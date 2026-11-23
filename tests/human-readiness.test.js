'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

const Sync = require('../shared/sync');
const { Hub } = require('../server/core');
const { liveWatch } = require('./helpers/live-room');
const RoomProtocol = require('../shared/room-protocol.mjs');
const WireProtocol = require('../shared/wire-protocol.mjs');

const { preset: permissionPreset } = Sync.Policy;

const { validateSyncCommand, controlFor, controlAllowed, controls } = Sync.Protocol;

const {
  HUMAN_CHECK_TTL_MS,
  PRESENCE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  createRoomState,
  createRoomCoordinator,
  policyAuthorize,
  beginReadiness,
  clearHumanCheck,
  snapshotHumanCheck,
  snapshotReadiness,
  nextDeadline,
} = Sync.RoomAuthority;

function createHarness({ media = { key: 'm1', duration: 600 }, permissions = undefined, withPersist = false } = {}) {
  let wall = 1_000_000;
  let mono = 10_000;
  let seq = 0;
  const changes = [];
  const persists = [];
  const createId = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  const host = { userId: '11111111-1111-4111-8111-111111111111', name: 'Alice' };
  const viewerA = { userId: '22222222-2222-4222-8222-222222222222', name: 'Bob' };
  const viewerB = { userId: '33333333-3333-4333-8333-333333333333', name: 'Carol' };
  const coordinator = createRoomCoordinator({
    authorize: policyAuthorize,
    now: () => wall,
    monoNow: () => mono,
    createId,
    setTimer: () => ({ unref() {} }),
    clearTimer: () => {},
    onChange(room, event) {
      changes.push({ event, revision: room.revision, humanCheck: snapshotHumanCheck(room, wall) });
    },
    ...(withPersist
      ? {
          onPersist: async (_state, meta) => {
            persists.push(meta);
          },
        }
      : {}),
  });
  const room = createRoomState({
    roomId: 'room-check-test',
    creatorId: host.userId,
    creatorName: host.name,
    visibility: 'public',
    permissions,
    now: wall,
    createId,
    media,
  });
  coordinator.add(room);
  return {
    coordinator,
    room,
    host,
    viewerA,
    viewerB,
    changes,
    persists,
    createId,
    advance(ms) {
      wall += ms;
      mono += ms;
    },
    now: () => wall,
    mono: () => mono,
  };
}

test('protocol validates human readiness check commands and playback control gating', () => {
  const checkId = randomUUID();
  assert.deepEqual(validateSyncCommand({ action: 'check.ask' }), { action: 'check.ask', args: {} });
  assert.deepEqual(validateSyncCommand({ action: 'check.clear' }), { action: 'check.clear', args: {} });
  assert.deepEqual(validateSyncCommand({ action: 'check.reply', args: { status: 'ready' } }), {
    action: 'check.reply',
    args: { status: 'ready' },
  });
  assert.deepEqual(validateSyncCommand({ action: 'check.reply', args: { status: 'hold', checkId } }), {
    action: 'check.reply',
    args: { status: 'hold', checkId },
  });

  assert.throws(() => validateSyncCommand({ action: 'check.reply', args: { status: 'maybe' } }));
  assert.throws(() => validateSyncCommand({ action: 'check.reply', args: { status: 'ready', checkId: 'bad' } }));

  assert.equal(controlFor({ action: 'check.ask' }), 'playback');
  assert.equal(controlFor({ action: 'check.clear' }), 'playback');
  assert.equal(controlFor({ action: 'check.reply' }), undefined);
  assert.equal(controlAllowed(controls({ playback: false }), { action: 'check.ask' }), false);
  assert.equal(controlAllowed(controls({ playback: false }), { action: 'check.clear' }), false);
  assert.equal(controlAllowed(controls({ playback: false }), { action: 'check.reply' }), true);
});

