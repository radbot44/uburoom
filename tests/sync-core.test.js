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

      const coordinator = esm.createRoomCoordinator();
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
      timeout: 10000
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
    pauseCalls: 0
  };

  const adapter = {
    readyState: () => customPlayerState.readyState,
    currentTime: () => customPlayerState.currentTime,
    seek(sec) { customPlayerState.currentTime = sec; },
    duration: () => customPlayerState.duration,
    paused: () => customPlayerState.paused,
    ended: () => customPlayerState.ended,
    seeking: () => customPlayerState.seeking,
    playbackRate: () => customPlayerState.playbackRate,
    setPlaybackRate(rate) { customPlayerState.playbackRate = rate; },
    setAudio(vol, muted) {
      if (vol !== undefined) customPlayerState.volume = vol;
      if (muted !== undefined) customPlayerState.muted = muted;
    },
    play() { customPlayerState.paused = false; customPlayerState.playCalls++; return Promise.resolve(); },
    pause() { customPlayerState.paused = true; customPlayerState.pauseCalls++; },
    bufferedAhead: pos => Math.max(0, customPlayerState.bufferedEnd - pos),
    isBufferedAt: pos => pos >= 0 && pos <= customPlayerState.bufferedEnd
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
      clockEpoch: 'epoch-1'
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
    state: { paused: true, position: 10, duration: 300, volume: 65, muted: false }
  };
  let receivedMono = monoNow;

  const makeTestAlarm = () => ({
    arm(key, targetTime, fn) { scheduledAlarms.push({ key, targetTime, fn, cancelled: false }); },
    cancel() { for (const a of scheduledAlarms) a.cancelled = true; }
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
      syncCorrectionMode: 'proportional'
    }),
    clock: playbackClock,
    presentation: Sync.presentation(),
    startAlarm: makeTestAlarm(),
    pauseAlarm: makeTestAlarm(),
    expected: () => Sync.target(currentRoom, receivedMono, monoNow, playbackClock),
    decodedFrames: () => 120,
    unlockLocal: async () => { readyVersion = currentRoom.mediaVersion; },
    reportReadiness: async () => { readinessCalls++; },
    render() {},
    checkFrames() {},
    sample() {},
    error() {},
    playing(ver) { if (ver !== undefined) readyVersion = ver; },
    visibility: () => 'visible',
    online: () => true,
    repeat: () => 0,
    cancelRepeat() {},
    now: () => monoNow
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
    state: { paused: false, position: 10, duration: 300, volume: 65, muted: false }
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
  assert.ok(customPlayerState.playbackRate > 1 && customPlayerState.playbackRate <= 1.04, 'nudges rate smoothly on sustained lag');

  // 4. Reached `pauseAt` pauses playback and restores nominal rate.
  const pauseServerNow = playbackClock.read().serverTime;
  currentRoom = {
    ...currentRoom,
    revision: 3,
    startAt: undefined,
    serverNow: pauseServerNow,
    pauseAt: pauseServerNow - 10,
    state: { paused: false, position: 15.25, duration: 300, volume: 65, muted: false }
  };
  receivedMono = monoNow;
  await sync.synchronize();
  assert.equal(customPlayerState.paused, true);
  assert.equal(customPlayerState.playbackRate, 1);
  sync.close();
});

