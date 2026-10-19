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

  function mount(host, { request, getState, getMe, fail, changed, execute, serverTime }) {
    const doc = host.ownerDocument;
    let activeTab = 'upcoming';
    let currentQueue = { items: [], total: 0, queueRevision: 0 };
    let currentHistory = { items: [], total: 0 };
    let fetching = false;
    let refetchNeeded = false;
    let busy = false;
    let autoplayPending = false;
    let cancelPending = false;
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
      if (iconName && root.uburoomUI?.icon) {
        b.append(root.uburoomUI.icon(doc, iconName));
      } else {
        b.textContent = label;
      }
      if (action) b.addEventListener('click', action);
      return b;
    }

    async function confirm(message) {
      const target = doc.getElementById('room-confirm-dialog');
      if (!target || target.open) return false;
      const msg = doc.getElementById('room-confirm-message');
      if (msg) msg.textContent = message;
      (doc.fullscreenElement || doc.body).append(target);
      target.returnValue = '';
      const result = new Promise(resolve => target.addEventListener('close', () => resolve(target.returnValue === 'yes'), { once: true }));
      target.showModal();
      return result;
    }

    const nowPlayingBox = node('div', host, undefined, 'queue-now-playing');

    const continuation = node('div', host, undefined, 'queue-continuation');
    const autoplayLabel = node('label', continuation, undefined, 'queue-check');
    const autoplayToggle = node('input', autoplayLabel);
    autoplayToggle.type = 'checkbox';
    autoplayToggle.id = 'queue-autoplay';
    autoplayLabel.append(doc.createTextNode('Autoplay next video'));
    const autoOpen = button(continuation, 'Auto-queue settings', undefined, () => openAuto(), false, 'quiet');
    autoOpen.id = 'queue-auto-open';
    const autoStatus = node('p', continuation, '', 'hint queue-auto-status');
    const countdown = node('div', doc.getElementById('stage'), undefined, 'queue-countdown');
    countdown.id = 'queue-autoplay-countdown';
    countdown.hidden = true;
    const countdownText = node('span', countdown);
    countdownText.setAttribute('role', 'status');
    const cancelAutoplay = button(countdown, 'Cancel autoplay', undefined, async () => {
      if (cancelPending) return;
      cancelPending = true; cancelAutoplay.disabled = true;
      try { await execute({ action: 'media.autoplay.cancel' }); }
      catch (error) { notice.textContent = error.message; }
      finally { cancelPending = false; renderContinuation(); }
    }, false, 'quiet');
    cancelAutoplay.id = 'queue-autoplay-cancel';
    cancelAutoplay.textContent = 'Cancel';

    autoplayToggle.addEventListener('change', async () => {
      if (autoplayPending) return;
      autoplayPending = true; autoplayToggle.disabled = true;
      try { await execute({ action: 'media.autoplay.set', args: { enabled: autoplayToggle.checked } }); }
      catch (error) { notice.textContent = error.message; }
      finally { autoplayPending = false; renderContinuation(); }
    });

    function renderContinuation() {
      const state = getState();
      if (!autoplayPending) autoplayToggle.checked = state?.autoplay?.enabled !== false;
      autoplayToggle.disabled = autoplayPending || !state?.capabilities?.autoplay;
      autoOpen.disabled = !state?.capabilities?.editQueue;
      const auto = state?.queueSummary?.autoQueue;
      autoStatus.textContent = auto?.mode === 'following' ? 'Auto-queue: following episodes' : auto?.mode === 'random' ?
        'Auto-queue: random from ' + (auto.scope?.type === 'library' ? 'movie library' : auto.scope?.type || 'selected source') : 'Auto-queue is off';
      const next = state?.autoplay?.countdown;
      countdown.hidden = !state?.durable || !next;
      if (next) {
        const now = serverTime?.() ?? state.serverNow;
        const seconds = Math.max(0, Math.ceil((next.endsAt - now) / 1000));
        countdownText.textContent = 'Up next: ' + next.title + ' in ' + seconds + (seconds === 1 ? ' second' : ' seconds');
      }
      cancelAutoplay.disabled = cancelPending || !state?.capabilities?.autoplay;
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
    const bulkSpecialLabel = node('label', bulkDialog, undefined, 'queue-check');
    const bulkSpecials = node('input', bulkSpecialLabel); bulkSpecials.type = 'checkbox'; bulkSpecials.id = 'queue-bulk-specials';
    bulkSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
    node('p', bulkDialog, 'Current and upcoming episodes are excluded. The queue holds up to 100 upcoming videos; an addition that exceeds the limit is rejected in full.', 'hint');
    const bulkStatus = node('p', bulkDialog, '', 'hint'); bulkStatus.setAttribute('role', 'status');
    const bulkActions = node('div', bulkDialog, undefined, 'room-actions');
    const bulkCancel = button(bulkActions, 'Cancel', undefined, () => bulkDialog.close('cancel'));
    const bulkSubmit = button(bulkActions, 'Add to queue', undefined, undefined, false, 'primary'); bulkSubmit.id = 'queue-bulk-submit';
    bulkDialog.addEventListener('cancel', event => { if (bulkPending) event.preventDefault(); });

    async function bulk(item) {
      if (bulkDialog.open) return;
      const roomId = getState()?.id;
      if (!roomId) return;
      bulkTitle.textContent = 'Add ' + (item.type === 'season' ? 'season' : 'show') + ' to queue';
      bulkDescription.textContent = item.title + (item.episodeCount ? ' · ' + item.episodeCount + ' episodes available' : '');
      bulkStatus.textContent = ''; bulkSubmit.disabled = bulkCancel.disabled = false;
      (doc.fullscreenElement || doc.body).append(bulkDialog);
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
      bulkDialog.showModal();
    }

    const autoDialog = node('dialog', doc.body, undefined, 'privacy-dialog queue-dialog');
    autoDialog.id = 'queue-auto-dialog'; autoDialog.setAttribute('aria-labelledby', 'queue-auto-title');
    node('h2', autoDialog, 'Auto-queue').id = 'queue-auto-title';
    node('p', autoDialog, 'Choose future videos to add as the queue runs low. Autoplay controls whether the next video starts when this one ends.', 'hint');
    const autoModeLabel = node('label', autoDialog, 'Mode');
    const autoMode = node('select', autoModeLabel); autoMode.id = 'queue-auto-mode';
    for (const [value, label] of [['off', 'Off'], ['following', 'Following episodes'], ['random', 'Random without repeats']]) {
      const option = node('option', autoMode, label); option.value = value;
    }
    const autoSource = node('p', autoDialog, '', 'hint'); autoSource.id = 'queue-auto-source';
    node('p', autoDialog, 'Choose a show, movie library or collection in the library to use another source. Following episodes uses the selected show, or the current show when no source is selected.', 'hint');
    const autoSpecialLabel = node('label', autoDialog, undefined, 'queue-check');
    const autoSpecials = node('input', autoSpecialLabel); autoSpecials.type = 'checkbox'; autoSpecials.id = 'queue-auto-specials';
    autoSpecialLabel.append(doc.createTextNode('Include Specials (Season 0)'));
    const autoNotice = node('p', autoDialog, '', 'hint'); autoNotice.setAttribute('role', 'status');
    const autoActions = node('div', autoDialog, undefined, 'room-actions');
    const autoCancel = button(autoActions, 'Cancel', undefined, () => autoDialog.close());
    const autoSave = button(autoActions, 'Save auto-queue', undefined, undefined, false, 'primary'); autoSave.id = 'queue-auto-save';
    autoDialog.addEventListener('cancel', event => { if (autoPending) event.preventDefault(); });
    function openAuto(source) {
      if (autoDialog.open) return;
      const state = getState(), roomId = state?.id;
      if (!roomId || !state.capabilities?.editQueue) return;
      const config = state.queueSummary?.autoQueue;
      autoMode.value = source ? 'random' : config?.mode || 'off';
      autoSpecials.checked = !!config?.includeSpecials;
      const scope = source?.scope || config?.scope || { type: 'show' };
      autoSource.textContent = 'Source: ' + (source?.title || (scope.type === 'show' ? scope.id ? 'Selected show' : 'Current show' : scope.type === 'library' ? 'Selected movie library' : 'Selected collection'));
      autoNotice.textContent = ''; autoSave.disabled = false;
      autoMode.querySelector('[value=following]').disabled = source && scope.type !== 'show';
      (doc.fullscreenElement || doc.body).append(autoDialog);
      autoSave.onclick = async () => {
        if (getState()?.id !== roomId || !getState()?.capabilities?.editQueue) { autoDialog.close(); return; }
        autoPending = true; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = true; autoNotice.textContent = 'Saving…';
        try {
          const selectedScope = autoMode.value === 'following' && scope.type !== 'show' ? { type: 'show' } : { type: scope.type, ...(scope.id ? { id: scope.id } : {}) };
          await mutate('auto', { mode: autoMode.value, scope: selectedScope, includeSpecials: autoSpecials.checked });
          autoDialog.close(); await changed();
        } catch (error) { autoNotice.textContent = error.message; }
        finally { autoPending = false; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = false; }
      };
      autoDialog.showModal();
    }

    const tabsRow = node('div', host, undefined, 'queue-tabs');
    tabsRow.setAttribute('role', 'tablist');
    const upcomingTab = node('button', tabsRow, 'Upcoming', 'queue-tab active');
    upcomingTab.id = 'queue-tab-upcoming';
    upcomingTab.setAttribute('role', 'tab');
    upcomingTab.setAttribute('aria-selected', 'true');
    const historyTab = node('button', tabsRow, 'History', 'queue-tab');
    historyTab.id = 'queue-tab-history';
    historyTab.setAttribute('role', 'tab');
    historyTab.setAttribute('aria-selected', 'false');

    const notice = node('p', host, '', 'hint queue-notice');
    notice.setAttribute('role', 'status');

    const upcomingView = node('div', host, undefined, 'queue-view queue-upcoming-view');
    upcomingView.id = 'queue-upcoming-view';
    const historyView = node('div', host, undefined, 'queue-view queue-history-view');
    historyView.id = 'queue-history-view';
    historyView.hidden = true;

    function switchTab(tab) {
      activeTab = tab;
      const isUpcoming = tab === 'upcoming';
      upcomingTab.classList.toggle('active', isUpcoming);
      upcomingTab.setAttribute('aria-selected', String(isUpcoming));
      historyTab.classList.toggle('active', !isUpcoming);
      historyTab.setAttribute('aria-selected', String(!isUpcoming));
      upcomingView.hidden = !isUpcoming;
      historyView.hidden = isUpcoming;
      renderTab();
      if (!isUpcoming) void fetchData(true);
    }

    upcomingTab.addEventListener('click', () => switchTab('upcoming'));
    historyTab.addEventListener('click', () => switchTab('history'));

    function renderHeaderBadge(summary) {
      const qLen = summary?.pendingCount ?? summary?.queueLength ?? currentQueue.total ?? currentQueue.items?.length ?? 0;
      const hLen = summary?.historyCount ?? summary?.historyLength ?? currentHistory.total ?? currentHistory.items?.length ?? 0;
      upcomingTab.textContent = 'Upcoming (' + qLen + ')';
      historyTab.textContent = 'History (' + hLen + ')';
      const badge = doc.getElementById('queue-count-badge');
      if (badge) {
        badge.textContent = String(qLen);
        badge.hidden = qLen === 0;
      }
    }

    function renderNowPlaying() {
      nowPlayingBox.replaceChildren();
      const state = getState();
      const current = state?.queueSummary?.current;
      const media = state?.mediaUrl ? state : null;
      if (!current && !media) {
        node('p', nowPlayingBox, 'Nothing currently playing.', 'hint');
        return;
      }
      const title = current?.title || media?.title || 'Unknown title';
      const subtitle = [current?.grandparentTitle, current?.parentTitle].filter(Boolean).join(' · ') || media?.subtitle || '';
      const duration = current?.duration || state?.state?.duration || 0;
      const position = state?.state?.position ?? current?.position ?? 0;

      const top = node('div', nowPlayingBox, undefined, 'queue-now-playing-header');
      node('span', top, 'Now playing', 'queue-section-label');
      if (state?.state?.paused) {
        node('span', top, 'Paused', 'queue-badge');
      }

      const body = node('div', nowPlayingBox, undefined, 'queue-now-playing-body');
      node('strong', body, title, 'queue-now-playing-title');
      if (subtitle) node('p', body, subtitle, 'hint queue-now-playing-subtitle');

      const meta = node('div', body, undefined, 'queue-now-playing-meta');
      node('span', meta, formatTime(position) + ' / ' + formatTime(duration), 'queue-meta');
    }

    function renderUpcoming() {
      upcomingView.replaceChildren();
      const state = getState();
      const canEdit = !!state?.capabilities?.editQueue;
      const canChoose = !!state?.capabilities?.chooseMedia;
      const items = currentQueue.items || [];

      if (items.length === 0) {
        node('p', upcomingView, 'The queue is empty. Choose "Add to queue" from the Plex library below to line up videos.', 'hint queue-empty');
        return;
      }

      const list = node('div', upcomingView, undefined, 'queue-list queue-upcoming-list');
      list.id = 'queue-upcoming-list';
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const row = node('div', list, undefined, 'queue-entry');
        row.dataset.entryId = item.id;

        node('span', row, '#' + (i + 1), 'queue-rank');

        const info = node('div', row, undefined, 'queue-entry-info');
        node('strong', info, item.title, 'queue-entry-title');
        const sub = [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' · ');
        if (sub) node('p', info, sub, 'hint queue-entry-subtitle');
        node('span', info, formatTime(item.duration), 'queue-meta');

        const actions = node('div', row, undefined, 'queue-entry-actions');

        button(actions, 'Play now', 'play', async () => {
          if (busy) return;
          busy = true;
          try {
            await playNow(item);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canChoose, 'icon-button quiet queue-action-play');

        button(actions, 'Move up', 'up', async () => {
          if (busy) return;
          busy = true;
          try {
            await moveItem(item.id, item.rank - 1);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canEdit || i === 0, 'icon-button quiet queue-action-up');

        button(actions, 'Move down', 'down', async () => {
          if (busy) return;
          busy = true;
          try {
            await moveItem(item.id, item.rank + 1);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canEdit || i === items.length - 1, 'icon-button quiet queue-action-down');

        button(actions, 'Remove from queue', 'close', async () => {
          if (busy) return;
          busy = true;
          try {
            await removeItem(item.id);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canEdit, 'icon-button quiet queue-action-remove');
      }

      const footer = node('div', upcomingView, undefined, 'queue-footer');
      const shuffle = button(footer, 'Shuffle queue', undefined, async () => {
        if (busy || !canEdit) return;
        busy = true; shuffle.disabled = true;
        try { await mutate('shuffle'); }
        catch (error) { notice.textContent = error.message; }
        finally { busy = false; shuffle.disabled = !getState()?.capabilities?.editQueue; }
      }, !canEdit || items.length < 2);
      shuffle.id = 'queue-shuffle';
      const clearQueueBtn = button(footer, 'Clear queue', undefined, async () => {
        if (busy || !canEdit || items.length === 0) return;
        if (await confirm('Clear all upcoming videos from the queue?')) {
          busy = true;
          try {
            await clearQueue();
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }
      }, !canEdit || items.length === 0, 'quiet');
      clearQueueBtn.id = 'queue-clear-queue';
    }

    function renderHistory() {
      historyView.replaceChildren();
      const state = getState();
      const canEdit = !!state?.capabilities?.editQueue;
      const canChoose = !!state?.capabilities?.chooseMedia;
      const items = currentHistory.items || [];

      if (items.length === 0) {
        node('p', historyView, 'No playback history yet.', 'hint queue-empty');
        return;
      }

      const list = node('div', historyView, undefined, 'queue-list queue-history-list');
      list.id = 'queue-history-list';
      for (const item of items) {
        const row = node('div', list, undefined, 'queue-history-entry');
        row.dataset.entryId = item.id;

        const outcome = item.outcome || 'interrupted';
        const badgeLabel = outcome === 'completed' ? 'Completed' : outcome === 'skipped' ? 'Skipped' : 'Stopped';
        node('span', row, badgeLabel, 'queue-badge outcome-' + outcome);

        const info = node('div', row, undefined, 'queue-entry-info');
        node('strong', info, item.title, 'queue-entry-title');
        const sub = [item.grandparentTitle, item.parentTitle].filter(Boolean).join(' · ');
        if (sub) node('p', info, sub, 'hint queue-entry-subtitle');
        const posText = outcome === 'completed' ? formatTime(item.duration) : formatTime(item.position) + ' of ' + formatTime(item.duration);
        node('span', info, posText, 'queue-meta');

        const actions = node('div', row, undefined, 'queue-entry-actions');

        button(actions, 'Resume', undefined, async () => {
          if (busy) return;
          busy = true;
          try {
            await replayHistory(item.id, true);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canChoose, 'quiet queue-item-resume');

        button(actions, 'Start over', undefined, async () => {
          if (busy) return;
          busy = true;
          try {
            await replayHistory(item.id, false);
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }, !canChoose, 'quiet queue-item-restart');
      }

      const footer = node('div', historyView, undefined, 'queue-footer');
      const clearHistBtn = button(footer, 'Clear history', undefined, async () => {
        if (busy || !canEdit || items.length === 0) return;
        if (await confirm('Clear all playback history for this room?')) {
          busy = true;
          try {
            await clearHistory();
          } catch (err) {
            notice.textContent = err.message;
          } finally {
            busy = false;
          }
        }
      }, !canEdit || items.length === 0, 'quiet');
      clearHistBtn.id = 'queue-clear-history';
    }

    function renderTab() {
      if (activeTab === 'upcoming') {
        renderUpcoming();
      } else {
        renderHistory();
      }
    }

    async function fetchData(force = false) {
      if (fetching) {
        refetchNeeded = true;
        return;
      }
      const state = getState();
      if (!state?.durable || !state?.id) return;
      const roomId = state.id;
      const rev = state.queueSummary?.queueRevision ?? 0;
      if (!force && lastFetchedRoomId === roomId && lastFetchedRevision >= rev) return;

      fetching = true;
      refetchNeeded = false;
      try {
        const needsHistory = activeTab === 'history' || currentHistory.total === undefined;
        const [qRes, hRes] = await Promise.all([
          request('/api/watch/rooms/' + roomId + '/queue?limit=100'),
          needsHistory ? request('/api/watch/rooms/' + roomId + '/history') : Promise.resolve(currentHistory)
        ]);
        if (getState()?.id !== roomId) return;
        currentQueue = qRes || { items: [], total: 0, queueRevision: rev };
        currentHistory = hRes || { items: [], total: 0 };
        lastFetchedRevision = currentQueue.queueRevision ?? rev;
        lastFetchedRoomId = roomId;
        renderHeaderBadge(state.queueSummary);
        renderTab();
      } catch (err) {
        notice.textContent = err.message;
      } finally {
        fetching = false;
        if (refetchNeeded) {
          refetchNeeded = false;
          void fetchData();
        }
      }
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
        ['bulk', 'auto'].includes(action) ? { timeoutMs: 35000 } : {});
      await fetchData(true);
      return result;
    }

    async function moveItem(entryId, targetRank) {
      const state = getState();
      if (!state?.id) return;
      const rev = queueRevision(state);
      await request('/api/watch/rooms/' + state.id + '/queue', {
        action: 'move',
        entryId,
        targetRank,
        expectedRevision: rev
      });
      await fetchData(true);
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

    async function replayHistory(entryId, resume) {
      const state = getState();
      if (!state?.id) return;
      await request('/api/watch/rooms/' + state.id + '/history', {
        action: 'replay',
        entryId,
        resume
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
      const visible = !!state?.durable;
      panel.hidden = !visible;
      renderContinuation();
      if (!visible) {
        if (bulkDialog.open) bulkDialog.close();
        if (autoDialog.open) autoDialog.close();
        return;
      }

      renderNowPlaying();
      if (queueSummary) {
        renderHeaderBadge(queueSummary);
        if (queueSummary.queueRevision > lastFetchedRevision || state.id !== lastFetchedRoomId) {
          void fetchData();
        }
      }
    }

    return {
      render,
      add,
      bulk,
      openAuto,
      fetchData
    };
  }

  root.uburoomQueueUI = { mount };
})(globalThis);
