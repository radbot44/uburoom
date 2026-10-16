'use strict';
// AV1 WebM goes directly to MediaSource, never through hls.js. Each independently
// encoded chunk starts at zero; timestampOffset maps it to Plex source time.
class uburoomAV1 {
  constructor(video, url, target, failed) {
    this.video = video; this.url = url; this.target = target; this.failed = failed;
    this.abort = new AbortController(); this.appended = new Set();
    this.chunkBytes = new Map(); this.seekVersion = 0;
    this.onSeek = () => {
      this.seekVersion++; this.request?.abort();
      if (!this.pumping) { clearTimeout(this.timer); this.timer = setTimeout(() => this.pump().catch(error => this.fail(error)),0); }
    };
    video.addEventListener('seeking',this.onSeek);
    this.source = new MediaSource(); this.objectUrl = URL.createObjectURL(this.source);
    this.source.addEventListener('sourceopen', () => this.start().catch(error => this.fail(error)), {once:true});
    video.src = this.objectUrl;
  }
  async fetch(url) {
    let response;
    try { response = await fetch(url, {signal:AbortSignal.any([this.abort.signal,...(this.request ? [this.request.signal] : []), AbortSignal.timeout(45000)])}); }
    catch (error) { error.retryable = true; throw error; }
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      const error = new Error(value.error || 'AV1 stream could not load.');
      error.retryable = response.status >= 500 || [408,429].includes(response.status); throw error;
    }
    return response;
  }
  async start() {
    const manifest = await (await this.fetch(this.url)).json();
    if (this.abort.signal.aborted) return;
    this.duration = manifest.duration; this.seconds = manifest.chunkSeconds;
    // This only validates the transport; playback/frame evidence chooses fallback.
    this.buffer = this.source.addSourceBuffer(manifest.mime);
    this.audio = this.source.addSourceBuffer(manifest.audioMime);
    this.source.duration = this.duration;
    await this.pump();
  }
  operation(buffer, action) {
    return new Promise((resolve, reject) => {
      const finish = error => {
        buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', bad);
        this.abort.signal.removeEventListener('abort', cancelled); error ? reject(error) : resolve();
      };
      const done = () => finish(), bad = () => finish(new Error('AV1 WebM could not be decoded.'));
      const cancelled = () => finish(new DOMException('Replaced','AbortError'));
      buffer.addEventListener('updateend', done, {once:true}); buffer.addEventListener('error', bad, {once:true});
      this.abort.signal.addEventListener('abort', cancelled, {once:true});
      try { action(); } catch (error) { finish(error); }
    });
  }
  async evict(indices) {
    for (const index of indices) {
      await Promise.all([this.buffer,this.audio].map(buffer => this.operation(buffer,() => buffer.remove(index * this.seconds,(index + 1) * this.seconds))));
      this.appended.delete(index); this.chunkBytes.delete(index);
    }
  }
  get retainedBytes() { return [...this.chunkBytes.values()].reduce((a,b) => a+b,0); }
  async makeSpace(first,bytes = 0) {
    const old = [...this.appended].filter(index => index < first).sort((a,b) => a-b);
    while (old.length && this.retainedBytes + bytes > uburoomPlayback.BUFFER.maxBytes) await this.evict([old.shift()]);
    return this.retainedBytes + bytes <= uburoomPlayback.BUFFER.maxBytes;
  }
  async append(index,videoBytes,audioBytes,first) {
    const attempt = async () => {
      this.buffer.timestampOffset = this.audio.timestampOffset = index * this.seconds + .01;
      const results = await Promise.allSettled([
        this.operation(this.buffer,() => this.buffer.appendBuffer(videoBytes)),
        this.operation(this.audio,() => this.audio.appendBuffer(audioBytes))
      ]);
      const error = results.find(result => result.status === 'rejected')?.reason;
      if (error) throw error;
    };
    try { await attempt(); }
    catch (error) {
      if (error.name !== 'QuotaExceededError') throw error;
      // Wait for BOTH append operations before touching either SourceBuffer.
      // Remove any partially appended pair, then free old data for one retry.
      await this.evict([index]);
      if (index > first) {
        this.pressureAhead = Math.max(0,(index-first-1) * this.seconds); this.pressured = true; return false;
      }
      await this.evict([...this.appended].filter(entry => entry !== first));
      await attempt();
    }
    this.appended.add(index); this.chunkBytes.set(index,videoBytes.byteLength + audioBytes.byteLength);
    return true;
  }
  async pump() {
    if (this.abort.signal.aborted || this.pumping || !this.buffer) return;
    this.pumping = true; clearTimeout(this.timer);
    try { await this.fill(); }
    finally {
      this.pumping = false;
      if (!this.abort.signal.aborted) this.timer = setTimeout(() => this.pump().catch(error => this.fail(error)),250);
    }
  }
  async fill() {
    const policy = uburoomPlayback.BUFFER;
    const target = this.target(), first = Math.floor(Math.min(target, this.duration - .05) / this.seconds);
    const version = this.seekVersion;
    const superseded = () => this.abort.signal.aborted || this.seekVersion !== version ||
      Math.floor(Math.min(this.target(),this.duration - .05) / this.seconds) !== first;
    const ahead = Math.min(policy.ahead,this.pressureAhead ?? policy.ahead);
    const last = Math.floor(Math.min(target + ahead,this.duration - .05) / this.seconds);
    const earliest = Math.max(0,Math.floor((target - (this.pressured ? 0 : policy.behind)) / this.seconds));
    await this.evict([...this.appended].filter(index => index < earliest || index > last));
    if (superseded()) return;
    for (let index = first; index <= last && index * this.seconds < this.duration; index++) {
      if (this.appended.has(index)) continue;
      if (this.prefetchFailure?.index === index) {
        const failure = this.prefetchFailure;
        // Speculation may fail long before this chunk is needed. Give actual
        // playback its own bounded retry when it reaches that source time.
        if (index === first && failure.error.retryable && !failure.required) {
          failure.required = true; failure.attempts = 0; failure.retryAt = 0;
        }
        if (!failure.error.retryable || failure.attempts >= (failure.required ? 3 : 6)) {
          if (index === first) throw failure.error;
          break;
        }
        if (Date.now() < failure.retryAt) break;
      }
      const estimate = this.prefetchSize?.index === index ? this.prefetchSize.bytes : this.chunkBytes.size ? this.retainedBytes / this.chunkBytes.size : 0;
      if (index > first) {
        const space = await this.makeSpace(first,estimate);
        if (superseded() || !space) break;
      }
      let videoBytes, audioBytes;
      const request = this.request = new AbortController();
      try {
        [videoBytes,audioBytes] = await Promise.all(['video','audio'].map(async track =>
          (await this.fetch(this.url.replace(/\/start$/, '/chunk-' + track + '-' + index))).arrayBuffer()));
      } catch (error) {
        if (request.signal.aborted && !this.abort.signal.aborted) break;
        request.abort(); // Cancel the sibling track request as well.
        const needed = Math.floor(Math.min(this.target(),this.duration - .05) / this.seconds);
        if (this.abort.signal.aborted || index === needed && !error.retryable) throw error;
        // Keep playing the valid current buffer. Some fractional-duration
        // sources have no video frame in the tiny final look-ahead chunk.
        // Surface the failure only if that chunk becomes necessary to play.
        const attempts = this.prefetchFailure?.index === index ? this.prefetchFailure.attempts + 1 : 1;
        this.prefetchFailure = {index,error,attempts,required:index === needed || this.prefetchFailure?.index === index && this.prefetchFailure.required,
          retryAt:Date.now() + 1000 * Math.min(8,2 ** (attempts-1))}; break;
      } finally { if (this.request === request) this.request = undefined; }
      // A shared seek may have happened while FFmpeg was running. Don't append
      // stale work; the next pump requests the authoritative position instead.
      if (superseded()) break;
      if (this.prefetchFailure?.index === index) this.prefetchFailure = undefined;
      const bytes = videoBytes.byteLength + audioBytes.byteLength;
      if (index > first) {
        const space = await this.makeSpace(first,bytes);
        if (superseded()) break;
        if (!space) { this.prefetchSize = {index,bytes}; break; }
      }
      if (index === first && !await this.makeSpace(first,bytes)) {
        const future = [...this.appended].filter(entry => entry > first).sort((a,b) => b-a);
        while (future.length && this.retainedBytes + bytes > policy.maxBytes) await this.evict([future.shift()]);
      }
      if (superseded()) break;
      // Keep Opus's codec preroll above zero; the source mapping differs by 10 ms.
      if (!await this.append(index,videoBytes,audioBytes,first)) break;
    }
  }
  fail(error) {
    if (this.abort.signal.aborted) return;
    this.destroy(); this.failed('AV1 playback failed: ' + error.message);
  }
  destroy() {
    clearTimeout(this.timer); this.abort.abort(); this.request?.abort();
    this.video.removeEventListener('seeking',this.onSeek);
    this.chunkBytes.clear(); this.appended.clear();
    URL.revokeObjectURL(this.objectUrl);
  }
}
window.uburoomAV1 = uburoomAV1;