test('createRoomCoordinator enforces tenant isolation, generic role capabilities, kick hierarchy, and readiness bypass', async () => {
  let now = 100_000;
  let monoNow = 5_000;
  const published = [];

  const coordinator = Sync.createRoomCoordinator({
    now: () => now,
    monoNow: () => monoNow,
    onPublish: event => published.push(event),
    isAdmin: actor => Boolean(actor?.isAdmin)
  });

  const creatorId = randomUUID();
  const creatorAlpha = { userId: creatorId, name: 'Alice', tenantId: 'tenant-alpha' };
  const hostAlpha = { userId: randomUUID(), name: 'Bob', tenantId: 'tenant-alpha' };
  const viewerAlpha = { userId: randomUUID(), name: 'Cara', tenantId: 'tenant-alpha' };
  const outsiderBeta = { userId: creatorId, name: 'AliceOtherTenant', tenantId: 'tenant-beta' };

  const room = coordinator.createRoom({
    tenantId: 'tenant-alpha',
    creatorId: creatorAlpha.userId,
    creatorName: creatorAlpha.name,
    name: 'Alpha Screening',
    visibility: 'public',
    hosts: [hostAlpha.userId],
    permissions: {
      host: { playPause: true, seek: true, chooseMedia: true, kickParticipants: true },
      viewer: { playPause: false, seek: false, continueWithoutHost: false }
    }
  });

  // Cross-tenant isolation: same userId in tenant-beta sees nothing and cannot join or command.
  assert.equal((await coordinator.listRooms(outsiderBeta, { tenantId: 'tenant-beta' })).length, 0);
  await assert.rejects(
    () => coordinator.joinViewer(room.id, outsiderBeta, { viewerId: randomUUID(), tenantId: 'tenant-beta' }),
    { status: 403 }
  );

  // Join viewer + host in tenant-alpha.
  const hostViewerId = randomUUID();
  const guestViewerId = randomUUID();
  await coordinator.joinViewer(room.id, hostAlpha, {
    viewerId: hostViewerId,
    rtts: [{ at: monoNow - 100, ms: 420 }]
  });
  let snap = await coordinator.joinViewer(room.id, viewerAlpha, {
    viewerId: guestViewerId,
    rtts: [{ at: monoNow - 100, ms: 80 }]
  });

  // Load an abstract 600s timeline with opaque content metadata.
  const loadedAlpha = await coordinator.loadTimeline(room.id, hostAlpha, {
    tenantId: 'tenant-alpha',
    duration: 600,
    position: 0,
    autoplay: true,
    content: { opaqueCiphertext: 'v1:encrypted-media-descriptor' }
  });
  assert.equal(loadedAlpha.status, 'applied');
  snap = await coordinator.snapshot(room.id, hostAlpha, { viewerId: hostViewerId });
  assert.equal(snap.waitingForReady, true);

  // Viewer without playPause capability is rejected.
  const deniedPlay = await coordinator.executeCommand(room.id, viewerAlpha, {
    epoch: snap.epoch,
    expiresAt: now + 2000,
    viewerId: guestViewerId,
    command: { action: 'media.play' }
  });
  assert.equal(deniedPlay.status, 'forbidden');

  // Host reports ready, guest stalls past readiness deadline -> host starts for ready viewers.
  await coordinator.reportReadiness(room.id, hostAlpha, {
    viewerId: hostViewerId,
    mediaVersion: snap.mediaVersion,
    ready: true,
    readinessVersion: snap.readinessVersion
  });
  assert.equal(room.paused, true, 'still gated while second initial viewer has not reported ready');

  monoNow += 5000;
  now += 5000;
  coordinator.touchViewer(room.id, hostViewerId, { tenantId: 'tenant-alpha', rttMs: 420 });
  coordinator.touchViewer(room.id, guestViewerId, { tenantId: 'tenant-alpha', rttMs: 80 });
  monoNow += Sync.READINESS_WAIT_MS - 4900;
  now += Sync.READINESS_WAIT_MS - 4900;
  const timedOutSnap = await coordinator.snapshot(room.id, hostAlpha, { viewerId: hostViewerId });
  assert.equal(timedOutSnap.readiness.timedOut, true);
  assert.equal(timedOutSnap.readiness.canStart, true);
  assert.deepEqual(timedOutSnap.readiness.blockers, ['Cara']);

  // Regular play is blocked until readiness decision is chosen.
  const blockedPlay = await coordinator.executeCommand(room.id, hostAlpha, {
    epoch: timedOutSnap.epoch,
    expiresAt: now + 2000,
    command: { action: 'media.play' }
  });
  assert.equal(blockedPlay.status, 'unavailable');

  const startReady = await coordinator.executeCommand(room.id, hostAlpha, {
    epoch: timedOutSnap.epoch,
    expiresAt: now + 2000,
    command: { action: 'media.ready.start', args: { readinessId: timedOutSnap.readiness.id } }
  });
  assert.equal(startReady.status, 'applied');
  assert.equal(room.paused, false);
  // Control lead accounts for the 420ms RTT viewer (+100ms margin => 520ms).
  assert.equal(room.startAt, now + 520);

  // Kick hierarchy: host cannot kick creator, CAN kick viewer, and kicked viewerId is held in cooldown.
  const creatorViewerId = randomUUID();
  await coordinator.joinViewer(room.id, creatorAlpha, { viewerId: creatorViewerId });
  const postJoinSnap = await coordinator.snapshot(room.id, hostAlpha, { viewerId: hostViewerId });

  const kickCreator = await coordinator.executeCommand(room.id, hostAlpha, {
    epoch: postJoinSnap.epoch,
    expiresAt: now + 2000,
    command: { action: 'room.kick', args: { userId: creatorAlpha.userId } }
  });
  assert.equal(kickCreator.status, 'forbidden');

  const kickViewer = await coordinator.executeCommand(room.id, hostAlpha, {
    epoch: postJoinSnap.epoch,
    expiresAt: now + 2000,
    command: { action: 'room.kick', args: { userId: viewerAlpha.userId } }
  });
  assert.equal(kickViewer.status, 'applied');
  await assert.rejects(
    () => coordinator.joinViewer(room.id, viewerAlpha, { viewerId: guestViewerId }),
    /removed from this room/
  );
  assert.ok(published.every(event => event.tenantId === 'tenant-alpha'));
});

