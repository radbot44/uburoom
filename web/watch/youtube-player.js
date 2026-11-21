import { createYouTubePlayerAdapter } from '../../shared/sync/player-adapter.mjs';
import { $ } from './page.js';
import { store } from './store.js';

let apiPromise;

function loadYouTubeApi() {
  if (typeof window === 'undefined') return Promise.reject(new Error('YouTube IFrame player requires a browser'));
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;

  apiPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiPromise = undefined;
      reject(new Error('Could not load the YouTube player. Check your connection or ad blocker.'));
    }, 15000);

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timer);
      if (typeof previous === 'function') {
        try {
          previous();
        } catch {}
      }
      if (window.YT?.Player) resolve(window.YT);
      else {
        apiPromise = undefined;
        reject(new Error('YouTube player API did not initialize.'));
      }
    };

    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => {
        clearTimeout(timer);
        apiPromise = undefined;
        reject(new Error('Could not load the YouTube player. Check your connection or ad blocker.'));
      };
      document.head.append(script);
    }
  });

  return apiPromise;
}

function configureIframe(player) {
  try {
    const iframe = player?.getIframe?.();
    if (!iframe) return;
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.setAttribute('tabindex', '-1');
    iframe.setAttribute('title', 'YouTube video player');
  } catch {}
}

function errorMessageFor(code) {
  if (code === 101 || code === 150) {
    return 'This YouTube video cannot be played in an embedded player (embedding disabled by owner).';
  }
  if (code === 100) return 'This YouTube video was removed or is private.';
  if (code === 153) return 'YouTube rejected the embedded player (missing Referrer header).';
  if (code === 2) return 'Invalid YouTube video ID.';
  if (code === 5) return 'The browser HTML5 player encountered an error playing this YouTube video.';
  return 'YouTube embedded player error (' + (code || 'unknown') + ').';
}

