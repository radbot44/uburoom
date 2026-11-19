'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PlaybackTracking } = require('../server/playback-tracking');
const { Accounts, credentialVault } = require('../server/accounts');
const policy = require('../web/playback-policy');
const syncWiring = require('../web/watch/sync-wiring.js');
const { mountModule } = require('./helpers/watch-module');

function client() {
  let mono = 1000,
    wall = 100000;
  const sent = [],
    events = new Map();
  const clock = policy.observationClock();
  clock.update('epoch', 100000, 1000, 1000);
  const time = {
    mono: () => mono,
    wall: () => wall,
    observation: clock,
    clock: { read: () => ({ valid: false }) },
    presentation: { read: () => undefined, interrupt() {} },
    target: () => undefined,
  };
  const { view: ctx } = mountModule(syncWiring, {
    observing: true,
    selected: 'room',
    state: { mediaUrl: 'url', streamVersion: 'stream', mediaVersion: 'media', observationEpoch: 'epoch' },
    mediaSource: 'url',
    viewerId: 'viewer',
    videoFrames: 30,
    time,
    video: {
      currentTime: 0,
      playbackRate: 1,
      readyState: 4,
      requestVideoFrameCallback() {},
      addEventListener: (name, run) => events.set(name, run),
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 100, droppedVideoFrames: 0 }),
    },
    diagnostics: { record() {} },
    syncQuality: { breakSample() {} },
    roomLink: {
      observe: async (_, data) => {
        sent.push(data);
        return { credit: { reason: 'baseline', creditedSeconds: 0 } };
      },
    },
  });
  return {
    ctx,
    time,
    sent,
    events,
    tick(ms = 1000, wallMs = ms) {
      mono += ms;
      wall += wallMs;
      clock.update('epoch', 100000 + mono - 1000, mono, mono);
      ctx.video.currentTime += ms / 1000;
      ctx.videoFrames += 30;
    },
  };
}

test('observations keep monotonic duration through client wall steps and queue in-flight reports or suppress when clock unavailable', async () => {
  const f = client();
  await f.ctx.reportObservation();
  f.tick(1000, 5745);
  await f.ctx.reportObservation();
  assert.equal(f.sent[1].observedAt - f.sent[0].observedAt, 1000);

  let resolveFlight;
  f.ctx.roomLink.observe = (_, data) =>
    new Promise(r => {
      f.sent.push(data);
      resolveFlight = r;
    });
  const first = f.ctx.reportObservation();
  assert.equal(f.ctx.observationPending, 1);
  f.ctx.video.ended = true;
  f.ctx.reportObservation();
  assert.equal(f.ctx.observationQueued, true);
  assert.equal(f.sent.length, 3);
  resolveFlight({ credit: { reason: 'baseline' } });
  await first;
  await new Promise(r => setTimeout(r, 10));
  assert.equal(f.sent.length, 4);
  assert.equal(f.sent[3].state, 'ended', 'in-flight ended observation drained after pending request');
  assert.equal(f.ctx.observationQueued, false);

  // Missing fresh clock suppresses reports with classified local reason
  const unanchored = client();
  const rows = [];
  unanchored.ctx.diagnostics.record = (event, fields) => rows.push({ event, ...fields });
  unanchored.time.observation = policy.observationClock();
  await unanchored.ctx.reportObservation();
  assert.equal(unanchored.sent.length, 0);
  assert.equal(rows[0].creditReason, 'clock-unavailable');
});

test('a held stream swap sends no reports about the stream the server already replaced', async () => {
  const f = client();
  f.ctx.heldStream = { next: { streamVersion: 'next-stream' } };
  for (let i = 0; i < 3; i++) {
    f.tick();
    await f.ctx.reportObservation();
  }
  assert.equal(f.sent.length, 0, 'every report during the hold would be a stream-changed rejection');
  assert.equal(f.ctx.observationQueued, false);
  f.ctx.heldStream = undefined;
  f.tick();
  await f.ctx.reportObservation();
  assert.equal(f.sent.length, 1, 'reports resume once the swap settles');
});

