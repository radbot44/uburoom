// @ts-check
/* One timer for the page's periodic work. Each job states its period, a multiple of the tick; due jobs run
 * in the order they subscribed. A failing job is reported like any uncaught error and never stops the others. */

export const TICK_MS = 250;

/**
 * @param {{set?: (run: () => void, ms: number) => any, clear?: (timer: any) => void}} [timers]
 */
export function createScheduler({ set = setInterval, clear = clearInterval } = {}) {
  /** @type {Set<{ticks: number, left: number, run: () => void}>} */
  const jobs = new Set();
  let timer;
  function tick() {
    for (const job of [...jobs]) {
      if (!jobs.has(job) || --job.left > 0) continue;
      job.left = job.ticks;
      try {
        job.run();
      } catch (error) {
        queueMicrotask(() => {
          throw error;
        });
      }
    }
  }
  /**
   * Runs `run` every `ms` milliseconds (rounded to whole ticks), first after one period, like setInterval.
   * @param {number} ms
   * @param {() => void} run
   * @returns {() => void} stops the job
   */
  function every(ms, run) {
    const ticks = Math.max(1, Math.round(ms / TICK_MS));
    const job = { ticks, left: ticks, run };
    jobs.add(job);
    timer ??= set(tick, TICK_MS);
    return () => {
      jobs.delete(job);
      if (!jobs.size && timer !== undefined) {
        clear(timer);
        timer = undefined;
      }
    };
  }
  return { every, tick };
}
