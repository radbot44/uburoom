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

function describeWasmSuite() {
  if (!hasFfmpeg) return;
  let tmpDir;
  let createWorkerEngine;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-libav-test-'));
    const workerMod = await import(pathToFileURL(path.join(__dirname, '../../web/watch-file-worker.js')).href);
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
      'testsrc2=size=320x180:rate=24:duration=3',
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

    // 2. HEVC 10-bit + TrueHD 5.1 MKV
    execFileSync('ffmpeg', [
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=24:duration=4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=523:sample_rate=48000:duration=4',
      '-c:v',
      'libx265',
      '-preset',
      'ultrafast',
      '-pix_fmt',
      'yuv420p10le',
      '-x265-params',
      'keyint=24:min-keyint=24:log-level=error',
      '-c:a',
      'truehd',
      '-strict',
      '-2',
      '-ac',
      '6',
      path.join(tmpDir, 'hevc_truehd.mkv'),
    ]);
  });

  after(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test(
    'watch-file-worker demuxes MKV DTS 5.1 + ASS + font attachment, switches audio tracks, and outputs valid fMP4',
    { timeout: 15000 },
    async () => {
      const fileBuf = fs.readFileSync(path.join(tmpDir, 'dts_dual.mkv'));
      const vParts = [];
      const aParts = [];
      const subEvents = [];
      let readyMsg = null;

      let doneResolve, doneReject;
      const donePromise = new Promise((res, rej) => {
        doneResolve = res;
        doneReject = rej;
      });

      const engine = createWorkerEngine(msg => {
        if (msg.type === 'read') {
          const slice = fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end));
          const copy = new Uint8Array(slice);
          setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
        } else if (msg.type === 'error') {
          doneReject(new Error(msg.message));
        } else if (msg.type === 'ready') {
          readyMsg = msg;
          if (msg.videoInit?.byteLength) vParts.push(Buffer.from(msg.videoInit));
          if (msg.audioInit?.byteLength) aParts.push(Buffer.from(msg.audioInit));
          engine.onMessage({ type: 'selectSubtitle', subGen: 1, subtitleId: msg.subtitleTracks[0].id });
        } else if (msg.type === 'subtitleInit' || msg.type === 'subtitleData') {
          subEvents.push(msg);
        } else if (msg.type === 'segment') {
          if (msg.videoBytes?.byteLength) vParts.push(Buffer.from(msg.videoBytes));
          if (msg.audioBytes?.byteLength) aParts.push(Buffer.from(msg.audioBytes));
          if (msg.eof) doneResolve();
        }
      });

      const initial = new Uint8Array(fileBuf.subarray(0, Math.min(fileBuf.length, 65536)));
      engine.onMessage({
        type: 'init',
        fileSize: fileBuf.length,
        flacSupported: true,
        aheadSeconds: 30,
        initialBytes: initial.buffer,
      });

      await donePromise;
      assert.ok(readyMsg, 'Worker emitted ready metadata');
      assert.match(readyMsg.video.mime, /^video\/mp4; codecs="avc1\./);
      assert.equal(readyMsg.audioTracks.length, 2, 'Detected both DTS 5.1 and AC-3 2.0 audio tracks');
      assert.equal(readyMsg.audioTracks[0].codec, 'dts');
      assert.equal(readyMsg.audioTracks[1].codec, 'ac3');
      assert.equal(readyMsg.subtitleTracks.length, 1);

      const subInit = subEvents.find(e => e.type === 'subtitleInit');
      assert.ok(subInit, 'Emitted ASS subtitleInit');
      assert.equal(subInit.fonts.length, 1, 'Extracted MKV TTF font attachment');
      assert.equal(subInit.fonts[0].byteLength, 256);
      assert.ok(
        subEvents.some(e => e.type === 'subtitleData'),
        'Streamed ASS Dialogue packet data',
      );

      const vOut = path.join(tmpDir, 'verify_v.mp4');
      const aOut = path.join(tmpDir, 'verify_a.mp4');
      fs.writeFileSync(vOut, Buffer.concat(vParts));
      fs.writeFileSync(aOut, Buffer.concat(aParts));
      const vProbe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', vOut], { encoding: 'utf8' }),
      );
      const aProbe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', aOut], { encoding: 'utf8' }),
      );
      assert.equal(vProbe.streams[0].codec_name, 'h264');
      assert.equal(aProbe.streams[0].codec_name, 'flac');
      assert.equal(aProbe.streams[0].channels, 2);

      await engine.cleanup();

      // Verify live audio track switching to Track 2 (Japanese AC-3 -> AAC)
      let switchedMsg = null;
      await new Promise((resolve, reject) => {
        const switchedEngine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => switchedEngine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'ready') {
            switchedEngine.onMessage({
              type: 'selectAudio',
              audioGen: 2,
              seekGen: 2,
              audioId: msg.audioTracks[1].id,
              time: 1.0,
              aheadSeconds: 10,
            });
          } else if (msg.type === 'audioSwitched') {
            switchedMsg = msg;
          } else if (msg.type === 'segment' && msg.audioGen === 2 && msg.audioBytes?.byteLength) {
            void switchedEngine.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void switchedEngine.cleanup().then(() => reject(new Error(msg.message)));
          }
        });
        switchedEngine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          flacSupported: false,
          aheadSeconds: 10,
        });
      });

      assert.ok(switchedMsg?.audioInit?.byteLength > 0, 'Produced fresh AAC fMP4 init segment on audio switch');
    },
  );

  test(
    'watch-file-worker remuxes 10-bit HEVC (hvc1) + TrueHD 5.1 and preserves timestamps across mid-stream seek',
    { timeout: 15000 },
    async () => {
      const fileBuf = fs.readFileSync(path.join(tmpDir, 'hevc_truehd.mkv'));
      const vParts = [];
      const aParts = [];
      let readyMsg = null;

      await new Promise((resolve, reject) => {
        const engine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'ready') {
            readyMsg = msg;
            vParts.push(Buffer.from(msg.videoInit));
            aParts.push(Buffer.from(msg.audioInit));
          } else if (msg.type === 'segment') {
            if (msg.videoBytes?.byteLength) vParts.push(Buffer.from(msg.videoBytes));
            if (msg.audioBytes?.byteLength) aParts.push(Buffer.from(msg.audioBytes));
            if (msg.eof) {
              void engine.cleanup().then(resolve);
            }
          } else if (msg.type === 'error') {
            void engine.cleanup().then(() => reject(new Error(msg.message)));
          }
        });
        engine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          flacSupported: true,
          startTime: 2.0,
          aheadSeconds: 10,
        });
      });

      assert.match(readyMsg.video.mime, /^video\/mp4; codecs="hvc1\./, 'Tagged HEVC stream as hvc1');
      const vOut = path.join(tmpDir, 'hevc_seek_v.mp4');
      const aOut = path.join(tmpDir, 'hevc_seek_a.mp4');
      fs.writeFileSync(vOut, Buffer.concat(vParts));
      fs.writeFileSync(aOut, Buffer.concat(aParts));
      const vProbe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', vOut], { encoding: 'utf8' }),
      );
      const aProbe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', aOut], { encoding: 'utf8' }),
      );
      assert.equal(vProbe.streams[0].codec_tag_string, 'hvc1');
      assert.ok(Math.abs(Number(vProbe.streams[0].start_time) - 2.0) < 0.25, 'Seeked HEVC fMP4 starts near 2.0s');
      assert.ok(
        Math.abs(Number(aProbe.streams[0].start_time) - 2.0) < 0.25,
        'Seeked TrueHD->FLAC fMP4 starts near 2.0s',
      );
    },
  );

  test(
    'watch-file-worker passes through MSE-native AAC audio without re-encoding and switches cleanly to decoded DTS',
    { timeout: 15000 },
    async () => {
      const aacDtsPath = path.join(tmpDir, 'aac_dts.mkv');
      execFileSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=48000:duration=2',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=660:sample_rate=48000:duration=2',
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-map',
        '2:a:0',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-pix_fmt',
        'yuv420p',
        '-g',
        '24',
        '-c:a:0',
        'aac',
        '-ac:a:0',
        '2',
        '-b:a:0',
        '128k',
        '-c:a:1',
        'dca',
        '-strict',
        '-2',
        '-ac:a:1',
        '6',
        '-b:a:1',
        '768k',
        aacDtsPath,
      ]);

      const fileBuf = fs.readFileSync(aacDtsPath);
      const aParts = [];
      let readyMsg = null;
      await new Promise((resolve, reject) => {
        const engine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'ready') {
            readyMsg = msg;
            if (msg.audioInit?.byteLength) aParts.push(Buffer.from(msg.audioInit));
          } else if (msg.type === 'segment') {
            if (msg.audioBytes?.byteLength) aParts.push(Buffer.from(msg.audioBytes));
            if (msg.eof) void engine.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void engine.cleanup().then(() => reject(new Error(msg.message)));
          }
        });
        engine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          flacSupported: true,
          passthroughAudioCodecs: ['aac', 'opus', 'flac'],
          aheadSeconds: 10,
        });
      });

      assert.equal(readyMsg.audioPassthrough, true);
      assert.equal(readyMsg.audioMime, 'audio/mp4; codecs="mp4a.40.2"');
      const aOut = path.join(tmpDir, 'passthrough_aac.mp4');
      fs.writeFileSync(aOut, Buffer.concat(aParts));
      const aProbe = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', aOut], { encoding: 'utf8' }),
      );
      assert.equal(aProbe.streams[0].codec_name, 'aac');

      let switchedMsg = null;
      await new Promise((resolve, reject) => {
        const engine = createWorkerEngine(msg => {
          if (msg.type === 'read') {
            const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
            setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
          } else if (msg.type === 'ready') {
            engine.onMessage({
              type: 'selectAudio',
              audioGen: 2,
              seekGen: 2,
              audioId: msg.audioTracks[1].id,
              time: 0,
              aheadSeconds: 10,
            });
          } else if (msg.type === 'audioSwitched') {
            switchedMsg = msg;
          } else if (msg.type === 'segment' && msg.audioGen === 2 && msg.audioBytes?.byteLength) {
            void engine.cleanup().then(resolve);
          } else if (msg.type === 'error') {
            void engine.cleanup().then(() => reject(new Error(msg.message)));
          }
        });
        engine.onMessage({
          type: 'init',
          fileSize: fileBuf.length,
          flacSupported: true,
          passthroughAudioCodecs: ['aac', 'opus', 'flac'],
          aheadSeconds: 10,
        });
      });

      assert.equal(switchedMsg.audioPassthrough, false);
      assert.equal(switchedMsg.audioMime, 'audio/mp4; codecs="flac"');
    },
  );

  test(
    'watch-file-worker preserves B-frame pyramid presentation timestamps in MKV without clamping and boosts discrete 5.1 center channel in dialogue mode',
    { timeout: 15000 },
    async () => {
      const bframeMkv = path.join(tmpDir, 'bframes_51.mkv');
      // 4-B-frame pyramid H.264 + 5.1 DTS with audio ONLY in the discrete Center (FC) channel.
      execFileSync('ffmpeg', [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=24:duration=2',
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
        const vParts = [];
        const aParts = [];
        let readyMsg = null;
        await new Promise((resolve, reject) => {
          const engine = createWorkerEngine(msg => {
            if (msg.type === 'read') {
              const copy = new Uint8Array(fileBuf.subarray(msg.start, Math.min(fileBuf.length, msg.end)));
              setImmediate(() => engine.onMessage({ type: 'readResult', id: msg.id, bytes: copy.buffer }));
            } else if (msg.type === 'ready') {
              readyMsg = msg;
              if (msg.videoInit?.byteLength) vParts.push(Buffer.from(msg.videoInit));
              if (msg.audioInit?.byteLength) aParts.push(Buffer.from(msg.audioInit));
            } else if (msg.type === 'segment') {
              if (msg.videoBytes?.byteLength) vParts.push(Buffer.from(msg.videoBytes));
              if (msg.audioBytes?.byteLength) aParts.push(Buffer.from(msg.audioBytes));
              if (msg.eof) void engine.cleanup().then(resolve);
            } else if (msg.type === 'error') {
              void engine.cleanup().then(() => reject(new Error(msg.message)));
            }
          });
          engine.onMessage({
            type: 'init',
            fileSize: fileBuf.length,
            flacSupported: true,
            audioMode: mode,
            aheadSeconds: 10,
          });
        });
        return { readyMsg, vBuf: Buffer.concat(vParts), aBuf: Buffer.concat(aParts) };
      };

      const [normal, dialogue] = await Promise.all([runMode('normal'), runMode('dialogue')]);
      assert.equal(normal.readyMsg.surroundDialogueActive, false);
      assert.equal(dialogue.readyMsg.surroundDialogueActive, true);

      // Verify B-frame pyramid PTS values are distinct and not clamped to DTS.
      const vOut = path.join(tmpDir, 'bframes_v.mp4');
      fs.writeFileSync(vOut, normal.vBuf);
      const pkts = JSON.parse(
        execFileSync('ffprobe', ['-v', 'error', '-show_packets', '-select_streams', 'v:0', '-of', 'json', vOut], {
          encoding: 'utf8',
        }),
      ).packets;
      const ptsList = pkts.map(p => Number(p.pts_time)).filter(Number.isFinite);
      assert.equal(ptsList.length, 48, 'All 48 B-frame pyramid video packets preserved without drops');
      const uniquePts = new Set(ptsList.map(t => Math.round(t * 1000)));
      assert.equal(uniquePts.size, ptsList.length, 'No B-frame PTS values were clamped/duplicated');

      // Verify discrete Center (FC) channel is louder in dialogue mode than normal mode.
      const rmsOf = buf => {
        const p = path.join(tmpDir, `rms_${Math.random().toString(36).slice(2)}.mp4`);
        fs.writeFileSync(p, buf);
        const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 's16le', '-ac', '2', 'pipe:1']);
        let sumSq = 0;
        const samples = pcm.length / 2;
        for (let i = 0; i < pcm.length; i += 2) {
          const s = pcm.readInt16LE(i) / 32768;
          sumSq += s * s;
        }
        return Math.sqrt(sumSq / Math.max(1, samples));
      };
      const normalRms = rmsOf(normal.aBuf);
      const dialogueRms = rmsOf(dialogue.aBuf);
      assert.ok(
        dialogueRms > normalRms * 1.4,
        `Expected dialogue mode (${dialogueRms.toFixed(4)}) to boost discrete Center channel over normal (${normalRms.toFixed(4)})`,
      );
    },
  );
}
