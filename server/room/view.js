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
const { isHost, sameVoice, canWatch } = require('../core');
const Tracks = require('../media-tracks');
const RoomPolicy = require('../room-policy');
const {
  aggregateParticipantSyncQuality: syncQualityParticipants,
  timelinePosition,
  controlLead,
  settleRoomTimeline,
  snapshotReadiness,
} = require('../../shared/sync');
const { REJOIN, formatEntrySubtitle } = require('./common');

// A number for each object, so a stamp can tell one stream record from its replacement.
const references = new WeakMap();
let referenceCount = 0;
const reference = value => {
  if (!value || typeof value !== 'object') return value;
  if (!references.has(value)) references.set(value, ++referenceCount);
  return references.get(value);
};

/**
 * The room as each tab sees it: the lobby list, the per-tab view and its timeline projection.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  position(room, now = this.clock.now()) {
    return timelinePosition(room, now);
  },
  controlLead(room) {
    return controlLead(room);
  },
  settle(room, now = this.clock.now()) {
    settleRoomTimeline(room, now);
  },
  // The timeline as the room's next lifecycle review would settle it at `now`,
  // worked out on a copy so that looking at a room never moves it. Like the review,
  // it leaves a room whose durable transition is still committing as it is.
  projectTimeline(room, now = this.clock.now()) {
    if (room.transition?.commit) return room;
    const copy = { ...room, state: { ...room.state } };
    this.settle(copy, now);
    copy.state.waitingForReady = copy.initialGate && !copy.manualPaused && !copy.readinessTimedOut;
    copy.state.position = this.position(copy, now);
    copy.state.duration = copy.media?.duration || 0;
    return copy;
  },
  /**
   * The synchronous part of canView for a viewer's published state. The asynchronous
   * part (membership refresh, Plex item access) comes from the viewer's last check,
   * which their presence keeps current; a viewer's state never waits on Plex for it.
   */
  canSee(room, actor, viewer) {
    if (!room || this.rooms.get(room.roomId) !== room) return false;
    if (room.frozen && actor.userId !== room.hostId) return false;
    if (!canWatch(this.hub.access, actor.userId, actor) && !(viewer?.access?.ok && viewer.access.media === room.media))
      return false;
    if (room.media?.kind === 'plex' && viewer?.access?.media === room.media && !viewer.access.ok) return false;
    return this.hub.authorize(actor, room, 'room.view').ok;
  },
  // Room access with the asynchronous provider checks authorize() leaves out:
  // membership refresh and personal Plex access to the current item.
  async canView(room, actor) {
    if (!room || this.rooms.get(room.roomId) !== room) return false;
    // A frozen room is its host's alone until it wakes or closes.
    if (room.frozen && actor.userId !== room.hostId) return false;
    if (!canWatch(this.hub.access, actor.userId, actor)) {
      try {
        if (!(await this.hub.admit(actor.userId, actor))) return false;
      } catch (error) {
        if (!this.retainedThroughOutage(room, actor, error)) return false;
      }
    }
    if (room.media?.kind === 'plex') {
      try {
        const allowed = await (await this.hub.plexFor(actor)).allows(room.media.id);
        this.providerResponded();
        if (!allowed) return false;
      } catch (error) {
        if (!this.retainedThroughOutage(room, actor, error)) return false;
      }
    }
    return this.hub.authorize(actor, room, 'room.view').ok;
  },
  async list(actor, activity = false) {
    const rooms = [];
    // Listing rooms only reads them; the server's sweep keeps their lifecycle.
    for (const room of this.rooms.values()) {
      const accessible = await this.canView(room, actor);
      if (!accessible && !(activity && room.visibility === 'private' && sameVoice(room, actor, this.hub.access)))
        continue;
      const members = [...new Map([...room.viewers.values()].map(v => [v.userId, v.name])).values()];
      rooms.push({
        maxMembers: Math.min(
          room.saved.maxMembers || this.roomState.limits.maxMembers,
          this.roomState.limits.maxMembers,
        ),
        id: room.roomId,
        name: accessible ? room.name : undefined,
        slug: accessible ? room.slug || room.saved.slug : undefined,
        hostName: room.hostName,
        visibility: room.visibility,
        viewers: members.length,
        ...(accessible
          ? { title: room.media?.title || '', members, canManage: this.hub.authorize(actor, room, 'roomSettings').ok }
          : { locked: true }),
      });
    }
    if (this.roomState)
      for (const [id, recovery] of this.roomState.recoveries) {
        if (this.rooms.has(id) || recovery.until <= this.clock.now()) continue;
        const record = this.roomState.store.get(id);
        if (!this.hub.authorize(actor, record, 'room.view').ok) continue;
        if (record.bookmark) {
          try {
            if (!(await (await this.hub.plexFor(actor)).allows(record.bookmark.mediaId))) continue;
          } catch {
            continue;
          }
        }
        rooms.push({
          id,
          name: record.name,
          slug: record.slug,
          visibility: record.visibility,
          hostName: this.roomState.registry.canonical(record.creatorId)?.name,
          title: record.bookmark?.title || '',
          viewers: 0,
          members: [],
          recovering: true,
          maxMembers: Math.min(record.maxMembers || this.roomState.limits.maxMembers, this.roomState.limits.maxMembers),
        });
      }
    return rooms;
  },
  /**
   * The version of a room's shared lane: it rises with every change the room's
   * subscribers should see, and never repeats, not even across a room's reopening.
   * The count belongs to publication, not to the room.
   */
  roomVersion(room) {
    return this.roomVersions.get(room) || 0;
  },
  /**
   * Publishes a change: the room's subscribers are sent its lanes again, and with
   * `lobby` (or no room) every connection is sent the lobby.
   * @param {any} [room]
   * @param {{lobby?: boolean}} [scope]
   */
  changed(room, { lobby = false } = {}) {
    this.announce(room, room && !lobby ? { roomId: room.roomId, includeLobby: false } : { includeLobby: true });
  },
  // Every publication passes here: the room's version rises before its subscribers are woken.
  announce(room, change) {
    if (room) this.roomVersions.set(room, ++this.publicationCount);
    this.onPublish?.(room, change);
  },
  /** Identifies what the lobby lists for a room: its name, video, visibility, host and who is in it. */
  lobbyStamp(room) {
    return [
      room.name,
      room.slug,
      room.visibility,
      room.hostName,
      room.media?.title,
      !!room.frozen,
      !!room.closed,
      [...new Set([...room.viewers.values()].map(viewer => viewer.userId + ':' + viewer.name))].join(','),
    ].join('|');
  },
  /**
   * Identifies the state of one tab's own lane (its stream, tracks and settings). The
   * lane is sent again when this differs from what the tab was last sent.
   */
  viewerStamp(room, viewer) {
    const media = viewer.media,
      fallback = this.fallbackFor(room, viewer);
    return [
      room.mediaVersion,
      viewer.streamVersion,
      viewer.observationEpoch,
      viewer.quality,
      viewer.preferredQuality,
      viewer.volume,
      viewer.muted,
      viewer.subtitleOffset,
      viewer.plexReporting,
      viewer.plexWatchState,
      viewer.localDelivery,
      viewer.directProxyVersion,
      JSON.stringify(viewer.trackChoice),
      (viewer.unavailableMedia || []).map(item => item.id).join(','),
      reference(media),
      media?.format,
      media?.playbackError,
      media?.captionVersion,
      media?.bootstrapFallback,
      media?.qualityNotice,
      reference(media?.selection),
      reference(fallback),
    ].join('|');
  },
  // Fetches the ending card's details an empty room needs. Triggered by joins and
  // by media and queue changes (prepareStreams), never by looking at the room.
  requestEndingMeta(room) {
    if (room.media || room.refreshingEndingMeta) return;
    const queueSummary = this.roomState.queue.summary(room.roomId);
    const completed = queueSummary?.lastHistory;
    const next =
      queueSummary?.next ||
      (queueSummary?.autoQueue?.next
        ? { ...queueSummary.autoQueue.next, id: 'auto:' + queueSummary.autoQueue.next.mediaId }
        : null);
    const endingOffer =
      room.endingOffer?.key === completed?.id + ':' + queueSummary?.queueRevision ? room.endingOffer.offer : null;
    if (!(completed || next || endingOffer)) return;
    const needsOffer =
      !next &&
      completed?.type === 'episode' &&
      queueSummary.autoQueue.mode === 'off' &&
      room.endingOffer?.key !== completed?.id + ':' + queueSummary?.queueRevision;
    const needsSummary = next && !room.endingMeta?.has(next.mediaId);
    if (needsOffer || needsSummary) void this.refreshEndingMeta(room);
  },
  /**
   * What one tab in the room sees. A pure projection: it never joins anyone,
   * refreshes presence or otherwise changes the room.
   * @param {any} room
   * @param {Actor} actor
   * @param {string} viewerId
   */
  view(room, actor, viewerId, now = this.clock.now()) {
    if (this.shuttingDown || room.closed || this.rooms.get(room.roomId) !== room) throw new Error('Room unavailable');
    const viewer = room.viewers.get(viewerId);
    if (!viewer) throw Object.assign(new Error(REJOIN), { status: 409 });
    if (viewer.userId !== actor.userId) throw new Error('Viewer identity mismatch');
    const owner = this.hub.authorize(actor, room, 'roomSettings').ok;
    const timeline = this.projectTimeline(room, now);
    const participants = syncQualityParticipants(room, this.roomState.participants(room.roomId), now);
    // Health details (buffer, stalls, device) are for the people who run the room.
    if (!owner)
      for (const person of participants)
        for (const session of person.syncQuality?.sessions || []) delete session.health;
    const { waitingForReady, readiness } = snapshotReadiness(timeline);
    return {
      id: room.roomId,
      epoch: room.epoch,
      revision: timeline.revision,
      mediaVersion: room.mediaVersion,
      serverNow: now,
      plexReporting: {
        eligible: !!this.reporting?.isEligible(actor.userId),
        activity: viewer.plexReporting !== false,
        watchState: !!(viewer.plexWatchState && this.hub?.config?.plexReporting?.watchState !== false),
        watchStateAllowed: this.hub?.config?.plexReporting?.watchState !== false,
      },
      // Everyone in the room may share its invite.
      invite: room.inviteCode
        ? { code: room.inviteCode, url: this.hub.config.publicUrl + '/join/' + room.inviteCode }
        : undefined,
      startAt: timeline.startAt,
      pauseAt: timeline.pauseAt,
      title: room.media?.title || 'Choose something to watchâ€¦',
      subtitle: room.media?.subtitle || '',
      mediaId: room.media?.id,
      chapters: room.media?.chapters || [],
      markers: room.media?.markers || [],
      observationEpoch: viewer.observationEpoch,
      format: viewer.media?.format,
      quality: room.media?.kind === 'demo' ? 'direct' : viewer.quality,
      videoCodec: viewer.media?.videoCodec,
      compatible: !!viewer.media?.compatible,
      streamVersion: viewer.streamVersion,
      audioCodec: viewer.media?.audioCodec,
      bitrate: viewer.media?.bitrate,
      bitrateCeiling: viewer.media?.bitrateCeiling,
      hdr: !!viewer.media?.hdr,
      hdrKind: viewer.media?.hdrKind || 'sdr',
      hdrLabel: viewer.media?.hdrLabel || 'SDR',
      doviProfile: viewer.media?.doviProfile ?? null,
      bitDepth: viewer.media?.bitDepth || 8,
      mediaError: viewer.media?.playbackError,
      unavailableMedia: viewer.unavailableMedia || [],
      providerNotice: this.providerNotice(room),
      qualityNotice: viewer.media?.qualityNotice,
      preferredQuality: viewer.preferredQuality,
      deliveryInfo: viewer.media
        ? {
            format: viewer.media.format,
            reason: viewer.media.deliveryReason,
            videoCodec: viewer.media.videoCodec,
            audioCodec: viewer.media.audioCodec,
            hdr: !!viewer.media.hdr,
            hdrKind: viewer.media.hdrKind || 'sdr',
            hdrLabel: viewer.media.hdrLabel || 'SDR',
            sourceHdr: !!viewer.media.sourceHdr,
            sourceHdrKind: viewer.media.sourceHdrKind || 'sdr',
            sourceHdrLabel: viewer.media.sourceHdrLabel || 'SDR',
            toneMapped: !!(viewer.media.sourceHdr && viewer.media.format !== 'file'),
            videoDecision: viewer.media.output?.videoDecision,
            audioDecision: viewer.media.output?.audioDecision,
            width: viewer.media.output?.width,
            height: viewer.media.output?.height,
            bitrate: viewer.media.bitrate,
            bitrateCeiling: viewer.media.bitrateCeiling,
            encoder: viewer.media.av1Lease?.group.encoder,
            cpuFallback: !!viewer.media.av1Lease?.group.cpuFallback,
          }
        : undefined,
      ...(viewer.media?.tracks
        ? {
            tracks: {
              ...Tracks.publicCatalog(viewer.media.tracks),
              audioChoice: viewer.trackChoice?.audioId || 'auto',
              subtitleChoice: viewer.trackChoice?.subtitleId || 'auto',
              audioId: viewer.media.selection.audio?.id,
              subtitleId: viewer.media.selection.subtitle?.id,
              subtitleOffset: viewer.subtitleOffset || 0,
              subtitleDelivery: viewer.media.selection.subtitle?.delivery,
              subtitleMode: viewer.trackChoice?.subtitleMode || 'auto',
              subtitleError:
                viewer.media.selection.subtitle && !viewer.media.selection.subtitle.available
                  ? viewer.media.selection.subtitle.reason
                  : undefined,
            },
          }
        : {}),
      qualities: this.plex.qualities?.(room.media) || Engine.QUALITIES,
      ...(() => {
        const queueSummary = this.roomState.queue.summary(room.roomId);
        const completed = queueSummary?.lastHistory;
        const next =
          queueSummary?.next ||
          (queueSummary?.autoQueue?.next
            ? { ...queueSummary.autoQueue.next, id: 'auto:' + queueSummary.autoQueue.next.mediaId, source: 'auto' }
            : null);
        const endingOffer =
          room.endingOffer?.key === completed?.id + ':' + queueSummary?.queueRevision ? room.endingOffer.offer : null;
        const hasInterstitial = !room.media && !!(completed || next || endingOffer);
        const ending = hasInterstitial
          ? {
              state: room.autoplayCountdown ? 'countdown' : next ? 'upNext' : endingOffer ? 'offer' : 'finished',
              completed: completed
                ? {
                    entryId: completed.id,
                    mediaId: completed.mediaId,
                    type: completed.type,
                    title: completed.title,
                    subtitle: formatEntrySubtitle(completed),
                    outcome: completed.outcome,
                  }
                : null,
              next: next
                ? {
                    entryId: next.id,
                    mediaId: next.mediaId,
                    type: next.type,
                    title: next.title,
                    subtitle: room.endingMeta?.get(next.mediaId)?.subtitle || formatEntrySubtitle(next),
                    duration: next.duration,
                    summary: room.endingMeta?.get(next.mediaId)?.summary || '',
                    hasLandscape: Boolean(room.endingMeta?.get(next.mediaId)?.hasLandscape ?? next.hasLandscape),
                    hasPoster: Boolean(room.endingMeta?.get(next.mediaId)?.hasPoster ?? next.hasPoster),
                    source:
                      next.provenance === 'following' ||
                      next.provenance === 'random' ||
                      next.provenance === 'continue' ||
                      next.source === 'auto'
                        ? 'auto'
                        : 'queue',
                  }
                : endingOffer
                  ? {
                      ...endingOffer,
                      source: 'offer',
                    }
                  : null,
              countdown: room.autoplayCountdown
                ? {
                    id: room.autoplayCountdown.id,
                    startedAt: room.autoplayCountdown.startedAt,
                    durationMs: room.autoplayCountdown.durationMs,
                    endsAt: room.autoplayCountdown.endsAt,
                  }
                : null,
              error: room.autoplayError || room.autoQueueError || null,
            }
          : null;
        return {
          hasPrevious: this.position(timeline, now) >= 5 || (queueSummary?.historyCount || 0) > 0,
          hasNext: !!(queueSummary?.next || queueSummary?.autoQueue?.next),
          queueSummary,
          ending,
        };
      })(),
      autoplay: {
        enabled: this.roomState.store.get(room.roomId).autoplay,
        countdown: room.autoplayCountdown
          ? {
              id: room.autoplayCountdown.id,
              title: room.autoplayCountdown.title,
              endsAt: room.autoplayCountdown.endsAt,
            }
          : null,
        error: room.autoplayError || room.autoQueueError,
      },
      readinessVersion: room.readinessVersion,
      waitingForReady,
      readiness,
      recovery: this.roomState.recoveryState(room),
      maxMembers: Math.min(room.saved.maxMembers || this.roomState.limits.maxMembers, this.roomState.limits.maxMembers),
      roomName: room.name,
      slug: room.slug || room.saved.slug,
      durable: true,
      roomRole: RoomPolicy.role(room, actor.userId),
      saveError: room.saveError,
      waitingForHost: !!room.waitingForHost,
      participants,
      // The room's viewer spread, for the people who run it. Self-reported; see sync quality.
      syncSpread: owner && room.syncSpread?.summary ? { ...room.syncSpread.summary } : undefined,
      allHosts: !!room.permissions?.allHosts,
      hostPermissions: { ...room.permissions.host },
      participantPermissions: { ...room.permissions.viewer },
      capabilities: Object.fromEntries(
        [...RoomPolicy.CAPABILITIES, 'managePermissions', 'manageHosts'].map(key => [
          key,
          this.hub.authorize(actor, room, key).ok,
        ]),
      ),
      hostName: room.hostName,
      canBrowse: true,
      isHost: isHost(room, actor),
      adminMode: this.hub.isAdmin(actor),
      state: Engine.snapshot({ ...timeline.state, volume: viewer.volume, muted: viewer.muted }),
      canManage: owner,
      visibility: room.visibility,
      canPlayback: this.hub.authorize(actor, room, 'media.play').ok,
      viewers: new Set([...room.viewers.values()].map(x => x.userId)).size,
      feedback: room.feedback,
    };
  },
};
