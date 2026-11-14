import * as uburoomPlayback from './playback-policy.js';
import * as uburoomTiming from '../shared/sync/timing.mjs';
import * as uburoomSyncQuality from '../shared/sync/quality.mjs';
import * as uburoomEvents from './watch-events.js';
import * as uburoomIcons from './icons.js';
import * as uburoomLibrary from './watch-library.js';
import * as uburoomLobbyEvents from './watch-lobby-events.js';
import * as uburoomQueueUI from './watch-queue-ui.js';
import * as uburoomRoomUI from './watch-rooms-ui.js';
import * as uburoomShare from './watch-share.js';
import * as uburoomToasts from './watch-toasts.js';
import { $ } from './watch/page.js';
import { store } from './watch/store.js';
import * as preferences from './watch/preferences.js';
import * as syncWiring from './watch/sync-wiring.js';
import * as syncQualityReport from './watch/sync-quality.js';
import * as diagnostics from './watch/diagnostics.js';
import * as tracksMenu from './watch/tracks-menu.js';
import * as ending from './watch/ending.js';
import * as connection from './watch/connection.js';
import * as layout from './watch/layout.js';
import * as session from './watch/session.js';
import * as delivery from './watch/delivery.js';
import * as player from './watch/player.js';
import * as room from './watch/room.js';
import * as commands from './watch/commands.js';
import * as roomResync from './watch/room-resync.js';
import * as recovery from './watch/recovery.js';
import * as transportBar from './watch/transport-bar.js';
import * as lobby from './watch/lobby.js';
import * as account from './watch/account.js';

import { createScheduler } from './watch/scheduler.js';
import { createTime } from './watch/time.js';
import * as scrollbars from './watch-scrollbars.js';
import * as sidebar from './watch-sidebar.js';

scrollbars.mount();
sidebar.mount();
const scheduler = createScheduler();
const time = createTime();
// The recorder behind this viewer's sync-quality reports (shared/sync/quality.mjs).
const syncQuality = uburoomSyncQuality.create();
const deps = {
  fail,
  fetchArtwork,
  glyph,
  renderScheduleButton,
  syncRoomUrl,
  every: scheduler.every,
  time,
  syncQuality,
};
store.identity.viewerId = (() => {
  try {
    const raw = sessionStorage.getItem('uburoom.reconnectViewer');
    sessionStorage.removeItem('uburoom.reconnectViewer');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.id === 'string' && time.wall() - parsed.at < 60000) {
        return parsed.id;
      }
    }
  } catch {}
  return crypto.randomUUID();
})();
const params = new URLSearchParams(location.search);
deps.params = params;
const activity = params.has('frame_id');
deps.activity = activity;
function syncRoomUrl(id, slug) {
  if (activity) return;
  if (store.identity.config?.singleRoom) {
    if (location.pathname !== '/' || location.search) {
      history.replaceState(null, '', '/' + location.hash);
    }
    return;
  }
  const currentSlug =
    slug ||
    (store.room.state?.id === id ? store.room.state.slug : undefined) ||
    store.lobby.knownRooms.find(r => r.id === id)?.slug;
  const target =
    id && currentSlug ? '/room/' + encodeURIComponent(currentSlug) : id ? '/room/' + encodeURIComponent(id) : '/';
  if (location.pathname !== target || location.search) {
    history.replaceState(null, '', target + location.hash);
  }
}
// The selected room's two lanes as last received: {roomId, viewerId, room, viewer}, each
// lane {version, state} (shared/wire-protocol.mjs).

const DISCONNECT_GRACE_MS = 8000;
deps.DISCONNECT_GRACE_MS = DISCONNECT_GRACE_MS;
store.identity.pageBootstrap = JSON.parse($('watch-bootstrap')?.textContent || 'null');
if (store.identity.pageBootstrap?.config) store.identity.config = store.identity.pageBootstrap.config;
if (store.identity.pageBootstrap?.me?.status === 200) store.identity.me = store.identity.pageBootstrap.me.value;
store.identity.directRoomEntry = Boolean(
  (!activity &&
    (store.identity.pageBootstrap?.targetRoom?.id ||
      /^\/room\/[a-z0-9-]+$/i.test(location.pathname) ||
      new URLSearchParams(location.search).has('room'))) ||
  store.identity.pageBootstrap?.me?.value?.guestRoomId ||
  store.identity.pageBootstrap?.config?.singleRoom,
);

