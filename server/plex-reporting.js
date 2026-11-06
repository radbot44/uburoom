// @ts-check
'use strict';
const { runOperation } = require('./operation');
const { randomUUID } = require('node:crypto');
const { mediaIdentity } = require('../shared/room-protocol');

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
    this.retiring = new Set();
    this.closed = false;
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
    const cred = identity && (this.registry.credential ? this.registry.credential(identity.subject) : this.registry.hasCredential?.(identity.subject));
    return !!(cred && (typeof cred !== 'object' || cred.serverToken || cred.authType !== 'traditional'));
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
    if (this.closed || this.config.plexReporting?.enabled === false) return;
    if (!room?.media || room.media.kind !== 'plex' || !room.media.id) return;
    if (!this.isEligible(viewer.userId)) {
      const existing = this.sessions.get(viewerId);
      if (existing) {
        existing.stopped = true; existing.desired = undefined;
        this.sessions.delete(viewerId);
      }
      return;
    }

    if (viewer && !viewer.viewerId && viewerId) viewer.viewerId = viewerId;

    const allowActivity = viewer.plexReporting !== false;
    const allowWatchState = !!(viewer.plexWatchState && this.config.plexReporting?.watchState !== false);
    if (!allowActivity) {
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

    const currentMs = Math.round(data.position * 1000);

    if (data.state === 'ended' || data.state === 'error') {
      if (session) {
        session.lastPositionMs = currentMs;
        await this.end(viewer, data.state === 'ended' ? 'playback-ended' : 'playback-error');
      }
      return;
    }

    const reportedState = data.state === 'seeking' ? 'buffering' : data.state === 'blocked' ? 'paused' : data.state;
    if (!['playing', 'buffering', 'paused'].includes(reportedState)) return;

    if (!session) {
      this.creating ||= new Map();
      let init = this.creating.get(viewerId);
      if (!init) {
        const mediaId = String(room.media.id);
        const mediaVersion = room.mediaVersion;
        const streamVersion = viewer.streamVersion;
        const observationEpoch = viewer.observationEpoch;
        init = (async () => {
          const plexAuth = this.plexAuth || this.hub?.plexAuth;
          let scoped;
          try {
            scoped = await plexAuth?.forUser(viewer.userId);
          } catch {
            return;
          }
          if (!scoped || scoped.principal === 'discord-shared' || scoped.clientId === 'configured-fallback') return;
          if (this.closed || (room.viewers && room.viewers.get(viewerId) !== viewer) || !room.media?.id || String(room.media.id) !== mediaId ||
              room.mediaVersion !== mediaVersion || viewer.streamVersion !== streamVersion ||
              viewer.observationEpoch !== observationEpoch || viewer.plexReporting === false) {
            return;
          }
          const baseClientId = scoped.clientId || 'uburoom-web-' + viewerId;
          const hasActiveTab = [...this.sessions.values()].some(s => !s.stopped && s.userId === viewer.userId && s.viewerId !== viewerId && s.clientId === baseClientId);
          const clientId = hasActiveTab ? `${baseClientId}-${String(viewerId).slice(0, 8)}` : baseClientId;
          const s = {
            sessionId: randomUUID(),
            clientId,
            userId: viewer.userId,
            viewerId,
            viewer,
            room,
            mediaId,
            duration: room.media.duration,
            mediaVersion,
            streamVersion,
            observationEpoch,
            consent: { activity: allowActivity, watchState: allowWatchState },
            scopedPlex: scoped,
            lastState: undefined,
            lastPositionMs: 0,
            lastReportedAt: 0,
            dispatched: Promise.resolve(),
            stopped: false
          };
          this.sessions.set(viewerId, s);
          return s;
        })().finally(() => { this.creating?.delete(viewerId); });
        this.creating.set(viewerId, init);
      }
      session = await init;
      if (!session) return;
    }

    // Refresh consent if modified mid-session
    session.consent.activity = viewer.plexReporting !== false;
    session.consent.watchState = !!(viewer.plexWatchState && this.config.plexReporting?.watchState !== false);

    const stateChanged = reportedState !== session.lastState;
    const advanced = observed.credit?.reason === 'credited' || observed.credit?.reason === 'baseline';
    const elapsedMs = this.now() - session.lastReportedAt;
    const positionDeltaMs = Math.abs(currentMs - session.lastPositionMs);

    let shouldReport = false;
    if (stateChanged) {
      shouldReport = true;
    } else if (reportedState === 'playing') {
      shouldReport = advanced && (elapsedMs >= 10000 || positionDeltaMs >= 15000);
    }

    if (!shouldReport) return;

    session.lastState = reportedState;
    session.lastPositionMs = currentMs;
    session.lastReportedAt = this.now();
    this.enqueue(session, { state: reportedState, position: currentMs });
  }

  // One in-flight request and one latest desired state. Payloads are built at
  // dispatch, never before an authorization/consent wait or as an unbounded log.
  enqueue(session, desired) {
    session.desired = desired;
    if (session.dispatching) return session.dispatched;
    session.dispatching = true;
    session.dispatched = Promise.resolve().then(() => runOperation(undefined, async () => {
      while (session.desired) {
        let scoped;
        try { scoped = await (this.plexAuth || this.hub?.plexAuth)?.forUser(session.userId); }
        catch { session.desired = undefined; break; }
        const next = session.desired; session.desired = undefined;
        if (!next || !scoped || !this.isEligible(session.userId) || scoped.principal === 'discord-shared' || scoped.clientId === 'configured-fallback') continue;
        const terminal = next.state === 'stopped';
        if (!terminal && (session.stopped || !session.consent.activity ||
            session.viewer.plexReporting === false || session.room.mediaVersion !== session.mediaVersion ||
            session.viewer.streamVersion !== session.streamVersion || session.viewer.observationEpoch !== session.observationEpoch)) continue;
        const identity = mediaIdentity(session.mediaId);
        if (!identity?.ratingKey) continue;
        const query = new URLSearchParams({ key: '/library/metadata/' + identity.ratingKey,
          ratingKey: identity.ratingKey, identifier: 'com.plexapp.plugins.library',
          state: next.state, time: String(next.position), continuing: '0' });
        if (session.consent.watchState && session.viewer.plexWatchState && this.config.plexReporting?.watchState !== false &&
            Number.isFinite(session.duration) && session.duration > 0) query.set('duration', String(Math.round(session.duration * 1000)));
        try {
          await scoped.request('/:/timeline?' + query, { method: 'POST',
            signal: AbortSignal.timeout(12000), headers: {
              'X-Plex-Client-Identifier': session.clientId, 'X-Plex-Session-Identifier': session.sessionId
            } });
        } catch (error) {
          if ([401, 403, 498].includes(error?.status)) {
            session.stopped = true; session.desired = undefined;
            if (this.sessions.get(session.viewerId) === session) this.sessions.delete(session.viewerId);
          }
        }
      }
    })).finally(() => {
      session.dispatching = false;
      if (session.desired) this.enqueue(session, session.desired);
    });
    return session.dispatched;
  }

  /**
   * Update consent dynamically for an active viewer session.
   * @param {import('./types').Viewer|string} viewer
   * @param {{activity?: boolean, watchState?: boolean}} consent
   */
  updateConsent(viewer, consent) {
    if (consent.activity === false) {
      return this.end(viewer, 'opt-out');
    }
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

    const retired = this.enqueue(session, { state: 'stopped', position: session.lastPositionMs || 0 });
    this.retiring.add(retired);
    try { await retired; } finally { this.retiring.delete(retired); }
  }

  /**
   * Close all active reporting sessions cleanly.
   */
  async close() {
    this.closed = true;
    await Promise.allSettled([...(this.creating?.values() || [])]);
    const pending = [...this.sessions.values()].map(session => this.end(session, 'server-closing'));
    await Promise.allSettled([...pending, ...this.retiring]);
  }
}

module.exports = { PlexReporting };
