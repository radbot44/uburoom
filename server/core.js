// @ts-check
'use strict';
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').EngineCommand} EngineCommand */
/**
 * What a command was admitted under: plain data, checked by Hub.current when the
 * command is dequeued and again before its result is applied. `room` names a live
 * room's command, `saved` a closed room's queue, `service` a Discord service.
 * @typedef {{kind: 'room'|'saved'|'service', roomId: string, actor: Actor, action: string,
 *   deadline: number, adminEpoch: number, room?: any, epoch?: string}} Ticket
 */

const { createHash } = require('node:crypto');
const Engine = require('../shared/engine.mjs');
const RoomPolicy = require('./room-policy');
const { COMMAND_TTL_MS, PRESENCE_TIMEOUT_MS, resolveCommandDeadlines } = require('../shared/sync/envelope.mjs');
const { createServerClock } = require('../shared/sync/server-clock.mjs');
const { silentLogger } = require('./logger');
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
function watching(room, actor, now) {
  return [...(room.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

async function unconfiguredPlex() {
  throw new Error('No Plex service is configured');
}
const refused = () => {
  throw Object.assign(new Error('No controllable room.'), { status: 403 });
};
/**
 * What a Hub is built with. The defaults are inert, for a Hub that stands alone;
 * server composition (server/compose.js) passes every one of them.
 * @returns {{
 *   logger: any, access: any, directory: any, discord: {client: any},
 *   adminEligible: (actor: Actor) => boolean,
 *   refreshAdmin: (actor: Actor) => Promise<void>,
 *   accountActor: (actor: Actor) => Actor,
 *   watchCanView: (room: RoomDescriptor, actor: Actor) => boolean | Promise<boolean>,
 *   watchIdle: (roomId: string) => boolean,
 *   guestMembers: (roomId: string) => Set<string>,
 *   guestsEnabled: () => boolean,
 *   canAllowGuests: (record: any, actor: Actor) => boolean,
 *   canScheduleEvents: (actor: Actor) => boolean,
 *   endGuestSessions: (roomId: string, userIds?: string[]) => Promise<string[]>,
 *   plexFor: (actor: Actor) => Promise<any>,
 *   singleRoomLeader: () => Promise<any>,
 *   renameAccount: (id: string, name: string) => Promise<any>,
 *   onCommand: (roomId: string | undefined) => (action: string | undefined) => void,
 *   publicationExecute: (roomId: string, actor: Actor, ticket: Ticket) => Promise<any>,
 *   savedPublicationExecute: (roomId: string, actor: Actor, ticket: Ticket) => Promise<any>,
 *   scheduledEventExecute: (roomId: string, command: EngineCommand, actor: Actor, ticket: Ticket) => Promise<any>,
 *   savedQueueExecute: (roomId: string, command: EngineCommand, actor: Actor, ticket: Ticket) => Promise<any>,
 * }}
 */
const standalonePorts = () => ({
  logger: silentLogger,
  // Discord or test membership policy (isMember, canWatch, refresh, refreshWatch, voiceChannel, ...).
  access: { isMember: () => false, refresh: async () => false },
  directory: { connected() {}, disconnected() {}, search: async () => [], candidate: async () => undefined },
  // The Discord client, once the bot has connected.
  discord: { client: undefined },
  adminEligible: () => false,
  refreshAdmin: async () => {},
  accountActor: actor => actor,
  watchCanView: async () => true,
  watchIdle: () => false,
  guestMembers: () => new Set(),
  guestsEnabled: () => false,
  canAllowGuests: () => false,
  canScheduleEvents: () => false,
  endGuestSessions: async () => [],
  plexFor: unconfiguredPlex,
  singleRoomLeader: async () => {
    throw new Error('No single-room leader is configured');
  },
  renameAccount: async () => {
    throw new Error('Accounts cannot be renamed here');
  },
  // Called as a command starts; the result is called when it is done.
  onCommand: () => () => {},
  publicationExecute: refused,
  savedPublicationExecute: refused,
  scheduledEventExecute: refused,
  savedQueueExecute: refused,
});

class Hub {
  /**
   * @param {any} config
   * @param {Partial<ReturnType<typeof standalonePorts>>} [ports] The collaborators this hub calls out to.
   */
  constructor(config, ports = {}) {
    this.config = config;
    // The one time base for room timelines and command deadlines (see shared/sync/server-clock.mjs).
    this.clock = createServerClock();
    this.rooms = new Map();
    this.adminMode = false;
    this.adminEpoch = 0;
    this.adminUsers = new Set();
    const all = { ...standalonePorts(), ...ports };
    this.logger = all.logger;
    this.access = all.access;
    this.directory = all.directory;
    this.discord = all.discord;
    this.adminEligible = all.adminEligible;
    this.refreshAdmin = all.refreshAdmin;
    this.accountActor = all.accountActor;
    this.watchCanView = all.watchCanView;
    this.watchIdle = all.watchIdle;
    this.guestMembers = all.guestMembers;
    this.guestsEnabled = all.guestsEnabled;
    this.canAllowGuests = all.canAllowGuests;
    this.canScheduleEvents = all.canScheduleEvents;
    this.endGuestSessions = all.endGuestSessions;
    this.plexFor = all.plexFor;
    this.singleRoomLeader = all.singleRoomLeader;
    this.renameAccount = all.renameAccount;
    this.onCommand = all.onCommand;
    this.publicationExecute = all.publicationExecute;
    this.savedPublicationExecute = all.savedPublicationExecute;
    this.scheduledEventExecute = all.scheduledEventExecute;
    this.savedQueueExecute = all.savedQueueExecute;
  }
  /** Whether the account is currently admitted to watch, as last confirmed. */
  canWatch(id, actor) {
    return canWatch(this.access, id, actor);
  }
  /** Asks the providers whether the account may watch, refreshing what is known. */
  async admit(id, actor) {
    const ask = this.access.refreshWatch || this.access.refresh;
    return !!(await ask?.call(this.access, id, actor));
  }
  isOwner(actor) {
    return isOwner(actor, this.config);
  }
  canAdmin(actor) {
    return !actor.guestRoomId && (this.isOwner(actor) || this.adminEligible(actor) === true);
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
   * - a command from the command table (shared/room-protocol.mjs): room access,
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
        this.guestMembers(room.roomId).has(actor.userId) ||
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
    if (!isHost(room, actor) && !admin && !watching(room, actor, this.clock.now())) return NO_ROOM;
    if (command.host) return this.authorize(actor, room, 'room.host').ok ? ALLOW : NO_PERMISSION;
    const can = capability => this.authorize(actor, room, capability).ok;
    if (
      !command.capability ||
      !(can(command.capability) || (command.idle && this.watchIdle(room.roomId) && can(command.idle))) ||
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
  /**
   * Whether a command may still act: its deadline has not passed, Admin mode and the
   * actor's eligibility are as they were, and a live room's command still finds the
   * same room, under the same epoch, with the actor allowed. A saved queue's command
   * stops counting once the room opens.
   * @param {Ticket} ticket
   */
  current(ticket) {
    if (this.clock.now() >= ticket.deadline || this.adminEpoch !== ticket.adminEpoch) return false;
    if (ticket.kind === 'room')
      return (
        this.rooms.get(ticket.roomId) === ticket.room &&
        ticket.room.epoch === ticket.epoch &&
        this.authorize(ticket.actor, ticket.room, ticket.action).ok
      );
    if (ticket.kind === 'saved' && this.rooms.has(ticket.roomId)) return false;
    return canWatch(this.access, ticket.actor.userId, ticket.actor);
  }
  /**
   * Runs one command. When it is done, whatever it answered, the subscribers of its
   * room (or the lobby) are told through `onCommand`, which the room registry supplies.
   */
  async dispatch(actor, input) {
    const done = this.onCommand(input?.roomId);
    try {
      return await this.runCommand(actor, input);
    } finally {
      done(input?.action);
    }
  }
  async runCommand(actor, input) {
    if (Object.hasOwn(input, 'sessionId')) return { status: 'unsupported', message: 'Use the current room protocol.' };
    actor = this.accountActor(actor);
    await this.refreshAdmin(actor);
    if (!this.isOwner(actor) || this.rooms.size) {
      try {
        if (!(await this.admit(actor.userId, actor))) return { status: 'forbidden', message: 'No controllable room.' };
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
        acceptedAt: this.clock.now(),
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: 12000,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Select a room and try again.' };
      /** @type {Ticket} */
      const ticket = {
        kind: 'service',
        roomId: input.roomId,
        actor,
        action: command.action,
        deadline: deadlines.executionDeadline,
        adminEpoch: this.adminEpoch,
      };
      try {
        return declared.service === 'event'
          ? await this.scheduledEventExecute(input.roomId, command, actor, ticket)
          : await /** @type {(roomId: string, actor: any, ticket: Ticket) => Promise<any>} */ (service)(
              input.roomId,
              actor,
              ticket,
            );
      } catch (error) {
        return {
          status: error.status === 403 ? 'forbidden' : 'failed',
          message: error.status ? error.message : 'Discord could not complete this action.',
          httpStatus: error.status || 503,
        };
      }
    }
    if (command.action.startsWith('queue.') && !this.rooms.has(input.roomId)) {
      const acceptedAt = this.clock.now();
      const deadlines = resolveCommandDeadlines({
        acceptedAt,
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: declared.preparesSaved ? 30000 : undefined,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Room changed or command expired.' };
      /** @type {Ticket} */
      const ticket = {
        kind: 'saved',
        roomId: input.roomId,
        actor,
        action: command.action,
        deadline: deadlines.executionDeadline,
        adminEpoch: this.adminEpoch,
      };
      try {
        return await this.savedQueueExecute(input.roomId, command, actor, ticket);
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
    if (!(await this.watchCanView(s, actor))) return { status: 'forbidden', message: 'No controllable room.' };
    if (!this.authorize(actor, s, command.action).ok)
      return { status: 'forbidden', message: 'Your room permissions do not allow this action.' };
    if (s.execute) {
      const acceptedAt = this.clock.now();
      // A fresh personal quality request starts immediately, but Plex room
      // preparation can take longer than the default command deadline.
      // Keep completion bounded and recheck the same live authorization below.
      const preparing =
        declared.prepares === true ||
        (declared.prepares === 'personal' && !!actor.watchViewerId) ||
        (declared.prepares === 'idle' && this.watchIdle(s.roomId));
      const deadlines = resolveCommandDeadlines({
        acceptedAt,
        expiresAt: input.expiresAt,
        commandTtlMs: COMMAND_MS,
        extendedTtlMs: preparing ? 30000 : undefined,
      });
      if (!deadlines.admitted) return { status: 'unavailable', message: 'Room changed or command expired.' };
      /** @type {Ticket} */
      const ticket = {
        kind: 'room',
        roomId: s.roomId,
        actor,
        action: command.action,
        deadline: deadlines.executionDeadline,
        adminEpoch: this.adminEpoch,
        room: s,
        epoch: s.epoch,
      };
      try {
        return await s.execute(command, actor, ticket);
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