test('a waiting event in a shared-buffering room sends while a playing observation awaits acknowledgement', async () => {
  const f = client();
  f.ctx.state.pauseOnBuffering = true;
  f.ctx.state.state = { paused: false };
  const playing = Promise.withResolvers();
  f.ctx.roomLink.observe = async (_, data) => {
    f.sent.push(data);
    if (data.state === 'playing') await playing.promise;
    return {};
  };
  const pending = f.ctx.reportObservation();
  f.tick(1);
  f.events.get('waiting')();
  assert.deepEqual(
    f.sent.map(report => report.state),
    ['playing', 'buffering'],
  );
  assert.equal(f.sent[1].stalled, true);
  assert.ok(f.sent[1].sequence > f.sent[0].sequence);
  playing.resolve();
  await pending;
  assert.equal(f.ctx.observationPending, 0);
});

test('frame observation tracks advancing callbacks, freezes counters when callbacks stall, and falls back to native metrics', async () => {
  const f = client();
  await f.ctx.reportObservation();
  f.tick();
  await f.ctx.reportObservation();
  assert.equal(f.sent[1].frames - f.sent[0].frames, 30);

  // Frozen supported frame callbacks cannot be replaced with advancing native counters
  f.tick();
  f.ctx.videoFrames = 60;
  f.ctx.video.getVideoPlaybackQuality = () => ({ totalVideoFrames: 130, droppedVideoFrames: 0 });
  await f.ctx.reportObservation();
  assert.equal(f.sent[2].frames, f.sent[1].frames);

  // Native frame fallback requires absent callback support and retains resets/freezes
  let frames = 30;
  const video = { getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: 10 }) };
  assert.equal(policy.observationFrames(video, 999), 20);
  frames = 10;
  assert.equal(policy.observationFrames(video, 999), 0);
  assert.equal(policy.observationFrames({}, 999), 0, 'no decoder evidence cannot earn credit');
});

test('client clock steps in both directions retain exactly observed decoded credit', async () => {
  const f = client(),
    registry = new Accounts(undefined, credentialVault()),
    tracking = new PlaybackTracking(registry, () => f.sent.at(-1)?.sampleAt + 99000 || 100000);
  const room = { roomId: 'room', mediaVersion: 'media', media: { id: 'fixture', duration: 100 } };
  const viewer = {
    userId: 'user',
    observationEpoch: 'epoch',
    streamVersion: 'stream',
    mediaVersion: 'media',
    media: { kind: 'demo' },
  };
  try {
    for (const wallStep of [0, 5745, -9000, 1000]) {
      if (f.sent.length) f.tick(1000, wallStep);
      await f.ctx.reportObservation();
      tracking.observe(room, viewer, 'tab', f.sent.at(-1));
    }
    assert.equal(viewer.tracking.record.watchedSeconds, 3);
    assert.equal(viewer.tracking.record.sourceSeconds, 3);
  } finally {
    registry.close();
  }
});

test('observation clock manages poll jitter, refuses stale evidence, isolates epochs, and rebases server steps', () => {
  const clock = policy.observationClock();
  const revision = clock.update('a', 100000, 0, 100);
  assert.equal(clock.sample(1100), 101050);
  assert.equal(clock.update('a', 100900, 1000, 1600), revision, '600 ms RTT cannot perturb existing duration');
  assert.equal(clock.sample(2100), 102050);
  clock.update('a', 999999, 2000, 3200);
  assert.equal(clock.sample(4601), undefined, 'slow poll does not refresh evidence');
  assert.equal(clock.sample(1500), undefined, 'monotonic time cannot run backwards');
  clock.update('b', 103000, 3000, 4200);
  assert.equal(clock.sample(4200), undefined, 'new epoch cannot inherit old anchor');

  // Server clock steps rebase with a discontinuity and never backfill the boundary
  for (const step of [-4745, 4745]) {
    const stepClock = policy.observationClock(),
      stepRev = stepClock.update('a', 100000, 0, 0);
    assert.equal(stepClock.sample(1000), 101000);
    assert.ok(stepClock.update('a', 101000 + step, 1000, 1000) > stepRev);
    assert.equal(stepClock.sample(1000), 101000 + step);
    assert.equal(stepClock.update('a', 102000 + step, 2000, 2000), stepRev + 1);
    assert.equal(stepClock.sample(2000), 102000 + step);
  }
});

