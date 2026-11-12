// @ts-check
/* The server's one shared time base for room timelines.
 * It is read from the wall clock once, when the clock is created, and from then
 * on only advances with the monotonic clock. A wall-clock step (NTP correction,
 * manual change) therefore never moves a room's position, start times or the
 * time reported to clients, which map to whatever the server reports. Wall time
 * belongs only where it is stored, logged or sent to an outside service.
 */

/**
 * @param {{wallNow?: () => number, monoNow?: () => number}} [options]
 * @returns {{now: () => number, anchor: {wall: number, mono: number}}}
 */
export function createServerClock({ wallNow = () => Date.now(), monoNow = () => globalThis.performance.now() } = {}) {
  const anchor = { wall: wallNow(), mono: monoNow() };
  return {
    anchor,
    /** Milliseconds on the server timeline; never steps, never decreases. */
    now: () => Math.floor(anchor.wall + (monoNow() - anchor.mono)),
  };
}
