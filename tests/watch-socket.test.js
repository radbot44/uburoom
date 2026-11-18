'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  https = require('node:https');
const { randomUUID } = require('node:crypto'),
  { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { requestByPath, hello } = require('./helpers/wire-paths');
const { PROTOCOL_VERSION, serverMessageError } = require('../shared/wire-protocol.mjs');
const certFile = path.join(__dirname, '../certs/server-cert.pem');

async function fixture(t, appOptions = {}) {
  const cert = fs.readFileSync(certFile),
    config = {
      cert,
      key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
      publicUrl: 'https://localhost:6768',
      ownerId: 'demo-host',
      guildId: 'guild',
      channels: ['commands'],
      demo: true,
    };
  config.clientId = 'fixture';
  config.clientSecret = 'fixture-secret';
  const app = createApp(config, {
    ...appOptions,
    oauthFetch: async url =>
      new Response(
        JSON.stringify(
          String(url).endsWith('/token')
            ? { access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600 }
            : { id: 'demo-host', username: 'Host' },
        ),
      ),
  });
  let allowed = true;
  app.access.connect({ isMember: () => allowed, refresh: async () => allowed, options: () => ({ available: true }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = 'https://localhost:' + app.server.address().port;
  t.after(() => app.close());
  const login = persona =>
    new Promise((resolve, reject) => {
      const req = https.request(
        config.publicUrl + '/api/watch/demo-login',
        { method: 'POST', ca: cert, headers: { Origin: config.publicUrl, 'Content-Type': 'application/json' } },
        res => {
          let raw = '';
          res.on('data', bytes => (raw += bytes));
          res.on('end', () => resolve(JSON.parse(raw)));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ persona }));
    });
  async function connect(identity, origin = config.publicUrl, cookie) {
    const ws = new WebSocket(config.publicUrl.replace('https:', 'wss:') + '/watch-socket', {
      ca: cert,
      origin,
      headers: cookie ? { Cookie: cookie } : {},
    });
    const events = [],
      waiting = new Map();
    let sequence = 0;
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      events.push(message);
      assert.equal(serverMessageError(message), undefined, 'the server sends only well-formed messages');
      if (message.type === 'ack' || (message.type === 'error' && message.id !== undefined)) {
        const pending = waiting.get(message.id);
        if (pending) {
          waiting.delete(message.id);
          pending(message);
        }
      }
    });
    await once(ws, 'open');
    const authenticated = once(ws, 'message');
    ws.send(JSON.stringify(hello({ token: identity.token, csrf: identity.csrf })));
    const authMessage = JSON.parse((await authenticated)[0]);
    assert.equal(authMessage.type, 'welcome');
    assert.equal(authMessage.protocol, PROTOCOL_VERSION);
    assert.ok(Number.isSafeInteger(authMessage.connectionId) && authMessage.connectionId > 0);
    const ping = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'clock', id: 0 }));
    }, 1000);
    t.after(() => clearInterval(ping));
    return {
      ws,
      connectionId: authMessage.connectionId,
      events,
      stopClock: () => clearInterval(ping),
      send: message =>
        new Promise(resolve => {
          const id = ++sequence;
          waiting.set(id, resolve);
          ws.send(JSON.stringify({ ...message, id }));
        }),
      // Requests named by resource path, as these tests were written (helpers/wire-paths.js).
      async call(route, data) {
        const { status, body } = await requestByPath(this.send, route, data);
        return { status, value: body };
      },
    };
  }
  return {
    app,
    config,
    cert,
    login,
    connect,
    revoke: () => {
      allowed = false;
    },
  };
}
const tls = { skip: !fs.existsSync(certFile) };

test('authenticated sockets have distinct server connection IDs', tls, async t => {
  const f = await fixture(t),
    identity = await f.login('host');
  const first = await f.connect(identity),
    second = await f.connect(identity);
  t.after(() => {
    first.ws.close();
    second.ws.close();
  });
  assert.notEqual(first.connectionId, second.connectionId);
  assert.ok(second.connectionId > first.connectionId);
  await new Promise(resolve => {
    const check = () => {
      if (first.events.some(e => e.type === 'lobby')) resolve();
      else setTimeout(check, 50);
    };
    check();
  });
  assert.equal(first.events.filter(e => e.type === 'lobby').length, 1);
  await new Promise(r => setTimeout(r, 1200));
  assert.equal(first.events.filter(e => e.type === 'lobby').length, 1, 'an unchanged lobby is not sent again');
});

test(
  'abnormal socket close retains viewer media and grant for prompt reconnect, then expires normally',
  tls,
  async t => {
    const f = await fixture(t),
      identity = await f.login('host'),
      first = await f.connect(identity);
    t.after(() => first.ws.terminate());
    const roomId = (await first.call('/api/watch/rooms', {})).value.id,
      viewerId = randomUUID(),
      route = '/api/watch/rooms/' + roomId;
    const initial = (await first.call(route + '?viewer=' + viewerId)).value;
    const loaded = await first.call(route + '/command', {
      epoch: initial.epoch,
      expiresAt: Date.now() + 2500,
      viewerId,
      command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
    });
    assert.equal(loaded.value.status, 'applied');
    const before = (await first.call(route + '?viewer=' + viewerId)).value;
    assert.ok(before.mediaUrl, 'media grant exists before disconnect');
    const room = f.app.watch.rooms.get(roomId),
      viewer = room.viewers.get(viewerId),
      media = viewer.media,
      oldSocket = viewer.watchSocket;
    assert.ok(media, 'server prepared viewer output');
    const disconnected = once(first.ws, 'close'),
      serverDisconnected = once(oldSocket, 'close');
    first.ws.terminate();
    await Promise.all([disconnected, serverDisconnected]);
    assert.equal(room.viewers.get(viewerId), viewer, 'abnormal closure does not evict the viewer');
    assert.equal(viewer.media, media, 'output survives unexpected close');
    assert.equal(await viewer.alive(), false, 'the old socket is no longer a live control transport');
    assert.equal(
      await viewer.reportingAuthorized(),
      true,
      'a closed socket does not revoke reporting credentials during grace',
    );
    assert.equal(room.disconnectedViewers.has(viewerId), false, 'no cold-rejoin record was created');
    const replacement = await f.connect(identity);
    t.after(() => replacement.ws.terminate());
    const after = (await replacement.call(route + '?viewer=' + viewerId)).value;
    assert.equal(room.viewers.get(viewerId), viewer, 'same viewer instance reattaches');
    assert.equal(viewer.media, media, 'Plex/media session is reused');
    assert.equal(after.streamVersion, before.streamVersion, 'no stream replacement');
    assert.equal(after.mediaUrl, before.mediaUrl, 'existing media grant stays usable');
    assert.equal(after.observationEpoch, before.observationEpoch, 'observation context remains stable');
    assert.notEqual(viewer.watchSocket, oldSocket, 'replacement server socket now owns viewer');
    assert.equal(viewer.watchSocket.readyState, 1);
    const lostAgain = once(replacement.ws, 'close'),
      serverLostAgain = once(viewer.watchSocket, 'close');
    replacement.ws.terminate();
    await Promise.all([lostAgain, serverLostAgain]);
    assert.equal(room.viewers.get(viewerId), viewer);
    viewer.at = Date.now() - 11000;
    f.app.watch.review(room);
    assert.equal(room.viewers.has(viewerId), false, 'normal presence expiry releases the abandoned viewer');
    assert.equal(room.disconnectedViewers.has(viewerId), true, 'cold reconnect still needs a new stream');
  },
);

