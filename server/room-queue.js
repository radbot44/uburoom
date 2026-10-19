// @ts-check
'use strict';

const { randomUUID, randomInt } = require('node:crypto');
const Policy = require('./room-policy');

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const MAX_PENDING = 100;
const MAX_HISTORY = 500;

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function cleanText(value, limit, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) || !value.trim() || value.trim().length > limit) {
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
  const mediaId = typeof raw.mediaId === 'string' && /^(?:\d{1,20}|demo)$/.test(raw.mediaId) ? raw.mediaId : null;
  if (!mediaId) throw error('Invalid media identity');
  if (mediaId === 'demo' && serverId !== 'local-demo') throw error('Invalid demo media source');
  if (!['movie', 'episode'].includes(raw.type)) throw error('Invalid media type');
  const title = cleanText(raw.title, 200, 'title');
  const parentTitle = optionalText(raw.parentTitle, 200);
  const grandparentTitle = optionalText(raw.grandparentTitle, 200);
  const thumb = optionalText(raw.thumb, 500);
  const duration = cleanNumber(raw.duration, 0.001, 1e9, 'duration');
  const provenance = optionalText(raw.provenance, 100);
  const position = raw.position !== undefined ? Math.min(Math.max(0, cleanNumber(raw.position, 0, duration, 'position')), duration) : 0;
  return { serverId, mediaId, type: raw.type, title, parentTitle, grandparentTitle, thumb, duration, position, provenance };
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
    updatedAt: row.updatedAt
  };
}

