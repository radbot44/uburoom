'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AV1, outputSpec, decodeRoute, cpuPlaceboRoute, encoderArgs } = require('../server/av1');
const { PlaybackError } = require('../server/errors');
const { classifyHdr, run } = require('../server/media-tools');
const { Plex } = require('../server/plex');
const Engine = require('../shared/engine.mjs');

test('AV1 derives a bounded source frame clock for CFR film and high frame rate video', () => {
  const spec = rate =>
    outputSpec({ streams: [{ codec_type: 'video', width: 640, height: 360, r_frame_rate: rate }] }, 'direct');
  assert.equal(spec('24000/1001').frameRate, '24000/1001');
  assert.equal(spec('60/1').frameRate, '60/1');
  for (const rate of ['0/0', '24000/0', '1000000/1', '-24/1', '24;anything'])
    assert.equal(spec(rate).frameRate, undefined);
  assert.equal(
    outputSpec(
      { streams: [{ codec_type: 'video', width: 640, height: 360, r_frame_rate: '0/0', avg_frame_rate: '25/1' }] },
      'direct',
    ).frameRate,
    '25/1',
  );
  assert.doesNotMatch(spec('60/1').filter, /(^|,)fps=/);
});

test('a failed speculative AV1 chunk stays bounded without poisoning other chunks', async () => {
  const calls = new Map();
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (binary, args) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({
          streams: [{ codec_type: 'video', width: 640, height: 360, r_frame_rate: '60/1' }, { codec_type: 'audio' }],
        }),
      );
    if (args.includes('-ss')) {
      const start = args[args.indexOf('-ss') + 1];
      calls.set(start, (calls.get(start) || 0) + 1);
      if (start === '18') throw new PlaybackError('No video in final fractional tail');
    }
    return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
  });
  const lease = manager.acquire({ id: '1', duration: 18.018, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    const current = await manager.chunk(lease, 2, signal);
    await assert.rejects(manager.chunk(lease, 3, signal), /fractional tail/);
    await assert.rejects(manager.chunk(lease, 3, signal), /fractional tail/);
    assert.equal(calls.get('18'), 1);
    assert.equal(await manager.chunk(lease, 2, signal), current, 'buffered current chunk survives');
    assert.ok((await manager.chunk(lease, 0, signal)).video.length, 'seek back can still encode another chunk');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('AV1 retries an isolated failed chunk after monotonic cooldown despite wall-clock steps', async t => {
  let mono = 1000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(Date, 'now', () => wall);
  let unavailable = true,
    encodes = 0,
    probes = 0;
  const manager = new AV1(
    { ffmpegPath: 'fixture', transcoding: { encoder: 'qsv', cpuFallback: false } },
    async (_binary, args) => {
      if (args.includes('testsrc2=size=320x180:rate=30')) {
        if (++probes === 1) throw new PlaybackError('Temporary probe failure');
        return Buffer.alloc(200);
      }
      if (args.includes('-show_entries'))
        return Buffer.from(
          JSON.stringify({
            streams: [{ codec_type: 'video', width: 640, height: 360, r_frame_rate: '24/1' }, { codec_type: 'audio' }],
          }),
        );
      if (args.includes('-ss')) {
        encodes++;
        if (unavailable) throw new PlaybackError('Temporary source failure');
      }
      return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
    },
  );
  const lease = manager.acquire({ id: '1', duration: 90, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary probe failure/);
    assert.equal(probes, 1);
    assert.equal(encodes, 0);
    wall += 30000;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary probe failure/);
    assert.equal(probes, 1, 'wall steps cannot bypass the failure cooldown');
    mono += 5001;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary source failure/);
    assert.equal(probes, 2);
    assert.equal(encodes, 1);
    unavailable = false;
    wall -= 40000;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary source failure/);
    assert.equal(encodes, 1);
    mono += 5001;
    const recovered = await manager.chunk(lease, 4, signal);
    assert.ok(recovered.video.length);
    assert.equal(encodes, 2);
    assert.equal(await manager.chunk(lease, 4, signal), recovered);
    assert.equal(encodes, 2);
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('hardware decode falls back to the CPU for the stream only when the CPU proves the GPU failed', async () => {
  let gpuFails = true,
    cpu = 0,
    gpu = 0;
  const warnings = [],
    tonemapped = [];
  const manager = new AV1(
    {
      ffmpegPath: 'fixture',
      transcoding: { encoder: 'nvenc', cpuFallback: false },
    },
    async (_binary, args) => {
      if (args.includes('-show_entries'))
        return Buffer.from(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: 3840,
                height: 2160,
                pix_fmt: 'yuv420p10le',
                color_transfer: 'smpte2084',
                r_frame_rate: '24000/1001',
              },
              { codec_type: 'audio' },
            ],
          }),
        );
      if (!args.includes('-ss')) return Buffer.alloc(200);
      if (args.includes('-hwaccel')) {
        gpu++;
        assert.match(args[args.indexOf('-vf') + 1], /scale_cuda=1920:1080:format=p010le,hwdownload/);
        tonemapped.push(args[args.indexOf('-vf') + 1].includes('libplacebo'));
        assert.ok(!args.includes('hevc_qsv'));
        if (gpuFails) throw Object.assign(new PlaybackError('decode failed'), { exitFailure: true });
      } else cpu++;
      return { video: Buffer.alloc(200), audio: Buffer.alloc(50) };
    },
    { warn: (_, message) => warnings.push(message) },
  );
  const lease = manager.acquire({ id: '1', duration: 60, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    assert.deepEqual([gpu, cpu], [2, 1]);
    assert.deepEqual(tonemapped, [true, false]);
    assert.equal(lease.group.decodeLevel, 2);
    assert.equal(warnings.length, 1);
    await manager.chunk(lease, 1, signal);
    assert.deepEqual([gpu, cpu], [2, 2], 'later chunks skip the failed routes');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('quality tiers respect source bitrate/resolution; AV1 clamps Original to the highest configured quality and tonemaps PQ/HLG', async () => {
  const plex = new Plex({});
  assert.deepEqual(
    plex.pipeline.qualities({ sourceHeight: 1080, sourceBitrate: 13000 }).map(q => q.id),
    ['direct', '1080p12', '1080p8', '720p4', '720p2'],
  );
  assert.deepEqual(
    plex.pipeline.qualities({ sourceHeight: 720, sourceBitrate: 1500 }).map(q => q.id),
    ['direct'],
  );
  const info = {
    streams: [{ codec_type: 'video', width: 7680, height: 4320, color_transfer: 'smpte2084' }, { codec_type: 'audio' }],
    format: { bit_rate: '80000000' },
  };
  const original = outputSpec(info, 'direct');
  assert.equal(original.width, 1920);
  assert.equal(original.height, 1080);
  assert.equal(original.bitrate, 20000);
  const customMax = outputSpec(info, 'direct', { id: '2160p25', width: 3840, height: 2160, bitrate: 25000 });
  assert.equal(customMax.width, 3840);
  assert.equal(customMax.height, 2160);
  assert.equal(customMax.bitrate, 25000);
  assert.equal(original.hdr, true);
  assert.equal(original.hdrKind, 'hdr10');
  assert.match(original.filter, /tonemap=/);
  assert.equal(original.audio, true);
  assert.equal(outputSpec(info, '720p2').bitrate, 2000);
  assert.doesNotMatch(
    outputSpec({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }, '1080p20').filter,
    /tonemap/,
  );
  assert.equal(outputSpec({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }, '1080p20').width, 640);
  assert.equal(
    Engine.validate({ action: 'media.quality.set', args: { quality: '720p4', fallback: 'av1' } }).args.fallback,
    'av1',
  );
  assert.throws(() => Engine.validate({ action: 'media.quality.set', args: { quality: '720p4', fallback: 'cpu' } }));

  // Distinguish Dolby Vision profiles (Profile 5 vs Profile 7/8.1 HDR10 base, 8.4 HLG base, 8.2 SDR base)
  const doviP5 = outputSpec(
    {
      streams: [
        {
          codec_type: 'video',
          width: 3840,
          height: 2160,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'unspecified',
          side_data_list: [
            { side_data_type: 'DOVI configuration record', dv_profile: 5, bl_signal_compatibility_id: 0 },
          ],
        },
      ],
    },
    '1080p8',
  );
  assert.equal(doviP5.hdr, true);
  assert.equal(doviP5.hdrKind, 'dovi-p5');
  assert.equal(doviP5.doviP5, true);
  assert.deepEqual(doviP5.tonemap, []);
  assert.doesNotMatch(doviP5.filter, /zscale/);
  assert.equal(decodeRoute(doviP5, 'nvenc', 'win32', false), undefined);
  assert.equal(decodeRoute(doviP5, 'software', 'darwin', true), undefined);
  assert.match(
    decodeRoute(doviP5, 'nvenc', 'win32', true).filter,
    /^setpts=PTS-STARTPTS,hwdownload,format=p010le,libplacebo=.*apply_dolbyvision=1$/,
  );
  const qsvPlacebo = decodeRoute(doviP5, 'qsv', 'win32', true);
  assert.ok(!qsvPlacebo.input.includes('qsv=q@d') && !qsvPlacebo.filter.includes('vpp_qsv'));
  // HDR10 on QSV shrinks on the GPU, still in HDR, so only the output size is copied to libplacebo.
  const hdr10 = outputSpec(
    {
      streams: [
        { codec_type: 'video', width: 3840, height: 2160, pix_fmt: 'yuv420p10le', color_transfer: 'smpte2084' },
      ],
    },
    '1080p8',
  );
  const qsvScaled = decodeRoute(hdr10, 'qsv', 'win32', true);
  assert.match(
    qsvScaled.filter,
    /^setpts=PTS-STARTPTS,hwmap=derive_device=qsv,format=qsv,vpp_qsv=w=1920:h=1080:format=p010le,hwdownload,format=p010le,libplacebo=w=1920:h=1080:/,
  );
  assert.ok(qsvScaled.input.includes('qsv=q@d') && qsvScaled.input.at(-1) === 'v', 'libplacebo filters on Vulkan');
  assert.doesNotMatch(qsvScaled.filter, /tonemap=1/, 'the GPU only scales; libplacebo tonemaps');
  assert.match(cpuPlaceboRoute(doviP5, 'win32').filter, /format=p010le,libplacebo=.*apply_dolbyvision=1/);

  const doviP7 = outputSpec(
    {
      streams: [
        {
          codec_type: 'video',
          width: 3840,
          height: 2160,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'smpte2084',
          side_data_list: [
            { side_data_type: 'DOVI configuration record', dv_profile: 7, bl_signal_compatibility_id: 1 },
          ],
        },
      ],
    },
    '1080p8',
  );
  assert.equal(doviP7.hdr, true);
  assert.equal(doviP7.hdrKind, 'dovi-hdr10');
  assert.equal(doviP7.doviP5, false);
  assert.match(
    doviP7.filter,
    /setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc,zscale=t=linear:npl=100/,
  );

  const doviHlg = classifyHdr({ DOVIPresent: 1, DOVIProfile: 8, DOVIBLCompatID: 4, colorTrc: 'arib-std-b67' });
  assert.equal(doviHlg.hdr, true);
  assert.equal(doviHlg.kind, 'dovi-hlg');
  assert.equal(doviHlg.transfer, 'arib-std-b67');

  const doviSdr = outputSpec(
    {
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'bt709',
          side_data_list: [
            { side_data_type: 'DOVI configuration record', dv_profile: 8, bl_signal_compatibility_id: 2 },
          ],
        },
      ],
    },
    '1080p8',
  );
  assert.equal(doviSdr.hdr, false);
  assert.equal(doviSdr.hdrKind, 'dovi-sdr');
  assert.doesNotMatch(doviSdr.filter, /tonemap/);

  // DV Profile 5 steps down from hardware decode + libplacebo to software decode + libplacebo, never raw CPU zscale
  const filters = [];
  const p5Manager = new AV1(
    { ffmpegPath: 'fixture', transcoding: { encoder: 'nvenc', cpuFallback: false } },
    async (binary, args) => {
      if (args.includes('testsrc2=size=320x180:rate=30')) return Buffer.alloc(200, 1);
      if (args.includes('-show_entries'))
        return Buffer.from(
          JSON.stringify({
            streams: [
              {
                codec_type: 'video',
                width: 3840,
                height: 2160,
                pix_fmt: 'yuv420p10le',
                side_data_list: [
                  { side_data_type: 'DOVI configuration record', dv_profile: 5, bl_signal_compatibility_id: 0 },
                ],
              },
            ],
          }),
        );
      filters.push(args[args.indexOf('-vf') + 1]);
      if (args.includes('-hwaccel')) {
        const err = new Error('hwaccel failed');
        err.exitFailure = true;
        throw err;
      }
      return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200, 1);
    },
  );
  const p5Lease = p5Manager.acquire({ id: 'p5', duration: 60, start: 'http://127.0.0.1:1/file' }, '1080p8');
  try {
    await p5Manager.chunk(p5Lease, 0, new AbortController().signal);
    assert.equal(filters.length, 2);
    assert.ok(filters.every(f => f.includes('libplacebo=')));
  } finally {
    p5Manager.release(p5Lease);
    await p5Manager.close();
  }
});

