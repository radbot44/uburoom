// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const Policy = require('./room-policy');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** @typedef {{serverId:string,mediaId:string,type:'movie'|'episode',title:string,duration:number,position:number}} RoomBookmark */
/** @typedef {{id:string,creatorId:string,hosts:string[],name:string,visibility:'public'|'private',revision:number,checkpointRevision:number,queueRevision:number,createdAt:number,updatedAt:number,permissions:Object,bookmark:RoomBookmark|null,autoQueue:Object,autoplay:boolean}} SavedRoom */

function error(message, status = 400) { return Object.assign(new Error(message), { status }); }
function text(value, limit, label) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value) || !value.trim() || value.trim().length > limit) {
    throw error('Invalid ' + label);
  }
  return value.trim();
}
function visibility(value) {
  if (!['public', 'private'].includes(value)) throw error('Invalid room visibility');
  return value;
}
/** @returns {RoomBookmark|null} */
function bookmark(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      typeof value.mediaId !== 'string' || !/^(?:\d{1,20}|demo)$/.test(value.mediaId) ||
      value.mediaId === 'demo' && value.serverId !== 'local-demo' ||
      !['movie', 'episode'].includes(value.type) || !Number.isFinite(value.duration) ||
      value.duration <= 0 || value.duration > 1e9 || !Number.isFinite(value.position) || value.position < 0) {
    throw error('Invalid room bookmark');
  }
  // Allowlist source identity and progress. No token, URL, stream or viewer data.
  return {
    serverId: text(value.serverId, 200, 'Plex server identity'), mediaId: value.mediaId,
    type: value.type, title: text(value.title, 200, 'media title'),
    duration: value.duration, position: Math.min(value.position, value.duration)
  };
}

