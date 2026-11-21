/* The set-password page opened from a uburoom account's one-time link (/account/password#<token>). */
const $ = id => document.getElementById(id);
// The token lives only in the fragment, which browsers never send; take it out of the address bar.
const token = location.hash.slice(1);
history.replaceState(null, '', location.pathname);

async function post(path, data) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(15000),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || 'Request failed; try again');
  return value;
}

async function start() {
  if (!token) {
    $('password-status').textContent = 'This link is incomplete. Open the whole link you were given.';
    return;
  }
  try {
    const info = await post('/api/uburoom-accounts/link', { token });
    $('password-title').textContent = info.purpose === 'reset' ? 'Choose a new password' : 'Set your password';
    $('password-status').textContent = `For ${info.name} (${info.username}).`;
    $('password-username').value = info.username;
    $('password-form').hidden = false;
    $('password-new').focus();
  } catch (error) {
    $('password-status').textContent = error.message;
  }
}

$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const password = $('password-new').value;
  $('password-error').textContent = '';
  if (password !== $('password-confirm').value) {
    $('password-error').textContent = 'The passwords don’t match.';
    $('password-confirm').focus();
    return;
  }
  $('password-submit').disabled = true;
  try {
    await post('/api/uburoom-accounts/password', { token, password });
    $('password-form').hidden = true;
    $('password-status').textContent = 'Password set. Opening uburoom…';
    location.assign('/');
  } catch (error) {
    $('password-error').textContent = error.message;
    $('password-submit').disabled = false;
  }
});

void start();
