'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { mountModule, element } = require('../helpers/watch-module.js');

let hasFfmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  hasFfmpeg = true;
} catch {}

class BitBuilder {
  constructor() {
    this.bits = [];
  }
  u(val, n) {
    const unsigned = val >>> 0;
    for (let i = n - 1; i >= 0; i--) this.bits.push((unsigned >>> i) & 1);
  }
  ue(val) {
    const v = val + 1;
    const len = 31 - Math.clz32(v);
    for (let i = 0; i < len; i++) this.bits.push(0);
    this.u(v, len + 1);
  }
  se(val) {
    const codeNum = val <= 0 ? -2 * val : 2 * val - 1;
    this.ue(codeNum);
  }
  toBytesWithEpb() {
    this.bits.push(1);
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const rbsp = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < rbsp.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i * 8 + j];
      rbsp[i] = b;
    }
    const out = [rbsp[0], rbsp[1]];
    let zeros = 0;
    for (let i = 2; i < rbsp.length; i++) {
      const byte = rbsp[i];
      if (zeros === 2 && byte <= 3) {
        out.push(0x03);
        zeros = 0;
      }
      out.push(byte);
      zeros = byte === 0 ? zeros + 1 : 0;
    }
    return new Uint8Array(out);
  }
}

function mockWebCodecs() {
  return {
    VideoDecoder: class {
      static async isConfigSupported(config) {
        return { supported: true, config };
      }
      constructor(init) {
        this._output = init.output;
        this.state = 'unconfigured';
        this.decodeQueueSize = 0;
      }
      configure(cfg) {
        this._cfg = cfg;
        this.state = 'configured';
      }
      decode(chunk) {
        const frame = {
          timestamp: chunk.timestamp,
          duration: chunk.duration,
          displayWidth: this._cfg?.codedWidth || 640,
          displayHeight: this._cfg?.codedHeight || 360,
          codedWidth: this._cfg?.codedWidth || 640,
          codedHeight: this._cfg?.codedHeight || 360,
          format: 'I420',
          colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
          close() {},
        };
        queueMicrotask(() => {
          if (this.state === 'configured') this._output(frame);
        });
      }
      async flush() {}
      reset() {}
      close() {
        this.state = 'closed';
      }
    },
    EncodedVideoChunk: class {
      constructor(init) {
        Object.assign(this, init);
        this.byteLength = init.data.byteLength;
      }
    },
    createOffscreenRenderer: async () => ({
      backend: 'mock',
      hdrOutputActive: false,
      renderFrame: async () => {},
      setTargetHdr() {},
      destroy() {},
    }),
  };
}