// This core owns durable records and role checks. Live eligibility, media access,
// command epochs and active-room allocation belong to the Watch integration.
class RoomStore {
  /**
   * @param {import('./accounts').Accounts} registry
   * @param {{defaults?:Object,now?:()=>number,isAdmin?:(userId:string)=>boolean}} [options]
   */
  constructor(registry, { defaults, now = Date.now, isAdmin = () => false } = {}) {
    this.registry = registry;
    this.db = registry.db;
    this.defaults = Policy.policy(defaults);
    this.now = now;
    // Server-owned opt-in Admin mode, never a flag accepted from a room edit.
    this.isAdmin = isAdmin;
  }
  healthy() {
    const failure = this.failure || this.registry.persistence.error;
    if (failure) throw error('Room storage unavailable; restart after checking the database', 503);
  }
  account(id) {
    const account = typeof id === 'string' && UUID.test(id) && this.registry.canonical(id);
    if (!account) throw error('Room account unavailable', 403);
    return account.id;
  }
  /** @returns {SavedRoom} */
  get(id) {
    this.healthy();
    if (!UUID.test(id)) throw error('Room unavailable', 404);
    const row = this.db.prepare('SELECT * FROM watch_rooms WHERE id=?').get(id);
    if (!row) throw error('Room unavailable', 404);
    const creatorId = this.account(row.creatorId);
    const hosts = [...new Set(this.db.prepare('SELECT userId FROM watch_room_hosts WHERE roomId=? ORDER BY userId').all(id)
      .map(entry => this.account(entry.userId)))].filter(userId => userId !== creatorId);
    return {
      id: row.id, creatorId, hosts, name: row.name, visibility: row.visibility,
      revision: row.revision, checkpointRevision: row.checkpointRevision, queueRevision: row.queueRevision ?? 0,
      createdAt: row.createdAt, updatedAt: row.updatedAt,
      permissions: Policy.policy(JSON.parse(row.permissions)), bookmark: row.bookmark === null ? null : bookmark(JSON.parse(row.bookmark)),
      autoQueue: row.autoQueue === null ? { mode: 'off', scope: null, includeSpecials: false, cycle: 0, used: [] } : JSON.parse(row.autoQueue),
      autoplay: row.autoplay === 1
    };
  }
  async commit(result) {
    try { await this.registry.flush(); }
    catch (failure) { this.failure = failure; this.healthy(); }
    return result;
  }
  async create(userId, { name = 'Room', visibility: selectedVisibility = 'public', fullPermissions = false } = {}) {
    this.healthy();
    const creatorId = this.account(userId), id = randomUUID(), at = this.now();
    name = text(name, 100, 'room name');
    selectedVisibility = visibility(selectedVisibility);
    if (typeof fullPermissions !== 'boolean') throw error('Choose full participant permissions on or off');
    const permissions = Policy.policy(this.defaults);
    if (fullPermissions) permissions.viewer = Object.fromEntries(Policy.CAPABILITIES.map(key => [key, true]));
    this.db.prepare('INSERT INTO watch_rooms(id,creatorId,name,visibility,revision,checkpointRevision,queueRevision,createdAt,updatedAt,permissions,bookmark) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, creatorId, name, selectedVisibility, 0, 0, 0, at, at, JSON.stringify(permissions), null);
    return this.commit(this.get(id));
  }
  list(userId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    userId = this.account(userId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('Invalid room page');
    const rooms = [];
    // ken: scan saved memberships; use an indexed canonical-account lookup if
    // measured room listing exceeds 50 ms. Closed rooms consume no player slots.
    for (const row of this.db.prepare('SELECT id FROM watch_rooms ORDER BY updatedAt DESC,id').all()) {
      const room = this.get(row.id);
      if (this.isAdmin(userId) === true || Policy.role(room, userId) !== 'viewer') rooms.push(room);
    }
    return { rooms: rooms.slice(offset, offset + limit), total: rooms.length };
  }
  restore(id, userId) {
    const room = this.get(id);
    userId = this.account(userId);
    if (this.isAdmin(userId) !== true && Policy.role(room, userId) === 'viewer') throw error('Only a room creator, host or active administrator can reopen it', 403);
    // The caller must obtain fresh media/command authority. A stored position
    // never includes elapsed downtime, remote consent or an autoplay intent.
    return { ...room, paused: true };
  }
  async edit(id, userId, revision, change) {
    const room = this.get(id);
    userId = this.account(userId);
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw error('Invalid room change');
    const capabilities = {
      rename: 'roomSettings', visibility: 'roomSettings', 'host.add': 'manageHosts',
      'host.remove': 'manageHosts', 'creator.transfer': 'transferCreator', permissions: 'managePermissions', delete: 'deleteRoom', 'bookmark.clear':'chooseMedia'
    };
    const capability = Object.hasOwn(capabilities, change.action) && capabilities[change.action];
    if (!capability) throw error('Unsupported room change');
    if (this.isAdmin(userId) !== true && !Policy.allowed(room, userId, capability)) throw error('Room permission required', 403);
    if (!Number.isSafeInteger(revision) || revision !== room.revision) throw error('Room changed; refresh before editing', 409);
    const at = this.now();
    this.registry.transaction(() => {
      switch (change.action) {
        case 'rename': room.name = text(change.name, 100, 'room name'); break;
        case 'visibility': room.visibility = visibility(change.visibility); break;
        case 'permissions': {
          if (!['host', 'viewer'].includes(change.role)) throw error('Choose host or viewer permissions');
          room.permissions[change.role] = Policy.permissions(change.permissions, room.permissions[change.role]);
          break;
        }
        case 'host.add': {
          const target = this.account(change.userId);
          if (target === room.creatorId) throw error('The creator is already a host');
          this.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id, target);
          break;
        }
        case 'host.remove': {
          const target = this.account(change.userId);
          if (target === room.creatorId) throw error('Transfer creatorship before removing the creator');
          for (const entry of this.db.prepare('SELECT userId FROM watch_room_hosts WHERE roomId=?').all(id)) {
            if (this.account(entry.userId) === target) this.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=? AND userId=?').run(id, entry.userId);
          }
          break;
        }
        case 'creator.transfer': {
          const target = this.account(change.userId);
          if (target === room.creatorId || !room.hosts.includes(target)) throw error('Transfer creatorship to another assigned host');
          this.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id, room.creatorId);
          for (const entry of this.db.prepare('SELECT userId FROM watch_room_hosts WHERE roomId=?').all(id)) {
            if (this.account(entry.userId) === target) this.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=? AND userId=?').run(id, entry.userId);
          }
          room.creatorId = target;
          break;
        }
        case 'bookmark.clear':
          this.db.prepare('UPDATE watch_rooms SET bookmark=NULL,checkpointRevision=checkpointRevision+1 WHERE id=?').run(id);
          break;
        case 'delete':
          this.db.prepare('DELETE FROM watch_queue_entries WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_rooms WHERE id=?').run(id);
          return;
      }
      this.db.prepare('UPDATE watch_rooms SET creatorId=?,name=?,visibility=?,permissions=?,revision=revision+1,updatedAt=? WHERE id=?')
        .run(room.creatorId, room.name, room.visibility, JSON.stringify(room.permissions), at, id);
    });
    return this.commit(change.action === 'delete' ? { deleted: true } : this.get(id));
  }
  // Server-owned checkpoint API: transport bodies must never be forwarded here.
  // Its own revision avoids invalidating a settings form every five seconds.
  async checkpoint(id, expectedRevision, value) {
    const room = this.get(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== room.checkpointRevision) throw error('Room bookmark changed', 409);
    const saved = bookmark(value);
    this.db.prepare('UPDATE watch_rooms SET bookmark=?,checkpointRevision=checkpointRevision+1,updatedAt=? WHERE id=?')
      .run(saved === null ? null : JSON.stringify(saved), this.now(), id);
    return this.commit(this.get(id));
  }
}

module.exports = { RoomStore };