/* YouTube IFrame Embed controller: lazy API loading, PlayerAdapter bridge, ad fencing, error mapping, and stage shield. */
export function mount(host, deps) {
  let active = false,
    ready = false,
    unlocked = false,
    seeking = false,
    adPlaying = false,
    errorCode = 0,
    generation = 0;
  let ytPlayer = null,
    currentVideoId = '',
    currentWatchUrl = '',
    currentMediaVersion = '';
  let progressTicks = 0,
    lastAdvancingTime = 0,
    frozenPlayingMs = 0,
    lastSampleMono = 0;
  let seekResetTimer,
    clickTimer,
    pendingPlay = null;

  const controller = {
    isReady: () => active && ready && !errorCode,
    isSeeking: () => active && seeking,
    isAdPlaying: () => active && adPlaying,
    hasUnlocked: () => unlocked,
    getPlayerState() {
      try {
        return active && ready && ytPlayer ? (ytPlayer.getPlayerState?.() ?? -1) : -1;
      } catch {
        return -1;
      }
    },
    getCurrentTime() {
      try {
        const value = active && ready && ytPlayer ? Number(ytPlayer.getCurrentTime?.()) : 0;
        return Number.isFinite(value) && value >= 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    getDuration() {
      try {
        const value = active && ready && ytPlayer ? Number(ytPlayer.getDuration?.()) : 0;
        return Number.isFinite(value) && value > 0 ? value : 0;
      } catch {
        return 0;
      }
    },
    getVideoLoadedFraction() {
      try {
        const value = active && ready && ytPlayer ? Number(ytPlayer.getVideoLoadedFraction?.()) : 0;
        return Number.isFinite(value) && value >= 0 ? Math.min(1, value) : 0;
      } catch {
        return 0;
      }
    },
    seek(seconds) {
      if (!active || !ready || !ytPlayer) return;
      const target = Math.max(0, Number(seconds) || 0);
      seeking = true;
      lastAdvancingTime = target;
      frozenPlayingMs = 0;
      deps.time.clearTimeout(seekResetTimer);
      seekResetTimer = deps.time.setTimeout(() => {
        seeking = false;
      }, 1200);
      try {
        ytPlayer.seekTo?.(target, true);
      } catch {
        seeking = false;
      }
    },
    play() {
      if (!active || !ready || !ytPlayer) return Promise.resolve();
      if (pendingPlay) return pendingPlay.promise;
      let resolvePlay, rejectPlay;
      const promise = new Promise((resolve, reject) => {
        resolvePlay = resolve;
        rejectPlay = reject;
      });
      const timer = deps.time.setTimeout(() => {
        if (pendingPlay?.promise === promise) {
          pendingPlay = null;
          resolvePlay();
        }
      }, 3000);
      pendingPlay = {
        promise,
        resolve: () => {
          deps.time.clearTimeout(timer);
          if (pendingPlay?.promise === promise) pendingPlay = null;
          resolvePlay();
        },
        reject: err => {
          deps.time.clearTimeout(timer);
          if (pendingPlay?.promise === promise) pendingPlay = null;
          rejectPlay(err);
        },
      };
      try {
        ytPlayer.playVideo?.();
      } catch (err) {
        pendingPlay?.reject(err);
      }
      return promise;
    },
    pauseVideo() {
      try {
        ytPlayer?.pauseVideo?.();
      } catch {}
    },
    setVolume(percent) {
      try {
        ytPlayer?.setVolume?.(percent);
      } catch {}
    },
    mute() {
      try {
        ytPlayer?.mute?.();
      } catch {}
    },
    unMute() {
      try {
        ytPlayer?.unMute?.();
      } catch {}
    },
  };

  const adapter = createYouTubePlayerAdapter(controller);

  function sampleTick() {
    if (!active || !ready || !ytPlayer || errorCode) return;
    const now = deps.time.mono(),
      dt = lastSampleMono > 0 ? Math.max(0, Math.min(1000, now - lastSampleMono)) : 250;
    lastSampleMono = now;

    const state = controller.getPlayerState(),
      currentTime = controller.getCurrentTime(),
      ytDuration = controller.getDuration();
    let videoDataId = '';
    try {
      videoDataId = ytPlayer.getVideoData?.()?.video_id || '';
    } catch {}

    if (seeking && (state === 1 || state === 2 || state === 0)) {
      seeking = false;
      deps.time.clearTimeout(seekResetTimer);
    }

    if (state === 1 && !seeking) {
      if (currentTime > lastAdvancingTime + 0.01) frozenPlayingMs = 0;
      else frozenPlayingMs += dt;
    } else {
      frozenPlayingMs = 0;
    }

    const roomDuration = Number(store.room.state?.state?.duration) || 0;
    const roomDurationUnknown = Boolean(store.room.state?.durationUnknown);
    const roomPaused = Boolean(store.room.state?.state?.paused);
    const wrongVideoId = Boolean(videoDataId && currentVideoId && videoDataId !== currentVideoId);
    const wrongDuration =
      roomDuration > 0 &&
      !roomDurationUnknown &&
      ytDuration > 0 &&
      Math.abs(ytDuration - roomDuration) > Math.max(5, roomDuration * 0.15);
    const frozenStart = state === 1 && !roomPaused && frozenPlayingMs > 2500;
    const nextAdPlaying =
      wrongVideoId || ((state === 1 || state === 3 || state === -1) && wrongDuration) || frozenStart;

    if (nextAdPlaying && !adPlaying) {
      adPlaying = true;
      $('youtube-stage')?.classList.add('ad-playing');
      deps.renderTransport?.();
      void deps.reportObservation?.(false);
    } else if (!nextAdPlaying && adPlaying) {
      if ((state === 1 && currentTime > lastAdvancingTime + 0.01) || state === 2 || state === 0) {
        adPlaying = false;
        $('youtube-stage')?.classList.remove('ad-playing');
        const target = deps.expected?.();
        if (Number.isFinite(target) && Math.abs(target - currentTime) > 0.35) controller.seek(target);
        deps.renderTransport?.();
        void store.player.sync?.synchronize();
      }
    }

    if (state === 1 && !adPlaying && !seeking) {
      const delta = currentTime - lastAdvancingTime;
      if (delta > 0.01 && delta < 3) {
        progressTicks += Math.max(1, Math.round(delta * 24));
        unlocked = true;
      }
      if (delta > 0.01 || delta < -0.1) lastAdvancingTime = currentTime;
    } else {
      lastAdvancingTime = currentTime;
    }

    if (store.room.state?.durationUnknown && !adPlaying && ytDuration >= 1) {
      void deps.reportReadiness?.();
    }
  }

  deps.every(250, sampleTick);

  function attach(next) {
    const videoId = next?.embed?.videoId || '';
    const watchUrl = next?.embed?.watchUrl || (videoId ? 'https://www.youtube.com/watch?v=' + videoId : '');
    destroy();
    if (!videoId) return;

    active = true;
    currentVideoId = videoId;
    currentWatchUrl = watchUrl;
    currentMediaVersion = next.mediaVersion;
    const gen = ++generation;

    if (deps.activity) {
      errorCode = 150;
      const msg =
        'YouTube embedded playback is blocked inside Discord Activity. Open this room in your browser to watch.';
      store.player.playbackError = msg;
      if (store.identity.config?.access?.publicWeb !== false) {
        deps.toasts?.show('youtube-activity', {
          type: 'error',
          title: 'YouTube embed requires a browser',
          hint: 'Discord Activity blocks external YouTube players.',
          symbol: 'open',
          persistent: true,
          action: {
            label: 'Open in Browser',
            run: () => void deps.openInBrowser?.(),
          },
        });
      }
      deps.fail?.(msg);
      deps.renderTransport?.();
      return;
    }

    $('stage')?.classList.add('youtube-embed-active');
    const stageEl = $('youtube-stage');
    if (stageEl) stageEl.hidden = false;

    void loadYouTubeApi()
      .then(YT => {
        if (gen !== generation || !active) return;
        const mountEl = $('youtube-mount');
        if (!mountEl) return;
        mountEl.replaceChildren();
        const slot = document.createElement('div');
        mountEl.append(slot);

        ytPlayer = new YT.Player(slot, {
          videoId,
          host: 'https://www.youtube.com',
          width: '100%',
          height: '100%',
          playerVars: {
            autoplay: 0,
            controls: 0,
            disablekb: 1,
            fs: 0,
            iv_load_policy: 3,
            modestbranding: 1,
            playsinline: 1,
            rel: 0,
            enablejsapi: 1,
            origin: location.origin,
          },
          events: {
            onReady() {
              if (gen !== generation || !active) return;
              configureIframe(ytPlayer);
              ready = true;
              lastSampleMono = deps.time.mono();
              const vol = (store.room.state?.state?.volume ?? store.preferences.playerPreferences?.volume ?? 30) / 100;
              const muted = Boolean(store.room.state?.state?.muted ?? store.preferences.playerPreferences?.muted);
              adapter.setAudio(vol, muted);
              void store.player.sync?.synchronize();
              void deps.reportReadiness?.();
            },
            onStateChange(event) {
              if (gen !== generation || !active) return;
              const state = event?.data;
              if (state === 1) {
                seeking = false;
                deps.time.clearTimeout(seekResetTimer);
                store.player.playerWaiting = false;
                store.player.autoplayBlocked = false;
                unlocked = true;
                progressTicks = Math.max(1, progressTicks);
                pendingPlay?.resolve();
                store.player.lastPresentationBreak = deps.time.mono();
                store.player.sync?.event('playing');
                void deps.reportObservation?.(false);
                void deps.reportReadiness?.();
                void store.player.sync?.synchronize();
              } else if (state === 2) {
                seeking = false;
                deps.time.clearTimeout(seekResetTimer);
                store.player.playerWaiting = false;
                deps.syncQuality?.breakSample();
                store.player.observationBreak++;
                store.player.lastPresentationBreak = deps.time.mono();
                store.player.sync?.event('pause');
                void deps.reportObservation?.(false);
              } else if (state === 3) {
                store.player.playerWaiting = true;
                deps.syncQuality?.breakSample();
                store.player.observationBreak++;
                store.player.lastPresentationBreak = deps.time.mono();
                store.player.sync?.event('waiting');
                void deps.reportObservation?.(
                  !adPlaying &&
                    store.room.state?.pauseOnBuffering === true &&
                    store.room.state.state.paused === false &&
                    !seeking &&
                    !store.stream.probing,
                );
              } else if (state === 0) {
                seeking = false;
                deps.time.clearTimeout(seekResetTimer);
                store.player.playerWaiting = false;
                deps.syncQuality?.breakSample();
                store.player.sync?.event('ended');
                void deps.reportObservation?.(false);
                void store.player.sync?.synchronize();
              } else if (state === 5) {
                void store.player.sync?.synchronize();
                void deps.reportReadiness?.();
              }
            },
            onAutoplayBlocked() {
              if (gen !== generation || !active) return;
              store.player.autoplayBlocked = true;
              pendingPlay?.reject(new DOMException('Autoplay blocked by browser', 'NotAllowedError'));
              void deps.reportObservation?.(false);
              deps.renderTransport?.();
            },
            onError(event) {
              if (gen !== generation || !active) return;
              const code = Number(event?.data) || 5;
              errorCode = code;
              store.player.playerWaiting = false;
              deps.syncQuality?.breakSample();
              store.player.observationBreak++;
              const message = errorMessageFor(code);
              store.player.playbackError = message;
              if ((code === 101 || code === 150) && currentWatchUrl) {
                const urlToOpen = currentWatchUrl;
                deps.toasts?.show('youtube-embed-error', {
                  type: 'error',
                  title: 'Video owner disabled embedding',
                  hint: 'This YouTube video can only be watched on YouTube directly.',
                  symbol: 'open',
                  persistent: true,
                  action: {
                    label: 'Open on YouTube',
                    run: () => {
                      window.open(urlToOpen, '_blank', 'noopener,noreferrer');
                    },
                  },
                });
              }
              deps.fail?.(message);
              void deps.reportObservation?.(false);
              deps.renderTransport?.();
            },
          },
        });
        configureIframe(ytPlayer);
      })
      .catch(error => {
        if (gen !== generation || !active) return;
        errorCode = 500;
        store.player.playbackError = error.message || 'Could not load the YouTube player.';
        deps.fail?.(store.player.playbackError);
        deps.renderTransport?.();
      });
  }

  async function unlock() {
    if (!active || !ready || !ytPlayer || store.stream.probing || store.player.playbackError) return false;
    const version = currentMediaVersion;
    store.stream.probing = true;
    try {
      await controller.play();
      if (!active || currentMediaVersion !== version || errorCode) return false;
      unlocked = true;
      progressTicks = Math.max(1, progressTicks);
      store.stream.readyVersion = version;
      store.player.autoplayBlocked = false;
      if (store.room.state?.state?.paused) controller.pauseVideo();
      return true;
    } catch (error) {
      if (active && currentMediaVersion === version && error?.name === 'NotAllowedError') {
        store.player.autoplayBlocked = true;
      }
      return false;
    } finally {
      store.stream.probing = false;
      deps.renderTransport?.();
    }
  }

  function destroy() {
    generation++;
    active = false;
    ready = false;
    unlocked = false;
    seeking = false;
    adPlaying = false;
    errorCode = 0;
    currentVideoId = '';
    currentWatchUrl = '';
    currentMediaVersion = '';
    progressTicks = 0;
    lastAdvancingTime = 0;
    frozenPlayingMs = 0;
    lastSampleMono = 0;
    deps.time.clearTimeout(seekResetTimer);
    deps.time.clearTimeout(clickTimer);
    if (pendingPlay) {
      pendingPlay.resolve();
      pendingPlay = null;
    }
    if (ytPlayer) {
      try {
        ytPlayer.destroy?.();
      } catch {}
      ytPlayer = null;
    }
    const mountEl = $('youtube-mount');
    if (mountEl) mountEl.replaceChildren();
    const stageEl = $('youtube-stage');
    if (stageEl) {
      stageEl.hidden = true;
      stageEl.classList.remove('ad-playing');
    }
    $('stage')?.classList.remove('youtube-embed-active');
    deps.toasts?.dismiss('youtube-embed-error', false);
    deps.toasts?.dismiss('youtube-activity', false);
  }

  function bufferedRanges() {
    const duration = controller.getDuration(),
      fraction = controller.getVideoLoadedFraction();
    if (!active || !ready || !(duration > 0) || !(fraction > 0)) {
      return { length: 0, start: () => 0, end: () => 0 };
    }
    const end = Math.min(duration, fraction * duration);
    return {
      length: end > 0 ? 1 : 0,
      start: () => 0,
      end: () => end,
    };
  }

  const shield = $('youtube-shield');
  if (shield) {
    shield.addEventListener('click', event => {
      if (!active || event.button !== 0) return;
      deps.time.clearTimeout(clickTimer);
      clickTimer = deps.time.setTimeout(() => {
        if (!active) return;
        if (store.player.autoplayBlocked && !$('join-playback')?.disabled) {
          $('join-playback')?.click();
        } else if (!$('player-play')?.disabled) {
          $('player-play')?.click();
        } else {
          store.player.playerUI?.showChrome?.();
        }
      }, 220);
    });
    shield.addEventListener('dblclick', event => {
      if (!active) return;
      event.preventDefault();
      deps.time.clearTimeout(clickTimer);
      if (!$('fullscreen')?.hidden && !$('fullscreen')?.disabled) {
        $('fullscreen')?.click();
      }
    });
  }

  return {
    adapter,
    attach,
    bufferedRanges,
    destroy,
    errorCode: () => (active && errorCode ? errorCode : 0),
    frames: () => (active ? progressTicks : 0),
    isActive: () => active,
    isAdPlaying: () => active && adPlaying,
    unlock,
  };
}
