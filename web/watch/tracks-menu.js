import * as uburoomIcons from '../icons.js';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomPlayerUI from '../watch-player-ui.js';
import * as uburoomPopover from '../watch-popover.js';
import { probeLocalFile } from '../ubuplayer.js';
import {
  formatSubtitleOffset,
  normalizeSubtitleOffset,
  parseSubtitleText,
  uburoomSubtitles,
} from '../watch-subtitles.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Player settings: tracks (audio, subtitles, quality), subtitle loading and appearance controls, media information and the host video check. */
export function mount(host, deps) {
  // The server checks each video for hosts. They read it in Player settings and get one
  // toast per video when it finds a problem or warning. Viewers never request it.
  const videoCheck = { media: undefined, report: undefined, toasted: undefined, timer: undefined };
  let richPresencePending = false;
  const VIDEO_CHECK_ICONS = { problem: 'alert-triangle', warning: 'alert-triangle', info: 'info-circle', ok: 'check' };
  async function loadVideoCheck(refresh = false) {
    deps.time.clearTimeout(videoCheck.timer);
    const room = store.room.selected,
      media = store.room.state?.mediaVersion;
    if (!store.room.state?.canManage || !store.room.state.mediaId || !room) return renderVideoCheck();
    let report;
    try {
      report = await deps.call('room.check', { roomId: room, args: { refresh } });
    } catch {
      return;
    }
    if (store.room.selected !== room || store.room.state?.mediaVersion !== media) return;
    videoCheck.report = report;
    renderVideoCheck();
    if (report.checking) videoCheck.timer = deps.time.setTimeout(() => void loadVideoCheck(), 5000);
    else if (['problem', 'warning'].includes(report.level) && videoCheck.toasted !== media) {
      videoCheck.toasted = media;
      deps.toasts.show('video-check', {
        type: report.level === 'problem' ? 'error' : 'normal',
        symbol: 'alert-triangle',
        duration: 15000,
        title: report.level === 'problem' ? 'Video check found a problem' : 'Video check found a warning',
        hint: report.items[0]?.title || '',
        action: {
          label: 'View',
          run: () => {
            store.player.playerUI.openDialog('video-check-refresh');
          },
        },
      });
    }
  }
  function renderVideoCheck() {
    const report =
      store.room.state?.canManage && store.room.state.mediaVersion === videoCheck.media ? videoCheck.report : undefined;
    $('video-check').hidden = !report;
    if (!report) return;
    const list = $('video-check-items');
    list.replaceChildren();
    for (const item of report.items) {
      const row = document.createElement('li');
      row.dataset.level = item.level;
      const icon = uburoomIcons.icon(document, VIDEO_CHECK_ICONS[item.level] || 'info-circle');
      icon.setAttribute('aria-hidden', 'true');
      const text = document.createElement('div'),
        title = document.createElement('p');
      title.className = 'video-check-title';
      title.textContent = item.title;
      text.append(title);
      if (item.detail) {
        const detail = document.createElement('p');
        detail.className = 'hint';
        detail.textContent = item.detail;
        text.append(detail);
      }
      row.append(icon, text);
      list.append(row);
    }
    $('video-check-refresh').disabled = !!report.checking;
  }
  $('video-check-refresh').prepend(uburoomIcons.icon(document, 'refresh'));
  $('video-check-refresh').addEventListener('click', () => {
    videoCheck.toasted = store.room.state?.mediaVersion;
    void loadVideoCheck(true);
  });
  let subtitleLoadingTimer,
    subtitleLoadingActive = false;
  function setSubtitleLoading(loading) {
    const cc = $('captions-toggle');
    if (!loading) {
      subtitleLoadingActive = false;
      deps.time.clearTimeout(subtitleLoadingTimer);
      subtitleLoadingTimer = undefined;
      if (cc) {
        cc.dataset.loading = 'false';
        cc.removeAttribute('aria-busy');
      }
      return;
    }
    if (subtitleLoadingActive) return;
    subtitleLoadingActive = true;
    subtitleLoadingTimer = deps.time.setTimeout(() => {
      subtitleLoadingTimer = undefined;
      if (subtitleLoadingActive && cc) {
        cc.dataset.loading = 'true';
        cc.setAttribute('aria-busy', 'true');
      }
    }, 250);
  }
  let lastBurnFallbackKey = '',
    burnFallbackRetryTimer,
    activeSubtitleKey = '';
  function attemptBurnFallback() {
    deps.time.clearTimeout?.(burnFallbackRetryTimer);
    burnFallbackRetryTimer = undefined;
    if (!store.room.state?.tracks?.subtitleId || (store.room.state.tracks.subtitleMode || 'auto') !== 'auto') return;
    const key = `${store.room.state.mediaVersion}:${store.room.state.tracks.subtitleId}`;
    if (lastBurnFallbackKey === key) return;
    if (store.room.pending || store.stream.qualityPending) {
      burnFallbackRetryTimer = (deps.time.setTimeout || setTimeout)(attemptBurnFallback, 200);
      return;
    }
    void changeTrack(
      { subtitleMode: 'burn' },
      { mediaVersion: store.room.state.mediaVersion, streamVersion: store.room.state.streamVersion },
      key,
    );
  }
  const captions = new uburoomSubtitles(
    deps.surface,
    value => {
      store.player.trackNotice = value.message;
      store.player.trackNoticeError = value.error;
      setSubtitleLoading(!!value.loading);
      renderTracks();
      if (
        value.error &&
        value.burnFallback &&
        store.room.state?.tracks?.subtitleId &&
        (store.room.state.tracks.subtitleMode || 'auto') === 'auto'
      ) {
        attemptBurnFallback();
      }
    },
    mediaTime =>
      store.player.sync.timelinePending || deps.activePlayer.readyState() < 1
        ? deps.expected()
        : Number.isFinite(mediaTime)
          ? mediaTime
          : deps.activePlayer.currentTime(),
  );
  store.player.subtitleLayout = () =>
    captions.appearance({
      position: store.preferences.playerPreferences.subtitlePosition,
      size: store.preferences.playerPreferences.subtitleSize,
    });
  store.player.subtitleLayout();
  const subtitleMode = $('subtitle-mode');
  deps.video.volume = store.preferences.playerPreferences.volume / 100;
  deps.video.muted = store.preferences.playerPreferences.muted;

  store.player.playerUI = uburoomPlayerUI.mount({
    getState: () => store.room.state,
    execute: (...args) => deps.execute(...args),
    fail: deps.fail,
    changeTrack,
    captions,
    beforeSettings: () => {
      deps.renderUbuPlayerSetting?.();
      renderMediaInformation(store.room.state);
      renderVideoCheck();
      store.player.trackContext = store.room.state
        ? { mediaVersion: store.room.state.mediaVersion, streamVersion: store.room.state.streamVersion }
        : undefined;
      store.player.trackActionError = '';
      renderTracks();
    },
    afterSettings: () => {
      store.player.trackContext = undefined;
    },
  });
  let pendingLocalCandidate = null;
  let localProbePending = false;
  function formatDurationDiff(seconds) {
    const abs = Math.round(Math.abs(seconds));
    const m = Math.floor(abs / 60);
    const s = abs % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }
  function renderLocalSourceControls() {
    const state = store.room.state;
    const operatorAllowed = deps.operatorAllowsUbuPlayer ? deps.operatorAllowsUbuPlayer() : true;
    const ubuAllowed = deps.canUseUbuPlayer ? deps.canUseUbuPlayer() : operatorAllowed;
    const sourceField = $('playback-source-field');
    if (sourceField) sourceField.hidden = !operatorAllowed;
    const canUseLocal = Boolean(operatorAllowed && state?.mediaId && state?.format !== 'youtube-embed');
    const activeLocal =
      ubuAllowed && state?.format === 'local' && store.stream.localFile?.mediaVersion === state?.mediaVersion
        ? store.stream.localFile
        : null;
    const chooseBtn = $('local-file-choose');
    const clearBtn = $('local-file-clear');
    const statusEl = $('local-file-status');
    const mismatchBox = $('local-file-mismatch');
    if (chooseBtn) {
      chooseBtn.disabled = !canUseLocal || !ubuAllowed || localProbePending || store.room.pending;
      chooseBtn.textContent = activeLocal ? 'Change local file…' : 'Choose local file…';
    }
    if (clearBtn) {
      clearBtn.hidden = !activeLocal;
      clearBtn.disabled = localProbePending || store.room.pending;
    }
    if (mismatchBox && (!pendingLocalCandidate || pendingLocalCandidate.mediaVersion !== state?.mediaVersion)) {
      pendingLocalCandidate = null;
      mismatchBox.hidden = true;
    }
    if (statusEl && !localProbePending && !pendingLocalCandidate) {
      if (!state?.mediaId) statusEl.textContent = 'Choose a video in the room first.';
      else if (state.format === 'youtube-embed') statusEl.textContent = 'Unavailable for embedded YouTube videos.';
      else if (!ubuAllowed) statusEl.textContent = 'Enable Use UbuPlayer above to play a local file.';
      else if (activeLocal) statusEl.textContent = 'Playing local file: ' + activeLocal.name;
      else statusEl.textContent = 'Streaming from room. Pick a downloaded copy on this device to play locally.';
      statusEl.classList.remove('error');
    }
    const subChoose = $('local-subtitle-choose');
    const subClear = $('local-subtitle-clear');
    const activeSidecar =
      store.stream.localSidecarSubtitle?.mediaVersion === state?.mediaVersion
        ? store.stream.localSidecarSubtitle
        : null;
    if (subChoose) {
      subChoose.disabled = !canUseLocal;
      subChoose.textContent = activeSidecar ? 'Change subtitle file…' : 'Load subtitle file…';
    }
    if (subClear) subClear.hidden = !activeSidecar;
  }
  async function commitLocalFile(candidate) {
    const state = store.room.state;
    if (!state || state.mediaVersion !== candidate.mediaVersion) return;
    pendingLocalCandidate = null;
    if ($('local-file-mismatch')) $('local-file-mismatch').hidden = true;
    const defaultAudio =
      candidate.probed.audioTracks.find(a => a.default)?.id || candidate.probed.audioTracks[0]?.id || null;
    store.stream.localFile = {
      key: 'local-file:' + crypto.randomUUID(),
      file: candidate.file,
      name: candidate.file.name,
      probed: candidate.probed,
      mediaVersion: state.mediaVersion,
      audioId: defaultAudio,
      subtitleId: state.tracks?.subtitleId || null,
    };
    renderLocalSourceControls();
    try {
      const res = await deps.execute({
        action: 'media.delivery.set',
        args: { mode: 'local', mediaVersion: state.mediaVersion },
      });
      if (res?.status && res.status !== 'applied') {
        store.stream.localFile = undefined;
        if ($('local-file-status')) {
          $('local-file-status').textContent = res.message || 'Could not switch to local file.';
          $('local-file-status').classList.add('error');
        }
      }
    } catch (err) {
      store.stream.localFile = undefined;
      deps.fail(err.message);
    } finally {
      renderLocalSourceControls();
      renderTracks();
    }
  }
  async function useRoomStream() {
    const state = store.room.state;
    pendingLocalCandidate = null;
    if ($('local-file-mismatch')) $('local-file-mismatch').hidden = true;
    store.stream.localFile = undefined;
    renderLocalSourceControls();
    if (!state?.mediaVersion) return;
    try {
      await deps.execute({
        action: 'media.delivery.set',
        args: { mode: 'auto', mediaVersion: state.mediaVersion },
      });
    } catch (err) {
      deps.fail(err.message);
    } finally {
      renderLocalSourceControls();
      renderTracks();
    }
  }
  async function handleLocalFilePicked(file) {
    const state = store.room.state;
    const ubuAllowed = deps.canUseUbuPlayer ? deps.canUseUbuPlayer() : store.identity.config?.ubuplayer !== false;
    if (!file || !state?.mediaVersion || !ubuAllowed) return;
    const mediaVersion = state.mediaVersion;
    localProbePending = true;
    pendingLocalCandidate = null;
    if ($('local-file-mismatch')) $('local-file-mismatch').hidden = true;
    const statusEl = $('local-file-status');
    if (statusEl) {
      statusEl.textContent = 'Checking ' + file.name + '…';
      statusEl.classList.remove('error');
    }
    renderLocalSourceControls();
    try {
      const probed = await probeLocalFile(file, { ubuplayerEnabled: ubuAllowed });
      if (store.room.state?.mediaVersion !== mediaVersion) return;
      if (!probed.webCodecsSupported) {
        if (statusEl) {
          statusEl.textContent = `This browser cannot hardware-decode ${(probed.video?.codec || 'the').toUpperCase()} video in ${file.name}. Keep using the room stream.`;
          statusEl.classList.add('error');
        }
        return;
      }
      const roomDur = Number(store.room.state?.state?.duration) || 0;
      if (roomDur > 0 && probed.duration > 0 && Math.abs(probed.duration - roomDur) > 5) {
        pendingLocalCandidate = { file, probed, mediaVersion };
        if ($('local-file-mismatch-text')) {
          $('local-file-mismatch-text').textContent =
            `Duration differs by ${formatDurationDiff(probed.duration - roomDur)} (${file.name}: ${deps.clock(probed.duration)}, room: ${deps.clock(roomDur)}). Playback sync may not line up.`;
        }
        if ($('local-file-mismatch')) $('local-file-mismatch').hidden = false;
        if (statusEl) statusEl.textContent = 'Confirm local file duration mismatch below.';
        return;
      }
      await commitLocalFile({ file, probed, mediaVersion });
    } catch (err) {
      if (statusEl) {
        statusEl.textContent = (err?.message || 'Could not read local file.') + ' Using room stream.';
        statusEl.classList.add('error');
      }
    } finally {
      localProbePending = false;
      renderLocalSourceControls();
    }
  }
  async function handleLocalSubtitlePicked(file) {
    const state = store.room.state;
    if (!file || !state?.mediaVersion) return;
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    let spec;
    if (ext === 'ass' || ext === 'ssa') {
      spec = { key: 'local-sidecar:' + crypto.randomUUID(), format: 'ass', data: bytes, fileName: file.name };
    } else if (ext === 'sup') {
      spec = { key: 'local-sidecar:' + crypto.randomUUID(), format: 'pgs', data: bytes, fileName: file.name };
    } else {
      const cues = parseSubtitleText(new TextDecoder('utf-8', { fatal: false }).decode(bytes));
      if (!cues.length) {
        store.player.trackActionError = 'No subtitle cues found in ' + file.name + '.';
        renderTracks();
        return;
      }
      spec = { key: 'local-sidecar:' + crypto.randomUUID(), format: 'cues', cues, fileName: file.name };
    }
    store.stream.localSidecarSubtitle = {
      id: 'local-sidecar',
      mediaVersion: state.mediaVersion,
      name: file.name,
      spec,
    };
    if (store.stream.localFile?.mediaVersion === state.mediaVersion) {
      store.stream.localFile.subtitleId = 'local-sidecar';
    }
    await captions.setLocalSubtitle(spec);
    deps.applyState(store.room.state, true);
    renderLocalSourceControls();
    renderTracks();
  }
  function clearLocalSubtitle() {
    store.stream.localSidecarSubtitle = undefined;
    if (store.stream.localFile?.subtitleId === 'local-sidecar') {
      store.stream.localFile.subtitleId = 'off';
    }
    void captions.setLocalSubtitle(null);
    if (store.room.state) deps.applyState(store.room.state, true);
    renderLocalSourceControls();
    renderTracks();
  }
  $('local-file-choose')?.addEventListener('click', () => $('local-file-input')?.click());
  $('local-file-input')?.addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) void handleLocalFilePicked(file);
  });
  $('local-file-clear')?.addEventListener('click', () => void useRoomStream());
  $('local-file-confirm')?.addEventListener('click', () => {
    if (pendingLocalCandidate) void commitLocalFile(pendingLocalCandidate);
  });
  $('local-file-cancel')?.addEventListener('click', () => {
    pendingLocalCandidate = null;
    if ($('local-file-mismatch')) $('local-file-mismatch').hidden = true;
    renderLocalSourceControls();
  });
  $('local-subtitle-choose')?.addEventListener('click', () => $('local-subtitle-input')?.click());
  $('local-subtitle-input')?.addEventListener('change', ev => {
    const file = ev.target.files?.[0];
    ev.target.value = '';
    if (file) void handleLocalSubtitlePicked(file);
  });
  $('local-subtitle-clear')?.addEventListener('click', () => clearLocalSubtitle());
  function renderMediaInformation(next) {
    if (!next) return;
    const info = next.deliveryInfo;
    if (info?.format === 'youtube-embed') {
      $('media-information').textContent = 'YouTube IFrame player';
      $('delivery-information').textContent =
        info.reason === 'youtube-embed-fallback' ? 'Direct from YouTube (fallback from yt-dlp)' : 'Direct from YouTube';
      return;
    }
    const mediaWidth = deps.surface.width() || info?.width,
      mediaHeight = deps.surface.height() || info?.height;
    $('media-information').textContent = info
      ? [
          mediaWidth && mediaHeight ? mediaWidth + ' x ' + mediaHeight : null,
          info.videoCodec?.toUpperCase(),
          info.audioCodec?.toUpperCase(),
          info.bitrate ? Number(info.bitrate / 1000).toFixed(1) + ' Mbps' : null,
        ]
          .filter(Boolean)
          .join(' / ')
      : 'Choose a video to see media information.';
    $('delivery-information').textContent = info
      ? [
          info.format === 'local'
            ? 'Local file' + (next.localFileName ? ' (' + next.localFileName + ')' : '')
            : info.format === 'file'
              ? store.stream.ubuplayer
                ? 'Original file (UbuPlayer)'
                : 'Original file'
              : info.format === 'hls'
                ? ['audio-conversion', 'multiple-audio'].includes(info.reason)
                  ? 'Original picture, converted sound'
                  : 'Media server conversion'
                : uburoomPlayback.localFormat(info.format)
                  ? 'uburoom conversion'
                  : info.format,
          info.format === 'local'
            ? 'From this device (synced with room)'
            : next.mediaUrl
              ? next.directDelivery
                ? 'Direct from Plex'
                : 'Through uburoom'
              : null,
          info.encoder ? 'Encoder: ' + info.encoder : null,
          info.cpuFallback ? 'Using CPU fallback' : null,
          info.bitrateCeiling ? 'Requested limit: ' + Number(info.bitrateCeiling / 1000).toFixed(1) + ' Mbps' : null,
        ]
          .filter(Boolean)
          .join(' / ')
      : 'No playback delivery yet.';
  }
  function renderTracks() {
    const tracks = store.room.state?.tracks,
      available = !!tracks;
    const render = (id, rows, choices, value) => {
      const options = [
        ...choices,
        ...(rows || []).map(row => ({
          id: row.id,
          label: [uburoomPlayerUI.trackLabel(row), row.title].filter(Boolean).join(' — '),
          disabled: !row.available,
        })),
      ];
      const element = $(id),
        signature = JSON.stringify(options);
      if (element.dataset.options !== signature) {
        element.replaceChildren(
          ...options.map(row => {
            const option = document.createElement('option');
            option.value = row.id;
            option.textContent = row.label;
            option.disabled = !!row.disabled;
            return option;
          }),
        );
        element.dataset.options = signature;
      }
      const hasTracks = rows?.some(row => row.available);
      element.value = value || 'auto';
      if (element.selectedIndex < 0) element.value = 'auto';
      element.disabled = !available || !hasTracks || store.room.pending || store.stream.qualityPending;
      element.title = hasTracks ? '' : id === 'audio-track' ? 'No audio available' : 'No subtitles available';
    };
    const audioAvailable = tracks?.audio.some(row => row.available),
      subtitlesAvailable = tracks?.subtitles.some(row => row.available);
    render('audio-track', tracks?.audio, [{ id: 'auto', label: 'Automatic' }], tracks?.audioChoice);
    render(
      'subtitle-track',
      tracks?.subtitles,
      [{ id: 'auto', label: 'Automatic' }, ...(subtitlesAvailable ? [{ id: 'off', label: 'Off' }] : [])],
      tracks?.subtitleChoice,
    );
    const audio = tracks?.audio.find(row => row.id === tracks.audioId),
      subtitle = tracks?.subtitles.find(row => row.id === tracks.subtitleId),
      delivery = tracks?.subtitleDelivery || subtitle?.delivery,
      burned = delivery === 'burn';
    const mediaId = store.room.state?.mediaId;
    const nextSubtitleKey =
      available && subtitle && mediaId ? `${mediaId}:${subtitle.id}:${burned ? 'burn' : 'live'}` : '';
    if (nextSubtitleKey !== activeSubtitleKey) {
      activeSubtitleKey = nextSubtitleKey;
      const restored = burned || !subtitle || !mediaId ? 0 : deps.getSubtitleOffset?.(mediaId, subtitle) || 0;
      captions.setOffset(restored);
    }
    const autoBurned = burned && (tracks?.subtitleMode || 'auto') === 'auto';
    subtitleMode.querySelector('option[value="auto"]').textContent = autoBurned ? 'Automatic (burned in)' : 'Automatic';
    subtitleMode.value = tracks?.subtitleMode || 'auto';
    subtitleMode.disabled =
      !available ||
      store.room.state?.format === 'local' ||
      String(subtitle?.id || '').startsWith('local-') ||
      store.room.pending ||
      store.stream.qualityPending ||
      !subtitle;
    $('audio-track-status').textContent = !audioAvailable
      ? 'No audio available'
      : audio
        ? [
            uburoomPlayerUI.trackLabel(audio),
            (store.room.state.format !== 'file' ||
              (!!store.stream.ubuplayer && !store.stream.ubuplayer.audioPassthrough)) &&
              audio.channels !== 2 &&
              'Stereo playback',
          ]
            .filter(Boolean)
            .join(' · ')
        : '';
    for (const [id, track] of [
      ['audio-track-name', audio],
      ['subtitle-track-name', subtitle],
    ]) {
      $(id).textContent = track?.title || '';
      $(id).hidden = !track?.title;
    }
    if (!subtitlesAvailable) {
      $('subtitle-track-name').textContent = 'No subtitles available';
      $('subtitle-track-name').hidden = false;
    }
    const offsetValue = burned || !subtitle ? 0 : captions.offset || 0;
    const offsetInput = $('subtitle-offset');
    if (document.activeElement !== offsetInput) offsetInput.value = String(offsetValue);
    const offsetDisabled = !available || !subtitle || burned;
    offsetInput.disabled = offsetDisabled;
    if ($('subtitle-offset-back')) $('subtitle-offset-back').disabled = offsetDisabled;
    if ($('subtitle-offset-forward')) $('subtitle-offset-forward').disabled = offsetDisabled;
    if ($('subtitle-offset-reset')) $('subtitle-offset-reset').disabled = offsetDisabled || offsetValue === 0;
    $('subtitle-delay-hint').textContent = burned
      ? 'Timing is fixed for subtitles included in the video.'
      : subtitle
        ? 'Positive values show subtitles later.'
        : 'Select subtitles to adjust their timing.';
    $('track-status').textContent =
      store.player.trackActionError ||
      tracks?.subtitleError ||
      store.player.trackNotice ||
      (autoBurned
        ? 'These subtitles are burned into the video because they cannot be shown separately here.'
        : burned
          ? 'These subtitles are included in the video to preserve their appearance. The choice is saved for this title.'
          : '');
    const error = !!store.player.trackActionError || !!tracks?.subtitleError || store.player.trackNoticeError;
    $('track-status').classList.toggle('error', error);
    const subtitleError =
      tracks?.subtitleError ||
      (store.player.trackNoticeError ? store.player.trackNotice || 'subtitle-renderer-error' : undefined);
    const notice = subtitleError
      ? JSON.stringify([store.room.state?.mediaVersion, tracks?.subtitleId, subtitleError])
      : undefined;
    if (notice && notice !== store.player.subtitleErrorNotice) {
      deps.toasts.show('subtitle-error', {
        type: 'error',
        title: 'Subtitles could not be shown.',
        hint: 'Open Player settings for details.',
        symbol: 'subtitles-off',
      });
    }
    store.player.subtitleErrorNotice = notice;
    $('subtitle-retry').hidden = !store.player.trackNoticeError || !store.room.state?.subtitleUrl;
    const rep = $('plex-reporting-settings');
    if (rep) {
      rep.hidden = !store.room.state?.plexReporting?.eligible;
      if (!rep.hidden) {
        $('plex-reporting-activity').checked = !!store.room.state.plexReporting.activity;
        $('plex-reporting-activity').disabled = store.room.pending;
        $('plex-reporting-watch-state').checked = !!store.room.state.plexReporting.watchState;
        $('plex-reporting-watch-state').disabled =
          store.room.pending || !store.room.state.plexReporting.watchStateAllowed;
      }
    }
    deps.renderUbuPlayerSetting?.();
    renderRichPresence();
    renderLocalSourceControls();
    const isEmbed = store.room.state?.format === 'youtube-embed';
    const audioModeSelect = $('audio-mode');
    if (audioModeSelect) {
      audioModeSelect.disabled = isEmbed;
      const group = $('audio-mode-group');
      if (group) {
        for (const btn of group.querySelectorAll('button')) btn.disabled = isEmbed;
      }
      const hint = $('audio-mode-hint');
      if (hint) {
        if (isEmbed) hint.textContent = 'Audio mode is unavailable for YouTube embeds.';
        else {
          const mode = store.preferences.playerPreferences?.audioMode || 'normal';
          hint.textContent =
            mode === 'dialogue'
              ? 'Boosts speech clarity and vocal frequencies.'
              : mode === 'night'
                ? 'Compresses loud peaks and lifts quiet audio for night listening.'
                : 'Original dynamic range and audio balance.';
        }
      }
    }
    store.player.playerUI?.render();
  }
  function renderRichPresence() {
    const rpSettings = $('discord-rich-presence-settings');
    const rpInput = $('discord-rich-presence');
    if (!rpSettings || !rpInput) return;
    const allowed = !!deps.activity && store.identity.config?.discordRichPresence !== false;
    rpSettings.hidden = !allowed;
    if (!allowed) return;
    rpInput.checked = !!store.preferences.playerPreferences?.discordRichPresence;
    rpInput.disabled = richPresencePending;
  }
  async function changeTrack(args, context = store.player.trackContext, burnKey = undefined) {
    if (
      !store.room.state ||
      store.room.pending ||
      store.stream.qualityPending ||
      !context ||
      context.mediaVersion !== store.room.state.mediaVersion ||
      context.streamVersion !== store.room.state.streamVersion
    )
      return;
    store.player.trackActionError = '';
    const state = store.room.state;
    const activeLocal =
      state.format === 'local' && store.stream.localFile?.mediaVersion === state.mediaVersion
        ? store.stream.localFile
        : null;
    if (activeLocal && args.audioId !== undefined) {
      const targetAudio =
        args.audioId === 'auto'
          ? activeLocal.probed.audioTracks.find(a => a.default)?.id || activeLocal.probed.audioTracks[0]?.id || null
          : args.audioId;
      activeLocal.audioId = targetAudio;
      store.stream.ubuplayer?.selectAudio(targetAudio);
      deps.applyState(store.room.state, true);
      if (args.subtitleId === undefined && args.subtitleMode === undefined && args.subtitleOffset === undefined) {
        renderTracks();
        return;
      }
    }
    if (args.subtitleId !== undefined) {
      const subId = args.subtitleId;
      if (subId === 'local-sidecar' && store.stream.localSidecarSubtitle?.mediaVersion === state.mediaVersion) {
        if (activeLocal) activeLocal.subtitleId = 'local-sidecar';
        store.stream.ubuplayer?.selectSubtitle(null);
        await captions.setLocalSubtitle(store.stream.localSidecarSubtitle.spec);
        deps.applyState({ ...state, subtitleUrl: undefined }, true);
        renderTracks();
        return;
      }
      if (String(subId).startsWith('local-s-') && activeLocal) {
        activeLocal.subtitleId = subId;
        store.stream.ubuplayer?.selectSubtitle(subId);
        deps.applyState({ ...state, subtitleUrl: undefined }, true);
        renderTracks();
        return;
      }
      if (activeLocal) {
        activeLocal.subtitleId = subId;
        store.stream.ubuplayer?.selectSubtitle(null);
      }
      if (store.stream.localSidecarSubtitle && subId !== 'local-sidecar') {
        await captions.setLocalSubtitle(null);
      }
      if (activeLocal && subId === 'off' && !state.subtitleUrl) {
        await captions.setLocalSubtitle(null);
        deps.applyState(state, true);
        renderTracks();
        return;
      }
    }
    try {
      const serverArgs = { ...args };
      if (activeLocal) delete serverArgs.audioId;
      if (!Object.keys(serverArgs).length) {
        renderTracks();
        return;
      }
      const result = await deps.execute({ action: 'media.tracks.set', args: { ...context, ...serverArgs } });
      if (result.status === 'applied') {
        if (burnKey) lastBurnFallbackKey = burnKey;
        deps.rememberPlayerSubtitles(args);
      }
    } catch (error) {
      store.player.trackActionError = error.message;
      deps.fail(error.message);
    } finally {
      renderTracks();
    }
  }
  function activeSubtitleContext() {
    const state = store.room.state;
    const tracks = state?.tracks;
    const subtitle = tracks?.subtitles.find(row => row.id === tracks.subtitleId);
    const delivery = tracks?.subtitleDelivery || subtitle?.delivery;
    const burned = store.room.state?.format !== 'local' && delivery === 'burn';
    return { state, tracks, subtitle, burned };
  }
  function applySubtitleOffset(value, { persist = true, announce = false } = {}) {
    const { state, subtitle, burned } = activeSubtitleContext();
    if (!state || !subtitle || burned) return false;
    const next = normalizeSubtitleOffset(value, captions.offset || 0);
    captions.setOffset(next);
    if (persist && state.mediaId) deps.setSubtitleOffset?.(state.mediaId, subtitle, next);
    renderTracks();
    if (announce) {
      deps.toasts?.show('subtitle-offset', {
        title: 'Subtitle sync ' + formatSubtitleOffset(next),
        hint: next > 0 ? 'Shown later' : next < 0 ? 'Shown earlier' : 'Default timing',
        symbol: 'subtitles',
        duration: 2500,
      });
    }
    return true;
  }
  function adjustSubtitleOffset({ delta = 0, reset = false, announce = false } = {}) {
    const { state, subtitle, burned } = activeSubtitleContext();
    if (!state?.mediaUrl || !subtitle || burned) return false;
    const target = reset ? 0 : (captions.offset || 0) + delta;
    return applySubtitleOffset(target, { persist: true, announce });
  }
  $('audio-track').addEventListener('change', () => void changeTrack({ audioId: $('audio-track').value }));
  $('subtitle-track').addEventListener('change', () => void changeTrack({ subtitleId: $('subtitle-track').value }));
  $('subtitle-offset').addEventListener('input', () => {
    const input = $('subtitle-offset');
    if (input.value.trim() === '') return;
    const numeric = Number(input.value);
    if (!Number.isFinite(numeric)) return;
    applySubtitleOffset(numeric, { persist: true });
  });
  $('subtitle-offset').addEventListener('change', () => {
    const input = $('subtitle-offset');
    const { state, subtitle, burned } = activeSubtitleContext();
    if (!state || !subtitle || burned) return;
    const raw = input.value.trim();
    const next = raw === '' ? 0 : normalizeSubtitleOffset(Number(raw), captions.offset || 0);
    input.value = String(next);
    applySubtitleOffset(next, { persist: true });
  });
  $('subtitle-offset-back')?.addEventListener('click', () => {
    applySubtitleOffset((captions.offset || 0) - 0.5, { persist: true });
  });
  $('subtitle-offset-forward')?.addEventListener('click', () => {
    applySubtitleOffset((captions.offset || 0) + 0.5, { persist: true });
  });
  $('subtitle-offset-reset')?.addEventListener('click', () => {
    const wasFocused = document.activeElement === $('subtitle-offset-reset');
    applySubtitleOffset(0, { persist: true });
    if (wasFocused && $('subtitle-offset-reset')?.disabled) $('subtitle-offset')?.focus();
  });
  $('subtitle-mode').addEventListener('change', () => void changeTrack({ subtitleMode: $('subtitle-mode').value }));
  $('plex-reporting-activity')?.addEventListener('change', () => {
    deps
      .execute({ action: 'media.reporting.set', args: { activity: $('plex-reporting-activity').checked } })
      .catch(error => {
        deps.fail(error.message);
        renderTracks();
      });
  });
  $('plex-reporting-watch-state')?.addEventListener('change', () => {
    deps
      .execute({ action: 'media.reporting.set', args: { watchState: $('plex-reporting-watch-state').checked } })
      .catch(error => {
        deps.fail(error.message);
        renderTracks();
      });
  });
  renderRichPresence();
  $('discord-rich-presence')?.addEventListener('change', async () => {
    const input = $('discord-rich-presence');
    if (!input) return;
    const wanted = !!input.checked;
    if (!wanted) {
      deps.savePlayerPreferences?.({ discordRichPresence: false });
      await deps.setRichPresenceEnabled?.(false);
      renderRichPresence();
      return;
    }
    if (!deps.activity || store.identity.config?.discordRichPresence === false) {
      input.checked = false;
      renderRichPresence();
      return;
    }
    richPresencePending = true;
    input.disabled = true;
    const anchor = input.closest?.('.watch-switch-label') || input;
    try {
      const granted = await deps.requestRichPresenceScope?.();
      if (!granted) {
        input.checked = false;
        deps.savePlayerPreferences?.({ discordRichPresence: false });
        await deps.setRichPresenceEnabled?.(false);
        uburoomPopover.show(anchor, {
          text: 'Discord permission was not granted.',
          state: 'error',
          duration: 3500,
        });
        return;
      }
      deps.savePlayerPreferences?.({ discordRichPresence: true });
      await deps.setRichPresenceEnabled?.(true);
    } catch {
      input.checked = false;
      deps.savePlayerPreferences?.({ discordRichPresence: false });
      await deps.setRichPresenceEnabled?.(false);
      uburoomPopover.show(anchor, {
        text: 'Could not enable Discord Rich Presence.',
        state: 'error',
        duration: 3500,
      });
    } finally {
      richPresencePending = false;
      renderRichPresence();
    }
  });
  $('subtitle-retry').addEventListener('click', () => captions.retry());
  $('subtitle-color-preset')?.addEventListener('change', () => {
    const val = $('subtitle-color-preset').value;
    if (val !== 'custom') {
      deps.savePlayerPreferences({ subtitleColor: val });
      deps.applySubtitleAppearance();
    } else {
      $('subtitle-color-hex')?.focus();
      $('subtitle-color-hex')?.select();
    }
  });
  function onSubtitleHexChange() {
    let val = $('subtitle-color-hex').value.trim();
    if (!val.startsWith('#')) val = '#' + val;
    if (/^#[0-9a-f]{6}$/i.test(val)) {
      deps.savePlayerPreferences({ subtitleColor: val.toLowerCase() });
      deps.applySubtitleAppearance();
    }
  }
  $('subtitle-color-hex')?.addEventListener('input', onSubtitleHexChange);
  $('subtitle-color-hex')?.addEventListener('change', onSubtitleHexChange);
  $('subtitle-color-picker')?.addEventListener('input', () => {
    deps.savePlayerPreferences({ subtitleColor: $('subtitle-color-picker').value.toLowerCase() });
    deps.applySubtitleAppearance();
  });
  $('subtitle-color-picker')?.addEventListener('change', () => {
    deps.savePlayerPreferences({ subtitleColor: $('subtitle-color-picker').value.toLowerCase() });
    deps.applySubtitleAppearance();
  });
  for (const [id, key] of [
    ['subtitle-size', 'subtitleSize'],
    ['subtitle-position', 'subtitlePosition'],
  ])
    $(id).addEventListener('change', () => {
      deps.savePlayerPreferences({ [key]: $(id).value });
      deps.applySubtitleAppearance();
    });
  $('subtitle-bg')?.addEventListener('change', () => {
    deps.savePlayerPreferences({ subtitleBg: $('subtitle-bg').value });
    deps.applySubtitleAppearance();
  });
  function onSubtitleBrightnessChange() {
    const val = Math.max(20, Math.min(100, Number($('subtitle-brightness').value) || 100));
    deps.savePlayerPreferences({ subtitleBrightness: val });
    deps.applySubtitleAppearance();
  }
  $('subtitle-brightness')?.addEventListener('input', onSubtitleBrightnessChange);
  $('subtitle-brightness')?.addEventListener('change', onSubtitleBrightnessChange);
  return {
    adjustSubtitleOffset,
    applySubtitleOffset,
    captions,
    loadVideoCheck,
    renderMediaInformation,
    renderTracks,
    setSubtitleLoading,
    useRoomStream,
    videoCheck,
  };
}
