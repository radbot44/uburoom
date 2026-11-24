'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { pathToFileURL } = require('node:url');

let hasFfmpeg = false;
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
  hasFfmpeg = true;
} catch {}

describeWasmSuite();

function createMockWebCodecs() {
  const stats = {
    configureCount: 0,
    resetCount: 0,
    closeCount: 0,
    configs: [],
    chunks: [],
  };
  class MockEncodedVideoChunk {
    constructor(init) {
      this.type = init.type;
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      this.byteLength = init.data.byteLength;
    }
  }
  class MockVideoDecoder {
    static async isConfigSupported(config) {
      return { supported: true, config };
    }
    constructor(init) {
      this._output = init.output;
      this._error = init.error;
      this.state = 'unconfigured';
      this.decodeQueueSize = 0;
    }
    configure(config) {
      stats.configureCount++;
      stats.configs.push(config);
      this.state = 'configured';
    }
    decode(chunk) {
      stats.chunks.push(chunk);
      const width = stats.configs.at(-1)?.codedWidth || 320;
      const height = stats.configs.at(-1)?.codedHeight || 180;
      const frame = {
        timestamp: chunk.timestamp,
        duration: chunk.duration,
        displayWidth: width,
        displayHeight: height,
        codedWidth: width,
        codedHeight: height,
        format: 'I420',
        colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false },
        close() {},
      };
      queueMicrotask(() => {
        if (this.state === 'configured') this._output(frame);
      });
    }
    async flush() {}
    reset() {
      stats.resetCount++;
    }
    close() {
      stats.closeCount++;
      this.state = 'closed';
    }
  }
  return { stats, VideoDecoder: MockVideoDecoder, EncodedVideoChunk: MockEncodedVideoChunk };
}

