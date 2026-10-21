/* Room and Queue scroll with Media; a tall stack sticks at the viewport edge in either direction. */
'use strict';
(() => {
  const column = document.getElementById('room-column');
  if (!column) return;

  const edge = 22;
  const desktop = matchMedia('(min-width: 1101px)');
  let lastScrollY = window.scrollY;
  let stickyTop = edge;
  let active = false;
  let scheduled = false;

  function update() {
    scheduled = false;
    const y = window.scrollY;
    const enabled = desktop.matches &&
      !document.body.classList.contains('immersive') &&
      !document.body.classList.contains('activity-pip') &&
      !document.body.classList.contains('mobile-player');
    if (!enabled) {
      if (active) column.style.removeProperty('top');
      active = false;
      lastScrollY = y;
      return;
    }

    // Short stack: stick at the top. Tall stack: follow page scrolling until
    // the bottom reaches the viewport, and reveal the top on reverse scroll.
    const bottomTop = Math.min(edge, window.innerHeight - column.offsetHeight - edge);
    if (!active) {
      active = true;
      stickyTop = edge;
    } else {
      stickyTop = Math.max(bottomTop, Math.min(edge, stickyTop + lastScrollY - y));
    }
    stickyTop = Math.max(bottomTop, Math.min(edge, stickyTop));
    column.style.top = `${stickyTop}px`;
    lastScrollY = y;
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(update);
  }

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
  desktop.addEventListener('change', schedule);
  new ResizeObserver(schedule).observe(column);
  new MutationObserver(schedule).observe(document.body, {
    attributes: true,
    attributeFilter: ['class']
  });
  update();
})();
