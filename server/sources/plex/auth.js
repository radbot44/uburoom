'use strict';
const { randomUUID, sign } = require('node:crypto');
const { resilientFetch, isProviderOutage } = require('../../resilience');
const { runOperation } = require('../../operation');
class PlexAccessError extends Error {
  constructor(message, revoked = false) {
    super(message);
    this.revoked = revoked;
  }
}
// A person's own Plex sign-in that Plex no longer accepts (a password change signs out
// every device) or that uburoom no longer holds. Only signing in to Plex again fixes it.
const RECONNECT_PLEX =
  'Your Plex sign-in has expired or was revoked, for example by a Plex password change. Reconnect Plex to continue.';
/** The client id the dedicated direct-delivery account's scope is opened with. */
const DIRECT_CLIENT = 'configured-direct';
function plexReconnectError(message = RECONNECT_PLEX) {
  return Object.assign(new PlexAccessError(message, true), { status: 403, reconnect: 'plex' });
}
/** A pin kept only in memory, for a source built without the account database. */
function memoryPin() {
  let value;
  return {
    get: () => value,
    set: async identity => {
      value = identity;
    },
  };
}

/**
 * plex.tv sign-in, and one Plex source's server seen through a person's own Plex account:
 * whether that account can reach this source's pinned server, and the scope it gets there.
 * Built per Plex source; `PlexSignIn` combines them for the people side.
 */
