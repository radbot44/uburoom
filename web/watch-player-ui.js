import * as uburoomDialogs from './watch-dialogs.js';
import * as uburoomIcons from './icons.js';
import * as uburoomPlayback from './playback-policy.js';

/* Player menus and pointer interaction; playback still uses the shared command engine. */
function trackLabel(track) {
  let language = ['und', 'unknown'].includes(track.languageName?.toLowerCase()) ? undefined : track.languageName;
  const code =
    language && /^[a-z]{2,3}(?:-[a-z0-9]+)*$/i.test(language) ? language : !language ? track.language : undefined;
  if (code && !['und', 'unknown'].includes(code)) {
    try {
      language = new Intl.DisplayNames(['en'], { type: 'language' }).of(code);
    } catch {}
  }
  const channels =
    track.channels === 1
      ? 'Mono'
      : track.channels === 2
        ? 'Stereo'
        : track.channels === 6
          ? '5.1'
          : track.channels === 8
            ? '7.1'
            : track.channels
              ? track.channels + ' ch'
              : '';
  const codec = /^pcm/.test(track.codec || '') ? 'PCM' : track.codec?.toUpperCase();
  return [
    language || 'Unknown',
    codec,
    channels,
    track.forced && 'Forced',
    track.sdh && 'SDH',
    track.commentary && 'Commentary',
    track.description && 'Audio description',
    !track.available && 'Unavailable',
  ]
    .filter(Boolean)
    .join(' · ');
}
function mount({ getState, execute, fail, beforeSettings, afterSettings, changeTrack, captions }) {
  const $ = id => document.getElementById(id),
    stage = $('stage'),
    cog = $('tracks-open'),
    dialog = $('tracks-dialog');
  const mobile = () => document.body.dataset.layout === 'phone';
  const menu = document.createElement('div');
  menu.id = 'player-settings-menu';
  menu.className = 'player-settings-menu';
  menu.popover = 'manual';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Player settings');
  stage.append(menu);
  const mainMenu = document.createElement('div');
  mainMenu.className = 'settings-main';
  menu.append(mainMenu);
  const submenu = document.createElement('div');
  submenu.id = 'player-settings-choices';
  submenu.className = 'settings-submenu';
  submenu.setAttribute('role', 'menu');
  submenu.inert = true;
  submenu.setAttribute('aria-hidden', 'true');
  menu.append(submenu);
  const options = document.createElement('div');
  options.className = 'settings-options';
  submenu.append(options);
  const badge = document.createElement('span');
  badge.id = 'quality-badge';
  badge.classList.add('quality-badge');
  badge.setAttribute('aria-hidden', 'true');
  cog.append(badge);
  const spinner = document.createElement('span');
  spinner.id = 'captions-spinner';
  spinner.classList.add('captions-spinner');
  spinner.setAttribute('aria-hidden', 'true');
  spinner.append(uburoomIcons.icon(document, 'loader-4'));
  const choices = [
    ['quality', 'Quality'],
    ['audio-track', 'Audio track'],
    ['audio-mode', 'Audio mode'],
    ['chapters', 'Chapters'],
    ['subtitle-track', 'Subtitle track'],
  ];
  const rows = [];
  let opened = false,
    activeChoice,
    choiceSignature,
    chromeTimer,
    tapTimer,
    feedbackTimer,
    press,
    taps,
    lastSubtitle,
    touching = false,
    volumeOpen = false;
  function layoutCaptions() {
    const transport = stage.querySelector('.transport');
    captions.layout(getComputedStyle(transport).pointerEvents !== 'none' ? transport.offsetHeight : 0);
  }
  const captionLayoutObserver = new ResizeObserver(layoutCaptions);
  captionLayoutObserver.observe(stage.querySelector('.transport'));
  for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout'])
    stage.addEventListener(event, () => requestAnimationFrame(layoutCaptions));
  function button(parent, label) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    parent.append(b);
    return b;
  }
  for (const [id, label] of choices) {
    const row = button(mainMenu, label);
    row.id = 'settings-' + id;
    row.setAttribute('role', 'menuitem');
    row.setAttribute('aria-haspopup', 'menu');
    row.setAttribute('aria-expanded', 'false');
    row.setAttribute('aria-controls', submenu.id);
    const value = document.createElement('span');
    value.className = 'settings-value';
    row.append(value, uburoomIcons.icon(document, 'right'));
    row.onclick = () => openChoices(id);
    rows.push({ id, row, value });
  }
  const more = button(mainMenu, 'More settings');
  more.id = 'settings-more';
  more.setAttribute('role', 'menuitem');
  more.setAttribute('aria-haspopup', 'dialog');
  more.setAttribute('aria-controls', dialog.id);
  more.append(uburoomIcons.icon(document, 'settings'));
  more.onclick = openDialog;
  const back = button(submenu, 'Back');
  back.id = 'settings-back';
  back.classList.add('settings-back');
  back.setAttribute('role', 'menuitem');
  back.prepend(uburoomIcons.icon(document, 'left'));
  back.onclick = backToSettings;
  function placeMenu() {
    if (!opened) return;
    const anchor = cog.getBoundingClientRect(),
      width = menu.getBoundingClientRect().width,
      scale = width / menu.offsetWidth;
    const height =
      Math.min(
        activeChoice ? options.scrollHeight + back.offsetHeight : mainMenu.scrollHeight,
        340,
        Math.max(40, anchor.top / scale - 28),
      ) + 14;
    // Position and height go to the stylesheet as --x, --y and --menu-height (tracks-menu.css).
    menu.style.setProperty('--menu-height', height + 'px');
    const left = Math.max(8, Math.min(innerWidth - width - 8, anchor.right - width));
    menu.style.setProperty('--x', left / scale + 'px');
    menu.style.setProperty('--y', Math.max(8, anchor.top - menu.offsetHeight * scale - 8) / scale + 'px');
  }
  function closeSettings(focus = false) {
    if (opened) menu.hidePopover();
    opened = false;
    activeChoice = undefined;
    choiceSignature = undefined;
    menu.classList.remove('show-choices');
    mainMenu.inert = false;
    mainMenu.removeAttribute('aria-hidden');
    submenu.inert = true;
    submenu.setAttribute('aria-hidden', 'true');
    rows.forEach(({ row }) => row.setAttribute('aria-expanded', 'false'));
    cog.setAttribute('aria-expanded', 'false');
    stage.classList.remove('settings-open');
    if (!dialog.open) afterSettings();
    if (focus) cog.focus();
    layoutCaptions();
  }
  function openDialog() {
    closeSettings();
    beforeSettings();
    uburoomDialogs.open(dialog, cog);
    stage.classList.add('settings-open');
    cog.setAttribute('aria-expanded', 'true');
    // Outside a room only the Notifications switch is shown.
    (document.body.classList.contains('outside-room') ? $('player-extras-notifications') : $('quality')).focus();
    showChrome();
  }
  function openSettings() {
    if (mobile()) return openDialog();
    if (opened) return closeSettings(true);
    beforeSettings();
    opened = true;
    menu.showPopover();
    stage.classList.add('settings-open');
    cog.setAttribute('aria-expanded', 'true');
    render();
    placeMenu();
    menu.querySelector('button:not(:disabled)')?.focus();
    showChrome();
  }
  function openChoices(id) {
    if ($(id).disabled) return;
    activeChoice = id;
    choiceSignature = undefined;
    mainMenu.inert = true;
    mainMenu.setAttribute('aria-hidden', 'true');
    submenu.inert = false;
    submenu.removeAttribute('aria-hidden');
    menu.classList.add('show-choices');
    submenu.setAttribute('aria-label', choices.find(choice => choice[0] === id)[1]);
    rows.forEach(({ id: other, row }) => row.setAttribute('aria-expanded', String(other === id)));
    renderChoices();
    placeMenu();
    submenu.querySelector('[aria-checked=true]:not(:disabled),button:not(:disabled)')?.focus();
  }
  function backToSettings() {
    const previous = activeChoice;
    activeChoice = undefined;
    choiceSignature = undefined;
    menu.classList.remove('show-choices');
    mainMenu.inert = false;
    mainMenu.removeAttribute('aria-hidden');
    submenu.inert = true;
    submenu.setAttribute('aria-hidden', 'true');
    rows.forEach(({ row }) => row.setAttribute('aria-expanded', 'false'));
    placeMenu();
    rows.find(r => r.id === previous)?.row.focus();
  }
  function renderChoices() {
    if (!activeChoice) return;
    const select = $(activeChoice),
      tracks = getState()?.tracks,
      audio = activeChoice === 'audio-track',
      isAudioMode = activeChoice === 'audio-mode',
      isChapters = activeChoice === 'chapters';
    const trackRows =
      activeChoice === 'quality' || isAudioMode || isChapters
        ? []
        : audio
          ? tracks?.audio || []
          : tracks?.subtitles || [];
    const resolved = audio ? tracks?.audioId : tracks?.subtitleId;
    const signature = JSON.stringify([
      select.value,
      select.disabled,
      resolved,
      trackRows,
      getState()?.fallbackActive,
      [...select.options].map(o => [o.value, o.textContent, o.disabled]),
    ]);
    if (signature === choiceSignature) return;
    choiceSignature = signature;
    const focused = options.contains(document.activeElement),
      previous = document.activeElement?.dataset.value,
      scrollTop = options.scrollTop;
    options.replaceChildren();
    const current = getState();
    if (activeChoice === 'quality' && current?.fallbackActive) {
      const status = document.createElement('p');
      status.className = 'settings-caption';
      status.setAttribute('role', 'status');
      status.textContent =
        'Using fallback · ' + current.fallbackStream.height + 'p · ' + current.fallbackStream.bitrate + ' Mbps';
      options.append(status);
    }
    for (const option of select.options) {
      const track = trackRows.find(row => row.id === option.value);
      const b = button(options, track ? trackLabel(track) : option.textContent);
      b.dataset.value = option.value;
      b.disabled = select.disabled || option.disabled;
      const captionText = track?.title || option.dataset.caption;
      if (captionText) {
        const caption = document.createElement('span');
        caption.className = 'settings-caption';
        caption.textContent = captionText;
        b.append(caption);
      }
      if (select.value === 'auto' && option.value === resolved) {
        const marker = document.createElement('span');
        marker.className = 'settings-auto';
        marker.textContent = 'Used by Automatic';
        b.append(marker);
      }
      if (
        option.value === 'auto' &&
        activeChoice === 'subtitle-track' &&
        !resolved &&
        trackRows.some(track => track.available)
      ) {
        const caption = document.createElement('span');
        caption.className = 'settings-caption';
        caption.textContent = 'Currently Off';
        b.append(caption);
      }
      b.setAttribute('role', 'menuitemradio');
      b.setAttribute('aria-checked', String(option.value === select.value));
      b.onclick = () => {
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        closeSettings(true);
      };
      if (focused && option.value === previous) b.focus();
    }
    options.scrollTop = scrollTop;
    if (focused && !options.contains(document.activeElement)) back.focus();
  }
  function render() {
    const state = getState(),
      tracks = state?.tracks;
    cog.setAttribute('aria-haspopup', mobile() ? 'dialog' : 'menu');
    cog.setAttribute('aria-controls', mobile() ? dialog.id : menu.id);
    badge.textContent = state?.fallbackActive
      ? 'FB'
      : state?.quality === 'direct'
        ? uburoomPlayback.convertedOriginal(state)
          ? 'MAX'
          : 'ORIG'
        : state?.quality?.startsWith('1080p')
          ? 'HD'
          : '';
    badge.hidden = !badge.textContent;
    const enabled = !!tracks?.subtitleId,
      available = tracks?.subtitles.some(t => t.available);
    const cc = $('captions-toggle');
    cc.disabled = !available || $('subtitle-track').disabled;
    cc.setAttribute('aria-pressed', String(enabled));
    cc.title = cc.ariaLabel = !available
      ? 'No subtitles available'
      : enabled
        ? 'Disable subtitles'
        : 'Enable subtitles';
    const symbol = enabled ? 'subtitles' : 'subtitles-off';
    if (cc.dataset.symbol !== symbol) {
      cc.replaceChildren(uburoomIcons.icon(document, symbol), spinner);
      cc.dataset.symbol = symbol;
    }
    if (!enabled && cc.dataset.loading === 'true') {
      cc.dataset.loading = 'false';
      cc.removeAttribute('aria-busy');
    }
    if (enabled) lastSubtitle = { media: state.mediaVersion, id: tracks.subtitleId };
    for (const { id, row, value } of rows) {
      const select = $(id),
        audio = id === 'audio-track',
        isAudioMode = id === 'audio-mode',
        isChapters = id === 'chapters';
      const track =
        id === 'quality' || isAudioMode || isChapters
          ? undefined
          : (audio ? tracks?.audio : tracks?.subtitles)?.find(
              track => track.id === (audio ? tracks?.audioId : tracks?.subtitleId),
            );
      const chapters = state?.chapters || [];
      const hasTracks =
        id === 'quality' || isAudioMode
          ? true
          : isChapters
            ? chapters.length > 0
            : (audio ? tracks?.audio : tracks?.subtitles)?.some(track => track.available);
      const canSeek = state?.capabilities ? state.capabilities.seek !== false : !!state?.canPlayback;
      row.disabled = isChapters ? chapters.length === 0 || !canSeek : select.disabled;
      value.textContent = isChapters
        ? chapters.length === 0
          ? 'None'
          : select.selectedOptions[0]?.textContent || chapters.length + ' chapters'
        : isAudioMode
          ? select.selectedOptions[0]?.textContent || 'Normal'
          : !hasTracks
            ? audio
              ? 'No audio available'
              : 'No subtitles available'
            : id === 'quality'
              ? select.selectedOptions[0]?.textContent || 'Unavailable'
              : track
                ? trackLabel(track)
                : tracks && !audio
                  ? 'Off'
                  : 'Unavailable';
      if (id === 'quality' && state?.fallbackActive) {
        const caption = document.createElement('span');
        caption.className = 'settings-caption';
        caption.textContent =
          'Using fallback · ' + state.fallbackStream.height + 'p · ' + state.fallbackStream.bitrate + ' Mbps';
        value.append(caption);
      }
      if (audio && state?.fallbackActive && tracks?.audioId !== state.fallbackStream.defaultAudioId)
        value.textContent = 'Default (fallback)';
      if (hasTracks && track?.title) {
        const caption = document.createElement('span');
        caption.className = 'settings-caption';
        caption.textContent = track.title;
        value.append(caption);
      }
      value.title = value.textContent;
    }
    if (opened) {
      renderChoices();
      placeMenu();
    }
    layoutCaptions();
  }
  $('captions-toggle').onclick = () => {
    const state = getState(),
      tracks = state?.tracks;
    if (!tracks) return;
    const available = tracks.subtitles.filter(t => t.available);
    const previous = lastSubtitle?.media === state.mediaVersion && available.find(t => t.id === lastSubtitle.id);
    const track = previous || available.find(t => t.selected) || available.find(t => t.default) || available[0];
    if (!track) return;
    void changeTrack(
      { subtitleId: tracks.subtitleId ? 'off' : track.id },
      { mediaVersion: state.mediaVersion, streamVersion: state.streamVersion },
    );
  };
  cog.onclick = openSettings;
  $('tracks-close').onclick = () => uburoomDialogs.close(dialog);
  dialog.addEventListener('close', () => {
    stage.classList.remove('settings-open');
    cog.setAttribute('aria-expanded', 'false');
    afterSettings();
    cog.focus();
    showChrome();
  });
  document.addEventListener('pointerdown', event => {
    if (opened && !menu.contains(event.target) && !cog.contains(event.target)) closeSettings();
  });
  menu.addEventListener('focusout', event => {
    if (opened && event.relatedTarget && !menu.contains(event.relatedTarget) && event.relatedTarget !== cog)
      closeSettings();
  });
  document.addEventListener('focusin', event => {
    if (opened && !menu.contains(event.target) && event.target !== cog) closeSettings();
  });
  menu.addEventListener('keydown', event => {
    const group = activeChoice ? submenu : mainMenu;
    const buttons = [...group.querySelectorAll('button:not(:disabled)')],
      index = buttons.indexOf(document.activeElement);
    if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? buttons.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    } else if (event.key === 'ArrowLeft' && activeChoice) {
      event.preventDefault();
      backToSettings();
    } else if (event.key === 'ArrowRight' && !activeChoice) {
      event.preventDefault();
      rows.find(r => r.row === document.activeElement)?.row.click();
    }
  });
  document.addEventListener(
    'keydown',
    event => {
      if (event.key === 'Escape' && opened) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeChoice) backToSettings();
        else closeSettings(true);
      }
      if (event.key === 'Tab') stage.classList.remove('touch-controls');
    },
    true,
  );
  let mouseTimer;
  function showChrome() {
    clearTimeout(chromeTimer);
    stage.classList.add('controls-visible');
    layoutCaptions();
    chromeTimer = setTimeout(() => {
      if (touching || opened || volumeOpen || dialog.open || stage.classList.contains('drawer-open'))
        return showChrome();
      stage.classList.remove('controls-visible');
      layoutCaptions();
    }, 2500);
  }
  // In fullscreen a resting mouse hides the controls and pointer, as in other players.
  function wakeMouse() {
    clearTimeout(mouseTimer);
    stage.classList.remove('mouse-idle');
    layoutCaptions();
    if (document.fullscreenElement !== stage) return;
    mouseTimer = setTimeout(() => {
      if (opened || dialog.open || stage.querySelector('.player-chrome:hover')) return wakeMouse();
      stage.classList.add('mouse-idle');
      layoutCaptions();
    }, 2500);
  }
  for (const event of ['pointermove', 'pointerdown'])
    stage.addEventListener(event, value => {
      if (value.pointerType === 'mouse') wakeMouse();
    });
  document.addEventListener('fullscreenchange', wakeMouse);
  function finishTaps() {
    clearTimeout(tapTimer);
    const sequence = taps;
    taps = undefined;
    const state = getState();
    if (
      !sequence ||
      sequence.count < 2 ||
      !state?.canPlayback ||
      state.id !== sequence.room ||
      state.epoch !== sequence.epoch ||
      state.mediaVersion !== sequence.media
    )
      return;
    void execute({
      action: 'media.seek.relative',
      args: { seconds: sequence.side * 15 * (sequence.count - 1) },
    }).catch(error => fail(error.message));
  }
  stage.addEventListener('pointerdown', event => {
    if (event.pointerType === 'mouse' || !event.isPrimary) return;
    touching = true;
    stage.classList.add('touch-controls');
    showChrome();
    if (event.target === $('video') || event.target === stage)
      press = { x: event.clientX, y: event.clientY, id: event.pointerId };
  });
  stage.addEventListener('pointercancel', () => {
    press = undefined;
    touching = false;
  });
  stage.addEventListener('pointerup', event => {
    touching = false;
    if (!press || press.id !== event.pointerId) return;
    const start = press;
    press = undefined;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 12) return;
    showChrome();
    const state = getState();
    if (!state?.mediaUrl || !state.canPlayback) return;
    const rect = stage.getBoundingClientRect(),
      x = (event.clientX - rect.left) / rect.width,
      side = x < 0.35 ? -1 : x > 0.65 ? 1 : 0;
    if (!side) return;
    if (taps && taps.side !== side) finishTaps();
    if (!taps) taps = { side, count: 0, room: state.id, epoch: state.epoch, media: state.mediaVersion };
    taps.count++;
    clearTimeout(tapTimer);
    tapTimer = setTimeout(finishTaps, 400);
    if (taps.count > 1) {
      const feedback = $('seek-feedback');
      feedback.textContent = (side < 0 ? '−' : '+') + (taps.count - 1) * 15 + ' seconds';
      feedback.dataset.side = side < 0 ? 'left' : 'right';
      feedback.hidden = false;
      clearTimeout(feedbackTimer);
      feedbackTimer = setTimeout(() => {
        feedback.hidden = true;
      }, 900);
    }
  });
  // Phone transport (600px wide and below): Notifications and Picture-in-Picture move into Player settings,
  // and the speaker button opens a vertical volume panel. The bar buttons stay the single source of truth;
  // the settings entries mirror them and act through them.
  const phone = matchMedia('(max-width: 600px)');
  const extras = document.createElement('section');
  extras.id = 'player-extras';
  extras.className = 'settings-group player-extras';
  const extrasTitle = document.createElement('h3');
  extrasTitle.textContent = 'Player';
  const notifyLabel = document.createElement('label');
  notifyLabel.className = 'watch-switch-label';
  const notify = document.createElement('input');
  notify.type = 'checkbox';
  notify.id = 'player-extras-notifications';
  notify.className = 'watch-switch';
  notify.setAttribute('role', 'switch');
  notifyLabel.append(notify, document.createTextNode('Notifications'));
  const pipEntry = document.createElement('button');
  pipEntry.type = 'button';
  pipEntry.id = 'player-extras-pip';
  pipEntry.className = 'player-extras-pip quiet';
  extras.append(extrasTitle, notifyLabel, pipEntry);
  dialog.querySelector('.player-settings-column')?.prepend(extras);
  function mirrorExtras() {
    const bell = $('notifications-toggle'),
      pip = $('pip');
    notify.checked = bell.getAttribute('aria-pressed') === 'true';
    notifyLabel.hidden = bell.hidden;
    const label = pip.getAttribute('aria-label') || 'Picture-in-Picture';
    if (pipEntry.dataset.label !== label) {
      pipEntry.replaceChildren(uburoomIcons.icon(document, 'picture-in-picture'), document.createTextNode(label));
      pipEntry.dataset.label = label;
    }
    pipEntry.disabled = pip.disabled;
    pipEntry.hidden = pip.hidden || document.body.classList.contains('no-pip');
    extras.hidden = notifyLabel.hidden && pipEntry.hidden;
  }
  notify.addEventListener('change', () => {
    $('notifications-toggle').click();
    mirrorExtras();
  });
  pipEntry.addEventListener('click', () => {
    if (pipEntry.disabled) return;
    uburoomDialogs.close(dialog);
    $('pip').click();
  });
  new MutationObserver(mirrorExtras).observe($('notifications-toggle'), { attributes: true });
  new MutationObserver(mirrorExtras).observe($('pip'), { attributes: true });
  mirrorExtras();

  const speaker = $('player-mute'),
    slider = $('player-volume'),
    volumeControl = speaker.closest('.volume-control');
  const volumePanel = document.createElement('div');
  volumePanel.id = 'volume-panel';
  volumePanel.className = 'volume-panel';
  const panelMute = document.createElement('button');
  panelMute.type = 'button';
  panelMute.id = 'volume-panel-mute';
  panelMute.className = 'player-button volume-panel-mute';
  slider.before(volumePanel);
  volumePanel.append(slider, panelMute);
  // iOS Safari ignores a page-set video volume; probe a detached element so playback is untouched.
  const volumeSettable = (() => {
    try {
      const probe = document.createElement('video');
      probe.volume = 0.5;
      return Math.abs(probe.volume - 0.5) < 0.01;
    } catch {
      return false;
    }
  })();
  volumeControl.classList.toggle('volume-mute-only', !volumeSettable);
  let volumeTimer,
    speakerMuting = false;
  const panelMode = () => volumeSettable && phone.matches;
  function idleVolume() {
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => closeVolume(), 3000);
  }
  function openVolume() {
    volumeOpen = true;
    volumeControl.classList.add('volume-open');
    speaker.setAttribute('aria-expanded', 'true');
    showChrome();
    idleVolume();
  }
  function closeVolume(focus = false) {
    clearTimeout(volumeTimer);
    if (!volumeOpen) return;
    volumeOpen = false;
    volumeControl.classList.remove('volume-open');
    speaker.setAttribute('aria-expanded', 'false');
    if (focus) speaker.focus();
  }
  // Only changed attributes are written, so the observer below settles after one pass.
  function setAttribute(element, name, value) {
    if (value === undefined) element.removeAttribute(name);
    else if (element.getAttribute(name) !== value) element.setAttribute(name, value);
  }
  function mirrorSpeaker() {
    const panel = panelMode(),
      muted = speaker.getAttribute('aria-pressed') === 'true',
      muteLabel = muted ? 'Unmute' : 'Mute';
    if (!panel) closeVolume();
    setAttribute(speaker, 'aria-controls', panel ? volumePanel.id : undefined);
    setAttribute(speaker, 'aria-expanded', panel ? String(volumeOpen) : undefined);
    // In panel mode the speaker opens the volume panel; otherwise it mutes.
    setAttribute(speaker, 'aria-label', panel ? 'Volume' : muteLabel);
    setAttribute(speaker, 'title', panel ? 'Volume' : muteLabel);
    const svg = speaker.querySelector('svg');
    if (svg) panelMute.replaceChildren(svg.cloneNode(true));
    setAttribute(panelMute, 'aria-label', muteLabel);
    setAttribute(panelMute, 'title', muteLabel);
    setAttribute(panelMute, 'aria-pressed', String(muted));
    panelMute.disabled = speaker.disabled;
  }
  // In panel mode the speaker opens the panel; its own mute action runs only from the panel's mute button.
  volumeControl.addEventListener(
    'click',
    event => {
      if (event.target.closest('#player-mute') !== speaker || speakerMuting || !panelMode()) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (volumeOpen) closeVolume();
      else openVolume();
    },
    true,
  );
  panelMute.addEventListener('click', () => {
    speakerMuting = true;
    try {
      speaker.click();
    } finally {
      speakerMuting = false;
    }
    idleVolume();
  });
  for (const type of ['pointerdown', 'pointermove', 'input', 'keydown', 'focusin'])
    volumePanel.addEventListener(type, () => volumeOpen && idleVolume());
  document.addEventListener('pointerdown', event => {
    if (volumeOpen && !volumeControl.contains(event.target)) closeVolume();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && volumeOpen) {
      event.preventDefault();
      closeVolume(true);
    }
  });
  new MutationObserver(mirrorSpeaker).observe(speaker, {
    attributes: true,
    attributeFilter: ['aria-label', 'title', 'aria-pressed', 'disabled'],
    childList: true,
  });
  phone.addEventListener('change', mirrorSpeaker);
  mirrorSpeaker();

  const reset = () => {
    clearTimeout(tapTimer);
    taps = press = undefined;
    touching = false;
    closeSettings();
    closeVolume();
    if (dialog.open) dialog.close();
  };
  window.addEventListener('resize', () => {
    if (opened && mobile()) closeSettings();
    else placeMenu();
  });
  document.addEventListener('fullscreenchange', () => {
    if (opened) closeSettings();
  });
  return { render, closeSettings, openDialog, reset, settingsOpen: () => opened || dialog.open, showChrome };
}
export { mount, trackLabel };
