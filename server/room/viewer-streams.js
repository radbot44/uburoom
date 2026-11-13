// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { FallbackStream } = require('../fallback-stream');
const { SharedTask, currentSignal } = require('../operation');
const { randomUUID } = require('node:crypto');
const Engine = require('../../shared/engine.mjs');
const { PlaybackError } = require('../av1');
const { PlaybackTracking } = require('../playback-tracking');
const SubtitleResources = require('../subtitle-resources');
const { TRANSCODE_PING_MS, expired } = require('./common');

/**
 * Each viewer's own stream: preparation, quality, preloads, retries and fallback delivery.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
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
  },
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
  },
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
  },
  async prepareQuality(room, viewer, plex, source, requested, compatible, fallback, authorized, extraOptions) {
    const opts =
      typeof authorized === 'object' && authorized !== null && typeof authorized !== 'function'
        ? { ...authorized, ...extraOptions }
        : { authorized, ...extraOptions };
    const authFn = opts.authorized;
    if (source.unavailable)
      source = await plex.prepare(source.id, 'direct', false, undefined, undefined, { sourceOnly: true });
    const { candidates } = require('../quality-options');
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
  },
  prepareOutput(room, viewer, plex, source, quality, compatible, fallback, choices) {
    return plex.prepare(source.id, quality, compatible, source, fallback, {
      ...choices,
      directPlan: () => this.delivery?.hlsPlan(plex, viewer, room, choices.authorized),
    });
  },
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
  },
  // Superseded preparation is not a failed request. A 4xx here would tell this
  // viewer the room is gone merely because someone else changed the media.
  async joinPreparation(job) {
    try {
      await job.join();
    } catch (error) {
      currentSignal()?.throwIfAborted();
      if (!job.signal.aborted && !this.providerFailed(error)) throw error;
    }
  },
  /**
   * @param {Room} room
   * @param {Actor} actor
   * @param {string} viewerId
   * @param {(authorized: () => Promise<boolean>, source: any) => Promise<any>} prepare
   * @param {{ticket?: import('../core').Ticket, retainUnavailable?: boolean, accept?: (media: any) => boolean}} [options]
   */
  async replaceViewer(
    room,
    actor,
    viewerId,
    prepare,
    { ticket = undefined, retainUnavailable = false, accept = () => true } = {},
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
    const admitted = () => matches() && (!ticket || this.hub.current(ticket));
    const authorized = async () =>
      admitted() && (await this.canView(room, actor)) && (!viewer.alive || (await viewer.alive())) && admitted();
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
      const usable = await authorized();
      // Back in the mailbox: the stream is adopted only by the same viewer, video and stream.
      return await this.inRoom(room, () => {
        if (!usable || !admitted()) return expired();
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
      });
    } finally {
      if (media && !adopted && media !== current && media !== room.media) await this.plex.stop(media);
    }
  },
  /**
   * Starts preparing every viewer's stream and checking the queue's availability, after
   * the room's media or queue changed. Each viewer's next state waits for their own stream.
   */
  prepareStreams(room) {
    if (this.rooms.get(room.roomId) !== room) return;
    for (const [viewerId, viewer] of room.viewers) this.prepareStream(room, viewer.actor, viewerId);
    this.requestEndingMeta(room);
    this.reconcileFallback(room);
  },
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
  },
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
  },
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
  },
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
  },
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
  },
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
  },
};
