'use strict';
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');

class AccessPolicy {
  constructor(config, registry, plexAuth, discordAccess) {
    this.config = config;
    this.settings = config.accessPolicy;
    this.registry = registry;
    this.plexAuth = plexAuth;
    this.discordAccess = discordAccess;
    this.allowed = new Map();
    this.passwordGrants = new Map();
    this.entryUsers = new Map();
  }
  get anonymous() { return !!this.settings && !this.settings.discord && !this.settings.plex; }
  get passwordRequired() { return !!this.settings?.password; }
  password(req, identity) {
    if (!this.passwordRequired) return true;
    if (identity?.activity && identity.entryAuthorized) return true;
    const token = /(?:^|;\s*)uburoom_entry=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return !!token && (this.passwordGrants.get(createHash('sha256').update(token).digest('hex')) || 0) > Date.now();
  }
  enter(value, identity) {
    const digest = value => createHash('sha256').update(value).digest();
    if (typeof value !== 'string' || value.length > 1024 || !timingSafeEqual(digest(value), digest(this.settings?.password || ''))) return;
    if (identity?.activity) identity.entryAuthorized = true;
    const token = randomBytes(32).toString('hex');
    this.passwordGrants.set(digest(token).toString('hex'), Date.now() + 12 * 3600000);
    this.sweep();
    return token;
  }
  async admit(id) {
    if (!this.settings) return false;
    const account = this.registry?.canonical(id);
    if (!account) return false;
    if(this.passwordRequired && (this.entryUsers.get(account.id)||0)<=Date.now())return false;
    const identities = this.registry.identities(account.id).filter(identity => identity.verified);
    const discord = identities.find(identity => identity.provider === 'discord');
    const plex = identities.find(identity => identity.provider === 'plex');
    let allowed = false;
    if (this.settings.requirePlex) {
      try { allowed = !!plex && !!await this.plexAuth.forUser(account.id); } catch { allowed = false; }
    } else if (this.anonymous || discord?.subject === this.config.ownerId) allowed = true;
    else {
      if (this.settings.discord && discord) {
        const access = this.discordAccess();
        try { allowed = !!access?.isMember(discord.subject) || !!await access?.refresh(discord.subject); } catch { allowed = false; }
      }
      if (!allowed && this.settings.plex && plex) {
        try { allowed = !!await this.plexAuth.forUser(account.id); } catch(error) { allowed = error.noServerAccess === true; }
      }
    }
    if (allowed) this.allowed.set(account.id, Date.now() + 1000);
    else this.allowed.delete(account.id);
    return allowed;
  }
  fresh(id) { return (this.allowed.get(id) || 0) > Date.now(); }
  entered(id) {this.entryUsers.set(id,Date.now()+12*3600000);}
  public() {
    return this.settings ? { discord:this.settings.discord, plex:this.settings.plex, requirePlex:this.settings.requirePlex,
      passwordRequired:this.passwordRequired, anonymous:this.anonymous, publicWeb:this.settings.publicWeb } : undefined;
  }
  sweep() { for(const map of [this.passwordGrants,this.entryUsers,this.allowed])for(const [key,expires]of map)if(expires<=Date.now())map.delete(key); }
}

module.exports = { AccessPolicy };
