'use strict';
const rooms = new Map();
let socket, reconnectTimer, authenticated = false, status = 'Not paired', serverOffset = 0;
let config = {}, connecting = false, signingIn = false, loginGeneration = 0;
let sharing = { available: false }, sharingRequestedAt = 0, ownerName = '';
let voiceReady = false, voiceSequence = 0;
const serverOrigins = globalThis.UBUROOM_REMOTE_SERVERS || ['https://localhost:6767'];
const allowedServers = new Set(serverOrigins);
const loaded = browser.storage.local.get(['deviceId', 'credential', 'serverUrl', 'autoJoin']).then(async saved => {
  // Keep paired device identity, credentials and selected origin across upgrades.
  if (saved.serverUrl === 'https://localhost:8787') saved.serverUrl = 'https://localhost:6767';
  config = { ...saved, deviceId: saved.deviceId || crypto.randomUUID(), serverUrl: saved.serverUrl || serverOrigins[0] };
  await browser.storage.local.set({ deviceId: config.deviceId, serverUrl: config.serverUrl });
});
function endpoint() {
  if (!allowedServers.has(config.serverUrl)) throw new Error('This server is not configured in this extension build. Keep your pairing and configure the build for its HTTPS origin.');
  return config.serverUrl;
}
function send(message) {
  if (!authenticated || socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message)); return true;
}
function tell(s) {
  try { s.port.postMessage({ type: 'remote-state', enabled: s.enabled, live: s.live, epoch: s.epoch,
    mode: s.mode, controls: { ...s.controls }, autoJoin: s.autoJoin,
    ownerName: uburoom.senderName(ownerName, 'You'), paired: !!config.credential, connected: authenticated, sharingAvailable: sharing.available, serverUrl: config.serverUrl }); } catch {}
}
function turnOff(s, notify = true) {
  s.enabled = false; s.live = false; s.epoch = crypto.randomUUID(); s.lastAck = 0;
  tell(s); if (notify) report(s);
}
function loseConnection(ws, incompatible = false) {
  if (socket !== ws) return;
  authenticated = false; connecting = false; socket = undefined;
  status = incompatible ? 'Incompatible remote protocol — update the extension and server; remote off' : 'Disconnected — remote off';
  sharing = { available: false }; sharingRequestedAt = 0;
  voiceReady = false; voiceSequence = 0;
  for (const s of rooms.values()) turnOff(s, false);
  clearTimeout(reconnectTimer);
  if (config.credential && !incompatible) reconnectTimer = setTimeout(connect, 3000);
}
async function connect() {
  await loaded;
  if (connecting || socket || !config.credential) return;
  connecting = true; status = 'Connecting';
  try {
    const ws = new WebSocket(endpoint().replace('https:', 'wss:') + '/ws');
    socket = ws;
    const authTimeout = setTimeout(() => { if (!authenticated && socket === ws) ws.close(); }, 5000);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'auth', deviceId: config.deviceId, credential: config.credential, protocol: uburoom.PROTOCOL }));
    ws.onclose = event => { clearTimeout(authTimeout); loseConnection(ws, event?.code === 4006); };
    ws.onerror = () => { status = 'Connection failed — check HTTPS certificate'; ws.close(); };
    ws.onmessage = async event => {
      if (socket !== ws) return;
      try {
        const m = JSON.parse(event.data);
        if (m.type === 'auth-ok') {
          if (!uburoom.protocolCompatible(m.protocol)) { ws.close(4006, 'Incompatible remote protocol'); return; }
          authenticated = true; connecting = false; status = 'Connected — enable a tab locally'; clearTimeout(authTimeout); requestSharing();
          for (const s of rooms.values()) report(s);
        }
        else if (!authenticated) return;
        else if (m.type === 'sharing-options') {
          ownerName = typeof m.ownerName === 'string' ? m.ownerName : ownerName;
          sharing = { available: m.available === true, guildName: typeof m.guildName === 'string' ? m.guildName : '' };
          for (const s of rooms.values()) tell(s);
        }
        else if (m.type === 'voice-state') {
          if (!authenticated || !Number.isSafeInteger(m.sequence) || m.sequence <= voiceSequence) return;
          voiceSequence = m.sequence;
          const wasReady = voiceReady; voiceReady = m.available === true;
          sharing.available = voiceReady;
          for (const s of rooms.values()) {
            if (wasReady && voiceReady && uburoom.joinEligible(s, m, Date.now(), serverOffset)) {
              try { changeRoom(s, { action: 'room.enable' }); } catch { /* No deferred enable or retry. */ }
            }
            tell(s);
          }
        }
        else if (m.type === 'room-ack') {
          const s = rooms.get(m.roomId);
          if (!s || s.epoch !== m.epoch) return;
          serverOffset = m.serverNow - Date.now();
          s.lastAck = Date.now(); s.live = s.enabled && m.live === true; tell(s);
        } else if (m.type === 'command') {
          const s = rooms.get(m.roomId);
          const ack = (result) => send({ type: 'ack', id: m.id, roomId: m.roomId, epoch: m.epoch, ...result });
          const command = uburoom.validate(m);
          const management = uburoom.MANAGEMENT.includes(command.action);
          if (!s || !s.reachable || !management && (!s.enabled || !s.live) || s.epoch !== m.epoch || Date.now() - s.lastAck > 8000 || Date.now() + serverOffset >= m.expiresAt) {
            ack({ status: 'unavailable' }); return;
          }
          if (management || command.action === 'room.disable') {
            if (m.actorId !== m.ownerId) { ack({ status: 'unavailable' }); return; }
            try {
              await changeRoom(s, command, false, uburoom.senderName(m.senderName));
              ack({ status: 'applied', disabled: command.action === 'room.disable', state: s.state }); report(s);
            } catch { ack({ status: 'unavailable' }); }
            return;
          }
          const guest = m.actorId !== m.ownerId;
          if (guest && !uburoom.controlAllowed(s.controls, command)) { ack({ status: 'unavailable' }); return; }
          const result = await browser.tabs.sendMessage(s.tabId, { type: 'remote-command', id: m.id,
            roomId: s.id, epoch: s.epoch, guest, localExpiresAt: m.expiresAt - serverOffset, senderName: uburoom.senderName(m.senderName), ...command }, { frameId: 0 });
          if (!s.enabled || s.epoch !== m.epoch || Date.now() + serverOffset >= m.expiresAt) ack({ status: 'unavailable' });
          else { s.state = uburoom.snapshot(result.state) || s.state; ack({ status: result.status, state: s.state }); report(s); }
        }
      } catch { /* Invalid messages never execute or reveal credentials. */ }
    };
  } catch { connecting = false; status = 'Invalid server address'; }
}
function report(s) {
  send({ type: 'room', roomId: s.id, epoch: s.epoch, alias: s.alias,
    mode: s.mode, controls: { ...s.controls }, autoJoin: s.autoJoin, enabled: s.enabled, reachable: s.reachable, state: s.state });
}
function requestSharing() {
  if (authenticated && Date.now() - sharingRequestedAt > 15000 && send({ type: 'sharing-options' })) sharingRequestedAt = Date.now();
}
function setSharing(s, m) {
  const mode = m.mode || 'owner';
  if (!['owner', 'voice', 'guild'].includes(mode)) throw new Error('Choose a sharing mode');
  if (mode !== 'owner' && !sharing.available) throw new Error('Wait for Discord to connect before sharing');
  s.mode = mode;
}
function changeRoom(s, input, notify = true, senderName = uburoom.senderName(ownerName, 'You')) {
  const command = uburoom.validate(input);
  if (command.action === 'room.autojoin') {
    if (command.args.enabled && (!authenticated || !sharing.available || !s.reachable)) throw new Error('Connect Discord and a player before enabling On join');
    // A remembered device preference arms new tabs; it never restores remote consent.
    const armedAt = Date.now();
    return browser.storage.local.set({ autoJoin: command.args.enabled }).then(() => {
      config.autoJoin = command.args.enabled;
      for (const player of rooms.values()) {
        player.autoJoin = config.autoJoin; player.autoArmedAt = config.autoJoin ? armedAt : undefined;
        tell(player); report(player);
      }
      try { s.port.postMessage({ type: 'command-feedback', roomId: s.id, command, senderName }); } catch {}
      return { status: 'applied', state: s.state };
    });
  }
  if (command.action === 'room.disable') turnOff(s, false);
  else {
    if (command.action === 'room.enable') {
      if (!authenticated || !s.reachable) throw new Error('A connected server and an available player are required');
      if (s.mode !== 'owner' && !sharing.available) throw new Error('Wait for Discord to connect before sharing');
      s.enabled = true;
    } else if (command.action === 'room.sharing') setSharing(s, command.args);
    else if (command.action === 'room.controls') s.controls[command.args.control] = command.args.allowed;
    else throw new Error('Unsupported room action');
    s.epoch = crypto.randomUUID(); s.live = false; s.lastAck = Date.now(); tell(s);
  }
  if (notify) report(s);
  try { s.port.postMessage({ type: 'command-feedback', roomId: s.id, command, senderName }); } catch {}
  return { status: 'applied', state: s.state };
}
browser.runtime.onConnect.addListener(port => {
  const sender = port.sender;
  if (port.name !== 'uburoom-player' || !sender?.tab || sender.frameId !== 0 || !sender.url?.startsWith('https://tv.youtube.com/')) { port.disconnect(); return; }
  let room, closed = false;
  port.onMessage.addListener(async m => {
    await loaded;
    if (closed) return;
    if (m.type === 'hello' && !room && /^[0-9a-f-]{36}$/i.test(m.roomId)) {
      for (const old of rooms.values()) if (old.tabId === sender.tab.id) {
        send({ type: 'remove', roomId: old.id }); rooms.delete(old.id);
      }
      room = { id: m.roomId, tabId: sender.tab.id, port, epoch: crypto.randomUUID(), alias: '',
        mode: 'owner', controls: { ...uburoom.CONTROLS }, autoJoin: config.autoJoin === true, autoArmedAt: Date.now(),
        enabled: false, live: false, reachable: false, lastAck: 0 };
      rooms.set(room.id, room); tell(room);
      const restoring = room;
      room.nameReady = browser.sessions.getTabValue(sender.tab.id, 'uburoom-name').then(alias => {
        if (rooms.get(restoring.id) === restoring && typeof alias === 'string' && (!alias || /^[a-z0-9][a-z0-9.-]{0,47}$/.test(alias))) {
          restoring.alias = alias; report(restoring);
        }
      }).catch(() => {});
    } else if (m.type === 'presence' && room && rooms.get(room.id) === room) {
      room.reachable = m.reachable === true;
      room.state = uburoom.snapshot(m.state);
      if (m.navigation || !room.reachable) turnOff(room);
      else report(room);
    }
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    if (room && rooms.get(room.id) === room) {
      send({ type: 'remove', roomId: room.id }); rooms.delete(room.id);
    }
  });
});
browser.tabs.onRemoved.addListener(tabId => {
  for (const s of rooms.values()) if (s.tabId === tabId) { send({ type: 'remove', roomId: s.id }); rooms.delete(s.id); }
});
browser.runtime.onMessage.addListener((m, sender) => {
  // The isolated player UI gets room controls, never pairing credentials or APIs.
  if (sender.tab && sender.frameId === 0 && sender.url?.startsWith('https://tv.youtube.com/')) {
    return (async () => {
      await loaded;
      const s = [...rooms.values()].find(s => s.tabId === sender.tab.id && s.id === m.roomId);
      if (!s) throw new Error('Player room changed');
      if (m.type === 'panel-state') { requestSharing(); tell(s); return {}; }
      if (m.type === 'local-room-command') return changeRoom(s, m.command);
      if (m.type === 'open-website') { await browser.tabs.create({ url: endpoint() + '/' }); return {}; }
    })().catch(error => ({ error: error.message }));
  }
  // Only extension popup code can access pairing operations.
  if (sender.url !== browser.runtime.getURL('popup.html')) return;
  return (async () => {
    await loaded;
    if (m.type === 'popup-state') {
      requestSharing();
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const s = [...rooms.values()].find(s => s.tabId === tabs[0]?.id);
      return { status, serverUrl: config.serverUrl, paired: !!config.credential,
        connected: authenticated, signingIn, sharing, ownerName, room: s && { id: s.id, alias: s.alias, mode: s.mode, controls: { ...s.controls }, autoJoin: s.autoJoin,
          enabled: s.enabled, live: s.live, reachable: s.reachable, state: s.state } };
    }
    if (m.type === 'sign-in') {
      if (config.credential) throw new Error('Forget the existing pairing first');
      if (signingIn) throw new Error('Finish the open Discord sign-in window');
      if (!allowedServers.has(m.serverUrl)) throw new Error('Unsupported server URL');
      signingIn = true; const generation = ++loginGeneration;
      config.serverUrl = m.serverUrl;
      status = 'Finish signing in with Discord';
      try {
        await browser.storage.local.set({ serverUrl: config.serverUrl });
        const token = () => [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
        const verifier = token(), state = token(), redirectUri = browser.identity.getRedirectURL();
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
        const challenge = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
        const attempt = await api('/api/login/start', { deviceId: config.deviceId, challenge, state, redirectUri });
        const start = new URL(attempt.url);
        if (start.origin !== endpoint() || start.pathname !== '/auth/discord' || start.searchParams.get('redirect_uri') !== redirectUri) throw new Error('Invalid sign-in destination');
        let returned;
        try { returned = new URL(await browser.identity.launchWebAuthFlow({ url: start.href, interactive: true })); }
        catch { throw new Error('Sign-in cancelled or unavailable. Retry and check the server HTTPS certificate.'); }
        if (returned.origin + returned.pathname !== redirectUri || returned.search) throw new Error('Invalid sign-in result');
        const result = new URLSearchParams(returned.hash.slice(1));
        if (result.get('state') !== state) throw new Error('Invalid sign-in state');
        if (result.get('error') === 'owner_only') throw new Error('Sign in with the Discord account configured as the owner');
        if (!/^[a-f0-9]{64}$/.test(result.get('code') || '')) throw new Error('Invalid sign-in result');
        if (generation !== loginGeneration) throw new Error('Sign-in cancelled');
        const paired = await api('/api/login/finish', { id: attempt.id, verifier, code: result.get('code') });
        if (generation !== loginGeneration) throw new Error('Sign-in cancelled');
        if (paired.deviceId !== config.deviceId || !/^[a-f0-9]{64}$/.test(paired.credential)) throw new Error('Invalid device sign-in');
        config.credential = paired.credential;
        await browser.storage.local.set({ credential: config.credential });
        status = 'Signed in — connecting'; connect(); return {};
      } catch (error) {
        status = error.message; throw error;
      } finally {
        signingIn = false;
      }
    }
    if (m.type === 'forget') {
      ++loginGeneration; config.credential = undefined;
      await browser.storage.local.remove('credential');
      for (const s of rooms.values()) turnOff(s);
      socket?.close(); status = 'Not paired'; return {};
    }
    if (m.type === 'local-command' || m.type === 'open-controls') {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const s = [...rooms.values()].find(s => s.tabId === tabs[0]?.id && s.id === m.roomId);
      if (!s) throw new Error('Select the YouTube TV tab');
      const command = m.type === 'local-command' ? uburoom.validate(m.command) : undefined;
      if (command && command.action.startsWith('room.')) return changeRoom(s, command);
      const result = await browser.tabs.sendMessage(s.tabId, m.type === 'open-controls' ? { type: 'open-controls' } :
        { type: 'local-command', senderName: uburoom.senderName(ownerName, 'You'), ...command }, { frameId: 0 });
      if (result.state) { s.state = uburoom.snapshot(result.state); report(s); }
      return result;
    }
    if (m.type === 'enable' || m.type === 'disable' || m.type === 'sharing' || m.type === 'rename') {
      const tabs = await browser.tabs.query({ active: true, currentWindow: true });
      const s = [...rooms.values()].find(s => s.tabId === tabs[0]?.id && s.id === m.roomId);
      if (!s) throw new Error('Select the YouTube TV tab');
      await s.nameReady;
      if (rooms.get(s.id) !== s) throw new Error('Player room changed');
      if (m.type === 'rename' || m.type === 'enable') {
        const alias = m.alias ?? s.alias;
        if (typeof alias !== 'string' || alias && !/^[a-z0-9][a-z0-9.-]{0,47}$/.test(alias)) throw new Error('Use a short name containing letters, numbers, dots or hyphens, or leave it blank');
        await browser.sessions.setTabValue(s.tabId, 'uburoom-name', alias);
        if (rooms.get(s.id) !== s) throw new Error('Player room changed');
        s.alias = alias;
        if (m.type === 'rename') { report(s); return {}; }
      }
      if (m.type === 'disable') return changeRoom(s, { action: 'room.disable' });
      if (m.type === 'sharing') {
        return changeRoom(s, { action: 'room.sharing', args: { mode: m.mode } });
      }
      if (!authenticated || !s.reachable) throw new Error('A connected server and an available player are required');
      setSharing(s, m);
      return changeRoom(s, { action: 'room.enable' });
    }
  })().catch(error => ({ error: error.message }));
});
async function api(path, body) {
  const response = await fetch(endpoint() + path, { method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Server request failed');
  return result;
}
setInterval(() => {
  if (authenticated) send({ type: 'heartbeat' });
  for (const s of rooms.values()) if (s.enabled && Date.now() - s.lastAck > 8000) turnOff(s);
}, 2000);
loaded.then(connect);
