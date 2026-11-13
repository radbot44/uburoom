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
const { runOperation, waitFor } = require('../operation');
const { isProviderOutage } = require('../resilience');
const { clearPlaybackEnd } = require('../playback-end');
const Engine = require('../../shared/engine');

/**
 * What the room asks of the server: room effects, media work and Plex sessions, preloads and provider health.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  /**
   * Publishes a finished command. A room-local command that left the room's video as it
   * was reaches only that room's subscribers; anything else reaches the lobby too. A live
   * room publishes through its mailbox, after everything the command did there.
   * @param {string | undefined} roomId
   * @param {string | undefined} action
   * @param {boolean} hadMedia
   */
  published(roomId, action, hadMedia) {
    const room = roomId ? this.rooms.get(roomId) : undefined;
    const roomOnly = Boolean(roomId && Engine.command(action)?.roomLocal && hadMedia === Boolean(room?.media));
    const change = roomOnly ? { roomId, includeLobby: false } : { includeLobby: true };
    if (!room || !this.coordinator.publish(room, change)) this.onPublish?.(room, change);
  },
  providerFailed(error) {
    if (!isProviderOutage(error)) return false;
    this.providerDownSince ??= this.clock.now();
    return true;
  },
  providerResponded() {
    if (this.providerDownSince === undefined) return;
    this.providerDownSince = undefined;
    this.providerRecoveredAt = this.clock.now();
  },
  // A viewer already watching keeps their place while Plex cannot answer. Nobody
  // new is admitted, and the next answer from Plex applies any real denial.
  retainedThroughOutage(room, actor, error) {
    if (!this.providerFailed(error)) return false;
    return [...room.viewers.values(), ...room.disconnectedViewers.values()].some(
      viewer => viewer.userId === actor.userId,
    );
  },
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
  },
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
  },
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
  },
  stopMedia(room, media) {
    if (!media) return Promise.resolve();
    return this.startMediaWork(room, () => this.plex.stop(media), { kind: 'cleanup' }).promise;
  },
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
  },
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
  },
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
  },
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
  },
  /** Runs what a committed room event asks of the server, in order. */
  roomEffect(room, effect, removed) {
    switch (effect.type) {
      case 'cancel-autoplay':
        return this.cancelAutoplay(room);
      case 'clear-playback-end':
        return clearPlaybackEnd(room);
      case 'save':
        return void this.roomState.save(room).catch(() => {});
      case 'checkpoint':
        // A save or transition already in flight writes the room itself; a frozen room keeps its last save.
        if (room.saving || room.transition || room.frozen) return;
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
  },
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
  },
  // Server maintenance, not room lifecycle: Plex transcode sessions nothing holds are ended once a minute.
  maintainPlexSessions() {
    if (this.plex.configured && !this.shuttingDown && Date.now() - (this.sessionsCheckedAt || 0) >= 60000) {
      this.sessionsCheckedAt = Date.now();
      void this.reconcilePlexSessions().catch(() => {});
    }
  },
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
  },
  async reconcilePlexSessions() {
    this.plexSessions = { ...(await this.plex.reconcileSessions(this.plexSessionsInUse())), checkedAt: Date.now() };
    return this.plexSessions;
  },
};
