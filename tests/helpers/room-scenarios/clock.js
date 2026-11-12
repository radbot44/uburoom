'use strict';
// Scenario time. The server reads time only through Date, setTimeout,
// setInterval and performance.now; all four follow this clock while it is
// installed. Monotonic time (performance.now and the timers) only moves with
// tick(). Wall time (Date) follows it too, but stepWall() can move it alone,
// like an NTP correction. Clients in a scenario keep server time, so they use
// scenarioNow(), which a wall step does not touch. setImmediate, sockets and the storage worker stay real so I/O
// still completes between ticks.
const { mock } = require('node:test');
const realSetTimeout = globalThis.setTimeout,
  realClearTimeout = globalThis.clearTimeout;
const realPerformanceNow = Object.getPrototypeOf(globalThis.performance).now.bind(globalThis.performance);
const START = Date.UTC(2026, 0, 5, 12, 0, 0);
const STEP_MS = 100;
/** Real (not scenario) delay and elapsed time, for waiting on I/O. */
const realDelay = ms => new Promise(resolve => realSetTimeout(resolve, ms));
const realNow = () => realPerformanceNow();
/** Real-time callback; returns its cancel function. */
function realTimer(ms, action) {
  const timer = realSetTimeout(action, ms);
  return () => realClearTimeout(timer);
}

let mockNow = () => Date.now();
/** Scenario server time: advances with tick() only, never with stepWall(). */
const scenarioNow = () => mockNow();

function installClock() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const performance = globalThis.performance;
  const mocked = Date.now;
  let wallOffset = 0;
  mockNow = () => mocked();
  Date.now = () => mocked() + wallOffset;
  // Monotonic time is a fixed offset from scenario time.
  performance.now = () => mocked() - START + 1000;
  return {
    /** Milliseconds since the scenario started. */
    elapsed: () => mocked() - START,
    /** Steps the wall clock alone by `ms` (negative for backwards); timers and monotonic time are unaffected. */
    stepWall(ms) {
      wallOffset += ms;
    },
    /** Advances in small increments so each timer runs close to its own due time. */
    tick(ms) {
      for (let left = ms; left > 0; left -= STEP_MS) mock.timers.tick(Math.min(STEP_MS, left));
    },
    uninstall() {
      delete performance.now;
      mockNow = () => Date.now();
      mock.timers.reset();
    },
  };
}
module.exports = { installClock, scenarioNow, realDelay, realNow, realTimer, START };
