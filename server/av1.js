'use strict';
// Six-second, on-demand WebM chunks. No episode download, background encoding,
// public upstream endpoint or new service to deploy.
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { silentLogger } = require('./logger');
const { randomBytes, createHash } = require('node:crypto');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { QUALITIES, qualityDefinition, qualityId } = require('../shared/room-protocol.mjs');
const Playback = require('../shared/playback-policy.mjs');
const { PlaybackError } = require('./errors');
const { run, segments, stream, fileIndex, classifyHdr, cpuTonemap } = require('./media-tools');
const { frameGrids, FRAME_GRID } = require('./media-facts');
const SubtitleResources = require('./subtitle-resources');
const CHUNK = Playback.BUFFER.chunkSeconds;
// Audio starts this early so Opus has settled before the chunk's first sample, and the
// player keeps only the chunk's own window. 312 samples of encoder delay plus ten
// 20 ms frames puts a packet edge exactly on the chunk boundary.
const AUDIO_LEAD_SAMPLES = 9912,
  AUDIO_LEAD = AUDIO_LEAD_SAMPLES / 48000;
const MIME = 'video/webm; codecs="av01.0.12M.08"',
  AUDIO_MIME = 'audio/webm; codecs="opus"';

// CPU encoders get this job's share of the machine: VP9/VP8 as threads, SVT-AV1 as its
// parallelism level (1-6), which it otherwise sets near the whole machine in every process.
function encoderArgs(encoder = 'qsv', codec = 'av1', threads = 2, cores = os.availableParallelism()) {
  if (!Playback.localFormat(codec)) throw new PlaybackError('Unknown local output codec.');
  if (encoder === 'software') {
    if (codec === 'av1') {
      const level = Math.min(6, Math.max(1, Math.ceil((6 * threads) / Math.max(threads, cores))));
      return [
        '-c:v',
        'libsvtav1',
        '-preset',
        '10',
        '-svtav1-params',
        'lp=' + level,
        '-pix_fmt',
        'yuv420p',
        '-flags',
        '+global_header',
      ];
    }
    return [
      '-c:v',
      codec === 'vp9' ? 'libvpx-vp9' : 'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      codec === 'vp9' ? '6' : '8',
      '-threads',
      String(threads),
      '-lag-in-frames',
      '0',
      '-auto-alt-ref',
      '0',
      ...(codec === 'vp9' ? ['-row-mt', '1'] : []),
      '-pix_fmt',
      'yuv420p',
    ];
  }
  if (encoder === 'nvenc') {
    if (codec !== 'av1')
      throw new PlaybackError(
        'NVENC does not encode ' + codec.toUpperCase() + '. Enable CPU fallback or choose another backend.',
      );
    return [
      '-c:v',
      'av1_nvenc',
      '-preset',
      'p4',
      '-pix_fmt',
      'yuv420p',
      '-bf',
      '0',
      '-forced_idr',
      '1',
      '-flags',
      '+global_header',
    ];
  }
  if (codec === 'vp8')
    throw new PlaybackError('VP8 requires the software backend. Enable CPU fallback or select software.');
  return [
    '-c:v',
    codec === 'vp9' ? 'vp9_qsv' : 'av1_qsv',
    '-preset',
    'veryfast',
    '-pix_fmt',
    'nv12',
    '-bf',
    '0',
    // A forced keyframe must be a key frame, not an intra frame later chunks depend on.
    '-forced_idr',
    '1',
    '-flags',
    '+global_header',
  ];
}
// SVT-AV1 rejects a maximum bitrate outside CRF mode, so it gets a plain target.
function rateArgs(encoder, codec, bitrate) {
  const target = ['-b:v', `${bitrate}k`];
  return encoder === 'software' && codec === 'av1'
    ? target
    : [...target, '-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`];
}
async function probeEncoder(ffmpeg, signal, execute = run, encoder = 'hardware', codec = 'av1') {
  const output = await execute(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x180:rate=30',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000',
      '-t',
      '0.5',
      ...encoderArgs(encoder, codec),
      '-b:v',
      '500k',
      '-c:a',
      'libopus',
      '-ac',
      '2',
      '-f',
      'webm',
      '-live',
      '1',
      'pipe:1',
    ],
    signal,
    15000,
  );
  if (output.length < 100) throw new PlaybackError('WebM hardware probe produced no video.');
  return output;
}

function resolveQuality(quality) {
  if (quality && typeof quality === 'object' && Number(quality.height) > 0) {
    return {
      id: quality.id || `${quality.height}p${quality.bitrate}`,
      width: quality.width || Math.round((Number(quality.height) * 16) / 9),
      height: Number(quality.height),
      bitrate: Number(quality.bitrate) || undefined,
    };
  }
  const q = qualityDefinition(quality);
  if (q) return q;
  const match = /^(\d{3,4})p(\d+(?:\.\d+)?)$/.exec(String(quality || ''));
  if (match) {
    const height = Number(match[1]);
    const rawRate = Number(match[2]);
    return {
      id: String(quality),
      width: Math.round((height * 16) / 9),
      height,
      bitrate: rawRate <= 100 ? Math.round(rawRate * 1000) : Math.round(rawRate),
    };
  }
  return null;
}

function outputSpec(info, quality, maxQuality = QUALITIES[1]) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video || !(video.width > 0 && video.height > 0))
    throw new PlaybackError('Original source has no readable video.');
  const q = resolveQuality(quality);
  if (!q) throw new PlaybackError('Invalid WebM quality.');
  const ceiling = q.id === 'direct' && maxQuality ? maxQuality : q;
  const maxWidth = ceiling.width || 3840,
    maxHeight = ceiling.height || 2160;
  const ratio = Math.min(1, maxWidth / video.width, maxHeight / video.height);
  const width = Math.max(2, Math.floor((video.width * ratio) / 2) * 2),
    height = Math.max(2, Math.floor((video.height * ratio) / 2) * 2);
  const hdrInfo = classifyHdr(video);
  const hdr = hdrInfo.hdr;
  // Keep constant-rate source cadence. Forcing 30 fps duplicates film frames and
  // discards half of a 60 fps source, even when both decoder and encoder keep up.
  const tonemap = cpuTonemap(hdrInfo);
  const filters = ['setpts=PTS-STARTPTS', ...tonemap, `scale=${width}:${height}:out_color_matrix=bt709`, 'format=nv12'];
  const sourceBitrate = Number(info.format?.bit_rate) / 1000;
  const maxBitrate = ceiling.bitrate || 20000;
  const bitrate =
    q.bitrate ||
    Math.min(maxBitrate, Math.max(2000, Number.isFinite(sourceBitrate) ? sourceBitrate : Math.min(12000, maxBitrate)));
  // Carry the measured source rate through the encoder and WebM DefaultDuration.
  // Timestamp passthrough without packet durations creates MSE buffer holes on
  // some clients. This establishes CFR coverage; VFR timing needs separate tests.
  let frameRate;
  for (const rate of [video.r_frame_rate, video.avg_frame_rate]) {
    const match = /^(\d+)\/(\d+)$/.exec(rate || '');
    if (
      match &&
      Number(match[2]) > 0 &&
      Number(match[1]) / Number(match[2]) > 0 &&
      Number(match[1]) / Number(match[2]) <= 240
    ) {
      frameRate = rate;
      break;
    }
  }
  return {
    width,
    height,
    hdr,
    hdrKind: hdrInfo.kind,
    hdrLabel: hdrInfo.label,
    doviProfile: hdrInfo.doviProfile,
    doviP5: hdrInfo.doviP5,
    bitrate,
    frameRate,
    tonemap,
    sourceFormat: video.pix_fmt,
    sourceCodec: video.codec_name,
    filter: filters.join(','),
    audio: info.streams.some(s => s.codec_type === 'audio'),
  };
}

// Decoding and scaling on the GPU removes the 4K cost. Every route uses FFmpeg's
// own decoder with -hwaccel. Never use wrapper decoders such as hevc_qsv: after a
// seek it mislabels frames, so chunks start up to three frames early.
// HDR tonemaps through libplacebo with peak detection off, the closest GPU match
// to the CPU picture. vpp_qsv tonemapping crushes shadows (its scaling matches libplacebo
// within SSIM 0.99, measured on a UHD remux), and tonemap_opencl adapts per
// process, so the first frame after every restart flashes.
// Sources without a listed surface format stay on the CPU path.
// Burned subtitles need cues that began before the run. Bitmap tracks decode a
// short run-in, so GPU routes stay real time; text cues only need reading.
const BITMAP_RUN_IN = 8,
  TEXT_RUN_IN = 15;