test('AV1 shares one encode per source/tier/chunk and releases/cancels its last viewer', async () => {
  let encodes = 0,
    url;
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (binary, args) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 360 }, { codec_type: 'audio' }] }),
      );
    if (args.includes('-ss')) {
      encodes++;
      url = args[args.indexOf('-i') + 1];
    }
    return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
  });
  const source = { id: '1', duration: 60, start: 'http://private-plex/library/parts/1/file?private-token' };
  const a = manager.acquire(source, '720p4'),
    b = manager.acquire(source, '720p4');
  const signal = new AbortController().signal;
  const [x, y] = await Promise.all([manager.chunk(a, 2, signal), manager.chunk(b, 2, signal)]);
  assert.equal(x, y);
  assert.equal(encodes, 1);
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/);
  assert.equal(url.includes('private'), false);
  assert.equal(manager.inputs.size, 0);
  manager.release(a);
  assert.equal(manager.groups.size, 1);
  manager.release(b);
  assert.equal(manager.groups.size, 0);
  await assert.rejects(manager.chunk(b, 2, signal), /replaced/);
  const speculative = manager.acquire({ ...source, id: 'fallback' }, '720p2', false, 'av1', { background: true });
  const viewers = Array.from({ length: 7 }, (_, index) =>
    manager.acquire({ ...source, id: 'viewer-' + index }, 'direct'),
  );
  const urgent = manager.acquire({ ...source, id: 'urgent' }, 'direct');
  assert.equal(
    speculative.released,
    true,
    'speculative fallback yields a group slot to a viewer without raising the cap',
  );
  assert.equal(manager.groups.size, 8);
  for (const lease of [...viewers, urgent]) manager.release(lease);
  manager.close();
});

