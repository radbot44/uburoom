// @ts-check
'use strict';

// These are room capabilities, independent of Plex access.
const CAPABILITIES = Object.freeze([
  'playPause', 'seek', 'chooseMedia', 'addQueue', 'editQueue', 'autoplay',
  'roomSettings', 'closeRoom', 'deleteRoom', 'continueWithoutHost', 'addHosts', 'kickParticipants'
]);
const VIEWER_BLOCKED = Object.freeze(['roomSettings', 'closeRoom', 'deleteRoom', 'addHosts', 'kickParticipants']);
const CREATOR_ONLY = Object.freeze(['manageHosts', 'transferCreator', 'managePermissions']);
const DEFAULTS = Object.freeze({
  host: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, !['deleteRoom','addHosts'].includes(key)]))),
  viewer: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, key === 'playPause'])))
});

// Presets define editable controls; participant room management is always locked off.
function preset(name) {
  if (!['host-control', 'play-pause', 'queue'].includes(name)) throw new Error('Unknown room permission preset');
  return {
    host: { ...DEFAULTS.host },
    viewer: Object.fromEntries(CAPABILITIES.map(key => [key,
      name === 'play-pause' && key === 'playPause' || name === 'queue' && ['playPause', 'seek', 'chooseMedia', 'addQueue', 'editQueue', 'autoplay'].includes(key)])),
    allHosts:false
  };
}

function permissions(value, base, { role, stored = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !(CAPABILITIES.includes(key) || stored && key === 'picture') || typeof value[key] !== 'boolean')) {
    throw new Error('Invalid room permissions');
  }
  if (!stored && role === 'viewer' && VIEWER_BLOCKED.some(key => value[key] === true)) {
    throw new Error('Room management permissions are unavailable to participants');
  }
  return Object.fromEntries(CAPABILITIES.map(key => [key, role === 'viewer' && VIEWER_BLOCKED.includes(key) ? false : value[key] ?? base[key]]));
}

function policy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'viewer', 'allHosts'].includes(key)) || value.allHosts !== undefined && typeof value.allHosts !== 'boolean') {
    throw new Error('Invalid room permission roles');
  }
  // Old saved policies may contain the retired picture flag; it no longer grants authority.
  return { host: permissions(value.host ?? {}, DEFAULTS.host, { stored:true }), viewer: permissions(value.viewer ?? {}, DEFAULTS.viewer, { role:'viewer', stored:true }), allHosts:value.allHosts ?? false };
}

/** @param {{creatorId:string,hosts:string[]}} room @param {string} userId */
function role(room, userId) {
  return userId === room.creatorId ? 'creator' : room.hosts.includes(userId) || room.permissions?.allHosts ? 'host' : 'viewer';
}

// Mode changes permissions, never private-room membership or saved-room discovery.
function assigned(room, userId) { return userId === room.creatorId || room.hosts.includes(userId); }

function allowed(room, userId, capability) {
  const level = role(room, userId);
  // Picture controls retain fixed host authority while their editable permission is retired.
  if (capability === 'picture') return level === 'creator' || level === 'host';
  if (![...CAPABILITIES, ...CREATOR_ONLY].includes(capability)) return false;
  if (level === 'viewer' && VIEWER_BLOCKED.includes(capability)) return false;
  if (level === 'creator') return true;
  return CAPABILITIES.includes(capability) && (room.permissions[level][capability] === true ||
    level === 'host' && !VIEWER_BLOCKED.includes(capability) && room.permissions.viewer[capability] === true);
}

function commandCapability(action) {
  if (action === 'room.kick') return 'kickParticipants';
  if (action.startsWith('media.autoplay.')) return 'autoplay';
  if (['queue.add','queue.bulk','queue.offer.start','queue.auto.pin'].includes(action)) return 'addQueue';
  if (['queue.playNow','queue.playEntry','queue.skipTo','queue.history.replay','queue.history.goBack','queue.auto.playNow'].includes(action)) return 'chooseMedia';
  if (action.startsWith('queue.')) return 'editQueue';
  if (['media.play', 'media.pause', 'media.toggle'].includes(action)) return 'playPause';
  if (action.startsWith('media.seek.')) return 'seek';
  if (['media.load', 'media.next', 'media.previous'].includes(action) || action.startsWith('media.ready.')) return 'chooseMedia';
  if (action.startsWith('room.')) return 'roomSettings';
  if (/^(zoom|stretch|pan|reset|profile)\./.test(action)) return 'picture';
}

function permissionList(value, base) {
  if (value === undefined) return { ...base };
  if (['all', 'none'].includes(value)) return Object.fromEntries(CAPABILITIES.map(key => [key, value === 'all']));
  if (!Array.isArray(value) || value.some(name => !CAPABILITIES.includes(name) && name !== 'picture')) throw new Error('Unknown capability in room permission defaults');
  return Object.fromEntries(CAPABILITIES.map(key => [key, value.includes(key)]));
}

function identifiers(value, pattern, setting) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !pattern.test(id))) throw new Error(setting + ' requires exact account or role IDs');
  return [...new Set(value)];
}

function configuration(rooms) {
  return {
    roomPermissions: policy({
      host: permissionList(rooms.host_permissions, DEFAULTS.host),
      viewer: permissionList(rooms.viewer_permissions, DEFAULTS.viewer)
    }),
    roomAdministrators: {
      discord: identifiers(rooms.admin_discord_ids, /^\d{17,20}$/, 'rooms.admin_discord_ids'),
      plex: identifiers(rooms.admin_plex_ids, /^\d{1,20}$/, 'rooms.admin_plex_ids'),
      discordRoles: identifiers(rooms.admin_discord_role_ids, /^\d{17,20}$/, 'rooms.admin_discord_role_ids')
    }
  };
}

// Provider identities and role membership must come from the server registry and
// current guild access, never actor fields supplied in a command body.
/** @param {import('./accounts').Accounts} registry */
function administrator(registry, config, userId, access) {
  const account = registry.canonical(userId);
  if (!account) return false;
  const identities = registry.identities(account.id).filter(identity => identity.verified);
  const configured = config.roomAdministrators || { discord: [], plex: [], discordRoles: [] };
  if (identities.some(identity => identity.provider === 'discord' &&
      (identity.subject === config.ownerId || configured.discord.includes(identity.subject)) ||
      identity.provider === 'plex' && configured.plex.includes(identity.subject))) return true;
  return identities.some(identity => identity.provider === 'discord' &&
    access?.isMember(identity.subject) === true && configured.discordRoles.some(id => access.hasRole?.(identity.subject, id) === true));
}

module.exports = { preset, CAPABILITIES, VIEWER_BLOCKED, CREATOR_ONLY, DEFAULTS, permissions, policy, role, assigned, allowed, commandCapability, configuration, administrator };
