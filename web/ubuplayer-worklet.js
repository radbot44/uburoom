// @ts-check
/* AudioWorklet PCM ring buffer and stereo phase-locked WSOLA pitch-preserving rate stretcher
 * for UbuPlayer. Serves as the single hardware audio output master clock for video & subtitles.
 */

const DEFAULT_SAMPLE_RATE = 48000;
const RING_CAPACITY_SECONDS = 24;

function buildHannWindow(length) {
  const win = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / length));
  }
  return win;
}

/**
 * Pure stereo PCM ring buffer + phase-locked WSOLA time-stretcher core.
 * Exported so Node unit tests can deterministically verify rate stretching,
 * bit-exact 1.0x passthrough, underrun accounting, and playhead sample tracking.
 */
export class UbuPlayerAudioCore {
  /**
   * @param {{sampleRate?: number, capacityFrames?: number}} [options]
   */
  constructor({ sampleRate = DEFAULT_SAMPLE_RATE, capacityFrames } = {}) {
    this.sampleRate = sampleRate > 0 ? sampleRate : DEFAULT_SAMPLE_RATE;
    this.capacity = capacityFrames || this.sampleRate * RING_CAPACITY_SECONDS;
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
    this.writeIndex = 0;
    this.readPos = 0; // Fractional frame offset from buffer start (monotonic)
    this.writtenTotal = 0; // Monotonic frames written since last reset
    this.baseMediaSample = 0; // Media timeline sample corresponding to writtenTotal === 0
    this.hasBaseSample = false;
    this.playing = false;
    this.playbackRate = 1.0;
    this.volume = 1.0;
    this.muted = false;
    this.eof = false;
    this.eofNotified = false;
    this.underruns = 0;
    this.seekGen = 0;
    this.audioGen = 0;

    // Scale WSOLA grain geometry to exact 20ms window / 10ms hop / 5ms search at any hardware sampleRate
    this.wsolaHop = Math.max(64, Math.round(this.sampleRate * 0.01));
    this.wsolaWindow = this.wsolaHop * 2;
    this.wsolaSearch = Math.max(32, Math.round(this.sampleRate * 0.005));
    this.hannWindow = buildHannWindow(this.wsolaWindow);

    // Stereo WSOLA synthesis FIFO & natural continuation template
    this.outFifoL = new Float32Array(this.wsolaWindow * 4);
    this.outFifoR = new Float32Array(this.wsolaWindow * 4);
    this.outFifoRead = 0;
    this.outFifoWrite = 0;
    this.olaTailL = new Float32Array(this.wsolaHop);
    this.olaTailR = new Float32Array(this.wsolaHop);
    this.prevContMono = new Float32Array(this.wsolaHop);
    this.wsolaPrimed = false;
  }

  reset(mediaSample = 0, { seekGen = this.seekGen, audioGen = this.audioGen } = {}) {
    this.writeIndex = 0;
    this.readPos = 0;
    this.writtenTotal = 0;
    this.baseMediaSample = Math.max(0, Math.round(mediaSample));
    this.hasBaseSample = Number.isFinite(mediaSample) && mediaSample >= 0;
    this.eof = false;
    this.eofNotified = false;
    this.seekGen = seekGen;
    this.audioGen = audioGen;
    this.resetWsola();
  }

  resetWsola() {
    this.outFifoRead = 0;
    this.outFifoWrite = 0;
    this.olaTailL.fill(0);
    this.olaTailR.fill(0);
    this.prevContMono.fill(0);
    this.wsolaPrimed = false;
  }

  get availableFrames() {
    return Math.max(0, this.writtenTotal - Math.floor(this.readPos));
  }

  get freeFrames() {
    return Math.max(0, this.capacity - this.availableFrames - this.wsolaSearch * 2);
  }

  get fifoFrames() {
    return Math.max(0, this.outFifoWrite - this.outFifoRead);
  }

  /** Exact media sample currently at the output head. */
  get currentMediaSample() {
    const inFifoMediaSamples = this.fifoFrames * this.playbackRate;
    return Math.max(0, this.baseMediaSample + this.readPos - inFifoMediaSamples);
  }

  get bufferedSeconds() {
    return (this.availableFrames + this.fifoFrames * this.playbackRate) / this.sampleRate;
  }

  setRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) return;
    const clamped = Math.max(0.5, Math.min(2.0, rate));
    const wasUnit = Math.abs(this.playbackRate - 1.0) < 0.0002;
    const isUnit = Math.abs(clamped - 1.0) < 0.0002;
    this.playbackRate = clamped;
    if (wasUnit !== isUnit && isUnit) {
      // Fold any unconsumed WSOLA FIFO frames back into readPos seamlessly
      this.readPos = Math.max(0, Math.min(this.writtenTotal, this.readPos - this.fifoFrames));
      this.resetWsola();
    }
  }

  /**
   * Append stereo Float32 PCM frames to the ring buffer.
   * @param {Float32Array} leftChunk
   * @param {Float32Array} [rightChunk]
   * @param {number} [startSample]
   */
  push(leftChunk, rightChunk, startSample) {
    if (!leftChunk?.length) return 0;
    const rightSrc = rightChunk?.length === leftChunk.length ? rightChunk : leftChunk;
    if (!this.hasBaseSample && Number.isFinite(startSample)) {
      this.baseMediaSample = Math.max(0, Math.round(startSample));
      this.hasBaseSample = true;
    } else if (this.writtenTotal === 0 && Number.isFinite(startSample)) {
      this.baseMediaSample = Math.max(0, Math.round(startSample));
      this.hasBaseSample = true;
    }
    const count = Math.min(leftChunk.length, this.capacity - this.availableFrames);
    if (count <= 0) return 0;
    const firstPart = Math.min(count, this.capacity - this.writeIndex);
    this.left.set(leftChunk.subarray(0, firstPart), this.writeIndex);
    this.right.set(rightSrc.subarray(0, firstPart), this.writeIndex);
    if (count > firstPart) {
      const rem = count - firstPart;
      this.left.set(leftChunk.subarray(firstPart, firstPart + rem), 0);
      this.right.set(rightSrc.subarray(firstPart, firstPart + rem), 0);
    }
    this.writeIndex = (this.writeIndex + count) % this.capacity;
    this.writtenTotal += count;
    this.eof = false;
    this.eofNotified = false;
    return count;
  }

  sampleRingL(absIndex) {
    if (absIndex < 0 || absIndex >= this.writtenTotal) return 0;
    return this.left[absIndex % this.capacity];
  }

  sampleRingR(absIndex) {
    if (absIndex < 0 || absIndex >= this.writtenTotal) return 0;
    return this.right[absIndex % this.capacity];
  }

  compactFifo() {
    if (this.outFifoRead === 0) return;
    const remaining = this.outFifoWrite - this.outFifoRead;
    if (remaining > 0) {
      this.outFifoL.copyWithin(0, this.outFifoRead, this.outFifoWrite);
      this.outFifoR.copyWithin(0, this.outFifoRead, this.outFifoWrite);
    }
    this.outFifoRead = 0;
    this.outFifoWrite = Math.max(0, remaining);
  }

  synthesizeWsolaGrain() {
    const minNeeded = this.wsolaWindow + this.wsolaSearch + 2;
    if (this.writtenTotal - Math.floor(this.readPos) < minNeeded && !this.eof) return false;
    const avail = this.writtenTotal - Math.floor(this.readPos);
    if (avail <= 0) return false;

    const center = Math.round(this.readPos);
    let bestOffset = 0;
    if (this.wsolaPrimed && avail >= this.wsolaWindow + this.wsolaSearch) {
      const minDelta = Math.max(-this.wsolaSearch, Math.floor(this.readPos) - center);
      const maxDelta = Math.min(this.wsolaSearch, this.writtenTotal - this.wsolaWindow - center);
      let bestScore = -Infinity;
      // Step by 2 samples for fast coarse match, then refine +/-1 around winner
      for (let delta = minDelta; delta <= maxDelta; delta += 2) {
        const candStart = center + delta;
        if (candStart < 0 || candStart + this.wsolaHop >= this.writtenTotal) continue;
        let dot = 0;
        let normCand = 1e-7;
        for (let k = 0; k < this.wsolaHop; k += 2) {
          const idx = (candStart + k) % this.capacity;
          const mono = 0.5 * (this.left[idx] + this.right[idx]);
          const ref = this.prevContMono[k];
          dot += mono * ref;
          normCand += mono * mono;
        }
        const score = dot / Math.sqrt(normCand);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = delta;
        }
      }
      for (const refine of [bestOffset - 1, bestOffset + 1]) {
        if (refine < minDelta || refine > maxDelta) continue;
        const candStart = center + refine;
        if (candStart < 0 || candStart + this.wsolaHop >= this.writtenTotal) continue;
        let dot = 0;
        let normCand = 1e-7;
        for (let k = 0; k < this.wsolaHop; k += 2) {
          const idx = (candStart + k) % this.capacity;
          const mono = 0.5 * (this.left[idx] + this.right[idx]);
          dot += mono * this.prevContMono[k];
          normCand += mono * mono;
        }
        const score = dot / Math.sqrt(normCand);
        if (score > bestScore) {
          bestScore = score;
          bestOffset = refine;
        }
      }
    }

    const grainStart = Math.max(0, Math.min(Math.max(0, this.writtenTotal - 1), center + bestOffset));
    if (this.outFifoWrite + this.wsolaHop > this.outFifoL.length) {
      this.compactFifo();
    }

    // Overlap-add first half (0..this.wsolaHop-1) with previous tail, emit to FIFO
    for (let i = 0; i < this.wsolaHop; i++) {
      const w = this.hannWindow[i];
      const sL = this.sampleRingL(grainStart + i) * w;
      const sR = this.sampleRingR(grainStart + i) * w;
      const outIdx = this.outFifoWrite + i;
      this.outFifoL[outIdx] = (this.wsolaPrimed ? this.olaTailL[i] : this.sampleRingL(grainStart + i) * (1 - w)) + sL;
      this.outFifoR[outIdx] = (this.wsolaPrimed ? this.olaTailR[i] : this.sampleRingR(grainStart + i) * (1 - w)) + sR;
    }
    this.outFifoWrite += this.wsolaHop;

    // Store second half (this.wsolaHop..this.wsolaWindow-1) as next overlap tail
    for (let i = 0; i < this.wsolaHop; i++) {
      const w = this.hannWindow[this.wsolaHop + i];
      this.olaTailL[i] = this.sampleRingL(grainStart + this.wsolaHop + i) * w;
      this.olaTailR[i] = this.sampleRingR(grainStart + this.wsolaHop + i) * w;
      // Natural continuation template begins at grainStart + this.wsolaHop
      const contL = this.sampleRingL(grainStart + this.wsolaHop + i);
      const contR = this.sampleRingR(grainStart + this.wsolaHop + i);
      this.prevContMono[i] = 0.5 * (contL + contR);
    }

    this.wsolaPrimed = true;
    this.readPos = Math.min(this.writtenTotal, this.readPos + this.wsolaHop * this.playbackRate);
    return true;
  }

  /**
   * Render `outL.length` stereo frames into `outL` and `outR`.
   * @param {Float32Array} outL
   * @param {Float32Array} outR
   * @returns {{rendered: number, underrun: boolean, ended: boolean}}
   */
  render(outL, outR) {
    const frames = outL.length;
    outL.fill(0);
    outR.fill(0);
    if (!this.playing) return { rendered: 0, underrun: false, ended: false };

    const gain = this.muted ? 0 : this.volume;
    const isUnitRate = Math.abs(this.playbackRate - 1.0) < 0.0002;

    if (isUnitRate) {
      const startInt = Math.floor(this.readPos);
      const avail = Math.max(0, this.writtenTotal - startInt);
      const take = Math.min(frames, avail);
      for (let i = 0; i < take; i++) {
        const ringIdx = (startInt + i) % this.capacity;
        outL[i] = this.left[ringIdx] * gain;
        outR[i] = this.right[ringIdx] * gain;
      }
      this.readPos = startInt + take;
      const underrun = take < frames && !this.eof;
      if (underrun) this.underruns++;
      const ended = this.eof && this.readPos >= this.writtenTotal && take < frames;
      return { rendered: take, underrun, ended };
    }

    while (this.fifoFrames < frames) {
      if (!this.synthesizeWsolaGrain()) break;
    }
    const take = Math.min(frames, this.fifoFrames);
    for (let i = 0; i < take; i++) {
      outL[i] = this.outFifoL[this.outFifoRead + i] * gain;
      outR[i] = this.outFifoR[this.outFifoRead + i] * gain;
    }
    this.outFifoRead += take;
    if (this.outFifoRead === this.outFifoWrite) {
      this.outFifoRead = 0;
      this.outFifoWrite = 0;
    }
    const underrun = take < frames && !this.eof;
    if (underrun) this.underruns++;
    const ended = this.eof && take < frames && this.availableFrames === 0 && this.fifoFrames === 0;
    return { rendered: take, underrun, ended };
  }
}

