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
        !await current() || !canWatch(hub.access, actor.userId, actor) && !await (hub.access?.refreshWatch || hub.access?.refresh)?.(actor.userId,actor)) {
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
    if(this.watch.hub.config.singleRoom)throw failure('Room creation is disabled in single-room mode',403);
    await this.eligible(actor, current); this.reserve(); this.creating++;
    try {
      let creation = options;
      if (options?.autoQueue && options.autoQueue.mode !== 'off') {
        const config = options.autoQueue, scope = config.scope;
        if (!scope?.id || !['show','library','collection'].includes(scope.type)) throw failure('Choose an auto-queue source');
        const plex = this.watch.hub.plexFor ? await this.watch.hub.plexFor(actor) : this.watch.plex;
        await plex.queueItems({...scope,includeSpecials:!!config.includeSpecials});
        const serverId = await this.identify(scope);
        if (this.watch.hub.plexFor && (await this.watch.hub.plexFor(actor)).principal !== plex.principal) throw failure('Plex access changed',403);
        creation = {...options,autoQueue:{...config,scope:{type:scope.type,id:scope.id,serverId}}};
        await this.eligible(actor,current);
      }
      const record = await this.store.create(actor.userId, creation);
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
    if(this.watch.hub.config.singleRoom){const selected=await this.ensureSingle(actor,current);if(id!==selected)throw failure('Only the configured shared room is available',403);return selected;}
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
    if(this.watch.hub.config.singleRoom)return {rooms:[],total:0};
    const result = this.store.list(actor.userId, page);
    return { ...result, rooms:result.rooms.map(record => ({ id:record.id, name:record.name, visibility:record.visibility,
      active:!!this.watch.rooms.get(record.id) && !this.watch.rooms.get(record.id).reconnecting,
      title:record.bookmark?.title, position:record.bookmark?.position || 0, updatedAt:record.updatedAt })) };
  }
  summary(id, actor) {
    const record = this.store.get(id), room = this.watch.rooms.get(id);
    const person = userId => ({ id:userId, name:this.registry.canonical(userId)?.name || 'Room member' });
    const candidates = [...new Set([record.creatorId, ...record.hosts, ...[...(room?.viewers.values() || [])].map(viewer => viewer.userId)])];
    return { id, singleRoom:!!this.watch.hub.config.singleRoom, name:record.name, visibility:record.visibility, revision:record.revision, active:!!room && !room.reconnecting, hasLiveRoom:!!room, epoch:room?.s.epoch, hasBookmark:!!record.bookmark,
      creator:person(record.creatorId), hosts:record.hosts.map(person), candidates:candidates.map(person), viewers:[...new Set([...(room?.viewers.values() || [])].map(viewer => viewer.userId))].map(person),
      role:Policy.role(record, actor.userId), permissions:record.permissions, autoplay:{enabled:record.autoplay}, queueSummary:this.queue.summary(id), mediaId:record.bookmark?.mediaId,
      capabilities:Object.fromEntries([...Policy.CAPABILITIES, ...Policy.CREATOR_ONLY].map(key =>
        [key, this.watch.hub.config.singleRoom&&key==='transferCreator' ? false : this.watch.hub.config.singleRoom&&key==='deleteRoom' ? this.watch.hub.isAdmin(actor)||record.creatorId===actor.userId : this.watch.hub.isAdmin(actor) || Policy.allowed(record, actor.userId, key)])) };
  }
  async edit(id, actor, revision, change, current) {
    await this.eligible(actor, current);
    if(this.watch.hub.config.singleRoom){
      if(id!==this.registry.meta('singleRoomId'))throw failure('Only the configured shared room is available',403);
      if(change?.action==='creator.transfer')throw failure('Single-room leadership is fixed by discord.owner_id',403);
      if(change?.action==='delete')throw failure('Use Reset room in single-room mode',403);
      if(change?.action==='reset')return this.resetSingle(id,actor,revision,current);
    }
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
      if (change.action === 'autoplay') this.watch.cancelAutoplay(room);
      else if (change.action !== 'rename') {
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
    if(this.watch.hub.config.singleRoom)throw failure('Use Reset room in single-room mode',403);
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
  async ensureSingle(actor,current=async()=>true) {
    await this.eligible(actor,current);
    if(!this.singleOpening){
      this.singleOpening=(async()=>{
        const config=this.watch.hub.config;
        const owner=await this.watch.hub.singleRoomLeader();
        await this.eligible(actor,current);
        let id=this.registry.meta('singleRoomId');
        let record;
        if(id){try{record=this.store.get(id);}catch(error){if(error.status!==404)throw error;}}
        if(!record){record=await this.store.create(owner.id,{name:config.singleRoomName||'Room',visibility:'public'});id=record.id;this.registry.meta('singleRoomId',id);}
        const hosts=[...new Set([
          ...(config.roomAdministrators?.discord||[]).map(subject=>this.registry.resolve('discord',subject,'Assigned account',false).id),
          ...(config.roomAdministrators?.plex||[]).map(subject=>this.registry.resolve('plex',subject,'Assigned account',false).id)
        ])].filter(id=>id!==owner.id);
        const previousHosts=JSON.parse(this.registry.meta('singleRoomDefaultHosts')||'[]');
        const added=hosts.filter(host=>!previousHosts.includes(host)),removed=previousHosts.filter(host=>!hosts.includes(host));
        if(record.creatorId!==owner.id||added.length||removed.length)this.registry.transaction(()=>{
          this.store.db.prepare('UPDATE watch_rooms SET creatorId=? WHERE id=?').run(owner.id,id);
          for(const host of added)this.store.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id,host);
          for(const host of removed)this.store.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=? AND userId=?').run(id,host);
          this.registry.meta('singleRoomDefaultHosts',JSON.stringify(hosts));
        });
        await this.registry.flush();record=this.store.get(id);
        for(const other of [...this.watch.rooms.keys()])if(other!==id)await this.watch.remove(other);
        if(this.watch.rooms.get(id)?.reconnecting){await this.watch.remove(id);record=this.store.get(id);}
        if(!this.watch.rooms.has(id)){
          this.watch.create(actor,record.visibility,record);
          const room=this.watch.rooms.get(id);room.s.hostId=owner.id;room.s.hostName=owner.name;
          if(record.bookmark){
            const saved=record.bookmark;
            try{
              const plex=this.watch.hub.plexFor?await this.watch.hub.plexFor(actor):this.watch.plex;
              const media=saved.mediaId==='demo'?this.watch.demoMedia&&{...this.watch.demoMedia,id:'demo',resources:new Map()}:await plex.prepare(saved.mediaId,'direct',false,undefined,undefined,{sourceOnly:true});
              if(media&&await this.identify(saved)===saved.serverId){room.media=media;room.position=Math.min(saved.position,media.duration);media.roomServerId=saved.serverId;room.s.state.seekable=true;room.manualPaused=true;}
            }catch{room.saveError='The saved video could not be restored. Choose media after checking Plex access.';}
          }
        }else this.apply(this.watch.rooms.get(id),record);
        return id;
      })();
      this.singleOpening.finally(()=>{this.singleOpening=undefined;}).catch(()=>{});
    }
    return this.singleOpening;
  }
  async resetSingle(id,actor,revision,current) {
    const record=this.store.get(id), room=this.watch.rooms.get(id);
    if(!this.watch.hub.isAdmin(actor)&&record.creatorId!==actor.userId)throw failure('Room creator rights required to reset',403);
    if(revision!==record.revision)throw failure('Room changed; refresh before resetting');
    if(!await current())throw failure('Room access changed',403);
    if(room&&(room.mediaTransition||room.queueEditing))throw failure('Wait for the current queue or media operation before resetting');
    if(room)room.mediaTransition=true;
    try{
    if(room){this.freeze(room);this.watch.revokeConsent(room);await room.saving;}
    this.registry.transaction(()=>{
      this.store.db.prepare('DELETE FROM watch_queue_entries WHERE roomId=?').run(id);
      this.store.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=?').run(id);
      for(const provider of ['discord','plex'])for(const subject of this.watch.hub.config.roomAdministrators?.[provider]||[]){const host=this.registry.identity(provider,subject)?.userId;if(host&&host!==record.creatorId)this.store.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id,host);}
      this.store.db.prepare("UPDATE watch_rooms SET bookmark=NULL,checkpointRevision=checkpointRevision+1,queueRevision=queueRevision+1,revision=revision+1,autoplay=1,autoQueue=NULL,permissions=?,name=?,visibility='public' WHERE id=?")
        .run(JSON.stringify(this.store.defaults),this.watch.hub.config.singleRoomName||'Room',id);
    });
    await this.registry.flush();
    if(room){this.watch.dropMedia(room,'room-reset');room.media=null;room.position=0;room.mediaVersion=require('node:crypto').randomUUID();room.initialGate=false;room.s.state.seekable=false;room.s.state.picture={...require('../shared/engine').DEFAULT};room.profiles={};}
    if(room)this.apply(room,this.store.get(id));
    return this.summary(id,actor);
    }finally{if(room)room.mediaTransition=false;}
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
