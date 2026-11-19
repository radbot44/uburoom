'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { AV1, outputSpec, decodeRoute, decodeRoutes, cpuPlaceboRoute, encoderArgs } = require('../server/av1');
const { PlaybackError } = require('../server/errors');
const { fakeRuns, fakeTools } = require('./helpers/fake-ffmpeg');
const { classifyHdr, run, segments } = require('../server/media-tools');
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

function manage(config, execute, runs, logger) {
  const manager = new AV1({ ffmpegPath: 'fixture', ...config }, execute, logger, runs.segments);
  runs.manager = manager;
  return manager;
}
const VIDEO = { streams: [{ codec_type: 'video', width: 640, height: 360 }, { codec_type: 'audio' }] };
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const graph = args => args[args.indexOf('-filter_complex') + 1];

test('a failed speculative AV1 chunk stays bounded without poisoning other chunks', async () => {
  // The last 0.018 s holds no frame, so the run ends before that chunk.
  const runs = fakeRuns({
    duration: 18.018,
    chunk: (args, n) => (Number(args[args.indexOf('-ss') + 1]) + n * 6 >= 18 ? false : undefined),
  });
  const manager = manage({}, fakeTools(VIDEO), runs);
  const lease = manager.acquire({ id: '1', duration: 18.018, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    const current = await manager.chunk(lease, 2, signal);
    await assert.rejects(manager.chunk(lease, 3, signal), /no video/);
    await assert.rejects(manager.chunk(lease, 3, signal), /no video/);
    assert.equal(runs.started.length, 1, 'the empty tail is tried once, by the run already there');
    assert.equal(await manager.chunk(lease, 2, signal), current, 'buffered current chunk survives');
    assert.ok((await manager.chunk(lease, 0, signal)).video.length, 'seek back can still encode another chunk');
    assert.equal(runs.started.length, 2);
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
    probes = 0;
  const runs = fakeRuns({
    duration: 90,
    chunk: () => {
      if (unavailable) throw new PlaybackError('Temporary source failure');
    },
  });
  const manager = manage(
    { transcoding: { encoder: 'qsv', cpuFallback: false } },
    fakeTools(VIDEO, {
      probe: () => {
        if (++probes === 1) throw new PlaybackError('Temporary probe failure');
      },
    }),
    runs,
  );
  const lease = manager.acquire({ id: '1', duration: 90, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary probe failure/);
    assert.equal(probes, 1);
    assert.equal(runs.started.length, 0);
    wall += 30000;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary probe failure/);
    assert.equal(probes, 1, 'wall steps cannot bypass the failure cooldown');
    mono += 5001;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary source failure/);
    assert.equal(probes, 2);
    assert.equal(runs.started.length, 1);
    unavailable = false;
    wall -= 40000;
    await assert.rejects(manager.chunk(lease, 4, signal), /Temporary source failure/);
    assert.equal(runs.started.length, 1);
    mono += 5001;
    const recovered = await manager.chunk(lease, 4, signal);
    assert.ok(recovered.video.length);
    assert.equal(runs.started.length, 2);
    assert.equal(await manager.chunk(lease, 4, signal), recovered);
    assert.equal(runs.started.length, 2);
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('hardware decode falls back to the CPU for the stream only when the CPU proves the GPU failed', async () => {
  let gpu = 0,
    cpu = 0;
  const warnings = [],
    tonemapped = [];
  const runs = fakeRuns({
    duration: 120,
    chunk: (args, n) => {
      if (n) return;
      if (args.includes('-hwaccel')) {
        gpu++;
        assert.match(graph(args), /scale_cuda=1920:1080:format=p010le,hwdownload/);
        tonemapped.push(graph(args).includes('libplacebo'));
        assert.ok(!args.includes('hevc_qsv'));
        throw Object.assign(new PlaybackError('decode failed'), { exitFailure: true });
      }
      cpu++;
    },
  });
  const manager = manage(
    { transcoding: { encoder: 'nvenc', cpuFallback: false } },
    fakeTools({
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
    runs,
    { warn: (_, message) => warnings.push(message) },
  );
  const lease = manager.acquire({ id: '1', duration: 120, start: 'http://fixture' }, 'direct'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    assert.deepEqual([gpu, cpu], [2, 1]);
    assert.deepEqual(tonemapped, [true, false]);
    assert.equal(lease.group.decodeLevel, 2);
    assert.equal(warnings.length, 1);
    await manager.chunk(lease, 1, signal);
    assert.deepEqual([gpu, cpu], [2, 1], 'the working process carries on');
    await manager.chunk(lease, 15, signal);
    assert.deepEqual([gpu, cpu], [2, 2], 'a later process skips the failed routes');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('NVENC decodes HDR on Vulkan first and steps down to CUDA when Vulkan fails', async () => {
  const hdr = {
    codec_type: 'video',
    codec_name: 'hevc',
    width: 3840,
    height: 2160,
    pix_fmt: 'yuv420p10le',
    color_transfer: 'smpte2084',
    r_frame_rate: '24000/1001',
  };
  const spec = outputSpec({ streams: [hdr] }, '1080p8');
  const [vulkan, cuda, cudaOnly, cpu, extra] = decodeRoutes(spec, 'nvenc', true, 'win32');
  assert.match(vulkan.filter, /^setpts=PTS-STARTPTS,libplacebo=w=1920:h=1080:.*,hwupload=derive_device=cuda$/);
  assert.match(vulkan.burnFilter, /libplacebo=.*,hwdownload,format=nv12$/, 'burned subtitles overlay on the CPU');
  assert.equal(vulkan.scale(1280, 720), 'scale_cuda=1280:720');
  assert.ok(vulkan.input.includes('vulkan=v@cu'), 'Vulkan decodes on the encoding GPU');
  assert.match(cuda.filter, /scale_cuda=1920:1080:format=p010le,hwdownload/);
  assert.ok(cudaOnly && cpu === undefined && extra === undefined);
  for (const other of [
    decodeRoutes({ ...spec, sourceCodec: 'vp9' }, 'nvenc', true, 'win32'),
    decodeRoutes(spec, 'qsv', true, 'win32'),
    decodeRoutes(outputSpec({ streams: [{ ...hdr, pix_fmt: 'yuv420p', color_transfer: 'bt709' }] }, '1080p8'), 'nvenc'),
  ])
    assert.ok(!other.some(route => route?.input.includes('vulkan=v@cu')));

  const routes = [],
    warnings = [];
  const runs = fakeRuns({
    chunk: (args, n) => {
      if (n) return;
      routes.push(args[args.indexOf('-hwaccel') + 1]);
      if (args.includes('vulkan=v@cu')) {
        // NVENC takes the CUDA frames as they are: no conversion back to system memory.
        assert.ok(!args.includes('-pix_fmt'));
        throw Object.assign(new PlaybackError('vulkan crashed'), { exitFailure: true });
      }
      assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
    },
  });
  const manager = manage(
    { transcoding: { encoder: 'nvenc', cpuFallback: false } },
    fakeTools({ streams: [hdr, { codec_type: 'audio' }] }),
    runs,
    { warn: (_, message) => warnings.push(message) },
  );
  const lease = manager.acquire({ id: '1', duration: 60, start: 'http://fixture' }, '1080p8');
  try {
    await manager.chunk(lease, 0, new AbortController().signal);
    assert.deepEqual(routes, ['vulkan', 'cuda']);
    assert.equal(lease.group.decodeLevel, 1);
    assert.match(warnings[0], /^Vulkan decode failed/);
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
  const p5Runs = fakeRuns({
    chunk: (args, n) => {
      if (n) return;
      filters.push(graph(args));
      if (args.includes('-hwaccel')) throw Object.assign(new Error('hwaccel failed'), { exitFailure: true });
    },
  });
  const p5Manager = manage(
    { transcoding: { encoder: 'nvenc', cpuFallback: false } },
    fakeTools({
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
    p5Runs,
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
  const runs = fakeRuns();
  const manager = manage({}, fakeTools(VIDEO), runs);
  const source = { id: '1', duration: 60, start: 'http://private-plex/library/parts/1/file?private-token' };
  const a = manager.acquire(source, '720p4'),
    b = manager.acquire(source, '720p4');
  const signal = new AbortController().signal;
  const [x, y] = await Promise.all([manager.chunk(a, 2, signal), manager.chunk(b, 2, signal)]);
  assert.equal(x, y);
  assert.equal(runs.started.length, 1);
  const url = runs.started[0][runs.started[0].indexOf('-i') + 1];
  assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]+$/);
  assert.equal(url.includes('private'), false);
  manager.release(a);
  assert.equal(manager.groups.size, 1);
  manager.release(b);
  assert.equal(manager.groups.size, 0);
  await tick();
  assert.equal(runs.aborted[0], true, 'the last viewer leaving stops the process');
  assert.equal(manager.inputs.size, 0);
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
  await manager.close();
});

test('AV1 isolates source audio and Plex scopes, maps the exact stream and refuses a missing choice', async () => {
  const sounds = [];
  const runs = fakeRuns();
  const manager = manage(
    {},
    fakeTools(
      {
        streams: [
          { index: 0, codec_type: 'video', width: 640, height: 360 },
          { index: 2, codec_type: 'audio' },
          { index: 4, codec_type: 'audio' },
        ],
      },
      { audio: args => sounds.push(args.filter((_, i) => args[i - 1] === '-map')) },
    ),
    runs,
  );
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
    assert.deepEqual(
      runs.started[0].filter((_, i) => runs.started[0][i - 1] === '-map'),
      ['[v0]'],
    );
    assert.deepEqual(sounds[0], ['0:4'], 'the sound process maps the chosen stream');
    await assert.rejects(manager.chunk(missing, 0, signal), /selected audio track/);
    assert.equal(runs.started.length, 1, 'a missing choice starts no process');
  } finally {
    for (const lease of [a, b, c, missing]) manager.release(lease);
    await manager.close();
  }
});

test('a slow chunk says whether its picture or its sound was late', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const warnings = [];
  // Chunk 1's picture arrives five seconds after its sound.
  const runs = fakeRuns({
    chunk: async (_args, n) => {
      if (n !== 1) return;
      for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
      t.mock.timers.tick(5000);
    },
  });
  const manager = manage({}, fakeTools(VIDEO), runs, { warn: (_, message) => warnings.push(message), info() {} });
  const lease = manager.acquire({ id: '1', duration: 60, start: 'x' }, '720p4');
  try {
    const signal = new AbortController().signal;
    await manager.chunk(lease, 0, signal);
    await manager.chunk(lease, 1, signal);
    const slow = warnings.filter(line => line.startsWith('Chunk 1 '));
    assert.equal(slow.length, 1);
    assert.match(slow[0], /took 5\.\ds to encode \(video 5\.\ds, sound 0\.\ds\)/);
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('a process logs where the time to its first chunk went, once', async () => {
  const lines = [];
  const runs = fakeRuns({ read: true });
  const manager = manage({}, fakeTools(VIDEO), runs, { info: (_, message) => lines.push(message), warn() {} });
  const lease = manager.acquire(
    { id: '1', duration: 60, start: 'part', provider: { request: async () => new Response(Buffer.alloc(16)) } },
    '720p4',
  );
  const signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    await manager.chunk(lease, 1, signal);
    const timing = lines.filter(line => line.startsWith('Chunk '));
    assert.equal(timing.length, 1, 'only the first chunk of a process is reported');
    assert.match(
      timing[0],
      /^Chunk 0 of 720p4 ready \d+\.\ds after it was asked for: process \d+\.\ds \(1 source request, slowest \d\.\d\ds\), sound \d+\.\ds \(0 source requests, slowest 0\.00s\), probe \d+\.\ds/,
    );
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('AV1 room outputs share across principals and a run reads with a lease still held', async () => {
  const reads = [];
  const runs = fakeRuns({ duration: 120, read: true });
  const manager = manage(
    {},
    fakeTools({
      streams: [
        { index: 0, codec_type: 'video', width: 640, height: 360 },
        { index: 2, codec_type: 'audio' },
      ],
    }),
    runs,
  );
  const source = principal => ({
    id: '1',
    partId: '5',
    sourceKey: 'same-authorized-file',
    shareKey: ['room', 'generation'],
    principal,
    duration: 120,
    audioIndex: 2,
    audioOrdinal: 0,
    start: 'part',
    provider: {
      request: async () => {
        reads.push(principal);
        return new Response(Buffer.alloc(16));
      },
    },
  });
  const a = manager.acquire(source('alice'), '720p4'),
    b = manager.acquire(source('bob'), '720p4');
  const otherRoom = manager.acquire({ ...source('alice'), shareKey: ['other-room', 'generation'] }, '720p4');
  const otherSource = manager.acquire({ ...source('alice'), sourceKey: 'another-file' }, '720p4');
  const otherAudio = manager.acquire({ ...source('alice'), audioIndex: 4 }, '720p4');
  const signal = new AbortController().signal;
  try {
    assert.equal(a.group, b.group);
    for (const lease of [otherRoom, otherSource, otherAudio]) assert.notEqual(lease.group, a.group);
    const [first, second] = await Promise.all([manager.chunk(a, 0, signal), manager.chunk(b, 0, signal)]);
    assert.equal(first, second);
    assert.equal(runs.started.length, 1);
    assert.deepEqual(new Set(reads), new Set(['alice']), 'the run reads with the lease that started it');
    manager.release(a);
    const before = reads.length;
    while (runs.produced[0] < 11) await tick();
    await manager.chunk(b, 12, signal);
    assert.equal(runs.started.length, 1, 'the run carries on for the remaining viewer');
    assert.ok(reads.length > before);
    assert.deepEqual(new Set(reads.slice(before)), new Set(['bob']), 'after alice leaves, reads use bob');
  } finally {
    for (const lease of [a, b, otherRoom, otherSource, otherAudio]) manager.release(lease);
    await manager.close();
  }
});

test('AV1 fails closed on encoder errors, bounds chunk offsets, and cancels work nobody holds', async () => {
  assert.throws(() => new AV1({}).acquire({ id: '1' }, 'direct'), /tools.ffmpeg/);
  let calls = 0;
  const failing = manage(
    { transcoding: { encoder: 'qsv', cpuFallback: false } },
    async () => {
      calls++;
      throw new PlaybackError('Hardware unavailable');
    },
    fakeRuns(),
  );
  const lease = failing.acquire({ id: '1', duration: 60 }, '720p4'),
    signal = new AbortController().signal;
  await assert.rejects(failing.chunk(lease, 0, signal), /Hardware unavailable/);
  await assert.rejects(failing.chunk(lease, 0, signal), /Hardware unavailable/);
  assert.equal(calls, 1, 'a persistent encoder failure does not launch repeated jobs');
  await assert.rejects(failing.chunk(lease, 100, signal), /Invalid/);
  failing.release(lease);
  await failing.close();

  const runs = fakeRuns({ chunk: () => new Promise(() => {}) });
  const waiting = manage({}, fakeTools({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }), runs);
  const active = waiting.acquire({ id: '2', duration: 60, start: 'http://source' }, 'direct'),
    client = new AbortController();
  const chunk = waiting.chunk(active, 0, client.signal);
  while (!runs.started.length) await tick();
  client.abort();
  await assert.rejects(chunk, /disconnected/);
  waiting.release(active);
  await tick();
  assert.equal(runs.aborted[0], true);
  await waiting.close();
});

test('a fresh AV1 request joins the run after an earlier request for that chunk was cancelled', async () => {
  let settleFirst;
  const first = new Promise(resolve => (settleFirst = resolve));
  const runs = fakeRuns({ chunk: (_, n) => (n === 0 ? first : new Promise(() => {})) });
  const manager = manage({}, fakeTools(VIDEO), runs);
  const lease = manager.acquire({ id: '1', duration: 60, start: 'http://fixture' }, 'direct'),
    cancelled = new AbortController();
  try {
    const old = manager.chunk(lease, 0, cancelled.signal);
    while (!runs.started.length) await tick();
    cancelled.abort();
    await assert.rejects(old, /disconnected/);
    const fresh = manager.chunk(lease, 0, new AbortController().signal);
    settleFirst();
    const bytes = await fresh;
    assert.equal(runs.started.length, 1, 'the process kept going for the next request');
    assert.equal(
      lease.group.chunks.get(0)?.bytes,
      bytes,
      'late cancellation cannot delete the replacement cache entry',
    );
    assert.equal(lease.group.bytes, 250, 'only the delivered chunk counts against the cache budget');
  } finally {
    settleFirst();
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

test('shared probe survives one cancelled chunk and source fallback is learned for the run', async () => {
  let releaseProbe, entered;
  const started = new Promise(resolve => (entered = resolve));
  let probes = 0,
    hardware = 0,
    software = 0;
  const runs = fakeRuns({
    chunk: (args, n) => {
      if (n) return;
      if (args[args.indexOf('-c:v') + 1] === 'av1_qsv') {
        hardware++;
        throw Object.assign(new PlaybackError('Source encoder failure'), { encoderFailure: true, exitFailure: true });
      }
      software++;
    },
  });
  const tools = fakeTools({ streams: [{ codec_type: 'video', width: 640, height: 360 }] });
  const manager = manage(
    { transcoding: { encoder: 'qsv', cpuFallback: true, maxJobs: 2 } },
    async (binary, args, signal) => {
      if (args.includes('-show_entries')) {
        probes++;
        entered();
        await new Promise((resolve, reject) => {
          releaseProbe = resolve;
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      }
      return tools(binary, args, signal);
    },
    runs,
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
    assert.equal(software, 1, 'one software process carries on after the hardware encoder failed');
    assert.equal(lease.group.encoder, 'software');
  } finally {
    releaseProbe?.();
    manager.release(lease);
    await tick();
    assert.equal(manager.pendingBytes, 0);
    await manager.close();
  }
});

test('recent AV1 fallback demand survives wall steps and yields capacity only after monotonic expiry', async t => {
  let mono = 1000,
    wall = Date.now();
  t.mock.method(performance, 'now', () => mono);
  t.mock.method(Date, 'now', () => wall);
  const manager = manage({}, fakeTools({ streams: [{ codec_type: 'video', width: 640, height: 360 }] }), fakeRuns());
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

const SHARED = {
  streams: [
    { index: 0, codec_type: 'video', width: 1920, height: 1080 },
    { index: 1, codec_type: 'audio' },
    { index: 2, codec_type: 'audio' },
  ],
};

test('qualities of one source asking together share one process that decodes once, and one sound per choice', async () => {
  const sounds = [];
  const runs = fakeRuns();
  const manager = manage(
    {},
    fakeTools(SHARED, {
      audio: args => sounds.push([args[args.indexOf('-ss') + 1], args[args.indexOf('-map') + 1]]),
    }),
    runs,
  );
  const source = { id: '1', partId: '5', principal: 'alice', duration: 60, start: 'http://fixture' };
  const a = manager.acquire(source, '1080p8'),
    b = manager.acquire(source, '720p4'),
    c = manager.acquire({ ...source, audioIndex: 2, audioOrdinal: 1 }, '720p2'),
    burned = manager.acquire({ ...source, burn: { id: 's', index: 3, codec: 'ass' } }, '720p4'),
    signal = new AbortController().signal;
  try {
    assert.equal(burned.group.batchKey, undefined, 'burned subtitles belong to one selection');
    const chunks = await Promise.all([a, b, c].map(lease => manager.chunk(lease, 1, signal)));
    assert.equal(runs.started.length, 1, 'qualities asking for the same chunk join one process');
    const shared = runs.started[0];
    assert.equal(graph(shared).match(/split=(\d)/)?.[1], '3', 'one decode feeds all three qualities');
    assert.equal((graph(shared).match(/scale=1280:720/g) || []).length, 2, 'smaller qualities scale from the largest');
    assert.equal(shared.filter(arg => arg === '-i').length, 1, 'the picture opens the source once');
    assert.deepEqual(
      shared.filter((_, i) => shared[i - 1] === '-map'),
      ['[v0]', '[v1]', '[v2]'],
    );
    assert.ok(shared.includes('-force_key_frames') && shared.includes('segment'), 'chunks cut at forced keyframes');
    assert.deepEqual(
      chunks.map(bytes => bytes.video.length),
      [200, 201, 202],
      'each quality receives its own output',
    );
    const first = sounds.filter(([start]) => Number(start) < 6 && Number(start) > 5);
    assert.deepEqual(
      first.map(([, map]) => map).sort(),
      ['0:2', '0:a:0'],
      'two qualities with the same audio share one sound process',
    );
    assert.ok(chunks.every(bytes => bytes.audio.length));
  } finally {
    for (const lease of [a, b, c, burned]) manager.release(lease);
    await manager.close();
  }
});

test('a quality added while its siblings convert restarts the run with it; one that leaves is dropped', async () => {
  const runs = fakeRuns({ duration: 300 });
  const manager = manage({}, fakeTools(SHARED), runs);
  const source = { id: '1', partId: '5', principal: 'alice', duration: 300, start: 'http://fixture' };
  const a = manager.acquire(source, '1080p8'),
    b = manager.acquire(source, '720p4'),
    signal = new AbortController().signal;
  let c;
  try {
    await Promise.all([manager.chunk(a, 0, signal), manager.chunk(b, 0, signal)]);
    assert.equal(runs.started.length, 1);
    c = manager.acquire(source, '720p2');
    assert.ok((await manager.chunk(c, 0, signal)).video.length);
    assert.equal(runs.started.length, 2);
    await tick();
    assert.equal(runs.aborted[0], true, 'the old process stops');
    assert.equal(graph(runs.started[1]).match(/split=(\d)/)?.[1], '3', 'the new process converts all three');
    manager.release(b);
    const later = await Promise.all([manager.chunk(a, 12, signal), manager.chunk(c, 12, signal)]);
    assert.ok(later.every(bytes => bytes.video.length));
    assert.equal(runs.started.length, 2, 'a quality leaving costs no restart');
  } finally {
    for (const lease of [a, b, c]) if (lease) manager.release(lease);
    await manager.close();
  }
});

test('a failed shared run converts each quality alone, and the source is not shared again', async () => {
  const warnings = [];
  const runs = fakeRuns({
    duration: 300,
    chunk: (args, n) => {
      if (!n && args.filter(arg => /^segments:/.test(arg)).length > 1)
        throw Object.assign(new PlaybackError('split unsupported'), { exitFailure: true });
    },
  });
  const manager = manage({}, fakeTools(SHARED), runs, { warn: (_, message) => warnings.push(message), info() {} });
  const source = { id: '1', partId: '5', principal: 'alice', duration: 300, start: 'http://fixture' };
  const a = manager.acquire(source, '1080p8'),
    b = manager.acquire(source, '720p4'),
    signal = new AbortController().signal;
  try {
    const [x, y] = await Promise.all([manager.chunk(a, 0, signal), manager.chunk(b, 0, signal)]);
    assert.ok(x.video.length && y.video.length, 'both qualities still play');
    assert.equal(runs.started.length, 3, 'one failed shared process, then one per quality');
    assert.equal(warnings.filter(message => /Shared conversion failed/.test(message)).length, 1);
    await Promise.all([manager.chunk(a, 30, signal), manager.chunk(b, 30, signal)]);
    assert.equal(runs.started.length, 5);
    assert.ok(
      runs.started.slice(3).every(args => args.filter(arg => /^segments:/.test(arg)).length === 1),
      'a source whose shared conversion failed is not retried shared',
    );
  } finally {
    for (const lease of [a, b]) manager.release(lease);
    await manager.close();
  }
});

test('a seek outside the converted range starts a new process there and stops the abandoned one', async () => {
  const runs = fakeRuns({ duration: 600 });
  const manager = manage({}, fakeTools(VIDEO), runs);
  const lease = manager.acquire({ id: '1', duration: 600, start: 'http://fixture' }, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    await manager.chunk(lease, 2, signal);
    assert.equal(runs.started.length, 1, 'chunks ahead come from the same process');
    await manager.chunk(lease, 50, signal);
    assert.equal(runs.started.length, 2);
    assert.equal(runs.started[1][runs.started[1].indexOf('-ss') + 1], '300');
    await tick();
    assert.equal(runs.aborted[0], true);
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('a run holds its source past the look-ahead, stops when held, and resumes at the next missing chunk', async () => {
  const runs = fakeRuns({ duration: 600 });
  const manager = manage({}, fakeTools(VIDEO), runs);
  manager.timing.idle = 40;
  const lease = manager.acquire({ id: '1', duration: 600, start: 'http://fixture' }, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    while (!runs.aborted[0]) await tick();
    assert.equal(runs.produced[0], 11, 'the playhead chunk and a minute ahead of it, then held');
    assert.deepEqual(
      [...lease.group.chunks].filter(([, entry]) => entry.bytes).map(([index]) => index),
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.equal(manager.active, 0, 'a held run gives back its slot');
    await manager.chunk(lease, 11, signal);
    assert.equal(runs.started.length, 2);
    assert.equal(runs.started[1][runs.started[1].indexOf('-ss') + 1], '66');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('look-ahead requests extend a run only to the chunk asked for, so it stays near the playhead', async () => {
  const runs = fakeRuns({ duration: 600 });
  const manager = manage({}, fakeTools(VIDEO), runs);
  const lease = manager.acquire({ id: '1', duration: 600, start: 'http://fixture' }, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    // The player fetches its next minute, chunk by chunk, none of them at the playhead.
    for (let index = 1; index <= 12; index++) await manager.chunk(lease, index, signal, { urgent: false });
    await tick();
    assert.equal(runs.started.length, 1);
    assert.equal(lease.group.run.target, 12, 'the target is the furthest chunk asked for');
    assert.equal(runs.produced[0], 13, 'nothing beyond it is converted');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('a process failing mid-run keeps its chunks and starts again where it stopped, on the same path', async () => {
  let failed = false;
  const runs = fakeRuns({
    duration: 600,
    chunk: (_, n) => {
      if (n === 3 && !failed) {
        failed = true;
        throw Object.assign(new PlaybackError('device lost'), { exitFailure: true });
      }
    },
  });
  const manager = manage({}, fakeTools(VIDEO), runs);
  const lease = manager.acquire({ id: '1', duration: 600, start: 'http://fixture' }, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(lease, 0, signal);
    assert.ok((await manager.chunk(lease, 3, signal)).video.length);
    assert.equal(runs.started.length, 2);
    assert.equal(runs.started[1][runs.started[1].indexOf('-ss') + 1], '18');
    assert.equal(lease.group.decodeLevel || 0, 0, 'a failure after progress is not a reason to step down');
    for (const index of [0, 1, 2]) assert.ok(lease.group.chunks.get(index).bytes, 'finished chunks stay');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('a run gives its slot to waiting work at a chunk boundary', async () => {
  let hold;
  const held = new Promise(resolve => (hold = resolve));
  const runs = fakeRuns({
    duration: 600,
    chunk: (args, n) => (args.includes('http://one') && n === 1 ? held : undefined),
  });
  const manager = manage({ transcoding: { maxJobs: 1 } }, fakeTools(VIDEO), runs);
  manager.input = async (source, _signal, action) =>
    action(typeof source === 'function' ? 'http://' + source().id : 'http://' + source.id);
  const one = manager.acquire({ id: 'one', duration: 600, start: 'x' }, '720p4'),
    two = manager.acquire({ id: 'two', duration: 600, start: 'x' }, '720p4'),
    signal = new AbortController().signal;
  try {
    await manager.chunk(one, 0, signal);
    const other = manager.chunk(two, 0, signal);
    await tick();
    assert.equal(runs.started.length, 1, 'the other source waits for the only slot');
    hold();
    assert.ok((await other).video.length, 'the first run yields after its chunk');
    assert.ok(one.group.chunks.get(1)?.bytes, 'the chunk in progress was finished first');
    assert.equal(one.group.chunks.has(2), false);
    assert.ok((await manager.chunk(one, 2, signal)).video.length, 'and its viewers get their turn back');
  } finally {
    manager.release(one);
    manager.release(two);
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

test('six shared qualities with real chunk sizes fit memory: the run waits rather than evicting unread chunks', async () => {
  const MB = 1024 * 1024,
    sizes = { 20000: 11 * MB, 12000: 7 * MB, 8000: 4.5 * MB, 4000: 2.3 * MB, 2000: 1.3 * MB };
  const runs = fakeRuns({
    duration: 600,
    chunk: args => args.filter((_, i) => args[i - 1] === '-b:v').map(rate => sizes[parseInt(rate)] || 4.5 * MB),
  });
  const manager = manage(
    {},
    fakeTools({
      streams: [
        { index: 0, codec_type: 'video', width: 3840, height: 2160 },
        { index: 1, codec_type: 'audio' },
      ],
      format: { bit_rate: '8000000' },
    }),
    runs,
  );
  // An 8 Mbps source: converted Original is its own sixth output, not the 20 Mbps one.
  const source = { id: '1', partId: '5', principal: 'p', duration: 600, start: 'x', sourceBitrate: 8000 };
  const leases = ['direct', '1080p20', '1080p12', '1080p8', '720p4', '720p2'].map(q => manager.acquire(source, q));
  const signal = new AbortController().signal;
  try {
    assert.equal(new Set(leases.map(lease => lease.group)).size, 6);
    await Promise.all(leases.map(lease => manager.chunk(lease, 0, signal)));
    assert.equal(runs.started.length, 1, 'six qualities fit one shared process');
    assert.equal(graph(runs.started[0]).match(/split=(\d)/)[1], '6');
    await tick();
    assert.ok(manager.retainedBytes + manager.pendingBytes <= manager.maxBytes);
    for (const lease of leases) {
      await manager.chunk(lease, 1, signal);
      await manager.chunk(lease, 2, signal);
    }
    assert.equal(runs.started.length, 1, 'every quality reads its chunks from the one process');
    assert.ok(
      leases.every(lease => [...lease.group.chunks.values()].every(entry => !entry.error)),
      'a full cache holds the run instead of failing chunks',
    );
  } finally {
    for (const lease of leases) manager.release(lease);
    await tick();
    assert.equal(manager.pendingBytes, 0);
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

  const runs = fakeRuns();
  const manager = manage(
    { transcoding: { encoder: 'software', hardwareDecode: false } },
    fakeTools({ streams: [{ codec_type: 'video', width: 1920, height: 1080 }] }),
    runs,
  );
  const lease = manager.acquire({ id: '1', duration: 60, start: 'x' }, '720p4');
  try {
    await manager.chunk(lease, 0, new AbortController().signal);
    const args = runs.started[0];
    assert.equal(args[args.indexOf('-threads') + 1], String(Math.max(2, cores)), 'a lone CPU decode uses every core');
    assert.equal(args[args.indexOf('-svtav1-params') + 1], 'lp=6', 'a lone CPU encode uses the top level');
  } finally {
    manager.release(lease);
    await manager.close();
  }
});

test('segments hands over each finished segment in order and only a real end finishes the last', async () => {
  // Node stands in for FFmpeg: it opens each output's segments in turn, as the muxer does.
  const script = `const fs=require('fs');const [count,code]=process.argv.slice(-2).map(Number);
    const files=process.argv.slice(1,-2);let n=0;
    const step=()=>{if(n===count)process.exit(code);for(const f of files)fs.writeFileSync(f.replace('%d',n),Buffer.alloc(100+n));n++;setTimeout(step,60)};step();`;
  const collect = async (count, code, ended = () => true) => {
    const seen = [];
    const done = segments(
      process.execPath,
      ['-e', script, 'segments:0', 'segments:1', String(count), String(code)],
      undefined,
      {
        onSegment: (output, n, bytes) => seen.push([output, n, bytes.length]),
        ended,
        poll: 10,
      },
    );
    return { seen, done };
  };
  let { seen, done } = await collect(3, 0);
  await done;
  assert.deepEqual(
    seen.filter(([output]) => output === 0),
    [
      [0, 0, 100],
      [0, 1, 101],
      [0, 2, 102],
    ],
  );
  assert.equal(seen.length, 6);
  ({ seen, done } = await collect(3, 1));
  await assert.rejects(done, error => error.exitFailure === true);
  assert.deepEqual(
    seen.filter(([output]) => output === 1).map(([, n]) => n),
    [0, 1],
    'a failed process keeps its finished segments, not the one it was writing',
  );
  ({ seen, done } = await collect(2, 0, () => false));
  await assert.rejects(done, /stopped before its end/);
  assert.deepEqual(
    seen.map(([, n]) => n),
    [0, 0],
  );
});

test('segments stops a process whose route quietly lost its hardware decoder', async () => {
  // FFmpeg replaces a Vulkan decoder that fails setup with the CPU and carries on, slowly.
  const started = Date.now();
  await assert.rejects(
    segments(
      process.execPath,
      [
        '-e',
        "console.error('Failed setup for format vulkan: hwaccel initialisation returned error.');setInterval(()=>{},1000)",
        'segments:0',
      ],
      undefined,
      { onSegment() {}, failOn: /Failed setup for format vulkan/, poll: 10 },
    ),
    error => error.exitFailure === true,
  );
  assert.ok(Date.now() - started < 5000);
});
