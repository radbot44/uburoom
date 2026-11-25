'use strict';
const Subtitles = require('./subtitles');
const { CacheBudget } = require('./cache-budget');
const { SharedTask, currentSignal, runOperation } = require('./operation');
const { scopeKey, pickLiveSource } = require('./media-facts');
// Original subtitle assets only. Rendering stays in the browser; extraction never
// re-encodes video or receives a provider credential in process arguments.
const fs = require('node:fs/promises'),
  os = require('node:os'),
  path = require('node:path');
const { PlaybackError } = require('./errors');
const { fileIndex } = require('./media-tools');
const { StringDecoder } = require('node:string_decoder');

const LIMIT = 64 * 1024 * 1024,
  FONTS = 16 * 1024 * 1024,
  TOTAL = 96 * 1024 * 1024,
  CUES_BUDGET = 8 * 1024 * 1024,
  MAX_CUES_TRACKS = 32,
  MAX_FULL_TRACKS = 8,
  MAX_TRACK_WINDOWS = 16,
  MAX_TRACK_WINDOW_BYTES = 16 * 1024 * 1024,
  MAX_TOTAL_WINDOWS = 128,
  QUANTUM_MS = 5000,
  MAX_WINDOW_DURATION_MS = 240000;

function classifyExtractionError(error) {
  if (/timed out/i.test(error?.message || '')) return new PlaybackError('Subtitle extraction timed out. Try burn-in.');
  if (/exceeded the.*limit|exceed/i.test(error?.message || ''))
    return new PlaybackError('Subtitle resource or fonts exceeded the supported limits. Try burn-in.');
  if (/no usable data/i.test(error?.message || ''))
    return new PlaybackError('Subtitle extraction produced no usable data. Try burn-in.');
  if (/failed/i.test(error?.message || ''))
    return new PlaybackError('Subtitle extraction failed during media demuxing. Try burn-in.');
  if (error instanceof PlaybackError) return error;
  return new PlaybackError('Original subtitles could not be extracted. Try burn-in.');
}

function quantizeWindow({ atMs = 0, beforeMs = 15000, afterMs = 60000 } = {}) {
  const number = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
  const targetMs = Math.max(0, Math.round(number(atMs, 0)));
  const beforeClampMs = Math.min(60000, Math.max(0, Math.round(number(beforeMs, 15000))));
  const afterClampMs = Math.min(180000, Math.max(10000, Math.round(number(afterMs, 60000))));
  const rawStartMs = Math.max(0, targetMs - beforeClampMs);
  const rawEndMs = targetMs + afterClampMs;

  // Round start DOWN and end UP so [qStartMs, qEndMs] strictly covers [rawStartMs, rawEndMs].
  const qStartMs = Math.floor(rawStartMs / QUANTUM_MS) * QUANTUM_MS;
  let qEndMs = Math.max(qStartMs + QUANTUM_MS, Math.ceil(rawEndMs / QUANTUM_MS) * QUANTUM_MS);
  if (qEndMs - qStartMs > MAX_WINDOW_DURATION_MS) {
    qEndMs = qStartMs + MAX_WINDOW_DURATION_MS;
  }
  const startSeconds = qStartMs / 1000;
  const endSeconds = qEndMs / 1000;
  const durationSeconds = endSeconds - startSeconds;
  return { qStartMs, qEndMs, startSeconds, endSeconds, durationSeconds };
}

function trackKey(track) {
  return JSON.stringify([
    track.external ? 'ext' : 'emb',
    track.id,
    track.index ?? null,
    track.delivery,
    track.codec || '',
    track.external ? track.resources?.data || '' : '',
    track.external && track.resources?.index ? track.resources.index : '',
  ]);
}

function buildCallerSignal(signal, media) {
  const signals = [signal, media?.subtitleAbort?.signal, media?.lifecycleAbort?.signal, currentSignal()].filter(
    Boolean,
  );
  return signals.length === 1 ? signals[0] : signals.length > 1 ? AbortSignal.any(signals) : undefined;
}

async function read(response, signal, limit = LIMIT) {
  if (!response.ok) throw new PlaybackError('The original subtitle resource is unavailable. Try burn-in.');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > limit) throw new PlaybackError('Subtitle resource exceeds the supported size. Try burn-in.');
      chunks.push(Buffer.from(chunk));
    }
  } catch (error) {
    await response.body.cancel?.().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, size);
}

function source(media) {
  const track = media.selection?.subtitle;
  if (!track || !['ass', 'pgs', 'vobsub', 'cues'].includes(track.delivery))
    throw new PlaybackError('No browser-rendered subtitle is selected.');
  return { track };
}

