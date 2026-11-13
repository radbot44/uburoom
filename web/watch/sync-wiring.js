import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { store } from './store.js';

/* Sync controller wiring: the shared client-sync controller on this page's player, the sync-quality measurements this viewer reports, playback observations and readiness. */
export function mount(host, deps) {
  const syncReady = import('../watch-sync.mjs').then(({ createSync }) => {
    store.player.sync = createSync({
      video: deps.video,
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
      streamKind: ({ state: current }) => (current?.directHls ? 'direct-hls' : current?.format || 'default'),
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
  });
  // Where the room's timeline is now, from the one time base. Undefined while the room clock is unusable and
  // the timeline moves: the player holds instead of guessing from when the last state arrived.
  function expected() {
    return deps.time.target(store.room.state);
  }
  async function reportObservation() {
    if (
      !store.player.observing ||
      !store.room.selected ||
      !store.room.state?.mediaUrl ||
      !store.room.state.streamVersion ||
      store.stream.mediaSource !== store.room.state.mediaUrl
    ) {
      store.player.observationQueued = false;
      return;
    }
    if (store.player.observationPending) {
      store.player.observationQueued = true;
      return;
    }
    const id = store.room.selected;
    const playerState =
      store.player.playbackError || deps.video.error
        ? 'error'
        : store.player.autoplayBlocked
          ? 'blocked'
          : deps.video.ended
            ? 'ended'
            : deps.video.seeking
              ? 'seeking'
              : store.stream.probing
                ? 'buffering'
                : deps.video.paused
                  ? 'paused'
                  : store.player.playerWaiting || deps.video.readyState < 3
                    ? 'buffering'
                    : 'playing';
    const sampleAt = deps.time.mono(),
      observedAt = deps.time.observation.sample(sampleAt);
    if (observedAt === undefined) {
      deps.diagnostics.record('observation-uncredited', { creditReason: 'clock-unavailable' });
      return;
    }
    const data = {
      viewerId: store.identity.viewerId,
      epoch: store.room.state.epoch,
      mediaVersion: store.room.state.mediaVersion,
      streamVersion: store.room.state.streamVersion,
      observationEpoch: store.room.state.observationEpoch,
      sequence: ++store.player.observationSequence,
      sampleAt,
      observedAt,
      position: deps.video.currentTime,
      rate: deps.video.playbackRate,
      frames: uburoomPlayback.observationFrames(deps.video, store.player.videoFrames),
      discontinuity: store.player.observationBreak,
      state: playerState,
    };
    store.player.observationPending = true;
    try {
      const result = await deps.roomLink.observe(id, data);
      if (result.credit && result.credit.reason !== 'credited')
        deps.diagnostics.record('observation-uncredited', { ...result.credit, creditReason: result.credit.reason });
    } catch {
      /* Never replay an observation after reconnect. The next sample is fresh. */
    } finally {
      store.player.observationPending = false;
      if (store.player.observationQueued) {
        store.player.observationQueued = false;
        void reportObservation();
      }
    }
  }
  for (const event of ['playing', 'pause', 'waiting', 'seeking', 'seeked', 'ended', 'error'])
    deps.video.addEventListener(event, () => {
      if (event === 'waiting') store.player.playerWaiting = true;
      if (event === 'playing' || event === 'seeked') store.player.playerWaiting = false;
      if (['pause', 'waiting', 'seeking', 'seeked', 'ended', 'error'].includes(event)) {
        deps.syncQuality.breakSample();
      }
      // Periodic samples include rate corrections; assigning playbackRate can
      // emit ratechange even when the rate is unchanged.
      if (event !== 'ended' && !(event === 'pause' && deps.video.ended)) store.player.observationBreak++;
      void reportObservation();
    });
  deps.every(1000, () => void reportObservation());

  async function reportReadiness() {
    if (!store.room.selected || !store.room.state?.mediaUrl) return;
    if (store.stream.readyPending) {
      store.stream.readyQueued = true;
      return;
    }
    const id = store.room.selected,
      version = store.room.state.mediaVersion,
      readinessVersion = store.room.state.readinessVersion;
    const target = expected();
    const bufferedReady =
      !store.room.state.state.paused ||
      (!deps.video.seeking &&
        Math.abs(deps.video.currentTime - target) <= (target === 0 ? 0.25 : readinessVersion ? 0.15 : 0.65) &&
        uburoomPlayback.readinessBuffered(deps.video.buffered, target, store.room.state.state.duration));
    const ready =
      bufferedReady &&
      deps.video.readyState >= 3 &&
      deps.decodedFrames() > 0 &&
      store.stream.readyVersion === version &&
      !store.player.playbackError;
    const key = id + ':' + version + ':' + readinessVersion + ':' + ready;
    if (
      store.stream.readinessSent === key ||
      (!store.room.state.readiness && !store.room.state.waitingForReady && !ready)
    )
      return;
    store.stream.readyPending = true;
    try {
      await deps.roomLink.ready(id, { mediaVersion: version, ready, readinessVersion });
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
  return { expected, reportObservation, reportReadiness, syncReady };
}
