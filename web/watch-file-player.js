import * as uburoomPlayback from './playback-policy.js';

/* Unified client media player for container files (MKV, MP4/MOV, WebM, MPEG-TS, AVI):
 * drives web/watch-file-worker.js over either a local File/Blob (Blob.slice) or an HTTP
 * Range URL (uburoom /api/watch/media or Direct from Plex), feeding fragmented MP4 into
 * MediaSource SourceBuffers with bounded memory, live audio-track switching and embedded subtitles.
 */

const HTTP_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_HTTP_CHUNKS = 8;

function detectPassthroughAudioCodecs() {
  if (typeof MediaSource === 'undefined' || typeof MediaSource.isTypeSupported !== 'function') return [];
  const canChangeType = typeof SourceBuffer !== 'undefined' && typeof SourceBuffer.prototype?.changeType === 'function';
  const probes = [
    ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
    ['opus', 'audio/mp4; codecs="opus"'],
    ['flac', 'audio/mp4; codecs="flac"'],
    ['mp3', 'audio/mp4; codecs="mp4a.40.34"'],
  ];
  const supported = probes.filter(([, mime]) => {
    try {
      return MediaSource.isTypeSupported(mime);
    } catch {
      return false;
    }
  });
  if (canChangeType) return supported.map(([codec]) => codec);
  const fallback = MediaSource.isTypeSupported('audio/mp4; codecs="flac"') ? 'flac' : 'aac';
  return supported.filter(([codec]) => codec === fallback).map(([codec]) => codec);
}

function parseContentRangeTotal(header) {
  const match = /^bytes\s+\d+-\d+\/(\d+)$/i.exec(String(header || '').trim());
  return match ? Number(match[1]) : undefined;
}

class BlobRangeReader {
  constructor(file) {
    this.file = file;
    this.size = file.size;
  }
  async probe() {
    const end = Math.min(this.size, 1024 * 1024);
    const bytes = new Uint8Array(await this.file.slice(0, end).arrayBuffer());
    return { fileSize: this.size, initialBytes: bytes };
  }
  async read(start, end) {
    if (start >= this.size || end <= start) return new Uint8Array(0);
    const buf = await this.file.slice(start, Math.min(this.size, end)).arrayBuffer();
    return new Uint8Array(buf);
  }
  abort() {}
}

