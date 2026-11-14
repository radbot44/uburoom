// @ts-check
'use strict';
const { repositories } = require('./repositories');
const { mediaIdentity } = require('../shared/room-protocol.mjs');

const { randomUUID, randomInt } = require('node:crypto');
const Policy = require('./room-policy');

/**
 * Options shared by the queue-advancing operations.
 * @typedef {{currentPosition?:number,expectedRevision?:number,autoCorpus?:any[],corpus?:any[],guard?:()=>boolean,
 *   skipPrevious?:boolean,initialAdd?:boolean,discardCurrent?:boolean,outcome?:string,currentEntryId?:string,
 *   nextEntryId?:string}} QueueAdvanceOptions
 */
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_PENDING = 50;
const MAX_HISTORY = 150;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, limit, label) {
  if (
    typeof value !== 'string' ||
    /[\u0000-\u001f\u007f-\u009f]/.test(value) ||
    !value.trim() ||
    value.trim().length > limit
  ) {
    throw error('Invalid ' + label);
  }
  return value.trim();
}

function optionalText(value, limit) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) || value.trim().length > limit) {
    return null;
  }
  return value.trim();
}

function cleanNumber(value, min, max, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw error('Invalid ' + label);
  }
  return value;
}

function validateItem(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw error('Invalid queue item');
  const serverId = cleanText(raw.serverId, 200, 'Plex server identity');
  const mediaId = mediaIdentity(raw.mediaId)?.id;
  if (!mediaId) throw error('Invalid media identity');
  if (mediaId === 'demo' && serverId !== 'local-demo') throw error('Invalid demo media source');
  if (!['movie', 'episode'].includes(raw.type)) throw error('Invalid media type');
  const title = cleanText(raw.title, 200, 'title');
  const parentTitle = optionalText(raw.parentTitle, 200);
  const grandparentTitle = optionalText(raw.grandparentTitle, 200);
  const thumb = optionalText(raw.thumb, 500);
  const duration = cleanNumber(raw.duration, 0.001, 1e9, 'duration');
  const provenance = optionalText(raw.provenance, 100);
  const position =
    raw.position !== undefined
      ? Math.min(Math.max(0, cleanNumber(raw.position, 0, duration, 'position')), duration)
      : 0;
  return {
    serverId,
    mediaId,
    type: raw.type,
    title,
    parentTitle,
    grandparentTitle,
    thumb,
    duration,
    position,
    provenance,
  };
}

function rowToEntry(row) {
  if (!row) return null;
  return {
    id: row.id,
    roomId: row.roomId,
    state: row.state,
    rank: row.rank,
    serverId: row.serverId,
    mediaId: row.mediaId,
    type: row.type,
    title: row.title,
    parentTitle: row.parentTitle || null,
    grandparentTitle: row.grandparentTitle || null,
    thumb: row.thumb || null,
    duration: row.duration,
    position: row.position,
    outcome: row.outcome || null,
    provenance: row.provenance || null,
    createdAt: row.createdAt,
    startedAt: row.startedAt || null,
    endedAt: row.endedAt || null,
    updatedAt: row.updatedAt,
  };
}

function validateAuto(config) {
  if (
    !config ||
    typeof config !== 'object' ||
    !['off', 'continue', 'following', 'random'].includes(config.mode) ||
    (config.includeSpecials !== undefined && typeof config.includeSpecials !== 'boolean')
  )
    throw error('Invalid auto-queue settings');
  let scope = null;
  if (['following', 'random'].includes(config.mode)) {
    const selected = config.scope;
    if (
      !selected ||
      !['show', 'library', 'collection'].includes(selected.type) ||
      (config.mode === 'following' && selected.type !== 'show') ||
      typeof selected.id !== 'string' ||
      !/^\d{1,20}$/.test(selected.id)
    )
      throw error('Invalid auto-queue scope');
    scope = {
      type: selected.type,
      id: selected.id,
      serverId: cleanText(selected.serverId, 200, 'Plex server identity'),
    };
  }
  return {
    mode: config.mode,
    scope,
    includeSpecials: config.mode === 'continue' ? false : !!config.includeSpecials,
    cycle: 0,
    used: [],
    next: null,
  };
}

class RoomQueue {
  /**
   * @param {InstanceType<typeof import('./accounts').Accounts>} registry
   * @param {InstanceType<typeof import('./room-store').RoomStore>} store
   * @param {{now?: () => number,randomIndex?:(max:number)=>number}} [options]
   */
  constructor(registry, store, { now, randomIndex = randomInt } = {}) {
    this.registry = registry;
    this.db = registry.db;
    this.store = store;
    this.randomIndex = randomIndex;
    this.maxPending = store.limits.maxQueue;
    this.maxHistory = store.limits.maxHistory;
    let lastNow = 0;
    this.now =
      typeof now === 'function'
        ? now
        : () => {
            const n = Date.now();
            lastNow = n > lastNow ? n : lastNow + 1;
            return lastNow;
          };
  }

  healthy() {
    this.store.healthy();
  }

  room(roomId) {
    return this.store.get(roomId);
  }

  account(userId) {
    return this.store.account(userId);
  }

  assertRevision(room, expectedRevision) {
    if (
      expectedRevision !== undefined &&
      (!Number.isSafeInteger(expectedRevision) || expectedRevision !== room.queueRevision)
    ) {
      throw error('Queue changed; refresh before editing', 409);
    }
  }

  assertAllowed(room, userId, capability) {
    const canonical = this.account(userId);
    if (this.store.isAdmin(canonical) !== true && !Policy.allowed(room, canonical, capability)) {
      throw error('Room queue permission required', 403);
    }
  }

