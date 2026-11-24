'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const path = require('node:path');
const { test } = require('node:test');
const { pathToFileURL } = require('node:url');

const { createUbuPlayerAdapter } = require('../shared/sync/player-adapter.mjs');
const { createMediaSurface } = require('../web/media-surface.js');
const { uburoomSubtitles } = require('../web/watch-subtitles.js');
const preferencesMod = require('../web/watch/preferences.js');
const roomMod = require('../web/watch/room.js');
const { mountModule, element, stubDocument } = require('./helpers/watch-module.js');

// Bit-writer + Annex B emulation-prevention byte injector for building exact HEVC NAL 62 RPU payloads.
class BitBuilder {
  constructor() {
    this.bits = [];
  }
  u(val, n) {
    const unsigned = val >>> 0;
    for (let i = n - 1; i >= 0; i--) this.bits.push((unsigned >>> i) & 1);
  }
  s(val, n) {
    const unsigned = val < 0 ? 2 ** n + val : val;
    for (let i = n - 1; i >= 0; i--) {
      this.bits.push(Math.floor(unsigned / 2 ** i) & 1);
    }
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
    // Append trailing RBSP stop bit + zero padding
    this.bits.push(1);
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const rbsp = new Uint8Array(this.bits.length / 8);
    for (let i = 0; i < rbsp.length; i++) {
      let b = 0;
      for (let j = 0; j < 8; j++) b = (b << 1) | this.bits[i * 8 + j];
      rbsp[i] = b;
    }
    // Keep 2-byte HEVC NAL header raw, apply EPB escaping to RBSP body
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

test('createUbuPlayerAdapter and UbuPlayerAudioCore provide pitch-preserved WSOLA sync and start-delay telemetry', async () => {
  const workletMod = await import(pathToFileURL(path.join(__dirname, '../web/ubuplayer-worklet.js')).href);
  const { UbuPlayerAudioCore } = workletMod;

  // 1. Verify bit-exact 1.0x passthrough
  const core1x = new UbuPlayerAudioCore({ sampleRate: 48000 });
  const totalIn = 4800; // 100 ms
  const inL = new Float32Array(totalIn);
  const inR = new Float32Array(totalIn);
  for (let i = 0; i < totalIn; i++) {
    inL[i] = Math.sin((2 * Math.PI * 440 * i) / 48000);
    inR[i] = Math.cos((2 * Math.PI * 440 * i) / 48000);
  }
  core1x.reset(48000, { seekGen: 1, audioGen: 1 });
  core1x.push(inL, inR, 48000);
  core1x.playing = true;
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  core1x.render(outL, outR);
  for (let i = 0; i < 128; i++) {
    assert.ok(Math.abs(outL[i] - inL[i]) < 1e-6, '1.0x passthrough preserves exact Float32 samples');
    assert.ok(Math.abs(outR[i] - inR[i]) < 1e-6);
  }
  assert.equal(core1x.currentMediaSample, 48000 + 128);

  // 2. Verify WSOLA micro-rate stretching at 1.03x and 0.97x preserves 440 Hz pitch while advancing media clock at target rate
  for (const rate of [1.03, 0.97]) {
    const core = new UbuPlayerAudioCore({ sampleRate: 48000 });
    const twoSec = 96000;
    const toneL = new Float32Array(twoSec);
    const toneR = new Float32Array(twoSec);
    for (let i = 0; i < twoSec; i++) {
      const v = 0.8 * Math.sin((2 * Math.PI * 440 * i) / 48000);
      toneL[i] = v;
      toneR[i] = v;
    }
    core.reset(0, { seekGen: 1, audioGen: 1 });
    core.push(toneL, toneR, 0);
    core.setRate(rate);
    core.playing = true;

    const renderedOut = new Float32Array(48000); // Render 1.000s of wall-clock audio output
    const bufL = new Float32Array(128);
    const bufR = new Float32Array(128);
    for (let off = 0; off < renderedOut.length; off += 128) {
      const len = Math.min(128, renderedOut.length - off);
      const subL = bufL.subarray(0, len);
      const subR = bufR.subarray(0, len);
      core.render(subL, subR);
      renderedOut.set(subL, off);
    }

    const expectedMediaSamples = 48000 * rate;
    assert.ok(
      Math.abs(core.currentMediaSample - expectedMediaSamples) < 1200,
      `At ${rate}x, media playhead (${core.currentMediaSample}) tracks expected ${expectedMediaSamples}`,
    );

    // Measure zero-crossings over steady-state [0.1s..0.9s] to confirm 440 Hz pitch is preserved
    let positiveCrossings = 0;
    const startIdx = 4800;
    const endIdx = 43200; // 0.8s window -> expected ~352 cycles of 440 Hz
    for (let i = startIdx + 1; i < endIdx; i++) {
      if (renderedOut[i - 1] <= 0 && renderedOut[i] > 0) positiveCrossings++;
    }
    const measuredHz = positiveCrossings / 0.8;
    assert.ok(
      Math.abs(measuredHz - 440) < 6,
      `Expected pitch-preserved ~440 Hz at ${rate}x, measured ${measuredHz.toFixed(1)} Hz`,
    );
  }

  // 3. Verify createUbuPlayerAdapter contract + measureStart()
  const listeners = new Map();
  let frameCb = null;
  const fakeUbu = {
    readyState: 4,
    currentTime: 12.5,
    duration: 120,
    paused: true,
    ended: false,
    seeking: false,
    playbackRate: 1,
    volume: 1,
    muted: false,
    buffered: { length: 1, start: () => 10, end: () => 35 },
    seek(t) {
      this.currentTime = t;
    },
    setPlaybackRate(r) {
      this.playbackRate = r;
    },
    setAudio(v, m) {
      this.volume = v;
      this.muted = m;
    },
    play() {
      this.paused = false;
      return Promise.resolve();
    },
    pause() {
      this.paused = true;
    },
    addEventListener(type, fn) {
      listeners.set(type, fn);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    requestVideoFrameCallback(cb) {
      frameCb = cb;
      return 7;
    },
    cancelVideoFrameCallback() {
      frameCb = null;
    },
  };

  const adapter = createUbuPlayerAdapter(fakeUbu);
  assert.equal(adapter.hasFrameEvidence, true);
  assert.equal(adapter.supportsRateSync, true);
  assert.equal(adapter.bufferModel, 'ranges');
  assert.equal(adapter.bufferedAhead(12.5), 22.5);
  assert.equal(adapter.isBufferedAt(12.5), true);
  adapter.setPlaybackRate(1.02);
  assert.equal(adapter.playbackRate(), 1.02);
  adapter.setAudio(0.45, true);
  assert.equal(fakeUbu.volume, 0.45);
  assert.equal(fakeUbu.muted, true);

  const startPromise = adapter.measureStart();
  await adapter.play();
  const now = performance.now();
  frameCb(now + 18, { expectedDisplayTime: now + 18, mediaTime: 12.54 });
  const delayMs = await startPromise;
  assert.ok(Number.isFinite(delayMs) && delayMs >= 0);
});

test('Dolby Vision RPU parser, NAL 62/63 inspector, BT.2390 tonemap uniforms, and zero-clamp VideoFrame wrapper match libplacebo', async () => {
  const gpuMod = await import(pathToFileURL(path.join(__dirname, '../web/ubuplayer-gpu.js')).href);
  const {
    createDoviRpuContext,
    parseDolbyVisionRpu,
    inspectHevcPacket,
    computeTonemapUniforms,
    wrapFramePreventingSdrClamp,
  } = gpuMod;

  // Build a bit-exact DV Profile 5 NAL 62 RPU with EPB escaping (0x00 0x00 0x00 -> 0x00 0x00 0x03 0x00)
  const r = new BitBuilder();
  r.u(62 << 1, 8);
  r.u(1, 8);
  r.u(25, 8); // nal_prefix = 25
  r.u(2, 6); // rpu_type = 2
  r.u(18, 11); // rpu_format = 18
  r.u(0, 4); // vdr_rpu_profile = 0
  r.u(0, 4); // vdr_rpu_level = 0
  r.u(1, 1); // vdr_seq_info_present_flag = 1
  r.u(0, 1); // chroma_resampling_explicit_filter_flag = 0
  r.u(0, 2); // coef_data_type = 0
  r.ue(23); // coef_log2_denom = 23
  r.u(0, 2); // vdr_rpu_normalized_idc = 0
  r.u(1, 1); // bl_video_full_range_flag = 1 -> Profile 5
  r.ue(2); // bl_bit_depth_minus8 = 2 (10-bit)
  r.ue(2); // el_bit_depth_minus8 = 2
  r.ue(4); // vdr_bit_depth_minus8 = 4 (12-bit)
  r.u(0, 1); // spatial_resampling_filter_flag = 0
  r.u(0, 3); // reserved_zero_3bits
  r.u(1, 1); // el_spatial_resampling_filter_flag = 1
  r.u(1, 1); // disable_residual_flag = 1
  r.u(1, 1); // vdr_dm_metadata_present_flag = 1
  r.u(0, 1); // use_prev_vdr_rpu_flag = 0
  r.ue(0); // vdr_rpu_id = 0
  r.ue(1); // mapping_color_space = 1 (IPTPQc2)
  r.ue(0); // mapping_chroma_format_idc = 0
  for (let c = 0; c < 3; c++) {
    r.ue(0); // num_pivots_minus2 = 0 (2 pivots)
    r.u(0, 10);
    r.u(1023, 10);
  }
  r.ue(0); // num_x_partitions_minus1 = 0
  r.ue(0); // num_y_partitions_minus1 = 0
  // Component 0 & 1: polynomial order 1 (y = 0 + 1.0 * x); Component 2: MMR order 1
  for (let c = 0; c < 2; c++) {
    r.ue(0); // mapping_idc = 0 (polynomial)
    r.ue(0); // poly_order_minus1 = 0 -> order 1
    r.u(0, 1); // linear_interp_flag = 0
    r.se(0); // coef_int[0] = 0
    r.u(0, 23); // coef_frac[0] = 0
    r.se(1); // coef_int[1] = 1
    r.u(0, 23); // coef_frac[1] = 0
  }
  // Component 2: MMR order 1
  r.ue(1); // mapping_idc = 1 (MMR)
  r.u(0, 2); // mmr_order_minus1 = 0 -> order 1
  r.se(0); // mmr_constant_int = 0
  r.u(0, 23); // mmr_constant_frac = 0
  for (let j = 0; j < 7; j++) {
    r.se(j === 2 ? 1 : 0);
    r.u(0, 23);
  }
  // DM metadata matching FFmpeg 6.1 vdr_dm_metadata_payload
  r.ue(0); // affected_dm_metadata_id = 0
  r.ue(0); // current_dm_metadata_id = 0
  r.ue(0); // scene_refresh_flag = 0
  const yccFixed = [8192, 0, 12900, 8192, -1600, -4600, 8192, 15200, 0];
  for (const v of yccFixed) r.s(v, 16);
  for (const off of [0, 1 << 27, 1 << 27]) r.u(off, 32);
  const lmsFixed = [16384, 0, 0, 0, 16384, 0, 0, 0, 16384];
  for (const v of lmsFixed) r.s(v, 16);
  r.u(65535, 16); // signal_eotf
  r.u(0, 16); // signal_eotf_param0
  r.u(0, 16); // signal_eotf_param1
  r.u(0, 32); // signal_eotf_param2
  r.u(12, 5); // signal_bit_depth
  r.u(1, 2); // signal_color_space
  r.u(0, 2); // signal_chroma_format
  r.u(1, 2); // signal_full_range_flag
  r.u(62, 12); // source_min_pq
  r.u(3079, 12); // source_max_pq (~1000 nits)
  r.u(42, 10); // source_diagonal
  const rpuNal = r.toBytesWithEpb();

  const ctx = createDoviRpuContext(5);
  const parsed = parseDolbyVisionRpu(rpuNal, ctx);
  assert.ok(parsed, 'Parsed HEVC NAL 62 RPU successfully');
  assert.equal(parsed.profile, 5);
  assert.equal(parsed.fullRange, true);
  assert.equal(parsed.mapping.curves[0].mappingIdc[0], 0);
  assert.equal(parsed.mapping.curves[2].mappingIdc[0], 1); // MMR
  assert.equal(parsed.color.sourceMinPq, 62);
  assert.equal(parsed.color.sourceMaxPq, 3079);
  assert.ok(Math.abs(parsed.color.yccToRgbMatrix[0] - 1.0) < 1e-4);

  // Wrap VCL slice (NAL 19 IDR) + NAL 63 (EL) + NAL 62 (RPU) into length-prefixed hvc1 packet
  const vclNal = new Uint8Array([19 << 1, 1, 0xaa, 0xbb, 0xcc]);
  const elNal = new Uint8Array([63 << 1, 1, 0x11, 0x22]);
  const buildLenPrefixed = nals => {
    const total = nals.reduce((acc, n) => acc + 4 + n.length, 0);
    const buf = new Uint8Array(total);
    const dv = new DataView(buf.buffer);
    let off = 0;
    for (const n of nals) {
      dv.setUint32(off, n.length, false);
      buf.set(n, off + 4);
      off += 4 + n.length;
    }
    return buf;
  };
  const combinedPkt = buildLenPrefixed([vclNal, elNal, rpuNal]);
  const inspected = inspectHevcPacket(combinedPkt, 4, createDoviRpuContext(7));
  assert.ok(inspected.rpu, 'Extracted RPU from NAL 62');
  assert.equal(inspected.packetData.byteLength, 4 + vclNal.length, 'Stripped both NAL 63 EL and NAL 62 RPU cleanly');

  // Verify BT.2390 tonemap uniform generation for DV-P5 -> SDR vs HDR10 -> HDR passthrough
  const uboSdr = computeTonemapUniforms({ hdr: true, hdrKind: 'dovi-p5', fullRange: true }, parsed, {
    targetHdr: false,
  });
  assert.equal(uboSdr.isDoviP5, true);
  assert.equal(uboSdr.applyBt2390, true);
  assert.equal(uboSdr.useDoviReshape, true);
  assert.equal(uboSdr.debandEnabled, true);
  assert.ok(uboSdr.srcPeakNits > 900 && uboSdr.srcPeakNits < 1100);

  const uboHdr = computeTonemapUniforms({ hdr: true, hdrKind: 'hdr10', maxCll: 1000 }, null, {
    targetHdr: true,
  });
  assert.equal(uboHdr.targetHdr, true);
  assert.equal(uboHdr.applyBt2390, false);
  assert.equal(uboHdr.debandEnabled, false);

  // Verify Chromium Issue 40944011 zero-clamp VideoFrame wrapper
  let constructedOpts = null;
  let closedWrapped = false;
  class FakeVideoFrame {
    constructor(src, opts) {
      constructedOpts = opts;
      this.colorSpace = opts?.colorSpace || src?.colorSpace;
    }
    close() {
      closedWrapped = true;
    }
  }
  const origVF = globalThis.VideoFrame;
  globalThis.VideoFrame = FakeVideoFrame;
  try {
    const gpuBackedHdrFrame = {
      timestamp: 1000,
      duration: 41666,
      format: 'NV12',
      colorSpace: { primaries: 'bt2020', transfer: 'pq', matrix: 'bt2020-ncl', fullRange: false },
    };
    const wrapped = wrapFramePreventingSdrClamp(gpuBackedHdrFrame, {
      hdr: true,
      hdrKind: 'hdr10',
      fullRange: false,
    });
    assert.equal(wrapped.owned, true);
    assert.equal(wrapped.inputMode, 'bt709-override');
    assert.deepEqual(constructedOpts.colorSpace, {
      primaries: 'bt709',
      transfer: 'srgb',
      matrix: 'bt709',
      fullRange: true,
    });
    wrapped.frame.close();
    assert.equal(closedWrapped, true);

    const planar10Frame = { format: 'I420P10', colorSpace: { transfer: 'pq' } };
    const directPlanar = wrapFramePreventingSdrClamp(planar10Frame, { hdr: true, hdrKind: 'hdr10' });
    assert.equal(directPlanar.owned, false);
    assert.equal(directPlanar.inputMode, 'planar10');
    assert.equal(directPlanar.frame, planar10Frame);

    // If the browser ignores colorSpace on VideoFrame(frame, init), fall back to passthrough
    let ignoredClosed = false;
    globalThis.VideoFrame = class IgnoredColorSpaceVideoFrame {
      constructor(src) {
        this.colorSpace = src.colorSpace;
      }
      close() {
        ignoredClosed = true;
      }
    };
    const ignored = wrapFramePreventingSdrClamp(gpuBackedHdrFrame, { hdr: true, hdrKind: 'hdr10', fullRange: false });
    assert.equal(ignored.owned, false);
    assert.equal(ignored.inputMode, 'passthrough');
    assert.equal(ignored.frame, gpuBackedHdrFrame);
    assert.equal(ignoredClosed, true);
  } finally {
    globalThis.VideoFrame = origVF;
  }
});

test('Watch client enforces operator ubuplayer=false, viewer opt-out, local reload safety, and codec-unsupported fallback', async () => {
  // 1. MediaSurface hides #video (hidden=true) and swaps fresh #ubuplayer-canvas without opacity hacks
  const origDoc = globalThis.document;
  globalThis.document = stubDocument();
  try {
    const videoEl = element('video');
    const stageEl = element('div');
    const initialCanvas = element('canvas');
    let replacedCanvas = null;
    initialCanvas.parentNode = {
      replaceChild(next) {
        replacedCanvas = next;
        next.parentNode = this;
      },
    };
    const surface = createMediaSurface({ video: videoEl, stage: stageEl, canvas: initialCanvas });
    assert.equal(surface.isUbuPlayer(), false);
    const fakeInstance = {
      destroyed: false,
      videoWidth: 3840,
      videoHeight: 2160,
      currentTime: 42,
      readyState: 4,
      paused: false,
      ended: false,
      seeking: false,
      playbackRate: 1,
      buffered: { length: 1, start: () => 0, end: () => 60 },
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 120, droppedVideoFrames: 1 }),
      addEventListener() {},
      removeEventListener() {},
      destroy() {
        this.destroyed = true;
      },
    };
    surface.attachUbuPlayer(() => fakeInstance);
    assert.equal(videoEl.hidden, true, '#video is genuinely hidden=true when UbuPlayer owns presentation');
    assert.ok(
      replacedCanvas && replacedCanvas !== initialCanvas,
      'Replaced canvas prior to transferControlToOffscreen',
    );
    assert.equal(replacedCanvas.hidden, false, 'Fresh #ubuplayer-canvas is visible');
    assert.equal(surface.isUbuPlayer(), true);
    assert.equal(surface.width(), 3840);
    assert.equal(surface.height(), 2160);
    surface.detachUbuPlayer();
    assert.equal(videoEl.hidden, false, '#video unhidden when UbuPlayer detaches');
    assert.equal(surface.isUbuPlayer(), false);
  } finally {
    globalThis.document = origDoc;
  }

  // 2. Operator config.ubuplayer = false hides #ubuplayer-settings, forces viewerPreferences ubuplayer=false, and spawns zero Workers
  const makeDocOverrides = () => {
    const byId = new Map();
    return {
      getElementById: id => {
        if (id.endsWith('-group')) return null;
        if (!byId.has(id)) {
          const el = element();
          el.options = [];
          el.isConnected = false;
          byId.set(id, el);
        }
        return byId.get(id);
      },
    };
  };
  let workerConstructed = 0;
  const prefMount = mountModule(preferencesMod, {
    config: { ubuplayer: false },
    document: makeDocOverrides(),
    subtitleLayout: () => {},
    VideoDecoder: function FakeVD() {},
    AudioWorkletNode: function FakeAW() {},
    OffscreenCanvas: function FakeOC() {},
    Worker: function ForbiddenWorker() {
      workerConstructed++;
    },
  });
  try {
    const prefs = prefMount.api.viewerPreferences();
    assert.equal(prefs.ubuplayer, false);
    assert.equal(prefs.gpuTonemap, false);
    assert.equal(prefs.clientRemux, false);
    assert.equal(prefMount.api.canUseUbuPlayer(), false);
    assert.equal(prefMount.view.document.getElementById('ubuplayer-settings').hidden, true);
    assert.equal(workerConstructed, 0);
  } finally {
    prefMount.restore();
  }

  // Viewer opt-out ('Use UbuPlayer' unchecked) when operator enables UbuPlayer
  const viewerOptOutMount = mountModule(preferencesMod, {
    config: { ubuplayer: true },
    document: makeDocOverrides(),
    localStorage: {
      getItem: key => (key === 'uburoom.player' ? JSON.stringify({ useUbuPlayer: false }) : null),
      setItem() {},
    },
    subtitleLayout: () => {},
    VideoDecoder: function FakeVD() {},
    AudioWorkletNode: function FakeAW() {},
    OffscreenCanvas: function FakeOC() {},
    Worker: function FakeW() {},
  });
  try {
    assert.equal(viewerOptOutMount.view.document.getElementById('ubuplayer-settings').hidden, false);
    assert.equal(viewerOptOutMount.api.canUseUbuPlayer(), false);
    assert.equal(viewerOptOutMount.api.viewerPreferences().ubuplayer, false);
  } finally {
    viewerOptOutMount.restore();
  }

  // 3. Reload while view.format === 'local' never assigns video.src = 'local://selected' and requests mode='auto'
  const executedCommands = [];
  const videoForRoom = element('video');
  videoForRoom.canPlayType = () => 'probably';
  const roomMount = mountModule(roomMod, {
    selected: 'room-1',
    config: { ubuplayer: true, localFormats: ['av1'], outputs: ['av1', 'provider'] },
    video: videoForRoom,
    canUseUbuPlayer: () => false,
    canGpuTonemap: () => false,
    execute: cmd => {
      executedCommands.push(cmd);
      return Promise.resolve({ status: 'applied' });
    },
    fallbackPlayback: { receive: s => s, reset() {}, tick() {} },
    sync: { transition() {}, synchronize() {}, reset() {}, sharedSeek() {} },
    diagnostics: { state() {}, record() {} },
    roomUI: { render() {} },
    stageCards: { register() {}, sync() {} },
    bufferingViewers: new Map(),
    suppressedBuffering: new Set(),
    queueUI: { render() {}, restorePosition() {} },
    playerUI: { settingsOpen: () => false, reset() {} },
    captions: { update() {}, reset() {} },
    videoCheck: {},
    toasts: { show() {}, dismiss() {} },
    expected: () => 0,
    clock: () => '0:00',
  });
  try {
    const mediaVersion = randomUUID();
    roomMount.api.applyState({
      id: 'room-1',
      roomName: 'Cinema',
      title: 'Test Film',
      mediaId: '101',
      mediaVersion,
      streamVersion: 's1',
      format: 'local',
      mediaUrl: 'local://selected',
      viewers: 1,
      state: { paused: true, position: 15, duration: 120, volume: 80, muted: false },
      tracks: { audio: [], subtitles: [] },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.notEqual(videoForRoom.src, 'local://selected', 'Never assigns local://selected to video.src');
    assert.ok(
      executedCommands.some(c => c.action === 'media.delivery.set' && c.args.mode === 'auto'),
      'Automatically resets stale local delivery back to room stream on reload',
    );
  } finally {
    roomMount.restore();
  }

  // 4. uburoomSubtitles paints active text cues from surface clock even when #video is hidden at currentTime=0
  const origVtt = global.VTTCue;
  global.VTTCue = class FakeCue {
    constructor(startTime, endTime, text) {
      this.startTime = startTime;
      this.endTime = endTime;
      this.text = text;
    }
  };
  try {
    const cueList = [];
    const hiddenVideo = {
      hidden: true,
      currentTime: 0,
      addTextTrack: () => ({
        mode: 'disabled',
        cues: cueList,
        activeCues: [], // Empty because hidden <video> is not playing!
        addCue: c => cueList.push(c),
        removeCue: c => {
          const i = cueList.indexOf(c);
          if (i >= 0) cueList.splice(i, 1);
        },
        addEventListener() {},
      }),
      textTracks: { addEventListener() {} },
    };
    let ubuTime = 6.0;
    const timeListeners = [];
    const fakeSurface = {
      isMediaSurface: true,
      videoElement: hiddenVideo,
      stageElement: () => null,
      isUbuPlayer: () => true,
      width: () => 1920,
      height: () => 1080,
      currentTime: () => ubuTime,
      addEventListener: (type, fn) => {
        if (type === 'timeupdate') timeListeners.push(fn);
      },
      removeEventListener() {},
    };
    const subs = new uburoomSubtitles(fakeSurface, () => {});
    const renderedBoxes = [[], []];
    subs.layer = {};
    subs.topCues = { replaceChildren: (...nodes) => (renderedBoxes[0] = nodes) };
    subs.bottomCues = { replaceChildren: (...nodes) => (renderedBoxes[1] = nodes) };
    const prevDoc = global.document;
    global.document = {
      createElement: () => ({ className: '', append() {}, childNodes: [], appendChild() {} }),
      createTextNode: t => ({ textContent: t }),
    };
    try {
      await subs.setLocalSubtitle({
        key: 'local-sub-1',
        format: 'cues',
        cues: [
          { start: 1, end: 3, text: 'First line' },
          { start: 5, end: 9, text: 'Active on UbuPlayer' },
        ],
      });
      assert.equal(
        renderedBoxes[1].length,
        1,
        'Rendered active cue at UbuPlayer clock t=6.0s despite empty video.activeCues',
      );
      ubuTime = 10.0;
      for (const fn of timeListeners) fn();
      assert.equal(renderedBoxes[1].length, 0, 'Cleared cue once UbuPlayer clock passed cue end');
    } finally {
      global.document = prevDoc;
    }
  } finally {
    global.VTTCue = origVtt;
  }
});

test('Server planDelivery and watch compatibleFallback honor ubuplayerAllowed=false and codec-unsupported preferHLS', async () => {
  const { planDelivery } = require('../server/delivery-plan.js');
  const deliveryMod = require('../web/watch/delivery.js');

  // 1. Server planDelivery ignores client ubuplayer/gpuTonemap claims when operator sets ubuplayerAllowed=false
  const allowedPlan = planDelivery({
    quality: 'direct',
    audioTracks: 2,
    ubuplayer: true,
    gpuTonemap: true,
    ubuplayerAllowed: true,
    hdr: true,
    hdrKind: 'dovi-p5',
    hdrDisplay: false,
    outputs: ['av1', 'provider'],
  });
  assert.deepEqual(allowedPlan, { route: 'file', reason: 'original' });

  const disabledPlan = planDelivery({
    quality: 'direct',
    audioTracks: 2,
    ubuplayer: true,
    gpuTonemap: true,
    ubuplayerAllowed: false,
    hdr: true,
    hdrKind: 'dovi-p5',
    hdrDisplay: false,
    outputs: ['av1', 'provider'],
  });
  assert.deepEqual(disabledPlan, { route: 'local', codec: 'av1', reason: 'compatible' });

  // 2. compatibleFallback skips 'audio' copy-video remux when error.kind === 'codec-unsupported' (preferHLS=false),
  //    and selects 'audio' copy-video remux when error.kind !== 'codec-unsupported' (preferHLS=true)
  const runFallback = async preferHLS => {
    const calls = [];
    const videoEl = element('video');
    videoEl.canPlayType = () => 'probably';
    const mount = mountModule(deliveryMod, {
      selected: 'room-1',
      config: { ubuplayer: true, copyVideo: true, localFormats: ['av1'], outputs: ['av1', 'provider'] },
      state: {
        id: 'room-1',
        mediaId: '42',
        mediaVersion: randomUUID(),
        streamVersion: 's1',
        format: 'file',
        container: 'mkv',
        videoCodec: 'h264',
        bitDepth: 8,
        quality: 'direct',
        mediaUrl: '/media/42',
      },
      video: videoEl,
      MediaSource: { isTypeSupported: () => true },
      surface: { detachUbuPlayer() {} },
      stopHls() {},
      diagnosticSample() {},
      diagnostics: { record() {} },
      toasts: { show() {} },
      fail() {},
      execute: cmd => {
        calls.push(cmd);
        return Promise.resolve({ status: 'applied' });
      },
    });
    try {
      await mount.api.compatibleFallback('UbuPlayer failed.', preferHLS);
      return calls[0];
    } finally {
      mount.restore();
    }
  };

  // Non-codec error (error?.kind !== 'codec-unsupported' -> preferHLS = true): uses lightweight 'audio' video-copy remux
  const nonCodecFallback = await runFallback(true);
  assert.equal(nonCodecFallback.args.fallback, 'audio');
  assert.equal(nonCodecFallback.args.ubuplayer, false);
  assert.equal(nonCodecFallback.args.gpuTonemap, false);

  // Codec-unsupported error (error?.kind === 'codec-unsupported' -> preferHLS = false): transcodes video ('av1') instead of copying video
  const codecUnsupportedFallback = await runFallback(false);
  assert.equal(codecUnsupportedFallback.args.fallback, 'av1');
  assert.equal(codecUnsupportedFallback.args.compatible, true);
  assert.equal(codecUnsupportedFallback.args.ubuplayer, false);
});

test('Second-pass regressions: 44.1/96 kHz WSOLA, 3rd-order MMR + WebGPU 2320B UBO + WebGL2 RGBA16F, and autoplay NotAllowedError', async () => {
  const workletMod = await import(pathToFileURL(path.join(__dirname, '../web/ubuplayer-worklet.js')).href);
  const gpuMod = await import(pathToFileURL(path.join(__dirname, '../web/ubuplayer-gpu.js')).href);
  const ubuMod = await import(pathToFileURL(path.join(__dirname, '../web/ubuplayer.js')).href);

  // 1. Verify WSOLA pitch preservation and media clock accuracy at 44100 Hz and 96000 Hz hardware AudioContexts
  for (const sr of [44100, 96000]) {
    const core = new workletMod.UbuPlayerAudioCore({ sampleRate: sr });
    assert.equal(core.wsolaHop, Math.round(sr * 0.01));
    assert.equal(core.wsolaWindow, core.wsolaHop * 2);
    const twoSec = sr * 2;
    const tone = new Float32Array(twoSec);
    for (let i = 0; i < twoSec; i++) tone[i] = 0.75 * Math.sin((2 * Math.PI * 440 * i) / sr);
    core.reset(0, { seekGen: 1, audioGen: 1 });
    core.push(tone, tone, 0);
    core.setRate(1.03);
    core.playing = true;

    const rendered = new Float32Array(sr);
    const qL = new Float32Array(128);
    const qR = new Float32Array(128);
    for (let off = 0; off < rendered.length; off += 128) {
      const n = Math.min(128, rendered.length - off);
      core.render(qL.subarray(0, n), qR.subarray(0, n));
      rendered.set(qL.subarray(0, n), off);
    }
    assert.ok(Math.abs(core.currentMediaSample - sr * 1.03) < sr * 0.03);
    let crossings = 0;
    for (let i = Math.floor(sr * 0.1) + 1; i < Math.floor(sr * 0.9); i++) {
      if (rendered[i - 1] <= 0 && rendered[i] > 0) crossings++;
    }
    const hz = crossings / 0.8;
    assert.ok(Math.abs(hz - 440) < 6, `Expected ~440 Hz at ${sr} Hz, got ${hz}`);
  }

  // 2. Verify RPU linear_interp_flag=1 + 3rd-order MMR (all 21 coeffs) + WebGPU 2320-byte UBO + WebGL2 RGBA16F upload
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
  b.u(0, 1); // dm_metadata_present = 0
  b.u(0, 1); // use_prev_vdr_rpu_flag = 0
  b.ue(0);
  b.ue(1);
  b.ue(0);
  for (let c = 0; c < 3; c++) {
    b.ue(0);
    b.u(0, 10);
    b.u(1023, 10);
  }
  b.ue(0);
  b.ue(0);
  // Component 0: poly order 1 with linear_interp_flag = 1 (x0 = 0, x1 = 1)
  b.ue(0);
  b.ue(0);
  b.u(1, 1); // linear_interp_flag = 1
  b.se(0);
  b.u(0, 23); // x0 = 0.0
  b.se(1);
  b.u(0, 23); // x1 = 1.0
  // Component 1: poly order 1
  b.ue(0);
  b.ue(0);
  b.u(0, 1);
  b.se(0);
  b.u(0, 23);
  b.se(1);
  b.u(0, 23);
  // Component 2: MMR order 3 (21 coefficients, setting coeff[20] = 2.0)
  b.ue(1);
  b.u(2, 2); // mmr_order_minus1 = 2 -> order 3!
  b.se(0);
  b.u(0, 23);
  for (let k = 0; k < 21; k++) {
    b.se(k === 20 ? 2 : k === 13 ? 1 : 0);
    b.u(0, 23);
  }
  const rpuOrder3 = gpuMod.parseDolbyVisionRpu(b.toBytesWithEpb(), gpuMod.createDoviRpuContext(5));
  assert.ok(rpuOrder3);
  assert.ok(Math.abs(rpuOrder3.mapping.curves[0].polyCoeffs[0][1] - 1.0) < 1e-5, 'linear_interp slope = 1.0');
  assert.equal(rpuOrder3.mapping.curves[2].mmrOrder[0], 3);
  assert.equal(rpuOrder3.mapping.curves[2].mmrCoeffs[0][20], 2);

  const ubo3 = gpuMod.computeTonemapUniforms({ hdr: true, hdrKind: 'dovi-p5' }, rpuOrder3, { targetHdr: false });
  // Channel 2 -> chroma index 1, piece 0 -> base = (1 * 8 + 0) * 24 = 192; coeff[20] at 192 + 20 = 212
  assert.equal(ubo3.mmrFlat.length, 384, '96 vec4s = 384 floats');
  assert.equal(ubo3.mmrFlat[192 + 13], 1);
  assert.equal(ubo3.mmrFlat[192 + 20], 2);

  // Check WebGPU uniform buffer size == 2320 bytes (145 vec4s) & WebGL2 RGBA16F upload
  let allocatedUboSize = 0;
  let lastWrittenUbo = null;
  const origNav = globalThis.navigator;
  const origGpuBufUsage = globalThis.GPUBufferUsage;
  const origGpuTexUsage = globalThis.GPUTextureUsage;
  const origVF = globalThis.VideoFrame;
  globalThis.GPUBufferUsage = { UNIFORM: 0x40, COPY_DST: 0x08 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 0x04, COPY_DST: 0x02, RENDER_ATTACHMENT: 0x10 };
  globalThis.VideoFrame = class FakeVF {
    constructor(src, opts) {
      this.src = src;
      this.opts = opts;
      this.colorSpace = opts?.colorSpace || src?.colorSpace;
      this.displayWidth = src.displayWidth;
      this.displayHeight = src.displayHeight;
    }
    close() {}
  };
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      gpu: {
        getPreferredCanvasFormat: () => 'bgra8unorm',
        requestAdapter: async () => ({
          requestDevice: async () => ({
            createShaderModule: ({ code }) => ({ code }),
            createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
            createBuffer: ({ size }) => {
              allocatedUboSize = size;
              return { destroy() {} };
            },
            createSampler: () => ({}),
            createTexture: () => ({ createView: () => ({}), destroy() {} }),
            createBindGroup: () => ({}),
            createCommandEncoder: () => ({
              beginRenderPass: () => ({ setPipeline() {}, setBindGroup() {}, draw() {}, end() {} }),
              finish: () => ({}),
            }),
            queue: {
              copyExternalImageToTexture() {},
              writeBuffer: (_buf, _off, data) => {
                lastWrittenUbo = new Float32Array(data.slice(0));
              },
              submit() {},
            },
            destroy() {},
          }),
        }),
      },
    },
  });
  try {
    const fakeWebGpuCanvas = {
      width: 1920,
      height: 1080,
      getContext: kind =>
        kind === 'webgpu'
          ? {
              configure() {},
              unconfigure() {},
              getCurrentTexture: () => ({ createView: () => ({}) }),
            }
          : null,
    };
    const gpuRenderer = await gpuMod.createOffscreenRenderer(fakeWebGpuCanvas, { preferWebGpu: true });
    assert.equal(gpuRenderer.backend, 'webgpu');
    assert.equal(allocatedUboSize, 145 * 16, 'WebGPU UBO matches exact 145 vec4s (2320 bytes)');
    await gpuRenderer.renderFrame(
      { displayWidth: 1920, displayHeight: 1080, format: 'NV12', timestamp: 0 },
      { hdr: true, hdrKind: 'dovi-p5' },
      rpuOrder3,
      false,
    );
    assert.equal(lastWrittenUbo[196 + 192 + 20], 2, '3rd-order MMR coeff[20] written to WebGPU UBO');
    gpuRenderer.destroy();

    // Verify WebGL2 RGBA16F upload and non-desynchronized context attributes
    let gl2Attrs = null;
    let uploadedInternalFormat = null;
    const fakeWebGl2Canvas = {
      width: 1920,
      height: 1080,
      getContext: (kind, attrs) => {
        if (kind !== 'webgl2') return null;
        gl2Attrs = attrs;
        return {
          NO_ERROR: 0,
          VERTEX_SHADER: 1,
          FRAGMENT_SHADER: 2,
          COMPILE_STATUS: 3,
          LINK_STATUS: 4,
          TEXTURE0: 10,
          TEXTURE_2D: 20,
          TEXTURE_WRAP_S: 21,
          TEXTURE_WRAP_T: 22,
          TEXTURE_MIN_FILTER: 23,
          TEXTURE_MAG_FILTER: 24,
          CLAMP_TO_EDGE: 25,
          NEAREST: 26,
          LINEAR: 27,
          R16UI: 28,
          RED_INTEGER: 29,
          UNSIGNED_SHORT: 30,
          RGBA: 31,
          RGBA16F: 32,
          HALF_FLOAT: 33,
          UNSIGNED_BYTE: 34,
          UNPACK_FLIP_Y_WEBGL: 35,
          TRIANGLES: 36,
          createShader: () => ({}),
          shaderSource() {},
          compileShader() {},
          getShaderParameter: () => true,
          deleteShader() {},
          createProgram: () => ({}),
          attachShader() {},
          linkProgram() {},
          getProgramParameter: () => true,
          createVertexArray: () => ({}),
          activeTexture() {},
          createTexture: () => ({}),
          bindTexture() {},
          texParameteri() {},
          texImage2D: (_target, _level, internalFmt) => {
            if (internalFmt === 32 || internalFmt === 31) uploadedInternalFormat = internalFmt;
          },
          getError: () => 0,
          useProgram() {},
          getUniformLocation: () => ({}),
          uniform1i() {},
          uniform2f() {},
          uniform4f() {},
          uniform3fv() {},
          uniform3iv() {},
          uniform1fv() {},
          uniform4fv() {},
          uniformMatrix3fv() {},
          pixelStorei() {},
          viewport() {},
          bindVertexArray() {},
          drawArrays() {},
          deleteTexture() {},
          deleteVertexArray() {},
          deleteProgram() {},
        };
      },
    };
    const gl2Renderer = await gpuMod.createOffscreenRenderer(fakeWebGl2Canvas, { preferWebGpu: false });
    assert.equal(gl2Renderer.backend, 'webgl2');
    assert.equal(
      gl2Attrs.desynchronized,
      undefined,
      'WebGL2 avoids desynchronized: true so DOM subtitles composite cleanly',
    );
    await gl2Renderer.renderFrame(
      { displayWidth: 1920, displayHeight: 1080, format: 'NV12', timestamp: 0 },
      { hdr: true, hdrKind: 'hdr10', fullRange: false },
      null,
      false,
    );
    assert.equal(uploadedInternalFormat, 32, 'Uploaded HDR bt709-override VideoFrame at RGBA16F precision');
    gl2Renderer.destroy();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: origNav });
    globalThis.GPUBufferUsage = origGpuBufUsage;
    globalThis.GPUTextureUsage = origGpuTexUsage;
    globalThis.VideoFrame = origVF;
  }

  // 3. Verify UbuPlayer.play() throws immediate NotAllowedError on suspended unmuted AudioContext,
  //    allows muted autoplay on wall-clock, and re-anchors audio on unmute!
  const prevNav = globalThis.navigator;
  const prevWorker = globalThis.Worker;
  const workerMsgs = [];
  globalThis.Worker = class StubWorker {
    postMessage(msg) {
      workerMsgs.push(msg);
    }
    terminate() {}
  };
  try {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userActivation: { hasBeenActive: false } },
    });
    const suspendedCtx = {
      state: 'suspended',
      sampleRate: 48000,
      currentTime: 0,
      resume: () => new Promise(() => {}), // Simulates Chromium hanging resume() without gesture
    };
    const dummyBlob = new Blob([new Uint8Array(64)]);
    const player = new ubuMod.UbuPlayer(
      null,
      { file: dummyBlob },
      () => 5.0,
      () => {},
      { audioContext: suspendedCtx, muted: false, audioId: 'a1' },
    );
    await new Promise(r => setTimeout(r, 20));
    player.hasAudioTrack = true;
    await assert.rejects(
      () => player.play(),
      err => err?.name === 'NotAllowedError',
      'Unmuted play() without userActivation immediately rejects with NotAllowedError',
    );
    assert.equal(player.paused, true);

    // Muted autoplay succeeds immediately and advances currentTime via wall clock!
    player.setAudio(0.8, true);
    await player.play();
    assert.equal(player.paused, false);
    await new Promise(r => setTimeout(r, 60));
    assert.ok(player.currentTime > 5.03, 'Muted autoplay advances currentTime while AudioContext is suspended');

    // User clicks Unmute: AudioContext transitions to running and resyncs audio to live playhead!
    suspendedCtx.resume = async () => {
      suspendedCtx.state = 'running';
    };
    workerMsgs.length = 0;
    player.setAudio(0.8, false);
    await new Promise(r => setTimeout(r, 20));
    const resyncMsg = workerMsgs.find(m => m.type === 'selectAudio');
    assert.ok(resyncMsg && resyncMsg.time > 5.03, 'Unmuting after muted autoplay re-anchors audio to live playhead');
    player.destroy();
  } finally {
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: prevNav });
    globalThis.Worker = prevWorker;
  }
});
