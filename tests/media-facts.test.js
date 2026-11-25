'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { CacheBudget, sizeOf } = require('../server/cache-budget');
const { MediaFacts } = require('../server/media-facts');
const { MediaPipeline } = require('../server/media-pipeline');
const { MediaChecks } = require('../server/media-check');

test('CacheBudget measures Map, Set, ArrayBuffer views and rejects oversized single entries without evicting existing ones', () => {
  const bytes = new Uint8Array(1024);
  const viewSize = sizeOf(bytes, 100000);
  assert.equal(viewSize, 1024 + 64, 'non-Buffer Uint8Array is measured by byteLength + 64, not indexed keys');

  const ab = new ArrayBuffer(512);
  assert.equal(sizeOf(ab, 100000), 512 + 64);

  const assetMap = new Map([
    ['data', Buffer.alloc(4096)],
    ['font-0', Buffer.alloc(2048)],
  ]);
  const mapSize = sizeOf(assetMap, 100000);
  assert.ok(mapSize >= 6144 + 64, 'Map<string, Buffer> accounts for full Buffer byteLengths');

  const set = new Set([Buffer.alloc(1024), 'abc']);
  assert.ok(sizeOf(set, 100000) >= 1024 + 64);

  const budget = new CacheBudget(8192);
  const cache = new Map();
  const small = { v: Buffer.alloc(1024) };
  cache.set('small', small);
  assert.equal(budget.retain(cache, 'small', small, small), true);
  assert.ok(budget.bytes > 1024 && budget.bytes <= 8192);

  // Oversized single entry must be rejected without evicting 'small'
  const huge = { v: Buffer.alloc(16384) };
  cache.set('huge', huge);
  assert.equal(budget.retain(cache, 'huge', huge, huge), false);
  assert.equal(cache.has('huge'), false);
  assert.equal(cache.get('small'), small, 'existing entry survives oversized admission rejection');

  assert.equal(budget.delete(small), true);
  assert.equal(budget.bytes, 0);
  assert.equal(cache.size, 0);
});

