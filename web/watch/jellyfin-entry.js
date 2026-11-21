import { mount } from '../account-sign-in.js';
import { $ } from './page.js';

export function jellyfinEntry(api) {
  const status = $('jellyfin-sign-in-status');
  const form = $('jellyfin-sign-in-form');
  const marker = $('entry-plex-activity');
  let buttons = [];
  let previous;
  let generation = 0;

  function show(message) {
    status.hidden = !message;
    status.textContent = message;
  }

  return sources => {
    const key = JSON.stringify(sources);
    if (key === previous) return;
    previous = key;
    generation++;
    for (const button of buttons) button.remove();
    buttons = [];
    form.replaceChildren();
    form.hidden = true;
    show('');

    for (const source of sources) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'provider-button quiet';
      button.textContent = 'Sign in with Jellyfin — ' + source.name;
      marker.before(button);
      buttons.push(button);
      const request = (action, fields) => api('/api/account/jellyfin', { source: source.id, action, ...fields });
      button.onclick = async () => {
        const attempt = ++generation;
        const active = () => attempt === generation;
        const setBusy = busy => buttons.forEach(item => (item.disabled = busy));
        setBusy(true);
        form.replaceChildren();
        form.hidden = true;
        show('');
        try {
          const result = await request('start');
          if (!active()) return;
          setBusy(false);
          if (result.password) {
            form.hidden = false;
            mount(form, {
              idPrefix: 'jellyfin-sign-in',
              label: button.textContent,
              usernameMaxLength: 200,
              authenticate: (username, password) => request('password', { username, password }),
            }).focus();
            return;
          }
          show('Enter code ' + result.code + ' in Jellyfin Quick Connect.');
          while (active()) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            if (!active()) return;
            const state = await request('poll');
            if (active() && state.ok) {
              location.reload();
              return;
            }
          }
        } catch (error) {
          if (active()) show(error.message);
        } finally {
          if (active()) setBusy(false);
        }
      };
    }
  };
}
