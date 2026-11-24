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
 * @property {boolean} [hasFrameEvidence] True when the player provides real decoded frame progression (false for cross-origin embeds such as YouTube).
 * @property {'ranges'|'state'} [bufferModel] Whether buffer readiness comes from seekable media ranges or abstract player state.
 * @property {boolean} [supportsRateSync] False when the player cannot honor micro-speed playback-rate nudges (e.g. YouTube IFrame).
 * @property {()=>boolean} [isAdPlaying] True while the viewer is held by a personal ad inside an embedded player.
 */

/**
 * @typedef {Object} UbuPlayerLike
 * @property {number|(()=>number)} readyState
 * @property {number|(()=>number)} currentTime
 * @property {number|(()=>number)} duration
 * @property {boolean|(()=>boolean)} paused
 * @property {boolean|(()=>boolean)} ended
 * @property {boolean|(()=>boolean)} seeking
 * @property {number|(()=>number)} playbackRate
 * @property {{length:number, start:(index:number)=>number, end:(index:number)=>number}} [buffered]
 * @property {(seconds:number)=>void} [seek]
 * @property {(rate:number)=>void} [setPlaybackRate]
 * @property {(volumeUnit:number, muted:boolean)=>void} [setAudio]
 * @property {number} [volume]
 * @property {boolean} [muted]
 * @property {()=>Promise<unknown>} play
 * @property {()=>void} pause
 * @property {(position:number)=>number} [bufferedAhead]
 * @property {(position:number, toleranceSeconds?:number)=>boolean} [isBufferedAt]
 * @property {(callback:(now:number, metadata:any)=>void)=>number} [requestVideoFrameCallback]
 * @property {(id:number)=>void} [cancelVideoFrameCallback]
 * @property {(type:string, listener:()=>void)=>void} [addEventListener]
 * @property {(type:string, listener:()=>void)=>void} [removeEventListener]
 */

function measureFirstFrame(target, getCurrentTime, isSeeking) {
  if (!target || typeof target.requestVideoFrameCallback !== 'function') return Promise.resolve(undefined);
  const began = globalThis.performance.now(),
    from = getCurrentTime();
  return new Promise(resolve => {
    let id, timer;
    const finish = value => {
      clearTimeout(timer);
      target.removeEventListener?.('pause', interrupt);
      target.removeEventListener?.('seeking', interrupt);
      try {
        target.cancelVideoFrameCallback?.(id);
      } catch {}
      resolve(value);
    };
    const interrupt = () => finish(undefined);
    const frame = (at, metadata) => {
      if (!isSeeking() && metadata?.mediaTime > from + 0.001) {
        const shown = Number.isFinite(metadata.expectedDisplayTime)
          ? metadata.expectedDisplayTime
          : Number.isFinite(metadata.presentationTime)
            ? metadata.presentationTime
            : at;
        finish(Math.max(0, shown - began));
      } else id = target.requestVideoFrameCallback(frame);
    };
    target.addEventListener?.('pause', interrupt);
    target.addEventListener?.('seeking', interrupt);
    timer = setTimeout(interrupt, 2000);
    id = target.requestVideoFrameCallback(frame);
  });
}

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
    hasFrameEvidence: true,
    bufferModel: 'ranges',
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
      return measureFirstFrame(
        video,
        () => (video ? video.currentTime : 0),
        () => Boolean(video?.seeking),
      );
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
 * Wrap a native WebCodecs + AudioWorklet + OffscreenCanvas `UbuPlayer` instance behind `PlayerAdapter`.
 * Reads playback time directly from `UbuPlayer`'s hardware audio output clock without any hidden `<video>`.
 * @param {UbuPlayerLike | null | undefined} ubuplayer
 * @param {{bufferedAhead?:(buffered:any, position:number)=>number}} [helpers]
 * @returns {PlayerAdapter}
 */