test('stale commands and outdated epochs cannot mutate state, and coordination envelopes separate cleanly from content payloads', async () => {
  let now = 200_000;
  let monoNow = 10_000;
  const coordinator = Sync.createRoomCoordinator({
    now: () => now,
    monoNow: () => monoNow,
    idPattern: /^[a-z0-9-]+$/
  });

  const host = { userId: 'host-1', name: 'Host', tenantId: 'cephalopod-t1' };
  const room = coordinator.createRoom({
    tenantId: 'cephalopod-t1',
    creatorId: host.userId,
    creatorName: host.name,
    visibility: 'private'
  });
  const viewerId = randomUUID();
  await coordinator.joinViewer(room.id, host, { viewerId });
  const loaded = await coordinator.loadTimeline(room.id, host, {
    tenantId: 'cephalopod-t1',
    duration: 1800,
    position: 45,
    autoplay: false,
    content: { encryptedBlob: 'base64:AAECAwQFBgc=' }
  });
  assert.equal(loaded.status, 'applied');

  const before = await coordinator.snapshot(room.id, host, { viewerId });
  const initialRevision = room.revision;

  // 1. Expired command (`expiresAt <= now`)
  const expired = await coordinator.executeCommand(room.id, host, {
    epoch: before.epoch,
    expiresAt: now,
    command: { action: 'media.seek.absolute', args: { seconds: 120 } }
  });
  assert.equal(expired.status, 'unavailable');
  assert.equal(expired.httpStatus, 409);
  assert.equal(expired.reason, 'expired');

  // 2. TTL exceeding COMMAND_TTL_MS (`expiresAt > now + 3000`)
  const excessiveTtl = await coordinator.executeCommand(room.id, host, {
    epoch: before.epoch,
    expiresAt: now + Sync.COMMAND_TTL_MS + 1,
    command: { action: 'media.seek.absolute', args: { seconds: 120 } }
  });
  assert.equal(excessiveTtl.status, 'unavailable');
  assert.equal(excessiveTtl.reason, 'invalid-ttl');

  // 3. Outdated epoch after epoch rotation
  const oldEpoch = before.epoch;
  const visResult = await coordinator.executeCommand(room.id, host, {
    epoch: oldEpoch,
    expiresAt: now + 1500,
    command: { action: 'room.visibility', args: { visibility: 'public' } }
  });
  assert.equal(visResult.status, 'applied');
  assert.notEqual(room.epoch, oldEpoch);
  const revisionAfterVis = room.revision;

  const staleEpochSeek = await coordinator.executeCommand(room.id, host, {
    epoch: oldEpoch,
    expiresAt: now + 1500,
    command: { action: 'media.seek.absolute', args: { seconds: 300 } }
  });
  assert.equal(staleEpochSeek.status, 'unavailable');
  assert.equal(staleEpochSeek.httpStatus, 409);
  assert.equal(staleEpochSeek.reason, 'epoch-mismatch');
  assert.equal(room.position, 45, 'stale command never alters timeline position');
  assert.equal(room.revision, revisionAfterVis, 'stale command never bumps revision');
  assert.ok(revisionAfterVis > initialRevision);

  // 4. Snapshot envelope/content round-trip preserves opaque payloads and timeline fields.
  const latest = await coordinator.snapshot(room.id, host, { viewerId });
  const parts = Sync.splitRoomSnapshot(latest);
  assert.equal(parts.coordination.id, room.id);
  assert.equal(parts.coordination.epoch, room.epoch);
  assert.equal(parts.coordination.timeline.position, 45);
  assert.equal(parts.coordination.timeline.duration, 1800);
  assert.equal(parts.content.encryptedBlob, 'base64:AAECAwQFBgc=');
  assert.equal(Object.hasOwn(parts.coordination, 'encryptedBlob'), false);
  const recomposed = Sync.composeRoomSnapshot(parts);
  assert.equal(recomposed.encryptedBlob, 'base64:AAECAwQFBgc=');
  assert.equal(recomposed.state.position, 45);
  assert.equal(recomposed.epoch, room.epoch);
});

