/* Self-hosted Tabler outline icons (MIT) + uburoom's original monochrome oomark.
 * Add SVGs to this distributed pack according to AGENTS.md and docs/design-guide.md.
 * Upstream: https://github.com/tabler/tabler-icons/tree/main/icons/outline
 * No runtime CDN, fonts, build-time icon dependency, or externally fetched icon imagery.
 */
(function (global) {
  'use strict';
  const aliases = Object.freeze({
    "home": "home",
    "sun": "sun",
    "moon": "moon",
    "libraryCards": "columns-2",
    "libraryList": "list-details",
    "libraryPosters": "border-all",
    "media": "photo-video",
    "film": "movie",
    "tv": "device-tv",
    "filter": "filter-2",
    "sort": "sort-descending",
    "queue": "playlist-add",
    "shuffle": "arrows-shuffle",
    "search": "search",
    "admin": "shield-check",
    "chevron": "chevron-down",
    "check": "check",
    "close": "x",
    "play": "player-play",
    "pause": "player-pause",
    "start": "player-skip-back",
    "end": "player-skip-forward",
    "back": "rewind-backward-15",
    "forward": "rewind-forward-15",
    "zoom": "search",
    "fullscreen": "maximize",
    "fullscreenExit": "minimize",
    "captions": "badge-cc",
    "theater": "rectangle",
    "drawer": "layout-sidebar-right",
    "stretchX": "arrows-horizontal",
    "stretchY": "arrows-vertical",
    "minus": "minus",
    "plus": "plus",
    "up": "arrow-up",
    "down": "arrow-down",
    "left": "arrow-left",
    "right": "arrow-right",
    "center": "viewfinder",
    "bookmark": "bookmark",
    "open": "external-link",
    "lock": "lock",
    "mic": "microphone",
    "users": "users",
    "reopen": "history",
    "refresh": "refresh",
    "login": "login",
    "logout": "logout",
    "website": "world",
    "creator": "crown",
    "host": "chair-director",
    "remote": "device-remote",
    "settings": "settings"
});
  const glyphs = Object.freeze({
    "oomark": "<circle cx=\"618.46\" cy=\"634.45\" r=\"48.3813\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"35.3374\"/><circle cx=\"737.35\" cy=\"634.45\" r=\"48.3813\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"35.3374\"/><path d=\"M601.9475 743.0031H753.8625\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"53.0061\"/>",
    // MORE_TABLER_GLYPHS
  });
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
  function resolveName(name, seekSeconds = 15) {
    if (name === 'back' || name === 'forward') {
      const seconds = Number(seekSeconds), direction = name === 'back' ? 'backward' : 'forward';
      if ([15, 30, 60].includes(seconds)) return 'rewind-' + direction + '-' + seconds;
      return name === 'back' ? 'player-skip-back' : 'player-skip-forward';
    }
    return own(aliases, name) ? aliases[name] : own(glyphs, name) ? name : null;
  }
  function volumeName(volume, muted = false) {
    const value = Number(volume);
    if (muted || !Number.isFinite(value) || value <= 0) return 'volume-off';
    if (value < 10) return 'volume-4';
    if (value <= 50) return 'volume-2';
    return 'volume';
  }
  function icon(doc, name, seekSeconds = 15) {
    const asset = resolveName(name, seekSeconds);
    if (!asset || !own(glyphs, asset)) throw new Error('Unknown uburoom icon: ' + name);
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', asset === 'oomark' ? '528.41 544.4 298.99 249.1061' : '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    if (asset === 'oomark') svg.setAttribute('class', 'oomark-icon');
    svg.innerHTML = glyphs[asset]; // Trusted, self-hosted, static SVG fragments only.
    return svg;
  }
  const api = Object.freeze({icon, resolveName, volumeName, aliases, glyphs});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.uburoomIcons = api;
})(globalThis);
