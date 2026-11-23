/* Completing Discord/Plex sign-in or account linking on a configured LAN origin (/auth/lan#ticket=…). */
const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket') || '';
// Keep the single-use ticket out of the address bar and history.
history.replaceState(null, '', location.pathname);

async function finish() {
  if (!ticket) throw new Error('This sign-in link is incomplete. Start again from uburoom.');
  const response = await fetch('/api/auth/lan-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Sign-in expired. Start again from uburoom.');
  return typeof body.destination === 'string' && body.destination.startsWith('/') ? body.destination : '/';
}

finish().then(
  destination => location.replace(destination),
  error => {
    document.getElementById('handoff-status').textContent = error.message;
    document.getElementById('handoff-open').hidden = false;
  },
);