const bitmapSubtitle = track => ['pgs', 'hdmv_pgs_subtitle', 'vobsub', 'dvd_subtitle'].includes(track.codec);
const filterPath = file => file.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
const SURFACES = { yuv420p: 'nv12', nv12: 'nv12', yuv420p10le: 'p010le', p010le: 'p010le' };
const VAAPI_DEVICE = '/dev/dri/renderD128';
function cpuPlaceboRoute(spec, platform = process.platform) {
  if (!spec.hdr || platform === 'darwin') return;
  const surface = SURFACES[spec.sourceFormat] || 'p010le';
  return {
    input: ['-init_hw_device', 'vulkan=v', '-filter_hw_device', 'v'],
    filter: [
      'setpts=PTS-STARTPTS',
      `format=${surface}`,
      `libplacebo=w=${spec.width}:h=${spec.height}:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:apply_dolbyvision=1`,
    ].join(','),
  };
}
// NVENC can keep HDR on the GPU through libplacebo only if Vulkan decodes: FFmpeg can't
// map CUDA frames into Vulkan, or copy them there. The tonemapped picture is copied to
// CUDA, smaller qualities scale there, and NVENC takes the frames as they are. Measured
// on an RTX 4090, 60 s of a 4K HDR10 remux with five qualities: about 6x real time through
// CUDA and system memory, 10x this way, same picture. Downloading the tonemapped picture
// instead saves nothing with five qualities: CPU scaling and five uploads cost as much.
// Burned subtitles overlay in system memory, so those runs download (`burnFilter`).
// If Vulkan setup fails, FFmpeg silently decodes on the CPU instead, so `failOn` stops the
// run and it steps down to the CUDA route.
const VULKAN_DECODE = ['hevc', 'h264', 'av1'];
function vulkanRoute(spec, encoder, platform = process.platform) {
  if (encoder !== 'nvenc' || !spec.hdr || spec.doviP5 || platform === 'darwin') return;
  if (!VULKAN_DECODE.includes(spec.sourceCodec) || !SURFACES[spec.sourceFormat]) return;
  const placebo = [
    'setpts=PTS-STARTPTS',
    `libplacebo=w=${spec.width}:h=${spec.height}:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:apply_dolbyvision=1`,
  ];
  return {
    label: 'Vulkan decode',
    filter: [...placebo, 'hwupload=derive_device=cuda'].join(','),
    burnFilter: [...placebo, 'hwdownload', 'format=nv12'].join(','),
    scale: (width, height) => `scale_cuda=${width}:${height}`,
    gpuFrames: true,
    input: [
      '-init_hw_device',
      'cuda=cu',
      // Derived from CUDA, so Vulkan decodes on the GPU that encodes.
      '-init_hw_device',
      'vulkan=v@cu',
      '-hwaccel',
      'vulkan',
      '-hwaccel_device',
      'v',
      '-hwaccel_output_format',
      'vulkan',
      '-filter_hw_device',
      'v',
    ],
    failOn: /Failed setup for format vulkan/,
  };
}
function decodeRoute(spec, encoder, platform = process.platform, gpuTonemap = true) {
  const surface = SURFACES[spec.sourceFormat];
  if (!surface) return;
  if (spec.doviP5 && (!gpuTonemap || platform === 'darwin')) return;
  const size = `${spec.width}:${spec.height}`,
    vpp = `vpp_qsv=w=${spec.width}:h=${spec.height}:format=${surface}`;
  const placebo = spec.hdr && gpuTonemap && platform !== 'darwin';
  const route = (input, gpu, downloaded = true) => ({
    label: placebo ? 'GPU tonemapping' : 'Hardware decode',
    input: placebo
      ? [
          '-init_hw_device',
          'vulkan=v',
          ...input.filter((_, i) => input[i] !== '-filter_hw_device' && input[i - 1] !== '-filter_hw_device'),
          '-filter_hw_device',
          'v',
        ]
      : input,
    filter: [
      'setpts=PTS-STARTPTS',
      ...gpu,
      ...(downloaded ? ['hwdownload', `format=${surface}`] : []),
      ...(placebo
        ? [
            `libplacebo=w=${spec.width}:h=${spec.height}:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:apply_dolbyvision=1`,
          ]
        : [
            ...(gpu.length ? [] : [`scale=${size}`]),
            ...spec.tonemap,
            `scale=${size}:out_color_matrix=bt709`,
            'format=nv12',
          ]),
    ].join(','),
  });
  if (encoder === 'nvenc')
    return route(
      ['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda'],
      spec.doviP5 ? [] : [`scale_cuda=${spec.width}:${spec.height}:format=${surface}`],
    );
  if (encoder === 'qsv') {
    const device =
      platform === 'win32'
        ? ['d3d11va=d,vendor_id=0x8086', 'd3d11va', 'd3d11']
        : [`vaapi=d:${VAAPI_DEVICE}`, 'vaapi', 'vaapi'];
    // Scale on the GPU while the picture is still HDR, so only the output size crosses to
    // libplacebo, as with CUDA and VAAPI. Copying whole 4K frames cost a third of each chunk.
    // Dolby Vision Profile 5 needs its original frame for libplacebo to reshape.
    if (placebo)
      return route(
        [
          '-init_hw_device',
          device[0],
          ...(spec.doviP5 ? [] : ['-init_hw_device', 'qsv=q@d']),
          '-hwaccel',
          device[1],
          '-hwaccel_device',
          'd',
          '-hwaccel_output_format',
          device[2],
        ],
        spec.doviP5 ? [] : ['hwmap=derive_device=qsv', 'format=qsv', vpp],
      );
    return route(
      [
        '-init_hw_device',
        device[0],
        '-init_hw_device',
        'qsv=q@d',
        '-hwaccel',
        device[1],
        '-hwaccel_device',
        'd',
        '-hwaccel_output_format',
        device[2],
        '-filter_hw_device',
        'q',
      ],
      ['hwmap=derive_device=qsv', 'format=qsv', vpp],
    );
  }
  if (platform === 'win32') return route(['-hwaccel', 'd3d11va', '-hwaccel_output_format', 'd3d11'], []);
  if (platform === 'darwin') return route(['-hwaccel', 'videotoolbox'], [], false);
  return route(
    ['-hwaccel', 'vaapi', '-hwaccel_device', VAAPI_DEVICE, '-hwaccel_output_format', 'vaapi'],
    spec.doviP5 ? [] : [`scale_vaapi=w=${spec.width}:h=${spec.height}:format=${surface}`],
  );
}

