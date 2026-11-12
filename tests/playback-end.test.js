'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PlaybackTracking } = require('../server/playback-tracking');
const { Accounts, credentialVault } = require('../server/accounts');
const { observePlaybackEnd, clearPlaybackEnd } = require('../server/playback-end');

function fixture() {
  let now = 100000,
    sequence = 0;
  const registry = new Accounts(undefined, credentialVault()),
    tracking = new PlaybackTracking(registry, () => now);
  const room = {
    roomId: randomUUID(),
    epoch: randomUUID(),
    state: { paused: false },
    media: { id: 'episode', duration: 100 },
    mediaVersion: randomUUID(),
    viewers: new Map(),
    manualPaused: false,
    initialGate: false,
  };
  const viewer = {
    userId: 'viewer',
    mediaVersion: room.mediaVersion,
    streamVersion: randomUUID(),
    observationEpoch: randomUUID(),
    media: { kind: 'demo' },
  };
  room.viewers.set('tab', viewer);
  function send(position, state = 'playing', extra = {}, delay = 1000) {
    now += delay;
    sequence++;
    const data = {
      epoch: room.epoch,
      observationEpoch: viewer.observationEpoch,
      streamVersion: viewer.streamVersion,
      mediaVersion: room.mediaVersion,
      sequence,
      sampleAt: now,
      observedAt: now,
      position,
      rate: 1,
      frames: sequence * 30,
      discontinuity: 0,
      state,
      ...extra,
    };
    const result = tracking.observe(room, viewer, 'tab', data);
    return observePlaybackEnd(room, viewer, data, result, now);
  }
  const tail = () => {
    send(96);
    send(97);
    send(98);
    send(99);
  };
  return { tracking, registry, room, viewer, send, tail };
}

test('natural ending requires recent sequential decoded playback; clamped room clock does not veto valid intent', () => {
  const f = fixture();
  try {
    f.tail();
    f.room.state.paused = true;
    assert.equal(f.send(100, 'ended'), true);
    assert.equal(f.send(100, 'ended'), false, 'the same ending cannot be consumed twice');
  } finally {
    f.registry.close();
  }
});

test('ending evidence is fenced by room epochs, stream leases, and invalidated by pauses, gaps, or premature seeks', () => {
  // 1. Premature or fraudulent completions
  const fraudCases = [
    f => {
      f.send(10);
      return f.send(100, 'ended');
    },
    f => {
      f.send(96);
      f.send(97);
      f.send(98);
      return f.send(98, 'ended');
    },
    f => {
      f.send(96);
      f.send(97);
      f.send(98, 'playing', { frames: 60 });
      f.send(99);
      return f.send(100, 'ended');
    },
    f => {
      f.tail();
      f.send(99.95, 'seeking', { discontinuity: 1 });
      return f.send(100, 'ended', { discontinuity: 1 });
    },
  ];
  for (const scenario of fraudCases) {
    const f = fixture();
    try {
      assert.equal(scenario(f), false);
    } finally {
      f.registry.close();
    }
  }

  // 2. Intervening pauses, buffer states, explicit resets, or timing gaps
  for (const state of ['paused', 'buffering', 'seeking', 'error']) {
    const f = fixture();
    try {
      f.tail();
      f.send(99, state);
      assert.equal(f.send(100, 'ended'), false, state);
    } finally {
      f.registry.close();
    }
  }
  for (const change of [
    f => {
      f.room.manualPaused = true;
    },
    f => {
      clearPlaybackEnd(f.room);
    },
    f => {
      f.room.viewers.clear();
    },
  ]) {
    const f = fixture();
    try {
      f.tail();
      change(f);
      assert.equal(f.send(100, 'ended'), false);
    } finally {
      f.registry.close();
    }
  }
  const gapFixture = fixture();
  try {
    gapFixture.tail();
    assert.equal(gapFixture.send(100, 'ended', {}, 3000), false, 'time gap discards ending evidence');
  } finally {
    gapFixture.registry.close();
  }

  // 3. Epoch, media, stream, and observation lease fences
  for (const change of [
    f => {
      f.room.epoch = randomUUID();
    },
    f => {
      f.room.mediaVersion = f.viewer.mediaVersion = randomUUID();
    },
    f => {
      f.viewer.streamVersion = randomUUID();
    },
    f => {
      f.viewer.observationEpoch = randomUUID();
    },
  ]) {
    const f = fixture();
    try {
      f.tail();
      change(f);
      assert.equal(f.send(100, 'ended'), false);
    } finally {
      f.registry.close();
    }
  }
});

test('a short near-end restart must earn its own decoded tail; accepted ending does not add watch credit', () => {
  const f = fixture();
  try {
    f.send(10);
    f.send(11);
    f.send(99);
    f.send(99.9, 'playing', {}, 900);
    assert.equal(f.send(100, 'ended', {}, 100), false);
    clearPlaybackEnd(f.room);
    f.send(96, 'seeking', { discontinuity: 1 });
    f.send(96, 'playing', { discontinuity: 1 });
    f.send(97, 'playing', { discontinuity: 1 });
    f.send(98, 'playing', { discontinuity: 1 });
    f.send(99, 'playing', { discontinuity: 1 });
    const before = f.viewer.tracking.record.watchedSeconds;
    assert.equal(f.send(100, 'ended', { discontinuity: 1 }), true);
    assert.equal(f.viewer.tracking.record.watchedSeconds, before);
  } finally {
    f.registry.close();
  }
});

test('ending evidence belongs to an individual viewer and short clips require actual decoded progress', () => {
  const a = fixture(),
    b = fixture();
  try {
    a.send(97);
    a.send(98);
    a.send(99);
    b.send(99);
    assert.equal(b.send(100, 'ended'), false, 'another viewer cannot lend its verified tail');
    assert.equal(a.send(100, 'ended'), true);
    b.room.media.duration = 2;
    b.send(0, 'seeking', { discontinuity: 1 });
    b.send(0, 'playing', { discontinuity: 1 });
    b.send(1, 'playing', { discontinuity: 1 });
    assert.equal(b.send(2, 'ended', { discontinuity: 1 }), true);
  } finally {
    a.registry.close();
    b.registry.close();
  }
});
