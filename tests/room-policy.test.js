'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Accounts, credentialVault } = require('../server/accounts');
const Policy = require('../server/room-policy');

test('room roles keep creator-only authority independent of full participant permissions', () => {
  const room = { creatorId: 'creator', hosts: ['host'], permissions: Policy.policy() };
  assert.equal(Policy.role(room, 'host'), 'host');
  for (const capability of Policy.CAPABILITIES) {
    assert.equal(Policy.allowed(room, 'creator', capability), true);
    assert.equal(Policy.allowed(room, 'host', capability), capability !== 'deleteRoom');
    assert.equal(Policy.allowed(room, 'viewer', capability), capability === 'playPause');
  }
  room.permissions.viewer = Object.fromEntries(Policy.CAPABILITIES.map(key => [key, true]));
  assert.ok(Policy.CAPABILITIES.every(key => Policy.allowed(room, 'host', key) === (key !== 'deleteRoom')), 'participant flags cannot confer management authority on hosts');
  for (const capability of Policy.CREATOR_ONLY) {
    assert.equal(Policy.allowed(room, 'creator', capability), true);
    assert.equal(Policy.allowed(room, 'host', capability), false);
    assert.equal(Policy.allowed(room, 'viewer', capability), false);
  }
  assert.equal(Policy.allowed(room, 'creator', 'inventedPermission'), false);
});

test('operator room defaults are complete snapshots and reject unknown roles or capabilities', () => {
  const defaults = Policy.policy({ host: { deleteRoom: true }, viewer: { seek: true } });
  assert.equal(defaults.viewer.seek, true);
  assert.equal(defaults.viewer.playPause, true);
  assert.equal(defaults.host.deleteRoom, true);
  assert.equal(Policy.DEFAULTS.viewer.seek, false);
  assert.throws(() => Policy.policy({ creator: {} }), /roles/);
  assert.throws(() => Policy.policy({ viewer: { manageHosts: true } }), /permissions/);
  assert.throws(() => Policy.policy({ host: { seek: 'true' } }), /permissions/);
  assert.throws(() => Policy.policy(JSON.parse('{"viewer":{"__proto__":true}}')), /permissions/);
  const config = Policy.configuration({ ROOM_HOST_PERMISSIONS: 'all', ROOM_VIEWER_PERMISSIONS: 'playPause,seek' });
  assert.equal(config.roomPermissions.host.deleteRoom, true);
  assert.equal(config.roomPermissions.viewer.seek, true);
  assert.equal(config.roomPermissions.viewer.chooseMedia, false);
  assert.ok(Object.values(Policy.configuration({ ROOM_VIEWER_PERMISSIONS: 'none' }).roomPermissions.viewer).every(value => !value));
  assert.deepEqual(Policy.configuration({}).roomPermissions, Policy.policy());
  assert.throws(() => Policy.configuration({ ROOM_VIEWER_PERMISSIONS: 'manageHosts' }), /Unknown capability/);
  assert.throws(() => Policy.configuration({ ROOM_VIEWER_PERMISSIONS: 'playPause,' }), /Unknown capability/);
});

test('administrator configuration uses exact stable provider IDs rather than names or room-supplied flags', async t => {
  const registry = new Accounts(undefined, credentialVault());
  t.after(() => registry.close());
  const discordId = '111111111111111111', roleId = '222222222222222222';
  const user = registry.resolve('discord', discordId, 'Alice');
  const other = registry.resolve('plex', '101', 'Other');
  const config = Policy.configuration({ ROOM_ADMIN_DISCORD_IDS: discordId + ',' + discordId, ROOM_ADMIN_DISCORD_ROLE_IDS: roleId });
  assert.deepEqual(config.roomAdministrators.discord, [discordId]);
  assert.equal(Policy.administrator(registry, config, user.id), true);
  assert.equal(Policy.administrator(registry, config, other.id), false);
  assert.equal(Policy.administrator(registry, { ownerId: discordId }, user.id), true);
  assert.equal(Policy.administrator(registry, Policy.configuration({ ROOM_ADMIN_PLEX_IDS: '101' }), other.id), true);
  assert.throws(() => Policy.configuration({ ROOM_ADMIN_DISCORD_IDS: 'Alice' }), /exact account/);
  assert.throws(() => Policy.configuration({ ROOM_ADMIN_PLEX_IDS: 'Alice' }), /exact account/);
  assert.throws(() => Policy.configuration({ ROOM_ADMIN_DISCORD_ROLE_IDS: '@moderators' }), /exact account/);
  registry.db.prepare('UPDATE identities SET verified=0,assigned=1 WHERE userId=?').run(user.id);
  assert.equal(Policy.administrator(registry, config, user.id), false, 'an assigned but unproven identity cannot become an administrator');
});

