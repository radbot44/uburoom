'use strict';
const { install } = require('./helpers/watch-sync');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const playback = require('../web/playback-policy');
const { create: diagnosticLog } = require('../web/playback-diagnostics');
const source = fs.readFileSync(path.join(__dirname, '../web/watch.js'), 'utf8');

async function load(context, name, next) {
  if (!context.sync) {
    const notify = context.synchronize;
    await install(context);
    if (notify) context.sync.synchronize = notify;
  }
  context.qualityPending ??= false;
  context.hlsTimelinePending ??= false;
  context.diagnostics ??= diagnosticLog();
  context.uburoomPlayback ??= playback;
  context.diagnosticSample ??= (event, fields) => context.diagnostics.record(event, fields);
  if (context.Hls) context.Hls.ErrorDetails ??= {};
  vm.runInNewContext(
    source.slice(source.indexOf('function ' + name + '('), source.indexOf('function ' + next + '(')),
    context,
  );
}

async function alignmentFixture() {
  let now = 0,
    target = 65,
    position = 0,
    seeks = 0,
    ranges = [];
  const timing = require('../web/playback-timing');
  const ctx = {
    state: {
      mediaUrl: '/current',
      format: 'hls',
      mediaVersion: 'media',
      streamVersion: 'stream',
      state: { duration: 120, paused: false, volume: 50, muted: false },
    },
    selected: 'room',
    mediaSource: '/current',
    expected: () => target,
    startKey: () => 'current',
    probing: false,
    playbackError: '',
    hlsNetworkFailure: undefined,
    hlsPreparationUntil: 0,
    hlsTimelinePending: false,
    syncSeekPending: false,
    playerWaiting: true,
    autoplayBlocked: false,
    performance: { now: () => now },
    document: { visibilityState: 'visible' },
    playbackClock: { read: () => ({ valid: true }) },
    syncCorrectionMode: 'speed',
    pauseAlarm: { cancel() {} },
    driftCorrection: timing.correction(),
    presentationTiming: timing.presentation(),
    uburoomPlayback: playback,
    video: {
      readyState: 2,
      paused: false,
      seeking: false,
      playbackRate: 1,
      buffered: {
        get length() {
          return ranges.length;
        },
        start: i => ranges[i][0],
        end: i => ranges[i][1],
      },
      pause() {
        this.paused = true;
      },
      async play() {
        this.paused = false;
      },
    },
    diagnosticSample() {},
    renderTransport() {},
    checkVideoFrames() {},
  };
  Object.defineProperty(ctx.video, 'currentTime', {
    get: () => position,
    set: value => {
      position = value;
      seeks++;
    },
  });
  ctx.resetDriftCorrection = () => {
    ctx.driftCorrection.reset();
    ctx.video.playbackRate = 1;
  };
  await install(ctx);
  return {
    ctx,
    set: values => {
      now = values.now ?? now;
      target = values.target ?? target;
      position = values.position ?? position;
      ranges = values.ranges ?? ranges;
    },
    seeks: () => seeks,
  };
}

test('an unbuffered alignment waits for refill instead of repeatedly cancelling the moving target', async () => {
  const f = await alignmentFixture();
  await f.ctx.synchronize();
  assert.equal(f.seeks(), 1);
  for (let i = 1; i <= 8; i++) {
    f.set({ now: i * 500, target: 65 + i * 0.5 });
    await f.ctx.synchronize();
  }
  assert.equal(f.seeks(), 1, 'no repeated out-of-buffer seek while waiting');
  f.ctx.playerWaiting = false;
  f.ctx.video.readyState = 4;
  f.set({ ranges: [[64, 72]] });
  await f.ctx.synchronize();
  assert.equal(f.seeks(), 2, 'buffered recovery can catch up');
  f.set({ position: 69.3, target: 69.3 });
  await f.ctx.synchronize();
  assert.equal(f.ctx.syncSeekPending, false, 'advancing aligned playback releases the guard');
  f.ctx.syncSeekPending = false;
  f.set({ target: 90 });
  await f.ctx.synchronize();
  assert.equal(f.seeks(), 3, 'a superseding shared seek can align outside the old buffer');
});

