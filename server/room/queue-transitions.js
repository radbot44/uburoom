// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { currentSignal } = require('../operation');
const { randomUUID } = require('node:crypto');
const { isHost } = require('../core');
const { PlaybackError } = require('../av1');
const { observePlaybackEnd, clearPlaybackEnd } = require('../playback-end');
const { expired } = require('./common');

/**
 * Moving between videos: load, next and previous, the end of a video, autoplay and ending offers.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  cancelAutoplay(room) {
    this.dropPreload(room);
    clearTimeout(room.autoplayTimer);
    room.autoplayTimer = undefined;
    if (room.autoplayCountdown) {
      room.autoplayCountdown = undefined;
      room.revision++;
      this.changed(room);
    }
    room.playbackIntent = (room.playbackIntent || 0) + 1;
  },
  async observeEnd(room, viewer, data, observed) {
    if (!observePlaybackEnd(room, viewer, data, observed, this.clock.now())) return;
    await this.finishQueueMedia(room, data);
  },
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
        this.changed(room);
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
  },
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
        this.changed(room);
      }
    } catch {
      if (room.epoch === epoch && this.roomState.store.get(record.id)?.queueRevision === revision) {
        room.endingOffer = { key, offer: null };
      }
    }
  },
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
    if ((person.alive && !(await person.alive())) || !(await this.canView(room, person.actor))) return;
    // Back in the mailbox: the countdown starts only if the room has not moved on.
    await this.inRoom(room, () => this.beginCountdown(room, record, viewerId, person, intent, data), undefined);
  },
  beginCountdown(room, record, viewerId, person, intent, data) {
    if (
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
    this.changed(room);
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
            this.changed(room);
          }
        })
        .catch(() => {
          this.cancelAutoplay(room);
          room.autoplayError = 'The next video could not be loaded.';
          room.revision++;
          this.changed(room);
        });
      this.roomState.track(advance);
    }, this.autoplayDelayMs);
    room.autoplayTimer.unref?.();
  },
  /** Ends the current video: reserved in the mailbox, written outside, unloaded back inside. */
  async finishQueueMedia(room, data) {
    if (this.shuttingDown || room.closed) return;
    const signal = currentSignal();
    const work = await this.inRoom(
      room,
      () =>
        this.startMediaWork(room, work => this.finishQueueMediaOwned(room, data, work), { kind: 'transition', signal }),
      undefined,
    );
    await work?.promise;
  },
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
    this.changed(room);
    const record = this.roomState.store.get(room.roomId),
      current = this.roomState.queue.current(record.id);
    room.transition = { kind: 'media' };
    try {
      // The durable write runs outside the mailbox; the room unloads the video back inside.
      const completing = (async () => {
        await room.saving?.catch(() => {});
        work.signal.throwIfAborted();
        work.committing = true;
        if (current) await this.roomState.queue.completeCurrent(record.id);
        await this.inRoom(
          room,
          () => {
            this.unloadQueueMedia(room);
            room.endedVersion = endedVersion;
            room.manualPaused = false;
            delete room.transition?.commit;
          },
          undefined,
        );
      })();
      room.transition.commit = completing;
      await completing;
      await this.roomState.save(room);
      await this.inRoom(
        room,
        () => {
          this.roomState.apply(room, this.roomState.store.get(record.id));
          room.revision++;
          this.changed(room);
          this.prepareStreams(room);
        },
        undefined,
      );
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
  },
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
  },
  /**
   * Changes the room's video in two phases. Inside the mailbox it checks the command
   * and reserves the room (`room.transition`, the handle on this work, with the
   * mediaVersion and epoch it expects). Outside, Plex prepares the video and the queue
   * is written. Back inside, the result is adopted only if the room has not moved on;
   * otherwise the prepared Plex session is stopped.
   */
  async changeQueueMedia(room, command, actor, ticket, options) {
    if (this.shuttingDown || room.closed) return { status: 'unavailable', message: 'Room is closing.' };
    const signal = currentSignal();
    const work = await this.inRoom(
      room,
      () =>
        this.startMediaWork(room, work => this.changeQueueMediaOwned(room, command, actor, ticket, options, work), {
          kind: 'transition',
          signal,
        }),
      undefined,
    );
    return work ? work.promise : { status: 'unavailable', message: 'Room is closing.' };
  },
  /** Adopts a committed queue transition's result on the live room, inside its mailbox. */
  adoptQueueMedia(
    room,
    { removing, advance, prepared, args, record, old, preload, preloaded, actor, initialAdd, forcePlay },
  ) {
    const id = room.roomId,
      queue = this.roomState.queue;
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
      // Viewers adopt their preloaded streams on their next poll; leftovers are stopped.
      if (preload?.sourceAdopted && preload.source && prepared === preloaded) {
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
    this.changed(room);
    room.lastActivity = this.clock.now();
    delete room.transition?.commit;
  },
  async changeQueueMediaOwned(room, command, actor, ticket, { initialAdd = false, forcePlay = false } = {}, work) {
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
      !work.signal.aborted &&
      (!ticket || this.hub.current(ticket)) &&
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
      }
      const preloaded =
        preload?.sourceAdopted && preload.source ? await preload.source.catch(() => undefined) : undefined;
      // Back in the mailbox. The durable transaction is the transition's commit point:
      // once written it is adopted while the room is live (otherwise the prepared
      // session is stopped below). Close waits for it; later controls apply to the
      // newly adopted generation.
      const committed = await this.inRoom(
        room,
        () => {
          // Without a durable queue nothing was committed yet: a room that moved on keeps its video.
          if (!record && !valid()) return false;
          if (record) this.roomState.apply(room, this.roomState.store.get(id));
          this.adoptQueueMedia(room, {
            removing,
            advance,
            prepared,
            args,
            record,
            old,
            preload,
            preloaded,
            actor,
            initialAdd,
            forcePlay,
          });
          adopted = !!prepared && !(removing && !advance);
          return true;
        },
        false,
      );
      if (!committed) return expired();
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
      this.changed(room);
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
  },
};
