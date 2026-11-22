'use strict';
// @ts-check
// Signing in to one Jellyfin source's server. Quick Connect when the server has it on; otherwise a username and password,
// sent once to that server and never stored or logged. The result is a verified identity
// `{provider: 'jellyfin:<serverId>', subject: <user id>, name, token}`; the person's token is kept
// encrypted in the credentials store under that provider, for membership and watch-state sync.
const { randomBytes } = require('node:crypto');
const { jellyfinId, jellyfinIdentityProvider } = require('./client');

// Jellyfin forgets a Quick Connect request after 10 minutes; uburoom stops a little earlier.
const QUICK_CONNECT_MS = 9 * 60000;
const MAX_ATTEMPTS = 200;

const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/**
 * @param {{client: ReturnType<typeof import('./client').jellyfinClient>, serverId: () => Promise<string>,
 *   registry?: any, now?: () => number, requireAdministrator?: boolean}} services
 *   `serverId` is the server's id (pinned for a configured source). Without `registry` nothing is stored.
 */
function jellyfinSignIn({ client, serverId, registry, now = Date.now, requireAdministrator = false }) {
  /** @type {Map<string, {secret: string, expires: number}>} */
  const attempts = new Map();
  function sweep() {
    for (const [id, attempt] of attempts) if (attempt.expires <= now()) attempts.delete(id);
  }
  function attempt(id) {
    const found = typeof id === 'string' ? attempts.get(id) : undefined;
    if (!found || found.expires <= now()) {
      if (found) attempts.delete(id);
      throw fail('The Quick Connect code expired; start again', 'JELLYFIN_EXPIRED');
    }
    return found;
  }
  /** Checks Jellyfin's answer to a sign-in and optionally keeps the person's token. */
  async function accept(result, persistCredential = true) {
    const server = await serverId();
    const user = jellyfinId(result?.User?.Id);
    const token = typeof result?.AccessToken === 'string' ? result.AccessToken : '';
    if (!user || !/^[\x21-\x7e]{8,200}$/.test(token) || token.includes('"'))
      throw fail('Jellyfin sent a sign-in uburoom cannot read', 'JELLYFIN_ANSWER', 502);
    if (jellyfinId(result.ServerId) !== server)
      throw fail('That sign-in came from a different Jellyfin server', 'JELLYFIN_SERVER', 409);
    if (result.User?.Policy?.IsDisabled === true)
      throw fail('This Jellyfin user is disabled', 'JELLYFIN_DISABLED', 403);
    if (requireAdministrator && result.User?.Policy?.IsAdministrator !== true)
      throw fail('Sign in as a Jellyfin administrator', 'JELLYFIN_NOT_ADMIN', 403);
    const name =
      typeof result.User.Name === 'string' && result.User.Name.trim()
        ? result.User.Name.trim().slice(0, 80)
        : 'Jellyfin user';
    const identity = { provider: jellyfinIdentityProvider(server), subject: user, name, token };
    if (registry && persistCredential) registry.credential(identity.provider, user, { token });
    return identity;
  }
  /** A sign-in failure as the person should hear it; never the password or the server's words. */
  function signInError(error) {
    if (error.code) return error;
    if (error.status === 401 || error.status === 400)
      return fail('Wrong Jellyfin username or password', 'JELLYFIN_REFUSED', 401);
    if (error.unanswered) return fail('The Jellyfin server did not answer; try again', 'JELLYFIN_UNANSWERED', 503);
    return fail('Jellyfin refused the sign-in', 'JELLYFIN_REFUSED', 401);
  }
  return {
    /** Whether the server offers Quick Connect (an admin turns it on in Jellyfin's dashboard). */
    async quickConnect() {
      try {
        return (await client.request('QuickConnect/Enabled')) === true;
      } catch (error) {
        if (error.status === 404) return false;
        throw fail('The Jellyfin server did not answer; try again', 'JELLYFIN_UNANSWERED', 503);
      }
    },
    /**
     * Starts Quick Connect: the code to show, and an attempt id for `poll` and `finish`. Jellyfin's
     * secret stays here; the caller binds the attempt to the browser that asked.
     */
    async startQuickConnect() {
      sweep();
      if (attempts.size >= MAX_ATTEMPTS)
        throw fail('Jellyfin sign-in is busy; try again shortly', 'JELLYFIN_BUSY', 429);
      if (!(await this.quickConnect()))
        throw fail('Quick Connect is off on this Jellyfin server', 'JELLYFIN_NO_QUICK_CONNECT', 409);
      let started;
      try {
        started = await client.request('QuickConnect/Initiate', { method: 'POST' });
      } catch (error) {
        throw signInError(error);
      }
      const code = typeof started?.Code === 'string' && /^\d{4,10}$/.test(started.Code) ? started.Code : '';
      if (!code || typeof started.Secret !== 'string' || !started.Secret)
        throw fail('Jellyfin sent a sign-in uburoom cannot read', 'JELLYFIN_ANSWER', 502);
      const id = randomBytes(24).toString('base64url');
      const expires = now() + QUICK_CONNECT_MS;
      attempts.set(id, { secret: started.Secret, expires });
      return { id, code, expires };
    },
    /** Whether the person has approved the code yet. */
    async poll(id) {
      const { secret } = attempt(id);
      try {
        const state = await client.request('QuickConnect/Connect', { query: { secret } });
        return state?.Authenticated === true;
      } catch (error) {
        if (error.status === 404 || error.status === 401) {
          attempts.delete(id);
          throw fail('The Quick Connect code expired; start again', 'JELLYFIN_EXPIRED');
        }
        throw signInError(error);
      }
    },
    /** Exchanges an approved Quick Connect attempt for the person's identity. Works once. */
    async finish(id, { persistCredential = true } = {}) {
      const { secret } = attempt(id);
      attempts.delete(id);
      let result;
      try {
        result = await client.request('Users/AuthenticateWithQuickConnect', {
          method: 'POST',
          body: { Secret: secret },
        });
      } catch (error) {
        throw error.status === 400 || error.status === 401
          ? fail('Approve the code in Jellyfin first, then try again', 'JELLYFIN_NOT_APPROVED', 409)
          : signInError(error);
      }
      return accept(result, persistCredential);
    },
    /**
     * Signs in with a username and password, sent once to the server. Never retried: Jellyfin
     * disables a user after too many wrong passwords.
     * @param {unknown} username
     * @param {unknown} password
     */
    async password(username, password, { persistCredential = true } = {}) {
      if (typeof username !== 'string' || !username.trim() || username.length > 200)
        throw fail('Enter your Jellyfin username', 'JELLYFIN_USERNAME');
      if (typeof password !== 'string' || password.length > 1024)
        throw fail('Wrong Jellyfin username or password', 'JELLYFIN_REFUSED', 401);
      let result;
      try {
        result = await client.request('Users/AuthenticateByName', {
          method: 'POST',
          body: { Username: username.trim(), Pw: password },
        });
      } catch (error) {
        throw signInError(error);
      }
      return accept(result, persistCredential);
    },
    /** Ends a Quick Connect attempt; later polls and exchanges find it expired. */
    cancel(id) {
      if (typeof id === 'string') attempts.delete(id);
    },
    sweep,
    close: () => attempts.clear(),
  };
}

module.exports = { jellyfinSignIn, QUICK_CONNECT_MS };
