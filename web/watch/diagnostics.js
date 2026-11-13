import * as uburoomDiagnostics from '../playback-diagnostics.js';
import * as uburoomIcons from '../icons.js';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomPopover from '../watch-popover.js';
import * as uburoomTiming from '../../shared/sync/timing.mjs';
import { $ } from './page.js';
import { setTraceSink } from '../trace.js';
import { store } from './store.js';

/* Local playback diagnostics: periodic samples, the soak and control-probe tools, the copyable report and the background upload when the server keeps diagnostics. */
export function mount(host, deps) {
  const soakMode = deps.params.get('soak') === '1',
    diagnostics = uburoomDiagnostics.create({ soak: soakMode });
  // Player helpers in other files report timings here; the recorder drops anything it does not allow.
  setTraceSink((event, fields) => diagnostics.record(event, fields));
  for (const event of ['error', 'unhandledrejection'])
    window.addEventListener(event, () => diagnostics.record('page-error'));
  let soak;
  $('soak-start').hidden = !soakMode;
  $('soak-status').hidden = !soakMode;
  $('soak-start').onclick = () => {
    if (
      soak ||
      !store.room.state?.mediaUrl ||
      store.room.state.visibility !== 'private' ||
      store.room.state.viewers !== 1 ||
      store.room.pending ||
      deps.video.paused ||
      deps.video.readyState < 3
    )
      return;
    soak = {
      room: store.room.selected,
      media: store.room.state.mediaVersion,
      startedAt: deps.time.mono(),
      finishing: false,
      done: false,
    };
    diagnosticSample('soak-start');
    $('soak-status').textContent = 'Two-hour soak recording locally. Keep this tab open.';
  };
  async function finishSoak(reason) {
    if (!soak || soak.finishing || soak.done) return;
    soak.finishing = true;
    let cleanup = false;
    const same = () =>
      store.room.selected === soak.room &&
      store.room.state?.mediaVersion === soak.media &&
      store.room.state.visibility === 'private' &&
      store.room.state.viewers === 1 &&
      store.room.state.canManage;
    try {
      if (reason === 'complete' && same() && !store.room.pending) {
        await deps.execute({ action: 'media.pause' });
        if (same() && !store.room.pending) {
          const id = store.room.selected;
          store.room.pending = true;
          try {
            await deps.roomLink.leave(id);
            if (store.room.selected === id) {
              store.room.selected = undefined;
              store.lobby.browseRoom = undefined;
              deps.unavailable('', 'leave');
              await deps.refreshRooms();
              cleanup = true;
            }
          } finally {
            store.room.pending = false;
            deps.renderTransport();
          }
        }
      }
    } catch {
      /* Export even if the current authorized room cannot be cleaned up. */
    } finally {
      soak.done = true;
      diagnosticSample('soak-end', { reason, cleanup, elapsedMs: deps.time.mono() - soak.startedAt });
      saveDiagnostics('uburoom-playback-soak.json');
      $('soak-status').textContent =
        reason === 'complete'
          ? 'Soak complete. Diagnostic download requested' +
            (cleanup ? '; test room closed.' : '; check playback cleanup.')
          : 'Soak stopped because the room changed. Diagnostic download requested.';
    }
  }
  const controlProbe = deps.params.get('playbackProbe') === '1' ? uburoomDiagnostics.controlProbe() : undefined;
  let probeRunning = false;
  $('probe-control').hidden = !controlProbe;
  $('probe-control').onclick = () => {
    if (
      !store.room.state?.mediaUrl ||
      store.room.state.visibility !== 'private' ||
      store.room.state.viewers !== 1 ||
      store.room.pending ||
      !controlProbe?.start(store.room.selected)
    )
      return;
    probeRunning = true;
    diagnosticSample('probe-start', { delayMs: 6000 });
    store.connection.transport?.interrupt(6000);
  };
  function diagnosticSample(event = 'sample', fields = {}) {
    // Diagnostics must never interrupt playback, even during MediaSource teardown.
    try {
      const quality = deps.video.getVideoPlaybackQuality?.(),
        tracks = store.room.state?.tracks,
        rect = deps.video.getBoundingClientRect(),
        timing = deps.time.clock.read();
      const sharedTarget = uburoomTiming.target(store.room.state, timing.serverTime);
      const control = store.player.sync?.control;
      diagnostics.record(event, {
        position: deps.video.currentTime,
        target: deps.expected(),
        ready: deps.video.readyState,
        network: deps.video.networkState,
        ...timing,
        clockValid: timing.valid,
        sharedTarget,
        timelineRevision: store.room.state?.revision,
        positionErrorMs: sharedTarget === undefined ? undefined : (deps.video.currentTime - sharedTarget) * 1000,
        paused: deps.video.paused,
        seeking: deps.video.seeking,
        waiting: store.player.playerWaiting,
        rate: deps.video.playbackRate,
        syncMode: store.preferences.syncCorrectionMode,
        ranges: Array.from({ length: Math.min(deps.video.buffered.length, 8) }, (_, i) => [
          deps.video.buffered.start(i),
          deps.video.buffered.end(i),
        ]),
        bufferAhead: uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime),
        frames: quality?.totalVideoFrames,
        dropped: quality?.droppedVideoFrames,
        decoded: quality ? quality.totalVideoFrames - quality.droppedVideoFrames : store.player.videoFrames,
        jsHeapUsed: performance.memory?.usedJSHeapSize,
        jsHeapTotal: performance.memory?.totalJSHeapSize,
        jsHeapLimit: performance.memory?.jsHeapSizeLimit,
        callbackFrames: store.player.videoFrames,
        width: deps.video.videoWidth,
        height: deps.video.videoHeight,
        mediaError: deps.video.error?.code,
        online: navigator.onLine,
        visibility: document.visibilityState,
        inViewport:
          rect.width > 0 &&
          rect.height > 0 &&
          rect.bottom > 0 &&
          rect.top < innerHeight &&
          rect.right > 0 &&
          rect.left < innerWidth,
        viewportFraction:
          rect.width > 0 && rect.height > 0
            ? (Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left)) *
                Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))) /
              (rect.width * rect.height)
            : 0,
        format: store.room.state?.format,
        audio: tracks?.audio.findIndex(row => row.id === tracks.audioId),
        subtitle: tracks?.subtitles.findIndex(row => row.id === tracks.subtitleId),
        delivery: tracks?.subtitles.find(row => row.id === tracks.subtitleId)?.delivery || 'off',
        controlSource: control?.source,
        controlErrorMs: Number.isFinite(control?.error) ? Math.round(control.error * 1000) : undefined,
        presentationAgeMs: Number.isFinite(control?.presentationAgeMs)
          ? control.presentationAgeMs
          : deps.time.presentation.read?.(deps.time.mono())?.ageMs,
        presentationDivergenceMs: control?.divergenceMs,
        presentationReason: control?.reason,
        ...fields,
      });
    } catch {
      /* A missing diagnostic sample must not change player behavior. */
    }
  }
  for (const event of [
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
    'canplay',
    'abort',
    'ratechange',
  ])
    deps.video.addEventListener(event, () => {
      if (event === 'playing') deps.resumeAudioContext();
      if (event === 'waiting' && store.connection.disconnectExtended) deps.fullPlayerClear();
      if (['pause', 'seeking', 'emptied'].includes(event)) deps.choppyDetector.interrupt();
      if (event === 'waiting') deps.choppyDetector.buffering();
      // Decoding has resumed after refill. Permit one alignment to the current
      // room target even when a long outage left that target outside this buffer.
      store.player.sync?.event(event);
      if (['playing', 'pause', 'waiting', 'seeking', 'emptied'].includes(event))
        store.player.lastPresentationBreak = deps.time.mono();
      diagnosticSample(event);
    });
  for (const event of ['online', 'offline', 'pagehide'])
    window.addEventListener(event, () => {
      store.player.sync?.event(event);
      diagnosticSample(event);
    });
  document.addEventListener('visibilitychange', () => {
    deps.choppyDetector.interrupt();
    store.player.sync?.event('visibilitychange');
    diagnosticSample('visibilitychange');
  });
  deps.every(1000, () => {
    if (probeRunning && !controlProbe.active()) {
      probeRunning = false;
      diagnosticSample('probe-end');
    }
    $('probe-control').disabled =
      !store.room.state?.mediaUrl ||
      store.room.state.visibility !== 'private' ||
      store.room.state.viewers !== 1 ||
      store.room.pending ||
      !!controlProbe?.active();
    $('soak-start').disabled =
      !!soak ||
      !store.room.state?.mediaUrl ||
      store.room.state.visibility !== 'private' ||
      store.room.state.viewers !== 1 ||
      store.room.pending ||
      deps.video.paused ||
      deps.video.readyState < 3;
    if (store.room.selected || store.room.state || store.stream.mediaSource) diagnosticSample();
    if (soak && !soak.finishing && !soak.done) {
      if (store.room.selected !== soak.room || (store.room.state && store.room.state.mediaVersion !== soak.media))
        void finishSoak('source-changed');
      else if (deps.time.mono() - soak.startedAt >= 7200000) void finishSoak('complete');
    }
  });
  function saveDiagnostics(filename = 'uburoom-playback-diagnostics.json') {
    diagnosticSample();
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(diagnostics.snapshot(), null, 2) + '\n'], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    deps.time.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  // A short paste for bug reports: the last few minutes of player events, with one
  // sample every five seconds and no frame rows. Links are removed from error text.
  function diagnosticReport(minutes = 5) {
    diagnosticSample();
    const snapshot = diagnostics.snapshot(),
      entries = diagnostics.entries({ since: deps.time.wall() - minutes * 60000 }),
      quiet = text =>
        String(text || '')
          .replace(/\bhttps?:\/\/\S+/g, '[link]')
          .slice(0, 200) || undefined;
    const tracks = store.room.state?.tracks,
      quality = deps.video.getVideoPlaybackQuality?.();
    return {
      report: 'uburoom diagnostics',
      schema: 1,
      minutes,
      createdAt: new Date().toISOString(),
      browser: navigator.userAgent,
      screen: [screen.width, screen.height, devicePixelRatio],
      window: [innerWidth, innerHeight],
      fullscreen: !!document.fullscreenElement,
      visibility: document.visibilityState,
      online: navigator.onLine,
      player: {
        format: store.room.state?.format,
        quality: store.room.state?.quality,
        preferredQuality: store.preferences.preferredQuality,
        subtitles: tracks?.subtitleDelivery || (tracks?.subtitleId ? 'text' : 'off'),
        paused: deps.video.paused,
        readyState: deps.video.readyState,
        position: +deps.video.currentTime.toFixed(2),
        target: +(deps.expected() || 0).toFixed(2),
        bufferedAhead: +uburoomPlayback.bufferedAhead(deps.video.buffered, deps.video.currentTime).toFixed(2),
        size: [deps.video.videoWidth, deps.video.videoHeight],
        frames: quality && { total: quality.totalVideoFrames, dropped: quality.droppedVideoFrames },
        chunkSeconds: store.stream.av1?.chunkTime && +store.stream.av1.chunkTime.toFixed(2),
        held: !!store.stream.heldStream,
        error: quiet(store.player.playbackError),
      },
      connection: {
        attempt: store.connection.transport?.connectionAttempt,
        id: store.connection.transport?.connectionId,
      },
      discarded: { events: snapshot.discardedEvents, samples: snapshot.discardedSamples },
      entries,
    };
  }
  // When the server keeps diagnostics, the player sends its rows in the background so
  // nobody has to copy a report. Each page load is its own stream; the server drops rows
  // it already has, so a retry or an overlapping final upload never duplicates them.
  const diagnosticUpload = { stream: crypto.randomUUID(), after: 0, busy: false };
  async function uploadDiagnostics(final = false) {
    if (!store.identity.config?.keepDiagnostics || !store.room.selected || (diagnosticUpload.busy && !final)) return;
    const rows = diagnostics.entries({ after: diagnosticUpload.after }).slice(0, final ? 120 : 2000);
    if (!rows.length) return;
    diagnosticUpload.busy = true;
    try {
      await deps.api(
        '/api/watch/diagnostics',
        { roomId: store.room.selected, viewerId: store.identity.viewerId, stream: diagnosticUpload.stream, rows },
        { keepalive: final, timeoutMs: 20000 },
      );
      diagnosticUpload.after = Math.max(diagnosticUpload.after, rows.at(-1).sequence);
    } catch {
    } finally {
      diagnosticUpload.busy = false;
    }
  }
  deps.every(30000, () => void uploadDiagnostics());
  window.addEventListener('pagehide', () => void uploadDiagnostics(true));
  $('copy-diagnostics').prepend(uburoomIcons.icon(document, 'copy'));
  $('copy-diagnostics').addEventListener('click', async () => {
    const btn = $('copy-diagnostics');
    const text = JSON.stringify(diagnosticReport());
    try {
      await navigator.clipboard.writeText(text);
      uburoomPopover.show(btn, { text: 'Report copied', state: 'success' });
    } catch {
      const url = URL.createObjectURL(new Blob([text + '\n'], { type: 'application/json' })),
        link = document.createElement('a');
      link.href = url;
      link.download = 'uburoom-diagnostic-report.json';
      link.click();
      deps.time.setTimeout(() => URL.revokeObjectURL(url), 1000);
      uburoomPopover.show(btn, { text: 'Saved report as file', state: 'normal', symbol: 'copy' });
    }
  });
  return { controlProbe, diagnosticSample, diagnostics, soakMode };
}
