// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const Engine = require('../../shared/engine');
const RoomPolicy = require('../room-policy');
const { clearPlaybackEnd } = require('../playback-end');

/**
 * Queue commands and the auto-queue they refill.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
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
  },
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
  },
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
  },
  async queueCommand(id, command, actor, ticket) {
    if (!this.roomState) throw Object.assign(new Error('Saved rooms are unavailable'), { status: 400 });
    const room = this.rooms.get(id),
      { action, args } = command,
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(action)),
      queue = this.roomState.queue;
    if (room?.transition) throw Object.assign(new Error('Wait for the current queue operation'), { status: 409 });
    const currentRequest = async () =>
      this.hub.current(ticket) && (!actor.watchCurrent || (await actor.watchCurrent())) && this.hub.current(ticket);
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
    // Reserve the room in its mailbox: one queue or media transition at a time.
    const reserve = () => {
      queue.assertRevision(queue.room(id), revision);
      if (room?.transition) throw Object.assign(new Error('Wait for the current queue operation'), { status: 409 });
      const priorCountdown = room?.autoplayCountdown;
      const wasEmptyQueue = !priorCountdown && !queue.current(id) && !queue.pending(id).length;
      if (room) {
        room.transition = { kind: 'queue' };
        if (room.media) {
          this.cancelAutoplay(room);
          clearPlaybackEnd(room);
        }
      }
      return { priorCountdown, wasEmptyQueue };
    };
    const reserved = room ? await this.inRoom(room, reserve, undefined) : reserve();
    if (!reserved) throw Object.assign(new Error('Room access changed; retry manually'), { status: 403 });
    const { priorCountdown, wasEmptyQueue } = reserved;
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
          return this.changeQueueMedia(room, command, actor, ticket);
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
          return this.changeQueueMedia(room, { action: 'media.load', args: { mediaId: item.mediaId } }, actor, ticket);
        }
        if (action === 'queue.add' && room && !room.media && wasEmptyQueue) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          return this.changeQueueMedia(room, { action: 'media.load', args: { mediaId: item.mediaId } }, actor, ticket, {
            initialAdd: true,
            forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay,
          });
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
          ticket,
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
            ticket,
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
            ticket,
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
          return this.changeQueueMedia(room, { action: 'media.next', args: {} }, actor, ticket, {
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
            ticket,
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
            ticket,
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
          return this.changeQueueMedia(room, command, actor, ticket);
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
      // Back in the mailbox: the live room adopts the queue as written.
      const countdown =
        room &&
        (await this.inRoom(
          room,
          () => {
            const latest = this.roomState.store.get(id);
            this.roomState.apply(room, latest);
            if (!priorCountdown || room.media) return;
            const afterNext = this.nextCandidate(id);
            const afterKey = afterNext ? afterNext.id || afterNext.serverId + ':' + afterNext.mediaId : null;
            if (!afterNext) this.cancelAutoplay(room);
            else if (afterKey === priorCountdown.nextKey && room.autoplayCountdown === priorCountdown)
              priorCountdown.queueRevision = latest.queueRevision;
            else {
              this.cancelAutoplay(room);
              if (room.transition?.kind === 'queue') room.transition = undefined;
              return { restarting: this.startAutoplayCountdown(room) };
            }
          },
          false,
        ));
      if (countdown?.restarting) await countdown.restarting;
      if (room && countdown !== false)
        await this.inRoom(
          room,
          () => {
            void this.refreshEndingMeta(room);
            room.revision++;
            this.changed(room);
            room.autoQueueError = undefined;
            // The queue changed: check its availability and everyone's stream again.
            this.prepareStreams(room);
          },
          undefined,
        );
      return { status: 'applied', ...value };
    } finally {
      if (room?.transition?.kind === 'queue') room.transition = undefined;
    }
  },
  nextCandidate(roomId) {
    const queue = this.roomState.queue;
    const nextPending = queue.peekNext(roomId);
    if (nextPending) return nextPending;
    const record = this.roomState.store.get(roomId);
    const autoNext = record?.autoQueue?.mode !== 'off' ? record?.autoQueue?.next : null;
    return autoNext ? { ...autoNext, id: 'auto:' + autoNext.mediaId, source: 'auto' } : null;
  },
};
