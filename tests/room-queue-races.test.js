'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Accounts, credentialVault } = require('../server/accounts');
const { Hub } = require('../server/core');
const { Watch } = require('../server/watch');

const turn = () => new Promise(setImmediate);
async function fixture(t, { autoLoad = false } = {}) {
  const registry = new Accounts(undefined, credentialVault());
  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const actor = { userId: creator, name: 'Creator', surface: 'web', guildId: 'guild', channelId: 'commands', watchViewerId: randomUUID() };
  const hub = new Hub({ ownerId: '111111111111111111', guildId: 'guild', channels: ['commands'] }, []);
  hub.access = { isMember: () => true, refresh: async () => true };
  const plex = {
    json: async () => ({ machineIdentifier: 'race-fixture' }),
    prepare: async id => ({ id, kind: 'plex', duration: 100, title: 'Video ' + id, source: { type: 'movie' }, resources: new Map() }),
    stop: async () => {}, close: async () => {}
  };
  const watch = new Watch(hub, plex, undefined, registry);
  clearInterval(watch.roomState.timer);
  const id = await watch.roomState.create(actor, { name: 'Writer race' }), room = watch.rooms.get(id);
  watch.snapshot(room, actor, actor.watchViewerId, async () => true, 'direct');
  assert.equal((await hub.dispatch(actor, { roomId: id, action: 'media.load', args: { mediaId: '100', quality: 'direct' } })).status, 'applied');
  await watch.roomState.queue.add(id, creator, { serverId: 'race-fixture', mediaId: '101', type: 'movie', title: 'Video 101', duration: 100 });
  let generationStarted = false, releaseGeneration = () => {};
  if (autoLoad) {
    await watch.roomState.queue.configureAuto(id, creator, { mode: 'random', scope: { type: 'library', id: '1', serverId: 'race-fixture' } });
    watch.autoCorpus = async () => ['100', '101', '103'].map(mediaId => ({ serverId: 'race-fixture', mediaId, type: 'movie', title: 'Video ' + mediaId, duration: 100 }));
    const generate = watch.roomState.queue.generate.bind(watch.roomState.queue);
    const heldGeneration = new Promise(resolve => { releaseGeneration = resolve; });
    watch.roomState.queue.generate = async (...args) => { generationStarted = true; await heldGeneration; return generate(...args); };
  }
  room.position = 80; room.changedAt = Date.now(); room.initialGate = false; room.manualPaused = true; room.s.state.paused = true;
  const originalFlush = registry.flush.bind(registry);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  registry.flush = async () => { await held; await originalFlush(); };
  const transition = hub.dispatch(actor, { roomId: id, action: autoLoad ? 'media.load' : 'media.next', ...(autoLoad ? { args: { mediaId: '103', quality: 'direct' } } : {}) });
  const deadline = Date.now() + 1500;
  while (!room.transitionCommit) { assert.ok(Date.now() < deadline, 'Transition did not reach writer'); await turn(); }
  t.after(async () => {
    release(); releaseGeneration(); registry.flush = originalFlush;
    await transition; await watch.close(); hub.close(); await registry.close();
  });
  return { registry, watch, hub, room, id, actor, transition, release, releaseGeneration, get generationStarted() { return generationStarted; } };
}

test('viewer expiry during a queue commit cannot checkpoint old media onto the new occurrence', async t => {
  const f = await fixture(t);
  assert.equal(f.watch.roomState.queue.current(f.id).mediaId, '101');
  assert.equal(f.room.media.id, '100', 'live adoption waits for the writer');
  f.room.viewers.get(f.actor.watchViewerId).at = Date.now() - 10001;
  f.watch.refresh(f.room);
  await turn();
  f.release();
  await f.transition;
  await Promise.allSettled([...f.watch.roomState.pending]);
  const record = f.watch.roomState.store.get(f.id), current = f.watch.roomState.queue.current(f.id);
  assert.equal(record.bookmark.mediaId, '101');
  assert.equal(current.position, 0);
  assert.equal(record.bookmark.position, 0);
});

test('shutdown waits for a pending queue commit and the resulting final room save', async t => {
  const f = await fixture(t);
  let closed = false;
  const closing = f.watch.close().then(() => { closed = true; });
  await turn();
  assert.equal(closed, false, 'shutdown must retain the database and Plex runtime until the queue transition is saved');
  f.release();
  await closing;
  assert.equal(f.watch.rooms.size, 0);
  assert.equal(f.watch.roomState.store.get(f.id).bookmark.mediaId, '101');
});

test('a deferred checkpoint can finish after media adoption while successor generation is still pending', async t => {
  const f = await fixture(t, { autoLoad: true });
  const saving = f.watch.roomState.save(f.room);
  f.release();
  const deadline = Date.now() + 1500;
  while (!f.generationStarted) { assert.ok(Date.now() < deadline, 'Successor generation did not start'); await turn(); }
  await saving;
  assert.equal(f.room.media.id, '103');
  assert.equal(f.watch.roomState.store.get(f.id).bookmark.mediaId, '103');
  assert.equal(f.watch.roomState.queue.current(f.id).position, 0);
  f.releaseGeneration();
  assert.equal((await f.transition).status, 'applied');
});
