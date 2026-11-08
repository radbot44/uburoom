'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PlaybackTracking } = require('../server/playback-tracking');
const { Accounts, credentialVault } = require('../server/accounts');

function fixture(registry) {
  let now = 100000;
  const tracking = new PlaybackTracking(registry, () => now);
  const room = { s: { roomId: randomUUID() }, media: { id: '42', duration: 300 }, mediaVersion: randomUUID() };
  const viewer = () => ({ userId: 'user', observationEpoch: randomUUID(), streamVersion: randomUUID(), mediaVersion: room.mediaVersion, media: { kind: 'plex', format: 'av1' } });
  const data = (v, seq, position, state = 'playing', extra = {}) => ({
    observationEpoch: v.observationEpoch, streamVersion: v.streamVersion, mediaVersion: room.mediaVersion,
    sequence: seq, sampleAt: seq * 1000, observedAt: now, position, state, rate: 1, frames: seq * 30, discontinuity: 0, ...extra
  });
  return { tracking, room, viewer, data, tick: (ms = 1000) => now += ms };
}

test('only advancing decoded playback earns credit; seeks, buffering, paused presence and replay do not', async () => {
  const f = fixture(), v = f.viewer(), send = (seq, pos, state, extra) => f.tracking.observe(f.room, v, 'tab', f.data(v, seq, pos, state, extra));
  send(1, 100); f.tick(); send(2, 101);
  assert.equal(v.tracking.record.watchedSeconds, 1, 'late join earns only new playback');
  f.tick(); send(3, 200); f.tick(); send(4, 201, 'buffering'); f.tick(); send(5, 201, 'paused'); f.tick(); send(6, 201, 'playing');
  assert.equal(v.tracking.record.watchedSeconds, 1);
  f.tick(); send(7, 202);
  assert.equal(v.tracking.record.watchedSeconds, 2);

  // Rejected observations throw safe rejections and do not consume sequence or baseline
  assert.throws(() => send(7, 202), err => err.rejection === 'sequence-replayed');
  assert.throws(() => send(8, 203, 'playing', { observedAt: 0 }), err => err.rejection === 'sample-stale');
  assert.throws(() => send(8, 203, 'playing', { streamVersion: randomUUID() }), err => err.rejection === 'stream-changed');
  assert.throws(() => send(8, 203, 'playing', { mediaVersion: 'mismatched' }), err => err.rejection === 'media-changed');
  assert.equal(v.observationSequence, 7, 'rejected observations do not consume sequence');

  f.tick(); send(8, 203, 'playing', { frames: 210 });
  assert.equal(v.tracking.record.watchedSeconds, 2, 'no new frames');
  f.tick(); send(9, 204, 'playing', { discontinuity: 1 });
  assert.equal(v.tracking.record.watchedSeconds, 2, 'brief seek/pause between reports');
  f.tick(); send(10, 205, 'playing', { discontinuity: 1, rate: 1.04 });
  assert.ok(v.tracking.record.watchedSeconds > 2, 'small synchronized rate adjustments retain observed viewing');

  f.tracking.end(v, 'logout');
  const row = (await f.tracking.history('user')).sessions[0];
  assert.equal(row.endReason, 'logout');
  assert.equal(row.deliveryMode, 'uburoom-av1');
  f.tracking.close();
});

test('overlapping tabs retain individual sessions, union wall time and source coverage, and use source timestamps', async () => {
  const f = fixture(), a = f.viewer(), b = f.viewer();
  for (let seq = 1; seq <= 3; seq++) {
    if (seq > 1) f.tick();
    for (const v of [a, b]) f.tracking.observe(f.room, v, v === a ? 'a' : 'b', f.data(v, seq, seq));
  }
  const history = await f.tracking.history('user');
  assert.equal(history.sessions.length, 2);
  assert.equal(history.sessions.reduce((n, s) => n + s.watchedSeconds, 0), 4);
  assert.deepEqual(history.totals, [{ mediaId: '42', watchedSeconds: 2, sourceSeconds: 2 }]);
  f.tracking.end(a, 'left');
  f.tick();
  f.tracking.observe(f.room, b, 'b', f.data(b, 4, 4));
  assert.equal((await f.tracking.history('user')).totals[0].watchedSeconds, 3);
  f.tracking.close();

  // Overlap uses source observation timestamps rather than differing delivery latency
  const f2 = fixture(), v1 = f2.viewer(), v2 = f2.viewer();
  f2.tracking.observe(f2.room, v1, 'a', f2.data(v1, 1, 0));
  f2.tick(500);
  f2.tracking.observe(f2.room, v2, 'b', f2.data(v2, 1, 0, 'playing', { observedAt: 100000 }));
  f2.tick(500);
  f2.tracking.observe(f2.room, v1, 'a', f2.data(v1, 2, 1));
  f2.tick(500);
  f2.tracking.observe(f2.room, v2, 'b', f2.data(v2, 2, 1, 'playing', { observedAt: 101000 }));
  assert.equal((await f2.tracking.history('user')).totals[0].watchedSeconds, 1);
  f2.tracking.close();
});

