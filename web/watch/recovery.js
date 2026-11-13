import * as uburoomPlayback from '../playback-policy.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Player recovery: HLS session refresh and error recovery with bounded retries, the held last frame through stream swaps, and the grace period when the room connection drops. */
export function mount(host, deps) {
  // The picture stays on the last frame through the gap the swap cannot avoid. The first
  // frame of a new stream is the anchor, so wait for the real one at the room's position.
  let frameHold, frameHoldTimer, frameHoldShown;
  function holdLastFrame() {
    if (deps.video.readyState < 2 || !deps.video.videoWidth) return;
    if (!frameHold) {
      frameHold = document.createElement('canvas');
      frameHold.id = 'frame-hold';
      frameHold.hidden = true;
      deps.video.after(frameHold);
    }
    frameHold.width = deps.video.videoWidth;
    frameHold.height = deps.video.videoHeight;
    frameHold.style.scale = deps.video.style.scale;
    frameHold.style.translate = deps.video.style.translate;
    try {
      frameHold.getContext('2d').drawImage(deps.video, 0, 0);
    } catch {
      return;
    }
    frameHold.hidden = false;
    frameHoldShown = deps.time.mono();
    deps.time.clearTimeout(frameHoldTimer);
    frameHoldTimer = deps.time.setTimeout(releaseLastFrame, 8000);
    const shown = () => {
      if (frameHold.hidden) return;
      if (store.player.sync.timelinePending || deps.video.seeking || deps.video.readyState < 2)
        return void deps.video.requestVideoFrameCallback(shown);
      releaseLastFrame();
    };
    if (deps.video.requestVideoFrameCallback) queueMicrotask(() => deps.video.requestVideoFrameCallback(shown));
    else deps.video.addEventListener('playing', releaseLastFrame, { once: true });
  }
  function releaseLastFrame() {
    deps.time.clearTimeout(frameHoldTimer);
    if (frameHold && !frameHold.hidden)
      deps.diagnostics.record('frame-hold-end', { elapsedMs: deps.time.mono() - frameHoldShown });
    if (frameHold) frameHold.hidden = true;
  }
  function stopHls(reason) {
    if (store.stream.hls) deps.diagnosticSample('hls-stop', { reason });
    deps.time.clearTimeout(store.stream.hls?.refreshRetryTimer);
    deps.time.clearTimeout(store.stream.hlsRecoveryTimer);
    store.stream.hlsNetworkRetries = 0;
    store.stream.hlsNetworkFailure = undefined;
    store.stream.hlsNetworkInterrupted = false;
    const client = store.stream.hls;
    store.stream.hls = undefined;
    client?.destroy();
  }
  function restartHlsForSeek(target) {
    if (store.player.sync.timelinePending) return;
    if (
      !store.stream.hls ||
      !store.stream.hlsNetworkInterrupted ||
      store.room.state?.mediaUrl !== store.stream.mediaSource ||
      uburoomPlayback.bufferedAhead(deps.video.buffered, target) > 0.05
    )
      return;
    // A new authorized room seek supersedes the old segment's retry timer.
    // stopLoad keeps MediaSource and its cached ranges attached.
    deps.time.clearTimeout(store.stream.hlsRecoveryTimer);
    store.stream.hlsNetworkRetries = 0;
    if (store.player.playbackError === store.stream.hlsNetworkFailure) store.player.playbackError = '';
    store.stream.hlsNetworkFailure = undefined;
    store.stream.hlsNetworkInterrupted = false;
    store.stream.hls.stopLoad();
    store.stream.hls.startLoad(target);
  }
  async function refreshHlsSession(client) {
    if (
      store.stream.hls !== client ||
      store.room.state?.format !== 'hls' ||
      store.room.state.mediaUrl !== store.stream.mediaSource ||
      store.stream.hlsRefreshPending
    )
      return;
    // A dead Plex session costs nothing until its buffered media is needed, and
    // replacing it discards that media, so keep playing what is already here.
    const buffered = uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime) >= 15;
    if (store.room.pending || store.stream.qualityPending || buffered) {
      if (client.refreshRetryTimer) return;
      const room = store.room.selected,
        version = store.room.state.mediaVersion,
        stream = store.room.state.streamVersion;
      client.refreshRetryTimer = deps.time.setTimeout(
        () => {
          client.refreshRetryTimer = undefined;
          if (
            store.stream.hls === client &&
            store.room.selected === room &&
            store.room.state?.mediaVersion === version &&
            store.room.state?.streamVersion === stream
          )
            void refreshHlsSession(client);
        },
        buffered ? 2000 : 200,
      );
      return;
    }
    if (store.stream.hlsRefreshVersion !== store.room.state.mediaVersion) {
      store.stream.hlsRefreshVersion = store.room.state.mediaVersion;
      store.stream.hlsRefreshTimes = [];
    }
    const now = deps.time.wall();
    store.stream.hlsRefreshTimes = store.stream.hlsRefreshTimes.filter(time => now - time < 60000);
    if (store.stream.hlsRefreshTimes.length >= 3) return;
    store.stream.hlsRefreshTimes.push(now);
    store.stream.hlsRefreshPending = true;
    deps.diagnosticSample('stream-refresh');
    const version = store.room.state.mediaVersion,
      streamVersion = store.room.state.streamVersion;
    try {
      await deps.execute({ action: 'media.stream.refresh', args: { mediaVersion: version, streamVersion } });
      deps.diagnosticSample('stream-refresh-ok');
    } catch {
      deps.diagnosticSample('stream-refresh-failed');
      if (store.room.state?.directHls && store.room.state?.streamVersion === streamVersion) void deps.proxyDirectFile();
      // The old buffered media can still play. HLS's bounded network retry
      // reports an error if delivery does not return in time.
    } finally {
      store.stream.hlsRefreshPending = false;
    }
  }
  function handleHlsFragmentBuffered(client) {
    if (
      store.stream.hls !== client ||
      !store.room.state?.state ||
      store.room.state.mediaUrl !== store.stream.mediaSource
    )
      return;
    if (store.player.sync.timelinePending) {
      // Plex advertises estimated segment durations. Starting a fresh transmuxer
      // in the middle normalizes its first PTS against that estimate, moving the
      // actual pictures relative to currentTime. Anchor every private stream at
      // segment zero before seeking, keeping that origin for the stream lifetime.
      const target = deps.expected();
      store.player.sync.anchor(target);
      if (target > 0.65) {
        client.startLoad(target);
      }
      client.resumeBuffering();
      void store.player.sync.synchronize();
    }
    // A buffered fragment from an obsolete seek does not establish that the
    // shared playback position can advance again.
    const target = deps.expected(),
      ahead = uburoomPlayback.bufferedAhead(deps.video.buffered, target);
    if (ahead <= 0.05 || ahead + 0.05 < Math.min(0.5, Math.max(0, store.room.state.state.duration - target))) return;
    if (store.room.state.waitingForReady || store.room.state.readiness) void deps.reportReadiness();
    deps.time.clearTimeout(store.stream.hlsRecoveryTimer);
    const resume = !!store.stream.hlsNetworkFailure && store.player.playbackError === store.stream.hlsNetworkFailure;
    store.stream.hlsNetworkRetries = 0;
    store.stream.hlsNetworkFailure = undefined;
    store.stream.hlsNetworkInterrupted = false;
    if (resume) {
      deps.diagnosticSample('buffer-recovered');
      store.player.playbackError = '';
      deps.fail('');
      void store.player.sync.synchronize();
    }
  }
  function handleHlsError(client, data) {
    if (store.stream.hls !== client) return;
    const detail = uburoomPlayback.hlsErrorDetail(data, Hls.ErrorDetails);
    deps.diagnosticSample('hls-error', {
      fatal: !!data.fatal,
      status: data.response?.code,
      category:
        data.type === Hls.ErrorTypes.NETWORK_ERROR
          ? 'network'
          : data.type === Hls.ErrorTypes.MEDIA_ERROR
            ? 'media'
            : 'other',
      detail,
      hlsMaxBufferSize: client.config?.maxBufferSize,
      hlsMaxBufferLength: client.config?.maxBufferLength,
      hlsMaxMaxBufferLength: client.config?.maxMaxBufferLength,
      hlsBackBufferLength: client.config?.backBufferLength,
    });
    if (store.room.state?.directHls && data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      client.stopLoad();
      if (
        (detail === 'fragment' || [404, 410].includes(data.response?.code)) &&
        (store.stream.hlsRefreshVersion !== store.room.state.mediaVersion || !store.stream.hlsRefreshTimes.length)
      ) {
        void refreshHlsSession(client);
      } else void deps.proxyDirectFile();
      return;
    }
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      store.stream.hlsNetworkInterrupted = true;
      // A vanished Plex conversion can be reported as a nonfatal fragment
      // error while hls.js is still spending its own retry budget.
      if ([404, 410].includes(data.response?.code)) void refreshHlsSession(client);
    }
    if (data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR) {
      // Keep already buffered media attached while retrying the current stream.
      // Authorization and grant renewal still run through the normal room poll.
      deps.time.clearTimeout(store.stream.hlsRecoveryTimer);
      if (store.stream.hlsNetworkRetries >= 3)
        store.stream.hlsNetworkFailure = 'The video stream could not load. Check the connection and try again.';
      // Three quick retries, then at most three low-frequency recovery attempts.
      // Keep the private stream, tracks and shared timeline; never replay commands.
      if (store.stream.hlsNetworkRetries < 6) {
        const attempt = store.stream.hlsNetworkRetries++,
          delay = attempt < 3 ? 1000 * 2 ** attempt : 15000 * 2 ** (attempt - 3);
        deps.diagnostics.record('retry-scheduled', { attempt: attempt + 1, delayMs: delay });
        const source = store.stream.mediaSource,
          version = store.room.state?.mediaVersion,
          stream = store.room.state?.streamVersion,
          room = store.room.selected;
        const retry = () => {
          if (
            store.stream.hls !== client ||
            !store.room.state?.state ||
            store.room.selected !== room ||
            store.stream.mediaSource !== source ||
            store.room.state.mediaUrl !== source ||
            store.room.state.mediaVersion !== version ||
            store.room.state.streamVersion !== stream
          )
            return;
          // Wait for online state and a recent authorized poll before loading.
          if (navigator.onLine === false || deps.time.mono() - store.room.receivedAt > 3000) {
            deps.diagnostics.record('retry-deferred', { attempt: attempt + 1, delayMs: delay });
            store.stream.hlsRecoveryTimer = deps.time.setTimeout(retry, delay);
            return;
          }
          const target = store.player.sync.timelinePending ? 0 : deps.expected();
          if (!Number.isFinite(target) || target < 0 || target >= store.room.state.state.duration) return;
          // Once the delivery error pauses local playback, normal synchronization
          // is suspended. Retarget MSE too, or hls.js can refill the old position.
          if (deps.video.readyState >= 1 && Math.abs(deps.video.currentTime - target) > 0.65)
            deps.video.currentTime = target;
          deps.diagnosticSample('retry-start', { attempt: attempt + 1 });
          store.stream.hlsRecoveryTimer = undefined;
          client.startLoad(target);
        };
        store.stream.hlsRecoveryTimer = deps.time.setTimeout(retry, delay);
      }
      return;
    }
    // hls.js also resets MediaSource internally on nonfatal reset events.
    if (data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET && !data.fatal) {
      if (spendHlsRecovery()) return;
    } else if (!data.fatal) return;
    else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && spendHlsRecovery()) {
      // Retry the current authorized stream once. No shared command or timeline change.
      store.stream.hlsRecoveryTimer = deps.time.setTimeout(() => {
        if (store.stream.hls === client && store.room.state?.mediaUrl === store.stream.mediaSource) {
          client.recoverMediaError();
          client.startLoad(store.player.sync.timelinePending ? 0 : deps.expected());
        }
      }, 0);
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR || data.details === Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET) {
      store.stream.fallbackDetail = [
        data.details,
        data.sourceBufferName,
        data.frag?.type,
        data.frag ? 'sn ' + data.frag.sn : '',
        (data.error || data.err)?.message,
        'at ' + deps.video.currentTime + '/' + deps.expected(),
      ]
        .filter(Boolean)
        .join(' ');
      void deps.compatibleFallback(
        ['quota-exceeded', 'buffer-full', 'buffer-append'].includes(detail)
          ? 'The browser could not append video data.'
          : 'The browser media pipeline failed.',
      );
      return;
    }
    stopHls('fatal');
    store.player.playbackError =
      data.type === Hls.ErrorTypes.MEDIA_ERROR
        ? 'The browser could not decode the video stream (' +
          data.details +
          '). Try enabling hardware acceleration or use the website.'
        : 'The video stream could not load (' + data.details + '). Check the connection and try again.';
    deps.fail(store.player.playbackError);
  }
  // One in-place recovery per quiet minute: failures this close together are one
  // problem, but an unrelated failure much later must not force a conversion.
  function spendHlsRecovery() {
    const now = deps.time.mono();
    if (now - store.stream.hlsRecoveryAt >= 60000) store.stream.hlsRecoveryCount = 0;
    store.stream.hlsRecoveryAt = now;
    return store.stream.hlsRecoveryCount++ === 0;
  }
  // Waits as long as the host buffering notice, so a brief stream replacement stays quiet.
  function renderProviderNotice(active) {
    if (!active) {
      deps.time.clearTimeout(store.stream.providerNoticeTimer);
      store.stream.providerNoticeTimer = undefined;
      if (store.stream.providerNoticeShown) deps.toasts.dismiss('provider-problem');
      store.stream.providerNoticeShown = false;
      return;
    }
    if (store.stream.providerNoticeShown || store.stream.providerNoticeTimer) return;
    store.stream.providerNoticeTimer = deps.time.setTimeout(() => {
      store.stream.providerNoticeTimer = undefined;
      store.stream.providerNoticeShown = true;
      deps.toasts.show('provider-problem', {
        type: 'error',
        title: 'Plex connection problem',
        hint: 'Playback should resume once Plex recovers.',
        symbol: 'refresh',
        persistent: true,
      });
    }, 3000);
  }
  function connectionLost(details = {}) {
    deps.diagnostics.record('control-disconnected', {
      socketCloseCode: details.code,
      connectionId: details.connectionId,
      connectionAttempt: details.connectionAttempt,
      connectionAgeMs: details.connectionAgeMs,
      closeInitiator: details.closeInitiator,
      socketCloseClean: details.clean,
      socketWasReady: details.wasReady,
      visibility: document.visibilityState,
    });
    if (store.connection.transport?.ready) store.connection.transport.interrupt(1000);
    if (store.connection.reconnecting) return;
    store.connection.reconnecting = true;
    store.connection.stateRequestSequence++;
    deps.time.clock.reset();
    deps.resetSyncQuality();
    deps.queueUI.rememberPosition();

    if (store.room.state) store.room.state = { ...store.room.state, enabled: false, reachable: false };
    deps.renderTransport();
    deps.renderBrowsing();
    deps.renderVisibility();
    document.title = document.title.replace(/^🟢 /, '');
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = deps.time.setTimeout(() => {
      if (!store.connection.reconnecting) return;
      const buffered = uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime);
      if (buffered > 2) {
        store.connection.disconnectExtended = true;
        deps.diagnostics.record('disconnect-extended', { bufferAhead: buffered });
        store.stream.hls?.stopLoad();
        showDisconnectToast();
      } else {
        deps.diagnostics.record('disconnect-expired', { bufferAhead: buffered });
        fullPlayerClear();
      }
    }, deps.DISCONNECT_GRACE_MS);
  }
  function showDisconnectToast() {
    deps.toasts.show('reconnect', {
      title: 'Disconnected from room',
      hint: 'Reconnecting…',
      symbol: 'refresh',
      loading: true,
    });
  }
  function hideDisconnectToast() {
    deps.toasts.dismiss('reconnect');
  }
  function fullPlayerClear() {
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = undefined;
    store.connection.disconnectExtended = false;
    hideDisconnectToast();
    deps.clearPlayer('control-disconnected');
    if (store.room.selected) {
      $('empty-title').textContent = 'Reconnecting to your room…';
      $('empty-hint').textContent = 'Your library and queue position are kept.';
    }
    deps.fail('Disconnected. Reconnecting…');
  }
  return {
    connectionLost,
    fullPlayerClear,
    handleHlsError,
    handleHlsFragmentBuffered,
    hideDisconnectToast,
    holdLastFrame,
    refreshHlsSession,
    renderProviderNotice,
    restartHlsForSeek,
    stopHls,
  };
}