test('native WebSocket pongs retain room presence without JavaScript clock messages', tls, async t => {
  // A one-second idle deadline, pinged every 100 ms, stands in for the production ten seconds.
  const f = await fixture(t, { socketTiming: { idleMs: 1000, livenessMs: 100 } }),
    host = await f.connect(await f.login('host'));
  t.after(() => host.ws.close());
  host.stopClock();
  const roomId = (await host.call('/api/watch/rooms', {})).value.id,
    viewer = randomUUID();
  await host.call('/api/watch/rooms/' + roomId + '?viewer=' + viewer);
  await new Promise(resolve => setTimeout(resolve, 2500));
  assert.equal(host.ws.readyState, 1, 'a throttled tab remains connected beyond the idle deadline');
  const presence = f.app.watch.rooms.get(roomId)?.viewers.get(viewer);
  assert.ok(presence, 'same viewer survives');
  assert.ok(Date.now() - presence.at < 500, 'native pongs refresh viewer presence');
  f.revoke();
  const closed = once(host.ws, 'close');
  assert.equal((await closed)[0], 4003, 'server publication still rechecks authorization without client clocks');
});

test('lobby browsing needs no room; private creation never exposes the room to another member', tls, async t => {
  const f = await fixture(t),
    host = await f.connect(await f.login('host')),
    guest = await f.connect(await f.login('guest'));
  assert.equal((await guest.call('/api/watch/library')).status, 200);
  assert.equal(f.app.watch.rooms.size, 0, 'browsing does not create a room');
  assert.equal((await host.call('/api/watch/rooms', { visibility: 'invalid' })).status, 400);
  assert.equal(f.app.watch.rooms.size, 0);
  const roomId = (await host.call('/api/watch/rooms', { visibility: 'private' })).value.id;
  assert.equal(f.app.watch.rooms.get(roomId).visibility, 'private');
  assert.equal(Object.hasOwn(f.app.watch.rooms.get(roomId), 'enabled'), false);
  assert.deepEqual((await guest.call('/api/watch/rooms')).value.rooms, []);
  assert.equal((await guest.call('/api/watch/rooms/' + roomId + '?viewer=' + randomUUID())).status, 403);
  assert.equal((await guest.call('/api/watch/library?room=' + roomId)).status, 403);
  assert.equal((await guest.call('/api/watch/library?room=missing')).status, 403);
  assert.equal((await guest.call('/api/watch/library?session=' + roomId)).status, 403);
  assert.equal((await guest.call('/api/watch/library')).status, 200, 'lobby reads do not grant room control');
  host.ws.close();
  guest.ws.close();
});
test(
  'watch socket pushes shared Engine commands, rejects stale/foreign viewers, hides private rooms and preserves reconnect security',
  tls,
  async t => {
    const f = await fixture(t),
      host = await f.connect(await f.login('host'));
    let guest = await f.connect(await f.login('guest'));
    const roomId = (await host.call('/api/watch/rooms', {})).value.id,
      viewer = randomUUID(),
      guestId = randomUUID();
    const target = '/api/watch/rooms/' + roomId;
    let state = (await host.call(target + '?viewer=' + viewer)).value;
    await guest.call(target + '?viewer=' + guestId);
    const command = (client, command, extra = {}) =>
      client.call(target + '/command', {
        epoch: state.epoch,
        expiresAt: Date.now() + 2500,
        viewerId: viewer,
        command,
        ...extra,
      });
    assert.equal(
      (await command(guest, { action: 'media.pause' })).status,
      400,
      'a different account cannot claim the host viewer',
    );
    assert.equal(
      (
        await command(
          host,
          { action: 'room.visibility', args: { visibility: 'public' } },
          { expiresAt: Date.now() - 1 },
        )
      ).status,
      409,
    );
    const before = guest.events.length;
    assert.equal(
      (await command(host, { action: 'room.visibility', args: { visibility: 'public' } })).value.status,
      'applied',
    );
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(
      guest.events.slice(before).some(message => message.type === 'room' && message.state.visibility === 'public'),
      'other viewer receives a pushed state without requesting it',
    );
    state = (await host.call(target + '?viewer=' + viewer)).value;
    assert.equal(state.visibility, 'public');
    const guestClosed = once(guest.ws, 'close');
    guest.ws.close(1000);
    await guestClosed;
    await new Promise(resolve => setTimeout(resolve, 30));
    const closed = once(host.ws, 'close');
    host.ws.close(1000);
    await closed;
    await new Promise(resolve => setTimeout(resolve, 30));
    const room = f.app.watch.rooms.get(roomId);
    assert.equal(Object.hasOwn(room, 'enabled'), false);
    assert.ok(room.disconnectedViewers.has(viewer));
    const rejoined = await f.connect(await f.login('host'));
    state = (await rejoined.call(target + '?viewer=' + viewer)).value;
    assert.equal(Object.hasOwn(state, 'enabled'), false, 'rejoined watch state has no obsolete consent field');
    guest = await f.connect(await f.login('guest'));
    await guest.call(target + '?viewer=' + guestId);
    assert.equal(
      (await command(rejoined, { action: 'room.visibility', args: { visibility: 'private' } })).value.status,
      'applied',
    );
    assert.deepEqual((await guest.call('/api/watch/rooms')).value.rooms, []);
    assert.equal((await guest.call(target + '?viewer=' + guestId)).status, 403);
    f.revoke();
    const denied = once(rejoined.ws, 'close');
    rejoined.ws.send(JSON.stringify({ type: 'clock', id: 999 }));
    assert.equal((await denied)[0], 4003);
  },
);

