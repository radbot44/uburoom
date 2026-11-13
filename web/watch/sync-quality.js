import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomSyncQuality from '../../shared/sync/quality.mjs';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { store } from './store.js';

/* Sync quality this viewer measures and reports: when a sample counts, presentation or position error, buffering time, and the periodic report with this player's health. */
export function mount(host, deps) {
  // What hosts see on this viewer's health card; the shared sync core validates it.
  function viewerHealth() {
    const errorCode = deps.video.error?.code,
      round = value => Math.round(value * 10) / 10;
    const error =
      store.stream.hlsNetworkFailure || errorCode === 2
        ? 'network'
        : errorCode === 3
          ? 'decode'
          : errorCode === 4
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
            bufferAhead: round(
              Math.min(3600, uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime)),
            ),
          }
        : {}),
      ...(/^[a-z0-9.]{1,24}$/i.test(store.room.state?.quality || '')
        ? {
            quality: store.room.state.fallbackActive
              ? store.room.state.fallbackStream.quality
              : store.room.state.quality,
          }
        : {}),
      ...(['hls', 'file', 'av1', 'vp9', 'vp8'].includes(store.room.state?.format)
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
    store.room.seekPendingRevision = undefined;
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
    const shared = store.room.state?.state;
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
      !deps.video.paused &&
      !deps.video.seeking &&
      (!store.player.playerWaiting || allowWaiting) &&
      !store.stream.probing &&
      !store.player.playbackError &&
      !deps.video.error &&
      !store.player.autoplayBlocked &&
      store.stream.readyVersion === store.room.state.mediaVersion &&
      (forBuffer || deps.video.readyState >= 3) &&
      document.visibilityState === 'visible' &&
      syncQualityClockUsable(timing) &&
      !(Number.isFinite(store.room.state.startAt) && timing.serverTime < store.room.state.startAt)
    );
  }
  function syncQualityBufferEligible(timing, at = deps.time.mono()) {
    return !!(
      store.room.state?.mediaUrl &&
      store.room.state.state &&
      !store.room.state.state.paused &&
      !store.room.state.waitingForReady &&
      !deps.video.paused &&
      !deps.video.ended &&
      !deps.video.seeking &&
      !store.stream.probing &&
      !store.player.playbackError &&
      !deps.video.error &&
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
    const presentationSample = deps.time.presentation.read?.(at, {
      context: store.player.sync?.contextKey(),
      clockRevision: timing.clockRevision,
    });
    const presentationInterrupted = Boolean(
      presentationSample?.interrupted ||
      (presentationSample?.reason && !['fresh', 'stale'].includes(presentationSample.reason)),
    );
    const presentationFresh =
      !presentationInterrupted &&
      Number.isFinite(presentationSample?.errorMs) &&
      presentationSample.ageMs !== undefined &&
      presentationSample.ageMs <= 2500;
    let errorMs,
      source = 'position';
    if (presentationFresh) {
      errorMs = presentationSample.errorMs;
      source = 'presentation';
    } else if (eligible) {
      const target = uburoomTiming.target(store.room.state, timing.serverTime);
      if (Number.isFinite(target)) errorMs = (deps.video.currentTime - target) * 1000;
    }
    if (Number.isFinite(errorMs)) store.player.lastSyncErrorMs = errorMs;
    deps.syncQuality.sample({
      at,
      errorMs,
      playbackRate: deps.video.playbackRate,
      eligible,
      source,
      context,
      clockRevision: timing.clockRevision,
    });
  }
  function refreshSyncQuality() {
    const timing = deps.time.clock.read(),
      at = deps.time.mono();
    const clockReliable = syncQualityClockUsable(timing);
    if (!clockReliable) deps.syncQuality.breakSample(at);
    const isBuffering = store.player.playerWaiting || (!deps.video.paused && deps.video.readyState < 3);
    const shouldCountBuffer = isBuffering && syncQualityBufferEligible(timing, at);
    if (shouldCountBuffer && !store.player.syncQualityBuffering)
      store.player.syncQualityBuffering = deps.syncQuality.startBuffer({ at, eligible: true });
    else if (!shouldCountBuffer && store.player.syncQualityBuffering) {
      deps.syncQuality.endBuffer({ at });
      store.player.syncQualityBuffering = false;
    }
    const playbackStatus =
      store.player.playbackError || deps.video.error
        ? 'error'
        : !store.room.state?.mediaUrl ||
            store.room.state.waitingForReady ||
            store.stream.probing ||
            store.stream.readyVersion !== store.room.state?.mediaVersion
          ? 'starting'
          : store.room.state.state.paused || deps.video.paused || deps.video.ended
            ? 'paused'
            : deps.video.seeking
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
