'use strict';
/**
 * Playback preparation & shared media resources benchmark harness.
 * Captures Before/After metrics for Phases 1 & 2 (B1-B4) and read-only Phase 3
 * contention profiles (B5, via --phase3 or --all). Never modifies production scheduling.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { Hub } = require('../server/core');
const { liveWatch } = require('../tests/helpers/live-room');
const { watchOperations } = require('../server/watch-operations');
const { Plex } = require('../server/sources/plex/plex');
const { plexProvider } = require('../server/sources/plex/provider');
const { MediaProviders } = require('../server/media-providers');
const { MediaPipeline } = require('../server/media-pipeline');
const { MediaChecks } = require('../server/media-check');
const { findOnPath } = require('../server/media-tools');
const { ConversionPolicy, ProcessGate } = require('../server/transcoding-policy');
const Subtitles = require('../server/subtitles');
const SubtitleResources = require('../server/subtitle-resources');

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Math.round(sorted[idx] * 100) / 100;
}

function buildFixtures(dir, ffmpeg, ffprobe) {
  fs.mkdirSync(dir, { recursive: true });
  const srtPath = path.join(dir, 'bench.srt');
  const assPath = path.join(dir, 'bench.ass');
  const mkvPath = path.join(dir, 'bench-65s.mkv');

  const srtLines = [];
  for (let i = 0; i < 12; i++) {
    const startSec = i * 5 + 1;
    const endSec = startSec + 3;
    const fmt = s => {
      const m = String(Math.floor(s / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return `00:${m}:${sec},000`;
    };
    srtLines.push(`${i + 1}\n${fmt(startSec)} --> ${fmt(endSec)}\nBench subtitle line ${i + 1}\n`);
  }
  fs.writeFileSync(srtPath, srtLines.join('\n'));

  fs.writeFileSync(
    assPath,
    '[Script Info]\nScriptType: v4.00+\nPlayResX: 320\nPlayResY: 180\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,18,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,ASS Bench Line 1\nDialogue: 0,0:00:10.00,0:00:15.00,Default,,0,0,0,,ASS Bench Line 2\n',
  );

  const res = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=10',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-i',
      srtPath,
      '-i',
      assPath,
      '-t',
      '65',
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-map',
      '2:s:0',
      '-map',
      '3:s:0',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '35',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '32k',
      '-c:s',
      'copy',
      '-metadata:s:a:0',
      'language=eng',
      '-metadata:s:s:0',
      'language=eng',
      '-metadata:s:s:1',
      'language=eng',
      mkvPath,
    ],
    { encoding: 'utf8', windowsHide: true, timeout: 60000 },
  );
  if (res.status !== 0) throw new Error('Failed to build bench MKV: ' + (res.stderr || res.error?.message));

  const probeOut = spawnSync(
    ffprobe,
    ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name:format=duration', '-of', 'json', mkvPath],
    { encoding: 'utf8', windowsHide: true },
  );
  if (probeOut.status !== 0) throw new Error('Failed to probe bench MKV');
  const probed = JSON.parse(probeOut.stdout);

  const bigSrtLines = [];
  for (let i = 0; i < 2000; i++) {
    const startSec = i * 2;
    const endSec = startSec + 1;
    const fmt = s => {
      const h = String(Math.floor(s / 3600)).padStart(2, '0');
      const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
      const sec = String(s % 60).padStart(2, '0');
      return `${h}:${m}:${sec},000`;
    };
    bigSrtLines.push(`${i + 1}\n${fmt(startSec)} --> ${fmt(endSec)}\nExternal cue number ${i + 1} for shared cache.\n`);
  }
  const bigSrtPath = path.join(dir, 'big-subs.srt');
  fs.writeFileSync(bigSrtPath, bigSrtLines.join('\n'));

  return { mkvPath, mkvSize: fs.statSync(mkvPath).size, mkvMtime: fs.statSync(mkvPath).mtimeMs, bigSrtPath, probed };
}

function serveFileRange(req, res, filePath, statSize, contentType, onBytes) {
  const range = req.headers.range;
  let start = 0;
  let end = statSize - 1;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      res.writeHead(416, { 'Content-Range': `bytes */${statSize}` });
      return res.end();
    }
    if (!m[1]) start = Math.max(0, statSize - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2]) end = Math.min(end, Number(m[2]));
    }
    if (start > end || start >= statSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${statSize}` });
      return res.end();
    }
  }
  res.writeHead(range ? 206 : 200, {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${statSize}` } : {}),
  });
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(filePath, { start, end });
  stream.on('data', chunk => onBytes?.(chunk.length));
  stream.pipe(res);
}

function instrumentAv1(av1, ffmpegPath, ffprobePath) {
  const counts = { ffprobeSpawns: 0, ffmpegSubtitleSpawns: 0, ffmpegOtherSpawns: 0 };
  const origRun = av1.run.bind(av1);
  av1.run = async (binary, args, signal, timeout, maxOutput, diagnostic, options) => {
    if (binary === ffprobePath) counts.ffprobeSpawns++;
    else if (binary === ffmpegPath) {
      if (args.includes('ass') || args.includes('sup') || args.includes('webvtt') || args.includes('matroska')) {
        counts.ffmpegSubtitleSpawns++;
      } else {
        counts.ffmpegOtherSpawns++;
      }
    }
    let stderrTail = '';
    const diag = (code, stderr) => {
      stderrTail = stderr;
      diagnostic?.(code, stderr);
    };
    try {
      return await origRun(binary, args, signal, timeout, maxOutput, diag, options);
    } catch (err) {
      if (stderrTail)
        console.error('CMD FAIL:', path.basename(binary), args.slice(0, 8), 'STDERR:', stderrTail.slice(-400));
      throw err;
    }
  };
  return counts;
}

async function benchB1(fixture, ffmpegPath, ffprobePath) {
  let bridgeBytesRead = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const json = value => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ MediaContainer: value }));
    };
    if (url.pathname === '/') return json({ machineIdentifier: 'bench-plex', friendlyName: 'BenchPlex' });
    if (url.pathname === '/library/metadata/1') {
      return json({
        Metadata: [
          {
            ratingKey: '1',
            type: 'movie',
            title: 'Direct Plex Bench',
            duration: 65000,
            Media: [
              {
                id: 99,
                videoCodec: 'h264',
                height: 1080,
                width: 1920,
                bitrate: 10000,
                Part: [
                  {
                    id: 5,
                    key: '/library/parts/5/file',
                    size: fixture.mkvSize,
                    Stream: [
                      { id: 10, index: 0, streamType: 1, codec: 'h264' },
                      { id: 11, index: 1, streamType: 2, codec: 'aac', languageCode: 'eng', selected: true },
                      { id: 21, index: 2, streamType: 3, codec: 'srt', languageCode: 'eng' },
                      { id: 22, index: 3, streamType: 3, codec: 'ass', languageCode: 'eng' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === '/library/parts/5/file') {
      return serveFileRange(req, res, fixture.mkvPath, fixture.mkvSize, 'video/x-matroska', n => {
        bridgeBytesRead += n;
      });
    }
    return json({});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  const config = {
    ffmpegPath,
    ffprobePath,
    transcoding: { uburoom: false, policy: 'disabled', encoder: 'software' },
  };
  const pipeline = new MediaPipeline(config);
  const counts = instrumentAv1(pipeline.av1, ffmpegPath, ffprobePath);
  const plex = new Plex({ url: baseUrl, token: 'owner-token' }, fetch, { pipeline, config });
  const provider = plexProvider({
    plex,
    source: {
      url: baseUrl,
      token: 'owner-token',
      delivery: { mode: 'auto', clientUrl: 'https://plex.example:32400', token: 'direct-token' },
    },
    plexAuth: {
      dedicated: async () => plex,
      machine: async () => ({}),
    },
  });
  provider.direct.file = async () => 'https://plex.example:32400/library/parts/5/file?X-Plex-Token=direct';
  const providers = new MediaProviders([provider], pipeline);
  const hub = new Hub({ ownerId: 'host', transcoding: config.transcoding }, []);
  hub.access = { isMember: () => true, refresh: async () => true, options: () => ({ available: true }) };
  const { watch, actor } = liveWatch(hub, plex);
  watch.providers = providers;
  const host = actor('host');
  const room = await watch.roomState.create(host).then(id => watch.rooms.get(id));
  const operations = watchOperations({
    config,
    hub,
    watch,
    authorized: async () => ({ actor: host }),
    throttle: () => true,
  });

  try {
    const viewerIds = Array.from({ length: 6 }, () => randomUUID());
    for (let i = 0; i < 6; i++) {
      watch.join(room, i === 0 ? host : actor(`viewer-${i}`), viewerIds[i]);
    }
    await hub.dispatch(
      { ...host, watchViewerId: viewerIds[0] },
      { roomId: room.roomId, action: 'media.load', args: { mediaId: '1', quality: 'direct' } },
    );
    await Promise.all([...room.viewers.values()].map(v => v.streamWork).filter(Boolean));
    for (const v of room.viewers.values()) {
      v.directFileResolved = {
        media: v.media,
        settled: true,
        url: 'https://plex.example:32400/library/parts/5/file?X-Plex-Token=direct',
      };
    }

    const t0 = performance.now();
    const checkRes = await operations.call({ headers: {} }, 'room.check', {
      roomId: room.roomId,
      args: { refresh: false },
    });
    const pendingCheck = watch.mediaChecks.files.get(room.media.sourceKey)?.promise;
    if (pendingCheck) await pendingCheck;
    const roomCheckMs = Math.round((performance.now() - t0) * 100) / 100;

    return {
      ffprobeSpawns: counts.ffprobeSpawns,
      bridgeBytesRead,
      roomCheckMs,
      checkStatus: checkRes.value?.status,
    };
  } finally {
    await watch.close();
    await plex.close();
    await pipeline.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

async function benchB2(fixture, ffmpegPath, ffprobePath) {
  const server = http.createServer((req, res) => {
    serveFileRange(req, res, fixture.mkvPath, fixture.mkvSize, 'video/x-matroska');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/bench.mkv`;

  const config = { ffmpegPath, ffprobePath, transcoding: { maxJobs: 2, encoder: 'software' } };
  const pipeline = new MediaPipeline(config);
  const counts = instrumentAv1(pipeline.av1, ffmpegPath, ffprobePath);
  const checks = new MediaChecks({ pipeline });
  const sourceProvider = {
    request: (target, opts) => fetch(target, opts),
  };
  const baseMedia = {
    id: 'b2-movie',
    title: 'B2 Movie',
    duration: 65,
    sourceStart: url,
    sourceKey: JSON.stringify(['bench', 'b2', fixture.mkvSize, fixture.mkvMtime]),
    shareKey: 'room-b2',
    provider: sourceProvider,
    tracks: {
      audio: [{ id: '1', index: 1, codec: 'aac' }],
      subtitles: [
        { id: '21', index: 2, codec: 'srt', delivery: 'cues', available: true, external: false },
        { id: '22', index: 3, codec: 'ass', delivery: 'ass', available: true, external: false },
      ],
    },
    selection: {
      audio: { id: '1', index: 1, codec: 'aac' },
      subtitle: { id: '22', index: 3, codec: 'ass', delivery: 'ass', available: true, external: false },
    },
  };

  const rssBefore = process.memoryUsage().rss;
  let rssPeak = rssBefore;
  const subLatencies = [];
  const probeLatencies = [];

  try {
    const groupA = { key: 'rung-720p4', controllers: new Set(), chunks: new Map(), leases: new Set() };
    const groupB = { key: 'rung-480p2', controllers: new Set(), chunks: new Map(), leases: new Set() };
    const checkMedia = { ...baseMedia, lifecycleAbort: new AbortController() };

    const checkTask = checks.start(checkMedia).promise;
    const rungTasks = [groupA, groupB].map(async group => {
      const t = performance.now();
      await pipeline.av1.sourceInfo(group, { ...baseMedia, start: baseMedia.sourceStart, quality: group.key });
      probeLatencies.push(performance.now() - t);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    });
    const viewerTasks = Array.from({ length: 8 }, async () => {
      const viewerMedia = {
        ...baseMedia,
        captionVersion: randomUUID(),
        subtitleAbort: new AbortController(),
        lifecycleAbort: new AbortController(),
      };
      const t = performance.now();
      const loader = pipeline.subtitleResources?.load ? pipeline.subtitleResources : SubtitleResources;
      await loader.load(pipeline.av1, viewerMedia, viewerMedia.subtitleAbort.signal);
      subLatencies.push(performance.now() - t);
      rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
    });

    await Promise.all([checkTask, ...rungTasks, ...viewerTasks]);

    return {
      ffprobeSpawns: counts.ffprobeSpawns,
      ffmpegSubtitleSpawns: counts.ffmpegSubtitleSpawns,
      p50ProbeMs: percentile(probeLatencies, 50),
      p95ProbeMs: percentile(probeLatencies, 95),
      p50SubMs: percentile(subLatencies, 50),
      p95SubMs: percentile(subLatencies, 95),
      peakRssMiB: Math.round((rssPeak / (1024 * 1024)) * 100) / 100,
    };
  } finally {
    await pipeline.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

async function benchB3(fixture, ffmpegPath, ffprobePath) {
  const server = http.createServer((req, res) => {
    serveFileRange(req, res, fixture.mkvPath, fixture.mkvSize, 'video/x-matroska');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/bench.mkv`;

  const config = { ffmpegPath, ffprobePath, transcoding: { maxJobs: 2, encoder: 'software' } };
  const pipeline = new MediaPipeline(config);
  const counts = instrumentAv1(pipeline.av1, ffmpegPath, ffprobePath);
  const loader = pipeline.subtitleResources?.window ? pipeline.subtitleResources : SubtitleResources;
  const sourceProvider = { request: (target, opts) => fetch(target, opts) };
  const makeViewerMedia = () => ({
    id: 'b3-movie',
    title: 'B3 Movie',
    duration: 65,
    sourceStart: url,
    sourceKey: JSON.stringify(['bench', 'b3', fixture.mkvSize, fixture.mkvMtime]),
    shareKey: 'room-b3',
    provider: sourceProvider,
    captionVersion: randomUUID(),
    subtitleAbort: new AbortController(),
    lifecycleAbort: new AbortController(),
    tracks: {
      audio: [{ id: '1', index: 1, codec: 'aac' }],
      subtitles: [{ id: '21', index: 2, codec: 'srt', delivery: 'cues', available: true, external: false }],
    },
    selection: {
      subtitle: { id: '21', index: 2, codec: 'srt', delivery: 'cues', available: true, external: false },
    },
  });

  try {
    const viewers10 = Array.from({ length: 10 }, makeViewerMedia);
    const joinLatencies = [];
    let busyErrorsAt10 = 0;

    await Promise.all(
      viewers10.map(async (m, i) => {
        const t = performance.now();
        try {
          await loader.window(pipeline.av1, m, { atMs: 10000 + i * 350, beforeMs: 5000, afterMs: 15000 });
          joinLatencies.push(performance.now() - t);
        } catch (err) {
          if (/busy/i.test(err.message)) busyErrorsAt10++;
          else throw err;
        }
      }),
    );
    const joinFfprobeSpawns = counts.ffprobeSpawns;
    const joinFfmpegSpawns = counts.ffmpegSubtitleSpawns;

    const seekLatencies = [];
    await Promise.all(
      viewers10.map(async (m, i) => {
        const t = performance.now();
        try {
          await loader.window(pipeline.av1, m, { atMs: 45000 + i * 350, beforeMs: 5000, afterMs: 15000 });
          seekLatencies.push(performance.now() - t);
        } catch (err) {
          if (/busy/i.test(err.message)) busyErrorsAt10++;
          else throw err;
        }
      }),
    );
    const seekFfprobeSpawns = counts.ffprobeSpawns - joinFfprobeSpawns;
    const seekFfmpegSpawns = counts.ffmpegSubtitleSpawns - joinFfmpegSpawns;

    let busyErrorsAt20 = 0;
    const viewers20 = Array.from({ length: 20 }, makeViewerMedia);
    await Promise.all(
      viewers20.map(async (m, i) => {
        try {
          await loader.window(pipeline.av1, m, { atMs: 25000 + (i % 10) * 350, beforeMs: 5000, afterMs: 15000 });
        } catch (err) {
          if (/busy/i.test(err.message)) busyErrorsAt20++;
          else throw err;
        }
      }),
    );

    return {
      joinFfprobeSpawns,
      joinFfmpegSpawns,
      seekFfprobeSpawns,
      seekFfmpegSpawns,
      busyErrorsAt10,
      busyErrorsAt20,
      p50WindowMs: percentile([...joinLatencies, ...seekLatencies], 50),
      p95WindowMs: percentile([...joinLatencies, ...seekLatencies], 95),
    };
  } finally {
    await pipeline.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

async function benchB4(fixture) {
  let providerSubtitleFetches = 0;
  const srtBytes = fs.readFileSync(fixture.bigSrtPath);
  const server = http.createServer((req, res) => {
    providerSubtitleFetches++;
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': srtBytes.length });
    res.end(srtBytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const subUrl = `http://127.0.0.1:${server.address().port}/big-subs.srt`;
  const pipeline = new MediaPipeline({});
  const sourceProvider = {
    request: (target, opts) => fetch(target, opts),
  };

  try {
    global.gc?.();
    const heapBefore = process.memoryUsage().heapUsed;
    const t0 = performance.now();
    const viewers = Array.from({ length: 10 }, () => ({
      sourceKey: JSON.stringify(['bench', 'b4', fixture.mkvSize, fixture.mkvMtime]),
      shareKey: 'room-b4',
      provider: sourceProvider,
      subtitleAbort: new AbortController(),
      selection: {
        subtitle: { id: 'ext-1', available: true, delivery: 'text', external: true, resources: { text: subUrl } },
      },
    }));
    const results = await Promise.all(
      viewers.map(m =>
        pipeline.subtitleResources?.loadTextCues ? pipeline.subtitleResources.loadTextCues(m) : Subtitles.load(m),
      ),
    );
    const totalMs = Math.round((performance.now() - t0) * 100) / 100;
    const heapAfter = process.memoryUsage().heapUsed;
    return {
      providerSubtitleFetches,
      totalParseMs: totalMs,
      cueCount: results[0].length,
      heapDeltaKiB: Math.round(((heapAfter - heapBefore) / 1024) * 100) / 100,
    };
  } finally {
    await pipeline.close();
    server.closeAllConnections?.();
    await new Promise(resolve => server.close(resolve));
  }
}

async function benchB5Phase3(fixture) {
  // B5a: ProcessGate FIFO vs simulated Priority Queue (urgent live playback vs background art/checks)
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  async function runGateProfile(usePriority) {
    const gate = new ProcessGate(4);
    const liveWaits = [];
    const bgWaits = [];

    if (!usePriority) {
      const bgTasks = Array.from({ length: 6 }, async () => {
        const t = performance.now();
        await gate.run(undefined, async () => {
          bgWaits.push(performance.now() - t);
          await delay(90);
        });
      });
      await delay(5);
      const liveTasks = Array.from({ length: 4 }, async () => {
        const t = performance.now();
        await gate.run(undefined, async () => {
          liveWaits.push(performance.now() - t);
          await delay(25);
        });
      });
      await Promise.all([...bgTasks, ...liveTasks]);
    } else {
      let active = 0;
      const limit = 4;
      const waiters = [];
      const acquire = urgent =>
        new Promise(resolve => {
          if (active < limit && !waiters.length) {
            active++;
            return resolve(() => release());
          }
          waiters.push({ urgent, at: performance.now(), resolve: () => resolve(() => release()) });
          waiters.sort((a, b) => Number(b.urgent) - Number(a.urgent) || a.at - b.at);
        });
      const release = () => {
        const next = waiters.shift();
        if (next) next.resolve();
        else active--;
      };
      const bgTasks = Array.from({ length: 6 }, async () => {
        const t = performance.now();
        const rel = await acquire(false);
        try {
          bgWaits.push(performance.now() - t);
          await delay(90);
        } finally {
          rel();
        }
      });
      await delay(5);
      const liveTasks = Array.from({ length: 4 }, async () => {
        const t = performance.now();
        const rel = await acquire(true);
        try {
          liveWaits.push(performance.now() - t);
          await delay(25);
        } finally {
          rel();
        }
      });
      await Promise.all([...bgTasks, ...liveTasks]);
    }

    return {
      liveWaitP50Ms: percentile(liveWaits, 50),
      liveWaitP95Ms: percentile(liveWaits, 95),
      bgWaitP95Ms: percentile(bgWaits, 95),
    };
  }

  // B5b: ConversionPolicy maxJobs = 1 with Room 1 paused 60s on Plex HLS
  async function runConversionLeaseProfile() {
    const policy = new ConversionPolicy({
      maxJobs: 1,
      policy: 'allow',
      uburoom: true,
      provider: true,
      formats: ['av1'],
    });
    policy.waitMs = 150;
    const room1Release = policy.acquire();
    let baselineRoom2Blocked = false;
    try {
      await policy.wait({});
    } catch (err) {
      baselineRoom2Blocked = !!err.conversionCapacity;
    }

    // Simulated contention-aware 60s paused Plex lease release + resume re-acquire
    const pausedDurationMs = 60000;
    let preempted = false;
    const simRelease = () => {
      preempted = true;
      room1Release();
    };
    const tWait = performance.now();
    if (pausedDurationMs >= 60000 && policy.jobs.size >= 1) simRelease();
    const room2Release = await policy.wait({});
    const room2AcquireMs = Math.round((performance.now() - tWait) * 100) / 100;
    room2Release();

    const tResume = performance.now();
    const resumeRelease = await policy.wait({});
    const resumeReacquireMs = Math.round((performance.now() - tResume) * 100) / 100;
    resumeRelease();

    return {
      baselineRoom2Blocked,
      contentionAwarePreempted: preempted,
      room2AcquireMs,
      resumeReacquireMs,
    };
  }

  // B5c: Range-read TTFB idle vs concurrent read load & pipeline.busy check
  async function runRangeIoProfile() {
    const pipeline = new MediaPipeline({});
    const remuxBusyReported = pipeline.busy; // Currently false for Remux / range streams
    const measureRead = async () => {
      const t = performance.now();
      const fh = await fs.promises.open(fixture.mkvPath, 'r');
      const buf = Buffer.allocUnsafe(Math.min(512 * 1024, fixture.mkvSize));
      await fh.read(buf, 0, buf.length, 0);
      await fh.close();
      return performance.now() - t;
    };
    const idleSamples = [];
    for (let i = 0; i < 6; i++) idleSamples.push(await measureRead());
    const loadedSamples = [];
    const bgNoise = Array.from({ length: 4 }, async () => {
      for (let i = 0; i < 4; i++) await fs.promises.readFile(fixture.mkvPath);
    });
    for (let i = 0; i < 6; i++) loadedSamples.push(await measureRead());
    await Promise.all(bgNoise);
    await pipeline.close();
    return {
      pipelineBusyWhenRangeActive: remuxBusyReported,
      rangeReadIdleP95Ms: percentile(idleSamples, 95),
      rangeReadLoadedP95Ms: percentile(loadedSamples, 95),
    };
  }

  return {
    b5aProcessGate: {
      fifoBaseline: await runGateProfile(false),
      priorityCandidate: await runGateProfile(true),
    },
    b5bConversionLease: await runConversionLeaseProfile(),
    b5cRangeIo: await runRangeIoProfile(),
  };
}

async function main() {
  const ffmpegPath = findOnPath('ffmpeg');
  const ffprobePath = findOnPath('ffprobe');
  if (!ffmpegPath || !ffprobePath) {
    console.error('ffmpeg and ffprobe are required on PATH to run scripts/prep-bench.js');
    process.exitCode = 1;
    return;
  }

  const runPhase3 = process.argv.includes('--phase3') || process.argv.includes('--all');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-prep-bench-'));
  try {
    const fixture = buildFixtures(tmpDir, ffmpegPath, ffprobePath);
    console.error('[bench] fixtures ready');
    const b1DirectPlex = await benchB1(fixture, ffmpegPath, ffprobePath);
    console.error('[bench] b1 done');
    const b2ColdStartAss = await benchB2(fixture, ffmpegPath, ffprobePath);
    console.error('[bench] b2 done');
    const b3WindowSyncSeek = await benchB3(fixture, ffmpegPath, ffprobePath);
    console.error('[bench] b3 done');
    const b4ExternalCues = await benchB4(fixture);
    console.error('[bench] b4 done');
    const results = {
      nodeVersion: process.version,
      b1DirectPlex,
      b2ColdStartAss,
      b3WindowSyncSeek,
      b4ExternalCues,
      ...(runPhase3 ? { b5Phase3Contention: await benchB5Phase3(fixture) } : {}),
    };
    console.log(JSON.stringify(results, null, 2));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
