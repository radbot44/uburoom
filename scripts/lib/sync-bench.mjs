// @ts-check
/* Deterministic clock and drift-controller simulation bench.
 *
 * Runs the real `shared/sync/timing.mjs` clock filter and rate controller against simulated networks and a
 * simple player model. Simulation only: it says nothing about real browsers, audio output delay or networks.
 * No Math.random(), wall clock or real timers: the same seed always produces byte-identical results.
 */
import { createTimingApi } from '../../shared/sync/timing.mjs';

// ---- Owner-agreed targets (2026-11-10). Percentages are 0-100.
export const TARGET_CONVERGENCE_FROM_MS = 150;
export const TARGET_CONVERGENCE_ERROR_MS = 20;
export const TARGET_CONVERGENCE_WITHIN_S = 15;
export const TARGET_SPREAD_P95_MS = 50;
export const TARGET_CLOCK_USABLE_PERCENT = 99;
export const TARGET_NON_NORMAL_RATE_PERCENT = 2;

export const TARGET_START_SPREAD_P95_MS = 30;
const START_JITTER_MS = 5;

export const DEFAULT_SEED = 20261110;

// ---- Seeded pseudo-random numbers (mulberry32). Sub-streams come from hashing labels into the seed.
export function deriveSeed(seed, ...labels) {
  let h = 0x811c9dc5 ^ seed;
  for (const ch of labels.join('\u0000')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h >>> 0;
}

export function createRng(seed) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    uniform: (low, high) => low + (high - low) * next(),
    exponential: mean => -Math.log(1 - next()) * mean,
    normal: () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next()),
  };
}

// ---- Network profiles. Delays in ms; jitter is the mean of an exponential added to each direction.
export const PROFILES = Object.freeze({
  wired: { label: 'wired', upMs: 20, downMs: 20, jitterMs: 3 },
  wifi: { label: 'Wi-Fi', upMs: 15, downMs: 15, jitterMs: 25 },
  mobile: { label: 'mobile', upMs: 40, downMs: 40, jitterMs: 60 },
  // Asymmetric path, heavy jitter, random loss, and bursts (two-state) that add delay to the reply and lose more.
  bad: {
    label: 'bad',
    upMs: 30,
    downMs: 70,
    jitterMs: 80,
    lossProbability: 0.04,
    burst: { enterProbability: 0.03, exitProbability: 0.12, extraDownMs: 150, lossProbability: 0.3 },
  },
});

const SERVER_OFFSET_MS = 5_000_000; // server wall clock = client stopwatch + this
const MONO_BASE_MS = 1000;
const SERVER_PROCESSING_MS = 0.3;
const POLL_MS = 1000; // clock exchange cadence (web/watch-transport.js)
const TICK_MS = 500; // drift-control cadence (shared/sync/client-sync.mjs)
const SEEK_THRESHOLD_S = 0.65;
const BASE_POSITION_S = 600;

/**
 * One viewer: a clock over a simulated network, a simple player and the real drift controller.
 * Time is in simulated client-stopwatch milliseconds; the run starts playing at `warmupS`.
 * @param {{profile:keyof typeof PROFILES, seed:number, seconds:number, warmupS?:number, player?:boolean,
 *   fps?:number, initialOffsetMs?:number, startDelayMs?:number, driftPpm?:number, noiseMs?:number,
 *   seekCostMs?:number, rateLagMs?:number, startAheadMs?:number, presentation?:boolean}} options
 * With `presentation`, the controller reads its error the way the browser does: per-frame presentation samples
 * (each with the measurement noise) smoothed by shared/sync/timing.mjs presentation(), chosen by controlSignal().
 */
