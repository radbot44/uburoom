'use strict';
// @ts-check
// Whether a verified Jellyfin identity is a member of this source's server: the user exists there,
// is enabled, and (when uburoom holds their token) that sign-in still works. Signing in to the
// server is the proof of membership; the source's API key confirms it later.
//
// Answers like the Plex check (server/sources/plex/auth.js): resolves true for a member; throws an
// error with `noServerAccess` (another server, removed or disabled user) or `revoked` (their own
// sign-in was revoked); any other error means the server gave no answer, which is never a denial.
const { jellyfinId, jellyfinIdentityProvider } = require('./client');

const fail = (message, flags) => Object.assign(new Error(message), flags);

/**
 * @param {{client: ReturnType<typeof import('./client').jellyfinClient>, apiKey: string,
 *   serverId: () => Promise<string>, knownServerId?: () => string|undefined, registry?: any}} services
 */
function jellyfinMembers({ client, apiKey, serverId, knownServerId = () => undefined, registry }) {
  const pending = new Map();
  /** @param {{provider: string, subject: string}} identity */
  async function check(identity) {
    const known = knownServerId();
    const user = jellyfinId(identity?.subject);
    const anotherServer = () => fail('This sign-in belongs to another Jellyfin server', { noServerAccess: true });
    // An outage on an unrelated pinned source cannot hide a denial from the qualifying source.
    if (!user || (known && identity?.provider !== jellyfinIdentityProvider(known))) throw anotherServer();
    const server = await serverId();
    if (identity?.provider !== jellyfinIdentityProvider(server)) throw anotherServer();
    let profile;
    try {
      profile = await client.request('Users/' + user, { token: apiKey });
    } catch (error) {
      if (error.status === 404) throw fail('This Jellyfin user no longer exists', { noServerAccess: true });
      if (error.status === 401 || error.status === 403)
        throw fail("The Jellyfin source's API key was refused; check the source", { status: 503 });
      throw error;
    }
    if (jellyfinId(profile?.Id) !== user) throw fail('Jellyfin answered for another user', { status: 503 });
    if (profile?.Policy?.IsDisabled === true) throw fail('This Jellyfin user is disabled', { noServerAccess: true });
    const credential = identity?.token ? { token: identity.token } : registry?.credential(identity.provider, user);
    if (credential?.token) {
      try {
        const me = await client.request('Users/Me', { token: credential.token });
        if (jellyfinId(me?.Id) !== user) throw fail('Your Jellyfin sign-in changed; sign in again', { revoked: true });
      } catch (error) {
        if (error.revoked) throw error;
        if (error.status === 401) throw fail('Your Jellyfin sign-in was revoked; sign in again', { revoked: true });
        throw error;
      }
    }
    return true;
  }
  /**
   * Concurrent checks for the same identity share one answer.
   * @param {{provider: string, subject: string}} identity
   * @returns {Promise<true>}
   */
  return function members(identity) {
    const key = JSON.stringify([identity?.provider, identity?.subject]);
    let job = pending.get(key);
    if (!job) {
      if (pending.size >= 200) return Promise.reject(fail('Jellyfin membership checks are busy', { status: 503 }));
      job = check(identity).finally(() => pending.delete(key));
      pending.set(key, job);
    }
    return job;
  };
}

module.exports = { jellyfinMembers };
