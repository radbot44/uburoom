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
  admitted,
  allowed,
  commandCapability,
  canKickParticipant,
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
      viewer: permissionList(rooms.viewer_permissions, DEFAULTS.viewer),
    }),
    roomAdministrators: members(rooms, 'admin'),
    trustedMembers: members(rooms, 'trusted'),
  };
}

function members(rooms, prefix) {
  return {
    discord: identifiers(rooms[prefix + '_discord_ids'], /^\d{17,20}$/, 'rooms.' + prefix + '_discord_ids'),
    plex: identifiers(rooms[prefix + '_plex_ids'], /^\d{1,20}$/, 'rooms.' + prefix + '_plex_ids'),
    discordRoles: identifiers(
      rooms[prefix + '_discord_role_ids'],
      /^\d{17,20}$/,
      'rooms.' + prefix + '_discord_role_ids',
    ),
  };
}

// True when a verified identity on the account is listed, directly or through a
// current Discord guild role.
function listed(identities, list, access) {
  if (
    identities.some(
      identity =>
        (identity.provider === 'discord' && list.discord.includes(identity.subject)) ||
        (identity.provider === 'plex' && list.plex.includes(identity.subject)),
    )
  )
    return true;
  return identities.some(
    identity =>
      identity.provider === 'discord' &&
      access?.isMember(identity.subject) === true &&
      list.discordRoles.some(id => access.hasRole?.(identity.subject, id) === true),
  );
}

const NONE = Object.freeze({ discord: [], plex: [], discordRoles: [] });
const TIERS = Object.freeze(['members', 'trusted', 'admins', 'operator']);

// Provider identities and role membership must come from the server registry and
// current guild access, never actor fields supplied in a command body.
/** @param {InstanceType<typeof import('./accounts').Accounts>} registry */
function administrator(registry, config, userId, access) {
  const account = registry.canonical(userId);
  if (!account) return false;
  const identities = registry.identities(account.id).filter(identity => identity.verified);
  if (identities.some(identity => identity.provider === 'discord' && identity.subject === config.ownerId)) return true;
  return listed(identities, config.roomAdministrators || NONE, access);
}

// Server-wide standing: operator > admins > trusted > members. Admins include the
// Discord owner. Unverified guests have no verified identities, so they are
// members at most; callers decide whether guests may act at all.
/** @param {InstanceType<typeof import('./accounts').Accounts>} registry @returns {'operator'|'admins'|'trusted'|'members'} */
function serverTier(registry, config, userId, access) {
  const account = registry.canonical(userId);
  if (!account) return 'members';
  if (require('./operator-policy').isServerOperator(registry, config, account.id)) return 'operator';
  if (administrator(registry, config, account.id, access)) return 'admins';
  const identities = registry.identities(account.id).filter(identity => identity.verified);
  return listed(identities, config.trustedMembers || NONE, access) ? 'trusted' : 'members';
}

function tierAtLeast(tier, minimum) {
  return TIERS.includes(minimum) && TIERS.indexOf(tier) >= TIERS.indexOf(minimum);
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
  admitted,
  allowed,
  commandCapability,
  canKickParticipant,
  configuration,
  administrator,
  serverTier,
  tierAtLeast,
  TIERS,
};