test('observation timeout rotates the lease; reconnect never credits the gap or replays a previous report', async () => {
  const f = fixture(), v = f.viewer();
  f.tracking.observe(f.room, v, 'tab', f.data(v, 1, 0));
  f.tick();
  f.tracking.observe(f.room, v, 'tab', f.data(v, 2, 1));
  const stale = f.data(v, 3, 2);
  f.tick(6000);
  f.tracking.expire(v);
  assert.equal(v.tracking, undefined);
  assert.throws(() => f.tracking.observe(f.room, v, 'tab', { ...stale, observedAt: 107000 }));
  f.tracking.observe(f.room, v, 'tab', f.data(v, 10, 50));
  f.tick();
  f.tracking.observe(f.room, v, 'tab', f.data(v, 11, 51));
  const history = await f.tracking.history('user');
  assert.equal(history.sessions.length, 2);
  assert.equal(history.totals[0].watchedSeconds, 2);
  assert.ok(history.sessions.some(s => s.endReason === 'observation-timeout'));
  f.tracking.close();
});

test('durable records preserve provider provenance, mark interrupted runs and survive explicit account merges', async () => {
  const registry = new Accounts(undefined, credentialVault());
  const a = registry.resolve('plex', '101', 'Alice'), b = registry.resolve('discord', '123', 'Alice Discord');
  const f = fixture(registry), v = f.viewer();
  v.userId = a.id;
  f.tracking.observe(f.room, v, 'tab', f.data(v, 1, 0));
  f.tick();
  f.tracking.observe(f.room, v, 'tab', f.data(v, 2, 1));
  const restarted = new PlaybackTracking(registry, () => 102000);
  assert.equal((await restarted.history(a.id)).sessions[0].endReason, 'interrupted');
  registry.merge(b.id, a.id, b.id);
  const history = await restarted.history(b.id);
  assert.equal(history.totals[0].watchedSeconds, 1);
  assert.deepEqual(history.sessions[0].identities, [{ provider: 'plex', subject: '101' }]);
  assert.equal((await restarted.history('unrelated')).sessions.length, 0);
  registry.close();
});

test('server wall-clock steps reject stale/future reports without replaying or crediting the changed interval', async () => {
  for (const step of [-4745, 4745]) {
    const f = fixture(), v = f.viewer();
    try {
      f.tracking.observe(f.room, v, 'tab', f.data(v, 1, 0));
      f.tick(1000 + step);
      assert.throws(() => f.tracking.observe(f.room, v, 'tab', f.data(v, 2, 1, 'playing', { observedAt: 101000 })), error => error.rejection === (step > 0 ? 'sample-stale' : 'sample-future'));
      if (step > 0) assert.throws(() => f.tracking.observe(f.room, v, 'tab', f.data(v, 2, 1, 'playing', { discontinuity: 1 })), error => error.rejection === 'observation-timeout');
      const result = f.tracking.observe(f.room, v, 'tab', f.data(v, 2, 1, 'playing', { discontinuity: 1 }));
      assert.equal(result.credit.reason, step > 0 ? 'baseline' : 'discontinuity');
      assert.equal(result.watchedSeconds, 0);
      f.tick();
      assert.equal(f.tracking.observe(f.room, v, 'tab', f.data(v, 3, 2, 'playing', { discontinuity: 1 })).watchedSeconds, 1);
    } finally {
      f.tracking.close();
    }
  }
});