for (const wallStep of [30000, -10000]) {
  test(`Watch accepts decoded observations and natural completion after a ${wallStep}ms wall step`, async t => {
    const { Hub } = require('../server/core');
    const { Watch } = require('../server/watch');
    const { wireRooms } = require('./helpers/live-room');
    const { watchOperations } = require('../server/watch-operations');
    const { randomUUID } = require('node:crypto');
    let clock = Date.now(),
      wall = clock;
    t.mock.method(Date, 'now', () => wall);
    const registry = new Accounts(undefined, credentialVault());
    const host = { userId: registry.resolve('discord', '111111111111111111', 'Host').id, watchViewerId: randomUUID() };
    const hub = new Hub({ ownerId: '111111111111111111' });
    hub.clock = { now: () => clock };
    hub.access = { isMember: () => true, refresh: async () => true };
    const plex = {
      json: async () => ({ machineIdentifier: 'fixture-plex' }),
      prepare: async id => ({
        id,
        title: 'Fixture',
        duration: 100,
        kind: 'plex',
        format: 'file',
        resources: new Map(),
      }),
      stop: async () => {},
    };
    const watch = wireRooms(hub, plex, new Watch(hub, plex, undefined, registry));
    clearInterval(watch.roomState.timer);
    t.after(async () => {
      await watch.close();
      hub.close();
      await registry.close();
    });
    const roomId = await watch.roomState.create(host, { name: 'Clock regression', keepEmpty: true });
    const room = watch.rooms.get(roomId),
      viewerId = host.watchViewerId;
    watch.join(room, host, viewerId, { alive: async () => true, quality: 'direct' });
    assert.equal(
      (await hub.dispatch(host, { roomId, action: 'media.load', args: { mediaId: '100', quality: 'direct' } })).status,
      'applied',
    );
    await watch.prepareViewer(room, host, viewerId);
    room.initialGate = false;
    room.state.paused = false;
    room.manualPaused = false;
    room.position = 96;
    room.changedAt = clock;
    room.startAt = room.pauseAt = undefined;
    const operations = watchOperations({
      config: hub.config,
      hub,
      watch,
      registry,
      throttle: () => true,
      authorized: async () => ({ actor: host }),
      login: async () => host,
    });
    const viewer = room.viewers.get(viewerId);
    let sequence = 0;
    const observe = async (position, state = 'playing') => {
      sequence++;
      const response = await operations.observe(
        { headers: {} },
        {
          roomId,
          viewerId,
          observation: {
            epoch: room.epoch,
            mediaVersion: room.mediaVersion,
            streamVersion: viewer.streamVersion,
            observationEpoch: viewer.observationEpoch,
            sequence,
            sampleAt: sequence * 1000,
            observedAt: clock,
            position,
            state,
            frames: sequence * 30,
            rate: 1,
            discontinuity: 0,
          },
        },
      );
      assert.equal(response.status, 200, JSON.stringify(response.value));
      return response;
    };
    await observe(96);
    const startedAt = wall;
    wall += wallStep;
    for (const position of [97, 98, 99]) {
      clock += 1000;
      wall += 1000;
      const result = await observe(position);
      assert.equal(result.value.credit.reason, 'credited');
      assert.equal(result.value.watchedSeconds, position - 96);
      watch.tracking.expire(viewer);
      assert.ok(viewer.tracking, 'a wall step cannot expire live observations');
    }
    clock += 1000;
    wall += 1000;
    await observe(100, 'ended');
    assert.equal(room.media, undefined, 'natural completion archives and unloads the media');
    const history = (await watch.tracking.history(host.userId)).sessions;
    assert.equal(history.length, 1);
    assert.equal(history[0].startedAt, startedAt);
    assert.equal(history[0].lastReceivedAt, wall);
    assert.equal(history[0].endedAt, wall);
    assert.equal(history[0].watchedSeconds, 3);
  });
}