// Text cue start times FFmpeg has written so far, in milliseconds of source time.
function cueStarts(text) {
  const starts = [];
  for (const match of text.matchAll(/^(\S+)\s+-->\s/gm)) {
    const m = /^(?:(\d{1,6}):)?(\d{2}):(\d{2})\.(\d{3})$/.exec(match[1]);
    if (m) starts.push(((Number(m[1] || 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]));
  }
  return starts;
}

function alignPgs(data, origin, endSeconds) {
  const output = [];
  let cues = 0;
  for (let offset = 0; offset < data.length;) {
    if (offset + 13 > data.length || data[offset] !== 0x50 || data[offset + 1] !== 0x47)
      throw new PlaybackError('Invalid PGS extraction. Try burn-in.');
    const end = offset + 13 + data.readUInt16BE(offset + 11);
    if (end > data.length) throw new PlaybackError('Incomplete PGS extraction. Try burn-in.');
    const pts = Math.round(data.readUInt32BE(offset + 2) - origin * 90000);
    if (pts >= 0 && pts < endSeconds * 90000) {
      const segment = Buffer.from(data.subarray(offset, end));
      segment.writeUInt32BE(pts, 2);
      segment.writeUInt32BE(0, 6);
      output.push(segment);
      if (segment[10] === 0x16) cues++;
    }
    offset = end;
  }
  return { data: Buffer.concat(output), cues };
}

class SubtitleResourceManager {
  constructor({ mediaFacts, logger, idleMs = 1500, totalBytes = TOTAL } = {}) {
    this.mediaFacts = mediaFacts;
    this.logger = logger;
    this.idleMs = idleMs;
    this.totalBytes = totalBytes;
    this.fullTracks = new Map();
    this.trackWindows = new Map();
    this.windowLru = new Set();
    this.loadJobs = new Map();
    this.windowJobs = new Map();
    this.pipeJobs = new Map();
    this.cuesCache = new Map();
    this.cueJobs = new Map();
    this.cuesBudget = new CacheBudget(CUES_BUDGET);
    this.tempDirs = new Set();
    this.mediaIds = new WeakMap();
    this.nextMediaId = 1;
    this.bytes = 0;
    this.active = 0;
    this.slotWaiters = [];
    this.closed = false;
    this.counters = {
      fullHits: 0,
      fullMisses: 0,
      windowHits: 0,
      windowMisses: 0,
      cuesHits: 0,
      cuesMisses: 0,
    };
  }

  mediaScope(media) {
    const shared = scopeKey(media);
    if (shared) return shared;
    let id = this.mediaIds.get(media);
    if (!id) {
      id = 'media:' + this.nextMediaId++;
      this.mediaIds.set(media, id);
    }
    return id;
  }

  async acquireSlot(signal) {
    signal?.throwIfAborted();
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    if (this.active < 2 && !this.slotWaiters.length) {
      this.active++;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.releaseSlot();
      };
    }
    if (this.slotWaiters.length >= 16)
      throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose burn-in.');
    await new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject: err => {
          signal?.removeEventListener('abort', onAbort);
          reject(err);
        },
      };
      const onAbort = () => {
        const idx = this.slotWaiters.indexOf(entry);
        if (idx >= 0) this.slotWaiters.splice(idx, 1);
        reject(signal?.reason || new PlaybackError('Subtitle loading was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.slotWaiters.push(entry);
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.releaseSlot();
    };
  }

  releaseSlot() {
    while (this.slotWaiters.length) {
      const next = this.slotWaiters.shift();
      if (next) {
        next.resolve();
        return;
      }
    }
    this.active = Math.max(0, this.active - 1);
  }

  dropWindow(entry) {
    if (!entry || !this.windowLru.has(entry)) return;
    this.bytes -= entry.size;
    this.windowLru.delete(entry);
    const map = this.trackWindows.get(entry.trackScopeKey);
    if (map) {
      map.delete(entry.key);
      if (!map.size) this.trackWindows.delete(entry.trackScopeKey);
    }
    for (const owner of entry.owners) owner.windowCache?.delete(entry.key);
    entry.owners.clear();
  }

  dropFullTrack(fullKey) {
    const entry = this.fullTracks.get(fullKey);
    if (!entry) return;
    this.bytes -= entry.size;
    this.fullTracks.delete(fullKey);
    for (const owner of entry.owners) {
      if (owner.subtitleAssets === entry.assets) owner.subtitleAssets = undefined;
    }
    entry.owners.clear();
  }

  reserve(size) {
    while (this.bytes + size > this.totalBytes) {
      if (this.windowLru.size) this.dropWindow(this.windowLru.values().next().value);
      else if (this.fullTracks.size) this.dropFullTrack(this.fullTracks.keys().next().value);
      else break;
    }
  }

  attachFullTrackToMedia(media, entry) {
    entry.owners.add(media);
    media.subtitleAssets = entry.assets;
  }

  attachWindowToMedia(media, entry) {
    entry.owners.add(media);
    media.windowCache ||= new Map();
    media.windowCache.set(entry.key, entry);
  }

  // Extraction reads the real file, so it uses the file's own number for the track.
  async fileTrack(av1, media, track, url, signal, facts) {
    if (!av1?.ffprobe || !media?.tracks?.subtitles?.length) return track;
    if (facts?.streams) {
      media.fileStreams ||= facts.streams;
      return { ...track, index: fileIndex(media.tracks?.subtitles, track, facts.streams, 'subtitle') };
    }
    media.fileStreams ||=
      JSON.parse(
        (
          await av1.run(
            av1.ffprobe,
            ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name', '-of', 'json', url],
            signal,
            20000,
            1024 * 1024,
          )
        ).toString(),
      ).streams || [];
    return { ...track, index: fileIndex(media.tracks?.subtitles, track, media.fileStreams, 'subtitle') };
  }

  async inspectWindow(av1, media, url, index, codec, startSeconds, endSeconds, signal, facts) {
    const probe = av1.ffprobe;
    if (!probe) throw new PlaybackError('Subtitle window extraction needs configured FFprobe. Try burn-in.');
    const verify = info => {
      if (!info.streams?.some(stream => stream.index === index && (!codec || stream.codec_name === codec)))
        throw new PlaybackError('The selected subtitle stream could not be verified. Try burn-in.');
    };
    const inspect = async (interval, timeout, limit, entries) =>
      JSON.parse(
        (
          await av1.run(
            probe,
            [
              '-v',
              'error',
              '-analyzeduration',
              '1000000',
              '-probesize',
              '1048576',
              '-read_intervals',
              interval,
              '-show_packets',
              '-show_entries',
              entries,
              '-of',
              'json',
              url,
            ],
            signal,
            timeout,
            limit,
          )
        ).toString(),
      );
    let origin = Number.isFinite(facts?.originSeconds) ? facts.originSeconds : media.subtitleOrigin;
    if (!Number.isFinite(origin)) {
      const info = await inspect(
        '%+0.1',
        10000,
        1024 * 1024,
        'format=start_time:stream=index,codec_name:packet=pts_time',
      );
      verify(info);
      origin = Number(info.format?.start_time ?? info.packets?.[0]?.pts_time);
      if (!Number.isFinite(origin))
        throw new PlaybackError('The source timeline could not be determined. Try burn-in.');
      signal.throwIfAborted();
      media.subtitleOrigin = origin;
    } else if (facts?.streams?.length) {
      verify(facts);
    }
    const metadata = await inspect(
      String(origin + startSeconds) + '%' + String(origin + endSeconds),
      25000,
      16 * 1024 * 1024,
      'packet=stream_index,pts_time,size:stream=index,codec_name',
    );
    verify(metadata);
    if (!Array.isArray(metadata.packets) || !metadata.packets.length)
      throw new PlaybackError('No media packets could be verified for the subtitle window. Try burn-in.');
    return { origin, packets: metadata.packets.filter(packet => packet.stream_index === index) };
  }

  async extract(av1, activeSources, fallbackMedia, track, signal, facts) {
    if (!av1?.ffmpeg || !Number.isSafeInteger(track.index))
      throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or burn-in.');
    let directory;
    const sourceResolver = () => pickLiveSource(activeSources, fallbackMedia, { requireSubtitleAbort: true });
    try {
      return await av1.input(sourceResolver, signal, async url => {
        const liveMedia = pickLiveSource(activeSources, fallbackMedia, { requireSubtitleAbort: true }) || fallbackMedia;
        const { index } = await this.fileTrack(av1, liveMedia, track, url, signal, facts);
        let fonts = [];
        if (track.delivery === 'ass') {
          if (facts) {
            if (facts.fontAttachmentOverflow)
              throw new PlaybackError('Subtitle font attachments exceed the supported count.');
            fonts = [...facts.fontAttachments];
          } else {
            const info = JSON.parse(
              (
                await av1.run(
                  av1.ffprobe,
                  [
                    '-v',
                    'error',
                    '-show_entries',
                    'stream=index,codec_type:stream_tags=mimetype,filename',
                    '-of',
                    'json',
                    url,
                  ],
                  signal,
                  20000,
                  1024 * 1024,
                )
              ).toString(),
            );
            for (const stream of info.streams || [])
              if (
                stream.codec_type === 'attachment' &&
                Number.isSafeInteger(stream.index) &&
                (!stream.tags?.mimetype || /(?:font|opentype|truetype)/i.test(stream.tags.mimetype)) &&
                /\.(?:ttf|ttc|otf|woff2?)$/i.test(stream.tags?.filename || '')
              ) {
                if (fonts.length >= 32)
                  throw new PlaybackError('Subtitle font attachments exceed the supported count.');
                fonts.push(stream.index);
              }
          }
        }
        if (fonts.length) {
          directory = await fs.mkdtemp(path.join(os.tmpdir(), 'uburoom-subtitles-'));
          this.tempDirs.add(directory);
        }
        const files = fonts.map((_, i) => path.join(directory, String(i) + '.font'));
        const budget = new AbortController(),
          cancel = () => budget.abort();
        signal.addEventListener('abort', cancel, { once: true });
        let checking = false,
          oversize = false;
        const timer = files.length
          ? setInterval(async () => {
              if (checking) return;
              checking = true;
              try {
                const sizes = await Promise.all(
                  files.map(file =>
                    fs.stat(file).then(
                      s => s.size,
                      () => 0,
                    ),
                  ),
                );
                if (sizes.reduce((a, b) => a + b, 0) > FONTS) {
                  oversize = true;
                  budget.abort();
                }
              } finally {
                checking = false;
              }
            }, 100)
          : undefined;
        timer?.unref?.();
        try {
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            ...fonts.flatMap((fontIndex, i) => ['-dump_attachment:' + fontIndex, files[i]]),
            '-i',
            url,
            '-map',
            '0:' + index,
            '-c:s',
            'copy',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-f',
            track.delivery === 'ass' ? 'ass' : track.delivery === 'pgs' ? 'sup' : 'matroska',
            'pipe:1',
          ];
          const data = await av1.run(
            av1.ffmpeg,
            args,
            AbortSignal.any([signal, budget.signal]),
            60000,
            track.delivery === 'ass' ? 4 * 1024 * 1024 : LIMIT,
          );
          const assets = new Map([['data', data]]);
          let fontSize = 0;
          for (let i = 0; i < files.length; i++) {
            const stat = await fs.stat(files[i]);
            fontSize += stat.size;
            if (fontSize > FONTS) throw new PlaybackError('Subtitle fonts exceed the supported size.');
            assets.set('font-' + i, await fs.readFile(files[i]));
          }
          if (!data.length || oversize) throw new PlaybackError('Subtitle extraction produced no usable data.');
          return { format: track.delivery, fileName: track.delivery === 'vobsub' ? 'track.mks' : undefined, assets };
        } finally {
          clearInterval(timer);
          signal.removeEventListener('abort', cancel);
        }
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw classifyExtractionError(error);
    } finally {
      if (directory) {
        const resolved = path.resolve(directory);
        this.tempDirs.delete(directory);
        if (
          path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
          !path.basename(resolved).startsWith('uburoom-subtitles-')
        )
          throw new Error('Invalid subtitle temporary directory');
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  }

  commitFullTrack(fullKey, trackScopeKey, result) {
    const size = [...result.assets.values()].reduce((sum, value) => sum + value.length, 0);
    if (size > this.totalBytes) throw new PlaybackError('Subtitle resources exceed the cache limit.');
    const old = this.fullTracks.get(fullKey);
    if (old) this.dropFullTrack(fullKey);
    while (this.fullTracks.size && this.fullTracks.size >= MAX_FULL_TRACKS)
      this.dropFullTrack(this.fullTracks.keys().next().value);
    this.reserve(size);
    const entry = {
      key: fullKey,
      trackScopeKey,
      format: result.format,
      fileName: result.fileName,
      assets: result.assets,
      size,
      owners: new Set(),
    };
    this.fullTracks.set(fullKey, entry);
    this.bytes += size;
    return entry;
  }

  async load(av1, media, signal) {
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const { track } = source(media),
      version = media.captionVersion;
    const callerSignal = buildCallerSignal(signal, media);
    callerSignal?.throwIfAborted();

    const scope = this.mediaScope(media);
    const tKey = trackKey(track);
    const trackScopeKey = `${scope}|${tKey}`;
    const fullKey = `${scope}|track|${tKey}`;

    const previous = this.fullTracks.get(fullKey);
    if (previous) {
      this.counters.fullHits++;
      this.fullTracks.delete(fullKey);
      this.fullTracks.set(fullKey, previous);
      this.attachFullTrackToMedia(media, previous);
      return {
        format: previous.format,
        fileName: previous.fileName,
        assets: previous.assets,
        size: previous.size,
      };
    }

    const factsService = this.mediaFacts || av1?.mediaFacts;
    let facts;
    if (!track.external && factsService && av1?.ffprobe) {
      facts = await factsService.inspect(media, { signal: callerSignal });
      if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
        throw new PlaybackError('Subtitle selection changed.');
    }

    let flight = this.loadJobs.get(fullKey);
    if (flight && !flight.task.settled && !flight.task.signal.aborted) {
      // Join existing shared job
    } else {
      if (this.active >= 2 && this.slotWaiters.length >= 16)
        throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose burn-in.');
      this.counters.fullMisses++;
      const activeSources = new Set();
      const task = new SharedTask(
        async taskSignal => {
          let release;
          try {
            release = await this.acquireSlot(taskSignal);
            let result;
            if (track.external) {
              const { data: file, index } = track.resources || {};
              if (!file || (track.delivery === 'vobsub' && !index))
                throw new PlaybackError('Invalid subtitle resource.');
              const live = pickLiveSource(activeSources, media, { requireSubtitleAbort: true }) || media;
              const data = await read(
                await live.provider.request(file, { signal: taskSignal, headers: { Accept: '*/*' } }),
                taskSignal,
                track.delivery === 'ass' ? 4 * 1024 * 1024 : LIMIT,
              );
              result = { format: track.delivery, assets: new Map([['data', data]]) };
              if (track.delivery === 'vobsub') {
                const liveIdx = pickLiveSource(activeSources, media, { requireSubtitleAbort: true }) || media;
                result.assets.set(
                  'index',
                  await read(
                    await liveIdx.provider.request(index, { signal: taskSignal, headers: { Accept: '*/*' } }),
                    taskSignal,
                    1024 * 1024,
                  ),
                );
              }
            } else {
              result = await this.extract(av1, activeSources, media, track, taskSignal, facts);
            }
            taskSignal.throwIfAborted();
            if (this.closed) throw new PlaybackError('Server is shutting down.');
            return this.commitFullTrack(fullKey, trackScopeKey, result);
          } finally {
            release?.();
          }
        },
        { timeoutMs: 85000, idleMs: 0 },
      );
      flight = { task, activeSources, trackScopeKey };
      this.loadJobs.set(fullKey, flight);
      task.promise
        .finally(() => {
          if (this.loadJobs.get(fullKey) === flight) this.loadJobs.delete(fullKey);
        })
        .catch(() => {});
    }

    const sub = { media, signal: callerSignal };
    flight.activeSources.add(sub);
    media.subtitleJob = flight.task;
    try {
      const entry = await flight.task.join(callerSignal);
      if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
        throw new PlaybackError('Subtitle selection changed.');
      this.attachFullTrackToMedia(media, entry);
      return {
        format: entry.format,
        fileName: entry.fileName,
        assets: entry.assets,
        size: entry.size,
      };
    } finally {
      flight.activeSources.delete(sub);
      if (media.subtitleJob === flight.task) media.subtitleJob = undefined;
    }
  }

  startPgsJob(av1, media, track, fullKey, trackScopeKey, pipeKey, facts) {
    if (this.active >= 2 && this.slotWaiters.length >= 16)
      throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose burn-in.');
    const controller = new AbortController();
    const abort = AbortSignal.any([controller.signal, AbortSignal.timeout(300000)]);
    const activeSources = new Set();
    const job = {
      controller,
      activeSources,
      chunks: [],
      size: 0,
      listeners: new Set(),
      complete: false,
      error: null,
      output: null,
      graceTimer: undefined,
      trackScopeKey,
    };
    job.promise = runOperation(abort, async () => {
      let release;
      try {
        release = await this.acquireSlot(abort);
        if (!av1?.ffmpeg || !Number.isSafeInteger(track.index))
          throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or burn-in.');
        const sourceResolver = () => pickLiveSource(activeSources, media, { requireSubtitleAbort: true });
        await av1.input(sourceResolver, abort, async url => {
          const liveMedia = pickLiveSource(activeSources, media, { requireSubtitleAbort: true }) || media;
          const { index } = await this.fileTrack(av1, liveMedia, track, url, abort, facts);
          const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-nostdin',
            '-y',
            '-i',
            url,
            '-map',
            '0:' + index,
            '-c:s',
            'copy',
            '-map_metadata',
            '-1',
            '-map_chapters',
            '-1',
            '-flush_packets',
            '1',
            '-f',
            'sup',
            'pipe:1',
          ];
          await av1.stream(
            av1.ffmpeg,
            args,
            abort,
            chunk => {
              job.chunks.push(chunk);
              job.size += chunk.length;
              for (const listener of job.listeners)
                try {
                  listener(chunk, null);
                } catch {}
            },
            { idleTimeout: 300000, maxOutput: LIMIT },
          );
        });
        job.complete = true;
        const fullData = Buffer.concat(job.chunks, job.size);
        job.output = fullData;
        job.chunks = [];
        abort.throwIfAborted();
        if (this.closed) throw new PlaybackError('Server is shutting down.');
        const entry = this.commitFullTrack(fullKey, trackScopeKey, {
          format: 'pgs',
          assets: new Map([['data', fullData]]),
        });
        for (const sub of activeSources) {
          this.attachFullTrackToMedia(sub.media, entry);
        }
        for (const listener of job.listeners)
          try {
            listener(null, null);
          } catch {}
        return entry;
      } catch (error) {
        job.error = classifyExtractionError(error);
        for (const listener of job.listeners)
          try {
            listener(null, job.error);
          } catch {}
        throw job.error;
      } finally {
        clearTimeout(job.graceTimer);
        release?.();
        job.listeners.clear();
        if (this.pipeJobs.get(pipeKey) === job) this.pipeJobs.delete(pipeKey);
        for (const sub of activeSources) {
          if (sub.media.subtitleJob === job) sub.media.subtitleJob = undefined;
        }
      }
    });
    job.promise.catch(() => {});
    this.pipeJobs.set(pipeKey, job);
    return job;
  }

  async pipe(av1, media, req, res, signal) {
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const { track } = source(media);
    const version = media.captionVersion;
    const callerSignal = buildCallerSignal(signal, media);
    const scope = this.mediaScope(media);
    const tKey = trackKey(track);
    const trackScopeKey = `${scope}|${tKey}`;
    const fullKey = `${scope}|track|${tKey}`;
    const pipeKey = `${scope}|pipe|${tKey}`;

    const previous = this.fullTracks.get(fullKey);
    if (previous?.assets?.has('data')) {
      this.counters.fullHits++;
      this.fullTracks.delete(fullKey);
      this.fullTracks.set(fullKey, previous);
      this.attachFullTrackToMedia(media, previous);
      const data = previous.assets.get('data');
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-store',
      });
      res.end(req?.method === 'HEAD' ? undefined : data);
      return;
    }
    if (req?.method === 'HEAD') {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    const factsService = this.mediaFacts || av1?.mediaFacts;
    let facts;
    if (!track.external && factsService && av1?.ffprobe) {
      facts = await factsService.inspect(media, { signal: callerSignal });
      if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
        throw new PlaybackError('Subtitle selection changed.');
    }

    let job = this.pipeJobs.get(pipeKey);
    if (!job || job.controller.signal.aborted) {
      this.counters.fullMisses++;
      job = this.startPgsJob(av1, media, track, fullKey, trackScopeKey, pipeKey, facts);
    }

    clearTimeout(job.graceTimer);
    job.graceTimer = undefined;
    const sub = { media, signal: callerSignal };
    job.activeSources.add(sub);
    media.subtitleJob = job;

    let wake,
      closed = false,
      sent = 0,
      index = 0,
      headers = false;
    const notify = () => {
      wake?.();
      wake = undefined;
    };
    const cancel = () => {
      closed = true;
      if (!res.writableEnded && !res.destroyed) res.destroy();
      notify();
    };
    const close = () => {
      closed = true;
      notify();
    };
    const wait = () =>
      new Promise(resolve => {
        wake = resolve;
      });
    job.listeners.add(notify);
    res.on('close', close);
    callerSignal?.addEventListener('abort', cancel, { once: true });
    try {
      if (callerSignal?.aborted || res.destroyed) cancel();
      while (!closed) {
        if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
          throw new PlaybackError('Subtitle selection changed.');
        if (job.error) throw job.error;
        const chunk = job.complete ? job.output?.subarray(sent, sent + 65536) : job.chunks[index];
        if (chunk?.length) {
          if (!headers) {
            res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
            headers = true;
          }
          sent += chunk.length;
          index++;
          if (res.write(chunk) === false) {
            await new Promise(resolve => {
              const done = () => {
                res.off('drain', done);
                res.off('close', done);
                callerSignal?.removeEventListener('abort', done);
                resolve();
              };
              res.on('drain', done);
              res.on('close', done);
              callerSignal?.addEventListener('abort', done, { once: true });
              if (closed || callerSignal?.aborted || res.destroyed) done();
            });
          }
        } else if (job.complete) {
          if (!headers) res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' });
          res.end();
          return;
        } else await wait();
      }
    } catch (error) {
      if (!res.headersSent) throw error;
      res.destroy();
    } finally {
      job.listeners.delete(notify);
      job.activeSources.delete(sub);
      if (media.subtitleJob === job) media.subtitleJob = undefined;
      res.off('close', close);
      callerSignal?.removeEventListener('abort', cancel);
      if (!job.complete && job.listeners.size === 0) {
        if (!this.idleMs) {
          job.controller?.abort();
        } else {
          job.graceTimer = setTimeout(() => {
            if (!job.complete && job.listeners.size === 0) job.controller?.abort();
          }, this.idleMs);
        }
      }
    }
  }

  async window(av1, media, { atMs = 0, beforeMs = 15000, afterMs = 60000, signal, revoked } = {}) {
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const { track } = source(media),
      version = media.captionVersion;
    const subAbortSignal = media?.subtitleAbort?.signal;
    const lifeAbortSignal = media?.lifecycleAbort?.signal;
    signal?.throwIfAborted();
    subAbortSignal?.throwIfAborted();
    lifeAbortSignal?.throwIfAborted();
    const callerSignal = buildCallerSignal(signal, media);

    const { qStartMs, qEndMs, startSeconds, endSeconds, durationSeconds } = quantizeWindow({
      atMs,
      beforeMs,
      afterMs,
    });
    media.windowCache ||= new Map();
    media.windowJobs ||= new Map();
    const scope = this.mediaScope(media);
    const tKey = trackKey(track);
    const trackScopeKey = `${scope}|${tKey}`;
    const winKey = `${scope}|win|${tKey}|${qStartMs}-${qEndMs}`;

    const trackWinMap = this.trackWindows.get(trackScopeKey);
    if (trackWinMap) {
      for (const item of trackWinMap.values()) {
        if (
          item.delivery === track.delivery &&
          item.startMs <= qStartMs &&
          item.endMs >= qEndMs &&
          item.endMs - item.startMs <= MAX_WINDOW_DURATION_MS
        ) {
          this.counters.windowHits++;
          this.windowLru.delete(item);
          this.windowLru.add(item);
          this.attachWindowToMedia(media, item);
          return { format: track.delivery, startMs: item.startMs, endMs: item.endMs, data: item.data, cues: item.cues };
        }
      }
    }

    if (!av1?.ffmpeg || !Number.isSafeInteger(track.index))
      throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or burn-in.');

    const factsService = this.mediaFacts || av1?.mediaFacts;
    let facts;
    if (!track.external && factsService && av1?.ffprobe) {
      facts = await factsService.inspect(media, { signal: callerSignal });
      if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
        throw new PlaybackError('Subtitle selection changed.');
    }

    let flight = this.windowJobs.get(winKey);
    if (flight && !flight.task.settled && !flight.task.signal.aborted) {
      // Join existing shared window extraction
    } else {
      if (this.active >= 2 && this.slotWaiters.length >= 16)
        throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose burn-in.');
      this.counters.windowMisses++;
      const activeSources = new Set();
      const task = new SharedTask(
        async taskSignal => {
          let release;
          try {
            release = await this.acquireSlot(taskSignal);
            const format =
              track.delivery === 'ass'
                ? 'ass'
                : track.delivery === 'vobsub'
                  ? 'matroska'
                  : track.delivery === 'cues'
                    ? 'webvtt'
                    : 'sup';
            let pgs;
            let extractedOrigin = 0;
            const sourceResolver = () =>
              pickLiveSource(activeSources, media, {
                requireSubtitleAbort: true,
                extra: { subtitleWindow: ['pgs', 'cues'].includes(track.delivery) },
              });
            let data = await av1.input(sourceResolver, taskSignal, async url => {
              const liveMedia = pickLiveSource(activeSources, media, { requireSubtitleAbort: true }) || media;
              const { index } = await this.fileTrack(av1, liveMedia, track, url, taskSignal, facts);
              if (track.delivery === 'pgs') {
                const { origin, packets } = await this.inspectWindow(
                  av1,
                  liveMedia,
                  url,
                  index,
                  'hdmv_pgs_subtitle',
                  startSeconds,
                  endSeconds,
                  taskSignal,
                  facts,
                );
                extractedOrigin = origin;
                const count = packets.length;
                const expected = packets.reduce((sum, packet) => sum + Number(packet.size), 0);
                if (!Number.isSafeInteger(expected) || expected < 0 || expected > 16 * 1024 * 1024)
                  throw new PlaybackError('PGS window exceeded the supported limit. Try burn-in.');
                if (!count) {
                  pgs = { data: Buffer.alloc(0), cues: 0 };
                  return pgs.data;
                }
                const args = [
                  '-hide_banner',
                  '-loglevel',
                  'error',
                  '-nostdin',
                  '-y',
                  '-ss',
                  String(startSeconds),
                  '-copyts',
                  '-analyzeduration',
                  '1000000',
                  '-probesize',
                  '1048576',
                  '-i',
                  url,
                  '-map',
                  '0:' + index,
                  '-c:s',
                  'copy',
                  '-frames:s',
                  String(count),
                  '-flush_packets',
                  '1',
                  '-map_metadata',
                  '-1',
                  '-map_chapters',
                  '-1',
                  '-f',
                  'sup',
                  'pipe:1',
                ];
                let pending = Buffer.alloc(0),
                  rawBytes = 0;
                const expectedTimes = new Map(),
                  receivedTimes = new Map();
                for (const packet of packets) {
                  const pts = Math.round(Number(packet.pts_time) * 90000);
                  if (!Number.isSafeInteger(pts) || pts < 0 || pts > 0xffffffff)
                    throw new PlaybackError(
                      'PGS source timestamps are unavailable or exceed the supported range. Try burn-in.',
                    );
                  expectedTimes.set(pts, (expectedTimes.get(pts) || 0) + Number(packet.size));
                }
                const outputComplete = chunk => {
                  pending = Buffer.concat([pending, chunk]);
                  let offset = 0;
                  while (offset + 13 <= pending.length) {
                    if (pending[offset] !== 0x50 || pending[offset + 1] !== 0x47)
                      throw new PlaybackError('Invalid PGS extraction. Try burn-in.');
                    const length = pending.readUInt16BE(offset + 11);
                    if (offset + 13 + length > pending.length) break;
                    const pts = pending.readUInt32BE(offset + 2);
                    receivedTimes.set(pts, (receivedTimes.get(pts) || 0) + 3 + length);
                    rawBytes += 3 + length;
                    offset += 13 + length;
                  }
                  pending = Buffer.from(pending.subarray(offset));
                  return rawBytes >= expected;
                };
                const rawPgs = await av1.run(av1.ffmpeg, args, taskSignal, 25000, 16 * 1024 * 1024, undefined, {
                  outputComplete,
                });
                if (
                  rawBytes !== expected ||
                  pending.length ||
                  expectedTimes.size !== receivedTimes.size ||
                  [...expectedTimes].some(([pts, size]) => receivedTimes.get(pts) !== size)
                )
                  throw new PlaybackError('PGS extraction did not match the requested packets. Try burn-in.');
                pgs = alignPgs(rawPgs, origin, endSeconds);
                if (!pgs.data.length)
                  throw new PlaybackError('Subtitle extraction produced no usable data. Try burn-in.');
                return pgs.data;
              }
              if (track.delivery === 'cues') {
                const { origin, packets } = await this.inspectWindow(
                  av1,
                  liveMedia,
                  url,
                  index,
                  undefined,
                  startSeconds,
                  endSeconds,
                  taskSignal,
                  facts,
                );
                extractedOrigin = origin;
                const first = Math.round((origin + startSeconds) * 1000),
                  last = Math.round((origin + endSeconds) * 1000),
                  wanted = [];
                for (const packet of packets) {
                  const at = Math.round(Number(packet.pts_time) * 1000);
                  if (!Number.isSafeInteger(at))
                    throw new PlaybackError('Subtitle source timestamps are unavailable. Try burn-in.');
                  if (at >= first && at < last) wanted.push(at);
                }
                if (!wanted.length) return Buffer.alloc(0);
                wanted.sort((a, b) => a - b);
                const decoder = new StringDecoder('utf8');
                let text = '';
                const missing = () => {
                  const seen = cueStarts(text).sort((a, b) => a - b);
                  let i = 0;
                  for (const at of wanted) {
                    while (i < seen.length && seen[i] < at - 1) i++;
                    if (i >= seen.length || seen[i] > at + 1) return true;
                    i++;
                  }
                  return false;
                };
                const vttBytes = await av1.run(
                  av1.ffmpeg,
                  [
                    '-hide_banner',
                    '-loglevel',
                    'error',
                    '-nostdin',
                    '-y',
                    '-ss',
                    String(startSeconds),
                    '-copyts',
                    '-i',
                    url,
                    '-to',
                    String(origin + endSeconds),
                    '-map',
                    '0:' + index,
                    '-c:s',
                    'webvtt',
                    '-flush_packets',
                    '1',
                    '-map_metadata',
                    '-1',
                    '-map_chapters',
                    '-1',
                    '-f',
                    'webvtt',
                    'pipe:1',
                  ],
                  taskSignal,
                  25000,
                  4 * 1024 * 1024,
                  undefined,
                  {
                    outputComplete: chunk => {
                      text += decoder.write(chunk);
                      return !missing();
                    },
                  },
                );
                text = vttBytes.toString('utf8');
                if (missing())
                  throw new PlaybackError('Subtitle extraction did not match the inspected cues. Try burn-in.');
                return vttBytes;
              }
              const args = [
                '-hide_banner',
                '-loglevel',
                'error',
                '-nostdin',
                '-y',
                '-ss',
                String(startSeconds),
                '-t',
                String(durationSeconds),
                '-copyts',
                '-i',
                url,
                '-map',
                '0:' + index,
                '-c:s',
                'copy',
                '-map_metadata',
                '-1',
                '-map_chapters',
                '-1',
                '-f',
                format,
                'pipe:1',
              ];
              return av1.run(av1.ffmpeg, args, taskSignal, 25000, 16 * 1024 * 1024);
            });
            taskSignal.throwIfAborted();
            if (this.closed) throw new PlaybackError('Server is shutting down.');
            data ||= Buffer.alloc(0);
            let cues = 0;
            if (track.delivery === 'cues') {
              const origin = Number(extractedOrigin) || 0;
              const rawList = data.length ? Subtitles.parse(data.toString('utf8')) : [];
              const list = origin
                ? rawList
                    .map(c => ({ ...c, start: Math.max(0, c.start - origin), end: Math.max(0, c.end - origin) }))
                    .filter(c => c.end > c.start)
                : rawList;
              cues = list.length;
              data = Buffer.from(JSON.stringify(list));
            } else if (track.delivery === 'pgs') cues = pgs.cues;
            else if (track.delivery === 'ass') cues = (data.toString('utf8').match(/^Dialogue:/gm) || []).length;
            else cues = data.length > 500 ? 1 : 0;

            if (data.length > this.totalBytes) throw new PlaybackError('Subtitle resources exceed the cache limit.');

            let map = this.trackWindows.get(trackScopeKey);
            if (!map) {
              map = new Map();
              this.trackWindows.set(trackScopeKey, map);
            }
            let trackBytes = [...map.values()].reduce((n, item) => n + item.size, 0);
            while (map.size >= MAX_TRACK_WINDOWS || trackBytes + data.length > MAX_TRACK_WINDOW_BYTES) {
              const oldest = map.values().next().value;
              if (!oldest) break;
              trackBytes -= oldest.size;
              this.dropWindow(oldest);
            }
            while (this.windowLru.size && this.windowLru.size >= MAX_TOTAL_WINDOWS)
              this.dropWindow(this.windowLru.values().next().value);
            this.reserve(data.length);

            const entry = {
              key: winKey,
              trackScopeKey,
              delivery: track.delivery,
              trackId: track.id,
              startMs: qStartMs,
              endMs: qEndMs,
              data,
              size: data.length,
              cues,
              owners: new Set(),
            };
            if (!this.trackWindows.has(trackScopeKey)) this.trackWindows.set(trackScopeKey, map);
            map.set(winKey, entry);
            this.windowLru.add(entry);
            this.bytes += entry.size;
            return entry;
          } catch (error) {
            if (taskSignal.aborted) throw error;
            throw classifyExtractionError(error);
          } finally {
            release?.();
          }
        },
        { timeoutMs: 30000, idleMs: this.idleMs },
      );
      flight = { task, activeSources, trackScopeKey };
      this.windowJobs.set(winKey, flight);
      task.promise
        .finally(() => {
          if (this.windowJobs.get(winKey) === flight) this.windowJobs.delete(winKey);
        })
        .catch(() => {});
    }

    const sub = { media, signal: callerSignal };
    flight.activeSources.add(sub);
    media.windowJobs ||= new Map();
    media.windowJobs.set(winKey, flight.task);
    try {
      const entry = await flight.task.join(callerSignal);
      if (media.captionVersion !== version || media.selection?.subtitle?.id !== track.id)
        throw new PlaybackError('Subtitle selection changed.');
      this.attachWindowToMedia(media, entry);
      return {
        format: track.delivery,
        startMs: entry.startMs,
        endMs: entry.endMs,
        data: entry.data,
        cues: entry.cues,
      };
    } finally {
      flight.activeSources.delete(sub);
      if (media.windowJobs?.get(winKey) === flight.task) media.windowJobs.delete(winKey);
      if (
        !flight.task.settled &&
        flight.task.users === 0 &&
        (revoked?.() || subAbortSignal?.aborted || lifeAbortSignal?.aborted)
      ) {
        flight.task.abort();
      }
    }
  }

  async loadTextCues(media, signal) {
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const track = media?.selection?.subtitle;
    if (!track?.available || track.delivery !== 'text')
      throw new PlaybackError(track?.reason || 'No external text subtitle is selected.');
    const resource = track.resources?.text || track.resources?.data;
    if (!resource) throw new PlaybackError('Subtitle selection no longer belongs to this file.');
    const version = media.captionVersion;
    const callerSignal = buildCallerSignal(signal, media);
    callerSignal?.throwIfAborted();

    const scope = this.mediaScope(media);
    const cueKey = `${scope}|cues|${track.id}|${resource}`;

    const cached = this.cuesCache.get(cueKey);
    if (cached) {
      this.counters.cuesHits++;
      this.cuesCache.delete(cueKey);
      this.cuesCache.set(cueKey, cached);
      this.cuesBudget.touch(cached);
      return cached.cues;
    }

    let flight = this.cueJobs.get(cueKey);
    if (!flight || flight.task.settled || flight.task.signal.aborted) {
      this.counters.cuesMisses++;
      const activeSources = new Set();
      const task = new SharedTask(
        async taskSignal => {
          const liveMedia = pickLiveSource(activeSources, media, { requireSubtitleAbort: true }) || media;
          const cues = await Subtitles.fetchCues(liveMedia, taskSignal);
          taskSignal.throwIfAborted();
          if (this.closed) throw new PlaybackError('Server is shutting down.');
          const entry = { key: cueKey, cues };
          this.cuesCache.delete(cueKey);
          this.cuesCache.set(cueKey, entry);
          while (this.cuesCache.size > MAX_CUES_TRACKS) {
            const oldestKey = this.cuesCache.keys().next().value;
            const oldest = this.cuesCache.get(oldestKey);
            this.cuesCache.delete(oldestKey);
            if (oldest) this.cuesBudget.delete(oldest);
          }
          this.cuesBudget.retain(this.cuesCache, cueKey, entry, cues);
          return cues;
        },
        { timeoutMs: 30000, idleMs: this.idleMs },
      );
      flight = { task, activeSources };
      this.cueJobs.set(cueKey, flight);
      task.promise
        .finally(() => {
          if (this.cueJobs.get(cueKey) === flight) this.cueJobs.delete(cueKey);
        })
        .catch(() => {});
    }

    const sub = { media, signal: callerSignal };
    flight.activeSources.add(sub);
    try {
      const cues = await flight.task.join(callerSignal);
      if (version !== undefined && media.captionVersion !== version)
        throw new PlaybackError('Subtitle selection changed.');
      if (media.selection?.subtitle?.id !== track.id) throw new PlaybackError('Subtitle selection changed.');
      return cues;
    } finally {
      flight.activeSources.delete(sub);
    }
  }

  clear(media) {
    if (!media) return;
    for (const entry of media.windowCache?.values() || []) {
      entry.owners.delete(media);
      if (!media.shareKey) this.dropWindow(entry);
    }
    media.windowCache?.clear();
    for (const job of media.windowJobs?.values() || []) {
      if (!media.shareKey) job.abort?.();
    }
    media.windowJobs?.clear();
    if (media.subtitleAssets) {
      for (const [fullKey, entry] of this.fullTracks) {
        if (entry.assets === media.subtitleAssets) {
          entry.owners.delete(media);
          if (!media.shareKey) this.dropFullTrack(fullKey);
        }
      }
      media.subtitleAssets = undefined;
    }
    if (media.subtitleJob) {
      if (!media.shareKey) {
        if (typeof media.subtitleJob.abort === 'function') media.subtitleJob.abort();
        else media.subtitleJob.controller?.abort();
      }
      media.subtitleJob = undefined;
    }
  }

  transfer(from, to) {
    if (
      !from ||
      !to ||
      from === to ||
      !from.sourceKey ||
      from.sourceKey !== to.sourceKey ||
      from.principal !== to.principal
    )
      return false;
    const a = from.selection?.subtitle,
      b = to.selection?.subtitle;
    if (!a?.available || !b?.available || a.delivery === 'burn' || a.delivery !== b.delivery || a.id !== b.id)
      return false;
    if (from.subtitleCache) {
      to.subtitleCache = from.subtitleCache;
      from.subtitleCache = undefined;
    }
    if (from.windowCache) {
      to.windowCache = from.windowCache;
      from.windowCache = undefined;
      for (const entry of to.windowCache.values()) {
        entry.owners?.delete(from);
        entry.owners?.add(to);
      }
    }
    if (from.windowJobs) {
      to.windowJobs = from.windowJobs;
      from.windowJobs = undefined;
    }
    to.captionVersion = from.captionVersion;
    to.subtitleAbort?.abort();
    to.subtitleAbort = from.subtitleAbort || new AbortController();
    to.subtitleAssets = from.subtitleAssets;
    if (to.subtitleAssets) {
      for (const entry of this.fullTracks.values()) {
        if (entry.assets === to.subtitleAssets) {
          entry.owners.delete(from);
          entry.owners.add(to);
        }
      }
    }
    to.subtitleJob = from.subtitleJob;
    from.subtitleAbort = undefined;
    from.subtitleAssets = undefined;
    from.subtitleJob = undefined;
    return true;
  }

  read(response, signal, limit) {
    return read(response, signal, limit);
  }

  stats() {
    return {
      bytes: this.bytes,
      fullTracks: this.fullTracks.size,
      windows: this.windowLru.size,
      cuesTracks: this.cuesCache.size,
      cuesBytes: this.cuesBudget.bytes,
      activeSlots: this.active,
      slotWaiters: this.slotWaiters.length,
      ...this.counters,
    };
  }

  close() {
    this.closed = true;
    for (const flight of this.loadJobs.values()) flight.task.abort();
    this.loadJobs.clear();
    for (const flight of this.windowJobs.values()) flight.task.abort();
    this.windowJobs.clear();
    for (const job of this.pipeJobs.values()) {
      clearTimeout(job.graceTimer);
      job.controller.abort();
    }
    this.pipeJobs.clear();
    for (const flight of this.cueJobs.values()) flight.task.abort();
    this.cueJobs.clear();
    while (this.slotWaiters.length) {
      const waiter = this.slotWaiters.shift();
      waiter?.reject(new PlaybackError('Server is shutting down.'));
    }
    this.fullTracks.clear();
    this.trackWindows.clear();
    this.windowLru.clear();
    this.cuesCache.clear();
    this.cuesBudget.clear();
    this.bytes = 0;
    for (const dir of [...this.tempDirs]) {
      this.tempDirs.delete(dir);
      void fs.rm(path.resolve(dir), { recursive: true, force: true }).catch(() => {});
    }
  }
}

const defaultManager = new SubtitleResourceManager();

module.exports = {
  SubtitleResourceManager,
  quantizeWindow,
  trackKey,
  load: (av1, media, signal) => defaultManager.load(av1, media, signal),
  clear: media => defaultManager.clear(media),
  transfer: (from, to) => defaultManager.transfer(from, to),
  read: (response, signal, limit) => defaultManager.read(response, signal, limit),
  pipe: (av1, media, req, res, signal) => defaultManager.pipe(av1, media, req, res, signal),
  window: (av1, media, options) => defaultManager.window(av1, media, options),
  loadTextCues: (media, signal) => defaultManager.loadTextCues(media, signal),
  classifyExtractionError,
  LIMIT,
};
