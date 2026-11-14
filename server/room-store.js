// @ts-check
'use strict';
const { repositories } = require('./repositories');

const { randomUUID } = require('node:crypto');
const Policy = require('./room-policy');
const { validateAuto } = require('./room-queue');
const { mediaIdentity } = require('../shared/room-protocol.mjs');
const ubumfa = require('../web/ubumfa');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

function deduplicateSlug(db, baseSlug, currentRoomId) {
  let candidate = baseSlug;
  let counter = 2;
  const query = repositories(db).rooms.slugStatement;
  while (true) {
    const existing = query.get(candidate);
    if (!existing || existing.id === currentRoomId) return candidate;
    candidate = `${baseSlug}-${counter++}`;
  }
}

/** @typedef {{serverId:string,mediaId:string,type:'movie'|'episode',title:string,duration:number,position:number}} RoomBookmark */
/**
 * A watch_rooms row as node:sqlite returns it.
 * @typedef {{id:string,creatorId:string,name:string,visibility:'public'|'private',revision:number,checkpointRevision:number,queueRevision:number,createdAt:number,updatedAt:number,permissions:string,bookmark:string|null,autoQueue:string|null,autoplay:number,lastAccessedAt:number,keepEmpty:number,maxMembers:number|null,liveState:string|null,slug:string|null,ubumfaWord:string|null,inviteCode:string|null,allowGuests:number}} RoomRow
 */
/** @typedef {{id:string,creatorId:string,hosts:string[],guests:string[],invited:string[],inviteCode:string,allowGuests:boolean,name:string,slug:string|null,ubumfaWord:string|null,visibility:'public'|'private',revision:number,checkpointRevision:number,queueRevision:number,createdAt:number,updatedAt:number,lastAccessedAt:number,keepEmpty:boolean,maxMembers:number|null,liveState:{viewers:string[],wasPlaying:boolean}|null,permissions:Object,bookmark:RoomBookmark|null,autoQueue:Object,autoplay:boolean}} SavedRoom */

// A room invite is two six-letter ubumfa words. People may type it in any case,
// with a hyphen, a space or nothing between the words.
function inviteCode(value) {
  if (typeof value !== 'string' || value.length > 40) return undefined;
  const letters = value.toLowerCase().replace(/[^a-z]/g, '');
  return letters.length === 12 ? letters.slice(0, 6) + '-' + letters.slice(6) : undefined;
}
function newInviteCode(db) {
  for (;;) {
    const code = ubumfa.generateWord(6).toLowerCase() + '-' + ubumfa.generateWord(6).toLowerCase();
    if (!repositories(db).rooms.inviteCodeExists(code)) return code;
  }
}

function error(message, status = 400) {
  return Object.assign(new Error(message), { status });
}
function text(value, limit, label) {
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
function visibility(value) {
  if (!['public', 'private'].includes(value)) throw error('Invalid room visibility');
  return value;
}
/** @returns {RoomBookmark|null} */
function bookmark(value) {
  if (value === null) return null;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !mediaIdentity(value.mediaId) ||
    (value.mediaId === 'demo' && value.serverId !== 'local-demo') ||
    !['movie', 'episode'].includes(value.type) ||
    !Number.isFinite(value.duration) ||
    value.duration <= 0 ||
    value.duration > 1e9 ||
    !Number.isFinite(value.position) ||
    value.position < 0
  ) {
    throw error('Invalid room bookmark');
  }
  // Allowlist source identity and progress. No token, URL, stream or viewer data.
  return {
    serverId: text(value.serverId, 200, 'Plex server identity'),
    mediaId: value.mediaId,
    type: value.type,
    title: text(value.title, 200, 'media title'),
    duration: value.duration,
    position: Math.min(value.position, value.duration),
  };
}

