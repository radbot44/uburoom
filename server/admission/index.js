'use strict';
const { silentLogger } = require('../logger');
const { ServerPassword } = require('./password');
const noGuests = Object.freeze({ admits: () => false });

// A viewer a rule confirmed stays admitted without asking again until the recheck. After
// that only a provider's own no removes them: one that gives no answer is asked again
// shortly, and someone not yet confirmed is still refused.
const RECHECK_MS = 5 * 60000,
  UNANSWERED_RECHECK_MS = 30000,
  CONFIRMED_MS = 12 * 3600000;

/**
 * Admission: the only code that decides who gets in. The owner picks entry rules in `access:`
 * and **any one** matching rule admits (docs/media-sources.md):
 * - `discordServer`: a verified Discord identity that is a member of `discord.guild_id`;
 * - `sourceMembers`: a verified identity the named source says is its member (that source
 *   module's `members`, e.g. a Plex account that can reach a Plex source's server);
 * - `password`: a server-wide guest who entered `secrets.server_password` (its current revision);
 * - `accounts`: a verified uburoom account;
 * - room invites: a guest session for its own room, as before.
 * Sign-in methods (server/identity/) only prove who someone is. Admitted means every source's
 * media; no rule changes what a source serves.
 */
class Admission {
  /**
   * @param {any} config
   * @param {any} registry
   * @param {{list?: any[]}} [sources] - The media providers; those named in `sourceMembers` that have
   *   `members` vouch for their members.
   * @param {() => any} [discordAccess] - The live Discord membership view.
   * @param {{logger?: any, guests?: {admits(roomId: string, userId: string): boolean},
   *   accounts?: {admits(userId: string): boolean}}} [services] - `accounts` is uburoom's own accounts
   *   (server/identity/accounts.js); without it, a verified uburoom identity is the answer.
   */
  constructor(
    config,
    registry,
    sources,
    discordAccess = () => undefined,
    { logger = silentLogger, guests = noGuests, accounts } = {},
  ) {
    this.logger = logger;
    this.guests = guests;
    this.config = config;
    this.settings = config.accessPolicy;
    this.registry = registry;
    this.sources = sources;
    this.discordAccess = discordAccess;
    this.accounts = accounts;
    this.password = new ServerPassword(this.settings?.password ? config.serverPassword : '', registry);
    this.allowed = new Map();
    this.confirmed = new Map();
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
  /** The sources a `sourceMembers` rule names that can vouch for members. */
  memberSources() {
    const named = this.settings?.sourceMembers || [];
    return (this.sources?.list || []).filter(provider => named.includes(provider.id) && provider.members);
  }
  memberSignIns(kind) {
    return this.memberSources().filter(source => source.memberIdentity === kind && source.signIn);
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
      this.allowed.set(key, Date.now() + 1000);
      return true;
    }
    const identities = this.registry.identities(account.id).filter(identity => identity.verified);
    const key = this.admissionKey(account.id, context),
      now = Date.now();
    // Linking a provider, or entering with another password, changes who has to vouch for this account.
    const proof = [
      ...identities.map(identity => identity.provider + ':' + identity.subject).sort(),
      'password:' + (context?.serverPassword || ''),
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
  /**
   * Whether any rule lets this account in. True or false is the rules' answer; undefined means
   * none said yes and one that matters gave no answer (an outage is not a denial).
   */
  async answer(account, identities, context) {
    const discord = identities.find(identity => identity.provider === 'discord');
    // The installation owner (discord.owner_id), never a blank match.
    if (this.config.ownerId && discord?.subject === this.config.ownerId) return true;
    // The server password: a server-wide guest who entered the current one.
    if (
      this.settings.password &&
      !!this.password.revision &&
      context?.serverPassword === this.password.revision &&
      this.registry.isGuest(account.id)
    )
      return true;
    // uburoom's own accounts: enabled, with a password, signed in as that account.
    if (
      this.settings.accounts &&
      (this.accounts ? this.accounts.admits(account.id) : identities.some(identity => identity.provider === 'uburoom'))
    )
      return true;
    let unanswered = false;
    // Discord server membership; a Discord Activity is always checked against its guild.
    if ((this.settings.discordServer || context?.activity === true) && discord) {
      const access = this.discordAccess();
      let member;
      try {
        member = access?.isMember(discord.subject) || (await access?.refresh(discord.subject));
      } catch {
        member = undefined;
      }
      if (member) return true;
      if (member === undefined) unanswered = true;
    }
    // Members of a source the owner named: only that source can say, and only about identities of
    // its own sign-in kind ('plex', or 'jellyfin:<server id>' for Jellyfin), so one source's outage
    // never keeps someone in whom every rule that applies to them has refused.
    for (const source of this.memberSources())
      for (const identity of identities) {
        const kind = source.memberIdentity;
        if (kind && identity.provider !== kind && !identity.provider.startsWith(kind + ':')) continue;
        try {
          if ((await source.members({ ...identity, userId: account.id })) === true) return true;
        } catch (error) {
          if (error?.noServerAccess || error?.revoked) continue;
          this.logger.warn('Access', `Source ${source.id} gave no membership answer: ${error?.message || error}`);
          unanswered = true;
        }
      }
    return unanswered ? undefined : false;
  }
  fresh(id, context) {
    return (this.allowed.get(this.admissionKey(id, context)) || 0) > Date.now();
  }
  /** The rules and sign-in methods the entry page may show; never a password or a source's details. */
  public() {
    const jellyfinSources = this.settings?.publicWeb ? this.memberSignIns('jellyfin') : [];
    return this.settings
      ? {
          discord: !!this.settings.discord,
          plex: !!this.settings.plex,
          password: !!this.settings.password,
          accounts: !!this.settings.accounts,
          ...(jellyfinSources.length && {
            jellyfin: jellyfinSources.map(source => ({ id: source.id, name: source.label || source.id })),
          }),
          publicWeb: this.settings.publicWeb,
        }
      : undefined;
  }
  sweep() {
    for (const [key, expires] of this.allowed) if (expires <= Date.now()) this.allowed.delete(key);
    for (const [key, held] of this.confirmed) if (held.expires <= Date.now()) this.confirmed.delete(key);
  }
}

module.exports = { Admission };
