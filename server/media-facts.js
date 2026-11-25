// @ts-check
'use strict';
const { CacheBudget } = require('./cache-budget');
const { PlaybackError } = require('./errors');
const { SharedTask, currentSignal } = require('./operation');

const FRAME_GRID = { aac: 1024, ac3: 1536, eac3: 256, mp3: 576, mp2: 1152, dts: '256*max(1,floor(SR/48000))' };

/**
 * Derive audio packet frame grids from a probe's initial packets. Mutates stream entries
 * in place with `first_pts`, `grid_from`, `major_sync_units`, or `even_packets`, and
 * removes raw `packets` so the summary stays compact.
 * @param {any} info
 */
function frameGrids(info) {
  const packets = info.packets || [];
  delete info.packets;
  for (const stream of info.streams || []) {
    if (stream.codec_type !== 'audio') continue;
    const own = packets.filter(p => p.stream_index === stream.index && Number.isFinite(Number(p.pts_time))),
      times = own.map(p => Number(p.pts_time)),
      rate = Number(stream.sample_rate);
    const even = (from, to, step) => {
      for (let i = from; i <= to; i++)
        if (Math.abs(times[i] - times[from] - ((i - from) * step) / rate) > 0.0015) return false;
      return true;
    };
    if (stream.codec_name === 'truehd' && rate) {
      const unit = 40 * Math.max(1, Math.round(rate / 44100)),
        syncs = own.flatMap((p, i) => (p.flags?.startsWith('K') ? [i] : [])),
        steady = syncs.slice(2).map((at, i) => at - syncs[i + 1]);
      if (steady.length >= 2 && steady.every(gap => gap === steady[0]) && even(syncs[0], syncs.at(-1), unit)) {
        stream.first_pts = times[syncs[0]];
        stream.grid_from = stream.first_pts + ((syncs[1] - syncs[0]) * unit) / rate;
        stream.major_sync_units = steady[0];
      }
    } else if ((stream.codec_name === 'flac' || /^pcm_/.test(stream.codec_name)) && rate && own.length >= 5) {
      const block = ((times.at(-1) - times[0]) / (times.length - 1)) * rate;
      if (block >= rate / 200 && even(0, times.length - 1, block)) {
        stream.first_pts = times[0];
        stream.even_packets = true;
      }
    } else if (own.length && FRAME_GRID[stream.codec_name]) stream.first_pts = times[0];
  }
  return info;
}

/**
 * Shared cache boundary key for a media source. Room-prepared streams carry `shareKey`
 * and share across authorized room viewers; standalone scoped calls isolate by principal.
 * @param {any} media
 * @returns {string | null}
 */
function scopeKey(media) {
  if (!media?.sourceKey) return null;
  if (media.shareKey) return JSON.stringify(['shared', media.sourceKey]);
  return JSON.stringify(['principal', media.principal || 'local', media.sourceKey]);
}

function isLiveSubscriber(sub, requireSubtitleAbort = false) {
  const media = sub?.media;
  if (!media) return false;
  if (sub.signal?.aborted) return false;
  if (media.lifecycleAbort?.signal?.aborted) return false;
  if (requireSubtitleAbort && media.subtitleAbort?.signal?.aborted) return false;
  return true;
}

/**
 * Select an un-aborted subscriber's upstream source descriptor for `av1.input` bridge
 * requests so one viewer closing their tab never cuts off shared extraction/probing.
 * @param {Set<{media: any, signal?: AbortSignal}>} activeSources
 * @param {any} fallbackMedia
 * @param {{requireSubtitleAbort?: boolean, extra?: Record<string, any>}} [options]
 */
function pickLiveSource(activeSources, fallbackMedia, { requireSubtitleAbort = false, extra } = {}) {
  let chosen;
  for (const sub of activeSources) {
    if (isLiveSubscriber(sub, requireSubtitleAbort)) {
      chosen = sub.media;
      break;
    }
  }
  if (!chosen && isLiveSubscriber({ media: fallbackMedia }, requireSubtitleAbort)) {
    chosen = fallbackMedia;
  }
  if (!chosen) return undefined;
  return {
    ...chosen,
    start: chosen.sourceStart ?? chosen.start,
    ...(extra || {}),
  };
}

