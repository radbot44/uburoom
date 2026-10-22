/* Shared Watch toast presentation and lifetime. Callers own operation state. */
(function (global) {
  'use strict';
  function create(host, { icons = global.uburoomIcons, schedule = setTimeout, cancel = clearTimeout } = {}) {
    const doc = host.ownerDocument, entries = new Map();
    function dismiss(id) {
      const entry = entries.get(id);
      if (!entry) return;
      cancel(entry.timer);
      entry.root.remove();
      entries.delete(id);
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