test('new HLS playback fills ahead locally with a bounded wait and preserves shared play intent', async () => {
  const f = await alignmentFixture();
  f.ctx.hlsPreparationUntil = 10000;
  f.ctx.video.paused = true;
  f.ctx.video.readyState = 3;
  f.ctx.playerWaiting = false;
  f.set({ position: 65, target: 67, ranges: [[65, 68]], now: 1000 });
  await f.ctx.synchronize();
  assert.equal(f.seeks(), 0);
  assert.equal(f.ctx.video.paused, true);
  assert.equal(f.ctx.state.state.paused, false);
  f.set({ target: 68, ranges: [[65, 72]], now: 2000 });
  await f.ctx.synchronize();
  assert.equal(f.ctx.hlsPreparationUntil, 0);
  assert.equal(f.ctx.video.paused, false);
  assert.equal(f.ctx.video.currentTime, 68);
  f.ctx.syncSeekPending = false;
  f.ctx.hlsPreparationUntil = 10000;
  f.ctx.video.paused = true;
  f.set({ now: 10001, target: 75, ranges: [] });
  await f.ctx.synchronize();
  assert.equal(f.ctx.hlsPreparationUntil, 0, 'normal bounded recovery resumes after the preparation limit');
});

test('HLS timestamp origin anchors once, guards pending sync, loads room target, and retries segment zero on failure', async () => {
  // 1. Pending origin blocks seek/play and exposes failures
  const align = await alignmentFixture();
  align.ctx.hlsTimelinePending = true;
  align.ctx.video.readyState = 4;
  align.ctx.playerWaiting = false;
  align.set({ position: 0, target: 95, ranges: [[0, 1]] });
  await align.ctx.synchronize();
  assert.equal(align.seeks(), 0);
  assert.equal(align.ctx.video.paused, true);
  let errorMsg;
  align.ctx.fail = message => {
    errorMsg = message;
  };
  align.ctx.hlsNetworkFailure = 'Connection failed';
  await align.ctx.synchronize();
  assert.equal(errorMsg, 'Connection failed', 'anchoring failures remain visible');

  // 2. Anchoring once and loading room target
  let resumed = 0;
  const loads = [],
    client = {
      startLoad: target => loads.push(target),
      resumeBuffering() {
        resumed++;
      },
    };
  let target = 65,
    synchronized = 0;
  const ctx = {
    hls: client,
    hlsTimelinePending: true,
    hlsPreparationUntil: 0,
    syncSeekPending: false,
    hlsRecoveryTimer: undefined,
    hlsNetworkFailure: undefined,
    state: { mediaUrl: '/current', state: { duration: 120 } },
    mediaSource: '/current',
    expected: () => target,
    performance: { now: () => 1000 },
    uburoomPlayback: playback,
    video: { currentTime: 0, buffered: { length: 1, start: () => 0, end: () => 1 } },
    clearTimeout() {},
    synchronize: () => {
      synchronized++;
    },
  };
  const notify = ctx.synchronize;
  await install(ctx);
  ctx.sync.synchronize = notify;
  await load(ctx, 'handleHlsFragmentBuffered', 'handleHlsError');
  ctx.handleHlsFragmentBuffered({});
  assert.equal(ctx.hlsTimelinePending, true, 'obsolete event cannot establish the new origin');
  target = 95;
  ctx.handleHlsFragmentBuffered(client);
  assert.equal(ctx.hlsTimelinePending, false);
  assert.equal(ctx.video.currentTime, 95);
  assert.deepEqual(loads, [95]);
  assert.equal(ctx.hlsPreparationUntil, 11000);
  assert.equal(synchronized, 1);
  target = 100;
  ctx.handleHlsFragmentBuffered(client);
  assert.deepEqual(loads, [95], 'ordinary fragments cannot anchor again');
  assert.equal(resumed, 1);
  ctx.hlsTimelinePending = true;
  ctx.video.currentTime = target = 0;
  ctx.handleHlsFragmentBuffered(client);
  assert.equal(resumed, 2, 'starting at zero must also resume ordinary fragment buffering');

  // 3. Network failure during pending anchor retries at 0; after anchor retries at shared position
  const timers = [],
    retryLoads = [],
    retryClient = { startLoad: t => retryLoads.push(t) };
  const errCtx = {
    hls: retryClient,
    Hls: { ErrorTypes: { NETWORK_ERROR: 'network' } },
    hlsTimelinePending: true,
    state: { mediaUrl: '/current', mediaVersion: 'media', streamVersion: 'stream', state: { duration: 120 } },
    mediaSource: '/current',
    selected: 'room',
    navigator: { onLine: true },
    performance: { now: () => 0 },
    receivedAt: 0,
    expected: () => 95,
    video: { readyState: 0, currentTime: 0 },
    hlsNetworkRetries: 0,
    hlsRecoveryTimer: undefined,
    hlsNetworkFailure: undefined,
    clearTimeout() {},
    setTimeout: callback => {
      timers.push(callback);
      return timers.length;
    },
  };
  await load(errCtx, 'handleHlsError', 'unavailable');
  errCtx.handleHlsError(retryClient, { fatal: true, type: 'network' });
  timers[0]();
  assert.deepEqual(retryLoads, [0]);
  errCtx.hlsTimelinePending = false;
  errCtx.handleHlsError(retryClient, { fatal: true, type: 'network' });
  timers[1]();
  assert.deepEqual(retryLoads, [0, 95]);
});