test('AV1 isolates source audio and Plex scopes, maps the exact stream and refuses a missing choice', async () => {
  const maps = [];
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (_binary, args) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({
          streams: [
            { index: 0, codec_type: 'video', width: 640, height: 360 },
            { index: 2, codec_type: 'audio' },
            { index: 4, codec_type: 'audio' },
          ],
        }),
      );
    if (args.includes('-ss')) maps.push(args.filter((_, i) => args[i - 1] === '-map'));
    return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
  });
  const source = {
    id: '1',
    partId: '5',
    principal: 'first',
    audioIndex: 2,
    audioOrdinal: 0,
    duration: 60,
    start: 'http://fixture',
  };
  const a = manager.acquire(source, 'direct'),
    b = manager.acquire({ ...source, audioIndex: 4, audioOrdinal: 1 }, 'direct'),
    c = manager.acquire({ ...source, principal: 'second' }, 'direct');
  const missing = manager.acquire({ ...source, audioIndex: 9 }, 'direct'),
    signal = new AbortController().signal;
  try {
    assert.notEqual(a.group, b.group);
    assert.notEqual(a.group, c.group);
    await manager.chunk(b, 0, signal);
    assert.deepEqual(maps, [['0:v:0', '1:4']]);
    await assert.rejects(manager.chunk(missing, 0, signal), /selected audio track/);
    assert.equal(maps.length, 1);
  } finally {
    for (const lease of [a, b, c, missing]) manager.release(lease);
    await manager.close();
  }
});