test('role administrators require fresh trusted guild membership and lose authority on role removal or unlink', async t => {
  const registry = new Accounts(undefined, credentialVault());
  t.after(() => registry.close());
  const discordId = '111111111111111111', roleId = '222222222222222222';
  const user = registry.resolve('discord', discordId, 'Alice');
  let present = true, role = true;
  const access = { isMember: id => id === discordId && present, hasRole: (id, requested) => id === discordId && requested === roleId && role };
  const config = Policy.configuration({ ROOM_ADMIN_DISCORD_ROLE_IDS: roleId });
  assert.equal(Policy.administrator(registry, config, user.id, access), true);
  role = false;
  assert.equal(Policy.administrator(registry, config, user.id, access), false);
  role = true; present = false;
  assert.equal(Policy.administrator(registry, config, user.id, access), false);
  assert.equal(Policy.administrator(registry, config, user.id, { isMember: () => true }), false);
  present = true;
  registry.db.prepare('DELETE FROM identities WHERE userId=?').run(user.id);
  assert.equal(Policy.administrator(registry, config, user.id, access), false);
});

test('the three presets grant exact participant controls and keep host deletion off', () => {
  const expected = { 'host-control':[], 'play-pause':['playPause'], queue:['playPause','seek','chooseMedia','addQueue','editQueue','autoplay'] };
  for (const [name, granted] of Object.entries(expected)) {
    const policy = Policy.preset(name);
    assert.deepEqual(Object.keys(policy.viewer).filter(key => policy.viewer[key]), granted);
    assert.ok(Policy.CAPABILITIES.every(key => policy.host[key] === (key !== 'deleteRoom')));
    assert.equal(Object.hasOwn(policy.host,'picture'), false);
    assert.equal(Object.hasOwn(policy.viewer,'picture'), false);
  }
  assert.throws(() => Policy.preset('custom'), /Unknown/);
});

test('participant management grants are denied even in old stored/default policies or forged live policies', () => {
  const old = {host:{picture:true},viewer:{picture:true,roomSettings:true,closeRoom:true,deleteRoom:true}};
  const normalized = Policy.policy(old);
  assert.equal(Object.hasOwn(normalized.viewer,'picture'), false);
  for (const key of Policy.VIEWER_BLOCKED) {
    assert.equal(normalized.viewer[key], false);
    assert.throws(() => Policy.permissions({[key]:true}, normalized.viewer, {role:'viewer'}), /unavailable to participants/);
    assert.equal(Policy.allowed({creatorId:'creator',hosts:['host'],permissions:old}, 'viewer', key), false);
  }
  assert.throws(() => Policy.permissions({picture:true},normalized.host), /Invalid/);
  const room = {creatorId:'creator',hosts:['host'],permissions:normalized};
  assert.equal(Policy.allowed(room,'viewer','picture'),false);
  assert.equal(Policy.allowed(room,'host','picture'),true);
  assert.equal(Policy.allowed(room,'creator','picture'),true);
  const configured = Policy.configuration({ROOM_VIEWER_PERMISSIONS:'all'}).roomPermissions;
  assert.ok(Policy.VIEWER_BLOCKED.every(key => !configured.viewer[key]));
  const retired = Policy.configuration({ROOM_HOST_PERMISSIONS:'playPause,picture'}).roomPermissions.host;
  assert.equal(retired.playPause,true);
  assert.equal(Object.hasOwn(retired,'picture'),false);
});
