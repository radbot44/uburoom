import * as uburoomIcons from '../icons.js';
import * as uburoomPlayback from '../playback-policy.js';
import { $ } from './page.js';
import { store } from './store.js';

const readinessReasons = Object.freeze({ preparing: 'preparing video', timing: 'lining up playback' });

/* The transport bar: play state and labels, volume, the timeline with chapters and skip markers, and keyboard shortcuts. */
export function mount(host, deps) {
  function dropVolume() {
    deps.time.clearTimeout(store.player.volumeTimer);
    store.player.volumeWanted = store.player.volumeDraft = undefined;
    store.player.volumeDragging = false;
  }
  function renderTransport() {
    const available = !store.connection.reconnecting && !!store.room.state?.mediaUrl,
      playback = available && store.room.state.canPlayback;
    for (const id of ['player-play', 'previous', 'seek-back', 'seek-forward'])
      $(id).disabled = !playback || store.room.pending;
    $('timeline').disabled = !playback || !!store.room.state?.durationUnknown;
    if (store.room.state?.durable) {
      for (const id of ['seek-back', 'seek-forward'])
        $(id).disabled =
          !available || !store.room.state.capabilities.seek || !!store.room.state.durationUnknown || store.room.pending;
      $('timeline').disabled = !available || !store.room.state.capabilities.seek || !!store.room.state.durationUnknown;
      $('previous').disabled = !available || !store.room.state.capabilities.chooseMedia || store.room.pending;
    }
    $('player-mute').disabled = !available || store.room.pending;
    $('player-volume').disabled = !available;
    $('next').disabled = !playback || !store.room.state?.hasNext || store.room.pending;
    if (store.room.state?.durable)
      $('next').disabled =
        !available || !store.room.state.hasNext || !store.room.state.capabilities.chooseMedia || store.room.pending;
    const isEmbed = store.room.state?.format === 'youtube-embed';
    $('quality').disabled =
      !available ||
      store.room.state?.mediaId === 'demo' ||
      isEmbed ||
      (store.room.state?.qualities?.length ?? 2) <= 1 ||
      store.room.pending ||
      store.stream.qualityPending;
    const canPiP = deps.supportsDocPiP || (deps.supportsVideoPiP && deps.surface.canRequestVideoPiP());
    $('pip').disabled = !available || isEmbed || !canPiP;
    const inPiP = !!store.player.pipWindow || document.pictureInPictureElement === deps.video;
    $('pip').setAttribute('aria-pressed', inPiP ? 'true' : 'false');
    $('pip').title = isEmbed
      ? 'Picture-in-Picture is unavailable for YouTube embeds'
      : !canPiP
        ? 'Picture-in-Picture requires Document Picture-in-Picture support'
        : inPiP
          ? 'Exit Picture-in-Picture'
          : 'Picture-in-Picture';
    $('pip').setAttribute('aria-label', $('pip').title);
    const paused =
      !!store.room.state?.pauseAt || (store.room.state?.state.paused !== false && !store.room.state?.waitingForReady);
    $('stage').classList.toggle('paused', store.room.state?.state.paused !== false);
    $('stage').classList.toggle('blocked', store.player.autoplayBlocked);
    deps.glyph('player-play', paused ? 'play' : 'pause');
    $('player-play').setAttribute('aria-label', paused ? 'Play' : 'Pause');
    $('player-play').title = paused ? 'Play' : 'Pause';
    const isMuted = !!store.room.state?.state?.muted;
    renderVolumeIcon();
    // Player UI derives the speaker's name from this: Mute/Unmute, or Volume where it opens the phone panel.
    if ($('player-mute').getAttribute('aria-pressed') !== String(isMuted))
      $('player-mute').setAttribute('aria-pressed', String(isMuted));
    const joinBlocked =
      !store.player.autoplayBlocked &&
      (!playback ||
        store.room.pending ||
        !!store.room.state?.waitingForReady ||
        !!store.room.state?.waitingForHost ||
        !!store.room.state?.recovery);
    $('join-playback').disabled = joinBlocked;
    $('join-playback').hidden = !store.room.state?.mediaUrl || !!store.room.state?.readiness?.timedOut || joinBlocked;
    const centerLabel = store.player.autoplayBlocked ? 'Join playback' : paused ? 'Play' : 'Pause';
    deps.glyph('join-playback', store.player.autoplayBlocked || paused ? 'play' : 'pause');
    $('join-playback').setAttribute('aria-label', centerLabel);
    $('join-playback').title = centerLabel;
    const readiness = store.room.state?.readiness;
    const blockers = readiness?.blockers || [];
    const reasonText = index => readinessReasons[readiness?.reasons?.[index]];
    let readyStatus = deps.youtube?.isAdPlaying()
      ? 'YouTube ad playing — rejoining room when it ends…'
      : store.room.state?.waitingForReady
        ? store.player.autoplayBlocked
          ? 'Press Play to join playback'
          : store.room.state?.readiness?.buffering
            ? 'Waiting for playback to buffer…'
            : 'Waiting for viewers…'
        : store.player.autoplayBlocked
          ? 'Press Play to join playback'
          : store.room.state?.startAt > store.room.state?.serverNow &&
              !(deps.time.serverNow() >= store.room.state.startAt)
            ? 'Starting together…'
            : '';
    if (blockers.length)
      readyStatus =
        blockers.length === 1 && reasonText(0)
          ? blockers[0] + ' is ' + reasonText(0) + '…'
          : 'Waiting for ' + blockers.join(', ') + '…';
    if (readiness?.timedOut)
      readyStatus = (store.room.state.durable ? store.room.state.capabilities?.chooseMedia : store.room.state.canManage)
        ? 'Some viewers need more time. Choose how to continue.'
        : 'Waiting for the host to choose how to continue.';
    if (store.room.state?.waitingForHost) readyStatus = 'Playback is paused until a room leader or host joins.';
    if ($('ready-status').textContent !== readyStatus) $('ready-status').textContent = readyStatus;
    $('room-recovery').hidden = !store.room.state?.recovery;
    const serverNow = deps.time.serverNow();
    // Without a usable room clock the countdown holds its last value.
    if (store.room.state?.recovery && serverNow !== undefined)
      $('room-recovery-message').textContent =
        'Waiting for ' +
        store.room.state.recovery.missing +
        ' people / ' +
        Math.max(0, Math.ceil((store.room.state.recovery.until - serverNow) / 1000)) +
        ' seconds remaining. Playback is paused.';
    $('room-recovery-start').hidden = !store.room.state?.canPlayback;
    $('room-recovery-start').disabled = store.room.pending || !store.room.state?.mediaUrl;
    $('readiness-choice').hidden =
      !!store.room.state?.recovery ||
      !store.room.state?.readiness?.timedOut ||
      (!!store.room.state.mediaError && !store.room.state.readiness.canStart) ||
      !(store.room.state.durable ? store.room.state.capabilities?.chooseMedia : store.room.state.canManage);
    $('readiness-title').textContent = blockers.length ? 'Some viewers need more time' : 'Ready to continue?';
    const readinessMessage = blockers.length
      ? (readiness.reasons?.some(Boolean)
          ? blockers.map((name, index) => name + ' is ' + (reasonText(index) || 'still getting ready') + '.').join(' ')
          : 'Waiting for ' + blockers.join(', ') + '.') + ' Start with ready viewers, or wait.'
      : 'Everyone is ready. Playback stays paused until you choose.';
    if ($('readiness-message').textContent !== readinessMessage) $('readiness-message').textContent = readinessMessage;
    $('ready-start').disabled = store.room.pending || !store.room.state?.readiness?.canStart;
    $('ready-wait').disabled = $('ready-cancel').disabled = store.room.pending;
    if (store.room.state?.readiness?.timedOut) $('player-play').disabled = true;
    if (!store.player.volumeDragging)
      $('player-volume').value =
        store.player.volumeDraft ?? store.room.state?.state.volume ?? store.preferences.playerPreferences.volume;
    deps.renderTracks();
  }
  function clock(value = 0) {
    const seconds = Math.floor(value || 0),
      minutes = Math.floor(seconds / 60);
    return (
      (seconds >= 3600 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') : minutes) +
      ':' +
      String(seconds % 60).padStart(2, '0')
    );
  }
  function renderVolumeIcon() {
    deps.glyph(
      'player-mute',
      uburoomIcons.volumeName(
        store.player.volumeDraft ?? store.room.state?.state?.volume ?? Number($('player-volume').value),
        !!store.room.state?.state?.muted,
      ),
    );
  }
  function pumpVolume() {
    deps.time.clearTimeout(store.player.volumeTimer);
    if (store.player.volumeWanted === undefined || !store.room.selected || !store.room.state) return;
    const wait = Math.max(0, 500 - (deps.time.wall() - store.player.lastVolumeAt));
    if (store.room.pending || store.player.volumePending || wait) {
      store.player.volumeTimer = deps.time.setTimeout(pumpVolume, Math.max(100, wait));
      return;
    }
    const percent = store.player.volumeWanted;
    store.player.volumeWanted = undefined;
    store.player.lastVolumeAt = deps.time.wall();
    deps
      .execute({ action: 'media.volume.set', args: { percent } })
      .then(() => {
        if (store.player.volumeWanted === undefined && store.player.volumeDraft === percent)
          store.player.volumeDraft = undefined;
        renderTransport();
      })
      .catch(error => {
        dropVolume();
        deps.fail(error.message);
      });
  }
  $('player-volume').addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    store.player.volumeDragging = true;
  });
  $('player-volume').addEventListener('input', () => {
    store.player.volumeWanted = store.player.volumeDraft = Number($('player-volume').value);
    deps.savePlayerPreferences({ volume: store.player.volumeDraft, muted: false });
    renderVolumeIcon();
    pumpVolume();
  });
  $('player-volume').addEventListener('change', () => {
    store.player.volumeDragging = false;
    store.player.volumeWanted = store.player.volumeDraft = Number($('player-volume').value);
    deps.savePlayerPreferences({ volume: store.player.volumeDraft, muted: false });
    renderVolumeIcon();
    pumpVolume();
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    $('player-volume').addEventListener(type, () => {
      store.player.volumeDragging = false;
    });
  }
  for (const [id, command] of [
    ['previous', { action: 'media.previous' }],
    ['seek-back', { action: 'media.seek.relative', args: { seconds: -15 } }],
    ['seek-forward', { action: 'media.seek.relative', args: { seconds: 15 } }],
    ['next', { action: 'media.next' }],
  ])
    $(id).addEventListener('click', () => deps.execute(command).catch(error => deps.fail(error.message)));
  for (const choice of ['start', 'wait', 'cancel'])
    $('ready-' + choice).addEventListener('click', () => {
      void deps
        .execute({ action: 'media.ready.' + choice, args: { readinessId: store.room.state?.readiness?.id } })
        .catch(error => deps.fail(error.message));
    });
  $('player-play').addEventListener('click', () =>
    deps
      .execute({
        action:
          store.room.state?.pauseAt || (store.room.state?.state.paused && !store.room.state?.waitingForReady)
            ? 'media.play'
            : 'media.pause',
      })
      .catch(error => deps.fail(error.message)),
  );
  $('player-mute').addEventListener('click', () =>
    deps
      .execute({ action: store.room.state?.state.muted ? 'media.unmute' : 'media.mute' })
      .catch(error => deps.fail(error.message)),
  );
  $('join-playback').addEventListener('click', async () => {
    if (store.player.autoplayBlocked) {
      await deps.unlockLocal();
      void deps.reportReadiness();
      if (store.room.state && !store.room.state.state.paused) void store.player.sync.synchronize();
    } else $('player-play').click();
  });
  $('quality').addEventListener('change', () => {
    store.preferences.preferredQuality = $('quality').value;
    deps.savePlayerPreferences({ quality: store.preferences.preferredQuality });
    deps.choppyDetector.triggerCooldown(10000, deps.time.mono());
    if (store.player.choppyToastActive) {
      deps.toasts.dismiss('choppy', false);
      store.player.choppyToastActive = false;
    }
    // Choosing a quality starts over, so a fallback from earlier cannot pin this viewer.
    store.stream.localFallbackAttempts = new Set();
    deps
      .execute({
        action: 'media.quality.set',
        args: {
          quality: store.preferences.preferredQuality,
          ubuplayer: deps.canUseUbuPlayer?.(),
          gpuTonemap: deps.canGpuTonemap?.(),
          reset: true,
        },
      })
      .catch(error => deps.fail(error.message));
  });
  function updateTimelineTooltip(event) {
    const tooltip = $('timeline-tooltip');
    if (!tooltip || !store.room.state?.state?.duration) return;
    const rect = $('timeline').getBoundingClientRect();
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const hoverSec = fraction * store.room.state.state.duration;
    const chapters = store.room.state.chapters || [];
    const chapter = chapters.find(ch => hoverSec >= ch.startTime && hoverSec < ch.endTime);
    tooltip.textContent = (chapter ? chapter.title + ' · ' : '') + clock(hoverSec);
    tooltip.hidden = false;
    const row = $('timeline-row') || $('timeline').parentElement;
    const rowRect = row.getBoundingClientRect();
    const left = event.clientX - rowRect.left;
    tooltip.style.setProperty('--x', Math.max(24, Math.min(rowRect.width - 24, left)) + 'px');
  }
  $('timeline').addEventListener('pointerdown', event => {
    if (event.button !== 0) return;
    store.player.seekDragging = true;
    updateTimelineTooltip(event);
  });
  $('timeline').addEventListener('pointermove', updateTimelineTooltip);
  $('timeline').addEventListener('pointerleave', () => {
    if (!store.player.seekDragging && $('timeline-tooltip')) $('timeline-tooltip').hidden = true;
  });
  $('timeline').addEventListener('input', () => {
    $('time').textContent = clock($('timeline').value);
  });
  $('timeline').addEventListener('change', () => {
    const seconds = Number($('timeline').value);
    store.player.seekDragging = false;
    if ($('timeline-tooltip')) $('timeline-tooltip').hidden = true;
    const token = (store.room.seekPendingToken = (store.room.seekPendingToken || 0) + 1);
    store.room.seekPendingValue = seconds;
    store.room.seekPendingUntil = deps.time.mono() + 1500;
    deps
      .execute({ action: 'media.seek.absolute', args: { seconds } })
      .catch(error => {
        deps.fail(error.message);
      })
      .finally(() => {
        if (store.room.seekPendingToken === token) {
          store.room.seekPendingValue = undefined;
          store.room.seekPendingUntil = 0;
        }
      });
  });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    $('timeline').addEventListener(type, () => {
      store.player.seekDragging = false;
      if ($('timeline-tooltip')) $('timeline-tooltip').hidden = true;
    });
  }
  $('chapters')?.addEventListener('change', () => {
    const seconds = Number($('chapters').value);
    if (Number.isFinite(seconds)) {
      deps.execute({ action: 'media.seek.absolute', args: { seconds } }).catch(error => deps.fail(error.message));
    }
  });
  $('skip-marker')?.addEventListener('click', () => {
    const seekTo = Number($('skip-marker').dataset.seekTo);
    if (Number.isFinite(seekTo)) {
      $('skip-marker').hidden = true;
      deps
        .execute({ action: 'media.seek.absolute', args: { seconds: seekTo } })
        .catch(error => deps.fail(error.message));
    }
  });
  function handleStageKeydown(event) {
    if (
      event.defaultPrevented ||
      document.body.classList.contains('activity-pip') ||
      document.querySelector('dialog:modal')
    )
      return;
    if (event.code === 'Escape' && !deps.drawer.hidden) {
      deps.toggleDrawer(false);
      $('drawer-open').focus();
      return;
    }
    if (!deps.drawer.hidden && typeof event.target?.nodeType === 'number' && deps.drawer.contains(event.target)) return;
    if (
      !store.room.state ||
      event.repeat ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      (typeof event.target?.closest === 'function' &&
        event.target.closest('button,input,select,textarea,[contenteditable=true]'))
    )
      return;
    if (event.code === 'KeyF') {
      event.preventDefault();
      $('fullscreen')?.click();
      return;
    }
    if (event.code === 'KeyT' && store.player.layout !== 'phone') {
      event.preventDefault();
      $('theater')?.click();
      return;
    }
    if (event.code === 'KeyP' && store.room.state?.mediaUrl && !$('pip')?.disabled && !$('pip')?.hidden) {
      event.preventDefault();
      $('pip')?.click();
      return;
    }
    if (event.code === 'KeyC' && store.room.state?.mediaUrl) {
      event.preventDefault();
      $('captions-toggle')?.click();
      return;
    }
    if (event.code === 'Space') {
      if (store.player.autoplayBlocked && store.room.state?.mediaUrl && !$('join-playback')?.disabled) {
        event.preventDefault();
        $('join-playback').click();
        return;
      }
      if (!store.room.state?.mediaUrl && !$('ending-stage')?.hidden && !$('ending-play')?.disabled) {
        event.preventDefault();
        $('ending-play')?.click();
        return;
      }
      if (store.room.state?.mediaUrl && !$('player-play')?.disabled) {
        event.preventDefault();
        deps
          .execute({
            action:
              store.room.state.pauseAt || (store.room.state.state.paused && !store.room.state.waitingForReady)
                ? 'media.play'
                : 'media.pause',
          })
          .catch(error => deps.fail(error.message));
        return;
      }
      return;
    }
    if (['ArrowLeft', 'ArrowRight'].includes(event.code) && store.room.state?.mediaUrl && !$('seek-back')?.disabled) {
      event.preventDefault();
      deps
        .execute({ action: 'media.seek.relative', args: { seconds: event.code === 'ArrowLeft' ? -15 : 15 } })
        .catch(error => deps.fail(error.message));
      return;
    }
    if (event.code === 'KeyM' && store.room.state?.mediaUrl && !$('player-mute')?.disabled) {
      event.preventDefault();
      deps
        .execute({ action: store.room.state.state.muted ? 'media.unmute' : 'media.mute' })
        .catch(error => deps.fail(error.message));
      return;
    }
    if (event.code === 'KeyG' || event.code === 'KeyH') {
      const step = event.shiftKey ? 0.1 : 0.5;
      const delta = event.code === 'KeyG' ? -step : step;
      if (deps.adjustSubtitleOffset?.({ delta, announce: true })) event.preventDefault();
      return;
    }
    if (event.code === 'Backslash' && !event.shiftKey) {
      if (deps.adjustSubtitleOffset?.({ reset: true, announce: true })) event.preventDefault();
      return;
    }
  }
  document.addEventListener('keydown', handleStageKeydown);
  deps.every(250, () => {
    const timeline = $('timeline'),
      duration = store.room.state?.state.duration || 0;
    let value;
    if (store.player.seekDragging) {
      value = Number(timeline.value);
    } else if (store.room.seekPendingValue !== undefined) {
      if (deps.time.mono() < store.room.seekPendingUntil) {
        value = store.room.seekPendingValue;
      } else {
        store.room.seekPendingValue = undefined;
        store.room.seekPendingUntil = 0;
        value = store.room.state ? deps.expected() : 0;
      }
    } else {
      value = store.room.state ? deps.expected() : 0;
    }
    if (!store.player.seekDragging) {
      timeline.value = value;
      $('time').textContent = clock(value);
    }
    const buffered = deps.youtube?.isActive() ? deps.youtube.bufferedRanges() : deps.surface.buffered();
    timeline.style.setProperty(
      '--timeline-fill',
      uburoomPlayback.timeline(buffered, duration, value, store.room.state?.chapters),
    );
    const chapters = store.room.state?.chapters || [];
    const currentChapter = chapters.find(ch => value >= ch.startTime && value < ch.endTime);
    if ($('chapters') && !$('chapters').disabled && $('chapters').value !== String(currentChapter?.startTime ?? '')) {
      $('chapters').value = String(currentChapter?.startTime ?? '');
    }
    const canSeek = store.room.state?.capabilities
      ? store.room.state.capabilities.seek !== false
      : !!store.room.state?.canPlayback;
    const markers = store.room.state?.markers || [];
    const activeMarker = canSeek && markers.find(m => value >= m.startTime && value < m.endTime - 0.5);
    const skipBtn = $('skip-marker');
    if (skipBtn) {
      if (activeMarker) {
        skipBtn.hidden = false;
        const label = activeMarker.type === 'credits' ? 'Skip credits' : 'Skip intro';
        $('skip-marker-label').textContent = label;
        skipBtn.setAttribute('aria-label', label);
        skipBtn.dataset.seekTo = String(activeMarker.endTime);
      } else {
        skipBtn.hidden = true;
      }
    }
    const active = deps.activePlayer;
    const loaded = Math.floor(active.bufferedAhead(active.currentTime()));
    timeline.setAttribute(
      'aria-valuetext',
      clock(value) + ' of ' + clock(duration) + ', ' + loaded + ' seconds buffered ahead',
    );
    timeline.title = loaded + ' seconds buffered ahead';
  });
  return { clock, dropVolume, handleStageKeydown, pumpVolume, renderTransport };
}
