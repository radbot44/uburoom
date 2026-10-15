/* Shared browser/server playback limits. No credentials, DOM or network calls. */
(function (root) {
  'use strict';
  const BUFFER = Object.freeze({ahead:60,behind:30,maxBytes:64 * 1024 * 1024,chunkSeconds:6});
  function hlsConfig(bitrateKbps) {
    const rate = Number(bitrateKbps), seconds = rate > 0 && Number.isFinite(rate) ? BUFFER.maxBytes * 8 / (rate * 1000) : 90;
    const ahead = Math.min(BUFFER.ahead,Math.max(12,Math.floor(seconds * 2 / 3)));
    const behind = Math.min(BUFFER.behind,Math.max(0,Math.floor(seconds / 3)));
    return {enableWorker:true,maxBufferLength:ahead,maxMaxBufferLength:ahead,backBufferLength:behind,maxBufferSize:BUFFER.maxBytes};
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
  function timeline(buffered,duration,position) {
    if (!(duration > 0) || !Number.isFinite(duration)) return 'var(--border)';
    const percent = value => (Math.min(100,Math.max(0,value * 100 / duration))).toFixed(3) + '%';
    const stops = ['var(--border) 0%'];
    for (const [start,end] of ranges(buffered,duration)) stops.push(`var(--border) ${percent(start)},var(--muted) ${percent(start)},var(--muted) ${percent(end)},var(--border) ${percent(end)}`);
    stops.push('var(--border) 100%');
    const progress = percent(Number.isFinite(position) ? position : 0);
    return `linear-gradient(to right,var(--orange) 0%,var(--orange) ${progress},transparent ${progress},transparent 100%),linear-gradient(to right,${stops.join(',')})`;
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
  const api = {BUFFER,hlsConfig,chunkWindow,ranges,bufferedAhead,timeline,needsCompatible};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomPlayback = api;
})(globalThis);
