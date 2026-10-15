'use strict';
const $ = id => document.getElementById(id);
for (const [id, icon] of [['manage', 'settings'], ['logout', 'logout'], ['refresh', 'refresh'], ['close-devices', 'close'], ['admin-mode','admin']]) $(id).replaceChildren(uburoomUI.icon(document, icon));
let me, selected, sessions = [], polling = false, commandPending = false, commandVersion = 0;
const remote = uburoomUI.mount($('remote'), { headerSlot: 'players', volumeInterval: 600, execute: async command => {
  if (!selected || commandPending) throw new Error('Select an available player');
  const id = selected; commandPending = true; commandVersion++;
  try {
    const result = await post('/api/command', { sessionId: id, command });
    if (id !== selected) return { status: 'unavailable', message: 'Player selection changed.' };
    if (result.state) { const s = sessions.find(s => s.id === id); if (s) s.state = result.state; }
    if (result.status === 'applied' && command.action.startsWith('session.')) {
      const s = sessions.find(s => s.id === id);
      if (s) {
        if (command.action === 'session.sharing') s.mode = command.args.mode;
        else if (command.action === 'session.controls') s.controls = { ...s.controls, [command.args.control]: command.args.allowed };
        else if (command.action === 'session.autojoin') s.autoJoin = command.args.enabled;
        else s.enabled = command.action === 'session.enable';
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
  const session = sessions.find(s => s.id === selected);
  remote.render(session?.state, { available: !!session && session.enabled !== false, canSave: !!session?.canSave,
    canPlayback: session?.canPlayback !== false, canTransform: session?.canTransform !== false,
    session: session?.canManage ? { ...session, connected: true, reachable: true, paired: true, live: session.enabled } : null });
  $('status').textContent = '';
  for (const button of $('players').children) {
    const s = sessions.find(s => s.id === button.dataset.id);
    if (s) button.textContent = s.alias + (s.enabled === false ? ' · Off' : '');
    button.setAttribute('aria-pressed', String(button.dataset.id === selected)); button.disabled = commandPending;
  }
}
async function refreshPlayers() {
  if (!me?.loggedIn || polling || commandPending) return;
  polling = true;
  const version = commandVersion;
  try {
    const response = await fetch('/api/sessions', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      if (response.status === 401) { me.loggedIn = false; $('welcome').hidden = false; $('signed-in').hidden = true; }
      throw new Error(response.status === 401 ? 'Sign-in expired. Log in again.' : 'Players unavailable.');
    }
    const next = (await response.json()).sessions;
    if (commandPending || version !== commandVersion) return;
    sessions = next;
    if (!sessions.some(s => s.id === selected)) { if (selected) remote.stop(); selected = undefined; }
    if (!selected) {
      const live = sessions.filter(s => s.enabled !== false);
      const own = live.filter(s => s.canManage);
      if (own.length === 1) selected = own[0].id;
      else if (!own.length && live.length === 1) selected = live[0].id;
      else if (sessions.length === 1) selected = sessions[0].id;
    }
    $('player-picker').hidden = sessions.length > 0;
    $('players').replaceChildren();
    for (const session of sessions) {
      const b = document.createElement('button'); b.type = 'button'; b.textContent = session.alias + (session.enabled === false ? ' · Off' : ''); b.dataset.id = session.id;
      b.title = b.textContent;
      b.addEventListener('click', () => { if (commandPending) return; remote.stop(); selected = session.id; renderSelection(); }); $('players').append(b);
    }
    $('empty').hidden = sessions.length > 0; renderSelection();
  } catch (e) {
    remote.stop();
    sessions = []; selected = undefined; $('players').replaceChildren(); $('empty').hidden = false;
    $('player-picker').hidden = false;
    remote.render(undefined, { available: false, canSave: false, session: null }); $('status').textContent = e.message;
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
  if (me.loggedIn) await refreshPlayers();
  else { sessions = []; selected = undefined; remote.stop(); remote.render(undefined, { available: false, session: null }); $('status').textContent = me.oauthReady ? '' : 'Configure Discord OAuth on the server.'; }
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
