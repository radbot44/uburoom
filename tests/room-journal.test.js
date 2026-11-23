'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createJournal,
  JOURNAL_LIMIT,
  SEEK_MERGE_MS,
  createRoomState,
  createRoomCoordinator,
  policyAuthorize,
  RoomAuthority,
  RECONNECT_GRACE_MS,
} = require('../shared/sync');

test('journal numbers entries monotonically, enforces cap, and merges with replaces', () => {
  let seqId = 0;
  const journal = createJournal({ limit: 5, createId: () => `j-${++seqId}` });
  assert.equal(journal.journalId, 'j-1');
  assert.equal(journal.head, 0);

  const first = journal.append(
    {
      at: 1000,
      kind: 'playback.seek',
      actor: { id: 'u1', name: 'Alice' },
      mediaVersion: 'mv1',
      data: { from: 10, to: 20 },
    },
    {
      mergeWithin: SEEK_MERGE_MS,
      key: 'seek:u1:mv1',
      merge: (prev, next) => ({ from: prev.data.from, to: next.data.to }),
    },
  );
  assert.equal(first.seq, 1);
  assert.equal(first.replaces, undefined);

  // Merge within 5 s window
  const merged = journal.append(
    {
      at: 4000,
      kind: 'playback.seek',
      actor: { id: 'u1', name: 'Alice' },
      mediaVersion: 'mv1',
      data: { from: 20, to: 55 },
    },
    {
      mergeWithin: SEEK_MERGE_MS,
      key: 'seek:u1:mv1',
      merge: (prev, next) => ({ from: prev.data.from, to: next.data.to }),
    },
  );
  assert.equal(merged.seq, 2);
  assert.equal(merged.replaces, 1);
  assert.deepEqual(merged.data, { from: 10, to: 55 });
  assert.equal(journal.size, 1);

  // Beyond 5 s window does not merge
  const separate = journal.append(
    {
      at: 10000,
      kind: 'playback.seek',
      actor: { id: 'u1', name: 'Alice' },
      mediaVersion: 'mv1',
      data: { from: 55, to: 80 },
    },
    {
      mergeWithin: SEEK_MERGE_MS,
      key: 'seek:u1:mv1',
      merge: (prev, next) => ({ from: prev.data.from, to: next.data.to }),
    },
  );
  assert.equal(separate.seq, 3);
  assert.equal(separate.replaces, undefined);
  assert.equal(journal.size, 2);

  // Enforce cap
  for (let i = 0; i < 6; i++) {
    journal.append({ at: 20000 + i * 1000, kind: 'playback.pause', data: { position: i } });
  }
  assert.equal(journal.size, 5);
  assert.equal(journal.head, 9);
  assert.equal(journal.since(6).length, 3);

  // Pending write tracks replaced seqs
  const pending = journal.pendingWrite(0);
  assert.deepEqual(pending.deletes, [1]);
  journal.acknowledgeDeletes(pending.deletes);
  assert.deepEqual(journal.pendingWrite(9).deletes, []);

  // Clear rotates journalId
  const prevId = journal.journalId;
  journal.clear();
  assert.notEqual(journal.journalId, prevId);
  assert.equal(journal.size, 0);
  assert.equal(journal.head, 0);
  assert.equal(JOURNAL_LIMIT, 500);
});