test('AV1 room outputs share across principals and each new chunk uses its requesting lease source', async () => {
  let encodes = 0;
  const inputs = [];
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (_binary, args) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({
          streams: [
            { index: 0, codec_type: 'video', width: 640, height: 360 },
            { index: 2, codec_type: 'audio' },
          ],
        }),
      );
    if (args.includes('-ss')) encodes++;
    return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
  });
  manager.input = async (source, _signal, action) => {
    inputs.push(source.principal);
    return action('http://fixture');
  };
  const source = {
    id: '1',
    partId: '5',
    sourceKey: 'same-authorized-file',
    shareKey: ['room', 'generation'],
    principal: 'alice',
    duration: 60,
    audioIndex: 2,
    audioOrdinal: 0,
  };
  const a = manager.acquire(source, '720p4'),
    b = manager.acquire({ ...source, principal: 'bob' }, '720p4');
  const otherRoom = manager.acquire({ ...source, shareKey: ['other-room', 'generation'] }, '720p4');
  const otherSource = manager.acquire({ ...source, sourceKey: 'another-file' }, '720p4');
  const otherAudio = manager.acquire({ ...source, audioIndex: 4 }, '720p4');
  const signal = new AbortController().signal;
  try {
    assert.equal(a.group, b.group);
    for (const lease of [otherRoom, otherSource, otherAudio]) assert.notEqual(lease.group, a.group);
    const [first, second] = await Promise.all([manager.chunk(a, 0, signal), manager.chunk(b, 0, signal)]);
    assert.equal(first, second);
    assert.equal(encodes, 1);
    assert.deepEqual(
      inputs,
      ['alice', 'alice'],
      'later acquisition cannot switch the first requesting lease credential',
    );
    manager.release(a);
    await manager.chunk(b, 1, signal);
    assert.deepEqual(inputs, ['alice', 'alice', 'bob']);
    assert.equal(encodes, 2);
  } finally {
    for (const lease of [a, b, otherRoom, otherSource, otherAudio]) manager.release(lease);
    await manager.close();
  }
});