test('authorization enforces host or playPause for ask/clear and allows any admitted viewer to reply', async () => {
  const locked = createHarness({ permissions: permissionPreset('host-control') });
  await locked.coordinator.dispatch(locked.room, { type: 'join', viewerId: 'h1', actor: locked.host });
  await locked.coordinator.dispatch(locked.room, { type: 'join', viewerId: 'v1', actor: locked.viewerA });

  const deniedAsk = await locked.coordinator.dispatch(locked.room, {
    type: 'command',
    actor: locked.viewerA,
    command: { action: 'check.ask' },
  });
  assert.equal(deniedAsk.error.status, 403);

  const hostAsk = await locked.coordinator.dispatch(locked.room, {
    type: 'command',
    actor: locked.host,
    command: { action: 'check.ask' },
  });
  assert.equal(hostAsk.error, undefined);

  const viewerReply = await locked.coordinator.dispatch(locked.room, {
    type: 'command',
    actor: locked.viewerA,
    command: { action: 'check.reply', args: { status: 'hold' } },
  });
  assert.equal(viewerReply.error, undefined);

  const deniedClear = await locked.coordinator.dispatch(locked.room, {
    type: 'command',
    actor: locked.viewerA,
    command: { action: 'check.clear' },
  });
  assert.equal(deniedClear.error.status, 403);

  const control = createHarness({ permissions: permissionPreset('play-pause') });
  await control.coordinator.dispatch(control.room, { type: 'join', viewerId: 'h1', actor: control.host });
  await control.coordinator.dispatch(control.room, { type: 'join', viewerId: 'v1', actor: control.viewerA });
  const viewerAsk = await control.coordinator.dispatch(control.room, {
    type: 'command',
    actor: control.viewerA,
    command: { action: 'check.ask' },
  });
  assert.equal(viewerAsk.error, undefined);
  assert.equal(snapshotHumanCheck(control.room, control.now()).answers[control.viewerA.userId], 'ready');
});

test('human check marks starter ready, handles stale checkIds and replacement, works idle, and avoids persistence', async () => {
  const h = createHarness({ media: null, withPersist: true });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'h1', actor: h.host });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'v1', actor: h.viewerA });

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  const first = snapshotHumanCheck(h.room, h.now());
  assert.equal(first.askedBy, h.host.userId);
  assert.equal(first.answers[h.host.userId], 'ready');
  assert.equal(first.expiresAt, h.now() + HUMAN_CHECK_TTL_MS);
  assert.equal(h.persists.length, 0);

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerA,
    command: { action: 'check.reply', args: { status: 'hold', checkId: first.id } },
  });
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'hold');

  // Replacement discards earlier viewer answers and rejects stale checkId replies.
  h.advance(5000);
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  const second = snapshotHumanCheck(h.room, h.now());
  assert.notEqual(second.id, first.id);
  assert.deepEqual(second.answers, { [h.host.userId]: 'ready' });

  const stale = await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerA,
    command: { action: 'check.reply', args: { status: 'ready', checkId: first.id } },
  });
  assert.equal(stale.error.status, 409);

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerA,
    command: { action: 'check.reply', args: { status: 'ready', checkId: second.id } },
  });
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'ready');

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.clear' },
  });
  assert.equal(snapshotHumanCheck(h.room, h.now()), undefined);
  assert.equal(h.persists.length, 0);
});

test('auto-expires after 120 seconds via nextDeadline and notifies subscribers on timer', async () => {
  const h = createHarness();
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'h1', actor: h.host });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'v1', actor: h.viewerA });

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  const active = snapshotHumanCheck(h.room, h.now());
  const due = nextDeadline(h.room, h.now(), h.mono());
  assert.ok(due <= active.expiresAt);

  // Just before 120 s (keep presence alive with touch).
  h.advance(HUMAN_CHECK_TTL_MS - 1000);
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'h1' });
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'v1' });
  await h.coordinator.dispatch(h.room, { type: 'timer' });
  assert.ok(snapshotHumanCheck(h.room, h.now()));

  // Exactly at 120 s deadline.
  h.changes.length = 0;
  h.advance(1000);
  await h.coordinator.dispatch(h.room, { type: 'timer' });
  assert.equal(h.room.humanCheck, undefined);
  assert.equal(snapshotHumanCheck(h.room, h.now()), undefined);
  assert.equal(h.changes.length, 1);
  assert.equal(h.changes[0].event, 'timer');
  assert.equal(h.changes[0].humanCheck, undefined);
});

