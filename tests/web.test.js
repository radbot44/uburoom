'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { createApp } = require('../server/app');
const { hash } = require('../server/core');
const Engine = require('../extension/engine');
const certFile = path.join(__dirname, '../certs/server-cert.pem');

test('web login, visibility, explicit UUID routing and writes enforce current permission and CSRF', { skip: !fs.existsSync(certFile) }, async t => {
  const cert = fs.readFileSync(certFile), config = { cert, key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
    publicUrl: 'https://localhost:6767', ownerId: 'owner', guildId: 'guild', channels: ['commands'], clientId: 'fixture', clientSecret: 'fixture-secret' };
  const firstVoice = '111111111111111111', secondVoice = '222222222222222222';
  let identity = 'owner', member = true, voice = firstVoice, hostVoice = firstVoice;
  const app = createApp(config, { oauthFetch: async url => new Response(JSON.stringify(url.endsWith('/token') ? { access_token: 'fixture' } : { id: identity, username: identity + '-name' })) });
  app.hub.access = { refresh: async id => id === 'owner' || id === 'friend' && member, isMember: id => id === 'owner' || id === 'friend' && member,
    options: () => ({ available: true }),
    validVoiceChannel: id => [firstVoice, secondVoice].includes(id), voiceChannel: id => id === 'owner' ? hostVoice : voice };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve)); t.after(() => app.close());
  const port = app.server.address().port; config.publicUrl = `https://localhost:${port}`;
  async function request(route, method = 'GET', data, headers = {}) {
    return new Promise((resolve, reject) => {
      const req = https.request({ hostname: 'localhost', port, path: route, method, ca: cert, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
        let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text ? JSON.parse(text) : undefined }));
      }); req.on('error', reject); req.end(data && JSON.stringify(data));
    });
  }
  async function login(id) {
    identity = id; const start = await request('/auth/discord');
    const state = new URL(start.headers.location).searchParams.get('state');
    const callback = await request('/auth/callback?code=fixture&state=' + state, 'GET', undefined, { Cookie: start.headers['set-cookie'][0].split(';')[0] });
    if (callback.status !== 302) return callback;
    const headers = { Cookie: callback.headers['set-cookie'][0].split(';')[0], Origin: config.publicUrl };
    const me = (await request('/api/me', 'GET', undefined, headers)).body; headers['X-CSRF-Token'] = me.csrf;
    return { headers, me };
  }
  assert.equal((await request('/api/sessions')).status, 401);
  assert.equal((await request('/api/command', 'POST', { sessionId: randomUUID(), command: { action: 'media.pause' } })).status, 403);
  assert.equal((await login('outsider')).status, 403);
  const owner = await login('owner'), friend = await login('friend');
  assert.equal(friend.me.owner, false); assert.deepEqual(friend.me.devices, []);
  const deviceId = randomUUID(), credential = 'a'.repeat(64);
  app.store.devices.push({ id: deviceId, ownerId: 'owner', credentialHash: hash(credential) });
  let commandCount = 0, lastCommand;
  const state = { picture: { ...Engine.DEFAULT }, paused: true, muted: false, volume: 72, seekable: false, profileSlots: [1] };
  const ws = { readyState: 1, close() { this.readyState = 3; }, send(raw) {
    const message = JSON.parse(raw); if (message.type !== 'command') return;
    commandCount++; lastCommand = message; queueMicrotask(() => app.hub.ack(ws, { ...message, status: 'applied', state }));
  } };
  assert.equal(app.hub.authenticate(ws, deviceId, credential), true);
  const make = (mode, alias, enabled = true) => {
    const s = { sessionId: randomUUID(), epoch: randomUUID(), alias, mode, enabled, reachable: true, state };
    app.hub.update(ws, s); return s;
  };
  const privateSession = make('owner', 'private-name', false), publicSession = make('voice', 'same-name'), duplicate = make('guild', 'same-name');
  const disabled = make('guild', 'disabled-name', false);
  const friendList = (await request('/api/sessions', 'GET', undefined, friend.headers)).body.sessions;
  assert.deepEqual(friendList.map(s => s.id).sort(), [publicSession.sessionId, duplicate.sessionId].sort());
  assert.equal(JSON.stringify(friendList).includes('private-name'), false); assert.equal(JSON.stringify(friendList).includes('disabled-name'), false);
  assert.equal((await request('/api/rooms')).status, 401);
  assert.deepEqual((await request('/api/rooms', 'GET', undefined, friend.headers)).body.rooms, friendList);
  const ownerList = (await request('/api/sessions', 'GET', undefined, owner.headers)).body.sessions;
  assert.equal(ownerList.length, 4);
  assert.equal(ownerList.find(s => s.id === disabled.sessionId).enabled, false);
  assert.equal(ownerList.find(s => s.id === disabled.sessionId).canManage, true);
  const input = { sessionId: publicSession.sessionId, senderName: 'owner-name', command: { action: 'media.pause', senderName: 'owner-name', name: 'owner-name' } };
  assert.equal((await request('/api/command', 'POST', input, { ...friend.headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await request('/api/command', 'POST', input, { ...friend.headers, 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/api/command', 'POST', { command: input.command }, friend.headers)).status, 400, 'web must select an explicit player');
  assert.equal((await request('/api/command', 'POST', {roomId:input.sessionId,command:input.command}, friend.headers)).body.status, 'applied');
  const applied = (await request('/api/command', 'POST', input, friend.headers)).body;
  assert.equal(applied.status, 'applied'); assert.equal(applied.state.volume, 72); assert.equal(commandCount, 2, 'duplicate aliases do not interfere with UUID targeting');
  assert.equal(lastCommand.senderName, 'friend-name', 'web commands use the login name despite forged sender fields');
  const spoof = (await request('/api/command', 'POST', { ...input, sessionId: privateSession.sessionId, userId: 'owner' }, friend.headers)).body;
  assert.equal(spoof.status, 'forbidden'); assert.equal(spoof.state, undefined);
  for (const action of ['profile.save', 'room.disable', 'room.enable', 'room.sharing', 'room.controls', 'room.autojoin']) {
    assert.notEqual((await request('/api/command', 'POST', { ...input, command: { action, args: { slot: 1, mode: 'guild',control:'playback',allowed:true,enabled:true } } }, friend.headers)).body.status, 'applied');
  }
  assert.equal((await request('/api/devices/revoke', 'POST', { id: deviceId }, friend.headers)).status, 403);
  hostVoice = secondVoice;
  assert.equal((await request('/api/command', 'POST', input, friend.headers)).body.status, 'forbidden');
  assert.deepEqual((await request('/api/sessions', 'GET', undefined, friend.headers)).body.sessions.map(s => s.id), []);
  voice = secondVoice;
  assert.equal((await request('/api/command', 'POST', input, friend.headers)).body.status, 'applied', 'web access follows the host');
  hostVoice = undefined;
  assert.equal((await request('/api/command', 'POST', input, friend.headers)).body.status, 'forbidden');
  assert.deepEqual((await request('/api/sessions', 'GET', undefined, friend.headers)).body.sessions.map(s => s.id), []);
  assert.equal((await request('/api/sessions', 'GET', undefined, owner.headers)).body.sessions.length, 4);
  voice = undefined;
  assert.equal((await request('/api/command', 'POST', input, friend.headers)).body.status, 'forbidden');
  assert.deepEqual((await request('/api/sessions', 'GET', undefined, friend.headers)).body.sessions.map(s => s.id), []);
  member = false;
  assert.equal((await request('/api/sessions', 'GET', undefined, friend.headers)).status, 401);
  assert.equal((await request('/api/command', 'POST', { ...input, sessionId: duplicate.sessionId }, friend.headers)).status, 403);
  assert.equal(commandCount, 3, 'denied writes never reach the device');
  const hostEnable = { sessionId: disabled.sessionId, command: { action: 'session.enable' } };
  assert.equal((await request('/api/command', 'POST', hostEnable, friend.headers)).status, 403);
  assert.equal((await request('/api/command', 'POST', hostEnable, { ...owner.headers, 'X-CSRF-Token': '' })).status, 403);
  assert.equal((await request('/api/command', 'POST', { ...hostEnable, command: { action: 'media.pause' } }, owner.headers)).body.status, 'forbidden', 'off session cannot accept playback commands');
  assert.equal((await request('/api/command', 'POST', hostEnable, owner.headers)).body.status, 'applied');
  assert.equal(app.hub.rooms.get(disabled.sessionId).enabled, true);
  assert.equal(lastCommand.action, 'session.enable', 'installed extensions retain the legacy wire command');
  assert.equal((await request('/api/command', 'POST', { ...hostEnable, command: { action: 'room.sharing', args: { mode: 'owner' } } }, owner.headers)).body.status, 'applied');
  assert.equal(app.hub.rooms.get(disabled.sessionId).mode, 'owner');
  const control = {sessionId:publicSession.sessionId,command:{action:'room.controls',args:{control:'playback',allowed:false}}};
  assert.equal((await request('/api/command','POST',control,owner.headers)).body.status,'applied');
  member=true;hostVoice=voice=firstVoice;
  assert.equal((await request('/api/command','POST',input,friend.headers)).body.status,'forbidden','web enforces category permissions');
  assert.equal((await request('/api/command','POST',input,owner.headers)).body.status,'applied','owner can still use playback');
});