test('AV1 fails closed on encoder errors, bounds chunk offsets, and cancels disconnected work', async () => {
  assert.throws(() => new AV1({}).acquire({ id: '1' }, 'direct'), /tools.ffmpeg/);
  let calls = 0;
  const manager = new AV1({ ffmpegPath: 'fixture', transcoding: { encoder: 'qsv', cpuFallback: false } }, async () => {
    calls++;
    throw new PlaybackError('Hardware unavailable');
  });
  const lease = manager.acquire({ id: '1', duration: 60 }, '720p4'),
    signal = new AbortController().signal;
  await assert.rejects(manager.chunk(lease, 0, signal), /Hardware unavailable/);
  await assert.rejects(manager.chunk(lease, 0, signal), /Hardware unavailable/);
  assert.equal(calls, 1, 'a persistent encoder failure does not launch repeated jobs');
  await assert.rejects(manager.chunk(lease, 100, signal), /Invalid/);
  manager.close();
  let aborted = false;
  const waiting = new AV1({ ffmpegPath: 'fixture' }, async (binary, args, signal) => {
    if (!args.includes('-ss'))
      return args.includes('-show_entries')
        ? Buffer.from('{"streams":[{"codec_type":"video","width":640,"height":360}]}')
        : Buffer.alloc(200);
    return new Promise((resolve, reject) =>
      signal.addEventListener(
        'abort',
        () => {
          aborted = true;
          reject(new PlaybackError('Cancelled'));
        },
        { once: true },
      ),
    );
  });
  const active = waiting.acquire({ id: '2', duration: 60, start: 'http://source' }, 'direct'),
    client = new AbortController();
  const chunk = waiting.chunk(active, 0, client.signal);
  await new Promise(resolve => setTimeout(resolve, 50));
  client.abort();
  await assert.rejects(chunk, /disconnected/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(aborted, true);
  waiting.release(active);
  waiting.close();
});

test('a fresh AV1 request can replace a cancelled chunk before its encoder settles', async () => {
  let encodes = 0,
    started,
    settleFirst;
  const firstStarted = new Promise(resolve => (started = resolve));
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (_binary, args, signal) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 360 }, { codec_type: 'audio' }] }),
      );
    if (args.includes('-ss')) {
      if (++encodes === 1) {
        started();
        return new Promise(resolve =>
          signal.addEventListener(
            'abort',
            () => {
              settleFirst = () => resolve({ video: Buffer.alloc(300), audio: Buffer.alloc(50) });
            },
            { once: true },
          ),
        );
      }
      return { video: Buffer.alloc(200), audio: Buffer.alloc(50) };
    }
    return Buffer.alloc(200);
  });
  const lease = manager.acquire({ id: '1', duration: 60, start: 'http://fixture' }, 'direct'),
    cancelled = new AbortController();
  try {
    const old = manager.chunk(lease, 0, cancelled.signal);
    await firstStarted;
    cancelled.abort();
    await assert.rejects(old, /disconnected/);
    assert.equal(typeof settleFirst, 'function');
    const fresh = manager.chunk(lease, 0, new AbortController().signal);
    settleFirst();
    const bytes = await fresh;
    assert.equal(encodes, 2);
    assert.equal(
      lease.group.chunks.get(0)?.bytes,
      bytes,
      'late cancellation cannot delete the replacement cache entry',
    );
    assert.equal(lease.group.bytes, 250, 'cancelled output is not added to the cache budget');
  } finally {
    settleFirst?.();
    manager.release(lease);
    await manager.close();
  }
});

test('run does not fail or kill on process exit race during memoryCheck', async () => {
  const res = await run(
    process.execPath,
    ['-e', 'process.stdout.write("ok"); process.exit(0)'],
    undefined,
    5000,
    1024,
    undefined,
    {
      memoryInterval: 10,
      memory: async pid => {
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            break;
          }
          await new Promise(r => setTimeout(r, 10));
        }
        throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
      },
    },
  );
  assert.equal(res.toString(), 'ok');
});

test('AV1 resets rejected bridgePromise so subsequent attempts can retry', async () => {
  const manager = new AV1({ ffmpegPath: 'fixture' });
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  let attempts = 0;
  http.createServer = function (...args) {
    attempts++;
    if (attempts === 1) {
      return {
        listen(_port, _host, cb) {
          process.nextTick(() => cb(new Error('transient listen error')));
        },
        once(event, cb) {
          if (event === 'error') process.nextTick(() => cb(new Error('transient listen error')));
        },
        unref() {},
      };
    }
    return originalCreateServer.apply(this, args);
  };
  try {
    await assert.rejects(manager.bridge(), /transient listen error/);
    assert.equal(manager.bridgePromise, undefined, 'bridgePromise is reset on failure');
    const port = await manager.bridge();
    assert.ok(typeof port === 'number' && port > 0, 'subsequent bridge attempt succeeds');
  } finally {
    http.createServer = originalCreateServer;
    await manager.close();
  }
});

