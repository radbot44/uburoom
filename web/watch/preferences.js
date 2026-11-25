import * as uburoom from '../../shared/engine.mjs';
import * as uburoomControls from '../watch-controls.js';
import * as uburoomPlayback from '../playback-policy.js';
import { subtitleRenderers } from '../subtitle-renderers.js';
import { normalizeSubtitleOffset } from '../watch-subtitles.js';
import { $ } from './page.js';
import { store } from './store.js';

const SUBTITLE_OFFSETS_KEY = 'uburoom.subtitleOffsets';
const MAX_SUBTITLE_OFFSETS = 100;

export function subtitleOffsetKey(mediaId, track) {
  const trackId = typeof track === 'string' || typeof track === 'number' ? String(track) : track?.id;
  if (!mediaId || !trackId || trackId === 'off' || trackId === 'auto') return '';
  return String(mediaId) + ':' + String(trackId);
}

export function createSubtitleOffsetStore(
  storage = typeof localStorage !== 'undefined' ? localStorage : undefined,
  limit = MAX_SUBTITLE_OFFSETS,
) {
  function load() {
    const map = new Map();
    try {
      const parsed = JSON.parse(storage?.getItem?.(SUBTITLE_OFFSETS_KEY) || 'null');
      if (!Array.isArray(parsed)) return map;
      for (const entry of parsed) {
        if (!Array.isArray(entry) || entry.length < 2) continue;
        const [key, raw] = entry;
        if (typeof key !== 'string' || !key) continue;
        const normalized = normalizeSubtitleOffset(raw, 0);
        if (normalized === 0) continue;
        map.delete(key);
        map.set(key, normalized);
      }
      while (map.size > limit) map.delete(map.keys().next().value);
    } catch {}
    return map;
  }
  function persist(map) {
    try {
      storage?.setItem?.(SUBTITLE_OFFSETS_KEY, JSON.stringify([...map.entries()]));
    } catch {}
  }
  return {
    get(mediaId, track) {
      const key = subtitleOffsetKey(mediaId, track);
      if (!key) return 0;
      const map = load();
      if (!map.has(key)) return 0;
      const value = map.get(key);
      // Promote actively restored tracks in the LRU without rewriting when already newest.
      if ([...map.keys()].at(-1) !== key) {
        map.delete(key);
        map.set(key, value);
        persist(map);
      }
      return value;
    },
    set(mediaId, track, offset) {
      const key = subtitleOffsetKey(mediaId, track);
      if (!key) return 0;
      const normalized = normalizeSubtitleOffset(offset, 0);
      const map = load();
      if (normalized === 0) {
        if (map.delete(key)) persist(map);
        return 0;
      }
      map.delete(key);
      map.set(key, normalized);
      while (map.size > limit) map.delete(map.keys().next().value);
      persist(map);
      return normalized;
    },
  };
}

