// @ts-check
/* Generic multi-tenant room roles, permission presets, and capability checks.
 * Independent of Plex media access, Discord guilds, or global single-owner state.
 */

export const CAPABILITIES = Object.freeze([
  'playPause', 'seek', 'chooseMedia', 'addQueue', 'editQueue', 'autoplay',
  'roomSettings', 'closeRoom', 'deleteRoom', 'continueWithoutHost', 'addHosts', 'kickParticipants'
]);

export const VIEWER_BLOCKED = Object.freeze([
  'roomSettings', 'closeRoom', 'deleteRoom', 'addHosts', 'kickParticipants'
]);

export const CREATOR_ONLY = Object.freeze([
  'manageHosts', 'transferCreator', 'managePermissions'
]);

export const DEFAULTS = Object.freeze({
  host: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, !['deleteRoom', 'addHosts'].includes(key)]))),
  viewer: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, key === 'playPause'])))
});

// Presets define editable controls; participant room management is always locked off.
export function preset(name) {
  if (!['host-control', 'play-pause', 'queue'].includes(name)) throw new Error('Unknown room permission preset');
  return {
    host: { ...DEFAULTS.host },
    viewer: Object.fromEntries(CAPABILITIES.map(key => [key,
      name === 'play-pause' && key === 'playPause' ||
      name === 'queue' && ['playPause', 'seek', 'chooseMedia', 'addQueue', 'editQueue', 'autoplay'].includes(key)])),
    allHosts: false
  };
}

export function permissions(value, base, { role: targetRole, stored = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !(CAPABILITIES.includes(key) || stored && key === 'picture') || typeof value[key] !== 'boolean')) {
    throw new Error('Invalid room permissions');
  }
  if (!stored && targetRole === 'viewer' && VIEWER_BLOCKED.some(key => value[key] === true)) {
    throw new Error('Room management permissions are unavailable to participants');
  }
  return Object.fromEntries(CAPABILITIES.map(key => [
    key,
    targetRole === 'viewer' && VIEWER_BLOCKED.includes(key) ? false : value[key] ?? base[key]
  ]));
}

export function policy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['host', 'viewer', 'allHosts'].includes(key)) ||
      value.allHosts !== undefined && typeof value.allHosts !== 'boolean') {
    throw new Error('Invalid room permission roles');
  }
  // Old saved policies may contain the retired picture flag; it no longer grants authority.
  return {
    host: permissions(value.host ?? {}, DEFAULTS.host, { stored: true }),
    viewer: permissions(value.viewer ?? {}, DEFAULTS.viewer, { role: 'viewer', stored: true }),
    allHosts: value.allHosts ?? false
  };
}

export function permissionList(value, base) {
  if (value === undefined) return { ...base };
  if (['all', 'none'].includes(value)) return Object.fromEntries(CAPABILITIES.map(key => [key, value === 'all']));
  if (!Array.isArray(value) || value.some(name => !CAPABILITIES.includes(name) && name !== 'picture')) {
    throw new Error('Unknown capability in room permission defaults');
  }
  return Object.fromEntries(CAPABILITIES.map(key => [key, value.includes(key)]));
}

/** @param {{creatorId?:string, hosts?:string[], permissions?:{allHosts?:boolean}}} room @param {string} userId */
export function role(room, userId) {
  const hosts = room.hosts || [];
  return userId === room.creatorId ? 'creator' : hosts.includes(userId) || room.permissions?.allHosts ? 'host' : 'viewer';
}

// Mode changes permissions, never private-room membership or saved-room discovery.
/** @param {{creatorId?:string, hosts?:string[]}} room @param {string} userId */
export function assigned(room, userId) {
  return userId === room.creatorId || (room.hosts || []).includes(userId);
}

/**
 * Evaluate whether `userId` holds `capability` in `room`.
 * Optional `isAdmin` allows host applications (self-hosted or multi-tenant) to inject
 * verified tenant/operator administration without global single-owner assumptions.
 */
export function allowed(room, userId, capability, { isAdmin = false } = {}) {
  if (isAdmin) return [...CAPABILITIES, ...CREATOR_ONLY, 'picture'].includes(capability);
  const level = role(room, userId);
  // Picture controls retain fixed host authority while their editable permission is retired.
  if (capability === 'picture') return level === 'creator' || level === 'host';
  if (![...CAPABILITIES, ...CREATOR_ONLY].includes(capability)) return false;
  if (level === 'viewer' && VIEWER_BLOCKED.includes(capability)) return false;
  if (level === 'creator') return true;
  return CAPABILITIES.includes(capability) && (
    room.permissions[level][capability] === true ||
    level === 'host' && !VIEWER_BLOCKED.includes(capability) && room.permissions.viewer[capability] === true
  );
}

export function commandCapability(action) {
  if (action === 'room.kick') return 'kickParticipants';
  if (action.startsWith('media.autoplay.')) return 'autoplay';
  if (['queue.add', 'queue.bulk', 'queue.offer.start', 'queue.auto.pin'].includes(action)) return 'addQueue';
  if (['queue.playNow', 'queue.playEntry', 'queue.skipTo', 'queue.history.replay', 'queue.history.goBack', 'queue.auto.playNow'].includes(action)) return 'chooseMedia';
  if (action.startsWith('queue.')) return 'editQueue';
  if (['media.play', 'media.pause', 'media.toggle'].includes(action)) return 'playPause';
  if (action.startsWith('media.seek.')) return 'seek';
  if (['media.load', 'media.next', 'media.previous'].includes(action) || action.startsWith('media.ready.')) return 'chooseMedia';
  if (action.startsWith('room.')) return 'roomSettings';
  if (/^(zoom|stretch|pan|reset|profile)\./.test(action)) return 'picture';
  return undefined;
}

/**
 * Enforce participant-kick hierarchy:
 * - Requires `kickParticipants` capability (or injected `isAdmin`)
 * - Cannot kick oneself or the room creator
 * - Hosts cannot kick other hosts unless they are the room creator or an administrator
 */
export function canKickParticipant(room, actorId, targetUserId, { isAdmin = false } = {}) {
  if (!actorId || !targetUserId || actorId === targetUserId || targetUserId === room.creatorId) return false;
  if (!allowed(room, actorId, 'kickParticipants', { isAdmin })) return false;
  if (role(room, targetUserId) === 'host' && actorId !== room.creatorId && !isAdmin) return false;
  return true;
}
