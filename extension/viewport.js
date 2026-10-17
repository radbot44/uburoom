/* Version 1 viewport/transform contract. No room timeline, DOM or network dependencies. */
(function (root) {
  'use strict';
  const VERSION = 1;
  const DEFAULT = Object.freeze({ zoom: 1, stretchX: 1, stretchY: 1, x: 0, y: 0 });
  const PAN_MAX = 129;
  const numeric = (n, min, max) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error('Value outside supported range');
    return n;
  };
  const round = n => Math.round(n * 100000) / 100000;
  function factor(text) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(text)) throw new Error('Use a multiplier or percent');
    let n = Number(text.replace('%', ''));
    if (text.endsWith('%') || n > 16) n /= 100;
    return numeric(n, .1, 16);
  }
  const isCommand = action => typeof action === 'string' && /^(zoom|stretch|pan|reset|profile)\./.test(action);
  function validate(command) {
    if (!command || typeof command !== 'object') throw new Error('Invalid command');
    const action = command.action;
    const a = command.args || {};
    let args = {};
    switch (action) {
      case 'zoom.set': args.value = numeric(a.value, .1, 16); break;
      case 'zoom.adjust': args.delta = numeric(a.delta, -16, 16); break;
      case 'stretch.set': case 'stretch.adjust':
        if (!['stretchX', 'stretchY'].includes(a.axis)) throw new Error('Invalid stretch axis');
        args.axis = a.axis;
        if (action.endsWith('.set')) args.value = numeric(a.value, .1, 16);
        else args.delta = numeric(a.delta, -16, 16);
        break;
      case 'pan.set': case 'pan.move':
        args.x = numeric(a.x, -PAN_MAX, PAN_MAX); args.y = numeric(a.y, -PAN_MAX, PAN_MAX); break;
      case 'pan.step': case 'pan.edge':
        if (!['x', 'y'].includes(a.axis) || ![-1, 1].includes(a.sign)) throw new Error('Invalid pan direction');
        args = { axis: a.axis, sign: a.sign, fast: a.fast === true }; break;
      case 'reset.stretchX': case 'reset.stretchY': case 'reset.pan': case 'reset.zoom': case 'reset.stretch': case 'reset.all': break;
      case 'profile.load': case 'profile.save':
        args.slot = numeric(a.slot, 1, 9);
        if (!Number.isInteger(args.slot)) throw new Error('Use profile 1–9');
        break;
      default: throw new Error('Unsupported command');
    }
    return { action, args };
  }
  function picture(state, input) {
    const { action, args: a } = validate(input);
    const s = { ...state };
    switch (action) {
      case 'zoom.set': s.zoom = a.value; break;
      case 'zoom.adjust': s.zoom = Math.max(.1, Math.min(16, s.zoom + a.delta)); break;
      case 'stretch.set': s[a.axis] = a.value; break;
      case 'stretch.adjust': s[a.axis] = Math.max(.1, Math.min(16, s[a.axis] + a.delta)); break;
      case 'pan.set': s.x = a.x; s.y = a.y; break;
      case 'pan.move': s.x += a.x; s.y += a.y; break;
      case 'pan.step': case 'pan.edge': {
        const scale = s.zoom * (a.axis === 'x' ? s.stretchX : s.stretchY);
        const edge = Math.min(PAN_MAX, Math.max(1, (1 + scale) / 2 + .5));
        s[a.axis] = action === 'pan.edge' ? a.sign * edge :
          Math.max(-edge, Math.min(edge, s[a.axis] + a.sign * .0025 * Math.max(1, scale) * (a.fast ? 40 : 1)));
        break;
      }
      case 'reset.pan': s.x = s.y = 0; break;
      case 'reset.zoom': s.zoom = 1; break;
      case 'reset.stretch': s.stretchX = s.stretchY = 1; break;
      case 'reset.stretchX': s.stretchX = 1; break;
      case 'reset.stretchY': s.stretchY = 1; break;
      case 'reset.all': return { ...DEFAULT };
      default: throw new Error('Not a picture command');
    }
    for (const k of Object.keys(DEFAULT)) numeric(s[k], k === 'x' || k === 'y' ? -PAN_MAX : .1, k === 'x' || k === 'y' ? PAN_MAX : 16);
    return Object.fromEntries(Object.entries(s).map(([k, v]) => [k, round(v)]));
  }
  const api = { VERSION, DEFAULT, PAN_MAX, isCommand, validate, picture, factor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoomViewport = api;
})(globalThis);
