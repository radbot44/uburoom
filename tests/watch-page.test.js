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
  assert.deepEqual(
    homeCards([
      { id: '1', title: 'Movies', mediaType: 'movie' },
      { id: '2', title: 'TV Shows', mediaType: 'show' },
    ]),
    [
      { id: '1', tab: 'library', title: 'Movies', icon: 'film' },
      { id: '2', tab: 'library', title: 'TV Shows', icon: 'tv' },
      { id: '1', tab: 'collections', title: 'Movie Collections', icon: 'layout-grid' },
      { id: '2', tab: 'collections', title: 'TV Shows Collections', icon: 'layout-grid' },
    ],
  );
  assert.ok(directRoomHtml.includes('<span class="library-home-title">Movies</span>'));
  assert.ok(directRoomHtml.includes('<span class="library-home-title">Movie Collections</span>'));
  assert.ok(directRoomHtml.includes('<span>Synchronization video</span>'));
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