test('shared probe survives one cancelled chunk and source fallback is learned across chunks', async () => {
  let releaseProbe, entered;
  const started = new Promise(resolve => (entered = resolve));
  let probes = 0,
    hardware = 0,
    software = 0;
  const manager = new AV1(
    { ffmpegPath: 'fixture', transcoding: { encoder: 'qsv', cpuFallback: true, maxJobs: 2 } },
    async (_, args, signal) => {
      if (args.includes('-show_entries')) {
        probes++;
        entered();
        await new Promise((resolve, reject) => {
          releaseProbe = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }));
      }
      if (!args.includes('-ss')) return Buffer.alloc(200);
      if (args[args.indexOf('-c:v') + 1] === 'av1_qsv') {
        hardware++;
        throw Object.assign(new PlaybackError('Source encoder failure'), { encoderFailure: true });
      }
      software++;
      return { video: Buffer.alloc(200), audio: Buffer.alloc(50) };
    },
  );
  manager.input = async (_, signal, action) => action('http://fixture');
  const lease = manager.acquire({ id: '1', duration: 60, start: 'http://fixture' }, 'direct'),
    firstAbort = new AbortController();
  try {
    const first = manager.chunk(lease, 0, firstAbort.signal),
      rejected = assert.rejects(first, /disconnected/);
    await started;
    const second = manager.chunk(lease, 1, new AbortController().signal);
    await new Promise(setImmediate);
    firstAbort.abort();
    await rejected;
    releaseProbe();
    assert.ok((await second).video.length);
    assert.equal(probes, 1);
    for (let index = 2; index < 5; index++) await manager.chunk(lease, index, new AbortController().signal);
    assert.equal(hardware, 1);
    assert.equal(software, 4);
    assert.equal(manager.pendingBytes, 0);
  } finally {
    releaseProbe?.();
    manager.release(lease);
    await manager.close();
  }
});

test('recent AV1 fallback demand survives wall steps and yields capacity only after monotonic expiry', async t => {
  let mono = 1000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(Date, 'now', () => wall);
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (_binary, args) =>
    args.includes('-show_entries')
      ? Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }))
      : args.includes('pipe:3')
        ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) }
        : Buffer.alloc(200),
  );
  const source = { id: 'fallback', duration: 60, start: 'http://fixture' };
  const fallback = manager.acquire(source, 'direct', false, 'av1', { background: true });
  const viewers = Array.from({ length: 7 }, (_, index) => manager.acquire({ ...source, id: String(index) }, 'direct'));
  let urgent;
  try {
    await manager.chunk(fallback, 0, new AbortController().signal);
    for (const step of [30000, -40000]) {
      wall += step;
      assert.throws(() => manager.acquire({ ...source, id: 'urgent' }, 'direct'), /busy/);
      assert.equal(fallback.released, false);
    }
    mono += 15001;
    urgent = manager.acquire({ ...source, id: 'urgent' }, 'direct');
    assert.equal(fallback.released, true);
    assert.equal(manager.groups.size, 8);
  } finally {
    for (const lease of [fallback, ...viewers, urgent]) manager.release(lease);
    await manager.close();
  }
});

// A fake FFmpeg for shared chunks: one buffer per WebM output, in pipe order.
function sharedFixture(onEncode) {
  return async (_binary, args, signal) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({
          streams: [
            { index: 0, codec_type: 'video', width: 1920, height: 1080 },
            { index: 1, codec_type: 'audio' },
            { index: 2, codec_type: 'audio' },
          ],
        }),
      );
    if (args.some(arg => String(arg).startsWith('testsrc2'))) return Buffer.alloc(200);
    await onEncode?.(args, signal);
    const pipes = args.filter(arg => /^pipe:\d+$/.test(arg));
    if (pipes.length > 2) return pipes.map((_, i) => Buffer.alloc(i % 2 ? 50 : 200 + i));
    return pipes.length === 2 ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
  };
}

test('qualities of one source near the same chunk share one process that decodes once', async () => {
  const encodes = [];
  const manager = new AV1(
    { ffmpegPath: 'fixture' },
    sharedFixture(args => encodes.push(args)),
  );
  const source = { id: '1', partId: '5', principal: 'alice', duration: 60, start: 'http://fixture' };
  const a = manager.acquire(source, '1080p8'),
    b = manager.acquire(source, '720p4'),
    c = manager.acquire({ ...source, audioIndex: 2, audioOrdinal: 1 }, '720p2'),
    burned = manager.acquire({ ...source, burn: { id: 's', index: 3, codec: 'ass' } }, '720p4'),
    signal = new AbortController().signal;
  try {
    assert.equal(burned.group.batchKey, undefined, 'burned subtitles belong to one selection');
    for (const lease of [a, b, c]) await manager.chunk(lease, 0, signal);
    assert.equal(encodes.length, 3, 'qualities with no recent position start alone');

    const first = await manager.chunk(a, 1, signal);
    assert.equal(encodes.length, 4);
    const shared = encodes.at(-1);
    const graph = shared[shared.indexOf('-filter_complex') + 1];
    assert.equal(graph.match(/split=(\d)/)?.[1], '3', 'one decode feeds all three qualities');
    assert.equal((graph.match(/scale=1280:720/g) || []).length, 2, 'smaller qualities scale from the largest');
    assert.equal(shared.filter(arg => arg === '-i').length, 2, 'the source is opened once for picture, once for sound');
    const maps = shared.filter((_, i) => shared[i - 1] === '-map');
    assert.deepEqual(maps, ['[v0]', '1:a:0', '[v1]', '1:a:0', '[v2]', '1:2'], 'each quality keeps its own audio');

    const [second, third] = await Promise.all([manager.chunk(b, 1, signal), manager.chunk(c, 1, signal)]);
    assert.equal(encodes.length, 4, 'siblings read the shared chunk from cache');
    assert.deepEqual(
      [first, second, third].map(bytes => bytes.video.length),
      [200, 202, 204],
      'each quality receives its own output',
    );
    assert.ok(second.audio.length && third.audio.length);
  } finally {
    for (const lease of [a, b, c, burned]) manager.release(lease);
    await manager.close();
  }
});

