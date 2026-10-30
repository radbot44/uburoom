// @ts-check
/* Playback timing, clock estimation, drift control and buffer range helpers.
 * Pure synchronization math only; never supplies watch-time credit or media delivery.
 */

export function createTimingApi() {
  const MAX_AGE = 5000;
  const WINDOW = 30000;

  function clock({ monotonic = () => performance.now(), wall = Date.now } = {}) {
    let samples = [], delays = [], delayed = [];
    let mapping, desired, adjustedAt, lastGood, lastTick, lastWall, lastSent, epoch;
    let uncertain = false, revision = 0, rejected = 0, accepted = 0, reason = 'startup';

    function reset(why = 'disconnect') {
      samples = []; delays = []; delayed = []; uncertain = false;
      mapping = desired = adjustedAt = lastGood = lastTick = lastWall = lastSent = epoch = undefined;
      revision++; reason = why;
    }

    function tick() {
      const now = monotonic(), date = wall();
      if (lastTick !== undefined && (now < lastTick || now - lastTick > MAX_AGE || Math.abs((date - lastWall) - (now - lastTick)) > 250)) {
        reset('discontinuity');
      }
      lastTick = now; lastWall = date;
      if (mapping !== undefined) {
        // Refine at <=2 ms/s. Reading a future frame timestamp cannot slew the clock.
        const limit = Math.max(0, now - adjustedAt) * .002;
        mapping += Math.max(-limit, Math.min(limit, desired - mapping));
        adjustedAt = now;
      }
      return now;
    }

    function begin() { return { sent: tick(), revision }; }

    function add(request, timing) {
      const received = tick(), duration = received - request.sent;
      const { serverReceivedAt: t2, serverSentAt: t3, serverProcessingMs: processing, clockEpoch } = timing || {};
      const reject = why => { rejected++; reason = why; return false; };
      if (request.revision !== revision) return reject('discontinuity');
      if (lastSent !==undefined && request.sent <= lastSent) return reject('invalid');
      lastSent = request.sent;
      if (![t2, t3, processing, duration].every(Number.isFinite) || duration < 0 || processing < 0 || t3 < t2 ||
          Math.abs(t3 - t2 - processing) > 5 || processing > duration + 5 || typeof clockEpoch !== 'string' || !clockEpoch) {
        return reject('invalid');
      }
      const rtt = Math.max(0, duration - processing);
      if (epoch !== undefined && clockEpoch !== epoch) {
        reset('server-change'); lastTick = received; lastWall = wall(); lastSent = request.sent;
      }
      epoch = clockEpoch;
      delays.push({ at: received, rtt });
      delays = delays.filter(s => received - s.at <= WINDOW).slice(-32);
      if (rtt > 1500) return reject('delay');
      const offset = (t2 + t3 - request.sent - received) / 2;
      samples = samples.filter(s => received - s.at <= WINDOW);
      // A low-delay sample gives the narrowest possible offset interval. Do
      // not assume path symmetry: uncertainty retains half the network RTT.
      const best = samples.filter(s => !s.suspect).reduce((a, b) => !a || b.rtt < a.rtt ? b : a, undefined);
      if (best && rtt > best.rtt + Math.max(20, best.rtt * .5)) {
        delayed.push({ rtt, offset }); delayed = delayed.slice(-3);
        // Reacquire a persistently slower route without waiting for the old
        // minimum to age out. Isolated queueing spikes cannot replace it.
        if (delayed.length < 3 || !delayed.every(s => Math.abs(s.rtt - rtt) <= Math.max(20, rtt * .2) && Math.abs(s.offset - offset) <= 20)) {
          return reject('jitter');
        }
        samples = [];
      }
      delayed = [];
      if (mapping !== undefined && Math.abs(offset - mapping) > Math.max(250, rtt / 2 + (best?.rtt || 0) / 2 + 10)) {
        uncertain = true;
        // A server wall-clock step changes the authoritative timeline. Require
        // three agreeing exchanges before rebasing; one outlier cannot jump it.
        samples.push({ at: received, rtt, offset, suspect: true });
        samples = samples.slice(-32);
        const recent = samples.slice(-3);
        if (recent.length < 3 || !recent.every(s => s.suspect && Math.abs(s.offset - offset) < 10)) return reject('outlier');
        samples = []; mapping = undefined; revision++;
      }
      samples.push({ at: received, rtt, offset });
      samples = samples.slice(-32);
      const reliable = samples.filter(s => !s.suspect).sort((a, b) => a.rtt - b.rtt || b.at - a.at);
      desired = reliable[0].offset;
      if (mapping === undefined) mapping = desired;
      adjustedAt = received; lastGood = received; uncertain = false; accepted++; reason = 'accepted';
      return true;
    }

    function read(at) {
      const now = tick(); at ??= now;
      let best;
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (!s.suspect && now - s.at <= WINDOW) {
          if (!best || s.rtt < best.rtt) best = s;
        }
      }
      let rttCount = 0, lastRtt, minRtt = Infinity, maxRtt = -Infinity;
      for (let i = 0; i < delays.length; i++) {
        const s = delays[i];
        if (now - s.at <= WINDOW) {
          rttCount++;
          lastRtt = s.rtt;
          if (s.rtt < minRtt) minRtt = s.rtt;
          if (s.rtt > maxRtt) maxRtt = s.rtt;
        }
      }
      const valid = mapping !== undefined && best !== undefined && now - lastGood <= MAX_AGE && !uncertain;
      const jitter = rttCount ? maxRtt - minRtt : undefined;
      const excessRtt = valid && rttCount ? Math.max(0, lastRtt - best.rtt) : 0;
      return {
        valid: !!valid,
        serverTime: valid ? at + mapping : undefined,
        clockRevision: revision,
        clockAccepted: accepted,
        clockRejected: rejected,
        clockReason: reason,
        clockOffsetMs: valid ? now + mapping - wall() : undefined,
        clockAgeMs: lastGood === undefined ? undefined : now - lastGood,
        clockUncertaintyMs: valid ? best.rtt / 2 + 2 + Math.abs(desired - mapping) + (now - best.at) * .0001 : undefined,
        clockStabilityMs: valid ? Math.min(25, best.rtt / 2) + 2 + excessRtt / 2 + Math.abs(desired - mapping) + (now - best.at) * .0001 : undefined,
        networkRttMs: lastRtt,
        networkMinRttMs: best?.rtt,
        networkJitterMs: jitter,
        networkRttSampleCount: rttCount
      };
    }

    return { begin, add, read, reset };
  }

  function target(state, serverTime) {
    const timeline = state?.state || state;
    if (!state || !timeline || (state.state === undefined && !Number.isFinite(timeline.position)) ||
        !Number.isFinite(serverTime) || !Number.isFinite(state.serverNow)) return undefined;
    if (Number.isFinite(state.pauseAt)) serverTime = Math.min(serverTime, state.pauseAt);
    const elapsed = Number.isFinite(state.startAt)
      ? Math.max(0, serverTime - Math.max(state.serverNow, state.startAt))
      : serverTime - state.serverNow;
    return Math.max(0, Math.min(timeline.duration || 0, timeline.position + (timeline.paused ? 0 : elapsed / 1000)));
  }

  function alarm({ now, set = setTimeout, clear = clearTimeout }) {
    let timer, key, generation = 0;
    const cancel = () => { generation++; if (timer !== undefined) clear(timer); timer = key = undefined; };
    function arm(nextKey, at, fire) {
      if (key === nextKey && timer !== undefined) return;
      cancel(); key = nextKey; const current = generation;
      const check = () => {
        if (current !== generation) return;
        const time = now();
        if (!Number.isFinite(time)) { cancel(); return; }
        if (time < at) { timer = set(check, Math.min(2500, at - time)); return; }
        timer = key = undefined; generation++; fire();
      };
      check();
    }
    return { arm, cancel };
  }

  function presentation() {
    let previous, intervals = [], sample, lastInterruptReason;

    function reset() {
      previous = undefined; intervals = []; sample = undefined; lastInterruptReason = undefined;
    }

    function interrupt(reason = 'interrupted') {
      previous = undefined;
      if (sample) {
        sample.interrupted = true; sample.smoothedErrorMs = undefined; sample.samples = 0;
        if (reason === 'stream') sample = undefined;
      }
      lastInterruptReason = reason;
    }

    function cadence() {
      return intervals.length >= 8 ? [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : 0;
    }

    function frame(now, metadata, options) {
      const { mediaTime, expectedDisplayTime, presentationTime, presentedFrames, processingDuration } = metadata || {};
      if (![mediaTime, expectedDisplayTime, presentedFrames].every(Number.isFinite)) return undefined;
      const current = { mediaTime, expectedDisplayTime, presentedFrames };
      const advancing = previous && mediaTime > previous.mediaTime && expectedDisplayTime > previous.expectedDisplayTime && presentedFrames > previous.presentedFrames;
      if (advancing && presentedFrames === previous.presentedFrames + 1) {
        const interval = mediaTime - previous.mediaTime;
        if (interval >= 1 / 120 && interval <= .1) { intervals.push(interval); intervals = intervals.slice(-24); }
      }
      const result = {
        frameMediaTime: mediaTime,
        frameDisplayMonoMs: expectedDisplayTime,
        framePresentationMonoMs: presentationTime,
        frameCallbackLatenessMs: now - expectedDisplayTime,
        frameProcessingMs: Number.isFinite(processingDuration) ? processingDuration * 1000 : undefined,
        presentedFrames,
        frameIntervalMs: advancing ? expectedDisplayTime - previous.expectedDisplayTime : undefined,
        frameMediaIntervalMs: advancing ? (mediaTime - previous.mediaTime) * 1000 : undefined,
        // Gaps mean callbacks were missed; they do not prove repeated/dropped pixels.
        frameCallbackGap: advancing ? Math.max(0, presentedFrames - previous.presentedFrames - 1) : undefined,
        frameRepeated: !!previous && mediaTime === previous.mediaTime
      };

      const { target: expectedTarget, context, clockRevision } = options || {};
      if (Number.isFinite(expectedTarget)) {
        const currentErrorMs = (mediaTime - expectedTarget) * 1000;
        let reinit = false;
        const currentCadenceSeconds = intervals.length >= 8 ? [...intervals].sort((a, b) => a - b)[Math.floor(intervals.length / 2)] : 0;
        const cadenceMs = currentCadenceSeconds * 1000;

        if (!sample || sample.interrupted || !Number.isFinite(sample.smoothedErrorMs)) {
          reinit = true;
        } else if (!Number.isFinite(sample.at) || now < sample.at || now - sample.at > 1000) {
          reinit = true;
        } else if (context !== undefined && sample.context !== undefined && context !== sample.context) {
          reinit = true;
        } else if (clockRevision !== undefined && sample.clockRevision !== undefined && clockRevision !== sample.clockRevision) {
          reinit = true;
        } else if (previous) {
          if (expectedDisplayTime < previous.expectedDisplayTime || expectedDisplayTime - previous.expectedDisplayTime > 250) {
            reinit = true;
          } else if (mediaTime < previous.mediaTime || presentedFrames < previous.presentedFrames) {
            reinit = true;
          } else {
            const dMediaMs = (mediaTime - previous.mediaTime) * 1000;
            const dDisplayMs = expectedDisplayTime - previous.expectedDisplayTime;
            if (Math.abs(dMediaMs - dDisplayMs) > Math.max(100, 3 * cadenceMs)) reinit = true;
          }
        }

        let smoothedErrorMs, sampleCount;
        if (reinit) {
          smoothedErrorMs = currentErrorMs; sampleCount = 1;
        } else {
          smoothedErrorMs = 0.35 * currentErrorMs + 0.65 * sample.smoothedErrorMs;
          sampleCount = (sample.samples || 0) + 1;
        }
        sample = { at: now, errorMs: currentErrorMs, smoothedErrorMs, samples: sampleCount, context, clockRevision, interrupted: false };
        lastInterruptReason = undefined;
        result.presentationErrorMs = currentErrorMs;
        result.smoothedPresentationErrorMs = smoothedErrorMs;
        result.presentationReset = reinit;
      }
      previous = current;
      return result;
    }

    function read(now, options) {
      const at = Number.isFinite(now) ? now : (typeof performance === 'object' && performance.now ? performance.now() : 0);
      const reqContext = typeof options === 'string' ? options : options?.context;
      const reqClockRevision = typeof options === 'object' ? options?.clockRevision : undefined;
      const currentCadence = cadence();
      if (!sample) return { valid: false, interrupted: false, errorMs: undefined, smoothedErrorMs: undefined, ageMs: undefined, cadenceSeconds: currentCadence, samples: 0, reason: lastInterruptReason || 'none' };
      const ageMs = at - sample.at;
      const base = { errorMs: sample.errorMs, smoothedErrorMs: sample.smoothedErrorMs, ageMs: ageMs >= 0 ? ageMs : undefined, cadenceSeconds: currentCadence, samples: sample.samples || 0, interrupted: Boolean(sample.interrupted) };
      if (sample.interrupted) return { ...base, valid: false, smoothedErrorMs: undefined, interrupted: true, reason: lastInterruptReason || 'interrupted' };
      if (ageMs < 0) return { ...base, valid: false, reason: 'discontinuity' };
      if (reqContext !== undefined && sample.context !== undefined && reqContext !== sample.context) return { ...base, valid: false, reason: 'context' };
      if (reqClockRevision !== undefined && sample.clockRevision !== undefined && reqClockRevision !== sample.clockRevision) return { ...base, valid: false, reason: 'clock' };
      if (ageMs > 1000) return { ...base, valid: false, reason: 'stale' };
      return { ...base, valid: true, reason: 'fresh' };
    }

    return { reset, interrupt, cadence, frame, read };
  }

  function controlSignal({ target: expectedTarget, currentTime, presentation: pres, clockValid = true, visible = true, eligible = true } = {}) {
    const positionError = Number.isFinite(expectedTarget) && Number.isFinite(currentTime) ? expectedTarget - currentTime : 0;
    const usable = !!(pres && pres.valid && Number.isFinite(pres.smoothedErrorMs) &&
      Number.isFinite(pres.ageMs) && pres.ageMs <= 1000 && pres.ageMs >= 0 &&
      clockValid && visible && eligible);
    if (!usable) {
      let reason = 'none';
      if (!pres || pres.reason === 'none') reason = 'none';
      else if (pres.interrupted || ['interrupted', 'pause', 'waiting', 'seek', 'visibilitychange', 'stream'].includes(pres.reason)) reason = 'interrupted';
      else if (pres.reason === 'context') reason = 'context';
      else if (pres.reason === 'clock') reason = 'clock';
      else if (pres.reason === 'discontinuity') reason = 'discontinuity';
      else if (pres.reason === 'stale' || (pres.ageMs !== undefined && pres.ageMs > 1000)) reason = 'stale';
      else if (!clockValid) reason = 'clock-invalid';
      else if (!visible) reason = 'hidden';
      else if (!eligible) reason = 'ineligible';
      else reason = pres.reason || 'fallback';
      const divergenceMs = (pres && Number.isFinite(pres.smoothedErrorMs))
        ? Math.round(Math.abs(-pres.smoothedErrorMs / 1000 - positionError) * 1000)
        : undefined;
      return { error: positionError, source: 'position', divergenceMs, reason };
    }
    const presentationError = -pres.smoothedErrorMs / 1000;
    const divergenceMs = Math.round(Math.abs(presentationError - positionError) * 1000);
    if (divergenceMs <= 90) return { error: presentationError, source: 'presentation', divergenceMs, reason: 'fresh' };
    if (divergenceMs <= 180) return { error: 0.5 * presentationError + 0.5 * positionError, source: 'blend', divergenceMs, reason: 'blend' };
    return { error: positionError, source: 'position', divergenceMs, reason: 'divergent' };
  }

  // Local drift correction only. Frame intervals widen tolerance; they never
  // authorize a shared action or imply that physical display cadence is known.
  function correction() {
    let since, direction = 0, activeUntil = 0, quietUntil = 0, last, key;
    function reset() { since = last = key = undefined; direction = activeUntil = quietUntil = 0; }
    function update({ now, error, eligible, context, uncertaintyMs = 0, stabilityMs = uncertaintyMs, frameSeconds = 0 }) {
      if (key !== context) reset();
      if (!Number.isFinite(now)) { reset(); return 1; }
      if (last !== undefined && (now < last || now - last > 1500)) {
        since = undefined; direction = activeUntil = 0;
      }
      key = context; last = now;
      const magnitude = Math.abs(error), sign = Math.sign(error);
      if (!eligible || !Number.isFinite(error) || !Number.isFinite(uncertaintyMs) ||
          uncertaintyMs < 0 || uncertaintyMs > 250 ||
          !Number.isFinite(stabilityMs) || stabilityMs < 0 || stabilityMs > 100 ||
          magnitude > 0.65 || sign === 0) {
        since = undefined; direction = activeUntil = 0; return 1;
      }
      const frameMargin = Math.min(0.05, Math.max(0, Number.isFinite(frameSeconds) ? frameSeconds : 0));
      const tolerance = Math.max(0.045 + frameMargin, (uncertaintyMs / 1000) * 1.25);
      const exitTol = Math.max(0.02, uncertaintyMs / 1000, tolerance * 0.45);
      const gainFor = mag => {
        const span = Math.max(0.001, 0.50 - exitTol);
        const ratio = Math.min(1, Math.max(0, (mag - exitTol) / span));
        const step = Math.round((0.005 + ratio * 0.035) / 0.005) * 0.005;
        return Number((1 + direction * step).toFixed(3));
      };
      const stop = timedOut => {
        direction = activeUntil = 0; since = undefined;
        if (timedOut) quietUntil = now + 5000;
      };
      if (direction !== 0) {
        if (sign !== direction || magnitude <= exitTol || now >= activeUntil) {
          stop(now >= activeUntil && magnitude > exitTol && sign === direction);
          return 1;
        }
        return gainFor(magnitude);
      }
      if (magnitude <= tolerance || now < quietUntil) { since = undefined; return 1; }
      if (since === undefined || since.sign !== sign) { since = { at: now, sign }; return 1; }
      if (now - since.at < 1000) return 1;
      direction = sign; activeUntil = now + 10000; since = undefined;
      return gainFor(magnitude);
    }
    return { update, reset };
  }

  // Opt-in local seeks. Interruptions discard drift evidence, but never erase
  // an outstanding seek or its cooldown. Only a new source/context resets those.
  function jumpCorrection() {
    let key, last, since, direction = 0, pending, quietUntil = 0, retries = 0, suspended = false;
    function interrupt() { since = undefined; direction = 0; }
    function reset() { interrupt(); key = last = pending = undefined; quietUntil = 0; retries = 0; suspended = false; }
    /** @param {{now:number,error:number,eligible:boolean,context:string,uncertaintyMs?:number,stabilityMs?:number,buffered:boolean,settled:boolean,frames?:number,position:number}} input */
    function update({ now, error, eligible, context, uncertaintyMs, stabilityMs = uncertaintyMs, buffered, settled, frames, position }) {
      if (key !== context) reset();
      if (!Number.isFinite(now)) { interrupt(); return false; }
      // Missing observations cannot count as sustained drift. Preserve cooldown
      // through backgrounding/refill; performance.now is monotonic in the player.
      if (last !== undefined && (now < last || now - last > 1500)) interrupt();
      key = context; last = now;
      if (pending) {
        pending.at ??= now;
        const elapsed = Math.max(0, (now - pending.at) / 1000);
        if (settled && Number.isFinite(frames) && frames >= pending.frames + 2) {
          if (position >= pending.target - .1 && position <= pending.target + elapsed + .1 &&
              (!Number.isFinite(error) || Math.abs(error) < .2)) {
            pending = undefined; quietUntil = now + 8000; retries = 0; suspended = false;
          } else if (elapsed >= 3) {
            if (retries < 1) { pending = undefined; quietUntil = now + 30000; retries++; }
            else suspended = true;
          }
        }
        interrupt(); return false;
      }
      const magnitude = Math.abs(error), sign = Math.sign(error);
      if (!eligible || !buffered || !Number.isFinite(frames) || frames <= 0 || now < quietUntil || !Number.isFinite(error) || magnitude < .25 || magnitude > .65 ||
          !Number.isFinite(uncertaintyMs) || uncertaintyMs < 0 || uncertaintyMs > 125 || uncertaintyMs / 1000 >= magnitude / 2 ||
          !Number.isFinite(stabilityMs) || stabilityMs < 0 || stabilityMs > 50) {
        interrupt(); return false;
      }
      if (sign !== direction) { interrupt(); direction = sign; }
      since ??= now;
      return now - since >= 1000;
    }
    /** @param {{now?:number,frames?:number,target:number,context:string}} input */
    function committed({ now, frames, target: jumpTarget, context }) {
      // Without decoded-frame evidence, remain blocked until source replacement
      // or a deliberate mode change. Large-error recovery remains independent.
      if (key !== context) reset();
      key = context;
      pending = { at: Number.isFinite(now) ? now : undefined, frames: Number.isFinite(frames) ? frames : Infinity, target: jumpTarget };
      interrupt();
    }
    return { update, committed, interrupt, reset, suspended: () => suspended };
  }

  function bufferedAhead(buffered, position) {
    if (!buffered || !Number.isFinite(buffered.length)) return 0;
    for (let i = 0; i < buffered.length; i++) {
      if (position >= buffered.start(i) - .05 && position < buffered.end(i)) return buffered.end(i) - position;
    }
    return 0;
  }

  function readinessBuffered(buffered, position, duration) {
    // Muxed audio/video may start a few frames after zero. Only tolerate this
    // bounded leading gap at the source origin, never holes elsewhere.
    const start = position === 0 && buffered && buffered.length && buffered.start(0) <= .25 ? Math.max(0, buffered.start(0)) : position;
    return bufferedAhead(buffered, start) >= Math.min(2, Math.max(0, duration - start));
  }

  // Observation duration follows the monotonic clock, not Date.now() or a
  // freshly jittering poll offset. A server clock step starts a new boundary.
  // Slow polls cannot establish/rebase this clock or extend its freshness.
  function observationClock() {
    let epoch, anchor, lastPoll, revision = 0;
    return {
      update(nextEpoch, serverNow, sent, received) {
        if (epoch !== nextEpoch) { epoch = nextEpoch; anchor = undefined; lastPoll = undefined; revision++; }
        const rtt = received - sent;
        if (!Number.isFinite(serverNow) || !Number.isFinite(rtt) || rtt < 0 || rtt > 1000) return revision;
        const predicted = anchor && anchor.wall + received - anchor.mono;
        if (!anchor || predicted < serverNow - 250 || predicted > serverNow + rtt + 250) {
          anchor = { wall: serverNow + rtt / 2, mono: received }; revision++;
        }
        lastPoll = received; return revision;
      },
      sample(mono) { return anchor && mono >= lastPoll && mono - lastPoll <= 3000 ? anchor.wall + mono - anchor.mono : undefined; }
    };
  }

  return {
    MAX_CLOCK_SAMPLE_AGE_MS: MAX_AGE,
    CLOCK_WINDOW_MS: WINDOW,
    clock,
    target,
    presentation,
    controlSignal,
    alarm,
    correction,
    jumpCorrection,
    bufferedAhead,
    readinessBuffered,
    observationClock
  };
}

export const {
  MAX_CLOCK_SAMPLE_AGE_MS,
  CLOCK_WINDOW_MS,
  clock,
  target,
  presentation,
  controlSignal,
  alarm,
  correction,
  jumpCorrection,
  bufferedAhead,
  readinessBuffered,
  observationClock
} = createTimingApi();
