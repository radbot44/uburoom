'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { createApp } = require('../server/app');
const certFile = path.join(__dirname, '../certs/server-cert.pem');

test('watch entry and application-owned static resources work without an extension checkout', { skip: !fs.existsSync(certFile) }, async t => {
  const cert = fs.readFileSync(certFile);
  const app = createApp({ cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')), publicUrl: 'https://localhost', ownerId: 'owner', guildId: 'guild', channels: ['channel'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const request = route => new Promise((resolve, reject) => {
    const req = https.get({ hostname: 'localhost', port: app.server.address().port, path: route, ca: cert }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
  for (const query of ['', '?demo=host', '?frame_id=fixture&instance_id=123']) {
    const response = await request('/' + query);
    assert.equal(response.status, 302);
    assert.equal(response.headers.location, '/watch' + query);
  }
  const watch = await request('/watch');
  assert.equal(watch.status, 200);
  assert.match(watch.body.toString(), /<title>uburoom watch<\/title>/);
  assert.ok(watch.body.toString().indexOf('<script src="/icons.js"></script>') < watch.body.toString().indexOf('<body'), 'icon pack loads in the document head');
  assert.match(watch.body.toString(), /<link rel="stylesheet" href="\/vendor\/overlayscrollbars\/overlayscrollbars\.css">/);
  assert.match(watch.body.toString(), /<link rel="stylesheet" href="\/watch-scrollbars\.css">/);
  assert.ok(watch.body.toString().indexOf('/vendor/overlayscrollbars/overlayscrollbars.browser.es6.min.js') < watch.body.toString().indexOf('<script src="/watch-scrollbars.js"></script>'), 'library loads before scrollbar initialization');
  assert.match(watch.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/discord.com/);
  const scriptNonce = /<script src="\/watch-scrollbars\.js" data-os-style-nonce="([A-Za-z0-9+/=]+)"><\/script>/.exec(watch.body.toString())?.[1];
  assert.ok(scriptNonce, 'watch page exposes a generated style nonce only to the scrollbar initializer');
  assert.ok(watch.headers['content-security-policy'].includes("'nonce-" + scriptNonce + "'"), 'CSP permits the nonce used by OverlayScrollbars');
  assert.ok(!watch.headers['content-security-policy'].includes("'unsafe-inline'"), 'inline styles stay denied unless explicitly nonced');
  const secondWatch = await request('/watch');
  const secondNonce = /data-os-style-nonce="([A-Za-z0-9+/=]+)"/.exec(secondWatch.body.toString())?.[1];
  assert.ok(secondNonce && secondNonce !== scriptNonce, 'every page request gets a fresh style nonce');
  const activity = await request('/activity');
  const activityNonce = /data-os-style-nonce="([A-Za-z0-9+/=]+)"/.exec(activity.body.toString())?.[1];
  assert.ok(activityNonce && activity.headers['content-security-policy'].includes("'nonce-" + activityNonce + "'"), 'Activity shares the secure body scrollbar initialization');
  const resources = {
    '/engine.js': 'shared/engine.js', '/room-protocol.js': 'shared/room-protocol.js', '/viewport.js': 'shared/viewport.js',
    '/remote-ui.js': 'web/remote-ui.js', '/icons.js': 'web/icons.js', '/watch-scrollbars.js': 'web/watch-scrollbars.js', '/watch-scrollbars.css': 'web/watch-scrollbars.css', '/vendor/overlayscrollbars/overlayscrollbars.browser.es6.min.js': 'web/vendor/overlayscrollbars/overlayscrollbars.browser.es6.min.js', '/vendor/overlayscrollbars/overlayscrollbars.css': 'web/vendor/overlayscrollbars/overlayscrollbars.css', '/favicon.ico': 'web/assets/uburoom-favicon.ico',
    '/favicon.svg': 'web/assets/uburoom-oomark-brand.svg', '/assets/branding/uburoom-wordmark-brand.svg': 'web/assets/uburoom-wordmark-brand.svg'
  };
  for (const [route, file] of Object.entries(resources)) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.deepEqual(response.body, fs.readFileSync(path.join(__dirname, '..', file)));
  }
  for (const route of ['/setup.js', '/style.css', '/index.html']) assert.equal((await request(route)).status, 404);
});
