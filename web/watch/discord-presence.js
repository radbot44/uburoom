// @ts-check
/* Personal Discord Rich Presence (Embedded App SDK setActivity) formatter and debounced controller.
 * Active only inside the Discord Activity iframe when both server configuration and viewer opt-in allow it. */

export const DEBOUNCE_MS = 350;
export const MIN_INTERVAL_MS = 2000;
export const TIMESTAMP_DRIFT_TOLERANCE_SEC = 2;
const MAX_FIELD_LENGTH = 128;

/** @param {unknown} value */
export function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

/** @param {unknown} value @param {string} [fallback] */
function formatField(value, fallback = '') {
  let text = cleanText(value) || cleanText(fallback);
  if (!text) return '';
  if (text.length > MAX_FIELD_LENGTH) text = text.slice(0, MAX_FIELD_LENGTH - 1).trimEnd() + '…';
  if (text.length === 1) text += ' ';
  return text;
}

/**
 * Computes Unix epoch-second start/end timestamps while playback is actively advancing.
 * Returns undefined when paused, waiting on readiness, or lacking valid timing/position.
 * @param {any} room
 * @param {number} nowMs
 * @param {number} [clockOffsetMs]
 */
export function computeTimestamps(room, nowMs, clockOffsetMs = 0) {
  const timeline = room?.state;
  if (!timeline || timeline.paused || timeline.waitingForReady) return undefined;
  if (!Number.isFinite(timeline.position) || !Number.isFinite(nowMs)) return undefined;

  let elapsedMs = 0;
  if (Number.isFinite(room.serverNow)) {
    let targetTime = nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
    if (Number.isFinite(room.pauseAt)) targetTime = Math.min(targetTime, room.pauseAt);
    const base = Number.isFinite(room.startAt) ? Math.max(room.serverNow, room.startAt) : room.serverNow;
    elapsedMs = Math.max(0, targetTime - base);
  }

  const duration = Number.isFinite(timeline.duration) && timeline.duration > 0 ? timeline.duration : 0;
  let position = Math.max(0, timeline.position + elapsedMs / 1000);
  if (duration > 0) position = Math.min(duration, position);

  const nowSec = Math.floor(nowMs / 1000);
  const start = Math.round(nowSec - position);
  if (duration <= 0) return { start };

  const end = start + Math.round(duration);
  if (position >= duration || end <= nowSec) return undefined;
  return { start, end };
}

/**
 * Builds the Discord Embedded App SDK `setActivity` payload (`activity` object or `null` to clear).
 * Never includes Plex URLs, tokens, or private room metadata/invites.
 * @param {{
 *   enabled?: boolean,
 *   serverAllowed?: boolean,
 *   activity?: boolean,
 *   room?: any,
 *   nowMs?: number,
 *   clockOffsetMs?: number,
 * }} input
 */
export function buildPresenceActivity({
  enabled = false,
  serverAllowed = true,
  activity = false,
  room = undefined,
  nowMs = Date.now(),
  clockOffsetMs = 0,
} = {}) {
  if (enabled !== true || serverAllowed === false || !activity || !room) return null;

  // Fail closed: anything other than explicitly public hides title, subtitle and room name.
  if (room.visibility !== 'public') {
    return {
      type: 3,
      details: 'Watching in uburoom',
    };
  }

  const title = cleanText(room.title);
  const hasMedia = Boolean(room.mediaId) && Boolean(title);
  const roomName = cleanText(room.roomName);

  if (!hasMedia) {
    return {
      type: 3,
      details: formatField(roomName, 'Watching in uburoom'),
      state: 'Choosing something to watch',
    };
  }

  const subtitle = cleanText(room.subtitle);
  const paused = !!room.state?.paused && !room.state?.waitingForReady;
  const state = formatField(
    [paused ? 'Paused' : '', subtitle, roomName].filter(Boolean).join(' · '),
    'Watching in uburoom',
  );
  const timestamps = computeTimestamps(room, nowMs, clockOffsetMs);

  return {
    type: 3,
    details: formatField(title, 'Watching in uburoom'),
    state,
    ...(timestamps ? { timestamps } : {}),
  };
}

/**
 * Compares two `setActivity` payloads while ignoring small clock-drift timestamp jitter.
 * @param {any} a
 * @param {any} b
 * @param {number} [driftToleranceSec]
 */
export function equivalentPresence(a, b, driftToleranceSec = TIMESTAMP_DRIFT_TOLERANCE_SEC) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.type !== b.type || a.details !== b.details) return false;
  if ((a.state || undefined) !== (b.state || undefined)) return false;
  if (Boolean(a.timestamps) !== Boolean(b.timestamps)) return false;
  if (a.timestamps && b.timestamps) {
    if (Math.abs((a.timestamps.start ?? 0) - (b.timestamps.start ?? 0)) > driftToleranceSec) return false;
    if (Math.abs((a.timestamps.end ?? 0) - (b.timestamps.end ?? 0)) > driftToleranceSec) return false;
  }
  return true;
}

/**
 * Creates a debounced, rate-limited Rich Presence controller for the Discord Activity session.
 * @param {{
 *   getSdk: () => any,
 *   isActivity: () => boolean,
 *   isEnabled: () => boolean,
 *   setEnabled?: (enabled: boolean) => void,
 *   isServerAllowed: () => boolean,
 *   getRoom: () => any,
 *   ensureScope: () => Promise<boolean>,
 *   now?: () => number,
 *   setTimeoutFn?: (fn: () => void, ms: number) => any,
 *   clearTimeoutFn?: (id: any) => void,
 *   debounceMs?: number,
 *   minIntervalMs?: number,
 *   onAuthDenied?: () => void,
 *   onError?: (error: any) => void,
 * }} options
 */
