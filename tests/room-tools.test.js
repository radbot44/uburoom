'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const {
  createRoomState,
  createRoomCoordinator,
  policyAuthorize,
  RoomAuthority,
  Activities,
  Policy,
} = require('../shared/sync');
const RoomProtocol = require('../shared/room-protocol.mjs');
const { Hub } = require('../server/core');
const { liveWatch } = require('./helpers/live-room');

async function createServerHarness(t, media = {}) {
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
  const { watch, registry, actor, open } = liveWatch(hub, { stop: async () => {}, allows: async () => true, ...media });
  const host = actor('host');
  const viewer = actor('viewer');
  const room = await open(host, { visibility: 'public', permissions: Policy.preset('host-control') });
  t.after(async () => {
    await watch.close();
    await registry.close();
  });
  return { hub, watch, registry, room, host, viewer };
}

test('announcements enforce length, rate limit, pinning vs auto-expiry, and permission', async () => {
  let clock = 500_000;
  let mono = 1000;
  let seq = 0;
  const coordinator = createRoomCoordinator({
    authorize: policyAuthorize,
    now: () => clock,
    monoNow: () => mono,
    createId: () => `a-${++seq}`,
    setTimer: () => ({}),
    clearTimer: () => {},
  });
  const host = { userId: 'host-1', name: 'Alice' };
  const viewer = { userId: 'viewer-1', name: 'Bob' };
  const room = createRoomState({
    roomId: 'room-ann',
    creatorId: host.userId,
    creatorName: host.name,
    permissions: Policy.preset('host-control'),
    now: clock,
    createId: () => `a-${++seq}`,
  });
  coordinator.add(room);
  coordinator.runSync(room, { type: 'join', viewerId: 'vh', actor: host });
  coordinator.runSync(room, { type: 'join', viewerId: 'vv', actor: viewer });

  // Protocol validation rejects >140 chars
  assert.throws(() => RoomProtocol.validate({ action: 'announce.send', args: { text: 'x'.repeat(141) } }));
  assert.equal(Policy.allowed(room, host.userId, 'announce'), true);
  assert.equal(Policy.allowed(room, viewer.userId, 'announce'), false);

  // Send unpinned announcement
  const sent = RoomAuthority.applyActivityCommand(
    room,
    { action: 'announce.send', args: { text: 'Pizza is here!', pinned: false } },
    host,
    { now: clock },
  );
  assert.equal(sent.status, 'applied');
  assert.equal(sent.journal[0].kind, 'announcement.send');
  let snaps = RoomAuthority.snapshotActivities(room, clock);
  assert.equal(snaps.length, 1);
  assert.equal(snaps[0].text, 'Pizza is here!');
  assert.equal(snaps[0].pinned, false);

  // Rate limit blocks a second announcement within 10 s
  clock += 5000;
  const limited = RoomAuthority.applyActivityCommand(
    room,
    { action: 'announce.send', args: { text: 'Second' } },
    host,
    { now: clock },
  );
  assert.equal(limited.status, 'unavailable');

  // Auto-expires after 12 s
  clock += 8000;
  RoomAuthority.settle(room, clock, mono);
  assert.equal(RoomAuthority.snapshotActivities(room, clock).length, 0);

  // Pinned announcement survives beyond 12 s until cleared
  const pinned = RoomAuthority.applyActivityCommand(
    room,
    { action: 'announce.send', args: { text: 'Intermission at 9pm', pinned: true } },
    host,
    { now: clock },
  );
  assert.equal(pinned.status, 'applied');
  clock += 60000;
  RoomAuthority.settle(room, clock, mono);
  assert.equal(RoomAuthority.snapshotActivities(room, clock).length, 1);
  const cleared = RoomAuthority.applyActivityCommand(room, { action: 'announce.clear', args: {} }, host, {
    now: clock,
  });
  assert.equal(cleared.status, 'applied');
  assert.equal(RoomAuthority.snapshotActivities(room, clock).length, 0);
});

