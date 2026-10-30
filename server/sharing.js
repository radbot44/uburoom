'use strict';
const { Events, Status, GatewayIntentBits } = require('discord.js');
const { COMMAND_MS } = require('./core');
const { CircuitBreaker } = require('./resilience');

// Gateway voice state is authoritative only while this guild's shard is ready.
// Guild membership is fetched afresh for each friend command and acknowledgement.
function discordAccess(client, guildId) {
  const members = new Map(), inflight = new Map();
  const circuit = new CircuitBreaker();
  let generation = 0;
  const guild = () => {
    const g = client.guilds.cache.get(guildId);
    return client.isReady() && g?.available && g.shard?.status === Status.Ready ? g : undefined;
  };
  const invalidate = () => { generation++; members.clear(); inflight.clear(); };
  client.on(Events.ShardDisconnect, invalidate);
  client.on(Events.ShardReconnecting, invalidate);
  client.on(Events.GuildUnavailable, g => { if (g.id === guildId) invalidate(); });
  async function lookup(userId) {
      const g = guild(), epoch = generation;
      if (!g) return false;
      let timer;
      try {
        const member = await circuit.run(() => Promise.race([
          g.members.fetch({ user: userId, force: true, cache: false }),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Membership timeout')), 2000); })
        ]));
        if (generation !== epoch || !guild()) return false;
        if (!member || member.user.bot) { members.delete(userId); return false; }
        members.set(userId, { roles: new Set(member.roles?.cache?.keys() || []), at: Date.now() });
        for (const [id, value] of members) if (value.at && Date.now() - value.at >= COMMAND_MS) members.delete(id);
        return true;
      } catch {
        if (generation === epoch) {
          const existing = members.get(userId);
          if (!existing || !existing.at || Date.now() - existing.at >= COMMAND_MS) members.delete(userId);
        }
        return false;
      } finally { clearTimeout(timer); }
  }
  return {
    async directory() {
      const g = guild(), epoch = generation;
      if (!g || !client.options?.intents?.has(GatewayIntentBits.GuildMembers)) throw new Error('Discord member directory unavailable');
      const result = []; let after, pages = 0;
      // REST pages avoid a full gateway chunk request on every search.
      do {
        if (++pages>100) throw new Error('Discord directory too large');
        const page = await g.members.list({limit:1000,...(after?{after}:{})});
        if (epoch !== generation || guild() !== g) throw new Error('Discord connection changed');
        for (const member of page.values()) if (!member.user.bot) result.push({subject:member.id,name:member.displayName || member.user.globalName || member.user.username,alias:member.user.username});
        if (result.length>100000) throw new Error('Discord directory too large');
        const next = page.last()?.id;
        if (page.size<1000) break;
        if (!next || next===after) throw new Error('Discord directory page did not advance');
        after = next;
      } while (true);
      return result;
    },
    discordOnline(subject) {
      if (!guild() || !client.options?.intents?.has(GatewayIntentBits.GuildPresences)) return undefined;
      const status = guild().presences.cache.get(subject)?.status;
      return status === undefined ? undefined : ['online','idle','dnd'].includes(status);
    },
    async identity(userId) {
      if(!client.isReady())return;
      try{const profile=await client.users.fetch(userId);if(!profile||profile.bot)return;return {id:profile.id,name:String(profile.globalName||profile.username).slice(0,100)};}catch{return;}
    },
    refresh(userId) {
      // Concurrent polling/command checks share the current lookup, never an older
      // completed result. This avoids one check cancelling another valid check.
      if (inflight.has(userId)) return inflight.get(userId);
      const request = lookup(userId);
      inflight.set(userId, request);
      const cleanup = () => { if (inflight.get(userId) === request) inflight.delete(userId); };
      request.then(cleanup, cleanup);
      return request;
    },
    isMember(userId) { const at = members.get(userId)?.at; return !!guild() && !!at && Date.now() - at < COMMAND_MS; },
    hasRole(userId, roleId) { const member = members.get(userId); return !!guild() && !!member?.at && Date.now() - member.at < COMMAND_MS && member.roles.has(roleId); },
    voiceChannel(userId) { return guild()?.voiceStates?.cache?.get(userId)?.channelId; },
    validVoiceChannel(channelId) { const c = channelId && guild()?.channels?.cache?.get(channelId); return !!c && typeof c.isVoiceBased === 'function' && c.isVoiceBased(); },
    options() {
      const g = guild();
      return { available: !!g, guildName: g?.name || '' };
    }
  };
}
module.exports = { discordAccess };
