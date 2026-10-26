// @ts-check
/**
 * @typedef {Object} SyncRoom
 * @property {string} [mediaUrl]
 * @property {string} [mediaVersion]
 * @property {string} [streamVersion]
 * @property {number} [epoch]
 * @property {number} [revision]
 * @property {number} [startAt]
 * @property {number} [pauseAt]
 * @property {number} [serverNow]
 * @property {string} [format]
 * @property {boolean} [durable]
 * @property {boolean} [waitingForReady]
 * @property {string} [readinessVersion]
 * @property {object} [readiness]
 * @property {{duration:number,paused:boolean,volume:number,muted:boolean}} state
 */
/**
 * @typedef {Object} SyncSnapshot
 * @property {SyncRoom} [state]
 * @property {string} [selected]
 * @property {string} [mediaSource]
 * @property {number} receivedAt
 * @property {boolean} probing
 * @property {string} playbackError
 * @property {boolean} playerWaiting
 * @property {string} [hlsNetworkFailure]
 * @property {boolean} autoplayBlocked
 * @property {string} [readyVersion]
 * @property {string} syncCorrectionMode
 */
/**
 * Local synchronization lifecycle; source anchoring stays fenced by the current HLS client.
 * read() must return current viewer state, including after asynchronous playback completes.
 * @param {{video:HTMLVideoElement, read:()=>SyncSnapshot,
 * timing:typeof import('./playback-timing.js'), playback:typeof import('./playback-policy.js'),
 * clock:ReturnType<typeof import('./playback-timing.js').clock>, presentation:ReturnType<typeof import('./playback-timing.js').presentation>,
 * expected:()=>number, decodedFrames:()=>number, unlockLocal:()=>Promise<unknown>, reportReadiness:()=>Promise<unknown>,
 * render:()=>void, checkFrames:()=>void, sample:(event:string,fields?:object)=>void,
 * error:(message:string)=>void, playing:(version:string|undefined,blocked:boolean)=>void,
 * correction?:(event:{magnitudeMs:number,kind:'seek'|'jump'})=>void, correctionEligible?:()=>boolean,
 * visibility:()=>string, online:()=>boolean, repeat:(callback:()=>void,delay:number)=>number, cancelRepeat:(timer:number)=>void,
 * now?:()=>number, driftCorrection?:ReturnType<typeof import('./playback-timing.js').correction>,
 * jumpDriftCorrection?:ReturnType<typeof import('./playback-timing.js').jumpCorrection>,
 * startAlarm?:ReturnType<typeof import('./playback-timing.js').alarm>, pauseAlarm?:ReturnType<typeof import('./playback-timing.js').alarm>}} host
 */
