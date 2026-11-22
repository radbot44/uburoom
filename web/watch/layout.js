import * as uburoomIcons from '../icons.js';
import { $ } from './page.js';
import { PHONE_LAYOUT } from './breakpoints.js';
import { store } from './store.js';

/* Page layout: section panels and tabs, the drawer, theater, the phone player, fullscreen and Picture-in-Picture, and the Discord Activity layout. */
export function mount(host, deps) {
  // Move the actual shells so their controls, state and listeners stay shared.
  const sections = [
    ['room', 'Room', 'options-panel'],
    ['queue', 'Queue', 'queue-panel'],
    ['media', 'Media', 'library-panel'],
  ];
  // Collapse the shared panels without rebuilding their live controls.
  const sectionToggles = sections.map(([key, , id]) => {
    const panel = $(id),
      heading = panel.querySelector('h2');
    let button = heading.querySelector('.section-toggle');
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'section-toggle';
      button.id = key + '-collapse';
      button.append(...heading.childNodes, uburoomIcons.icon(document, 'chevron'));
      heading.append(button);
    }
    button.setAttribute(
      'aria-controls',
      key === 'room' ? 'options-content' : key === 'media' ? 'library-content' : 'queue-body',
    );
    button.addEventListener('click', () => {
      if (store.player.layout === 'phone') return;
      panel.classList.toggle('section-collapsed');
      updateSectionTabs();
    });
    return { panel, button };
  });
  let mobileSection;
  const sectionTabs = $('section-tabs') || document.createElement('nav');
  if (!sectionTabs.parentElement) {
    sectionTabs.id = 'section-tabs';
    sectionTabs.hidden = true;
    sectionTabs.setAttribute('role', 'tablist');
    sectionTabs.setAttribute('aria-label', 'Room sections');
    $('viewing-section').after(sectionTabs);
  }
  for (const [key, label, panel] of sections) {
    let tab = $('section-tab-' + key);
    if (!tab) {
      tab = document.createElement('button');
      tab.id = 'section-tab-' + key;
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-controls', panel);
      tab.dataset.section = key;
      tab.append(
        uburoomIcons.icon(document, key === 'room' ? 'armchair-2' : key === 'queue' ? 'player-track-next' : 'video'),
      );
      tab.append(document.createTextNode(label));
      sectionTabs.append(tab);
    }
    tab.addEventListener('click', () => selectSection(key));
  }
  function selectSection(key, focus = false) {
    if (mobileSection === 'queue' && key !== 'queue') deps.queueUI.rememberPosition();
    mobileSection = key;
    updateSectionTabs();
    if (key === 'queue') deps.queueUI.restorePosition();
    if (focus) $('section-tab-' + key).focus();
  }
  function updateSectionTabs() {
    const mobile = store.player.layout === 'phone';
    if (!mobileSection && mobile && store.identity.me)
      mobileSection = store.room.state?.durable || store.identity.directRoomEntry ? 'room' : 'media';
    if (mobileSection === 'queue' && store.room.state && !store.room.state.durable) mobileSection = 'media';
    sectionTabs.hidden = !mobile;
    for (const { panel, button } of sectionToggles) {
      button.disabled = mobile;
      button.setAttribute('aria-expanded', String(mobile || !panel.classList.contains('section-collapsed')));
    }
    for (const [key, , id] of sections) {
      const panel = $(id),
        tab = $('section-tab-' + key),
        active = key === (mobileSection || 'media');
      tab.disabled = key === 'queue' && !!store.room.state && !store.room.state.durable;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      panel.classList.toggle('section-tab-inactive', mobile && !active);
      if (mobile) {
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
      } else {
        panel.removeAttribute('role');
        panel.removeAttribute('aria-labelledby');
      }
    }
  }
  sectionTabs.addEventListener('keydown', event => {
    const tabs = [...sectionTabs.querySelectorAll('button:not(:disabled)')];
    const index = tabs.indexOf(document.activeElement);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next >= 0) {
      event.preventDefault();
      selectSection(tabs[next].dataset.section, true);
    }
  });
  const drawer = document.createElement('aside');
  drawer.id = 'drawer';
  drawer.classList.add('drawer');
  drawer.hidden = true;
  drawer.setAttribute('aria-label', 'Menu');
  document.body.append(drawer);
  const shells = [
    'account',
    'section-tabs',
    'options-panel',
    'queue-panel',
    'library-panel',
    'status',
    'error',
    'diagnostic-actions',
    'acceleration-help',
  ].map(id => {
    const element = $(id),
      marker = document.createComment(id);
    element.before(marker);
    return { element, marker };
  });
  function toggleDrawer(show = drawer.hidden) {
    $('library-panel').classList.remove('media-glow');
    show = !!show && store.player.immersive && !document.body.classList.contains('activity-pip');
    const parent = document.fullscreenElement === $('stage') ? $('stage') : document.body;
    if (drawer.parentElement !== parent) parent.append(drawer);
    parent.append($('drawer-close'));
    $('drawer-close').hidden = !show;
    drawer.hidden = !show;
    $('stage').classList.toggle('drawer-open', show);
    $('drawer-open').setAttribute('aria-expanded', String(show));
  }
  function returnToVideo() {
    toggleDrawer(false);
    window.scrollTo({ top: 0, behavior: 'instant' });
    $('stage').focus({ preventScroll: true });
  }
  $('library-top').addEventListener('click', returnToVideo);
  function setTheater(enabled, remember = true) {
    store.player.theater = !deps.activity && store.player.layout !== 'phone' && !!enabled;
    document.body.classList.toggle('theater', store.player.theater);
    $('theater').setAttribute('aria-pressed', String(store.player.theater));
    $('theater').title = $('theater').ariaLabel = store.player.theater ? 'Exit theater mode' : 'Theater mode';
    if (remember && !deps.activity) {
      try {
        localStorage.setItem('uburoom.watchMode', store.player.theater ? 'theater' : 'normal');
      } catch {}
    }
    updateViewingLayout();
  }
  // The phone layout follows the phone breakpoint, and stays while fullscreen lasts so rotating a phone does
  // not switch layouts under the video. One value in the store, mirrored to body[data-layout] for the CSS.
  const phoneLayout = matchMedia(PHONE_LAYOUT);
  function updateMobilePlayer() {
    const mobile = phoneLayout.matches || (!!document.fullscreenElement && store.player.layout === 'phone');
    store.player.layout = mobile ? 'phone' : 'wide';
    document.body.dataset.layout = store.player.layout;
    if (mobile && store.player.theater && !store.player.immersive && !document.fullscreenElement)
      setTheater(false, false);
    updateSectionTabs();
  }
  function updateViewingLayout() {
    if (!store.player.immersive)
      document.documentElement.style.setProperty(
        '--watch-header-height',
        $('viewing-section').getBoundingClientRect().top + scrollY + 'px',
      );
  }
  const viewingLayoutObserver = new ResizeObserver(updateViewingLayout);
  viewingLayoutObserver.observe($('account'));
  viewingLayoutObserver.observe($('viewing-section'));
  window.addEventListener('scroll', () => document.body.classList.toggle('page-scrolled', scrollY > 0), {
    passive: true,
  });
  function updateFullscreenLayout() {
    store.player.immersive = deps.activity || document.fullscreenElement === $('stage');
    const drawerOpen = !drawer.hidden;
    document.body.classList.toggle('immersive', store.player.immersive);
    for (const { element, marker } of shells) store.player.immersive ? drawer.append(element) : marker.after(element);
    $('drawer-open').hidden = $('drawer-close').hidden = !store.player.immersive;
    toggleDrawer(drawerOpen);
    placeRoomBar();
    updateSectionTabs();
    updateViewingLayout();
  }
  function placeRoomBar() {
    $('room-bar').hidden = !store.identity.me && $('auth-overlay').hidden;
    const inRoom = Boolean(store.room.selected || store.identity.directRoomEntry);
    const lobbyHidden = inRoom || !store.identity.me;
    const opening = $('room-lobby').hidden && !lobbyHidden;
    $('room-lobby').hidden = lobbyHidden;
    if (opening) {
      if (store.lobby.knownRooms) deps.renderRoomChoices?.(store.lobby.knownRooms, $('lobby-rooms'));
      // The Upcoming list refreshes whenever the lobby comes back into view.
      if (store.connection.transport?.ready && store.identity.me?.durableRooms && !store.identity.config?.singleRoom)
        void deps.lobbyEvents.refresh();
    }
  }
  function updateActivityLayout(event) {
    if (event) store.player.layoutMode = event.layout_mode;
    const pip =
      deps.activity &&
      (store.player.layoutMode === 1 ||
        (store.player.layoutMode === undefined && innerWidth <= 480 && innerHeight <= 300));
    document.body.classList.toggle('activity-pip', pip);
    if (pip) toggleDrawer(false);
    if (pip && $('account-dialog').open) $('account-dialog').close();
    if (pip) {
      store.player.playerUI?.reset();
      if ($('tracks-dialog').open) $('tracks-dialog').close();
    }
  }
  document.body.classList.toggle('activity', deps.activity);
  $('fullscreen').hidden = $('theater').hidden = deps.activity;
  $('pip').hidden = deps.activity || !deps.supportsPiP;
  if (deps.activity) {
    $('brand-link').href = '/' + location.search;
    $('brand-link').setAttribute('aria-label', 'uburoom watch');
    $('welcome').hidden = true;
  } else {
    $('brand-link').href = '/';
    $('brand-link').setAttribute('aria-label', 'uburoom watch');
  }
  updateMobilePlayer();
  phoneLayout.addEventListener('change', updateMobilePlayer);
  setTheater(store.player.theater, false);
  updateFullscreenLayout();
  updateActivityLayout();
  window.addEventListener('resize', () => {
    updateMobilePlayer();
    updateActivityLayout();
    deps.renderTransport();
  });
  $('theater').addEventListener('click', async () => {
    if (deps.activity) return;
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setTheater(true);
      } else setTheater(!store.player.theater);
    } catch (error) {
      deps.fail(error.message);
    }
  });

  async function togglePictureInPicture() {
    if (deps.activity || !deps.supportsPiP) return;
    if (store.player.pipWindow) {
      store.player.pipWindow.close();
      return;
    }
    if (document.pictureInPictureElement) {
      await document.exitPictureInPicture();
      return;
    }
    if (!store.room.state?.mediaUrl) return;

    if (deps.supportsDocPiP) {
      const stage = $('stage'),
        viewingSection = $('viewing-section'),
        placeholder = $('pip-placeholder');
      const width = Math.min(Math.max(deps.video.videoWidth || stage.clientWidth || 640, 320), 1920);
      const height = Math.min(Math.max(deps.video.videoHeight || stage.clientHeight || 360, 180), 1080);
      const win = await window.documentPictureInPicture.requestWindow({
        width,
        height,
        preferInitialWindowPlacement: true,
      });
      for (const sheet of document.styleSheets) {
        try {
          if (sheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            win.document.head.append(link);
          } else if (sheet.cssRules) {
            const rules = [...sheet.cssRules].map(r => r.cssText).join('\n');
            const style = document.createElement('style');
            style.textContent = rules;
            win.document.head.append(style);
          }
        } catch {
          if (sheet.href) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = sheet.href;
            win.document.head.append(link);
          }
        }
      }
      win.document.title = document.title || 'uburoom';
      const syncPipTheme = event => {
        win.document.documentElement.dataset.theme =
          event?.detail?.theme || document.documentElement.dataset.theme || 'dark';
      };
      syncPipTheme();
      window.addEventListener('uburoom-theme', syncPipTheme);
      win.document.body.className = 'pip-window';
      const sprite = document.getElementById('icon-sprite');
      if (sprite && !win.document.getElementById('icon-sprite'))
        win.document.body.append(win.document.importNode(sprite, true));
      placeholder.hidden = false;
      win.document.body.append(stage);
      store.player.pipWindow = win;
      deps.renderTransport();

      if (deps.handleStageKeydown) win.document.addEventListener('keydown', deps.handleStageKeydown);

      win.addEventListener(
        'pagehide',
        () => {
          window.removeEventListener('uburoom-theme', syncPipTheme);
          if (deps.handleStageKeydown) win.document.removeEventListener('keydown', deps.handleStageKeydown);
          if (store.player.pipWindow === win) {
            store.player.pipWindow = null;
            viewingSection.insertBefore(stage, placeholder);
            placeholder.hidden = true;
            deps.renderTransport();
            stage.focus({ preventScroll: true });
          }
        },
        { once: true },
      );
    } else if (deps.supportsVideoPiP) {
      await deps.video.requestPictureInPicture();
      const tracks = store.room.state?.tracks;
      const hasSubtitles = !!tracks?.subtitleId;
      const subtitleTrack = tracks?.subtitles?.find(track => track.id === tracks.subtitleId);
      const isBurned =
        (tracks?.subtitleDelivery || subtitleTrack?.delivery || tracks?.subtitleMode || 'auto') === 'burn';
      if (hasSubtitles && !isBurned) {
        deps.toasts.show('pip-subtitles', {
          title: 'Subtitles in Picture-in-Picture',
          hint: 'Client subtitles require Document PiP or burn-in.',
          symbol: 'subtitles',
          duration: 8000,
          action: {
            label: 'Burn-in settings',
            run: () => {
              store.player.playerUI.openDialog('subtitle-mode');
            },
          },
        });
      }
    }
  }
  $('pip').addEventListener('click', () => {
    togglePictureInPicture().catch(error => deps.fail(error.message));
  });
  $('pip-return').addEventListener('click', () => {
    togglePictureInPicture().catch(error => deps.fail(error.message));
  });
  deps.video.addEventListener('enterpictureinpicture', () => {
    deps.renderTransport();
  });
  deps.video.addEventListener('leavepictureinpicture', () => {
    deps.renderTransport();
  });
  $('drawer-open').addEventListener('click', () => {
    if (!store.player.immersive) return;
    toggleDrawer();
    if (!drawer.hidden) $('drawer-close').focus();
  });
  $('drawer-close').addEventListener('click', () => {
    toggleDrawer(false);
    $('drawer-open').focus();
  });
  document.addEventListener('pointerdown', event => {
    if (
      !drawer.hidden &&
      !event.composedPath().some(node => ['drawer', 'drawer-open', 'drawer-close'].includes(node.id)) &&
      !event
        .composedPath()
        .some(
          node => node instanceof HTMLDialogElement || node.matches?.('.player-settings-menu, .viewer-telemetry-card'),
        )
    ) {
      toggleDrawer(false);
      $('stage').focus({ preventScroll: true });
    }
  });
  $('fullscreen').addEventListener('click', () => {
    // iPhones allow fullscreen only on the video itself, never on the player around it.
    if (!$('stage').requestFullscreen)
      return deps.video.webkitEnterFullscreen
        ? deps.video.webkitEnterFullscreen()
        : deps.fail('This browser cannot go fullscreen.');
    (document.fullscreenElement ? document.exitFullscreen() : $('stage').requestFullscreen()).catch(error =>
      deps.fail(error.message),
    );
  });
  deps.video.addEventListener('webkitbeginfullscreen', () => {
    if (deps.captions.nativeFullscreen(true))
      deps.toasts.show('native-fullscreen-subtitles', {
        title: 'Subtitles need burn-in here',
        hint: 'Choose Burn-in in Subtitle settings to see them in iPhone fullscreen.',
        symbol: 'subtitles',
      });
  });
  deps.video.addEventListener('webkitendfullscreen', () => {
    deps.captions.nativeFullscreen(false);
  });
  document.addEventListener('fullscreenchange', () => {
    updateMobilePlayer();
    updateFullscreenLayout();
    deps.glyph('fullscreen', document.fullscreenElement ? 'fullscreenExit' : 'fullscreen');
    $('fullscreen').title = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    $('fullscreen').setAttribute('aria-label', $('fullscreen').title);
  });
  return { drawer, placeRoomBar, returnToVideo, selectSection, toggleDrawer, updateActivityLayout, updateSectionTabs };
}
