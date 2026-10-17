'use strict';
const $ = id => document.getElementById(id);
$('open-controls').replaceChildren(uburoomUI.icon(document, 'open'));
$('settings-toggle').replaceChildren(uburoomUI.icon(document, 'settings'));
$('open-website').replaceChildren(uburoomUI.icon(document, 'website'));
const serverOrigins = globalThis.UBUROOM_REMOTE_SERVERS;
for (const origin of serverOrigins) {
  const b = document.createElement('button'); b.dataset.server = origin; b.textContent = new URL(origin).host; b.title = origin; $('servers').appendChild(b);
}
let current, selectedServer = serverOrigins[0], serverEdited = false, refreshing = false;
const remote = uburoomUI.mount($('local-remote'), { compact: true, execute: async command => {
  const id = current?.id;
  const result = await request({ type: 'local-command', sessionId: id, command });
  if (current?.id !== id) return { status: 'unavailable', message: 'Selected tab changed.' };
  if (command.action.startsWith('room.')) await refresh();
  return result;
} });
async function request(message) { const result = await browser.runtime.sendMessage(message); if (result?.error) throw new Error(result.error); return result; }
async function refresh() {
  if (refreshing) return; refreshing = true;
  try {
    const state = await request({ type: 'popup-state' });
    current = state.session; if (!serverEdited || state.paired) selectedServer = state.serverUrl;
    $('open-website').href = selectedServer + '/';
    $('status').textContent = state.signingIn || state.paired && !state.connected ? state.status : '';
    $('signin-area').hidden = state.paired; $('forget').hidden = !state.paired;
    $('signin').disabled = !!state.signingIn; $('signin').textContent = state.signingIn ? 'Finish Discord sign-in…' : 'Log in with Discord';
    for (const b of $('servers').children) { b.setAttribute('aria-pressed', String(b.dataset.server === selectedServer)); b.disabled = !!state.signingIn; }
    $('player-section').hidden = !current; $('no-player').hidden = !!current;
    $('open-controls').disabled = !current;
    $('alias').placeholder = state.ownerName || 'Discord username';
    $('alias').disabled = !current;
    if (document.activeElement !== $('alias') && current) $('alias').value = current.alias;
    remote.render(current?.state, { available: !!current?.reachable, canSave: true,
      room: current ? { ...current, canManage: true, connected: state.connected, paired: state.paired, sharingAvailable: state.sharing.available } : null });
  } finally { refreshing = false; }
}
function button(id, action) { $(id).addEventListener('click', async () => { $('error').textContent = ''; try { await action(); await refresh(); } catch (e) { $('error').textContent = e.message; } }); }
$('alias').addEventListener('change', async () => {
  try { await request({ type: 'rename', sessionId: current?.id, alias: $('alias').value.trim().toLowerCase() }); await refresh(); }
  catch (e) { $('error').textContent = e.message; }
});
button('signin', () => request({ type: 'sign-in', serverUrl: selectedServer }));
button('forget', () => request({ type: 'forget' }));
button('open-controls', async () => { await request({ type: 'open-controls', sessionId: current?.id }); window.close(); });
button('settings-toggle', () => { $('settings-panel').hidden = !$('settings-panel').hidden; $('settings-toggle').setAttribute('aria-expanded', String(!$('settings-panel').hidden)); });
for (const b of $('servers').children) b.addEventListener('click', () => { serverEdited = true; selectedServer = b.dataset.server; for (const other of $('servers').children) other.setAttribute('aria-pressed', String(other === b)); });
refresh().catch(e => { $('error').textContent = e.message; });
setInterval(() => refresh().catch(() => {}), 1000);
