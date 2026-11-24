'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { test } = require('node:test');

const { planDelivery } = require('../server/delivery-plan');
const { createStaticFiles } = require('../server/http/static');
const Engine = require('../shared/engine.mjs');
const PlaybackPolicy = require('../shared/playback-policy.mjs');
const WireProtocol = require('../shared/wire-protocol.mjs');

test('DeliveryPlan and playback-policy preserve route=file for clientRemux Original streams', () => {
  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 3,
      remux: true,
      clientRemux: true,
      outputs: ['av1', 'provider'],
    }),
    { route: 'file', reason: 'original' },
  );

  assert.deepEqual(
    planDelivery({
      quality: 'direct',
      compatible: false,
      burn: false,
      audioTracks: 3,
      remux: true,
      clientRemux: false,
      outputs: ['av1', 'provider'],
    }),
    { route: 'remux', reason: 'multiple-audio' },
  );

  const canPlayMp4Only = mime => (/^video\/mp4/i.test(mime) && /avc1|hvc1/i.test(mime) ? 'probably' : '');
  const dtsMkvSource = {
    format: 'file',
    container: 'mkv',
    videoCodec: 'h264',
    audioCodec: 'dca',
    bitDepth: 8,
    hdr: false,
    tracks: { audio: [{ id: 'a1' }, { id: 'a2' }] },
  };
  assert.equal(PlaybackPolicy.needsCompatible(dtsMkvSource, canPlayMp4Only, null, 'auto', false), true);
  assert.equal(PlaybackPolicy.needsCompatible(dtsMkvSource, canPlayMp4Only, null, 'auto', true), false);
  assert.equal(PlaybackPolicy.needsClientRemux(dtsMkvSource, canPlayMp4Only), true);
});

test('media.delivery.set command and clientRemux join preference validate cleanly', () => {
  const mediaVersion = randomUUID();
  const validLocal = Engine.validate({
    action: 'media.delivery.set',
    args: { mode: 'local', mediaVersion },
  });
  assert.equal(validLocal.args.mode, 'local');
  assert.equal(validLocal.args.mediaVersion, mediaVersion);

  const validAuto = Engine.validate({
    action: 'media.delivery.set',
    args: { mode: 'auto', mediaVersion },
  });
  assert.equal(validAuto.args.mode, 'auto');

  assert.equal(
    WireProtocol.clientMessageError({
      type: 'join',
      id: 1,
      roomId: randomUUID(),
      viewerId: randomUUID(),
      preferences: { quality: 'direct', clientRemux: true, delivery: 'local' },
    }),
    undefined,
  );
});

test('static file server sets wasm-unsafe-eval CSP on watch-file-worker.js and immutable caching on versioned libav wasm', async () => {
  const staticFiles = createStaticFiles({ config: {} });
  const staticRoute = staticFiles.routes().find(r => r.name === 'static files');

  const serve = async route => {
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

  const worker = await serve('/watch-file-worker.js');
  assert.equal(worker.status, 200);
  assert.match(worker.headers['content-security-policy'] || '', /wasm-unsafe-eval/);
  assert.equal(worker.headers['cache-control'], 'public, no-cache');

  const wasm = await serve('/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.wasm');
  assert.equal(wasm.status, 200);
  assert.equal(wasm.headers['content-type'], 'application/wasm');
  assert.equal(wasm.headers['cache-control'], 'public, max-age=31536000, immutable');

  const wrapper = await serve('/vendor/libav/libav-uburoom.mjs');
  assert.equal(wrapper.status, 200);
  assert.match(wrapper.headers['content-security-policy'] || '', /wasm-unsafe-eval/);
  assert.equal(wrapper.headers['cache-control'], 'public, no-cache');
});
