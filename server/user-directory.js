'use strict';

// Search returns public presentation fields only, never Accounts.summary/credentials.
class UserDirectory {
  constructor({registry,config,discord,discordOnline,plex,now=Date.now}) {
    Object.assign(this,{registry,config,discord,discordOnline,plex,now});
    this.cache = new Map(); this.connections = new Map();
  }
  connected(socket,userId) { this.connections.set(socket,{userId,at:this.now()}); }
  disconnected(socket) { this.connections.delete(socket); }
  online() {
    const ids = new Set();
    for (const [socket,entry] of this.connections) {
      if (socket.readyState !== 1 || this.now()-entry.at > 10000) this.connections.delete(socket);
      else { const user = this.registry.canonical(entry.userId); if (user) ids.add(user.id); }
    }
    return ids;
  }
  enabled(provider) { return this.config.directory?.[provider] ?? provider === 'discord'; }
  async source(provider) {
    if (!this.enabled(provider)) return [];
    const existing = this.cache.get(provider);
    if (existing?.until > this.now()) { if (existing.error) throw new Error(existing.error); return existing.rows; }
    if (existing?.promise) return existing.promise;
    const entry = {};
    entry.promise = (async () => {
      try {
        const rows = await this[provider]();
        if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Directory too large');
        entry.rows = rows.filter(row=>typeof row.subject === 'string' && (provider === 'discord' ? /^\d{17,20}$/ : /^\d{1,20}$/).test(row.subject))
          .map(row=>({provider,subject:row.subject,name:String(row.name || row.subject).slice(0,100),alias:String(row.alias || '').slice(0,100)}));
        entry.until = this.now()+60000; return entry.rows;
      } catch {
        entry.error = provider === 'discord' ? 'Discord directory unavailable; check the bot and Server Members Intent.' : 'Plex directory unavailable; check the configured server owner token.';
        entry.until = this.now()+15000; throw new Error(entry.error);
      } finally { delete entry.promise; }
    })();
    this.cache.set(provider,entry); return entry.promise;
  }
  async candidate(provider,subject) {
    if (!['discord','plex'].includes(provider) || !this.enabled(provider)) throw Object.assign(new Error('Directory source is disabled'),{status:403});
    const target = (await this.source(provider)).find(row=>row.subject===subject);
    if (!target) throw Object.assign(new Error('Directory member unavailable; search again'),{status:409});
    return target;
  }
  async search(query,{members=[],hosts=[],creatorId,allHosts=false,pending=[]}={}) {
    if (typeof query !== 'string' || query.length > 100) throw Object.assign(new Error('Search with up to 100 characters'),{status:400});
    const q = query.trim().normalize('NFC').toLocaleLowerCase(), notices = [], external = [];
    if (!q) return {results:[],notices};
    await Promise.all(['discord','plex'].map(async provider=>{
      if (!this.enabled(provider)) return;
      try { external.push(...await this.source(provider)); } catch (error) { notices.push(error.message); }
    }));
    const online = this.online(), room = new Set(members), rows = [], linked = new Map();
    for (const account of this.registry.directory()) {
      for (const identity of account.identities) linked.set(identity.provider+':'+identity.subject,account.id);
      if (account.signedInAt === null && !room.has(account.id) && !online.has(account.id)) continue;
      rows.push({userId:account.id,name:account.name,aliases:account.identities.map(i=>i.name),discord:account.identities.find(i=>i.provider==='discord')?.subject,
        providers:account.identities.map(i=>i.provider),group:room.has(account.id)?0:online.has(account.id)?1:2});
    }
    for (const entry of external) {
      const id = linked.get(entry.provider+':'+entry.subject), known = id && rows.find(row=>row.userId===id);
      if (known) { known.aliases.push(entry.name,entry.alias); continue; }
      rows.push({...entry,aliases:[entry.alias],providers:[entry.provider],discord:entry.provider==='discord'?entry.subject:undefined,group:3});
    }
    const unique = new Map();
    for (const row of rows) {
      if (![row.name,...row.aliases].some(name=>name?.normalize('NFC').toLocaleLowerCase().includes(q))) continue;
      row.available = row.group >= 2 && !!row.discord && this.discordOnline?.(row.discord) === true;
      const base = ['In this room','Online in uburoom','Previously on uburoom','Not on uburoom yet'][row.group];
      row.caption = base + (row.available ? ' · Online on Discord' : '') + (row.providers.length ? ' · ' + row.providers.map(p=>p==='discord'?'Discord':'Plex').join(' / ') : ' · Guest');
      const aliases = [...new Set(row.aliases)].filter(alias=>alias && alias!==row.name);
      if (aliases.length) row.caption += ' · ' + aliases.join(' / ');
      row.assigned = row.userId === creatorId || hosts.includes(row.userId) || pending.some(p=>p.provider===row.provider&&p.subject===row.subject);
      row.host = row.assigned || allHosts && row.group===0;
      unique.set(row.userId || row.provider+':'+row.subject,row);
    }
    const matched = [...unique.values()].sort((a,b)=>a.group-b.group || Number(b.available)-Number(a.available) || a.name.localeCompare(b.name) || String(a.userId||a.subject).localeCompare(String(b.userId||b.subject)));
    // Same-name accounts remain selectable without pretending their names identify them.
    const duplicates = new Map();
    for (const row of matched) duplicates.set(row.name,(duplicates.get(row.name)||0)+1);
    return {results:matched.slice(0,20).map(row=>({userId:row.userId,provider:row.provider,subject:row.subject,name:row.name,
      caption:row.caption+(duplicates.get(row.name)>1&&row.userId?' · Account '+row.userId.slice(0,8):''),assigned:row.assigned,host:row.host})),notices:notices.sort()};
  }
}
module.exports = { UserDirectory };
