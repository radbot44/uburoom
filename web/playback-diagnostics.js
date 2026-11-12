/* Local, bounded playback evidence. Exports exclude URLs, IDs, titles and error text.
 * The server keeps viewer uploads through the same allowlist (see clean). */
(function (root) {
  'use strict';
  const choices = {
    fallbackReason: ['join', 'reconnect', 'stall', 'low-buffer', 'buffer-ready', 'decode'],
    reason: [
      'state-change',
      'room-select',
      'room-poll',
      'identity-poll',
      'room-unavailable',
      'control-disconnected',
      'kicked',
      'leave',
      'end',
      'logout',
      'fallback',
      'decoder',
      'fatal',
      'complete',
      'source-changed',
      'unavailable',
    ],
    action: [
      'media.load',
      'media.play',
      'media.pause',
      'media.toggle',
      'media.seek.absolute',
      'media.seek.relative',
      'media.quality.set',
      'media.tracks.set',
      'media.stream.refresh',
      'room.enable',
      'room.disable',
      'room.visibility',
    ],
    request: ['room-poll', 'rooms', 'observe', 'ready', 'command', 'identity', 'other'],
    failure: ['http', 'network', 'timeout', 'abort', 'decode', 'other'],
    category: ['network', 'media', 'other'],
    detail: [
      'reset',
      'fragment',
      'manifest',
      'quota-exceeded',
      'buffer-full',
      'buffer-append',
      'audio-enhancement',
      'other',
    ],
    degradation: ['severe-drops', 'drops', 'stalls'],
    capabilityStatus: ['unavailable', 'incomplete', 'reported', 'error'],
    deliveryReason: [
      'source-only',
      'original',
      'local-fallback',
      'burn-in',
      'compatible',
      'multiple-audio',
      'quality-limit',
    ],
    format: ['hls', 'file', 'av1', 'vp9', 'vp8'],
    delivery: ['text', 'image', 'burn', 'off'],
    syncMode: ['speed', 'jumps'],
    audioMode: ['normal', 'dialogue', 'night'],
    visibility: ['visible', 'hidden', 'prerender'],
    closeInitiator: ['none', 'manual-close', 'interrupt', 'auth-timeout', 'protocol-error', 'heartbeat-timeout'],
    roomListState: ['missing', 'locked'],
    holdEnd: ['ready', 'timeout', 'error'],
    rejection: [
      'media-unavailable',
      'media-changed',
      'stream-changed',
      'epoch-changed',
      'invalid-discontinuity',
      'invalid-state',
      'invalid-sequence',
      'sequence-replayed',
      'invalid-sample',
      'sample-replayed',
      'invalid-clock',
      'sample-stale',
      'sample-future',
      'invalid-position',
      'invalid-rate',
      'invalid-frames',
      'observation-timeout',
      'storage-failure',
    ],
    creditReason: [
      'baseline',
      'not-playing',
      'discontinuity',
      'frames-not-advancing',
      'sample-gap',
      'receive-gap',
      'delivery-jitter',
      'clock-discontinuity',
      'position-discontinuity',
      'interval-limit',
      'clock-unavailable',
      'credited',
    ],
    clockReason: [
      'startup',
      'disconnect',
      'discontinuity',
      'server-change',
      'invalid',
      'delay',
      'jitter',
      'outlier',
      'accepted',
    ],
    qualityStatus: ['playing', 'buffering', 'paused', 'seeking', 'starting', 'stale', 'unknown', 'error'],
    qualityConfidence: ['confident', 'reduced', 'provisional'],
    qualityReason: [
      'clock-unavailable',
      'clock-stale',
      'clock-low-confidence',
      'insufficient-clock-samples',
      'insufficient-sync-samples',
      'measurement-stale',
      'invalid-measurements',
      'invalid-measurement-time',
      'playback-error',
      'paused',
      'seeking',
      'starting',
      'stream-changed',
      'media-changed',
      'room-changed',
      'awaiting-sync-interval',
      'awaiting-measurements',
      'position-timing-estimate',
      'clock-warmup',
      'measurement-interrupted',
      'no-sessions',
    ],
    lastKnownQualityLevel: ['excellent', 'good', 'fair', 'poor'],
    controlSource: ['presentation', 'blend', 'position'],
    presentationReason: [
      'fresh',
      'none',
      'stale',
      'context',
      'clock',
      'interrupted',
      'discontinuity',
      'divergent',
      'blend',
      'hidden',
      'ineligible',
      'clock-invalid',
    ],
  };
  const events = new Set([
    'start',
    'sample',
    'state-change',
    'request-failed',
    'player-clear',
    'hls-stop',
    'hls-error',
    'retry-scheduled',
    'retry-deferred',
    'retry-start',
    'fallback-start',
    'fallback-switch',
    'fallback-return',
    'fallback-failed',
    'stream-refresh',
    'stream-refresh-ok',
    'stream-refresh-failed',
    'identity-renewed',
    'identity-renew-failed',
    'fallback',
    'buffer-recovered',
    'control-disconnected',
    'control-reconnected',
    'playing',
    'pause',
    'waiting',
    'stalled',
    'seeking',
    'seeked',
    'ended',
    'error',
    'emptied',
    'loadstart',
    'loadedmetadata',
    'canplay',
    'abort',
    'soak-start',
    'soak-end',
    'probe-start',
    'probe-end',
    'command-start',
    'command-ok',
    'command-failed',
    'online',
    'offline',
    'visibilitychange',
    'pagehide',
    'observation-uncredited',
    'frame',
    'clock-sample',
    'ratechange',
    'sync-seek',
    'sync-jump',
    'sync-mode',
    'sync-quality',
    'start-prepare',
    'start-timer',
    'start-delay',
    'hls-anchor',
    'hls-buffer-flushing',
    'control-connected',
    'room-list-unavailable',
    'room-state-unavailable',
    'playback-degraded',
    'playback-rearmed',
    'decode-capability',
    'disconnect-extended',
    'disconnect-expired',
    'stream-hold',
    'stream-swap',
    'frame-hold-end',
    'subtitle-window',
    'subtitle-window-failed',
    'chunk-loaded',
    'page-error',
  ]);
  const numbers = new Set([
    'elapsedMs',
    'status',
    'attempt',
    'delayMs',
    'position',
    'target',
    'ready',
    'network',
    'rate',
    'bufferAhead',
    'frames',
    'decoded',
    'dropped',
    'failedReturns',
    'callbackFrames',
    'width',
    'height',
    'viewportFraction',
    'jsHeapUsed',
    'jsHeapTotal',
    'jsHeapLimit',
    'mediaError',
    'audio',
    'subtitle',
    'identity',
    'room',
    'media',
    'stream',
    'grant',
    'observation',
    'receivedMs',
    'clockDeltaMs',
    'positionDelta',
    'frameDelta',
    'creditedSeconds',
    'serverTime',
    'clockRevision',
    'clockAccepted',
    'clockRejected',
    'clockOffsetMs',
    'clockAgeMs',
    'clockUncertaintyMs',
    'networkRttMs',
    'networkMinRttMs',
    'networkJitterMs',
    'requestRttMs',
    'serverProcessingMs',
    'timelineRevision',
    'sharedTarget',
    'positionErrorMs',
    'frameMediaTime',
    'frameDisplayMonoMs',
    'framePresentationMonoMs',
    'frameCallbackLatenessMs',
    'frameProcessingMs',
    'presentedFrames',
    'frameIntervalMs',
    'frameMediaIntervalMs',
    'frameCallbackGap',
    'presentationErrorMs',
    'arrivalTarget',
    'frameServerTime',
    'seekDeltaMs',
    'aheadMs',
    'socketCloseCode',
    'smoothedPresentationErrorMs',
    'controlErrorMs',
    'presentationAgeMs',
    'presentationDivergenceMs',
    'measuredPlaybackSeconds',
    'outOfSync250Seconds',
    'outOfSync500Seconds',
    'automaticCorrectionCount',
    'automaticCorrectionMagnitudeMs',
    'correctionDutyCycle',
    'rateAdjustedSeconds',
    'rateAdjustmentSeconds',
    'bufferingSeconds',
    'rawQualityScore',
    'smoothedQualityScore',
    'qualityMeasurementFreshnessMs',
    'presentationMeasuredSeconds',
    'positionMeasuredSeconds',
    'connectionId',
    'connectionAttempt',
    'connectionAgeMs',
    'roomCount',
    'dropRatio',
    'deltaTotal',
    'deltaDropped',
    'severeRatio',
    'severeTotal',
    'severeDropped',
    'totalStallMs',
    'stallCount',
    'sampleGapMs',
    'hlsMaxBufferSize',
    'hlsMaxBufferLength',
    'hlsMaxMaxBufferLength',
    'hlsBackBufferLength',
  ]);
  const flags = new Set([
    'paused',
    'roomPaused',
    'seeking',
    'waiting',
    'online',
    'inViewport',
    'fatal',
    'enabled',
    'cleanup',
    'roomChanged',
    'mediaChanged',
    'streamChanged',
    'grantChanged',
    'observationChanged',
    'clockValid',
    'frameRepeated',
    'settling',
    'socketCloseClean',
    'socketWasReady',
    'presentationReset',
    'prepared',
    'capabilitySupported',
    'capabilitySmooth',
    'capabilityPowerEfficient',
  ]);
  // The one allowlist for recorded fields, in the browser and again on the server.
  function clean(fields) {
    const row = {};
    for (const [key, value] of Object.entries(fields || {})) {
      if (numbers.has(key) && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER)
        row[key] = Math.round(value * 1000) / 1000;
      else if (flags.has(key) && typeof value === 'boolean') row[key] = value;
      else if (Object.hasOwn(choices, key) && choices[key].includes(value)) row[key] = value;
      else if (key === 'ranges' && Array.isArray(value))
        row.ranges = value
          .slice(0, 8)
          .filter(
            pair =>
              Array.isArray(pair) && pair.length === 2 && pair.every(n => Number.isFinite(n) && n >= 0 && n <= 1e9),
          )
          .map(pair => pair.map(n => Math.round(n * 1000) / 1000));
    }
    return row;
  }
  // A recorded row as received from a browser: known event, sane times, allowed fields only.
  /** @returns {({sequence:number, at:number, ms:number, event:string} & Record<string, unknown>) | undefined} */
  function cleanRow(row) {
    if (
      !row ||
      typeof row !== 'object' ||
      !events.has(row.event) ||
      !Number.isSafeInteger(row.sequence) ||
      !Number.isFinite(row.at) ||
      !Number.isFinite(row.ms)
    )
      return;
    const { sequence, at, ms, event, ...fields } = row;
    return { sequence, at: Math.round(at), ms: Math.round(ms), event, ...clean(fields) };
  }
  function requestKind(path) {
    const route = String(path).split('?')[0];
    if (/^\/api\/watch\/rooms\/[^/]+$/.test(route)) return 'room-poll';
    if (route === '/api/watch/rooms') return 'rooms';
    const action = /^\/api\/watch\/rooms\/[^/]+\/(observe|ready|command)$/.exec(route)?.[1];
    if (action) return action;
    return /^\/api\/(watch\/(me|.*login)|account\/.*login)$/.test(route) ? 'identity' : 'other';
  }
  function create({ now = Date.now, monotonic = () => performance.now(), soak = false } = {}) {
    const limits = soak ? { events: 2400, samples: 8100, frames: 36000 } : { events: 300, samples: 600, frames: 7200 };
    const startedAt = now(),
      start = monotonic(),
      buckets = { events: [], samples: [], frames: [] },
      generations = { room: 0, media: 0, stream: 0, grant: 0, observation: 0 };
    let previous = {},
      sequence = 0,
      discardedEvents = 0,
      discardedSamples = 0,
      discardedFrames = 0,
      frameCursor = 0;
    function record(event, fields = {}) {
      if (!events.has(event)) return;
      const row = {
        sequence: ++sequence,
        at: now(),
        ms: Math.round(monotonic() - start),
        event,
        ...generations,
        ...clean(fields),
      };
      const sample = event === 'sample',
        frame = event === 'frame',
        bucket = frame ? buckets.frames : sample ? buckets.samples : buckets.events,
        limit = frame ? limits.frames : sample ? limits.samples : limits.events;
      if (frame && bucket.length === limit) {
        bucket[frameCursor] = row;
        frameCursor = (frameCursor + 1) % limit;
        discardedFrames++;
        return;
      }
      if (bucket.length === limit) {
        bucket.shift();
        if (frame) discardedFrames++;
        else if (sample) discardedSamples++;
        else discardedEvents++;
      }
      bucket.push(row);
    }
    function state(value) {
      const current = {
          room: value.id,
          media: value.mediaVersion,
          stream: value.streamVersion,
          grant: value.mediaUrl,
          observation: value.observationEpoch,
        },
        changed = {};
      for (const key of Object.keys(generations))
        if (previous[key] !== current[key]) {
          generations[key]++;
          changed[key + 'Changed'] = true;
        }
      previous = current;
      if (Object.keys(changed).length)
        record('state-change', { ...changed, deliveryReason: value.deliveryInfo?.reason });
    }
    // Rows after a sequence, for reports and uploads: no per-frame rows, and at most
    // one periodic sample per interval. Events are always kept.
    function entries({ after = 0, since = 0, sampleEveryMs = 5000 } = {}) {
      let lastSample = 0;
      return [...buckets.events, ...buckets.samples]
        .filter(row => row.sequence > after && row.at >= since)
        .sort((a, b) => a.sequence - b.sequence)
        .filter(row => {
          if (row.event !== 'sample') return true;
          if (row.at - lastSample < sampleEveryMs) return false;
          lastSample = row.at;
          return true;
        })
        .map(row => ({ ...row }));
    }
    record('start');
    return {
      record,
      state,
      entries,
      snapshot: () =>
        JSON.parse(
          JSON.stringify({
            schema: 2,
            startedAt,
            exportedAt: now(),
            limits,
            discardedEvents,
            discardedSamples,
            discardedFrames,
            entries: [...buckets.events, ...buckets.samples, ...buckets.frames].sort((a, b) => a.sequence - b.sequence),
          }),
        ),
    };
  }
  function controlProbe(now = () => performance.now()) {
    let room,
      until = 0;
    return {
      start(id) {
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id || '') || now() < until) return false;
        room = id;
        until = now() + 6000;
        return true;
      },
      active: () => now() < until,
      rejects: (path, id) => id === room && now() < until && String(path).split('?')[0] === '/api/watch/rooms/' + room,
    };
  }
  const api = { create, clean, cleanRow, requestKind, controlProbe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uburoomDiagnostics = api;
})(typeof globalThis === 'object' ? globalThis : this);
