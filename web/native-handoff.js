'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const rawCode = (location.hash || '').replace(/^#/, '').trim();
  if (rawCode) history.replaceState(null, '', '/auth/native');
  const code = rawCode;

  if (!/^[a-f0-9]{64}$/.test(code)) {
    $('native-message').textContent = 'Missing or invalid authorization code. Start pairing from Plezy.';
    return;
  }

  (async () => {
    try {
      const claimRes = await fetch('/api/watch/handoff/native/claim', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
        signal: AbortSignal.timeout(10000)
      });
      if (claimRes.status === 401) {
        $('native-message').textContent = 'You must be signed in to authorize a companion client.';
        const loginLink = $('native-login');
        if (loginLink) {
          loginLink.href = '/auth/discord?return=' + encodeURIComponent('/auth/native#' + code);
          loginLink.hidden = false;
        }
        return;
      }
      const claimData = await claimRes.json();
      if (!claimRes.ok) {
        $('native-error').textContent = claimData.error || 'Failed to claim authorization code.';
        $('native-message').textContent = '';
        return;
      }

      if (claimData.verification) {
        const v = claimData.verification;
        $('native-code').textContent = v.length === 6 ? (v.slice(0, 3) + ' ' + v.slice(3)) : v;
        $('native-code').hidden = false;
        $('native-hint').hidden = false;
      }

      $('native-message').textContent = 'Authorize Plezy to connect to uburoom as ' + (claimData.name || 'your account') + '?';
      const approveBtn = $('native-approve');
      approveBtn.hidden = false;
      approveBtn.addEventListener('click', async () => {
        approveBtn.disabled = true;
        $('native-message').textContent = 'Authorizing Plezy…';
        $('native-error').textContent = '';
        try {
          const approveRes = await fetch('/api/watch/handoff/native/approve', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: claimData.id, csrf: claimData.csrf }),
            signal: AbortSignal.timeout(10000)
          });
          const approveData = await approveRes.json();
          if (!approveRes.ok) {
            $('native-error').textContent = approveData.error || 'Approval failed.';
            approveBtn.disabled = false;
            return;
          }
          approveBtn.hidden = true;
          $('native-code').hidden = true;
          $('native-hint').hidden = true;
          $('native-message').textContent = 'Plezy is now authorized! You can return to the app.';
        } catch (err) {
          $('native-error').textContent = 'Network error during approval.';
          approveBtn.disabled = false;
        }
      });
    } catch (err) {
      $('native-error').textContent = 'Failed to connect to the server.';
      $('native-message').textContent = '';
    }
  })();
})();