test('never mutates playback or decoder readiness and clears on play, media change, and room close', async () => {
  const h = createHarness();
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'h1', actor: h.host });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'v1', actor: h.viewerA });

  // Simulate paused room waiting behind initial decoder readiness gate.
  const seeded = await h.coordinator.step(h.room, room => {
    room.initialGate = true;
    room.manualPaused = true;
    room.readinessVersion = h.createId();
    room.initialViewers = new Set(['h1', 'v1']);
    beginReadiness(room, h.now(), 10000, { monoNow: h.mono(), createId: h.createId });
    room.state.paused = true;
  });
  assert.equal(seeded.error, undefined);
  await h.coordinator.dispatch(h.room, {
    type: 'ready',
    viewerId: 'h1',
    actor: h.host,
    mediaVersion: h.room.mediaVersion,
    readinessVersion: h.room.readinessVersion,
    ready: true,
  });
  await h.coordinator.dispatch(h.room, {
    type: 'ready',
    viewerId: 'v1',
    actor: h.viewerA,
    mediaVersion: h.room.mediaVersion,
    readinessVersion: h.room.readinessVersion,
    ready: true,
  });

  const epochBefore = h.room.epoch;
  const readinessBefore = snapshotReadiness(h.room, h.mono());
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerA,
    command: { action: 'check.reply', args: { status: 'hold' } },
  });

  assert.equal(h.room.state.paused, true);
  assert.equal(h.room.manualPaused, true);
  assert.equal(h.room.initialGate, true);
  assert.equal(h.room.epoch, epochBefore);
  assert.deepEqual(snapshotReadiness(h.room, h.mono()), readinessBefore);

  // Explicit readiness wait/cancel and seek/pause preserve humanCheck.
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'media.seek.absolute', args: { seconds: 30 } },
  });
  assert.ok(snapshotHumanCheck(h.room, h.now()));

  // media.play clears active humanCheck.
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'media.play' },
  });
  assert.equal(h.room.humanCheck, undefined);

  // Starting another check while playing leaves playback running; pausing preserves check; toggle-to-play clears it.
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  assert.equal(h.room.manualPaused, false);
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'media.toggle' },
  });
  assert.equal(h.room.manualPaused, true);
  assert.ok(snapshotHumanCheck(h.room, h.now()));
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'media.toggle' },
  });
  assert.equal(h.room.manualPaused, false);
  assert.equal(h.room.humanCheck, undefined);

  // Media version change / unload / room close clear humanCheck.
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  await h.coordinator.step(h.room, room => {
    room.mediaVersion = h.createId();
  });
  await h.coordinator.dispatch(h.room, { type: 'review' });
  assert.equal(h.room.humanCheck, undefined);

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  assert.equal(clearHumanCheck(h.room), true);
  assert.equal(h.room.humanCheck, undefined);

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  await h.coordinator.dispatch(h.room, { type: 'close', save: false });
  assert.equal(h.room.humanCheck, undefined);
});

