/* Customize the document and selected safe scroll areas without replacing scroll targets. */
'use strict';
(() => {
  const OverlayScrollbars = window.OverlayScrollbarsGlobal?.OverlayScrollbars;
  if (!OverlayScrollbars) return; // Missing vendor script: keep all scrollbars native.

  // OverlayScrollbars injects a temporary <style> to detect scrollbar support.
  // Supply its per-response CSP nonce before the first API call.
  const styleNonce = document.currentScript?.dataset.osStyleNonce;
  if (styleNonce) OverlayScrollbars.nonce(styleNonce);

  const body = document.body;
  const isScrollLocked = () => body.classList.contains('immersive') || body.classList.contains('activity-pip');
  const theme = {
    theme: 'os-theme-uburoom',
    autoHide: 'scroll',
    autoHideDelay: 1000,
    autoHideSuspend: true,
    dragScroll: true,
    clickScroll: 'instant'
  };
  let locked = isScrollLocked();
  const pageScrollbar = OverlayScrollbars(body, {
    overflow: { y: locked ? 'hidden' : 'scroll' },
    scrollbars: theme
  });
  // Some browsers cannot hide native body scrollbars without changing window
  // scrolling semantics. OverlayScrollbars cancels in that case.
  if (!pageScrollbar || pageScrollbar.state().destroyed) return;

  const desktop = matchMedia('(min-width: 1101px)');
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
    const instance = OverlayScrollbars({ target: element, elements: { viewport: element } }, {
      overflow: { x: 'hidden', y: 'scroll' },
      scrollbars: theme
    });
    if (instance && !instance.state().destroyed) innerScrollbars.set(element, instance);
  }

  function syncInnerScrollbars() {
    // Keep touch, high-contrast and unsupported-browser internal scrollbars native.
    const useCustom = safeInnerViewport && finePointer.matches && !forcedColors.matches;
    const immersive = body.classList.contains('immersive');
    const pip = body.classList.contains('activity-pip');
    toggleInner(document.getElementById('room-column'),
      useCustom && desktop.matches && !immersive && !body.classList.contains('mobile-player'));

    const drawer = document.getElementById('drawer');
    toggleInner(drawer, useCustom && immersive && !pip && drawer && !drawer.hidden);

    const settings = document.getElementById('room-settings-dialog');
    const settingsContent = document.getElementById('room-settings-content');
    toggleInner(document.getElementById('room-settings-panels'),
      useCustom && !!settings?.open && !!settingsContent && !settingsContent.hidden);
  }

  new MutationObserver(() => {
    const next = isScrollLocked();
    if (next !== locked) {
      locked = next;
      pageScrollbar.options({ overflow: { y: locked ? 'hidden' : 'scroll' } });
    }
    if (document.readyState !== 'loading') syncInnerScrollbars();
  }).observe(body, { attributes: true, attributeFilter: ['class'] });

  function startInnerScrollbars() {
    const drawer = document.getElementById('drawer');
    if (drawer) new MutationObserver(syncInnerScrollbars)
      .observe(drawer, { attributes: true, attributeFilter: ['hidden'] });
    const settings = document.getElementById('room-settings-dialog');
    if (settings) new MutationObserver(syncInnerScrollbars)
      .observe(settings, { attributes: true, attributeFilter: ['open'] });
    const settingsContent = document.getElementById('room-settings-content');
    if (settingsContent) new MutationObserver(syncInnerScrollbars)
      .observe(settingsContent, { attributes: true, attributeFilter: ['hidden'] });
    for (const media of [desktop, finePointer, forcedColors])
      media.addEventListener('change', syncInnerScrollbars);
    syncInnerScrollbars();
  }

  // watch.js creates #drawer after this initializer script runs.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startInnerScrollbars, { once: true });
  } else startInnerScrollbars();
})();