if (typeof globalThis.AudioWorkletProcessor === 'function' && typeof globalThis.registerProcessor === 'function') {
  class UbuPlayerProcessor extends globalThis.AudioWorkletProcessor {
    constructor(options) {
      super();
      const rate = options?.processorOptions?.sampleRate || globalThis.sampleRate || DEFAULT_SAMPLE_RATE;
      this.core = new UbuPlayerAudioCore({ sampleRate: rate });
      this.workerPort = null;
      this.quantaCount = 0;
      this.port.onmessage = event => this.handleMessage(event.data, event.ports);
    }

    handleMessage(msg, ports) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'attachWorkerPort' && ports?.[0]) {
        if (this.workerPort) {
          try {
            this.workerPort.onmessage = null;
          } catch {}
        }
        this.workerPort = ports[0];
        this.workerPort.onmessage = ev => this.handleWorkerMessage(ev.data);
        return;
      }
      if (msg.type === 'play') {
        this.core.playing = true;
        this.emitClock(true);
        return;
      }
      if (msg.type === 'pause') {
        this.core.playing = false;
        this.emitClock(true);
        return;
      }
      if (msg.type === 'rate') {
        this.core.setRate(msg.rate);
        this.emitClock(true);
        return;
      }
      if (msg.type === 'volume') {
        if (Number.isFinite(msg.volume)) this.core.volume = Math.max(0, Math.min(1, msg.volume));
        if (typeof msg.muted === 'boolean') this.core.muted = msg.muted;
        return;
      }
      if (msg.type === 'reset') {
        this.core.reset(msg.startSample ?? 0, { seekGen: msg.seekGen, audioGen: msg.audioGen });
        this.emitClock(true);
        return;
      }
      if (msg.type === 'pcm') {
        this.handleWorkerMessage(msg);
      }
    }

    handleWorkerMessage(msg) {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'reset') {
        this.core.reset(msg.startSample ?? 0, { seekGen: msg.seekGen, audioGen: msg.audioGen });
        this.emitClock(true);
        return;
      }
      if (msg.type === 'pcm') {
        if (Number.isInteger(msg.seekGen) && msg.seekGen < this.core.seekGen) return;
        if (Number.isInteger(msg.audioGen) && msg.audioGen < this.core.audioGen) return;
        if (Number.isInteger(msg.seekGen)) this.core.seekGen = msg.seekGen;
        if (Number.isInteger(msg.audioGen)) this.core.audioGen = msg.audioGen;
        const left = msg.left instanceof Float32Array ? msg.left : new Float32Array(msg.left || 0);
        const right = msg.right instanceof Float32Array ? msg.right : left;
        this.core.push(left, right, msg.startSample);
        if (msg.eof) this.core.eof = true;
        this.emitWorkerCapacity();
        return;
      }
      if (msg.type === 'eof') {
        if (!Number.isInteger(msg.seekGen) || msg.seekGen === this.core.seekGen) {
          this.core.eof = true;
        }
      }
    }

    emitWorkerCapacity() {
      if (!this.workerPort) return;
      this.workerPort.postMessage({
        type: 'audioState',
        freeFrames: this.core.freeFrames,
        bufferedSeconds: this.core.bufferedSeconds,
        mediaSample: this.core.currentMediaSample,
        seekGen: this.core.seekGen,
        audioGen: this.core.audioGen,
      });
    }

    emitClock(force = false) {
      if (!force && this.quantaCount % 12 !== 0) return;
      this.port.postMessage({
        type: 'clock',
        contextTime: globalThis.currentTime,
        contextFrame: globalThis.currentFrame,
        mediaSample: this.core.currentMediaSample,
        bufferedSeconds: this.core.bufferedSeconds,
        underruns: this.core.underruns,
        playing: this.core.playing,
        playbackRate: this.core.playbackRate,
        eofDrained: this.core.eof && this.core.availableFrames === 0 && this.core.fifoFrames === 0,
        seekGen: this.core.seekGen,
      });
      this.emitWorkerCapacity();
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      if (!out || out.length === 0) return true;
      const outL = out[0];
      if (out.length === 1 && (!this.monoScratch || this.monoScratch.length !== outL.length)) {
        this.monoScratch = new Float32Array(outL.length);
      }
      const outR = out.length > 1 ? out[1] : this.monoScratch;
      const { ended } = this.core.render(outL, outR);
      if (out.length === 1) {
        // Mono output hardware fallback (average separate L and R channels)
        for (let i = 0; i < outL.length; i++) outL[i] = 0.5 * (outL[i] + outR[i]);
      }
      this.quantaCount++;
      this.emitClock(ended && !this.core.eofNotified);
      if (ended && !this.core.eofNotified) {
        this.core.eofNotified = true;
        this.core.playing = false;
      }
      return true;
    }
  }

  globalThis.registerProcessor('ubuplayer-worklet', UbuPlayerProcessor);
}
