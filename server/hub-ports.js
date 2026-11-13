'use strict';
const RoomPolicy = require('./room-policy');
const { UserDirectory } = require('./user-directory');
const { plexDirectory } = require('./plex-directory');

/**
 * What the hub calls out to, built from the services it needs. `hub` and `rooms` are read
 * when a port is called, because the hub and the rooms are built from these ports.
 * @param {{config: any, logger: any, registry: any, accounts: any, access: any, plexAuth: any, entryPolicy: any,
 *   guests: any, sessions: any, discord: {client: any}, hub: () => any, rooms: () => any}} services
 */
function createHubPorts({
  config,
  logger,
  registry,
  accounts,
  access,
  plexAuth,
  entryPolicy,
  guests,
  sessions,
  discord,
  hub,
  rooms,
}) {
  const { logins, discordIdentity } = sessions;
  let singleLeader;
  /** Shows the installation owner's Discord name on their room. */
  const setOwnerName = name => {
    const owner = registry.identity('discord', config.ownerId);
    if (owner?.verified) name = registry.canonical(owner.userId)?.name || name;
    if (typeof name !== 'string' || !name || name === accounts.ownerName) return;
    accounts.ownerName = name.slice(0, 100);
    accounts.save();
  };
  const directory = new UserDirectory({
    registry,
    config,
    discord: () => access.directory(),
    discordOnline: subject => access.discordOnline(subject),
    plex: () => plexDirectory(plexAuth),
  });
  const ports = {
    logger,
    access,
    directory,
    discord,
    singleRoomLeader: async () => {
      if (!singleLeader) {
        singleLeader = (async () => {
          if (config.singleRoomLeaderPlexId)
            return registry.resolve('plex', config.singleRoomLeaderPlexId, 'Assigned account', false);
          if (config.accessPolicy?.discord !== false || !config.accessPolicy?.plex)
            return registry.resolve('discord', config.ownerId, 'Assigned account', false);
          let profile;
          try {
            profile = await plexAuth.request('/user', { token: config.plexToken });
          } catch {
            throw new Error(
              'Cannot identify the single-room leader from plex.token; check the token or set rooms.single_room_leader_plex_id',
            );
          }
          if (!/^\d{1,20}$/.test(String(profile?.id || '')))
            throw new Error('Plex did not identify the token account; set rooms.single_room_leader_plex_id');
          return registry.resolve('plex', String(profile.id), 'Assigned account', false);
        })();
        singleLeader.catch(() => {
          singleLeader = undefined;
        });
      }
      return singleLeader.then(account => registry.canonical(account.id));
    },
    adminEligible: actor => RoomPolicy.administrator(registry, config, actor.userId, access.raw()),
    refreshAdmin: async actor => {
      // Trusted roles decide who may turn on guests and who may schedule events.
      const roles = [
        ...(config.roomAdministrators?.discordRoles || []),
        ...(config.trustedMembers?.discordRoles || []),
      ];
      const discordId = registry
        .identities(actor.userId)
        .find(identity => identity.provider === 'discord' && identity.verified)?.subject;
      if (roles.length && discordId && !access.raw()?.isMember(discordId)) {
        try {
          await access.raw()?.refresh(discordId);
        } catch {
          /* Missing live guild authority fails closed below. */
        }
      }
      if (!hub().canAdmin(actor)) hub().clearAdmin(actor);
    },
    guestsEnabled: guests.enabled,
    guestMembers: guests.members,
    endGuestSessions: guests.endSessions,
    // Turning guests on needs the configured server tier and hosting this room
    // (Admin mode always counts). Guests themselves never can.
    canAllowGuests: (record, actor) =>
      guests.enabled() &&
      !actor.guestRoomId &&
      !registry.isGuest(actor.userId) &&
      !record.guests?.includes(actor.userId) &&
      RoomPolicy.tierAtLeast(
        RoomPolicy.serverTier(registry, config, actor.userId, access.raw()),
        config.guests.issuers,
      ) &&
      (hub().isAdmin(actor) || RoomPolicy.role(record, actor.userId) !== 'viewer'),
    // Scheduling watch nights needs the configured server tier; guests never can.
    canScheduleEvents: actor =>
      !actor.guestRoomId &&
      !registry.isGuest(actor.userId) &&
      RoomPolicy.tierAtLeast(
        RoomPolicy.serverTier(registry, config, actor.userId, access.raw()),
        config.events?.schedulers || 'trusted',
      ),
    accountActor: actor =>
      registry.canonical(actor.userId)
        ? { ...actor, name: registry.canonical(actor.userId).name }
        : {
            ...actor,
            ...discordIdentity({ userId: actor.userId, name: actor.name || 'Discord user' }),
            discordId: actor.userId,
          },
    plexFor: async actor => {
      const identity = registry.identities(actor.userId).find(i => i.provider === 'plex' && i.verified);
      const fallback = () => {
        if (config.plexFallback?.enabled === false)
          throw new Error('Connect a Plex account with access to this server; shared fallback is disabled');
        return plexAuth.fallback();
      };
      if (!identity) return fallback();
      if (!registry.hasCredential(identity.subject)) throw new Error('Connect your Plex account again');
      try {
        const scoped = await plexAuth.forUser(actor.userId);
        if (!scoped) throw new Error('Connect your Plex account again');
        return scoped;
      } catch (error) {
        // Only a confirmed lack of server membership may use explicit open-entry
        // sponsorship. Expiry, network errors and item restrictions never do.
        if (config.accessPolicy && !entryPolicy.requiresPlex(actor) && error.noServerAccess) return fallback();
        throw error;
      }
    },
    renameAccount: async (id, name) => {
      const account = registry.rename(id, name);
      await registry.flush();
      if (
        registry.identities(id).some(identity => identity.provider === 'discord' && identity.subject === config.ownerId)
      )
        setOwnerName(account.name);
      for (const login of logins.values()) if (login.userId === id) login.name = account.name;
      rooms().renamed(id, account.name);
      return account;
    },
  };
  return { ports, setOwnerName };
}
module.exports = { createHubPorts };
