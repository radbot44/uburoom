// @ts-check
import * as uburoomPlayback from './playback-policy.js';

/* UbuPlayer: Native WebCodecs + AudioWorklet + OffscreenCanvas client media engine.
 * Drives `/ubuplayer-worker.js` and `/ubuplayer-worklet.js` over either a local File/Blob
 * or an HTTP Range URL without any hidden `<video>` element or MediaSource SourceBuffers.
 * Hardware audio output (`AudioContext.getOutputTimestamp()`) is the single master clock.
 */

const HTTP_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_HTTP_CHUNKS = 10;
const SAMPLE_RATE = 48000;
const workletModulesLoaded = new WeakMap();

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
    this.etag = undefined;
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
    const responseEtag = response.headers.get('etag');
    if (responseEtag) {
      if (this.etag && this.etag !== responseEtag) {
        await response.body?.cancel().catch(() => {});
        throw new Error('Underlying media file changed during playback.');
      }
      this.etag = responseEtag;
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
    if (firstChunk === lastChunk && this.size && (lastChunk + 1) * HTTP_CHUNK_BYTES < this.size) {
      if (!this.chunks.has(lastChunk + 1) && !this.inflight.has(lastChunk + 1)) {
        void this.getChunk(lastChunk + 1).catch(() => {});
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

async function ensureWorkletModule(audioContext) {
  let pending = workletModulesLoaded.get(audioContext);
  if (!pending) {
    pending = audioContext.audioWorklet.addModule('/ubuplayer-worklet.js');
    workletModulesLoaded.set(audioContext, pending);
    pending.catch(() => workletModulesLoaded.delete(audioContext));
  }
  return pending;
}

/**
 * Probe a local File/Blob via `ubuplayer-worker.js` without loading `/vendor/libav/*`
 * on the main thread or when `ubuplayer` is disabled.
 * @param {Blob} file
 * @param {{ubuplayerEnabled?: boolean}} [options]
 */
export async function probeLocalFile(file, options = {}) {
  if (options?.ubuplayerEnabled === false) {
    throw new Error('UbuPlayer client playback is disabled.');
  }
  const reader = new BlobRangeReader(file);
  const { fileSize, initialBytes } = await reader.probe();
  const worker = new Worker('/ubuplayer-worker.js', { type: 'module' });
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
        let webCodecsSupported = typeof VideoDecoder === 'function' && Boolean(msg.video?.webCodecsCodec);
        if (webCodecsSupported && typeof VideoDecoder.isConfigSupported === 'function') {
          try {
            const check = await VideoDecoder.isConfigSupported({
              codec: msg.video.webCodecsCodec,
              codedWidth: msg.video.width || 1920,
              codedHeight: msg.video.height || 1080,
            });
            webCodecsSupported = Boolean(check?.supported);
          } catch {
            webCodecsSupported = false;
          }
        }
        resolve({ ...msg, fileSize, webCodecsSupported, mseSupported: webCodecsSupported });
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
        initialBytes: initialBytes.buffer,
      },
      [initialBytes.buffer],
    );
  });
}

