// @ts-check
/* Playback synchronization quality scoring, message validation, viewer state reduction,
 * and room participant aggregation. Independent of Plex, Discord, or media transport.
 */

export function createQualityApi() {
  const WINDOW_MS = 60000, SAMPLE_INTERVAL_MS = 1000, INTERVAL_SLOTS = 64, BUFFER_SLOTS = 32, CORRECTION_SLOTS = 64;
  const MAX_CLOCK_AGE_MS = 5000, MAX_CLOCK_UNCERTAINTY_MS = 1000;
  const RECENT_EVIDENCE_MS = 12000, PAUSED_EVIDENCE_MS = 120000;
  // Omit over-age evidence from reports to older servers that reject it with socket code 4002.
  const MAX_REPORT_FRESHNESS_MS = 300000;
  const REFRESH_INTERVAL_MS = 5000, STALE_AFTER_MS = 15000;
  const DEFAULT_UUID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

  const QUALITY_STATUSES = Object.freeze([
    'playing', 'buffering', 'paused', 'seeking', 'starting', 'stale', 'unknown', 'error'
  ]);
  const QUALITY_REASONS = Object.freeze([
    'clock-unavailable', 'clock-stale', 'clock-low-confidence', 'insufficient-clock-samples', 'insufficient-sync-samples',
    'measurement-stale', 'measurement-expired', 'invalid-measurements', 'invalid-measurement-time', 'playback-error', 'paused', 'seeking', 'starting',
    'stream-changed', 'media-changed', 'room-changed', 'no-sessions', 'awaiting-sync-interval', 'awaiting-measurements',
    'position-timing-estimate', 'clock-warmup', 'measurement-interrupted'
  ]);
  const QUALITY_CONFIDENCES = Object.freeze(['confident', 'reduced', 'provisional']);

  const statusSet = new Set(QUALITY_STATUSES);
  const reasonSet = new Set(QUALITY_REASONS);
  const confidenceSet = new Set(QUALITY_CONFIDENCES);
  const finite = Number.isFinite;

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  function reportableMeasurementFreshnessMs(age) {
    return finite(age) && age >= 0 && age <= MAX_REPORT_FRESHNESS_MS ? age : undefined;
  }

  function level(score, previous) {
    if (!finite(score) || score < 0 || score > 1) return undefined;
    if (previous === 'excellent') return score >= .87 ? 'excellent' : score >= .72 ? 'good' : score >= .47 ? 'fair' : 'poor';
    if (previous === 'good') return score >= .93 ? 'excellent' : score >= .72 ? 'good' : score >= .47 ? 'fair' : 'poor';
    if (previous === 'fair') return score >= .93 ? 'excellent' : score >= .78 ? 'good' : score >= .47 ? 'fair' : 'poor';
    if (previous === 'poor') return score >= .93 ? 'excellent' : score >= .78 ? 'good' : score >= .53 ? 'fair' : 'poor';
    return score >= .90 ? 'excellent' : score >= .75 ? 'good' : score >= .50 ? 'fair' : 'poor';
  }

  function calculate({
    measuredSeconds,
    outOfSync250Seconds,
    outOfSync500Seconds,
    automaticCorrectionCount,
    automaticCorrectionMagnitudeMs,
    rateAdjustedSeconds,
    rateAdjustmentSeconds,
    bufferingSeconds
  } = {}) {
    if (!finite(measuredSeconds) || measuredSeconds <= 0 || !finite(outOfSync250Seconds) || outOfSync250Seconds < 0 ||
        !finite(outOfSync500Seconds) || outOfSync500Seconds < 0 || !finite(automaticCorrectionCount) || automaticCorrectionCount < 0 ||
        !finite(automaticCorrectionMagnitudeMs) || automaticCorrectionMagnitudeMs < 0 || !finite(rateAdjustedSeconds) || rateAdjustedSeconds < 0 ||
        !finite(rateAdjustmentSeconds) || rateAdjustmentSeconds < 0 || !finite(bufferingSeconds) || bufferingSeconds < 0) return undefined;
    const out250 = clamp(outOfSync250Seconds / measuredSeconds, 0, 1);
    const out500 = clamp(outOfSync500Seconds / measuredSeconds, 0, 1);
    const rateDuty = clamp(rateAdjustedSeconds / measuredSeconds, 0, 1);
    const penalty = out250 + 2 * out500 + .03 * automaticCorrectionCount + .00004 * automaticCorrectionMagnitudeMs +
      1.4 * rateDuty + .15 * rateAdjustmentSeconds + 2.5 * (bufferingSeconds / 60);
    const score = Math.exp(-penalty);
    return finite(score) ? clamp(score, 0, 1) : undefined;
  }

  function create({ now = () => performance.now() } = {}) {
    const intervals = Array.from({ length: INTERVAL_SLOTS }, () => ({ start: 0, end: 0, errorMs: 0, playbackRate: 1, source: 'presentation' }));
    const buffers = Array.from({ length: BUFFER_SLOTS }, () => ({ start: 0, end: 0 }));
    const corrections = Array.from({ length: CORRECTION_SLOTS }, () => ({ at: 0, magnitudeMs: 0 }));
    let intervalCount = 0, bufferCount = 0, correctionCount = 0;
    let context, clockRevision, previousPoint, latestSource, bufferStart, lastCalculatedAt, lastValidAt, lastActivityAt, lastRawScore;
    let smoothedScore = 1, smoothedLevel = 'excellent', hasMeasuredScore = false;

    function clearWindow() {
      intervalCount = bufferCount = correctionCount = 0;
      previousPoint = latestSource = bufferStart = lastCalculatedAt = lastRawScore = undefined;
    }

    function reset(nextContext, { preserveLast = true } = {}) {
      if (!preserveLast) { smoothedScore = 1; smoothedLevel = 'excellent'; lastValidAt = undefined; hasMeasuredScore = false; }
      context = nextContext; clockRevision = undefined; lastActivityAt = undefined; clearWindow();
    }

    function sample({ at = now(), errorMs, playbackRate = 1, eligible, source = 'presentation', context: nextContext, clockRevision: nextRevision } = {}) {
      if (context !== nextContext) reset(nextContext);
      if (!finite(at)) return false;
      if (clockRevision !== nextRevision) { clockRevision = nextRevision; clearWindow(); }
      if (!eligible || !finite(errorMs) || !finite(playbackRate) || playbackRate <= 0) { previousPoint = undefined; return false; }
      if (previousPoint && at < previousPoint.at) { previousPoint = undefined; return false; }
      if (previousPoint && at - previousPoint.at < SAMPLE_INTERVAL_MS - 50) return false;
      if (previousPoint && at - previousPoint.at <= 2500) {
        const slot = intervals[intervalCount++ % INTERVAL_SLOTS];
        slot.start = previousPoint.at; slot.end = at; slot.errorMs = previousPoint.errorMs;
        slot.playbackRate = previousPoint.playbackRate; slot.source = previousPoint.source;
      }
      latestSource = source === 'position' ? 'position' : 'presentation';
      previousPoint = { at, errorMs: Math.abs(errorMs), playbackRate, source: latestSource };
      lastActivityAt = at; return true;
    }

    function breakSample(at = now()) {
      previousPoint = undefined;
      if (finite(at) && bufferStart !== undefined && at < bufferStart) bufferStart = undefined;
    }

    function startBuffer({ at = now(), eligible = false } = {}) {
      if (!eligible || !finite(at)) return false;
      if (bufferStart === undefined) bufferStart = at;
      return true;
    }

    function endBuffer({ at = now() } = {}) {
      if (bufferStart === undefined) return false;
      if (!finite(at) || at < bufferStart) { bufferStart = undefined; return false; }
      const slot = buffers[bufferCount++ % BUFFER_SLOTS];
      slot.start = bufferStart; slot.end = at; bufferStart = undefined; return true;
    }

    function recordCorrection({ at = now(), magnitudeMs, kind = 'seek' } = {}) {
      if (!finite(at) || !finite(magnitudeMs) || magnitudeMs < 0 || (kind !== 'seek' && kind !== 'jump')) return false;
      const slot = corrections[correctionCount++ % CORRECTION_SLOTS];
      slot.at = at; slot.magnitudeMs = magnitudeMs; return true;
    }

    function metricsAt(at) {
      const cutoff = at - WINDOW_MS;
      let measuredMs = 0, out250Ms = 0, out500Ms = 0, rateAdjustedMs = 0, rateAdjustmentMs = 0, bufferMs = 0, presentationMs = 0, positionMs = 0;
      let autoCount = 0, autoMagnitudeMs = 0, sampleCount = 0;
      const intervalLimit = Math.min(intervalCount, INTERVAL_SLOTS);
      for (let i = 0; i < intervalLimit; i++) {
        const slot = intervals[i], duration = Math.min(at, slot.end) - Math.max(cutoff, slot.start);
        if (!(duration > 0)) continue;
        sampleCount++; measuredMs += duration;
        if (slot.source === 'position') positionMs += duration; else presentationMs += duration;
        if (slot.errorMs > 250) out250Ms += duration;
        if (slot.errorMs > 500) out500Ms += duration;
        const rateDelta = Math.abs(slot.playbackRate - 1);
        if (rateDelta > .0005) { rateAdjustedMs += duration; rateAdjustmentMs += duration * rateDelta; }
      }
      if (previousPoint && previousPoint.at >= cutoff && previousPoint.at <= at) sampleCount++;
      const bufferLimit = Math.min(bufferCount, BUFFER_SLOTS);
      for (let i = 0; i < bufferLimit; i++) {
        const slot = buffers[i], duration = Math.min(at, slot.end) - Math.max(cutoff, slot.start);
        if (duration > 0) bufferMs += duration;
      }
      if (bufferStart !== undefined && at > bufferStart) bufferMs += Math.max(0, at - Math.max(cutoff, bufferStart));
      const correctionLimit = Math.min(correctionCount, CORRECTION_SLOTS);
      for (let i = 0; i < correctionLimit; i++) {
        const slot = corrections[i];
        if (slot.at >= cutoff && slot.at <= at) { autoCount++; autoMagnitudeMs += slot.magnitudeMs; }
      }
      return {
        measuredSeconds: measuredMs / 1000,
        presentationMeasuredSeconds: presentationMs / 1000,
        positionMeasuredSeconds: positionMs / 1000,
        outOfSync250Seconds: out250Ms / 1000,
        outOfSync500Seconds: out500Ms / 1000,
        automaticCorrectionCount: autoCount,
        automaticCorrectionMagnitudeMs: autoMagnitudeMs,
        rateAdjustedSeconds: rateAdjustedMs / 1000,
        correctionDutyCycle: measuredMs ? rateAdjustedMs / measuredMs : undefined,
        rateAdjustmentSeconds: rateAdjustmentMs / 1000,
        bufferingSeconds: bufferMs / 1000,
        measurementFreshnessMs: lastActivityAt === undefined ? undefined : Math.max(0, at - lastActivityAt),
        latestSource: sampleCount ? latestSource : undefined,
        sampleCount
      };
    }

    function report(status, reason, metrics, rawScore, updated = false, confidence) {
      return {
        status,
        reason,
        score: smoothedScore,
        level: smoothedLevel,
        lastScore: smoothedScore,
        lastLevel: smoothedLevel,
        confidence: confidence || (hasMeasuredScore ? 'reduced' : 'provisional'),
        rawScore,
        updated,
        lastValidAt,
        metrics
      };
    }

    function refresh({ at = now(), clockValid, clockAgeMs, clockUncertaintyMs, playbackStatus = 'unknown', unknownReason } = {}) {
      if (!finite(at)) return report(playbackStatus, 'invalid-measurement-time', undefined, undefined);
      const metrics = metricsAt(at), reduced = reason => report(playbackStatus, reason, metrics, undefined, false, hasMeasuredScore ? 'reduced' : 'provisional');
      const evidenceAge = lastActivityAt === undefined ? Infinity : Math.max(0, at - lastActivityAt);
      const retained = (reason, longPause = false) => hasMeasuredScore && evidenceAge <= (longPause ? PAUSED_EVIDENCE_MS : RECENT_EVIDENCE_MS)
        ? report(playbackStatus, reason, metrics, undefined, false, 'confident')
        : reduced(reason);
      if (playbackStatus === 'error') return reduced(unknownReason || 'playback-error');
      if (playbackStatus === 'paused') return retained(unknownReason || 'paused', true);
      if (playbackStatus === 'seeking') return retained(unknownReason || 'seeking');
      if (playbackStatus === 'starting') return reduced(unknownReason || 'starting');
      if (!clockValid) return retained(unknownReason || 'clock-unavailable');
      if (!finite(clockAgeMs) || clockAgeMs > MAX_CLOCK_AGE_MS) return retained(unknownReason || 'clock-stale');
      if (!finite(clockUncertaintyMs) || clockUncertaintyMs > MAX_CLOCK_UNCERTAINTY_MS) return retained(unknownReason || 'clock-low-confidence');
      const buffering = playbackStatus === 'buffering' && bufferStart !== undefined;
      const freshPoint = previousPoint !== undefined && at - previousPoint.at <= 2500;
      if (!(freshPoint || buffering)) return retained(unknownReason || 'measurement-stale');
      if (metrics.measuredSeconds <= 0 && !buffering) return retained('awaiting-sync-interval');
      const rawScore = calculate(metrics);
      if (rawScore === undefined) return retained('invalid-measurements');
      if (lastCalculatedAt === undefined || at - lastCalculatedAt >= REFRESH_INTERVAL_MS) {
        if (!hasMeasuredScore) smoothedScore = rawScore;
        else if (lastRawScore !== undefined && rawScore > lastRawScore) smoothedScore = clamp(smoothedScore + (rawScore - lastRawScore) * .25, 0, 1);
        else if (rawScore < smoothedScore) smoothedScore = smoothedScore * .35 + rawScore * .65;
        else smoothedScore = smoothedScore * .75 + rawScore * .25;
        lastRawScore = rawScore; hasMeasuredScore = true; smoothedLevel = level(smoothedScore, smoothedLevel);
        lastCalculatedAt = at; lastValidAt = at;
        return report(playbackStatus, metrics.latestSource === 'position' ? 'position-timing-estimate' : undefined, metrics, rawScore, true, 'confident');
      }
      return report(playbackStatus, metrics.latestSource === 'position' ? 'position-timing-estimate' : undefined, metrics, rawScore, false, 'confident');
    }

    return { sample, breakSample, startBuffer, endBuffer, recordCorrection, refresh, reset, metricsAt };
  }

  /**
   * Validate an incoming client sync-quality telemetry message.
   * @param {any} message
   * @param {{idPattern?:RegExp}} [options]
   */
  function validateSyncQualityMessage(message, options = {}) {
    const idPattern = options.idPattern || DEFAULT_UUID_PATTERN;
    if (!message || typeof message !== 'object') return false;
    if (![message.roomId, message.viewerId, message.mediaVersion, message.streamVersion].every(value => typeof value === 'string' && idPattern.test(value))) {
      return false;
    }
    if (!statusSet.has(message.status)) return false;
    if (Object.hasOwn(message, 'score') && !finite(message.score)) return false;
    if (message.confidence !== undefined && !confidenceSet.has(message.confidence)) return false;
    if (message.measurementFreshnessMs !== undefined && (!finite(message.measurementFreshnessMs) || message.measurementFreshnessMs < 0)) return false;
    if (message.reason !== undefined && !reasonSet.has(message.reason)) return false;
    return true;
  }

  /**
   * Reduce an authenticated viewer's ephemeral sync-quality telemetry state.
   * Preserves anti-manufacture rules for paused/seeking reports and minimum update intervals.
   */
  function reduceViewerSyncQuality(previous = {}, message, {
    now = Date.now(),
    mediaVersion,
    streamVersion,
    lastAt,
    lastStatus,
    lastConfidence
  } = {}) {
    const statusChanged = lastStatus !== message.status;
    const confidenceChanged = lastConfidence !== message.confidence;
    const minimumInterval = statusChanged || confidenceChanged ? 500 : 4000;
    if (lastAt !== undefined && now - lastAt < minimumInterval) {
      return { throttled: true, next: previous, displayChanged: false };
    }
    const hasScore = finite(message.score);
    const score = hasScore
      ? clamp(message.score, 0, 1)
      : finite(previous.score) ? previous.score : finite(previous.lastKnownScore) ? previous.lastKnownScore : 1;
    const lastKnownScore = hasScore ? score : previous.lastKnownScore ?? score;
    const lastKnownLevel = hasScore ? level(score, previous.lastKnownLevel) : previous.lastKnownLevel;
    const confidence = message.confidence || (['playing', 'buffering'].includes(message.status)
      ? previous.confidence || 'reduced'
      : previous.confidence === 'provisional' ? 'provisional' : 'reduced');
    // Receiving a retained score is not a new playback measurement.
    const reportAge = reportableMeasurementFreshnessMs(message.measurementFreshnessMs);
    const reportedAt = reportAge !== undefined && confidence !== 'provisional' ? now - reportAge : undefined;
    // A pause/seek may report an old score, but cannot manufacture a new
    // measurement. Its first report can still carry the original evidence age.
    const mayAdvance = ['playing', 'buffering'].includes(message.status) || !finite(previous.measuredAt);
    const measuredAt = finite(reportedAt) && mayAdvance
      ? Math.max(previous.measuredAt ?? -Infinity, reportedAt)
      : previous.measuredAt;
    const advanced = finite(measuredAt) && (!finite(previous.measuredAt) || measuredAt - previous.measuredAt >= 500);
    const measurementFreshnessMs = finite(measuredAt) ? Math.max(0, now - measuredAt) : undefined;
    const next = {
      status: message.status,
      score,
      lastKnownScore,
      lastKnownLevel,
      confidence,
      measurementFreshnessMs,
      measuredAt,
      lastKnownAt: advanced ? measuredAt : previous.lastKnownAt,
      updatedAt: now,
      mediaVersion,
      streamVersion,
      reason: message.reason
    };
    const displayChanged = level(previous.score, previous.lastKnownLevel) !== level(score, lastKnownLevel) || previous.confidence !== confidence;
    return { throttled: false, next, displayChanged };
  }

  /**
   * Aggregate per-session sync-quality telemetry onto room participants.
   * Selects worst active confident device first while preserving every session row.
   */
  function aggregateParticipantSyncQuality(room, participants, now = Date.now()) {
    for (const person of participants || []) {
      const sessions = [];
      for (const [viewerId, viewer] of room.viewers) {
        if (viewer.userId === person.id) {
          sessions.push({ viewerId, viewer, disconnected: false, joinedAt: viewer.joinedAt || 0 });
        }
      }
      for (const [viewerId, viewer] of room.disconnectedViewers || []) {
        if (viewer.userId === person.id && viewer.mediaVersion === room.mediaVersion && viewer.expires > now) {
          sessions.push({ viewerId, viewer, disconnected: true, joinedAt: viewer.joinedAt || 0 });
        }
      }
      sessions.sort((a, b) => a.joinedAt - b.joinedAt || a.viewerId.localeCompare(b.viewerId));
      const visible = sessions.map(({ viewer, disconnected }) => {
        const measurement = viewer.syncQuality;
        const age = measurement && finite(measurement.updatedAt) ? Math.max(0, now - measurement.updatedAt) : Infinity;
        const contextMatches = measurement?.mediaVersion === room.mediaVersion && measurement?.streamVersion === viewer.streamVersion;
        let status = disconnected ? 'disconnected' : !measurement ? 'unknown' : measurement.status;
        const socketClosed = viewer.watchSocket ? viewer.watchSocket.readyState !== 1 : viewer.connected === false;
        if (!disconnected && socketClosed) status = 'disconnected';
        else if (!disconnected && measurement && (!contextMatches || age > STALE_AFTER_MS) && status !== 'error') status = 'stale';
        const lastKnownScore = finite(measurement?.lastKnownScore)
          ? clamp(measurement.lastKnownScore, 0, 1)
          : finite(measurement?.score) ? clamp(measurement.score, 0, 1) : 1;
        const score = finite(measurement?.score) ? clamp(measurement.score, 0, 1) : lastKnownScore;
        const rememberedLevel = measurement?.lastKnownLevel || level(lastKnownScore);
        let confidence = confidenceSet.has(measurement?.confidence) ? measurement.confidence : 'provisional';
        const evidenceAge = finite(measurement?.measuredAt)
          ? Math.max(0, now - measurement.measuredAt)
          : finite(measurement?.measurementFreshnessMs) ? age + measurement.measurementFreshnessMs : Infinity;
        const allowedAge = status === 'paused' ? PAUSED_EVIDENCE_MS : RECENT_EVIDENCE_MS;
        if (disconnected || status === 'disconnected' || status === 'stale' || age > STALE_AFTER_MS || evidenceAge > allowedAge ||
            ['starting', 'error', 'unknown'].includes(status)) {
          confidence = confidence === 'provisional' ? 'provisional' : 'reduced';
        }
        return {
          status,
          score,
          level: level(score, rememberedLevel),
          confidence,
          lastKnownScore,
          lastKnownLevel: rememberedLevel,
          lastKnownAt: measurement?.lastKnownAt,
          updatedAt: measurement?.updatedAt,
          measurementFreshnessMs: evidenceAge,
          reason: status === 'stale' ? (contextMatches ? 'measurement-expired' : 'stream-changed') : measurement?.reason,
          current: !disconnected && contextMatches && age <= STALE_AFTER_MS && ['playing', 'buffering', 'paused', 'seeking', 'starting', 'error'].includes(status)
        };
      });
      // Scan once and compare the displayed-session priority in place. Sessions
      // stay in `visible` for the participant tooltip regardless of selection.
      let selected, selectedPriority = Infinity;
      for (const session of visible) {
        const active = session.current && ['playing', 'buffering'].includes(session.status);
        const connected = session.current && session.status !== 'disconnected' && session.status !== 'stale';
        const priority = active ? (session.confidence === 'confident' ? 0 : 1) : connected ? 2 : finite(session.lastKnownAt) ? 3 : 4;
        const better = priority < selectedPriority || priority === selectedPriority && (
          priority < 3 && session.score < selected.score || priority === 3 && session.lastKnownAt > selected.lastKnownAt
        );
        if (!selected || better) { selected = session; selectedPriority = priority; }
      }
      const score = selected && finite(selected.score) ? selected.score : 1;
      const confidence = selected?.confidence || 'provisional';
      const reason = visible.length === 0 ? 'no-sessions' : selected?.reason ||
        (confidence === 'provisional' ? 'awaiting-measurements' : confidence === 'reduced' ? 'measurement-interrupted' : undefined);
      person.syncQuality = {
        status: confidence === 'confident' ? 'known' : 'unknown',
        score,
        level: level(score, selected?.level || selected?.lastKnownLevel || 'excellent'),
        confidence,
        reason,
        lastKnownScore: score,
        lastKnownLevel: level(score, selected?.level || selected?.lastKnownLevel || 'excellent'),
        measurementFreshnessMs: selected?.measurementFreshnessMs,
        sessions: visible
      };
    }
    return participants;
  }

  return {
    WINDOW_MS,
    REFRESH_INTERVAL_MS,
    STALE_AFTER_MS,
    MAX_CLOCK_AGE_MS,
    MAX_CLOCK_UNCERTAINTY_MS,
    RECENT_EVIDENCE_MS,
    PAUSED_EVIDENCE_MS,
    MAX_REPORT_FRESHNESS_MS,
    QUALITY_STATUSES,
    QUALITY_REASONS,
    QUALITY_CONFIDENCES,
    reportableMeasurementFreshnessMs,
    calculate,
    level,
    create,
    validateSyncQualityMessage,
    reduceViewerSyncQuality,
    aggregateParticipantSyncQuality
  };
}

export const {
  WINDOW_MS,
  REFRESH_INTERVAL_MS,
  STALE_AFTER_MS,
  MAX_CLOCK_AGE_MS,
  MAX_CLOCK_UNCERTAINTY_MS,
  RECENT_EVIDENCE_MS,
  PAUSED_EVIDENCE_MS,
  MAX_REPORT_FRESHNESS_MS,
  QUALITY_STATUSES,
  QUALITY_REASONS,
  QUALITY_CONFIDENCES,
  reportableMeasurementFreshnessMs,
  calculate,
  level,
  create,
  validateSyncQualityMessage,
  reduceViewerSyncQuality,
  aggregateParticipantSyncQuality
} = createQualityApi();