test('answers are keyed by userId across tabs, survive reconnect grace, and clear on departure, kick, or grace expiry', async () => {
  const h = createHarness();
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'h1', actor: h.host });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'a1', actor: h.viewerA });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'a2', actor: h.viewerA });
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'b1', actor: h.viewerB });

  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.host,
    command: { action: 'check.ask' },
  });
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerA,
    command: { action: 'check.reply', args: { status: 'hold' } },
  });
  await h.coordinator.dispatch(h.room, {
    type: 'command',
    actor: h.viewerB,
    command: { action: 'check.reply', args: { status: 'ready' } },
  });

  // Closing one tab of viewerA keeps viewerA's reply because tab a2 remains.
  await h.coordinator.dispatch(h.room, { type: 'leave', viewerId: 'a1', actor: h.viewerA });
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'hold');

  // Unexpected disconnect moves a2 into reconnect grace; answer survives while within grace.
  h.advance(PRESENCE_TIMEOUT_MS + 100);
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'h1' });
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'b1' });
  await h.coordinator.dispatch(h.room, { type: 'timer' });
  assert.equal(h.room.viewers.has('a2'), false);
  assert.equal(h.room.disconnectedViewers.has('a2'), true);
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'hold');

  // Reconnecting within grace retains answer; letting a fresh disconnect expire grace clears it.
  await h.coordinator.dispatch(h.room, { type: 'join', viewerId: 'a2', actor: h.viewerA });
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'hold');

  h.advance(PRESENCE_TIMEOUT_MS + 100);
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'h1' });
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'b1' });
  await h.coordinator.dispatch(h.room, { type: 'timer' });
  assert.equal(snapshotHumanCheck(h.room, h.now()).answers[h.viewerA.userId], 'hold');

  h.changes.length = 0;
  h.advance(RECONNECT_GRACE_MS + 100);
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'h1' });
  await h.coordinator.dispatch(h.room, { type: 'touch', viewerId: 'b1' });
  await h.coordinator.dispatch(h.room, { type: 'timer' });
  assert.equal(h.room.humanCheck.answers.has(h.viewerA.userId), false);
  assert.ok(h.changes.some(change => change.event === 'timer'));

  // Kick removes viewerB's answer immediately.
  assert.equal(h.room.humanCheck.answers.get(h.viewerB.userId), 'ready');
  await h.coordinator.dispatch(h.room, { type: 'kick', userId: h.viewerB.userId });
  assert.equal(h.room.humanCheck.answers.has(h.viewerB.userId), false);
});

async function createServerHarness({ permissions = 'host-control', visibility = 'public' } = {}) {
  let wall = 1_000_000;
  const hub = new Hub({ ownerId: 'host' }, []);
  hub.clock = { now: () => wall };
  hub.access = {
    refresh: async () => true,
    isMember: () => true,
    voiceChannel: () => 'call',
    validVoiceChannel: () => true,
    options: () => ({ available: true }),
  };
  const { watch, registry, actor, open } = liveWatch(hub, { stop: async () => {}, allows: async () => true });
  const host = actor('host');
  const viewerA = actor('viewerA');
  const viewerB = actor('viewerB');
  const room = await open(host, { visibility, permissions: permissionPreset(permissions) });
  return {
    hub,
    watch,
    registry,
    room,
    host,
    viewerA,
    viewerB,
    now: () => wall,
    advance(ms) {
      wall += ms;
    },
    async close() {
      await watch.close();
    },
  };
}

