// @ts-check
/* Activity hub: anchored panel with live Now items above the Earlier room journal.
 * Preserves DOM identity, scroll position, and focus on live journal appends.
 */
import * as uburoomIcons from './icons.js';

const FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'playback', label: 'Playback' },
  { id: 'people', label: 'People' },
  { id: 'queue', label: 'Queue' },
  { id: 'tools', label: 'Tools' },
  { id: 'room', label: 'Room', hostOnly: true },
]);

function categoryForKind(kind) {
  if (!kind) return 'room';
  if (kind.startsWith('playback.') || kind.startsWith('media.')) return 'playback';
  if (kind.startsWith('people.')) return 'people';
  if (kind.startsWith('queue.') || kind.startsWith('suggestion.')) return 'queue';
  if (
    kind.startsWith('check.') ||
    kind.startsWith('break.') ||
    kind.startsWith('poll.') ||
    kind.startsWith('announcement.')
  )
    return 'tools';
  return 'room';
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms)) return '';
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function formatPeopleList(people) {
  const names = (Array.isArray(people) ? people : []).map(p => p?.name || 'Someone').filter(Boolean);
  if (!names.length) return 'Someone';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} ${names.length - 2 === 1 ? 'other' : 'others'}`;
}

/**
 * Formats a structured journal entry into plain display text (no HTML).
 * @param {any} entry
 */
export function formatJournalEntry(entry) {
  const actor = entry.actor?.name || 'Someone';
  const data = entry.data || {};
  const mediaTitle = data.media?.title || 'video';
  switch (entry.kind) {
    case 'playback.play': {
      const pos = Number.isFinite(data.position) ? ` at ${formatClock(data.position)}` : '';
      if (data.reason === 'buffering') return `Playback resumed after buffering${pos}`;
      if (data.reason === 'recovery') return `Playback resumed after recovery${pos}`;
      if (data.reason === 'break') return `Break ended — playback resumed${pos}`;
      return `${actor} resumed playback${pos}`;
    }
    case 'playback.pause': {
      const pos = Number.isFinite(data.position) ? ` at ${formatClock(data.position)}` : '';
      if (data.reason === 'buffering') {
        const who = data.viewer?.name ? ` for ${data.viewer.name}` : '';
        return `Paused${who} (buffering)${pos}`;
      }
      if (data.reason === 'noHost') return `Paused — waiting for a host${pos}`;
      if (data.reason === 'empty') return `Paused — room empty${pos}`;
      if (data.reason === 'break') return `${actor} paused for a break${pos}`;
      return `${actor} paused${pos}`;
    }
    case 'playback.seek': {
      const from = Number.isFinite(data.from) ? formatClock(data.from) : '0:00';
      const to = Number.isFinite(data.to) ? formatClock(data.to) : '0:00';
      return `${actor} sought ${from} → ${to}`;
    }
    case 'media.start': {
      if (data.how === 'autoplay' || data.how === 'auto-queue') return `Now playing: ${mediaTitle} (autoplay)`;
      if (data.how === 'next') return `${actor} skipped to ${mediaTitle}`;
      if (data.how === 'previous') return `${actor} went back to ${mediaTitle}`;
      return entry.actor ? `${actor} started ${mediaTitle}` : `Now playing: ${mediaTitle}`;
    }
    case 'media.end':
      return data.reason === 'completed' ? `Finished ${mediaTitle}` : `Ended ${mediaTitle}`;
    case 'people.join':
      return `${formatPeopleList(data.people || (entry.actor ? [entry.actor] : []))} joined`;
    case 'people.leave':
      return `${formatPeopleList(data.people || (entry.actor ? [entry.actor] : []))} left`;
    case 'people.host':
      return `${data.hostName || actor} is now running playback`;
    case 'people.role': {
      const target = data.target?.name || 'participant';
      if (data.change === 'host.add') return `${actor} made ${target} a host`;
      if (data.change === 'host.remove') return `${actor} removed ${target} as host`;
      if (data.change === 'host.relinquish') return `${actor} stepped down as host`;
      if (data.change === 'creator.transfer') return `${actor} transferred room ownership to ${target}`;
      return `${actor} updated room roles`;
    }
    case 'people.removed':
      return `${actor} removed ${data.target?.name || 'a participant'}`;
    case 'queue.add':
      return data.count ? `${actor} queued ${data.count} items` : `${actor} queued ${mediaTitle}`;
    case 'queue.playNow':
      return `${actor} played ${mediaTitle} now`;
    case 'queue.remove':
      return data.cleared
        ? `${actor} cleared ${data.count || ''} queued items`.trim()
        : `${actor} removed ${mediaTitle} from the queue`;
    case 'suggestion.accepted':
      return `${actor} accepted suggestion: ${mediaTitle}`;
    case 'check.start':
      return `${actor} started a readiness check`;
    case 'check.end':
      return data.reason === 'cancelled'
        ? `${actor} cancelled the readiness check`
        : data.reason === 'expired'
          ? 'Readiness check expired'
          : 'Readiness check finished';
    case 'break.start':
      return `${actor} started a ${data.minutes || ''}-minute break`;
    case 'break.extend':
      return `${actor} extended the break by ${data.minutes || 5} min`;
    case 'break.end':
      return data.reason === 'auto' ? 'Break ended (auto-resumed)' : `${actor} ended the break`;
    case 'announcement.send':
      return `${actor} announced: “${data.text || ''}”`;
    case 'poll.start':
      return `${actor} started a poll: ${data.question || ''}`;
    case 'poll.close': {
      const winner = data.winner ? ` → ${data.winner}` : '';
      const tie = data.tieRule === 'random' ? ' (tie → random)' : data.tieRule === 'host' ? ' (host pick)' : '';
      return `Poll closed${winner}${tie}`;
    }
    case 'room.visibility':
      return `${actor} set room to ${data.visibility || 'updated'}`;
    case 'room.guests':
      return data.removedAll
        ? `${actor} removed all guests`
        : `${actor} ${data.allowGuests ? 'enabled' : 'disabled'} guest passes`;
    case 'room.invite':
      return data.rerolled
        ? `${actor} changed the invite link`
        : `${actor} revoked ${data.revoked?.name || 'an'} invite`;
    case 'room.permissions':
      return `${actor} updated room permissions`;
    case 'room.settings':
      return `${actor} updated room settings (${data.setting || 'general'})`;
    case 'room.recovered':
      return 'Room recovered after server restart';
    default:
      return entry.kind;
  }
}

/**
 * Mounts the Activity hub button, badge, fullscreen menu dot, and anchored panel.
 * @param {{
 *   button: HTMLElement,
 *   badge: HTMLElement,
 *   menuDot?: HTMLElement | null,
 *   panel: HTMLElement,
 *   journal: ReturnType<import('./watch/journal.js').createClientJournal>,
 *   attention: ReturnType<import('./watch-attention.js').createAttention>,
 *   getState: () => any,
 *   getSelfId: () => string | undefined,
 *   onReopenActivity?: (id: string) => void,
 * }} options
 */
export function mountActivityHub({
  button,
  badge,
  menuDot,
  panel,
  journal,
  attention,
  getState,
  getSelfId,
  onReopenActivity,
}) {
  let open = false;
  let activeFilter = 'all';
  let unseenWhileScrolled = 0;
  /** @type {Map<number, HTMLLIElement>} */
  const rowNodes = new Map();

  // Build static panel shell once so live appends never recreate controls or steal focus.
  panel.replaceChildren();
  const header = document.createElement('div');
  header.className = 'activity-header';
  const heading = document.createElement('h3');
  heading.textContent = 'Activity';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'icon-button activity-close';
  closeBtn.setAttribute('aria-label', 'Close activity');
  closeBtn.replaceChildren(uburoomIcons.icon(document, 'x'));
  header.append(heading, closeBtn);

  const nowSection = document.createElement('section');
  nowSection.className = 'activity-now';
  nowSection.hidden = true;
  const nowTitle = document.createElement('div');
  nowTitle.className = 'activity-section-label';
  nowTitle.textContent = 'Now';
  const nowList = document.createElement('div');
  nowList.className = 'activity-now-list';
  nowSection.append(nowTitle, nowList);

  const earlierHeader = document.createElement('div');
  earlierHeader.className = 'activity-earlier-header';
  const earlierTitle = document.createElement('div');
  earlierTitle.className = 'activity-section-label';
  earlierTitle.textContent = 'Earlier';
  const filterBar = document.createElement('div');
  filterBar.className = 'activity-filters';
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', 'Filter activity');

  /** @type {Map<string, HTMLButtonElement>} */
  const filterButtons = new Map();
  for (const filter of FILTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'activity-filter-chip';
    btn.dataset.filter = filter.id;
    btn.textContent = filter.label;
    btn.setAttribute('aria-pressed', String(filter.id === activeFilter));
    if (filter.hostOnly) btn.hidden = true;
    btn.addEventListener('click', () => {
      if (activeFilter === filter.id) return;
      activeFilter = filter.id;
      for (const [id, el] of filterButtons) el.setAttribute('aria-pressed', String(id === activeFilter));
      rebuildList();
    });
    filterButtons.set(filter.id, btn);
    filterBar.append(btn);
  }
  earlierHeader.append(earlierTitle, filterBar);

  const newPill = document.createElement('button');
  newPill.type = 'button';
  newPill.className = 'activity-new-pill';
  newPill.hidden = true;
  newPill.addEventListener('click', () => {
    listEl.scrollTop = 0;
    unseenWhileScrolled = 0;
    newPill.hidden = true;
  });

  const listEl = document.createElement('ol');
  listEl.className = 'activity-list';
  listEl.id = 'activity-list';
  listEl.addEventListener('scroll', () => {
    if (listEl.scrollTop <= 16 && unseenWhileScrolled > 0) {
      unseenWhileScrolled = 0;
      newPill.hidden = true;
    }
  });

  const emptyEl = document.createElement('p');
  emptyEl.className = 'activity-empty';
  emptyEl.textContent = 'No room activity yet.';

  panel.append(header, nowSection, earlierHeader, newPill, listEl, emptyEl);

  function matchesFilter(entry) {
    if (activeFilter === 'all') return true;
    return categoryForKind(entry.kind) === activeFilter;
  }

  function createRow(entry) {
    const li = document.createElement('li');
    li.className = 'activity-row';
    li.dataset.seq = String(entry.seq);
    li.dataset.kind = entry.kind;
    const timeEl = document.createElement('time');
    timeEl.className = 'activity-time';
    timeEl.textContent = formatTimestamp(entry.at);
    const textEl = document.createElement('span');
    textEl.className = 'activity-text';
    textEl.textContent = formatJournalEntry(entry);
    li.append(timeEl, textEl);
    return li;
  }

  function updateRoomFilterVisibility() {
    const state = getState();
    const canSeeRoom =
      journal.hasRoomEntries || !!state?.capabilities?.roomSettings || !!state?.capabilities?.kickParticipants;
    const roomBtn = filterButtons.get('room');
    if (roomBtn) {
      roomBtn.hidden = !canSeeRoom;
      if (!canSeeRoom && activeFilter === 'room') {
        activeFilter = 'all';
        for (const [id, el] of filterButtons) el.setAttribute('aria-pressed', String(id === activeFilter));
        rebuildList();
      }
    }
  }

  function rebuildList() {
    const entries = journal.entries;
    const visible = [];
    for (let i = entries.length - 1; i >= 0; i--) {
      if (matchesFilter(entries[i])) visible.push(entries[i]);
    }
    const nextSeqs = new Set(visible.map(e => e.seq));
    for (const [seq, node] of [...rowNodes.entries()]) {
      if (!nextSeqs.has(seq)) {
        node.remove();
        rowNodes.delete(seq);
      }
    }
    const frag = document.createDocumentFragment();
    for (const entry of visible) {
      let node = rowNodes.get(entry.seq);
      if (!node) {
        node = createRow(entry);
        rowNodes.set(entry.seq, node);
      }
      frag.append(node);
    }
    listEl.replaceChildren(frag);
    emptyEl.hidden = visible.length > 0;
    unseenWhileScrolled = 0;
    newPill.hidden = true;
  }

  function applyJournalChange(change) {
    updateRoomFilterVisibility();
    if (change.full) {
      rebuildList();
      return;
    }
    const wasScrolledDown = open && listEl.scrollTop > 24;
    const prevScrollTop = listEl.scrollTop;
    const prevScrollHeight = listEl.scrollHeight;

    for (const oldSeq of change.replaced || []) {
      const oldNode = rowNodes.get(oldSeq);
      if (oldNode) {
        oldNode.remove();
        rowNodes.delete(oldSeq);
      }
    }

    let prepended = 0;
    for (const entry of change.added || []) {
      if (!matchesFilter(entry)) continue;
      if (rowNodes.has(entry.seq)) continue;
      const node = createRow(entry);
      rowNodes.set(entry.seq, node);
      listEl.prepend(node);
      prepended++;
    }

    emptyEl.hidden = listEl.children.length > 0;
    if (prepended > 0 && wasScrolledDown) {
      const addedHeight = listEl.scrollHeight - prevScrollHeight;
      if (addedHeight > 0) listEl.scrollTop = prevScrollTop + addedHeight;
      unseenWhileScrolled += prepended;
      newPill.textContent = `${unseenWhileScrolled} new`;
      newPill.hidden = false;
    }
  }

  function renderNowAndBadge() {
    const state = getState();
    const selfId = getSelfId();
    const { items, badgeCount } = attention.compute(state, selfId, Date.now());
    badge.textContent = badgeCount > 0 ? String(badgeCount) : '';
    badge.hidden = badgeCount === 0;
    if (menuDot) menuDot.hidden = badgeCount === 0;
    updateRoomFilterVisibility();

    nowSection.hidden = items.length === 0;
    if (!items.length) {
      nowList.replaceChildren();
      return;
    }
    // Preserve existing Now button nodes by activity id where possible.
    const existing = new Map([...nowList.children].map(el => [el.dataset.activityId, el]));
    const nextNodes = items.map(item => {
      let btn = existing.get(item.id);
      if (!btn) {
        btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'activity-now-item';
        btn.dataset.activityId = item.id;
        const iconSpan = document.createElement('span');
        iconSpan.className = 'activity-now-icon';
        const body = document.createElement('span');
        body.className = 'activity-now-body';
        const titleEl = document.createElement('span');
        titleEl.className = 'activity-now-title';
        const metaEl = document.createElement('span');
        metaEl.className = 'activity-now-meta';
        body.append(titleEl, metaEl);
        btn.append(iconSpan, body);
        btn.addEventListener('click', () => {
          attention.reopen(item.id);
          onReopenActivity?.(item.id);
          setOpen(false);
        });
      }
      btn.classList.toggle('needs-me', item.needsMe);
      const iconSpan = btn.querySelector('.activity-now-icon');
      if (iconSpan && iconSpan.dataset.symbol !== item.symbol) {
        iconSpan.dataset.symbol = item.symbol;
        iconSpan.replaceChildren(uburoomIcons.icon(document, item.symbol));
      }
      const titleEl = btn.querySelector('.activity-now-title');
      if (titleEl && titleEl.textContent !== item.title) titleEl.textContent = item.title;
      const metaEl = btn.querySelector('.activity-now-meta');
      if (metaEl && metaEl.textContent !== item.meta) metaEl.textContent = item.meta;
      return btn;
    });
    for (const child of [...nowList.children]) {
      if (!nextNodes.includes(child)) child.remove();
    }
    for (let i = 0; i < nextNodes.length; i++) {
      if (nowList.children[i] !== nextNodes[i]) {
        nowList.insertBefore(nextNodes[i], nowList.children[i] || null);
      }
    }
  }

  function positionPanel() {
    if (!open) return;
    const rect = button.getBoundingClientRect();
    const panelWidth = Math.min(360, window.innerWidth - 24);
    const left = Math.max(12, Math.min(rect.left, window.innerWidth - panelWidth - 12));
    const spaceAbove = rect.top - 16;
    panel.style.left = `${left}px`;
    panel.style.width = `${panelWidth}px`;
    if (spaceAbove >= 260) {
      panel.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      panel.style.top = 'auto';
      panel.style.maxHeight = `${Math.min(440, spaceAbove)}px`;
    } else {
      panel.style.top = `${rect.bottom + 8}px`;
      panel.style.bottom = 'auto';
      panel.style.maxHeight = `${Math.min(440, window.innerHeight - rect.bottom - 16)}px`;
    }
  }

  function setOpen(next) {
    open = !!next;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open) {
      renderNowAndBadge();
      positionPanel();
      closeBtn.focus();
    }
  }

  button.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(!open);
  });
  closeBtn.addEventListener('click', () => {
    setOpen(false);
    button.focus();
  });
  document.addEventListener('click', event => {
    if (!open) return;
    const target = /** @type {Node | null} */ (event.target);
    if (target && !panel.contains(target) && !button.contains(target)) setOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
      button.focus();
    }
  });
  window.addEventListener('resize', () => {
    if (open) positionPanel();
  });

  const unsubscribe = journal.subscribe(applyJournalChange);
  rebuildList();
  renderNowAndBadge();

  return {
    sync: renderNowAndBadge,
    setOpen,
    isOpen: () => open,
    destroy: unsubscribe,
  };
}
