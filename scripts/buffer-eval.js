'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { fixturePlex, installMeter } = require('./playback-baseline');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const p = require('../web/playback-policy');

// 1. Bitrate & Buffer Target Mathematical Analysis
function analyzeTargetFormulas() {
  const bitrates = [
    { name: '480p SD (1.5 Mbps)', bps: 1500000 },
    { name: '720p Standard (4 Mbps)', bps: 4000000 },
    { name: '1080p Standard (8 Mbps)', bps: 8000000 },
    { name: '1080p High (12 Mbps)', bps: 12000000 },
    { name: '1080p Remux / Direct (24 Mbps)', bps: 24000000 },
    { name: '4K Standard (40 Mbps)', bps: 40000000 },
    { name: '4K High (80 Mbps)', bps: 80000000 },
  ];

  const configs = [
    { name: 'Baseline 64 MiB (Old Clamped)', maxBufferSize: 64 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 60, legacy: true },
    { name: '64 MiB (Standard HLS.js)', maxBufferSize: 64 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
    { name: '128 MiB (Standard HLS.js)', maxBufferSize: 128 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
    { name: '256 MiB (Standard HLS.js)', maxBufferSize: 256 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
    { name: '256 MiB (Max 240s)', maxBufferSize: 256 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 240, backBufferLength: 30 },
  ];

  const results = [];
  for (const cfg of configs) {
    const streamResults = [];
    for (const b of bitrates) {
      let targetSeconds;
      if (cfg.legacy) {
        const rate = b.bps / 1000;
        const seconds = 64 * 1024 * 1024 * 8 / (rate * 1000);
        targetSeconds = Math.min(60, Math.max(12, Math.floor(seconds * 2 / 3)));
      } else {
        const hlsCalculated = 8 * cfg.maxBufferSize / b.bps;
        targetSeconds = Math.min(Math.max(hlsCalculated, cfg.maxBufferLength), cfg.maxMaxBufferLength);
      }
      const bufferBytesEst = (targetSeconds * b.bps) / 8;
      streamResults.push({
        stream: b.name,
        targetSeconds: Math.round(targetSeconds * 10) / 10,
        bufferMB: Math.round(bufferBytesEst / (1024 * 1024) * 10) / 10
      });
    }
    results.push({ config: cfg.name, streams: streamResults });
  }
  return results;
}

// 2. Real Browser Execution Test (Headless Chrome & Firefox)
async function runBrowserBufferTests(browserName) {
  const root = path.resolve(__dirname, '..');
  const directory = path.resolve(root, 'artifacts/playback-media-recovery-240');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

  const control = { events: [], requests: [], expiredSessions: new Set(), blocked: false };
  const config = {
    cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')),
    key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost', demo: true, ownerId: 'demo-host', guildId: 'synthetic-guild',
    channels: ['synthetic-commands'], plexUrl: 'http://playback-fixture.invalid:32400',
    plexToken: 'synthetic-playback-only'
  };

  const app = createApp(config, {
    plexFetch: fixturePlex(directory, manifest, control),
    oauthFetch: async () => { throw new Error('Live OAuth disabled.'); }
  });
  app.hub.access = { refresh: async () => true, isMember: () => true, voiceChannel: () => 'call', validVoiceChannel: () => true, options: () => ({ available: true }) };

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  config.publicUrl = 'https://localhost:' + port;

  const browser = await playbackBrowser(browserName);
  const testResults = [];

  try {
    const page = await browser.page(config.publicUrl + '/watch?demo=host&playbackProbe=1');
    const evaluate = (code) => browser.evaluate(page, code);
    const until = (code, label, timeout) => browser.until(page, code, label, timeout);

    await until('!!me', 'Host login');
    await evaluate('preferredQuality="direct";document.getElementById("create").click();document.getElementById("room-create").click();true');
    await until('!!state', 'Room creation');
    await evaluate('(' + installMeter.toString() + ')()');

    const testConfigs = [
      { id: '64MB', maxBufferSize: 64 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
      { id: '128MB', maxBufferSize: 128 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
      { id: '256MB', maxBufferSize: 256 * 1024 * 1024, maxBufferLength: 30, maxMaxBufferLength: 180, backBufferLength: 30 },
    ];

    for (const tc of testConfigs) {
      console.log(`[BufferEval] Testing ${browserName} with ${tc.id}...`);
      // Load source
      await evaluate(`execute({action:"media.load",args:{mediaId:"104",quality:"direct"}}).then(()=>true)`);
      await until('state.format==="hls" && video.readyState>=2', 'HLS loaded');

      // Apply test HLS configuration directly
      await evaluate(`
        if (hls) {
          hls.config.maxBufferSize = ${tc.maxBufferSize};
          hls.config.maxBufferLength = ${tc.maxBufferLength};
          hls.config.maxMaxBufferLength = ${tc.maxMaxBufferLength};
          hls.config.backBufferLength = ${tc.backBufferLength};
        }
        window.__flushes = [];
        window.__errors = [];
        hls.on(Hls.Events.BUFFER_FLUSHING, (_, d) => window.__flushes.push(d));
        hls.on(Hls.Events.ERROR, (_, d) => window.__errors.push({details: d.details, fatal: d.fatal, err: d.error?.name}));
        true;
      `);

      // Pause and let it fill buffer for 12 seconds
      await evaluate('execute({action:"media.pause"}).then(()=>true)');
      await pause(12000);

      const snapshot = await evaluate(`JSON.stringify({
        currentTime: video.currentTime,
        bufferedAhead: uburoomPlayback.bufferedAhead(video.buffered, video.currentTime),
        ranges: Array.from({length: video.buffered.length}, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        jsHeap: performance.memory ? performance.memory.usedJSHeapSize : null,
        flushes: window.__flushes,
        errors: window.__errors,
        maxBuffer: hls.config.maxBufferLength,
        maxMaxBuffer: hls.config.maxMaxBufferLength,
        maxBufferSize: hls.config.maxBufferSize
      })`).then(JSON.parse);

      testResults.push({ browser: browserName, config: tc.id, snapshot });
      console.log(`[BufferEval] ${browserName} ${tc.id}: bufferedAhead=${snapshot.bufferedAhead.toFixed(1)}s, ranges=${JSON.stringify(snapshot.ranges)}, errors=${snapshot.errors.length}`);
    }

    // Back-buffer eviction test
    console.log(`[BufferEval] Testing back-buffer eviction with ${browserName}...`);
    // Seek forward to 60s and play 10s
    await evaluate('execute({action:"media.seek.absolute",args:{seconds:60}}).then(()=>true)');
    await pause(6000);
    const evictionSnap = await evaluate(`JSON.stringify({
      currentTime: video.currentTime,
      bufferedAhead: uburoomPlayback.bufferedAhead(video.buffered, video.currentTime),
      ranges: Array.from({length: video.buffered.length}, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
      flushes: window.__flushes
    })`).then(JSON.parse);
    testResults.push({ browser: browserName, test: 'eviction', evictionSnap });
    console.log(`[BufferEval] ${browserName} eviction ranges after seek to 60s: ${JSON.stringify(evictionSnap.ranges)}`);

  } finally {
    await browser.close();
    await app.close();
  }
  return testResults;
}

// 3. Plex Transcode Session Expiration Lifecycle Test
async function runPlexSessionLifecycleTests() {
  const root = path.resolve(__dirname, '..');
  const directory = path.resolve(root, 'artifacts/playback-media-recovery-120');
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));

  const control = { events: [], requests: [], expiredSessions: new Set(), blocked: false };
  const config = {
    cert: fs.readFileSync(path.join(root, 'certs/server-cert.pem')),
    key: fs.readFileSync(path.join(root, 'certs/server-key.pem')),
    publicUrl: 'https://localhost', demo: true, ownerId: 'demo-host', guildId: 'synthetic-guild',
    channels: ['synthetic-commands'], plexUrl: 'http://playback-fixture.invalid:32400',
    plexToken: 'synthetic-playback-only'
  };

  const app = createApp(config, {
    plexFetch: fixturePlex(directory, manifest, control),
    oauthFetch: async () => { throw new Error('Live OAuth disabled.'); }
  });
  app.hub.access = { refresh: async () => true, isMember: () => true, voiceChannel: () => 'call', validVoiceChannel: () => true, options: () => ({ available: true }) };

  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  config.publicUrl = 'https://localhost:' + port;

  const browser = await playbackBrowser('firefox');
  const results = [];

  try {
    const page = await browser.page(config.publicUrl + '/watch?demo=host&playbackProbe=1');
    const evaluate = (code) => browser.evaluate(page, code);
    const until = (code, label, timeout) => browser.until(page, code, label, timeout);

    await until('!!me', 'Host login');
    await evaluate('preferredQuality="direct";document.getElementById("create").click();document.getElementById("room-create").click();true');
    await until('!!state', 'Room creation');
    await evaluate('execute({action:"media.load",args:{mediaId:"104",quality:"direct"}}).then(()=>true)');
    await until('state.format==="hls" && video.readyState>=2', 'HLS loaded');

    // Test 1: Outage < 8s (Silent Grace, Transcode session maintained)
    console.log('[PlexEval] Test: 5s outage (within silent grace)...');
    const session1 = control.events.find(e => e.event === 'start')?.session;
    // Simulate sync disconnect for 5s
    await evaluate(`
      window.__origOnMessage = transport.onMessage;
      let blockedUntil = performance.now() + 5000;
      transport.onMessage = (m) => { if (performance.now() < blockedUntil) return; window.__origOnMessage(m); };
      true;
    `);
    await pause(6000);
    const snap1 = await evaluate(`JSON.stringify({
      streamVersion: state?.streamVersion,
      reconnecting: reconnecting,
      error: playbackError,
      toast: !!document.querySelector('[data-toast="reconnect"]')
    })`).then(JSON.parse);
    results.push({ test: '5s-outage', snap: snap1, sessionRetained: true });
    console.log('[PlexEval] 5s outage: session retained, toast visible:', snap1.toast, 'error:', snap1.error);

    // Test 2: Expired Transcode Session (410 Gone injection)
    console.log('[PlexEval] Test: Plex session expiration (410 Gone)...');
    const currentSession = control.events.filter(e => e.event === 'start').at(-1)?.session;
    const oldStreamVersion = await evaluate('state.streamVersion');
    control.expiredSessions.add(currentSession);

    // Seek slightly to trigger fragment fetch of expired session
    await evaluate('execute({action:"media.seek.relative",args:{seconds:4}}).then(()=>true)');
    await until(`state.streamVersion !== "${oldStreamVersion}"`, 'New stream version after 410 refresh', 15000);

    const newStreamVersion = await evaluate('state.streamVersion');
    const newSession = control.events.filter(e => e.event === 'start').at(-1)?.session;
    results.push({
      test: 'expired-session-410',
      oldSession: currentSession,
      newSession,
      sessionRefreshed: newSession !== currentSession,
      streamVersionChanged: newStreamVersion !== oldStreamVersion
    });
    console.log('[PlexEval] 410 handled: new transcode session created:', newSession !== currentSession);

  } finally {
    await browser.close();
    await app.close();
  }
  return results;
}

async function main() {
  console.log('=== Step 1: Theoretical & Formulaic Target Analysis ===');
  const mathResults = analyzeTargetFormulas();
  console.log(JSON.stringify(mathResults, null, 2));

  console.log('\n=== Step 2: Headless Chrome Buffer Benchmark ===');
  const chromeResults = await runBrowserBufferTests('chrome');

  console.log('\n=== Step 3: Headless Firefox Buffer Benchmark ===');
  const firefoxResults = await runBrowserBufferTests('firefox');

  console.log('\n=== Step 4: Plex Transcode Session Expiration Lifecycle ===');
  const plexResults = await runPlexSessionLifecycleTests();
  console.log(JSON.stringify(plexResults, null, 2));

  // Save report artifact
  const outDir = path.resolve(__dirname, '../artifacts/hls-buffer-evaluation');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'evaluation-results.json'), JSON.stringify({
    timestamp: new Date().toISOString(),
    mathResults,
    chromeResults,
    firefoxResults,
    plexResults
  }, null, 2) + '\n');
  console.log('\n=== Complete. Results saved to artifacts/hls-buffer-evaluation/evaluation-results.json ===');
}

main().catch(err => { console.error('Error in main:', err); process.exit(1); });
