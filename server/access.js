'use strict';

/**
 * The admission gate every part of the server asks: Discord membership when Discord is
 * connected (`connect`), the account's Plex entitlement, and the entry policy.
 * Until Discord connects, the Discord side reports no members.
 * @param {{registry: any, config: any, plexAuth: any, entryPolicy: any}} services
 */
function createAccess({ registry, config, plexAuth, entryPolicy }) {
  /** The live Discord membership view; absent until the bot connects. */
  let live;
  const discordId = id =>
    registry.canonical(id) ? registry.identities(id).find(i => i.provider === 'discord' && i.verified)?.subject : id;
  const access = {
    isMember: id => {
      const discord = discordId(id);
      return !!discord && !!live?.isMember(discord);
    },
    refresh: async id => {
      const discord = discordId(id);
      return !!discord && !!(await live?.refresh(discord));
    },
    voiceChannel: id => {
      const discord = discordId(id);
      return discord && live?.voiceChannel(discord);
    },
    hasRole: (id, role) => {
      const discord = discordId(id);
      return !!discord && live?.hasRole?.(discord, role) === true;
    },
    identity: async id =>
      live?.identity
        ? live.identity(id)
        : (await live?.refresh(id))
          ? { id, name: registry.identity('discord', id)?.name || id }
          : undefined,
    directory: () =>
      live?.directory?.() ||
      Promise.reject(new Error('Discord directory unavailable; check the bot and Server Members Intent')),
    discordOnline: subject => live?.discordOnline?.(subject),
    validVoiceChannel: id => !!live?.validVoiceChannel(id),
    options: () => live?.options() || { available: false },
    canWatch: (id, actor) =>
      config.accessPolicy
        ? entryPolicy.fresh(id, actor)
        : access.isMember(id) || (!!registry.canonical(id) && plexAuth.fresh(id)),
    refreshWatch: async (id, actor) => {
      if (config.accessPolicy) return entryPolicy.admit(id, actor);
      if (access.isMember(id) || (await access.refresh(id))) return true;
      try {
        return !!(await plexAuth.forUser(id));
      } catch {
        return false;
      }
    },
  };
  return Object.assign(access, {
    /** Receives Discord's membership view when the bot connects (or a test's stand-in). */
    connect(raw) {
      live = raw;
    },
    /** The connected Discord membership view, if any. */
    raw: () => live,
  });
}
module.exports = { createAccess };
