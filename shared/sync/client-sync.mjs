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
 * @property {{duration:number,paused:boolean,position?:number,volume?:number,muted?:boolean}} state
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
 * @property {string} [streamNetworkFailure]
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
 *   expected:()=>number|undefined,
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
 *   startDelay?:ReturnType<typeof import('./timing.mjs').startDelay>,
 *   streamKind?:(snapshot:SyncSnapshot)=>string,
 *   startAlarm?:ReturnType<typeof import('./timing.mjs').alarm>,
 *   pauseAlarm?:ReturnType<typeof import('./timing.mjs').alarm>
 * }} host
 */
export function createSync(host) {
  const timingApi = host.timing || defaultTiming;
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
    sample: diagnosticSample,
  } = host;
  const now = host.now || (() => globalThis.performance.now());
  const makeCorrection = () => (timingApi.correction || defaultTiming.correction)();
  const makeJumpCorrection = opts => (timingApi.jumpCorrection || defaultTiming.jumpCorrection)(opts);
  const makeAlarm = opts => (timingApi.alarm || defaultTiming.alarm)(opts);
  let driftCorrection = host.driftCorrection || makeCorrection();
  const jumpDriftCorrection = host.jumpDriftCorrection || makeJumpCorrection();
  const embedJumpDriftCorrection =
    host.jumpDriftCorrection ||
    makeJumpCorrection({ minErrorSeconds: 0.35, maxErrorSeconds: 0.9, settleToleranceSeconds: 0.35 });
  const startAlarm = host.startAlarm || makeAlarm({ now: () => playbackClock.read().serverTime });
  const pauseAlarm = host.pauseAlarm || makeAlarm({ now: () => playbackClock.read().serverTime });
  // Per-page start-delay estimates by stream kind (see timing.mjs startDelay); never persisted.
  const startDelay = host.startDelay || (timingApi.startDelay || defaultTiming.startDelay)();
  const streamKind = snapshot => String(host.streamKind?.(snapshot) ?? 'default');
  let scheduledStartKey;
  let preparedStartKey,
    syncSeekPending = false,
    sharedSeekPending = false,
    hlsPreparationUntil = 0,
    hlsTimelinePending = false;
  let correctionSuppressionUntil = 0,
    lastControl;

  const hasLoadedMedia = snapshot =>
    host.mediaReady ? Boolean(host.mediaReady(snapshot)) : Boolean(snapshot.state?.mediaUrl);
  const hasCurrentSource = snapshot =>
    host.mediaReady
      ? Boolean(host.mediaReady(snapshot))
      : Boolean(snapshot.state?.mediaUrl && snapshot.mediaSource === snapshot.state.mediaUrl);
  function resetDriftCorrection(full = false) {
    if (full) {
      jumpDriftCorrection.reset();
      if (embedJumpDriftCorrection !== jumpDriftCorrection) embedJumpDriftCorrection.reset();
    }
    driftCorrection.reset();
    jumpDriftCorrection.interrupt();
    if (embedJumpDriftCorrection !== jumpDriftCorrection) embedJumpDriftCorrection.interrupt();
    player.setPlaybackRate(1);
  }

  function startKey(value = host.read().state) {
    const { selected } = host.read();
    return (
      value &&
      [
        selected,
        value.mediaVersion,
        value.streamVersion,
        value.epoch,
        value.revision,
        value.startAt,
        value.pauseAt,
      ].join(':')
    );
  }

  function applyAudio(roomState) {
    const volumeUnit = Number.isFinite(roomState.volume) ? roomState.volume / 100 : undefined;
    const muted = typeof roomState.muted === 'boolean' ? roomState.muted : undefined;
    player.setAudio(volumeUnit, muted);
  }

  function holdForStart(timing, target) {
    const { state } = host.read();
    if (state.state.paused) return false;
    const compMs = startDelay.compensationMs(streamKind(host.read()));
    const triggerAt = state.startAt - compMs;
    if (timing.valid && timing.serverTime >= triggerAt) {
      // Measure this start only if it was prepared and the alarm was on time; late or unprepared starts say nothing
      // about the player's own delay.
      if (preparedStartKey === startKey() && timing.serverTime - triggerAt <= 150) scheduledStartKey = startKey();
      startAlarm.cancel();
      return false;
    }
    player.pause();
    player.setPlaybackRate(1);
    applyAudio(state.state);
    const key = startKey();
    if (preparedStartKey !== key && !player.seeking() && player.readyState() >= 2) {
      // Readiness briefly decoded a local probe. Align to the room target once while paused
      // (skipping seeks on an already-warm aligned decoder) and fire the alarm compMs early.
      try {
        if (!(player.readyState() >= 3 && Math.abs(player.currentTime() - target) <= 0.02)) {
          diagnosticSample('start-prepare', { compMs });
          player.seek(target);
        }
        preparedStartKey = key;
      } catch {}
    }
    if (timing.valid) {
      startAlarm.arm(key, triggerAt, () => {
        const snapshot = host.read();
        const { state: latestState, receivedAt } = snapshot;
        const latestTrigger = latestState.startAt - startDelay.compensationMs(streamKind(snapshot));
        if (startKey() !== key || !hasCurrentSource(snapshot) || host.online() === false || now() - receivedAt > 3000)
          return;
        diagnosticSample('start-timer', { delayMs: playbackClock.read().serverTime - latestTrigger });
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
      autoplayBlocked,
      readyVersion,
      syncCorrectionMode,
    } = snapshot;
    const streamNetworkFailure = snapshot.streamNetworkFailure ?? snapshot.hlsNetworkFailure;
    if (!state || !hasLoadedMedia(snapshot) || player.readyState() < 1 || probing || playbackError) return;
    if (player.isAdPlaying?.()) return;
    const supportsRate = player.supportsRateSync !== false;
    const effectiveSyncMode = !supportsRate ? 'jumps' : syncCorrectionMode;
    const activeJump = !supportsRate ? embedJumpDriftCorrection : jumpDriftCorrection;
    if (hlsTimelinePending) {
      player.pause();
      resetDriftCorrection();
      if (streamNetworkFailure) host.error(streamNetworkFailure);
      renderTransport();
      return;
    }
    const currentTime = player.currentTime();
    const timing = playbackClock.read(),
      clockValid = timing.valid;
    let target = expected();
    if (!Number.isFinite(target)) {
      // The room clock is unusable and the timeline moves: hold. A start that is still pending stays paused at
      // its position; running playback continues uncorrected until the clock is usable again.
      if (state.startAt > state.serverNow) target = state.state.position;
      else {
        resetDriftCorrection();
        renderTransport();
        return;
      }
    }
    const { duration: effectiveDuration, ceiling: alignCeiling } = (
      timingApi.nearEndBounds || defaultTiming.nearEndBounds
    )(state.state.duration, player.duration());
    const alignTarget = Math.max(0, Math.min(target, alignCeiling));
    // Keep the final decoded frame while the server verifies ending evidence.
    // Calling play() on an ended element can restart this occurrence at zero.
    if (
      state.durable &&
      player.ended() &&
      currentTime >= effectiveDuration - 0.5 &&
      target >= effectiveDuration - 0.5
    ) {
      resetDriftCorrection();
      renderTransport();
      return;
    }
    const paused =
      state.state.paused || (clockValid && Number.isFinite(state.pauseAt) && timing.serverTime >= state.pauseAt);
    if (clockValid && state.pauseAt > timing.serverTime) {
      const key = startKey();
      pauseAlarm.arm(key, state.pauseAt, () => {
        if (startKey() === key) void synchronize();
      });
    } else pauseAlarm.cancel();
    if (state.startAt > state.serverNow && holdForStart(timing, target)) return;
    const inStartLeadWindow =
      clockValid && !state.state.paused && Number.isFinite(state.startAt) && timing.serverTime < state.startAt;
    if (streamNetworkFailure && !state.state.paused && player.bufferedAhead(target) < 0.5) {
      player.pause();
      host.error(streamNetworkFailure);
      return;
    }
    if (hlsPreparationUntil && !state.state.paused) {
      // A replacement has discarded this viewer's old buffer. Fill ahead of the
      // moving room target before starting locally; healthy viewers keep playing.
      const required = Math.min(2, Math.max(0, effectiveDuration - alignTarget));
      if (now() < hlsPreparationUntil && player.bufferedAhead(alignTarget) < required) {
        player.pause();
        resetDriftCorrection();
        renderTransport();
        return;
      }
      hlsPreparationUntil = 0;
    }
    if (state.waitingForReady) player.pause();
    const bufferedTarget = player.bufferedAhead(alignTarget) > 0;
    // A shared seek/restart can supersede a native seek still waiting for old
    // chunks. Retarget it once the new source-time window is buffered.
    const targetBuffered =
      player.bufferedAhead(alignTarget) >= Math.min(0.5, Math.max(0, effectiveDuration - alignTarget));
    const settleBand = supportsRate ? 0.65 : 0.9;
    if (
      !player.seeking() &&
      !playerWaiting &&
      player.readyState() >= 3 &&
      Math.abs(alignTarget - currentTime) <= settleBand
    ) {
      syncSeekPending = false;
      sharedSeekPending = false;
    }
    // Let an in-flight alignment refill before chasing a moving playing target.
    // Repeated out-of-buffer seeks abort the very HLS fragments needed to recover.
    const canAlign =
      !syncSeekPending || state.state.paused || (!playerWaiting && player.readyState() >= 3 && targetBuffered);
    const jumpContext =
      effectiveSyncMode === 'jumps'
        ? [selected, state.mediaVersion, state.streamVersion, state.epoch, state.readinessVersion].join(':')
        : undefined;
    const align = (eventName = 'sync-seek') => {
      presentationTiming.interrupt?.('seek');
      const destination = alignTarget;
      const automaticCorrection =
        (eventName === 'sync-seek' || eventName === 'sync-jump') &&
        !sharedSeekPending &&
        now() >= correctionSuppressionUntil &&
        clockValid &&
        !paused &&
        !state.waitingForReady &&
        readyVersion === state.mediaVersion &&
        !playerWaiting &&
        !player.paused() &&
        !player.seeking() &&
        player.readyState() >= 3 &&
        (player.hasFrameEvidence === false || decodedFrames() > 0) &&
        host.correctionEligible?.() !== false;
      try {
        const seekDeltaMs = (destination - player.currentTime()) * 1000;
        const frames = effectiveSyncMode === 'jumps' ? decodedFrames() : undefined;
        player.seek(destination);
        syncSeekPending = true;
        sharedSeekPending = false;
        if (effectiveSyncMode === 'jumps')
          activeJump.committed({ now: now(), frames, target: destination, context: jumpContext });
        diagnosticSample(eventName, { seekDeltaMs });
        if (automaticCorrection)
          host.correction?.({ magnitudeMs: Math.abs(seekDeltaMs), kind: eventName === 'sync-jump' ? 'jump' : 'seek' });
      } catch {
        return false;
      }
      return true;
    };
    const seekThreshold =
      state.waitingForReady && state.readinessVersion ? (supportsRate ? 0.05 : 0.25) : supportsRate ? 0.65 : 0.9;
    if (
      !inStartLeadWindow &&
      (clockValid || state.state.paused) &&
      canAlign &&
      (!player.seeking() || bufferedTarget || sharedSeekPending) &&
      Math.abs(alignTarget - currentTime) > seekThreshold
    ) {
      align();
    }
    const postAlignTime = player.currentTime();
    const difference = alignTarget - postAlignTime;
    const eligible =
      !inStartLeadWindow &&
      clockValid &&
      host.visibility() === 'visible' &&
      !paused &&
      !player.paused() &&
      !player.seeking() &&
      !playerWaiting &&
      player.readyState() >= 3 &&
      player.bufferedAhead(postAlignTime) >= 1;
    const presentationSample = presentationTiming.read
      ? presentationTiming.read(now(), { context: startKey(), clockRevision: timing.clockRevision })
      : undefined;
    const evaluateSignal = timingApi.controlSignal;
    const signal = evaluateSignal
      ? evaluateSignal({
          target: alignTarget,
          currentTime: postAlignTime,
          presentation: presentationSample,
          clockValid,
          visible: host.visibility() === 'visible',
          eligible,
        })
      : { error: difference, source: 'position', divergenceMs: undefined, reason: 'none' };
    lastControl = { ...signal, presentationAgeMs: presentationSample?.ageMs };
    const correctionInput = {
      now: now(),
      error: signal.error,
      context: startKey(),
      eligible,
      uncertaintyMs: timing.clockUncertaintyMs,
      stabilityMs: timing.clockStabilityMs ?? timing.clockUncertaintyMs,
      frameSeconds: presentationTiming.cadence ? presentationTiming.cadence() : 0,
    };
    if (
      effectiveSyncMode === 'jumps' &&
      activeJump.update({
        ...correctionInput,
        error: difference,
        context: jumpContext,
        eligible: correctionInput.eligible && !state.waitingForReady,
        buffered: targetBuffered,
        settled: !player.paused() && !player.seeking() && !playerWaiting && player.readyState() >= 3,
        frames: decodedFrames(),
        position: player.currentTime(),
      }) &&
      canAlign &&
      !syncSeekPending &&
      !player.seeking()
    ) {
      align('sync-jump');
    }
    const rate =
      !supportsRate || (effectiveSyncMode === 'jumps' && !activeJump.suspended?.())
        ? 1
        : driftCorrection.update(correctionInput);
    player.setPlaybackRate(rate);
    applyAudio(state.state);
    if (paused) {
      player.pause();
      if (
        (state.waitingForReady || state.readiness) &&
        readyVersion !== state.mediaVersion &&
        !autoplayBlocked &&
        player.readyState() >= 2
      ) {
        await unlockLocal();
        void reportReadiness();
      } else if (
        (state.waitingForReady || state.readiness) &&
        readyVersion === state.mediaVersion &&
        !autoplayBlocked &&
        player.readyState() >= 3 &&
        !player.seeking()
      ) {
        void reportReadiness();
      }
    } else if (player.paused() && !autoplayBlocked) {
      const room = selected,
        version = state.mediaVersion,
        stream = state.streamVersion,
        source = mediaSource;
      const current = () => {
        const value = host.read();
        const sourceMatches = host.mediaReady ? Boolean(host.mediaReady(value)) : value.mediaSource === source;
        return (
          value.selected === room &&
          value.state?.mediaVersion === version &&
          value.state?.streamVersion === stream &&
          sourceMatches
        );
      };
      const measured = scheduledStartKey !== undefined && scheduledStartKey === startKey() && player.measureStart;
      scheduledStartKey = undefined;
      const kind = streamKind(snapshot);
      const measurement = measured ? player.measureStart() : undefined;
      void measurement?.then(ms => {
        if (ms !== undefined && current() && startDelay.record(kind, ms))
          diagnosticSample('start-delay', { delayMs: ms });
      });
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
    preparedStartKey = scheduledStartKey = undefined;
    syncSeekPending = false;
    sharedSeekPending = false;
    correctionSuppressionUntil = 0;
    hlsPreparationUntil = 0;
    hlsTimelinePending = false;
    lastControl = undefined;
    presentationTiming.reset?.();
  }

  function event(name) {
    if (name === 'playing' && !hlsTimelinePending) syncSeekPending = false;
    if (name === 'seeking' || name === 'emptied') presentationTiming.reset?.();
    else if (['pause', 'waiting', 'visibilitychange'].includes(name)) presentationTiming.interrupt?.(name);
    if (
      ['pause', 'waiting', 'seeking', 'emptied'].includes(name) ||
      (name === 'visibilitychange' && host.visibility() !== 'visible')
    ) {
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
    if (target > 0.65) {
      try {
        diagnosticSample('hls-anchor');
        player.seek(target);
        syncSeekPending = true;
      } catch {}
    }
  }

  function sharedSeek() {
    syncSeekPending = false;
    sharedSeekPending = true;
    jumpDriftCorrection.reset();
    if (embedJumpDriftCorrection !== jumpDriftCorrection) embedJumpDriftCorrection.reset();
    presentationTiming.interrupt?.('seek');
    if (hlsPreparationUntil) hlsPreparationUntil = now() + 10000;
  }

  function suppressCorrectionTelemetry(durationMs = 5000) {
    correctionSuppressionUntil = Math.max(correctionSuppressionUntil, now() + Math.max(0, durationMs));
  }

  function transition(next) {
    if (startKey() !== startKey(next)) {
      startAlarm.cancel();
      pauseAlarm.cancel();
    }
  }

  const interval = host.repeat(() => {
    if (host.read().state) void synchronize();
  }, 500);
  function close() {
    host.cancelRepeat(interval);
    reset();
  }

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
    get control() {
      return lastControl;
    },
    get driftCorrection() {
      return driftCorrection;
    },
    set driftCorrection(value) {
      driftCorrection = value || makeCorrection();
    },
    get seekPending() {
      return syncSeekPending;
    },
    get preparationUntil() {
      return hlsPreparationUntil;
    },
    get timelinePending() {
      return hlsTimelinePending;
    },
  };
}
