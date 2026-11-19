'use strict';
const { PlaybackError } = require('../../server/errors');

// A fake long-running FFmpeg. From its -ss it makes each chunk's segment for every output, in
// order, after the run's source gate lets it read, as the bridge holds a real process. The
// `chunk` hook can shape (sizes per output), fail (throw) or end (false) a chunk.
function fakeRuns({ duration = 60, chunk, read = false } = {}) {
  const runs = { started: [], aborted: [], produced: [], manager: undefined };
  runs.segments = async (_binary, args, signal, { onSegment, ended }) => {
    const at = runs.started.push(args) - 1;
    runs.produced[at] = 0;
    const stopped = new Promise((_, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          runs.aborted[at] = true;
          reject(signal.reason);
        },
        { once: true },
      ),
    );
    stopped.catch(() => {});
    const url = args[args.indexOf('-i') + 1],
      start = Number(args[args.indexOf('-ss') + 1]),
      limit = args.includes('-t') ? Number(args[args.indexOf('-t') + 1]) : Infinity,
      outputs = args.filter(arg => /^segments:\d+$/.test(arg)).length;
    let gate;
    try {
      gate = runs.manager?.inputs.get(new URL(url).pathname)?.gate;
    } catch {
      /* A stubbed input has no bridge entry. */
    }
    for (let n = 0; n * 6 < limit && start + n * 6 < duration; n++) {
      if (read) await Promise.race([fetch(url).then(response => response.arrayBuffer()), stopped]);
      else await Promise.race([gate?.wait(), stopped]);
      const result = await Promise.race([chunk?.(args, n, signal), stopped]);
      if (result === false) break;
      for (let i = 0; i < outputs; i++) await onSegment(i, n, Buffer.alloc(result?.[i] ?? 200 + i));
      runs.produced[at]++;
    }
    if (signal.aborted) throw signal.reason;
    if (!ended()) throw Object.assign(new PlaybackError('The source stopped before its end.'), { exitFailure: true });
  };
  return runs;
}
// Probe, FFprobe and per-chunk sound for a fake source.
function fakeTools(info, { audio, probe } = {}) {
  return async (_binary, args, signal) => {
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify(info));
    if (args.some(arg => String(arg).startsWith('testsrc2'))) {
      await probe?.(args, signal);
      return Buffer.alloc(200);
    }
    if (args.includes('libopus')) await audio?.(args, signal);
    return Buffer.alloc(50);
  };
}
module.exports = { fakeRuns, fakeTools };