const PROBE_ENTRIES =
  'stream=index,codec_type,codec_name,profile,level,sample_rate,channels,width,height,coded_width,coded_height,pix_fmt,color_space,color_primaries,color_transfer,color_range,r_frame_rate,avg_frame_rate:' +
  'stream_tags=mimetype,filename,language,title:' +
  'stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:' +
  'format=duration,bit_rate,start_time:' +
  'packet=stream_index,codec_type,pts_time,flags';

function normalizeFacts(parsed, probeStats = { seconds: 0 }) {
  const streamsInput = Array.isArray(parsed?.streams) ? parsed.streams.map(s => ({ ...s })) : [];
  const packetsInput = Array.isArray(parsed?.packets) ? parsed.packets : [];
  const formatInput = parsed?.format ? { ...parsed.format } : undefined;
  const formatStart = Number(formatInput?.start_time);
  let firstPacketPts;
  for (const packet of packetsInput) {
    const pts = Number(packet?.pts_time);
    if (Number.isFinite(pts)) {
      firstPacketPts = pts;
      break;
    }
  }
  const parsedOrigin = Number(parsed?.originSeconds);
  const originSeconds = Number.isFinite(parsedOrigin)
    ? parsedOrigin
    : Number.isFinite(formatStart)
      ? formatStart
      : firstPacketPts;

  /** @type {number[]} */
  const fontAttachments = [];
  let fontAttachmentOverflow = false;
  for (const stream of streamsInput) {
    if (
      stream.codec_type === 'attachment' &&
      Number.isSafeInteger(stream.index) &&
      (!stream.tags?.mimetype || /(?:font|opentype|truetype)/i.test(stream.tags.mimetype)) &&
      /\.(?:ttf|ttc|otf|woff2?)$/i.test(stream.tags?.filename || '')
    ) {
      if (fontAttachments.length >= 32) {
        fontAttachmentOverflow = true;
        break;
      }
      fontAttachments.push(stream.index);
    }
  }

  const frameGridInfo = frameGrids({
    streams: streamsInput,
    packets: packetsInput,
    ...(formatInput ? { format: formatInput } : {}),
  });

  const format = Object.freeze({
    duration: formatInput?.duration,
    bitRate: formatInput?.bit_rate,
    startTime: formatInput?.start_time,
  });

  return Object.freeze({
    streams: frameGridInfo.streams || [],
    fontAttachments: Object.freeze(fontAttachments),
    fontAttachmentOverflow,
    format,
    originSeconds,
    frameGridInfo,
    probeStats: Object.freeze({ ...probeStats }),
  });
}

class MediaFacts {
  /**
   * @param {{av1?: any, logger?: any, maxBytes?: number, maxEntries?: number, idleMs?: number, timeoutMs?: number}} [options]
   */
  constructor({ av1, logger, maxBytes = 8 * 1024 * 1024, maxEntries = 256, idleMs = 1500, timeoutMs = 30000 } = {}) {
    this.av1 = av1;
    this.logger = logger;
    this.maxEntries = maxEntries;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.budget = new CacheBudget(maxBytes);
    /** @type {Map<string, {key: string, sourceKey: string, facts: ReturnType<typeof normalizeFacts>}>} */
    this.cache = new Map();
    /** @type {Map<string, {sourceKey: string, task: InstanceType<typeof SharedTask>, activeSources: Set<{media: any, signal?: AbortSignal}>}>} */
    this.inflight = new Map();
    this.closed = false;
    this.counters = { probes: 0, hits: 0, coalesced: 0, misses: 0 };
  }

