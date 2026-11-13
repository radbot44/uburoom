import * as uburoomFallback from '../watch-fallback.js';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomStreams from '../watch-streams.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Delivery and fallback: the compatible-stream fallback, direct files and their proxy, and holding the current stream while a quality change prepares the next one. */
export function mount(host, deps) {
  async function compatibleFallback(reason, preferHLS = false) {
    if (fallbackPlayback.active && fallbackPlayback.failed()) return;
    if (!store.room.state?.mediaUrl || store.room.state.mediaId === 'demo' || store.stream.fallbackPending) return;
    // Plex would hand a file the browser already failed on the same H.264 again.
    const skipPlex =
      !preferHLS && store.room.state.format === 'file' && /^(h264|avc1)$/i.test(store.room.state.videoCodec || '');
    if (store.room.pending || store.stream.qualityPending) {
      if (store.stream.fallbackRetryTimer) return;
      const id = store.room.selected,
        version = store.room.state.mediaVersion,
        stream = store.room.state.streamVersion;
      store.stream.fallbackRetryTimer = deps.time.setTimeout(() => {
        store.stream.fallbackRetryTimer = undefined;
        if (
          store.room.selected === id &&
          store.room.state?.mediaVersion === version &&
          store.room.state?.streamVersion === stream
        )
          void compatibleFallback(reason, preferHLS);
      }, 200);
      return;
    }
    if (store.stream.localFallbackVersion !== store.room.state.mediaVersion) {
      store.stream.localFallbackVersion = store.room.state.mediaVersion;
      store.stream.localFallbackAttempts = new Set();
    }
    if (uburoomPlayback.localFormat(store.room.state.format))
      store.stream.localFallbackAttempts.add(store.room.state.format);
    if (store.room.state.format === 'hls') store.stream.localFallbackAttempts.add('plex');
    const localCandidates = uburoomPlayback.fallbackCodecs(
      store.identity.config.localFormats || ['av1'],
      store.stream.localFallbackAttempts,
      mime => typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime),
    );
    const order = store.identity.config.outputs || [...localCandidates, 'plex'];
    const candidates = order.filter(output =>
      output === 'plex'
        ? !skipPlex && !store.stream.localFallbackAttempts.has('plex')
        : localCandidates.includes(output),
    );
    // H.264 or browser-supported HEVC with unplayable audio needs no new picture: Plex can copy the video and convert only the audio.
    const canCopyVideo =
      /^(h264|avc1|hevc|h265|hvc1|hev1)$/i.test(store.room.state.videoCodec || '') &&
      !uburoomPlayback.needsVideoConversion(store.room.state, type => deps.video.canPlayType(type));
    if (
      preferHLS &&
      order.includes('plex') &&
      canCopyVideo &&
      !store.stream.localFallbackAttempts.has('audio') &&
      !store.stream.localFallbackAttempts.has('plex')
    )
      candidates.unshift('audio');
    if (!candidates.length) {
      store.stream.av1?.destroy();
      store.stream.av1 = undefined;
      deps.video.pause();
      store.player.playbackError =
        reason + ' No remaining compatible conversion is available. Check the server codec/encoder settings.';
      $('acceleration-help').hidden = !deps.activity;
      $('enable-acceleration').hidden = !store.connection.sdk;
      deps.fail(store.player.playbackError);
      return;
    }
    const id = store.room.selected,
      version = store.room.state.mediaVersion;
    store.stream.fallbackPending = true;
    deps.diagnosticSample('fallback');
    store.stream.av1?.destroy();
    store.stream.av1 = undefined;
    deps.stopHls('fallback');
    try {
      for (const codec of candidates) {
        if (store.room.selected !== id || store.room.state?.mediaVersion !== version) return;
        store.stream.localFallbackAttempts.add(codec);
        try {
          await deps.execute({
            action: 'media.quality.set',
            args: {
              quality:
                store.room.state.preferredQuality || store.preferences.preferredQuality || store.room.state.quality,
              ...(codec === 'audio' ? {} : { compatible: true }),
              fallback: codec,
              reason: [reason, store.stream.fallbackDetail].filter(Boolean).join(' '),
            },
          });
          return;
        } catch (error) {
          store.player.playbackError =
            reason +
            ' ' +
            (['plex', 'audio'].includes(codec) ? 'Plex' : codec.toUpperCase()) +
            ' fallback failed: ' +
            error.message;
        }
      }
      deps.fail(store.player.playbackError);
    } finally {
      store.stream.fallbackPending = false;
    }
  }
  async function proxyDirectFile() {
    if (!store.room.state?.directDelivery || store.stream.directRecovery || !navigator.onLine) return;
    const next = store.room.state,
      id = store.room.selected;
    const recovery = (async () => {
      try {
        await deps.call('room.delivery', {
          roomId: id,
          args: {
            viewerId: store.identity.viewerId,
            mediaVersion: next.mediaVersion,
            streamVersion: next.streamVersion,
          },
        });
        if (store.room.selected === id && store.room.state?.mediaVersion === next.mediaVersion)
          await deps.refreshState();
      } catch {
        if (store.room.selected === id && store.room.state?.streamVersion === next.streamVersion)
          deps.fail('Video delivery could not recover. Try joining the room again.');
      }
    })();
    store.stream.directRecovery = recovery;
    try {
      await recovery;
    } finally {
      if (store.stream.directRecovery === recovery) store.stream.directRecovery = undefined;
    }
  }
  async function attachDirectFile(next) {
    const controller = (store.stream.directProbe = new AbortController());
    const current = () =>
      !controller.signal.aborted &&
      store.room.selected === next.id &&
      store.room.state?.streamVersion === next.streamVersion &&
      store.stream.mediaSource === next.mediaUrl;
    try {
      // Prove CORS/range delivery before attaching native media. Do not follow a
      // redirect or send uburoom cookies/credentials to the Plex origin.
      const response = await fetch(next.mediaUrl, {
        headers: { Range: 'bytes=0-0' },
        mode: 'cors',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]),
      });
      await response.body?.cancel();
      if (!current()) return;
      if (!response.ok) {
        await proxyDirectFile();
        return;
      }
      deps.video.crossOrigin = 'anonymous';
      deps.video.src = next.mediaUrl;
      store.stream.directStartupTimer = deps.time.setTimeout(() => {
        if (current() && deps.video.readyState < 2) void proxyDirectFile();
      }, 10000);
    } catch {
      if (current()) await proxyDirectFile();
    }
  }
  // A quality change keeps the current stream playing from its buffer while the new one
  // loads out of sight, and swaps only once it reaches the room's position. A new stream
  // that is too slow or fails falls back to the plain swap before the buffer runs out.
  const HOLD_LIMIT_MS = 20000,
    HOLD_RESERVE = 1.5;
  store.stream.lastQualityRequest = 0;
  const fallbackPlayback = uburoomFallback.create({
    supported: format =>
      typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(uburoomPlayback.LOCAL_CODECS[format]),
    prepare: (next, seconds) =>
      uburoomStreams.prepare(next, { target: deps.expected, seconds, hlsConfig: deps.hlsClientConfig }),
    swap: (_, prepared) => {
      store.stream.preparedStream = prepared;
      store.stream.lastQualityRequest = 0;
      deps.applyState(fallbackPlayback.display(), true);
    },
    record: (event, fields) => deps.diagnostics.record(event, fields),
    notify: (active, next) =>
      deps.toasts.show('fallback-stream', {
        title: active ? 'Switched to fallback to keep playing.' : 'Returned to your selected quality.',
        hint: active && next.tracks?.audioId !== next.fallbackStream?.defaultAudioId ? 'Using default audio.' : '',
        symbol: active ? 'down' : 'up',
        duration: 3000,
      }),
  });
  function canHoldStream(next) {
    if (
      deps.activity ||
      store.player.layout === 'phone' ||
      !(store.stream.hls || store.stream.av1) ||
      !store.room.state?.mediaUrl ||
      store.player.playbackError
    )
      return false;
    if (
      deps.time.wall() - store.stream.lastQualityRequest > 10000 ||
      deps.video.readyState < 3 ||
      uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime) <= HOLD_RESERVE + 1
    )
      return false;
    return (
      (next.format === 'hls' && typeof Hls !== 'undefined' && Hls.isSupported()) ||
      uburoomPlayback.localFormat(next.format) ||
      fileNeedsAudioStream(next)
    );
  }
  const fileNeedsAudioStream = next =>
    next.format === 'file' &&
    /^(h264|avc1|hevc|h265|hvc1|hev1)$/i.test(next.videoCodec || '') &&
    !uburoomPlayback.needsVideoConversion(next, type => deps.video.canPlayType(type)) &&
    (store.identity.config.outputs || ['plex']).includes('plex') &&
    uburoomPlayback.needsAudioConversion(next, type => deps.video.canPlayType(type));
  function holdStream(next) {
    const hold = (store.stream.heldStream = { next, started: deps.time.mono() });
    deps.diagnostics.record('stream-hold', { format: next.format });
    store.stream.hls?.stopLoad();
    store.stream.av1?.hold();
    const room = uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime) - HOLD_RESERVE;
    hold.timer = deps.time.setTimeout(
      () => {
        if (store.stream.heldStream === hold) releaseStream('timeout');
      },
      Math.min(HOLD_LIMIT_MS, (room * 1000) / Math.max(deps.video.playbackRate, 1)),
    );
    prepareHeldStream(hold);
  }
  function prepareHeldStream(hold) {
    const next = hold.next;
    clearInterval(hold.prepareTimer);
    hold.preparation?.close();
    hold.request?.abort();
    hold.cache = undefined;
    if (fileNeedsAudioStream(next)) return void requestAudioStream(hold);
    try {
      const preparation = (hold.preparation = uburoomStreams.prepare(next, {
        target: deps.expected,
        seconds: 3,
        hlsConfig: deps.hlsClientConfig,
      }));
      hold.cache = preparation.cache;
      hold.prepareTimer = setInterval(() => {
        if (store.stream.heldStream !== hold) return;
        if (preparation.failed) releaseStream('error');
        else if (preparation.ahead() >= 1) releaseStream();
      }, 100);
    } catch {
      releaseStream('error');
    }
  }
  // Plex copies H.264 and converts only the audio, so skip the file the browser cannot play.
  async function requestAudioStream(hold) {
    const started = deps.time.wall();
    while (store.stream.qualityPending && store.stream.heldStream === hold && deps.time.wall() - started < 3000)
      await new Promise(resolve => deps.time.setTimeout(resolve, 30));
    if (store.stream.heldStream !== hold) return;
    try {
      await deps.execute({
        action: 'media.quality.set',
        args: {
          quality: hold.next.preferredQuality || store.preferences.preferredQuality || hold.next.quality,
          fallback: 'audio',
          reason: 'The browser does not support the original codecs.',
        },
      });
    } catch {
      if (store.stream.heldStream === hold) releaseStream('error');
    }
  }
  function dropHeldStream(adopt = false) {
    const hold = store.stream.heldStream;
    store.stream.heldStream = undefined;
    if (!hold) return;
    deps.time.clearTimeout(hold.timer);
    hold.request?.abort();
    clearInterval(hold.prepareTimer);
    hold.preparation?.close(adopt);
    const client = hold.client;
    hold.client = undefined;
    client?.destroy();
    return hold;
  }
  function releaseStream(end = 'ready') {
    const hold = dropHeldStream(true);
    if (!hold) return;
    store.stream.lastQualityRequest = 0;
    deps.diagnostics.record('stream-swap', {
      format: hold.next.format,
      holdEnd: end,
      prepared: !!hold.cache,
      elapsedMs: deps.time.mono() - hold.started,
    });
    if (hold.cache) {
      hold.cache.recording = false;
      store.stream.preparedStream = { url: hold.next.mediaUrl, cache: hold.cache };
    }
    deps.applyState(hold.next, true);
  }
  return {
    attachDirectFile,
    canHoldStream,
    compatibleFallback,
    dropHeldStream,
    fallbackPlayback,
    holdStream,
    prepareHeldStream,
    proxyDirectFile,
  };
}