class HttpRangeReader {
  constructor(url, { direct = false, fileSize, signal } = {}) {
    this.url = url;
    this.direct = direct;
    this.size = Number(fileSize) > 0 ? Number(fileSize) : undefined;
    this.signal = signal;
    this.chunks = new Map();
    this.inflight = new Map();
  }
  fetchInit(rangeHeader, extraSignal) {
    const signals = [this.signal, extraSignal, AbortSignal.timeout(this.direct ? 10000 : 35000)].filter(Boolean);
    return {
      headers: { Range: rangeHeader },
      ...(this.direct
        ? { mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' }
        : { credentials: 'same-origin' }),
      signal: AbortSignal.any(signals),
    };
  }
  async fetchSpan(start, endInclusive) {
    let response;
    try {
      response = await fetch(this.url, this.fetchInit(`bytes=${start}-${endInclusive}`));
    } catch (err) {
      if (this.direct) err.kind = 'direct-failed';
      throw err;
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      const error = new Error('Media stream byte range could not load.');
      error.status = response.status;
      if (this.direct) error.kind = 'direct-failed';
      else if ([401, 403].includes(response.status)) error.kind = 'grant-expired';
      throw error;
    }
    const total = parseContentRangeTotal(response.headers.get('content-range'));
    if (total > 0) this.size = total;
    else if (response.status === 200 && !this.size) {
      const len = Number(response.headers.get('content-length'));
      if (len > 0) this.size = len;
    }
    if (response.status === 200 && start > 0) {
      await response.body?.cancel().catch(() => {});
      const error = new Error('Media server does not support HTTP byte-range requests.');
      if (this.direct) error.kind = 'direct-failed';
      throw error;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!this.size && start === 0 && bytes.length < endInclusive - start + 1) {
      this.size = bytes.length;
    }
    return bytes;
  }
  async probe() {
    const firstEnd = HTTP_CHUNK_BYTES - 1;
    const bytes = await this.fetchSpan(0, firstEnd);
    if (!this.size) throw new Error('Could not determine media file byte length for range playback.');
    this.storeChunk(0, bytes);
    const initial = bytes.subarray(0, Math.min(bytes.length, 1024 * 1024)).slice();
    return { fileSize: this.size, initialBytes: initial };
  }
  storeChunk(chunkIdx, bytes) {
    if (this.chunks.has(chunkIdx)) this.chunks.delete(chunkIdx);
    this.chunks.set(chunkIdx, bytes);
    while (this.chunks.size > MAX_HTTP_CHUNKS) {
      const oldest = this.chunks.keys().next().value;
      this.chunks.delete(oldest);
    }
  }
  async getChunk(chunkIdx) {
    if (this.chunks.has(chunkIdx)) {
      const hit = this.chunks.get(chunkIdx);
      this.chunks.delete(chunkIdx);
      this.chunks.set(chunkIdx, hit);
      return hit;
    }
    if (this.inflight.has(chunkIdx)) return this.inflight.get(chunkIdx);
    const start = chunkIdx * HTTP_CHUNK_BYTES;
    if (this.size && start >= this.size) return new Uint8Array(0);
    const endInclusive = this.size
      ? Math.min(this.size - 1, start + HTTP_CHUNK_BYTES - 1)
      : start + HTTP_CHUNK_BYTES - 1;
    const req = this.fetchSpan(start, endInclusive)
      .then(bytes => {
        this.storeChunk(chunkIdx, bytes);
        return bytes;
      })
      .finally(() => {
        this.inflight.delete(chunkIdx);
      });
    this.inflight.set(chunkIdx, req);
    return req;
  }
  async read(start, end) {
    if (this.size && start >= this.size) return new Uint8Array(0);
    const clampedEnd = this.size ? Math.min(this.size, end) : end;
    if (clampedEnd <= start) return new Uint8Array(0);
    const firstChunk = Math.floor(start / HTTP_CHUNK_BYTES);
    const lastChunk = Math.floor((clampedEnd - 1) / HTTP_CHUNK_BYTES);
    const parts = [];
    let total = 0;
    for (let idx = firstChunk; idx <= lastChunk; idx++) {
      const chunk = await this.getChunk(idx);
      const chunkStart = idx * HTTP_CHUNK_BYTES;
      const relStart = Math.max(0, start - chunkStart);
      const relEnd = Math.min(chunk.length, clampedEnd - chunkStart);
      if (relEnd > relStart) {
        const sub = chunk.subarray(relStart, relEnd);
        parts.push(sub);
        total += sub.length;
      }
    }
    if (parts.length === 1) return parts[0].slice();
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      out.set(p, offset);
      offset += p.length;
    }
    return out;
  }
  abort() {
    this.chunks.clear();
    this.inflight.clear();
  }
}

export async function probeLocalFile(file) {
  const reader = new BlobRangeReader(file);
  const { fileSize, initialBytes } = await reader.probe();
  const worker = new Worker('/watch-file-worker.js', { type: 'module' });
  const flacSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Timed out reading local file headers.'));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timer);
      try {
        worker.postMessage({ type: 'close' });
      } catch {}
      setTimeout(() => worker.terminate(), 50);
    };
    worker.onerror = ev => {
      cleanup();
      reject(ev.error || new Error(ev.message || 'Could not inspect local file.'));
    };
    worker.onmessage = async event => {
      const msg = event.data;
      if (!msg) return;
      if (msg.type === 'read') {
        try {
          const bytes = await reader.read(msg.start, msg.end);
          worker.postMessage({ type: 'readResult', id: msg.id, bytes: bytes.buffer }, [bytes.buffer]);
        } catch (err) {
          worker.postMessage({ type: 'readResult', id: msg.id, error: err.message });
        }
      } else if (msg.type === 'probed') {
        cleanup();
        const mseSupported =
          typeof MediaSource !== 'undefined' && Boolean(msg.video?.mime) && MediaSource.isTypeSupported(msg.video.mime);
        resolve({ ...msg, fileSize, mseSupported });
      } else if (msg.type === 'error') {
        cleanup();
        reject(new Error(msg.message || 'Unsupported media file.'));
      }
    };
    worker.postMessage(
      {
        type: 'init',
        probeOnly: true,
        fileSize,
        flacSupported,
        initialBytes: initialBytes.buffer,
      },
      [initialBytes.buffer],
    );
  });
}