test('server Hub.authorize, room-protocol, epoch preservation, and room-lane projection work across idle and playing states', async () => {
  const s = await createServerHarness({ permissions: 'host-control' });
  try {
    const hostTab = randomUUID();
    const viewerTab = randomUUID();
    s.watch.join(s.room, s.host, hostTab);
    s.watch.join(s.room, s.viewerA, viewerTab);

    assert.equal(RoomProtocol.command('check.ask').liveOnly, true);
    assert.equal(RoomProtocol.command('check.reply').roomLocal, true);
    assert.equal(WireProtocol.PROTOCOL_VERSION, 4);

    // Plain viewer cannot ask or clear in host-control, but can reply; non-watching viewer cannot reply.
    const nonWatching = await s.hub.dispatch(s.viewerB, {
      roomId: s.room.roomId,
      action: 'check.reply',
      args: { status: 'ready' },
    });
    assert.equal(nonWatching.status, 'forbidden');

    const deniedAsk = await s.hub.dispatch(s.viewerA, { roomId: s.room.roomId, action: 'check.ask' });
    assert.equal(deniedAsk.status, 'forbidden');

    // Works in idle room (no room.media loaded) and projects humanCheck on the room lane.
    const started = await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    assert.equal(started.status, 'applied');
    const viewAfterAsk = s.watch.view(s.room, s.viewerA, viewerTab, s.now());
    assert.equal(viewAfterAsk.canCheck, false);
    assert.equal(viewAfterAsk.humanCheck.askedBy, s.host.userId);
    assert.deepEqual(viewAfterAsk.humanCheck.answers, { [s.host.userId]: 'ready' });
    const lanes = WireProtocol.splitView(viewAfterAsk);
    assert.equal(WireProtocol.lanesAgree(lanes.room, lanes.viewer), true);
    assert.equal(lanes.room.humanCheck.id, viewAfterAsk.humanCheck.id);
    assert.equal('humanCheck' in lanes.viewer, false);

    const replied = await s.hub.dispatch(s.viewerA, {
      roomId: s.room.roomId,
      action: 'check.reply',
      args: { status: 'hold', checkId: viewAfterAsk.humanCheck.id },
    });
    assert.equal(replied.status, 'applied');
    assert.equal(s.watch.view(s.room, s.host, hostTab, s.now()).humanCheck.answers[s.viewerA.userId], 'hold');

    const deniedClear = await s.hub.dispatch(s.viewerA, { roomId: s.room.roomId, action: 'check.clear' });
    assert.equal(deniedClear.status, 'forbidden');

    // Verify room.epoch is preserved across check.ask / check.reply / check.clear during loaded playback.
    s.room.media = { kind: 'demo', title: 'Fixture', id: '123', duration: 300, roomServerId: 'fixture' };
    s.room.state.seekable = true;
    s.room.state.paused = false;
    s.room.manualPaused = false;
    const epochBefore = s.room.epoch;
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    const checkId = s.room.humanCheck.id;
    await s.hub.dispatch(s.viewerA, {
      roomId: s.room.roomId,
      action: 'check.reply',
      args: { status: 'hold', checkId },
    });
    assert.equal(s.room.epoch, epochBefore);

    // A concurrent command validated against pre-check epoch still succeeds.
    const paused = await s.hub.dispatch(s.host, {
      roomId: s.room.roomId,
      action: 'media.pause',
    });
    assert.equal(paused.status, 'applied');
    assert.equal(s.room.epoch, epochBefore);
    assert.ok(s.watch.view(s.room, s.host, hostTab, s.now()).humanCheck);

    // playPause-authorized viewer can ask and clear in play-pause preset.
    const p = await createServerHarness({ permissions: 'play-pause' });
    try {
      const hTab = randomUUID();
      const vTab = randomUUID();
      p.watch.join(p.room, p.host, hTab);
      p.watch.join(p.room, p.viewerA, vTab);
      assert.equal(p.watch.view(p.room, p.viewerA, vTab, p.now()).canCheck, true);
      const asked = await p.hub.dispatch(p.viewerA, { roomId: p.room.roomId, action: 'check.ask' });
      assert.equal(asked.status, 'applied');
      assert.equal(p.room.humanCheck.askedBy, p.viewerA.userId);
      assert.equal(p.room.humanCheck.answers.get(p.viewerA.userId), 'ready');
      const cleared = await p.hub.dispatch(p.viewerA, { roomId: p.room.roomId, action: 'check.clear' });
      assert.equal(cleared.status, 'applied');
      assert.equal(p.watch.view(p.room, p.host, hTab, p.now()).humanCheck, null);
    } finally {
      await p.close();
    }
  } finally {
    await s.close();
  }
});

