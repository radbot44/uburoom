'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { spawnSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const { WebSocket } = require('ws');

const Sync = require('../shared/sync');
const { createApp } = require('../server/app');
const { requestByPath, hello } = require('./helpers/wire-paths');

const certFile = path.join(__dirname, '../certs/server-cert.pem');
const keyFile = path.join(__dirname, '../certs/server-key.pem');
const tlsAvailable = fs.existsSync(certFile) && fs.existsSync(keyFile);

test('shared/sync imports cleanly in an isolated process without server modules, config, credentials, or active handles', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-sync-core-'));
  const esmEntry = path.resolve(__dirname, '../shared/sync/index.mjs');
  const cjsEntry = path.resolve(__dirname, '../shared/sync/index.js');
  try {
    const probeScript = `
      import { createRequire } from 'node:module';
      import { pathToFileURL } from 'node:url';

      const esm = await import(pathToFileURL(${JSON.stringify(esmEntry)}).href);
      const require = createRequire(import.meta.url);
      const cjs = require(${JSON.stringify(cjsEntry)});

      const coordinator = esm.createRoomCoordinator({ authorize: esm.policyAuthorize });
      const broker = esm.createSubscriptionBroker({ publish() {} });
      const noop = () => {};
      const clientSync = esm.createSync({
        player: {
          readyState: () => 4,
          currentTime: () => 0,
          seek() {},
          duration: () => 120,
          paused: () => true,
          ended: () => false,
          seeking: () => false,
          playbackRate: () => 1,
          setPlaybackRate() {},
          setAudio() {},
          play: () => Promise.resolve(),
          pause() {},
          bufferedAhead: () => 10,
          isBufferedAt: () => true
        },
        read: () => ({ receivedAt: 0, probing: false, playbackError: '', playerWaiting: false, autoplayBlocked: false, syncCorrectionMode: 'proportional' }),
        clock: esm.clock(),
        presentation: esm.presentation(),
        expected: () => 0,
        decodedFrames: () => 0,
        unlockLocal: () => Promise.resolve(),
        reportReadiness: () => Promise.resolve(),
        render: noop,
        checkFrames: noop,
        sample: noop,
        error: noop,
        playing: noop,
        visibility: () => 'visible',
        online: () => true,
        repeat: () => 0,
        cancelRepeat: noop
      });
      clientSync.close();
      // Allow Node's ESM loader FileHandleCloseReq (observed on Node 22.14 Windows) to settle.
      await new Promise(resolve => setImmediate(resolve));

      const loadedServerModules = Object.keys(require.cache).filter(id =>
        id.replace(/\\\\/g, '/').includes('/server/')
      );
      const activeHandles = process._getActiveHandles().filter(
        handle => handle !== process.stdout && handle !== process.stderr
      );
      const activeRequests = process._getActiveRequests();

      console.log(JSON.stringify({
        esmKeys: Object.keys(esm).length,
        cjsKeys: Object.keys(cjs).length,
        sameExports: Object.keys(esm).every(key => key in cjs),
        loadedServerModules,
        activeHandleCount: activeHandles.length,
        activeRequestCount: activeRequests.length,
        coordinatorRoomCount: coordinator.rooms.size,
        brokerSize: broker.size
      }));
    `;

    const run = spawnSync(process.execPath, ['--input-type=module', '-e', probeScript], {
      cwd: tempDir,
      env: { PATH: process.env.PATH || '' },
      encoding: 'utf8',
      timeout: 10000,
    });

    assert.equal(run.status, 0, run.stderr || 'isolated import exited non-zero');
    const report = JSON.parse(run.stdout.trim());
    assert.ok(report.esmKeys >= 50);
    assert.equal(report.esmKeys, report.cjsKeys);
    assert.equal(report.sameExports, true);
    assert.deepEqual(report.loadedServerModules, []);
    assert.equal(report.activeHandleCount, 0);
    assert.equal(report.activeRequestCount, 0);
    assert.equal(report.coordinatorRoomCount, 0);
    assert.equal(report.brokerSize, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('client-sync drives a custom non-DOM PlayerAdapter on an abstract timeline without media URLs', async () => {
  let monoNow = 1000;
  let wallNow = 50_000;
  const scheduledAlarms = [];
  let readinessCalls = 0;

  const customPlayerState = {
    paused: true,
    ended: false,
    seeking: false,
    readyState: 4,
    currentTime: 10,
    duration: 300,
    playbackRate: 1,
    volume: 1,
    muted: false,
    bufferedEnd: 40,
    playCalls: 0,
    pauseCalls: 0,
  };

  const adapter = {
    readyState: () => customPlayerState.readyState,
    currentTime: () => customPlayerState.currentTime,
    seek(sec) {
      customPlayerState.currentTime = sec;
    },
    duration: () => customPlayerState.duration,
    paused: () => customPlayerState.paused,
    ended: () => customPlayerState.ended,
    seeking: () => customPlayerState.seeking,
    playbackRate: () => customPlayerState.playbackRate,
    setPlaybackRate(rate) {
      customPlayerState.playbackRate = rate;
    },
    setAudio(vol, muted) {
      if (vol !== undefined) customPlayerState.volume = vol;
      if (muted !== undefined) customPlayerState.muted = muted;
    },
    play() {
      customPlayerState.paused = false;
      customPlayerState.playCalls++;
      return Promise.resolve();
    },
    pause() {
      customPlayerState.paused = true;
      customPlayerState.pauseCalls++;
    },
    bufferedAhead: pos => Math.max(0, customPlayerState.bufferedEnd - pos),
    isBufferedAt: pos => pos >= 0 && pos <= customPlayerState.bufferedEnd,
  };

  const playbackClock = Sync.clock({ monotonic: () => monoNow, wall: () => wallNow });
  const feedClockSample = () => {
    const req = playbackClock.begin();
    monoNow += 20;
    wallNow += 20;
    playbackClock.add(req, {
      serverReceivedAt: wallNow + 190,
      serverSentAt: wallNow + 190,
      serverProcessingMs: 0,
      clockEpoch: 'epoch-1',
    });
  };
  for (let i = 0; i < 4; i++) {
    monoNow += 30;
    wallNow += 30;
    feedClockSample();
  }
  assert.equal(playbackClock.read().valid, true);

  let readyVersion;
  let currentRoom = {
    mediaVersion: '00000000-0000-4000-8000-000000000010',
    streamVersion: '00000000-0000-4000-8000-000000000011',
    epoch: '00000000-0000-4000-8000-000000000012',
    revision: 1,
    readinessVersion: '00000000-0000-4000-8000-000000000020',
    waitingForReady: true,
    serverNow: playbackClock.read().serverTime,
    startAt: undefined,
    pauseAt: undefined,
    state: { paused: true, position: 10, duration: 300, volume: 65, muted: false },
  };
  let receivedMono = monoNow;

  const makeTestAlarm = () => ({
    arm(key, targetTime, fn) {
      scheduledAlarms.push({ key, targetTime, fn, cancelled: false });
    },
    cancel() {
      for (const a of scheduledAlarms) a.cancelled = true;
    },
  });

  const sync = Sync.createSync({
    player: adapter,
    mediaReady: snap => Boolean(snap?.content?.assetId),
    read: () => ({
      selected: 'room-abstract-1',
      state: currentRoom,
      content: { assetId: 'abstract-item-42' },
      receivedAt: receivedMono,
      probing: false,
      playbackError: '',
      playerWaiting: false,
      autoplayBlocked: false,
      readyVersion,
      syncCorrectionMode: 'proportional',
    }),
    clock: playbackClock,
    presentation: Sync.presentation(),
    startAlarm: makeTestAlarm(),
    pauseAlarm: makeTestAlarm(),
    expected: () => Sync.target(currentRoom, receivedMono, monoNow, playbackClock),
    decodedFrames: () => 120,
    unlockLocal: async () => {
      readyVersion = currentRoom.mediaVersion;
    },
    reportReadiness: async () => {
      readinessCalls++;
    },
    render() {},
    checkFrames() {},
    sample() {},
    error() {},
    playing(ver) {
      if (ver !== undefined) readyVersion = ver;
    },
    visibility: () => 'visible',
    online: () => true,
    repeat: () => 0,
    cancelRepeat() {},
    now: () => monoNow,
  });

  // 1. Readiness gate unlocks & reports on an abstract timeline without `state.mediaUrl`.
  await sync.synchronize();
  assert.equal(readinessCalls, 1);
  assert.equal(customPlayerState.volume, 0.65);

  // 2. Scheduled future `startAt` holds player paused and arms `startAlarm`.
  const serverNow = playbackClock.read().serverTime;
  currentRoom = {
    ...currentRoom,
    revision: 2,
    waitingForReady: false,
    serverNow,
    startAt: serverNow + 500,
    state: { paused: false, position: 10, duration: 300, volume: 65, muted: false },
  };
  receivedMono = monoNow;
  await sync.synchronize();
  assert.equal(customPlayerState.paused, true, 'holds paused while awaiting future startAt');
  assert.ok(scheduledAlarms.some(a => !a.cancelled && a.targetTime === serverNow + 500));

  // 3. Past `startAt` starts playback and nudges `playbackRate` smoothly over persistent moderate lag.
  monoNow += 2500;
  wallNow += 2500;
  feedClockSample();
  customPlayerState.currentTime = Sync.target(currentRoom, receivedMono, monoNow, playbackClock);
  await sync.synchronize();
  assert.equal(customPlayerState.paused, false);

  for (let step = 0; step < 8; step++) {
    monoNow += 500;
    wallNow += 500;
    const expectedPos = Sync.target(currentRoom, receivedMono, monoNow, playbackClock);
    customPlayerState.currentTime = expectedPos - 0.18; // 180ms behind target
    await sync.synchronize();
  }
  assert.ok(
    customPlayerState.playbackRate > 1 && customPlayerState.playbackRate <= 1.04,
    'nudges rate smoothly on sustained lag',
  );

  // 4. Reached `pauseAt` pauses playback and restores nominal rate.
  const pauseServerNow = playbackClock.read().serverTime;
  currentRoom = {
    ...currentRoom,
    revision: 3,
    startAt: undefined,
    serverNow: pauseServerNow,
    pauseAt: pauseServerNow - 10,
    state: { paused: false, position: 15.25, duration: 300, volume: 65, muted: false },
  };
  receivedMono = monoNow;
  await sync.synchronize();
  assert.equal(customPlayerState.paused, true);
  assert.equal(customPlayerState.playbackRate, 1);
  sync.close();
});

test('room-scoped subscription broker isolates room notifications across rooms and tenants', async () => {
  const deliveries = [];
  const broker = Sync.createSubscriptionBroker({
    publish(client, ctx) {
      deliveries.push({ id: client.id, roomOnly: ctx.roomOnly });
    },
    schedule: queueMicrotask,
  });

  const roomA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const roomB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const clientA1 = { id: 'a1', tenantId: 't1', roomId: roomA };
  const clientB1 = { id: 'b1', tenantId: 't1', roomId: roomB };
  const clientLobby1 = { id: 'lobby1', tenantId: 't1', roomId: undefined };
  const clientA2 = { id: 'a2', tenantId: 't2', roomId: roomA };

  for (const c of [clientA1, clientB1, clientLobby1, clientA2]) broker.add(c);

  // Room-local update in (t1, roomA) wakes ONLY clientA1.
  broker.notify({ tenantId: 't1', roomId: roomA, includeLobby: false });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(deliveries, [{ id: 'a1', roomOnly: true }]);

  // Tenant-wide lobby update in t1 wakes t1 clients (roomOnly: false), never t2.
  deliveries.length = 0;
  broker.notify({ tenantId: 't1', includeLobby: true });
  await new Promise(resolve => queueMicrotask(resolve));
  assert.deepEqual(deliveries.map(d => d.id).sort(), ['a1', 'b1', 'lobby1']);
  assert.ok(deliveries.every(d => d.roomOnly === false));
});

test(
  'self-hosted Uburoom integration uses shared/sync and isolates room-local WebSocket updates between rooms',
  { skip: !tlsAvailable },
  async t => {
    const cert = fs.readFileSync(certFile);
    const key = fs.readFileSync(keyFile);
    const config = {
      cert,
      key,
      publicUrl: 'https://localhost:6768',
      ownerId: 'demo-host',
      guildId: 'guild',
      channels: ['commands'],
      demo: true,
      clientId: 'fixture',
      clientSecret: 'fixture-secret',
    };
    const app = createApp(config, {
      oauthFetch: async url =>
        new Response(
          JSON.stringify(
            String(url).endsWith('/token')
              ? { access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600 }
              : { id: 'demo-host', username: 'Host' },
          ),
        ),
    });
    app.access.connect({ isMember: () => true, refresh: async () => true, options: () => ({ available: true }) });
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    t.after(() => app.close());

    const getText = route =>
      new Promise((resolve, reject) => {
        https
          .get(config.publicUrl + route, { ca: cert }, res => {
            let body = '';
            res.on('data', chunk => {
              body += chunk;
            });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
          })
          .on('error', reject);
      });

    // The browser imports the shared modules unchanged.
    const [timingScript, esmModule] = await Promise.all([
      getText('/shared/sync/timing.mjs'),
      getText('/shared/sync/client-sync.mjs'),
    ]);
    assert.equal(timingScript.status, 200);
    assert.match(timingScript.body, /export function createTimingApi/);
    assert.equal(esmModule.status, 200);
    assert.match(String(esmModule.headers['content-type']), /javascript/);

    const login = persona =>
      new Promise((resolve, reject) => {
        const req = https.request(
          config.publicUrl + '/api/watch/demo-login',
          {
            method: 'POST',
            ca: cert,
            headers: { Origin: config.publicUrl, 'Content-Type': 'application/json' },
          },
          res => {
            let raw = '';
            res.on('data', bytes => {
              raw += bytes;
            });
            res.on('end', () => resolve(JSON.parse(raw)));
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ persona }));
      });

    async function connect(identity) {
      const ws = new WebSocket(config.publicUrl.replace('https:', 'wss:') + '/watch-socket', {
        ca: cert,
        origin: config.publicUrl,
      });
      const events = [];
      const waiting = new Map();
      let seq = 0;
      ws.on('message', raw => {
        const msg = JSON.parse(raw.toString());
        events.push(msg);
        if (msg.type === 'ack' || (msg.type === 'error' && msg.id !== undefined)) {
          const pending = waiting.get(msg.id);
          if (pending) {
            waiting.delete(msg.id);
            pending(msg);
          }
        }
      });
      await once(ws, 'open');
      const authReply = once(ws, 'message');
      ws.send(JSON.stringify(hello({ token: identity.token, csrf: identity.csrf })));
      assert.equal(JSON.parse((await authReply)[0]).type, 'welcome');
      t.after(() => ws.close());
      return {
        ws,
        events,
        // Requests named by resource path, as this test was written (helpers/wire-paths.js).
        async call(route, data) {
          const send = message =>
            new Promise(resolve => {
              const id = ++seq;
              waiting.set(id, resolve);
              ws.send(JSON.stringify({ ...message, id }));
            });
          const { status, body } = await requestByPath(send, route, data);
          return { status, value: body };
        },
      };
    }

    const host = await connect(await login('host'));
    const second = await connect(await login('host'));

    const roomA = (await host.call('/api/watch/rooms', { visibility: 'private' })).value.id;
    const roomB = (await second.call('/api/watch/rooms', { visibility: 'private' })).value.id;
    const viewerA = randomUUID();
    const viewerB = randomUUID();

    let stateA = (await host.call(`/api/watch/rooms/${roomA}?viewer=${viewerA}`)).value;
    let stateB = (await second.call(`/api/watch/rooms/${roomB}?viewer=${viewerB}`)).value;

    await host.call(`/api/watch/rooms/${roomA}/command`, {
      epoch: stateA.epoch,
      expiresAt: Date.now() + 2500,
      viewerId: viewerA,
      command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
    });
    await second.call(`/api/watch/rooms/${roomB}/command`, {
      epoch: stateB.epoch,
      expiresAt: Date.now() + 2500,
      viewerId: viewerB,
      command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } },
    });

    stateA = (await host.call(`/api/watch/rooms/${roomA}?viewer=${viewerA}`)).value;
    stateB = (await second.call(`/api/watch/rooms/${roomB}?viewer=${viewerB}`)).value;

    // Let both rooms' own publications finish, for a clean window.
    await new Promise(resolve => setTimeout(resolve, 300));
    second.events.length = 0;

    const serverRoomB = app.watch.rooms.get(roomB);
    const seqBBefore = app.watch.roomVersion(serverRoomB);
    const eventsBBefore = second.events.length;
    host.events.length = 0;

    // Trigger room-local readiness, play, and seek in Room A.
    await host.call(`/api/watch/rooms/${roomA}/ready`, {
      viewerId: viewerA,
      mediaVersion: stateA.mediaVersion,
      ready: true,
      readinessVersion: stateA.readinessVersion,
    });
    stateA = (await host.call(`/api/watch/rooms/${roomA}?viewer=${viewerA}`)).value;
    const seekRes = await host.call(`/api/watch/rooms/${roomA}/command`, {
      epoch: stateA.epoch,
      expiresAt: Date.now() + 2500,
      viewerId: viewerA,
      command: { action: 'media.seek.absolute', args: { seconds: 3 } },
    });
    assert.equal(seekRes.value.status, 'applied');

    // Wait for Room A's pushed `room` lane to arrive.
    await new Promise(resolve => {
      const check = () => {
        if (host.events.some(e => e.type === 'room' && e.roomId === roomA)) resolve();
        else setTimeout(check, 10);
      };
      check();
    });

    assert.equal(
      app.watch.roomVersion(serverRoomB),
      seqBBefore,
      'Room A local actions do not trigger snapshot publications in Room B',
    );
    assert.equal(
      second.events.length,
      eventsBBefore,
      'Room B subscriber receives zero frames from Room A local playback mutations',
    );
    assert.equal(
      second.events.some(e => e.roomId === roomA),
      false,
    );
  },
);

