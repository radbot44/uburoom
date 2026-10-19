'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Accounts, credentialVault } = require('../server/accounts');
const { RoomStore } = require('../server/room-store');
const { RoomQueue, MAX_PENDING } = require('../server/room-queue');

function fixture(t, { disk = false, defaults, isAdmin } = {}) {
  const directory = disk ? fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-queue-test-')) : undefined;
  const file = directory && path.join(directory, 'accounts.sqlite'), vault = credentialVault();
  let registry = new Accounts(file, vault);
  let store = new RoomStore(registry, { defaults, isAdmin });
  let queue = new RoomQueue(registry, store);

  const creator = registry.resolve('discord', '111111111111111111', 'Creator').id;
  const host = registry.resolve('plex', '101', 'Host').id;
  const viewer = registry.resolve('discord', '222222222222222222', 'Viewer').id;

  t.after(async () => {
    await Promise.resolve(registry.close()).catch(() => {});
    if (directory) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  return {
    get registry() { return registry; },
    get store() { return store; },
    get queue() { return queue; },
    creator, host, viewer, file,
    async restart() {
      await registry.close();
      registry = new Accounts(file, vault);
      store = new RoomStore(registry, { defaults, isAdmin });
      queue = new RoomQueue(registry, store);
    }
  };
}

const sampleItem = (n = 1) => ({
  serverId: 'plex-server-1',
  mediaId: String(100 + n),
  type: 'episode',
  title: `Episode ${n}`,
  parentTitle: 'Season 1',
  grandparentTitle: 'Great Show',
  duration: 1800,
  thumb: `/library/metadata/${100 + n}/thumb`
});

test('add appends to queue, updates queueRevision, and rejects exceeding MAX_PENDING', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator, { name: 'Queue Room' });
  await f.store.edit(room.id, f.creator, room.revision, { action: 'host.add', userId: f.host });

  const added1 = await f.queue.add(room.id, f.creator, sampleItem(1));
  assert.equal(added1.added.rank, 0);
  assert.equal(added1.added.title, 'Episode 1');
  assert.equal(added1.queueRevision, 1);

  const added2 = await f.queue.add(room.id, f.host, sampleItem(2), { expectedRevision: 1 });
  assert.equal(added2.added.rank, 1);
  assert.equal(added2.added.title, 'Episode 2');
  assert.equal(added2.queueRevision, 2);

  const list = f.queue.list(room.id);
  assert.equal(list.total, 2);
  assert.equal(list.items[0].id, added1.added.id);
  assert.equal(list.items[1].id, added2.added.id);

  // Stale expectedRevision rejected
  await assert.rejects(
    f.queue.add(room.id, f.creator, sampleItem(3), { expectedRevision: 1 }),
    /Queue changed/
  );
});

test('viewer without addQueue permission cannot add, but full participant permissions allow it', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);

  await assert.rejects(
    f.queue.add(room.id, f.viewer, sampleItem(1)),
    /Room queue permission required/
  );

  // Enable full permissions for room
  const fullRoom = await f.store.create(f.creator, { fullPermissions: true });
  const added = await f.queue.add(fullRoom.id, f.viewer, sampleItem(1));
  assert.equal(added.added.title, 'Episode 1');
});

test('move reindexes pending items transactionally and rejects stale queueRevision', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  const e1 = (await f.queue.add(room.id, f.creator, sampleItem(1))).added;
  const e2 = (await f.queue.add(room.id, f.creator, sampleItem(2))).added;
  const e3 = (await f.queue.add(room.id, f.creator, sampleItem(3))).added;

  // Stale revision rejects
  await assert.rejects(
    f.queue.move(room.id, f.creator, e3.id, 0, 1),
    /Queue changed/
  );

  // Move e3 (currently at rank 2) to rank 0 with correct revision (3)
  const moved = await f.queue.move(room.id, f.creator, e3.id, 0, 3);
  assert.equal(moved.queueRevision, 4);

  const list = f.queue.list(room.id);
  assert.equal(list.items[0].id, e3.id);
  assert.equal(list.items[0].rank, 0);
  assert.equal(list.items[1].id, e1.id);
  assert.equal(list.items[1].rank, 1);
  assert.equal(list.items[2].id, e2.id);
  assert.equal(list.items[2].rank, 2);
});