test('server clears humanCheck on media.play, dropMedia/unloadQueueMedia/resetLive, 120s timer, and user departure, without SQLite persistence', async () => {
  const s = await createServerHarness({ permissions: 'host-control' });
  try {
    const hostTab = randomUUID();
    const viewerTab = randomUUID();
    s.watch.join(s.room, s.host, hostTab);
    s.watch.join(s.room, s.viewerA, viewerTab);
    s.room.media = { kind: 'demo', title: 'Fixture', id: '123', duration: 300, roomServerId: 'fixture' };
    s.room.state.seekable = true;

    // 1. media.play clears active humanCheck.
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    assert.ok(s.room.humanCheck);
    const played = await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'media.play' });
    assert.equal(played.status, 'applied');
    assert.equal(s.room.humanCheck, undefined);
    assert.equal(s.watch.view(s.room, s.host, hostTab, s.now()).humanCheck, null);

    // 2. capture/save excludes ephemeral humanCheck; dropMedia / unloadQueueMedia / resetLive clear it.
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    const captured = s.watch.roomState.capture(s.room, { at: s.now() });
    assert.equal('humanCheck' in captured, false);
    assert.equal('humanCheck' in (captured.live || {}), false);

    await s.watch.inRoom(s.room, () => s.watch.unloadQueueMedia(s.room));
    assert.equal(s.room.humanCheck, undefined);

    s.room.media = { kind: 'demo', title: 'Fixture 2', id: '124', duration: 300, roomServerId: 'fixture' };
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    await s.watch.inRoom(s.room, () => s.watch.roomState.resetLive(s.room, s.room.roomId));
    assert.equal(s.room.humanCheck, undefined);

    // 3. 120 s timer expiry clears humanCheck and increments roomVersion.
    s.room.viewers.get(hostTab).at = s.now();
    s.room.viewers.get(viewerTab).at = s.now();
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    const versionBeforeExpire = s.watch.roomVersion(s.room);
    s.advance(HUMAN_CHECK_TTL_MS);
    s.room.viewers.get(hostTab).at = s.now();
    s.room.viewers.get(viewerTab).at = s.now();
    await s.watch.coordinator.dispatch(s.room, { type: 'timer' });
    assert.equal(s.room.humanCheck, undefined);
    assert.ok(s.watch.roomVersion(s.room) > versionBeforeExpire);

    // 4. userId departure (grace expiry and leave) clears viewer's answer while keeping room open.
    s.watch.join(s.room, s.viewerB, randomUUID());
    await s.hub.dispatch(s.host, { roomId: s.room.roomId, action: 'check.ask' });
    await s.hub.dispatch(s.viewerA, {
      roomId: s.room.roomId,
      action: 'check.reply',
      args: { status: 'hold' },
    });
    await s.hub.dispatch(s.viewerB, {
      roomId: s.room.roomId,
      action: 'check.reply',
      args: { status: 'ready' },
    });

    // Leave immediately removes viewerB's answer.
    const vBTab = [...s.room.viewers.entries()].find(([, v]) => v.userId === s.viewerB.userId)[0];
    await s.watch.leave(s.room, s.viewerB, vBTab);
    assert.equal(s.room.humanCheck.answers.has(s.viewerB.userId), false);
    assert.equal(s.room.humanCheck.answers.get(s.viewerA.userId), 'hold');

    // Disconnect + grace expiry removes viewerA's answer and publishes room update.
    s.watch.disconnected(s.room.viewers.get(viewerTab).watchSocket, false, s.room.roomId, viewerTab);
    s.advance(PRESENCE_TIMEOUT_MS + 100);
    s.watch.present({ watchRtts: [] }, s.room.roomId, hostTab); // touch host
    s.room.viewers.get(hostTab).at = s.now();
    await s.watch.coordinator.dispatch(s.room, { type: 'timer' });
    assert.equal(s.room.humanCheck.answers.get(s.viewerA.userId), 'hold');

    const versionBeforeGrace = s.watch.roomVersion(s.room);
    s.advance(RECONNECT_GRACE_MS + 100);
    s.room.viewers.get(hostTab).at = s.now();
    await s.watch.coordinator.dispatch(s.room, { type: 'timer' });
    assert.equal(s.room.humanCheck.answers.has(s.viewerA.userId), false);
    assert.ok(s.watch.roomVersion(s.room) > versionBeforeGrace);
  } finally {
    await s.close();
  }
});
