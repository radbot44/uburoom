/* Explicit extension artifact + disposable local TLS fixture; never loads .env. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { randomUUID, webcrypto } = require('node:crypto');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { hash } = require('../server/core');
const Engine = require('../extension/engine');
const fixture = require('../tests/fixtures/remote-protocol-v1.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await pause(20); }
  throw new Error('Timed out: ' + label);
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some(arg => !arg.startsWith('--extension=') && !arg.startsWith('--fixtures='))) throw new Error('Use --extension=build-directory --fixtures=remote-protocol-v1.json');
  const extensionArg = args.find(arg => arg.startsWith('--extension='))?.slice(12);
  const fixtureFile = args.find(arg => arg.startsWith('--fixtures='))?.slice(11);
  if (!fixtureFile || !extensionArg) throw new Error('Supply both extension and fixture paths');
  const extension = path.resolve(extensionArg);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixtureFile, 'utf8')), fixture, 'Both repositories must carry matching contract fixtures');
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'), 'utf8'));
  assert.equal(manifest.browser_specific_settings.gecko.id, 'uburoom@uburoom.com');
  const root = path.resolve(__dirname, '..');
  const cert = fs.readFileSync(path.join(root, 'certs/server-cert.pem'));
  const config = { cert, key: fs.readFileSync(path.join(root, 'certs/server-key.pem')), publicUrl: 'https://localhost', ownerId: 'fixture-owner', guildId: 'fixture-guild', channels: ['fixture-channel'] };
  const app = createApp(config, { oauthFetch: async () => { throw new Error('Live OAuth disabled'); }, plexFetch: async () => { throw new Error('Live Plex disabled'); } });
  app.hub.access = { refresh: async () => true, isMember: () => true, options: () => ({ available: true }), voiceChannel: () => null, validVoiceChannel: () => false };
  const sockets = [], timers = new Set(), intervals = new Set();
  try {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const origin = 'https://localhost:' + app.server.address().port;
    const saved = { deviceId: randomUUID(), credential: 'a'.repeat(64), serverUrl: origin };
    app.store.devices.push({ id: saved.deviceId, ownerId: config.ownerId, credentialHash: hash(saved.credential) });
    let onConnect, onMessage, playerState, tabCommands = 0, socketFailure = '';
    const event = register => ({ addListener: register || (() => {}) });
    const browser = {
      storage: { local: { get: async () => ({ ...saved }), set: async value => Object.assign(saved, value), remove: async key => delete saved[key] } },
      runtime: { getURL: file => 'moz-extension://fixture/' + file, onConnect: event(fn => { onConnect = fn; }), onMessage: event(fn => { onMessage = fn; }) },
      sessions: { getTabValue: async () => '', setTabValue: async () => {} },
      tabs: { query: async () => [{ id: 1 }], onRemoved: event(), create: async () => {}, sendMessage: async (id, message) => {
        tabCommands++;
        if (message.action === 'media.pause') playerState.paused = true;
        else if (message.action === 'zoom.set') playerState.picture = context.uburoom.picture(playerState.picture, message);
        else throw new Error('Unexpected fixture player command');
        return { status: 'applied', state: playerState };
      } }
    };
    class Socket extends WebSocket {
      constructor(url) {
        super(url, { ca: cert }); sockets.push(this);
        this.on('error', error => { socketFailure = error.message; });
        this.on('close', (code, reason) => { socketFailure = code + ': ' + reason.toString(); });
      }
    }
    const context = vm.createContext({ browser, WebSocket: Socket, crypto: webcrypto, URL, URLSearchParams, TextEncoder, Uint8Array,
      UBUROOM_REMOTE_SERVERS: [origin], console,
      setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; }, clearTimeout,
      setInterval: (fn, ms) => { const timer = setInterval(fn, ms); intervals.add(timer); return timer; }, clearInterval });
    for (const file of ['room-protocol.js', 'viewport.js', 'engine.js']) {
      vm.runInContext(fs.readFileSync(path.join(extension, file), 'utf8'), context, { filename: file });
    }
    for (const { input, args: expectedArgs } of fixture.accepted) {
      assert.deepEqual(JSON.parse(JSON.stringify(context.uburoom.validate(input))), { action: input.action, args: expectedArgs });
    }
    for (const input of fixture.rejected) assert.throws(() => context.uburoom.validate(input));
    assert.ok(Engine.protocolCompatible(context.uburoom.PROTOCOL));
    playerState = { picture: { ...context.uburoom.DEFAULT }, paused: false };
    vm.runInContext(fs.readFileSync(path.join(extension, 'background.js'), 'utf8'), context, { filename: 'background.js' });
    const popup = message => onMessage(message, { url: browser.runtime.getURL('popup.html') });
    try { await until(async () => onMessage && (await popup({ type: 'popup-state' })).connected, 'versioned background authentication'); }
    catch (error) { throw new Error(error.message + '; ' + (await popup({ type: 'popup-state' })).status + '; ' + socketFailure); }
    const roomId = randomUUID();
    let receive, remoteState;
    onConnect({ name: 'uburoom-player', sender: { tab: { id: 1 }, frameId: 0, url: 'https://tv.youtube.com/' },
      postMessage: message => { if (message.type === 'remote-state') remoteState = message; },
      onMessage: event(fn => { receive = fn; }), onDisconnect: event() });
    await receive({ type: 'hello', roomId });
    await receive({ type: 'presence', reachable: true, state: playerState });
    try { await until(() => app.hub.rooms.has(roomId), 'room registration'); }
    catch (error) { throw new Error(error.message + '; ' + (await popup({ type: 'popup-state' })).status + '; ' + socketFailure); }
    const actor = { userId: config.ownerId, guildId: config.guildId, channelId: config.channels[0] };
    assert.equal(remoteState.enabled, false);
    assert.equal((await app.hub.dispatch(actor, { action: 'media.pause' })).status, 'forbidden');
    assert.equal((await popup({ type: 'local-command', roomId, command: { action: 'room.enable' } })).status, 'applied');
    await until(() => remoteState.live, 'confirmed local consent');
    assert.equal((await app.hub.dispatch(actor, { action: 'media.pause' })).status, 'applied');
    assert.equal(playerState.paused, true);
    assert.equal((await app.hub.dispatch(actor, { action: 'zoom.set', args: { value: 1.5 } })).status, 'applied');
    assert.equal(playerState.picture.zoom, 1.5);
    assert.equal(tabCommands, 2);
    app.hub.revoke(saved.deviceId);
    await until(async () => !remoteState.enabled && !(await popup({ type: 'popup-state' })).connected, 'revocation leaves consent off');
    assert.equal(remoteState.live, false);
    console.log(JSON.stringify({ passed: true, protocol: Engine.PROTOCOL, commands: tabCommands, checks: ['matching fixtures', 'TLS authentication', 'consent gate', 'playback command', 'transform command', 'revocation'], limitations: 'Simulated browser APIs/player with real extension background source and TLS server; not real YouTube TV or browser lifecycle certification.' }));
  } finally {
    for (const socket of sockets) socket.terminate();
    await app.close();
    for (const timer of timers) clearTimeout(timer);
    for (const timer of intervals) clearInterval(timer);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
