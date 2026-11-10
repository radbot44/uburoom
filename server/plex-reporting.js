// @ts-check
'use strict';
const { runOperation } = require('./operation');
const { randomUUID } = require('node:crypto');
const { mediaIdentity } = require('../shared/room-protocol');
const { RECONNECT_GRACE_MS } = require('../shared/sync');
const RECOVERABLE = new Set(['stream-changed', 'delivery-changed', 'observation-timeout']);

class PlexReporting {
  /**
   * @param {Object} [options]
   * @param {Object} [options.config]
   * @param {Object} [options.hub]
   * @param {Object} [options.plexAuth]
   * @param {Object} [options.registry]
   * @param {() => number} [options.now]
   * @param {(room: Object, viewer: Object) => Promise<boolean>} [options.authorize]
   */
  constructor({ config, hub, plexAuth, registry, now = Date.now, authorize } = {}) {
    this.config = config || hub?.config || {};
    this.hub = hub;
    this.plexAuth = plexAuth || hub?.plexAuth;
    this.registry = registry;
    this.now = now;
    this.authorize = authorize;
    /** @type {Map<string, Object>} */
    this.sessions = new Map();
    this.retiring = new Set();
    this.stopping = new Map();
    this.creating = new Map();
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
    const cred =
      identity &&
      (this.registry.credential
        ? this.registry.credential(identity.subject)
        : this.registry.hasCredential?.(identity.subject));
    return !!(cred && (typeof cred !== 'object' || cred.serverToken || cred.authType !== 'traditional'));
  }

  /**
   * @param {import('./types').Viewer|string} viewer
   * @returns {Object|undefined}
   */
  _findSession(viewer) {
    if (typeof viewer === 'string') return this.sessions.get(viewer);
    const found = this.sessions.get(viewer?.viewerId);
    if (found && (found === viewer || found.viewer === viewer)) return found;
    for (const session of this.sessions.values()) {
      if (session.viewer === viewer) return session;
    }
  }

  subject(userId) {
    return this.registry
      ? this.registry.identities(userId)?.find(i => i.provider === 'plex' && i.verified)?.subject
      : userId;
  }

  personal(scoped) {
    return scoped && scoped.principal !== 'discord-shared' && scoped.clientId !== 'configured-fallback';
  }

  current(context) {
    return (
      !this.closed &&
      (!context.room.viewers || context.room.viewers.get(context.viewerId) === context.viewer) &&
      context.viewer.userId === context.userId &&
      String(context.room.media?.id) === context.mediaId &&
      context.room.mediaVersion === context.mediaVersion &&
      context.viewer.streamVersion === context.streamVersion &&
      context.viewer.observationEpoch === context.observationEpoch &&
      context.viewer.plexReporting !== false
    );
  }

  occurrence(session, room, viewer) {
    return (
      session.room === room &&
      session.userId === viewer.userId &&
      session.mediaId === String(room.media?.id) &&
      session.mediaVersion === room.mediaVersion &&
      session.subject === this.subject(viewer.userId)
    );
  }

  // Reconnect authority comes from the room's saved, same-tab grace record,
  // never from matching a user/title or a client-supplied reporting ID.
  reconnect(room, viewer, saved) {
    const session = this.sessions.get(viewer.viewerId);
    if (!session) return;
    if (
      !saved ||
      saved.expires <= this.now() ||
      saved.userId !== viewer.userId ||
      saved.mediaVersion !== room.mediaVersion ||
      !this.occurrence(session, room, viewer) ||
      !session.suspendedUntil ||
      session.suspendedUntil <= this.now()
    ) {
      void this.stop(session);
      return;
    }
    session.viewer = viewer;
    session.generation++;
    session.desired = undefined;
    session.streamVersion = viewer.streamVersion;
    session.observationEpoch = viewer.observationEpoch;
  }

  present(session) {
    if (!this.occurrence(session, session.room, session.viewer)) return false;
    if (!session.room.viewers || session.room.viewers.get(session.viewerId) === session.viewer) return true;
    const saved = session.room.disconnectedViewers?.get(session.viewerId);
    return !!(
      session.suspendedUntil &&
      saved &&
      saved.expires > this.now() &&
      saved.userId === session.userId &&
      saved.mediaVersion === session.mediaVersion
    );
  }

  suspend(session, expires = session.suspendedUntil || this.now() + RECONNECT_GRACE_MS) {
    if (session.stopped) return;
    session.generation++;
    session.suspendedUntil = expires;
    session.lastState = 'buffering';
    session.lastReportedAt = this.now();
    return this.enqueue(session, { state: 'buffering', position: session.lastPositionMs, activityOnly: true });
  }

  // Called by the existing room sweep; no independent timer or persisted lease.
  refresh(room, now = this.now()) {
    for (const session of this.sessions.values()) {
      if (session.room !== room) continue;
      if (!this.present(session) || (session.suspendedUntil && session.suspendedUntil <= now)) {
        void this.stop(session);
        continue;
      }
      if (session.suspendedUntil && now - session.lastReportedAt >= 10000) {
        session.lastReportedAt = now;
        this.enqueue(session, { state: 'buffering', position: session.lastPositionMs, activityOnly: true });
      }
    }
  }

