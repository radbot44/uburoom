// @ts-check
'use strict';
/** @typedef {import('./types').Room} Room */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').EngineCommand} EngineCommand */
/** @typedef {{room: Room, kind: 'preload'|'transition'|'cleanup', controller: AbortController, signal: AbortSignal, committing: boolean, promise: Promise<any>}} MediaWork */
/** @typedef {{countdown: any, mediaId: string, startAt: number, viewers: Map<string, any>, work?: MediaWork, dropped?: boolean, media?: any, fallbackStream?: InstanceType<typeof import('./fallback-stream').FallbackStream>, source?: Promise<any>}} Preload */

const { MediaChecks } = require('./media-check');
const { waitFor, createDeadline } = require('./operation');
const { randomUUID } = require('node:crypto');
const { canWatch, Hub } = require('./core');
const { PlaybackTracking } = require('./playback-tracking');
const { PlexReporting } = require('./plex-reporting');
const { WatchRooms } = require('./watch-rooms');
const { clearPlaybackEnd } = require('./playback-end');
const {
  aggregateParticipantSyncQuality: syncQualityParticipants,
  createServerClock,
  createRoomCoordinator,
} = require('../shared/sync');
const { REJOIN } = require('./room/common');

// The parts of Watch, each a file of its methods (server/room/). They are composed
// onto one prototype that Watch extends, so every part reads the same `this`.
const parts = [
  require('./room/view'),
  require('./room/viewer-streams'),
  require('./room/personal-commands'),
  require('./room/commands'),
  require('./room/queue-commands'),
  require('./room/queue-transitions'),
  require('./room/effects'),
  require('./room/extensions'),
];
/** @type {new () => typeof import('./room/view') & typeof import('./room/viewer-streams') & typeof import('./room/personal-commands') & typeof import('./room/commands') & typeof import('./room/queue-commands') & typeof import('./room/queue-transitions') & typeof import('./room/effects') & typeof import('./room/extensions')} */
const WatchParts = /** @type {any} */ (function WatchParts() {});
for (const part of parts)
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(part)))
    Object.defineProperty(WatchParts.prototype, name, { ...descriptor, enumerable: false });