test('the room core is a pure reducer: joins, presence lapses, freezing and the automatic start are events', () => {
  let now = 1_000_000,
    monoNow = 50_000;
  const createId = (() => {
    let n = 0;
    return () => 'id-' + ++n;
  })();
  const context = () => ({ now, monoNow, createId, authorize: Sync.policyAuthorize });
  const room = Sync.createRoomState({ roomId: 'room-1', creatorId: 'host', creatorName: 'Host', now, createId });
  room.media = { id: 'm', duration: 60 };
  const host = { userId: 'host', name: 'Host' },
    guest = { userId: 'guest', name: 'Guest' },
    other = { userId: 'other', name: 'Other' };
  const apply = event => {
    const before = JSON.stringify([...room.viewers.keys()]);
    const result = Sync.reduceRoom(room, event, context());
    assert.equal(JSON.stringify([...room.viewers.keys()]), before, 'reduce never changes its input');
    Sync.commitRoomState(room, result.state);
    return result;
  };
  for (const [actor, viewerId] of [
    [host, 'tab-host'],
    [guest, 'tab-guest'],
    [other, 'tab-other'],
  ])
    assert.equal(apply({ type: 'join', actor, viewerId }).value, viewerId);
  const live = room.viewers.get('tab-guest');
  // The host seeks while playing: everyone must be ready again before the room starts.
  Object.assign(room, { initialGate: true, readinessVersion: 'ready-1' });
  room.initialViewers = new Set(room.viewers.keys());
  Sync.beginReadiness(room, now, Sync.READINESS_WAIT_MS, { monoNow, createId });
  // The host closes the tab. Nobody left may host, so the room waits for one, but keeps the start.
  const left = apply({ type: 'disconnect', viewerId: 'tab-host', planned: true });
  assert.ok(left.effects.some(effect => effect.type === 'viewer-removed' && effect.viewerId === 'tab-host'));
  assert.equal(room.waitingForHost, true);
  assert.equal(room.manualPaused, false);
  assert.equal(room.viewers.get('tab-guest'), live, 'a commit keeps the live viewer object');
  const ready = viewerId =>
    apply({
      type: 'ready',
      actor: room.viewers.get(viewerId).actor,
      viewerId,
      mediaVersion: room.mediaVersion,
      ready: true,
      readinessVersion: 'ready-1',
    });
  assert.equal(ready('tab-guest').effects.length, 0);
  const started = ready('tab-other');
  assert.ok(
    started.effects.some(effect => effect.type === 'started'),
    'S6: the room starts with no host present',
  );
  assert.equal(room.state.paused, false);
  assert.equal(room.initialGate, false);
  assert.ok(room.startAt >= now);

  // Presence lapses on the one-second grid; an empty room freezes for its host's tab.
  now += Sync.PRESENCE_TIMEOUT_MS + 1;
  monoNow += Sync.PRESENCE_TIMEOUT_MS + 1;
  assert.equal(Sync.nextRoomDeadline(room, now, monoNow) <= now, true);
  apply({ type: 'timer' });
  assert.equal(room.viewers.size, 0);
  assert.equal(room.frozen, true);
  assert.equal(room.state.paused, true);
  const refused = apply({ type: 'join', actor: guest, viewerId: 'tab-guest' });
  assert.equal(refused.error?.status, 403, 'only the host wakes a frozen room');
  room.hostViewerId = 'tab-guest';
  room.hostId = 'guest';
  assert.equal(apply({ type: 'join', actor: guest, viewerId: 'tab-guest' }).value, 'tab-guest');
  assert.equal(room.frozen, false);
  const closed = apply({ type: 'leave', actor: guest, viewerId: 'tab-guest' });
  assert.ok(closed.effects.some(effect => effect.type === 'remove'));
  assert.equal(room.closed, true);
});

