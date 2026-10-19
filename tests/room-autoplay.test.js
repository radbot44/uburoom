'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Accounts, credentialVault } = require('../server/accounts');
const { Hub } = require('../server/core');
const { Watch } = require('../server/watch');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate) {
  const deadline = Date.now() + 1500;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Autoplay operation did not settle');
    await delay(5);
  }
}
function gate() {
  let started = false, release;
  return { get started() { return started; }, held: new Promise(resolve => { release = resolve; }), enter: () => { started = true; }, release: () => release() };
}

async function fixture(t) {
  const registry = new Accounts(undefined, credentialVault());
  const creatorId = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const guestId = registry.resolve('discord', '222222222222222222', 'Host').id;
  const actor = userId => ({ userId, name: userId === creatorId ? 'Creator' : 'Host', surface: 'web', guildId: 'guild', channelId: 'commands', watchViewerId: randomUUID() });
  const creator = actor(creatorId), guest = actor(guestId);
  const hub = new Hub({ ownerId: '111111111111111111', guildId: 'guild', channels: ['commands'] }, []);
  hub.access = { isMember: () => true, refresh: async () => true };
  const stopped = [], prepared = [];
  const plex = {
    json: async () => ({ machineIdentifier: 'fixture-plex' }),
    prepare: async id => {
      const source = { id, kind: 'plex', format: 'file', duration: 100, title: 'Video ' + id, source: { type: 'movie' }, resources: new Map() };
      prepared.push(source);
      return source;
    },
    stop: async media => { if (media) stopped.push(media); }
  };
  const watch = new Watch(hub, plex, undefined, registry);
  watch.autoplayDelayMs = 30;
  clearInterval(watch.roomState.timer);
  let controller = creator;
  const id = await watch.roomState.create(creator, { name: 'Autoplay room' });
  const room = watch.rooms.get(id), queue = watch.roomState.queue, store = watch.roomState.store;
  watch.snapshot(room, creator, creator.watchViewerId, async () => true, 'direct');
  const command = (action, args, person = controller) => hub.dispatch(person, { roomId: id, action, ...(args ? { args } : {}) });
  assert.equal((await command('media.load', { mediaId: '100', quality: 'direct' })).status, 'applied');
  await watch.prepareViewer(room, creator, creator.watchViewerId);
  const upcoming = [];
  for (const mediaId of ['101', '102']) upcoming.push((await queue.add(id, creatorId, { serverId: 'fixture-plex', mediaId, type: 'movie', title: 'Video ' + mediaId, duration: 100 })).added);
  assert.equal((await command('media.autoplay.set', { enabled: true })).status, 'applied');
  function playTail() {
    room.position = 96; room.changedAt = Date.now(); room.manualPaused = false; room.initialGate = false; room.s.state.paused = false;
    room.pauseAt = room.startAt = undefined;
  }
  playTail();
  let observedAt = Date.now(), sequence = 0;
  watch.tracking.now = () => observedAt;
  async function observe(position, state = 'playing', extra = {}) {
    observedAt += 1000;
    sequence++;
    const viewer = room.viewers.get(controller.watchViewerId);
    const data = { epoch: room.s.epoch, mediaVersion: room.mediaVersion, streamVersion: viewer.streamVersion, observationEpoch: viewer.observationEpoch,
      sequence, sampleAt: observedAt, observedAt, position, state, frames: sequence * 30, rate: 1, discontinuity: 0, ...extra };
    const observed = watch.tracking.observe(room, viewer, controller.watchViewerId, data);
    await watch.observeEnd(room, viewer, data, observed);
  }
  async function end() { for (const position of [96, 97, 98, 99]) await observe(position); await observe(100, 'ended'); }
  const flush = registry.flush.bind(registry);
  t.after(async () => {
    registry.flush = flush;
    delete store.failure;
    watch.tracking.now = Date.now;
    await watch.close(); hub.close(); await registry.close();
  });
  return { registry, hub, plex, watch, room, queue, store, id, creator, guest, upcoming, command, observe, end, playTail, prepared, stopped,
    async hostController() {
      const record = store.get(id);
      watch.roomState.apply(room, await store.edit(id, creatorId, record.revision, { action: 'host.add', userId: guestId }));
      watch.snapshot(room, guest, guest.watchViewerId, async () => true, 'direct');
      await watch.prepareViewer(room, guest, guest.watchViewerId);
      await watch.leave(room, creator, creator.watchViewerId);
      controller = guest; playTail();
    }
  };
}

