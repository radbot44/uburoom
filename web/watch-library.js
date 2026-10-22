/* One safe-DOM Plex browser for the website, fullscreen drawer and Activity. */
(function (global) {
  'use strict';
  function mount(host, { request, artwork, load, close, getPlayer, addToQueue, addBulkToQueue, autoQueue, isAdmin = () => false, openCodecTester }) {
    const doc = host.ownerDocument;
    function node(tag, parent, text, className) { const n = doc.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; parent?.append(n); return n; }
    function button(parent, label, symbol, className = 'library-key') {
      const b = node('button',parent,undefined,className); b.type = 'button'; b.setAttribute('aria-label',label); b.title = label;
      if (symbol) b.append(uburoomIcons.icon(doc,symbol)); return b;
    }
    function option(select, value, label) { const n = node('option',select,label); n.value = value; }
    function select(parent, label) { const s = node('select',parent); s.setAttribute('aria-label',label); return s; }
    const header = doc.getElementById('library-header') || host.closest('#library-panel')?.querySelector('.library-header');
    const controls = global.uburoomControls;
    header?.classList.add('watch-panel-header');
    header?.querySelector('h2')?.classList.add('watch-panel-heading');
    const headerLeft = doc.getElementById('library-header-left') || header?.querySelector('.library-header-left');
    const headerRight = doc.getElementById('library-header-right') || header?.querySelector('.library-header-right');
    const scopeActions = node('div',headerRight || host,undefined,'library-scope-actions');
    scopeActions.hidden = true;
    const topWrap = headerRight?.querySelector('.library-top');
    if (topWrap) headerRight.insertBefore(scopeActions,topWrap);
    if (topWrap) controls.content(topWrap.querySelector('button'),{label:'Back to top',icon:'arrow-bar-to-up'});
    const navParent = headerLeft || host;
    const historyGroup = node('div',navParent,undefined,'library-navigation-history watch-control-group watch-header-actions');
    historyGroup.setAttribute('role','group'); historyGroup.setAttribute('aria-label','Navigation');
    const previous = button(historyGroup,'Back','left','library-key'); previous.id = 'library-back';
    const next = button(historyGroup,'Forward','right','library-key'); next.id = 'library-forward';
    const home = button(historyGroup,'Libraries home','home','library-key'); home.id = 'library-home';
    for (const [control,label,icon] of [[previous,'Back','left'],[next,'Forward','right'],[home,'Libraries home','home']]) {
      controls.content(control,{label,icon,iconOnly:true}); control.classList.add('watch-control-solid-disabled');
    }
    const choices = node('div',navParent,undefined,'library-choices watch-segmented watch-segmented-view'); choices.setAttribute('role','group'); choices.setAttribute('aria-label','Libraries');
    const crumbs = node('nav',navParent,undefined,'library-crumbs'); crumbs.setAttribute('aria-label','Library location');
    const tools = node('div',host,undefined,'library-tools');
    const row = node('div',tools,undefined,'library-toolbar watch-toolbar');
    const searchField = node('label',row,undefined,'search-field');
    searchField.append(uburoomIcons.icon(doc,'search'));
    const search = node('input',searchField); search.type = 'search'; search.id = 'search'; search.placeholder = 'Search this library'; search.setAttribute('aria-label','Search this library'); search.maxLength = 200;
    const toolControls = node('div',row,undefined,'tool-controls watch-control-group');
    const sortWrap = node('div',toolControls,undefined,'sort-wrap');
    const sort = select(sortWrap,'Sort library'); sort.id = 'library-sort';
    sortWrap.append(uburoomIcons.icon(doc,'chevron'));
    const direction = button(toolControls,'Ascending','sort','library-key library-direction'); direction.id = 'library-direction';
    controls.content(direction,{label:'Ascending',icon:'sort',iconOnly:true}); direction.classList.add('watch-control-solid-disabled');
    const filterHolder = node('div',toolControls,undefined,'filter-holder');
    const filterButton = button(filterHolder,'Filters','filter','library-key watch-control watch-control-responsive watch-control-solid-disabled'); filterButton.id = 'library-filters-toggle'; filterButton.append(node('span',null,'Filters','filter-label watch-control-label')); filterButton.setAttribute('aria-expanded','false'); filterButton.setAttribute('aria-controls','library-filters');
    const views = node('div',toolControls,undefined,'library-views view-switch watch-segmented watch-segmented-view'); views.setAttribute('role','group'); views.setAttribute('aria-label','Library view');
    const viewButtons = ['cards','list','posters'].map(view => {
      const b = button(views,view[0].toUpperCase() + view.slice(1),'library' + view[0].toUpperCase() + view.slice(1),'library-key group-button'); b.dataset.view = view;
      b.append(node('span',null,view[0].toUpperCase() + view.slice(1))); return b;
    });
    controls.segmented(views);
    const filters = node('div',tools,undefined,'library-filters'); filters.id = 'library-filters'; filters.hidden = true;
    const genreLabel = node('label',filters,'Genre'); const genre = select(genreLabel,'Genre');
    const yearLabel = node('label',filters,'Year'); const year = select(yearLabel,'Year');
    const filterStatus = node('span',filters,undefined,'hint');
    const chips = node('div',tools,undefined,'library-filter-chips');
    const count = node('p',tools,'','library-count'); count.setAttribute('role','status'); count.setAttribute('aria-live','polite');
    const overview = node('div',host,undefined,'library-overview'); overview.hidden = true;
    const results = node('div',host,undefined,'library'); results.id = 'library';
    const footer = node('div',host,undefined,'library-footer');
    const note = node('p',footer,'','hint'); note.id = 'library-note'; note.setAttribute('role','status'); note.setAttribute('aria-live','polite');
    const retry = button(footer,'Retry','refresh'); retry.append(node('span',null,'Retry')); retry.hidden = true;
    controls.content(retry,{label:'Retry',icon:'refresh'});
    const sentinel = node('div',host,undefined,'library-sentinel'); sentinel.setAttribute('aria-hidden','true'); sentinel.hidden = true;
    const landing = node('div',host,undefined,'library-landing'); landing.hidden = true;
    overview.before(landing);
    const navigationControls = [home,search,sort,filterButton,...viewButtons];
    let room, generation = 0, controller, detailController, imageController, imageObserver, activeImages = 0, imageQueue = [], timer, busy = false, playing;
    let sections = [], trail = [], screen, filterSection, facetFailed = false, requestVersion = 0, errorAction, testVideo = false;
    let visits = [], visitIndex = 0, historyEpoch, historyMoving = false;
    const homes = new Map(), images = new Map();
    let view = 'cards'; try { const saved = localStorage.getItem('uburoom-library-view'); if (['cards','list','posters'].includes(saved)) view = saved; } catch {}
    const demoItem = { id:'demo',type:'demo',title:'uburoom synchronization test',duration:60,summary:'A short picture and sound sample for checking shared playback.' };
    function context(section, tab = 'library') { return { section,tab,title:sections.find(x => x.id === section)?.title || 'Test video',kind:'library',q:'',genre:'',year:'',sort:'title',order:'asc',seed:newSeed(),items:[],total:null,nextOffset:null,scroll:0,minHeight:0 }; }
    function homeContext() { return {...context(),title:'Libraries',kind:'home'}; }
    // Browser history holds only opaque indices. Private catalog data remains in
    // room-scoped memory, and is discarded when viewing eligibility changes.
    function historyState(index = visitIndex) { return {...history.state,uburoomLibrary:{epoch:historyEpoch,index}}; }
    function saveVisit() { if (screen) visits[visitIndex] = {screen,trail:[...trail]}; }
    function beginHistory() {
      historyEpoch = newSeed(); visits = []; visitIndex = 0; historyMoving = false;
      history.scrollRestoration = 'manual';
      // A root guard keeps an ordinary mouse/browser Back at Home on /watch.
      history.replaceState(historyState(-1),''); history.pushState(historyState(0),''); saveVisit();
    }
    function pushVisit() { visits = visits.slice(0,visitIndex + 1); visitIndex++; saveVisit(); history.pushState(historyState(),''); }
    function cancelReads() { clearTimeout(timer); controller?.abort(); detailController?.abort(); requestVersion++; resetStatus(); }
    function saveHome() {
      const root = [...trail,screen].find(x => x?.kind === 'library');
      if (root?.section) homes.set(root.section + ':' + root.tab,root);
    }
    function prepareNavigation() { rememberScroll(); saveVisit(); saveHome(); cancelReads(); reserveHeight(); }
    function goHistory(delta) { if (historyMoving || !room || visitIndex + delta < 0 || visitIndex + delta >= visits.length) return; historyMoving = true; history.go(delta); }
    window.addEventListener('popstate',event => {
      const entry = event.state?.uburoomLibrary;
      if (!historyEpoch) return;
      if (entry?.epoch === historyEpoch && entry.index === -1) { history.go(1); return; }
      if (entry?.epoch !== historyEpoch || !visits[entry.index]) { history.replaceState(historyState(),''); historyMoving = false; return; }
      rememberScroll(); saveVisit(); saveHome(); cancelReads(); visitIndex = entry.index;
      ({screen,trail} = visits[visitIndex]); historyMoving = false;
      if (!room || !screen) return;
      restoreScreen();
      if (screen.section && screen.section !== filterSection) void fetchFacets(screen.section);
    });
    function goHome() {
      if (!room || screen.kind === 'home') return;
      prepareNavigation(); screen = homeContext(); trail = []; pushVisit(); renderResults(); positionLibrary();
    }
    function newSeed() { return crypto.randomUUID().replace(/-/g,''); }
    function clearResults() { results.replaceChildren(); }
    const layoutObserver = new ResizeObserver(entries => {
      const updates = [];
      for (const {target} of entries) {
        if (target === host) {
          // Match the Cards/Posters grid, including its two-column phone layout.
          const width = host.getBoundingClientRect().width; if (!width) continue;
          const gap = width <= 440 ? 12 : 14, columns = width <= 440 ? 2 : Math.max(1,Math.floor((width + gap) / (160 + gap)));
          updates.push([host,'--library-poster-width',(width - gap * (columns - 1)) / columns + 'px']);
        }
        if (target === header) updates.push([header.parentElement,'--media-header-height',header.offsetHeight + 'px']);
      }
      // Batch writes after measurements so loaded rows do not each force layout.
      for (const [target,property,value] of updates) if (target.style.getPropertyValue(property) !== value) target.style.setProperty(property,value);
    });
    layoutObserver.observe(host);
    if (header) layoutObserver.observe(header);
    function measureHeader() {
      if (header) header.parentElement.style.setProperty('--media-header-height',header.offsetHeight + 'px');
    }
    function scrollElement() {
      const drawer = host.closest('#drawer'); if (drawer) return drawer;
      const panel = host.closest('#library-panel');
      return panel && getComputedStyle(panel).overflowY === 'auto' ? panel : document.scrollingElement;
    }
    function viewport(root = scrollElement()) { const top = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top + root.clientTop; return {top,bottom:top + root.clientHeight}; }
    function captureAnchor() {
      const root = scrollElement(), box = viewport(root), top = Math.max(box.top,tools.getBoundingClientRect().bottom);
      const item = [...results.querySelectorAll('.library-tile')].find(n => { const b = n.getBoundingClientRect(); return b.bottom > top && b.top < box.bottom; });
      return {id:item?.dataset.item,offset:item ? item.getBoundingClientRect().top - top : 0,scroll:root.scrollTop};
    }
    function rememberScroll() { if (screen) { screen.scroll = scrollElement().scrollTop; screen.anchor = captureAnchor(); } }
    function reserveHeight() { host.style.minHeight = Math.max(host.getBoundingClientRect().height,scrollElement().clientHeight) + 'px'; }
    function roomForScroll(desired) {
      const root = scrollElement(), box = viewport(root), rect = host.getBoundingClientRect(), hostTop = root.scrollTop + rect.top - box.top;
      const end = Math.max(footer.getBoundingClientRect().bottom,landing.hidden ? 0 : landing.getBoundingClientRect().bottom,sentinel.hidden ? 0 : sentinel.getBoundingClientRect().bottom);
      screen.minHeight = Math.ceil(Math.max(0,end - rect.top + 8,desired + root.clientHeight - hostTop));
      host.style.minHeight = screen.minHeight + 'px';
    }
    function restoreAnchor(anchor) {
      const root = scrollElement(), item = anchor.id && [...results.querySelectorAll('.library-tile')].find(n => n.dataset.item === anchor.id);
      let desired = anchor.scroll;
      if (item) { const b = item.getBoundingClientRect(), top = Math.max(viewport(root).top,tools.getBoundingClientRect().bottom); const offset = Math.max(anchor.offset,-Math.max(0,b.height - 44)); desired = Math.max(0,root.scrollTop + b.top - top - offset); }
      roomForScroll(desired); root.scrollTop = desired;
    }
    function restoreScroll(value) { const current = screen, version = generation; requestAnimationFrame(() => { if (room && screen === current && generation === version) scrollElement().scrollTop = value; }); }
    function positionLibrary(behavior = 'instant') {
      const root = scrollElement(), box = viewport(root), rect = host.getBoundingClientRect();
      const contentTop = Math.max(box.top,header?.getBoundingClientRect().bottom || box.top,tools.hidden ? box.top : tools.getBoundingClientRect().bottom);
      const visible = [...host.querySelectorAll('.library-tile,.library-home-card,.library-overview')].some(item => {
        const bounds = item.getBoundingClientRect();
        return bounds.width > 0 && bounds.height > 0 && bounds.bottom > contentTop && bounds.top < box.bottom;
      });
      if (visible || (rect.top >= box.top && rect.top < box.bottom)) return;
      // The content host starts after the header. Aligning it to the viewport
      // would put the first row underneath that sticky header.
      const panel = host.closest('#library-panel') || host;
      const desired = Math.max(0,root.scrollTop + panel.getBoundingClientRect().top - box.top);
      roomForScroll(desired);
      root.scrollTo({top:desired,behavior});
    }
    const pageObserver = new IntersectionObserver(entries => {
      if (entries.some(x => x.isIntersecting) && room && screen?.kind !== 'details' && screen?.kind !== 'home' && screen?.nextOffset != null && !screen.loading && !screen.pageError) void loadPage(true);
    }, {rootMargin:'320px 0px'});
    function watchNextPage() {
      pageObserver.unobserve(sentinel); sentinel.hidden = !screen || ['details','home'].includes(screen.kind) || screen.nextOffset == null;
      if (!sentinel.hidden && !screen.loading && !screen.pageError) pageObserver.observe(sentinel);
    }
    function endpoint(path, query = {}) { return path + '?' + new URLSearchParams({...(room === 'lobby' ? {} : {room}),...query}); }
    function playable(item) { return ['movie','episode','demo'].includes(item.type); }
    function identity(item) { return item.title + (item.edition ? ' · ' + item.edition : ''); }
    function runtime(seconds) { const minutes = Math.round(seconds / 60); return minutes >= 60 ? Math.floor(minutes / 60) + 'h ' + minutes % 60 + 'm' : minutes + 'm'; }
    function metadata(item) {
      if (item.type === 'collection') return (item.count || item.episodeCount || 0) + ' items';
      if (item.type === 'season') return (item.episodeCount || item.count || 0) + ' episodes';
      return [item.type === 'episode' ? (Number.isInteger(item.index) ? 'Episode ' + item.index : '') : item.endYear && item.endYear !== item.year ? item.year + '–' + item.endYear : item.year,
        item.type === 'show' ? (item.count ? item.count + (item.count === 1 ? ' season' : ' seasons') : '') : item.duration ? runtime(item.duration) : '',item.edition].filter(Boolean).join(' · ');
    }
    function clearImages() {
      imageController?.abort(); imageObserver?.disconnect(); imageQueue = []; activeImages = 0;
      for (const value of images.values()) URL.revokeObjectURL(value); images.clear();
      imageController = new AbortController();
      imageObserver = new IntersectionObserver(entries => { for (const entry of entries) if (entry.isIntersecting) { imageObserver.unobserve(entry.target); imageQueue.push(entry.target); } pumpImages(); }, {rootMargin:'180px'});
    }
    function pumpImages() {
      const version = generation, signal = imageController.signal;
      while (activeImages < 4 && imageQueue.length) {
        const img = imageQueue.shift(); if (!img.isConnected || img.src) continue;
        const key = img.dataset.item + ':' + img.dataset.kind;
        if (images.has(key)) { img.src = images.get(key); continue; }
        activeImages++;
        artwork(endpoint('/api/watch/library/art',{item:img.dataset.item,kind:img.dataset.kind,type:img.dataset.type}),signal)
          .then(blob => {
            if (version !== generation || signal.aborted) return;
            const url = URL.createObjectURL(blob), old = images.get(key); if (old) URL.revokeObjectURL(old);
            images.set(key,url); while (images.size > 160) { const first = images.keys().next().value; URL.revokeObjectURL(images.get(first)); images.delete(first); }
            if (img.isConnected) img.src = url;
          }).catch(() => {}).finally(() => { if (version === generation) { activeImages--; pumpImages(); } });
      }
    }
    function art(parent,item,landscape = false) {
      const box = node('div',parent,undefined,'library-art' + (landscape ? ' landscape' : ''));
      const fallback = node('span',box,undefined,'library-art-fallback'); fallback.append(uburoomIcons.icon(doc,['show','season','episode'].includes(item.type) ? 'tv' : 'film')); node('span',fallback,item.title);
      if (landscape ? item.hasLandscape : item.hasPoster) {
        const img = node('img',box); img.alt = ''; img.decoding = 'async'; img.dataset.item = item.id; img.dataset.kind = landscape ? 'landscape' : 'poster'; img.dataset.type = item.type;
        img.addEventListener('load',() => { box.classList.add('loaded'); });
        const key = item.id + ':' + img.dataset.kind; if (images.has(key)) img.src = images.get(key); else imageObserver.observe(img);
      }
      if (item.available === false) { box.classList.add('unavailable'); node('span',box,'Unavailable','library-unavailable'); }
      return box;
    }
    function signalError(message, action) { note.textContent = message; note.classList.add('library-error'); retry.hidden = false; errorAction = action; }
    function resetStatus() { note.textContent = ''; note.classList.remove('library-error'); retry.hidden = true; errorAction = undefined; }
    function canAddQueue() {
      const p = getPlayer?.();
      return !!p?.durable && (p?.capabilities ? !!p.capabilities.addQueue : true);
    }
    function setBusy(value) {
      busy = value;
      const root = host.closest('#library-panel') || host;
      for (const b of root.querySelectorAll('[data-play]')) b.disabled = b.dataset.unavailable === 'true' || busy || !!playing || !room;
      for (const b of root.querySelectorAll('[data-queue]')) b.disabled = b.dataset.unavailable === 'true' || busy || !room || !canAddQueue();
      for (const b of root.querySelectorAll('[data-auto-queue]')) b.disabled = busy || !room || !getPlayer()?.capabilities?.editQueue;
    }
    async function play(item) {
      if (item.available === false || busy || playing || !room) return;
      const version = generation; playing = item.id; setBusy(busy); resetStatus(); note.textContent = 'Loading ' + identity(item) + '…';
      try {
        const result = await load(item);
        if (version !== generation) return;
        if (result?.status === 'cancelled') { note.textContent = ''; return; }
        if (result?.status !== 'applied') throw new Error('Playback was not accepted; try again.');
        note.textContent = ''; close();
      } catch (error) { if (version === generation) signalError(error.message,() => play(item)); }
      finally { if (version === generation) { playing = undefined; setBusy(busy); } }
    }
    function playButton(parent,item,large = false) {
      const b = button(parent,'Play ' + identity(item),'play',large ? 'library-play-now' : 'library-play'); b.dataset.play = item.id; b.dataset.action = 'play';
      b.dataset.unavailable = String(item.available === false); b.disabled = item.available === false;
      if (large) b.append(node('span',null,'Play now')); b.addEventListener('click',() => void play(item)); return b;
    }
    function queueButton(parent, item, large = false) {
      const b = button(parent, 'Add ' + identity(item) + ' to queue', 'queue', large ? 'library-queue-add library-play-now' : 'library-queue-add');
      b.dataset.unavailable = String(item.available === false);
      b.dataset.queue = item.id; b.disabled = b.dataset.unavailable === 'true' || busy || !room || !canAddQueue();
      if (large) b.append(node('span', null, 'Add to queue'));
      b.addEventListener('click', async event => {
        event.stopPropagation();
        if (b.disabled || !addToQueue) return;
        b.disabled = true;
        try {
          await addToQueue(item);
          const span = b.querySelector('span');
          if (span) span.textContent = 'Added!';
          note.textContent = 'Added ' + identity(item) + ' to queue.';
          setTimeout(() => {
            if (span) span.textContent = 'Add to queue';
            b.disabled = b.dataset.unavailable === 'true' || busy || !room || !canAddQueue();
          }, 1500);
        } catch (error) {
          signalError(error.message, () => b.click());
          b.disabled = b.dataset.unavailable === 'true' || busy || !room || !canAddQueue();
        }
      });
      return b;
    }
    function bulkButton(parent, item) {
      const label = 'Add ' + (item.type === 'season' ? 'season' : 'show') + ' to queue';
      const b = button(parent, label, 'queue', 'library-queue-add library-play-now');
      b.dataset.queue = item.id;
      b.append(node('span', null, label));
      b.onclick = () => { if (!b.disabled) void addBulkToQueue(item); };
      return b;
    }
    function autoButton(parent, scope, title) {
      const b = button(parent, 'Random auto-queue from ' + title, 'shuffle', 'queue-control');
      if (parent === scopeActions) b.classList.add('watch-control','watch-control-responsive','watch-control-solid-disabled');
      b.dataset.autoQueue = scope.id;
      node('span', b, 'Random auto-queue', 'queue-label watch-control-label');
      b.onclick = () => { if (!b.disabled) autoQueue({ scope, title }); };
      return b;
    }
    function extras(parent,item,full = false) {
      if (item.available !== false && !item.contentRating && !item.genres?.length) return;
      const line = node('div',parent,undefined,'library-extras');
      if (item.available === false) node('span',line,'Unavailable');
      if (item.contentRating) node('span',line,item.contentRating,'library-rating');
      if (item.genres?.length) node('span',line,(full ? item.genres : item.genres.slice(0,2)).join(' · '));
    }
    function tile(item) {
      const episode = item.type === 'episode', row = episode || view === 'list';
      const card = node('article',results,undefined,'library-tile' + (episode ? ' episode' : '')); card.dataset.item = item.id; card.classList.toggle('unavailable',item.available === false);
      if (row) {
        card.classList.add('library-row');
        card.addEventListener('click',event => {
          if (event.target.closest('button,a,input,select,textarea,summary')) return;
          const selection = doc.getSelection(); if (selection?.toString() && card.contains(selection.anchorNode)) return;
          void openItem(item);
        });
      }
      const picture = art(card,item,episode), open = button(picture,'View ' + identity(item),'', 'library-open');
      open.addEventListener('click',() => {
        if (view === 'posters' && !episode && matchMedia('(hover: none)').matches && !card.classList.contains('revealed')) {
          results.querySelectorAll('.revealed').forEach(n => n.classList.remove('revealed')); card.classList.add('revealed'); return;
        }
        void openItem(item);
      });
      const copy = node('div',card,undefined,'library-copy');
      const title = button(copy,'View ' + identity(item),undefined,'library-title'); title.textContent = item.title; title.addEventListener('click',() => void openItem(item));
      node('p',copy,metadata(item),'library-meta');
      if (row) { extras(copy,item); if (episode && item.summary) node('p',copy,item.summary,'library-episode-summary'); }
      if (playable(item)) {
        if (row) {
          const actions = node('div', card, undefined, 'library-row-actions');
          playButton(actions, item);
          if (addToQueue && getPlayer()?.durable) queueButton(actions, item);
        } else {
          playButton(picture, item);
          if (addToQueue && getPlayer()?.durable) queueButton(picture, item);
        }
      } else {
        const target = row ? node('div', card, undefined, 'library-row-actions') : picture;
        const b = button(target, 'Browse ' + item.title, 'right', 'library-browse');
        b.addEventListener('click', () => void openItem(item));
      }
    }
    function summary(item) {
      overview.replaceChildren(); overview.hidden = !item;
      if (!item) return;
      const episode = item.type === 'episode';
      const top = node('div',overview,undefined,'library-detail-top' + (episode ? ' episode-detail' : item.type === 'movie' ? ' movie-detail' : ''));
      const pictures = node('div',top,undefined,'library-detail-art'); art(pictures,item,episode);
      const copy = node('div',top,undefined,'library-detail-copy'); node('h3',copy,item.title); node('p',copy,metadata(item),'library-meta'); extras(copy,item,true);
      if (playable(item)) {
        const actionRow = node('div', copy, undefined, 'library-detail-actions');
        playButton(actionRow, item, true);
        if (addToQueue && getPlayer()?.durable) queueButton(actionRow, item, true);
        const warning = node('p',copy,'','library-replace'); warning.textContent = getPlayer()?.mediaId ? 'Replaces the current video for everyone.' : '';
      } else if (getPlayer()?.durable) {
        const actionRow = node('div', copy, undefined, 'library-detail-actions');
        if (addBulkToQueue && ['show', 'season'].includes(item.type)) bulkButton(actionRow, item);
        if (autoQueue && ['show', 'collection'].includes(item.type)) autoButton(actionRow, { type: item.type, id: item.id }, item.title);
      }
      const body = node('div',copy,undefined,'library-detail-body');
      if (item.summary) node('p',body,item.summary,'library-summary');
      const rows = [];
      if (item.directors?.length) rows.push(['Director',item.directors.join(', ')]);
      if (item.cast?.length) rows.push(['Cast',item.cast.join(', ')]);
      if (item.ratings?.length) rows.push(['Ratings',item.ratings.map(r => r.source + ' ' + (r.source.startsWith('Rotten Tomatoes') ? Math.round(r.value * 10) + '%' : r.value.toFixed(1) + '/10')).join(' · ')]);
      if (rows.length) {
        const facts = node('dl',body,undefined,'library-facts');
        for (const [label,value] of rows) { node('dt',facts,label); node('dd',facts,value); }
      }
      if (item.mediaInfo?.length) { const info = node('details',body,undefined,'library-media-info'); node('summary',info,'Media info'); node('p',info,item.mediaInfo.join(' · '),'library-credit'); }
    }
    function renderTools() {
      if (!screen) return;
      navigationControls.forEach(n => { n.disabled = false; });
      previous.disabled = visitIndex === 0; next.disabled = visitIndex >= visits.length - 1;
      home.disabled = screen.kind === 'home';
      previous.title = previous.disabled ? 'No earlier Media page.' : 'Back';
      next.title = next.disabled ? 'No later Media page.' : 'Forward';
      home.title = home.disabled ? 'Already at Libraries home.' : 'Libraries home';
      const focusedSection = choices.contains(doc.activeElement) ? doc.activeElement.dataset.section : null;
      choices.replaceChildren(); choices.hidden = screen.kind === 'home';
      sections.forEach(section => { const b = button(choices,section.title,undefined,'library-key library-choice group-button'); b.textContent = section.title; b.dataset.section = section.id; b.setAttribute('aria-pressed',String(section.id === screen.section)); b.onclick = () => void chooseLibrary(section.id,screen.tab); });
      controls.segmented(choices);
      if (focusedSection) [...choices.querySelectorAll('button')].find(b => b.dataset.section === focusedSection)?.focus();
      crumbs.replaceChildren();
      const path = [{title:'Libraries',action:goHome}];
      if (screen.section) path.push({title:sections.find(x => x.id === screen.section)?.title || screen.title,action:() => void chooseLibrary(screen.section,screen.tab)});
      if (screen.tab === 'collections') path.push({title:'Collections',action:() => void chooseLibrary(screen.section,'collections')});
      const all = [...trail,screen].filter(x => !['library','home'].includes(x.kind));
      all.forEach((entry,index) => {
        path.push({title:entry.title,action:() => navigateCrumb(entry)});
        if (entry.onlySeason && index < all.length - 1) path.push({title:entry.onlySeason.title,action:() => navigateCrumb(entry)});
      });
      path.forEach((entry,index) => {
        if (index) node('span',crumbs,'›','library-crumb-divider');
        if (index === path.length - 1) { const n = node('span',crumbs,entry.title); n.setAttribute('aria-current','page'); }
        else { const b = button(crumbs,entry.title,undefined,'library-crumb'); b.textContent = entry.title; b.onclick = entry.action; }
      });
      crumbs.hidden = path.length <= 2;
      const details = screen.kind === 'details', atHome = screen.kind === 'home', collectionIndex = screen.kind === 'library' && screen.tab === 'collections';
      choices.hidden = atHome;
      scopeActions.replaceChildren();
      const section = sections.find(item => item.id === screen.section);
      scopeActions.hidden = !autoQueue || !getPlayer()?.durable || screen.kind !== 'library' || screen.tab !== 'library' || section?.mediaType !== 'movie';
      if (!scopeActions.hidden) autoButton(scopeActions, { type: 'library', id: section.id }, section.title);
      row.hidden = details || atHome; chips.hidden = details || atHome;
      filterButton.hidden = !screen.section || collectionIndex || ['show','season'].includes(screen.kind);
      filterButton.classList.toggle('filter-active',!filters.hidden || !!(screen.genre || screen.year));
      const filterSpan = filterButton.querySelector('.filter-label');
      if (filterSpan) filterSpan.textContent = (screen.genre || screen.year) ? 'Filters (' + ((screen.genre ? 1 : 0) + (screen.year ? 1 : 0)) + ')' : 'Filters';
      if (filterButton.hidden || details || atHome) { filters.hidden = true; filterButton.setAttribute('aria-expanded','false'); filterButton.classList.remove('filter-active'); }
      if (search.value !== screen.q) search.value = screen.q || '';
      search.placeholder = screen.kind === 'season' || screen.onlySeason ? 'Search episodes' : collectionIndex ? 'Search collections' : 'Search this library';
      sort.replaceChildren();
      if (screen.parent || screen.collection) option(sort,'default','Plex order');
      option(sort,'title',screen.sort === 'title' && screen.order === 'desc' ? 'Title Z–A' : 'Title A–Z');
      if (!collectionIndex) { option(sort,'added',screen.sort === 'added' && screen.order === 'asc' ? 'Oldest added' : 'Recently added'); option(sort,'year',screen.sort === 'year' && screen.order === 'asc' ? 'Oldest release' : 'Newest release'); if (screen.kind !== 'show' || screen.onlySeason) option(sort,'runtime',screen.sort === 'runtime' && screen.order === 'desc' ? 'Longest runtime' : 'Shortest runtime'); }
      option(sort,'random','Random');
      sort.value = screen.sort; direction.disabled = screen.sort === 'default';
      direction.title = direction.ariaLabel = screen.sort === 'random' ? 'Shuffle again' : screen.order === 'asc' ? 'Ascending: switch to descending' : 'Descending: switch to ascending';
      if (direction.disabled) direction.title = 'Plex order cannot be reversed.';
      direction.replaceChildren(uburoomIcons.icon(doc,screen.sort === 'random' ? 'refresh' : 'sort')); direction.dataset.order = screen.sort === 'random' ? '' : screen.order;
      genre.value = screen.genre; year.value = screen.year;
      chips.replaceChildren();
      for (const [key,control] of [['genre',genre],['year',year]]) if (screen[key]) {
        const label = control.selectedOptions[0]?.textContent || screen[key]; const b = button(chips,'Remove ' + label,'close','library-filter-chip'); b.append(node('span',null,label)); b.onclick = () => { screen[key] = ''; void query(); };
      }
      host.dataset.view = view; viewButtons.forEach(b => b.setAttribute('aria-pressed',String(b.dataset.view === view)));
      count.hidden = details || atHome;
      count.textContent = screen.loading ? 'Loading…' : screen.total == null ? screen.items.length + ' loaded' :
        screen.items.length < screen.total ? screen.items.length + ' of ' + screen.total + ' items' : screen.total + (screen.total === 1 ? ' item' : ' items');
      results.classList.toggle('episodes',screen.kind === 'season' || !!screen.onlySeason); results.hidden = details || atHome;
      landing.hidden = !atHome; footer.hidden = atHome;
      // Navigation can wrap differently after rendering. Publish its height before
      // restoring the visible item so the sticky toolbar uses the final offset.
      measureHeader();
    }
    function renderLanding() {
      landing.replaceChildren();
      for (const tab of ['library','collections']) for (const section of sections) {
        const title = tab === 'library' ? section.title : (section.title === 'Movies' ? 'Movie' : section.title) + ' Collections';
        const b = button(landing,title,tab === 'library' ? section.mediaType === 'show' ? 'tv' : 'film' : 'libraryCards','library-home-card'); b.dataset.section = section.id; b.dataset.tab = tab;
        b.append(node('span',null,title,'library-home-title')); b.onclick = () => void chooseLibrary(section.id,tab);
      }
      if (testVideo || isAdmin()) {
        const other = node('article',landing,undefined,'library-home-card library-other'); node('h3',other,'Other');
        if (testVideo) {
        const b = button(other,'Play synchronization video','play'); b.dataset.action = 'play'; b.dataset.play = 'demo'; b.append(node('span',null,'Synchronization video')); b.onclick = () => void play(demoItem);
        }
        if (isAdmin() && openCodecTester) {
          const b = button(other,'Open codec tester','settings'); b.id = 'library-codec-test';
          b.append(node('span',null,'Codec tester')); b.onclick = openCodecTester;
        }
      }
    }
    function renderResults() {
      renderTools(); clearResults();
      if (screen.kind === 'home') renderLanding();
      else if (screen.kind !== 'details') {
        screen.items.forEach(tile);
        if (!screen.items.length && screen.loading) for (let i = 0; i < 3; i++) { const placeholder = node('div',results,undefined,'library-skeleton'); placeholder.setAttribute('aria-hidden','true'); }
        if (!screen.items.length && !screen.loading) node('p',results,screen.q || screen.genre || screen.year ? 'No matches. Try another search or clear the filters.' : screen.tab === 'collections' ? 'No collections in this library.' : 'No titles here yet.','library-empty');
      }
      summary(screen.detail); watchNextPage(); setBusy(busy);
    }
    async function loadPage(append = false) {
      if (!room || !screen || ['details','home'].includes(screen.kind)) return;
      if (append && (screen.loading || screen.nextOffset == null)) return;
      if (append && screen.dirty) { await query(); return; }
      controller?.abort(); controller = new AbortController(); const version = ++requestVersion, current = screen, roomVersion = generation;
      resetStatus(); current.pageError = false; current.loading = true; if (append) renderTools(); else renderResults(); pageObserver.unobserve(sentinel);
      try {
        const query = {section:current.section,tab:current.tab,q:current.q,genre:current.genre,year:current.year,sort:current.sort,order:current.order,seed:current.seed,offset:append ? current.nextOffset : 0};
        if (current.parent) query.parent = current.parent; if (current.collection) query.collection = current.collection;
        let data;
        if (!current.section) data = {items:[demoItem].filter(x => x.title.toLowerCase().includes(current.q.toLowerCase())),total:1,nextOffset:null};
        else data = await request(endpoint('/api/watch/library',query),controller.signal);
        if (version !== requestVersion || roomVersion !== generation || current !== screen) return;
        // Use the complete child result, rather than the listing's season count.
        // A Specials folder counts as another season and keeps normal browsing.
        if (!append && current.kind === 'show' && !current.onlySeason && !query.q && !query.genre && !query.year && data.items.length === 1 && data.items[0].type === 'season' && data.nextOffset == null && (data.total == null || data.total === 1)) {
          current.onlySeason = data.items[0]; current.parent = current.onlySeason.id;
          data = await request(endpoint('/api/watch/library',{...query,parent:current.parent}),controller.signal);
        }
        if (version !== requestVersion || roomVersion !== generation || current !== screen) return;
        const seen = new Set(append ? current.items.map(x => x.id) : []), added = data.items.filter(x => { if (seen.has(x.id)) return false; seen.add(x.id); return true; });
        current.items = append ? [...current.items,...added] : added; current.total = data.total; current.nextOffset = data.nextOffset;
        current.loading = false;
        if (append) { renderTools(); added.forEach(tile); watchNextPage(); setBusy(busy); } else renderResults();
      } catch (error) {
        if (version !== requestVersion || roomVersion !== generation || error.name === 'AbortError') return;
        current.loading = false; current.pageError = true; renderTools(); signalError(error.message,() => void loadPage(append));
      }
    }
    async function getDetails(item,current) {
      detailController?.abort(); detailController = new AbortController(); const version = generation;
      try {
        const full = item.id === 'demo' ? demoItem : (await request(endpoint('/api/watch/library/item',{item:item.id,type:item.type}),detailController.signal)).item;
        if (version !== generation || screen !== current) return;
        current.detail = full; current.detailsLoaded = true; summary(full); setBusy(busy);
      } catch (error) { if (version === generation && screen === current && error.name !== 'AbortError') signalError('Details could not load. ' + error.message,() => void getDetails(item,current)); }
    }
    async function openItem(item) {
      if (!screen) screen = homeContext();
      prepareNavigation(); screen.focusItem = item.id; trail.push(screen);
      screen = {...context(screen.section,screen.tab),title:item.title,kind:playable(item) ? 'details' : item.type,detail:item,sort:'default'};
      if (item.type === 'collection') screen.collection = item.id; else if (!playable(item)) screen.parent = item.id;
      pushVisit(); renderResults(); positionLibrary();
      void getDetails(item,screen); if (!playable(item)) await loadPage();
    }
    function navigateCrumb(entry) {
      const index = trail.indexOf(entry); if (index < 0) return;
      prepareNavigation(); screen = entry; trail = trail.slice(0,index); pushVisit(); restoreScreen(true);
    }
    function restoreScreen(reveal = false) {
      reserveHeight(); screen.loading = false; renderResults();
      if (reveal) positionLibrary();
      else if (screen.anchor?.id) restoreAnchor(screen.anchor);
      else { roomForScroll(screen.scroll); restoreScroll(screen.scroll); }
      const current = screen; requestAnimationFrame(() => { if (screen === current && current.focusItem) [...results.querySelectorAll('.library-tile')].find(n => n.dataset.item === current.focusItem)?.querySelector('.library-open')?.focus({preventScroll:true}); });
      if (screen.detail && !screen.detailsLoaded) void getDetails(screen.detail,screen);
      if (!['details','home'].includes(screen.kind)) { if (screen.dirty) void query(); else if (!screen.items.length && screen.total == null) void loadPage(); }
    }
    async function fetchFacets(section) {
      filterSection = section; facetFailed = false; filterStatus.textContent = 'Loading filters…';
      for (const [control,label] of [[genre,'All genres'],[year,'All years']]) { control.replaceChildren(); option(control,'',label); control.disabled = true; }
      if (!section) { filterStatus.textContent = ''; return; }
      const version = generation;
      try {
        const value = await request(endpoint('/api/watch/library/filters',{section}),imageController.signal);
        if (version !== generation || section !== filterSection) return;
        for (const [control,values] of [[genre,value.genres],[year,value.years]]) { values.forEach(x => option(control,x.id,x.title)); control.disabled = false; }
        filterStatus.textContent = ''; renderTools();
      } catch (error) { if (version === generation && section === filterSection && error.name !== 'AbortError') { facetFailed = true; filterStatus.textContent = 'Filters unavailable. Reopen to retry.'; } }
    }
    async function chooseLibrary(id, tab = 'library') {
      if (screen?.kind === 'library' && screen.section === id && screen.tab === tab) return;
      prepareNavigation(); trail = [];
      const section = id === 'demo' ? undefined : id;
      const saved = homes.get(id + ':' + tab);
      screen = saved || context(section,tab); pushVisit();
      if (saved) restoreScreen(true); else { renderResults(); positionLibrary(); void loadPage(); }
      if (filterSection !== section) void fetchFacets(section);
    }
    async function query() { clearTimeout(timer); screen.dirty = false; screen.items = []; screen.nextOffset = null; reserveHeight(); const promise = loadPage(); positionLibrary(); await promise; }
    previous.onclick = () => goHistory(-1); next.onclick = () => goHistory(1); home.onclick = goHome;
    search.oninput = () => { screen.q = search.value.trim(); screen.dirty = true; clearTimeout(timer); timer = setTimeout(() => void query(),220); };
    sort.onchange = () => { screen.sort = sort.value; screen.order = ['added','year'].includes(screen.sort) ? 'desc' : 'asc'; if (screen.sort === 'random') screen.seed = newSeed(); void query(); };
    direction.onclick = () => { if (screen.sort === 'random') screen.seed = newSeed(); else screen.order = screen.order === 'asc' ? 'desc' : 'asc'; void query(); };
    genre.onchange = () => { screen.genre = genre.value; void query(); }; year.onchange = () => { screen.year = year.value; void query(); };
    filterButton.onclick = () => { filters.hidden = !filters.hidden; filterButton.setAttribute('aria-expanded',String(!filters.hidden)); filterButton.classList.toggle('filter-active',!filters.hidden || !!(screen.genre || screen.year)); if (!filters.hidden && facetFailed) void fetchFacets(screen.section); };
    viewButtons.forEach(b => b.onclick = () => { const anchor = captureAnchor(); reserveHeight(); view = b.dataset.view; try { localStorage.setItem('uburoom-library-view',view); } catch {} renderResults(); restoreAnchor(anchor); });
    retry.onclick = () => errorAction?.();
    async function setRoom(id) {
      if (room === id) { setBusy(busy); return; }
      room = id; generation++; requestVersion++; controller?.abort(); detailController?.abort(); clearTimeout(timer); clearImages(); homes.clear(); sections = []; trail = []; screen = undefined; playing = undefined;
      testVideo = false; screen = homeContext(); beginHistory();
      pageObserver.unobserve(sentinel); sentinel.hidden = true; host.style.minHeight = ''; clearResults(); landing.replaceChildren(); landing.hidden = true; overview.replaceChildren(); overview.hidden = true; choices.replaceChildren(); crumbs.replaceChildren(); chips.replaceChildren(); scopeActions.replaceChildren(); scopeActions.hidden = true; resetStatus(); count.hidden = false; count.textContent = id ? 'Loading libraries…' : ''; tools.hidden = !id;
      navigationControls.forEach(n => { n.disabled = true; }); direction.disabled = true;
      previous.disabled = next.disabled = true;
      genre.replaceChildren(); year.replaceChildren(); search.value = ''; filterSection = undefined; filterStatus.textContent = ''; filters.hidden = true; filterButton.classList.remove('filter-active');
      if (!id) return;
      const version = generation;
      async function start() {
        try {
          const data = await request(endpoint('/api/watch/library'),imageController.signal); if (version !== generation) return;
          sections = data.items; testVideo = !!data.testVideo;
          renderResults(); saveVisit();
        } catch (error) { if (version === generation && error.name !== 'AbortError') signalError(error.message,() => void start()); }
      }
      await start();
    }
    return {setRoom,setBusy,openItem,reveal:positionLibrary,refreshAdmin:()=>{if(screen?.kind==='home')renderLanding();}};
  }
  global.uburoomLibrary = {mount};
})(globalThis);
