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
    "adjustments-horizontal": "<path d=\"M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" /><path d=\"M4 6l8 0\" /><path d=\"M16 6l4 0\" /><path d=\"M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" /><path d=\"M4 12l2 0\" /><path d=\"M10 12l10 0\" /><path d=\"M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" /><path d=\"M4 18l11 0\" /><path d=\"M19 18l1 0\" />",
    "arrow-down": "<path d=\"M12 5l0 14\" /><path d=\"M18 13l-6 6\" /><path d=\"M6 13l6 6\" />",
    "arrow-left": "<path d=\"M5 12l14 0\" /><path d=\"M5 12l6 6\" /><path d=\"M5 12l6 -6\" />",
    "arrow-right": "<path d=\"M5 12l14 0\" /><path d=\"M13 18l6 -6\" /><path d=\"M13 6l6 6\" />",
    "arrow-up": "<path d=\"M12 5l0 14\" /><path d=\"M18 11l-6 -6\" /><path d=\"M6 11l6 -6\" />",
    "arrows-horizontal": "<path d=\"M7 8l-4 4l4 4\" /><path d=\"M17 8l4 4l-4 4\" /><path d=\"M3 12l18 0\" />",
    "arrows-shuffle": "<path d=\"M18 4l3 3l-3 3\" /><path d=\"M18 20l3 -3l-3 -3\" /><path d=\"M3 7h3a5 5 0 0 1 5 5a5 5 0 0 0 5 5h5\" /><path d=\"M21 7h-5a4.978 4.978 0 0 0 -3 1m-4 8a4.984 4.984 0 0 1 -3 1h-3\" />",
    "arrows-vertical": "<path d=\"M8 7l4 -4l4 4\" /><path d=\"M8 17l4 4l4 -4\" /><path d=\"M12 3l0 18\" />",
    "badge-cc": "<path d=\"M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10\" /><path d=\"M10 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0\" /><path d=\"M17 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0\" />",
    "ban": "<path d=\"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0\" /><path d=\"M5.7 5.7l12.6 12.6\" />",
    "border-all": "<path d=\"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12\" /><path d=\"M4 12l16 0\" /><path d=\"M12 4l0 16\" />",
    "chair-director": "<path d=\"M6 21l12 -9\" /><path d=\"M6 12l12 9\" /><path d=\"M5 12h14\" /><path d=\"M6 3v9\" /><path d=\"M18 3v9\" /><path d=\"M6 8h12\" /><path d=\"M6 5h12\" />",
    "chevron-down": "<path d=\"M6 9l6 6l6 -6\" />",
    "columns-2": "<path d=\"M3 4a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v16a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-16\" /><path d=\"M12 3v18\" />",
    "crown": "<path d=\"M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4l4 -6\" />",
    "device-remote": "<path d=\"M10 10a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" /><path d=\"M7 5a2 2 0 0 1 2 -2h6a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-6a2 2 0 0 1 -2 -2l0 -14\" /><path d=\"M12 3v2\" /><path d=\"M10 15v.01\" /><path d=\"M10 18v.01\" /><path d=\"M14 18v.01\" /><path d=\"M14 15v.01\" />",
    "device-tv": "<path d=\"M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9\" /><path d=\"M16 3l-4 4l-4 -4\" />",
    "external-link": "<path d=\"M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6\" /><path d=\"M11 13l9 -9\" /><path d=\"M15 4h5v5\" />",
    "filter-2": "<path d=\"M4 6h16\" /><path d=\"M6 12h12\" /><path d=\"M9 18h6\" />",
    "history": "<path d=\"M12 8l0 4l2 2\" /><path d=\"M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5\" />",
    "karate": "<path d=\"M3 9l4.5 1l3 2.5\" /><path d=\"M13 21v-8l3 -5.5\" /><path d=\"M8 4.5l4 2l4 1l4 3.5l-2 3.5\" /><path d=\"M15.007 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0\" />",
    "layout-sidebar-right": "<path d=\"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12\" /><path d=\"M15 4l0 16\" />",
    "list-details": "<path d=\"M13 5h8\" /><path d=\"M13 9h5\" /><path d=\"M13 15h8\" /><path d=\"M13 19h5\" /><path d=\"M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4\" /><path d=\"M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4\" />",
    "maximize": "<path d=\"M4 8v-2a2 2 0 0 1 2 -2h2\" /><path d=\"M4 16v2a2 2 0 0 0 2 2h2\" /><path d=\"M16 4h2a2 2 0 0 1 2 2v2\" /><path d=\"M16 20h2a2 2 0 0 0 2 -2v-2\" />",
    "microphone": "<path d=\"M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5\" /><path d=\"M5 10a7 7 0 0 0 14 0\" /><path d=\"M8 21l8 0\" /><path d=\"M12 17l0 4\" />",
    "minimize": "<path d=\"M15 19v-2a2 2 0 0 1 2 -2h2\" /><path d=\"M15 5v2a2 2 0 0 0 2 2h2\" /><path d=\"M5 15h2a2 2 0 0 1 2 2v2\" /><path d=\"M5 9h2a2 2 0 0 0 2 -2v-2\" />",
    "movie": "<path d=\"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12\" /><path d=\"M8 4l0 16\" /><path d=\"M16 4l0 16\" /><path d=\"M4 8l4 0\" /><path d=\"M4 16l4 0\" /><path d=\"M4 12l16 0\" /><path d=\"M16 8l4 0\" /><path d=\"M16 16l4 0\" />",
    "photo-video": "<path d=\"M9 15h-3a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3h6a3 3 0 0 1 3 3v3\" /><path d=\"M9 12a3 3 0 0 1 3 -3h6a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-6a3 3 0 0 1 -3 -3l0 -6\" /><path d=\"M3 12l2.296 -2.296a2.41 2.41 0 0 1 3.408 0l.296 .296\" /><path d=\"M14 13.5v3l2.5 -1.5l-2.5 -1.5\" /><path d=\"M7 6v.01\" />",
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
