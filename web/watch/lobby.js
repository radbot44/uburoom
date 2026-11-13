import * as uburoomControls from '../watch-controls.js';
import * as uburoomDialogs from '../watch-dialogs.js';
import * as uburoomIcons from '../icons.js';
import * as uburoomLobbyEvents from '../watch-lobby-events.js';
import * as uburoomUbumfa from '../ubumfa.js';
import { $ } from './page.js';
import { store } from './store.js';

/* Outside a room and choosing one: the room list, waiting for a host, opening rooms, the room chooser and new-room form, library loads and invites. */
export function mount(host, deps) {
  // Someone who arrives for a watch night before a host opens its room waits
  // here and joins as soon as the room opens. Hosts open it from the Upcoming card.

  // target is the room's id or, from a /room/<slug> link, its slug. It is matched
  // against the Upcoming list, which loads once the control socket is ready.
  let waitTarget;
  function waitForHost(target) {
    waitTarget = target;
    resolveWait();
    if (store.connection.transport?.ready) void deps.lobbyEvents.refresh();
  }
  function resolveWait() {
    if (!waitTarget || store.room.selected) return;
    const event = deps.lobbyEvents.events().find(item => item.roomId === waitTarget || item.roomSlug === waitTarget);
    if (!event) return;
    waitTarget = undefined;
    if (event.canManage) return;
    store.lobby.waitingRoom = { id: event.roomId, event };
    renderWaiting();
  }
  function renderWaiting() {
    if (!store.lobby.waitingRoom || store.room.selected) return;
    const { event } = store.lobby.waitingRoom;
    if (Date.parse(event.end) <= deps.time.wall()) {
      store.lobby.waitingRoom = undefined;
      return;
    }
    $('empty-title').textContent = event.title;
    $('empty-hint').textContent =
      (Date.parse(event.start) <= deps.time.wall()
        ? 'Starting now'
        : 'Starts ' + uburoomLobbyEvents.startsLabel(event)) + ' · Waiting for host';
  }
  async function selectRoom(id) {
    if (store.lobby.waitingRoom && store.lobby.waitingRoom.id !== id) store.lobby.waitingRoom = undefined;
    waitTarget = undefined;
    deps.time.clearTimeout(store.connection.disconnectGraceTimer);
    store.connection.disconnectGraceTimer = undefined;
    store.connection.disconnectExtended = false;
    deps.hideDisconnectToast();
    if (id === store.room.selected) return;
    if (store.lobby.switchingRoom) throw new Error('Wait for the room to open.');
    store.lobby.switchingRoom = true;
    const previous = store.room.selected;
    try {
      const exchange = deps.time.clock.begin();
      const hlsReady = deps.ensureHls().catch(() => {});
      let next;
      try {
        next = await deps.roomLink.join(id);
      } catch (error) {
        if (error?.status === 403) store.identity.viewerId = crypto.randomUUID();
        throw error;
      }
      if (next.format === 'hls') await hlsReady;
      if (next.id !== id) throw new Error('Room changed while opening. Try again.');
      deps.syncRoomUrl(id, next.slug);
      store.stream.qualityPending = false;
      store.connection.stateRequestSequence++;
      deps.time.clock.add(exchange, next.timing);
      const now = deps.time.mono(),
        revision = deps.time.observation.update(
          next.observationEpoch,
          deps.time.clock.read().serverTime ?? next.serverNow,
          now,
          now,
        );
      if (revision !== store.player.observationClockRevision) {
        store.player.observationBreak++;
        store.player.observationClockRevision = revision;
      }
      if ($('tracks-dialog').open) $('tracks-dialog').close();
      store.player.trackContext = undefined;
      deps.clearPlayer('room-select');
      store.room.selected = id;
      store.room.state = undefined;
      store.room.lastFeedback = store.lobby.browseRoom = undefined;
      deps.applyState(next);
      deps.placeRoomBar();
      deps.fail(store.player.playbackError);
      void deps.reportReadiness();
      if (previous) void deps.roomLink.leave(previous).catch(() => {});
      if (store.player.immersive) deps.toggleDrawer(!!store.room.state?.canBrowse && !store.room.state?.mediaId);
    } finally {
      store.lobby.switchingRoom = false;
    }
  }
  function renderRooms(host, rooms, join = id => selectRoom(id)) {
    host.replaceChildren();
    if (!rooms.length) {
      const empty = document.createElement('span');
      empty.className = 'hint';
      empty.textContent = 'No active rooms';
      host.append(empty);
    }
    for (const room of rooms) {
      const button = document.createElement('button');
      button.type = 'button';
      button.disabled = !!room.locked;
      button.append(uburoomIcons.icon(document, room.visibility === 'private' ? 'lock' : 'website'));
      const name = document.createElement('span');
      name.textContent = room.name || room.hostName;
      button.append(name, uburoomIcons.icon(document, 'users'));
      const count = document.createElement('span');
      count.textContent = room.maxMembers ? room.viewers + ' / ' + room.maxMembers : String(room.viewers);
      button.append(count);
      button.title = room.locked
        ? 'Private - No one can join'
        : room.members?.length
          ? room.members.join('\n')
          : 'No viewers yet';
      button.setAttribute(
        'aria-label',
        (room.name || room.hostName) +
          (room.visibility === 'private' ? ', private' : '') +
          ', ' +
          room.viewers +
          ' viewers',
      );
      button.setAttribute('aria-pressed', String(room.id === store.room.selected));
      button.addEventListener('click', () => join(room.id).catch(error => deps.fail(error.message)));
      host.append(button);
    }
  }
  async function refreshRooms() {
    try {
      const { rooms } = await deps.call('rooms.list');
      applyRooms(rooms);
    } catch (error) {
      if (!store.room.state) $('lobby-error').textContent = error.message;
      throw error;
    }
  }
  function applyRooms(rooms) {
    store.lobby.knownRooms = rooms;
    if (store.room.selected) deps.syncRoomUrl(store.room.selected);
    $('lobby-error').textContent = '';
    renderRooms($('rooms'), rooms);
    renderRoomChoices(rooms, $('lobby-rooms'));
    if ($('room-dialog').open && !store.lobby.creating) {
      renderRoomChoices(rooms);
    }
    if (
      !store.connection.reconnecting &&
      !store.lobby.switchingRoom &&
      !rooms.some(room => room.id === store.room.selected && !room.locked)
    ) {
      if (store.room.selected) {
        const listed = rooms.find(room => room.id === store.room.selected);
        deps.diagnostics.record('room-list-unavailable', {
          roomListState: listed?.locked ? 'locked' : 'missing',
          roomCount: rooms.length,
          connectionId: store.connection.transport?.connectionId,
          visibility: document.visibilityState,
        });
        store.room.selected = undefined;
        deps.unavailable('Room ended or was made private.');
        if (store.player.immersive) deps.toggleDrawer(false);
      }
    }
    $('status').textContent =
      !store.identity.config?.singleRoom && !store.room.selected && rooms.length
        ? 'Choose an active room or create your own.'
        : '';
    $('create').textContent = 'New room';
    $('create').hidden = !!store.room.selected;
    if (store.identity.config?.singleRoom) {
      for (const id of ['create', 'lobby-create', 'lobby-reopen', 'room-chooser-new']) if ($(id)) $(id).hidden = true;
      $('rooms').hidden = true;
      if (
        !store.room.selected &&
        store.connection.transport?.ready &&
        rooms[0] &&
        !rooms[0].locked &&
        !store.lobby.switchingRoom
      )
        void selectRoom(rooms[0].id).catch(error => deps.fail(error.message));
    }
    if (!store.room.selected) {
      $('stage').classList.remove('ending-active');
      $('ending-stage').hidden = true;
      deps.renderEnding({ ending: null });
      $('viewers').textContent = '';
      $('close-room').hidden = true;
      $('empty-browse').hidden = true;
      $('title').textContent = 'Watch together';
      $('details').textContent = '';
      $('empty-title').textContent = 'Join or create a room';
      $('empty-hint').textContent = 'Choose an active room or create your own.';
      const opened =
        store.lobby.waitingRoom && rooms.find(room => room.id === store.lobby.waitingRoom.id && !room.locked);
      if (opened) {
        store.lobby.waitingRoom = undefined;
        void selectRoom(opened.id)
          .then(() => {
            if (store.room.state) deps.returnToVideo();
          })
          .catch(error => deps.fail(error.message));
      } else renderWaiting();
    }
    deps.placeRoomBar();
    renderBrowsing();
    deps.renderVisibility();
    if (store.identity.config?.singleRoom) $('close-room').hidden = true;
  }
  function renderBrowsing() {
    store.lobby.browseRoom =
      !store.room.selected && store.identity.me
        ? 'lobby'
        : !store.connection.transport?.ready && !store.connection.reconnecting
          ? undefined
          : store.room.state?.canBrowse
            ? store.room.state.id
            : undefined;
    $('library-panel').hidden =
      !store.lobby.browseRoom && $('auth-overlay').hidden && (!store.identity.me || !!store.room.state);
    void deps.library.setRoom(store.lobby.browseRoom);
    deps.library.setBusy(store.room.pending || store.connection.reconnecting);
  }
  function renderLibrary() {
    deps.library.setBusy(store.room.pending || store.connection.reconnecting);
  }
  async function loadLibraryItem(item, options = {}) {
    return deps.execute({
      action: 'media.load',
      args: {
        mediaId: item.id,
        quality: item.id === 'demo' ? 'direct' : store.preferences.preferredQuality,
        ...options,
      },
    });
  }
  let roomChoice, roomChoiceOptions;
  function renderRoomChoices(rooms, container = $('room-choices')) {
    const key = JSON.stringify([
      store.room.selected,
      rooms.map(room => [
        room.id,
        room.name,
        room.hostName,
        room.title,
        room.viewers,
        room.maxMembers,
        room.recovering,
        room.locked,
      ]),
    ]);
    if (container.dataset.roomList === key) return;
    container.dataset.roomList = key;
    const focusedRoom = container.contains(document.activeElement)
      ? document.activeElement.dataset.joinRoom
      : undefined;
    container.replaceChildren();
    if (!rooms.length && container.id !== 'lobby-rooms') {
      const empty = document.createElement('p');
      empty.className = 'hint';
      empty.textContent = 'No active rooms. Create a new room or reopen one of yours.';
      container.append(empty);
    }
    for (const room of rooms) {
      const row = document.createElement('div');
      row.className = 'saved-room';
      const copy = document.createElement('div'),
        name = document.createElement('strong'),
        info = document.createElement('p');
      name.textContent = room.name || room.hostName;
      name.prepend(uburoomIcons.icon(document, room.visibility === 'private' ? 'lock' : 'website'));
      info.className = 'hint';
      info.textContent =
        (room.recovering ? 'Recovering · ' : '') +
        (room.title || 'No video selected') +
        ' · ' +
        room.viewers +
        ' / ' +
        (room.maxMembers || 20) +
        ' people';
      copy.append(name, info);
      const actions = document.createElement('div');
      actions.className = 'room-actions';
      const currentRoom = container.id === 'room-choices' && room.id === store.room.selected;
      const button = document.createElement('button');
      button.className = 'quiet';
      button.dataset.joinRoom = room.id;
      button.textContent = currentRoom ? 'Cancel' : 'Join';
      if (!currentRoom) button.prepend(uburoomIcons.icon(document, 'login'));
      button.disabled = !currentRoom && !!room.locked;
      button.addEventListener('click', async () => {
        if (currentRoom) {
          $('room-dialog').close('cancel');
          return;
        }
        if (store.lobby.creating) return;
        store.lobby.creating = true;
        button.disabled = true;
        $('lobby-error').textContent = '';
        try {
          await selectRoom(room.id);
          if (!store.room.state || store.room.selected !== room.id)
            throw new Error('Room unavailable. Choose another room.');
          $('room-dialog').close('joined');
          deps.returnToVideo();
        } catch (error) {
          $(container.id === 'lobby-rooms' ? 'lobby-error' : 'room-dialog-error').textContent = error.message;
        } finally {
          store.lobby.creating = false;
          button.disabled = !!room.locked;
        }
      });
      actions.append(button);
      row.append(copy, actions);
      container.append(row);
    }
    if (focusedRoom)
      [...container.querySelectorAll('button')]
        .find(button => button.dataset.joinRoom === focusedRoom)
        ?.focus({ preventScroll: true });
  }
  for (const btn of $('room-create-visibility-group')?.querySelectorAll('button') || []) {
    btn.prepend(uburoomIcons.icon(document, btn.dataset.value === 'private' ? 'lock' : 'website'));
  }
  for (const btn of $('room-settings-visibility-group')?.querySelectorAll('button') || []) {
    btn.prepend(uburoomIcons.icon(document, btn.dataset.value === 'private' ? 'lock' : 'website'));
  }
  const roomOptionHints = {
    public: 'Eligible viewers can find and join this room.',
    private: 'Only the room leader and assigned hosts can join.',
    'host-control': 'Hosts control playback and the queue. Viewers have no controls.',
    'play-pause': 'Viewers can play and pause. Hosts control seeking, video choice and the queue.',
    queue: 'Viewers can use all playback and queue controls. Room management stays with hosts.',
    custom: 'Custom permissions. Selecting this option does not change any permissions.',
  };
  for (const group of [
    'room-create-visibility-group',
    'room-create-preset-group',
    'room-settings-visibility-group',
    'room-permission-preset-group',
  ]) {
    for (const button of $(group).querySelectorAll('button')) button.title = roomOptionHints[button.dataset.value];
  }
  $('room-name').placeholder = uburoomUbumfa.roomName();
  store.lobby.roomNameDraft = '';
  store.lobby.roomVisibilityDraft = 'public';
  store.lobby.roomPresetDraft = 'host-control';
  $('room-create-visibility').addEventListener('change', event => {
    store.lobby.roomVisibilityDraft = event.target.value;
  });
  $('room-name').addEventListener('input', event => {
    store.lobby.roomNameDraft = event.target.value;
  });
  function roomChooserSection(section) {
    $('room-create-form').hidden = section !== 'new';
    $('room-create-actions').hidden = section !== 'new';
    $('room-dialog-footer').hidden = section !== 'new';
    $('room-join').hidden = section !== 'active';
    $('room-reopen').hidden = section !== 'saved' || !store.identity.me?.durableRooms;
    $('room-chooser-nav').hidden = section === 'new';
    $('room-chooser-new').hidden = section === 'new';
    $('room-create-back').hidden = section !== 'new' || !store.identity.me?.durableRooms;
    $('room-dialog-title').textContent = section === 'new' ? 'New room' : 'Rooms';
    for (const [id, value] of [
      ['room-show-active', 'active'],
      ['room-show-saved', 'saved'],
    ])
      $(id).setAttribute('aria-pressed', String(section === value));
    $('room-show-saved').hidden = !store.identity.me?.durableRooms;
    $('room-dialog-hint').textContent = roomChoice
      ? 'Create a room to watch ' +
        roomChoice.title +
        '. Joining follows current playback; reopening restores the saved video.'
      : section === 'new'
        ? 'Choose a name and who can join.'
        : 'Choose an active room or restore one of your saved rooms.';
  }
  let openedAsNew = false;
  async function chooseRoom(item, section = 'active', options = {}) {
    const dialog = $('room-dialog');
    if (dialog.open || store.lobby.creating) return { status: 'cancelled' };
    deps.roomUI.clearDraft();
    roomChoice = item;
    roomChoiceOptions = options;
    openedAsNew = section === 'new';
    $('room-dialog-error').textContent = '';
    delete $('room-choices').dataset.roomList;
    $('room-choices').replaceChildren();
    $('room-name').value = store.lobby.roomNameDraft;
    $('room-create-visibility').value = store.lobby.roomVisibilityDraft;
    $('room-create-preset').value = store.lobby.roomPresetDraft;
    roomChooserSection(section);
    const closed = new Promise(resolve =>
      dialog.addEventListener(
        'close',
        () => {
          roomChoice = undefined;
          roomChoiceOptions = undefined;
          resolve({ status: dialog.returnValue === 'cancel' || !dialog.returnValue ? 'cancelled' : 'applied' });
        },
        { once: true },
      ),
    );
    uburoomDialogs.open(dialog);
    (section === 'new' ? $('room-name') : section === 'saved' ? $('room-show-saved') : $('room-show-active')).focus();
    void deps.roomUI.loadSaved(0);
    renderRoomChoices(store.lobby.knownRooms);
    return closed;
  }
  uburoomDialogs.register($('room-dialog'), {
    busy: () => store.lobby.creating,
    dirty: () =>
      !$('room-create-form').hidden &&
      (!!$('room-name').value.trim() ||
        store.lobby.roomVisibilityDraft !== 'public' ||
        store.lobby.roomPresetDraft !== 'host-control'),
  });
  $('room-dialog-footer').addEventListener('submit', event => {
    event.preventDefault();
    if (!store.lobby.creating) void createRoom().catch(error => deps.fail(error.message));
  });
  async function createRoom(advanced = deps.roomUI.draftOptions()) {
    if (store.lobby.creating) return;
    store.lobby.creating = true;
    $('room-create').disabled = true;
    try {
      const customTyped = $('room-name').value.trim();
      const created = await deps.call('rooms.create', {
        args: {
          ...advanced,
          visibility: $('room-create-visibility').value,
          name: customTyped || $('room-name').placeholder,
          isCustom: Boolean(customTyped),
          ...(store.identity.me?.durableRooms && $('room-create-preset').value
            ? { permissionPreset: $('room-create-preset').value }
            : {}),
        },
      });
      await selectRoom(created.id);
      if (store.room.selected !== created.id || !store.room.state) throw new Error('Room unavailable. Try again.');
      const item = roomChoice,
        opts = roomChoiceOptions;
      store.lobby.roomNameDraft = '';
      store.lobby.roomVisibilityDraft = 'public';
      store.lobby.roomPresetDraft = 'host-control';
      $('room-name').value = '';
      $('room-name').placeholder = uburoomUbumfa.roomName();
      $('room-dialog').close('created');
      deps.roomUI.clearDraft();
      renderLibrary();
      if (item) {
        const result = await loadLibraryItem(item, opts);
        if (result?.status !== 'applied') throw new Error('Playback was not accepted; try again from the library.');
        deps.returnToVideo();
      }
    } catch (error) {
      if ($('room-dialog').open) $('room-dialog-error').textContent = error.message;
      else deps.fail(error.message);
      if (advanced && Object.keys(advanced).length) throw error;
    } finally {
      store.lobby.creating = false;
      $('room-create').disabled = false;
    }
  }
  for (const id of ['create', 'lobby-create']) $(id).addEventListener('click', () => void chooseRoom(undefined, 'new'));
  for (const id of ['switch-room']) $(id).addEventListener('click', () => void chooseRoom());
  $('room-dialog-close').addEventListener('click', () => uburoomDialogs.close($('room-dialog')));
  $('room-create-cancel').addEventListener('click', () => {
    if (roomChoice || openedAsNew) uburoomDialogs.close($('room-dialog'), 'cancel');
    else roomChooserSection('active');
  });
  $('room-create').addEventListener('click', () => void createRoom().catch(error => deps.fail(error.message)));
  $('room-create-settings').replaceChildren(uburoomIcons.icon(document, 'settings'));
  $('room-create-settings').addEventListener('click', () =>
    deps.roomUI.openDraft({
      name: $('room-name').value,
      visibility: $('room-create-visibility').value,
      permissionPreset: $('room-create-preset').value,
    }),
  );
  $('room-create-preset').addEventListener('change', () => {
    store.lobby.roomPresetDraft = $('room-create-preset').value;
    deps.roomUI.updateDraftPreset(store.lobby.roomPresetDraft);
  });
  $('room-chooser-new').addEventListener('click', () => {
    roomChooserSection('new');
    if (store.lobby.roomNameDraft) $('room-name').value = store.lobby.roomNameDraft;
    $('room-name').focus();
  });
  $('room-create-back').addEventListener('click', () => {
    roomChooserSection('saved');
    void deps.roomUI.loadSaved(0);
  });
  $('room-show-active').addEventListener('click', () => roomChooserSection('active'));
  $('room-show-saved').addEventListener('click', () => roomChooserSection('saved'));
  $('room-chooser-refresh').addEventListener('click', () => {
    void deps.roomUI.loadSaved(0);
    void refreshRooms().catch(error => ($('room-dialog-error').textContent = error.message));
  });
  function browseMedia() {
    const panel = $('library-panel');
    if (store.player.immersive) {
      deps.toggleDrawer(true);
      deps.selectSection('media');
    } else {
      deps.selectSection('media');
      deps.library.reveal('smooth');
    }
    panel.classList.remove('media-glow');
    void panel.offsetWidth;
    panel.classList.add('media-glow');
  }
  $('library-panel').addEventListener('animationend', event => {
    if (event.animationName === 'media-glow') $('library-panel').classList.remove('media-glow');
  });
  if (!$('empty-browse').querySelector('svg')) $('empty-browse').prepend(uburoomIcons.icon(document, 'media'));
  $('empty-browse').addEventListener('click', browseMedia);
  $('close-room').addEventListener('click', async () => {
    if (!store.room.selected || store.room.pending) return;
    const id = store.room.selected;
    store.room.pending = true;
    try {
      await deps.roomLink.leave(id);
      store.room.selected = undefined;
      store.lobby.browseRoom = undefined;
      deps.unavailable('', 'leave');
      await refreshRooms();
    } catch (error) {
      deps.fail(error.message);
    } finally {
      store.room.pending = false;
      renderLibrary();
    }
  });
  $('admin-end-room').addEventListener('click', () => {
    if (store.room.state?.adminMode) void deps.roomUI.open(store.room.state.id, 'manage');
  });
  $('refresh').addEventListener('click', () => refreshRooms().catch(error => deps.fail(error.message)));
  // Room invites: /join/<code> or a code typed on the sign-in screen. People the
  // server already admits go straight to the room; others may join as guests when
  // the room allows it.
  const INVITE_CODE = /^[a-z]{6}-[a-z]{6}$/;
  function inviteCode(text) {
    const letters = String(text || '')
      .toLowerCase()
      .replace(/[^a-z]/g, '');
    return letters.length === 12 ? letters.slice(0, 6) + '-' + letters.slice(6) : undefined;
  }
  function showInviteCodeBox() {
    $('invite-code-form').hidden = false;
    $('invite-code-form').onsubmit = event => {
      event.preventDefault();
      const code = inviteCode($('invite-code').value);
      if (!code) {
        $('entry-status').textContent = 'An invite code is two six-letter words, like ubumfa-ogdave.';
        return;
      }
      location.assign('/join/' + code);
    };
  }
  async function inviteEntry(discordButton, code) {
    const show = (title, message) => {
      $('auth-loading').hidden = true;
      $('welcome').hidden = false;
      document.body.classList.remove('auth-pending');
      $('empty-title').textContent = title;
      $('empty-hint').textContent = '';
      $('entry-status').textContent = message;
      $('entry-form').hidden = true;
      $('entry-recheck').hidden = true;
      $('entry-plex-activity').hidden = true;
    };
    const signIn = visible => {
      for (const button of [discordButton, $('plex-login')])
        button.href = button.href.split('?')[0] + '?return=' + encodeURIComponent('/join/' + code);
      discordButton.hidden = !visible.discord;
      $('plex-login').hidden = !visible.plex;
    };
    const enter = room => location.replace('/room/' + room.slug);
    if (!code) {
      signIn({});
      show('Invite code not recognized', 'An invite code is two six-letter words, like ubumfa-ogdave.');
      showInviteCodeBox();
      return;
    }
    let preview;
    try {
      preview = await deps.api('/api/watch/invite', { action: 'preview', code });
    } catch (error) {
      signIn({});
      show('Invite unavailable', error.message);
      showInviteCodeBox();
      return;
    }
    const providers = {
      discord: preview.providers.discord && store.identity.config.access?.discord !== false,
      plex: preview.providers.plex && store.identity.config.unifiedAccounts && store.identity.config.plexConfigured,
    };
    if (preview.member || (preview.signedIn && preview.guestsAllowed)) {
      show(
        'Joining ' + preview.room.name,
        (preview.signedIn ? 'Signed in as ' + preview.name + '. ' : '') + 'Joining the room…',
      );
      signIn({});
      try {
        enter((await deps.api('/api/watch/invite', { action: 'join', code })).room);
      } catch (error) {
        $('entry-status').textContent = error.message;
      }
      return;
    }
    signIn(providers);
    if (!preview.guestsAllowed) {
      show(
        'Join ' + preview.room.name,
        'Sign in with an account that can join this server. This room isn’t taking guests right now.',
      );
      return;
    }
    if (preview.signInRequired) {
      show('Join ' + preview.room.name, 'Sign in with Discord or Plex to join as a guest.');
      return;
    }
    show('Join ' + preview.room.name + ' as a guest', 'Pick a name to show in the room.');
    $('guest-join').hidden = false;
    $('guest-sign-in-label').hidden = !providers.discord && !providers.plex;
    const name = $('guest-name'),
      roll = $('guest-name-roll');
    if (!roll.firstChild)
      uburoomControls.content(roll, { label: 'New random name', icon: 'arrows-shuffle', iconOnly: true });
    const rollName = () => {
      name.value = uburoomUbumfa.ubunym().fullName;
    };
    if (!name.value) rollName();
    roll.onclick = rollName;
    $('guest-join').onsubmit = async event => {
      event.preventDefault();
      const button = $('guest-join-submit');
      button.disabled = true;
      try {
        enter((await deps.api('/api/watch/invite', { action: 'join', code, name: name.value })).room);
      } catch (error) {
        $('entry-status').textContent = error.message;
        button.disabled = false;
      }
    };
  }
  // A guest only ever sees their own room.
  function guestRoomClosed() {
    $('auth-loading').hidden = $('auth-overlay').hidden = true;
    document.body.classList.remove('auth-pending');
    $('empty-title').textContent = 'This room isn’t open right now';
    $('empty-hint').textContent = 'You can join once a host opens it again.';
    for (const id of [
      'lobby-create',
      'lobby-reopen',
      'room-chooser-new',
      'create',
      'reopen',
      'switch-room',
      'room-bar',
    ])
      if ($(id)) $(id).hidden = true;
  }
  return {
    INVITE_CODE,
    applyRooms,
    browseMedia,
    chooseRoom,
    createRoom,
    guestRoomClosed,
    inviteCode,
    inviteEntry,
    loadLibraryItem,
    refreshRooms,
    renderBrowsing,
    renderLibrary,
    renderRoomChoices,
    renderRooms,
    renderWaiting,
    resolveWait,
    selectRoom,
    showInviteCodeBox,
    waitForHost,
  };
}