test('remove deletes entry, reindexes remaining, and rejects stale queueRevision', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  const e1 = (await f.queue.add(room.id, f.creator, sampleItem(1))).added;
  const e2 = (await f.queue.add(room.id, f.creator, sampleItem(2))).added;
  const e3 = (await f.queue.add(room.id, f.creator, sampleItem(3))).added;

  const res = await f.queue.remove(room.id, f.creator, e2.id, 3);
  assert.equal(res.removed, e2.id);
  assert.equal(res.queueRevision, 4);

  const list = f.queue.list(room.id);
  assert.equal(list.total, 2);
  assert.equal(list.items[0].id, e1.id);
  assert.equal(list.items[0].rank, 0);
  assert.equal(list.items[1].id, e3.id);
  assert.equal(list.items[1].rank, 1);
});

test('clear removes all pending items', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.add(room.id, f.creator, sampleItem(1));
  await f.queue.add(room.id, f.creator, sampleItem(2));

  const res = await f.queue.clear(room.id, f.creator, 2);
  assert.equal(res.cleared, true);
  assert.equal(res.queueRevision, 3);

  const list = f.queue.list(room.id);
  assert.equal(list.total, 0);
});

test('playNow interrupts current item, saves progress in history, and sets new current', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);

  // Play item 1
  const p1 = await f.queue.playNow(room.id, f.creator, sampleItem(1));
  assert.equal(p1.current.title, 'Episode 1');
  assert.equal(p1.previous, null);
  assert.equal(f.queue.current(room.id).id, p1.current.id);

  // Play item 2 while item 1 is at 450s
  const p2 = await f.queue.playNow(room.id, f.creator, sampleItem(2), 450);
  assert.equal(p2.current.title, 'Episode 2');
  assert.equal(p2.previous.id, p1.current.id);

  // Check history
  const history = f.queue.history(room.id);
  assert.equal(history.total, 1);
  assert.equal(history.items[0].id, p1.current.id);
  assert.equal(history.items[0].outcome, 'interrupted');
  assert.equal(history.items[0].position, 450);

  // Check room bookmark updated
  const storedRoom = f.store.get(room.id);
  assert.equal(storedRoom.bookmark.title, 'Episode 2');
});

test('next advances pending to current, archives old current with outcome, and reindexes pending', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  const e1 = (await f.queue.add(room.id, f.creator, sampleItem(1))).added;
  const e2 = (await f.queue.add(room.id, f.creator, sampleItem(2))).added;

  // First advance to next (nothing was playing yet)
  const n1 = await f.queue.next(room.id, f.creator);
  assert.equal(n1.current.id, e1.id);
  assert.equal(n1.previous, null);

  const remaining = f.queue.list(room.id);
  assert.equal(remaining.total, 1);
  assert.equal(remaining.items[0].id, e2.id);
  assert.equal(remaining.items[0].rank, 0);

  // Advance to next while e1 was playing at 1800s (completed)
  const n2 = await f.queue.next(room.id, f.creator, { currentPosition: 1800, outcome: 'completed' });
  assert.equal(n2.current.id, e2.id);
  assert.equal(n2.previous.id, e1.id);

  const hist = f.queue.history(room.id);
  assert.equal(hist.total, 1);
  assert.equal(hist.items[0].id, e1.id);
  assert.equal(hist.items[0].outcome, 'completed');
  assert.equal(hist.items[0].position, 1800);
});

test('previous restarts current if position >= 5s, otherwise replays history as fresh occurrence', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.add(room.id, f.creator, sampleItem(1));
  await f.queue.add(room.id, f.creator, sampleItem(2));

  // Advance to item 1, then item 2
  await f.queue.next(room.id, f.creator);
  await f.queue.next(room.id, f.creator, { currentPosition: 1750, outcome: 'completed' });

  // Now current is item 2.
  // 1. Position = 10s (>= 5s): restarts current
  const r1 = await f.queue.previous(room.id, f.creator, 10);
  assert.equal(r1.action, 'restart');
  assert.equal(r1.position, 0);
  assert.equal(f.queue.current(room.id).title, 'Episode 2');

  // 2. Position = 2s (< 5s): replays item 1 from history as fresh occurrence!
  const r2 = await f.queue.previous(room.id, f.creator, 2);
  assert.equal(r2.action, 'replayed');
  assert.equal(r2.current.title, 'Episode 1');
  assert.notEqual(r2.current.id, r1.current.id); // New occurrence UUID!
  assert.equal(r2.current.state, 'current');

  // Episode 2 should now be in history as interrupted at 2s
  const hist = f.queue.history(room.id);
  assert.equal(hist.total, 2);
  assert.equal(hist.items[0].title, 'Episode 2');
  assert.equal(hist.items[0].outcome, 'interrupted');
});

