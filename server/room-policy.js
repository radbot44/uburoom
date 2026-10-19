// @ts-check
'use strict';

// These are room capabilities, independent of remote consent and Plex access.
const CAPABILITIES = Object.freeze([
  'playPause', 'seek', 'chooseMedia', 'addQueue', 'editQueue', 'autoplay',
  'picture', 'roomSettings', 'closeRoom', 'deleteRoom', 'continueWithoutHost'
]);
const CREATOR_ONLY = Object.freeze(['manageHosts', 'transferCreator', 'managePermissions']);
const DEFAULTS = Object.freeze({
  host: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, key !== 'deleteRoom']))),
  viewer: Object.freeze(Object.fromEntries(CAPABILITIES.map(key => [key, key === 'playPause'])))
});

function permissions(value, base) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !CAPABILITIES.includes(key) || typeof value[key] !== 'boolean')) {
    throw new Error('Invalid room permissions');
  }
  return Object.fromEntries(CAPABILITIES.map(key => [key, value[key] ?? base[key]]));
}

function policy(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['host', 'viewer'].includes(key))) {
    throw new Error('Invalid room permission roles');
  }
  return { host: permissions(value.host ?? {}, DEFAULTS.host), viewer: permissions(value.viewer ?? {}, DEFAULTS.viewer) };
}

/** @param {{creatorId:string,hosts:string[]}} room @param {string} userId */
function role(room, userId) {
  return userId === room.creatorId ? 'creator' : room.hosts.includes(userId) ? 'host' : 'viewer';
}

function allowed(room, userId, capability) {
  if (![...CAPABILITIES, ...CREATOR_ONLY].includes(capability)) return false;
  const level = role(room, userId);
  if (level === 'creator') return true;
  return CAPABILITIES.includes(capability) && (room.permissions[level][capability] === true ||
    level === 'host' && room.permissions.viewer[capability] === true);
}

function commandCapability(action) {
  if (action.startsWith('media.autoplay.')) return 'autoplay';
  if (['queue.add','queue.bulk'].includes(action)) return 'addQueue';
  if (['queue.playNow','queue.history.replay'].includes(action)) return 'chooseMedia';
  if (action.startsWith('queue.')) return 'editQueue';
  if (['media.play', 'media.pause', 'media.toggle'].includes(action)) return 'playPause';
  if (action.startsWith('media.seek.')) return 'seek';
  if (['media.load', 'media.next', 'media.previous'].includes(action) || action.startsWith('media.ready.')) return 'chooseMedia';
  if (action.startsWith('room.')) return 'roomSettings';
  if (/^(zoom|stretch|pan|reset|profile)\./.test(action)) return 'picture';
}

function permissionList(value, base) {
  if (value === undefined || value.trim() === '') return { ...base };
  const names = value.split(',').map(name => name.trim());
  if (names.length === 1 && ['all', 'none'].includes(names[0])) {
    return Object.fromEntries(CAPABILITIES.map(key => [key, names[0] === 'all']));
  }
  if (names.some(name => !CAPABILITIES.includes(name))) throw new Error('Unknown capability in room permission defaults');
  return Object.fromEntries(CAPABILITIES.map(key => [key, names.includes(key)]));
}

function identifiers(value, pattern, setting) {
  if (value === undefined || value.trim() === '') return [];
  const ids = [...new Set(value.split(',').map(id => id.trim()))];
  if (ids.some(id => !pattern.test(id))) throw new Error(setting + ' requires exact account or role IDs');
  return ids;
}

function configuration(env) {
  return {
    roomPermissions: {
      host: permissionList(env.ROOM_HOST_PERMISSIONS, DEFAULTS.host),
      viewer: permissionList(env.ROOM_VIEWER_PERMISSIONS, DEFAULTS.viewer)
    },
    roomAdministrators: {
      discord: identifiers(env.ROOM_ADMIN_DISCORD_IDS, /^\d{17,20}$/, 'ROOM_ADMIN_DISCORD_IDS'),
      plex: identifiers(env.ROOM_ADMIN_PLEX_IDS, /^\d{1,20}$/, 'ROOM_ADMIN_PLEX_IDS'),
      discordRoles: identifiers(env.ROOM_ADMIN_DISCORD_ROLE_IDS, /^\d{17,20}$/, 'ROOM_ADMIN_DISCORD_ROLE_IDS')
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

module.exports = { CAPABILITIES, CREATOR_ONLY, DEFAULTS, permissions, policy, role, allowed, commandCapability, configuration, administrator };
