import * as uburoomDialogs from '../watch-dialogs.js';
import { WatchTransport as uburoomWatchTransport } from '../watch-transport.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Starting the page: sign-in and entry, the room connection and its messages, browser hand-off from the Discord Activity, and leaving the page. */
export function mount(host, deps) {
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load ' + src));
      document.head.append(script);
    });
  }
  function ensureHls() {
    if (typeof Hls !== 'undefined') return Promise.resolve();
    return (store.connection.hlsLoading ||= loadScript('/vendor/hls.js').catch(error => {
      store.connection.hlsLoading = undefined;
      throw error;
    }));
  }
  function ensureDiscordSdk() {
    if (typeof uburoomDiscord !== 'undefined') return Promise.resolve();
    return (store.connection.discordSdkLoading ||= loadScript('/vendor/discord-sdk.js').catch(error => {
      store.connection.discordSdkLoading = undefined;
      throw error;
    }));
  }
  function renderAccount() {
    deps.loadSyncPreference();
    const identityName = store.identity.me.name + (store.identity.config.demo ? ' · local demo' : '');
    $('identity').textContent = identityName;
    $('identity').setAttribute('aria-label', identityName + ' · Account settings');
    $('admin-mode').hidden = !(store.identity.me.adminEligible ?? store.identity.me.owner);
    $('admin-mode').setAttribute('aria-checked', String(!!store.identity.me.adminMode));
    $('admin-mode').title = store.identity.me.adminMode ? 'Admin mode on: turn off' : 'Admin mode off: turn on';
    $('open-browser').hidden = !deps.activity || store.identity.config.access?.publicWeb === false;
    if (typeof deps.updateAccountButton === 'function') deps.updateAccountButton();
    deps.roomUI.render();
    deps.library.refreshAdmin();
    if (!store.identity.me.adminMode && $('codec-test-dialog').open) $('codec-test-dialog').close();
  }
  function stopBrowserHandoff(cancel = false) {
    deps.time.clearTimeout(store.identity.browserHandoffTimer);
    const id = store.identity.browserHandoff;
    store.identity.browserHandoff = store.identity.browserVerification = undefined;
    $('open-browser').disabled = $('watch-website').disabled = false;
    if (cancel && id)
      void deps.api('/api/watch/handoff/action', { id, action: 'cancel' }, { keepalive: true }).catch(() => {});
  }
  async function pollBrowserHandoff() {
    const id = store.identity.browserHandoff;
    if (!id) return;
    try {
      const value = await deps.api('/api/watch/handoff/status', { id });
      if (store.identity.browserHandoff !== id) return;
      if (value.state === 'complete') {
        stopBrowserHandoff();
        $('handoff-dialog').close('complete');
        return;
      }
      store.identity.browserVerification = value.verification;
      $('handoff-code').textContent = value.verification || '';
      $('handoff-code').hidden = !value.verification;
      $('approve-browser').disabled = value.state !== 'claimed';
      $('handoff-status').textContent =
        value.state === 'waiting'
          ? 'Open uburoom in your browser, then check its code.'
          : value.state === 'approved'
            ? 'Approved. Waiting for your browser…'
            : 'Check the code in your browser.';
      store.identity.browserHandoffTimer = deps.time.setTimeout(pollBrowserHandoff, 1000);
    } catch (error) {
      if (store.identity.browserHandoff === id) {
        stopBrowserHandoff(true);
        $('handoff-dialog').close('expired');
        deps.fail(error.message);
      }
    }
  }
  async function openInBrowser(options) {
    if (!deps.activity || !store.identity.me || store.identity.browserHandoff || $('open-browser').disabled) return;
    const opts = options && typeof options === 'object' && !('target' in options) ? options : {};
    $('open-browser').disabled = $('watch-website').disabled = true;
    // Only the isolated localhost demo uses window.open; live Discord always uses its SDK.
    const demoWindow = store.identity.config.demo ? window.open('about:blank', '_blank') : undefined;
    if (demoWindow) demoWindow.opener = null;
    try {
      if (store.identity.config.demo && !demoWindow)
        throw new Error('Allow this localhost demo to open its browser tab, then retry.');
      const value = await deps.api('/api/watch/handoff', {
        ...(store.room.selected ? { roomId: store.room.selected } : {}),
        ...(opts.account ? { account: true } : {}),
        ...(opts.connectPlex ? { connectPlex: true } : {}),
      });
      store.identity.browserHandoff = value.id;
      if (demoWindow) demoWindow.location.replace(value.url);
      else {
        if (!store.connection.sdk) throw new Error('Discord browser opening is unavailable. Reopen the Activity.');
        const result = await store.connection.sdk.commands.openExternalLink({ url: value.url });
        if (result.opened === false) throw new Error('Browser opening was cancelled. Try Open in Browser again.');
      }
      $('handoff-code').hidden = true;
      $('approve-browser').disabled = true;
      $('handoff-status').textContent = 'Open uburoom in your browser, then check its code.';
      uburoomDialogs.open($('handoff-dialog'));
      void pollBrowserHandoff();
    } catch (error) {
      demoWindow?.close();
      stopBrowserHandoff(true);
      deps.fail(error.message);
    }
  }
  $('open-browser').addEventListener('click', openInBrowser);
  $('watch-website').addEventListener('click', openInBrowser);
  $('handoff-dialog').addEventListener('close', () => stopBrowserHandoff(true));
  $('approve-browser').addEventListener('click', async () => {
    const id = store.identity.browserHandoff;
    if (!id || !store.identity.browserVerification) return;
    const release = uburoomDialogs.hold($('handoff-dialog'));
    $('approve-browser').disabled = true;
    try {
      await deps.api('/api/watch/handoff/action', {
        id,
        action: 'approve',
        verification: store.identity.browserVerification,
      });
    } catch (error) {
      if (store.identity.browserHandoff === id) {
        stopBrowserHandoff(true);
        $('handoff-dialog').close('failed');
        deps.fail(error.message);
      }
    } finally {
      release();
    }
  });
  $('admin-mode').addEventListener('click', async () => {
    $('admin-mode').disabled = true;
    try {
      await deps.call('admin.mode', { args: { enabled: !store.identity.me.adminMode } });
      store.identity.me = await deps.call('me');
      renderAccount();
      await deps.refreshRooms();
      await deps.refreshState();
    } catch (error) {
      deps.fail(error.message);
    } finally {
      $('admin-mode').disabled = false;
    }
  });
  window.addEventListener('pagehide', event => {
    if (!event.persisted && store.identity.viewerId) {
      try {
        sessionStorage.setItem(
          'uburoom.reconnectViewer',
          JSON.stringify({ id: store.identity.viewerId, at: deps.time.wall() }),
        );
      } catch {}
    }
    stopBrowserHandoff(true);
    store.connection.transport?.close();
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted && store.connection.transport)
      void store.connection.transport.connect().catch(error => deps.fail(error.message));
  });
  async function start() {
    store.identity.config = store.identity.pageBootstrap?.config || (await deps.api('/api/watch/config'));
    if (store.identity.config.keepDiagnostics)
      $('diagnostic-report-hint').textContent +=
        ` This server also keeps player diagnostics for ${store.identity.config.keepDiagnostics} ${store.identity.config.keepDiagnostics === 1 ? 'day' : 'days'}.`;
    if (store.identity.config.watchVersion !== 19)
      throw new Error('The player and server versions differ. Reload after the server update.');
    $('plex-login').hidden =
      !store.identity.config.unifiedAccounts ||
      !store.identity.config.plexConfigured ||
      store.identity.config.access?.plex === false;
    const discordButton = $('welcome').querySelector('.discord-button');
    discordButton.hidden = store.identity.config.access?.discord === false;
    const joinPath = !deps.activity && /^\/join\/([^/]+)$/.exec(location.pathname);
    if (joinPath) {
      await deps.inviteEntry(discordButton, deps.inviteCode(decodeURIComponent(joinPath[1])));
      return;
    }
    const roomPathMatch = !deps.activity && /^\/room\/([a-z0-9-]+)$/i.exec(location.pathname);
    const initialRoom =
      store.identity.pageBootstrap?.targetRoom?.id ||
      deps.params.get('room') ||
      (roomPathMatch ? roomPathMatch[1] : undefined);
    if (!deps.activity && initialRoom) {
      const returnSlug =
        store.identity.pageBootstrap?.targetRoom?.slug || (roomPathMatch ? roomPathMatch[1] : undefined);
      const returnTarget = encodeURIComponent(returnSlug ? '/room/' + returnSlug : '/room/' + initialRoom);
      if (discordButton) discordButton.href = '/auth/discord?return=' + returnTarget;
      if ($('plex-login')) $('plex-login').href = '/auth/plex?return=' + returnTarget;
    }
    if (store.identity.config.demo && ['host', 'guest', 'guest2'].includes(deps.params.get('demo'))) {
      if (store.identity.config.accountDemo && !deps.activity)
        await deps.api('/api/account/demo-login', { persona: deps.params.get('demo') });
      else
        deps.acceptIdentity(
          await deps.api('/api/watch/demo-login', { persona: deps.params.get('demo'), activity: deps.activity }),
        );
    } else if (deps.params.has('frame_id') && !store.identity.token) {
      if (!store.identity.config.clientId) throw new Error('Configure Discord OAuth on the server first');
      await ensureDiscordSdk();
      store.connection.sdk = new uburoomDiscord.DiscordSDK(store.identity.config.clientId);
      await store.connection.sdk.ready();
      deps.acceptIdentity(await deps.activityIdentity());
      await store.connection.sdk.subscribe('ACTIVITY_LAYOUT_MODE_UPDATE', deps.updateActivityLayout);
    }
    if (store.identity.config.access) {
      let admission = store.identity.pageBootstrap?.admission || (await deps.api('/api/watch/admission'));
      if (deps.activity && store.identity.token && !admission.identity) {
        store.identity.identityRenewAt = 0;
        store.identity.identityRetryAt = 0;
        await deps.renewIdentity();
        admission = await deps.api('/api/watch/admission');
      }
      if (
        store.identity.config.access.anonymous &&
        !admission.identity &&
        !admission.passwordNeeded &&
        !admission.activityOnly
      ) {
        await deps.api('/api/watch/entry', {});
        admission = await deps.api('/api/watch/admission');
        store.identity.pageBootstrap = undefined;
      }
      if (!admission.admitted) {
        $('auth-loading').hidden = true;
        $('welcome').hidden = false;
        document.body.classList.remove('auth-pending');
        $('empty-title').textContent = admission.activityOnly
          ? 'Discord Activity only'
          : admission.passwordNeeded
            ? 'Enter uburoom'
            : admission.plexRequired
              ? 'Connect Plex to join'
              : 'Sign in to join';
        $('entry-form').hidden = !admission.passwordNeeded || admission.activityOnly;
        $('entry-status').textContent = admission.activityOnly
          ? 'Open uburoom through Discord Activity. Browser playback is disabled.'
          : admission.passwordNeeded
            ? 'Enter this server’s password to continue.'
            : admission.plexRequired
              ? 'This server requires confirmed Plex access. Connect a Plex account with access to the configured server to continue.'
              : admission.identity
                ? 'Your account does not meet this server’s entry requirements. Check your Discord membership or Plex server access.'
                : 'Sign in to join this server.';
        discordButton.hidden =
          store.identity.config.access.discord === false || admission.passwordNeeded || admission.activityOnly;
        $('plex-login').hidden =
          store.identity.config.access.plex === false ||
          admission.passwordNeeded ||
          (admission.activityOnly && !admission.identity);
        if (admission.identity) {
          store.identity.me = { ...admission.pendingIdentity, adminEligible: false };
          renderAccount();
        }
        $('entry-plex-activity').hidden =
          !deps.activity || !admission.identity || admission.passwordNeeded || !store.identity.config.access.plex;
        $('entry-recheck').hidden = !admission.identity;
        if (!deps.activity && !admission.activityOnly) deps.showInviteCodeBox();
        if (
          admission.identity &&
          !deps.activity &&
          deps.params.get('account') === '1' &&
          typeof deps.showAccount === 'function'
        )
          await deps.showAccount();
        return;
      }
      $('entry-form').hidden = true;
    }
    try {
      if (store.identity.pageBootstrap?.me) {
        if (store.identity.pageBootstrap.me.status !== 200)
          throw Object.assign(new Error(store.identity.pageBootstrap.me.value.error), {
            status: store.identity.pageBootstrap.me.status,
          });
        store.identity.me = store.identity.pageBootstrap.me.value;
      } else store.identity.me = await deps.call('me');
    } catch (error) {
      if (deps.activity || error.status !== 401) throw error;
      $('auth-loading').hidden = true;
      $('welcome').hidden = false;
      document.body.classList.remove('auth-pending');
      deps.renderVisibility();
      return;
    }
    renderAccount();
    $('welcome').hidden = true;
    if (store.identity.pageBootstrap?.events?.status === 200)
      deps.lobbyEvents.hydrate(store.identity.pageBootstrap.events.value);
    let initialRooms =
      store.identity.pageBootstrap?.rooms?.status === 200 ? store.identity.pageBootstrap.rooms.value.rooms : undefined;
    let initialEvents = store.identity.pageBootstrap?.events?.status === 200;
    store.identity.directRoomEntry =
      (!deps.activity && !!initialRoom) || !!store.identity.me?.guestRoomId || !!store.identity.config.singleRoom;
    if (store.identity.directRoomEntry) void ensureHls().catch(() => {});
    if (initialRooms) {
      if (store.identity.directRoomEntry) {
        store.lobby.knownRooms = initialRooms;
        deps.renderRooms($('rooms'), initialRooms);
        deps.renderRoomChoices(initialRooms, $('lobby-rooms'));
      } else {
        deps.applyRooms(initialRooms);
        $('auth-overlay').hidden = true;
        document.body.classList.remove('auth-pending');
        deps.placeRoomBar();
      }
    }
    $('diagnostic-actions').hidden = !deps.controlProbe && !deps.soakMode;
    await deps.syncReady;
    let bootstrap;
    async function enterDirectRoom() {
      if (store.identity.me?.guestRoomId) {
        try {
          await deps.selectRoom(store.identity.me.guestRoomId);
        } catch {
          store.identity.directRoomFailed = true;
          deps.guestRoomClosed();
          void deps.waitForHost(store.identity.me.guestRoomId);
        }
        return;
      }
      if (deps.activity && deps.INVITE_CODE.test(store.connection.sdk?.customId || '')) {
        try {
          await deps.selectRoom(
            (await deps.api('/api/watch/invite', { action: 'join', code: store.connection.sdk.customId })).room.id,
          );
        } catch (error) {
          store.identity.directRoomFailed = true;
          deps.fail(error.message);
          if (initialRooms) deps.applyRooms(initialRooms);
        }
        return;
      }
      const requestedRoom =
        store.identity.pageBootstrap?.targetRoom?.id ||
        deps.params.get('room') ||
        (roomPathMatch ? roomPathMatch[1] : undefined);
      if (!deps.activity && requestedRoom) {
        let targetId = requestedRoom;
        if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(targetId)) {
          const found = store.lobby.knownRooms.find(r => r.slug === targetId || r.id === targetId);
          if (found) targetId = found.id;
          else if (store.identity.pageBootstrap?.targetRoom?.id) targetId = store.identity.pageBootstrap.targetRoom.id;
        }
        try {
          await deps.selectRoom(targetId);
        } catch {
          store.identity.directRoomFailed = true;
          deps.syncRoomUrl(null);
          void deps.waitForHost(store.identity.pageBootstrap?.targetRoom?.id || requestedRoom);
          if (!store.lobby.waitingRoom && initialRooms) deps.applyRooms(initialRooms);
        }
        return;
      }
      if (store.identity.config?.singleRoom && store.lobby.knownRooms[0] && !store.lobby.knownRooms[0].locked) {
        try {
          await deps.selectRoom(store.lobby.knownRooms[0].id);
        } catch (error) {
          store.identity.directRoomFailed = true;
          deps.fail(error.message);
          if (initialRooms) deps.applyRooms(initialRooms);
        }
      }
    }
    store.connection.transport?.close();
    store.connection.transport = new uburoomWatchTransport({
      url: location.origin.replace(/^http/, 'ws') + '/watch-socket',
      identity: () => ({ token: store.identity.token, csrf: store.identity.me?.csrf }),
      onReady: () =>
        (bootstrap = (async () => {
          deps.diagnostics.record('control-connected', {
            connectionId: store.connection.transport?.connectionId,
            connectionAttempt: store.connection.transport?.connectionAttempt,
            visibility: document.visibilityState,
          });
          if (store.room.selected) {
            await deps.rejoinRoom();
          } else if (store.identity.directRoomEntry && !store.identity.directRoomFailed) {
            await enterDirectRoom();
          } else {
            if (initialRooms) {
              deps.applyRooms(initialRooms);
              initialRooms = undefined;
            } else await deps.refreshRooms();
          }
          if (store.identity.me?.durableRooms) {
            if (initialEvents) initialEvents = false;
            else void deps.lobbyEvents.refresh();
          }
          if (!store.room.selected) {
            if (store.connection.reconnecting)
              deps.diagnostics.record('control-reconnected', {
                connectionId: store.connection.transport?.connectionId,
                connectionAttempt: store.connection.transport?.connectionAttempt,
              });
            deps.time.clearTimeout(store.connection.disconnectGraceTimer);
            store.connection.disconnectGraceTimer = undefined;
            store.connection.disconnectExtended = false;
            deps.hideDisconnectToast();
            store.connection.reconnecting = false;
            deps.fail('');
          }
          if (!store.identity.directRoomEntry || store.room.selected || store.identity.directRoomFailed) {
            $('auth-loading').hidden = $('auth-overlay').hidden = true;
            document.body.classList.remove('auth-pending');
            deps.renderBrowsing();
            deps.renderVisibility();
            deps.placeRoomBar();
          }
        })()),
      onClose: details => {
        deps.connectionLost(details);
        if (details.code === 4029) deps.fail('Server full; try again when someone leaves');
        if (store.identity.token && details.code === 4003) {
          store.identity.identityRenewAt = 0;
          store.identity.identityRetryAt = 0;
          void deps.renewIdentity().catch(() => {});
        }
      },
      beginClock: () => ({ exchange: deps.time.clock.begin(), sent: deps.time.mono() }),
      onClock: (message, sample) => {
        deps.time.clock.add(sample.exchange, message.timing);
        if (store.room.state) {
          const revision = deps.time.observation.update(
            store.room.state.observationEpoch,
            message.serverNow,
            sample.sent,
            deps.time.mono(),
          );
          if (revision !== store.player.observationClockRevision) {
            store.player.observationBreak++;
            store.player.observationClockRevision = revision;
          }
        }
      },
      onMessage: message => {
        if (message.type === 'error' && message.code === 'removed' && message.roomId === store.room.selected) {
          store.room.selected = store.connection.roomLanes = undefined;
          store.identity.viewerId = crypto.randomUUID();
          // A removed guest has nowhere else to go; their sign-in ends with the room.
          if (store.identity.me?.guestRoomId) {
            deps.unavailable('You were removed from the room.', 'kicked');
            deps.guestRoomClosed();
            $('empty-title').textContent = 'You were removed from the room';
            $('empty-hint').textContent = '';
            store.connection.transport?.close();
            store.identity.identityTimer?.();
          } else deps.unavailable('You were removed from the room. You may rejoin.', 'kicked');
        } else if (message.type === 'lobby') {
          store.identity.me = message.identity;
          renderAccount();
          if (JSON.stringify(message.rooms) !== JSON.stringify(store.lobby.knownRooms)) deps.applyRooms(message.rooms);
        } else if (message.type === 'room' || message.type === 'viewer') {
          const next = message.roomId === store.room.selected ? deps.receiveLane(message) : undefined;
          if (next) {
            deps.applyState(next);
            deps.fail(store.player.playbackError);
            void deps.reportReadiness();
          }
        } else if (message.type === 'error' && message.code === 'room' && message.roomId === store.room.selected) {
          deps.diagnostics.record('room-state-unavailable', {
            status: message.status,
            connectionId: store.connection.transport?.connectionId,
            visibility: document.visibilityState,
          });
          // The room let this tab go (it went private, or the tab went silent). Leaving it
          // selected would make choosing it again do nothing; the lobby offers it to rejoin.
          if (message.rejoin) store.room.selected = store.connection.roomLanes = undefined;
          deps.unavailable(message.message || 'Room unavailable', 'room-poll');
        } else if (message.type === 'error' && message.code === 'protocol') {
          // The server was updated under this page; only a reload brings the matching client.
          deps.unavailable('uburoom was updated. Reload this page to continue.', 'protocol');
        } else if (message.type === 'error' && message.code === 'auth') {
          deps.unavailable(message.message || 'Sign in again', 'identity-poll');
        } else if (message.type === 'error' && message.code === 'unavailable') deps.connectionLost();
      },
    });
    $('create').hidden =
      (store.identity.directRoomEntry && !store.identity.directRoomFailed) ||
      !!store.identity.config?.singleRoom ||
      !!store.identity.me?.guestRoomId;
    deps.renderBrowsing();
    deps.renderVisibility();
    deps.renderTransport();
    store.identity.identityTimer?.();
    store.identity.identityTimer = deps.every(1000, async () => {
      try {
        await deps.renewIdentity();
      } catch (error) {
        deps.unavailable('Disconnected. ' + error.message, 'identity-poll');
      }
    });
    await store.connection.transport.connect();
    await bootstrap;
    if (deps.params.get('account') === '1' && !deps.activity) {
      history.replaceState(history.state, '', '/');
      if (typeof deps.showAccount === 'function') await deps.showAccount();
    }
    const idlePreload =
      typeof requestIdleCallback === 'function' ? requestIdleCallback : fn => deps.time.setTimeout(fn, 250);
    idlePreload(() => {
      void ensureHls().catch(() => {});
    });
  }
  $('entry-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = $('entry-submit');
    button.disabled = true;
    try {
      await deps.api('/api/watch/entry', { password: $('entry-password').value });
      $('entry-password').value = '';
      store.identity.pageBootstrap = undefined;
      await start();
    } catch (error) {
      $('entry-status').textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
  $('entry-recheck').addEventListener('click', () => {
    store.identity.pageBootstrap = undefined;
    void start().catch(error => deps.fail(error.message));
  });
  $('entry-plex-activity').addEventListener('click', () => void openInBrowser({ connectPlex: true }));
  $('room-recovery-start').addEventListener(
    'click',
    () => void deps.execute({ action: 'media.play' }).catch(error => deps.fail(error.message)),
  );
  $('auth-retry').addEventListener('click', () => location.reload());
  return { ensureHls, openInBrowser, renderAccount, start, stopBrowserHandoff };
}
