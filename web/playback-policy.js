import * as uburoomTiming from '../shared/sync/timing.mjs';

/* Shared browser/server playback limits. No credentials, DOM or network calls. */
const BUFFER = Object.freeze({
  ahead: 60,
  behind: 30,
  maxBytes: 64 * 1024 * 1024,
  hlsMaxBytes: 256 * 1024 * 1024,
  chunkSeconds: 6,
});
const LOCAL_CODECS = Object.freeze({
  av1: 'video/webm; codecs="av01.0.12M.08"',
  vp9: 'video/webm; codecs="vp9"',
  vp8: 'video/webm; codecs="vp8"',
});
const localFormat = value => Object.hasOwn(LOCAL_CODECS, value);
function fallbackCodecs(allowed, attempted, supports) {
  return [...new Set(allowed)].filter(
    codec => localFormat(codec) && !attempted.has(codec) && supports(LOCAL_CODECS[codec]),
  );
}
// Selecting Original can still mean a conversion, for example when subtitles are
// burned or the browser cannot decode the file. Plex changing only the audio keeps the video.
function convertedOriginal(state) {
  const info = state?.deliveryInfo;
  return (
    state?.quality === 'direct' &&
    !!info &&
    info.format !== 'file' &&
    !['multiple-audio', 'audio-conversion'].includes(info.reason)
  );
}
// Reads what a transport stream segment holds: its AAC audio pid, where and when its
// audio starts, and when its first picture plays. Other containers return undefined.
function transportAudio(bytes) {
  if (!bytes.length || bytes.length % 188 || bytes[0] !== 0x47) return undefined;
  let programPid, videoPid, audioPid, audioAt, audioPts, pts;
  for (let at = 0; at < bytes.length; at += 188) {
    if (bytes[at] !== 0x47) return undefined;
    const pid = ((bytes[at + 1] & 31) << 8) | bytes[at + 2],
      start = !!(bytes[at + 1] & 64),
      control = (bytes[at + 3] >> 4) & 3;
    if (!(control & 1)) continue;
    const payload = at + 4 + (control & 2 ? bytes[at + 4] + 1 : 0);
    if (start && (pid === 0 || pid === programPid)) {
      const table = payload + 1 + bytes[payload],
        end = table + 3 + (((bytes[table + 1] & 15) << 8) | bytes[table + 2]) - 4;
      if (pid === 0) programPid = ((bytes[table + 10] & 31) << 8) | bytes[table + 11];
      else
        for (
          let entry = table + 12 + (((bytes[table + 10] & 15) << 8) | bytes[table + 11]);
          entry < end;
          entry += 5 + (((bytes[entry + 3] & 15) << 8) | bytes[entry + 4])
        ) {
          const type = bytes[entry],
            stream = ((bytes[entry + 1] & 31) << 8) | bytes[entry + 2];
          if (type === 0x0f) audioPid = stream;
          if (type === 0x1b || type === 0x24) videoPid = stream;
        }
    } else if (start && (pid === audioPid || pid === videoPid) && bytes[payload + 7] & 0x80) {
      const p = payload + 9,
        time =
          ((bytes[p] >> 1) & 7) * 2 ** 30 +
          ((bytes[p + 1] << 22) | ((bytes[p + 2] >> 1) << 15) | (bytes[p + 3] << 7) | (bytes[p + 4] >> 1));
      if (pid === videoPid && (pts === undefined || time < pts)) pts = time;
      if (pid === audioPid && audioAt === undefined) {
        audioAt = at;
        audioPts = time;
      }
    }
  }
  return { audioPid, audioAt, audioPts, pts };
}
// Silent 48 kHz stereo AAC packets for one segment, in the same pid as the real audio.
function silentAudioPackets(pid, pts, seconds) {
  const frame = [0xff, 0xf1, 0x4c, 0x80, 0x02, 0x1f, 0xfc, 0x21, 0x00, 0x49, 0x90, 0x02, 0x19, 0x00, 0x23, 0x80];
  const frames = Math.min(4000, Math.floor((seconds * 48000) / 1024)),
    length = 8 + frames * frame.length,
    low = pts % 2 ** 30;
  const pes = new Uint8Array(6 + length);
  pes.set([
    0,
    0,
    1,
    0xc0,
    length >> 8,
    length & 255,
    0x80,
    0x80,
    5,
    0x21 | (Math.floor(pts / 2 ** 30) << 1),
    (low >>> 22) & 255,
    ((low >>> 14) & 0xfe) | 1,
    (low >>> 7) & 255,
    ((low << 1) & 0xfe) | 1,
  ]);
  for (let i = 0; i < frames; i++) pes.set(frame, 14 + i * frame.length);
  const count = Math.ceil(pes.length / 184),
    packets = new Uint8Array(count * 188);
  for (let i = 0; i < count; i++) {
    const at = i * 188,
      chunk = pes.subarray(i * 184, i * 184 + 184),
      spare = 184 - chunk.length;
    packets.set([0x47, (i ? 0 : 64) | (pid >> 8), pid & 255, (spare ? 0x30 : 0x10) | (i & 15)], at);
    if (spare) {
      packets[at + 4] = spare - 1;
      if (spare > 1) (packets.fill(0xff, at + 5, at + 4 + spare), (packets[at + 5] = 0));
    }
    packets.set(chunk, at + 4 + spare);
  }
  return packets;
}
// A film whose audio starts late has opening segments that declare audio but hold
// none, and the player then builds no audio track for the audio that follows. Silence
// fills them up to the first audio. Later segments stream untouched.
// A cache lets a stream load out of sight while another plays: recording keeps each
// finished segment by number, and the real player then reads them from memory.
function silentAudioLoader(cache) {
  let audioFrom = Infinity;
  const keep = (frag, data) => {
    if (!cache?.recording || cache.segments.has(frag.sn) || cache.bytes + data.byteLength > CACHE_BYTES) return;
    // hls.js hands each segment to its worker, which empties the original buffer.
    cache.segments.set(frag.sn, data.slice(0));
    cache.bytes += data.byteLength;
    cache.windows?.set(frag.sn, { start: frag.start, end: frag.start + frag.duration });
  };
  return class {
    constructor(config) {
      this.loader = new config.loader(config);
    }
    get stats() {
      return this.loader.stats;
    }
    get context() {
      return this.loader.context;
    }
    abort() {
      this.loader.abort();
    }
    destroy() {
      this.loader.destroy();
    }
    getCacheAge() {
      return this.loader.getCacheAge?.() ?? null;
    }
    getResponseHeader(name) {
      return this.loader.getResponseHeader?.(name) ?? null;
    }
    load(context, config, callbacks) {
      const frag = context.frag,
        saved = frag?.type === 'main' ? cache?.segments.get(frag.sn) : undefined;
      if (saved) {
        cache.segments.delete(frag.sn);
        cache.bytes -= saved.byteLength;
        cache.windows?.delete(frag.sn);
        const stats = this.loader.stats,
          now = performance.now();
        stats.loading.start = stats.loading.first = stats.loading.end = now;
        stats.loaded = stats.total = saved.byteLength;
        queueMicrotask(() => {
          callbacks.onProgress?.(stats, context, saved, null);
          callbacks.onSuccess({ url: context.url, data: saved }, stats, context, null);
        });
        return;
      }
      if (!frag || frag.sn === 'initSegment' || frag.type !== 'main' || (frag.start >= audioFrom && !cache?.recording))
        return this.loader.load(context, config, callbacks);
      const chunks = [];
      this.loader.load(context, config, {
        ...callbacks,
        onProgress: (stats, loaded, data) => {
          chunks.push(new Uint8Array(data));
        },
        onSuccess: (response, stats, loaded, details) => {
          const parts = chunks.length ? chunks : [new Uint8Array(response.data)];
          const bytes = join(parts),
            found = transportAudio(bytes),
            hasAudio = found?.audioAt !== undefined;
          if (hasAudio) audioFrom = Math.min(audioFrom, frag.start);
          // A segment runs slightly past its listed length; the player trims any overlap.
          const missing = hasAudio ? (found.audioPts - found.pts) / 90000 : frag.duration + 0.05;
          const silence =
            found?.audioPid !== undefined && found.pts !== undefined && missing > 0.05
              ? silentAudioPackets(found.audioPid, found.pts, missing)
              : undefined;
          const at = found?.audioAt ?? bytes.length,
            data = silence ? join([bytes.subarray(0, at), silence, bytes.subarray(at)]).buffer : bytes.buffer;
          keep(frag, data);
          callbacks.onProgress?.(stats, loaded, data, details);
          callbacks.onSuccess({ ...response, data }, stats, loaded, details);
        },
      });
    }
  };
}
const CACHE_BYTES = 96 * 1024 * 1024;
function join(parts) {
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    joined.set(part, at);
    at += part.length;
  }
  return joined;
}
function hlsConfig(bitrateKbps, direct = false, cache) {
  // Establish transport timestamps from the first segment before any seek.
  const config = {
    enableWorker: true,
    startPosition: 0,
    maxLiveSyncPlaybackRate: 1,
    maxBufferLength: 30,
    maxMaxBufferLength: 180,
    backBufferLength: 30,
    maxBufferSize: BUFFER.hlsMaxBytes || 256 * 1024 * 1024,
    fLoader: silentAudioLoader(cache),
  };
  if (direct) {
    // A failed optional direct playlist or segment should refresh or fall back,
    // rather than spend the normal HLS retry budget on a stale or unreachable session.
    for (const policy of ['manifestLoadPolicy', 'playlistLoadPolicy', 'fragLoadPolicy'])
      config[policy] = {
        default: {
          maxTimeToFirstByteMs: 5000,
          maxLoadTimeMs: 8000,
          timeoutRetry: null,
          errorRetry: null,
        },
      };
  }
  return config;
}
function directHlsUrl(value, plan) {
  const url = new URL(value),
    origin = new URL(plan.origin);
  if (
    origin.protocol !== 'https:' ||
    origin.origin !== plan.origin ||
    url.origin !== origin.origin ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-f0-9-]{36}$/.test(plan.session) ||
    !url.pathname.startsWith('/video/:/transcode/universal/session/' + plan.session + '/')
  )
    throw new Error('Unexpected direct Plex HLS resource');
  // Session resource paths identify this output. Do not forward arbitrary
  // playlist query parameters, which could contain a permanent credential.
  url.search = '';
  url.searchParams.set('X-Plex-Token', plan.token);
  url.searchParams.set('X-Plex-Client-Identifier', plan.session);
  url.searchParams.set('X-Plex-Session-Identifier', plan.session);
  return url.href;
}
function chunkWindow(position, duration) {
  const current = Math.max(0, Math.min(position, Math.max(0, duration - 0.05)));
  return {
    first: Math.max(0, Math.floor((current - BUFFER.behind) / BUFFER.chunkSeconds)),
    last: Math.min(
      Math.ceil(duration / BUFFER.chunkSeconds) - 1,
      Math.floor((current + BUFFER.ahead) / BUFFER.chunkSeconds),
    ),
  };
}
function ranges(buffered, duration) {
  if (!(duration > 0) || !Number.isFinite(duration)) return [];
  const result = [];
  for (let i = 0; i < buffered.length; i++) {
    const start = Math.max(0, buffered.start(i)),
      end = Math.min(duration, buffered.end(i));
    if (Number.isFinite(start) && Number.isFinite(end) && end > start) result.push([start, end]);
  }
  return result;
}
const timingApi = () => uburoomTiming;
function bufferedAhead(buffered, position) {
  return timingApi().bufferedAhead(buffered, position);
}
function readinessBuffered(buffered, position, duration) {
  return timingApi().readinessBuffered(buffered, position, duration);
}
function timeline(buffered, duration, position, chapters) {
  if (!(duration > 0) || !Number.isFinite(duration)) return 'var(--border)';
  const percent = value => Math.min(100, Math.max(0, (value * 100) / duration)).toFixed(3) + '%';
  const stops = ['var(--border) 0%'];
  for (const [start, end] of ranges(buffered, duration))
    stops.push(
      `var(--border) ${percent(start)},var(--muted) ${percent(start)},var(--muted) ${percent(end)},var(--border) ${percent(end)}`,
    );
  stops.push('var(--border) 100%');
  const progress = percent(Number.isFinite(position) ? position : 0);
  const notchStops = [];
  if (Array.isArray(chapters)) {
    for (const ch of chapters) {
      if (Number.isFinite(ch.startTime) && ch.startTime > 0 && ch.startTime < duration) {
        const pct = ((ch.startTime * 100) / duration).toFixed(3);
        notchStops.push(
          `transparent calc(${pct}% - 1px),#101217 calc(${pct}% - 1px),#101217 calc(${pct}% + 1px),transparent calc(${pct}% + 1px)`,
        );
      }
    }
  }
  const notchLayer = notchStops.length
    ? `linear-gradient(to right,transparent 0%,${notchStops.join(',')},transparent 100%),`
    : '';
  return `${notchLayer}linear-gradient(to right,var(--primary) 0%,var(--primary) ${progress},transparent ${progress},transparent 100%),linear-gradient(to right,${stops.join(',')})`;
}
function supportsHdrDisplay(
  matchMedia = typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia.bind(globalThis) : null,
) {
  if (typeof matchMedia !== 'function') return false;
  try {
    return Boolean(matchMedia('(video-dynamic-range: high)')?.matches || matchMedia('(dynamic-range: high)')?.matches);
  } catch {
    return false;
  }
}
function needsVideoConversion(source, canPlayType, matchMedia) {
  // Positive answers remain only hints. Only an explicit negative for every
  // representative family probe rules out an initial HEVC direct-play trial.
  // Test Main/Main10 and both sample entries: bare `hvc1` alone is insufficient.
  if (!source || typeof canPlayType !== 'function') return false;
  try {
    if (source.hdrKind === 'dovi-p5') {
      if (!supportsHdrDisplay(matchMedia)) return true;
      const dovi = ['dvh1.05.06', 'dvhe.05.06'];
      if (dovi.every(codec => canPlayType(`video/mp4; codecs="${codec}"`) === '')) return true;
    } else if (source.hdr) {
      if (!supportsHdrDisplay(matchMedia)) return true;
    }
    if (/^(hevc|h265|hvc1|hev1)$/i.test(source.videoCodec || '')) {
      const codecs =
        source.hdr || Number(source.bitDepth) >= 10
          ? ['hvc1.2.4.L153.B0', 'hev1.2.4.L153.B0']
          : ['hvc1.1.6.L93.B0', 'hev1.1.6.L93.B0', 'hvc1.2.4.L153.B0', 'hev1.2.4.L153.B0'];
      if (codecs.every(codec => canPlayType(`video/mp4; codecs="${codec}"`) === '')) return true;
    }
  } catch {
    /* Unknown capability keeps the normal observed-playback path. */
  }
  return false;
}
function needsAudioConversion(source, canPlayType) {
  if (!source || typeof canPlayType !== 'function') return false;
  try {
    const codec = typeof source === 'string' ? source : source.audioCodec;
    const audio = { aac: 'mp4a.40.2', ac3: 'ac-3', eac3: 'ec-3', dca: 'dtsc', dts: 'dtsc', truehd: 'mlpa' }[
      String(codec || '').toLowerCase()
    ];
    if (audio && canPlayType(`audio/mp4; codecs="${audio}"`) === '') return true;
  } catch {
    /* Unknown capability keeps the normal observed-playback path. */
  }
  return false;
}
function needsCompatible(source, canPlayType, matchMedia) {
  return needsVideoConversion(source, canPlayType, matchMedia) || needsAudioConversion(source, canPlayType);
}
function observationClock() {
  return timingApi().observationClock();
}
function observationFrames(video, callbacks) {
  // Never switch to a different counter when the chosen one stops. Hidden
  // video may advance its media clock/native counters without presentation.
  if (typeof video.requestVideoFrameCallback === 'function') return callbacks;
  const quality = video.getVideoPlaybackQuality?.();
  return quality ? quality.totalVideoFrames - quality.droppedVideoFrames : 0;
}
function hlsErrorDetail(data, details) {
  const error = data.error || data.err;
  if (error?.name === 'QuotaExceededError' || error?.code === 22) return 'quota-exceeded';
  if (details.BUFFER_FULL_ERROR && data.details === details.BUFFER_FULL_ERROR) return 'buffer-full';
  if (details.BUFFER_APPEND_ERROR && data.details === details.BUFFER_APPEND_ERROR) return 'buffer-append';
  if (details.MEDIA_SOURCE_REQUIRES_RESET && data.details === details.MEDIA_SOURCE_REQUIRES_RESET) return 'reset';
  return /^frag/.test(data.details) ? 'fragment' : /^manifest/.test(data.details) ? 'manifest' : 'other';
}
async function decodingCapability(configuration, capabilities, timeoutMs = 2000) {
  if (typeof capabilities?.decodingInfo !== 'function') return { capabilityStatus: 'unavailable' };
  const video = configuration?.video;
  // Bare codec families, guessed frame rates and requested quality ceilings
  // cannot describe the actual output. Missing metadata is inconclusive.
  if (
    !['file', 'media-source'].includes(configuration?.type) ||
    !video ||
    !/^video\/mp4; codecs="avc[13]\.[a-f0-9]{6}"$/i.test(video.contentType || '') ||
    !['width', 'height', 'bitrate', 'framerate'].every(key => Number.isFinite(video[key]) && video[key] > 0)
  )
    return { capabilityStatus: 'incomplete' };
  let timer;
  try {
    const info = await Promise.race([
      capabilities.decodingInfo(configuration),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Capability query timed out')), timeoutMs);
      }),
    ]);
    if (![info?.supported, info?.smooth, info?.powerEfficient].every(value => typeof value === 'boolean'))
      return { capabilityStatus: 'incomplete' };
    return {
      capabilityStatus: 'reported',
      capabilitySupported: info.supported,
      capabilitySmooth: info.smooth,
      capabilityPowerEfficient: info.powerEfficient,
    };
  } catch {
    return { capabilityStatus: 'error' };
  } finally {
    clearTimeout(timer);
  }
}
function choppinessDetector({
  threshold = 0.1,
  windowMs = 10000,
  minFrames = 50,
  maxStallMs = 1500,
  maxStallCount = 2,
  minMultiStallMs = 1000,
  settleMs = 2500,
  severeWindowMs = 2000,
  severeMinFrames = 20,
  severeMinDropped = 6,
  severeThreshold = 0.08,
  severeWindows = 2,
  maxSampleGapMs = 1500,
  healthyRearmMs = 10000,
} = {}) {
  let samples = [],
    stallHistory = [],
    currentStallStart,
    playingStartedAt,
    lastUpdateAt,
    previousQuality;
  let shortStart,
    badWindows = 0,
    severeDropChoppy = false,
    severeRatio = 0,
    severeTotal = 0,
    severeDropped = 0;
  let cooldownUntil = 0,
    deliberatelyDismissed = false,
    episodeActive = false,
    healthyMs = 0;
  function clearDrops() {
    samples = [];
    shortStart = undefined;
    previousQuality = undefined;
    badWindows = 0;
    severeDropChoppy = false;
    severeRatio = severeTotal = severeDropped = 0;
  }
  function reset() {
    interrupt();
    cooldownUntil = 0;
    deliberatelyDismissed = false;
    episodeActive = false;
  }
  function interrupt() {
    clearDrops();
    stallHistory = [];
    currentStallStart = undefined;
    playingStartedAt = lastUpdateAt = undefined;
    healthyMs = 0;
  }
  function triggerCooldown(cooldownMs = 10000, now = performance.now()) {
    cooldownUntil = now + cooldownMs;
    interrupt();
  }
  function dismiss(deliberate = false) {
    if (deliberate) deliberatelyDismissed = true;
    interrupt();
  }
  function buffering() {
    clearDrops();
    healthyMs = 0;
  }
  function update(
    now,
    quality,
    { paused = false, seeking = false, waiting = false, visible = true, active = true } = {},
  ) {
    if (deliberatelyDismissed) return { choppy: false, dismissed: true };
    if (now < cooldownUntil) return { choppy: false, inCooldown: true };
    const userInterrupted = paused || seeking || !visible || !active;
    if (userInterrupted) {
      interrupt();
      return { choppy: false, interrupted: true };
    }
    // A suspended event loop or counter discontinuity cannot supply evidence
    // for the unobserved interval (including a waiting timer).
    const hasQuality =
      quality &&
      Number.isFinite(quality.totalVideoFrames) &&
      Number.isFinite(quality.droppedVideoFrames) &&
      quality.totalVideoFrames >= 0 &&
      quality.droppedVideoFrames >= 0 &&
      quality.droppedVideoFrames <= quality.totalVideoFrames;
    const sampleGapMs = lastUpdateAt === undefined ? 0 : now - lastUpdateAt;
    if (
      sampleGapMs < 0 ||
      sampleGapMs > maxSampleGapMs ||
      (previousQuality &&
        hasQuality &&
        (quality.totalVideoFrames < previousQuality.total ||
          quality.droppedVideoFrames < previousQuality.dropped ||
          quality.droppedVideoFrames - previousQuality.dropped > quality.totalVideoFrames - previousQuality.total))
    )
      interrupt();
    lastUpdateAt = now;
    if (!waiting && playingStartedAt === undefined) playingStartedAt = now;
    const isSettled = playingStartedAt !== undefined && now - playingStartedAt >= settleMs;
    if (waiting) {
      clearDrops();
      healthyMs = 0;
      if (playingStartedAt === undefined) return { choppy: false, warming: true, isSettled: false };
      if (currentStallStart === undefined) currentStallStart = now;
    } else {
      if (currentStallStart !== undefined) {
        stallHistory.push({ start: currentStallStart, end: now });
        currentStallStart = undefined;
      }
    }
    const cutoff = now - windowMs;
    while (stallHistory.length && stallHistory[0].end <= cutoff) stallHistory.shift();
    let totalStallMs = 0,
      stallCount = 0;
    for (const s of stallHistory) {
      const sStart = Math.max(cutoff, s.start),
        sEnd = Math.min(now, s.end);
      if (sEnd > sStart) {
        totalStallMs += sEnd - sStart;
        stallCount++;
      }
    }
    if (currentStallStart !== undefined) {
      const cStart = Math.max(cutoff, currentStallStart);
      if (now > cStart) {
        totalStallMs += now - cStart;
        stallCount++;
      }
    }
    const stallChoppy =
      isSettled && (totalStallMs >= maxStallMs || (stallCount >= maxStallCount && totalStallMs >= minMultiStallMs));
    let dropChoppy = false,
      deltaTotal = 0,
      deltaDropped = 0,
      ratio = 0,
      minFramesRequired = undefined;
    let rearmed = false;
    if (hasQuality && !waiting) {
      const total = quality.totalVideoFrames,
        dropped = quality.droppedVideoFrames;
      previousQuality = { total, dropped };
      samples.push({ time: now, total, dropped });
      while (samples.length > 1 && samples[1].time <= cutoff) samples.shift();
      const oldest = samples[0];
      const durationMs = now - oldest.time;
      if (durationMs >= windowMs) {
        deltaTotal = total - oldest.total;
        deltaDropped = dropped - oldest.dropped;
        if (deltaTotal < minFrames) {
          minFramesRequired = minFrames;
        } else {
          ratio = deltaTotal > 0 ? deltaDropped / deltaTotal : 0;
          dropChoppy = ratio >= threshold;
        }
      }
      if (isSettled) {
        shortStart ??= { time: now, total, dropped };
        const elapsed = now - shortStart.time;
        if (elapsed >= severeWindowMs) {
          severeTotal = total - shortStart.total;
          severeDropped = dropped - shortStart.dropped;
          severeRatio = severeTotal > 0 ? severeDropped / severeTotal : 0;
          const enoughFrames = severeTotal >= severeMinFrames;
          const bad = enoughFrames && severeDropped >= severeMinDropped && severeRatio >= severeThreshold;
          badWindows = bad ? badWindows + 1 : 0;
          severeDropChoppy = badWindows >= severeWindows;
          // Completed non-overlapping windows only: absent counters, low frame
          // counts, waiting and interruptions never count as healthy playback.
          healthyMs =
            enoughFrames && severeRatio < severeThreshold && currentStallStart === undefined ? healthyMs + elapsed : 0;
          shortStart = { time: now, total, dropped };
          if (episodeActive && healthyMs >= healthyRearmMs) {
            episodeActive = false;
            healthyMs = 0;
            rearmed = true;
            samples = [{ time: now, total, dropped }];
            dropChoppy = false;
          }
        }
      }
    } else if (!waiting) {
      clearDrops();
      healthyMs = 0;
    }
    const oldestSample = samples[0];
    const durationMs = oldestSample ? now - oldestSample.time : isSettled ? windowMs : 0;
    const choppy = stallChoppy || dropChoppy || severeDropChoppy;
    const warning = choppy && !episodeActive;
    if (warning) {
      episodeActive = true;
      healthyMs = 0;
    }
    const warming = !isSettled || (!choppy && (!oldestSample || durationMs < windowMs));
    return {
      choppy,
      warning,
      rearmed,
      episodeActive,
      ratio,
      deltaTotal,
      deltaDropped,
      durationMs,
      minFramesRequired,
      totalStallMs,
      stallCount,
      stallChoppy,
      dropChoppy,
      severeDropChoppy,
      severeRatio,
      severeTotal,
      severeDropped,
      badWindows,
      sampleGapMs,
      healthyMs,
      warming,
      isSettled,
    };
  }
  return {
    update,
    reset,
    interrupt,
    buffering,
    triggerCooldown,
    dismiss,
    get isDismissed() {
      return deliberatelyDismissed;
    },
    inCooldown: now => now < cooldownUntil,
  };
}
// A rolling minute of playback health for hosts: stalls the viewer did not cause and
// dropped frames. Seeks, pauses, hidden pages and stream changes are not stalls.
function healthTracker({ windowMs = 60000, minFrames = 50 } = {}) {
  let stalls = [],
    stallStart,
    frames = [],
    sampledAt = 0;
  function closeStall(now) {
    if (stallStart !== undefined) {
      stalls.push({ start: stallStart, end: now });
      stallStart = undefined;
    }
  }
  function update(now, quality, { stalled = false, interrupted = false } = {}) {
    sampledAt = now;
    if (interrupted || !stalled) closeStall(now);
    else stallStart ??= now;
    const cutoff = now - windowMs;
    stalls = stalls.filter(stall => stall.end > cutoff);
    let stalledMs = 0;
    for (const stall of stalls) stalledMs += stall.end - Math.max(cutoff, stall.start);
    if (stallStart !== undefined) stalledMs += now - Math.max(cutoff, stallStart);
    const valid = quality && Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames);
    if (valid) {
      const last = frames.at(-1);
      if (last && (quality.totalVideoFrames < last.total || quality.droppedVideoFrames < last.dropped)) frames = [];
      if (!interrupted) frames.push({ at: now, total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames });
      else frames = [];
    }
    frames = frames.filter(sample => sample.at > cutoff);
    const first = frames[0],
      last = frames.at(-1),
      total = first && last ? last.total - first.total : 0;
    return {
      stalls: stalls.length + (stallStart === undefined ? 0 : 1),
      stalledSeconds: Math.min(60, Math.round(stalledMs / 100) / 10),
      droppedPercent:
        total >= minFrames ? Math.min(100, Math.round(((last.dropped - first.dropped) / total) * 1000) / 10) : 0,
    };
  }
  function reset() {
    stalls = [];
    stallStart = undefined;
    frames = [];
  }
  return {
    update,
    reset,
    currentStallSeconds: () => (stallStart === undefined ? 0 : Math.max(0, (sampledAt - stallStart) / 1000)),
  };
}
// Coarse browser and device names for host health cards, never the full user agent.
function clientKind(nav, activity = false) {
  const agent = String(nav?.userAgent || '');
  const browser = /Edg\//.test(agent)
    ? 'edge'
    : /Firefox\//.test(agent)
      ? 'firefox'
      : /Chrome\/|CriOS\//.test(agent)
        ? 'chrome'
        : /Safari\//.test(agent)
          ? 'safari'
          : 'other';
  const device = activity
    ? 'activity'
    : /SMART-TV|SmartTV|AFT[A-Z]|CrKey|Web0S|Tizen|BRAVIA/i.test(agent)
      ? 'tv'
      : /iPad|Tablet/.test(agent) || (/Macintosh/.test(agent) && nav?.maxTouchPoints > 1)
        ? 'tablet'
        : /Mobi|iPhone|Android/.test(agent)
          ? 'phone'
          : 'desktop';
  return { browser, device };
}
export {
  BUFFER,
  healthTracker,
  clientKind,
  LOCAL_CODECS,
  localFormat,
  fallbackCodecs,
  convertedOriginal,
  hlsConfig,
  hlsErrorDetail,
  decodingCapability,
  directHlsUrl,
  chunkWindow,
  ranges,
  bufferedAhead,
  readinessBuffered,
  timeline,
  supportsHdrDisplay,
  needsVideoConversion,
  needsAudioConversion,
  needsCompatible,
  observationClock,
  observationFrames,
  choppinessDetector,
};