export function simulateViewer(options) {
  const {
    profile: profileId,
    seed,
    seconds,
    warmupS = 0,
    player: withPlayer = true,
    fps = 24,
    initialOffsetMs = 0,
    startDelayMs,
    driftPpm = 0,
    noiseMs = 3,
    seekCostMs = 250,
    rateLagMs = 100,
    startAheadMs = 0, // start-delay compensation: the paused player was seeked this far ahead before the alarm
    presentation: withPresentation = false,
  } = options;
  const profile = PROFILES[profileId];
  const rng = createRng(deriveSeed(seed, 'viewer', profileId));
  const timing = createTimingApi();
  let mono = 0;
  const clock = timing.clock({ monotonic: () => MONO_BASE_MS + mono, wall: () => MONO_BASE_MS + mono + 777 });
  const control = timing.correction();
  const frames = timing.presentation();
  let presentedFrames = 0;
  const startMs = warmupS * 1000;
  const totalMs = startMs + seconds * 1000;

  // ---- Build the event list up front so every random draw happens in a fixed order.
  const events = [];
  let seq = 0;
  const push = (t, order, run) => events.push({ t, order, seq: seq++, run });
  let inBurst = false;
  for (let t0 = rng.uniform(0, POLL_MS); t0 < totalMs; t0 += POLL_MS) {
    const burst = profile.burst;
    if (burst) inBurst = inBurst ? rng.next() >= burst.exitProbability : rng.next() < burst.enterProbability;
    const loss = inBurst ? profile.burst.lossProbability : (profile.lossProbability ?? 0);
    const lost = rng.next() < loss;
    const up = profile.upMs + rng.exponential(profile.jitterMs);
    const down = profile.downMs + rng.exponential(profile.jitterMs) + (inBurst ? profile.burst.extraDownMs : 0);
    let request;
    push(t0, 0, () => (request = clock.begin()));
    if (lost) continue;
    const arrival = t0 + up + SERVER_PROCESSING_MS + down;
    push(arrival, 1, () => {
      const t2 = Math.round(MONO_BASE_MS + t0 + up + SERVER_OFFSET_MS);
      const t3 = Math.round(MONO_BASE_MS + t0 + up + SERVER_PROCESSING_MS + SERVER_OFFSET_MS);
      const ok = clock.add(request, {
        serverReceivedAt: t2,
        serverSentAt: t3,
        serverProcessingMs: SERVER_PROCESSING_MS,
        clockEpoch: 'bench',
      });
      stats.exchanges++;
      if (ok) stats.accepted++;
    });
  }

  // ---- Clock statistics (all reads, including warm-up) and player state.
  const stats = { exchanges: 0, accepted: 0, reads: 0, valid: 0, invalidRun: 0, longestInvalidMs: 0 };
  const clockErrors = [];
  const uncertainties = [];
  const position = { p: BASE_POSITION_S, last: startMs, stallUntil: Infinity, rate: 1, pending: undefined };
  let holdUntil = Infinity;
  let commanded = 1;
  let seeks = 0;
  let started = !withPlayer;
  let startErrorMs = NaN; // true error when the first frame moves, for a scheduled start with a valid clock
  const errorsMs = []; // true error on the common sampling grid: target - position (positive = behind)
  const rates = [];
  const drift = 1 + driftPpm * 1e-6;
  const trueTarget = t => BASE_POSITION_S + (t - startMs) / 1000;

  function advance(to) {
    if (to <= position.last) return;
    const bounds = [position.last, to];
    for (const b of [position.stallUntil, position.pending?.at]) if (b > position.last && b < to) bounds.push(b);
    bounds.sort((a, b) => a - b);
    for (let i = 0; i + 1 < bounds.length; i++) {
      const [a, b] = [bounds[i], bounds[i + 1]];
      if ((a + b) / 2 >= position.stallUntil) {
        const rate = position.pending && (a + b) / 2 >= position.pending.at ? position.pending.rate : position.rate;
        position.p += ((b - a) / 1000) * rate * drift;
      }
    }
    if (position.pending && to >= position.pending.at) {
      position.rate = position.pending.rate;
      position.pending = undefined;
    }
    position.last = to;
  }

  function setRate(rate, t) {
    if (rate === commanded) return;
    commanded = rate;
    position.pending = { rate, at: t + rateLagMs };
  }

  // Clock read in every control tick, as the real loop does.
  function onTick(t) {
    const reading = clock.read();
    stats.reads++;
    if (reading.valid) {
      stats.valid++;
      stats.invalidRun = 0;
      clockErrors.push(Math.abs(reading.serverTime - (MONO_BASE_MS + t + SERVER_OFFSET_MS)));
      uncertainties.push(reading.clockUncertaintyMs);
    } else {
      stats.invalidRun += TICK_MS;
      stats.longestInvalidMs = Math.max(stats.longestInvalidMs, stats.invalidRun);
    }
    if (!withPlayer || t < startMs) return;
    if (!started) {
      // Start was deferred because the clock was invalid at the scheduled instant: join late at the expected position.
      if (!reading.valid) return;
      started = true;
      advance(t);
      position.p = BASE_POSITION_S + (reading.serverTime - SERVER_OFFSET_MS - MONO_BASE_MS - startMs) / 1000;
      position.stallUntil = t + startDelayMs;
      holdUntil = position.stallUntil + 1000;
      return;
    }
    advance(t);
    const control_ = (eligible, diff, frameSeconds) =>
      control.update({
        now: t,
        error: diff,
        eligible,
        context: 'bench',
        uncertaintyMs: reading.clockUncertaintyMs,
        stabilityMs: reading.clockStabilityMs ?? reading.clockUncertaintyMs,
        frameSeconds,
      });
    if (t < holdUntil || !reading.valid || t < position.stallUntil) {
      setRate(control_(false, 0, 1 / fps), t);
      return;
    }
    const estimate = BASE_POSITION_S + (reading.serverTime - SERVER_OFFSET_MS - MONO_BASE_MS - startMs) / 1000;
    const measured = Math.round(position.p * fps) / fps + (rng.normal() * noiseMs) / 1000;
    const diff = estimate - measured;
    if (Math.abs(diff) > SEEK_THRESHOLD_S) {
      // The client seeks to the expected position; the player then resumes after the seek cost.
      frames.interrupt('seek');
      seeks++;
      position.p = estimate;
      position.stallUntil = t + seekCostMs;
      holdUntil = position.stallUntil + TICK_MS;
      setRate(control_(false, 0, 1 / fps), t);
      return;
    }
    if (!withPresentation) return setRate(control_(true, diff, 1 / fps), t);
    const signal = timing.controlSignal({
      target: estimate,
      currentTime: measured,
      presentation: frames.read(t, { context: 'bench', clockRevision: reading.clockRevision }),
      clockValid: true,
    });
    setRate(control_(true, signal.error, 1 / fps), t);
  }

  // One presentation sample per displayed frame, as requestVideoFrameCallback reports it.
  function onFrame(t) {
    if (!started || t < position.stallUntil || t < startMs) return;
    const reading = clock.read();
    if (!reading.valid) return;
    advance(t);
    const target = BASE_POSITION_S + (reading.serverTime - SERVER_OFFSET_MS - MONO_BASE_MS - startMs) / 1000;
    const mediaTime = Math.round(position.p * fps) / fps + (rng.normal() * noiseMs) / 1000;
    frames.frame(
      t,
      { mediaTime, expectedDisplayTime: t, presentedFrames: ++presentedFrames },
      { target, context: 'bench', clockRevision: reading.clockRevision },
    );
  }

  if (withPlayer) {
    push(startMs, 1.5, () => {
      const reading = clock.read();
      if (startDelayMs === undefined) {
        // Fixed initial error: playing immediately, offset from the target.
        started = true;
        position.p = BASE_POSITION_S - initialOffsetMs / 1000;
        position.stallUntil = 0;
        holdUntil = startMs;
        return;
      }
      if (!reading.valid) {
        // The real client cancels the armed start when the clock is invalid and holds paused (client-sync.mjs).
        started = false;
        return;
      }
      // The alarm fires when the clock estimate reaches the start; clock error shifts the instant.
      const clockError = reading.serverTime - (MONO_BASE_MS + startMs + SERVER_OFFSET_MS);
      started = true;
      position.p = BASE_POSITION_S + startAheadMs / 1000;
      position.stallUntil = startMs - clockError + startDelayMs;
      startErrorMs = position.stallUntil - startMs - startAheadMs;
      holdUntil = position.stallUntil + 1000;
    });
    for (let t = startMs; t <= totalMs; t += TICK_MS) {
      push(t, 2.5, () => {
        advance(t);
        errorsMs.push(started || startDelayMs === undefined ? (trueTarget(t) - position.p) * 1000 : NaN);
        rates.push(commanded);
      });
    }
  }
  const phase = rng.uniform(0, TICK_MS);
  for (let t = phase; t < totalMs; t += TICK_MS) push(t, 2, () => onTick(t));
  if (withPresentation) for (let t = startMs; t < totalMs; t += 1000 / fps) push(t, 1.5, () => onFrame(t));

  events.sort((a, b) => a.t - b.t || a.order - b.order || a.seq - b.seq);
  for (const event of events) {
    mono = event.t;
    event.run();
  }

  return {
    errorsMs,
    rates,
    seeks,
    startErrorMs,
    clock: {
      exchanges: stats.exchanges,
      accepted: stats.accepted,
      reads: stats.reads,
      valid: stats.valid,
      longestInvalidS: stats.longestInvalidMs / 1000,
      errorsMs: clockErrors,
      uncertaintiesMs: uncertainties,
    },
  };
}

