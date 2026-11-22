// @ts-check
'use strict';
const { LinkedAccountReporting } = require('../linked-reporting');
const { jellyfinIdentityProvider: identityProvider } = require('./client');

const TICKS_PER_MS = 10000;
const ITEM = /^([a-f0-9]{32})(?::([A-Za-z0-9_-]{1,64}))?$/i;

/**
 * Personal Jellyfin watch-state sync: playback start, progress and stop, and played state, written
 * to the viewer's own Jellyfin user with their own token, only when they opt in to watch-state sync.
 * Jellyfin keeps resume points from these same reports, so unlike Plex there is no activity-only
 * mode: without the opt-in nothing is sent. The source's API key never reports anything.
 * See server/sources/linked-reporting.js.
 */
class JellyfinReporting extends LinkedAccountReporting {
  /**
   * @param {ConstructorParameters<typeof LinkedAccountReporting>[0] & {
   *   client: ReturnType<typeof import('./client').jellyfinClient>}} options
   */
  constructor(options) {
    super(options);
    this.client = options.client;
  }
  get mediaKind() {
    return 'jellyfin';
  }
  identityProvider() {
    const server = this.serverId?.();
    return server ? identityProvider(server) : undefined;
  }
  /** The viewer's own Jellyfin token for this server, when they signed in to it. */
  token(userId) {
    const provider = this.identityProvider(),
      subject = provider && this.subject(userId);
    const credential = subject ? this.registry.credential(provider, subject) : undefined;
    return typeof credential?.token === 'string' && credential.token ? credential.token : undefined;
  }
  isEligible(userId) {
    return !!userId && this.settings.enabled !== false && this.settings.watchState !== false && !!this.token(userId);
  }
  async personalScope(userId) {
    const token = this.token(userId);
    return token ? { token, server: this.client.base + '#' + this.serverId?.() } : undefined;
  }
  /** Jellyfin stores resume points from every playback report, so it reports only with the opt-in or on stop. */
  wants(session, next, watchState) {
    return watchState || (next.state === 'stopped' && !!session.jellyfinStarted);
  }
  updateConsent(viewer, consent) {
    if (consent.watchState === false) {
      const session = this._findSession(viewer);
      if (session?.jellyfinStarted) {
        session.consent.watchState = false;
        return this.end(viewer, 'opt-out');
      }
    }
    return super.updateConsent(viewer, consent);
  }
  revoked(error) {
    return error?.status === 401;
  }
  async send(scoped, session, next, watchState) {
    const item = ITEM.exec(session.mediaId);
    if (!item) return;
    const [, itemId, mediaSourceId] = item;
    const report = {
      ItemId: itemId.toLowerCase(),
      ...(mediaSourceId ? { MediaSourceId: mediaSourceId } : {}),
      PositionTicks: Math.max(0, Math.round(next.position * TICKS_PER_MS)),
      IsPaused: next.state === 'paused',
      PlaySessionId: session.sessionId,
      PlayMethod: 'DirectStream',
      CanSeek: true,
    };
    const post = (path, body) => this.client.request(path, { method: 'POST', token: scoped.token, body });
    if (next.state === 'stopped') {
      if (session.jellyfinStarted) await post('Sessions/Playing/Stopped', report);
      session.jellyfinStarted = false;
      if (next.ended && watchState) await post('UserPlayedItems/' + report.ItemId);
      return;
    }
    if (!session.jellyfinStarted) {
      await post('Sessions/Playing', report);
      session.jellyfinStarted = true;
    } else await post('Sessions/Playing/Progress', report);
  }
}

module.exports = { JellyfinReporting };
