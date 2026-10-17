'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { hash } = require('../server/core');
const { FIREFOX_REDIRECT } = require('../server/login');
const certFile = path.join(__dirname, '../certs/server-cert.pem');
test('real TLS transport authenticates devices, gates consent, acknowledges execution and drops on disconnect', { skip: !fs.existsSync(certFile) && 'Generate the development certificate to run the TLS integration check' }, async t => {
  const cert = fs.readFileSync(certFile);
  const app = createApp({ publicUrl: 'https://localhost:6767', cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
    ownerId: 'owner', guildId: 'guild', channels: ['commands'] });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const port = app.server.address().port;
  function request(route, method = 'GET', body, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port, path: route, method, ca: cert,
        headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      }); req.on('error', reject); req.end(body && JSON.stringify(body));
    });
  }
  assert.equal((await request('/health')).status, 200);
  assert.equal((await request('/api/me')).body.loggedIn, false);
  assert.equal((await request('/api/login/start', 'POST', {}, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/devices/revoke', 'POST', { id: randomUUID() })).status, 403);
  const unpaired = new WebSocket(`wss://localhost:${port}/ws`, { ca: cert });
  await once(unpaired, 'open');
  const denied = once(unpaired, 'close'); unpaired.send(JSON.stringify({ type: 'auth', deviceId: randomUUID(), credential: 'a'.repeat(64) }));
  assert.equal((await denied)[0], 4003);
  const deviceId = randomUUID(), credential = 'c'.repeat(64);
  app.store.devices.push({ id: deviceId, ownerId: 'owner', credentialHash: hash(credential) });
  const ws = new WebSocket(`wss://localhost:${port}/ws`, { ca: cert });
  await once(ws, 'open');
  async function exchange(message) {
    const response = once(ws, 'message'); ws.send(JSON.stringify(message)); return JSON.parse((await response)[0]);
  }
  assert.equal((await exchange({ type: 'auth', deviceId, credential })).type, 'auth-ok');
  const session = { type: 'session', sessionId: randomUUID(), epoch: randomUUID(), alias: 'player', mode: 'owner', enabled: false, reachable: true };
  assert.equal((await exchange(session)).live, false);
  const actor = { userId: 'owner', guildId: 'guild', channelId: 'commands' }, command = { action: 'media.pause' };
  assert.equal((await app.hub.dispatch(actor, command)).status, 'forbidden');
  session.enabled = true; assert.equal((await exchange(session)).live, true);
  const received = once(ws, 'message'); const applied = app.hub.dispatch(actor, command);
  const wire = JSON.parse((await received)[0]);
  assert.ok(wire.expiresAt > Date.now());
  ws.send(JSON.stringify({ type: 'ack', id: wire.id, sessionId: wire.sessionId, epoch: wire.epoch, status: 'applied' }));
  assert.equal((await applied).status, 'applied');
  const closing = once(ws, 'close'); ws.close(); await closing;
  // Server close event can follow the client's close event by one turn.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await app.hub.dispatch(actor, command)).status, 'forbidden');
});
test('Discord sign-in pairs automatically only through the fixed Firefox return URL and matching proof', { skip: !fs.existsSync(certFile) }, async t => {
  const cert = fs.readFileSync(certFile), config = {
    publicUrl: 'https://localhost:6767', cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
    ownerId: 'owner', clientId: 'test-client', clientSecret: 'test-secret', guildId: 'guild', channels: ['commands']
  };
  // Mock only Discord's external OAuth endpoints; local TLS, cookies and writes are real.
  let identity = 'other';
  t.mock.method(globalThis, 'fetch', async url => {
    assert.ok(['https://discord.com/api/oauth2/token', 'https://discord.com/api/users/@me'].includes(url));
    return new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'test-token' } : { id: identity }), { status: 200 });
  });
  const app = createApp(config); app.hub.access = {refresh:async id=>id==='owner',isMember:id=>id==='owner'};
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close()); const port = app.server.address().port; config.publicUrl = `https://localhost:${port}`;
  function request(route, method = 'GET', data, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port, path: route, method, ca: cert, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : undefined }));
      }); req.on('error', reject); req.end(data && JSON.stringify(data));
    });
  }
  async function beginLogin(route = '/auth/discord') {
    const login = await request(route); assert.equal(login.status, 302);
    const state = new URL(login.headers.location).searchParams.get('state');
    return { state, headers: { Cookie: login.headers['set-cookie'][0].split(';')[0] } };
  }
  let login = await beginLogin();
  assert.equal((await request('/auth/callback?state=' + login.state + '&code=x')).status, 403, 'state must be bound to the initiating browser cookie');
  login = await beginLogin();
  assert.equal((await request('/auth/callback?state=' + login.state + '&code=x', 'GET', undefined, login.headers)).status, 403, 'other Discord identities cannot log in');
  identity = 'owner'; login = await beginLogin();
  const callback = await request('/auth/callback?state=' + login.state + '&code=x', 'GET', undefined, login.headers);
  assert.equal(callback.status, 302); const cookie = callback.headers['set-cookie'][0];
  assert.ok(cookie.includes('HttpOnly') && cookie.includes('Secure') && cookie.includes('SameSite=Lax'));
  const authenticated = { Cookie: cookie.split(';')[0], Origin: config.publicUrl };
  const me = await request('/api/me', 'GET', undefined, authenticated); assert.equal(me.body.loggedIn, true);
  const deviceId = randomUUID(), verifier = 'd'.repeat(64), state = 'e'.repeat(64);
  const extensionHeaders = { Origin: 'moz-extension://' + randomUUID() };
  const loginData = { deviceId, challenge: hash(verifier), state, redirectUri: FIREFOX_REDIRECT };
  assert.equal((await request('/api/login/start', 'POST', loginData, { Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/login/start', 'POST', { ...loginData, redirectUri: 'https://attacker.example/' }, extensionHeaders)).status, 400);
  const start = await request('/api/login/start', 'POST', loginData, extensionHeaders);
  assert.equal(start.status, 200);
  const authPath = new URL(start.body.url).pathname + new URL(start.body.url).search;
  assert.equal((await request(authPath.replace(encodeURIComponent(FIREFOX_REDIRECT), encodeURIComponent('https://attacker.example/')))).status, 400);
  assert.equal((await request('/api/login/finish', 'POST', { id: start.body.id, verifier, code: 'a'.repeat(64) }, extensionHeaders)).status, 400);
  identity = 'other';
  const wrongStart = await request('/api/login/start', 'POST', loginData, extensionHeaders);
  const wrongUrl = new URL(wrongStart.body.url); login = await beginLogin(wrongUrl.pathname + wrongUrl.search);
  const wrongCallback = await request('/auth/callback?state=' + login.state + '&code=x', 'GET', undefined, login.headers);
  assert.equal(new URLSearchParams(new URL(wrongCallback.headers.location).hash.slice(1)).get('error'), 'owner_only');
  assert.equal(app.store.devices.length, 0, 'another Discord identity never pairs');
  identity = 'owner'; login = await beginLogin(authPath);
  const approved = await request('/auth/callback?state=' + login.state + '&code=x', 'GET', undefined, login.headers);
  assert.equal(approved.status, 302);
  const returned = new URL(approved.headers.location);
  assert.equal(returned.origin + returned.pathname, FIREFOX_REDIRECT);
  assert.equal(returned.search, '', 'completion code is not placed in a request query');
  const result = new URLSearchParams(returned.hash.slice(1)); assert.equal(result.get('state'), state);
  assert.equal(app.store.devices.length, 0, 'OAuth alone does not register a device');
  assert.equal((await request('/api/login/finish', 'POST', { id: start.body.id, verifier: 'a'.repeat(64), code: result.get('code') }, extensionHeaders)).status, 400);
  const claimed = await request('/api/login/finish', 'POST', { id: start.body.id, verifier, code: result.get('code') }, extensionHeaders);
  assert.equal(claimed.status, 200); assert.equal(claimed.body.deviceId, deviceId);
  assert.equal(app.store.devices[0].credentialHash, hash(claimed.body.credential));
  assert.equal(app.store.devices[0].credential, undefined);
  assert.equal(app.hub.rooms.size, 0, 'automatic pairing never enables remote access');
  assert.equal((await request('/api/login/finish', 'POST', { id: start.body.id, verifier, code: result.get('code') }, extensionHeaders)).status, 400);
  assert.equal((await request('/api/devices/revoke', 'POST', { id: deviceId }, authenticated)).status, 403, 'CSRF header required');
  authenticated['X-CSRF-Token'] = me.body.csrf;
  assert.equal((await request('/api/devices/revoke', 'POST', { id: deviceId }, { ...authenticated, Origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await request('/api/devices/revoke', 'POST', { id: deviceId }, authenticated)).status, 403, 'Admin mode is required for device management');
  assert.equal((await request('/api/admin-mode','POST',{enabled:true},authenticated)).status,200);
  assert.equal((await request('/api/devices/revoke', 'POST', { id: deviceId }, authenticated)).status, 200);
  assert.equal(app.store.devices.length, 0);
});
