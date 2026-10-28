/* Playback queue and history UI; safe DOM only, shared command engine. */
(function(root) {
  'use strict';

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    if (h > 0) {
      return h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
    }
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function mount(host, { request, getState, getMe, fail, changed, execute, serverTime, openLibraryItem, artwork, openSettings, browseMedia, getSettingsState = getState, saveSettings }) {
    const doc = host.ownerDocument;
    let view = 'cards';
    try { if (localStorage.getItem('uburoom-queue-view') === 'list') view = 'list'; } catch {}
    let centerPending = true;
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
    let cancelPending = false;
    let bulkPending = false;
    let autoPending = false;
    let lastAutoplayError = '';
    let lastFetchedRevision = -1;
    let lastFetchedRoomId = null;
    let moveFollow = null;

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
      if (iconName && root.uburoomIcons?.icon) {
        b.append(root.uburoomIcons.icon(doc, iconName));
      } else {
        b.textContent = label;
      }
      if (action) b.addEventListener('click', action);
      return b;
    }

    const popups = root.uburoomDialogs;
    const confirm = message => popups.confirm(message, {destructive:true});

    host.dataset.view = view;
    const header = node('header', host, undefined, 'queue-header watch-panel-header');
    const heading = node('h2', header, undefined, 'queue-heading watch-panel-heading');
    heading.append(root.uburoomIcons.icon(doc, 'queue'), doc.createTextNode('Queue'));
    const views = node('div', header, undefined, 'queue-view-switch watch-segmented watch-segmented-view');
    views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Queue layout');
    const viewButtons = ['cards', 'list'].map(value => {
      const b = button(views, value === 'cards' ? 'Cards' : 'List', value === 'cards' ? 'libraryCards' : 'libraryList', () => {
        view = value; host.dataset.view = view;
        try { localStorage.setItem('uburoom-queue-view', view); } catch {}
        centerPending = true; renderNowPlaying(); renderTab(); updateView();
      }, false, 'queue-view-button group-button');
      node('span', b, value === 'cards' ? 'Cards' : 'List');
      b.id = 'queue-view-' + value; return b;
    });
    root.uburoomControls.segmented(views);
    const body = node('div', host); body.id = 'queue-body';
    const toolbar = node('div', header, undefined, 'queue-toolbar watch-toolbar'); toolbar.append(views);
    const centerButton = button(toolbar, 'Center Now Playing', 'center', () => centerCurrent(true));
    root.uburoomControls.content(centerButton,{label:'Center Now Playing',icon:'center'});
    centerButton.id = 'queue-center';
    const timeline = node('div', body, undefined, 'queue-timeline');
    const navigation = node('div', timeline, undefined, 'queue-navigation');
    const previousCard = button(navigation, 'Scroll toward history', 'left', () => scrollCards(-1));
    previousCard.id = 'queue-scroll-previous';
    const previousCount = node('span',previousCard,'','queue-navigation-count');
    const nextCard = button(navigation, 'Scroll toward upcoming videos', 'right', () => scrollCards(1));
    const nextCount = node('span',nextCard,'','queue-navigation-count');
    nextCard.id = 'queue-scroll-next';
    const layout = node('div', timeline, undefined, 'queue-layout');
    layout.tabIndex = 0; layout.setAttribute('role', 'region'); layout.setAttribute('aria-label', 'Playback queue timeline');
    const historyView = node('section', layout, undefined, 'queue-view queue-history-view');
    historyView.id = 'queue-history-view'; historyView.setAttribute('aria-label', 'Playback history');
    const nowPlayingBox = node('div', layout, undefined, 'queue-now-playing');
    const upcomingView = node('section', layout, undefined, 'queue-view queue-upcoming-view');
    upcomingView.id = 'queue-upcoming-view'; upcomingView.setAttribute('aria-label', 'Upcoming videos');
    const emptyScreen = node('section', body, undefined, 'queue-empty-screen'); emptyScreen.id = 'queue-empty-screen';
    emptyScreen.append(root.uburoomIcons.icon(doc, 'queue'));
    const emptyTitle = node('p', emptyScreen, '', 'queue-empty-title');
    const emptyBrowse = button(emptyScreen, 'Browse media', 'media', () => browseMedia()); node('span', emptyBrowse, 'Browse media');
    const footer = node('div', body, undefined, 'queue-footer');
    const notice = node('p', footer, '', 'hint queue-notice'); notice.setAttribute('role', 'status');


    const continuation = node('div', header, undefined, 'queue-continuation queue-quick-controls watch-control-group');
    const autoplayLabel = node('label', continuation, undefined, 'queue-check watch-switch-label');
    const autoplayToggle = node('input', autoplayLabel);
    autoplayToggle.type = 'checkbox';
    autoplayToggle.id = 'queue-autoplay';
    autoplayToggle.className = 'watch-switch'; autoplayToggle.setAttribute('role','switch');
    autoplayLabel.append(doc.createTextNode('Auto-play'));
    const autoOpen = button(continuation, 'Queue settings', 'settings', () => openSettings(), false, 'icon-button');
    root.uburoomControls.content(autoOpen,{label:'Queue settings',icon:'settings',iconOnly:true});
    autoOpen.id = 'queue-auto-open';
    const autoLabel = node('label', continuation, undefined, 'queue-check watch-switch-label');
    const autoToggle = node('input', autoLabel); autoToggle.type = 'checkbox'; autoToggle.id = 'queue-auto-toggle';
    autoToggle.className = 'watch-switch'; autoToggle.setAttribute('role','switch');
    autoLabel.append(doc.createTextNode('Auto-queue')); continuation.append(autoOpen);
    let rememberedAuto = null, rememberedRoom, lastAutoNextKey = '';
    autoToggle.addEventListener('change', async () => {
      if (autoPending) return;
      autoPending = true; autoToggle.disabled = true;
      notice.textContent = 'Saving Auto-queue…';
      const targetAuto = autoToggle.checked ? (rememberedAuto || { mode: 'continue', scope: null, includeSpecials: false }) : { mode: 'off', scope: null, includeSpecials: false };
      try { await mutate('auto', targetAuto); await changed(); }
      catch (error) { notice.textContent = error.message; }
      finally { autoPending = false; if (notice.textContent === 'Saving Auto-queue…') notice.textContent = 'Auto-queue saved.'; renderContinuation(); }
    });

    autoplayToggle.addEventListener('change', async () => {
      if (autoplayPending) return;
      autoplayPending = true; autoplayToggle.disabled = true;
      notice.textContent = 'Saving Auto-play…';
      try { await execute({ action: 'media.autoplay.set', args: { enabled: autoplayToggle.checked } }); }
      catch (error) { notice.textContent = error.message; }
      finally { autoplayPending = false; if (notice.textContent === 'Saving Auto-play…') notice.textContent = 'Auto-play saved.'; renderContinuation(); }
    });

    function renderContinuation() {
      const state = getState();
      if (!autoplayPending) autoplayToggle.checked = state?.autoplay?.enabled !== false;
      autoplayToggle.disabled = autoplayPending || !state?.capabilities?.autoplay;
      autoOpen.disabled = !state?.durable;
      autoplayToggle.title = autoplayToggle.disabled ? (autoplayPending ? 'Saving Auto-play…' : 'Auto-play is unavailable for your role.') : 'Auto-play';
      autoOpen.title = autoOpen.disabled ? 'Join a room to change queue settings.' : 'Queue settings';
      const auto = state?.queueSummary?.autoQueue;
      if (rememberedRoom !== state?.id) { rememberedAuto = null; rememberedRoom = state?.id; }
      if (auto?.mode && auto.mode !== 'off') rememberedAuto = { mode: auto.mode, scope: auto.scope, includeSpecials: auto.includeSpecials };
      if (!autoPending) autoToggle.checked = !!auto?.mode && auto.mode !== 'off';
      autoToggle.disabled = autoPending || !state?.capabilities?.editQueue;
      autoToggle.title = autoToggle.disabled ? (autoPending ? 'Saving Auto-queue…' : 'Queue editing is unavailable for your role.') : 'Auto-queue';
      if (state?.autoplay?.error) notice.textContent = state.autoplay.error;
      else if (lastAutoplayError && notice.textContent === lastAutoplayError) notice.textContent = '';
      lastAutoplayError = state?.autoplay?.error || '';
    }
    setInterval(renderContinuation, 250);

    const bulkDialog = node('dialog', doc.body, undefined, 'privacy-dialog queue-dialog');
    bulkDialog.id = 'queue-bulk-dialog';
    bulkDialog.setAttribute('aria-labelledby', 'queue-bulk-title');
    const bulkTitle = node('h2', bulkDialog, 'Add episodes to queue');
    bulkTitle.id = 'queue-bulk-title';
    const bulkDescription = node('p', bulkDialog, '', 'hint');
    const bulkFilterLabel = node('label', bulkDialog, 'Episodes');
    const bulkFilter = node('select', bulkFilterLabel);
    bulkFilter.id = 'queue-bulk-filter';
    for (const [value, label] of [['all', 'All episodes'], ['unfinished', 'Unfinished by this room']]) {
      const option = node('option', bulkFilter, label); option.value = value;
    }
    const bulkSpecialLabel = node('label', bulkDialog, undefined, 'queue-check watch-switch-label');
    const bulkSpecials = node('input', bulkSpecialLabel); bulkSpecials.type = 'checkbox'; bulkSpecials.id = 'queue-bulk-specials';
    bulkSpecials.className = 'watch-switch'; bulkSpecials.setAttribute('role','switch');
    bulkSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
    node('p', bulkDialog, 'Current and upcoming episodes are excluded. The server limits upcoming videos; an addition that exceeds its limit is rejected in full.', 'hint');
    const bulkStatus = node('p', bulkDialog, '', 'hint'); bulkStatus.setAttribute('role', 'status');
    const bulkActions = node('div', bulkDialog, undefined, 'room-actions');
    const bulkCancel = button(bulkActions, 'Cancel', undefined, () => popups.close(bulkDialog));
    const bulkSubmit = button(bulkActions, 'Add to queue', undefined, undefined, false, 'primary'); bulkSubmit.id = 'queue-bulk-submit';
    let bulkDirty = false;
    bulkFilter.addEventListener('change',() => { bulkDirty = true; });
    bulkSpecials.addEventListener('change',() => { bulkDirty = true; });
    popups.register(bulkDialog, {busy:() => bulkPending, dirty:() => bulkDirty});

    async function bulk(item) {
      if (bulkDialog.open) return;
      const roomId = getState()?.id;
      if (!roomId) return;
      bulkTitle.textContent = 'Add ' + (item.type === 'season' ? 'season' : 'show') + ' to queue';
      bulkDescription.textContent = item.title + (item.episodeCount ? ' · ' + item.episodeCount + ' episodes available' : '');
      bulkDirty = false; bulkStatus.textContent = ''; bulkSubmit.disabled = bulkCancel.disabled = false;
      bulkSubmit.onclick = async () => {
        if (getState()?.id !== roomId || !getState()?.capabilities?.addQueue) { bulkDialog.close(); return; }
        bulkPending = true; bulkSubmit.disabled = bulkCancel.disabled = bulkFilter.disabled = bulkSpecials.disabled = true; bulkStatus.textContent = 'Loading episodes…';
        try {
          const result = await mutate('bulk', { type: item.type, mediaId: item.id, unfinished: bulkFilter.value === 'unfinished', includeSpecials: bulkSpecials.checked });
          bulkDialog.close('added');
          notice.textContent = 'Episodes added to queue' + (Number.isInteger(result?.addedCount) ? ': ' + result.addedCount : '') + '.';
        } catch (error) { bulkStatus.textContent = error.message; }
        finally { bulkPending = false; bulkSubmit.disabled = bulkCancel.disabled = bulkFilter.disabled = bulkSpecials.disabled = false; }
      };
      popups.open(bulkDialog);
    }

    const autoDialog = node('div', doc.getElementById('room-playback-controls'), undefined, 'queue-settings');
    const settingsAutoplayLabel = node('label', autoDialog, undefined, 'queue-check watch-switch-label');
    const settingsAutoplay = node('input', settingsAutoplayLabel); settingsAutoplay.type = 'checkbox'; settingsAutoplay.id = 'room-autoplay';
    settingsAutoplay.className = 'watch-switch'; settingsAutoplay.setAttribute('role','switch');
    settingsAutoplayLabel.append(doc.createTextNode('Auto-play next video'));
    settingsAutoplay.addEventListener('change',async () => {
      settingsAutoplay.disabled = true; setAutoNotice('Saving…');
      try { await saveSettings({autoplay:settingsAutoplay.checked}); setAutoNotice('Saved', true); }
      catch (error) { setAutoNotice(error.message); }
      finally { settingsAutoplay.checked = getSettingsState()?.autoplay?.enabled !== false; settingsAutoplay.disabled = !getSettingsState()?.capabilities?.autoplay; }
    });
    autoDialog.id = 'queue-auto-dialog'; autoDialog.setAttribute('aria-labelledby', 'queue-auto-title');
    node('h4', autoDialog, 'Auto-queue').id = 'queue-auto-title';
    const autoModeLabel = node('label', autoDialog, 'Mode');
    const autoMode = node('select', autoModeLabel); autoMode.id = 'queue-auto-mode';
    autoMode.hidden = true;
    for (const [value, label] of [['off', 'Off'], ['continue', 'Continue'], ['following', 'In order'], ['random', 'Shuffle']]) {
      const option = node('option', autoMode, label); option.value = value;
    }
    const autoModeGroup = node('div', autoDialog, undefined, 'button-group watch-segmented');
    autoModeGroup.id = 'queue-auto-mode-group';
    autoModeGroup.setAttribute('role', 'group');
    autoModeGroup.setAttribute('aria-label', 'Mode');
    const modeButtons = new Map();
    for (const [value, label] of [['off', 'Off'], ['continue', 'Continue'], ['following', 'In order'], ['random', 'Shuffle']]) {
      const btn = node('button', autoModeGroup, label, 'group-button');
      btn.type = 'button';
      btn.dataset.value = value;
      btn.title = value === 'off' ? 'Do not generate queued videos automatically.' :
        value === 'continue' ? 'Automatically queue the next episode of the last TV show in the queue.' :
        value === 'following' ? 'Queue episodes in order from the selected show.' :
        'Shuffle videos from the selected source.';
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
    root.uburoomControls.segmented(autoModeGroup);
    const autoSource = node('p', autoDialog, '', 'hint'); autoSource.id = 'queue-auto-source';
    const sourceChange = button(autoDialog,'Change source',undefined,() => { sourcePicker.hidden = false; void browseSources(); }); sourceChange.id = 'queue-source-change';
    const sourcePicker = node('section',autoDialog,undefined,'queue-source-picker'); sourcePicker.id = 'queue-source-picker'; sourcePicker.hidden = true;
    const sourceTitle = node('strong',sourcePicker,'Choose source');
    const sourceNotice = node('p',sourcePicker,'','hint'); sourceNotice.setAttribute('role','status');
    const sourceRows = node('div',sourcePicker);
    const sourceNav = node('div',sourcePicker,undefined,'room-actions');
    button(sourceNav,'Libraries',undefined,() => void browseSources());
    button(sourceNav,'Close picker','close',() => { sourcePicker.hidden = true; });
    let draftScope = {type:'show'}, sourceTicket = 0, autoRoom, autoTicket = 0, hasAutoDraft = false, autoNoticeTimer;
    popups.register(doc.getElementById('room-settings-dialog'), {dirty:() => hasAutoDraft, busy:() => autoPending});
    const sourceNames = new Map();
    function setAutoNotice(text, transient = false) {
      clearTimeout(autoNoticeTimer);
      autoNotice.textContent = text;
      if (transient) autoNoticeTimer = setTimeout(() => { if (autoNotice.textContent === text) autoNotice.textContent = ''; }, 2500);
    }
    function sourceKey(scope, state = getSettingsState()) {
      return scope.type + ':' + (scope.id || ('current:' + (state?.queueSummary?.current?.grandparentTitle || state?.mediaId || 'none')));
    }
    function chooseSource(scope,title) {
      ++autoTicket; hasAutoDraft = true;
      draftScope = scope; sourceNames.set(sourceKey(scope),title); autoSource.textContent = title;
      if (scope.type !== 'show' && autoMode.value === 'following') autoMode.value = 'random';
      sourcePicker.hidden = true; sourceChange.focus(); updateAutoFields();
    }
    async function browseSources(query = {}, title = 'Libraries') {
      const ticket = ++sourceTicket, roomId = getSettingsState()?.id;
      sourceTitle.textContent = title; sourceRows.replaceChildren(); sourceNotice.textContent = 'Loading…';
      try {
        const data = await request('/api/watch/library?' + new URLSearchParams(query));
        if (ticket !== sourceTicket || roomId !== getSettingsState()?.id || sourcePicker.hidden) return;
        sourceNotice.textContent = data.items.length ? '' : 'No sources available.';
        for (const item of data.items) {
          const row = node('div',sourceRows,undefined,'source-row'); node('span',row,item.title);
          if (item.type === 'library') {
            if (item.mediaType === 'movie') button(row,'Use library',undefined,() => chooseSource({type:'library',id:item.id},item.title));
            else button(row,'Shows',undefined,() => void browseSources({section:item.id},item.title));
            button(row,'Collections',undefined,() => void browseSources({section:item.id,tab:'collections'},item.title + ' collections'));
          } else if (['show','collection'].includes(item.type)) button(row,'Use source',undefined,() => chooseSource({type:item.type,id:item.id},item.title));
        }
        if (data.nextOffset !== null && data.nextOffset !== undefined) button(sourceRows,'Next page',undefined,() => void browseSources({...query,offset:data.nextOffset},title));
        if (Number(query.offset) > 0) button(sourceRows,'Previous page',undefined,() => void browseSources({...query,offset:Math.max(0,Number(query.offset)-48)},title));
      } catch (error) { if (ticket === sourceTicket) sourceNotice.textContent = error.message; }
    }
    async function sourceName(scope,state,ticket) {
      const key = sourceKey(scope, state);
      if (sourceNames.has(key)) {
        if (ticket === autoTicket && draftScope === scope) autoSource.textContent = sourceNames.get(key);
        return;
      }
      autoSource.textContent = 'Loading source…';
      try {
        let title;
        if (!scope.id) title = state.queueSummary?.current?.grandparentTitle;
        else if (scope.type === 'library') title = (await request('/api/watch/library')).items.find(item => item.id === scope.id)?.title;
        else title = (await request('/api/watch/library/item?' + new URLSearchParams({item:scope.id,type:scope.type}))).item.title;
        if (ticket !== autoTicket || getSettingsState()?.id !== state.id || draftScope !== scope) return;
        autoSource.textContent = title || 'Choose a source'; if (title) sourceNames.set(key,title);
      } catch (error) { if (ticket === autoTicket && draftScope === scope) autoSource.textContent = 'Source unavailable: ' + error.message; }
    }
    function updateAutoFields() {
      const hideSource = autoMode.value === 'off' || autoMode.value === 'continue';
      autoSource.hidden = sourceChange.hidden = hideSource;
      autoSpecialLabel.hidden = hideSource || draftScope.type !== 'show';
      autoMode.querySelector('[value=following]').disabled = draftScope.type !== 'show';
      if (hideSource) sourcePicker.hidden = true;
      syncAutoModeButtons();
    }
    autoMode.addEventListener('change',() => { hasAutoDraft = true; updateAutoFields(); });
    const autoSpecialLabel = node('label', autoDialog, undefined, 'queue-check watch-switch-label');
    const autoSpecials = node('input', autoSpecialLabel); autoSpecials.type = 'checkbox'; autoSpecials.id = 'queue-auto-specials';
    autoSpecials.className = 'watch-switch'; autoSpecials.setAttribute('role','switch');
    autoSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
    autoSpecials.addEventListener('change',() => { hasAutoDraft = true; });
    const autoNotice = node('p', autoDialog, '', 'hint'); autoNotice.setAttribute('role', 'status');
    const autoActions = node('div', autoDialog, undefined, 'room-actions queue-settings-footer');
    const autoCancel = button(autoActions, 'Reset changes', undefined, () => { hasAutoDraft = false; void openAuto(); });
    const autoSave = button(autoActions, 'Save auto-queue', undefined, undefined, false, 'primary'); autoSave.id = 'queue-auto-save';
    const autoReset = button(autoActions,'Reset auto-queue progress',undefined,async () => {
      if (!await confirm('Reset auto-queue progress? Episode progress and repeat prevention will restart. Upcoming items and visible history stay unchanged.')) return;
      autoReset.disabled = true; setAutoNotice('Resetting…');
      try { await saveSettings({resetProgress:true}); setAutoNotice('Auto-queue progress reset',true); await changed(); }
      catch (error) { setAutoNotice(error.message); }
      finally { autoReset.disabled = !getSettingsState()?.capabilities?.editQueue; }
    }); autoReset.id = 'queue-auto-progress-reset';
    doc.addEventListener('room-playback-settings' ,() => { if (!autoPending && (!hasAutoDraft || autoRoom !== getSettingsState()?.id)) void openAuto(); });
    async function openAuto(source) {
      const state = getSettingsState(), roomId = state?.id;
      if (!roomId) return;
      if (source) await openSettings();
      if (getSettingsState()?.id !== roomId) return;
      const config = state.queueSummary?.autoQueue;
      if (autoRoom !== roomId) { hasAutoDraft = false; sourceNames.clear(); }
      autoRoom = roomId;
      if (!hasAutoDraft || source) {
        autoMode.value = source ? 'random' : config?.mode || 'off';
        autoSpecials.checked = !!config?.includeSpecials;
        draftScope = source?.scope || config?.scope || { type: 'show' };
        if (source) hasAutoDraft = true;
      }
      const ticket = ++autoTicket;
      if (source?.title) sourceNames.set(sourceKey(draftScope, state),source.title);
      void sourceName(draftScope,state,ticket); sourcePicker.hidden = true;
      autoReset.hidden = !!state.draft; autoReset.disabled = !state.capabilities?.editQueue;
      setAutoNotice(''); autoSave.disabled = autoMode.disabled = autoSpecials.disabled = !state.capabilities?.editQueue;
      settingsAutoplay.checked = state.autoplay?.enabled !== false; settingsAutoplay.disabled = !state.capabilities?.autoplay;
      sourceChange.disabled = !state.capabilities?.editQueue; updateAutoFields();

      autoSave.onclick = async () => {
        if (getSettingsState()?.id !== roomId || !getSettingsState()?.capabilities?.editQueue) { return; }
        autoPending = true; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = sourceChange.disabled = true; setAutoNotice('Saving…');
        try {
          const hasScope = ['following', 'random'].includes(autoMode.value);
          const selectedScope = hasScope ? { ...draftScope } : null;
          await saveSettings({autoQueue:{ mode: autoMode.value, scope: selectedScope, includeSpecials: hasScope && draftScope.type === 'show' && autoSpecials.checked }});
          hasAutoDraft = false;
          setAutoNotice('Saved', true); await changed();
        } catch (error) { setAutoNotice(error.message); }
        finally { autoPending = false; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = sourceChange.disabled = !getSettingsState()?.capabilities?.editQueue; }
      };

    }

    function motion() {
      return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    }

    function centerCurrent(smooth = false) {
      if (!layout.clientWidth) return;
      if (view === 'list') {
        layout.style.paddingBlock = Math.max(0, (layout.clientHeight - nowPlayingBox.offsetHeight) / 2) + 'px';
        const r = nowPlayingBox.getBoundingClientRect(), bounds = layout.getBoundingClientRect();
        layout.scrollTo({ top: layout.scrollTop + r.top - bounds.top - (layout.clientHeight - r.height) / 2, behavior: smooth ? motion() : 'instant' });
        centerPending = false; return;
      }
      layout.style.paddingBlock = '';
      layout.style.paddingInline = '0px';
      const inset = Math.max(0, (layout.clientWidth - nowPlayingBox.offsetWidth) / 2);
      layout.style.paddingInline = inset + 'px';
      const r = nowPlayingBox.getBoundingClientRect(), bounds = layout.getBoundingClientRect();
      layout.scrollTo({ left: layout.scrollLeft + r.left - bounds.left - inset, behavior: smooth ? motion() : 'instant' });
      centerPending = false;
      updateNavigation();
    }

    function entries() {
      return [...layout.querySelectorAll('.queue-entry,.queue-history-entry,.queue-now-playing')].filter(row => row.dataset.entryId);
    }
    function nearestEntry() {
      const bounds = layout.getBoundingClientRect(), horizontal = view === 'cards';
      const center = horizontal ? bounds.left + layout.clientWidth / 2 : bounds.top + layout.clientHeight / 2;
      let closest, distance = Infinity;
      for (const row of entries()) {
        const rect = row.getBoundingClientRect();
        const delta = Math.abs((horizontal ? rect.left + rect.width / 2 : rect.top + rect.height / 2) - center);
        if (delta < distance) { closest = row; distance = delta; }
      }
      return closest;
    }
    function centerEntry(target, smooth = true) {
      if (!target || timeline.hidden) return;
      const rect = target.getBoundingClientRect(), bounds = layout.getBoundingClientRect();
      layout.scrollTo(view === 'cards' ? { left:layout.scrollLeft + rect.left - bounds.left - (layout.clientWidth - rect.width) / 2, behavior:smooth ? motion() : 'instant' } :
        { top:layout.scrollTop + rect.top - bounds.top - (layout.clientHeight - rect.height) / 2, behavior:smooth ? motion() : 'instant' });
      updateNavigation();
    }
    function directionTarget(direction) {
      const rows = entries(), selected = nearestEntry();
      const index = rows.indexOf(selected);
      if (index === -1) return undefined;
      return rows[index + direction];
    }
    function scrollCards(direction) { centerEntry(directionTarget(direction)); }
    function updateNavigation() {
      if (!layout.clientWidth) return;
      previousCard.disabled = !directionTarget(-1); nextCard.disabled = !directionTarget(1);
    }
    let navFrame;
    function scheduleNavigation() {
      if (navFrame) return;
      navFrame = requestAnimationFrame(() => { navFrame = undefined; updateNavigation(); });
    }

    function updateView() {
      renderHeaderBadge(getState()?.queueSummary);
      viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(view === (i ? 'list' : 'cards'))));
      navigation.hidden = false;
      previousCard.querySelector('svg')?.replaceWith(root.uburoomIcons.icon(doc,view === 'cards' ? 'left' : 'up'));
      nextCard.querySelector('svg')?.replaceWith(root.uburoomIcons.icon(doc,view === 'cards' ? 'right' : 'down'));
      layout.tabIndex = 0;
      layout.style.paddingBlock = '';
      if (view === 'list') layout.style.paddingInline = '';
      requestAnimationFrame(() => centerCurrent());
    }

    layout.addEventListener('scroll', scheduleNavigation, { passive: true });
    layout.addEventListener('keydown', event => {
      if (event.target !== layout) return;
      if ((view === 'cards' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown']).includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); scrollCards(['ArrowLeft','ArrowUp'].includes(event.key) ? -1 : 1);
      } else if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); centerCurrent(true); }
    });
    let measuredWidth = 0;
    new ResizeObserver(() => {
      if (!layout.clientWidth) return;
      const resized = measuredWidth !== layout.clientWidth; measuredWidth = layout.clientWidth;
      if (resized || centerPending) centerCurrent();
    }).observe(layout);
    updateView();

    const images = new Map();
    const imageRequests = new Map();
    let artworkQueue = [];
    let artworkActive = 0;
    let artworkGeneration = 0;
    let imageController = new AbortController();
    const observedImages = new Set();
    const imageObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        imageObserver.unobserve(entry.target); observedImages.delete(entry.target);
        artworkQueue.push(entry.target);
      }
      pumpArtwork();
    }, { root: layout, rootMargin: '200px' });

    function pumpArtwork() {
      const generation = artworkGeneration;
      while (artworkActive < 4 && artworkQueue.length) {
        const img = artworkQueue.shift();
        if (!img.isConnected) continue;
        artworkActive++;
        void loadArtwork(img).finally(() => {
          if (generation === artworkGeneration) { artworkActive--; pumpArtwork(); }
        });
      }
    }

    function clearArtwork() {
      imageController.abort(); imageController = new AbortController();
      artworkGeneration++; artworkActive = 0; artworkQueue = [];
      imageObserver.disconnect(); observedImages.clear(); imageRequests.clear();
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
            imageRequests.set(key, artwork('/api/watch/library/art?' + params, signal).then(blob => {
              if (!signal.aborted) {
                images.set(key, URL.createObjectURL(blob));
                while (images.size > 220) { const first = images.keys().next().value; URL.revokeObjectURL(images.get(first)); images.delete(first); imageRequests.delete(first); }
              }
            }));
          }
          await imageRequests.get(key);
        }
        if (!signal.aborted && img.isConnected && images.has(key)) { img.src = images.get(key); img.parentElement.parentElement.querySelector('.queue-row-backdrop').style.backgroundImage = 'url(' + images.get(key) + ')'; }
      } catch {
        if (!signal.aborted) { imageRequests.delete(key); img.parentNode?.setAttribute('title', 'Artwork unavailable'); img.remove(); }
      }
    }

    function art(parent, item) {
      node('div',parent,undefined,'queue-row-backdrop').setAttribute('aria-hidden','true');
      const box = node('div', parent, undefined, 'queue-art');
      box.append(root.uburoomIcons.icon(doc, item.type === 'episode' ? 'tv' : 'film'));
      if (!artwork || !/^\d{1,20}$/.test(item.mediaId || item.id || '')) return;
      const img = node('img', box);
      img.alt = ''; img.decoding = 'async';
      img.dataset.item = item.mediaId || item.id; img.dataset.type = item.type || 'movie';
      const cached = images.get(img.dataset.item + ':' + img.dataset.type);
      if (cached) { img.src = cached; parent.querySelector('.queue-row-backdrop').style.backgroundImage = 'url(' + cached + ')'; }
      else { observedImages.add(img); imageObserver.observe(img); }
    }

    function renderHeaderBadge(summary) {
      const qLen = summary?.pendingCount ?? currentQueue.total ?? 0;
      const hLen = summary?.historyCount ?? currentHistory.total ?? 0;
      previousCount.textContent = hLen ? hLen + ' past' : '';
      nextCount.textContent = qLen ? qLen + ' queued' : '';
      const badge = doc.getElementById('queue-count-badge');
      if (badge) { badge.textContent = String(qLen); badge.hidden = qLen === 0; }
    }

    function title(parent, item, className) {
      const targetId = item.mediaId || item.id;
      const target = node(openLibraryItem && targetId ? 'button' : 'strong', parent, item.title || 'Unknown title', 'queue-title-link ' + className);
      if (target.tagName === 'BUTTON') {
        target.type = 'button'; target.title = 'View in library: ' + item.title;
        target.addEventListener('click', () => openLibraryItem({ id: targetId, type: item.type || 'movie', title: item.title }));
      }
      const subtitle = formatSubtitle(item);
      if (subtitle) node('p', parent, subtitle, 'hint queue-entry-subtitle');
    }

    function updateViewsVisibility() {
      const state = getState();
      const noEntries = !state || !(state.mediaId || state.queueSummary?.current || state.queueSummary?.pendingCount || currentQueue.items.length || state.queueSummary?.autoQueue?.next || state.queueSummary?.historyCount || currentHistory.items.length);
      views.hidden = toolbar.hidden = timeline.hidden = noEntries;
      emptyScreen.hidden = !noEntries;
      continuation.hidden = !state;
      host.dataset.view = noEntries ? 'empty' : view;
      host.classList.toggle('queue-is-empty', noEntries);
      emptyTitle.textContent = state ? 'The queue is empty' : 'Join a room to use the queue';
      emptyBrowse.disabled = !getMe?.() || !!state && !state.canBrowse;
    }

    function renderNowPlaying() {
      const state = getState();
      const empty = !state?.mediaId && !state?.queueSummary?.current;
      host.classList.toggle('queue-no-current',empty); host.classList.toggle('queue-no-entries',!(state?.queueSummary?.pendingCount || state?.queueSummary?.autoQueue?.next || state?.queueSummary?.historyCount));
      updateViewsVisibility();
      if (empty) {
        delete nowPlayingBox.dataset.entryId;
        if (currentKey !== 'empty') { nowPlayingBox.replaceChildren(); node('p',nowPlayingBox,'No video selected'); const browse = button(nowPlayingBox,'Browse media','media',() => browseMedia(),!state ? !getMe?.() : !state?.canBrowse); node('span',browse,'Browse media'); currentKey = 'empty'; }
        return;
      }
      const current = state?.queueSummary?.current;
      const item = current || { title: state?.title || 'Nothing currently playing', mediaId: state?.mediaId };
      const duration = current?.duration || state?.state?.duration || 0;
      const position = state?.state?.position ?? current?.position ?? 0;
      const key = JSON.stringify([state?.id, item.id, item.mediaId, item.title, item.thumb, formatSubtitle(item), state?.capabilities?.playPause, state?.capabilities?.editQueue, state?.capabilities?.chooseMedia, view]);
      if (currentKey !== key) {
        const changedItem = currentId !== current?.id;
        currentId = current?.id; currentKey = key;
        if (changedItem) centerPending = centerAfterFetch = true;
        nowPlayingBox.replaceChildren();
        nowPlayingBox.dataset.entryId = current?.id || '';
        const top = node('div', nowPlayingBox, undefined, 'queue-now-playing-header');
        node('span', top, 'Now playing', 'queue-section-label');
        const moves = node('div', top, undefined, 'queue-move-actions');
        action(moves, 'Remove current video', 'close', () => removeCurrent(false), !state?.capabilities?.editQueue || !state?.capabilities?.chooseMedia, 'queue-current-remove');
        art(nowPlayingBox, item);
        const body = node('div', nowPlayingBox, undefined, 'queue-now-playing-body');
        title(body, item, 'queue-now-playing-title');
        node('div', body, '', 'queue-now-playing-meta');
        const progress = node('progress', body, undefined, 'queue-progress');
        progress.setAttribute('aria-label', 'Current video progress');
        const actions = node('div', nowPlayingBox, undefined, 'queue-entry-actions');
        node('span', actions, '', 'queue-card-caption queue-playback-state');
        button(actions, 'Play', 'play', async () => {
          try { await execute({ action: getState()?.state?.paused ? 'media.play' : 'media.pause' }); }
          catch (error) { notice.textContent = error.message; }
        }, !state?.mediaId || !state?.capabilities?.playPause, 'icon-button quiet queue-current-toggle');
        action(actions, 'Skip to next video', 'end', () => execute({ action: 'media.next' }), !state?.hasNext || !state?.capabilities?.chooseMedia, 'queue-current-skip');
      }
      nowPlayingBox.querySelector('.queue-playback-state').textContent = current || state?.mediaId ? state?.state?.paused ? 'Paused' : 'Playing' : '';
      nowPlayingBox.querySelector('.queue-now-playing-meta').textContent = formatTime(position) + ' / ' + formatTime(duration);
      const progress = nowPlayingBox.querySelector('progress');
      progress.max = duration || 1; progress.value = Math.min(position, duration);
      const toggle = nowPlayingBox.querySelector('.queue-current-toggle');
      nowPlayingBox.querySelector('.queue-current-skip').disabled = !state?.hasNext || !state?.capabilities?.chooseMedia;
      const label = state?.state?.paused ? 'Play' : 'Pause';
      if (toggle.title !== label) {
        toggle.title = label; toggle.setAttribute('aria-label', label);
        toggle.replaceChildren(root.uburoomIcons.icon(doc, state?.state?.paused ? 'play' : 'pause'));
      }
      if (centerPending) requestAnimationFrame(() => centerCurrent());
    }

    function action(parent, label, icon, callback, disabled, className = '') {
      return button(parent, label, icon, async () => {
        if (busy) return;
        busy = true;
        try { await callback(); }
        catch (error) { notice.textContent = error.message; }
        finally { busy = false; }
      }, disabled, 'icon-button quiet ' + className);
    }

    function updateUpcomingTimes() {
      const state = getState();
      const duration = state?.queueSummary?.current?.duration || state?.state?.duration || 0;
      let remaining = Math.max(0, duration - (state?.state?.position || 0));
      const ranks = upcomingView.querySelectorAll('.queue-rank');
      const captions = upcomingView.querySelectorAll('.queue-card-caption');
      const items = currentQueue.items || [];
      items.forEach((item, i) => {
        if (ranks[i]) { ranks[i].textContent = i === 0 ? 'NEXT' : '#' + (i + 1); ranks[i].classList.toggle('queue-next',i === 0); }
        if (captions[i]) captions[i].textContent = 'Up in ' + formatTime(remaining);
        remaining += Math.max(0, item.duration - (item.position || 0));
      });
      const autoRow = upcomingView.querySelector('.queue-entry-auto');
      if (autoRow) {
        const autoCaption = autoRow.querySelector('.queue-card-caption');
        if (autoCaption) autoCaption.textContent = view === 'list' ? 'Auto · Up in ' + formatTime(remaining) : 'Auto-queue';
      }
    }

    function renderUpcoming() {
      upcomingView.replaceChildren();
      node('h3', upcomingView, 'Upcoming →', 'queue-column-heading');
      const state = getState(), items = currentQueue.items || [];
      const autoNext = state?.queueSummary?.autoQueue?.mode !== 'off' ? state?.queueSummary?.autoQueue?.next : null;
      const canEdit = !!state?.capabilities?.editQueue, canChoose = !!state?.capabilities?.chooseMedia;
      if (!items.length && !autoNext) node('p', upcomingView, 'The queue is empty. Choose "Add to queue" from Media to line up videos.', 'hint queue-empty');
      const list = node('div', upcomingView, undefined, 'queue-list queue-upcoming-list');
      list.id = 'queue-upcoming-list';
      items.forEach((item, i) => {
        const row = node('article', list, undefined, 'queue-entry'); row.dataset.entryId = item.id;
        const top = node('div', row, undefined, 'queue-entry-top');
        node('span', top, '', 'queue-rank');
        const moves = node('div', top, undefined, 'queue-move-actions');
        action(moves, 'Move earlier', view === 'cards' ? 'left' : 'up', () => moveItem(item.id, item.rank - 1), !canEdit || i === 0, 'queue-action-up');
        action(moves, 'Move later', view === 'cards' ? 'right' : 'down', () => moveItem(item.id, item.rank + 1), !canEdit || item.rank === currentQueue.total - 1, 'queue-action-down');
        action(moves, 'Remove from queue', 'close', () => removeItem(item.id), !canEdit, 'queue-action-remove');
        art(row, item);
        const info = node('div', row, undefined, 'queue-entry-info');
        title(info, item, 'queue-entry-title');
        node('span', info, formatTime(item.duration), 'queue-meta');
        const actions = node('div', row, undefined, 'queue-entry-actions');
        node('span', actions, 'Queue', 'queue-card-caption');
        action(actions, 'Play now', 'play', () => playEntry(item.id, false), !canChoose, 'queue-action-play');
        const skipLabel = i === 0 ? 'Skip to' : ('Skip ' + i + (i === 1 ? ' item to' : ' items to'));
        action(actions, skipLabel, 'player-track-next', () => playEntry(item.id, true), !canChoose, 'queue-action-skip');
      });
      if (autoNext && items.length >= (currentQueue.total || items.length)) {
        const canIdlePlay = !state?.mediaId && !state?.queueSummary?.current && !!state?.capabilities?.playPause;
        const row = node('article', list, undefined, 'queue-entry queue-entry-auto');
        row.dataset.entryId = 'auto:' + autoNext.mediaId;
        const top = node('div', row, undefined, 'queue-entry-top');
        node('span', top, 'AUTO', 'queue-rank queue-rank-auto');
        const moves = node('div', top, undefined, 'queue-move-actions');
        action(moves, 'Add to queue', 'queue', async () => { await mutate('auto.pin'); await changed(); }, !state?.capabilities?.addQueue, 'queue-action-pin');
        const isShuffle = state?.queueSummary?.autoQueue?.mode === 'random';
        action(moves, 'Skip suggestion', isShuffle ? 'refresh' : 'end', async () => { await mutate('auto.skip'); await changed(); }, !canEdit, 'queue-action-auto-skip');
        art(row, autoNext);
        const info = node('div', row, undefined, 'queue-entry-info');
        title(info, autoNext, 'queue-entry-title');
        node('span', info, formatTime(autoNext.duration), 'queue-meta');
        const actions = node('div', row, undefined, 'queue-entry-actions');
        node('span', actions, 'Auto-queue', 'queue-card-caption');
        action(actions, 'Play now', 'play', async () => { await mutate('auto.playNow'); await changed(); }, !canChoose && !canIdlePlay, 'queue-action-play');
        const autoSkipLabel = items.length === 0 ? 'Skip to' : ('Skip ' + items.length + (items.length === 1 ? ' item to' : ' items to'));
        action(actions, autoSkipLabel, 'player-track-next', async () => {
          if (!items.length) await execute({ action: 'media.next' });
          else { await mutate('auto.playNow'); await changed(); }
        }, !canChoose, 'queue-action-skip');
      }
      updateUpcomingTimes();
      const actions = node('div', footer, undefined, 'queue-footer-actions watch-control-group');
      if (items.length < currentQueue.total) {
        const more = button(actions,'Load more upcoming',undefined,async () => {
          const roomId = getState()?.id, revision = lastFetchedRevision;
          try {
            const page = await request('/api/watch/rooms/' + roomId + '/queue?limit=100&offset=' + items.length);
            if (getState()?.id !== roomId || lastFetchedRevision !== revision || page.queueRevision !== revision || getState()?.queueSummary?.queueRevision !== revision) return;
            currentQueue = {...currentQueue,items:[...items,...page.items],total:page.total}; renderTab();
          } catch (error) { notice.textContent = error.message; }
        });
        root.uburoomControls.content(more,{label:'Load more upcoming'});
      }
      const shuffle = action(actions, 'Shuffle queue', 'shuffle', () => mutate('shuffle'), !canEdit || items.length < 2);
      root.uburoomControls.content(shuffle,{label:'Shuffle queue',icon:'shuffle',iconOnly:true});
      shuffle.classList.add('watch-control-solid-disabled');
      if (shuffle.disabled) shuffle.title = canEdit ? 'Add at least two upcoming videos to shuffle.' : 'Queue editing is unavailable for your role.';
      shuffle.setAttribute('aria-label', shuffle.disabled ? 'Shuffle queue: ' + shuffle.title : 'Shuffle queue');
      shuffle.id = 'queue-shuffle';
      const clear = button(actions, 'Clear queue', undefined, async () => {
        if (busy || !getState()?.capabilities?.editQueue || !currentQueue.items.length) return;
        const roomId = getState().id;
        if (await confirm('Clear all upcoming videos from the queue?') && getState()?.id === roomId) {
          busy = true;
          try { await clearQueue(); } catch (error) { notice.textContent = error.message; } finally { busy = false; }
        }
      }, !canEdit || !items.length);
      root.uburoomControls.content(clear,{label:'Clear queue'});
      clear.classList.add('watch-control-solid-disabled');
      if (clear.disabled) clear.title = canEdit ? 'There are no upcoming videos to clear.' : 'Queue editing is unavailable for your role.';
      clear.setAttribute('aria-label', clear.disabled ? 'Clear queue: ' + clear.title : 'Clear queue');
      clear.id = 'queue-clear-queue';
    }

    function renderHistory() {
      historyView.replaceChildren();
      const top = node('div', historyView, undefined, 'queue-history-heading');
      node('h3', top, '← History', 'queue-column-heading');
      const state = getState(), items = currentHistory.items || [];
      const canChoose = !!state?.capabilities?.chooseMedia;
      const clear = button(top, 'Clear history', undefined, async () => {
        if (busy || !getState()?.capabilities?.editQueue || !currentHistory.items.length) return;
        const roomId = getState().id;
        if (await confirm('Clear all playback history for this room?') && getState()?.id === roomId) {
          busy = true;
          try { await clearHistory(); } catch (error) { notice.textContent = error.message; } finally { busy = false; }
        }
      }, !state?.capabilities?.editQueue || !items.length, 'queue-clear-history');
      root.uburoomControls.content(clear,{label:'Clear history'});
      clear.classList.add('watch-control-solid-disabled');
      if (clear.disabled) clear.title = state?.capabilities?.editQueue ? 'There is no playback history to clear.' : 'Queue editing is unavailable for your role.';
      clear.setAttribute('aria-label', clear.disabled ? 'Clear history: ' + clear.title : 'Clear history');
      clear.id = 'queue-clear-history';
      footer.querySelector('.queue-footer-actions').prepend(clear);
      if (!items.length) node('p', historyView, 'No playback history yet.', 'hint queue-empty');
      if (items.length < currentHistory.total) {
        const older = button(historyView, 'Load older history', undefined, async () => {
          const roomId = getState()?.id, revision = lastFetchedRevision;
          older.disabled = true;
          try {
            const page = await request('/api/watch/rooms/' + roomId + '/history?limit=100&offset=' + items.length);
            if (getState()?.id !== roomId || lastFetchedRevision !== revision || page.queueRevision !== revision || getState()?.queueSummary?.queueRevision !== revision) return;
            currentHistory = { items: [...items, ...page.items], total: page.total };
            renderTab();
          } catch (error) { notice.textContent = error.message; }
          finally { older.disabled = false; }
        }, false, 'quiet queue-history-older');
      }
      const list = node('div', historyView, undefined, 'queue-list queue-history-list');
      list.id = 'queue-history-list';
      for (const item of [...items].reverse()) {
        const row = node('article', list, undefined, 'queue-history-entry'); row.dataset.entryId = item.id;
        const outcome = item.outcome || 'interrupted';
        const label = outcome === 'completed' ? 'Completed' : outcome === 'skipped' ? 'Skipped' : 'Stopped';
        const top = node('div', row, undefined, 'queue-entry-top');
        const status = node('span', top, undefined, 'queue-history-status queue-rank outcome-' + outcome);
        const moves = node('div', top, undefined, 'queue-move-actions');
        action(moves, 'Remove from history', 'close', () => removeItem(item.id), !state?.capabilities?.editQueue, 'queue-action-remove');
        status.title = label;
        node('span', status, label.toUpperCase(), 'queue-outcome-label');
        art(row, item);
        const info = node('div', row, undefined, 'queue-entry-info');
        title(info, item, 'queue-entry-title');
        node('span', info, outcome === 'completed' ? formatTime(item.duration) : formatTime(item.position) + ' / ' + formatTime(item.duration), 'queue-meta');
        const actions = node('div', row, undefined, 'queue-entry-actions');
        node('span', actions, 'History', 'queue-card-caption');
        action(actions, 'Restart from here', 'player-track-prev', () => replayHistory(item.id, true, true), !canChoose, 'queue-item-go-back');
        action(actions, 'Restart now', 'rotate-clockwise', () => replayHistory(item.id, false), !canChoose, 'queue-item-restart');
      }
    }

    function renderTab() {
      const scroll = layout.scrollLeft, scrollTop = layout.scrollTop;
      footer.querySelector('.queue-footer-actions')?.remove();
      renderUpcoming(); renderHistory(); updateViewsVisibility();
      for (const img of observedImages) if (!img.isConnected) { imageObserver.unobserve(img); observedImages.delete(img); }
      layout.scrollLeft = scroll; layout.scrollTop = scrollTop;
      if (moveFollow && view === 'cards') {
        const follow = moveFollow;
        requestAnimationFrame(() => {
          const row = [...upcomingView.querySelectorAll('.queue-entry')].find(item => item.dataset.entryId === follow.entryId);
          if (!row || moveFollow !== follow) return;
          const delta = row.getBoundingClientRect().left - layout.getBoundingClientRect().left - follow.offset;
          layout.scrollTo({ left: layout.scrollLeft + delta, behavior: motion() });
          if (follow.focus) row.querySelector(follow.direction < 0 ? '.queue-action-up' : '.queue-action-down')?.focus({ preventScroll: true });
        });
      } else if (centerPending) requestAnimationFrame(() => centerCurrent());
      else { layout.scrollLeft = scroll; updateNavigation(); }
      scheduleNavigation();
    }

    function fetchData(force = false) {
      refetchForce ||= force;
      if (fetching) { refetchNeeded = true; return fetching; }
      fetching = (async () => {
        do {
          refetchNeeded = false;
          const force = refetchForce; refetchForce = false;
          const state = getState();
          if (!state?.durable || !state.id) break;
          const roomId = state.id, rev = state.queueSummary?.queueRevision ?? 0;
          if (!force && lastFetchedRoomId === roomId && lastFetchedRevision >= rev) break;
          try {
            const [qRes, hRes] = await Promise.all([
              request('/api/watch/rooms/' + roomId + '/queue?limit=100'),
              request('/api/watch/rooms/' + roomId + '/history?limit=100')
            ]);
            if (getState()?.id !== roomId) { refetchNeeded = true; continue; }
            if ((getState()?.queueSummary?.queueRevision ?? 0) < qRes.queueRevision) await changed();
            if (getState()?.id !== roomId || qRes.queueRevision !== hRes.queueRevision ||
                qRes.queueRevision !== getState()?.queueSummary?.queueRevision) {
              refetchNeeded = true; continue;
            }
            // Publish the current item and both lists together from one revision.
            currentQueue = qRes; currentHistory = hRes;
            lastFetchedRevision = qRes.queueRevision; lastFetchedRoomId = roomId;
            renderHeaderBadge(getState().queueSummary);
            renderNowPlaying();
            if (centerAfterFetch) { centerPending = true; centerAfterFetch = false; }
            renderTab();
          } catch (error) { notice.textContent = error.message; break; }
        } while (refetchNeeded);
      })().finally(() => { fetching = null; });
      return fetching;
    }

    function queueRevision(state) {
      return Math.max(state.queueSummary?.queueRevision ?? 0, lastFetchedRoomId === state.id ? currentQueue.queueRevision ?? 0 : 0);
    }

    async function add(item) {
      const state = getState();
      if (!state?.id || !state.durable) throw new Error('Durable room required');
      const roomId = state.id;
      const rev = queueRevision(state);
      const res = await request('/api/watch/rooms/' + roomId + '/queue', {
        action: 'add',
        item,
        expectedRevision: rev
      });
      notice.textContent = 'Added ' + (item.title || 'item') + ' to queue.';
      setTimeout(() => { if (notice.textContent.startsWith('Added')) notice.textContent = ''; }, 3000);
      await fetchData(true);
      return res;
    }

    async function mutate(action, args = {}) {
      const state = getState();
      if (!state?.id || !state.durable) throw new Error('Durable room required');
      const expectedRevision = queueRevision(state);
      const result = await request('/api/watch/rooms/' + state.id + '/queue', { action, ...args, expectedRevision },
        ['bulk', 'auto', 'auto.skip', 'auto.pin', 'auto.playNow', 'playEntry', 'skipTo', 'remove'].includes(action) ? { timeoutMs: 35000 } : {});
      await fetchData(true);
      return result;
    }

    async function moveItem(entryId, targetRank) {
      const state = getState();
      if (!state?.id) return;
      const item = currentQueue.items.find(item => item.id === entryId);
      const row = [...upcomingView.querySelectorAll('.queue-entry')].find(row => row.dataset.entryId === entryId);
      const follow = view === 'cards' && row ? { entryId, direction: targetRank - item.rank,
        offset: row.getBoundingClientRect().left - layout.getBoundingClientRect().left,
        focus: row.contains(doc.activeElement) } : null;
      moveFollow = follow;
      try {
        await request('/api/watch/rooms/' + state.id + '/queue', {
          action: 'move', entryId, targetRank, expectedRevision: queueRevision(state)
        });
        await changed();
        await fetchData(true);
        // renderTab schedules the follow after the new order has been laid out.
        await new Promise(resolve => requestAnimationFrame(resolve));
      } finally { if (moveFollow === follow) moveFollow = null; }
    }

    async function removeItem(entryId) {
      const state = getState();
      if (!state?.id) return;
      const rev = queueRevision(state);
      await request('/api/watch/rooms/' + state.id + '/queue', {
        action: 'remove',
        entryId,
        expectedRevision: rev
      });
      await fetchData(true);
    }

    async function removeCurrent(advance) {
      const state = getState(), entryId = state?.queueSummary?.current?.id;
      if (!entryId) return;
      await mutate('remove', {entryId,advance});
      await changed();
    }

    async function clearQueue() {
      const state = getState();
      if (!state?.id) return;
      const rev = queueRevision(state);
      await request('/api/watch/rooms/' + state.id + '/queue', {
        action: 'clear',
        expectedRevision: rev
      });
      await fetchData(true);
    }

    async function playEntry(entryId, skipPrevious = false) {
      const state = getState();
      if (!state?.id) return;
      await mutate(skipPrevious ? 'skipTo' : 'playEntry', { entryId, skipPrevious });
      await changed();
    }

    async function playNow(item) {
      const state = getState();
      if (!state?.id) return;
      await request('/api/watch/rooms/' + state.id + '/queue', {
        action: 'playNow',
        item: { mediaId: item.mediaId || item.id }
      }, { timeoutMs: 35000 });
      await fetchData(true);
      await changed();
    }

    async function replayHistory(entryId, resume, restore = false) {
      const state = getState();
      if (!state?.id) return;
      await request('/api/watch/rooms/' + state.id + '/history', {
        action: restore ? 'goBack' : 'replay',
        entryId,
        resume,
        expectedRevision: queueRevision(state)
      }, { timeoutMs: 35000 });
      await fetchData(true);
      await changed();
    }

    async function clearHistory() {
      const state = getState();
      if (!state?.id) return;
      await request('/api/watch/rooms/' + state.id + '/history', {
        action: 'clear'
      });
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
        if (lastFetchedRoomId) { clearArtwork(); lastFetchedRoomId = null; lastFetchedRevision = -1; }
        if (bulkDialog.open) bulkDialog.close();
        autoNotice.textContent = '';
        return;
      }
      if (!state) {
        if (lastFetchedRoomId) { clearArtwork(); lastFetchedRoomId = null; lastFetchedRevision = -1; }
        currentQueue = { items: [], total: 0, queueRevision: 0 };
        currentHistory = { items: [], total: 0 };
        renderTab(); renderNowPlaying(); renderHeaderBadge();
        return;
      }

      if (state.id !== lastFetchedRoomId) {
        currentQueue = { items: [], total: 0, queueRevision: 0 };
        currentHistory = { items: [], total: 0 };
        currentKey = ''; currentId = undefined; centerPending = centerAfterFetch = true; clearArtwork();
        lastFetchedRoomId = state.id; lastFetchedRevision = -1;
        renderTab();
      }
      if (lastFetchedRevision < 0 || lastFetchedRevision === queueSummary?.queueRevision) {
        const autoNextKey = JSON.stringify(queueSummary?.autoQueue?.mode !== 'off' ? queueSummary?.autoQueue?.next || null : null);
        if (autoNextKey !== lastAutoNextKey) { lastAutoNextKey = autoNextKey; renderTab(); }
        renderNowPlaying(); updateUpcomingTimes();
      }
      const permissions = JSON.stringify(state.capabilities);
      if (permissions !== capabilityKey) { capabilityKey = permissions; renderTab(); }
      if (queueSummary) {
        renderHeaderBadge(queueSummary);
        if (queueSummary.queueRevision > lastFetchedRevision || state.id !== lastFetchedRoomId) {
          void fetchData();
        }
      }
    }

    let rememberedPosition;
    return {
      rememberPosition() { if (layout.clientWidth) rememberedPosition = {room:getState()?.id,view,left:layout.scrollLeft,top:layout.scrollTop}; },
      restorePosition() { const saved = rememberedPosition; if (layout.clientWidth && saved?.room === getState()?.id && saved.view === view) requestAnimationFrame(() => { if(!layout.clientWidth)return;layout.scrollTo({left:saved.left,top:saved.top,behavior:'instant'}); updateNavigation(); }); },
      render,
      add,
      bulk,
      openAuto,
      fetchData,
      get selectedEntryId() { return null; },
      selectEntry(entryId) { centerEntry(entries().find(row => row.dataset.entryId === entryId)); }
    };
  }

  root.uburoomQueueUI = { mount };
})(globalThis);
