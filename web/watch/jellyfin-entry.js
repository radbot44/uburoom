import { mount } from '../account-sign-in.js';
import { $ } from './page.js';
import { reveal } from './entry-ways.js';

/* Jellyfin sign-in on the entry page: one "Log in with Jellyfin" button per Jellyfin member source,
 * placed after Plex in the list of ways in. Choosing one opens its panel under it: the Quick Connect
 * code (large, with its expiry and Cancel), or a username and password form when the server has
 * Quick Connect off. Every message is scrolled into view. */
export function jellyfinEntry(api, ways) {
  const panel = $('jellyfin-sign-in');
  const status = $('jellyfin-sign-in-status');
  const form = $('jellyfin-sign-in-form');
  const quick = $('jellyfin-quick-connect');
  let buttons = [];
  let previous;
  let generation = 0;
  let timer;
  let cancelSource;

  function message(text) {
    status.hidden = !text;
    status.textContent = text;
    reveal(status);
  }
  function stopWaiting() {
    clearInterval(timer);
    timer = undefined;
    quick.hidden = true;
  }
  // Closing the panel (Escape, another way in, Cancel) ends the attempt in this page.
  function reset() {
    generation++;
    stopWaiting();
    form.replaceChildren();
    form.hidden = true;
    message('');
    if (cancelSource) {
      const source = cancelSource;
      cancelSource = undefined;
      void api('/api/account/jellyfin', { source, action: 'cancel' }).catch(() => {});
    }
  }
  $('jellyfin-quick-connect-cancel').addEventListener('click', () => {
    const button = buttons.find(item => item.getAttribute('aria-expanded') === 'true');
    ways.close();
    button?.focus();
  });

  return sources => {
    const key = JSON.stringify(sources);
    if (key === previous) return;
    previous = key;
    if (ways.isOpen(panel)) ways.close();
    for (const button of buttons) button.remove();
    buttons = [];
    const before = $('account-sign-in-open');
    for (const source of sources) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-button quiet';
      button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-controls', 'jellyfin-sign-in');
      const logo = document.createElement('img');
      Object.assign(logo, { src: '/assets/jellyfin-icon.svg', alt: '', width: 24, height: 24 });
      const label = 'Log in with Jellyfin' + (sources.length > 1 ? ' (' + source.name + ')' : '');
      button.append(logo, document.createTextNode(label));
      before.before(button);
      buttons.push(button);
      const request = (action, fields) => api('/api/account/jellyfin', { source: source.id, action, ...fields });
      // Choosing the button starts (or, after an error, retries) sign-in; Cancel, Escape or another way closes it.
      button.onclick = async () => {
        if (ways.isOpen(panel)) reset();
        ways.show(button, panel, { focus: button, onClose: reset });
        const attempt = ++generation;
        const active = () => attempt === generation;
        message('Contacting Jellyfin…');
        try {
          const result = await request('start');
          if (!active()) return;
          message('');
          if (result.password) {
            form.hidden = false;
            mount(form, {
              idPrefix: 'jellyfin-sign-in',
              label,
              usernameMaxLength: 200,
              authenticate: (username, password) => request('password', { username, password }),
            }).focus();
            reveal(form);
            return;
          }
          cancelSource = source.id;
          $('jellyfin-quick-connect-code').textContent = result.code;
          const ends = Date.now() + (Number(result.expiresIn) || 540) * 1000;
          const expiry = () => {
            const minutes = Math.ceil((ends - Date.now()) / 60000);
            $('jellyfin-quick-connect-expiry').textContent =
              minutes > 1 ? 'Expires in ' + minutes + ' minutes' : minutes === 1 ? 'Expires in 1 minute' : 'Expired';
          };
          expiry();
          timer = setInterval(expiry, 15000);
          quick.hidden = false;
          reveal(panel);
          while (active()) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            if (!active()) return;
            const state = await request('poll');
            if (active() && state.ok) {
              cancelSource = undefined;
              location.reload();
              return;
            }
          }
        } catch (error) {
          if (!active()) return;
          cancelSource = undefined;
          stopWaiting();
          message(error.message);
        }
      };
    }
  };
}
