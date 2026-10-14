'use strict';
(() => {
  const $ = id => document.getElementById(id);
  let code = location.hash.slice(1);
  history.replaceState(null, '', '/auth/handoff');
  const proof = Array.from(crypto.getRandomValues(new Uint8Array(32)), value => value.toString(16).padStart(2,'0')).join('');
  let attempt, stopped = false, switchAccount = false, timer;
  const stop = message => { stopped = true; clearTimeout(timer); $('error').textContent = message; $('handoff-switch').hidden = true; $('handoff-code').hidden = $('handoff-instruction').hidden = true; };
  async function request(action, data) {
    const response = await fetch('/api/watch/handoff/' + action, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(10000)});
    const value = await response.json();
    if (!response.ok) {
      if (response.status === 409 && value.switchRequired) return value;
      throw new Error(value.error || 'Browser sign-in failed');
    }
    return value;
  }
  function confirmSwitch(name) {
    $('handoff-message').textContent = 'This browser has a different uburoom account. Switch to ' + name + '?';
    $('handoff-switch').textContent = 'Switch to ' + name; $('handoff-switch').hidden = false;
  }
  async function poll() {
    if (stopped) return;
    if (Date.now() >= attempt.expires) return stop('Sign-in expired. Open a fresh link from the Activity.');
    try {
      const value = await request('redeem',{id:attempt.id,proof,switchAccount});
      if (stopped) return;
      if (value.switchRequired) { confirmSwitch(attempt.name); return; }
      if (value.destination) {
        // Server provides only its fixed watch path and an optional room UUID.
        if (!/^\/watch(?:\?room=[a-f0-9-]{36})?$/.test(value.destination)) throw new Error('Invalid sign-in destination');
        stopped = true; location.replace(value.destination); return;
      }
      timer = setTimeout(poll, 1000);
    } catch (error) { stop(error.message); }
  }
  $('handoff-switch').addEventListener('click', () => {
    switchAccount = true; $('handoff-switch').hidden = true;
    $('handoff-message').textContent = 'Continue as ' + attempt.name + '.'; void poll();
  });
  window.addEventListener('pagehide', () => { stopped = true; clearTimeout(timer); });
  (async () => {
    if (!/^[a-f0-9]{64}$/.test(code)) throw new Error('Open this page using Open in Browser in the uburoom Activity.');
    const secret = code; code = undefined;
    attempt = await request('claim',{code:secret,proof});
    if (stopped) return;
    $('handoff-code').textContent = attempt.verification; $('handoff-code').hidden = $('handoff-instruction').hidden = false;
    $('handoff-message').textContent = 'Continue as ' + attempt.name + '.';
    if (attempt.switchRequired) confirmSwitch(attempt.name); else void poll();
  })().catch(error => stop(error.message));
})();
