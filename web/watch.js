'use strict';
const $ = id => document.getElementById(id);
const viewerId = crypto.randomUUID(), params = new URLSearchParams(location.search);
let token, me, config, selected, state, receivedAt, offset = 0, pending = false, polling = false, creating = false;
let identityExpiresAt = 0, identityRenewAt = 0, identityRetryAt = 0, identityRenewal, identityGeneration = 0;
let hls, mediaVersion, mediaSource, lastFeedback, badgeTimer, seekDragging = false, sdk;
let playbackError = '', autoplayBlocked = false, probing = false, readyVersion, readyPending = false, readinessSent, browseSession, preferredQuality = '720p4';
let volumeWanted, volumeDraft, volumeTimer, lastVolumeAt = 0, volumeDragging = false;
const activity = params.has('frame_id');
let theater = false, layoutMode, fallbackVersion, fallbackPending = false, frameStartedAt, videoFrames = 0, frameCallback;
let hlsRecoveryTimer, hlsRecoveryCount = 0, hlsNetworkRetries = 0, hlsNetworkFailure, hlsNetworkInterrupted = false;
let hlsRefreshPending = false, hlsRefreshVersion, hlsRefreshTimes = [];
let av1, av1FallbackVersion;
let observationPending = false, observationSequence = 0, observationBreak = 0, observing = false, playerWaiting = false;
let browserHandoff, browserHandoffTimer, browserVerification;
let trackNotice='', trackNoticeError=false, trackActionError='', trackContext;
const video = $('video');
const captions = new uburoomSubtitles(video,value=>{trackNotice=value.message;trackNoticeError=value.error;renderTracks();});
video.volume = .5;
function glyph(id, symbol) { $(id).replaceChildren(uburoomUI.icon(document, symbol)); }
for (const pair of [['refresh','refresh'],['open-remote','remote'],['empty-symbol','play'],['fullscreen','fullscreen'],
  ['join-playback','play'],['player-play','play'],['previous','start'],['seek-back','back'],['seek-forward','forward'],['next','end'],['player-mute','mute'],
  ['theater','theater'],['tracks-open','settings'],['tracks-close','close'],['drawer-symbol','drawer'],['drawer-close','close'],['playback-close','close'],['admin-mode','admin'],['browser-symbol','open'],['options-chevron','chevron'],['library-chevron','chevron']]) glyph(...pair);