export class UbuPlayer {
  /**
   * @param {HTMLCanvasElement | null} canvasElement
   * @param {{file?: Blob, url?: string, direct?: boolean, fileSize?: number}} input
   * @param {()=>number} target
   * @param {(message: string, error?: any)=>void} failed
   * @param {Record<string, any>} [options]
   */
  constructor(canvasElement, input, target, failed, options = {}) {
    this.canvasElement = canvasElement;
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

    this._readyState = 0;
    this._duration = Number(options.duration) > 0 ? Number(options.duration) : NaN;
    this._paused = true;
    this._ended = false;
    this._seeking = false;
    this._playbackRate = 1.0;
    this._volume = Number.isFinite(options.volume) ? Math.max(0, Math.min(1, options.volume)) : 1.0;
    this._muted = Boolean(options.muted);

    this.videoWidth = 0;
    this.videoHeight = 0;
    this.totalVideoFrames = 0;
    this.droppedVideoFrames = 0;
    this.bufferedStart = 0;
    this.bufferedEnd = 0;
    this.videoEof = false;
    this.audioEof = false;
    this.hasAudioTrack = true;

    this.selectedAudioId = options.audioId || null;
    this.selectedSubtitleId = options.subtitleId || null;
    this.audioMode = ['normal', 'dialogue', 'night'].includes(options.audioMode) ? options.audioMode : 'normal';
    this.targetHdr = Boolean(options.targetHdr);
    this.surroundDialogueActive = false;
    this.audioPassthrough = false;

    // Master audio clock state anchored to AudioContext.getOutputTimestamp()
    this.audioContext = options.audioContext || null;
    this.ownsAudioContext = false;
    this.audioDestination = options.audioDestination || null;
    this.workletNode = null;
    this.anchorMediaTime = Math.max(0, Number(target?.()) || 0);
    this.anchorContextTime = null;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletClockValid = false;
    this.lastUnderruns = 0;
    this.underrunWaiting = false;
    this.audioSwitchGen = 0;
    this.seekFrameReady = false;
    this.workletBufferedSeconds = 0;

    this.listeners = new Map();
    this.frameCallbacks = new Map();
    this.nextFrameCbId = 1;
    this.clockSyncTimer = null;

    this.buffered = {
      length: 0,
      start: index => {
        if (index !== 0 || !(this.bufferedEnd > this.bufferedStart)) throw new DOMException('Index out of bounds');
        return this.bufferedStart;
      },
      end: index => {
        if (index !== 0 || !(this.bufferedEnd > this.bufferedStart)) throw new DOMException('Index out of bounds');
        return this.bufferedEnd;
      },
    };

    this.reader = input.file
      ? new BlobRangeReader(input.file)
      : new HttpRangeReader(input.url, {
          direct: !!input.direct,
          fileSize: input.fileSize,
          signal: this.abort.signal,
        });

    void this.start().catch(err => this.fail(err));
  }

  get readyState() {
    return this._readyState;
  }

  get duration() {
    return this._duration;
  }

  get paused() {
    return this._paused;
  }

  get ended() {
    return this._ended;
  }

  get seeking() {
    return this._seeking;
  }

  get playbackRate() {
    return this._playbackRate;
  }

  set playbackRate(rate) {
    this.setPlaybackRate(rate);
  }

  get volume() {
    return this._volume;
  }

  set volume(v) {
    this.setAudio(v, this._muted);
  }

  get muted() {
    return this._muted;
  }

  set muted(m) {
    this.setAudio(this._volume, Boolean(m));
  }

