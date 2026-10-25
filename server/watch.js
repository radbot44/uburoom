// @ts-check
'use strict';
/** @typedef {import('./types').Room} Room */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').EngineCommand} EngineCommand */

const { randomUUID } = require('node:crypto');
const Engine = require('../shared/engine');
const { eligible, viewEligible, isHost, sameVoice, canWatch } = require('./core');
const { PlaybackError } = require('./av1');
const { PlaybackTracking } = require('./playback-tracking');
const { PlexReporting } = require('./plex-reporting');
const Tracks = require('./media-tracks');
const SubtitleResources = require('./subtitle-resources');
const { WatchRooms } = require('./watch-rooms');
const RoomPolicy = require('./room-policy');
const { observePlaybackEnd, clearPlaybackEnd } = require('./playback-end');
const SyncQuality = require('../web/sync-quality');
const RECONNECT_GRACE_MS = 60000;
// Multiple viewing tabs share a startup/seek lead alongside buffering.
// A sole tab retains readiness and clock tracking without coordination delays.
// Late readiness retains a short delivery margin for a 300+ ms RTT.
const INITIAL_START_LEAD_MS = 1750;
const READY_START_MARGIN_MS = 400;
function syncQualityParticipants(room,participants,now=Date.now()) {
  for (const person of participants || []) {
    const sessions=[];
    for (const [viewerId,viewer] of room.viewers) if(viewer.userId===person.id) {
      sessions.push({viewerId,viewer,disconnected:false,joinedAt:viewer.joinedAt||0});
    }
    for (const [viewerId,viewer] of room.disconnectedViewers||[]) if(viewer.userId===person.id&&viewer.mediaVersion===room.mediaVersion&&viewer.expires>now) {
      sessions.push({viewerId,viewer,disconnected:true,joinedAt:viewer.joinedAt||0});
    }
    sessions.sort((a,b)=>a.joinedAt-b.joinedAt||a.viewerId.localeCompare(b.viewerId));
    const visible=sessions.map(({viewerId,viewer,disconnected})=>{
      const measurement=viewer.syncQuality;
      const age=measurement&&Number.isFinite(measurement.updatedAt)?Math.max(0,now-measurement.updatedAt):Infinity;
      const contextMatches=measurement?.mediaVersion===room.mediaVersion&&measurement?.streamVersion===viewer.streamVersion;
      let status=disconnected?'disconnected':!measurement?'unknown':measurement.status;
      if(!disconnected&&viewer.watchSocket&&viewer.watchSocket.readyState!==1)status='disconnected';
      else if(!disconnected&&measurement&&(!contextMatches||age>15000)&&status!=='error')status='stale';
      const lastKnownScore=Number.isFinite(measurement?.lastKnownScore)?Math.max(0,Math.min(1,measurement.lastKnownScore)):
        Number.isFinite(measurement?.score)?Math.max(0,Math.min(1,measurement.score)):1;
      const score=Number.isFinite(measurement?.score)?Math.max(0,Math.min(1,measurement.score)):lastKnownScore;
      const rememberedLevel=measurement?.lastKnownLevel||SyncQuality.level(lastKnownScore);
      let confidence=['confident','reduced','provisional'].includes(measurement?.confidence)?measurement.confidence:'provisional';
      const evidenceAge=Number.isFinite(measurement?.measuredAt)?Math.max(0,now-measurement.measuredAt):
        Number.isFinite(measurement?.measurementFreshnessMs)?age+measurement.measurementFreshnessMs:Infinity;
      const allowedAge=status==='paused'?SyncQuality.PAUSED_EVIDENCE_MS:SyncQuality.RECENT_EVIDENCE_MS;
      if(disconnected||status==='disconnected'||status==='stale'||age>15000||evidenceAge>allowedAge||
        ['starting','error','unknown'].includes(status))confidence=confidence==='provisional'?'provisional':'reduced';
      return {status,score,level:SyncQuality.level(score,rememberedLevel),confidence,
        lastKnownScore,lastKnownLevel:rememberedLevel,lastKnownAt:measurement?.lastKnownAt,
        updatedAt:measurement?.updatedAt,measurementFreshnessMs:evidenceAge,
        reason:status==='stale'?(contextMatches?'measurement-expired':'stream-changed'):measurement?.reason,
        current:!disconnected&&contextMatches&&age<=15000&&['playing','buffering','paused','seeking','starting','error'].includes(status)};
    });
    // Scan once and compare the displayed-session priority in place. Sessions
    // stay in `visible` for the participant tooltip regardless of selection.
    let selected,selectedPriority=Infinity;
    for(const session of visible) {
      const active=session.current&&['playing','buffering'].includes(session.status);
      const connected=session.current&&session.status!=='disconnected'&&session.status!=='stale';
      const priority=active?(session.confidence==='confident'?0:1):connected?2:Number.isFinite(session.lastKnownAt)?3:4;
      const better=priority<selectedPriority||priority===selectedPriority&&(
        priority<3&&session.score<selected.score||priority===3&&session.lastKnownAt>selected.lastKnownAt);
      if(!selected||better){selected=session;selectedPriority=priority;}
    }
    const score=selected&&Number.isFinite(selected.score)?selected.score:1;
    const confidence=selected?.confidence||'provisional';
    const reason=visible.length===0?'no-sessions':selected?.reason||
      (confidence==='provisional'?'awaiting-measurements':confidence==='reduced'?'measurement-interrupted':undefined);
    person.syncQuality={status:confidence==='confident'?'known':'unknown',score,level:SyncQuality.level(score,selected?.level||selected?.lastKnownLevel||'excellent'),
      confidence,reason,lastKnownScore:score,lastKnownLevel:SyncQuality.level(score,selected?.level||selected?.lastKnownLevel||'excellent'),
      measurementFreshnessMs:selected?.measurementFreshnessMs,sessions:visible};
  }
  return participants;
}

