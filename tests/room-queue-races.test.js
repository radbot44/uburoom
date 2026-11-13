'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { currentSignal } = require('../server/operation');
const { Accounts, credentialVault } = require('../server/accounts');
const { Hub } = require('../server/core');
const { Watch } = require('../server/watch');
const { wireRooms } = require('./helpers/live-room');

const turn = () => new Promise(setImmediate);
async function roomFixture({ disk = false } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-room-lifecycle-')) : undefined;
  const file = directory && path.join(directory, 'accounts.sqlite'),
    vault = credentialVault();
  const registry = new Accounts(file, vault);
  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const actor = {
    userId: creator,
    name: 'Creator',
    watchViewerId: randomUUID(),
  };
  const hub = new Hub({ ownerId: '111111111111111111' }, []);
  hub.access = { isMember: () => true, refresh: async () => true };
  const events = [],
    stopped = [];
  const plex = {
    json: async () => ({ machineIdentifier: 'race-fixture' }),
    prepare: async id => ({
      id,
      kind: 'plex',
      duration: 100,
      title: 'Video ' + id,
      source: { type: 'movie' },
      resources: new Map(),
    }),
    stop: async media => {
      if (media) {
        stopped.push(media);
        events.push('stop:' + media.id);
      }
    },
    close: async () => {
      events.push('provider-closed');
    },
  };
  const watch = wireRooms(hub, plex, new Watch(hub, plex, undefined, registry));
  clearInterval(watch.roomState.timer);
  const id = await watch.roomState.create(actor, { name: 'Writer race' }),
    room = watch.rooms.get(id);
  watch.join(room, actor, actor.watchViewerId, { alive: async () => true, quality: 'direct' });
  assert.equal(
    (await hub.dispatch(actor, { roomId: id, action: 'media.load', args: { mediaId: '100', quality: 'direct' } }))
      .status,
    'applied',
  );
  await watch.roomState.queue.add(id, creator, {
    serverId: 'race-fixture',
    mediaId: '101',
    type: 'movie',
    title: 'Video 101',
    duration: 100,
  });
  return {
    registry,
    watch,
    hub,
    room,
    id,
    actor,
    plex,
    events,
    stopped,
    file,
    vault,
    async cleanup() {
      await watch.close().catch(() => {});
      hub.close();
      await registry.close();
      if (directory) {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('uburoom-room-lifecycle-'));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}
async function fixture(t, { autoLoad = false } = {}) {
  const f = await roomFixture();
  const { registry, watch, hub, room, id, actor } = f,
    creator = actor.userId;
  let generationStarted = false,
    releaseGeneration = () => {};
  if (autoLoad) {
    await watch.roomState.queue.configureAuto(id, creator, {
      mode: 'random',
      scope: { type: 'library', id: '1', serverId: 'race-fixture' },
    });
    watch.autoCorpus = async () =>
      ['100', '101', '103'].map(mediaId => ({
        serverId: 'race-fixture',
        mediaId,
        type: 'movie',
        title: 'Video ' + mediaId,
        duration: 100,
      }));
    const generate = watch.roomState.queue.generate.bind(watch.roomState.queue);
    const heldGeneration = new Promise(resolve => {
      releaseGeneration = resolve;
    });
    watch.roomState.queue.generate = async (...args) => {
      generationStarted = true;
      await heldGeneration;
      return generate(...args);
    };
  }
  room.position = 80;
  room.changedAt = watch.clock.now();
  room.initialGate = false;
  room.manualPaused = true;
  room.state.paused = true;
  const originalFlush = registry.flush.bind(registry);
  let release;
  const held = new Promise(resolve => {
    release = resolve;
  });
  registry.flush = async () => {
    await held;
    await originalFlush();
  };
  const transition = hub.dispatch(actor, {
    roomId: id,
    action: autoLoad ? 'media.load' : 'media.next',
    ...(autoLoad ? { args: { mediaId: '103', quality: 'direct' } } : {}),
  });
  const deadline = Date.now() + 1500;
  while (!room.transition?.commit) {
    assert.ok(Date.now() < deadline, 'Transition did not reach writer');
    await turn();
  }
  t.after(async () => {
    release();
    releaseGeneration();
    registry.flush = originalFlush;
    await transition;
    await f.cleanup();
  });
  return {
    registry,
    watch,
    hub,
    room,
    id,
    actor,
    transition,
    release,
    releaseGeneration,
    get generationStarted() {
      return generationStarted;
    },
  };
}

test('viewer expiry during a queue commit cannot checkpoint old media onto the new occurrence', async t => {
  const f = await fixture(t);
  assert.equal(f.watch.roomState.queue.current(f.id).mediaId, '101');
  assert.equal(f.room.media.id, '100', 'live adoption waits for the writer');
  f.room.viewers.get(f.actor.watchViewerId).at = Date.now() - 10001;
  f.watch.review(f.room);
  await turn();
  f.release();
  await f.transition;
  await Promise.allSettled([...f.watch.roomState.pending]);
  const record = f.watch.roomState.store.get(f.id),
    current = f.watch.roomState.queue.current(f.id);
  assert.equal(record.bookmark.mediaId, '101');
  assert.equal(current.position, 0);
  assert.equal(record.bookmark.position, 0);
});

test('stale autoplay retains preload ownership until cancellation cleans up every prepared output', async t => {
  const f = await roomFixture();
  t.after(() => f.cleanup());
  await f.watch.roomState.queue.completeCurrent(f.id);
  f.watch.unloadQueueMedia(f.room);
  f.room.manualPaused = false;
  await f.watch.startAutoplayCountdown(f.room);
  const countdown = f.room.autoplayCountdown,
    preload = f.room.preload;
  await preload.source;
  await turn();
  const outputs = await Promise.all(preload.viewers.values());
  assert.equal(outputs.length, 1);
  f.watch.join(f.room, f.actor, randomUUID(), { alive: async () => true, quality: 'direct' });
  const result = await f.hub.dispatch(
    { ...f.actor, watchQueueAdvance: countdown },
    { roomId: f.id, action: 'media.next' },
  );
  assert.equal(result.status, 'unavailable');
  assert.equal(f.room.preload, preload, 'rejection cannot detach ownership before a cleanup scope exists');
  f.watch.cancelAutoplay(f.room);
  await f.watch.drainMedia(f.room);
  assert.equal(f.stopped.filter(media => media === preload.media).length, 1);
  for (const output of outputs) assert.equal(f.stopped.filter(media => media === output.media).length, 1);
  assert.equal(f.room.preload, undefined);
});

test('orderly shutdown captures final progress and restart intent before detaching, after pending checkpoints', async t => {
  const f = await roomFixture({ disk: true });
  t.after(() => f.cleanup());
  f.room.position = 25;
  f.room.changedAt = f.watch.clock.now();
  f.room.initialGate = false;
  f.room.state.paused = true;
  await f.watch.roomState.save(f.room);
  const flush = f.registry.flush.bind(f.registry);
  let release, entered;
  const held = new Promise(resolve => {
      release = resolve;
    }),
    started = new Promise(resolve => {
      entered = resolve;
    });
  f.registry.flush = async () => {
    entered();
    await held;
    return flush();
  };
  const previous = f.watch.roomState.save(f.room);
  await started;
  f.room.position = 80;
  f.room.changedAt = f.watch.clock.now();
  f.room.startAt = undefined;
  f.room.state.paused = false;
  f.room.manualPaused = false;
  const closing = f.watch.close();
  try {
    await turn();
    assert.equal(f.events.includes('provider-closed'), false, 'the final checkpoint still owns storage');
  } finally {
    release();
    f.registry.flush = flush;
  }
  await previous;
  await closing;
  await f.registry.flush();
  const restarted = new Accounts(f.file, f.vault);
  try {
    const record = new (require('../server/room-store').RoomStore)(restarted).get(f.id);
    assert.ok(record.bookmark.position >= 80 && record.bookmark.position < 81);
    assert.equal(
      restarted.db.prepare("SELECT position FROM watch_queue_entries WHERE roomId=? AND state='current'").get(f.id)
        .position,
      record.bookmark.position,
    );
    assert.equal(record.liveState.wasPlaying, true);
    assert.deepEqual(record.liveState.viewers, [f.actor.userId]);
    assert.deepEqual(Object.keys(record.liveState).sort(), ['viewers', 'wasPlaying']);
    assert.equal(restarted.identity('discord', '111111111111111111').userId, f.actor.userId);
    assert.equal(restarted.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally {
    await restarted.close();
  }
});

test('shutdown cancels preparation and waits for late output cleanup before closing the provider', async t => {
  const f = await roomFixture();
  let release, entered, signal;
  const held = new Promise(resolve => {
      release = resolve;
    }),
    started = new Promise(resolve => {
      entered = resolve;
    });
  const prepare = f.plex.prepare;
  f.plex.prepare = async (...args) => {
    if (args[0] === '101') {
      signal = currentSignal();
      entered();
      await held;
    }
    return prepare(...args);
  };
  t.after(async () => {
    release();
    await f.cleanup();
  });
  const transition = f.hub.dispatch(f.actor, { roomId: f.id, action: 'media.next' });
  await started;
  let closed = false;
  const closing = f.watch.close().then(() => {
    closed = true;
  });
  await turn();
  assert.equal(signal.aborted, true);
  assert.equal(closed, false);
  assert.equal(f.events.includes('provider-closed'), false);
  release();
  assert.equal((await transition).status, 'unavailable');
  await closing;
  assert.ok(f.events.indexOf('stop:101') < f.events.indexOf('provider-closed'));
  assert.equal(f.watch.roomState.queue.current(f.id).mediaId, '100');
  assert.equal(f.watch.mediaWork.size, 0);
});

test('shutdown drains an unfinished preload and bounds a provider that ignores cancellation', async t => {
  const f = await roomFixture({ disk: true });
  let release, entered;
  const held = new Promise(resolve => {
      release = resolve;
    }),
    started = new Promise(resolve => {
      entered = resolve;
    });
  const prepare = f.plex.prepare;
  f.plex.prepare = async (...args) => {
    if (args[0] === '101') {
      entered();
      await held;
    }
    return prepare(...args);
  };
  t.after(async () => {
    release();
    await Promise.allSettled([...f.watch.mediaWork].map(work => work.promise));
    await f.cleanup();
  });
  await f.watch.roomState.queue.completeCurrent(f.id);
  f.watch.unloadQueueMedia(f.room);
  f.room.manualPaused = false;
  await f.watch.startAutoplayCountdown(f.room);
  await started;
  f.watch.mediaDrainMs = 30;
  await assert.rejects(f.watch.close(), error => error.name === 'TimeoutError');
  assert.equal(f.events.includes('provider-closed'), true, 'deadline failure still closes the available subsystems');
  assert.equal(f.watch.reporting.closed, true);
  release();
  await Promise.allSettled([...f.watch.mediaWork].map(work => work.promise));
  await f.watch.drainMedia();
  assert.equal(f.watch.roomState.queue.current(f.id), null, 'a late preload cannot adopt or consume the next entry');
  assert.equal(f.stopped.filter(media => media.id === '101').length, 1);
});

test('a final checkpoint failure still closes provider/reporting and the application database', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-app-lifecycle-'));
  const app = require('../server/app').createApp({
    publicUrl: 'https://localhost',
    ownerId: '111111111111111111',
    guildId: 'guild',
    channels: ['commands'],
    accountFile: path.join(directory, 'accounts.sqlite'),
    credentialKeyFile: path.join(directory, 'original.key'),
  });
  t.after(async () => {
    await app.close().catch(() => {});
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('uburoom-app-lifecycle-'));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  app.access.connect({ isMember: () => true, refresh: async () => true });
  const userId = app.registry.resolve('discord', '111111111111111111', 'Fixture').id;
  const actor = { userId, name: 'Fixture' };
  const id = await app.watch.roomState.create(actor, { keepEmpty: true });
  app.watch.join(app.watch.rooms.get(id), actor, randomUUID(), { alive: async () => true });
  await Promise.all([...app.watch.roomState.pending]);
  await app.registry.flush();
  const flush = app.registry.flush.bind(app.registry);
  app.registry.flush = async () => {
    app.registry.flush = flush;
    throw new Error('Injected final checkpoint failure');
  };
  await assert.rejects(app.close(), /Room storage unavailable/);
  assert.equal(app.watch.reporting.closed, true);
  assert.equal(app.watch.roomState.stopped, true);
  assert.throws(() => app.registry.db.prepare('SELECT 1'), /not open|closed/i);
});

test('shutdown waits for a pending queue commit and the resulting final room save', async t => {
  const f = await fixture(t);
  let closed = false;
  const closing = f.watch.close().then(() => {
    closed = true;
  });
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
  while (!f.generationStarted) {
    assert.ok(Date.now() < deadline, 'Successor generation did not start');
    await turn();
  }
  await saving;
  assert.equal(f.room.media.id, '103');
  assert.equal(f.watch.roomState.store.get(f.id).bookmark.mediaId, '103');
  assert.equal(f.watch.roomState.queue.current(f.id).position, 0);
  f.releaseGeneration();
  assert.equal((await f.transition).status, 'applied');
});
