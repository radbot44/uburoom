'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore, inviteCode } = require('../server/room-store');
const Policy = require('../server/room-policy');

function fixture(t) {
  const registry = new Accounts(undefined, credentialVault());
  const guests = new Set();
  const store = new RoomStore(registry, { guests: () => guests });
  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const viewer = registry.resolve('discord', '222222222222222222', 'Viewer').id;
  t.after(() => registry.close());
  return { registry, store, guests, creator, viewer };
}

test('room invites use typeable codes, only hosts change them, and a reroll clears blocks without removing anyone', async t => {
  const f = fixture(t);
  let room = await f.store.create(f.creator, { name:'Private party', visibility:'private' });
  assert.match(room.inviteCode, /^[a-z]{6}-[a-z]{6}$/);
  const [first, second] = room.inviteCode.split('-');
  for (const typed of [room.inviteCode, (first + ' ' + second).toUpperCase(), first + second]) assert.equal(f.store.byInvite(typed)?.id, room.id);
  assert.equal(inviteCode('short'), undefined);
  assert.equal(f.store.byInvite('abcdef-ghijkl'), undefined);

  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, { action:'invite.reroll' }), /permission/);
  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, { action:'guests.allow', enabled:true }), /permission/);
  room = await f.store.edit(room.id, f.creator, room.revision, { action:'guests.allow', enabled:true });
  assert.equal(room.allowGuests, true);

  // Joining a private room by invite is remembered until someone revokes it.
  assert.equal(Policy.admitted(room, f.viewer), false);
  room = await f.store.invite(room.id, f.viewer);
  assert.equal(Policy.admitted(room, f.viewer), true);
  room = await f.store.edit(room.id, f.creator, room.revision, { action:'invite.revoke', userId:f.viewer });
  assert.equal(Policy.admitted(room, f.viewer), false);
  assert.equal(f.store.blocked(room.id, ['user:' + f.viewer]), true, 'a revoked person cannot use the invite again');
  room = await f.store.block(room.id, ['device:browser']);

  room = await f.store.invite(room.id, f.registry.resolve('plex', '303', 'Kept').id);
  const before = room.inviteCode;
  room = await f.store.edit(room.id, f.creator, room.revision, { action:'invite.reroll' });
  assert.notEqual(room.inviteCode, before);
  assert.equal(f.store.byInvite(before), undefined, 'the old code stops working');
  assert.equal(f.store.blocked(room.id, ['user:' + f.viewer, 'device:browser']), false, 'blocks end with the old code');
  assert.equal(room.invited.length, 1, 'a reroll removes nobody');
  room = await f.store.edit(room.id, f.creator, room.revision, { action:'guests.removeAll' });
  assert.notEqual(f.store.byInvite(room.inviteCode)?.id, undefined);
});

test('guests are always viewers, never hosts, and are excluded from host search and provider links', async t => {
  const f = fixture(t);
  let room = await f.store.create(f.creator, { name:'Guests welcome' });
  const guest = f.registry.createGuest('Bomaxu Tirelo'), invitee = f.registry.resolve('plex', '202', 'Outsider').id;
  assert.equal(f.registry.directory().some(user => user.id === guest), false);
  assert.throws(() => f.registry.link(guest, 'plex', '404', 'Someone'), /Guest accounts cannot connect/);
  f.guests.add(invitee);
  room = await f.store.edit(room.id, f.creator, room.revision, { action:'allHosts', enabled:true });
  assert.equal(Policy.role(room, invitee), 'viewer', 'All hosts never covers a guest');
  assert.equal(Policy.admitted({ ...room, visibility:'private' }, invitee), true, 'a guest may be in their private room');
  await assert.rejects(f.store.edit(room.id, f.creator, room.revision, { action:'host.add', userId:invitee }), /Guests cannot be hosts/);
  f.guests.delete(invitee);
  assert.equal(Policy.role(f.store.get(room.id), invitee), 'host');
});

test('server tiers rank operator, admins, trusted and members from verified identities only', t => {
  const registry = new Accounts(undefined, credentialVault());
  t.after(() => registry.close());
  const config = { ownerId:'', serverOperator:{ discordId:'', plexId:'1' }, ...Policy.configuration({ admin_plex_ids:['2'], trusted_plex_ids:['3'] }) };
  const tier = subject => Policy.serverTier(registry, config, registry.resolve('plex', subject, 'P' + subject).id);
  assert.deepEqual(['1', '2', '3', '4'].map(tier), ['operator', 'admins', 'trusted', 'members']);
  const assigned = registry.resolve('plex', '5', 'Unverified', false).id;
  config.trustedMembers.plex.push('5');
  assert.equal(Policy.serverTier(registry, config, assigned), 'members', 'an unverified assignment grants nothing');
  assert.equal(Policy.tierAtLeast('trusted', 'trusted'), true);
  assert.equal(Policy.tierAtLeast('members', 'trusted'), false);
});