store.player.theater = document.body.classList.contains('theater');
const supportsDocPiP = typeof window !== 'undefined' && 'documentPictureInPicture' in window;
deps.supportsDocPiP = supportsDocPiP;
const supportsVideoPiP =
  typeof document !== 'undefined' &&
  'pictureInPictureEnabled' in document &&
  typeof HTMLVideoElement.prototype.requestPictureInPicture === 'function';
deps.supportsVideoPiP = supportsVideoPiP;
const supportsPiP = supportsDocPiP || supportsVideoPiP;
deps.supportsPiP = supportsPiP;

store.player.lastPresentationBreak = time.mono();
const bufferingViewers = new Map(),
  suppressedBuffering = new Set();
deps.bufferingViewers = bufferingViewers;
deps.suppressedBuffering = suppressedBuffering;

const video = $('video');
deps.video = video;
store.player.subtitleLayout = () => {};
// Button artwork first: modules append their own parts (badges, spinners) to some of these buttons.
function glyph(id, symbol) {
  $(id)?.replaceChildren(uburoomIcons.icon(document, symbol));
}
for (const pair of [
  ['refresh', 'refresh'],
  ['room-symbol', 'armchair-2'],
  ['fullscreen', 'fullscreen'],
  ['join-playback', 'play'],
  ['player-play', 'play'],
  ['previous', 'start'],
  ['seek-back', 'back'],
  ['seek-forward', 'forward'],
  ['next', 'end'],
  ['player-mute', 'volume'],
  ['theater', 'theater'],
  ['pip', 'pip'],
  ['tracks-open', 'settings'],
  ['tracks-close', 'close'],
  ['drawer-symbol', 'drawer'],
  ['media-symbol', 'video'],
  ['drawer-close', 'close'],
  ['admin-mode', 'admin'],
  ['browser-symbol', 'open'],
  ['options-chevron', 'chevron'],
  ['skip-marker-icon', 'player-track-next'],
])
  glyph(...pair);
