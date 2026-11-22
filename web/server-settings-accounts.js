/* Server settings → Accounts: uburoom accounts the operator creates. Owned by web/server-settings.js,
 * which gives it a panel. Unlike the other sections nothing here waits for Save or a restart: each
 * action applies at once. A one-time link is shown only in the answer that created it. */
import * as uburoomControls from './watch-controls.js';

const dateTime = value => new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * @param {HTMLElement} panel
 * @param {{request: (path: string, data?: any) => Promise<any>, onOpenAccess?: () => void}} services
 * @returns {{load: () => Promise<void>, reset: () => void, updateAccess: (state: {running?: boolean, saved?: boolean}) => void}}
 */
export function mount(panel, { request, onOpenAccess }) {
  const doc = panel.ownerDocument;
  const node = (tag, parent, text, style) => {
    const value = doc.createElement(tag);
    if (text) value.textContent = text;
    if (style) value.className = style;
    parent?.append(value);
    return value;
  };
  node('p', panel, 'People you add here sign in with a username and password. Changes apply at once.', 'hint');
  const accessNotice = node('div', panel, null, 'server-account-notice');
  accessNotice.id = 'server-accounts-access-notice';
  accessNotice.hidden = true;
  accessNotice.setAttribute('role', 'status');
  const form = node('form', panel, null, 'server-accounts-create');
  const grid = node('div', form, null, 'server-settings-grid');
  const field = (label, id, attributes) => {
    const wrapper = node('label', grid, null, 'server-settings-field');
    node('span', wrapper, label);
    const input = node('input', wrapper);
    Object.assign(input, { id, type: 'text', autocomplete: 'off', ...attributes });
    return input;
  };
  const username = field('Username', 'server-account-username', {
    required: true,
    maxLength: 32,
    pattern: '[A-Za-z0-9](?:[A-Za-z0-9._\\-]{0,30}[A-Za-z0-9])?',
    autocapitalize: 'none',
    spellcheck: false,
    title: 'Letters, digits, dots, dashes or underscores',
  });
  const name = field('Display name', 'server-account-name', { maxLength: 80, placeholder: 'Same as username' });
  const create = node('button', form, 'Add account', 'quiet');
  create.type = 'submit';
  create.id = 'server-account-create';
  const linkBox = node('div', panel, null, 'server-account-link');
  linkBox.id = 'server-account-link';
  linkBox.hidden = true;
  linkBox.setAttribute('role', 'status');
  const error = node('p', panel, null, 'server-settings-error');
  error.id = 'server-accounts-error';
  error.setAttribute('role', 'alert');
  const list = node('div', panel, null, 'server-accounts-list');
  list.id = 'server-accounts-list';
  let generation = 0,
    busy = false,
    rows = [];

  function setBusy(value) {
    busy = value;
    for (const control of panel.querySelectorAll('input,button')) control.disabled = busy;
  }
  /** The link from the answer that made it; the server never shows it again. */
  function showLink(account, link) {
    linkBox.replaceChildren();
    node(
      'p',
      linkBox,
      `Send this link to ${account.name}. It works once, until ${dateTime(link.expires)}. It won’t be shown again.`,
    );
    const row = node('div', linkBox, null, 'server-account-link-row');
    const input = node('input', row);
    Object.assign(input, { type: 'text', readOnly: true, value: link.url, id: 'server-account-link-url' });
    input.setAttribute('aria-label', 'One-time link for ' + account.name);
    const copy = uburoomControls.button(doc, {
      label: 'Copy link',
      icon: 'copy',
      action: async () => {
        try {
          await navigator.clipboard.writeText(link.url);
          uburoomControls.content(copy, { label: 'Copied', icon: 'copy' });
        } catch {
          input.select();
        }
      },
    });
    copy.classList.add('quiet');
    row.append(copy);
    linkBox.hidden = false;
    input.select();
  }
  function status(account) {
    if (account.disabled) return 'Disabled';
    if (!account.passwordSet)
      return account.link ? 'Waiting for password · link until ' + dateTime(account.link.expires) : 'No password yet';
    if (account.link) return 'Active · new link until ' + dateTime(account.link.expires);
    return account.signedInAt ? 'Active' : 'Active · not signed in yet';
  }
  function render() {
    list.replaceChildren();
    if (!rows.length) {
      node('p', list, 'No accounts yet.', 'hint');
      return;
    }
    for (const account of rows) {
      const row = node('div', list, null, 'server-account-row');
      row.dataset.subject = account.subject;
      const who = node('div', row, null, 'server-account-who');
      node('strong', who, account.name);
      node('span', who, account.username, 'hint');
      node('span', who, status(account), 'hint server-account-status');
      const actions = node('div', row, null, 'server-account-actions');
      const action = (label, path, aria) => {
        const button = node('button', actions, label, 'quiet');
        button.type = 'button';
        button.setAttribute('aria-label', aria + ' ' + account.username);
        button.addEventListener('click', () => void act(path, account));
        return button;
      };
      if (!account.disabled) action('New link', '/api/operator/accounts/link', 'New link for');
      if (account.disabled) action('Enable', '/api/operator/accounts/enable', 'Enable');
      else action('Disable', '/api/operator/accounts/disable', 'Disable');
    }
    setBusy(busy);
  }
  async function act(path, account) {
    if (busy) return;
    const id = generation;
    setBusy(true);
    error.textContent = '';
    try {
      const result = await request(path, { subject: account.subject });
      if (id !== generation) return;
      rows = rows.map(row => (row.subject === account.subject ? result.account : row));
      if (result.link) showLink(result.account, result.link);
      else linkBox.hidden = true;
      render();
      list.querySelector(`[data-subject="${CSS.escape(account.subject)}"] button`)?.focus();
    } catch (failure) {
      if (id === generation) error.textContent = failure.message;
    } finally {
      if (id === generation) setBusy(false);
    }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    const id = generation;
    setBusy(true);
    error.textContent = '';
    try {
      const result = await request('/api/operator/accounts', { username: username.value, name: name.value });
      if (id !== generation) return;
      rows = [...rows, result.account].sort((a, b) => a.username.localeCompare(b.username));
      username.value = name.value = '';
      render();
      showLink(result.account, result.link);
    } catch (failure) {
      if (id === generation) error.textContent = failure.message;
    } finally {
      if (id === generation) setBusy(false);
    }
  });
  return {
    async load() {
      const id = ++generation;
      setBusy(true);
      error.textContent = '';
      try {
        const result = await request('/api/operator/accounts');
        if (id !== generation) return;
        rows = result.accounts;
        render();
      } catch (failure) {
        if (id === generation) error.textContent = failure.message;
      } finally {
        if (id === generation) setBusy(false);
      }
    },
    /** Updates the banner explaining whether uburoom accounts can currently sign in. */
    updateAccess({ running, saved } = {}) {
      accessNotice.replaceChildren();
      if (running === undefined || (running && saved !== false)) {
        accessNotice.hidden = true;
        return;
      }
      if (!running && !saved) {
        node(
          'p',
          accessNotice,
          'uburoom account sign-in is turned off. People you add here cannot sign in until you enable it in Access and restart uburoom.',
          'server-source-problem',
        );
        if (onOpenAccess) {
          const openAccess = node('button', accessNotice, 'Open Access settings', 'quiet');
          openAccess.type = 'button';
          openAccess.id = 'server-accounts-open-access';
          openAccess.addEventListener('click', () => onOpenAccess());
        }
      } else if (!running && saved) {
        node(
          'p',
          accessNotice,
          'uburoom account sign-in is enabled in saved settings. Restart uburoom before these accounts can sign in.',
          'server-source-problem',
        );
      } else if (running && saved === false) {
        node(
          'p',
          accessNotice,
          'uburoom account sign-in is turned off in saved settings and will stop working after the next restart.',
          'hint',
        );
      }
      accessNotice.hidden = false;
    },
    /** Forgets the shown link and list when the dialog closes. */
    reset() {
      generation++;
      busy = false;
      rows = [];
      accessNotice.hidden = true;
      accessNotice.replaceChildren();
      linkBox.hidden = true;
      linkBox.replaceChildren();
      list.replaceChildren();
      error.textContent = '';
      username.value = name.value = '';
    },
  };
}
