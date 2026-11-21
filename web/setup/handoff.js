/* Arriving from first-run setup (/auth/setup#ticket=…): the ticket signs the operator in once, then the lobby opens. */
const ticket = new URLSearchParams(location.hash.slice(1)).get('ticket') || '';
// The ticket lives only in the fragment, which browsers never send; take it out of the address bar.
history.replaceState(null, '', location.pathname);

async function signIn() {
  if (!ticket) throw new Error('This link is incomplete. Sign in to uburoom.');
  const response = await fetch('/api/setup-handoff', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'Sign in to uburoom.');
}

signIn().then(
  () => location.replace('/'),
  error => {
    document.getElementById('handoff-status').textContent = error.message;
    document.getElementById('handoff-open').hidden = false;
  },
);
