'use strict';
const { install } = require('./helpers/watch-sync');
const test = require('node:test'),
  assert = require('node:assert/strict');
const { correction, presentation, jumpCorrection } = require('../web/playback-timing');

function fixture() {
  const policy = correction();
  let now = 0;
  return {
    policy,
    step: (ms = 500, extra = {}) =>
      policy.update({ now: (now += ms), error: 0.3, eligible: true, context: 'one', ...extra }),
  };
}

test('small drift stays at native speed at representative cadences and within clock uncertainty', () => {
  for (const fps of [24, 60]) {
    const f = fixture();
    for (let i = 0; i < 100; i++)
      assert.equal(f.step(500, { error: 0.015, frameSeconds: 1 / fps, uncertaintyMs: 10 }), 1);
    // Once settling has passed, the resting band is wider than the settling band.
    for (let i = 0; i < 100; i++)
      assert.equal(f.step(500, { error: 0.028, frameSeconds: 1 / fps, uncertaintyMs: 10 }), 1);
  }
  const f = fixture();
  for (let i = 0; i < 20; i++) assert.equal(f.step(500, { error: 0.1, uncertaintyMs: 250 }), 1);
  const highRtt = fixture();
  for (let i = 0; i < 10; i++)
    assert.equal(
      highRtt.step(500, { error: 0.05, uncertaintyMs: 110, stabilityMs: 25 }),
      1,
      'ignores drift inside asymmetry bound',
    );
  assert.equal(highRtt.step(500, { error: 0.35, uncertaintyMs: 110, stabilityMs: 25 }), 1);
  assert.equal(
    highRtt.step(500, { error: 0.35, uncertaintyMs: 110, stabilityMs: 25 }),
    1.04,
    'corrects resolvable drift on stable high-RTT clock',
  );
  assert.equal(
    highRtt.step(500, { error: 0.1, uncertaintyMs: 110, stabilityMs: 25 }),
    1.015,
    'keeps converging inside the clock uncertainty',
  );
  assert.equal(highRtt.step(500, { error: -0.1, uncertaintyMs: 110, stabilityMs: 25 }), 1, 'exits on a sign change');
  for (let i = 0; i < 3; i++) highRtt.step(500, { error: 0.35, uncertaintyMs: 110, stabilityMs: 25 });
  assert.equal(
    highRtt.step(500, { error: 0.35, uncertaintyMs: 110, stabilityMs: 105 }),
    1,
    'aborts when stabilityMs > 100',
  );
});

test('persistent drift converges with a tapering rate and rests; stalled progress backs off', () => {
  const f = fixture();
  assert.equal(f.step(), 1);
  assert.equal(f.step(), 1.04, 'settling after a reset needs half a second of evidence');
  for (let i = 0; i < 19; i++) assert.equal(f.step(), 1.04);
  assert.equal(f.step(), 1, 'backs off when the error has stopped shrinking');
  for (let i = 0; i < 9; i++) assert.equal(f.step(), 1, 'quiet interval');
  assert.equal(f.step(), 1, 'fresh persistence required');
  assert.equal(f.step(), 1);
  assert.equal(f.step(), 1.04);
  // A player that obeys: the error shrinks at the commanded rate.
  let error = 0.3,
    rate = 1.04,
    previous = rate;
  for (let i = 0; i < 60 && rate !== 1; i++) {
    error -= (rate - 1) * 0.5;
    rate = f.step(500, { error });
    assert.ok(rate <= previous && (rate === 1 || rate >= 1.01), 'the rate only tapers, down to one percent');
    previous = rate;
  }
  assert.equal(rate, 1, 'stops');
  assert.ok(error > 0 && error <= 0.015, `stops near zero without overshoot (${error})`);
  for (let i = 0; i < 40; i++) assert.equal(f.step(500, { error }), 1, 'rests');
});