  get currentTime() {
    if (this._paused || this._seeking) {
      return this.clampTime(this.anchorMediaTime);
    }
    if (
      this.hasAudioTrack &&
      !this.audioSwitchGen &&
      this.audioContext &&
      this.audioContext.state === 'running' &&
      this.workletClockValid &&
      this.anchorContextTime !== null
    ) {
      const outTime = this.hardwareOutputContextTime();
      const deltaCtx = Math.max(-0.05, outTime - this.anchorContextTime);
      return this.clampTime(this.anchorMediaTime + deltaCtx * this._playbackRate);
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const elapsed = Math.max(0, (now - this.anchorPerfMs) / 1000);
    return this.clampTime(this.anchorMediaTime + elapsed * this._playbackRate);
  }

  set currentTime(seconds) {
    this.seek(seconds);
  }

  clampTime(t) {
    const pos = Math.max(0, Number(t) || 0);
    return Number.isFinite(this._duration) && this._duration > 0 ? Math.min(this._duration, pos) : pos;
  }

  hardwareOutputContextTime() {
    if (!this.audioContext) return 0;
    if (typeof this.audioContext.getOutputTimestamp === 'function') {
      try {
        const ts = this.audioContext.getOutputTimestamp();
        if (ts && Number.isFinite(ts.contextTime) && ts.contextTime > 0 && Number.isFinite(ts.performanceTime)) {
          const nowPerf = typeof performance !== 'undefined' ? performance.now() : ts.performanceTime;
          return ts.contextTime + Math.max(0, (nowPerf - ts.performanceTime) / 1000);
        }
      } catch {}
    }
    return Number(this.audioContext.currentTime) || 0;
  }

  updateBufferedObject() {
    this.buffered.length = this.bufferedEnd > this.bufferedStart ? 1 : 0;
  }

  bufferedAhead(position = this.currentTime) {
    return uburoomPlayback.bufferedAhead(this.buffered, position);
  }

  isBufferedAt(position, toleranceSeconds = 0.05) {
    if (!(this.bufferedEnd > this.bufferedStart)) return false;
    return position >= this.bufferedStart - toleranceSeconds && position < this.bufferedEnd;
  }

  getVideoPlaybackQuality() {
    return {
      totalVideoFrames: this.totalVideoFrames,
      droppedVideoFrames: this.droppedVideoFrames,
    };
  }

  addEventListener(type, listener) {
    if (typeof listener !== 'function') return;
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type, detail) {
    const set = this.listeners.get(type);
    if (set) {
      for (const fn of [...set]) {
        try {
          fn({ type, detail, target: this });
        } catch {}
      }
    }
    this.options.onStateChange?.(type, this);
  }

  requestVideoFrameCallback(callback) {
    if (typeof callback !== 'function') return 0;
    const id = this.nextFrameCbId++;
    this.frameCallbacks.set(id, callback);
    return id;
  }

  cancelVideoFrameCallback(id) {
    this.frameCallbacks.delete(id);
  }

  hold() {
    this.held = true;
  }

  async initAudioEngine() {
    const AudioCtx = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!this.audioContext && typeof AudioCtx === 'function') {
      this.audioContext = new AudioCtx({ sampleRate: SAMPLE_RATE, latencyHint: 'playback' });
      this.ownsAudioContext = true;
    }
    if (!this.audioContext || typeof AudioWorkletNode !== 'function' || !this.audioContext.audioWorklet) {
      return null;
    }
    await ensureWorkletModule(this.audioContext);
    if (this.destroyed) return null;
    const node = new AudioWorkletNode(this.audioContext, 'ubuplayer-worklet', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { sampleRate: this.audioContext.sampleRate || SAMPLE_RATE },
    });
    const dest = this.audioDestination || this.audioContext.destination;
    node.connect(dest);
    node.port.onmessage = ev => this.handleWorkletMessage(ev.data);
    node.port.postMessage({ type: 'volume', volume: this._volume, muted: this._muted });
    node.port.postMessage({ type: 'rate', rate: this._playbackRate });
    this.workletNode = node;
    const channel = new MessageChannel();
    node.port.postMessage({ type: 'attachWorkerPort' }, [channel.port1]);
    return channel.port2;
  }

  async start() {
    const { fileSize, initialBytes } = await this.reader.probe();
    if (this.destroyed || this.abort.signal.aborted) return;

    const workerAudioPort = await this.initAudioEngine();
    if (this.destroyed || this.abort.signal.aborted) return;

    let offscreen = null;
    if (this.canvasElement && typeof this.canvasElement.transferControlToOffscreen === 'function') {
      offscreen = this.canvasElement.transferControlToOffscreen();
    }

    this.worker = new Worker('/ubuplayer-worker.js', { type: 'module' });
    this.worker.onerror = ev => this.fail(ev.error || new Error(ev.message || 'UbuPlayer worker crashed.'));
    this.worker.onmessage = event => this.handleWorkerMessage(event.data);

    const startPos = Math.max(0, Number(this.target?.()) || 0);
    this.anchorMediaTime = startPos;
    this.bufferedStart = startPos;
    this.bufferedEnd = startPos;

    const transfers = [initialBytes.buffer];
    if (offscreen) transfers.push(offscreen);
    if (workerAudioPort) transfers.push(workerAudioPort);

    this.worker.postMessage(
      {
        type: 'init',
        fileSize,
        duration: Number.isFinite(this._duration) ? this._duration : 0,
        audioMode: this.audioMode,
        targetHdr: this.targetHdr,
        audioId: this.selectedAudioId,
        serverAudioIds: this.options.serverAudioIds,
        startTime: startPos,
        aheadSeconds: uburoomPlayback.BUFFER.ahead,
        initialBytes: initialBytes.buffer,
        canvas: offscreen,
        sampleRate: this.audioContext?.sampleRate || SAMPLE_RATE,
        audioPort: workerAudioPort,
      },
      transfers,
    );
  }

  finishSeekIfReady() {
    if (!this._seeking || !this.seekFrameReady) return;
    const audioReady =
      !this.hasAudioTrack ||
      this.audioEof ||
      this.workletBufferedSeconds >= 0.15 ||
      (this.audioContext?.state !== 'running' && this.bufferedAhead(this.currentTime) >= 0.15);
    if (!audioReady) return;
    this._seeking = false;
    this.seekFrameReady = false;
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.anchorPerfMs = now;
    if (this.audioContext) this.anchorContextTime = this.hardwareOutputContextTime();
    if (!this._paused) {
      this.workletNode?.port.postMessage({ type: 'play' });
    }
    this.sendClockSync();
    if (this._readyState < 4 && (this.bufferedAhead(this.currentTime) >= 0.25 || this.videoEof)) {
      this._readyState = 4;
      this.emit('canplay');
    }
    this.emit('seeked');
    if (!this._paused) this.emit('playing');
  }

  handleWorkletMessage(msg) {
    if (!msg || this.destroyed) return;
    if (msg.type === 'clock') {
      if (msg.seekGen !== this.seekGen) return;
      this.workletBufferedSeconds = Number(msg.bufferedSeconds) || 0;
      if (this.audioSwitchGen) {
        if (msg.audioGen >= this.audioSwitchGen && (this.workletBufferedSeconds >= 0.1 || msg.eofDrained)) {
          this.audioSwitchGen = 0;
          this.lastUnderruns = msg.underruns;
        } else {
          return;
        }
      }
      if (this._seeking) {
        this.finishSeekIfReady();
        return;
      }
      const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE;
      const mediaSec = (Number(msg.mediaSample) || 0) / sampleRate;
      if (msg.playing || !this.workletClockValid) {
        this.anchorMediaTime = mediaSec;
        this.anchorContextTime = Number.isFinite(msg.contextTime) ? msg.contextTime : this.hardwareOutputContextTime();
        this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        this.workletClockValid = true;
      }
      if (!this._paused) {
        if (!msg.eofDrained && msg.underruns > this.lastUnderruns && this.workletBufferedSeconds < 0.05) {
          this.lastUnderruns = msg.underruns;
          if (!this.underrunWaiting) {
            this.underrunWaiting = true;
            if (this._readyState > 2) this._readyState = 2;
            this.emit('waiting');
          }
        } else if (this.underrunWaiting && (this.workletBufferedSeconds >= 0.25 || msg.eofDrained)) {
          this.underrunWaiting = false;
          this._readyState = 4;
          this.emit('canplay');
          this.emit('playing');
        }
        this.emit('timeupdate');
      }
      if (msg.eofDrained && this.videoEof && !this._ended) {
        this._ended = true;
        this._paused = true;
        this.stopClockSyncLoop();
        this.sendClockSync();
        this.emit('pause');
        this.emit('ended');
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
      if (msg.seekGen !== undefined && msg.seekGen !== this.seekGen) return;
      const error = Object.assign(new Error(msg.message || 'UbuPlayer playback failed.'), {
        ...(msg.kind ? { kind: msg.kind } : {}),
      });
      this.fail(error);
      return;
    }
    if (msg.type === 'ready') {
      if (msg.duration > 0) this._duration = msg.duration;
      this.videoWidth = msg.video?.width || 0;
      this.videoHeight = msg.video?.height || 0;
      this.hasAudioTrack = Boolean(msg.selectedAudioId && msg.audioTracks?.length > 0);
      this.selectedAudioId = msg.selectedAudioId;
      this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
      this.metadata = {
        duration: msg.duration,
        rendererBackend: msg.rendererBackend,
        hdrOutputActive: msg.hdrOutputActive,
        video: msg.video,
        audioTracks: msg.audioTracks,
        subtitleTracks: msg.subtitleTracks,
        chapters: msg.chapters,
      };
      if (this._readyState < 1) {
        this._readyState = 1;
        this.emit('loadedmetadata');
      }
      this.options.onResize?.(this.videoWidth, this.videoHeight);
      this.emit('resize');
      this.options.onMetadata?.(this.metadata);
      this.options.onAudioStateChange?.();
      if (this.selectedSubtitleId) this.selectSubtitle(this.selectedSubtitleId);
      return;
    }
    if (msg.type === 'progress') {
      if (msg.seekGen !== this.seekGen) return;
      this.bufferedStart = msg.bufferedStart;
      this.bufferedEnd = msg.bufferedEnd;
      this.videoEof = Boolean(msg.videoEof);
      this.audioEof = Boolean(msg.audioEof);
      this.updateBufferedObject();
      if (this._seeking) this.finishSeekIfReady();
      const ahead = this.bufferedAhead(this.currentTime);
      if (this._readyState >= 2 && (ahead >= 0.5 || this.videoEof)) {
        if (this._readyState < 4) {
          this._readyState = 4;
          this.emit('canplay');
          if (!this._paused && !this._seeking) this.emit('playing');
        }
      }
      if (!this.hasAudioTrack && this.videoEof && !this._paused && this.currentTime >= (this._duration || 0) - 0.05) {
        this._ended = true;
        this._paused = true;
        this.stopClockSyncLoop();
        this.sendClockSync();
        this.emit('pause');
        this.emit('ended');
      }
      return;
    }
    if (msg.type === 'framePresented') {
      if (msg.seekGen !== this.seekGen) return;
      this.totalVideoFrames = msg.totalVideoFrames;
      this.droppedVideoFrames = msg.droppedVideoFrames;
      if (msg.width > 0 && msg.height > 0 && (msg.width !== this.videoWidth || msg.height !== this.videoHeight)) {
        this.videoWidth = msg.width;
        this.videoHeight = msg.height;
        this.options.onResize?.(this.videoWidth, this.videoHeight);
        this.emit('resize');
      }
      if (Number.isFinite(msg.bufferedEnd)) {
        this.bufferedStart = msg.bufferedStart;
        this.bufferedEnd = msg.bufferedEnd;
        this.updateBufferedObject();
      }
      if (this._readyState < 3) {
        this._readyState = this.bufferedAhead(this.currentTime) >= 0.25 || this.videoEof ? 4 : 2;
        this.emit('loadeddata');
        this.emit('canplay');
      }
      if (this._seeking) {
        this.seekFrameReady = true;
        this.finishSeekIfReady();
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (this.frameCallbacks.size > 0) {
        const callbacks = [...this.frameCallbacks.values()];
        this.frameCallbacks.clear();
        const meta = {
          presentationTime: now,
          expectedDisplayTime: now,
          width: this.videoWidth,
          height: this.videoHeight,
          mediaTime: msg.mediaTime,
          presentedFrames: this.totalVideoFrames,
        };
        for (const cb of callbacks) {
          try {
            cb(now, meta);
          } catch {}
        }
      }
      this.options.onFrame?.(msg.mediaTime, now);
      return;
    }
    if (msg.type === 'seeked') {
      if (msg.seekGen !== this.seekGen) return;
      this.sendClockSync();
      return;
    }
    if (msg.type === 'audioSwitched') {
      if (msg.audioGen !== this.audioGen) return;
      this.selectedAudioId = msg.selectedAudioId;
      this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
      this.options.onAudioStateChange?.();
      return;
    }
    if (msg.type === 'audioModeApplied') {
      this.surroundDialogueActive = Boolean(msg.surroundDialogueActive);
      this.options.onAudioStateChange?.();
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

  sendClockSync() {
    if (!this.worker || this.destroyed) return;
    this.worker.postMessage({
      type: 'clockSync',
      mediaTime: this.currentTime,
      paused: this._paused,
      playbackRate: this._playbackRate,
    });
  }

  startClockSyncLoop() {
    if (this.clockSyncTimer) return;
    this.clockSyncTimer = setInterval(() => {
      if (this.destroyed || this._paused) return;
      this.sendClockSync();
      const usingWallClock = !this.hasAudioTrack || !this.audioContext || this.audioContext.state !== 'running';
      if (usingWallClock) {
        this.emit('timeupdate');
        if (
          this.videoEof &&
          !this._ended &&
          Number.isFinite(this._duration) &&
          this._duration > 0 &&
          this.currentTime >= this._duration - 0.05
        ) {
          this._ended = true;
          this._paused = true;
          this.stopClockSyncLoop();
          this.sendClockSync();
          this.emit('pause');
          this.emit('ended');
        }
      }
    }, 50);
  }

  stopClockSyncLoop() {
    if (!this.clockSyncTimer) return;
    clearInterval(this.clockSyncTimer);
    this.clockSyncTimer = null;
  }

  makeAutoplayError() {
    if (typeof DOMException === 'function') {
      return new DOMException('Playback requires user interaction.', 'NotAllowedError');
    }
    const err = new Error('Playback requires user interaction.');
    err.name = 'NotAllowedError';
    return err;
  }

  resyncAudioToPlayhead() {
    if (this.destroyed || !this.worker || !this.hasAudioTrack || !this.selectedAudioId) return;
    const aGen = ++this.audioGen;
    const pos = this.currentTime;
    const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE;
    this.anchorMediaTime = pos;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletClockValid = false;
    this.workletNode?.port.postMessage({
      type: 'reset',
      seekGen: this.seekGen,
      audioGen: aGen,
      startSample: Math.round(pos * sampleRate),
    });
    if (!this._paused) {
      this.workletNode?.port.postMessage({ type: 'play' });
    }
    this.worker.postMessage({
      type: 'selectAudio',
      audioGen: aGen,
      audioId: this.selectedAudioId,
      time: pos,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
  }

  async play() {
    if (this.destroyed) return;
    if (this.audioContext && this.audioContext.state === 'suspended') {
      if (this.hasAudioTrack && !this._muted) {
        const activation = globalThis.navigator?.userActivation;
        if (activation && activation.hasBeenActive === false) {
          throw this.makeAutoplayError();
        }
        let timer;
        try {
          await Promise.race([
            this.audioContext.resume(),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(this.makeAutoplayError()), 450);
            }),
          ]);
        } catch {
          throw this.makeAutoplayError();
        } finally {
          clearTimeout(timer);
        }
        if (this.audioContext.state !== 'running') {
          throw this.makeAutoplayError();
        }
      } else {
        void Promise.resolve(this.audioContext.resume()).catch(() => {});
      }
    }
    if (this._ended) {
      this._ended = false;
      this.seek(0);
    }
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.anchorPerfMs = now;
    if (this.audioContext) {
      this.anchorContextTime = this.hardwareOutputContextTime();
    }
    this._paused = false;
    if (!this._seeking) {
      this.workletNode?.port.postMessage({ type: 'play' });
    }
    this.sendClockSync();
    this.startClockSyncLoop();
    this.emit('play');
    if (this._readyState >= 3 && !this._seeking) {
      this.emit('playing');
    }
  }

  pause() {
    if (this.destroyed || this._paused) return;
    const frozenTime = this.currentTime;
    this._paused = true;
    this.anchorMediaTime = frozenTime;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletNode?.port.postMessage({ type: 'pause' });
    this.stopClockSyncLoop();
    this.sendClockSync();
    this.emit('pause');
  }

  seek(seconds) {
    if (this.destroyed || this.held || !Number.isFinite(seconds)) return;
    const clamped = this.clampTime(seconds);
    if (!this._seeking && Math.abs(clamped - this.currentTime) < 0.02 && this._readyState >= 2) return;
    this._ended = false;
    this._seeking = true;
    this.seekFrameReady = false;
    this.workletBufferedSeconds = 0;
    this.underrunWaiting = false;
    this.anchorMediaTime = clamped;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletClockValid = false;
    if (this._readyState > 1) this._readyState = 1;
    const gen = ++this.seekGen;
    const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE;
    this.workletNode?.port.postMessage({ type: 'pause' });
    this.workletNode?.port.postMessage({
      type: 'reset',
      seekGen: gen,
      audioGen: this.audioGen,
      startSample: Math.round(clamped * sampleRate),
    });
    this.worker?.postMessage({
      type: 'seek',
      seekGen: gen,
      time: clamped,
      aheadSeconds: uburoomPlayback.BUFFER.ahead,
    });
    this.emit('seeking');
  }

  setPlaybackRate(rate) {
    if (this.destroyed || !Number.isFinite(rate) || rate <= 0) return;
    const clamped = Math.max(0.5, Math.min(2.0, rate));
    if (Math.abs(clamped - this._playbackRate) < 1e-5) return;
    const pos = this.currentTime;
    this.anchorMediaTime = pos;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.audioContext) this.anchorContextTime = this.hardwareOutputContextTime();
    this._playbackRate = clamped;
    this.workletNode?.port.postMessage({ type: 'rate', rate: clamped });
    this.sendClockSync();
    this.emit('ratechange');
  }

  setAudio(volumeUnit, muted) {
    if (this.destroyed) return;
    const wasMuted = this._muted;
    if (Number.isFinite(volumeUnit)) this._volume = Math.max(0, Math.min(1, volumeUnit));
    if (typeof muted === 'boolean') this._muted = muted;
    this.workletNode?.port.postMessage({ type: 'volume', volume: this._volume, muted: this._muted });
    if (wasMuted && !this._muted && !this._paused && this.hasAudioTrack && this.audioContext?.state === 'suspended') {
      const needResync = !this.workletClockValid;
      void Promise.resolve(this.audioContext.resume())
        .then(() => {
          if (!this.destroyed && !this._paused && this.audioContext?.state === 'running' && needResync) {
            this.resyncAudioToPlayhead();
          }
        })
        .catch(() => {});
    }
    this.emit('volumechange');
  }

  selectAudio(audioId) {
    if (this.destroyed || !this.worker || audioId === this.selectedAudioId) return;
    this.selectedAudioId = audioId;
    const aGen = ++this.audioGen;
    this.audioSwitchGen = aGen;
    const pos = this.currentTime;
    const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE;
    this.anchorMediaTime = pos;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletClockValid = false;
    this.workletBufferedSeconds = 0;
    this.underrunWaiting = false;
    this.workletNode?.port.postMessage({
      type: 'reset',
      seekGen: this.seekGen,
      audioGen: aGen,
      startSample: Math.round(pos * sampleRate),
    });
    this.worker.postMessage({
      type: 'selectAudio',
      audioGen: aGen,
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
    const aGen = ++this.audioGen;
    this.audioSwitchGen = aGen;
    const pos = this.currentTime;
    const sampleRate = this.audioContext?.sampleRate || SAMPLE_RATE;
    this.anchorMediaTime = pos;
    this.anchorPerfMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
    this.workletClockValid = false;
    this.workletBufferedSeconds = 0;
    this.underrunWaiting = false;
    this.workletNode?.port.postMessage({
      type: 'reset',
      seekGen: this.seekGen,
      audioGen: aGen,
      startSample: Math.round(pos * sampleRate),
    });
    this.worker.postMessage({
      type: 'setAudioMode',
      mode: nextMode,
      audioGen: aGen,
      time: pos,
    });
  }

  setHdrTarget(wantHdr) {
    const next = Boolean(wantHdr);
    if (this.destroyed || next === this.targetHdr) return;
    this.targetHdr = next;
    this.worker?.postMessage({ type: 'setHdrTarget', targetHdr: next });
  }

  selectSubtitle(subtitleId) {
    if (this.destroyed || !this.worker) return;
    this.selectedSubtitleId = subtitleId || null;
    const gen = ++this.subGen;
    const pos = this.currentTime;
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
    const message = error?.message || 'UbuPlayer playback failed.';
    this.destroy();
    this.failed?.(message, error);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopClockSyncLoop();
    this.abort.abort();
    this.reader?.abort();
    this.frameCallbacks.clear();
    this.listeners.clear();
    if (this.workletNode) {
      try {
        this.workletNode.port.postMessage({ type: 'pause' });
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {}
      this.workletNode = null;
    }
    if (this.ownsAudioContext && this.audioContext) {
      try {
        void this.audioContext.close();
      } catch {}
      this.audioContext = null;
    }
    if (this.worker) {
      try {
        this.worker.postMessage({ type: 'close' });
      } catch {}
      const w = this.worker;
      this.worker = undefined;
      setTimeout(() => w.terminate(), 50);
    }
  }
}