test('the coordinator serializes each room, commits only after persistence and arms deadlines as timer events', async () => {
  let now = 2_000_000;
  const timers = [];
  const persisted = [];
  let failNext = false;
  assert.throws(() => Sync.createRoomCoordinator({}), /authorize/);
  const coordinator = Sync.createRoomCoordinator({
    authorize: Sync.policyAuthorize,
    now: () => now,
    monoNow: () => now,
    timerResolutionMs: 1000,
    timerOrigin: now,
    setTimer: (action, ms) => timers.push({ at: now + ms, action }) && timers.at(-1),
    clearTimer: timer => timers.splice(timers.indexOf(timer), 1),
    async onPersist(state, meta) {
      await new Promise(resolve => setImmediate(resolve));
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      persisted.push(meta.reason);
    },
  });
  const room = coordinator.add(
    Sync.createRoomState({
      roomId: 'room-2',
      creatorId: 'host',
      visibility: 'private',
      now,
      media: { id: 'm', duration: 60 },
    }),
  );
  const host = { userId: 'host', name: 'Host' };
  assert.equal(coordinator.run(room, { type: 'join', actor: { userId: 'stranger' }, viewerId: 'x' }).error.status, 403);
  assert.equal(coordinator.run(room, { type: 'join', actor: host, viewerId: 'tab' }).value, 'tab');
  // The presence deadline lands on the next whole second after it is due.
  assert.equal(coordinator.timerAt('room-2'), now + Sync.PRESENCE_TIMEOUT_MS + 1000);

  const command = action => coordinator.dispatch(room, { type: 'command', actor: host, command: { action } });
  failNext = true;
  const [failed, played] = await Promise.all([command('media.play'), command('media.play')]);
  assert.equal(failed.error.message, 'disk full');
  assert.equal(played.error, undefined);
  assert.deepEqual(persisted, ['media.play'], 'the second command waited for the first, then committed');
  assert.equal(room.state.paused, false);

  // A lapsed presence is noticed by the armed timer; the empty room then closes.
  now = coordinator.timerAt('room-2');
  timers.find(timer => timer.at === now).action();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(room.viewers.size, 0);
  assert.equal(room.frozen, true, 'its host may still come back within the grace');
});

