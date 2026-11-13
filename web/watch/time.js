// @ts-check
/* The page's one time base. Every module reads time through the object created here:
 * - `serverNow()` is the room's time from the playback clock (shared/sync/timing.mjs). It is undefined while
 *   that clock has no usable estimate; callers then hold what they show or do instead of guessing.
 * - `target(state)` is where the room's timeline is now; undefined under the same condition, except for a
 *   paused timeline, whose position does not depend on the time.
 * - `mono()` is local monotonic time for intervals, timeouts and freshness; `wall()` is the local date for
 *   things stamped with it (sign-in expiry, saved preferences, diagnostics rows).
 * - `setTimeout` / `clearTimeout` schedule one-off work; periodic work goes through the scheduler.
 * The observation clock and presentation timing live here too, so a test can replace all time at once. */
import * as timing from '../../shared/sync/timing.mjs';
import * as playback from '../playback-policy.js';

/**
 * @param {{mono?: () => number, wall?: () => number}} [sources]
 */
export function createTime({ mono = () => performance.now(), wall = () => Date.now() } = {}) {
  const timers = { setTimeout: (run, ms) => setTimeout(run, ms), clearTimeout: id => clearTimeout(id) };
  const clock = timing.clock({ monotonic: mono, wall });
  return {
    clock,
    observation: playback.observationClock(),
    presentation: timing.presentation(),
    mono,
    wall,
    ...timers,
    /** @param {number} [at] */
    read: at => clock.read(at),
    serverNow: () => clock.read().serverTime,
    /** @param {any} state */
    target: state => timing.target(state, clock.read().serverTime),
  };
}