  endViewer(room, viewerId, reason) {
    const pending = this.creating.get(viewerId);
    if (pending?.context.room === room) pending.cancelled = true;
    const session = this.sessions.get(viewerId);
    if (session?.room === room) return this.stop(session);
  }

  endRoom(room) {
    for (const pending of this.creating.values()) if (pending.context.room === room) pending.cancelled = true;
    return Promise.allSettled([...this.sessions.values()].filter(s => s.room === room).map(s => this.stop(s)));
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
        this.discard(existing);
      }
      return;
    }

    if (viewer && !viewer.viewerId && viewerId) viewer.viewerId = viewerId;

    const allowActivity = viewer.plexReporting !== false;
    const allowWatchState = !!(viewer.plexWatchState && this.config.plexReporting?.watchState !== false);
    if (!allowActivity) {
      await this.endViewer(room, viewerId, 'opt-out');
      return;
    }

    // Occurrence identity survives transport replacement. Each accepted sample
    // still belongs to exactly one attachment, including across awaited setup.
    const context = {
      room,
      viewer,
      viewerId,
      userId: viewer.userId,
      mediaId: String(room.media.id),
      mediaVersion: room.mediaVersion,
      streamVersion: viewer.streamVersion,
      observationEpoch: viewer.observationEpoch,
    };
    let session = this.sessions.get(viewerId);
    if (session) {
      if (
        !this.occurrence(session, room, viewer) ||
        session.viewer !== viewer ||
        (session.suspendedUntil && session.suspendedUntil <= this.now())
      ) {
        await this.stop(session);
        session = undefined;
      }
    }

    if (!this.current(context)) return;

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
      let init = this.creating.get(viewerId);
      if (!init) {
        init = { context, cancelled: false };
        const pending = init;
        init.promise = (async () => {
          await this.stopping.get(viewerId);
          const plexAuth = this.plexAuth || this.hub?.plexAuth;
          const subject = this.subject(viewer.userId);
          let scoped;
          try {
            scoped = await plexAuth?.forUser(viewer.userId);
          } catch {
            return;
          }
          if (
            !this.personal(scoped) ||
            !this.isEligible(viewer.userId) ||
            this.subject(viewer.userId) !== subject ||
            pending.cancelled ||
            !this.current(context)
          )
            return;
          const baseClientId = scoped.clientId || 'uburoom-web-' + viewerId;
          const hasActiveTab = [...this.sessions.values()].some(
            s => !s.stopped && s.userId === viewer.userId && s.viewerId !== viewerId && s.clientId === baseClientId,
          );
          const clientId = hasActiveTab ? `${baseClientId}-${viewerId}` : baseClientId;
          const s = {
            sessionId: randomUUID(),
            clientId,
            userId: viewer.userId,
            viewerId,
            viewer,
            room,
            mediaId: context.mediaId,
            duration: room.media.duration,
            mediaVersion: context.mediaVersion,
            streamVersion: context.streamVersion,
            observationEpoch: context.observationEpoch,
            subject,
            server: scoped.base?.origin,
            generation: 0,
            consent: { activity: allowActivity, watchState: allowWatchState },
            scopedPlex: scoped,
            lastState: undefined,
            lastPositionMs: 0,
            lastReportPositionMs: 0,
            lastReportedAt: 0,
            dispatched: Promise.resolve(),
            stopped: false,
          };
          this.sessions.set(viewerId, s);
          return s;
        })().finally(() => {
          if (this.creating.get(viewerId) === pending) this.creating.delete(viewerId);
        });
        this.creating.set(viewerId, init);
      }
      session = await init.promise;
      if (!session || !this.current(context) || session.stopped || session.viewer !== viewer) return;
    }

    if (
      session.suspendedUntil ||
      session.streamVersion !== viewer.streamVersion ||
      session.observationEpoch !== viewer.observationEpoch
    ) {
      session.generation++;
      session.desired = undefined;
      session.suspendedUntil = undefined;
      session.streamVersion = viewer.streamVersion;
      session.observationEpoch = viewer.observationEpoch;
      session.lastState = undefined; // Report the new attachment immediately.
    }

    // Refresh consent if modified mid-session
    session.consent.activity = viewer.plexReporting !== false;
    session.consent.watchState = !!(viewer.plexWatchState && this.config.plexReporting?.watchState !== false);

    const stateChanged = reportedState !== session.lastState;
    const advanced = observed.credit?.reason === 'credited' || observed.credit?.reason === 'baseline';
    const elapsedMs = this.now() - session.lastReportedAt;
    const positionDeltaMs = Math.abs(currentMs - session.lastReportPositionMs);
    session.lastPositionMs = currentMs;

    let shouldReport = false;
    if (stateChanged) {
      shouldReport = true;
    } else if (reportedState === 'playing') {
      shouldReport = advanced && (elapsedMs >= 10000 || positionDeltaMs >= 15000);
    }

    if (!shouldReport) return;

    session.lastState = reportedState;
    session.lastReportPositionMs = currentMs;
    session.lastReportedAt = this.now();
    this.enqueue(session, { state: reportedState, position: currentMs });
  }

  // One in-flight request and one latest desired state. Payloads are built at
  // dispatch, never before an authorization/consent wait or as an unbounded log.
  enqueue(session, desired) {
    session.desired = { ...desired, generation: session.generation };
    if (session.dispatching) return session.dispatched;
    session.dispatching = true;
    session.dispatched = Promise.resolve()
      .then(() =>
        runOperation(undefined, async () => {
          while (session.desired) {
            const next = session.desired;
            session.desired = undefined;
            let scoped;
            try {
              scoped = await (this.plexAuth || this.hub?.plexAuth)?.forUser(session.userId);
            } catch {
              continue;
            }
            if (
              !this.personal(scoped) ||
              !this.isEligible(session.userId) ||
              session.subject !== this.subject(session.userId) ||
              session.server !== scoped.base?.origin
            ) {
              this.discard(session);
              break;
            }
            const terminal = next.state === 'stopped';
            if (!terminal && (session.stopped || next.generation !== session.generation)) continue;
            if (!terminal && this.authorize) {
              let allowed;
              try {
                allowed = await this.authorize(session.room, session.viewer);
              } catch {
                continue;
              }
              if (session.stopped || next.generation !== session.generation) continue;
              if (!allowed) {
                this.discard(session);
                break;
              }
            }
            if (
              !terminal &&
              (session.stopped ||
                next.generation !== session.generation ||
                !session.consent.activity ||
                session.viewer.plexReporting === false ||
                !this.present(session) ||
                (next.activityOnly
                  ? !session.suspendedUntil || session.suspendedUntil <= this.now()
                  : session.viewer.streamVersion !== session.streamVersion ||
                    session.viewer.observationEpoch !== session.observationEpoch))
            )
              continue;
            if (
              session.subject !== this.subject(session.userId) ||
              session.server !== scoped.base?.origin ||
              !this.isEligible(session.userId)
            ) {
              this.discard(session);
              break;
            }
            const identity = mediaIdentity(session.mediaId);
            if (!identity?.ratingKey) continue;
            const query = new URLSearchParams({
              key: '/library/metadata/' + identity.ratingKey,
              ratingKey: identity.ratingKey,
              identifier: 'com.plexapp.plugins.library',
              state: next.state,
              time: String(next.position),
              continuing: '0',
            });
            if (
              !next.activityOnly &&
              session.consent.watchState &&
              session.viewer.plexWatchState &&
              this.config.plexReporting?.watchState !== false &&
              Number.isFinite(session.duration) &&
              session.duration > 0
            )
              query.set('duration', String(Math.round(session.duration * 1000)));
            try {
              await scoped.request('/:/timeline?' + query, {
                method: 'POST',
                signal: AbortSignal.timeout(12000),
                headers: {
                  'X-Plex-Client-Identifier': session.clientId,
                  'X-Plex-Session-Identifier': session.sessionId,
                },
              });
            } catch (error) {
              if ([401, 403, 498].includes(error?.status)) {
                this.discard(session);
              }
            }
          }
        }),
      )
      .finally(() => {
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
   * Classify lifecycle changes centrally. Recoverable changes suspend the
   * occurrence; terminal teardown never uses the shared producer's identity.
   * @param {import('./types').Viewer|string} viewer
   * @param {string} [reason]
   */
  async end(viewer, reason) {
    const session = this._findSession(viewer);
    if (RECOVERABLE.has(reason) && session) return this.suspend(session);
    if (reason === 'disconnected' && session) {
      const saved = session.room.disconnectedViewers?.get(session.viewerId);
      if (saved?.userId === session.userId && saved.mediaVersion === session.mediaVersion && saved.expires > this.now())
        return this.suspend(session, saved.expires);
    }
    const pending = this.creating.get(typeof viewer === 'string' ? viewer : viewer?.viewerId);
    if (pending && (typeof viewer === 'string' || pending.context.viewer === viewer)) pending.cancelled = true;
    return this.stop(session);
  }

  discard(session) {
    session.stopped = true;
    session.desired = undefined;
    if (this.sessions.get(session.viewerId) === session) this.sessions.delete(session.viewerId);
  }

  async stop(session) {
    if (!session || session.stopped) return;
    const activityOnly = !!session.suspendedUntil;
    this.discard(session);

    const retired = this.enqueue(session, { state: 'stopped', position: session.lastPositionMs || 0, activityOnly });
    this.retiring.add(retired);
    this.stopping.set(session.viewerId, retired);
    try {
      await retired;
    } finally {
      this.retiring.delete(retired);
      if (this.stopping.get(session.viewerId) === retired) this.stopping.delete(session.viewerId);
    }
  }

  /**
   * Close all active reporting sessions cleanly.
   */
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.creating.values()].map(init => init.promise));
    const pending = [...this.sessions.values()].map(session => this.stop(session));
    await Promise.allSettled([...pending, ...this.retiring]);
  }
}

module.exports = { PlexReporting };
