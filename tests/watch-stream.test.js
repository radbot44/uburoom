'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { watchHttp } = require('../server/watch-http');

for (const kind of ['demo', 'plex']) test(kind + ' periodic login-check rejection ends only the affected stream', async t => {
  const checks = new Set();
  t.mock.method(globalThis, 'setInterval', callback => { checks.add(callback); return callback; });
  t.mock.method(globalThis, 'clearInterval', callback => checks.delete(callback));
  const sources = [];
  if (kind === 'demo') {
    t.mock.method(fs, 'statSync', () => ({ size: 100 }));
    t.mock.method(fs, 'createReadStream', () => { const source = new PassThrough(); sources.push(source); source.write('x'); return source; });
  }
  const roomId = randomUUID(), viewerId = randomUUID(), media = { kind, format: 'file', file: 'fixture', start: 'http://plex.invalid/file', resources: new Map() };
  const room = { s: { roomId }, mediaVersion: randomUUID(), viewers: new Map([[viewerId, { userId: 'host', media, streamVersion: randomUUID() }]]) };
  const identity = { userId: 'host', name: 'Host', csrf: 'csrf' };
  let rejectLogin = false, upstreamAborts = 0;
  const routes = watchHttp({ config: { publicUrl: 'https://localhost' },
    watch: { rooms: new Map([[roomId, room]]), canView: async () => true, snapshot: () => ({}), prepareViewer: async () => {},
      plex: { request: async (url, options) => new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array([120]));
        options.signal.addEventListener('abort', () => { upstreamAborts++; controller.error(new Error('Access check failed')); }, { once: true });
      } }), { headers: { 'Content-Type': 'video/mp4' } }) } },
    hub: { access: { isMember: () => true } }, user: async () => { if (rejectLogin) throw new Error('Discord renewal unavailable'); return identity; },
    webActor: value => value, cookies: () => ({ uburoom: 'fixture-cookie' }), throttle: () => true,
    json: (res, status, value) => { res.status = status; res.end(JSON.stringify(value)); } });
  t.after(() => routes.close());
  const headers = { origin: 'https://localhost', 'x-csrf-token': 'csrf' };
  const snapshot = await routes.execute({ headers }, '/api/watch/rooms/' + roomId + '?viewer=' + viewerId);
  assert.equal(snapshot.status, 200);
  const res = new PassThrough(); res.writeHead = status => { res.status = status; res.headersSent = true; };
  const received = new Promise(resolve => res.once('data', resolve));
  const streaming = routes.route({ method: 'GET', headers }, res, new URL(snapshot.value.mediaUrl, 'https://localhost'));
  await received;
  rejectLogin = true;
  assert.equal(checks.size, 1);
  await [...checks][0](); // A rejected renewal must be caught inside the timer.
  await streaming;
  assert.equal(res.destroyed, true); assert.equal(checks.size, 0);
  if (kind === 'demo') assert.equal(sources[0].destroyed, true);
  else assert.equal(upstreamAborts, 1);
  rejectLogin = false;
  const healthy = new PassThrough(); healthy.writeHead = status => { healthy.status = status; };
  healthy.resume();
  await routes.route({ method: 'HEAD', headers }, healthy, new URL(snapshot.value.mediaUrl, 'https://localhost'));
  assert.equal(healthy.status, 200, 'another authorized request remains usable');
  assert.equal(room.viewers.get(viewerId).media, media, 'a failed resource does not mutate room media');
});
