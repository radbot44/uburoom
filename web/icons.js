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
    "captions": "subtitles",
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
    "settings": "settings",
    "sparkle": "sparkles",
    "sparkles": "sparkles"
  });
  const glyphs = Object.freeze({
    "bookmark": [["path",{"d":"M18 7v14l-6 -4l-6 4v-14a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4"}]],
    "check": [["path",{"d":"M5 12l5 5l10 -10"}]],
    "home": [["path",{"d":"M5 12l-2 0l9 -9l9 9l-2 0"}],["path",{"d":"M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-7"}],["path",{"d":"M9 21v-6a2 2 0 0 1 2 -2h2a2 2 0 0 1 2 2v6"}]],
    "lock": [["path",{"d":"M5 13a2 2 0 0 1 2 -2h10a2 2 0 0 1 2 2v6a2 2 0 0 1 -2 2h-10a2 2 0 0 1 -2 -2v-6"}],["path",{"d":"M11 16a1 1 0 1 0 2 0a1 1 0 0 0 -2 0"}],["path",{"d":"M8 11v-4a4 4 0 1 1 8 0v4"}]],
    "login": [["path",{"d":"M15 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"}],["path",{"d":"M21 12h-13l3 -3"}],["path",{"d":"M11 15l-3 -3"}]],
    "logout": [["path",{"d":"M14 8v-2a2 2 0 0 0 -2 -2h-7a2 2 0 0 0 -2 2v12a2 2 0 0 0 2 2h7a2 2 0 0 0 2 -2v-2"}],["path",{"d":"M9 12h12l-3 -3"}],["path",{"d":"M18 15l3 -3"}]],
    "minus": [["path",{"d":"M5 12l14 0"}]],
    "moon": [["path",{"d":"M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313 -12.454l0 .008"}]],
    "plus": [["path",{"d":"M12 5l0 14"}],["path",{"d":"M5 12l14 0"}]],
    "refresh": [["path",{"d":"M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"}],["path",{"d":"M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"}]],
    "search": [["path",{"d":"M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"}],["path",{"d":"M21 21l-6 -6"}]],
    "settings": [["path",{"d":"M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065"}],["path",{"d":"M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"}]],
    "sun": [["path",{"d":"M8 12a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"}],["path",{"d":"M3 12h1m8 -9v1m8 8h1m-9 8v1m-6.4 -15.4l.7 .7m12.1 -.7l-.7 .7m0 11.4l.7 .7m-12.1 -.7l-.7 .7"}]],
    "users": [["path",{"d":"M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"}],["path",{"d":"M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"}],["path",{"d":"M16 3.13a4 4 0 0 1 0 7.75"}],["path",{"d":"M21 21v-2a4 4 0 0 0 -3 -3.85"}]],
    "oomark": [["circle",{"cx":"618.4600","cy":"634.4500","r":"48.3813","fill":"none","stroke":"currentColor","stroke-width":"35.3374"}],["circle",{"cx":"737.3500","cy":"634.4500","r":"48.3813","fill":"none","stroke":"currentColor","stroke-width":"35.3374"}],["line",{"x1":"601.9475","x2":"753.8625","y1":"743.0031","y2":"743.0031","stroke":"currentColor","stroke-width":"53.0061","stroke-linecap":"butt"}]],
    "adjustments-horizontal": [["path",{"d":"M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"}],["path",{"d":"M4 6l8 0"}],["path",{"d":"M16 6l4 0"}],["path",{"d":"M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"}],["path",{"d":"M4 12l2 0"}],["path",{"d":"M10 12l10 0"}],["path",{"d":"M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"}],["path",{"d":"M4 18l11 0"}],["path",{"d":"M19 18l1 0"}]],
    "arrow-down": [["path",{"d":"M12 5l0 14"}],["path",{"d":"M18 13l-6 6"}],["path",{"d":"M6 13l6 6"}]],
    "arrow-left": [["path",{"d":"M5 12l14 0"}],["path",{"d":"M5 12l6 6"}],["path",{"d":"M5 12l6 -6"}]],
    "arrow-right": [["path",{"d":"M5 12l14 0"}],["path",{"d":"M13 18l6 -6"}],["path",{"d":"M13 6l6 6"}]],
    "arrow-up": [["path",{"d":"M12 5l0 14"}],["path",{"d":"M18 11l-6 -6"}],["path",{"d":"M6 11l6 -6"}]],
    "arrow-bar-to-up": [["path",{"d":"M12 10l0 10"}],["path",{"d":"M12 10l4 4"}],["path",{"d":"M12 10l-4 4"}],["path",{"d":"M4 4l16 0"}]],
    "arrows-horizontal": [["path",{"d":"M7 8l-4 4l4 4"}],["path",{"d":"M17 8l4 4l-4 4"}],["path",{"d":"M3 12l18 0"}]],
    "arrows-shuffle": [["path",{"d":"M18 4l3 3l-3 3"}],["path",{"d":"M18 20l3 -3l-3 -3"}],["path",{"d":"M3 7h3a5 5 0 0 1 5 5a5 5 0 0 0 5 5h5"}],["path",{"d":"M21 7h-5a4.978 4.978 0 0 0 -3 1m-4 8a4.984 4.984 0 0 1 -3 1h-3"}]],
    "arrows-vertical": [["path",{"d":"M8 7l4 -4l4 4"}],["path",{"d":"M8 17l4 4l4 -4"}],["path",{"d":"M12 3l0 18"}]],
    "badge-cc": [["path",{"d":"M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10"}],["path",{"d":"M10 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0"}],["path",{"d":"M17 10.5a1.5 1.5 0 0 0 -3 0v3a1.5 1.5 0 0 0 3 0"}]],
    "ban": [["path",{"d":"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"}],["path",{"d":"M5.7 5.7l12.6 12.6"}]],
    "border-all": [["path",{"d":"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"}],["path",{"d":"M4 12l16 0"}],["path",{"d":"M12 4l0 16"}]],
    "chair-director": [["path",{"d":"M6 21l12 -9"}],["path",{"d":"M6 12l12 9"}],["path",{"d":"M5 12h14"}],["path",{"d":"M6 3v9"}],["path",{"d":"M18 3v9"}],["path",{"d":"M6 8h12"}],["path",{"d":"M6 5h12"}]],
    "chevron-down": [["path",{"d":"M6 9l6 6l6 -6"}]],
    "columns-2": [["path",{"d":"M3 4a1 1 0 0 1 1 -1h16a1 1 0 0 1 1 1v16a1 1 0 0 1 -1 1h-16a1 1 0 0 1 -1 -1v-16"}],["path",{"d":"M12 3v18"}]],
    "crown": [["path",{"d":"M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4l4 -6"}]],
    "device-tv": [["path",{"d":"M3 9a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v9a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2l0 -9"}],["path",{"d":"M16 3l-4 4l-4 -4"}]],
    "door": [["path",{"d":"M14 12v.01"}],["path",{"d":"M3 21h18"}],["path",{"d":"M6 21v-16a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v16"}]],
    "external-link": [["path",{"d":"M12 6h-6a2 2 0 0 0 -2 2v10a2 2 0 0 0 2 2h10a2 2 0 0 0 2 -2v-6"}],["path",{"d":"M11 13l9 -9"}],["path",{"d":"M15 4h5v5"}]],
    "filter-2": [["path",{"d":"M4 6h16"}],["path",{"d":"M6 12h12"}],["path",{"d":"M9 18h6"}]],
    "history": [["path",{"d":"M12 8l0 4l2 2"}],["path",{"d":"M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"}]],
    "karate": [["path",{"d":"M3 9l4.5 1l3 2.5"}],["path",{"d":"M13 21v-8l3 -5.5"}],["path",{"d":"M8 4.5l4 2l4 1l4 3.5l-2 3.5"}],["path",{"d":"M15.007 5a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"}]],
    "layout-sidebar-right": [["path",{"d":"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"}],["path",{"d":"M15 4l0 16"}]],
    "list-details": [["path",{"d":"M13 5h8"}],["path",{"d":"M13 9h5"}],["path",{"d":"M13 15h8"}],["path",{"d":"M13 19h5"}],["path",{"d":"M3 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}],["path",{"d":"M3 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}]],
    "maximize": [["path",{"d":"M4 8v-2a2 2 0 0 1 2 -2h2"}],["path",{"d":"M4 16v2a2 2 0 0 0 2 2h2"}],["path",{"d":"M16 4h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M16 20h2a2 2 0 0 0 2 -2v-2"}]],
    "microphone": [["path",{"d":"M9 5a3 3 0 0 1 3 -3a3 3 0 0 1 3 3v5a3 3 0 0 1 -3 3a3 3 0 0 1 -3 -3l0 -5"}],["path",{"d":"M5 10a7 7 0 0 0 14 0"}],["path",{"d":"M8 21l8 0"}],["path",{"d":"M12 17l0 4"}]],
    "minimize": [["path",{"d":"M15 19v-2a2 2 0 0 1 2 -2h2"}],["path",{"d":"M15 5v2a2 2 0 0 0 2 2h2"}],["path",{"d":"M5 15h2a2 2 0 0 1 2 2v2"}],["path",{"d":"M5 9h2a2 2 0 0 0 2 -2v-2"}]],
    "movie": [["path",{"d":"M4 6a2 2 0 0 1 2 -2h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2l0 -12"}],["path",{"d":"M8 4l0 16"}],["path",{"d":"M16 4l0 16"}],["path",{"d":"M4 8l4 0"}],["path",{"d":"M4 16l4 0"}],["path",{"d":"M4 12l16 0"}],["path",{"d":"M16 8l4 0"}],["path",{"d":"M16 16l4 0"}]],
    "photo-video": [["path",{"d":"M9 15h-3a3 3 0 0 1 -3 -3v-6a3 3 0 0 1 3 -3h6a3 3 0 0 1 3 3v3"}],["path",{"d":"M9 12a3 3 0 0 1 3 -3h6a3 3 0 0 1 3 3v6a3 3 0 0 1 -3 3h-6a3 3 0 0 1 -3 -3l0 -6"}],["path",{"d":"M3 12l2.296 -2.296a2.41 2.41 0 0 1 3.408 0l.296 .296"}],["path",{"d":"M14 13.5v3l2.5 -1.5l-2.5 -1.5"}],["path",{"d":"M7 6v.01"}]],
    "player-pause": [["path",{"d":"M6 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"}],["path",{"d":"M14 6a1 1 0 0 1 1 -1h2a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1l0 -12"}]],
    "player-play": [["path",{"d":"M7 4v16l13 -8l-13 -8"}]],
    "player-skip-back": [["path",{"d":"M20 5v14l-12 -7l12 -7"}],["path",{"d":"M4 5l0 14"}]],
    "player-skip-forward": [["path",{"d":"M4 5v14l12 -7l-12 -7"}],["path",{"d":"M20 5l0 14"}]],
    "playlist-add": [["path",{"d":"M19 8h-14"}],["path",{"d":"M5 12h9"}],["path",{"d":"M11 16h-6"}],["path",{"d":"M15 16h6"}],["path",{"d":"M18 13v6"}]],
    "rectangle": [["path",{"d":"M3 7a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-10"}]],
    "rewind-backward-15": [["path",{"d":"M8 20h2a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-2v-3h3"}],["path",{"d":"M15 18a6 6 0 1 0 0 -12h-11"}],["path",{"d":"M5 14v6"}],["path",{"d":"M7 9l-3 -3l3 -3"}]],
    "rewind-backward-30": [["path",{"d":"M19.007 16.466a6 6 0 0 0 -4.007 -10.466h-11"}],["path",{"d":"M12 15.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0"}],["path",{"d":"M6 14h1.5a1.5 1.5 0 0 1 0 3h-.5h.5a1.5 1.5 0 0 1 0 3h-1.5"}],["path",{"d":"M7 9l-3 -3l3 -3"}]],
    "rewind-backward-60": [["path",{"d":"M19.007 16.466a6 6 0 0 0 -4.007 -10.466h-11"}],["path",{"d":"M7 9l-3 -3l3 -3"}],["path",{"d":"M12 15.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0"}],["path",{"d":"M9 14h-2a1 1 0 0 0 -1 1v4a1 1 0 0 0 1 1h1a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-2"}]],
    "rewind-forward-15": [["path",{"d":"M17 9l3 -3l-3 -3"}],["path",{"d":"M9 18a6 6 0 1 1 0 -12h11"}],["path",{"d":"M16 20h2a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-2v-3h3"}],["path",{"d":"M13 14v6"}]],
    "rewind-forward-30": [["path",{"d":"M5.007 16.478a6 6 0 0 1 3.993 -10.478h11"}],["path",{"d":"M15 15.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0"}],["path",{"d":"M17 9l3 -3l-3 -3"}],["path",{"d":"M9 14h1.5a1.5 1.5 0 0 1 0 3h-.5h.5a1.5 1.5 0 0 1 0 3h-1.5"}]],
    "rewind-forward-60": [["path",{"d":"M5.007 16.478a6 6 0 0 1 3.993 -10.478h11"}],["path",{"d":"M15 15.5v3a1.5 1.5 0 0 0 3 0v-3a1.5 1.5 0 0 0 -3 0"}],["path",{"d":"M17 9l3 -3l-3 -3"}],["path",{"d":"M12 14h-2a1 1 0 0 0 -1 1v4a1 1 0 0 0 1 1h1a1 1 0 0 0 1 -1v-1a1 1 0 0 0 -1 -1h-2"}]],
    "shield-check": [["path",{"d":"M11.46 20.846a12 12 0 0 1 -7.96 -14.846a12 12 0 0 0 8.5 -3a12 12 0 0 0 8.5 3a12 12 0 0 1 -.09 7.06"}],["path",{"d":"M15 19l2 2l4 -4"}]],
    "sort-descending": [["path",{"d":"M4 6l9 0"}],["path",{"d":"M4 12l7 0"}],["path",{"d":"M4 18l7 0"}],["path",{"d":"M15 15l3 3l3 -3"}],["path",{"d":"M18 6l0 12"}]],
    "sparkles": [["path",{"d":"M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2m-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6"}]],
    "thumb-up": [["path",{"d":"M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a4 4 0 0 0 4 -4v-1a2 2 0 0 1 4 0v5h3a2 2 0 0 1 2 2l-1 5a2 3 0 0 1 -2 2h-7a3 3 0 0 1 -3 -3"}]],
    "thumb-down": [["path",{"d":"M7 13v-8a1 1 0 0 0 -1 -1h-2a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h3a4 4 0 0 1 4 4v1a2 2 0 0 0 4 0v-5h3a2 2 0 0 0 2 -2l-1 -5a2 3 0 0 0 -2 -2h-7a3 3 0 0 0 -3 3"}]],
    "thumb-up-off": [["path",{"d":"M7 11v8a1 1 0 0 1 -1 1h-2a1 1 0 0 1 -1 -1v-7a1 1 0 0 1 1 -1h3a3.987 3.987 0 0 0 2.828 -1.172m1.172 -2.828v-1a2 2 0 1 1 4 0v5h3a2 2 0 0 1 2 2c-.222 1.112 -.39 1.947 -.5 2.503m-.758 3.244c-.392 .823 -1.044 1.312 -1.742 1.253h-7a3 3 0 0 1 -3 -3"}],["path",{"d":"M3 3l18 18"}]],
    "thumb-down-off": [["path",{"d":"M7 13v-6m-3 -3a1 1 0 0 0 -1 1v7a1 1 0 0 0 1 1h3a4 4 0 0 1 4 4v1a2 2 0 1 0 4 0v-3m2 -2h1a2 2 0 0 0 2 -2l-1 -5c-.295 -1.26 -1.11 -2.076 -2 -2h-7c-.57 0 -1.102 .159 -1.556 .434"}],["path",{"d":"M3 3l18 18"}]],
    "user": [["path",{"d":"M8 7a4 4 0 1 0 8 0a4 4 0 0 0 -8 0"}],["path",{"d":"M6 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"}]],
    "viewfinder": [["path",{"d":"M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"}],["path",{"d":"M12 3l0 4"}],["path",{"d":"M12 21l0 -3"}],["path",{"d":"M3 12l4 0"}],["path",{"d":"M21 12l-3 0"}],["path",{"d":"M12 12l0 .01"}]],
    "volume": [["path",{"d":"M15 8a5 5 0 0 1 0 8"}],["path",{"d":"M17.7 5a9 9 0 0 1 0 14"}],["path",{"d":"M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"}]],
    "volume-2": [["path",{"d":"M15 8a5 5 0 0 1 0 8"}],["path",{"d":"M6 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"}]],
    "volume-4": [["path",{"d":"M9.5 15h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l3.5 -4.5a.8 .8 0 0 1 1.5 .5v14a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5"}]],
    "volume-off": [["path",{"d":"M15 8a5 5 0 0 1 1.912 4.934m-1.377 2.602a5 5 0 0 1 -.535 .464"}],["path",{"d":"M17.7 5a9 9 0 0 1 2.362 11.086m-1.676 2.299a9 9 0 0 1 -.686 .615"}],["path",{"d":"M9.069 5.054l.431 -.554a.8 .8 0 0 1 1.5 .5v2m0 4v8a.8 .8 0 0 1 -1.5 .5l-3.5 -4.5h-2a1 1 0 0 1 -1 -1v-4a1 1 0 0 1 1 -1h2l1.294 -1.664"}],["path",{"d":"M3 3l18 18"}]],
    "world": [["path",{"d":"M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"}],["path",{"d":"M3.6 9h16.8"}],["path",{"d":"M3.6 15h16.8"}],["path",{"d":"M11.5 3a17 17 0 0 0 0 18"}],["path",{"d":"M12.5 3a17 17 0 0 1 0 18"}]],
    "x": [["path",{"d":"M18 6l-12 12"}],["path",{"d":"M6 6l12 12"}]],
    "bell": [["path",{"d":"M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6"}],["path",{"d":"M9 17v1a3 3 0 0 0 6 0v-1"}]],
    "bell-off": [["path",{"d":"M9.346 5.353c.21 -.129 .428 -.246 .654 -.353a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3m-1 3h-13a4 4 0 0 0 2 -3v-3a6.996 6.996 0 0 1 1.273 -3.707"}],["path",{"d":"M9 17v1a3 3 0 0 0 6 0v-1"}],["path",{"d":"M3 3l18 18"}]],
    "subtitles": [["path",{"d":"M18 5a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3l12 0"}],["path",{"d":"M7 15h5"}],["path",{"d":"M15 15h2"}],["path",{"d":"M17 12h-3"}],["path",{"d":"M11 12h-1"}]],
    "subtitles-off": [["path",{"d":"M9 5h9a3 3 0 0 1 3 3v8a3 3 0 0 1 -.13 .874m-2.006 2a3 3 0 0 1 -.864 .126h-12a3 3 0 0 1 -3 -3v-8c0 -1.35 .893 -2.493 2.12 -2.869"}],["path",{"d":"M7 15h5"}],["path",{"d":"M17 12h-1"}],["path",{"d":"M12 12h-2"}],["path",{"d":"M3 3l18 18"}]],
    "layout-grid": [["path",{"d":"M4 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}],["path",{"d":"M14 5a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}],["path",{"d":"M4 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}],["path",{"d":"M14 15a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1l0 -4"}]],
    "wifi": [["path",{"d":"M12 18l.01 0"}],["path",{"d":"M9.172 15.172a4 4 0 0 1 5.656 0"}],["path",{"d":"M6.343 12.343a8 8 0 0 1 11.314 0"}],["path",{"d":"M3.515 9.515c4.686 -4.687 12.284 -4.687 17 0"}]],
    "wifi-off": [["path",{"d":"M12 18l.01 0"}],["path",{"d":"M9.172 15.172a4 4 0 0 1 5.656 0"}],["path",{"d":"M6.343 12.343a7.963 7.963 0 0 1 3.864 -2.14m4.163 .155a7.965 7.965 0 0 1 3.287 2"}],["path",{"d":"M3.515 9.515a12 12 0 0 1 3.544 -2.455m3.101 -.92a12 12 0 0 1 10.325 3.374"}],["path",{"d":"M3 3l18 18"}]],
    "wifi-0": [["path",{"d":"M12 18l.01 0"}]],
    "wifi-1": [["path",{"d":"M12 18l.01 0"}],["path",{"d":"M9.172 15.172a4 4 0 0 1 5.656 0"}]],
    "wifi-2": [["path",{"d":"M12 18l.01 0"}],["path",{"d":"M9.172 15.172a4 4 0 0 1 5.656 0"}],["path",{"d":"M6.343 12.343a8 8 0 0 1 11.314 0"}]],
    "ghost-2": [["path",{"d":"M10 9h.01"}],["path",{"d":"M14 9h.01"}],["path",{"d":"M12 3a7 7 0 0 1 7 7v1l1 0a2 2 0 1 1 0 4l-1 0v3l2 3h-10a6 6 0 0 1 -6 -5.775l0 -.226l-1 0a2 2 0 0 1 0 -4l1 0v-1a7 7 0 0 1 7 -7l0 .001"}],["path",{"d":"M11 14h2a1 1 0 0 0 -2 0"}]],
    "robot": [["path",{"d":"M6 6a2 2 0 0 1 2 -2h8a2 2 0 0 1 2 2v4a2 2 0 0 1 -2 2h-8a2 2 0 0 1 -2 -2l0 -4"}],["path",{"d":"M12 2v2"}],["path",{"d":"M9 12v9"}],["path",{"d":"M15 12v9"}],["path",{"d":"M5 16l4 -2"}],["path",{"d":"M15 14l4 2"}],["path",{"d":"M9 18h6"}],["path",{"d":"M10 8v.01"}],["path",{"d":"M14 8v.01"}]],
    "heart": [["path",{"d":"M19.5 12.572l-7.5 7.428l-7.5 -7.428a5 5 0 1 1 7.5 -6.566a5 5 0 1 1 7.5 6.572"}]],
    "player-track-next": [["path",{"d":"M3 5v14l8 -7l-8 -7"}],["path",{"d":"M14 5v14l8 -7l-8 -7"}]],
    "player-track-prev": [["path",{"d":"M21 5v14l-8 -7l8 -7"}],["path",{"d":"M10 5v14l-8 -7l8 -7"}]],
    "rotate-clockwise": [["path",{"d":"M4.05 11a8 8 0 1 1 .5 4m-.5 5v-5h5"}]],
    "loader-2": [["path",{"d":"M12 3a9 9 0 1 0 9 9"}]],
    "loader-4": [["path",{"d":"M12 21v-3m6.36 .36l-2.12 -2.12m4.76 -4.24h-3m.36 -6.36l-2.12 2.12m-4.24 -4.76v3m-6.36 -.36l2.12 2.12m-3.76 4.24h2m1 4.95l.71 -.71"}]],
    "rotate": "\u003cpath d=\"M19.95 11a8 8 0 1 0 -.5 4m.5 5v-5h-5\" xmlns=\"http://www.w3.org/2000/svg\" /\u003e",
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
  const SVG_NS = 'http://www.w3.org/2000/svg';
  function icon(doc, name, seekSeconds = 15) {
    const asset = resolveName(name, seekSeconds);
    if (!asset || !own(glyphs, asset)) throw new Error('Unknown uburoom icon: ' + name);
    const svg = doc.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', asset === 'oomark' ? '528.41 544.4 298.99 249.1061' : '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2'); svg.setAttribute('stroke-linecap', asset === 'oomark' ? 'butt' : 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('data-tabler-icon', asset === 'oomark' ? 'oomark' : asset);
    if (asset === 'oomark') svg.setAttribute('class', 'oomark-icon');
    const specs = glyphs[asset];
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      const el = doc.createElementNS(SVG_NS, spec[0]);
      const attrs = spec[1];
      for (const key in attrs) {
        if (own(attrs, key)) el.setAttribute(key, attrs[key]);
      }
      svg.append(el);
    }
    return svg;
  }
  const api = Object.freeze({icon, resolveName, volumeName, aliases, glyphs});
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.uburoomIcons = api;
})(globalThis);