function describeWasmSuite() {
  if (!hasFfmpeg) return;
  let tmpDir;
  let createWorkerEngine;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-ubuplayer-test-'));
    const workerMod = await import(pathToFileURL(path.join(__dirname, '../../web/ubuplayer-worker.js')).href);
    createWorkerEngine = workerMod.createWorkerEngine;

    const fontPath = path.join(tmpDir, 'DummyFont.ttf');
    fs.writeFileSync(fontPath, Buffer.alloc(256, 0x42));
    const assPath = path.join(tmpDir, 'subs.ass');
    fs.writeFileSync(
      assPath,
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 320',
        'PlayResY: 180',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,10,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.20,0:00:02.50,Default,,0,0,0,,Hello from embedded MKV ASS!',
        '',
      ].join('\n'),
    );

    // 1. Dual-audio MKV: H.264 + DTS 5.1 + AC-3 Stereo + ASS + TTF attachment
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=24:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=880:sample_rate=48000:duration=3',
      '-i',
      assPath,
      '-attach',
      fontPath,
      '-metadata:s:t:0',
      'mimetype=application/x-truetype-font',
      '-metadata:s:t:0',
      'filename=DummyFont.ttf',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-map',
      '2:a:0',
      '-map',
      '3:s:0',
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p',
      '-g',
      '24',
      '-c:a:0',
      'dca',
      '-strict',
      '-2',
      '-ac:a:0',
      '6',
      '-b:a:0',
      '768k',
      '-c:a:1',
      'ac3',
      '-ac:a:1',
      '2',
      '-b:a:1',
      '192k',
      '-metadata:s:a:1',
      'language=jpn',
      '-c:s:0',
      'ass',
      path.join(tmpDir, 'dts_dual.mkv'),
    ]);

    // 2. HEVC 10-bit HDR10 (SMPTE ST 2084 + MasteringDisplay/ContentLight SEI) + TrueHD + E-AC-3 5.1 MKV
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=160x90:rate=24:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=523:sample_rate=48000:duration=4',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-map',
      '1:a:0',
      '-c:v',
      'libx265',
      '-threads',
      '1',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p10le',
      '-x265-params',
      'keyint=24:min-keyint=24:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400:log-level=error',
      '-c:a:0',
      'truehd',
      '-strict',
      '-2',
      '-ac:a:0',
      '2',
      '-c:a:1',
      'eac3',
      '-ac:a:1',
      '6',
      '-b:a:1',
      '384k',
      path.join(tmpDir, 'hevc_hdr10_truehd.mkv'),
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test(
    'ubuplayer-worker demuxes MKV compressed packets + direct Float32 PCM and switches audio/subtitles without resetting VideoDecoder',
    { timeout: 20000 },
    async () => {
      const fileBuf = fs.readFileSync(path.join(tmpDir, 'dts_dual.mkv'));
      const mockWC = createMockWebCodecs();
      const pcmBatches = [];
      const subEvents = [];
      let readyMsg = null;
      let switchedMsg = null;

      await new Promise((resolve, reject) => {
        const engine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'error') {
            void engine.cleanup().then(() => reject(new Error(msg.message)));
          } else if (msg.type === 'ready') {
            readyMsg = msg;
            engine.onMessage({ type: 'selectSubtitle', subGen: 1, subtitleId: msg.subtitleTracks[0].id, time: 0 });
          } else if (msg.type === 'subtitleInit' || msg.type === 'subtitleData') {
            subEvents.push(msg);
          } else if (msg.type === 'audioPcm') {
            pcmBatches.push(msg);
            if (msg.audioGen === 0 && msg.eof && !switchedMsg) {
              // Switch live to Track 2 (Japanese AC-3) mid-session without seeking video!
              engine.onMessage({
                type: 'selectAudio',
                audioGen: 2,
                audioId: readyMsg.audioTracks[1].id,
                time: 1.0,
                aheadSeconds: 10,
              });
            } else if (msg.audioGen === 2 && msg.samples > 0) {
              void engine.cleanup().then(resolve);
            }
          } else if (msg.type === 'audioSwitched') {
            switchedMsg = msg;
          }
        }, mockWC);

        const initial = new Uint8Array(fileBuf.subarray(0, Math.min(fileBuf.length, 65536)));
        engine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          aheadSeconds: 30,
          initialBytes: initial.buffer,
        });
      });

      assert.ok(readyMsg, 'Worker emitted ready metadata');
      assert.match(readyMsg.video.webCodecsCodec, /^avc1\./);
      assert.equal(readyMsg.audioTracks.length, 2, 'Detected both DTS 5.1 and AC-3 2.0 audio tracks');
      assert.equal(readyMsg.audioTracks[0].codec, 'dts');
      assert.equal(readyMsg.audioTracks[1].codec, 'ac3');
      assert.equal(readyMsg.subtitleTracks.length, 1);

      // Verify VideoDecoder was configured ONCE and NEVER reset during selectSubtitle or selectAudio!
      assert.equal(mockWC.stats.configureCount, 1, 'VideoDecoder configured once');
      assert.equal(mockWC.stats.resetCount, 0, 'selectAudio and selectSubtitle never reset VideoDecoder');
      assert.equal(mockWC.stats.chunks.length, 72, 'All 72 compressed H.264 packets fed directly to VideoDecoder');

      // Verify direct Float32 stereo PCM output for DTS 5.1 and switched AC-3
      const gen0Samples = pcmBatches.filter(b => b.audioGen === 0).reduce((acc, b) => acc + b.samples, 0);
      assert.ok(gen0Samples > 48000 * 2.5, 'Decoded >2.5s of 48 kHz Float32 PCM from DTS 5.1');
      assert.equal(switchedMsg?.selectedAudioId, readyMsg.audioTracks[1].id);
      assert.ok(
        pcmBatches.some(b => b.audioGen === 2 && b.samples > 0),
        'Decoded switched AC-3 audio to Float32 PCM',
      );

      // Verify embedded ASS subtitle header, MKV TTF font attachment, and Dialogue packet extraction
      const subInit = subEvents.find(e => e.type === 'subtitleInit');
      assert.ok(subInit, 'Emitted ASS subtitleInit');
      assert.equal(subInit.fonts.length, 1, 'Extracted MKV TTF font attachment');
      assert.equal(subInit.fonts[0].byteLength, 256);
      assert.ok(
        subEvents.some(e => e.type === 'subtitleData'),
        'Streamed ASS Dialogue packet data',
      );
    },
  );

  test(
    'ubuplayer-worker detects 10-bit HEVC HDR10 metadata, decodes TrueHD 5.1 to Float32 PCM, and aligns mid-stream seek',
    { timeout: 20000 },
    async () => {
      const fileBuf = fs.readFileSync(path.join(tmpDir, 'hevc_hdr10_truehd.mkv'));
      const mockWC = createMockWebCodecs();
      let readyMsg = null;
      const pcmBatches = [];
      const presentedFrames = [];
      let audioDone = false;

      await new Promise((resolve, reject) => {
        const maybeDone = engine => {
          if (audioDone && presentedFrames.length > 0) {
            void engine.cleanup().then(resolve);
          }
        };
        const engine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'ready') {
            readyMsg = msg;
          } else if (msg.type === 'framePresented') {
            presentedFrames.push(msg);
            maybeDone(engine);
          } else if (msg.type === 'audioPcm') {
            pcmBatches.push(msg);
            if (msg.eof) {
              audioDone = true;
              maybeDone(engine);
            }
          } else if (msg.type === 'error') {
            void engine.cleanup().then(() => reject(new Error(msg.message)));
          }
        }, mockWC);

        engine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          startTime: 2.0,
          aheadSeconds: 10,
        });
      });

      assert.match(readyMsg.video.webCodecsCodec, /^hev1\.|^hvc1\./, 'Built WebCodecs HEVC codec string');
      assert.equal(readyMsg.video.bitDepth, 10);
      assert.equal(readyMsg.video.hdr, true);
      assert.equal(readyMsg.video.hdrKind, 'hdr10');
      assert.equal(readyMsg.video.maxCll, 1000);
      assert.equal(readyMsg.video.maxFall, 400);
      assert.equal(readyMsg.audioTracks.length, 2, 'Detected both TrueHD and E-AC-3 5.1 audio tracks');
      assert.equal(readyMsg.audioTracks[0].codec, 'truehd');
      assert.equal(readyMsg.audioTracks[1].codec, 'eac3');

      assert.ok(mockWC.stats.chunks.length > 0, 'Fed seeked HEVC chunks to VideoDecoder');
      assert.equal(mockWC.stats.chunks[0].type, 'key', 'First fed HEVC chunk after seek is a keyframe');
      const firstVideoSec = mockWC.stats.chunks[0].timestamp / 1_000_000;
      assert.ok(firstVideoSec <= 2.05, `VideoDecoder starts at preceding GOP keyframe <= 2.0s (got ${firstVideoSec}s)`);
      assert.ok(presentedFrames.length > 0, 'Presented target video frame after discarding GOP pre-roll');
      assert.ok(
        Math.abs(presentedFrames[0].mediaTime - 2.0) < 0.1,
        `First presented frame after paused seek is at ~2.0s (got ${presentedFrames[0].mediaTime}s)`,
      );

      const firstAudio = pcmBatches.find(b => b.samples > 0);
      assert.ok(firstAudio, 'Decoded TrueHD audio to Float32 PCM');
      const firstAudioSec = firstAudio.startSample / firstAudio.sampleRate;
      assert.ok(
        Math.abs(firstAudioSec - 2.0) < 0.05,
        `Seeked TrueHD PCM starts sample-accurately at 2.0s (got ${firstAudioSec}s)`,
      );
    },
  );

  test(
    'ubuplayer-worker preserves B-frame pyramid presentation timestamps without synthetic DTS clamping and boosts discrete 5.1 center channel in dialogue mode',
    { timeout: 20000 },
    async () => {
      const bframeMkv = path.join(tmpDir, 'bframes_51.mkv');
      execFileSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=160x90:rate=24:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=500:sample_rate=48000:duration=2',
        '-filter_complex',
        '[1:a]pan=5.1|FC=c0[aout]',
        '-map',
        '0:v:0',
        '-map',
        '[aout]',
        '-c:v',
        'libx264',
        '-threads',
        '1',
        '-preset',
        'fast',
        '-pix_fmt',
        'yuv420p',
        '-bf',
        '4',
        '-b_strategy',
        '0',
        '-x264-params',
        'b-pyramid=normal:keyint=24:min-keyint=24:log-level=error',
        '-c:a',
        'dca',
        '-strict',
        '-2',
        '-b:a',
        '768k',
        bframeMkv,
      ]);

      const fileBuf = fs.readFileSync(bframeMkv);
      const runMode = async mode => {
        const mockWC = createMockWebCodecs();
        const leftChunks = [];
        let readyMsg = null;
        await new Promise((resolve, reject) => {
          const engine = createWorkerEngine(msg => {
            if (msg.type === 'read') {
              const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
              setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
            } else if (msg.type === 'ready') {
              readyMsg = msg;
            } else if (msg.type === 'audioPcm') {
              if (msg.left?.length) leftChunks.push(new Float32Array(msg.left));
              if (msg.eof) void engine.cleanup().then(resolve);
            } else if (msg.type === 'error') {
              void engine.cleanup().then(() => reject(new Error(msg.message)));
            }
          }, mockWC);
          engine.onMessage({
            type: 'init',
            fileSize: fileBuf.length,
            audioMode: mode,
            aheadSeconds: 10,
          });
        });
        let sumSq = 0;
        let count = 0;
        for (const arr of leftChunks) {
          for (let i = 0; i < arr.length; i++) {
            sumSq += arr[i] * arr[i];
            count++;
          }
        }
        return {
          readyMsg,
          chunks: mockWC.stats.chunks,
          rms: Math.sqrt(sumSq / Math.max(1, count)),
        };
      };

      // Run both concurrently to ALSO prove blockReadHandlers device-name isolation across concurrent sessions!
      const [normal, dialogue] = await Promise.all([runMode('normal'), runMode('dialogue')]);
      assert.equal(normal.readyMsg.surroundDialogueActive, false);
      assert.equal(dialogue.readyMsg.surroundDialogueActive, true);

      assert.equal(normal.chunks.length, 48, 'All 48 B-frame pyramid packets fed to VideoDecoder');
      const uniquePtsMs = new Set(normal.chunks.map(c => Math.round(c.timestamp / 1000)));
      assert.equal(uniquePtsMs.size, 48, 'Every B-frame pyramid packet kept its distinct presentation timestamp');

      assert.ok(
        dialogue.rms > normal.rms * 1.4,
        `Expected dialogue mode (${dialogue.rms.toFixed(4)}) to boost discrete 5.1 Center channel over normal (${normal.rms.toFixed(4)})`,
      );
    },
  );
}