class Watch extends WatchParts {
  constructor(hub, plex, demoMedia, registry, plexAuth) {
    super();
    // Room timelines and every in-memory deadline read this clock, never Date.now() (stored and external times excepted).
    this.clock = hub?.clock || createServerClock();
    this.tracking = new PlaybackTracking(registry);
    this.hub = hub;
    this.plex = plex;
    this.demoMedia = demoMedia;
    // The one room registry. Presence, readiness, the automatic start and every room
    // lifecycle deadline are events in each room's mailbox (shared/sync/room-authority.mjs).
    this.coordinator = createRoomCoordinator({
      authorize: (actor, room, action) => this.hub.authorize(actor, room, action),
      now: () => this.clock.now(),
      monoNow: () => performance.now(),
      // Lifecycle deadlines are acted on at one-second resolution from startup.
      timerResolutionMs: 1000,
      // Each room's progress is checkpointed this often (see the 'checkpoint' effect).
      checkpointMs: 5000,
      timerOrigin: this.clock.now(),
      // A durable queue transition owns the room until its write is confirmed (A3.5 removes this).
      hold: room => !!room.transition?.commit,
      extensions: this.roomExtensions(),
      onEffect: (room, effect, removed) => this.roomEffect(room, effect, removed),
      onPublish: (room, change) => this.announce(room, change),
      // A room event reaches the lobby too when it changed what the lobby lists.
      onChange: room => {
        const stamp = this.lobbyStamp(room),
          lobby = stamp !== this.lobbyStamps.get(room);
        this.lobbyStamps.set(room, stamp);
        this.changed(room, { lobby });
      },
      onError: error =>
        this.hub.logger.warn('Room', 'Room effect failed: ' + (error instanceof Error ? error.message : String(error))),
    });
    this.rooms = this.coordinator.rooms;
    /** @type {((room: any, change: {roomId?: string, includeLobby: boolean}) => void) | undefined} Set by the socket layer when it starts. */
    this.onPublish = undefined;
    /** @type {WeakMap<Room, number>} Each room's shared-lane version (roomVersion). */
    this.roomVersions = new WeakMap();
    this.publicationCount = 0;
    /** @type {WeakMap<Room, string>} What the lobby last listed for each room (lobbyStamp). */
    this.lobbyStamps = new WeakMap();
    this.reporting = new PlexReporting({
      config: hub?.config,
      hub,
      plexAuth,
      registry,
      now: () => this.clock.now(),
      authorize: async (room, viewer) => {
        const authenticated = viewer.reportingAuthorized || viewer.alive;
        return (!authenticated || (await authenticated())) && (await this.canView(room, viewer.actor));
      },
    });
    this.roomState = new WatchRooms(this, registry);
    this.publications = new (require('./discord-publications').DiscordPublications)(this, registry);
    this.events = new (require('./room-events').RoomEvents)(this, registry);
    this.autoplayDelayMs = 10000;
    /** @type {Set<MediaWork>} */
    this.mediaWork = new Set();
    this.mediaDrainMs = 35000;
    this.providerDownSince = undefined;
    this.providerRecoveredAt = 0;
    /** @type {any} Plex transcode sessions as last reconciled (reconcilePlexSessions). */
    this.plexSessions = undefined;
    this.mediaChecks = new MediaChecks({ plex, config: hub?.config || {}, sessions: () => this.plexSessions });
    /** @type {InstanceType<typeof import('./plex-delivery').PlexDelivery> | undefined} Attached by server/watch-http.js. */
    this.delivery = undefined;
  }
  create(actor, visibility = 'public', saved) {
    if (this.shuttingDown) throw new Error('Server is closing');
    if (!['public', 'private'].includes(visibility)) throw new Error('Invalid room visibility');
    if (!canWatch(this.hub.access, actor.userId, actor))
      throw new Error('Only authenticated eligible users can create a viewing room');
    if (
      this.rooms.size >= require('./room-limits').limits(this.hub.config).maxOpen &&
      !this.roomState.recoveries.has(saved.id)
    )
      throw new Error('Close an existing viewing room first');
    const id = saved.id;
    const slug =
      saved.slug ||
      (saved.name
        ? require('../web/ubumfa').slugify(saved.name)
        : require('../web/ubumfa').generateWord(6).toLowerCase());
    const room = {
      roomId: id,
      epoch: randomUUID(),
      ownerId: actor.userId,
      ownerName: actor.name,
      hostId: actor.userId,
      hostName: actor.name,
      visibility,
      slug,
      ubumfaWord: saved.ubumfaWord || slug,
      state: {
        paused: true,
        muted: false,
        volume: 30,
        seekable: false,
      },
      media: null,
      mediaVersion: randomUUID(),
      revision: 0,
      position: 0,
      changedAt: this.clock.now(),
      viewers: new Map(),
      disconnectedViewers: new Map(),
      kickedViewers: new Map(),
      lastActivity: this.clock.now(),
      initialGate: false,
      manualPaused: false,
      initialViewers: new Set(),
      hadViewers: false,
    };
    room.execute = (command, actor, ticket) => this.execute(room, command, actor, ticket);
    this.roomState.apply(room, saved);
    this.coordinator.add(room);
    this.hub.rooms.set(id, room);
    this.hub.logger.info('Room', `Room created (${id}) by ${actor.name || actor.userId}`);
    return id;
  }
  async leave(room, actor, viewerId, reason = 'left') {
    if (room.transition?.commit) await room.transition?.commit.catch(() => {});
    if (this.rooms.get(room.roomId) !== room) return;
    this.coordinator.run(room, { type: 'leave', actor, viewerId, reason });
    if (room.closed) await room.removal;
  }
  async ready(room, actor, viewerId, version, ready, readinessVersion) {
    const result = this.coordinator.run(room, {
      type: 'ready',
      actor,
      viewerId,
      mediaVersion: version,
      ready,
      readinessVersion,
    });
    if (result.error) throw result.error;
  }
  /**
   * Admits one tab to the room, or renews the tab that is already in it. This is
   * the only way into a room: reading a room never adds anyone to it.
   * @param {any} room
   * @param {Actor} actor
   * @param {string} viewerId
   * @param {{alive?: () => Promise<boolean>, quality?: string | null, preferences?: Object, rtts?: Array<{at: number, ms: number}>}} [options]
   * @returns {any} The joined viewer.
   */
  join(room, actor, viewerId, { alive, quality, preferences, rtts } = {}) {
    if (this.shuttingDown || room.closed || this.rooms.get(room.roomId) !== room) throw new Error('Room unavailable');
    const result = this.coordinator.run(room, { type: 'join', actor, viewerId, quality, preferences, rtts });
    if (result.error) throw result.error;
    const viewer = room.viewers.get(viewerId);
    if (alive) viewer.alive = alive;
    return viewer;
  }
  /** A tab's connection closed. A planned close leaves now; any other leaves when its presence lapses. */
  disconnected(socket, planned, roomId, viewerId) {
    const room = this.rooms.get(roomId);
    if (room?.viewers.get(viewerId)?.watchSocket === socket)
      this.coordinator.run(room, { type: 'disconnect', viewerId, planned });
  }
  /**
   * Presence for one tab from its own connection (its clock exchanges and pongs).
   * Returns false once the connection no longer holds that tab.
   */
  present(socket, roomId, viewerId) {
    const room = this.rooms.get(roomId),
      viewer = room?.viewers.get(viewerId);
    if (viewer?.watchSocket !== socket) return false;
    this.touch(room, viewer, socket.watchRtts);
    return true;
  }