test('verified natural ending broadcasts one countdown, atomically archives completion and consumes one upcoming occurrence', async t => {
  const f = await fixture(t), before = f.queue.current(f.id), version = f.room.mediaVersion;
  await f.end();
  const countdown = f.room.autoplayCountdown;
  assert.ok(countdown); assert.equal(countdown.nextEntryId, f.upcoming[0].id);
  const snapshot = f.watch.snapshot(f.room, f.creator, f.creator.watchViewerId);
  assert.equal(snapshot.autoplay.countdown.title, 'Video 101');
  await f.observe(100, 'ended');
  assert.equal(f.room.autoplayCountdown, countdown, 'duplicate endings retain one countdown');
  await waitFor(() => f.queue.current(f.id).id === f.upcoming[0].id && !f.room.mediaTransition);
  assert.notEqual(f.room.mediaVersion, version);
  assert.equal(f.room.media.id, '101'); assert.equal(f.queue.list(f.id).total, 1);
  const history = f.queue.history(f.id);
  assert.equal(history.total, 1); assert.equal(history.items[0].id, before.id);
  assert.equal(history.items[0].outcome, 'completed'); assert.equal(history.items[0].position, 100);
  assert.equal(f.store.get(f.id).bookmark.mediaId, '101'); assert.equal(f.store.get(f.id).bookmark.position, 0);
  assert.equal(f.room.autoplayCountdown, undefined);
});

test('Cancel, pause, seek, queue edits and disabling autoplay immediately cancel countdowns without consuming entries', async t => {
  for (const [action, args] of [
    ['media.autoplay.cancel'], ['media.pause'], ['media.seek.absolute', { seconds: 20 }],
    ['queue.shuffle'], ['queue.add', { item: { serverId: 'fixture-plex', mediaId: '103', type: 'movie', title: 'Video 103', duration: 100 } }],
    ['media.autoplay.set', { enabled: false }]
  ]) await t.test(action, async sub => {
    const f = await fixture(sub), current = f.queue.current(f.id).id;
    await f.end(); assert.ok(f.room.autoplayCountdown);
    assert.equal((await f.command(action, args)).status, 'applied');
    assert.equal(f.room.autoplayCountdown, undefined);
    await delay(60);
    assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0);
  });
});

test('autoplay off retains current media paused at its verified ending when queue has upcoming items', async t => {
  const f = await fixture(t), current = f.queue.current(f.id).id;
  await f.command('media.autoplay.set', { enabled: false });
  await f.end(); await delay(60);
  assert.equal(f.room.autoplayCountdown, undefined); assert.equal(f.room.s.state.paused, true); assert.equal(f.room.position, 100);
  assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0);
});

test('empty upcoming queue archives completed media and leaves the player', async t => {
  const f = await fixture(t), before = f.queue.current(f.id);
  await f.command('queue.clear');
  await f.end(); await delay(60);
  assert.equal(f.room.autoplayCountdown, undefined); assert.equal(f.room.s.state.paused, true); assert.equal(f.room.position, 0);
  assert.equal(f.room.media, undefined);
  assert.equal(f.queue.current(f.id), null);
  const history = f.queue.history(f.id);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].id, before.id);
  assert.equal(history.items[0].outcome, 'completed');
  assert.equal(history.items[0].position, 100);
});

