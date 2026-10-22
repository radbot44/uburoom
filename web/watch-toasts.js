/* Shared Watch toast presentation and lifetime. Callers own operation state. */
(function (global) {
  'use strict';
  function create(host, { stage, icons = global.uburoomIcons, schedule = setTimeout, cancel = clearTimeout } = {}) {
    const doc = host.ownerDocument, entries = new Map();
    const view = doc.defaultView, controls = stage?.querySelector('.transport');
    const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)');
    let layoutFrame, animateLayout = false, movement, positioned = false, enabled = true;
    function place() {
      layoutFrame = undefined;
      const animate = animateLayout;
      animateLayout = false;
      if (!entries.size || !stage) return;
      // Outside the player clipping/containment in page layouts, inside the
      // fullscreen top layer when the player enters fullscreen.
      const parent = doc.fullscreenElement || doc.body;
      const reparented = host.parentElement !== parent;
      const previous = positioned && !reparented ? host.getBoundingClientRect() : undefined;
      movement?.cancel();
      if (reparented) parent.append(host);
      const viewport = view.visualViewport;
      const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
      const height = viewport?.height || view.innerHeight, width = viewport?.width || view.innerWidth;
      const rect = stage.getBoundingClientRect();
      const inset = parseFloat(view.getComputedStyle(host).getPropertyValue('--toast-inset'));
      host.style.maxWidth = Math.max(0, Math.min(rect.width, width) - inset * 2) + 'px';
      const stack = host.getBoundingClientRect();
      let bottom = rect.bottom - inset;
      if (controls && view.getComputedStyle(controls).pointerEvents !== 'none') {
        for (const element of controls.querySelectorAll('[data-media-controls]')) {
          const controlRect = element.getBoundingClientRect();
          if (controlRect.height && view.getComputedStyle(element).visibility !== 'hidden') bottom = Math.min(bottom, controlRect.top - inset);
        }
      }
      // Clamp after control avoidance: staying visible always wins.
      const y = Math.max(top, Math.min(bottom - stack.height, top + height - stack.height));
      const x = Math.max(left, Math.min(rect.left + inset, left + width - stack.width));
      // A fullscreen player can establish a containing block for fixed children.
      const origin = doc.fullscreenElement?.getBoundingClientRect();
      host.style.top = y - (origin?.top || 0) + 'px';
      host.style.left = x - (origin?.left || 0) + 'px';
      if (animate && previous && !reducedMotion.matches && previous.top >= top && previous.bottom <= top + height) {
        movement = host.animate([
          { transform: `translate(${previous.left - x}px, ${previous.top - y}px)` },
          { transform: 'translate(0, 0)' }
        ], { duration: 180, easing: 'ease-out' });
      }
      positioned = true;
    }
    function requestLayout(animate = true) {
      // Scrolling/resizing must not acquire a delayed animation from another
      // observer firing in the same frame.
      animateLayout = layoutFrame === undefined ? animate : animateLayout && animate;
      if (stage && layoutFrame === undefined) layoutFrame = view.requestAnimationFrame(place);
    }
    if (stage) {
      doc.body.append(host);
      const anchor = () => requestLayout(false), move = () => requestLayout();
      view.addEventListener('scroll', anchor, { capture: true, passive: true });
      view.addEventListener('resize', anchor);
      view.visualViewport?.addEventListener('resize', anchor);
      view.visualViewport?.addEventListener('scroll', anchor);
      doc.addEventListener('fullscreenchange', anchor);
      for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) stage.addEventListener(event, move);
      const sizes = new view.ResizeObserver(move);
      for (const element of [host, stage, controls]) if (element) sizes.observe(element);
      const attributes = new view.MutationObserver(move);
      for (const element of [stage, doc.body, controls]) if (element) attributes.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    function dismiss(id) {
      const entry = entries.get(id);
      if (!entry || entry.exiting) return;
      cancel(entry.timer);
      entry.exiting = true;
      const remove = () => {
        entry.root.remove();
        entries.delete(id);
        if (!entries.size) positioned = false;
        requestLayout();
      };
      const current = view.getComputedStyle(entry.root);
      const from = { opacity: current.opacity, transform: current.transform };
      entry.motion?.cancel();
      if (reducedMotion.matches) remove();
      else {
        const motion = entry.root.animate([from, { opacity: 0, transform: 'translateY(6px)' }], { duration: 180, easing: 'ease-in', fill: 'forwards' });
        entry.motion = motion;
        motion.onfinish = () => { if (entry.motion === motion) remove(); };
      }
    }
    function show(id, { type = 'normal', title, hint = '', symbol, seekSeconds, loading = false, duration = 0, persistent = false }) {
      if (!enabled && type !== 'error') return;
      // A stable ID updates an existing notification rather than duplicating it.
      let entry = entries.get(id);
      if (!entry) {
        const root = doc.createElement('button');
        root.type = 'button';
        root.className = 'watch-toast';
        root.dataset.toast = id;
        root.title = 'Dismiss notification';
        root.addEventListener('click', event => { event.stopPropagation(); dismiss(id); });
        const artwork = doc.createElement('span');
        artwork.className = 'watch-toast-symbol';
        artwork.setAttribute('aria-hidden', 'true');
        const message = doc.createElement('span');
        message.className = 'watch-toast-message';
        const heading = doc.createElement('strong');
        heading.className = 'watch-toast-title';
        const detail = doc.createElement('span');
        detail.className = 'watch-toast-hint';
        message.append(heading, detail);
        root.append(artwork, message);
        entry = { root, artwork, heading, detail, timer: undefined, motion: undefined, exiting: false };
        entries.set(id, entry);
        host.append(root);
        if (!reducedMotion.matches) entry.motion = root.animate([
          { opacity: 0, transform: 'translateY(6px)' },
          { opacity: 1, transform: 'translateY(0)' }
        ], { duration: 180, easing: 'ease-out' });
      } else if (entry.exiting) {
        const current = view.getComputedStyle(entry.root);
        const from = { opacity: current.opacity, transform: current.transform };
        entry.motion?.cancel();
        entry.motion = reducedMotion.matches ? undefined : entry.root.animate([
          from, { opacity: 1, transform: 'translateY(0)' }
        ], { duration: 180, easing: 'ease-out' });
        entry.exiting = false;
      }
      cancel(entry.timer);
      entry.type = type;
      entry.root.classList.toggle('normal', type !== 'error');
      entry.root.classList.toggle('error', type === 'error');
      entry.root.dataset.loading = String(loading);
      entry.artwork.replaceChildren(...(symbol ? [icons.icon(doc, symbol, seekSeconds)] : []));
      entry.artwork.hidden = !symbol;
      entry.heading.textContent = title;
      entry.detail.textContent = hint;
      entry.detail.hidden = !hint;
      entry.root.setAttribute('aria-label', 'Dismiss notification: ' + title + (hint ? ' ' + hint : ''));
      const lifetime = persistent ? 0 : type === 'error' ? 10000 : duration;
      entry.timer = lifetime > 0 ? schedule(() => dismiss(id), lifetime) : undefined;
      requestLayout();
    }
    function clear() {
      for (const id of entries.keys()) dismiss(id);
    }
    function setEnabled(value) {
      enabled = !!value;
      if (!enabled) for (const [id, entry] of entries) if (entry.type !== 'error') dismiss(id);
    }
    return { show, dismiss, clear, setEnabled, get enabled() { return enabled; } };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.uburoomToasts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
