'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { watchPage } = require('../server/watch-page');
const { homeCards } = require('../web/watch-library');
const template = fs.readFileSync(path.join(__dirname, '../web/watch.html'), 'utf8');

// The opening tag of the element with this attribute value, whitespace collapsed; attribute and text readers.
function tag(html, value, attribute = 'id') {
  const match = new RegExp('<[a-zA-Z][\\w-]*(?:\\s[^>]*?)?\\s' + attribute + '="' + value + '"[^>]*>').exec(html);
  return match && match[0].replace(/\s+/g, ' ');
}
const attr = (html, id, name) => {
  const open = tag(html, id);
  const match = open && new RegExp('\\s' + name + '(?:="([^"]*)")?(?=[\\s/>])').exec(open);
  return match ? (match[1] ?? true) : undefined;
};
const text = (html, id) => new RegExp('\\sid="' + id + '"[^>]*>([^<]*)<').exec(html)?.[1];

test('watchPage renders authenticated and unauthenticated bootstrap data safely with CSP nonce support', () => {
  const name = '</script><img src=x onerror="attack()"> & room';
  const initial = {
    config: { clientId: '</script>\u2028' },
    me: { status: 200, value: { durableRooms: true } },
    rooms: { status: 200, value: { rooms: [{ id: 'room', name, title: name, viewers: 1 }] } },
  };
  const html = watchPage(template, initial, 'testNonce1234==');
  assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=&quot;attack()&quot;&gt; &amp; room'));
  assert.ok(!html.includes(name));
  assert.ok(html.includes('href="/room/room"'));
  assert.equal(attr(html, 'room-lobby', 'hidden'), undefined);
  assert.equal(attr(html, 'auth-overlay', 'hidden'), true);
  const data = JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(data, initial);
  assert.ok(!html.includes('<script>attack()'), 'No executable bootstrap script is generated');
  assert.match(tag(html, '/watch.js', 'src'), / data-os-style-nonce="testNonce1234=="/);
  assert.ok(!html.includes('<style nonce="testNonce1234=="'), 'the nonce is not applied to arbitrary inline styles');

  const unauthHtml = watchPage(template, { config: {}, me: { status: 401, value: { error: 'Sign in' } } });
  assert.equal(attr(unauthHtml, 'room-lobby', 'hidden'), true);
  assert.ok(!unauthHtml.includes('/room/'));
  assert.ok(unauthHtml.includes('id="welcome"'));

  const directRoomHtml = watchPage(template, {
    config: { unifiedAccounts: true },
    me: { status: 200, value: { name: 'Alice <Host>', durableRooms: true, adminEligible: true, adminMode: true } },
    rooms: { status: 200, value: { rooms: [{ id: 'room', name: 'Movie Night', viewers: 2 }] } },
    events: { status: 200, value: { canSchedule: true, events: [] } },
    library: {
      status: 200,
      value: { items: [{ id: '1', title: 'Movies', type: 'library', mediaType: 'movie' }], testVideo: true },
    },
    targetRoom: { id: 'room', slug: 'movie-night', name: 'Movie Night & Chill' },
  });
  assert.equal(
    attr(directRoomHtml, 'room-lobby', 'hidden'),
    true,
    'direct /room/<slug> entry keeps lobby hidden on first paint',
  );
  assert.equal(
    attr(directRoomHtml, 'auth-overlay', 'hidden'),
    true,
    'direct /room/<slug> keeps auth-overlay hidden for authorized viewers',
  );
  assert.equal(
    text(directRoomHtml, 'options-title'),
    'Movie Night &amp; Chill',
    'direct /room/<slug> sets options title to room name on first paint',
  );
  assert.doesNotMatch(
    attr(directRoomHtml, 'watch-body', 'class'),
    /outside-room/,
    'direct /room/<slug> removes outside-room class on first paint',
  );
  assert.equal(attr(directRoomHtml, 'switch-room', 'aria-label'), 'Switch room');
  assert.equal(attr(directRoomHtml, 'switch-room', 'title'), 'Switch room', 'switch-room control on first paint');
  assert.equal(
    attr(directRoomHtml, 'close-room', 'hidden'),
    undefined,
    'direct /room/<slug> reveals leave room control',
  );
  assert.equal(text(directRoomHtml, 'empty-title'), 'Movie Night &amp; Chill');
  assert.equal(attr(directRoomHtml, 'identity', 'aria-label'), 'Alice &lt;Host&gt; · Account settings');
  assert.equal(attr(directRoomHtml, 'admin-mode', 'aria-checked'), 'true');
  assert.equal(attr(directRoomHtml, 'lobby-schedule', 'hidden'), undefined);
  assert.equal(attr(directRoomHtml, 'reopen', 'hidden'), undefined);
  assert.equal(tag(directRoomHtml, 'queue-empty-title', 'class'), '<h3 class="queue-empty-title">');
  assert.equal(attr(directRoomHtml, 'queue-empty-browse', 'disabled'), undefined);
  assert.match(directRoomHtml, /\sid="library-content"[^>]*><div class="library-landing">/);

  const directRoomWithMediaHtml = watchPage(template, {
    config: { unifiedAccounts: true },
    me: { status: 200, value: { name: 'Alice <Host>' } },
    rooms: { status: 200, value: { rooms: [{ id: 'room', name: 'Movie Night', viewers: 2 }] } },
    targetRoom: {
      id: 'room',
      slug: 'movie-night',
      name: 'Movie Night & Chill',
      media: { title: "The 'High Sign'", subtitle: '1921' },
    },
  });
  assert.equal(
    attr(directRoomWithMediaHtml, 'empty-stage', 'hidden'),
    true,
    'direct room with media hides empty stage on first paint',
  );
  assert.equal(text(directRoomWithMediaHtml, 'title'), 'The &#39;High Sign&#39;', 'player title on first paint');
  assert.equal(text(directRoomWithMediaHtml, 'details'), '1921');
  assert.equal(attr(directRoomWithMediaHtml, 'watch-body', 'class'), '', 'direct room with media leaves no body state');
  // One card per library, naming its server by that server's mark and own name; collections open from the card.
  assert.deepEqual(
    homeCards([
      { id: '1', title: 'Movies', mediaType: 'movie', serverKind: 'plex', serverName: 'VIGRID' },
      { id: '2', title: 'TV Shows', mediaType: 'show', serverKind: 'jellyfin' },
      { id: 'film', title: 'Film', mediaType: 'movie', source: 'folder', collections: false, serverKind: 'local' },
    ]),
    [
      {
        id: '1',
        title: 'Movies',
        icon: 'film',
        collections: true,
        source: { text: 'VIGRID', logo: '/assets/plex-icon.png', label: 'Plex' },
      },
      {
        id: '2',
        title: 'TV Shows',
        icon: 'tv',
        collections: true,
        source: { text: 'Jellyfin', logo: '/assets/jellyfin-icon.svg', label: 'Jellyfin' },
      },
      { id: 'film', title: 'Film', icon: 'folder', collections: false, source: { text: 'Local folders' } },
    ],
  );
  assert.ok(directRoomHtml.includes('<span class="library-home-title">Movies</span>'));
  assert.ok(directRoomHtml.includes('class="library-home-collections" aria-label="Movies collections"'));
  // The sync test video is shown in Admin mode only.
  assert.ok(directRoomHtml.includes('data-play="demo"'));
  const withoutAdmin = watchPage(template, {
    config: { unifiedAccounts: true },
    me: { status: 200, value: { name: 'Alice', durableRooms: true, adminEligible: true, adminMode: false } },
    rooms: { status: 200, value: { rooms: [] } },
    library: { status: 200, value: { items: [{ id: '1', title: 'Movies', mediaType: 'movie' }], testVideo: true } },
  });
  assert.ok(withoutAdmin.includes('<span class="library-home-title">Movies</span>'));
  assert.ok(!withoutAdmin.includes('data-play="demo"'));
  const usedIcons = [...directRoomHtml.matchAll(/<use href="#icon-([^"]+)"><\/use>/g)].map(m => m[1]);
  assert.ok(usedIcons.length > 0);
  for (const iconId of usedIcons) {
    assert.ok(directRoomHtml.includes('<symbol id="icon-' + iconId + '"'), 'icon-sprite contains symbol for ' + iconId);
  }
  assert.throws(
    () => watchPage(template.replace('id="reopen"', 'id="reopen-drifted"'), initial),
    /watch\.html template target missing/,
  );
});

