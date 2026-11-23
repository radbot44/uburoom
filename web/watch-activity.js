// @ts-check
/* Activity dialog with live Now items above the Earlier room journal.
 * Preserves DOM identity, scroll position, and focus on live journal appends.
 */
import * as uburoomIcons from './icons.js';
import * as controls from './watch-controls.js';
import * as dialogs from './watch-dialogs.js';
import * as popover from './watch-popover.js';

const FILTERS = Object.freeze([
  { id: 'all', label: 'All' },
  { id: 'playback', label: 'Playback' },
  { id: 'people', label: 'Viewers' },
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
 * Mounts the Activity hub button, badge, fullscreen menu dot, and dialog.
 * @param {{
 *   button: HTMLElement,
 *   badge: HTMLElement,
 *   menuDot?: HTMLElement | null,
 *   panel: HTMLDialogElement,
 *   journal: ReturnType<import('./watch/journal.js').createClientJournal>,
 *   attention: ReturnType<import('./watch-attention.js').createAttention>,
 *   getState: () => any,
 *   getSelfId: () => string | undefined,
 *   getServerNow: () => number | undefined,
 *   onReopenActivity: (id: string) => boolean,
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
  getServerNow,
  onReopenActivity,
}) {
  let activeFilter = 'all';
  let unseenWhileScrolled = 0;
  let journalId = journal.journalId;
  let roomId = journal.roomId;
  /** @type {Map<number, HTMLLIElement>} */
  const rowNodes = new Map();

  // Build the body once so live updates preserve the controls and scroll viewport.
  const body = panel.querySelector('#activity-body');
  const closeBtn = panel.querySelector('#activity-dismiss');

  const nowSection = document.createElement('section');
  nowSection.className = 'activity-now';
  nowSection.hidden = true;
  nowSection.setAttribute('aria-label', 'Active room tools');
  const nowList = document.createElement('div');
  nowList.className = 'activity-now-list';
  nowSection.append(nowList);

  const filterBar = document.createElement('div');
  filterBar.className = 'button-group activity-filters';
  filterBar.setAttribute('role', 'group');
  filterBar.setAttribute('aria-label', 'Filter activity');

  /** @type {Map<string, HTMLButtonElement>} */
  const filterButtons = new Map();
  for (const filter of FILTERS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'group-button activity-filter-chip';
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
  controls.segmented(filterBar);
  const newPill = document.createElement('button');
  newPill.type = 'button';
  newPill.className = 'primary activity-new-pill';
  newPill.hidden = true;
  newPill.addEventListener('click', () => {
    viewport.scrollTop = 0;
    viewport.focus({ preventScroll: true });
    unseenWhileScrolled = 0;
    newPill.hidden = true;
  });

  const viewport = document.createElement('div');
  viewport.id = 'activity-scroll';
  viewport.className = 'activity-scroll';
  viewport.tabIndex = 0;
  viewport.setAttribute('role', 'region');
  viewport.setAttribute('aria-label', 'Room activity history');
  viewport.addEventListener('scroll', () => {
    if (viewport.scrollTop <= 16 && unseenWhileScrolled > 0) {
      unseenWhileScrolled = 0;
      newPill.hidden = true;
    }
  });
  const listEl = document.createElement('ol');
  listEl.id = 'activity-list';
  listEl.className = 'activity-list';
  viewport.append(listEl);

  const emptyEl = document.createElement('p');
  emptyEl.className = 'activity-empty';
  emptyEl.textContent = 'No room activity yet.';

  const history = document.createElement('div');
  history.className = 'activity-history';
  history.append(newPill, viewport, emptyEl);
  body.append(nowSection, filterBar, history);

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

  function rebuildList(resetScroll = true) {
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
    for (const [index, entry] of visible.entries()) {
      let node = rowNodes.get(entry.seq);
      if (!node) {
        node = createRow(entry);
        rowNodes.set(entry.seq, node);
      } else {
        const [time, description] = node.children;
        const stamp = formatTimestamp(entry.at);
        const text = formatJournalEntry(entry);
        if (time.textContent !== stamp) time.textContent = stamp;
        if (description.textContent !== text) description.textContent = text;
      }
      const atIndex = listEl.children[index];
      if (node !== atIndex) listEl.insertBefore(node, atIndex || null);
    }
    emptyEl.hidden = visible.length > 0;
    viewport.hidden = !emptyEl.hidden;
    if (resetScroll) {
      viewport.scrollTop = 0;
      unseenWhileScrolled = 0;
      newPill.hidden = true;
    }
  }

  function applyJournalChange(change) {
    updateRoomFilterVisibility();
    if (change.full) {
      const reset = change.journalId !== journalId || change.roomId !== roomId;
      if (reset) {
        journalId = change.journalId;
        roomId = change.roomId;
        listEl.replaceChildren();
        rowNodes.clear();
      }
      rebuildList(reset);
      return;
    }
    const wasScrolledDown = panel.open && viewport.scrollTop > 24;
    const removed = new Set(change.removed);
    const viewportTop = wasScrolledDown ? viewport.getBoundingClientRect().top : 0;
    const anchor = wasScrolledDown
      ? [...listEl.children].find(
          row => !removed.has(Number(row.dataset.seq)) && row.getBoundingClientRect().bottom > viewportTop,
        )
      : undefined;
    const anchorTop = anchor?.getBoundingClientRect().top;
    for (const oldSeq of removed) {
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
    viewport.hidden = !emptyEl.hidden;
    if (anchor && anchorTop !== undefined) {
      viewport.scrollTop += anchor.getBoundingClientRect().top - anchorTop;
    }
    if (prepended > 0 && wasScrolledDown) {
      unseenWhileScrolled += prepended;
      newPill.textContent = `${unseenWhileScrolled} new`;
      newPill.hidden = false;
    }
  }

  function renderNowAndBadge() {
    const state = getState();
    const selfId = getSelfId();
    const { items, badgeCount } = attention.compute(state, selfId, getServerNow());
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
        btn.className = 'quiet activity-now-item';
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
          if (onReopenActivity(item.id)) dialogs.close(panel);
          else popover.show(btn, { state: 'error', text: 'This activity can’t open right now.' });
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

  button.addEventListener('click', () => {
    renderNowAndBadge();
    dialogs.open(panel, button);
  });
  closeBtn.addEventListener('click', () => dialogs.close(panel));

  const unsubscribe = journal.subscribe(applyJournalChange);
  rebuildList();
  renderNowAndBadge();

  return {
    sync: renderNowAndBadge,
    destroy: unsubscribe,
  };
}
