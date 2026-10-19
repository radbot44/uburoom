/* Shared remote: safe DOM only, used by the webpage, toolbar and player overlay. */
(function (global) {
  'use strict';
  const CSS = `
:host{color:var(--text);font:14px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:inherit}
*{box-sizing:border-box}[hidden]{display:none!important}button,input{font:inherit}button{cursor:pointer;border:0;touch-action:manipulation;user-select:none;color:inherit}button:disabled,input:disabled{opacity:.4;cursor:default}button:focus-visible,input:focus-visible{outline:3px solid var(--text);outline-offset:3px}button:active{transform:scale(.97)}
.remote{background:var(--card);border-radius:28px;padding:24px;max-width:500px;margin:auto}svg{width:30px;height:30px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}.header{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.header h2{font-size:24px;letter-spacing:-.7px;margin:0}.plain{background:transparent;border-radius:10px;padding:6px;color:var(--muted);display:grid;place-items:center}.plain:hover{background:var(--hover);color:var(--text)}.media{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.key{height:74px;border-radius:12px;background:var(--elevated);display:grid;place-items:center}.key:hover,.dpad button:hover{background:var(--hover)}.key svg{width:38px;height:38px}.play{background:var(--primary);color:var(--on-primary)}.play:hover{background:color-mix(in srgb,var(--primary),var(--text) 10%)}.volume{grid-column:span 2;display:flex;align-items:center;gap:12px;background:var(--elevated);border-radius:12px;padding:12px;min-width:0}.bars{position:relative;flex:1;height:42px;display:flex;align-items:end;gap:3px;min-width:0}.bar{flex:1;background:var(--border);border-radius:2px;height:var(--height);position:relative;overflow:hidden}.fill{height:100%;background:var(--primary)}.volume.muted .fill{background:var(--muted)}.bars input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}.bars:focus-within{outline:2px solid var(--text);outline-offset:3px}.number{background:transparent;padding:4px 0;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}.volume .number{font-size:17px;width:52px;flex:0 0 52px;text-align:right}.number-input{background:var(--elevated);color:var(--text);text-align:center;border:0;border-radius:8px;padding:5px;min-width:0;width:100%;font-weight:700}.volume .number-input{width:52px;flex:0 0 52px}.separator{height:1.5px;background:var(--border);margin:26px 0}
.transform{background:var(--card);border-radius:18px;padding:14px 12px}
.picture-layout{display:grid;grid-template-columns:minmax(0,1fr) 140px;gap:14px;align-items:center}
.size-controls{display:grid;gap:12px;min-width:0}
.size-control{display:grid;grid-template-columns:44px minmax(0,1fr) 44px;gap:4px;align-items:stretch;min-width:0;--size-accent:var(--primary)}
.decrease-stack{display:grid;grid-template-rows:44px 40px;gap:4px}
.adjust{display:grid;place-items:center;padding:0;background:var(--elevated);color:var(--accent-text);border-radius:10px;height:88px}.adjust.minus{height:44px}.adjust svg{width:23px;height:23px}
.adjust:hover,.size-reset:hover,.reset-all:hover,.dpad button:hover{background:var(--hover)}
.size-reset{display:grid;place-items:center;padding:0;background:var(--elevated);color:var(--muted);border-radius:9px;height:40px}.size-reset svg{width:18px;height:18px}
.value-wrap{min-width:0;text-align:center}.picture-value{display:flex;align-items:center;justify-content:center;flex-direction:column;gap:6px;min-height:88px;width:100%;line-height:1.1;padding:5px 0}
.size-label{display:flex;align-items:center;justify-content:center;gap:4px;font-size:11px;font-weight:500;letter-spacing:0;color:var(--muted)}.size-label svg{width:16px;height:16px;color:var(--accent-text);flex:none}
.size-number{font-size:22px;letter-spacing:-.6px}.size-number[data-long=true]{font-size:16px;letter-spacing:-.5px}
.value-wrap input{height:88px;font-size:18px;padding:4px 2px}
.position{min-width:0}.dpad{display:grid;grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px);gap:4px;justify-content:center}
.dpad button{background:var(--elevated);border-radius:10px;display:grid;place-items:center;padding:0}.dpad svg{width:24px;height:24px}.dpad .up{grid-area:1/2}.dpad .left{grid-area:2/1}.dpad .center{grid-area:2/2;background:var(--elevated);border-radius:50%}.dpad .right{grid-area:2/3}.dpad .down{grid-area:3/2}
.position-text{display:grid;gap:3px;text-align:center;margin-top:10px;color:var(--muted);font-size:11px}.position-label{font-size:12px;font-weight:500;color:var(--text)}.position-text output{font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.footer{display:flex;justify-content:space-between;gap:8px;align-items:center;margin-top:18px}.profiles-toggle{display:flex;align-items:center;background:none;font-size:12px;gap:6px;min-height:44px;padding:0 4px}.profiles-toggle svg{width:22px;height:22px}
.pill{border-radius:999px;font-size:12px;font-weight:650;padding:10px 14px;min-height:44px;white-space:nowrap}.reset-all{display:flex;align-items:center;justify-content:center;gap:7px;background:var(--elevated);border:1px solid var(--border);color:var(--muted)}.reset-all svg{width:18px;height:18px;flex:none}
.profiles{margin-top:16px;background:var(--card);padding:14px;border-radius:16px}.slots{display:grid;grid-template-columns:repeat(9,minmax(0,1fr));gap:4px}.slot{background:var(--elevated);border-radius:7px;min-height:35px;padding:0;font-size:12px}.slot[aria-pressed=true]{background:var(--primary);color:var(--on-primary)}.profile-actions{display:flex;gap:8px;margin-top:12px}.profile-actions button{flex:1;background:var(--elevated);padding:10px;border-radius:9px}.message{font-size:12px;color:var(--muted);min-height:17px;margin:12px 0 0}.message.error{color:var(--error)}
.compact{padding:4px 0;border-radius:0}.compact .header{display:none}.compact .media{gap:7px}.compact .key{height:36px}.compact .key svg{width:28px;height:28px}.compact .volume{padding:7px 10px}.compact .bars{height:24px}.compact .separator{margin:8px 0}
.compact .transform{padding:8px;border-radius:12px}.compact .picture-layout{grid-template-columns:minmax(0,1fr) 116px;gap:12px}.compact .size-controls{gap:6px}.compact .size-control{grid-template-columns:36px minmax(0,1fr) 36px}
.compact .decrease-stack{grid-template-rows:36px 30px}.compact .adjust{height:70px}.compact .adjust.minus{height:36px}.compact .adjust svg{width:21px;height:21px}.compact .size-reset{height:30px}.compact .size-reset svg{width:17px;height:17px}.compact .picture-value{min-height:70px;gap:4px}.compact .size-number{font-size:21px}.compact .size-number[data-long=true]{font-size:16px}.compact .value-wrap input{height:70px;font-size:17px}
.compact .dpad{grid-template-columns:repeat(3,36px);grid-template-rows:repeat(3,36px)}.compact .dpad svg{width:23px;height:23px}.compact .position-text{margin-top:8px}.compact .footer{margin-top:8px}.compact .pill{min-height:36px;padding:7px 12px}.compact .profiles-toggle{min-height:36px;font-size:12px}.compact .profiles-toggle svg{width:20px;height:20px}
.compact .message{margin-top:8px;min-height:0}.compact .message:empty{display:none}
@media(max-width:430px){.remote:not(.compact){padding:19px 16px;border-radius:24px}.key{height:63px}}
.remote{container-type:inline-size;container-name:remote-size}
@container remote-size (max-width:340px){.remote:not(.compact) .picture-layout{grid-template-columns:1fr;gap:22px}.remote:not(.compact) .position{justify-self:center;width:140px}.remote:not(.compact) .size-control{grid-template-columns:54px minmax(0,1fr) 54px}}
@container remote-size (max-width:325px){.compact .picture-layout{grid-template-columns:1fr;gap:16px}.compact .position{justify-self:center;width:116px}}
@media(pointer:coarse){.remote .size-control{grid-template-columns:44px minmax(0,1fr) 44px}.remote .decrease-stack{grid-template-rows:44px 44px}.remote .adjust{height:92px}.remote .adjust.minus,.remote .size-reset{height:44px}.remote .picture-value{min-height:92px}.remote .value-wrap input{height:92px}.remote .dpad{grid-template-columns:repeat(3,44px);grid-template-rows:repeat(3,44px)}.remote .pill,.remote .profiles-toggle{min-height:44px}}

.header{gap:12px}.header h2{flex-shrink:0}.header-actions{display:flex;align-items:center;justify-content:flex-end;gap:3px;min-width:0}.header-actions.with-slot{flex:1}.sharing{background:var(--card);border-radius:12px;padding:10px;margin-bottom:12px}.sharing-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:8px}.sharing .pill{padding:7px 12px;font-size:12px}.sharing .on{background:#158761}.permissions{display:flex;gap:5px}.permissions button{display:flex;align-items:center;justify-content:center;gap:5px;flex:1;background:var(--elevated);border-radius:9px;padding:7px;font-size:12px}.permissions button[aria-pressed=true]{background:var(--primary);color:var(--on-primary)}.permissions svg{width:14px;height:14px}
.header h2{display:flex;align-items:center}.brand-frame{display:inline-grid}.brand-frame>.brand{grid-area:1/1}.brand{display:block;width:108px;height:auto;aspect-ratio:944.16 / 293.5061;object-fit:contain}
.sharing-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;margin:0 0 12px}.control{--control-on:var(--primary);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:7px;background:none;border-radius:10px;padding:4px 0;min-height:58px;min-width:0}.control[data-control=enabled]{--control-on:#158761}.control-label{font-size:12px;white-space:nowrap}.control-track{position:relative;display:block;width:57.5px;height:26px;border-radius:999px;background:var(--elevated)}.control-thumb{position:absolute;left:3px;top:3px;display:grid;place-items:center;width:20px;height:20px;border-radius:50%;background:var(--muted);color:var(--background);transition:translate 120ms ease}.control-thumb svg{width:14px;height:14px;stroke-width:2}.control[aria-checked=true] .control-track{background:var(--control-on)}.control[aria-checked=true] .control-thumb{translate:31.5px;background:var(--text)}
.media{grid-template-rows:74px 74px 74px}.media .back{grid-area:1/1}.media .play{grid-area:1/2/3/3;height:auto}.media .play svg{width:48px;height:48px}.media .forward{grid-area:1/3}.media .start{grid-area:2/1}.media .end{grid-area:2/3}.media .audio-key{grid-area:3/1}.media .volume{grid-area:3/2/4/4}.message:empty{display:none}
.compact .sharing{padding:8px;margin-bottom:8px}.compact .sharing-row{gap:4px;margin-bottom:8px}.compact .control{min-height:46px;gap:5px;padding:0}.compact .control-label{font-size:11px}.compact .permissions button{min-height:28px;padding:5px 4px;font-size:11px}.compact .media{grid-template-rows:36px 36px 36px}.compact .media .play{height:auto}.compact .media .play svg{width:36px;height:36px}
@media(max-width:430px){.remote:not(.compact) .media{grid-template-rows:63px 63px 63px}.sharing{padding:10px 8px}.sharing-row{gap:4px}.control-label{font-size:11px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
.compact .master-row{margin-bottom:6px;gap:16px}.compact .master-row .control{flex-direction:row;min-height:28px;gap:6px}.compact .sharing-row{margin-bottom:4px}
.master-row{display:flex;justify-content:center;gap:22px;margin-bottom:8px}.sharing-row{grid-template-columns:repeat(3,minmax(0,1fr));margin-bottom:0}.control[data-control=queue]:disabled,.control[data-control=playback]:disabled,.control[data-control=transform]:disabled{opacity:.35}.remote.settings-only{padding:0;max-width:none;border-radius:0;background:none}.settings-only>.header,.settings-only>.media,.settings-only>.transform,.settings-only>.separator,.settings-only>.profiles{display:none}.settings-only>.sharing{margin-bottom:0;padding:0;background:none}.settings-only .master-row{justify-content:stretch;margin:0 0 10px}.settings-only .master-row .control{width:100%;display:flex;flex-direction:row;justify-content:flex-start;gap:12px;min-height:36px;padding:0}.settings-only .master-row .control:active{transform:none}.settings-only .master-row .control-label{font-size:14px;font-weight:600}.settings-only .sharing-row{gap:10px}.settings-only .sharing-row .control{flex-direction:row;flex-wrap:wrap;gap:8px;min-height:36px;padding:8px;border-radius:10px;background:var(--card)}.settings-only .control-label{font-size:12px}

`;
  const paths = {
    home: ['M3 10 12 3l9 7M5 9v12h5v-7h4v7h5V9'],
    sun: ['M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0','M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5 19 19M5 19l1.5-1.5M17.5 6.5 19 5'],
    moon: ['M20 14a8.5 8.5 0 0 1-10-10 8.5 8.5 0 1 0 10 10Z'],
    libraryNormal: ['M3 3h7v10H3zM14 3h7v10h-7zM3 17h7M14 17h7M3 21h5M14 21h5'],
    libraryList: ['M3 4h4v6H3zM11 5h10M11 9h7M3 14h4v6H3zM11 15h10M11 19h7'],
    libraryPoster: ['M3 5h7v14H3zM14 5h7v14h-7z'],
    film: ['M3 3h18v18H3zM7 3v18M17 3v18M3 9h4M3 15h4M17 9h4M17 15h4'],
    tv: ['M3 7h18v14H3zM8 3l4 4 4-4'],
    filter: ['M4 6h16M7 12h10M10 18h4'], sort: ['M8 3v18m-4-4 4 4 4-4M14 4h7M14 9h5M14 14h3'],
    queue: ['M4 5h16M4 10h16M4 15h7M17 14v6M14 17h6'], shuffle: ['M4 6h3c5 0 5 12 10 12h3M17 15l3 3-3 3M4 18h3c2 0 3-2 4-4M14 9c1-2 2-3 3-3h3M17 3l3 3-3 3'],
    search: ['M15 15l6 6', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0'],
    admin: ['M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6l-9-4Z', 'm8 12 3 3 5-6'], chevron: ['m6 9 6 6 6-6'],
    check: ['m5 12 5 5 9-9'],
    close: ['M18 6 6 18M6 6l12 12'], play: ['m8 4 12 8-12 8V4Z'], pause: ['M9 5v14M15 5v14'],
    start: ['M5 4v16', 'M20 4 8 12l12 8V4Z'], end: ['M19 4v16', 'M4 4l12 8-12 8V4Z'],
    mute: ['M11 5 6 9H3v6h3l5 4V5Z', 'M15 9a5 5 0 0 1 0 6M18 6a9 9 0 0 1 0 12'],
    muted: ['M11 5 6 9H3v6h3l5 4V5Z', 'M16 9l6 6m0-6-6 6'],
    back: ['M4 9a8 8 0 1 1 0 6', 'M4 4v5h5'], forward: ['M20 9a8 8 0 1 0 0 6', 'M20 4v5h-5'],
    zoom: ['M15 15l6 6', 'M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0'],
    fullscreen: ['M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5'],
    fullscreenExit: ['M3 8h5V3M16 3v5h5M21 16h-5v5M8 21v-5H3'],
    captions: ['M5 5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z', 'M10 9H7v6h3M17 9h-3v6h3'],
    captionsOn: ['M5 5h14a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3ZM6 8h5v2H8v4h3v2H6ZM13 8h5v2h-3v4h3v2h-5Z'],
    theater: ['M3 6h18v12H3z'], drawer: ['M3 4h18v16H3zM14 4v16M6 8h5M6 12h5M6 16h5'],
    stretchX: ['M3 12h18m-5-5 5 5-5 5M8 7l-5 5 5 5'], stretchY: ['M12 3v18m-5-5 5 5 5-5M7 8l5-5 5 5'],
    minus: ['M5 12h14'], plus: ['M5 12h14M12 5v14'], up: ['M12 20V4m-7 7 7-7 7 7'],
    down: ['M12 4v16m-7-7 7 7 7-7'], left: ['M20 12H4m7-7-7 7 7 7'], right: ['M4 12h16m-7-7 7 7-7 7'],
    center: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M12 2v5m0 10v5M2 12h5m10 0h5'],
    bookmark: ['M6 3h12v18l-6-4-6 4V3Z'], open: ['M10 4H4v16h16v-6M14 3h7v7M21 3 11 13'],
    lock: ['M6 10h12v11H6zM8 10V6a4 4 0 0 1 8 0v4'], mic: ['M9 6a3 3 0 0 1 6 0v6a3 3 0 0 1-6 0V6zM6 11v1a6 6 0 0 0 12 0v-1M12 18v3M8 21h8'],
    users: ['M11 7a3 3 0 1 1-6 0 3 3 0 0 1 6 0M3 20v-2a5 5 0 0 1 10 0v2M16 4a3 3 0 0 1 0 6M17 13a4 4 0 0 1 4 4v3'],
    refresh: ['M3 12a9 9 0 0 1 15.364-6.364L21 8M21 3v5h-5',
      'M21 12a9 9 0 0 1-15.364 6.364L3 16M3 21v-5h5'],
    logout: ['M9 4H3v16h6M9 12h12m-5-5 5 5-5 5'],
    website: ['M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0', 'M4 12h16M12 4c-5 5-5 11 0 16M12 4c5 5 5 11 0 16'],
    remote: ['M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Z', 'M9 6h6M9 10h.01M15 10h.01M9 14h.01M15 14h.01M9 18h6'],
    settings: ['M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0', gearPath()]
  };
  function gearPath() {
    const point = (degrees, radius) => {
      const angle = degrees * Math.PI / 180;
      return (12 + radius * Math.cos(angle)).toFixed(3) + ' ' + (12 + radius * Math.sin(angle)).toFixed(3);
    };
    // Eight equal trapezoidal teeth centered on the cardinal/diagonal axes.
    let path = 'M' + point(-102, 7.5);
    for (let i = 0; i < 8; i++) {
      const center = -90 + i * 45;
      path += 'L' + point(center - 7, 9.5) + 'L' + point(center + 7, 9.5) + 'L' + point(center + 12, 7.5) +
        'A7.5 7.5 0 0 1 ' + point(center + 33, 7.5);
    }
    return path + 'Z';
  }
  function node(doc, parent, tag, text, attrs = {}) {
    const n = doc.createElement(tag); if (text !== undefined) n.textContent = text;
    for (const [key, value] of Object.entries(attrs)) n.setAttribute(key, value);
    parent.append(n); return n;
  }
  function icon(doc, name, seekSeconds = 15) {
    const svg = doc.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    for (const d of paths[name] || []) { const p = doc.createElementNS(svg.namespaceURI, 'path'); p.setAttribute('d', d); svg.append(p); }
    if(name==='captionsOn'){svg.firstChild.setAttribute('fill','currentColor');svg.firstChild.setAttribute('fill-rule','evenodd');svg.firstChild.setAttribute('stroke','none');}
    if (name === 'back' || name === 'forward') {
      const text = doc.createElementNS(svg.namespaceURI, 'text'); text.textContent = String(seekSeconds); text.setAttribute('x', '12'); text.setAttribute('y', '15');
      text.setAttribute('text-anchor', 'middle'); text.setAttribute('stroke', 'none'); text.setAttribute('fill', 'currentColor'); text.setAttribute('font-size', '7'); text.setAttribute('font-weight', '700'); svg.append(text);
    }
    return svg;
  }
  const BADGE_CSS = `
.uburoom-badge{width:min(164px,calc(100vw - 32px));min-height:186px;padding:16px 12px 12px;box-sizing:border-box;background:var(--card);color:var(--text);color-scheme:inherit;border-radius:18px;text-align:center;font:14px/1.4 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}
.badge-symbol{display:grid;place-items:center;height:112px;color:var(--badge-color,var(--text))}.badge-symbol svg{width:min(112px,100%);height:112px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
.badge-value{min-height:20px;margin-top:5px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.badge-name{color:var(--muted);overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.badge-announcement{position:absolute;width:1px;height:1px;padding:0;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
`;
  function badgeDetails(command, state = {}) {
    const { action, args = {} } = command, picture = state.picture || {};
    const percent = n => Number(((n ?? 1) * 100).toFixed(2)) + '%';
    const position = (axis, n) => axis.toUpperCase() + ' ' + (n > 0 ? '+' : '') + percent(n ?? 0);
    let symbol, value = '', label;
    switch (action) {
      case 'media.play': case 'media.pause': case 'media.toggle':
        symbol = action === 'media.toggle' ? (state.paused ? 'pause' : 'play') : action.slice(6);
        label = symbol === 'play' ? 'Play' : 'Pause'; break;
      case 'media.mute': case 'media.unmute': case 'media.volume.set':
        symbol = action === 'media.mute' ? 'muted' : 'mute';
        label = action === 'media.volume.set' ? 'Volume' : action === 'media.mute' ? 'Mute' : 'Unmute';
        if (action === 'media.volume.set') value = (state.volume ?? args.percent) + '%'; break;
      case 'media.seek.relative':
        symbol = args.seconds < 0 ? 'back' : 'forward'; label = args.seconds < 0 ? 'Seek back' : 'Seek forward'; break;
      case 'media.seek.absolute': {
        const seconds = Math.floor(state.position ?? args.seconds ?? 0);
        symbol = 'end'; value = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); label = 'Seek'; break;
      }
      case 'media.load': symbol = 'play'; label = 'Video selected'; break;
      case 'media.previous': symbol = 'start'; label = 'Previous / restart'; break;
      case 'media.next': symbol = 'end'; label = 'Next video'; break;
      case 'media.quality.set': symbol = 'settings'; value = global.uburoom?.QUALITIES?.find(q => q.id === global.uburoom.qualityId(args.quality))?.label || (args.quality === 'direct' ? 'Original' : args.quality); label = 'Quality'; break;
      case 'media.seek.start': symbol = 'start'; label = 'Back to start'; break;
      case 'media.seek.end': symbol = 'end'; label = 'Go to end / live'; break;
      case 'zoom.set': case 'zoom.adjust': case 'reset.zoom':
        symbol = 'zoom'; value = percent(picture.zoom); label = action === 'reset.zoom' ? 'Reset zoom' : 'Zoom'; break;
      case 'stretch.set': case 'stretch.adjust': case 'reset.stretchX': case 'reset.stretchY':
        symbol = args.axis || action.slice(6); value = percent(picture[symbol]);
        label = (action.startsWith('reset.') ? 'Reset ' : '') + (symbol === 'stretchX' ? 'width' : 'height'); break;
      case 'pan.step': case 'pan.edge':
        symbol = args.axis === 'x' ? (args.sign < 0 ? 'left' : 'right') : (args.sign < 0 ? 'up' : 'down');
        value = action === 'pan.edge' ? 'Offscreen' : position(args.axis, picture[args.axis]); label = 'Move ' + symbol; break;
      case 'pan.set': case 'pan.move':
        symbol = 'center'; value = position('x', picture.x) + ' · ' + position('y', picture.y); label = 'Position'; break;
      case 'reset.pan': symbol = 'center'; value = 'Centered'; label = 'Recenter'; break;
      case 'reset.stretch': symbol = 'refresh'; value = 'Width / height'; label = 'Reset stretch'; break;
      case 'reset.all': symbol = 'refresh'; value = 'Reset all'; label = value; break;
      case 'profile.load': case 'profile.save':
        symbol = 'bookmark'; value = (action === 'profile.load' ? '↥ Load ' : '↧ Save ') + args.slot; label = value; break;
      case 'room.enable': symbol = 'website'; value = 'Enabled'; label = 'Enable remote'; break;
      case 'room.disable': symbol = 'close'; value = 'Off'; label = 'Disable remote'; break;
      case 'room.controls':
        symbol = args.control === 'playback' ? 'play' : 'zoom';
        value = (args.control === 'playback' ? 'Playback' : 'Picture') + (args.allowed ? ' shared' : ' private'); label = value; break;
      case 'room.autojoin': symbol = 'mic'; value = 'On join ' + (args.enabled ? 'on' : 'off'); label = value; break;
      case 'room.sharing':
        symbol = { owner:'lock', voice:'mic', guild:'users' }[args.mode];
        value = { owner:'Owner only', voice:'Voice channel', guild:'Server members' }[args.mode]; label = value; break;
      case 'room.visibility': symbol = args.visibility === 'private' ? 'lock' : 'users'; value = args.visibility === 'private' ? 'Private' : 'Public'; label = value; break;
      case 'status.get': case 'help.get': return;
      default: return;
    }
    const color = { zoom:'var(--accent-text)', stretchX:'var(--accent-text)', stretchY:'var(--accent-text)' }[symbol] ||
      (action === 'room.disable' || action === 'reset.all' ? '#ea3035' : 'var(--text)');
    return { symbol, value, label, color, ...(action === 'media.seek.relative' ? { seekSeconds: Math.abs(args.seconds) } : {}) };
  }
  function mountBadge(host) {
    const doc = host.ownerDocument;
    node(doc, host, 'style', BADGE_CSS);
    const root = node(doc, host, 'div', undefined, { class:'uburoom-badge' });
    const symbol = node(doc, root, 'div', undefined, { class:'badge-symbol', 'aria-hidden':'true' });
    const value = node(doc, root, 'div', '', { class:'badge-value', 'aria-hidden':'true' });
    const name = node(doc, root, 'div', '', { class:'badge-name', 'aria-hidden':'true' });
    const announcement = node(doc, root, 'span', '', { class:'badge-announcement' });
    function render(details, sender) {
      symbol.replaceChildren(icon(doc, details.symbol, details.seekSeconds));
      root.style.setProperty('--badge-color', details.color);
      value.textContent = details.value; name.textContent = sender;
      name.title = sender;
      announcement.textContent = details.label + (details.value && details.value !== details.label ? ' ' + details.value : '') + ' by ' + sender;
    }
    return {
      show(command, state, sender) {
        const details = badgeDetails(command, state); if (!details) return false;
        root.dataset.action = command.action; render(details, sender); return true;
      },
      notice(message, sender, symbol = 'close') {
        root.dataset.action = 'notice'; render({symbol,color:symbol === 'close' ? '#ea3035' : 'var(--text)',value:message,label:message}, sender);
      }
    };
  }
  function mount(host, { execute, close, compact = false, volumeInterval = 25, website, trustedRoomControls = false, headerSlot, showAutoJoin = true, settingsOnly = false } = {}) {
    const doc = host.ownerDocument, shadow = host.attachShadow({ mode: 'open' });
    node(doc, shadow, 'style', CSS);
    const root = node(doc, shadow, 'section', undefined, { class: 'remote' + (compact ? ' compact' : '') + (settingsOnly ? ' settings-only' : ''), 'aria-label': settingsOnly ? 'Remote permissions' : 'uburoom remote' });
    let state = {}, available = false, canSave = true, canPlayback = true, canAudio = true, canTransform = true, slot = 1, busy = false, holdTimer, holdId = 0, generation = 0;
    let room, pendingVolume, volumeDraft, dragging = false, volumeTimer, lastVolumeAt = 0, volumeSettledAt = 0;
    const message = node(doc, root, 'p', '', { class: 'message', role: 'status' });
    function notify(text, error = false) { message.textContent = text; message.classList.toggle('error', error); }
    async function act(command, event) {
      const policy = command.action.startsWith('room.');
      if (busy || (policy ? !room?.canManage : !available) || policy && trustedRoomControls && !event?.isTrusted) return;
      const audio = ['media.volume.set','media.mute','media.unmute'].includes(command.action);
      if (!policy && (audio ? !canAudio : command.action.startsWith('media.') ? !canPlayback : !canTransform)) return;
      if (policy || ['media.mute', 'media.unmute'].includes(command.action)) { clearTimeout(volumeTimer); pendingVolume = volumeDraft = undefined; dragging = false; }
      const version = generation;
      busy = true;
      try {
        const result = await execute(command);
        if (version !== generation) return;
        if (result?.state) state = result.state;
        if (result?.status !== 'applied' && command.action === 'media.volume.set') { pendingVolume = volumeDraft = undefined; dragging = false; }
        if (command.action === 'media.volume.set') volumeSettledAt = Date.now();
        notify(result?.status === 'applied' ? '' : (result?.message || 'This action is unavailable.'), result?.status !== 'applied');
      } catch (e) { if (version === generation) { stop(); notify(e.message || 'Connection unavailable.', true); } }
      finally { busy = false; if (version === generation) render(state); scheduleVolume(); }
    }
    function button(parent, name, className, action, label) {
      const b = node(doc, parent, 'button', label, { type: 'button', class: className, 'aria-label': name, title: name });
      if (action) b.addEventListener('click', e => { const c = action(e); if (c) act(c, e); }); return b;
    }
    function glyph(parent, name, className, image, action) { const b = button(parent, name, className, action); b.append(icon(doc, image)); return b; }
    const header = node(doc, root, 'header', undefined, { class: 'header' });
    const heading = node(doc, header, 'h2');
    const logoUrl = typeof browser !== 'undefined' && browser.runtime?.getURL ? browser.runtime.getURL('assets/uburoom-wordmark-brand.svg') : '/assets/branding/uburoom-wordmark-brand.svg';
    const logo=node(doc, heading, 'img', undefined, { class:'brand', src:global.uburoomTheme?.brandUrl(logoUrl) || logoUrl, alt:'uburoom', width:'108', height:'34' });
    global.addEventListener?.('uburoom-theme',()=>{if(global.uburoomTheme)global.uburoomTheme.updateBrand(logo,logoUrl);});
    const headerActions = node(doc, header, 'div', undefined, { class: 'header-actions' });
    if (headerSlot) { headerActions.classList.add('with-slot'); node(doc, headerActions, 'slot', undefined, { name: headerSlot }); }
    if (website) glyph(headerActions, 'Open uburoom website', 'plain', 'website', () => { website(); });
    const closeButton = glyph(headerActions, 'Close remote', 'plain', 'close', () => { stop(); close?.(); }); closeButton.hidden = !close;
    const sharingPanel = node(doc, root, 'section', undefined, { class: 'sharing', 'aria-label': 'Remote access', hidden: '' });
    const masterRow = node(doc, sharingPanel, 'div', undefined, { class:'master-row' });
    const sharingRow = node(doc, sharingPanel, 'div', undefined, { class:'sharing-row' });
    const controlButtons = [];
    for (const [field, label, image, description] of [
      ['enabled', settingsOnly ? 'Remote control' : 'Enable', 'website', 'Allow others to control the media'],
      ['playback', 'Playback', 'play', 'Allow guest playback controls - play/pause, seek, skip'],
      ['queue', 'Queue', 'queue', 'Queue controls are coming soon'],
      ['transform', 'Picture', 'zoom', 'Allow guest picture controls - zoom, width, height, position'],
      ['autoJoin', 'On join', 'mic', 'Remember auto-enable on this Firefox device when you join a call']
    ]) {
      if (field === 'autoJoin' && !showAutoJoin) continue;
      const b = button(field === 'enabled' || field === 'autoJoin' ? masterRow : sharingRow, description, 'control', field === 'queue' ? undefined :
        () => field === 'enabled' ? { action: room?.enabled ? 'room.disable' : 'room.enable' } :
          field === 'autoJoin' ? { action:'room.autojoin', args:{enabled:!room?.autoJoin} } :
          { action:'room.controls', args:{control:field,allowed:!room?.controls?.[field]} });
      b.dataset.control = field; b.setAttribute('role','switch'); b.setAttribute('aria-checked','false');
      node(doc,b,'span',label,{class:'control-label'});
      const track = node(doc,b,'span',undefined,{class:'control-track','aria-hidden':'true'});
      const thumb = node(doc,track,'span',undefined,{class:'control-thumb'}); thumb.append(icon(doc,image));
      controlButtons.push(b);
    }
    const toggleRemote = controlButtons[0];
    const media = node(doc, root, 'section', undefined, { class: 'media', 'aria-label': 'Media playback' });
    const back = glyph(media, 'Back 15 seconds', 'key back', 'back', () => ({ action: 'media.seek.relative', args: { seconds: -15 } }));
    const play = glyph(media, 'Play / pause', 'key play', 'pause', () => ({ action: 'media.toggle' }));
    const forward = glyph(media, 'Forward 15 seconds', 'key forward', 'forward', () => ({ action: 'media.seek.relative', args: { seconds: 15 } }));
    const start = glyph(media, 'Back to available start', 'key start', 'start', () => ({ action: 'media.seek.start' }));
    const end = glyph(media, 'Go to end / live', 'key end', 'end', () => ({ action: 'media.seek.end' }));
    const mute = glyph(media, 'Mute', 'key audio-key', 'mute', () => ({ action: state.muted ? 'media.unmute' : 'media.mute' }));
    const volume = node(doc, media, 'div', undefined, { class: 'volume', role: 'group', 'aria-label': 'Volume' });
    const bars = node(doc, volume, 'div', undefined, { class: 'bars' }), fills = [];
    for (let i = 0; i < 20; i++) {
      const bar = node(doc, bars, 'span', undefined, { class: 'bar', 'aria-hidden': 'true' }); bar.style.setProperty('--height', (20 + i * 80 / 19) + '%');
      fills.push(node(doc, bar, 'div', undefined, { class: 'fill' }));
    }
    const range = node(doc, bars, 'input', undefined, { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'Volume percentage' });
    const volumeValue = button(volume, 'Enter exact volume', 'number', undefined, '—');
    const volumeEdit = node(doc, volume, 'input', undefined, { class: 'number-input', type: 'number', min: '0', max: '100', step: '1', inputmode: 'numeric', 'aria-label': 'Exact volume percentage' }); volumeEdit.hidden = true;
    function scheduleVolume() {
      clearTimeout(volumeTimer);
      if (pendingVolume === undefined || busy || !available || !canAudio) return;
      const sendVolume = () => {
        if (!available || !canAudio || busy || pendingVolume === undefined) return;
        const percent = pendingVolume; pendingVolume = undefined; lastVolumeAt = Date.now();
        act({ action: 'media.volume.set', args: { percent } });
      };
      const delay = Math.max(0, volumeInterval - (Date.now() - lastVolumeAt));
      if (delay) volumeTimer = setTimeout(sendVolume, delay); else sendVolume();
    }
    function volumeInput() {
      if (!available || !canAudio) return;
      volumeDraft = pendingVolume = Number(range.value); volumeSettledAt = 0;
      volumeValue.textContent = range.value + '%'; volume.classList.remove('muted'); paintVolume(volumeDraft); scheduleVolume();
    }
    range.addEventListener('pointerdown', () => { dragging = true; });
    range.addEventListener('input', volumeInput);
    range.addEventListener('change', () => { dragging = false; if (Number(range.value) !== volumeDraft) volumeInput(); scheduleVolume(); });
    for (const event of ['pointerup', 'pointercancel', 'blur']) range.addEventListener(event, () => { dragging = false; scheduleVolume(); });
    node(doc, root, 'div', undefined, { class: 'separator' });
    const transform = node(doc, root, 'section', undefined, { class: 'transform', 'aria-label': 'Picture adjustments' });
    const pictureLayout = node(doc, transform, 'div', undefined, { class: 'picture-layout' });
    const sizeControls = node(doc, pictureLayout, 'div', undefined, { class: 'size-controls', role: 'group', 'aria-label': 'Picture size' }), sizeFields = [];
    function stopHold() { holdId++; clearTimeout(holdTimer); }
    function stop() { generation++; stopHold(); clearTimeout(volumeTimer); pendingVolume = volumeDraft = undefined; dragging = false; }
    function repeat(b, command) {
      b.addEventListener('pointerdown', e => {
        if (e.button !== 0 || b.disabled) return; stopHold(); const id = holdId;
        const tick = async () => { if (id !== holdId || !available) return; await act(command(e)); if (id === holdId) holdTimer = setTimeout(tick, 180); };
        holdTimer = setTimeout(tick, 450);
      });
      for (const event of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) b.addEventListener(event, stopHold);
    }
    function precision(display, input, currentValue, command) {
      display.addEventListener('click', () => { if (display.disabled) return; input.value = currentValue(); display.hidden = true; input.hidden = false; input.focus(); input.select(); });
      function finish(save) {
        if (input.hidden) return;
        const n = Number(input.value); input.hidden = true; display.hidden = false;
        if (save && input.value.trim() && Number.isFinite(n) && n >= Number(input.min) && n <= Number(input.max)) act(command(n));
        else { if (save) notify('Enter a value from ' + input.min + ' to ' + input.max + '.', true); render(state); }
      }
      input.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') { e.stopPropagation(); finish(e.key === 'Enter'); } }); input.addEventListener('blur', () => finish(true));
    }
    precision(volumeValue, volumeEdit, () => state.volume ?? 0, n => ({ action: 'media.volume.set', args: { percent: n } }));
    for (const [field, label] of [['zoom', 'Zoom'], ['stretchX', 'Width'], ['stretchY', 'Height']]) {
      const control = node(doc, sizeControls, 'div', undefined, { class: 'size-control', 'data-field': field, role: 'group', 'aria-label': label + ' adjustment' });
      const decrease = node(doc, control, 'div', undefined, { class: 'decrease-stack' });
      const adjust = (sign, e) => ({ action: field === 'zoom' ? 'zoom.adjust' : 'stretch.adjust', args: { axis: field, delta: sign * (e?.ctrlKey ? .25 : field === 'zoom' ? .005 : .01) } });
      const minus = glyph(decrease, 'Decrease ' + label.toLowerCase() + ' (hold to repeat; Ctrl faster)', 'adjust minus', 'minus', e => adjust(-1, e));
      const reset = glyph(decrease, 'Reset ' + label.toLowerCase() + ' to 100%', 'size-reset', 'refresh', () => ({ action: 'reset.' + field }));
      const valueWrap = node(doc, control, 'div', undefined, { class: 'value-wrap' });
      const value = button(valueWrap, 'Enter exact ' + label.toLowerCase() + ' percentage', 'number picture-value');
      const name = node(doc, value, 'span', undefined, { class: 'size-label' }); name.append(icon(doc, field)); node(doc, name, 'span', label);
      const number = node(doc, value, 'span', '100%', { class: 'size-number' });
      const edit = node(doc, valueWrap, 'input', undefined, { class: 'number-input', type: 'number', min: '10', max: '1600', step: field === 'zoom' ? '.5' : '1', inputmode: 'decimal', 'aria-label': 'Exact ' + label.toLowerCase() + ' percentage' }); edit.hidden = true;
      const plus = glyph(control, 'Increase ' + label.toLowerCase() + ' (hold to repeat; Ctrl faster)', 'adjust plus', 'plus', e => adjust(1, e));
      repeat(minus, e => adjust(-1, e)); repeat(plus, e => adjust(1, e));
      precision(value, edit, () => Number(((state.picture?.[field] ?? 1) * 100).toFixed(2)), n => ({ action: field === 'zoom' ? 'zoom.set' : 'stretch.set', args: { axis: field, value: n / 100 } }));
      sizeFields.push({ field, number, reset });
    }
    const position = node(doc, pictureLayout, 'section', undefined, { class: 'position', 'aria-label': 'Picture position' });
    const dpad = node(doc, position, 'div', undefined, { class: 'dpad', role: 'group', 'aria-label': 'Pan picture' });
    for (const direction of ['up', 'left', 'center', 'right', 'down']) {
      const command = e => direction === 'center' ? { action: 'reset.pan' } : { action: e?.shiftKey ? 'pan.edge' : 'pan.step', args: {
        axis: ['left', 'right'].includes(direction) ? 'x' : 'y', sign: ['up', 'left'].includes(direction) ? -1 : 1, fast: e?.ctrlKey === true } };
      const b = glyph(dpad, direction === 'center' ? 'Recenter picture' : 'Pan ' + direction + ' (Ctrl faster; Shift offscreen)', direction, direction, command);
      if (direction !== 'center') repeat(b, command);
    }
    const positionText = node(doc, position, 'div', undefined, { class: 'position-text' }); node(doc, positionText, 'span', 'Position', { class: 'position-label' });
    const coords = node(doc, positionText, 'output', 'Centered', { 'aria-live': 'polite' });
    const footer = node(doc, transform, 'footer', undefined, { class: 'footer' });
    const profileToggle = glyph(footer, 'Profiles', 'profiles-toggle', 'bookmark', () => { profiles.hidden = !profiles.hidden; }); node(doc, profileToggle, 'span', 'Profiles');
    const resetAll = glyph(footer, 'Reset all picture settings', 'pill reset-all', 'refresh', () => ({ action: 'reset.all' })); node(doc, resetAll, 'span', 'Reset all');
    const profiles = node(doc, root, 'section', undefined, { class: 'profiles', 'aria-label': 'Device picture profiles' }); profiles.hidden = true;
    const slots = node(doc, profiles, 'div', undefined, { class: 'slots' }), slotButtons = [];
    for (let i = 1; i <= 9; i++) slotButtons.push(button(slots, 'Profile ' + i, 'slot', () => { slot = i; render(state); }, String(i)));
    const profileActions = node(doc, profiles, 'div', undefined, { class: 'profile-actions' });
    button(profileActions, 'Load selected profile', '', () => ({ action: 'profile.load', args: { slot } }), '↥ Load');
    const save = button(profileActions, 'Save selected profile', '', () => ({ action: 'profile.save', args: { slot } }), '↧ Save');
    root.append(message);
    function paintVolume(n) { fills.forEach((f, i) => { f.style.width = Math.max(0, Math.min(100, (n - i * 5) * 20)) + '%'; }); }
    function render(next = state, options = {}) {
      state = next || {}; if (options.available !== undefined) available = options.available; if (options.canSave !== undefined) canSave = options.canSave;
      if (options.canPlayback !== undefined) canPlayback = options.canPlayback;
      canAudio = options.canAudio ?? canPlayback;
      if (options.canTransform !== undefined) canTransform = options.canTransform;
      if (options.room !== undefined) room = options.room;
      const picture = state.picture || {};
      for (const b of root.querySelectorAll('button,input')) b.disabled = !available;
      for (const b of media.querySelectorAll('button,input')) b.disabled = !available || !canPlayback;
      for (const b of [mute, range, volumeValue, volumeEdit]) b.disabled = !available || !canAudio;
      for (const b of root.querySelectorAll('.transform button,.transform input,.dpad button,.footer button,.profile-actions button')) b.disabled = !available || !canTransform;
      for (const b of [profileToggle, ...slotButtons, closeButton, ...headerActions.querySelectorAll('button')]) b.disabled = false;
      sharingPanel.hidden = !room?.canManage;
      toggleRemote.setAttribute('aria-label', 'Allow others to control the media');
      toggleRemote.title = 'Allow others to control the media';
      for (const b of controlButtons) {
        const field = b.dataset.control;
        b.setAttribute('aria-checked', String(field === 'playback' || field === 'transform' ? room?.controls?.[field] !== false : !!room?.[field]));
        b.disabled = field === 'queue' || (field === 'playback' || field === 'transform') && !room?.enabled || busy || !room?.reachable || field === 'enabled' && !room?.enabled && (!room?.connected || !room?.paired) ||
          field === 'autoJoin' && !room?.autoJoin && (!room?.connected || !room?.sharingAvailable);
      }

      back.disabled = forward.disabled = start.disabled = end.disabled = !available || !canPlayback || state.seekable !== true;
      back.title = forward.title = state.seekable ? 'Seek 15 seconds' : 'Seeking unavailable for this player';
      start.title = state.seekable ? 'Back to available start' : 'Seeking unavailable for this player'; end.title = state.seekable ? 'Go to end / live' : 'Seeking unavailable for this player';
      play.replaceChildren(icon(doc, state.paused && !state.waitingForReady ? 'play' : 'pause')); play.setAttribute('aria-label', state.paused && !state.waitingForReady ? 'Play' : 'Pause');
      mute.replaceChildren(icon(doc, state.muted ? 'muted' : 'mute')); mute.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute'); mute.setAttribute('aria-pressed', String(!!state.muted));
      if (volumeDraft !== undefined && !dragging && pendingVolume === undefined && !busy && volumeSettledAt && Date.now() - volumeSettledAt > 1000) volumeDraft = undefined;
      const shownVolume = volumeDraft ?? state.volume;
      volume.classList.toggle('muted', volumeDraft === undefined && (!!state.muted || state.volume === 0)); volumeValue.textContent = shownVolume === undefined ? '—' : shownVolume + '%';
      if (!dragging) range.value = shownVolume ?? 0; paintVolume(Number(range.value));
      for (const { field, number, reset } of sizeFields) {
        const percentage = Number(((picture[field] ?? 1) * 100).toFixed(2)) + '%'; number.textContent = percentage; number.dataset.long = String(percentage.length > 4);
        reset.disabled = !available || !canTransform || Math.abs((picture[field] ?? 1) - 1) < 1e-8;
      }
      const offset = (field, negative, positive) => Math.abs(Number(((picture[field] || 0) * 100).toFixed(2))) + '% ' + (picture[field] < 0 ? negative : positive);
      const coordinates = [picture.x ? offset('x', 'left', 'right') : '', picture.y ? offset('y', 'up', 'down') : ''].filter(Boolean).join(' · ') || 'Centered';
      if (coords.textContent !== coordinates) coords.textContent = coordinates;
      slotButtons.forEach((b, i) => { b.setAttribute('aria-pressed', String(i + 1 === slot)); b.textContent = (i + 1) + (state.profileSlots?.includes(i + 1) ? '·' : ''); });
      save.hidden = !canSave;
      if ((!available || !canAudio) && (pendingVolume !== undefined || volumeDraft !== undefined)) stop();
      if (!available || !canTransform) stopHold();
    }
    render(); return { render, notify, stop, shadow };
  }
  const api = { mount, CSS, icon, mountBadge, BADGE_CSS, badgeDetails };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.uburoomUI = api;
})(globalThis);