test('HLS retries stream with capped backoff, checks online/timeline state, retains buffered media, and ignores superseded timers', async () => {
  const timers = [],
    loads = [],
    client = {
      loads: 0,
      startLoad(t) {
        this.loads++;
        if (t !== undefined) loads.push(t);
      },
    };
  let now = 0,
    target = 12;
  const context = {
    hls: client,
    Hls: { ErrorTypes: { NETWORK_ERROR: 'network' } },
    state: { mediaUrl: '/current', mediaVersion: 'media', streamVersion: 'stream', state: { duration: 60 } },
    mediaSource: '/current',
    selected: 'room',
    navigator: { onLine: true },
    performance: { now: () => now },
    receivedAt: 0,
    expected: () => target,
    video: { readyState: 4, currentTime: 12 },
    hlsNetworkRetries: 0,
    hlsRecoveryTimer: undefined,
    hlsNetworkFailure: undefined,
    clearTimeout: () => {},
    setTimeout: (action, delay) => {
      timers.push({ action, delay });
      return timers.length;
    },
  };
  await load(context, 'handleHlsError', 'unavailable');

  // Initial backoff steps
  for (let i = 0; i < 4; i++) context.handleHlsError(client, { fatal: true, type: 'network' });
  assert.deepEqual(
    timers.map(t => t.delay),
    [1000, 2000, 4000, 15000],
  );
  assert.equal(context.hls, client, 'good MSE data stays attached after exhausted speculation');
  assert.match(context.hlsNetworkFailure, /connection/);
  timers[0].action();
  assert.equal(client.loads, 1);
  context.hls = undefined;
  timers[1].action();
  assert.equal(client.loads, 1, 'old stream cannot restart');

  // Online/offline and state guards during fatal recovery
  context.hls = client;
  context.hlsNetworkRetries = 3;
  loads.length = 0;
  const fatalIndex = timers.length;
  const fatal = () => context.handleHlsError(client, { fatal: true, type: 'network' });
  fatal();
  assert.equal(timers[fatalIndex].delay, 15000);
  context.navigator.onLine = false;
  timers[fatalIndex].action();
  assert.deepEqual(loads, [], 'offline cannot load');
  context.navigator.onLine = true;
  now = 4000;
  timers[fatalIndex + 1].action();
  assert.deepEqual(loads, [], 'stale authorization cannot load');
  context.receivedAt = now;
  target = 24;
  timers[fatalIndex + 2].action();
  assert.deepEqual(loads, [24], 'fresh authorization uses current position');
  assert.equal(context.video.currentTime, 24);

  // Backoff capping at 60s
  fatal();
  assert.equal(timers.at(-1).delay, 30000);
  timers.at(-1).action();
  fatal();
  assert.equal(timers.at(-1).delay, 60000);
  timers.at(-1).action();
  const count = timers.length;
  for (let i = 0; i < 10; i++) fatal();
  assert.equal(timers.length, count, 'persistent outage does not schedule unlimited attempts');
});