class RoomQueue {
  /**
   * @param {import('./accounts').Accounts} registry
   * @param {import('./room-store').RoomStore} store
   * @param {{now?: () => number,randomIndex?:(max:number)=>number}} [options]
   */
  constructor(registry, store, { now, randomIndex = randomInt } = {}) {
    this.registry = registry;
    this.db = registry.db;
    this.store = store;
    this.randomIndex = randomIndex;
    let lastNow = 0;
    this.now = typeof now === 'function' ? now : () => {
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
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision !== room.queueRevision)) {
      throw error('Queue changed; refresh before editing', 409);
    }
  }

  assertAllowed(room, userId, capability) {
    const canonical = this.account(userId);
    if (this.store.isAdmin(canonical) !== true && !Policy.allowed(room, canonical, capability)) {
      throw error('Room queue permission required', 403);
    }
  }

  bumpQueueRevision(roomId, at = this.now()) {
    this.db.prepare('UPDATE watch_rooms SET queueRevision = queueRevision + 1, updatedAt = ? WHERE id = ?').run(at, roomId);
  }

  getEntry(entryId) {
    this.healthy();
    if (!UUID.test(entryId)) return null;
    const row = this.db.prepare('SELECT * FROM watch_queue_entries WHERE id = ?').get(entryId);
    return rowToEntry(row);
  }

  current(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'current'").get(roomId);
    return rowToEntry(row);
  }

  peekNext(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC LIMIT 1").get(roomId);
    return rowToEntry(row);
  }

  lastHistory(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const row = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT 1").get(roomId);
    return rowToEntry(row);
  }

  async add(roomId, userId, rawItem, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'addQueue');
    if (expectedRevision !== undefined) this.assertRevision(room, expectedRevision);
    const item = validateItem(rawItem);

    const pendingCount = this.db.prepare("SELECT COUNT(*) AS count FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'").get(roomId).count;
    if (pendingCount >= MAX_PENDING) {
      throw error('Queue limit reached (maximum 100 upcoming items)', 400);
    }

    const id = randomUUID(), at = this.now();
    this.registry.transaction(() => {
      this.db.prepare(`
        INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, roomId, 'pending', pendingCount, item.serverId, item.mediaId, item.type,
        item.title, item.parentTitle, item.grandparentTitle, item.thumb, item.duration,
        item.position, null, item.provenance, at, null, null, at
      );
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { added: this.getEntry(id), queueRevision: room.queueRevision + 1 };
  }

  pending(roomId) {
    return this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC").all(roomId).map(rowToEntry);
  }

  insertPending(roomId, items, startRank, at) {
    const insert = this.db.prepare('INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    return items.map((item, index) => {
      const id = randomUUID();
      insert.run(id, roomId, 'pending', startRank + index, item.serverId, item.mediaId, item.type,
        item.title, item.parentTitle, item.grandparentTitle, item.thumb, item.duration,
        item.position, null, item.provenance, at, null, null, at);
      return id;
    });
  }

  async addBulk(roomId, userId, rawItems, { expectedRevision, unfinished = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'addQueue');
    this.assertRevision(room, expectedRevision);
    if (!Array.isArray(rawItems) || rawItems.length > 20000 || typeof unfinished !== 'boolean') throw error('Invalid bulk queue selection');
    const pending = this.pending(roomId), current = this.current(roomId);
    const key = item => item.serverId + ':' + item.mediaId;
    const excluded = new Set([...pending, ...(current ? [current] : [])].map(key));
    if (unfinished) {
      for (const row of this.db.prepare("SELECT serverId,mediaId FROM watch_queue_entries WHERE roomId = ? AND state = 'history' AND outcome = 'completed'").all(roomId)) excluded.add(key(row));
    }
    const items = [];
    for (const raw of rawItems) {
      const item = validateItem(raw);
      if (!excluded.has(key(item))) { excluded.add(key(item)); items.push(item); }
    }
    if (pending.length + items.length > MAX_PENDING) throw error('Adding ' + items.length + ' items would exceed the queue limit (maximum 100 upcoming items)');
    if (!items.length) return { added: [], addedCount: 0, queueRevision: room.queueRevision };
    const at = this.now(); let ids;
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
      const update = this.db.prepare('UPDATE watch_queue_entries SET rank = ?, updatedAt = ? WHERE id = ?');
      items.forEach((item, rank) => update.run(rank, at, item.id));
      this.bumpQueueRevision(roomId, at);
    });
    await this.store.commit();
    return { queueRevision: room.queueRevision + 1 };
  }

  async configureAuto(roomId, userId, config, { expectedRevision } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);
    if (!config || typeof config !== 'object' || !['off','following','random'].includes(config.mode) ||
        config.includeSpecials !== undefined && typeof config.includeSpecials !== 'boolean') throw error('Invalid auto-queue settings');
    let scope = null;
    if (config.mode !== 'off') {
      const selected = config.scope;
      if (!selected || !['show','library','collection'].includes(selected.type) || config.mode === 'following' && selected.type !== 'show' ||
          typeof selected.id !== 'string' || !/^\d{1,20}$/.test(selected.id)) throw error('Invalid auto-queue scope');
      scope = { type: selected.type, id: selected.id, serverId: cleanText(selected.serverId, 200, 'Plex server identity') };
    }
    const same = room.autoQueue.mode === config.mode && JSON.stringify(room.autoQueue.scope) === JSON.stringify(scope) && room.autoQueue.includeSpecials === !!config.includeSpecials;
    const current = this.current(roomId);
    const active = [...this.pending(roomId), ...(current ? [current] : [])];
    const used = config.mode === 'random' ? [...new Set(active.filter(item => item.serverId === scope.serverId).map(item => item.mediaId))] : [];
    const autoQueue = same ? room.autoQueue : { mode: config.mode, scope, includeSpecials: !!config.includeSpecials, cycle: 0, used };
    const at = this.now();
    this.registry.transaction(() => {
      this.db.prepare('UPDATE watch_rooms SET autoQueue = ?, queueRevision = queueRevision + 1, updatedAt = ? WHERE id = ?').run(JSON.stringify(autoQueue), at, roomId);
    });
    await this.store.commit();
    return { autoQueue, queueRevision: room.queueRevision + 1 };
  }

  async setAutoplay(roomId, userId, enabled) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'autoplay');
    if (typeof enabled !== 'boolean') throw error('Choose autoplay on or off');
    this.registry.transaction(() => {
      this.db.prepare('UPDATE watch_rooms SET autoplay = ?, revision = revision + 1, updatedAt = ? WHERE id = ?').run(enabled ? 1 : 0, this.now(), roomId);
    });
    await this.store.commit();
    return { autoplay: enabled, revision: room.revision + 1 };
  }

  // The caller resolves Plex access before supplying the full, ordered corpus.
  // ken: scan at most 20000 catalog entries; index only if generation exceeds 50 ms measured.
  generatePending(roomId, corpus, targetPending, at) {
    const room = this.room(roomId), autoQueue = { ...room.autoQueue, used: [...room.autoQueue.used] };
    if (autoQueue.mode === 'off') return { ids: [], autoQueue, changed: false };
    const pending = this.pending(roomId), current = this.current(roomId);
    const items = corpus.filter(item => item.serverId === autoQueue.scope.serverId);
    const active = new Set([...pending, ...(current ? [current] : [])].filter(item => item.serverId === autoQueue.scope.serverId).map(item => item.mediaId));
    const selected = [];
    if (autoQueue.mode === 'following') {
      let anchor = -1;
      for (const item of [...(current ? [current] : []), ...pending]) {
        const index = items.findIndex(candidate => candidate.serverId === item.serverId && candidate.mediaId === item.mediaId);
        if (index >= 0) anchor = index;
      }
      for (let index = anchor + 1; index < items.length && pending.length + selected.length < targetPending; index++) {
        const item = items[index];
        if (!active.has(item.mediaId)) { selected.push({ ...item, position: 0, provenance: 'following' }); active.add(item.mediaId); }
      }
    } else {
      const poolIds = new Set(items.map(item => item.mediaId));
      let used = new Set(autoQueue.used.filter(id => poolIds.has(id)));
      for (const id of active) if (poolIds.has(id)) used.add(id);
      while (pending.length + selected.length < targetPending) {
        let available = items.filter(item => !used.has(item.mediaId) && !active.has(item.mediaId));
        if (!available.length) {
          if (!items.some(item => !active.has(item.mediaId))) break;
          if (used.size < poolIds.size) break;
          autoQueue.cycle++;
          used = new Set([...active].filter(id => poolIds.has(id)));
          available = items.filter(item => !active.has(item.mediaId));
        }
        const item = available[this.randomIndex(available.length)];
        selected.push({ ...item, position: 0, provenance: 'random' });
        used.add(item.mediaId); active.add(item.mediaId);
      }
      autoQueue.used = [...used];
    }
    const ids = this.insertPending(roomId, selected, pending.length, at);
    const changed = ids.length > 0 || JSON.stringify(room.autoQueue) !== JSON.stringify(autoQueue);
    if (changed) this.db.prepare('UPDATE watch_rooms SET autoQueue = ? WHERE id = ?').run(JSON.stringify(autoQueue), roomId);
    return { ids, autoQueue, changed };
  }

  validateCorpus(rawItems) {
    if (!Array.isArray(rawItems) || rawItems.length > 20000) throw error('Invalid auto-queue corpus');
    const seen = new Set();
    return rawItems.map(validateItem).filter(item => {
      const key = item.serverId + ':' + item.mediaId;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
  }

  async generate(roomId, userId, rawItems, { expectedRevision, targetPending = 1, continuation = false } = {}) {
    this.healthy();
    const room = this.room(roomId);
    if (typeof continuation !== 'boolean') throw error('Invalid auto-queue continuation');
    this.assertAllowed(room, userId, continuation ? 'chooseMedia' : 'editQueue');
    this.assertRevision(room, expectedRevision);
    if (!Number.isSafeInteger(targetPending) || targetPending < 1 || targetPending > MAX_PENDING) throw error('Invalid auto-queue target');
    const corpus = this.validateCorpus(rawItems), at = this.now(); let result;
    this.registry.transaction(() => {
      result = this.generatePending(roomId, corpus, targetPending, at);
      if (result.changed) this.bumpQueueRevision(roomId, at);
    });
    await this.store.commit();
    return { added: result.ids.map(id => this.getEntry(id)), autoQueue: result.autoQueue, queueRevision: room.queueRevision + (result.changed ? 1 : 0) };
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

    const rows = this.db.prepare("SELECT id FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC").all(roomId);
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
      const updateRank = this.db.prepare('UPDATE watch_queue_entries SET rank = ?, updatedAt = ? WHERE id = ?');
      for (let i = 0; i < ids.length; i++) {
        updateRank.run(i, at, ids[i]);
      }
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { queueRevision: room.queueRevision + 1 };
  }

  async remove(roomId, userId, entryId, expectedRevision) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');
    this.assertRevision(room, expectedRevision);

    const entry = this.getEntry(entryId);
    if (!entry || entry.roomId !== roomId || entry.state !== 'pending') {
      throw error('Queue item unavailable', 404);
    }

    const at = this.now();
    this.registry.transaction(() => {
      this.db.prepare('DELETE FROM watch_queue_entries WHERE id = ?').run(entryId);
      const rows = this.db.prepare("SELECT id FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC").all(roomId);
      const updateRank = this.db.prepare('UPDATE watch_queue_entries SET rank = ?, updatedAt = ? WHERE id = ?');
      for (let i = 0; i < rows.length; i++) {
        updateRank.run(i, at, rows[i].id);
      }
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
      this.db.prepare("DELETE FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'").run(roomId);
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { cleared: true, queueRevision: room.queueRevision + 1 };
  }

  async playNow(roomId, userId, rawItem, currentPosition = 0) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'chooseMedia');
    const item = validateItem(rawItem);

    const at = this.now(), id = randomUUID();
    const current = this.current(roomId);

    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        this.db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = 'interrupted', endedAt = ?, updatedAt = ?
          WHERE id = ?
        `).run(clamped, at, at, current.id);
      }

      this.db.prepare(`
        INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, roomId, 'current', null, item.serverId, item.mediaId, item.type,
        item.title, item.parentTitle, item.grandparentTitle, item.thumb, item.duration,
        item.position || 0, null, item.provenance || 'manual', at, at, null, at
      );

      const bookmark = {
        serverId: item.serverId, mediaId: item.mediaId, type: item.type,
        title: item.title, duration: item.duration, position: item.position || 0
      };
      this.db.prepare(`
        UPDATE watch_rooms
        SET bookmark = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `).run(JSON.stringify(bookmark), at, roomId);

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { current: this.getEntry(id), previous: current, queueRevision: room.queueRevision + 1 };
  }

  async next(roomId, userId, { currentPosition = 0, outcome = 'skipped', expectedRevision, currentEntryId, nextEntryId, autoCorpus, corpus, guard } = {}) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'chooseMedia');
    this.assertRevision(room, expectedRevision);

    const nextPending = this.peekNext(roomId);
    const current = this.current(roomId);
    if (currentEntryId !== undefined && currentEntryId !== (current?.id || null) || nextEntryId !== undefined && nextEntryId !== (nextPending?.id || null)) {
      throw error('Queue changed; refresh before advancing', 409);
    }
    if (guard && guard() !== true) throw error('Playback changed before queue advance', 409);
    if (!nextPending) return { current: null, previous: null, queueRevision: room.queueRevision };

    const generationCorpus = autoCorpus ?? corpus;
    const validatedCorpus = generationCorpus === undefined ? undefined : this.validateCorpus(generationCorpus);
    const at = this.now();
    const validOutcome = ['completed', 'skipped', 'interrupted'].includes(outcome) ? outcome : 'skipped';
    let generated = [];

    this.registry.transaction(() => {
      if (current) {
        const clamped = validOutcome === 'completed' ? current.duration : Math.min(Math.max(0, currentPosition || 0), current.duration);
        this.db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = ?, endedAt = ?, updatedAt = ?
          WHERE id = ?
        `).run(clamped, validOutcome, at, at, current.id);
      }

      this.db.prepare(`
        UPDATE watch_queue_entries
        SET state = 'current', rank = NULL, startedAt = ?, updatedAt = ?
        WHERE id = ?
      `).run(at, at, nextPending.id);

      this.db.prepare(`
        UPDATE watch_queue_entries
        SET rank = rank - 1, updatedAt = ?
        WHERE roomId = ? AND state = 'pending'
      `).run(at, roomId);

      const bookmark = {
        serverId: nextPending.serverId, mediaId: nextPending.mediaId, type: nextPending.type,
        title: nextPending.title, duration: nextPending.duration, position: nextPending.position || 0
      };
      this.db.prepare(`
        UPDATE watch_rooms
        SET bookmark = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `).run(JSON.stringify(bookmark), at, roomId);

      if (validatedCorpus) generated = this.generatePending(roomId, validatedCorpus, 1, at).ids;
      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { current: this.getEntry(nextPending.id), previous: current, generated: generated.map(id => this.getEntry(id)), queueRevision: room.queueRevision + 1 };
  }

  async previous(roomId, userId, currentPosition = 0, thresholdSeconds = 5) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'chooseMedia');

    const current = this.current(roomId);
    if (current && currentPosition >= thresholdSeconds) {
      const at = this.now();
      this.registry.transaction(() => {
        this.db.prepare('UPDATE watch_queue_entries SET position = 0, updatedAt = ? WHERE id = ?').run(at, current.id);
        const bookmark = room.bookmark ? { ...room.bookmark, position: 0 } : null;
        this.db.prepare('UPDATE watch_rooms SET bookmark = ?, checkpointRevision = checkpointRevision + 1, updatedAt = ? WHERE id = ?')
          .run(bookmark ? JSON.stringify(bookmark) : null, at, roomId);
      });
      await this.store.commit();
      return { action: 'restart', position: 0, current, queueRevision: room.queueRevision };
    }

    const last = this.lastHistory(roomId);
    if (!last) {
      if (current) {
        const at = this.now();
        this.registry.transaction(() => {
          this.db.prepare('UPDATE watch_queue_entries SET position = 0, updatedAt = ? WHERE id = ?').run(at, current.id);
          const bookmark = room.bookmark ? { ...room.bookmark, position: 0 } : null;
          this.db.prepare('UPDATE watch_rooms SET bookmark = ?, checkpointRevision = checkpointRevision + 1, updatedAt = ? WHERE id = ?')
            .run(bookmark ? JSON.stringify(bookmark) : null, at, roomId);
        });
        await this.store.commit();
      }
      return { action: 'restart', position: 0, current, queueRevision: room.queueRevision };
    }

    // Replay prior history entry as a fresh occurrence
    const id = randomUUID(), at = this.now();
    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        this.db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = 'interrupted', endedAt = ?, updatedAt = ?
          WHERE id = ?
        `).run(clamped, at, at, current.id);
      }

      this.db.prepare(`
        INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, roomId, 'current', null, last.serverId, last.mediaId, last.type,
        last.title, last.parentTitle, last.grandparentTitle, last.thumb, last.duration,
        0, null, last.provenance, at, at, null, at
      );

      const bookmark = {
        serverId: last.serverId, mediaId: last.mediaId, type: last.type,
        title: last.title, duration: last.duration, position: 0
      };
      this.db.prepare(`
        UPDATE watch_rooms
        SET bookmark = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `).run(JSON.stringify(bookmark), at, roomId);

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { action: 'replayed', current: this.getEntry(id), previous: current, queueRevision: room.queueRevision + 1 };
  }

  async historyReplay(roomId, userId, historyEntryId, { resume = false } = {}, currentPosition = 0) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'chooseMedia');

    const historyEntry = this.getEntry(historyEntryId);
    if (!historyEntry || historyEntry.roomId !== roomId || historyEntry.state !== 'history') {
      throw error('History entry unavailable', 404);
    }

    const current = this.current(roomId);
    const targetPosition = resume ? Math.min(Math.max(0, historyEntry.position), historyEntry.duration) : 0;
    const id = randomUUID(), at = this.now();

    this.registry.transaction(() => {
      if (current) {
        const clamped = Math.min(Math.max(0, currentPosition || 0), current.duration);
        this.db.prepare(`
          UPDATE watch_queue_entries
          SET state = 'history', rank = NULL, position = ?, outcome = 'interrupted', endedAt = ?, updatedAt = ?
          WHERE id = ?
        `).run(clamped, at, at, current.id);
      }

      this.db.prepare(`
        INSERT INTO watch_queue_entries VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        id, roomId, 'current', null, historyEntry.serverId, historyEntry.mediaId, historyEntry.type,
        historyEntry.title, historyEntry.parentTitle, historyEntry.grandparentTitle, historyEntry.thumb, historyEntry.duration,
        targetPosition, null, historyEntry.provenance, at, at, null, at
      );

      const bookmark = {
        serverId: historyEntry.serverId, mediaId: historyEntry.mediaId, type: historyEntry.type,
        title: historyEntry.title, duration: historyEntry.duration, position: targetPosition
      };
      this.db.prepare(`
        UPDATE watch_rooms
        SET bookmark = ?, checkpointRevision = checkpointRevision + 1, queueRevision = queueRevision + 1, updatedAt = ?
        WHERE id = ?
      `).run(JSON.stringify(bookmark), at, roomId);

      this.pruneHistory(roomId);
    });

    await this.store.commit();
    return { replayed: this.getEntry(id), previous: current, queueRevision: room.queueRevision + 1 };
  }

  async historyClear(roomId, userId) {
    this.healthy();
    const room = this.room(roomId);
    this.assertAllowed(room, userId, 'editQueue');

    const at = this.now();
    this.registry.transaction(() => {
      this.db.prepare("DELETE FROM watch_queue_entries WHERE roomId = ? AND state = 'history'").run(roomId);
      this.bumpQueueRevision(roomId, at);
    });

    await this.store.commit();
    return { cleared: true, queueRevision: room.queueRevision + 1 };
  }

  checkpoint(roomId, position) {
    this.healthy();
    if (!UUID.test(roomId)) return;
    const at = this.now();
    this.db.prepare("UPDATE watch_queue_entries SET position = ?, updatedAt = ? WHERE roomId = ? AND state = 'current'")
      .run(Math.max(0, position || 0), at, roomId);
  }

  list(roomId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    if (!UUID.test(roomId)) throw error('Room unavailable', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw error('Invalid queue page');
    }
    const room = this.room(roomId);
    const rows = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC LIMIT ? OFFSET ?")
      .all(roomId, limit, offset);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'").get(roomId).count;
    return { items: rows.map(rowToEntry), total: count, queueRevision: room.queueRevision };
  }

  history(roomId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    if (!UUID.test(roomId)) throw error('Room unavailable', 404);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw error('Invalid history page');
    }
    const rows = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(roomId, limit, offset);
    const count = this.db.prepare("SELECT COUNT(*) AS count FROM watch_queue_entries WHERE roomId = ? AND state = 'history'").get(roomId).count;
    return { items: rows.map(rowToEntry), total: count };
  }

  summary(roomId) {
    this.healthy();
    if (!UUID.test(roomId)) return null;
    const pendingCount = this.db.prepare("SELECT COUNT(*) AS c FROM watch_queue_entries WHERE roomId = ? AND state = 'pending'").get(roomId)?.c || 0;
    const historyCount = this.db.prepare("SELECT COUNT(*) AS c FROM watch_queue_entries WHERE roomId = ? AND state = 'history'").get(roomId)?.c || 0;
    const currentRow = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'current'").get(roomId);
    const nextRow = this.db.prepare("SELECT * FROM watch_queue_entries WHERE roomId = ? AND state = 'pending' ORDER BY rank ASC LIMIT 1").get(roomId);
    const roomRow = this.db.prepare('SELECT queueRevision,autoQueue,autoplay FROM watch_rooms WHERE id = ?').get(roomId);
    const autoQueue = roomRow?.autoQueue ? JSON.parse(roomRow.autoQueue) : { mode: 'off', scope: null, includeSpecials: false, cycle: 0, used: [] };

    return {
      queueLength: pendingCount,
      historyLength: historyCount,
      pendingCount,
      historyCount,
      queueRevision: roomRow?.queueRevision ?? 0,
      autoQueue: { mode: autoQueue.mode, scope: autoQueue.scope, includeSpecials: autoQueue.includeSpecials, cycle: autoQueue.cycle, usedCount: autoQueue.used.length },
      autoplay: roomRow?.autoplay === 1,
      current: currentRow ? {
        id: currentRow.id,
        mediaId: currentRow.mediaId,
        type: currentRow.type,
        title: currentRow.title,
        parentTitle: currentRow.parentTitle || null,
        grandparentTitle: currentRow.grandparentTitle || null,
        thumb: currentRow.thumb || null,
        duration: currentRow.duration,
        position: currentRow.position,
        startedAt: currentRow.startedAt || null
      } : null,
      next: nextRow ? {
        id: nextRow.id,
        mediaId: nextRow.mediaId,
        type: nextRow.type,
        title: nextRow.title,
        parentTitle: nextRow.parentTitle || null,
        grandparentTitle: nextRow.grandparentTitle || null,
        thumb: nextRow.thumb || null,
        duration: nextRow.duration
      } : null
    };
  }

  pruneHistory(roomId) {
    this.db.prepare(`
      DELETE FROM watch_queue_entries
      WHERE roomId = ? AND state = 'history' AND id NOT IN (
        SELECT id FROM watch_queue_entries WHERE roomId = ? AND state = 'history' ORDER BY endedAt DESC, rowid DESC LIMIT ?
      )
    `).run(roomId, roomId, MAX_HISTORY);
  }
}

module.exports = { RoomQueue, MAX_PENDING, MAX_HISTORY };
