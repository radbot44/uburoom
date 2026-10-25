/* Shared command dispatch and player snapshots for browser clients and Node. */
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
  const NO_PAN = Object.freeze({ action: 'pan.move', args: { x: 0, y: 0 } });
  function snapshot(value) {
    if (!value || typeof value !== 'object') return;
    try {
      // Bolt Optimization: Directly extract picture properties and filter profile slots with a fast loop
      // to eliminate allocations from Object.keys, Object.fromEntries, map, filter, and Set.
      const pic = value.picture;
      const clean = { zoom: pic?.zoom, stretchX: pic?.stretchX, stretchY: pic?.stretchY, x: pic?.x, y: pic?.y };
      const result = { picture: picture(clean, NO_PAN) };
      for (const field of ['paused', 'muted', 'seekable', 'waitingForReady']) if (typeof value[field] === 'boolean') result[field] = value[field];
      if (typeof value.volume === 'number') result.volume = numeric(value.volume, 0, 100);
      if (typeof value.position === 'number') result.position = numeric(value.position, 0, 1e9);
      if (typeof value.duration === 'number') result.duration = numeric(value.duration, 0, 1e9);
      if (Array.isArray(value.profileSlots)) {
        const slots = [];
        for (let i = 0; i < value.profileSlots.length; i++) {
          const n = value.profileSlots[i];
          if (Number.isInteger(n) && n >= 1 && n <= 9 && !slots.includes(n)) {
            slots.push(n);
            if (slots.length === 9) break;
          }
        }
        result.profileSlots = slots;
      } else {
        result.profileSlots = [];
      }
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
    validate, picture, factor, snapshot, seekTarget, seekBoundary, senderName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.uburoom = api;
})(globalThis);
