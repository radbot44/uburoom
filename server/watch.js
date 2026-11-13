// @ts-check
'use strict';
/** @typedef {import('./types').Room} Room */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('./fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { MediaChecks } = require('./media-check');
const { FallbackStream } = require('./fallback-stream');
const { SharedTask, currentSignal, runOperation, waitFor } = require('./operation');
const { isProviderOutage } = require('./resilience');
const { randomUUID } = require('node:crypto');
const Engine = require('../shared/engine');
const { isHost, sameVoice, canWatch } = require('./core');
const { PlaybackError } = require('./av1');
const { PlaybackTracking } = require('./playback-tracking');
const { PlexReporting } = require('./plex-reporting');
const Tracks = require('./media-tracks');
const SubtitleResources = require('./subtitle-resources');
const { WatchRooms } = require('./watch-rooms');
const RoomPolicy = require('./room-policy');
const { observePlaybackEnd, clearPlaybackEnd } = require('./playback-end');
const {
  aggregateParticipantSyncQuality: syncQualityParticipants,
  timelinePosition,
  controlLead,
  beginReadiness,
  settleRoomTimeline,
  invalidateEpoch,
  snapshotReadiness,
  applyReadinessDecision,
  applyTimelineCommand,
  createServerClock,
  createRoomCoordinator,
} = require('../shared/sync');

// A tab the room let go of (privacy, presence timeout) must join again; looking never readmits it.
const REJOIN = 'You are no longer in this room; join again';
// Plain room and viewer fields the room core manages beyond its own (see ROOM_STATE_KEYS).
const ROOM_KEYS = ['saved', 'ownerId', 'ownerName', 'autoplayCountdown', 'endedVersion'];
const PERSONAL_KEYS = [
  'quality',
  'preferredQuality',
  'volume',
  'muted',
  'plexReporting',
  'plexWatchState',
  'trackChoice',
  'subtitleOffset',
  'compatible',
  'fallback',
  'directProxyVersion',
  'browserSubtitles',
  'localCodecs',
  'localDelivery',
  'browserLoginHash',
];
// The access a viewer's republish relies on is rechecked this often from their own presence.
const ACCESS_RECHECK_MS = 3000;
// A stream that keeps a Plex transcode open is pinged this often.
const TRANSCODE_PING_MS = 15000;

function formatEntrySubtitle(entry) {
  if (!entry) return '';
  if (entry.subtitle) return entry.subtitle;
  if (entry.type === 'episode') {
    return [entry.grandparentTitle, entry.parentTitle].filter(Boolean).join(' Â· ');
  }
  return entry.parentTitle || '';
}

class Watch {
  constructor(hub, plex, demoMedia, registry, plexAuth) {
    // Room timelines and every in-memory deadline read this clock, never Date.now() (stored and external times excepted).
    this.clock = hub?.clock || createServerClock();
    this.tracking = new PlaybackTracking(registry);
    this.hub = hub;
    this.plex = plex;
    this.demoMedia = demoMedia;
    // The one room registry. Presence, readiness, the automatic start and every room
    // lifecycle deadline are events in each room's mailbox (shared/sync/room-authority.mjs).
    this.coordinator = createRoomCoordinator({
      authorize: (actor, room, action) => this.hub.authorize(actor, room, action),
      now: () => this.clock.now(),
      monoNow: () => performance.now(),
      // Lifecycle deadlines are acted on at one-second resolution from startup.
      timerResolutionMs: 1000,
      timerOrigin: this.clock.now(),
      // A durable queue transition owns the room until its write is confirmed (A3.5 removes this).
      hold: room => !!room.transition?.commit,
      extensions: this.roomExtensions(),
      onEffect: (room, effect, removed) => this.roomEffect(room, effect, removed),
      onError: error =>
        this.hub?.config?.logger?.warn(
          'Room',
          'Room effect failed: ' + (error instanceof Error ? error.message : String(error)),
        ),
    });
    this.rooms = this.coordinator.rooms;
    /** @type {WeakMap<Room, number>} */
    this.stateSequences = new WeakMap();
    this.reporting = new PlexReporting({
      config: hub?.config,
      hub,
      plexAuth,
      registry,
      now: () => this.clock.now(),
      authorize: async (room, viewer) => {
        const authenticated = viewer.reportingAuthorized || viewer.alive;
        return (!authenticated || (await authenticated())) && (await this.canView(room, viewer.actor));
      },
    });
    this.roomState = new WatchRooms(this, registry);
    this.publications = new (require('./discord-publications').DiscordPublications)(this, registry);
    this.events = new (require('./room-events').RoomEvents)(this, registry);
    hub.publicationExecute = this.publications
      ? (id, actor, permitted) => this.publications.command(this.rooms.get(id), 'room.publish', actor, permitted)
      : undefined;
    hub.savedPublicationExecute = this.publications
      ? (id, actor, permitted) => this.publications.removeSaved(id, actor, permitted)
      : undefined;
    hub.scheduledEventExecute = this.events
      ? (id, command, actor, permitted) => this.events.command(id, command, actor, permitted)
      : undefined;
    hub.savedQueueExecute = (id, command, actor, permitted) => this.queueCommand(id, command, actor, permitted);
    hub.watchIdle = id => !this.rooms.get(id)?.media && !this.roomState.queue.current(id);
    this.autoplayDelayMs = 10000;
    /** @type {Set<MediaWork>} */
    this.mediaWork = new Set();
    this.mediaDrainMs = 35000;
    this.providerDownSince = undefined;
    this.providerRecoveredAt = 0;
    this.mediaChecks = new MediaChecks({ plex, config: hub?.config || {}, sessions: () => this.plexSessions });
    /** @type {InstanceType<typeof import('./plex-delivery').PlexDelivery> | undefined} Attached by server/watch-http.js. */
    this.delivery = undefined;
  }
  providerFailed(error) {
    if (!isProviderOutage(error)) return false;
    this.providerDownSince ??= this.clock.now();
    return true;
  }
  providerResponded() {
    if (this.providerDownSince === undefined) return;
    this.providerDownSince = undefined;
    this.providerRecoveredAt = this.clock.now();
  }
  // A viewer already watching keeps their place while Plex cannot answer. Nobody
  // new is admitted, and the next answer from Plex applies any real denial.
  retainedThroughOutage(room, actor, error) {
    if (!this.providerFailed(error)) return false;
    return [...room.viewers.values(), ...room.disconnectedViewers.values()].some(
      viewer => viewer.userId === actor.userId,
    );
  }
  // Silent unless someone is actually affected, including while recovering after Plex returns.
  providerNotice(room) {
    if (this.providerDownSince === undefined && this.clock.now() - this.providerRecoveredAt >= 60000) return false;
    // A viewer retrying delivery reports seeking; a brief healthy seek stays below the client's delay.
    return [...room.viewers.values()].some(
      viewer =>
        ['buffering', 'seeking', 'starting', 'error'].includes(viewer.syncQuality?.status) ||
        viewer.media?.playbackError ||
        (room.media && !viewer.media),
    );
  }
  create(actor, visibility = 'public', saved) {
    if (this.shuttingDown) throw new Error('Server is closing');
    if (!['public', 'private'].includes(visibility)) throw new Error('Invalid room visibility');
    if (!canWatch(this.hub.access, actor.userId, actor))
      throw new Error('Only authenticated eligible users can create a viewing room');
    if (
      this.rooms.size >= require('./room-limits').limits(this.hub.config).maxOpen &&
      !this.roomState.recoveries.has(saved.id)
    )
      throw new Error('Close an existing viewing room first');
    const id = saved.id;
    const slug =
      saved.slug ||
      (saved.name
        ? require('../web/ubumfa').slugify(saved.name)
        : require('../web/ubumfa').generateWord(6).toLowerCase());
    const room = {
      roomId: id,
      epoch: randomUUID(),
      ownerId: actor.userId,
      ownerName: actor.name,
      hostId: actor.userId,
      hostName: actor.name,
      visibility,
      slug,
      ubumfaWord: saved.ubumfaWord || slug,
      state: {
        paused: true,
        muted: false,
        volume: 30,
        seekable: false,
      },
      media: null,
      mediaVersion: randomUUID(),
      revision: 0,
      position: 0,
      changedAt: this.clock.now(),
      viewers: new Map(),
      disconnectedViewers: new Map(),
      kickedViewers: new Map(),
      lastActivity: this.clock.now(),
      initialGate: false,
      manualPaused: false,
      initialViewers: new Set(),
      hadViewers: false,
    };
    room.execute = (command, actor, permitted) => this.execute(room, command, actor, permitted);
    this.roomState.apply(room, saved);
    this.coordinator.add(room);
    this.hub.rooms.set(id, room);
    this.hub?.config?.logger?.info('Room', `Room created (${id}) by ${actor.name || actor.userId}`);
    return id;
  }
  position(room, now = this.clock.now()) {
    return timelinePosition(room, now);
  }
  controlLead(room) {
    return controlLead(room);
  }
  beginReadiness(room, now = this.clock.now(), waitMs = 10000) {
    beginReadiness(room, now, waitMs);
    this.coordinator.schedule(room);
  }
  settle(room, now = this.clock.now()) {
    settleRoomTimeline(room, now);
  }
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
  }
  invalidateControls(room) {
    this.cancelAutoplay(room);
    invalidateEpoch(room);
  }
  dropMedia(room, reason = 'media-changed') {
    void this.reporting?.endRoom(room);
    room.fallbackStream?.close();
    room.fallbackStream = undefined;
    this.cancelAutoplay(room);
    clearPlaybackEnd(room);
    room.disconnectedViewers.clear();
    for (const viewer of room.viewers.values()) {
      viewer.preparing?.abort();
      this.tracking.end(viewer, reason);
      void this.stopMedia(room, viewer.media);
      void this.reporting?.end(viewer, reason);
      viewer.media = undefined;
      viewer.ready = false;
      if (reason === 'media-changed' || reason === 'room-reset') {
        viewer.compatible = false;
        viewer.fallback = undefined;
        viewer.subtitleOffset = 0;
        if (viewer.trackChoice) {
          viewer.trackChoice.audioId = 'auto';
          if (viewer.trackChoice.subtitleId !== 'off') viewer.trackChoice.subtitleId = 'auto';
        }
      }
    }
  }
  // Work ownership includes preparation and cleanup, not just the durable
  // commit receipt. Preloads have their own lifetime rather than their caller's.
  /**
   * @param {Room} room
   * @param {(work: MediaWork) => any} action
   * @param {{kind?: MediaWork['kind'], signal?: AbortSignal}} [options]
   * @returns {MediaWork}
   */
  startMediaWork(room, action, { kind = 'preload', signal } = {}) {
    const controller = new AbortController();
    const work = {
      room,
      kind,
      controller,
      committing: false,
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(30000), ...(signal ? [signal] : [])]),
      promise: Promise.resolve(),
    };
    this.mediaWork.add(work);
    try {
      work.promise = Promise.resolve(
        runOperation(work.signal, () => {
          work.signal.throwIfAborted();
          return action(work);
        }),
      );
    } catch (error) {
      work.promise = Promise.reject(error);
    }
    const done = () => this.mediaWork.delete(work);
    work.promise.then(done, done);
    return work;
  }
  stopMedia(room, media) {
    if (!media) return Promise.resolve();
    return this.startMediaWork(room, () => this.plex.stop(media), { kind: 'cleanup' }).promise;
  }
  async drainMedia(room) {
    const deadline = this.shutdownDeadline || AbortSignal.timeout(this.mediaDrainMs);
    let failure;
    for (;;) {
      const pending = [...this.mediaWork].filter(work => !room || work.room === room);
      if (!pending.length) break;
      for (const work of pending) if (work.kind !== 'cleanup' && !work.committing) work.controller.abort();
      const results = await waitFor(Promise.allSettled(pending.map(work => work.promise)), deadline);
      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected' && (pending[index].kind === 'cleanup' || !pending[index].signal.aborted))
          failure ||= result.reason;
      }
    }
    if (failure) throw failure;
  }
  /**
   * Prepare-then-adopt for autoplay. During the countdown the next video's metadata, its
   * video check and every viewer's stream are prepared through the normal paths; when the
   * room switches, each viewer adopts theirs instead of starting cold. Anything not adopted
   * is stopped.
   */
  preloadNext(room, countdown, next, actor) {
    this.dropPreload(room);
    if (this.shuttingDown || room.closed || !next?.mediaId || next.mediaId === 'demo') return;
    const preload = (room.preload = /** @type {Preload} */ ({
      countdown: countdown.id,
      mediaId: next.mediaId,
      startAt: Number(next.position) || 0,
      viewers: new Map(),
    }));
    preload.work = this.startMediaWork(room, async work => {
      const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
      const source = await plex.prepare(next.mediaId, 'direct', false, undefined, undefined, { sourceOnly: true });
      if (preload.dropped || work.signal.aborted) {
        await this.stopMedia(room, source);
        return;
      }
      this.mediaChecks.start(source);
      preload.media = source;
      const settings = this.hub.config.transcoding;
      if (settings?.fallback?.enabled && settings.uburoom && source.tracks) {
        preload.fallbackStream = new FallbackStream({
          av1: this.plex.av1,
          settings,
          source,
          shareKey: [room.roomId, 'next', preload.countdown],
          authorized: async () => !preload.dropped && (!plex.allows || (await plex.allows(source.id))),
        });
        preload.fallbackStream.reconcile(preload.startAt, true);
      }
      return source;
    });
    preload.source = preload.work.promise;
    void preload.source.then(
      source => {
        if (!source || preload.dropped) return;
        for (const [viewerId, viewer] of room.viewers)
          if (!viewer.localDelivery)
            preload.viewers.set(viewerId, this.preloadViewer(room, preload, source, viewerId, viewer));
      },
      () => {},
    );
  }
  /**
   * Start a viewer's first text subtitle window as soon as their stream exists, with the
   * same bounds the player asks for first, so its request finds it ready. Image and ASS
   * subtitles load differently and are left alone; extraction stays capped by its module.
   */
  warmSubtitles(media, seconds) {
    if (media?.selection?.subtitle?.delivery !== 'cues' || media.unavailable) return;
    void SubtitleResources.window(media.plexContext || this.plex, media, {
      atMs: Math.max(0, seconds || 0) * 1000,
      beforeMs: 5000,
      afterMs: 15000,
    }).catch(() => {});
  }
  // What a viewer's stream depends on; a preload is adopted only if none of it changed.
  streamChoices(viewer) {
    return JSON.stringify([
      viewer.preferredQuality || viewer.quality,
      viewer.compatible,
      viewer.fallback,
      viewer.trackChoice,
      viewer.browserSubtitles,
      viewer.localCodecs,
    ]);
  }
  preloadViewer(room, preload, source, viewerId, viewer) {
    const current = () =>
      !this.shuttingDown && !room.closed && !preload.dropped && room.viewers.get(viewerId) === viewer;
    return this.startMediaWork(
      room,
      async work => {
        const plex = this.hub.plexFor ? await this.hub.plexFor(viewer.actor) : this.plex,
          choices = this.streamChoices(viewer);
        const authorized = async () =>
          current() &&
          (!viewer.alive || (await viewer.alive())) &&
          (await this.canView(room, viewer.actor)) &&
          current();
        if (!(await authorized())) return;
        const media = await this.prepareQuality(
          room,
          viewer,
          plex,
          source,
          viewer.preferredQuality || viewer.quality,
          viewer.compatible,
          viewer.fallback,
          authorized,
          { shareKey: [room.roomId, 'next', preload.countdown] },
        );
        if (!current() || work.signal.aborted) {
          await this.stopMedia(room, media);
          return;
        }
        this.warmSubtitles(media, preload.startAt);
        return { media, choices, principal: plex.principal };
      },
      { signal: preload.work?.signal },
    ).promise;
  }
  /** A viewer's preloaded stream for the room's current video, if it still fits them. */
  takePreload(room, viewerId, viewer, source, plex) {
    const preload = room.adoptable,
      task = preload?.media && preload.media === source ? preload.viewers.get(viewerId) : undefined;
    if (!task) return;
    preload.viewers.delete(viewerId);
    return task.then(
      result => {
        if (result?.principal === plex.principal && result.choices === this.streamChoices(viewer)) {
          result.adopted = true;
          return result.media;
        }
        if (result?.media) void this.stopMedia(room, result.media);
      },
      () => undefined,
    );
  }
  dropPreload(room, preload = room.preload) {
    if (!preload || preload.dropped) return;
    preload.dropped = true;
    preload.work?.controller.abort();
    preload.fallbackStream?.close();
    preload.fallbackStream = undefined;
    if (room.preload === preload) room.preload = undefined;
    if (room.adoptable === preload) room.adoptable = undefined;
    clearTimeout(preload.expiry);
    const viewers = [...preload.viewers.values()];
    preload.viewers.clear();
    // Register cleanup before yielding, even when all preparation promises have
    // already settled, so shutdown cannot miss their deferred continuations.
    this.startMediaWork(
      room,
      async () => {
        const results = await Promise.allSettled(viewers);
        for (const result of results)
          if (result.status === 'fulfilled' && result.value?.media && !result.value.adopted)
            await this.plex.stop(result.value.media);
        const source = await preload.source.catch(() => undefined);
        if (!preload.sourceAdopted && source) await this.plex.stop(source);
      },
      { kind: 'cleanup' },
    );
  }
  async prepareQuality(room, viewer, plex, source, requested, compatible, fallback, authorized, extraOptions) {
    const opts =
      typeof authorized === 'object' && authorized !== null && typeof authorized !== 'function'
        ? { ...authorized, ...extraOptions }
        : { authorized, ...extraOptions };
    const authFn = opts.authorized;
    if (source.unavailable)
      source = await plex.prepare(source.id, 'direct', false, undefined, undefined, { sourceOnly: true });
    const { candidates } = require('./quality-options');
    const choices = this.plex.qualities?.(source) || Engine.QUALITIES;
    if (!choices.length)
      throw new PlaybackError(
        'No configured quality is available for this video. Ask the owner to offer a lower quality or Original.',
      );
    const options = candidates(choices, requested, source),
      quality = options[0]?.id;
    if (!quality)
      throw new PlaybackError(
        'No available quality is at or below your preferred setting. Your preference has been kept.',
      );
    const prepare = (value, sharedOnly = false) =>
      this.prepareOutput(room, viewer, plex, source, value, compatible, fallback, {
        ...viewer.trackChoice,
        browserSubtitles: viewer.browserSubtitles,
        localCodecs: viewer.localCodecs,
        shareKey: [room.roomId, room.mediaVersion],
        shareWaitMs: 8000,
        ...opts,
        authorized: authFn,
        sharedOnly,
      });
    let media;
    try {
      media = await prepare(quality);
    } catch (error) {
      if (!error.conversionCapacity) throw error;
      for (const option of options.slice(1)) {
        try {
          media = await prepare(option.id, true);
          break;
        } catch (next) {
          if (!next.conversionCapacity) throw next;
        }
      }
      if (!media) throw error;
    }
    media.qualityNotice =
      media.quality !== 'direct' && media.quality !== Engine.qualityId(requested)
        ? 'Your requested quality is unavailable. Playing ' +
          (choices.find(q => q.id === media.quality)?.label || media.quality) +
          '. You can try your preferred quality again later.'
        : '';
    return media;
  }
  prepareOutput(room, viewer, plex, source, quality, compatible, fallback, choices) {
    return plex.prepare(source.id, quality, compatible, source, fallback, {
      ...choices,
      directPlan: () => this.delivery?.hlsPlan(plex, viewer, room, choices.authorized),
    });
  }
  async prepareViewer(room, actor, viewerId) {
    const viewer = room.viewers.get(viewerId),
      version = room.mediaVersion;
    if (!viewer || viewer.userId !== actor.userId) return;
    let plex;
    try {
      plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
    } catch (error) {
      // Plex cannot answer: keep what the viewer has and try again shortly.
      if (this.providerFailed(error)) {
        this.retryStream(room, viewerId, 1000);
        return viewer.media;
      }
      throw error;
    }
    if (room.mediaVersion !== version || room.viewers.get(viewerId) !== viewer) return;
    const queueRevision = this.roomState.queue.room(room.roomId).queueRevision;
    if (room.queueEntriesRevision !== queueRevision) {
      room.queueEntries = [
        this.roomState.queue.current(room.roomId),
        ...this.roomState.queue.pending(room.roomId),
      ].filter(Boolean);
      room.queueEntriesRevision = queueRevision;
    }
    const entries = [...(room.queueEntries || [])];
    if (room.media && !entries.some(item => item.mediaId === room.media.id))
      entries.unshift({ id: room.media.id, mediaId: room.media.id, title: room.media.title });
    let availability;
    if (plex.availability) {
      try {
        availability = await plex.availability(entries.map(item => item.mediaId));
        if (entries.length) this.providerResponded();
      } catch (error) {
        if (!this.providerFailed(error)) throw error;
      }
    }
    if (availability) {
      if (room.mediaVersion !== version || room.viewers.get(viewerId) !== viewer) return;
      if (this.roomState.queue.room(room.roomId).queueRevision !== queueRevision) return;
      viewer.unavailableMedia = entries
        .filter(item => availability.get(item.mediaId) === false)
        .map(({ id, mediaId, title }) => ({ id, mediaId, title }));
      if (room.media && availability.get(room.media.id) === false) {
        if (!viewer.media?.unavailable) {
          this.tracking.end(viewer, 'media-unavailable');
          void this.reporting?.end(viewer, 'media-unavailable');
          await this.plex.stop(viewer.media);
        }
        if (room.mediaVersion !== version || room.viewers.get(viewerId) !== viewer) return;
        viewer.media = {
          id: room.media.id,
          title: room.media.title,
          duration: room.media.duration,
          kind: 'plex',
          format: 'unavailable',
          resources: new Map(),
          unavailable: true,
          playbackError: room.media.title + ' is unavailable.',
        };
        viewer.mediaVersion = version;
        viewer.ready = false;
        return viewer.media;
      }
      if (viewer.media?.unavailable) viewer.media = undefined;
    }
    if (!room.media) return;
    if (viewer.localDelivery) {
      if (
        viewer.media &&
        viewer.mediaVersion === version &&
        viewer.media.format === 'local' &&
        (!viewer.media.principal || viewer.media.principal === plex.principal)
      )
        return viewer.media;
      this.tracking.end(viewer, 'stream-changed');
      void this.reporting?.end(viewer, 'stream-changed');
      if (viewer.media) void this.plex.stop(viewer.media);
      viewer.directDelivery = undefined;
      viewer.media = {
        id: room.media.id,
        title: room.media.title,
        duration: room.media.duration,
        kind: room.media.kind,
        format: 'local',
        principal: plex.principal,
        resources: new Map(),
        chapters: room.media.chapters || [],
        markers: room.media.markers || [],
      };
      viewer.mediaVersion = version;
      viewer.streamVersion = randomUUID();
      viewer.ready = false;
      return viewer.media;
    }
    if (!viewer.localDelivery && viewer.media?.format === 'local') viewer.media = undefined;
    const background =
      !!this.fallbackFor(room, viewer) && (viewer.media?.bootstrapFallback || viewer.media?.playbackError);
    if (
      viewer.media &&
      viewer.mediaVersion === version &&
      (!viewer.media.principal || viewer.media.principal === plex.principal) &&
      (!background || this.clock.now() < (viewer.fallbackRetryAt || 0))
    )
      return viewer.media;
    // Collapse concurrent polls for this one viewer, never across viewers.
    if (viewer.preparing) {
      if (background) return viewer.media;
      await Promise.race([
        this.joinPreparation(viewer.preparing),
        viewer.preparing.bootstrap || viewer.preparing.promise,
      ]);
      return room.mediaVersion !== version ? this.prepareViewer(room, actor, viewerId) : viewer.media;
    }
    if (background) {
      viewer.fallbackRetryAt = this.clock.now() + 60000;
      this.retryStream(room, viewerId, 60000);
    }
    let bootstrapReady;
    const bootstrap = new Promise(resolve => {
      bootstrapReady = resolve;
    });
    /** @type {InstanceType<typeof SharedTask> & {bootstrap?: Promise<void>}} */
    const job = new SharedTask(
      async () => {
        // Bootstrap and the chosen output share one preparation lifetime, so
        // concurrent polls cannot create competing metadata or conversion work.
        if (!viewer.media && this.fallbackFor(room, viewer)) {
          await this.replaceViewer(
            room,
            actor,
            viewerId,
            async (authorized, source) => {
              const media = await plex.prepare(
                source.id,
                viewer.preferredQuality || viewer.quality,
                false,
                source,
                undefined,
                { ...viewer.trackChoice, browserSubtitles: viewer.browserSubtitles, sourceOnly: true, authorized },
              );
              if (media.selection?.subtitle?.delivery === 'burn') {
                await this.plex.stop(media);
                return this.prepareQuality(
                  room,
                  viewer,
                  plex,
                  source,
                  viewer.preferredQuality || viewer.quality,
                  viewer.compatible,
                  viewer.fallback,
                  authorized,
                );
              }
              media.bootstrapFallback = true;
              return media;
            },
            { retainUnavailable: true },
          );
          if (viewer.media?.bootstrapFallback) {
            viewer.fallbackRetryAt = this.clock.now() + 60000;
            this.retryStream(room, viewerId, 60000);
            void job.join(new AbortController().signal).catch(() => {});
            bootstrapReady();
          } else return;
        }
        await this.replaceViewer(
          room,
          actor,
          viewerId,
          async (authorized, source) =>
            source.kind === 'demo'
              ? source
              : (await this.takePreload(room, viewerId, viewer, source, plex)) ||
                this.prepareQuality(
                  room,
                  viewer,
                  plex,
                  source,
                  viewer.preferredQuality || viewer.quality,
                  viewer.compatible,
                  viewer.fallback,
                  authorized,
                ),
          { retainUnavailable: true },
        );
        if (viewer.media?.quality) viewer.quality = viewer.media.quality;
        if (room.mediaVersion === version && room.state.paused) this.warmSubtitles(viewer.media, this.position(room));
      },
      { timeoutMs: 120000, idleMs: 15000 },
    );
    job.bootstrap = bootstrap;
    job.promise
      .finally(() => {
        if (viewer.preparing === job) viewer.preparing = undefined;
      })
      .catch(() => {});
    viewer.preparing = job;
    if (background) {
      void job.join(new AbortController().signal).catch(() => {});
      return viewer.media;
    }
    await Promise.race([this.joinPreparation(job), bootstrap]);
    return room.mediaVersion !== version ? this.prepareViewer(room, actor, viewerId) : viewer.media;
  }
  // Superseded preparation is not a failed request. A 4xx here would tell this
  // viewer the room is gone merely because someone else changed the media.
  async joinPreparation(job) {
    try {
      await job.join();
    } catch (error) {
      currentSignal()?.throwIfAborted();
      if (!job.signal.aborted && !this.providerFailed(error)) throw error;
    }
  }
  /**
   * @param {Room} room
   * @param {Actor} actor
   * @param {string} viewerId
   * @param {(authorized: () => Promise<boolean>, source: any) => Promise<any>} prepare
   * @param {{permitted?: () => boolean, retainUnavailable?: boolean, accept?: (media: any) => boolean}} [options]
   */
  async replaceViewer(
    room,
    actor,
    viewerId,
    prepare,
    { permitted = () => true, retainUnavailable = false, accept = () => true } = {},
  ) {
    const viewer = room.viewers.get(viewerId),
      version = room.mediaVersion,
      current = viewer?.media,
      stream = viewer?.streamVersion,
      source = room.media;
    if (!viewer || viewer.userId !== actor.userId)
      return { status: 'unavailable', message: 'Room changed or command expired.' };
    const signal = currentSignal();
    const matches = () =>
      !signal?.aborted &&
      room.mediaVersion === version &&
      room.viewers.get(viewerId) === viewer &&
      viewer.media === current &&
      viewer.streamVersion === stream;
    const authorized = async () =>
      matches() &&
      permitted() &&
      (await this.canView(room, actor)) &&
      (!viewer.alive || (await viewer.alive())) &&
      matches() &&
      permitted();
    let media,
      adopted = false;
    try {
      if (!(await authorized())) return { status: 'unavailable', message: 'Room changed or command expired.' };
      try {
        media = await prepare(authorized, source);
      } catch (error) {
        if (retainUnavailable && error.code === 'MEDIA_UNAVAILABLE') {
          media = {
            id: source.id,
            title: source.title,
            duration: source.duration,
            kind: 'plex',
            resources: new Map(),
            unavailable: true,
            format: 'unavailable',
            playbackError: error.message,
          };
        } else {
          const failure = /** @type {InstanceType<typeof PlaybackError> & {media?: any}} */ (error);
          if (!retainUnavailable || !(failure instanceof PlaybackError) || !failure.media) throw error;
          // Preserve the catalog so Off/another subtitle can recover a failed burn.
          media = failure.media;
          media.format = 'unavailable';
          media.playbackError = error.message;
        }
      }
      if (!(await authorized())) return { status: 'unavailable', message: 'Room changed or command expired.' };
      if (!accept(media)) throw new PlaybackError('Plex could not refresh this stream.');
      this.tracking.end(viewer, 'stream-changed');
      void this.reporting?.end(viewer, 'stream-changed');
      viewer.media = media;
      viewer.mediaVersion = version;
      viewer.streamVersion = randomUUID();
      viewer.directDelivery = undefined;
      adopted = true;
      if (media.unavailable) {
        const entry = this.roomState.queue.current(room.roomId);
        viewer.unavailableMedia = [
          ...(viewer.unavailableMedia || []).filter(item => item.mediaId !== media.id),
          { id: entry?.id || media.id, mediaId: media.id, title: media.title },
        ];
      }
      // A viewer with no stream can never report ready, so the room stops waiting for them
      // until they have one again.
      this.coordinator.run(room, { type: 'stream', viewerId, available: media.format !== 'unavailable' });
      if (current && current !== media) {
        SubtitleResources.transfer(current, media);
        void this.plex.stop(current);
      }
      return { status: 'applied' };
    } finally {
      if (media && !adopted && media !== current && media !== room.media) await this.plex.stop(media);
    }
  }
  /** Rechecks a room's lifecycle after a change made outside its mailbox (a command, new media). */
  review(room) {
    if (this.rooms.get(room.roomId) !== room) return;
    return this.coordinator.run(room, { type: 'review' });
  }
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
  }
  /** Runs what a committed room event asks of the server, in order. */
  roomEffect(room, effect, removed) {
    switch (effect.type) {
      case 'cancel-autoplay':
        return this.cancelAutoplay(room);
      case 'clear-playback-end':
        return clearPlaybackEnd(room);
      case 'save':
        return void this.roomState.save(room).catch(() => {});
      case 'hide':
        return void this.hub.rooms.delete(room.roomId);
      case 'reveal':
        return void this.hub.rooms.set(room.roomId, room);
      case 'remove':
        return void this.removeRoom(room, effect.save).catch(() => {});
      case 'viewer-joined': {
        const viewer = room.viewers.get(effect.viewerId);
        this.hub?.config?.logger?.info(
          'Room',
          `Viewer "${viewer?.name || viewer?.userId}" joined "${room.name || room.roomId}" (viewers: ${room.viewers.size})`,
        );
        this.roomState.store.touch(room.roomId);
        return void this.roomState.save(room).catch(() => {});
      }
      case 'viewer-reconnected':
        return this.reporting?.reconnect(room, room.viewers.get(effect.viewerId), effect.saved);
      case 'viewer-removed': {
        const viewer = removed.get(effect.viewerId);
        if (!viewer) return;
        viewer.preparing?.abort();
        clearTimeout(viewer.streamRetry);
        clearTimeout(viewer.observationTimer);
        this.tracking.end(viewer, effect.tracking);
        void this.plex.stop(viewer.media);
        void this.reporting?.end(viewer, effect.reporting);
        if (effect.left)
          this.hub?.config?.logger?.info(
            'Room',
            `Viewer "${viewer.name || effect.viewerId}" left "${room.name || room.roomId}" (remaining: ${room.viewers.size})`,
          );
        return;
      }
      case 'reporting-ended':
        return void this.reporting?.endViewer(room, effect.viewerId, effect.reason);
      case 'kicked':
        for (const socket of new Set(effect.viewerIds.map(id => removed.get(id)?.watchSocket).filter(Boolean)))
          socket.watchKick?.(room.roomId);
        return;
      case 'host-elected':
        return void this.confirmHost(room, effect.viewerId, effect.replay).catch(() => {});
      case 'recovery-finished':
        return void this.roomState.recoveries.delete(room.roomId);
      case 'started':
        // The start completes a play someone already asked for; it persists like that play.
        this.reconcileFallback(room);
        return void this.roomState.save(room).catch(() => {});
    }
  }
  /**
   * The election chose this tab using what the room knows. Its connection and media
   * access are checked here, outside the mailbox; a tab that fails is passed over and
   * the room elects again. A playing room resumes through its new host's play.
   */
  async confirmHost(room, viewerId, replay) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer) return;
    const usable = (!viewer.alive || (await viewer.alive())) && (await this.canView(room, viewer.actor));
    if (this.rooms.get(room.roomId) !== room || room.hostViewerId !== viewerId || room.viewers.get(viewerId) !== viewer)
      return;
    if (!usable) {
      (room.passedOverHosts ||= new Set()).add(viewerId);
      this.coordinator.run(room, { type: 'elect', exclude: [...room.passedOverHosts] });
      return;
    }
    room.passedOverHosts = undefined;
    if (replay)
      await this.hub.dispatch(
        { ...viewer.actor, watchViewerId: viewerId },
        { roomId: room.roomId, action: 'media.play' },
      );
  }
  /**
   * Starts preparing every viewer's stream and checking the queue's availability, after
   * the room's media or queue changed. Each viewer's next state waits for their own stream.
   */
  prepareStreams(room) {
    if (this.rooms.get(room.roomId) !== room) return;
    for (const [viewerId, viewer] of room.viewers) this.prepareStream(room, viewer.actor, viewerId);
    this.requestEndingMeta(room);
    this.reconcileFallback(room);
  }
  /**
   * Prepares one viewer's stream (join, delivery change, retries). Returns the work,
   * which the viewer's published state waits for; nothing else does.
   * @returns {Promise<void>}
   */
  prepareStream(room, actor, viewerId) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer || this.shuttingDown || room.closed) return Promise.resolve();
    clearTimeout(viewer.streamRetry);
    const work = this.checkAccess(room, viewer)
      .then(() => this.prepareViewer(room, actor, viewerId))
      .then(
        () => {
          viewer.streamFailure = undefined;
          this.keepTranscodes(room);
        },
        error => {
          // Shown to this viewer until a retry succeeds, as the old once-a-second poll did.
          viewer.streamFailure = error;
          this.retryStream(room, viewerId, 1000);
        },
      );
    viewer.streamWork = work;
    void work.finally(() => {
      if (viewer.streamWork === work) viewer.streamWork = undefined;
    });
    return work;
  }
  /** Prepares a viewer's stream again after `ms` (a provider outage, a failure, a fallback retry). */
  retryStream(room, viewerId, ms) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer) return;
    clearTimeout(viewer.streamRetry);
    viewer.streamRetry = setTimeout(() => {
      if (this.rooms.get(room.roomId) === room && room.viewers.get(viewerId) === viewer)
        void this.prepareStream(room, viewer.actor, viewerId);
    }, ms);
    viewer.streamRetry.unref?.();
  }
  /** Keeps open Plex transcodes alive while any viewer streams through one. */
  keepTranscodes(room) {
    const ping = () => {
      const media = new Map(
        [...room.viewers.values()].filter(v => v.media?.transcodeId).map(v => [v.media.transcodeId, v.media]),
      );
      if (this.rooms.get(room.roomId) !== room || !media.size) {
        clearInterval(room.transcodePing);
        room.transcodePing = undefined;
        return;
      }
      for (const item of media.values()) void this.plex.ping(item);
    };
    if (room.transcodePing || ![...room.viewers.values()].some(v => v.media?.transcodeId)) return;
    room.transcodePing = setInterval(ping, TRANSCODE_PING_MS);
    room.transcodePing.unref?.();
    ping();
  }
  /** Ends a viewer's playback observation once it goes quiet (see PlaybackTracking). */
  observed(room, viewer) {
    clearTimeout(viewer.observationTimer);
    if (!viewer.tracking) return;
    viewer.observationTimer = setTimeout(() => {
      if (!viewer.tracking) return;
      this.tracking.expire(viewer);
      if (!viewer.tracking) void this.reporting?.end(viewer, 'observation-timeout');
      else this.observed(room, viewer);
    }, PlaybackTracking.OBSERVATION_GAP_MS + 1);
    viewer.observationTimer.unref?.();
  }
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
  }
  /** Records whether `viewer` may still see the room's current media (membership and Plex item access). */
  async checkAccess(room, viewer) {
    const media = room.media,
      at = this.clock.now(),
      ok = await this.canView(room, viewer.actor);
    if (room.media === media) viewer.access = { media, at, ok };
    return ok;
  }
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
    if (room.media?.kind === 'plex' && this.hub.plexFor && viewer?.access?.media === room.media && !viewer.access.ok)
      return false;
    return this.hub.authorize(actor, room, 'room.view').ok;
  }
  /** Rechecks every room after a change to who someone is or what they may do (Admin mode). */
  identityChanged() {
    for (const room of [...this.rooms.values()]) this.review(room);
  }
  /** A person's display name changed. */
  renamed(userId, name) {
    for (const room of [...this.rooms.values()]) this.coordinator.run(room, { type: 'identity', userId, name });
  }
  reconcileFallback(room) {
    const settings = this.hub.config.transcoding;
    if (
      !settings?.fallback?.enabled ||
      !settings.uburoom ||
      settings.policy === 'disabled' ||
      !room.media ||
      !room.viewers.size ||
      room.media.kind !== 'plex'
    ) {
      room.fallbackStream?.close();
      room.fallbackStream = undefined;
      clearInterval(room.fallbackTimer);
      room.fallbackTimer = undefined;
      return;
    }
    if (!room.fallbackStream && room.media.tracks && this.plex.av1) {
      const source = room.media,
        version = room.mediaVersion;
      room.fallbackStream = new FallbackStream({
        av1: this.plex.av1,
        settings,
        source,
        shareKey: [room.roomId, version],
        authorized: async () => {
          if (this.rooms.get(room.roomId) !== room || room.mediaVersion !== version) return false;
          for (const viewer of room.viewers.values())
            if ((!viewer.alive || (await viewer.alive())) && (await this.canView(room, viewer.actor))) return true;
          return false;
        },
        event: (event, fields) => this.hub.config.logger?.info('Fallback', event, fields),
      });
    }
    const media = room.fallbackStream?.media;
    // Active fallback viewers retain their group even between chunk requests.
    // The existing health report distinguishes them from speculative warming.
    if (
      media &&
      [...room.viewers.values()].some(
        viewer =>
          viewer.syncQuality?.health?.format === media.format &&
          viewer.syncQuality.health.quality === media.quality &&
          this.clock.now() - viewer.syncQuality.updatedAt < 15000,
      )
    )
      media.av1Lease.group.viewerDemandAt = this.clock.now();
    room.fallbackStream?.reconcile(this.position(room), !room.state.paused);
    // The fallback encoder follows the playhead once a second while it exists.
    if (room.fallbackStream && !room.fallbackTimer) {
      room.fallbackTimer = setInterval(() => {
        if (this.rooms.get(room.roomId) === room) this.reconcileFallback(room);
        else {
          clearInterval(room.fallbackTimer);
          room.fallbackTimer = undefined;
        }
      }, 1000);
      room.fallbackTimer.unref?.();
    }
  }
  fallbackFor(room, viewer) {
    const media = room.fallbackStream?.media;
    return media &&
      !media.av1Lease?.released &&
      !viewer.localDelivery &&
      !viewer.media?.unavailable &&
      viewer.media?.selection?.subtitle?.delivery !== 'burn' &&
      viewer.localCodecs?.includes(media.format)
      ? media
      : undefined;
  }
  // Room access with the asynchronous provider checks authorize() leaves out:
  // membership refresh and personal Plex access to the current item.
  async canView(room, actor) {
    if (!room || this.rooms.get(room.roomId) !== room) return false;
    // A frozen room is its host's alone until it wakes or closes.
    if (room.frozen && actor.userId !== room.hostId) return false;
    if (!canWatch(this.hub.access, actor.userId, actor)) {
      try {
        if (!(await (this.hub.access?.refreshWatch || this.hub.access?.refresh)?.(actor.userId, actor))) return false;
      } catch (error) {
        if (!this.retainedThroughOutage(room, actor, error)) return false;
      }
    }
    if (room.media?.kind === 'plex' && this.hub.plexFor) {
      try {
        const allowed = await (await this.hub.plexFor(actor)).allows(room.media.id);
        this.providerResponded();
        if (!allowed) return false;
      } catch (error) {
        if (!this.retainedThroughOutage(room, actor, error)) return false;
      }
    }
    return this.hub.authorize(actor, room, 'room.view').ok;
  }
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
        if (record.bookmark && this.hub.plexFor) {
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
  }
  async leave(room, actor, viewerId, reason = 'left') {
    if (room.transition?.commit) await room.transition?.commit.catch(() => {});
    if (this.rooms.get(room.roomId) !== room) return;
    this.coordinator.run(room, { type: 'leave', actor, viewerId, reason });
    if (room.closed) await room.removal;
  }
  async ready(room, actor, viewerId, version, ready, readinessVersion) {
    const result = this.coordinator.run(room, {
      type: 'ready',
      actor,
      viewerId,
      mediaVersion: version,
      ready,
      readinessVersion,
    });
    if (result.error) throw result.error;
  }
  /**
   * Admits one tab to the room, or renews the tab that is already in it. This is
   * the only way into a room: reading a room never adds anyone to it.
   * @param {any} room
   * @param {Actor} actor
   * @param {string} viewerId
   * @param {{alive?: () => Promise<boolean>, quality?: string | null, preferences?: Object, rtts?: Array<{at: number, ms: number}>}} [options]
   * @returns {any} The joined viewer.
   */
  join(room, actor, viewerId, { alive, quality, preferences, rtts } = {}) {
    if (this.shuttingDown || room.closed || this.rooms.get(room.roomId) !== room) throw new Error('Room unavailable');
    const result = this.coordinator.run(room, { type: 'join', actor, viewerId, quality, preferences, rtts });
    if (result.error) throw result.error;
    const viewer = room.viewers.get(viewerId);
    if (alive) viewer.alive = alive;
    return viewer;
  }
  /** A tab's connection closed. A planned close leaves now; any other leaves when its presence lapses. */
  disconnected(socket, planned) {
    for (const room of [...this.rooms.values()])
      for (const [viewerId, viewer] of [...room.viewers])
        if (viewer.watchSocket === socket) this.coordinator.run(room, { type: 'disconnect', viewerId, planned });
  }
  /** Presence and grant renewal for the tabs on one connection (its clock exchanges and pongs). */
  present(socket) {
    for (const room of [...this.rooms.values()])
      for (const viewer of [...room.viewers.values()])
        if (viewer.watchSocket === socket) this.touch(room, viewer, socket.watchRtts);
  }
  // Each state handed to a client carries the next number in its room's
  // publication order, so the browser can drop an older state that arrives late.
  // The count belongs to publication, not to the room.
  nextStateSequence(room) {
    const next = this.stateSequence(room) + 1;
    this.stateSequences.set(room, next);
    return next;
  }
  stateSequence(room) {
    return this.stateSequences.get(room) || 0;
  }
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
  }
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
  }
  cancelAutoplay(room) {
    this.dropPreload(room);
    clearTimeout(room.autoplayTimer);
    room.autoplayTimer = undefined;
    if (room.autoplayCountdown) {
      room.autoplayCountdown = undefined;
      room.revision++;
    }
    room.playbackIntent = (room.playbackIntent || 0) + 1;
  }
  async autoCorpus(id, actor, config = this.roomState.store.get(id).autoQueue, anchorOverride) {
    if (!config || config.mode === 'off') return undefined;
    const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
    if (config.mode === 'continue') {
      const queue = this.roomState.queue;
      const pending = queue.pending(id),
        current = queue.current(id),
        lastHistory = queue.lastHistory(id);
      const active = [...(current ? [current] : []), ...pending];
      const anchorItem =
        anchorOverride !== undefined ? anchorOverride : active.length ? active[active.length - 1] : lastHistory;
      if (!anchorItem || anchorItem.type !== 'episode' || anchorItem.mediaId === 'demo') return [];
      const details = plex.details ? await plex.details(anchorItem.mediaId, 'episode') : null;
      const showId = details?.showId;
      if (!showId) return [];
      const serverId = anchorItem.serverId || (await this.roomState.identify({ id: String(showId) }));
      const items = await plex.queueItems({ type: 'show', id: String(showId), includeSpecials: false });
      if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
        throw Object.assign(new Error('Plex access changed'), { status: 403 });
      return items.map(item => this.queueItem(item, serverId));
    }
    const serverId = await this.roomState.identify({ id: config.scope.id });
    if (serverId !== config.scope.serverId)
      throw Object.assign(new Error('The auto-queue Plex server changed'), { status: 409 });
    const items = await plex.queueItems({ ...config.scope, includeSpecials: config.includeSpecials });
    if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
      throw Object.assign(new Error('Plex access changed'), { status: 403 });
    return items.map(item => this.queueItem(item, serverId));
  }
  async verifyAutoNext(id, actor, corpus) {
    const queue = this.roomState.queue;
    const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
    if (!plex?.availability) return this.roomState.store.get(id).autoQueue;
    let remaining = corpus;
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentAuto = this.roomState.store.get(id).autoQueue;
      const candidate = currentAuto?.mode !== 'off' ? currentAuto?.next : null;
      if (!candidate || candidate.mediaId === 'demo') return currentAuto;
      const status = await plex.availability([candidate.mediaId]);
      if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
        throw Object.assign(new Error('Plex access changed'), { status: 403 });
      if (status.get(candidate.mediaId) !== false) return currentAuto;
      remaining = (remaining || (await this.autoCorpus(id, actor)) || []).filter(
        item => item.mediaId !== candidate.mediaId,
      );
      await queue.generate(id, actor.userId, attempt === 4 ? [] : remaining, {
        continuation: true,
        forceAdvance: true,
      });
    }
    return this.roomState.store.get(id).autoQueue;
  }
  queueItem(item, serverId) {
    let parentTitle = item.parentTitle;
    const epNum = Number.isInteger(item.index)
      ? item.index
      : typeof item.episode === 'number' && Number.isInteger(item.episode)
        ? item.episode
        : undefined;
    if (item.type === 'episode' && Number.isInteger(epNum)) {
      const epStr = 'Episode ' + epNum;
      if (parentTitle && !parentTitle.includes('Episode')) {
        parentTitle = parentTitle + ' Â· ' + epStr;
      } else if (!parentTitle) {
        parentTitle = epStr;
      }
    }
    return {
      ...item,
      serverId,
      mediaId: String(item.mediaId || item.id || ''),
      type: item.type === 'demo' || item.mediaId === 'demo' || item.id === 'demo' ? 'movie' : item.type,
      parentTitle,
      grandparentTitle: item.grandparentTitle || item.showTitle,
    };
  }
  async queueCommand(id, command, actor, permitted) {
    if (!this.roomState) throw Object.assign(new Error('Saved rooms are unavailable'), { status: 400 });
    const room = this.rooms.get(id),
      { action, args } = command,
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(action)),
      queue = this.roomState.queue;
    if (room?.transition) throw Object.assign(new Error('Wait for the current queue operation'), { status: 409 });
    const currentRequest = async () =>
      permitted() && (!actor.watchCurrent || (await actor.watchCurrent())) && permitted();
    await this.roomState.eligible(actor, currentRequest);
    await this.roomState.metadata(id, actor);
    const check = async () => {
      if (
        !(await currentRequest()) ||
        this.rooms.get(id) !== room ||
        (room && !(await this.canView(room, actor))) ||
        !(await currentRequest())
      ) {
        throw Object.assign(new Error('Room access changed; retry manually'), { status: 403 });
      }
      if (declared.idle && !room?.media && !queue.current(id)) {
        const r = queue.room(id),
          canonical = queue.account(actor.userId);
        if (
          this.roomState.store.isAdmin(canonical) !== true &&
          !RoomPolicy.allowed(r, canonical, declared.capability) &&
          !RoomPolicy.allowed(r, canonical, declared.idle)
        ) {
          throw Object.assign(new Error('Room queue permission required'), { status: 403 });
        }
      } else {
        queue.assertAllowed(queue.room(id), actor.userId, declared.capability);
      }
    };
    await check();
    const revision = args.expectedRevision ?? queue.room(id).queueRevision;
    queue.assertRevision(queue.room(id), revision);
    if (room?.transition) throw Object.assign(new Error('Wait for the current queue operation'), { status: 409 });
    const priorCountdown = room?.autoplayCountdown;
    const hadMedia = !!room?.media;
    const wasEmptyQueue = !priorCountdown && !queue.current(id) && !queue.pending(id).length;
    if (room) {
      room.transition = { kind: 'queue' };
      if (hadMedia) {
        this.cancelAutoplay(room);
        clearPlaybackEnd(room);
      }
    }
    try {
      let value;
      if (action === 'queue.remove' && (args.advance || queue.current(id)?.id === args.entryId)) {
        if (queue.current(id)?.id !== args.entryId)
          throw Object.assign(new Error('Current video changed; refresh before removing'), { status: 409 });
        queue.assertAllowed(queue.room(id), actor.userId, 'chooseMedia');
        if (args.advance && !this.nextCandidate(id))
          throw Object.assign(new Error('No next video is available'), { status: 409 });
        if (room) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(room, command, actor, permitted);
        }
        value = args.advance
          ? await queue.next(id, actor.userId, {
              expectedRevision: revision,
              currentEntryId: args.entryId,
              discardCurrent: true,
            })
          : await queue.remove(id, actor.userId, args.entryId, revision, { allowCurrent: true });
      } else if (action === 'queue.add' || action === 'queue.playNow') {
        const raw = args.item,
          serverId = raw.serverId || (await this.roomState.identify({ id: raw.mediaId || raw.id }));
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        const checked =
          plex.playableItem && (raw.mediaId || raw.id) !== 'demo'
            ? await plex.playableItem(raw.mediaId || raw.id)
            : raw;
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
          throw Object.assign(new Error('Plex access changed'), { status: 403 });
        const item = this.queueItem(checked, serverId);
        await check();
        queue.assertRevision(queue.room(id), revision);
        if (action === 'queue.playNow' && room) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'media.load', args: { mediaId: item.mediaId } },
            actor,
            permitted,
          );
        }
        if (action === 'queue.add' && room && !room.media && wasEmptyQueue) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'media.load', args: { mediaId: item.mediaId } },
            actor,
            permitted,
            { initialAdd: true, forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay },
          );
        }
        value =
          action === 'queue.add'
            ? await queue.add(id, actor.userId, item, { expectedRevision: revision })
            : await queue.playNow(id, actor.userId, item);
      } else if (action === 'queue.offer.start') {
        if (!room) throw Object.assign(new Error('Room unavailable'), { status: 404 });
        if (!this.hub.authorize(actor, room, 'addQueue').ok || !this.hub.authorize(actor, room, 'playPause').ok) {
          throw Object.assign(new Error('Room permission required'), { status: 403 });
        }
        if (room.media || queue.current(id) || queue.pending(id).length) {
          throw Object.assign(new Error('Queue is no longer empty'), { status: 409 });
        }
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        const checked = plex.playableItem
          ? await plex.playableItem(args.mediaId)
          : { id: args.mediaId, type: 'episode' };
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal) {
          throw Object.assign(new Error('Plex access changed'), { status: 403 });
        }
        await check();
        const autoConfig = { mode: 'continue', scope: null, includeSpecials: false };
        await queue.configureAuto(id, actor.userId, autoConfig, { expectedRevision: revision });
        if (room.transition?.kind === 'queue') room.transition = undefined;
        return this.changeQueueMedia(
          room,
          { action: 'media.load', args: { mediaId: checked.id || args.mediaId } },
          actor,
          permitted,
          { initialAdd: true, forcePlay: true },
        );
      } else if (action === 'queue.playEntry' || action === 'queue.skipTo') {
        const skipPrevious = action === 'queue.skipTo' || !!args.skipPrevious;
        if (room) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'queue.playEntry', args: { entryId: args.entryId, skipPrevious } },
            actor,
            permitted,
          );
        }
        value = await queue.playEntry(id, actor.userId, args.entryId, { skipPrevious, expectedRevision: revision });
      } else if (action === 'queue.bulk') {
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        const serverId = await this.roomState.identify({ id: args.mediaId });
        const items = await plex.queueItems({
          type: args.type,
          id: args.mediaId,
          includeSpecials: args.includeSpecials,
        });
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
          throw Object.assign(new Error('Plex access changed'), { status: 403 });
        await check();
        value = await queue.addBulk(
          id,
          actor.userId,
          items.map(item => this.queueItem(item, serverId)),
          { expectedRevision: revision, unfinished: args.unfinished },
        );
        if (room && !room.media && wasEmptyQueue && value.addedCount) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'queue.playEntry', args: { entryId: queue.pending(id)[0].id } },
            actor,
            permitted,
            { initialAdd: true, forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay },
          );
        }
      } else if (action === 'queue.auto') {
        let scope = null,
          corpus;
        if (['following', 'random'].includes(args.mode)) {
          scope = args.scope;
          const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
          if (!scope.id) {
            if (scope.type !== 'show' || !room?.media || room.media.id === 'demo')
              throw Object.assign(new Error('Choose a show from the library'), { status: 400 });
            const details = await plex.details(room.media.id);
            scope = { ...scope, id: details.showId || (details.type === 'show' ? details.id : undefined) };
          }
          if (!scope.id) throw Object.assign(new Error('Choose a show from the library'), { status: 400 });
          scope = { ...scope, serverId: await this.roomState.identify({ id: scope.id }) };
          corpus = await this.autoCorpus(id, actor, { ...args, scope });
        } else if (args.mode === 'continue') {
          corpus = await this.autoCorpus(id, actor, { mode: 'continue', scope: null, includeSpecials: false });
        }
        await check();
        value = await queue.configureAuto(id, actor.userId, { ...args, scope }, { expectedRevision: revision });
        if (corpus) {
          await check();
          const generated = await queue.generate(id, actor.userId, corpus, { expectedRevision: value.queueRevision });
          const verified = await this.verifyAutoNext(id, actor, corpus);
          value = {
            ...value,
            ...generated,
            autoQueue: verified,
            next: verified.next,
            queueRevision: this.roomState.store.get(id).queueRevision,
          };
        }
        if (
          room &&
          !room.media &&
          !queue.current(id) &&
          !queue.pending(id).length &&
          value.autoQueue?.next &&
          this.roomState.store.get(id).autoplay
        ) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(room, { action: 'media.next', args: {} }, actor, permitted, {
            initialAdd: true,
            forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay,
          });
        }
      } else if (action === 'queue.auto.skip') {
        const corpus = (await this.autoCorpus(id, actor)) || [];
        await check();
        value = await queue.skipAuto(id, actor.userId, corpus, { expectedRevision: revision });
        const verified = await this.verifyAutoNext(id, actor, corpus);
        value = {
          ...value,
          autoQueue: verified,
          next: verified.next,
          queueRevision: this.roomState.store.get(id).queueRevision,
        };
      } else if (action === 'queue.auto.pin') {
        const corpus = (await this.autoCorpus(id, actor)) || [];
        await check();
        value = await queue.pinAuto(id, actor.userId, corpus, { expectedRevision: revision });
        const verified = await this.verifyAutoNext(id, actor, corpus);
        value = {
          ...value,
          autoQueue: verified,
          next: verified.next,
          queueRevision: this.roomState.store.get(id).queueRevision,
        };
        if (room && !room.media && wasEmptyQueue && value.added && this.roomState.store.get(id).autoplay) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'queue.playEntry', args: { entryId: value.added.id } },
            actor,
            permitted,
            { initialAdd: true, forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay },
          );
        }
      } else if (action === 'queue.auto.playNow') {
        if (room) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(
            room,
            { action: 'queue.auto.playNow', args: { skipPrevious: !!args.skipPrevious } },
            actor,
            permitted,
          );
        }
        const pendingItems = queue.pending(id);
        const postAnchor =
          !args.skipPrevious && pendingItems.length > 0 ? pendingItems[pendingItems.length - 1] : undefined;
        const corpus = await this.autoCorpus(id, actor, this.roomState.store.get(id).autoQueue, postAnchor);
        await check();
        value = await queue.playAutoNow(id, actor.userId, {
          expectedRevision: revision,
          autoCorpus: corpus,
          skipPrevious: !!args.skipPrevious,
        });
        await this.verifyAutoNext(id, actor, corpus);
        value = { ...value, queueRevision: this.roomState.store.get(id).queueRevision };
      } else if (action === 'queue.move')
        value = await queue.move(id, actor.userId, args.entryId, args.targetRank, revision);
      else if (action === 'queue.remove') value = await queue.remove(id, actor.userId, args.entryId, revision);
      else if (action === 'queue.clear') value = await queue.clear(id, actor.userId, revision);
      else if (action === 'queue.shuffle') value = await queue.shuffle(id, actor.userId, revision);
      else if (action === 'queue.history.clear') value = await queue.historyClear(id, actor.userId);
      else if (action === 'queue.history.replay' || action === 'queue.history.goBack') {
        if (room) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(room, command, actor, permitted);
        }
        value = await queue.historyReplay(id, actor.userId, args.entryId, {
          resume: args.resume,
          restore: action === 'queue.history.goBack',
          expectedRevision: revision,
        });
      }
      if (declared.refillsAutoQueue && this.roomState.store.get(id).autoQueue.mode !== 'off') {
        try {
          const corpus = await this.autoCorpus(id, actor);
          if (corpus) {
            const latestRev = this.roomState.store.get(id).queueRevision;
            await queue.generate(id, actor.userId, corpus, { expectedRevision: latestRev, continuation: true });
            const verified = await this.verifyAutoNext(id, actor, corpus);
            value = { ...value, autoQueue: verified, queueRevision: this.roomState.store.get(id).queueRevision };
          }
        } catch (error) {
          if (room) room.autoQueueError = error.message;
        }
      }
      if (room && this.rooms.get(id) === room) {
        const latest = this.roomState.store.get(id);
        this.roomState.apply(room, latest);
        if (priorCountdown && !room.media) {
          const afterNext = this.nextCandidate(id);
          const afterKey = afterNext ? afterNext.id || afterNext.serverId + ':' + afterNext.mediaId : null;
          if (!afterNext) {
            this.cancelAutoplay(room);
          } else if (afterKey === priorCountdown.nextKey && room.autoplayCountdown === priorCountdown) {
            priorCountdown.queueRevision = latest.queueRevision;
          } else {
            this.cancelAutoplay(room);
            if (room.transition?.kind === 'queue') room.transition = undefined;
            await this.startAutoplayCountdown(room);
          }
        }
        void this.refreshEndingMeta(room);
        room.revision++;
        room.autoQueueError = undefined;
        // The queue changed: check its availability and everyone's stream again.
        this.prepareStreams(room);
      }
      return { status: 'applied', ...value };
    } finally {
      if (room?.transition?.kind === 'queue') room.transition = undefined;
    }
  }
  async observeEnd(room, viewer, data, observed) {
    if (!observePlaybackEnd(room, viewer, data, observed, this.clock.now())) return;
    await this.finishQueueMedia(room, data);
  }
  nextCandidate(roomId) {
    const queue = this.roomState.queue;
    const nextPending = queue.peekNext(roomId);
    if (nextPending) return nextPending;
    const record = this.roomState.store.get(roomId);
    const autoNext = record?.autoQueue?.mode !== 'off' ? record?.autoQueue?.next : null;
    return autoNext ? { ...autoNext, id: 'auto:' + autoNext.mediaId, source: 'auto' } : null;
  }
  async refreshEndingMeta(room) {
    if (!room || room.media || room.refreshingEndingMeta) return;
    room.refreshingEndingMeta = true;
    try {
      const record = this.roomState.store.get(room.roomId);
      if (!record) return;
      const summary = this.roomState.queue.summary(record.id);
      if (!summary) return;
      room.endingMeta ||= new Map();
      const nextItem = summary.next || summary.autoQueue?.next;
      const needed = [summary.lastHistory, nextItem].filter(Boolean);
      const viewer = [...room.viewers.values()][0];
      const plex = viewer && this.hub.plexFor ? await this.hub.plexFor(viewer.actor) : this.plex;
      let changed = false;
      if (plex?.details) {
        for (const item of needed) {
          if (!room.endingMeta.has(item.mediaId)) {
            try {
              const details = await plex.details(item.mediaId, item.type);
              room.endingMeta.set(item.mediaId, {
                summary: details?.summary || '',
                subtitle: details?.subtitle || item.subtitle || '',
                hasLandscape: Boolean(details?.hasLandscape || item.hasLandscape),
                hasPoster: Boolean(details?.hasPoster || item.hasPoster),
              });
              while (room.endingMeta.size > 8) room.endingMeta.delete(room.endingMeta.keys().next().value);
              changed = true;
            } catch {
              room.endingMeta.set(item.mediaId, {
                summary: '',
                subtitle: item.subtitle || '',
                hasLandscape: Boolean(item.hasLandscape),
                hasPoster: Boolean(item.hasPoster),
              });
            }
          }
        }
      } else {
        for (const item of needed) {
          if (!room.endingMeta.has(item.mediaId)) {
            room.endingMeta.set(item.mediaId, {
              summary: '',
              subtitle: item.subtitle || '',
              hasLandscape: Boolean(item.hasLandscape),
              hasPoster: Boolean(item.hasPoster),
            });
          }
        }
      }
      if (changed) {
        room.revision++;
        this.review(room);
      }
      if (!nextItem && summary.lastHistory?.type === 'episode' && record.autoQueue?.mode === 'off') {
        const offerKey = summary.lastHistory.id + ':' + record.queueRevision;
        if (!room.endingOffer || room.endingOffer.key !== offerKey) {
          await this.resolveEndingOffer(room, summary.lastHistory);
        }
      }
    } finally {
      room.refreshingEndingMeta = false;
    }
  }
  async resolveEndingOffer(room, completed) {
    if (!completed || completed.type !== 'episode') return;
    const record = this.roomState.store.get(room.roomId);
    if (!record || record.autoQueue?.mode !== 'off') return;
    const epoch = room.epoch;
    const revision = record.queueRevision;
    const key = completed.id + ':' + revision;
    const viewer = [...room.viewers.values()][0];
    const plex = viewer && this.hub.plexFor ? await this.hub.plexFor(viewer.actor) : this.plex;
    if (!plex || typeof plex.nextEpisodeOffer !== 'function') {
      room.endingOffer = { key, offer: null };
      return;
    }
    try {
      const offer = await plex.nextEpisodeOffer(completed.mediaId);
      if (room.epoch !== epoch || this.roomState.store.get(record.id)?.queueRevision !== revision) return;
      room.endingOffer = { key, offer: offer || null };
      if (offer) {
        room.endingMeta ||= new Map();
        room.endingMeta.set(offer.mediaId, {
          summary: offer.summary || '',
          subtitle: offer.subtitle || '',
          hasLandscape: offer.hasLandscape,
          hasPoster: offer.hasPoster,
        });
        room.revision++;
      }
    } catch {
      if (room.epoch === epoch && this.roomState.store.get(record.id)?.queueRevision === revision) {
        room.endingOffer = { key, offer: null };
      }
    }
  }
  /**
   * @param {Room} room
   * @param {{intent?: number, data?: any}} [options]
   */
  async startAutoplayCountdown(room, { intent = room.playbackIntent || 0, data } = {}) {
    if (this.shuttingDown || room.closed) return;
    const record = this.roomState.store.get(room.roomId);
    if (!record || !record.autoplay || room.autoplayCountdown || room.transition || room.manualPaused) return;
    const hostConnected = [...room.viewers.values()].some(v => isHost(room, v.actor) || this.hub.isAdmin(v.actor));
    const controller =
      !room.waitingForHost &&
      [...room.viewers.entries()].find(
        ([, person]) =>
          (this.hub.authorize(person.actor, room, 'chooseMedia').ok ||
            this.hub.authorize(person.actor, room, 'playPause').ok) &&
          this.hub.authorize(person.actor, room, 'autoplay').ok &&
          (hostConnected ||
            isHost(room, person.actor) ||
            this.hub.isAdmin(person.actor) ||
            this.hub.authorize(person.actor, room, 'continueWithoutHost').ok),
      );
    if (!controller) return;
    const [viewerId, person] = controller;
    if (
      (person.alive && !(await person.alive())) ||
      !(await this.canView(room, person.actor)) ||
      room.viewers.get(viewerId) !== person ||
      this.rooms.get(record.id) !== room ||
      room.manualPaused ||
      (data &&
        (room.epoch !== data.epoch ||
          (room.endedVersion !== data.mediaVersion && room.mediaVersion !== data.mediaVersion))) ||
      room.autoplayCountdown ||
      room.transition ||
      (room.playbackIntent || 0) !== intent ||
      !this.roomState.store.get(record.id).autoplay
    )
      return;
    const latest = this.roomState.store.get(record.id);
    const next = this.nextCandidate(record.id);
    if (!next) return;
    clearTimeout(room.autoplayTimer);
    const now = this.clock.now();
    const countdown = {
      id: randomUUID(),
      title: next.title,
      startedAt: now,
      durationMs: this.autoplayDelayMs,
      endsAt: now + this.autoplayDelayMs,
      epoch: room.epoch,
      mediaVersion: room.mediaVersion,
      currentEntryId: null,
      nextEntryId: next.id,
      nextKey: next.id || next.serverId + ':' + next.mediaId,
      queueRevision: latest.queueRevision,
      viewerId,
    };
    room.autoplayCountdown = countdown;
    room.autoplayError = undefined;
    room.revision++;
    this.preloadNext(room, countdown, next, person.actor);
    room.autoplayTimer = setTimeout(() => {
      const advance = this.hub
        .dispatch(
          { ...person.actor, watchViewerId: viewerId, watchQueueAdvance: countdown },
          { roomId: record.id, action: 'media.next' },
        )
        .then(result => {
          if (result.status !== 'applied' && room.autoplayCountdown === countdown) {
            this.cancelAutoplay(room);
            room.autoplayError = result.message || 'The next video could not be loaded.';
            room.revision++;
          }
        })
        .catch(() => {
          this.cancelAutoplay(room);
          room.autoplayError = 'The next video could not be loaded.';
          room.revision++;
        });
      this.roomState.track(advance);
    }, this.autoplayDelayMs);
    room.autoplayTimer.unref?.();
  }
  finishQueueMedia(room, data) {
    if (this.shuttingDown || room.closed) return Promise.resolve();
    return this.startMediaWork(room, work => this.finishQueueMediaOwned(room, data, work), {
      kind: 'transition',
      signal: currentSignal(),
    }).promise;
  }
  async finishQueueMediaOwned(room, data, work) {
    if (room.autoplayCountdown || room.transition || room.endedVersion === room.mediaVersion) return;
    const endedVersion = room.mediaVersion;
    room.endedVersion = endedVersion;
    room.initialGate = false;
    room.readinessTimedOut = false;
    room.readinessVersion = randomUUID();
    room.readinessStartAt = room.pauseAt = room.startAt = undefined;
    if (room.media) room.position = room.media.duration;
    room.changedAt = this.clock.now();
    room.state.paused = true;
    room.revision++;
    const record = this.roomState.store.get(room.roomId),
      current = this.roomState.queue.current(record.id);
    room.transition = { kind: 'media' };
    try {
      const completing = (async () => {
        await room.saving?.catch(() => {});
        work.signal.throwIfAborted();
        work.committing = true;
        if (current) await this.roomState.queue.completeCurrent(record.id);
        this.unloadQueueMedia(room);
        room.endedVersion = endedVersion;
        room.manualPaused = false;
      })();
      room.transition.commit = completing;
      await completing;
      delete room.transition?.commit;
      await this.roomState.save(room);
      this.roomState.apply(room, this.roomState.store.get(record.id));
      room.revision++;
      this.prepareStreams(room);
    } finally {
      delete room.transition?.commit;
      if (room.transition?.kind === 'media') room.transition = undefined;
    }
    await this.refreshEndingMeta(room);
    let latestRecord = this.roomState.store.get(record.id);
    let next = this.nextCandidate(record.id);
    if (!next && latestRecord.autoQueue.mode !== 'off') {
      try {
        const actor = room.viewers.get(room.hostViewerId)?.actor || [...room.viewers.values()][0]?.actor;
        if (actor) {
          const corpus = await this.autoCorpus(record.id, actor);
          if (corpus) {
            await this.roomState.queue.generate(record.id, actor.userId, corpus, {
              expectedRevision: latestRecord.queueRevision,
            });
            await this.verifyAutoNext(record.id, actor, corpus);
            latestRecord = this.roomState.store.get(record.id);
            this.roomState.apply(room, latestRecord);
            next = this.nextCandidate(record.id);
          }
        }
      } catch {}
    }
    if (next && latestRecord.autoplay) {
      await this.startAutoplayCountdown(room, { intent: room.playbackIntent || 0, data });
    } else if (!next && current?.type === 'episode' && latestRecord.autoQueue.mode === 'off') {
      await this.resolveEndingOffer(room, current);
    }
  }
  unloadQueueMedia(room) {
    const old = room.media;
    room.media = undefined;
    room.mediaVersion = randomUUID();
    room.readinessVersion = undefined;
    room.position = 0;
    room.changedAt = this.clock.now();
    room.pauseAt = room.startAt = undefined;
    room.initialGate = false;
    room.manualPaused = true;
    room.readinessTimedOut = false;
    room.endedVersion = undefined;
    room.state.paused = true;
    room.state.position = 0;
    room.state.duration = 0;
    room.state.seekable = false;
    this.dropMedia(room, 'end');
    if (old) void this.stopMedia(room, old);
  }
  changeQueueMedia(room, command, actor, permitted, options) {
    if (this.shuttingDown || room.closed)
      return Promise.resolve({ status: 'unavailable', message: 'Room is closing.' });
    return this.startMediaWork(
      room,
      work =>
        this.changeQueueMediaOwned(room, command, actor, () => !work.signal.aborted && permitted(), options, work),
      { kind: 'transition', signal: currentSignal() },
    ).promise;
  }
  async changeQueueMediaOwned(room, command, actor, permitted, { initialAdd = false, forcePlay = false } = {}, work) {
    if (room.transition) return { status: 'unavailable', message: 'Wait for the current queue operation.' };
    if (
      !room.viewers.size &&
      command.action !== 'media.load' &&
      !(command.action === 'queue.remove' && !command.args.advance)
    )
      return { status: 'unavailable', message: 'No viewer is connected.' };
    const { action, args } = command,
      id = room.roomId,
      queue = this.roomState.queue,
      countdown = actor.watchQueueAdvance;
    const preload = countdown && room.preload?.countdown === countdown.id ? room.preload : undefined;
    const version = room.mediaVersion,
      epoch = room.epoch,
      intent = room.playbackIntent || 0;
    const record = this.roomState.store.get(id),
      current = record && queue.current(id),
      next = record && this.nextCandidate(id);
    const valid = () =>
      !this.shuttingDown &&
      !room.closed &&
      permitted() &&
      this.rooms.get(id) === room &&
      room.mediaVersion === version &&
      room.epoch === epoch &&
      // A play or pause cancels an automatic advance, but not a video someone chose.
      (!countdown ||
        ((room.playbackIntent || 0) === intent &&
          room.autoplayCountdown === countdown &&
          room.viewers.has(countdown.viewerId) &&
          !room.manualPaused &&
          this.roomState.store.get(id).autoplay &&
          countdown.epoch === epoch &&
          countdown.mediaVersion === version &&
          (countdown.currentEntryId || null) === (current?.id || null) &&
          countdown.nextEntryId === next?.id &&
          countdown.queueRevision === record.queueRevision &&
          this.hub.authorize(actor, room, 'autoplay').ok));
    if (!valid()) return { status: 'unavailable', message: 'Autoplay or media selection was cancelled.' };
    const removing = action === 'queue.remove',
      advance = removing && args.advance;
    if (removing && current?.id !== args.entryId)
      return { status: 'unavailable', message: 'Current video changed; refresh before removing.' };
    let target,
      prepared,
      adopted = false;
    const old = room.media,
      oldPosition = this.position(room),
      restore = action === 'queue.history.goBack',
      replay = action === 'queue.history.replay' || restore,
      playEntry = action === 'queue.playEntry',
      playAuto = action === 'queue.auto.playNow';
    if (replay) {
      target = queue.getEntry(args.entryId);
      if (!target || target.roomId !== id || target.state !== 'history')
        throw Object.assign(new Error('History entry unavailable'), { status: 404 });
    } else if (playEntry) {
      target = queue.getEntry(args.entryId);
      if (!target || target.roomId !== id || target.state !== 'pending')
        throw Object.assign(new Error('Queue entry unavailable'), { status: 404 });
    } else if (playAuto) {
      target = record?.autoQueue?.mode !== 'off' ? record?.autoQueue?.next : null;
      if (!target) throw Object.assign(new Error('Auto-queue item unavailable'), { status: 404 });
    } else if (action === 'media.next' || advance) {
      target = record ? next : old?.nextId && { mediaId: old.nextId };
      if (!target) return { status: 'unsupported', message: 'No next video is available.' };
    } else if (action === 'media.previous') {
      target =
        oldPosition < (record ? 5 : 3) &&
        (record ? queue.lastHistory(id) : old?.previousId && { mediaId: old.previousId });
    } else if (!removing) target = { mediaId: args.mediaId };
    room.transition = { kind: 'media' };
    // Transfer only after admission/target checks, inside the cleanup scope.
    if (preload) room.preload = undefined;
    try {
      await room.saving?.catch(() => {});
      if (target) {
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        // A failed preload is this load's failure; preparing again would only repeat it.
        const preloaded = preload?.mediaId === target.mediaId ? await preload.source : undefined;
        if (preloaded && preloaded.principal === plex.principal) preload.sourceAdopted = true;
        prepared =
          target.mediaId === 'demo'
            ? this.demoMedia && { ...this.demoMedia, id: 'demo', resources: new Map() }
            : preload?.sourceAdopted
              ? preloaded
              : await plex.prepare(target.mediaId, 'direct', false, undefined, undefined, { sourceOnly: true });
        if (!prepared) return { status: 'failed', message: 'Test video is unavailable.' };
        if (record) {
          prepared.roomServerId = await this.roomState.identify(prepared);
          if (
            target.serverId &&
            (target.serverId !== prepared.roomServerId ||
              Math.abs(target.duration - prepared.duration) > 0.5 ||
              (prepared.source?.type && target.type !== prepared.source.type))
          )
            throw Object.assign(new Error('The queued video changed; choose it again from the library'), {
              status: 409,
            });
        }
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
          return { status: 'unavailable', message: 'Plex access changed.' };
      }
      let corpus;
      if (record && (action === 'media.next' || advance || playEntry || playAuto)) {
        const pendingItems = queue.pending(id);
        let postAnchor = target;
        if (action === 'media.next' || advance) {
          if (queue.peekNext(id) && pendingItems.length > 1) postAnchor = pendingItems[pendingItems.length - 1];
        } else if (playAuto) {
          if (!args.skipPrevious && pendingItems.length > 0) postAnchor = pendingItems[pendingItems.length - 1];
        } else if (playEntry) {
          const remaining = pendingItems.filter(item =>
            args.skipPrevious ? item.rank > target.rank : item.id !== target.id,
          );
          if (remaining.length > 0) postAnchor = remaining[remaining.length - 1];
        }
        corpus = await this.autoCorpus(id, actor, record.autoQueue, postAnchor);
      }
      const person = room.viewers.get(actor.watchViewerId);
      if (
        (countdown && (!person || (person.alive && !(await person.alive())))) ||
        (actor.watchCurrent && !(await actor.watchCurrent())) ||
        !(await this.canView(room, actor)) ||
        !valid()
      )
        return { status: 'unavailable', message: 'Room changed or command expired.' };
      if (record) {
        queue.assertRevision(queue.room(id), record.queueRevision);
        const position = this.position(room);
        let saving;
        const startPosition =
          Number.isFinite(Number(args.position)) && Number(args.position) > 0
            ? Math.min(Number(args.position), prepared.duration)
            : 0;
        if (action === 'media.next' || advance)
          saving = queue.next(id, actor.userId, {
            currentPosition: countdown || room.endedVersion === version ? old?.duration || 0 : position,
            outcome: countdown || room.endedVersion === version ? 'completed' : 'skipped',
            expectedRevision: record.queueRevision,
            currentEntryId: current?.id,
            nextEntryId: target.id,
            autoCorpus: corpus,
            guard: valid,
            discardCurrent: !!advance,
            initialAdd,
          });
        else if (playAuto)
          saving = queue.playAutoNow(id, actor.userId, {
            currentPosition: countdown || room.endedVersion === version ? old?.duration || 0 : position,
            expectedRevision: record.queueRevision,
            autoCorpus: corpus,
            guard: valid,
            skipPrevious: !!args.skipPrevious,
          });
        else if (removing)
          saving = queue.remove(id, actor.userId, args.entryId, record.queueRevision, { allowCurrent: true });
        else if (replay)
          saving = queue.historyReplay(
            id,
            actor.userId,
            target.id,
            { resume: args.resume, restore, expectedRevision: record.queueRevision },
            position,
          );
        else if (playEntry)
          saving = queue.playEntry(id, actor.userId, target.id, {
            skipPrevious: !!args.skipPrevious,
            currentPosition: position,
            expectedRevision: record.queueRevision,
            autoCorpus: corpus,
            guard: valid,
            initialAdd,
          });
        else if (action === 'media.previous') saving = queue.previous(id, actor.userId, oldPosition, 5);
        else
          saving = queue.playNow(
            id,
            actor.userId,
            this.queueItem(
              { ...prepared, type: prepared.source?.type || 'movie', position: startPosition },
              prepared.roomServerId,
            ),
            position,
            { initialAdd },
          );
        room.transition.commit = saving;
        work.committing = true;
        await saving;
        this.roomState.apply(room, this.roomState.store.get(id));
      }
      // The durable transaction is the transition's commit point. Close waits
      // for it; later controls apply to the newly adopted generation.
      room.pauseAt = room.startAt = undefined;
      if (removing && !advance) {
        this.cancelAutoplay(room);
        clearPlaybackEnd(room);
        this.unloadQueueMedia(room);
      } else if (prepared) {
        const startPosition =
          Number.isFinite(Number(args.position)) && Number(args.position) > 0
            ? Math.min(Number(args.position), prepared.duration)
            : 0;
        room.media = prepared;
        room.mediaVersion = randomUUID();
        room.readinessVersion = undefined;
        this.mediaChecks.start(prepared);
        room.position = record ? queue.current(id).position : startPosition;
        room.changedAt = this.clock.now();
        if (room.recovery) this.roomState.finishRecovery(room);
        this.dropMedia(room);
        room.state.paused = true;
        room.manualPaused = forcePlay ? false : initialAdd && !this.roomState.store.get(id).autoplay;
        room.initialGate = true;
        this.beginReadiness(room);
        room.initialViewers = new Set(room.viewers.keys());
        room.state.seekable = true;
        void this.stopMedia(room, old);
        adopted = true;
        // Viewers adopt their preloaded streams on their next poll; leftovers are stopped.
        if (preload?.sourceAdopted && preload.source && prepared === (await preload.source.catch(() => undefined))) {
          if (preload.fallbackStream) {
            room.fallbackStream = preload.fallbackStream;
            preload.fallbackStream = undefined;
            const version = room.mediaVersion;
            room.fallbackStream.authorized = async () =>
              this.rooms.get(id) === room &&
              room.mediaVersion === version &&
              room.viewers.size > 0 &&
              (await this.canView(room, actor));
            room.fallbackStream.reconcile(this.position(room), false);
          }
          room.adoptable = preload;
          preload.expiry = setTimeout(() => this.dropPreload(room, preload), 60000);
          preload.expiry.unref?.();
        }
      } else {
        this.cancelAutoplay(room);
        clearPlaybackEnd(room);
        room.position = 0;
        room.changedAt = this.clock.now();
        if (!room.state.paused || room.initialGate) {
          room.readinessVersion = randomUUID();
          room.initialGate = true;
          room.state.paused = true;
          this.beginReadiness(room);
          room.initialViewers = new Set(room.viewers.keys());
          for (const viewer of room.viewers.values()) viewer.ready = false;
        }
      }
      room.autoplayError = undefined;
      room.revision++;
      room.lastActivity = this.clock.now();
      delete room.transition?.commit;
      if (record && this.roomState.store.get(id).autoQueue.mode !== 'off') {
        try {
          let postCorpus = corpus;
          if (!['media.next', 'queue.playEntry', 'queue.auto.playNow'].includes(action) && !advance) {
            postCorpus = await this.autoCorpus(id, actor);
            if (postCorpus) await queue.generate(id, actor.userId, postCorpus, { continuation: true });
          }
          await this.verifyAutoNext(id, actor, postCorpus);
          this.roomState.apply(room, this.roomState.store.get(id));
        } catch (error) {
          room.autoQueueError = error.message;
        }
      }
      // New media (or a restart of the current one): prepare everyone's stream now.
      this.prepareStreams(room);
      return {
        status: 'applied',
        message: 'Viewing room updated.',
        ...(initialAdd ? { added: queue.current(id), queueRevision: this.roomState.store.get(id).queueRevision } : {}),
      };
    } catch (error) {
      if (work.signal.aborted && !work.committing)
        return { status: 'unavailable', message: 'Media selection was cancelled.' };
      room.autoplayError =
        error.status || error instanceof PlaybackError
          ? error.message
          : 'The next video could not be loaded. Check Plex and server storage.';
      room.revision++;
      return { status: 'failed', message: room.autoplayError };
    } finally {
      delete room.transition?.commit;
      if (room.transition?.kind === 'media') room.transition = undefined;
      if (prepared && !adopted) await this.plex.stop(prepared);
      if (preload && room.adoptable !== preload) {
        if (!adopted) preload.sourceAdopted = false;
        this.dropPreload(room, preload);
      }
    }
  }
  async execute(room, input, actor, permitted) {
    if (this.shuttingDown || room.closed) return { status: 'unavailable', message: 'Room is closing.' };
    const command = Engine.validate(input),
      { action, args } = command,
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(action));
    this.roomState.store.healthy();
    if (declared.service === 'publish' || declared.service === 'unpublish') {
      return this.publications.command(room, action, actor, permitted);
    }
    if (action === 'room.kick') {
      if (room.transition?.commit) await room.transition?.commit.catch(() => {});
      if (!permitted() || (actor.watchCurrent && !(await actor.watchCurrent())) || !permitted())
        return { status: 'unavailable', message: 'Room changed or command expired.' };
      const record = this.roomState.store.get(room.roomId),
        userId = args.userId;
      if (
        !this.hub.authorize(actor, room, 'kickParticipants').ok ||
        !RoomPolicy.canKickParticipant(record, actor.userId, userId, { isAdmin: this.hub.isAdmin(actor) })
      )
        return { status: 'forbidden', message: 'You cannot kick this participant.' };
      const viewers = [...room.viewers.entries()].filter(([, viewer]) => viewer.userId === userId);
      if (!viewers.length) return { status: 'unavailable', message: 'This participant has already left.' };
      this.coordinator.run(room, { type: 'kick', userId });
      if (room.closed) await room.removal;
      // Kicking a guest ends their guest access; kicking someone invited into a
      // private room revokes the invite. Either way they stay out until the code changes.
      const guest = this.hub.guestMembers?.(room.roomId).has(userId);
      if (guest) {
        const devices = viewers.map(([, viewer]) => viewer.actor.device).filter(Boolean);
        await this.roomState.store.block(room.roomId, ['user:' + userId, ...devices.map(device => 'device:' + device)]);
        await this.hub.endGuestSessions?.(room.roomId, [userId]);
        return { status: 'applied', message: 'Guest removed.' };
      }
      if (room.visibility === 'private' && record.invited?.includes(userId)) {
        this.roomState.apply(room, await this.roomState.store.revokeInvite(room.roomId, userId));
        return { status: 'applied', message: 'Participant removed and their invite revoked.' };
      }
      return { status: 'applied', message: 'Participant removed. They may rejoin.' };
    }
    if (!permitted()) return { status: 'unavailable', message: 'Room changed or command expired.' };
    if (room.transition?.commit)
      return { status: 'unavailable', message: 'Wait for the current queue transition to finish.' };
    if (!room.media && ['media.play', 'media.toggle'].includes(action) && this.nextCandidate(room.roomId)) {
      if (!this.hub.authorize(actor, room, 'playPause').ok && !this.hub.authorize(actor, room, 'chooseMedia').ok) {
        return { status: 'forbidden', message: 'Starting the next video requires permission.' };
      }
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      return this.changeQueueMedia(room, { action: 'media.next', args: {} }, actor, permitted);
    }
    if (!room.media && room.autoplayCountdown && action === 'media.pause') {
      if (!this.hub.authorize(actor, room, 'playPause').ok)
        return { status: 'forbidden', message: 'Pausing requires playback permission.' };
      this.cancelAutoplay(room);
      room.manualPaused = true;
      room.endedVersion = undefined;
      return { status: 'applied', message: 'Autoplay paused.' };
    }
    if (!room.media && room.endedVersion && (action === 'media.seek.end' || action.startsWith('media.seek.'))) {
      if (!this.hub.authorize(actor, room, 'playPause').ok)
        return { status: 'forbidden', message: 'Seeking requires playback permission.' };
      return { status: 'applied', message: 'Current video finished.' };
    }
    const endpointSeek =
      room.media &&
      (action === 'media.seek.end' ||
        (action === 'media.seek.absolute' && args.seconds >= room.media.duration) ||
        (action === 'media.seek.relative' && this.position(room) + args.seconds >= room.media.duration));
    const endpointPlay =
      room.media &&
      ['media.play', 'media.toggle'].includes(action) &&
      (room.endedVersion === room.mediaVersion || this.position(room) >= room.media.duration - 0.1);
    if (endpointSeek || endpointPlay) {
      if (!room.viewers.size || room.transition)
        return { status: 'unavailable', message: 'Wait for an available viewing room.' };
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (room.recovery) this.roomState.finishRecovery(room);
      room.manualPaused = false;
      room.endedVersion = undefined;
      await this.finishQueueMedia(room, { mediaVersion: room.mediaVersion, epoch: room.epoch });
      return { status: 'applied', message: 'Current video finished.' };
    }
    if (action.startsWith('queue.')) return this.queueCommand(room.roomId, command, actor, permitted);
    if (action.startsWith('media.autoplay.')) {
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (action === 'media.autoplay.cancel') room.endedVersion = undefined;
      if (action === 'media.autoplay.set') {
        await this.roomState.queue.setAutoplay(room.roomId, actor.userId, args.enabled);
        this.roomState.apply(room, this.roomState.store.get(room.roomId));
        if (args.enabled && !room.media) {
          const next = this.nextCandidate(room.roomId);
          if (next) await this.startAutoplayCountdown(room);
        }
      }
      return { status: 'applied', message: 'Autoplay updated.' };
    }
    if (!actor.watchQueueAdvance && declared.persists) {
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (action !== 'media.next') room.endedVersion = undefined;
    }
    if (['media.load', 'media.next', 'media.previous'].includes(action))
      return this.changeQueueMedia(room, command, actor, permitted);
    this.settle(room);
    if (action.startsWith('media.ready.')) {
      if (!this.hub.authorize(actor, room, 'chooseMedia').ok)
        return { status: 'unavailable', message: 'This readiness choice expired.' };
      const outcome = applyReadinessDecision(room, action, args.readinessId);
      if (outcome.status !== 'applied') return { status: outcome.status, message: outcome.message };
      this.review(room);
      return { status: 'applied', message: outcome.message };
    }
    if (room.readinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(action))
      return { status: 'unavailable', message: 'The host must choose whether to start, wait or cancel.' };
    if (declared.scope === 'personal') {
      const viewer = room.viewers.get(actor.watchViewerId);
      if (!viewer || viewer.userId !== actor.userId)
        return { status: 'unsupported', message: 'Use your watch player for personal audio and quality.' };
      if (declared.handler === 'tracks') return this.changeTracks(room, viewer, args, actor, permitted);
      if (declared.handler === 'stream') return this.refreshStream(room, viewer, args, actor, permitted);
      if (declared.handler === 'quality') {
        if (!args.compatible && !args.fallback && args.quality)
          viewer.preferredQuality = Engine.qualityId(args.quality);
        if (!room.media || room.media.kind === 'demo')
          return { status: 'applied', message: 'Preferred quality updated for future videos.' };
        if (viewer.preparing || viewer.updating)
          return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
        if (args.reset) {
          viewer.fallback = undefined;
          viewer.compatible = false;
        }
        const fallback = args.fallback || viewer.fallback;
        if (args.fallback)
          this.hub?.config?.logger?.info(
            'Delivery',
            `Viewer "${viewer.name || actor.userId}" moving to ${args.fallback}: ${args.reason || 'no reason given'}`,
          );
        viewer.updating = true;
        try {
          const result = await this.replaceViewer(
            room,
            actor,
            actor.watchViewerId,
            async (authorized, source) =>
              this.prepareQuality(
                room,
                viewer,
                await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
                source,
                args.quality,
                args.compatible === true || !!viewer.compatible,
                fallback,
                authorized,
              ),
            { permitted },
          );
          if (result.status !== 'applied') {
            this.hub?.config?.logger?.warn(
              'Delivery',
              `Quality change not applied: ${result.message || result.status}`,
            );
            return result;
          }
          viewer.quality = viewer.media.quality;
          viewer.compatible = args.compatible === true || !!viewer.compatible;
          viewer.fallback = fallback;
        } catch (error) {
          if (error instanceof PlaybackError) {
            this.hub?.config?.logger?.warn('Delivery', `Quality change failed: ${error.message}`);
            return { status: 'failed', message: error.message };
          }
          throw error;
        } finally {
          viewer.updating = false;
        }
      } else if (declared.handler === 'player') {
        if (action === 'media.volume.set') {
          viewer.volume = args.percent;
          viewer.muted = false;
        } else viewer.muted = action === 'media.mute';
      } else if (declared.handler === 'reporting') {
        if (typeof args.activity === 'boolean') viewer.plexReporting = args.activity;
        if (typeof args.watchState === 'boolean') viewer.plexWatchState = args.watchState;
        this.reporting?.updateConsent(viewer, { activity: viewer.plexReporting, watchState: viewer.plexWatchState });
        return {
          status: 'applied',
          message: 'Your reporting preferences updated.',
          state: Engine.snapshot({ ...room.state, volume: viewer.volume, muted: viewer.muted }),
          plexReporting: {
            eligible: !!this.reporting?.isEligible(actor.userId),
            activity: viewer.plexReporting !== false,
            watchState: !!(viewer.plexWatchState && this.hub?.config?.plexReporting?.watchState !== false),
            watchStateAllowed: this.hub?.config?.plexReporting?.watchState !== false,
          },
        };
      }
      return {
        status: 'applied',
        message: 'Your player updated.',
        state: Engine.snapshot({ ...room.state, volume: viewer.volume, muted: viewer.muted }),
      };
    }
    if (
      actor.watchAutoplayVersion &&
      (room.manualPaused ||
        room.mediaVersion !== actor.watchAutoplayVersion ||
        room.readinessVersion !== actor.watchReadinessVersion)
    )
      return { status: 'unavailable', message: 'Autoplay was cancelled.' };
    if (!action.startsWith('room.') && action !== 'media.load' && !room.viewers.size)
      return { status: 'unavailable', message: 'No viewer is connected.' };
    if (action.startsWith('media.') && action !== 'media.load' && !room.media)
      return { status: 'unavailable', message: 'Choose a video first.' };
    if (['media.play', 'media.toggle'].includes(action) && room.media?.kind !== 'demo') {
      const version = room.mediaVersion;
      // An outage must not stop anyone resuming media already buffered. A file
      // Plex confirms is missing still refuses, and access is checked below.
      let plex,
        unconfirmed = false;
      try {
        plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        if (plex.playableItem) await plex.playableItem(room.media.id);
      } catch (error) {
        if (!this.providerFailed(error)) throw error;
        unconfirmed = true;
      }
      if (
        !permitted() ||
        room.mediaVersion !== version ||
        !(await this.canView(room, actor)) ||
        !permitted() ||
        (!unconfirmed && this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
      )
        return { status: 'unavailable', message: 'Room changed or command expired.' };
    }
    if (
      room.recovery &&
      (['media.pause', 'media.play', 'media.toggle'].includes(action) || action.startsWith('media.seek.'))
    )
      this.roomState.finishRecovery(room);
    const now = this.clock.now();
    if (!applyTimelineCommand(room, command, { now, autoplayVersion: actor.watchAutoplayVersion })) {
      room.position = this.position(room, now);
      room.changedAt = now;
      if (action === 'room.visibility') {
        const record = await this.roomState.store.edit(room.roomId, actor.userId, room.saved.revision, {
          action: 'visibility',
          visibility: args.visibility,
        });
        this.roomState.apply(room, record);
        this.coordinator.run(room, { type: 'visibility' });
      }
    }
    if (action.startsWith('room.')) room.epoch = randomUUID();
    room.revision++;
    room.lastActivity = now;
    this.review(room);
    room.feedback = { revision: room.revision, action, args, sender: Engine.senderName(actor.name), at: now };
    if (declared.persists) await this.roomState.save(room);
    return {
      status: 'applied',
      message: 'Viewing room updated.',
      state: Engine.snapshot(room.state),
    };
  }
  async changeTracks(room, viewer, args, actor, permitted) {
    const current = viewer.media,
      version = room.mediaVersion;
    if (!current?.tracks || current.kind !== 'plex')
      return { status: 'unsupported', message: 'Audio and subtitles are unavailable for this video.' };
    if (viewer.preparing || viewer.updating)
      return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
    if (args.mediaVersion !== version || args.streamVersion !== viewer.streamVersion)
      return { status: 'unavailable', message: 'Track selection expired. Choose again for the current video.' };
    const choices = {
      ...viewer.trackChoice,
      audioId: args.audioId ?? viewer.trackChoice?.audioId ?? 'auto',
      subtitleId: args.subtitleId ?? viewer.trackChoice?.subtitleId ?? 'auto',
      subtitleMode: args.subtitleMode ?? viewer.trackChoice?.subtitleMode ?? 'auto',
    };
    if (args.audioId === 'auto') choices.audioIntent = undefined;
    if (['auto', 'off'].includes(args.subtitleId)) choices.subtitleIntent = undefined;
    let selection;
    viewer.updating = true;
    try {
      selection = Tracks.select(current.tracks, choices);
      if (selection.subtitle?.delivery === 'burn' && args.subtitleOffset !== undefined && args.subtitleOffset !== 0)
        throw new PlaybackError('Burned subtitles cannot be shifted in this player.');
      if (args.audioId && args.audioId !== 'auto') choices.audioIntent = Tracks.intent(selection.audio);
      if (args.subtitleId && !['auto', 'off'].includes(args.subtitleId))
        choices.subtitleIntent = Tracks.intent(selection.subtitle);
      const burnChanged =
        (selection.subtitle?.delivery === 'burn' || current.selection.subtitle?.delivery === 'burn') &&
        (selection.subtitle?.id !== current.selection.subtitle?.id ||
          selection.subtitle?.delivery !== current.selection.subtitle?.delivery);
      if (selection.audio?.id !== current.selection.audio?.id || burnChanged || current.playbackError) {
        const result = await this.replaceViewer(
          room,
          actor,
          actor.watchViewerId,
          async (authorized, source) =>
            this.prepareQuality(
              room,
              viewer,
              await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
              source,
              viewer.quality,
              viewer.compatible,
              viewer.fallback,
              {
                ...choices,
                browserSubtitles: viewer.browserSubtitles,
                localCodecs: viewer.localCodecs,
                shareKey: [room.roomId, version],
                authorized,
              },
            ),
          { permitted },
        );
        if (result.status !== 'applied') return result;
      } else {
        const alive = !viewer.alive || (await viewer.alive()),
          access = await this.canView(room, actor);
        if (
          !alive ||
          !access ||
          !permitted() ||
          version !== room.mediaVersion ||
          viewer.media !== current ||
          room.viewers.get(actor.watchViewerId) !== viewer
        )
          return { status: 'unavailable', message: 'Room changed or command expired.' };
        if (selection.subtitle?.id !== current.selection.subtitle?.id) {
          current.subtitleAbort.abort();
          current.subtitleAbort = new AbortController();
          current.subtitleCache?.clear();
          SubtitleResources.clear(current);
          current.captionVersion = randomUUID();
        }
        current.selection = selection;
      }
      viewer.trackChoice = choices;
      if (selection.subtitle?.delivery === 'burn') viewer.subtitleOffset = 0;
      else if (args.subtitleOffset !== undefined) viewer.subtitleOffset = args.subtitleOffset;
      return { status: 'applied', message: 'Your audio and subtitles updated.' };
    } catch (error) {
      return {
        status: 'failed',
        message:
          error instanceof PlaybackError
            ? error.message
            : 'Audio and subtitles could not be updated. Your previous selection is unchanged.',
      };
    } finally {
      viewer.updating = false;
    }
  }
  async refreshStream(room, viewer, args, actor, permitted) {
    const current = viewer.media,
      version = room.mediaVersion;
    if (!current || current.kind !== 'plex' || !room.media || current.format !== 'hls')
      return { status: 'unsupported', message: 'This stream cannot be refreshed.' };
    if (viewer.preparing || viewer.updating)
      return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
    if (args.mediaVersion !== version || args.streamVersion !== viewer.streamVersion)
      return { status: 'unavailable', message: 'Stream refresh expired.' };
    viewer.updating = true;
    try {
      const result = await this.replaceViewer(
        room,
        actor,
        actor.watchViewerId,
        async (authorized, source) =>
          this.prepareQuality(
            room,
            viewer,
            await (this.hub.plexFor ? this.hub.plexFor(actor) : this.plex),
            source,
            viewer.quality,
            viewer.compatible,
            viewer.fallback,
            {
              ...viewer.trackChoice,
              browserSubtitles: viewer.browserSubtitles,
              shareKey: [room.roomId, version],
              excludeLease: current.hlsLease,
              authorized,
            },
          ),
        { permitted, accept: media => media.format === 'hls' },
      );
      return result.status === 'applied' ? { status: 'applied', message: 'Your stream refreshed.' } : result;
    } catch (error) {
      return {
        status: 'failed',
        message: error instanceof PlaybackError ? error.message : 'Plex could not refresh this stream.',
      };
    } finally {
      viewer.updating = false;
    }
  }

  /** Closes a room: an event in its mailbox, whose effect is removeRoom. */
  remove(id, save = true) {
    const room = this.rooms.get(id);
    if (!room) return;
    if (!room.removal) this.coordinator.run(room, { type: 'close', save });
    return room.removal;
  }
  // The server's half of closing a room: drain its media work, save it and let it go.
  removeRoom(room, save = true) {
    const id = room.roomId;
    if (room.removal) return room.removal;
    room.removalAt = this.clock.now();
    if (!this.shuttingDown) this.publications.roomClosed(id);
    this.cancelAutoplay(room);
    const pending = [...this.mediaWork].some(work => work.room === room);
    if (pending || room.transition?.commit) {
      room.removal = this.drainMedia(room).then(
        () => this.removeNow(room, save),
        async error => {
          await this.removeNow(room, save);
          throw error;
        },
      );
      return room.removal;
    }
    return (room.removal = this.removeNow(room, save));
  }
  removeNow(room, save) {
    const id = room.roomId;
    this.cancelAutoplay(room);
    clearPlaybackEnd(room);
    const saved = save
      ? this.roomState.save(room, { closing: !this.shuttingDown, final: true }).then(async () => {
          if (!this.shuttingDown) {
            this.roomState.recoveries.delete(id);
            await this.roomState.deleteEmpty(id);
          }
        })
      : Promise.resolve();
    this.roomState.closing.set(id, saved);
    saved.then(
      () => this.roomState.closing.delete(id),
      () => this.roomState.closing.delete(id),
    );
    room.state.paused = true;
    room.epoch = randomUUID();
    this.dropMedia(room, 'room-closed');
    this.hub.rooms.delete(id);
    this.coordinator.delete(id);
    clearInterval(room.transcodePing);
    clearInterval(room.fallbackTimer);
    void this.stopMedia(room, room.media);
    this.dropPreload(room);
    this.dropPreload(room, room.adoptable);
    this.hub?.config?.logger?.info('Room', `Room closed (${id})`);
    return saved.finally(() => this.drainMedia(room));
  }
  // Server maintenance, not room lifecycle: Plex transcode sessions nothing holds are ended once a minute.
  maintainPlexSessions() {
    if (this.plex.configured && !this.shuttingDown && Date.now() - (this.sessionsCheckedAt || 0) >= 60000) {
      this.sessionsCheckedAt = Date.now();
      void this.reconcilePlexSessions().catch(() => {});
    }
  }
  /** Transcode sessions that something in uburoom still holds. */
  plexSessionsInUse() {
    const ids = new Set(),
      add = media => {
        if (media?.transcodeId) ids.add(media.transcodeId);
      };
    for (const room of this.rooms.values()) {
      add(room.media);
      for (const viewer of room.viewers.values()) add(viewer.media);
      for (const viewer of room.disconnectedViewers.values()) add(viewer.media);
    }
    for (const group of this.plex.hlsPool?.groups?.values() || []) add(group.media);
    return ids;
  }
  async reconcilePlexSessions() {
    this.plexSessions = { ...(await this.plex.reconcileSessions(this.plexSessionsInUse())), checkedAt: Date.now() };
    return this.plexSessions;
  }
  close() {
    if (this.closing) return this.closing;
    this.shuttingDown = true;
    this.shutdownDeadline = AbortSignal.timeout(this.mediaDrainMs);
    this.coordinator.close();
    if (this.roomState) {
      this.roomState.stopped = true;
      clearInterval(this.roomState.timer);
    }
    this.closing = (async () => {
      await this.publications.close();
      await this.events.close();
      const results = await Promise.allSettled([...this.rooms.keys()].map(async id => this.remove(id)));
      try {
        await this.drainMedia();
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
      try {
        await waitFor(this.roomState.close(), this.shutdownDeadline);
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
      results.push(
        ...(await Promise.allSettled(
          [() => this.plex.close?.(), () => this.reporting?.close()].map(action => Promise.resolve().then(action)),
        )),
      );
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })();
    return this.closing;
  }
}
module.exports = { Watch, syncQualityParticipants, REJOIN };