  /** @param {any} media @param {{signal?: AbortSignal}} [options] */
  async inspect(media, { signal } = {}) {
    if (this.closed) throw new PlaybackError('Server is shutting down.');
    const signals = [signal, media?.lifecycleAbort?.signal, currentSignal()].filter(Boolean);
    const effectiveSignal =
      signals.length === 1 ? signals[0] : signals.length > 1 ? AbortSignal.any(signals) : undefined;
    effectiveSignal?.throwIfAborted();

    if (
      media?.file &&
      media?.localProbeInfo &&
      Array.isArray(media.localProbeInfo.streams) &&
      media.localProbeInfo.format &&
      Number.isFinite(Number(media.localProbeInfo.originSeconds ?? media.localProbeInfo.format.start_time))
    ) {
      return normalizeFacts(media.localProbeInfo, { seconds: 0 });
    }

    const key = scopeKey(media);
    if (!key) {
      return this.runProbe(new Set([{ media, signal: effectiveSignal }]), media, effectiveSignal);
    }

    const cached = this.cache.get(key);
    if (cached) {
      this.counters.hits++;
      this.cache.delete(key);
      this.cache.set(key, cached);
      this.budget.touch(cached);
      return cached.facts;
    }

    let flight = this.inflight.get(key);
    if (flight && !flight.task.settled && !flight.task.signal.aborted) {
      this.counters.coalesced++;
    } else {
      this.counters.misses++;
      const activeSources = new Set();
      const task = new SharedTask(
        async taskSignal => {
          const facts = await this.runProbe(activeSources, media, taskSignal);
          if (taskSignal.aborted || this.closed) throw taskSignal.reason || new PlaybackError('Media probe cancelled.');
          const entry = { key, sourceKey: media.sourceKey, facts };
          this.cache.delete(key);
          this.cache.set(key, entry);
          while (this.cache.size > this.maxEntries) {
            const oldestKey = this.cache.keys().next().value;
            const oldest = this.cache.get(oldestKey);
            this.cache.delete(oldestKey);
            if (oldest) this.budget.delete(oldest);
          }
          this.budget.retain(this.cache, key, entry, facts);
          return facts;
        },
        { idleMs: this.idleMs, timeoutMs: this.timeoutMs },
      );
      flight = { sourceKey: media.sourceKey, task, activeSources };
      this.inflight.set(key, flight);
      task.promise
        .finally(() => {
          if (this.inflight.get(key) === flight) this.inflight.delete(key);
        })
        .catch(() => {});
    }

    const sub = { media, signal: effectiveSignal };
    flight.activeSources.add(sub);
    try {
      return await flight.task.join(effectiveSignal);
    } finally {
      flight.activeSources.delete(sub);
    }
  }

  /**
   * @param {Set<{media: any, signal?: AbortSignal}>} activeSources
   * @param {any} fallbackMedia
   * @param {AbortSignal | undefined} signal
   */
  async runProbe(activeSources, fallbackMedia, signal) {
    const av1 = this.av1;
    if (!av1?.ffprobe) throw new PlaybackError('FFprobe is not configured.');
    const sourceResolver = () => pickLiveSource(activeSources, fallbackMedia);
    return av1.input(sourceResolver, signal, async (url, state) => {
      const asked = Date.now();
      this.counters.probes++;
      const raw = await av1.run(
        av1.ffprobe,
        [
          '-v',
          'error',
          '-analyzeduration',
          '1000000',
          '-probesize',
          '1048576',
          '-read_intervals',
          '%+0.5',
          '-show_entries',
          PROBE_ENTRIES,
          '-of',
          'json',
          url,
        ],
        signal,
        this.timeoutMs,
        16 * 1024 * 1024,
      );
      const parsed = JSON.parse(raw.toString());
      return normalizeFacts(parsed, { seconds: (Date.now() - asked) / 1000, ...state });
    });
  }

  /** @param {string | {sourceKey?: string} | undefined} sourceKeyOrMedia */
  forget(sourceKeyOrMedia) {
    const sk = typeof sourceKeyOrMedia === 'string' ? sourceKeyOrMedia : sourceKeyOrMedia?.sourceKey;
    if (!sk) return;
    for (const [k, entry] of this.cache) {
      if (entry.sourceKey === sk || k === sk) {
        this.cache.delete(k);
        this.budget.delete(entry);
      }
    }
    for (const [k, flight] of this.inflight) {
      if (flight.sourceKey === sk || k === sk) {
        this.inflight.delete(k);
        flight.task.abort();
      }
    }
  }

  stats() {
    return {
      entries: this.cache.size,
      bytes: this.budget.bytes,
      inflight: this.inflight.size,
      ...this.counters,
    };
  }

  close() {
    this.closed = true;
    for (const flight of this.inflight.values()) flight.task.abort();
    this.inflight.clear();
    this.cache.clear();
    this.budget.clear();
  }
}

module.exports = { MediaFacts, frameGrids, FRAME_GRID, scopeKey, pickLiveSource };