// ---- Aggregation helpers
const round1 = x => (Number.isFinite(x) ? Math.round(x * 10) / 10 : x);
function quantile(values, q) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : NaN;
}
const median = values => quantile(values, 0.5);

/** Last continuous stretch with |error| under the threshold, as seconds from the start; Infinity if it never holds. */
function settleSeconds(errorsMs, thresholdMs) {
  let i = errorsMs.length;
  while (i > 0 && Math.abs(errorsMs[i - 1]) < thresholdMs) i--;
  return i === errorsMs.length ? Infinity : (i * TICK_MS) / 1000;
}

// ---- Rows
/**
 * @typedef {{key:string, scenario:string, profile:string, metric:string, unit:'ms'|'s'|'%'|'count',
 *   better:'lower'|'higher', value:number, target?:{id:string, op:'<'|'<='|'>=', limit:number, text:string}}} BenchRow
 */

export const TARGETS = Object.freeze({
  convergence: {
    id: 'T1',
    text: `${TARGET_CONVERGENCE_FROM_MS} ms to under ${TARGET_CONVERGENCE_ERROR_MS} ms within ${TARGET_CONVERGENCE_WITHIN_S} s`,
  },
  spread: { id: 'T2', text: `two-viewer spread p95 under ${TARGET_SPREAD_P95_MS} ms` },
  usable: { id: 'T3', text: `clock usable at least ${TARGET_CLOCK_USABLE_PERCENT}% (Wi-Fi, mobile)` },
  startSpread: {
    id: 'T5',
    text: `two-viewer start spread p95 under ${TARGET_START_SPREAD_P95_MS} ms once the start delay is estimated`,
  },
  nonNormal: { id: 'T4', text: `under ${TARGET_NON_NORMAL_RATE_PERCENT}% of steady-state time at a non-normal speed` },
});

