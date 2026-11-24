// @ts-check
/* MediaSurface: Unified stage presentation, intrinsic size, frame callback, and lifecycle
 * event contract across the native `<video id="video">` element and `<canvas id="ubuplayer-canvas">`.
 * Guarantees `#video` is genuinely `hidden = true` whenever `UbuPlayer` owns presentation,
 * and replaces `#ubuplayer-canvas` cleanly before every `transferControlToOffscreen()` session.
 */

const FORWARDED_EVENTS = [
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'seeking',
  'seeked',
  'ended',
  'error',
  'emptied',
  'loadstart',
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'abort',
  'ratechange',
  'timeupdate',
  'resize',
  'volumechange',
];

/**
 * @param {{
 *   video: HTMLVideoElement | any,
 *   stage?: HTMLElement | any,
 *   canvas?: HTMLCanvasElement | any,
 * }} options
 */
export function createMediaSurface({ video, stage, canvas: initialCanvas }) {
  const hostStage = stage || video?.parentElement || null;
  let currentCanvas =
    initialCanvas ||
    (typeof document !== 'undefined' && typeof document.getElementById === 'function'
      ? document.getElementById('ubuplayer-canvas')
      : null);
  let activeUbuPlayer = null;
  let ubuUnsubscribe = null;
  let nextFrameHandle = 1;
  /** @type {Map<number, {kind: 'ubu' | 'video', rawId: number}>} */
  const frameHandles = new Map();
  /** @type {Map<string, Set<(event?: any) => void>>} */
  const listeners = new Map();

  function dispatch(type, event) {
    const set = listeners.get(type);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(event || { type });
      } catch {}
    }
  }

  for (const type of FORWARDED_EVENTS) {
    video?.addEventListener?.(type, event => {
      if (activeUbuPlayer && !activeUbuPlayer.destroyed) return;
      dispatch(type, event);
    });
  }

  function createFreshCanvas() {
    if (typeof document === 'undefined' || typeof document.createElement !== 'function') return currentCanvas;
    const nextCanvas = document.createElement('canvas');
    nextCanvas.id = 'ubuplayer-canvas';
    nextCanvas.className = 'video ubuplayer-canvas';
    nextCanvas.hidden = true;
    if (typeof currentCanvas?.parentNode?.replaceChild === 'function') {
      currentCanvas.parentNode.replaceChild(nextCanvas, currentCanvas);
    } else if (typeof video?.after === 'function') {
      video.after(nextCanvas);
    } else if (hostStage?.prepend) {
      hostStage.prepend(nextCanvas);
    }
    currentCanvas = nextCanvas;
    return nextCanvas;
  }

  function isUbuPlayer() {
    return Boolean(activeUbuPlayer && !activeUbuPlayer.destroyed);
  }

  function cancelAllFrames() {
    for (const [, entry] of frameHandles) {
      try {
        if (entry.kind === 'ubu') activeUbuPlayer?.cancelVideoFrameCallback?.(entry.rawId);
        else video?.cancelVideoFrameCallback?.(entry.rawId);
      } catch {}
    }
    frameHandles.clear();
  }

  function detachUbuPlayer() {
    cancelAllFrames();
    if (ubuUnsubscribe) {
      ubuUnsubscribe();
      ubuUnsubscribe = null;
    }
    const hadUbuPlayer = Boolean(activeUbuPlayer);
    if (activeUbuPlayer) {
      const prev = activeUbuPlayer;
      activeUbuPlayer = null;
      prev.destroy?.();
    }
    if (hadUbuPlayer && currentCanvas) {
      createFreshCanvas();
    } else if (currentCanvas) {
      currentCanvas.hidden = true;
    }
    if (video) {
      video.hidden = false;
    }
  }

  /**
   * @template T
   * @param {(canvas: HTMLCanvasElement | null) => T} factory
   * @returns {T}
   */
  function attachUbuPlayer(factory) {
    detachUbuPlayer();
    const freshCanvas = createFreshCanvas();
    if (video) {
      video.pause?.();
      video.removeAttribute?.('src');
      video.removeAttribute?.('crossorigin');
      video.load?.();
      video.hidden = true;
    }
    if (freshCanvas) {
      freshCanvas.hidden = false;
    }
    const instance = factory(freshCanvas);
    activeUbuPlayer = instance;
    const cleanups = [];
    for (const type of FORWARDED_EVENTS) {
      const handler = ev => {
        if (activeUbuPlayer !== instance) return;
        dispatch(type, ev);
      };
      instance?.addEventListener?.(type, handler);
      cleanups.push(() => instance?.removeEventListener?.(type, handler));
    }
    ubuUnsubscribe = () => {
      for (const fn of cleanups) fn();
    };
    return instance;
  }

  return {
    isMediaSurface: true,
    videoElement: video,
    stageElement: () => hostStage || video?.parentElement || null,
    canvasElement: () => currentCanvas,
    activeElement: () => (isUbuPlayer() && currentCanvas ? currentCanvas : video),
    ubuplayer: () => (isUbuPlayer() ? activeUbuPlayer : undefined),
    isUbuPlayer,
    attachUbuPlayer,
    detachUbuPlayer,
    width: () => (isUbuPlayer() ? activeUbuPlayer.videoWidth || 0 : video?.videoWidth || 0),
    height: () => (isUbuPlayer() ? activeUbuPlayer.videoHeight || 0 : video?.videoHeight || 0),
    currentTime: () => (isUbuPlayer() ? activeUbuPlayer.currentTime : video?.currentTime || 0),
    readyState: () => (isUbuPlayer() ? activeUbuPlayer.readyState : video?.readyState || 0),
    paused: () => (isUbuPlayer() ? activeUbuPlayer.paused : Boolean(video?.paused ?? true)),
    ended: () => (isUbuPlayer() ? activeUbuPlayer.ended : Boolean(video?.ended)),
    seeking: () => (isUbuPlayer() ? activeUbuPlayer.seeking : Boolean(video?.seeking)),
    playbackRate: () => (isUbuPlayer() ? activeUbuPlayer.playbackRate : (video?.playbackRate ?? 1)),
    networkState: () => (isUbuPlayer() ? (activeUbuPlayer.readyState >= 1 ? 2 : 1) : (video?.networkState ?? 0)),
    errorCode: () => (isUbuPlayer() ? activeUbuPlayer.errorCode || undefined : video?.error?.code),
    buffered: () =>
      isUbuPlayer() ? activeUbuPlayer.buffered : video?.buffered || { length: 0, start: () => 0, end: () => 0 },
    playbackQuality: () =>
      isUbuPlayer() ? activeUbuPlayer.getVideoPlaybackQuality() : video?.getVideoPlaybackQuality?.(),
    supportsFrameCallback: () =>
      isUbuPlayer()
        ? typeof activeUbuPlayer.requestVideoFrameCallback === 'function'
        : typeof video?.requestVideoFrameCallback === 'function',
    requestFrame(callback) {
      if (typeof callback !== 'function') return undefined;
      if (isUbuPlayer() && typeof activeUbuPlayer.requestVideoFrameCallback === 'function') {
        const handle = nextFrameHandle++;
        const rawId = activeUbuPlayer.requestVideoFrameCallback((now, meta) => {
          frameHandles.delete(handle);
          callback(now, meta);
        });
        frameHandles.set(handle, { kind: 'ubu', rawId });
        return handle;
      }
      if (typeof video?.requestVideoFrameCallback === 'function') {
        const handle = nextFrameHandle++;
        const rawId = video.requestVideoFrameCallback((now, meta) => {
          frameHandles.delete(handle);
          callback(now, meta);
        });
        frameHandles.set(handle, { kind: 'video', rawId });
        return handle;
      }
      return undefined;
    },
    cancelFrame(handle) {
      if (handle === undefined) return;
      const entry = frameHandles.get(handle);
      if (!entry) return;
      frameHandles.delete(handle);
      try {
        if (entry.kind === 'ubu') activeUbuPlayer?.cancelVideoFrameCallback?.(entry.rawId);
        else video?.cancelVideoFrameCallback?.(entry.rawId);
      } catch {}
    },
    addEventListener(type, listener) {
      if (typeof listener !== 'function') return;
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    canRequestVideoPiP: () => !isUbuPlayer(),
    drawCurrentFrameTo(ctx2d) {
      const src = isUbuPlayer() ? currentCanvas : video;
      if (!src || !ctx2d) return false;
      try {
        ctx2d.drawImage(src, 0, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Normalize either a `MediaSurface` or a legacy `HTMLVideoElement`-like object into a surface view.
 * @param {any} target
 */
export function asMediaSurface(target) {
  if (target?.isMediaSurface) return target;
  return {
    isMediaSurface: true,
    videoElement: target,
    stageElement: () => target?.parentElement || null,
    canvasElement: () => null,
    activeElement: () => target,
    ubuplayer: () => undefined,
    isUbuPlayer: () => false,
    width: () => target?.videoWidth || 0,
    height: () => target?.videoHeight || 0,
    currentTime: () => target?.currentTime || 0,
    readyState: () => target?.readyState || 0,
    paused: () => Boolean(target?.paused ?? true),
    ended: () => Boolean(target?.ended),
    seeking: () => Boolean(target?.seeking),
    playbackRate: () => target?.playbackRate ?? 1,
    networkState: () => target?.networkState ?? 0,
    errorCode: () => target?.error?.code,
    buffered: () => target?.buffered || { length: 0, start: () => 0, end: () => 0 },
    playbackQuality: () => target?.getVideoPlaybackQuality?.(),
    supportsFrameCallback: () => typeof target?.requestVideoFrameCallback === 'function',
    requestFrame: cb => target?.requestVideoFrameCallback?.(cb),
    cancelFrame: id => target?.cancelVideoFrameCallback?.(id),
    addEventListener: (type, fn) => target?.addEventListener?.(type, fn),
    removeEventListener: (type, fn) => target?.removeEventListener?.(type, fn),
    canRequestVideoPiP: () => true,
    drawCurrentFrameTo(ctx2d) {
      if (!target || !ctx2d) return false;
      try {
        ctx2d.drawImage(target, 0, 0);
        return true;
      } catch {
        return false;
      }
    },
  };
}
