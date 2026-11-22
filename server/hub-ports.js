'use strict';
const { displayName } = require('./accounts');
const RoomPolicy = require('./room-policy');
const { UserDirectory } = require('./user-directory');

/**
 * What the hub calls out to, built from the services it needs. `hub` and `rooms` are read
 * when a port is called, because the hub and the rooms are built from these ports.
 * @param {{config: any, logger: any, registry: any, accounts: any, access: any, plexAuth: any, providers: any,
 *   guests: any, sessions: any, discord: {client: any}, onlineUsers?: () => string[],
 *   hub: () => any, rooms: () => any}} services
 */
function createHubPorts({
  config,
  logger,
  registry,
  accounts,
  access,
  plexAuth,
  providers,
  guests,
  sessions,
  discord,
  onlineUsers,
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
    onlineUsers,
  });
  const ports = {
    logger,
    access,
    directory,
    discord,
    singleRoomLeader: async () => {
      if (!singleLeader) {
        singleLeader = (async () => {
          if (config.singleRoomLeader)
            return registry.resolve(
              config.singleRoomLeader.provider,
              config.singleRoomLeader.subject,
              'Assigned account',
              false,
            );
          const operators = config.serverOperator?.identities || [];
          const verifiedOp = operators.find(op => registry.identity(op.provider, op.subject)?.verified);
          if (verifiedOp) return registry.resolve(verifiedOp.provider, verifiedOp.subject, 'Assigned account', false);
          if (config.singleRoomLeaderPlexId)
            return registry.resolve('plex', config.singleRoomLeaderPlexId, 'Assigned account', false);
          if (operators.length && !config.ownerId)
            return registry.resolve(operators[0].provider, operators[0].subject, 'Assigned account', false);
          if (config.accessPolicy?.discord !== false || !config.accessPolicy?.plex)
            return registry.resolve('discord', config.ownerId, 'Assigned account', false);
          let profile;
          try {
            profile = await plexAuth.ownerProfile();
          } catch {
            throw new Error(
              "Cannot identify the single-room leader from the first Plex source's token; check it or set rooms.single_room_leader",
            );
          }
          if (!/^\d{1,20}$/.test(String(profile?.id || '')))
            throw new Error('Plex did not identify the token account; set rooms.single_room_leader');
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
    mediaFor: (actor, serverId) => providers.for(actor, serverId),
    renameAccount: async (id, name) => {
      let nextName;
      try {
        nextName = displayName(name);
      } catch (error) {
        throw Object.assign(new Error(error.message), { status: 400 });
      }
      if (registry.isGuest(id)) {
        const lower = nextName.toLocaleLowerCase();
        const openRooms = [...(rooms()?.rooms?.values() || [])];
        const activeRooms = openRooms.filter(
          room => room.viewers.has(id) || [...room.viewers.values()].some(v => v.userId === id),
        );
        const scoped = activeRooms.length ? activeRooms : openRooms;
        if (
          scoped.some(room =>
            [...room.viewers.values()].some(
              viewer => !registry.isGuest(viewer.userId) && viewer.name?.toLocaleLowerCase() === lower,
            ),
          )
        )
          throw Object.assign(new Error('Someone in this room already uses that name. Choose another.'), {
            status: 409,
          });
      }
      const account = registry.rename(id, nextName);
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