test('historyReplay can resume or start over, creating a fresh occurrence', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.playNow(room.id, f.creator, sampleItem(2), 600); // archives item 1 at 600s

  const hist = f.queue.history(room.id);
  const item1HistId = hist.items[0].id;
  assert.equal(hist.items[0].position, 600);

  // Resume item 1
  const resumed = await f.queue.historyReplay(room.id, f.creator, item1HistId, { resume: true });
  assert.equal(resumed.replayed.title, 'Episode 1');
  assert.notEqual(resumed.replayed.id, item1HistId); // Fresh UUID
  assert.equal(resumed.replayed.position, 600);

  // Start over item 2
  const item2Hist = f.queue.history(room.id).items[0];
  const restarted = await f.queue.historyReplay(room.id, f.creator, item2Hist.id, { resume: false });
  assert.equal(restarted.replayed.title, 'Episode 2');
  assert.equal(restarted.replayed.position, 0);
});

test('historyClear removes history without touching queue or current', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.playNow(room.id, f.creator, sampleItem(2));
  await f.queue.add(room.id, f.creator, sampleItem(3));

  assert.equal(f.queue.history(room.id).total, 1);
  assert.equal(f.queue.list(room.id).total, 1);

  const cleared = await f.queue.historyClear(room.id, f.creator);
  assert.equal(cleared.cleared, true);
  assert.equal(f.queue.history(room.id).total, 0);
  assert.equal(f.queue.list(room.id).total, 1);
  assert.equal(f.queue.current(room.id).title, 'Episode 2');
});

test('checkpoint updates position of current occurrence', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));

  f.queue.checkpoint(room.id, 825.5);
  const cur = f.queue.current(room.id);
  assert.equal(cur.position, 825.5);
});

test('summary returns lightweight snapshot with current, next, and counts', async t => {
  const f = fixture(t);
  const room = await f.store.create(f.creator);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.add(room.id, f.creator, sampleItem(2));

  const sum = f.queue.summary(room.id);
  assert.equal(sum.queueLength, 1);
  assert.equal(sum.historyLength, 0);
  assert.equal(sum.current.title, 'Episode 1');
  assert.equal(sum.next.title, 'Episode 2');
});

test('queue and history survive disk restart', async t => {
  const f = fixture(t, { disk: true });
  const room = await f.store.create(f.creator);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.add(room.id, f.creator, sampleItem(2));
  f.queue.checkpoint(room.id, 300);

  await f.restart();

  const sum = f.queue.summary(room.id);
  assert.equal(sum.queueLength, 1);
  assert.equal(sum.current.title, 'Episode 1');
  assert.equal(sum.current.position, 300);
  assert.equal(sum.next.title, 'Episode 2');

  const list = f.queue.list(room.id);
  assert.equal(list.total, 1);
  assert.equal(list.items[0].title, 'Episode 2');
});

test('bulk append deduplicates active occurrences, filters only completed room history and preserves rewatch identities', async t => {
  const f = fixture(t), room = await f.store.create(f.creator);
  const first = (await f.queue.playNow(room.id, f.creator, sampleItem(1))).current;
  await f.queue.add(room.id, f.creator, sampleItem(2));
  await f.queue.next(room.id, f.creator, { outcome: 'completed' });
  await f.queue.add(room.id, f.creator, sampleItem(3));
  const skipped = await f.queue.addBulk(room.id, f.creator, [sampleItem(1), sampleItem(2), sampleItem(3), sampleItem(4), sampleItem(4)], { unfinished: true });
  assert.deepEqual(skipped.added.map(item => item.mediaId), ['104']);
  const rewatch = await f.queue.addBulk(room.id, f.creator, [sampleItem(1)]);
  assert.equal(rewatch.added[0].mediaId, '101');
  assert.notEqual(rewatch.added[0].id, first.id);
  const otherServer = await f.queue.addBulk(room.id, f.creator, [{ ...sampleItem(1), serverId: 'another-server' }], { unfinished: true });
  assert.equal(otherServer.added.length, 1);
  await assert.rejects(f.queue.addBulk(room.id, f.viewer, [sampleItem(5)]), /permission/);
  await assert.rejects(f.queue.addBulk(room.id, f.creator, [sampleItem(5)], { expectedRevision: 0 }), /Queue changed/);
});