test('coordinator observer logs play/pause, seek merges, buffering, presence grace, host handoff, and media transitions', async () => {
  let clock = 100_000;
  let mono = 1000;
  let ids = 0;
  const coordinator = createRoomCoordinator({
    authorize: policyAuthorize,
    now: () => clock,
    monoNow: () => mono,
    createId: () => `id-${++ids}`,
    setTimer: () => ({}),
    clearTimer: () => {},
  });

  const alice = { userId: 'alice', name: 'Alice' };
  const bob = { userId: 'bob', name: 'Bob' };
  const room = createRoomState({
    roomId: 'room-1',
    creatorId: 'alice',
    creatorName: 'Alice',
    hosts: ['bob'],
    now: clock,
    createId: () => `id-${++ids}`,
    media: { id: 'm1', title: 'Alien', subtitle: '1979', duration: 600 },
  });
  coordinator.add(room);
  const journal = coordinator.journal(room);
  assert.ok(journal);

  // record() outside mailbox throws
  assert.throws(() => coordinator.record(room, { kind: 'room.settings', data: {} }), /mailbox/);

  // Alice joins (2 tabs -> only 1 people.join)
  coordinator.runSync(room, { type: 'join', viewerId: 'v-a1', actor: alice });
  clock += 1000;
  coordinator.runSync(room, { type: 'join', viewerId: 'v-a2', actor: alice });
  let entries = journal.since(0);
  assert.equal(entries.filter(e => e.kind === 'people.join').length, 1);

  // Bob joins within 60 s -> merged into the same people.join entry
  clock += 5000;
  coordinator.runSync(room, { type: 'join', viewerId: 'v-b1', actor: bob });
  entries = journal.since(0);
  const joins = entries.filter(e => e.kind === 'people.join');
  assert.equal(joins.length, 1);
  assert.equal(joins[0].data.people.length, 2);
  assert.ok(joins[0].replaces);

  // Play, seek twice within 5 s, then pause
  clock += 1000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a1' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-b1' });
  coordinator.runSync(room, { type: 'command', actor: alice, command: { action: 'media.play', args: {} } });
  clock += 2000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a1' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a2' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-b1' });
  coordinator.runSync(room, {
    type: 'command',
    actor: alice,
    command: { action: 'media.seek.absolute', args: { seconds: 100 } },
  });
  clock += 2000;
  coordinator.runSync(room, {
    type: 'command',
    actor: alice,
    command: { action: 'media.seek.absolute', args: { seconds: 140 } },
  });
  const seeks = journal.since(0).filter(e => e.kind === 'playback.seek');
  assert.equal(seeks.length, 1);
  assert.equal(seeks[0].data.to, 140);
  assert.ok(seeks[0].replaces);

  // Buffering pause via step
  room.initialGate = false;
  room.state.paused = false;
  room.startAt = undefined;
  clock += 1000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a1' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a2' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-b1' });
  coordinator.step(room, live => {
    RoomAuthority.pauseForBuffering(live, 'v-b1', ['v-a1', 'v-b1'], clock, mono);
  });
  const pauses = journal.since(0).filter(e => e.kind === 'playback.pause');
  assert.ok(pauses.some(e => e.data.reason === 'buffering' && e.data.viewer?.id === 'bob'));

  // Disconnect + reconnect within grace period produces NO people.leave or people.join
  const beforeSeq = journal.head;
  clock += 1000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a1' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a2' });
  coordinator.runSync(room, { type: 'disconnect', viewerId: 'v-b1', planned: true });
  clock += 3000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a1' });
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-a2' });
  coordinator.runSync(room, { type: 'join', viewerId: 'v-b1', actor: bob });
  const graceEntries = journal.since(beforeSeq);
  assert.equal(graceEntries.filter(e => e.kind === 'people.leave' || e.kind === 'people.join').length, 0);

  // Alice leaves both tabs -> Bob becomes host (people.host) and Alice leaves (people.leave)
  clock += 1000;
  coordinator.runSync(room, { type: 'touch', viewerId: 'v-b1' });
  coordinator.runSync(room, { type: 'leave', viewerId: 'v-a1', actor: alice });
  coordinator.runSync(room, { type: 'leave', viewerId: 'v-a2', actor: alice });
  const afterLeave = journal.since(beforeSeq);
  assert.ok(afterLeave.some(e => e.kind === 'people.leave' && e.actor?.id === 'alice'));
  assert.ok(afterLeave.some(e => e.kind === 'people.host' && e.data?.hostId === 'bob'));

  // Media transition via step with cause
  clock += 1000;
  coordinator.step(
    room,
    live => {
      live.media = { id: 'm2', title: 'Aliens', subtitle: '1986', duration: 720 };
      live.mediaVersion = 'mv-2';
      live.position = 0;
      live.changedAt = clock;
    },
    { cause: { actor: bob, action: 'media.next' } },
  );
  const mediaEntries = journal.since(0).filter(e => e.kind.startsWith('media.'));
  assert.equal(mediaEntries.length, 2);
  assert.equal(mediaEntries[0].kind, 'media.end');
  assert.equal(mediaEntries[0].data.media.title, 'Alien');
  assert.equal(mediaEntries[0].data.reason, 'skipped');
  assert.equal(mediaEntries[1].kind, 'media.start');
  assert.equal(mediaEntries[1].data.media.title, 'Aliens');
  assert.equal(mediaEntries[1].data.how, 'next');

  // Disconnect beyond grace expires and records people.leave
  clock += 1000;
  coordinator.runSync(room, { type: 'disconnect', viewerId: 'v-b1', planned: true });
  clock += RECONNECT_GRACE_MS + 1000;
  coordinator.runSync(room, { type: 'timer' });
  assert.ok(journal.since(0).some(e => e.kind === 'people.leave' && e.actor?.id === 'bob'));
});
