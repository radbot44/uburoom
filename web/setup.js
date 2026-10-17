'use strict';
const $ = id => document.getElementById(id);
for (const [id, icon] of [['manage', 'settings'], ['logout', 'logout'], ['refresh', 'refresh'], ['close-devices', 'close'], ['admin-mode','admin']]) $(id).replaceChildren(uburoomUI.icon(document, icon));
let me, selected, rooms = [], polling = false, commandPending = false, commandVersion = 0;
const connection = new uburoomWatchTransport({
  url: location.origin.replace('https:', 'wss:') + '/watch-socket',
  identity: () => ({ csrf: me?.csrf }),
  onClose: () => { remote.stop(); rooms = []; selected = undefined; renderSelection(); },
  onReady: () => refreshPlayers()
});
const remote = uburoomUI.mount($('remote'), { headerSlot: 'players', volumeInterval: 600, execute: async command => {
  if (!selected || commandPending) throw new Error('Select an available player');
  const id = selected; commandPending = true; commandVersion++;
  try {
    const result = await connection.request('/api/command', { roomId: id, command });
    if (id !== selected) return { status: 'unavailable', message: 'Player selection changed.' };
    if (result.state) { const s = rooms.find(s => s.id === id); if (s) s.state = result.state; }
    if (result.status === 'applied' && command.action.startsWith('room.')) {
      const s = rooms.find(s => s.id === id);
      if (s) {
        if (command.action === 'room.sharing') s.mode = command.args.mode;
        else if (command.action === 'room.controls') s.controls = { ...s.controls, [command.args.control]: command.args.allowed };
        else if (command.action === 'room.autojoin') s.autoJoin = command.args.enabled;
        else s.enabled = command.action === 'room.enable';
      }
      renderSelection();
    }
    if (result.status !== 'applied') await refreshPlayers();
    return result;
  } finally { commandPending = false; for (const b of $('players').children) b.disabled = false; }
} });
async function post(path, body = {}) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': me.csrf },
    body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
function renderSelection() {
  const room = rooms.find(s => s.id === selected);
  remote.render(room?.state, { available: !!room && room.enabled !== false, canSave: !!room?.canSave,
    canPlayback: room?.canPlayback !== false, canTransform: room?.canTransform !== false,
    room: room?.canManage ? { ...room, connected: true, reachable: true, paired: true, live: room.enabled } : null });
  $('status').textContent = '';
  for (const button of $('players').children) {
    const s = rooms.find(s => s.id === button.dataset.id);
    if (s) button.textContent = s.alias + (s.enabled === false ? ' · Off' : '');
    button.setAttribute('aria-pressed', String(button.dataset.id === selected)); button.disabled = commandPending;
  }
}
async function refreshPlayers() {
  if (!me?.loggedIn || polling || commandPending) return;
  polling = true;
  const version = commandVersion;
  try {
    if (!connection.ready) return;
    const next = (await connection.request('/api/rooms')).rooms;
    if (commandPending || version !== commandVersion) return;
    rooms = next;
    if (!rooms.some(s => s.id === selected)) { if (selected) remote.stop(); selected = undefined; }
    if (!selected) {
      const live = rooms.filter(s => s.enabled !== false);
      const own = live.filter(s => s.canManage);
      if (own.length === 1) selected = own[0].id;
      else if (!own.length && live.length === 1) selected = live[0].id;
      else if (rooms.length === 1) selected = rooms[0].id;
    }
    $('player-picker').hidden = rooms.length > 0;
    $('players').replaceChildren();
    for (const room of rooms) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = room.alias + (room.enabled === false ? ' · Off' : ''); b.dataset.id = room.id;
      b.title = b.textContent;
      b.addEventListener('click', () => { if (commandPending) return; remote.stop(); selected = room.id; renderSelection(); }); $('players').append(b);
    }
    $('empty').hidden = rooms.length > 0; renderSelection();
  } catch (e) {
    remote.stop();
    rooms = []; selected = undefined; $('players').replaceChildren(); $('empty').hidden = false;
    $('player-picker').hidden = false;
    remote.render(undefined, { available: false, canSave: false, room: null }); $('status').textContent = e.message;
  } finally { polling = false; }
}
async function refreshAccount() {
  const response = await fetch('/api/me', { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Server unavailable'); me = await response.json();
  $('welcome').hidden = me.loggedIn; $('signed-in').hidden = !me.loggedIn; $('login').hidden = !me.oauthReady;
  $('manage').hidden = !me.adminMode; if (!me.adminMode) $('devices-panel').hidden = true; $('name').textContent = me.name || 'Discord account';
  $('admin-mode').hidden = !me.owner; $('admin-mode').setAttribute('aria-checked',String(!!me.adminMode));
  $('admin-mode').title = me.adminMode ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
  $('devices').replaceChildren();
  for (const device of me.devices) {
    const li = document.createElement('li'), name = document.createElement('span'); name.textContent = device.id.slice(0, 8) + '… · ' + new Date(device.pairedAt).toLocaleDateString();
    const revoke = document.createElement('button'); revoke.textContent = '×'; revoke.title = revoke.ariaLabel = 'Revoke this device';
    revoke.addEventListener('click', () => action(async () => { await post('/api/devices/revoke', { id: device.id }); await refreshAccount(); await refreshPlayers(); }));
    li.append(name, revoke); $('devices').append(li);
  }
  if (me.loggedIn) { await connection.connect(); await refreshPlayers(); }
  else { connection.close(); rooms = []; selected = undefined; remote.stop(); remote.render(undefined, { available: false, room: null }); $('status').textContent = me.oauthReady ? '' : 'Configure Discord OAuth on the server.'; }
}
async function action(fn) { $('result').textContent = ''; try { await fn(); } catch (e) { $('result').textContent = e.message; } }
$('manage').addEventListener('click', () => { $('devices-panel').hidden = !$('devices-panel').hidden; });
$('close-devices').addEventListener('click', () => { $('devices-panel').hidden = true; });
$('logout').addEventListener('click', () => action(async () => { await post('/api/logout'); selected = undefined; $('devices-panel').hidden = true; await refreshAccount(); }));
$('refresh').addEventListener('click', () => action(refreshPlayers));
$('admin-mode').addEventListener('click', () => action(async () => { $('admin-mode').disabled = true;
  try {await post('/api/admin-mode',{enabled:!me.adminMode});await refreshAccount();} finally {$('admin-mode').disabled = false;} }));
action(refreshAccount);
setInterval(() => { if (!document.hidden && !commandPending) action(refreshAccount); }, 2000);