test('a shared chunk outlives a leaving viewer and a failed one converts each quality alone', async () => {
  let release,
    failShared = false;
  const encodes = [],
    warnings = [];
  const manager = new AV1(
    { ffmpegPath: 'fixture' },
    sharedFixture(async (args, signal) => {
      encodes.push(args);
      if (!args.includes('-filter_complex')) return;
      if (failShared) throw Object.assign(new PlaybackError('split unsupported'), { exitFailure: true });
      await new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new PlaybackError('WebM preparation cancelled.')), {
          once: true,
        });
      });
    }),
    { warn: (_, message) => warnings.push(message), info() {} },
  );
  const source = { id: '1', partId: '5', principal: 'alice', duration: 60, start: 'http://fixture' };
  const a = manager.acquire(source, '1080p8'),
    b = manager.acquire(source, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(a, 0, signal);
    await manager.chunk(b, 0, signal);

    const leaving = new AbortController();
    const gone = manager.chunk(a, 1, leaving.signal);
    await new Promise(resolve => setImmediate(resolve));
    while (!release) await new Promise(resolve => setTimeout(resolve, 5));
    leaving.abort();
    await assert.rejects(gone, /disconnected/);
    const staying = manager.chunk(b, 1, signal);
    release();
    assert.equal((await staying).video.length, 202, 'the remaining quality keeps the shared work');
    assert.equal(encodes.filter(args => args.includes('-filter_complex')).length, 1);

    failShared = true;
    const before = encodes.length;
    const [x, y] = await Promise.all([manager.chunk(a, 2, signal), manager.chunk(b, 2, signal)]);
    assert.ok(x.video.length && y.video.length, 'both qualities still play');
    assert.equal(encodes.length - before, 3, 'one failed shared attempt, then one process per quality');
    assert.equal(warnings.filter(message => /Shared conversion failed/.test(message)).length, 1);
    await manager.chunk(a, 3, signal);
    assert.equal(
      encodes.slice(before + 3).some(args => args.includes('-filter_complex')),
      false,
      'a source whose shared conversion failed is not retried shared',
    );
  } finally {
    for (const lease of [a, b]) manager.release(lease);
    await manager.close();
  }
});

test('run returns every WebM output of one process in pipe order', async () => {
  // Node stands in for FFmpeg: it writes each output file it is given, sized by position.
  const script =
    "const fs=require('fs');process.argv.slice(1).filter(a=>a.endsWith('.webm')).forEach((f,i)=>fs.writeFileSync(f,Buffer.alloc(100+i)))";
  const outputs = await run(
    process.execPath,
    ['-e', script, 'webm', 'pipe:1', 'pipe:3', 'pipe:4', 'pipe:5'],
    undefined,
  );
  assert.deepEqual(
    outputs.map(bytes => bytes.length),
    [100, 101, 102, 103],
  );
  const pair = await run(process.execPath, ['-e', script, 'webm', 'pipe:1', 'pipe:3'], undefined);
  assert.deepEqual([pair.video.length, pair.audio.length], [100, 101]);
});

