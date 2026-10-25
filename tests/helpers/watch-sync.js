'use strict';
const timing = require('../../web/playback-timing');
const playback = require('../../web/playback-policy');
async function install(context) {
  const { createSync } = await import('../../web/watch-sync.mjs');
  const until = context.hlsPreparationUntil || 0, timeline = context.hlsTimelinePending || false;
  const noop = () => {};
  const sync = createSync({ video: context.video, timing, playback,
    read: () => context.startKey && context.state ? { ...context, state: { ...context.state, epoch: context.startKey() } } : context,
    clock: context.playbackClock || { read: () => ({ valid: true }), reset: noop },
    presentation: context.presentationTiming || timing.presentation(),
    driftCorrection: context.driftCorrection, jumpDriftCorrection: context.jumpDriftCorrection,
    startAlarm: context.startAlarm || { arm: noop, cancel: noop }, pauseAlarm: context.pauseAlarm || { arm: noop, cancel: noop },
    expected: () => context.expected?.() || 0, decodedFrames: () => context.decodedFrames?.() || 0,
    unlockLocal: () => context.unlockLocal?.(), reportReadiness: () => context.reportReadiness?.(),
    render: () => context.renderTransport?.(), checkFrames: () => context.checkVideoFrames?.(), sample: (...args) => context.diagnosticSample?.(...args),
    error: message => { context.playbackError = message; context.fail?.(message); },
    playing: (version, blocked) => { if (version !== undefined) context.readyVersion = version; context.autoplayBlocked = blocked; },
    now: () => context.performance?.now() || 0, visibility: () => context.document?.visibilityState || (context.document?.hidden ? 'hidden' : 'visible'),
    online: () => context.navigator?.onLine !== false, repeat: context.repeat || (() => 0), cancelRepeat: context.cancelRepeat || noop });
  sync.prepare({ until, timeline });
  Object.defineProperties(context, {
    hlsPreparationUntil: { configurable: true, get: () => sync.preparationUntil, set: value => sync.prepare({ until: value }) },
    hlsTimelinePending: { configurable: true, get: () => sync.timelinePending, set: value => sync.prepare({ timeline: value }) },
    syncSeekPending: { configurable: true, get: () => sync.seekPending, set: value => { if (value) throw new Error('Use an actual alignment'); sync.sharedSeek(); } }
  });
  context.sync = sync;
  context.synchronize = sync.synchronize;
  return sync;
}
module.exports = { install };
