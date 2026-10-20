'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');
const Policy = require('../server/room-policy');

function fixture(t, { disk = false, defaults, isAdmin } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-room-core-')) : undefined;
  const file = directory && path.join(directory, 'accounts.sqlite'), vault = credentialVault();
  let registry = new Accounts(file, vault), store = new RoomStore(registry, { defaults, isAdmin });
  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const host = registry.resolve('plex', '101', 'Host').id;
  const viewer = registry.resolve('discord', '222222222222222222', 'Viewer').id;
  t.after(async () => {
    await Promise.resolve(registry.close()).catch(() => {});
    if (directory) {
      const target = path.resolve(directory), relative = path.relative(os.tmpdir(), target);
      assert.ok(relative.startsWith('uburoom-room-core-') && !relative.includes(path.sep));
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
  return {
    get registry() { return registry; }, get store() { return store; }, creator, host, viewer, file,
    async restart() { await registry.close(); registry = new Accounts(file, vault); store = new RoomStore(registry, { defaults, isAdmin }); }
  };
}
const savedVideo = { serverId: 'fixture-plex-server', mediaId: '42', type: 'episode', title: 'Episode 4', duration: 1800, position: 731.25 };
const status = code => failure => failure.status === code;

test('persistent room restart retains identities, host permissions and a paused bookmark without runtime authority', async t => {
  const f = fixture(t, { disk: true });
  f.registry.credential('101', { token: 'private-room-credential' });
  const before = f.registry.db.prepare('SELECT value FROM credentials WHERE subject=?').get('101').value;
  let room = await f.store.create(f.creator, { name: 'Friday films', visibility: 'private' });
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });
  room = await f.store.checkpoint(room.id, room.checkpointRevision, {
    ...savedVideo, enabled: true, paused: false, mediaUrl: 'https://private.invalid/token', viewers: ['private-viewer'], token: 'private-token'
  });
  await f.restart();
  const restored = f.store.restore(room.id, f.host);
  assert.equal(restored.id, room.id);
  assert.equal(restored.creatorId, f.creator);
  assert.deepEqual(restored.hosts, [f.host]);
  assert.equal(restored.name, 'Friday films');
  assert.equal(restored.visibility, 'private');
  assert.equal(restored.paused, true);
  assert.deepEqual(restored.bookmark, savedVideo);
  assert.equal(f.registry.db.prepare('SELECT value FROM credentials WHERE subject=?').get('101').value, before);
  assert.equal(f.registry.credential('101').token, 'private-room-credential');
  const serialized = JSON.stringify(restored);
  for (const value of ['private-token', 'private.invalid', 'private-viewer', 'mediaUrl', 'enabled']) assert.ok(!serialized.includes(value));
  assert.throws(() => f.store.restore(room.id, f.viewer), status(403));
});

test('creator-only host assignments and transfer survive old-creator departure without granting permanent viewer membership', async t => {
  const f = fixture(t);
  let room = await f.store.create(f.creator);
  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, { action: 'host.add', userId: f.viewer }), status(403));
  await assert.rejects(f.store.edit(room.id, f.creator, room.revision, { action: 'creator.transfer', userId: f.viewer }), /assigned host/);
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });
  await assert.rejects(f.store.edit(room.id, f.host, room.revision, { action: 'host.add', userId: f.viewer }), status(403));
  room = await f.store.edit(room.id, f.host, room.revision, { action: 'rename', name: 'A new name' });
  assert.equal(room.name, 'A new name');
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'creator.transfer', userId: f.host });
  assert.equal(room.creatorId, f.host);
  assert.deepEqual(room.hosts, [f.creator]);
  await assert.rejects(f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.viewer }), status(403));
  room = await f.store.edit(room.id, f.host, room.revision, { action: 'host.remove', userId: f.creator });
  assert.deepEqual(room.hosts, []);
  assert.throws(() => f.store.restore(room.id, f.creator), status(403));
});

test('full participant playback and queue controls never grant room management', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator, { fullPermissions:true });
  assert.deepEqual(room.permissions.viewer, Policy.preset('queue').viewer);
  assert.equal(Policy.allowed(room, f.viewer, 'manageHosts'), false);
  assert.throws(() => f.store.restore(room.id, f.viewer), status(403));
  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, {action:'rename',name:'Denied'}), status(403));
  for (const key of Policy.VIEWER_BLOCKED) {
    await assert.rejects(f.store.edit(room.id, f.creator, room.revision, {action:'permissions',role:'viewer',permissions:{[key]:true}}), /unavailable to participants/);
    assert.equal(f.store.get(room.id).revision, room.revision);
    assert.equal(f.store.get(room.id).permissions.viewer[key], false);
  }
});

