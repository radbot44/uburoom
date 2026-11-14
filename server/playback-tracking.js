'use strict';
const { repositories } = require('./repositories');
const { randomUUID } = require('node:crypto');
const STATES = new Set(['playing', 'paused', 'buffering', 'seeking', 'ended', 'error', 'blocked']);
const GAP = 5000,
  MAX_INTERVALS = 2048;
class ObservationError extends Error {
  constructor(rejection) {
    super('Invalid or stale playback observation');
    this.rejection = rejection;
  }
}
function union(intervals) {
  const result = [];
  for (const [start, end] of intervals.sort((a, b) => a[0] - b[0])) {
    const last = result.at(-1);
    if (last && start <= last[1] + 0.001) last[1] = Math.max(last[1], end);
    else result.push([start, end]);
  }
  return result;
}
const length = intervals => intervals.reduce((sum, [a, b]) => sum + b - a, 0);
class PlaybackTracking {
  /** An observation ends after this long without a sample. */
  static OBSERVATION_GAP_MS = GAP;
  constructor(registry, now = Date.now) {
    this.registry = registry;
    this.now = now;
    this.db = registry.db;
    // Runtime viewers and consent are never restored after a process restart.
    for (const row of repositories(this.db).history.listInterrupted()) {
      const record = JSON.parse(row.record);
      if (!record.endedAt) {
        record.endedAt = record.lastReceivedAt;
        record.endReason = 'interrupted';
        this.save(record);
      }
    }
    this.prune();
  }
  prune() {
    repositories(this.db).history.prune(this.now());
  }
  save(record) {
    repositories(this.db).history.save(record.id, record.userId, record.lastReceivedAt, JSON.stringify(record));
  }
  end(viewer, reason) {
    if (viewer.tracking) {
      const record = viewer.tracking.record;
      record.endedAt = this.now();
      record.endReason = reason;
      this.save(record);
      viewer.tracking = undefined;
    }
    viewer.observationEpoch = randomUUID();
    viewer.observationSequence = undefined;
    viewer.observationSample = undefined;
  }
  expire(viewer) {
    if (viewer.tracking && this.now() - viewer.tracking.record.lastReceivedAt > GAP)
      this.end(viewer, 'observation-timeout');
  }
  observe(room, viewer, viewerId, data) {
    const now = this.now();
    const rejection = !viewer.media
      ? 'media-unavailable'
      : viewer.mediaVersion !== room.mediaVersion || data.mediaVersion !== room.mediaVersion
        ? 'media-changed'
        : data.streamVersion !== viewer.streamVersion
          ? 'stream-changed'
          : data.observationEpoch !== viewer.observationEpoch
            ? 'epoch-changed'
            : !Number.isSafeInteger(data.discontinuity) || data.discontinuity < 0
              ? 'invalid-discontinuity'
              : !STATES.has(data.state)
                ? 'invalid-state'
                : !Number.isSafeInteger(data.sequence) || data.sequence < 0
                  ? 'invalid-sequence'
                  : data.sequence <= (viewer.observationSequence ?? -1)
                    ? 'sequence-replayed'
                    : !Number.isFinite(data.sampleAt) || data.sampleAt < 0
                      ? 'invalid-sample'
                      : data.sampleAt <= (viewer.observationSample ?? -1)
                        ? 'sample-replayed'
                        : !Number.isFinite(data.observedAt)
                          ? 'invalid-clock'
                          : now - data.observedAt > 3000
                            ? 'sample-stale'
                            : data.observedAt - now > 1000
                              ? 'sample-future'
                              : !Number.isFinite(data.position) ||
                                  data.position < 0 ||
                                  data.position > room.media.duration + 0.5
                                ? 'invalid-position'
                                : !Number.isFinite(data.rate) || data.rate < 0.25 || data.rate > 4
                                  ? 'invalid-rate'
                                  : !Number.isSafeInteger(data.frames) || data.frames < 0
                                    ? 'invalid-frames'
                                    : undefined;
    if (rejection) throw new ObservationError(rejection);
    this.expire(viewer);
    if (data.observationEpoch !== viewer.observationEpoch) throw new ObservationError('observation-timeout');
    viewer.observationSequence = data.sequence;
    viewer.observationSample = data.sampleAt;
    const starting = !viewer.tracking;
    if (starting) {
      const identities = this.registry
        .identities(viewer.userId)
        .map(i => ({ provider: i.provider, subject: i.subject }));
      viewer.tracking = {
        record: {
          id: randomUUID(),
          userId: viewer.userId,
          identities,
          roomId: room.roomId,
          viewerId,
          mediaId: room.media.id,
          duration: room.media.duration,
          mediaVersion: room.mediaVersion,
          streamVersion: viewer.streamVersion,
          deliveryMode:
            viewer.media.format === 'local'
              ? 'local-file'
              : viewer.media.kind === 'demo'
                ? 'local-fixture'
                : { file: 'original', hls: 'plex-hls', av1: 'uburoom-av1' }[viewer.media.format] || 'unknown',
          startedAt: now,
          lastReceivedAt: now,
          watchedSeconds: 0,
          sourceSeconds: 0,
          wallIntervals: [],
          sourceIntervals: [],
        },
      };
    }
    const { record, previous } = viewer.tracking;
    const credit = { reason: 'baseline', creditedSeconds: 0 };
    if (previous) {
      const elapsed = (data.sampleAt - previous.sampleAt) / 1000,
        received = (now - record.lastReceivedAt) / 1000,
        advanced = data.position - previous.position;
      const clockDelta = (data.observedAt - previous.observedAt) / 1000 - elapsed;
      credit.reason =
        previous.state !== 'playing' || data.state !== 'playing'
          ? 'not-playing'
          : previous.discontinuity !== data.discontinuity
            ? 'discontinuity'
            : data.frames <= previous.frames
              ? 'frames-not-advancing'
              : !(elapsed > 0 && elapsed <= GAP / 1000)
                ? 'sample-gap'
                : !(received > 0 && received <= GAP / 1000)
                  ? 'receive-gap'
                  : Math.abs(received - elapsed) >= 1
                    ? 'delivery-jitter'
                    : Math.abs(clockDelta) >= 0.25
                      ? 'clock-discontinuity'
                      : !(advanced > 0) || Math.abs(advanced - (elapsed * (previous.rate + data.rate)) / 2) >= 0.25
                        ? 'position-discontinuity'
                        : record.wallIntervals.length >= MAX_INTERVALS || record.sourceIntervals.length >= MAX_INTERVALS
                          ? 'interval-limit'
                          : 'credited';
      // Only bounded scalar deltas leave the server; no request echo or IDs.
      for (const [key, value] of Object.entries({
        elapsedMs: elapsed * 1000,
        receivedMs: received * 1000,
        clockDeltaMs: clockDelta * 1000,
        positionDelta: advanced,
        frameDelta: data.frames - previous.frames,
      }))
        if (Number.isFinite(value) && Math.abs(value) <= 1e9) credit[key] = Math.round(value * 1000) / 1000;
      // Both boundaries must describe decoded playback. No tail extrapolation,
      // seek credit, room-clock credit or credit across a missing heartbeat.
      if (credit.reason === 'credited') {
        // Network jitter must not manufacture thousands of tiny source gaps.
        // These are the two validated observation boundaries, not projections.
        record.wallIntervals = union([...record.wallIntervals, [previous.observedAt, data.observedAt]]);
        record.sourceIntervals = union([...record.sourceIntervals, [previous.position, data.position]]);
        credit.creditedSeconds = length(record.wallIntervals) / 1000 - record.watchedSeconds;
      }
    }
    Object.assign(record, {
      lastReceivedAt: now,
      observedAt: data.observedAt,
      position: data.position,
      state: data.state,
      sequence: data.sequence,
      watchedSeconds: length(record.wallIntervals) / 1000,
      sourceSeconds: length(record.sourceIntervals),
    });
    viewer.tracking.previous = { ...data };
    this.save(record);
    if (starting) this.prune();
    return {
      accepted: true,
      playbackId: record.id,
      state: record.state,
      watchedSeconds: record.watchedSeconds,
      credit,
    };
  }
  history(userId) {
    const canonicalId = this.registry.canonical(userId)?.id;
    if (!canonicalId) return { retentionDays: 90, totals: [], sessions: [] };
    const ids = repositories(this.db)
      .accounts.listMergedUsers(canonicalId)
      .map(u => u.id);
    if (ids.length === 0) return { retentionDays: 90, totals: [], sessions: [] };
    return repositories(this.db).history.history(ids);
  }
}
module.exports = { PlaybackTracking, union, ObservationError };
