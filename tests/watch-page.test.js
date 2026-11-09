'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { watchPage } = require('../server/watch-page');
const { homeCards } = require('../web/watch-library');
const template = fs.readFileSync(path.join(__dirname, '../web/watch.html'), 'utf8');

test('watchPage renders authenticated and unauthenticated bootstrap data safely with CSP nonce support', () => {
  const name = '</script><img src=x onerror="attack()"> & room';
  const initial = { config: { clientId: '</script>\u2028' }, me: { status: 200, value: { durableRooms: true } }, rooms: { status: 200, value: { rooms: [{ id: 'room', name, title: name, viewers: 1 }] } } };
  const html = watchPage(template, initial, 'testNonce1234==');
  assert.ok(html.includes('&lt;/script&gt;&lt;img src=x onerror=&quot;attack()&quot;&gt; &amp; room'));
  assert.ok(!html.includes(name));
  assert.ok(html.includes('href="/room/room"'));
  assert.ok(!html.includes('id="room-lobby" hidden'));
  assert.ok(html.includes('id="auth-overlay" class="lobby-auth" hidden'));
  const data = JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  assert.deepEqual(data, initial);
  assert.ok(!html.includes('<script>attack()'), 'No executable bootstrap script is generated');
  assert.match(html, /<script src="\/watch-scrollbars\.js" data-os-style-nonce="testNonce1234=="><\/script>/);
  assert.ok(!html.includes('<style nonce="testNonce1234=="'), 'the nonce is not applied to arbitrary inline styles');

  const unauthHtml = watchPage(template, { config: {}, me: { status: 401, value: { error: 'Sign in' } } });
  assert.ok(unauthHtml.includes('id="room-lobby" hidden'));
  assert.ok(!unauthHtml.includes('/room/'));
  assert.ok(unauthHtml.includes('id="welcome"'));

  const directRoomHtml = watchPage(template, {
    config: { unifiedAccounts: true },
    me: { status: 200, value: { name: 'Alice <Host>', durableRooms: true, adminEligible: true, adminMode: true } },
    rooms: { status: 200, value: { rooms: [{ id: 'room', name: 'Movie Night', viewers: 2 }] } },
    events: { status: 200, value: { canSchedule: true, events: [] } },
    library: { status: 200, value: { items: [{ id: '1', title: 'Movies', type: 'library', mediaType: 'movie' }], testVideo: true } },
    targetRoom: { id: 'room', slug: 'movie-night', name: 'Movie Night & Chill' }
  });
  assert.ok(directRoomHtml.includes('id="room-lobby" hidden'), 'direct /room/<slug> entry keeps lobby hidden on first paint');
  assert.ok(directRoomHtml.includes('id="auth-overlay" class="lobby-auth" hidden'), 'direct /room/<slug> keeps auth-overlay hidden for authorized viewers');
  assert.ok(directRoomHtml.includes('<span id="options-title" class="watch-panel-title">Movie Night &amp; Chill</span>'), 'direct /room/<slug> sets options title to room name on first paint');
  assert.ok(!directRoomHtml.includes('class="outside-room'), 'direct /room/<slug> removes outside-room class on first paint');
  assert.ok(directRoomHtml.includes('aria-label="Switch room" title="Switch room"'), 'direct /room/<slug> renders switch-room control on first paint');
  assert.ok(!directRoomHtml.includes('id="close-room" class="quiet watch-control watch-control-responsive" aria-label="Leave room" title="Leave room" hidden'), 'direct /room/<slug> reveals leave room control');
  assert.ok(directRoomHtml.includes('<h1 id="empty-title">Movie Night &amp; Chill</h1>'));
  assert.ok(directRoomHtml.includes('aria-label="Alice &lt;Host&gt; · Account settings"'));
  assert.ok(directRoomHtml.includes('id="admin-mode" class="admin-toggle" role="switch" aria-checked="true"'));
  assert.ok(!directRoomHtml.includes('id="lobby-schedule" class="quiet" type="button" aria-label="Schedule event" hidden'));
  assert.ok(!directRoomHtml.includes('id="reopen" class="quiet watch-control watch-control-responsive" aria-label="Reopen room" title="Reopen room" hidden'));
  assert.ok(directRoomHtml.includes('<p class="queue-empty-title">Join a room to use the queue</p>'));
  assert.ok(directRoomHtml.includes('id="queue-empty-browse" type="button" class="quiet" aria-label="Browse media" title="Browse media">'));
  assert.ok(directRoomHtml.includes('<div id="library-content"><div class="library-landing">'));

  const directRoomWithMediaHtml = watchPage(template, {
    config: { unifiedAccounts: true },
    me: { status: 200, value: { name: 'Alice <Host>' } },
    rooms: { status: 200, value: { rooms: [{ id: 'room', name: 'Movie Night', viewers: 2 }] } },
    targetRoom: { id: 'room', slug: 'movie-night', name: 'Movie Night & Chill', media: { title: "The 'High Sign'", subtitle: '1921' } }
  });
  assert.ok(directRoomWithMediaHtml.includes('id="empty-stage" hidden'), 'direct room with media hides empty stage on first paint');
  assert.ok(directRoomWithMediaHtml.includes('<h1 id="title">The &#39;High Sign&#39;</h1><p id="details">1921</p>'), 'direct room with media sets player title on first paint');
  assert.ok(!directRoomWithMediaHtml.includes('idle-player'), 'direct room with media removes idle-player class');
  assert.ok(!directRoomWithMediaHtml.includes('outside-room'), 'direct room with media removes outside-room class');
  assert.deepEqual(
    homeCards([{ id: '1', title: 'Movies', mediaType: 'movie' }, { id: '2', title: 'TV Shows', mediaType: 'show' }]),
    [
      { id: '1', tab: 'library', title: 'Movies', icon: 'film' },
      { id: '2', tab: 'library', title: 'TV Shows', icon: 'tv' },
      { id: '1', tab: 'collections', title: 'Movie Collections', icon: 'layout-grid' },
      { id: '2', tab: 'collections', title: 'TV Shows Collections', icon: 'layout-grid' }
    ]
  );
  assert.ok(directRoomHtml.includes('<span class="library-home-title">Movies</span>'));
  assert.ok(directRoomHtml.includes('<span class="library-home-title">Movie Collections</span>'));
  assert.ok(directRoomHtml.includes('<span>Synchronization video</span>'));
  assert.ok(directRoomHtml.includes('id="library-codec-test"'));
  const usedIcons = [...directRoomHtml.matchAll(/<use href="#icon-([^"]+)"><\/use>/g)].map(m => m[1]);
  assert.ok(usedIcons.length > 0);
  for (const iconId of usedIcons) {
    assert.ok(directRoomHtml.includes('<symbol id="icon-' + iconId + '"'), 'icon-sprite contains symbol for ' + iconId);
  }
  assert.throws(
    () => watchPage(template.replace('id="reopen"', 'id="reopen-drifted"'), initial),
    /watch\.html template target missing/
  );
});