test('queue revisions fence countdowns even when the pending head remains the same', async t => {
  const f = await fixture(t), current = f.queue.current(f.id).id;
  await f.end(); assert.ok(f.room.autoplayCountdown);
  await f.queue.add(f.id, f.creator.userId, { serverId: 'fixture-plex', mediaId: '103', type: 'movie', title: 'Video 103', duration: 100 });
  await waitFor(() => !f.room.autoplayCountdown && !f.room.mediaTransition);
  assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0);
  assert.equal(f.queue.list(f.id).total, 3);
});

test('empty and closed rooms cannot consume the next occurrence', async t => {
  for (const mode of ['empty', 'closed']) await t.test(mode, async sub => {
    const f = await fixture(sub), current = f.queue.current(f.id).id;
    await f.end(); assert.ok(f.room.autoplayCountdown);
    if (mode === 'empty') { f.room.viewers.clear(); f.watch.refresh(f.room); }
    else await f.watch.remove(f.id);
    assert.equal(f.room.autoplayCountdown, undefined);
    await delay(60);
    assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0);
  });
});

test('next media preparation failure preserves the occurrence and reports one truthful failure without retry loops', async t => {
  const f = await fixture(t), current = f.queue.current(f.id).id;
  let attempts = 0;
  f.plex.prepare = async () => { attempts++; throw Object.assign(new Error('Plex fixture is unavailable'), { status: 503 }); };
  await f.end();
  await waitFor(() => !f.room.autoplayCountdown && !f.room.mediaTransition);
  assert.match(f.room.autoplayError, /Plex fixture is unavailable/);
  assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.peekNext(f.id).id, f.upcoming[0].id);
  assert.equal(f.queue.history(f.id).total, 0); assert.equal(attempts, 1);
  await delay(60); assert.equal(attempts, 1);
});

test('revoked host permissions during media preparation invalidate autoplay before consumption', async t => {
  const f = await fixture(t), held = gate(), prepare = f.plex.prepare;
  await f.hostController();
  f.plex.prepare = async (...args) => { held.enter(); await held.held; return prepare(...args); };
  const current = f.queue.current(f.id).id;
  await f.end(); await waitFor(() => held.started);
  const record = f.store.get(f.id);
  f.watch.roomState.apply(f.room, await f.store.edit(f.id, f.creator.userId, record.revision, { action: 'host.remove', userId: f.guest.userId }));
  held.release();
  await waitFor(() => !f.room.mediaTransition && !f.room.autoplayCountdown);
  assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.peekNext(f.id).id, f.upcoming[0].id);
  assert.equal(f.room.media.id, '100'); assert.equal(f.queue.history(f.id).total, 0);
});

test('a failed durable commit cannot adopt prepared media in the live room', async t => {
  const f = await fixture(t), version = f.room.mediaVersion;
  await f.end();
  f.registry.flush = async () => { throw new Error('Fixture disk failure'); };
  await waitFor(() => !f.room.autoplayCountdown && !f.room.mediaTransition);
  assert.equal(f.room.media.id, '100'); assert.equal(f.room.mediaVersion, version);
  assert.ok(f.store.failure); assert.match(f.room.autoplayError, /storage/i);
  assert.ok(f.stopped.some(media => media.id === '101'), 'unadopted prepared stream is released');
});

test('manual Next during an autoplay prepare cancels that attempt and a retry consumes exactly one entry', async t => {
  const f = await fixture(t), held = gate(), prepare = f.plex.prepare;
  let attempts = 0;
  f.plex.prepare = async (...args) => { attempts++; held.enter(); await held.held; return prepare(...args); };
  const current = f.queue.current(f.id).id;
  await f.end(); await waitFor(() => held.started);
  assert.equal((await f.command('media.next')).status, 'unavailable');
  held.release();
  await waitFor(() => !f.room.mediaTransition && !f.room.autoplayCountdown);
  assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0); assert.equal(attempts, 1);
  assert.equal((await f.command('media.next')).status, 'applied');
  assert.equal(f.queue.current(f.id).id, f.upcoming[0].id); assert.equal(f.queue.history(f.id).total, 1);
  assert.equal(f.queue.history(f.id).items[0].outcome, 'completed', 'manual advance retains the verified natural ending'); assert.equal(f.queue.list(f.id).total, 1);
});

