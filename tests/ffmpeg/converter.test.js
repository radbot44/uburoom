'use strict';
// The converter with real FFmpeg, on a small synthetic film: picture and sound from one read
// of the source, joined sample-exactly. Opt-in (`npm run test:ffmpeg`), since it needs FFmpeg
// and encodes on the CPU for about half a minute.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { AV1, CHUNK, AUDIO_LEAD } = require('../../server/av1');
const { run, findOnPath } = require('../../server/media-tools');

const ffmpeg = findOnPath('ffmpeg'),
  ffprobe = findOnPath('ffprobe');
const RATE = 48000,
  TONE = 440,
  SECONDS = 24;

// A file served the way the media server serves one: ranges, read as the converter asks.
function provider(file) {
  return {
    async request(_start, { method = 'GET', headers = {} } = {}) {
      const size = fs.statSync(file).size;
      const range = /^bytes=(\d+)-(\d*)$/.exec(headers.Range || '');
      const start = range ? Number(range[1]) : 0,
        end = range && range[2] ? Number(range[2]) : size - 1;
      const head = {
        'content-type': 'video/x-matroska',
        'accept-ranges': 'bytes',
        'content-length': String(end - start + 1),
        ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
      };
      if (method === 'HEAD') return new Response(null, { status: range ? 206 : 200, headers: head });
      // Read on pull, so a cancelled read leaves nothing queued (Readable.toWeb throws then).
      const handle = await fs.promises.open(file);
      let at = start;
      const body = new ReadableStream({
        async pull(controller) {
          const length = Math.min(256 * 1024, end + 1 - at);
          if (length <= 0) return (controller.close(), handle.close());
          const { bytesRead, buffer } = await handle.read(Buffer.alloc(length), 0, length, at);
          at += bytesRead;
          controller.enqueue(new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead));
        },
        cancel: () => handle.close(),
      });
      return new Response(body, { status: range ? 206 : 200, headers: head });
    },
  };
}
// The chunk's sound as the player keeps it: its own six seconds from its boundary, mono.
function window(audio, k) {
  const pcm = execFileSync(ffmpeg, ['-v', 'error', '-i', 'pipe:0', '-ac', '1', '-f', 'f32le', 'pipe:1'], {
    input: audio,
    maxBuffer: 64 << 20,
  });
  const samples = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4),
    lead = Math.round(AUDIO_LEAD * RATE);
  return { k, samples: samples.subarray(lead, lead + CHUNK * RATE) };
}
// Where the tone sits in a chunk's window, as a phase in milliseconds, and how loud it is.
function tone({ k, samples }) {
  let sin = 0,
    cos = 0;
  for (let i = RATE; i < samples.length - RATE; i++) {
    const t = k * CHUNK + i / RATE;
    sin += samples[i] * Math.sin(2 * Math.PI * TONE * t);
    cos += samples[i] * Math.cos(2 * Math.PI * TONE * t);
  }
  return { phase: (Math.atan2(cos, sin) / (2 * Math.PI * TONE)) * 1000, level: Math.hypot(sin, cos) };
}

test('converted chunks come from one read of the source and join on one sound timeline', { skip: !ffmpeg }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-converter-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Keyframes every 2 s, AC-3 5.1 sound, and a start time that is not zero, as on many rips.
  const film = path.join(directory, 'film.mkv');
  execFileSync(ffmpeg, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `testsrc2=s=320x180:r=24:d=${SECONDS}`],
    ...['-f', 'lavfi', '-i', `sine=frequency=${TONE}:sample_rate=${RATE}:duration=${SECONDS}`],
    ...['-map', '0', '-map', '1', '-c:v', 'libx264', '-g', '48', '-pix_fmt', 'yuv420p'],
    ...['-c:a', 'ac3', '-ac', '6', '-output_ts_offset', '0.042', film],
  ]);
  const encodes = { decoded: 0, read: 0 };
  const manager = () =>
    new AV1(
      { ffmpegPath: ffmpeg, ffprobePath: ffprobe, transcoding: { encoder: 'software' } },
      (binary, args, ...rest) => {
        // Sound that reads the source opens its URL; the encoder probe opens a generated input.
        if (args.includes('libopus') && (args.includes('pipe:0') || args.some(arg => /^http:/.test(arg))))
          encodes[args.includes('pipe:0') ? 'decoded' : 'read']++;
        return run(binary, args, ...rest);
      },
    );
  const source = { id: '1', partId: '1', principal: 'p', duration: SECONDS, start: 'file', provider: provider(film) };
  const convert = async (from, count) => {
    const av1 = manager(),
      lease = av1.acquire(source, '720p4', false, 'vp9'),
      chunks = [];
    try {
      for (let k = from; k < from + count; k++) {
        const chunk = await av1.chunk(lease, k, AbortSignal.timeout(120000));
        assert.ok(chunk.video.length > 100, `chunk ${k} has a picture`);
        chunks.push(window(chunk.audio, k));
      }
    } finally {
      av1.release(lease);
      await av1.close();
    }
    return chunks;
  };

  const fromStart = await convert(0, 4);
  assert.deepEqual(encodes, { decoded: 4, read: 0 }, "every chunk's sound comes from the run's own read");
  const tones = fromStart.map(tone);
  for (const { phase } of tones.slice(1))
    assert.ok(Math.abs(phase - tones[0].phase) < 0.001, `every chunk keeps the tone's phase (${phase} ms)`);
  for (const { level } of tones)
    assert.ok(Math.abs(level / tones[1].level - 1) < 0.01, 'the first chunk is as loud as the rest');

  // A seek: a new process from chunk 2, which still has sound to settle on before it.
  await t.test("a seek's sound lands where the same chunk from the start does", async () => {
    const seeked = await convert(2, 2);
    for (const [i, chunk] of seeked.entries()) {
      const before = fromStart[i + 2].samples;
      let most = 0;
      for (let j = 0; j < before.length; j++) most = Math.max(most, Math.abs(before[j] - chunk.samples[j]));
      assert.ok(most < 1e-4, `chunk ${chunk.k} after a seek matches the same chunk from the start (${most})`);
    }
  });
});
