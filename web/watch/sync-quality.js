import * as uburoomSyncQuality from '../../shared/sync/quality.mjs';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { store } from './store.js';

/* Sync quality this viewer measures and reports: when a sample counts, presentation or position error, buffering time, and the periodic report with this player's health. */
export function mount(host, deps) {
  // What hosts see on this viewer's health card; the shared sync core validates it.
  function viewerHealth() {
    const active = deps.activePlayer,
      ytError = deps.youtube?.errorCode() || 0,
      errorCode = ytError || deps.video.error?.code,
      round = value => Math.round(value * 10) / 10;
    const error =
      store.stream.hlsNetworkFailure || errorCode === 2
        ? 'network'
        : errorCode === 3
          ? 'decode'
          : errorCode === 4 || ytError
            ? 'media'
            : store.player.playbackError
              ? 'other'
              : undefined;
    return {
      ...(store.player.playbackHealth || {}),
      ...deps.viewerClient,
      reconnects: Math.min(10000, Math.max(0, (store.connection.transport?.connectionAttempt || 1) - 1)),
      ...(store.room.state?.mediaUrl
        ? {
            bufferAhead: round(Math.min(3600, active.bufferedAhead(active.currentTime()))),
          }
        : {}),
      ...(/^[a-z0-9.]{1,24}$/i.test(store.room.state?.quality || '')
        ? {
            quality: store.room.state.fallbackActive
              ? store.room.state.fallbackStream.quality
              : store.room.state.quality,
          }
        : {}),
      ...(['hls', 'file', 'av1', 'vp9', 'vp8', 'youtube-embed'].includes(store.room.state?.format)
        ? { format: store.room.state.format }
        : {}),
      ...(Number.isFinite(store.player.lastSyncErrorMs)
        ? { offsetMs: Math.round(Math.max(-86400000, Math.min(86400000, store.player.lastSyncErrorMs))) }
        : {}),
      ...(error ? { error } : {}),
    };
  }
  function sendSyncQuality(status, score, confidence, reason, measurementFreshnessMs) {
    if (!store.room.selected || !store.room.state?.mediaVersion || !store.room.state?.streamVersion) return false;
    const freshness = uburoomSyncQuality.reportableMeasurementFreshnessMs(measurementFreshnessMs);
    const value = {
      roomId: store.room.selected,
      viewerId: store.identity.viewerId,
      mediaVersion: store.room.state.mediaVersion,
      streamVersion: store.room.state.streamVersion,
      status,
      score: Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 1,
      confidence: ['confident', 'reduced', 'provisional'].includes(confidence) ? confidence : 'reduced',
      ...(freshness === undefined ? {} : { measurementFreshnessMs: freshness }),
      ...(reason ? { reason } : {}),
      health: viewerHealth(),
    };
    const sent = store.connection.transport?.quality(value) || false;
    if (sent) {
      store.player.publishedSyncQualityStatus = status;
      store.player.publishedSyncQualityConfidence = value.confidence;
      store.player.publishedSyncQualityReason = reason;
      store.player.lastSyncQualityPublishAt = deps.time.wall();
    }
    return sent;
  }
  function resetSyncQuality() {
    store.room.seekPendingValue = undefined;
    store.room.seekPendingUntil = 0;
    store.room.seekPendingToken = (store.room.seekPendingToken || 0) + 1;
    store.player.lastSyncErrorMs = undefined;
    const wasActive =
      store.player.publishedSyncQualityStatus === 'playing' || store.player.publishedSyncQualityStatus === 'buffering';
    deps.syncQuality.reset(undefined, { preserveLast: true });
    store.player.syncQualityContext = store.player.syncQualityClockRevision = undefined;
    store.player.syncQualityBuffering = false;
    deps.time.presentation.interrupt?.('stream');
    store.player.syncQualitySettleUntil = deps.time.mono() + 2000;
    if (wasActive)
      sendSyncQuality(
        'stale',
        deps.syncQuality.refresh({ playbackStatus: 'starting' }).score,
        'reduced',
        'stream-changed',
      );
  }
  function syncQualityClockUsable(timing) {
    return !!(
      timing?.valid &&
      Number.isFinite(timing.clockAgeMs) &&
      timing.clockAgeMs <= uburoomSyncQuality.MAX_CLOCK_AGE_MS &&
      Number.isFinite(timing.clockUncertaintyMs) &&
      timing.clockUncertaintyMs <= uburoomSyncQuality.MAX_CLOCK_UNCERTAINTY_MS
    );
  }
  function syncQualityEligible(timing, { allowWaiting = false, forBuffer = false } = {}) {
    const shared = store.room.state?.state,
      active = deps.activePlayer,
      hasError = Boolean(store.player.playbackError || deps.youtube?.errorCode() || deps.video.error);
    return !!(
      store.room.selected &&
      store.room.state?.id === store.room.selected &&
      store.room.state.mediaUrl &&
      store.room.state.streamVersion &&
      store.room.state.mediaVersion &&
      store.stream.mediaSource === store.room.state.mediaUrl &&
      shared &&
      !shared.paused &&
      !store.room.state.waitingForReady &&
      !active.paused() &&
      !active.seeking() &&
      !deps.youtube?.isAdPlaying() &&
      (!store.player.playerWaiting || allowWaiting) &&
      !store.stream.probing &&
      !hasError &&
      !store.player.autoplayBlocked &&
      store.stream.readyVersion === store.room.state.mediaVersion &&
      (forBuffer || active.readyState() >= 3) &&
      document.visibilityState === 'visible' &&
      syncQualityClockUsable(timing) &&
      !(Number.isFinite(store.room.state.startAt) && timing.serverTime < store.room.state.startAt)
    );
  }
  function syncQualityBufferEligible(timing, at = deps.time.mono()) {
    const active = deps.activePlayer,
      hasError = Boolean(store.player.playbackError || deps.youtube?.errorCode() || deps.video.error);
    return !!(
      store.room.state?.mediaUrl &&
      store.room.state.state &&
      !store.room.state.state.paused &&
      !store.room.state.waitingForReady &&
      !active.paused() &&
      !active.ended() &&
      !active.seeking() &&
      !deps.youtube?.isAdPlaying() &&
      !store.stream.probing &&
      !hasError &&
      !store.player.autoplayBlocked &&
      store.stream.readyVersion === store.room.state.mediaVersion &&
      document.visibilityState === 'visible' &&
      at - store.player.lastPresentationBreak >= 2000 &&
      at >= store.player.syncQualitySettleUntil &&
      !store.player.sync?.timelinePending &&
      (!Number.isFinite(store.room.state.startAt) || (timing?.valid && timing.serverTime >= store.room.state.startAt))
    );
  }
  function sampleSyncQuality(timing, at) {
    const context =
      store.room.selected +
      ':' +
      store.identity.viewerId +
      ':' +
      store.room.state?.mediaVersion +
      ':' +
      store.room.state?.streamVersion;
    if (store.player.syncQualityContext !== context) {
      deps.syncQuality.reset(context, { preserveLast: true });
      store.player.syncQualityContext = context;
      store.player.syncQualityClockRevision = timing.clockRevision;
      store.player.syncQualitySettleUntil = at + 2000;
    } else if (store.player.syncQualityClockRevision !== timing.clockRevision) {
      deps.syncQuality.breakSample(at);
      store.player.syncQualityClockRevision = timing.clockRevision;
      store.player.syncQualitySettleUntil = at + 2000;
    }
    const eligible =
      syncQualityEligible(timing) &&
      at - store.player.lastPresentationBreak >= 2000 &&
      at >= store.player.syncQualitySettleUntil &&
      !store.player.sync?.timelinePending;
    const target = uburoomTiming.target(store.room.state, timing.serverTime);
    const presentationSample = deps.time.presentation.read?.(at, {
      context: store.player.sync?.contextKey(),
      clockRevision: timing.clockRevision,
    });
    const signal = uburoomTiming.controlSignal({
      target,
      currentTime: deps.activePlayer.currentTime(),
      presentation: presentationSample,
      clockValid: syncQualityClockUsable(timing),
      visible: document.visibilityState === 'visible',
      eligible,
      maxAgeMs: 2500,
    });
    let errorMs,
      source = 'position';
    if (eligible && (signal.source === 'presentation' || signal.source === 'blend')) {
      errorMs = presentationSample.errorMs;
      source = 'presentation';
    } else if (eligible && Number.isFinite(target)) {
      const value = -signal.error * 1000;
      errorMs = value === 0 ? 0 : value;
    }
    store.player.lastSyncErrorMs = eligible && Number.isFinite(errorMs) ? errorMs : undefined;
    deps.syncQuality.sample({
      at,
      errorMs,
      playbackRate: deps.activePlayer.playbackRate(),
      eligible,
      source,
      context,
      clockRevision: timing.clockRevision,
    });
  }
  function refreshSyncQuality() {
    const timing = deps.time.clock.read(),
      at = deps.time.mono(),
      active = deps.activePlayer,
      hasError = Boolean(store.player.playbackError || deps.youtube?.errorCode() || deps.video.error);
    const clockReliable = syncQualityClockUsable(timing);
    if (!clockReliable) deps.syncQuality.breakSample(at);
    const isBuffering = store.player.playerWaiting || (!active.paused() && active.readyState() < 3);
    const shouldCountBuffer = isBuffering && syncQualityBufferEligible(timing, at);
    if (shouldCountBuffer && !store.player.syncQualityBuffering)
      store.player.syncQualityBuffering = deps.syncQuality.startBuffer({ at, eligible: true });
    else if (!shouldCountBuffer && store.player.syncQualityBuffering) {
      deps.syncQuality.endBuffer({ at });
      store.player.syncQualityBuffering = false;
    }
    const playbackStatus = hasError
      ? 'error'
      : !store.room.state?.mediaUrl ||
          store.room.state.waitingForReady ||
          store.stream.probing ||
          store.stream.readyVersion !== store.room.state?.mediaVersion
        ? 'starting'
        : store.room.state.state.paused || active.paused() || active.ended()
          ? 'paused'
          : active.seeking()
            ? 'seeking'
            : isBuffering
              ? 'buffering'
              : 'playing';
    sampleSyncQuality(timing, at);
    const result = deps.syncQuality.refresh({
      at,
      clockValid: timing.valid,
      clockAgeMs: timing.clockAgeMs,
      clockUncertaintyMs: timing.clockUncertaintyMs,
      playbackStatus,
    });
    const changed =
      result.status !== store.player.publishedSyncQualityStatus ||
      result.confidence !== store.player.publishedSyncQualityConfidence ||
      result.reason !== store.player.publishedSyncQualityReason;
    if (result.updated || changed || deps.time.wall() - store.player.lastQualityDiagnosticAt >= 10000) {
      deps.diagnostics.record('sync-quality', {
        qualityStatus: result.status,
        qualityConfidence: result.confidence,
        qualityReason: result.reason,
        rawQualityScore: result.rawScore,
        smoothedQualityScore: result.lastScore,
        lastKnownQualityLevel: result.lastLevel,
        qualityMeasurementFreshnessMs: result.metrics?.measurementFreshnessMs,
        qualityMeasurementSource: result.metrics?.latestSource,
        qualitySampleCount: result.metrics?.sampleCount,
        measuredPlaybackSeconds: result.metrics?.measuredSeconds,
        outOfSync50Seconds: result.metrics?.outOfSync50Seconds,
        outOfSync100Seconds: result.metrics?.outOfSync100Seconds,
        outOfSync250Seconds: result.metrics?.outOfSync250Seconds,
        outOfSync500Seconds: result.metrics?.outOfSync500Seconds,
        automaticCorrectionCount: result.metrics?.automaticCorrectionCount,
        automaticCorrectionMagnitudeMs: result.metrics?.automaticCorrectionMagnitudeMs,
        correctionDutyCycle: result.metrics?.correctionDutyCycle,
        rateAdjustedSeconds: result.metrics?.rateAdjustedSeconds,
        rateAdjustmentSeconds: result.metrics?.rateAdjustmentSeconds,
        presentationMeasuredSeconds: result.metrics?.presentationMeasuredSeconds,
        positionMeasuredSeconds: result.metrics?.positionMeasuredSeconds,
        bufferingSeconds: result.metrics?.bufferingSeconds,
        clockValid: timing.valid,
        clockAgeMs: timing.clockAgeMs,
        clockUncertaintyMs: timing.clockUncertaintyMs,
      });
      store.player.lastQualityDiagnosticAt = deps.time.wall();
    }
    if (result.updated || changed || deps.time.wall() - store.player.lastSyncQualityPublishAt >= 5000)
      sendSyncQuality(
        result.status,
        result.score,
        result.confidence,
        result.reason,
        result.metrics?.measurementFreshnessMs,
      );
  }
  deps.every(1000, refreshSyncQuality);
  return { refreshSyncQuality, resetSyncQuality, sampleSyncQuality };
}
