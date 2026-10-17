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
  assert.match(watch.headers['content-security-policy'], /frame-ancestors 'self' https:\/\/discord.com/);
  const resources = {
    '/engine.js': 'shared/engine.js', '/room-protocol.js': 'shared/room-protocol.js', '/viewport.js': 'shared/viewport.js',
    '/remote-ui.js': 'web/remote-ui.js', '/favicon.ico': 'web/assets/uburoom-favicon.ico',
    '/favicon.svg': 'web/assets/uburoom-oomark-brand.svg', '/assets/branding/uburoom-wordmark-brand.svg': 'web/assets/uburoom-wordmark-brand.svg'
  };
  for (const [route, file] of Object.entries(resources)) {
    const response = await request(route);
    assert.equal(response.status, 200, route);
    assert.deepEqual(response.body, fs.readFileSync(path.join(__dirname, '..', file)));
  }
  for (const route of ['/setup.js', '/style.css', '/index.html']) assert.equal((await request(route)).status, 404);
});
