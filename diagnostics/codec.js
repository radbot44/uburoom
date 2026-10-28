'use strict';
const $ = id => document.getElementById(id), video = $('test-video');
const embedded = parent !== window && typeof parent.uburoomCodecSample === 'function';
const sampleFetch = embedded ? (path, options) => parent.uburoomCodecSample(path, options) : fetch;
if (embedded) {
  $('back').textContent = 'Close tester';
  $('back').addEventListener('click',event => {event.preventDefault(); parent.uburoomCloseCodecTester();});
}
const samples = [
  { file:'sync-test.mp4', url:'/__diagnostics/media/sample.mp4', video:'H.264 High', codec:'avc1.640016', videoBitrate:388051 },
  { file:'h264-baseline.mp4', video:'H.264 Constrained Baseline', codec:'avc1.42C01F', videoBitrate:404350 },
  { file:'h264-main.mp4', video:'H.264 Main', codec:'avc1.4D401F', videoBitrate:374170 },
  { file:'vp8.webm', video:'VP8', codec:'vp8' },
  { file:'vp9.webm', video:'VP9 Profile 0', codec:'vp09.00.21.08' },
  { file:'av1.webm', video:'AV1 Main', codec:'av01.0.01M.08' },
  { file:'hevc.mp4', video:'HEVC Main', codec:'hvc1.1.6.L93.90', videoBitrate:322281 }
].map(sample => ({ width:640, height:360, framerate:12, pixelFormat:'yuv420p', videoBitrate:null,
  audio:sample.file.endsWith('.webm') ? 'Opus' : 'AAC LC', audioCodec:sample.file.endsWith('.webm') ? 'opus' : 'mp4a.40.2',
  container:sample.file.endsWith('.webm') ? 'video/webm' : 'video/mp4', sampleRate:48000, channels:1,
  url:'/__diagnostics/media/' + sample.file, ...sample }));
