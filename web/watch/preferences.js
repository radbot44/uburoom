import * as uburoom from '../../shared/engine.mjs';
import * as uburoomControls from '../watch-controls.js';
import * as uburoomPlayback from '../playback-policy.js';
import { subtitleRenderers } from '../subtitle-renderers.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Saved viewer preferences: volume, quality, subtitles and audio language, subtitle appearance, audio mode and the sync correction mode; what this tab says about itself when it joins. */
export function mount(host, deps) {
  const playerPreferenceKey = 'uburoom.player';
  store.preferences.playerPreferences = {
    volume: 30,
    muted: false,
    quality: '720p4',
    subtitleColor: '#ffffff',
    subtitleBg: 'shadow',
    subtitleSize: 'medium',
    subtitlePosition: 'video',
    subtitleBrightness: 100,
    plexReporting: true,
    plexWatchState: false,
    audioMode: 'normal',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(playerPreferenceKey) || 'null');
    if (saved && typeof saved === 'object') {
      if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100)
        store.preferences.playerPreferences.volume = saved.volume;
      if (typeof saved.muted === 'boolean') store.preferences.playerPreferences.muted = saved.muted;
      if (typeof saved.plexReporting === 'boolean')
        store.preferences.playerPreferences.plexReporting = saved.plexReporting;
      if (typeof saved.plexWatchState === 'boolean')
        store.preferences.playerPreferences.plexWatchState = saved.plexWatchState;
      if (['normal', 'dialogue', 'night'].includes(saved.audioMode))
        store.preferences.playerPreferences.audioMode = saved.audioMode;
      if (uburoom.validQuality(saved.quality))
        store.preferences.playerPreferences.quality = uburoom.qualityId(saved.quality);
      if (['auto', 'burn'].includes(saved.subtitleMode))
        store.preferences.playerPreferences.subtitleMode = saved.subtitleMode;
      if (['auto', 'off'].includes(saved.subtitles?.choice))
        store.preferences.playerPreferences.subtitles = { choice: saved.subtitles.choice };
      else if (
        saved.subtitles?.choice === 'language' &&
        /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(saved.subtitles.language || '')
      )
        store.preferences.playerPreferences.subtitles = { choice: 'language', language: saved.subtitles.language };
      if (saved.audio?.choice === 'auto') store.preferences.playerPreferences.audio = { choice: 'auto' };
      else if (saved.audio?.choice === 'language' && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(saved.audio.language || ''))
        store.preferences.playerPreferences.audio = { choice: 'language', language: saved.audio.language };
      if (typeof saved.subtitleColor === 'string' && /^#[0-9a-f]{6}$/i.test(saved.subtitleColor))
        store.preferences.playerPreferences.subtitleColor = saved.subtitleColor.toLowerCase();
      if (['off', 'background', 'shadow'].includes(saved.subtitleBg))
        store.preferences.playerPreferences.subtitleBg = saved.subtitleBg;
      if (['small', 'medium', 'large'].includes(saved.subtitleSize))
        store.preferences.playerPreferences.subtitleSize = saved.subtitleSize;
      if (['video', 'player'].includes(saved.subtitlePosition))
        store.preferences.playerPreferences.subtitlePosition = saved.subtitlePosition;
      if (
        Number.isFinite(saved.subtitleBrightness) &&
        saved.subtitleBrightness >= 20 &&
        saved.subtitleBrightness <= 100
      )
        store.preferences.playerPreferences.subtitleBrightness = saved.subtitleBrightness;
    }
  } catch {}
  store.preferences.preferredQuality = store.preferences.playerPreferences.quality;
  let restoredPlayerSubtitles;
  function rememberPlayerSubtitles(args) {
    if (args.subtitleMode) savePlayerPreferences({ subtitleMode: args.subtitleMode });
    // The audio language is remembered the same way, so a new visit starts with it.
    if (args.audioId === 'auto') savePlayerPreferences({ audio: { choice: 'auto' } });
    else if (args.audioId !== undefined) {
      const track = store.room.state?.tracks?.audio.find(row => row.id === args.audioId);
      if (track?.language && !['und', 'unknown'].includes(track.language))
        savePlayerPreferences({ audio: { choice: 'language', language: track.language } });
    }
    if (args.subtitleId === undefined) return;
    if (['auto', 'off'].includes(args.subtitleId)) savePlayerPreferences({ subtitles: { choice: args.subtitleId } });
    else {
      const track = store.room.state?.tracks?.subtitles.find(row => row.id === args.subtitleId);
      if (track?.language && !['und', 'unknown'].includes(track.language))
        savePlayerPreferences({ subtitles: { choice: 'language', language: track.language } });
    }
  }
  async function restorePlayerSubtitles(next) {
    const key = next.id + ':' + next.mediaVersion;
    if (
      restoredPlayerSubtitles === key ||
      !next.tracks ||
      !next.mediaUrl ||
      store.room.pending ||
      store.stream.qualityPending ||
      !deps.time.clock.read().valid
    )
      return;
    const saved = store.preferences.playerPreferences.subtitles,
      tracks = next.tracks,
      args = {};
    const matches = tracks.subtitles.filter(row => row.available && row.language === saved?.language);
    const match = matches.find(row => row.id === tracks.subtitleId) || matches[0];
    const choice = saved?.choice === 'language' ? match?.id : saved?.choice;
    if (
      choice &&
      choice !== tracks.subtitleChoice &&
      !(choice !== 'off' && choice !== 'auto' && choice === tracks.subtitleId)
    )
      args.subtitleId = choice;
    const mode = store.preferences.playerPreferences.subtitleMode;
    if (['auto', 'burn'].includes(mode) && mode !== tracks.subtitleMode) args.subtitleMode = mode;
    restoredPlayerSubtitles = key;
    if (!Object.keys(args).length) return;
    try {
      await deps.execute({
        action: 'media.tracks.set',
        args: { mediaVersion: next.mediaVersion, streamVersion: next.streamVersion, ...args },
      });
    } catch (error) {
      deps.fail(error.message);
    }
  }

  function savePlayerPreferences(change) {
    Object.assign(store.preferences.playerPreferences, change);
    try {
      localStorage.setItem(playerPreferenceKey, JSON.stringify(store.preferences.playerPreferences));
    } catch {}
  }
  // What this tab says about itself when it joins a room.
  function viewerPreferences() {
    return {
      quality: store.preferences.preferredQuality,
      volume: Number(store.preferences.playerPreferences.volume),
      muted: !!store.preferences.playerPreferences.muted,
      plexReporting: !!store.preferences.playerPreferences.plexReporting,
      plexWatchState: !!store.preferences.playerPreferences.plexWatchState,
      // The saved subtitle choice goes with the join, so the first stream already has it.
      ...(store.preferences.playerPreferences.subtitles
        ? {
            subtitlePreference:
              store.preferences.playerPreferences.subtitles.choice === 'language'
                ? 'language:' + store.preferences.playerPreferences.subtitles.language
                : store.preferences.playerPreferences.subtitles.choice,
          }
        : {}),
      ...(store.preferences.playerPreferences.subtitleMode
        ? { subtitleMode: store.preferences.playerPreferences.subtitleMode }
        : {}),
      ...(store.preferences.playerPreferences.audio?.choice === 'language'
        ? { audioPreference: 'language:' + store.preferences.playerPreferences.audio.language }
        : {}),
      ...(subtitleRenderers.supported() ? { subtitles: 'browser' } : {}),
      codecs: Object.keys(uburoomPlayback.LOCAL_CODECS)
        .filter(
          codec =>
            typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(uburoomPlayback.LOCAL_CODECS[codec]),
        )
        .join(','),
    };
  }
  function applySubtitleAppearance() {
    const color = store.preferences.playerPreferences.subtitleColor || '#ffffff';
    const bg = store.preferences.playerPreferences.subtitleBg || 'shadow';
    const brightness = store.preferences.playerPreferences.subtitleBrightness ?? 100;
    const stage = $('stage');
    stage.style.setProperty('--subtitle-color', color);
    stage.dataset.subtitleBg = bg;
    stage.style.setProperty('--subtitle-brightness', (brightness / 100).toFixed(2));
    store.player.subtitleLayout();
    const preset = $('subtitle-color-preset');
    const hex = $('subtitle-color-hex');
    const picker = $('subtitle-color-picker');
    const bgSelect = $('subtitle-bg');
    const brightnessInput = $('subtitle-brightness');
    const brightnessValue = $('subtitle-brightness-value');
    if (hex && document.activeElement !== hex) hex.value = color;
    if (picker) picker.value = color;
    if (preset) {
      const match = [...preset.options].find(o => o.value.toLowerCase() === color.toLowerCase());
      preset.value = match ? match.value : 'custom';
    }
    if (bgSelect && bgSelect.value !== bg) bgSelect.value = bg;
    for (const [id, value] of [
      ['subtitle-size', store.preferences.playerPreferences.subtitleSize],
      ['subtitle-position', store.preferences.playerPreferences.subtitlePosition],
    ])
      if ($(id).value !== value) $(id).value = value;
    if (brightnessInput && document.activeElement !== brightnessInput) brightnessInput.value = brightness;
    if (brightnessValue) brightnessValue.textContent = brightness + '%';
  }
  applySubtitleAppearance();
  let audioContext, audioSourceNode, speechFilterNode, compressorNode, makeupGainNode;
  const audioModeHints = {
    normal: 'Original dynamic range and audio balance.',
    dialogue: 'Boosts speech clarity and vocal frequencies.',
    night: 'Compresses loud peaks and lifts quiet audio for night listening.',
  };
  function initAudioGraph() {
    if (audioSourceNode) return true;
    if (typeof window === 'undefined') return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || !deps.video || typeof AudioCtx !== 'function') return false;
    try {
      if (!audioContext) audioContext = new AudioCtx();
      if (typeof audioContext.createMediaElementSource !== 'function') return false;
      audioSourceNode = audioContext.createMediaElementSource(deps.video);

      speechFilterNode = audioContext.createBiquadFilter();
      speechFilterNode.type = 'peaking';
      speechFilterNode.frequency.value = 2500;
      speechFilterNode.Q.value = 1.2;
      speechFilterNode.gain.value = 0;

      compressorNode = audioContext.createDynamicsCompressor();
      compressorNode.threshold.value = 0;
      compressorNode.knee.value = 30;
      compressorNode.ratio.value = 1;
      compressorNode.attack.value = 0.003;
      compressorNode.release.value = 0.25;

      makeupGainNode = audioContext.createGain();
      makeupGainNode.gain.value = 1.0;

      audioSourceNode.connect(speechFilterNode);
      speechFilterNode.connect(compressorNode);
      compressorNode.connect(makeupGainNode);
      makeupGainNode.connect(audioContext.destination);
      return true;
    } catch (error) {
      deps.diagnostics?.record?.('failure', { category: 'media', detail: 'audio-enhancement', reason: error.message });
      return false;
    }
  }
  function resumeAudioContext() {
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }
  function applyAudioMode(mode) {
    const targetMode = ['normal', 'dialogue', 'night'].includes(mode)
      ? mode
      : store.preferences.playerPreferences.audioMode || 'normal';
    const select = $('audio-mode');
    const hint = $('audio-mode-hint');
    if (select && select.value !== targetMode) select.value = targetMode;
    if (hint) hint.textContent = audioModeHints[targetMode] || audioModeHints.normal;
    if (targetMode === 'normal' && !audioSourceNode) return;
    if (!initAudioGraph()) return;
    resumeAudioContext();
    const now = audioContext.currentTime;
    if (targetMode === 'normal') {
      speechFilterNode.gain.setValueAtTime(0, now);
      compressorNode.threshold.setValueAtTime(0, now);
      compressorNode.ratio.setValueAtTime(1, now);
      makeupGainNode.gain.setValueAtTime(1.0, now);
    } else if (targetMode === 'dialogue') {
      speechFilterNode.gain.setValueAtTime(5.0, now);
      compressorNode.threshold.setValueAtTime(-20, now);
      compressorNode.knee.setValueAtTime(12, now);
      compressorNode.ratio.setValueAtTime(4.0, now);
      compressorNode.attack.setValueAtTime(0.005, now);
      compressorNode.release.setValueAtTime(0.2, now);
      makeupGainNode.gain.setValueAtTime(1.1, now);
    } else if (targetMode === 'night') {
      speechFilterNode.gain.setValueAtTime(0, now);
      compressorNode.threshold.setValueAtTime(-28, now);
      compressorNode.knee.setValueAtTime(24, now);
      compressorNode.ratio.setValueAtTime(12.0, now);
      compressorNode.attack.setValueAtTime(0.003, now);
      compressorNode.release.setValueAtTime(0.25, now);
      makeupGainNode.gain.setValueAtTime(1.35, now);
    }
  }
  function renderSyncPreference() {
    $('sync-correction').value = store.preferences.syncCorrectionMode;
    $('sync-correction-hint').textContent =
      (store.preferences.syncCorrectionMode === 'jumps'
        ? 'Keep normal speed; occasionally skip or repeat a moment to catch up.'
        : 'Adjust playback speed to stay together, with jumps for larger gaps.') +
      (store.preferences.syncPreferenceStored
        ? ' Only your player in this browser.'
        : ' This tab only; browser storage is unavailable.');
  }
  function loadSyncPreference() {
    const key = 'uburoom.syncCorrection.' + (store.identity.me?.account?.id || 'browser');
    if (key === store.preferences.syncPreferenceKey) return;
    store.preferences.syncPreferenceKey = key;
    store.preferences.syncCorrectionMode = 'speed';
    store.preferences.syncPreferenceStored = true;
    try {
      if (localStorage.getItem(key) === 'jumps') store.preferences.syncCorrectionMode = 'jumps';
    } catch {
      store.preferences.syncPreferenceStored = false;
    }
    store.player.sync?.resetCorrection(true);
    renderSyncPreference();
  }
  function setSyncPreference(value) {
    if (value !== 'speed' && value !== 'jumps') return;
    store.preferences.syncCorrectionMode = value;
    store.player.sync?.resetCorrection(true);
    try {
      localStorage.setItem(store.preferences.syncPreferenceKey, value);
      store.preferences.syncPreferenceStored = true;
    } catch {
      store.preferences.syncPreferenceStored = false;
    }
    renderSyncPreference();
    deps.diagnosticSample('sync-mode');
  }
  $('sync-correction').addEventListener('change', event => setSyncPreference(event.target.value));
  function syncButtonGroup(selectId, groupId) {
    const select = $(selectId),
      group = $(groupId);
    if (!select || !group) return;
    uburoomControls.bindSelect(select, group);
  }
  syncButtonGroup('room-create-visibility', 'room-create-visibility-group');
  syncButtonGroup('room-create-preset', 'room-create-preset-group');
  syncButtonGroup('room-settings-visibility', 'room-settings-visibility-group');
  syncButtonGroup('room-permission-preset', 'room-permission-preset-group');
  syncButtonGroup('subtitle-bg', 'subtitle-bg-group');
  syncButtonGroup('subtitle-size', 'subtitle-size-group');
  syncButtonGroup('subtitle-position', 'subtitle-position-group');
  syncButtonGroup('audio-mode', 'audio-mode-group');
  applySubtitleAppearance();
  applyAudioMode(store.preferences.playerPreferences.audioMode);
  $('audio-mode')?.addEventListener('change', () => {
    const next = $('audio-mode').value;
    savePlayerPreferences({ audioMode: next });
    applyAudioMode(next);
  });
  return {
    applySubtitleAppearance,
    loadSyncPreference,
    rememberPlayerSubtitles,
    restorePlayerSubtitles,
    resumeAudioContext,
    savePlayerPreferences,
    viewerPreferences,
  };
}