test('operator defaults snapshot at creation and settings edits are not invalidated by periodic bookmarks', async t => {
  const defaults = Policy.policy({ host: { roomSettings: false }, viewer: { seek: true } });
  const f = fixture(t, { defaults });
  let room = await f.store.create(f.creator);
  defaults.viewer.seek = false;
  assert.equal(room.permissions.viewer.seek, true);
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });
  await assert.rejects(f.store.edit(room.id, f.host, room.revision, { action: 'rename', name: 'Denied' }), status(403));
  const revision = room.revision;
  room = await f.store.checkpoint(room.id, room.checkpointRevision, savedVideo);
  assert.equal(room.revision, revision);
  room = await f.store.edit(room.id, f.creator, revision, { action: 'rename', name: 'Still valid' });
  assert.equal(room.bookmark.position, savedVideo.position);
  await assert.rejects(f.store.checkpoint(room.id, 0, savedVideo), status(409));
});

test('concurrent settings edits reject stale revisions and invalid edits roll back without changing membership', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  const first = f.store.edit(room.id, f.creator, room.revision, { action: 'rename', name: 'First' });
  await assert.rejects(f.store.edit(room.id, f.creator, room.revision, { action: 'rename', name: 'Second' }), status(409));
  const updated = await first;
  assert.equal(updated.name, 'First');
  await assert.rejects(f.store.edit(room.id, f.creator, updated.revision, { action: 'host.add', userId: randomUUID() }), status(403));
  assert.deepEqual(f.store.get(room.id), updated);
  await assert.rejects(f.store.edit(room.id, f.creator, updated.revision, { action: 'permissions', role: 'creator', permissions: {} }), /Choose host or viewer/);
  await assert.rejects(f.store.edit(room.id, f.creator, updated.revision, { action: '__proto__' }), /Unsupported/);
  assert.deepEqual(f.store.get(room.id), updated);
});

test('reopen listings are paged and private to assigned hosts; saved rooms do not allocate live player slots', async t => {
  const f = fixture(t);
  const ids = [];
  for (let index = 0; index < 6; index++) ids.push((await f.store.create(f.creator, { name: 'Room ' + index })).id);
  let room = f.store.get(ids[0]);
  await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });
  assert.equal(f.store.list(f.creator, { limit: 2 }).rooms.length, 2);
  assert.equal(f.store.list(f.creator, { offset: 2, limit: 2 }).total, 6);
  assert.deepEqual(f.store.list(f.host).rooms.map(item => item.id), [ids[0]]);
  assert.deepEqual(f.store.list(f.viewer), { rooms: [], total: 0 });
  assert.throws(() => f.store.list(f.creator, { limit: 101 }), status(400));
  assert.throws(() => f.store.list(f.creator, { offset: -1 }), status(400));
});

test('verified account merges preserve creator and host access, and revocation clears every retired membership', async t => {
  const f = fixture(t);
  let room = await f.store.create(f.creator);
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });
  f.registry.merge(f.viewer, f.host, f.creator);
  assert.deepEqual(f.store.restore(room.id, f.viewer).hosts, [f.viewer]);
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.viewer });
  assert.deepEqual(room.hosts, [f.viewer]);
  room = await f.store.edit(room.id, f.creator, room.revision, { action: 'host.remove', userId: f.viewer });
  assert.deepEqual(room.hosts, []);
  assert.equal(f.registry.db.prepare('SELECT count(*) AS n FROM watch_room_hosts WHERE roomId=?').get(room.id).n, 0);
  assert.throws(() => f.store.restore(room.id, f.viewer), status(403));
  const other = f.registry.resolve('plex', '202', 'New creator');
  f.registry.merge(other.id, f.creator, other.id);
  assert.equal(f.store.restore(room.id, other.id).creatorId, other.id);
});