test(
  "watch socket accepts only a viewer's current ephemeral synchronization telemetry and preserves its last rating",
  tls,
  async t => {
    const f = await fixture(t),
      host = await f.connect(await f.login('host')),
      guest = await f.connect(await f.login('guest'));
    t.after(() => {
      host.ws.close();
      guest.ws.close();
    });
    const roomId = (await host.call('/api/watch/rooms', {})).value.id,
      hostViewer = randomUUID(),
      guestViewer = randomUUID(),
      path = '/api/watch/rooms/' + roomId;
    await host.call(path + '?viewer=' + hostViewer);
    await guest.call(path + '?viewer=' + guestViewer);
    const room = f.app.watch.rooms.get(roomId),
      hostPresence = room.viewers.get(hostViewer);
    const mediaVersion = room.mediaVersion,
      streamVersion = randomUUID();
    hostPresence.streamVersion = streamVersion;
    host.ws.send(
      JSON.stringify({
        type: 'quality',
        roomId,
        viewerId: hostViewer,
        mediaVersion,
        streamVersion,
        status: 'playing',
        score: 1.5,
        confidence: 'confident',
        measurementFreshnessMs: 300,
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(hostPresence.syncQuality.score, 1, 'valid scores are clamped');
    assert.equal(hostPresence.syncQuality.lastKnownScore, 1);
    assert.equal(hostPresence.syncQuality.lastKnownLevel, 'excellent');
    assert.equal(hostPresence.syncQuality.confidence, 'confident');
    assert.ok(hostPresence.syncQuality.measurementFreshnessMs >= 300);
    const firstMeasuredAt = hostPresence.syncQuality.measuredAt,
      firstKnownAt = hostPresence.syncQuality.lastKnownAt;
    await host.call(path + '?viewer=' + hostViewer);
    assert.equal(hostPresence.syncQuality.score, 1, 'the current viewer retains its ephemeral score');
    assert.equal(Object.hasOwn(room, 'syncQuality'), false, 'the score is separate from durable room state');
    // The viewer spread is for the people who run the room.
    room.syncSpread = { mediaVersion, samples: [], taken: 12, summary: { p50Ms: 5, p95Ms: 9 } };
    assert.deepEqual((await host.call(path + '?viewer=' + hostViewer)).value.syncSpread, { p50Ms: 5, p95Ms: 9 });
    assert.equal(Object.hasOwn((await guest.call(path + '?viewer=' + guestViewer)).value, 'syncSpread'), false);
    // Telemetry already in flight when a viewer leaves must not cost the socket.
    host.ws.send(
      JSON.stringify({
        type: 'quality',
        roomId,
        viewerId: randomUUID(),
        mediaVersion,
        streamVersion,
        status: 'paused',
        reason: 'paused',
      }),
    );
    assert.equal(
      (await host.call(path + '?viewer=' + hostViewer)).status,
      200,
      'stale telemetry keeps the control socket',
    );
    const guestClosed = once(guest.ws, 'close');
    guest.ws.send(
      JSON.stringify({
        type: 'quality',
        roomId,
        viewerId: hostViewer,
        mediaVersion,
        streamVersion,
        status: 'playing',
        score: 0.1,
      }),
    );
    assert.equal((await guestClosed)[0], 4003, 'a viewer cannot claim another viewer identity');
    assert.equal(hostPresence.syncQuality.score, 1, 'the foreign update did not change the owner score');
    await new Promise(resolve => setTimeout(resolve, 550));
    host.ws.send(
      JSON.stringify({
        type: 'quality',
        roomId,
        viewerId: hostViewer,
        mediaVersion,
        streamVersion,
        status: 'paused',
        reason: 'paused',
        measurementFreshnessMs: 0,
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(hostPresence.syncQuality.status, 'paused');
    assert.equal(hostPresence.syncQuality.score, 1);
    assert.equal(hostPresence.syncQuality.lastKnownScore, 1, 'temporary unavailability preserves the last score');
    assert.equal(hostPresence.syncQuality.lastKnownLevel, 'excellent');
    assert.equal(hostPresence.syncQuality.confidence, 'reduced');
    assert.equal(hostPresence.syncQuality.measuredAt, firstMeasuredAt);
    assert.equal(
      hostPresence.syncQuality.lastKnownAt,
      firstKnownAt,
      'reporting a retained score must not refresh evidence time',
    );
    await new Promise(resolve => setTimeout(resolve, 550));
    // A five-minute-old paused measurement must not invalidate an otherwise healthy viewer socket.
    host.ws.send(
      JSON.stringify({
        type: 'quality',
        roomId,
        viewerId: hostViewer,
        mediaVersion,
        streamVersion,
        status: 'seeking',
        score: 0.995,
        confidence: 'reduced',
        measurementFreshnessMs: 301000,
      }),
    );
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(host.ws.readyState, WebSocket.OPEN, 'stale measurement age must not disconnect the viewer');
    assert.equal(hostPresence.syncQuality.status, 'seeking', 'stale age is ignored but the report is accepted');
    assert.equal(hostPresence.syncQuality.measuredAt, firstMeasuredAt, 'old telemetry must not refresh evidence time');
    assert.equal(
      hostPresence.syncQuality.score,
      0.995,
      'minor percentage changes update the stored score without changing its band',
    );
    assert.equal(hostPresence.syncQuality.lastKnownLevel, 'excellent');
    assert.equal(hostPresence.syncQuality.lastKnownAt, firstKnownAt);
  },
);

test(
  'watch socket validates upgrade paths, origin, and credentials, destroying invalid sockets promptly',
  tls,
  async t => {
    const f = await fixture(t);
    const baseWss = f.config.publicUrl.replace('https:', 'wss:');

    // Cross-origin upgrade rejection
    const foreign = new WebSocket(baseWss + '/watch-socket', { ca: f.cert, origin: 'https://elsewhere.invalid' });
    foreign.on('error', () => {});
    await new Promise(resolve => foreign.once('close', resolve));

    // Invalid auth credentials
    for (const auth of [hello({ token: 'a'.repeat(64) }), hello({ csrf: 'b'.repeat(64) })]) {
      const ws = new WebSocket(baseWss + '/watch-socket', { ca: f.cert, origin: f.config.publicUrl });
      await once(ws, 'open');
      const closed = once(ws, 'close');
      ws.send(JSON.stringify(auth));
      assert.equal((await closed)[0], 4003);
    }

    // A client speaking another protocol version is told so before any sign-in.
    for (const outdated of [
      { type: 'auth', token: 'a'.repeat(64) },
      { ...hello({}), protocol: PROTOCOL_VERSION + 1 },
    ]) {
      const ws = new WebSocket(baseWss + '/watch-socket', { ca: f.cert, origin: f.config.publicUrl });
      await once(ws, 'open');
      const told = once(ws, 'message'),
        closed = once(ws, 'close');
      ws.send(JSON.stringify(outdated));
      const message = JSON.parse((await told)[0]);
      assert.equal(message.type, 'error');
      assert.equal(message.code, 'protocol');
      assert.deepEqual(message.supported, [PROTOCOL_VERSION]);
      assert.equal((await closed)[0], 4010);
    }

    // Unsupported upgrade paths and query variants destroyed promptly
    for (const target of ['/wrong-path', '/watch-socket?variant=1', '/watch-socket/extra', '/']) {
      const ws = new WebSocket(baseWss + target, { ca: f.cert, origin: f.config.publicUrl });
      t.after(() => {
        try {
          ws.terminate();
        } catch {}
      });
      ws.on('error', () => {});
      const closed = await Promise.race([
        new Promise(resolve => ws.once('close', () => resolve(true))),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Upgrade socket hung on ' + target)), 1500)),
      ]);
      assert.equal(closed, true);
    }
    const valid = await f.connect(await f.login('host'));
    t.after(() => valid.ws.close());
    assert.equal(valid.ws.readyState, 1);
  },
);

test('cookie socket authentication requires CSRF and logout invalidates the active connection', tls, async t => {
  const f = await fixture(t);
  const http = (route, headers = {}, data) =>
    new Promise((resolve, reject) => {
      const req = https.request(
        f.config.publicUrl + route,
        {
          ca: f.cert,
          method: data === undefined ? 'GET' : 'POST',
          headers: { Origin: f.config.publicUrl, 'Content-Type': 'application/json', ...headers },
        },
        res => {
          let raw = '';
          res.on('data', bytes => (raw += bytes));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              raw,
              value: res.headers['content-type']?.includes('json') ? JSON.parse(raw) : undefined,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  const begin = await http('/auth/discord'),
    state = new URL(begin.headers.location).searchParams.get('state');
  const auth = await http('/auth/callback?code=fixture&state=' + state, {
    Cookie: begin.headers['set-cookie'][0].split(';')[0],
  });
  const cookie = auth.headers['set-cookie'][0].split(';')[0],
    identity = (await http('/api/watch/me', { Cookie: cookie })).value;
  const bad = new WebSocket(f.config.publicUrl.replace('https:', 'wss:') + '/watch-socket', {
    ca: f.cert,
    origin: f.config.publicUrl,
    headers: { Cookie: cookie },
  });
  await once(bad, 'open');
  const closed = once(bad, 'close');
  bad.send(JSON.stringify(hello({ csrf: 'wrong' })));
  assert.equal((await closed)[0], 4003);
  const good = await f.connect(identity, f.config.publicUrl, cookie);
  const created = await good.call('/api/watch/rooms', {});
  assert.equal(created.status, 201);
  const clientId = f.config.clientId;
  f.config.clientId = '</script><script>bootstrapInjection()</script>&\u2028';
  const page = await http('/', { Cookie: cookie });
  const initial = JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(page.raw)[1]);
  assert.equal(page.headers['cache-control'], 'no-store', 'Personalized bootstrap cannot be shared by caches');
  assert.equal(initial.me.value.csrf, identity.csrf);
  assert.equal(initial.me.status, 200);
  assert.equal(initial.config.clientId, f.config.clientId);
  assert.ok(!page.raw.includes(f.config.clientId), 'Embedded JSON escapes script delimiters and separators');
  f.config.clientId = clientId;
  assert.ok(
    initial.rooms.value.rooms.some(room => room.id === created.value.id),
    'Page embeds authorized active rooms',
  );
  const signedOut = await http('/');
  const publicInitial = JSON.parse(
    /<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(signedOut.raw)[1],
  );
  assert.equal(publicInitial.me.status, 401);
  assert.equal(publicInitial.rooms, undefined, 'Signed-out pages never embed room data');
  assert.equal((await http('/api/logout', { Cookie: cookie, 'X-CSRF-Token': identity.csrf }, {})).status, 200);
  const staticRes = await http('/watch.js', { 'Accept-Encoding': 'br' });
  assert.equal(staticRes.headers['content-encoding'], 'br');
  assert.equal(staticRes.headers['cache-control'], 'public, no-cache');
  assert.equal(staticRes.headers['vary'], 'Accept-Encoding');
  assert.ok(staticRes.headers['etag']);
  const etag = staticRes.headers['etag'];
  const cachedRes = await http('/watch.js', { 'If-None-Match': etag });
  assert.equal(cachedRes.status, 304);
  assert.equal(cachedRes.headers['etag'], etag);
  assert.equal(cachedRes.raw, '');
  const gzipRes = await http('/watch.js', { 'Accept-Encoding': 'gzip' });
  assert.equal(gzipRes.headers['content-encoding'], 'gzip');
  const revoked = once(good.ws, 'close');
  good.ws.send(JSON.stringify({ type: 'clock', id: 100 }));
  assert.equal((await revoked)[0], 4003);
});

test('watch socket updates watchHeaders when client re-authenticates with renewed token', tls, async t => {
  const f = await fixture(t),
    identity = await f.login('host');
  const client = await f.connect(identity);
  t.after(() => client.ws.close());

  const roomId = (await client.call('/api/watch/rooms', {})).value.id;
  const viewerId = randomUUID();
  await client.call(`/api/watch/rooms/${roomId}?viewer=${viewerId}`);
  const viewer = f.app.watch.rooms.get(roomId).viewers.get(viewerId);
  assert.ok(viewer?.watchSocket);
  assert.equal(viewer.watchSocket.watchHeaders.authorization, 'Bearer ' + identity.token);

  const renewed = await f.login('host');
  assert.notEqual(renewed.token, identity.token);

  client.ws.send(JSON.stringify(hello({ token: renewed.token, csrf: renewed.csrf })));
  await new Promise(resolve => {
    const handler = raw => {
      const msg = JSON.parse(raw);
      if (msg.type === 'welcome') {
        client.ws.off('message', handler);
        resolve();
      }
    };
    client.ws.on('message', handler);
  });

  assert.equal(viewer.watchSocket.watchHeaders.authorization, 'Bearer ' + renewed.token);
});

test(
  'an idle room with ten viewers is sent no state between resyncs, and a change reaches only its room',
  tls,
  async t => {
    const f = await fixture(t);
    const identities = [await f.login('host'), await f.login('guest'), await f.login('guest2')];
    const tabs = [];
    for (let i = 0; i < 10; i++) tabs.push({ client: await f.connect(identities[i % 3]), viewerId: randomUUID() });
    const bystander = await f.connect(identities[1]);
    t.after(() => {
      for (const tab of tabs) tab.client.ws.terminate();
      bystander.ws.terminate();
    });
    const host = tabs[0],
      roomId = (await host.client.call('/api/watch/rooms', {})).value.id,
      route = '/api/watch/rooms/' + roomId;
    let state;
    for (const tab of tabs) {
      const joined = await tab.client.call(route + '?viewer=' + tab.viewerId + '&quality=direct');
      assert.equal(joined.status, 200);
    }
    // A host's further tabs rotate the room's command epoch; read it once everyone is in.
    state = (await host.client.call(route + '?viewer=' + host.viewerId)).value;
    const command = action =>
      host.client.call(route + '/command', {
        epoch: state.epoch,
        expiresAt: Date.now() + 2500,
        viewerId: host.viewerId,
        command: action,
      });
    assert.equal(
      (await command({ action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } })).value.status,
      'applied',
    );
    state = (await host.client.call(route + '?viewer=' + host.viewerId)).value;
    for (const tab of tabs)
      await tab.client.call(route + '/ready', {
        viewerId: tab.viewerId,
        mediaVersion: state.mediaVersion,
        ready: true,
        readinessVersion: state.readinessVersion,
      });
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(f.app.watch.rooms.get(roomId).state.paused, false, 'the room is playing');
    const pushes = client => client.events.filter(e => ['room', 'viewer', 'lobby'].includes(e.type));
    for (const tab of tabs) tab.client.events.length = 0;
    bystander.events.length = 0;
    // Three seconds of playback: clocks and pongs keep everyone present; nothing changes.
    await new Promise(resolve => setTimeout(resolve, 3000));
    for (const tab of tabs) {
      assert.ok(
        tab.client.events.some(e => e.type === 'clock'),
        'each tab kept exchanging clock samples',
      );
      assert.deepEqual(pushes(tab.client), [], 'an idle room pushes nothing');
    }
    assert.equal(f.app.watch.rooms.get(roomId).viewers.size, 10, 'everyone stayed in the room');
    // One change: every tab in the room gets the room lane once; nobody is sent the lobby or their own lane.
    assert.equal((await command({ action: 'media.pause' })).value.status, 'applied');
    await new Promise(resolve => setTimeout(resolve, 300));
    for (const tab of tabs)
      assert.deepEqual(
        pushes(tab.client).map(e => e.type),
        ['room'],
        'a pause is one room message per tab',
      );
    assert.deepEqual(pushes(bystander), [], 'a connection outside the room hears nothing of its playback');
  },
);

// A server whose room work is scripted, to exercise the connection's own publication rules.
async function scripted(operations, options = {}) {
  const http = require('node:http'),
    { watchSockets } = require('../server/watch-socket');
  const { WatchTransport } = require('../web/watch-transport');
  const server = http.createServer(),
    roomId = '11111111-1111-4111-8111-111111111111',
    viewerId = '22222222-2222-4222-8222-222222222222';
  const room = { roomId, viewers: new Map([[viewerId, { viewerId }]]) },
    lanes = { version: 1, stamp: 'stream', room: { mediaVersion: 'm' }, viewer: { mediaVersion: 'm' } };
  const messages = [];
  const sockets = watchSockets({
    server,
    config: { publicUrl: 'http://fixture.invalid' },
    routes: {
      clockEpoch: 'fixture',
      authorized: async () => ({ actor: { userId: 'fixture' } }),
      operations: {
        join: async () => ({ status: 200, value: lanes }),
        lanes: async () => ({ status: 200, value: lanes }),
        lobby: async () => ({ status: 200, value: { identity: {}, rooms: [] } }),
        call: async () => ({ status: 200, value: {} }),
        ...operations(lanes),
      },
    },
    watch: {
      clock: { now: () => Date.now() },
      rooms: new Map([[roomId, room]]),
      roomVersion: () => 1,
      viewerStamp: () => 'stream',
      changed() {},
      disconnected() {},
      present: () => true,
      roomState: { startRecovery() {}, people: { reserve() {}, enter() {} } },
    },
    hub: {
      dispatch: async () => {},
      logger: { debug() {}, info() {}, warn() {} },
      directory: { connected() {}, disconnected() {} },
    },
    throttle: () => true,
    // The slow resync, sped up: it is what publishes here, since nothing changes.
    resyncMs: 100,
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  class Client extends WebSocket {
    constructor(url) {
      super(url, { origin: 'http://fixture.invalid' });
    }
  }
  const transport = new WatchTransport({
    url: 'ws://127.0.0.1:' + server.address().port + '/watch-socket',
    identity: () => ({}),
    WebSocket: Client,
    onMessage: message => messages.push(message),
  });
  await transport.connect();
  await transport.join(roomId, viewerId, {});
  return {
    transport,
    messages,
    async close() {
      transport.close();
      sockets.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

test('a slow room publication retries without telling a healthy browser it disconnected', async () => {
  let calls = 0;
  const f = await scripted(
    lanes => ({
      async lanes(context) {
        if (++calls === 1)
          await new Promise((_, reject) =>
            context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }),
          );
        return { status: 200, value: lanes };
      },
    }),
    { publishTimeoutMs: 50 },
  );
  try {
    await new Promise(resolve => setTimeout(resolve, 2300));
    assert.equal(f.messages.filter(message => message.type === 'error').length, 0);
    assert.ok(
      f.messages.some(message => message.type === 'room') && f.messages.some(message => message.type === 'viewer'),
      'the retried publication delivers both lanes, with nothing having changed: a resync',
    );
    assert.ok(calls >= 2);
    assert.equal(f.transport.socket.readyState, 1);
  } finally {
    await f.close();
  }
});

test('cancelled library work releases admission and stalled discovery cannot block room publication', async () => {
  let cancelled = 0,
    published = 0,
    releaseLobby;
  const lobby = new Promise(resolve => (releaseLobby = resolve));
  const f = await scripted(lanes => ({
    async lanes() {
      published++;
      return { status: 200, value: lanes };
    },
    async lobby() {
      await lobby;
      return { status: 200, value: { identity: {}, rooms: [] } };
    },
    async call(context, op) {
      if (op === 'library.browse')
        await new Promise((resolve, reject) =>
          context.signal.addEventListener(
            'abort',
            () => {
              cancelled++;
              reject(context.signal.reason);
            },
            { once: true },
          ),
        );
      return { status: 200, value: {} };
    },
  }));
  try {
    for (let i = 0; i < 10; i++) {
      const abort = new AbortController(),
        request = f.transport.call('library.browse', { args: { q: String(i) } }, { signal: abort.signal });
      const rejected = assert.rejects(request);
      await new Promise(resolve => setTimeout(resolve, 20));
      abort.abort();
      await rejected;
    }
    assert.deepEqual(await f.transport.call('me'), {});
    await new Promise(resolve => setTimeout(resolve, 2100));
    assert.equal(cancelled, 10);
    assert.ok(published >= 2, 'the room lanes are resynced while the lobby is still stalled');
    assert.equal(f.transport.socket.readyState, 1);
  } finally {
    releaseLobby();
    await f.close();
  }
});

async function pushedWithin(predicate, message) {
  const deadline = performance.now() + 1500;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, message);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('room buffering policy freezes on the first stall report and releases on current readiness', tls, async t => {
  const f = await fixture(t);
  const host = await f.connect(await f.login('host'));
  const guestIdentity = await f.login('guest');
  const guest = await f.connect(guestIdentity);
  const late = await f.connect(guestIdentity);
  t.after(() => [host, guest, late].forEach(client => client.ws.terminate()));
  const roomId = (await host.call('/api/watch/rooms', { keepEmpty: true })).value.id;
  const root = '/api/watch/rooms/' + roomId;
  const hostId = randomUUID(),
    guestId = randomUUID(),
    lateId = randomUUID();
  await host.call(root + '?viewer=' + hostId);
  await guest.call(root + '?viewer=' + guestId);
  const { watch } = f.app;
  const room = watch.rooms.get(roomId);
  const command = (action, args) =>
    host.call(root + '/command', {
      viewerId: hostId,
      epoch: room.epoch,
      expiresAt: watch.clock.now() + 2000,
      command: { action, args },
    });
  const settings = async () => (await host.call(root + '/settings')).value;
  const setPolicy = async (client, value) =>
    client.call(root + '/settings', {
      revision: (await settings()).revision,
      change: { action: 'pauseOnBuffering', value },
    });
  assert.equal((await settings()).pauseOnBuffering, false);
  assert.equal(watch.roomState.store.get(roomId).pauseOnBuffering, null);
  assert.equal((await setPolicy(guest, true)).status, 403);
  assert.equal((await command('media.load', { mediaId: 'demo', quality: 'direct' })).value.status, 'applied');
  await Promise.all([...room.viewers.values()].map(viewer => viewer.streamWork));
  const ready = (client, viewerId, readinessVersion = room.readinessVersion) =>
    client.call(root + '/ready', { viewerId, mediaVersion: room.mediaVersion, readinessVersion, ready: true });
  const waitForStart = () =>
    new Promise(resolve => setTimeout(resolve, Math.max(0, room.startAt - watch.clock.now()) + 5));
  const sequences = new Map();
  const observe = (client, viewerId, state, extra = {}) => {
    const viewer = room.viewers.get(viewerId);
    const sequence = (sequences.get(viewerId) || 0) + 1;
    sequences.set(viewerId, sequence);
    return client.call(root + '/observe', {
      viewerId,
      epoch: room.epoch,
      mediaVersion: room.mediaVersion,
      streamVersion: viewer.streamVersion,
      observationEpoch: viewer.observationEpoch,
      sequence,
      sampleAt: performance.now(),
      observedAt: watch.clock.now(),
      position: watch.position(room),
      state,
      frames: sequence * 10,
      rate: 1,
      discontinuity: 0,
      ...extra,
    });
  };
  assert.equal((await ready(host, hostId)).status, 200);
  assert.equal((await ready(guest, guestId)).status, 200);
  await waitForStart();
  assert.equal((await observe(guest, guestId, 'playing')).status, 200);
  assert.equal((await observe(guest, guestId, 'buffering')).status, 200);
  assert.equal(room.state.paused, false, 'the default keeps playback moving');
  assert.equal((await setPolicy(host, true)).value.pauseOnBuffering, true);
  assert.equal(watch.roomState.store.get(roomId).pauseOnBuffering, true);

  assert.equal((await observe(host, hostId, 'playing')).status, 200);
  assert.equal((await observe(guest, guestId, 'playing')).status, 200);
  assert.equal((await observe(guest, guestId, 'buffering', { stalled: false })).status, 200);
  assert.equal(room.state.paused, false, 'stream preparation is not an active playback stall');
  assert.equal((await observe(guest, guestId, 'playing')).status, 200);
  assert.equal((await observe(guest, guestId, 'buffering', { epoch: randomUUID() })).status, 200);
  assert.equal(room.state.paused, false, 'a previous room epoch cannot pause playback');
  assert.equal((await observe(guest, guestId, 'playing')).status, 200);
  const eventsBeforeStall = host.events.length;
  assert.equal((await observe(guest, guestId, 'buffering')).status, 200);
  assert.equal(room.state.paused, true);
  assert.equal(room.pauseAt, undefined, 'buffering freezes immediately, with no scheduled pause lead');
  const frozenPosition = room.position;
  await pushedWithin(
    () =>
      host.events
        .slice(eventsBeforeStall)
        .some(event => event.type === 'room' && event.state.state.paused && event.state.readiness?.buffering),
    'the healthy viewer did not receive the buffering pause',
  );
  assert.equal((await ready(guest, guestId, randomUUID())).status, 400, 'old readiness cannot release the hold');
  await late.call(root + '?viewer=' + lateId);
  assert.equal(room.initialViewers.has(lateId), false);
  assert.equal((await ready(host, hostId)).status, 200);
  assert.equal(room.state.paused, true, 'the stalled viewer still needs to buffer');
  assert.equal(watch.position(room), frozenPosition);
  await watch.inRoom(room, () => {
    room.readinessDeadline = performance.now() - 1;
    watch.review(room);
  });
  assert.equal(room.readinessTimedOut, true, 'the host can intervene after the readiness deadline');
  assert.equal((await ready(guest, guestId)).status, 200);
  assert.equal(room.state.paused, false, 'a recovered viewer still releases the room after the deadline');
  assert.equal(room.position, frozenPosition);
  assert.ok(room.startAt > room.changedAt, 'the room resumes together');

  await waitForStart();
  assert.equal((await observe(guest, guestId, 'playing')).status, 200);
  assert.equal((await observe(guest, guestId, 'buffering')).status, 200);
  assert.equal(room.state.paused, true);
  assert.equal((await command('media.pause')).value.status, 'applied');
  assert.equal((await ready(guest, guestId)).status, 200);
  assert.equal(room.state.paused, true);
  assert.equal(room.manualPaused, true, 'a manual pause survives buffering recovery');
  f.config.pauseOnBuffering = true;
  assert.equal((await setPolicy(host, false)).value.pauseOnBuffering, false);
  assert.equal((await setPolicy(host, null)).value.pauseOnBuffering, true);
  assert.equal(watch.roomState.store.get(roomId).pauseOnBuffering, null);
});

test('local delivery pushes a fresh viewer lane after delayed auto-queue corpus work', tls, async t => {
  const f = await fixture(t),
    identity = await f.login('host'),
    client = await f.connect(identity);
  t.after(() => client.ws.terminate());
  const id = (await client.call('/api/watch/rooms', {})).value.id,
    viewerId = randomUUID();
  assert.equal((await client.call('/api/watch/rooms/' + id + '?viewer=' + viewerId + '&delivery=local')).status, 200);
  const watch = f.app.watch,
    room = watch.rooms.get(id),
    viewer = room.viewers.get(viewerId);
  await watch.roomState.queue.configureAuto(id, viewer.userId, {
    mode: 'following',
    scope: { type: 'show', id: '50', serverId: 'local-demo' },
  });
  const corpus = Promise.withResolvers();
  let entered = false;
  t.mock.method(watch, 'autoCorpus', async () => {
    entered = true;
    return corpus.promise;
  });
  t.after(() => corpus.resolve(undefined));
  let outcome;
  const loading = client
    .call('/api/watch/rooms/' + id + '/command', {
      viewerId,
      epoch: room.epoch,
      expiresAt: watch.clock.now() + 2500,
      command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
    })
    .then(result => {
      outcome = result;
      return result;
    });
  await pushedWithin(() => entered || outcome, 'load never reached delayed auto-queue corpus');
  assert.ok(entered, JSON.stringify(outcome));
  await pushedWithin(
    () => client.events.some(event => event.type === 'viewer' && event.state.mediaVersion === room.mediaVersion),
    'adopted generation was not published while corpus was pending',
  );
  const boundary = client.events.length;
  const stream = Promise.withResolvers();
  const scope = watch.streamScope.bind(watch);
  let preparing = false;
  t.mock.method(watch, 'streamScope', async (...args) => {
    preparing = true;
    await stream.promise;
    return scope(...args);
  });
  t.after(() => stream.resolve());
  corpus.resolve(undefined);
  assert.equal((await loading).value.status, 'applied');
  await pushedWithin(() => preparing, 'local viewer never started preparing');
  // Let the command publication read the unchanged, still-empty viewer lane.
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
  stream.resolve();
  await pushedWithin(
    () =>
      client.events
        .slice(boundary)
        .some(
          event =>
            event.type === 'viewer' &&
            event.state.format === 'local' &&
            event.state.streamVersion === viewer.streamVersion,
        ),
    'local stream was not pushed after corpus resolution',
  );
  assert.equal(viewer.media.format, 'local');
  assert.ok(viewer.streamVersion);
});

test('stream preparation failure and recovery publish promptly without a resync request', tls, async t => {
  const f = await fixture(t),
    client = await f.connect(await f.login('host'));
  t.after(() => client.ws.terminate());
  const id = (await client.call('/api/watch/rooms', {})).value.id,
    viewerId = randomUUID();
  await client.call('/api/watch/rooms/' + id + '?viewer=' + viewerId);
  const watch = f.app.watch,
    room = watch.rooms.get(id),
    viewer = room.viewers.get(viewerId);
  const original = watch.prepareViewer.bind(watch);
  let fail = true;
  t.mock.method(watch, 'prepareViewer', (...args) => {
    if (fail) throw Object.assign(new Error('Fixture preparation failed'), { status: 503 });
    return original(...args);
  });
  const boundary = client.events.length;
  await watch.prepareStream(room, viewer.actor, viewerId);
  await pushedWithin(
    () => client.events.slice(boundary).some(event => event.type === 'error' && event.code === 'unavailable'),
    'preparation failure was not pushed',
  );
  const recovery = client.events.length;
  fail = false;
  await watch.prepareStream(room, viewer.actor, viewerId);
  await pushedWithin(
    () => client.events.slice(recovery).some(event => event.type === 'room'),
    'recovery was not pushed',
  );
  assert.equal(viewer.streamFailure, undefined);
});

for (const failure of ['cancel', 'disconnect', 'stream-failure']) {
  test(
    `a host-eligible ${failure} during join cannot leave a phantom viewer or stop healthy playback`,
    tls,
    async t => {
      const f = await fixture(t);
      const hostIdentity = await f.login('host');
      const host = await f.connect(hostIdentity),
        healthy = await f.connect(await f.login('guest'));
      t.after(() => {
        host.ws.terminate();
        healthy.ws.terminate();
      });
      const roomId = (await host.call('/api/watch/rooms', { keepEmpty: true })).value.id;
      const root = '/api/watch/rooms/' + roomId,
        hostId = randomUUID(),
        healthyId = randomUUID();
      await host.call(root + '?viewer=' + hostId);
      await healthy.call(root + '?viewer=' + healthyId);
      const watch = f.app.watch,
        room = watch.rooms.get(roomId),
        store = watch.roomState.store;
      const record = store.get(roomId);
      watch.roomState.apply(
        room,
        await store.edit(roomId, record.creatorId, record.revision, {
          action: 'permissions',
          role: 'viewer',
          permissions: { continueWithoutHost: true },
        }),
      );
      assert.equal(
        (
          await host.call(root + '/command', {
            viewerId: hostId,
            epoch: room.epoch,
            expiresAt: watch.clock.now() + 2500,
            command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
          })
        ).value.status,
        'applied',
      );
      await Promise.all([...room.viewers.values()].map(viewer => viewer.streamWork));
      for (const [client, viewerId] of [
        [host, hostId],
        [healthy, healthyId],
      ])
        await client.call(root + '/ready', {
          viewerId,
          mediaVersion: room.mediaVersion,
          readinessVersion: room.readinessVersion,
          ready: true,
        });
      await host.call(root + '/leave', { viewerId: hostId });
      await pushedWithin(
        () => room.hostViewerId === healthyId && !room.state.paused,
        'healthy viewer did not continue playback',
      );
      const joiningClient = await f.connect(hostIdentity),
        attemptedId = randomUUID();
      t.after(() => joiningClient.ws.terminate());
      const gate = Promise.withResolvers();
      t.after(() => gate.resolve());
      let attempted;
      const prepare = watch.prepareViewer.bind(watch);
      t.mock.method(watch, 'prepareViewer', async (currentRoom, actor, viewerId) => {
        if (viewerId === attemptedId) {
          attempted = currentRoom.viewers.get(viewerId);
          await gate.promise;
          if (failure === 'stream-failure')
            throw Object.assign(new Error('Fixture stream preparation failed'), { status: 503 });
        }
        return prepare(currentRoom, actor, viewerId);
      });
      const pending = joiningClient.send({ type: 'join', roomId, viewerId: attemptedId });
      await pushedWithin(() => attempted, 'join never entered stream preparation');
      assert.equal(room.hostViewerId, attemptedId, 'the attempted host join exercised host election');
      if (failure === 'disconnect') {
        joiningClient.ws.terminate();
      } else if (failure === 'cancel') {
        // The fixture send() allocates the first request ID as 1 on this socket.
        joiningClient.ws.send(JSON.stringify({ type: 'cancel', id: 1 }));
      } else {
        gate.resolve();
        const result = await pending;
        assert.equal(result.type, 'error');
        assert.equal(result.status, 503);
      }
      // Cancellation/disconnection must detach even while the provider still retires.
      await pushedWithin(() => !room.viewers.has(attemptedId), 'failed join kept a phantom viewer');
      gate.resolve();
      await attempted.streamWork;
      assert.equal(room.initialViewers.has(attemptedId), false);
      assert.equal(room.disconnectedViewers.has(attemptedId), false);
      assert.ok(!attempted.streamRetry || attempted.streamRetry._destroyed, 'retry timer was not cleared');
      let now = watch.clock.now();
      t.mock.method(watch.clock, 'now', () => now);
      now += require('../shared/sync/envelope.mjs').PRESENCE_TIMEOUT_MS + 1;
      room.viewers.get(healthyId).at = now;
      watch.review(room);
      await pushedWithin(() => !room.state.paused, 'healthy playback stopped after the failed host join');
      assert.ok(!room.frozen);
      assert.equal(room.hostViewerId, healthyId);
      assert.equal(room.viewers.size, 1);
    },
  );
}

test('a socket switching rooms or viewer IDs detaches its superseded viewer immediately', tls, async t => {
  const f = await fixture(t),
    client = await f.connect(await f.login('host'));
  t.after(() => client.ws.terminate());
  const a = (await client.call('/api/watch/rooms', { name: 'First', keepEmpty: true })).value.id;
  const b = (await client.call('/api/watch/rooms', { name: 'Second', keepEmpty: true })).value.id;
  const first = randomUUID(),
    second = randomUUID(),
    replacement = randomUUID();
  await client.call('/api/watch/rooms/' + a + '?viewer=' + first);
  const old = f.app.watch.rooms.get(a);
  await client.call('/api/watch/rooms/' + b + '?viewer=' + second);
  assert.equal(old.viewers.has(first), false);
  assert.equal(old.disconnectedViewers.has(first), false);
  const current = f.app.watch.rooms.get(b);
  await client.call('/api/watch/rooms/' + b + '?viewer=' + replacement);
  assert.equal(current.viewers.has(second), false);
  assert.equal(current.disconnectedViewers.has(second), false);
  assert.equal(current.viewers.has(replacement), true);
});

test('an older abandoned join cannot detach a newer successful connection for the same viewer', tls, async t => {
  const f = await fixture(t),
    identity = await f.login('host');
  const old = await f.connect(identity),
    current = await f.connect(identity);
  t.after(() => {
    old.ws.terminate();
    current.ws.terminate();
  });
  const id = (await current.call('/api/watch/rooms', { keepEmpty: true })).value.id;
  const watch = f.app.watch,
    room = watch.rooms.get(id),
    viewerId = randomUUID();
  const gate = Promise.withResolvers(),
    retired = Promise.withResolvers();
  t.after(() => gate.resolve());
  let first = true,
    attempted,
    previousSocket;
  const prepare = watch.prepareViewer.bind(watch);
  t.mock.method(watch, 'prepareViewer', async (...args) => {
    if (args[2] === viewerId && first) {
      first = false;
      attempted = room.viewers.get(viewerId);
      previousSocket = attempted.watchSocket;
      await gate.promise;
      try {
        return await prepare(...args);
      } finally {
        retired.resolve();
      }
    }
    return prepare(...args);
  });
  void old.send({ type: 'join', roomId: id, viewerId });
  await pushedWithin(() => attempted, 'first join never prepared');
  assert.equal((await current.call('/api/watch/rooms/' + id + '?viewer=' + viewerId)).status, 200);
  const socket = attempted.watchSocket;
  assert.notEqual(socket, previousSocket);
  const closed = once(old.ws, 'close');
  old.ws.terminate();
  await closed;
  gate.resolve();
  await retired.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(room.viewers.get(viewerId), attempted);
  assert.equal(attempted.watchSocket, socket);
  assert.equal((await current.send({ type: 'resync' })).type, 'ack');
  assert.equal(room.viewers.has(viewerId), true);
});

test('a join refused during media projection removes its admitted viewer', tls, async t => {
  const f = await fixture(t),
    host = await f.connect(await f.login('host')),
    guest = await f.connect(await f.login('guest'));
  t.after(() => {
    host.ws.terminate();
    guest.ws.terminate();
  });
  const id = (await host.call('/api/watch/rooms', {})).value.id;
  const watch = f.app.watch,
    room = watch.rooms.get(id),
    hostId = randomUUID(),
    guestId = randomUUID();
  await host.call('/api/watch/rooms/' + id + '?viewer=' + hostId);
  assert.equal(
    (
      await host.call('/api/watch/rooms/' + id + '/command', {
        viewerId: hostId,
        epoch: room.epoch,
        expiresAt: watch.clock.now() + 2500,
        command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
      })
    ).value.status,
    'applied',
  );
  let denied = false;
  const canView = watch.canView.bind(watch);
  t.mock.method(watch, 'canView', (currentRoom, actor) =>
    denied && actor.userId !== room.hostId ? false : canView(currentRoom, actor),
  );
  t.mock.method(watch.providers, 'directFile', async () => {
    denied = true;
    return undefined;
  });
  const result = await guest.call('/api/watch/rooms/' + id + '?viewer=' + guestId);
  assert.equal(result.status, 409);
  assert.equal(room.viewers.has(guestId), false);
  assert.equal(room.initialViewers.has(guestId), false);
  assert.equal(room.viewers.has(hostId), true);
});
