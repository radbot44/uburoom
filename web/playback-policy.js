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
    const config={enableWorker:true,startPosition:0,
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
  function bufferedAhead(buffered,position) {
    for (let i = 0; i < buffered.length; i++) if (position >= buffered.start(i) - .05 && position < buffered.end(i)) return buffered.end(i) - position;
    return 0;
  }
  function readinessBuffered(buffered,position,duration) {
    // Muxed audio/video may start a few frames after zero. Only tolerate this
    // bounded leading gap at the source origin, never holes elsewhere.
    const start = position === 0 && buffered.length && buffered.start(0) <= .25 ? Math.max(0,buffered.start(0)) : position;
    return bufferedAhead(buffered,start) >= Math.min(2,Math.max(0,duration-start));
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
  // Observation duration follows the monotonic clock, not Date.now() or a
  // freshly jittering poll offset. A server clock step starts a new boundary.
  // Slow polls cannot establish/rebase this clock or extend its freshness.
  function observationClock() {
    let epoch,anchor,lastPoll,revision=0;
    return {
      update(nextEpoch,serverNow,sent,received) {
        if(epoch!==nextEpoch){epoch=nextEpoch;anchor=undefined;lastPoll=undefined;revision++;}
        const rtt=received-sent;
        if(!Number.isFinite(serverNow)||!Number.isFinite(rtt)||rtt<0||rtt>1000)return revision;
        const predicted=anchor && anchor.wall+received-anchor.mono;
        if(!anchor || predicted<serverNow-250 || predicted>serverNow+rtt+250){
          anchor={wall:serverNow+rtt/2,mono:received};revision++;
        }
        lastPoll=received;return revision;
      },
      sample(mono) {return anchor && mono>=lastPoll && mono-lastPoll<=3000 ? anchor.wall+mono-anchor.mono : undefined;}
    };
  }
  function observationFrames(video,callbacks) {
    // Never switch to a different counter when the chosen one stops. Hidden
    // video may advance its media clock/native counters without presentation.
    if(typeof video.requestVideoFrameCallback==='function')return callbacks;
    const quality=video.getVideoPlaybackQuality?.();
    return quality ? quality.totalVideoFrames-quality.droppedVideoFrames : 0;
  }
  function choppinessDetector({ threshold = 0.10, windowMs = 10000, minFrames = 50, maxStallMs = 1500, maxStallCount = 2, minMultiStallMs = 1000, settleMs = 2500 } = {}) {
    let samples = [], stallHistory = [], currentStallStart = undefined, playingStartedAt = 0;
    let cooldownUntil = 0, deliberatelyDismissed = false;
    function reset() {
      samples = [];
      stallHistory = [];
      currentStallStart = undefined;
      playingStartedAt = 0;
      cooldownUntil = 0;
      deliberatelyDismissed = false;
    }
    function interrupt() {
      samples = [];
      stallHistory = [];
      currentStallStart = undefined;
      playingStartedAt = 0;
    }
    function triggerCooldown(cooldownMs = 10000, now = performance.now()) {
      cooldownUntil = now + cooldownMs;
      interrupt();
    }
    function dismiss(deliberate = false) {
      if (deliberate) deliberatelyDismissed = true;
      interrupt();
    }
    function update(now, quality, { paused = false, seeking = false, waiting = false, visible = true, active = true } = {}) {
      if (deliberatelyDismissed) return { choppy: false, dismissed: true };
      if (now < cooldownUntil) return { choppy: false, inCooldown: true };
      const userInterrupted = paused || seeking || !visible || !active;
      if (userInterrupted) {
        interrupt();
        return { choppy: false, interrupted: true };
      }
      const isSettled = playingStartedAt > 0 && (now - playingStartedAt >= settleMs);
      if (waiting) {
        if (!isSettled) {
          interrupt();
          return { choppy: false, interrupted: true, isSettled: false };
        }
        if (currentStallStart === undefined) currentStallStart = now;
      } else {
        if (playingStartedAt === 0) playingStartedAt = now;
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
      const hasQuality = quality && Number.isFinite(quality.totalVideoFrames) && Number.isFinite(quality.droppedVideoFrames);
      if (hasQuality && !waiting) {
        const total = quality.totalVideoFrames, dropped = quality.droppedVideoFrames;
        if (samples.length && (total < samples[samples.length - 1].total || dropped < samples[samples.length - 1].dropped)) samples = [];
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
      }
      const oldestSample = samples[0];
      const durationMs = oldestSample ? now - oldestSample.time : (isSettled ? windowMs : 0);
      const choppy = stallChoppy || dropChoppy;
      const warming = !isSettled || (!choppy && (!oldestSample || durationMs < windowMs));
      return { choppy, ratio, deltaTotal, deltaDropped, durationMs, minFramesRequired, totalStallMs, stallCount, stallChoppy, dropChoppy, warming, isSettled };
    }
    return {
      update, reset, interrupt, triggerCooldown, dismiss,
      get isDismissed() { return deliberatelyDismissed; },
      inCooldown: now => now < cooldownUntil
    };
  }
  const api = {BUFFER,LOCAL_CODECS,localFormat,fallbackCodecs,hlsConfig,directHlsUrl,chunkWindow,ranges,bufferedAhead,readinessBuffered,timeline,needsCompatible,observationClock,observationFrames,choppinessDetector};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomPlayback = api;
})(globalThis);
