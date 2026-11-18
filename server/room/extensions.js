// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const Engine = require('../../shared/engine.mjs');
const { RoomAuthority, beginReadiness, invalidateEpoch } = require('../../shared/sync');
const { ROOM_KEYS, PERSONAL_KEYS, ACCESS_RECHECK_MS } = require('./common');

/**
 * The server's hooks into the room core (shared/sync/room-authority.mjs): its fields, lifecycle hooks and presence events.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  beginReadiness(room, now = this.clock.now(), waitMs = 10000) {
    beginReadiness(room, now, waitMs);
    this.coordinator.schedule(room);
  },
  invalidateControls(room) {
    this.cancelAutoplay(room);
    invalidateEpoch(room);
  },
  /** Rechecks a room's lifecycle after a change made outside its mailbox (a command, new media). */
  review(room) {
    if (this.rooms.get(room.roomId) !== room) return;
    return this.coordinator.run(room, { type: 'review' });
  },
  /** A validated observation can hold the shared timeline only for the stream that reported it. */
  async holdForBuffering(room, viewer, data) {
    const { viewerId, epoch, mediaVersion, streamVersion, observationEpoch, observedAt, sequence } = data;
    await this.inRoom(room, () => {
      if (
        !(room.saved.pauseOnBuffering ?? this.hub.config.pauseOnBuffering) ||
        room.transition ||
        room.epoch !== epoch ||
        room.mediaVersion !== mediaVersion ||
        observedAt < Math.max(room.changedAt, room.startAt || 0) ||
        room.viewers.get(viewerId) !== viewer ||
        viewer.streamVersion !== streamVersion ||
        viewer.observationEpoch !== observationEpoch ||
        viewer.observationSequence !== sequence ||
        !this.canSee(room, viewer.actor, viewer)
      )
        return;
      const now = this.clock.now();
      const active = [...room.viewers.entries()]
        .filter(([, tab]) => {
          const report = tab.tracking?.previous;
          return (
            report?.state === 'playing' &&
            report.epoch === epoch &&
            report.mediaVersion === mediaVersion &&
            report.streamVersion === tab.streamVersion &&
            now - tab.tracking.lastObservedServerAt <= 3000
          );
        })
        .map(([id]) => id);
      if (RoomAuthority.pauseForBuffering(room, viewerId, active, now)) this.review(room);
    });
  },
  /** The server's part of the room core: its own plain fields and lifecycle hooks. */
  roomExtensions() {
    return {
      roomKeys: ROOM_KEYS,
      viewerKeys: PERSONAL_KEYS,
      displayName: actor => Engine.senderName(actor.name),
      // Only personal playback settings survive a short reconnect; streams and observations never do.
      retain: viewer => ({
        trackChoice: viewer.trackChoice && { ...viewer.trackChoice },
        subtitleOffset: viewer.subtitleOffset,
        quality: viewer.quality,
        preferredQuality: viewer.preferredQuality,
        compatible: viewer.compatible,
        fallback: viewer.fallback,
        volume: viewer.volume,
        muted: viewer.muted,
        plexReporting: viewer.plexReporting,
        plexWatchState: viewer.plexWatchState,
        browserLoginHash: viewer.browserLoginHash,
        directProxyVersion: viewer.directProxyVersion,
        browserSubtitles: viewer.browserSubtitles,
        localCodecs: viewer.localCodecs,
        localDelivery: viewer.localDelivery,
      }),
      /** @type {(saved: any, event: {quality?: string | null, preferences?: any}) => any} */
      admit: (saved, { quality = '720p', preferences = {} }) => ({
        quality: saved?.quality || (Engine.validQuality(quality) ? quality : '720p4'),
        preferredQuality:
          saved?.preferredQuality || (Engine.validQuality(quality) ? Engine.qualityId(quality) : '720p4'),
        volume: saved?.volume ?? preferences.volume ?? 30,
        muted: saved?.muted ?? preferences.muted ?? false,
        plexReporting: saved?.plexReporting ?? preferences.plexReporting ?? true,
        plexWatchState: saved?.plexWatchState ?? preferences.plexWatchState ?? false,
        trackChoice: saved?.trackChoice ?? preferences.trackChoice,
        subtitleOffset: saved?.subtitleOffset,
        compatible: saved?.compatible,
        fallback: saved?.fallback,
        directProxyVersion: saved?.directProxyVersion,
        browserSubtitles: saved?.browserSubtitles,
        localCodecs: saved?.localCodecs,
        localDelivery: saved?.localDelivery ?? false,
      }),
      capacity: (room, userId) => {
        try {
          this.roomState.checkCapacity(room, userId);
        } catch (error) {
          return { message: error.message, status: error.status };
        }
      },
      recoveryReady: room => this.roomState.recoveryReady(room),
      countdownViewer: room => room.autoplayCountdown?.viewerId,
      starting: room => {
        room.endedVersion = undefined;
      },
      renamed: (room, userId, name) => {
        if (room.ownerId === userId) room.ownerName = name;
      },
    };
  },
  /**
   * A tab's own presence (its clock exchanges and pongs) keeps it in the room and
   * re-checks, every few seconds and off the publication path, the media access its
   * published state relies on.
   */
  touch(room, viewer, rtts) {
    if (this.rooms.get(room.roomId) !== room || room.viewers.get(viewer.viewerId) !== viewer) return;
    this.coordinator.run(room, { type: 'touch', viewerId: viewer.viewerId, rtts });
    if (viewer.accessChecking || this.clock.now() - (viewer.access?.at ?? -Infinity) < ACCESS_RECHECK_MS) return;
    viewer.accessChecking = true;
    void this.checkAccess(room, viewer).finally(() => {
      viewer.accessChecking = false;
    });
  },
  /** Records whether `viewer` may still see the room's current media (membership and provider item access). */
  async checkAccess(room, viewer) {
    const media = room.media,
      at = this.clock.now(),
      ok = await this.canView(room, viewer.actor);
    if (room.media === media) viewer.access = { media, at, ok };
    return ok;
  },
  /** Rechecks every room after a change to who someone is or what they may do (Admin mode). */
  identityChanged() {
    for (const room of [...this.rooms.values()]) this.review(room);
  },
  /** A person's display name changed. */
  renamed(userId, name) {
    for (const room of [...this.rooms.values()]) this.coordinator.run(room, { type: 'identity', userId, name });
  },
};