Object.assign(deps, session.mount(document, deps));
Object.assign(deps, preferences.mount(document, deps));
Object.assign(deps, syncQualityReport.mount(document, deps));
Object.assign(deps, syncWiring.mount(document, deps));
Object.assign(deps, diagnostics.mount($('stage'), deps));
Object.assign(deps, tracksMenu.mount($('tracks-dialog'), deps));
const toasts = uburoomToasts.create($('watch-toasts'), { stage: $('stage') });
deps.toasts = toasts;
function renderNotifications() {
  const button = $('notifications-toggle');
  button.setAttribute('aria-pressed', String(toasts.enabled));
  button.title = toasts.enabled ? 'Hide notifications' : 'Show notifications';
  button.replaceChildren(uburoomIcons.icon(document, toasts.enabled ? 'bell' : 'bell-off'));
}
$('notifications-toggle').onclick = () => {
  toasts.setEnabled(!toasts.enabled);
  renderNotifications();
};
renderNotifications();
const roomEvents = uburoomEvents.mount({ request: (...args) => deps.call(...args) });
deps.roomEvents = roomEvents;
const lobbyEvents = uburoomLobbyEvents.mount({
  request: (...args) => deps.call(...args),
  schedule: options => roomEvents.open(options),
  join: async id => {
    await deps.selectRoom(id);
    if (!store.room.state || store.room.selected !== id) throw new Error('Room unavailable');
    deps.returnToVideo();
  },
  changed: () => {
    renderScheduleButton();
    deps.resolveWait();
    deps.renderWaiting();
  },
  reopen: async id => {
    const opened = await deps.call('room.reopen', { roomId: id }, { timeoutMs: 35000 });
    await deps.selectRoom(opened.id);
    if (!store.room.state) throw new Error('Room unavailable');
    deps.returnToVideo();
  },
});
deps.lobbyEvents = lobbyEvents;
// The room header calendar button needs both hosting and the server's scheduling tier.
function renderScheduleButton() {
  // Shown to everyone the server lets schedule; disabled with its reason for people who are not hosts here.
  const button = $('room-schedule'),
    usable = !!store.room.state?.canManage;
  button.hidden = !store.room.state?.durable || !lobbyEvents.canSchedule();
  // aria-disabled keeps it focusable so the reason is reachable by keyboard and tooltip.
  button.setAttribute('aria-disabled', String(!usable));
  button.title = usable ? 'Schedule event' : 'Only hosts can schedule events';
}
const roomShare = uburoomShare.mount({
  request: (...args) => deps.call(...args),
  share: (...args) => deps.shareInvite(...args),
  openLink: async url => {
    if (activity && store.connection.sdk) {
      const result = await store.connection.sdk.commands.openExternalLink({ url });
      if (!result.opened) throw new Error('Discord could not open the post.');
    } else window.open(url, '_blank', 'noopener,noreferrer');
  },
});
deps.roomShare = roomShare;
const roomUI = uburoomRoomUI.mount({
  request: (...args) => deps.call(...args),
  command: (id, envelope) => deps.roomLink.command(id, envelope),
  getState: () => store.room.state,
  getMe: () => store.identity.me,
  execute: (...args) => deps.execute(...args),
  share: (invite, name, id) => roomShare.open(id || store.room.selected),
  join: async id => {
    await deps.selectRoom(id);
    if (!store.room.state) throw new Error('Room unavailable');
    deps.returnToVideo();
  },
  changed: async () => {
    await deps.refreshRooms();
    if (store.room.selected) await deps.refreshState();
  },
  showChooser: section => deps.chooseRoom(undefined, section),
  fail,
  createDraft: options => deps.createRoom(options),
  draftChanged: options => {
    $('room-name').value = store.lobby.roomNameDraft = options.name;
    $('room-create-visibility').value = store.lobby.roomVisibilityDraft = options.visibility;
    const preset = uburoomRoomUI.presetName(options.permissions);
    $('room-create-preset').value = store.lobby.roomPresetDraft = preset === 'custom' ? '' : preset;
  },
});
deps.roomUI = roomUI;
async function fetchArtwork(path, signal) {
  const response = await fetch(path, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
    headers: store.identity.token ? { Authorization: 'Bearer ' + store.identity.token } : {},
  });
  if (!response.ok) throw new Error('Artwork unavailable');
  return response.blob();
}
const queueUI = uburoomQueueUI.mount($('queue-content'), {
  every: deps.every,
  request: (...args) => deps.call(...args),
  getState: () => store.room.state,
  getMe: () => store.identity.me,
  fail,
  execute: (...args) => deps.execute(...args),
  getSettingsState: () => roomUI.playbackContext(),
  saveSettings: change => roomUI.savePlayback(change),
  openSettings: () => roomUI.open(store.room.state.id, 'playback'),
  browseMedia: (...args) => deps.browseMedia(...args),
  openLibraryItem: item => {
    deps.selectSection('media');
    return library?.openItem(item);
  },
  artwork: fetchArtwork,
  changed: async () => {
    if (store.room.selected) await deps.refreshState();
  },
});
deps.queueUI = queueUI;
Object.assign(deps, ending.mount($('ending-stage'), deps));
const library = uburoomLibrary.mount($('library-content'), {
  request: (op, args, signal) => deps.call(op, { args }, { signal }),
  artwork: fetchArtwork,
  initialLibrary:
    store.identity.pageBootstrap?.library?.status === 200 ? store.identity.pageBootstrap.library.value : undefined,
  load: (item, options) =>
    store.room.selected ? deps.loadLibraryItem(item, options) : deps.chooseRoom(item, 'active', options),
  addToQueue: async (item, trigger) => {
    if (!store.room.selected || !store.room.state?.durable) return;
    await queueUI.add(item, trigger);
  },
  addBulkToQueue: (item, trigger) => queueUI.bulk(item, trigger),
  autoQueue: source => queueUI.openAuto(source),
  close: (...args) => deps.returnToVideo(...args),
  getPlayer: () => store.room.state,
});
deps.library = library;
// Errors go to the menu's error line. In fullscreen they never take over the screen:
// they show as a toast with a way to the fix (the menu by default). The Discord
// Activity has no fullscreen of its own, so it still opens the menu.
function fail(message, action) {
  const changed = $('error').textContent !== message;
  $('error').textContent = message;
  // The error line clears whenever a command starts; a toast stays its full time so it can be read.
  if (!message || !changed) return;
  if (document.fullscreenElement === $('stage')) {
    toasts.show('player-error', {
      type: 'error',
      title: message,
      symbol: 'alert-triangle',
      duration: 12000,
      action: action || { label: 'Open menu', run: () => deps.toggleDrawer(true) },
    });
  } else if (store.player.immersive && !document.body.classList.contains('activity-pip')) deps.toggleDrawer(true);
}
// A person's own Plex sign-in stopped working, for example after a Plex password change.
deps.plexReconnect = message =>
  toasts.show('plex-reconnect', {
    type: 'error',
    title: message,
    symbol: 'alert-triangle',
    persistent: true,
    action: {
      label: 'Reconnect Plex',
      run: async () => {
        if (deps.activity) return void deps.openInBrowser({ account: true, connectPlex: true });
        try {
          const { url } = await deps.api('/api/account/plex/connect', {});
          location.assign(url);
        } catch (error) {
          toasts.show('plex-reconnect', { type: 'error', title: error.message, symbol: 'alert-triangle' });
        }
      },
    },
  });