  bumpQueueRevision(roomId, at = this.now(), { clearCursor = true } = {}) {
    const room = this.room(roomId);
    if (clearCursor && room?.autoQueue?.cursor) {
      const autoQueue = { ...room.autoQueue, cursor: null };
      repositories(this.db).rooms.updateRoomsSetAutoQueueQueueRevisionUpdatedAtLastAccessedAtById(
        JSON.stringify(autoQueue),
        at,
        at,
        roomId,
      );
    } else {
      repositories(this.db).rooms.updateRoomsSetQueueRevisionUpdatedAtLastAccessedAtById(at, at, roomId);
    }
  }

  getEntry(entryId) {
    this.healthy();
    if (!UUID.test(entryId)) return null;
    const row = repositories(this.db).queue.findEntry(entryId);
    return rowToEntry(row);
  }

  current(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = repositories(this.db).queue.findCurrent(roomId);
    return rowToEntry(row);
  }

  peekNext(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = repositories(this.db).queue.findNextPending(roomId);
    return rowToEntry(row);
  }

  lastHistory(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = repositories(this.db).queue.findLatestHistory(roomId);
    return rowToEntry(row);
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any} rawItem
   * @param {{expectedRevision?:number}} [options]
   */
  async add(roomId, userId, rawItem, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'addQueue');
    if (expectedRevision !== undefined) this.assertRevision(room, expectedRevision);
    const item = validateItem(rawItem);

    const pendingCount = /** @type {{count:number}} */ (repositories(this.db).queue.countPending(roomId)).count;
    if (pendingCount >= this.maxPending) {
      throw error('Queue limit reached (maximum ' + this.maxPending + ' upcoming items)', 400);
    }