export function createPresenceController(options) {
  const now = options.now || (() => Date.now());
  const setTimer = options.setTimeoutFn || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimeoutFn || (id => clearTimeout(id));
  const debounceMs = options.debounceMs ?? DEBOUNCE_MS;
  const minIntervalMs = options.minIntervalMs ?? MIN_INTERVAL_MS;

  let timer;
  let sentActive = false;
  let lastSentPayload = null;
  let lastSentAt = 0;
  let inFlight = false;
  let inFlightPayload;
  let pendingFlush = false;
  let clearRequested = false;
  let scopeDenied = false;
  let generation = 0;

  function cancelTimer() {
    if (timer !== undefined) {
      clearTimer(timer);
      timer = undefined;
    }
  }

  function wantsActive() {
    return !!(options.isActivity() && options.isServerAllowed() && options.isEnabled());
  }

  async function sendActivity(activity) {
    const sdk = options.getSdk();
    if (!sdk?.commands?.setActivity) return false;
    inFlight = true;
    inFlightPayload = activity;
    try {
      await sdk.commands.setActivity({ activity });
      lastSentAt = now();
      lastSentPayload = activity;
      sentActive = activity !== null;
      return true;
    } catch (error) {
      options.onError?.(error);
      return false;
    } finally {
      inFlight = false;
      inFlightPayload = undefined;
    }
  }

  async function flush() {
    const runGen = generation;
    if (inFlight) {
      pendingFlush = true;
      return;
    }

    if (clearRequested || !wantsActive()) {
      clearRequested = false;
      if (sentActive) await sendActivity(null);
      else lastSentPayload = null;
      return;
    }

    const sdk = options.getSdk();
    if (!sdk?.commands?.setActivity) return;

    const candidate = buildPresenceActivity({
      enabled: options.isEnabled(),
      serverAllowed: options.isServerAllowed(),
      activity: options.isActivity(),
      room: options.getRoom(),
      nowMs: now(),
    });

    if (candidate === null) {
      if (sentActive) await sendActivity(null);
      else lastSentPayload = null;
      return;
    }

    if (equivalentPresence(lastSentPayload, candidate)) return;

    let granted = false;
    try {
      granted = !!(await options.ensureScope());
    } catch (error) {
      options.onError?.(error);
    }
    if (runGen !== generation) {
      if (clearRequested || !wantsActive()) {
        clearRequested = false;
        if (sentActive) await sendActivity(null);
      } else if (pendingFlush) {
        pendingFlush = false;
        void schedule(0);
      }
      return;
    }
    if (!granted) {
      scopeDenied = true;
      options.onAuthDenied?.();
      if (sentActive) await sendActivity(null);
      return;
    }

    if (!wantsActive()) {
      if (sentActive) await sendActivity(null);
      return;
    }

    const elapsed = now() - lastSentAt;
    if (lastSentAt > 0 && elapsed < minIntervalMs) {
      schedule(minIntervalMs - elapsed);
      return;
    }

    const latest = buildPresenceActivity({
      enabled: options.isEnabled(),
      serverAllowed: options.isServerAllowed(),
      activity: options.isActivity(),
      room: options.getRoom(),
      nowMs: now(),
    });
    if (latest === null) {
      if (sentActive) await sendActivity(null);
      return;
    }
    if (equivalentPresence(lastSentPayload, latest)) return;

    await sendActivity(latest);

    if (pendingFlush || clearRequested) {
      pendingFlush = false;
      void flush();
    }
  }

  function schedule(delayMs) {
    cancelTimer();
    timer = setTimer(
      () => {
        timer = undefined;
        return flush();
      },
      Math.max(0, delayMs),
    );
  }

  function sync() {
    if (!wantsActive() || !options.getRoom()) {
      return clear();
    }
    clearRequested = false;
    if (scopeDenied) return Promise.resolve();
    const candidate = buildPresenceActivity({
      enabled: options.isEnabled(),
      serverAllowed: options.isServerAllowed(),
      activity: options.isActivity(),
      room: options.getRoom(),
      nowMs: now(),
    });
    if (
      equivalentPresence(lastSentPayload, candidate) ||
      (inFlight && equivalentPresence(inFlightPayload, candidate))
    ) {
      cancelTimer();
      return Promise.resolve();
    }
    const elapsed = lastSentAt > 0 ? now() - lastSentAt : minIntervalMs;
    const waitMs = Math.max(debounceMs, Math.max(0, minIntervalMs - elapsed));
    schedule(waitMs);
    return Promise.resolve();
  }

  function clear() {
    cancelTimer();
    generation++;
    clearRequested = true;
    if (!sentActive && !inFlight) {
      clearRequested = false;
      lastSentPayload = null;
      return Promise.resolve();
    }
    return flush();
  }

  function setEnabled(enabled) {
    const next = !!enabled;
    if (next) scopeDenied = false;
    options.setEnabled?.(next);
    if (!next) return clear();
    return sync();
  }

  function dispose() {
    cancelTimer();
    generation++;
    pendingFlush = false;
    clearRequested = false;
  }

  return {
    clear,
    dispose,
    setEnabled,
    sync,
    flush,
  };
}
