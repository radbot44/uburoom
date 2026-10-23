/* Shared command dispatch, text parsing and player snapshots for browser clients and Node. */
(function (root) {
  'use strict';
  const Room = typeof module !== 'undefined' && module.exports ? require('./room-protocol') : root.uburoomRoomProtocol;
  const Picture = typeof module !== 'undefined' && module.exports ? require('./picture') : root.uburoomPicture;
  const { DEFAULT, PAN_MAX, picture, factor } = Picture;
  const { CONTROLS, QUALITIES, qualityId, validQuality, MANAGEMENT, controls, controlFor, controlAllowed, senderName } = Room;
  function validate(command) {
    return Picture.isCommand(command?.action) ? Picture.validate(command) : Room.validate(command);
  }
  const numeric = (n, min, max) => {
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw new Error('Value outside supported range');
    return n;
  };
  function parse(text) {
    if (typeof text !== 'string' || text.length > 200) throw new Error('Command too long');
    const m = /^!ubu(?:\.([a-z0-9_][a-z0-9_.-]{0,99}(?: ?#[1-9][0-9]?)?))?\s+(.+)$/i.exec(text.trim());
    if (!m) throw new Error('Use !ubu pause, mute, zoom 150%, or reset all');
    const [verb, ...words] = m[2].trim().toLowerCase().split(/\s+/);
    let command;
    if (['pause', 'play', 'mute', 'unmute', 'toggle'].includes(verb) && words.length === 0) command = { action: 'media.' + verb };
    else if (verb === 'status' && !words.length) command = { action: 'status.get' };
    else if (verb === 'help' && !words.length) command = { action: 'help.get' };
    else if (['start', 'end', 'live'].includes(verb) && !words.length) command = { action: 'media.seek.' + (verb === 'start' ? 'start' : 'end') };
    else if (verb === 'seek' && words.length === 1 && /^[+-]?\d+(?:\.\d+)?$/.test(words[0])) command = { action: 'media.seek.relative', args: { seconds: Number(words[0]) } };
    else if (verb === 'zoom' && words.length === 1) {
      const relative = /^[+-](?:\d+(?:\.\d*)?|\.\d+)%$/.test(words[0]);
      command = relative ? { action: 'zoom.adjust', args: { delta: Number(words[0].slice(0, -1)) / 100 } } :
        { action: 'zoom.set', args: { value: factor(words[0]) } };
    } else if (verb === 'volume' && words.length === 1 && /^\d+(?:\.\d+)?%?$/.test(words[0])) command = { action: 'media.volume.set', args: { percent: Number(words[0].replace('%', '')) } };
    else if (verb === 'reset' && words.length === 1 && ['all', 'pan', 'zoom', 'stretch'].includes(words[0])) command = { action: 'reset.' + words[0] };
    else if (verb === 'profile' && words.length === 2 && ['load', 'save'].includes(words[0]) && /^[1-9]$/.test(words[1])) command = { action: 'profile.' + words[0], args: { slot: Number(words[1]) } };
    else throw new Error('Use pause, play, mute, unmute, volume 50, zoom 150%, reset all, profile load 1, or status');
    return { target: m[1]?.toLowerCase(), ...validate(command) };
  }
  function snapshot(value) {
    if (!value || typeof value !== 'object') return;
    try {
      const clean = Object.fromEntries(Object.keys(DEFAULT).map(key => [key, value.picture?.[key]]));
      const result = { picture: picture(clean, { action: 'pan.move', args: { x: 0, y: 0 } }) };
      for (const field of ['paused', 'muted', 'seekable', 'waitingForReady']) if (typeof value[field] === 'boolean') result[field] = value[field];
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
  const api = { DEFAULT, PAN_MAX, CONTROLS, QUALITIES, qualityId, validQuality, MANAGEMENT, controls, controlFor, controlAllowed,
    validate, picture, parse, factor, snapshot, seekTarget, seekBoundary, senderName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoom = api;
})(globalThis);
