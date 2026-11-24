'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const { planDelivery } = require('../server/delivery-plan');
const { createStaticFiles } = require('../server/http/static');
const { pageBootstrap } = require('../server/http/watch/bootstrap');
const Engine = require('../shared/engine.mjs');
const PlaybackPolicy = require('../shared/playback-policy.mjs');
const WireProtocol = require('../shared/wire-protocol.mjs');

test('DeliveryPlan and playback-policy preserve route=file for UbuPlayer Original streams including dovi-p5 and HDR-on-SDR', () => {
  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 3,
      remux: true,
      ubuplayer: true,
      ubuplayerAllowed: true,
      outputs: ['av1', 'provider'],
    }),
    { route: 'file', reason: 'original' },
  );

  // Operator ubuplayerAllowed=false overrides client-advertised ubuplayer/clientRemux
  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 3,
      remux: true,
      ubuplayer: true,
      clientRemux: true,
      ubuplayerAllowed: false,
      outputs: ['av1', 'provider'],
    }),
    { route: 'remux', reason: 'multiple-audio' },
  );

  // Server-side dovi-p5 and HDR-on-SDR planDelivery checks
  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 1,
      hdr: true,
      hdrKind: 'dovi-p5',
      hdrDisplay: false,
      ubuplayer: true,
      gpuTonemap: true,
      ubuplayerAllowed: true,
      outputs: ['av1', 'provider'],
    }),
    { route: 'file', reason: 'original' },
  );
  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 1,
      hdr: true,
      hdrKind: 'dovi-p5',
      hdrDisplay: false,
      ubuplayer: true,
      gpuTonemap: true,
      ubuplayerAllowed: false,
      outputs: ['av1', 'provider'],
    }),
    { route: 'local', codec: 'av1', reason: 'compatible' },
  );

  const canPlayMp4Only = mime => (/^video\/mp4/i.test(mime) && /avc1|hvc1/i.test(mime) ? 'probably' : '');
  const sdrScreen = () => ({ matches: false });

  const dtsMkvSource = {
    format: 'file',
    container: 'mkv',
    videoCodec: 'h264',
    audioCodec: 'dca',
    bitDepth: 8,
    hdr: false,
    tracks: { audio: [{ id: 'a1' }, { id: 'a2' }] },
  };
  assert.equal(PlaybackPolicy.needsCompatible(dtsMkvSource, canPlayMp4Only, sdrScreen, 'auto', false), true);
  assert.equal(
    PlaybackPolicy.needsCompatible(dtsMkvSource, canPlayMp4Only, sdrScreen, 'auto', {
      ubuplayer: true,
      gpuTonemap: true,
    }),
    false,
  );
  assert.equal(
    PlaybackPolicy.needsUbuPlayer(dtsMkvSource, canPlayMp4Only, sdrScreen, 'auto', { gpuTonemap: true }),
    true,
  );

  // Dolby Vision Profile 5 stays on Original (route: file) when UbuPlayer + GPU tonemapping are active
  const doviP5Source = {
    format: 'file',
    container: 'mp4',
    videoCodec: 'hevc',
    audioCodec: 'eac3',
    bitDepth: 10,
    hdr: true,
    hdrKind: 'dovi-p5',
  };
  assert.equal(PlaybackPolicy.needsCompatible(doviP5Source, canPlayMp4Only, sdrScreen, 'auto', false), true);
  assert.equal(
    PlaybackPolicy.needsCompatible(doviP5Source, canPlayMp4Only, sdrScreen, 'auto', {
      ubuplayer: true,
      gpuTonemap: false,
    }),
    true,
  );
  assert.equal(
    PlaybackPolicy.needsCompatible(doviP5Source, canPlayMp4Only, sdrScreen, 'auto', {
      ubuplayer: true,
      gpuTonemap: true,
    }),
    false,
  );
  assert.equal(
    PlaybackPolicy.needsUbuPlayer(doviP5Source, canPlayMp4Only, sdrScreen, 'auto', { gpuTonemap: true }),
    true,
  );

  // HDR10 on an SDR screen (or forced SDR mode) stays on Original when UbuPlayer GPU tonemapping is active
  const hdr10Source = {
    format: 'file',
    container: 'mkv',
    videoCodec: 'hevc',
    audioCodec: 'truehd',
    bitDepth: 10,
    hdr: true,
    hdrKind: 'hdr10',
  };
  assert.equal(PlaybackPolicy.needsCompatible(hdr10Source, canPlayMp4Only, sdrScreen, 'sdr', false), true);
  assert.equal(
    PlaybackPolicy.needsCompatible(hdr10Source, canPlayMp4Only, sdrScreen, 'sdr', {
      ubuplayer: true,
      gpuTonemap: true,
    }),
    false,
  );
});

