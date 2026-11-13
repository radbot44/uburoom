/* Playback queue and history UI; safe DOM only, shared command engine. */
import * as uburoomControls from './watch-controls.js';
import * as uburoomDialogs from './watch-dialogs.js';
import * as uburoomIcons from './icons.js';
import * as uburoomPopover from './watch-popover.js';

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) {
    return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  return m + ':' + String(s % 60).padStart(2, '0');
}

function mount(
  host,
  {
    request,
    getState,
    getMe,
    fail,
    changed,
    execute,
    openLibraryItem,
    artwork,
    openSettings,
    browseMedia,
    getSettingsState = getState,
    saveSettings,
    // The page's scheduler (web/watch/scheduler.js); a plain interval elsewhere.
    every = (ms, run) => setInterval(run, ms),
  },
) {
  const doc = host.ownerDocument;
  let centerPending = true,
    hadHistory = false;
  let centerAfterFetch = true;
  let currentKey = '';
  let currentId;
  let capabilityKey = '';

  function formatSubtitle(item) {
    if (!item) return '';
    const parts = [];
    if (item.grandparentTitle) parts.push(item.grandparentTitle);
    if (item.parentTitle) parts.push(item.parentTitle);
    if (item.type === 'episode' && Number.isInteger(item.index)) {
      const hasEpisode = parts.some(p => /episode/i.test(p));
      if (!hasEpisode) {
        parts.push('Episode ' + item.index);
      }
    }
    return parts.join(' · ');
  }
  let currentQueue = { items: [], total: 0, queueRevision: 0 };
  let currentHistory = { items: [], total: 0 };
  let fetching = null;
  let refetchNeeded = false;
  let refetchForce = false;
  let busy = false;
  let autoplayPending = false;
  let bulkPending = false;
  let autoPending = false;
  let lastAutoplayError = '';
  let lastFetchedRevision = -1;
  let lastFetchedRoomId = null;

  function node(tag, parent, text, className) {
    const el = doc.createElement(tag);
    if (text !== undefined) el.textContent = text;
    if (className) el.className = className;
    parent?.append(el);
    return el;
  }

  function button(parent, label, iconName, action, disabled = false, className = 'quiet') {
    const b = node('button', parent, undefined, className);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    b.disabled = disabled;
    if (iconName) {
      b.append(uburoomIcons.icon(doc, iconName));
    } else {
      b.textContent = label;
    }
    if (action) b.addEventListener('click', action);
    return b;
  }

  const popups = uburoomDialogs;
  const confirm = message => popups.confirm(message, { destructive: true });

  host.replaceChildren();
  host.dataset.view = 'list';
  const header = node('header', host, undefined, 'queue-header watch-panel-header');
  const heading = node('h2', header, undefined, 'queue-heading watch-panel-heading');
  const symbol = node('span', heading, undefined, 'watch-panel-symbol');
  symbol.id = 'queue-symbol';
  symbol.setAttribute('aria-hidden', 'true');
  symbol.append(uburoomIcons.icon(doc, 'player-track-next'));
  const queueTitle = node('span', heading, 'Queue', 'watch-panel-title');
  queueTitle.id = 'queue-title';
  const autoOpen = button(header, 'Queue settings', 'settings', () => openSettings(), false, 'icon-button');
  uburoomControls.content(autoOpen, { label: 'Queue settings', icon: 'settings', iconOnly: true });
  autoOpen.id = 'queue-auto-open';
  autoOpen.classList.add('queue-auto-open');
  const body = node('div', host);
  body.id = 'queue-body';
  // Second header row: the continuation switches, then Center Now Playing.
  const toolbar = node('div', header, undefined, 'queue-toolbar watch-toolbar');
  const continuation = node('div', toolbar, undefined, 'queue-continuation queue-quick-controls watch-control-group');
  const autoplayPill = uburoomControls.switchPill(doc, { label: 'Auto-play' });
  const autoplayLabel = autoplayPill.element,
    autoplayToggle = autoplayPill.input;
  autoplayToggle.id = 'queue-autoplay';
  const autoPill = uburoomControls.switchPill(doc, { label: 'Auto-queue', accent: 'secondary' });
  const autoLabel = autoPill.element,
    autoToggle = autoPill.input;
  autoToggle.id = 'queue-auto-toggle';
  autoToggle.classList.add('queue-auto-toggle');
  continuation.append(autoplayLabel, autoLabel);
  const centerButton = button(toolbar, 'Center Now Playing', 'center', () => centerCurrent(true));
  uburoomControls.content(centerButton, { label: 'Center Now Playing', icon: 'center' });
  centerButton.id = 'queue-center';
  centerButton.classList.add('queue-center');
  const timeline = node('div', body, undefined, 'queue-timeline');
  const navigation = node('div', timeline, undefined, 'queue-navigation');
  const previousButton = button(navigation, 'Scroll toward history', 'up', () => scrollEntries(-1));
  previousButton.id = 'queue-scroll-previous';
  const previousCount = node('span', previousButton, '', 'queue-navigation-count');
  const nextButton = button(navigation, 'Scroll toward upcoming videos', 'down', () => scrollEntries(1));
  const nextCount = node('span', nextButton, '', 'queue-navigation-count');
  nextButton.id = 'queue-scroll-next';
  const layout = node('div', timeline, undefined, 'queue-layout');
  layout.tabIndex = 0;
  layout.setAttribute('role', 'region');
  layout.setAttribute('aria-label', 'Playback queue timeline');
  const historyView = node('section', layout, undefined, 'queue-view queue-history-view');
  historyView.id = 'queue-history-view';
  historyView.setAttribute('aria-label', 'Playback history');
  const nowPlayingBox = node('div', layout, undefined, 'queue-now-playing');
  const upcomingView = node('section', layout, undefined, 'queue-view queue-upcoming-view');
  upcomingView.id = 'queue-upcoming-view';
  upcomingView.setAttribute('aria-label', 'Upcoming videos');
  const emptyScreen = node('section', body, undefined, 'queue-empty-screen');
  emptyScreen.id = 'queue-empty-screen';
  emptyScreen.append(uburoomIcons.icon(doc, 'queue'));
  const emptyTitle = node('h3', emptyScreen, '', 'queue-empty-title');
  const emptyText = node(
    'p',
    emptyScreen,
    'Join or create a room, then add movies and episodes here. They play in order for everyone.',
    'queue-empty-text',
  );
  const emptyBrowse = button(emptyScreen, 'Browse media', 'media', () => browseMedia());
  node('span', emptyBrowse, 'Browse media');
  const footer = node('div', body, undefined, 'queue-footer');

  let rememberedAuto = null,
    rememberedRoom,
    lastAutoNextKey = '';
  autoToggle.addEventListener('change', async () => {
    if (autoPending) return;
    autoPending = true;
    renderContinuation();
    uburoomPopover.show(autoLabel, { text: 'Saving…', state: 'loading' });
    const targetAuto = autoToggle.checked
      ? rememberedAuto || { mode: 'continue', scope: null, includeSpecials: false }
      : { mode: 'off', scope: null, includeSpecials: false };
    try {
      await mutate('auto', targetAuto);
      await changed();
      uburoomPopover.show(autoLabel, { text: 'Auto-queue saved.', state: 'success' });
    } catch (error) {
      uburoomPopover.show(autoLabel, { text: error.message, state: 'error' });
    } finally {
      autoPending = false;
      renderContinuation();
    }
  });

  autoplayToggle.addEventListener('change', async () => {
    if (autoplayPending) return;
    autoplayPending = true;
    renderContinuation();
    uburoomPopover.show(autoplayLabel, { text: 'Saving…', state: 'loading' });
    try {
      await execute({ action: 'media.autoplay.set', args: { enabled: autoplayToggle.checked } });
      uburoomPopover.show(autoplayLabel, { text: 'Auto-play saved.', state: 'success' });
    } catch (error) {
      uburoomPopover.show(autoplayLabel, { text: error.message, state: 'error' });
    } finally {
      autoplayPending = false;
      renderContinuation();
    }
  });

  function renderContinuation() {
    const state = getState();
    autoplayPill.update({
      checked: autoplayPending ? autoplayToggle.checked : state?.autoplay?.enabled !== false,
      disabled: autoplayPending || !state?.capabilities?.autoplay,
      reason: autoplayPending
        ? 'Saving Auto-play…'
        : !state?.capabilities?.autoplay
          ? 'Auto-play is unavailable for your role.'
          : '',
    });
    autoOpen.disabled = !state?.durable;
    autoOpen.title = autoOpen.disabled ? 'Join a room to change queue settings.' : 'Queue settings';
    const auto = state?.queueSummary?.autoQueue;
    if (rememberedRoom !== state?.id) {
      rememberedAuto = null;
      rememberedRoom = state?.id;
    }
    if (auto?.mode && auto.mode !== 'off')
      rememberedAuto = { mode: auto.mode, scope: auto.scope, includeSpecials: auto.includeSpecials };
    autoPill.update({
      checked: autoPending ? autoToggle.checked : !!auto?.mode && auto.mode !== 'off',
      disabled: autoPending || !state?.capabilities?.editQueue,
      reason: autoPending
        ? 'Saving Auto-queue…'
        : !state?.capabilities?.editQueue
          ? 'Queue editing is unavailable for your role.'
          : '',
    });
    if (state?.autoplay?.error && state.autoplay.error !== lastAutoplayError) {
      uburoomPopover.show(autoplayLabel, { text: state.autoplay.error, state: 'error' });
    }
    lastAutoplayError = state?.autoplay?.error || '';
  }
  every(250, renderContinuation);

  const bulkDialog = node('dialog', doc.body, undefined, 'watch-dialog queue-dialog');
  bulkDialog.id = 'queue-bulk-dialog';
  bulkDialog.setAttribute('aria-labelledby', 'queue-bulk-title');
  const bulkHeader = node('header', bulkDialog);
  const bulkTitle = node('h2', bulkHeader, 'Add episodes to queue');
  bulkTitle.id = 'queue-bulk-title';
  const bulkDescription = node('p', bulkDialog, '', 'hint');
  const bulkFilterLabel = node('label', bulkDialog, 'Episodes');
  const bulkFilter = node('select', bulkFilterLabel);
  bulkFilter.id = 'queue-bulk-filter';
  for (const [value, label] of [
    ['all', 'All episodes'],
    ['unfinished', 'Unfinished by this room'],
  ]) {
    const option = node('option', bulkFilter, label);
    option.value = value;
  }
  const bulkSpecialLabel = node('label', bulkDialog, undefined, 'watch-switch-label');
  const bulkSpecials = node('input', bulkSpecialLabel);
  bulkSpecials.type = 'checkbox';
  bulkSpecials.id = 'queue-bulk-specials';
  bulkSpecials.className = 'watch-switch';
  bulkSpecials.setAttribute('role', 'switch');
  bulkSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
  node(
    'p',
    bulkDialog,
    'Current and upcoming episodes are excluded. The server limits upcoming videos; an addition that exceeds its limit is rejected in full.',
    'hint',
  );
  const bulkStatus = node('p', bulkDialog, '', 'hint');
  bulkStatus.setAttribute('role', 'status');
  const bulkActions = node('footer', bulkDialog, undefined, 'dialog-footer');
  const bulkCancel = button(bulkActions, 'Cancel', undefined, () => popups.close(bulkDialog));
  const bulkSubmit = button(bulkActions, 'Add to queue', undefined, undefined, false, 'primary');
  bulkSubmit.id = 'queue-bulk-submit';
  let bulkDirty = false;
  bulkFilter.addEventListener('change', () => {
    bulkDirty = true;
  });
  bulkSpecials.addEventListener('change', () => {
    bulkDirty = true;
  });
  popups.register(bulkDialog, { busy: () => bulkPending, dirty: () => bulkDirty });

  async function bulk(item, trigger) {
    if (bulkDialog.open) return;
    const roomId = getState()?.id;
    if (!roomId) return;
    bulkTitle.textContent = 'Add ' + (item.type === 'season' ? 'season' : 'show') + ' to queue';
    bulkDescription.textContent =
      item.title + (item.episodeCount ? ' · ' + item.episodeCount + ' episodes available' : '');
    bulkDirty = false;
    bulkStatus.textContent = '';
    bulkSubmit.disabled = bulkCancel.disabled = false;
    bulkSubmit.onclick = async () => {
      if (getState()?.id !== roomId || !getState()?.capabilities?.addQueue) {
        bulkDialog.close();
        return;
      }
      bulkPending = true;
      bulkSubmit.disabled = bulkCancel.disabled = bulkFilter.disabled = bulkSpecials.disabled = true;
      bulkStatus.textContent = 'Loading episodes…';
      try {
        const result = await mutate('bulk', {
          type: item.type,
          mediaId: item.id,
          unfinished: bulkFilter.value === 'unfinished',
          includeSpecials: bulkSpecials.checked,
        });
        bulkDialog.close('added');
        if (trigger) {
          uburoomPopover.show(trigger, {
            text:
              'Episodes added to queue' + (Number.isInteger(result?.addedCount) ? ': ' + result.addedCount : '') + '.',
            state: 'success',
          });
        }
      } catch (error) {
        bulkStatus.textContent = error.message;
      } finally {
        bulkPending = false;
        bulkSubmit.disabled = bulkCancel.disabled = bulkFilter.disabled = bulkSpecials.disabled = false;
      }
    };
    popups.open(bulkDialog);
  }

  const autoDialog = node('div', doc.getElementById('room-playback-controls'), undefined, 'queue-settings');
  const settingsAutoplayLabel = node('label', autoDialog, undefined, 'watch-switch-label');
  const settingsAutoplay = node('input', settingsAutoplayLabel);
  settingsAutoplay.type = 'checkbox';
  settingsAutoplay.id = 'room-autoplay';
  settingsAutoplay.className = 'watch-switch';
  settingsAutoplay.setAttribute('role', 'switch');
  settingsAutoplayLabel.append(doc.createTextNode('Auto-play next video'));
  settingsAutoplay.addEventListener('change', async () => {
    settingsAutoplay.disabled = true;
    setAutoNotice('Saving…');
    try {
      await saveSettings({ autoplay: settingsAutoplay.checked });
      setAutoNotice('Saved', true);
    } catch (error) {
      setAutoNotice(error.message);
    } finally {
      settingsAutoplay.checked = getSettingsState()?.autoplay?.enabled !== false;
      settingsAutoplay.disabled = !getSettingsState()?.capabilities?.autoplay;
    }
  });
  autoDialog.id = 'queue-auto-dialog';
  autoDialog.setAttribute('aria-labelledby', 'queue-auto-title');
  node('h4', autoDialog, 'Auto-queue').id = 'queue-auto-title';
  const autoModeLabel = node('label', autoDialog, 'Mode');
  const autoMode = node('select', autoModeLabel);
  autoMode.id = 'queue-auto-mode';
  autoMode.hidden = true;
  for (const [value, label] of [
    ['off', 'Off'],
    ['continue', 'Continue'],
    ['following', 'In order'],
    ['random', 'Shuffle'],
  ]) {
    const option = node('option', autoMode, label);
    option.value = value;
  }
  const autoModeGroup = node('div', autoDialog, undefined, 'button-group watch-segmented');
  autoModeGroup.id = 'queue-auto-mode-group';
  autoModeGroup.classList.add('queue-auto-mode-group');
  autoModeGroup.setAttribute('role', 'group');
  autoModeGroup.setAttribute('aria-label', 'Mode');
  const modeButtons = new Map();
  for (const [value, label] of [
    ['off', 'Off'],
    ['continue', 'Continue'],
    ['following', 'In order'],
    ['random', 'Shuffle'],
  ]) {
    const btn = node('button', autoModeGroup, label, 'group-button');
    btn.type = 'button';
    btn.dataset.value = value;
    btn.title =
      value === 'off'
        ? 'Do not generate queued videos automatically.'
        : value === 'continue'
          ? 'Automatically queue the next episode of the last TV show in the queue.'
          : value === 'following'
            ? 'Queue episodes in order from the selected show.'
            : 'Shuffle videos from the selected source.';
    btn.setAttribute('aria-pressed', String(value === 'off'));
    btn.addEventListener('click', () => {
      if (autoMode.value !== value) {
        autoMode.value = value;
        autoMode.dispatchEvent(new Event('change', { bubbles: true }));
        syncAutoModeButtons();
      }
    });
    modeButtons.set(value, btn);
  }
  function syncAutoModeButtons() {
    for (const [val, btn] of modeButtons) {
      btn.setAttribute('aria-pressed', String(autoMode.value === val));
      btn.disabled = autoMode.disabled || (val === 'following' && draftScope.type !== 'show');
    }
  }
  uburoomControls.segmented(autoModeGroup);
  const autoSource = node('p', autoDialog, '', 'hint');
  autoSource.id = 'queue-auto-source';
  const sourceChange = button(autoDialog, 'Change source', undefined, () => {
    sourcePicker.hidden = false;
    void browseSources();
  });
  sourceChange.id = 'queue-source-change';
  sourceChange.classList.add('queue-source-change');
  const sourcePicker = node('section', autoDialog, undefined, 'queue-source-picker');
  sourcePicker.id = 'queue-source-picker';
  sourcePicker.hidden = true;
  const sourceTitle = node('strong', sourcePicker, 'Choose source');
  const sourceNotice = node('p', sourcePicker, '', 'hint');
  sourceNotice.setAttribute('role', 'status');
  const sourceRows = node('div', sourcePicker);
  const sourceNav = node('div', sourcePicker, undefined, 'dialog-actions');
  button(sourceNav, 'Libraries', undefined, () => void browseSources());
  button(sourceNav, 'Close picker', 'close', () => {
    sourcePicker.hidden = true;
  });
  let draftScope = { type: 'show' },
    sourceTicket = 0,
    autoRoom,
    autoTicket = 0,
    hasAutoDraft = false,
    autoNoticeTimer;
  popups.register(doc.getElementById('room-settings-dialog'), { dirty: () => hasAutoDraft, busy: () => autoPending });
  const sourceNames = new Map();
  function setAutoNotice(text, transient = false) {
    clearTimeout(autoNoticeTimer);
    autoNotice.textContent = text;
    if (transient)
      autoNoticeTimer = setTimeout(() => {
        if (autoNotice.textContent === text) autoNotice.textContent = '';
      }, 2500);
  }
  function sourceKey(scope, state = getSettingsState()) {
    return (
      scope.type +
      ':' +
      (scope.id || 'current:' + (state?.queueSummary?.current?.grandparentTitle || state?.mediaId || 'none'))
    );
  }
  function chooseSource(scope, title) {
    ++autoTicket;
    hasAutoDraft = true;
    draftScope = scope;
    sourceNames.set(sourceKey(scope), title);
    autoSource.textContent = title;
    if (scope.type !== 'show' && autoMode.value === 'following') autoMode.value = 'random';
    sourcePicker.hidden = true;
    sourceChange.focus();
    updateAutoFields();
  }
  async function browseSources(query = {}, title = 'Libraries') {
    const ticket = ++sourceTicket,
      roomId = getSettingsState()?.id;
    sourceTitle.textContent = title;
    sourceRows.replaceChildren();
    sourceNotice.textContent = 'Loading…';
    try {
      const data = await request('library.browse', { args: query });
      if (ticket !== sourceTicket || roomId !== getSettingsState()?.id || sourcePicker.hidden) return;
      sourceNotice.textContent = data.items.length ? '' : 'No sources available.';
      for (const item of data.items) {
        const row = node('div', sourceRows, undefined, 'source-row');
        node('span', row, item.title);
        if (item.type === 'library') {
          if (item.mediaType === 'movie')
            button(row, 'Use library', undefined, () => chooseSource({ type: 'library', id: item.id }, item.title));
          else button(row, 'Shows', undefined, () => void browseSources({ section: item.id }, item.title));
          button(
            row,
            'Collections',
            undefined,
            () => void browseSources({ section: item.id, tab: 'collections' }, item.title + ' collections'),
          );
        } else if (['show', 'collection'].includes(item.type))
          button(row, 'Use source', undefined, () => chooseSource({ type: item.type, id: item.id }, item.title));
      }
      if (data.nextOffset !== null && data.nextOffset !== undefined)
        button(
          sourceRows,
          'Next page',
          undefined,
          () => void browseSources({ ...query, offset: data.nextOffset }, title),
        );
      if (Number(query.offset) > 0)
        button(
          sourceRows,
          'Previous page',
          undefined,
          () => void browseSources({ ...query, offset: Math.max(0, Number(query.offset) - 48) }, title),
        );
    } catch (error) {
      if (ticket === sourceTicket) sourceNotice.textContent = error.message;
    }
  }
  async function sourceName(scope, state, ticket) {
    const key = sourceKey(scope, state);
    if (sourceNames.has(key)) {
      if (ticket === autoTicket && draftScope === scope) autoSource.textContent = sourceNames.get(key);
      return;
    }
    autoSource.textContent = 'Loading source…';
    try {
      let title;
      if (!scope.id) title = state.queueSummary?.current?.grandparentTitle;
      else if (scope.type === 'library')
        title = (await request('library.browse')).items.find(item => item.id === scope.id)?.title;
      else title = (await request('library.item', { args: { item: scope.id, type: scope.type } })).item.title;
      if (ticket !== autoTicket || getSettingsState()?.id !== state.id || draftScope !== scope) return;
      autoSource.textContent = title || 'Choose a source';
      if (title) sourceNames.set(key, title);
    } catch (error) {
      if (ticket === autoTicket && draftScope === scope)
        autoSource.textContent = 'Source unavailable: ' + error.message;
    }
  }
  function updateAutoFields() {
    const hideSource = autoMode.value === 'off' || autoMode.value === 'continue';
    autoSource.hidden = sourceChange.hidden = hideSource;
    autoSpecialLabel.hidden = hideSource || draftScope.type !== 'show';
    autoMode.querySelector('[value=following]').disabled = draftScope.type !== 'show';
    if (hideSource) sourcePicker.hidden = true;
    syncAutoModeButtons();
  }
  autoMode.addEventListener('change', () => {
    hasAutoDraft = true;
    updateAutoFields();
  });
  const autoSpecialLabel = node('label', autoDialog, undefined, 'watch-switch-label');
  const autoSpecials = node('input', autoSpecialLabel);
  autoSpecials.type = 'checkbox';
  autoSpecials.id = 'queue-auto-specials';
  autoSpecials.className = 'queue-auto-specials watch-switch';
  autoSpecials.setAttribute('role', 'switch');
  autoSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
  autoSpecials.addEventListener('change', () => {
    hasAutoDraft = true;
  });
  const autoNotice = node('p', autoDialog, '', 'hint');
  autoNotice.setAttribute('role', 'status');
  const autoActions = node('div', autoDialog, undefined, 'dialog-actions queue-settings-footer');
  const autoCancel = button(autoActions, 'Reset changes', undefined, () => {
    hasAutoDraft = false;
    void openAuto();
  });
  const autoSave = button(autoActions, 'Save auto-queue', undefined, undefined, false, 'primary');
  autoSave.id = 'queue-auto-save';
  const autoReset = button(autoActions, 'Reset auto-queue progress', undefined, async () => {
    if (
      !(await confirm(
        'Reset auto-queue progress? Episode progress and repeat prevention will restart. Upcoming items and visible history stay unchanged.',
      ))
    )
      return;
    autoReset.disabled = true;
    setAutoNotice('Resetting…');
    try {
      await saveSettings({ resetProgress: true });
      setAutoNotice('Auto-queue progress reset', true);
      await changed();
    } catch (error) {
      setAutoNotice(error.message);
    } finally {
      autoReset.disabled = !getSettingsState()?.capabilities?.editQueue;
    }
  });
  autoReset.id = 'queue-auto-progress-reset';
  doc.addEventListener('room-playback-settings', () => {
    if (!autoPending && (!hasAutoDraft || autoRoom !== getSettingsState()?.id)) void openAuto();
  });
  async function openAuto(source) {
    const state = getSettingsState(),
      roomId = state?.id;
    if (!roomId) return;
    if (source) await openSettings();
    if (getSettingsState()?.id !== roomId) return;
    const config = state.queueSummary?.autoQueue;
    if (autoRoom !== roomId) {
      hasAutoDraft = false;
      sourceNames.clear();
    }
    autoRoom = roomId;
    if (!hasAutoDraft || source) {
      autoMode.value = source ? 'random' : config?.mode || 'off';
      autoSpecials.checked = !!config?.includeSpecials;
      draftScope = source?.scope || config?.scope || { type: 'show' };
      if (source) hasAutoDraft = true;
    }
    const ticket = ++autoTicket;
    if (source?.title) sourceNames.set(sourceKey(draftScope, state), source.title);
    void sourceName(draftScope, state, ticket);
    sourcePicker.hidden = true;
    autoReset.hidden = !!state.draft;
    autoReset.disabled = !state.capabilities?.editQueue;
    setAutoNotice('');
    autoSave.disabled = autoMode.disabled = autoSpecials.disabled = !state.capabilities?.editQueue;
    settingsAutoplay.checked = state.autoplay?.enabled !== false;
    settingsAutoplay.disabled = !state.capabilities?.autoplay;
    sourceChange.disabled = !state.capabilities?.editQueue;
    updateAutoFields();

    autoSave.onclick = async () => {
      if (getSettingsState()?.id !== roomId || !getSettingsState()?.capabilities?.editQueue) {
        return;
      }
      autoPending = true;
      autoSave.disabled =
        autoCancel.disabled =
        autoMode.disabled =
        autoSpecials.disabled =
        sourceChange.disabled =
          true;
      setAutoNotice('Saving…');
      try {
        const hasScope = ['following', 'random'].includes(autoMode.value);
        const selectedScope = hasScope ? { ...draftScope } : null;
        await saveSettings({
          autoQueue: {
            mode: autoMode.value,
            scope: selectedScope,
            includeSpecials: hasScope && draftScope.type === 'show' && autoSpecials.checked,
          },
        });
        hasAutoDraft = false;
        setAutoNotice('Saved', true);
        await changed();
      } catch (error) {
        setAutoNotice(error.message);
      } finally {
        autoPending = false;
        autoSave.disabled =
          autoCancel.disabled =
          autoMode.disabled =
          autoSpecials.disabled =
          sourceChange.disabled =
            !getSettingsState()?.capabilities?.editQueue;
      }
    };
  }

  function motion() {
    return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
  }

  function centerCurrent(smooth = false) {
    if (!layout.clientWidth) return;
    // Without history there is nothing to scroll back to: the "No playback history yet" line, Now Playing
    // and the upcoming rows start at the top with no centering space.
    hadHistory = Boolean(layout.querySelector('.queue-history-entry'));
    layout.style.paddingBlock = hadHistory
      ? Math.max(0, (layout.clientHeight - nowPlayingBox.offsetHeight) / 2) + 'px'
      : '';
    const r = nowPlayingBox.getBoundingClientRect(),
      bounds = layout.getBoundingClientRect();
    layout.scrollTo({
      top: layout.scrollTop + r.top - bounds.top - (layout.clientHeight - r.height) / 2,
      behavior: smooth ? motion() : 'instant',
    });
    centerPending = false;
    updateNavigation();
  }

  function entries() {
    return [...layout.querySelectorAll('.queue-entry,.queue-history-entry,.queue-now-playing')].filter(
      row => row.dataset.entryId,
    );
  }
  function nearestEntry() {
    const bounds = layout.getBoundingClientRect();
    const center = bounds.top + layout.clientHeight / 2;
    let closest,
      distance = Infinity;
    for (const row of entries()) {
      const rect = row.getBoundingClientRect();
      const delta = Math.abs(rect.top + rect.height / 2 - center);
      if (delta < distance) {
        closest = row;
        distance = delta;
      }
    }
    return closest;
  }
  function centerEntry(target, smooth = true) {
    if (!target || timeline.hidden) return;
    const rect = target.getBoundingClientRect(),
      bounds = layout.getBoundingClientRect();
    layout.scrollTo({
      top: layout.scrollTop + rect.top - bounds.top - (layout.clientHeight - rect.height) / 2,
      behavior: smooth ? motion() : 'instant',
    });
    updateNavigation();
  }
  function directionTarget(direction) {
    const rows = entries(),
      selected = nearestEntry();
    const index = rows.indexOf(selected);
    if (index === -1) return undefined;
    return rows[index + direction];
  }
  function scrollEntries(direction) {
    centerEntry(directionTarget(direction));
  }
  function updateNavigation() {
    if (!layout.clientWidth) return;
    previousButton.disabled = !directionTarget(-1);
    nextButton.disabled = !directionTarget(1);
  }
  let navFrame;
  function scheduleNavigation() {
    if (navFrame) return;
    navFrame = requestAnimationFrame(() => {
      navFrame = undefined;
      updateNavigation();
    });
  }

  layout.addEventListener('scroll', scheduleNavigation, { passive: true });
  layout.addEventListener('keydown', event => {
    if (event.target !== layout) return;
    if (['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      scrollEntries(event.key === 'ArrowUp' ? -1 : 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      event.stopPropagation();
      centerCurrent(true);
    }
  });
  let measuredWidth = 0;
  new ResizeObserver(() => {
    if (!layout.clientWidth) return;
    const resized = measuredWidth !== layout.clientWidth;
    measuredWidth = layout.clientWidth;
    if (resized || centerPending) centerCurrent();
  }).observe(layout);
  renderHeaderBadge(getState()?.queueSummary);
  requestAnimationFrame(() => centerCurrent());

  const images = new Map();
  const imageRequests = new Map();
  let artworkQueue = [];
  let artworkActive = 0;
  let artworkGeneration = 0;
  let imageController = new AbortController();
  const observedImages = new Set();
  const imageObserver = new IntersectionObserver(
    entries => {
      for (const entry of entries)
        if (entry.isIntersecting) {
          imageObserver.unobserve(entry.target);
          observedImages.delete(entry.target);
          artworkQueue.push(entry.target);
        }
      pumpArtwork();
    },
    { root: layout, rootMargin: '200px' },
  );

  function pumpArtwork() {
    const generation = artworkGeneration;
    while (artworkActive < 4 && artworkQueue.length) {
      const img = artworkQueue.shift();
      if (!img.isConnected) continue;
      artworkActive++;
      void loadArtwork(img).finally(() => {
        if (generation === artworkGeneration) {
          artworkActive--;
          pumpArtwork();
        }
      });
    }
  }

  function clearArtwork() {
    imageController.abort();
    imageController = new AbortController();
    artworkGeneration++;
    artworkActive = 0;
    artworkQueue = [];
    imageObserver.disconnect();
    observedImages.clear();
    imageRequests.clear();
    for (const url of images.values()) URL.revokeObjectURL(url);
    images.clear();
  }

  async function loadArtwork(img) {
    const key = img.dataset.item + ':' + img.dataset.type;
    const signal = imageController.signal;
    try {
      if (!images.has(key)) {
        if (!imageRequests.has(key)) {
          const params = new URLSearchParams({ item: img.dataset.item, kind: 'poster', type: img.dataset.type });
          imageRequests.set(
            key,
            artwork('/api/watch/library/art?' + params, signal).then(blob => {
              if (!signal.aborted) {
                images.set(key, URL.createObjectURL(blob));
                while (images.size > 220) {
                  const first = images.keys().next().value;
                  URL.revokeObjectURL(images.get(first));
                  images.delete(first);
                  imageRequests.delete(first);
                }
              }
            }),
          );
        }
        await imageRequests.get(key);
      }
      if (!signal.aborted && img.isConnected && images.has(key)) {
        img.src = images.get(key);
        img.parentElement.parentElement.querySelector('.queue-row-backdrop').style.backgroundImage =
          'url(' + images.get(key) + ')';
      }
    } catch {
      if (!signal.aborted) {
        imageRequests.delete(key);
        img.parentNode?.setAttribute('title', 'Artwork unavailable');
        img.remove();
      }
    }
  }

  function art(parent, item) {
    node('div', parent, undefined, 'queue-row-backdrop').setAttribute('aria-hidden', 'true');
    const box = node('div', parent, undefined, 'queue-art');
    box.append(uburoomIcons.icon(doc, item.type === 'episode' ? 'tv' : 'film'));
    if (!artwork || !/^\d{1,20}$/.test(item.mediaId || item.id || '')) return;
    const img = node('img', box);
    img.alt = '';
    img.decoding = 'async';
    img.dataset.item = item.mediaId || item.id;
    img.dataset.type = item.type || 'movie';
    const cached = images.get(img.dataset.item + ':' + img.dataset.type);
    if (cached) {
      img.src = cached;
      parent.querySelector('.queue-row-backdrop').style.backgroundImage = 'url(' + cached + ')';
    } else {
      observedImages.add(img);
      imageObserver.observe(img);
    }
  }

  function renderHeaderBadge(summary) {
    const qLen = summary?.pendingCount ?? currentQueue.total ?? 0;
    const hLen = summary?.historyCount ?? currentHistory.total ?? 0;
    previousCount.textContent = hLen ? hLen + ' past' : '';
    // Without history the button has nothing to scroll to and would cover the "No playback history yet" line.
    previousButton.classList.toggle('queue-navigation-idle', !hLen);
    timeline.classList.toggle('queue-has-history', hLen > 0);
    nextCount.textContent = qLen ? qLen + ' queued' : '';
    const badge = doc.getElementById('queue-count-badge');
    if (badge) {
      badge.textContent = String(qLen);
      badge.hidden = qLen === 0;
    }
  }

  function title(parent, item, className) {
    const targetId = item.mediaId || item.id;
    const target = node(
      openLibraryItem && targetId ? 'button' : 'strong',
      parent,
      item.title || 'Unknown title',
      'queue-title-link ' + className,
    );
    if (target.tagName === 'BUTTON') {
      target.type = 'button';
      target.title = 'View in library: ' + item.title;
      target.addEventListener('click', () =>
        openLibraryItem({ id: targetId, type: item.type || 'movie', title: item.title }),
      );
    }
    const subtitle = formatSubtitle(item);
    if (subtitle) node('p', parent, subtitle, 'hint queue-entry-subtitle');
  }

  function updateViewsVisibility() {
    const state = getState();
    const noEntries =
      !state ||
      !(
        state.mediaId ||
        state.queueSummary?.current ||
        state.queueSummary?.pendingCount ||
        currentQueue.items.length ||
        state.queueSummary?.autoQueue?.next ||
        state.queueSummary?.historyCount ||
        currentHistory.items.length
      );
    timeline.hidden = centerButton.hidden = noEntries;
    toolbar.hidden = autoOpen.hidden = !state;
    emptyScreen.hidden = !noEntries;
    host.dataset.view = noEntries ? 'empty' : 'list';
    host.classList.toggle('queue-is-empty', noEntries);
    emptyTitle.textContent = state ? 'The queue is empty' : 'The queue lives in a room';
    emptyText.hidden = !!state;
    emptyBrowse.disabled = !getMe?.() || (!!state && !state.canBrowse);
  }

  function renderNowPlaying() {
    const state = getState();
    const empty = !state?.mediaId && !state?.queueSummary?.current;
    host.classList.toggle('queue-no-current', empty);
    host.classList.toggle(
      'queue-no-entries',
      !(state?.queueSummary?.pendingCount || state?.queueSummary?.autoQueue?.next || state?.queueSummary?.historyCount),
    );
    updateViewsVisibility();
    if (empty) {
      delete nowPlayingBox.dataset.entryId;
      if (currentKey !== 'empty') {
        nowPlayingBox.replaceChildren();
        node('p', nowPlayingBox, 'No video selected');
        const browse = button(
          nowPlayingBox,
          'Browse media',
          'media',
          () => browseMedia(),
          !state ? !getMe?.() : !state?.canBrowse,
        );
        node('span', browse, 'Browse media');
        currentKey = 'empty';
      }
      return;
    }
    const current = state?.queueSummary?.current;
    const item = current || { title: state?.title || 'Nothing currently playing', mediaId: state?.mediaId };
    const duration = current?.duration || state?.state?.duration || 0;
    const position = state?.state?.position ?? current?.position ?? 0;
    const key = JSON.stringify([
      state?.id,
      item.id,
      item.mediaId,
      item.title,
      item.thumb,
      formatSubtitle(item),
      state?.capabilities?.playPause,
      state?.capabilities?.editQueue,
      state?.capabilities?.chooseMedia,
    ]);
    if (currentKey !== key) {
      const changedItem = currentId !== current?.id;
      currentId = current?.id;
      currentKey = key;
      if (changedItem) centerPending = centerAfterFetch = true;
      nowPlayingBox.replaceChildren();
      nowPlayingBox.dataset.entryId = current?.id || '';
      const top = node('div', nowPlayingBox, undefined, 'queue-now-playing-header');
      node('span', top, 'Now playing', 'queue-section-label');
      const moves = node('div', top, undefined, 'queue-move-actions');
      action(
        moves,
        'Remove current video',
        'close',
        () => removeCurrent(false),
        !state?.capabilities?.editQueue || !state?.capabilities?.chooseMedia,
        'queue-current-remove',
      );
      art(nowPlayingBox, item);
      const body = node('div', nowPlayingBox, undefined, 'queue-now-playing-body');
      title(body, item, 'queue-now-playing-title');
      node('div', body, '', 'queue-now-playing-meta');
      const progress = node('progress', body, undefined, 'queue-progress');
      progress.setAttribute('aria-label', 'Current video progress');
      const actions = node('div', nowPlayingBox, undefined, 'queue-entry-actions');
      node('span', actions, '', 'queue-entry-caption queue-playback-state');
      const playBtn = button(
        actions,
        'Play',
        'play',
        async () => {
          try {
            await execute({ action: getState()?.state?.paused ? 'media.play' : 'media.pause' });
          } catch (error) {
            uburoomPopover.show(playBtn, { text: error.message, state: 'error' });
          }
        },
        !state?.mediaId || !state?.capabilities?.playPause,
        'icon-button quiet queue-current-toggle',
      );
      action(
        actions,
        'Skip to next video',
        'end',
        () => execute({ action: 'media.next' }),
        !state?.hasNext || !state?.capabilities?.chooseMedia,
        'queue-current-skip',
      );
    }
    nowPlayingBox.querySelector('.queue-playback-state').textContent =
      current || state?.mediaId ? (state?.state?.paused ? 'Paused' : 'Playing') : '';
    nowPlayingBox.querySelector('.queue-now-playing-meta').textContent =
      formatTime(position) + ' / ' + formatTime(duration);
    const progress = nowPlayingBox.querySelector('progress');
    progress.max = duration || 1;
    progress.value = Math.min(position, duration);
    const toggle = nowPlayingBox.querySelector('.queue-current-toggle');
    nowPlayingBox.querySelector('.queue-current-skip').disabled = !state?.hasNext || !state?.capabilities?.chooseMedia;
    const label = state?.state?.paused ? 'Play' : 'Pause';
    if (toggle.title !== label) {
      toggle.title = label;
      toggle.setAttribute('aria-label', label);
      toggle.replaceChildren(uburoomIcons.icon(doc, state?.state?.paused ? 'play' : 'pause'));
    }
    if (centerPending) requestAnimationFrame(() => centerCurrent());
  }

  function action(parent, label, icon, callback, disabled, className = '') {
    let btn;
    btn = button(
      parent,
      label,
      icon,
      async () => {
        if (busy) return;
        busy = true;
        try {
          await callback();
        } catch (error) {
          uburoomPopover.show(btn, { text: error.message, state: 'error' });
        } finally {
          busy = false;
        }
      },
      disabled,
      'icon-button quiet ' + className,
    );
    return btn;
  }

  function updateUpcomingTimes() {
    const state = getState();
    const duration = state?.queueSummary?.current?.duration || state?.state?.duration || 0;
    let remaining = Math.max(0, duration - (state?.state?.position || 0));
    const ranks = upcomingView.querySelectorAll('.queue-rank');
    const captions = upcomingView.querySelectorAll('.queue-entry-caption');
    const items = currentQueue.items || [];
    items.forEach((item, i) => {
      if (ranks[i]) {
        ranks[i].textContent = i === 0 ? 'NEXT' : '#' + (i + 1);
        ranks[i].classList.toggle('queue-next', i === 0);
      }
      if (captions[i]) captions[i].textContent = 'Up in ' + formatTime(remaining);
      remaining += Math.max(0, item.duration - (item.position || 0));
    });
    const autoRow = upcomingView.querySelector('.queue-entry-auto');
    if (autoRow) {
      const autoCaption = autoRow.querySelector('.queue-entry-caption');
      if (autoCaption) autoCaption.textContent = 'Auto · Up in ' + formatTime(remaining);
    }
  }

  function renderUpcoming() {
    upcomingView.replaceChildren();
    node('h3', upcomingView, 'Upcoming →', 'queue-column-heading');
    const state = getState(),
      items = currentQueue.items || [];
    const autoNext = state?.queueSummary?.autoQueue?.mode !== 'off' ? state?.queueSummary?.autoQueue?.next : null;
    const canEdit = !!state?.capabilities?.editQueue,
      canChoose = !!state?.capabilities?.chooseMedia;
    if (!items.length && !autoNext)
      node(
        'p',
        upcomingView,
        'The queue is empty. Choose "Add to queue" from Media to line up videos.',
        'hint queue-empty',
      );
    const list = node('div', upcomingView, undefined, 'queue-list queue-upcoming-list');
    list.id = 'queue-upcoming-list';
    items.forEach((item, i) => {
      const row = node('article', list, undefined, 'queue-entry');
      row.dataset.entryId = item.id;
      const top = node('div', row, undefined, 'queue-entry-top');
      node('span', top, '', 'queue-rank');
      const moves = node('div', top, undefined, 'queue-move-actions');
      action(
        moves,
        'Move earlier',
        'up',
        () => moveItem(item.id, item.rank - 1),
        !canEdit || i === 0,
        'queue-action-up',
      );
      action(
        moves,
        'Move later',
        'down',
        () => moveItem(item.id, item.rank + 1),
        !canEdit || item.rank === currentQueue.total - 1,
        'queue-action-down',
      );
      action(moves, 'Remove from queue', 'close', () => removeItem(item.id), !canEdit, 'queue-action-remove');
      art(row, item);
      const info = node('div', row, undefined, 'queue-entry-info');
      title(info, item, 'queue-entry-title');
      node('span', info, formatTime(item.duration), 'queue-meta');
      const actions = node('div', row, undefined, 'queue-entry-actions');
      node('span', actions, 'Queue', 'queue-entry-caption');
      action(actions, 'Play now', 'play', () => playEntry(item.id, false), !canChoose, 'queue-action-play');
      const skipLabel = i === 0 ? 'Skip to' : 'Skip ' + i + (i === 1 ? ' item to' : ' items to');
      action(actions, skipLabel, 'player-track-next', () => playEntry(item.id, true), !canChoose, 'queue-action-skip');
    });
    if (autoNext && items.length >= (currentQueue.total || items.length)) {
      const canIdlePlay = !state?.mediaId && !state?.queueSummary?.current && !!state?.capabilities?.playPause;
      const row = node('article', list, undefined, 'queue-entry queue-entry-auto');
      row.dataset.entryId = 'auto:' + autoNext.mediaId;
      const top = node('div', row, undefined, 'queue-entry-top');
      node('span', top, 'AUTO', 'queue-rank queue-rank-auto');
      const moves = node('div', top, undefined, 'queue-move-actions');
      action(
        moves,
        'Add to queue',
        'queue',
        async () => {
          await mutate('auto.pin');
          await changed();
        },
        !state?.capabilities?.addQueue,
        'queue-action-pin',
      );
      const isShuffle = state?.queueSummary?.autoQueue?.mode === 'random';
      action(
        moves,
        'Skip suggestion',
        isShuffle ? 'refresh' : 'end',
        async () => {
          await mutate('auto.skip');
          await changed();
        },
        !canEdit,
        'queue-action-auto-skip',
      );
      art(row, autoNext);
      const info = node('div', row, undefined, 'queue-entry-info');
      title(info, autoNext, 'queue-entry-title');
      node('span', info, formatTime(autoNext.duration), 'queue-meta');
      const actions = node('div', row, undefined, 'queue-entry-actions');
      node('span', actions, 'Auto-queue', 'queue-entry-caption');
      action(
        actions,
        'Play now',
        'play',
        async () => {
          await mutate('auto.playNow');
          await changed();
        },
        !canChoose && !canIdlePlay,
        'queue-action-play',
      );
      const autoSkipLabel =
        items.length === 0 ? 'Skip to' : 'Skip ' + items.length + (items.length === 1 ? ' item to' : ' items to');
      action(
        actions,
        autoSkipLabel,
        'player-track-next',
        async () => {
          if (!items.length) await execute({ action: 'media.next' });
          else {
            await mutate('auto.playNow', { skipPrevious: true });
            await changed();
          }
        },
        !canChoose,
        'queue-action-skip',
      );
    }
    updateUpcomingTimes();
    const actions = node('div', footer, undefined, 'queue-footer-actions watch-control-group');
    if (items.length < currentQueue.total) {
      const more = button(actions, 'Load more upcoming', undefined, async () => {
        const roomId = getState()?.id,
          revision = lastFetchedRevision;
        try {
          const page = await request('room.queue', { roomId, args: { limit: 100, offset: items.length } });
          if (
            getState()?.id !== roomId ||
            lastFetchedRevision !== revision ||
            page.queueRevision !== revision ||
            getState()?.queueSummary?.queueRevision !== revision
          )
            return;
          currentQueue = { ...currentQueue, items: [...items, ...page.items], total: page.total };
          renderTab();
        } catch (error) {
          uburoomPopover.show(more, { text: error.message, state: 'error' });
        }
      });
      uburoomControls.content(more, { label: 'Load more upcoming' });
    }
    const shuffle = action(actions, 'Shuffle queue', 'shuffle', () => mutate('shuffle'), !canEdit || items.length < 2);
    uburoomControls.content(shuffle, { label: 'Shuffle queue', icon: 'shuffle', iconOnly: true });
    shuffle.classList.add('watch-control-solid-disabled');
    if (shuffle.disabled)
      shuffle.title = canEdit
        ? 'Add at least two upcoming videos to shuffle.'
        : 'Queue editing is unavailable for your role.';
    shuffle.id = 'queue-shuffle';
    const clear = button(
      actions,
      'Clear queue',
      undefined,
      async () => {
        if (busy || !getState()?.capabilities?.editQueue || !currentQueue.items.length) return;
        const roomId = getState().id;
        if ((await confirm('Clear all upcoming videos from the queue?')) && getState()?.id === roomId) {
          busy = true;
          try {
            await clearQueue();
          } catch (error) {
            uburoomPopover.show(clear, { text: error.message, state: 'error' });
          } finally {
            busy = false;
          }
        }
      },
      !canEdit || !items.length,
    );
    uburoomControls.content(clear, { label: 'Clear queue' });
    clear.classList.add('watch-control-solid-disabled');
    if (clear.disabled)
      clear.title = canEdit ? 'There are no upcoming videos to clear.' : 'Queue editing is unavailable for your role.';
    clear.id = 'queue-clear-queue';
  }

  function renderHistory() {
    historyView.replaceChildren();
    const top = node('div', historyView, undefined, 'queue-history-heading');
    node('h3', top, '← History', 'queue-column-heading');
    const state = getState(),
      items = currentHistory.items || [];
    const canChoose = !!state?.capabilities?.chooseMedia;
    const clear = button(
      top,
      'Clear history',
      undefined,
      async () => {
        if (busy || !getState()?.capabilities?.editQueue || !currentHistory.items.length) return;
        const roomId = getState().id;
        if ((await confirm('Clear all playback history for this room?')) && getState()?.id === roomId) {
          busy = true;
          try {
            await clearHistory();
          } catch (error) {
            uburoomPopover.show(clear, { text: error.message, state: 'error' });
          } finally {
            busy = false;
          }
        }
      },
      !state?.capabilities?.editQueue || !items.length,
      'queue-clear-history',
    );
    uburoomControls.content(clear, { label: 'Clear history' });
    clear.classList.add('watch-control-solid-disabled');
    if (clear.disabled)
      clear.title = state?.capabilities?.editQueue
        ? 'There is no playback history to clear.'
        : 'Queue editing is unavailable for your role.';
    clear.id = 'queue-clear-history';
    footer.querySelector('.queue-footer-actions').prepend(clear);
    if (!items.length) node('p', historyView, 'No playback history yet.', 'hint queue-empty');
    if (items.length < currentHistory.total) {
      const older = button(
        historyView,
        'Load older history',
        undefined,
        async () => {
          const roomId = getState()?.id,
            revision = lastFetchedRevision;
          older.disabled = true;
          try {
            const page = await request('room.history', { roomId, args: { limit: 100, offset: items.length } });
            if (
              getState()?.id !== roomId ||
              lastFetchedRevision !== revision ||
              page.queueRevision !== revision ||
              getState()?.queueSummary?.queueRevision !== revision
            )
              return;
            currentHistory = { items: [...items, ...page.items], total: page.total };
            renderTab();
          } catch (error) {
            uburoomPopover.show(older, { text: error.message, state: 'error' });
          } finally {
            older.disabled = false;
          }
        },
        false,
        'quiet queue-history-older',
      );
    }
    const list = node('div', historyView, undefined, 'queue-list queue-history-list');
    list.id = 'queue-history-list';
    for (const item of [...items].reverse()) {
      const row = node('article', list, undefined, 'queue-history-entry');
      row.dataset.entryId = item.id;
      const outcome = item.outcome || 'interrupted';
      const label = outcome === 'completed' ? 'Completed' : outcome === 'skipped' ? 'Skipped' : 'Stopped';
      const top = node('div', row, undefined, 'queue-entry-top');
      const status = node('span', top, undefined, 'queue-history-status queue-rank outcome-' + outcome);
      const moves = node('div', top, undefined, 'queue-move-actions');
      action(
        moves,
        'Remove from history',
        'close',
        () => removeItem(item.id),
        !state?.capabilities?.editQueue,
        'queue-action-remove',
      );
      status.title = label;
      node('span', status, label.toUpperCase(), 'queue-outcome-label');
      art(row, item);
      const info = node('div', row, undefined, 'queue-entry-info');
      title(info, item, 'queue-entry-title');
      node(
        'span',
        info,
        outcome === 'completed'
          ? formatTime(item.duration)
          : formatTime(item.position) + ' / ' + formatTime(item.duration),
        'queue-meta',
      );
      const actions = node('div', row, undefined, 'queue-entry-actions');
      node('span', actions, 'History', 'queue-entry-caption');
      action(
        actions,
        'Restart from here',
        'player-track-prev',
        () => replayHistory(item.id, true, true),
        !canChoose,
        'queue-item-go-back',
      );
      action(
        actions,
        'Restart now',
        'rotate-clockwise',
        () => replayHistory(item.id, false),
        !canChoose,
        'queue-item-restart',
      );
    }
  }

  function renderTab() {
    const scrollTop = layout.scrollTop;
    footer.querySelector('.queue-footer-actions')?.remove();
    renderUpcoming();
    renderHistory();
    updateViewsVisibility();
    for (const img of observedImages)
      if (!img.isConnected) {
        imageObserver.unobserve(img);
        observedImages.delete(img);
      }
    layout.scrollTop = scrollTop;
    if (Boolean(layout.querySelector('.queue-history-entry')) !== hadHistory) centerPending = true;
    if (centerPending) requestAnimationFrame(() => centerCurrent());
    else updateNavigation();
    scheduleNavigation();
  }

  function fetchData(force = false) {
    refetchForce ||= force;
    if (fetching) {
      refetchNeeded = true;
      return fetching;
    }
    fetching = (async () => {
      do {
        refetchNeeded = false;
        const force = refetchForce;
        refetchForce = false;
        const state = getState();
        if (!state?.durable || !state.id) break;
        const roomId = state.id,
          rev = state.queueSummary?.queueRevision ?? 0;
        if (!force && lastFetchedRoomId === roomId && lastFetchedRevision >= rev) break;
        try {
          const [qRes, hRes] = await Promise.all([
            request('room.queue', { roomId, args: { limit: 100 } }),
            request('room.history', { roomId, args: { limit: 100 } }),
          ]);
          if (getState()?.id !== roomId) {
            refetchNeeded = true;
            continue;
          }
          if ((getState()?.queueSummary?.queueRevision ?? 0) < qRes.queueRevision) await changed();
          if (
            getState()?.id !== roomId ||
            qRes.queueRevision !== hRes.queueRevision ||
            qRes.queueRevision !== getState()?.queueSummary?.queueRevision
          ) {
            refetchNeeded = true;
            continue;
          }
          // Publish the current item and both lists together from one revision.
          currentQueue = qRes;
          currentHistory = hRes;
          lastFetchedRevision = qRes.queueRevision;
          lastFetchedRoomId = roomId;
          renderHeaderBadge(getState().queueSummary);
          renderNowPlaying();
          if (centerAfterFetch) {
            centerPending = true;
            centerAfterFetch = false;
          }
          renderTab();
        } catch (error) {
          fail?.(error.message);
          break;
        }
      } while (refetchNeeded);
    })().finally(() => {
      fetching = null;
    });
    return fetching;
  }

  function queueRevision(state) {
    return Math.max(
      state.queueSummary?.queueRevision ?? 0,
      lastFetchedRoomId === state.id ? (currentQueue.queueRevision ?? 0) : 0,
    );
  }

  async function add(item, trigger) {
    const state = getState();
    if (!state?.id || !state.durable) throw new Error('Durable room required');
    const roomId = state.id;
    const rev = queueRevision(state);
    const res = await request('room.queue.command', {
      roomId,
      args: { action: 'add', item, expectedRevision: rev },
    });
    if (trigger) {
      uburoomPopover.show(trigger, { text: 'Added ' + (item.title || 'item') + ' to queue.', state: 'success' });
    }
    await fetchData(true);
    return res;
  }

  async function mutate(action, args = {}) {
    const state = getState();
    if (!state?.id || !state.durable) throw new Error('Durable room required');
    const expectedRevision = queueRevision(state);
    const result = await request(
      'room.queue.command',
      { roomId: state.id, args: { action, ...args, expectedRevision } },
      ['bulk', 'auto', 'auto.skip', 'auto.pin', 'auto.playNow', 'playEntry', 'skipTo', 'remove'].includes(action)
        ? { timeoutMs: 35000 }
        : {},
    );
    await fetchData(true);
    return result;
  }

  async function moveItem(entryId, targetRank) {
    const state = getState();
    if (!state?.id) return;
    await request('room.queue.command', {
      roomId: state.id,
      args: { action: 'move', entryId, targetRank, expectedRevision: queueRevision(state) },
    });
    await changed();
    await fetchData(true);
  }

  async function removeItem(entryId) {
    const state = getState();
    if (!state?.id) return;
    const rev = queueRevision(state);
    await request('room.queue.command', {
      roomId: state.id,
      args: { action: 'remove', entryId, expectedRevision: rev },
    });
    await fetchData(true);
  }

  async function removeCurrent(advance) {
    const state = getState(),
      entryId = state?.queueSummary?.current?.id;
    if (!entryId) return;
    await mutate('remove', { entryId, advance });
    await changed();
  }

  async function clearQueue() {
    const state = getState();
    if (!state?.id) return;
    const rev = queueRevision(state);
    await request('room.queue.command', { roomId: state.id, args: { action: 'clear', expectedRevision: rev } });
    await fetchData(true);
  }

  async function playEntry(entryId, skipPrevious = false) {
    const state = getState();
    if (!state?.id) return;
    await mutate(skipPrevious ? 'skipTo' : 'playEntry', { entryId, skipPrevious });
    await changed();
  }

  async function replayHistory(entryId, resume, restore = false) {
    const state = getState();
    if (!state?.id) return;
    await request(
      'room.history.command',
      {
        roomId: state.id,
        args: {
          action: restore ? 'goBack' : 'replay',
          entryId,
          resume,
          expectedRevision: queueRevision(state),
        },
      },
      { timeoutMs: 35000 },
    );
    await fetchData(true);
    await changed();
  }

  async function clearHistory() {
    const state = getState();
    if (!state?.id) return;
    await request('room.history.command', { roomId: state.id, args: { action: 'clear' } });
    await fetchData(true);
    await changed();
  }

  function render(queueSummary) {
    const state = getState();
    const panel = doc.getElementById('queue-panel');
    if (!panel) return;
    const visible = !state || !!state?.durable;
    panel.hidden = !visible;
    renderContinuation();
    if (!visible) {
      if (lastFetchedRoomId) {
        clearArtwork();
        lastFetchedRoomId = null;
        lastFetchedRevision = -1;
      }
      if (bulkDialog.open) bulkDialog.close();
      autoNotice.textContent = '';
      return;
    }
    if (!state) {
      if (lastFetchedRoomId) {
        clearArtwork();
        lastFetchedRoomId = null;
        lastFetchedRevision = -1;
      }
      currentQueue = { items: [], total: 0, queueRevision: 0 };
      currentHistory = { items: [], total: 0 };
      renderTab();
      renderNowPlaying();
      renderHeaderBadge();
      return;
    }

    if (state.id !== lastFetchedRoomId) {
      currentQueue = { items: [], total: 0, queueRevision: 0 };
      currentHistory = { items: [], total: 0 };
      currentKey = '';
      currentId = undefined;
      centerPending = centerAfterFetch = true;
      clearArtwork();
      lastFetchedRoomId = state.id;
      lastFetchedRevision = -1;
      renderTab();
    }
    if (lastFetchedRevision < 0 || lastFetchedRevision === queueSummary?.queueRevision) {
      const autoNextKey = JSON.stringify(
        queueSummary?.autoQueue?.mode !== 'off' ? queueSummary?.autoQueue?.next || null : null,
      );
      if (autoNextKey !== lastAutoNextKey) {
        lastAutoNextKey = autoNextKey;
        renderTab();
      }
      renderNowPlaying();
      updateUpcomingTimes();
    }
    const permissions = JSON.stringify(state.capabilities);
    if (permissions !== capabilityKey) {
      capabilityKey = permissions;
      renderTab();
    }
    if (queueSummary) {
      renderHeaderBadge(queueSummary);
      if (queueSummary.queueRevision > lastFetchedRevision || state.id !== lastFetchedRoomId) {
        void fetchData();
      }
    }
  }

  let rememberedPosition;
  return {
    rememberPosition() {
      if (layout.clientWidth) rememberedPosition = { room: getState()?.id, top: layout.scrollTop };
    },
    restorePosition() {
      const saved = rememberedPosition;
      if (layout.clientWidth && saved?.room === getState()?.id)
        requestAnimationFrame(() => {
          if (!layout.clientWidth) return;
          layout.scrollTo({ top: saved.top, behavior: 'instant' });
          updateNavigation();
        });
    },
    render,
    add,
    bulk,
    openAuto,
    fetchData,
    get selectedEntryId() {
      return null;
    },
    selectEntry(entryId) {
      centerEntry(entries().find(row => row.dataset.entryId === entryId));
    },
  };
}

export { mount };
