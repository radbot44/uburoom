// @ts-check
'use strict';
/** @typedef {import('../types').Room} Room */
/** @typedef {import('../types').Viewer} Viewer */
/** @typedef {import('../types').Actor} Actor */
/** @typedef {import('../types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('../types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('../fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { randomUUID } = require('node:crypto');
const Engine = require('../../shared/engine.mjs');
const { mediaIdentity } = require('../../shared/room-protocol.mjs');
const RoomPolicy = require('../room-policy');
const { clearPlaybackEnd } = require('../playback-end');

function textField(value, max, label, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) throw Object.assign(new Error('Invalid ' + label), { status: 400 });
    return undefined;
  }
  if (typeof value !== 'string') throw Object.assign(new Error('Invalid ' + label), { status: 400 });
  const cleaned = value.trim();
  if (!cleaned) {
    if (required) throw Object.assign(new Error('Invalid ' + label), { status: 400 });
    return undefined;
  }
  if (cleaned.length > max) throw Object.assign(new Error(label + ' exceeds limit'), { status: 400 });
  return cleaned;
}

function validateSuggestionItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) {
    throw Object.assign(new Error('Invalid suggestion item'), { status: 400 });
  }
  const serverId = textField(item.serverId, 200, 'Media server identity', true);
  const mediaId = mediaIdentity(item.mediaId)?.id;
  if (!mediaId) throw Object.assign(new Error('Invalid media identity'), { status: 400 });
  if (mediaId === 'demo' && serverId !== 'local-demo') {
    throw Object.assign(new Error('Invalid demo media source'), { status: 400 });
  }
  if (!['movie', 'episode'].includes(item.type)) {
    throw Object.assign(new Error('Select a movie or episode'), { status: 400 });
  }
  const title = textField(item.title, 200, 'title', true);
  const parentTitle = textField(item.parentTitle, 200, 'parent title');
  const grandparentTitle = textField(item.grandparentTitle, 200, 'series title');
  // 'none' records that the provider has no picture for this item.
  const thumb = textField(item.thumb ?? (item.hasPoster === false ? 'none' : undefined), 500, 'artwork path');
  const duration = item.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0.001 || duration > 1e9) {
    throw Object.assign(new Error('Invalid media duration'), { status: 400 });
  }
  return {
    serverId,
    mediaId,
    type: item.type,
    title,
    ...(parentTitle ? { parentTitle } : {}),
    ...(grandparentTitle ? { grandparentTitle } : {}),
    ...(thumb ? { thumb } : {}),
    duration,
    ...(Number.isSafeInteger(item.year) ? { year: item.year } : {}),
    ...(item.hasPoster !== undefined ? { hasPoster: !!item.hasPoster } : {}),
    ...(item.hasLandscape !== undefined ? { hasLandscape: !!item.hasLandscape } : {}),
  };
}

function sameMedia(a, b) {
  if (!a || !b) return false;
  const aMedia = String(a.mediaId || a.id || '');
  const bMedia = String(b.mediaId || b.id || '');
  if (!aMedia || aMedia !== bMedia) return false;
  const aServer = a.serverId || a.roomServerId || (aMedia === 'demo' ? 'local-demo' : '');
  const bServer = b.serverId || b.roomServerId || (bMedia === 'demo' ? 'local-demo' : '');
  return !aServer || !bServer || aServer === bServer;
}

function duplicateSuggestionReason(queue, roomId, room, item) {
  if (sameMedia(room.media, item) || sameMedia(queue.current(roomId), item)) {
    return 'This item is already playing';
  }
  if (queue.pending(roomId).some(entry => sameMedia(entry, item))) {
    return 'This item is already in the queue';
  }
  if (
    (room.suggestions || []).some(
      entry => ['pending', 'accepting'].includes(entry.status) && sameMedia(entry.item, item),
    )
  ) {
    return 'This item has already been suggested';
  }
  return null;
}

/**
 * Queue commands and the auto-queue they refill.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  async autoCorpus(id, actor, config = this.roomState.store.get(id).autoQueue, anchorOverride) {
    if (!config || config.mode === 'off') return undefined;
    if (config.mode === 'continue') {
      const queue = this.roomState.queue;
      const pending = queue.pending(id),
        current = queue.current(id),
        lastHistory = queue.lastHistory(id);
      const active = [...(current ? [current] : []), ...pending];
      const anchorItem =
        anchorOverride !== undefined ? anchorOverride : active.length ? active[active.length - 1] : lastHistory;
      if (!anchorItem || anchorItem.type !== 'episode' || anchorItem.mediaId === 'demo') return [];
      const serverId = anchorItem.serverId || (await this.roomState.identify(anchorItem));
      const provider = await this.hub.mediaFor(actor, serverId);
      const details = provider.details ? await provider.details(anchorItem.mediaId, 'episode') : null;
      const showId = details?.showId;
      if (!showId) return [];
      const items = await provider.queueItems({ type: 'show', id: String(showId), includeSpecials: false });
      if ((await this.hub.mediaFor(actor, serverId)).principal !== provider.principal)
        throw Object.assign(new Error('Media access changed'), { status: 403 });
      return items.map(item => this.queueItem(item, serverId));
    }
    const serverId = config.scope.serverId;
    if (!(await this.providers.recorded({ serverId })))
      throw Object.assign(new Error('The auto-queue media server changed'), { status: 409 });
    const provider = await this.hub.mediaFor(actor, serverId);
    const items = await provider.queueItems({ ...config.scope, includeSpecials: config.includeSpecials });
    if ((await this.hub.mediaFor(actor, serverId)).principal !== provider.principal)
      throw Object.assign(new Error('Media access changed'), { status: 403 });
    return items.map(item => this.queueItem(item, serverId));
  },
  async verifyAutoNext(id, actor, corpus) {
    const queue = this.roomState.queue;
    let remaining = corpus;
    for (let attempt = 0; attempt < 5; attempt++) {
      const currentAuto = this.roomState.store.get(id).autoQueue;
      const candidate = currentAuto?.mode !== 'off' ? currentAuto?.next : null;
      if (!candidate || candidate.mediaId === 'demo') return currentAuto;
      const provider = await this.hub.mediaFor(actor, candidate.serverId);
      if (!provider?.availability) return currentAuto;
      const status = await provider.availability([candidate.mediaId]);
      if ((await this.hub.mediaFor(actor, candidate.serverId)).principal !== provider.principal)
        throw Object.assign(new Error('Media access changed'), { status: 403 });
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
        parentTitle = parentTitle + ' · ' + epStr;
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
  /** @param {Actor} actor @param {any} raw @param {{verifyServer?: boolean}} [options] */
  async resolvePlayableQueueItem(actor, raw, { verifyServer = false } = {}) {
    const rawId = raw.mediaId || raw.id;
    // A provider that cannot answer leaves a named server unconfirmed, not refused.
    if (verifyServer && raw.serverId && !(await this.providers.recorded({ ...raw, mediaId: rawId }).catch(() => true)))
      throw Object.assign(new Error('Media server identity mismatch'), { status: 400 });
    const serverId = raw.serverId || (await this.roomState.identify({ id: rawId }));
    const provider = await this.hub.mediaFor(actor, serverId);
    const checked = provider.playableItem && rawId !== 'demo' ? await provider.playableItem(rawId) : raw;
    if ((await this.hub.mediaFor(actor, serverId)).principal !== provider.principal)
      throw Object.assign(new Error('Media access changed'), { status: 403 });
    return this.queueItem(checked, serverId);
  },
  /** Removes a suggestion once it is accepted, played, dismissed or abandoned. @param {any} room @param {string} suggestionId */
  settleSuggestion(room, suggestionId) {
    const index = room.suggestions?.findIndex(entry => entry.id === suggestionId) ?? -1;
    if (index === -1) return false;
    room.suggestions.splice(index, 1);
    room.revision++;
    room.lastActivity = this.clock.now();
    this.changed(room);
    return true;
  },
  /** One suggestion as a viewer sees it. @param {any} entry @param {string} canonical */
  suggestionView(entry, canonical) {
    return {
      id: entry.id,
      item: { ...entry.item },
      supporters: entry.supporters.map(supporter => supporter.name),
      agreed: entry.supporters.some(supporter => supporter.userId === canonical),
      createdAt: entry.createdAt,
    };
  },
  /**
   * Suggesting, agreeing and dismissing. A suggestion lives while at least one viewer agrees with it:
   * whoever suggested it is its first supporter, and suggesting a video already suggested agrees with it.
   * @param {string} id @param {EngineCommand} command @param {any} actor @param {import('../core').Ticket} ticket
   */
  async suggestionCommand(id, command, actor, ticket) {
    if (!this.roomState) throw Object.assign(new Error('Saved rooms are unavailable'), { status: 400 });
    const room = this.rooms.get(id),
      { action, args } = command,
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(action)),
      queue = this.roomState.queue;
    if (!room) throw Object.assign(new Error('Suggestions require an open room'), { status: 409 });
    const currentRequest = async () =>
      this.hub.current(ticket) && (!actor.watchCurrent || (await actor.watchCurrent())) && this.hub.current(ticket);
    await this.roomState.eligible(actor, currentRequest);
    await this.roomState.metadata(id, actor);
    const permitted = () => {
      if (!this.hub.authorize(actor, room, action).ok) {
        throw Object.assign(new Error('Room queue permission required'), { status: 403 });
      }
      if (!actor.guestRoomId) queue.assertAllowed(queue.room(id), actor.userId, declared.capability);
    };
    const check = async () => {
      if (
        !(await currentRequest()) ||
        this.rooms.get(id) !== room ||
        !(await this.canView(room, actor)) ||
        !(await currentRequest())
      ) {
        throw Object.assign(new Error('Room access changed; retry manually'), { status: 403 });
      }
      permitted();
    };
    // One change in the room's mailbox, after rechecking that the request is still current and allowed.
    const change = run =>
      this.inRoom(room, () => {
        if (!this.hub.current(ticket)) {
          throw Object.assign(new Error('Room access changed; retry manually'), { status: 403 });
        }
        permitted();
        this.pruneSuggestions(room);
        room.suggestions ||= [];
        return run();
      });
    const canonical = queue.account(actor.userId);
    const supporter = () => ({
      userId: canonical,
      name: Engine.senderName(actor.name),
      requiresPresence: [...room.viewers.values()].some(v => v.userId === canonical),
    });
    const touched = () => {
      room.revision++;
      room.lastActivity = this.clock.now();
      this.changed(room);
    };
    await check();
    if (action === 'queue.suggest') {
      const item = validateSuggestionItem(
        await this.resolvePlayableQueueItem(actor, args.item, { verifyServer: true }),
      );
      await check();
      const maxPending = this.roomState.limits?.maxSuggestions ?? 25;
      const maxPerViewer = this.roomState.limits?.maxSuggestionsPerViewer ?? 3;
      const suggestion = await change(() => {
        const existing = room.suggestions.find(entry => entry.status === 'pending' && sameMedia(entry.item, item));
        if (existing) {
          if (!existing.supporters.some(entry => entry.userId === canonical)) {
            existing.supporters.push(supporter());
            touched();
          }
          return existing;
        }
        const duplicate = duplicateSuggestionReason(queue, id, room, item);
        if (duplicate) throw Object.assign(new Error(duplicate), { status: 409 });
        if (room.suggestions.length >= maxPending) {
          throw Object.assign(new Error(`Suggestion limit reached (maximum ${maxPending} pending items)`), {
            status: 409,
          });
        }
        // Only suggestions a viewer leads count toward their limit; agreeing is free.
        const led = room.suggestions.filter(entry => entry.supporters[0]?.userId === canonical).length;
        if (led >= maxPerViewer) {
          throw Object.assign(new Error(`You already have ${maxPerViewer} pending suggestions in this room`), {
            status: 409,
          });
        }
        const created = {
          id: randomUUID(),
          status: 'pending',
          item,
          supporters: [supporter()],
          createdAt: this.clock.now(),
        };
        room.suggestions.push(created);
        touched();
        return created;
      });
      return { status: 'applied', suggestion: this.suggestionView(suggestion, canonical) };
    }
    const suggestion = await change(() => {
      const target = room.suggestions.find(entry => entry.id === args.suggestionId);
      if (!target) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
      if (target.status !== 'pending') {
        throw Object.assign(new Error('Suggestion is already being accepted'), { status: 409 });
      }
      if (action === 'queue.suggestion.dismiss') {
        this.settleSuggestion(room, target.id);
        return undefined;
      }
      const index = target.supporters.findIndex(entry => entry.userId === canonical);
      if (args.agree && index === -1) target.supporters.push(supporter());
      else if (!args.agree && index !== -1) target.supporters.splice(index, 1);
      else return target;
      // The last viewer to stop agreeing takes the suggestion away.
      if (!target.supporters.length) {
        this.settleSuggestion(room, target.id);
        return undefined;
      }
      touched();
      return target;
    });
    return { status: 'applied', ...(suggestion ? { suggestion: this.suggestionView(suggestion, canonical) } : {}) };
  },
  async queueCommand(id, command, actor, ticket) {
    if (!this.roomState) throw Object.assign(new Error('Saved rooms are unavailable'), { status: 400 });
    const room = this.rooms.get(id),
      { action, args } = command,
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(action)),
      queue = this.roomState.queue;
    if (['queue.suggest', 'queue.suggestion.dismiss', 'queue.suggestion.agree'].includes(action)) {
      return this.suggestionCommand(id, command, actor, ticket);
    }
    const accepting = action === 'queue.suggestion.accept' || action === 'queue.suggestion.playNow';
    if (accepting && !room) {
      throw Object.assign(new Error('Suggestions require an open room'), { status: 409 });
    }
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
      if (room && accepting && !this.hub.authorize(actor, room, action).ok) {
        throw Object.assign(new Error('Room queue permission required'), { status: 403 });
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
    let revision = args.expectedRevision;
    // Reserve the room in its mailbox: one queue or media transition at a time.
    const reserve = () => {
      if (revision === undefined) revision = queue.room(id).queueRevision;
      queue.assertRevision(queue.room(id), revision);
      if (room?.transition) throw Object.assign(new Error('Wait for the current queue operation'), { status: 409 });
      if (room && accepting) {
        if (!this.hub.current(ticket) || !this.hub.authorize(actor, room, action).ok) {
          throw Object.assign(new Error('Room queue permission required'), { status: 403 });
        }
      }
      const priorCountdown = room?.autoplayCountdown;
      const wasEmptyQueue = !priorCountdown && !queue.current(id) && !queue.pending(id).length;
      let acceptedSuggestion;
      if (accepting) {
        acceptedSuggestion = (room.suggestions || []).find(entry => entry.id === args.suggestionId);
        if (!acceptedSuggestion) throw Object.assign(new Error('Suggestion not found'), { status: 404 });
        if (acceptedSuggestion.status !== 'pending') {
          throw Object.assign(new Error('Suggestion is already being accepted'), { status: 409 });
        }
        if (
          action === 'queue.suggestion.accept' &&
          !(!room.media && wasEmptyQueue) &&
          queue.pending(id).length >= queue.maxPending
        ) {
          throw Object.assign(new Error('Queue limit reached (maximum ' + queue.maxPending + ' upcoming items)'), {
            status: 400,
          });
        }
        acceptedSuggestion.status = 'accepting';
      }
      if (room) {
        room.transition = { kind: 'queue' };
        if (room.media) {
          this.cancelAutoplay(room);
          clearPlaybackEnd(room);
        }
      }
      return { priorCountdown, wasEmptyQueue, acceptedSuggestion };
    };
    const reserved = room ? await this.inRoom(room, reserve, undefined) : reserve();
    if (!reserved) throw Object.assign(new Error('Room access changed; retry manually'), { status: 403 });
    const { priorCountdown, wasEmptyQueue, acceptedSuggestion } = reserved;
    let suggestionSettled = false;
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
      } else if (action === 'queue.add' || action === 'queue.playNow' || accepting) {
        const raw = acceptedSuggestion ? acceptedSuggestion.item : args.item;
        const item = await this.resolvePlayableQueueItem(actor, raw);
        await check();
        queue.assertRevision(queue.room(id), revision);
        const playNow = action === 'queue.playNow' || action === 'queue.suggestion.playNow';
        // An accepted suggestion leaves the list once its video has played or joined the queue.
        const settle = async () => {
          if (!acceptedSuggestion) return;
          suggestionSettled = true;
          await this.inRoom(room, () => this.settleSuggestion(room, acceptedSuggestion.id), undefined);
        };
        if (room && (playNow || (!room.media && wasEmptyQueue))) {
          if (room.transition?.kind === 'queue') room.transition = undefined;
          const outcome = await this.changeQueueMedia(
            room,
            { action: 'media.load', args: { mediaId: item.mediaId, serverId: item.serverId } },
            actor,
            ticket,
            ...(playNow
              ? []
              : [{ initialAdd: true, forcePlay: !!room.endedVersion && !!this.roomState.store.get(id).autoplay }]),
          );
          if (outcome?.status === 'applied') await settle();
          return outcome;
        }
        value =
          action === 'queue.playNow'
            ? await queue.playNow(id, actor.userId, item)
            : await queue.add(id, actor.userId, item, { expectedRevision: revision });
        await settle();
      } else if (action === 'queue.offer.start') {
        if (!room) throw Object.assign(new Error('Room unavailable'), { status: 404 });
        if (!this.hub.authorize(actor, room, 'addQueue').ok || !this.hub.authorize(actor, room, 'playPause').ok) {
          throw Object.assign(new Error('Room permission required'), { status: 403 });
        }
        if (room.media || queue.current(id) || queue.pending(id).length) {
          throw Object.assign(new Error('Queue is no longer empty'), { status: 409 });
        }
        const serverId = await this.roomState.identify({ id: args.mediaId, serverId: args.serverId });
        const provider = await this.hub.mediaFor(actor, serverId);
        const checked = provider.playableItem
          ? await provider.playableItem(args.mediaId)
          : { id: args.mediaId, type: 'episode' };
        if ((await this.hub.mediaFor(actor, serverId)).principal !== provider.principal) {
          throw Object.assign(new Error('Media access changed'), { status: 403 });
        }
        await check();
        const autoConfig = { mode: 'continue', scope: null, includeSpecials: false };
        await queue.configureAuto(id, actor.userId, autoConfig, { expectedRevision: revision });
        if (room.transition?.kind === 'queue') room.transition = undefined;
        return this.changeQueueMedia(
          room,
          { action: 'media.load', args: { mediaId: checked.id || args.mediaId, serverId } },
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
        const serverId = await this.roomState.identify({ id: args.mediaId, serverId: args.serverId });
        const provider = await this.hub.mediaFor(actor, serverId);
        const items = await provider.queueItems({
          type: args.type,
          id: args.mediaId,
          includeSpecials: args.includeSpecials,
        });
        if ((await this.hub.mediaFor(actor, serverId)).principal !== provider.principal)
          throw Object.assign(new Error('Media access changed'), { status: 403 });
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
          let serverId;
          if (!scope.id) {
            if (scope.type !== 'show' || !room?.media || room.media.id === 'demo')
              throw Object.assign(new Error('Choose a show from the library'), { status: 400 });
            serverId = await this.roomState.identify(room.media);
            const details = await (await this.hub.mediaFor(actor, serverId)).details(room.media.id);
            scope = { ...scope, id: details.showId || (details.type === 'show' ? details.id : undefined) };
          } else serverId = await this.roomState.identify(scope);
          if (!scope.id) throw Object.assign(new Error('Choose a show from the library'), { status: 400 });
          scope = { ...scope, serverId };
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
      if (acceptedSuggestion && !suggestionSettled && room) {
        await this.inRoom(
          room,
          () => {
            if (acceptedSuggestion.status === 'accepting') acceptedSuggestion.status = 'pending';
          },
          undefined,
        );
      }
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
