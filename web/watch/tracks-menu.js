import * as uburoomIcons from '../icons.js';
import * as uburoomPlayback from '../playback-policy.js';
import * as uburoomPlayerUI from '../watch-player-ui.js';
import { uburoomSubtitles } from '../watch-subtitles.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Player settings: tracks (audio, subtitles, quality), subtitle loading and appearance controls, media information and the host video check. */
export function mount(host, deps) {
  // The server checks each video for hosts. They read it in Player settings and get one
  // toast per video when it finds a problem or warning. Viewers never request it.
  const videoCheck = { media: undefined, report: undefined, toasted: undefined, timer: undefined };
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
            store.player.playerUI.openDialog();
            $('video-check').scrollIntoView({ block: 'center' });
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
  let lastBurnFallbackKey = '';
  const captions = new uburoomSubtitles(
    deps.video,
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
        const key = `${store.room.state.mediaVersion}:${store.room.state.tracks.subtitleId}`;
        if (lastBurnFallbackKey !== key) {
          lastBurnFallbackKey = key;
          void changeTrack(
            { subtitleMode: 'burn' },
            { mediaVersion: store.room.state.mediaVersion, streamVersion: store.room.state.streamVersion },
          );
        }
      }
    },
    mediaTime =>
      store.player.sync.timelinePending || deps.video.readyState < 1
        ? deps.expected()
        : Number.isFinite(mediaTime)
          ? mediaTime
          : deps.video.currentTime,
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
  function renderMediaInformation(next) {
    if (!next) return;
    const info = next.deliveryInfo;
    const mediaWidth = deps.video.videoWidth || info?.width,
      mediaHeight = deps.video.videoHeight || info?.height;
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
          info.format === 'file'
            ? 'Original file'
            : info.format === 'hls'
              ? 'Plex streaming'
              : uburoomPlayback.localFormat(info.format)
                ? 'uburoom conversion'
                : info.format,
          next.mediaUrl ? (next.directDelivery ? 'Direct from Plex' : 'Through uburoom') : null,
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
    const autoBurned = burned && (tracks?.subtitleMode || 'auto') === 'auto';
    subtitleMode.querySelector('option[value="auto"]').textContent = autoBurned ? 'Automatic (burned in)' : 'Automatic';
    subtitleMode.value = tracks?.subtitleMode || 'auto';
    subtitleMode.disabled = !available || store.room.pending || store.stream.qualityPending || !subtitle;
    $('audio-track-status').textContent = !audioAvailable
      ? 'No audio available'
      : audio
        ? [
            uburoomPlayerUI.trackLabel(audio),
            store.room.state.format !== 'file' && audio.channels !== 2 && 'Stereo playback',
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
    if (document.activeElement !== $('subtitle-offset')) $('subtitle-offset').value = tracks?.subtitleOffset || 0;
    $('subtitle-offset').disabled = !available || store.room.pending || !subtitle || burned;
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
    store.player.playerUI?.render();
  }
  async function changeTrack(args, context = store.player.trackContext) {
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
    try {
      const result = await deps.execute({ action: 'media.tracks.set', args: { ...context, ...args } });
      if (result.status === 'applied') deps.rememberPlayerSubtitles(args);
    } catch (error) {
      store.player.trackActionError = error.message;
      deps.fail(error.message);
    } finally {
      renderTracks();
    }
  }
  $('audio-track').addEventListener('change', () => void changeTrack({ audioId: $('audio-track').value }));
  $('subtitle-track').addEventListener('change', () => void changeTrack({ subtitleId: $('subtitle-track').value }));
  $('subtitle-offset').addEventListener('change', () => {
    if ($('subtitle-offset').reportValidity()) void changeTrack({ subtitleOffset: $('subtitle-offset').valueAsNumber });
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
  return { captions, loadVideoCheck, renderMediaInformation, renderTracks, setSubtitleLoading, videoCheck };
}