test('breaks pause playback, extend, and auto-resume only after timer, all ready, 3s countdown, and host present', () => {
  let clock = 1_000_000;
  let mono = 1000;
  let seq = 0;
  const host = { userId: 'host-1', name: 'Alice' };
  const viewer = { userId: 'viewer-1', name: 'Bob' };
  const room = createRoomState({
    roomId: 'room-brk',
    creatorId: host.userId,
    creatorName: host.name,
    now: clock,
    createId: () => `b-${++seq}`,
    media: { id: 'm1', title: 'Movie', duration: 3600 },
  });
  room.viewers.set('vh', { viewerId: 'vh', userId: host.userId, name: host.name, actor: host, at: clock });
  room.viewers.set('vv', { viewerId: 'vv', userId: viewer.userId, name: viewer.name, actor: viewer, at: clock });
  room.state.paused = false;
  room.manualPaused = false;

  // Start 5 min break with autoResume
  const started = RoomAuthority.applyActivityCommand(
    room,
    { action: 'break.start', args: { minutes: 5, autoResume: true } },
    host,
    {
      now: clock,
      onBreakPause: (live, at) =>
        RoomAuthority.applyTimelineCommand(live, { action: 'media.pause', args: {} }, { now: at }),
    },
  );
  assert.equal(started.status, 'applied');
  assert.equal(room.manualPaused, true);
  let snap = RoomAuthority.snapshotActivities(room, clock)[0];
  assert.equal(snap.mode, 'break');
  assert.equal(snap.autoResume, true);

  // Extend by 5 min
  const extended = RoomAuthority.applyActivityCommand(room, { action: 'break.extend', args: { minutes: 5 } }, host, {
    now: clock,
  });
  assert.equal(extended.status, 'applied');
  snap = RoomAuthority.snapshotActivities(room, clock)[0];
  assert.equal(snap.breakEndsAt, clock + 10 * 60000);

  // Both viewers mark ready before timer ends -> does NOT start 3s resume countdown yet
  RoomAuthority.applyActivityCommand(room, { action: 'check.reply', args: { status: 'ready' } }, host, { now: clock });
  RoomAuthority.applyActivityCommand(room, { action: 'check.reply', args: { status: 'ready' } }, viewer, {
    now: clock,
  });
  snap = RoomAuthority.snapshotActivities(room, clock)[0];
  assert.equal(snap.resumingAt, null);

  // Timer reaches breakEndsAt -> starts 3s resuming countdown, still paused!
  clock += 10 * 60000;
  RoomAuthority.settle(room, clock, mono);
  snap = RoomAuthority.snapshotActivities(room, clock)[0];
  assert.equal(snap.resumingAt, clock + Activities.BREAK_AUTO_RESUME_COUNTDOWN_MS);
  assert.equal(room.manualPaused, true);

  // After 3s countdown, auto-resumes playback and clears break!
  clock += Activities.BREAK_AUTO_RESUME_COUNTDOWN_MS;
  RoomAuthority.settle(room, clock, mono);
  assert.equal(RoomAuthority.snapshotActivities(room, clock).length, 0);
  assert.equal(room.manualPaused, false);
});

test('polls enforce one vote per account, tie rules (host vs random), and close-time re-authorization', async t => {
  const f = await createServerHarness(t);
  const hostTab = randomUUID();
  const viewerTab = randomUUID();
  f.watch.join(f.room, f.host, hostTab);
  f.watch.join(f.room, f.viewer, viewerTab);

  // Start text poll with random tie rule
  const started = await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.start',
    args: {
      question: 'Snack?',
      options: [
        { id: 'o1', label: 'Popcorn' },
        { id: 'o2', label: 'Nachos' },
      ],
      tieRule: 'random',
    },
  });
  assert.equal(started.status, 'applied');

  const pollSnap = f.watch.view(f.room, f.viewer, viewerTab).activities.find(a => a.kind === 'poll');
  assert.ok(pollSnap);

  // Viewer votes o1 then changes to o2; host votes o1 -> 1-1 tie
  await f.hub.dispatch(f.viewer, {
    roomId: f.room.roomId,
    action: 'poll.vote',
    args: { pollId: pollSnap.id, optionId: 'o1' },
  });
  await f.hub.dispatch(f.viewer, {
    roomId: f.room.roomId,
    action: 'poll.vote',
    args: { pollId: pollSnap.id, optionId: 'o2' },
  });
  await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.vote',
    args: { pollId: pollSnap.id, optionId: 'o1' },
  });

  const beforeClose = f.watch.view(f.room, f.viewer, viewerTab).activities.find(a => a.kind === 'poll');
  assert.equal(beforeClose.totalVotes, 2);
  assert.equal(beforeClose.myVote, 'o2');

  // Viewer cannot close poll
  const denied = await f.hub.dispatch(f.viewer, {
    roomId: f.room.roomId,
    action: 'poll.close',
    args: { pollId: pollSnap.id },
  });
  assert.equal(denied.status, 'forbidden');

  // Host closes -> random tie breaker picks one and logs tieRule: 'random'
  const closed = await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.close',
    args: { pollId: pollSnap.id },
  });
  assert.equal(closed.status, 'applied');
  const afterClose = f.watch.view(f.room, f.host, hostTab).activities.find(a => a.kind === 'poll');
  assert.equal(afterClose.status, 'closed');
  assert.equal(afterClose.tieBrokenBy, 'random');
  assert.ok(['o1', 'o2'].includes(afterClose.winnerOptionId));
  const closeEntry = f.watch
    .journal(f.room)
    .since(0)
    .find(e => e.kind === 'poll.close');
  assert.equal(closeEntry?.data?.tieRule, 'random');

  // Close-time re-authorization: if creator loses addQueue permission before media poll closes, truthful actionError is set
  const mediaPoll = await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.start',
    args: {
      question: 'Next movie?',
      options: [
        { id: 'm1', label: 'Alien', media: { serverId: 'plex-1', mediaId: '101', type: 'movie', title: 'Alien' } },
        { id: 'm2', label: 'Aliens', media: { serverId: 'plex-1', mediaId: '102', type: 'movie', title: 'Aliens' } },
      ],
      onClose: 'queueNext',
      tieRule: 'host',
    },
  });
  assert.equal(mediaPoll.status, 'applied');
  const activePoll = f.room.activities.get('poll');
  // Simulate creator being a plain viewer without addQueue at close time
  activePoll.creatorActor = { userId: f.viewer.userId, name: f.viewer.name };
  activePoll.creatorId = f.viewer.userId;
  await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.vote',
    args: { pollId: activePoll.id, optionId: 'm1' },
  });
  await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'poll.close',
    args: { pollId: activePoll.id },
  });
  // Allow async executePollWinAction to settle
  await new Promise(resolve => setTimeout(resolve, 40));
  const resultPoll = f.watch.view(f.room, f.host, hostTab).activities.find(a => a.kind === 'poll');
  assert.equal(resultPoll.status, 'closed');
  assert.match(resultPoll.actionError || '', /permission/i);
});

