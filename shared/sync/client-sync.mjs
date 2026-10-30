// @ts-check
/* Client-side playback synchronization controller over an abstract PlayerAdapter.
 * Operates on timeline coordinates and readiness states without requiring Plex or a media URL.
 */
import * as defaultTiming from './timing.mjs';
import { normalizePlayerAdapter } from './player-adapter.mjs';

/**
 * @typedef {Object} SyncRoom
 * @property {string} [mediaUrl]
 * @property {string} [mediaVersion]
 * @property {string} [streamVersion]
 * @property {number|string} [epoch]
 * @property {number} [revision]
 * @property {number} [startAt]
 * @property {number} [pauseAt]
 * @property {number} [serverNow]
 * @property {string} [format]
 * @property {boolean} [durable]
 * @property {boolean} [waitingForReady]
 * @property {string} [readinessVersion]
 * @property {object} [readiness]
 * @property {{duration:number,paused:boolean,volume?:number,muted?:boolean}} state
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
 * @property {number} [lastPresentationSampleAt]
 * @property {number} [lastPresentationErrorMs]
 */

/**
 * Local synchronization lifecycle; source anchoring stays fenced by the host delivery adapter.
 * `read()` must return current viewer state, including after asynchronous playback completes.
 * @param {{
 *   player?:import('./player-adapter.mjs').PlayerAdapter,
 *   video?:any,
 *   read:()=>SyncSnapshot,
 *   mediaReady?:(snapshot:SyncSnapshot)=>boolean,
 *   timing?:Partial<typeof import('./timing.mjs')>,
 *   playback?:{bufferedAhead?:(buffered:any, position:number)=>number, localFormat?:(format:string|undefined)=>boolean},
 *   clock:ReturnType<typeof import('./timing.mjs').clock>,
 *   presentation:ReturnType<typeof import('./timing.mjs').presentation>,
 *   expected:()=>number,
 *   decodedFrames:()=>number,
 *   unlockLocal:()=>Promise<unknown>,
 *   reportReadiness:()=>Promise<unknown>,
 *   render:()=>void,
 *   checkFrames:()=>void,
 *   sample:(event:string,fields?:object)=>void,
 *   error:(message:string)=>void,
 *   playing:(version:string|undefined,blocked:boolean)=>void,
 *   correction?:(event:{magnitudeMs:number,kind:'seek'|'jump'})=>void,
 *   correctionEligible?:()=>boolean,
 *   visibility:()=>string,
 *   online:()=>boolean,
 *   repeat:(callback:()=>void,delay:number)=>any,
 *   cancelRepeat:(timer:any)=>void,
 *   now?:()=>number,
 *   driftCorrection?:ReturnType<typeof import('./timing.mjs').correction>,
 *   jumpDriftCorrection?:ReturnType<typeof import('./timing.mjs').jumpCorrection>,
 *   startAlarm?:ReturnType<typeof import('./timing.mjs').alarm>,
 *   pauseAlarm?:ReturnType<typeof import('./timing.mjs').alarm>
 * }} host
 */
