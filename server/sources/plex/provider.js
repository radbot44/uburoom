'use strict';
const { PlexDelivery } = require('./delivery');
const { PlexReporting } = require('./reporting');
const { serverName } = require('../../media-providers');

const failure = (message, status = 409) => Object.assign(new Error(message), { status });

/**
 * Plex as a media provider: which server it is, the one scope everyone admitted watches
 * through, and the two things only Plex offers: playback reports to a viewer's own Plex
 * account and direct delivery from the Plex server. Catalog, sessions and transcodes
 * stay in server/plex.js.
 * @param {{plex: any, source?: any, registry?: any, plexAuth?: any, pin?: any}} services - `source` is the
 *   source entry; `plexAuth` this source's own server access (server/sources/plex/auth.js).
 * @returns {import('../../media-providers').MediaProvider}
 */
function plexProvider({ plex, source = {}, registry, plexAuth, pin = plexAuth?.pin }) {
  let identifying;
  const provider = {
    kind: 'plex',
    root: plex,
    reporting: services =>
      new PlexReporting({
        settings: source.reporting,
        serverId: () => provider.serverId,
        plexAuth,
        registry,
        ...services,
      }),
    // Direct delivery checks its dedicated account with plex.tv, so it needs the Plex sign-in services.
    direct: plexAuth ? new PlexDelivery(source, plex, plexAuth, actor => provider.scopeFor(actor)) : undefined,
    /** The server's own name (Plex's friendlyName), known once `identity()` has answered. */
    serverName: '',
    /** The machine identifier, seeded from configuration or saved pin, and verified on `identity()`. */
    serverId: source.machineIdentifier || pin?.get() || undefined,
    // The machine identifier, pinned the first time it is seen so a different
    // server behind the same address is refused rather than mistaken for this one.
    identity() {
      if (!identifying) {
        identifying = (async () => {
          const info = await plex.json('/');
          const id = info.machineIdentifier,
            pinned = source.machineIdentifier || pin?.get();
          if (typeof id !== 'string' || !id || (pinned && id !== pinned))
            throw failure('The configured Plex server identity changed', 503);
          if (!pinned) await pin?.set(id);
          provider.serverName = serverName(info.friendlyName);
          provider.serverId = id;
          return id;
        })();
        identifying.catch(() => {
          identifying = undefined;
        });
      }
      return identifying;
    },
    /**
     * Continue watching is each viewer's own: their Plex On Deck through their own verified Plex sign-in.
     * A viewer without one, or whose account cannot reach this server, gets none: the shared
     * account's progress is not theirs. This is personal data, never a way to media.
     */
    async continueWatching(actor) {
      if (!plexAuth || !registry.identities(actor.userId).some(i => i.provider === 'plex' && i.verified)) return [];
      let own;
      try {
        own = await plexAuth.forUser(actor.userId);
      } catch (error) {
        if (error.noServerAccess) return [];
        throw error;
      }
      return own ? own.continueWatching() : [];
    },
    /**
     * Everyone admitted watches every library through the source's own credential: the
     * configured token, or with direct delivery the dedicated account browsers get tokens from.
     * Admission is checked by the caller; a viewer's own Plex permissions play no part.
     */
    async scopeFor() {
      return provider.direct?.enabled ? plexAuth.dedicated() : plex;
    },
  };
  return provider;
}

module.exports = { plexProvider };