class PlexAuth {
  /**
   * @param {any} source - The Plex source entry (`token`, `machineIdentifier`, `delivery`); absent for plex.tv only.
   * @param {any} accounts
   * @param {any} plex - That source's Plex.
   * @param {typeof fetch} [fetcher]
   * @param {{pin?: {get(): string|undefined, set(id: string): Promise<void>}}} [services]
   */
  constructor(source, accounts, plex, fetcher = fetch, { pin } = {}) {
    this.source = source || {};
    this.accounts = accounts;
    this.plex = plex;
    this.pin = pin || memoryPin();
    this.fetch = resilientFetch(fetcher, { timeoutMs: 10000 });
    this.cache = new Map();
    this.inflight = new Map();
    this.generation = 0;
  }
  async request(resource, { token, clientId, method = 'GET', data } = {}) {
    const response = await this.fetch('https://clients.plex.tv/api/v2' + resource, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        Accept: 'application/json',
        'X-Plex-Product': 'uburoom',
        'X-Plex-Client-Identifier': clientId || 'uburoom-auth',
        ...(token ? { 'X-Plex-Token': token } : {}),
        ...(data ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    if (!response.ok)
      throw new PlexAccessError(
        [401, 403, 498].includes(response.status)
          ? 'Plex authorization expired or was revoked'
          : 'Plex is temporarily unavailable; try again',
        [401, 403, 498].includes(response.status),
      );
    return response.json();
  }
  jwt(credential, claims = {}) {
    const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url'),
      now = Math.floor(Date.now() / 1000);
    const payload = encode({
      aud: 'plex.tv',
      iss: credential.clientId,
      iat: now,
      exp: now + 300,
      scope: 'username,friendly_name,restricted',
      ...claims,
    });
    const input = encode({ kid: credential.kid, alg: 'EdDSA', typ: 'JWT' }) + '.' + payload;
    return input + '.' + sign(null, Buffer.from(input), credential.privateKey).toString('base64url');
  }
  async start(forwardUrl) {
    // PMS installations can reject JWT resource tokens despite accepting the
    // same account at plex.tv. Use Plex's documented traditional PIN flow.
    const clientId = randomUUID(),
      credential = { clientId, authType: 'traditional' };
    const pin = await this.request('/pins?strong=true', { clientId, method: 'POST' });
    if (!pin.id || typeof pin.code !== 'string') throw new Error('Plex sign-in could not start');
    const params = new URLSearchParams({
      clientID: clientId,
      code: pin.code,
      forwardUrl,
      'context[device][product]': 'uburoom',
    });
    return { credential, pinId: String(pin.id), url: 'https://app.plex.tv/auth#?' + params };
  }
  /** The plex.tv account a finished PIN belongs to; says nothing about any server. */
  async identify(attempt) {
    const { credential } = attempt,
      pin = await this.request(
        '/pins/' +
          encodeURIComponent(attempt.pinId) +
          (credential.privateKey ? '?deviceJWT=' + encodeURIComponent(this.jwt(credential)) : ''),
        { clientId: credential.clientId },
      );
    if (typeof pin.authToken !== 'string' || !pin.authToken)
      throw new Error('Plex sign-in was not completed; start again');
    credential.token = pin.authToken;
    if (credential.privateKey) credential.expires = Date.now() + 6 * 86400000;
    const profile = await this.request('/user', { token: credential.token, clientId: credential.clientId });
    if (!/^\d{1,20}$/.test(String(profile.id))) throw new Error('Plex account identity unavailable');
    const name = String(profile.username || profile.friendlyName || 'Plex user').slice(0, 100);
    return { subject: String(profile.id), name, credential };
  }
  async machine() {
    const pinned = this.source.machineIdentifier || this.pin.get();
    let root;
    try {
      root = await this.plex.json('/');
    } catch (error) {
      throw Object.assign(
        new PlexAccessError(
          error.status
            ? `Plex server identity check failed (HTTP ${error.status}); check the server's PLEX_TOKEN and access settings`
            : 'Plex server identity check could not reach the configured server; check PLEX_URL and connectivity',
        ),
        { providerOutage: isProviderOutage(error) },
      );
    }
    const id = root.machineIdentifier;
    if (typeof id !== 'string' || !id) throw new Error('Plex server identity unavailable');
    if (pinned && pinned !== id) throw new Error('Configured Plex server identity changed; check server configuration');
    if (!pinned) await this.pin.set(id);
    return id;
  }
  async validate(credential, expectedSubject) {
    // Keep renewal for already-stored JWT credentials; traditional tokens are
    // verified on every access refresh and require sign-in again if revoked.
    if (credential.privateKey && credential.expires <= Date.now()) {
      const { nonce } = await this.request('/auth/nonce', { clientId: credential.clientId });
      if (typeof nonce !== 'string') throw new Error('Plex renewal unavailable');
      const renewed = await this.request('/auth/token', {
        clientId: credential.clientId,
        method: 'POST',
        data: { jwt: this.jwt(credential, { nonce }) },
      });
      if (typeof renewed.auth_token !== 'string') throw new Error('Plex renewal unavailable');
      credential.token = renewed.auth_token;
      credential.expires = Date.now() + 6 * 86400000;
    }
    const [profile, machine, resources] = await Promise.all([
      expectedSubject ? this.request('/user', { token: credential.token, clientId: credential.clientId }) : null,
      this.machine(),
      this.request('/resources?includeHttps=1&includeRelay=1', {
        token: credential.token,
        clientId: credential.clientId,
      }),
    ]);
    if (expectedSubject && String(profile?.id) !== expectedSubject)
      throw new PlexAccessError('Plex credential identity mismatch', true);
    const resource =
      Array.isArray(resources) &&
      resources.find(r => r.clientIdentifier === machine && String(r.provides).split(',').includes('server'));
    if (!resource || typeof resource.accessToken !== 'string' || !resource.accessToken)
      throw Object.assign(new PlexAccessError('This Plex account does not have access to this server', true), {
        noServerAccess: true,
      });
    credential.serverToken = resource.accessToken;
    const scoped = this.plex.scope(resource.accessToken, credential.clientId);
    scoped.discoveryToken = credential.token;
    let sections;
    try {
      sections = await scoped.json('/library/sections');
    } catch (error) {
      const denied = [401, 403, 498].includes(error.status);
      throw Object.assign(
        new PlexAccessError(
          error.status
            ? `Plex server library access check failed (HTTP ${error.status}); ${denied ? 'the server rejected this account token. Sign in or reconnect Plex again; check that this account has server access' : 'try again or check the Plex server'}`
            : 'Plex server library access check could not reach the configured server; check PLEX_URL and connectivity',
          denied,
        ),
        { providerOutage: isProviderOutage(error) },
      );
    }
    if (!Array.isArray(sections.Directory) || !sections.Directory.length)
      throw new PlexAccessError('This Plex account has no accessible libraries on this server', true);
    // A refreshed permission scope must not reuse data gathered before revalidation.
    for (const cache of [scoped.catalogCache, scoped.artSources, scoped.imageCache, scoped.randomCache]) cache.clear();
    scoped.invalidateAccess?.();
    return scoped;
  }
  /**
   * The server as the dedicated direct-delivery account (`plex.direct_token`) sees it.
   * Everyone admitted watches through it when delivery is direct; it is never the owner token.
   */
  async dedicated() {
    const token = this.source.delivery?.token;
    if (!token || token === this.source.token) throw new PlexAccessError('Direct delivery has no dedicated account');
    if (this.dedicatedCache?.token === token && this.dedicatedCache.until > Date.now()) return this.dedicatedCache.plex;
    if (this.dedicatedInflight?.token === token) return this.dedicatedInflight.job;
    const generation = this.generation;
    const job = runOperation(undefined, async () => {
      let scoped = this.plex.scope(token, DIRECT_CLIENT),
        sections;
      try {
        sections = await scoped.json('/library/sections');
      } catch (error) {
        if (error.status !== 401) throw error;
        // The dedicated token may be an account token rather than a PMS token.
        // Resolve access for that same account; never change identity.
        scoped = await this.validate({ token, clientId: DIRECT_CLIENT });
      }
      if (sections && (!Array.isArray(sections.Directory) || !sections.Directory.length))
        throw new PlexAccessError('The direct delivery account has no accessible libraries');
      if (generation !== this.generation) throw new PlexAccessError('Plex scope changed during validation');
      this.dedicatedCache = { token, plex: scoped, until: Date.now() + 30000 };
      return scoped;
    });
    this.dedicatedInflight = { token, job };
    try {
      return await job;
    } finally {
      if (this.dedicatedInflight?.job === job) this.dedicatedInflight = undefined;
    }
  }
  async forUser(userId) {
    const user = this.accounts.canonical(userId),
      identity = user && this.accounts.identities(user.id).find(i => i.provider === 'plex' && i.verified);
    if (!identity) return;
    const cached = this.cache.get(identity.subject);
    if (cached && cached.until > Date.now()) return cached.plex;
    if (this.inflight.has(identity.subject)) return this.inflight.get(identity.subject);
    const generation = this.generation;
    const job = runOperation(undefined, async () => {
      const credential = this.accounts.credential(identity.subject);
      if (!credential) return;
      try {
        const scoped = await this.validate(credential, identity.subject);
        if (generation !== this.generation) throw new PlexAccessError('Plex scope changed during validation');
        this.accounts.credential(identity.subject, credential);
        this.cache.set(identity.subject, { plex: scoped, until: Date.now() + 30000 });
        return scoped;
      } catch (error) {
        if (generation === this.generation) this.cache.delete(identity.subject);
        // Plex refused this person's own sign-in. Say so, so they can reconnect;
        // a lack of server membership stays its own answer.
        if (error.revoked && !error.noServerAccess && !error.reconnect) throw plexReconnectError();
        throw error;
      }
    });
    this.inflight.set(identity.subject, job);
    try {
      return await job;
    } finally {
      if (this.inflight.get(identity.subject) === job) this.inflight.delete(identity.subject);
    }
  }
  fresh(userId) {
    const user = this.accounts.canonical(userId),
      identity = user && this.accounts.identities(user.id).find(i => i.provider === 'plex' && i.verified);
    return !!identity && !!this.cache.get(identity.subject) && this.cache.get(identity.subject).until > Date.now();
  }
  clear() {
    this.plex.invalidateAccess?.();
    for (const scope of this.plex.scopes?.values() || []) scope.invalidateAccess?.();
    this.generation++;
    this.cache.clear();
    this.inflight.clear();
    this.dedicatedCache = undefined;
    this.dedicatedInflight = undefined;
  }
}
/**
 * Plex sign-in across every Plex source: plex.tv proves who someone is, and until admission
 * has its own entry rules (phase 3) a Plex account is let in when it can reach **any**
 * configured Plex source. With no Plex source, signing in still proves who someone is, but
 * admits nobody.
 */
class PlexSignIn {
  /**
   * @param {any} config - Reads `accessPolicy` and `guests` for who may finish signing in.
   * @param {any} accounts
   * @param {PlexAuth[]} sources - One per Plex source, in config order.
   * @param {typeof fetch} [fetcher]
   */
  constructor(config, accounts, sources, fetcher = fetch) {
    this.config = config;
    this.accounts = accounts;
    this.sources = sources;
    this.account = new PlexAuth(undefined, accounts, undefined, fetcher);
  }
  /** Whether any Plex source is configured, so a Plex sign-in can let anyone in. */
  get admits() {
    return this.sources.some(source => source.plex?.configured);
  }
  request(resource, options) {
    return this.account.request(resource, options);
  }
  start(forwardUrl) {
    return this.account.start(forwardUrl);
  }
  async finish(attempt) {
    const identity = await this.account.identify(attempt);
    if (!this.sources.length) return identity;
    try {
      await this.any(source => source.validate(identity.credential));
    } catch (error) {
      // Someone outside every server may still sign in to use a room invite as a guest.
      if (!(this.config.accessPolicy && this.config.guests?.enabled && error.noServerAccess)) throw error;
    }
    return identity;
  }
  /**
   * The first source that answers yes. With none: a source that gave no answer is the answer
   * (so an outage is not a denial), then a revoked sign-in, then "no access to any server".
   */
  async any(ask) {
    const errors = [];
    for (const source of this.sources) {
      try {
        const answer = await ask(source);
        if (answer) return answer;
      } catch (error) {
        errors.push(error);
      }
    }
    const unanswered = errors.find(error => !error.noServerAccess && !error.revoked);
    if (unanswered) throw unanswered;
    const revoked = errors.find(error => error.revoked && !error.noServerAccess);
    if (revoked) throw revoked;
    if (errors.length || !this.sources.length)
      throw Object.assign(new PlexAccessError('This Plex account does not have access to this server', true), {
        noServerAccess: true,
      });
  }
  /** This person's own scope on the first Plex source their account can reach. */
  forUser(userId) {
    return this.any(source => source.forUser(userId));
  }
  fresh(userId) {
    return this.sources.some(source => source.fresh(userId));
  }
  clear() {
    for (const source of this.sources) source.clear();
  }
  /** The plex.tv account the first Plex source's own token belongs to. */
  async ownerProfile() {
    const token = this.sources.find(source => source.source.token)?.source.token;
    if (!token) throw new Error('No Plex source token');
    return this.request('/user', { token });
  }
}

module.exports = { PlexAuth, PlexSignIn, PlexAccessError, plexReconnectError, RECONNECT_PLEX, DIRECT_CLIENT };
