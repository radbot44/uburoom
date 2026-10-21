/* Customize only the document scrollbar; leave queue and nested scrollers untouched. */
'use strict';
(() => {
  const OverlayScrollbars = window.OverlayScrollbarsGlobal?.OverlayScrollbars;
  if (!OverlayScrollbars) return; // Native scrollbar fallback if the vendor script is unavailable.

  const body = document.body;
  const isScrollLocked = () => body.classList.contains('immersive') || body.classList.contains('activity-pip');
  let locked = isScrollLocked();
  const instance = OverlayScrollbars(body, {
    overflow: { y: locked ? 'hidden' : 'scroll' },
    scrollbars: {
      theme: 'os-theme-uburoom',
      autoHide: 'scroll',
      autoHideDelay: 1000,
      autoHideSuspend: true,
      dragScroll: true,
      clickScroll: 'instant'
    }
  });

  // OverlayScrollbars cancels body initialization when it could disrupt native
  // scrolling on a browser; that leaves the native scrollbar in place.
  if (!instance || instance.state().destroyed) return;

  new MutationObserver(() => {
    const next = isScrollLocked();
    if (next === locked) return;
    locked = next;
    instance.options({ overflow: { y: locked ? 'hidden' : 'scroll' } });
  }).observe(body, { attributes: true, attributeFilter: ['class'] });
})();
