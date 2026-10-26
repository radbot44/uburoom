'use strict';
const $ = id => document.getElementById(id);
let viewerId = crypto.randomUUID();
const params = new URLSearchParams(location.search);
let token, me, config, selected, state, receivedAt, offset = 0, pending = false, creating = false, transport;
let stateTransportSequence=0;
let reconnecting=false;
let disconnectGraceTimer, disconnectExtended = false;
const DISCONNECT_GRACE_MS = 8000;
let switchingRoom=false, knownRooms=[];
let pageBootstrap=JSON.parse($('watch-bootstrap')?.textContent||'null');
if(pageBootstrap?.me?.status===200)me=pageBootstrap.me.value;
let identityExpiresAt = 0, identityRenewAt = 0, identityRetryAt = 0, identityRenewal, identityGeneration = 0, identityTimer;
let hls, mediaVersion, mediaSource, lastFeedback, seekDragging = false, sdk;
let playbackError = '', autoplayBlocked = false, probing = false, readyVersion, readyPending = false, readyQueued = false, readinessSent, browseRoom, preferredQuality = '720p4';
let volumeWanted, volumeDraft, volumeTimer, lastVolumeAt = 0, volumeDragging = false, volumePending = false;
const playerPreferenceKey='uburoom.player';
let playerPreferences={volume:30,muted:false,quality:'720p4'};
try {
  const saved=JSON.parse(localStorage.getItem(playerPreferenceKey)||'null');
  if(saved && typeof saved==='object') {
    if(Number.isFinite(saved.volume) && saved.volume>=0 && saved.volume<=100)playerPreferences.volume=saved.volume;
    if(typeof saved.muted==='boolean')playerPreferences.muted=saved.muted;
    if(uburoom.validQuality(saved.quality))playerPreferences.quality=uburoom.qualityId(saved.quality);
    if(['auto','burn'].includes(saved.subtitleMode))playerPreferences.subtitleMode=saved.subtitleMode;
    if(['auto','off'].includes(saved.subtitles?.choice))playerPreferences.subtitles={choice:saved.subtitles.choice};
    else if(saved.subtitles?.choice==='language' && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(saved.subtitles.language || ''))playerPreferences.subtitles={choice:'language',language:saved.subtitles.language};
  }
} catch {}
preferredQuality=playerPreferences.quality;
let restoredPlayerSubtitles;
function rememberPlayerSubtitles(args) {
  if(args.subtitleMode)savePlayerPreferences({subtitleMode:args.subtitleMode});
  if(args.subtitleId===undefined)return;
  if(['auto','off'].includes(args.subtitleId))savePlayerPreferences({subtitles:{choice:args.subtitleId}});
  else {
    const track=state?.tracks?.subtitles.find(row=>row.id===args.subtitleId);
    if(track?.language && !['und','unknown'].includes(track.language))savePlayerPreferences({subtitles:{choice:'language',language:track.language}});
  }
}
async function restorePlayerSubtitles(next) {
  const key=next.id+':'+next.mediaVersion;
  if(restoredPlayerSubtitles===key || !next.tracks || !next.mediaUrl || pending || qualityPending || !playbackClock.read().valid)return;
  const saved=playerPreferences.subtitles, tracks=next.tracks, args={};
  const matches=tracks.subtitles.filter(row=>row.available && row.language===saved?.language);
  const match=matches.find(row=>row.id===tracks.subtitleId) || matches[0];
  const choice=saved?.choice==='language'?match?.id:saved?.choice;
  if(choice && choice!==tracks.subtitleChoice)args.subtitleId=choice;
  const mode=playerPreferences.subtitleMode;
  if(['auto','burn'].includes(mode) && mode!==tracks.subtitleMode)args.subtitleMode=mode;
  restoredPlayerSubtitles=key;
  if(!Object.keys(args).length)return;
  try {await execute({action:'media.tracks.set',args:{mediaVersion:next.mediaVersion,streamVersion:next.streamVersion,...args}});}
  catch(error){fail(error.message);}
}

function savePlayerPreferences(change) {
  Object.assign(playerPreferences,change);
  try {localStorage.setItem(playerPreferenceKey,JSON.stringify(playerPreferences));} catch {}
}
function viewerPreferences() {
  return {viewer:viewerId,quality:preferredQuality,volume:String(playerPreferences.volume),muted:String(playerPreferences.muted),
    ...(globalThis.uburoomSubtitleRenderers?.supported()?{subtitles:'browser'}:{})};
}

const activity = params.has('frame_id');
let theater = document.body.classList.contains('theater'), immersive = false, layoutMode, fallbackVersion, fallbackPending = false, fallbackRetryTimer, frameStartedAt, videoFrames = 0, frameCallback;
let hlsRecoveryTimer, hlsRecoveryCount = 0, hlsNetworkRetries = 0, hlsNetworkFailure, hlsNetworkInterrupted = false;
let hlsRefreshPending = false, hlsRefreshVersion, hlsRefreshTimes = [];
let av1, localFallbackVersion, localFallbackAttempts = new Set();
let directProbe, directStartupTimer, directStallTimer, directRecovery;
let observationPending = false, observationSequence = 0, observationBreak = 0, observing = false, playerWaiting = false;
const observationClock=uburoomPlayback.observationClock();
const playbackClock=uburoomTiming.clock(), presentationTiming=uburoomTiming.presentation();
const syncQuality=uburoomSyncQuality.create();
let syncQualityContext, syncQualityClockRevision, syncQualityBuffering=false, publishedSyncQualityStatus='unknown',
  publishedSyncQualityConfidence, publishedSyncQualityReason, lastSyncQualityPublishAt=0, syncQualitySettleUntil=0,lastQualityDiagnosticAt=0;
let lastPresentationSampleAt=0,lastPresentationErrorMs;
let sync;
let syncCorrectionMode='speed', syncPreferenceKey, syncPreferenceStored=true;
let qualityPending=false;
let observationClockRevision=0;
let lastPresentationBreak=performance.now(), stateRequestSequence=0;
let browserHandoff, browserHandoffTimer, browserVerification;
let trackNotice='', trackNoticeError=false, trackActionError='', trackContext, playerUI, subtitleErrorNotice;
const video = $('video');
function sendSyncQuality(status,score,confidence,reason,measurementFreshnessMs) {
  if (!selected || !state?.mediaVersion || !state?.streamVersion) return false;
  const value={roomId:selected,viewerId,mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,status,
    score:Number.isFinite(score)?Math.max(0,Math.min(1,score)):1,
    confidence:['confident','reduced','provisional'].includes(confidence)?confidence:'reduced',
    ...(Number.isFinite(measurementFreshnessMs)?{measurementFreshnessMs:Math.max(0,measurementFreshnessMs)}:{}),...(reason?{reason}:{})};
  const sent=transport?.syncQuality(value) || false;
  if(sent){publishedSyncQualityStatus=status;publishedSyncQualityConfidence=value.confidence;publishedSyncQualityReason=reason;lastSyncQualityPublishAt=Date.now();}
  return sent;
}
function resetSyncQuality() {
  const wasActive=publishedSyncQualityStatus==='playing'||publishedSyncQualityStatus==='buffering';
  syncQuality.reset(undefined,{preserveLast:true});syncQualityContext=syncQualityClockRevision=undefined;syncQualityBuffering=false;
  lastPresentationSampleAt=0;lastPresentationErrorMs=undefined;
  syncQualitySettleUntil=performance.now()+2000;
  if(wasActive)sendSyncQuality('stale',syncQuality.refresh({playbackStatus:'starting'}).score,'reduced','stream-changed');
}
function syncQualityClockUsable(timing) {
  return !!(timing?.valid && Number.isFinite(timing.clockAgeMs) && timing.clockAgeMs<=uburoomSyncQuality.MAX_CLOCK_AGE_MS &&
    Number.isFinite(timing.clockUncertaintyMs) && timing.clockUncertaintyMs<=uburoomSyncQuality.MAX_CLOCK_UNCERTAINTY_MS);
}
function syncQualityEligible(timing,{allowWaiting=false,forBuffer=false}={}) {
  const shared=state?.state;
  return !!(selected && state?.id===selected && state.mediaUrl && state.streamVersion && state.mediaVersion && mediaSource===state.mediaUrl &&
    shared && !shared.paused && !state.waitingForReady && !video.paused && !video.seeking && (!playerWaiting || allowWaiting) &&
    !probing && !playbackError && !video.error && !autoplayBlocked && readyVersion===state.mediaVersion && (forBuffer || video.readyState >= 3) &&
    document.visibilityState==='visible' && syncQualityClockUsable(timing)&&
    !(Number.isFinite(state.startAt) && timing.serverTime<state.startAt));
}
function syncQualityBufferEligible(timing,at=performance.now()) {
  return !!(state?.mediaUrl&&state.state&&!state.state.paused&&!state.waitingForReady&&!video.paused&&!video.ended&&!video.seeking&&
    !probing&&!playbackError&&!video.error&&!autoplayBlocked&&readyVersion===state.mediaVersion&&document.visibilityState==='visible'&&
    at-lastPresentationBreak>=2000&&at>=syncQualitySettleUntil&&!sync?.timelinePending&&
    (!Number.isFinite(state.startAt)||timing?.valid&&timing.serverTime>=state.startAt));
}
function sampleSyncQuality(timing,at) {
  const context=selected+':'+viewerId+':'+state?.mediaVersion+':'+state?.streamVersion;
  if(syncQualityContext!==context) {
    syncQuality.reset(context,{preserveLast:true});syncQualityContext=context;syncQualityClockRevision=timing.clockRevision;
    syncQualitySettleUntil=at+2000;
  } else if(syncQualityClockRevision!==timing.clockRevision) {
    syncQuality.breakSample(at);syncQualityClockRevision=timing.clockRevision;syncQualitySettleUntil=at+2000;
  }
  const eligible=syncQualityEligible(timing)&&at-lastPresentationBreak>=2000&&at>=syncQualitySettleUntil&&!sync?.timelinePending;
  const presentationFresh=Number.isFinite(lastPresentationErrorMs)&&at-lastPresentationSampleAt<=2500;
  let errorMs,source='position';
  if(presentationFresh){errorMs=lastPresentationErrorMs;source='presentation';}
  else if(eligible) {
    const target=uburoomTiming.target(state,timing.serverTime);
    if(Number.isFinite(target))errorMs=(video.currentTime-target)*1000;
  }
  syncQuality.sample({at,errorMs,playbackRate:video.playbackRate,eligible,source,context,clockRevision:timing.clockRevision});
}
function refreshSyncQuality() {
  const timing=playbackClock.read(),at=performance.now();
  const clockReliable=syncQualityClockUsable(timing);
  if(!clockReliable)syncQuality.breakSample(at);
  const isBuffering=playerWaiting||!video.paused&&video.readyState<3;
  const shouldCountBuffer=isBuffering&&syncQualityBufferEligible(timing,at);
  if(shouldCountBuffer&&!syncQualityBuffering)syncQualityBuffering=syncQuality.startBuffer({at,eligible:true});
  else if(!shouldCountBuffer&&syncQualityBuffering){syncQuality.endBuffer({at});syncQualityBuffering=false;}
  const playbackStatus=playbackError||video.error?'error':!state?.mediaUrl||state.waitingForReady||probing||readyVersion!==state?.mediaVersion?'starting':
    state.state.paused||video.paused||video.ended?'paused':video.seeking?'seeking':isBuffering?'buffering':'playing';
  sampleSyncQuality(timing,at);
  const result=syncQuality.refresh({at,
    clockValid:timing.valid,clockAgeMs:timing.clockAgeMs,clockUncertaintyMs:timing.clockUncertaintyMs,playbackStatus});
  const changed=result.status!==publishedSyncQualityStatus||result.confidence!==publishedSyncQualityConfidence||result.reason!==publishedSyncQualityReason;
  if(result.updated||changed||Date.now()-lastQualityDiagnosticAt>=10000) {
    diagnostics.record('sync-quality',{qualityStatus:result.status,qualityConfidence:result.confidence,qualityReason:result.reason,rawQualityScore:result.rawScore,
      smoothedQualityScore:result.lastScore,lastKnownQualityLevel:result.lastLevel,qualityMeasurementFreshnessMs:result.metrics?.measurementFreshnessMs,
      qualityMeasurementSource:result.metrics?.latestSource,qualitySampleCount:result.metrics?.sampleCount,
      measuredPlaybackSeconds:result.metrics?.measuredSeconds,outOfSync250Seconds:result.metrics?.outOfSync250Seconds,
      outOfSync500Seconds:result.metrics?.outOfSync500Seconds,automaticCorrectionCount:result.metrics?.automaticCorrectionCount,
      automaticCorrectionMagnitudeMs:result.metrics?.automaticCorrectionMagnitudeMs,correctionDutyCycle:result.metrics?.correctionDutyCycle,
      rateAdjustedSeconds:result.metrics?.rateAdjustedSeconds,rateAdjustmentSeconds:result.metrics?.rateAdjustmentSeconds,
      presentationMeasuredSeconds:result.metrics?.presentationMeasuredSeconds,positionMeasuredSeconds:result.metrics?.positionMeasuredSeconds,
      bufferingSeconds:result.metrics?.bufferingSeconds,clockValid:timing.valid,clockAgeMs:timing.clockAgeMs,
      clockUncertaintyMs:timing.clockUncertaintyMs});
    lastQualityDiagnosticAt=Date.now();
  }
  if(result.updated||changed||Date.now()-lastSyncQualityPublishAt>=5000)
    sendSyncQuality(result.status,result.score,result.confidence,result.reason,result.metrics?.measurementFreshnessMs);
}
const syncReady=import('./watch-sync.mjs').then(({createSync})=>{
  sync=createSync({video,timing:uburoomTiming,playback:uburoomPlayback,clock:playbackClock,presentation:presentationTiming,
    read:()=>({state,selected,mediaSource,receivedAt,probing,playbackError,playerWaiting,hlsNetworkFailure,
      autoplayBlocked,readyVersion,syncCorrectionMode}),
    expected,decodedFrames,unlockLocal,reportReadiness,render:renderTransport,checkFrames:checkVideoFrames,sample:diagnosticSample,
    correction:event=>syncQuality.recordCorrection({at:performance.now(),magnitudeMs:event.magnitudeMs,kind:event.kind}),
    correctionEligible:()=>performance.now()-lastPresentationBreak>=2000&&performance.now()>=syncQualitySettleUntil&&!sync?.timelinePending,
    error:message=>{playbackError=message;fail(message);},
    playing:(version,blocked)=>{if(version!==undefined)readyVersion=version;autoplayBlocked=blocked;},
    visibility:()=>document.visibilityState,online:()=>navigator.onLine,
    repeat:(callback,delay)=>setInterval(callback,delay),cancelRepeat:timer=>clearInterval(timer)});
});
const soakMode=params.get('soak')==='1', diagnostics = uburoomDiagnostics.create({soak:soakMode});
let soak;
$('soak-start').hidden=!soakMode;
$('soak-status').hidden=!soakMode;
$('soak-start').onclick=()=>{
  if(soak||!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||pending||video.paused||video.readyState<3)return;
  soak={room:selected,media:state.mediaVersion,startedAt:performance.now(),finishing:false,done:false};
  diagnosticSample('soak-start');$('soak-status').textContent='Two-hour soak recording locally. Keep this tab open.';
};
async function finishSoak(reason) {
  if(!soak||soak.finishing||soak.done)return;
  soak.finishing=true;let cleanup=false;
  const same=()=>selected===soak.room&&state?.mediaVersion===soak.media&&state.visibility==='private'&&state.viewers===1&&state.canManage;
  try {
    if(reason==='complete'&&same()&&!pending){
      await execute({action:'media.pause'});
      if(same()&&!pending){const id=selected;pending=true;try{await api('/api/watch/rooms/'+id+'/leave',{viewerId});
        if(selected===id){selected=undefined;browseRoom=undefined;unavailable('','leave');await refreshRooms();cleanup=true;}}
        finally{pending=false;renderTransport();}}
    }
  } catch { /* Export even if the current authorized room cannot be cleaned up. */ }
  finally {
    soak.done=true;diagnosticSample('soak-end',{reason,cleanup,elapsedMs:performance.now()-soak.startedAt});
    saveDiagnostics('uburoom-playback-soak.json');
    $('soak-status').textContent=reason==='complete'?'Soak complete. Diagnostic download requested'+(cleanup?'; test room closed.':'; check playback cleanup.'):'Soak stopped because the room changed. Diagnostic download requested.';
  }
}
const controlProbe=params.get('playbackProbe')==='1'?uburoomDiagnostics.controlProbe():undefined;
let probeRunning=false;
$('probe-control').hidden=!controlProbe;
$('probe-control').onclick=()=>{
  if(!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||pending||!controlProbe?.start(selected))return;
  probeRunning=true;diagnosticSample('probe-start',{delayMs:6000});
  transport?.interrupt(6000);
};
function diagnosticSample(event='sample',fields={}) {
  // Diagnostics must never interrupt playback, even during MediaSource teardown.
  try {
    const quality=video.getVideoPlaybackQuality?.(), tracks=state?.tracks, rect=video.getBoundingClientRect(), timing=playbackClock.read();
    const sharedTarget=uburoomTiming.target(state,timing.serverTime);
    diagnostics.record(event,{position:video.currentTime,target:expected(),ready:video.readyState,network:video.networkState,
      ...timing,clockValid:timing.valid,sharedTarget,arrivalTarget:arrivalExpected(),timelineRevision:state?.revision,
      positionErrorMs:sharedTarget===undefined?undefined:(video.currentTime-sharedTarget)*1000,
      paused:video.paused,seeking:video.seeking,waiting:playerWaiting,rate:video.playbackRate,syncMode:syncCorrectionMode,
      ranges:Array.from({length:Math.min(video.buffered.length,8)},(_,i)=>[video.buffered.start(i),video.buffered.end(i)]),
      bufferAhead:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime),frames:quality?.totalVideoFrames,dropped:quality?.droppedVideoFrames,
      decoded:quality?quality.totalVideoFrames-quality.droppedVideoFrames:videoFrames,
      jsHeapUsed:performance.memory?.usedJSHeapSize,jsHeapTotal:performance.memory?.totalJSHeapSize,jsHeapLimit:performance.memory?.jsHeapSizeLimit,
      callbackFrames:videoFrames,width:video.videoWidth,height:video.videoHeight,mediaError:video.error?.code,
      online:navigator.onLine,visibility:document.visibilityState,inViewport:rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth,
      viewportFraction:rect.width>0&&rect.height>0?Math.max(0,Math.min(innerWidth,rect.right)-Math.max(0,rect.left))*Math.max(0,Math.min(innerHeight,rect.bottom)-Math.max(0,rect.top))/(rect.width*rect.height):0,
      format:state?.format,
      audio:tracks?.audio.findIndex(row=>row.id===tracks.audioId),subtitle:tracks?.subtitles.findIndex(row=>row.id===tracks.subtitleId),
      delivery:tracks?.subtitles.find(row=>row.id===tracks.subtitleId)?.delivery || 'off',...fields});
  } catch { /* A missing diagnostic sample must not change player behavior. */ }
}
for(const event of ['playing','pause','waiting','stalled','seeking','seeked','ended','error','emptied','loadstart','loadedmetadata','canplay','abort','ratechange'])
  video.addEventListener(event,()=>{
    if(event==='waiting'&&disconnectExtended)fullPlayerClear();
    if(['pause','waiting','seeking','emptied'].includes(event))choppyDetector.interrupt();
    // Decoding has resumed after refill. Permit one alignment to the current
    // room target even when a long outage left that target outside this buffer.
    sync?.event(event);
    if(['playing','pause','waiting','seeking','emptied'].includes(event))lastPresentationBreak=performance.now();
    diagnosticSample(event);
  });
