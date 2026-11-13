/* Customize the document and selected safe scroll areas without replacing scroll targets. */
export function mount() {
  const OverlayScrollbars = window.OverlayScrollbarsGlobal?.OverlayScrollbars;
  if (!OverlayScrollbars) return; // Missing vendor script: keep all scrollbars native.

  // OverlayScrollbars injects a temporary <style> to detect scrollbar support.
  // Supply its per-response CSP nonce before the first API call.
  const styleNonce = document.querySelector('script[data-os-style-nonce]')?.dataset.osStyleNonce;
  if (styleNonce) OverlayScrollbars.nonce(styleNonce);

  const body = document.body;
  const isScrollLocked = () => body.classList.contains('immersive') || body.classList.contains('activity-pip');
  const theme = {
    theme: 'os-theme-uburoom',
    autoHide: 'scroll',
    autoHideDelay: 1000,
    autoHideSuspend: true,
    dragScroll: true,
    clickScroll: 'instant',
  };
  let locked = isScrollLocked();
  const pageScrollbar = OverlayScrollbars(body, {
    overflow: { y: locked ? 'hidden' : 'scroll' },
    scrollbars: theme,
  });
  // Some browsers cannot hide native body scrollbars without changing window
  // scrolling semantics. OverlayScrollbars cancels in that case.
  if (!pageScrollbar || pageScrollbar.state().destroyed) return;

  const finePointer = matchMedia('(pointer: fine)');
  const forcedColors = matchMedia('(forced-colors: active)');
  const safeInnerViewport = OverlayScrollbars.env().scrollbarsHiding;
  const innerScrollbars = new Map();

  function toggleInner(element, enabled) {
    if (!element) return;
    const existing = innerScrollbars.get(element);
    if (!enabled) {
      if (existing) {
        existing.destroy();
        innerScrollbars.delete(element);
      }
      return;
    }
    if (existing) return;

    // Reuse the original element as the scroll viewport: no DOM wrappers, no
    // change to scrollTop, scroll events, direct-child selectors or sticky UI.
    const instance = OverlayScrollbars(
      { target: element, elements: { viewport: element } },
      {
        overflow: { x: 'hidden', y: 'scroll' },
        scrollbars: theme,
      },
    );
    if (instance && !instance.state().destroyed) innerScrollbars.set(element, instance);
  }

  function syncInnerScrollbars() {
    // Keep touch, high-contrast and unsupported-browser internal scrollbars native.
    const useCustom = safeInnerViewport && finePointer.matches && !forcedColors.matches;
    const immersive = body.classList.contains('immersive');
    const pip = body.classList.contains('activity-pip');
    const drawer = document.getElementById('drawer');
    toggleInner(drawer, useCustom && immersive && !pip && drawer && !drawer.hidden);

    const settings = document.getElementById('room-settings-dialog');
    const settingsContent = document.getElementById('room-settings-content');
    toggleInner(
      document.getElementById('room-settings-panels'),
      useCustom && !!settings?.open && !!settingsContent && !settingsContent.hidden,
    );

    const emptyStage = document.getElementById('empty-stage');
    toggleInner(emptyStage, useCustom && !!emptyStage && !emptyStage.hidden);

    const lobbyRooms = document.getElementById('lobby-rooms');
    toggleInner(lobbyRooms, useCustom && !!lobbyRooms && !lobbyRooms.hidden && (!emptyStage || !emptyStage.hidden));

    const roster = document.getElementById('room-participants') || document.querySelector('.room-roster');
    toggleInner(roster, useCustom && !!roster && !roster.hidden);

    const serverSettings = document.getElementById('server-settings-dialog');
    const serverSettingsContent = serverSettings?.querySelector('.server-settings-content');
    toggleInner(serverSettingsContent, useCustom && !!serverSettings?.open);

    for (const dialog of document.querySelectorAll('dialog.watch-dialog')) {
      if (dialog.id === 'room-settings-dialog' || dialog.id === 'server-settings-dialog') continue;
      toggleInner(dialog, useCustom && dialog.open);
    }
  }

  new MutationObserver(() => {
    const next = isScrollLocked();
    if (next !== locked) {
      locked = next;
      pageScrollbar.options({ overflow: { y: locked ? 'hidden' : 'scroll' } });
    }
    if (innerStarted) syncInnerScrollbars();
  }).observe(body, { attributes: true, attributeFilter: ['class', 'data-layout'] });

  let innerStarted = false;
  function startInnerScrollbars() {
    innerStarted = true;
    const drawer = document.getElementById('drawer');
    if (drawer)
      new MutationObserver(syncInnerScrollbars).observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
    const settings = document.getElementById('room-settings-dialog');
    if (settings)
      new MutationObserver(syncInnerScrollbars).observe(settings, { attributes: true, attributeFilter: ['open'] });
    const settingsContent = document.getElementById('room-settings-content');
    if (settingsContent)
      new MutationObserver(syncInnerScrollbars).observe(settingsContent, {
        attributes: true,
        attributeFilter: ['hidden'],
      });
    const emptyStage = document.getElementById('empty-stage');
    if (emptyStage)
      new MutationObserver(syncInnerScrollbars).observe(emptyStage, { attributes: true, attributeFilter: ['hidden'] });
    for (const dialog of document.querySelectorAll('dialog')) {
      new MutationObserver(syncInnerScrollbars).observe(dialog, { attributes: true, attributeFilter: ['open'] });
    }
    for (const media of [finePointer, forcedColors]) media.addEventListener('change', syncInnerScrollbars);
    syncInnerScrollbars();
  }

  // The watch modules create #drawer and other scroll areas after this runs; the page's module scripts all
  // run before DOMContentLoaded.
  if (document.readyState === 'complete') startInnerScrollbars();
  else document.addEventListener('DOMContentLoaded', startInnerScrollbars, { once: true });
}
