// @ts-check
'use strict';
const { CHUNK } = require('./av1');
const Tracks = require('./media-tracks');

/** One cancellable, speculative encoder lease. No timer, credentials or viewer grants are owned here. */
class FallbackStream {
  constructor({ av1, settings, source, shareKey, authorized, event = () => {} }) {
    Object.assign(this, { av1, settings, source, shareKey, authorized, event });
    this.position = 0;
    this.active = false;
    this.closed = false;
    this.retryAt = 0;
  }
  reconcile(position, active) {
    this.position = position;
    if (this.media?.av1Lease.released) this.media = undefined;
    const moved = this.work && (Math.abs(position - this.work.position) > CHUNK * 2 || !active);
    if (moved) this.work.controller.abort();
    this.active = active;
    if (!active || this.closed || this.work || Date.now() < this.retryAt) return;
    const work = (this.work = { position, controller: new AbortController() });
    work.promise = this.fill(work)
      .catch(() => {
        this.retryAt = Date.now() + 5000;
      })
      .finally(() => {
        if (this.work === work) this.work = undefined;
      });
  }
  async fill(work) {
    const current = () => !this.closed && this.active && !work.controller.signal.aborted;
    if (!current() || !(await this.authorized())) return;
    if (!this.media) {
      const format = this.settings.formats[0];
      await this.av1.conversionPolicy?.video('uburoom', format);
      if (!current()) return;
      const selection = Tracks.select(this.source.tracks, { audioId: 'auto', subtitleId: 'off' }),
        audio = selection.audio;
      const source = {
        ...this.source,
        start: this.source.sourceStart || this.source.start,
        shareKey: this.shareKey,
        audioIndex: audio?.index,
        audioOrdinal: audio?.ordinal,
        audioTrack: audio,
        burn: undefined,
      };
      const quality = this.settings.fallback.height + 'p' + this.settings.fallback.bitrate;
      const lease = this.av1.acquire(source, quality, false, format, { background: true });
      this.media = {
        ...source,
        format,
        quality,
        videoCodec: format,
        audioCodec: 'opus',
        av1Lease: lease,
        selection,
        resources: new Map(),
        fallback: true,
      };
      this.event('fallback-start', { format });
    }
    const first = Math.floor(this.position / CHUNK),
      last = Math.floor(Math.min(this.position + 30, this.media.duration - 0.05) / CHUNK);
    for (let index = first; index <= last && current(); index++) {
      if (!(await this.authorized()) || !current()) break;
      await this.av1.chunk(this.media.av1Lease, index, work.controller.signal, { urgent: false, background: true });
    }
  }
  close() {
    this.closed = true;
    this.active = false;
    this.work?.controller.abort();
    if (this.media) this.av1.release(this.media.av1Lease);
    this.media = undefined;
  }
}
module.exports = { FallbackStream };
