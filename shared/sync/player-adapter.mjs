// @ts-check
/* Media-agnostic client playback adapter for shared synchronization control. */
import { bufferedAhead as computeBufferedAhead } from './timing.mjs';

/**
 * @typedef {Object} PlayerAdapter
 * @property {()=>number} readyState Media readiness level (0=empty, 1=metadata, 2=current frame, 3+=future data).
 * @property {()=>number} currentTime Current playback position in seconds.
 * @property {(seconds:number)=>void} seek Jump local playback position in seconds.
 * @property {()=>number} duration Known media duration in seconds, or NaN/undefined when unknown.
 * @property {()=>boolean} paused Whether local playback is currently paused.
 * @property {()=>boolean} ended Whether local playback reached media end.
 * @property {()=>boolean} seeking Whether an asynchronous seek is currently in flight.
 * @property {()=>number} playbackRate Current playback speed multiplier (1 = nominal).
 * @property {(rate:number)=>void} setPlaybackRate Set local playback speed multiplier.
 * @property {(volumeUnit:number, muted:boolean)=>void} setAudio Apply normalized volume [0..1] and mute state.
 * @property {()=>Promise<unknown>} play Start or resume local playback.
 * @property {()=>void} pause Pause local playback.
 * @property {(position:number)=>number} bufferedAhead Contiguous buffered seconds ahead of position.
 * @property {()=>Promise<number|undefined>} [measureStart] Call just before play(). Resolves with milliseconds from the call to the first presented frame that advanced past the position at the call, or undefined when unsupported, interrupted (pause, seek) or not seen within 2 s.
 * @property {(position:number, toleranceSeconds?:number)=>boolean} isBufferedAt Whether position lies inside any buffered range.
 * @property {boolean} [supportsRateSync] False when the player cannot honor micro-speed playback-rate nudges (e.g. YouTube IFrame).
 * @property {()=>boolean} [isAdPlaying] True while the viewer is held by a personal ad inside an embedded player.
 */

/**
 * Wrap an HTMLMediaElement-compatible object behind the abstract PlayerAdapter interface.
 * Preserves direct property reads and writes on `video` for full DOM and test compatibility.
 * @param {{
 *   readyState:number, currentTime:number, duration:number, paused:boolean, ended:boolean,
 *   seeking:boolean, playbackRate:number, volume:number, muted:boolean,
 *   buffered:{length:number, start:(index:number)=>number, end:(index:number)=>number},
 *   play:()=>Promise<unknown>, pause:()=>void,
 *   requestVideoFrameCallback?:(callback:(now:number, metadata:any)=>void)=>number,
 *   cancelVideoFrameCallback?:(id:number)=>void,
 *   addEventListener?:(type:string, listener:()=>void)=>void,
 *   removeEventListener?:(type:string, listener:()=>void)=>void
 * }} video
 * @param {{bufferedAhead?:(buffered:any, position:number)=>number}} [helpers]
 * @returns {PlayerAdapter}
 */
