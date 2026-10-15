'use strict';
// AV1 WebM goes directly to MediaSource, never through hls.js. Each independently
// encoded chunk starts at zero; timestampOffset maps it to Plex source time.
class uburoomAV1 {
  constructor(video, url, target, failed) {
    this.video = video; this.url = url; this.target = target; this.failed = failed;
    this.abort = new AbortController(); this.appended = new Set();
    this.source = new MediaSource(); this.objectUrl = URL.createObjectURL(this.source);
    this.source.addEventListener('sourceopen', () => this.start().catch(error => this.fail(error)), {once:true});
    video.src = this.objectUrl;
  }
  async fetch(url) {
    const response = await fetch(url, {signal:AbortSignal.any([this.abort.signal, AbortSignal.timeout(45000)])});
    if (!response.ok) {
      const value = await response.json().catch(() => ({}));
      throw new Error(value.error || 'AV1 stream could not load.');
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
  async pump() {
    if (this.abort.signal.aborted) return;
    const target = this.target(), first = Math.floor(Math.min(target, this.duration - .05) / this.seconds);
    if (this.buffer.buffered.length && this.buffer.buffered.start(0) < target - 18) {
      await Promise.all([this.buffer,this.audio].map(buffer => this.operation(buffer, () => buffer.remove(0, target - 18))));
      for (const index of this.appended) if ((index + 1) * this.seconds <= target - 18) this.appended.delete(index);
    }
    // Also evict old forward buffers after a backwards seek.
    if (this.buffer.buffered.length && this.buffer.buffered.end(this.buffer.buffered.length - 1) > target + 24) {
      await Promise.all([this.buffer,this.audio].map(buffer => this.operation(buffer, () => buffer.remove(target + 18, this.duration))));
      for (const index of this.appended) if (index * this.seconds >= target + 18) this.appended.delete(index);
    }
    for (let index = first; index <= first + 1 && index * this.seconds < this.duration; index++) {
      if (this.appended.has(index)) continue;
      const [videoBytes,audioBytes] = await Promise.all(['video','audio'].map(async track =>
        (await this.fetch(this.url.replace(/\/start$/, '/chunk-' + track + '-' + index))).arrayBuffer()));
      if (this.abort.signal.aborted) return;
      // A shared seek may have happened while FFmpeg was running. Don't append
      // stale work; the next pump requests the authoritative position instead.
      if (Math.abs(index * this.seconds - this.target()) > this.seconds * 3) break;
      // Keep Opus's codec preroll above zero; the source mapping differs by 10 ms.
      this.buffer.timestampOffset = index * this.seconds + .01;
      this.audio.timestampOffset = index * this.seconds + .01;
      await Promise.all([this.operation(this.buffer, () => this.buffer.appendBuffer(videoBytes)),
        this.operation(this.audio, () => this.audio.appendBuffer(audioBytes))]);
      this.appended.add(index);
    }
    this.timer = setTimeout(() => this.pump().catch(error => this.fail(error)), 250);
  }
  fail(error) {
    if (this.abort.signal.aborted) return;
    this.destroy(); this.failed('AV1 playback failed: ' + error.message);
  }
  destroy() {
    clearTimeout(this.timer); this.abort.abort();
    URL.revokeObjectURL(this.objectUrl);
  }
}
window.uburoomAV1 = uburoomAV1;
