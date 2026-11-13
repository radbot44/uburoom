'use strict';
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { silentLogger } = require('./logger');
const noGuests = Object.freeze({ admits: () => false });

// A viewer the providers confirmed stays admitted without asking them again until
// the recheck. After that only a provider's own no removes them: one that gives no
// answer is asked again shortly, and someone not yet confirmed is still refused.
const RECHECK_MS = 5 * 60000,
  UNANSWERED_RECHECK_MS = 30000,
  CONFIRMED_MS = 12 * 3600000;

class AccessPolicy {
  /**
   * @param {{logger?: any, guests?: {admits(roomId: string, userId: string): boolean}}} [services]
   */
  constructor(config, registry, plexAuth, discordAccess, { logger = silentLogger, guests = noGuests } = {}) {
    this.logger = logger;
    this.guests = guests;
    this.config = config;
    this.settings = config.accessPolicy;
    this.registry = registry;
    this.plexAuth = plexAuth;
    this.discordAccess = discordAccess;
    this.allowed = new Map();
    this.confirmed = new Map();
    this.passwordGrants = new Map();
    this.entryUsers = new Map();
  }
  get anonymous() {
    return !!this.settings && !this.settings.discord && !this.settings.plex;
  }
  get passwordRequired() {
    return !!this.settings?.password;
  }
  // A guest session carries its room (login records hold guestRoom; actors hold
  // guestRoomId). For that room it stands in for the usual entry rules.
  guestRoom(context) {
    return context?.guestRoomId ?? context?.guestRoom;
  }
  viaGuest(id, context) {
    const room = this.guestRoom(context);
    return !!room && (context.guestUntil ?? Infinity) > Date.now() && this.guests.admits(room, id);
  }
  password(req, identity) {
    if (!this.passwordRequired) return true;
    if (identity?.activity && identity.entryAuthorized) return true;
    if (identity && this.viaGuest(identity.userId, identity)) return true;
    const token = /(?:^|;\s*)uburoom_entry=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return !!token && (this.passwordGrants.get(createHash('sha256').update(token).digest('hex')) || 0) > Date.now();
  }
  enter(value, identity) {
    if (!this.passwordRequired) return;
    const digest = value => createHash('sha256').update(value).digest();
    if (
      typeof value !== 'string' ||
      value.length > 1024 ||
      !timingSafeEqual(digest(value), digest(this.settings?.password || ''))
    )
      return;
    if (identity?.activity) identity.entryAuthorized = true;
    const token = randomBytes(32).toString('hex');
    this.passwordGrants.set(digest(token).toString('hex'), Date.now() + 12 * 3600000);
    this.sweep();
    return token;
  }
  requiresPlex(context) {
    return (
      !!this.settings?.requirePlex && !(context?.activity === true && this.settings.requirePlexInActivity === false)
    );
  }
  admissionKey(id, context) {
    const room = this.guestRoom(context);
    return room ? 'guest:' + room + ':' + id : context?.activity === true ? 'activity:' + id : id;
  }
  async admit(id, context) {
    if (!this.settings) return false;
    const account = this.registry.canonical(id);
    if (!account) return false;
    if (this.guestRoom(context)) {
      const key = this.admissionKey(account.id, context);
      if (!this.viaGuest(account.id, context)) {
        this.allowed.delete(key);
        return false;
      }
      // Being a guest never stands in for required personal Plex access.
      if (!this.requiresPlex(context)) {
        this.allowed.set(key, Date.now() + 1000);
        return true;
      }
    } else if (this.passwordRequired && (this.entryUsers.get(account.id) || 0) <= Date.now()) return false;
    const identities = this.registry.identities(account.id).filter(identity => identity.verified);
    const key = this.admissionKey(account.id, context),
      now = Date.now();
    // Linking a provider or changing the rule changes who has to vouch for this account.
    const proof = [
      this.requiresPlex(context),
      ...identities.map(identity => identity.provider + ':' + identity.subject).sort(),
    ].join();
    let held = this.confirmed.get(key);
    if (held?.proof !== proof || held.expires <= now) held = undefined;
    let allowed = held?.recheck > now;
    if (!allowed) {
      const answer = await this.answer(account, identities, context);
      allowed = answer === true || (answer === undefined && !!held);
      if (answer === true)
        this.confirmed.set(key, { proof, recheck: Date.now() + RECHECK_MS, expires: Date.now() + CONFIRMED_MS });
      else if (allowed) {
        held.recheck = Date.now() + UNANSWERED_RECHECK_MS;
        this.logger.warn('Access', `Keeping ${account.name || account.id} admitted: no provider answer`);
      } else this.confirmed.delete(key);
    }
    if (allowed) this.allowed.set(key, Date.now() + 1000);
    else this.allowed.delete(key);
    return allowed;
  }
  // True or false is the providers' answer; undefined means one that matters gave none.
  async answer(account, identities, context) {
    const discord = identities.find(identity => identity.provider === 'discord');
    const plex = identities.find(identity => identity.provider === 'plex');
    if (this.requiresPlex(context)) return plex ? this.plexAnswer(account.id, false) : false;
    if (this.anonymous || discord?.subject === this.config.ownerId) return true;
    let answer = false;
    if ((this.settings.discord || context?.activity === true) && discord) {
      const access = this.discordAccess();
      try {
        answer = access?.isMember(discord.subject) || (await access?.refresh(discord.subject));
      } catch {
        answer = undefined;
      }
      if (answer) return true;
    }
    if (this.settings.plex && plex) {
      const viaPlex = await this.plexAnswer(account.id, true);
      if (viaPlex || viaPlex === undefined) return viaPlex;
    }
    return answer;
  }
  async plexAnswer(id, withoutServerAccess) {
    try {
      return !!(await this.plexAuth.forUser(id));
    } catch (error) {
      if (error.noServerAccess) return withoutServerAccess;
      if (error.revoked) return false;
      this.logger.warn('Access', `Plex check got no answer: ${error.message}`);
      return undefined;
    }
  }
  fresh(id, context) {
    return (this.allowed.get(this.admissionKey(id, context)) || 0) > Date.now();
  }
  entered(id) {
    const account = this.registry.canonical(id);
    if (account) this.entryUsers.set(account.id, Date.now() + 12 * 3600000);
  }
  public() {
    return this.settings
      ? {
          discord: this.settings.discord,
          plex: this.settings.plex,
          requirePlex: this.settings.requirePlex,
          requirePlexInActivity: this.settings.requirePlexInActivity !== false,
          passwordRequired: this.passwordRequired,
          anonymous: this.anonymous,
          publicWeb: this.settings.publicWeb,
        }
      : undefined;
  }
  sweep() {
    for (const map of [this.passwordGrants, this.entryUsers, this.allowed])
      for (const [key, expires] of map) if (expires <= Date.now()) map.delete(key);
    for (const [key, held] of this.confirmed) if (held.expires <= Date.now()) this.confirmed.delete(key);
  }
}

module.exports = { AccessPolicy };