test('bulk overflow and insertion failures leave all entries and revisions unchanged', async t => {
  const f = fixture(t), room = await f.store.create(f.creator);
  await f.queue.addBulk(room.id, f.creator, Array.from({ length: 99 }, (_, index) => sampleItem(index + 1)));
  const revision = f.store.get(room.id).queueRevision;
  await assert.rejects(f.queue.addBulk(room.id, f.creator, [sampleItem(500), sampleItem(501)]), /Adding 2 items would exceed/);
  assert.equal(f.queue.list(room.id).total, 99);
  assert.equal(f.store.get(room.id).queueRevision, revision);
  await f.queue.clear(room.id, f.creator, revision);
  const before = f.store.get(room.id).queueRevision;
  f.registry.db.exec("CREATE TEMP TRIGGER reject_bulk BEFORE INSERT ON watch_queue_entries WHEN NEW.mediaId = '102' BEGIN SELECT RAISE(ABORT, 'fixture insertion failure'); END");
  await assert.rejects(f.queue.addBulk(room.id, f.creator, [sampleItem(1), sampleItem(2)]), /fixture insertion failure/);
  assert.equal(f.queue.list(room.id).total, 0);
  assert.equal(f.store.get(room.id).queueRevision, before);
});

test('shuffle reorders only pending occurrences with contiguous ranks and current/edit fences', async t => {
  const f = fixture(t), room = await f.store.create(f.creator);
  const current = (await f.queue.playNow(room.id, f.creator, sampleItem(1))).current;
  await f.queue.addBulk(room.id, f.creator, [sampleItem(2), sampleItem(3), sampleItem(4)]);
  const before = f.queue.list(room.id);
  f.queue.randomIndex = () => 0;
  const shuffled = await f.queue.shuffle(room.id, f.creator, before.queueRevision);
  const after = f.queue.list(room.id);
  assert.deepEqual(after.items.map(item => item.mediaId), ['103', '104', '102']);
  assert.deepEqual(after.items.map(item => item.rank), [0, 1, 2]);
  assert.equal(f.queue.current(room.id).id, current.id);
  assert.equal(shuffled.queueRevision, before.queueRevision + 1);
  await assert.rejects(f.queue.shuffle(room.id, f.creator, before.queueRevision), /Queue changed/);
  await assert.rejects(f.queue.shuffle(room.id, f.viewer, shuffled.queueRevision), /permission/);
});

const autoConfig = mode => ({ mode, scope: { type: 'show', id: '50', serverId: 'plex-server-1' }, includeSpecials: false });

test('following generation appends after the current or pending tail and atomic advance saves the successor', async t => {
  const f = fixture(t), room = await f.store.create(f.creator);
  const corpus = [1, 2, 3, 4].map(sampleItem);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.configureAuto(room.id, f.creator, autoConfig('following'));
  const generated = await f.queue.generate(room.id, f.creator, corpus);
  assert.deepEqual(generated.added.map(item => item.mediaId), ['102']);
  assert.equal((await f.queue.generate(room.id, f.creator, corpus)).added.length, 0);
  const current = f.queue.current(room.id), next = f.queue.peekNext(room.id), revision = f.store.get(room.id).queueRevision;
  const advanced = await f.queue.next(room.id, f.creator, { outcome: 'completed', expectedRevision: revision, currentEntryId: current.id, nextEntryId: next.id, corpus });
  assert.equal(advanced.current.mediaId, '102');
  assert.equal(advanced.generated[0].mediaId, '103');
  assert.equal(advanced.queueRevision, revision + 1);
  assert.equal(f.queue.history(room.id).items[0].outcome, 'completed');
  assert.equal(f.queue.history(room.id).items[0].position, current.duration);
  assert.equal(f.store.get(room.id).bookmark.mediaId, '102');
  await assert.rejects(f.queue.next(room.id, f.creator, { expectedRevision: revision, currentEntryId: current.id, nextEntryId: next.id }), /Queue changed/);
  await assert.rejects(f.queue.next(room.id, f.creator, { currentEntryId: current.id }), /Queue changed/);
  await assert.rejects(f.queue.next(room.id, f.creator, { guard: () => false }), /Playback changed/);
  assert.equal(f.queue.current(room.id).id, advanced.current.id);
});