test('pause, Cancel and closing while the next item is preparing release it without adopting or consuming it', async t => {
  for (const action of ['media.pause', 'media.autoplay.cancel', 'close']) await t.test(action, async sub => {
    const f = await fixture(sub), held = gate(), prepare = f.plex.prepare;
    f.plex.prepare = async (...args) => { held.enter(); await held.held; return prepare(...args); };
    const current = f.queue.current(f.id).id;
    await f.end(); await waitFor(() => held.started);
    if (action === 'close') await f.watch.remove(f.id);
    else assert.equal((await f.command(action)).status, 'applied');
    held.release(); await waitFor(() => !f.room.mediaTransition);
    assert.equal(f.queue.current(f.id).id, current); assert.equal(f.queue.history(f.id).total, 0);
    assert.equal(f.room.media.id, '100'); assert.ok(f.stopped.some(media => media.id === '101'));
  });
});

test('seeking to the end and reaching duration on the room clock do not start countdowns or archive completion', async t => {
  for (const mode of ['seek', 'clock']) await t.test(mode, async sub => {
    const f = await fixture(sub), current = f.queue.current(f.id).id;
    if (mode === 'seek') {
      await f.observe(96); await f.observe(97); await f.observe(98); await f.observe(99);
      assert.equal((await f.command('media.seek.end')).status, 'applied');
      await f.observe(100, 'ended', { discontinuity: 1 });
    } else {
      f.room.position = 100; f.watch.refresh(f.room);
    }
    await delay(60);
    assert.equal(f.room.autoplayCountdown, undefined); assert.equal(f.queue.current(f.id).id, current);
    assert.equal(f.queue.history(f.id).total, 0); assert.equal(f.room.endedVersion, undefined);
  });
});

for (const enabled of [false, true]) test('first queue addition selects current media and respects auto-play ' + enabled, async t => {
  const f = await fixture(t);
  const id = await f.watch.roomState.create(f.creator, { name: 'Empty queue' });
  const room = f.watch.rooms.get(id), actor = f.creator;
  f.watch.snapshot(room, actor, actor.watchViewerId, async () => true, 'direct');
  const command = (action, args) => f.hub.dispatch(actor, { roomId:id, action, args });
  assert.equal((await command('media.autoplay.set', { enabled })).status, 'applied');
  const item = { serverId:'fixture-plex', mediaId:'105', type:'movie', title:'First', duration:100 };
  assert.equal((await command('queue.add', { item, expectedRevision:0 })).status, 'applied');
  assert.equal(room.media.id, '105');
  assert.equal(f.queue.current(id).mediaId, '105');
  assert.equal(f.queue.pending(id).length, 0);
  await f.watch.prepareViewer(room, actor, actor.watchViewerId);
  await f.watch.ready(room, actor, actor.watchViewerId, room.mediaVersion, true, room.readinessVersion);
  assert.equal(room.manualPaused, !enabled);
  assert.equal(room.initialGate, !enabled);
  assert.equal(room.s.state.paused, !enabled);
  const current = f.queue.current(id).id;
  assert.equal((await command('queue.add', { item:{...item,mediaId:'106'}, expectedRevision:1 })).status, 'applied');
  assert.equal(f.queue.current(id).id, current);
  assert.equal(f.queue.pending(id).length, 1);
});

