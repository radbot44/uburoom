'use strict';
const $ = id => document.getElementById(id);
const viewerId = crypto.randomUUID(), params = new URLSearchParams(location.search);
let token, me, config, selected, state, receivedAt, offset = 0, pending = false, creating = false, transport;
let stateTransportSequence=0;
let identityExpiresAt = 0, identityRenewAt = 0, identityRetryAt = 0, identityRenewal, identityGeneration = 0;
let hls, mediaVersion, mediaSource, lastFeedback, badgeTimer, seekDragging = false, sdk;
let playbackError = '', autoplayBlocked = false, probing = false, readyVersion, readyPending = false, readinessSent, browseRoom, preferredQuality = '720p4';
let volumeWanted, volumeDraft, volumeTimer, lastVolumeAt = 0, volumeDragging = false;
const activity = params.has('frame_id');
let theater = document.body.classList.contains('theater'), immersive = false, layoutMode, fallbackVersion, fallbackPending = false, frameStartedAt, videoFrames = 0, frameCallback;
let hlsRecoveryTimer, hlsRecoveryCount = 0, hlsNetworkRetries = 0, hlsNetworkFailure, hlsNetworkInterrupted = false;
let hlsRefreshPending = false, hlsRefreshVersion, hlsRefreshTimes = [];
let av1, av1FallbackVersion;
let observationPending = false, observationSequence = 0, observationBreak = 0, observing = false, playerWaiting = false;
const observationClock=uburoomPlayback.observationClock();
const playbackClock=uburoomTiming.clock(), presentationTiming=uburoomTiming.presentation();
let sync;
let syncCorrectionMode='speed', syncPreferenceKey, syncPreferenceStored=true;
let precisionCorrectionEnabled=false;
// Experimental policies remain off; only isolated comparison runners enable them.
let gentleCorrectionEnabled=false;
let qualityPending=false;
let observationClockRevision=0;
let lastPresentationBreak=performance.now(), stateRequestSequence=0;
let browserHandoff, browserHandoffTimer, browserVerification;
let trackNotice='', trackNoticeError=false, trackActionError='', trackContext, playerUI;
const video = $('video');
const syncReady=import('./watch-sync.mjs').then(({createSync})=>{
  sync=createSync({video,timing:uburoomTiming,playback:uburoomPlayback,clock:playbackClock,presentation:presentationTiming,
    read:()=>({state,selected,mediaSource,receivedAt,probing,playbackError,playerWaiting,hlsNetworkFailure,
      autoplayBlocked,readyVersion,syncCorrectionMode,precisionCorrectionEnabled,gentleCorrectionEnabled}),
    expected,decodedFrames,unlockLocal,reportReadiness,render:renderTransport,checkFrames:checkVideoFrames,sample:diagnosticSample,
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
  if(soak||!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||state.enabled||pending||video.paused||video.readyState<3)return;
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
  if(!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||state.enabled||pending||!controlProbe?.start(selected))return;
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
      format:state?.format,enabled:!!state?.enabled,
      audio:tracks?.audio.findIndex(row=>row.id===tracks.audioId),subtitle:tracks?.subtitles.findIndex(row=>row.id===tracks.subtitleId),
      delivery:tracks?.subtitles.find(row=>row.id===tracks.subtitleId)?.delivery || 'off',...fields});
  } catch { /* A missing diagnostic sample must not change player behavior. */ }
}
for(const event of ['playing','pause','waiting','stalled','seeking','seeked','ended','error','emptied','loadstart','loadedmetadata','canplay','abort','ratechange'])
  video.addEventListener(event,()=>{
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
  $('probe-control').disabled=!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||state.enabled||pending||!!controlProbe?.active();
  $('soak-start').disabled=!!soak||!state?.mediaUrl||state.visibility!=='private'||state.viewers!==1||state.enabled||pending||video.paused||video.readyState<3;
  if(selected || state || mediaSource)diagnosticSample();
  if(soak&&!soak.finishing&&!soak.done){
    if(selected!==soak.room||state&&state.mediaVersion!==soak.media)void finishSoak('source-changed');
    else if(performance.now()-soak.startedAt>=7200000)void finishSoak('complete');
  }
},1000);
$('save-diagnostics').onclick=()=>saveDiagnostics();
function saveDiagnostics(filename='uburoom-playback-diagnostics.json') {
  diagnosticSample();
  const url=URL.createObjectURL(new Blob([JSON.stringify(diagnostics.snapshot(),null,2)+'\n'],{type:'application/json'}));
  const link=document.createElement('a');link.href=url;link.download=filename;link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
const captions = new uburoomSubtitles(video,value=>{trackNotice=value.message;trackNoticeError=value.error;renderTracks();});
const subtitleMode=$('subtitle-mode');
video.volume = .5;
function glyph(id, symbol) { $(id).replaceChildren(uburoomUI.icon(document, symbol)); }
for (const pair of [['refresh','refresh'],['open-remote','remote'],['empty-symbol','play'],['fullscreen','fullscreen'],
  ['join-playback','play'],['player-play','play'],['previous','start'],['seek-back','back'],['seek-forward','forward'],['next','end'],['player-mute','mute'],
  ['theater','theater'],['tracks-open','settings'],['tracks-close','close'],['drawer-symbol','drawer'],['drawer-close','close'],['admin-mode','admin'],['browser-symbol','open'],['options-chevron','chevron'],['library-chevron','chevron']]) glyph(...pair);
const badge = uburoomUI.mountBadge($('badge'));
const remote = uburoomUI.mount($('remote'), { showAutoJoin: false, volumeInterval: 600, execute: command => execute(command), close: () => toggleRemote(false) });
const settings = uburoomUI.mount($('remote-settings'), { settingsOnly: true, showAutoJoin: false, execute: command => execute(command) });
playerUI=uburoomPlayerUI.mount({getState:()=>state,execute,fail,changeTrack,captions,
  beforeSettings:()=>{trackContext=state?{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion}:undefined;trackActionError='';renderTracks();},
  afterSettings:()=>{trackContext=undefined;}});
const library = uburoomLibrary.mount($('library-content'), {
  request:(path,signal) => api(path,undefined,{signal}),
  artwork:async (path,signal) => {
    const response = await fetch(path,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:token ? {Authorization:'Bearer ' + token} : {}});
    if (!response.ok) throw new Error('Artwork unavailable'); return response.blob();
  },
  load:item => execute({action:'media.load',args:{mediaId:item.id,quality:item.id === 'demo' ? 'direct' : preferredQuality}}),
  close:returnToVideo, getPlayer:() => state
});
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
  if(transport && /^\/api\/watch\/(rooms|me|admin-mode|playback|library)(?:[/?]|$)/.test(path) && !path.startsWith('/api/watch/library/art')) {
    try {return await transport.request(path,data,options);} catch(error){rejection=error.rejection;if(error.status)response={status:error.status,ok:false};throw error;}
  }
  response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers,
    body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(options.timeoutMs || 12000)]) : AbortSignal.timeout(options.timeoutMs || 12000), keepalive: !!options.keepalive });
  const value = await response.json(); decoded=true; if (!response.ok) {rejection=value.rejection;throw new Error(value.error || 'Request failed');} return value;
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
const drawer = document.createElement('aside'); drawer.id = 'drawer'; drawer.hidden = true;
drawer.setAttribute('aria-label', 'Rooms and library'); document.body.append(drawer);
const shells = ['account','welcome','room-bar','options-panel','library-panel','status','error','diagnostic-actions','acceleration-help'].map(id => {
  const element = $(id), marker = document.createComment(id); element.before(marker); return { element, marker };
});
function toggleDrawer(show = drawer.hidden) {
  show = !!show && immersive && !document.body.classList.contains('activity-pip');
  const parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
  if (drawer.parentElement !== parent) parent.append(drawer);
  parent.append($('drawer-close'));
  $('drawer-close').hidden = !show;
  drawer.hidden = !show; $('stage').classList.toggle('drawer-open', show);
  $('drawer-open').setAttribute('aria-expanded', String(show));
  if (!show) toggleRemote(false);
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
}
function updateViewingLayout() {
  document.documentElement.style.setProperty('--watch-room-bar-height',$('room-bar').offsetHeight+'px');
  if (!immersive) document.documentElement.style.setProperty('--watch-header-height', ($('viewing-section').getBoundingClientRect().top + scrollY) + 'px');
}
const viewingLayoutObserver = new ResizeObserver(updateViewingLayout);
viewingLayoutObserver.observe($('account')); viewingLayoutObserver.observe($('viewing-section')); viewingLayoutObserver.observe($('room-bar'));
window.addEventListener('scroll', () => document.body.classList.toggle('page-scrolled', scrollY > 0), {passive:true});
function updateFullscreenLayout() {
  immersive = activity || document.fullscreenElement === $('stage');
  const drawerOpen = !drawer.hidden, remoteOpen = !$('remote').hidden;
  document.body.classList.toggle('immersive', immersive);
  for (const { element, marker } of shells) immersive ? drawer.append(element) : marker.after(element);
  $('drawer-open').hidden = $('drawer-close').hidden = !immersive;
  toggleDrawer(drawerOpen);
  toggleRemote(remoteOpen);
  placeRoomBar();
  updateViewingLayout();
}
function placeRoomBar() {
  $('room-bar').hidden = !me;
  $('room-lobby').hidden = !immersive || !!selected || !me;
}
for (const name of ['options','library']) $(name + '-collapse').addEventListener('click', () => {
  const button = $(name + '-collapse'), content = $(name + '-content');
  content.hidden = !content.hidden; button.setAttribute('aria-expanded', String(!content.hidden));
});
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
  $('identity').textContent = me.name + (config.demo ? ' · local demo' : '');
  $('admin-mode').hidden = !me.owner; $('admin-mode').setAttribute('aria-checked',String(!!me.adminMode));
  $('admin-mode').title = me.adminMode ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
  $('open-browser').hidden = !activity;
  if(typeof updateAccountButton==='function')updateAccountButton();
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
    $('handoff-dialog').showModal(); void pollBrowserHandoff();
  } catch (error) { demoWindow?.close(); stopBrowserHandoff(true); fail(error.message); }
}
$('open-browser').addEventListener('click',openInBrowser);
$('watch-website').addEventListener('click',openInBrowser);
$('handoff-dialog').addEventListener('close', () => stopBrowserHandoff(true));
$('approve-browser').addEventListener('click',async () => {
  const id = browserHandoff; if (!id || !browserVerification) return;
  $('approve-browser').disabled = true;
  try { await api('/api/watch/handoff/action',{id,action:'approve',verification:browserVerification}); }
  catch (error) { if (browserHandoff === id) { stopBrowserHandoff(true); $('handoff-dialog').close('failed'); fail(error.message); } }
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
  if (pip) { toggleDrawer(false); toggleRemote(false); if ($('privacy-dialog').open) $('privacy-dialog').close('cancel'); }
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
  const useAV1 = !preferHLS && (state.format !== 'file' || /^(h264|avc1)$/i.test(state.videoCodec || ''));
  if (state.format === 'av1' || useAV1 && av1FallbackVersion === state.mediaVersion || !useAV1 && fallbackVersion === state.mediaVersion) {
    if (state.format === 'av1') { av1?.destroy(); video.pause(); playbackError = 'AV1 played no decoded video. Check the Playback test and server encoder probe.'; fail(playbackError); }
    return;
  }
  if (pending || qualityPending) {
    const id = selected, version = state.mediaVersion;
    setTimeout(() => { if (selected === id && state?.mediaVersion === version) void compatibleFallback(reason,preferHLS); }, 200); return;
  }
  if (useAV1) av1FallbackVersion = state.mediaVersion; else fallbackVersion = state.mediaVersion;
  fallbackPending = true;
  diagnosticSample('fallback');stopHls('fallback');
  try { await execute({ action:'media.quality.set', args:{quality:state.quality, compatible:true, ...(useAV1 ? {fallback:'av1'} : {})} }); }
  catch (error) { playbackError = reason + ' ' + (useAV1 ? 'AV1' : 'H.264') + ' fallback failed: ' + error.message; fail(playbackError); }
  finally { fallbackPending = false; }
}
function watchFrames() {
  if (!video.requestVideoFrameCallback) return;
  frameCallback = video.requestVideoFrameCallback((now,metadata) => {
    videoFrames++;
    try {
      const frame=presentationTiming.frame(now,metadata), timing=playbackClock.read(metadata.expectedDisplayTime);
      const target=uburoomTiming.target(state,timing.serverTime);
      if(frame)diagnostics.record('frame',{...frame,...timing,clockValid:timing.valid,frameServerTime:timing.serverTime,
        timelineRevision:state?.revision,sharedTarget:target,presentationErrorMs:target===undefined?undefined:(metadata.mediaTime-target)*1000,
        paused:video.paused,roomPaused:state?.state.paused,seeking:video.seeking,waiting:playerWaiting,ready:video.readyState,rate:video.playbackRate,syncMode:syncCorrectionMode,
        settling:performance.now()-lastPresentationBreak<2000,
        visibility:document.visibilityState,bufferAhead:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime)});
    } catch { /* Diagnostics cannot stop the decoded-frame evidence loop. */ }
    watchFrames();
  });
}
function decodedFrames() {
  const quality = video.getVideoPlaybackQuality?.();
  return videoFrames || (quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined);
}
function checkVideoFrames() {
  if (!state?.mediaUrl || video.paused || video.seeking || autoplayBlocked || playbackError) { frameStartedAt = undefined; return; }
  frameStartedAt ??= performance.now();
  const frames = decodedFrames();
  if (performance.now() - frameStartedAt > 8000 && (frames === 0 || !video.videoWidth || !video.videoHeight) && video.currentTime > 1) void compatibleFallback('Audio is playing without decoded video.');
}
function clearPlayer(reason) {
  if(reason!=='state-change')playerUI?.reset();
  sync.reset();
  diagnosticSample('player-clear',{reason});
  captions.reset(); trackActionError='';
  observing = false; observationBreak++; playerWaiting = false;
  av1?.destroy(); av1 = undefined;
  clearTimeout(hlsRecoveryTimer); hlsRecoveryCount = 0; $('acceleration-help').hidden = true;
  if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = undefined; frameStartedAt = undefined; videoFrames = 0;
  presentationTiming.reset();
  remote.stop(); dropVolume(); video.pause(); stopHls(reason);
  video.removeAttribute('src'); video.load(); mediaVersion = mediaSource = readyVersion = readinessSent = undefined;
  playbackError = ''; autoplayBlocked = false;
  $('join-playback').hidden = true; $('empty-stage').hidden = false; $('ready-status').textContent = '';
}
function stopHls(reason) {
  if(hls)diagnosticSample('hls-stop',{reason});
  clearTimeout(hlsRecoveryTimer);
  hlsNetworkRetries = 0; hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  const client = hls; hls = undefined; client?.destroy();
}
function unsupportedDecoder() {
  av1?.destroy(); video.pause(); stopHls('decoder'); clearTimeout(hlsRecoveryTimer);
  playbackError = activity ? 'Discord cannot decode this video with hardware acceleration off. Enable acceleration and reopen the Activity, or watch on the website.' :
    'This browser cannot decode the video. Try Firefox or Chrome, or enable hardware acceleration.';
  $('acceleration-help').hidden = !activity;
  $('enable-acceleration').hidden = !sdk;
  fail(playbackError);
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
  if (hls !== client || state?.format !== 'hls' || state.mediaUrl !== mediaSource || hlsRefreshPending || pending || qualityPending) return;
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
  diagnosticSample('hls-error',{fatal:!!data.fatal,status:data.response?.code,
    category:data.type===Hls.ErrorTypes.NETWORK_ERROR?'network':data.type===Hls.ErrorTypes.MEDIA_ERROR?'media':'other',
    detail:data.details===Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET?'reset':/^frag/.test(data.details)?'fragment':/^manifest/.test(data.details)?'manifest':'other'});
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
    hlsNetworkInterrupted = true;
    // A vanished Plex conversion can be reported as a nonfatal fragment
    // error while hls.js is still spending its own retry budget.
    if (data.response?.code === 410) void refreshHlsSession(client);
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
  qualityPending=false;
  playbackClock.reset();
  if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
  clearPlayer(reason); state = undefined; toggleRemote(false);
  browseRoom = undefined; $('library-panel').hidden = true; void library.setRoom(undefined);
  renderRemote(); renderVisibility(); renderTransport(); document.title = 'uburoom watch'; fail(message);
}
async function unlockLocal() {
  if (!state?.mediaUrl || video.readyState < 2 || probing || playbackError || sync.timelinePending) return false;
  const version = state.mediaVersion, source = mediaSource; probing = true; let playTimer;
  try {
    await Promise.race([video.play(), new Promise((resolve,reject) => { playTimer = setTimeout(() => {
      video.pause(); reject(new DOMException('Playback is still buffering','AbortError'));
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
  if (!selected || !state || pending) throw new Error('Wait for an available viewing room');
  const qualityChange=command.action==='media.quality.set';
  if(qualityPending && ['media.quality.set','media.tracks.set','media.stream.refresh','media.load','media.next','media.previous'].includes(command.action))throw new Error('Wait for your quality change to finish.');
  if ((command.action === 'media.play' || command.action === 'media.toggle' && !state.waitingForReady) && state.state.paused &&
      (autoplayBlocked || readyVersion !== state.mediaVersion) && expected() < state.state.duration - .1) await unlockLocal();
  const id = selected, epoch = state.epoch, qualityRequest=qualityChange?{}:undefined;
  if(qualityChange)qualityPending=qualityRequest;else pending=true;
  fail('');renderTransport();
  diagnosticSample('command-start',{action:command.action});
  try {
    const timing=playbackClock.read();
    if(!timing.valid)throw new Error('Playback timing is refreshing. Retry the control after the next room update.');
    const result = await api('/api/watch/rooms/' + id + '/command', { viewerId, epoch, expiresAt: timing.serverTime + 2500, command },qualityChange?{timeoutMs:35000}:{});
    if (selected !== id) return { status: 'unavailable' };
    if (result.status !== 'applied') throw new Error(result.message);
    diagnostics.record('command-ok',{action:command.action});
    await refreshState(); if (command.action === 'room.visibility') await refreshRooms(); return result;
  } catch(error) {
    diagnostics.record('command-failed',{action:command.action});
    if(qualityChange&&selected===id)await refreshState();
    throw error;
  }
  finally {
    if(qualityChange){if(qualityPending===qualityRequest)qualityPending=false;}else pending=false;
    if(qualityChange&&selected===id&&state?.mediaUrl)$('quality').value=uburoom.qualityId(state.quality);
    renderLibrary(); renderRemote(); renderVisibility(); renderTransport(); pumpVolume();
  }
}
function renderRemote() {
  const options = { available: !!state, canSave: !!state?.canManage,
    canPlayback: !!state?.canPlayback, canAudio: !!state?.mediaUrl, canTransform: !!state?.canTransform,
    room: state?.canManage ? { ...state, connected: true, paired: true, reachable: true, live: state.enabled } : null };
  remote.render(state?.state, options); settings.render(state?.state, options);
}
function renderVisibility() {
  $('options-panel').hidden = !state; $('watch-settings').hidden = !state?.canManage;
  $('admin-end-room').hidden = !state?.adminMode || state?.isHost; $('admin-end-room').disabled = pending;
  for (const id of ['visibility', 'drawer-visibility']) {
    const button = $(id), privateRoom = state?.visibility === 'private';
    button.hidden = !state; button.disabled = pending || !state?.canManage;
    button.textContent = privateRoom ? 'Private - No one can join' : 'Public'; button.classList.toggle('private', privateRoom);
    button.setAttribute('aria-label', state?.canManage ? (privateRoom ? 'Private room: make public' : 'Public room: make private') : 'Public room');
    button.title = state?.canManage ? (privateRoom ? 'Only you can watch. Make public.' : 'Server members can watch. Make private.') : 'Only the host can change visibility';
  }
}
async function changeVisibility() {
  if (!state?.canManage || pending || $('privacy-dialog').open) return;
  const id = selected;
  if (state.visibility === 'public') {
    const dialog = $('privacy-dialog'), parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
    parent.append(dialog); dialog.returnValue = '';
    const accepted = new Promise(resolve => dialog.addEventListener('close',()=>resolve(dialog.returnValue === 'private'),{once:true}));
    dialog.showModal();
    if (!await accepted || selected !== id || state?.visibility !== 'public' || !state?.canManage) return;
    await execute({action:'room.visibility',args:{visibility:'private'}});
  } else await execute({action:'room.visibility',args:{visibility:'public'}});
}
for (const id of ['visibility','drawer-visibility']) $(id).addEventListener('click', () => changeVisibility().catch(error=>fail(error.message)));
function renderTransport() {
  const available = !!state?.mediaUrl, playback = available && state.canPlayback;
  for (const id of ['player-play','previous','seek-back','seek-forward']) $(id).disabled = !playback || pending;
  $('timeline').disabled = !playback;
  $('player-mute').disabled = !available || pending; $('player-volume').disabled = !available;
  $('next').disabled = !playback || !state?.hasNext || pending;
  $('quality').disabled = !available || state?.mediaId === 'demo' || pending || qualityPending;
  const paused = !!state?.pauseAt || state?.state.paused !== false && !state?.waitingForReady;
  $('stage').classList.toggle('paused', state?.state.paused !== false); $('stage').classList.toggle('blocked', autoplayBlocked);
  glyph('player-play', paused ? 'play' : 'pause'); $('player-play').setAttribute('aria-label', paused ? 'Play' : 'Pause'); $('player-play').title = paused ? 'Play' : 'Pause';
  glyph('player-mute', state?.state.muted ? 'muted' : 'mute'); $('player-mute').setAttribute('aria-label', state?.state.muted ? 'Unmute' : 'Mute');
  $('player-mute').title = state?.state.muted ? 'Unmute' : 'Mute';
  $('join-playback').hidden = !state?.mediaUrl || !!state?.readiness?.timedOut;
  $('join-playback').disabled = !autoplayBlocked && (!playback || pending);
  const centerLabel=autoplayBlocked?'Join playback':paused?'Play':'Pause';
  glyph('join-playback',autoplayBlocked||paused?'play':'pause');
  $('join-playback').setAttribute('aria-label',centerLabel); $('join-playback').title=centerLabel;
  $('ready-status').textContent = state?.waitingForReady ? autoplayBlocked ? 'Press Play to join playback' : 'Waiting for viewers…' : autoplayBlocked ? 'Press Play to join playback' :
    state?.startAt>state?.serverNow && (playbackClock.read().serverTime??state.serverNow)<state.startAt ? 'Starting together…' : '';
  if (state?.readiness?.blockers.length) $('ready-status').textContent = 'Waiting for ' + state.readiness.blockers.join(', ') + '…';
  if (state?.readiness?.timedOut) $('ready-status').textContent = state.canManage ? 'Some viewers need more time. Choose how to continue.' : 'Waiting for the host to choose how to continue.';
  $('readiness-choice').hidden = !state?.readiness?.timedOut || !state.canManage;
  $('readiness-title').textContent = state?.readiness?.blockers.length ? 'Some viewers need more time' : 'Ready to continue?';
  $('readiness-message').textContent = state?.readiness?.blockers.length ? 'Waiting for ' + state.readiness.blockers.join(', ') + '. Start with ready viewers, or wait.' : 'Everyone is ready. Playback stays paused until you choose.';
  $('ready-start').disabled = pending || !state?.readiness?.canStart;
  $('ready-wait').disabled = $('ready-cancel').disabled = pending;
  if (state?.readiness?.timedOut) $('player-play').disabled = true;
  if (!volumeDragging) $('player-volume').value = volumeDraft ?? state?.state.volume ?? 50;
  renderTracks();
}
function trackLabel(track) {
  const roles=[track.forced && 'Forced',track.sdh && 'SDH',track.commentary && 'Commentary',track.description && 'Audio description'].filter(Boolean);
  return [track.label,track.codec?.toUpperCase(),track.channels && track.channels+' ch',...roles,!track.available && 'Unavailable'].filter(Boolean).join(' · ');
}
function renderTracks() {
  const tracks=state?.tracks, available=!!tracks;
  const render=(id,rows,choices,value)=>{
    const options=[...choices,...(rows || []).map(row=>({id:row.id,label:trackLabel(row),disabled:!row.available}))];
    const element=$(id), signature=JSON.stringify(options);
    if(element.dataset.options!==signature){element.replaceChildren(...options.map(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=row.label;option.disabled=!!row.disabled;return option;}));element.dataset.options=signature;}
    element.value=value || 'auto'; element.disabled=!available || pending || qualityPending;
  };
  render('audio-track',tracks?.audio,[{id:'auto',label:'Automatic (Plex)'}],tracks?.audioChoice);
  render('subtitle-track',tracks?.subtitles,[{id:'auto',label:'Automatic (Plex)'},{id:'off',label:'Off'}],tracks?.subtitleChoice);
  const audio=tracks?.audio.find(row=>row.id===tracks.audioId), subtitle=tracks?.subtitles.find(row=>row.id===tracks.subtitleId), delivery=tracks?.subtitleDelivery || subtitle?.delivery,burned=delivery==='burn';
  subtitleMode.value=tracks?.subtitleMode || 'auto';subtitleMode.disabled=!available || pending || qualityPending || !subtitle;
  $('audio-track-status').textContent=audio ? audio.label+(state.format!=='file' ? ' · Stereo playback' : '') : '';
  if(document.activeElement!==$('subtitle-offset'))$('subtitle-offset').value=tracks?.subtitleOffset || 0;
  $('subtitle-offset').disabled=!available || pending || !subtitle || burned;
  $('subtitle-delay-hint').textContent=burned ? 'Timing is fixed by Plex for subtitles included in the video.' : subtitle ? 'Positive values show subtitles later.' : 'Select subtitles to adjust their timing.';
  $('track-status').textContent=trackActionError || tracks?.subtitleError || trackNotice || (burned ? 'Plex includes these subtitles in the video to preserve their appearance and saves the choice for this title.' : '');
  const error=!!trackActionError || !!tracks?.subtitleError || trackNoticeError;
  $('track-status').classList.toggle('error',error);
  $('subtitle-status').hidden=!trackNoticeError && !tracks?.subtitleError;
  $('subtitle-status').textContent='Subtitles could not be shown. Open Player settings for details.';
  $('subtitle-retry').hidden=!trackNoticeError || !state?.subtitleUrl;
  playerUI?.render();
}
async function changeTrack(args,context=trackContext) {
  if(!state || pending || qualityPending || !context || context.mediaVersion!==state.mediaVersion || context.streamVersion!==state.streamVersion)return;
  trackActionError='';
  try { await execute({action:'media.tracks.set',args:{...context,...args}}); }
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
  const data = {viewerId,mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,observationEpoch:state.observationEpoch,
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
  // Periodic samples include rate corrections; assigning playbackRate can
  // emit ratechange even when the rate is unchanged.
  observationBreak++;
  void reportObservation();
});
setInterval(() => { void reportObservation(); },1000);
async function reportReadiness() {
  if (readyPending || !selected || !state?.mediaUrl) return;
  const id = selected, version = state.mediaVersion, readinessVersion = state.readinessVersion;
  const target = expected();
  const bufferedReady = !state.state.paused || !video.seeking && Math.abs(video.currentTime-target) <= (target === 0 ? .25 : readinessVersion ? .15 : .65) &&
    uburoomPlayback.readinessBuffered(video.buffered,target,state.state.duration);
  const ready = bufferedReady && video.readyState >= 3 && decodedFrames() > 0 && readyVersion === version && !playbackError;
  const key = id + ':' + version + ':' + readinessVersion + ':' + ready;
  if (readinessSent === key || !state.readiness && !state.waitingForReady && !ready) return;
  readyPending = true;
  try { await api('/api/watch/rooms/' + id + '/ready', { viewerId, mediaVersion: version,
    ready, readinessVersion }); readinessSent = key; } catch {} finally { readyPending = false; }
}
function applyState(next) {
  if(next.id!==selected||next.transportSequence<=stateTransportSequence)return;
  stateTransportSequence=next.transportSequence;
  sync.transition(next);
  diagnostics.state(next);
  const changed = mediaVersion !== next.mediaVersion || mediaSource !== next.mediaUrl;
  const previousTarget = state ? expected() : undefined;
  if(trackContext && trackContext.mediaVersion!==next.mediaVersion){playerUI.reset();$('tracks-dialog').close();trackContext=undefined;}
  if (state && state.epoch !== next.epoch) dropVolume();
  state = next; receivedAt = performance.now();
  if(playerUI.settingsOpen())trackContext={mediaVersion:next.mediaVersion,streamVersion:next.streamVersion};
  if (changed) {
    clearPlayer('state-change'); mediaVersion = next.mediaVersion; mediaSource = next.mediaUrl;
    if (next.mediaUrl) {
      $('empty-stage').hidden = true;
      watchFrames();
      if (next.format === 'file' && uburoomPlayback.needsCompatible(next,type => video.canPlayType(type))) {
        queueMicrotask(() => { if (state === next) void compatibleFallback('The browser does not support the original codecs.',true); });
      } else if (next.format === 'av1') {
        try { av1 = new uburoomAV1(video, next.mediaUrl, expected, message => { playbackError = message; video.pause(); fail(message); }); }
        catch (error) { playbackError = 'AV1 WebM transport unavailable: ' + error.message; fail(playbackError); }
      } else if (next.format === 'hls' && Hls.isSupported()) {
        sync.prepare({timeline:true});
        const client = hls = new Hls(uburoomPlayback.hlsConfig(next.bitrate || next.bitrateCeiling));
        client.on(Hls.Events.ERROR, (_, data) => handleHlsError(client, data));
        // Finish appending the anchor without requesting segment one before
        // the target seek; aborting that speculative load adds recovery noise.
        client.on(Hls.Events.FRAG_LOADED,()=>{if(hls===client&&sync.timelinePending)client.pauseBuffering();});
        client.on(Hls.Events.FRAG_BUFFERED, () => handleHlsFragmentBuffered(client));
        client.loadSource(next.mediaUrl); client.attachMedia(video);
      } else video.src = next.mediaUrl;
    }
  }
  if (!changed && !sync.timelinePending && previousTarget !== undefined && Math.abs(expected()-previousTarget) > 1.5) {
    sync.sharedSeek();
    if(sync.preparationUntil&&hls){hls.startLoad(expected());}
    else restartHlsForSeek(expected());
  }
  captions.update(next);
  if(next.mediaError)playbackError=next.mediaError;
  const picture = next.state.picture;
  video.style.scale = picture.zoom * picture.stretchX + ' ' + picture.zoom * picture.stretchY;
  video.style.translate = picture.x * 100 + '% ' + picture.y * 100 + '%';
  $('title').textContent = next.title; $('details').textContent = next.subtitle;
  $('viewers').textContent = next.viewers + (next.viewers === 1 ? ' viewer' : ' viewers');
  $('viewers').title = 'Host: ' + next.hostName;
  $('empty-title').textContent = 'Choose something to watch'; $('empty-hint').textContent = next.canManage ? 'Select a video from the library.' : 'The host chooses the video.';
  $('close-room').hidden = false; $('close-room').textContent = next.viewers === 1 && next.canManage ? 'End room' : 'Leave room';
  $('timeline').max = next.state.duration || 60; $('duration').textContent = clock(next.state.duration);
  const choices = next.qualities || uburoom.QUALITIES;
  if ([...$('quality').options].map(o => o.value).join() !== choices.map(q => q.id).join()) {
    $('quality').replaceChildren(...choices.map(q => { const option = document.createElement('option'); option.value = q.id; option.textContent = q.label; return option; }));
  }
  if (next.mediaUrl && !pending && !qualityPending && document.activeElement !== $('quality')) $('quality').value = uburoom.qualityId(next.quality);
  $('library-panel').hidden = !next.canBrowse;
  browseRoom = next.canBrowse ? next.id : undefined; void library.setRoom(browseRoom); library.setBusy(pending);
  const transformed = Object.keys(uburoom.DEFAULT).some(key => Math.abs(picture[key] - uburoom.DEFAULT[key]) > 1e-8);
  document.title = (next.enabled && video.readyState >= 1 && !playbackError ? '🟢 ' : '') + (transformed ? '🔵 ' : '') + next.title + ' · uburoom';
  renderRemote(); renderVisibility(); renderTransport();
  if (next.feedback && next.feedback.revision !== lastFeedback && Date.now() + offset - next.feedback.at < 3000) {
    lastFeedback = next.feedback.revision;
    if (badge.show(next.feedback, next.state, next.feedback.sender)) {
      $('badge').classList.add('visible'); clearTimeout(badgeTimer); badgeTimer = setTimeout(() => $('badge').classList.remove('visible'), 2500);
    }
  }
  observing = !!next.mediaUrl;
  void sync.synchronize();
}
async function refreshState() {
  if (!selected) return;
  const id = selected, before = Date.now(), sent=performance.now(), exchange=playbackClock.begin(), sequence=++stateRequestSequence;
  try {
    const next = await api('/api/watch/rooms/' + id + '?viewer=' + viewerId + '&quality=' + preferredQuality+(globalThis.uburoomSubtitleRenderers?.supported()?'&subtitles=browser':'')); if (id !== selected || sequence!==stateRequestSequence || next.transportSequence<=stateTransportSequence) return;
    playbackClock.add(exchange,next.timing);
    diagnostics.record('clock-sample',{...playbackClock.read(),requestRttMs:performance.now()-exchange.sent,serverProcessingMs:next.timing?.serverProcessingMs});
    const revision=observationClock.update(next.observationEpoch,next.serverNow,sent,performance.now());
    if(revision!==observationClockRevision){observationBreak++;observationClockRevision=revision;}
    offset = next.serverNow - (before + Date.now()) / 2; applyState(next); fail(playbackError); void reportReadiness();
  } catch (error) { if (id === selected && sequence===stateRequestSequence) unavailable(error.message,'room-poll'); }
}
async function selectRoom(id) {
  if (id === selected) return;
  qualityPending=false;
  stateTransportSequence=0;
  stateRequestSequence++;
  playbackClock.reset();
  if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
  if (selected) void api('/api/watch/rooms/' + selected + '/leave', { viewerId }).catch(() => {});
  clearPlayer('room-select'); toggleRemote(false); selected = id; state = undefined; lastFeedback = browseRoom = undefined;
  await refreshState(); await refreshRooms();
  if (immersive) toggleDrawer(!!state?.canBrowse && !state?.mediaId);
}
function renderRooms(host, rooms) {
  host.replaceChildren();
  for (const room of rooms) {
    const button = document.createElement('button'); button.type = 'button'; button.disabled = !!room.locked;
    if (room.visibility === 'private') button.append(uburoomUI.icon(document,'lock'));
    const name = document.createElement('span'); name.textContent = room.hostName; button.append(name,uburoomUI.icon(document,'users'));
    const count = document.createElement('span'); count.textContent = String(room.viewers); button.append(count);
    button.title = room.locked ? 'Private - No one can join' : room.members?.length ? room.members.join('\n') : 'No viewers yet';
    button.setAttribute('aria-label', room.hostName + (room.visibility === 'private' ? ', private' : '') + ', ' + room.viewers + ' viewers');
    button.setAttribute('aria-pressed', String(room.id === selected)); button.addEventListener('click', () => selectRoom(room.id).catch(error => fail(error.message))); host.append(button);
  }
}
async function refreshRooms() {
  const { rooms } = await api('/api/watch/rooms');
  applyRooms(rooms);
}
function applyRooms(rooms) {
  for (const id of ['rooms','lobby-rooms']) renderRooms($(id), rooms);
  if (!rooms.some(room => room.id === selected && !room.locked)) {
    if (selected) { selected = undefined; unavailable('Room ended or was made private.'); if (immersive) toggleDrawer(false); }
  }
  $('status').textContent = selected ? '' : rooms.length ? 'Choose an active room or create your own.' : 'No active rooms. Create a room to start watching.';
  $('create').textContent = selected ? 'New room' : 'Create room';
  $('create').className = selected ? 'quiet' : 'primary';
  if (!selected) { $('viewers').textContent = ''; $('close-room').hidden = true; $('library-panel').hidden = true;
    $('title').textContent = 'Watch together'; $('details').textContent = ''; $('empty-title').textContent = 'Join or create a room'; $('empty-hint').textContent = 'Choose an active room or create your own.'; }
  placeRoomBar();
}
function renderLibrary() {
  library.setBusy(pending);
}
function clock(value = 0) {
  const seconds = Math.floor(value || 0), minutes = Math.floor(seconds / 60);
  return (seconds >= 3600 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2,'0') : minutes) + ':' + String(seconds % 60).padStart(2,'0');
}
function toggleRemote(show = $('remote').hidden) {
  const parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
  if ($('remote').parentElement !== parent) parent.append($('remote'));
  $('remote').hidden = !show; $('stage').classList.toggle('remote-open', show); $('open-remote').setAttribute('aria-expanded', String(show));
  if (!show) remote.stop();
}
function pumpVolume() {
  clearTimeout(volumeTimer);
  if (volumeWanted === undefined || !selected || !state) return;
  const wait = Math.max(0, 500 - (Date.now() - lastVolumeAt));
  if (pending || wait) { volumeTimer = setTimeout(pumpVolume, Math.max(100, wait)); return; }
  const percent = volumeWanted; volumeWanted = undefined; lastVolumeAt = Date.now();
  execute({ action: 'media.volume.set', args: { percent } }).then(() => {
    if (volumeWanted === undefined && volumeDraft === percent) volumeDraft = undefined; renderTransport();
  }).catch(error => { dropVolume(); fail(error.message); });
}
$('player-volume').addEventListener('pointerdown', () => { volumeDragging = true; });
$('player-volume').addEventListener('input', () => { volumeWanted = volumeDraft = Number($('player-volume').value); pumpVolume(); });
$('player-volume').addEventListener('change', () => { volumeDragging = false; volumeWanted = volumeDraft = Number($('player-volume').value); pumpVolume(); });
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
  if ([3,4].includes(code) && state.format === 'file') {
    void compatibleFallback('The original video could not be decoded.'); return;
  }
  if ([3,4].includes(code) && /kUnsupportedConfig|DECODER_ERROR_NOT_SUPPORTED|decoder.*(?:not supported|initialization failed)/i.test(message)) {
    if (state.format !== 'av1') void compatibleFallback('The video decoder is unsupported.');
    else unsupportedDecoder(); return;
  }
  // HLS manages recoverable media errors through its bounded handler.
  if (hls && [3,4].includes(code)) return;
  if (state.format === 'av1') { av1?.destroy(); video.pause(); }
  playbackError = 'Video could not play (media error ' + (code || 'unknown') + ').'; fail(playbackError);
});
$('enable-acceleration').addEventListener('click', async () => {
  if (!sdk) return;
  try { await sdk.commands.encourageHardwareAcceleration(); }
  catch { fail('Enable hardware acceleration in Discord Settings → Advanced, then reopen the Activity.'); }
});
document.addEventListener('keydown', event => {
  if (document.body.classList.contains('activity-pip')) return;
  if (event.code === 'Escape' && !$('remote').hidden) { toggleRemote(false); $('open-remote').focus(); return; }
  if (event.code === 'Escape' && !drawer.hidden) { toggleDrawer(false); $('drawer-open').focus(); return; }
  if (event.code === 'F8' || event.code === 'KeyC' && event.altKey && event.shiftKey) { event.preventDefault(); if (!event.repeat) toggleRemote(); return; }
  if (!state || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('button,input,select,textarea,[contenteditable=true]')) return;
  const command = event.code === 'Space' ? {action:state.pauseAt || state.state.paused && !state.waitingForReady?'media.play':'media.pause'} : ['ArrowLeft','ArrowRight'].includes(event.code) ?
    {action:'media.seek.relative',args:{seconds:event.code==='ArrowLeft'?-15:15}} : event.code==='KeyM' ? {action:state.state.muted?'media.unmute':'media.mute'} : undefined;
  if (command) { event.preventDefault(); execute(command).catch(error => fail(error.message)); }
});
$('open-remote').addEventListener('click', () => toggleRemote());
document.addEventListener('pointerdown', event => {
  if (!drawer.hidden && !event.composedPath().some(node => ['drawer','drawer-open','drawer-close'].includes(node.id)) && !event.composedPath().some(node => node instanceof HTMLDialogElement || node.classList?.contains('player-settings-menu'))) {
    toggleDrawer(false);
    $('stage').focus({preventScroll:true});
  }
});
document.addEventListener('pointerdown', event => { if (!$('remote').hidden && !event.composedPath().some(node => ['remote','open-remote'].includes(node.id))) toggleRemote(false); });
$('fullscreen').addEventListener('click', () => { (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error => fail(error.message)); });
document.addEventListener('fullscreenchange', () => { updateMobilePlayer(); updateFullscreenLayout(); glyph('fullscreen', document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'); $('fullscreen').title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; $('fullscreen').setAttribute('aria-label', $('fullscreen').title); });
async function createRoom() {
  if (creating) return; creating = true;
  for (const id of ['create','lobby-create']) $(id).disabled = true;
  try { const room = await api('/api/watch/rooms', {}); await selectRoom(room.id); renderLibrary(); }
  catch (error) { fail(error.message); }
  finally { creating = false; for (const id of ['create','lobby-create']) $(id).disabled = false; }
}
for (const id of ['create','lobby-create']) $(id).addEventListener('click', createRoom);
$('close-room').addEventListener('click', async () => {
  if (!selected || pending) return;
  const id = selected; pending = true;
  try {
    await api('/api/watch/rooms/' + id + '/leave', { viewerId });
    selected = undefined; browseRoom = undefined; unavailable('','leave'); await refreshRooms();
  } catch (error) { fail(error.message); } finally { pending = false; }
});
$('admin-end-room').addEventListener('click', async () => {
  if (!state?.adminMode || pending) return;
  const id = selected; pending = true;
  try {await api('/api/watch/rooms/' + id + '/close',{});selected=undefined;browseRoom=undefined;unavailable('','end');await refreshRooms();}
  catch(error){fail(error.message);} finally {pending=false;}
});
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
  config = await api('/api/watch/config');
  if (config.watchVersion !== 18) throw new Error('The player and server versions differ. Reload after the server update.');
  $('plex-login').hidden=!config.unifiedAccounts||!config.plexConfigured;
  if (config.demo && ['host','guest','guest2'].includes(params.get('demo'))) {
    if(config.accountDemo&&!activity)await api('/api/account/demo-login',{persona:params.get('demo')});
    else acceptIdentity(await api('/api/watch/demo-login', { persona:params.get('demo'), activity }));
  } else if (params.has('frame_id')) {
    if (!config.clientId) throw new Error('Configure Discord OAuth on the server first');
    sdk = new uburoomDiscord.DiscordSDK(config.clientId); await sdk.ready();
    acceptIdentity(await activityIdentity());
    await sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', updateActivityLayout);
  }
  try { me = await api('/api/watch/me'); } catch (error) { $('status').textContent = ''; if (activity) throw error; return; }
  renderAccount(); $('welcome').hidden = true; $('app').hidden = false;
  $('diagnostic-actions').hidden=false;
  transport=new uburoomWatchTransport({
    url:location.origin.replace(/^http/,'ws')+'/watch-socket',identity:()=>({token,csrf:me?.csrf}),
    onReady:async()=>{await refreshState();await refreshRooms();},
    onClose:()=>{diagnostics.record('request-failed',{request:'room-poll',failure:'network'});playbackClock.reset();unavailable('Disconnected. Reconnecting…','room-poll');},
    beginClock:()=>({exchange:playbackClock.begin(),sent:performance.now(),before:Date.now()}),
    onClock:(message,sample)=>{
      playbackClock.add(sample.exchange,message.timing);
      offset=message.serverNow-(sample.before+Date.now())/2;
      if(state){const revision=observationClock.update(state.observationEpoch,message.serverNow,sample.sent,performance.now());
        if(revision!==observationClockRevision){observationBreak++;observationClockRevision=revision;}}
    },
    onMessage:message=>{
      if(message.type==='identity'){me=message.value;renderAccount();}
      else if(message.type==='rooms'&&message.status===200)applyRooms(message.value.rooms);
      else if(message.type==='state'&&message.path.split('?')[0]==='/api/watch/rooms/'+selected){
        if(message.status===200){applyState(message.value);fail(playbackError);void reportReadiness();}
        else unavailable(message.value?.error||'Room unavailable','room-poll');
      } else if(message.type==='unavailable')unavailable(message.value?.error||'Room connection unavailable','room-poll');
    }
  });
  $('create').hidden = false; $('library-panel').hidden = true; renderTransport();
  setInterval(async () => {
    try { await renewIdentity(); }
    catch (error) { unavailable('Disconnected. ' + error.message,'identity-poll'); }
  }, 1000);
  await transport.connect();
  await refreshRooms();
  if(params.get('account')==='1'&&!activity){history.replaceState(history.state,'','/watch');if(typeof showAccount==='function')await showAccount();}
  const requestedRoom = params.get('room');
  if (!activity && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestedRoom || '')) {
    history.replaceState(history.state,'','/watch');
    await selectRoom(requestedRoom);
  }
}
start().catch(error => fail(error.message));
