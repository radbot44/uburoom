/* Shared browser/server playback limits. No credentials, DOM or network calls. */
(function (root) {
  'use strict';
  const BUFFER = Object.freeze({ahead:60,behind:30,maxBytes:64 * 1024 * 1024,hlsMaxBytes:256 * 1024 * 1024,chunkSeconds:6});
  const LOCAL_CODECS = Object.freeze({av1:'video/webm; codecs="av01.0.12M.08"',vp9:'video/webm; codecs="vp9"',vp8:'video/webm; codecs="vp8"'});
  const localFormat = value => Object.hasOwn(LOCAL_CODECS,value);
  function fallbackCodecs(allowed, attempted, supports) {
    return [...new Set(allowed)].filter(codec=>localFormat(codec) && !attempted.has(codec) && supports(LOCAL_CODECS[codec]));
  }
  function hlsConfig(bitrateKbps,direct=false) {
    // Establish transport timestamps from the first segment before any seek.
    const config={enableWorker:true,startPosition:0,maxLiveSyncPlaybackRate:1,
      maxBufferLength:30,maxMaxBufferLength:180,backBufferLength:30,maxBufferSize:BUFFER.hlsMaxBytes || (256 * 1024 * 1024)};
    if(direct) {
      // A failed optional direct playlist or segment should refresh or fall back,
      // rather than spend the normal HLS retry budget on a stale or unreachable session.
      for(const policy of ['manifestLoadPolicy','playlistLoadPolicy','fragLoadPolicy'])config[policy]={default:{
        maxTimeToFirstByteMs:5000,maxLoadTimeMs:8000,timeoutRetry:null,errorRetry:null}};
    }
    return config;
  }
  function directHlsUrl(value,plan) {
    const url=new URL(value),origin=new URL(plan.origin);
    if(origin.protocol!=='https:' || origin.origin!==plan.origin || url.origin!==origin.origin || url.username || url.password || url.hash ||
      !/^[a-f0-9-]{36}$/.test(plan.session) || !url.pathname.startsWith('/video/:/transcode/universal/session/'+plan.session+'/'))throw new Error('Unexpected direct Plex HLS resource');
    // Session resource paths identify this output. Do not forward arbitrary
    // playlist query parameters, which could contain a permanent credential.
    url.search='';
    url.searchParams.set('X-Plex-Token',plan.token);
    url.searchParams.set('X-Plex-Client-Identifier',plan.session);
    url.searchParams.set('X-Plex-Session-Identifier',plan.session);
    return url.href;
  }
  function chunkWindow(position,duration) {
    const current = Math.max(0,Math.min(position,Math.max(0,duration - .05)));
    return {first:Math.max(0,Math.floor((current - BUFFER.behind) / BUFFER.chunkSeconds)),
      last:Math.min(Math.ceil(duration / BUFFER.chunkSeconds)-1,Math.floor((current + BUFFER.ahead) / BUFFER.chunkSeconds))};
  }
  function ranges(buffered,duration) {
    if (!(duration > 0) || !Number.isFinite(duration)) return [];
    const result = [];
    for (let i = 0; i < buffered.length; i++) {
      const start = Math.max(0,buffered.start(i)), end = Math.min(duration,buffered.end(i));
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) result.push([start,end]);
    }
    return result;
  }
  const sharedTiming = typeof module !== 'undefined' && module.exports ? require('../shared/sync/timing.mjs') : undefined;
  const timingApi = () => sharedTiming || root.uburoomTiming;
  function bufferedAhead(buffered,position) {
    return timingApi().bufferedAhead(buffered,position);
  }
  function readinessBuffered(buffered,position,duration) {
    return timingApi().readinessBuffered(buffered,position,duration);
  }
  function timeline(buffered,duration,position) {
    if (!(duration > 0) || !Number.isFinite(duration)) return 'var(--border)';
    const percent = value => (Math.min(100,Math.max(0,value * 100 / duration))).toFixed(3) + '%';
    const stops = ['var(--border) 0%'];
    for (const [start,end] of ranges(buffered,duration)) stops.push(`var(--border) ${percent(start)},var(--muted) ${percent(start)},var(--muted) ${percent(end)},var(--border) ${percent(end)}`);
    stops.push('var(--border) 100%');
    const progress = percent(Number.isFinite(position) ? position : 0);
    return `linear-gradient(to right,var(--primary) 0%,var(--primary) ${progress},transparent ${progress},transparent 100%),linear-gradient(to right,${stops.join(',')})`;
  }
  function needsCompatible(source,canPlayType) {
    // Positive answers remain only hints. Only an explicit negative for every
    // representative family probe rules out an initial HEVC direct-play trial.
    // Test Main/Main10 and both sample entries: bare `hvc1` alone is insufficient.
    try {
      if (/^(hevc|h265|hvc1|hev1)$/i.test(source.videoCodec || '')) {
        const codecs = ['hvc1.1.6.L93.B0','hev1.1.6.L93.B0','hvc1.2.4.L153.B0','hev1.2.4.L153.B0'];
        if (codecs.every(codec => canPlayType(`video/mp4; codecs="${codec}"`) === '')) return true;
      }
      const audio = {aac:'mp4a.40.2',ac3:'ac-3',eac3:'ec-3',dca:'dtsc',dts:'dtsc',truehd:'mlpa'}[String(source.audioCodec || '').toLowerCase()];
      if (audio && canPlayType(`audio/mp4; codecs="${audio}"`) === '') return true;
    } catch { /* Unknown capability keeps the normal observed-playback path. */ }
    return false;
  }
  function observationClock() {
    return timingApi().observationClock();
  }
  function observationFrames(video,callbacks) {
    // Never switch to a different counter when the chosen one stops. Hidden
    // video may advance its media clock/native counters without presentation.
    if(typeof video.requestVideoFrameCallback==='function')return callbacks;
    const quality=video.getVideoPlaybackQuality?.();
    return quality ? quality.totalVideoFrames-quality.droppedVideoFrames : 0;
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
    if (typeof capabilities?.decodingInfo !== 'function') return {capabilityStatus:'unavailable'};
    const video = configuration?.video;
    // Bare codec families, guessed frame rates and requested quality ceilings
    // cannot describe the actual output. Missing metadata is inconclusive.
    if (!['file','media-source'].includes(configuration?.type) || !video ||
      !/^video\/mp4; codecs="avc[13]\.[a-f0-9]{6}"$/i.test(video.contentType || '') ||
      !['width','height','bitrate','framerate'].every(key => Number.isFinite(video[key]) && video[key] > 0)) return {capabilityStatus:'incomplete'};
    let timer;
    try {
      const info = await Promise.race([capabilities.decodingInfo(configuration),new Promise((resolve,reject) => {
        timer = setTimeout(() => reject(new Error('Capability query timed out')),timeoutMs);
      })]);
      if (![info?.supported,info?.smooth,info?.powerEfficient].every(value => typeof value === 'boolean')) return {capabilityStatus:'incomplete'};
      return {capabilityStatus:'reported',capabilitySupported:info.supported,capabilitySmooth:info.smooth,capabilityPowerEfficient:info.powerEfficient};
    } catch { return {capabilityStatus:'error'}; }
    finally { clearTimeout(timer); }
  }
  function choppinessDetector({ threshold = 0.10, windowMs = 10000, minFrames = 50, maxStallMs = 1500, maxStallCount = 2, minMultiStallMs = 1000, settleMs = 2500,
    severeWindowMs = 2000, severeMinFrames = 20, severeMinDropped = 6, severeThreshold = 0.08, severeWindows = 2, maxSampleGapMs = 1500, healthyRearmMs = 10000 } = {}) {
    let samples = [], stallHistory = [], currentStallStart, playingStartedAt, lastUpdateAt, previousQuality;
    let shortStart, badWindows = 0, severeDropChoppy = false, severeRatio = 0, severeTotal = 0, severeDropped = 0;
    let cooldownUntil = 0, deliberatelyDismissed = false, episodeActive = false, healthyMs = 0;
    function clearDrops() {
      samples = []; shortStart = undefined; previousQuality = undefined;
      badWindows = 0; severeDropChoppy = false; severeRatio = severeTotal = severeDropped = 0;
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
    function buffering() { clearDrops(); healthyMs = 0; }
    function update(now, quality, { paused = false, seeking = false, waiting = false, visible = true, active = true } = {}) {
      if (deliberatelyDismissed) return { choppy: false, dismissed: true };
      if (now < cooldownUntil) return { choppy: false, inCooldown: true };
      const userInterrupted = paused || seeking || !visible || !active;
      if (userInterrupted) {
        interrupt();
        return { choppy: false, interrupted: true };
      }
      // A suspended event loop or counter discontinuity cannot supply evidence
      // for the unobserved interval (including a waiting timer).
      const hasQuality = quality && Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames) &&
        quality.totalVideoFrames >= 0 && quality.droppedVideoFrames >= 0 && quality.droppedVideoFrames <= quality.totalVideoFrames;
      const sampleGapMs = lastUpdateAt === undefined ? 0 : now - lastUpdateAt;
      if (sampleGapMs < 0 || sampleGapMs > maxSampleGapMs || previousQuality && hasQuality &&
        (quality.totalVideoFrames < previousQuality.total || quality.droppedVideoFrames < previousQuality.dropped ||
        quality.droppedVideoFrames - previousQuality.dropped > quality.totalVideoFrames - previousQuality.total)) interrupt();
      lastUpdateAt = now;
      if (!waiting && playingStartedAt === undefined) playingStartedAt = now;
      const isSettled = playingStartedAt !== undefined && now - playingStartedAt >= settleMs;
      if (waiting) {
        clearDrops(); healthyMs = 0;
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
      let totalStallMs = 0, stallCount = 0;
      for (const s of stallHistory) {
        const sStart = Math.max(cutoff, s.start), sEnd = Math.min(now, s.end);
        if (sEnd > sStart) { totalStallMs += (sEnd - sStart); stallCount++; }
      }
      if (currentStallStart !== undefined) {
        const cStart = Math.max(cutoff, currentStallStart);
        if (now > cStart) { totalStallMs += (now - cStart); stallCount++; }
      }
      const stallChoppy = isSettled && (totalStallMs >= maxStallMs || (stallCount >= maxStallCount && totalStallMs >= minMultiStallMs));
      let dropChoppy = false, deltaTotal = 0, deltaDropped = 0, ratio = 0, minFramesRequired = undefined;
      let rearmed = false;
      if (hasQuality && !waiting) {
        const total = quality.totalVideoFrames, dropped = quality.droppedVideoFrames;
        previousQuality = {total,dropped};
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
          shortStart ??= {time:now,total,dropped};
          const elapsed = now - shortStart.time;
          if (elapsed >= severeWindowMs) {
            severeTotal = total - shortStart.total; severeDropped = dropped - shortStart.dropped;
            severeRatio = severeTotal > 0 ? severeDropped / severeTotal : 0;
            const enoughFrames = severeTotal >= severeMinFrames;
            const bad = enoughFrames && severeDropped >= severeMinDropped && severeRatio >= severeThreshold;
            badWindows = bad ? badWindows + 1 : 0;
            severeDropChoppy = badWindows >= severeWindows;
            // Completed non-overlapping windows only: absent counters, low frame
            // counts, waiting and interruptions never count as healthy playback.
            healthyMs = enoughFrames && severeRatio < severeThreshold && currentStallStart === undefined ? healthyMs + elapsed : 0;
            shortStart = {time:now,total,dropped};
            if (episodeActive && healthyMs >= healthyRearmMs) {
              episodeActive = false; healthyMs = 0; rearmed = true;
              samples = [{time:now,total,dropped}]; dropChoppy = false;
            }
          }
        }
      } else if (!waiting) {
        clearDrops(); healthyMs = 0;
      }
      const oldestSample = samples[0];
      const durationMs = oldestSample ? now - oldestSample.time : (isSettled ? windowMs : 0);
      const choppy = stallChoppy || dropChoppy || severeDropChoppy;
      const warning = choppy && !episodeActive;
      if (warning) { episodeActive = true; healthyMs = 0; }
      const warming = !isSettled || (!choppy && (!oldestSample || durationMs < windowMs));
      return { choppy, warning, rearmed, episodeActive, ratio, deltaTotal, deltaDropped, durationMs, minFramesRequired, totalStallMs, stallCount, stallChoppy, dropChoppy,
        severeDropChoppy, severeRatio, severeTotal, severeDropped, badWindows, sampleGapMs, healthyMs, warming, isSettled };
    }
    return {
      update, reset, interrupt, buffering, triggerCooldown, dismiss,
      get isDismissed() { return deliberatelyDismissed; },
      inCooldown: now => now < cooldownUntil
    };
  }
  const api = {BUFFER,LOCAL_CODECS,localFormat,fallbackCodecs,hlsConfig,hlsErrorDetail,decodingCapability,directHlsUrl,chunkWindow,ranges,bufferedAhead,readinessBuffered,timeline,needsCompatible,observationClock,observationFrames,choppinessDetector};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomPlayback = api;
})(globalThis);