test('a pending room write holds queued events and publications without partially admitting a synchronous join', async t => {
  const write = Promise.withResolvers();
  const changes = [];
  let writes = 0;
  const coordinator = Sync.createRoomCoordinator({
    authorize: Sync.policyAuthorize,
    onPersist: () => {
      writes++;
      return write.promise;
    },
    onChange: (room, type) => changes.push([type, room.state.paused, [...room.viewers.keys()]]),
    onPublish: (room, type) => changes.push([type, room.state.paused, [...room.viewers.keys()]]),
  });
  t.after(() => {
    write.resolve();
    coordinator.close();
  });
  const room = coordinator.add(
    Sync.createRoomState({ roomId: 'pending', creatorId: 'host', media: { id: 'm', duration: 60 } }),
  );
  const host = { userId: 'host' };
  const join = viewerId => ({ type: 'join', actor: host, viewerId });
  const play = { type: 'command', actor: host, command: { action: 'media.play' } };
  assert.equal(coordinator.runSync(room, join('host-tab')).value, 'host-tab');
  changes.length = 0;
  assert.match(coordinator.runSync(room, play).error.message, /persistence/);
  assert.equal(writes, 0);
  assert.equal(room.state.paused, true);

  const playing = coordinator.dispatch(room, play);
  const joining = coordinator.dispatch(room, join('queued-tab'));
  assert.equal(coordinator.publish(room, 'publish'), true);
  assert.equal(coordinator.runSync(room, join('sync-tab')).error.status, 409);
  assert.equal(writes, 1);
  assert.equal(room.state.paused, true);
  assert.deepEqual([...room.viewers.keys()], ['host-tab']);
  assert.deepEqual(changes, []);

  write.resolve();
  assert.equal((await playing).error, undefined);
  assert.equal((await joining).value, 'queued-tab');
  assert.deepEqual(changes, [
    ['command', false, ['host-tab']],
    ['join', false, ['host-tab', 'queued-tab']],
    ['publish', false, ['host-tab', 'queued-tab']],
  ]);
});