// The decode routes a chunk tries in order: Vulkan decode (NVENC HDR only), GPU
// tonemapping, GPU decode, then the CPU. A failed route steps down; only a later
// success proves the step.
function decodeRoutes(spec, encoder, hardwareDecode = true, platform = process.platform) {
  const unique = (route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i;
  if (spec.doviP5)
    return [...(hardwareDecode ? [decodeRoute(spec, encoder, platform)] : []), cpuPlaceboRoute(spec, platform)].filter(
      unique,
    );
  return [
    ...(hardwareDecode
      ? [
          vulkanRoute(spec, encoder, platform),
          decodeRoute(spec, encoder, platform),
          decodeRoute(spec, encoder, platform, false),
        ].filter(unique)
      : []),
    undefined,
  ];
}

// One process can make chunks for every quality of a source: the picture is
// decoded and tonemapped once, at the largest size, then split and scaled for each.
// Decoding and tonemapping a 4K source is most of a chunk's cost; encoding is not.
const BATCH_MAX = 6,
  BATCH_DEMAND_MS = 30000;

// One process per source converts consecutive chunks for every quality sharing it, rather
// than one process per chunk: starting FFmpeg, its GPU devices and the seek cost about as
// much as converting a chunk. The process reads the source only while the chunk it is
// converting is wanted (a viewer's look-ahead), and stops after RUN_IDLE_MS held.
const AHEAD = Playback.BUFFER.ahead / CHUNK,
  JOIN_URGENT = 2,
  GATHER_MS = 250,
  RUN_IDLE_MS = 10000,
  RUN_STALL_MS = 30000,
  TEXT_BURN_CHUNKS = 5;

// Holds a run's source reads while nobody needs the chunk it would convert next.
class Gate {
  constructor() {
    this.open = true;
    this.waiters = [];
  }
  set(open) {
    this.open = open || !!this.ended;
    if (this.open) for (const resolve of this.waiters.splice(0)) resolve();
  }
  wait() {
    return this.open ? undefined : new Promise(resolve => this.waiters.push(resolve));
  }
  end() {
    this.ended = true;
    this.set(true);
  }
}
const delay = (ms, signal) =>
  new Promise(resolve => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

const seconds = ms => (ms / 1000).toFixed(1) + 's';
// Each provider response a bridged input waited for: how many, and the slowest.
function noteResponse(state, asked) {
  if (!state) return;
  const waited = (Date.now() - asked) / 1000;
  state.requests = (state.requests || 0) + 1;
  state.slowest = Math.max(state.slowest || 0, waited);
}
// A chunk's sound read by its own short process: a process's first chunk, silence, or sound
// the run's decoded copy could not supply. It starts AUDIO_LEAD early and ends 0.04 s
// late, so consecutive chunks overlap and each decodes on its own; the player keeps only
// the chunk's window. The first chunk has nothing before it, so silence takes the lead's place.
// Matroska rounds audio packet times to the millisecond, so processes that seek separately
// disagree by up to a millisecond about where a sample is, and chunks made by different
// processes clicked where the player joined them. Most codecs' frames sit on a fixed grid from
// the stream's first packet: each process snaps its first decoded frame onto that grid and
// counts samples from there, so every chunk lands on one sample-exact timeline, whichever
// process made it. Every frame is a whole number of grid steps, and half a step is wider than
// the timestamp error. The decoder drops encoder delay from the first packet it decodes, after
// a seek too, which shortens that frame, so its end is what is snapped. FLAC's and PCM's grid
// is their packets' size, when the source's first packets are all of one size. TrueHD's
// access units are under a millisecond long, but its sound starts at a major sync: the grid
// is the major sync interval (Blu-ray discs: 128 units, after a shorter first one), counted in
// units from the stream's first packet. FFmpeg's decoder makes one frame too many when it
// opens: at the stream's start it delays the sound by a unit, and after a seek it comes from
// the cluster's first packet, ahead of a gap to the first major sync. That frame is dropped,
// and so is anything else before the first frame at the start or on the grid. Vorbis and Opus
// keep their own timestamps.
function snap(stream) {
  const syncs = stream?.major_sync_units,
    grid = syncs
      ? `${syncs * 40}*max(1,round(SR/44100))`
      : stream?.even_packets
        ? 'NB_SAMPLES'
        : FRAME_GRID[stream?.codec_name];
  if (!grid) return '';
  // Without the stream's first packet time, the grid starts at zero.
  const first = `(${Number(stream.first_pts) || 0})*SR`;
  if (!syncs) {
    const [end, back] = stream.even_packets ? ['', ''] : ['+NB_SAMPLES', '-NB_SAMPLES'],
      at = `round((STARTPTS*TB*SR${end}-${first})/(${grid}))*(${grid})+${first}${back}`;
    return `asetpts='round((if(eq(N,0),st(0,${at}),ld(0))+N)/SR/TB)',`;
  }
  // TrueHD: sound starts at the stream's start or at a major sync on the grid from the second.
  const anchor = `(${stream.grid_from})*SR`,
    at = time => `round((${time}-${anchor})/(${grid}))*(${grid})+${anchor}`,
    near = (time, to) => `lt(abs(${time}-(${to})),0.0025*SR)`,
    sound = time => `${near(time, first)}+${near(time, at(time))}`,
    start = 'STARTPTS*TB*SR';
  const select = `aselect='st(1,ld(1)+gt(n,0)*(${sound('t*SR')}))',`.replaceAll('SR', 'sample_rate');
  return `${select}asetpts='round((if(eq(N,0),st(0,if(${near(start, first)},${first},${at(start)})),ld(0))+N)/SR/TB)',`;
}
// AC-3's decoder dithers with a generator seeded when it opens, so a process that seeks hears
// other noise than one from the start; seeded from each frame, they decode alike.
const decoderArgs = stream => (['ac3', 'eac3'].includes(stream?.codec_name) ? ['-cons_noisegen', '1'] : []);
// The sound at 48 kHz from sample `first` on: trimmed, or padded with silence where the source
// has none yet. Unlike adelay it keeps the channel layout, which the stereo downmix needs.
const PAD = first => `aresample=48000,aresample=async=1:first_pts=${first}`;
// Each chunk decodes from 2 s before its lead (the first from the source's start), on the
// source's own times, and is laid down exactly as the run's decoder lays down its sound.
function audioCommand(url, spec, audioMap, start, duration, stream) {
  const from = start - AUDIO_LEAD,
    length = duration + AUDIO_LEAD + 0.04;
  let input, filter;
  if (!spec.audio) {
    input = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', String(length)];
    filter = 'asetpts=PTS-STARTPTS';
  } else {
    input = [
      ...(start ? ['-ss', String(Math.max(0, from - 2))] : []),
      '-noaccurate_seek',
      '-copyts',
      ...decoderArgs(stream),
      '-i',
      url,
    ];
    filter =
      `${snap(stream)}${PAD(Math.round(from * PCM_RATE))},` +
      `atrim=end_sample=${Math.round(length * PCM_RATE)},asetpts=PTS-STARTPTS`;
  }
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    ...input,
    '-map',
    spec.audio ? audioMap(0) : '0:a:0',
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-af',
    filter,
    ...OPUS,
  ];
}
// Every chunk's sound is its own Opus stream: browsers start each WebM piece afresh.
const OPUS = [
  '-c:a',
  'libopus',
  '-b:a',
  '128k',
  '-ac',
  '2',
  '-ar',
  '48000',
  '-f',
  'webm',
  '-live',
  '1',
  '-cluster_time_limit',
  '1000',
  'pipe:1',
];
// A run decodes its sound once. Its process copies the chosen streams' packets out as they
// are read, restored to the source's own times: an input seek takes away the seek point and
// the file's start time, and -copyts on the decoder keeps them. Each decoder lays the sound
// down from `from` on the same sample-exact timeline as audioCommand, as 48 kHz stereo floats.
const PCM_RATE = 48000,
  PCM_FRAME = 8;
function soundCopyArgs(maps, offset, length) {
  return [
    ...maps.flatMap(map => ['-map', map]),
    '-vn',
    '-sn',
    '-dn',
    '-map_metadata',
    '-1',
    '-map_chapters',
    '-1',
    '-c:a',
    'copy',
    '-output_ts_offset',
    String(offset),
    ...(length ? ['-t', String(length)] : []),
    // Matroska carries every codec a source can have (NUT refuses TrueHD and ALAC); short
    // clusters hand the sound over as it is read.
    '-f',
    'matroska',
    '-live',
    '1',
    '-cluster_time_limit',
    '200',
    'pipe:1',
  ];
}
function soundDecodeCommand(index, from, stream) {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-copyts',
    ...decoderArgs(stream),
    '-f',
    'matroska',
    '-i',
    'pipe:0',
    '-map',
    `0:a:${index}`,
    '-vn',
    '-af',
    `${snap(stream)}${PAD(Math.round(from * PCM_RATE))},asetpts=PTS-STARTPTS`,
    '-ac',
    '2',
    '-ar',
    String(PCM_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ];
}
// One chunk's Opus from decoded samples on standard input.
function encodeCommand() {
  return [
    '-hide_banner',
    '-loglevel',
    'error',
    '-nostdin',
    '-f',
    'f32le',
    '-ar',
    String(PCM_RATE),
    '-ac',
    '2',
    '-i',
    'pipe:0',
    '-map_metadata',
    '-1',
    ...OPUS,
  ];
}
// When each track of the copy starts: the time in seconds of its first block, by track
// number, from the start of a Matroska stream. Undefined until every one of `tracks` has a
// block, or if the stream is not one this can read.
const EBML_MASTER = new Set([0x18538067, 0x1549a966, 0x1f43b675, 0xa0]);
function copyStarts(bytes, tracks) {
  const vint = (at, id) => {
    const first = bytes[at];
    if (first === undefined || !first) return undefined;
    const length = Math.clz32(first) - 23;
    if (at + length > bytes.length) return undefined;
    let value = id ? first : first & (0xff >> length),
      unknown = value === 0xff >> length;
    for (let i = 1; i < length; i++) {
      value = value * 256 + bytes[at + i];
      unknown &&= bytes[at + i] === 0xff;
    }
    return { value: unknown && !id ? Infinity : value, length };
  };
  const starts = new Map();
  let scale = 1e6,
    cluster = 0;
  for (let at = 0; at < bytes.length && starts.size < tracks;) {
    const id = vint(at, true),
      size = id && vint(at + id.length, false);
    if (!size) return undefined;
    const body = at + id.length + size.length;
    if (EBML_MASTER.has(id.value)) {
      at = body;
      continue;
    }
    if (size.value === Infinity) return undefined;
    if (body + size.value > bytes.length) return undefined;
    const uint = () => bytes.subarray(body, body + size.value).reduce((v, b) => v * 256 + b, 0);
    if (id.value === 0x2ad7b1) scale = uint();
    else if (id.value === 0xe7) cluster = uint();
    else if (id.value === 0xa3 || id.value === 0xa1) {
      const track = vint(body, false);
      if (!track) return undefined;
      const relative = bytes.readInt16BE(body + track.length);
      if (!starts.has(track.value)) starts.set(track.value, ((cluster + relative) * scale) / 1e9);
    }
    at = body + size.value;
  }
  return starts.size < tracks ? undefined : starts;
}
// A run's decoded sound for one audio choice, from the lead of the process's first chunk,
// padded with silence where the copy has no sound yet. Each chunk takes its window (the same
// one audioCommand cuts); samples before the earliest chunk still to come are dropped. The
// first chunk needs real sound before its window, so it is taken only when the copy began
// early enough (or at the file's start). Once the process has ended, a chunk the samples do
// not cover gets nothing, so it reads the source itself, except the source's last chunk,
// which takes what there is.
const SOUND_PREROLL = 0.5;
class SoundMemory {
  constructor(start, last, limit = 64 * 1024 * 1024) {
    this.start = start;
    this.from = start * CHUNK - AUDIO_LEAD;
    this.last = last;
    this.limit = limit;
    this.parts = [];
    this.dropped = 0;
    this.size = 0;
    this.waiters = new Set();
    this.began = new Promise(resolve => (this.begin = resolve));
  }
  // Whether chunk k's window has real sound before it, once the copy's start is known.
  async covers(k) {
    if (k > this.start || !this.start) return true;
    const began = await this.began;
    return began !== undefined && began <= this.from - SOUND_PREROLL;
  }
  at(k) {
    return Math.round((k * CHUNK - AUDIO_LEAD - this.from) * PCM_RATE) * PCM_FRAME;
  }
  add(bytes) {
    if (this.ended) return;
    this.parts.push(bytes);
    this.size += bytes.length;
    // Nobody is taking it, so the run would only keep growing: chunks read the source instead.
    if (this.size - this.dropped > this.limit) this.end(false);
    else this.check();
  }
  end(complete) {
    if (this.ended) return;
    this.ended = true;
    this.complete = complete;
    this.begin(undefined);
    this.check();
    if (!complete) this.parts = [];
  }
  wait(k, duration) {
    const start = this.at(k),
      end = start + Math.round((duration + AUDIO_LEAD + 0.04) * PCM_RATE) * PCM_FRAME;
    if (start < this.dropped || (this.ended && !this.complete)) return Promise.resolve(undefined);
    return new Promise(resolve => {
      this.waiters.add({ k, start, end, resolve });
      this.check();
    });
  }
  check() {
    for (const waiter of this.waiters) {
      const { k, start, end, resolve } = waiter;
      if (this.size >= end) resolve(this.slice(start, end));
      else if (this.ended)
        resolve(this.complete && k === this.last && this.size > start ? this.slice(start, this.size) : undefined);
      else continue;
      this.waiters.delete(waiter);
    }
  }
  slice(start, end) {
    const out = Buffer.alloc(end - start);
    let at = this.dropped;
    for (const part of this.parts) {
      const from = Math.max(start, at),
        to = Math.min(end, at + part.length);
      if (to > from) part.copy(out, from - start, from - at, to - at);
      at += part.length;
      if (at >= end) break;
    }
    return out;
  }
  // The run reached chunk k: what comes before its window, and before every waiting chunk's, goes.
  advance(k) {
    const keep = Math.min(this.at(k), ...[...this.waiters].map(waiter => waiter.start));
    while (this.parts.length && this.dropped + this.parts[0].length <= keep) this.dropped += this.parts.shift().length;
  }
}

const { SharedTask, runOperation } = require('./operation');

class AV1 {
  constructor(config = {}, execute = run, logger = silentLogger, runSegments = segments) {
    this.ffmpeg = config.ffmpegPath;
    this.jobs = new Set();
    this.encoder = config.transcoding?.encoder || 'auto';
    this.cpuFallback = config.transcoding?.cpuFallback ?? true;
    this.hardwareDecode = config.transcoding?.hardwareDecode ?? true;
    this.maxQuality = (config.transcoding?.qualities || QUALITIES).find(q => q.id !== 'direct') || QUALITIES[1];
    this.logger = logger;
    this.maxBytes = 256 * 1024 * 1024;
    this.jobBytes = 48 * 1024 * 1024;
    this.pendingBytes = 0;
    this.maxActive = Math.min(config.transcoding?.maxJobs || 2, Math.floor(this.maxBytes / this.jobBytes));
    this.run = (...args) => {
      const invoke = () => execute(...args);
      const priority = args[6]?.priority;
      const job = Promise.resolve().then(() =>
        this.processGate ? this.processGate.run(args[2], invoke, priority ? { priority } : undefined) : invoke(),
      );
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {});
      return job;
    };
    this.segments = (...args) => {
      const job = Promise.resolve().then(() => runSegments(...args));
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {});
      return job;
    };
    this.stream = (...args) => {
      const invoke = () => stream(...args);
      const priority = args[6]?.priority;
      const job = Promise.resolve().then(() =>
        this.processGate ? this.processGate.run(args[2], invoke, priority ? { priority } : undefined) : invoke(),
      );
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {});
      return job;
    };
    this.ffprobe =
      config.ffprobePath ||
      (this.ffmpeg && path.join(path.dirname(this.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    this.groups = new Map();
    this.batchBroken = new Set();
    this.inputs = new Map();
    this.controllers = new Set();
    this.queue = [];
    this.active = 0;
    this.closed = false;
    this.memoryWaiters = new Set();
    this.memoryWakeScheduled = false;
    // Overridable for tests.
    this.timing = { gather: GATHER_MS, idle: RUN_IDLE_MS, stall: RUN_STALL_MS };
  }
  wakeMemoryWaiters() {
    if (this.memoryWakeScheduled || !this.memoryWaiters.size) return;
    this.memoryWakeScheduled = true;
    queueMicrotask(() => {
      this.memoryWakeScheduled = false;
      for (const check of [...this.memoryWaiters]) {
        try {
          if (check()) this.memoryWaiters.delete(check);
        } catch {
          this.memoryWaiters.delete(check);
        }
      }
    });
  }
  async waitForMemory(reserveBytes, signal) {
    this.pruneAll(reserveBytes, undefined, true);
    if (this.retainedBytes + this.pendingBytes + reserveBytes <= this.maxBytes) return;
    await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new PlaybackError('WebM preparation cancelled.'));
      let settled = false;
      const check = () => {
        if (settled) return true;
        if (signal?.aborted || this.closed) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          reject(new PlaybackError('WebM preparation cancelled.'));
          return true;
        }
        this.pruneAll(reserveBytes, undefined, true);
        if (this.retainedBytes + this.pendingBytes + reserveBytes <= this.maxBytes) {
          settled = true;
          signal?.removeEventListener('abort', onAbort);
          resolve();
          return true;
        }
        return false;
      };
      const onAbort = () => {
        this.memoryWaiters.delete(check);
        check();
      };
      this.memoryWaiters.add(check);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  async selectEncoder(codec = 'av1') {
    this.probePromises ||= new Map();
    if (!this.probePromises.has(codec)) {
      const promise = (async () => {
        const preferred =
          this.encoder === 'auto' || this.encoder === 'hardware'
            ? codec === 'av1'
              ? ['qsv', 'nvenc']
              : codec === 'vp9'
                ? ['qsv']
                : []
            : [this.encoder];
        const candidates = [...new Set([...preferred, ...(this.cpuFallback ? ['software'] : [])])];
        if (!candidates.length)
          throw new PlaybackError(
            codec.toUpperCase() + ' has no available hardware backend; enable CPU fallback or select software.',
          );
        for (const encoder of candidates) {
          try {
            await probeEncoder(
              this.ffmpeg,
              (this.shutdownSignal ||= (this.shutdownController = new AbortController()).signal),
              this.run,
              encoder,
              codec,
            );
            return encoder;
          } catch (error) {
            if (this.closed || encoder === candidates.at(-1)) throw error;
          }
        }
      })().catch(error => {
        this.probePromises.delete(codec);
        throw error;
      });
      this.probePromises.set(codec, promise);
    }
    return this.probePromises.get(codec);
  }
  acquire(source, quality, existingOnly = false, codec = 'av1', { background = false, conversionRelease } = {}) {
    if (!Playback.localFormat(codec)) throw new PlaybackError('Unknown local output codec.');
    if (!this.ffmpeg)
      throw new PlaybackError(
        'WebM unavailable: install FFmpeg on the server PATH or set tools.ffmpeg in config.yaml, then run the encoder probe.',
      );
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const scope = source.shareKey ? [source.shareKey, source.sourceKey] : source.principal;
    const key = createHash('sha256')
      .update(
        JSON.stringify([
          scope,
          source.id,
          source.partId,
          source.audioIndex,
          source.audioOrdinal,
          this.outputQuality(source, quality),
          codec,
          source.burn?.id,
        ]),
      )
      .digest('hex');
    if (existingOnly && !this.groups.has(key))
      throw Object.assign(new PlaybackError('No matching shared output is available.'), { conversionCapacity: true });
    let group = this.groups.get(key);
    if (!group) {
      if (!background && this.groups.size >= 8) {
        for (const candidate of this.groups.values()) {
          if (
            candidate.leases.size &&
            [...candidate.leases].every(lease => lease.background) &&
            performance.now() - (candidate.viewerDemandAt ?? -Infinity) > 15000
          ) {
            for (const lease of [...candidate.leases]) this.release(lease);
            break;
          }
        }
      }
      if (this.groups.size >= 8)
        throw Object.assign(new PlaybackError('WebM is busy; close an unused player or choose a shared quality.'), {
          conversionCapacity: true,
        });
      group = {
        key,
        source,
        quality,
        codec,
        refs: 0,
        chunks: new Map(),
        controllers: new Set(),
        leases: new Set(),
        bytes: 0,
        conversionRelease,
        // Qualities of one source that can share a decode. Burned subtitles are per selection.
        batchKey: source.burn
          ? undefined
          : createHash('sha256')
              .update(JSON.stringify([scope, source.id, source.partId, codec]))
              .digest('hex'),
      };
      this.groups.set(key, group);
    } else if (conversionRelease) {
      if (group.conversionRelease || this.liveRun(group)) conversionRelease();
      else group.conversionRelease = conversionRelease;
    }
    group.refs++;
    // Each lease keeps its authorized source for future uncached chunk work.
    group.source = source;
    const lease = { group, source, background, released: false };
    group.leases.add(lease);
    return lease;
  }
  release(lease) {
    if (!lease || lease.released) return;
    lease.released = true;
    const group = lease.group;
    group.leases?.delete(lease);
    if (group.leases?.size) group.source = group.leases.values().next().value.source;
    if (--group.refs > 0) return;
    this.groups.delete(group.key);
    group.conversionRelease?.();
    group.conversionRelease = undefined;
    group.infoTask?.abort();
    for (const controller of group.controllers) controller.abort();
    group.chunks.clear();
    group.bytes = 0;
    if (group.run) this.checkRun(group.run);
    this.wakeMemoryWaiters();
  }
  bridge() {
    return runOperation(undefined, () => this.openBridge());
  }
  async openBridge() {
    if (this.bridgePromise) return this.bridgePromise;
    this.bridgePromise = (async () => {
      const server = (this.server = http.createServer(async (req, res) => {
        const entry = this.inputs.get(req.url),
          source = typeof entry?.source === 'function' ? entry.source() : entry?.source;
        if (!entry || !source || entry.signal.aborted || !['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(403);
          return res.end();
        }
        const abort = new AbortController(),
          cancel = () => abort.abort();
        res.on('close', cancel);
        entry.signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, 30000),
          asked = Date.now();
        try {
          const response = await source.provider.request(source.start, {
            method: req.method,
            signal: abort.signal,
            streaming: true,
            headers: { Accept: '*/*', ...(req.headers.range ? { Range: req.headers.range } : {}) },
          });
          clearTimeout(timer);
          noteResponse(entry.state, asked);
          if (source.subtitleWindow && req.headers.range) {
            const requested = /^bytes=(\d+)-/.exec(req.headers.range),
              received = /^bytes (\d+)-\d+\/\d+$/.exec(response.headers.get('content-range') || '');
            if (response.status !== 206 || !requested || !received || requested[1] !== received[1]) {
              await response.body?.cancel().catch(() => {});
              res.writeHead(502);
              res.end();
              return;
            }
          }
          const headers = {};
          for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges'])
            if (response.headers.has(key)) headers[key] = response.headers.get(key);
          res.writeHead(response.status, headers);
          if (req.method === 'HEAD') res.end();
          else if (!entry.gate) await pipeline(Readable.fromWeb(response.body), res);
          else {
            // A held run stops here: FFmpeg's reads block and the whole process waits.
            for await (const piece of Readable.fromWeb(response.body)) {
              await entry.gate.wait();
              if (abort.signal.aborted || res.destroyed) break;
              if (!res.write(piece))
                await new Promise(resolve => {
                  const done = () => {
                    res.off('drain', done);
                    res.off('close', done);
                    resolve();
                  };
                  res.on('drain', done);
                  res.on('close', done);
                });
            }
            res.end();
          }
        } catch {
          // FFmpeg closing a request is normal when it seeks; the source failing under an
          // open request is not, and FFmpeg may take the cut-off for the end of the file.
          if (!res.destroyed && !entry.signal.aborted) entry.state.upstreamFailed = true;
          res.destroy();
        } finally {
          clearTimeout(timer);
          res.off('close', cancel);
          entry.signal.removeEventListener('abort', cancel);
        }
      }));
      server.requestTimeout = 0;
      server.headersTimeout = 30000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      if (this.closed) {
        server.close();
        throw new PlaybackError('Server is shutting down.');
      }
      server.unref();
      return server.address().port;
    })().catch(error => {
      this.bridgePromise = undefined;
      throw error;
    });
    return this.bridgePromise;
  }
  async input(source, signal, action, gate) {
    const port = await this.bridge(),
      key = '/' + randomBytes(24).toString('hex'),
      state = {};
    // A short-lived loopback capability is visible in the process arguments;
    // the provider's URL and credential are never passed to FFmpeg or FFprobe.
    this.inputs.set(key, { source, signal, gate, state });
    try {
      return await action(`http://127.0.0.1:${port}${key}`, state);
    } finally {
      this.inputs.delete(key);
    }
  }
  // Prepare what one chunk needs to burn the selected subtitle. Each process sees
  // only its own window, so cue timing comes from the same source position.
  async burnInput(source, url, start, duration, signal, info) {
    const track = source.burn;
    if (!track) return;
    if (bitmapSubtitle(track)) {
      if (track.external) throw new PlaybackError('External image subtitles cannot be burned by local conversion.');
      return { bitmap: true, runIn: Math.min(BITMAP_RUN_IN, start) };
    }
    const origin = track.external ? 0 : Number(info?.format?.start_time) || 0;
    let data;
    if (track.external) {
      const response = await source.provider.request(track.resources.data, { signal, headers: { Accept: '*/*' } });
      data = await SubtitleResources.read(response, signal, 4 * 1024 * 1024);
    } else {
      // Source timestamps, so cue times do not depend on the keyframe the seek landed on.
      data = await this.run(
        this.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-ss',
          String(origin + Math.max(0, start - TEXT_RUN_IN)),
          '-copyts',
          '-i',
          url,
          '-to',
          String(origin + start + duration),
          '-map',
          '0:' + track.index,
          '-c:s',
          'ass',
          '-f',
          'ass',
          'pipe:1',
        ],
        signal,
        20000,
        4 * 1024 * 1024,
      );
    }
    if (!data.length) return;
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uburoom-burn-')),
      file = path.join(
        directory,
        'subtitle.' + (track.external ? { subrip: 'srt', webvtt: 'vtt' }[track.codec] || track.codec : 'ass'),
      );
    await fs.writeFile(file, data);
    return { file, offset: origin + start, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
  }
  async slot(signal, action, owner, priority = { urgent: true }) {
    if (signal.aborted) throw new PlaybackError('WebM preparation cancelled.');
    if (this.active >= this.maxActive) {
      if (this.queue.length >= (priority.urgent ? 12 : 10)) throw new PlaybackError('WebM encoder is busy.');
      await new Promise((resolve, reject) => {
        const entry = {
          owner,
          priority,
          at: Date.now(),
          resolve: () => {
            signal.removeEventListener('abort', cancel);
            resolve();
          },
        };
        const cancel = () => {
          this.queue = this.queue.filter(x => x !== entry);
          reject(new PlaybackError('WebM preparation cancelled.'));
        };
        signal.addEventListener('abort', cancel, { once: true });
        this.queue.push(entry);
      });
    } else this.active++;
    try {
      if (signal.aborted) throw new PlaybackError('WebM preparation cancelled.');
      return await action();
    } finally {
      const now = Date.now();
      this.queue.sort(
        (a, b) =>
          Number(!!a.priority.background) - Number(!!b.priority.background) ||
          Number(b.priority.urgent || now - b.at >= 2000) - Number(a.priority.urgent || now - a.at >= 2000) ||
          Number(a.owner === owner) - Number(b.owner === owner) ||
          a.at - b.at,
      );
      const next = this.queue.shift();
      if (next) next.resolve();
      else this.active--;
    }
  }
  async chunk(lease, index, signal, { urgent = true, background = false } = {}) {
    if (lease.released || this.closed) throw new PlaybackError('WebM stream was replaced.');
    const group = lease.group,
      source = lease.source || group.source,
      start = index * CHUNK;
    if (!Number.isSafeInteger(index) || index < 0 || start >= source.duration)
      throw new PlaybackError('Invalid WebM chunk.');
    if (!background) {
      group.viewerDemandAt = performance.now();
      group.lastIndex = index;
      this.wakeMemoryWaiters();
    }
    let entry = group.chunks.get(index);
    if (entry?.controller.signal.aborted && !entry.error) {
      group.chunks.delete(index);
      entry = undefined;
    }
    // Briefly memoize failures to collapse concurrent track/viewer requests.
    // A later bounded client retry must be able to recover a temporary Plex
    // outage; caching a rejected chunk forever makes that source time unusable.
    if (entry?.error && !entry.users && performance.now() - entry.failedAt >= 5000) {
      group.chunks.delete(index);
      entry = undefined;
    }
    if (!entry) entry = this.request(group, source, index, { urgent, background });
    else if (this.liveRun(group)) this.want(this.liveRun(group), index, urgent);
    entry.at = Date.now();
    entry.users++;
    if (urgent) entry.priority.urgent = true;
    if (!background) entry.priority.background = false;
    try {
      const bytes = await new Promise((resolve, reject) => {
        const cancel = () => reject(new PlaybackError('WebM client disconnected.'));
        if (signal.aborted) return cancel();
        signal.addEventListener('abort', cancel, { once: true });
        entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
      entry.fetched = true;
      this.wakeMemoryWaiters();
      return bytes;
    } finally {
      if (--entry.users === 0 && !entry.bytes) {
        entry.controller.abort();
        this.wakeMemoryWaiters();
      }
    }
  }
  alive(run) {
    return !!run && !run.done && !run.controller.signal.aborted;
  }
  liveRun(group) {
    return this.alive(group?.run) ? group.run : undefined;
  }
  // Reads for a run use a source a viewer still holds: the one that started it while its
  // lease is held, otherwise a current lease's. Authorization stays with the leases.
  runSource(run) {
    const members = this.members(run);
    for (const { group, source } of members)
      if ([...group.leases].some(lease => lease.source === source)) return source;
    for (const { group } of members) if (group.leases.size) return group.source;
  }
  // The members a run still converts for: groups that are current and still belong to it.
  members(run) {
    return run.members.filter(member => member.group.run === run && this.groups.get(member.group.key) === member.group);
  }
  // A chunk this group's run will reach soon waits for it, and so does a sibling run that
  // has not started its process yet. Anything else starts a run at that chunk.
  request(group, source, index, { urgent, background }) {
    let run = this.liveRun(group);
    if (
      run &&
      index >= run.next &&
      index < run.end &&
      index <= run.next + (urgent ? JOIN_URGENT : background ? Infinity : AHEAD)
    ) {
      this.want(run, index, urgent);
      return this.runEntry(run, group, index);
    }
    if (!background && group.batchKey && !this.batchBroken.has(group.batchKey))
      for (const other of this.groups.values()) {
        run = this.liveRun(other);
        if (
          run &&
          !run.spawned &&
          !run.priority.background &&
          other.batchKey === group.batchKey &&
          run.members.length < BATCH_MAX &&
          (!run.encoder || !group.encoder || run.encoder === group.encoder) &&
          index >= run.start &&
          index <= run.start + JOIN_URGENT
        ) {
          this.join(run, { group, source });
          this.want(run, index, urgent);
          return this.runEntry(run, group, index);
        }
      }
    const members = [{ group, source }, ...(background ? [] : this.siblings(group, index))];
    return this.startRun(members, index, { urgent, background });
  }
  // Raise how far a run converts. A request at a viewer's playhead keeps the look-ahead
  // ahead of it; any other request (the player's own look-ahead, a prefetch, speculative
  // work) needs only that chunk, or the target would run away from the playhead.
  want(run, index, urgent) {
    run.target = Math.max(run.target, urgent ? index + AHEAD : index);
    this.flow(run);
  }
  newEntry(group, priority) {
    const controller = new AbortController();
    group.controllers.add(controller);
    this.controllers.add(controller);
    // A seek can make an already queued prefetch imminent; joining raises it.
    return { users: 0, at: Date.now(), queued: Date.now(), controller, priority };
  }
  // A pending entry the run fills when it converts that chunk.
  runEntry(run, group, index) {
    const entry = this.newEntry(group, run.priority);
    entry.run = run;
    const work = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    work.catch(() => {});
    this.track(group, index, entry, work);
    if (!run.pending.has(index)) run.pending.set(index, new Map());
    run.pending.get(index).set(group, entry);
    return entry;
  }
  // A group moves to a run with its pending chunks from there on. A run left with nobody stops.
  join(run, member) {
    const old = this.liveRun(member.group);
    member.group.run = run;
    if (!run.members.some(other => other.group === member.group)) run.members.push(member);
    run.target = Math.max(run.target, member.group.lastIndex ?? run.start);
    if (!old || old === run) return;
    for (const [index, entries] of old.pending) {
      const entry = entries.get(member.group);
      if (!entry || index < run.start) continue;
      entries.delete(member.group);
      entry.run = run;
      if (!run.pending.has(index)) run.pending.set(index, new Map());
      run.pending.get(index).set(member.group, entry);
    }
    this.checkRun(old);
  }
  checkRun(run) {
    if (this.alive(run) && !this.members(run).length)
      run.controller.abort(new PlaybackError('WebM preparation cancelled.'));
  }
  // Other qualities of this source whose viewers are near this chunk.
  siblings(group, index) {
    if (!group.batchKey || this.batchBroken.has(group.batchKey)) return [];
    const now = performance.now(),
      found = [];
    for (const other of this.groups.values()) {
      if (found.length >= BATCH_MAX - 1) break;
      if (other === group || other.batchKey !== group.batchKey || !other.leases.size) continue;
      if (other.encoder && group.encoder && other.encoder !== group.encoder) continue;
      if (now - (other.viewerDemandAt ?? -Infinity) > BATCH_DEMAND_MS) continue;
      if (other.lastIndex === undefined || index < other.lastIndex - 1 || index > other.lastIndex + AHEAD) continue;
      if (index * CHUNK >= other.source.duration) continue;
      found.push({ group: other, source: other.source });
    }
    return found;
  }
  // One process from this chunk on, for every member. A member whose old run was converting
  // just before this chunk starts there, so its chunk in progress is not lost.
  startRun(members, index, priority, { level, encoder, waitMemory = false } = {}) {
    const first = members[0];
    let start = index;
    for (const { group } of members) {
      const old = this.liveRun(group);
      if (old && old.next <= index && old.next >= index - JOIN_URGENT) start = Math.min(start, old.next);
    }
    const count = Math.ceil(first.source.duration / CHUNK),
      textBurn = first.source.burn && !bitmapSubtitle(first.source.burn);
    const run = {
      members: [],
      start,
      next: start,
      // Text cues are read for a window, so a burned text run is bounded.
      end: textBurn ? Math.min(count, start + TEXT_BURN_CHUNKS) : count,
      target: priority.urgent ? index + AHEAD : index,
      level: level ?? Math.max(0, ...members.map(({ group }) => group.decodeLevel || 0)),
      encoder: encoder ?? first.group.encoder,
      controller: new AbortController(),
      gate: new Gate(),
      priority: { ...priority },
      pending: new Map(),
      spawned: false,
      done: false,
      waitMemory,
    };
    this.controllers.add(run.controller);
    for (const member of members) this.join(run, member);
    const entry = first.group.chunks.get(index) || this.runEntry(run, first.group, index);
    run.promise = runOperation(run.controller.signal, () =>
      this.slot(run.controller.signal, () => this.drive(run), first.group.key, run.priority),
    )
      .catch(error => (run.error = error))
      .finally(() => this.settle(run));
    return entry;
  }
  // Pending chunks of a run that ended: a member now in another run that will reach them
  // moves there, anything else is cancelled so a later request starts it again.
  settle(run) {
    run.done = true;
    clearTimeout(run.idleTimer);
    clearTimeout(run.stallTimer);
    if (run.checkMemory) {
      this.memoryWaiters.delete(run.checkMemory);
      run.checkMemory = undefined;
    }
    run.gate.end();
    this.controllers.delete(run.controller);
    for (const [index, entries] of run.pending)
      for (const [group, entry] of entries) {
        const live = this.liveRun(group);
        if (live && index >= live.next) {
          entry.run = live;
          if (!live.pending.has(index)) live.pending.set(index, new Map());
          live.pending.get(index).set(group, entry);
          continue;
        }
        // A real failure stays briefly as that chunk's error; cancellation leaves nothing.
        if (!run.error || run.controller.signal.aborted) entry.controller.abort();
        entry.reject(run.error || new PlaybackError('WebM preparation cancelled.'));
      }
    run.pending.clear();
  }
  // The run's slot: one process, replaced at the chunk where it failed by the next step
  // down (GPU tonemapping, GPU decode, CPU, then the software encoder) until one works.
  async drive(run) {
    const signal = run.controller.signal,
      first = run.members[0],
      codec = first.group.codec;
    await this.conversionPolicy?.video('uburoom', codec, first.source.provider);
    let releaseConversion = first.group.conversionRelease;
    if (releaseConversion) {
      first.group.conversionRelease = undefined;
    } else {
      releaseConversion = await this.conversionPolicy?.wait({ signal, background: run.priority.background });
    }
    // From here the run holds a conversion slot; waiting before this is waiting for a slot.
    run.slotAt = Date.now();
    try {
      run.encoder ||= await this.selectEncoder(codec);
      const info = await this.sourceInfo(first.group, first.source, signal);
      for (const { group } of run.members) group.info ||= info;
      if (run.waitMemory) {
        const needed = run.members.reduce((sum, { group }) => sum + this.chunkBytes(group), 0);
        await this.waitForMemory(needed, signal);
        run.waitMemory = false;
      }
      // Siblings asking for the same chunk a moment later join before the process starts.
      if (!run.priority.background && this.gathering(run)) await delay(this.timing.gather, signal);
      let restarts = 0;
      while (run.next < run.end && !signal.aborted) {
        const live = this.members(run);
        if (!live.length) break;
        const before = run.next;
        const { error, stopped, routes, spec } = await this.attempt(run, live, info);
        if (signal.aborted || this.closed) break;
        if (stopped) {
          if (stopped === 'yield') this.continueRun(run);
          else if (stopped === 'idle' && run.memoryWait) this.continueRun(run, false, { waitMemory: true });
          break;
        }
        if (!error) {
          // The source ended before these chunks: there is no picture for them.
          this.failPending(run, run.next, new PlaybackError('The source has no video at this point.'));
          break;
        }
        // A failure after progress starts again where it stopped, a few times.
        if (run.next > before && error.exitFailure && restarts++ < 3) continue;
        if (!error.exitFailure) {
          this.failChunk(run, error);
          continue;
        }
        if (routes && run.level < routes - 1) {
          run.level++;
          continue;
        }
        if (live.length > 1) {
          this.batchBroken.add(first.group.batchKey);
          this.logger.warn('Conversion', 'Shared conversion failed for a source; converting each quality alone.');
          this.continueRun(run, true);
          break;
        }
        if (error.encoderFailure && run.encoder !== 'software' && this.cpuFallback) {
          run.encoder = 'software';
          run.software = true;
          continue;
        }
        this.failChunk(
          run,
          spec?.doviP5 && !run.software ? new PlaybackError('Dolby Vision Profile 5 tone-mapping failed.') : error,
        );
      }
    } finally {
      releaseConversion?.();
    }
  }
  gathering(run) {
    const key = run.members[0].group.batchKey,
      now = performance.now();
    if (!key || this.batchBroken.has(key)) return false;
    return [...this.groups.values()].some(
      group =>
        group.batchKey === key &&
        group.run !== run &&
        now - (group.viewerDemandAt ?? -Infinity) <= BATCH_DEMAND_MS &&
        group.leases.size,
    );
  }
  // A chunk that failed even on the last step keeps its error briefly, as one chunk.
  failChunk(run, error) {
    const entries = run.pending.get(run.next);
    run.pending.delete(run.next);
    for (const entry of entries?.values() || []) entry.reject(error);
    run.next++;
    // Later chunks a viewer is waiting for start again in a new run.
    this.continueRun(run);
    run.controller.abort(new PlaybackError('WebM preparation cancelled.'));
  }
  failPending(run, from, error) {
    for (const [index, entries] of run.pending) {
      if (index < from) continue;
      for (const entry of entries.values()) entry.reject(error);
      run.pending.delete(index);
    }
  }
  // Continue a run's waiting chunks in a new run: queued for a slot again, or, after a
  // shared failure, one run per quality.
  continueRun(run, split = false, { waitMemory = false } = {}) {
    const live = this.members(run);
    const waiting = live.filter(({ group }) =>
      [...run.pending].some(([index, entries]) => index >= run.next && (split || entries.get(group)?.users)),
    );
    if (!waiting.length) return;
    const index = Math.min(
      ...[...run.pending].filter(([index, entries]) => index >= run.next && entries.size).map(([index]) => index),
    );
    const priority = { urgent: run.priority.urgent, background: run.priority.background };
    if (split)
      for (const member of waiting)
        this.startRun([member], index, priority, { level: member.group.decodeLevel, waitMemory });
    else this.startRun(waiting, index, priority, { level: run.level, encoder: run.encoder, waitMemory });
  }
  // Open the source while the chunk being converted is wanted and fits memory. A run held
  // closed for RUN_IDLE_MS stops, so a paused room keeps no slot or GPU memory.
  flow(run) {
    if (run.done) return;
    // A chunk whose sound still waits for the process's own read keeps the source open.
    const open = run.soundWaits > 0 || (!run.memoryWait && run.next <= run.target);
    if (open === run.gate.open) return;
    run.gate.set(open);
    if (open) {
      clearTimeout(run.idleTimer);
      run.idleTimer = undefined;
      const now = Date.now();
      for (const entry of run.pending.get(run.next)?.values() || []) entry.began = now;
      this.sounds(run, run.next);
      run.current?.stalled();
    } else {
      clearTimeout(run.stallTimer);
      run.idleTimer ||= setTimeout(() => {
        run.idleTimer = undefined;
        run.current?.stop('idle');
      }, this.timing.idle);
    }
  }
  // One FFmpeg process from run.next: video for every member through the segment muxer,
  // and sound as one short process per chunk for each distinct audio choice.
  async attempt(run, live, info) {
    const start = run.next,
      controller = new AbortController(),
      stop = reason => controller.abort(reason),
      abort = () => stop(run.controller.signal.reason);
    run.controller.signal.addEventListener('abort', abort, { once: true });
    const first = live[0],
      codec = first.group.codec,
      encoder = run.encoder,
      signal = controller.signal;
    let routes, lead;
    try {
      return await this.input(
        () => this.runSource(run),
        signal,
        async (url, state) => {
          const spawned = Date.now();
          const outputs = live.map(({ group, source }) => {
            const spec = outputSpec(info, group.quality, this.maxQuality);
            const audio = this.audioChoice(source, info);
            if (spec.audio && !audio.selected)
              throw new PlaybackError('The selected audio track is not present in the source.');
            return { group, source, spec, audio, sound: spec.audio ? audio.map(0) : 'silence' };
          });
          // Decode and tonemap at the largest size; smaller outputs scale from it.
          lead = outputs.reduce((best, output) =>
            output.spec.width * output.spec.height > best.spec.width * best.spec.height ? output : best,
          ).spec;
          const allRoutes = run.software
            ? [lead.doviP5 ? cpuPlaceboRoute(lead) : undefined]
            : decodeRoutes(lead, encoder, this.hardwareDecode);
          if (!allRoutes.length)
            throw new PlaybackError('Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping.');
          routes = allRoutes.length;
          const level = Math.min(run.level, routes - 1),
            route = allRoutes[level];
          const { chosen } = outputs[0].audio;
          const burn = first.source.burn;
          if (burn && !burn.external && burn.index !== undefined)
            chosen.burn = { ...burn, index: fileIndex(first.source.tracks?.subtitles, burn, info.streams, 'subtitle') };
          const span = Math.min((run.end - start) * CHUNK, first.source.duration - start * CHUNK);
          const burned =
            outputs.length === 1 ? await this.burnInput(chosen, url, start * CHUNK, span, signal, info) : undefined;
          // Sound is decoded once from the process's own read. Silence, and a first chunk the
          // copy began too late for, still come from processes of their own.
          const runIn = burned?.runIn || 0,
            lastChunk = Math.ceil(first.source.duration / CHUNK) - 1,
            choices = [...new Map(outputs.filter(o => o.spec.audio).map(o => [o.sound, o])).values()],
            memories = choices.map(() => new SoundMemory(start, lastChunk));
          let head = Buffer.alloc(0);
          const copied = bytes => {
            if (!head) return;
            head = Buffer.concat([head, bytes]);
            const starts = copyStarts(head, choices.length);
            if (!starts && head.length < 4 * 1024 * 1024) return;
            memories.forEach((memory, i) => memory.begin(starts?.get(i + 1)));
            head = undefined;
          };
          const sound = choices.length
            ? {
                maps: choices.map(o => o.sound),
                offset: start * CHUNK - runIn + (Number(info.format?.start_time) || 0),
                length: run.end <= lastChunk ? (run.end - start) * CHUNK + runIn + 1 : undefined,
              }
            : undefined;
          let current;
          try {
            const args = this.runCommand(url, outputs, lead, route, start, run, burned, chosen, encoder, codec, sound);
            run.spawned = true;
            current = run.current = {
              start,
              outputs,
              url,
              stop,
              spawned,
              state,
              delivered: new Map(),
              audio: new Map(),
              pictures: new Map(),
              sounds: new Map(),
              // When each picture and sound arrived, so a slow chunk can say which was late.
              arrived: new Map(),
              memory: new Map(choices.map((o, i) => [o.sound, memories[i]])),
            };
            current.stalled = () => {
              clearTimeout(run.stallTimer);
              if (run.gate.open)
                run.stallTimer = setTimeout(
                  () => stop(new PlaybackError('WebM encoder timed out. Check the server GPU/FFmpeg support.')),
                  this.timing.stall,
                );
            };
            current.stalled();
            current.success = () => {
              if (outputs.some(({ group }) => level > (group.decodeLevel || 0)))
                this.logger.warn(
                  'Conversion',
                  `${allRoutes[level - 1]?.label || 'Hardware decode'} failed for a ${lead.sourceFormat} source; using a slower path for this stream.`,
                );
              for (const { group } of outputs) {
                group.decodeLevel = Math.max(group.decodeLevel || 0, level);
                group.encoder = encoder;
                group.cpuFallback = encoder === 'software' && this.encoder !== 'software';
              }
              current.success = undefined;
            };
            this.begin(run, start);
            await this.segments(this.ffmpeg, args, signal, {
              onSegment: (output, n, bytes) => this.deliver(run, current, output, n, bytes),
              ended: () => !state?.upstreamFailed,
              memoryLimit: (burned?.bitmap ? 3 : 2 + 0.5 * (outputs.length - 1)) * 1024 * 1024 * 1024,
              failOn: route?.failOn,
              sound: choices.length
                ? {
                    commands: choices.map((o, i) =>
                      soundDecodeCommand(i, start * CHUNK - AUDIO_LEAD, o.audio.selected),
                    ),
                    onCopy: copied,
                    onData: (i, bytes) => memories[i].add(bytes),
                    onEnd: (i, ok) => ok || memories[i].end(false),
                  }
                : undefined,
            });
            for (const memory of memories) memory.end(true);
            return {};
          } finally {
            for (const memory of memories) memory.end(false);
            clearTimeout(run.stallTimer);
            run.current = undefined;
            // A chunk whose picture this process made keeps its sound, which may still be
            // encoding or reading the source: the run settles only after it.
            const unfinished = [...(current?.audio || [])].filter(([k]) => k < run.next);
            await Promise.allSettled(unfinished.flatMap(([, byChoice]) => [...byChoice.values()]));
            await burned?.cleanup?.();
          }
        },
        run.gate,
      );
    } catch (error) {
      if (typeof signal.reason === 'string') return { stopped: signal.reason };
      return { error, routes, spec: lead };
    } finally {
      run.controller.signal.removeEventListener('abort', abort);
    }
  }
  runCommand(url, outputs, lead, route, start, run, burn, chosen, encoder, codec, sound) {
    const count = outputs.length,
      runIn = burn?.runIn || 0,
      // Burned subtitles overlay in system memory; otherwise a route may keep its frames on the GPU.
      gpu = !burn && route?.gpuFrames,
      filter = (burn && route?.burnFilter) || route?.filter || lead.filter;
    let graph;
    if (burn?.bitmap)
      graph = [
        '-filter_complex',
        `[0:v:0]${filter.replace('setpts=PTS-STARTPTS,', '')}[picture];[0:${chosen.burn.index}]scale=${lead.width}:-2[subtitle];[picture][subtitle]overlay=(W-w)/2:(H-h)/2:shortest=1,format=nv12,trim=start=${runIn},setpts=PTS-STARTPTS[v0]`,
      ];
    else if (burn?.file)
      graph = [
        '-filter_complex',
        `[0:v:0]${filter},setpts=PTS+${burn.offset}/TB,subtitles=filename='${filterPath(burn.file)}',setpts=PTS-STARTPTS,format=nv12[v0]`,
      ];
    else {
      const split = outputs.map((_, i) => `[s${i}]`).join('');
      const scaled = outputs.map(({ spec }, i) =>
        spec.width === lead.width && spec.height === lead.height
          ? `[s${i}]null[v${i}]`
          : gpu
            ? `[s${i}]${route.scale(spec.width, spec.height)}[v${i}]`
            : `[s${i}]scale=${spec.width}:${spec.height},format=nv12[v${i}]`,
      );
      graph = ['-filter_complex', `[0:v:0]${filter}[base];[base]split=${count}${split};${scaled.join(';')}`];
    }
    // A bounded run stops at its last chunk; otherwise the source's end does.
    const bounded = run.end < Math.ceil(outputs[0].source.duration / CHUNK);
    return [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-threads',
      String(route ? 2 : this.cpuShare()),
      ...(route?.input || []),
      '-ss',
      String(start * CHUNK - runIn),
      '-i',
      url,
      '-filter_threads',
      String(count > 1 ? 4 : 2),
      ...graph,
      ...outputs.flatMap(({ spec }, i) => [
        '-map',
        `[v${i}]`,
        ...(bounded ? ['-t', String((run.end - start) * CHUNK)] : []),
        '-an',
        '-sn',
        '-dn',
        '-map_metadata',
        '-1',
        '-map_chapters',
        '-1',
        // GPU frames carry their own format; -pix_fmt would ask FFmpeg to convert them.
        ...encoderArgs(encoder, codec, Math.max(1, Math.floor(this.cpuShare() / count))).filter(
          (arg, j, all) => !gpu || (arg !== '-pix_fmt' && all[j - 1] !== '-pix_fmt'),
        ),
        ...rateArgs(encoder, codec, spec.bitrate),
        ...(spec.frameRate ? ['-r', spec.frameRate, '-fps_mode', 'cfr'] : []),
        '-g',
        '180',
        // A keyframe opens every chunk, and the segment muxer cuts there.
        '-force_key_frames',
        `expr:gte(t,n_forced*${CHUNK})`,
        '-color_primaries',
        'bt709',
        '-color_trc',
        'bt709',
        '-colorspace',
        'bt709',
        '-f',
        'segment',
        '-segment_time',
        String(CHUNK),
        '-segment_format',
        'webm',
        '-segment_format_options',
        'cluster_time_limit=1000',
        '-segment_list',
        'segment-list:' + i,
        '-segment_list_type',
        'flat',
        '-segment_list_flags',
        '+live',
        '-reset_timestamps',
        '1',
        'segments:' + i,
      ]),
      ...(sound ? soundCopyArgs(sound.maps, sound.offset, sound.length) : []),
    ];
  }
  // The run reaches chunk k: under contention it yields its slot here; otherwise it sets
  // aside memory for every member's chunk, starts its sound and opens or holds the source.
  begin(run, k) {
    const current = run.current;
    if (!current || k >= run.end) return;
    for (const memory of current.memory.values()) memory.advance(k);
    // Waiting work is another conversion for a slot here, or anything waiting for a job of
    // the conversion limit shared with the media server.
    if (
      k > current.start &&
      (this.queue.some(waiter => !waiter.priority.background || run.priority.background) ||
        this.conversionPolicy?.waiters?.length)
    )
      return current.stop('yield');
    const now = Date.now(),
      wanted = [];
    for (const output of current.outputs) {
      if (output.group.run !== run || this.groups.get(output.group.key) !== output.group) continue;
      let entry = output.group.chunks.get(k);
      if (entry?.bytes) continue;
      if (entry && (entry.run !== run || entry.controller.signal.aborted)) {
        if (!entry.controller.signal.aborted) continue;
        output.group.chunks.delete(k);
        entry = undefined;
      }
      entry ||= this.runEntry(run, output.group, k);
      entry.began = now;
      entry.shared = current.outputs.length > 1 ? current.outputs.length : undefined;
      wanted.push({ output, entry });
    }
    const reserve = () => {
      // A chunk carried over from a replaced process keeps its reservation.
      const sizes = wanted.map(({ output, entry }) => (entry.reservedBytes ? 0 : this.chunkBytes(output.group))),
        total = sizes.reduce((sum, bytes) => sum + bytes, 0);
      this.pruneAll(total, undefined, true);
      if (this.retainedBytes + this.pendingBytes + total > this.maxBytes) return false;
      wanted.forEach(({ entry }, i) => {
        if (!sizes[i]) return;
        this.pendingBytes += sizes[i];
        entry.reservedBytes = sizes[i];
      });
      return true;
    };
    if (run.checkMemory) {
      this.memoryWaiters.delete(run.checkMemory);
      run.checkMemory = undefined;
    }
    run.memoryWait = !reserve();
    // Memory frees as viewers read and old chunks are pruned; until then the source waits.
    if (run.memoryWait) {
      run.checkMemory = () => {
        if (run.done || !run.current) return true;
        if (!reserve()) return false;
        run.memoryWait = false;
        run.checkMemory = undefined;
        this.sounds(run, k);
        this.flow(run);
        return true;
      };
      this.memoryWaiters.add(run.checkMemory);
    }
    // Sound starts when the run goes ahead with this chunk; a run held here (a paused room)
    // may stop before then, and its sound would be converted again by the next run.
    if (!run.memoryWait && k <= run.target) this.sounds(run, k);
    this.flow(run);
  }
  sounds(run, k) {
    const current = run.current;
    if (!current) return;
    for (const output of current.outputs)
      if (run.pending.get(k)?.has(output.group)) this.sound(run, current, output, k);
  }
  // One sound encode per chunk and audio choice, shared by members that chose the same: from
  // the run's decoded sound, or, for the process's first chunk, silence, or sound the
  // process can no longer supply, its own short process reading the source.
  sound(run, current, output, k) {
    if (!current.audio.has(k)) current.audio.set(k, new Map());
    const byChoice = current.audio.get(k);
    if (!byChoice.has(output.sound)) {
      const start = k * CHUNK,
        duration = Math.min(CHUNK, output.source.duration - start);
      // Its own source request, outside the run's gate, so a held run cannot starve it.
      const asked = Date.now();
      const read = () =>
        this.input(
          () => this.runSource(run),
          run.controller.signal,
          (url, state) =>
            this.run(
              this.ffmpeg,
              audioCommand(url, output.spec, output.audio.map, start, duration, output.audio.selected),
              run.controller.signal,
              30000,
              4 * 1024 * 1024,
              undefined,
              { stream: true },
            ).then(audio => {
              if (k === current.start) current.firstSound = { seconds: (Date.now() - asked) / 1000, ...state };
              return audio;
            }),
        );
      const memory = current.memory.get(output.sound);
      const job = memory
        ? this.decoded(run, memory, k, duration).then(audio => {
            if (!audio) return read();
            if (k === current.start) current.firstSound = { seconds: (Date.now() - asked) / 1000 };
            return audio;
          })
        : read();
      job.catch(() => {});
      byChoice.set(output.sound, job);
    }
    byChoice
      .get(output.sound)
      .then(
        audio => {
          if (!run.pending.has(k)) return;
          current.sounds.set(`${k}:${output.sound}`, audio);
          current.arrived.set(`${k}:sound:${output.sound}`, Date.now());
          this.complete(run, current, k, output);
        },
        error => {
          const entry = run.pending.get(k)?.get(output.group);
          if (!entry || run.controller.signal.aborted) return;
          run.pending.get(k).delete(output.group);
          entry.reject(error);
        },
      )
      .catch(() => {});
  }
  // A chunk's Opus from the run's decoded sound, or undefined when the copy began too late
  // for it or the process ended before its window arrived. While it waits, the source stays
  // open so the samples can come.
  async decoded(run, memory, k, duration) {
    run.soundWaits = (run.soundWaits || 0) + 1;
    this.flow(run);
    let samples;
    try {
      if (await memory.covers(k)) samples = await memory.wait(k, duration);
    } finally {
      run.soundWaits--;
      this.flow(run);
    }
    if (!samples) return undefined;
    return this.run(this.ffmpeg, encodeCommand(), run.controller.signal, 30000, 4 * 1024 * 1024, undefined, {
      input: samples,
      stream: true,
    });
  }
  async deliver(run, current, output, n, video) {
    const k = current.start + n,
      member = current.outputs[output];
    current.success?.();
    current.stalled();
    // Only a chunk someone is waiting for is kept, so a long run holds no bytes of its own.
    if (run.pending.get(k)?.has(member.group)) {
      current.pictures.set(`${k}:${output}`, video);
      current.arrived.set(`${k}:video:${output}`, Date.now());
    }
    this.complete(run, current, k, member);
    const delivered = (current.delivered.get(k) || 0) + 1;
    current.delivered.set(k, delivered);
    if (delivered < current.outputs.length) return;
    current.delivered.delete(k);
    if (!run.pending.has(k)) this.forget(current, k);
    run.next = Math.max(run.next, k + 1);
    this.begin(run, k + 1);
  }
  // Picture and sound are kept by the process, not the request, so a request that replaced
  // a cancelled one still gets both.
  complete(run, current, k, output) {
    const entry = run.pending.get(k)?.get(output.group),
      video = current.pictures.get(`${k}:${current.outputs.indexOf(output)}`),
      audio = current.sounds.get(`${k}:${output.sound}`);
    if (!entry || !video || !audio) return;
    entry.videoAt = current.arrived.get(`${k}:video:${current.outputs.indexOf(output)}`);
    entry.soundAt = current.arrived.get(`${k}:sound:${output.sound}`);
    run.pending.get(k).delete(output.group);
    if (!run.pending.get(k).size) run.pending.delete(k);
    // Every member that wants this chunk has it once none is pending, so the process forgets it.
    if (!run.pending.has(k) && current.delivered.get(k) === undefined) this.forget(current, k);
    entry.resolve({ video, audio });
    if (k === current.start && !current.reported) {
      current.reported = true;
      this.logStart(current, k, entry);
    }
  }
  // How long a process took to its first chunk, and where: seeks, joins and resumes all
  // pay it, and the provider's responses, the probe and the sound show which part was slow.
  logStart(current, k, entry) {
    const now = Date.now(),
      group = current.outputs[0].group,
      probed = group.probed,
      sound = current.firstSound;
    group.probed = undefined;
    const requests = state =>
      `${state.requests || 0} source request${state.requests === 1 ? '' : 's'}, slowest ${(state.slowest || 0).toFixed(2)}s`;
    this.logger.info(
      'Conversion',
      `Chunk ${k} of ${current.outputs.map(output => output.group.quality).join(', ')} ready ${seconds(now - entry.queued)} after it was asked for: ` +
        `process ${seconds(now - current.spawned)} (${requests(current.state)})` +
        (sound ? `, sound ${sound.seconds.toFixed(1)}s (${requests(sound)})` : '') +
        (probed ? `, probe ${probed.seconds.toFixed(1)}s (${requests(probed)})` : '') +
        '.',
    );
  }
  forget(current, k) {
    for (const key of [...current.pictures.keys(), ...current.sounds.keys(), ...current.arrived.keys()])
      if (key.startsWith(k + ':')) {
        current.pictures.delete(key);
        current.sounds.delete(key);
        current.arrived.delete(key);
      }
    current.audio.delete(k);
  }
  async sourceInfo(group, source, signal) {
    if (group.info) return group.info;
    if (this.mediaFacts && source?.sourceKey) {
      const facts = await this.mediaFacts.inspect(source, { signal });
      group.probed ||= facts.probeStats;
      group.info = facts.frameGridInfo;
      return group.info;
    }
    if (!group.infoTask || group.infoTask.signal.aborted) {
      const task = new SharedTask(signal =>
        this.input(source, signal, async (url, state) => {
          const asked = Date.now();
          const raw = await this.run(
            this.ffprobe,
            [
              '-v',
              'error',
              '-show_entries',
              'stream=index,codec_type,codec_name,sample_rate,width,height,pix_fmt,color_space,color_primaries,color_transfer,r_frame_rate,avg_frame_rate:stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:format=bit_rate,start_time:packet=stream_index,pts_time,flags',
              // Half a second of packets, which the stream analysis has mostly read already.
              '-read_intervals',
              '%+0.5',
              '-of',
              'json',
              url,
            ],
            signal,
          );
          group.probed = { seconds: (Date.now() - asked) / 1000, ...state };
          return frameGrids(JSON.parse(raw.toString()));
        }),
      );
      group.infoTask = task;
      task.promise.catch(() => {
        if (group.infoTask === task) group.infoTask = undefined;
      });
    }
    group.info = await group.infoTask.join(signal);
    return group.info;
  }
  // The audio track a source selects, by its index in this file.
  audioChoice(source, info) {
    const audioStreams = info.streams.filter(s => s.codec_type === 'audio');
    const chosen = { ...source };
    if (source.audioTrack && source.audioIndex !== undefined)
      chosen.audioIndex = fileIndex(source.tracks?.audio, source.audioTrack, info.streams, 'audio');
    const selected =
      chosen.audioIndex !== undefined
        ? audioStreams.find(s => s.index === chosen.audioIndex)
        : audioStreams[chosen.audioOrdinal ?? 0];
    const map = input =>
      chosen.audioIndex !== undefined ? input + ':' + chosen.audioIndex : input + ':a:' + (chosen.audioOrdinal ?? 0);
    return { chosen, selected, map };
  }
  // A chunk settles once: cached on success, briefly remembered on failure.
  track(group, index, entry, work) {
    const controller = entry.controller;
    entry.promise = work
      .then(bytes => {
        if (controller.signal.aborted || group.chunks.get(index) !== entry)
          throw new PlaybackError('WebM preparation cancelled.');
        if (entry.reservedBytes) {
          this.pendingBytes -= entry.reservedBytes;
          entry.reservedBytes = 0;
          this.wakeMemoryWaiters();
        }
        entry.bytes = bytes;
        entry.size = bytes.video.length + bytes.audio.length;
        group.bytes += entry.size;
        this.prune(group, entry);
        // A chunk slower than real time means viewers will catch up and wait.
        const took = (Date.now() - entry.began) / 1000,
          // Only time before the run had a slot: a look-ahead chunk asked for early waits for
          // the player to need it, which is not a shortage of slots.
          waited = Math.max(0, Math.min(entry.began, entry.run?.slotAt ?? entry.began) - entry.queued) / 1000;
        // Picture and sound come from different processes; say which one was late.
        const parts = [
          ['video', entry.videoAt],
          ['sound', entry.soundAt],
        ]
          .filter(([, at]) => at)
          .map(([name, at]) => `${name} ${Math.max(0, (at - entry.began) / 1000).toFixed(1)}s`);
        if (took > CHUNK * 0.8 || waited > CHUNK)
          this.logger.warn(
            'Conversion',
            `Chunk ${index} of ${group.quality} took ${took.toFixed(1)}s to encode${parts.length ? ` (${parts.join(', ')})` : ''} and waited ${waited.toFixed(1)}s for a slot (${group.encoder || 'auto'}${group.cpuFallback ? ', software fallback' : ''}${entry.shared ? `, shared by ${entry.shared} qualities` : ''}); viewers may wait.`,
          );
        return bytes;
      })
      .catch(error => {
        if (controller.signal.aborted) {
          if (group.chunks.get(index) === entry) group.chunks.delete(index);
        } else {
          // Keep failure local to this chunk and cool down before re-encoding.
          entry.error = error instanceof PlaybackError ? error : new PlaybackError('WebM chunk preparation failed.');
          this.logger.warn('Conversion', `Chunk ${index} failed: ${entry.error.message}`);
          entry.failedAt = performance.now();
          this.prune(group, entry);
        }
        throw entry.error || error;
      })
      .finally(() => {
        if (entry.reservedBytes) {
          this.pendingBytes -= entry.reservedBytes;
          entry.reservedBytes = 0;
          this.wakeMemoryWaiters();
        }
        group.controllers.delete(controller);
        this.controllers.delete(controller);
      });
    // Caller disconnects can stop waiting without leaving an unhandled rejection.
    entry.promise.catch(() => {});
    group.chunks.set(index, entry);
  }
  // A starting chunk's share of the CPU for CPU decoding and CPU encoders: the machine split
  // among the conversions running now, at least two threads. GPU routes keep two.
  cpuShare() {
    return Math.max(2, Math.floor(os.availableParallelism() / Math.max(1, this.active)));
  }
  // Converted Original takes the highest configured quality's size limit, and the source's
  // bitrate up to that quality's. From a source at least that bitrate it is exactly that
  // quality, so both share one output.
  outputQuality(source, quality) {
    const id = qualityId(quality),
      top = this.maxQuality;
    return id === 'direct' && top?.bitrate && source.sourceBitrate >= top.bitrate ? top.id : id;
  }
  // Memory set aside for one chunk before it is encoded. With -maxrate at the bitrate and a
  // buffer of twice that, a chunk holds at most its length plus two seconds of bitrate; a
  // quarter more covers the container and sound. A flat 48 MB worst case per quality let a
  // shared chunk of five qualities fill the whole cache.
  chunkBytes(group) {
    const kbps = (group.quality === 'direct' ? this.maxQuality : resolveQuality(group.quality))?.bitrate;
    if (!kbps) return this.jobBytes;
    return Math.min(this.jobBytes, Math.ceil(((kbps + 128) * 1000 * (CHUNK + 2) * 1.25) / 8));
  }
  get retainedBytes() {
    return [...this.groups.values()].reduce((sum, group) => sum + group.bytes, 0);
  }
  // A run setting memory aside for look-ahead never evicts a chunk a viewer has yet to
  // fetch ahead of its playhead; it waits instead.
  pruneAll(reserve = 0, keep, lookAhead = false) {
    const candidates = [...this.groups.values()]
      .flatMap(group => [...group.chunks].map(([index, entry]) => ({ group, index, entry })))
      .filter(
        ({ group, index, entry }) =>
          entry !== keep &&
          !entry.users &&
          (entry.bytes || entry.error) &&
          !(lookAhead && entry.bytes && !entry.fetched && index >= (group.lastIndex ?? Infinity)),
      )
      .sort(
        (a, b) =>
          Number(b.entry.priority?.background) - Number(a.entry.priority?.background) || a.entry.at - b.entry.at,
      );
    for (const { group, index, entry } of candidates) {
      if (this.retainedBytes + this.pendingBytes + reserve <= this.maxBytes) break;
      group.chunks.delete(index);
      group.bytes -= entry.size || 0;
    }
  }
  prune(group, keep) {
    this.pruneAll(0, keep);
    for (const [index, entry] of [...group.chunks].sort((a, b) => a[1].at - b[1].at)) {
      if (group.chunks.size <= 12 && group.bytes <= 128 * 1024 * 1024) break;
      if (entry !== keep && (entry.bytes || entry.error) && !entry.users) {
        group.chunks.delete(index);
        group.bytes -= entry.size || 0;
      }
    }
    this.wakeMemoryWaiters();
  }
  close() {
    this.closed = true;
    this.shutdownController?.abort();
    for (const controller of this.controllers) controller.abort();
    for (const group of this.groups.values()) group.infoTask?.abort();
    this.groups.clear();
    this.inputs.clear();
    this.wakeMemoryWaiters();
    this.server?.closeAllConnections();
    this.server?.close();
    return Promise.allSettled([...this.jobs]);
  }
}
module.exports = {
  AV1,
  CHUNK,
  AUDIO_LEAD,
  audioCommand,
  soundDecodeCommand,
  soundCopyArgs,
  frameGrids,
  MIME,
  AUDIO_MIME,
  copyStarts,
  encoderArgs,
  probeEncoder,
  outputSpec,
  decodeRoute,
  decodeRoutes,
  cpuPlaceboRoute,
  rateArgs,
};
