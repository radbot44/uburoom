// @ts-check
'use strict';

// Generic room roles and capabilities come from shared/sync; self-hosted YAML
// configuration and Discord/Plex administrator resolution stay here.
const SyncPolicy = require('../shared/sync/policy.mjs');
const {
  preset,
  CAPABILITIES,
  VIEWER_BLOCKED,
  CREATOR_ONLY,
  DEFAULTS,
  permissions,
  policy,
  permissionList,
  role,
  assigned,
  allowed,
  commandCapability,
  canKickParticipant
} = SyncPolicy;

function identifiers(value, pattern, setting) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !pattern.test(id))) {
    throw new Error(setting + ' requires exact account or role IDs');
  }
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

module.exports = {
  preset,
  CAPABILITIES,
  VIEWER_BLOCKED,
  CREATOR_ONLY,
  DEFAULTS,
  permissions,
  policy,
  role,
  assigned,
  allowed,
  commandCapability,
  canKickParticipant,
  configuration,
  administrator
};
