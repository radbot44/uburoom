'use strict';
// Scenario time. The server reads time only through Date, setTimeout,
// setInterval and performance.now; all four follow this clock while it is
// installed. setImmediate, sockets and the storage worker stay real so I/O
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

function installClock() {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  const performance = globalThis.performance;
  // Monotonic time is a fixed offset from scenario wall time.
  performance.now = () => Date.now() - START + 1000;
  return {
    /** Milliseconds since the scenario started. */
    elapsed: () => Date.now() - START,
    /** Advances in small increments so each timer runs close to its own due time. */
    tick(ms) {
      for (let left = ms; left > 0; left -= STEP_MS) mock.timers.tick(Math.min(STEP_MS, left));
    },
    uninstall() {
      delete performance.now;
      mock.timers.reset();
    },
  };
}
module.exports = { installClock, realDelay, realNow, realTimer, START };