/** Whether a row's value meets its target. Rows without a target return undefined. */
export function meetsTarget(row) {
  if (!row.target) return undefined;
  const { op, limit } = row.target;
  return op === '<' ? row.value < limit : op === '<=' ? row.value <= limit : row.value >= limit;
}

function makeRow(scenario, profile, metric, unit, better, value, target) {
  return {
    key: `${scenario}/${profile}/${metric}`,
    scenario,
    profile,
    metric,
    unit,
    better,
    value: round1(value),
    target,
  };
}

function clockRows(seed, trials) {
  const rows = [];
  for (const profile of Object.keys(PROFILES)) {
    const runs = Array.from({ length: trials }, (_, i) =>
      simulateViewer({
        profile: /** @type {any} */ (profile),
        seed: deriveSeed(seed, 'clock', String(i)),
        seconds: 300,
        player: false,
      }),
    );
    const sum = pick => runs.reduce((a, r) => a + pick(r.clock), 0);
    const usable = (100 * sum(c => c.valid)) / sum(c => c.reads);
    const scenario = 'clock-validity-300s';
    rows.push(
      makeRow(
        scenario,
        profile,
        'usablePercent',
        '%',
        'higher',
        usable,
        profile === 'wifi' || profile === 'mobile'
          ? { ...TARGETS.usable, op: '>=', limit: TARGET_CLOCK_USABLE_PERCENT }
          : undefined,
      ),
      makeRow(
        scenario,
        profile,
        'acceptedPercent',
        '%',
        'higher',
        (100 * sum(c => c.accepted)) / sum(c => c.exchanges),
      ),
      makeRow(
        scenario,
        profile,
        'longestInvalidGapS',
        's',
        'lower',
        Math.max(...runs.map(r => r.clock.longestInvalidS)),
      ),
      makeRow(scenario, profile, 'clockErrorP50Ms', 'ms', 'lower', median(runs.flatMap(r => r.clock.errorsMs))),
      makeRow(
        scenario,
        profile,
        'clockErrorP95Ms',
        'ms',
        'lower',
        quantile(
          runs.flatMap(r => r.clock.errorsMs),
          0.95,
        ),
      ),
    );
  }
  return rows;
}