test('room-scoped subscription broker isolates room notifications across rooms and tenants', async () => {
  const deliveries = [];
  const broker = Sync.createSubscriptionBroker({
    publish(client, ctx) {
      deliveries.push({ id: client.id, roomOnly: ctx.roomOnly });
    },
    schedule: queueMicrotask
  });

  const roomA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const roomB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const clientA1 = { id: 'a1', tenantId: 't1', subscription: `/api/watch/rooms/${roomA}?viewer=1` };
  const clientB1 = { id: 'b1', tenantId: 't1', subscription: `/api/watch/rooms/${roomB}?viewer=2` };
  const clientLobby1 = { id: 'lobby1', tenantId: 't1', subscription: undefined };
  const clientA2 = { id: 'a2', tenantId: 't2', subscription: `/api/watch/rooms/${roomA}?viewer=3` };

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

test('self-hosted Uburoom integration uses shared/sync and isolates room-local WebSocket updates between rooms', { skip: !tlsAvailable }, async t => {
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
    clientSecret: 'fixture-secret'
  };
  const app = createApp(config, {
    oauthFetch: async url => new Response(JSON.stringify(
      String(url).endsWith('/token')
        ? { access_token: 'fixture', refresh_token: 'fixture', expires_in: 3600 }
        : { id: 'demo-host', username: 'Host' }
    ))
  });
  app.hub.access = { isMember: () => true, refresh: async () => true, options: () => ({ available: true }) };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = 'https://localhost:' + app.server.address().port;
  t.after(() => app.close());

  const getText = route => new Promise((resolve, reject) => {
    https.get(config.publicUrl + route, { ca: cert }, res => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });

  // Verify browser classic-script and native ESM sync endpoints serve cleanly.
  const [timingScript, esmModule] = await Promise.all([
    getText('/playback-timing.js'),
    getText('/shared/sync/client-sync.mjs')
  ]);
  assert.equal(timingScript.status, 200);
  assert.match(timingScript.body, /uburoomTiming/);
  assert.equal(esmModule.status, 200);
  assert.match(String(esmModule.headers['content-type']), /javascript/);

  const login = persona => new Promise((resolve, reject) => {
    const req = https.request(config.publicUrl + '/api/watch/demo-login', {
      method: 'POST',
      ca: cert,
      headers: { Origin: config.publicUrl, 'Content-Type': 'application/json' }
    }, res => {
      let raw = '';
      res.on('data', bytes => { raw += bytes; });
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ persona }));
  });

  async function connect(identity) {
    const ws = new WebSocket(config.publicUrl.replace('https:', 'wss:') + '/watch-socket', {
      ca: cert,
      origin: config.publicUrl
    });
    const events = [];
    const waiting = new Map();
    let seq = 0;
    ws.on('message', raw => {
      const msg = JSON.parse(raw.toString());
      events.push(msg);
      if (msg.type === 'response') {
        const pending = waiting.get(msg.id);
        if (pending) { waiting.delete(msg.id); pending(msg); }
      }
    });
    await once(ws, 'open');
    const authReply = once(ws, 'message');
    ws.send(JSON.stringify({ type: 'auth', token: identity.token, csrf: identity.csrf }));
    assert.equal(JSON.parse((await authReply)[0]).type, 'auth-ok');
    t.after(() => ws.close());
    return {
      ws,
      events,
      call(route, data) {
        return new Promise(resolve => {
          const id = ++seq;
          waiting.set(id, resolve);
          ws.send(JSON.stringify({ type: 'request', id, path: route, ...(data === undefined ? {} : { data }) }));
        });
      }
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
    command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } }
  });
  await second.call(`/api/watch/rooms/${roomB}/command`, {
    epoch: stateB.epoch,
    expiresAt: Date.now() + 2500,
    viewerId: viewerB,
    command: { action: 'media.load', args: { mediaId: 'demo', quality: 'direct' } }
  });

  stateA = (await host.call(`/api/watch/rooms/${roomA}?viewer=${viewerA}`)).value;
  stateB = (await second.call(`/api/watch/rooms/${roomB}?viewer=${viewerB}`)).value;

  // Align right after a periodic 1-second publish on `second` so we have a clean sub-second window.
  second.events.length = 0;
  await new Promise(resolve => {
    const check = () => {
      if (second.events.some(e => e.type === 'state')) resolve();
      else setTimeout(check, 15);
    };
    check();
  });

  const serverRoomB = app.watch.rooms.get(roomB);
  const seqBBefore = serverRoomB.transportSequence;
  const eventsBBefore = second.events.length;
  host.events.length = 0;

  // Trigger room-local readiness, play, and seek in Room A.
  await host.call(`/api/watch/rooms/${roomA}/ready`, {
    viewerId: viewerA,
    mediaVersion: stateA.mediaVersion,
    ready: true,
    readinessVersion: stateA.readinessVersion
  });
  stateA = (await host.call(`/api/watch/rooms/${roomA}?viewer=${viewerA}`)).value;
  const seekRes = await host.call(`/api/watch/rooms/${roomA}/command`, {
    epoch: stateA.epoch,
    expiresAt: Date.now() + 2500,
    viewerId: viewerA,
    command: { action: 'media.seek.absolute', args: { seconds: 3 } }
  });
  assert.equal(seekRes.value.status, 'applied');

  // Wait for Room A's pushed `state` notification to arrive.
  await new Promise(resolve => {
    const check = () => {
      if (host.events.some(e => e.type === 'state' && e.path?.includes(roomA))) resolve();
      else setTimeout(check, 10);
    };
    check();
  });

  assert.equal(serverRoomB.transportSequence, seqBBefore, 'Room A local actions do not trigger snapshot publications in Room B');
  assert.equal(second.events.length, eventsBBefore, 'Room B subscriber receives zero frames from Room A local playback mutations');
  assert.equal(second.events.some(e => e.type === 'state' && e.path?.includes(roomA)), false);
});

