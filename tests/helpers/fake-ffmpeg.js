'use strict';
const { PlaybackError } = require('../../server/errors');

// A fake long-running FFmpeg. From its -ss it makes each chunk's segment for every output, in
// order, after the run's source gate lets it read, as the bridge holds a real process. The
// `chunk` hook can shape (sizes per output), fail (throw) or end (false) a chunk. Its sound
// copy starts `copyLead` seconds before the seek point, as a seek to the keyframe before it
// does, and its decoders lay down silence before each chunk, up to the end of that chunk's
// window, unless `decoded` returns false for (args, n).
function fakeRuns({ duration = 60, chunk, read = false, decoded, copyLead = 2 } = {}) {
  const runs = { started: [], aborted: [], produced: [], decoders: [], manager: undefined };
  runs.segments = async (_binary, args, signal, { onSegment, ended, sound }) => {
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
      outputs = args.filter(arg => /^segments:\d+$/.test(arg)).length,
      emitted = (sound?.commands || []).map(() => 0);
    if (sound) {
      runs.decoders.push(sound.commands);
      sound.onCopy?.(copyHead(sound.commands.length, Math.max(0, start - copyLead)));
    }
    let gate;
    try {
      gate = runs.manager?.inputs.get(new URL(url).pathname)?.gate;
    } catch {
      /* A stubbed input has no bridge entry. */
    }
    for (let n = 0; n * 6 < limit && start + n * 6 < duration; n++) {
      if (read) await Promise.race([fetch(url).then(response => response.arrayBuffer()), stopped]);
      else await Promise.race([gate?.wait(), stopped]);
      // The source is read, and its sound decoded, ahead of the picture's encoder.
      if (sound && decoded?.(args, n) !== false) {
        const samples = (n * 288000 + 299832) * 8;
        sound.commands.forEach((_, i) => {
          if (samples > emitted[i]) sound.onData(i, Buffer.alloc(samples - emitted[i]));
          emitted[i] = Math.max(emitted[i], samples);
        });
      }
      const result = await Promise.race([chunk?.(args, n, signal), stopped]);
      if (result === false) break;
      for (let i = 0; i < outputs; i++) await onSegment(i, n, Buffer.alloc(result?.[i] ?? 200 + i));
      runs.produced[at]++;
    }
    if (signal.aborted) throw signal.reason;
    sound?.commands.forEach((_, i) => sound.onEnd(i, true));
    if (!ended()) throw Object.assign(new PlaybackError('The source stopped before its end.'), { exitFailure: true });
  };
  return runs;
}
// The head of a live Matroska copy: one cluster at `seconds`, then a block of each track.
function copyHead(tracks, seconds) {
  const unknown = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
    time = Buffer.alloc(4);
  time.writeUInt32BE(Math.round(seconds * 1000));
  const blocks = Array.from({ length: tracks }, (_, i) => [0xa3, 0x84, 0x81 + i, 0, 0, 0x80]);
  return Buffer.from([
    ...[0x18, 0x53, 0x80, 0x67, ...unknown],
    ...[0x1f, 0x43, 0xb6, 0x75, ...unknown],
    ...[0xe7, 0x84, ...time],
    ...blocks.flat(),
  ]);
}
// Probe, FFprobe and per-chunk sound for a fake source; `audio` also sees an encode's samples.
function fakeTools(info, { audio, probe } = {}) {
  return async (_binary, args, signal, _timeout, _maxOutput, _diagnostic, options) => {
    if (args.includes('-show_entries')) return Buffer.from(JSON.stringify(info));
    if (args.some(arg => String(arg).startsWith('testsrc2'))) {
      await probe?.(args, signal);
      return Buffer.alloc(200);
    }
    if (args.includes('libopus')) await audio?.(args, signal, options?.input);
    return Buffer.alloc(50);
  };
}
module.exports = { fakeRuns, fakeTools };