    const id = randomUUID(),
      at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).queue.insertQueueEntries(
        id,
        roomId,
        'pending',
        pendingCount,
        item.serverId,
        item.mediaId,
        item.type,
        item.title,
        item.parentTitle,
        item.grandparentTitle,
        item.thumb,
        item.duration,
        item.position,
        null,
        item.provenance,
        at,
        null,
        null,
        at,
      );
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { added: this.getEntry(id), queueRevision: room.queueRevision + 1 };
  }

  pending(roomId) {
    return repositories(this.db).queue.listPending(roomId).map(rowToEntry);
  }

  insertPending(roomId, items, startRank, at) {
    const insert = repositories(this.db).queue.insertStatement;
    return items.map((item, index) => {
      const id = randomUUID();
      insert.run(
        id,
        roomId,
        'pending',
        startRank + index,
        item.serverId,
        item.mediaId,
        item.type,
        item.title,
        item.parentTitle,
        item.grandparentTitle,
        item.thumb,
        item.duration,
        item.position,
        null,
        item.provenance,
        at,
        null,
        null,
        at,
      );
      return id;
    });
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any[]} rawItems
   * @param {{expectedRevision?:number,unfinished?:boolean}} [options]
   */
  async addBulk(roomId, userId, rawItems, { expectedRevision, unfinished = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'addQueue');
    this.assertRevision(room, expectedRevision);
    if (!Array.isArray(rawItems) || rawItems.length > 20000 || typeof unfinished !== 'boolean')
      throw error('Invalid bulk queue selection');
    const pending = this.pending(roomId),
      current = this.current(roomId);
    const key = item => item.serverId + ':' + item.mediaId;
    const excluded = new Set([...pending, ...(current ? [current] : [])].map(key));
    if (unfinished) {
      for (const row of repositories(this.db).queue.listRoomProgressByRoomId(roomId)) excluded.add(key(row));
    }
    const items = [];
    for (const raw of rawItems) {
      const item = validateItem(raw);
      if (!excluded.has(key(item))) {
        excluded.add(key(item));
        items.push(item);
      }
    }
    if (pending.length + items.length > this.maxPending)
      throw error(
        'Adding ' +
          items.length +
          ' items would exceed the queue limit (maximum ' +
          this.maxPending +
          ' upcoming items)',
      );
    if (!items.length) return { added: [], addedCount: 0, queueRevision: room.queueRevision };
    const at = this.now();
    let ids;
    this.registry.transaction(() => {
      ids = this.insertPending(roomId, items, pending.length, at);
      this.bumpQueueRevision(roomId, at);
    });
    await this.store.commit();
    return { added: ids.map(id => this.getEntry(id)), addedCount: ids.length, queueRevision: room.queueRevision + 1 };
  }

  async shuffle(roomId, userId, expectedRevision) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);
    const items = this.pending(roomId);
    if (items.length < 2) return { queueRevision: room.queueRevision };
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.randomIndex(i + 1);
      [items[i], items[j]] = [items[j], items[i]];
    }
    const at = this.now();
    this.registry.transaction(() => {
      const update = repositories(this.db).queue.rankStatement;
      items.forEach((item, rank) => update.run(rank, at, item.id));
      this.bumpQueueRevision(roomId, at);
    });
    await this.store.commit();
    return { queueRevision: room.queueRevision + 1 };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any} config
   * @param {{expectedRevision?:number}} [options]
   */
  async configureAuto(roomId, userId, config, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);
    const { scope, includeSpecials } = validateAuto(config);
    const same =
      room.autoQueue.mode === config.mode &&
      JSON.stringify(room.autoQueue.scope) === JSON.stringify(scope) &&
      room.autoQueue.includeSpecials === includeSpecials;
    const current = this.current(roomId);
    const active = [...this.pending(roomId), ...(current ? [current] : [])];
    const used =
      config.mode === 'random'
        ? [...new Set(active.filter(item => item.serverId === scope.serverId).map(item => item.mediaId))]
        : [];
    const autoQueue = same
      ? { ...room.autoQueue, next: room.autoQueue.next ?? null }
      : { mode: config.mode, scope, includeSpecials, cycle: 0, used, next: null };
    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).rooms.updateRoomsSetAutoQueueQueueRevisionUpdatedAtLastAccessedAtById(
        JSON.stringify(autoQueue),
        at,
        at,
        roomId,
      );
    });
    await this.store.commit();
    return { autoQueue, queueRevision: room.queueRevision + 1 };
  }

  async setAutoplay(roomId, userId, enabled) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'autoplay');
    if (typeof enabled !== 'boolean') throw error('Choose autoplay on or off');
    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).rooms.updateRoomsSetAutoplayRevisionUpdatedAtLastAccessedAtById(
        enabled ? 1 : 0,
        at,
        at,
        roomId,
      );
    });
    await this.store.commit();
    return { autoplay: enabled, revision: room.revision + 1 };
  }

  // The caller resolves Plex access before supplying the full, ordered corpus.
  // Bolt Optimization: Use Map indexing for O(1) item lookups in 'following'/'continue' modes
  // and maintain the 'available' array in 'random' mode for O(N) preview selection.
  computeAutoNext(roomId, corpus, { forceAdvance = false } = {}) {
    const room = this.room(roomId);
    const autoQueue = { ...room.autoQueue, used: [...(room.autoQueue.used || [])], next: room.autoQueue.next ?? null };
    if (autoQueue.mode === 'off') {
      autoQueue.next = null;
      const changed = JSON.stringify(room.autoQueue) !== JSON.stringify(autoQueue);
      if (changed) repositories(this.db).rooms.updateRoomsSetAutoQueueById(JSON.stringify(autoQueue), roomId);
      return { next: null, autoQueue, changed };
    }
    if (!corpus.length) {
      autoQueue.next = null;
      const changed = JSON.stringify(room.autoQueue) !== JSON.stringify(autoQueue);
      if (changed) repositories(this.db).rooms.updateRoomsSetAutoQueueById(JSON.stringify(autoQueue), roomId);
      return { next: null, autoQueue, changed };
    }
    const pending = this.pending(roomId),
      current = this.current(roomId),
      lastHistory = this.lastHistory(roomId);
    const activeEntries = [...(current ? [current] : []), ...pending];
    if (autoQueue.mode === 'continue') {
      const anchorItem = activeEntries.length ? activeEntries[activeEntries.length - 1] : lastHistory;
      if (!anchorItem || anchorItem.type !== 'episode' || !corpus.length) {
        autoQueue.next = null;
        autoQueue.cursor = null;
      } else {
        const serverId = anchorItem.serverId;
        const items = corpus.filter(item => item.serverId === serverId);
        const active = new Set(activeEntries.filter(item => item.serverId === serverId).map(item => item.mediaId));
        const itemsIndexMap = new Map();
        for (let i = 0; i < items.length; i++) itemsIndexMap.set(items[i].serverId + ':' + items[i].mediaId, i);
        let anchor = itemsIndexMap.get(serverId + ':' + anchorItem.mediaId) ?? -1;
        if (anchor === -1) {
          autoQueue.next = null;
          autoQueue.cursor = null;
        } else {
          if (autoQueue.cursor) {
            const cursorIdx = itemsIndexMap.get(serverId + ':' + autoQueue.cursor);
            if (cursorIdx !== undefined && cursorIdx > anchor) anchor = cursorIdx;
            else if (cursorIdx === undefined) autoQueue.cursor = null;
          }
          let nextItem = null;
          for (let index = anchor + 1; index < items.length; index++) {
            const item = items[index];
            if (!active.has(item.mediaId)) {
              nextItem = { ...item, position: 0, provenance: 'continue' };
              break;
            }
          }
          autoQueue.next = nextItem;
        }
      }
    } else if (autoQueue.mode === 'following') {
      const serverId = autoQueue.scope.serverId;
      const items = corpus.filter(item => item.serverId === serverId);
      const active = new Set(activeEntries.filter(item => item.serverId === serverId).map(item => item.mediaId));
      const itemsIndexMap = new Map();
      for (let i = 0; i < items.length; i++) itemsIndexMap.set(items[i].serverId + ':' + items[i].mediaId, i);
      let anchor = autoQueue.cursor ? (itemsIndexMap.get(serverId + ':' + autoQueue.cursor) ?? -1) : -1;
      for (const item of activeEntries) {
        const index = itemsIndexMap.get(item.serverId + ':' + item.mediaId);
        if (index !== undefined && index > anchor) anchor = index;
      }
      let nextItem = null;
      for (let index = anchor + 1; index < items.length; index++) {
        const item = items[index];
        if (!active.has(item.mediaId)) {
          nextItem = { ...item, position: 0, provenance: 'following' };
          break;
        }
      }
      autoQueue.next = nextItem;
    } else {
      const serverId = autoQueue.scope.serverId;
      const items = corpus.filter(item => item.serverId === serverId);
      const poolIds = new Set(items.map(item => item.mediaId));
      const active = new Set(activeEntries.filter(item => item.serverId === serverId).map(item => item.mediaId));
      if (
        !forceAdvance &&
        autoQueue.next &&
        poolIds.has(autoQueue.next.mediaId) &&
        !active.has(autoQueue.next.mediaId)
      ) {
        const poolItem = items.find(item => item.mediaId === autoQueue.next.mediaId);
        if (poolItem) autoQueue.next = { ...poolItem, position: 0, provenance: 'random' };
        const used = new Set(autoQueue.used.filter(id => poolIds.has(id)));
        for (const id of active) if (poolIds.has(id)) used.add(id);
        used.add(autoQueue.next.mediaId);
        autoQueue.used = [...used];
      } else {
        let used = new Set(autoQueue.used.filter(id => poolIds.has(id)));
        for (const id of active) if (poolIds.has(id)) used.add(id);
        if (forceAdvance && autoQueue.next && poolIds.has(autoQueue.next.mediaId)) used.add(autoQueue.next.mediaId);
        let available = items.filter(item => !used.has(item.mediaId) && !active.has(item.mediaId));
        if (!available.length && items.some(item => !active.has(item.mediaId)) && used.size >= poolIds.size) {
          autoQueue.cycle++;
          used = new Set([...active].filter(id => poolIds.has(id)));
          available = items.filter(item => !active.has(item.mediaId));
        }
        if (available.length) {
          const idx = this.randomIndex(available.length);
          const item = available[idx];
          autoQueue.next = { ...item, position: 0, provenance: 'random' };
          used.add(item.mediaId);
        } else {
          autoQueue.next = null;
        }
        autoQueue.used = [...used];
      }
    }
    const changed = JSON.stringify(room.autoQueue) !== JSON.stringify(autoQueue);
    if (changed) repositories(this.db).rooms.updateRoomsSetAutoQueueById(JSON.stringify(autoQueue), roomId);
    return { next: autoQueue.next, autoQueue, changed };
  }

  validateCorpus(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length > 20000) throw error('Invalid auto-queue corpus');
    const seen = new Set();
    return rawItems.map(validateItem).filter(item => {
      const key = item.serverId + ':' + item.mediaId;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any[]} rawItems
   * @param {{expectedRevision?:number,continuation?:boolean,forceAdvance?:boolean}} [options]
   */
  async generate(roomId, userId, rawItems, { expectedRevision, continuation = false, forceAdvance = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    if (typeof continuation !== 'boolean') throw error('Invalid auto-queue continuation');
    if (continuation) {
      const canonical = this.account(userId);
      if (
        this.store.isAdmin(canonical) !== true &&
        !Policy.allowed(room, canonical, 'chooseMedia') &&
        !Policy.allowed(room, canonical, 'addQueue') &&
        !Policy.allowed(room, canonical, 'editQueue') &&
        !Policy.allowed(room, canonical, 'playPause')
      ) {
        throw error('Room queue permission required', 403);
      }
    } else {
      this.assertAllowed(room, userId, 'editQueue');
    }
    this.assertRevision(room, expectedRevision);
    const corpus = this.validateCorpus(rawItems),
      at = this.now();
    let result;
    this.registry.transaction(() => {
      result = this.computeAutoNext(roomId, corpus, { forceAdvance });
      if (result.changed) this.bumpQueueRevision(roomId, at);
    });
    await this.store.commit();
    return {
      added: result.changed && result.next ? [result.next] : [],
      next: result.next,
      autoQueue: result.autoQueue,
      queueRevision: room.queueRevision + (result.changed ? 1 : 0),
    };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any[]} rawItems
   * @param {{expectedRevision?:number}} [options]
   */
  async skipAuto(roomId, userId, rawItems, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);
    const autoNext = room.autoQueue?.mode !== 'off' ? room.autoQueue?.next : null;
    if (!autoNext) throw error('Auto-queue item unavailable', 404);
    const corpus = this.validateCorpus(rawItems),
      at = this.now();
    let result;
    this.registry.transaction(() => {
      if (room.autoQueue.mode === 'following' || room.autoQueue.mode === 'continue') {
        const updated = { ...room.autoQueue, cursor: autoNext.mediaId };
        repositories(this.db).rooms.updateRoomsSetAutoQueueById(JSON.stringify(updated), roomId);
      }
      result = this.computeAutoNext(roomId, corpus, { forceAdvance: true });
      this.bumpQueueRevision(roomId, at, { clearCursor: false });
    });
    await this.store.commit();
    return { skipped: autoNext, next: result.next, autoQueue: result.autoQueue, queueRevision: room.queueRevision + 1 };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {any[]} rawItems
   * @param {{expectedRevision?:number}} [options]
   */
  async pinAuto(roomId, userId, rawItems, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'addQueue');
    this.assertRevision(room, expectedRevision);
    const autoNext = room.autoQueue?.mode !== 'off' ? room.autoQueue?.next : null;
    if (!autoNext) throw error('Auto-queue item unavailable', 404);
    const pending = this.pending(roomId);
    if (pending.length >= this.maxPending)
      throw error('Queue is full (maximum ' + this.maxPending + ' upcoming items)');
    const corpus = rawItems === undefined ? undefined : this.validateCorpus(rawItems),
      at = this.now();
    let addedId, result;
    this.registry.transaction(() => {
      [addedId] = this.insertPending(roomId, [{ ...autoNext, position: 0, provenance: 'manual' }], pending.length, at);
      const cleared = {
        ...room.autoQueue,
        next: null,
        ...(room.autoQueue.mode === 'following' || room.autoQueue.mode === 'continue'
          ? { cursor: autoNext.mediaId }
          : {}),
        ...(room.autoQueue.mode === 'random'
          ? { used: [...new Set([...(room.autoQueue.used || []), autoNext.mediaId])] }
          : {}),
      };
      repositories(this.db).rooms.updateRoomsSetAutoQueueById(JSON.stringify(cleared), roomId);
      if (corpus !== undefined) {
        result = this.computeAutoNext(roomId, corpus, { forceAdvance: true });
      } else {
        result = { next: null, autoQueue: cleared };
      }
      this.bumpQueueRevision(roomId, at, { clearCursor: false });
    });
    await this.store.commit();
    return {
      added: this.getEntry(addedId),
      next: result.next,
      autoQueue: result.autoQueue,
      queueRevision: room.queueRevision + 1,
    };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {QueueAdvanceOptions} [options]
   */
  async playAutoNow(
    roomId,
    userId,
    { currentPosition = 0, expectedRevision, autoCorpus, corpus, guard, skipPrevious = false } = {},
  ) {
    this.healthy();
    const room = this.room(roomId);
    const current = this.current(roomId);
    if (!current) {
      const canonical = this.account(userId);
      if (
        this.store.isAdmin(canonical) !== true &&
        !Policy.allowed(room, canonical, 'chooseMedia') &&
        !Policy.allowed(room, canonical, 'playPause')
      ) {
        throw error('Room queue permission required', 403);
      }
    } else {
      this.assertAllowed(room, userId, 'chooseMedia');
    }
    this.assertRevision(room, expectedRevision);
    if (guard && guard() !== true) throw error('Playback changed before queue advance', 409);
    const autoNext = room.autoQueue?.mode !== 'off' ? room.autoQueue?.next : null;
    if (!autoNext) throw error('Auto-queue item unavailable', 404);
    const generationCorpus = autoCorpus ?? corpus;
    const validatedCorpus = generationCorpus === undefined ? undefined : this.validateCorpus(generationCorpus);
    const at = this.now(),
      id = randomUUID();
    let generated;
    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.interruptCurrent(clamped, at, at, current.id);
      }
      if (skipPrevious) {
        repositories(this.db).queue.skipPending(at, at, roomId);
      }
      repositories(this.db).queue.insertQueueEntries(
        id,
        roomId,
        'current',
        null,
        autoNext.serverId,
        autoNext.mediaId,
        autoNext.type,
        autoNext.title,
        autoNext.parentTitle || null,
        autoNext.grandparentTitle || null,
        autoNext.thumb || null,
        autoNext.duration,
        0,
        null,
        autoNext.provenance || room.autoQueue.mode,
        at,
        at,
        null,
        at,
      );
      const bookmark = {
        serverId: autoNext.serverId,
        mediaId: autoNext.mediaId,
        type: autoNext.type,
        title: autoNext.title,
        duration: autoNext.duration,
        position: 0,
      };
      const cleared = {
        ...room.autoQueue,
        next: null,
        ...(room.autoQueue.mode === 'following' || room.autoQueue.mode === 'continue'
          ? { cursor: autoNext.mediaId }
          : {}),
      };
      repositories(this.db).rooms.saveQueueAndAutoBookmark(
        JSON.stringify(bookmark),
        JSON.stringify(cleared),
        at,
        roomId,
      );
      if (validatedCorpus) generated = this.computeAutoNext(roomId, validatedCorpus, { forceAdvance: true });
      this.pruneHistory(roomId);
    });
    await this.store.commit();
    return {
      current: this.getEntry(id),
      previous: current,
      generated: generated?.next ? [generated.next] : [],
      queueRevision: room.queueRevision + 1,
    };
  }

  async move(roomId, userId, entryId, targetRank, expectedRevision) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);

    const entry = this.getEntry(entryId);
    if (!entry || entry.roomId !== roomId || entry.state !== 'pending') {
      throw error('Queue item unavailable', 404);
    }

    const rows = repositories(this.db).queue.listPendingIds(roomId);
    const ids = rows.map(r => r.id);
    const fromIndex = ids.indexOf(entryId);
    if (fromIndex === -1) throw error('Queue item unavailable', 404);
    if (!Number.isInteger(targetRank) || targetRank < 0 || targetRank >= ids.length) {
      throw error('Invalid target rank', 400);
    }
    if (fromIndex === targetRank) {
      return { queueRevision: room.queueRevision };
    }

    ids.splice(fromIndex, 1);
    ids.splice(targetRank, 0, entryId);

    const at = this.now();
    this.registry.transaction(() => {
      const updateRank = repositories(this.db).queue.rankStatement;
      for (let i = 0; i < ids.length; i++) {
        updateRank.run(i, at, ids[i]);
      }
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { queueRevision: room.queueRevision + 1 };
  }

  async remove(roomId, userId, entryId, expectedRevision, { allowCurrent = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);

    const entry = this.getEntry(entryId);
    if (
      !entry ||
      entry.roomId !== roomId ||
      !['pending', 'history', ...(allowCurrent ? ['current'] : [])].includes(entry.state)
    ) {
      throw error('Queue item unavailable', 404);
    }

    if (entry.state === 'current') this.assertAllowed(room, userId, 'chooseMedia');
    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).queue.deleteQueueEntriesById(entryId);
      if (entry.state === 'pending') {
        repositories(this.db).queue.closeRankGap(at, roomId, entry.rank);
      }
      if (entry.state === 'current') repositories(this.db).rooms.clearBookmark(roomId);
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { removed: entryId, queueRevision: room.queueRevision + 1 };
  }

  async clear(roomId, userId, expectedRevision) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);

    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).queue.clearPending(roomId);
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { cleared: true, queueRevision: room.queueRevision + 1 };
  }

  async playNow(roomId, userId, rawItem, currentPosition = 0, { initialAdd = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, initialAdd ? 'addQueue' : 'chooseMedia');
    if (initialAdd && (this.current(roomId) || this.pending(roomId).length))
      throw error('Queue is no longer empty', 409);
    const item = validateItem(rawItem);

    const at = this.now(),
      id = randomUUID();
    const current = this.current(roomId);

    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.interruptCurrent(clamped, at, at, current.id);
      }

      repositories(this.db).queue.insertQueueEntries(
        id,
        roomId,
        'current',
        null,
        item.serverId,
        item.mediaId,
        item.type,
        item.title,
        item.parentTitle,
        item.grandparentTitle,
        item.thumb,
        item.duration,
        item.position || 0,
        null,
        item.provenance || 'manual',
        at,
        at,
        null,
        at,
      );

      const bookmark = {
        serverId: item.serverId,
        mediaId: item.mediaId,
        type: item.type,
        title: item.title,
        duration: item.duration,
        position: item.position || 0,
      };
      const autoQueue = room.autoQueue?.cursor ? { ...room.autoQueue, cursor: null } : room.autoQueue;
      repositories(this.db).rooms.saveQueueAndAutoBookmark(
        JSON.stringify(bookmark),
        JSON.stringify(autoQueue),
        at,
        roomId,
      );

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { current: this.getEntry(id), previous: current, queueRevision: room.queueRevision + 1 };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {string} entryId
   * @param {QueueAdvanceOptions} [options]
   */
  async playEntry(
    roomId,
    userId,
    entryId,
    { skipPrevious = false, currentPosition = 0, expectedRevision, autoCorpus, corpus, guard, initialAdd = false } = {},
  ) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, initialAdd ? 'addQueue' : 'chooseMedia');
    if (initialAdd && (this.current(roomId) || this.pending(roomId)[0]?.id !== entryId))
      throw error('Queue selection changed', 409);
    this.assertRevision(room, expectedRevision);
    if (guard && guard() !== true) throw error('Playback changed before queue advance', 409);

    const target = this.getEntry(entryId);
    if (!target || target.roomId !== roomId || target.state !== 'pending') {
      throw error('Queue entry unavailable', 404);
    }

    const current = this.current(roomId);
    const generationCorpus = autoCorpus ?? corpus;
    const validatedCorpus = generationCorpus === undefined ? undefined : this.validateCorpus(generationCorpus);
    const at = this.now();
    let generated;

    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.interruptCurrent(clamped, at, at, current.id);
      }

      if (skipPrevious) {
        repositories(this.db).queue.skipBefore(at, at, roomId, target.rank);

        repositories(this.db).queue.shiftRanksAfter(target.rank + 1, at, roomId, target.rank);
      } else {
        repositories(this.db).queue.closeSuccessorGap(at, roomId, target.rank);
      }

      repositories(this.db).queue.startEntry(at, at, target.id);

      const bookmark = {
        serverId: target.serverId,
        mediaId: target.mediaId,
        type: target.type,
        title: target.title,
        duration: target.duration,
        position: target.position || 0,
      };
      const autoQueue = room.autoQueue?.cursor ? { ...room.autoQueue, cursor: null } : room.autoQueue;
      repositories(this.db).rooms.saveQueueAndAutoBookmark(
        JSON.stringify(bookmark),
        JSON.stringify(autoQueue),
        at,
        roomId,
      );

      if (validatedCorpus) generated = this.computeAutoNext(roomId, validatedCorpus);
      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return {
      current: this.getEntry(target.id),
      previous: current,
      generated: generated?.next ? [generated.next] : [],
      queueRevision: room.queueRevision + 1,
    };
  }

  async completeCurrent(roomId) {
    this.healthy();
    const room = this.room(roomId);
    const current = this.current(roomId);
    if (!current) return { queueRevision: room.queueRevision };
    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).queue.completeCurrent(at, at, current.id);
      repositories(this.db).queue.insertRoomProgress(roomId, current.serverId, current.mediaId);

      repositories(this.db).rooms.clearQueueBookmark(at, roomId);

      this.pruneHistory(roomId);
    });
    await this.store.commit();
    return { completed: current, queueRevision: room.queueRevision + 1 };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {QueueAdvanceOptions} [options]
   */
  async next(
    roomId,
    userId,
    {
      currentPosition = 0,
      outcome = 'skipped',
      expectedRevision,
      currentEntryId,
      nextEntryId,
      autoCorpus,
      corpus,
      guard,
      discardCurrent = false,
      initialAdd = false,
    } = {},
  ) {
    this.healthy();
    const room = this.room(roomId);
    const current = this.current(roomId);
    if (!current && !discardCurrent) {
      const canonical = this.account(userId);
      if (
        this.store.isAdmin(canonical) !== true &&
        !Policy.allowed(room, canonical, 'chooseMedia') &&
        !Policy.allowed(room, canonical, 'playPause') &&
        !(initialAdd && (Policy.allowed(room, canonical, 'addQueue') || Policy.allowed(room, canonical, 'editQueue')))
      ) {
        throw error('Room queue permission required', 403);
      }
    } else {
      this.assertAllowed(room, userId, 'chooseMedia');
    }
    if (discardCurrent) this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);

    const nextPending = this.peekNext(roomId);
    const autoNext = !nextPending && room.autoQueue?.mode !== 'off' ? room.autoQueue?.next || null : null;
    if (currentEntryId !== undefined && currentEntryId !== (current?.id || null)) {
      throw error('Queue changed; refresh before advancing', 409);
    }
    if (nextEntryId !== undefined) {
      const validNextId = nextPending
        ? nextEntryId === nextPending.id
        : autoNext
          ? nextEntryId === 'auto:' + autoNext.mediaId || nextEntryId === autoNext.mediaId
          : nextEntryId === null;
      if (!validNextId) throw error('Queue changed; refresh before advancing', 409);
    }
    if (guard && guard() !== true) throw error('Playback changed before queue advance', 409);
    if (!nextPending && !autoNext) return { current: null, previous: null, queueRevision: room.queueRevision };

    const generationCorpus = autoCorpus ?? corpus;
    const validatedCorpus = generationCorpus === undefined ? undefined : this.validateCorpus(generationCorpus);
    const at = this.now();
    const validOutcome = ['completed', 'skipped', 'interrupted'].includes(outcome) ? outcome : 'skipped';
    let generated, targetId;

    this.registry.transaction(() => {
      if (current && discardCurrent) repositories(this.db).queue.deleteQueueEntriesById(current.id);
      else if (current) {
        const clamped =
          validOutcome === 'completed'
            ? current.duration
            : Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.endCurrent(clamped, validOutcome, at, at, current.id);
        if (validOutcome === 'completed')
          repositories(this.db).queue.insertRoomProgress(roomId, current.serverId, current.mediaId);
      }

      if (nextPending) {
        targetId = nextPending.id;
        repositories(this.db).queue.startSuccessor(at, at, nextPending.id);

        repositories(this.db).queue.updateQueueEntriesSetRankUpdatedAtByRoomIdState(at, roomId);

        const bookmark = {
          serverId: nextPending.serverId,
          mediaId: nextPending.mediaId,
          type: nextPending.type,
          title: nextPending.title,
          duration: nextPending.duration,
          position: nextPending.position || 0,
        };
        repositories(this.db).rooms.saveQueueBookmark(JSON.stringify(bookmark), at, roomId);

        if (validatedCorpus) generated = this.computeAutoNext(roomId, validatedCorpus);
      } else {
        targetId = randomUUID();
        repositories(this.db).queue.insertQueueEntries3(
          targetId,
          roomId,
          'current',
          null,
          autoNext.serverId,
          autoNext.mediaId,
          autoNext.type,
          autoNext.title,
          autoNext.parentTitle || null,
          autoNext.grandparentTitle || null,
          autoNext.thumb || null,
          autoNext.duration,
          0,
          null,
          autoNext.provenance || room.autoQueue.mode,
          at,
          at,
          null,
          at,
        );

        const bookmark = {
          serverId: autoNext.serverId,
          mediaId: autoNext.mediaId,
          type: autoNext.type,
          title: autoNext.title,
          duration: autoNext.duration,
          position: 0,
        };
        const cleared = {
          ...room.autoQueue,
          next: null,
          ...(room.autoQueue.mode === 'following' || room.autoQueue.mode === 'continue'
            ? { cursor: autoNext.mediaId }
            : {}),
        };
        repositories(this.db).rooms.saveTransitionBookmark(
          JSON.stringify(bookmark),
          JSON.stringify(cleared),
          at,
          roomId,
        );

        if (validatedCorpus) generated = this.computeAutoNext(roomId, validatedCorpus, { forceAdvance: true });
      }
      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return {
      current: this.getEntry(targetId),
      previous: current,
      generated: generated?.next ? [generated.next] : [],
      queueRevision: room.queueRevision + 1,
    };
  }

  async previous(roomId, userId, currentPosition = 0, thresholdSeconds = 5) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'chooseMedia');

    const current = this.current(roomId);
    if (current && currentPosition >= thresholdSeconds) {
      const at = this.now();
      this.registry.transaction(() => {
        repositories(this.db).queue.updateQueueEntriesSetPositionUpdatedAtById(at, current.id);
        const bookmark = room.bookmark ? { ...room.bookmark, position: 0 } : null;
        repositories(this.db).rooms.savePositionBookmark(bookmark ? JSON.stringify(bookmark) : null, at, roomId);
      });
      await this.store.commit();
      return { action: 'restart', position: 0, current, queueRevision: room.queueRevision };
    }

    const last = this.lastHistory(roomId);
    if (!last) {
      if (current) {
        const at = this.now();
        this.registry.transaction(() => {
          repositories(this.db).queue.updateQueueEntriesSetPositionUpdatedAtById(at, current.id);
          const bookmark = room.bookmark ? { ...room.bookmark, position: 0 } : null;
          repositories(this.db).rooms.savePositionBookmark(bookmark ? JSON.stringify(bookmark) : null, at, roomId);
        });
        await this.store.commit();
      }
      return { action: 'restart', position: 0, current, queueRevision: room.queueRevision };
    }

    // Replay prior history entry as a fresh occurrence
    const id = randomUUID(),
      at = this.now();
    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.interruptCurrent(clamped, at, at, current.id);
      }

      repositories(this.db).queue.insertQueueEntries(
        id,
        roomId,
        'current',
        null,
        last.serverId,
        last.mediaId,
        last.type,
        last.title,
        last.parentTitle,
        last.grandparentTitle,
        last.thumb,
        last.duration,
        0,
        null,
        last.provenance,
        at,
        at,
        null,
        at,
      );

      const bookmark = {
        serverId: last.serverId,
        mediaId: last.mediaId,
        type: last.type,
        title: last.title,
        duration: last.duration,
        position: 0,
      };
      const autoQueue = room.autoQueue?.cursor ? { ...room.autoQueue, cursor: null } : room.autoQueue;
      repositories(this.db).rooms.saveQueueAndAutoBookmark(
        JSON.stringify(bookmark),
        JSON.stringify(autoQueue),
        at,
        roomId,
      );

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { action: 'replayed', current: this.getEntry(id), previous: current, queueRevision: room.queueRevision + 1 };
  }

  /**
   * @param {string} roomId
   * @param {string} userId
   * @param {string} historyEntryId
   * @param {{resume?:boolean,restore?:boolean,expectedRevision?:number}} [options]
   * @param {number} [currentPosition]
   */
  async historyReplay(
    roomId,
    userId,
    historyEntryId,
    { resume = false, restore = false, expectedRevision } = {},
    currentPosition = 0,
  ) {
    this.healthy();
    const room = this.room(roomId);
    if (!restore && !this.current(roomId)) {
      const canonical = this.account(userId);
      if (
        this.store.isAdmin(canonical) !== true &&
        !Policy.allowed(room, canonical, 'chooseMedia') &&
        !Policy.allowed(room, canonical, 'playPause')
      ) {
        throw error('Room queue permission required', 403);
      }
    } else {
      this.assertAllowed(room, userId, 'chooseMedia');
    }
    this.assertRevision(room, expectedRevision);

    const historyEntry = this.getEntry(historyEntryId);
    if (!historyEntry || historyEntry.roomId !== roomId || historyEntry.state !== 'history') {
      throw error('History entry unavailable', 404);
    }

    const current = this.current(roomId);
    const history = restore ? repositories(this.db).queue.listHistory(roomId).map(rowToEntry) : [];
    const restored = restore
      ? [
          ...history
            .slice(
              0,
              history.findIndex(item => item.id === historyEntryId),
            )
            .reverse(),
          ...(current ? [current] : []),
        ]
      : [];
    if (restore && this.pending(roomId).length + restored.length > this.maxPending)
      throw error('Going back would exceed the queue limit (maximum ' + this.maxPending + ' upcoming items)');
    const targetPosition = (restore ? historyEntry.outcome !== 'completed' : resume)
      ? Math.min(Math.max(0, historyEntry.position), historyEntry.duration)
      : 0;
    const id = randomUUID(),
      at = this.now();
    let restoredIds = [];

    this.registry.transaction(() => {
      if (restore) {
        repositories(this.db).queue.shiftPendingRanks(restored.length, at, roomId);
        restoredIds = this.insertPending(
          roomId,
          restored.map(item => ({ ...item, position: 0 })),
          0,
          at,
        );
        const remove = repositories(this.db).queue.deleteStatement;
        for (const item of restored) remove.run(item.id);
      } else if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        repositories(this.db).queue.interruptCurrent(clamped, at, at, current.id);
      }

      repositories(this.db).queue.insertQueueEntries(
        id,
        roomId,
        'current',
        null,
        historyEntry.serverId,
        historyEntry.mediaId,
        historyEntry.type,
        historyEntry.title,
        historyEntry.parentTitle,
        historyEntry.grandparentTitle,
        historyEntry.thumb,
        historyEntry.duration,
        targetPosition,
        null,
        historyEntry.provenance,
        at,
        at,
        null,
        at,
      );
      // Explicit replay moves this selection out of history. The new occurrence
      // keeps a fresh identity so stale observations cannot target its timeline.
      repositories(this.db).queue.deleteQueueEntriesById(historyEntryId);

      const bookmark = {
        serverId: historyEntry.serverId,
        mediaId: historyEntry.mediaId,
        type: historyEntry.type,
        title: historyEntry.title,
        duration: historyEntry.duration,
        position: targetPosition,
      };
      const autoQueue = room.autoQueue?.cursor ? { ...room.autoQueue, cursor: null } : room.autoQueue;
      repositories(this.db).rooms.saveQueueAndAutoBookmark(
        JSON.stringify(bookmark),
        JSON.stringify(autoQueue),
        at,
        roomId,
      );

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return {
      replayed: this.getEntry(id),
      previous: current,
      restored: restoredIds.map(id => this.getEntry(id)),
      queueRevision: room.queueRevision + 1,
    };
  }

  async historyClear(roomId, userId) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');

    const at = this.now();
    this.registry.transaction(() => {
      repositories(this.db).queue.clearHistory(roomId);
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { cleared: true, queueRevision: room.queueRevision + 1 };
  }

  checkpoint(roomId, position) {
    this.healthy();
    if (!UUID.test(roomId)) return;
    const at = this.now();
    repositories(this.db).queue.updateQueueEntriesSetPositionUpdatedAtByRoomIdState(
      Math.max(0, position || 0),
      at,
      roomId,
    );
  }

  list(roomId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    if (!UUID.test(roomId)) throw error('Room unavailable', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw error('Invalid queue page');
    }
    const room = this.room(roomId);
    const rows = repositories(this.db).queue.pagePending(roomId, limit, offset);
    const count = repositories(this.db).queue.countPending(roomId).count;
    return { items: rows.map(rowToEntry), total: count, queueRevision: room.queueRevision };
  }

  history(roomId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    if (!UUID.test(roomId)) throw error('Room unavailable', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw error('Invalid history page');
    }
    const rows = repositories(this.db).queue.pageHistory(roomId, limit, offset);
    const count = repositories(this.db).queue.countHistory(roomId).count;
    return { items: rows.map(rowToEntry), total: count, queueRevision: this.room(roomId).queueRevision };
  }

  summary(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const pendingCount =
      /** @type {{c:number}|undefined} */ (repositories(this.db).queue.countPendingSummary(roomId))?.c || 0;
    const historyCount =
      /** @type {{c:number}|undefined} */ (repositories(this.db).queue.countHistorySummary(roomId))?.c || 0;
    const currentRow = repositories(this.db).queue.findCurrent(roomId);
    const nextRow = repositories(this.db).queue.findNextPending(roomId);
    const lastHistoryRow = repositories(this.db).queue.findLatestHistory(roomId);
    const roomRow = /** @type {{queueRevision:number,autoQueue:string|null,autoplay:number}|undefined} */ (
      repositories(this.db).rooms.findQueueSettings(roomId)
    );
    const autoQueue = roomRow?.autoQueue
      ? { next: null, ...JSON.parse(roomRow.autoQueue) }
      : { mode: 'off', scope: null, includeSpecials: false, cycle: 0, used: [], next: null };

    return {
      queueLength: pendingCount,
      historyLength: historyCount,
      pendingCount,
      historyCount,
      queueRevision: roomRow?.queueRevision ?? 0,
      autoQueue: {
        mode: autoQueue.mode,
        scope: autoQueue.scope,
        includeSpecials: autoQueue.includeSpecials,
        cycle: autoQueue.cycle,
        usedCount: (autoQueue.used || []).length,
        next: autoQueue.next || null,
      },
      autoplay: roomRow?.autoplay === 1,
      current: currentRow
        ? {
            id: currentRow.id,
            mediaId: currentRow.mediaId,
            type: currentRow.type,
            title: currentRow.title,
            parentTitle: currentRow.parentTitle || null,
            grandparentTitle: currentRow.grandparentTitle || null,
            thumb: currentRow.thumb || null,
            duration: currentRow.duration,
            position: currentRow.position,
            startedAt: currentRow.startedAt || null,
          }
        : null,
      next: nextRow
        ? {
            id: nextRow.id,
            mediaId: nextRow.mediaId,
            type: nextRow.type,
            title: nextRow.title,
            parentTitle: nextRow.parentTitle || null,
            grandparentTitle: nextRow.grandparentTitle || null,
            thumb: nextRow.thumb || null,
            duration: nextRow.duration,
          }
        : null,
      lastHistory: lastHistoryRow
        ? {
            id: lastHistoryRow.id,
            serverId: lastHistoryRow.serverId,
            mediaId: lastHistoryRow.mediaId,
            type: lastHistoryRow.type,
            title: lastHistoryRow.title,
            parentTitle: lastHistoryRow.parentTitle || null,
            grandparentTitle: lastHistoryRow.grandparentTitle || null,
            thumb: lastHistoryRow.thumb || null,
            duration: lastHistoryRow.duration,
            position: lastHistoryRow.position,
            outcome: lastHistoryRow.outcome || null,
            endedAt: lastHistoryRow.endedAt || null,
          }
        : null,
    };
  }

  pruneHistory(roomId) {
    repositories(this.db).queue.trimHistory(roomId, roomId, this.maxHistory);
  }
}

module.exports = { RoomQueue, MAX_PENDING, MAX_HISTORY, validateAuto };
