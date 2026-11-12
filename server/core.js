// @ts-check
'use strict';
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').EngineCommand} EngineCommand */

const { createHash } = require('node:crypto');
const Engine = require('../shared/engine');
const RoomPolicy = require('./room-policy');
const { COMMAND_TTL_MS, PRESENCE_TIMEOUT_MS, resolveCommandDeadlines } = require('../shared/sync/envelope.mjs');
const hash = text => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PRESENCE_MS = PRESENCE_TIMEOUT_MS;
const COMMAND_MS = COMMAND_TTL_MS;
const isOwner = (actor, config) => (actor?.discordId || actor?.userId) === config.ownerId;
// A guest session is never a host, whatever the room's roles say.
const isHost = (room, actor) => !actor.guestRoomId && RoomPolicy.role(room, actor.userId) !== 'viewer';
const ALLOW = Object.freeze({ ok: true });
const NO_ROOM = Object.freeze({ ok: false, reason: 'room' });
const NO_PERMISSION = Object.freeze({ ok: false, reason: 'permission' });
const canWatch = (access, id, actor) => (access?.canWatch ? access.canWatch(id, actor) : !!access?.isMember(id));
function sameVoice(room, actor, access) {
  const channel = access?.voiceChannel?.(room.hostId || room.ownerId);
  return !!channel && !!access?.validVoiceChannel?.(channel) && access.voiceChannel(actor.userId) === channel;
}
function watching(room, actor, now = Date.now()) {
  return [...(room.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

class Hub {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
    this.adminMode = false;
    this.adminEpoch = 0;
    this.adminUsers = new Set();
    // Integration hooks that server/app.js, server/watch.js and server/discord.js attach after construction.
    /** @type {any} Discord or test membership policy (isMember, canWatch, refresh, refreshWatch, voiceChannel, ...). */
    this.access = undefined;
    /** @type {((actor: Actor) => boolean) | undefined} */
    this.adminEligible = undefined;
    /** @type {((actor: Actor) => Promise<void>) | undefined} */
    this.refreshAdmin = undefined;
    /** @type {((actor: Actor) => Actor | undefined) | undefined} */
    this.accountActor = undefined;
    /** @type {((room: RoomDescriptor, actor: Actor) => boolean | Promise<boolean>) | undefined} */
    this.watchCanView = undefined;
    /** @type {((roomId: string) => boolean) | undefined} */
    this.watchIdle = undefined;
    /** @type {((roomId: string) => Set<string>) | undefined} Accounts holding the room's current guest passes. */
    this.guestMembers = undefined;
    /** @type {((roomId: string, actor: Actor, permitted: () => boolean) => Promise<any>) | undefined} */
    this.publicationExecute = undefined;
    /** @type {((roomId: string, actor: Actor, permitted: () => boolean) => Promise<any>) | undefined} */
    this.savedPublicationExecute = undefined;
    /** @type {((roomId: string, command: EngineCommand, actor: Actor, permitted: () => boolean) => Promise<any>) | undefined} */
    this.scheduledEventExecute = undefined;
    /** @type {((roomId: string, command: EngineCommand, actor: Actor, permitted: () => boolean) => Promise<any>) | undefined} */
    this.savedQueueExecute = undefined;
  }
  isOwner(actor) {
    return isOwner(actor, this.config);
  }
  canAdmin(actor) {
    return !actor.guestRoomId && (this.isOwner(actor) || this.adminEligible?.(actor) === true);
  }
  isAdmin(actor) {
    if (!this.canAdmin(actor)) {
      this.adminUsers.delete(actor.userId);
      return false;
    }
    return this.isOwner(actor) ? this.adminMode : this.adminUsers.has(actor.userId);
  }
  /**
   * The one authorization decision for room work: may `actor` perform `action` in `room`?
   * `room` is an open room or a stored room record. `action` is one of:
   * - a command from the command table (shared/room-protocol.js): room access,
   *   presence for room-scoped commands, and the command's permission rule;
   * - a room capability (RoomPolicy.CAPABILITIES or CREATOR_ONLY);
   * - 'room.view': see and join the room (admission, visibility, guest scope);
   * - 'room.remain': stay in the room's private membership (members, guests, Admin mode);
   * - 'room.host': act as one of the room's hosts (hosts and Admin mode, never guests).
   * Returns `{ok: true}`, or `{ok: false, reason}` where reason 'room' means the
   * actor has no access to the room and 'permission' means the room's permissions
   * deny the action. Provider checks (membership refresh, Plex item access) are
   * asynchronous and stay with Watch.canView.
   * @param {Actor} actor
   * @param {any} room
   * @param {string} action
   * @returns {{ok: boolean, reason?: 'room'|'permission'}}
   */
  authorize(actor, room, action) {
    const admin = this.isAdmin(actor);
    const roomId = room.roomId ?? room.id;
    if (action === 'room.remain')
      return room.visibility !== 'private' ||
        RoomPolicy.admitted(room.saved, actor.userId) ||
        !!this.guestMembers?.(room.roomId).has(actor.userId) ||
        admin
        ? ALLOW
        : NO_ROOM;
    if (action === 'room.host') return !actor.guestRoomId && (isHost(room, actor) || admin) ? ALLOW : NO_PERMISSION;
    const command = Engine.command(action);
    // A guest session opens one room only.
    const view =
      (!actor.guestRoomId || roomId === actor.guestRoomId) &&
      canWatch(this.access, actor.userId, actor) &&
      (admin ||
        room.visibility === 'public' ||
        RoomPolicy.admitted(room, actor.userId) ||
        actor.guestRoomId === roomId);
    // A capability is only ever held inside a room the actor may open.
    if (!command && action !== 'room.view')
      return admin ||
        (view &&
          RoomPolicy.allowed(actor.guestRoomId ? { ...room, guests: [actor.userId] } : room, actor.userId, action))
        ? ALLOW
        : view
          ? NO_PERMISSION
          : NO_ROOM;
    if (!view) return NO_ROOM;
    // Only the authenticated watch endpoint attaches a viewer identity; personal
    // commands change only that viewer's player.
    if (!command || (command.scope === 'personal' && actor.watchViewerId)) return ALLOW;
    if (!isHost(room, actor) && !admin && !watching(room, actor)) return NO_ROOM;
    if (command.host) return this.authorize(actor, room, 'room.host').ok ? ALLOW : NO_PERMISSION;
    const can = capability => this.authorize(actor, room, capability).ok;
    if (
      !command.capability ||
      !(can(command.capability) || (command.idle && this.watchIdle?.(room.roomId) && can(command.idle))) ||
      (command.also && !can(command.also))
    )
      return NO_PERMISSION;
    if (
      command.hostless &&
      !isHost(room, actor) &&
      !admin &&
      ![...(room.viewers?.values() || [])].some(viewer => isHost(room, viewer.actor) || this.isAdmin(viewer.actor))
    )
      return can('continueWithoutHost') ? ALLOW : NO_PERMISSION;
    return ALLOW;
  }
  clearAdmin(actor) {
    const changed = this.adminUsers.delete(actor.userId) || (this.isOwner(actor) && this.adminMode);
    if (this.isOwner(actor)) this.adminMode = false;
    if (changed) {
      this.adminEpoch++;
    }
  }
  setAdminMode(actor, enabled) {
    if (!this.canAdmin(actor) || !canWatch(this.access, actor.userId, actor) || typeof enabled !== 'boolean')
      throw new Error('Only an authorized administrator can change Admin mode');
    if (!enabled) {
      this.clearAdmin(actor);
      return;
    }
    if (this.isAdmin(actor)) return;
    if (this.isOwner(actor)) this.adminMode = true;
    else this.adminUsers.add(actor.userId);
    this.adminEpoch++;
  }
  async dispatch(actor, input) {
    if (Object.hasOwn(input, 'sessionId')) return { status: 'unsupported', message: 'Use the current room protocol.' };
    actor = this.accountActor?.(actor) || actor;
    if (this.refreshAdmin) await this.refreshAdmin(actor);
    if (!this.isOwner(actor) || this.rooms.size) {
      try {
        if (!(await (this.access?.refreshWatch || this.access?.refresh)?.(actor.userId, actor)))
          return { status: 'forbidden', message: 'No controllable room.' };
      } catch {
        return { status: 'forbidden', message: 'No controllable room.' };
      }
    }
    if (!UUID.test(input.roomId || '')) return { status: 'forbidden', message: 'No controllable room.' };
    if (this.config.singleRoom && !this.rooms.has(input.roomId))
      return { status: 'forbidden', message: 'Only the configured shared room is available.' };
    let command;
    try {
      command = Engine.validate(input);
    } catch {
      return { status: 'unsupported', message: 'Unsupported command or value.' };
    }
    const declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(command.action));
    const service =
      declared.service &&
      {
        publish: this.publicationExecute,
        unpublish: this.savedPublicationExecute,
        event: this.scheduledEventExecute,
      }[declared.service];
    if (service) {
      const deadlines = resolveCommandDeadlines({
        acceptedAt: Date.now(),
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: 12000,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Select a room and try again.' };
      const adminEpoch = this.adminEpoch;
      const permitted = () =>
        Date.now() < deadlines.executionDeadline &&
        this.adminEpoch === adminEpoch &&
        canWatch(this.access, actor.userId, actor);
      try {
        return declared.service === 'event'
          ? await this.scheduledEventExecute(input.roomId, command, actor, permitted)
          : await service(input.roomId, actor, permitted);
      } catch (error) {
        return {
          status: error.status === 403 ? 'forbidden' : 'failed',
          message: error.status ? error.message : 'Discord could not complete this action.',
          httpStatus: error.status || 503,
        };
      }
    }
    if (command.action.startsWith('queue.') && !this.rooms.has(input.roomId) && this.savedQueueExecute) {
      const acceptedAt = Date.now();
      const deadlines = resolveCommandDeadlines({
        acceptedAt,
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: declared.preparesSaved ? 30000 : undefined,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Room changed or command expired.' };
      const deadline = deadlines.executionDeadline,
        adminEpoch = this.adminEpoch;
      const permitted = () =>
        Date.now() < deadline &&
        this.adminEpoch === adminEpoch &&
        !this.rooms.has(input.roomId) &&
        canWatch(this.access, actor.userId, actor);
      try {
        return await this.savedQueueExecute(input.roomId, command, actor, permitted);
      } catch (error) {
        return {
          status: error.status === 403 ? 'forbidden' : 'failed',
          message: error.message,
          httpStatus: error.status || 400,
        };
      }
    }
    const s = this.rooms.get(input.roomId);
    if (!s || this.authorize(actor, s, command.action).reason === 'room')
      return { status: 'forbidden', message: 'No controllable room.' };
    if (this.watchCanView && !(await this.watchCanView(s, actor)))
      return { status: 'forbidden', message: 'No controllable room.' };
    if (!this.authorize(actor, s, command.action).ok)
      return { status: 'forbidden', message: 'Your room permissions do not allow this action.' };
    if (s.execute) {
      const acceptedAt = Date.now();
      // A fresh personal quality request starts immediately, but Plex room
      // preparation can take longer than the default command deadline.
      // Keep completion bounded and recheck the same live authorization below.
      const preparing =
        declared.prepares === true ||
        (declared.prepares === 'personal' && !!actor.watchViewerId) ||
        (declared.prepares === 'idle' && this.watchIdle?.(s.roomId));
      const deadlines = resolveCommandDeadlines({
        acceptedAt,
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: preparing ? 30000 : undefined,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Room changed or command expired.' };
      const deadline = deadlines.executionDeadline;
      const epoch = s.epoch,
        adminEpoch = this.adminEpoch;
      const permitted = () =>
        this.rooms.get(s.roomId) === s &&
        s.epoch === epoch &&
        Date.now() < deadline &&
        this.adminEpoch === adminEpoch &&
        this.authorize(actor, s, command.action).ok;
      try {
        return await s.execute(command, actor, permitted);
      } catch (error) {
        return command.action.startsWith('queue.')
          ? {
              status: error.status === 403 ? 'forbidden' : 'failed',
              message: error.message,
              httpStatus: error.status || 400,
            }
          : {
              status: 'failed',
              message:
                error instanceof Error && /** @type {Error & {status?: number}} */ (error).status
                  ? error.message
                  : 'Playback could not be updated.',
            };
      }
    }
    return { status: 'unavailable', message: 'Room is no longer active.' };
  }
  close() {
    this.rooms.clear();
  }
}
module.exports = {
  Hub,
  isHost,
  sameVoice,
  watching,
  hash,
  UUID,
  PRESENCE_MS,
  COMMAND_MS,
  canWatch,
};