function convergenceRow(seed, trials, { profile, offsetMs, fps, noiseMs, label, presentation = false }) {
  const seconds = 90;
  const runs = Array.from({ length: trials }, (_, i) =>
    simulateViewer({
      profile,
      seed: deriveSeed(seed, 'conv', label, String(i)),
      seconds,
      warmupS: 15,
      fps,
      initialOffsetMs: offsetMs,
      noiseMs,
      presentation,
    }),
  );
  const scenario = `convergence-${label}`;
  const isTarget = profile === 'wired' && fps === 24 && offsetMs === TARGET_CONVERGENCE_FROM_MS && noiseMs === 3;
  const grid15 = (15 * 1000) / TICK_MS;
  return [
    makeRow(
      scenario,
      profile,
      `settleUnder${TARGET_CONVERGENCE_ERROR_MS}msS`,
      's',
      'lower',
      Math.max(...runs.map(r => settleSeconds(r.errorsMs, TARGET_CONVERGENCE_ERROR_MS))),
      isTarget ? { ...TARGETS.convergence, op: '<=', limit: TARGET_CONVERGENCE_WITHIN_S } : undefined,
    ),
    makeRow(scenario, profile, 'errorAt15sMs', 'ms', 'lower', Math.max(...runs.map(r => Math.abs(r.errorsMs[grid15])))),
    makeRow(
      scenario,
      profile,
      'residualMs',
      'ms',
      'lower',
      median(runs.map(r => median(r.errorsMs.slice(-60).map(Math.abs)))),
    ),
    makeRow(
      scenario,
      profile,
      'seeks',
      'count',
      'lower',
      runs.reduce((a, r) => a + r.seeks, 0),
    ),
  ];
}

function steadyRows(seed, trials) {
  const rows = [];
  for (const profile of Object.keys(PROFILES)) {
    const runs = Array.from({ length: trials }, (_, i) =>
      simulateViewer({
        profile: /** @type {any} */ (profile),
        seed: deriveSeed(seed, 'steady', String(i)),
        seconds: 3600,
        warmupS: 15,
        driftPpm: 100,
      }),
    );
    const rates = runs.flatMap(r => r.rates);
    const scenario = 'steady-drift-100ppm-3600s';
    rows.push(
      makeRow(
        scenario,
        profile,
        'nonNormalRatePercent',
        '%',
        'lower',
        (100 * rates.filter(r => r !== 1).length) / rates.length,
        {
          ...TARGETS.nonNormal,
          op: '<',
          limit: TARGET_NON_NORMAL_RATE_PERCENT,
        },
      ),
      makeRow(
        scenario,
        profile,
        'errorP95Ms',
        'ms',
        'lower',
        quantile(
          runs.flatMap(r => r.errorsMs.map(Math.abs)),
          0.95,
        ),
      ),
      makeRow(
        scenario,
        profile,
        'seeks',
        'count',
        'lower',
        runs.reduce((a, r) => a + r.seeks, 0),
      ),
    );
  }
  return rows;
}

const PAIRS = Object.freeze([
  ['wired', 'wired'],
  ['wired', 'wifi'],
  ['wifi', 'mobile'],
  ['mobile', 'bad'],
]);