export function createVideoElementAdapter(video, helpers = {}) {
  const aheadFn = helpers.bufferedAhead || computeBufferedAhead;
  return {
    readyState: () => (video ? video.readyState : 0),
    currentTime: () => (video ? video.currentTime : 0),
    seek(seconds) {
      if (video) video.currentTime = seconds;
    },
    duration: () => (video ? video.duration : NaN),
    paused: () => (video ? video.paused : true),
    ended: () => (video ? Boolean(video.ended) : false),
    seeking: () => (video ? Boolean(video.seeking) : false),
    playbackRate: () => (video ? video.playbackRate : 1),
    setPlaybackRate(rate) {
      if (video && video.playbackRate !== rate) video.playbackRate = rate;
    },
    setAudio(volumeUnit, muted) {
      if (!video) return;
      if (Number.isFinite(volumeUnit)) video.volume = volumeUnit;
      if (typeof muted === 'boolean') video.muted = muted;
    },
    play: () => (video ? video.play() : Promise.resolve()),
    pause() {
      if (video) video.pause();
    },
    measureStart() {
      if (!video || typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve(undefined);
      const began = globalThis.performance.now(),
        from = video.currentTime;
      return new Promise(resolve => {
        let id, timer;
        const finish = value => {
          clearTimeout(timer);
          video.removeEventListener?.('pause', interrupt);
          video.removeEventListener?.('seeking', interrupt);
          try {
            video.cancelVideoFrameCallback?.(id);
          } catch {}
          resolve(value);
        };
        const interrupt = () => finish(undefined);
        const frame = (at, metadata) => {
          if (metadata?.mediaTime > from + 0.001) {
            const shown = Number.isFinite(metadata.presentationTime) ? metadata.presentationTime : at;
            finish(Math.max(0, shown - began));
          } else id = video.requestVideoFrameCallback(frame);
        };
        video.addEventListener?.('pause', interrupt);
        video.addEventListener?.('seeking', interrupt);
        timer = setTimeout(interrupt, 2000);
        id = video.requestVideoFrameCallback(frame);
      });
    },
    bufferedAhead: position => (video ? aheadFn(video.buffered, position) : 0),
    isBufferedAt(position, toleranceSeconds = 0.05) {
      const buffered = video?.buffered;
      if (!buffered || !Number.isFinite(buffered.length)) return false;
      for (let i = 0; i < buffered.length; i++) {
        if (position >= buffered.start(i) - toleranceSeconds && position < buffered.end(i)) return true;
      }
      return false;
    },
  };
}

/**
 * Wrap a YouTube IFrame Player (or controller around YT.Player) behind PlayerAdapter.
 * Disables rate-based drift nudges (YouTube rounds decimal rates back to 1) and exposes
 * optional ad-hold detection so personal viewer ads do not fight sync or pause the room.
 * @param {{
 *   getPlayerState?:()=>number,
 *   getCurrentTime?:()=>number,
 *   getDuration?:()=>number,
 *   getVideoLoadedFraction?:()=>number,
 *   seekTo?:(seconds:number, allowSeekAhead?:boolean)=>void,
 *   playVideo?:()=>void,
 *   pauseVideo?:()=>void,
 *   setVolume?:(volumePercent:number)=>void,
 *   mute?:()=>void,
 *   unMute?:()=>void,
 *   isReady?:()=>boolean,
 *   isSeeking?:()=>boolean,
 *   isAdPlaying?:()=>boolean,
 *   hasUnlocked?:()=>boolean,
 *   play?:()=>Promise<unknown>,
 *   seek?:(seconds:number)=>void
 * }} controller
 * @returns {PlayerAdapter}
 */
export function createYouTubePlayerAdapter(controller) {
  const bufferedAhead = position => {
    const duration = Number(controller?.getDuration?.());
    const fraction = Number(controller?.getVideoLoadedFraction?.());
    if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(fraction) || fraction <= 0) return 0;
    return Math.max(0, fraction * duration - (Number.isFinite(position) ? position : 0));
  };
  let lastVolume, lastMuted;
  return {
    supportsRateSync: false,
    isAdPlaying: () => Boolean(controller?.isAdPlaying?.()),
    readyState() {
      if (!controller || (controller.isReady && !controller.isReady())) return 0;
      if (controller.isAdPlaying?.()) return 2;
      const state = controller.getPlayerState?.();
      if (state === 1 || state === 0) return 4;
      if (state === 2) return controller.hasUnlocked?.() === false ? 2 : 4;
      return 2;
    },
    currentTime() {
      const value = Number(controller?.getCurrentTime?.());
      return Number.isFinite(value) && value >= 0 ? value : 0;
    },
    seek(seconds) {
      if (!controller) return;
      if (typeof controller.seek === 'function') controller.seek(seconds);
      else controller.seekTo?.(seconds, true);
    },
    duration() {
      const value = Number(controller?.getDuration?.());
      return Number.isFinite(value) && value > 0 ? value : NaN;
    },
    paused() {
      const state = controller?.getPlayerState?.();
      return state !== 1 && state !== 3;
    },
    ended: () => controller?.getPlayerState?.() === 0,
    seeking: () => Boolean(controller?.isSeeking?.()),
    playbackRate: () => 1,
    setPlaybackRate(_rate) {},
    setAudio(volumeUnit, muted) {
      if (!controller) return;
      if (Number.isFinite(volumeUnit)) {
        const percent = Math.max(0, Math.min(100, Math.round(volumeUnit * 100)));
        if (percent !== lastVolume) {
          lastVolume = percent;
          controller.setVolume?.(percent);
        }
      }
      if (typeof muted === 'boolean' && muted !== lastMuted) {
        lastMuted = muted;
        if (muted) controller.mute?.();
        else controller.unMute?.();
      }
    },
    play() {
      if (!controller) return Promise.resolve();
      if (typeof controller.play === 'function') return controller.play();
      controller.playVideo?.();
      return Promise.resolve();
    },
    pause() {
      controller?.pauseVideo?.();
    },
    bufferedAhead,
    isBufferedAt: (position, toleranceSeconds = 0.05) =>
      bufferedAhead(Math.max(0, (Number.isFinite(position) ? position : 0) - toleranceSeconds)) > 0,
  };
}

/**
 * Resolve either an explicit `PlayerAdapter` or an `HTMLMediaElement`-like `video`.
 * @param {{player?:PlayerAdapter, video?:any, playback?:{bufferedAhead?:(buffered:any, position:number)=>number}}} host
 * @returns {PlayerAdapter}
 */
export function normalizePlayerAdapter(host) {
  if (host?.player) return host.player;
  if (host && 'video' in host)
    return createVideoElementAdapter(host.video, { bufferedAhead: host.playback?.bufferedAhead });
  throw new Error('Synchronization requires a player adapter or video element');
}