test('an add-only participant can populate empty playback but cannot replace it, including bulk additions', async t => {
  const f = await fixture(t);
  for (const bulk of [false, true]) {
    const id = await f.watch.roomState.create(f.creator, { name:'Participant additions' });
    const room = f.watch.rooms.get(id);
    const record = f.store.get(id);
    f.watch.roomState.apply(room, await f.store.edit(id, f.creator.userId, record.revision, {
      action:'permissions', role:'viewer', permissions:{addQueue:true,chooseMedia:false}
    }));
    await f.queue.setAutoplay(id, f.creator.userId, false);
    f.watch.snapshot(room, f.guest, f.guest.watchViewerId, async () => true, 'direct');
    f.plex.queueItems = async () => ['105','106'].map(id => ({id,type:'movie',title:'Video ' + id,duration:100}));
    const item = {serverId:'fixture-plex',mediaId:'105',type:'movie',title:'Video 105',duration:100};
    const result = await f.hub.dispatch(f.guest, {roomId:id,action:bulk ? 'queue.bulk' : 'queue.add',
      args:bulk ? {type:'show',mediaId:'50',unfinished:false,includeSpecials:false} : {item}});
    assert.equal(result.status, 'applied', result.message);
    assert.equal(f.queue.current(id).mediaId, '105');
    assert.equal(f.queue.pending(id).length, bulk ? 1 : 0);
    assert.equal(room.manualPaused, true);
    assert.equal((await f.hub.dispatch(f.guest, {roomId:id,action:'queue.playNow',args:{item}})).status, 'forbidden');
  }
});

for (const advance of [false, true]) test('current removal ' + (advance ? 'advances without history' : 'stops without consuming upcoming entries'), async t => {
  const f = await fixture(t);
  await f.command('media.next');
  const current = f.queue.current(f.id), history = f.queue.history(f.id).items.map(item => item.id);
  const upcoming = f.queue.pending(f.id).map(item => item.id), version = f.room.mediaVersion;
  const result = await f.command('queue.remove', {entryId:current.id,advance,expectedRevision:f.store.get(f.id).queueRevision});
  assert.equal(result.status,'applied',result.message);
  assert.equal(f.queue.getEntry(current.id),null);
  assert.deepEqual(f.queue.history(f.id).items.map(item => item.id),history);
  assert.notEqual(f.room.mediaVersion,version);
  assert.equal(f.room.autoplayCountdown,undefined);
  if (advance) {
    assert.equal(f.queue.current(f.id).id,upcoming[0]);
    assert.equal(f.room.media.id,f.queue.current(f.id).mediaId);
    assert.equal(f.store.get(f.id).bookmark.mediaId,f.room.media.id);
  } else {
    assert.equal(f.queue.current(f.id),null);
    assert.deepEqual(f.queue.pending(f.id).map(item => item.id),upcoming);
    assert.equal(f.store.get(f.id).bookmark,null);
    assert.equal(f.room.media,undefined);
    assert.equal(f.room.initialGate,false);
    assert.equal(f.room.s.state.paused,true);
    assert.equal(f.room.s.state.duration,0);
  }
});

test('discard-and-advance preparation failure and revoked video authority preserve the current occurrence', async t => {
  const f = await fixture(t), current = f.queue.current(f.id);
  const revision = f.store.get(f.id).queueRevision;
  const prepare = f.plex.prepare;
  f.plex.prepare = async () => { throw new Error('Fixture preparation failed'); };
  assert.equal((await f.command('queue.remove',{entryId:current.id,advance:true,expectedRevision:revision})).status,'failed');
  assert.equal(f.queue.current(f.id).id,current.id);
  assert.equal(f.queue.pending(f.id).length,2);
  assert.equal(f.queue.history(f.id).total,0);
  f.plex.prepare = prepare;
  const record = f.store.get(f.id);
  f.watch.roomState.apply(f.room,await f.store.edit(f.id,f.creator.userId,record.revision,{action:'permissions',role:'viewer',permissions:{editQueue:true,chooseMedia:false}}));
  f.watch.snapshot(f.room,f.guest,f.guest.watchViewerId,async () => true,'direct');
  assert.notEqual((await f.command('queue.remove',{entryId:current.id,advance:false,expectedRevision:revision},f.guest)).status,'applied');
  assert.equal(f.queue.current(f.id).id,current.id);
});