test('active server Admin mode gives creator authority over private saved rooms without changing actual roles', async t => {
  const active = new Set();
  const f = fixture(t, { isAdmin: id => active.has(id) });
  let room = await f.store.create(f.creator, { visibility: 'private' });
  assert.equal(f.store.list(f.viewer).total, 0);
  const candidates = Policy.configuration({ admin_discord_ids: ['222222222222222222'] });
  assert.equal(Policy.administrator(f.registry, candidates, f.viewer), true, 'the viewer is an eligible administrator');
  assert.throws(() => f.store.restore(room.id, f.viewer), status(403), 'eligibility alone does not enable Admin mode');
  const pendingAdmin = new RoomStore(f.registry, { isAdmin: () => Promise.resolve(false) });
  assert.equal(pendingAdmin.list(f.viewer).total, 0, 'an unfinished administrator lookup cannot grant privileges');
  assert.throws(() => pendingAdmin.restore(room.id, f.viewer), status(403));
  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, { action: 'host.add', userId: f.host, adminMode: true }), status(403));
  active.add(f.viewer);
  assert.equal(f.store.list(f.viewer).total, 1);
  assert.equal(f.store.restore(room.id, f.viewer).creatorId, f.creator);
  room = await f.store.edit(room.id, f.viewer, room.revision, { action: 'host.add', userId: f.host });
  room = await f.store.edit(room.id, f.viewer, room.revision, { action: 'permissions', role: 'host', permissions: { deleteRoom: true } });
  assert.equal(room.creatorId, f.creator);
  assert.deepEqual(room.hosts, [f.host]);
  active.delete(f.viewer);
  assert.throws(() => f.store.restore(room.id, f.viewer), status(403));
  await assert.rejects(f.store.edit(room.id, f.viewer, room.revision, { action: 'creator.transfer', userId: f.host }), status(403));
  await f.store.edit(room.id, f.host, room.revision, { action: 'delete' });
  assert.throws(() => f.store.get(room.id), status(404));
});

test('input validation and bookmark allowlisting preserve room state on invalid mutations', async t => {
  const f = fixture(t);
  for (const options of [{ name: '' }, { name: 'a'.repeat(101) }, { visibility: 'invalid' }, { fullPermissions: 'true' }]) {
    await assert.rejects(f.store.create(f.creator, options), status(400));
  }
  assert.equal(f.store.list(f.creator).total, 0);
  let room = await f.store.create(f.creator, { name: '  Named room  ' });
  assert.equal(room.name, 'Named room');
  for (const invalid of [{ ...savedVideo, position: NaN }, { ...savedVideo, mediaId: 'https://private.invalid' }, { ...savedVideo, duration: 0 }, { ...savedVideo, type: 'show' }]) {
    await assert.rejects(f.store.checkpoint(room.id, room.checkpointRevision, invalid), status(400));
  }
  assert.equal(f.store.get(room.id).bookmark, null);
  room = await f.store.checkpoint(room.id, room.checkpointRevision, { ...savedVideo, position: 9999 });
  assert.equal(room.bookmark.position, savedVideo.duration);
  room = await f.store.checkpoint(room.id, room.checkpointRevision, null);
  assert.equal(room.bookmark, null);
});

test('a locked disk delays successful room acknowledgements while the event loop remains available', async t => {
  const f = fixture(t, { disk: true });
  await f.registry.flush();
  const lock = new DatabaseSync(f.file);
  lock.exec('BEGIN EXCLUSIVE');
  let completed = false, ticks = 0;
  const saving = f.store.create(f.creator, { name: 'Durable acknowledgement' }).then(room => { completed = true; return room; });
  const timer = setInterval(() => ticks++, 5);
  try {
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(completed, false);
    assert.ok(ticks >= 10);
    lock.exec('COMMIT');
    const room = await saving;
    await f.restart();
    assert.equal(f.store.get(room.id).name, 'Durable acknowledgement');
  } finally { clearInterval(timer); lock.close(); }
});

test('writer conflict fails room mutations and seals reads against uncommitted mirror state', async t => {
  const f = fixture(t, { disk: true });
  const room = await f.store.create(f.creator);
  const disk = new DatabaseSync(f.file);
  disk.prepare('UPDATE watch_rooms SET name=? WHERE id=?').run('External writer', room.id);
  disk.close();
  await assert.rejects(f.store.edit(room.id, f.creator, room.revision, { action: 'rename', name: 'Unsaved name' }), status(503));
  assert.throws(() => f.store.get(room.id), status(503));
  assert.throws(() => f.store.list(f.creator), status(503));
  await assert.rejects(f.store.create(f.creator), status(503));
  const read = new DatabaseSync(f.file);
  assert.equal(read.prepare('SELECT name FROM watch_rooms WHERE id=?').get(room.id).name, 'External writer');
  read.close();
});


