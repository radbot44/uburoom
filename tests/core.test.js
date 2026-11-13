'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const Engine = require('../shared/engine.mjs');
const { Hub } = require('../server/core');
const config = { ownerId: 'owner' };
const actor = { userId: 'owner' };

test('command validation enforces explicit units, bounded finite values and no arbitrary actions', () => {
  assert.equal(Engine.validate({ action: 'media.volume.set', args: { percent: 50 } }).args.percent, 50);
  assert.throws(() => Engine.validate({ action: 'media.volume.set', args: { percent: 101 } }));
  assert.throws(() => Engine.validate({ action: 'zoom.set', args: { value: '1.5' } }));
  const entryId = randomUUID();
  assert.equal(Engine.validate({ action: 'queue.remove', args: { entryId, advance: true } }).args.advance, true);
  assert.equal(Engine.validate({ action: 'queue.remove', args: { entryId, advance: false } }).args.advance, false);
  assert.equal(Object.hasOwn(Engine.validate({ action: 'queue.remove', args: { entryId } }).args, 'advance'), false);
  assert.throws(() => Engine.validate({ action: 'queue.remove', args: { entryId, advance: 'true' } }), /advance/);
});

test('media seeking stays inside available DVR ranges and snapshots contain only validated state', () => {
  const ranges = [
    [130, 200],
    [10, 50],
    [60, 90],
  ];
  assert.equal(Engine.seekBoundary(ranges, 'start'), 10);
  assert.equal(Engine.seekBoundary(ranges, 'end'), 199.99);
  assert.equal(Engine.seekBoundary([[4, 4.005]], 'end'), 4, 'tiny ranges never seek before their beginning');
  for (const r of [[], [[0, Infinity]], [[NaN, 10]], [[50, 10]]])
    assert.equal(Engine.seekBoundary(r, 'start'), undefined);

  assert.equal(Engine.validate({ action: 'media.seek.relative', args: { seconds: -15 } }).args.seconds, -15);
  assert.throws(() => Engine.validate({ action: 'media.seek.relative', args: { seconds: Infinity } }));
  assert.throws(() => Engine.validate({ action: 'media.seek.relative', args: { seconds: 601 } }));
  assert.equal(Engine.seekTarget(25, [[10, 40]], -15), 10);
  assert.equal(Engine.seekTarget(35, [[10, 40]], 15), 39.99);
  assert.equal(Engine.seekTarget(12, [], 15), undefined);
  assert.equal(Engine.seekTarget(10, [[10, 40]], -15), undefined);
  assert.equal(
    Engine.seekTarget(
      20,
      [
        [10, 25],
        [40, 60],
      ],
      30,
    ),
    50,
  );
  const state = Engine.snapshot({
    title: 'private title',
    volume: 72,
    paused: true,
  });
  assert.deepEqual(state, { paused: true, volume: 72 });
  assert.equal(Engine.snapshot({ volume: Infinity }), undefined);
});

test('live watch rooms use the shared engine and reject removed management actions', async () => {
  assert.equal(
    Engine.validate({ action: 'room.visibility', args: { visibility: 'private' } }).action,
    'room.visibility',
  );
  for (const [name, args] of Object.entries({
    enable: {},
    disable: {},
    sharing: { mode: 'owner' },
    visibility: { visibility: 'private' },
    controls: { control: 'playback', allowed: false },
    autojoin: { enabled: true },
  })) {
    assert.throws(() => Engine.validate({ action: 'session.' + name, args }));
    if (name !== 'visibility') assert.throws(() => Engine.validate({ action: 'room.' + name, args }));
  }
  assert.throws(() => Engine.validate({ action: 'session.controls', args: { control: 'playback', allowed: 'yes' } }));
  assert.throws(() => Engine.validate({ action: 'session.unknown' }));
  assert.equal(Engine.parse, undefined);

  const hub = new Hub(config);
  hub.access = { refresh: async () => true, isMember: () => true };
  const host = { ...actor };
  const guest = { ...actor, userId: 'friend' };
  const roomId = randomUUID(),
    room = {
      roomId,
      epoch: randomUUID(),
      ownerId: 'owner',
      hostId: 'owner',
      hostName: 'owner',
      ownerName: 'owner',
      visibility: 'public',
      creatorId: 'owner',
      permissions: { host: {}, viewer: { playPause: true } },
      viewers: new Map([['guest-viewer', { userId: 'friend', at: Date.now(), actor: guest }]]),
      state: { paused: true, muted: false, volume: 50, seekable: false },
      execute: async command => ({ status: 'applied', message: command.action }),
    };
  hub.rooms.set(roomId, room);
  assert.equal((await hub.dispatch(host, { roomId, action: 'media.pause' })).status, 'applied');
  assert.equal((await hub.dispatch(guest, { roomId, action: 'media.pause' })).status, 'applied');
  room.permissions.viewer.playPause = false;
  assert.equal((await hub.dispatch(guest, { roomId, action: 'media.pause' })).status, 'forbidden');
  hub.close();
});

test('dispatch grants 30s deadline to personal track/stream refreshes and queue operations', async () => {
  const hub = new Hub(config);
  // This test moves time by replacing Date.now, so the room clock follows it.
  hub.clock = { now: () => Date.now() };
  hub.access = { refresh: async () => true, isMember: () => true };
  const host = { ...actor };
  const roomId = randomUUID();
  let capturedTicket;
  const room = {
    roomId,
    epoch: randomUUID(),
    ownerId: 'owner',
    hostId: 'owner',
    hostName: 'owner',
    ownerName: 'owner',
    visibility: 'public',
    creatorId: 'owner',
    permissions: { host: { playPause: true }, viewer: {} },
    viewers: new Map([['viewer-1', { userId: 'owner', at: Date.now(), actor: host }]]),
    state: { paused: true, muted: false, volume: 50, seekable: false },
    execute: async (command, actor, ticket) => {
      capturedTicket = ticket;
      return { status: 'applied' };
    },
  };
  hub.rooms.set(roomId, room);
  await hub.dispatch(
    { ...host, watchViewerId: 'viewer-1' },
    {
      roomId,
      action: 'media.tracks.set',
      args: { mediaVersion: randomUUID(), streamVersion: randomUUID(), audioId: '1' },
    },
  );
  assert.ok(capturedTicket);
  const now = Date.now;
  try {
    Date.now = () => now() + 5000;
    assert.equal(
      hub.current(capturedTicket),
      true,
      'personal track change is still permitted after 5s (exceeding default 2.5s)',
    );
    Date.now = () => now() + 31000;
    assert.equal(hub.current(capturedTicket), false, 'personal track change expires after 30s');
  } finally {
    Date.now = now;
  }
  hub.close();
});