test('random generation persists its pool cycle and autoplay choice across reopen without rerolls', async t => {
  const f = fixture(t, { disk: true }), room = await f.store.create(f.creator), corpus = [1, 2, 3].map(sampleItem);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.configureAuto(room.id, f.creator, autoConfig('random'));
  await f.queue.setAutoplay(room.id, f.creator, false);
  f.queue.randomIndex = () => 0;
  assert.equal((await f.queue.generate(room.id, f.creator, corpus)).added[0].mediaId, '102');
  await f.restart();
  f.queue.randomIndex = () => 0;
  assert.equal(f.store.get(room.id).autoplay, false);
  assert.equal(f.queue.peekNext(room.id).mediaId, '102');
  assert.deepEqual(f.store.get(room.id).autoQueue.used, ['101', '102']);
  await f.queue.next(room.id, f.creator, { corpus });
  assert.equal(f.queue.peekNext(room.id).mediaId, '103');
  assert.equal(f.store.get(room.id).autoQueue.cycle, 0);
  await f.queue.next(room.id, f.creator, { corpus });
  assert.equal(f.queue.peekNext(room.id).mediaId, '101');
  assert.equal(f.store.get(room.id).autoQueue.cycle, 1);
  const summary = f.queue.summary(room.id);
  assert.equal(summary.autoplay, false);
  assert.equal(summary.autoQueue.used, undefined, 'snapshots exclude the potentially large persisted pool');
  await assert.rejects(f.queue.setAutoplay(room.id, f.viewer, true), /permission/);
});

test('generation insertion failure rolls back completion, bookmark, successor and random state together', async t => {
  const f = fixture(t), room = await f.store.create(f.creator), corpus = [1, 2, 3].map(sampleItem);
  await f.queue.playNow(room.id, f.creator, sampleItem(1));
  await f.queue.add(room.id, f.creator, sampleItem(2));
  await f.queue.configureAuto(room.id, f.creator, autoConfig('random'));
  const before = f.store.get(room.id);
  f.registry.db.exec("CREATE TEMP TRIGGER reject_generation BEFORE INSERT ON watch_queue_entries WHEN NEW.mediaId = '103' BEGIN SELECT RAISE(ABORT, 'fixture generation failure'); END");
  await assert.rejects(f.queue.next(room.id, f.creator, { outcome: 'completed', corpus }), /fixture generation failure/);
  assert.equal(f.queue.current(room.id).mediaId, '101');
  assert.equal(f.queue.peekNext(room.id).mediaId, '102');
  assert.equal(f.queue.history(room.id).total, 0);
  assert.deepEqual(f.store.get(room.id), before);
});

test('configured continuation follows chooseMedia authority without granting queue configuration or manual generation', async t => {
  const f = fixture(t), room = await f.store.create(f.creator), corpus = [1, 2].map(sampleItem);
  await f.store.edit(room.id, f.creator, room.revision, { action: 'permissions', role: 'viewer', permissions: { chooseMedia: true } });
  await f.queue.playNow(room.id, f.viewer, sampleItem(1));
  await f.queue.configureAuto(room.id, f.creator, autoConfig('following'));
  await assert.rejects(f.queue.configureAuto(room.id, f.viewer, autoConfig('random')), /permission/);
  await assert.rejects(f.queue.generate(room.id, f.viewer, corpus), /permission/);
  await assert.rejects(f.queue.generate(room.id, f.viewer, corpus, { continuation: 'true' }), /Invalid auto-queue continuation/);
  const result = await f.queue.generate(room.id, f.viewer, corpus, { continuation: true });
  assert.equal(result.added[0].mediaId, '102');
});