test('Watch Night upcoming card description-only update preserves DOM node while Edit uses the latest revision', async t => {
  const lobbyEventsMod = await import('../web/watch-lobby-events.js');
  const prevDoc = global.document;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    global.document = prevDoc;
  });

  function makeNode(tag) {
    const node = {
      tagName: tag.toUpperCase(),
      className: '',
      id: '',
      hidden: false,
      disabled: false,
      textContent: '',
      title: '',
      dataset: {},
      attributes: {},
      children: [],
      listeners: {},
      parentNode: null,
      get firstChild() {
        return this.children[0] || null;
      },
      get nextSibling() {
        if (!this.parentNode) return null;
        const idx = this.parentNode.children.indexOf(this);
        return idx >= 0 ? this.parentNode.children[idx + 1] || null : null;
      },
      setAttribute(k, v) {
        this.attributes[k] = String(v);
      },
      getAttribute(k) {
        return this.attributes[k] ?? null;
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      append(...items) {
        for (const item of items) {
          if (typeof item === 'string') {
            this.textContent += item;
            continue;
          }
          if (item.parentNode) item.remove();
          item.parentNode = this;
          this.children.push(item);
        }
      },
      prepend(...items) {
        for (const item of items.reverse()) {
          if (typeof item === 'string') continue;
          if (item.parentNode) item.remove();
          item.parentNode = this;
          this.children.unshift(item);
        }
      },
      insertBefore(item, ref) {
        if (item.parentNode) item.remove();
        item.parentNode = this;
        const idx = ref ? this.children.indexOf(ref) : -1;
        if (idx >= 0) this.children.splice(idx, 0, item);
        else this.children.push(item);
      },
      remove() {
        if (!this.parentNode) return;
        const idx = this.parentNode.children.indexOf(this);
        if (idx >= 0) this.parentNode.children.splice(idx, 1);
        this.parentNode = null;
      },
      replaceWith(next) {
        if (!this.parentNode) return;
        const parent = this.parentNode;
        const idx = parent.children.indexOf(this);
        if (idx >= 0) {
          next.parentNode = parent;
          parent.children[idx] = next;
          this.parentNode = null;
        }
      },
      querySelector(sel) {
        if (sel === 'svg') return this.children.find(c => c.tagName === 'SVG') || null;
        return null;
      },
      querySelectorAll(sel) {
        if (sel === ':scope > .lobby-event') return this.children.filter(c => c.className.includes('lobby-event'));
        return [];
      },
    };
    return node;
  }

  const byId = new Map([
    ['lobby-events', makeNode('section')],
    ['lobby-event-list', makeNode('div')],
    ['lobby-events-more', makeNode('button')],
    ['lobby-schedule', makeNode('button')],
    ['room-lobby', Object.assign(makeNode('div'), { hidden: true })],
  ]);
  global.document = {
    getElementById: id => byId.get(id),
    createElement: tag => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
  };

  let editedEvent;
  const mounted = lobbyEventsMod.mount({
    request: async () => ({ canSchedule: true, events: [] }),
    schedule: ({ event }) => {
      editedEvent = event;
    },
    join: async () => {},
    reopen: async () => {},
  });

  const baseEvent = {
    key: 'evt-1',
    title: 'Friday Watch Night',
    description: 'Original description',
    eventVersion: 1,
    roomId: 'room-1',
    roomName: 'Friday Watch Night',
    start: '2026-12-01T20:00:00.000Z',
    end: '2026-12-01T22:00:00.000Z',
    live: false,
    active: true,
    canManage: true,
    canEdit: true,
    invite: 'https://example.test/join/abc',
  };
  mounted.hydrate({ canSchedule: true, events: [baseEvent] });
  const list = byId.get('lobby-event-list');
  assert.equal(list.children.length, 1);
  const firstCard = list.children[0];
  const actions = firstCard.children[1];
  const editButton = actions.children.find(btn => btn.getAttribute('aria-label') === 'Edit event');
  assert.ok(editButton, 'Edit event button rendered');

  // Description-only update bumps eventVersion without changing visible card fields.
  mounted.hydrate({
    canSchedule: true,
    events: [{ ...baseEvent, description: 'Updated description', eventVersion: 2 }],
  });
  assert.equal(list.children[0], firstCard, 'description-only update preserves existing card DOM node');

  editButton.listeners.click();
  assert.equal(editedEvent?.description, 'Updated description', 'Edit opens with updated description');
  assert.equal(editedEvent?.eventVersion, 2, 'Edit opens with latest eventVersion');
});

