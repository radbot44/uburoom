/* Shared Watch toast presentation and lifetime. Callers own operation state. */
(function (global) {
  'use strict';
  function create(host, { stage, icons = global.uburoomIcons, schedule = setTimeout, cancel = clearTimeout } = {}) {
    const doc = host.ownerDocument, entries = new Map();
    const view = doc.defaultView, controls = stage?.querySelector('.transport');
    let layoutFrame;
    function place() {
      layoutFrame = undefined;
      if (!entries.size || !stage) return;
      // Outside the player clipping/containment in page layouts, inside the
      // fullscreen top layer when the player enters fullscreen.
      const parent = doc.fullscreenElement || doc.body;
      if (host.parentElement !== parent) parent.append(host);
      const viewport = view.visualViewport;
      const top = viewport?.offsetTop || 0, left = viewport?.offsetLeft || 0;
      const height = viewport?.height || view.innerHeight, width = viewport?.width || view.innerWidth;
      const rect = stage.getBoundingClientRect();
      const inset = parseFloat(view.getComputedStyle(host).getPropertyValue('--toast-inset'));
      host.style.maxWidth = Math.max(0, Math.min(rect.width, width) - inset * 2) + 'px';
      const stack = host.getBoundingClientRect();
      let bottom = rect.bottom - inset;
      if (controls && view.getComputedStyle(controls).pointerEvents !== 'none') {
        const controlRect = controls.getBoundingClientRect();
        if (controlRect.height) bottom = Math.min(bottom, controlRect.top - inset);
      }
      // Clamp after control avoidance: staying visible always wins.
      const y = Math.max(top, Math.min(bottom - stack.height, top + height - stack.height));
      const x = Math.max(left, Math.min(rect.left + inset, left + width - stack.width));
      // A fullscreen player can establish a containing block for fixed children.
      const origin = doc.fullscreenElement?.getBoundingClientRect();
      host.style.top = y - (origin?.top || 0) + 'px';
      host.style.left = x - (origin?.left || 0) + 'px';
    }
    function requestLayout() {
      if (stage && layoutFrame === undefined) layoutFrame = view.requestAnimationFrame(place);
    }
    if (stage) {
      doc.body.append(host);
      view.addEventListener('scroll', requestLayout, { capture: true, passive: true });
      view.addEventListener('resize', requestLayout);
      view.visualViewport?.addEventListener('resize', requestLayout);
      view.visualViewport?.addEventListener('scroll', requestLayout);
      doc.addEventListener('fullscreenchange', requestLayout);
      for (const event of ['pointerenter', 'pointerleave', 'focusin', 'focusout']) stage.addEventListener(event, requestLayout);
      const sizes = new view.ResizeObserver(requestLayout);
      for (const element of [host, stage, controls]) if (element) sizes.observe(element);
      const attributes = new view.MutationObserver(requestLayout);
      for (const element of [stage, doc.body, controls]) if (element) attributes.observe(element, { attributes: true, attributeFilter: ['class', 'style', 'hidden'] });
    }
    function dismiss(id) {
      const entry = entries.get(id);
      if (!entry) return;
      cancel(entry.timer);
      entry.root.remove();
      entries.delete(id);
      requestLayout();
    }
    function show(id, { title, hint = '', symbol, seekSeconds, loading = false, duration = 0 }) {
      // A stable ID updates an existing notification rather than duplicating it.
      let entry = entries.get(id);
      if (!entry) {
        const root = doc.createElement('div');
        root.className = 'watch-toast';
        root.dataset.toast = id;
        root.setAttribute('role', 'status');
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
        entry = { root, artwork, heading, detail, timer: undefined };
        entries.set(id, entry);
        host.append(root);
      }
      cancel(entry.timer);
      entry.root.classList.toggle('loading', loading);
      entry.artwork.replaceChildren(...(symbol ? [icons.icon(doc, symbol, seekSeconds)] : []));
      entry.artwork.hidden = !symbol;
      entry.heading.textContent = title;
      entry.detail.textContent = hint;
      entry.detail.hidden = !hint;
      entry.timer = duration > 0 ? schedule(() => dismiss(id), duration) : undefined;
      requestLayout();
    }
    function clear() {
      for (const id of entries.keys()) dismiss(id);
    }
    return { show, dismiss, clear };
  }
  const api = { create };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.uburoomToasts = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