test('reducing and committing an event for a 30-viewer room stays well under a millisecond', () => {
  const room = Sync.createRoomState({ roomId: 'big', creatorId: 'host', now: 0 });
  const context = { now: 1, monoNow: 1, authorize: Sync.policyAuthorize };
  for (let i = 0; i < 30; i++)
    Sync.commitRoomState(
      room,
      Sync.reduceRoom(room, { type: 'join', actor: { userId: 'u' + i }, viewerId: 'v' + i }, context).state,
    );
  const runs = 500,
    started = performance.now();
  for (let i = 0; i < runs; i++)
    Sync.commitRoomState(room, Sync.reduceRoom(room, { type: 'touch', viewerId: 'v' + (i % 30) }, context).state);
  assert.ok((performance.now() - started) / runs < 1);
});

test('nearEndBounds and createSync clamp slight container duration shortfalls without truncating short streams', async () => {
  assert.deepEqual(Sync.nearEndBounds(10.3, 10.0), { duration: 10.0, ceiling: 9.95 });
  assert.deepEqual(Sync.nearEndBounds(120, 45), { duration: 120, ceiling: 44.95 });
  assert.deepEqual(Sync.nearEndBounds(10, 10.4), { duration: 10, ceiling: 10.35 });
  assert.deepEqual(Sync.nearEndBounds(10, NaN), { duration: 10, ceiling: 9.95 });
  assert.deepEqual(Sync.nearEndBounds(undefined, undefined), { duration: 0, ceiling: Infinity });

  const tailBuffered = { length: 1, start: () => 0, end: () => 9.96 };
  const incompleteBuffered = { length: 1, start: () => 0, end: () => 9.5 };
  assert.equal(Sync.readinessBuffered(tailBuffered, 9.95, 10.0), true);
  assert.equal(Sync.readinessBuffered(incompleteBuffered, 9.95, 10.0), false);

  let monoNow = 1000;
  let wallNow = 50_000;
  const clock = Sync.clock({ monotonic: () => monoNow, wall: () => wallNow });
  for (let i = 0; i < 4; i++) {
    monoNow += 30;
    wallNow += 30;
    const req = clock.begin();
    monoNow += 20;
    wallNow += 20;
    clock.add(req, {
      serverReceivedAt: wallNow,
      serverSentAt: wallNow,
      serverProcessingMs: 0,
      clockEpoch: 'epoch-1',
    });
  }

  let currentTime = 0;
  let playCalls = 0;
  const seeks = [];
  const noop = () => {};
  const snapshot = {
    mediaVersion: '00000000-0000-4000-8000-000000000010',
    streamVersion: '00000000-0000-4000-8000-000000000011',
    epoch: '00000000-0000-4000-8000-000000000012',
    revision: 1,
    waitingForReady: false,
    serverNow: clock.read().serverTime,
    state: { paused: true, position: 10.1, duration: 10.3, volume: 65, muted: false },
  };
  const sync = Sync.createSync({
    now: () => monoNow,
    player: {
      readyState: () => 4,
      currentTime: () => currentTime,
      seek: dest => {
        seeks.push(dest);
        currentTime = dest;
      },
      duration: () => 10.0,
      paused: () => true,
      ended: () => false,
      seeking: () => false,
      playbackRate: () => 1,
      setPlaybackRate: noop,
      setAudio: noop,
      play: async () => {
        playCalls++;
      },
      pause: noop,
      bufferedAhead: () => Math.max(0, 10.0 - currentTime),
      isBufferedAt: () => true,
    },
    read: () => ({
      receivedAt: monoNow,
      probing: false,
      playbackError: '',
      playerWaiting: false,
      autoplayBlocked: false,
      syncCorrectionMode: 'proportional',
      state: snapshot,
    }),
    clock,
    mediaReady: () => true,
    presentation: Sync.presentation(),
    expected: () => 10.1,
    decodedFrames: () => 0,
    unlockLocal: () => Promise.resolve(),
    reportReadiness: () => Promise.resolve(),
    render: noop,
    checkFrames: noop,
    sample: noop,
    error: noop,
    playing: noop,
    visibility: () => 'visible',
    online: () => true,
    repeat: () => 0,
    cancelRepeat: noop,
  });

  try {
    for (let i = 0; i < 5; i++) {
      monoNow += 500;
      await sync.synchronize();
    }
    assert.equal(seeks.length, 1, 'converges on one seek instead of looping near EOF');
    assert.ok(Math.abs(seeks[0] - 9.95) < 0.01);
    assert.equal(playCalls, 0);
  } finally {
    sync.close();
  }
});