/* Saved viewer preferences: volume, quality, HDR, UbuPlayer, subtitles and audio language, subtitle appearance, audio mode and the sync correction mode; what this tab says about itself when it joins. */
export function mount(host, deps) {
  const playerPreferenceKey = 'uburoom.player';
  store.preferences.playerPreferences = {
    volume: 30,
    muted: false,
    quality: '720p4',
    useUbuPlayer: true,
    subtitleColor: '#ffffff',
    subtitleBg: 'shadow',
    subtitleSize: 'medium',
    subtitlePosition: 'video',
    subtitleBrightness: 100,
    plexReporting: true,
    plexWatchState: false,
    discordRichPresence: false,
    audioMode: 'normal',
    hdrMode: 'auto',
  };
  try {
    const saved = JSON.parse(localStorage.getItem(playerPreferenceKey) || 'null');
    if (saved && typeof saved === 'object') {
      if (Number.isFinite(saved.volume) && saved.volume >= 0 && saved.volume <= 100)
        store.preferences.playerPreferences.volume = saved.volume;
      if (typeof saved.muted === 'boolean') store.preferences.playerPreferences.muted = saved.muted;
      if (typeof saved.useUbuPlayer === 'boolean')
        store.preferences.playerPreferences.useUbuPlayer = saved.useUbuPlayer;
      if (typeof saved.plexReporting === 'boolean')
        store.preferences.playerPreferences.plexReporting = saved.plexReporting;
      if (typeof saved.plexWatchState === 'boolean')
        store.preferences.playerPreferences.plexWatchState = saved.plexWatchState;
      if (typeof saved.discordRichPresence === 'boolean')
        store.preferences.playerPreferences.discordRichPresence = saved.discordRichPresence;
      if (['normal', 'dialogue', 'night'].includes(saved.audioMode))
        store.preferences.playerPreferences.audioMode = saved.audioMode;
      if (['auto', 'hdr', 'sdr'].includes(saved.hdrMode)) store.preferences.playerPreferences.hdrMode = saved.hdrMode;
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

  function operatorAllowsUbuPlayer() {
    return store.identity.config?.ubuplayer !== false;
  }
  function canUseUbuPlayer(options = {}) {
    return (
      operatorAllowsUbuPlayer() &&
      store.preferences.playerPreferences.useUbuPlayer !== false &&
      uburoomPlayback.supportsUbuPlayer(options)
    );
  }
  function canGpuTonemap() {
    return canUseUbuPlayer() && uburoomPlayback.supportsGpuTonemap();
  }
  function renderUbuPlayerSetting() {
    const field = $('ubuplayer-settings'),
      toggle = $('ubuplayer-enabled'),
      hint = $('ubuplayer-hint');
    if (!field || !toggle) return;
    const operatorAllowed = operatorAllowsUbuPlayer();
    field.hidden = !operatorAllowed;
    if (!operatorAllowed) return;
    const browserSupported = uburoomPlayback.supportsUbuPlayer();
    const localOnlySupported = !browserSupported && uburoomPlayback.supportsUbuPlayer({ localFile: true });
    toggle.disabled = !browserSupported;
    toggle.checked = browserSupported && store.preferences.playerPreferences.useUbuPlayer !== false;
    if (hint) {
      hint.textContent = localOnlySupported
        ? 'Native fullscreen is used for room streams on iPhone; UbuPlayer remains available for local files.'
        : !browserSupported
          ? 'Unavailable in this browser (requires WebCodecs, AudioWorklet, and OffscreenCanvas).'
          : toggle.checked
            ? 'Plays additional video formats, surround sound, and HDR directly in your browser. Required for local files.'
            : 'Off in this browser; uburoom converts unsupported formats on the server instead.';
    }
  }

  let restoredPlayerSubtitles,
    restoringPlayerSubtitles = false;
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
      restoringPlayerSubtitles ||
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
    if (!Object.keys(args).length) {
      restoredPlayerSubtitles = key;
      return;
    }
    restoringPlayerSubtitles = true;
    try {
      const result = await deps.execute({
        action: 'media.tracks.set',
        args: { mediaVersion: next.mediaVersion, streamVersion: next.streamVersion, ...args },
      });
      if (!result || result.status === 'applied') restoredPlayerSubtitles = key;
    } catch (error) {
      deps.fail(error.message);
    } finally {
      restoringPlayerSubtitles = false;
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
    const ubuActive = canUseUbuPlayer();
    const gpuActive = canGpuTonemap();
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
      ubuplayer: ubuActive,
      gpuTonemap: gpuActive,
      clientRemux: ubuActive,
      ...(ubuActive &&
      store.stream.localFile?.mediaVersion &&
      store.stream.localFile.mediaVersion === store.room.state?.mediaVersion
        ? { delivery: 'local' }
        : {}),
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
    const preview = $('subtitle-preview');
    if (preview) {
      preview.style.setProperty('--subtitle-color', color);
      preview.style.setProperty('--subtitle-brightness', (brightness / 100).toFixed(2));
      preview.dataset.subtitleBg = bg;
      preview.dataset.subtitleSize = store.preferences.playerPreferences.subtitleSize || 'medium';
    }
  }
  applySubtitleAppearance();
  let audioContext, audioSourceNode, speechFilterNode, compressorNode, makeupGainNode;
  const audioModeHints = {
    normal: 'Original dynamic range and audio balance.',
    dialogue: 'Boosts speech clarity and vocal frequencies.',
    night: 'Compresses loud peaks and lifts quiet audio for night listening.',
  };
  function ensureAudioChainNodes() {
    if (speechFilterNode && audioContext) return true;
    if (typeof window === 'undefined') return false;
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx || typeof AudioCtx !== 'function') return false;
    try {
      if (!audioContext) audioContext = new AudioCtx();
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

      speechFilterNode.connect(compressorNode);
      compressorNode.connect(makeupGainNode);
      makeupGainNode.connect(audioContext.destination);
      return true;
    } catch (error) {
      deps.diagnostics?.record?.('failure', { category: 'media', detail: 'audio-enhancement', reason: error.message });
      return false;
    }
  }
  function initVideoAudioGraph() {
    if (!ensureAudioChainNodes()) return false;
    if (audioSourceNode) return true;
    if (!deps.video || typeof audioContext.createMediaElementSource !== 'function') return false;
    try {
      audioSourceNode = audioContext.createMediaElementSource(deps.video);
      audioSourceNode.connect(speechFilterNode);
      return true;
    } catch (error) {
      deps.diagnostics?.record?.('failure', { category: 'media', detail: 'audio-enhancement', reason: error.message });
      return false;
    }
  }
  function ensureAudioProcessingInput() {
    if (!ensureAudioChainNodes()) return undefined;
    applyAudioChainParameters(store.preferences.playerPreferences.audioMode || 'normal');
    // DynamicsCompressorNode in WebAudio introduces a fixed 6.0 ms lookahead delay when connected.
    return { audioContext, destination: speechFilterNode, downstreamAudioLatencySec: 0.006 };
  }
  function resumeAudioContext() {
    if (store.room.state?.format === 'youtube-embed') return;
    if (audioContext && audioContext.state === 'suspended') {
      audioContext.resume().catch(() => {});
    }
  }
  function applyAudioChainParameters(targetMode) {
    if (!speechFilterNode || !compressorNode || !makeupGainNode || !audioContext) return;
    const now = audioContext.currentTime;
    const workerSurroundDialogue = Boolean(store.stream.ubuplayer?.surroundDialogueActive);
    if (targetMode === 'normal') {
      speechFilterNode.gain.setValueAtTime(0, now);
      compressorNode.threshold.setValueAtTime(0, now);
      compressorNode.ratio.setValueAtTime(1, now);
      makeupGainNode.gain.setValueAtTime(1.0, now);
    } else if (targetMode === 'dialogue') {
      // Skip redundant 2.5 kHz stereo EQ when UbuPlayer is boosting the discrete 5.1/7.1 Center channel.
      speechFilterNode.gain.setValueAtTime(workerSurroundDialogue ? 0 : 5.0, now);
      compressorNode.threshold.setValueAtTime(-20, now);
      compressorNode.knee.setValueAtTime(12, now);
      compressorNode.ratio.setValueAtTime(workerSurroundDialogue ? 3.0 : 4.0, now);
      compressorNode.attack.setValueAtTime(0.005, now);
      compressorNode.release.setValueAtTime(0.2, now);
      makeupGainNode.gain.setValueAtTime(workerSurroundDialogue ? 1.05 : 1.1, now);
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
  function applyAudioMode(mode) {
    const targetMode = ['normal', 'dialogue', 'night'].includes(mode)
      ? mode
      : store.preferences.playerPreferences.audioMode || 'normal';
    const select = $('audio-mode');
    const hint = $('audio-mode-hint');
    if (select && select.value !== targetMode) select.value = targetMode;
    if (hint) hint.textContent = audioModeHints[targetMode] || audioModeHints.normal;
    store.stream.ubuplayer?.setAudioMode?.(targetMode);
    const ubuActive = Boolean(deps.surface?.isUbuPlayer?.() || store.stream.ubuplayer);
    if (ubuActive) {
      if (!ensureAudioChainNodes()) return;
      resumeAudioContext();
      applyAudioChainParameters(targetMode);
      return;
    }
    if (targetMode === 'normal' && !audioSourceNode) return;
    if (!initVideoAudioGraph()) return;
    resumeAudioContext();
    applyAudioChainParameters(targetMode);
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
  syncButtonGroup('hdr-mode', 'hdr-mode-group');
  applySubtitleAppearance();
  applyAudioMode(store.preferences.playerPreferences.audioMode);
  renderUbuPlayerSetting();
  $('audio-mode')?.addEventListener('change', () => {
    const next = $('audio-mode').value;
    savePlayerPreferences({ audioMode: next });
    applyAudioMode(next);
  });
  $('ubuplayer-enabled')?.addEventListener('change', async () => {
    const enabled = Boolean($('ubuplayer-enabled').checked);
    savePlayerPreferences({ useUbuPlayer: enabled });
    renderUbuPlayerSetting();
    store.stream.ubuplayerFailed = undefined;
    store.stream.localFallbackAttempts = new Set();
    if (!enabled && (store.room.state?.format === 'local' || store.stream.localFile)) {
      await deps.useRoomStream?.();
    }
    if (store.room.state?.mediaId && store.room.state.mediaId !== 'demo') {
      const prevUrl = store.room.state.mediaUrl;
      try {
        await deps.execute({
          action: 'media.quality.set',
          args: {
            quality: store.preferences.preferredQuality,
            ubuplayer: canUseUbuPlayer(),
            gpuTonemap: canGpuTonemap(),
            reset: true,
          },
        });
        if (store.room.state && store.room.state.mediaUrl === prevUrl) {
          store.stream.mediaSource = undefined;
          deps.applyState(store.room.state, true);
        }
      } catch (error) {
        deps.fail(error.message);
      }
    }
    deps.renderTracks?.();
  });
  const screenHdr = typeof matchMedia === 'function' ? matchMedia('(dynamic-range: high)') : undefined;
  function renderHdrMode() {
    const mode = store.preferences.playerPreferences.hdrMode;
    if ($('hdr-mode').value !== mode) $('hdr-mode').value = mode;
    $('hdr-mode-hint').textContent =
      mode === 'hdr'
        ? 'Always HDR; your browser adjusts it for this screen.'
        : mode === 'sdr'
          ? 'uburoom converts HDR to SDR, even on HDR screens.'
          : 'HDR on HDR screens, SDR on others. This screen: ' +
            (uburoomPlayback.supportsHdrDisplay() ? 'HDR' : 'SDR') +
            '.';
  }
  // An HDR video at Original updates live on UbuPlayer, or requests a new stream when server-delivered.
  function reconsiderHdr() {
    const state = store.room.state,
      info = state?.deliveryInfo;
    const wantHdr = uburoomPlayback.supportsHdrDisplay(undefined, store.preferences.playerPreferences.hdrMode);
    if (store.stream.ubuplayer && (state?.format === 'file' || state?.format === 'local')) {
      store.stream.ubuplayer.setHdrTarget(wantHdr);
      return;
    }
    if (!info?.sourceHdr || store.preferences.preferredQuality !== 'direct') return;
    if (info.sourceHdrKind === 'dovi-p5' && !canGpuTonemap()) return;
    if (!!info.toneMapped !== wantHdr) return;
    store.stream.localFallbackAttempts = new Set();
    deps
      .execute({
        action: 'media.quality.set',
        args: {
          quality: store.preferences.preferredQuality,
          ubuplayer: canUseUbuPlayer(),
          gpuTonemap: canGpuTonemap(),
          reset: true,
        },
      })
      .catch(error => deps.fail(error.message));
  }
  renderHdrMode();
  $('hdr-mode').addEventListener('change', () => {
    savePlayerPreferences({ hdrMode: $('hdr-mode').value });
    renderHdrMode();
    reconsiderHdr();
  });
  // Turning Windows HDR on or off, or moving the window to another screen, changes what Auto means.
  screenHdr?.addEventListener('change', () => {
    renderHdrMode();
    if (store.preferences.playerPreferences.hdrMode === 'auto') reconsiderHdr();
  });
  const subtitleOffsets = createSubtitleOffsetStore();
  function getSubtitleOffset(mediaId, track) {
    return subtitleOffsets.get(mediaId, track);
  }
  function setSubtitleOffset(mediaId, track, offset) {
    return subtitleOffsets.set(mediaId, track, offset);
  }
  return {
    applyAudioMode,
    applySubtitleAppearance,
    canGpuTonemap,
    canUseUbuPlayer,
    ensureAudioProcessingInput,
    getSubtitleOffset,
    loadSyncPreference,
    operatorAllowsUbuPlayer,
    rememberPlayerSubtitles,
    renderUbuPlayerSetting,
    restorePlayerSubtitles,
    resumeAudioContext,
    savePlayerPreferences,
    setSubtitleOffset,
    viewerPreferences,
  };
}