export function createSync(host) {
  const timingApi = host.timing || defaultTiming;
  const playbackApi = host.playback;
  const player = normalizePlayerAdapter(host);
  const {
    clock: playbackClock,
    presentation: presentationTiming,
    expected,
    decodedFrames,
    unlockLocal,
    reportReadiness,
    render: renderTransport,
    checkFrames: checkVideoFrames,
    sample: diagnosticSample
  } = host;
  const now = host.now || (() => globalThis.performance.now());
  const makeCorrection = () => (timingApi.correction || defaultTiming.correction)();
  const makeJumpCorrection = () => (timingApi.jumpCorrection || defaultTiming.jumpCorrection)();
  const makeAlarm = opts => (timingApi.alarm || defaultTiming.alarm)(opts);
  let driftCorrection = host.driftCorrection || makeCorrection();
  const jumpDriftCorrection = host.jumpDriftCorrection || makeJumpCorrection();
  const startAlarm = host.startAlarm || makeAlarm({ now: () => playbackClock.read().serverTime });
  const pauseAlarm = host.pauseAlarm || makeAlarm({ now: () => playbackClock.read().serverTime });
  let preparedStartKey, syncSeekPending = false, hlsPreparationUntil = 0, hlsTimelinePending = false;
  let correctionSuppressionUntil = 0, lastControl;

  const hasLoadedMedia = snapshot => host.mediaReady ? Boolean(host.mediaReady(snapshot)) : Boolean(snapshot.state?.mediaUrl);
  const hasCurrentSource = snapshot => host.mediaReady
    ? Boolean(host.mediaReady(snapshot))
    : Boolean(snapshot.state?.mediaUrl && snapshot.mediaSource === snapshot.state.mediaUrl);
  const isLocalFormat = format => playbackApi?.localFormat
    ? playbackApi.localFormat(format)
    : ['av1', 'vp9', 'vp8'].includes(format || '');

  function resetDriftCorrection(full = false) {
    if (full) jumpDriftCorrection.reset();
    driftCorrection.reset();
    jumpDriftCorrection.interrupt();
    player.setPlaybackRate(1);
  }

  function startKey(value = host.read().state) {
    const { selected } = host.read();
    return value && [selected, value.mediaVersion, value.streamVersion, value.epoch, value.revision, value.startAt, value.pauseAt].join(':');
  }

  function applyAudio(roomState) {
    const volumeUnit = Number.isFinite(roomState.volume) ? roomState.volume / 100 : undefined;
    const muted = typeof roomState.muted === 'boolean' ? roomState.muted : undefined;
    player.setAudio(volumeUnit, muted);
  }

  function holdForStart(timing, target) {
    const { state } = host.read();
    if (state.state.paused) return false;
    if (timing.valid && timing.serverTime >= state.startAt) { startAlarm.cancel(); return false; }
    player.pause();
    player.setPlaybackRate(1);
    applyAudio(state.state);
    const key = startKey();
    if (preparedStartKey !== key && !player.seeking() && player.readyState() >= 2) {
      // Readiness briefly decoded a local probe. Rewind/align once while paused,
      // before the shared deadline, rather than correcting its residue in motion.
      try {
        if (Math.abs(player.currentTime() - target) > .01) {
          diagnosticSample('start-prepare');
          player.seek(target);
        }
        preparedStartKey = key;
      } catch {}
    }
    if (timing.valid) {
      startAlarm.arm(key, state.startAt, () => {
        const snapshot = host.read();
        const { state: latestState, receivedAt } = snapshot;
        if (startKey() !== key || !hasCurrentSource(snapshot) || host.online() === false || now() - receivedAt > 3000) return;
        diagnosticSample('start-timer', { delayMs: playbackClock.read().serverTime - latestState.startAt });
        void synchronize();
      });
    } else startAlarm.cancel();
    renderTransport();
    return true;
  }

  async function synchronize() {
    const snapshot = host.read();
    const {
      state,
      selected,
      mediaSource,
      probing,
      playbackError,
      playerWaiting,
      hlsNetworkFailure,
      autoplayBlocked,
      readyVersion,
      syncCorrectionMode
    } = snapshot;
    if (!state || !hasLoadedMedia(snapshot) || player.readyState() < 1 || probing || playbackError) return;
    if (hlsTimelinePending) {
      player.pause();
      resetDriftCorrection();
      if (hlsNetworkFailure) host.error(hlsNetworkFailure);
      renderTransport();
      return;
    }
    const currentTime = player.currentTime();
    const target = expected(), difference = target - currentTime, timing = playbackClock.read(), clockValid = timing.valid;
    // Keep the final decoded frame while the server verifies ending evidence.
    // Calling play() on an ended element can restart this occurrence at zero.
    if (state.durable && player.ended() && currentTime >= state.state.duration - .5 && target >= state.state.duration - .5) {
      resetDriftCorrection(); renderTransport(); return;
    }
    const paused = state.state.paused || clockValid && Number.isFinite(state.pauseAt) && timing.serverTime >= state.pauseAt;
    if (clockValid && state.pauseAt > timing.serverTime) {
      const key = startKey();
      pauseAlarm.arm(key, state.pauseAt, () => { if (startKey() === key) void synchronize(); });
    } else pauseAlarm.cancel();
    if (state.startAt > state.serverNow && holdForStart(timing, target)) return;
    if (hlsNetworkFailure && !state.state.paused && player.bufferedAhead(target) < .5) {
      player.pause(); host.error(hlsNetworkFailure); return;
    }
    if (hlsPreparationUntil && !state.state.paused) {
      // A replacement has discarded this viewer's old buffer. Fill ahead of the
      // moving room target before starting locally; healthy viewers keep playing.
      const required = Math.min(2, Math.max(0, state.state.duration - target));
      if (now() < hlsPreparationUntil && player.bufferedAhead(target) < required) {
        player.pause(); resetDriftCorrection(); renderTransport(); return;
      }
      hlsPreparationUntil = 0;
    }
    if (state.waitingForReady) player.pause();
    const bufferedTarget = isLocalFormat(state.format) && player.isBufferedAt(target, .05);
    // A shared seek/restart can supersede a native seek still waiting for old
    // chunks. Retarget it once the new source-time window is buffered.
    const targetBuffered = player.bufferedAhead(target) >= Math.min(.5, Math.max(0, state.state.duration - target));
    if (!player.seeking() && !playerWaiting && player.readyState() >= 3 && Math.abs(difference) <= .65) syncSeekPending = false;
    // Let an in-flight alignment refill before chasing a moving playing target.
    // Repeated out-of-buffer seeks abort the very HLS fragments needed to recover.
    const canAlign = !syncSeekPending || state.state.paused || !playerWaiting && player.readyState() >= 3 && targetBuffered;
    const jumpContext = syncCorrectionMode === 'jumps' ? [selected, state.mediaVersion, state.streamVersion, state.epoch, state.readinessVersion].join(':') : undefined;
    const align = (eventName = 'sync-seek') => {
      presentationTiming.interrupt?.('seek');
      const playerDuration = player.duration();
      const destination = Math.max(0, Math.min(target, (Number.isFinite(playerDuration) ? playerDuration : state.state.duration) - .05));
      const automaticCorrection = (eventName === 'sync-seek' || eventName === 'sync-jump') && now() >= correctionSuppressionUntil && clockValid && !paused &&
        !state.waitingForReady && readyVersion === state.mediaVersion && !playerWaiting && !player.paused() && !player.seeking() && player.readyState() >= 3 && decodedFrames() > 0 &&
        host.correctionEligible?.() !== false;
      try {
        const seekDeltaMs = (destination - player.currentTime()) * 1000;
        const frames = syncCorrectionMode === 'jumps' ? decodedFrames() : undefined;
        player.seek(destination); syncSeekPending = true;
        if (syncCorrectionMode === 'jumps') jumpDriftCorrection.committed({ now: now(), frames, target: destination, context: jumpContext });
        diagnosticSample(eventName, { seekDeltaMs });
        if (automaticCorrection) host.correction?.({ magnitudeMs: Math.abs(seekDeltaMs), kind: eventName === 'sync-jump' ? 'jump' : 'seek' });
      } catch { return false; }
      return true;
    };
    if ((clockValid || state.state.paused) && canAlign && (!player.seeking() || bufferedTarget) && Math.abs(difference) > (state.waitingForReady && state.readinessVersion ? .05 : .65)) {
      align();
    }
    const postAlignTime = player.currentTime();
    const eligible = clockValid && host.visibility() === 'visible' && !paused && !player.paused() && !player.seeking() && !playerWaiting && player.readyState() >= 3 &&
      player.bufferedAhead(postAlignTime) >= 1;
    const presentationSample = presentationTiming.read ? presentationTiming.read(now(), { context: startKey(), clockRevision: timing.clockRevision }) : undefined;
    const evaluateSignal = timingApi.controlSignal;
    const signal = evaluateSignal ? evaluateSignal({
      target, currentTime: postAlignTime, presentation: presentationSample, clockValid, visible: host.visibility() === 'visible', eligible
    }) : { error: difference, source: 'position', divergenceMs: undefined, reason: 'none' };
    lastControl = { ...signal, presentationAgeMs: presentationSample?.ageMs };
    const correctionInput = {
      now: now(),
      error: signal.error,
      context: startKey(),
      eligible,
      uncertaintyMs: timing.clockUncertaintyMs,
      stabilityMs: timing.clockStabilityMs ?? timing.clockUncertaintyMs,
      frameSeconds: presentationTiming.cadence ? presentationTiming.cadence() : 0
    };
    if (syncCorrectionMode === 'jumps' && jumpDriftCorrection.update({
      ...correctionInput,
      error: difference,
      context: jumpContext,
      eligible: correctionInput.eligible && !state.waitingForReady,
      buffered: targetBuffered,
      settled: !player.paused() && !player.seeking() && !playerWaiting && player.readyState() >= 3,
      frames: decodedFrames(),
      position: player.currentTime()
    }) && canAlign && !syncSeekPending && !player.seeking()) {
      align('sync-jump');
    }
    const rate = syncCorrectionMode === 'jumps' && !jumpDriftCorrection.suspended?.() ? 1 : driftCorrection.update(correctionInput);
    player.setPlaybackRate(rate);
    applyAudio(state.state);
    if (paused) {
      player.pause();
      if ((state.waitingForReady || state.readiness) && readyVersion !== state.mediaVersion && !autoplayBlocked && player.readyState() >= 2) {
        await unlockLocal(); void reportReadiness();
      } else if ((state.waitingForReady || state.readiness) && readyVersion === state.mediaVersion && !autoplayBlocked && player.readyState() >= 3 && !player.seeking()) {
        void reportReadiness();
      }
    } else if (player.paused() && !autoplayBlocked) {
      const room = selected, version = state.mediaVersion, stream = state.streamVersion, source = mediaSource;
      const current = () => {
        const value = host.read();
        const sourceMatches = host.mediaReady ? Boolean(host.mediaReady(value)) : value.mediaSource === source;
        return value.selected === room && value.state?.mediaVersion === version && value.state?.streamVersion === stream && sourceMatches;
      };
      try {
        await player.play();
        if (current()) host.playing(version, false);
      } catch (error) {
        if (current() && error?.name === 'NotAllowedError') host.playing(undefined, true);
      }
    }
    renderTransport();
    checkVideoFrames();
  }

  function reset() {
    resetDriftCorrection(true);
    startAlarm.cancel();
    pauseAlarm.cancel();
    preparedStartKey = undefined;
    syncSeekPending = false;
    hlsPreparationUntil = 0;
    hlsTimelinePending = false;
    lastControl = undefined;
    presentationTiming.reset?.();
  }

  function event(name) {
    if (name === 'playing' && !hlsTimelinePending) syncSeekPending = false;
    if (name === 'seeking' || name === 'emptied') presentationTiming.reset?.();
    else if (['pause', 'waiting', 'visibilitychange'].includes(name)) presentationTiming.interrupt?.(name);
    if (['pause', 'waiting', 'seeking', 'emptied'].includes(name) || name === 'visibilitychange' && host.visibility() !== 'visible') {
      resetDriftCorrection();
    }
    if (name === 'offline' || name === 'pagehide') {
      playbackClock.reset();
      presentationTiming.interrupt?.(name);
      startAlarm.cancel();
      pauseAlarm.cancel();
      resetDriftCorrection();
    }
  }

  function prepare({ until = hlsPreparationUntil, timeline = hlsTimelinePending } = {}) {
    hlsPreparationUntil = until;
    hlsTimelinePending = timeline;
  }

  function anchor(target) {
    hlsTimelinePending = false;
    hlsPreparationUntil = now() + 10000;
    if (target > .65) {
      try { diagnosticSample('hls-anchor'); player.seek(target); syncSeekPending = true; } catch {}
    }
  }

  function sharedSeek() {
    syncSeekPending = false;
    jumpDriftCorrection.reset();
    presentationTiming.interrupt?.('seek');
    correctionSuppressionUntil = Math.max(correctionSuppressionUntil, now() + 5000);
    if (hlsPreparationUntil) hlsPreparationUntil = now() + 10000;
  }

  function suppressCorrectionTelemetry(durationMs = 5000) {
    correctionSuppressionUntil = Math.max(correctionSuppressionUntil, now() + Math.max(0, durationMs));
  }

  function transition(next) {
    if (startKey() !== startKey(next)) { startAlarm.cancel(); pauseAlarm.cancel(); }
  }

  const interval = host.repeat(() => { if (host.read().state) void synchronize(); }, 500);
  function close() { host.cancelRepeat(interval); reset(); }

  return {
    synchronize,
    reset,
    resetCorrection: resetDriftCorrection,
    event,
    prepare,
    anchor,
    sharedSeek,
    suppressCorrectionTelemetry,
    transition,
    close,
    contextKey: () => startKey(),
    get control() { return lastControl; },
    get driftCorrection() { return driftCorrection; },
    set driftCorrection(value) { driftCorrection = value || makeCorrection(); },
    get seekPending() { return syncSeekPending; },
    get preparationUntil() { return hlsPreparationUntil; },
    get timelinePending() { return hlsTimelinePending; }
  };
}