test('snapshot() enforces authorization, tenant isolation, revocation, kick eviction, non-leakage, and explicit internal boundaries', async () => {
  let now = 300_000;
  let monoNow = 20_000;
  const revokedUsers = new Set();
  const authAudit = [];

  let coordinator;
  const pushedMessages = [];
  const broker = Sync.createSubscriptionBroker({
    getTenantId: client => client.tenantId,
    getRoomId: client => client.subscribedRoomId,
    schedule: queueMicrotask,
    async publish(client) {
      if (!client.subscribedRoomId) return;
      try {
        const value = await coordinator.snapshot(client.subscribedRoomId, client.actor, {
          viewerId: client.viewerId,
          tenantId: client.tenantId,
          envelopeOnly: true
        });
        pushedMessages.push({ userId: client.actor.userId, status: 200, value });
      } catch (err) {
        if (err?.status === 403) {
          client.subscribedRoomId = undefined;
          client.viewerId = undefined;
          pushedMessages.push({ userId: client.actor.userId, status: 403, error: err.message });
          return;
        }
        throw err;
      }
    }
  });

  coordinator = Sync.createRoomCoordinator({
    now: () => now,
    monoNow: () => monoNow,
    isAdmin: actor => Boolean(actor?.isAdmin),
    authorize: async ({ tenantId, room, actor, operation }) => {
      authAudit.push({ tenantId, roomId: room.id, userId: actor.userId, operation });
      return !revokedUsers.has(`${tenantId}:${actor.userId}`);
    },
    onPublish: event => broker.notify(event)
  });

  const creatorAlpha = { userId: randomUUID(), name: 'Alice', tenantId: 'tenant-alpha' };
  const hostAlpha = { userId: randomUUID(), name: 'Bob', tenantId: 'tenant-alpha' };
  const outsiderAlpha = { userId: randomUUID(), name: 'EveSameTenant', tenantId: 'tenant-alpha' };
  const adminBeta = { userId: randomUUID(), name: 'BetaAdmin', tenantId: 'tenant-beta', isAdmin: true };
  const defaultTenantActor = { userId: randomUUID(), name: 'NoTenantField' };

  const privateRoom = coordinator.createRoom({
    tenantId: 'tenant-alpha',
    creatorId: creatorAlpha.userId,
    creatorName: creatorAlpha.name,
    name: 'Classified Room',
    visibility: 'private',
    hosts: [hostAlpha.userId],
    content: { secretKey: 'classified-cipher-envelope-v1' }
  });

  const creatorViewerId = randomUUID();
  const hostViewerId = randomUUID();
  await coordinator.joinViewer(privateRoom.id, creatorAlpha, { viewerId: creatorViewerId });
  await coordinator.joinViewer(privateRoom.id, hostAlpha, { viewerId: hostViewerId });
  await coordinator.loadTimeline(privateRoom.id, creatorAlpha, {
    duration: 900,
    position: 42,
    autoplay: false,
    content: { secretKey: 'classified-cipher-envelope-v1' }
  });

  // 1. Authorized room members retrieve the expected snapshot (composed and envelopeOnly).
  const authorizedSnap = await coordinator.snapshot(privateRoom.id, hostAlpha, {
    viewerId: hostViewerId,
    envelopeOnly: true
  });
  assert.equal(authorizedSnap.coordination.id, privateRoom.id);
  assert.equal(authorizedSnap.coordination.timeline.position, 42);
  assert.equal(authorizedSnap.content.secretKey, 'classified-cipher-envelope-v1');
  assert.ok(authAudit.some(entry => entry.operation === 'snapshot' && entry.userId === hostAlpha.userId));

  const seqBeforeUnauthorized = privateRoom.transportSequence;
  const revBeforeUnauthorized = privateRoom.revision;

  // 2 & 6. Unauthorized same-tenant user cannot read private room snapshot, does not mutate state,
  // and receives the exact same error as for a nonexistent room ID (no existence oracle).
  let privateErr;
  let missingErr;
  await assert.rejects(
    async () => {
      try {
        await coordinator.snapshot(privateRoom.id, outsiderAlpha);
      } catch (err) {
        privateErr = err;
        throw err;
      }
    },
    { status: 403, message: 'Room unavailable or private' }
  );
  await assert.rejects(
    async () => {
      try {
        await coordinator.snapshot(randomUUID(), outsiderAlpha);
      } catch (err) {
        missingErr = err;
        throw err;
      }
    },
    { status: 403, message: 'Room unavailable or private' }
  );
  assert.equal(privateErr.status, missingErr.status);
  assert.equal(privateErr.message, missingErr.message);
  assert.equal('secretKey' in privateErr, false);
  assert.equal(privateRoom.transportSequence, seqBeforeUnauthorized, 'unauthorized snapshot never bumps transportSequence');
  assert.equal(privateRoom.revision, revBeforeUnauthorized);

  // 3. Cross-tenant callers cannot retrieve or list another tenant's room by supplying target tenantId
  // (even when marked isAdmin in their own tenant, or when actor.tenantId is omitted).
  await assert.rejects(
    () => coordinator.snapshot(privateRoom.id, adminBeta, { tenantId: 'tenant-alpha' }),
    { status: 403, message: 'Room unavailable or private' }
  );
  await assert.rejects(
    () => coordinator.snapshot(privateRoom.id, defaultTenantActor, { tenantId: 'tenant-alpha' }),
    { status: 403, message: 'Room unavailable or private' }
  );
  await assert.rejects(
    () => coordinator.snapshot(privateRoom.id, undefined, { tenantId: 'tenant-alpha' }),
    { status: 403, message: 'Room unavailable or private' }
  );
  await assert.rejects(
    () => coordinator.listRooms(adminBeta, { tenantId: 'tenant-alpha' }),
    { status: 403 }
  );
  // Authorized member cannot impersonate another member's viewerId to read their streamVersion/observationEpoch.
  await assert.rejects(
    () => coordinator.snapshot(privateRoom.id, hostAlpha, { viewerId: creatorViewerId }),
    { status: 403, message: 'Viewer identity mismatch' }
  );
  assert.equal(privateRoom.transportSequence, seqBeforeUnauthorized);

  // Delimiter collision safety: `tenant="a::b", room="c"` vs `tenant="a", room="b::c"` never alias.
  const actorDelimitedA = { userId: randomUUID(), name: 'A', tenantId: 'org::alpha' };
  const actorDelimitedB = { userId: randomUUID(), name: 'B', tenantId: 'org' };
  coordinator.createRoom({
    tenantId: 'org::alpha',
    roomId: 'room-1',
    creatorId: actorDelimitedA.userId,
    visibility: 'private',
    content: { tag: 'delimited-secret' }
  });
  await assert.rejects(
    () => coordinator.snapshot('alpha::room-1', actorDelimitedB, { tenantId: 'org' }),
    { status: 403 }
  );

  // 4 & 5. Revoked access and kicked/removed participants lose snapshot & subscription access immediately,
  // while authorized subscribers and `inspectRoomInternal` continue working across explicit boundaries.
  const publicRoom = coordinator.createRoom({
    tenantId: 'tenant-alpha',
    creatorId: creatorAlpha.userId,
    creatorName: creatorAlpha.name,
    visibility: 'public',
    content: { topic: 'initial-public' }
  });
  const creatorPubViewer = randomUUID();
  const guestPubViewer = randomUUID();
  await coordinator.joinViewer(publicRoom.id, creatorAlpha, { viewerId: creatorPubViewer });
  await coordinator.joinViewer(publicRoom.id, outsiderAlpha, { viewerId: guestPubViewer });

  const creatorClient = {
    tenantId: 'tenant-alpha',
    actor: creatorAlpha,
    subscribedRoomId: publicRoom.id,
    viewerId: creatorPubViewer
  };
  const guestClient = {
    tenantId: 'tenant-alpha',
    actor: outsiderAlpha,
    subscribedRoomId: publicRoom.id,
    viewerId: guestPubViewer
  };
  broker.add(creatorClient);
  broker.add(guestClient);

  // Kick guest -> kicked viewerId cannot fetch snapshots during cooldown.
  const snapBeforeKick = await coordinator.snapshot(publicRoom.id, creatorAlpha, { viewerId: creatorPubViewer });
  const kickRes = await coordinator.executeCommand(publicRoom.id, creatorAlpha, {
    epoch: snapBeforeKick.epoch,
    expiresAt: now + 2000,
    command: { action: 'room.kick', args: { userId: outsiderAlpha.userId } }
  });
  assert.equal(kickRes.status, 'applied');
  await assert.rejects(
    () => coordinator.snapshot(publicRoom.id, outsiderAlpha, { viewerId: guestPubViewer }),
    { status: 403 }
  );

  // Re-subscribe hostAlpha to privateRoom, then revoke hostAlpha via `authorize` callback ->
  // broker publication catches 403 and unsubscribes hostAlpha while creatorAlpha still receives updates!
  const hostClient = {
    tenantId: 'tenant-alpha',
    actor: hostAlpha,
    subscribedRoomId: privateRoom.id,
    viewerId: hostViewerId
  };
  const creatorPrivClient = {
    tenantId: 'tenant-alpha',
    actor: creatorAlpha,
    subscribedRoomId: privateRoom.id,
    viewerId: creatorViewerId
  };
  broker.add(hostClient);
  broker.add(creatorPrivClient);
  pushedMessages.length = 0;

  revokedUsers.add(`tenant-alpha:${hostAlpha.userId}`);
  await assert.rejects(
    () => coordinator.snapshot(privateRoom.id, hostAlpha, { viewerId: hostViewerId }),
    { status: 403, message: 'Room unavailable or private' }
  );

  const seekAfterRevoke = await coordinator.executeCommand(privateRoom.id, creatorAlpha, {
    epoch: privateRoom.epoch,
    expiresAt: now + 2000,
    command: { action: 'media.seek.absolute', args: { seconds: 105 } }
  });
  assert.equal(seekAfterRevoke.status, 'applied');
  await new Promise(resolve => queueMicrotask(resolve));
  await new Promise(resolve => queueMicrotask(resolve));

  const creatorPush = pushedMessages.find(m => m.userId === creatorAlpha.userId && m.status === 200);
  const revokedPush = pushedMessages.find(m => m.userId === hostAlpha.userId);
  assert.ok(creatorPush, 'authorized subscriber receives published snapshot');
  assert.equal(creatorPush.value.coordination.timeline.position, 105);
  assert.equal(revokedPush?.status, 403, 'revoked subscriber is denied snapshot publication');
  assert.equal(revokedPush?.value, undefined);
  assert.equal(hostClient.subscribedRoomId, undefined, 'revoked subscriber is unsubscribed on 403');

  // Privileged internal inspection reads state without actor or mutating transportSequence.
  const seqBeforeInternal = privateRoom.transportSequence;
  const internalView = coordinator.inspectRoomInternal(privateRoom.id, { tenantId: 'tenant-alpha' });
  assert.equal(internalView.coordination.id, privateRoom.id);
  assert.equal(internalView.coordination.roomRole, undefined);
  assert.equal(internalView.content.secretKey, 'classified-cipher-envelope-v1');
  assert.equal(privateRoom.transportSequence, seqBeforeInternal, 'inspectRoomInternal does not increment transportSequence');
});