export function createUbuPlayerAdapter(ubuplayer, helpers = {}) {
  const aheadFn = helpers.bufferedAhead || computeBufferedAhead;
  const readNum = (field, fallback) => {
    if (!ubuplayer) return fallback;
    const value = typeof ubuplayer[field] === 'function' ? ubuplayer[field]() : ubuplayer[field];
    return typeof value === 'number' ? value : fallback;
  };
  const readBool = (field, fallback) => {
    if (!ubuplayer) return fallback;
    const value = typeof ubuplayer[field] === 'function' ? ubuplayer[field]() : ubuplayer[field];
    return value === undefined ? fallback : Boolean(value);
  };
  return {
    hasFrameEvidence: true,
    bufferModel: 'ranges',
    supportsRateSync: true,
    readyState: () => readNum('readyState', 0),
    currentTime: () => readNum('currentTime', 0),
    seek(seconds) {
      if (!ubuplayer || !Number.isFinite(seconds)) return;
      const clamped = Math.max(0, seconds);
      if (typeof ubuplayer.seek === 'function') ubuplayer.seek(clamped);
      else ubuplayer.currentTime = clamped;
    },
    duration: () => readNum('duration', NaN),
    paused: () => readBool('paused', true),
    ended: () => readBool('ended', false),
    seeking: () => readBool('seeking', false),
    playbackRate: () => readNum('playbackRate', 1),
    setPlaybackRate(rate) {
      if (!ubuplayer || !Number.isFinite(rate) || rate <= 0) return;
      if (typeof ubuplayer.setPlaybackRate === 'function') ubuplayer.setPlaybackRate(rate);
      else if (ubuplayer.playbackRate !== rate) ubuplayer.playbackRate = rate;
    },
    setAudio(volumeUnit, muted) {
      if (!ubuplayer) return;
      if (typeof ubuplayer.setAudio === 'function') {
        ubuplayer.setAudio(volumeUnit, muted);
        return;
      }
      if (Number.isFinite(volumeUnit)) ubuplayer.volume = Math.max(0, Math.min(1, volumeUnit));
      if (typeof muted === 'boolean') ubuplayer.muted = muted;
    },
    play: () => (ubuplayer ? ubuplayer.play() : Promise.resolve()),
    pause() {
      if (ubuplayer) ubuplayer.pause();
    },
    measureStart() {
      return measureFirstFrame(
        ubuplayer,
        () => readNum('currentTime', 0),
        () => readBool('seeking', false),
      );
    },
    bufferedAhead(position) {
      if (!ubuplayer) return 0;
      if (typeof ubuplayer.bufferedAhead === 'function') return ubuplayer.bufferedAhead(position);
      return ubuplayer.buffered ? aheadFn(ubuplayer.buffered, position) : 0;
    },
    isBufferedAt(position, toleranceSeconds = 0.05) {
      if (!ubuplayer) return false;
      if (typeof ubuplayer.isBufferedAt === 'function') return ubuplayer.isBufferedAt(position, toleranceSeconds);
      const buffered = ubuplayer.buffered;
      if (!buffered || !Number.isFinite(buffered.length)) return false;
      for (let i = 0; i < buffered.length; i++) {
        if (position >= buffered.start(i) - toleranceSeconds && position < buffered.end(i)) return true;
      }
      return false;
    },
  };
}

/**
 * Resolve either an explicit `PlayerAdapter`, a `UbuPlayer` instance, or an `HTMLMediaElement`-like `video`.
 * @param {{player?:PlayerAdapter, ubuplayer?:UbuPlayerLike, video?:any, playback?:{bufferedAhead?:(buffered:any, position:number)=>number}}} host
 * @returns {PlayerAdapter}
 */
export function normalizePlayerAdapter(host) {
  if (host?.player) return host.player;
  if (host?.ubuplayer) return createUbuPlayerAdapter(host.ubuplayer, { bufferedAhead: host.playback?.bufferedAhead });
  if (host && 'video' in host)
    return createVideoElementAdapter(host.video, { bufferedAhead: host.playback?.bufferedAhead });
  throw new Error('Synchronization requires a player adapter or video element');
}
