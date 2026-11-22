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

function parseIdentity(value, setting) {
  const match = /^(discord|plex|uburoom|jellyfin:[0-9a-f]{32}):(.+)$/.exec(value);
  const valid =
    match &&
    (match[1] === 'discord'
      ? /^\d{17,20}$/.test(match[2])
      : match[1] === 'plex'
        ? /^\d{1,20}$/.test(match[2])
        : match[1].startsWith('jellyfin:')
          ? /^[0-9a-f]{32}$/.test(match[2])
          : /^[A-Za-z0-9._@-]{1,100}$/.test(match[2]));
  if (!valid)
    throw new Error(
      `${setting} entries are quoted 'discord:<id>', 'plex:<id>', 'uburoom:<subject>' or 'jellyfin:<server id>:<user id>' account identities`,
    );
  return { provider: match[1], subject: match[2] };
}

function members(rooms, prefix) {
  const rawIdentities = rooms[prefix + '_identities'];
  let identities = [];
  if (rawIdentities !== undefined && rawIdentities !== null) {
    if (!Array.isArray(rawIdentities) || rawIdentities.some(value => typeof value !== 'string'))
      throw new Error('rooms.' + prefix + '_identities must be a YAML list of quoted account identities');
    identities = rawIdentities.map(value => parseIdentity(value, 'rooms.' + prefix + '_identities'));
  }
  return {
    discord: identifiers(rooms[prefix + '_discord_ids'], /^\d{17,20}$/, 'rooms.' + prefix + '_discord_ids'),
    plex: identifiers(rooms[prefix + '_plex_ids'], /^\d{1,20}$/, 'rooms.' + prefix + '_plex_ids'),
    discordRoles: identifiers(
      rooms[prefix + '_discord_role_ids'],
      /^\d{17,20}$/,
      'rooms.' + prefix + '_discord_role_ids',
    ),
    identities,
  };
}

// True when a verified identity on the account is listed, directly or through a
// current Discord guild role.
function listed(identities, list, access) {
  if (
    identities.some(
      identity =>
        (identity.provider === 'discord' && list.discord.includes(identity.subject)) ||
        (identity.provider === 'plex' && list.plex.includes(identity.subject)) ||
        list.identities?.some(entry => entry.provider === identity.provider && entry.subject === identity.subject),
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

const NONE = Object.freeze({ discord: [], plex: [], discordRoles: [], identities: [] });
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