Object.assign(deps, connection.mount(document, deps));
Object.assign(deps, transportBar.mount($('stage'), deps));
Object.assign(deps, layout.mount(document.body, deps));
Object.assign(deps, delivery.mount($('stage'), deps));
Object.assign(deps, player.mount($('stage'), deps));
Object.assign(deps, recovery.mount($('stage'), deps));
Object.assign(deps, room.mount(document, deps));
Object.assign(deps, commands.mount(document, deps));
Object.assign(deps, roomResync.mount(document, deps));
Object.assign(deps, lobby.mount($('room-lobby'), deps));
deps.renderVisibility();
deps.renderTransport();
deps.start().catch(error => {
  if (!$('auth-loading').hidden) {
    $('auth-title').hidden = false;
    $('auth-title').textContent = 'Couldn’t load uburoom';
    $('auth-status').textContent = error.message;
    $('auth-retry').hidden = false;
  } else fail(error.message);
});
Object.assign(deps, account.mount($('account-dialog'), deps));

// Names the browser runners in scripts/ read or set through page.evaluate. The page used to be one
// classic script, so these were its globals; now only this list is reachable, as accessors.
const harnessState = {
  token: 'identity',
  me: 'identity',
  config: 'identity',
  identityGeneration: 'identity',
  transport: 'connection',
  reconnecting: 'connection',
  selected: 'room',
  state: 'room',
  pending: 'room',
  hls: 'stream',
  mediaSource: 'stream',
  hlsNetworkRetries: 'stream',
  hlsNetworkFailure: 'stream',
  hlsRefreshTimes: 'stream',
  providerNoticeShown: 'stream',
  av1: 'stream',
  playbackError: 'player',
  playerWaiting: 'player',
  sync: 'player',
  theater: 'player',
  immersive: 'player',
  videoFrames: 'player',
  trackNotice: 'player',
};
for (const [name, area] of Object.entries(harnessState))
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get: () => store[area][name],
    set: value => (store[area][name] = value),
  });
for (const name of [
  'api',
  'applyState',
  'captions',
  'decodedFrames',
  'diagnosticSample',
  'diagnostics',
  'execute',
  'expected',
  'fail',
  'library',
  'queueUI',
  'refreshState',
  'reportReadiness',
  'roomLink',
  'selectRoom',
  'toasts',
  'video',
])
  Object.defineProperty(globalThis, name, { configurable: true, get: () => deps[name] });
Object.assign(globalThis, { uburoomPlayback, uburoomTiming, playbackClock: time.clock });