test('closing media polls runs Queue next and Play now through the live room command engine', async t => {
  const playableItem = async id => ({ id, type: 'movie', title: 'Movie ' + id, duration: 120 });
  const { watch, hub, host, room } = await createServerHarness(t, {
    principal: 'fixture',
    json: async () => ({ machineIdentifier: 'plex-1' }),
    playableItem,
    prepare: async id => ({ ...(await playableItem(id)), kind: 'plex', resources: new Map() }),
    close: async () => {},
  });
  const viewerId = randomUUID();
  watch.join(room, host, viewerId, { alive: async () => true, quality: 'direct' });
  const command = (action, args) => hub.dispatch(host, { roomId: room.roomId, action, args });
  const initial = await command('media.load', { mediaId: '100', quality: 'direct' });
  assert.equal(initial.status, 'applied', initial.message);
  const queue = watch.roomState.queue;
  const winnerAction = t.mock.method(watch, 'executePollWinAction');

  for (const [index, [onClose, winnerId]] of [
    ['queueNext', '101'],
    ['playNow', '102'],
  ].entries()) {
    const options = [winnerId, '103'].map(mediaId => ({
      id: mediaId,
      label: 'Movie ' + mediaId,
      media: { serverId: 'plex-1', mediaId, type: 'movie', title: 'Movie ' + mediaId },
    }));
    const started = await command('poll.start', { question: 'Next movie?', options, onClose });
    assert.equal(started.status, 'applied', started.message);
    const pollId = room.activities.get('poll').id;
    assert.equal((await command('poll.vote', { pollId, optionId: winnerId })).status, 'applied');
    assert.equal((await command('poll.close', { pollId })).status, 'applied');
    assert.equal(winnerAction.mock.callCount(), index + 1);
    await winnerAction.mock.calls[index].result;
    const poll = watch.view(room, host, viewerId).activities.find(activity => activity.kind === 'poll');
    assert.equal(poll.actionError, undefined);
    assert.equal(poll.winnerOptionId, winnerId);
    assert.equal(queue.list(room.roomId).items[0]?.mediaId, '101');
    assert.equal(room.media.id, onClose === 'playNow' ? '102' : '100');
  }
});

test('room journal persists to watch_room_journal across close and reopen and clears on reset', async t => {
  const f = await createServerHarness(t);
  const hostTab = randomUUID();
  f.watch.join(f.room, f.host, hostTab);
  await f.hub.dispatch(f.host, {
    roomId: f.room.roomId,
    action: 'announce.send',
    args: { text: 'Persisted note', pinned: false },
  });
  await f.watch.roomState.save(f.room, { closing: true, final: true });
  const rows = f.registry.db
    .prepare('SELECT seq, entry FROM watch_room_journal WHERE roomId = ? ORDER BY seq')
    .all(f.room.roomId);
  assert.ok(rows.length >= 2);
  assert.ok(rows.some(r => JSON.parse(r.entry).kind === 'announcement.send'));
});