test('HLS delivery failure plays cached buffer, overrides backoff for outside-cache seeks, and clears error on fresh media', async () => {
  // 1. Cached playback during failure until buffer runs out
  let paused = false,
    message;
  const context = {
    state: { mediaUrl: '/current', state: { paused: false, volume: 50, muted: false } },
    probing: false,
    playbackError: '',
    video: {
      readyState: 4,
      currentTime: 12,
      paused: false,
      buffered: { length: 1, start: () => 0, end: () => 20 },
      pause: () => {
        paused = true;
      },
    },
    hlsPreparationUntil: 0,
    hlsTimelinePending: false,
    syncSeekPending: false,
    hlsNetworkFailure: 'Connection failed',
    expected: () => 12,
    uburoomPlayback: playback,
    playbackClock: { read: () => ({ valid: true }) },
    performance: { now: () => 0 },
    document: { visibilityState: 'visible' },
    syncCorrectionMode: 'speed',
    pauseAlarm: { cancel() {} },
    driftCorrection: require('../web/playback-timing').correction(),
    startKey: () => 'fixture',
    presentationTiming: require('../web/playback-timing').presentation(),
    playerWaiting: false,
    fail: value => {
      message = value;
    },
    renderTransport: () => {},
    checkVideoFrames: () => {},
  };
  await install(context);
  await context.synchronize();
  assert.equal(paused, false);
  assert.equal(context.playbackError, '');
  context.expected = () => 21;
  await context.synchronize();
  assert.equal(paused, true);
  assert.equal(message, 'Connection failed');

  // 2. Outside-cache seek supersedes backoff while cached rewind stays local
  const actions = [],
    seekClient = { stopLoad: () => actions.push('stop'), startLoad: time => actions.push(time) };
  const seekCtx = {
    hls: seekClient,
    hlsNetworkInterrupted: true,
    state: { mediaUrl: '/current' },
    mediaSource: '/current',
    video: { buffered: { length: 1, start: () => 10, end: () => 30 } },
    uburoomPlayback: playback,
    hlsRecoveryTimer: 1,
    hlsNetworkRetries: 3,
    hlsNetworkFailure: 'Connection failed',
    playbackError: 'Connection failed',
    clearTimeout: () => actions.push('cancel'),
  };
  await load(seekCtx, 'restartHlsForSeek', 'handleHlsError');
  seekCtx.restartHlsForSeek(20);
  assert.deepEqual(actions, [], 'cached rewind needs no network restart');
  seekCtx.restartHlsForSeek(80);
  assert.deepEqual(actions, ['cancel', 'stop', 80]);
  assert.equal(seekCtx.hls, seekClient);
  assert.equal(seekCtx.hlsNetworkRetries, 0);
  assert.equal(seekCtx.playbackError, '');

  // 3. Fresh media clears exhausted delivery error and resumes sync
  const freshClient = {},
    calls = [];
  const freshCtx = {
    hls: freshClient,
    hlsRecoveryTimer: 7,
    hlsNetworkRetries: 3,
    hlsNetworkFailure: 'Connection failed',
    hlsNetworkInterrupted: true,
    playbackError: 'Connection failed',
    state: { mediaUrl: '/current', state: { duration: 60 } },
    mediaSource: '/current',
    expected: () => 12,
    uburoomPlayback: playback,
    video: { buffered: { length: 1, start: () => 0, end: () => 5 } },
    clearTimeout: id => calls.push(['cancel', id]),
    fail: value => calls.push(['error', value]),
    synchronize: () => {
      calls.push(['synchronize']);
    },
  };
  await load(freshCtx, 'handleHlsFragmentBuffered', 'handleHlsError');
  freshCtx.video.buffered = { length: 1, start: () => 10, end: () => 20 };
  freshCtx.handleHlsFragmentBuffered(freshClient);
  assert.equal(freshCtx.playbackError, '');
  assert.equal(freshCtx.hlsNetworkFailure, undefined);
  assert.equal(freshCtx.hlsNetworkRetries, 0);
  assert.equal(freshCtx.hlsNetworkInterrupted, false);
  assert.deepEqual(calls, [['cancel', 7], ['error', ''], ['synchronize']]);
});

