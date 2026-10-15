/* Shared by Firefox content scripts and Node. No DOM or network dependencies. */
(function (root) {
  'use strict';
  const DEFAULT = Object.freeze({ zoom: 1, stretchX: 1, stretchY: 1, x: 0, y: 0 });
  const PAN_MAX = 129;
  const CONTROLS = Object.freeze({ playback: true, transform: true });
  const QUALITIES = Object.freeze([
    { id:'direct', label:'Original' },
    { id:'1080p20', label:'1080 · 20 Mbps', width:1920, height:1080, bitrate:20000 },
    { id:'1080p12', label:'1080 · 12 Mbps', width:1920, height:1080, bitrate:12000 },
    { id:'1080p8', label:'1080 · 8 Mbps', width:1920, height:1080, bitrate:8000 },
    { id:'720p4', label:'720 · 4 Mbps', width:1280, height:720, bitrate:4000 },
    { id:'720p2', label:'720 · 2 Mbps', width:1280, height:720, bitrate:2000 }
  ]);
  const qualityId = id => ({'720p':'720p4','1080p':'1080p8'}[id] || id);
  const validQuality = id => QUALITIES.some(q => q.id === qualityId(id));
  const MANAGEMENT = Object.freeze(['session.enable', 'session.sharing', 'session.visibility', 'session.controls', 'session.autojoin', 'media.load', 'media.quality.set']);
  function controls(value = CONTROLS) {
    if (!value || typeof value.playback !== 'boolean' || typeof value.transform !== 'boolean') throw new Error('Invalid control permissions');
    return { playback: value.playback, transform: value.transform };
  }
  function controlFor(command) {
    if (command.action.startsWith('media.')) return 'playback';
    if (/^(zoom|stretch|pan|reset|profile)\./.test(command.action)) return 'transform';
  }
  function controlAllowed(value, command) {
    const category = controlFor(command);
    return !category || controls(value)[category];
  }
  function joinEligible(session, event, now, offset = 0) {
    return session.autoJoin === true && !session.enabled && session.reachable &&
      now - session.lastAck < 8000 && event.joined === true && event.available === true &&
      typeof event.channelId === 'string' && !!event.channelId && Number.isFinite(event.serverNow) &&
      Number.isFinite(event.expiresAt) && now + offset < event.expiresAt &&
      event.serverNow >= session.autoArmedAt + offset;
  }
  const numeric = (n, min, max) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error('Value outside supported range');
    return n;
  };
  const round = n => Math.round(n * 100000) / 100000;
  // Display metadata only. Identity and permissions continue to use Discord IDs.
  function senderName(value, fallback = 'Discord user') {
    const clean = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 100) : '';
    return clean || fallback;
  }
  function factor(text) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(text)) throw new Error('Use a multiplier or percent');
    let n = Number(text.replace('%', ''));
    if (text.endsWith('%') || n > 16) n /= 100;
    return numeric(n, .1, 16);
  }
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
      case 'reset.stretchX': case 'reset.stretchY': case 'reset.pan': case 'reset.zoom': case 'reset.stretch': case 'reset.all':
      case 'media.pause': case 'media.play': case 'media.mute': case 'media.unmute': case 'media.toggle':
      case 'media.seek.start': case 'media.seek.end':
      case 'status.get': case 'help.get': case 'session.disable': case 'session.enable': break;
      case 'media.previous': case 'media.next': break;
      case 'media.quality.set':
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args.quality = a.quality;
        if (a.compatible !== undefined) {
          if (typeof a.compatible !== 'boolean') throw new Error('Invalid compatibility setting');
          args.compatible = a.compatible;
        }
        if (a.fallback !== undefined) {
          if (a.fallback !== 'av1') throw new Error('Invalid playback fallback');
          args.fallback = 'av1';
        }
        break;
      case 'session.controls':
        if (!['playback', 'transform'].includes(a.control) || typeof a.allowed !== 'boolean') throw new Error('Choose a control permission');
        args = { control: a.control, allowed: a.allowed }; break;
      case 'session.autojoin':
        if (typeof a.enabled !== 'boolean') throw new Error('Choose on or off');
        args.enabled = a.enabled; break;
      case 'session.sharing':
        if (!['owner', 'voice', 'guild'].includes(a.mode)) throw new Error('Choose a sharing mode');
        args.mode = a.mode; break;
      case 'session.visibility':
        if (!['public', 'private'].includes(a.visibility)) throw new Error('Choose Public or Private');
        args.visibility = a.visibility; break;
      case 'media.volume.set': args.percent = numeric(a.percent, 0, 100); break;
      case 'media.load':
        if (typeof a.mediaId !== 'string' || !/^(?:demo|[0-9]{1,20})$/.test(a.mediaId)) throw new Error('Choose a library item');
        if (!validQuality(a.quality)) throw new Error('Choose a playback quality');
        args = { mediaId: a.mediaId, quality: a.quality }; break;
      case 'media.seek.relative': args.seconds = numeric(a.seconds, -600, 600); break;
      case 'media.seek.absolute': args.seconds = numeric(a.seconds, 0, 1e9); break;
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
  function parse(text) {
    if (typeof text !== 'string' || text.length > 200) throw new Error('Command too long');
    const m = /^!ubu(?:\.([a-z0-9_][a-z0-9_.-]{0,99}(?: ?#[1-9][0-9]?)?))?\s+(.+)$/i.exec(text.trim());
    if (!m) throw new Error('Use !ubu pause, mute, zoom 150%, or reset all');
    const [verb, ...words] = m[2].trim().toLowerCase().split(/\s+/);
    let command;
    if (['pause', 'play', 'mute', 'unmute', 'toggle'].includes(verb) && words.length === 0) command = { action: 'media.' + verb };
    else if (verb === 'status' && !words.length) command = { action: 'status.get' };
    else if (verb === 'help' && !words.length) command = { action: 'help.get' };
    else if (verb === 'off' && !words.length) command = { action: 'session.disable' };
    else if (['start', 'end', 'live'].includes(verb) && !words.length) command = { action: 'media.seek.' + (verb === 'start' ? 'start' : 'end') };
    else if (verb === 'seek' && words.length === 1 && /^[+-]?\d+(?:\.\d+)?$/.test(words[0])) command = { action: 'media.seek.relative', args: { seconds: Number(words[0]) } };
    else if (verb === 'zoom' && words.length === 1) {
      const relative = /^[+-](?:\d+(?:\.\d*)?|\.\d+)%$/.test(words[0]);
      command = relative ? { action: 'zoom.adjust', args: { delta: Number(words[0].slice(0, -1)) / 100 } } :
        { action: 'zoom.set', args: { value: factor(words[0]) } };
    } else if (verb === 'volume' && words.length === 1 && /^\d+(?:\.\d+)?%?$/.test(words[0])) command = { action: 'media.volume.set', args: { percent: Number(words[0].replace('%', '')) } };
    else if (verb === 'reset' && words.length === 1 && ['all', 'pan', 'zoom', 'stretch'].includes(words[0])) command = { action: 'reset.' + words[0] };
    else if (verb === 'profile' && words.length === 2 && ['load', 'save'].includes(words[0]) && /^[1-9]$/.test(words[1])) command = { action: 'profile.' + words[0], args: { slot: Number(words[1]) } };
    else throw new Error('Use pause, play, mute, unmute, volume 50, zoom 150%, reset all, profile load 1, status, or off');
    return { target: m[1]?.toLowerCase(), ...validate(command) };
  }
  function snapshot(value) {
    if (!value || typeof value !== 'object') return;
    try {
      const clean = Object.fromEntries(Object.keys(DEFAULT).map(key => [key, value.picture?.[key]]));
      const result = { picture: picture(clean, { action: 'pan.move', args: { x: 0, y: 0 } }) };
      for (const field of ['paused', 'muted', 'seekable']) if (typeof value[field] === 'boolean') result[field] = value[field];
      if (typeof value.volume === 'number') result.volume = numeric(value.volume, 0, 100);
      if (typeof value.position === 'number') result.position = numeric(value.position, 0, 1e9);
      if (typeof value.duration === 'number') result.duration = numeric(value.duration, 0, 1e9);
      result.profileSlots = Array.isArray(value.profileSlots) ? [...new Set(value.profileSlots.filter(n => Number.isInteger(n) && n >= 1 && n <= 9))].slice(0, 9) : [];
      return result;
    } catch { return; }
  }
  function seekTarget(current, ranges, seconds) {
    if (!Number.isFinite(current) || !Number.isFinite(seconds) || !Array.isArray(ranges) || ranges.length > 100) return;
    const wanted = current + seconds;
    let target, distance = Infinity;
    for (const [start, end] of ranges) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) continue;
      const candidate = Math.max(start, Math.min(Math.max(start, end - .01), wanted));
      if (seconds > 0 && candidate <= current || seconds < 0 && candidate >= current) continue;
      if (Math.abs(wanted - candidate) < distance) { target = candidate; distance = Math.abs(wanted - candidate); }
    }
    return target;
  }
  function seekBoundary(ranges, edge) {
    if (!['start', 'end'].includes(edge) || !Array.isArray(ranges) || ranges.length > 100) return;
    const valid = ranges.filter(r => Array.isArray(r) && r.length === 2 && Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] >= 0 && r[1] > r[0]);
    if (!valid.length) return;
    return edge === 'start' ? Math.min(...valid.map(r => r[0])) : Math.max(...valid.map(([start, end]) => Math.max(start, end - .01)));
  }
  const api = { DEFAULT, PAN_MAX, CONTROLS, QUALITIES, qualityId, validQuality, MANAGEMENT, controls, controlFor, controlAllowed, joinEligible,
    validate, picture, parse, factor, snapshot, seekTarget, seekBoundary, senderName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoom = api;
})(globalThis);