class Watch {
  constructor(hub, plex, demoMedia, registry, plexAuth) {
    this.tracking = new PlaybackTracking(registry); this.hub = hub; this.plex = plex; this.demoMedia = demoMedia; this.rooms = new Map();
    this.reporting = new PlexReporting({ config: hub?.config, hub, plexAuth, registry });
    this.roomState = registry ? new WatchRooms(this, registry) : undefined;
    hub.savedQueueExecute = (id, command, actor, permitted) => this.queueCommand(id,command,actor,permitted);
    this.autoplayDelayMs = 10000;
  }
  create(actor, visibility = 'public', saved) {
    if (!['public','private'].includes(visibility)) throw new Error('Invalid room visibility');
    if (actor.surface !== 'web' || !canWatch(this.hub.access,actor.userId,actor) || actor.guildId !== this.hub.config.guildId || (this.hub.config.channels?.length && !this.hub.config.channels.includes(actor.channelId))) throw new Error('Only authenticated eligible users can create a viewing room');
    if (this.rooms.size >= require('./room-limits').limits(this.hub.config).maxOpen && !this.roomState?.recoveries.has(saved?.id)) throw new Error('Close an existing viewing room first');
    const socket = { readyState: 1 }, id = saved?.id || randomUUID();
    const s = { roomId: id, epoch: randomUUID(), alias: this.rooms.size ? 'plex.' + id.slice(0, 8) : 'plex', kind: 'watch',
      ownerId: actor.userId, ownerName: actor.name, hostId: actor.userId, hostName: actor.name, socket, visibility, reachable: true, lastSeen: Date.now(),
      controls: { ...Engine.CONTROLS }, state: { picture: { ...Engine.DEFAULT }, paused: true, muted: false, volume: 30, seekable: false, profileSlots: [] } };
    const room = { s, media: null, mediaVersion: randomUUID(), revision: 0, position: 0, changedAt: Date.now(), viewers: new Map(), disconnectedViewers: new Map(), profiles: {}, lastActivity: Date.now(),
      initialGate: false, manualPaused: false, initialViewers: new Set(), hadViewers: false };
    s.execute = (command, actor, permitted) => this.execute(room, command, actor, permitted);
    s.viewers = room.viewers;
    if (saved) this.roomState.apply(room, saved);
    this.rooms.set(id, room); this.hub.rooms.set(id, s);
    this.hub?.config?.logger?.info('Room', `Room created "${s.alias || id}" (${id}) by ${actor.name || actor.userId}`);
    return id;
  }
  position(room, now = Date.now()) {
    if (room.pauseAt) now = Math.min(now, room.pauseAt);
    const elapsed=room.startAt?Math.max(0,now-Math.max(room.changedAt,room.startAt)):now-room.changedAt;
    return Math.min(room.media?.duration || 0, Math.max(0, room.position + (room.s.state.paused ? 0 : elapsed / 1000)));
  }
  controlLead(room) {
    if (room.viewers.size <= 1) return 0;
    const now = performance.now();
    let lead = READY_START_MARGIN_MS;
    for (const viewer of room.viewers.values()) {
      const samples = (viewer.watchSocket?.watchRtts || []).filter(sample => now - sample.at <= 30000 && now >= sample.at).map(sample => sample.ms).sort((a, b) => a - b);
      if (samples.length) lead = Math.max(lead, samples[Math.ceil(samples.length * .95) - 1] + 100);
    }
    return Math.min(1000, Math.ceil(lead));
  }
  beginReadiness(room, now = Date.now(), waitMs = 10000) {
    room.readinessId = randomUUID();
    room.readinessSince = performance.now();
    room.readinessDeadline = room.readinessSince + waitMs;
    room.readinessTimedOut = false;
    room.readinessStartAt = now + (room.viewers.size > 1 ? INITIAL_START_LEAD_MS : 0);
  }
  settle(room, now = Date.now()) {
    if (room.viewers.size === 1) {
      if (room.startAt > now) { room.startAt = now; room.changedAt = now; room.revision++; }
      if (room.pauseAt > now) room.pauseAt = now;
    }
    if (room.pauseAt && now >= room.pauseAt) {
      room.position = this.position(room, room.pauseAt); room.changedAt = room.pauseAt;
      room.pauseAt = undefined; room.s.state.paused = true; room.revision++;
    }
    if (!room.recovery && room.initialGate && !room.manualPaused && !room.readinessTimedOut && performance.now() >= room.readinessDeadline) {
      room.readinessTimedOut = true; room.readinessStartAt = undefined; room.revision++;
    }
  }
  invalidateControls(room) {
    this.cancelAutoplay(room);
    room.s.epoch = randomUUID(); room.revision++;
  }
  dropMedia(room, reason = 'media-changed') {
    this.cancelAutoplay(room); clearPlaybackEnd(room);
    room.disconnectedViewers.clear();
    for (const viewer of room.viewers.values()) {
      this.tracking.end(viewer, reason); void this.plex.stop(viewer.media); void this.reporting?.end(viewer, reason); viewer.media = undefined; viewer.ready = false;
      if (reason === 'media-changed') {
        viewer.compatible = false; viewer.fallback = undefined;
        viewer.subtitleOffset=0;
        if (viewer.trackChoice) { viewer.trackChoice.audioId='auto'; if (viewer.trackChoice.subtitleId!=='off') viewer.trackChoice.subtitleId='auto'; }
      }
    }
  }
  async prepareQuality(room,viewer,plex,source,requested,compatible,fallback,authorized) {
    if (source.unavailable) source = await plex.prepare(source.id,'direct',false,undefined,undefined,{sourceOnly:true});
    const {candidates}=require('./quality-options');
    const choices=this.plex.qualities?.(source) || Engine.QUALITIES;
    if(!choices.length)throw new PlaybackError('No configured quality is available for this video. Ask the owner to offer a lower quality or Original.');
    const options=candidates(choices,requested,source), quality=options[0]?.id;
    if(!quality)throw new PlaybackError('No available quality is at or below your preferred setting. Your preference has been kept.');
    const prepare=(value,sharedOnly=false)=>this.prepareOutput(room,viewer,plex,source,value,compatible,fallback,
      {...viewer.trackChoice,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.roomId,room.mediaVersion],shareWaitMs:8000,authorized,sharedOnly});
    let media;
    try {media=await prepare(quality);}
    catch(error) {
      if(!error.conversionCapacity)throw error;
      for(const option of options.slice(1)) {
        try {media=await prepare(option.id,true);break;}
        catch(next) {if(!next.conversionCapacity)throw next;}
      }
      if(!media)throw error;
    }
    media.qualityNotice=media.quality!==Engine.qualityId(requested)?'Your requested quality is unavailable. Playing '+(choices.find(q=>q.id===media.quality)?.label || media.quality)+'. You can try your preferred quality again later.':'';
    return media;
  }
  prepareOutput(room,viewer,plex,source,quality,compatible,fallback,choices) {
    return plex.prepare(source.id,quality,compatible,source,fallback,{...choices,
      directPlan:()=>this.delivery?.hlsPlan(plex,viewer,room,choices.authorized)});
  }
  async prepareViewer(room, actor, viewerId) {
    const viewer = room.viewers.get(viewerId), version = room.mediaVersion;
    if (!viewer || viewer.userId !== actor.userId) return;
    const plex=this.hub.plexFor?await this.hub.plexFor(actor):this.plex;
    if(room.mediaVersion!==version || room.viewers.get(viewerId)!==viewer)return;
    const queueRevision = room.saved ? this.roomState.queue.room(room.s.roomId).queueRevision : undefined;
    const entries = room.saved ? [this.roomState.queue.current(room.s.roomId),...this.roomState.queue.pending(room.s.roomId)].filter(Boolean) : [];
    if (room.media && !entries.some(item=>item.mediaId===room.media.id)) entries.unshift({id:room.media.id,mediaId:room.media.id,title:room.media.title});
    if (plex.availability) {
      const availability = await plex.availability(entries.map(item=>item.mediaId));
      if (room.mediaVersion!==version || room.viewers.get(viewerId)!==viewer) return;
      if (room.saved && this.roomState.queue.room(room.s.roomId).queueRevision!==queueRevision) return;
      viewer.unavailableMedia = entries.filter(item=>availability.get(item.mediaId)===false).map(({id,mediaId,title})=>({id,mediaId,title}));
      if (room.media && availability.get(room.media.id)===false) {
        if (!viewer.media?.unavailable) { this.tracking.end(viewer,'media-unavailable'); await this.plex.stop(viewer.media); }
        if (room.mediaVersion!==version || room.viewers.get(viewerId)!==viewer) return;
        viewer.media = {id:room.media.id,title:room.media.title,duration:room.media.duration,kind:'plex',format:'unavailable',resources:new Map(),unavailable:true,playbackError:room.media.title+' is unavailable.'};
        viewer.mediaVersion = version; viewer.ready = false; return viewer.media;
      }
      if (viewer.media?.unavailable) viewer.media = undefined;
    }
    if (!room.media) return;
    if (viewer.media && viewer.mediaVersion === version && (!viewer.media.principal||viewer.media.principal===plex.principal)) return viewer.media;
    // Collapse concurrent polls for this one viewer, never across viewers.
    if (viewer.preparing) {
      await viewer.preparing;
      return room.mediaVersion !== version ? this.prepareViewer(room, actor, viewerId) : viewer.media;
    }
    const prepare = (async () => {
      await this.replaceViewer(room,actor,viewerId,(authorized,source)=>source.kind==='demo'?source:
        this.prepareQuality(room,viewer,plex,source,viewer.preferredQuality || viewer.quality,viewer.compatible,viewer.fallback,authorized),{retainUnavailable:true});
      if(viewer.media?.quality)viewer.quality=viewer.media.quality;
    })();
    const job = prepare.finally(() => { if (viewer.preparing === job) viewer.preparing = undefined; });
    viewer.preparing = job;
    await job;
    return viewer.media;
  }
  async replaceViewer(room,actor,viewerId,prepare,{permitted=()=>true,retainUnavailable=false,accept=()=>true}={}) {
    const viewer=room.viewers.get(viewerId),version=room.mediaVersion,current=viewer?.media,stream=viewer?.streamVersion,source=room.media;
    if(!viewer || viewer.userId!==actor.userId)return {status:'unavailable',message:'Room changed or command expired.'};
    const matches=()=>room.mediaVersion===version && room.viewers.get(viewerId)===viewer && viewer.media===current && viewer.streamVersion===stream;
    const authorized=async()=>matches() && permitted() && await this.canView(room,actor) && (!viewer.alive || await viewer.alive()) && matches() && permitted();
    let media,adopted=false;
    try {
      if(!await authorized())return {status:'unavailable',message:'Room changed or command expired.'};
      try {media=await prepare(authorized,source);}
      catch(error) {
        if (retainUnavailable && error.code === 'MEDIA_UNAVAILABLE') {
          media={id:source.id,title:source.title,duration:source.duration,kind:'plex',resources:new Map(),unavailable:true,format:'unavailable',playbackError:error.message};
        } else {
          if(!retainUnavailable || !(error instanceof PlaybackError) || !error.media)throw error;
          // Preserve the catalog so Off/another subtitle can recover a failed burn.
          media=error.media;media.format='unavailable';media.playbackError=error.message;
        }
      }
      if(!await authorized())return {status:'unavailable',message:'Room changed or command expired.'};
      if(!accept(media))throw new PlaybackError('Plex could not refresh this stream.');
      this.tracking.end(viewer,'stream-changed');viewer.media=media;viewer.mediaVersion=version;viewer.streamVersion=randomUUID();adopted=true;
      if (media.unavailable) {
        const entry=room.saved && this.roomState.queue.current(room.s.roomId);
        viewer.unavailableMedia=[...(viewer.unavailableMedia || []).filter(item=>item.mediaId!==media.id),{id:entry?.id || media.id,mediaId:media.id,title:media.title}];
      }
      if(current && current!==media)void this.plex.stop(current);
      return {status:'applied'};
    } finally {
      if(media && !adopted && media!==current && media!==room.media)await this.plex.stop(media);
    }
  }
  refresh(room, now = Date.now()) {
    // A durable transition has committed its in-memory queue transaction but
    // still owns the old live media until the writer acknowledges it.
    room.s.lastSeen = now;
    if (room.transitionCommit) return;
    this.settle(room, now);
    room.s.state.waitingForReady = room.initialGate && !room.manualPaused && !room.readinessTimedOut;
    room.s.state.position = this.position(room, now); room.s.state.duration = room.media?.duration || 0;
    let pruned = false, hostTimedOut = false, lastPresence = 0;
    for (const [id, saved] of room.disconnectedViewers) if (saved.expires <= now || saved.mediaVersion !== room.mediaVersion || room.saved && room.s.visibility === 'private' && !RoomPolicy.assigned(room.saved,saved.userId) && !this.hub.isAdmin({userId:saved.userId})) room.disconnectedViewers.delete(id);
    for (const viewer of room.viewers.values()) this.tracking.expire(viewer);
    for (const [id, viewer] of room.viewers) if (now - viewer.at > 10000 || room.s.visibility === 'private' && !(room.saved ? RoomPolicy.assigned(room.saved,viewer.userId) : isHost(room.s,viewer.actor)) && !this.hub.isAdmin(viewer.actor)) {
      lastPresence = Math.max(lastPresence, viewer.at);
      if (now - viewer.at > 10000 && (room.s.visibility !== 'private' || (room.saved ? RoomPolicy.assigned(room.saved,viewer.userId) : isHost(room.s,viewer.actor)) || this.hub.isAdmin(viewer.actor))) {
        // Preserve only personal playback settings for the same tab's short
        // reconnect. A fresh stream and observation epoch are always required.
        room.disconnectedViewers.set(id, { userId:viewer.userId, mediaVersion:room.mediaVersion, streamVersion:viewer.streamVersion, expires:now+RECONNECT_GRACE_MS,
          trackChoice:viewer.trackChoice && {...viewer.trackChoice}, subtitleOffset:viewer.subtitleOffset,
          quality:viewer.quality, preferredQuality:viewer.preferredQuality, compatible:viewer.compatible, fallback:viewer.fallback,
          volume:viewer.volume, muted:viewer.muted, joinedAt:viewer.joinedAt,
          plexReporting:viewer.plexReporting, plexWatchState:viewer.plexWatchState,
          syncQuality:viewer.syncQuality?{...viewer.syncQuality,status:'disconnected',confidence:viewer.syncQuality.confidence==='provisional'?'provisional':'reduced',updatedAt:now}:undefined });
        if (room.disconnectedViewers.size > 128) room.disconnectedViewers.delete(room.disconnectedViewers.keys().next().value);
      }
      if (viewer.userId === room.s.hostId && now - viewer.at > 10000) hostTimedOut = true;
      this.tracking.end(viewer, room.s.visibility === 'private' ? 'privacy-revoked' : 'disconnected'); void this.plex.stop(viewer.media); void this.reporting?.end(viewer, 'disconnected'); room.viewers.delete(id); room.initialViewers.delete(id); pruned = true;
    }
    if (hostTimedOut) this.invalidateControls(room);
    if (pruned) this.settle(room, now);
    if (room.viewers.size && now - (room.lastPing || 0) >= 15000) {
      room.lastPing = now;
      for (const viewer of new Map([...room.viewers.values()].filter(v => v.media?.transcodeId).map(v => [v.media.transcodeId, v])).values()) void this.plex.ping(viewer.media);
    }
    if (!room.saved && room.media && !room.s.state.paused && room.s.state.position >= room.media.duration) {
      room.position = room.media.duration; room.changedAt = now; room.s.state.paused = true; room.revision++;
    }
    if (room.recovery && !room.viewers.size) return;
    if (room.hadViewers && !room.viewers.size) {
      this.cancelAutoplay(room); clearPlaybackEnd(room);
      const savedHost = room.disconnectedViewers.get(room.hostViewerId);
      if (room.saved ? room.disconnectedViewers.size : savedHost?.userId === room.s.hostId) {
        if (room.saved && !room.reconnecting) { room.disconnectedWasPlaying = !room.s.state.paused || room.initialGate && !room.manualPaused; this.roomState.freeze(room, lastPresence || now); void this.roomState.save(room); }
        // An empty room has no command target. Only its original host tab may
        // reactivate it during the bounded, same-media reconnect grace.
        room.reconnecting = true; this.hub.rooms.delete(room.s.roomId); return;
      }
      if (room.saved && !room.reconnecting) this.roomState.freeze(room, lastPresence || now);
      this.remove(room.s.roomId); return;
    }
    if (room.hadViewers && !room.recovery && ![...room.viewers.values()].some(viewer => viewer.userId === room.s.hostId)) void this.transfer(room);
    else if (pruned) void this.maybeStart(room);
    if (!room.hadViewers && now - room.lastActivity > 30000) this.remove(room.s.roomId);
  }
  async canView(room, actor) {
    if (!room?.saved && room?.reconnecting && (actor.surface !== 'web' || actor.userId !== room.s.hostId)) return false;
    if (!room || this.rooms.get(room.s.roomId) !== room) return false;
    if (!canWatch(this.hub.access,actor.userId,actor)) {
      try { if (!await (this.hub.access?.refreshWatch||this.hub.access?.refresh)?.(actor.userId,actor)) return false; } catch { return false; }
    }
    if(room.media?.kind==='plex'&&this.hub.plexFor){try{if(!await (await this.hub.plexFor(actor)).allows(room.media.id))return false;}catch{return false;}}
    return viewEligible(room.s, actor, this.hub.config, Date.now(), this.hub.access, this.hub.isAdmin(actor));
  }
  async list(actor, activity = false) {
    const rooms = [];
    for (const room of this.rooms.values()) {
      this.refresh(room); if (!this.rooms.has(room.s.roomId)) continue;
      if (!room.saved && room.reconnecting && (actor.surface !== 'web' || actor.userId !== room.s.hostId)) continue;
      const accessible = await this.canView(room, actor);
      if (!accessible && !(activity && room.s.visibility === 'private' && sameVoice(room.s, actor, this.hub.access))) continue;
      const members = [...new Map([...room.viewers.values()].map(v => [v.userId, v.name])).values()];
      rooms.push({maxMembers:room.saved ? Math.min(room.saved.maxMembers || this.roomState.limits.maxMembers,this.roomState.limits.maxMembers) : undefined,id:room.s.roomId, name:accessible ? room.s.name : undefined, hostName:room.s.hostName, visibility:room.s.visibility, viewers:members.length,
        ...(accessible ? {title:room.media?.title || '',members,canManage:this.hub.canManage(room.s, actor)} : {locked:true})});
    }
    if (this.roomState) for (const [id,recovery] of this.roomState.recoveries) {
      if (this.rooms.has(id) || recovery.until <= Date.now()) continue;
      const record = this.roomState.store.get(id), now = Date.now();
      const descriptor = {...record,kind:'watch',reachable:true,lastSeen:now,socket:{readyState:1}};
      if (!viewEligible(descriptor,actor,this.hub.config,now,this.hub.access,this.hub.isAdmin(actor))) continue;
      if (record.bookmark && this.hub.plexFor) {
        try { if (!await (await this.hub.plexFor(actor)).allows(record.bookmark.mediaId)) continue; } catch { continue; }
      }
      rooms.push({id,name:record.name,visibility:record.visibility,hostName:this.roomState.registry.canonical(record.creatorId)?.name,
        title:record.bookmark?.title || '',viewers:0,members:[],recovering:true,
        maxMembers:Math.min(record.maxMembers || this.roomState.limits.maxMembers,this.roomState.limits.maxMembers)});
    }
    return rooms;
  }
  async transfer(room) {
    if (room.saved) return this.roomState.elect(room);
    if (room.transferring || this.rooms.get(room.s.roomId) !== room) return;
    room.transferring = true;
    const oldHost = room.s.hostId;
    try {
      const candidates = [...room.viewers.entries()].filter(([, v]) => v.userId !== oldHost).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      for (const [viewerId, candidate] of candidates) {
        try { if (candidate.alive && !await candidate.alive()) continue; } catch { continue; }
        let member;
        try { member = !!await (this.hub.access?.refreshWatch||this.hub.access?.refresh)?.(candidate.userId,candidate.actor);if(member&&room.media?.kind==='plex'&&this.hub.plexFor)member=await (await this.hub.plexFor(candidate.actor)).allows(room.media.id); } catch { member = false; }
        if (this.rooms.get(room.s.roomId) !== room || room.s.hostId !== oldHost) return;
        if ([...room.viewers.values()].some(v => v.userId === oldHost)) return;
        if (!member || room.s.visibility !== 'public' || room.viewers.get(viewerId) !== candidate || Date.now() - candidate.at >= 10000) continue;
        room.s.hostId = candidate.userId; room.s.hostName = candidate.name; room.hostViewerId = viewerId;
        room.s.epoch = randomUUID(); room.revision++;
        await this.maybeStart(room);
        return;
      }
      this.remove(room.s.roomId);
    } finally { room.transferring = false; }
  }
  async leave(room, actor, viewerId, reason = 'left') {
    if (room.transitionCommit) await room.transitionCommit.catch(() => {});
    if (room.disconnectedViewers.get(viewerId)?.userId === actor.userId) {
      room.disconnectedViewers.delete(viewerId);
      if (room.reconnecting && viewerId === room.hostViewerId) { this.remove(room.s.roomId); return; }
    }
    if (room.viewers.get(viewerId)?.userId !== actor.userId) return;
    const hostLeft = actor.userId === room.s.hostId;
    const viewer = room.viewers.get(viewerId);
    this.tracking.end(viewer, reason); void this.plex.stop(viewer.media); void this.reporting?.end(viewer, reason);
    room.viewers.delete(viewerId); room.initialViewers.delete(viewerId); room.revision++;
    this.hub?.config?.logger?.info('Room', `Viewer "${viewer?.name || viewerId}" left "${room.s.alias || room.s.roomId}" (remaining: ${room.viewers.size})`);
    if (room.autoplayCountdown?.viewerId === viewerId || !room.viewers.size) this.cancelAutoplay(room);
    this.settle(room);
    if (!room.viewers.size) { await this.remove(room.s.roomId); return; }
    if (hostLeft) {
      if (reason === 'left') {
        // An intentional handoff retains room settings, but never old commands.
        room.s.epoch = randomUUID();
      } else this.invalidateControls(room);
    }
    if (![...room.viewers.values()].some(v => v.userId === room.s.hostId)) await this.transfer(room);
    await this.maybeStart(room);
  }
  async ready(room, actor, viewerId, version, ready, readinessVersion) {
    this.settle(room);
    const viewer = room.viewers.get(viewerId);
    if (!viewer || viewer.userId !== actor.userId || room.mediaVersion !== version || typeof ready !== 'boolean' || room.readinessVersion !== readinessVersion) throw new Error('Invalid readiness');
    viewer.ready = ready; viewer.version = version; viewer.at = Date.now();
    await this.maybeStart(room);
  }
  async maybeStart(room) {
    if (room.recovery) return this.roomState.maybeRecover(room);
    if (!room.initialGate || room.manualPaused || room.readinessTimedOut || room.starting || this.rooms.get(room.s.roomId) !== room) return;
    const viewers = [...room.initialViewers].map(id => room.viewers.get(id)).filter(Boolean);
    const host = [...room.viewers.values()].find(v => v.userId === room.s.hostId);
    if (!viewers.length || !host || viewers.some(v => !v.ready || v.version !== room.mediaVersion)) return;
    room.starting = true;
    const version = room.mediaVersion, readinessVersion = room.readinessVersion;
    try {
      if (host.alive && !await host.alive()) return;
      this.settle(room);
      if (room.manualPaused || room.readinessTimedOut || room.mediaVersion !== version || room.readinessVersion !== readinessVersion || [...room.initialViewers].some(id => {
        const viewer = room.viewers.get(id); return viewer && (!viewer.ready || viewer.version !== version);
      })) return;
      room.initialGate = false;
      const result = await this.hub.dispatch({ ...host.actor, watchAutoplayVersion: version, watchReadinessVersion: readinessVersion }, { roomId: room.s.roomId, action: 'media.play' });
      if (result.status !== 'applied' && room.mediaVersion === version && room.readinessVersion === readinessVersion) room.initialGate = true;
    } finally { room.starting = false; }
  }
  snapshot(room, actor, viewerId, alive, quality = '720p', preferences = {}) {
    if ((room.kickedViewers?.get(viewerId) || 0) > Date.now()) throw Object.assign(new Error('You were removed from this room. You may rejoin.'),{status:403});
    room.kickedViewers?.delete(viewerId);
    const now = Date.now(); this.refresh(room, now); room.lastActivity = now;
    if (this.rooms.get(room.s.roomId) !== room) throw new Error('Room unavailable');
    // Existing viewers can keep the room alive between host tabs.
    if (room.saved) this.roomState.checkCapacity(room,actor.userId);
    const oldViewer = room.viewers.get(viewerId);
    if (oldViewer && oldViewer.userId !== actor.userId) throw new Error('Viewer identity mismatch');
    const saved = !oldViewer && room.disconnectedViewers.get(viewerId);
    if (saved && saved.userId !== actor.userId) throw new Error('Viewer identity mismatch');
    if (!room.saved && room.reconnecting && (!saved || viewerId !== room.hostViewerId || actor.surface !== 'web' || actor.userId !== room.s.hostId || !viewEligible(room.s,actor,this.hub.config,now,this.hub.access))) throw new Error('Room unavailable');
    if (saved) room.disconnectedViewers.delete(viewerId);
    if (room.reconnecting) { room.reconnecting = false; this.hub.rooms.set(room.s.roomId, room.s); }
    const controller = !room.saved ? isHost(room.s, actor) : actor.userId === room.s.hostId ||
      (isHost(room.s, actor) || this.hub.isAdmin(actor)) && !room.viewers.has(room.hostViewerId);
    if (controller && !oldViewer && room.hostViewerId && room.hostViewerId !== viewerId) {
      room.s.epoch = randomUUID(); room.revision++;
    }
    if (controller && !oldViewer) { room.hostViewerId = viewerId; room.s.hostId = actor.userId; room.s.hostName = actor.name; room.waitingForHost = false; }
    room.hadViewers = true;
    const viewer = oldViewer || { observationEpoch: randomUUID(), quality: saved?.quality || (Engine.validQuality(quality) ? quality : '720p4'),
      preferredQuality:saved?.preferredQuality || (Engine.validQuality(quality) ? Engine.qualityId(quality) : '720p4'),
      volume:saved?.volume ?? preferences.volume ?? 30, muted:saved?.muted ?? preferences.muted ?? false,
      plexReporting:saved?.plexReporting ?? preferences.plexReporting ?? true,
      plexWatchState:saved?.plexWatchState ?? preferences.plexWatchState ?? false,
      trackChoice:saved?.trackChoice, subtitleOffset:saved?.subtitleOffset, compatible:saved?.compatible, fallback:saved?.fallback,
      syncQuality:saved?.syncQuality,
      joinedAt: Math.min(now, saved?.joinedAt ?? now, ...[...room.viewers.values()].filter(v => v.userId === actor.userId).map(v => v.joinedAt)) };
    Object.assign(viewer, { at: now, userId: actor.userId, viewerId, name: Engine.senderName(actor.name), actor: { ...actor }, ...(alive ? { alive } : {}) });
    room.viewers.set(viewerId, viewer);
    if (!oldViewer) this.hub?.config?.logger?.info('Room', `Viewer "${viewer.name || actor.userId}" joined "${room.s.alias || room.s.roomId}" (viewers: ${room.viewers.size})`);
    if (room.saved && !oldViewer) { this.roomState.store.touch(room.s.roomId); void this.roomState.save(room).catch(() => {}); }
    if (!oldViewer && room.viewers.size === 2 && room.initialGate) {
      room.readinessStartAt = Math.max(room.readinessStartAt || 0, now + INITIAL_START_LEAD_MS);
    }
    if (room.initialGate && !oldViewer) room.initialViewers.add(viewerId);
    const owner = this.hub.canManage(room.s, actor);
    room.transportSequence=(room.transportSequence||0)+1;
    const participants = room.saved ? syncQualityParticipants(room,this.roomState.participants(room.s.roomId),now) : undefined;
    return { id: room.s.roomId, transportSequence:room.transportSequence, epoch: room.s.epoch, revision: room.revision, mediaVersion: room.mediaVersion, serverNow: now,
      startAt:room.startAt, pauseAt:room.pauseAt,
      title: room.media?.title || 'Choose something to watch…', subtitle: room.media?.subtitle || '', mediaId: room.media?.id,
      observationEpoch: viewer.observationEpoch, format: viewer.media?.format, quality: room.media?.kind === 'demo' ? 'direct' : viewer.quality,
      videoCodec: viewer.media?.videoCodec, compatible: !!viewer.media?.compatible, streamVersion: viewer.streamVersion,
      audioCodec:viewer.media?.audioCodec,bitrate:viewer.media?.bitrate,bitrateCeiling:viewer.media?.bitrateCeiling,
      mediaError:viewer.media?.playbackError, unavailableMedia:viewer.unavailableMedia || [],
      qualityNotice:viewer.media?.qualityNotice, preferredQuality:viewer.preferredQuality,
      deliveryInfo:viewer.media?{format:viewer.media.format,videoCodec:viewer.media.videoCodec,audioCodec:viewer.media.audioCodec,
        width:viewer.media.output?.width,height:viewer.media.output?.height,bitrate:viewer.media.bitrate,bitrateCeiling:viewer.media.bitrateCeiling,
        encoder:viewer.media.av1Lease?.group.encoder,cpuFallback:!!viewer.media.av1Lease?.group.cpuFallback}:undefined,
      ...(viewer.media?.tracks ? {tracks:{...Tracks.publicCatalog(viewer.media.tracks),audioChoice:viewer.trackChoice?.audioId || 'auto',subtitleChoice:viewer.trackChoice?.subtitleId || 'auto',
        audioId:viewer.media.selection.audio?.id,subtitleId:viewer.media.selection.subtitle?.id,subtitleOffset:viewer.subtitleOffset || 0,
        subtitleDelivery:viewer.media.selection.subtitle?.delivery,subtitleMode:viewer.trackChoice?.subtitleMode || 'auto',
        subtitleError:viewer.media.selection.subtitle && !viewer.media.selection.subtitle.available ? viewer.media.selection.subtitle.reason : undefined}} : {}),
      qualities: this.plex.qualities?.(room.media) || Engine.QUALITIES,
      hasPrevious: room.saved ? (this.position(room) >= 5 || !!this.roomState.queue.lastHistory(room.s.roomId)) : !!room.media?.previousId,
      hasNext: room.saved ? !!this.roomState.queue.peekNext(room.s.roomId) : !!room.media?.nextId,
      queueSummary: room.saved ? this.roomState.queue.summary(room.s.roomId) : undefined,
      autoplay: room.saved ? { enabled:this.roomState.store.get(room.s.roomId).autoplay,
        countdown:room.autoplayCountdown ? {id:room.autoplayCountdown.id,title:room.autoplayCountdown.title,endsAt:room.autoplayCountdown.endsAt} : null,
        error:room.autoplayError || room.autoQueueError } : undefined,
      readinessVersion: room.readinessVersion, waitingForReady: room.initialGate && !room.manualPaused && !room.readinessTimedOut,
      readiness: room.initialGate && !room.manualPaused ? { id:room.readinessId, timedOut:!!room.readinessTimedOut,
        blockers: performance.now() - room.readinessSince >= 3000 ? [...room.initialViewers].map(id => room.viewers.get(id)).filter(v => v && (!v.ready || v.version !== room.mediaVersion)).map(v => v.name) : [],
        canStart:[...room.initialViewers].some(id => { const v = room.viewers.get(id); return v?.ready && v.version === room.mediaVersion; }) } : undefined,
      recovery:this.roomState?.recoveryState(room),maxMembers:room.saved ? Math.min(room.saved.maxMembers || this.roomState.limits.maxMembers,this.roomState.limits.maxMembers) : undefined,
      roomName:room.s.name, durable:!!room.saved, roomRole:room.saved ? RoomPolicy.role(room.s,actor.userId) : undefined, saveError:room.saveError, waitingForHost:!!room.waitingForHost,
      participants,
      allHosts:!!room.s.permissions?.allHosts,hostPermissions:room.saved ? {...room.s.permissions.host} : undefined,
      participantPermissions:room.saved ? { ...room.s.permissions.viewer } : undefined,
      capabilities:room.saved ? Object.fromEntries([...RoomPolicy.CAPABILITIES,'managePermissions','manageHosts'].map(key => [key,this.hub.canRoom(room.s,actor,key)])) : undefined,
      hostName: room.s.hostName, canBrowse:true, isHost:isHost(room.s,actor), adminMode:this.hub.isAdmin(actor),
      state: Engine.snapshot({ ...room.s.state, volume: viewer.volume, muted: viewer.muted }), canManage: owner, controls: { ...room.s.controls },
      visibility: room.s.visibility,
      canPlayback:room.saved ? this.hub.roomCommandAllowed(room.s,actor,{action:'media.play'}) : owner || eligible(room.s, actor, this.hub.config, now, this.hub.access) && room.s.controls.playback,
      canTransform:room.saved ? this.hub.canRoom(room.s,actor,'picture') : owner || eligible(room.s, actor, this.hub.config, now, this.hub.access) && room.s.controls.transform, viewers: new Set([...room.viewers.values()].map(x => x.userId)).size,
      feedback: room.feedback };
  }
  cancelAutoplay(room) {
    clearTimeout(room.autoplayTimer); room.autoplayTimer = undefined;
    if (room.autoplayCountdown) { room.autoplayCountdown = undefined; room.revision++; }
    room.playbackIntent = (room.playbackIntent || 0) + 1;
  }
  async autoCorpus(id, actor, config = this.roomState.store.get(id).autoQueue) {
    if (config.mode === 'off') return undefined;
    const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
    const serverId = await this.roomState.identify({id:config.scope.id});
    if (serverId !== config.scope.serverId) throw Object.assign(new Error('The auto-queue Plex server changed'),{status:409});
    const items = await plex.queueItems({...config.scope,includeSpecials:config.includeSpecials});
    if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal) throw Object.assign(new Error('Plex access changed'),{status:403});
    return items.map(item => this.queueItem(item,serverId));
  }
  queueItem(item, serverId) {
    let parentTitle = item.parentTitle;
    const epNum = Number.isInteger(item.index) ? item.index : (typeof item.episode === 'number' && Number.isInteger(item.episode)) ? item.episode : undefined;
    if (item.type === 'episode' && Number.isInteger(epNum)) {
      const epStr = 'Episode ' + epNum;
      if (parentTitle && !parentTitle.includes('Episode')) {
        parentTitle = parentTitle + ' · ' + epStr;
      } else if (!parentTitle) {
        parentTitle = epStr;
      }
    }
    return { ...item, serverId, mediaId:String(item.mediaId || item.id || ''),
      type:item.type === 'demo' || item.mediaId === 'demo' || item.id === 'demo' ? 'movie' : item.type,
      parentTitle, grandparentTitle:item.grandparentTitle || item.showTitle };
  }
  async queueCommand(id, command, actor, permitted) {
    if (!this.roomState) throw Object.assign(new Error('Saved rooms are unavailable'),{status:400});
    const room = this.rooms.get(id), {action,args} = command, queue = this.roomState.queue;
    if (room?.mediaTransition || room?.queueEditing) throw Object.assign(new Error('Wait for the current queue operation'),{status:409});
    const currentRequest = async () => permitted() && (!actor.watchCurrent || await actor.watchCurrent()) && permitted();
    await this.roomState.eligible(actor,currentRequest);
    await this.roomState.metadata(id,actor);
    const check = async () => {
      if (!await currentRequest() || this.rooms.get(id) !== room || room && !await this.canView(room,actor) || !await currentRequest()) {
        throw Object.assign(new Error('Room access changed; retry manually'),{status:403});
      }
      queue.assertAllowed(queue.room(id),actor.userId,RoomPolicy.commandCapability(action));
    };
    await check();
    const revision = args.expectedRevision ?? queue.room(id).queueRevision;
    queue.assertRevision(queue.room(id),revision);
    if (room?.mediaTransition || room?.queueEditing) throw Object.assign(new Error('Wait for the current queue operation'),{status:409});
    if (room) { room.queueEditing = true; this.cancelAutoplay(room); clearPlaybackEnd(room); }
    try {
      let value;
      if (action === 'queue.remove' && (args.advance || queue.current(id)?.id === args.entryId)) {
        if (queue.current(id)?.id !== args.entryId) throw Object.assign(new Error('Current video changed; refresh before removing'),{status:409});
        queue.assertAllowed(queue.room(id),actor.userId,'chooseMedia');
        if (args.advance && !queue.peekNext(id)) throw Object.assign(new Error('No next video is available'),{status:409});
        if (room) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,command,actor,permitted);
        }
        value = args.advance ? await queue.next(id,actor.userId,{expectedRevision:revision,currentEntryId:args.entryId,discardCurrent:true}) :
          await queue.remove(id,actor.userId,args.entryId,revision,{allowCurrent:true});
      } else if (action === 'queue.add' || action === 'queue.playNow') {
        const raw = args.item, serverId = raw.serverId || await this.roomState.identify({id:raw.mediaId || raw.id});
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        const checked = plex.playableItem && (raw.mediaId || raw.id) !== 'demo' ? await plex.playableItem(raw.mediaId || raw.id) : raw;
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal) throw Object.assign(new Error('Plex access changed'),{status:403});
        const item = this.queueItem(checked,serverId); await check();
        queue.assertRevision(queue.room(id),revision);
        if (action === 'queue.playNow' && room) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,{action:'media.load',args:{mediaId:item.mediaId}},actor,permitted);
        }
        if (action === 'queue.add' && room && !room.media && !queue.current(id) && !queue.pending(id).length) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,{action:'media.load',args:{mediaId:item.mediaId}},actor,permitted,{initialAdd:true});
        }
        value = action === 'queue.add' ? await queue.add(id,actor.userId,item,{expectedRevision:revision}) : await queue.playNow(id,actor.userId,item);
      } else if (action === 'queue.playEntry' || action === 'queue.skipTo') {
        const skipPrevious = action === 'queue.skipTo' || !!args.skipPrevious;
        if (room) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,{action:'queue.playEntry',args:{entryId:args.entryId,skipPrevious}},actor,permitted);
        }
        value = await queue.playEntry(id,actor.userId,args.entryId,{skipPrevious,expectedRevision:revision});
      } else if (action === 'queue.bulk') {
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        const serverId = await this.roomState.identify({id:args.mediaId});
        const items = await plex.queueItems({type:args.type,id:args.mediaId,includeSpecials:args.includeSpecials});
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal) throw Object.assign(new Error('Plex access changed'),{status:403});
        await check();
        value = await queue.addBulk(id,actor.userId,items.map(item => this.queueItem(item,serverId)),{expectedRevision:revision,unfinished:args.unfinished});
        if (room && !room.media && !queue.current(id) && value.addedCount) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,{action:'queue.playEntry',args:{entryId:queue.pending(id)[0].id}},actor,permitted,{initialAdd:true});
        }
      } else if (action === 'queue.auto') {
        let scope = args.scope, corpus;
        if (args.mode !== 'off') {
          const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
          if (!scope.id) {
            if (scope.type !== 'show' || !room?.media || room.media.id === 'demo') throw Object.assign(new Error('Choose a show from the library'),{status:400});
            const details = await plex.details(room.media.id);
            scope = {...scope,id:details.showId || (details.type === 'show' ? details.id : undefined)};
          }
          if (!scope.id) throw Object.assign(new Error('Choose a show from the library'),{status:400});
          scope = {...scope,serverId:await this.roomState.identify({id:scope.id})};
          corpus = await this.autoCorpus(id,actor,{...args,scope});
        }
        await check();
        value = await queue.configureAuto(id,actor.userId,{...args,scope},{expectedRevision:revision});
        if (corpus) {
          await check();
          const generated = await queue.generate(id,actor.userId,corpus,{expectedRevision:value.queueRevision});
          value = {...value,...generated};
        }
      } else if (action === 'queue.move') value = await queue.move(id,actor.userId,args.entryId,args.targetRank,revision);
      else if (action === 'queue.remove') value = await queue.remove(id,actor.userId,args.entryId,revision);
      else if (action === 'queue.clear') value = await queue.clear(id,actor.userId,revision);
      else if (action === 'queue.shuffle') value = await queue.shuffle(id,actor.userId,revision);
      else if (action === 'queue.history.clear') value = await queue.historyClear(id,actor.userId);
      else if (action === 'queue.history.replay' || action === 'queue.history.goBack') {
        if (room) {
          room.queueEditing = false;
          return this.changeQueueMedia(room,command,actor,permitted);
        }
        value = await queue.historyReplay(id,actor.userId,args.entryId,{resume:args.resume,restore:action === 'queue.history.goBack',expectedRevision:revision});
      }
      if (room && this.rooms.get(id) === room) { this.roomState.apply(room,this.roomState.store.get(id)); room.revision++; room.autoQueueError = undefined; }
      return {status:'applied',...value};
    } finally { if (room) room.queueEditing = false; }
  }
  async observeEnd(room, viewer, data, observed) {
    if (!room.saved || !observePlaybackEnd(room,viewer,data,observed)) return;
    await this.finishQueueMedia(room,data);
  }
  async finishQueueMedia(room, data) {
    if (room.autoplayCountdown || room.mediaTransition || room.queueEditing || room.endedVersion === room.mediaVersion) return;
    const intent = room.playbackIntent || 0;
    room.endedVersion = room.mediaVersion;
    room.initialGate = false; room.readinessTimedOut = false; room.readinessVersion = randomUUID();
    room.readinessStartAt = room.pauseAt = room.startAt = undefined;
    room.position = room.media.duration; room.changedAt = Date.now(); room.s.state.paused = true; room.revision++;
    const record = this.roomState.store.get(room.s.roomId), current = this.roomState.queue.current(record.id), next = this.roomState.queue.peekNext(record.id);
    if (!current || !next) {
      room.mediaTransition = true;
      try {
        // A checkpoint or another control must not restore the completed item
        // while its durable completion is waiting for the writer.
        const completing = (async () => {
          await room.saving?.catch(() => {});
          if (current) await this.roomState.queue.completeCurrent(record.id);
          this.unloadQueueMedia(room);
        })();
        room.transitionCommit = completing;
        await completing;
        room.transitionCommit = undefined;
        await this.roomState.save(room);
        this.roomState.apply(room, this.roomState.store.get(record.id));
        room.revision++;
      } finally { room.transitionCommit = undefined; room.mediaTransition = false; }
      return;
    }
    const controller = [...room.viewers.entries()].find(([,person]) => this.hub.canRoom(room.s,person.actor,'chooseMedia') && this.hub.canRoom(room.s,person.actor,'autoplay'));
    if (!controller) return;
    const [viewerId, person] = controller;
    if (person.alive && !await person.alive() || !await this.canView(room,person.actor) || room.viewers.get(viewerId) !== person || this.rooms.get(record.id) !== room || room.manualPaused ||
        room.mediaVersion !== data.mediaVersion || room.s.epoch !== data.epoch || room.autoplayCountdown || room.mediaTransition || room.queueEditing ||
        (room.playbackIntent || 0) !== intent || this.roomState.store.get(record.id).queueRevision !== record.queueRevision ||
        !this.roomState.store.get(record.id).autoplay || !this.hub.canRoom(room.s,person.actor,'chooseMedia') || !this.hub.canRoom(room.s,person.actor,'autoplay')) return;
    const countdown = {id:randomUUID(),title:next.title,endsAt:Date.now()+this.autoplayDelayMs,epoch:room.s.epoch,
      mediaVersion:room.mediaVersion,currentEntryId:current.id,nextEntryId:next.id,queueRevision:record.queueRevision,viewerId};
    room.autoplayCountdown = countdown; room.autoplayError = undefined; room.revision++;
    room.autoplayTimer = setTimeout(() => {
      const advance = this.hub.dispatch({...person.actor,watchViewerId:viewerId,watchQueueAdvance:countdown},{roomId:record.id,action:'media.next'}).then(result => {
        if (result.status !== 'applied' && room.autoplayCountdown === countdown) {
          this.cancelAutoplay(room); room.autoplayError = result.message || 'The next video could not be loaded.'; room.revision++;
        }
      }).catch(() => { this.cancelAutoplay(room); room.autoplayError = 'The next video could not be loaded.'; room.revision++; });
      this.roomState.track(advance);
    },this.autoplayDelayMs);
    room.autoplayTimer.unref?.();
  }
  unloadQueueMedia(room) {
    const old = room.media;
    room.media = undefined; room.mediaVersion = randomUUID(); room.readinessVersion = undefined;
    room.position = 0; room.changedAt = Date.now(); room.pauseAt = room.startAt = undefined;
    room.initialGate = false; room.manualPaused = true; room.readinessTimedOut = false; room.endedVersion = undefined;
    room.s.state.paused = true; room.s.state.position = 0; room.s.state.duration = 0; room.s.state.seekable = false;
    this.dropMedia(room, 'end');
    if (old) void this.plex.stop(old);
  }
  async changeQueueMedia(room, command, actor, permitted, { initialAdd = false } = {}) {
    if (room.mediaTransition || room.queueEditing) return {status:'unavailable',message:'Wait for the current queue operation.'};
    if (!room.viewers.size && command.action !== 'media.load' && !(command.action === 'queue.remove' && !command.args.advance)) return {status:'unavailable',message:'No viewer is connected.'};
    const {action,args} = command, id = room.s.roomId, queue = this.roomState?.queue, countdown = actor.watchQueueAdvance;
    const version = room.mediaVersion, epoch = room.s.epoch, intent = room.playbackIntent || 0;
    const record = room.saved ? this.roomState.store.get(id) : null, current = record && queue.current(id), next = record && queue.peekNext(id);
    const valid = () => permitted() && this.rooms.get(id) === room && room.mediaVersion === version && room.s.epoch === epoch &&
      (room.playbackIntent || 0) === intent && (!countdown || room.autoplayCountdown === countdown && room.viewers.has(countdown.viewerId) &&
        !room.manualPaused && this.roomState.store.get(id).autoplay && countdown.epoch === epoch && countdown.mediaVersion === version &&
        countdown.currentEntryId === current?.id && countdown.nextEntryId === next?.id && countdown.queueRevision === record.queueRevision &&
        this.hub.canRoom(room.s,actor,'autoplay'));
    if (!valid()) return {status:'unavailable',message:'Autoplay or media selection was cancelled.'};
    const removing = action === 'queue.remove', advance = removing && args.advance;
    if (removing && current?.id !== args.entryId) return {status:'unavailable',message:'Current video changed; refresh before removing.'};
    let target, prepared, adopted = false;
    const old = room.media, oldPosition = this.position(room), restore = action === 'queue.history.goBack', replay = action === 'queue.history.replay' || restore, playEntry = action === 'queue.playEntry';
    if (replay) {
      target = queue.getEntry(args.entryId);
      if (!target || target.roomId !== id || target.state !== 'history') throw Object.assign(new Error('History entry unavailable'),{status:404});
    } else if (playEntry) {
      target = queue.getEntry(args.entryId);
      if (!target || target.roomId !== id || target.state !== 'pending') throw Object.assign(new Error('Queue entry unavailable'),{status:404});
    } else if (action === 'media.next' || advance) {
      target = record ? next : old?.nextId && {mediaId:old.nextId};
      if (!target) return {status:'unsupported',message:'No next video is available.'};
    } else if (action === 'media.previous') {
      target = oldPosition < (record ? 5 : 3) && (record ? queue.lastHistory(id) : old?.previousId && {mediaId:old.previousId});
    } else if (!removing) target = {mediaId:args.mediaId};
    room.mediaTransition = true;
    try {
      await room.saving?.catch(() => {});
      const corpus = record && !(removing && !advance) ? await this.autoCorpus(id,actor) : undefined;
      if (target) {
        const plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
        prepared = target.mediaId === 'demo' ? this.demoMedia && {...this.demoMedia,id:'demo',resources:new Map()} :
          await plex.prepare(target.mediaId,'direct',false,undefined,undefined,{sourceOnly:true});
        if (!prepared) return {status:'failed',message:'Test video is unavailable.'};
        if (record) {
          prepared.roomServerId = await this.roomState.identify(prepared);
          if (target.serverId && (target.serverId !== prepared.roomServerId || Math.abs(target.duration-prepared.duration) > .5 ||
              prepared.source?.type && target.type !== prepared.source.type)) throw Object.assign(new Error('The queued video changed; choose it again from the library'),{status:409});
        }
        if (this.hub.plexFor && (await this.hub.plexFor(actor)).principal !== plex.principal) return {status:'unavailable',message:'Plex access changed.'};
      }
      const person = room.viewers.get(actor.watchViewerId);
      if (countdown && (!person || person.alive && !await person.alive()) || actor.watchCurrent && !await actor.watchCurrent() ||
          !await this.canView(room,actor) || !valid()) return {status:'unavailable',message:'Room changed or command expired.'};
      if (record) {
        queue.assertRevision(queue.room(id),record.queueRevision);
        const position = this.position(room);
        let saving;
        if (action === 'media.next' || advance) saving = queue.next(id,actor.userId,{currentPosition:countdown || room.endedVersion === version ? old.duration : position,
          outcome:countdown || room.endedVersion === version ? 'completed' : 'skipped',expectedRevision:record.queueRevision,currentEntryId:current?.id,nextEntryId:target.id,autoCorpus:corpus,guard:valid,discardCurrent:!!advance});
        else if (removing) saving = queue.remove(id,actor.userId,args.entryId,record.queueRevision,{allowCurrent:true});
        else if (replay) saving = queue.historyReplay(id,actor.userId,target.id,{resume:args.resume,restore,expectedRevision:record.queueRevision},position);
        else if (playEntry) saving = queue.playEntry(id,actor.userId,target.id,{skipPrevious:!!args.skipPrevious,currentPosition:position,expectedRevision:record.queueRevision,autoCorpus:corpus,guard:valid,initialAdd});
        else if (action === 'media.previous') saving = queue.previous(id,actor.userId,oldPosition,5);
        else saving = queue.playNow(id,actor.userId,this.queueItem({...prepared,type:prepared.source?.type || 'movie'},prepared.roomServerId),position,{initialAdd});
        room.transitionCommit = saving;
        await saving;
        this.roomState.apply(room,this.roomState.store.get(id));
      }
      // The durable transaction is the transition's commit point. Close waits
      // for it; later controls apply to the newly adopted generation.
      room.pauseAt = room.startAt = undefined;
      if (removing && !advance) {
        this.cancelAutoplay(room); clearPlaybackEnd(room); this.unloadQueueMedia(room);
      } else if (prepared) {
        room.media = prepared; room.mediaVersion = randomUUID(); room.readinessVersion = undefined;
        room.position = record ? queue.current(id).position : 0; room.changedAt = Date.now();
        if (room.recovery) this.roomState.finishRecovery(room);
        this.dropMedia(room); room.s.state.paused = true; room.manualPaused = initialAdd && !this.roomState.store.get(id).autoplay; room.initialGate = true;
        this.beginReadiness(room); room.initialViewers = new Set(room.viewers.keys()); room.s.state.seekable = true;
        void this.plex.stop(old); adopted = true;
      } else {
        this.cancelAutoplay(room); clearPlaybackEnd(room); room.position = 0; room.changedAt = Date.now();
        if (!room.s.state.paused || room.initialGate) {
          room.readinessVersion = randomUUID(); room.initialGate = true; room.s.state.paused = true;
          this.beginReadiness(room); room.initialViewers = new Set(room.viewers.keys());
          for (const viewer of room.viewers.values()) viewer.ready = false;
        }
      }
      room.autoplayError = undefined; room.revision++; room.lastActivity = Date.now();
      room.transitionCommit = undefined;
      if (record && action !== 'media.next' && !removing && corpus) {
        try { await queue.generate(id,actor.userId,corpus,{continuation:true}); this.roomState.apply(room,this.roomState.store.get(id)); }
        catch (error) { room.autoQueueError = error.message; }
      }
      return {status:'applied',message:'Viewing room updated.',...(initialAdd ? {added:queue.current(id),queueRevision:this.roomState.store.get(id).queueRevision} : {})};
    } catch (error) {
      room.autoplayError = error.status || error instanceof PlaybackError ? error.message : 'The next video could not be loaded. Check Plex and server storage.';
      room.revision++;
      return {status:'failed',message:room.autoplayError};
    } finally {
      room.transitionCommit = undefined; room.mediaTransition = false;
      if (prepared && !adopted) await this.plex.stop(prepared);
    }
  }
  async execute(room, input, actor, permitted) {
    const command = Engine.validate(input), { action, args } = command, s = room.s;
    if (room.saved) this.roomState.store.healthy();
    if (action === 'room.kick') {
      if (room.transitionCommit) await room.transitionCommit.catch(() => {});
      if (!room.saved || !permitted() || actor.watchCurrent && !await actor.watchCurrent() || !permitted()) return {status:'unavailable',message:'Room changed or command expired.'};
      const record = this.roomState.store.get(room.s.roomId), userId = args.userId;
      if (!this.hub.canRoom(room.s,actor,'kickParticipants') || userId === actor.userId || userId === record.creatorId ||
          RoomPolicy.role(record,userId) === 'host' && actor.userId !== record.creatorId && !this.hub.isAdmin(actor)) return {status:'forbidden',message:'You cannot kick this participant.'};
      const viewers = [...room.viewers.entries()].filter(([,viewer]) => viewer.userId === userId);
      if (!viewers.length) return {status:'unavailable',message:'This participant has already left.'};
      const now = Date.now(); room.kickedViewers ||= new Map();
      for (const [id,until] of room.kickedViewers) if (until <= now) room.kickedViewers.delete(id);
      for (const [id] of viewers) room.kickedViewers.set(id,now + RECONNECT_GRACE_MS);
      for (const [id,viewer] of room.disconnectedViewers) if (viewer.userId === userId) { room.kickedViewers.set(id,now + RECONNECT_GRACE_MS); room.disconnectedViewers.delete(id); }
      for (const socket of new Set(viewers.map(([,viewer]) => viewer.watchSocket).filter(Boolean))) socket.watchKick?.(room.s.roomId);
      for (const [id,viewer] of viewers) await this.leave(room,viewer.actor,id,'kicked');
      return {status:'applied',message:'Participant removed. They may rejoin.'};
    }
    if (!permitted()) return { status: 'unavailable', message: 'Room changed or command expired.' };
    if (room.transitionCommit) return {status:'unavailable',message:'Wait for the current queue transition to finish.'};
    const endpointSeek = room.saved && room.media && (action === 'media.seek.end' ||
      action === 'media.seek.absolute' && args.seconds >= room.media.duration ||
      action === 'media.seek.relative' && this.position(room) + args.seconds >= room.media.duration);
    const endpointPlay = room.saved && room.media && ['media.play','media.toggle'].includes(action) &&
      (room.endedVersion === room.mediaVersion || this.position(room) >= room.media.duration - .1);
    if (endpointSeek || endpointPlay) {
      if (!room.viewers.size || room.mediaTransition || room.queueEditing) return {status:'unavailable',message:'Wait for an available viewing room.'};
      if (endpointPlay && room.endedVersion === room.mediaVersion && this.roomState.queue.peekNext(s.roomId)) {
        if (!this.hub.canRoom(s,actor,'chooseMedia')) return {status:'forbidden',message:'Choosing the next video requires video-selection permission.'};
        this.cancelAutoplay(room); clearPlaybackEnd(room);
        return this.changeQueueMedia(room,{action:'media.next',args:{}},actor,permitted);
      }
      // Endpoint intent is an authorized command, not decoded watch evidence.
      // Never ask a decoder to become ready beyond its last presented frame.
      if (room.endedVersion !== room.mediaVersion || !this.roomState.queue.peekNext(s.roomId)) {
        this.cancelAutoplay(room); clearPlaybackEnd(room);
        if (room.recovery) this.roomState.finishRecovery(room);
        room.manualPaused = false; room.endedVersion = undefined;
        await this.finishQueueMedia(room,{mediaVersion:room.mediaVersion,epoch:s.epoch});
      }
      return {status:'applied',message:'Current video finished.'};
    }
    if (action.startsWith('queue.')) return this.queueCommand(s.roomId,command,actor,permitted);
    if (action.startsWith('media.autoplay.')) {
      if (!room.saved) return {status:'unsupported',message:'Autoplay requires a saved room.'};
      this.cancelAutoplay(room); clearPlaybackEnd(room);
      if (action === 'media.autoplay.set') {
        await this.roomState.queue.setAutoplay(s.roomId,actor.userId,args.enabled);
        this.roomState.apply(room,this.roomState.store.get(s.roomId));
      }
      return {status:'applied',message:'Autoplay updated.'};
    }
    if (!actor.watchQueueAdvance && (['media.load','media.next','media.previous','media.pause','media.play','media.toggle'].includes(action) || action.startsWith('media.seek.'))) {
      this.cancelAutoplay(room); clearPlaybackEnd(room);
      if (action !== 'media.next') room.endedVersion = undefined;
    }
    if (['media.load','media.next','media.previous'].includes(action)) return this.changeQueueMedia(room,command,actor,permitted);
    this.settle(room);
    if (action.startsWith('media.ready.')) {
      if (!(room.saved ? this.hub.canRoom(s,actor,'chooseMedia') : this.hub.canManage(s, actor)) || !room.initialGate || !room.readinessTimedOut || args.readinessId !== room.readinessId) return { status:'unavailable', message:'This readiness choice expired.' };
      if (action === 'media.ready.start') {
        const ready = [...room.initialViewers].filter(id => { const v = room.viewers.get(id); return v?.ready && v.version === room.mediaVersion; });
        if (!ready.length) return { status:'unavailable', message:'No viewer is ready yet.' };
        // This host command is already in the validated Engine handler. Commit
        // the override without an awaited second dispatch or an expired choice.
        room.initialViewers = new Set(ready); room.initialGate = false; room.readinessTimedOut = false;
        room.readinessStartAt = undefined; room.changedAt = Date.now(); room.s.state.paused = false;
        room.startAt = room.changedAt + this.controlLead(room);
      } else if (action === 'media.ready.wait') {
        this.beginReadiness(room, Date.now(), 15000); await this.maybeStart(room);
      } else {
        room.manualPaused = true; room.readinessTimedOut = false; room.readinessStartAt = undefined;
      }
      room.revision++; this.refresh(room);
      return { status:'applied', message:'Readiness choice applied.' };
    }
    if (room.readinessTimedOut && ['media.play','media.toggle','media.pause'].includes(action)) return { status:'unavailable', message:'The host must choose whether to start, wait or cancel.' };
    if (['media.quality.set','media.tracks.set','media.stream.refresh','media.volume.set','media.mute','media.unmute','media.reporting.set'].includes(action)) {
      const viewer = actor.surface === 'web' && room.viewers.get(actor.watchViewerId);
      if (!viewer || viewer.userId !== actor.userId) return { status: 'unsupported', message: 'Use your watch player for personal audio and quality.' };
      if (action === 'media.tracks.set') return this.changeTracks(room,viewer,args,actor,permitted);
      if (action === 'media.stream.refresh') return this.refreshStream(room,viewer,args,actor,permitted);
      if (action === 'media.quality.set') {
        if (!room.media || room.media.kind === 'demo') return { status: 'unsupported', message: 'Quality is unavailable for this video.' };
        if (viewer.preparing || viewer.updating) return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
        const version = room.mediaVersion;
        if(!args.compatible && !args.fallback)viewer.preferredQuality=Engine.qualityId(args.quality);
        const fallback = args.fallback || viewer.fallback;
        viewer.updating = true;
        try {
          const result=await this.replaceViewer(room,actor,actor.watchViewerId,async (authorized,source)=>
            this.prepareQuality(room,viewer,await (this.hub.plexFor?this.hub.plexFor(actor):this.plex),source,args.quality,args.compatible===true || !!viewer.compatible,fallback,authorized),{permitted});
          if(result.status!=='applied')return result;
          viewer.quality=viewer.media.quality;
          viewer.compatible=args.compatible===true || !!viewer.compatible;viewer.fallback=fallback;
        } catch(error) {
          if(error instanceof PlaybackError)return {status:'failed',message:error.message};
          throw error;
        } finally {viewer.updating=false;}
      } else if (action === 'media.volume.set') { viewer.volume = args.percent; viewer.muted = false; }
      else if (action === 'media.mute' || action === 'media.unmute') viewer.muted = action === 'media.mute';
      else if (action === 'media.reporting.set') {
        if (typeof args.activity === 'boolean') viewer.plexReporting = args.activity;
        if (typeof args.watchState === 'boolean') viewer.plexWatchState = args.watchState;
        this.reporting?.updateConsent(viewer, { activity: viewer.plexReporting, watchState: viewer.plexWatchState });
        return { status: 'applied', message: 'Your reporting preferences updated.', state: Engine.snapshot({ ...s.state, volume: viewer.volume, muted: viewer.muted }) };
      }
      return { status: 'applied', message: 'Your player updated.', state: Engine.snapshot({ ...s.state, volume: viewer.volume, muted: viewer.muted }) };
    }
    if (actor.watchAutoplayVersion && (room.manualPaused || room.mediaVersion !== actor.watchAutoplayVersion || room.readinessVersion !== actor.watchReadinessVersion)) return { status: 'unavailable', message: 'Autoplay was cancelled.' };
    if (!action.startsWith('room.') && action !== 'media.load' && !room.viewers.size) return { status: 'unavailable', message: 'No viewer is connected.' };
    if (action.startsWith('media.') && action !== 'media.load' && !room.media) return { status: 'unavailable', message: 'Choose a video first.' };
    if (['media.play','media.toggle'].includes(action) && room.media?.kind !== 'demo') {
      const version = room.mediaVersion, plex = this.hub.plexFor ? await this.hub.plexFor(actor) : this.plex;
      if (plex.playableItem) await plex.playableItem(room.media.id);
      if (!permitted() || room.mediaVersion!==version || !await this.canView(room,actor) || !permitted() || this.hub.plexFor && (await this.hub.plexFor(actor)).principal!==plex.principal) return {status:'unavailable',message:'Room changed or command expired.'};
    }
    if (room.recovery && (['media.pause','media.play','media.toggle'].includes(action) || action.startsWith('media.seek.'))) this.roomState.finishRecovery(room);
    const now = Date.now(), pausePending = !!room.pauseAt, wasPlaying = !s.state.paused && !(room.startAt > now);
    const oldPosition = this.position(room, now);
    room.position = oldPosition; room.changedAt = now;
    if (pausePending && action.startsWith('media.seek.')) s.state.paused = true;
    if (['media.load','media.next','media.previous','media.pause','media.play','media.toggle'].includes(action) || action.startsWith('media.seek.')) room.pauseAt = undefined;
    if(['media.load','media.next','media.previous','media.pause','media.play','media.toggle'].includes(action)||action.startsWith('media.seek.'))room.startAt=undefined;
    switch (action) {
      case 'media.pause':
        room.manualPaused = true; room.readinessStartAt = undefined; room.readinessTimedOut = false;
        if (wasPlaying && !room.initialGate) room.pauseAt = now + this.controlLead(room);
        else s.state.paused = true;
        break;
      case 'media.play':
        if (room.recovery) this.roomState.finishRecovery(room);
        if (room.position >= room.media.duration - .1) room.position = 0;
        if (room.manualPaused && room.initialGate) this.beginReadiness(room, now);
        room.manualPaused = false; s.state.paused = room.initialGate;
        if(actor.watchAutoplayVersion===room.mediaVersion && !room.initialGate)room.startAt=Math.max(room.viewers.size > 1 ? room.readinessStartAt || 0 : 0, now + this.controlLead(room));
        else if (!room.initialGate && !wasPlaying) room.startAt = now + this.controlLead(room);
        break;
      case 'media.toggle':
        if (room.recovery) this.roomState.finishRecovery(room);
        // A play intent at the end restarts even before the expiry sweep pauses it.
        if (room.position >= room.media.duration - .1) { room.position = 0; s.state.paused = true; }
        room.manualPaused = !pausePending && (!s.state.paused || room.initialGate && !room.manualPaused);
        if (room.initialGate) {
          if (room.manualPaused) room.readinessStartAt = undefined;
          else this.beginReadiness(room, now);
          s.state.paused = true;
        } else if (room.manualPaused && wasPlaying) room.pauseAt = now + this.controlLead(room);
        else { s.state.paused = room.manualPaused; if (!s.state.paused && !wasPlaying) room.startAt = now + this.controlLead(room); }
        break;
      case 'media.seek.relative': room.position = Math.max(0, Math.min(room.media.duration - .05, room.position + args.seconds)); break;
      case 'media.seek.absolute': room.position = Math.max(0, Math.min(room.media.duration - .05, args.seconds)); break;
      case 'media.seek.start': room.position = 0; break;
      case 'media.seek.end': room.position = Math.max(0, room.media.duration - .05); break;
      case 'room.visibility':
        if (room.saved) {
          const record = await this.roomState.store.edit(s.roomId,actor.userId,room.saved.revision,{action:'visibility',visibility:args.visibility});
          this.roomState.apply(room,record);
        } else s.visibility = args.visibility;
        room.disconnectedViewers.clear();
        this.refresh(room);
        break;
      case 'profile.save': room.profiles[args.slot] = { ...s.state.picture }; break;
      case 'profile.load': if (!room.profiles[args.slot]) return { status: 'unsupported', message: 'Save this profile first.' }; s.state.picture = { ...room.profiles[args.slot] }; break;
      default: s.state.picture = Engine.picture(s.state.picture, command);
    }
    if (action.startsWith('media.seek.')) {
      // Freeze the new target and discard acknowledgements from earlier seeks.
      // An explicit pause remains paused; seeking during playback resumes together.
      if (!s.state.paused || room.initialGate) {
        room.readinessVersion = randomUUID();
        room.initialGate = true; this.beginReadiness(room, now); room.initialViewers = new Set(room.viewers.keys());
        s.state.paused = true;
        for (const viewer of room.viewers.values()) viewer.ready = false;
      }
    }
    if (action.startsWith('room.')) s.epoch = randomUUID();
    s.state.profileSlots = Object.keys(room.profiles).map(Number); room.revision++; room.lastActivity = now; this.refresh(room, now);
    room.feedback = { revision: room.revision, action, args, sender: Engine.senderName(actor.name), at: now };
    if (room.saved && (['media.load','media.next','media.previous','media.pause','media.play','media.toggle'].includes(action) || action.startsWith('media.seek.'))) await this.roomState.save(room);
    if (['media.play', 'media.toggle', 'room.visibility'].includes(action) && room.initialGate && !room.manualPaused) await this.maybeStart(room);
    return { status: 'applied', message: 'Viewing room updated.', ...(actor.surface === 'web' ? { state: Engine.snapshot(s.state) } : {}) };
  }
  async changeTracks(room,viewer,args,actor,permitted) {
    const current = viewer.media, version = room.mediaVersion;
    if (!current?.tracks || current.kind!=='plex') return {status:'unsupported',message:'Audio and subtitles are unavailable for this video.'};
    if (viewer.preparing || viewer.updating) return {status:'unavailable',message:'Wait for your stream to finish loading.'};
    if (args.mediaVersion!==version || args.streamVersion!==viewer.streamVersion) return {status:'unavailable',message:'Track selection expired. Choose again for the current video.'};
    const choices = {...viewer.trackChoice,audioId:args.audioId ?? viewer.trackChoice?.audioId ?? 'auto',subtitleId:args.subtitleId ?? viewer.trackChoice?.subtitleId ?? 'auto',
      subtitleMode:args.subtitleMode ?? viewer.trackChoice?.subtitleMode ?? 'auto'};
    if (args.audioId==='auto') choices.audioIntent=undefined;
    if (['auto','off'].includes(args.subtitleId)) choices.subtitleIntent=undefined;
    let selection;
    viewer.updating = true;
    try {
      selection = Tracks.select(current.tracks,choices);
      if (selection.subtitle?.delivery==='burn' && args.subtitleOffset!==undefined && args.subtitleOffset!==0) throw new PlaybackError('Plex burned subtitles cannot be shifted in this player.');
      if (args.audioId && args.audioId!=='auto') choices.audioIntent=Tracks.intent(selection.audio);
      if (args.subtitleId && !['auto','off'].includes(args.subtitleId)) choices.subtitleIntent=Tracks.intent(selection.subtitle);
      const burnChanged=(selection.subtitle?.delivery==='burn' || current.selection.subtitle?.delivery==='burn') &&
        (selection.subtitle?.id!==current.selection.subtitle?.id || selection.subtitle?.delivery!==current.selection.subtitle?.delivery);
      if (selection.audio?.id!==current.selection.audio?.id || burnChanged || current.playbackError) {
        const result=await this.replaceViewer(room,actor,actor.watchViewerId,async (authorized,source)=>
          this.prepareOutput(room,viewer,await (this.hub.plexFor?this.hub.plexFor(actor):this.plex),source,viewer.quality,viewer.compatible,selection.subtitle?.delivery==='burn'?undefined:viewer.fallback,
            {...choices,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.roomId,version],authorized}),{permitted});
        if(result.status!=='applied')return result;
        if(selection.subtitle?.delivery==='burn')viewer.fallback=undefined;
      } else {
        const alive=!viewer.alive || await viewer.alive(),access=await this.canView(room,actor);
        if(!alive || !access || !permitted() || version!==room.mediaVersion || viewer.media!==current || room.viewers.get(actor.watchViewerId)!==viewer)
          return {status:'unavailable',message:'Room changed or command expired.'};
        if (selection.subtitle?.id!==current.selection.subtitle?.id) {
          current.subtitleAbort.abort(); current.subtitleAbort=new AbortController(); current.subtitleCache?.clear(); SubtitleResources.clear(current); current.captionVersion=randomUUID();
        }
        current.selection=selection;
      }
      viewer.trackChoice=choices;
      if (selection.subtitle?.delivery==='burn') viewer.subtitleOffset=0;
      else if (args.subtitleOffset!==undefined) viewer.subtitleOffset=args.subtitleOffset;
      return {status:'applied',message:'Your audio and subtitles updated.'};
    } catch (error) {
      return {status:'failed',message:error instanceof PlaybackError ? error.message : 'Audio and subtitles could not be updated. Your previous selection is unchanged.'};
    } finally { viewer.updating=false; }
  }
  async refreshStream(room,viewer,args,actor,permitted) {
    const current=viewer.media, version=room.mediaVersion;
    if (!current || current.kind!=='plex' || !room.media || current.format!=='hls') return {status:'unsupported',message:'This stream cannot be refreshed.'};
    if (viewer.preparing || viewer.updating) return {status:'unavailable',message:'Wait for your stream to finish loading.'};
    if (args.mediaVersion!==version || args.streamVersion!==viewer.streamVersion) return {status:'unavailable',message:'Stream refresh expired.'};
    viewer.updating=true;
    try {
      const result=await this.replaceViewer(room,actor,actor.watchViewerId,async (authorized,source)=>
        this.prepareOutput(room,viewer,await (this.hub.plexFor?this.hub.plexFor(actor):this.plex),source,viewer.quality,viewer.compatible,viewer.fallback,
          {...viewer.trackChoice,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.roomId,version],excludeLease:current.hlsLease,authorized}),
        {permitted,accept:media=>media.format==='hls'});
      return result.status==='applied'?{status:'applied',message:'Your stream refreshed.'}:result;
    } catch(error) {
      return {status:'failed',message:error instanceof PlaybackError ? error.message : 'Plex could not refresh this stream.'};
    } finally {viewer.updating=false;}
  }

  remove(id, save = true) {
    const room = this.rooms.get(id); if (!room) return;
    if (room.transitionCommit) return room.transitionCommit.catch(() => {}).then(() => this.remove(id,save));
    this.cancelAutoplay(room); clearPlaybackEnd(room);
    const saved = room.saved && save ? this.roomState.save(room,{closing:!this.shuttingDown}).then(async () => {
      if (!this.shuttingDown) { this.roomState.recoveries.delete(id); await this.roomState.deleteEmpty(id); }
    }) : Promise.resolve();
    if (room.saved) {
      this.roomState.closing.set(id,saved);
      saved.then(() => this.roomState.closing.delete(id), () => this.roomState.closing.delete(id));
    }
    room.s.state.paused = true; room.s.epoch = randomUUID();
    this.dropMedia(room, 'room-closed');
    this.hub.rooms.delete(id); this.rooms.delete(id); room.s.socket.readyState = 3; void this.plex.stop(room.media);
    this.hub?.config?.logger?.info('Room', `Room closed (${id})`);
    return saved;
  }
  sweep() { for (const room of this.rooms.values()) this.refresh(room); }
  async close() {
    this.shuttingDown = true;
    await Promise.all([...this.rooms.keys()].map(id => this.remove(id)));
    this.tracking.close(); return Promise.all([this.roomState?.close(), this.plex.close?.(), this.reporting?.close()]);
  }
}
module.exports = { Watch, syncQualityParticipants };