export class uburoomFilePlayer {
  constructor(video, input, target, failed, options = {}) {
    this.video = video;
    this.input = input;
    this.target = target;
    this.failed = failed;
    this.options = options;
    this.abort = new AbortController();
    this.destroyed = false;
    this.held = false;
    this.seekGen = 0;
    this.audioGen = 0;
    this.subGen = 0;
    this.duration = Number(options.duration) || 0;
    this.selectedAudioId = options.audioId || null;
    this.selectedSubtitleId = options.subtitleId || null;
    this.audioMode = ['normal', 'dialogue', 'night'].includes(options.audioMode) ? options.audioMode : 'normal';
    this.audioPassthrough = false;
    this.surroundDialogueActive = false;
    this.appendChain = Promise.resolve();
    this.endSignalled = false;
    this.lastSeekTarget = -Infinity;

    this.reader = input.file
      ? new BlobRangeReader(input.file)
      : new HttpRangeReader(input.url, {
          direct: !!input.direct,
          fileSize: input.fileSize,
          signal: this.abort.signal,
        });

    this.onSeek = () => this.handleSeek();
    this.onTimeUpdate = () => this.kick(false);
    this.onNeedData = () => this.kick(true);
    video.addEventListener('seeking', this.onSeek);
    video.addEventListener('timeupdate', this.onTimeUpdate);
    video.addEventListener('waiting', this.onNeedData);
    video.addEventListener('stalled', this.onNeedData);

    this.source = new MediaSource();
    this.objectUrl = URL.createObjectURL(this.source);
    this.source.addEventListener('sourceopen', () => this.start().catch(err => this.fail(err)), { once: true });
    video.removeAttribute('crossorigin');
    video.src = this.objectUrl;
  }

  hold() {
    this.held = true;
  }

  async start() {
    const { fileSize, initialBytes } = await this.reader.probe();
    if (this.destroyed || this.abort.signal.aborted) return;

    this.worker = new Worker('/watch-file-worker.js', { type: 'module' });
    this.worker.onerror = ev => this.fail(ev.error || new Error(ev.message || 'Media worker crashed.'));
    this.worker.onmessage = event => this.handleWorkerMessage(event.data);

    const flacSupported = typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('audio/mp4; codecs="flac"');
    const passthroughAudioCodecs = detectPassthroughAudioCodecs();
    const startPos = Math.max(0, Number(this.target?.()) || 0);
    this.lastSeekTarget = startPos;

    this.worker.postMessage(
      {
        type: 'init',
        fileSize,
        flacSupported,
        audioMode: this.audioMode,
        passthroughAudioCodecs,
        audioId: this.selectedAudioId,
        serverAudioIds: this.options.serverAudioIds,
        startTime: startPos,
        aheadSeconds: uburoomPlayback.BUFFER.ahead,
        initialBytes: initialBytes.buffer,
      },
      [initialBytes.buffer],
    );
  }

  enqueueAppend(fn) {
    this.appendChain = this.appendChain.then(
      () => (this.destroyed ? undefined : fn()),
      () => (this.destroyed ? undefined : fn()),
    );
    return this.appendChain;
  }