test('room-authority preserves initial start countdown on media.play, skips commit/changed on reducer error, and fires 3s blocker reveal', async () => {
  let now = 50000;
  let monoNow = 10000;
  const timers = [];
  let changes = 0;
  const coordinator = Sync.createRoomCoordinator({
    authorize: Sync.policyAuthorize,
    now: () => now,
    monoNow: () => monoNow,
    timerOrigin: now,
    timerResolutionMs: 1000,
    setTimer: (action, delay) => {
      const entry = { at: now + delay, delay, action };
      timers.push(entry);
      return entry;
    },
    clearTimer: entry => {
      const i = timers.indexOf(entry);
      if (i !== -1) timers.splice(i, 1);
    },
    onChange: () => {
      changes++;
    },
  });
  const room = coordinator.add(
    Sync.createRoomState({
      roomId: 'r-b407',
      creatorId: 'host',
      now,
      media: { id: 'm', duration: 120 },
    }),
  );
  const host = { userId: 'host', name: 'Host' };
  const guest = { userId: 'guest', name: 'Guest' };
  coordinator.runSync(room, { type: 'join', actor: host, viewerId: 'v-host' });
  coordinator.runSync(room, { type: 'join', actor: guest, viewerId: 'v-guest' });
  room.initialGate = true;
  room.initialViewers = new Set(['v-host', 'v-guest']);
  Sync.beginReadiness(room, now, Sync.READINESS_WAIT_MS, { monoNow });
  coordinator.schedule(room);

  // 1. 3s blocker-reveal deadline is scheduled and publishes a non-quiet change when reached.
  assert.equal(coordinator.timerAt('r-b407'), now + Sync.READINESS_BLOCKER_REVEAL_MS);
  now += Sync.READINESS_BLOCKER_REVEAL_MS;
  monoNow += Sync.READINESS_BLOCKER_REVEAL_MS;
  const beforeRevealChanges = changes;
  timers.find(t => t.at === now).action();
  assert.equal(room.blockerRevealed, true);
  assert.ok(changes > beforeRevealChanges, '3s blocker reveal timer triggers onChange');

  // 2. When readiness releases into INITIAL_START_LEAD_MS (1750ms) countdown, media.play does not truncate it to 400ms.
  Sync.beginReadiness(room, now, Sync.READINESS_WAIT_MS, { monoNow });
  coordinator.runSync(room, {
    type: 'ready',
    actor: host,
    viewerId: 'v-host',
    mediaVersion: room.mediaVersion,
    readinessVersion: room.readinessVersion,
    ready: true,
  });
  coordinator.runSync(room, {
    type: 'ready',
    actor: guest,
    viewerId: 'v-guest',
    mediaVersion: room.mediaVersion,
    readinessVersion: room.readinessVersion,
    ready: true,
  });
  const initialStartAt = room.startAt;
  assert.equal(initialStartAt, now + Sync.INITIAL_START_LEAD_MS);
  coordinator.runSync(room, { type: 'command', actor: host, command: { action: 'media.play' } });
  assert.equal(room.startAt, initialStartAt, 'media.play during active initial start countdown preserves startAt');

  // 3. Failing reducer event does not commit draft mutations or emit onChange.
  room.kickedViewers.set('v-kicked', now + 30000);
  const revBeforeFail = room.revision;
  const changesBeforeFail = changes;
  const failedJoin = coordinator.runSync(room, {
    type: 'join',
    actor: { userId: 'other', name: 'Other' },
    viewerId: 'v-host',
  });
  assert.ok(failedJoin.error);
  assert.equal(room.revision, revBeforeFail);
  assert.equal(changes, changesBeforeFail, 'failed reducer event does not trigger onChange');
});