test('expectedRevision preconditions enforce optimistic concurrency without state mutation or async interleaving', async () => {
  let now = 400_000;
  let monoNow = 30_000;
  let asyncAuthDelayMs = 0;
  const persistedRevisions = [];

  const coordinator = Sync.createRoomCoordinator({
    now: () => now,
    monoNow: () => monoNow,
    authorize: async () => {
      if (asyncAuthDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, asyncAuthDelayMs));
      }
      return true;
    },
    onPersist: async room => {
      if (asyncAuthDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      persistedRevisions.push(room.revision);
    }
  });

  const host = { userId: randomUUID(), name: 'Host', tenantId: 'tenant-rev' };
  const secondHost = { userId: randomUUID(), name: 'CoHost', tenantId: 'tenant-rev' };
  const room = coordinator.createRoom({
    tenantId: 'tenant-rev',
    creatorId: host.userId,
    creatorName: host.name,
    hosts: [secondHost.userId],
    visibility: 'private'
  });

  const hostViewer = randomUUID();
  const secondViewer = randomUUID();
  await coordinator.joinViewer(room.id, host, { viewerId: hostViewer });
  await coordinator.joinViewer(room.id, secondHost, { viewerId: secondViewer });

  const loaded = await coordinator.loadTimeline(room.id, host, {
    expectedRevision: room.revision,
    duration: 600,
    position: 20,
    autoplay: false,
    content: { mediaKey: 'ep-1' }
  });
  assert.equal(loaded.status, 'applied');
  const revAfterLoad = room.revision;

  // 1. Matching expectedRevision succeeds and increments revision.
  const seekOk = await coordinator.executeCommand(room.id, host, {
    epoch: room.epoch,
    expectedRevision: revAfterLoad,
    expiresAt: now + 2000,
    viewerId: hostViewer,
    command: { action: 'media.seek.absolute', args: { seconds: 60 } }
  });
  assert.equal(seekOk.status, 'applied');
  assert.equal(seekOk.revision, revAfterLoad + 1);
  assert.equal(room.position, 60);

  // 2 & 3. Stale and malformed expectedRevision values are rejected and leave room state untouched.
  const snapshotBeforeRejections = {
    position: room.position,
    paused: room.paused,
    epoch: room.epoch,
    revision: room.revision,
    readinessVersion: room.readinessVersion,
    transportSequence: room.transportSequence
  };

  const staleSeek = await coordinator.executeCommand(room.id, host, {
    epoch: room.epoch,
    expectedRevision: revAfterLoad, // stale: room.revision is revAfterLoad + 1
    expiresAt: now + 2000,
    viewerId: hostViewer,
    command: { action: 'media.seek.absolute', args: { seconds: 240 } }
  });
  assert.equal(staleSeek.status, 'unavailable');
  assert.equal(staleSeek.httpStatus, 409);
  assert.equal(staleSeek.reason, 'revision-mismatch');

  for (const badRev of [-1, 1.5, '2', null, NaN]) {
    const malformed = await coordinator.executeCommand(room.id, host, {
      epoch: room.epoch,
      expectedRevision: badRev,
      expiresAt: now + 2000,
      command: { action: 'media.pause' }
    });
    assert.equal(malformed.status, 'unavailable');
    assert.equal(malformed.httpStatus, 400);
    assert.equal(malformed.reason, 'invalid-revision');
  }

  // 5. Expired commands and stale epochs remain rejected without mutating state.
  const expiredCmd = await coordinator.executeCommand(room.id, host, {
    epoch: room.epoch,
    expectedRevision: room.revision,
    expiresAt: now - 1,
    command: { action: 'media.seek.absolute', args: { seconds: 300 } }
  });
  assert.equal(expiredCmd.status, 'unavailable');
  assert.equal(expiredCmd.httpStatus, 409);
  assert.equal(expiredCmd.reason, 'expired');

  const wrongEpochCmd = await coordinator.executeCommand(room.id, host, {
    epoch: '00000000-0000-4000-8000-000000000000',
    expectedRevision: room.revision,
    expiresAt: now + 2000,
    command: { action: 'media.seek.absolute', args: { seconds: 300 } }
  });
  assert.equal(wrongEpochCmd.status, 'unavailable');
  assert.equal(wrongEpochCmd.httpStatus, 409);
  assert.equal(wrongEpochCmd.reason, 'epoch-mismatch');

  assert.deepEqual({
    position: room.position,
    paused: room.paused,
    epoch: room.epoch,
    revision: room.revision,
    readinessVersion: room.readinessVersion,
    transportSequence: room.transportSequence
  }, snapshotBeforeRejections, 'rejected commands never modify room position, pause state, epoch, revision, readiness, or sequence');

  // 4. Commands omitting optional expectedRevision continue to work when epoch and expiresAt are valid.
  const omittedRevSeek = await coordinator.executeCommand(room.id, host, {
    epoch: room.epoch,
    expiresAt: now + 2000,
    viewerId: hostViewer,
    command: { action: 'media.seek.absolute', args: { seconds: 95 } }
  });
  assert.equal(omittedRevSeek.status, 'applied');
  assert.equal(room.position, 95);

  // 6. Concurrent conflicting updates with the same expectedRevision cannot bypass optimistic concurrency
  // across async `authorize` and `onPersist` boundaries.
  asyncAuthDelayMs = 15;
  persistedRevisions.length = 0;
  const contestedRevision = room.revision;
  const [resA, resB, resC] = await Promise.all([
    coordinator.executeCommand(room.id, host, {
      epoch: room.epoch,
      expectedRevision: contestedRevision,
      expiresAt: now + 2500,
      viewerId: hostViewer,
      command: { action: 'media.seek.absolute', args: { seconds: 150 } }
    }),
    coordinator.executeCommand(room.id, secondHost, {
      epoch: room.epoch,
      expectedRevision: contestedRevision,
      expiresAt: now + 2500,
      viewerId: secondViewer,
      command: { action: 'media.seek.absolute', args: { seconds: 250 } }
    }),
    coordinator.executeCommand(room.id, host, {
      epoch: room.epoch,
      expectedRevision: contestedRevision,
      expiresAt: now + 2500,
      viewerId: hostViewer,
      command: { action: 'media.pause' }
    })
  ]);

  const outcomes = [resA, resB, resC];
  const appliedOutcomes = outcomes.filter(o => o.status === 'applied');
  const conflictOutcomes = outcomes.filter(o => o.status === 'unavailable' && o.httpStatus === 409 && o.reason === 'revision-mismatch');
  assert.equal(appliedOutcomes.length, 1, 'exactly one concurrent command with contested expectedRevision succeeds');
  assert.equal(conflictOutcomes.length, 2, 'other concurrent commands with the same expectedRevision fail with 409 revision-mismatch');
  assert.equal(room.revision, contestedRevision + 1);
  assert.equal(room.position, 150);
  assert.deepEqual(persistedRevisions, [contestedRevision + 1], 'onPersist fires once for the winning transition in monotonic revision order');
});
