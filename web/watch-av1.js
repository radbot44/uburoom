'use strict';
// AV1/VP9/VP8 WebM goes directly to MediaSource, never through hls.js. Each independently
// encoded chunk starts at zero; timestampOffset maps it to Plex source time.
class uburoomAV1 {
  constructor(video, url, target, failed) {
    this.video = video; this.url = url; this.target = target; this.failed = failed;
    this.abort = new AbortController(); this.appended = new Set();
    this.chunkBytes = new Map(); this.seekVersion = 0; this.endSignalled = false;
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
      const error = new Error(value.error || 'Converted stream could not load.');
      error.retryable = response.status >= 500 || [408,429].includes(response.status); throw error;
    }
    return response;
  }
  async start() {
    const response = await this.fetch(this.url);
    let manifest;
    try { manifest = await response.json(); }
    catch (error) { error.retryable = true; throw error; }
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
      const done = () => finish(), bad = () => finish(new Error('Converted WebM could not be decoded.'));
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
      this.coverage?.delete(index); this.refills?.delete(index);
    }
  }
  ranges(buffer, index) {
    if (!buffer.buffered) return undefined;
    const start = index * this.seconds, end = Math.min(this.duration, start + this.seconds), result = [];
    for (let i = 0; i < buffer.buffered.length; i++) {
      const a = Math.max(start, buffer.buffered.start(i)), b = Math.min(end, buffer.buffered.end(i));
      if (b > a) result.push([a,b]);
    }
    return result;
  }
  reconcile(first, last) {
    this.coverage ||= new Map(); this.refills ||= new Map();
    for (const index of this.refills.keys()) if (index < first || index > last) this.refills.delete(index);
    for (const index of this.appended) {
      if (index < first || index > last) continue;
      const actual = [this.ranges(this.buffer,index),this.ranges(this.audio,index)];
      if (actual.some(ranges => ranges === undefined)) continue;
      const expected = this.coverage.get(index) || actual.map(() => [[index*this.seconds+.15,Math.min(this.duration,(index+1)*this.seconds)-.15]]);
      const covered = actual.every((ranges,track) => expected[track].every(([a,b]) => {
        const needed = index === first ? Math.max(a,this.target()-.15) : a;
        return b <= needed || ranges.some(([x,y]) => x <= needed+.08 && y >= b-.08);
      }));
      if (covered && actual.every(ranges => ranges.length)) continue;
      const count = (this.refills.get(index) || 0) + 1;
      if (count > 3) {
        if (index === first) throw new Error('Converted playback buffer could not be retained.');
        this.pressureAhead = this.seconds; this.pressured = true; continue;
      }
      this.refills.set(index,count);
      this.appended.delete(index); this.chunkBytes.delete(index); this.endSignalled = false;
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
      // A fractional last frame can overlap the next chunk's keyframe. During
      // refill, MSE would then remove dependent frames from that good chunk.
      // Bound each pair to its source window before any out-of-order append.
      this.buffer.appendWindowEnd = this.audio.appendWindowEnd = Math.min(this.duration + .1,(index + 1) * this.seconds + .01);
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
        this.pressureAhead = Math.max(this.seconds,(index-first-1) * this.seconds); this.pressured = true; return false;
      }
      await this.evict([...this.appended].filter(entry => entry !== first));
      await attempt();
    }
    this.coverage ||= new Map();
    const coverage = [this.ranges(this.buffer,index),this.ranges(this.audio,index)];
    if (coverage.every(ranges => ranges?.length)) this.coverage.set(index,coverage);
    this.appended.add(index); this.chunkBytes.set(index,videoBytes.byteLength + audioBytes.byteLength);
    return true;
  }
  async pump() {
    if (this.abort.signal.aborted || this.pumping || !this.buffer) return;
    this.pumping = true; clearTimeout(this.timer);
    const version = this.seekVersion;
    try { await this.fill(); }
    finally {
      this.pumping = false;
      if (!this.abort.signal.aborted) this.timer = setTimeout(() => this.pump().catch(error => this.fail(error)), this.seekVersion !== version ? 0 : 250);
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
    this.reconcile(first,last);
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
        [videoBytes,audioBytes] = await Promise.all(['video','audio'].map(async track => {
          const res = await this.fetch(this.url.replace(/\/start$/, '/chunk-' + track + '-' + index));
          try { return await res.arrayBuffer(); }
          catch (error) { error.retryable = true; throw error; }
        }));
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
    // The browser cannot fire a natural 'ended' event for MSE until EOF is
    // declared. Do not declare it merely because the last chunk was prefetched:
    // the actual playback position must have reached the last chunk.
    const finalIndex = Math.floor(Math.max(0,this.duration - .05) / this.seconds);
    if (first !== finalIndex) this.endSignalled = false;
    if (first === finalIndex && !superseded() && this.appended.has(finalIndex) && !this.endSignalled &&
        this.source?.readyState === 'open' && !this.buffer.updating && !this.audio.updating) {
      this.source.endOfStream();
      this.endSignalled = true;
    }
  }
  fail(error) {
    if (this.abort.signal.aborted) return;
    this.destroy(); this.failed('Converted playback failed: ' + error.message);
  }
  destroy() {
    clearTimeout(this.timer); this.abort.abort(); this.request?.abort();
    this.video.removeEventListener('seeking',this.onSeek);
    this.chunkBytes.clear(); this.appended.clear(); this.coverage?.clear(); this.refills?.clear();
    URL.revokeObjectURL(this.objectUrl);
  }
}
window.uburoomAV1 = uburoomAV1;