  bufferOp(sb, action) {
    if (!sb || this.destroyed || this.source.readyState !== 'open') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = err => {
        sb.removeEventListener('updateend', onDone);
        sb.removeEventListener('error', onErr);
        this.abort.signal.removeEventListener('abort', onAbort);
        err ? reject(err) : resolve();
      };
      const onDone = () => cleanup();
      const onErr = () => cleanup(new Error('Browser MediaSource rejected media segment.'));
      const onAbort = () => cleanup();
      sb.addEventListener('updateend', onDone, { once: true });
      sb.addEventListener('error', onErr, { once: true });
      this.abort.signal.addEventListener('abort', onAbort, { once: true });
      try {
        action();
      } catch (err) {
        cleanup(err);
      }
    });
  }

  async appendSafe(sb, bytes) {
    if (!sb || !bytes?.byteLength || this.destroyed || this.source.readyState !== 'open') return;
    try {
      await this.bufferOp(sb, () => sb.appendBuffer(bytes));
    } catch (err) {
      if (err?.name === 'QuotaExceededError' || /quota/i.test(err?.message || '')) {
        await this.evictBehind(true);
        await this.bufferOp(sb, () => sb.appendBuffer(bytes));
        return;
      }
      throw err;
    }
  }

  async evictBehind(aggressive = false) {
    if (this.destroyed || this.source.readyState !== 'open') return;
    const now = Number(this.video.currentTime) || 0;
    const keepBehind = aggressive ? 8 : uburoomPlayback.BUFFER.behind;
    const cut = Math.max(0, now - keepBehind);
    if (cut <= 1) return;
    for (const sb of [this.videoBuffer, this.audioBuffer]) {
      if (!sb || sb.updating || !sb.buffered?.length) continue;
      const start = sb.buffered.start(0);
      if (cut > start + 1) {
        await this.bufferOp(sb, () => sb.remove(0, cut)).catch(() => {});
      }
    }
  }

  handleWorkerMessage(msg) {
    if (!msg || this.destroyed) return;
    if (msg.type === 'read') {
      void this.reader
        .read(msg.start, msg.end)
        .then(bytes => {
          if (this.destroyed) return;
          this.worker?.postMessage({ type: 'readResult', id: msg.id, bytes: bytes.buffer }, [bytes.buffer]);
        })
        .catch(err => {
          if (this.destroyed) return;
          if (err?.kind === 'direct-failed' || err?.kind === 'grant-expired') {
            this.fail(err);
            return;
          }
          this.worker?.postMessage({ type: 'readResult', id: msg.id, error: err.message });
        });
      return;
    }
    if (msg.type === 'error') {
      this.fail(new Error(msg.message || 'Media playback failed.'));
      return;
    }
    if (msg.type === 'ready') {
      void this.enqueueAppend(async () => {
        if (this.destroyed || this.source.readyState !== 'open') return;
        if (!MediaSource.isTypeSupported(msg.video.mime)) {
          throw Object.assign(
            new Error(`Browser cannot decode ${msg.video.codec.toUpperCase()} (${msg.video.mime}).`),
            {
              kind: 'codec-unsupported',
            },
          );
        }
        this.videoMime = msg.video.mime;
        this.audioMime = msg.audioMime;
        this.audioPassthrough = Boolean(msg.audioPassthrough);
        this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
        this.selectedAudioId = msg.selectedAudioId;
        this.metadata = {
          duration: msg.duration,
          video: msg.video,
          audioTracks: msg.audioTracks,
          subtitleTracks: msg.subtitleTracks,
          chapters: msg.chapters,
        };
        if (msg.duration > 0) {
          this.duration = msg.duration;
          try {
            this.source.duration = msg.duration;
          } catch {}
        }
        this.videoBuffer = this.source.addSourceBuffer(msg.video.mime);
        if (msg.audioMime && MediaSource.isTypeSupported(msg.audioMime)) {
          this.audioBuffer = this.source.addSourceBuffer(msg.audioMime);
        }
        if (msg.videoInit?.byteLength) await this.appendSafe(this.videoBuffer, new Uint8Array(msg.videoInit));
        if (msg.audioInit?.byteLength && this.audioBuffer) {
          await this.appendSafe(this.audioBuffer, new Uint8Array(msg.audioInit));
        }
        this.options.onMetadata?.(this.metadata);
        this.options.onAudioStateChange?.();
        if (this.selectedSubtitleId) this.selectSubtitle(this.selectedSubtitleId);
      }).catch(err => this.fail(err));
      return;
    }
    if (msg.type === 'segment') {
      if (msg.seekGen !== this.seekGen) return;
      void this.enqueueAppend(async () => {
        if (this.destroyed || msg.seekGen !== this.seekGen || this.source.readyState !== 'open') return;
        if (msg.videoInit?.byteLength) {
          if (!this.videoBuffer) {
            const mime = msg.videoMime || this.videoMime;
            if (!MediaSource.isTypeSupported(mime)) {
              throw Object.assign(new Error(`Browser cannot decode video (${mime}).`), { kind: 'codec-unsupported' });
            }
            this.videoBuffer = this.source.addSourceBuffer(mime);
          }
          await this.appendSafe(this.videoBuffer, new Uint8Array(msg.videoInit));
        }
        if (msg.videoBytes?.byteLength && this.videoBuffer) {
          await this.appendSafe(this.videoBuffer, new Uint8Array(msg.videoBytes));
        }
        if (msg.audioGen === this.audioGen && msg.audioBytes?.byteLength && this.audioBuffer) {
          await this.appendSafe(this.audioBuffer, new Uint8Array(msg.audioBytes));
        }
        await this.evictBehind(false);
        if (msg.eof && !this.endSignalled && this.source.readyState === 'open') {
          this.endSignalled = true;
          try {
            if (!this.videoBuffer?.updating && !this.audioBuffer?.updating) this.source.endOfStream();
          } catch {}
        }
      }).catch(err => this.fail(err));
      return;
    }
    if (msg.type === 'audioSwitched') {
      if (msg.audioGen !== this.audioGen) return;
      this.selectedAudioId = msg.selectedAudioId;
      this.audioPassthrough = Boolean(msg.audioPassthrough);
      this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
      this.options.onAudioStateChange?.();
      void this.enqueueAppend(async () => {
        if (this.destroyed || !this.audioBuffer || this.source.readyState !== 'open') return;
        if (this.audioBuffer.buffered?.length) {
          const end = this.audioBuffer.buffered.end(this.audioBuffer.buffered.length - 1);
          if (end > 0) await this.bufferOp(this.audioBuffer, () => this.audioBuffer.remove(0, end + 1)).catch(() => {});
        }
        if (msg.audioMime && msg.audioMime !== this.audioMime && typeof this.audioBuffer.changeType === 'function') {
          this.audioBuffer.changeType(msg.audioMime);
          this.audioMime = msg.audioMime;
        }
        if (msg.audioInit?.byteLength) {
          await this.appendSafe(this.audioBuffer, new Uint8Array(msg.audioInit));
        }
      }).catch(err => this.fail(err));
      return;
    }
    if (msg.type === 'audioModeApplied') {
      this.audioPassthrough = Boolean(msg.audioPassthrough);
      this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
      this.options.onAudioStateChange?.();
      return;
    }
    if (msg.type === 'subtitleReseed') {
      if (Number.isInteger(msg.seekGen) && msg.seekGen > this.seekGen) {
        this.seekGen = msg.seekGen;
        this.endSignalled = false;
      }
      return;
    }
    if (msg.type === 'subtitleInit') {
      if (msg.subGen !== this.subGen) return;
      this.options.onSubtitleInit?.(msg);
      return;
    }
    if (msg.type === 'subtitleCues') {
      if (msg.subGen !== this.subGen) return;
      this.options.onSubtitleCues?.(msg.cues);
      return;
    }
    if (msg.type === 'subtitleData') {
      if (msg.subGen !== this.subGen) return;
      this.options.onSubtitleData?.(msg.format, new Uint8Array(msg.data));
    }
  }

  isBufferedNear(seconds) {
    const buf = this.video.buffered;
    if (!buf?.length) return false;
    for (let i = 0; i < buf.length; i++) {
      if (seconds >= buf.start(i) - 0.25 && seconds + 1.0 <= buf.end(i)) return true;
    }
    return false;
  }

  handleSeek() {
    if (this.destroyed || this.held || !this.worker) return;
    const pos = Math.max(0, Number(this.video.currentTime) || 0);
    if (this.isBufferedNear(pos)) {
      this.kick(true);
      return;
    }
    if (Math.abs(pos - this.lastSeekTarget) < 0.2) return;
    this.lastSeekTarget = pos;
    this.endSignalled = false;
    const gen = ++this.seekGen;
    this.worker.postMessage({
      type: 'seek',
      seekGen: gen,
      time: pos,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
  }

  kick(urgent = false) {
    if (this.destroyed || this.held || !this.worker) return;
    const pos = Math.max(0, Number(this.video.currentTime) || 0);
    const ahead = uburoomPlayback.bufferedAhead(this.video.buffered, pos);
    const threshold = urgent ? uburoomPlayback.BUFFER.ahead : uburoomPlayback.BUFFER.ahead * 0.65;
    if (ahead < threshold && !this.endSignalled) {
      this.worker.postMessage({
        type: 'pump',
        targetUntil: pos + uburoomPlayback.BUFFER.ahead,
      });
    }
  }

  selectAudio(audioId) {
    if (this.destroyed || !this.worker || audioId === this.selectedAudioId) return;
    this.selectedAudioId = audioId;
    this.endSignalled = false;
    const aGen = ++this.audioGen;
    const sGen = ++this.seekGen;
    const pos = Math.max(0, Number(this.video.currentTime) || Number(this.target?.()) || 0);
    this.lastSeekTarget = pos;
    this.worker.postMessage({
      type: 'selectAudio',
      audioGen: aGen,
      seekGen: sGen,
      audioId,
      time: pos,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
  }

  setAudioMode(mode) {
    const nextMode = ['normal', 'dialogue', 'night'].includes(mode) ? mode : 'normal';
    if (this.destroyed || nextMode === this.audioMode) return;
    this.audioMode = nextMode;
    if (!this.worker) return;
    this.endSignalled = false;
    const aGen = ++this.audioGen;
    const sGen = ++this.seekGen;
    const pos = Math.max(0, Number(this.video.currentTime) || Number(this.target?.()) || 0);
    this.lastSeekTarget = pos;
    this.worker.postMessage({
      type: 'setAudioMode',
      mode: nextMode,
      audioGen: aGen,
      seekGen: sGen,
      time: pos,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
  }

  selectSubtitle(subtitleId) {
    if (this.destroyed || !this.worker) return;
    this.selectedSubtitleId = subtitleId || null;
    const gen = ++this.subGen;
    const pos = Math.max(0, Number(this.video.currentTime) || Number(this.target?.()) || 0);
    this.worker.postMessage({
      type: 'selectSubtitle',
      subGen: gen,
      subtitleId: this.selectedSubtitleId,
      time: this.selectedSubtitleId ? pos : undefined,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
  }

  fail(error) {
    if (this.destroyed) return;
    const message = error?.message || 'File playback failed.';
    this.destroy();
    this.failed?.(message, error);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.abort.abort();
    this.reader?.abort();
    this.video.removeEventListener('seeking', this.onSeek);
    this.video.removeEventListener('timeupdate', this.onTimeUpdate);
    this.video.removeEventListener('waiting', this.onNeedData);
    this.video.removeEventListener('stalled', this.onNeedData);
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'close' });
      } catch {}
      const w = this.worker;
      this.worker = undefined;
      setTimeout(() => w.terminate(), 50);
    }
    if (this.objectUrl) {
      if (this.video?.src === this.objectUrl) {
        this.video.removeAttribute('src');
        this.video.load();
      }
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = undefined;
    }
  }
}