test('six shared qualities with real chunk sizes fit memory and keep their outputs for viewers', async () => {
  const MB = 1024 * 1024,
    sizes = { 20000: 11 * MB, 12000: 7 * MB, 8000: 4.5 * MB, 4000: 2.3 * MB, 2000: 1.3 * MB };
  const shared = [],
    solo = [];
  const manager = new AV1({ ffmpegPath: 'fixture' }, async (_binary, args) => {
    if (args.includes('-show_entries'))
      return Buffer.from(
        JSON.stringify({
          streams: [
            { index: 0, codec_type: 'video', width: 3840, height: 2160 },
            { index: 1, codec_type: 'audio' },
          ],
          format: { bit_rate: '8000000' },
        }),
      );
    if (args.some(arg => String(arg).startsWith('testsrc2'))) return Buffer.alloc(200);
    const rates = args.filter((_, i) => args[i - 1] === '-b:v').map(rate => sizes[parseInt(rate)] || 4.5 * MB);
    (args.includes('-filter_complex') ? shared : solo).push(args);
    const outputs = rates.flatMap(bytes => [Buffer.alloc(bytes), Buffer.alloc(100 * 1024)]);
    return outputs.length > 2 ? outputs : { video: outputs[0], audio: outputs[1] };
  });
  // An 8 Mbps source: converted Original is its own sixth output, not the 20 Mbps one.
  const source = { id: '1', partId: '5', principal: 'p', duration: 600, start: 'x', sourceBitrate: 8000 };
  const leases = ['direct', '1080p20', '1080p12', '1080p8', '720p4', '720p2'].map(q => manager.acquire(source, q));
  const signal = new AbortController().signal;
  try {
    assert.equal(new Set(leases.map(lease => lease.group)).size, 6);
    for (const lease of leases) await manager.chunk(lease, 0, signal);
    const before = solo.length;
    // The first quality to ask makes chunks 1 and 2 for everyone before the others ask.
    await manager.chunk(leases[0], 1, signal);
    await manager.chunk(leases[0], 2, signal);
    assert.equal(shared.length, 2, 'six qualities fit one shared process per chunk');
    assert.equal(shared[0][shared[0].indexOf('-filter_complex') + 1].match(/split=(\d)/)[1], '6');
    for (const lease of leases.slice(1)) {
      await manager.chunk(lease, 1, signal);
      await manager.chunk(lease, 2, signal);
    }
    assert.equal(solo.length, before, 'the other qualities read both chunks from cache');
    assert.equal(manager.pendingBytes, 0);
  } finally {
    for (const lease of leases) manager.release(lease);
    await manager.close();
  }
});

test('converted Original shares the top quality output only when the source reaches its bitrate', () => {
  const manager = new AV1({ ffmpegPath: 'fixture' });
  const source = { id: '1', partId: '5', principal: 'p', duration: 60, start: 'x' };
  try {
    const remux = { ...source, sourceBitrate: 68000 },
      top = manager.acquire(remux, '1080p20'),
      original = manager.acquire(remux, 'direct');
    assert.equal(original.group, top.group, 'a 68 Mbps source converts Original to exactly 1080p20');
    const light = { ...source, id: '2', sourceBitrate: 8000 },
      lightTop = manager.acquire(light, '1080p20'),
      lightOriginal = manager.acquire(light, 'direct');
    assert.notEqual(lightOriginal.group, lightTop.group, 'an 8 Mbps Original keeps its own lower bitrate');
    const unknown = manager.acquire({ ...source, id: '3' }, 'direct');
    assert.equal(unknown.group.quality, 'direct');
    for (const lease of [top, original, lightTop, lightOriginal, unknown]) manager.release(lease);
  } finally {
    manager.close();
  }
});

test('CPU conversion splits the machine among running jobs instead of fixed threads', async () => {
  const cores = require('node:os').availableParallelism();
  assert.deepEqual(
    encoderArgs('software', 'av1', 2, 12).slice(4, 6),
    ['-svtav1-params', 'lp=1'],
    'a fifth of twelve threads is the lowest SVT-AV1 level',
  );
  assert.deepEqual(encoderArgs('software', 'av1', 12, 12).slice(4, 6), ['-svtav1-params', 'lp=6']);
  const vp9 = encoderArgs('software', 'vp9', 4, 12);
  assert.equal(vp9[vp9.indexOf('-threads') + 1], '4');
  assert.ok(!encoderArgs('qsv', 'av1', 8).includes('-threads'), 'hardware encoders are unchanged');

  const commands = [];
  const manager = new AV1(
    { ffmpegPath: 'fixture', transcoding: { encoder: 'software', hardwareDecode: false } },
    async (_binary, args) => {
      if (args.includes('-show_entries'))
        return Buffer.from(JSON.stringify({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }] }));
      if (args.includes('-ss')) commands.push(args);
      return args.includes('pipe:3') ? { video: Buffer.alloc(200), audio: Buffer.alloc(50) } : Buffer.alloc(200);
    },
  );
  const lease = manager.acquire({ id: '1', duration: 60, start: 'x' }, '720p4');
  try {
    await manager.chunk(lease, 0, new AbortController().signal);
    const args = commands[0];
    assert.equal(args[args.indexOf('-threads') + 1], String(Math.max(2, cores)), 'a lone CPU decode uses every core');
    assert.equal(args[args.indexOf('-svtav1-params') + 1], 'lp=6', 'a lone CPU encode uses the top level');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});
