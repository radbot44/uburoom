// @ts-check
'use strict';
const { repositories } = require('./repositories');
const { RoomStore, newInviteCode } = require('./room-store');
const { RoomQueue } = require('./room-queue');
const Policy = require('./room-policy');
const { canWatch } = require('./core');
const { applyTimelineCommand } = require('../shared/sync');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

// Durable lifecycle decisions. Watch retains the player, viewers and live clock.
class WatchRooms {
  constructor(watch, registry) {
    this.watch = watch;
    this.registry = registry;
    this.pending = new Set();
    this.opening = new Map();
    this.closing = new Map();
    this.closedLocks = new Map();
    this.creating = 0;
    this.limits = require('./room-limits').limits(watch.hub.config);
    this.people = new (require('./room-presence').RoomPresence)(this.limits.maxPeople, () => watch.clock.now());
    this.recoveries = new Map();
    this.store = new RoomStore(registry, {
      limits: this.limits,
      defaults: watch.hub.config.roomPermissions,
      isAdmin: id =>
        watch.hub.isAdmin({
          userId: id,
          discordId: registry.identities(id).find(identity => identity.provider === 'discord' && identity.verified)
            ?.subject,
        }),
      guests: id => watch.hub.guestMembers(id) || [],
      defaultAllowGuests: !!(watch.hub.config.guests?.enabled && watch.hub.config.guests?.defaultAllow !== false),
    });
    this.queue = new RoomQueue(registry, this.store);
    registry.transaction(() => {
      for (const { roomId } of repositories(this.store.db).queue.listOverHistoryLimit(this.limits.maxHistory)) {
        this.queue.pruneHistory(roomId);
        repositories(this.store.db).rooms.updateRoomsSetQueueRevisionById(roomId);
      }
    });
    for (const { id } of repositories(this.store.db).rooms.listRoomsByLiveState()) {
      const record = this.store.get(id);
      this.recoveries.set(id, { ...record.liveState, until: Infinity });
    }
    // Storage maintenance; each room's own checkpoint is an effect of its room timer.
    this.timer = setInterval(() => {
      void this.track(this.maintain()).catch(() => {});
    }, 5000);
    this.timer.unref();
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(
      () => this.pending.delete(promise),
      () => this.pending.delete(promise),
    );
    return promise;
  }
  startRecovery(now = this.watch.clock.now()) {
    this.readyAt = now;
    for (const recovery of this.recoveries.values()) {
      recovery.until = now + this.limits.recoverySeconds * 1000;
      for (const id of recovery.viewers) this.people.reserve(this.store.account(id), recovery.until);
    }
  }
  reason(record) {
    if (this.watch.hub.config.singleRoom || record.keepEmpty) return 'Kept when empty';
    if (this.watch.events.upcoming(record.id)) return 'Event scheduled';
    if (record.bookmark && record.bookmark.position < record.bookmark.duration * 0.9) return 'Video in progress';
    if (this.queue.pending(record.id).length) return 'Queue pending';
    if (record.autoQueue.mode === 'following' || record.autoQueue.mode === 'random' || record.autoQueue.next)
      return 'Auto-queue enabled';
    return null;
  }
  checkCapacity(room, userId) {
    const now = this.watch.clock.now(),
      members = new Set([...room.viewers.values()].map(v => this.store.account(v.userId)));
    for (const saved of room.disconnectedViewers.values())
      if (saved.expires > now) members.add(this.store.account(saved.userId));
    if (room.recovery?.until > now) for (const id of room.recovery.viewers) members.add(this.store.account(id));
    const record = this.store.get(room.roomId),
      maximum = Math.min(record.maxMembers || this.limits.maxMembers, this.limits.maxMembers);
    if (!members.has(userId) && members.size >= maximum) throw failure('Room full; try again when someone leaves', 429);
  }
  async recover(id, actor, current) {
    const recovery = this.recoveries.get(id);
    if (!recovery || recovery.until <= this.watch.clock.now()) return;
    if (actor.guestRoomId && actor.guestRoomId !== id) return;
    const record = this.store.get(id);
    if (record.visibility === 'private' && !Policy.assigned(record, actor.userId) && !this.watch.hub.isAdmin(actor))
      return;
    await this.eligible(actor, current);
    if (!this.opening.has(id)) {
      const opening = (async () => {
        await this.closedLocks.get(id);
        let media;
        try {
          const saved = record.bookmark;
          if (saved) {
            if (!(await this.watch.providers.recorded(saved))) throw failure('The saved media server changed', 409);
            const provider = await this.watch.hub.mediaFor(actor, saved.serverId);
            media =
              saved.mediaId === 'demo'
                ? this.watch.demoMedia && { ...this.watch.demoMedia, id: 'demo', resources: new Map() }
                : await this.savedSource(provider, saved);
            if (!media || Math.abs(media.duration - saved.duration) > 0.5 || (media.type && media.type !== saved.type))
              throw failure('The saved video changed or is unavailable', 409);
            media.roomServerId = saved.serverId;
          }
          await this.eligible(actor, current);
          if (this.recoveries.get(id) !== recovery || recovery.until <= this.watch.clock.now()) return;
          const latest = this.store.get(id);
          if (latest.checkpointRevision !== record.checkpointRevision || latest.revision !== record.revision)
            throw failure('Room changed during recovery', 409);
          this.watch.create(actor, latest.visibility, latest);
          const room = this.watch.rooms.get(id);
          room.media = media || null;
          media = undefined;
          room.position = saved?.position || 0;
          room.state.seekable = !!room.media;
          room.manualPaused = !recovery.wasPlaying;
          room.recovery = recovery;
          room.hostId = record.creatorId;
          room.hostName = this.registry.canonical(record.creatorId)?.name || 'Room leader';
          room.initialGate = !!room.media;
          if (room.media) this.watch.beginReadiness(room);
        } finally {
          if (media) await this.watch.providers.stop(media);
        }
      })();
      this.opening.set(id, opening);
      opening.finally(() => this.opening.delete(id)).catch(() => {});
    }
    await this.opening.get(id);
  }
  recoveryState(room) {
    if (!room.recovery) return;
    const present = new Set([...room.viewers.values()].map(v => this.store.account(v.userId)));
    return {
      until: room.recovery.until,
      missing: new Set(room.recovery.viewers.map(id => this.store.account(id)).filter(id => !present.has(id))).size,
    };
  }
  // A recovered room that was playing starts again once everyone it saved is back
  // and ready (the room core's automatic start; no host actor is needed).
  recoveryReady(room) {
    const recovery = room.recovery;
    return (
      !!recovery &&
      recovery.until > this.watch.clock.now() &&
      !!recovery.wasPlaying &&
      !!room.media &&
      !this.recoveryState(room).missing &&
      [...room.viewers.values()].every(v => v.ready && v.version === room.mediaVersion)
    );
  }
  finishRecovery(room) {
    room.recovery = undefined;
    this.recoveries.delete(room.roomId);
  }
  withClosedLock(id, action) {
    const previous = this.closedLocks.get(id) || Promise.resolve();
    const run = previous.catch(() => {}).then(action);
    const tail = run.finally(() => {
      if (this.closedLocks.get(id) === tail) this.closedLocks.delete(id);
    });
    this.closedLocks.set(id, tail);
    return run;
  }
  async maintain(now = this.watch.clock.now()) {
    if (this.stopped || !this.readyAt) return;
    this.maintainAt = now;
    if (this.maintaining) {
      this.maintainDirty = true;
      return;
    }
    this.maintaining = true;
    this.maintainDirty = true;
    try {
      while (this.maintainDirty && !this.stopped) {
        this.maintainDirty = false;
        const tickNow = this.maintainAt;
        for (const [id, recovery] of this.recoveries)
          if (recovery.until <= tickNow) {
            this.recoveries.delete(id);
            const room = this.watch.rooms.get(id);
            if (room) {
              await this.watch.inRoom(
                room,
                () => {
                  room.recovery = undefined;
                  this.freeze(room);
                },
                undefined,
              );
              if (!room.viewers.size) await this.watch.remove(id);
              else await this.save(room);
            } else {
              repositories(this.store.db).rooms.clearLiveState(id);
              await this.registry.flush();
              await this.deleteEmpty(id);
            }
          }
        if (!this.limits.inactiveDays) continue;
        const cutoff = tickNow - this.limits.inactiveDays * 86400000;
        let count = /** @type {{n:number}} */ (repositories(this.store.db).rooms.count()).n;
        for (const { id } of repositories(this.store.db).rooms.listRoomsByLastAccessedAt(cutoff)) {
          if (count <= this.limits.minRetained) break;
          if (
            this.watch.rooms.has(id) ||
            this.opening.has(id) ||
            this.closing.has(id) ||
            this.recoveries.has(id) ||
            this.watch.events.upcoming(id) ||
            (this.watch.hub.config.singleRoom && id === this.registry.meta('singleRoomId'))
          )
            continue;
          await this.watch.events?.cancelForRoom?.(id);
          await this.store.destroy(id);
          count--;
        }
      }
    } finally {
      this.maintaining = false;
    }
  }
  async deleteEmpty(id) {
    if (this.stopped || this.watch.rooms.has(id) || this.recoveries.has(id) || this.opening.has(id)) return;
    let record;
    try {
      record = this.store.get(id);
    } catch (error) {
      if (error.status === 404) return;
      throw error;
    }
    if (!this.reason(record)) {
      await this.watch.events?.cancelForRoom?.(id);
      this.watch.publications?.roomClosed?.(id);
      await this.store.destroy(id);
    }
  }
  async eligible(actor, current = async () => true) {
    const hub = this.watch.hub;
    if (
      this.stopped ||
      !(await current()) ||
      (!canWatch(hub.access, actor.userId, actor) && !(await hub.admit(actor.userId, actor)))
    ) {
      throw failure('Room access expired; sign in again', 403);
    }
    await hub.refreshAdmin(actor);
    if (this.stopped || !(await current())) throw failure('Room connection changed; retry manually', 403);
  }
  async claimHosts(userId) {
    let lobbyChanged = false;
    for (const id of await this.store.claimHosts(userId)) {
      const room = this.watch.rooms.get(id);
      if (room) {
        lobbyChanged = true;
        await this.watch.inRoom(
          room,
          () => {
            this.apply(room, this.store.get(id));
            room.revision++;
            this.watch.changed(room, { lobby: true });
          },
          undefined,
        );
        void this.watch.coordinator.dispatch(room, { type: 'roles' });
      }
    }
    if (lobbyChanged) this.watch.changed?.(undefined, { lobby: true });
  }
  apply(room, record) {
    const previous = room.saved;
    if (previous && previous.revision > record.revision) {
      if (record.checkpointRevision > previous.checkpointRevision) {
        previous.checkpointRevision = record.checkpointRevision;
        previous.bookmark = record.bookmark;
      }
      if (record.queueRevision > previous.queueRevision) previous.queueRevision = record.queueRevision;
      return;
    }
    if (previous && previous.checkpointRevision > record.checkpointRevision) {
      record = { ...record, checkpointRevision: previous.checkpointRevision, bookmark: previous.bookmark };
    }
    if (previous && previous.queueRevision > record.queueRevision) {
      record = { ...record, queueRevision: previous.queueRevision };
    }
    room.saved = record;
    if (room.slug && record.slug && room.slug !== record.slug) {
      room.previousSlugs ||= new Set();
      room.previousSlugs.add(room.slug);
    }
    Object.assign(room, {
      creatorId: record.creatorId,
      hosts: record.hosts,
      invited: record.invited,
      inviteCode: record.inviteCode,
      permissions: record.permissions,
      name: record.name,
      slug: record.slug,
      ubumfaWord: record.ubumfaWord,
      visibility: record.visibility,
      ownerId: record.creatorId,
    });
  }
  reserve(replacing = false) {
    if (
      new Set([...this.watch.rooms.keys(), ...this.recoveries.keys(), ...this.opening.keys()]).size +
        this.creating -
        (replacing ? 1 : 0) >=
      this.limits.maxOpen
    )
      throw failure('Open room limit reached; close an active room first', 429);
  }
  async create(actor, options, current) {
    if (this.watch.hub.config.singleRoom) throw failure('Room creation is disabled in single-room mode', 403);
    if (actor.guestRoomId) throw failure('Guests cannot create rooms', 403);
    await this.eligible(actor, current);
    this.reserve();
    this.creating++;
    try {
      let creation = options,
        initialCorpus;
      if (options?.autoQueue && ['following', 'random'].includes(options.autoQueue.mode)) {
        const config = options.autoQueue,
          scope = config.scope;
        if (!scope?.id || !['show', 'library', 'collection'].includes(scope.type))
          throw failure('Choose an auto-queue source');
        const serverId = await this.identify(scope);
        const provider = await this.watch.hub.mediaFor(actor, serverId);
        const items = await provider.queueItems({ ...scope, includeSpecials: !!config.includeSpecials });
        if ((await this.watch.hub.mediaFor(actor, serverId)).principal !== provider.principal)
          throw failure('Media access changed', 403);
        creation = { ...options, autoQueue: { ...config, scope: { type: scope.type, id: scope.id, serverId } } };
        initialCorpus = items.map(item => this.watch.queueItem(item, serverId));
        await this.eligible(actor, current);
      } else if (options?.autoQueue && options.autoQueue.mode === 'continue') {
        creation = { ...options, autoQueue: { mode: 'continue', scope: null, includeSpecials: false } };
      }
      let record = await this.store.create(actor.userId, creation);
      if (initialCorpus?.length) {
        await this.queue.generate(record.id, actor.userId, initialCorpus);
        await this.watch.verifyAutoNext?.(record.id, actor, initialCorpus);
        record = this.store.get(record.id);
      }
      await this.eligible(actor, current);
      return this.watch.create(actor, record.visibility, record);
    } finally {
      this.creating--;
    }
  }
  // A saved room that stays closed, such as one made for a scheduled watch night.
  async createClosed(actor, options, current) {
    if (this.watch.hub.config.singleRoom) throw failure('Room creation is disabled in single-room mode', 403);
    if (actor.guestRoomId) throw failure('Guests cannot create rooms', 403);
    await this.eligible(actor, current);
    const record = await this.store.create(actor.userId, options);
    await this.eligible(actor, current);
    return record.id;
  }
  /** The server id this media, or a reference that names its server, is recorded under. */
  identify(media) {
    return this.watch.providers.identify(media);
  }
  async savedSource(provider, saved) {
    try {
      return await provider.prepare(saved.mediaId, 'direct', false, undefined, undefined, { sourceOnly: true });
    } catch (error) {
      if (error.code !== 'MEDIA_UNAVAILABLE') throw error;
      return {
        id: saved.mediaId,
        title: saved.title,
        duration: saved.duration,
        type: saved.type,
        kind: provider.kind,
        resources: new Map(),
        unavailable: true,
        playbackError: error.message,
      };
    }
  }
  async reopen(id, actor, current) {
    if (actor.guestRoomId) throw failure('Guests cannot reopen rooms', 403);
    if (this.watch.hub.config.singleRoom) {
      const selected = await this.ensureSingle(actor, current);
      if (id !== selected) throw failure('Only the configured shared room is available', 403);
      return selected;
    }
    await this.eligible(actor, current);
    await this.closing.get(id);
    await this.closedLocks.get(id);
    if (this.recoveries.has(id)) await this.recover(id, actor, current);
    this.store.restore(id, actor.userId);
    const existing = this.watch.rooms.get(id);
    if (existing && !existing.frozen) return id;
    if (!this.opening.has(id)) {
      this.reserve(!!existing);
      const opening = (async () => {
        if (existing) await this.watch.remove(id);
        const record = this.store.restore(id, actor.userId),
          saved = record.bookmark;
        let media,
          adopted = false;
        try {
          if (saved) {
            if (!(await this.watch.providers.recorded(saved)))
              throw failure('This room belongs to another media server; choose a new video');
            if (saved.mediaId === 'demo') {
              if (!this.watch.demoMedia) throw failure('The saved test video is unavailable');
              media = { ...this.watch.demoMedia, id: 'demo', resources: new Map() };
            } else {
              const provider = await this.watch.hub.mediaFor(actor, saved.serverId);
              media = await this.savedSource(provider, saved);
            }
            if (Math.abs(media.duration - saved.duration) > 0.5 || (media.type && media.type !== saved.type)) {
              throw failure(
                'The saved video changed. Clear its saved video in room settings before choosing it again.',
              );
            }
            media.roomServerId = saved.serverId;
          }
          await this.eligible(actor, current);
          const latest = this.store.restore(id, actor.userId);
          if (latest.revision !== record.revision || latest.checkpointRevision !== record.checkpointRevision)
            throw failure('The saved room changed; reopen it again');
          const opened = this.watch.create(actor, latest.visibility, latest),
            room = this.watch.rooms.get(opened);
          room.media = media || null;
          room.position = Math.min(saved?.position || 0, media?.duration || 0);
          room.state.seekable = !!media;
          room.state.paused = true;
          room.manualPaused = true;
          if (media) {
            room.initialGate = true;
            this.watch.beginReadiness(room);
          }
          adopted = true;
          return opened;
        } finally {
          if (media && !adopted) await this.watch.providers.stop(media);
        }
      })();
      this.opening.set(id, opening);
      opening.then(
        () => this.opening.delete(id),
        () => this.opening.delete(id),
      );
    }
    const opened = await this.opening.get(id);
    await this.eligible(actor, current);
    this.store.restore(id, actor.userId);
    return opened;
  }
  list(actor, page) {
    if (this.watch.hub.config.singleRoom || actor.guestRoomId) return { rooms: [], total: 0 };
    const result = this.store.list(actor.userId, page);
    return {
      ...result,
      rooms: result.rooms.map(record => ({
        id: record.id,
        name: record.name,
        slug: record.slug,
        visibility: record.visibility,
        active:
          this.recoveries.has(record.id) ||
          (!!this.watch.rooms.get(record.id) && !this.watch.rooms.get(record.id).frozen),
        title: record.bookmark?.title,
        position: record.bookmark?.position || 0,
        updatedAt: record.updatedAt,
        createdAt: record.createdAt,
        lastAccessedAt: record.lastAccessedAt,
        retentionReason: this.reason(record),
        recovering: this.recoveries.has(record.id),
        members: new Set([...(this.watch.rooms.get(record.id)?.viewers.values() || [])].map(v => v.userId)).size,
        maxMembers: Math.min(record.maxMembers || this.limits.maxMembers, this.limits.maxMembers),
      })),
    };
  }
  participants(id) {
    const record = this.store.get(id),
      room = this.watch.rooms.get(id);
    const now = this.watch.clock.now();
    const activeAndRecovering = [
      ...(room?.viewers.values() || []),
      ...[...(room?.disconnectedViewers.values() || [])].filter(viewer => viewer.expires > now),
    ];
    return [...new Set([record.creatorId, ...record.hosts, ...activeAndRecovering.map(viewer => viewer.userId)])].map(
      userId => ({
        id: userId,
        name: this.registry.canonical(userId)?.name || 'Room member',
        role: Policy.role(record, userId),
        explicitHost: record.hosts.includes(userId),
        present: [...(room?.viewers.values() || [])].some(viewer => viewer.userId === userId),
        // guest: the name is not verified. passGuest: in this room through a pass, so never a host.
        ...(this.registry.isGuest?.(userId) ? { guest: true } : {}),
        ...(record.guests?.includes(userId) ? { passGuest: true } : {}),
      }),
    );
  }
  summary(id, actor) {
    const record = this.store.get(id),
      room = this.watch.rooms.get(id);
    const person = userId => ({
      id: userId,
      name: this.registry.canonical(userId)?.name || 'Room member',
      ...(this.registry.isGuest?.(userId) ? { guest: true } : {}),
      ...(record.guests?.includes(userId) ? { passGuest: true } : {}),
    });
    const candidates = [
      ...new Set([
        record.creatorId,
        ...record.hosts,
        ...[...(room?.viewers.values() || [])].map(viewer => viewer.userId),
      ]),
    ];
    return {
      id,
      createdAt: record.createdAt,
      lastAccessedAt: record.lastAccessedAt,
      keepEmpty: record.keepEmpty,
      maxMembers: record.maxMembers,
      pauseOnBuffering: !!(record.pauseOnBuffering ?? this.watch.hub.config.pauseOnBuffering),
      serverMaxMembers: this.limits.maxMembers,
      retentionReason: this.reason(record),
      singleRoom: !!this.watch.hub.config.singleRoom,
      name: record.name,
      slug: record.slug,
      visibility: record.visibility,
      revision: record.revision,
      active: !!room && !room.frozen,
      hasLiveRoom: !!room,
      epoch: room?.epoch,
      hasBookmark: !!record.bookmark,
      creator: person(record.creatorId),
      hosts: record.hosts.map(person),
      candidates: candidates.map(person),
      viewers: [...new Set([...(room?.viewers.values() || [])].map(viewer => viewer.userId))].map(person),
      actorId: actor.userId,
      allHosts: !!record.permissions.allHosts,
      canSetAllHosts: record.creatorId === actor.userId && !actor.guestRoomId,
      pendingHosts: this.store.pendingHosts(id),
      role: Policy.role(record, actor.userId),
      permissions: record.permissions,
      invite: this.inviteSummary(record, actor),
      autoplay: { enabled: record.autoplay },
      queueSummary: this.queue.summary(id),
      mediaId: record.bookmark?.mediaId,
      capabilities: Object.fromEntries(
        [...Policy.CAPABILITIES, ...Policy.CREATOR_ONLY].map(key => [
          key,
          this.watch.hub.config.singleRoom && key === 'transferCreator'
            ? false
            : this.watch.hub.config.singleRoom && key === 'deleteRoom'
              ? this.watch.hub.isAdmin(actor) || record.creatorId === actor.userId
              : this.watch.hub.isAdmin(actor) || Policy.allowed(record, actor.userId, key),
        ]),
      ),
    };
  }
  async edit(id, actor, revision, change, current) {
    if (actor.guestRoomId) throw failure('Guests cannot edit room settings', 403);
    await this.eligible(actor, current);
    if (this.watch.hub.config.singleRoom) {
      if (id !== this.registry.meta('singleRoomId')) throw failure('Only the configured shared room is available', 403);
      if (change?.action === 'rename') throw failure('The shared room is always named Room', 403);
      if (change?.action === 'keepEmpty') throw failure('The shared room is always kept', 403);
      if (change?.action === 'creator.transfer')
        throw failure('Single-room leadership is fixed by server configuration', 403);
      if (change?.action === 'delete') throw failure('Use Reset room in single-room mode', 403);
      if (change?.action === 'reset') return this.resetSingle(id, actor, revision, current);
    }
    const room = this.watch.rooms.get(id);
    if (change?.action === 'auto.reset' && room?.transition) throw failure('Wait for the current queue operation', 409);
    if (change?.action === 'bookmark.clear' && room) throw failure('Close the room before clearing its saved video');
    await this.metadata(id, actor);
    if (!(await current())) throw failure('Room connection changed', 403);
    if (change?.action === 'host.pending.add') {
      if (!this.watch.hub.isAdmin(actor) && !Policy.allowed(this.store.get(id), actor.userId, 'addHosts'))
        throw failure('Add hosts permission required', 403);
      const candidate = await this.watch.hub.directory.candidate(change.provider, change.subject);
      await this.eligible(actor, current);
      await this.metadata(id, actor);
      change = { ...change, name: candidate.name };
    }
    if (change?.action === 'guests.allow' && !this.watch.hub.canAllowGuests(this.store.get(id), actor))
      throw failure('You can’t change whether this room allows guests', 403);
    if (
      ['invite.reroll', 'guests.allow', 'guests.removeAll', 'invite.revoke'].includes(change?.action) &&
      actor.guestRoomId
    )
      throw failure('Guests can’t change the room invite', 403);
    if (change?.action === 'delete') {
      this.store.checkEdit(id, actor.userId, revision, change);
      this.recoveries.delete(id);
      if (room) await this.watch.remove(id, false);
      await this.eligible(actor, current);
      await this.watch.events?.cancelForRoom?.(id);
      this.watch.publications?.roomClosed?.(id);
    }
    const runEdit = async () => {
      const record = await this.store.edit(id, actor.userId, revision, change);
      // Removing guests or revoking an invite takes effect at once, through the kick notice.
      if (change.action === 'guests.removeAll') await this.watch.hub.endGuestSessions(id);
      if (change.action === 'invite.revoke') await this.removeFromRoom(id, [this.store.account(change.userId)]);
      if (change.action === 'delete') {
        return { deleted: true };
      }
      if (room && change.action === 'pauseOnBuffering') {
        await this.watch.inRoom(
          room,
          () => {
            this.apply(room, record);
            room.revision++;
            if (room.bufferingViewerId && !(room.saved.pauseOnBuffering ?? this.watch.hub.config.pauseOnBuffering)) {
              const action = room.waitingForHost ? 'media.pause' : 'media.play';
              applyTimelineCommand(room, { action }, { now: this.watch.clock.now() });
              this.watch.review(room);
            }
          },
          undefined,
        );
        this.watch.publications?.notify?.(id);
        return this.summary(id, actor);
      }
      if (room && this.watch.rooms.get(id) === room) {
        await this.watch.inRoom(
          room,
          () => {
            this.apply(room, record);
            room.revision++;
            this.watch.changed(room, { lobby: true });
            if (change.action === 'autoplay') this.watch.cancelAutoplay(room);
          },
          undefined,
        );
        if (change.action === 'visibility') {
          void this.watch.coordinator.dispatch(room, { type: 'visibility' });
        } else if (!['autoplay', 'rename', 'keepEmpty', 'maxMembers', 'auto.reset'].includes(change.action)) {
          void this.watch.coordinator.dispatch(room, { type: 'roles' });
        }
      }
      if (['invite.reroll', 'guests.removeAll', 'guests.allow'].includes(change.action)) {
        this.watch.events?.inviteChanged?.(id);
      }
      this.watch.publications?.notify?.(id);
      return this.summary(id, actor);
    };
    return room ? runEdit() : this.withClosedLock(id, runEdit);
  }
  // Removes these accounts' viewers from a live room with the ordinary kick notice.
  async removeFromRoom(id, userIds) {
    const room = this.watch.rooms.get(id);
    if (!room) return;
    for (const [viewerId, viewer] of [...room.viewers])
      if (userIds.includes(viewer.userId)) {
        viewer.watchSocket?.watchKick?.(id);
        await this.watch.leave(room, viewer.actor, viewerId, 'kicked');
      }
  }
  inviteSummary(record, actor) {
    const hub = this.watch.hub,
      host = hub.isAdmin(actor) || Policy.role(record, actor.userId) !== 'viewer';
    return {
      code: record.inviteCode,
      url: hub.config.publicUrl + '/join/' + record.inviteCode,
      allowGuests: record.allowGuests,
      guestsEnabled: !!hub.guestsEnabled(),
      canAllowGuests: !!hub.canAllowGuests(record, actor),
      canManage: host && !actor.guestRoomId,
      invited:
        record.visibility === 'private' && host
          ? record.invited.map(userId => ({ id: userId, name: this.registry.canonical(userId)?.name || 'Room member' }))
          : [],
    };
  }
  async metadata(id, actor) {
    if (actor.guestRoomId && actor.guestRoomId !== id) throw failure('Room unavailable', 403);
    const record = this.store.get(id);
    if (Policy.assigned(record, actor.userId) || this.watch.hub.isAdmin(actor)) return;
    const room = this.watch.rooms.get(id);
    if (!room || !(await this.watch.canView(room, actor))) throw failure('Room unavailable', 403);
  }
  async closeRoom(id, actor, epoch, current) {
    if (actor.guestRoomId) throw failure('Guests cannot close rooms', 403);
    if (this.watch.hub.config.singleRoom) throw failure('Use Reset room in single-room mode', 403);
    await this.eligible(actor, current);
    await this.metadata(id, actor);
    const room = this.watch.rooms.get(id);
    if (!room || room.epoch !== epoch) throw failure('Room changed; refresh before closing');
    if (!this.watch.hub.authorize(actor, room, 'closeRoom').ok) throw failure('Room close permission required', 403);
    if (!(await current()) || this.watch.rooms.get(id) !== room || room.epoch !== epoch)
      throw failure('Room connection changed');
    await this.watch.remove(id);
    return { ok: true };
  }
  freeze(room, at = this.watch.clock.now()) {
    this.watch.cancelAutoplay(room);
    room.position = this.watch.position(room, Math.max(room.changedAt, at));
    room.changedAt = this.watch.clock.now();
    room.pauseAt = room.startAt = undefined;
    room.state.paused = true;
    room.manualPaused = true;
    room.revision++;
    this.watch.changed(room);
  }
  async ensureSingle(actor, current = async () => true) {
    if (!this.singleOpening) {
      this.singleOpening = (async () => {
        const config = this.watch.hub.config;
        const owner = await this.watch.hub.singleRoomLeader();
        await this.eligible(actor);
        let id = this.registry.meta('singleRoomId');
        let record;
        if (id) {
          try {
            record = this.store.get(id);
          } catch (error) {
            if (error.status !== 404) throw error;
          }
        }
        if (!record) {
          record = await this.store.create(owner.id, { name: 'Room', visibility: 'public' });
          id = record.id;
          this.registry.meta('singleRoomId', id);
        }
        const hosts = [
          ...new Set([
            ...(config.roomAdministrators?.discord || []).map(
              subject => this.registry.resolve('discord', subject, 'Assigned account', false).id,
            ),
            ...(config.roomAdministrators?.plex || []).map(
              subject => this.registry.resolve('plex', subject, 'Assigned account', false).id,
            ),
            ...(config.roomAdministrators?.identities || []).map(
              entry => this.registry.resolve(entry.provider, entry.subject, 'Assigned account', false).id,
            ),
          ]),
        ].filter(id => id !== owner.id);
        const previousHosts = JSON.parse(this.registry.meta('singleRoomDefaultHosts') || '[]');
        const added = hosts.filter(host => !previousHosts.includes(host)),
          removed = previousHosts.filter(host => !hosts.includes(host));
        if (record.creatorId !== owner.id || added.length || removed.length)
          this.registry.transaction(() => {
            repositories(this.store.db).rooms.updateRoomsSetCreatorIdById(owner.id, id);
            for (const host of added) repositories(this.store.db).rooms.insertRoomHosts(id, host);
            for (const host of removed) repositories(this.store.db).rooms.deleteRoomHostsByRoomIdUserId(id, host);
            this.registry.meta('singleRoomDefaultHosts', JSON.stringify(hosts));
          });
        repositories(this.store.db).rooms.updateRoomsSetNameSlugKeepEmptyById(id);
        await this.registry.flush();
        record = this.store.get(id);
        if (this.recoveries.has(id) && !this.watch.rooms.has(id)) await this.recover(id, actor);
        for (const other of [...this.watch.rooms.keys()]) if (other !== id) await this.watch.remove(other);
        if (!this.watch.rooms.has(id)) {
          this.watch.create(actor, record.visibility, record);
          const room = this.watch.rooms.get(id);
          room.hostId = owner.id;
          room.hostName = owner.name;
          room.recovery = this.recoveries.get(id);
          if (record.bookmark) {
            const saved = record.bookmark;
            let media,
              adopted = false;
            try {
              if (await this.watch.providers.recorded(saved)) {
                const provider = await this.watch.hub.mediaFor(actor, saved.serverId);
                media =
                  saved.mediaId === 'demo'
                    ? this.watch.demoMedia && { ...this.watch.demoMedia, id: 'demo', resources: new Map() }
                    : await this.savedSource(provider, saved);
                if (
                  !media ||
                  Math.abs(media.duration - saved.duration) > 0.5 ||
                  (media.type && media.type !== saved.type)
                ) {
                  room.saveError = 'The saved video could not be restored. Choose media after checking library access.';
                } else {
                  room.media = media;
                  room.position = Math.min(saved.position, media.duration);
                  media.roomServerId = saved.serverId;
                  room.state.seekable = true;
                  room.state.paused = true;
                  room.manualPaused = true;
                  room.initialGate = true;
                  this.watch.beginReadiness(room);
                  adopted = true;
                }
              } else {
                room.saveError = 'The saved video could not be restored. Choose media after checking library access.';
              }
            } catch {
              room.saveError = 'The saved video could not be restored. Choose media after checking library access.';
            } finally {
              if (media && !adopted) await this.watch.providers.stop(media);
            }
          }
        } else {
          const existing = this.watch.rooms.get(id);
          await this.watch.inRoom(
            existing,
            () => {
              this.apply(existing, record);
              existing.revision++;
            },
            undefined,
          );
        }
        return id;
      })();
      this.singleOpening
        .finally(() => {
          this.singleOpening = undefined;
        })
        .catch(() => {});
    }
    const opened = await this.singleOpening;
    await this.eligible(actor, current);
    return opened;
  }
  async resetSingle(id, actor, revision, current) {
    const record = this.store.get(id),
      room = this.watch.rooms.get(id);
    if (!this.watch.hub.isAdmin(actor) && record.creatorId !== actor.userId)
      throw failure('Room creator rights required to reset', 403);
    if (revision !== record.revision) throw failure('Room changed; refresh before resetting');
    if (!(await current())) throw failure('Room access changed', 403);
    // Reserve the live room in its mailbox; the reset is written outside and applied back inside.
    const reserve = () => {
      if (room.transition) throw failure('Wait for the current queue or media operation before resetting');
      room.transition = { kind: 'media' };
      this.freeze(room);
      this.watch.invalidateControls(room);
      return true;
    };
    if (room && !(await this.watch.inRoom(room, reserve, false)))
      throw failure('Room changed; refresh before resetting');
    this.watch.publications?.roomClosed?.(id);
    try {
      await this.watch.events?.cancelForRoom?.(id);
      if (room) await room.saving?.catch(() => {});
      const hosts = [
        ...new Set([
          ...(this.watch.hub.config.roomAdministrators?.discord || []).map(
            subject => this.registry.resolve('discord', subject, 'Assigned account', false).id,
          ),
          ...(this.watch.hub.config.roomAdministrators?.plex || []).map(
            subject => this.registry.resolve('plex', subject, 'Assigned account', false).id,
          ),
          ...(this.watch.hub.config.roomAdministrators?.identities || []).map(
            entry => this.registry.resolve(entry.provider, entry.subject, 'Assigned account', false).id,
          ),
        ]),
      ].filter(h => h !== record.creatorId);
      this.registry.transaction(() => {
        const repos = repositories(this.store.db);
        repos.rooms.deleteRoomEventsByRoomId(id);
        repos.rooms.deleteRoomInvitesByRoomId(id);
        repos.rooms.deleteRoomInviteBlocksByRoomId(id);
        repos.queue.deleteRoomProgressByRoomId(id);
        repos.queue.deleteQueueEntriesByRoomId(id);
        repos.rooms.deleteRoomHostsByRoomId(id);
        repos.rooms.deleteRoomHostGrantsByRoomId(id);
        for (const host of hosts) repos.rooms.insertRoomHosts(id, host);
        this.registry.meta('singleRoomDefaultHosts', JSON.stringify(hosts));
        repos.rooms.resetRoom(JSON.stringify(this.store.defaults), 'Room', newInviteCode(this.store.db), id);
      });
      await this.registry.flush();
      this.recoveries.delete(id);
      await this.watch.hub.endGuestSessions?.(id);
      if (room) await this.watch.inRoom(room, () => this.resetLive(room, id), undefined);
      return this.summary(id, actor);
    } finally {
      if (room?.transition?.kind === 'media') room.transition = undefined;
    }
  }
  /** Applies a written reset to the live room, inside its mailbox. */
  resetLive(room, id) {
    this.finishRecovery(room);
    const old = room.media;
    this.watch.dropMedia(room, 'room-reset');
    room.media = null;
    void this.watch.providers.stop(old);
    room.position = 0;
    room.mediaVersion = require('node:crypto').randomUUID();
    room.initialGate = false;
    room.bufferingViewerId = undefined;
    room.state.seekable = false;
    room.readinessVersion = undefined;
    room.readinessStartAt = undefined;
    room.readinessTimedOut = undefined;
    room.endedVersion = undefined;
    room.endingOffer = undefined;
    room.endingMeta = undefined;
    room.autoplayError = undefined;
    room.autoQueueError = undefined;
    room.saveError = undefined;
    this.apply(room, this.store.get(id));
    void this.watch.coordinator.dispatch(room, { type: 'roles', invalidate: false });
  }
  savedSelectionChanged(room) {
    return room.retainedEntryId !== undefined && room.retainedEntryId !== (this.queue.current(room.roomId)?.id || null);
  }
  // Queue edits keep the old source and reconnect reservations until a host actually
  // returns. Prepare its new saved selection before replacing that retained snapshot.
  async restoreSavedSelection(room, actor, current, signal) {
    if (!room.viewers.size && room.transition) throw failure('Wait for the current queue operation');
    if (!this.savedSelectionChanged(room)) {
      delete room.retainedEntryId;
      return;
    }
    const watch = this.watch;
    const work = await watch.inRoom(
      room,
      () => {
        if (room.viewers.size || (room.frozen && actor.userId !== room.hostId))
          throw failure('Room unavailable or private', 403);
        if (room.transition) throw failure('Wait for the current queue operation');
        room.transition = { kind: 'media' };
        return watch.startMediaWork(
          room,
          async work => {
            const record = this.store.get(room.roomId),
              saved = record.bookmark;
            let media,
              adopted = false;
            try {
              if (saved) {
                if (!(await watch.providers.recorded(saved))) throw failure('The saved media server changed');
                if (saved.mediaId === 'demo') {
                  if (!watch.demoMedia) throw failure('The saved test video is unavailable');
                  media = { ...watch.demoMedia, id: 'demo', resources: new Map() };
                } else {
                  const provider = await watch.hub.mediaFor(actor, saved.serverId);
                  media = await this.savedSource(provider, saved);
                  if ((await watch.hub.mediaFor(actor, saved.serverId)).principal !== provider.principal)
                    throw failure('Media access changed', 403);
                }
                if (Math.abs(media.duration - saved.duration) > 0.5 || (media.type && media.type !== saved.type))
                  throw failure('The saved video changed; choose it again');
                media.roomServerId = saved.serverId;
              }
              await this.eligible(actor, current);
              if (!(await watch.canView(room, actor))) throw failure('Room access changed', 403);
              work.signal.throwIfAborted();
              const applied = await watch.inRoom(
                room,
                () => {
                  const latest = this.store.get(room.roomId);
                  if (
                    room.closed ||
                    room.viewers.size ||
                    latest.revision !== record.revision ||
                    latest.checkpointRevision !== record.checkpointRevision ||
                    latest.queueRevision !== record.queueRevision ||
                    (room.frozen && actor.userId !== room.hostId)
                  )
                    throw failure('The saved selection changed; reconnect again');
                  work.signal.throwIfAborted();
                  if (media) {
                    watch.adoptQueueMedia(room, {
                      prepared: media,
                      args: { position: saved.position },
                      old: room.media,
                      actor,
                    });
                    room.manualPaused = true;
                  } else watch.unloadQueueMedia(room);
                  // The new generation has no participants yet. Clearing old-media
                  // grace must not let an already armed presence timer close it
                  // between adoption and the returning tab's admission.
                  room.hadViewers = false;
                  room.lastActivity = watch.clock.now();
                  delete room.retainedEntryId;
                  room.disconnectedWasPlaying = false;
                  this.apply(room, latest);
                  adopted = true;
                  return true;
                },
                false,
              );
              if (!applied) throw failure('Room is closing');
            } finally {
              if (media && !adopted) await watch.providers.stop(media);
              if (room.transition?.kind === 'media') room.transition = undefined;
            }
          },
          { kind: 'transition', signal },
        );
      },
      undefined,
    );
    if (!work) throw failure('Room is closing');
    await work.promise;
  }
  capture(room, { closing = false, at = this.watch.clock.now() } = {}) {
    const media = room.media;
    const bookmark = media
      ? {
          serverId: media.roomServerId,
          mediaId: media.id,
          type: media.type || 'movie',
          title: media.title,
          duration: media.duration,
          position: this.watch.position(room, at),
        }
      : null;
    const viewers = [
      ...new Set(
        [...room.viewers.values(), ...[...room.disconnectedViewers.values()].filter(v => v.expires > at)].map(
          v => v.userId,
        ),
      ),
    ];
    const live = closing
      ? null
      : room.recovery || {
          viewers,
          wasPlaying:
            !this.savedSelectionChanged(room) &&
            (!room.state.paused ||
              (room.initialGate && !room.manualPaused) ||
              (room.frozen && !!room.disconnectedWasPlaying)),
        };
    return {
      bookmark,
      preserveSelection: this.savedSelectionChanged(room),
      live: live ? { viewers: [...live.viewers], wasPlaying: live.wasPlaying } : null,
      active: !!room.viewers.size,
    };
  }
  save(room, { closing = false, final = false } = {}) {
    if (room.transition?.commit)
      return this.track(room.transition?.commit.then(() => this.save(room, { closing, final })));
    const captured = final ? this.capture(room, { closing, at: room.removalAt ?? this.watch.clock.now() }) : undefined;
    const previous = room.saving ? room.saving.catch(() => {}) : Promise.resolve();
    const saving = previous
      .then(async () => {
        if (!final && this.watch.rooms.get(room.roomId) !== room) return;
        const { bookmark, preserveSelection, live, active } = captured || this.capture(room, { closing });
        const record = this.store.get(room.roomId);
        const saved = this.registry.transaction(() => {
          repositories(this.store.db).rooms.saveLiveState(
            live
              ? JSON.stringify({ viewers: live.viewers.map(id => this.store.account(id)), wasPlaying: live.wasPlaying })
              : null,
            record.id,
          );
          if (active) this.store.touch(record.id);
          if (preserveSelection) return this.store.get(record.id);
          if (bookmark) this.queue.checkpoint(record.id, bookmark.position);
          return this.store.writeCheckpoint(record.id, record.checkpointRevision, bookmark);
        });
        const committed = await this.store.commit(saved);
        this.apply(room, committed);
        if (room.saveError) {
          room.saveError = undefined;
          this.watch.changed(room);
        }
      })
      .catch(error => {
        room.saveError = 'Room progress could not be saved. Check server storage.';
        this.watch.changed(room);
        this.freeze(room);
        throw error;
      });
    room.saving = saving;
    const clear = () => {
      if (room.saving === saving) room.saving = undefined;
    };
    saving.then(clear, clear);
    return this.track(saving);
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.opening.values(), ...this.pending]);
  }
}
module.exports = { WatchRooms };
