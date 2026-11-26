import * as uburoomControls from './watch-controls.js';
import * as uburoomIcons from './icons.js';
import * as uburoomPopover from './watch-popover.js';
import { mediaIdentity } from '../shared/room-protocol.mjs';
import { libraryProgress, libraryProgressKey } from '../shared/library-progress.mjs';
import { pictureLoader } from './watch-library-pictures.js';
import { libraryChoices } from './watch-library-choices.js';
import { homeCards, libraryKey, SYNC_CARD } from '../shared/library-cards.mjs';
import { libraryScroll } from './watch-library-scroll.js';
import { libraryDetails } from './watch-library-details.js';
import { libraryShelves } from './watch-library-shelves.js';

/* One safe-DOM library browser for the website, fullscreen drawer and Activity. */

function mount(
  host,
  {
    request,
    artwork,
    load,
    close,
    getPlayer,
    addToQueue,
    addBulkToQueue,
    autoQueue,
    suggestMedia,
    agreeSuggestion,
    initialLibrary,
    initialAccount,
    syncRoomLocation,
    isAdmin = () => false,
  },
) {
  const doc = host.ownerDocument;
  host.replaceChildren();
  function node(tag, parent, text, className) {
    const n = doc.createElement(tag);
    if (text !== undefined) n.textContent = text;
    if (className) n.className = className;
    parent?.append(n);
    return n;
  }
  function button(parent, label, symbol, className = 'library-key') {
    const b = node('button', parent, undefined, className);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    b.title = label;
    if (symbol) b.append(uburoomIcons.icon(doc, symbol));
    return b;
  }
  function option(select, value, label) {
    const n = node('option', select, label);
    n.value = value;
  }
  function select(parent, label) {
    const s = node('select', parent);
    s.setAttribute('aria-label', label);
    return s;
  }
  const header =
    doc.getElementById('library-header') || host.closest('#library-panel')?.querySelector('.library-header');
  const controls = uburoomControls;
  header?.classList.add('watch-panel-header');
  header?.querySelector('h2')?.classList.add('watch-panel-heading');
  const headerLeft = doc.getElementById('library-header-left') || header?.querySelector('.library-header-left');
  const headerRight = doc.getElementById('library-header-right') || header?.querySelector('.library-header-right');
  const topWrap = headerRight?.querySelector('.library-top');
  if (topWrap) controls.content(topWrap.querySelector('button'), { label: 'Back to top', icon: 'arrow-bar-to-up' });
  const navParent = headerLeft || host;
  navParent.querySelector('.library-navigation-history')?.remove();
  const historyGroup = node(
    'div',
    navParent,
    undefined,
    'library-navigation-history watch-control-group watch-header-actions',
  );
  historyGroup.setAttribute('role', 'group');
  historyGroup.setAttribute('aria-label', 'Navigation');
  const previous = button(historyGroup, 'Back', 'left', 'library-key');
  previous.id = 'library-back';
  const next = button(historyGroup, 'Forward', 'right', 'library-key');
  next.id = 'library-forward';
  const home = button(historyGroup, 'Libraries home', 'home', 'library-key');
  home.id = 'library-home';
  for (const [control, label, icon] of [
    [previous, 'Back', 'left'],
    [next, 'Forward', 'right'],
    [home, 'Libraries home', 'home'],
  ]) {
    controls.content(control, { label, icon, iconOnly: true });
    control.classList.add('watch-control-solid-disabled');
  }
  const choices = libraryChoices({
    doc,
    parent: historyGroup,
    menuParent: header || host,
    header,
    headerRight,
    node,
    button,
    onChoose: library => void chooseLibrary(library, screen?.tab),
  });
  const tools = node('div', host, undefined, 'library-tools');
  const row = node('div', tools, undefined, 'library-toolbar watch-toolbar');
  const searchField = node('label', row, undefined, 'search-field');
  searchField.append(uburoomIcons.icon(doc, 'search'));
  const search = node('input', searchField);
  search.type = 'search';
  search.id = 'search';
  search.placeholder = 'Search this library';
  search.setAttribute('aria-label', 'Search this library');
  search.maxLength = 200;
  const toolControls = node('div', row, undefined, 'tool-controls watch-control-group');
  const sortWrap = node('div', toolControls, undefined, 'sort-wrap');
  const sort = select(sortWrap, 'Sort library');
  sort.id = 'library-sort';
  sortWrap.append(uburoomIcons.icon(doc, 'chevron'));
  const direction = button(toolControls, 'Ascending', 'sort', 'library-key library-direction');
  direction.id = 'library-direction';
  direction.classList.add('library-direction');
  controls.content(direction, { label: 'Ascending', icon: 'sort', iconOnly: true });
  direction.classList.add('watch-control-solid-disabled');
  const filterHolder = node('div', toolControls, undefined, 'filter-holder');
  const filterButton = button(
    filterHolder,
    'Filters',
    'filter',
    'library-key watch-control watch-control-responsive watch-control-solid-disabled',
  );
  filterButton.id = 'library-filters-toggle';
  filterButton.classList.add('library-filters-toggle');
  filterButton.append(node('span', null, 'Filters', 'filter-label watch-control-label'));
  filterButton.setAttribute('aria-expanded', 'false');
  filterButton.setAttribute('aria-controls', 'library-filters');
  // Set as auto-queue acts on the list being browsed, so it sits with Sort and Filters.
  const scopeActions = node('div', toolControls, undefined, 'library-scope-actions');
  scopeActions.hidden = true;
  const views = node('div', toolControls, undefined, 'library-views view-switch watch-segmented watch-segmented-view');
  views.setAttribute('role', 'group');
  views.setAttribute('aria-label', 'Library view');
  const viewButtons = ['cards', 'list', 'posters'].map(view => {
    const b = button(
      views,
      view[0].toUpperCase() + view.slice(1),
      'library' + view[0].toUpperCase() + view.slice(1),
      'library-key group-button',
    );
    b.dataset.view = view;
    b.append(node('span', null, view[0].toUpperCase() + view.slice(1)));
    return b;
  });
  controls.segmented(views);
  const filters = node('div', tools, undefined, 'library-filters');
  filters.id = 'library-filters';
  filters.hidden = true;
  const genreLabel = node('label', filters, 'Genre');
  const genre = select(genreLabel, 'Genre');
  const yearLabel = node('label', filters, 'Year');
  const year = select(yearLabel, 'Year');
  const filterStatus = node('span', filters, undefined, 'hint');
  const chips = node('div', tools, undefined, 'library-filter-chips');
  const count = node('p', tools, '', 'library-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const overview = node('div', host, undefined, 'library-overview');
  overview.hidden = true;
  const linkBar = node('div', host, undefined, 'library-link-bar');
  linkBar.hidden = true;
  const linkForm = node('form', linkBar, undefined, 'library-link-form');
  const linkField = node('label', linkForm, undefined, 'library-link-field');
  linkField.append(uburoomIcons.icon(doc, 'link'));
  const linkInput = node('input', linkField);
  linkInput.type = 'url';
  linkInput.id = 'library-link-input';
  linkInput.placeholder = 'Paste a YouTube video or playlist link…';
  linkInput.setAttribute('aria-label', 'YouTube video or playlist link');
  linkInput.autocomplete = 'off';
  linkInput.maxLength = 500;
  const linkSubmit = node('button', linkForm, undefined, 'primary library-link-submit');
  linkSubmit.type = 'submit';
  linkSubmit.id = 'library-link-submit';
  linkSubmit.textContent = 'Load link';
  const linkClear = button(linkForm, 'Clear link', 'close', 'quiet library-link-clear');
  linkClear.hidden = true;
  const linkStatus = node('p', linkBar, '', 'hint library-link-status');
  linkStatus.setAttribute('role', 'status');
  linkStatus.setAttribute('aria-live', 'polite');
  const linkResults = node('div', linkBar, undefined, 'library-link-results');
  const results = node('div', host, undefined, 'library');
  results.id = 'library';
  const footer = node('div', host, undefined, 'library-footer');
  const note = node('p', footer, '', 'hint');
  note.id = 'library-note';
  note.setAttribute('role', 'status');
  note.setAttribute('aria-live', 'polite');
  const retry = button(footer, 'Retry', 'refresh');
  retry.append(node('span', null, 'Retry'));
  retry.hidden = true;
  controls.content(retry, { label: 'Retry', icon: 'refresh' });
  const sentinel = node('div', host, undefined, 'library-sentinel');
  sentinel.setAttribute('aria-hidden', 'true');
  sentinel.hidden = true;
  const landing = node('div', host, undefined, 'library-landing');
  landing.hidden = true;
  linkBar.before(landing);
  tools.hidden = true;
  row.hidden = true;
  chips.hidden = true;
  count.hidden = true;
  results.hidden = true;
  const navigationControls = [home, search, sort, filterButton, ...viewButtons];
  const scroll = libraryScroll({
    doc,
    host,
    header,
    tools,
    filters,
    results,
    ends: [footer, landing, sentinel],
    onScrolledChange: () => choices.fit(),
  });
  let toolsScreen;
  let catalog,
    room,
    roomRead,
    roomData,
    roomReadAt = 0,
    roomChecked = new Set(),
    roomProgressRows = new Map(),
    progressFor = libraryProgress(),
    generation = 0,
    controller,
    detailController,
    linkController,
    linkResolveVersion = 0,
    catalogController,
    timer,
    busy = false,
    playing;
  let sections = [],
    trail = [],
    screen,
    filterSection,
    facetRead,
    facetFailed = false,
    requestVersion = 0,
    errorAction,
    testVideo = false;
  let visits = [],
    visitIndex = 0,
    historyEpoch,
    historyMoving = false;
  const homes = new Map(),
    availabilityReads = new Set();
  let view = 'cards';
  try {
    const saved = localStorage.getItem('uburoom-library-view');
    if (['cards', 'list', 'posters'].includes(saved)) view = saved;
  } catch {}
  const demoItem = {
    id: 'demo',
    type: 'demo',
    title: 'uburoom synchronization test',
    duration: 60,
    summary: 'A short picture and sound sample for checking shared playback.',
  };
  function context(library, tab = 'library') {
    return {
      library,
      section: library?.id,
      server: library?.serverId,
      tab,
      title: library?.title || 'Test video',
      kind: 'library',
      q: '',
      genre: '',
      year: '',
      sort: 'title',
      order: 'asc',
      seed: newSeed(),
      items: [],
      total: null,
      nextOffset: null,
      scroll: 0,
    };
  }
  function homeContext() {
    return { ...context(), title: 'Libraries', kind: 'home' };
  }
  // Browser history holds only opaque indices. Private catalog data remains in
  // account-scoped memory, and is discarded when catalog eligibility changes.
  function historyState(index = visitIndex) {
    return { ...history.state, uburoomLibrary: { epoch: historyEpoch, index } };
  }
  function saveVisit() {
    if (screen) visits[visitIndex] = { screen, trail: [...trail] };
  }
  function beginHistory() {
    historyEpoch = newSeed();
    visits = [];
    visitIndex = 0;
    historyMoving = false;
    history.scrollRestoration = 'manual';
    // A root guard keeps an ordinary mouse/browser Back at Home on /watch.
    history.replaceState(historyState(-1), '');
    history.pushState(historyState(0), '');
    saveVisit();
  }
  function pushVisit() {
    visits = visits.slice(0, visitIndex + 1);
    visitIndex++;
    saveVisit();
    history.pushState(historyState(), '');
  }
  function cancelAvailability() {
    for (const read of availabilityReads) read.abort();
    availabilityReads.clear();
  }
  function cancelReads() {
    cancelAvailability();
    clearTimeout(timer);
    controller?.abort();
    detailController?.abort();
    requestVersion++;
    resetStatus();
  }
  function saveHome() {
    const root = [...trail, screen].find(x => x?.kind === 'library');
    if (root?.library) homes.set(JSON.stringify([libraryKey(root.library), root.tab]), root);
  }
  function prepareNavigation() {
    rememberScroll();
    saveVisit();
    saveHome();
    cancelReads();
    scroll.reserveHeight();
  }
  function goHistory(delta) {
    if (historyMoving || !catalog || visitIndex + delta < 0 || visitIndex + delta >= visits.length) return;
    historyMoving = true;
    history.go(delta);
  }
  window.addEventListener('popstate', event => {
    const entry = event.state?.uburoomLibrary;
    if (!historyEpoch) return;
    syncRoomLocation();
    if (entry?.epoch === historyEpoch && entry.index === -1) {
      history.go(1);
      return;
    }
    if (entry?.epoch !== historyEpoch || !visits[entry.index]) {
      history.replaceState(historyState(), '');
      historyMoving = false;
      return;
    }
    rememberScroll();
    saveVisit();
    saveHome();
    cancelReads();
    visitIndex = entry.index;
    ({ screen, trail } = visits[visitIndex]);
    historyMoving = false;
    if (!catalog || !screen) return;
    restoreScreen();
    if (screen.library !== filterSection) void fetchFacets(screen.library);
  });
  function goHome() {
    if (!catalog || (screen.kind === 'home' && !screen.q)) return;
    prepareNavigation();
    screen = homeContext();
    trail = [];
    pushVisit();
    renderResults();
    scroll.position();
  }
  function newSeed() {
    return crypto.randomUUID().replace(/-/g, '');
  }
  function clearResults() {
    results.replaceChildren();
  }
  const layoutObserver = new ResizeObserver(entries => {
    const updates = [];
    for (const { target } of entries) {
      if (target === host) {
        // Match the Cards/Posters grid, including its two-column phone layout.
        const width = host.getBoundingClientRect().width;
        if (!width) continue;
        const gap = width <= 440 ? 12 : 14,
          columns = width <= 440 ? 2 : Math.max(1, Math.floor((width + gap) / (160 + gap)));
        updates.push([host, '--library-poster-width', (width - gap * (columns - 1)) / columns + 'px']);
      }
      if (target === header) updates.push([header.parentElement, '--media-header-height', header.offsetHeight + 'px']);
    }
    // Batch writes after measurements so loaded rows do not each force layout.
    for (const [target, property, value] of updates)
      if (target.style.getPropertyValue(property) !== value) target.style.setProperty(property, value);
    if (entries.some(entry => entry.target === header)) choices.scheduleFit();
  });
  layoutObserver.observe(host);
  if (header) layoutObserver.observe(header);
  function measureHeader() {
    if (header) header.parentElement.style.setProperty('--media-header-height', header.offsetHeight + 'px');
  }
  function rememberScroll() {
    if (screen) {
      screen.scroll = scroll.scrollElement().scrollTop;
      screen.anchor = scroll.captureAnchor();
    }
  }
  function restoreScroll(value) {
    const current = screen,
      version = generation;
    requestAnimationFrame(() => {
      if (catalog && screen === current && generation === version) scroll.scrollElement().scrollTop = value;
    });
  }
  const pageObserver = new IntersectionObserver(
    entries => {
      if (
        entries.some(x => x.isIntersecting) &&
        catalog &&
        screen?.kind !== 'details' &&
        (screen?.kind !== 'home' || !!screen?.q) &&
        screen?.nextOffset != null &&
        !screen.loading &&
        !screen.pageError
      )
        void loadPage(true);
    },
    { rootMargin: '320px 0px' },
  );
  function watchNextPage() {
    pageObserver.unobserve(sentinel);
    sentinel.hidden =
      !screen || screen.kind === 'details' || (screen.kind === 'home' && !screen.q) || screen.nextOffset == null;
    if (!sentinel.hidden && !screen.loading && !screen.pageError) pageObserver.observe(sentinel);
  }
  // Catalog reads use the account; the server applies a guest's room grant automatically.
  // A page opened from outside a library (an episode from the queue, then its show) names its item's server.
  const scoped = (query = {}) => {
    const server = screen?.server;
    return { ...(server ? { server } : {}), ...query };
  };
  function playable(item) {
    return ['movie', 'episode', 'demo'].includes(item.type);
  }
  function identity(item) {
    return item.title + (item.edition ? ' · ' + item.edition : '');
  }
  function runtime(seconds) {
    const minutes = Math.round(seconds / 60);
    return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + (minutes % 60) + 'm' : minutes + 'm';
  }
  function metadata(item) {
    if (item.type === 'collection') return (item.count || item.episodeCount || 0) + ' items';
    if (item.type === 'season') return (item.episodeCount || item.count || 0) + ' episodes';
    return [
      item.type === 'episode'
        ? Number.isInteger(item.index)
          ? 'Episode ' + item.index
          : ''
        : item.endYear && item.endYear !== item.year
          ? item.year + '–' + item.endYear
          : item.year,
      item.type === 'show'
        ? item.count
          ? item.count + (item.count === 1 ? ' season' : ' seasons')
          : ''
        : item.duration
          ? runtime(item.duration)
          : '',
      item.edition,
      !screen?.section && item.sectionTitle
        ? item.serverName && new Set(sections.map(s => s.serverId)).size > 1
          ? item.sectionTitle + ' (' + item.serverName + ')'
          : item.sectionTitle
        : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }
  const pictures = pictureLoader({
    doc,
    serverFor: item => item.serverId || screen?.server,
    fetchArt: (server, item, kind, type, signal) => {
      const params = new URLSearchParams({ ...(server ? { server } : {}), item, kind, type });
      return artwork('/api/watch/library/art?' + params, signal);
    },
  });
  const { prefetch: prefetchArt, picture } = pictures;
  const artItems = new WeakMap(),
    resumeItems = new WeakMap();
  function patchProgress(box, item, position) {
    let track = box.querySelector('.library-progress');
    if (position > 0 && item.duration > 0) {
      if (!track) {
        track = node('div', box, undefined, 'library-progress');
        node('div', track, undefined, 'library-progress-fill');
      }
      const width = Math.min(100, (position / item.duration) * 100).toFixed(1) + '%';
      if (track.firstElementChild.style.width !== width) track.firstElementChild.style.width = width;
    } else track?.remove();
  }
  function art(parent, item, landscape = false, projectRoom = true) {
    const box = node('div', parent, undefined, 'library-art' + (landscape ? ' landscape' : ''));
    const fallback = node('span', box, undefined, 'library-art-fallback');
    fallback.append(
      uburoomIcons.icon(
        doc,
        item.type === 'collection' ? 'layout-grid' : ['show', 'season', 'episode'].includes(item.type) ? 'tv' : 'film',
      ),
    );
    node('span', fallback, item.title);
    if (landscape ? item.hasLandscape : item.hasPoster) picture(box, item, landscape ? 'landscape' : 'poster');
    if (projectRoom) artItems.set(box, item);
    patchProgress(box, item, projectRoom ? progressFor(item) : item.viewOffset);
    box.classList.toggle('unavailable', item.available === false);
    node('span', box, 'Unavailable', 'library-unavailable').hidden = item.available !== false;
    return box;
  }
  function signalError(message, action) {
    note.textContent = message;
    note.classList.add('library-error');
    retry.hidden = !action;
    errorAction = action;
  }
  function signalNotice(message) {
    note.textContent = message;
    note.classList.remove('library-error');
    retry.hidden = true;
    errorAction = undefined;
  }
  function resetStatus() {
    note.textContent = '';
    note.classList.remove('library-error');
    retry.hidden = true;
    errorAction = undefined;
  }
  function itemMediaKey(item) {
    const raw = String(item?.mediaId || item?.id || '');
    return mediaIdentity(raw)?.id || raw;
  }
  // The room's pending suggestion of this video, if any.
  function suggestionFor(item) {
    const key = itemMediaKey(item);
    if (!key || key === 'demo') return undefined;
    return (getPlayer?.()?.suggestions || []).find(entry => itemMediaKey(entry?.item) === key);
  }
  function canAddQueue() {
    const p = getPlayer?.();
    return !!p?.durable && (p?.capabilities ? !!p.capabilities.addQueue : true);
  }
  function canSuggest() {
    const p = getPlayer?.();
    return !!suggestMedia && !!p?.durable && !!p?.capabilities?.suggestMedia;
  }
  // A suggested video's bulb stays lit, shows how many agree once more than one does, and toggles your agreement.
  function syncSuggestButton(b) {
    const entry = suggestionFor({ id: b.dataset.suggest });
    const count = entry?.supporters.length || 0;
    const itemTitle = b.dataset.identity || 'item';
    const label = !entry
      ? 'Suggest ' + itemTitle
      : entry.agreed
        ? (count === 1 ? 'Withdraw suggestion of ' : 'Stop agreeing with ') + itemTitle
        : 'Agree with suggesting ' + itemTitle;
    b.hidden = !canSuggest();
    b.dataset.suggested = String(!!entry);
    b.setAttribute('aria-pressed', String(!!entry?.agreed));
    b.disabled = b.dataset.unavailable === 'true' || busy || !canSuggest();
    b.title = label + (count ? ' (' + count + (count === 1 ? ' agrees)' : ' agree)') : '');
    b.setAttribute('aria-label', b.title);
    const text = b.querySelector('.library-suggest-label');
    if (text) text.textContent = entry ? 'Suggested' : 'Suggest';
    const counter = b.querySelector('.library-suggest-count');
    counter.textContent = String(count);
    counter.hidden = count < 2;
  }
  function syncSuggestions() {
    const root = host.closest('#library-panel') || host;
    const addAllowed = canAddQueue();
    for (const b of root.querySelectorAll('[data-queue-item]')) {
      b.hidden = !addAllowed;
      b.disabled = b.dataset.unavailable === 'true' || busy || !addAllowed;
    }
    for (const b of root.querySelectorAll('[data-suggest]')) syncSuggestButton(b);
  }
  function setBusy(value) {
    busy = value;
    const root = host.closest('#library-panel') || host;
    for (const b of root.querySelectorAll('[data-play]'))
      b.disabled = b.dataset.unavailable === 'true' || busy || !!playing || !catalog;
    const durable = !!getPlayer()?.durable;
    for (const b of root.querySelectorAll('[data-queue]:not([data-queue-item])')) {
      b.hidden = !durable;
      b.disabled = b.dataset.unavailable === 'true' || busy || !canAddQueue();
    }
    for (const b of root.querySelectorAll('[data-auto-queue]')) {
      b.hidden = !durable;
      b.disabled = busy || !getPlayer()?.capabilities?.editQueue;
    }
    scopeActions.hidden = !durable || !scopeActions.childElementCount;
    syncSuggestions();
  }
  function formatTimestamp(value) {
    const seconds = Math.floor(value || 0),
      minutes = Math.floor(seconds / 60);
    return (
      (seconds >= 3600 ? Math.floor(minutes / 60) + ':' + String(minutes % 60).padStart(2, '0') : minutes) +
      ':' +
      String(seconds % 60).padStart(2, '0')
    );
  }
  async function play(item, options = {}) {
    if (item.available === false || busy || playing || !catalog) return;
    const version = generation;
    const attempt = (playing = {});
    setBusy(busy);
    resetStatus();
    note.textContent = 'Loading ' + identity(item) + '…';
    try {
      const result = await load(item, options);
      if (version !== generation || playing !== attempt) return;
      if (result?.status === 'cancelled') {
        note.textContent = '';
        return;
      }
      if (result?.status !== 'applied') throw new Error('Playback was not accepted; try again.');
      note.textContent = '';
      close();
    } catch (error) {
      if (version === generation && playing === attempt) signalError(error.message, () => play(item, options));
    } finally {
      if (version === generation && playing === attempt) {
        playing = undefined;
        setBusy(busy);
      }
    }
  }
  function playButton(parent, item, large = false) {
    const b = button(parent, 'Play ' + identity(item), 'play', large ? 'library-play-now primary' : 'library-play');
    b.dataset.play = item.id;
    b.dataset.action = 'play';
    b.dataset.unavailable = String(item.available === false);
    b.disabled = item.available === false;
    if (large) b.append(node('span', null, 'Play now'));
    b.addEventListener('click', () => void play(item));
    return b;
  }
  function resumeButton(parent, item) {
    const b = button(parent, '', 'play', 'library-resume quiet');
    b.dataset.play = item.id;
    b.dataset.action = 'resume';
    b.dataset.unavailable = String(item.available === false);
    b.append(node('span', null));
    resumeItems.set(b, item);
    patchResume(b, item);
    b.addEventListener('click', () => {
      const position = progressFor(item);
      if (position > 0) void play(item, { position, resume: true });
    });
    return b;
  }
  function patchResume(b, item) {
    const position = progressFor(item);
    b.hidden = position === 0;
    const label = 'Resume at ' + formatTimestamp(position);
    if (b.getAttribute('aria-label') !== label) {
      b.setAttribute('aria-label', label);
      b.title = label;
      b.lastElementChild.textContent = label;
    }
  }
  function queueButton(parent, item, large = false) {
    const b = button(
      parent,
      'Add ' + identity(item) + ' to queue',
      'queue',
      large ? 'library-queue-add quiet' : 'library-queue-add',
    );
    b.dataset.unavailable = String(item.available === false);
    b.dataset.queue = item.id;
    b.dataset.queueItem = 'true';
    b.hidden = !canAddQueue();
    b.disabled = b.dataset.unavailable === 'true' || busy || !canAddQueue();
    if (large) b.append(node('span', null, 'Add to queue'));
    b.addEventListener('click', async event => {
      event.stopPropagation();
      if (b.disabled || !addToQueue) return;
      b.disabled = true;
      try {
        await addToQueue(item, b);
      } catch (error) {
        uburoomPopover.show(b, { text: error.message, state: 'error' });
      } finally {
        b.disabled = b.dataset.unavailable === 'true' || busy || !canAddQueue();
      }
    });
    return b;
  }
  function suggestButton(parent, item, large = false) {
    const b = button(parent, 'Suggest ' + identity(item), 'bulb', large ? 'library-suggest quiet' : 'library-suggest');
    b.dataset.unavailable = String(item.available === false);
    b.dataset.suggest = item.id;
    b.dataset.identity = identity(item);
    if (large) b.append(node('span', null, 'Suggest', 'library-suggest-label'));
    node('span', b, '', 'library-suggest-count');
    syncSuggestButton(b);
    b.addEventListener('click', async event => {
      event.stopPropagation();
      if (b.disabled) return;
      const entry = suggestionFor(item);
      b.disabled = true;
      try {
        if (!entry) await suggestMedia(item);
        else await agreeSuggestion(entry.id, !entry.agreed);
        const text = !entry
          ? 'Suggested'
          : entry.agreed
            ? entry.supporters.length === 1
              ? 'Suggestion withdrawn'
              : 'No longer agreeing'
            : 'Agreed';
        uburoomPopover.show(b, { text, state: 'success' });
      } catch (error) {
        uburoomPopover.show(b, { text: error.message, state: 'error' });
      } finally {
        syncSuggestButton(b);
      }
    });
    return b;
  }
  function bulkButton(parent, item) {
    const label = 'Add ' + (item.type === 'season' ? 'season' : 'show') + ' to queue';
    const b = button(parent, label, 'queue', 'library-queue-add quiet');
    b.dataset.queue = item.id;
    b.append(node('span', null, label));
    b.onclick = () => {
      if (!b.disabled) void addBulkToQueue(item, b);
    };
    return b;
  }
  function autoButton(parent, scope, title) {
    const b = button(parent, 'Set as auto-queue from ' + title, 'sparkle', 'library-auto-queue');
    if (parent === scopeActions)
      b.classList.add('watch-control', 'watch-control-responsive', 'watch-control-solid-disabled');
    else b.classList.add('quiet');
    b.dataset.autoQueue = scope.id;
    node('span', b, 'Set as auto-queue', 'library-auto-queue-label watch-control-label');
    b.onclick = () => {
      if (!b.disabled) autoQueue({ scope, title });
    };
    return b;
  }
  function extras(parent, item, full = false) {
    const line = node('div', parent, undefined, 'library-extras');
    line.hidden = item.available !== false && !item.contentRating && !item.genres?.length;
    node('span', line, 'Unavailable', 'library-availability').hidden = item.available !== false;
    if (item.contentRating) node('span', line, item.contentRating, 'library-rating');
    if (item.genres?.length) node('span', line, (full ? item.genres : item.genres.slice(0, 2)).join(' · '));
  }
  /**
   * One title as a tile. On Media Home a row passes its container and a shape ('landscape' for Continue
   * watching, 'poster' for Recently added): there every title, episodes too, is a picture tile, and it opens
   * from its own server as a page opened from outside a library does.
   */
  function tile(item, { parent = results, shape } = {}) {
    const episode = item.type === 'episode' && !shape,
      row = !shape && (episode || view === 'list');
    const open = () => void openItem(item, shape ? { outside: true } : undefined);
    const card = node('article', parent, undefined, 'library-tile' + (episode ? ' episode' : ''));
    card.dataset.item = item.id;
    if (item.serverId) card.dataset.server = item.serverId;
    card.classList.toggle('unavailable', item.available === false);
    if (item.hasLogo || item.hasBackdrop) {
      // Resting a mouse pointer (or keyboard focus) on a title starts its details pictures, so they are often
      // ready by the time it opens; passing over it on the way elsewhere does not.
      let intent;
      const start = () => {
        clearTimeout(intent);
        intent = setTimeout(() => prefetchArt(item), 150);
      };
      const stop = () => clearTimeout(intent);
      card.addEventListener('pointerenter', event => event.pointerType === 'mouse' && start());
      card.addEventListener('pointerleave', stop);
      card.addEventListener('focusin', start);
      card.addEventListener('focusout', stop);
    }
    if (row) {
      card.classList.add('library-row');
      card.addEventListener('click', event => {
        if (event.target.closest('button,a,input,select,textarea,summary')) return;
        const selection = doc.getSelection();
        if (selection?.toString() && card.contains(selection.anchorNode)) return;
        open();
      });
    }
    const picture = art(card, item, shape ? shape === 'landscape' : episode, shape !== 'landscape');
    button(picture, 'View ' + identity(item), '', 'library-open').addEventListener('click', open);
    const copy = node('div', card, undefined, 'library-copy');
    const title = button(copy, 'View ' + identity(item), undefined, 'library-title');
    title.textContent = item.title;
    title.addEventListener('click', open);
    node('p', copy, shape === 'landscape' ? resumeLine(item) : metadata(item), 'library-meta');
    if (row) {
      extras(copy, item);
      if (episode && item.summary) node('p', copy, item.summary, 'library-episode-summary');
    }
    if (playable(item)) {
      if (row) {
        const actions = node('div', card, undefined, 'library-row-actions');
        playButton(actions, item);
        if (addToQueue) queueButton(actions, item);
        if (suggestMedia && item.id !== 'demo') suggestButton(actions, item);
      } else {
        playButton(picture, item);
        if (addToQueue) queueButton(picture, item);
        if (suggestMedia && item.id !== 'demo') suggestButton(picture, item);
      }
    } else {
      const target = row ? node('div', card, undefined, 'library-row-actions') : picture;
      const b = button(target, 'Browse ' + item.title, 'right', 'library-browse');
      b.addEventListener('click', open);
    }
    return card;
  }
  // Under a Continue watching tile: where an episode sits in its show, or how much of a movie is left.
  function resumeLine(item) {
    if (item.type === 'episode')
      return [
        item.showTitle,
        Number.isInteger(item.seasonIndex) ? 'S' + item.seasonIndex : '',
        Number.isInteger(item.index) ? 'E' + item.index : '',
      ]
        .filter(Boolean)
        .join(' · ');
    const left = item.duration > 0 && item.viewOffset > 0 ? item.duration - item.viewOffset : 0;
    return left > 60 ? runtime(left) + ' left' : metadata(item);
  }
  // Catalog shelves have the account's lifetime. The room row is read separately.
  let shelfData = null,
    shelfAt = 0,
    shelfRead;
  const shelfHost = node('div', null, undefined, 'library-shelves');
  const librariesTitle = node('h3', null, 'Libraries', 'library-shelf-title');
  function patchShelfProgress(card, item, shape) {
    const box = card.querySelector('.library-art');
    if (box) {
      if (shape !== 'landscape') artItems.set(box, item);
      patchProgress(box, item, shape === 'landscape' ? item.viewOffset : progressFor(item));
    }
    if (shape === 'landscape') {
      const meta = card.querySelector('.library-meta');
      if (meta) meta.textContent = resumeLine(item);
    }
  }
  const shelves = libraryShelves({ host: shelfHost, node, button, tile, patchProgress: patchShelfProgress });
  function renderShelves() {
    scroll.preserveVisible(landing.querySelectorAll('.library-shelf, .library-home-card'), () => {
      librariesTitle.hidden = !shelves.render([
        // What this room started and left unfinished, before each viewer's own Plex progress.
        { title: 'Continue in this room', items: roomData?.roomItems, shape: 'landscape' },
        { title: 'Continue watching', items: shelfData?.continueWatching, shape: 'landscape' },
        { title: 'Recently added', items: shelfData?.recentlyAdded, shape: 'poster' },
      ]);
    });
    setBusy(busy);
  }
  function loadShelves() {
    if (!catalog || Date.now() - shelfAt < 60000 || shelfRead) return;
    const version = generation;
    // Asked once the page has finished starting: the library can render Libraries home while it is still being
    // mounted (from the page's first paint), before the connection a request goes through exists.
    const signal = catalogController.signal;
    const read = Promise.resolve()
      .then(() => request('library.shelves', {}, signal))
      .then(data => {
        if (version !== generation) return;
        shelfData = data;
        shelfAt = Date.now();
        if (screen?.kind === 'home') {
          renderShelves();
          refreshRoomMedia();
        }
      })
      .catch(() => {})
      .finally(() => {
        if (shelfRead === read) shelfRead = undefined;
      });
    shelfRead = read;
  }
  function showRoomMedia(data) {
    roomData = data;
    progressFor = libraryProgress(data?.progress);
    if (screen?.kind === 'home') renderShelves();
    for (const box of host.querySelectorAll('.library-art')) {
      const item = artItems.get(box);
      if (item) patchProgress(box, item, progressFor(item));
    }
    for (const b of overview.querySelectorAll('[data-action="resume"]')) patchResume(b, resumeItems.get(b));
  }
  async function refreshRoomMedia() {
    if (!catalog || !room || roomRead) return;
    const now = Date.now();
    const expired = now - roomReadAt >= 60000;
    if (expired) {
      roomChecked.clear();
      roomProgressRows.clear();
    }
    const includeContinue = screen?.kind === 'home' && (expired || roomData?.roomItems === undefined);
    const pending = new Map();
    for (const box of host.querySelectorAll('.library-art')) {
      const item = artItems.get(box);
      if (!item || !playable(item) || item.id === 'demo') continue;
      const server = item.serverId || screen?.server || '';
      const key = libraryProgressKey(server, item.id);
      if (!roomChecked.has(key)) pending.set(key, [server, item.id]);
    }
    if (!pending.size && !includeContinue) return;
    const read = (roomRead = new AbortController());
    const wanted = room;
    const entries = [...pending];
    const encode = new TextEncoder();
    let applied = false;
    try {
      let progress, roomItems;
      let offset = 0;
      do {
        const start = offset;
        let bytes = 0;
        // Keep room progress batches inside the socket's 8 KiB message limit.
        while (offset < entries.length && offset - start < 32) {
          bytes += encode.encode(entries[offset][0]).length + 1;
          if (offset > start && bytes > 7000) break;
          offset++;
        }
        const batch = entries.slice(start, offset);
        const data = await request(
          'library.room',
          { room: wanted, items: batch.map(([, pair]) => pair), includeContinue: start === 0 && includeContinue },
          read.signal,
        );
        if (read.signal.aborted) return;
        progress = data.progress;
        roomItems ??= data.roomItems;
        for (const [key] of batch) roomChecked.add(key);
        for (const row of progress.history) roomProgressRows.set(libraryProgressKey(row.serverId, row.mediaId), row);
      } while (offset < entries.length);
      roomReadAt = now;
      showRoomMedia({
        progress: { ...progress, history: [...roomProgressRows.values()] },
        roomItems: roomItems ?? roomData?.roomItems,
      });
      applied = true;
    } catch (error) {
      if (!read.signal.aborted && [401, 403].includes(error.status)) showRoomMedia(undefined);
    } finally {
      if (roomRead === read) {
        roomRead = undefined;
        if (applied) void refreshRoomMedia();
      }
    }
  }
  function setRoom(id) {
    if (room !== id) {
      if (room && playing) {
        playing = undefined;
        resetStatus();
      }
      room = id;
      roomRead?.abort();
      roomRead = undefined;
      roomReadAt = 0;
      roomChecked.clear();
      roomProgressRows.clear();
      showRoomMedia(undefined);
      void refreshRoomMedia();
    }
  }
  function renderTools() {
    if (!screen) return;
    navigationControls.forEach(n => {
      n.disabled = false;
    });
    previous.disabled = visitIndex === 0;
    next.disabled = visitIndex >= visits.length - 1;
    home.disabled = screen.kind === 'home' && !screen.q;
    previous.title = previous.disabled ? 'No earlier Media page.' : 'Back';
    next.title = next.disabled ? 'No later Media page.' : 'Forward';
    home.title = home.disabled ? 'Already at Libraries home.' : 'Libraries home';
    choices.render(sections, screen.library, screen.kind !== 'home');
    const details = screen.kind === 'details',
      atHome = screen.kind === 'home',
      homeSearching = atHome && Boolean(screen.q),
      showHomeBar = atHome && sections.length > 0,
      collectionIndex = screen.kind === 'library' && screen.tab === 'collections';
    const section = screen.library;
    const isLinkSection = !details && !atHome && (section?.source === 'link' || screen.source === 'link');
    const libraryAutoQueue = !(
      isLinkSection ||
      !autoQueue ||
      screen.kind !== 'library' ||
      screen.tab !== 'library' ||
      section?.mediaType !== 'movie' ||
      section.autoQueue === false
    );
    const scopeSig = libraryAutoQueue ? JSON.stringify([section.id, section.serverId || '', section.title || '']) : '';
    if (scopeActions.dataset.signature !== scopeSig) {
      scopeActions.dataset.signature = scopeSig;
      scopeActions.replaceChildren();
      if (libraryAutoQueue)
        autoButton(
          scopeActions,
          { type: 'library', id: section.id, ...(section.serverId ? { serverId: section.serverId } : {}) },
          section.title,
        );
    }
    tools.hidden = details || (atHome && !showHomeBar && !homeSearching);
    if (toolsScreen !== screen) {
      toolsScreen = screen;
      scroll.tuck(false);
    }
    row.hidden = details || (atHome && !showHomeBar && !homeSearching);
    toolControls.hidden = atHome && !homeSearching;
    linkBar.hidden = !isLinkSection;
    sortWrap.hidden = isLinkSection;
    direction.hidden = isLinkSection;
    chips.hidden = details || atHome;
    filterButton.hidden =
      isLinkSection ||
      !screen.section ||
      section?.filters === false ||
      collectionIndex ||
      ['show', 'season'].includes(screen.kind);
    filterButton.classList.toggle('filter-active', !filters.hidden || !!(screen.genre || screen.year));
    const filterSpan = filterButton.querySelector('.filter-label');
    if (filterSpan)
      filterSpan.textContent =
        screen.genre || screen.year ? 'Filters (' + ((screen.genre ? 1 : 0) + (screen.year ? 1 : 0)) + ')' : 'Filters';
    if (filterButton.hidden || details || atHome) {
      filters.hidden = true;
      filterButton.setAttribute('aria-expanded', 'false');
      filterButton.classList.remove('filter-active');
    }
    if (search.value !== screen.q) search.value = screen.q || '';
    search.placeholder = atHome
      ? 'Search all libraries'
      : isLinkSection
        ? 'Filter cached videos'
        : screen.kind === 'season' || screen.onlySeason
          ? 'Search episodes'
          : collectionIndex
            ? 'Search collections'
            : 'Search this library';
    search.setAttribute('aria-label', search.placeholder);
    const hasDefaultSort = !!(screen.parent || screen.collection);
    const hasRuntimeSort = !collectionIndex && (screen.kind !== 'show' || !!screen.onlySeason);
    const sortSig = JSON.stringify([hasDefaultSort, collectionIndex, hasRuntimeSort, screen.sort, screen.order]);
    if (sort.dataset.signature !== sortSig) {
      sort.dataset.signature = sortSig;
      sort.replaceChildren();
      if (hasDefaultSort) option(sort, 'default', 'Default order');
      option(sort, 'title', screen.sort === 'title' && screen.order === 'desc' ? 'Title Z–A' : 'Title A–Z');
      if (!collectionIndex) {
        option(sort, 'added', screen.sort === 'added' && screen.order === 'asc' ? 'Oldest added' : 'Recently added');
        option(sort, 'year', screen.sort === 'year' && screen.order === 'asc' ? 'Oldest release' : 'Newest release');
        if (hasRuntimeSort)
          option(
            sort,
            'runtime',
            screen.sort === 'runtime' && screen.order === 'desc' ? 'Longest runtime' : 'Shortest runtime',
          );
      }
      option(sort, 'random', 'Random');
    }
    sort.value = screen.sort;
    direction.disabled = screen.sort === 'default';
    direction.title = direction.ariaLabel =
      screen.sort === 'random'
        ? 'Shuffle again'
        : screen.order === 'asc'
          ? 'Ascending: switch to descending'
          : 'Descending: switch to ascending';
    if (direction.disabled) direction.title = 'Default order cannot be reversed.';
    const dirIcon = screen.sort === 'random' ? 'refresh' : 'sort';
    if (direction.dataset.icon !== dirIcon) {
      direction.dataset.icon = dirIcon;
      direction.replaceChildren(uburoomIcons.icon(doc, dirIcon));
    }
    direction.dataset.order = screen.sort === 'random' ? '' : screen.order;
    genre.value = screen.genre;
    year.value = screen.year;
    const chipsSig = JSON.stringify([
      screen.genre || '',
      screen.genre ? genre.selectedOptions[0]?.textContent || screen.genre : '',
      screen.year || '',
      screen.year ? year.selectedOptions[0]?.textContent || screen.year : '',
    ]);
    if (chips.dataset.signature !== chipsSig) {
      chips.dataset.signature = chipsSig;
      chips.replaceChildren();
      for (const [key, control] of [
        ['genre', genre],
        ['year', year],
      ])
        if (screen[key]) {
          const label = control.selectedOptions[0]?.textContent || screen[key];
          const b = button(chips, 'Remove ' + label, 'close', 'library-filter-chip');
          b.append(node('span', null, label));
          b.onclick = () => {
            screen[key] = '';
            void query();
          };
        }
    }
    host.dataset.view = view;
    viewButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    count.hidden = details || (atHome && !homeSearching);
    count.textContent = screen.loading
      ? 'Loading…'
      : screen.partial && screen.limited
        ? screen.items.length + ' loaded (partial, limit reached)'
        : screen.partial
          ? screen.items.length + ' loaded (partial)'
          : screen.limited
            ? screen.items.length + ' loaded (limit reached)'
            : screen.total == null
              ? screen.items.length + ' loaded'
              : screen.items.length < screen.total
                ? screen.items.length + ' of ' + screen.total + ' items'
                : screen.total + (screen.total === 1 ? ' item' : ' items');
    results.classList.toggle('episodes', screen.kind === 'season' || !!screen.onlySeason);
    results.hidden = details || (atHome && !homeSearching);
    landing.hidden = !atHome || homeSearching;
    footer.hidden = atHome && !homeSearching;
    // Navigation can wrap differently after rendering. Publish its height before
    // restoring the visible item so the sticky toolbar uses the final offset.
    measureHeader();
  }
  function renderLanding() {
    landing.replaceChildren();
    landing.append(shelfHost, librariesTitle);
    renderShelves();
    for (const [index, card] of homeCards(sections).entries()) {
      const library = sections[index];
      const { item, open } = homeCard(card);
      open.dataset.section = card.id;
      open.dataset.tab = 'library';
      open.onclick = () => void chooseLibrary(library, 'library');
      if (card.collections) {
        const more = button(item, card.title + ' collections', 'layout-grid', 'library-home-collections');
        more.append(node('span', null, 'Collections'));
        more.dataset.section = card.id;
        more.dataset.tab = 'collections';
        more.onclick = () => void chooseLibrary(library, 'collections');
      }
    }
    if (testVideo && isAdmin()) {
      const { open } = homeCard(SYNC_CARD);
      open.dataset.action = 'play';
      open.dataset.play = 'demo';
      open.onclick = () => void play(demoItem);
    }
    // The rows above are fetched last: the library cards never wait on, or fail with, them.
    loadShelves();
  }
  /** A card's frame and its main button: the icon at the top, the name and server at the bottom. */
  function homeCard(card) {
    const item = node('div', landing, undefined, 'library-home-item');
    const open = button(item, card.title, undefined, 'library-home-card');
    node('span', open, undefined, 'library-home-icon').append(uburoomIcons.icon(doc, card.icon));
    const text = node('span', open, undefined, 'library-home-text');
    node('span', text, card.title, 'library-home-title');
    if (card.source) {
      const source = node('span', text, undefined, 'library-home-source');
      if (card.source.logo) {
        const logo = node('img', source);
        logo.src = card.source.logo;
        logo.alt = card.source.label;
        logo.width = 16;
        logo.height = 16;
      }
      node('span', source, card.source.text);
    }
    return { item, open };
  }
  function renderResults(reuseImages = false) {
    if (reuseImages) pictures.reuse(host.querySelectorAll('.library-art img, .library-detail-backdrop img'));
    renderTools();
    clearResults();
    if (screen.kind === 'home' && !screen.q) renderLanding();
    // Away from Home its rows hold no tiles: hidden copies would linger behind the page being browsed.
    else {
      shelves.clear();
      landing.replaceChildren();
    }
    if ((screen.kind !== 'home' || !!screen.q) && screen.kind !== 'details') {
      screen.items.forEach(item => tile(item));
      if (!screen.items.length && screen.loading)
        for (let i = 0; i < 3; i++) {
          const placeholder = node('div', results, undefined, 'library-skeleton');
          placeholder.setAttribute('aria-hidden', 'true');
        }
      if (!screen.items.length && !screen.loading && !screen.pageError) {
        const currentSection = screen.library;
        const isLink = currentSection?.source === 'link' || screen.source === 'link';
        node(
          'p',
          results,
          screen.partial && screen.limited
            ? 'Not all libraries were searched, and some could not be reached. Narrow your search to check more.'
            : screen.partial
              ? 'No matches in the available libraries.'
              : screen.limited
                ? 'Not all libraries were searched. Narrow your search to check more.'
                : screen.q || screen.genre || screen.year
                  ? 'No matches. Try another search or clear the filters.'
                  : isLink
                    ? 'Paste a YouTube video or playlist link above to preview or queue it.'
                    : screen.tab === 'collections'
                      ? 'No collections in this library.'
                      : 'No titles here yet.',
          'library-empty',
        );
      }
    }
    // A page opened from the queue knows only a title until its details arrive; it shows nothing until then
    // rather than a bare placeholder that is replaced a moment later.
    summary(screen.outside && !screen.detailsLoaded ? undefined : screen.detail);
    pictures.endReuse();
    watchNextPage();
    setBusy(busy);
    void refreshRoomMedia();
  }
  function updateAvailability(root, item) {
    const missing = item.available === false;
    if (root.classList.contains('library-tile')) root.classList.toggle('unavailable', missing);
    root.querySelector('.library-art')?.classList.toggle('unavailable', missing);
    for (const label of root.querySelectorAll('.library-unavailable,.library-availability')) label.hidden = !missing;
    const line = root.querySelector('.library-extras');
    if (line) line.hidden = !missing && !item.contentRating && !item.genres?.length;
    for (const b of root.querySelectorAll('[data-play],[data-queue],[data-suggest]'))
      b.dataset.unavailable = String(missing);
  }
  async function checkAvailability(items, current) {
    const groups = new Map();
    for (const item of items) {
      if (!['movie', 'episode'].includes(item.type) || !item.id) continue;
      const server = item.serverId || current?.server || '';
      if (!groups.has(server)) groups.set(server, new Set());
      groups.get(server).add(item.id);
    }
    if (!groups.size) return;
    const read = new AbortController(),
      version = generation;
    availabilityReads.add(read);
    try {
      for (const [server, idSet] of groups) {
        const ids = [...idSet];
        // Keep batches within the room connection's message limit, including 20-digit IDs.
        for (let offset = 0; offset < ids.length; offset += 32) {
          const data = await request(
            'library.availability',
            { ...(server ? { server } : {}), items: ids.slice(offset, offset + 32).join(',') },
            read.signal,
          );
          if (version !== generation || screen !== current || read.signal.aborted) return;
          const statuses = new Map(data.items.map(item => [item.id, item.available]));
          const cards = new Map(
            [...results.children].map(card => [(card.dataset.server || server) + ':' + card.dataset.item, card]),
          );
          for (const item of current.items)
            if ((item.serverId || current?.server || '') === server && statuses.has(item.id)) {
              item.available = statuses.get(item.id);
              const card = cards.get(server + ':' + item.id);
              if (card) updateAvailability(card, item);
            }
          if (
            current.detail &&
            (current.detail.serverId || current?.server || '') === server &&
            statuses.has(current.detail.id)
          ) {
            current.detail.available = statuses.get(current.detail.id);
            updateAvailability(overview, current.detail);
          }
          setBusy(busy);
        }
      }
    } catch (error) {
      if (version === generation && current === screen && error.name !== 'AbortError')
        signalError(
          'Availability could not be checked. ' + error.message,
          () => void checkAvailability(items, current),
        );
    } finally {
      availabilityReads.delete(read);
    }
  }
  // The notice describes the cached page, not the navigation that originally fetched it.
  function renderBrowseStatus() {
    if (screen.kind === 'details' || (screen.kind === 'home' && !screen.q)) return;
    if (screen.partial && screen.limited)
      signalError(
        'Some libraries could not be searched and the search limit was reached. Narrow your search to see more.',
        () => void loadPage(false),
      );
    else if (screen.partial)
      signalError('Some libraries could not be searched. Showing partial results.', () => void loadPage(false));
    else if (screen.limited) signalNotice('Not all libraries were searched. Narrow your search to see more.');
  }
  async function loadPage(append = false) {
    if (!catalog || !screen || screen.kind === 'details' || (screen.kind === 'home' && !screen.q)) return;
    if (append && (screen.loading || screen.nextOffset == null)) return;
    if (append && screen.dirty) {
      await query();
      return;
    }
    controller?.abort();
    controller = new AbortController();
    const version = ++requestVersion,
      current = screen,
      catalogVersion = generation;
    resetStatus();
    current.pageError = false;
    if (!append) {
      current.partial = false;
      current.limited = false;
    }
    current.loading = true;
    if (append) renderTools();
    else renderResults();
    pageObserver.unobserve(sentinel);
    try {
      const query = {
        section: current.section,
        tab: current.tab,
        q: current.q,
        genre: current.genre,
        year: current.year,
        sort: current.sort,
        order: current.order,
        seed: current.seed,
        offset: append ? current.nextOffset : 0,
      };
      if (current.parent) query.parent = current.parent;
      if (current.collection) query.collection = current.collection;
      let data;
      if (!current.section && !current.parent && !current.collection && !sections.length)
        data = {
          items: [demoItem].filter(x => x.title.toLowerCase().includes(current.q.toLowerCase())),
          total: 1,
          nextOffset: null,
        };
      else data = await request('library.browse', scoped(query), controller.signal);
      if (version !== requestVersion || catalogVersion !== generation || current !== screen) return;
      // Use the complete child result, rather than the listing's season count.
      // A Specials folder counts as another season and keeps normal browsing.
      if (
        !append &&
        current.kind === 'show' &&
        !current.onlySeason &&
        !query.q &&
        !query.genre &&
        !query.year &&
        data.items.length === 1 &&
        data.items[0].type === 'season' &&
        data.nextOffset == null &&
        (data.total == null || data.total === 1)
      ) {
        current.onlySeason = data.items[0];
        current.parent = current.onlySeason.id;
        data = await request('library.browse', scoped({ ...query, parent: current.parent }), controller.signal);
      }
      if (version !== requestVersion || catalogVersion !== generation || current !== screen) return;
      const itemKey = x => (x.serverId || '') + ':' + x.id;
      const seen = new Set(append ? current.items.map(itemKey) : []),
        added = data.items.filter(x => {
          const k = itemKey(x);
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
      current.items = append ? [...current.items, ...added] : added;
      current.total = data.total;
      current.nextOffset = data.nextOffset;
      current.partial = !!data.partial;
      current.limited = !!data.limited;
      if (data.source) current.source = data.source;
      current.loading = false;
      if (append) {
        renderTools();
        added.forEach(tile);
        watchNextPage();
        setBusy(busy);
        void refreshRoomMedia();
      } else renderResults();
      renderBrowseStatus();
      void checkAvailability(added, current);
    } catch (error) {
      if (version !== requestVersion || catalogVersion !== generation || error.name === 'AbortError') return;
      current.loading = false;
      current.pageError = true;
      if (append) renderTools();
      else renderResults();
      signalError(error.message, () => void loadPage(append));
    }
  }
  // A page opened outside any library takes on its item's library, on the same server, as the current one.
  function adoptLibrary(current, full) {
    if (current.section || !full.section) return;
    const key = libraryKey({ id: full.section, serverId: current.server ?? full.serverId });
    const library = sections.find(section => libraryKey(section) === key);
    if (!library) return;
    current.section = library.id;
    current.library = library;
    current.server = library.serverId;
    renderTools();
  }
  const details = libraryDetails({
    doc,
    overview,
    node,
    button,
    picture,
    art,
    metadata,
    extras,
    runtime,
    playable,
    actions: {
      play: playButton,
      resume: resumeButton,
      queue: queueButton,
      suggest: suggestButton,
      bulk: bulkButton,
      auto: autoButton,
    },
    can: {
      queue: !!addToQueue,
      suggest: !!suggestMedia,
      bulk: !!addBulkToQueue,
      auto: !!autoQueue,
    },
    openItem: (...args) => openItem(...args),
    openParent: target => openParent(target),
  });
  const summary = item => details.render(item);
  async function getDetails(item, current) {
    detailController?.abort();
    detailController = new AbortController();
    const version = generation;
    try {
      const full =
        item.id === 'demo'
          ? demoItem
          : (await request('library.item', scoped({ item: item.id, type: item.type }), detailController.signal)).item;
      if (version !== generation || screen !== current) return;
      current.detail = full;
      current.detailsLoaded = true;
      adoptLibrary(current, full);
      summary(full);
      setBusy(busy);
      void refreshRoomMedia();
      void checkAvailability([full], current);
    } catch (error) {
      if (version === generation && screen === current && error.name !== 'AbortError')
        signalError('Details could not load. ' + error.message, () => void getDetails(item, current));
    }
  }
  // `outside`: opened from elsewhere (the queue), so not inside the library on screen; the item's own
  // server answers, and its library becomes current once its details say which it is.
  async function openItem(item, { outside = false } = {}) {
    prefetchArt(item);
    if (!screen) screen = homeContext();
    prepareNavigation();
    screen.focusItem = item.id;
    trail.push(screen);
    const from = outside ? homeContext() : screen;
    screen = {
      ...context(from.library, from.tab),
      title: item.title,
      kind: playable(item) ? 'details' : item.type,
      detail: item,
      sort: 'default',
    };
    if (!from.section && (item.serverId || from.server)) screen.server = item.serverId || from.server;
    if (outside) screen.outside = true;
    if (item.type === 'collection') screen.collection = item.id;
    else if (!playable(item)) screen.parent = item.id;
    pushVisit();
    renderResults();
    scroll.position();
    void getDetails(item, screen);
    if (!playable(item)) await loadPage();
  }
  // Going back to a show or season already on the way here restores it as it was left.
  function openParent(target) {
    const entry = [...trail]
      .reverse()
      .find(
        entry =>
          (entry.kind === target.type && entry.detail?.id === target.id) ||
          (target.type === 'season' && entry.onlySeason?.id === target.id),
      );
    if (entry) returnTo(entry);
    else void openItem(target);
  }
  function returnTo(entry) {
    const index = trail.indexOf(entry);
    if (index < 0) return;
    prepareNavigation();
    screen = entry;
    trail = trail.slice(0, index);
    pushVisit();
    restoreScreen(true);
  }
  function restoreScreen(reveal = false) {
    scroll.reserveHeight();
    screen.loading = false;
    renderResults();
    renderBrowseStatus();
    if (reveal) scroll.position();
    else if (screen.anchor?.id) scroll.restoreAnchor(screen.anchor);
    else {
      scroll.roomForScroll(screen.scroll);
      restoreScroll(screen.scroll);
    }
    const current = screen;
    requestAnimationFrame(() => {
      if (screen === current && current.focusItem)
        [...results.querySelectorAll('.library-tile')]
          .find(n => n.dataset.item === current.focusItem)
          ?.querySelector('.library-open')
          ?.focus({ preventScroll: true });
    });
    if (screen.detail && !screen.detailsLoaded) void getDetails(screen.detail, screen);
    else void checkAvailability(screen.detail ? [...screen.items, screen.detail] : screen.items, screen);
    if (!['details', 'home'].includes(screen.kind)) {
      if (screen.dirty) void query();
      else if (!screen.items.length && screen.total == null) void loadPage();
    }
  }
  async function fetchFacets(library) {
    const read = (facetRead = Symbol());
    filterSection = library;
    facetFailed = false;
    filterStatus.textContent = 'Loading filters…';
    for (const [control, label] of [
      [genre, 'All genres'],
      [year, 'All years'],
    ]) {
      control.replaceChildren();
      option(control, '', label);
      control.disabled = true;
    }
    if (!library) {
      filterStatus.textContent = '';
      return;
    }
    const version = generation;
    try {
      const value = await request('library.filters', scoped({ section: library.id }), catalogController.signal);
      if (version !== generation || read !== facetRead) return;
      for (const [control, values] of [
        [genre, value.genres],
        [year, value.years],
      ]) {
        values.forEach(x => option(control, x.id, x.title));
        control.disabled = false;
      }
      // A library with no genres (a local one) offers only the filters it has.
      genreLabel.hidden = !value.genres.length;
      filterStatus.textContent = '';
      renderTools();
    } catch (error) {
      if (version === generation && read === facetRead && error.name !== 'AbortError') {
        facetFailed = true;
        filterStatus.textContent = 'Filters unavailable. Reopen to retry.';
      }
    }
  }
  async function chooseLibrary(library, tab = 'library') {
    if (screen?.kind === 'library' && screen.library === library && screen.tab === tab) return;
    prepareNavigation();
    trail = [];
    const saved = homes.get(JSON.stringify([libraryKey(library), tab]));
    screen = saved || context(library, tab);
    pushVisit();
    if (saved) restoreScreen(true);
    else {
      renderResults();
      scroll.position();
      void loadPage();
    }
    if (filterSection !== library) void fetchFacets(library);
  }
  async function query() {
    clearTimeout(timer);
    screen.dirty = false;
    screen.items = [];
    screen.nextOffset = null;
    scroll.reserveHeight();
    const promise = loadPage();
    scroll.position();
    await promise;
  }
  previous.onclick = () => goHistory(-1);
  next.onclick = () => goHistory(1);
  home.onclick = goHome;
  search.oninput = () => {
    screen.q = search.value.trim();
    screen.dirty = true;
    clearTimeout(timer);
    if (screen.kind === 'home' && !screen.q) {
      screen.dirty = false;
      screen.items = [];
      screen.total = null;
      screen.nextOffset = null;
      screen.loading = false;
      screen.partial = false;
      screen.limited = false;
      screen.pageError = false;
      cancelReads();
      renderResults();
      return;
    }
    timer = setTimeout(() => void query(), 220);
  };
  sort.onchange = () => {
    screen.sort = sort.value;
    screen.order = ['added', 'year'].includes(screen.sort) ? 'desc' : 'asc';
    if (screen.sort === 'random') screen.seed = newSeed();
    void query();
  };
  direction.onclick = () => {
    if (screen.sort === 'random') screen.seed = newSeed();
    else screen.order = screen.order === 'asc' ? 'desc' : 'asc';
    void query();
  };
  genre.onchange = () => {
    screen.genre = genre.value;
    void query();
  };
  year.onchange = () => {
    screen.year = year.value;
    void query();
  };
  filterButton.onclick = () => {
    filters.hidden = !filters.hidden;
    filterButton.setAttribute('aria-expanded', String(!filters.hidden));
    filterButton.classList.toggle('filter-active', !filters.hidden || !!(screen.genre || screen.year));
    if (!filters.hidden && (screen.library !== filterSection || facetFailed)) void fetchFacets(screen.library);
  };
  viewButtons.forEach(
    b =>
      (b.onclick = () => {
        if (view === b.dataset.view) return;
        const anchor = scroll.captureAnchor();
        scroll.reserveHeight();
        view = b.dataset.view;
        try {
          localStorage.setItem('uburoom-library-view', view);
        } catch {}
        renderResults(true);
        scroll.restoreAnchor(anchor);
      }),
  );
  async function resolveLink(rawUrl) {
    if (!catalog) return;
    const url = String(rawUrl || '').trim();
    if (!url) {
      linkStatus.textContent = 'Paste a YouTube video or playlist link first.';
      linkInput.focus();
      return;
    }
    linkController?.abort();
    linkController = new AbortController();
    const resolveId = ++linkResolveVersion;
    const catalogVersion = generation;
    linkSubmit.disabled = true;
    linkClear.hidden = false;
    linkStatus.textContent = 'Resolving YouTube link…';
    linkResults.replaceChildren();
    try {
      const data = await request('library.resolve', scoped({ url }), linkController.signal);
      if (resolveId !== linkResolveVersion || catalogVersion !== generation) return;
      if (data.kind === 'playlist') {
        const plTitle = data.title || 'YouTube playlist';
        linkStatus.textContent =
          plTitle + ' · ' + (data.items?.length || 0) + (data.items?.length === 1 ? ' video' : ' videos');
        const bar = node('div', linkResults, undefined, 'library-link-playlist');
        const info = node('div', bar, undefined, 'library-link-playlist-info');
        node('strong', info, plTitle);
        if (data.channelTitle) node('span', info, data.channelTitle, 'hint');
        if (data.items?.length && addBulkToQueue && canAddQueue()) {
          const section = screen?.library;
          const bulkBtn = button(bar, 'Add playlist to queue', 'queue', 'primary library-queue-add');
          bulkBtn.dataset.queue = data.id;
          bulkBtn.dataset.queueItem = 'true';
          bulkBtn.append(node('span', null, `Add all ${data.items.length} to queue`));
          bulkBtn.onclick = () => {
            if (!bulkBtn.disabled) {
              void addBulkToQueue(
                {
                  id: data.id,
                  type: 'playlist',
                  title: plTitle,
                  serverId: data.items[0]?.serverId || section?.serverId || screen?.server,
                },
                bulkBtn,
              );
            }
          };
        }
        const grid = node('div', linkResults, undefined, 'library-link-grid library');
        for (const item of data.items || []) tile(item, { parent: grid, shape: 'landscape' });
      } else if (data.kind === 'video' && data.item) {
        linkStatus.textContent = '';
        const grid = node('div', linkResults, undefined, 'library-link-grid library');
        tile(data.item, { parent: grid, shape: 'landscape' });
        if (data.playlist?.url) {
          const rowHint = node('div', linkResults, undefined, 'library-link-playlist-hint');
          const plBtn = button(rowHint, 'Load full playlist', 'queue', 'quiet');
          plBtn.append(node('span', null, 'This link includes a playlist — load playlist instead'));
          plBtn.onclick = () => {
            linkInput.value = data.playlist.url;
            void resolveLink(data.playlist.url);
          };
        }
      } else {
        linkStatus.textContent = 'Could not resolve that YouTube link.';
      }
      setBusy(busy);
    } catch (err) {
      if (resolveId !== linkResolveVersion || catalogVersion !== generation || err.name === 'AbortError') return;
      linkStatus.textContent = err.message || 'Could not resolve YouTube link.';
    } finally {
      if (resolveId === linkResolveVersion) linkSubmit.disabled = false;
    }
  }
  linkForm.addEventListener('submit', event => {
    event.preventDefault();
    void resolveLink(linkInput.value);
  });
  linkInput.addEventListener('input', () => {
    linkClear.hidden = !linkInput.value.trim() && !linkResults.childElementCount && !linkStatus.textContent;
  });
  linkClear.addEventListener('click', () => {
    linkController?.abort();
    linkResolveVersion++;
    linkInput.value = '';
    linkStatus.textContent = '';
    linkResults.replaceChildren();
    linkClear.hidden = true;
    linkSubmit.disabled = false;
    linkInput.focus();
  });
  retry.onclick = () => errorAction?.();
  let initialData = initialLibrary;
  async function setCatalog(account, guestRoom) {
    if (catalog?.account === account && catalog?.guestRoom === guestRoom) return;
    cancelAvailability();
    catalog = account ? { account, guestRoom } : undefined;
    room = undefined;
    roomRead?.abort();
    roomRead = roomData = undefined;
    roomReadAt = 0;
    roomChecked.clear();
    roomProgressRows.clear();
    progressFor = libraryProgress();
    generation++;
    requestVersion++;
    controller?.abort();
    detailController?.abort();
    linkController?.abort();
    linkResolveVersion++;
    clearTimeout(timer);
    catalogController?.abort();
    catalogController = new AbortController();
    shelfData = null;
    shelfRead = undefined;
    shelfAt = 0;
    shelves.clear();
    pictures.reset();
    homes.clear();
    sections = [];
    trail = [];
    screen = undefined;
    playing = undefined;
    testVideo = false;
    screen = homeContext();
    if (catalog) beginHistory();
    else historyEpoch = undefined;
    pageObserver.unobserve(sentinel);
    sentinel.hidden = true;
    host.style.minHeight = '';
    clearResults();
    landing.replaceChildren();
    landing.hidden = true;
    overview.replaceChildren();
    overview.hidden = true;
    choices.clear();
    chips.dataset.signature = '';
    chips.replaceChildren();
    chips.hidden = true;
    row.hidden = true;
    linkBar.hidden = true;
    linkInput.value = '';
    linkStatus.textContent = '';
    linkResults.replaceChildren();
    linkClear.hidden = true;
    linkSubmit.disabled = false;
    results.hidden = true;
    scopeActions.dataset.signature = '';
    scopeActions.replaceChildren();
    scopeActions.hidden = true;
    sort.dataset.signature = '';
    resetStatus();
    count.hidden = !catalog;
    count.textContent = catalog ? 'Loading libraries…' : '';
    tools.hidden = !catalog;
    navigationControls.forEach(n => {
      n.disabled = true;
    });
    direction.disabled = true;
    previous.disabled = next.disabled = true;
    genre.replaceChildren();
    year.replaceChildren();
    search.value = '';
    filterSection = undefined;
    filterStatus.textContent = '';
    filters.hidden = true;
    filterButton.classList.remove('filter-active');
    const bootstrap = initialData;
    initialData = undefined;
    if (!catalog) return;
    if (!guestRoom && account === initialAccount && bootstrap) {
      const data = bootstrap;
      sections = data.items || [];
      testVideo = !!data.testVideo;
      renderResults();
      saveVisit();
      return;
    }
    const version = generation;
    async function start() {
      try {
        if (version !== generation) return;
        const data = await request('library.browse', {}, catalogController.signal);
        if (version !== generation) return;
        sections = data.items;
        testVideo = !!data.testVideo;
        renderResults();
        saveVisit();
      } catch (error) {
        if (version === generation && error.name !== 'AbortError') signalError(error.message, () => void start());
      }
    }
    await start();
  }
  if (initialData && initialAccount) void setCatalog(initialAccount);
  return {
    setCatalog,
    setRoom,
    setBusy,
    openItem,
    reveal: behavior => scroll.position(behavior),
    refreshSuggestions: syncSuggestions,
    refreshShelves: () => {
      void refreshRoomMedia();
      if (screen?.kind === 'home') loadShelves();
    },
    /** Admin mode shows or hides the sync test video's card on Libraries home. */
    refreshAdmin: () => {
      if (screen?.kind !== 'home' || !testVideo) return;
      const existing = landing.querySelector('[data-play="demo"]')?.closest('.library-home-item');
      if (isAdmin() && !existing) {
        const { open } = homeCard(SYNC_CARD);
        open.dataset.action = 'play';
        open.dataset.play = 'demo';
        open.onclick = () => void play(demoItem);
        setBusy(busy);
      } else if (!isAdmin() && existing) {
        existing.remove();
      }
    },
  };
}
export { mount, homeCards, SYNC_CARD };