test('MediaFacts coalesces concurrent callers by sourceKey, isolates unshared principals, and self-invalidates', async () => {
  let probes = 0;
  let releaseFirst;
  const firstStarted = Promise.withResolvers();

  const pipeline = new MediaPipeline({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  pipeline.av1.input = async (sourceOrFn, _signal, action) => {
    const src = typeof sourceOrFn === 'function' ? sourceOrFn() : sourceOrFn;
    assert.ok(src, 'live source resolved');
    return action('http://127.0.0.1:0/fixture');
  };
  pipeline.av1.run = async (binary, args, signal) => {
    if (binary === 'ffprobe' && args.some(a => String(a).includes('stream_tags='))) {
      probes++;
      if (probes === 1) {
        firstStarted.resolve();
        await new Promise((resolve, reject) => {
          releaseFirst = resolve;
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return Buffer.from(
        JSON.stringify({
          format: { duration: '120', bit_rate: '4000000', start_time: '0' },
          streams: [
            { index: 0, codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '24/1' },
            { index: 1, codec_type: 'audio', codec_name: 'aac', sample_rate: '48000', channels: 2 },
            { index: 2, codec_type: 'subtitle', codec_name: 'subrip' },
            {
              index: 3,
              codec_type: 'attachment',
              tags: { mimetype: 'application/x-truetype-font', filename: 'font.ttf' },
            },
          ],
          packets: [
            { stream_index: 0, pts_time: '0.000', flags: 'K_' },
            { stream_index: 1, pts_time: '0.000', flags: 'K_' },
          ],
        }),
      );
    }
    if (binary === 'ffprobe') {
      // MediaChecks audioStartItem / bitrateItem or window packet probe
      return Buffer.from(
        JSON.stringify({
          streams: [{ index: 2, codec_name: 'subrip' }],
          packets: [{ stream_index: 0, pts_time: '1.0', size: '100' }],
        }),
      );
    }
    return Buffer.from('WEBVTT\n\n');
  };

  try {
    const baseSource = {
      id: 'movie-1',
      sourceStart: 'http://fixture/movie.mkv',
      sourceKey: JSON.stringify(['https://plex.example', '1', '5', '/library/parts/5/file', 1000, 120000, '99']),
      shareKey: ['room-1', 'v1'],
      tracks: {
        audio: [{ id: '1', index: 1, codec: 'aac' }],
        subtitles: [{ id: '2', index: 2, codec: 'srt', delivery: 'cues', available: true, external: false }],
      },
      selection: {
        audio: { id: '1', index: 1, codec: 'aac' },
        subtitle: { id: '2', index: 2, codec: 'srt', delivery: 'cues', available: true, external: false },
      },
      subtitleAbort: new AbortController(),
      lifecycleAbort: new AbortController(),
    };

    const checks = new MediaChecks({ pipeline });
    const group720 = { key: '720p4', controllers: new Set(), chunks: new Map(), leases: new Set() };
    const group480 = { key: '480p2', controllers: new Set(), chunks: new Map(), leases: new Set() };

    const callers = [
      pipeline.av1.sourceInfo(group720, { ...baseSource, quality: '720p4' }),
      pipeline.av1.sourceInfo(group480, { ...baseSource, quality: '480p2' }),
      checks.fileItems({ ...baseSource }),
      ...Array.from({ length: 5 }, (_, i) => pipeline.mediaFacts.inspect({ ...baseSource, principal: 'viewer-' + i })),
    ];

    await firstStarted.promise;
    releaseFirst();
    const results = await Promise.all(callers);
    assert.equal(probes, 1, 'all 8 concurrent callers share exactly 1 consolidated ffprobe');
    assert.deepEqual(results[3].fontAttachments, [3]);
    assert.equal(results[3].originSeconds, 0);

    // Mutating size/mtimeMs/ETag in sourceKey triggers a fresh probe
    const mutated = {
      ...baseSource,
      sourceKey: JSON.stringify(['https://plex.example', '1', '5', '/library/parts/5/file', 2000, 120000, '99']),
    };
    await pipeline.mediaFacts.inspect(mutated);
    assert.equal(probes, 2);

    // Unshared principal calls isolate by principal
    await pipeline.mediaFacts.inspect({ ...baseSource, shareKey: undefined, principal: 'alice' });
    await pipeline.mediaFacts.inspect({ ...baseSource, shareKey: undefined, principal: 'bob' });
    assert.equal(probes, 4);

    // Explicit forget invalidates and re-probes
    pipeline.mediaFacts.forget(baseSource.sourceKey);
    await pipeline.mediaFacts.inspect(baseSource);
    assert.equal(probes, 5);
  } finally {
    await pipeline.close();
  }
});

test('MediaFacts rotates upstream av1.input source when initiating viewer aborts and cancels on idleMs or close', async () => {
  const upstreamTokens = [];
  let probeStarted = Promise.withResolvers();
  let releaseProbe;
  let probeAborted = false;

  const pipeline = new MediaPipeline({ ffmpegPath: 'ffmpeg', ffprobePath: 'ffprobe' });
  pipeline.mediaFacts.idleMs = 60;
  pipeline.av1.run = async (_binary, _args, signal) => {
    probeStarted.resolve();
    await new Promise((resolve, reject) => {
      releaseProbe = resolve;
      signal?.addEventListener(
        'abort',
        () => {
          probeAborted = true;
          reject(signal.reason);
        },
        { once: true },
      );
    });
    // Trigger an actual bridge request to verify which live subscriber source is selected
    const port = await pipeline.av1.bridge();
    assert.ok(port > 0);
    return Buffer.from('{"format":{"start_time":"0"},"streams":[],"packets":[]}');
  };

  try {
    const mediaA = {
      sourceKey: 'rotate-key',
      shareKey: ['room-r', 'v1'],
      principal: 'alice',
      sourceStart: 'http://upstream.invalid/a',
      lifecycleAbort: new AbortController(),
      provider: {
        request: async url => {
          upstreamTokens.push(url);
          return new Response(Buffer.alloc(0), { status: 200 });
        },
      },
    };
    const mediaB = {
      sourceKey: 'rotate-key',
      shareKey: ['room-r', 'v1'],
      principal: 'bob',
      sourceStart: 'http://upstream.invalid/b',
      lifecycleAbort: new AbortController(),
      provider: {
        request: async url => {
          upstreamTokens.push(url);
          return new Response(Buffer.alloc(0), { status: 200 });
        },
      },
    };

    const ctrlA = new AbortController();
    const pA = pipeline.mediaFacts.inspect(mediaA, { signal: ctrlA.signal });
    await probeStarted.promise;
    const pB = pipeline.mediaFacts.inspect(mediaB);

    // Simulate bridge request using live resolver while A aborts and B remains
    const entry = [...pipeline.av1.inputs.values()][0];
    assert.equal(entry.source().sourceStart, 'http://upstream.invalid/a');

    ctrlA.abort();
    mediaA.lifecycleAbort.abort();
    await assert.rejects(pA);
    assert.equal(probeAborted, false, 'shared probe stays alive for Viewer B');
    assert.equal(entry.source().sourceStart, 'http://upstream.invalid/b', 'av1.input rotates to Viewer B');

    releaseProbe();
    const factsB = await pB;
    assert.equal(factsB.originSeconds, 0);

    // Transient failure is never cached
    pipeline.mediaFacts.forget('rotate-key');
    pipeline.av1.run = async () => {
      throw new Error('upstream 503');
    };
    await assert.rejects(pipeline.mediaFacts.inspect(mediaB), /503/);
    assert.equal(pipeline.mediaFacts.stats().entries, 0);

    // When all subscribers abort, task aborts after idleMs
    probeStarted = Promise.withResolvers();
    probeAborted = false;
    pipeline.av1.run = async (_binary, _args, signal) => {
      probeStarted.resolve();
      await new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => {
            probeAborted = true;
            reject(signal.reason);
          },
          { once: true },
        );
      });
    };
    const ctrlC = new AbortController();
    const pC = pipeline.mediaFacts.inspect(mediaB, { signal: ctrlC.signal });
    await probeStarted.promise;
    ctrlC.abort();
    await assert.rejects(pC);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(probeAborted, true, 'probe aborts after idleMs once all subscribers leave');
  } finally {
    await pipeline.close();
  }
});

test('MediaFacts enforces maxEntries and maxBytes LRU bounds', async () => {
  const facts = new MediaFacts({
    av1: {
      ffprobe: 'ffprobe',
      input: (_src, _sig, action) => action('http://fixture'),
      run: async () =>
        Buffer.from(
          JSON.stringify({
            format: { duration: '10', start_time: '0' },
            streams: [{ index: 0, codec_type: 'video', codec_name: 'h264' }],
            packets: [],
          }),
        ),
    },
    maxEntries: 4,
    maxBytes: 1024 * 1024,
  });

  try {
    for (let i = 0; i < 6; i++) {
      await facts.inspect({ sourceKey: 'key-' + i, shareKey: 'room' });
    }
    assert.equal(facts.stats().entries, 4);
    assert.equal(facts.cache.has(JSON.stringify(['shared', 'key-0'])), false);
    assert.equal(facts.cache.has(JSON.stringify(['shared', 'key-5'])), true);
  } finally {
    facts.close();
  }
});

test('ProcessGate schedules live normal/urgent work ahead of background tasks and preserves FIFO within rank', async () => {
  const { ProcessGate } = require('../server/transcoding-policy');
  const gate = new ProcessGate(1);
  const releaseFirst = await gate.acquire();
  const order = [];
  const pBg1 = gate.run(undefined, async () => order.push('bg1'), { priority: 'background' });
  const pBg2 = gate.run(undefined, async () => order.push('bg2'), { priority: 'background' });
  const pNormal = gate.run(undefined, async () => order.push('normal'));
  const pUrgent = gate.run(undefined, async () => order.push('urgent'), { priority: 'urgent' });
  const abortCtrl = new AbortController();
  const pAborted = gate.run(abortCtrl.signal, async () => order.push('aborted'), { priority: 'urgent' });
  abortCtrl.abort();
  await assert.rejects(pAborted);

  releaseFirst();
  await Promise.all([pBg1, pBg2, pNormal, pUrgent]);
  assert.deepEqual(order, ['urgent', 'normal', 'bg1', 'bg2']);
});

test('MediaPipeline.busy reflects active remux sessions and active HTTP range streams', async () => {
  const { MediaPipeline } = require('../server/media-pipeline');
  const pipeline = new MediaPipeline();
  try {
    assert.equal(pipeline.busy, false);
    const endRange = pipeline.beginRangeStream();
    assert.equal(pipeline.busy, true);
    endRange();
    // Recent range-stream window keeps background scans paused briefly
    assert.equal(pipeline.busy, true);
    pipeline.lastRangeStreamAt = 0;
    assert.equal(pipeline.busy, false);

    pipeline.remux.sessions.set('remux-key', { id: 's1' });
    assert.equal(pipeline.busy, true);
    pipeline.remux.sessions.clear();
    assert.equal(pipeline.busy, false);
  } finally {
    await pipeline.close();
  }
});