const badge = uburoomUI.mountBadge($('badge'));
const remote = uburoomUI.mount($('remote'), { showAutoJoin: false, volumeInterval: 600, execute: command => execute(command), close: () => toggleRemote(false) });
const settings = uburoomUI.mount($('remote-settings'), { settingsOnly: true, showAutoJoin: false, execute: command => execute(command) });
const library = uburoomLibrary.mount($('library-content'), {
  request:(path,signal) => api(path,undefined,{signal}),
  artwork:async (path,signal) => {
    const response = await fetch(path,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),headers:token ? {Authorization:'Bearer ' + token} : {}});
    if (!response.ok) throw new Error('Artwork unavailable'); return response.blob();
  },
  load:item => execute({action:'media.load',args:{mediaId:item.id,quality:item.id === 'demo' ? 'direct' : preferredQuality}}),
  close:() => toggleDrawer(false), getPlayer:() => state, showTest:showPlaybackTest, hideTest:hidePlaybackTest
});
function showPlaybackTest() {
  if (document.body.classList.contains('activity-pip') || $('playback-dialog').open) return;
  const testParams = new URLSearchParams(location.search); testParams.set('embedded','1');
  $('playback-frame').src = '/watch/test?' + testParams;
  $('playback-dialog').showModal(); $('playback-close').focus();
}
function hidePlaybackTest() {
  if ($('playback-dialog').open) $('playback-dialog').close();
  // Unload the diagnostic player so audio/decoding stop as soon as it closes.
  $('playback-frame').removeAttribute('src');
}
$('playback-close').onclick = () => library.closeTest();
$('playback-dialog').addEventListener('cancel',event => { event.preventDefault(); library.closeTest(); });
window.addEventListener('message',event => {
  if (event.origin === location.origin && event.source === $('playback-frame').contentWindow && event.data?.type === 'uburoom-test-close') library.closeTest();
});
function fail(message) {
  const changed = $('error').textContent !== message;
  $('error').textContent = message;
  if (message && changed && theater && !document.body.classList.contains('activity-pip')) toggleDrawer(true);
}
async function api(path, data, options = {}) {
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  if (data !== undefined) { headers['Content-Type'] = 'application/json'; if (me?.csrf) headers['X-CSRF-Token'] = me.csrf; }
  const response = await fetch(path, { method: data === undefined ? 'GET' : 'POST', headers,
    body: data === undefined ? undefined : JSON.stringify(data), signal: options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000), keepalive: !!options.keepalive });
  const value = await response.json(); if (!response.ok) throw new Error(value.error || 'Request failed'); return value;
}
function acceptIdentity(auth) {
  token = auth.token; identityExpiresAt = auth.expiresAt;
  identityRenewAt = identityExpiresAt - Math.min(60000, Math.floor((identityExpiresAt - Date.now()) / 5));
  identityRetryAt = 0; identityGeneration++;
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
    identityRetryAt = Date.now() + 10000;
    if (Date.now() >= identityExpiresAt) throw error;
  }).finally(() => { identityRenewal = undefined; });
  return identityRenewal;
}
function dropVolume() { clearTimeout(volumeTimer); volumeWanted = volumeDraft = undefined; volumeDragging = false; }
// Move the actual shells so their controls, state and listeners stay shared.
const drawer = document.createElement('aside'); drawer.id = 'drawer'; drawer.hidden = true;
drawer.setAttribute('aria-label', 'Sessions and library'); document.body.append(drawer);
const shells = ['account','welcome','session-bar','options-panel','library-panel','status','error','acceleration-help'].map(id => {
  const element = $(id), marker = document.createComment(id); element.before(marker); return { element, marker };
});
function toggleDrawer(show = drawer.hidden) {
  const parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
  if (drawer.parentElement !== parent) parent.append(drawer);
  drawer.hidden = !show; $('stage').classList.toggle('drawer-open', show);
  $('drawer-open').setAttribute('aria-expanded', String(show));
  if (!show) toggleRemote(false);
}
function setTheater(enabled) {
  enabled = activity || enabled;
  theater = enabled; toggleDrawer(false); document.body.classList.toggle('theater', enabled);
  for (const { element, marker } of shells) enabled ? drawer.append(element) : marker.after(element);
  $('drawer-open').hidden = $('drawer-close').hidden = !enabled;
  $('theater').setAttribute('aria-pressed', String(enabled));
  $('theater').title = $('theater').ariaLabel = enabled ? 'Exit theater mode' : 'Theater mode';
  placeSessionBar();
}
function placeSessionBar() {
  $('session-bar').hidden = !me;
  $('session-lobby').hidden = !theater || !!selected || !me;
}
for (const name of ['options','library']) $(name + '-collapse').addEventListener('click', () => {
  const button = $(name + '-collapse'), content = $(name + '-content');
  content.hidden = !content.hidden; button.setAttribute('aria-expanded', String(!content.hidden));
});
function renderAccount() {
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
  if (pip) { toggleDrawer(false); toggleRemote(false); if ($('privacy-dialog').open) $('privacy-dialog').close('cancel'); if ($('playback-dialog').open) { hidePlaybackTest(); library.closeTest(); } }
  if(pip&&$('account-dialog').open)$('account-dialog').close();
  if(pip&&$('tracks-dialog').open)$('tracks-dialog').close();
}
document.body.classList.toggle('activity', activity); $('fullscreen').hidden = $('theater').hidden = activity;
if (activity) {
  $('brand-link').href = '/watch' + location.search; $('brand-link').setAttribute('aria-label', 'uburoom watch');
  $('welcome').hidden = true;
}
setTheater(activity); updateActivityLayout();
window.addEventListener('resize', () => { updateActivityLayout(); renderTransport(); });
$('theater').addEventListener('click', () => setTheater(!theater));
$('drawer-open').addEventListener('click', () => {
  if (!theater) return;
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
  if (pending) {
    const id = selected, version = state.mediaVersion;
    setTimeout(() => { if (selected === id && state?.mediaVersion === version) void compatibleFallback(reason,preferHLS); }, 200); return;
  }
  if (useAV1) av1FallbackVersion = state.mediaVersion; else fallbackVersion = state.mediaVersion;
  fallbackPending = true;
  stopHls();
  try { await execute({ action:'media.quality.set', args:{quality:state.quality, compatible:true, ...(useAV1 ? {fallback:'av1'} : {})} }); }
  catch (error) { playbackError = reason + ' ' + (useAV1 ? 'AV1' : 'H.264') + ' fallback failed: ' + error.message; fail(playbackError); }
  finally { fallbackPending = false; }
}
function watchFrames() {
  if (!video.requestVideoFrameCallback) return;
  frameCallback = video.requestVideoFrameCallback(() => { videoFrames++; watchFrames(); });
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
function clearPlayer() {
  captions.reset(); trackActionError='';
  observing = false; observationBreak++; playerWaiting = false;
  av1?.destroy(); av1 = undefined;
  clearTimeout(hlsRecoveryTimer); hlsRecoveryCount = 0; $('acceleration-help').hidden = true;
  if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
  frameCallback = undefined; frameStartedAt = undefined; videoFrames = 0;
  remote.stop(); dropVolume(); video.pause(); stopHls();
  video.removeAttribute('src'); video.load(); mediaVersion = mediaSource = readyVersion = readinessSent = undefined;
  playbackError = ''; autoplayBlocked = false;
  $('join-playback').hidden = true; $('empty-stage').hidden = false; $('ready-status').textContent = '';
}
function stopHls() {
  clearTimeout(hlsRecoveryTimer);
  hlsNetworkRetries = 0; hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  const client = hls; hls = undefined; client?.destroy();
}
function unsupportedDecoder() {
  av1?.destroy(); video.pause(); stopHls(); clearTimeout(hlsRecoveryTimer);
  playbackError = activity ? 'Discord cannot decode this video with hardware acceleration off. Enable acceleration and reopen the Activity, or watch on the website.' :
    'This browser cannot decode the video. Try Firefox or Chrome, or enable hardware acceleration.';
  $('acceleration-help').hidden = !activity;
  $('enable-acceleration').hidden = !sdk;
  fail(playbackError);
}
function restartHlsForSeek(target) {
  if (!hls || !hlsNetworkInterrupted || state?.mediaUrl !== mediaSource || uburoomPlayback.bufferedAhead(video.buffered,target) > .05) return;
  // A new authorized room seek supersedes the old segment's retry timer.
  // stopLoad keeps MediaSource and its cached ranges attached.
  clearTimeout(hlsRecoveryTimer); hlsNetworkRetries = 0;
  if (playbackError === hlsNetworkFailure) playbackError = '';
  hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  hls.stopLoad(); hls.startLoad(target);
}
async function refreshHlsSession(client) {
  if (hls !== client || state?.format !== 'hls' || state.mediaUrl !== mediaSource || hlsRefreshPending || pending) return;
  if (hlsRefreshVersion !== state.mediaVersion) { hlsRefreshVersion = state.mediaVersion; hlsRefreshTimes = []; }
  const now = Date.now(); hlsRefreshTimes = hlsRefreshTimes.filter(time => now-time < 60000);
  if (hlsRefreshTimes.length >= 3) return;
  hlsRefreshTimes.push(now); hlsRefreshPending = true;
  const version = state.mediaVersion, streamVersion = state.streamVersion;
  try {
    await execute({action:'media.stream.refresh',args:{mediaVersion:version,streamVersion}});
  } catch {
    // The old buffered media can still play. HLS's bounded network retry
    // reports an error if delivery does not return in time.
  } finally { hlsRefreshPending = false; }
}
function handleHlsFragmentBuffered(client) {
  if (hls !== client || !state?.state || state.mediaUrl !== mediaSource) return;
  // A buffered fragment from an obsolete seek does not establish that the
  // shared playback position can advance again.
  const target = expected(), ahead = uburoomPlayback.bufferedAhead(video.buffered,target);
  if (ahead <= .05 || ahead + .05 < Math.min(.5,Math.max(0,state.state.duration - target))) return;
  clearTimeout(hlsRecoveryTimer);
  const resume = !!hlsNetworkFailure && playbackError === hlsNetworkFailure;
  hlsNetworkRetries = 0; hlsNetworkFailure = undefined; hlsNetworkInterrupted = false;
  if (resume) {
    playbackError = '';
    fail('');
    void synchronize();
  }
}
function handleHlsError(client, data) {
  if (hls !== client) return;
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
      const source = mediaSource, version = state?.mediaVersion, stream = state?.streamVersion, room = selected;
      const retry = () => {
        if (hls !== client || !state?.state || selected !== room || mediaSource !== source || state.mediaUrl !== source ||
          state.mediaVersion !== version || state.streamVersion !== stream) return;
        // Wait for online state and a recent authorized poll before loading.
        if (navigator.onLine === false || performance.now()-receivedAt > 3000) { hlsRecoveryTimer = setTimeout(retry,delay); return; }
        const target = expected();
        if (!Number.isFinite(target) || target < 0 || target >= state.state.duration) return;
        // Once the delivery error pauses local playback, normal synchronization
        // is suspended. Retarget MSE too, or hls.js can refill the old position.
        if (video.readyState >= 1 && Math.abs(video.currentTime-target) > .65) video.currentTime = target;
        hlsRecoveryTimer = undefined; client.startLoad(target);
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
      if (hls === client && state?.mediaUrl === mediaSource) { client.recoverMediaError(); client.startLoad(expected()); }
    }, 0);
    return;
  }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR || data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET) {
    void compatibleFallback('H.264 decoder failed.'); return;
  }
  stopHls();
  playbackError = data.type === Hls.ErrorTypes.MEDIA_ERROR ?
    'The browser could not decode the video stream (' + data.details + '). Try enabling hardware acceleration or use the website.' :
    'The video stream could not load (' + data.details + '). Check the connection and try again.';
  fail(playbackError);
}
function unavailable(message) {
  if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
  clearPlayer(); state = undefined; toggleRemote(false);
  browseSession = undefined; $('library-panel').hidden = true; void library.setSession(undefined);
  renderRemote(); renderVisibility(); renderTransport(); document.title = 'uburoom watch'; fail(message);
}
async function unlockLocal() {
  if (!state?.mediaUrl || video.readyState < 2 || probing || playbackError) return false;
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
  if (!selected || !state || pending) throw new Error('Wait for an available viewing session');
  if (['media.play','media.toggle'].includes(command.action) && state.state.paused && expected() < state.state.duration - .1) await unlockLocal();
  const id = selected, epoch = state.epoch; pending = true; fail('');
  try {
    const result = await api('/api/watch/rooms/' + id + '/command', { viewerId, epoch, expiresAt: Date.now() + offset + 2500, command });
    if (selected !== id) return { status: 'unavailable' };
    if (result.status !== 'applied') throw new Error(result.message);
    await refreshState(); if (command.action === 'session.visibility') await refreshRooms(); return result;
  } finally { pending = false; renderLibrary(); renderRemote(); renderVisibility(); renderTransport(); pumpVolume(); }
}
function renderRemote() {
  const options = { available: !!state, canSave: !!state?.canManage,
    canPlayback: !!state?.canPlayback, canAudio: !!state?.mediaUrl, canTransform: !!state?.canTransform,
    session: state?.canManage ? { ...state, connected: true, paired: true, reachable: true, live: state.enabled } : null };
  remote.render(state?.state, options); settings.render(state?.state, options);
}
function renderVisibility() {
  $('options-panel').hidden = !state; $('watch-settings').hidden = !state?.canManage;
  $('admin-end-room').hidden = !state?.adminMode || state?.isHost; $('admin-end-room').disabled = pending;
  for (const id of ['visibility', 'drawer-visibility']) {
    const button = $(id), privateSession = state?.visibility === 'private';
    button.hidden = !state; button.disabled = pending || !state?.canManage;
    button.textContent = privateSession ? 'Private - No one can join' : 'Public'; button.classList.toggle('private', privateSession);
    button.setAttribute('aria-label', state?.canManage ? (privateSession ? 'Private session: make public' : 'Public session: make private') : 'Public session');
    button.title = state?.canManage ? (privateSession ? 'Only you can watch. Make public.' : 'Server members can watch. Make private.') : 'Only the host can change visibility';
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
    await execute({action:'session.visibility',args:{visibility:'private'}});
  } else await execute({action:'session.visibility',args:{visibility:'public'}});
}
for (const id of ['visibility','drawer-visibility']) $(id).addEventListener('click', () => changeVisibility().catch(error=>fail(error.message)));
function renderTransport() {
  const available = !!state?.mediaUrl, playback = available && state.canPlayback;
  for (const id of ['player-play','previous','seek-back','seek-forward']) $(id).disabled = !playback || pending;
  $('timeline').disabled = !playback;
  $('player-mute').disabled = !available || pending; $('player-volume').disabled = !available;
  $('next').disabled = !playback || !state?.hasNext || pending;
  $('quality').disabled = !available || state?.mediaId === 'demo' || pending;
  const paused = state?.state.paused !== false;
  $('stage').classList.toggle('paused', paused); $('stage').classList.toggle('blocked', autoplayBlocked);
  glyph('player-play', paused ? 'play' : 'pause'); $('player-play').setAttribute('aria-label', paused ? 'Play' : 'Pause'); $('player-play').title = paused ? 'Play' : 'Pause';
  glyph('player-mute', state?.state.muted ? 'muted' : 'mute'); $('player-mute').setAttribute('aria-label', state?.state.muted ? 'Unmute' : 'Mute');
  $('player-mute').title = state?.state.muted ? 'Unmute' : 'Mute';
  $('join-playback').hidden = !state?.mediaUrl || !paused && !autoplayBlocked;
  $('join-playback').disabled = !autoplayBlocked && (!playback || pending);
  $('join-playback').setAttribute('aria-label', autoplayBlocked ? 'Join playback' : 'Play'); $('join-playback').title = autoplayBlocked ? 'Join playback' : 'Play';
  $('ready-status').textContent = state?.waitingForReady ? autoplayBlocked ? 'Press Play to join playback' : 'Waiting for viewers…' : autoplayBlocked ? 'Press Play to join playback' : '';
  if (!volumeDragging) $('player-volume').value = volumeDraft ?? state?.state.volume ?? 50;
  renderTracks();
  captions.layout($('stage').matches(':hover,:focus-within') || paused || autoplayBlocked || !$('remote').hidden,innerWidth<=700);
}
function trackLabel(track) {
  const roles=[track.forced && 'Forced',track.sdh && 'SDH',track.commentary && 'Commentary',track.description && 'Audio description'].filter(Boolean);
  return [track.label,track.codec?.toUpperCase(),track.channels && track.channels+' ch',...roles,!track.available && 'Unavailable'].filter(Boolean).join(' · ');
}
function renderTracks() {
  const tracks=state?.tracks, available=!!tracks;
  $('tracks-open').hidden=!available || !tracks.audio.length && !tracks.subtitles.length;
  $('tracks-open').disabled=pending;
  const render=(id,rows,choices,value)=>{
    const options=[...choices,...(rows || []).map(row=>({id:row.id,label:trackLabel(row),disabled:!row.available}))];
    const element=$(id), signature=JSON.stringify(options);
    if(element.dataset.options!==signature){element.replaceChildren(...options.map(row=>{const option=document.createElement('option');option.value=row.id;option.textContent=row.label;option.disabled=!!row.disabled;return option;}));element.dataset.options=signature;}
    element.value=value || 'auto'; element.disabled=!available || pending;
  };
  render('audio-track',tracks?.audio,[{id:'auto',label:'Automatic (Plex)'}],tracks?.audioChoice);
  render('subtitle-track',tracks?.subtitles,[{id:'auto',label:'Automatic (Plex)'},{id:'off',label:'Off'}],tracks?.subtitleChoice);
  const audio=tracks?.audio.find(row=>row.id===tracks.audioId), subtitle=tracks?.subtitles.find(row=>row.id===tracks.subtitleId), burned=subtitle?.delivery==='burn';
  $('audio-track-status').textContent=audio ? audio.label+(state.format!=='file' ? ' · Stereo playback' : '') : '';
  if(document.activeElement!==$('subtitle-offset'))$('subtitle-offset').value=tracks?.subtitleOffset || 0;
  $('subtitle-offset').disabled=!available || pending || !subtitle || burned;
  $('subtitle-delay-hint').textContent=burned ? 'Timing is fixed by Plex for subtitles included in the video.' : subtitle ? 'Positive values show subtitles later.' : 'Select text subtitles to adjust their timing.';
  $('track-status').textContent=trackActionError || tracks?.subtitleError || trackNotice || (burned ? 'Plex includes these subtitles in the video to preserve their appearance and saves the choice for this title.' : '');
  const error=!!trackActionError || !!tracks?.subtitleError || trackNoticeError;
  $('track-status').classList.toggle('error',error);
  $('subtitle-status').hidden=!trackNoticeError && !tracks?.subtitleError;
  $('subtitle-status').textContent='Subtitles could not be shown. Open Audio and subtitles for details.';
  $('subtitle-retry').hidden=!trackNoticeError || !state?.subtitleUrl;
}
async function changeTrack(args) {
  if(!$('tracks-dialog').open || !state || pending || !trackContext || trackContext.mediaVersion!==state.mediaVersion || trackContext.streamVersion!==state.streamVersion)return;
  trackActionError='';
  try { await execute({action:'media.tracks.set',args:{...trackContext,...args}}); }
  catch(error){trackActionError=error.message;}
  finally{renderTracks();}
}
$('tracks-open').addEventListener('click',()=>{
  if(!state?.tracks || pending)return;
  trackContext={mediaVersion:state.mediaVersion,streamVersion:state.streamVersion}; trackActionError=''; renderTracks();
  $('tracks-dialog').showModal(); $('audio-track').focus();
});
$('tracks-close').addEventListener('click',()=>$('tracks-dialog').close());
$('tracks-dialog').addEventListener('close',()=>{trackContext=undefined; $('tracks-open').focus();});
$('audio-track').addEventListener('change',()=>void changeTrack({audioId:$('audio-track').value}));
$('subtitle-track').addEventListener('change',()=>void changeTrack({subtitleId:$('subtitle-track').value}));
$('subtitle-offset').addEventListener('change',()=>{if($('subtitle-offset').reportValidity())void changeTrack({subtitleOffset:$('subtitle-offset').valueAsNumber});});
$('subtitle-retry').addEventListener('click',()=>captions.retry());
function expected() {
  if (!state) return 0;
  return Math.min(state.state.duration || 0, state.state.position + (state.state.paused ? 0 : (performance.now() - receivedAt) / 1000));
}
async function reportObservation() {
  if (observationPending || !observing || !selected || !state?.mediaUrl || !state.streamVersion || mediaSource !== state.mediaUrl) return;
  const id = selected;
  const playerState = playbackError || video.error ? 'error' : autoplayBlocked ? 'blocked' : video.ended ? 'ended' : video.seeking ? 'seeking' :
    probing ? 'buffering' : video.paused ? 'paused' : playerWaiting || video.readyState < 3 ? 'buffering' : 'playing';
  const quality = video.getVideoPlaybackQuality?.();
  const data = {viewerId,mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,observationEpoch:state.observationEpoch,
    sequence:++observationSequence,sampleAt:performance.now(),observedAt:Date.now()+offset,position:video.currentTime,
    rate:video.playbackRate,frames:quality ? quality.totalVideoFrames-quality.droppedVideoFrames : videoFrames,discontinuity:observationBreak,state:playerState};
  observationPending = true;
  try { await api('/api/watch/rooms/' + id + '/observe',data); }
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
  const id = selected, version = state.mediaVersion;
  const ready = video.readyState >= 3 && decodedFrames() > 0 && readyVersion === version && !playbackError;
  const key = id + ':' + version + ':' + ready;
  if (readinessSent === key || !state.waitingForReady && !ready) return;
  readyPending = true;
  try { await api('/api/watch/rooms/' + id + '/ready', { viewerId, mediaVersion: version,
    ready }); readinessSent = key; } catch {} finally { readyPending = false; }
}
async function synchronize() {
  if (!state?.mediaUrl || video.readyState < 1 || probing || playbackError) return;
  const target = expected(), difference = target - video.currentTime;
  if (hlsNetworkFailure && !state.state.paused && uburoomPlayback.bufferedAhead(video.buffered,target) < .5) {
    playbackError = hlsNetworkFailure; video.pause(); fail(playbackError); return;
  }
  const bufferedTarget = state.format === 'av1' && [...Array(video.buffered.length)].some((_, i) =>
    target >= video.buffered.start(i) - .05 && target < video.buffered.end(i));
  // A shared seek/restart can supersede a native seek still waiting for old
  // chunks. Retarget it once the new source-time window is buffered.
  if ((!video.seeking || bufferedTarget) && Math.abs(difference) > .65) {
    try { video.currentTime = Math.max(0, Math.min(target, (Number.isFinite(video.duration) ? video.duration : state.state.duration) - .05)); } catch {}
  }
  video.playbackRate = state.state.paused || Math.abs(difference) < .15 || Math.abs(difference) > .65 ? 1 : difference > 0 ? 1.04 : .96;
  video.volume = state.state.volume / 100; video.muted = state.state.muted;
  if (state.state.paused) {
    video.pause();
    if (state.waitingForReady && readyVersion !== state.mediaVersion && !autoplayBlocked && video.readyState >= 2) { await unlockLocal(); void reportReadiness(); }
  } else if (video.paused && !autoplayBlocked) {
    try { await video.play(); readyVersion = state.mediaVersion; autoplayBlocked = false; }
    catch (error) { if (error.name === 'NotAllowedError') autoplayBlocked = true; }
  }
  renderTransport();
  checkVideoFrames();
}
function applyState(next) {
  const changed = mediaVersion !== next.mediaVersion || mediaSource !== next.mediaUrl;
  const previousTarget = state ? expected() : undefined;
  if(trackContext && trackContext.mediaVersion!==next.mediaVersion){$('tracks-dialog').close();trackContext=undefined;}
  if (state && state.epoch !== next.epoch) dropVolume();
  state = next; receivedAt = performance.now();
  if($('tracks-dialog').open)trackContext={mediaVersion:next.mediaVersion,streamVersion:next.streamVersion};
  if (changed) {
    clearPlayer(); mediaVersion = next.mediaVersion; mediaSource = next.mediaUrl;
    if (next.mediaUrl) {
      $('empty-stage').hidden = true;
      watchFrames();
      if (next.format === 'file' && uburoomPlayback.needsCompatible(next,type => video.canPlayType(type))) {
        queueMicrotask(() => { if (state === next) void compatibleFallback('The browser does not support the original codecs.',true); });
      } else if (next.format === 'av1') {
        try { av1 = new uburoomAV1(video, next.mediaUrl, expected, message => { playbackError = message; video.pause(); fail(message); }); }
        catch (error) { playbackError = 'AV1 WebM transport unavailable: ' + error.message; fail(playbackError); }
      } else if (next.format === 'hls' && Hls.isSupported()) {
        const client = hls = new Hls(uburoomPlayback.hlsConfig(next.bitrate));
        client.on(Hls.Events.ERROR, (_, data) => handleHlsError(client, data));
        client.on(Hls.Events.FRAG_BUFFERED, () => handleHlsFragmentBuffered(client));
        client.loadSource(next.mediaUrl); client.attachMedia(video);
      } else video.src = next.mediaUrl;
    }
  }
  if (!changed && previousTarget !== undefined && Math.abs(expected()-previousTarget) > 1.5) restartHlsForSeek(expected());
  captions.update(next);
  if(next.mediaError)playbackError=next.mediaError;
  const picture = next.state.picture;
  video.style.scale = picture.zoom * picture.stretchX + ' ' + picture.zoom * picture.stretchY;
  video.style.translate = picture.x * 100 + '% ' + picture.y * 100 + '%';
  $('title').textContent = next.title; $('details').textContent = next.subtitle;
  $('viewers').textContent = next.viewers + (next.viewers === 1 ? ' viewer' : ' viewers');
  $('viewers').title = 'Host: ' + next.hostName;
  $('empty-title').textContent = 'Choose something to watch'; $('empty-hint').textContent = next.canManage ? 'Select a video from the library below.' : 'The host chooses the video.';
  $('close-room').hidden = false; $('close-room').textContent = next.viewers === 1 && next.canManage ? 'End session' : 'Leave session';
  $('timeline').max = next.state.duration || 60; $('duration').textContent = clock(next.state.duration);
  const choices = next.qualities || uburoom.QUALITIES;
  if ([...$('quality').options].map(o => o.value).join() !== choices.map(q => q.id).join()) {
    $('quality').replaceChildren(...choices.map(q => { const option = document.createElement('option'); option.value = q.id; option.textContent = q.label; return option; }));
  }
  if (next.mediaUrl && !pending && document.activeElement !== $('quality')) $('quality').value = uburoom.qualityId(next.quality);
  $('library-panel').hidden = !next.canBrowse;
  browseSession = next.canBrowse ? next.id : undefined; void library.setSession(browseSession); library.setBusy(pending);
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
  void synchronize();
}
async function refreshState() {
  if (!selected) return;
  const id = selected, before = Date.now();
  try {
    const next = await api('/api/watch/rooms/' + id + '?viewer=' + viewerId + '&quality=' + preferredQuality); if (id !== selected) return;
    offset = next.serverNow - (before + Date.now()) / 2; applyState(next); fail(playbackError); void reportReadiness();
  } catch (error) { if (id === selected) unavailable(error.message); }
}
async function selectRoom(id) {
  if (id === selected) return;
  if($('tracks-dialog').open)$('tracks-dialog').close(); trackContext=undefined;
  if (selected) void api('/api/watch/rooms/' + selected + '/leave', { viewerId }).catch(() => {});
  clearPlayer(); toggleRemote(false); selected = id; state = undefined; lastFeedback = browseSession = undefined;
  await refreshState(); await refreshRooms();
  if (theater) toggleDrawer(!!state?.canBrowse && !state?.mediaId);
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
  for (const id of ['rooms','lobby-rooms']) renderRooms($(id), rooms);
  if (!rooms.some(room => room.id === selected && !room.locked)) {
    if (selected) { selected = undefined; unavailable('Session ended or was made private.'); if (theater) toggleDrawer(false); }
  }
  $('status').textContent = selected ? '' : rooms.length ? 'Choose an active session or create your own.' : 'No active sessions. Create a session to start watching.';
  $('create').textContent = selected ? 'New session' : 'Create session';
  $('create').className = selected ? 'quiet' : 'primary';
  if (!selected) { $('viewers').textContent = ''; $('close-room').hidden = true; $('library-panel').hidden = true;
    $('title').textContent = 'Watch together'; $('details').textContent = ''; $('empty-title').textContent = 'Join or create a session'; $('empty-hint').textContent = 'Choose an active session or create your own.'; }
  placeSessionBar();
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
$('player-play').addEventListener('click', () => execute({ action: state?.state.paused ? 'media.play' : 'media.pause' }).catch(error => fail(error.message)));
$('player-mute').addEventListener('click', () => execute({ action: state?.state.muted ? 'media.unmute' : 'media.mute' }).catch(error => fail(error.message)));
$('join-playback').addEventListener('click', async () => {
  if (autoplayBlocked) { await unlockLocal(); void reportReadiness(); if (state && !state.state.paused) void synchronize(); }
  else execute({ action: 'media.play' }).catch(error => fail(error.message));
});
$('quality').addEventListener('change', () => {
  preferredQuality = $('quality').value;
  if (state?.mediaId && state.mediaId !== 'demo') execute({ action: 'media.quality.set', args: { quality: preferredQuality } }).catch(error => fail(error.message));
});
$('timeline').addEventListener('pointerdown', () => { seekDragging = true; });
$('timeline').addEventListener('input', () => { $('time').textContent = clock($('timeline').value); });
$('timeline').addEventListener('change', () => { const seconds = Number($('timeline').value); seekDragging = false; execute({ action:'media.seek.absolute',args:{seconds} }).catch(error => fail(error.message)); });
$('timeline').addEventListener('pointercancel', () => { seekDragging = false; });
video.addEventListener('loadedmetadata', () => { void synchronize(); });
video.addEventListener('canplay', () => { void synchronize(); });
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
  if (document.body.classList.contains('activity-pip') || $('playback-dialog').open) return;
  if (event.code === 'Escape' && !$('remote').hidden) { toggleRemote(false); $('open-remote').focus(); return; }
  if (event.code === 'Escape' && !drawer.hidden) { toggleDrawer(false); $('drawer-open').focus(); return; }
  if (event.code === 'F8' || event.code === 'KeyC' && event.altKey && event.shiftKey) { event.preventDefault(); if (!event.repeat) toggleRemote(); return; }
  if (!state || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.target.closest('button,input,select,textarea,[contenteditable=true]')) return;
  const command = event.code === 'Space' ? {action:state.state.paused?'media.play':'media.pause'} : ['ArrowLeft','ArrowRight'].includes(event.code) ?
    {action:'media.seek.relative',args:{seconds:event.code==='ArrowLeft'?-15:15}} : event.code==='KeyM' ? {action:state.state.muted?'media.unmute':'media.mute'} : undefined;
  if (command) { event.preventDefault(); execute(command).catch(error => fail(error.message)); }
});
$('open-remote').addEventListener('click', () => toggleRemote());
document.addEventListener('pointerdown', event => { if (!$('remote').hidden && !event.composedPath().some(node => ['remote','open-remote'].includes(node.id))) toggleRemote(false); });
$('fullscreen').addEventListener('click', () => { (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error => fail(error.message)); });
document.addEventListener('fullscreenchange', () => { toggleDrawer(!drawer.hidden); toggleRemote(!$('remote').hidden); glyph('fullscreen', document.fullscreenElement ? 'fullscreenExit' : 'fullscreen'); $('fullscreen').title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen'; $('fullscreen').setAttribute('aria-label', $('fullscreen').title); });
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
    selected = undefined; browseSession = undefined; unavailable(''); await refreshRooms();
  } catch (error) { fail(error.message); } finally { pending = false; }
});
$('admin-end-room').addEventListener('click', async () => {
  if (!state?.adminMode || pending) return;
  const id = selected; pending = true;
  try {await api('/api/watch/rooms/' + id + '/close',{});selected=undefined;browseSession=undefined;unavailable('');await refreshRooms();}
  catch(error){fail(error.message);} finally {pending=false;}
});
$('refresh').addEventListener('click', () => refreshRooms().catch(error => fail(error.message)));
window.addEventListener('pagehide', () => { stopBrowserHandoff(true); if (selected) void api('/api/watch/rooms/' + selected + '/leave', { viewerId }, { keepalive:true }).catch(() => {}); });
setInterval(() => {
  const timeline = $('timeline'), duration = state?.state.duration || 0;
  const value = seekDragging ? Number(timeline.value) : state ? expected() : 0;
  if (!seekDragging) { timeline.value = value; $('time').textContent = clock(value); }
  timeline.style.setProperty('--timeline-fill',uburoomPlayback.timeline(video.buffered,duration,value));
  const loaded = Math.floor(uburoomPlayback.bufferedAhead(video.buffered,video.currentTime));
  timeline.setAttribute('aria-valuetext',clock(value) + ' of ' + clock(duration) + ', ' + loaded + ' seconds buffered ahead');
  timeline.title = loaded + ' seconds buffered ahead';
}, 250);
setInterval(() => { if (state) void synchronize(); }, 500);
async function start() {
  config = await api('/api/watch/config');
  if (config.watchVersion !== 13) throw new Error('Restart the uburoom server to load the native playback tracking update.');
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
  $('create').hidden = false; $('library-panel').hidden = true; renderTransport();
  await refreshRooms();
  if(params.get('account')==='1'&&!activity){history.replaceState(history.state,'','/watch');if(typeof showAccount==='function')await showAccount();}
  const requestedRoom = params.get('room');
  if (!activity && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(requestedRoom || '')) {
    history.replaceState(history.state,'','/watch');
    await selectRoom(requestedRoom);
  }
  let roomPoll = 0;
  setInterval(async () => {
    if (polling) return; polling = true;
    try { if (!pending) { await renewIdentity(); if (!selected || ++roomPoll % 5 === 0) {me = await api('/api/watch/me');renderAccount();await refreshRooms();} await refreshState(); } }
    catch (error) { unavailable('Disconnected. ' + error.message); } finally { polling = false; }
  }, 1000);
}
start().catch(error => fail(error.message));