for(const event of ['online','offline','pagehide'])window.addEventListener(event,()=>{sync?.event(event);diagnosticSample(event);});
document.addEventListener('visibilitychange',()=>{sync?.event('visibilitychange');diagnosticSample('visibilitychange');});
setInterval(()=>{
  if(probeRunning&&!controlProbe.active()){probeRunning=false;diagnosticSample('probe-end');}
  $('probe-control').disabled=!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||pending||!!controlProbe?.active();
  $('soak-start').disabled=!!soak||!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||pending||video.paused||video.readyState<3;
  if(selected || state || mediaSource)diagnosticSample();
  if(soak&&!soak.finishing&&!soak.done){
    if(selected!==soak.room||state&&state.mediaVersion!==soak.media)void finishSoak('source-changed');
    else if(performance.now()-soak.startedAt>=7200000)void finishSoak('complete');
  }
},1000);
function saveDiagnostics(filename='uburoom-playback-diagnostics.json') {
  diagnosticSample();
  const url=URL.createObjectURL(new Blob([JSON.stringify(diagnostics.snapshot(),null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
let subtitleLoadingTimer, subtitleLoadingActive = false;
function setSubtitleLoadingToast(loading) {
  if (!loading) {
    subtitleLoadingActive = false;
    clearTimeout(subtitleLoadingTimer); subtitleLoadingTimer = undefined;
    toasts?.dismiss('subtitle-loading', false);
    return;
  }
  if (subtitleLoadingActive) return;
  subtitleLoadingActive = true;
  subtitleLoadingTimer = setTimeout(() => {
    subtitleLoadingTimer = undefined;
    if (subtitleLoadingActive) toasts?.show('subtitle-loading', { symbol: 'subtitles', title: 'Loading subtitles…', duration: 0 });
  }, 250);
}
const captions = new uburoomSubtitles(video, value => {
  trackNotice = value.message; trackNoticeError = value.error;
  setSubtitleLoadingToast(!!value.loading);
  renderTracks();
}, mediaTime => (sync.timelinePending || video.readyState < 1) ? expected() : (Number.isFinite(mediaTime) ? mediaTime : video.currentTime));
const subtitleMode=$('subtitle-mode');
video.volume = playerPreferences.volume / 100;
video.muted = playerPreferences.muted;
function glyph(id, symbol) { $(id)?.replaceChildren(uburoomIcons.icon(document, symbol)); }
for (const pair of [['refresh','refresh'],['room-symbol','door'],['roomies-symbol','oomark'],['fullscreen','fullscreen'],
  ['join-playback','play'],['player-play','play'],['previous','start'],['seek-back','back'],['seek-forward','forward'],['next','end'],['player-mute','volume'],
  ['theater','theater'],['tracks-open','settings'],['tracks-close','close'],['drawer-symbol','drawer'],['media-symbol','media'],['drawer-close','close'],['admin-mode','admin'],['browser-symbol','open'],['options-chevron','chevron'],]) glyph(...pair);
const toasts = uburoomToasts.create($('watch-toasts'), { stage: $('stage') });
function renderNotifications() {
  const button = $('notifications-toggle');
  button.setAttribute('aria-pressed', String(toasts.enabled));
  button.title = toasts.enabled ? 'Hide notifications' : 'Show notifications';
  button.replaceChildren(uburoomIcons.icon(document, toasts.enabled ? 'bell' : 'bell-off'));
}
$('notifications-toggle').onclick = () => { toasts.setEnabled(!toasts.enabled); renderNotifications(); };
renderNotifications();
const roomUI = uburoomRoomUI.mount({ request:api,getState:()=>state,getMe:()=>me,execute,
  join:async (id,next)=>{await selectRoom(id,next);if(!state)throw new Error('Room unavailable');returnToVideo();},entry:()=>{const {viewer,...preferences}=viewerPreferences();return {viewerId:viewer,...preferences};},
  changed:async()=>{await refreshRooms();if(selected)await refreshState();},showChooser:section=>chooseRoom(undefined,section),fail,
  createDraft:options=>createRoom(options),draftChanged:options=>{ $('room-name').value = roomNameDraft = options.name; $('room-create-visibility').value = roomVisibilityDraft = options.visibility; const preset = uburoomRoomUI.presetName(options.permissions); $('room-create-preset').value = roomPresetDraft = preset === 'custom' ? '' : preset; } });
async function fetchArtwork(path, signal) {
  const response = await fetch(path, { signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]), headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!response.ok) throw new Error('Artwork unavailable');
  return response.blob();
}
const queueUI = uburoomQueueUI.mount($('queue-content'), {
  request:api,getState:()=>state,getMe:()=>me,fail,execute,getSettingsState:()=>roomUI.playbackContext(),saveSettings:change=>roomUI.savePlayback(change),
  openSettings:()=>roomUI.open(state.id,'playback'),
  browseMedia,
  serverTime:()=>playbackClock.read().serverTime ?? Date.now() + offset,
  openLibraryItem: item => { selectSection('media'); return library?.openItem(item); },
  artwork: fetchArtwork,
  changed:async()=>{if(selected)await refreshState();}
});

let endingTicker = null;
let endingArtController = null;
const endingArtUrls = new Map();

function initEndingStage() {
  const container = $('ending-stage');
  if (!container) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'ending-backdrop';
  backdrop.className = 'ending-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');

  const header = document.createElement('div');
  header.className = 'ending-header';
  header.id = 'ending-header';

  const playWrap = document.createElement('div');
  playWrap.className = 'ending-play-wrap';
  const playBtn = document.createElement('button');
  playBtn.id = 'ending-play';
  playBtn.className = 'ending-center-play';
  playBtn.type = 'button';
  playBtn.setAttribute('aria-label', 'Play');

  const svgNS = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(svgNS, 'svg');
  ring.setAttribute('class', 'ending-ring');
  ring.setAttribute('viewBox', '0 0 72 72');
  ring.setAttribute('aria-hidden', 'true');
  const track = document.createElementNS(svgNS, 'circle');
  track.setAttribute('class', 'ending-ring-track');
  track.setAttribute('cx', '36');
  track.setAttribute('cy', '36');
  track.setAttribute('r', '34.25');
  const progress = document.createElementNS(svgNS, 'circle');
  progress.setAttribute('id', 'ending-ring-progress');
  progress.setAttribute('class', 'ending-ring-progress');
  progress.setAttribute('cx', '36');
  progress.setAttribute('cy', '36');
  progress.setAttribute('r', '34.25');
  ring.append(track, progress);

  const playIcon = uburoomIcons.icon(document, 'play');
  playIcon.setAttribute('class', 'ending-play-icon');
  playBtn.append(ring, playIcon);
  playWrap.append(playBtn);

  const status = document.createElement('p');
  status.className = 'ending-status';
  status.id = 'ending-status';
  status.setAttribute('role', 'status');

  const body = document.createElement('div');
  body.className = 'ending-body';

  const kicker = document.createElement('div');
  kicker.id = 'ending-kicker';
  kicker.className = 'ending-kicker';

  const title = document.createElement('h2');
  title.id = 'ending-title';
  title.className = 'ending-title';

  const subtitle = document.createElement('p');
  subtitle.id = 'ending-subtitle';
  subtitle.className = 'ending-subtitle';

  const summary = document.createElement('p');
  summary.id = 'ending-summary';
  summary.className = 'ending-summary';

  const actions = document.createElement('div');
  actions.className = 'ending-actions';

  const startNowBtn = document.createElement('button');
  startNowBtn.id = 'ending-start-now';
  startNowBtn.className = 'primary ending-secondary-primary';
  startNowBtn.type = 'button';
  startNowBtn.append(uburoomIcons.icon(document, 'play'), document.createTextNode('Start now'));

  const cancelBtn = document.createElement('button');
  cancelBtn.id = 'ending-cancel';
  cancelBtn.className = 'quiet';
  cancelBtn.type = 'button';
  cancelBtn.textContent = 'Cancel';

  const watchAgainBtn = document.createElement('button');
  watchAgainBtn.id = 'ending-watch-again';
  watchAgainBtn.className = 'quiet';
  watchAgainBtn.type = 'button';
  watchAgainBtn.append(uburoomIcons.icon(document, 'refresh'), document.createTextNode('Watch again'));

  const browseBtn = document.createElement('button');
  browseBtn.id = 'ending-browse';
  browseBtn.className = 'quiet';
  browseBtn.type = 'button';
  browseBtn.append(uburoomIcons.icon(document, 'media'), document.createTextNode('Browse media'));
  browseBtn.addEventListener('click', browseMedia);

  actions.append(startNowBtn, cancelBtn, watchAgainBtn, browseBtn);
  body.append(kicker, title, subtitle, summary, actions);

  container.replaceChildren(backdrop, header, playWrap, status, body);

  playBtn.onclick = async () => {
    if (!state?.ending) return;
    const ending = state.ending;
    if (ending.state === 'countdown' || ending.state === 'upNext') {
      await execute({ action: 'media.next' });
    } else if (ending.state === 'offer' && ending.next) {
      await execute({
        action: 'queue.offer.start',
        args: { mediaId: ending.next.mediaId, showId: ending.next.showId }
      });
    } else if (ending.state === 'finished' && ending.completed) {
      await execute({
        action: 'queue.history.replay',
        args: { entryId: ending.completed.entryId, resume: false }
      });
    }
  };

  startNowBtn.onclick = async () => {
    if (!state?.ending?.next) return;
    await execute({
      action: 'queue.offer.start',
      args: { mediaId: state.ending.next.mediaId, showId: state.ending.next.showId }
    });
  };

  cancelBtn.onclick = async () => {
    await execute({ action: 'media.autoplay.cancel' });
  };

  watchAgainBtn.onclick = async () => {
    if (!state?.ending?.completed) return;
    await execute({
      action: 'queue.history.replay',
      args: { entryId: state.ending.completed.entryId, resume: false }
    });
  };
}

function renderEnding(next) {
  const ending = next.ending;
  if (!ending || next.mediaUrl) {
    if (endingTicker) {
      cancelAnimationFrame(endingTicker);
      endingTicker = null;
    }
    return;
  }

  const artItem = ending.next || ending.completed;
  const artMediaId = artItem?.mediaId;
  const artType = artItem?.type || 'movie';
  const artKey = artMediaId && /^\d{1,20}$/.test(String(artMediaId)) ? (artMediaId + ':' + artType) : '';
  const backdrop = $('ending-backdrop');
  if (backdrop && backdrop.dataset.artKey !== artKey) {
    backdrop.dataset.artKey = artKey;
    if (!artKey) {
      backdrop.style.backgroundImage = '';
    } else if (endingArtUrls.has(artKey)) {
      backdrop.style.backgroundImage = 'url(' + endingArtUrls.get(artKey) + ')';
    } else {
      backdrop.style.backgroundImage = '';
      endingArtController?.abort();
      const controller = new AbortController();
      endingArtController = controller;
      const params = new URLSearchParams({ item: String(artMediaId), kind: 'poster', type: artType });
      fetchArtwork('/api/watch/library/art?' + params, controller.signal).then(blob => {
        if (controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        endingArtUrls.set(artKey, url);
        while (endingArtUrls.size > 24) {
          const first = endingArtUrls.keys().next().value;
          URL.revokeObjectURL(endingArtUrls.get(first));
          endingArtUrls.delete(first);
        }
        if (backdrop.dataset.artKey === artKey) {
          backdrop.style.backgroundImage = 'url(' + url + ')';
        }
      }).catch(() => {});
    }
  }

  const header = $('ending-header');
  if (header) {
    if (ending.completed && ending.next) {
      header.hidden = false;
      const subtitleStr = ending.completed.subtitle ? ' (' + ending.completed.subtitle + ')' : '';
      header.textContent = 'Last played: ' + ending.completed.title + subtitleStr;
    } else {
      header.hidden = true;
      header.textContent = '';
    }
  }

  const isSecondary = ending.next?.source === 'auto' || ending.next?.source === 'offer';
  const playBtn = $('ending-play');
  if (playBtn) {
    playBtn.hidden = false;
    playBtn.classList.toggle('is-secondary', isSecondary);
    const hasCaps = !!next.capabilities;
    const canPlay = !hasCaps || ((ending.state === 'offer')
      ? (!!next.capabilities.addQueue && !!next.capabilities.playPause)
      : (!!next.capabilities.playPause || !!next.capabilities.chooseMedia));
    playBtn.disabled = !canPlay;
    const status = $('ending-status');
    if (status) {
      if (!canPlay) {
        status.textContent = ending.state === 'offer'
          ? 'Starting continuation requires permission to add to queue and play.'
          : 'Playing next requires playback permission.';
      } else if (ending.error) {
        status.textContent = ending.error;
      } else {
        status.textContent = '';
      }
    }
  }

  const displayItem = ending.next || ending.completed;
  const title = $('ending-title');
  if (title) title.textContent = displayItem?.title || '';
  const subtitle = $('ending-subtitle');
  if (subtitle) subtitle.textContent = displayItem?.subtitle || '';
  const summary = $('ending-summary');
  if (summary) {
    summary.textContent = ending.next?.summary || '';
    summary.hidden = !ending.next?.summary;
  }

  const kicker = $('ending-kicker');
  if (kicker) {
    kicker.classList.toggle('is-secondary', isSecondary);
    if (ending.state === 'upNext') {
      kicker.textContent = isSecondary ? 'Auto-queue · Up next' : 'Up next';
    } else if (ending.state === 'offer') {
      kicker.textContent = 'Next episode · Auto-queue';
    } else if (ending.state === 'finished') {
      kicker.textContent = 'Just ended';
    }
  }

  const ring = document.querySelector('.ending-ring');
  if (ring) ring.hidden = ending.state !== 'countdown';

  const startNowBtn = $('ending-start-now');
  if (startNowBtn) {
    const canOffer = !!next.capabilities?.addQueue && !!next.capabilities?.playPause;
    startNowBtn.hidden = ending.state !== 'offer' || !canOffer;
  }
  const cancelBtn = $('ending-cancel');
  if (cancelBtn) {
    cancelBtn.hidden = ending.state !== 'countdown' || !next.capabilities?.autoplay;
  }
  const watchAgainBtn = $('ending-watch-again');
  if (watchAgainBtn) {
    const canReplay = !!next.capabilities?.playPause || !!next.capabilities?.chooseMedia;
    watchAgainBtn.hidden = !ending.completed || !canReplay;
  }
  const browseBtn = $('ending-browse');
  if (browseBtn) {
    browseBtn.hidden = !next.canBrowse;
  }

  if (ending.state === 'countdown' && ending.countdown) {
    const updateCountdown = () => {
      if (!state?.ending || state.ending.state !== 'countdown' || !state.ending.countdown) {
        endingTicker = null;
        return;
      }
      const now = (playbackClock.read().serverTime ?? (Date.now() + offset));
      const remaining = Math.max(0, state.ending.countdown.endsAt - now);
      const fraction = Math.max(0, Math.min(1, remaining / (state.ending.countdown.durationMs || 10000)));
      const seconds = Math.max(0, Math.ceil(remaining / 1000));
      const kickerEl = $('ending-kicker');
      if (kickerEl) kickerEl.textContent = 'Up next in ' + seconds + 's';
      const progressEl = $('ending-ring-progress');
      if (progressEl) {
        const circumference = 215.199;
        progressEl.style.strokeDashoffset = String(circumference * (1 - fraction));
      }
      endingTicker = requestAnimationFrame(updateCountdown);
    };
    if (!endingTicker) {
      endingTicker = requestAnimationFrame(updateCountdown);
    }
  } else {
    if (endingTicker) {
      cancelAnimationFrame(endingTicker);
      endingTicker = null;
    }
  }
}

playerUI=uburoomPlayerUI.mount({getState:()=>state,execute,fail,changeTrack,captions,
  beforeSettings:()=>{renderMediaInformation(state);trackContext=state?{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion}:undefined;trackActionError='';renderTracks();},
  afterSettings:()=>{trackContext=undefined;}});
const library = uburoomLibrary.mount($('library-content'), {
  request:(path,signal) => api(path,undefined,{signal}),
  artwork: fetchArtwork,
  load:item => selected ? loadLibraryItem(item) : chooseRoom(item),
  addToQueue: async item => {
    if (!selected || !state?.durable) return;
    await queueUI.add(item);
  },
  addBulkToQueue: item => queueUI.bulk(item),
  autoQueue: source => queueUI.openAuto(source),
  isAdmin:() => !!me?.adminMode,
  openCodecTester:() => {
    if (!me?.adminMode) return;
    $('codec-test-frame').src = '/__diagnostics/codec';
    uburoomDialogs.open($('codec-test-dialog'));
  },
  close:returnToVideo, getPlayer:() => state
});
initEndingStage();
// The nested same-origin tester uses current Activity authorization without
// copying its bearer token into a URL, iframe or exported diagnostics.
globalThis.uburoomCodecSample = async (path, options = {}) => {
  if (!me?.adminMode || !/^\/__diagnostics\/media\/[a-z0-9.-]+$/.test(path)) throw new Error('Turn on Admin mode to use the codec tester.');
  return fetch(path,{...options,headers:token?{Authorization:'Bearer '+token}:{}});
};
globalThis.uburoomCloseCodecTester = () => uburoomDialogs.close($('codec-test-dialog'));
$('codec-test-close').onclick = globalThis.uburoomCloseCodecTester;
$('codec-test-dialog').addEventListener('close',() => {$('codec-test-frame').src = 'about:blank';});
function fail(message) {
  const changed = $('error').textContent !== message;
  $('error').textContent = message;
  if (message && changed && immersive && !document.body.classList.contains('activity-pip')) toggleDrawer(true);
}
async function api(path, data, options = {}) {
  const started=performance.now(); let response,decoded=false,rejection;
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; if (me?.csrf) headers['X-CSRF-Token'] = me.csrf; }
  try {
  if(controlProbe?.rejects(path,selected))throw new TypeError('Controlled room-poll interruption');
  if(transport && /^\/api\/watch\/(rooms|me|profile|admin-mode|playback|library)(?:[/?]|$)/.test(path) && !path.startsWith('/api/watch/library/art')) {
    try {return await transport.request(path,data,options);} catch(error){rejection=error.rejection;if(error.status)response={status:error.status,ok:false};throw error;}
  }
  response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers,
    body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs || 12000)]) : AbortSignal.timeout(options.timeoutMs || 12000), keepalive: !!options.keepalive });
  const value = await response.json(); decoded=true; if (!response.ok) {rejection=value.rejection;throw Object.assign(new Error(value.error || 'Request failed'),{status:response.status,response:value});} return value;
  } catch(error) {
    diagnostics.record('request-failed',{request:uburoomDiagnostics.requestKind(path),elapsedMs:performance.now()-started,status:response?.status,
      rejection:uburoomDiagnostics.requestKind(path)==='observe'?rejection:undefined,
      failure:response && !response.ok?'http':response && !decoded?'decode':error.name==='TimeoutError'?'timeout':error.name==='AbortError'?'abort':error instanceof TypeError?'network':'other'});
    throw error;
  }
}
function acceptIdentity(auth) {
  token = auth.token; identityExpiresAt = auth.expiresAt;
  identityRenewAt = identityExpiresAt - Math.min(60000, Math.floor((identityExpiresAt - Date.now()) / 5));
  identityRetryAt = 0; identityGeneration++;
  diagnostics.record('identity-renewed',{identity:identityGeneration});
  transport?.reauthenticate();
}
async function activityIdentity() {
  const { code } = await sdk.commands.authorize({ client_id:config.clientId,response_type:'code',state:crypto.randomUUID(),prompt:'none',scope:['identify'] });
  const auth = await api('/api/watch/activity-login', {code});
  if (!await sdk.commands.authenticate({access_token:auth.accessToken})) throw new Error('Discord Activity authentication failed');
  return auth;
}
async function renewIdentity() {
  if (!token || Date.now() < identityRenewAt) return;
  if (identityRenewal) return identityRenewal;
  if (Date.now() < identityRetryAt) {
    if (Date.now() >= identityExpiresAt) throw new Error('Viewing sign-in expired; reconnect to continue.');
    return;
  }
  identityRenewal = (async () => {
    const auth = config.demo && ['host','guest','guest2'].includes(params.get('demo'))
      ? await api('/api/watch/demo-login', {persona:params.get('demo'),activity})
      : await activityIdentity();
    acceptIdentity(auth);
  })().catch(error => {
    diagnostics.record('identity-renew-failed');
    identityRetryAt = Date.now() + 10000;
    if (Date.now() >= identityExpiresAt) throw error;
  }).finally(() => { identityRenewal = undefined; });
  return identityRenewal;
}
function dropVolume() { clearTimeout(volumeTimer); volumeWanted = volumeDraft = undefined; volumeDragging = false; }
// Move the actual shells so their controls, state and listeners stay shared.
const sections = [['room','Room','options-panel'],['queue','Queue','queue-panel'],['media','Media','library-panel']];
// Collapse the shared panels without rebuilding their live controls.
const sectionToggles = sections.map(([key,, id]) => {
  const panel = $(id), heading = panel.querySelector('h2');
  let button = heading.querySelector('.section-toggle');
  if (!button) {
    button = document.createElement('button'); button.type = 'button';
    button.className = 'section-toggle'; button.id = key + '-collapse';
    button.append(...heading.childNodes, uburoomIcons.icon(document, 'chevron'));
    heading.append(button);
  }
  button.setAttribute('aria-controls', key === 'room' ? 'options-content' : key === 'media' ? 'library-content' : 'queue-body');
  button.addEventListener('click', () => {
    if (document.body.classList.contains('mobile-player')) return;
    panel.classList.toggle('section-collapsed'); updateSectionTabs();
  });
  return { panel, button };
});
let mobileSection = 'room', sectionChosen = false;
const sectionTabs = document.createElement('nav');
sectionTabs.id = 'section-tabs'; sectionTabs.hidden = true;
sectionTabs.setAttribute('role', 'tablist'); sectionTabs.setAttribute('aria-label', 'Room sections');
$('viewing-section').after(sectionTabs);
for (const [key, label, panel] of sections) {
  const tab = document.createElement('button');
  tab.id = 'section-tab-' + key; tab.type = 'button'; tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-controls', panel); tab.dataset.section = key;
  if (key === 'room') {
    tab.append(uburoomIcons.icon(document,'door'));
  } else tab.append(uburoomIcons.icon(document, key === 'queue' ? 'queue' : 'media'));
  tab.append(document.createTextNode(label));
  tab.addEventListener('click', () => selectSection(key));
  sectionTabs.append(tab);
}
function selectSection(key, focus = false) {
  if (mobileSection === 'queue' && key !== 'queue') queueUI.rememberPosition();
  mobileSection = key; sectionChosen = true;
  updateSectionTabs();
  if (key === 'queue') queueUI.restorePosition();
  if (focus) $('section-tab-' + key).focus();
}
function updateSectionTabs() {
  const mobile = document.body.classList.contains('mobile-player');
  if (!sectionChosen) mobileSection = state?.durable ? 'room' : 'media';
  if (mobileSection === 'queue' && state && !state.durable) mobileSection = 'media';
  sectionTabs.hidden = !mobile;
  for (const { panel, button } of sectionToggles) {
    button.disabled = mobile;
    button.setAttribute('aria-expanded', String(mobile || !panel.classList.contains('section-collapsed')));
  }
  for (const [key,, id] of sections) {
    const panel = $(id), tab = $('section-tab-' + key), active = key === mobileSection;
    tab.disabled = key === 'queue' && !!state && !state.durable;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    panel.classList.toggle('section-tab-inactive', mobile && !active);
    if (mobile) { panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', tab.id); }
    else { panel.removeAttribute('role'); panel.removeAttribute('aria-labelledby'); }
  }
}
sectionTabs.addEventListener('keydown', event => {
  const tabs = [...sectionTabs.querySelectorAll('button:not(:disabled)')];
  const index = tabs.indexOf(document.activeElement);
  const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length :
    event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
  if (next >= 0) { event.preventDefault(); selectSection(tabs[next].dataset.section, true); }
});
const drawer = document.createElement('aside'); drawer.id = 'drawer'; drawer.hidden = true;
drawer.setAttribute('aria-label', 'Menu'); document.body.append(drawer);
const shells = ['account','section-tabs','options-panel','queue-panel','library-panel','status','error','diagnostic-actions','acceleration-help'].map(id => {
  const element = $(id), marker = document.createComment(id); element.before(marker); return { element, marker };
});
function toggleDrawer(show = drawer.hidden) {
  $('library-panel').classList.remove('media-glow');
  show = !!show && immersive && !document.body.classList.contains('activity-pip');
  const parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
  if (drawer.parentElement !== parent) parent.append(drawer);
  parent.append($('drawer-close'));
  $('drawer-close').hidden = !show;
  drawer.hidden = !show; $('stage').classList.toggle('drawer-open', show);
  $('drawer-open').setAttribute('aria-expanded', String(show));
}
function returnToVideo() {
  toggleDrawer(false);
  window.scrollTo({top:0,behavior:'instant'});
  $('stage').focus({preventScroll:true});
}
$('library-top').addEventListener('click', returnToVideo);
function setTheater(enabled, remember = true) {
  theater = !activity && !document.body.classList.contains('mobile-player') && !!enabled;
  document.body.classList.toggle('theater', theater);
  $('theater').setAttribute('aria-pressed', String(theater));
  $('theater').title = $('theater').ariaLabel = theater ? 'Exit theater mode' : 'Theater mode';
  if (remember && !activity) { try { localStorage.setItem('uburoom.watchMode', theater ? 'theater' : 'normal'); } catch {} }
  updateViewingLayout();
}
function updateMobilePlayer() {
  const mobile=innerWidth<=700||matchMedia('(pointer:coarse) and (max-height:700px)').matches||!!document.fullscreenElement&&document.body.classList.contains('mobile-player');
  document.body.classList.toggle('mobile-player',mobile);
  if(mobile&&theater&&!immersive&&!document.fullscreenElement)setTheater(false,false);
  updateSectionTabs();
}
function updateViewingLayout() {
  if (!immersive) document.documentElement.style.setProperty('--watch-header-height', ($('viewing-section').getBoundingClientRect().top + scrollY) + 'px');
}
const viewingLayoutObserver = new ResizeObserver(updateViewingLayout);
viewingLayoutObserver.observe($('account')); viewingLayoutObserver.observe($('viewing-section'));
window.addEventListener('scroll', () => document.body.classList.toggle('page-scrolled', scrollY > 0), {passive:true});
function updateFullscreenLayout() {
  immersive = activity || document.fullscreenElement === $('stage');
  const drawerOpen = !drawer.hidden;
  document.body.classList.toggle('immersive', immersive);
  for (const { element, marker } of shells) immersive ? drawer.append(element) : marker.after(element);
  $('drawer-open').hidden = $('drawer-close').hidden = !immersive;
  toggleDrawer(drawerOpen);
  placeRoomBar();
  updateSectionTabs();
  updateViewingLayout();
}
function placeRoomBar() {
  $('room-bar').hidden = !me && $('auth-overlay').hidden;
  $('room-lobby').hidden = !!selected || !me;
}
function renderSyncPreference() {
  $('sync-correction').value=syncCorrectionMode;
  $('sync-correction-hint').textContent=(syncCorrectionMode==='jumps'
    ? 'Keep normal speed; occasionally skip or repeat a moment to catch up.'
    : 'Adjust playback speed to stay together, with jumps for larger gaps.')+
    (syncPreferenceStored?' Only your player in this browser.':' This tab only; browser storage is unavailable.');
}
function loadSyncPreference() {
  const key='uburoom.syncCorrection.'+(me?.account?.id||'browser');
  if(key===syncPreferenceKey)return;
  syncPreferenceKey=key;syncCorrectionMode='speed';syncPreferenceStored=true;
  try { if(localStorage.getItem(key)==='jumps')syncCorrectionMode='jumps'; } catch { syncPreferenceStored=false; }
  sync.resetCorrection(true);renderSyncPreference();
}
function setSyncPreference(value) {
  if(value!=='speed'&&value!=='jumps')return;
  syncCorrectionMode=value;sync.resetCorrection(true);
  try { localStorage.setItem(syncPreferenceKey,value);syncPreferenceStored=true; } catch { syncPreferenceStored=false; }
  renderSyncPreference();diagnosticSample('sync-mode');
}
$('sync-correction').addEventListener('change',event=>setSyncPreference(event.target.value));
function renderAccount() {
  loadSyncPreference();
  const identityName = me.name + (config.demo ? ' · local demo' : '');
  $('identity').textContent = identityName;
  $('identity').setAttribute('aria-label', identityName + ' · Account settings');
  $('admin-mode').hidden = !(me.adminEligible ?? me.owner); $('admin-mode').setAttribute('aria-checked',String(!!me.adminMode));
  $('admin-mode').title = me.adminMode ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
  $('open-browser').hidden = !activity||config.access?.publicWeb===false;
  if(typeof updateAccountButton==='function')updateAccountButton();
  roomUI.render();
  library.refreshAdmin();
  if (!me.adminMode && $('codec-test-dialog').open) $('codec-test-dialog').close();
}
function stopBrowserHandoff(cancel = false) {
  clearTimeout(browserHandoffTimer);
  const id = browserHandoff; browserHandoff = browserVerification = undefined;
  $('open-browser').disabled = $('watch-website').disabled = false;
  if (cancel && id) void api('/api/watch/handoff/action',{id,action:'cancel'},{keepalive:true}).catch(() => {});
}
async function pollBrowserHandoff() {
  const id = browserHandoff; if (!id) return;
  try {
    const value = await api('/api/watch/handoff/status',{id}); if (browserHandoff !== id) return;
    if (value.state === 'complete') { stopBrowserHandoff(); $('handoff-dialog').close('complete'); return; }
    browserVerification = value.verification;
    $('handoff-code').textContent = value.verification || ''; $('handoff-code').hidden = !value.verification;
    $('approve-browser').disabled = value.state !== 'claimed';
    $('handoff-status').textContent = value.state === 'waiting' ? 'Open uburoom in your browser, then check its code.' :
      value.state === 'approved' ? 'Approved. Waiting for your browser…' : 'Check the code in your browser.';
    browserHandoffTimer = setTimeout(pollBrowserHandoff,1000);
  } catch (error) {
    if (browserHandoff === id) { stopBrowserHandoff(true); $('handoff-dialog').close('expired'); fail(error.message); }
  }
}
async function openInBrowser() {
  if (!activity || !me || browserHandoff || $('open-browser').disabled) return;
  $('open-browser').disabled = $('watch-website').disabled = true;
  // Only the isolated localhost demo uses window.open; live Discord always uses its SDK.
  const demoWindow = config.demo ? window.open('about:blank','_blank') : undefined;
  if (demoWindow) demoWindow.opener = null;
  try {
    if (config.demo && !demoWindow) throw new Error('Allow this localhost demo to open its browser tab, then retry.');
    const value = await api('/api/watch/handoff',selected ? {roomId:selected} : {});
    browserHandoff = value.id;
    if (demoWindow) demoWindow.location.replace(value.url);
    else {
      if (!sdk) throw new Error('Discord browser opening is unavailable. Reopen the Activity.');
      const result = await sdk.commands.openExternalLink({url:value.url});
      if (result.opened === false) throw new Error('Browser opening was cancelled. Try Open in Browser again.');
    }
    $('handoff-code').hidden = true; $('approve-browser').disabled = true;
    $('handoff-status').textContent = 'Open uburoom in your browser, then check its code.';
    uburoomDialogs.open($('handoff-dialog')); void pollBrowserHandoff();
  } catch (error) { demoWindow?.close(); stopBrowserHandoff(true); fail(error.message); }
}
$('open-browser').addEventListener('click',openInBrowser);
$('watch-website').addEventListener('click',openInBrowser);
$('handoff-dialog').addEventListener('close', () => stopBrowserHandoff(true));
$('approve-browser').addEventListener('click',async () => {
  const id = browserHandoff; if (!id || !browserVerification) return;
  const release = uburoomDialogs.hold($('handoff-dialog'));
  $('approve-browser').disabled = true;
  try { await api('/api/watch/handoff/action',{id,action:'approve',verification:browserVerification}); }
  catch (error) { if (browserHandoff === id) { stopBrowserHandoff(true); $('handoff-dialog').close('failed'); fail(error.message); } }
  finally { release(); }
});
$('admin-mode').addEventListener('click', async () => {
  $('admin-mode').disabled = true;
  try { await api('/api/watch/admin-mode',{enabled:!me.adminMode}); me = await api('/api/watch/me'); renderAccount(); await refreshRooms(); await refreshState(); }
  catch (error) {fail(error.message);} finally {$('admin-mode').disabled = false;}
});
function updateActivityLayout(event) {
  if (event) layoutMode = event.layout_mode;
  const pip = activity && (layoutMode === 1 || layoutMode === undefined && innerWidth <= 480 && innerHeight <= 300);
  document.body.classList.toggle('activity-pip', pip);
  if (pip) { toggleDrawer(false); if ($('privacy-dialog').open) $('privacy-dialog').close('cancel'); }
  if(pip&&$('account-dialog').open)$('account-dialog').close();
  if(pip){playerUI?.reset();if($('tracks-dialog').open)$('tracks-dialog').close();}
}
document.body.classList.toggle('activity', activity); $('fullscreen').hidden = $('theater').hidden = activity;
if (activity) {
  $('brand-link').href = '/watch' + location.search; $('brand-link').setAttribute('aria-label', 'uburoom watch');
  $('welcome').hidden = true;
}
updateMobilePlayer(); setTheater(theater,false); updateFullscreenLayout(); updateActivityLayout();
window.addEventListener('resize', () => { updateMobilePlayer(); updateActivityLayout(); renderTransport(); });
$('theater').addEventListener('click', async () => {
  if (activity) return;
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); setTheater(true); }
    else setTheater(!theater);
  } catch (error) { fail(error.message); }
});
$('drawer-open').addEventListener('click', () => {
  if (!immersive) return;
  toggleDrawer(); if (!drawer.hidden) $('drawer-close').focus();
});
$('drawer-close').addEventListener('click', () => { toggleDrawer(false); $('drawer-open').focus(); });
async function compatibleFallback(reason, preferHLS = false) {
  if (!state?.mediaUrl || state.mediaId === 'demo' || fallbackPending) return;
  const useLocal = !preferHLS && (state.format !== 'file' || /^(h264|avc1)$/i.test(state.videoCodec || ''));
  if (pending || qualityPending) {
    if (fallbackRetryTimer) return;
    const id = selected, version = state.mediaVersion, stream = state.streamVersion;
    fallbackRetryTimer = setTimeout(() => {
      fallbackRetryTimer = undefined;
      if (selected === id && state?.mediaVersion === version && state?.streamVersion === stream) void compatibleFallback(reason,preferHLS);
    }, 200);
    return;
  }
  if (localFallbackVersion !== state.mediaVersion) {localFallbackVersion=state.mediaVersion;localFallbackAttempts=new Set();}
  if (uburoomPlayback.localFormat(state.format)) localFallbackAttempts.add(state.format);
  const localCandidates=uburoomPlayback.fallbackCodecs(config.localFormats || ['av1'],localFallbackAttempts,
    mime=>typeof MediaSource!=='undefined'&&MediaSource.isTypeSupported(mime));
  const candidates=useLocal || fallbackVersion===state.mediaVersion?localCandidates:[undefined,...localCandidates];
  if (!candidates.length) {
    av1?.destroy();av1=undefined;video.pause();playbackError=reason+' No remaining compatible conversion is available. Check the server codec/encoder settings.';
    $('acceleration-help').hidden=!activity;$('enable-acceleration').hidden=!sdk;fail(playbackError);return;
  }
  const id=selected,version=state.mediaVersion;
  fallbackPending = true;diagnosticSample('fallback');av1?.destroy();av1=undefined;stopHls('fallback');
  try {
    for (const codec of candidates) {
      if(selected!==id || state?.mediaVersion!==version)return;
      if(codec)localFallbackAttempts.add(codec);else fallbackVersion=version;
      try {
        await execute({action:'media.quality.set',args:{quality:state.quality,compatible:true,...(codec?{fallback:codec}:{})}});
        return;
      } catch(error) {
        playbackError=reason+' '+(codec?.toUpperCase() || 'H.264')+' fallback failed: '+error.message;
      }
    }
    fail(playbackError);
  } finally {fallbackPending=false;}
}
async function proxyDirectFile() {
  if (!state?.directDelivery || directRecovery || !navigator.onLine) return;
  const next = state, id = selected;
  const recovery = (async () => {
    try {
      await api('/api/watch/rooms/' + id + '/delivery', { viewerId, mediaVersion:next.mediaVersion, streamVersion:next.streamVersion });
      if (selected === id && state?.mediaVersion === next.mediaVersion) await refreshState();
    } catch {
      if (selected === id && state?.streamVersion === next.streamVersion) fail('Video delivery could not recover. Try joining the room again.');
    }
  })();
  directRecovery = recovery;
  try { await recovery; } finally { if (directRecovery === recovery) directRecovery = undefined; }
}
async function attachDirectFile(next) {
  const controller = directProbe = new AbortController();
  const current = () => !controller.signal.aborted && selected === next.id && state?.streamVersion === next.streamVersion && mediaSource === next.mediaUrl;
  try {
    // Prove CORS/range delivery before attaching native media. Do not follow a
    // redirect or send uburoom cookies/credentials to the Plex origin.
    const response = await fetch(next.mediaUrl, { headers:{Range:'bytes=0-0'}, mode:'cors', credentials:'omit', redirect:'error',
      referrerPolicy:'no-referrer', signal:AbortSignal.any([controller.signal,AbortSignal.timeout(8000)]) });
    await response.body?.cancel();
    if (!current()) return;
    if (!response.ok) { await proxyDirectFile(); return; }
    video.crossOrigin = 'anonymous'; video.src = next.mediaUrl;
    directStartupTimer = setTimeout(() => { if (current() && video.readyState < 2) void proxyDirectFile(); }, 10000);
  } catch { if (current()) await proxyDirectFile(); }
}
video.addEventListener('waiting', () => {
  clearTimeout(directStallTimer);
  if (!state?.directDelivery) return;
  const stream = state.streamVersion, position = video.currentTime;
  directStallTimer = setTimeout(() => {
    if (state?.directDelivery && state.streamVersion === stream && !video.paused && video.readyState < 3 && video.currentTime <= position + .1) void proxyDirectFile();
  }, 8000);
});
window.addEventListener('online', () => {
  if (state?.directDelivery && (video.error || video.readyState < 2)) void proxyDirectFile();
});
function watchFrames() {
  if (!video.requestVideoFrameCallback) return;
  frameCallback = video.requestVideoFrameCallback((now,metadata) => {
    videoFrames++;
    try {
      const frame=presentationTiming.frame(now,metadata), timing=playbackClock.read(metadata.expectedDisplayTime);
      const target=uburoomTiming.target(state,timing.serverTime);
      const presentationErrorMs=target===undefined?undefined:(metadata.mediaTime-target)*1000;
      if(frame && Number.isFinite(presentationErrorMs)) {
        lastPresentationSampleAt=now;lastPresentationErrorMs=presentationErrorMs;
      }
      if(frame)diagnostics.record('frame',{...frame,...timing,clockValid:timing.valid,frameServerTime:timing.serverTime,
        timelineRevision:state?.revision,sharedTarget:target,presentationErrorMs,
        paused:video.paused,roomPaused:state?.state.paused,seeking:video.seeking,waiting:playerWaiting,ready:video.readyState,rate:video.playbackRate,syncMode:syncCorrectionMode,
        settling:performance.now()-lastPresentationBreak<2000,
        visibility:document.visibilityState,bufferAhead:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime)});
    } catch { /* Diagnostics cannot stop the decoded-frame evidence loop. */ }
    watchFrames();
  });
}
const choppyDetector = uburoomPlayback.choppinessDetector({ threshold: 0.10, windowMs: 10000, minFrames: 50 });
let choppyToastActive = false;
function dropPlaybackQuality() {
  const choices = state?.qualities || uburoom.QUALITIES;
  const current = uburoom.qualityId(state?.quality || preferredQuality);
  const index = choices.findIndex(q => q.id === current);
  if (index >= 0 && index < choices.length - 1) {
    const next = choices[index + 1].id;
    preferredQuality = next;
    savePlayerPreferences({ quality: preferredQuality });
    choppyDetector.triggerCooldown(10000, performance.now());
    if (state?.mediaId && state.mediaId !== 'demo') {
      execute({ action: 'media.quality.set', args: { quality: preferredQuality } }).catch(error => fail(error.message));
    }
  }
}
function checkChoppyPlayback() {
  if (!state?.mediaUrl || autoplayBlocked || playbackError || state?.mediaId === 'demo') {
    choppyDetector.interrupt();
    return;
  }
  const choices = state?.qualities || uburoom.QUALITIES;
  const current = uburoom.qualityId(state?.quality || preferredQuality);
  const index = choices.findIndex(q => q.id === current);
  if (index >= choices.length - 1) {
    if (choppyToastActive) {
      toasts.dismiss('choppy', false);
      choppyToastActive = false;
    }
    return;
  }
  const quality = video.getVideoPlaybackQuality?.();
  const conditions = {
    paused: video.paused || !!state?.state?.paused,
    seeking: video.seeking || sync?.seekPending,
    waiting: playerWaiting || video.readyState < 3,
    visible: document.visibilityState === 'visible',
    active: !pending && !qualityPending && video.currentTime > 1
  };
  const result = choppyDetector.update(performance.now(), quality, conditions);
  if (result.choppy) {
    if (!choppyToastActive && !choppyDetector.isDismissed) {
      choppyToastActive = true;
      toasts.show('choppy', {
        title: 'Playback seems choppy',
        duration: 15000,
        action: {
          label: 'Lower quality',
          run: () => {
            dropPlaybackQuality();
          }
        },
        onDismiss: (deliberate) => {
          choppyToastActive = false;
          if (deliberate) {
            choppyDetector.dismiss(true);
          }
        }
      });
    }
  } else if (choppyToastActive && !result.warming && !result.interrupted && !result.inCooldown) {
    toasts.dismiss('choppy', false);
    choppyToastActive = false;
  }
}
function decodedFrames() {
  const quality = video.getVideoPlaybackQuality?.();
  return videoFrames || (quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined);
}
function checkVideoFrames() {
  checkChoppyPlayback();
  if (!state?.mediaUrl || video.paused || video.seeking || autoplayBlocked || playbackError || fallbackPending) { frameStartedAt = undefined; return; }
  frameStartedAt ??= performance.now();
  const frames = decodedFrames();
  if (performance.now() - frameStartedAt > 8000 && (frames === 0 || !video.videoWidth || !video.videoHeight) && video.currentTime > 1) void compatibleFallback('Audio is playing without decoded video.');
}
function clearPlayer(reason, preserveSubtitles = false) {
  directProbe?.abort(); directProbe = undefined;
  directRecovery = undefined;
  clearTimeout(fallbackRetryTimer); fallbackRetryTimer = undefined;
  clearTimeout(directStartupTimer); clearTimeout(directStallTimer);
  clearTimeout(disconnectGraceTimer); disconnectGraceTimer = undefined;
  disconnectExtended = false; hideDisconnectToast();
  toasts.dismiss('choppy', false); choppyToastActive = false;
  choppyDetector.reset();
  toasts.dismiss('participant'); lastFeedback = undefined;
  if(reason!=='state-change')playerUI?.reset();
  sync.reset();
  resetSyncQuality();
  diagnosticSample('player-clear',{reason});
  if (!preserveSubtitles) {
    captions.reset(); trackActionError='';
    setSubtitleLoadingToast(false);
    toasts.dismiss('subtitle-error'); subtitleErrorNotice=undefined;
  }
  observing = false; observationBreak++; playerWaiting = false;
  av1?.destroy(); av1 = undefined;
  clearTimeout(hlsRecoveryTimer); hlsRecoveryCount = 0; $('acceleration-help').hidden = true;
  if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = undefined; frameStartedAt = undefined; videoFrames = 0;
  presentationTiming.reset();
  dropVolume(); video.pause(); stopHls(reason);
  video.removeAttribute('src'); video.removeAttribute('crossorigin'); video.load(); mediaVersion = mediaSource = readyVersion = readinessSent = undefined; readyQueued = false;
  playbackError = ''; autoplayBlocked = false;
  $('join-playback').hidden = true;
  const isEnding = !!(state && !state.mediaUrl && state.ending);
  stage.classList.toggle('ending-active', isEnding);
  $('ending-stage').hidden = !isEnding;
  $('empty-stage').hidden = isEnding;
  if (isEnding) renderEnding(state);
  $('ready-status').textContent = '';
}
function stopHls(reason) {
  if(hls)diagnosticSample('hls-stop',{reason});
  clearTimeout(hls?.refreshRetryTimer);
  clearTimeout(hlsRecoveryTimer);
  hlsNetworkRetries = 0; hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  const client = hls; hls = undefined; client?.destroy();
}
function restartHlsForSeek(target) {
  if(sync.timelinePending)return;
  if (!hls || !hlsNetworkInterrupted || state?.mediaUrl !== mediaSource || uburoomPlayback.bufferedAhead(video.buffered,target) > .05) return;
  // A new authorized room seek supersedes the old segment's retry timer.
  // stopLoad keeps MediaSource and its cached ranges attached.
  clearTimeout(hlsRecoveryTimer); hlsNetworkRetries = 0;
  if (playbackError === hlsNetworkFailure) playbackError = '';
  hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  hls.stopLoad(); hls.startLoad(target);
}
async function refreshHlsSession(client) {
  if (hls !== client || state?.format !== 'hls' || state.mediaUrl !== mediaSource || hlsRefreshPending) return;
  if (pending || qualityPending) {
    if (client.refreshRetryTimer) return;
    const room = selected, version = state.mediaVersion, stream = state.streamVersion;
    client.refreshRetryTimer = setTimeout(() => {
      client.refreshRetryTimer = undefined;
      if (hls === client && selected === room && state?.mediaVersion === version && state?.streamVersion === stream) void refreshHlsSession(client);
    }, 200);
    return;
  }
  if (hlsRefreshVersion !== state.mediaVersion) { hlsRefreshVersion = state.mediaVersion; hlsRefreshTimes = []; }
  const now = Date.now(); hlsRefreshTimes = hlsRefreshTimes.filter(time => now-time < 60000);
  if (hlsRefreshTimes.length >= 3) return;
  hlsRefreshTimes.push(now); hlsRefreshPending = true;
  diagnosticSample('stream-refresh');
  const version = state.mediaVersion, streamVersion = state.streamVersion;
  try {
    await execute({action:'media.stream.refresh',args:{mediaVersion:version,streamVersion}});
    diagnosticSample('stream-refresh-ok');
  } catch {
    diagnosticSample('stream-refresh-failed');
    if (state?.directHls && state?.streamVersion === streamVersion) void proxyDirectFile();
    // The old buffered media can still play. HLS's bounded network retry
    // reports an error if delivery does not return in time.
  } finally { hlsRefreshPending = false; }
}
function handleHlsFragmentBuffered(client) {
  if (hls !== client || !state?.state || state.mediaUrl !== mediaSource) return;
  if(sync.timelinePending) {
    // Plex advertises estimated segment durations. Starting a fresh transmuxer
    // in the middle normalizes its first PTS against that estimate, moving the
    // actual pictures relative to currentTime. Anchor every private stream at
    // segment zero before seeking, keeping that origin for the stream lifetime.
    const target=expected();sync.anchor(target);
    if(target>.65) {
      client.startLoad(target);
    }
    client.resumeBuffering();
    void sync.synchronize();
  }
  // A buffered fragment from an obsolete seek does not establish that the
  // shared playback position can advance again.
  const target = expected(), ahead = uburoomPlayback.bufferedAhead(video.buffered,target);
  if (ahead <= .05 || ahead + .05 < Math.min(.5,Math.max(0,state.state.duration - target))) return;
  clearTimeout(hlsRecoveryTimer);
  const resume = !!hlsNetworkFailure && playbackError === hlsNetworkFailure;
  hlsNetworkRetries = 0; hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  if (resume) {
    diagnosticSample('buffer-recovered');
    playbackError = '';
    fail('');
    void sync.synchronize();
  }
}
function handleHlsError(client, data) {
  if (hls !== client) return;
  const detail = data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET ? 'reset' :
    data.error?.name === 'QuotaExceededError' ? 'quota-exceeded' :
    data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR ? 'buffer-append' :
    /^frag/.test(data.details) ? 'fragment' :
    /^manifest/.test(data.details) ? 'manifest' : 'other';
  diagnosticSample('hls-error',{fatal:!!data.fatal,status:data.response?.code,
    category:data.type===Hls.ErrorTypes.NETWORK_ERROR?'network':data.type===Hls.ErrorTypes.MEDIA_ERROR?'media':'other',
    detail});
  if(state?.directHls && data.fatal && data.type===Hls.ErrorTypes.NETWORK_ERROR) {
    client.stopLoad();
    if((detail==='fragment' || [404,410].includes(data.response?.code)) && (hlsRefreshVersion!==state.mediaVersion || !hlsRefreshTimes.length)) {
      void refreshHlsSession(client);
    } else void proxyDirectFile();
    return;
  }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    hlsNetworkInterrupted = true;
    // A vanished Plex conversion can be reported as a nonfatal fragment
    // error while hls.js is still spending its own retry budget.
    if ([404, 410].includes(data.response?.code)) void refreshHlsSession(client);
  }
  if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    // Keep already buffered media attached while retrying the current stream.
    // Authorization and grant renewal still run through the normal room poll.
    clearTimeout(hlsRecoveryTimer);
    if (hlsNetworkRetries >= 3) hlsNetworkFailure = 'The video stream could not load. Check the connection and try again.';
    // Three quick retries, then at most three low-frequency recovery attempts.
    // Keep the private stream, tracks and shared timeline; never replay commands.
    if (hlsNetworkRetries < 6) {
      const attempt = hlsNetworkRetries++, delay = attempt < 3 ? 1000 * 2 ** attempt : 15000 * 2 ** (attempt-3);
      diagnostics.record('retry-scheduled',{attempt:attempt+1,delayMs:delay});
      const source = mediaSource, version = state?.mediaVersion, stream = state?.streamVersion, room = selected;
      const retry = () => {
        if (hls !== client || !state?.state || selected !== room || mediaSource !== source || state.mediaUrl !== source ||
          state.mediaVersion !== version || state.streamVersion !== stream) return;
        // Wait for online state and a recent authorized poll before loading.
        if (navigator.onLine === false || performance.now()-receivedAt > 3000) { diagnostics.record('retry-deferred',{attempt:attempt+1,delayMs:delay});hlsRecoveryTimer = setTimeout(retry,delay); return; }
        const target = sync.timelinePending?0:expected();
        if (!Number.isFinite(target) || target < 0 || target >= state.state.duration) return;
        // Once the delivery error pauses local playback, normal synchronization
        // is suspended. Retarget MSE too, or hls.js can refill the old position.
        if (video.readyState >= 1 && Math.abs(video.currentTime-target) > .65) video.currentTime = target;
        diagnosticSample('retry-start',{attempt:attempt+1});hlsRecoveryTimer = undefined; client.startLoad(target);
      };
      hlsRecoveryTimer = setTimeout(retry,delay);
    }
    return;
  }
  // hls.js also resets MediaSource internally on nonfatal reset events.
  if (data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET && !data.fatal) {
    if (hlsRecoveryCount++ === 0) return;
  } else if (!data.fatal) return;
  else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && hlsRecoveryCount++ === 0) {
    // Retry the current authorized stream once. No shared command or timeline change.
    hlsRecoveryTimer = setTimeout(() => {
      if (hls === client && state?.mediaUrl === mediaSource) { client.recoverMediaError(); client.startLoad(sync.timelinePending?0:expected()); }
    }, 0);
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR || data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET) {
    void compatibleFallback('H.264 decoder failed.'); return;
  }
  stopHls('fatal');
  playbackError = data.type === Hls.ErrorTypes.MEDIA_ERROR ?
    'The browser could not decode the video stream (' + data.details + '). Try enabling hardware acceleration or use the website.' :
    'The video stream could not load (' + data.details + '). Check the connection and try again.';
  fail(playbackError);
}
function unavailable(message,reason='room-unavailable') {
  unavailableToasts();
  clearTimeout(disconnectGraceTimer); disconnectGraceTimer = undefined;
  disconnectExtended = false; hideDisconnectToast();
  reconnecting=false;
  qualityPending=false;
  playbackClock.reset();
  if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
  clearPlayer(reason); state = undefined; 
  browseRoom = undefined; renderBrowsing();
  renderVisibility(); renderTransport(); document.title = 'uburoom watch'; fail(message);
}
function connectionLost(details={}) {
  diagnostics.record('control-disconnected',{socketCloseCode:details.code});
  if(transport?.ready)transport.interrupt(1000);
  if(reconnecting)return;
  reconnecting=true;stateRequestSequence++;stateTransportSequence=0;
  playbackClock.reset();resetSyncQuality();queueUI.rememberPosition();
  
  if(state)state={...state,enabled:false,reachable:false};
  renderTransport();renderBrowsing();renderVisibility();
  document.title=document.title.replace(/^🟢 /,'');
  clearTimeout(disconnectGraceTimer);
  disconnectGraceTimer=setTimeout(()=>{
    if(!reconnecting)return;
    const buffered=uburoomPlayback.bufferedAhead(video.buffered,video.currentTime);
    if(buffered>2){
      disconnectExtended=true;
      diagnostics.record('disconnect-extended',{bufferAhead:buffered});
      hls?.stopLoad();
      showDisconnectToast();
    } else {
      diagnostics.record('disconnect-expired',{bufferAhead:buffered});
      fullPlayerClear();
    }
  },DISCONNECT_GRACE_MS);
}
function showDisconnectToast() {
  toasts.show('reconnect', { title: 'Disconnected from room', hint: 'Reconnecting…', symbol: 'refresh', loading: true });
}
function hideDisconnectToast() {
  toasts.dismiss('reconnect');
}
function fullPlayerClear() {
  clearTimeout(disconnectGraceTimer);disconnectGraceTimer=undefined;
  disconnectExtended=false;hideDisconnectToast();
  clearPlayer('control-disconnected');
  if(selected){$('empty-title').textContent='Reconnecting to your room…';$('empty-hint').textContent='Your library and queue position are kept.';}
  fail('Disconnected. Reconnecting…');
}
async function unlockLocal() {
  if (!state?.mediaUrl || video.readyState < 2 || probing || playbackError || sync.timelinePending) return false;
  const version = state.mediaVersion, source = mediaSource; probing = true; let playTimer;
  try {
    await Promise.race([video.play(), new Promise((resolve,reject) => { playTimer = setTimeout(() => {
      if (state?.mediaVersion === version && mediaSource === source) video.pause();
      reject(new DOMException('Playback is still buffering','AbortError'));
    }, 8500); })]);
    clearTimeout(playTimer);
    const until = performance.now() + 8500;
    while ((decodedFrames() === 0 || !video.videoWidth) && performance.now() < until && state?.mediaVersion === version && mediaSource === source && !video.error) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (state?.mediaVersion !== version || mediaSource !== source) return false;
    if (decodedFrames() === 0 || !video.videoWidth) { void compatibleFallback('No video frames were decoded.'); return false; }
    readyVersion = version; autoplayBlocked = false;
    if (state.state.paused) video.pause();
    return true;
  } catch (error) {
    if (state?.mediaVersion === version && error.name === 'NotAllowedError') autoplayBlocked = true;
    return false;
  } finally { clearTimeout(playTimer); probing = false; renderTransport(); }
}
async function execute(command) {
  if(reconnecting||!transport?.ready)throw new Error('Reconnecting. Wait for the room connection.');
  if(switchingRoom)throw new Error('Wait for the room to open.');
  if (!selected || !state || pending) throw new Error('Wait for an available viewing room');
  const qualityChange=command.action==='media.quality.set', volumeChange=command.action==='media.volume.set';
  if(volumeChange && volumePending)throw new Error('Wait for your volume update to finish.');
  if(qualityPending && ['media.quality.set','media.tracks.set','media.stream.refresh','media.load','media.next','media.previous'].includes(command.action))throw new Error('Wait for your quality change to finish.');
  if ((command.action === 'media.play' || command.action === 'media.toggle' && !state.waitingForReady) && state.state.paused &&
      (autoplayBlocked || readyVersion !== state.mediaVersion) && expected() < state.state.duration - .1) await unlockLocal();
  const id = selected, epoch = state.epoch, qualityRequest=qualityChange?{}:undefined;
  if(qualityChange)qualityPending=qualityRequest;else if(volumeChange)volumePending=true;else pending=true;
  fail('');renderTransport();
  diagnosticSample('command-start',{action:command.action});
  try {
    const timing=playbackClock.read();
    if(!timing.valid)throw new Error('Playback timing is refreshing. Retry the control after the next room update.');
    const preparing = qualityChange || state?.durable && ['media.load','media.next','media.previous','queue.history.replay','queue.playNow'].includes(command.action);
    const result = await api('/api/watch/rooms/' + id + '/command', { viewerId, epoch, expiresAt: timing.serverTime + 2500, command },preparing?{timeoutMs:35000}:{});
    if (selected !== id) return { status: 'unavailable' };
    if (result.status !== 'applied') throw new Error(result.message);
    diagnostics.record('command-ok',{action:command.action});
    if(command.action==='media.volume.set')savePlayerPreferences({volume:command.args.percent,muted:false});
    if(['media.mute','media.unmute'].includes(command.action))savePlayerPreferences({muted:command.action==='media.mute'});
    await refreshState(); if (command.action === 'room.visibility') await refreshRooms(); return result;
  } catch(error) {
    diagnostics.record('command-failed',{action:command.action});
    if(qualityChange&&selected===id)await refreshState();
    throw error;
  }
  finally {
    if(qualityChange){if(qualityPending===qualityRequest)qualityPending=false;}else if(volumeChange)volumePending=false;else pending=false;
    if(qualityChange&&selected===id&&state?.mediaUrl)$('quality').value=uburoom.qualityId(state.quality);
    renderLibrary(); renderVisibility(); renderTransport(); pumpVolume();
  }
}
function renderMediaInformation(next) {
  if (!next) return;
  const info=next.deliveryInfo;
  const mediaWidth=video.videoWidth || info?.width,mediaHeight=video.videoHeight || info?.height;
  $('media-information').textContent=info?[mediaWidth&&mediaHeight?mediaWidth+' x '+mediaHeight:null,info.videoCodec?.toUpperCase(),info.audioCodec?.toUpperCase(),info.bitrate?Number(info.bitrate/1000).toFixed(1)+' Mbps':null].filter(Boolean).join(' / '):'Choose a video to see media information.';
  $('delivery-information').textContent=info?[info.format==='file'?'Original file':info.format==='hls'?'Plex streaming':uburoomPlayback.localFormat(info.format)?'uburoom conversion':info.format,next.mediaUrl?(next.directDelivery?'Direct from Plex':'Through uburoom'):null,info.encoder?'Encoder: '+info.encoder:null,info.cpuFallback?'Using CPU fallback':null,info.bitrateCeiling?'Requested limit: '+Number(info.bitrateCeiling/1000).toFixed(1)+' Mbps':null].filter(Boolean).join(' / '):'No playback delivery yet.';
}
function renderVisibility() {
  $('empty-hint').hidden=!me;
  document.body.classList.toggle('outside-room', !state); document.body.classList.toggle('idle-player',!state?.mediaId);
  $('current-room').hidden = !state;
  $('rooms').hidden = true;
  $('refresh').hidden = true;
  $('room-bar').hidden = !me && $('auth-overlay').hidden;
  $('switch-room').textContent = state ? 'Switch room' : 'Choose room';
  $('switch-room').hidden=!!config?.singleRoom;
  $('create').hidden = !!state||!!config?.singleRoom;
  if(config?.singleRoom)for(const id of ['lobby-create','lobby-reopen','room-chooser-new'])$(id).hidden=true;
  if ($('options-title')) $('options-title').textContent = state ? (state.roomName || 'Room') : 'Room';
  if (state) {
    if ($('current-room-name')) $('current-room-name').textContent = state.roomName || 'Room';
    uburoomControls.content($('room-visibility'),{icon:state.visibility === 'private' ? 'lock' : 'website',label:state.visibility === 'private' ? 'Private · Hosts only' : 'Public',iconOnly:true});
    $('room-visibility').setAttribute('aria-pressed', String(state.visibility === 'private'));
    $('room-visibility').classList.toggle('private', state.visibility === 'private');
    $('room-visibility').disabled = pending || !state.canManage;
    $('room-visibility').title = pending ? 'Updating visibility...' : !state.canManage ? 'Only authorized room managers can change visibility' : 'Change room visibility';
    uburoomControls.content($('room-people-open'),{icon:'users',label:state.viewers + ' / ' + (state.maxMembers || 20)});
    $('room-people-open').classList.remove('watch-control-responsive');
    $('room-people-open').setAttribute('aria-label','People: ' + state.viewers + ' / ' + (state.maxMembers || 20));
  }
  roomUI.render();
  queueUI.render(state?.queueSummary);
  for(const id of ['options-panel','queue-panel','library-panel'])$(id).inert=!me;
  $('options-panel').hidden = !me && $('auth-overlay').hidden;
  if ($('watch-settings')) {
    $('watch-settings').hidden = !state || !state.canManage;
    $('watch-settings').inert = !state;
    $('watch-settings').setAttribute('aria-disabled', String(!state));
  }
  $('admin-end-room').hidden = true;
  updateSectionTabs();
}
async function changeVisibility() {
  if (!state?.canManage || pending || $('privacy-dialog').open) return;
  const id = selected;
  if (state.visibility === 'public') {
    const dialog = $('privacy-dialog');
    const accepted = new Promise(resolve => dialog.addEventListener('close',()=>resolve(dialog.returnValue === 'private'),{once:true}));
    uburoomDialogs.open(dialog);
    if (!await accepted || selected !== id || state?.visibility !== 'public' || !state?.canManage) return;
    await execute({action:'room.visibility',args:{visibility:'private'}});
  } else await execute({action:'room.visibility',args:{visibility:'public'}});
}
$('room-visibility')?.addEventListener('click', () => changeVisibility().catch(error=>fail(error.message)));
function renderTransport() {
  const available = !reconnecting && !!state?.mediaUrl, playback = available && state.canPlayback;
  for (const id of ['player-play','previous','seek-back','seek-forward']) $(id).disabled = !playback || pending;
  $('timeline').disabled = !playback;
  if (state?.durable) {
    for (const id of ['seek-back','seek-forward']) $(id).disabled = !available || !state.capabilities.seek || pending;
    $('timeline').disabled = !available || !state.capabilities.seek;
    $('previous').disabled = !available || !state.capabilities.chooseMedia || pending;
  }
  $('player-mute').disabled = !available || pending; $('player-volume').disabled = !available;
  $('next').disabled = !playback || !state?.hasNext || pending;
  if (state?.durable) $('next').disabled = !available || !state.hasNext || !state.capabilities.chooseMedia || pending;
  $('quality').disabled = !available || state?.mediaId === 'demo' || pending || qualityPending;
  const paused = !!state?.pauseAt || state?.state.paused !== false && !state?.waitingForReady;
  $('stage').classList.toggle('paused', state?.state.paused !== false); $('stage').classList.toggle('blocked', autoplayBlocked);
  glyph('player-play', paused ? 'play' : 'pause'); $('player-play').setAttribute('aria-label', paused ? 'Play' : 'Pause'); $('player-play').title = paused ? 'Play' : 'Pause';
  const isMuted = !!state?.state?.muted;
  renderVolumeIcon(); $('player-mute').setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
  $('player-mute').title = isMuted ? 'Unmute' : 'Mute';
  $('player-mute').setAttribute('aria-pressed', isMuted ? 'true' : 'false');
  const joinDisabled = !autoplayBlocked && (!playback || pending);
  $('join-playback').disabled = joinDisabled;
  $('join-playback').hidden = !state?.mediaUrl || !!state?.readiness?.timedOut || joinDisabled;
  const centerLabel=autoplayBlocked?'Join playback':paused?'Play':'Pause';
  glyph('join-playback',autoplayBlocked||paused?'play':'pause');
  $('join-playback').setAttribute('aria-label',centerLabel); $('join-playback').title=centerLabel;
  $('ready-status').textContent = state?.waitingForReady ? autoplayBlocked ? 'Press Play to join playback' : 'Waiting for viewers…' : autoplayBlocked ? 'Press Play to join playback' :
    state?.startAt>state?.serverNow && (playbackClock.read().serverTime??state.serverNow)<state.startAt ? 'Starting together…' : '';
  if (state?.readiness?.blockers.length) $('ready-status').textContent = 'Waiting for ' + state.readiness.blockers.join(', ') + '…';
  if (state?.readiness?.timedOut) $('ready-status').textContent = (state.durable ? state.capabilities?.chooseMedia : state.canManage) ? 'Some viewers need more time. Choose how to continue.' : 'Waiting for the host to choose how to continue.';
  if (state?.waitingForHost) $('ready-status').textContent = 'Playback is paused until a room leader or host joins.';
  $('room-recovery').hidden = !state?.recovery;
  if (state?.recovery) $('room-recovery-message').textContent = 'Waiting for ' + state.recovery.missing + ' people / ' + Math.max(0,Math.ceil((state.recovery.until - (Date.now() + offset))/1000)) + ' seconds remaining. Playback is paused.';
  $('room-recovery-start').hidden = !state?.canPlayback;
  $('room-recovery-start').disabled = pending || !state?.mediaUrl;
  $('readiness-choice').hidden = !!state?.recovery || !state?.readiness?.timedOut || !(state.durable ? state.capabilities?.chooseMedia : state.canManage);
  $('readiness-title').textContent = state?.readiness?.blockers.length ? 'Some viewers need more time' : 'Ready to continue?';
  $('readiness-message').textContent = state?.readiness?.blockers.length ? 'Waiting for ' + state.readiness.blockers.join(', ') + '. Start with ready viewers, or wait.' : 'Everyone is ready. Playback stays paused until you choose.';
  $('ready-start').disabled = pending || !state?.readiness?.canStart;
  $('ready-wait').disabled = $('ready-cancel').disabled = pending;
  if (state?.readiness?.timedOut) $('player-play').disabled = true;
  if (!volumeDragging) $('player-volume').value = volumeDraft ?? state?.state.volume ?? playerPreferences.volume;
  renderTracks();
}
function renderTracks() {
  const tracks=state?.tracks, available=!!tracks;
  const render=(id,rows,choices,value)=>{
    const options=[...choices,...(rows || []).map(row=>({id:row.id,label:[uburoomPlayerUI.trackLabel(row),row.title].filter(Boolean).join(' — '),disabled:!row.available}))];
    const element=$(id), signature=JSON.stringify(options);
    if(element.dataset.options!==signature){element.replaceChildren(...options.map(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=row.label;option.disabled=!!row.disabled;return option;}));element.dataset.options=signature;}
    const hasTracks=rows?.some(row=>row.available);
    element.value=value || 'auto';
    if(element.selectedIndex<0)element.value='auto';
    element.disabled=!available || !hasTracks || pending || qualityPending;
    element.title=hasTracks?'':id==='audio-track'?'No audio available':'No subtitles available';
  };
  const audioAvailable=tracks?.audio.some(row=>row.available), subtitlesAvailable=tracks?.subtitles.some(row=>row.available);
  render('audio-track',tracks?.audio,[{id:'auto',label:'Automatic'}],tracks?.audioChoice);
  render('subtitle-track',tracks?.subtitles,[{id:'auto',label:'Automatic'},...(subtitlesAvailable?[{id:'off',label:'Off'}]:[])],tracks?.subtitleChoice);
  const audio=tracks?.audio.find(row=>row.id===tracks.audioId), subtitle=tracks?.subtitles.find(row=>row.id===tracks.subtitleId), delivery=tracks?.subtitleDelivery || subtitle?.delivery,burned=delivery==='burn';
  subtitleMode.value=tracks?.subtitleMode || 'auto';subtitleMode.disabled=!available || pending || qualityPending || !subtitle;
  $('audio-track-status').textContent=!audioAvailable?'No audio available':audio ? [uburoomPlayerUI.trackLabel(audio),state.format!=='file' && audio.channels!==2 && 'Stereo playback'].filter(Boolean).join(' · ') : '';
  for (const [id,track] of [['audio-track-name',audio],['subtitle-track-name',subtitle]]) { $(id).textContent=track?.title || ''; $(id).hidden=!track?.title; }
  if(!subtitlesAvailable){$('subtitle-track-name').textContent='No subtitles available';$('subtitle-track-name').hidden=false;}
  if(document.activeElement!==$('subtitle-offset'))$('subtitle-offset').value=tracks?.subtitleOffset || 0;
  $('subtitle-offset').disabled=!available || pending || !subtitle || burned;
  $('subtitle-delay-hint').textContent=burned ? 'Timing is fixed by Plex for subtitles included in the video.' : subtitle ? 'Positive values show subtitles later.' : 'Select subtitles to adjust their timing.';
  $('track-status').textContent=trackActionError || tracks?.subtitleError || trackNotice || (burned ? 'Plex includes these subtitles in the video to preserve their appearance and saves the choice for this title.' : '');
  const error=!!trackActionError || !!tracks?.subtitleError || trackNoticeError;
  $('track-status').classList.toggle('error',error);
  const subtitleError=tracks?.subtitleError || (trackNoticeError ? trackNotice || 'subtitle-renderer-error' : undefined);
  const notice=subtitleError ? JSON.stringify([state?.mediaVersion,tracks?.subtitleId,subtitleError]) : undefined;
  if(notice && notice!==subtitleErrorNotice) {
    toasts.show('subtitle-error', {type:'error',title:'Subtitles could not be shown.',hint:'Open Player settings for details.',symbol:'subtitles-off'});
  }
  subtitleErrorNotice=notice;
  $('subtitle-retry').hidden=!trackNoticeError || !state?.subtitleUrl;
  playerUI?.render();
}
async function changeTrack(args,context=trackContext) {
  if(!state || pending || qualityPending || !context || context.mediaVersion!==state.mediaVersion || context.streamVersion!==state.streamVersion)return;
  trackActionError='';
  try { const result=await execute({action:'media.tracks.set',args:{...context,...args}}); if(result.status==='applied')rememberPlayerSubtitles(args); }
  catch(error){trackActionError=error.message;fail(error.message);}
  finally{renderTracks();}
}
$('audio-track').addEventListener('change',()=>void changeTrack({audioId:$('audio-track').value}));
$('subtitle-track').addEventListener('change',()=>void changeTrack({subtitleId:$('subtitle-track').value}));
$('subtitle-offset').addEventListener('change',()=>{if($('subtitle-offset').reportValidity())void changeTrack({subtitleOffset:$('subtitle-offset').valueAsNumber});});
subtitleMode.addEventListener('change',()=>void changeTrack({subtitleMode:subtitleMode.value}));
$('subtitle-retry').addEventListener('click',()=>captions.retry());
function expected() {
  const timing=playbackClock.read();
  return uburoomTiming.target(state,timing.serverTime) ?? arrivalExpected();
}
function arrivalExpected() {
  if (!state) return 0;
  return Math.min(state.state.duration || 0, state.state.position + (state.state.paused ? 0 : (performance.now() - receivedAt) / 1000));
}
async function reportObservation() {
  if (observationPending || !observing || !selected || !state?.mediaUrl || !state.streamVersion || mediaSource !== state.mediaUrl) return;
  const id = selected;
  const playerState = playbackError || video.error ? 'error' : autoplayBlocked ? 'blocked' : video.ended ? 'ended' : video.seeking ? 'seeking' :
    probing ? 'buffering' : video.paused ? 'paused' : playerWaiting || video.readyState < 3 ? 'buffering' : 'playing';
  const sampleAt=performance.now(), observedAt=observationClock.sample(sampleAt);
  if(observedAt===undefined){diagnostics.record('observation-uncredited',{creditReason:'clock-unavailable'});return;}
  const data = {viewerId,epoch:state.epoch,mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,observationEpoch:state.observationEpoch,
    sequence:++observationSequence,sampleAt,observedAt,position:video.currentTime,
    rate:video.playbackRate,frames:uburoomPlayback.observationFrames(video,videoFrames),discontinuity:observationBreak,state:playerState};
  observationPending = true;
  try {
    const result=await api('/api/watch/rooms/' + id + '/observe',data);
    if(result.credit && result.credit.reason!=='credited')diagnostics.record('observation-uncredited',{...result.credit,creditReason:result.credit.reason});
  }
  catch { /* Never replay an observation after reconnect. The next sample is fresh. */ }
  finally { observationPending = false; }
}
for (const event of ['playing','pause','waiting','seeking','seeked','ended','error']) video.addEventListener(event, () => {
  if (event === 'waiting') playerWaiting = true;
  if (event === 'playing' || event === 'seeked') playerWaiting = false;
  if(['pause','waiting','seeking','seeked','ended','error'].includes(event)) {
    syncQuality.breakSample();
  }
  // Periodic samples include rate corrections; assigning playbackRate can
  // emit ratechange even when the rate is unchanged.
  if (event !== 'ended' && !(event === 'pause' && video.ended)) observationBreak++;
  void reportObservation();
});
setInterval(() => { void reportObservation(); },1000);
setInterval(refreshSyncQuality,1000);
async function reportReadiness() {
  if (!selected || !state?.mediaUrl) return;
  if (readyPending) { readyQueued = true; return; }
  const id = selected, version = state.mediaVersion, readinessVersion = state.readinessVersion;
  const target = expected();
  const bufferedReady = !state.state.paused || !video.seeking && Math.abs(video.currentTime-target) <= (target === 0 ? .25 : readinessVersion ? .15 : .65) &&
    uburoomPlayback.readinessBuffered(video.buffered,target,state.state.duration);
  const ready = bufferedReady && video.readyState >= 3 && decodedFrames() > 0 && readyVersion === version && !playbackError;
  const key = id + ':' + version + ':' + readinessVersion + ':' + ready;
  if (readinessSent === key || !state.readiness && !state.waitingForReady && !ready) return;
  readyPending = true;
  try { await api('/api/watch/rooms/' + id + '/ready', { viewerId, mediaVersion: version,
    ready, readinessVersion }); readinessSent = key; } catch {} finally {
    readyPending = false;
    if (readyQueued) { readyQueued = false; void reportReadiness(); }
  }
}
let unavailableNotices = new Set();
function unavailableToasts(items = []) {
  const ids = new Set(items.map(item => 'unavailable:' + item.id));
  for (const id of unavailableNotices) if (!ids.has(id)) toasts.dismiss(id);
  for (const item of items) {
    const id = 'unavailable:' + item.id;
    if (!unavailableNotices.has(id)) toasts.show(id,{type:'error',title:item.title + ' is unavailable.',symbol:'film',persistent:true});
  }
  unavailableNotices = ids;
}
function applyState(next) {
  if(next.id!==selected||next.transportSequence<=stateTransportSequence)return;
  stateTransportSequence=next.transportSequence;
  clearTimeout(disconnectGraceTimer);disconnectGraceTimer=undefined;
  const wasExtended=disconnectExtended;disconnectExtended=false;hideDisconnectToast();
  const resumed=reconnecting;reconnecting=false;
  sync.transition(next);
  diagnostics.state(next);
  const mediaChanged = mediaVersion !== next.mediaVersion || !next.mediaUrl;
  const changed = mediaChanged || mediaSource !== next.mediaUrl;
  const qualityContextChanged = !!state && (state.mediaVersion !== next.mediaVersion || state.streamVersion !== next.streamVersion || state.id !== next.id || state.epoch !== next.epoch);
  if(qualityContextChanged && !changed){resetSyncQuality();choppyDetector.interrupt();}
  const previousTarget = state ? expected() : undefined,previousRevision=state?.revision;
  if(trackContext && trackContext.mediaVersion!==next.mediaVersion){playerUI.reset();$('tracks-dialog').close();trackContext=undefined;}
  if (state && state.epoch !== next.epoch) dropVolume();
  state = next; receivedAt = performance.now();
  unavailableToasts(next.unavailableMedia);
  if(playerUI.settingsOpen())trackContext={mediaVersion:next.mediaVersion,streamVersion:next.streamVersion};
  if (changed) {
    clearPlayer('state-change', !mediaChanged); mediaVersion = next.mediaVersion; mediaSource = next.mediaUrl;
    if (next.mediaUrl) {
      stage.classList.remove('ending-active');
      $('ending-stage').hidden = true;
      $('empty-stage').hidden = true;
      watchFrames();
      if (next.format === 'file' && uburoomPlayback.needsCompatible(next,type => video.canPlayType(type))) {
        queueMicrotask(() => { if (state === next) void compatibleFallback('The browser does not support the original codecs.',true); });
      } else if (uburoomPlayback.localFormat(next.format)) {
        try { av1 = new uburoomAV1(video, next.mediaUrl, expected, message => { void compatibleFallback(message); }); }
        catch (error) { void compatibleFallback('Converted WebM transport unavailable: '+error.message); }
      } else if (next.format === 'hls' && Hls.isSupported()) {
        sync.prepare({timeline:true});
        const config=uburoomPlayback.hlsConfig(next.bitrate || next.bitrateCeiling,!!next.directHls);
        if(next.directHls) {
          // FetchLoader rejects redirects and adds only this viewer's temporary
          // credential to resources under the pinned Plex output session.
          config.progressive=true;
          config.fetchSetup=(context,init)=>{
            try {
              const url=new URL(context.url,location.href);
              const target=url.href===new URL(next.mediaUrl,location.href).href?url.href:uburoomPlayback.directHlsUrl(url.href,next.directHls);
              return new Request(target,{...init,credentials:url.origin===location.origin?'same-origin':'omit',redirect:'error',referrerPolicy:'no-referrer'});
            }catch{return Promise.reject(new Error('Direct Plex resource unavailable'));}
          };
        }
        const client = hls = new Hls(config);
        client.on(Hls.Events.ERROR, (_, data) => handleHlsError(client, data));
        // Finish appending the anchor without requesting segment one before
        // the target seek; aborting that speculative load adds recovery noise.
        client.on(Hls.Events.FRAG_LOADED,()=>{if(hls===client&&sync.timelinePending)client.pauseBuffering();});
        client.on(Hls.Events.FRAG_BUFFERED, () => handleHlsFragmentBuffered(client));
        client.on(Hls.Events.BUFFER_FLUSHING, (_, data) => {
          if (hls === client) diagnosticSample('hls-buffer-flushing', { target: data.startOffset, position: data.endOffset });
        });
        client.loadSource(next.mediaUrl); client.attachMedia(video);
        if(next.directHls)directStartupTimer=setTimeout(()=>{
          if(hls===client && state?.streamVersion===next.streamVersion && video.readyState<2)void proxyDirectFile();
        },12000);
      } else if (next.directHls) queueMicrotask(()=>{if(state===next)void proxyDirectFile();});
      else if (next.directDelivery) void attachDirectFile(next);
      else video.src = next.mediaUrl;
    }
  }
  const nextTarget=expected();
  if(!changed&&previousRevision!==undefined&&previousRevision!==next.revision&&previousTarget!==undefined&&nextTarget!==undefined&&Math.abs(nextTarget-previousTarget)>.05)
    sync.suppressCorrectionTelemetry(5000);
  if (!changed && !sync.timelinePending && previousTarget !== undefined && Math.abs(nextTarget-previousTarget) > 1.5) {
    sync.sharedSeek();
    if(sync.preparationUntil&&hls){hls.startLoad(expected());}
    else restartHlsForSeek(expected());
  } else if (wasExtended && !changed && hls) {
    hls.startLoad(expected());
  }
  captions.update(next);
  queueMicrotask(()=>{if(state===next)void restorePlayerSubtitles(next);});
  if(next.mediaError)playbackError=next.mediaError;
  const picture = next.state.picture;
  video.style.scale = picture.zoom * picture.stretchX + ' ' + picture.zoom * picture.stretchY;
  video.style.translate = picture.x * 100 + '% ' + picture.y * 100 + '%';
  const isIdle = !next.mediaUrl;
  const isEnding = isIdle && !!next.ending;
  stage.classList.toggle('ending-active', isEnding);
  $('ending-stage').hidden = !isEnding;
  $('empty-stage').hidden = !isIdle || isEnding;
  if (isEnding) renderEnding(next);
  else renderEnding({ ending: null });
  $('title').textContent = isIdle ? (next.roomName || 'Room') : next.title; $('details').textContent = isIdle ? '' : next.subtitle;
  $('viewers').textContent = next.viewers + (next.viewers === 1 ? ' viewer' : ' viewers');
  $('viewers').title = (next.roomName ? next.roomName + ' · ' : '') + 'Live controller: ' + next.hostName;
  $('empty-title').textContent = 'Choose something to watch…'; $('empty-hint').textContent = '...or he\'ll be watching you.';
  $('empty-browse').hidden = !isIdle || !next.canBrowse;
  $('close-room').hidden = !!config?.singleRoom;
  $('timeline').max = next.state.duration || 60; $('duration').textContent = clock(next.state.duration);
  $('quality-notice').textContent=next.qualityNotice || '';
  renderMediaInformation(next);
  const choices = next.qualities || uburoom.QUALITIES;
  if (JSON.stringify([...$('quality').options].map(o => [o.value,o.textContent])) !== JSON.stringify(choices.map(q => [q.id,q.label]))) {
    const previous=$('quality').value;
    $('quality').replaceChildren(...choices.map(q => { const option = document.createElement('option'); option.value = q.id; option.textContent = q.label; return option; }));
    if(choices.some(q=>q.id===previous))$('quality').value=previous;
  }
  if (next.mediaUrl && !pending && !qualityPending && document.activeElement !== $('quality')) $('quality').value = uburoom.qualityId(next.quality);
  renderBrowsing();
  const transformed = Object.keys(uburoom.DEFAULT).some(key => Math.abs(picture[key] - uburoom.DEFAULT[key]) > 1e-8);
  document.title = (transformed ? '🔵 ' : '') + next.title + ' · uburoom';
  renderVisibility(); renderTransport();
  if(resumed){queueUI.restorePosition();diagnostics.record('control-reconnected');}
  if (next.feedback && next.feedback.revision !== lastFeedback && Date.now() + offset - next.feedback.at < 3000) {
    lastFeedback = next.feedback.revision;
    const details = uburoomWatchFeedback.badgeDetails(next.feedback, next.state);
    if (details) {
      toasts.show('participant', {
        title: details.label + (details.value && details.value !== details.label ? ' ' + details.value : ''),
        hint: next.feedback.sender,
        symbol: details.symbol, seekSeconds: details.seekSeconds, duration: 2500
      });
    }
  }
  observing = !!next.mediaUrl;
  void sync.synchronize();
}
async function refreshState() {
  if (!selected) return;
  const id = selected, before = Date.now(), sent=performance.now(), exchange=playbackClock.begin(), sequence=++stateRequestSequence;
  try {
    const next = await api('/api/watch/rooms/' + id + '?'+new URLSearchParams(viewerPreferences())); if (id !== selected || sequence!==stateRequestSequence || next.transportSequence<=stateTransportSequence) return;
    playbackClock.add(exchange,next.timing);
    diagnostics.record('clock-sample',{...playbackClock.read(),requestRttMs:performance.now()-exchange.sent,serverProcessingMs:next.timing?.serverProcessingMs});
    const revision=observationClock.update(next.observationEpoch,next.serverNow,sent,performance.now());
    if(revision!==observationClockRevision){observationBreak++;observationClockRevision=revision;}
    offset = next.serverNow - (before + Date.now()) / 2; applyState(next); fail(playbackError); void reportReadiness();
  } catch (error) { if (id === selected && sequence===stateRequestSequence) {
    if(!error.status||error.status>=500)connectionLost();
    else unavailable(error.message,'room-poll');
  } }
}
async function selectRoom(id,initial) {
  clearTimeout(disconnectGraceTimer);disconnectGraceTimer=undefined;
  disconnectExtended=false;hideDisconnectToast();
  if (id === selected) return;
  if(switchingRoom)throw new Error('Wait for the room to open.');
  switchingRoom=true;
  const previous=selected;
  try {
    const exchange=playbackClock.begin();
    const next=initial||await api('/api/watch/rooms/'+id+'?'+new URLSearchParams(viewerPreferences()));
    if(next.id!==id)throw new Error('Room changed while opening. Try again.');
    qualityPending=false;
    stateTransportSequence=0;
    stateRequestSequence++;
    if(!initial)playbackClock.add(exchange,next.timing);
    const now=performance.now(),revision=observationClock.update(next.observationEpoch,playbackClock.read().serverTime??next.serverNow,now,now);
    if(revision!==observationClockRevision){observationBreak++;observationClockRevision=revision;}
    if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
    clearPlayer('room-select'); selected = id; state = undefined; lastFeedback = browseRoom = undefined;
    applyState(next);placeRoomBar();fail(playbackError);void reportReadiness();
    if(previous)void api('/api/watch/rooms/'+previous+'/leave',{viewerId}).catch(()=>{});
    if (immersive) toggleDrawer(!!state?.canBrowse && !state?.mediaId);
  } finally {switchingRoom=false;}
}
function renderRooms(host, rooms, join = id => selectRoom(id)) {
  host.replaceChildren();
  if (!rooms.length) {
    const empty = document.createElement('span'); empty.className = 'hint'; empty.textContent = 'No active rooms'; host.append(empty);
  }
  for (const room of rooms) {
    const button = document.createElement('button'); button.type = 'button'; button.disabled = !!room.locked;
    button.append(uburoomIcons.icon(document, room.visibility === 'private' ? 'lock' : 'website'));
    const name = document.createElement('span'); name.textContent = room.name || room.hostName; button.append(name,uburoomIcons.icon(document,'users'));
    const count = document.createElement('span'); count.textContent = room.maxMembers ? room.viewers + ' / ' + room.maxMembers : String(room.viewers); button.append(count);
    button.title = room.locked ? 'Private - No one can join' : room.members?.length ? room.members.join('\n') : 'No viewers yet';
    button.setAttribute('aria-label', (room.name || room.hostName) + (room.visibility === 'private' ? ', private' : '') + ', ' + room.viewers + ' viewers');
    button.setAttribute('aria-pressed', String(room.id === selected)); button.addEventListener('click', () => join(room.id).catch(error => fail(error.message))); host.append(button);
  }
}
async function refreshRooms() {
  try { const { rooms } = await api('/api/watch/rooms'); applyRooms(rooms); }
  catch (error) { if (!state) $('lobby-error').textContent = error.message; throw error; }
}
function applyRooms(rooms) {
  knownRooms=rooms;
  $('lobby-error').textContent='';
  renderRooms($('rooms'), rooms); renderRoomChoices(rooms,$('lobby-rooms'));
  if ($('room-dialog').open && !creating) {
    renderRoomChoices(rooms);
  }
  if (!reconnecting && !switchingRoom && !rooms.some(room => room.id === selected && !room.locked)) {
    if (selected) { selected = undefined; unavailable('Room ended or was made private.'); if (immersive) toggleDrawer(false); }
  }
  $('status').textContent = !config?.singleRoom&&!selected && rooms.length ? 'Choose an active room or create your own.' : '';
  $('create').textContent = 'New room';
  $('create').hidden = !!selected;
  if(config?.singleRoom){
    for(const id of ['create','lobby-create','lobby-reopen','room-chooser-new'])if($(id))$(id).hidden=true;
    $('rooms').hidden=true;
    if(!selected&&transport?.ready&&rooms[0]&&!rooms[0].locked&&!switchingRoom)void selectRoom(rooms[0].id).catch(error=>fail(error.message));
  }
  if (!selected) {
    stage.classList.remove('ending-active');
    $('ending-stage').hidden = true;
    renderEnding({ ending: null });
    $('viewers').textContent = ''; $('close-room').hidden = true; $('empty-browse').hidden = true;
    $('title').textContent = 'Watch together'; $('details').textContent = ''; $('empty-title').textContent = 'Join or create a room'; $('empty-hint').textContent = 'Choose an active room or create your own.'; }
  placeRoomBar();
  renderBrowsing(); renderVisibility();
  if(config?.singleRoom)$('close-room').hidden=true;
}
function renderBrowsing() {
  browseRoom = !transport?.ready && !reconnecting ? undefined : !selected && me ? 'lobby' : state?.canBrowse ? state.id : undefined;
  $('library-panel').hidden = !browseRoom && $('auth-overlay').hidden && (!me || !!state);
  void library.setRoom(browseRoom); library.setBusy(pending||reconnecting);
}
function renderLibrary() {
  library.setBusy(pending||reconnecting);
}
function clock(value = 0) {
  const seconds = Math.floor(value || 0), minutes = Math.floor(seconds / 60);
  return (seconds >= 3600 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2,'0') : minutes) + ':' + String(seconds % 60).padStart(2,'0');
}
function renderVolumeIcon() {
  glyph('player-mute',uburoomIcons.volumeName(volumeDraft ?? state?.state?.volume ?? Number($('player-volume').value),!!state?.state?.muted));
}
function pumpVolume() {
  clearTimeout(volumeTimer);
  if (volumeWanted === undefined || !selected || !state) return;
  const wait = Math.max(0, 500 - (Date.now() - lastVolumeAt));
  if (pending || volumePending || wait) { volumeTimer = setTimeout(pumpVolume, Math.max(100, wait)); return; }
  const percent = volumeWanted; volumeWanted = undefined; lastVolumeAt = Date.now();
  execute({ action: 'media.volume.set', args: { percent } }).then(() => {
    if (volumeWanted === undefined && volumeDraft === percent) volumeDraft = undefined; renderTransport();
  }).catch(error => { dropVolume(); fail(error.message); });
}
$('player-volume').addEventListener('pointerdown', () => { volumeDragging = true; });
$('player-volume').addEventListener('input', () => { volumeWanted = volumeDraft = Number($('player-volume').value); savePlayerPreferences({volume:volumeDraft,muted:false}); renderVolumeIcon(); pumpVolume(); });
$('player-volume').addEventListener('change', () => { volumeDragging = false; volumeWanted = volumeDraft = Number($('player-volume').value); savePlayerPreferences({volume:volumeDraft,muted:false}); renderVolumeIcon(); pumpVolume(); });
$('player-volume').addEventListener('pointercancel', () => { volumeDragging = false; });
for (const [id, command] of [['previous',{action:'media.previous'}],['seek-back',{action:'media.seek.relative',args:{seconds:-15}}],
  ['seek-forward',{action:'media.seek.relative',args:{seconds:15}}],['next',{action:'media.next'}]]) $(id).addEventListener('click', () => execute(command).catch(error => fail(error.message)));
