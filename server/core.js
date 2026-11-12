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
const privileged = (room, actor, config, admin = false) => isHost(room, actor) || admin;
const canWatch = (access, id, actor) => (access?.canWatch ? access.canWatch(id, actor) : !!access?.isMember(id));
function sameVoice(room, actor, access) {
  const channel = access?.voiceChannel?.(room.hostId || room.ownerId);
  return !!channel && !!access?.validVoiceChannel?.(channel) && access.voiceChannel(actor.userId) === channel;
}
function watching(room, actor, now = Date.now()) {
  return [...(room.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

function viewEligible(room, actor, config, now = Date.now(), access, admin = false) {
  // A guest session opens one room only.
  if (actor.guestRoomId && (room.roomId ?? room.id) !== actor.guestRoomId) return false;
  return (
    canWatch(access, actor.userId, actor) &&
    (admin ||
      room.visibility === 'public' ||
      RoomPolicy.admitted(room, actor.userId) ||
      actor.guestRoomId === (room.roomId ?? room.id))
  );
}
function eligible(room, actor, config, now = Date.now(), access, manage = false, admin = false) {
  if (!viewEligible(room, actor, config, now, access, admin)) return false;
  if (privileged(room, actor, config, admin)) return true;
  return watching(room, actor, now);
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
  canRoom(room, actor, capability) {
    return (
      this.isAdmin(actor) ||
      RoomPolicy.allowed(actor.guestRoomId ? { ...room, guests: [actor.userId] } : room, actor.userId, capability)
    );
  }
  canManage(room, actor) {
    return this.canRoom(room, actor, 'roomSettings');
  }
  roomCommandAllowed(room, actor, command, personal = false) {
    if (personal) return true;
    if (['room.publish', 'room.unpublish'].includes(command.action))
      return !actor.guestRoomId && (isHost(room, actor) || this.isAdmin(actor));
    const capability = RoomPolicy.commandCapability(command.action);
    if (['queue.auto.playNow', 'media.next', 'queue.history.replay'].includes(command.action)) {
      if (
        !this.canRoom(room, actor, 'chooseMedia') &&
        !(this.watchIdle?.(room.roomId) && this.canRoom(room, actor, 'playPause'))
      )
        return false;
    } else if (!capability || !this.canRoom(room, actor, capability)) return false;
    if (command.action === 'queue.offer.start' && !this.canRoom(room, actor, 'playPause')) return false;
    if (
      ['media.play', 'media.toggle', 'media.ready.start'].includes(command.action) &&
      !isHost(room, actor) &&
      !this.isAdmin(actor) &&
      ![...(room.viewers?.values() || [])].some(viewer => isHost(room, viewer.actor) || this.isAdmin(viewer.actor))
    ) {
      return this.canRoom(room, actor, 'continueWithoutHost');
    }
    return true;
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
    const savedUnpublish = command.action === 'room.unpublish' && !!this.savedPublicationExecute;
    const publishing = command.action === 'room.publish' && !!this.publicationExecute;
    if ((command.action.startsWith('room.event.') && this.scheduledEventExecute) || savedUnpublish || publishing) {
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
        if (publishing) return await this.publicationExecute(input.roomId, actor, permitted);
        return savedUnpublish
          ? await this.savedPublicationExecute(input.roomId, actor, permitted)
          : await this.scheduledEventExecute(input.roomId, command, actor, permitted);
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
      const extendedTtlMs = [
        'queue.bulk',
        'queue.auto',
        'queue.auto.skip',
        'queue.auto.pin',
        'queue.add',
        'queue.playNow',
      ].includes(command.action)
        ? 30000
        : undefined;
      const deadlines = resolveCommandDeadlines({
        acceptedAt,
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs,
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
    // Only the authenticated watch endpoint can attach a viewer identity.
    // Personal audio/quality never changes the room for other viewers.
    const personal =
      this.rooms.has(input.roomId) &&
      !!actor.watchViewerId &&
      [
        'media.quality.set',
        'media.tracks.set',
        'media.stream.refresh',
        'media.volume.set',
        'media.mute',
        'media.unmute',
        'media.reporting.set',
      ].includes(command.action);
    const manage = Engine.MANAGEMENT.includes(command.action) && !personal;
    const s = this.rooms.get(input.roomId);
    if (
      !s ||
      !(personal
        ? viewEligible(s, actor, this.config, Date.now(), this.access, this.isAdmin(actor))
        : eligible(s, actor, this.config, Date.now(), this.access, manage, this.isAdmin(actor)))
    )
      return { status: 'forbidden', message: 'No controllable room.' };
    if (this.watchCanView && !(await this.watchCanView(s, actor)))
      return { status: 'forbidden', message: 'No controllable room.' };
    if (!this.roomCommandAllowed(s, actor, command, personal))
      return { status: 'forbidden', message: 'Your room permissions do not allow this action.' };
    if (s.execute) {
      const acceptedAt = Date.now();
      // A fresh personal quality request starts immediately, but Plex room
      // preparation can take longer than the default command deadline.
      // Keep completion bounded and recheck the same live authorization below.
      const preparing =
        (personal && ['media.quality.set', 'media.tracks.set', 'media.stream.refresh'].includes(command.action)) ||
        ['media.load', 'room.publish'].includes(command.action) ||
        [
          'queue.bulk',
          'queue.auto',
          'queue.auto.skip',
          'queue.auto.pin',
          'queue.auto.playNow',
          'queue.offer.start',
          'queue.history.replay',
          'queue.history.goBack',
          'queue.playNow',
          'queue.playEntry',
          'queue.skipTo',
          'media.next',
          'media.previous',
        ].includes(command.action) ||
        (['media.play', 'media.toggle'].includes(command.action) && this.watchIdle?.(s.roomId));
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
        (personal
          ? viewEligible(s, actor, this.config, Date.now(), this.access, this.isAdmin(actor))
          : eligible(s, actor, this.config, Date.now(), this.access, manage, this.isAdmin(actor))) &&
        this.roomCommandAllowed(s, actor, command, personal);
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
  eligible,
  viewEligible,
  isHost,
  sameVoice,
  watching,
  hash,
  UUID,
  PRESENCE_MS,
  COMMAND_MS,
  canWatch,
};
