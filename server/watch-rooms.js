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
    this.limits = require('./room-limits').limits(watch.hub.config);
    this.people = new (require('./room-presence').RoomPresence)(this.limits.maxPeople);
    this.recoveries = new Map();
    this.store = new RoomStore(registry, {
      limits:this.limits,
      defaults: watch.hub.config.roomPermissions,
      isAdmin: id => watch.hub.isAdmin({ userId:id, discordId:registry.identities(id).find(identity => identity.provider === 'discord')?.subject })
    });
    this.queue = new RoomQueue(registry, this.store);
    registry.transaction(() => {
      for (const {roomId} of this.store.db.prepare("SELECT roomId FROM watch_queue_entries WHERE state='history' GROUP BY roomId HAVING COUNT(*)>?").all(this.limits.maxHistory)) {
        this.queue.pruneHistory(roomId);
        this.store.db.prepare('UPDATE watch_rooms SET queueRevision=queueRevision+1 WHERE id=?').run(roomId);
      }
    });
    for (const {id} of this.store.db.prepare('SELECT id FROM watch_rooms WHERE liveState IS NOT NULL').all()) {
      const record = this.store.get(id);
      this.recoveries.set(id, { ...record.liveState, until:Infinity });
    }
    this.timer = setInterval(() => {
      for (const room of watch.rooms.values()) if (!room.saving && !room.mediaTransition && !room.reconnecting) void this.save(room).catch(() => {});
      void this.track(this.maintain()).catch(() => {});
    }, 5000);
    this.timer.unref();
  }
  track(promise) {
    this.pending.add(promise);
    promise.then(() => this.pending.delete(promise), () => this.pending.delete(promise));
    return promise;
  }
  startRecovery(now = Date.now()) {
    this.readyAt = now;
    for (const recovery of this.recoveries.values()) {
      recovery.until = now + this.limits.recoverySeconds * 1000;
      for (const id of recovery.viewers) this.people.reserve(this.store.account(id),recovery.until);
    }
  }
  reason(record) {
    if (this.watch.hub.config.singleRoom || record.keepEmpty) return 'Kept when empty';
    if (record.bookmark && record.bookmark.position < record.bookmark.duration * .9) return 'Video in progress';
    if (this.queue.pending(record.id).length) return 'Queue pending';
    if (record.autoQueue.mode === 'following' || record.autoQueue.mode === 'random' || record.autoQueue.next) return 'Auto-queue enabled';
    return null;
  }
  checkCapacity(room, userId) {
    const now = Date.now(), members = new Set([...room.viewers.values()].map(v => this.store.account(v.userId)));
    for (const saved of room.disconnectedViewers.values()) if (saved.expires > now) members.add(this.store.account(saved.userId));
    if (room.recovery?.until > now) for (const id of room.recovery.viewers) members.add(this.store.account(id));
    const record = this.store.get(room.s.roomId), maximum = Math.min(record.maxMembers || this.limits.maxMembers,this.limits.maxMembers);
    if (!members.has(userId) && members.size >= maximum) throw failure('Room full; try again when someone leaves',429);
  }
  async recover(id, actor, current) {
    const recovery = this.recoveries.get(id);
    if (!recovery || recovery.until <= Date.now()) return;
    const record = this.store.get(id);
    if (record.visibility === 'private' && !Policy.assigned(record,actor.userId) && !this.watch.hub.isAdmin(actor)) return;
    await this.eligible(actor,current);
    if (!this.opening.has(id)) {
      const opening = (async () => {
        let media;
        try {
          const saved = record.bookmark;
          if (saved) {
            if (await this.identify(saved) !== saved.serverId) throw failure('The saved Plex server changed',409);
            const plex = this.watch.hub.plexFor ? await this.watch.hub.plexFor(actor) : this.watch.plex;
            media = saved.mediaId === 'demo' ? this.watch.demoMedia && {...this.watch.demoMedia,id:'demo',resources:new Map()} : await this.savedSource(plex,saved);
            if (!media || Math.abs(media.duration - saved.duration) > .5 || media.source?.type && media.source.type !== saved.type) throw failure('The saved video changed or is unavailable',409);
            media.roomServerId = saved.serverId;
          }
          await this.eligible(actor,current);
          if (this.recoveries.get(id) !== recovery || recovery.until <= Date.now()) return;
          const latest = this.store.get(id);
          if (latest.checkpointRevision !== record.checkpointRevision || latest.revision !== record.revision) throw failure('Room changed during recovery',409);
          this.watch.create(actor,latest.visibility,latest);
          const room = this.watch.rooms.get(id);
          room.media = media || null; media = undefined; room.position = saved?.position || 0;
          room.s.state.seekable = !!room.media; room.manualPaused = !recovery.wasPlaying; room.recovery = recovery;
          room.s.hostId = record.creatorId; room.s.hostName = this.registry.canonical(record.creatorId)?.name || 'Room leader';
          room.initialGate = !!room.media; if (room.media) this.watch.beginReadiness(room);
        } finally { if (media) await this.watch.plex.stop(media); }
      })();
      this.opening.set(id,opening);
      opening.finally(() => this.opening.delete(id)).catch(() => {});
    }
    await this.opening.get(id);
  }
  recoveryState(room) {
    if (!room.recovery) return;
    const present = new Set([...room.viewers.values()].map(v=>this.store.account(v.userId)));
    return { until:room.recovery.until, missing:new Set(room.recovery.viewers.map(id=>this.store.account(id)).filter(id=>!present.has(id))).size };
  }
  async maybeRecover(room) {
    const recovery = room.recovery;
    if (!recovery || room.recovering || recovery.until <= Date.now() || !recovery.wasPlaying || !room.media) return;
    if (this.recoveryState(room).missing || [...room.viewers.values()].some(v=>!v.ready || v.version !== room.mediaVersion)) return;
    const controller = [...room.viewers.values()].find(v => (isHost(room.s,v.actor) || this.watch.hub.canRoom(room.s,v.actor,'continueWithoutHost')) && this.watch.hub.canRoom(room.s,v.actor,'playPause'));
    if (!controller) return;
    room.recovering = true;
    try {
      if (controller.alive && !await controller.alive() || !await this.watch.canView(room,controller.actor) || room.recovery !== recovery || recovery.until <= Date.now()) return;
      if (this.recoveryState(room).missing || [...room.viewers.values()].some(v=>!v.ready || v.version !== room.mediaVersion)) return;
      await this.watch.hub.dispatch({...controller.actor,watchViewerId:[...room.viewers.entries()].find(([,v])=>v===controller)[0]}, {roomId:room.s.roomId,action:'media.play'});
    } finally { room.recovering = false; }
  }
  finishRecovery(room) {
    room.recovery = undefined; this.recoveries.delete(room.s.roomId);
  }
  async maintain(now = Date.now()) {
    if (this.stopped || this.maintaining || !this.readyAt) return;
    this.maintaining = true;
    try {
      for (const [id,recovery] of this.recoveries) if (recovery.until <= now) {
        this.recoveries.delete(id);
        const room = this.watch.rooms.get(id);
        if (room) { room.recovery = undefined; this.freeze(room); if (!room.viewers.size) await this.watch.remove(id); else await this.save(room); }
        else { this.store.db.prepare('UPDATE watch_rooms SET liveState=NULL WHERE id=?').run(id); await this.registry.flush(); await this.deleteEmpty(id); }
      }
      if (!this.limits.inactiveDays) return;
      const cutoff = now - this.limits.inactiveDays * 86400000;
      let count = this.store.db.prepare('SELECT COUNT(*) AS n FROM watch_rooms').get().n;
      for (const {id} of this.store.db.prepare('SELECT id FROM watch_rooms WHERE lastAccessedAt<=? ORDER BY lastAccessedAt,id').all(cutoff)) {
        if (count <= this.limits.minRetained) break;
        if (this.watch.rooms.has(id) || this.opening.has(id) || this.closing.has(id) || this.recoveries.has(id) || this.watch.hub.config.singleRoom && id === this.registry.meta('singleRoomId')) continue;
        await this.store.destroy(id); count--;
      }
    } finally { this.maintaining = false; }
  }
  async deleteEmpty(id) {
    if (this.stopped || this.watch.rooms.has(id) || this.recoveries.has(id) || this.opening.has(id)) return;
    const record = this.store.get(id);
    if (!this.reason(record)) await this.store.destroy(id);
  }
  async eligible(actor, current = async () => true) {
    const hub = this.watch.hub;
    if (this.stopped || actor.surface !== 'web' || actor.guildId !== hub.config.guildId || (hub.config.channels?.length && !hub.config.channels.includes(actor.channelId)) ||
        !await current() || !canWatch(hub.access, actor.userId, actor) && !await (hub.access?.refreshWatch || hub.access?.refresh)?.(actor.userId,actor)) {
      throw failure('Room access expired; sign in again', 403);
    }
    await hub.refreshAdmin?.(actor);
    if (this.stopped || !await current()) throw failure('Room connection changed; retry manually', 403);
  }
  async claimHosts(userId) {
    for (const id of await this.store.claimHosts(userId)) {
      const room = this.watch.rooms.get(id);
      if (room) { this.apply(room,this.store.get(id)); room.revision++; }
    }
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
    if (new Set([...this.watch.rooms.keys(), ...this.recoveries.keys(), ...this.opening.keys()]).size + this.creating - (replacing ? 1 : 0) >= this.limits.maxOpen) throw failure('Open room limit reached; close an active room first', 429);
  }
  async create(actor, options, current) {
    if(this.watch.hub.config.singleRoom)throw failure('Room creation is disabled in single-room mode',403);
    await this.eligible(actor, current); this.reserve(); this.creating++;
    try {
      let creation = options, initialCorpus;
      if (options?.autoQueue && ['following','random'].includes(options.autoQueue.mode)) {
        const config = options.autoQueue, scope = config.scope;
        if (!scope?.id || !['show','library','collection'].includes(scope.type)) throw failure('Choose an auto-queue source');
        const plex = this.watch.hub.plexFor ? await this.watch.hub.plexFor(actor) : this.watch.plex;
        const items = await plex.queueItems({...scope,includeSpecials:!!config.includeSpecials});
        const serverId = await this.identify(scope);
        if (this.watch.hub.plexFor && (await this.watch.hub.plexFor(actor)).principal !== plex.principal) throw failure('Plex access changed',403);
        creation = {...options,autoQueue:{...config,scope:{type:scope.type,id:scope.id,serverId}}};
        initialCorpus = items.map(item => this.watch.queueItem(item, serverId));
        await this.eligible(actor,current);
      } else if (options?.autoQueue && options.autoQueue.mode === 'continue') {
        creation = {...options,autoQueue:{mode:'continue',scope:null,includeSpecials:false}};
      }
      let record = await this.store.create(actor.userId, creation);
      if (initialCorpus?.length) {
        await this.queue.generate(record.id, actor.userId, initialCorpus);
        await this.watch.verifyAutoNext?.(record.id, actor, initialCorpus);
        record = this.store.get(record.id);
      }
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
  async savedSource(plex,saved) {
    try { return await plex.prepare(saved.mediaId,'direct',false,undefined,undefined,{sourceOnly:true}); }
    catch (error) {
      if (error.code !== 'MEDIA_UNAVAILABLE') throw error;
      return {id:saved.mediaId,title:saved.title,duration:saved.duration,source:{type:saved.type},kind:'plex',resources:new Map(),unavailable:true,playbackError:error.message};
    }
  }
  async reopen(id, actor, current) {
    if(this.watch.hub.config.singleRoom){const selected=await this.ensureSingle(actor,current);if(id!==selected)throw failure('Only the configured shared room is available',403);return selected;}
    await this.eligible(actor, current);
    await this.closing.get(id);
    if (this.recoveries.has(id)) await this.recover(id,actor,current);
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
              media = await this.savedSource(plex,saved);
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
      active:this.recoveries.has(record.id) || !!this.watch.rooms.get(record.id) && !this.watch.rooms.get(record.id).reconnecting,
      title:record.bookmark?.title, position:record.bookmark?.position || 0, updatedAt:record.updatedAt,
      createdAt:record.createdAt,lastAccessedAt:record.lastAccessedAt,retentionReason:this.reason(record),
      recovering:this.recoveries.has(record.id),members:new Set([...(this.watch.rooms.get(record.id)?.viewers.values() || [])].map(v=>v.userId)).size,maxMembers:Math.min(record.maxMembers || this.limits.maxMembers,this.limits.maxMembers) })) };
  }
  participants(id) {
    const record = this.store.get(id), room = this.watch.rooms.get(id);
    const now=Date.now();
    const activeAndRecovering=[...(room?.viewers.values() || []),...[...(room?.disconnectedViewers.values() || [])].filter(viewer=>viewer.expires>now)];
    return [...new Set([record.creatorId,...record.hosts,...activeAndRecovering.map(viewer => viewer.userId)])]
      .map(userId => ({id:userId,name:this.registry.canonical(userId)?.name || 'Room member',role:Policy.role(record,userId),
        explicitHost:record.hosts.includes(userId),present:[...(room?.viewers.values() || [])].some(viewer => viewer.userId === userId)}));
  }
  summary(id, actor) {
    const record = this.store.get(id), room = this.watch.rooms.get(id);
    const person = userId => ({ id:userId, name:this.registry.canonical(userId)?.name || 'Room member' });
    const candidates = [...new Set([record.creatorId, ...record.hosts, ...[...(room?.viewers.values() || [])].map(viewer => viewer.userId)])];
    return { id, createdAt:record.createdAt,lastAccessedAt:record.lastAccessedAt,keepEmpty:record.keepEmpty,
      maxMembers:record.maxMembers,serverMaxMembers:this.limits.maxMembers,retentionReason:this.reason(record),singleRoom:!!this.watch.hub.config.singleRoom, name:record.name, visibility:record.visibility, revision:record.revision, active:!!room && !room.reconnecting, hasLiveRoom:!!room, epoch:room?.s.epoch, hasBookmark:!!record.bookmark,
      creator:person(record.creatorId), hosts:record.hosts.map(person), candidates:candidates.map(person), viewers:[...new Set([...(room?.viewers.values() || [])].map(viewer => viewer.userId))].map(person),
      actorId:actor.userId,allHosts:!!record.permissions.allHosts,canSetAllHosts:record.creatorId===actor.userId,pendingHosts:this.store.pendingHosts(id),
      role:Policy.role(record, actor.userId), permissions:record.permissions, autoplay:{enabled:record.autoplay}, queueSummary:this.queue.summary(id), mediaId:record.bookmark?.mediaId,
      capabilities:Object.fromEntries([...Policy.CAPABILITIES, ...Policy.CREATOR_ONLY].map(key =>
        [key, this.watch.hub.config.singleRoom&&key==='transferCreator' ? false : this.watch.hub.config.singleRoom&&key==='deleteRoom' ? this.watch.hub.isAdmin(actor)||record.creatorId===actor.userId : this.watch.hub.isAdmin(actor) || Policy.allowed(record, actor.userId, key)])) };
  }
  async edit(id, actor, revision, change, current) {
    await this.eligible(actor, current);
    if(this.watch.hub.config.singleRoom){
      if(id!==this.registry.meta('singleRoomId'))throw failure('Only the configured shared room is available',403);
      if(change?.action==='rename')throw failure('The shared room is always named Room',403);
      if(change?.action==='keepEmpty')throw failure('The shared room is always kept',403);
      if(change?.action==='creator.transfer')throw failure('Single-room leadership is fixed by discord.owner_id',403);
      if(change?.action==='delete')throw failure('Use Reset room in single-room mode',403);
      if(change?.action==='reset')return this.resetSingle(id,actor,revision,current);
    }
    const room = this.watch.rooms.get(id);
    if (change?.action === 'auto.reset' && (room?.mediaTransition || room?.queueEditing)) throw failure('Wait for the current queue operation',409);
    if (change?.action === 'bookmark.clear' && room) throw failure('Close the room before clearing its saved video');
    await this.metadata(id,actor);
    if (!await current()) throw failure('Room connection changed', 403);
    if (change?.action === 'host.pending.add') {
      if (!this.watch.hub.isAdmin(actor) && !Policy.allowed(this.store.get(id),actor.userId,'addHosts')) throw failure('Add hosts permission required',403);
      const candidate = await this.watch.hub.directory.candidate(change.provider,change.subject);
      await this.eligible(actor,current); await this.metadata(id,actor);
      change = {...change,name:candidate.name};
    }
    const record = await this.store.edit(id, actor.userId, revision, change);
    if (change.action === 'delete') {
      if (room) this.watch.remove(id, false);
      return { deleted:true };
    }
    if (room && this.watch.rooms.get(id) === room) {
      this.apply(room, record); room.revision++;
      if (change.action === 'autoplay') this.watch.cancelAutoplay(room);
      else if (!['rename','keepEmpty','maxMembers','auto.reset'].includes(change.action)) {
        this.watch.invalidateControls(room); this.watch.refresh(room); await this.elect(room);
      }
    }
    return this.summary(id, actor);
  }
  async metadata(id, actor) {
    const record = this.store.get(id);
    if (Policy.assigned(record,actor.userId) || this.watch.hub.isAdmin(actor)) return;
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
    if(!this.singleOpening){
      this.singleOpening=(async()=>{
        const config=this.watch.hub.config;
        const owner=await this.watch.hub.singleRoomLeader();
        await this.eligible(actor);
        let id=this.registry.meta('singleRoomId');
        let record;
        if(id){try{record=this.store.get(id);}catch(error){if(error.status!==404)throw error;}}
        if(!record){record=await this.store.create(owner.id,{name:'Room',visibility:'public'});id=record.id;this.registry.meta('singleRoomId',id);}
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
        this.store.db.prepare("UPDATE watch_rooms SET name='Room',keepEmpty=1 WHERE id=?").run(id);
        await this.registry.flush();record=this.store.get(id);
        if(this.recoveries.has(id) && !this.watch.rooms.has(id)) await this.recover(id,actor);
        for(const other of [...this.watch.rooms.keys()])if(other!==id)await this.watch.remove(other);
        if(this.watch.rooms.get(id)?.reconnecting){await this.watch.remove(id);record=this.store.get(id);}
        if(!this.watch.rooms.has(id)){
          this.watch.create(actor,record.visibility,record);
          const room=this.watch.rooms.get(id);room.s.hostId=owner.id;room.s.hostName=owner.name;room.recovery=this.recoveries.get(id);
          if(record.bookmark){
            const saved=record.bookmark;
            let media, adopted=false;
            try{
              if(await this.identify(saved)===saved.serverId){
                const plex=this.watch.hub.plexFor?await this.watch.hub.plexFor(actor):this.watch.plex;
                media=saved.mediaId==='demo'?this.watch.demoMedia&&{...this.watch.demoMedia,id:'demo',resources:new Map()}:await this.savedSource(plex,saved);
                if(!media || Math.abs(media.duration - saved.duration) > .5 || (media.source?.type && media.source.type !== saved.type)){
                  room.saveError='The saved video could not be restored. Choose media after checking Plex access.';
                } else {
                  room.media=media;room.position=Math.min(saved.position,media.duration);media.roomServerId=saved.serverId;room.s.state.seekable=true;
                  room.s.state.paused=true;room.manualPaused=true;room.initialGate=true;this.watch.beginReadiness(room);
                  adopted=true;
                }
              } else {
                room.saveError='The saved video could not be restored. Choose media after checking Plex access.';
              }
            }catch{room.saveError='The saved video could not be restored. Choose media after checking Plex access.';}
            finally{if(media&&!adopted)await this.watch.plex.stop(media);}
          }
        }else this.apply(this.watch.rooms.get(id),record);
        return id;
      })();
      this.singleOpening.finally(()=>{this.singleOpening=undefined;}).catch(()=>{});
    }
    const opened=await this.singleOpening;
    await this.eligible(actor,current);
    return opened;
  }
  async resetSingle(id,actor,revision,current) {
    const record=this.store.get(id), room=this.watch.rooms.get(id);
    if(!this.watch.hub.isAdmin(actor)&&record.creatorId!==actor.userId)throw failure('Room creator rights required to reset',403);
    if(revision!==record.revision)throw failure('Room changed; refresh before resetting');
    if(!await current())throw failure('Room access changed',403);
    if(room&&(room.mediaTransition||room.queueEditing))throw failure('Wait for the current queue or media operation before resetting');
    if(room)room.mediaTransition=true;
    try{
      if(room){this.freeze(room);this.watch.invalidateControls(room);await room.saving?.catch(()=>{});}
      const hosts=[...new Set([
        ...(this.watch.hub.config.roomAdministrators?.discord||[]).map(subject=>this.registry.resolve('discord',subject,'Assigned account',false).id),
        ...(this.watch.hub.config.roomAdministrators?.plex||[]).map(subject=>this.registry.resolve('plex',subject,'Assigned account',false).id)
      ])].filter(h=>h!==record.creatorId);
      this.registry.transaction(()=>{
        this.store.db.prepare('DELETE FROM watch_room_progress WHERE roomId=?').run(id);
        this.store.db.prepare('DELETE FROM watch_queue_entries WHERE roomId=?').run(id);
        this.store.db.prepare('DELETE FROM watch_room_hosts WHERE roomId=?').run(id);
        this.store.db.prepare('DELETE FROM watch_room_host_grants WHERE roomId=?').run(id);
        for(const host of hosts)this.store.db.prepare('INSERT OR IGNORE INTO watch_room_hosts VALUES(?,?)').run(id,host);
        this.registry.meta('singleRoomDefaultHosts',JSON.stringify(hosts));
        this.store.db.prepare("UPDATE watch_rooms SET bookmark=NULL,checkpointRevision=checkpointRevision+1,queueRevision=queueRevision+1,revision=revision+1,autoplay=1,autoQueue=NULL,liveState=NULL,maxMembers=NULL,permissions=?,name=?,visibility='public' WHERE id=?")
          .run(JSON.stringify(this.store.defaults),'Room',id);
      });
      await this.registry.flush();
      this.recoveries.delete(id);
      if(room){
        this.finishRecovery(room);
        const old=room.media;
        this.watch.dropMedia(room,'room-reset');
        room.media=null;
        void this.watch.plex.stop(old);
        room.position=0;
        room.mediaVersion=require('node:crypto').randomUUID();
        room.initialGate=false;
        room.s.state.seekable=false;
        room.s.state.picture={...require('../shared/engine').DEFAULT};
        room.profiles={};
        room.readinessVersion=undefined;
        room.readinessStartAt=undefined;
        room.readinessTimedOut=undefined;
        room.endedVersion=undefined;
        room.endingOffer=undefined;
        room.endingMeta=undefined;
        room.autoplayError=undefined;
        room.autoQueueError=undefined;
        room.saveError=undefined;
        this.apply(room,this.store.get(id));
        this.watch.refresh(room);
        await this.elect(room);
      }
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
    const wasPlaying = !room.s.state.paused; this.freeze(room); this.watch.invalidateControls(room);
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
  save(room, { closing = false } = {}) {
    if (!room.saved) return Promise.resolve();
    if (room.transitionCommit) return this.track(room.transitionCommit.then(() => this.save(room,{closing})));
    const media = room.media;
    const bookmark = media ? { serverId:media.roomServerId, mediaId:media.id, type:media.source?.type || 'movie',
      title:media.title, duration:media.duration, position:this.watch.position(room) } : null;
    const viewers = [...new Set([...room.viewers.values(), ...[...room.disconnectedViewers.values()].filter(v=>v.expires>Date.now())].map(v => this.store.account(v.userId)))];
    const live = closing ? null : room.recovery || { viewers, wasPlaying:!room.s.state.paused || room.initialGate && !room.manualPaused || room.reconnecting && !!room.disconnectedWasPlaying };
    const previous = room.saving ? room.saving.catch(() => {}) : Promise.resolve();
    const saving = previous.then(async () => {
      const record = this.store.get(room.s.roomId);
      this.store.db.prepare('UPDATE watch_rooms SET liveState=? WHERE id=?').run(live ? JSON.stringify({viewers:live.viewers,wasPlaying:live.wasPlaying}) : null,record.id);
      if (room.viewers.size) this.store.touch(record.id);
      this.apply(room, await this.store.checkpoint(record.id, record.checkpointRevision, bookmark));
      if (bookmark) this.queue.checkpoint(record.id, bookmark.position);
      room.saveError = undefined;
    }).catch(error => { room.saveError = 'Room progress could not be saved. Check server storage.'; this.freeze(room); throw error; });
    room.saving = saving;
    const clear = () => { if (room.saving === saving) room.saving = undefined; };
    saving.then(clear, clear);
    return this.track(saving);
  }
  async close() {
    this.stopped = true; clearInterval(this.timer);
    await Promise.allSettled([...this.opening.values(), ...this.pending]);
  }
}
module.exports = { WatchRooms };
