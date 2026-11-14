/* Apply explicit appearance preferences before rendering; never follow the host theme. */
'use strict';
(() => {
  const root = document.documentElement,
    key = 'uburoom.appearance';
  function saved() {
    try {
      return JSON.parse(localStorage.getItem(key)) || {};
    } catch {
      return {};
    }
  }
  // Canonical SVG sources arrive with this script once. Recolor page and remote
  // logos locally; keep the browser favicon static during appearance changes.
  const branding = window.uburoomBrandAssets,
    forcedColors = window.matchMedia('(forced-colors: active)'),
    images = new Map();
  function forcedLightCanvas() {
    if (!forcedColors.matches) return false;
    const probe = document.body || root;
    const style = getComputedStyle(probe);
    const luma = value => {
      if (!value || /rgba\([^)]+,\s*0(?:\.0+)?\s*\)/.test(value)) return null;
      const match = /\d+\s*,\s*\d+\s*,\s*\d+/.exec(value);
      if (!match) return null;
      const [r, g, b] = match[0].split(',').map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const bgLuma = luma(style.backgroundColor);
    if (bgLuma !== null) return bgLuma > 0.5;
    const fgLuma = luma(style.color);
    return fgLuma !== null && fgLuma < 0.5;
  }
  function brandUrl(path) {
    const light = root.dataset.theme === 'light' || forcedLightCanvas();
    const cacheKey = path + '/' + light;
    if (!images.has(cacheKey)) {
      const svg = light ? branding[path].replace(/#F8F7F4/g, '#242329') : branding[path];
      images.set(cacheKey, 'data:image/svg+xml,' + encodeURIComponent(svg));
    }
    return images.get(cacheKey);
  }
  function updateBrand(img, path) {
    const next = brandUrl(path);
    if (img.src === next) return;
    if (
      img.src.startsWith('data:') &&
      img.complete &&
      img.naturalWidth &&
      !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      let frame = img.parentElement;
      if (!frame.classList.contains('brand-frame')) {
        frame = document.createElement('span');
        frame.className = 'brand-frame';
        img.replaceWith(frame);
        frame.append(img);
      }
      frame.querySelector('[data-brand-outgoing]')?.remove();
      const previous = img.cloneNode();
      previous.dataset.brandOutgoing = '';
      previous.alt = '';
      previous.setAttribute('aria-hidden', 'true');
      frame.append(previous);
      previous.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: 'linear' }).finished.then(
        () => previous.remove(),
        () => previous.remove(),
      );
    }
    img.src = next;
  }
  function clicked() {
    apply({ theme: root.dataset.theme === 'dark' ? 'light' : 'dark' }, true);
  }
  // Same element as icons.js icon(); this script runs before the page's modules load.
  function spriteIcon(name) {
    const ns = 'http://www.w3.org/2000/svg',
      svg = document.createElementNS(ns, 'svg'),
      use = document.createElementNS(ns, 'use');
    for (const [key, value] of Object.entries({
      viewBox: '0 0 24 24',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
      'data-tabler-icon': name,
    }))
      svg.setAttribute(key, value);
    use.setAttribute('href', '#icon-' + name);
    svg.append(use);
    return svg;
  }
  function render() {
    const light = root.dataset.theme === 'light';
    const button = document.getElementById('theme-toggle');
    if (button) {
      button.setAttribute('aria-checked', String(light));
      button.querySelector('.appearance-thumb').replaceChildren(spriteIcon(light ? 'sun' : 'moon'));
      button.title = button.ariaLabel =
        'Theme: ' + (light ? 'Light' : 'Dark') + '. Switch to ' + (light ? 'dark' : 'light') + '.';
    }
    for (const img of document.querySelectorAll('img.brand:not([data-brand-outgoing])'))
      updateBrand(img, '/assets/branding/uburoom-wordmark-brand.svg');
    document.querySelector('meta[name=theme-color]')?.setAttribute('content', light ? '#F8F6F2' : '#101217');
  }
  function apply(value, persist = false) {
    root.dataset.theme = value.theme === 'light' ? 'light' : 'dark';
    if (persist)
      try {
        localStorage.setItem(key, JSON.stringify({ theme: root.dataset.theme }));
      } catch {}
    render();
    window.dispatchEvent(new Event('uburoom-theme'));
  }
  window.uburoomTheme = { brandUrl, updateBrand };
  apply(saved());
  if (document.readyState === 'loading') {
    const observer = new MutationObserver(() => {
      if (document.getElementById('theme-toggle') || document.querySelector('img.brand:not([data-brand-outgoing])'))
        render();
      if (document.getElementById('theme-toggle') && document.querySelector('img.brand:not([data-brand-outgoing])'))
        observer.disconnect();
    });
    observer.observe(root, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', () => observer.disconnect(), { once: true });
  }
  document.addEventListener('DOMContentLoaded', () => {
    render();
    document.getElementById('theme-toggle')?.addEventListener('click', clicked);
  });
  window.addEventListener('load', render, { once: true });
  window.addEventListener('storage', event => {
    if (event.key === key || event.key === null) {
      apply(saved());
    }
  });
  forcedColors.addEventListener?.('change', render);
})();
