'use strict';
const { Events, Status } = require('discord.js');
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
  function validVoiceChannel(id) { return !!guild()?.channels.cache.get(id)?.isVoiceBased(); }
  async function lookup(userId) {
      const g = guild(), epoch = generation;
      if (!g) return false;
      let timer;
      const request = {};
      members.set(userId, request);
      try {
        const member = await Promise.race([
          circuit.run(()=>g.members.fetch({ user: userId, force: true, cache: false })),
          new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Membership timeout')), 2000); })
        ]);
        if (generation !== epoch || !guild() || members.get(userId) !== request) return false;
        if (!member || member.user.bot) { members.delete(userId); return false; }
        request.roles = new Set(member.roles?.cache?.keys() || []);
        request.at = Date.now();
        for (const [id, value] of members) if (value.at && Date.now() - value.at >= COMMAND_MS) members.delete(id);
        return true;
      } catch {
        if (members.get(userId) === request) members.delete(userId);
        return false;
      } finally { clearTimeout(timer); }
  }
  return {
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
    voiceChannel(userId) { return guild()?.voiceStates.cache.get(userId)?.channelId; },
    validVoiceChannel,
    options() {
      const g = guild();
      return { available: !!g, guildName: g?.name || '' };
    }
  };
}
module.exports = { discordAccess };