test('transient/sign-changing drift never accumulates evidence; interrupted playback cancels a burst', () => {
  const f = fixture();
  for (let i = 0; i < 20; i++) assert.equal(f.step(500, { error: i % 2 ? 0.3 : -0.3 }), 1);
  for (const extra of [
    { eligible: false },
    { context: 'replacement' },
    { error: -0.3 },
    { error: NaN },
    { error: 1 },
  ]) {
    const g = fixture();
    for (let i = 0; i < 3; i++) g.step();
    assert.equal(g.step(500, extra), 1);
  }
  const g = fixture();
  for (let i = 0; i < 3; i++) g.step();
  assert.equal(g.step(4000), 1, 'sleep cannot continue a burst');
  g.policy.reset();
  assert.equal(g.step(), 1);
  const ahead = fixture();
  for (let i = 0; i < 2; i++) ahead.step(500, { error: -0.3 });
  assert.equal(ahead.step(500, { error: -0.3 }), 0.96);
  assert.equal(ahead.step(500, { error: -0.05 }), 0.99);
});

test('cadence estimate needs contiguous frames and resets across source/seek boundaries', () => {
  for (const fps of [24, 60]) {
    const p = presentation();
    for (let i = 0; i < 9; i++)
      p.frame((i * 1000) / fps, { mediaTime: i / fps, expectedDisplayTime: (i * 1000) / fps, presentedFrames: i });
    assert.ok(Math.abs(p.cadence() - 1 / fps) < 1e-8);
    p.reset();
    assert.equal(p.cadence(), 0);
    for (let i = 0; i < 20; i++)
      p.frame((i * 1000) / fps, { mediaTime: i / fps, expectedDisplayTime: (i * 1000) / fps, presentedFrames: i * 2 });
    assert.equal(p.cadence(), 0, 'missed callbacks cannot establish source cadence');
  }
});

test('pause, buffering, seek, teardown, offline and hidden events immediately restore native speed', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) f.step();
  const ctx = { driftCorrection: f.policy, video: { playbackRate: 1.005 }, document: { hidden: true } };
  const sync = await install(ctx);
  for (const event of ['pause', 'waiting', 'seeking', 'emptied', 'offline', 'pagehide', 'visibilitychange']) {
    ctx.video.playbackRate = 1.005;
    sync.event(event);
    assert.equal(ctx.video.playbackRate, 1, event);
    assert.equal(f.step(), 1, event + ' cancels persistence');
  }
});