let fixture = samples[0], started = performance.now(), loadId = 0, accelerationReported = $('acceleration').value;
const events = [], savedResults = new Map();
let objectUrl;
for (const [index, sample] of samples.entries()) {
  const option = document.createElement('option'); option.value = index; option.textContent = sample.video; $('codec').append(option);
}
let capabilities = 'Checking…', presentedCallbacks = 0, frameCallback, lastMediaError = null, playAttempt = null, copied = false;
let fixtureHttp = 'Checking…';
const finite = value => Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
const mediaError = () => video.error ? { code:video.error.code, message:video.error.message } : null;
const ranges = values => Array.from({length:values.length}, (_, i) => [finite(values.start(i)), finite(values.end(i))]);
function report() {
  const quality = video.getVideoPlaybackQuality?.();
  return {
    capturedAt:new Date().toISOString(),
    environment:{ userAgent:navigator.userAgent, secureContext:isSecureContext,
      hardwareAccelerationReported:accelerationReported, embedded, discordActivity:embedded && new URL(parent.location.href).searchParams.has('frame_id'), mediaSource:typeof MediaSource !== 'undefined', webCodecs:typeof VideoDecoder !== 'undefined' },
    fixture, fixtureHttp,
    playback:{ currentTime:finite(video.currentTime), duration:finite(video.duration), width:video.videoWidth, height:video.videoHeight,
      paused:video.paused, ended:video.ended, seeking:video.seeking, muted:video.muted, volume:video.volume,
      readyState:video.readyState, networkState:video.networkState, buffered:ranges(video.buffered), seekable:ranges(video.seekable),
      totalVideoFrames:quality?.totalVideoFrames ?? null, droppedVideoFrames:quality?.droppedVideoFrames ?? null,
      requestVideoFrameCallbacks:video.requestVideoFrameCallback ? presentedCallbacks : 'unavailable',
      error:mediaError(), lastMediaError, playAttempt, observed:$('observed').value },
    capabilities, events:[...events], previousTests:[...savedResults.entries()].filter(([key]) => key !== resultKey()).map(([, value]) => value)
  };
}
function refresh() { if (!copied && document.activeElement !== $('diagnostics')) $('diagnostics').value = JSON.stringify(report(), null, 2); }
function record(name) {
  events.push({ event:name, elapsedMs:Math.round(performance.now() - started), time:finite(video.currentTime), readyState:video.readyState });
  if (events.length > 40) events.shift();
  if (name === 'error') { lastMediaError = mediaError(); $('play-status').textContent = 'Media error ' + lastMediaError?.code + ': ' + lastMediaError?.message; }
  else if (name === 'playing') $('play-status').textContent = 'Playback started. Check whether you can see the picture and hear the sound.';
  refresh();
}
for (const event of ['loadstart','loadedmetadata','loadeddata','canplay','play','playing','pause','waiting','stalled','seeking','seeked','ended','error','abort','emptied']) {
  video.addEventListener(event, () => record(event));
}
function watchFrames() {
  if (video.requestVideoFrameCallback) frameCallback = video.requestVideoFrameCallback(() => { presentedCallbacks++; watchFrames(); });
}
async function play() {
  const attemptLoad = loadId;
  copied = false; playAttempt = { status:'pending' };
  if (video.ended) video.currentTime = 0;
  try { await video.play(); if (attemptLoad === loadId) playAttempt = { status:'resolved' }; }
  catch (error) { if (attemptLoad === loadId) { playAttempt = { status:'rejected', name:error.name, message:error.message }; $('play-status').textContent = error.name + ': ' + error.message; } }
  refresh();
}
$('play').addEventListener('click', play);
function resultKey() { return fixture.file + ':' + accelerationReported; }
function saveResult() {
  if (!playAttempt && !lastMediaError && !presentedCallbacks) return;
  const {previousTests, ...snapshot} = report(); savedResults.set(resultKey(), snapshot);
}
function loadSample() {
  loadId++; const thisLoad = loadId;
  copied = false; video.pause(); video.removeAttribute('src'); video.load();
  if (objectUrl) {URL.revokeObjectURL(objectUrl); objectUrl = undefined;}
  if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
  events.length = 0; started = performance.now(); presentedCallbacks = 0; lastMediaError = playAttempt = null;
  fixture = samples[Number($('codec').value)]; fixtureHttp = 'Checking…'; $('observed').value = 'not checked';
  $('sample-description').textContent = `${fixture.file} · ${fixture.video} · 640 × 360 · ${fixture.audio} audio · native video player`;
  if (!embedded) video.src = fixture.url;
  $('play').disabled = embedded; watchFrames(); $('play-status').textContent = 'Press Play to test ' + fixture.video + '.';
  $('copy-status').textContent = ''; refresh();
  sampleFetch(fixture.url, {method:embedded?'GET':'HEAD', signal:AbortSignal.timeout(8000)}).then(async response => {
    if (thisLoad !== loadId) return;
    fixtureHttp = { status:response.status, contentType:response.headers.get('content-type'), contentLength:response.headers.get('content-length'), acceptRanges:response.headers.get('accept-ranges') }; refresh();
    if (!response.ok) throw new Error('Test sample unavailable (HTTP ' + response.status + '). Check Admin mode.');
    if (embedded) {
      const blob = await response.blob(); if (thisLoad !== loadId) return;
      objectUrl = URL.createObjectURL(blob); video.src = objectUrl; $('play').disabled = false;
    }
  }).catch(error => { if (thisLoad === loadId) { fixtureHttp = error.name + ': ' + error.message; $('play-status').textContent = fixtureHttp; refresh(); } });
}
$('reset').addEventListener('click', loadSample);
$('codec').addEventListener('change', () => { saveResult(); loadSample(); });
$('observed').addEventListener('change', () => { copied = false; refresh(); });
$('acceleration').addEventListener('change', () => {
  saveResult(); accelerationReported = $('acceleration').value; copied = false; refresh();
});
$('copy').addEventListener('click', async () => {
  // Freeze the exact snapshot so manual selection also copies stable results.
  saveResult(); copied = true; $('diagnostics').value = JSON.stringify(report(), null, 2);
  try { await navigator.clipboard.writeText($('diagnostics').value); $('copy-status').textContent = 'Copied. Paste these results along with whether picture and sound play.'; }
  catch { $('diagnostics').focus(); $('diagnostics').select(); $('copy-status').textContent = 'Diagnostics selected. Press Ctrl+C (or use your device’s Copy command).'; }
});
async function checkCapabilities() {
  const results = [];
  for (const sample of samples) {
    const {video:name, codec, container} = sample;
    const mime = `${container}; codecs="${codec}"`;
    const dimensions = { width:sample.width, height:sample.height, bitrate:sample.videoBitrate ?? 500000, framerate:sample.framerate };
    const result = { name, codec, probe:dimensions, html:video.canPlayType(mime) || 'no', mse:typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime) };
    if (navigator.mediaCapabilities) {
      try {
        const info = await navigator.mediaCapabilities.decodingInfo({ type:'file',
          video:{ contentType:mime, ...dimensions } });
        Object.assign(result, { mediaCapabilities:info.supported, smooth:info.smooth, powerEfficient:info.powerEfficient });
      } catch (error) { result.mediaCapabilities = error.name + ': ' + error.message; }
    } else result.mediaCapabilities = 'unavailable';
    if (typeof VideoDecoder !== 'undefined') {
      try { result.preferSoftwareSupported = (await VideoDecoder.isConfigSupported({ codec, codedWidth:dimensions.width, codedHeight:dimensions.height, hardwareAcceleration:'prefer-software' })).supported; }
      catch (error) { result.preferSoftwareSupported = error.name + ': ' + error.message; }
    } else result.preferSoftwareSupported = 'unavailable';
    results.push(result);
  }
  capabilities = results; refresh();
}
loadSample();
setInterval(refresh, 500);
void checkCapabilities();
