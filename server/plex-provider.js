'use strict';
const { plexReconnectError } = require('./plex-auth');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });

/**
 * Plex as a media provider: which server it is, and which Plex scope a person
 * watches through. Catalog, sessions and transcodes stay in server/plex.js.
 * @param {{plex: any, config?: any, registry?: any, plexAuth?: any, entryPolicy?: any}} services
 * @returns {import('./media-providers').MediaProvider}
 */
function plexProvider({ plex, config = {}, registry, plexAuth, entryPolicy }) {
  let identifying;
  return {
    kind: 'plex',
    root: plex,
    // The machine identifier, pinned the first time it is seen so a different
    // server behind the same address is refused rather than mistaken for this one.
    identity() {
      if (!identifying) {
        identifying = (async () => {
          const info = await plex.json('/');
          const id = info.machineIdentifier,
            pinned = config.plexMachineIdentifier || registry.meta('plexMachineIdentifier');
          if (typeof id !== 'string' || !id || (pinned && id !== pinned))
            throw failure('The configured Plex server identity changed', 503);
          if (!pinned) {
            registry.meta('plexMachineIdentifier', id);
            await registry.flush();
          }
          return id;
        })();
        identifying.catch(() => {
          identifying = undefined;
        });
      }
      return identifying;
    },
    // Without the services that know people, everyone watches through the configured token.
    async scopeFor(actor) {
      if (!plexAuth) return plex;
      const identity = registry.identities(actor.userId).find(i => i.provider === 'plex' && i.verified);
      const fallback = () => {
        if (config.plexFallback?.enabled === false)
          throw new Error('Connect a Plex account with access to this server; shared fallback is disabled');
        return plexAuth.fallback();
      };
      if (!identity) return fallback();
      if (!registry.hasCredential(identity.subject))
        throw plexReconnectError('Your Plex sign-in is missing. Reconnect Plex to continue.');
      try {
        const scoped = await plexAuth.forUser(actor.userId);
        if (!scoped) throw plexReconnectError('Your Plex sign-in is missing. Reconnect Plex to continue.');
        return scoped;
      } catch (error) {
        // Only a confirmed lack of server membership may use explicit open-entry
        // sponsorship. Expiry, network errors and item restrictions never do.
        if (config.accessPolicy && !entryPolicy.requiresPlex(actor) && error.noServerAccess) return fallback();
        throw error;
      }
    },
  };
}

module.exports = { plexProvider };