for (const choice of ['start','wait','cancel']) $('ready-' + choice).addEventListener('click', () => {
  void execute({action:'media.ready.' + choice,args:{readinessId:state?.readiness?.id}}).catch(error => fail(error.message));
});
$('player-play').addEventListener('click', () => execute({ action: state?.pauseAt || state?.state.paused && !state?.waitingForReady ? 'media.play' : 'media.pause' }).catch(error => fail(error.message)));
$('player-mute').addEventListener('click', () => execute({ action: state?.state.muted ? 'media.unmute' : 'media.mute' }).catch(error => fail(error.message)));
$('join-playback').addEventListener('click', async () => {
  if (autoplayBlocked) { await unlockLocal(); void reportReadiness(); if (state && !state.state.paused) void sync.synchronize(); }
  else $('player-play').click();
});
$('quality').addEventListener('change', () => {
  preferredQuality = $('quality').value;
  savePlayerPreferences({quality:preferredQuality});
  choppyDetector.triggerCooldown(10000, performance.now());
  if (choppyToastActive) { toasts.dismiss('choppy', false); choppyToastActive = false; }
  if (state?.mediaId && state.mediaId !== 'demo') execute({ action: 'media.quality.set', args: { quality: preferredQuality } }).catch(error => fail(error.message));
});
$('timeline').addEventListener('pointerdown', () => { seekDragging = true; });
$('timeline').addEventListener('input', () => { $('time').textContent = clock($('timeline').value); });
$('timeline').addEventListener('change', () => { const seconds = Number($('timeline').value); seekDragging = false; execute({ action:'media.seek.absolute',args:{seconds} }).catch(error => fail(error.message)); });
$('timeline').addEventListener('pointercancel', () => { seekDragging = false; });
video.addEventListener('loadedmetadata', () => { void sync.synchronize(); });
video.addEventListener('canplay', () => { void sync.synchronize(); });
video.addEventListener('error', () => {
  if (!video.getAttribute('src') || !state?.mediaUrl || !video.error || playbackError) return;
  const code = video.error?.code, message = video.error?.message || '';
  if (state.directDelivery && code === 2) { void proxyDirectFile(); return; }
  if ([3,4].includes(code) && state.format === 'file') {
    void compatibleFallback('The original video could not be decoded.'); return;
  }
  if ([3,4].includes(code) && /kUnsupportedConfig|DECODER_ERROR_NOT_SUPPORTED|decoder.*(?:not supported|initialization failed)/i.test(message)) {
    void compatibleFallback('The video decoder is unsupported.'); return;
  }
  // HLS manages recoverable media errors through its bounded handler.
  if (hls && [3,4].includes(code)) return;
  if (uburoomPlayback.localFormat(state.format)) {void compatibleFallback('The converted video could not be decoded.');return;}
  playbackError = 'Video could not play (media error ' + (code || 'unknown') + ').'; fail(playbackError);
});
$('enable-acceleration').addEventListener('click', async () => {
  if (!sdk) return;
  try { await sdk.commands.encourageHardwareAcceleration(); }
  catch { fail('Enable hardware acceleration in Discord Settings → Advanced, then reopen the Activity.'); }
});
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || document.body.classList.contains('activity-pip') || document.querySelector('dialog:modal')) return;
  if (event.code === 'Escape' && !drawer.hidden) { toggleDrawer(false); $('drawer-open').focus(); return; }
  if (!state || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('button,input,select,textarea,[contenteditable=true]')) return;
  const command = event.code === 'Space' ? {action:state.pauseAt || state.state.paused && !state.waitingForReady?'media.play':'media.pause'} : ['ArrowLeft','ArrowRight'].includes(event.code) ?
    {action:'media.seek.relative',args:{seconds:event.code==='ArrowLeft'?-15:15}} : event.code==='KeyM' ? {action:state.state.muted?'media.unmute':'media.mute'} : undefined;
  if (command) { event.preventDefault(); execute(command).catch(error => fail(error.message)); }
});
document.addEventListener('pointerdown', event => {
  if (!drawer.hidden && !event.composedPath().some(node => ['drawer','drawer-open','drawer-close'].includes(node.id)) && !event.composedPath().some(node => node instanceof HTMLDialogElement || node.classList?.contains('player-settings-menu'))) {
    toggleDrawer(false);
    $('stage').focus({preventScroll:true});
  }
});
$('fullscreen').addEventListener('click', () => { (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error => fail(error.message)); });
document.addEventListener('fullscreenchange', () => { updateMobilePlayer(); updateFullscreenLayout(); glyph('fullscreen', document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'); $('fullscreen').title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; $('fullscreen').setAttribute('aria-label', $('fullscreen').title); });
async function loadLibraryItem(item) {
  return execute({action:'media.load',args:{mediaId:item.id,quality:item.id === 'demo' ? 'direct' : preferredQuality}});
}
let roomChoice;
function renderRoomChoices(rooms, container = $('room-choices')) {
  const key = JSON.stringify([selected,rooms.map(room => [room.id,room.name,room.hostName,room.title,room.viewers,room.maxMembers,room.recovering,room.locked])]);
  if (container.dataset.roomList === key) return;
  container.dataset.roomList = key;
  const focusedRoom = container.contains(document.activeElement) ? document.activeElement.dataset.joinRoom : undefined;
  container.replaceChildren();
  if (!rooms.length && container.id !== 'lobby-rooms') { const empty = document.createElement('p'); empty.className = 'hint'; empty.textContent = 'No active rooms. Create a new room or reopen one of yours.'; container.append(empty); }
  for (const room of rooms) {
    const row = document.createElement('div'); row.className = 'saved-room';
    const copy = document.createElement('div'), name = document.createElement('strong'), info = document.createElement('p');
    name.textContent = room.name || room.hostName;
    name.prepend(uburoomIcons.icon(document, room.visibility === 'private' ? 'lock' : 'website'));
    info.className = 'hint';
    info.textContent = (room.recovering ? 'Recovering · ' : '') + (room.title || 'No video selected') + ' · ' + room.viewers + ' / ' + (room.maxMembers || 20) + ' people'; copy.append(name,info);
    const actions = document.createElement('div'); actions.className = 'room-actions';
    const currentRoom = container.id === 'room-choices' && room.id === selected;
    const button = document.createElement('button'); button.className = 'quiet'; button.dataset.joinRoom = room.id; button.textContent = currentRoom ? 'Cancel' : 'Join';
    if (!currentRoom) button.prepend(uburoomIcons.icon(document,'login')); button.disabled = !currentRoom && !!room.locked;
    button.addEventListener('click',async () => {
      if (currentRoom) { $('room-dialog').close('cancel'); return; }
      if (creating) return;
      creating = true; button.disabled = true; $('lobby-error').textContent = '';
      try { await selectRoom(room.id); if (!state || selected !== room.id) throw new Error('Room unavailable. Choose another room.'); $('room-dialog').close('joined'); returnToVideo(); }
      catch (error) { $(container.id === 'lobby-rooms' ? 'lobby-error' : 'room-dialog-error').textContent = error.message; }
      finally { creating = false; button.disabled = !!room.locked; }
    }); actions.append(button); row.append(copy,actions); container.append(row);
  }
  if (focusedRoom) [...container.querySelectorAll('button')].find(button => button.dataset.joinRoom === focusedRoom)?.focus({preventScroll:true});
}
function syncButtonGroup(selectId, groupId) {
  const select = $(selectId), group = $(groupId);
  if (!select || !group) return;
  uburoomControls.bindSelect(select, group);
}
syncButtonGroup('room-create-visibility', 'room-create-visibility-group');
syncButtonGroup('room-create-preset', 'room-create-preset-group');
syncButtonGroup('room-settings-visibility', 'room-settings-visibility-group');
syncButtonGroup('room-permission-preset', 'room-permission-preset-group');
for (const btn of $('room-create-visibility-group')?.querySelectorAll('button') || []) {
  btn.prepend(uburoomIcons.icon(document, btn.dataset.value === 'private' ? 'lock' : 'website'));
}
for (const btn of $('room-settings-visibility-group')?.querySelectorAll('button') || []) {
  btn.prepend(uburoomIcons.icon(document, btn.dataset.value === 'private' ? 'lock' : 'website'));
}
const roomOptionHints = {
  public:'Eligible viewers can find and join this room.', private:'Only the room leader and assigned hosts can join.',
  'host-control':'Hosts control playback and the queue. Participants have no controls.',
  'play-pause':'Participants can play and pause. Hosts control seeking, video choice and the queue.',
  queue:'Participants can use all playback and queue controls. Room management stays with hosts.',
  custom:'Custom permissions. Selecting this option does not change any permissions.'
};
for (const group of ['room-create-visibility-group','room-create-preset-group','room-settings-visibility-group','room-permission-preset-group']) {
  for (const button of $(group).querySelectorAll('button')) button.title = roomOptionHints[button.dataset.value];
}
$('room-name').placeholder = uburoomUbumfa.roomName();
let roomNameDraft = '', roomVisibilityDraft = 'public', roomPresetDraft = 'host-control';
$('room-create-visibility').addEventListener('change',event => { roomVisibilityDraft = event.target.value; });
$('room-name').addEventListener('input', event => { roomNameDraft = event.target.value; });
function roomChooserSection(section) {
  $('room-create-form').hidden = section !== 'new';
  $('room-create-actions').hidden = section !== 'new';
  $('room-join').hidden = section !== 'active';
  $('room-reopen').hidden = section !== 'saved' || !me?.durableRooms;
  $('room-chooser-nav').hidden = section === 'new';
  $('room-chooser-new').hidden = section === 'new';
  $('room-create-back').hidden = section !== 'new' || !me?.durableRooms;
  $('room-dialog-title').textContent = section === 'new' ? 'New room' : 'Rooms';
  for (const [id,value] of [['room-show-active','active'],['room-show-saved','saved']]) $(id).setAttribute('aria-pressed',String(section === value));
  $('room-show-saved').hidden = !me?.durableRooms;
  $('room-dialog-hint').textContent = roomChoice ? 'Create a room to watch ' + roomChoice.title + '. Joining follows current playback; reopening restores the saved video.' : section === 'new' ? 'Choose a name and who can join.' : 'Choose an active room or restore one of your saved rooms.';
}
async function chooseRoom(item, section = 'active') {
  const dialog = $('room-dialog');
  if (dialog.open || creating) return {status:'cancelled'};
  roomUI.clearDraft(); roomChoice = item;
  $('room-dialog-error').textContent = ''; delete $('room-choices').dataset.roomList; $('room-choices').replaceChildren();
  $('room-name').value = roomNameDraft; $('room-create-visibility').value = roomVisibilityDraft; $('room-create-preset').value = roomPresetDraft;
  roomChooserSection(section);
  const closed = new Promise(resolve => dialog.addEventListener('close', () => {
    roomChoice = undefined; resolve({status:dialog.returnValue === 'cancel' || !dialog.returnValue ? 'cancelled' : 'applied'});
  }, {once:true}));
  uburoomDialogs.open(dialog);
  (section === 'new' ? $('room-name') : section === 'saved' ? $('room-show-saved') : $('room-show-active')).focus();
  void roomUI.loadSaved(0);
  renderRoomChoices(knownRooms);
  return closed;
}
uburoomDialogs.register($('room-dialog'), {busy:() => creating, dirty:() => !$('room-create-form').hidden && (!!$('room-name').value.trim() || roomVisibilityDraft !== 'public' || roomPresetDraft !== 'host-control')});
$('room-dialog').querySelector('form').addEventListener('submit', event => { if (creating) event.preventDefault(); });
async function createRoom(advanced = roomUI.draftOptions()) {
  if (creating) return; creating = true;
  $('room-create').disabled = true;
  try {
    const room = await api('/api/watch/rooms', {...advanced,visibility:$('room-create-visibility').value,name:$('room-name').value.trim() || $('room-name').placeholder,...(me?.durableRooms && $('room-create-preset').value ? {permissionPreset:$('room-create-preset').value} : {})}); await selectRoom(room.id);
    if (selected !== room.id || !state) throw new Error('Room unavailable. Try again.');
    const item = roomChoice;
    roomNameDraft = ''; roomVisibilityDraft = 'public'; roomPresetDraft = 'host-control'; $('room-name').value = '';
    $('room-name').placeholder = uburoomUbumfa.roomName();
    $('room-dialog').close('created'); roomUI.clearDraft(); renderLibrary();
    if (item) {
      const result = await loadLibraryItem(item);
      if (result?.status !== 'applied') throw new Error('Playback was not accepted; try again from the library.');
      returnToVideo();
    }
  }
  catch (error) { if ($('room-dialog').open) $('room-dialog-error').textContent = error.message; else fail(error.message); if (advanced && Object.keys(advanced).length) throw error; }
  finally { creating = false; $('room-create').disabled = false; }
}
for (const id of ['create','lobby-create']) $(id).addEventListener('click', () => void chooseRoom(undefined,'new'));
for (const id of ['switch-room']) $(id).addEventListener('click', () => void chooseRoom());
$('room-create').addEventListener('click', () => void createRoom().catch(error=>fail(error.message)));
$('room-create-settings').append(uburoomIcons.icon(document,'settings'));
$('room-create-settings').addEventListener('click',()=>roomUI.openDraft({name:$('room-name').value,visibility:$('room-create-visibility').value,permissionPreset:$('room-create-preset').value}));
$('room-create-preset').addEventListener('change',()=>{ roomPresetDraft = $('room-create-preset').value; roomUI.updateDraftPreset(roomPresetDraft); });
$('room-chooser-new').addEventListener('click',() => { roomChooserSection('new'); if (roomNameDraft) $('room-name').value = roomNameDraft; $('room-name').focus(); });
$('room-create-back').addEventListener('click',() => { roomChooserSection('saved'); void roomUI.loadSaved(0); });
$('room-show-active').addEventListener('click',() => roomChooserSection('active'));
$('room-show-saved').addEventListener('click',() => roomChooserSection('saved'));
$('room-chooser-refresh').addEventListener('click',() => { void roomUI.loadSaved(0); void refreshRooms().catch(error => $('room-dialog-error').textContent = error.message); });
function browseMedia() {
  const panel = $('library-panel');
  if (immersive) { toggleDrawer(true); selectSection('media'); }
  else { selectSection('media'); library.reveal('smooth'); }
  panel.classList.remove('media-glow');
  void panel.offsetWidth;
  panel.classList.add('media-glow');
}
$('library-panel').addEventListener('animationend', event => { if (event.animationName === 'media-glow') $('library-panel').classList.remove('media-glow'); });
$('empty-browse').prepend(uburoomIcons.icon(document, 'media'));
$('empty-browse').addEventListener('click', browseMedia);
$('close-room').addEventListener('click', async () => {
  if (!selected || pending) return;
  const id = selected; pending = true;
  try {
    await api('/api/watch/rooms/' + id + '/leave', { viewerId });
    selected = undefined; browseRoom = undefined; unavailable('','leave'); await refreshRooms();
  } catch (error) { fail(error.message); } finally { pending = false; renderLibrary(); }
});
$('admin-end-room').addEventListener('click',() => { if (state?.adminMode) void roomUI.open(state.id,'manage'); });
$('refresh').addEventListener('click', () => refreshRooms().catch(error => fail(error.message)));
window.addEventListener('pagehide', () => { stopBrowserHandoff(true); transport?.close(); });
window.addEventListener('pageshow',event=>{if(event.persisted&&transport)void transport.connect().catch(error=>fail(error.message));});
setInterval(() => {
  const timeline = $('timeline'), duration = state?.state.duration || 0;
  const value = seekDragging ? Number(timeline.value) : state ? expected() : 0;
  if (!seekDragging) { timeline.value = value; $('time').textContent = clock(value); }
  timeline.style.setProperty('--timeline-fill',uburoomPlayback.timeline(video.buffered,duration,value));
  const loaded = Math.floor(uburoomPlayback.bufferedAhead(video.buffered,video.currentTime));
  timeline.setAttribute('aria-valuetext',clock(value) + ' of ' + clock(duration) + ', ' + loaded + ' seconds buffered ahead');
  timeline.title = loaded + ' seconds buffered ahead';
}, 250);
async function start() {
  await syncReady;
  config = pageBootstrap?.config||await api('/api/watch/config');
  if (config.watchVersion !== 19) throw new Error('The player and server versions differ. Reload after the server update.');
  $('plex-login').hidden=!config.unifiedAccounts||!config.plexConfigured||config.access?.plex===false;
  const discordButton=$('welcome').querySelector('.discord-button');
  discordButton.hidden=config.access?.discord===false;
  if (config.demo && ['host','guest','guest2'].includes(params.get('demo'))) {
    if(config.accountDemo&&!activity)await api('/api/account/demo-login',{persona:params.get('demo')});
    else acceptIdentity(await api('/api/watch/demo-login', { persona:params.get('demo'), activity }));
  } else if (params.has('frame_id') && !token) {
    if (!config.clientId) throw new Error('Configure Discord OAuth on the server first');
    sdk = new uburoomDiscord.DiscordSDK(config.clientId); await sdk.ready();
    acceptIdentity(await activityIdentity());
    await sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', updateActivityLayout);
  }
  if(config.access){
    let admission=await api('/api/watch/admission');
    if(config.access.anonymous&&!admission.identity&&!admission.passwordNeeded&&!admission.activityOnly){await api('/api/watch/entry',{});admission=await api('/api/watch/admission');pageBootstrap=undefined;}
    if(!admission.admitted){
      $('auth-loading').hidden=true;$('welcome').hidden=false;document.body.classList.remove('auth-pending');
      $('empty-title').textContent=admission.activityOnly?'Discord Activity only':admission.passwordNeeded?'Enter uburoom':admission.plexRequired?'Connect Plex to join':'Sign in to join';
      $('entry-form').hidden=!admission.passwordNeeded||admission.activityOnly;
      $('entry-status').textContent=admission.activityOnly?'Open uburoom through Discord Activity. Browser playback is disabled.':
        admission.passwordNeeded?'Enter this server’s password to continue.':
        admission.plexRequired?'This server requires confirmed Plex access. Connect a Plex account with access to the configured server to continue.':
        admission.identity?'Your account does not meet this server’s entry requirements. Check your Discord membership or Plex server access.':'Sign in to join this server.';
      discordButton.hidden=config.access.discord===false||admission.passwordNeeded||admission.activityOnly;
      $('plex-login').hidden=config.access.plex===false||admission.passwordNeeded||admission.activityOnly&&!admission.identity;
      if(admission.identity){me={...admission.pendingIdentity,adminEligible:false};renderAccount();}
      $('entry-plex-activity').hidden=!activity||!admission.identity||admission.passwordNeeded||!config.access.plex;
      $('entry-recheck').hidden=!admission.identity;
      if(admission.identity&&!activity&&params.get('account')==='1'&&typeof showAccount==='function')await showAccount();
      return;
    }
    $('entry-form').hidden=true;
  }
  try {
    if(pageBootstrap?.me){if(pageBootstrap.me.status!==200)throw Object.assign(new Error(pageBootstrap.me.value.error),{status:pageBootstrap.me.status});me=pageBootstrap.me.value;}
    else me = await api('/api/watch/me');
  } catch (error) {
    if (activity || error.status !== 401) throw error;
    $('auth-loading').hidden = true; $('welcome').hidden = false;
    document.body.classList.remove('auth-pending');renderVisibility();return;
  }
  renderAccount(); $('welcome').hidden = true;
  let initialRooms=pageBootstrap?.rooms?.status===200?pageBootstrap.rooms.value.rooms:undefined;
  if(initialRooms){applyRooms(initialRooms);$('auth-overlay').hidden=true;document.body.classList.remove('auth-pending');placeRoomBar();}
  $('diagnostic-actions').hidden=!controlProbe&&!soakMode;
  let bootstrap;
  transport?.close();
  transport=new uburoomWatchTransport({
    url:location.origin.replace(/^http/,'ws')+'/watch-socket',identity:()=>({token,csrf:me?.csrf}),
    onReady:()=>bootstrap=(async()=>{
      await refreshState();if(initialRooms)initialRooms=undefined;else await refreshRooms();
      if(!selected){if(reconnecting)diagnostics.record('control-reconnected');clearTimeout(disconnectGraceTimer);disconnectGraceTimer=undefined;disconnectExtended=false;hideDisconnectToast();reconnecting=false;fail('');}
      $('auth-loading').hidden=$('auth-overlay').hidden=true;
      document.body.classList.remove('auth-pending');
      renderBrowsing();renderVisibility();placeRoomBar();
    })(),
    onClose:details=>{ connectionLost(details); if (details.code === 4029) fail('Server full; try again when someone leaves'); if (token && details.code === 4003) { identityRenewAt = 0; identityRetryAt = 0; void renewIdentity().catch(()=>{}); } },
    beginClock:()=>({exchange:playbackClock.begin(),sent:performance.now(),before:Date.now()}),
    onClock:(message,sample)=>{
      playbackClock.add(sample.exchange,message.timing);
      offset=message.serverNow-(sample.before+Date.now())/2;
      if(state){const revision=observationClock.update(state.observationEpoch,message.serverNow,sample.sent,performance.now());
        if(revision!==observationClockRevision){observationBreak++;observationClockRevision=revision;}}
    },
    onMessage:message=>{
      if(message.type==='room-kicked' && message.roomId===selected){selected=undefined;viewerId=crypto.randomUUID();unavailable('You were removed from the room. You may rejoin.','kicked');}
      else if(message.type==='identity'){me=message.value;renderAccount();}
      else if(message.type==='rooms'&&message.status===200)applyRooms(message.value.rooms);
      else if(message.type==='state'&&message.path.split('?')[0]==='/api/watch/rooms/'+selected){
        if(message.status===200){applyState(message.value);fail(playbackError);void reportReadiness();}
        else if(message.status>=500)connectionLost();
        else unavailable(message.value?.error||'Room unavailable','room-poll');
      } else if(message.type==='unavailable'){
        if(message.status===401||message.status===403)unavailable(message.value?.error||'Sign in again','identity-poll');
        else connectionLost();
      }
    }
  });
  $('create').hidden = false; renderBrowsing(); renderVisibility(); renderTransport();
  clearInterval(identityTimer);
  identityTimer = setInterval(async () => {
    try { await renewIdentity(); }
    catch (error) { unavailable('Disconnected. ' + error.message,'identity-poll'); }
  }, 1000);
  await transport.connect();
  await bootstrap;
  if(params.get('account')==='1'&&!activity){history.replaceState(history.state,'','/watch');if(typeof showAccount==='function')await showAccount();}
  const requestedRoom = params.get('room');
  if (!activity && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestedRoom || '')) {
    history.replaceState(history.state,'','/watch');
    await selectRoom(requestedRoom);
  }
}
$('entry-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=$('entry-submit');button.disabled=true;
  try{await api('/api/watch/entry',{password:$('entry-password').value});$('entry-password').value='';pageBootstrap=undefined;await start();}
  catch(error){$('entry-status').textContent=error.message;}finally{button.disabled=false;}
});
$('entry-recheck').addEventListener('click',()=>{pageBootstrap=undefined;void start().catch(error=>fail(error.message));});
$('entry-plex-activity').addEventListener('click',()=>void openInBrowser());
$('room-recovery-start').addEventListener('click',() => void execute({action:'media.play'}).catch(error=>fail(error.message)));
$('auth-retry').addEventListener('click', () => location.reload());
renderVisibility();renderTransport();
start().catch(error => {
  if (!$('auth-loading').hidden) {
    $('auth-title').hidden = false;
    $('auth-title').textContent = 'Couldn’t load uburoom';
    $('auth-status').textContent = error.message;
    $('auth-retry').hidden = false;
  } else fail(error.message);
});