// This core owns durable records and role checks. Live eligibility, media access,
// command epochs and active-room allocation belong to the Watch integration.
class RoomStore {
  /**
   * @param {InstanceType<typeof import('./accounts').Accounts>} registry
   * @param {{defaults?:Object,now?:()=>number,isAdmin?:(userId:string)=>boolean,guests?:(roomId:string)=>Iterable<string>,
   *   limits?:typeof import('./room-limits').DEFAULTS,defaultAllowGuests?:boolean}} [options]
   */
  constructor(
    registry,
    {
      defaults,
      now = Date.now,
      isAdmin = () => false,
      guests = () => [],
      limits = require('./room-limits').DEFAULTS,
      defaultAllowGuests = false,
    } = {},
  ) {
    this.registry = registry;
    this.db = registry.db;
    this.defaults = Policy.policy(defaults);
    this.now = now;
    this.limits = limits;
    // Server-owned opt-in Admin mode, never a flag accepted from a room edit.
    this.isAdmin = isAdmin;
    // People currently in a room through a guest pass; they hold no room roles.
    this.guests = guests;
    this.defaultAllowGuests = !!defaultAllowGuests;
  }
  healthy() {
    const failure = this.failure;
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
    const row = /** @type {RoomRow|undefined} */ (repositories(this.db).rooms.findRoom(id));
    if (!row) throw error('Room unavailable', 404);
    const creatorId = this.account(row.creatorId);
    const hosts = [
      ...new Set(
        repositories(this.db)
          .rooms.listRoomHostsByRoomId(id)
          .map(entry => this.account(/** @type {string} */ (entry.userId))),
      ),
    ].filter(userId => userId !== creatorId);
    return {
      id: row.id,
      creatorId,
      hosts,
      guests: [...this.guests(row.id)],
      name: row.name,
      inviteCode: row.inviteCode,
      allowGuests: row.allowGuests === 1,
      invited: [
        ...new Set(
          repositories(this.db)
            .rooms.listRoomInvitesByRoomId(id)
            .map(entry => this.account(/** @type {string} */ (entry.userId))),
        ),
      ],
      slug: row.slug,
      ubumfaWord: row.ubumfaWord,
      visibility: row.visibility,
      revision: row.revision,
      checkpointRevision: row.checkpointRevision,
      queueRevision: row.queueRevision ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      lastAccessedAt: row.lastAccessedAt,
      keepEmpty: !!row.keepEmpty,
      maxMembers: row.maxMembers,
      liveState: row.liveState ? JSON.parse(row.liveState) : null,
      permissions: Policy.policy(JSON.parse(row.permissions)),
      bookmark: row.bookmark === null ? null : bookmark(JSON.parse(row.bookmark)),
      autoQueue:
        row.autoQueue === null
          ? { mode: 'off', scope: null, includeSpecials: false, cycle: 0, used: [], next: null }
          : { next: null, ...JSON.parse(row.autoQueue) },
      autoplay: row.autoplay === 1,
    };
  }
  getBySlug(slug) {
    this.healthy();
    if (typeof slug !== 'string' || !slug.trim()) throw error('Room unavailable', 404);
    const normalized = slug.trim().toLowerCase();
    const row = repositories(this.db).rooms.findRoomsBySlugId(normalized, normalized);
    if (!row) throw error('Room unavailable', 404);
    return this.get(row.id);
  }
  async commit(result) {
    try {
      await this.registry.flush();
    } catch (failure) {
      this.failure = failure;
      this.healthy();
    }
    return result;
  }
  /**
   * @param {string} userId
   * @param {{name?:string,isCustom?:boolean,visibility?:string,fullPermissions?:boolean,permissionPreset?:string,
   *   permissions?:{host?:Record<string,boolean>,viewer?:Record<string,boolean>,allHosts?:boolean},autoplay?:boolean,
   *   autoQueue?:Object,keepEmpty?:boolean,maxMembers?:number|null,allowGuests?:boolean}} [options]
   */
  async create(
    userId,
    {
      name,
      isCustom,
      visibility: selectedVisibility = 'public',
      fullPermissions = false,
      permissionPreset,
      permissions: customPermissions,
      autoplay = true,
      autoQueue = { mode: 'off' },
      keepEmpty = false,
      maxMembers = null,
      allowGuests,
    } = {},
  ) {
    this.healthy();
    if (/** @type {{n:number}} */ (repositories(this.db).rooms.count()).n >= this.limits.maxSaved)
      throw error('Saved room limit reached', 429);
    if (typeof keepEmpty !== 'boolean') throw error('Choose whether to keep the room when empty');
    this.validateMembers(maxMembers);
    const creatorId = this.account(userId),
      id = randomUUID(),
      at = this.now();
    selectedVisibility = visibility(selectedVisibility);
    if (typeof fullPermissions !== 'boolean') throw error('Choose full participant permissions on or off');
    let permissions =
      permissionPreset === undefined || permissionPreset === 'server-defaults'
        ? Policy.policy(this.defaults)
        : Policy.preset(permissionPreset);
    if (fullPermissions) permissions.viewer = Policy.preset('queue').viewer;
    if (customPermissions !== undefined) {
      Policy.policy(customPermissions);
      permissions = {
        host: Policy.permissions(customPermissions.host ?? {}, permissions.host),
        viewer: Policy.permissions(customPermissions.viewer ?? {}, permissions.viewer, { role: 'viewer' }),
        allHosts: customPermissions.allHosts ?? false,
      };
    }
    if (typeof autoplay !== 'boolean') throw error('Choose auto-play on or off');
    const automatic = validateAuto(autoQueue);
    if (name !== undefined) {
      name = text(name, 100, 'room name');
    }
    const custom = isCustom === true || (isCustom === undefined && name !== undefined && name !== 'Room');
    const ubumfaWord = ubumfa.generateWord(6).toLowerCase();
    let finalName, finalSlug;
    if (!custom) {
      if (name && /^Room\s+[A-Za-z]+$/i.test(name)) {
        const wordMatch = /^Room\s+([A-Za-z]+)$/i.exec(name);
        const w = wordMatch[1].toLowerCase();
        finalName = 'Room ' + w[0].toUpperCase() + w.slice(1);
        finalSlug = deduplicateSlug(this.db, w, id);
      } else {
        finalName = 'Room ' + ubumfaWord[0].toUpperCase() + ubumfaWord.slice(1);
        finalSlug = deduplicateSlug(this.db, ubumfaWord, id);
      }
    } else {
      finalName = name;
      const baseSlug = ubumfa.slugify(finalName);
      finalSlug = deduplicateSlug(this.db, baseSlug, id);
    }
    const allowGuestsValue = typeof allowGuests === 'boolean' ? (allowGuests ? 1 : 0) : this.defaultAllowGuests ? 1 : 0;
    repositories(this.db).rooms.insertRooms(
      id,
      creatorId,
      finalName,
      finalSlug,
      ubumfaWord,
      selectedVisibility,
      0,
      0,
      0,
      at,
      at,
      JSON.stringify(permissions),
      null,
      autoplay ? 1 : 0,
      JSON.stringify(automatic),
      at,
      keepEmpty ? 1 : 0,
      maxMembers,
      newInviteCode(this.db),
      allowGuestsValue,
    );
    return this.commit(this.get(id));
  }
  list(userId, { offset = 0, limit = 50 } = {}) {
    this.healthy();
    userId = this.account(userId);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw error('Invalid room page');
    const rooms = [];
    // ken: scan saved memberships; use an indexed canonical-account lookup if
    // measured room listing exceeds 50 ms. Closed rooms consume no player slots.
    for (const row of repositories(this.db).rooms.listRooms()) {
      const room = this.get(row.id);
      if (this.isAdmin(userId) === true || Policy.assigned(room, userId)) rooms.push(room);
    }
    return { rooms: rooms.slice(offset, offset + limit), total: rooms.length };
  }
  /** The room a typed or linked invite code belongs to, if any. */
  byInvite(value) {
    const code = inviteCode(value);
    const row = code && repositories(this.db).rooms.findByInviteCode(code);
    return row ? this.get(row.id) : undefined;
  }
  // Signed-in people who joined a private room by invite stay invited until revoked.
  invite(id, userId) {
    repositories(this.db).rooms.insertRoomInvites(id, this.account(userId), this.now());
    return this.commit(this.get(id));
  }
  // Subjects are 'user:<uuid>' or 'device:<hash>'. Blocks end when the code is rerolled.
  blocked(id, subjects) {
    return subjects.some(subject => repositories(this.db).rooms.findRoomInviteBlocksByRoomIdSubject(id, subject));
  }
  block(id, subjects) {
    this.registry.transaction(() => {
      for (const subject of subjects) repositories(this.db).rooms.insertRoomInviteBlocks(id, subject, this.now());
    });
    return this.commit(this.get(id));
  }
  // Removes someone's invite to a private room and keeps them from using it again.
  revokeInvite(id, userId) {
    const target = this.account(userId);
    this.registry.transaction(() => {
      repositories(this.db).rooms.deleteRoomInvitesByRoomIdUserId(id, target);
      repositories(this.db).rooms.insertRoomInviteBlocks(id, 'user:' + target, this.now());
    });
    return this.commit(this.get(id));
  }
  restore(id, userId) {
    const room = this.get(id);
    userId = this.account(userId);
    if (this.isAdmin(userId) !== true && !Policy.assigned(room, userId))
      throw error('Only a room creator, assigned host or active administrator can reopen it', 403);
    // The caller must obtain fresh media/command authority. A stored position
    // never includes elapsed downtime or an autoplay intent.
    return { ...room, paused: true };
  }
  async edit(id, userId, revision, change) {
    const room = this.get(id);
    userId = this.account(userId);
    if (!change || typeof change !== 'object' || Array.isArray(change)) throw error('Invalid room change');
    const capabilities = {
      keepEmpty: 'roomSettings',
      maxMembers: 'roomSettings',
      'auto.reset': 'editQueue',
      rename: 'roomSettings',
      visibility: 'roomSettings',
      'host.add': 'addHosts',
      'host.remove': 'manageHosts',
      'host.leave': 'self',
      'host.pending.add': 'addHosts',
      'host.pending.remove': 'manageHosts',
      allHosts: 'leader',
      'creator.transfer': 'transferCreator',
      permissions: 'managePermissions',
      'permissions.preset': 'managePermissions',
      autoplay: 'autoplay',
      delete: 'deleteRoom',
      'bookmark.clear': 'chooseMedia',
      'invite.reroll': 'host',
      'guests.allow': 'host',
      'guests.removeAll': 'host',
      'invite.revoke': 'kickParticipants',
    };
    const capability = Object.hasOwn(capabilities, change.action) && capabilities[change.action];
    if (!capability) throw error('Unsupported room change');
    const host = this.isAdmin(userId) === true || Policy.role(room, userId) !== 'viewer';
    if (
      capability === 'leader'
        ? userId !== room.creatorId
        : capability === 'self'
          ? !room.hosts.includes(userId)
          : capability === 'host'
            ? !host
            : this.isAdmin(userId) !== true && !Policy.allowed(room, userId, capability)
    )
      throw error('Room permission required', 403);
    if (!Number.isSafeInteger(revision) || revision !== room.revision)
      throw error('Room changed; refresh before editing', 409);
    const at = this.now();
    const clearPendingForUser = targetId => {
      for (const ident of this.registry.identities(targetId)) {
        repositories(this.db).rooms.deleteRoomHostGrantsByRoomIdProviderSubject(id, ident.provider, ident.subject);
      }
    };
    this.registry.transaction(() => {
      switch (change.action) {
        case 'allHosts':
          if (typeof change.enabled !== 'boolean') throw error('Choose All hosts on or off');
          room.permissions.allHosts = change.enabled;
          break;
        case 'host.pending.add': {
          if (
            !['discord', 'plex'].includes(change.provider) ||
            typeof change.subject !== 'string' ||
            !(change.provider === 'discord' ? /^\d{17,20}$/ : /^\d{1,20}$/).test(change.subject)
          )
            throw error('Invalid provider account');
          const identity = this.registry.identity(change.provider, change.subject);
          if (identity?.verified) {
            const target = this.account(identity.userId);
            if (target !== room.creatorId) repositories(this.db).rooms.insertRoomHosts(id, target);
          } else
            repositories(this.db).rooms.insertRoomHostGrants(
              id,
              change.provider,
              change.subject,
              text(change.name, 100, 'host name'),
              userId,
              at,
            );
          break;
        }
        case 'host.pending.remove':
          repositories(this.db).rooms.deleteRoomHostGrantsByRoomIdProviderSubject(
            id,
            String(change.provider),
            String(change.subject),
          );
          break;
        case 'keepEmpty':
          if (typeof change.enabled !== 'boolean') throw error('Choose whether to keep the room when empty');
          repositories(this.db).rooms.updateRoomsSetKeepEmptyById(change.enabled ? 1 : 0, id);
          break;
        case 'maxMembers':
          this.validateMembers(change.value);
          repositories(this.db).rooms.updateRoomsSetMaxMembersById(change.value, id);
          break;
        case 'auto.reset': {
          const auto = { ...room.autoQueue, used: [], cycle: 0, cursor: null, next: null };
          repositories(this.db).rooms.updateRoomsSetAutoQueueQueueRevisionById(JSON.stringify(auto), id);
          repositories(this.db).queue.deleteRoomProgressByRoomId(id);
          break;
        }
        case 'rename': {
          const trimmed = typeof change.name === 'string' ? change.name.trim() : '';
          const word = room.ubumfaWord || ubumfa.generateWord(6).toLowerCase();
          const defaultDisplayName = 'Room ' + word[0].toUpperCase() + word.slice(1);
          if (!trimmed || trimmed === defaultDisplayName || trimmed === 'Room') {
            room.name = defaultDisplayName;
            room.slug = deduplicateSlug(this.db, word, id);
          } else {
            room.name = text(trimmed, 100, 'room name');
            const baseSlug = ubumfa.slugify(room.name);
            room.slug = deduplicateSlug(this.db, baseSlug, id);
          }
          break;
        }
        case 'visibility':
          room.visibility = visibility(change.visibility);
          break;
        case 'autoplay':
          if (typeof change.enabled !== 'boolean') throw error('Choose auto-play on or off');
          repositories(this.db).rooms.updateRoomsSetAutoplayById(change.enabled ? 1 : 0, id);
          break;
        case 'permissions.preset': {
          room.permissions = { ...Policy.preset(change.preset), allHosts: room.permissions.allHosts };
          break;
        }
        case 'permissions': {
          if (!['host', 'viewer'].includes(change.role)) throw error('Choose host or viewer permissions');
          room.permissions[change.role] = Policy.permissions(change.permissions, room.permissions[change.role], {
            role: change.role,
          });
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
          if (room.guests.includes(target)) throw error('Guests cannot be hosts', 403);
          clearPendingForUser(target);
          repositories(this.db).rooms.insertRoomHosts(id, target);
          break;
        }
        case 'host.leave':
        case 'host.remove': {
          const target = change.action === 'host.leave' ? userId : this.account(change.userId);
          if (target === room.creatorId) throw error('Transfer room leadership before removing the room leader');
          clearPendingForUser(target);
          for (const entry of repositories(this.db).rooms.listHosts(id)) {
            if (this.account(entry.userId) === target)
              repositories(this.db).rooms.deleteRoomHostsByRoomIdUserId(id, entry.userId);
          }
          break;
        }
        case 'creator.transfer': {
          const target = this.account(change.userId);
          if (target === room.creatorId || !room.hosts.includes(target))
            throw error('Transfer room leadership to another assigned host');
          clearPendingForUser(target);
          repositories(this.db).rooms.insertRoomHosts(id, room.creatorId);
          for (const entry of repositories(this.db).rooms.listHosts(id)) {
            if (this.account(entry.userId) === target)
              repositories(this.db).rooms.deleteRoomHostsByRoomIdUserId(id, entry.userId);
          }
          room.creatorId = target;
          break;
        }
        case 'invite.reroll':
        case 'guests.removeAll':
          // A new code; blocks tied to the old one end with it. Sessions are ended by the caller.
          repositories(this.db).rooms.updateRoomsSetInviteCodeById(newInviteCode(this.db), id);
          repositories(this.db).rooms.deleteRoomInviteBlocksByRoomId(id);
          break;
        case 'guests.allow':
          if (typeof change.enabled !== 'boolean') throw error('Choose whether to allow guests');
          repositories(this.db).rooms.updateRoomsSetAllowGuestsById(change.enabled ? 1 : 0, id);
          break;
        case 'invite.revoke': {
          const target = this.account(change.userId);
          repositories(this.db).rooms.deleteRoomInvitesByRoomIdUserId(id, target);
          repositories(this.db).rooms.insertRoomInviteBlocks(id, 'user:' + target, at);
          break;
        }
        case 'bookmark.clear':
          repositories(this.db).rooms.updateRoomsSetBookmarkCheckpointRevisionById(id);
          break;
        case 'delete':
          repositories(this.db).rooms.deleteRoomHostGrantsByRoomId(id);
          repositories(this.db).rooms.deleteRoomInvitesByRoomId(id);
          repositories(this.db).rooms.deleteRoomInviteBlocksByRoomId(id);
          repositories(this.db).queue.deleteRoomProgressByRoomId(id);
          repositories(this.db).queue.deleteQueueEntriesByRoomId(id);
          repositories(this.db).rooms.deleteRoomHostsByRoomId(id);
          repositories(this.db).rooms.deleteRoomsById(id);
          return;
      }
      repositories(
        this.db,
      ).rooms.updateRoomsSetCreatorIdNameSlugVisibilityPermissionsRevisionUpdatedAtLastAccessedAtById(
        room.creatorId,
        room.name,
        room.slug,
        room.visibility,
        JSON.stringify(room.permissions),
        at,
        at,
        id,
      );
    });
    return this.commit(change.action === 'delete' ? { deleted: true } : this.get(id));
  }
  validateMembers(value) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 1 || value > this.limits.maxMembers))
      throw error('Room capacity must be from 1 to ' + this.limits.maxMembers);
  }
  pendingHosts(id) {
    return repositories(this.db).rooms.listRoomHostGrantsByRoomId(id);
  }
  async claimHosts(userId) {
    userId = this.account(userId);
    const grants = repositories(this.db).rooms.listRoomHostGrantsByUserIdVerified(userId);
    if (!grants.length) return [];
    this.healthy();
    this.registry.transaction(() => {
      for (const grant of grants) {
        const room = this.get(grant.roomId);
        if (userId !== room.creatorId) repositories(this.db).rooms.insertRoomHosts(room.id, userId);
        repositories(this.db).rooms.deleteRoomHostGrantsByRoomIdProviderSubject(room.id, grant.provider, grant.subject);
        repositories(this.db).rooms.updateRoomsSetRevisionById(room.id);
      }
    });
    await this.commit();
    return [...new Set(grants.map(grant => grant.roomId))];
  }
  touch(id, at = this.now()) {
    this.healthy();
    repositories(this.db).rooms.updateRoomsSetLastAccessedAtById(at, id);
  }
  async destroy(id) {
    this.healthy();
    this.registry.transaction(() => {
      repositories(this.db).rooms.deleteRoomEventsByRoomId(id);
      repositories(this.db).queue.deleteRoomProgressByRoomId(id);
      repositories(this.db).queue.deleteQueueEntriesByRoomId(id);
      repositories(this.db).rooms.deleteRoomHostGrantsByRoomId(id);
      repositories(this.db).rooms.deleteRoomHostsByRoomId(id);
      repositories(this.db).rooms.deleteRoomsById(id);
    });
    return this.commit({ deleted: true });
  }
  // Server-owned checkpoint API: transport bodies must never be forwarded here.
  // Its own revision avoids invalidating a settings form every five seconds.
  async checkpoint(id, expectedRevision, value) {
    return this.commit(this.writeCheckpoint(id, expectedRevision, value));
  }
  // Synchronous half for an atomic room/live-state/queue snapshot.
  writeCheckpoint(id, expectedRevision, value) {
    const room = this.get(id);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== room.checkpointRevision)
      throw error('Room bookmark changed', 409);
    const saved = bookmark(value);
    repositories(this.db).rooms.updateRoomsSetBookmarkCheckpointRevisionUpdatedAtById(
      saved === null ? null : JSON.stringify(saved),
      this.now(),
      id,
    );
    return this.get(id);
  }
}

module.exports = { inviteCode, RoomStore };