test('explicit room presets preserve defaults, reject unknown names and protect destructive powers', async t => {
  const f = fixture(t, { defaults:{viewer:{playPause:false, deleteRoom:true}} });
  const configured = await f.store.create(f.creator, {permissionPreset:'server-defaults'});
  assert.equal(configured.permissions.viewer.deleteRoom, false);
  for (const name of ['host-control','play-pause','queue']) {
    let room = await f.store.create(f.creator, {permissionPreset:name});
    assert.equal(room.permissions.viewer.playPause, name !== 'host-control');
    assert.equal(room.permissions.viewer.seek, name === 'queue');
    assert.equal(room.permissions.viewer.editQueue, name === 'queue');
    for (const role of ['host','viewer']) assert.equal(room.permissions[role].deleteRoom, false);
    await assert.rejects(f.store.edit(room.id,f.viewer,room.revision,{action:'permissions.preset',preset:'queue'}),/permission/);
    room = await f.store.edit(room.id,f.creator,room.revision,{action:'permissions.preset',preset:'queue'});
    assert.equal(room.permissions.viewer.editQueue,true);
    assert.equal(f.store.get(configured.id).permissions.viewer.deleteRoom,false);
  }
  await assert.rejects(f.store.create(f.creator,{permissionPreset:'unknown'}),/Unknown/);
  const ui = {}; require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname,'../web/watch-rooms-ui.js'),'utf8'),ui);
  for (const name of ['host-control','play-pause','queue']) {
    assert.equal(JSON.stringify(ui.uburoomRoomUI.presetPolicy(name)),JSON.stringify(Policy.preset(name)));
    assert.equal(ui.uburoomRoomUI.presetName(Policy.preset(name)),name);
  }
  const custom = Policy.preset('host-control'); custom.viewer.seek = true;
  assert.equal(ui.uburoomRoomUI.presetName(custom),'custom');
});

test('old stored picture flags are retired and participant management stays off across restart', async t => {
  const f = fixture(t, {disk:true});
  const room = await f.store.create(f.creator);
  const old = {...room.permissions,host:{...room.permissions.host,picture:true},viewer:{...room.permissions.viewer,picture:true,roomSettings:true,closeRoom:true,deleteRoom:true}};
  f.registry.db.prepare('UPDATE watch_rooms SET permissions=? WHERE id=?').run(JSON.stringify(old), room.id);
  await f.registry.flush();
  await f.restart();
  const restored = f.store.get(room.id);
  assert.equal(Object.hasOwn(restored.permissions.host,'picture'),false);
  assert.equal(Object.hasOwn(restored.permissions.viewer,'picture'),false);
  assert.ok(Policy.VIEWER_BLOCKED.every(key => !restored.permissions.viewer[key]));
  assert.equal(restored.creatorId, room.creatorId);
  assert.equal(restored.revision, room.revision);
});


test('prospective room settings save atomically and closed autoplay changes enforce permissions and revisions', async t => {
  const f = fixture(t, {disk:true});
  const permissions = Policy.preset('host-control'); permissions.viewer.seek = true;
  let room = await f.store.create(f.creator,{name:'Configured before opening',permissions,autoplay:false,autoQueue:{mode:'random',scope:{type:'library',id:'1',serverId:'fixture-server'},includeSpecials:true}});
  assert.deepEqual(room.permissions,permissions);
  assert.equal(room.autoplay,false);
  assert.equal(room.autoQueue.mode,'random');
  await assert.rejects(f.store.edit(room.id,f.viewer,room.revision,{action:'autoplay',enabled:true}),status(403));
  room = await f.store.edit(room.id,f.creator,room.revision,{action:'host.add',userId:f.host});
  const revision = room.revision;
  room = await f.store.edit(room.id,f.host,revision,{action:'autoplay',enabled:true});
  assert.equal(room.autoplay,true);
  await assert.rejects(f.store.edit(room.id,f.creator,revision,{action:'autoplay',enabled:false}),status(409));
  await f.restart();
  const saved = f.store.get(room.id);
  assert.equal(saved.autoplay,true);
  assert.deepEqual(saved.permissions,permissions);
  assert.equal(saved.autoQueue.scope.serverId,'fixture-server');
  const count = f.store.list(f.creator).total;
  for (const options of [{autoplay:'false'},{autoQueue:{mode:'unknown'}},{autoQueue:{mode:'random',scope:{type:'library',id:'invalid'}}},{permissions:{...permissions,viewer:{...permissions.viewer,roomSettings:true}}}]) {
    await assert.rejects(f.store.create(f.creator,options));
    assert.equal(f.store.list(f.creator).total,count,'Invalid drafts do not create saved rooms');
  }
});