test('default uses proportional drift correction with persistence and recovery guards', async () => {
  let now = 0;
  const jumps = jumpCorrection();
  const ctx = {
    state: { mediaUrl: 'fixture', state: { paused: false, volume: 50, muted: false } },
    expected: () => 10.3,
    playbackClock: { read: () => ({ valid: true, clockUncertaintyMs: 12 }) },
    startKey: () => 'fixture',
    driftCorrection: correction(),
    jumpDriftCorrection: jumps,
    presentationTiming: presentation(),
    syncCorrectionMode: 'speed',
    pauseAlarm: { cancel() {} },
    performance: { now: () => now },
    document: { visibilityState: 'visible' },
    video: {
      currentTime: 10,
      readyState: 4,
      seeking: false,
      paused: false,
      playbackRate: 1,
      buffered: { length: 1, start: () => 0, end: () => 40 },
    },
    hlsPreparationUntil: 0,
    hlsTimelinePending: false,
    syncSeekPending: false,
    uburoomPlayback: require('../web/playback-policy'),
    playerWaiting: false,
    probing: false,
    playbackError: '',
    hlsNetworkFailure: undefined,
    renderTransport() {},
    checkVideoFrames() {},
  };
  await install(ctx);
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1, 'waits for sustained drift before adjusting speed');
  now = 500;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1.04, 'applies proportional speed adjustment');
  now = 1000;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1.04);
  ctx.video.currentTime = 10.25;
  now = 1500;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1.01, 'tapers rate smoothly as viewer catches up');
  ctx.playerWaiting = true;
  now = 2000;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1);
  ctx.playerWaiting = false;
  ctx.document.visibilityState = 'hidden';
  now = 2500;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1);

  jumps.committed({ now: 3000, frames: 10, target: 5, context: 'fixture' });
  assert.equal(
    jumps.update({
      now: 3100,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 14,
      position: 20,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    'blocks premature completion immediately after backward jump',
  );
  assert.equal(
    jumps.update({
      now: 5000,
      error: 0.08,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 20,
      position: 7.05,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    'unlocks cleanly when frame callbacks resume with elapsed progression',
  );
  assert.equal(
    jumps.update({
      now: 12500,
      error: 0.35,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 22,
      position: 7.2,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    '8s cooldown active until 13000',
  );
  assert.equal(
    jumps.update({
      now: 13100,
      error: 0.35,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 24,
      position: 7.3,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
  );
  assert.equal(
    jumps.update({
      now: 14100,
      error: 0.35,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 26,
      position: 7.4,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    true,
    'pending unlocked and fires new jump after cooldown',
  );
  jumps.committed({ now: 14100, frames: 30, target: 5, context: 'fixture' });
  assert.equal(
    jumps.update({
      now: 17500,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 35,
      position: 8.9,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    'first failed seek enters 30s bounded retry backoff',
  );
  assert.equal(
    jumps.update({
      now: 40000,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 40,
      position: 12,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    '30s backoff blocks early retry',
  );
  assert.equal(
    jumps.update({
      now: 47600,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 45,
      position: 15,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
  );
  assert.equal(
    jumps.update({
      now: 48600,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 48,
      position: 16,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    true,
    'allows one bounded retry after 30s backoff',
  );
  jumps.committed({ now: 48600, frames: 48, target: 5, context: 'fixture' });
  assert.equal(jumps.suspended(), false);
  assert.equal(
    jumps.update({
      now: 52000,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 55,
      position: 19.4,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    'second failed seek locks until explicit reset',
  );
  assert.equal(jumps.suspended(), true, 'marks jump correction suspended after exhausting retry budget');
  assert.equal(
    jumps.update({
      now: 90000,
      error: 0.4,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 80,
      position: 30,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
    'remains locked after retry budget exhausted',
  );
  ctx.sync.sharedSeek();
  assert.equal(jumps.suspended(), false, 'sharedSeek clears suspended jump state');
  assert.equal(
    jumps.update({
      now: 91000,
      error: 0.3,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 85,
      position: 5,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    false,
  );
  assert.equal(
    jumps.update({
      now: 92100,
      error: 0.3,
      eligible: true,
      context: 'fixture',
      buffered: true,
      settled: true,
      frames: 88,
      position: 5,
      uncertaintyMs: 10,
      stabilityMs: 10,
    }),
    true,
    'sharedSeek clears exhausted pending lock',
  );

  ctx.document.visibilityState = 'visible';
  ctx.expected = () => 10.3;
  ctx.video.currentTime = 10.15;
  const syncKey = ctx.sync.contextKey();
  // Behind frame: mediaTime 10.18 vs target 10.30 => presentationErrorMs = -120 ms => presentationControlError = +0.12 s
  // Position error: 10.3 - 10.15 = +0.15 s => divergence = 30 ms <= 90 ms => presentation selected
  ctx.presentationTiming.frame(
    30000,
    { mediaTime: 10.18, expectedDisplayTime: 30000, presentedFrames: 100 },
    { target: 10.3, context: syncKey },
  );
  now = 30000;
  await ctx.synchronize();
  now = 30500;
  ctx.presentationTiming.frame(
    30500,
    { mediaTime: 10.18 + (30500 - 30000) / 1000, expectedDisplayTime: 30500, presentedFrames: 112 },
    { target: 10.3 + (30500 - 30000) / 1000, context: syncKey },
  );
  await ctx.synchronize();
  now = 31000;
  ctx.presentationTiming.frame(
    31000,
    { mediaTime: 10.18 + (31000 - 30000) / 1000, expectedDisplayTime: 31000, presentedFrames: 124 },
    { target: 10.3 + (31000 - 30000) / 1000, context: syncKey },
  );
  await ctx.synchronize();
  assert.equal(ctx.sync.control.source, 'presentation', 'selects presentation control signal');
  assert.equal(ctx.video.playbackRate, 1.02, 'steers playbackRate to speed up from behind presentation error');

  // Stale sample fallback: after > 1000 ms without frame updates, falls back to position difference
  ctx.video.currentTime = 10.0;
  now = 32500;
  await ctx.synchronize();
  assert.equal(ctx.sync.control.source, 'position', 'falls back to position when presentation sample is stale');
  assert.equal(ctx.video.playbackRate, 1.04, 'falls back to currentTime difference when presentation sample is stale');

  // Ahead frame: mediaTime 10.42 vs target 10.30 => presentationErrorMs = +120 ms => presentationControlError = -0.12 s (slows down)
  ctx.video.currentTime = 10.45;
  ctx.presentationTiming.frame(
    33000,
    { mediaTime: 10.42, expectedDisplayTime: 33000, presentedFrames: 150 },
    { target: 10.3, context: syncKey },
  );
  now = 33000;
  await ctx.synchronize(); // exits previous positive direction burst
  now = 33500;
  ctx.presentationTiming.frame(
    33500,
    { mediaTime: 10.42 + (33500 - 33000) / 1000, expectedDisplayTime: 33500, presentedFrames: 162 },
    { target: 10.3 + (33500 - 33000) / 1000, context: syncKey },
  );
  await ctx.synchronize(); // sets since.at = 33500
  now = 34000;
  ctx.presentationTiming.frame(
    34000,
    { mediaTime: 10.42 + (34000 - 33000) / 1000, expectedDisplayTime: 34000, presentedFrames: 174 },
    { target: 10.3 + (34000 - 33000) / 1000, context: syncKey },
  );
  await ctx.synchronize();
  now = 34500;
  ctx.presentationTiming.frame(
    34500,
    { mediaTime: 10.42 + (34500 - 33000) / 1000, expectedDisplayTime: 34500, presentedFrames: 186 },
    { target: 10.3 + (34500 - 33000) / 1000, context: syncKey },
  );
  await ctx.synchronize(); // 1000ms sustained negative drift
  assert.equal(ctx.sync.control.source, 'presentation');
  assert.equal(ctx.video.playbackRate, 0.98, 'steers playbackRate to slow down from ahead presentation error');

  // Presentation error cannot independently trigger hard seeks or jumps
  // Small position difference (0.05s) with large presentation error (-800ms)
  ctx.video.currentTime = 10.25;
  ctx.presentationTiming.frame(
    35000,
    { mediaTime: 9.5, expectedDisplayTime: 35000, presentedFrames: 190 },
    { target: 10.3, context: syncKey },
  );
  now = 35000;
  await ctx.synchronize();
  assert.equal(ctx.video.currentTime, 10.25, 'presentation error cannot trigger hard seek');

  ctx.syncCorrectionMode = 'jumps';
  jumps.committed({ now: 35500, frames: 10, target: 5, context: ':::fixture:' });
  jumps.update({
    now: 39000,
    error: 0.3,
    eligible: true,
    context: ':::fixture:',
    buffered: true,
    settled: true,
    frames: 15,
    position: 10,
    uncertaintyMs: 12,
    stabilityMs: 12,
  });
  jumps.committed({ now: 70000, frames: 20, target: 5, context: ':::fixture:' });
  jumps.update({
    now: 73500,
    error: 0.3,
    eligible: true,
    context: ':::fixture:',
    buffered: true,
    settled: true,
    frames: 25,
    position: 10,
    uncertaintyMs: 12,
    stabilityMs: 12,
  });
  assert.equal(jumps.suspended(), true);
  ctx.video.currentTime = 10;
  now = 74000;
  await ctx.synchronize();
  now = 74500;
  await ctx.synchronize();
  now = 75000;
  await ctx.synchronize();
  assert.equal(ctx.video.playbackRate, 1.04, 'suspended jump mode falls back to speed correction');

  assert.equal(typeof ctx.sync.driftCorrection?.update, 'function');
  const custom = {
    updated: 0,
    policy: 'custom',
    update() {
      this.updated++;
      return 1.04;
    },
    reset() {},
  };
  ctx.sync.driftCorrection = custom;
  assert.equal(ctx.sync.driftCorrection.policy, 'custom');
  ctx.syncCorrectionMode = 'speed';
  now = 75000;
  await ctx.synchronize();
  assert.equal(custom.updated, 1);
  assert.equal(ctx.video.playbackRate, 1.04, 'swapped driftCorrection controller drives rate adjustment');
  ctx.sync.driftCorrection = undefined;
  assert.equal(
    typeof ctx.sync.driftCorrection?.update,
    'function',
    'clearing driftCorrection restores default controller',
  );
});
