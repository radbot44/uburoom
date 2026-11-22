// @ts-check
'use strict';
const { LinkedAccountReporting } = require('../linked-reporting');
const { plexIdentity } = require('./identity');
const { DIRECT_CLIENT } = require('./auth');

/**
 * Personal Plex reports: activity in the viewer's own Plex "Now playing", and with their opt-in,
 * watch state (`duration` on the timeline, so Plex keeps resume points and marks played). Sent
 * with the viewer's own Plex sign-in, never the source's token. See server/sources/linked-reporting.js.
 */
class PlexReporting extends LinkedAccountReporting {
  /**
   * @param {ConstructorParameters<typeof LinkedAccountReporting>[0] & {plexAuth?: any}} [options]
   */
  constructor(options = {}) {
    super(options);
    this.plexAuth = options.plexAuth || options.hub?.plexAuth;
  }
  get mediaKind() {
    return 'plex';
  }
  identityProvider() {
    return 'plex';
  }
  /**
   * Whether a viewer is eligible for personal Plex reporting: their own stored Plex sign-in.
   * @param {string} userId
   * @returns {boolean}
   */
  isEligible(userId) {
    if (!userId || this.settings.enabled === false) return false;
    const identity = this.registry.identities(userId)?.find(i => i.provider === 'plex' && i.verified);
    if (!identity || this.plexAuth?.hasNegativeAccess?.(identity.subject)) return false;
    const cred = this.registry.credential
      ? this.registry.credential('plex', identity.subject)
      : this.registry.hasCredential?.('plex', identity.subject);
    return !!cred;
  }
  personalScope(userId) {
    return (this.plexAuth || this.hub?.plexAuth)?.forUser(userId);
  }
  personal(scoped) {
    return !!scoped && scoped.principal !== 'discord-shared' && scoped.clientId !== DIRECT_CLIENT;
  }
  scopeServer(scoped) {
    return scoped?.base?.origin;
  }
  revoked(error) {
    return [401, 403, 498].includes(error?.status);
  }
  async send(scoped, session, next, watchState) {
    const identity = plexIdentity(session.mediaId);
    if (!identity?.ratingKey) return;
    const query = new URLSearchParams({
      key: '/library/metadata/' + identity.ratingKey,
      ratingKey: identity.ratingKey,
      identifier: 'com.plexapp.plugins.library',
      state: next.state,
      time: String(next.position),
      continuing: '0',
    });
    if (watchState) query.set('duration', String(Math.round(session.duration * 1000)));
    await scoped.request('/:/timeline?' + query, {
      method: 'POST',
      signal: AbortSignal.timeout(12000),
      headers: {
        'X-Plex-Client-Identifier': session.clientId,
        'X-Plex-Session-Identifier': session.sessionId,
      },
    });
  }
}

module.exports = { PlexReporting };
