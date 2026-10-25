// @ts-check
'use strict';
const { randomUUID } = require('node:crypto');

class PlexReporting {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {Object} [options.hub]
   * @param {Object} [options.plexAuth]
   * @param {Object} [options.registry]
   * @param {() => number} [options.now]
   */
  constructor({ config, hub, plexAuth, registry, now = Date.now } = {}) {
    this.config = config || hub?.config || {};
    this.hub = hub;
    this.plexAuth = plexAuth || hub?.plexAuth;
    this.registry = registry;
    this.now = now;
    /** @type {Map<string, Object>} */
    this.sessions = new Map();
  }

  /**
   * Determine whether a viewer is eligible for personal Plex reporting.
   * Sponsored and guest viewers without stored personal credentials must fail closed.
   * @param {string} userId
   * @returns {boolean}
   */
  isEligible(userId) {
    if (!userId || this.config.plexReporting?.enabled === false) return false;
    if (!this.registry) return true;
    const identity = this.registry.identities(userId)?.find(i => i.provider === 'plex' && i.verified);
    return !!(identity && this.registry.hasCredential(identity.subject));
  }

  /**
   * @param {import('./types').Viewer|string} viewer
   * @returns {Object|undefined}
   */
  _findSession(viewer) {
    if (typeof viewer === 'string') return this.sessions.get(viewer);
    if (viewer?.viewerId && this.sessions.has(viewer.viewerId)) return this.sessions.get(viewer.viewerId);
    for (const session of this.sessions.values()) {
      if (session.viewer === viewer) return session;
    }
  }

  /**
   * @param {import('./types').Room} room
   * @param {import('./types').Viewer} viewer
   * @param {string} viewerId
   * @param {Object} data Decoded observation payload
   * @param {Object} observed Accepted tracking result
   */
  async observe(room, viewer, viewerId, data, observed) {
    if (this.config.plexReporting?.enabled === false) return;
    if (!room?.media || room.media.kind !== 'plex' || !room.media.id) return;
    if (!this.isEligible(viewer.userId)) return;

    if (viewer && !viewer.viewerId && viewerId) viewer.viewerId = viewerId;

    const allowActivity = viewer.plexReporting !== false;
    const allowWatchState = !!(viewer.plexWatchState && this.config.plexReporting?.watchState !== false);
    if (!allowActivity && !allowWatchState) {
      if (this.sessions.has(viewerId)) await this.end(viewer, 'opt-out');
      return;
    }

    let session = this.sessions.get(viewerId);
    if (session) {
      if (session.mediaId !== String(room.media.id) ||
          session.mediaVersion !== room.mediaVersion ||
          session.streamVersion !== viewer.streamVersion ||
          session.observationEpoch !== viewer.observationEpoch) {
        await this.end(viewer, 'context-changed');
        session = undefined;
      }
    }

    if (!session) {
      const plexAuth = this.plexAuth || this.hub?.plexAuth;
      let scoped;
      try {
        scoped = await (this.hub?.plexFor ? this.hub.plexFor(viewer.actor || { userId: viewer.userId }) : plexAuth?.forUser(viewer.userId));
      } catch {
        return;
      }
      if (!scoped) return;

      session = {
        sessionId: randomUUID(),
        clientId: scoped.clientId || 'uburoom-web-' + randomUUID(),
        userId: viewer.userId,
        viewerId,
        viewer,
        mediaId: String(room.media.id),
        duration: room.media.duration,
        mediaVersion: room.mediaVersion,
        streamVersion: viewer.streamVersion,
        observationEpoch: viewer.observationEpoch,
        consent: { activity: allowActivity, watchState: allowWatchState },
        scopedPlex: scoped,
        lastState: undefined,
        lastPositionMs: 0,
        lastReportedAt: 0,
        dispatched: Promise.resolve(),
        stopped: false
      };
      this.sessions.set(viewerId, session);
    }

    // Refresh consent if modified mid-session
    session.consent.activity = allowActivity;
    session.consent.watchState = allowWatchState;

    const currentMs = Math.round(data.position * 1000);
    const stateChanged = data.state !== session.lastState;
    const advanced = observed.credit?.reason === 'credited' || observed.credit?.reason === 'baseline';
    const elapsedMs = this.now() - session.lastReportedAt;
    const positionDeltaMs = Math.abs(currentMs - session.lastPositionMs);

    let shouldReport = false;
    if (stateChanged) {
      shouldReport = true;
    } else if (data.state === 'playing') {
      shouldReport = advanced && (elapsedMs >= 10000 || positionDeltaMs >= 15000);
    }

    if (!shouldReport) return;

    const reportedState = data.state === 'ended' ? 'stopped' : data.state;
    const query = new URLSearchParams({
      key: '/library/metadata/' + session.mediaId,
      ratingKey: session.mediaId,
      identifier: 'com.plexapp.plugins.library',
      state: reportedState,
      time: String(currentMs),
      continuing: '0'
    });

    if (session.consent.watchState && Number.isFinite(session.duration) && session.duration > 0) {
      query.set('duration', String(Math.round(session.duration * 1000)));
    }

    const headers = {
      'X-Plex-Client-Identifier': session.clientId,
      'X-Plex-Session-Identifier': session.sessionId
    };

    session.lastState = data.state;
    session.lastPositionMs = currentMs;
    session.lastReportedAt = this.now();

    session.dispatched = session.dispatched.then(async () => {
      if (session.stopped) return;
      try {
        await session.scopedPlex.request('/:/timeline?' + query, { method: 'POST', headers });
      } catch {}
    });

    if (data.state === 'ended') {
      await this.end(viewer, 'playback-ended');
    }
  }

  /**
   * Update consent dynamically for an active viewer session.
   * @param {import('./types').Viewer|string} viewer
   * @param {{activity?: boolean, watchState?: boolean}} consent
   */
  updateConsent(viewer, consent) {
    const session = this._findSession(viewer);
    if (!session) return;
    if (typeof consent.activity === 'boolean') session.consent.activity = consent.activity;
    if (typeof consent.watchState === 'boolean') session.consent.watchState = consent.watchState;
  }

  /**
   * Terminal report teardown. Dispatches state=stopped under viewerSessionId
   * without affecting the shared transcode producer.
   * @param {import('./types').Viewer|string} viewer
   * @param {string} [reason]
   */
  async end(viewer, reason) {
    const session = this._findSession(viewer);
    if (!session || session.stopped) return;
    session.stopped = true;
    this.sessions.delete(session.viewerId);

    const query = new URLSearchParams({
      key: '/library/metadata/' + session.mediaId,
      ratingKey: session.mediaId,
      identifier: 'com.plexapp.plugins.library',
      state: 'stopped',
      time: String(session.lastPositionMs || 0),
      continuing: '0'
    });

    if (session.consent.watchState && Number.isFinite(session.duration) && session.duration > 0) {
      query.set('duration', String(Math.round(session.duration * 1000)));
    }

    const headers = {
      'X-Plex-Client-Identifier': session.clientId,
      'X-Plex-Session-Identifier': session.sessionId
    };

    session.dispatched = session.dispatched.then(async () => {
      try {
        await session.scopedPlex.request('/:/timeline?' + query, { method: 'POST', headers });
      } catch {}
    });

    return session.dispatched;
  }

  /**
   * Close all active reporting sessions cleanly.
   */
  async close() {
    const pending = [...this.sessions.values()].map(session => this.end(session, 'server-closing'));
    await Promise.all(pending);
  }
}

module.exports = { PlexReporting };