test('Track 1 Regression Suite', async t => {
  const repoRoot = path.resolve(__dirname, '../..');
  const workerMod = await import(pathToFileURL(path.join(repoRoot, 'web/ubuplayer-worker.js')).href);
  const workletMod = await import(pathToFileURL(path.join(repoRoot, 'web/ubuplayer-worklet.js')).href);
  const gpuMod = await import(pathToFileURL(path.join(repoRoot, 'web/ubuplayer-gpu.js')).href);
  const ubuMod = await import(pathToFileURL(path.join(repoRoot, 'web/ubuplayer.js')).href);
  const policyMod = await import(pathToFileURL(path.join(repoRoot, 'shared/playback-policy.mjs')).href);
  const fixtures = await import(pathToFileURL(path.join(repoRoot, 'tests/helpers/ubuplayer-fixtures.mjs')).href);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubu-t1-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  await t.test(
    '1A (D4): Master clock eliminates 50ms clamp bias, staircases, cold-start backward snaps, and accounts for downstream latency',
    () => {
      for (const outputLatencySec of [0.02, 0.1, 0.16, 0.22]) {
        const p = Object.create(ubuMod.UbuPlayer.prototype);
        Object.assign(p, {
          _paused: false,
          _seeking: false,
          _duration: 600,
          _playbackRate: 1.0,
          hasAudioTrack: true,
          audioSwitchGen: 0,
          workletClockValid: false,
          anchorMediaTime: 10.0,
          anchorContextTime: null,
          downstreamAudioLatencySec: 0.006,
          _lastMonotonicMediaTime: null,
          lastUnderruns: 0,
          underrunWaiting: false,
          seekGen: 0,
          destroyed: false,
          listeners: new Map(),
          options: {},
        });

        let simWallMs = 1000;
        p.audioContext = {
          state: 'running',
          sampleRate: 48000,
          baseLatency: 0.01,
          outputLatency: outputLatencySec - 0.01,
          get currentTime() {
            return 50.0 + (simWallMs - 1000) / 1000;
          },
          getOutputTimestamp() {
            // Simulate cold-start contextTime === 0 for first 24ms, then valid speaker timestamp
            if (simWallMs - 1000 < 24) return { contextTime: 0, performanceTime: performance.now() };
            return {
              contextTime: 50.0 + (simWallMs - 1000) / 1000 - outputLatencySec,
              performanceTime: performance.now(),
            };
          },
        };

        let prev = null;
        let frozen = 0;
        let steps = 0;
        const errorsMs = [];
        for (let tMs = 0; tMs <= 200; tMs += 2) {
          simWallMs = 1000 + tMs;
          if (tMs % 32 === 0) {
            p.handleWorkletMessage({
              type: 'clock',
              seekGen: 0,
              audioGen: 0,
              contextTime: 50.0 + tMs / 1000,
              mediaSample: (10.0 + tMs / 1000) * 48000,
              bufferedSeconds: 5.0,
              underruns: 0,
              playing: true,
              eofDrained: false,
            });
          }
          const cur = p.currentTime;
          const expectedPhysical = 10.0 + tMs / 1000 - outputLatencySec - 0.006;
          errorsMs.push(Math.abs(cur - expectedPhysical) * 1000);
          if (prev !== null) {
            steps++;
            assert.ok(cur >= prev - 1e-6, `Clock snapped backward at ${tMs}ms (${prev} -> ${cur})`);
            if (Math.abs(cur - prev) < 1e-5) frozen++;
          }
          prev = cur;
        }
        const meanErrMs = errorsMs.reduce((a, b) => a + b, 0) / errorsMs.length;
        assert.ok(
          meanErrMs < 2.0,
          `Mean clock error ${meanErrMs.toFixed(2)}ms exceeded 2.0ms at ${outputLatencySec * 1000}ms latency`,
        );
        assert.equal(
          frozen,
          0,
          `Detected ${frozen}/${steps} frozen clock intervals at ${outputLatencySec * 1000}ms latency`,
        );
      }

      // Cold-start transition when browser reports outputLatency: 0 initially before getOutputTimestamp activates
      const pZeroLat = Object.create(ubuMod.UbuPlayer.prototype);
      Object.assign(pZeroLat, {
        _paused: false,
        _seeking: false,
        _duration: 600,
        _playbackRate: 1.0,
        hasAudioTrack: true,
        audioSwitchGen: 0,
        workletClockValid: false,
        anchorMediaTime: 10.0,
        anchorContextTime: null,
        downstreamAudioLatencySec: 0.006,
        _lastMonotonicMediaTime: null,
        lastUnderruns: 0,
        underrunWaiting: false,
        seekGen: 0,
        destroyed: false,
        listeners: new Map(),
        options: {},
      });
      let wall = 1000;
      pZeroLat.audioContext = {
        state: 'running',
        sampleRate: 48000,
        baseLatency: 0,
        outputLatency: 0,
        get currentTime() {
          return 50.0 + (wall - 1000) / 1000;
        },
        getOutputTimestamp() {
          if (wall - 1000 < 24) return { contextTime: 0, performanceTime: performance.now() };
          return {
            contextTime: 50.0 + (wall - 1000) / 1000 - 0.16,
            performanceTime: performance.now(),
          };
        },
      };
      let prevZero = null;
      for (let tMs = 0; tMs <= 80; tMs += 4) {
        wall = 1000 + tMs;
        if (tMs === 0 || tMs === 32) {
          pZeroLat.handleWorkletMessage({
            type: 'clock',
            seekGen: 0,
            audioGen: 0,
            contextTime: 50.0 + tMs / 1000,
            mediaSample: (10.0 + tMs / 1000) * 48000,
            bufferedSeconds: 5.0,
            underruns: 0,
            playing: true,
            eofDrained: false,
          });
        }
        const cur = pZeroLat.currentTime;
        if (prevZero !== null) {
          assert.ok(cur >= prevZero - 1e-6, `Cold-start backward snap (${prevZero} -> ${cur}) at ${tMs}ms`);
        }
        prevZero = cur;
      }
    },
  );

  await t.test(
    '1A (D4): preferences.js exposes downstreamAudioLatencySec = 0.006 from ensureAudioProcessingInput()',
    () => {
      const fakeNode = {
        type: '',
        frequency: { value: 0 },
        Q: { value: 0 },
        gain: { value: 0, setValueAtTime() {} },
        threshold: { value: 0, setValueAtTime() {} },
        knee: { value: 0, setValueAtTime() {} },
        ratio: { value: 0, setValueAtTime() {} },
        attack: { value: 0, setValueAtTime() {} },
        release: { value: 0, setValueAtTime() {} },
        connect() {},
      };
      const FakeAudioContext = function () {
        this.currentTime = 1.0;
        this.state = 'running';
        this.destination = {};
        this.createBiquadFilter = () => ({
          ...fakeNode,
          frequency: { value: 0 },
          Q: { value: 0 },
          gain: { value: 0, setValueAtTime() {} },
        });
        this.createDynamicsCompressor = () => ({
          ...fakeNode,
          threshold: { value: 0, setValueAtTime() {} },
          knee: { value: 0, setValueAtTime() {} },
          ratio: { value: 0, setValueAtTime() {} },
          attack: { value: 0, setValueAtTime() {} },
          release: { value: 0, setValueAtTime() {} },
        });
        this.createGain = () => ({ ...fakeNode, gain: { value: 1, setValueAtTime() {} } });
      };
      const prefMod = require('../../web/watch/preferences.js');
      const byId = new Map();
      const { api, restore } = mountModule(prefMod, {
        document: {
          getElementById: id => {
            if (id.endsWith('-group')) return null;
            if (!byId.has(id)) byId.set(id, element());
            return byId.get(id);
          },
        },
        window: {
          AudioContext: FakeAudioContext,
          addEventListener() {},
          removeEventListener() {},
          matchMedia: () => ({ matches: false, addEventListener() {} }),
        },
        subtitleLayout: () => {},
        playerPreferences: {
          quality: 'direct',
          audioMode: 'normal',
          subtitleColor: 'white',
          subtitleBg: 'background',
          subtitleSize: 'medium',
          subtitlePosition: 'video',
          subtitleBrightness: 100,
        },
        time: { mono: () => 0, wall: () => 0, setTimeout: () => 1, clearTimeout() {} },
        surface: { isUbuPlayer: () => true },
      });
      try {
        const chain = api.ensureAudioProcessingInput();
        assert.ok(chain && chain.audioContext && chain.destination);
        assert.equal(chain.downstreamAudioLatencySec, 0.006);
      } finally {
        restore();
      }
    },
  );

  await t.test(
    '1B (D1): Stereo-linked true-peak limiter prevents 5.1 clipping while preserving solo Center dialogue loudness and THD+N < -110 dB',
    { skip: !hasFfmpeg && 'ffmpeg missing' },
    async () => {
      const { UbuPlayerAudioCore } = workletMod;
      const boomBuf = fs.readFileSync(fixtures.buildCoherent51Mkv(tmpDir));
      const speechBuf = fs.readFileSync(fixtures.buildSoloCenterSpeechMkv(tmpDir));

      async function decodeAndRenderThroughCore(buf, mode) {
        const chunksL = [];
        const chunksR = [];
        await new Promise((resolve, reject) => {
          const eng = workerMod.createWorkerEngine(msg => {
            if (msg.type === 'read') {
              const copy = new Uint8Array(buf.subarray(msg.start, Math.min(buf.length, msg.end)));
              setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
            } else if (msg.type === 'audioPcm') {
              if (msg.left.length) {
                chunksL.push(msg.left);
                chunksR.push(msg.right);
              }
              if (msg.eof) void eng.cleanup().then(resolve);
            } else if (msg.type === 'error') {
              void eng.cleanup().then(() => reject(new Error(msg.message)));
            }
          }, mockWebCodecs());
          eng.onMessage({ type: 'init', fileSize: buf.length, audioMode: mode, aheadSeconds: 5, canvas: {} });
        });

        const core = new UbuPlayerAudioCore({ sampleRate: 48000 });
        core.reset(0, { seekGen: 1, audioGen: 1 });
        for (let i = 0; i < chunksL.length; i++) core.push(chunksL[i], chunksR[i]);
        core.eof = true;
        core.playing = true;

        const outL = [];
        const outR = [];
        const qL = new Float32Array(128);
        const qR = new Float32Array(128);
        while (true) {
          const r = core.render(qL, qR);
          if (r.rendered > 0) {
            outL.push(...qL.subarray(0, r.rendered));
            outR.push(...qR.subarray(0, r.rendered));
          }
          if (r.ended || outL.length >= 48000) break;
        }
        let maxSamplePeak = 0;
        let maxTruePeak = 0;
        for (let i = 1; i < outL.length - 2; i++) {
          for (const arr of [outL, outR]) {
            const y0 = arr[i - 1],
              y1 = arr[i],
              y2 = arr[i + 1],
              y3 = arr[i + 2];
            maxSamplePeak = Math.max(maxSamplePeak, Math.abs(y1));
            for (const tFrac of [0.0, 0.25, 0.5, 0.75]) {
              const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
              const a1 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
              const a2 = -0.5 * y0 + 0.5 * y2;
              const tp = Math.abs(((a0 * tFrac + a1) * tFrac + a2) * tFrac + y1);
              if (tp > maxTruePeak) maxTruePeak = tp;
            }
          }
        }
        return { maxSamplePeak, maxTruePeakDbtp: 20 * Math.log10(Math.max(1e-9, maxTruePeak)) };
      }

      for (const mode of ['normal', 'dialogue', 'night']) {
        const boom = await decodeAndRenderThroughCore(boomBuf, mode);
        assert.ok(boom.maxSamplePeak <= 1.0, `${mode} sample peak ${boom.maxSamplePeak} clipped > 1.0`);
        assert.ok(
          boom.maxTruePeakDbtp <= -0.1,
          `${mode} true peak ${boom.maxTruePeakDbtp.toFixed(2)} dBTP exceeded -0.1 dBTP`,
        );
      }

      const speechNormal = await decodeAndRenderThroughCore(speechBuf, 'normal');
      const speechDialogue = await decodeAndRenderThroughCore(speechBuf, 'dialogue');
      assert.ok(
        Math.abs(20 * Math.log10(speechNormal.maxSamplePeak) - -21.07) < 0.1,
        'Normal Center speech attenuated!',
      );
      assert.ok(Math.abs(20 * Math.log10(speechDialogue.maxSamplePeak) - -15.05) < 0.1, 'Dialogue Center boost lost!');

      // Verify THD+N < -110 dB on -6 dBFS (0.501) 1 kHz sine below ceiling
      const sr = 48000;
      const coreThd = new UbuPlayerAudioCore({ sampleRate: sr });
      const N = 4800;
      const sineL = new Float32Array(N);
      const sineR = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        sineL[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sr);
        sineR[i] = sineL[i];
      }
      coreThd.reset(0, { seekGen: 1, audioGen: 1 });
      coreThd.push(sineL, sineR, 0);
      coreThd.playing = true;
      const rendered = new Float32Array(N);
      const bL = new Float32Array(128);
      const bR = new Float32Array(128);
      for (let off = 0; off + 128 <= N; off += 128) {
        coreThd.render(bL, bR);
        rendered.set(bL, off);
      }
      const d = coreThd.limiterLookahead;
      let errEnergy = 0;
      let sigEnergy = 0;
      for (let i = d; i < N - 128; i++) {
        const diff = rendered[i] - sineL[i - d];
        errEnergy += diff * diff;
        sigEnergy += sineL[i - d] * sineL[i - d];
      }
      const thdNDb = 10 * Math.log10(Math.max(1e-16, errEnergy / sigEnergy));
      assert.ok(thdNDb < -110, `Expected THD+N < -110 dB below ceiling, got ${thdNDb.toFixed(1)} dB`);
    },
  );

  await t.test(
    '1C: WSOLA crossfades 1.02x -> 1.00x exit without clicks and preserves pitch on anti-phase stereo',
    () => {
      const { UbuPlayerAudioCore } = workletMod;
      const sr = 48000;
      const inL = new Float32Array(sr * 3);
      const inR = new Float32Array(sr * 3);
      for (let i = 0; i < inL.length; i++) {
        inL[i] = 0.7 * Math.sin((2 * Math.PI * 440 * i) / sr);
        inR[i] = inL[i];
      }
      const core = new UbuPlayerAudioCore({ sampleRate: sr });
      core.reset(0, { seekGen: 1, audioGen: 1 });
      core.push(inL, inR, 0);
      core.playing = true;

      const out = new Float32Array(sr * 2);
      const qL = new Float32Array(128);
      const qR = new Float32Array(128);
      for (let off = 0; off < out.length; off += 128) {
        if (off === 128 * 40) core.setRate(1.02);
        if (off === 128 * 250) core.setRate(1.0);
        core.render(qL, qR);
        out.set(qL, off);
      }
      const nominalSlope = 0.7 * ((2 * Math.PI * 440) / sr);
      let maxSlopeAroundExit = 0;
      for (let i = 128 * 248; i < 128 * 265; i++) {
        maxSlopeAroundExit = Math.max(maxSlopeAroundExit, Math.abs(out[i] - out[i - 1]));
      }
      assert.ok(
        maxSlopeAroundExit <= nominalSlope * 1.15,
        `Rate exit click ratio ${(maxSlopeAroundExit / nominalSlope).toFixed(2)}x > 1.15x`,
      );

      // Anti-phase stereo pitch check at 1.025x
      const antiCore = new UbuPlayerAudioCore({ sampleRate: sr });
      const antiR = new Float32Array(inL.length);
      for (let i = 0; i < inL.length; i++) antiR[i] = -inL[i];
      antiCore.reset(0, { seekGen: 1, audioGen: 1 });
      antiCore.push(inL, antiR, 0);
      antiCore.setRate(1.025);
      antiCore.playing = true;
      const antiOut = new Float32Array(sr);
      for (let off = 0; off < sr; off += 128) {
        antiCore.render(qL, qR);
        antiOut.set(qL, off);
      }
      let crossings = 0;
      for (let i = 4800; i < 43200; i++) {
        if (antiOut[i - 1] <= 0 && antiOut[i] > 0) crossings++;
      }
      const measuredHz = crossings / 0.8;
      assert.ok(
        Math.abs(measuredHz - 440.0) <= 1.0,
        `Anti-phase stereo shifted to ${measuredHz.toFixed(2)} Hz instead of 440 Hz`,
      );
    },
  );

  await t.test(
    '1D: Audio PTS gap resynchronizes within +/-2ms, Opus pre-skip and container start_time normalize cleanly, and live audio switch has no backward snap',
    { skip: !hasFfmpeg && 'ffmpeg missing' },
    async () => {
      const { UbuPlayerAudioCore } = workletMod;

      // 1. Mid-stream PTS gap
      const gapBuf = fs.readFileSync(fixtures.buildPtsGapMkv(tmpDir));
      const core = new UbuPlayerAudioCore({ sampleRate: 48000 });
      core.reset(0, { seekGen: 0, audioGen: 0 });
      await new Promise((resolve, reject) => {
        const eng = workerMod.createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const c = new Uint8Array(gapBuf.subarray(msg.start, Math.min(gapBuf.length, msg.end)));
            setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: c.buffer }));
          } else if (msg.type === 'audioPcm') {
            if (msg.left.length) core.push(msg.left, msg.right, msg.startSample);
            if (msg.eof) void eng.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void eng.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWebCodecs());
        eng.onMessage({ type: 'init', fileSize: gapBuf.length, audioMode: 'normal', aheadSeconds: 5, canvas: {} });
      });
      let impulseIdx = -1;
      for (let i = 0; i < core.writtenTotal; i++) {
        if (Math.abs(core.sampleRingL(i)) > 0.05) {
          impulseIdx = i;
          break;
        }
      }
      const impulseSec = impulseIdx / 48000;
      // In buildPtsGapMkv, FFmpeg's 1024-sample sine filter evaluates volume=0 per frame, placing the 1 kHz pulse at container pts_time = 1.5150s
      assert.ok(
        Math.abs(impulseSec - 1.515) <= 0.002,
        `PTS-gap impulse landed at ${impulseSec.toFixed(4)}s instead of 1.5150s`,
      );

      // 2. Opus negative-PTS pre-skip trimming
      const opusBuf = fs.readFileSync(fixtures.buildOpusPreSkipMkv(tmpDir));
      const opusCore = new UbuPlayerAudioCore({ sampleRate: 48000 });
      opusCore.reset(0, { seekGen: 0, audioGen: 0 });
      let firstStartSample = null;
      await new Promise((resolve, reject) => {
        const eng = workerMod.createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const c = new Uint8Array(opusBuf.subarray(msg.start, Math.min(opusBuf.length, msg.end)));
            setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: c.buffer }));
          } else if (msg.type === 'audioPcm') {
            if (msg.left.length) {
              if (firstStartSample === null) firstStartSample = msg.startSample;
              opusCore.push(msg.left, msg.right, msg.startSample);
            }
            if (msg.eof) void eng.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void eng.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWebCodecs());
        eng.onMessage({ type: 'init', fileSize: opusBuf.length, audioMode: 'normal', aheadSeconds: 5, canvas: {} });
      });
      assert.equal(firstStartSample, 0, 'Opus negative pre-skip should trim so first emitted sample starts at 0');
      let opusImpulseIdx = -1;
      for (let i = 0; i < opusCore.writtenTotal; i++) {
        if (Math.abs(opusCore.sampleRingL(i)) > 0.05) {
          opusImpulseIdx = i;
          break;
        }
      }
      const opusImpulseSec = opusImpulseIdx / 48000;
      assert.ok(
        Math.abs(opusImpulseSec - 1.0) <= 0.004,
        `Opus pre-skip impulse landed at ${opusImpulseSec.toFixed(4)}s instead of 1.0000s`,
      );

      // 3. Container start_time normalization on MPEG-TS
      const tsBuf = fs.readFileSync(fixtures.buildOffsetStartTimeTs(tmpDir, 12.345));
      const tsCore = new UbuPlayerAudioCore({ sampleRate: 48000 });
      tsCore.reset(0, { seekGen: 0, audioGen: 0 });
      let tsFirstSample = null;
      await new Promise((resolve, reject) => {
        const eng = workerMod.createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const c = new Uint8Array(tsBuf.subarray(msg.start, Math.min(tsBuf.length, msg.end)));
            setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: c.buffer }));
          } else if (msg.type === 'audioPcm') {
            if (msg.left.length) {
              if (tsFirstSample === null) tsFirstSample = msg.startSample;
              tsCore.push(msg.left, msg.right, msg.startSample);
            }
            if (msg.eof) void eng.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void eng.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWebCodecs());
        eng.onMessage({ type: 'init', fileSize: tsBuf.length, audioMode: 'normal', aheadSeconds: 5, canvas: {} });
      });
      assert.ok(
        tsFirstSample !== null && tsFirstSample < 4800,
        `Expected TS start_time normalized near 0, got first sample ${tsFirstSample}`,
      );

      // 4. Live selectAudio / setAudioMode zero backward playhead snap
      const p = Object.create(ubuMod.UbuPlayer.prototype);
      const postedWorklet = [];
      const postedWorker = [];
      Object.assign(p, {
        _paused: false,
        _seeking: false,
        _duration: 600,
        _playbackRate: 1.0,
        hasAudioTrack: true,
        selectedAudioId: 'a1',
        audioMode: 'normal',
        audioGen: 1,
        audioSwitchGen: 0,
        workletClockValid: true,
        anchorMediaTime: 25.0,
        anchorContextTime: 100.0,
        anchorPerfMs: performance.now() - 100,
        downstreamAudioLatencySec: 0.006,
        _lastMonotonicMediaTime: 25.0,
        lastUnderruns: 0,
        underrunWaiting: false,
        seekGen: 0,
        destroyed: false,
        listeners: new Map(),
        options: {},
        workletNode: { port: { postMessage: m => postedWorklet.push(m) } },
        worker: { postMessage: m => postedWorker.push(m) },
        audioContext: {
          state: 'running',
          sampleRate: 48000,
          baseLatency: 0.01,
          outputLatency: 0.04,
          currentTime: 100.2,
          getOutputTimestamp: () => ({ contextTime: 100.15, performanceTime: performance.now() }),
        },
      });
      const beforeSwitch = p.currentTime;
      p.selectAudio('a2');
      const resetMsg = postedWorklet.find(m => m.type === 'reset');
      assert.ok(
        resetMsg && resetMsg.startSample > Math.round(beforeSwitch * 48000),
        'selectAudio prerolls target ahead',
      );
      await new Promise(r => setTimeout(r, 40));
      const midSwitch = p.currentTime;
      assert.ok(
        midSwitch >= beforeSwitch - 1e-6,
        `currentTime snapped backward during switch: ${beforeSwitch} -> ${midSwitch}`,
      );
      // Worklet sends clock at the prerolled target sample; currentTime must not snap backward
      p.handleWorkletMessage({
        type: 'clock',
        seekGen: 0,
        audioGen: p.audioGen,
        contextTime: 100.45,
        mediaSample: resetMsg.startSample,
        bufferedSeconds: 0.25,
        underruns: 0,
        playing: true,
        eofDrained: false,
      });
      assert.ok(
        p.currentTime >= midSwitch - 1e-6,
        `currentTime snapped backward after handoff: ${midSwitch} -> ${p.currentTime}`,
      );
    },
  );

  await t.test(
    '1E & D3 & D5: Font cap, device unlink, sparse-subtitle I/O bound, PGS reset, RPU multi-piece linear_interp, hold(), async destroy race, iPhone routing, and PiP visibility',
    { skip: !hasFfmpeg && 'ffmpeg missing' },
    async () => {
      // 1. Aggregate 16 MiB font cap + fontsTruncated flag on 5 x 4 MiB = 20 MiB MKV
      const fontBuf = fs.readFileSync(fixtures.buildOversizeFontsMkv(tmpDir, 5, 4));
      let subInitFontsBytes = 0;
      let fontsTruncated = false;
      await new Promise((resolve, reject) => {
        const eng = workerMod.createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const c = new Uint8Array(fontBuf.subarray(msg.start, Math.min(fontBuf.length, msg.end)));
            setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: c.buffer }));
          } else if (msg.type === 'ready') {
            eng.onMessage({ type: 'selectSubtitle', subGen: 1, subtitleId: msg.subtitleTracks[0].id, time: 0 });
          } else if (msg.type === 'subtitleInit') {
            subInitFontsBytes = (msg.fonts || []).reduce((s, f) => s + f.byteLength, 0);
            fontsTruncated = Boolean(msg.fontsTruncated);
            void eng.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void eng.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWebCodecs());
        eng.onMessage({ type: 'init', fileSize: fontBuf.length, aheadSeconds: 5, canvas: {} });
      });
      assert.ok(subInitFontsBytes <= 16 * 1024 * 1024, `Aggregate font bytes ${subInitFontsBytes} exceeded 16 MiB cap`);
      assert.equal(fontsTruncated, true, 'subtitleInit must report fontsTruncated: true when aggregate exceeds 16 MiB');

      // 2. Sparse Forced SRT read-amplification bound (aheadSeconds = 10 on 60s ~42 MiB MKV)
      const sparseBuf = fs.readFileSync(fixtures.buildSparseForcedSubMkv(tmpDir));
      let bytesRead = 0;
      await new Promise((resolve, reject) => {
        let done = false;
        const eng = workerMod.createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const end = Math.min(sparseBuf.length, msg.end);
            bytesRead += Math.max(0, end - msg.start);
            const c = new Uint8Array(sparseBuf.subarray(msg.start, end));
            setImmediate(() => eng.onMessage({ type: 'readResult', id: msg.id, bytes: c.buffer }));
          } else if (msg.type === 'ready') {
            eng.onMessage({ type: 'selectSubtitle', subGen: 1, subtitleId: msg.subtitleTracks[0].id, time: 0 });
            setTimeout(() => {
              if (!done) {
                done = true;
                void eng.cleanup().then(resolve);
              }
            }, 150);
          } else if (msg.type === 'error' && !done) {
            done = true;
            void eng.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWebCodecs());
        eng.onMessage({ type: 'init', fileSize: sparseBuf.length, aheadSeconds: 10, canvas: {} });
      });
      assert.ok(
        bytesRead < sparseBuf.length * 1.35,
        `Sparse subtitle read ${(bytesRead / 1048576).toFixed(2)} MiB (> 1.35x of ${(sparseBuf.length / 1048576).toFixed(2)} MiB file)`,
      );

      // 3. PGS / local subtitle seek emits subtitleReset and resets renderer
      const { uburoomSubtitles } = require('../../web/watch-subtitles.js');
      let resetCalls = 0;
      const fakeSubs = Object.create(uburoomSubtitles.prototype);
      fakeSubs.renderer = { reset: () => resetCalls++ };
      fakeSubs.resetLocalRenderer();
      assert.equal(resetCalls, 1, 'resetLocalRenderer must invoke renderer.reset()');

      let onSubtitleResetCalled = 0;
      const pReset = Object.create(ubuMod.UbuPlayer.prototype);
      Object.assign(pReset, {
        destroyed: false,
        subGen: 3,
        seekGen: 1,
        options: { onSubtitleReset: () => onSubtitleResetCalled++ },
      });
      pReset.handleWorkerMessage({ type: 'subtitleReset', subGen: 3, seekGen: 1 });
      assert.equal(onSubtitleResetCalled, 1, 'UbuPlayer forwards subtitleReset to options.onSubtitleReset');

      // 4. Multi-piece linear_interp_flag = 1 RPU parser fix
      const b = new BitBuilder();
      b.u(62 << 1, 8);
      b.u(1, 8);
      b.u(25, 8);
      b.u(2, 6);
      b.u(18, 11);
      b.u(0, 4);
      b.u(0, 4);
      b.u(1, 1);
      b.u(0, 1);
      b.u(0, 2);
      b.ue(23);
      b.u(0, 2);
      b.u(1, 1); // full range -> Profile 5
      b.ue(2);
      b.ue(2);
      b.ue(4);
      b.u(0, 1);
      b.u(0, 3);
      b.u(1, 1);
      b.u(1, 1);
      b.u(0, 1);
      b.u(0, 1);
      b.ue(0);
      b.ue(1);
      b.ue(0);
      // 3 pivots (2 pieces) for all 3 components: 0 -> 511 -> 1023
      for (let c = 0; c < 3; c++) {
        b.ue(1); // num_pivots_minus_2 = 1 -> 3 pivots (2 pieces)
        b.u(0, 10);
        b.u(511, 10);
        b.u(512, 10);
      }
      b.ue(0);
      b.ue(0);
      // Each component has 2 pieces with poly_order_minus1 = 0, linear_interp_flag = 1
      // Spec bitstream: piece 0 reads [v0, v1]; piece 1 reads ONLY [v2]
      for (let c = 0; c < 3; c++) {
        // Piece 0: v0 = 0.0 -> v1 = 0.25
        b.ue(0);
        b.ue(0);
        b.u(1, 1);
        b.se(0);
        b.u(0, 23);
        b.se(0);
        b.u(1 << 21, 23); // 0.25
        // Piece 1: reuses v1 = 0.25, reads only v2 = 1.0
        b.ue(0);
        b.ue(0);
        b.u(1, 1);
        b.se(1);
        b.u(0, 23);
      }
      const multiRpu = gpuMod.parseDolbyVisionRpu(b.toBytesWithEpb(), gpuMod.createDoviRpuContext(5));
      assert.ok(multiRpu, 'Multi-piece linear_interp_flag=1 RPU must parse without returning null');
      const curve0 = multiRpu.mapping.curves[0];
      assert.equal(curve0.numPieces, 2);
      const p1 = curve0.pivots[1];
      const vAtPivot1Piece0 = curve0.polyCoeffs[0][0] + curve0.polyCoeffs[0][1] * p1;
      const vAtPivot1Piece1 = curve0.polyCoeffs[1][0] + curve0.polyCoeffs[1][1] * p1;
      assert.ok(Math.abs(vAtPivot1Piece0 - 0.25) < 1e-4);
      assert.ok(Math.abs(vAtPivot1Piece1 - 0.25) < 1e-4, 'Piece 1 must start at Piece 0 ending value');

      // 5. Cooperative hold() pauses speculative reader fetches and Worker pumpLoop
      const pHold = Object.create(ubuMod.UbuPlayer.prototype);
      let abortedCount = 0;
      const holdWorkerMsgs = [];
      const reader = new ubuMod.HttpRangeReader('https://example.test/hold.mkv', { fileSize: 16 * 1024 * 1024 });
      reader.storeChunk(0, new Uint8Array([1, 2, 3]));
      reader.inflightControllers = new Set([{ abort: () => abortedCount++ }]);
      Object.assign(pHold, {
        destroyed: false,
        held: false,
        reader,
        worker: { postMessage: m => holdWorkerMsgs.push(m) },
      });
      pHold.hold(true);
      assert.equal(pHold.held, true);
      assert.equal(abortedCount, 1, 'hold(true) aborts speculative inflight requests');
      assert.equal(reader.chunks.size, 1, 'hold(true) preserves already cached chunks');
      assert.deepEqual(holdWorkerMsgs.at(-1), { type: 'hold', held: true });
      pHold.hold(false);
      assert.equal(pHold.held, false);
      assert.deepEqual(holdWorkerMsgs.at(-1), { type: 'hold', held: false });

      // 6. D5 iPhone vs iPad policy check + dynamic layout.js PiP visibility
      assert.equal(
        policyMod.isIPhone({
          userAgent:
            'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        }),
        true,
      );
      assert.equal(
        policyMod.isIPhone({
          userAgent:
            'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
        }),
        false,
      );
      assert.equal(
        policyMod.supportsUbuPlayer({
          videoDecoder: true,
          audioWorklet: true,
          offscreenCanvas: true,
          wasm: true,
          worker: true,
          navigator: {
            userAgent:
              'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
          },
          localFile: false,
        }),
        false,
        'HTTP UbuPlayer must be disabled on iPhone so native fullscreen works',
      );
      assert.equal(
        policyMod.supportsUbuPlayer({
          videoDecoder: true,
          audioWorklet: true,
          offscreenCanvas: true,
          wasm: true,
          worker: true,
          navigator: {
            userAgent:
              'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1',
          },
          localFile: false,
        }),
        true,
        'iPadOS must retain UbuPlayer support',
      );

      // layout.js PiP button visibility without documentPictureInPicture
      let isUbu = true;
      const pipBtn = element('button');
      const origMatchMedia = globalThis.matchMedia;
      const origResizeObserver = globalThis.ResizeObserver;
      const origScrollY = globalThis.scrollY;
      globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
      globalThis.ResizeObserver = class {
        observe() {}
        disconnect() {}
      };
      globalThis.scrollY = 0;
      const layoutMod = require('../../web/watch/layout.js');
      const { api: layoutApi, restore: restoreLayout } = mountModule(layoutMod, {
        document: {
          createComment: () => ({ after() {} }),
          getElementById: id => (id === 'pip' ? pipBtn : element()),
        },
        innerWidth: 1280,
        innerHeight: 720,
        activity: false,
        supportsPiP: true,
        supportsDocPiP: false,
        supportsVideoPiP: true,
        surface: { isUbuPlayer: () => isUbu, canRequestVideoPiP: () => !isUbu },
        glyph() {},
        renderTransport() {},
        toasts: { show() {} },
        fail() {},
      });
      try {
        assert.equal(pipBtn.hidden, true, 'PiP button must be hidden when UbuPlayer is active without Document PiP');
        isUbu = false;
        layoutApi.updatePipVisibility?.();
        assert.equal(
          pipBtn.hidden,
          false,
          'PiP button must become visible again when switching back to native <video>',
        );
      } finally {
        restoreLayout();
        if (origMatchMedia === undefined) delete globalThis.matchMedia;
        else globalThis.matchMedia = origMatchMedia;
        if (origResizeObserver === undefined) delete globalThis.ResizeObserver;
        else globalThis.ResizeObserver = origResizeObserver;
        if (origScrollY === undefined) delete globalThis.scrollY;
        else globalThis.scrollY = origScrollY;
      }

      // 7. Async start() / destroy() race closes created AudioWorkletNode / MessageChannel cleanly
      let portClosed = false;
      const pRace = Object.create(ubuMod.UbuPlayer.prototype);
      Object.assign(pRace, {
        destroyed: false,
        abort: new AbortController(),
        reader: {
          async probe() {
            await new Promise(r => setTimeout(r, 15));
            return { fileSize: 1024, initialBytes: new Uint8Array(64) };
          },
          abort() {},
        },
        async initAudioEngine() {
          await new Promise(r => setTimeout(r, 15));
          return {
            close() {
              portClosed = true;
            },
          };
        },
        options: {},
      });
      const startPromise = pRace.start();
      setTimeout(() => {
        pRace.destroyed = true;
        pRace.abort.abort();
      }, 20);
      await startPromise;
      assert.equal(portClosed, true, 'start() must close MessageChannel port if destroyed during initAudioEngine');
    },
  );
});
