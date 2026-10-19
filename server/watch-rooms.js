// @ts-check
'use strict';
const { RoomStore } = require('./room-store');
const { RoomQueue } = require('./room-queue');
const Policy = require('./room-policy');
const { isHost, canWatch } = require('./core');
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

// Durable lifecycle decisions. Watch retains the player, viewers and live clock.
class WatchRooms {
  constructor(watch, registry) {
    this.watch = watch; this.registry = registry; this.pending = new Set(); this.opening = new Map(); this.closing = new Map(); this.creating = 0;
    this.store = new RoomStore(registry, {
      defaults: watch.hub.config.roomPermissions,
      isAdmin: id => watch.hub.isAdmin({ userId:id, discordId:registry.identities(id).find(identity => identity.provider === 'discord')?.subject })
    });
    this.queue = new RoomQueue(registry, this.store);
    this.timer = setInterval(() => {
      for (const room of watch.rooms.values()) if (!room.saving && !room.mediaTransition && room.media && !room.reconnecting) void this.save(room);
    }, 5000);
    this.timer.unref();
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  async eligible(actor, current = async () => true) {
    const hub = this.watch.hub;
    if (this.stopped || actor.surface !== 'web' || actor.guildId !== hub.config.guildId || !hub.config.channels.includes(actor.channelId) ||
        !await current() || !canWatch(hub.access, actor.userId) && !await (hub.access?.refreshWatch || hub.access?.refresh)?.(actor.userId)) {
      throw failure('Room access expired; sign in again', 403);
    }
    await hub.refreshAdmin?.(actor);
    if (this.stopped || !await current()) throw failure('Room connection changed; retry manually', 403);
  }
  apply(room, record) {
    const previous = room.saved;
    if (previous && previous.revision > record.revision) {
      if (record.checkpointRevision > previous.checkpointRevision) {
        previous.checkpointRevision = record.checkpointRevision; previous.bookmark = record.bookmark;
      }
      if (record.queueRevision > previous.queueRevision) previous.queueRevision = record.queueRevision;
      return;
    }
    if (previous && previous.checkpointRevision > record.checkpointRevision) {
      record = { ...record, checkpointRevision:previous.checkpointRevision, bookmark:previous.bookmark };
    }
    if (previous && previous.queueRevision > record.queueRevision) {
      record = { ...record, queueRevision:previous.queueRevision };
    }
    room.saved = record;
    Object.assign(room.s, { creatorId:record.creatorId, hosts:record.hosts, permissions:record.permissions,
      name:record.name, visibility:record.visibility, ownerId:record.creatorId });
  }
  reserve(replacing = false) {
    if (this.watch.rooms.size + this.opening.size + this.creating - (replacing ? 1 : 0) >= 4) throw failure('Close an active room first', 429);
  }
  async create(actor, options, current) {
    await this.eligible(actor, current); this.reserve(); this.creating++;
    try {
      const record = await this.store.create(actor.userId, options);
      await this.eligible(actor, current);
      return this.watch.create(actor, record.visibility, record);
    } finally { this.creating--; }
  }
  async identify(media) {
    if (media.id === 'demo' || media.mediaId === 'demo') return 'local-demo';
    if (!this.identifying) {
      this.identifying = (async () => {
        const info = await this.watch.plex.json('/');
        const id = info.machineIdentifier, pinned = this.watch.hub.config.plexMachineIdentifier || this.registry.meta('plexMachineIdentifier');
        if (typeof id !== 'string' || !id || pinned && id !== pinned) throw failure('The configured Plex server identity changed', 503);
        if (!pinned) { this.registry.meta('plexMachineIdentifier', id); await this.registry.flush(); }
        return id;
      })();
      this.identifying.catch(() => { this.identifying = undefined; });
    }
    return this.identifying;
  }
  async reopen(id, actor, current) {
    await this.eligible(actor, current);
    await this.closing.get(id);
    this.store.restore(id, actor.userId);
    const existing = this.watch.rooms.get(id);
    if (existing && !existing.reconnecting) return id;
    if (!this.opening.has(id)) {
      this.reserve(!!existing);
      const opening = (async () => {
        if (existing) await this.watch.remove(id);
        const record = this.store.restore(id, actor.userId), saved = record.bookmark;
        let media, adopted = false;
        try {
          if (saved) {
            if (await this.identify(saved) !== saved.serverId) throw failure('This room belongs to another Plex server; choose a new video');
            if (saved.mediaId === 'demo') {
              if (!this.watch.demoMedia) throw failure('The saved test video is unavailable');
              media = { ...this.watch.demoMedia, id:'demo', resources:new Map() };
            } else {
              const plex = this.watch.hub.plexFor ? await this.watch.hub.plexFor(actor) : this.watch.plex;
              media = await plex.prepare(saved.mediaId, 'direct', false, undefined, undefined, { sourceOnly:true });
            }
            if (Math.abs(media.duration - saved.duration) > .5 || media.source?.type && media.source.type !== saved.type) {
              throw failure('The saved video changed. Clear its saved video in room settings before choosing it again.');
            }
            media.roomServerId = saved.serverId;
          }
          await this.eligible(actor, current);
          const latest = this.store.restore(id, actor.userId);
          if (latest.revision !== record.revision || latest.checkpointRevision !== record.checkpointRevision) throw failure('The saved room changed; reopen it again');
          const opened = this.watch.create(actor, latest.visibility, latest), room = this.watch.rooms.get(opened);
          room.media = media || null; room.position = Math.min(saved?.position || 0, media?.duration || 0);
          room.s.state.seekable = !!media; room.s.state.paused = true; room.manualPaused = true;
          if (media) { room.initialGate = true; this.watch.beginReadiness(room); }
          adopted = true; return opened;
        } finally { if (media && !adopted) await this.watch.plex.stop(media); }
      })();
      this.opening.set(id, opening);
      opening.then(() => this.opening.delete(id), () => this.opening.delete(id));
    }
    const opened = await this.opening.get(id);
    await this.eligible(actor, current); this.store.restore(id, actor.userId);
    return opened;
  }
  list(actor, page) {
    const result = this.store.list(actor.userId, page);
    return { ...result, rooms:result.rooms.map(record => ({ id:record.id, name:record.name, visibility:record.visibility,
      active:!!this.watch.rooms.get(record.id) && !this.watch.rooms.get(record.id).reconnecting,
      title:record.bookmark?.title, position:record.bookmark?.position || 0, updatedAt:record.updatedAt })) };
  }
  summary(id, actor) {
    const record = this.store.get(id), room = this.watch.rooms.get(id);
    const person = userId => ({ id:userId, name:this.registry.canonical(userId)?.name || 'Room member' });
    const candidates = [...new Set([record.creatorId, ...record.hosts, ...[...(room?.viewers.values() || [])].map(viewer => viewer.userId)])];
    return { id, name:record.name, visibility:record.visibility, revision:record.revision, active:!!room && !room.reconnecting, hasLiveRoom:!!room, epoch:room?.s.epoch, hasBookmark:!!record.bookmark,
      creator:person(record.creatorId), hosts:record.hosts.map(person), candidates:candidates.map(person),
      role:Policy.role(record, actor.userId), permissions:record.permissions,
      capabilities:Object.fromEntries([...Policy.CAPABILITIES, ...Policy.CREATOR_ONLY].map(key =>
        [key, this.watch.hub.isAdmin(actor) || Policy.allowed(record, actor.userId, key)])) };
  }
  async edit(id, actor, revision, change, current) {
    await this.eligible(actor, current);
    const room = this.watch.rooms.get(id);
    if (change?.action === 'bookmark.clear' && room) throw failure('Close the room before clearing its saved video');
    await this.metadata(id,actor);
    if (!await current()) throw failure('Room connection changed', 403);
    const record = await this.store.edit(id, actor.userId, revision, change);
    if (change.action === 'delete') {
      if (room) this.watch.remove(id, false);
      return { deleted:true };
    }
    if (room && this.watch.rooms.get(id) === room) {
      this.apply(room, record); room.revision++;
      if (change.action !== 'rename') {
        this.watch.revokeConsent(room); this.watch.refresh(room); await this.elect(room);
      }
    }
    return this.summary(id, actor);
  }
  async metadata(id, actor) {
    const record = this.store.get(id);
    if (Policy.role(record,actor.userId) !== 'viewer' || this.watch.hub.isAdmin(actor)) return;
    const room = this.watch.rooms.get(id);
    if (!room || !await this.watch.canView(room,actor)) throw failure('Room unavailable',403);
  }
  async closeRoom(id, actor, epoch, current) {
    await this.eligible(actor,current); await this.metadata(id,actor);
    const room = this.watch.rooms.get(id);
    if (!room || room.s.epoch !== epoch) throw failure('Room changed; refresh before closing');
    if (!this.watch.hub.canRoom(room.s,actor,'closeRoom')) throw failure('Room close permission required',403);
    if (!await current() || this.watch.rooms.get(id) !== room || room.s.epoch !== epoch) throw failure('Room connection changed');
    await this.watch.remove(id);
    return {ok:true};
  }
  freeze(room, at = Date.now()) {
    this.watch.cancelAutoplay(room);
    room.position = this.watch.position(room, Math.max(room.changedAt, at)); room.changedAt = Date.now();
    room.pauseAt = room.startAt = undefined; room.s.state.paused = true; room.manualPaused = true; room.revision++;
  }
  async elect(room) {
    if (room.electing || this.watch.rooms.get(room.s.roomId) !== room) return;
    const candidates = [...room.viewers.entries()].sort((a, b) => Number(isHost(room.s, b[1].actor) || this.watch.hub.isAdmin(b[1].actor)) -
      Number(isHost(room.s, a[1].actor) || this.watch.hub.isAdmin(a[1].actor)) || a[1].joinedAt - b[1].joinedAt);
    const current = room.viewers.get(room.hostViewerId);
    if (current && Date.now() - current.at < 10000 && (isHost(room.s, current.actor) || this.watch.hub.isAdmin(current.actor))) return;
    if (room.waitingForHost && !candidates.some(([,viewer]) => isHost(room.s,viewer.actor) || this.watch.hub.isAdmin(viewer.actor) ||
        this.watch.hub.canRoom(room.s,viewer.actor,'continueWithoutHost'))) return;
    // Freeze immediately; permission refresh/media authorization can take time.
    const wasPlaying = !room.s.state.paused; this.freeze(room); this.watch.revokeConsent(room);
    room.electing = true;
    try {
      for (const [viewerId, viewer] of candidates) {
        if (!isHost(room.s, viewer.actor) && !this.watch.hub.isAdmin(viewer.actor) &&
            !this.watch.hub.canRoom(room.s, viewer.actor, 'continueWithoutHost')) continue;
        if (viewer.alive && !await viewer.alive() || !await this.watch.canView(room, viewer.actor) ||
            this.watch.rooms.get(room.s.roomId) !== room || room.viewers.get(viewerId) !== viewer || Date.now() - viewer.at >= 10000) continue;
        room.s.hostId = viewer.userId; room.s.hostName = viewer.name; room.hostViewerId = viewerId;
        room.waitingForHost = false;
        if (wasPlaying && this.watch.hub.canRoom(room.s, viewer.actor, 'playPause')) {
          await this.watch.hub.dispatch({ ...viewer.actor, watchViewerId:viewerId }, { roomId:room.s.roomId, action:'media.play' });
        }
        return;
      }
      room.hostViewerId = undefined;
      room.waitingForHost = room.viewers.size > 0;
    } finally { room.electing = false; void this.save(room); }
  }
  save(room) {
    if (!room.saved) return Promise.resolve();
    if (room.transitionCommit) return this.track(room.transitionCommit.then(() => this.save(room)));
    const media = room.media;
    const bookmark = media ? { serverId:media.roomServerId, mediaId:media.id, type:media.source?.type || 'movie',
      title:media.title, duration:media.duration, position:this.watch.position(room) } : null;
    const saving = (room.saving || Promise.resolve()).then(async () => {
      const record = this.store.get(room.s.roomId);
      this.apply(room, await this.store.checkpoint(record.id, record.checkpointRevision, bookmark));
      if (bookmark) this.queue.checkpoint(record.id, bookmark.position);
    }).catch(error => { room.saveError = 'Room progress could not be saved. Check server storage.'; this.freeze(room); throw error; });
    room.saving = saving;
    saving.then(() => { if (room.saving === saving) room.saving = undefined; }, () => {});
    return this.track(saving);
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([...this.opening.values(), ...this.pending]);
  }
}
module.exports = { WatchRooms };
