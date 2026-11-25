import * as uburoomDialogs from '../watch-dialogs.js';
import * as uburoomControls from '../watch-controls.js';
import * as uburoomIcons from '../icons.js';
import * as uburoomPopover from '../watch-popover.js';
import * as uburoomServerSettings from '../server-settings.js';
import * as accountSignIn from '../account-sign-in.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Account dialog: name, linked providers, merging accounts and server settings for administrators. */
export function mount(host, deps) {
  // Uses the watch page's existing authenticated API and shared safe-DOM controls.
  let accountPreview,
    accountMerge,
    accountValue,
    removeProvider,
    removeSubject,
    jellyfinCleanup,
    accountLoad = 0,
    accountNameDraft,
    previewLoad = 0,
    previewSnapshot;
  const accountDialog = $('account-dialog'),
    accountPopups = uburoomDialogs;
  function invalidatePreview() {
    previewLoad++;
    accountPreview = undefined;
    previewSnapshot = undefined;
    $('match-confirm').hidden = true;
    $('match-summary').textContent = '';
    const b = $('match-preview');
    if (b) b.disabled = false;
  }
  accountDialog.addEventListener('close', () => {
    invalidatePreview();
    jellyfinCleanup?.();
    jellyfinCleanup = undefined;
  });
  accountPopups.register(accountDialog, {
    dirty: () =>
      !!accountValue &&
      ($('account-display-name').value !== accountValue.name || !!$('match-discord').value || !!$('match-plex').value),
  });
  $('account-display-name').addEventListener('input', () => {
    accountNameDraft = { id: accountValue?.id, name: $('account-display-name').value };
  });
  const accountButton = $('identity');
  const serverSettingsButton = document.createElement('button');
  serverSettingsButton.id = 'account-server-settings';
  serverSettingsButton.type = 'button';
  serverSettingsButton.className = 'account-server-settings quiet';
  serverSettingsButton.textContent = 'Server settings';
  serverSettingsButton.hidden = true;
  serverSettingsButton.setAttribute('aria-haspopup', 'dialog');
  serverSettingsButton.setAttribute('aria-controls', 'server-settings-dialog');
  $('account-content').append(serverSettingsButton);
  let serverSettingsPanel;
  serverSettingsButton.addEventListener('click', () => {
    if (deps.activity || store.identity.token || serverSettingsButton.hidden) return;
    serverSettingsPanel ||= uburoomServerSettings.mount({ request: deps.api, trigger: serverSettingsButton });
    serverSettingsPanel.open();
  });
  $('account-close').replaceChildren(uburoomIcons.icon(document, 'close'));
  const logoutButton = document.createElement('button');
  logoutButton.id = 'account-logout';
  logoutButton.type = 'button';
  logoutButton.className = 'account-logout quiet browser-button';
  logoutButton.hidden = true;
  logoutButton.append(uburoomIcons.icon(document, 'logout'), document.createTextNode('Log out'));
  $('account-footer').append(logoutButton);
  function updateAccountButton() {
    accountButton.disabled = !store.identity.config?.unifiedAccounts || !store.identity.me;
  }
  function accountError(message = '') {
    $('account-error').textContent = message;
  }
  function identityLabel(identity) {
    if (identity.label) return identity.label;
    if (identity.provider === 'plex') return 'Plex';
    if (identity.provider === 'discord') return 'Discord';
    if (identity.provider === 'uburoom') return 'uburoom account';
    if (identity.provider?.startsWith('jellyfin:')) return 'Jellyfin';
    return identity.provider || '';
  }
  function identityRows(host, account) {
    host.replaceChildren();
    for (const identity of account.identities) {
      const row = document.createElement('p'),
        name = document.createElement('strong'),
        detail = document.createElement('span');
      name.textContent =
        identityLabel(identity) + (identity.name && identity.name !== identity.subject ? ': ' + identity.name : '');
      detail.className = 'hint';
      detail.textContent = identity.assigned && !identity.authenticated ? ' · awaiting sign-in' : '';
      row.append(name, detail);
      host.append(row);
    }
  }
  function renderJellyfinRows(sources, account) {
    jellyfinCleanup?.();
    jellyfinCleanup = undefined;
    const container = $('account-jellyfin-identities');
    if (!container) return;
    container.replaceChildren();
    if (!Array.isArray(sources) || !sources.length) {
      container.hidden = true;
      return;
    }
    container.className = 'account-identities';
    container.hidden = false;
    const isGuest = account.guest === 1;
    let activeCancel;
    jellyfinCleanup = () => {
      activeCancel?.();
      activeCancel = undefined;
    };
    for (const source of sources) {
      const label = sources.length > 1 ? `Jellyfin (${source.name})` : 'Jellyfin';
      const identity = source.identity;
      const connected = !!(identity?.authenticated && identity.credentialStored);
      const name = identity && identity.name !== identity.subject ? identity.name : '';
      const note = !source.memberRule && source.watchState ? ' · watch-state sync' : '';
      const row = document.createElement('div');
      row.className = 'provider-row';
      const details = document.createElement('div');
      details.className = 'provider-details';
      const heading = document.createElement('h3');
      const symbol = document.createElement('span');
      symbol.className = 'plex-symbol';
      const logo = document.createElement('img');
      Object.assign(logo, { src: '/assets/jellyfin-icon.svg', alt: '', width: 28, height: 28 });
      symbol.append(logo);
      heading.append(symbol, document.createTextNode(label));
      const summary = document.createElement('p');
      if (identity) {
        summary.textContent = connected
          ? (name ? 'Connected as ' + name : 'Connected') + note
          : 'Sign-in needed' + (name ? ' · ' + name : '') + note;
      } else if (isGuest) {
        summary.textContent = 'Guests can’t connect accounts';
      } else {
        summary.textContent = 'Not connected' + note;
      }
      details.append(heading, summary);
      const connectBtn = document.createElement('button');
      connectBtn.type = 'button';
      connectBtn.className = 'provider-connect ' + (connected ? 'quiet' : 'primary');
      connectBtn.textContent = !identity ? 'Connect Jellyfin' : connected ? 'Reconnect' : 'Sign in to ' + label;
      connectBtn.hidden = isGuest;
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'icon-button provider-remove';
      removeBtn.append(uburoomIcons.icon(document, 'close'));
      removeBtn.hidden = !identity;
      removeBtn.disabled = !deps.activity && !source.canUnlink;
      removeBtn.setAttribute('aria-label', 'Remove ' + label);
      removeBtn.title = removeBtn.disabled
        ? 'Connect another sign-in method before removing ' + label
        : 'Remove ' + label;
      removeBtn.addEventListener('click', () => {
        if (deps.activity) {
          $('account-dialog').close();
          void deps.openInBrowser({ account: true });
          return;
        }
        removeProvider = identity.provider;
        removeSubject = identity.subject;
        $('account-remove-title').textContent = 'Remove ' + label + '?';
        $('account-remove-description').textContent =
          (identity.name !== identity.subject ? identity.name + ' will be removed from uburoom. ' : '') +
          'You can connect ' +
          label +
          ' again afterward. Your other browsers will be signed out.';
        $('account-remove-confirm').textContent = 'Remove ' + label;
        $('account-remove-error').textContent = '';
        accountPopups.open($('account-remove-dialog'));
      });
      const panel = document.createElement('div');
      panel.className = 'jellyfin-sign-in';
      panel.hidden = true;
      const status = document.createElement('p');
      status.className = 'hint';
      status.hidden = true;
      const formHost = document.createElement('div');
      formHost.hidden = true;
      const quickHost = document.createElement('div');
      quickHost.className = 'jellyfin-quick-connect';
      quickHost.hidden = true;
      const qcPrompt = document.createElement('p');
      qcPrompt.textContent = 'Open Jellyfin → Quick Connect and enter this code';
      const qcCode = document.createElement('p');
      qcCode.className = 'handoff-code';
      const qcExpiry = document.createElement('p');
      qcExpiry.className = 'hint';
      const qcCancel = document.createElement('button');
      qcCancel.type = 'button';
      qcCancel.className = 'quiet';
      qcCancel.textContent = 'Cancel';
      quickHost.append(qcPrompt, qcCode, qcExpiry, qcCancel);
      panel.append(status, formHost, quickHost);

      let pollTimer,
        cancelPending = false,
        panelGen = 0;
      const stopPanel = (sendCancel = false) => {
        panelGen++;
        clearInterval(pollTimer);
        pollTimer = undefined;
        quickHost.hidden = true;
        formHost.hidden = true;
        formHost.replaceChildren();
        status.hidden = true;
        status.textContent = '';
        panel.hidden = true;
        if (sendCancel && cancelPending) {
          cancelPending = false;
          void deps.api('/api/account/jellyfin', { source: source.id, action: 'cancel', link: true }).catch(() => {});
        }
      };
      qcCancel.addEventListener('click', () => {
        stopPanel(true);
        if (activeCancel) activeCancel = undefined;
        connectBtn.focus();
      });
      connectBtn.addEventListener('click', async () => {
        if (deps.activity) {
          $('account-dialog').close();
          void deps.openInBrowser({ account: true });
          return;
        }
        if (!panel.hidden) {
          stopPanel(true);
          activeCancel = undefined;
          return;
        }
        activeCancel?.();
        const myGen = ++panelGen;
        const alive = () => myGen === panelGen && accountDialog.open;
        let cancelRequested = false;
        activeCancel = () => {
          cancelRequested = true;
          stopPanel(true);
        };
        const refreshLinked = async () => {
          activeCancel = undefined;
          panel.hidden = true;
          store.identity.me = await deps.call('me');
          deps.renderAccount?.();
          void showAccount();
        };
        panel.hidden = false;
        status.textContent = 'Contacting Jellyfin…';
        status.hidden = false;
        accountError();
        try {
          const started = await deps.api('/api/account/jellyfin', { source: source.id, action: 'start', link: true });
          if (!alive() || cancelRequested) return;
          status.hidden = true;
          status.textContent = '';
          if (started.password) {
            formHost.hidden = false;
            accountSignIn
              .mount(formHost, {
                idPrefix: 'account-jellyfin-' + source.id,
                label: connectBtn.textContent,
                usernameMaxLength: 200,
                authenticate: (username, password) =>
                  deps.api('/api/account/jellyfin', {
                    source: source.id,
                    action: 'password',
                    username,
                    password,
                    link: true,
                  }),
                onSignedIn: () => {
                  void refreshLinked();
                },
              })
              .focus();
            return;
          }
          cancelPending = true;
          qcCode.textContent = started.code;
          const ends = Date.now() + (Number(started.expiresIn) || 540) * 1000;
          const updateExpiry = () => {
            const minutes = Math.ceil((ends - Date.now()) / 60000);
            qcExpiry.textContent =
              minutes > 1 ? 'Expires in ' + minutes + ' minutes' : minutes === 1 ? 'Expires in 1 minute' : 'Expired';
          };
          updateExpiry();
          pollTimer = setInterval(updateExpiry, 15000);
          quickHost.hidden = false;
          while (alive() && !cancelRequested) {
            await new Promise(resolve => setTimeout(resolve, 3000));
            if (!alive() || cancelRequested) return;
            const polled = await deps.api('/api/account/jellyfin', { source: source.id, action: 'poll', link: true });
            if (alive() && polled.ok) {
              cancelPending = false;
              clearInterval(pollTimer);
              pollTimer = undefined;
              await refreshLinked();
              return;
            }
          }
        } catch (error) {
          if (!alive() || cancelRequested) return;
          cancelPending = false;
          clearInterval(pollTimer);
          pollTimer = undefined;
          quickHost.hidden = true;
          status.textContent = error.message;
          status.hidden = false;
        }
      });
      row.append(details, connectBtn, removeBtn);
      container.append(row, panel);
    }
  }
  async function showAccount() {
    const load = ++accountLoad;
    serverSettingsButton.hidden = true;
    $('account-footer').hidden = true;
    accountError();
    invalidatePreview();
    $('account-content').hidden = true;
    $('account-loading').hidden = false;
    $('account-retry').hidden = true;
    $('account-admin').open = false;
    logoutButton.hidden = deps.activity || !!store.identity.token;
    $('account-footer').hidden = logoutButton.hidden;
    if (!accountDialog.open) accountPopups.open(accountDialog, accountButton);
    try {
      const value = deps.activity ? { account: store.identity.me.account } : await deps.api('/api/account');
      if (!value.account) throw new Error('Restart the server to enable accounts');
      const known = value.admin && !deps.activity ? await deps.api('/api/account/admin') : undefined;
      const isOwner = !!(value.owner ?? store.identity.me?.owner);
      if (load !== accountLoad || !$('account-dialog').open) return;
      serverSettingsButton.hidden = deps.activity || !!store.identity.token || value.serverOperator !== true;
      for (const provider of ['discord', 'plex']) {
        const identity = value.account.identities.find(i => i.provider === provider),
          label = provider === 'discord' ? 'Discord' : 'Plex';
        const connected = identity?.authenticated && (provider !== 'plex' || identity.credentialStored);
        const name = identity && identity.name !== identity.subject ? identity.name : '';
        const disabledServer = store.identity.config.access?.[provider] === false;
        const button = $('connect-' + provider);
        button.disabled = disabledServer;
        button.removeAttribute('title');
        if (identity) {
          if (connected) {
            const note = disabledServer
              ? provider === 'discord' && isOwner
                ? ' · owner sign-in'
                : ' · sign-in disabled'
              : '';
            $(provider + '-identity').textContent = (name ? 'Connected as ' + name : 'Connected') + note;
            button.textContent = 'Reconnect';
            button.className = 'provider-connect quiet';
            button.hidden = false;
            if (disabledServer && provider === 'discord') {
              button.disabled = true;
              button.title = isOwner
                ? 'Ordinary Discord sign-in is disabled; sign in via /auth/owner'
                : 'Discord sign-in is disabled on this server';
            }
          } else {
            $(provider + '-identity').textContent = 'Sign-in needed' + (name ? ' · ' + name : '');
            button.textContent = 'Sign in to ' + label;
            button.className = 'provider-connect ' + (provider === 'discord' ? 'discord-button' : 'primary');
            button.hidden = false;
            if (disabledServer && provider === 'discord' && isOwner) {
              button.disabled = true;
              button.title = 'Ordinary Discord sign-in is disabled; sign in via /auth/owner';
            }
          }
        } else if (value.account.guest === 1) {
          // Guest accounts never gain a provider; signing in starts a separate account.
          $(provider + '-identity').textContent = 'Guests can’t connect accounts';
          button.hidden = true;
        } else {
          $(provider + '-identity').textContent = disabledServer ? 'Unavailable on this server' : 'Not connected';
          button.textContent = 'Connect ' + label;
          button.className = 'provider-connect ' + (provider === 'discord' ? 'discord-button' : 'primary');
          button.hidden = false;
          if (disabledServer && provider === 'discord') {
            button.title = isOwner
              ? 'Ordinary Discord sign-in is disabled; sign in via /auth/owner'
              : 'Discord sign-in is disabled on this server';
          }
        }
        const remove = $('remove-' + provider);
        remove.hidden = !identity;
        remove.disabled = !deps.activity && !identity?.canUnlink;
        remove.title = remove.disabled ? 'Connect another sign-in method before removing ' + label : 'Remove ' + label;
      }
      renderJellyfinRows(value.jellyfin || [], value.account);
      $('account-browser-hint').hidden = !deps.activity;
      $('account-connect-hint').hidden = deps.activity;
      $('account-admin').hidden = deps.activity || !value.admin;
      accountMerge = value.merge;
      $('account-merge').hidden = !accountMerge;
      if (accountMerge) {
        $('account-merge-details').replaceChildren();
        for (const account of accountMerge.accounts) {
          const section = document.createElement('div');
          identityRows(section, account);
          $('account-merge-details').append(section);
        }
      }
      if (known) {
        for (const provider of ['discord', 'plex']) {
          const list = $('known-' + provider);
          list.replaceChildren();
          for (const account of known.accounts)
            for (const identity of account.identities.filter(i => i.provider === provider)) {
              const option = document.createElement('option');
              option.value = identity.subject;
              option.label = identity.name;
              list.append(option);
            }
        }
      }
      accountValue = value.account;
      $('account-display-name').value =
        accountNameDraft?.id === value.account.id ? accountNameDraft.name : value.account.name;
      syncAccountNameSave();
      $('account-content').hidden = false;
    } catch (error) {
      if (load === accountLoad && $('account-dialog').open) {
        accountError(error.message);
        $('account-retry').hidden = false;
      }
    } finally {
      if (load === accountLoad) $('account-loading').hidden = true;
    }
  }
  let savingAccountName = false;
  function syncAccountNameSave() {
    const button = $('account-name-save');
    if (!button || savingAccountName) return;
    const current = ($('account-display-name')?.value || '').trim();
    const saved = (accountValue?.name || '').trim();
    button.disabled = !accountValue || !current || current === saved;
  }
  $('account-display-name')?.addEventListener('input', () => {
    if (accountValue) accountNameDraft = { id: accountValue.id, name: $('account-display-name').value };
    syncAccountNameSave();
  });
  syncAccountNameSave();
  $('account-name-save').addEventListener('click', async () => {
    if (savingAccountName) return;
    const release = accountPopups.hold(accountDialog);
    const submittedName = $('account-display-name').value;
    const button = $('account-name-save');
    savingAccountName = true;
    uburoomControls.busy(button, true, { label: 'Saving name…' });
    accountError();
    try {
      await deps.call('profile.rename', { args: { name: submittedName } });
      store.identity.me = await deps.call('me');
      deps.renderAccount();
      accountValue = store.identity.me.account;
      if ($('account-display-name').value === submittedName) {
        accountNameDraft = undefined;
        $('account-display-name').value = store.identity.me.name;
      }
      uburoomPopover.show(button, { text: 'Saved', state: 'success' });
    } catch (error) {
      accountError(error.message);
      uburoomPopover.show(button, { text: error.message, state: 'error' });
    } finally {
      savingAccountName = false;
      uburoomControls.busy(button, false);
      syncAccountNameSave();
      release();
    }
  });
  accountButton.addEventListener('click', showAccount);
  $('account-retry').addEventListener('click', showAccount);
  $('account-dialog').addEventListener('close', () => {
    if (!accountDialog.open) accountLoad++;
  });
  logoutButton.addEventListener('click', async () => {
    const release = accountPopups.hold(accountDialog);
    logoutButton.disabled = true;
    accountError();
    store.room.pending = true;
    try {
      await deps.api('/api/logout', {});
      deps.stopBrowserHandoff();
      deps.clearPlayer('logout');
      location.replace('/');
    } catch (error) {
      accountError(error.message);
      logoutButton.disabled = false;
      store.room.pending = false;
    } finally {
      release();
    }
  });
  $('account-close').addEventListener('click', () => accountPopups.close(accountDialog));
  for (const provider of ['discord', 'plex']) {
    const button = $('remove-' + provider);
    button.append(uburoomIcons.icon(document, 'close'));
    button.addEventListener('click', () => {
      if (deps.activity) {
        $('account-dialog').close();
        void deps.openInBrowser({ account: true });
        return;
      }
      removeProvider = provider;
      const label = provider === 'discord' ? 'Discord' : 'Plex',
        identity = accountValue.identities.find(i => i.provider === provider);
      removeSubject = identity?.subject;
      $('account-remove-title').textContent = 'Remove ' + label + '?';
      $('account-remove-description').textContent =
        (identity.name !== identity.subject ? identity.name + ' will be removed from uburoom. ' : '') +
        'You can connect ' +
        label +
        ' again afterward. Your other browsers will be signed out.';
      $('account-remove-confirm').textContent = 'Remove ' + label;
      $('account-remove-error').textContent = '';
      accountPopups.open($('account-remove-dialog'));
    });
  }
  $('account-remove-confirm').addEventListener('click', async () => {
    const release = accountPopups.hold($('account-remove-dialog'));
    const button = $('account-remove-confirm'),
      identity = accountValue.identities.find(
        i => i.provider === removeProvider && (!removeSubject || i.subject === removeSubject),
      );
    const subject = removeSubject || identity?.subject;
    const endpoint = removeProvider.startsWith('jellyfin:')
      ? '/api/account/jellyfin/remove'
      : '/api/account/' + removeProvider + '/remove';
    button.disabled = true;
    $('account-remove-error').textContent = '';
    try {
      await deps.api(endpoint, {
        ...(removeProvider.startsWith('jellyfin:') ? { provider: removeProvider } : {}),
        subject,
      });
      location.replace('/?account=1');
    } catch (error) {
      $('account-remove-error').textContent = error.message;
    } finally {
      button.disabled = false;
      release();
    }
  });
  for (const provider of ['plex', 'discord'])
    $('connect-' + provider).addEventListener('click', async () => {
      if (deps.activity) {
        $('account-dialog').close();
        void deps.openInBrowser({ account: true, connectPlex: provider === 'plex' });
        return;
      }
      const release = accountPopups.hold(accountDialog);
      const button = $('connect-' + provider),
        label = button.textContent;
      button.disabled = true;
      button.textContent = 'Opening ' + (provider === 'plex' ? 'Plex' : 'Discord') + '…';
      accountError();
      try {
        const { url } = await deps.api('/api/account/' + provider + '/connect', {});
        location.assign(url);
      } catch (error) {
        accountError(error.message);
      } finally {
        button.disabled = false;
        button.textContent = label;
        release();
      }
    });
  $('account-merge-confirm').addEventListener('click', async () => {
    const release = accountPopups.hold(accountDialog);
    const button = $('account-merge-confirm');
    button.disabled = true;
    accountError();
    try {
      await deps.api('/api/account/merge', { id: accountMerge.id });
      location.replace('/?account=1');
    } catch (error) {
      accountError(error.message);
      button.disabled = false;
    } finally {
      release();
    }
  });
  for (const provider of ['discord', 'plex']) $('match-' + provider).addEventListener('input', invalidatePreview);
  $('match-preview').addEventListener('click', async () => {
    const discordId = $('match-discord').value.trim(),
      plexId = $('match-plex').value.trim();
    const generation = ++previewLoad;
    accountError();
    accountPreview = undefined;
    previewSnapshot = undefined;
    $('match-confirm').hidden = true;
    $('match-summary').textContent = '';
    const previewButton = $('match-preview');
    previewButton.disabled = true;
    try {
      const result = await deps.api('/api/account/admin/preview', { discordId, plexId });
      if (
        generation !== previewLoad ||
        !accountDialog.open ||
        $('match-discord').value.trim() !== discordId ||
        $('match-plex').value.trim() !== plexId
      )
        return;
      accountPreview = result;
      previewSnapshot = { discordId, plexId };
      $('match-summary').textContent =
        'Discord ' +
        accountPreview.discordName +
        ' (' +
        accountPreview.discordId +
        ') ↔ Plex ' +
        accountPreview.plexName +
        ' (' +
        accountPreview.plexId +
        '). ' +
        (accountPreview.accounts.length > 1
          ? 'Merge ' +
            accountPreview.accounts.map(a => a.name).join(' and ') +
            '. Both must leave their watch rooms and sign in again.'
          : accountPreview.accounts.length
            ? 'Attach to ' + accountPreview.accounts[0].name + '.'
            : 'Reserve one account before either identity signs in.');
      $('match-confirm').hidden = false;
    } catch (error) {
      if (
        generation === previewLoad &&
        accountDialog.open &&
        $('match-discord').value.trim() === discordId &&
        $('match-plex').value.trim() === plexId
      )
        accountError(error.message);
    } finally {
      if (generation === previewLoad) previewButton.disabled = false;
    }
  });
  $('match-confirm').addEventListener('click', async () => {
    if (!accountPreview || !previewSnapshot) return;
    if (
      $('match-discord').value.trim() !== previewSnapshot.discordId ||
      $('match-plex').value.trim() !== previewSnapshot.plexId
    )
      return;
    const release = accountPopups.hold(accountDialog);
    const button = $('match-confirm');
    button.disabled = true;
    accountError();
    try {
      await deps.api('/api/account/admin/assign', { id: accountPreview.id });
      accountPreview = undefined;
      previewSnapshot = undefined;
      await showAccount();
      $('match-summary').textContent = 'Match assigned.';
    } catch (error) {
      accountError(error.message);
    } finally {
      button.disabled = false;
      release();
    }
  });
  return { showAccount, updateAccountButton };
}
