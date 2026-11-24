import * as uburoom from '../../shared/engine.mjs';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { $ } from './page.js';
import { store } from './store.js';

/* Player lifecycle: frame counting, playback health and choppiness warnings, capability probes, clearing the player, hls.js configuration and the local unlock before shared play. */
export function mount(host, deps) {
  function clearDirectTimers(clearStartup = false) {
    deps.time.clearTimeout(store.stream.directStallTimer);
    store.stream.directStallTimer = undefined;
    if (clearStartup) {
      deps.time.clearTimeout(store.stream.directStartupTimer);
      store.stream.directStartupTimer = undefined;
      store.stream.directStartupBegan = undefined;
    }
  }
  deps.video.addEventListener('waiting', () => {
    deps.time.clearTimeout(store.stream.directStallTimer);
    if (!store.room.state?.directDelivery || deps.surface.isUbuPlayer()) return;
    const stream = store.room.state.streamVersion,
      position = deps.video.currentTime;
    store.stream.directStallTimer = deps.time.setTimeout(() => {
      if (
        store.room.state?.directDelivery &&
        !deps.surface.isUbuPlayer() &&
        store.room.state.streamVersion === stream &&
        !deps.video.paused &&
        deps.video.readyState < 3 &&
        deps.video.currentTime <= position + 0.1
      )
        void deps.proxyDirectFile();
    }, 8000);
  });
  for (const evt of ['playing', 'canplay', 'loadeddata']) {
    deps.surface.addEventListener(evt, () => clearDirectTimers(true));
  }
  for (const evt of ['pause', 'seeked']) {
    deps.surface.addEventListener(evt, () => clearDirectTimers(false));
  }
  deps.video.addEventListener('progress', () => {
    if (
      !store.stream.directStartupTimer ||
      !store.room.state?.directDelivery ||
      deps.surface.isUbuPlayer() ||
      deps.video.readyState >= 2 ||
      deps.time.mono() - (store.stream.directStartupBegan || 0) >= 30000
    )
      return;
    const stream = store.room.state.streamVersion;
    deps.time.clearTimeout(store.stream.directStartupTimer);
    store.stream.directStartupTimer = deps.time.setTimeout(() => {
      store.stream.directStartupTimer = undefined;
      if (
        store.room.state?.directDelivery &&
        !deps.surface.isUbuPlayer() &&
        store.room.state.streamVersion === stream &&
        deps.video.readyState < 2
      )
        void deps.proxyDirectFile();
    }, 8000);
  });
  window.addEventListener('online', () => {
    if (
      store.room.state?.directDelivery &&
      !deps.surface.isUbuPlayer() &&
      !store.stream.directProbe &&
      !store.stream.directStartupTimer &&
      (deps.video.error || (deps.video.readyState < 2 && deps.video.networkState === 3))
    )
      void deps.proxyDirectFile();
  });
  function watchFrames() {
    if (!deps.surface.supportsFrameCallback()) return;
    store.player.frameCallback = deps.surface.requestFrame((now, metadata) => {
      store.player.videoFrames++;
      try {
        const active = deps.activePlayer;
        const timing = deps.time.clock.read(metadata.expectedDisplayTime);
        const target = uburoomTiming.target(store.room.state, timing.serverTime);
        const frame = deps.time.presentation.frame(now, metadata, {
          target,
          context: store.player.sync?.contextKey(),
          clockRevision: timing.clockRevision,
        });
        const presentationErrorMs = frame?.presentationErrorMs;
        if (frame)
          deps.diagnostics.record('frame', {
            ...frame,
            ...timing,
            clockValid: timing.valid,
            frameServerTime: timing.serverTime,
            timelineRevision: store.room.state?.revision,
            sharedTarget: target,
            presentationErrorMs,
            smoothedPresentationErrorMs: frame.smoothedPresentationErrorMs,
            paused: active.paused(),
            roomPaused: store.room.state?.state.paused,
            seeking: active.seeking(),
            waiting: store.player.playerWaiting,
            ready: active.readyState(),
            rate: active.playbackRate(),
            syncMode: store.preferences.syncCorrectionMode,
            settling: deps.time.mono() - store.player.lastPresentationBreak < 2000,
            visibility: document.visibilityState,
            bufferAhead: active.bufferedAhead(active.currentTime()),
          });
      } catch {
        /* Diagnostics cannot stop the decoded-frame evidence loop. */
      }
      watchFrames();
    });
  }
  const playbackHealthTracker = uburoomPlayback.healthTracker(),
    viewerClient = uburoomPlayback.clientKind(navigator, !!deps.activity);

  const choppyDetector = uburoomPlayback.choppinessDetector({ threshold: 0.1, windowMs: 10000, minFrames: 50 });
  store.player.choppyToastActive = false;
  store.player.capabilityProbeVersion = 0;
  async function probePlaybackCapabilities(configuration, client = store.stream.hls) {
    const key = JSON.stringify(configuration);
    if (key === store.player.capabilityProbeKey) return;
    store.player.capabilityProbeKey = key;
    const version = ++store.player.capabilityProbeVersion,
      room = store.room.selected,
      media = store.room.state?.mediaVersion,
      stream = store.room.state?.streamVersion;
    const result = await uburoomPlayback.decodingCapability(configuration, navigator.mediaCapabilities);
    if (
      version !== store.player.capabilityProbeVersion ||
      store.stream.hls !== client ||
      store.room.selected !== room ||
      store.room.state?.mediaVersion !== media ||
      store.room.state?.streamVersion !== stream
    )
      return;
    deps.diagnostics.record('decode-capability', { format: store.room.state?.format, ...result });
  }
  function resetChoppyPlayback(preserve = false) {
    deps.toasts.dismiss('choppy', false);
    store.player.choppyToastActive = false;
    if (preserve) choppyDetector.interrupt();
    else choppyDetector.reset();
    store.player.capabilityProbeVersion++;
    store.player.capabilityProbeKey = undefined;
  }
  function dropPlaybackQuality() {
    const choices = store.room.state?.qualities || uburoom.QUALITIES;
    const current = uburoom.qualityId(store.room.state?.quality || store.preferences.preferredQuality);
    const index = choices.findIndex(q => q.id === current);
    if (index >= 0 && index < choices.length - 1) {
      const next = choices[index + 1].id;
      store.preferences.preferredQuality = next;
      deps.savePlayerPreferences({ quality: store.preferences.preferredQuality });
      choppyDetector.triggerCooldown(10000, deps.time.mono());
      if (store.room.state?.mediaId && store.room.state.mediaId !== 'demo') {
        deps
          .execute({
            action: 'media.quality.set',
            args: {
              quality: store.preferences.preferredQuality,
              ubuplayer: deps.canUseUbuPlayer?.(),
              gpuTonemap: deps.canGpuTonemap?.(),
            },
          })
          .catch(error => deps.fail(error.message));
      }
    }
  }
  function checkChoppyPlayback() {
    if (
      !store.room.state?.mediaUrl ||
      store.room.state?.format === 'youtube-embed' ||
      store.room.state?.format === 'local' ||
      store.player.autoplayBlocked ||
      store.player.playbackError ||
      store.room.state?.mediaId === 'demo'
    ) {
      choppyDetector.interrupt();
      return;
    }
    const choices = store.room.state?.qualities || uburoom.QUALITIES;
    const current = uburoom.qualityId(store.room.state?.quality || store.preferences.preferredQuality);
    const index = choices.findIndex(q => q.id === current);
    if (index < 0 || index >= choices.length - 1) {
      choppyDetector.interrupt();
      if (store.player.choppyToastActive) {
        deps.toasts.dismiss('choppy', false);
        store.player.choppyToastActive = false;
      }
      return;
    }
    const active = deps.activePlayer;
    const quality = deps.surface.playbackQuality();
    const conditions = {
      paused: active.paused() || !!store.room.state?.state?.paused,
      seeking: active.seeking() || store.player.seekDragging || store.player.sync?.timelinePending,
      waiting: store.player.playerWaiting || active.readyState() < 3,
      visible: document.visibilityState === 'visible',
      active: !store.room.pending && !store.stream.qualityPending && active.currentTime() > 1,
    };
    const result = choppyDetector.update(deps.time.mono(), quality, conditions);
    if (result.rearmed) deps.diagnostics.record('playback-rearmed');
    if (result.warning) {
      deps.diagnosticSample('playback-degraded', {
        degradation: result.severeDropChoppy ? 'severe-drops' : result.dropChoppy ? 'drops' : 'stalls',
        dropRatio: result.ratio,
        deltaTotal: result.deltaTotal,
        deltaDropped: result.deltaDropped,
        severeRatio: result.severeRatio,
        severeTotal: result.severeTotal,
        severeDropped: result.severeDropped,
        totalStallMs: result.totalStallMs,
        stallCount: result.stallCount,
        sampleGapMs: result.sampleGapMs,
      });
      if (!store.player.choppyToastActive && !choppyDetector.isDismissed) {
        store.player.choppyToastActive = true;
        deps.toasts.show('choppy', {
          title: 'Playback seems choppy',
          duration: 15000,
          onClose: () => {
            store.player.choppyToastActive = false;
          },
          action: {
            label: 'Lower quality',
            run: () => {
              dropPlaybackQuality();
            },
          },
          onDismiss: deliberate => {
            store.player.choppyToastActive = false;
            if (deliberate) {
              choppyDetector.dismiss(true);
            }
          },
        });
      }
    } else if (
      store.player.choppyToastActive &&
      !result.choppy &&
      !result.warming &&
      !result.interrupted &&
      !result.inCooldown
    ) {
      deps.toasts.dismiss('choppy', false);
      store.player.choppyToastActive = false;
    }
  }
  function decodedFrames() {
    if (deps.youtube?.isActive()) return deps.youtube.frames();
    const quality = deps.surface.playbackQuality();
    return store.player.videoFrames || (quality ? quality.totalVideoFrames - quality.droppedVideoFrames : undefined);
  }
  function checkVideoFrames() {
    if (store.room.state?.format === 'youtube-embed') {
      choppyDetector.interrupt();
      store.player.frameStartedAt = undefined;
      return;
    }
    const active = deps.activePlayer,
      surface = deps.surface;
    const interrupted =
      !store.room.state?.mediaUrl ||
      active.paused() ||
      !!store.room.state?.state?.paused ||
      active.seeking() ||
      store.player.seekDragging ||
      !!store.player.sync?.timelinePending ||
      store.room.pending ||
      store.stream.qualityPending ||
      !!store.stream.heldStream ||
      document.visibilityState !== 'visible';
    store.player.playbackHealth = playbackHealthTracker.update(deps.time.mono(), surface.playbackQuality(), {
      stalled:
        !!store.room.state?.mediaUrl && (store.player.playerWaiting || (!active.paused() && active.readyState() < 3)),
      interrupted,
    });
    deps.fallbackPlayback.tick({
      bufferAhead: active.bufferedAhead(active.currentTime()),
      stallSeconds: playbackHealthTracker.currentStallSeconds(),
      interrupted: interrupted || store.player.autoplayBlocked,
      target: deps.expected(),
    });
    checkChoppyPlayback();
    // Hidden or minimized pages may stop producing frames while audio continues.
    if (
      !store.room.state?.mediaUrl ||
      active.paused() ||
      active.seeking() ||
      store.player.autoplayBlocked ||
      store.player.playbackError ||
      store.stream.fallbackPending ||
      document.visibilityState !== 'visible'
    ) {
      store.player.frameStartedAt = undefined;
      store.player.noFramePlayingMs = 0;
      store.player.lastFrameCheckAt = undefined;
      return;
    }
    const now = deps.time.mono();
    const frames = decodedFrames();
    if (frames > 0 && surface.width() > 0 && surface.height() > 0) {
      store.player.noFramePlayingMs = 0;
      store.player.lastFrameCheckAt = now;
      return;
    }
    if (!store.player.playerWaiting && active.readyState() >= 3 && active.currentTime() > 1) {
      store.player.frameStartedAt ??= now;
      if (store.player.lastFrameCheckAt !== undefined) {
        store.player.noFramePlayingMs =
          (store.player.noFramePlayingMs || 0) + Math.max(0, Math.min(2000, now - store.player.lastFrameCheckAt));
      }
      store.player.lastFrameCheckAt = now;
      if (store.player.noFramePlayingMs > 8000 || now - store.player.frameStartedAt > 8000) {
        void deps.compatibleFallback('Audio is playing without decoded video.');
      }
    } else {
      store.player.lastFrameCheckAt = undefined;
    }
  }
  function clearPlayer(reason, preserveSubtitles = false, preserveChoppiness = false) {
    if (reason !== 'state-change') deps.fallbackPlayback.reset();
    store.stream.directProbe?.abort();
    store.stream.directProbe = undefined;
    store.stream.directRecovery = undefined;
    deps.time.clearTimeout(store.stream.fallbackRetryTimer);
    store.stream.fallbackRetryTimer = undefined;
    deps.time.clearTimeout(store.stream.directStartupTimer);
    deps.time.clearTimeout(store.stream.directStallTimer);
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = undefined;
    store.connection.disconnectExtended = false;
    deps.hideDisconnectToast();
    resetChoppyPlayback(preserveChoppiness);
    deps.toasts.dismiss('participant');
    if (reason !== 'state-change') store.player.playerUI?.reset();
    store.player.sync.reset();
    deps.resetSyncQuality();
    deps.diagnosticSample('player-clear', { reason });
    if (store.player.pipWindow && reason !== 'state-change') {
      try {
        store.player.pipWindow.close();
      } catch {}
    }
    if (document.pictureInPictureElement && reason !== 'state-change') {
      try {
        document.exitPictureInPicture().catch(() => {});
      } catch {}
    }
    if (reason !== 'state-change') {
      deps.roomUI?.closeTelemetryCard?.();
      for (const id of deps.bufferingViewers.keys()) deps.toasts.dismiss('buffering-' + id);
      deps.bufferingViewers.clear();
      deps.suppressedBuffering.clear();
      store.room.voluntarilyPausedFor = null;
    }
    if (!preserveSubtitles) {
      deps.captions.reset();
      store.player.trackActionError = '';
      deps.setSubtitleLoading(false);
      deps.toasts.dismiss('subtitle-error');
      store.player.subtitleErrorNotice = undefined;
    }
    store.player.observing = false;
    store.player.observationBreak++;
    store.player.playerWaiting = false;
    store.stream.av1?.destroy();
    store.stream.av1 = undefined;
    if (store.player.frameCallback !== undefined) deps.surface.cancelFrame(store.player.frameCallback);
    store.player.frameCallback = undefined;
    deps.surface.detachUbuPlayer();
    store.stream.ubuplayer?.destroy?.();
    store.stream.ubuplayer = undefined;
    deps.time.clearTimeout(store.stream.hlsRecoveryTimer);
    deps.time.clearTimeout(store.stream.hlsNativeErrorTimer);
    store.stream.hlsNativeErrorTimer = undefined;
    store.stream.hlsRecoveryCount = 0;
    $('acceleration-help').hidden = true;
    store.player.frameStartedAt = undefined;
    store.player.noFramePlayingMs = 0;
    store.player.lastFrameCheckAt = undefined;
    store.player.videoFrames = 0;
    deps.time.presentation.reset();
    deps.dropVolume();
    deps.youtube?.destroy();
    deps.video.pause();
    deps.stopHls(reason);
    deps.video.removeAttribute('src');
    deps.video.removeAttribute('crossorigin');
    deps.video.load();
    store.stream.mediaVersion =
      store.stream.mediaSource =
      store.stream.readyVersion =
      store.stream.readinessSent =
        undefined;
    store.stream.readyQueued = false;
    store.player.playbackError = '';
    store.player.autoplayBlocked = false;
    $('join-playback').hidden = true;
    const isEnding = !!(store.room.state && !store.room.state.mediaUrl && store.room.state.ending);
    $('stage').classList.toggle('ending-active', isEnding);
    $('ending-stage').hidden = !isEnding;
    $('empty-stage').hidden = isEnding;
    if (isEnding) deps.renderEnding(store.room.state);
    $('ready-status').textContent = '';
  }
  function hlsClientConfig(next, cache) {
    const config = uburoomPlayback.hlsConfig(next.bitrate || next.bitrateCeiling, !!next.directHls, cache);
    if (next.directHls) {
      // FetchLoader rejects redirects and adds only this viewer's temporary
      // credential to resources under the pinned Plex output session.
      config.progressive = true;
      config.fetchSetup = (context, init) => {
        try {
          const url = new URL(context.url, location.href);
          const target =
            url.href === new URL(next.mediaUrl, location.href).href
              ? url.href
              : uburoomPlayback.directHlsUrl(url.href, next.directHls);
          return new Request(target, {
            ...init,
            credentials: url.origin === location.origin ? 'same-origin' : 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
          });
        } catch {
          return Promise.reject(new Error('Direct Plex resource unavailable'));
        }
      };
    }
    return config;
  }
  function unavailable(message, reason = 'room-unavailable') {
    deps.renderProviderNotice(false);
    deps.syncRoomUrl(null);
    deps.unavailableToasts();
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = undefined;
    store.connection.disconnectExtended = false;
    deps.hideDisconnectToast();
    store.connection.reconnecting = false;
    store.stream.qualityPending = false;
    deps.time.clock.reset();
    if ($('tracks-dialog').open) $('tracks-dialog').close();
    store.player.trackContext = undefined;
    clearPlayer(reason);
    deps.journal.clear();
    store.room.state = undefined;
    deps.renderBrowsing();
    deps.renderVisibility();
    deps.placeRoomBar();
    if (
      (reason === 'kicked' || reason === 'room-poll') &&
      !store.room.selected &&
      store.connection.transport?.ready &&
      !store.identity.me?.guestRoomId
    )
      void deps.refreshRooms?.().catch(() => {});
    deps.renderTransport();
    document.title = 'uburoom watch';
    deps.fail(message);
  }
  async function unlockLocal() {
    if (deps.youtube?.isActive()) return deps.youtube.unlock();
    const active = deps.activePlayer,
      surface = deps.surface;
    if (
      !store.room.state?.mediaUrl ||
      active.readyState() < 2 ||
      store.stream.probing ||
      store.player.playbackError ||
      store.player.sync.timelinePending
    )
      return false;
    const version = store.room.state.mediaVersion,
      source = store.stream.mediaSource;
    store.stream.probing = true;
    let playTimer;
    try {
      await Promise.race([
        active.play(),
        new Promise((resolve, reject) => {
          playTimer = deps.time.setTimeout(() => {
            if (store.room.state?.mediaVersion === version && store.stream.mediaSource === source) active.pause();
            reject(new DOMException('Playback is still buffering', 'AbortError'));
          }, 8500);
        }),
      ]);
      deps.time.clearTimeout(playTimer);
      if (
        (decodedFrames() === 0 || !surface.width()) &&
        store.room.state?.mediaVersion === version &&
        store.stream.mediaSource === source &&
        !surface.errorCode() &&
        !store.player.playbackError
      ) {
        await new Promise(resolve => {
          let waitTimer, frameId;
          const check = () => {
            if (
              (decodedFrames() > 0 && surface.width() > 0) ||
              store.room.state?.mediaVersion !== version ||
              store.stream.mediaSource !== source ||
              surface.errorCode() ||
              store.player.playbackError
            ) {
              finish();
              return;
            }
            if (surface.supportsFrameCallback()) {
              frameId = surface.requestFrame(check);
            }
          };
          const finish = () => {
            deps.time.clearTimeout(waitTimer);
            if (frameId !== undefined) surface.cancelFrame(frameId);
            for (const evt of ['loadeddata', 'canplay', 'playing', 'timeupdate', 'error'])
              surface.removeEventListener(evt, check);
            resolve();
          };
          waitTimer = deps.time.setTimeout(finish, 8500);
          for (const evt of ['loadeddata', 'canplay', 'playing', 'timeupdate', 'error'])
            surface.addEventListener(evt, check);
          if (surface.supportsFrameCallback()) {
            frameId = surface.requestFrame(check);
          } else {
            check();
          }
        });
      }
      if (store.room.state?.mediaVersion !== version || store.stream.mediaSource !== source) return false;
      const hasDecodedFrame = decodedFrames() > 0 && surface.width() > 0;
      if (!hasDecodedFrame && document.visibilityState === 'visible') {
        void deps.compatibleFallback('No video frames were decoded.');
        return false;
      }
      if (hasDecodedFrame) store.stream.readyVersion = version;
      store.player.autoplayBlocked = false;
      if (store.room.state.state.paused) active.pause();
      return true;
    } catch (error) {
      if (store.room.state?.mediaVersion === version && error.name === 'NotAllowedError')
        store.player.autoplayBlocked = true;
      return false;
    } finally {
      deps.time.clearTimeout(playTimer);
      store.stream.probing = false;
      deps.renderTransport();
    }
  }
  deps.surface.addEventListener('loadedmetadata', () => {
    void store.player.sync.synchronize();
  });
  deps.surface.addEventListener('canplay', () => {
    void store.player.sync.synchronize();
    if (store.room.state?.waitingForReady || store.room.state?.readiness) void deps.reportReadiness();
  });
  deps.surface.addEventListener('playing', () => {
    deps.time.clearTimeout(store.stream.hlsNativeErrorTimer);
    store.stream.hlsNativeErrorTimer = undefined;
  });
  deps.surface.addEventListener('seeked', () => {
    void store.player.sync.synchronize();
    if (store.room.state?.waitingForReady || store.room.state?.readiness) void deps.reportReadiness();
  });
  deps.video.addEventListener('error', () => {
    if (
      deps.surface.isUbuPlayer() ||
      !deps.video.getAttribute('src') ||
      !store.room.state?.mediaUrl ||
      !deps.video.error ||
      store.player.playbackError
    )
      return;
    const code = deps.video.error?.code,
      message = deps.video.error?.message || '';
    if (store.room.state.directDelivery && code === 2) {
      void deps.proxyDirectFile();
      return;
    }
    if ([3, 4].includes(code) && store.room.state.format === 'file') {
      void deps.compatibleFallback('The original video could not be decoded.');
      return;
    }
    if (
      [3, 4].includes(code) &&
      /kUnsupportedConfig|DECODER_ERROR_NOT_SUPPORTED|decoder.*(?:not supported|initialization failed)/i.test(message)
    ) {
      void deps.compatibleFallback('The video decoder is unsupported.');
      return;
    }
    // HLS manages recoverable media errors through its bounded handler; guard against silent stalls if hls.js never fires fatal MEDIA_ERROR.
    if (store.stream.hls && [3, 4].includes(code)) {
      const client = store.stream.hls;
      deps.time.clearTimeout(store.stream.hlsNativeErrorTimer);
      store.stream.hlsNativeErrorTimer = deps.time.setTimeout(() => {
        store.stream.hlsNativeErrorTimer = undefined;
        if (store.stream.hls === client && deps.video.error && !store.player.playbackError) {
          void deps.compatibleFallback('The video decoder could not play this stream.');
        }
      }, 2500);
      return;
    }
    if (uburoomPlayback.localFormat(store.room.state.format)) {
      void deps.compatibleFallback('The converted video could not be decoded.');
      return;
    }
    store.player.playbackError = 'Video could not play (media error ' + (code || 'unknown') + ').';
    deps.fail(store.player.playbackError);
  });
  $('enable-acceleration').addEventListener('click', async () => {
    if (!store.connection.sdk) return;
    try {
      await store.connection.sdk.commands.encourageHardwareAcceleration();
    } catch {
      deps.fail('Enable hardware acceleration in Discord Settings → Advanced, then reopen the Activity.');
    }
  });
  return {
    checkChoppyPlayback,
    checkVideoFrames,
    choppyDetector,
    clearPlayer,
    decodedFrames,
    hlsClientConfig,
    probePlaybackCapabilities,
    resetChoppyPlayback,
    unavailable,
    unlockLocal,
    viewerClient,
    watchFrames,
  };
}
