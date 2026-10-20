/* Shared browser/server playback limits. No credentials, DOM or network calls. */
(function (root) {
  'use strict';
  const BUFFER = Object.freeze({ahead:60,behind:30,maxBytes:64 * 1024 * 1024,hlsMaxBytes:256 * 1024 * 1024,chunkSeconds:6});
  const LOCAL_CODECS = Object.freeze({av1:'video/webm; codecs="av01.0.12M.08"',vp9:'video/webm; codecs="vp9"',vp8:'video/webm; codecs="vp8"'});
  const localFormat = value => Object.hasOwn(LOCAL_CODECS,value);
  function fallbackCodecs(allowed, attempted, supports) {
    return [...new Set(allowed)].filter(codec=>localFormat(codec) && !attempted.has(codec) && supports(LOCAL_CODECS[codec]));
  }
  function hlsConfig(bitrateKbps) {
    // Establish transport timestamps from the first segment before any seek.
    return {enableWorker:true,startPosition:0,
      maxBufferLength:30,maxMaxBufferLength:180,backBufferLength:30,maxBufferSize:BUFFER.hlsMaxBytes || (256 * 1024 * 1024)};
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
  const api = {BUFFER,LOCAL_CODECS,localFormat,fallbackCodecs,hlsConfig,chunkWindow,ranges,bufferedAhead,readinessBuffered,timeline,needsCompatible,observationClock,observationFrames};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomPlayback = api;
})(globalThis);