export function createSync(host) {
  const {video,timing,playback:uburoomPlayback,clock:playbackClock,presentation:presentationTiming,
    expected,decodedFrames,unlockLocal,reportReadiness,render:renderTransport,checkFrames:checkVideoFrames,sample:diagnosticSample}=host;
  const now=host.now || (()=>globalThis.performance.now());
  const driftCorrection=host.driftCorrection || timing.correction();
  const jumpDriftCorrection=host.jumpDriftCorrection || timing.jumpCorrection();
  const startAlarm=host.startAlarm || timing.alarm({now:()=>playbackClock.read().serverTime});
  const pauseAlarm=host.pauseAlarm || timing.alarm({now:()=>playbackClock.read().serverTime});
  let preparedStartKey, syncSeekPending=false, hlsPreparationUntil=0, hlsTimelinePending=false;
  let correctionSuppressionUntil=0;
  function resetDriftCorrection(full=false) {
    if(full)jumpDriftCorrection.reset();
    driftCorrection.reset();jumpDriftCorrection.interrupt();
    if(video.playbackRate!==1)video.playbackRate=1;
  }
  function startKey(value=host.read().state) {
    const {selected}=host.read();
    return value && [selected,value.mediaVersion,value.streamVersion,value.epoch,value.revision,value.startAt,value.pauseAt].join(':');
  }
  function holdForStart(timing,target) {
    const {state}=host.read();
    if(state.state.paused)return false;
    if(timing.valid && timing.serverTime>=state.startAt){startAlarm.cancel();return false;}
    video.pause();if(video.playbackRate!==1)video.playbackRate=1;
    video.volume=state.state.volume/100;video.muted=state.state.muted;
    const key=startKey();
    if(preparedStartKey!==key && !video.seeking && video.readyState>=2) {
      // Readiness briefly decoded a local probe. Rewind/align once while paused,
      // before the shared deadline, rather than correcting its residue in motion.
      try{if(Math.abs(video.currentTime-target)>.01){diagnosticSample('start-prepare');video.currentTime=target;}preparedStartKey=key;}catch{}
    }
    if(timing.valid)startAlarm.arm(key,state.startAt,()=>{
      const {state,mediaSource,receivedAt}=host.read();
      if(startKey()!==key || !state?.mediaUrl || mediaSource!==state.mediaUrl || host.online()===false || now()-receivedAt>3000)return;
      diagnosticSample('start-timer',{delayMs:playbackClock.read().serverTime-state.startAt});void synchronize();
    });
    else startAlarm.cancel();
    renderTransport();return true;
  }
  async function synchronize() {
    const {state,selected,mediaSource,probing,playbackError,playerWaiting,hlsNetworkFailure,autoplayBlocked,readyVersion,
      syncCorrectionMode}=host.read();
    if (!state?.mediaUrl || video.readyState < 1 || probing || playbackError) return;
    if(hlsTimelinePending){
      video.pause();resetDriftCorrection();
      if(hlsNetworkFailure){host.error(hlsNetworkFailure);}
      renderTransport();return;
    }
    const target = expected(), difference = target - video.currentTime, timing=playbackClock.read(),clockValid=timing.valid;
    // Keep the final decoded frame while the server verifies ending evidence.
    // Calling play() on an ended element can restart this occurrence at zero.
    if (state.durable && video.ended && video.currentTime >= state.state.duration - .5 && target >= state.state.duration - .5) {
      resetDriftCorrection(); renderTransport(); return;
    }
    const paused = state.state.paused || clockValid && Number.isFinite(state.pauseAt) && timing.serverTime >= state.pauseAt;
    if (clockValid && state.pauseAt > timing.serverTime) {
      const key = startKey();
      pauseAlarm.arm(key, state.pauseAt, () => { if (startKey() === key) void synchronize(); });
    } else pauseAlarm.cancel();
    if(state.startAt>state.serverNow && holdForStart(timing,target))return;
    if (hlsNetworkFailure && !state.state.paused && uburoomPlayback.bufferedAhead(video.buffered,target) < .5) {
      video.pause(); host.error(hlsNetworkFailure); return;
    }
    if(hlsPreparationUntil&&!state.state.paused) {
      // A replacement has discarded this viewer's old buffer. Fill ahead of the
      // moving room target before starting locally; healthy viewers keep playing.
      const required=Math.min(2,Math.max(0,state.state.duration-target));
      if(now()<hlsPreparationUntil&&uburoomPlayback.bufferedAhead(video.buffered,target)<required) {
        video.pause();resetDriftCorrection();renderTransport();return;
      }
      hlsPreparationUntil=0;
    }
    if (state.waitingForReady) video.pause();
    const bufferedTarget = (uburoomPlayback.localFormat ? uburoomPlayback.localFormat(state.format) : state.format === 'av1') && [...Array(video.buffered.length)].some((_, i) =>
      target >= video.buffered.start(i) - .05 && target < video.buffered.end(i));
    // A shared seek/restart can supersede a native seek still waiting for old
    // chunks. Retarget it once the new source-time window is buffered.
    const targetBuffered=uburoomPlayback.bufferedAhead(video.buffered,target)>=Math.min(.5,Math.max(0,state.state.duration-target));
    if(!video.seeking&&!playerWaiting&&video.readyState>=3&&Math.abs(difference)<=.65)syncSeekPending=false;
    // Let an in-flight alignment refill before chasing a moving playing target.
    // Repeated out-of-buffer seeks abort the very HLS fragments needed to recover.
    const canAlign=!syncSeekPending||state.state.paused||!playerWaiting&&video.readyState>=3&&targetBuffered;
    const jumpContext=syncCorrectionMode==='jumps'?[selected,state.mediaVersion,state.streamVersion,state.epoch,state.readinessVersion].join(':'):undefined;
    const align = (event='sync-seek') => {
      const destination=Math.max(0,Math.min(target,(Number.isFinite(video.duration)?video.duration:state.state.duration)-.05));
      const automaticCorrection=(event==='sync-seek'||event==='sync-jump')&&now()>=correctionSuppressionUntil&&clockValid&&!paused&&
        !state.waitingForReady&&readyVersion===state.mediaVersion&&!playerWaiting&&!video.paused&&!video.seeking&&video.readyState>=3&&decodedFrames()>0&&
        host.correctionEligible?.()!==false;
      try {
        const seekDeltaMs=(destination-video.currentTime)*1000;
        const frames=syncCorrectionMode==='jumps'?decodedFrames():undefined;
        video.currentTime=destination;syncSeekPending=true;
        if(syncCorrectionMode==='jumps')jumpDriftCorrection.committed({frames,target:destination,context:jumpContext});
        diagnosticSample(event,{seekDeltaMs});
        if(automaticCorrection)host.correction?.({magnitudeMs:Math.abs(seekDeltaMs),kind:event==='sync-jump'?'jump':'seek'});
      } catch { return false; }
      return true;
    };
    if ((clockValid || state.state.paused) && canAlign && (!video.seeking || bufferedTarget) && Math.abs(difference) > (state.waitingForReady && state.readinessVersion ? .05 : .65)) {
      align();
    }
    const correctionInput={now:now(),error:difference,context:startKey(),
      eligible:clockValid&&host.visibility()==='visible'&&!paused&&!video.paused&&!video.seeking&&!playerWaiting&&video.readyState>=3&&
        uburoomPlayback.bufferedAhead(video.buffered,video.currentTime)>=1,
      uncertaintyMs:timing.clockUncertaintyMs,frameSeconds:presentationTiming.cadence()};
    if(syncCorrectionMode==='jumps' && jumpDriftCorrection.update({...correctionInput,
      context:jumpContext,
      eligible:correctionInput.eligible&&!state.waitingForReady,
      buffered:targetBuffered,settled:!video.paused&&!video.seeking&&!playerWaiting&&video.readyState>=3,
      frames:decodedFrames(),position:video.currentTime}) && canAlign && !syncSeekPending && !video.seeking)align('sync-jump');
    const rate = syncCorrectionMode === 'jumps' ? 1 : (!correctionInput.eligible || Math.abs(difference) < .15 || Math.abs(difference) > .65 ? 1 : difference > 0 ? 1.04 : .96);
    if(video.playbackRate!==rate)video.playbackRate=rate;
    video.volume = state.state.volume / 100; video.muted = state.state.muted;
    if (paused) {
      video.pause();
      if ((state.waitingForReady || state.readiness) && readyVersion !== state.mediaVersion && !autoplayBlocked && video.readyState >= 2) { await unlockLocal(); void reportReadiness(); }
    } else if (video.paused && !autoplayBlocked) {
      const room=selected,version=state.mediaVersion,stream=state.streamVersion,source=mediaSource;
      const current=()=>{const value=host.read();return value.selected===room && value.state?.mediaVersion===version && value.state?.streamVersion===stream && value.mediaSource===source;};
      try { await video.play(); if(current()){host.playing(version,false);} }
      catch (error) { if (current() && error.name === 'NotAllowedError') host.playing(undefined,true); }
    }
    renderTransport();
    checkVideoFrames();
  }

  function reset() {
    resetDriftCorrection(true);startAlarm.cancel();pauseAlarm.cancel();
    preparedStartKey=undefined;syncSeekPending=false;hlsPreparationUntil=0;hlsTimelinePending=false;
  }
  function event(name) {
    if(name==='playing'&&!hlsTimelinePending)syncSeekPending=false;
    if(name==='seeking'||name==='emptied')presentationTiming.reset();
    if(['pause','waiting','seeking','emptied'].includes(name)||name==='visibilitychange'&&host.visibility()!=='visible')resetDriftCorrection();
    if(name==='offline'||name==='pagehide'){playbackClock.reset();startAlarm.cancel();pauseAlarm.cancel();resetDriftCorrection();}
  }
  function prepare({until=hlsPreparationUntil,timeline=hlsTimelinePending}={}) {hlsPreparationUntil=until;hlsTimelinePending=timeline;}
  function anchor(target) {
    hlsTimelinePending=false;hlsPreparationUntil=now()+10000;
    if(target>.65){try{diagnosticSample('hls-anchor');video.currentTime=target;syncSeekPending=true;}catch{}}
  }
  function sharedSeek() {syncSeekPending=false;correctionSuppressionUntil=Math.max(correctionSuppressionUntil,now()+5000);if(hlsPreparationUntil)hlsPreparationUntil=now()+10000;}
  function suppressCorrectionTelemetry(durationMs=5000) {correctionSuppressionUntil=Math.max(correctionSuppressionUntil,now()+Math.max(0,durationMs));}
  function transition(next) {if(startKey()!==startKey(next)){startAlarm.cancel();pauseAlarm.cancel();}}
  const interval=host.repeat(()=>{if(host.read().state)void synchronize();},500);
  function close() {host.cancelRepeat(interval);reset();}
  return {synchronize,reset,resetCorrection:resetDriftCorrection,event,prepare,anchor,sharedSeek,suppressCorrectionTelemetry,transition,close,
    get seekPending(){return syncSeekPending;},get preparationUntil(){return hlsPreparationUntil;},get timelinePending(){return hlsTimelinePending;}};
}
