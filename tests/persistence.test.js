'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/app');
const { hash } = require('../server/core');
const certFile = path.join(__dirname, '../certs/server-cert.pem');

test('logins survive restart, renew Discord tokens, persist logout/revocation and never restore player consent', { skip: !fs.existsSync(certFile) }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'radtv-auth-test-'));
  const cert = fs.readFileSync(certFile), config = { cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
    publicUrl: 'https://localhost:6767', ownerId: 'owner', guildId: 'guild', channels: ['commands'], clientId: 'fixture', clientSecret: 'fixture-secret',
    deviceFile: path.join(directory, 'devices.json'), loginFile: path.join(directory, 'logins.json') };
  let app, renewals = 0, renewalStatus = 200;
  const oauthFetch = async (url, options) => {
    if (!url.endsWith('/token')) return new Response(JSON.stringify({ id: 'owner', username: 'alice' }));
    if (options.body.get('grant_type') === 'refresh_token') {
      renewals++;
      await new Promise(resolve => setTimeout(resolve, 40));
      if (renewalStatus !== 200) return new Response('{}', { status: renewalStatus });
      assert.equal(options.body.get('refresh_token'), 'private-fixture-refresh');
      return new Response(JSON.stringify({ access_token: 'private-fixture-access', refresh_token: 'rotated-private-refresh', expires_in: 604800 }));
    }
    return new Response(JSON.stringify({ access_token: 'private-fixture-access', refresh_token: 'private-fixture-refresh', expires_in: 604800 }));
  };
  async function start() {
    app = createApp(config, { oauthFetch });
    app.hub.access = { refresh: async id => id === 'owner', isMember: id => id === 'owner' };
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  async function restart(edit) {
    await app.close(); app = undefined;
    if (edit) {
      const data = JSON.parse(fs.readFileSync(config.loginFile, 'utf8')); edit(data);
      fs.writeFileSync(config.loginFile, JSON.stringify(data));
    }
    await start();
  }
  t.after(async () => {
    if (app) await app.close();
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await start();
  async function request(route, headers = {}, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port: app.server.address().port, path: route, method, ca: cert, headers }, res => {
        let text = ''; res.on('data', c => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : undefined }));
      }); req.on('error', reject); req.end();
    });
  }
  async function login() {
    const begin = await request('/auth/discord'), state = new URL(begin.headers.location).searchParams.get('state');
    const result = await request('/auth/callback?code=fixture&state=' + state, { Cookie: begin.headers['set-cookie'][0].split(';')[0] });
    assert.equal(result.status, 302);
    const headers = { Cookie: result.headers['set-cookie'][0].split(';')[0], Origin: config.publicUrl };
    const me = (await request('/api/me', headers)).body; headers['X-CSRF-Token'] = me.csrf;
    assert.equal(me.name, 'alice');
    assert.match(result.headers['set-cookie'][0], /Max-Age=31536000/);
    return headers;
  }
  const headers = await login(), csrf = headers['X-CSRF-Token'];
  const persisted = JSON.parse(fs.readFileSync(config.loginFile, 'utf8'));
  assert.equal(persisted.logins[0][1].expires, null, 'no arbitrary login deadline');
  assert.equal(persisted.logins[0][0], hash(headers.Cookie.slice('radtv='.length)), 'only a hash of the browser credential is stored');
  assert.equal(JSON.stringify(persisted).includes('private-fixture-access'), false, 'unused access tokens are not retained');
  const deviceId = randomUUID(), credential = 'a'.repeat(64);
  app.store.devices.push({ id: deviceId, ownerId: 'owner', credentialHash: hash(credential) }); app.store.save();
  const socket = { readyState: 1, send() {}, close() { this.readyState = 3; } };
  assert.equal(app.hub.authenticate(socket, deviceId, credential), true);
  app.hub.update(socket, { sessionId: randomUUID(), epoch: randomUUID(), alias: '', mode: 'owner', enabled: true, reachable: true });
  await restart();
  const me = await request('/api/me', headers);
  assert.equal(me.body.loggedIn, true); assert.equal(me.body.csrf, csrf);
  assert.match(me.headers['set-cookie'][0], /Max-Age=31536000/, 'returning renews the browser cookie');
  assert.equal(app.hub.ownerName, 'alice'); assert.equal(app.store.devices.length, 1);
  assert.deepEqual((await request('/api/sessions', headers)).body.sessions, [], 'live players and consent are not persisted');
  await restart(data => { data.logins[0][1].oauth.expires = 0; });
  const results = await Promise.all([request('/api/me', headers), request('/api/me', headers)]);
  assert.ok(results.every(result => result.body.loggedIn)); assert.equal(renewals, 1, 'concurrent requests share one renewal');
  assert.equal(JSON.parse(fs.readFileSync(config.loginFile, 'utf8')).logins[0][1].oauth.refreshToken, 'rotated-private-refresh');
  await restart(); assert.equal((await request('/api/me', headers)).body.loggedIn, true);
  assert.equal((await request('/api/logout', headers, 'POST')).status, 200);
  await restart(); assert.equal((await request('/api/me', headers)).body.loggedIn, false, 'logout remains effective after restart');
  const second = await login();
  await restart(data => { data.logins[0][1].oauth.expires = 0; });
  renewalStatus = 503;
  assert.equal((await request('/api/me', second)).status, 503, 'temporary Discord outage does not erase login');
  assert.equal(JSON.parse(fs.readFileSync(config.loginFile, 'utf8')).logins.length, 1);
  renewalStatus = 400;
  assert.equal((await request('/api/me', second)).body.loggedIn, false, 'Discord rejecting renewal requires a fresh sign-in');
  await restart(); assert.equal((await request('/api/me', second)).body.loggedIn, false, 'revocation is durable');
  const third = await login();
  config.guildId = 'different-guild';
  await restart(); assert.equal((await request('/api/me', third)).body.loggedIn, false, 'saved logins cannot transfer to another authorization context');
});