test('media.delivery.set, media.quality.set ubuplayer/gpuTonemap, and bootstrap publicConfig validate cleanly', () => {
  const mediaVersion = randomUUID();
  const validLocal = Engine.validate({
    action: 'media.delivery.set',
    args: { mode: 'local', mediaVersion },
  });
  assert.equal(validLocal.args.mode, 'local');
  assert.equal(validLocal.args.mediaVersion, mediaVersion);

  const validQuality = Engine.validate({
    action: 'media.quality.set',
    args: { quality: 'direct', ubuplayer: true, gpuTonemap: true, reset: true },
  });
  assert.equal(validQuality.args.ubuplayer, true);
  assert.equal(validQuality.args.gpuTonemap, true);

  assert.equal(
    WireProtocol.clientMessageError({
      type: 'join',
      id: 1,
      roomId: randomUUID(),
      viewerId: randomUUID(),
      preferences: { quality: 'direct', ubuplayer: true, gpuTonemap: true, clientRemux: true, delivery: 'local' },
    }),
    undefined,
  );

  const makeBootstrap = cfg =>
    pageBootstrap({
      config: { diagnostics: { keepDays: 0 }, ...cfg },
      watch: { providers: { summary: () => [], list: [] } },
      hub: { guestsEnabled: () => false },
    }).publicConfig();

  assert.equal(makeBootstrap({}).ubuplayer, true);
  assert.equal(makeBootstrap({ ubuplayer: false }).ubuplayer, false);
  assert.equal(makeBootstrap({ transcoding: { ubuplayer: false } }).ubuplayer, false);
});

test('static file server gates wasm-unsafe-eval CSP on ubuplayer-worker.js by config.ubuplayer and caches libav wasm immutably', async () => {
  const serveWithConfig = async (cfg, route) => {
    const staticFiles = createStaticFiles({ config: cfg });
    const staticRoute = staticFiles.routes().find(r => r.name === 'static files');
    const asset = await staticFiles.lookup(route);
    assert.ok(asset, `expected static asset for ${route}`);
    const headers = {};
    let status = 0;
    const res = {
      setHeader(k, v) {
        headers[k.toLowerCase()] = v;
      },
      writeHead(code, map) {
        status = code;
        for (const [k, v] of Object.entries(map || {})) headers[k.toLowerCase()] = v;
      },
      end() {},
    };
    await staticRoute.handle({ req: { method: 'HEAD', headers: {} }, res, route }, asset);
    return { status, headers };
  };

  const workerEnabled = await serveWithConfig({ ubuplayer: true }, '/ubuplayer-worker.js');
  assert.equal(workerEnabled.status, 200);
  assert.match(workerEnabled.headers['content-security-policy'] || '', /wasm-unsafe-eval/);
  assert.equal(workerEnabled.headers['cache-control'], 'public, no-cache');

  const workerDisabled = await serveWithConfig({ ubuplayer: false }, '/ubuplayer-worker.js');
  assert.equal(workerDisabled.status, 200);
  assert.doesNotMatch(workerDisabled.headers['content-security-policy'] || '', /wasm-unsafe-eval/);

  const wasm = await serveWithConfig({ ubuplayer: true }, '/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  assert.equal(wasm.headers['cache-control'], 'public, max-age=31536000, immutable');

  const wrapperEnabled = await serveWithConfig({ ubuplayer: true }, '/vendor/libav/libav-uburoom.mjs');
  assert.equal(wrapperEnabled.status, 200);
  assert.match(wrapperEnabled.headers['content-security-policy'] || '', /wasm-unsafe-eval/);

  const wrapperDisabled = await serveWithConfig({ ubuplayer: false }, '/vendor/libav/libav-uburoom.mjs');
  assert.equal(wrapperDisabled.status, 200);
  assert.doesNotMatch(wrapperDisabled.headers['content-security-policy'] || '', /wasm-unsafe-eval/);
});
