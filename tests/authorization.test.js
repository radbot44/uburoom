'use strict';
// Every authorization decision for an open room, against every kind of actor.
// tests/fixtures/authorization.json was recorded from the separate helpers that
// authorize() replaced (eligible, viewEligible, canRoom, roomCommandAllowed,
// privateMember and the publication host check) at e2627bb, then deliberately
// changed on 2026-11-12: next-video commands need a host present (or
// continueWithoutHost), and capabilities require room access. Each decision is a
// string of eight results, one per context in CONTEXTS order.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Hub } = require('../server/core');
const RoomPolicy = require('../server/room-policy');
const recorded = require('./fixtures/authorization.json');

const ROOM = '00000000-0000-4000-8000-000000000001';
const OTHER_ROOM = '00000000-0000-4000-8000-000000000002';
const ID = {
  owner: '00000000-0000-4000-8000-0000000000a0',
  creator: '00000000-0000-4000-8000-0000000000a1',
  host: '00000000-0000-4000-8000-0000000000a2',
  viewer: '00000000-0000-4000-8000-0000000000a3',
  invitee: '00000000-0000-4000-8000-0000000000a4',
  absent: '00000000-0000-4000-8000-0000000000a5',
  guest: '00000000-0000-4000-8000-0000000000a6',
  otherGuest: '00000000-0000-4000-8000-0000000000a7',
};
// Present actors have a viewer in the room; the creator and host are present only
// when the context says the host is present. `admin` is the owner in Admin mode.
const ACTORS = {
  creator: { userId: ID.creator, watchViewerId: 'creator-tab', host: true },
  host: { userId: ID.host, watchViewerId: 'host-tab', host: true },
  viewer: { userId: ID.viewer, watchViewerId: 'viewer-tab', present: true },
  invitee: { userId: ID.invitee, watchViewerId: 'invitee-tab', present: true },
  absent: { userId: ID.absent },
  guest: { userId: ID.guest, watchViewerId: 'guest-tab', guestRoomId: ROOM, present: true },
  otherGuest: { userId: ID.otherGuest, guestRoomId: OTHER_ROOM },
  admin: { userId: ID.owner, admin: true },
  adminOff: { userId: ID.owner },
};
const CONTEXTS = [];
for (const visibility of ['public', 'private'])
  for (const hostPresent of [true, false])
    for (const idle of [true, false]) CONTEXTS.push({ visibility, hostPresent, idle });
const config = { ownerId: ID.owner };

function actorFor(name) {
  const { host, present, admin, ...actor } = ACTORS[name];
  return actor;
}
function setup(hub, { visibility, hostPresent, idle }, actorName) {
  const now = Date.now();
  const saved = {
    id: ROOM,
    creatorId: ID.creator,
    hosts: [ID.host],
    invited: [ID.invitee],
    visibility,
    permissions: RoomPolicy.policy(),
  };
  const room = {
    roomId: ROOM,
    saved,
    creatorId: saved.creatorId,
    hosts: saved.hosts,
    invited: saved.invited,
    permissions: saved.permissions,
    visibility,
    viewers: new Map(),
  };
  for (const [name, spec] of Object.entries(ACTORS))
    if (spec.present || (spec.host && hostPresent))
      room.viewers.set(spec.watchViewerId, { userId: spec.userId, at: now, actor: actorFor(name) });
  hub.access = { isMember: () => true };
  hub.guestMembers = id => new Set(id === ROOM ? [ID.guest] : []);
  hub.watchIdle = id => id === ROOM && idle;
  hub.adminMode = !!ACTORS[actorName].admin;
  return room;
}

test('authorize() reproduces the recorded decision for every action, actor, visibility, host presence and idle state', () => {
  const failures = [];
  for (const [action, expected] of Object.entries(recorded))
    for (const name of Object.keys(ACTORS)) {
      const actual = CONTEXTS.map(context => {
        const hub = new Hub(config);
        return hub.authorize(actorFor(name), setup(hub, context, name), action).ok ? '1' : '0';
      }).join('');
      if (actual !== expected[name]) failures.push(`${action} ${name}: expected ${expected[name]}, got ${actual}`);
    }
  assert.deepEqual(failures, []);
});
