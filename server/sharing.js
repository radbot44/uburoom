'use strict';
const { Events, Status, GatewayIntentBits } = require('discord.js');
const { COMMAND_MS } = require('./core');
const { CircuitBreaker } = require('./resilience');

// Gateway voice state is authoritative only while this guild's shard is ready.
// Guild membership is fetched afresh for each friend command and acknowledgement.
function discordAccess(client, excludedGuildIds = [], log) {
  const members = new Map(),
    inflight = new Map(),
    circuits = new Map(),
    excluded = new Set(excludedGuildIds);
  let generation = 0;
  const joined = () => [...client.guilds.cache.entries()];
  const eligible = () => joined().filter(([id]) => !excluded.has(id));
  const ready = g => client.isReady() && g?.available && g.shard?.status === Status.Ready;
  const guilds = () => eligible().filter(([, guild]) => ready(guild));
  const invalidate = () => {
    generation++;
    members.clear();
    inflight.clear();
  };
  client.on(Events.ShardDisconnect, invalidate);
  client.on(Events.ShardReconnecting, invalidate);
  client.on(Events.GuildUnavailable, invalidate);
  client.on(Events.GuildCreate, invalidate);
  client.on(Events.GuildDelete, guild => {
    circuits.delete(guild.id);
    invalidate();
  });
  // A role set is a positive answer, null is a denial, and undefined is unavailable.
  async function checkMember(id, guild, userId) {
    if (!ready(guild)) return undefined;
    if (!circuits.has(id)) circuits.set(id, new CircuitBreaker());
    let timer;
    try {
      const member = await circuits.get(id).run(() =>
        Promise.race([
          Promise.resolve()
            .then(() => guild.members.fetch({ user: userId, force: true, cache: false }))
            .catch(error => {
              if (error.code === 10007 || error.code === 10013) return null;
              throw error;
            }),
          new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Membership timeout')), 2000);
          }),
        ]),
      );
      if (!ready(guild) || client.guilds.cache.get(id) !== guild) return undefined;
      return member && !member.user.bot ? new Set(member.roles?.cache?.keys() || []) : null;
    } catch (error) {
      if (!ready(guild) || client.guilds.cache.get(id) !== guild) return undefined;
      log?.warn('Discord membership check got no answer.');
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }
  async function lookup(userId) {
    if (!client.isReady()) return undefined;
    const candidates = eligible(),
      epoch = generation,
      confirmed = new Map();
    let unanswered = false;
    for (let offset = 0; offset < candidates.length; offset += 3) {
      const batch = candidates.slice(offset, offset + 3);
      const answers = await Promise.all(batch.map(([id, guild]) => checkMember(id, guild, userId)));
      if (generation !== epoch || !client.isReady()) return undefined;
      answers.forEach((answer, index) => {
        if (answer === undefined) unanswered = true;
        else if (answer) confirmed.set(batch[index][0], answer);
      });
    }
    if (!confirmed.size) {
      if (!unanswered) members.delete(userId);
      return unanswered ? undefined : false;
    }
    const now = Date.now();
    members.set(userId, { confirmed, at: now });
    for (const [id, value] of members) if (now - value.at >= COMMAND_MS) members.delete(id);
    return true;
  }
  function currentMembership(userId) {
    const value = members.get(userId);
    return value && Date.now() - value.at < COMMAND_MS
      ? [...value.confirmed].filter(([id]) => ready(client.guilds.cache.get(id)))
      : [];
  }
  function activityLocation(userId, guildId, channelId) {
    if (excluded.has(guildId)) return false;
    if (!client.isReady()) return undefined;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return false;
    if (!ready(guild)) return undefined;
    return (
      guild.voiceStates?.cache?.get(userId)?.channelId === channelId &&
      guild.channels?.cache?.get(channelId)?.isVoiceBased?.() === true
    );
  }
  return {
    async directory() {
      const available = guilds(),
        epoch = generation;
      if (!available.length || !client.options?.intents?.has(GatewayIntentBits.GuildMembers))
        throw new Error('Discord member directory unavailable');
      const result = new Map();
      let pages = 0;
      for (const [id, guild] of available) {
        let after;
        // REST pages avoid a full gateway chunk request on every search.
        do {
          if (++pages > 100) throw new Error('Discord directory too large');
          const page = await guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
          if (epoch !== generation || !ready(guild) || client.guilds.cache.get(id) !== guild)
            throw new Error('Discord connection changed');
          for (const member of page.values())
            if (!member.user.bot && !result.has(member.id))
              result.set(member.id, {
                subject: member.id,
                name: member.displayName || member.user.globalName || member.user.username,
                alias: member.user.username,
              });
          const next = page.last()?.id;
          if (page.size < 1000) break;
          if (!next || next === after) throw new Error('Discord directory page did not advance');
          after = next;
        } while (true);
      }
      return [...result.values()];
    },
    discordOnline(subject) {
      if (!client.options?.intents?.has(GatewayIntentBits.GuildPresences)) return undefined;
      const statuses = guilds()
        .map(([, guild]) => guild.presences?.cache?.get(subject)?.status)
        .filter(Boolean);
      return statuses.length ? statuses.some(status => ['online', 'idle', 'dnd'].includes(status)) : undefined;
    },
    async identity(userId) {
      if (!client.isReady()) return;
      try {
        const profile = await client.users.fetch(userId);
        if (!profile || profile.bot) return;
        return { id: profile.id, name: String(profile.globalName || profile.username).slice(0, 100) };
      } catch {
        return;
      }
    },
    refresh(userId) {
      // Concurrent polling/command checks share the current lookup, never an older
      // completed result. This avoids one check cancelling another valid check.
      if (inflight.has(userId)) return inflight.get(userId);
      if (inflight.size >= 32) return Promise.resolve(undefined);
      const request = lookup(userId);
      inflight.set(userId, request);
      const cleanup = () => {
        if (inflight.get(userId) === request) inflight.delete(userId);
      };
      request.then(cleanup, cleanup);
      return request;
    },
    isMember(userId) {
      return currentMembership(userId).length > 0;
    },
    hasRole(userId, roleId) {
      return currentMembership(userId).some(([, roles]) => roles.has(roleId));
    },
    voiceChannel(userId) {
      return guilds()
        .map(([, guild]) => guild.voiceStates?.cache?.get(userId)?.channelId)
        .find(Boolean);
    },
    validVoiceChannel(channelId) {
      return !!channelId && guilds().some(([, guild]) => guild.channels?.cache?.get(channelId)?.isVoiceBased?.());
    },
    activityLocation,
    async activityVoice(userId, guildId, channelId) {
      const guild = client.guilds.cache.get(guildId),
        epoch = generation;
      const current = () => generation === epoch && activityLocation(userId, guildId, channelId) === true;
      return !!(current() && (await checkMember(guildId, guild, userId)) && current());
    },
    options() {
      return { available: guilds().length > 0 };
    },
    joinedServers() {
      if (!client.isReady()) return undefined;
      return joined().map(([id, guild]) => ({
        id,
        name: guild.name || 'Discord server',
        memberCount: guild.memberCount,
      }));
    },
  };
}
module.exports = { discordAccess };
