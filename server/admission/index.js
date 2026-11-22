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
 * - `discordServer`: a verified Discord identity that belongs to an eligible server the bot joined;
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
  discordDropped(identities, held) {
    if (!['discord', 'owner'].includes(held?.via) || held.unanswered || !held.cachedMember) return false;
    const discord = identities.find(identity => identity.provider === 'discord');
    const access = discord && this.discordAccess();
    if (!access || access.options?.()?.available === false) return false;
    return access.isMember(discord.subject) === false;
  }
  async admit(id, context) {
    if (!this.settings) return false;
    const account = this.registry.canonical(id);
    if (!account) return false;
    const guestRoom = this.guestRoom(context);
    const key = this.admissionKey(account.id, context);
    const identities = this.registry.identities(account.id).filter(identity => identity.verified);
    if (!this.registry.isGuest?.(account.id)) {
      const regularKey = context?.activity === true ? 'activity:' + account.id : account.id;
      const now = Date.now();
      const proof = [
        ...identities.map(identity => identity.provider + ':' + identity.subject).sort(),
        'password:' + (context?.serverPassword || ''),
      ].join();
      let held = this.confirmed.get(regularKey);
      if (held?.proof !== proof || held.expires <= now) held = undefined;
      let regularAllowed = held?.recheck > now && !this.discordDropped(identities, held);
      if (!regularAllowed) {
        const regularContext = guestRoom ? { ...context, guestRoom: undefined, guestRoomId: undefined } : context;
        const outcome = await this.answerWithRule(account, identities, regularContext);
        const answer = outcome.allowed;
        regularAllowed = answer === true || (answer === undefined && !!held);
        if (answer === true) {
          const discord = identities.find(identity => identity.provider === 'discord');
          this.confirmed.set(regularKey, {
            proof,
            via: outcome.via,
            cachedMember: !!(discord && this.discordAccess()?.isMember?.(discord.subject) === true),
            unanswered: false,
            recheck: Date.now() + RECHECK_MS,
            expires: Date.now() + CONFIRMED_MS,
          });
        } else if (regularAllowed) {
          held.unanswered = true;
          held.recheck = Date.now() + UNANSWERED_RECHECK_MS;
          this.logger.warn('Access', `Keeping ${account.name || account.id} admitted: no provider answer`);
        } else {
          this.confirmed.delete(regularKey);
          this.allowed.delete(regularKey);
        }
      }
      if (regularAllowed) {
        const until = Date.now() + 1000;
        this.allowed.set(regularKey, until);
        if (key !== regularKey) this.allowed.set(key, until);
        if (account.signedInAt === null) this.registry.seen(account.id);
        return true;
      }
      if (!guestRoom) {
        this.allowed.delete(key);
        return false;
      }
    }
    if (guestRoom) {
      if (!this.viaGuest(account.id, context)) {
        this.allowed.delete(key);
        return false;
      }
      this.allowed.set(key, Date.now() + 1000);
      return true;
    }
    const now = Date.now();
    // Linking a provider, or entering with another password, changes who has to vouch for this account.
    const proof = [
      ...identities.map(identity => identity.provider + ':' + identity.subject).sort(),
      'password:' + (context?.serverPassword || ''),
    ].join();
    let held = this.confirmed.get(key);
    if (held?.proof !== proof || held.expires <= now) held = undefined;
    let allowed = held?.recheck > now && !this.discordDropped(identities, held);
    if (!allowed) {
      const outcome = await this.answerWithRule(account, identities, context);
      const answer = outcome.allowed;
      allowed = answer === true || (answer === undefined && !!held);
      if (answer === true) {
        const discord = identities.find(identity => identity.provider === 'discord');
        this.confirmed.set(key, {
          proof,
          via: outcome.via,
          cachedMember: !!(discord && this.discordAccess()?.isMember?.(discord.subject) === true),
          unanswered: false,
          recheck: Date.now() + RECHECK_MS,
          expires: Date.now() + CONFIRMED_MS,
        });
      } else if (allowed) {
        held.unanswered = true;
        held.recheck = Date.now() + UNANSWERED_RECHECK_MS;
        this.logger.warn('Access', `Keeping ${account.name || account.id} admitted: no provider answer`);
      } else this.confirmed.delete(key);
    }
    if (allowed) {
      this.allowed.set(key, Date.now() + 1000);
      if (account.signedInAt === null) this.registry.seen(account.id);
    } else this.allowed.delete(key);
    return allowed;
  }
  invalidate(ids) {
    const match = new Set(ids);
    for (const key of this.allowed.keys()) {
      const userId = key.startsWith('activity:')
        ? key.slice('activity:'.length)
        : key.startsWith('guest:')
          ? key.slice(key.indexOf(':', 6) + 1)
          : key;
      if (match.has(userId)) this.allowed.delete(key);
    }
    for (const key of this.confirmed.keys()) {
      const userId = key.startsWith('activity:') ? key.slice('activity:'.length) : key;
      if (match.has(userId)) this.confirmed.delete(key);
    }
  }
  sourceMatchesIdentity(source, identity) {
    const kind = source.memberIdentity;
    if (!kind) return false;
    if (kind === 'plex') return identity.provider === 'plex';
    if (kind === 'jellyfin') return !!source.serverId && identity.provider === 'jellyfin:' + source.serverId;
    return identity.provider === kind || identity.provider.startsWith(kind + ':');
  }
  /**
   * Checks whether `userId` would still be admitted if `(provider, subject)` were unlinked.
   * Synchronous/rule-level when `live` is false (for UI state); live-verifies remaining providers when `live` is true.
   */
  async wouldAdmitWithout(userId, provider, subject, { live = false } = {}) {
    const account = this.registry.canonical(userId);
    if (!account || !this.settings) return false;
    const oauthReady = !!(this.config.clientId && this.config.clientSecret && this.config.ownerId);
    const identities = this.registry
      .identities(account.id)
      .filter(i => i.verified && !(i.provider === provider && i.subject === String(subject)));
    const usable = identities.filter(
      i =>
        (i.provider !== 'plex' && !i.provider.startsWith('jellyfin:')) ||
        this.registry.hasCredential(i.provider, i.subject),
    );
    if (usable.some(i => i.provider.startsWith('jellyfin:'))) {
      for (const source of this.memberSources()) {
        if (source.memberIdentity === 'jellyfin' && !source.serverId && typeof source.identity === 'function') {
          try {
            await source.identity();
          } catch {}
        }
      }
    }
    const providerEnabled = identity => {
      if (!identity) return false;
      if (identity.provider === 'discord') {
        if (!oauthReady) return false;
        return this.settings.discord !== false || identity.subject === this.config.ownerId;
      }
      if (identity.provider === 'uburoom') return !!this.settings.accounts;
      return this.memberSources().some(source => this.sourceMatchesIdentity(source, identity));
    };
    const configuredEligible = usable.some(
      i => providerEnabled(i) && (i.provider !== 'uburoom' || !this.accounts || this.accounts.admits(account.id)),
    );
    if (!live) return configuredEligible;
    const enabled = usable.filter(providerEnabled);
    if (!usable.length) throw new Error('Connect another sign-in method before removing this account');
    if (!enabled.length) {
      const remaining = usable[0];
      const label =
        remaining.provider === 'plex'
          ? 'Plex'
          : remaining.provider === 'discord'
            ? 'Discord'
            : remaining.provider === 'uburoom'
              ? 'uburoom account'
              : 'Jellyfin';
      throw new Error(label + ' sign-in is disabled on this server; keep your connected account');
    }
    let lastError;
    for (const remaining of enabled) {
      if (remaining.provider === 'uburoom') {
        if (!this.accounts || this.accounts.admits(account.id)) return true;
        lastError = new Error('Set a password for your uburoom account before removing this sign-in');
        continue;
      }
      if (remaining.provider === 'discord') {
        const access = this.discordAccess();
        if (access?.isMember(remaining.subject) || (await access?.refresh(remaining.subject))) return true;
        lastError = new Error('Discord access is unavailable; keep your connected account');
        continue;
      }
      let denied = false;
      let answered = false;
      for (const source of this.memberSources()) {
        if (!this.sourceMatchesIdentity(source, remaining)) continue;
        try {
          if ((await source.members({ ...remaining, userId: account.id })) === true) return true;
          denied = true;
        } catch (error) {
          if (error?.noServerAccess || error?.revoked) denied = true;
          else answered = true;
        }
      }
      const name = remaining.provider === 'plex' ? 'Plex' : 'Jellyfin';
      lastError =
        !denied && answered
          ? new Error('Could not verify your remaining account access right now; try again')
          : new Error(`Sign in to ${name} before removing your other sign-in`);
    }
    throw lastError;
  }
  /**
   * Whether any rule lets this account in, and which rule matched.
   */
  async answerWithRule(account, identities, context) {
    const discord = identities.find(identity => identity.provider === 'discord');
    // The installation owner (discord.owner_id), never a blank match.
    if (this.config.ownerId && discord?.subject === this.config.ownerId) {
      const access = this.discordAccess();
      if (!access || access.options?.()?.available === false || access.isMember(discord.subject) !== false) {
        return { allowed: true, via: 'owner' };
      }
      if ((await access.refresh?.(discord.subject)) === true) return { allowed: true, via: 'owner' };
    }
    // The server password: a server-wide guest who entered the current one.
    if (
      this.settings.password &&
      !!this.password.revision &&
      context?.serverPassword === this.password.revision &&
      this.registry.isGuest(account.id)
    )
      return { allowed: true, via: 'password' };
    // uburoom's own accounts: enabled, with a password, signed in as that account.
    if (
      this.settings.accounts &&
      (this.accounts ? this.accounts.admits(account.id) : identities.some(identity => identity.provider === 'uburoom'))
    )
      return { allowed: true, via: 'accounts' };
    let unanswered = false;
    // The Activity login also checks the account's voice channel through the bot.
    if ((this.settings.discordServer || context?.activity === true) && discord) {
      const access = this.discordAccess();
      let member;
      try {
        member = access?.isMember(discord.subject) || (await access?.refresh(discord.subject));
      } catch {
        member = undefined;
      }
      if (member) return { allowed: true, via: 'discord' };
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
          if ((await source.members({ ...identity, userId: account.id })) === true)
            return { allowed: true, via: 'source' };
        } catch (error) {
          if (error?.noServerAccess || error?.revoked) continue;
          this.logger.warn('Access', `Source ${source.id} gave no membership answer: ${error?.message || error}`);
          unanswered = true;
        }
      }
    return { allowed: unanswered ? undefined : false };
  }
  async answer(account, identities, context) {
    return (await this.answerWithRule(account, identities, context)).allowed;
  }
  fresh(id, context) {
    const account = this.registry.canonical(id);
    const canonicalId = account?.id || id;
    const now = Date.now();
    const guestRoom = this.guestRoom(context);
    if (guestRoom && this.viaGuest(canonicalId, context)) return true;
    const key = this.admissionKey(canonicalId, context);
    const identities = account ? this.registry.identities(account.id).filter(identity => identity.verified) : [];
    const proof = [
      ...identities.map(identity => identity.provider + ':' + identity.subject).sort(),
      'password:' + (context?.serverPassword || ''),
    ].join();
    const regularKey = context?.activity === true ? 'activity:' + canonicalId : canonicalId;
    const held = this.confirmed.get(guestRoom && (!account || this.registry.isGuest(account.id)) ? key : regularKey);
    if (!guestRoom || (account && !this.registry.isGuest(account.id))) {
      if (
        held &&
        held.recheck > now &&
        held.expires > now &&
        (!account || held.proof === proof) &&
        !this.discordDropped(identities, held)
      ) {
        return true;
      }
    }
    return (this.allowed.get(key) || 0) > now && !this.discordDropped(identities, held);
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