test('expired or dead HLS session bounds personal refresh rate, replaces stream when buffer runs low, and falls back to proxy', async () => {
  const timers = [],
    commands = [];
  let proxied = 0;
  const client = { startLoad() {}, stopLoad() {} };
  const context = {
    hls: client,
    Hls: { ErrorTypes: { NETWORK_ERROR: 'network' }, ErrorDetails: { MEDIA_SOURCE_REQUIRES_RESET: 'reset' } },
    state: { format: 'hls', mediaUrl: '/current', mediaVersion: 'media', streamVersion: 'stream' },
    mediaSource: '/current',
    selected: 'room',
    pending: false,
    hlsRefreshPending: false,
    hlsRefreshVersion: undefined,
    hlsRefreshTimes: [],
    video: { currentTime: 0, buffered: { length: 0 } },
    hlsNetworkRetries: 0,
    hlsRecoveryTimer: undefined,
    hlsNetworkFailure: undefined,
    proxyDirectFile: () => {
      proxied++;
    },
    execute: async command => {
      commands.push(command);
    },
    clearTimeout: () => {},
    setTimeout: (action, delay) => {
      timers.push({ action, delay });
      return timers.length;
    },
  };
  vm.runInNewContext(
    source.slice(source.indexOf('async function refreshHlsSession('), source.indexOf('function handleHlsError(')),
    context,
  );
  await load(context, 'handleHlsError', 'unavailable');

  context.handleHlsError(client, { fatal: true, type: 'network', response: { code: 410 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].action, 'media.stream.refresh');
  assert.equal(commands[0].args.streamVersion, 'stream');

  // Rate-limiting repeated expiry
  for (let i = 0; i < 4; i++) {
    context.handleHlsError(client, { fatal: true, type: 'network', response: { code: 410 } });
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.equal(commands.length, 3, 'repeated expiry cannot create unbounded loop');

  // Direct HLS fragment expiry falls back to proxy
  context.state = {
    format: 'hls',
    directHls: { origin: 'https://plex.example', session: 's', token: 't' },
    mediaUrl: '/current',
    mediaVersion: 'direct-media',
    streamVersion: 'direct-stream',
  };
  context.handleHlsError(client, { fatal: true, type: 'network', details: 'fragLoadError' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(commands.length, 4);
  assert.equal(proxied, 0);
  context.handleHlsError(client, { fatal: true, type: 'network', details: 'fragLoadError' });
  assert.equal(proxied, 1, 'repeated direct HLS failure falls back to proxy');

  // Buffer-based session replacement: high buffer retains stream, low buffer replaces it
  let ahead = 60;
  const deadCtx = {
    hls: client,
    state: { format: 'hls', mediaUrl: '/current', mediaVersion: 'media', streamVersion: 'stream' },
    mediaSource: '/current',
    selected: 'room',
    pending: false,
    qualityPending: false,
    hlsRefreshPending: false,
    hlsRefreshVersion: undefined,
    hlsRefreshTimes: [],
    video: { currentTime: 10, buffered: { length: 1, start: () => 0, end: () => 10 + ahead } },
    uburoomPlayback: playback,
    diagnosticSample() {},
    execute: async command => {
      commands.push(command);
    },
    clearTimeout() {},
    setTimeout: (action, delay) => {
      timers.push({ action, delay });
      return timers.length;
    },
  };
  vm.runInNewContext(
    source.slice(
      source.indexOf('async function refreshHlsSession('),
      source.indexOf('function handleHlsFragmentBuffered('),
    ),
    deadCtx,
  );
  await deadCtx.refreshHlsSession(client);
  assert.equal(commands.length, 4, 'plenty of buffer keeps the stream attached');
  ahead = 5;
  client.refreshRetryTimer = undefined;
  await timers.at(-1).action();
  assert.equal(commands.length, 5, 'a low buffer replaces the dead session');
});

test('brief WebSocket disconnect does not tear down player, and extended disconnect plays from buffer with toast', async () => {
  const timers = [];
  let cleared = 0,
    stoppedLoad = 0,
    failedMessage = '',
    qualityResets = 0;
  const client = {
    stopLoad() {
      stoppedLoad++;
    },
    startLoad() {},
  };
  const toast = { hidden: true };
  const elements = {
    'disconnect-toast': toast,
    'empty-title': { textContent: '' },
    'empty-hint': { textContent: '' },
    badge: { classList: { remove() {} } },
  };
  const $ = id => elements[id];
  const context = {
    $: $,
    toasts: {
      show() {
        toast.hidden = false;
      },
      dismiss() {
        toast.hidden = true;
      },
    },
    uburoomPlayback: playback,
    diagnostics: diagnosticLog(),
    transport: { ready: false, interrupt() {} },
    reconnecting: false,
    stateRequestSequence: 0,
    stateTransportSequence: 0,
    playbackClock: { reset() {} },
    queueUI: { rememberPosition() {} },
    resetSyncQuality() {
      qualityResets++;
    },
    renderTransport() {},
    renderBrowsing() {},
    renderVisibility() {},
    document: { title: 'Room · uburoom' },
    selected: 'room-1',
    state: { reachable: true, mediaUrl: '/media' },
    video: {
      currentTime: 10,
      buffered: { length: 1, start: () => 0, end: () => 30 },
    },
    hls: client,
    clearPlayer: () => {
      cleared++;
    },
    fail: msg => {
      failedMessage = msg;
    },
    clearTimeout: id => {
      const idx = timers.findIndex(t => t.id === id);
      if (idx !== -1) timers.splice(idx, 1);
    },
    setTimeout: (fn, delay) => {
      const id = timers.length + 1;
      timers.push({ id, fn, delay });
      return id;
    },
    disconnectGraceTimer: undefined,
    disconnectExtended: false,
    DISCONNECT_GRACE_MS: 8000,
  };

  const code = source.slice(source.indexOf('function connectionLost('), source.indexOf('async function unlockLocal('));
  vm.runInNewContext(code, context);

  // 1. connectionLost arms grace timer without tearing down player
  context.connectionLost({ code: 1006 });
  assert.equal(context.reconnecting, true);
  assert.equal(qualityResets, 1, 'disconnect invalidates local quality window');
  assert.equal(cleared, 0, 'player is not cleared immediately');
  assert.equal(toast.hidden, true, 'toast is not shown during silent grace period');
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 8000);

  // 2. Fast reconnect clears timer
  context.clearTimeout(timers[0].id);
  assert.equal(cleared, 0);

  // 3. Extended disconnect plays from buffer and shows toast
  timers.length = 0;
  context.reconnecting = false;
  context.connectionLost({ code: 1006 });
  assert.equal(qualityResets, 2);
  timers[0].fn();
  assert.equal(context.disconnectExtended, true);
  assert.equal(stoppedLoad, 1, 'hls.stopLoad is called to preserve buffer');
  assert.equal(toast.hidden, false, 'toast shown after grace period');
  assert.equal(cleared, 0);

  // 4. Buffer exhausted: full player clear
  context.fullPlayerClear();
  assert.equal(context.disconnectExtended, false);
  assert.equal(toast.hidden, true);
  assert.equal(cleared, 1);
  assert.equal(failedMessage, 'Disconnected. Reconnecting…');
});

test('HLS media recovery refills after quiet period, classifies quota/append errors, and reaches compatible fallback on repeats', async () => {
  let now = 0;
  const recovered = [],
    fallbacks = [],
    client = {
      config: playback.hlsConfig(40000),
      recoverMediaError() {
        recovered.push(now);
      },
      startLoad() {},
    };
  const details = { MEDIA_SOURCE_REQUIRES_RESET: 'reset', BUFFER_FULL_ERROR: 'full', BUFFER_APPEND_ERROR: 'append' };
  const context = {
    hls: client,
    Hls: { ErrorTypes: { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' }, ErrorDetails: details },
    hlsRecoveryCount: 0,
    hlsRecoveryAt: 0,
    hlsRecoveryTimer: undefined,
    video: {},
    state: { mediaUrl: '/current' },
    mediaSource: '/current',
    sync: { timelinePending: false },
    expected: () => 12,
    performance: { now: () => now },
    clearTimeout() {},
    setTimeout: action => {
      action();
      return 1;
    },
    compatibleFallback: async reason => {
      fallbacks.push(reason);
    },
  };
  await load(context, 'handleHlsError', 'unavailable');

  // Recovery retry and quiet period reset
  const failure = { fatal: true, type: 'media', details: 'bufferAppendError' };
  context.handleHlsError(client, failure);
  now = 3600000;
  context.handleHlsError(client, failure);
  assert.deepEqual(recovered, [0, 3600000], 'an unrelated failure an hour later retries the same stream');
  assert.equal(fallbacks.length, 0);
  now += 1000;
  context.handleHlsError(client, failure);
  assert.equal(recovered.length, 2);
  assert.equal(fallbacks.length, 1, 'repeat failure inside window triggers fallback');

  // Quota and append error classifications
  for (const error of [
    { details: 'full', error: { name: 'QuotaExceededError' }, type: 'media' },
    { details: 'full', error: { code: 22 }, type: 'media' },
    { details: 'full', type: 'media' },
    { details: 'append', error: { name: 'InvalidStateError' }, type: 'media' },
    { details: 'fragLoadError', type: 'network' },
  ])
    context.handleHlsError(client, { fatal: false, ...error });
  const rows = context.diagnostics
    .snapshot()
    .entries.filter(r => r.event === 'hls-error')
    .slice(-5);
  assert.deepEqual(
    rows.map(r => r.detail),
    ['quota-exceeded', 'quota-exceeded', 'buffer-full', 'buffer-append', 'fragment'],
  );
  assert.equal(rows[4].category, 'network');
});