function spreadRows(seed, trials) {
  const rows = [];
  const seconds = 900;
  const steadyFromTick = (60 * 1000) / TICK_MS;
  for (const pair of PAIRS) {
    const spreads = [];
    let seeks = 0;
    for (let i = 0; i < trials; i++) {
      const viewers = pair.map((profile, index) => {
        const rng = createRng(deriveSeed(seed, 'spread', pair.join('+'), String(i), String(index)));
        return simulateViewer({
          profile: /** @type {any} */ (profile),
          seed: deriveSeed(seed, 'spread-net', pair.join('+'), String(i), String(index)),
          seconds,
          warmupS: 15,
          // Players start 40 ms to a few hundred ms late and their media clocks differ by tens of ppm.
          startDelayMs: Math.min(400, 40 + rng.exponential(60)),
          driftPpm: rng.uniform(-50, 50),
        });
      });
      seeks += viewers[0].seeks + viewers[1].seeks;
      for (let k = steadyFromTick; k < viewers[0].errorsMs.length; k++) {
        spreads.push(Math.abs(viewers[0].errorsMs[k] - viewers[1].errorsMs[k]));
      }
    }
    const scenario = 'two-viewer-spread-900s';
    const profile = pair.join('+');
    rows.push(
      makeRow(scenario, profile, 'spreadP50Ms', 'ms', 'lower', quantile(spreads, 0.5)),
      makeRow(scenario, profile, 'spreadP95Ms', 'ms', 'lower', quantile(spreads, 0.95), {
        ...TARGETS.spread,
        op: '<',
        limit: TARGET_SPREAD_P95_MS,
      }),
      makeRow(scenario, profile, 'seeks', 'count', 'lower', seeks),
    );
  }
  return rows;
}

/**
 * Scheduled starts: each viewer's player has its own start delay (40 ms + exponential, capped at 400 ms, as in the
 * spread scenario) that varies a little from start to start (normal, sd START_JITTER_MS). The compensated runs seek
 * ahead by the running median that timing.mjs startDelay() holds, as the client does, once two starts have been
 * measured; the uncompensated runs are today's behaviour. Error is true target minus position when the first frame
 * moves, before any drift correction. Starts whose clock was invalid at the alarm are not observed. The estimator is
 * fed the exact delay; real rVFC timing adds frame quantization.
 */
function startRows(seed, trials) {
  const rows = [];
  const starts = 8;
  for (const compensated of [false, true]) {
    for (const pair of PAIRS) {
      const errors = [];
      const spreads = [];
      for (let i = 0; i < trials; i++) {
        const rng = createRng(deriveSeed(seed, 'start', pair.join('+'), String(i)));
        const base = pair.map(() => Math.min(400, 40 + rng.exponential(60)));
        const estimators = pair.map(() => createTimingApi().startDelay());
        for (let k = 0; k < starts; k++) {
          const result = pair.map((profile, index) => {
            const delay = Math.min(400, Math.max(0, base[index] + rng.normal() * START_JITTER_MS));
            const run = simulateViewer({
              profile: /** @type {any} */ (profile),
              seed: deriveSeed(seed, 'start-net', pair.join('+'), String(i), String(index), String(k)),
              seconds: 1,
              warmupS: 15,
              startDelayMs: delay,
              startAheadMs: compensated ? estimators[index].compensationMs('bench') : 0,
            });
            estimators[index].record('bench', delay);
            return run.startErrorMs;
          });
          if (compensated && k < 2) continue;
          for (const error of result) if (Number.isFinite(error)) errors.push(Math.abs(error));
          if (result.every(Number.isFinite)) spreads.push(Math.abs(result[0] - result[1]));
        }
      }
      const scenario = compensated ? 'start-compensated' : 'start-uncompensated';
      const profile = pair.join('+');
      rows.push(
        makeRow(scenario, profile, 'startErrorP95Ms', 'ms', 'lower', quantile(errors, 0.95)),
        makeRow(
          scenario,
          profile,
          'startSpreadP95Ms',
          'ms',
          'lower',
          quantile(spreads, 0.95),
          compensated ? { ...TARGETS.startSpread, op: '<', limit: TARGET_START_SPREAD_P95_MS } : undefined,
        ),
      );
    }
  }
  return rows;
}

