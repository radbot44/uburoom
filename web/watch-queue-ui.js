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

  function mount(host, { request, getState, getMe, fail, changed, execute, serverTime, openLibraryItem, artwork, openSettings }) {
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

    host.dataset.view = view;
    const header = node('header', host, undefined, 'queue-header');
    const heading = node('h2', header, undefined, 'queue-heading');
    heading.append(root.uburoomUI.icon(doc, 'queue'), doc.createTextNode('Queue'));
    const views = node('div', header, undefined, 'queue-view-switch');
    views.setAttribute('role', 'group'); views.setAttribute('aria-label', 'Queue layout');
    const viewButtons = ['cards', 'list'].map(value => {
      const b = button(views, value === 'cards' ? 'Cards' : 'List', value === 'cards' ? 'libraryNormal' : 'libraryList', () => {
        view = value; host.dataset.view = view;
        try { localStorage.setItem('uburoom-queue-view', view); } catch {}
        centerPending = true; renderTab(); updateView();
      }, false, 'queue-view-button');
      node('span', b, value === 'cards' ? 'Cards' : 'List');
      b.id = 'queue-view-' + value; return b;
    });
    const body = node('div', host); body.id = 'queue-body';
    const toolbar = node('div', body, undefined, 'queue-toolbar');
    const directions = node('div', toolbar, undefined, 'queue-directions');
    const historyTab = button(directions, 'Browse history', undefined, () => browse('history'), false, 'queue-direction');
    historyTab.id = 'queue-tab-history';
    const upcomingTab = button(directions, 'Browse upcoming videos', undefined, () => browse('upcoming'), false, 'queue-direction');
    upcomingTab.id = 'queue-tab-upcoming';
    const navigation = node('div', toolbar, undefined, 'queue-navigation');
    const previousCard = button(navigation, 'Scroll toward history', 'left', () => scrollCards(-1));
    previousCard.id = 'queue-scroll-previous';
    button(navigation, 'Center current video', 'center', () => centerCurrent(true)).id = 'queue-center';
    const nextCard = button(navigation, 'Scroll toward upcoming videos', 'right', () => scrollCards(1));
    nextCard.id = 'queue-scroll-next';
    const notice = node('p', body, '', 'hint queue-notice'); notice.setAttribute('role', 'status');
    const layout = node('div', body, undefined, 'queue-layout');
    layout.tabIndex = 0; layout.setAttribute('role', 'region'); layout.setAttribute('aria-label', 'Playback queue timeline');
    const historyView = node('section', layout, undefined, 'queue-view queue-history-view');
    historyView.id = 'queue-history-view'; historyView.setAttribute('aria-label', 'Playback history');
    const nowPlayingBox = node('div', layout, undefined, 'queue-now-playing');
    const upcomingView = node('section', layout, undefined, 'queue-view queue-upcoming-view');
    upcomingView.id = 'queue-upcoming-view'; upcomingView.setAttribute('aria-label', 'Upcoming videos');
    const footer = node('div', body, undefined, 'queue-footer');


    const continuation = node('div', footer, undefined, 'queue-continuation');
    const autoplayLabel = node('label', continuation, undefined, 'queue-check');
    const autoplayToggle = node('input', autoplayLabel);
    autoplayToggle.type = 'checkbox';
    autoplayToggle.id = 'queue-autoplay';
    autoplayLabel.append(doc.createTextNode('Autoplay next video'));
    const autoOpen = button(continuation, 'Queue settings', undefined, () => openSettings(), false, 'quiet');
    autoOpen.id = 'queue-auto-open';
    const autoStatus = node('p', continuation, '', 'hint queue-auto-status');
    const countdown = node('div', doc.getElementById('stage'), undefined, 'queue-countdown');
    countdown.id = 'queue-autoplay-countdown';
    countdown.hidden = true;
    const countdownText = node('span', countdown, undefined, 'queue-countdown-text');
    countdownText.setAttribute('role', 'status');
    const countdownActions = node('div', countdown, undefined, 'queue-countdown-actions');
    const playNowAutoplay = button(countdownActions, 'Play now', undefined, async () => {
      if (cancelPending) return;
      cancelPending = true; playNowAutoplay.disabled = cancelAutoplay.disabled = true;
      try { await execute({ action: 'media.next' }); }
      catch (error) { notice.textContent = error.message; }
      finally { cancelPending = false; renderContinuation(); }
    }, false, 'primary queue-autoplay-now');
    playNowAutoplay.id = 'queue-autoplay-play-now';
    playNowAutoplay.textContent = 'Play now';
    const cancelAutoplay = button(countdownActions, 'Cancel autoplay', undefined, async () => {
      if (cancelPending) return;
      cancelPending = true; playNowAutoplay.disabled = cancelAutoplay.disabled = true;
      try { await execute({ action: 'media.autoplay.cancel' }); }
      catch (error) { notice.textContent = error.message; }
      finally { cancelPending = false; renderContinuation(); }
    }, false, 'quiet queue-autoplay-cancel');
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
      autoOpen.disabled = !state?.durable;
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
      playNowAutoplay.disabled = cancelAutoplay.disabled = cancelPending || !state?.capabilities?.autoplay;
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

    const autoDialog = node('div', doc.getElementById('room-playback-controls'), undefined, 'queue-settings');
    const settingsAutoplayLabel = node('label', autoDialog, undefined, 'queue-check');
    const settingsAutoplay = node('input', settingsAutoplayLabel); settingsAutoplay.type = 'checkbox'; settingsAutoplay.id = 'room-autoplay';
    settingsAutoplayLabel.append(doc.createTextNode('Autoplay next video'));
    settingsAutoplay.addEventListener('change',async () => {
      settingsAutoplay.disabled = true; autoNotice.textContent = 'Saving…';
      try { await execute({action:'media.autoplay.set',args:{enabled:settingsAutoplay.checked}}); autoNotice.textContent = 'Saved'; }
      catch (error) { autoNotice.textContent = error.message; }
      finally { settingsAutoplay.checked = getState()?.autoplay?.enabled !== false; settingsAutoplay.disabled = !getState()?.capabilities?.autoplay; }
    });
    autoDialog.id = 'queue-auto-dialog'; autoDialog.setAttribute('aria-labelledby', 'queue-auto-title');
    node('h4', autoDialog, 'Automatic queue generation').id = 'queue-auto-title';
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
    const autoCancel = button(autoActions, 'Reset changes', undefined, () => openAuto());
    const autoSave = button(autoActions, 'Save auto-queue', undefined, undefined, false, 'primary'); autoSave.id = 'queue-auto-save';
    doc.addEventListener('room-playback-settings',() => { if (!autoPending) void openAuto(); });
    async function openAuto(source) {
      const state = getState(), roomId = state?.id;
      if (!roomId) return;
      if (source) await openSettings();
      if (getState()?.id !== roomId) return;
      const config = state.queueSummary?.autoQueue;
      autoMode.value = source ? 'random' : config?.mode || 'off';
      autoSpecials.checked = !!config?.includeSpecials;
      const scope = source?.scope || config?.scope || { type: 'show' };
      autoSource.textContent = 'Source: ' + (source?.title || (scope.type === 'show' ? scope.id ? 'Selected show' : 'Current show' : scope.type === 'library' ? 'Selected movie library' : 'Selected collection'));
      autoNotice.textContent = ''; autoSave.disabled = autoMode.disabled = autoSpecials.disabled = !state.capabilities?.editQueue;
      settingsAutoplay.checked = state.autoplay?.enabled !== false; settingsAutoplay.disabled = !state.capabilities?.autoplay;
      autoMode.querySelector('[value=following]').disabled = source && scope.type !== 'show';

      autoSave.onclick = async () => {
        if (getState()?.id !== roomId || !getState()?.capabilities?.editQueue) { return; }
        autoPending = true; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = true; autoNotice.textContent = 'Saving…';
        try {
          const selectedScope = autoMode.value === 'following' && scope.type !== 'show' ? { type: 'show' } : { type: scope.type, ...(scope.id ? { id: scope.id } : {}) };
          await mutate('auto', { mode: autoMode.value, scope: selectedScope, includeSpecials: autoSpecials.checked });
          autoNotice.textContent = 'Saved'; await changed();
        } catch (error) { autoNotice.textContent = error.message; }
        finally { autoPending = false; autoSave.disabled = autoCancel.disabled = autoMode.disabled = autoSpecials.disabled = false; }
      };

    }

    function motion() {
      return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
    }

    function centerCurrent(smooth = false) {
      if (view !== 'cards' || !layout.clientWidth) return;
      layout.style.paddingInline = '0px';
      const inset = Math.max(0, (layout.clientWidth - nowPlayingBox.offsetWidth) / 2);
      layout.style.paddingInline = inset + 'px';
      const r = nowPlayingBox.getBoundingClientRect(), bounds = layout.getBoundingClientRect();
      layout.scrollTo({ left: layout.scrollLeft + r.left - bounds.left - inset, behavior: smooth ? motion() : 'instant' });
      centerPending = false;
      updateNavigation();
    }

    function scrollCards(direction) {
      layout.scrollBy({ left: direction * (nowPlayingBox.offsetWidth + 14), behavior: motion() });
    }

    function updateNavigation() {
      previousCard.disabled = layout.scrollLeft <= 2;
      nextCard.disabled = layout.scrollLeft + layout.clientWidth >= layout.scrollWidth - 2;
    }

    function updateView() {
      viewButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(view === (i ? 'list' : 'cards'))));
      navigation.hidden = view !== 'cards';
      layout.tabIndex = view === 'cards' ? 0 : -1;
      if (view === 'list') layout.style.paddingInline = '';
      else requestAnimationFrame(() => centerCurrent());
    }

    function browse(section) {
      if (view === 'cards') {
        const target = section === 'history' ? historyView.querySelector('.queue-history-entry:last-child') : upcomingView.querySelector('.queue-entry');
        if (target) {
          const r = target.getBoundingClientRect(), bounds = layout.getBoundingClientRect();
          layout.scrollTo({ left: layout.scrollLeft + r.left - bounds.left - (layout.clientWidth - r.width) / 2, behavior: motion() });
        }
      } else (section === 'history' ? historyView : upcomingView).scrollIntoView({ behavior: motion(), block: 'nearest' });
    }

    layout.addEventListener('scroll', updateNavigation, { passive: true });
    layout.addEventListener('keydown', event => {
      if (event.target !== layout || view !== 'cards') return;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault(); scrollCards(event.key === 'ArrowLeft' ? -1 : 1);
      } else if (event.key === 'Home') { event.preventDefault(); centerCurrent(true); }
    });
    new ResizeObserver(() => { if (view === 'cards') centerCurrent(); }).observe(layout);
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
            const params = new URLSearchParams({ item: img.dataset.item, kind: 'landscape', type: img.dataset.type });
            imageRequests.set(key, artwork('/api/watch/library/art?' + params, signal).then(blob => {
              if (!signal.aborted) {
                images.set(key, URL.createObjectURL(blob));
                while (images.size > 220) { const first = images.keys().next().value; URL.revokeObjectURL(images.get(first)); images.delete(first); imageRequests.delete(first); }
              }
            }));
          }
          await imageRequests.get(key);
        }
        if (!signal.aborted && img.isConnected && images.has(key)) img.src = images.get(key);
      } catch {
        if (!signal.aborted) { imageRequests.delete(key); img.parentNode?.setAttribute('title', 'Artwork unavailable'); img.remove(); }
      }
    }

    function art(parent, item) {
      const box = node('div', parent, undefined, 'queue-art');
      box.append(root.uburoomUI.icon(doc, item.type === 'episode' ? 'tv' : 'film'));
      if (!artwork || !/^\d{1,20}$/.test(item.mediaId || item.id || '')) return;
      const img = node('img', box);
      img.alt = ''; img.decoding = 'async';
      img.dataset.item = item.mediaId || item.id; img.dataset.type = item.type || 'movie';
      const cached = images.get(img.dataset.item + ':' + img.dataset.type);
      if (cached) img.src = cached;
      else { observedImages.add(img); imageObserver.observe(img); }
    }

    function renderHeaderBadge(summary) {
      const qLen = summary?.pendingCount ?? currentQueue.total ?? 0;
      const hLen = summary?.historyCount ?? currentHistory.total ?? 0;
      upcomingTab.textContent = 'Upcoming (' + qLen + ') →';
      historyTab.textContent = '← History (' + hLen + ')';
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

    function renderNowPlaying() {
      const state = getState();
      const current = state?.queueSummary?.current;
      const item = current || { title: state?.title || 'Nothing currently playing', mediaId: state?.mediaId };
      const duration = current?.duration || state?.state?.duration || 0;
      const position = state?.state?.position ?? current?.position ?? 0;
      const key = JSON.stringify([state?.id, item.id, item.mediaId, item.title, item.thumb, formatSubtitle(item), state?.capabilities?.playPause]);
      if (currentKey !== key) {
        const changedItem = currentId !== current?.id;
        currentId = current?.id; currentKey = key;
        if (changedItem) centerPending = centerAfterFetch = true;
        nowPlayingBox.replaceChildren();
        nowPlayingBox.dataset.entryId = current?.id || '';
        const top = node('div', nowPlayingBox, undefined, 'queue-now-playing-header');
        node('span', top, 'Now playing', 'queue-section-label');
        node('span', top, '', 'queue-badge queue-playback-state');
        art(nowPlayingBox, item);
        const body = node('div', nowPlayingBox, undefined, 'queue-now-playing-body');
        title(body, item, 'queue-now-playing-title');
        node('div', body, '', 'queue-now-playing-meta');
        const progress = node('progress', body, undefined, 'queue-progress');
        progress.setAttribute('aria-label', 'Current video progress');
        const actions = node('div', nowPlayingBox, undefined, 'queue-entry-actions');
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
        toggle.replaceChildren(root.uburoomUI.icon(doc, state?.state?.paused ? 'play' : 'pause'));
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
      (currentQueue.items || []).forEach((item, i) => {
        if (ranks[i]) ranks[i].textContent = (i + 1) + ' · UP NEXT in ' + formatTime(remaining);
        remaining += Math.max(0, item.duration - (item.position || 0));
      });
    }

    function renderUpcoming() {
      upcomingView.replaceChildren();
      node('h3', upcomingView, 'Upcoming →', 'queue-column-heading');
      const state = getState(), items = currentQueue.items || [];
      const canEdit = !!state?.capabilities?.editQueue, canChoose = !!state?.capabilities?.chooseMedia;
      if (!items.length) node('p', upcomingView, 'The queue is empty. Choose "Add to queue" from Media to line up videos.', 'hint queue-empty');
      const list = node('div', upcomingView, undefined, 'queue-list queue-upcoming-list');
      list.id = 'queue-upcoming-list';
      items.forEach((item, i) => {
        const row = node('article', list, undefined, 'queue-entry'); row.dataset.entryId = item.id;
        const top = node('div', row, undefined, 'queue-entry-top');
        node('span', top, '', 'queue-rank');
        const moves = node('div', top, undefined, 'queue-move-actions');
        action(moves, 'Remove from queue', 'close', () => removeItem(item.id), !canEdit, 'queue-action-remove');
        action(moves, 'Move earlier', view === 'cards' ? 'left' : 'up', () => moveItem(item.id, item.rank - 1), !canEdit || i === 0, 'queue-action-up');
        action(moves, 'Move later', view === 'cards' ? 'right' : 'down', () => moveItem(item.id, item.rank + 1), !canEdit || i === items.length - 1, 'queue-action-down');
        art(row, item);
        const info = node('div', row, undefined, 'queue-entry-info');
        title(info, item, 'queue-entry-title');
        node('span', info, formatTime(item.duration), 'queue-meta');
        const actions = node('div', row, undefined, 'queue-entry-actions');
        node('span', actions, 'Queue', 'queue-card-caption');
        action(actions, 'Play now', 'play', () => playEntry(item.id, false), !canChoose, 'queue-action-play');
        action(actions, 'Skip to', 'end', () => playEntry(item.id, true), !canChoose, 'queue-action-skip');
      });
      updateUpcomingTimes();
      const actions = node('div', footer, undefined, 'queue-footer-actions');
      const shuffle = action(actions, 'Shuffle queue', 'shuffle', () => mutate('shuffle'), !canEdit || items.length < 2);
      shuffle.id = 'queue-shuffle';
      const clear = button(actions, 'Clear queue', undefined, async () => {
        if (busy || !getState()?.capabilities?.editQueue || !currentQueue.items.length) return;
        const roomId = getState().id;
        if (await confirm('Clear all upcoming videos from the queue?') && getState()?.id === roomId) {
          busy = true;
          try { await clearQueue(); } catch (error) { notice.textContent = error.message; } finally { busy = false; }
        }
      }, !canEdit || !items.length);
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
      }, !state?.capabilities?.editQueue || !items.length, 'queue-clear-history quiet');
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
      for (const item of (view === 'cards' ? [...items].reverse() : items)) {
        const row = node('article', list, undefined, 'queue-history-entry'); row.dataset.entryId = item.id;
        const outcome = item.outcome || 'interrupted';
        const label = outcome === 'completed' ? 'Completed' : outcome === 'skipped' ? 'Skipped' : 'Stopped';
        const status = node('span', row, undefined, 'queue-history-status queue-rank outcome-' + outcome);
        status.title = label;
        node('span', status, label.toUpperCase(), 'queue-outcome-label');
        art(row, item);
        const info = node('div', row, undefined, 'queue-entry-info');
        title(info, item, 'queue-entry-title');
        node('span', info, outcome === 'completed' ? formatTime(item.duration) : formatTime(item.position) + ' / ' + formatTime(item.duration), 'queue-meta');
        const actions = node('div', row, undefined, 'queue-entry-actions');
        node('span', actions, 'History', 'queue-card-caption');
        action(actions, 'Go back to', 'start', () => replayHistory(item.id, true, true), !canChoose, 'queue-item-go-back');
        if (outcome !== 'completed') action(actions, 'Resume now', 'play', () => replayHistory(item.id, true), !canChoose, 'queue-item-resume');
        action(actions, 'Start over now', 'refresh', () => replayHistory(item.id, false), !canChoose, 'queue-item-restart');
        action(actions, 'Add to queue', 'queue', () => add({ ...item, position: 0 }), !state?.capabilities?.addQueue, 'queue-item-add');
      }
    }

    function renderTab() {
      const scroll = layout.scrollLeft;
      footer.querySelector('.queue-footer-actions')?.remove();
      renderUpcoming(); renderHistory();
      for (const img of observedImages) if (!img.isConnected) { imageObserver.unobserve(img); observedImages.delete(img); }
      layout.scrollLeft = scroll;
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
        ['bulk', 'auto', 'playEntry', 'skipTo'].includes(action) ? { timeoutMs: 35000 } : {});
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
      const visible = !!state?.durable;
      panel.hidden = !visible;
      renderContinuation();
      if (!visible) {
        if (lastFetchedRoomId) { clearArtwork(); lastFetchedRoomId = null; lastFetchedRevision = -1; }
        if (bulkDialog.open) bulkDialog.close();
        autoNotice.textContent = '';
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
