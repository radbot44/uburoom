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
const { run, stream, fileIndex, classifyHdr, cpuTonemap } = require('./media-tools');
const CHUNK = Playback.BUFFER.chunkSeconds;
// Audio starts this early so Opus has settled before the chunk's first sample, and the
// player keeps only the chunk's own window. 312 samples of encoder delay plus ten
// 20 ms frames puts a packet edge exactly on the chunk boundary.
const AUDIO_LEAD_SAMPLES = 9912,
  AUDIO_LEAD = AUDIO_LEAD_SAMPLES / 48000;
const MIME = 'video/webm; codecs="av01.0.12M.08"',
  AUDIO_MIME = 'audio/webm; codecs="opus"';

function encoderArgs(encoder = 'qsv', codec = 'av1') {
  if (!Playback.localFormat(codec)) throw new PlaybackError('Unknown local output codec.');
  if (encoder === 'software') {
    if (codec === 'av1')
      return ['-c:v', 'libsvtav1', '-preset', '10', '-pix_fmt', 'yuv420p', '-flags', '+global_header'];
    return [
      '-c:v',
      codec === 'vp9' ? 'libvpx-vp9' : 'libvpx',
      '-deadline',
      'realtime',
      '-cpu-used',
      codec === 'vp9' ? '6' : '8',
      '-threads',
      '2',
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
    return ['-c:v', 'av1_nvenc', '-preset', 'p4', '-pix_fmt', 'yuv420p', '-bf', '0', '-flags', '+global_header'];
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

function outputSpec(info, quality, maxQuality = QUALITIES[1]) {
  const video = info.streams?.find(s => s.codec_type === 'video');
  if (!video || !(video.width > 0 && video.height > 0))
    throw new PlaybackError('Original source has no readable video.');
  const q = qualityDefinition(quality);
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
    filter: filters.join(','),
    audio: info.streams.some(s => s.codec_type === 'audio'),
  };
}

// Decoding and scaling on the GPU removes the 4K cost. Every route uses FFmpeg's
// own decoder with -hwaccel. Never use wrapper decoders such as hevc_qsv: after a
// seek it mislabels frames, so chunks start up to three frames early.
// HDR tonemaps through libplacebo with peak detection off, the closest GPU match
// to the CPU picture. vpp_qsv crushes shadows, and tonemap_opencl adapts per
// process, so the first frame of every chunk flashes. Each chunk is a new process.
// Sources without a listed surface format stay on the CPU path.
// Burned subtitles need cues that began before the chunk. Bitmap tracks decode a
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
function decodeRoute(spec, encoder, platform = process.platform, gpuTonemap = true) {
  const surface = SURFACES[spec.sourceFormat];
  if (!surface) return;
  if (spec.doviP5 && (!gpuTonemap || platform === 'darwin')) return;
  const size = `${spec.width}:${spec.height}`,
    vpp = `vpp_qsv=w=${spec.width}:h=${spec.height}:format=${surface}`;
  const placebo = spec.hdr && gpuTonemap && platform !== 'darwin';
  const route = (input, gpu, downloaded = true) => ({
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
    if (placebo)
      return route(
        [
          '-init_hw_device',
          device[0],
          '-hwaccel',
          device[1],
          '-hwaccel_device',
          'd',
          '-hwaccel_output_format',
          device[2],
        ],
        [],
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

const { SharedTask, runOperation } = require('./operation');

class AV1 {
  constructor(config = {}, execute = run, logger = silentLogger) {
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
      const job = Promise.resolve().then(() => execute(...args));
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {});
      return job;
    };
    this.stream = (...args) => {
      const job = Promise.resolve().then(() => stream(...args));
      this.jobs.add(job);
      job.finally(() => this.jobs.delete(job)).catch(() => {});
      return job;
    };
    this.ffprobe =
      config.ffprobePath ||
      (this.ffmpeg && path.join(path.dirname(this.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'));
    this.groups = new Map();
    this.inputs = new Map();
    this.controllers = new Set();
    this.queue = [];
    this.active = 0;
    this.closed = false;
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
  acquire(source, quality, existingOnly = false, codec = 'av1', { background = false } = {}) {
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
          qualityId(quality),
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
      };
      this.groups.set(key, group);
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
    group.infoTask?.abort();
    for (const controller of group.controllers) controller.abort();
    group.chunks.clear();
    group.bytes = 0;
  }
  bridge() {
    return runOperation(undefined, () => this.openBridge());
  }
  async openBridge() {
    if (this.bridgePromise) return this.bridgePromise;
    this.bridgePromise = (async () => {
      const server = (this.server = http.createServer(async (req, res) => {
        const entry = this.inputs.get(req.url);
        if (!entry || entry.signal.aborted || !['GET', 'HEAD'].includes(req.method)) {
          res.writeHead(403);
          return res.end();
        }
        const abort = new AbortController(),
          cancel = () => abort.abort();
        res.on('close', cancel);
        entry.signal.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(cancel, 30000);
        try {
          const response = await entry.source.provider.request(entry.source.start, {
            method: req.method,
            signal: abort.signal,
            streaming: true,
            headers: { Accept: '*/*', ...(req.headers.range ? { Range: req.headers.range } : {}) },
          });
          clearTimeout(timer);
          if (entry.source.subtitleWindow && req.headers.range) {
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
          else await pipeline(Readable.fromWeb(response.body), res);
        } catch {
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
  async input(source, signal, action) {
    const port = await this.bridge(),
      key = '/' + randomBytes(24).toString('hex');
    // A short-lived loopback capability is visible in the process arguments;
    // the provider's URL and credential are never passed to FFmpeg or FFprobe.
    this.inputs.set(key, { source, signal });
    try {
      return await action(`http://127.0.0.1:${port}${key}`);
    } finally {
      this.inputs.delete(key);
    }
  }
  // Prepare what one chunk needs to burn the selected subtitle. Each process sees
  // only its own window, so cue timing comes from the same source position.
  async burnInput(source, url, start, duration, signal) {
    const track = source.burn;
    if (!track) return;
    if (bitmapSubtitle(track)) {
      if (track.external) throw new PlaybackError('External image subtitles cannot be burned by local conversion.');
      return { bitmap: true, runIn: Math.min(BITMAP_RUN_IN, start) };
    }
    let data;
    if (track.external) {
      const response = await source.provider.request(track.resources.data, { signal, headers: { Accept: '*/*' } });
      if (!response.ok) throw new PlaybackError('The subtitle file is unavailable.');
      data = Buffer.from(await response.arrayBuffer());
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
          String(Math.max(0, start - TEXT_RUN_IN)),
          '-copyts',
          '-i',
          url,
          '-to',
          String(start + duration),
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
    return { file, offset: start, cleanup: () => fs.rm(directory, { recursive: true, force: true }) };
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
    if (!background) group.viewerDemandAt = performance.now();
    if (!Number.isSafeInteger(index) || index < 0 || start >= source.duration)
      throw new PlaybackError('Invalid WebM chunk.');
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
    if (!entry) {
      const controller = new AbortController();
      group.controllers.add(controller);
      this.controllers.add(controller);
      // A seek can make an already queued prefetch imminent; joining raises it.
      entry = { users: 0, at: Date.now(), queued: Date.now(), controller, priority: { urgent, background } };
      entry.promise = runOperation(controller.signal, () =>
        this.slot(
          controller.signal,
          async () => {
            this.pruneAll(this.jobBytes);
            if (this.retainedBytes + this.pendingBytes + this.jobBytes > this.maxBytes)
              throw new PlaybackError('Encoded video memory is busy; retry shortly.');
            this.pendingBytes += this.jobBytes;
            entry.reserved = true;
            await this.conversionPolicy?.video('uburoom', group.codec, source.provider);
            const releaseConversion = await this.conversionPolicy?.wait({
              signal: controller.signal,
              background: entry.priority.background,
            });
            entry.began = Date.now();
            try {
              const codec = group.codec;
              const encoder = group.encoder || (await this.selectEncoder(codec));
              if (!group.info) {
                if (!group.infoTask || group.infoTask.signal.aborted) {
                  const task = new SharedTask(signal =>
                    this.input(source, signal, async url => {
                      const raw = await this.run(
                        this.ffprobe,
                        [
                          '-v',
                          'error',
                          '-show_entries',
                          'stream=index,codec_type,codec_name,width,height,pix_fmt,color_space,color_primaries,color_transfer,r_frame_rate,avg_frame_rate:stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:format=bit_rate',
                          '-of',
                          'json',
                          url,
                        ],
                        signal,
                      );
                      return JSON.parse(raw.toString());
                    }),
                  );
                  group.infoTask = task;
                  task.promise.catch(() => {
                    if (group.infoTask === task) group.infoTask = undefined;
                  });
                }
                group.info = await group.infoTask.join(controller.signal);
              }
              return await this.input(source, controller.signal, async url => {
                const spec = outputSpec(group.info, group.quality, this.maxQuality);
                const audioStreams = group.info.streams.filter(s => s.codec_type === 'audio');
                const chosen = { ...source };
                if (source.audioTrack && source.audioIndex !== undefined)
                  chosen.audioIndex = fileIndex(source.tracks?.audio, source.audioTrack, group.info.streams, 'audio');
                if (source.burn && !source.burn.external && source.burn.index !== undefined)
                  chosen.burn = {
                    ...source.burn,
                    index: fileIndex(source.tracks?.subtitles, source.burn, group.info.streams, 'subtitle'),
                  };
                const selectedAudio =
                  chosen.audioIndex !== undefined
                    ? audioStreams.find(s => s.index === chosen.audioIndex)
                    : audioStreams[chosen.audioOrdinal ?? 0];
                if (spec.audio && !selectedAudio)
                  throw new PlaybackError('The selected audio track is not present in the source.');
                const audioMap = input =>
                  chosen.audioIndex !== undefined
                    ? input + ':' + chosen.audioIndex
                    : input + ':a:' + (chosen.audioOrdinal ?? 0);
                const duration = String(Math.min(CHUNK, source.duration - start));
                const burn = await this.burnInput(chosen, url, start, Number(duration), controller.signal);
                const runIn = burn?.runIn || 0;
                const video = route => {
                  const filter = route?.filter || spec.filter;
                  if (burn?.bitmap)
                    return [
                      '-filter_complex',
                      `[0:v:0]${filter.replace('setpts=PTS-STARTPTS,', '')}[picture];[0:${chosen.burn.index}]scale=${spec.width}:${spec.height}[subtitle];[picture][subtitle]overlay,format=nv12,trim=start=${runIn},setpts=PTS-STARTPTS[video]`,
                      '-map',
                      '[video]',
                      '-an',
                    ];
                  const text = burn?.file
                    ? `,setpts=PTS+${burn.offset}/TB,subtitles=filename='${filterPath(burn.file)}',setpts=PTS-STARTPTS,format=nv12`
                    : '';
                  return ['-map', '0:v:0', '-an', '-filter_threads', '2', '-vf', filter + text];
                };
                const silence = spec.audio ? [] : ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'];
                const audioInput = ['-ss', String(Math.max(0, start - AUDIO_LEAD)), '-i', url];
                // The first chunk has nothing before it, so silence takes the lead's place.
                const audio = input => [
                  '-t',
                  String(Number(duration) + AUDIO_LEAD + 0.04),
                  '-map',
                  spec.audio ? audioMap(input) : '1:a:0',
                  '-vn',
                  '-sn',
                  '-dn',
                  '-map_metadata',
                  '-1',
                  '-c:a',
                  'libopus',
                  '-b:a',
                  '128k',
                  '-ac',
                  '2',
                  '-ar',
                  '48000',
                  '-af',
                  'asetpts=PTS-STARTPTS' + (start ? '' : `,aresample=48000,adelay=${AUDIO_LEAD_SAMPLES}S:all=1`),
                  '-f',
                  'webm',
                  '-live',
                  '1',
                  '-cluster_time_limit',
                  '1000',
                ];
                const command = (selected, route) => [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-nostdin',
                  '-threads',
                  '2',
                  ...(route?.input || []),
                  '-ss',
                  String(start - runIn),
                  '-i',
                  url,
                  ...(burn?.bitmap ? [] : spec.audio ? audioInput : silence),
                  '-t',
                  duration,
                  ...video(route),
                  '-sn',
                  '-dn',
                  '-map_metadata',
                  '-1',
                  '-map_chapters',
                  '-1',
                  ...encoderArgs(selected, codec),
                  ...rateArgs(selected, codec, spec.bitrate),
                  ...(spec.frameRate ? ['-r', spec.frameRate, '-fps_mode', 'cfr'] : []),
                  '-g',
                  '180',
                  '-color_primaries',
                  'bt709',
                  '-color_trc',
                  'bt709',
                  '-colorspace',
                  'bt709',
                  '-f',
                  'webm',
                  '-live',
                  '1',
                  '-cluster_time_limit',
                  '1000',
                  'pipe:1',
                  ...(burn?.bitmap ? [] : [...audio(1), 'pipe:3']),
                ];
                // 4K jobs commit about 1 GiB on either path, GPU surfaces add to that, and the
                // run-in for image subtitles adds about the same again.
                const encode = async (selected, route) => {
                  const job = args =>
                    this.run(this.ffmpeg, args, controller.signal, 30000, 48 * 1024 * 1024, undefined, {
                      memoryLimit: (burn?.bitmap ? 3 : 2) * 1024 * 1024 * 1024,
                    });
                  if (!burn?.bitmap) return job(command(selected, route));
                  // Audio in the same process as an image overlay runs about ten times slower.
                  const [video, sound] = await Promise.all([
                    job(command(selected, route)),
                    job([
                      '-hide_banner',
                      '-loglevel',
                      'error',
                      '-nostdin',
                      ...audioInput,
                      ...silence,
                      ...audio(0),
                      'pipe:1',
                    ]),
                  ]);
                  return { video, audio: sound };
                };
                const routes = spec.doviP5
                  ? [...(this.hardwareDecode ? [decodeRoute(spec, encoder)] : []), cpuPlaceboRoute(spec)].filter(
                      (route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i,
                    )
                  : [
                      ...(this.hardwareDecode
                        ? [decodeRoute(spec, encoder), decodeRoute(spec, encoder, undefined, false)].filter(
                            (route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i,
                          )
                        : []),
                      undefined,
                    ];
                if (!routes.length)
                  throw new PlaybackError('Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping.');
                try {
                  let level = Math.min(group.decodeLevel || 0, routes.length - 1),
                    bytes;
                  for (;;) {
                    try {
                      bytes = await encode(encoder, routes[level]);
                      break;
                    } catch (error) {
                      // Step down from GPU tonemapping, to GPU decode, to the CPU. Only a later
                      // success proves the step, so upstream failures change nothing for the group.
                      if (level === routes.length - 1) {
                        if (spec.doviP5 && error.exitFailure && !controller.signal.aborted)
                          throw new PlaybackError('Dolby Vision Profile 5 tone-mapping failed.');
                        throw error;
                      }
                      if (!error.exitFailure || controller.signal.aborted) throw error;
                      level++;
                    }
                  }
                  if (level > (group.decodeLevel || 0)) {
                    group.decodeLevel = level;
                    this.logger.warn(
                      'Conversion',
                      `${routes[level] ? 'GPU tonemapping' : 'Hardware decode'} failed for a ${spec.sourceFormat} source; using a slower path for this stream.`,
                    );
                  }
                  group.encoder = encoder;
                  group.cpuFallback = encoder === 'software' && this.encoder !== 'software';
                  return bytes;
                } catch (error) {
                  // Retry only an encoder process failure, under the same job lease.
                  // Cancellation, limits and upstream failures never trigger CPU work.
                  if (!error.encoderFailure || encoder === 'software' || !this.cpuFallback || controller.signal.aborted)
                    throw error;
                  const bytes = await encode('software', spec.doviP5 ? cpuPlaceboRoute(spec) : undefined);
                  group.encoder = 'software';
                  group.cpuFallback = true;
                  return bytes;
                } finally {
                  await burn?.cleanup?.();
                }
              });
            } finally {
              releaseConversion?.();
            }
          },
          group.key,
          entry.priority,
        ),
      )
        .then(bytes => {
          if (controller.signal.aborted || group.chunks.get(index) !== entry)
            throw new PlaybackError('WebM preparation cancelled.');
          if (entry.reserved) {
            this.pendingBytes -= this.jobBytes;
            entry.reserved = false;
          }
          entry.bytes = bytes;
          entry.size = bytes.video.length + bytes.audio.length;
          group.bytes += entry.size;
          this.prune(group, entry);
          // A chunk slower than real time means viewers will catch up and wait.
          const took = (Date.now() - entry.began) / 1000,
            waited = (entry.began - entry.queued) / 1000;
          if (took > CHUNK * 0.8 || waited > CHUNK)
            this.logger.warn(
              'Conversion',
              `Chunk ${index} of ${group.quality} took ${took.toFixed(1)}s to encode and waited ${waited.toFixed(1)}s for a slot (${group.encoder || 'auto'}${group.cpuFallback ? ', software fallback' : ''}); viewers may wait.`,
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
          if (entry.reserved) {
            this.pendingBytes -= this.jobBytes;
            entry.reserved = false;
          }
          group.controllers.delete(controller);
          this.controllers.delete(controller);
        });
      // Caller disconnects can stop waiting without leaving an unhandled rejection.
      entry.promise.catch(() => {});
      group.chunks.set(index, entry);
    }
    entry.at = Date.now();
    entry.users++;
    if (urgent) entry.priority.urgent = true;
    if (!background) entry.priority.background = false;
    try {
      return await new Promise((resolve, reject) => {
        const cancel = () => reject(new PlaybackError('WebM client disconnected.'));
        if (signal.aborted) return cancel();
        signal.addEventListener('abort', cancel, { once: true });
        entry.promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
      });
    } finally {
      if (--entry.users === 0 && !entry.bytes) entry.controller.abort();
    }
  }
  get retainedBytes() {
    return [...this.groups.values()].reduce((sum, group) => sum + group.bytes, 0);
  }
  pruneAll(reserve = 0, keep) {
    const candidates = [...this.groups.values()]
      .flatMap(group => [...group.chunks].map(([index, entry]) => ({ group, index, entry })))
      .filter(({ entry }) => entry !== keep && !entry.users && (entry.bytes || entry.error))
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
  }
  close() {
    this.closed = true;
    this.shutdownController?.abort();
    for (const controller of this.controllers) controller.abort();
    for (const group of this.groups.values()) group.infoTask?.abort();
    this.groups.clear();
    this.inputs.clear();
    this.server?.closeAllConnections();
    this.server?.close();
    return Promise.allSettled([...this.jobs]);
  }
}
module.exports = {
  AV1,
  CHUNK,
  AUDIO_LEAD,
  MIME,
  AUDIO_MIME,
  encoderArgs,
  probeEncoder,
  outputSpec,
  decodeRoute,
  cpuPlaceboRoute,
  rateArgs,
};
