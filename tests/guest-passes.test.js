'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');
const { GuestPasses } = require('../server/guest-passes');
const Policy = require('../server/room-policy');

function fixture(t, { requireSignIn = false } = {}) {
  const registry = new Accounts(undefined, credentialVault());
  const members = new Set();
  const store = new RoomStore(registry, { guests: () => members });
  let issuer = true;
  const passes = new GuestPasses(registry, { maxLifetimeHours:24, maxUses:2, requireSignIn }, { issuer: () => issuer });
  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  t.after(() => registry.close());
  return { registry, store, passes, creator, members, setIssuer(value) { issuer = value; } };
}

test('guest passes count uses atomically, pause without removing guests, and end for good when revoked or the issuer loses rights', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator, { name:'Guests welcome' });
  assert.throws(() => f.passes.create(room.id, f.creator, { hours:25, uses:1, signIn:false }), /1 to 24 hours/);
  const { pass, token } = f.passes.create(room.id, f.creator, { hours:1, uses:2, signIn:false });
  assert.equal(f.registry.db.prepare('SELECT count(*) AS n FROM guest_passes WHERE tokenHash=?').get(token).n, 0, 'only a hash of the token is stored');
  const stored = f.passes.byToken(token), guest = f.registry.createGuest('Bomaxu');
  assert.equal(stored.id, pass.id);
  assert.equal(f.passes.byToken(token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')), undefined);

  assert.equal(f.passes.use(pass.id), true);
  f.passes.change(room.id, pass.id, f.creator, 'disable');
  assert.equal(f.passes.use(pass.id), false, 'a turned-off pass lets nobody new in');
  assert.equal(f.passes.admits(f.passes.get(pass.id), guest), true, 'guests already in stay while the pass is off');
  f.passes.change(room.id, pass.id, f.creator, 'enable');
  assert.equal(f.passes.use(pass.id), true);
  assert.equal(f.passes.use(pass.id), false, 'the use limit holds');
  assert.equal(f.passes.view(f.passes.get(pass.id)).status, 'used');

  f.setIssuer(undefined);
  assert.equal(f.passes.admits(f.passes.get(pass.id), guest), true, 'an unanswered provider check keeps guests');
  assert.equal(f.passes.open(f.passes.get(pass.id)), false, 'but lets nobody new in');
  f.setIssuer(false);
  assert.equal(f.passes.admits(f.passes.get(pass.id), guest), false, 'an issuer who lost the right ends the pass');
  f.setIssuer(true);
  f.passes.change(room.id, pass.id, f.creator, 'revoke');
  assert.equal(f.passes.admits(f.passes.get(pass.id), guest), false);
  assert.throws(() => f.passes.change(room.id, pass.id, f.creator, 'enable'), /already revoked/);
});

test('sign-in passes refuse unverified guests and guests never become hosts or appear in host search', async t => {
  const f = fixture(t, { requireSignIn:true });
  const room = await f.store.create(f.creator, { name:'Signed in only' });
  const { pass } = f.passes.create(room.id, f.creator, { hours:1, uses:2, signIn:false });
  assert.equal(pass.signIn, true, 'the server setting makes every pass require sign-in');
  const guest = f.registry.createGuest('Tirelo'), invitee = f.registry.resolve('plex', '202', 'Invitee').id;
  assert.equal(f.passes.admits(f.passes.get(pass.id), guest), false);
  assert.equal(f.passes.admits(f.passes.get(pass.id), invitee), true);
  assert.equal(f.registry.directory().some(user => user.id === guest), false);
  assert.throws(() => f.registry.link(guest, 'plex', '303', 'Someone'), /Guest accounts cannot connect/);

  f.members.add(invitee);
  let record = await f.store.edit(room.id, f.creator, room.revision, { action:'allHosts', enabled:true });
  assert.equal(Policy.role(record, invitee), 'viewer', 'All hosts never covers someone in through a pass');
  assert.equal(Policy.allowed(record, invitee, 'seek'), false);
  await assert.rejects(f.store.edit(room.id, f.creator, record.revision, { action:'host.add', userId:invitee }), /Guests cannot be hosts/);
  f.members.delete(invitee);
  record = f.store.get(room.id);
  assert.equal(Policy.role(record, invitee), 'host');
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
  assert.equal(Policy.tierAtLeast('operator', 'admins'), true);
});
