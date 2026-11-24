import * as uburoomPlayback from '../playback-policy.js';
import { createSync } from '../../shared/sync/client-sync.mjs';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { store } from './store.js';

/* Sync controller wiring: the shared client-sync controller on this page's player, the sync-quality measurements this viewer reports, playback observations and readiness. */
export function mount(host, deps) {
  function initializeSync() {
    store.player.sync = createSync({
      player: deps.activePlayer,
      timing: uburoomTiming,
      playback: uburoomPlayback,
      clock: deps.time.clock,
      presentation: deps.time.presentation,
      read: () => ({
        state: store.room.state,
        selected: store.room.selected,
        mediaSource: store.stream.mediaSource,
        receivedAt: store.room.receivedAt,
        probing: store.stream.probing,
        playbackError: store.player.playbackError,
        playerWaiting: store.player.playerWaiting,
        hlsNetworkFailure: store.stream.hlsNetworkFailure,
        autoplayBlocked: store.player.autoplayBlocked,
        readyVersion: store.stream.readyVersion,
        syncCorrectionMode: store.preferences.syncCorrectionMode,
      }),
      expected,
      decodedFrames: deps.decodedFrames,
      // Start-delay estimates are kept per stream kind: players start differently on direct files, HLS and local formats.
      streamKind: ({ state: current }) =>
        deps.surface?.isUbuPlayer?.() ? 'ubuplayer' : current?.directHls ? 'direct-hls' : current?.format || 'default',
      unlockLocal: deps.unlockLocal,
      reportReadiness,
      render: deps.renderTransport,
      checkFrames: deps.checkVideoFrames,
      sample: deps.diagnosticSample,
      correction: event =>
        deps.syncQuality.recordCorrection({ at: deps.time.mono(), magnitudeMs: event.magnitudeMs, kind: event.kind }),
      correctionEligible: () =>
        deps.time.mono() - store.player.lastPresentationBreak >= 2000 &&
        deps.time.mono() >= store.player.syncQualitySettleUntil &&
        !store.player.sync?.timelinePending,
      error: message => {
        store.player.playbackError = message;
        deps.fail(message);
      },
      playing: (version, blocked) => {
        if (version !== undefined) store.stream.readyVersion = version;
        store.player.autoplayBlocked = blocked;
      },
      visibility: () => document.visibilityState,
      online: () => navigator.onLine,
      repeat: (callback, delay) => deps.every(delay, callback),
      cancelRepeat: stop => stop(),
    });
  }
  // Where the room's timeline is now, from the one time base. Undefined while the room clock is unusable and
  // the timeline moves: the player holds instead of guessing from when the last state arrived.
  function expected() {
    return deps.time.target(store.room.state);
  }
  // A paused player reports less often from the periodic timer: often enough that the server keeps its
  // playback record (it closes after 5 s without a report), not once a second for a picture that is still.
  const PAUSED_REPORT_MS = 3000;
  let lastReportAt = -Infinity;
  async function reportObservation(immediateStall = false, periodic = false) {
    const active = deps.activePlayer;
    if (periodic && active.paused() && !active.seeking() && deps.time.mono() - lastReportAt < PAUSED_REPORT_MS) return;
    // While a new stream is held back for a seamless swap, the player still shows the stream the server
    // has already replaced, so the server would reject every report about it.
    if (
      !store.player.observing ||
      !store.room.selected ||
      !store.room.state?.mediaUrl ||
      !store.room.state.streamVersion ||
      store.stream.mediaSource !== store.room.state.mediaUrl ||
      store.stream.heldStream
    ) {
      store.player.observationQueued = false;
      return;
    }
    // A waiting event can get through while a periodic observation awaits its
    // acknowledgement. Bound concurrency and let the server fence report order.
    if (store.player.observationPending && (!immediateStall || store.player.observationPending >= 2)) {
      store.player.observationQueued = true;
      return;
    }
    const id = store.room.selected;
    const ytActive = Boolean(deps.youtube?.isActive());
    const adPlaying = ytActive && Boolean(deps.youtube?.isAdPlaying());
    const hasError = Boolean(
      store.player.playbackError || (ytActive ? deps.youtube.errorCode() : deps.surface.errorCode()),
    );
    const playerState = hasError
      ? 'error'
      : store.player.autoplayBlocked
        ? 'blocked'
        : active.ended()
          ? 'ended'
          : active.seeking()
            ? 'seeking'
            : store.stream.probing || adPlaying
              ? 'buffering'
              : active.paused()
                ? 'paused'
                : store.player.playerWaiting || active.readyState() < 3
                  ? 'buffering'
                  : 'playing';
    const sampleAt = deps.time.mono(),
      observedAt = deps.time.observation.sample(sampleAt);
    if (observedAt === undefined) {
      deps.diagnostics.record('observation-uncredited', { creditReason: 'clock-unavailable' });
      return;
    }
    const knownDuration = active.duration();
    const data = {
      viewerId: store.identity.viewerId,
      epoch: store.room.state.epoch,
      mediaVersion: store.room.state.mediaVersion,
      streamVersion: store.room.state.streamVersion,
      observationEpoch: store.room.state.observationEpoch,
      sequence: ++store.player.observationSequence,
      sampleAt,
      observedAt,
      position: active.currentTime(),
      rate: active.playbackRate(),
      frames:
        active.hasFrameEvidence === false
          ? 0
          : uburoomPlayback.observationFrames(
              deps.surface.isUbuPlayer() ? deps.surface.ubuplayer() : deps.video,
              store.player.videoFrames,
            ),
      discontinuity: store.player.observationBreak,
      state: playerState,
      ...(playerState === 'buffering' ? { stalled: !store.stream.probing && !adPlaying } : {}),
      ...(store.room.state.durationUnknown && Number.isFinite(knownDuration) && knownDuration > 0
        ? { duration: knownDuration }
        : {}),
    };
    store.player.observationPending++;
    lastReportAt = sampleAt;
    try {
      const result = await deps.roomLink.observe(id, data);
      if (result.credit && result.credit.reason !== 'credited')
        deps.diagnostics.record('observation-uncredited', { ...result.credit, creditReason: result.credit.reason });
    } catch {
      /* Never replay an observation after reconnect. The next sample is fresh. */
    } finally {
      store.player.observationPending--;
      if (!store.player.observationPending && store.player.observationQueued) {
        store.player.observationQueued = false;
        void reportObservation();
      }
    }
  }
  for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error'])
    deps.surface.addEventListener(event, () => {
      if (event === 'waiting') store.player.playerWaiting = true;
      if (event === 'playing' || event === 'seeked') store.player.playerWaiting = false;
      if (['pause', 'waiting', 'seeking', 'seeked', 'ended', 'error'].includes(event)) {
        deps.syncQuality.breakSample();
      }
      // Periodic samples include rate corrections; assigning playbackRate can
      // emit ratechange even when the rate is unchanged.
      if (event !== 'ended' && !(event === 'pause' && deps.activePlayer.ended())) store.player.observationBreak++;
      void reportObservation(
        event === 'waiting' &&
          store.room.state?.pauseOnBuffering === true &&
          store.room.state.state.paused === false &&
          !deps.activePlayer.paused() &&
          !deps.activePlayer.seeking() &&
          !store.stream.probing,
      );
    });
  deps.every(1000, () => {
    void reportObservation(false, true);
    if (store.room.state?.readiness) void reportReadiness();
  });

  async function reportReadiness() {
    if (!store.room.selected || !store.room.state?.mediaUrl) return;
    if (store.stream.readyPending) {
      store.stream.readyQueued = true;
      return;
    }
    const active = deps.activePlayer,
      stateBuffered = active.bufferModel === 'state';
    const id = store.room.selected,
      version = store.room.state.mediaVersion,
      readinessVersion = store.room.state.readinessVersion,
      readinessId = store.room.state.readiness?.id,
      streamVersion = store.room.state.streamVersion;
    const target = expected();
    const playerDuration = active.duration();
    const { duration, ceiling } = uburoomTiming.nearEndBounds(store.room.state.state.duration, playerDuration);
    const readyTarget = Math.max(0, Math.min(target, ceiling));
    const alignBand = stateBuffered ? 0.35 : readyTarget === 0 ? 0.25 : readinessVersion ? 0.15 : 0.65;
    const aligned =
      Number.isFinite(target) && !active.seeking() && Math.abs(active.currentTime() - readyTarget) <= alignBand;
    const bufferedReady =
      Number.isFinite(target) &&
      aligned &&
      (!store.room.state.state.paused ||
        (stateBuffered
          ? active.readyState() >= 3 || active.bufferedAhead(readyTarget) >= 0.5
          : uburoomPlayback.readinessBuffered(deps.surface.buffered(), readyTarget, duration)));
    const hasFrames = active.readyState() >= 3 && (active.hasFrameEvidence === false || deps.decodedFrames() > 0);
    const ready = bufferedReady && hasFrames && store.stream.readyVersion === version && !store.player.playbackError;
    let blocker;
    if (!ready && readinessId && streamVersion && !store.player.playbackError && !store.player.autoplayBlocked) {
      const reason =
        store.stream.probing || !hasFrames
          ? 'preparing'
          : !aligned
            ? 'timing'
            : !bufferedReady
              ? 'preparing'
              : undefined;
      if (reason) blocker = { id: readinessId, streamVersion, reason };
    }
    const learnDuration =
      store.room.state.durationUnknown && Number.isFinite(playerDuration) && playerDuration > 0
        ? Math.round(playerDuration * 10) / 10
        : undefined;
    const key = [id, version, readinessVersion, readinessId, streamVersion, ready, blocker?.reason, learnDuration].join(
      ':',
    );
    if (
      store.stream.readinessSent === key ||
      (!store.room.state.readiness && !store.room.state.waitingForReady && !ready && learnDuration === undefined)
    )
      return;
    store.stream.readyPending = true;
    try {
      await deps.roomLink.ready(id, {
        mediaVersion: version,
        ready,
        readinessVersion,
        ...(blocker ? { blocker } : {}),
        ...(learnDuration !== undefined ? { duration: learnDuration } : {}),
      });
      store.stream.readinessSent = key;
    } catch {
    } finally {
      store.stream.readyPending = false;
      if (store.stream.readyQueued) {
        store.stream.readyQueued = false;
        void reportReadiness();
      }
    }
  }
  return { expected, reportObservation, reportReadiness, initializeSync };
}
