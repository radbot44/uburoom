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
const RoomPolicy = require('../room-policy');
const { clearPlaybackEnd } = require('../playback-end');
const { applyReadinessDecision, applyTimelineCommand } = require('../../shared/sync');
const { expired, later } = require('./common');

/**
 * Room commands: admission in the room's mailbox, application and acknowledgement.
 * Methods of Watch (server/watch.js), which composes these modules onto its prototype.
 */
module.exports = {
  /**
   * Runs one phase of a command in the room's mailbox (see the coordinator's `step`):
   * its admission, which checks and reserves, or the completion of work that ran
   * outside. Resolves with the step's value, or `gone` when the room is no longer live.
   * @param {Room} room
   * @param {(room: Room) => any} step
   * @param {any} [gone]
   * @returns {Promise<any>}
   */
  async inRoom(room, step, gone = expired()) {
    let ran = false;
    const result = await this.coordinator.step(room, live => {
      ran = true;
      return step(live);
    });
    if (!ran) return gone;
    if (result.error) throw result.error;
    return result.value;
  },
  /**
   * A room command. Its admission runs in the room's mailbox, so a command that went
   * stale while queued (its epoch, deadline or permission changed) is refused as it is
   * dequeued. Admission answers at once or returns the work to run outside the mailbox;
   * that work comes back to the mailbox to apply its result.
   * @param {any} room
   * @param {any} input
   * @param {Actor} actor
   * @param {import('../core').Ticket} ticket
   */
  async execute(room, input, actor, ticket) {
    if (this.shuttingDown || room.closed) return { status: 'unavailable', message: 'Room is closing.' };
    const command = Engine.validate(input),
      declared = /** @type {NonNullable<ReturnType<typeof Engine.command>>} */ (Engine.command(command.action));
    this.roomState.store.healthy();
    if (declared.service === 'publish' || declared.service === 'unpublish')
      return this.publications.command(room, command.action, actor, ticket);
    if (command.action === 'room.kick') return this.kick(room, command.args.userId, actor, ticket);
    const admitted = await this.inRoom(room, () => this.admit(room, command, declared, actor, ticket));
    return typeof admitted === 'function' ? admitted() : admitted;
  },
  async kick(room, userId, actor, ticket) {
    // A durable queue transition finishes first; who is in the room is decided after it.
    if (room.transition?.commit) await room.transition.commit.catch(() => {});
    if (actor.watchCurrent && !(await actor.watchCurrent())) return expired();
    const admitted = await this.inRoom(room, () => {
      if (!this.hub.current(ticket)) return expired();
      const record = this.roomState.store.get(room.roomId);
      if (
        !this.hub.authorize(actor, room, 'kickParticipants').ok ||
        !RoomPolicy.canKickParticipant(record, actor.userId, userId, { isAdmin: this.hub.isAdmin(actor) })
      )
        return { status: 'forbidden', message: 'You cannot kick this participant.' };
      const viewers = [...room.viewers.entries()].filter(([, viewer]) => viewer.userId === userId);
      if (!viewers.length) return { status: 'unavailable', message: 'This participant has already left.' };
      this.coordinator.run(room, { type: 'kick', userId });
      return { record, viewers };
    });
    if (!admitted.viewers) return admitted;
    const { record, viewers } = admitted;
    if (room.closed) await room.removal;
    // Kicking a guest ends their guest access; kicking someone invited into a
    // private room revokes the invite. Either way they stay out until the code changes.
    const guest = this.hub.guestMembers?.(room.roomId).has(userId);
    if (guest) {
      const devices = viewers.map(([, viewer]) => viewer.actor.device).filter(Boolean);
      await this.roomState.store.block(room.roomId, ['user:' + userId, ...devices.map(device => 'device:' + device)]);
      await this.hub.endGuestSessions?.(room.roomId, [userId]);
      return { status: 'applied', message: 'Guest removed.' };
    }
    if (room.visibility === 'private' && record.invited?.includes(userId)) {
      const revoked = await this.roomState.store.revokeInvite(room.roomId, userId);
      await this.inRoom(room, () => this.roomState.apply(room, revoked), undefined);
      return { status: 'applied', message: 'Participant removed and their invite revoked.' };
    }
    return { status: 'applied', message: 'Participant removed. They may rejoin.' };
  },
  /**
   * A command's admission, inside the mailbox: it never waits. Returns the answer, or
   * the work to run outside the mailbox (a function resolving with the answer).
   * @returns {any}
   */
  admit(room, command, declared, actor, ticket) {
    const { action, args } = command;
    if (!this.hub.current(ticket)) return expired();
    // Owner decision 4: while a durable transition is committing, commands are answered, not queued.
    if (room.transition?.commit)
      return { status: 'unavailable', message: 'Wait for the current queue transition to finish.' };
    if (!room.media && ['media.play', 'media.toggle'].includes(action) && this.nextCandidate(room.roomId)) {
      if (!this.hub.authorize(actor, room, 'playPause').ok && !this.hub.authorize(actor, room, 'chooseMedia').ok) {
        return { status: 'forbidden', message: 'Starting the next video requires permission.' };
      }
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      return later(this.changeQueueMedia(room, { action: 'media.next', args: {} }, actor, ticket));
    }
    if (!room.media && room.autoplayCountdown && action === 'media.pause') {
      if (!this.hub.authorize(actor, room, 'playPause').ok)
        return { status: 'forbidden', message: 'Pausing requires playback permission.' };
      this.cancelAutoplay(room);
      room.manualPaused = true;
      room.endedVersion = undefined;
      return { status: 'applied', message: 'Autoplay paused.' };
    }
    if (!room.media && room.endedVersion && (action === 'media.seek.end' || action.startsWith('media.seek.'))) {
      if (!this.hub.authorize(actor, room, 'playPause').ok)
        return { status: 'forbidden', message: 'Seeking requires playback permission.' };
      return { status: 'applied', message: 'Current video finished.' };
    }
    const endpointSeek =
      room.media &&
      (action === 'media.seek.end' ||
        (action === 'media.seek.absolute' && args.seconds >= room.media.duration) ||
        (action === 'media.seek.relative' && this.position(room) + args.seconds >= room.media.duration));
    const endpointPlay =
      room.media &&
      ['media.play', 'media.toggle'].includes(action) &&
      (room.endedVersion === room.mediaVersion || this.position(room) >= room.media.duration - 0.1);
    if (endpointSeek || endpointPlay) {
      if (!room.viewers.size || room.transition)
        return { status: 'unavailable', message: 'Wait for an available viewing room.' };
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (room.recovery) this.roomState.finishRecovery(room);
      room.manualPaused = false;
      room.endedVersion = undefined;
      const finishing = this.finishQueueMedia(room, { mediaVersion: room.mediaVersion, epoch: room.epoch });
      return async () => {
        await finishing;
        return { status: 'applied', message: 'Current video finished.' };
      };
    }
    if (action.startsWith('queue.')) return later(this.queueCommand(room.roomId, command, actor, ticket));
    if (action.startsWith('media.autoplay.')) {
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (action === 'media.autoplay.cancel') room.endedVersion = undefined;
      const applied = { status: 'applied', message: 'Autoplay updated.' };
      if (action !== 'media.autoplay.set') return applied;
      return async () => {
        await this.roomState.queue.setAutoplay(room.roomId, actor.userId, args.enabled);
        const next = await this.inRoom(
          room,
          () => {
            this.roomState.apply(room, this.roomState.store.get(room.roomId));
            return args.enabled && !room.media && !!this.nextCandidate(room.roomId);
          },
          false,
        );
        if (next) await this.startAutoplayCountdown(room);
        return applied;
      };
    }
    if (!actor.watchQueueAdvance && declared.persists) {
      this.cancelAutoplay(room);
      clearPlaybackEnd(room);
      if (action !== 'media.next') room.endedVersion = undefined;
    }
    if (['media.load', 'media.next', 'media.previous'].includes(action))
      return later(this.changeQueueMedia(room, command, actor, ticket));
    this.settle(room);
    if (action.startsWith('media.ready.')) {
      if (!this.hub.authorize(actor, room, 'chooseMedia').ok)
        return { status: 'unavailable', message: 'This readiness choice expired.' };
      const outcome = applyReadinessDecision(room, action, args.readinessId);
      if (outcome.status !== 'applied') return { status: outcome.status, message: outcome.message };
      this.review(room);
      return { status: 'applied', message: outcome.message };
    }
    if (room.readinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(action))
      return { status: 'unavailable', message: 'The host must choose whether to start, wait or cancel.' };
    if (declared.scope === 'personal') return this.personal(room, command, declared, actor, ticket);
    if (
      actor.watchAutoplayVersion &&
      (room.manualPaused ||
        room.mediaVersion !== actor.watchAutoplayVersion ||
        room.readinessVersion !== actor.watchReadinessVersion)
    )
      return { status: 'unavailable', message: 'Autoplay was cancelled.' };
    if (!action.startsWith('room.') && action !== 'media.load' && !room.viewers.size)
      return { status: 'unavailable', message: 'No viewer is connected.' };
    if (action.startsWith('media.') && action !== 'media.load' && !room.media)
      return { status: 'unavailable', message: 'Choose a video first.' };
    if (action === 'room.visibility')
      // The durable edit runs outside; its result is applied back inside.
      return async () => {
        const record = await this.roomState.store.edit(room.roomId, actor.userId, room.saved.revision, {
          action: 'visibility',
          visibility: args.visibility,
        });
        const reply = await this.inRoom(room, () => {
          this.roomState.apply(room, record);
          this.coordinator.run(room, { type: 'visibility' });
          return this.applyCommand(room, command, actor);
        });
        return this.acknowledge(room, declared, reply);
      };
    if (['media.play', 'media.toggle'].includes(action) && room.media?.kind !== 'demo') {
      // Plex confirms the file outside the mailbox; the play applies only to the same video.
      const version = room.mediaVersion,
        media = room.media;
      return async () => {
        // An outage must not stop anyone resuming media already buffered. A file
        // Plex confirms is missing still refuses, and access is checked below.
        let plex,
          unconfirmed = false;
        try {
          plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
          if (plex.playableItem) await plex.playableItem(media.id);
        } catch (error) {
          if (!this.providerFailed(error)) throw error;
          unconfirmed = true;
        }
        if (
          !(await this.canView(room, actor)) ||
          (!unconfirmed && this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal)
        )
          return expired();
        const reply = await this.inRoom(room, () =>
          !this.hub.current(ticket) || room.mediaVersion !== version
            ? expired()
            : this.applyCommand(room, command, actor),
        );
        return this.acknowledge(room, declared, reply);
      };
    }
    const reply = this.applyCommand(room, command, actor);
    return () => this.acknowledge(room, declared, reply);
  },
  /** Applies an admitted timeline or room command to the live room, inside its mailbox. */
  applyCommand(room, command, actor) {
    const { action, args } = command;
    if (
      room.recovery &&
      (['media.pause', 'media.play', 'media.toggle'].includes(action) || action.startsWith('media.seek.'))
    )
      this.roomState.finishRecovery(room);
    const now = this.clock.now();
    if (!applyTimelineCommand(room, command, { now, autoplayVersion: actor.watchAutoplayVersion })) {
      room.position = this.position(room, now);
      room.changedAt = now;
    }
    if (action.startsWith('room.')) room.epoch = randomUUID();
    room.revision++;
    room.lastActivity = now;
    // The review is the room's next event; the acknowledgement reads the room after it.
    this.review(room);
    return { status: 'applied', feedback: { action, args, sender: Engine.senderName(actor.name), at: now } };
  },
  /**
   * Once the command's review has run: records its feedback and, for a command the
   * table marks `persists`, acknowledges only after the room's save is confirmed.
   */
  async acknowledge(room, declared, reply) {
    if (reply.status !== 'applied' || !reply.feedback) return reply;
    room.feedback = { revision: room.revision, ...reply.feedback };
    if (declared.persists) await this.roomState.save(room);
    return { status: 'applied', message: 'Viewing room updated.', state: Engine.snapshot(room.state) };
  },
};
