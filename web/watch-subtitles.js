import { asMediaSurface } from './media-surface.js';
import { subtitleRenderers as uburoomSubtitleRenderers } from './subtitle-renderers.js';

import { trace } from './trace.js';
const PGS_MEMORY_LIMIT = 16 * 1024 * 1024;
// Native TextTrack/VTTCue rendering follows the video into fullscreen. Cue text
// is parsed by the media API, never inserted into the document as HTML.
// PGS push parsers retain their input history. Replay only a bounded ordered set
// of windows, and discard exact overlapping segments before feeding the parser.
function pgsWindowBytes(items) {
  const segments = [],
    seen = new Map();
  let size = 0;
  for (let windowIndex = 0; windowIndex < items.length; windowIndex++) {
    const bytes = items[windowIndex].data,
      view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let offset = 0; offset < bytes.length;) {
      if (offset + 13 > bytes.length || bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x47)
        throw new Error('Invalid PGS subtitle window. Try burn-in.');
      const end = offset + 13 + view.getUint16(offset + 11);
      if (end > bytes.length) throw new Error('Incomplete PGS subtitle window. Try burn-in.');
      const data = bytes.subarray(offset, end),
        pts = view.getUint32(offset + 2);
      let hash = 2166136261;
      for (let i = 10; i < data.length; i++) hash = Math.imul(hash ^ data[i], 16777619);
      const key = pts + ':' + hash,
        previous = seen.get(key) || [];
      const duplicate = previous.some(
        p =>
          p.windowIndex !== windowIndex &&
          p.data.length === data.length &&
          p.data.every((v, i) => (i >= 6 && i < 10) || v === data[i]),
      );
      if (!duplicate) {
        const segment = { data, pts, windowIndex };
        previous.push(segment);
        seen.set(key, previous);
        segments.push(segment);
        size += data.length;
      }
      offset = end;
    }
  }
  segments.sort((a, b) => a.pts - b.pts);
  const palettes = new Set(),
    objects = new Set(),
    assembling = new Set();
  let composition;
  for (const { data } of segments) {
    const payload = data.subarray(13),
      view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    if (data[10] === 0x16) {
      if (payload.length < 11) throw new Error('Invalid PGS composition. Try burn-in.');
      if (payload[7] === 0x80) {
        palettes.clear();
        objects.clear();
        assembling.clear();
      }
      composition = { palette: payload[9], objects: [] };
      let offset = 11;
      for (let i = 0; i < payload[10]; i++) {
        if (offset + 8 > payload.length) throw new Error('Incomplete PGS composition. Try burn-in.');
        const length = payload[offset + 3] & 0x80 ? 16 : 8;
        if (offset + length > payload.length) throw new Error('Incomplete PGS composition. Try burn-in.');
        composition.objects.push(view.getUint16(offset));
        offset += length;
      }
    } else if (data[10] === 0x14 && payload.length >= 2) palettes.add(payload[0]);
    else if (data[10] === 0x15 && payload.length >= 4) {
      const id = view.getUint16(0);
      if (payload[3] & 0x80) {
        assembling.add(id);
        objects.delete(id);
      }
      if (payload[3] & 0x40 && assembling.has(id)) {
        objects.add(id);
        assembling.delete(id);
      }
    } else if (data[10] === 0x80 && composition?.objects.length) {
      if (!palettes.has(composition.palette) || composition.objects.some(id => !objects.has(id)))
        throw Object.assign(new Error('PGS window is missing bitmap initialization. Try burn-in.'), {
          initialization: true,
        });
    }
  }
  if (size && !composition) throw new Error('PGS window has no usable composition. Try burn-in.');
  const output = new Uint8Array(size);
  let offset = 0;
  for (const segment of segments) {
    output.set(segment.data, offset);
    offset += segment.data.length;
  }
  return output;
}
class uburoomSubtitleWindows {
  constructor(renderer, windowUrl, onSync, signal, onError = () => {}) {
    this.renderer = renderer;
    this.windowUrl = windowUrl;
    this.onSync = onSync;
    this.signal = signal;
    this.onError = onError;
    this.intervals = [];
    this.items = [];
    this.fetching = null;
    this.disposed = false;
    this.generation = 0;
    this.queue = Promise.resolve();
    this.failures = 0;
    this.retryAt = 0;
    this.error = null;
    this.positionMs = 0;
    this.parserBytes = 0;
    this.replayBytes = 0;
    this.transferBytes = 0;
    this.requests = new Set();
  }
  resourceUsage() {
    const retainedBytes = this.items.reduce((sum, item) => sum + item.data.length, 0);
    const fetchingBytes = [...this.requests].reduce((sum, request) => sum + request.bytes, 0);
    return {
      retainedBytes,
      parserBytes: this.parserBytes,
      replayBytes: this.replayBytes,
      transferBytes: this.transferBytes,
      fetchingBytes,
      totalBytes: retainedBytes + this.parserBytes + this.replayBytes + this.transferBytes + fetchingBytes,
      limitBytes: PGS_MEMORY_LIMIT,
    };
  }
  isCovered(timeMs, lookaheadMs = 0) {
    return this.intervals.some(i => i.startMs <= timeMs && i.endMs > timeMs + lookaheadMs);
  }
  synced(timeSeconds) {
    return this.isCovered(Math.max(0, Math.round(timeSeconds * 1000)));
  }
  check(timeSeconds) {
    if (this.disposed || !Number.isFinite(timeSeconds)) return;
    const timeMs = Math.max(0, Math.round(timeSeconds * 1000));
    // A new seek can recover a failed window without inheriting its retry delay.
    const seek = Math.abs(timeMs - this.positionMs) > 15000;
    if (seek && !this.error?.terminal) {
      const failed = this.error;
      clearTimeout(this.retryTimer);
      this.failures = 0;
      this.retryAt = 0;
      this.error = null;
      if (failed) this.onSync();
    }
    this.positionMs = timeMs;
    if (
      this.fetching &&
      (seek || !this.isCovered(timeMs)) &&
      (timeMs < this.fetching.startMs || timeMs >= this.fetching.endMs)
    ) {
      this.fetching.controller.abort();
      this.fetching = null;
    }
    if (this.error?.terminal || this.failures >= 3 || performance.now() < this.retryAt) return;
    if (!this.isCovered(timeMs)) this.fetch(timeMs, true);
    else if (!this.isCovered(timeMs, 20000)) this.fetch(timeMs + 30000, false);
  }
  fetch(targetMs, priority = false) {
    if (this.disposed || this.signal?.aborted || this.isCovered(targetMs)) return;
    if (this.fetching) {
      if (!priority || (this.fetching.startMs <= targetMs && this.fetching.endMs > targetMs)) return;
      this.fetching.controller.abort();
    }
    const controller = new AbortController(),
      signal = AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30000)].filter(Boolean));
    const beforeMs = this.beforeMs || 15000;
    const startExpected = Math.max(0, targetMs - beforeMs),
      endExpected = targetMs + 60000;
    const pending = { controller, startMs: startExpected, endMs: endExpected, bytes: 0 };
    this.fetching = pending;
    this.requests.add(pending);
    const generation = ++this.generation,
      current = () => !signal.aborted && !this.disposed && generation === this.generation;
    if (priority && !this.isCovered(targetMs)) {
      this.items = [];
      this.intervals = [];
      this.queue = this.queue
        .catch(() => {})
        .then(async () => {
          if (current()) {
            await this.renderer.reset?.();
            this.parserBytes = 0;
          }
        });
    }
    const url = this.windowUrl + '?atMs=' + targetMs + '&beforeMs=' + beforeMs + '&afterMs=60000';
    pending.promise = (async () => {
      try {
        const response = await fetch(url, { signal });
        if (!response.ok) {
          const value = await response.json().catch(() => ({}));
          const error = Object.assign(new Error(value.error || 'Subtitle window could not load. Try burn-in.'), {
            terminal: response.status === 403,
          });
          if (
            /(?:exceeded the supported|timed out|no usable data|failed during media demuxing|could not be extracted|needs configured FFmpeg)/i.test(
              error.message,
            )
          ) {
            error.burnFallback = true;
          }
          throw error;
        }
        const header = name => {
          const raw = response.headers.get(name);
          return raw !== null && raw !== '' ? Number(raw) : NaN;
        };
        const startMs = header('x-subtitle-start-ms'),
          endMs = header('x-subtitle-end-ms'),
          cues = header('x-subtitle-cues');
        if (
          !Number.isFinite(startMs) ||
          !Number.isFinite(endMs) ||
          startMs < 0 ||
          endMs <= startMs ||
          endMs - startMs > 240000 ||
          targetMs < startMs ||
          targetMs >= endMs
        )
          throw new Error('Invalid subtitle coverage. Try burn-in.');
        const reader = response.body?.getReader(),
          chunks = [];
        let size = 0;
        if (!reader) throw new Error('Subtitle response was interrupted. Try burn-in.');
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            // Reserve both incoming chunks and their assembled copy, alongside
            // retained windows and parser/replay data owned by this scheduler.
            if (this.resourceUsage().totalBytes - pending.bytes + 2 * (size + value.length) > PGS_MEMORY_LIMIT)
              throw new Error('Subtitle windows exceeded the supported cache limit. Try burn-in.');
            size += value.length;
            pending.bytes = 2 * size;
            chunks.push(value);
          }
        } finally {
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
        if (!current()) return;
        if (!size && cues > 0) throw new Error('Subtitle extraction produced no usable data. Try burn-in.');
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          data.set(chunk, offset);
          offset += chunk.length;
        }
        chunks.length = 0;
        pending.bytes = size;
        this.queue = this.queue
          .catch(() => {})
          .then(async () => {
            if (!current()) return;
            const items = [...this.items, { startMs, endMs, cues: Number.isFinite(cues) ? cues : 0, data }];
            const otherRequests = this.resourceUsage().fetchingBytes - pending.bytes;
            // Charge retained input, assembled replay, worker transfer, and the
            // parser's encoded copy together, rather than permitting 16MiB each.
            while (
              items.length > 3 ||
              otherRequests + 4 * items.reduce((n, item) => n + item.data.length, 0) > PGS_MEMORY_LIMIT
            ) {
              // Retain current coverage ahead of stale history or speculative work.
              let index = items.findIndex(i => i.endMs <= this.positionMs);
              if (index < 0) index = items.findIndex(i => i.startMs > this.positionMs);
              if (index < 0) index = 0;
              if (index === items.length - 1)
                throw new Error('Subtitle windows exceeded the supported cache limit. Try burn-in.');
              items.splice(index, 1);
            }
            items.sort((a, b) => a.startMs - b.startMs);
            this.items = items;
            pending.bytes = 0;
            this.intervals = [];
            pending.startMs = items[0]?.startMs ?? startMs;
            pending.endMs = items.at(-1)?.endMs ?? endMs;
            await this.renderer.reset?.();
            this.parserBytes = 0;
            if (!current()) return;
            const bytes = pgsWindowBytes(items);
            this.replayBytes = bytes.length;
            try {
              if (bytes.length) {
                this.parserBytes = bytes.length;
                this.transferBytes = bytes.length;
                await this.renderer.append(bytes);
              }
            } finally {
              this.transferBytes = 0;
              this.replayBytes = 0;
            }
            if (!current()) return;
            // A complete window is not a partial full-track stream. Finalize its
            // last display set, including the final clear, before claiming coverage.
            await this.renderer.flush?.();
            if (!current()) return;
            this.items = items;
            this.intervals = [];
            for (const item of items) {
              const previous = this.intervals[this.intervals.length - 1];
              if (previous && item.startMs <= previous.endMs) {
                previous.endMs = Math.max(previous.endMs, item.endMs);
                previous.cues += item.cues;
              } else this.intervals.push({ startMs: item.startMs, endMs: item.endMs, cues: item.cues });
            }
            this.failures = 0;
            this.retryAt = 0;
            this.error = null;
            this.onSync();
          });
        await this.queue;
      } catch (error) {
        if (!current()) return;
        if (
          /(?:exceeded the supported|timed out|no usable data|failed during media demuxing|could not be extracted|needs configured FFmpeg)/i.test(
            error.message,
          )
        ) {
          error.burnFallback = true;
        }
        this.error = error;
        this.failures++;
        this.retryAt = performance.now() + 1000 * 2 ** (this.failures - 1);
        if (error.initialization) this.beforeMs = 60000;
        this.onError(error, error.terminal || this.failures >= 3);
        if (!error.terminal && this.failures < 3)
          this.retryTimer = setTimeout(
            () => {
              this.retryTimer = undefined;
              this.check(this.positionMs / 1000);
            },
            Math.max(1, this.retryAt - performance.now()),
          );
      } finally {
        this.requests.delete(pending);
        if (this.fetching === pending) this.fetching = null;
      }
    })();
  }
  retry() {
    if (this.error?.terminal) return;
    clearTimeout(this.retryTimer);
    this.failures = 0;
    this.retryAt = 0;
    this.error = null;
    this.check(this.positionMs / 1000);
    this.onSync();
  }
  destroy() {
    this.disposed = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    this.fetching?.controller.abort();
    this.fetching = null;
    this.items = [];
    this.intervals = [];
  }
}
// Embedded text cannot be read whole: that scans the entire file. Fetch cues in
// windows around playback, which works for any delivery route, including Original.
class uburoomTextWindows {
  constructor(windowUrl, onCues, onState, signal) {
    this.windowUrl = windowUrl;
    this.onCues = onCues;
    this.onState = onState;
    this.signal = signal;
    this.intervals = [];
    this.seen = new Map();
    this.failures = 0;
    this.retryAt = 0;
  }
  covered(timeMs, aheadMs = 0) {
    return this.intervals.some(i => i.startMs <= timeMs && i.endMs > timeMs + aheadMs);
  }
  check(timeSeconds) {
    if (this.disposed || !Number.isFinite(timeSeconds)) return;
    const timeMs = Math.max(0, Math.round(timeSeconds * 1000));
    if (Math.abs(timeMs - (this.positionMs ?? timeMs)) > 15000) {
      this.failures = 0;
      this.retryAt = 0;
    }
    this.positionMs = timeMs;
    const current = this.covered(timeMs);
    if (this.fetching && !current && (timeMs < this.fetching.startMs || timeMs >= this.fetching.endMs)) {
      this.fetching.controller.abort();
      this.fetching = undefined;
    }
    if (this.fetching || this.failures >= 3 || performance.now() < this.retryAt) return;
    // A window reads every track of the video, so a short one brings up the first cues
    // soonest. Later windows continue from the end of what is already covered.
    if (!current) void this.fetch(timeMs, 5000, 15000);
    else if (!this.covered(timeMs, 20000))
      void this.fetch(this.intervals.find(item => item.startMs <= timeMs && item.endMs > timeMs).endMs, 0, 60000);
  }
  synced(timeSeconds) {
    return this.covered(Math.max(0, Math.round(timeSeconds * 1000)));
  }
  async fetch(targetMs, beforeMs, afterMs) {
    const controller = new AbortController(),
      pending = (this.fetching = { controller, startMs: Math.max(0, targetMs - beforeMs), endMs: targetMs + afterMs }),
      began = performance.now();
    try {
      const response = await fetch(
        this.windowUrl + '?atMs=' + targetMs + '&beforeMs=' + beforeMs + '&afterMs=' + afterMs,
        { signal: AbortSignal.any([this.signal, controller.signal, AbortSignal.timeout(30000)].filter(Boolean)) },
      );
      if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw Object.assign(new Error(value.error || 'Subtitle window could not load. Try burn-in.'), {
          terminal: response.status === 403,
        });
      }
      const startMs = Number(response.headers.get('X-Subtitle-Start-Ms')),
        endMs = Number(response.headers.get('X-Subtitle-End-Ms')),
        cues = await response.json();
      if (
        !Number.isFinite(startMs) ||
        !Number.isFinite(endMs) ||
        endMs <= startMs ||
        !Array.isArray(cues) ||
        cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || typeof c.text !== 'string')
      )
        throw new Error('Invalid subtitle window. Try burn-in.');
      if (this.disposed || this.fetching !== pending) return;
      // Merge touching windows, or the look-ahead check never sees continuous coverage.
      const merged = [];
      for (const item of [...this.intervals, { startMs, endMs }].sort((x, y) => x.startMs - y.startMs)) {
        const last = merged.at(-1);
        if (last && item.startMs <= last.endMs) last.endMs = Math.max(last.endMs, item.endMs);
        else merged.push({ ...item });
      }
      this.intervals = merged;
      this.onCues(
        cues.filter(cue => {
          const key = Math.round(cue.end * 1000) + '|' + cue.text;
          const prevStart = this.seen.get(key);
          if (prevStart !== undefined && cue.start >= prevStart - 0.001) return false;
          this.seen.set(key, cue.start);
          return true;
        }),
      );
      this.failures = 0;
      this.retryAt = 0;
      this.onState();
      trace('subtitle-window', { elapsedMs: performance.now() - began });
    } catch (error) {
      if (this.disposed || controller.signal.aborted || this.signal?.aborted) return;
      trace('subtitle-window-failed', {
        elapsedMs: performance.now() - began,
        attempt: this.failures + 1,
      });
      this.failures = error.terminal ? 3 : this.failures + 1;
      this.retryAt = performance.now() + 1000 * 2 ** this.failures;
      this.onState(error, this.failures >= 3);
    } finally {
      if (this.fetching === pending) this.fetching = undefined;
    }
  }
  prune(keepStartMs, keepEndMs, droppedCues = []) {
    const kept = [];
    for (const item of this.intervals) {
      const startMs = Math.max(item.startMs, keepStartMs);
      const endMs = Math.min(item.endMs, keepEndMs);
      if (endMs > startMs) kept.push({ startMs, endMs });
    }
    this.intervals = kept;
    for (const cue of droppedCues) this.seen.delete(Math.round(cue.end * 1000) + '|' + cue.text);
  }
  retry() {
    this.failures = 0;
    this.retryAt = 0;
    this.onState();
    this.check((this.positionMs || 0) / 1000);
  }
  destroy() {
    this.disposed = true;
    this.fetching?.controller.abort();
  }
}
// Text subtitles draw in their own layer. Browser cues live inside the video box,
// so they cannot follow the picture, and moving them disturbs native playback layout.
const TEXT_SIZES = { small: 0.035, medium: 0.045, large: 0.06 };
function appendCueText(parent, text) {
  const stack = [parent];
  for (const part of text.split(/(<[^>]*>|\n)/)) {
    if (!part) continue;
    const tag = /^<(\/?)([ibu])(?:[.\s][^>]*)?>$/i.exec(part);
    if (part === '\n') stack.at(-1).append(document.createElement('br'));
    else if (tag && !tag[1]) {
      const element = document.createElement(tag[2].toLowerCase());
      stack.at(-1).append(element);
      stack.push(element);
    } else if (tag) {
      if (stack.length > 1) stack.pop();
    } else if (!part.startsWith('<'))
      stack.at(-1).append(
        part
          .replace(/&nbsp;/g, '\u00a0')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&'),
      );
  }
}
function cueDedupKey(cue) {
  return Math.round(cue.end * 1000) + '|' + cue.text;
}
function sameCueList(prev, next) {
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (prev[i] !== next[i]) return false;
  }
  return true;
}
function renderCueBox(box, cues) {
  if (!cues.length) {
    box.replaceChildren();
    return;
  }
  const nodes = new Array(cues.length);
  for (let i = 0; i < cues.length; i++) {
    const row = document.createElement('div'),
      text = document.createElement('span');
    row.className = 'subtitle-cue';
    row.append(text);
    appendCueText(text, cues[i].text);
    nodes[i] = row;
  }
  box.replaceChildren(...nodes);
}
const SUBTITLE_OFFSET_MIN = -30;
const SUBTITLE_OFFSET_MAX = 30;
function normalizeSubtitleOffset(value, fallback = 0) {
  if (value === '' || value === null || value === undefined) return fallback;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const clamped = Math.max(SUBTITLE_OFFSET_MIN, Math.min(SUBTITLE_OFFSET_MAX, numeric));
  const rounded = Math.round(clamped * 10) / 10;
  return rounded === 0 ? 0 : rounded;
}
function formatSubtitleOffset(value) {
  const normalized = normalizeSubtitleOffset(value, 0);
  return (normalized > 0 ? '+' : normalized < 0 ? '−' : '') + Math.abs(normalized).toFixed(1) + ' s';
}
class uburoomSubtitles {
  constructor(target, status, resolveMediaTime) {
    this.surface = asMediaSurface(target);
    this.video = this.surface.videoElement;
    this.status = status;
    this.resolveMediaTime = resolveMediaTime;
    this.cues = [];
    this.cuesByKey = new Map();
    this.offset = 0;
    this.serverOffset = 0;
    this.generation = 0;
    this.key = '';
    this.track = this.video.addTextTrack('subtitles', 'uburoom subtitles');
    this.track.mode = 'disabled';
    this.cueSnapshot = null;
    this.cueValidFrom = Infinity;
    this.cueValidUntil = -Infinity;
    this.renderedTopCues = [];
    this.renderedBottomCues = [];
    this.position = 'video';
    this.size = 'medium';
    this.controlsHeight = 0;
    const stageEl = this.surface.stageElement();
    if (stageEl && typeof document !== 'undefined') {
      const layer = (this.layer = document.createElement('div')),
        bottom = (this.bottomCues = document.createElement('div')),
        top = (this.topCues = document.createElement('div'));
      layer.className = 'subtitle-text-layer';
      bottom.className = 'subtitle-text-lines';
      top.className = 'subtitle-text-lines top';
      layer.append(top, bottom);
      stageEl.append(layer);
      this.track.addEventListener?.('cuechange', () => {
        if (!this.surface.isUbuPlayer()) this.paint();
      });
      new ResizeObserver(() => this.place()).observe(stageEl);
      this.onPlace = () => this.place();
      for (const event of ['loadedmetadata', 'resize']) this.surface.addEventListener(event, this.onPlace);
    }
    this.video.textTracks?.addEventListener?.('addtrack', event => {
      if (event.track !== this.track) event.track.mode = 'disabled';
    });
    this.onTimeChange = () => {
      const now = this.mediaTime();
      this.windowScheduler?.check(now - (this.offset || 0));
      this.textWindows?.check(now - (this.offset || 0));
      if (this.surface.isUbuPlayer() && this.track.mode !== 'disabled') this.paint();
      this.syncStatus();
    };
    for (const event of ['seeking', 'seeked', 'timeupdate']) this.surface.addEventListener(event, this.onTimeChange);
  }
  mediaTime() {
    const raw = this.surface.currentTime();
    return typeof this.resolveMediaTime === 'function' ? this.resolveMediaTime(raw) : raw;
  }
  syncStatus() {
    if ((!this.streaming && !this.windowScheduler) || !this.renderer) return;
    if (this.renderFailed) return;
    const failure = this.windowScheduler && this.renderer.error?.();
    if (failure) {
      this.renderFailed = true;
      this.windowScheduler.destroy();
      this.renderer.destroy();
      this.status({ message: failure.message, error: true, loading: false });
      return;
    }
    const synced = this.windowScheduler
      ? this.windowScheduler.synced(this.mediaTime() - (this.offset || 0))
      : this.renderer.synced
        ? this.renderer.synced(this.mediaTime() - (this.offset || 0))
        : true;
    if (this.windowScheduler?.error) return;
    if (synced === this.streamSynced) return;
    this.streamSynced = synced;
    this.status({ message: synced ? '' : 'Loading subtitles…', error: false, loading: !synced });
  }
  indexCues() {
    this.cuesByKey.clear();
    for (const cue of this.cues) {
      if (!Number.isFinite(cue.end) || typeof cue.text !== 'string') continue;
      const key = cueDedupKey(cue);
      if (!this.cuesByKey.has(key)) this.cuesByKey.set(key, cue);
    }
  }
  invalidateCueSnapshot() {
    this.cueSnapshot = null;
    this.cueValidFrom = Infinity;
    this.cueValidUntil = -Infinity;
  }
  setTrackMode(mode) {
    if (this.track.mode === mode) return;
    this.track.mode = mode;
    this.invalidateCueSnapshot();
  }
  getCueSnapshot() {
    if (this.cueSnapshot === null) this.cueSnapshot = Array.from(this.track.cues || []);
    return this.cueSnapshot;
  }
  // Native fullscreen shows only the video, so text cues move to the browser's own
  // captions there. Other subtitle formats draw in the page and cannot follow.
  nativeFullscreen(active) {
    if (active && this.track.mode === 'hidden') this.setTrackMode('showing');
    if (!active && this.track.mode === 'showing') this.setTrackMode('hidden');
    return !!this.renderer;
  }
  clearCues() {
    for (const cue of Array.from(this.track.cues || [])) this.track.removeCue(cue);
    this.invalidateCueSnapshot();
    this.paint();
  }
  reset() {
    this.generation++;
    this.abort?.abort();
    clearTimeout(this.timer);
    this.timer = undefined;
    this.key = '';
    this.localKey = '';
    this.url = undefined;
    this.cues = [];
    this.cuesByKey.clear();
    this.attempts = 0;
    this.loading = false;
    this.loaded = false;
    this.streaming = false;
    this.streamSynced = false;
    this.renderFailed = false;
    this.windowScheduler?.destroy();
    this.windowScheduler = undefined;
    this.textWindows?.destroy();
    this.textWindows = undefined;
    this.renderer?.destroy();
    this.renderer = undefined;
    this.clearCues();
    this.setTrackMode('disabled');
    this.status({ message: '', error: false, loading: false });
  }
  setOffset(value) {
    const next = normalizeSubtitleOffset(value, this.offset || 0);
    if (this.offset === next) return next;
    this.offset = next;
    this.rebuild();
    this.renderer?.offset(next);
    this.windowScheduler?.check(this.mediaTime() - next);
    this.textWindows?.check(this.mediaTime() - next);
    this.syncStatus();
    return next;
  }
  async setLocalSubtitle(spec) {
    if (!spec) {
      if (this.localKey) this.reset();
      return;
    }
    if (spec.key === this.localKey && this.loaded) return;
    this.reset();
    this.localKey = spec.key;
    const generation = this.generation;
    const abort = (this.abort = new AbortController());
    try {
      if (spec.format === 'cues') {
        this.setTrackMode('hidden');
        this.cues = Array.isArray(spec.cues) ? [...spec.cues] : [];
        this.indexCues();
        this.rebuild();
        this.loaded = true;
        this.status({ message: '', error: false, loading: false });
        return;
      }
      this.status({ message: 'Preparing subtitles…', error: false, loading: true });
      const renderer = await uburoomSubtitleRenderers.create(
        this.surface,
        spec.format,
        {
          data: spec.data,
          fonts: spec.fonts || [],
          pushStream: spec.pushStream,
          fileName: spec.fileName,
        },
        this.offset || 0,
        abort.signal,
        this.resolveMediaTime,
      );
      if (generation !== this.generation) {
        renderer.destroy();
        return;
      }
      this.renderer = renderer;
      renderer.offset(this.offset || 0);
      this.setTrackMode('disabled');
      this.loaded = true;
      this.paint();
      this.status({ message: '', error: false, loading: false });
    } catch (err) {
      if (generation !== this.generation || abort.signal.aborted) return;
      this.status({ message: err?.message || 'Local subtitles could not load.', error: true, loading: false });
    }
  }
  appendLocalCues(cues) {
    if (!this.localKey || !Array.isArray(cues) || !cues.length) return;
    let replaced = false;
    for (const cue of cues) {
      if (!Number.isFinite(cue.start) || !Number.isFinite(cue.end) || typeof cue.text !== 'string') continue;
      const key = cueDedupKey(cue);
      const existing = this.cuesByKey.get(key);
      if (existing) {
        if (cue.start < existing.start - 0.001) {
          existing.start = cue.start;
          replaced = true;
        }
      } else {
        this.cues.push(cue);
        this.cuesByKey.set(key, cue);
        this.addCue(cue);
      }
    }
    if (replaced) this.rebuild();
    else this.paint();
  }
  async appendLocalData(bytes) {
    if (!this.localKey || !this.renderer || !bytes?.byteLength) return;
    await this.renderer.append?.(bytes);
  }
  update(state) {
    if (!state.subtitleUrl && this.localKey && state.localSubtitleKey === this.localKey) {
      const serverOffset = state.tracks?.subtitleOffset;
      if (serverOffset !== undefined) {
        const normalizedServer = normalizeSubtitleOffset(serverOffset, this.serverOffset);
        if (normalizedServer !== this.serverOffset) {
          this.serverOffset = normalizedServer;
          this.setOffset(normalizedServer);
        }
      }
      this.setTrackMode(this.renderer ? 'disabled' : 'hidden');
      return;
    }
    const key = state.subtitleUrl?.replace(/^\/api\/watch\/media\/[a-f0-9]+\//, '') || '';
    if (key !== this.key) {
      this.reset();
      this.key = key;
    }
    this.url = state.subtitleUrl;
    const serverOffset = state.tracks?.subtitleOffset;
    if (serverOffset !== undefined) {
      const normalizedServer = normalizeSubtitleOffset(serverOffset, this.serverOffset);
      if (normalizedServer !== this.serverOffset) {
        this.serverOffset = normalizedServer;
        this.setOffset(normalizedServer);
      }
    }
    if (!this.url) {
      this.status({ message: state.tracks?.subtitleError || '', error: !!state.tracks?.subtitleError, loading: false });
      return;
    }
    this.setTrackMode(this.renderer ? 'disabled' : 'hidden');
    if (this.streaming || this.windowScheduler) this.syncStatus();
    if (!this.loaded && !this.loading && !this.timer && this.attempts < 3) void this.load();
  }
  rebuild() {
    this.clearCues();
    for (const item of this.cues) this.addCue(item);
    this.paint();
  }
  addCue(item) {
    const start = Math.max(0, item.start + (this.offset || 0)),
      end = item.end + (this.offset || 0);
    if (end <= start) return;
    const cue = new VTTCue(start, end, item.text);
    const line = /(?:^|\s)line:(\d{1,3})(?:\.\d+)?%/.exec(item.settings || '');
    cue.uburoomTop = !!line && Number(line[1]) < 50;
    this.track.addCue(cue);
    this.invalidateCueSnapshot();
  }
  paint() {
    if (!this.layer) return;
    const topList = [];
    const bottomList = [];
    if (this.track.mode !== 'disabled' && this.surface.isUbuPlayer()) {
      const now = this.mediaTime();
      if (this.cueSnapshot !== null && now >= this.cueValidFrom && now < this.cueValidUntil) return;
      const snapshot = this.getCueSnapshot();
      let from = -Infinity;
      let until = Infinity;
      for (let i = 0; i < snapshot.length; i++) {
        const cue = snapshot[i];
        const start = cue.startTime;
        const end = cue.endTime;
        if (now >= start && now < end) {
          if (start > from) from = start;
          if (end < until) until = end;
          if (cue.uburoomTop) topList.push(cue);
          else bottomList.push(cue);
        } else if (end <= now) {
          if (end > from) from = end;
        } else if (start > now) {
          if (start < until) until = start;
        }
      }
      if (Number.isFinite(now)) {
        this.cueValidFrom = from;
        this.cueValidUntil = until;
      } else {
        this.cueValidFrom = Infinity;
        this.cueValidUntil = -Infinity;
      }
    } else {
      this.cueValidFrom = Infinity;
      this.cueValidUntil = -Infinity;
      if (this.track.mode !== 'disabled') {
        const active = this.track.activeCues;
        if (active) {
          for (let i = 0; i < active.length; i++) {
            const cue = active[i];
            if (cue.uburoomTop) topList.push(cue);
            else bottomList.push(cue);
          }
        }
      }
    }
    if (!sameCueList(this.renderedTopCues, topList)) {
      this.renderedTopCues = topList;
      renderCueBox(this.topCues, topList);
    }
    if (!sameCueList(this.renderedBottomCues, bottomList)) {
      this.renderedBottomCues = bottomList;
      renderCueBox(this.bottomCues, bottomList);
    }
  }
  // Follows the visible picture, or the whole player, and clears the controls only when they would cover the text.
  place() {
    if (!this.layer) return;
    const stageEl = this.surface.stageElement();
    const width = stageEl?.clientWidth || 0,
      height = stageEl?.clientHeight || 0;
    if (!width || !height) return;
    let left = 0,
      top = 0,
      boxWidth = width,
      boxHeight = height;
    const videoW = this.surface.width(),
      videoH = this.surface.height();
    if (this.position === 'video' && videoW && videoH) {
      const scale = Math.min(width / videoW, height / videoH);
      boxWidth = videoW * scale;
      boxHeight = videoH * scale;
      left = (width - boxWidth) / 2;
      top = (height - boxHeight) / 2;
    }
    const fontSize = Math.max(13, Math.min(height, (width * 9) / 16) * (TEXT_SIZES[this.size] || TEXT_SIZES.medium));
    const lift = Math.max(fontSize * 0.8, this.controlsHeight + 8 - (height - top - boxHeight));
    Object.assign(this.layer.style, {
      left: left + 'px',
      top: top + 'px',
      width: boxWidth + 'px',
      height: boxHeight + 'px',
    });
    this.layer.style.setProperty('--subtitle-size', fontSize + 'px');
    this.layer.style.setProperty('--subtitle-lift', lift + 'px');
  }
  appearance({ position, size }) {
    this.position = position;
    this.size = size;
    this.place();
  }
  layout(controlsHeight) {
    if (this.controlsHeight === controlsHeight) return;
    this.controlsHeight = controlsHeight;
    this.place();
  }
  retry() {
    if (this.textWindows) {
      this.textWindows.retry();
      return;
    }
    if (this.renderFailed) {
      const url = this.url,
        key = this.key;
      this.reset();
      this.url = url;
      this.key = key;
    }
    if (this.windowScheduler) {
      this.windowScheduler.retry();
      return;
    }
    clearTimeout(this.timer);
    this.timer = undefined;
    this.attempts = 0;
    if (this.url && !this.loading) void this.load();
  }
  async load() {
    const generation = this.generation,
      url = this.url;
    if (!url) return;
    this.loading = true;
    const abort = (this.abort = new AbortController());
    try {
      this.status({ message: 'Loading subtitles…', error: false, loading: true });
      const response = await fetch(url, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(90000)]) }),
        value = await response.json();
      if (!response.ok)
        throw Object.assign(new Error(value.error || 'Subtitles could not load.'), {
          terminal: response.status === 403,
        });
      if (generation !== this.generation) return;
      if (value.format === 'cues') {
        if (
          typeof value.window !== 'string' ||
          !value.window.startsWith(url + '/') ||
          !value.window.endsWith('/window')
        )
          throw new Error('Invalid subtitle window.');
        this.textWindows = new uburoomTextWindows(
          value.window,
          cues => {
            let replaced = false;
            for (const cue of cues) {
              const key = cueDedupKey(cue);
              const existing = this.cuesByKey.get(key);
              if (existing) {
                if (cue.start < existing.start - 0.001) {
                  existing.start = cue.start;
                  replaced = true;
                }
              } else {
                this.cues.push(cue);
                this.cuesByKey.set(key, cue);
                this.addCue(cue);
              }
            }
            if (this.cues.length > 2500) {
              const now = this.mediaTime() - (this.offset || 0);
              this.cues.sort((a, b) => Math.abs(a.start - now) - Math.abs(b.start - now));
              const dropped = this.cues.splice(2000);
              this.cues.sort((a, b) => a.start - b.start);
              let leftCutMs = 0,
                rightCutMs = Infinity;
              const nowMs = Math.round(now * 1000);
              for (const cue of dropped) {
                this.cuesByKey.delete(cueDedupKey(cue));
                if (cue.start <= now) leftCutMs = Math.max(leftCutMs, Math.min(nowMs, Math.ceil(cue.end * 1000)));
                else rightCutMs = Math.min(rightCutMs, Math.max(nowMs, Math.floor(cue.start * 1000)));
              }
              this.textWindows?.prune(leftCutMs, rightCutMs, dropped);
              replaced = true;
            }
            if (replaced) this.rebuild();
          },
          (error, failed) => {
            this.status(
              error
                ? {
                    message: failed ? error.message : 'Retrying subtitles…',
                    error: !!failed,
                    loading: !failed,
                    burnFallback: !!failed,
                  }
                : { message: '', error: false, loading: false },
            );
          },
          abort.signal,
        );
        this.textWindows.check(this.mediaTime() - (this.offset || 0));
        this.loaded = true;
        return;
      }
      if (value.format) {
        if (!['ass', 'pgs', 'vobsub'].includes(value.format) || !Array.isArray(value.fonts) || value.fonts.length > 32)
          throw new Error('Invalid subtitle response.');
        const asset = async (name, limit) => {
          if (
            typeof name !== 'string' ||
            !name.startsWith(url + '/') ||
            !/(?:\/data|\/index|\/font-\d{1,2})$/.test(name)
          )
            throw new Error('Invalid subtitle asset.');
          const result = await fetch(name, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]) });
          if (!result.ok) throw new Error('Subtitle resource could not load. Retry or choose burn-in.');
          const reader = result.body.getReader(),
            chunks = [];
          let size = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.length;
              if (size > limit) throw new Error('Subtitle resource exceeds the supported size.');
              chunks.push(value);
            }
          } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let at = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, at);
            at += chunk.length;
          }
          return bytes;
        };
        let data, subUrl;
        if (value.window && ['pgs', 'ass', 'vobsub'].includes(value.format)) subUrl = value.data;
        else if (value.format === 'pgs') subUrl = value.data;
        else data = await asset(value.data, value.format === 'ass' ? 4 * 1024 * 1024 : 64 * 1024 * 1024);
        const index = value.index ? await asset(value.index, 1024 * 1024) : undefined;
        if (value.fonts.length) this.status({ message: 'Loading subtitle fonts…', error: false, loading: true });
        const fonts = [];
        let fontSize = 0;
        for (const font of value.fonts) {
          const bytes = await asset(font, 16 * 1024 * 1024 - fontSize);
          fontSize += bytes.length;
          fonts.push(bytes);
        }
        this.status({ message: 'Preparing subtitles…', error: false, loading: true });
        const renderer = await uburoomSubtitleRenderers.create(
          this.surface,
          value.format,
          { data, subUrl, index, fonts, fileName: value.fileName },
          this.offset || 0,
          abort.signal,
          this.resolveMediaTime,
        );
        if (generation !== this.generation) {
          renderer.destroy();
          return;
        }
        this.renderer = renderer;
        renderer.offset(this.offset || 0);
        this.setTrackMode('disabled');
        this.paint();
        if (value.window && value.format === 'pgs') {
          this.streamSynced = undefined;
          if (
            typeof value.window !== 'string' ||
            !value.window.startsWith(url + '/') ||
            !value.window.endsWith('/window')
          )
            throw new Error('Invalid subtitle window.');
          const scheduler = (this.windowScheduler = new uburoomSubtitleWindows(
            renderer,
            value.window,
            () => {
              this.streamSynced = undefined;
              this.syncStatus();
            },
            abort.signal,
            (error, failed) => {
              if (error.terminal) renderer.destroy();
              this.status({
                message: failed ? error.message : 'Retrying subtitles…',
                error: !!failed,
                loading: !failed,
                burnFallback: !!error.burnFallback,
              });
            },
          ));
          this.syncStatus();
          scheduler.check(this.mediaTime() - (this.offset || 0));
        } else if (subUrl) {
          if (typeof subUrl !== 'string' || !subUrl.startsWith(url + '/') || !subUrl.endsWith('/data'))
            throw new Error('Invalid subtitle asset.');
          // Stall timers are backstops for the server's own FFmpeg idle limit. They
          // abort only this request so the failure is reported and retried; the
          // shared controller stays reserved for reset/cancellation. Headers wait
          // for the first extracted packet, which can follow a long demux catch-up.
          const stall = new AbortController(),
            stalled = () => stall.abort(new Error('Subtitle stream timed out. Retry or choose burn-in.'));
          const signal = AbortSignal.any([abort.signal, stall.signal]);
          const interrupted = error =>
            abort.signal.aborted
              ? error
              : stall.signal.aborted
                ? stall.signal.reason
                : error instanceof TypeError || error?.name === 'AbortError'
                  ? new Error('Subtitle stream was interrupted. Retry or choose burn-in.')
                  : error;
          const headerTimer = setTimeout(stalled, 310000);
          let result;
          try {
            result = await fetch(subUrl, { signal });
          } catch (error) {
            throw interrupted(error);
          } finally {
            clearTimeout(headerTimer);
          }
          if (!result.ok || !result.body) {
            const value = await result.json().catch(() => ({}));
            throw Object.assign(
              new Error(value.error || 'Subtitle resource could not load. Retry or choose burn-in.'),
              { terminal: result.status === 403 },
            );
          }
          const reader = result.body.getReader(),
            limit = 64 * 1024 * 1024;
          let size = 0,
            idleTimer;
          const resetIdle = () => {
            clearTimeout(idleTimer);
            idleTimer = setTimeout(stalled, 310000);
          };
          this.streaming = true;
          this.streamSynced = false;
          this.syncStatus();
          resetIdle();
          try {
            for (;;) {
              let next;
              try {
                next = await reader.read();
              } catch (error) {
                throw interrupted(error);
              }
              const { done, value: chunk } = next;
              if (done) break;
              resetIdle();
              if (!chunk || !chunk.byteLength) continue;
              size += chunk.byteLength;
              if (size > limit) throw new Error('Subtitle resource exceeds the supported size.');
              const added = await renderer.append(chunk);
              if (added > 0) this.syncStatus();
            }
            clearTimeout(idleTimer);
            await renderer.flush();
            this.streaming = false;
            this.streamSynced = true;
          } finally {
            clearTimeout(idleTimer);
            await reader.cancel().catch(() => {});
            reader.releaseLock();
          }
        }
      } else {
        if (
          !Array.isArray(value.cues) ||
          value.cues.some(c => !Number.isFinite(c.start) || !Number.isFinite(c.end) || typeof c.text !== 'string')
        )
          throw new Error('Invalid subtitle response.');
        this.cues = value.cues;
        this.indexCues();
        this.rebuild();
      }
      this.loaded = true;
      if (!this.windowScheduler) this.status({ message: '', error: false, loading: false });
    } catch (error) {
      if (generation !== this.generation || abort.signal.aborted) return;
      // Release this attempt's renderer and requests before retrying so a
      // retry never stacks a second overlay over a stale partial stream.
      abort.abort();
      this.renderer?.destroy();
      this.renderer = undefined;
      this.streaming = false;
      this.streamSynced = false;
      this.attempts = error.terminal ? 3 : this.attempts + 1;
      const failed = this.attempts >= 3;
      this.status({
        message: failed ? error.message : 'Retrying subtitles…',
        error: failed,
        loading: !failed,
        burnFallback: !!error.burnFallback,
      });
      if (!failed)
        this.timer = setTimeout(
          () => {
            this.timer = undefined;
            void this.load();
          },
          1000 * 2 ** (this.attempts - 1),
        );
    } finally {
      if (generation === this.generation) this.loading = false;
    }
  }
  destroy() {
    for (const event of ['seeking', 'seeked', 'timeupdate']) this.surface.removeEventListener(event, this.onTimeChange);
    if (this.onPlace) {
      for (const event of ['loadedmetadata', 'resize']) this.surface.removeEventListener(event, this.onPlace);
    }
    this.reset();
  }
}
function parseSubtitleTimestamp(raw) {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[,.](\d{1,3})$/.exec(raw.trim());
  if (!m) return undefined;
  const h = Number(m[1] || 0);
  const min = Number(m[2]);
  const sec = Number(m[3]);
  const ms = Number(m[4].padEnd(3, '0'));
  return h * 3600 + min * 60 + sec + ms / 1000;
}
function parseSubtitleText(rawText) {
  const normalized = String(rawText || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const blocks = normalized.split(/\n{2,}/);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trimEnd());
    let arrowLineIdx = -1;
    for (let i = 0; i < Math.min(lines.length, 3); i++) {
      if (lines[i].includes('-->')) {
        arrowLineIdx = i;
        break;
      }
    }
    if (arrowLineIdx < 0) continue;
    const parts = lines[arrowLineIdx].split('-->');
    const start = parseSubtitleTimestamp(parts[0]);
    const endAndSettings = (parts[1] || '').trim().split(/\s+/);
    const end = parseSubtitleTimestamp(endAndSettings[0] || '');
    const settings = endAndSettings.slice(1).join(' ');
    if (start === undefined || end === undefined || end <= start) continue;
    const text = lines
      .slice(arrowLineIdx + 1)
      .join('\n')
      .replace(/\{\\[^}]*\}/g, '')
      .trim();
    if (text) cues.push({ start, end, text, settings });
  }
  return cues;
}
export {
  parseSubtitleText,
  SUBTITLE_OFFSET_MAX,
  SUBTITLE_OFFSET_MIN,
  formatSubtitleOffset,
  normalizeSubtitleOffset,
  pgsWindowBytes,
  uburoomSubtitleWindows,
  uburoomSubtitles,
};
