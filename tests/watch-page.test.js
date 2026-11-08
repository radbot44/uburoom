'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { watchPage } = require('../server/watch-page');
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
});
