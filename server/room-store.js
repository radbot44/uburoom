// @ts-check
'use strict';

const { randomUUID } = require('node:crypto');
const Policy = require('./room-policy');
const { validateAuto } = require('./room-queue');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/** @typedef {{serverId:string,mediaId:string,type:'movie'|'episode',title:string,duration:number,position:number}} RoomBookmark */
/** @typedef {{id:string,creatorId:string,hosts:string[],name:string,visibility:'public'|'private',revision:number,checkpointRevision:number,queueRevision:number,createdAt:number,updatedAt:number,lastAccessedAt:number,keepEmpty:boolean,maxMembers:number|null,liveState:{viewers:string[],wasPlaying:boolean}|null,permissions:Object,bookmark:RoomBookmark|null,autoQueue:Object,autoplay:boolean}} SavedRoom */

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
   * @param {{defaults?:Object,now?:()=>number,isAdmin?:(userId:string)=>boolean,limits?:typeof import('./room-limits').DEFAULTS}} [options]
   */
  constructor(registry, { defaults, now = Date.now, isAdmin = () => false, limits = require('./room-limits').DEFAULTS } = {}) {
    this.registry = registry;
    this.db = registry.db;
    this.defaults = Policy.policy(defaults);
    this.now = now; this.limits = limits;
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
      createdAt: row.createdAt, updatedAt: row.updatedAt, lastAccessedAt:row.lastAccessedAt,
      keepEmpty:!!row.keepEmpty, maxMembers:row.maxMembers, liveState:row.liveState ? JSON.parse(row.liveState) : null,
      permissions: Policy.policy(JSON.parse(row.permissions)), bookmark: row.bookmark === null ? null : bookmark(JSON.parse(row.bookmark)),
      autoQueue: row.autoQueue === null ? { mode: 'off', scope: null, includeSpecials: false, cycle: 0, used: [], next: null } : { next: null, ...JSON.parse(row.autoQueue) },
      autoplay: row.autoplay === 1
    };
  }
  async commit(result) {
    try { await this.registry.flush(); }
    catch (failure) { this.failure = failure; this.healthy(); }
    return result;
  }
  async create(userId, { name = 'Room', visibility: selectedVisibility = 'public', fullPermissions = false, permissionPreset, permissions:customPermissions, autoplay = true, autoQueue = {mode:'off'}, keepEmpty = false, maxMembers = null } = {}) {
    this.healthy();
    if (this.db.prepare('SELECT COUNT(*) AS n FROM watch_rooms').get().n >= this.limits.maxSaved) throw error('Saved room limit reached', 429);
    if (typeof keepEmpty !== 'boolean') throw error('Choose whether to keep the room when empty');
    this.validateMembers(maxMembers);
    const creatorId = this.account(userId), id = randomUUID(), at = this.now();
    name = text(name, 100, 'room name');
    selectedVisibility = visibility(selectedVisibility);
    if (typeof fullPermissions !== 'boolean') throw error('Choose full participant permissions on or off');
    let permissions = permissionPreset === undefined || permissionPreset === 'server-defaults' ? Policy.policy(this.defaults) : Policy.preset(permissionPreset);
    if (fullPermissions) permissions.viewer = Policy.preset('queue').viewer;
    if (customPermissions !== undefined) {
      Policy.policy(customPermissions);
      permissions = {host:Policy.permissions(customPermissions.host ?? {},permissions.host),viewer:Policy.permissions(customPermissions.viewer ?? {},permissions.viewer,{role:'viewer'}),allHosts:customPermissions.allHosts ?? false};
    }
    if (typeof autoplay !== 'boolean') throw error('Choose auto-play on or off');
    const automatic = validateAuto(autoQueue);
    this.db.prepare('INSERT INTO watch_rooms(id,creatorId,name,visibility,revision,checkpointRevision,queueRevision,createdAt,updatedAt,permissions,bookmark,autoplay,autoQueue,lastAccessedAt,keepEmpty,maxMembers) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, creatorId, name, selectedVisibility, 0, 0, 0, at, at, JSON.stringify(permissions), null, autoplay ? 1 : 0, JSON.stringify(automatic), at, keepEmpty ? 1 : 0, maxMembers);
    return this.commit(this.get(id));
  }
  list(userId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    userId = this.account(userId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw error('Invalid room page');
    const rooms = [];
    // ken: scan saved memberships; use an indexed canonical-account lookup if
    // measured room listing exceeds 50 ms. Closed rooms consume no player slots.
    for (const row of this.db.prepare('SELECT id FROM watch_rooms ORDER BY lastAccessedAt DESC,id').all()) {
      const room = this.get(row.id);
      if (this.isAdmin(userId) === true || Policy.assigned(room, userId)) rooms.push(room);
    }
    return { rooms: rooms.slice(offset, offset + limit), total: rooms.length };
  }
  restore(id, userId) {
    const room = this.get(id);
    userId = this.account(userId);
    if (this.isAdmin(userId) !== true && !Policy.assigned(room, userId)) throw error('Only a room creator, assigned host or active administrator can reopen it', 403);
    // The caller must obtain fresh media/command authority. A stored position
    // never includes elapsed downtime or an autoplay intent.
    return { ...room, paused: true };
  }
  async edit(id, userId, revision, change) {
    const room = this.get(id);
    userId = this.account(userId);
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw error('Invalid room change');
    const capabilities = {
      'keepEmpty':'roomSettings', 'maxMembers':'roomSettings', 'auto.reset':'editQueue', rename: 'roomSettings', visibility: 'roomSettings', 'host.add': 'addHosts',
      'host.remove': 'manageHosts', 'host.leave':'self', 'host.pending.add':'addHosts', 'host.pending.remove':'manageHosts', 'allHosts':'leader', 'creator.transfer': 'transferCreator', permissions: 'managePermissions', 'permissions.preset': 'managePermissions', autoplay:'autoplay', delete: 'deleteRoom', 'bookmark.clear':'chooseMedia'
    };
    const capability = Object.hasOwn(capabilities, change.action) && capabilities[change.action];
    if (!capability) throw error('Unsupported room change');
    if (capability === 'leader' ? userId !== room.creatorId : capability === 'self' ? !room.hosts.includes(userId) : this.isAdmin(userId) !== true && !Policy.allowed(room, userId, capability)) throw error('Room permission required', 403);
    if (!Number.isSafeInteger(revision) || revision !== room.revision) throw error('Room changed; refresh before editing', 409);
    const at = this.now();
    const clearPendingForUser = targetId => {
      for (const ident of this.registry.identities(targetId)) {
        this.db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=? AND provider=? AND subject=?').run(id, ident.provider, ident.subject);
      }
    };
    this.registry.transaction(() => {
      switch (change.action) {
        case 'allHosts':
          if (typeof change.enabled !== 'boolean') throw error('Choose All hosts on or off');
          room.permissions.allHosts = change.enabled; break;
        case 'host.pending.add': {
          if (!['discord','plex'].includes(change.provider) || typeof change.subject !== 'string' || !(change.provider === 'discord' ? /^\d{17,20}$/ : /^\d{1,20}$/).test(change.subject)) throw error('Invalid provider account');
          const identity = this.registry.identity(change.provider,change.subject);
          if (identity?.verified) {
            const target = this.account(identity.userId);
            if (target !== room.creatorId) this.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id,target);
          } else this.db.prepare('INSERT OR IGNORE INTO watch_room_host_grants VALUES(?,?,?,?,?,?)').run(id,change.provider,change.subject,text(change.name,100,'host name'),userId,at);
          break;
        }
        case 'host.pending.remove':
          this.db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=? AND provider=? AND subject=?').run(id,String(change.provider),String(change.subject)); break;
        case 'keepEmpty':
          if (typeof change.enabled !== 'boolean') throw error('Choose whether to keep the room when empty');
          this.db.prepare('UPDATE watch_rooms SET keepEmpty=? WHERE id=?').run(change.enabled ? 1 : 0,id); break;
        case 'maxMembers':
          this.validateMembers(change.value);
          this.db.prepare('UPDATE watch_rooms SET maxMembers=? WHERE id=?').run(change.value,id); break;
        case 'auto.reset': {
          const auto = { ...room.autoQueue, used:[], cycle:0, cursor:null, next:null };
          this.db.prepare('UPDATE watch_rooms SET autoQueue=?,queueRevision=queueRevision+1 WHERE id=?').run(JSON.stringify(auto),id);
          this.db.prepare('DELETE FROM watch_room_progress WHERE roomId=?').run(id); break;
        }
        case 'rename': room.name = text(change.name, 100, 'room name'); break;
        case 'visibility': room.visibility = visibility(change.visibility); break;
        case 'autoplay':
          if (typeof change.enabled !== 'boolean') throw error('Choose auto-play on or off');
          this.db.prepare('UPDATE watch_rooms SET autoplay=? WHERE id=?').run(change.enabled ? 1 : 0,id);
          break;
        case 'permissions.preset': {
          room.permissions = {...Policy.preset(change.preset),allHosts:room.permissions.allHosts};
          break;
        }
        case 'permissions': {
          if (!['host', 'viewer'].includes(change.role)) throw error('Choose host or viewer permissions');
          room.permissions[change.role] = Policy.permissions(change.permissions, room.permissions[change.role], { role:change.role });
          for (const key of Policy.CAPABILITIES) {
            if (change.role === 'host' && room.permissions.host[key] === false) {
              room.permissions.viewer[key] = false;
            } else if (change.role === 'viewer' && room.permissions.viewer[key] === true) {
              room.permissions.host[key] = true;
            }
          }
          break;
        }
        case 'host.add': {
          const target = this.account(change.userId);
          if (target === room.creatorId) throw error('The room leader is already a host');
          clearPendingForUser(target);
          this.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id, target);
          break;
        }
        case 'host.leave':
        case 'host.remove': {
          const target = change.action === 'host.leave' ? userId : this.account(change.userId);
          if (target === room.creatorId) throw error('Transfer room leadership before removing the room leader');
          clearPendingForUser(target);
          for (const entry of this.db.prepare('SELECT userId FROM watch_room_hosts WHERE roomId=?').all(id)) {
            if (this.account(entry.userId) === target) this.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=? AND userId=?').run(id, entry.userId);
          }
          break;
        }
        case 'creator.transfer': {
          const target = this.account(change.userId);
          if (target === room.creatorId || !room.hosts.includes(target)) throw error('Transfer room leadership to another assigned host');
          clearPendingForUser(target);
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
          this.db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_room_progress WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_queue_entries WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=?').run(id);
          this.db.prepare('DELETE FROM watch_rooms WHERE id=?').run(id);
          return;
      }
      this.db.prepare('UPDATE watch_rooms SET creatorId=?,name=?,visibility=?,permissions=?,revision=revision+1,updatedAt=?,lastAccessedAt=? WHERE id=?')
        .run(room.creatorId, room.name, room.visibility, JSON.stringify(room.permissions), at, at, id);
    });
    return this.commit(change.action === 'delete' ? { deleted: true } : this.get(id));
  }
  validateMembers(value) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > this.limits.maxMembers)) throw error('Room capacity must be from 1 to ' + this.limits.maxMembers);
  }
  pendingHosts(id) { return this.db.prepare('SELECT provider,subject,name FROM watch_room_host_grants WHERE roomId=? ORDER BY name,provider,subject').all(id); }
  async claimHosts(userId) {
    userId = this.account(userId);
    const grants = this.db.prepare('SELECT g.* FROM watch_room_host_grants g JOIN identities i ON i.provider=g.provider AND i.subject=g.subject WHERE i.userId=? AND i.verified=1').all(userId);
    if (!grants.length) return [];
    this.healthy();
    this.registry.transaction(() => {
      for (const grant of grants) {
        const room = this.get(grant.roomId);
        if (userId !== room.creatorId) this.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(room.id,userId);
        this.db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=? AND provider=? AND subject=?').run(room.id,grant.provider,grant.subject);
        this.db.prepare('UPDATE watch_rooms SET revision=revision+1 WHERE id=?').run(room.id);
      }
    });
    await this.commit(); return [...new Set(grants.map(grant=>grant.roomId))];
  }
  touch(id, at = this.now()) {
    this.healthy();
    this.db.prepare('UPDATE watch_rooms SET lastAccessedAt=MAX(lastAccessedAt,?) WHERE id=?').run(at,id);
  }
  async destroy(id) {
    this.healthy();
    this.registry.transaction(() => {
      for (const table of ['watch_room_progress','watch_queue_entries','watch_room_host_grants','watch_room_hosts','watch_rooms']) {
        this.db.prepare('DELETE FROM ' + table + ' WHERE ' + (table === 'watch_rooms' ? 'id' : 'roomId') + '=?').run(id);
      }
    });
    return this.commit({deleted:true});
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