test('a lobby refresh preserves the selected room until its subscription refuses it', async t => {
  const { mountModule, stubDocument } = require('./helpers/watch-module');
  const lobbyMod = await import('../web/watch/lobby.js');
  const layoutMod = await import('../web/watch/layout.js');
  const resyncMod = await import('../web/watch/room-resync.js');

  const prevMatchMedia = global.matchMedia;
  const prevResizeObserver = global.ResizeObserver;
  const prevScrollY = global.scrollY;
  const prevAddEventListener = global.addEventListener;
  global.matchMedia = () => ({ matches: false, addEventListener() {} });
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.scrollY = 0;
  global.addEventListener = () => {};
  t.after(() => {
    if (prevMatchMedia === undefined) delete global.matchMedia;
    else global.matchMedia = prevMatchMedia;
    if (prevResizeObserver === undefined) delete global.ResizeObserver;
    else global.ResizeObserver = prevResizeObserver;
    if (prevScrollY === undefined) delete global.scrollY;
    else global.scrollY = prevScrollY;
    if (prevAddEventListener === undefined) delete global.addEventListener;
    else global.addEventListener = prevAddEventListener;
  });

  const rendered = [];
  const doc = stubDocument({ createComment: () => ({ after() {} }) });
  doc.getElementById('room-lobby').hidden = true;
  doc.getElementById('lobby-rooms').id = 'lobby-rooms';

  let layoutApi;
  let lobbyApi;
  let lobbyEventsRefreshed = 0;
  let cleared = 0;
  const state = { id: 'room-old', streamVersion: 'stream-1' };
  const mounted = mountModule(lobbyMod, {
    document: doc,
    me: { account: { id: 'u1' }, durableRooms: true },
    config: { singleRoom: false },
    selected: 'room-old',
    knownRooms: [{ id: 'room-old', name: 'Old Room', viewers: 1 }],
    transport: { ready: true, connectionId: 'c1' },
    syncRoomUrl: () => {},
    diagnostics: { record() {} },
    clearRichPresence: async () => {},
    renderEnding: () => {},
    toggleDrawer: () => {},
    library: { setCatalog() {}, setRoom() {}, setBusy() {} },
    queue: { clear() {} },
    renderVisibility: () => {},
    renderTransport: () => {},
    renderScheduleButton: () => {},
    placeRoomBar: () => layoutApi?.placeRoomBar(),
    lobbyEvents: { refresh: async () => lobbyEventsRefreshed++ },
    unavailable: (message, reason) => {
      assert.equal(message, 'Room unavailable or private');
      assert.equal(reason, 'room-poll');
      cleared++;
      // Simulate player.unavailable() calling placeRoomBar() which unhides #room-lobby.
      layoutApi.placeRoomBar();
    },
  });
  t.after(() => mounted.restore());
  lobbyApi = mounted.api;

  // Wrap renderRoomChoices to observe what is rendered into #lobby-rooms.
  const origRender = lobbyApi.renderRoomChoices;
  mounted.deps.renderRoomChoices = (rooms, container) => {
    if (container === doc.getElementById('lobby-rooms')) {
      rendered.push(rooms.map(r => r.id));
    }
    return origRender(rooms, container);
  };
  layoutApi = layoutMod.mount(doc, mounted.deps);
  const resync = resyncMod.mount(doc, mounted.deps);
  mounted.view.state = state;
  mounted.view.roomLanes = { roomId: 'room-old' };

  // Start inside 'room-old' with lobby hidden.
  assert.equal(doc.getElementById('room-lobby').hidden, true);

  lobbyApi.applyRooms([]);
  lobbyApi.applyRooms([{ id: 'room-new', name: 'Fresh Room', viewers: 3 }]);
  assert.equal(mounted.view.selected, 'room-old');
  assert.equal(mounted.view.state, state);
  assert.equal(mounted.view.roomLanes.roomId, 'room-old');
  assert.equal(doc.getElementById('room-lobby').hidden, true);
  assert.equal(cleared, 0);

  resync.roomUnavailable('Room unavailable or private', 403);
  assert.equal(mounted.view.selected, undefined);
  assert.equal(mounted.view.roomLanes, undefined);
  assert.equal(cleared, 1);
  assert.equal(doc.getElementById('room-lobby').hidden, false, 'lobby opened when current room became unavailable');
  assert.ok(rendered.length >= 1, 'lobby room list rendered immediately');
  assert.deepEqual(rendered.at(-1), ['room-new'], 'lobby displays the latest room list');
  assert.equal(lobbyEventsRefreshed, 1, 'lobby upcoming events refreshed on lobby open');
});