  /** Closes a room: an event in its mailbox, whose effect is removeRoom. */
  remove(id, save = true) {
    const room = this.rooms.get(id);
    if (!room) return;
    if (!room.removal) this.coordinator.run(room, { type: 'close', save });
    return room.removal;
  }
  // The server's half of closing a room: drain its media work, save it and let it go.
  removeRoom(room, save = true) {
    const id = room.roomId;
    if (room.removal) return room.removal;
    room.removalAt = this.clock.now();
    if (!this.shuttingDown) this.publications.roomClosed(id);
    this.cancelAutoplay(room);
    const pending = [...this.mediaWork].some(work => work.room === room);
    if (pending || room.transition?.commit) {
      room.removal = this.drainMedia(room).then(
        () => this.removeNow(room, save),
        async error => {
          await this.removeNow(room, save);
          throw error;
        },
      );
      return room.removal;
    }
    return (room.removal = this.removeNow(room, save));
  }
  removeNow(room, save) {
    const id = room.roomId;
    this.cancelAutoplay(room);
    clearPlaybackEnd(room);
    const saved = save
      ? this.roomState.save(room, { closing: !this.shuttingDown, final: true }).then(async () => {
          if (!this.shuttingDown) {
            this.roomState.recoveries.delete(id);
            await this.roomState.deleteEmpty(id);
          }
        })
      : Promise.resolve();
    this.roomState.closing.set(id, saved);
    saved.then(
      () => this.roomState.closing.delete(id),
      () => this.roomState.closing.delete(id),
    );
    room.state.paused = true;
    room.epoch = randomUUID();
    this.dropMedia(room, 'room-closed');
    this.hub.rooms.delete(id);
    this.coordinator.delete(id);
    clearInterval(room.transcodePing);
    clearInterval(room.fallbackTimer);
    void this.stopMedia(room, room.media);
    this.dropPreload(room);
    this.dropPreload(room, room.adoptable);
    this.hub.logger.info('Room', `Room closed (${id})`);
    this.changed(undefined, { lobby: true });
    return saved.finally(() => this.drainMedia(room));
  }
  close() {
    if (this.closing) return this.closing;
    this.shuttingDown = true;
    const deadline = createDeadline(this.mediaDrainMs);
    this.shutdownDeadline = deadline.signal;
    this.coordinator.close();
    if (this.roomState) {
      this.roomState.stopped = true;
      clearInterval(this.roomState.timer);
    }
    this.closing = (async () => {
      await this.publications.close();
      await this.events.close();
      const results = await Promise.allSettled([...this.rooms.keys()].map(async id => this.remove(id)));
      try {
        await this.drainMedia();
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
      try {
        await waitFor(this.roomState.close(), this.shutdownDeadline);
      } catch (error) {
        results.push({ status: 'rejected', reason: error });
      }
      results.push(
        ...(await Promise.allSettled(
          [() => this.plex.close?.(), () => this.reporting?.close()].map(action => Promise.resolve().then(action)),
        )),
      );
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    })().finally(deadline.clear);
    return this.closing;
  }
}

/**
 * The hub's calls into the rooms. Each reads `rooms()` when it is called, because the
 * hub is built before the Watch it serves.
 * @param {() => Watch} rooms
 */
function roomPorts(rooms) {
  return {
    // A finished command is published through its room's mailbox, after everything it did there.
    onCommand: roomId => {
      const watch = rooms();
      const hadMedia = Boolean(roomId && watch.rooms.get(roomId)?.media);
      return action => watch.published(roomId, action, hadMedia);
    },
    publicationExecute: (id, actor, ticket) => {
      const watch = rooms();
      return watch.publications.command(watch.rooms.get(id), 'room.publish', actor, ticket);
    },
    savedPublicationExecute: (id, actor, ticket) => rooms().publications.removeSaved(id, actor, ticket),
    scheduledEventExecute: (id, command, actor, ticket) => rooms().events.command(id, command, actor, ticket),
    savedQueueExecute: (id, command, actor, ticket) => rooms().queueCommand(id, command, actor, ticket),
    watchIdle: id => {
      const watch = rooms();
      return !watch.rooms.get(id)?.media && !watch.roomState.queue.current(id);
    },
    watchCanView: (room, actor) => {
      const watch = rooms();
      return watch.canView(watch.rooms.get(room.roomId), actor);
    },
  };
}

/**
 * A hub and the rooms it serves, wired to each other. `ports` are the hub's other collaborators.
 * @param {{config: any, ports?: object, plex: any, demoMedia?: any, registry?: any, plexAuth?: any}} options
 */
function createRooms({ config, ports = {}, plex, demoMedia, registry, plexAuth }) {
  /** @type {Watch} */
  let watch;
  const hub = new Hub(config, { plexFor: async () => plex, ...roomPorts(() => watch), ...ports });
  watch = new Watch(hub, plex, demoMedia, registry, plexAuth);
  return { hub, watch };
}
module.exports = { Watch, createRooms, roomPorts, syncQualityParticipants, REJOIN };