/**
 * Run every scenario. Deterministic for a given seed.
 * @param {{seed?:number}} [options]
 * @returns {{seed:number, rows:BenchRow[]}}
 */
export function runBench({ seed = DEFAULT_SEED } = {}) {
  const rows = [...clockRows(seed, 6)];
  for (const offsetMs of [60, 85, 150, 400, 600])
    rows.push(
      ...convergenceRow(seed, 6, { profile: 'wired', offsetMs, fps: 24, noiseMs: 3, label: `${offsetMs}ms-24fps` }),
    );
  for (const fps of [30, 60])
    rows.push(
      ...convergenceRow(seed, 6, { profile: 'wired', offsetMs: 150, fps, noiseMs: 3, label: `150ms-${fps}fps` }),
    );
  for (const profile of ['wifi', 'mobile', 'bad'])
    rows.push(
      ...convergenceRow(seed, 6, {
        profile: /** @type {any} */ (profile),
        offsetMs: 150,
        fps: 24,
        noiseMs: 3,
        label: '150ms-24fps',
      }),
    );
  rows.push(
    ...convergenceRow(seed, 6, { profile: 'wired', offsetMs: 95, fps: 24, noiseMs: 25, label: '95ms-24fps-noise25ms' }),
    ...convergenceRow(seed, 6, {
      profile: 'wired',
      offsetMs: 95,
      fps: 24,
      noiseMs: 25,
      presentation: true,
      label: '95ms-24fps-noise25ms-presentation',
    }),
  );
  rows.push(...steadyRows(seed, 2), ...spreadRows(seed, 10), ...startRows(seed, 10));
  return { seed, rows };
}

/** Margin allowed past the recorded baseline before a regression is reported. */
export function ratchetLimit(row, baseline) {
  const margin = { ms: [3, 0.1], s: [1, 0.1], '%': [1, 0], count: [1, 0.2] }[row.unit];
  const slack = Math.max(margin[0], margin[1] * Math.abs(baseline));
  return row.better === 'lower' ? baseline + slack : baseline - slack;
}

/** Source of scripts/lib/sync-bench-baseline.mjs for the given rows. */
export function formatBaseline(rows) {
  const num = value => (Number.isFinite(value) ? String(value) : 'Infinity');
  const baseline = rows.map(row => `  '${row.key}': ${num(row.value)},`).join('\n');
  const status = rows
    .filter(row => row.target)
    .map(row => `  '${row.key}': { met: ${meetsTarget(row)}, today: ${num(row.value)} },`)
    .join('\n');
  return [
    `// Recorded sync-bench values for shared/sync/timing.mjs (seed ${DEFAULT_SEED}).`,
    '// tests/sync-bench.test.js fails when a metric is worse than its value here by more than ratchetLimit() allows,',
    '// when a target marked met stops being met, and when a target marked unmet starts being met (flip it to true).',
    '// Regenerate with `npm run sync:bench -- --emit-baseline` only after an intentional behaviour change.',
    `export const BASELINE = Object.freeze({\n${baseline}\n});`,
    '',
    "// Each owner-agreed target per row: met today or not, with today's measured value. Unmet targets are data, not skips.",
    `export const TARGET_STATUS = Object.freeze({\n${status}\n});`,
    '',
  ].join('\n');
}

export function formatTable(rows) {
  const fmt = row =>
    Number.isFinite(row.value) ? `${row.value} ${row.unit === 'count' ? '' : row.unit}`.trim() : 'never';
  const lines = rows.map(row => {
    const met = meetsTarget(row);
    return [
      row.scenario,
      row.profile,
      row.metric,
      fmt(row),
      row.target ? `${row.target.id}: ${row.target.op} ${row.target.limit}` : '-',
      met === undefined ? '-' : met ? 'met' : 'NOT MET',
    ];
  });
  const header = ['scenario', 'profile', 'metric', 'today', 'target', 'status'];
  const widths = header.map((h, i) => Math.max(h.length, ...lines.map(l => l[i].length)));
  const render = cells =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [render(header), widths.map(w => '-'.repeat(w)).join('  '), ...lines.map(render)].join('\n');
}
