// @ts-check
'use strict';
/** @typedef {import('./types').Room} Room */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').SessionDescriptor} SessionDescriptor */
/** @typedef {import('./types').EngineCommand} EngineCommand */

const { randomUUID } = require('node:crypto');
const Engine = require('../extension/engine');
const { eligible, viewEligible, isHost, sameVoice, canWatch } = require('./core');
const { PlaybackError } = require('./av1');
const { PlaybackTracking } = require('./playback-tracking');
const Tracks = require('./media-tracks');
const SubtitleResources = require('./subtitle-resources');
const RECONNECT_GRACE_MS = 60000;
// Covers the normal 1 s state poll plus a 300+ ms RTT and scheduling margin.
// Only the initial readiness release waits; ongoing recovery never reschedules it.
const INITIAL_START_LEAD_MS = 1750;

class Watch {
  constructor(hub, plex, demoMedia, registry) { this.tracking = new PlaybackTracking(registry); this.hub = hub; this.plex = plex; this.demoMedia = demoMedia; this.rooms = new Map(); }
  create(actor) {
    if (actor.surface !== 'web' || !canWatch(this.hub.access,actor.userId) || actor.guildId !== this.hub.config.guildId || !this.hub.config.channels.includes(actor.channelId)) throw new Error('Only authenticated eligible users can create a viewing session');
    if (this.rooms.size >= 4) throw new Error('Close an existing viewing session first');
    const socket = { readyState: 1 }, id = randomUUID();
    const s = { sessionId: id, epoch: randomUUID(), alias: this.rooms.size ? 'plex.' + id.slice(0, 8) : 'plex', kind: 'watch',
      ownerId: actor.userId, ownerName: actor.name, hostId: actor.userId, hostName: actor.name, socket, visibility: 'public', mode: 'guild', enabled: false, reachable: true, lastSeen: Date.now(),
      controls: { ...Engine.CONTROLS }, state: { picture: { ...Engine.DEFAULT }, paused: true, muted: false, volume: 50, seekable: false, profileSlots: [] } };
    const room = { s, media: null, mediaVersion: randomUUID(), revision: 0, position: 0, changedAt: Date.now(), viewers: new Map(), disconnectedViewers: new Map(), profiles: {}, lastActivity: Date.now(),
      initialGate: false, manualPaused: false, initialViewers: new Set(), hadViewers: false };
    s.execute = (command, actor, permitted) => this.execute(room, command, actor, permitted);
    s.viewers = room.viewers;
    this.rooms.set(id, room); this.hub.sessions.set(id, s); return id;
  }
  position(room, now = Date.now()) {
    const elapsed=room.startAt?Math.max(0,now-Math.max(room.changedAt,room.startAt)):now-room.changedAt;
    return Math.min(room.media?.duration || 0, Math.max(0, room.position + (room.s.state.paused ? 0 : elapsed / 1000)));
  }
  revokeConsent(room) {
    room.s.enabled = false; room.s.mode = 'owner'; room.s.epoch = randomUUID(); room.revision++; this.hub.cancel(room.s.sessionId);
  }
  dropMedia(room, reason = 'media-changed') {
    room.disconnectedViewers.clear();
    for (const viewer of room.viewers.values()) {
      this.tracking.end(viewer, reason); void this.plex.stop(viewer.media); viewer.media = undefined; viewer.ready = false;
      if (reason === 'media-changed') {
        viewer.compatible = false; viewer.fallback = undefined;
        viewer.subtitleOffset=0;
        if (viewer.trackChoice) { viewer.trackChoice.audioId='auto'; if (viewer.trackChoice.subtitleId!=='off') viewer.trackChoice.subtitleId='auto'; }
      }
    }
  }
  async prepareViewer(room, actor, viewerId) {
    const viewer = room.viewers.get(viewerId), version = room.mediaVersion;
    if (!viewer || viewer.userId !== actor.userId || !room.media) return;
    const plex=this.hub.plexFor?await this.hub.plexFor(actor):this.plex;
    if (viewer.media && viewer.mediaVersion === version && (!viewer.media.principal||viewer.media.principal===plex.principal)) return viewer.media;
    // Collapse concurrent polls for this one viewer, never across viewers.
    if (viewer.preparing) { await viewer.preparing; return this.prepareViewer(room, actor, viewerId); }
    const prepare = async () => {
      const choices = this.plex.qualities?.(room.media);
      if (choices && !choices.some(q => q.id === Engine.qualityId(viewer.quality))) {
        const requested = Engine.QUALITIES.find(q => q.id === Engine.qualityId(viewer.quality));
        viewer.quality = (choices.find(q => q.bitrate && q.bitrate <= requested?.bitrate && q.height <= requested?.height) || choices[0]).id;
      }
      const authorized=async()=>room.mediaVersion===version && room.viewers.get(viewerId)===viewer && await this.canView(room,actor) && (!viewer.alive || await viewer.alive());
      let media;
      try { media=room.media.kind === 'demo' ? room.media : await plex.prepare(room.media.id, viewer.quality, viewer.compatible, room.media, viewer.fallback,{...viewer.trackChoice,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.sessionId,version],shareWaitMs:8000,authorized}); }
      catch(error) {
        if(!(error instanceof PlaybackError) || !error.media)throw error;
        // Keep the private catalog reachable so a failed automatic subtitle
        // conversion still offers Off/another track rather than stranding UI.
        media=error.media; media.format='unavailable'; media.playbackError=error.message;
      }
      if (room.mediaVersion !== version || room.viewers.get(viewerId) !== viewer || !await this.canView(room, actor) || viewer.alive && !await viewer.alive()) {
        if (media !== room.media) await this.plex.stop(media); return;
      }
      this.tracking.end(viewer, 'stream-changed'); const old=viewer.media;viewer.media = media; viewer.mediaVersion = version; viewer.streamVersion = randomUUID();if(old&&old!==media)void this.plex.stop(old);
    };
    viewer.preparing = prepare();
    try { await viewer.preparing; } finally { viewer.preparing = undefined; }
    return viewer.media;
  }
  refresh(room, now = Date.now()) {
    room.s.lastSeen = now;
    room.s.state.position = this.position(room, now); room.s.state.duration = room.media?.duration || 0;
    let pruned = false, hostTimedOut = false;
    for (const [id, saved] of room.disconnectedViewers) if (saved.expires <= now || saved.mediaVersion !== room.mediaVersion) room.disconnectedViewers.delete(id);
    for (const viewer of room.viewers.values()) this.tracking.expire(viewer);
    for (const [id, viewer] of room.viewers) if (now - viewer.at > 10000 || room.s.visibility === 'private' && viewer.userId !== room.s.hostId && !this.hub.isAdmin(viewer.actor)) {
      if (now - viewer.at > 10000 && (room.s.visibility !== 'private' || viewer.userId === room.s.hostId || this.hub.isAdmin(viewer.actor))) {
        // Preserve only personal playback settings for the same tab's short
        // reconnect. A fresh stream and observation epoch are always required.
        room.disconnectedViewers.set(id, { userId:viewer.userId, mediaVersion:room.mediaVersion, expires:now+RECONNECT_GRACE_MS,
          trackChoice:viewer.trackChoice && {...viewer.trackChoice}, subtitleOffset:viewer.subtitleOffset,
          quality:viewer.quality, compatible:viewer.compatible, fallback:viewer.fallback,
          volume:viewer.volume, muted:viewer.muted, joinedAt:viewer.joinedAt });
        if (room.disconnectedViewers.size > 128) room.disconnectedViewers.delete(room.disconnectedViewers.keys().next().value);
      }
      if (viewer.userId === room.s.hostId && now - viewer.at > 10000) hostTimedOut = true;
      this.tracking.end(viewer, room.s.visibility === 'private' ? 'privacy-revoked' : 'disconnected'); void this.plex.stop(viewer.media); room.viewers.delete(id); room.initialViewers.delete(id); pruned = true;
    }
    if (hostTimedOut) this.revokeConsent(room);
    if (room.viewers.size && now - (room.lastPing || 0) >= 15000) {
      room.lastPing = now;
      for (const viewer of room.viewers.values()) if (viewer.media?.transcodeId) void this.plex.ping(viewer.media);
    }
    if (room.media && !room.s.state.paused && room.s.state.position >= room.media.duration) {
      room.position = room.media.duration; room.changedAt = now; room.s.state.paused = true; room.revision++;
    }
    if (room.hadViewers && !room.viewers.size) {
      const savedHost = room.disconnectedViewers.get(room.hostViewerId);
      if (savedHost?.userId === room.s.hostId) {
        // An empty room has no command target. Only its original host tab may
        // reactivate it during the bounded, same-media reconnect grace.
        room.reconnecting = true; this.hub.sessions.delete(room.s.sessionId); return;
      }
      this.remove(room.s.sessionId); return;
    }
    if (room.hadViewers && ![...room.viewers.values()].some(viewer => viewer.userId === room.s.hostId)) void this.transfer(room);
    else if (pruned) void this.maybeStart(room);
    if (!room.hadViewers && now - room.lastActivity > 30000) this.remove(room.s.sessionId);
  }
  async canView(room, actor) {
    if (!room || this.rooms.get(room.s.sessionId) !== room) return false;
    if (room.reconnecting && (actor.surface !== 'web' || actor.userId !== room.s.hostId)) return false;
    if (!canWatch(this.hub.access,actor.userId)) {
      try { if (!await (this.hub.access?.refreshWatch||this.hub.access?.refresh)?.(actor.userId)) return false; } catch { return false; }
    }
    if(room.media?.kind==='plex'&&this.hub.plexFor){try{if(!await (await this.hub.plexFor(actor)).allows(room.media.id))return false;}catch{return false;}}
    return viewEligible(room.s, actor, this.hub.config, Date.now(), this.hub.access, this.hub.isAdmin(actor));
  }
  async list(actor, activity = false) {
    const rooms = [];
    for (const room of this.rooms.values()) {
      this.refresh(room); if (!this.rooms.has(room.s.sessionId)) continue;
      if (room.reconnecting && (actor.surface !== 'web' || actor.userId !== room.s.hostId)) continue;
      const accessible = await this.canView(room, actor);
      if (!accessible && !(activity && room.s.visibility === 'private' && sameVoice(room.s, actor, this.hub.access))) continue;
      const members = [...new Map([...room.viewers.values()].map(v => [v.userId, v.name])).values()];
      rooms.push({id:room.s.sessionId, hostName:room.s.hostName, visibility:room.s.visibility, viewers:members.length,
        ...(accessible ? {members,canManage:this.hub.canManage(room.s, actor)} : {locked:true})});
    }
    return rooms;
  }
  async transfer(room) {
    if (room.transferring || this.rooms.get(room.s.sessionId) !== room) return;
    room.transferring = true;
    const oldHost = room.s.hostId;
    try {
      const candidates = [...room.viewers.entries()].filter(([, v]) => v.userId !== oldHost).sort((a, b) => a[1].joinedAt - b[1].joinedAt);
      for (const [viewerId, candidate] of candidates) {
        try { if (candidate.alive && !await candidate.alive()) continue; } catch { continue; }
        let member;
        try { member = !!await (this.hub.access?.refreshWatch||this.hub.access?.refresh)?.(candidate.userId);if(member&&room.media?.kind==='plex'&&this.hub.plexFor)member=await (await this.hub.plexFor(candidate.actor)).allows(room.media.id); } catch { member = false; }
        if (this.rooms.get(room.s.sessionId) !== room || room.s.hostId !== oldHost) return;
        if ([...room.viewers.values()].some(v => v.userId === oldHost)) return;
        if (!member || room.s.visibility !== 'public' || room.viewers.get(viewerId) !== candidate || Date.now() - candidate.at >= 10000) continue;
        room.s.hostId = candidate.userId; room.s.hostName = candidate.name; room.hostViewerId = viewerId;
        room.s.epoch = randomUUID(); room.revision++; this.hub.cancel(room.s.sessionId);
        await this.maybeStart(room);
        return;
      }
      this.remove(room.s.sessionId);
    } finally { room.transferring = false; }
  }
  async leave(room, actor, viewerId, reason = 'left') {
    if (room.disconnectedViewers.get(viewerId)?.userId === actor.userId) {
      room.disconnectedViewers.delete(viewerId);
      if (room.reconnecting && viewerId === room.hostViewerId) { this.remove(room.s.sessionId); return; }
    }
    if (room.viewers.get(viewerId)?.userId !== actor.userId) return;
    const hostLeft = actor.userId === room.s.hostId;
    this.tracking.end(room.viewers.get(viewerId), reason); void this.plex.stop(room.viewers.get(viewerId).media);
    room.viewers.delete(viewerId); room.initialViewers.delete(viewerId); room.revision++;
    if (!room.viewers.size) { this.remove(room.s.sessionId); return; }
    if (hostLeft) this.revokeConsent(room);
    if (![...room.viewers.values()].some(v => v.userId === room.s.hostId)) await this.transfer(room);
    await this.maybeStart(room);
  }
  async ready(room, actor, viewerId, version, ready) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer || viewer.userId !== actor.userId || room.mediaVersion !== version || typeof ready !== 'boolean') throw new Error('Invalid readiness');
    viewer.ready = ready; viewer.version = version; viewer.at = Date.now();
    await this.maybeStart(room);
  }
  async maybeStart(room) {
    if (!room.initialGate || room.manualPaused || room.starting || this.rooms.get(room.s.sessionId) !== room) return;
    const viewers = [...room.initialViewers].map(id => room.viewers.get(id)).filter(Boolean);
    const host = [...room.viewers.values()].find(v => v.userId === room.s.hostId);
    if (!viewers.length || !host || viewers.some(v => !v.ready || v.version !== room.mediaVersion)) return;
    room.starting = true;
    const version = room.mediaVersion;
    try {
      if (host.alive && !await host.alive()) return;
      if (room.manualPaused || room.mediaVersion !== version || [...room.initialViewers].some(id => {
        const viewer = room.viewers.get(id); return viewer && (!viewer.ready || viewer.version !== version);
      })) return;
      room.initialGate = false;
      const result = await this.hub.dispatch({ ...host.actor, watchAutoplayVersion: version }, { sessionId: room.s.sessionId, action: 'media.play' });
      if (result.status !== 'applied' && room.mediaVersion === version) room.initialGate = true;
    } finally { room.starting = false; }
  }
  snapshot(room, actor, viewerId, alive, quality = '720p') {
    const now = Date.now(); this.refresh(room, now); room.lastActivity = now;
    if (this.rooms.get(room.s.sessionId) !== room) throw new Error('Session unavailable');
    // A new host page never silently inherits remote consent from a previous
    // host tab. Existing viewers can keep the server session alive in between.
    const oldViewer = room.viewers.get(viewerId);
    if (oldViewer && oldViewer.userId !== actor.userId) throw new Error('Viewer identity mismatch');
    const saved = !oldViewer && room.disconnectedViewers.get(viewerId);
    if (saved && saved.userId !== actor.userId) throw new Error('Viewer identity mismatch');
    if (room.reconnecting && (!saved || viewerId !== room.hostViewerId || actor.surface !== 'web' || actor.userId !== room.s.hostId ||
      !viewEligible(room.s, actor, this.hub.config, now, this.hub.access))) throw new Error('Session unavailable');
    if (saved) room.disconnectedViewers.delete(viewerId);
    if (room.reconnecting) { room.reconnecting = false; this.hub.sessions.set(room.s.sessionId, room.s); }
    if (isHost(room.s, actor) && !oldViewer && room.hostViewerId && room.hostViewerId !== viewerId) {
      room.s.enabled = false; room.s.mode = 'owner'; room.s.epoch = randomUUID(); room.revision++; this.hub.cancel(room.s.sessionId);
    }
    if (isHost(room.s, actor) && !oldViewer) room.hostViewerId = viewerId;
    room.hadViewers = true;
    const viewer = oldViewer || { observationEpoch: randomUUID(), quality: saved?.quality || (Engine.validQuality(quality) ? quality : '720p4'), volume: saved?.volume ?? 50, muted: saved?.muted ?? false,
      trackChoice:saved?.trackChoice, subtitleOffset:saved?.subtitleOffset, compatible:saved?.compatible, fallback:saved?.fallback,
      joinedAt: Math.min(now, saved?.joinedAt ?? now, ...[...room.viewers.values()].filter(v => v.userId === actor.userId).map(v => v.joinedAt)) };
    Object.assign(viewer, { at: now, userId: actor.userId, name: Engine.senderName(actor.name), actor: { ...actor }, ...(alive ? { alive } : {}) });
    room.viewers.set(viewerId, viewer);
    if (room.initialGate && !oldViewer) room.initialViewers.add(viewerId);
    const owner = this.hub.canManage(room.s, actor);
    room.transportSequence=(room.transportSequence||0)+1;
    return { id: room.s.sessionId, transportSequence:room.transportSequence, epoch: room.s.epoch, revision: room.revision, mediaVersion: room.mediaVersion, serverNow: now,
      startAt:room.startAt,
      title: room.media?.title || 'Choose something to watch', subtitle: room.media?.subtitle || '', mediaId: room.media?.id,
      observationEpoch: viewer.observationEpoch, format: viewer.media?.format, quality: room.media?.kind === 'demo' ? 'direct' : viewer.quality,
      videoCodec: viewer.media?.videoCodec, compatible: !!viewer.media?.compatible, streamVersion: viewer.streamVersion,
      audioCodec:viewer.media?.audioCodec,bitrate:viewer.media?.bitrate,
      mediaError:viewer.media?.playbackError,
      ...(viewer.media?.tracks ? {tracks:{...Tracks.publicCatalog(viewer.media.tracks),audioChoice:viewer.trackChoice?.audioId || 'auto',subtitleChoice:viewer.trackChoice?.subtitleId || 'auto',
        audioId:viewer.media.selection.audio?.id,subtitleId:viewer.media.selection.subtitle?.id,subtitleOffset:viewer.subtitleOffset || 0,
        subtitleDelivery:viewer.media.selection.subtitle?.delivery,subtitleMode:viewer.trackChoice?.subtitleMode || 'auto',
        subtitleError:viewer.media.selection.subtitle && !viewer.media.selection.subtitle.available ? viewer.media.selection.subtitle.reason : undefined}} : {}),
      qualities: this.plex.qualities?.(room.media) || Engine.QUALITIES,
      hasPrevious: !!room.media?.previousId, hasNext: !!room.media?.nextId,
      waitingForReady: room.initialGate && !room.manualPaused, hostName: room.s.hostName, canBrowse: owner, isHost:isHost(room.s,actor), adminMode:this.hub.isAdmin(actor),
      state: Engine.snapshot({ ...room.s.state, volume: viewer.volume, muted: viewer.muted }), canManage: owner, enabled: room.s.enabled, mode: room.s.mode, controls: { ...room.s.controls },
      visibility: room.s.visibility,
      sharingAvailable: !!this.hub.access?.options?.().available, canPlayback: owner || eligible(room.s, actor, this.hub.config, now, this.hub.access) && room.s.controls.playback,
      canTransform: owner || eligible(room.s, actor, this.hub.config, now, this.hub.access) && room.s.controls.transform, viewers: new Set([...room.viewers.values()].map(x => x.userId)).size,
      feedback: room.feedback };
  }
  async execute(room, input, actor, permitted) {
    const command = Engine.validate(input), { action, args } = command, s = room.s;
    if (!permitted()) return { status: 'unavailable', message: 'Session changed or command expired.' };
    if (['media.quality.set','media.tracks.set','media.stream.refresh','media.volume.set','media.mute','media.unmute'].includes(action)) {
      const viewer = actor.surface === 'web' && room.viewers.get(actor.watchViewerId);
      if (!viewer || viewer.userId !== actor.userId) return { status: 'unsupported', message: 'Use your watch player for personal audio and quality.' };
      if (action === 'media.tracks.set') return this.changeTracks(room,viewer,args,actor,permitted);
      if (action === 'media.stream.refresh') return this.refreshStream(room,viewer,args,actor,permitted);
      if (action === 'media.quality.set') {
        if (!room.media || room.media.kind === 'demo') return { status: 'unsupported', message: 'Quality is unavailable for this video.' };
        if (viewer.preparing || viewer.updating) return { status: 'unavailable', message: 'Wait for your stream to finish loading.' };
        if (this.plex.qualities && !this.plex.qualities(room.media).some(q => q.id === Engine.qualityId(args.quality))) return { status:'unsupported', message:'This quality exceeds the original source.' };
        const version = room.mediaVersion;
        const fallback = args.fallback || viewer.fallback;
        let media;
        viewer.updating = true;
        try {
          try { media = await (this.hub.plexFor?await this.hub.plexFor(actor):this.plex).prepare(room.media.id, args.quality, args.compatible === true || !!viewer.compatible, room.media, fallback,
            {...viewer.trackChoice,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.sessionId,version],shareWaitMs:8000,authorized:async()=>permitted() && version===room.mediaVersion && room.viewers.get(actor.watchViewerId)===viewer && await this.canView(room,actor) && (!viewer.alive || await viewer.alive())}); }
          catch (error) { if (error instanceof PlaybackError) return {status:'failed', message:error.message}; throw error; }
          const authorized=await this.canView(room,actor) && (!viewer.alive || await viewer.alive());
          if (!authorized || !permitted() || version !== room.mediaVersion || room.viewers.get(actor.watchViewerId) !== viewer) {
            await this.plex.stop(media); return { status: 'unavailable', message: 'Session changed or command expired.' };
          }
          this.tracking.end(viewer, 'stream-changed'); const old = viewer.media; viewer.media = media; viewer.mediaVersion = version; viewer.streamVersion = randomUUID();
          viewer.quality = args.quality; viewer.compatible = args.compatible === true || !!viewer.compatible; void this.plex.stop(old);
          viewer.fallback = fallback;
        } catch(error) {
          if(media && viewer.media!==media)await this.plex.stop(media);
          throw error;
        } finally { viewer.updating = false; }
      } else if (action === 'media.volume.set') { viewer.volume = args.percent; viewer.muted = false; }
      else viewer.muted = action === 'media.mute';
      return { status: 'applied', message: 'Your player updated.', state: Engine.snapshot({ ...s.state, volume: viewer.volume, muted: viewer.muted }) };
    }
    if (actor.watchAutoplayVersion && (room.manualPaused || room.mediaVersion !== actor.watchAutoplayVersion)) return { status: 'unavailable', message: 'Autoplay was cancelled.' };
    let prepared;
    const previous = action === 'media.previous' && this.position(room) < 3 && room.media?.previousId;
    const next = action === 'media.next' && room.media?.nextId;
    if (action === 'media.next' && !next) return { status: 'unsupported', message: 'No next video is available.' };
    if (action === 'media.load' || previous || next) {
      const id = action === 'media.load' ? args.mediaId : previous || next || room.media.id;
      prepared = id === 'demo' ? this.demoMedia && { ...this.demoMedia, id: 'demo', resources: new Map() } : await (this.hub.plexFor?await this.hub.plexFor(actor):this.plex).prepare(id, 'direct',false,undefined,undefined,{sourceOnly:true});
      if (!prepared) return { status: 'unsupported', message: 'Test video is unavailable.' };
      if (!permitted()) { await this.plex.stop(prepared); return { status: 'unavailable', message: 'Session changed or command expired.' }; }
    }
    if (!action.startsWith('session.') && !['media.load', 'status.get', 'help.get'].includes(action) && !room.viewers.size) return { status: 'unavailable', message: 'No viewer is connected.' };
    if (action.startsWith('media.') && action !== 'media.load' && !room.media) return { status: 'unavailable', message: 'Choose a video first.' };
    const now = Date.now(); room.position = this.position(room, now); room.changedAt = now;
    if(['media.load','media.next','media.previous','media.pause','media.play','media.toggle'].includes(action)||action.startsWith('media.seek.'))room.startAt=undefined;
    switch (action) {
      case 'media.load': case 'media.next': {
        const old = room.media; room.media = prepared; room.mediaVersion = randomUUID(); room.position = 0;
        this.dropMedia(room);
        s.state.paused = true; room.manualPaused = false; room.initialGate = true; room.initialViewers = new Set(room.viewers.keys());
        for (const viewer of room.viewers.values()) viewer.ready = false;
        s.state.seekable = true; void this.plex.stop(old); break;
      }
      case 'media.previous':
        room.position = 0;
        if (prepared) {
          const old = room.media; room.media = prepared; room.mediaVersion = randomUUID(); void this.plex.stop(old);
          this.dropMedia(room);
          s.state.paused = true; room.manualPaused = false; room.initialGate = true; room.initialViewers = new Set(room.viewers.keys());
          for (const viewer of room.viewers.values()) viewer.ready = false;
        }
        break;
      case 'media.pause': s.state.paused = true; room.manualPaused = true; break;
      case 'media.play':
        if (room.position >= room.media.duration - .1) room.position = 0;
        room.manualPaused = false; s.state.paused = room.initialGate;
        if(actor.watchAutoplayVersion===room.mediaVersion && !room.initialGate)room.startAt=now+INITIAL_START_LEAD_MS;
        break;
      case 'media.toggle':
        // A play intent at the end restarts even before the expiry sweep pauses it.
        if (room.position >= room.media.duration - .1) { room.position = 0; s.state.paused = true; }
        room.manualPaused = !s.state.paused;
        s.state.paused = room.manualPaused || room.initialGate; break;
      case 'media.seek.relative': room.position = Math.max(0, Math.min(room.media.duration - .05, room.position + args.seconds)); break;
      case 'media.seek.absolute': room.position = Math.max(0, Math.min(room.media.duration - .05, args.seconds)); break;
      case 'media.seek.start': room.position = 0; break;
      case 'media.seek.end': room.position = Math.max(0, room.media.duration - .05); break;
      case 'session.enable': s.enabled = true; break;
      case 'session.disable': s.enabled = false; break;
      case 'session.sharing': s.mode = args.mode; break;
      case 'session.visibility':
        s.visibility = args.visibility;
        room.disconnectedViewers.clear();
        if (s.visibility === 'private') for (const [id, viewer] of room.viewers) {
          if (viewer.userId === s.hostId || this.hub.isAdmin(viewer.actor)) continue;
          this.tracking.end(viewer, room.s.visibility === 'private' ? 'privacy-revoked' : 'disconnected'); void this.plex.stop(viewer.media); room.viewers.delete(id); room.initialViewers.delete(id);
        }
        break;
      case 'session.controls': s.controls[args.control] = args.allowed; break;
      case 'session.autojoin': return { status: 'unsupported', message: 'On join applies to Firefox player devices.' };
      case 'profile.save': room.profiles[args.slot] = { ...s.state.picture }; break;
      case 'profile.load': if (!room.profiles[args.slot]) return { status: 'unsupported', message: 'Save this profile first.' }; s.state.picture = { ...room.profiles[args.slot] }; break;
      case 'status.get': case 'help.get': break;
      default: s.state.picture = Engine.picture(s.state.picture, command);
    }
    if (action.startsWith('session.')) { s.epoch = randomUUID(); this.hub.cancel(s.sessionId); }
    s.state.profileSlots = Object.keys(room.profiles).map(Number); room.revision++; room.lastActivity = now; this.refresh(room, now);
    room.feedback = { revision: room.revision, action, args, sender: Engine.senderName(actor.name), at: now };
    if (['media.play', 'media.toggle', 'session.visibility'].includes(action) && room.initialGate && !room.manualPaused) await this.maybeStart(room);
    return { status: 'applied', message: 'Viewing session updated.', ...(actor.surface === 'web' ? { state: Engine.snapshot(s.state) } : {}) };
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
    let selection, replacement;
    viewer.updating = true;
    try {
      selection = Tracks.select(current.tracks,choices);
      if (selection.subtitle?.delivery==='burn' && args.subtitleOffset!==undefined && args.subtitleOffset!==0) throw new PlaybackError('Plex burned subtitles cannot be shifted in this player.');
      if (args.audioId && args.audioId!=='auto') choices.audioIntent=Tracks.intent(selection.audio);
      if (args.subtitleId && !['auto','off'].includes(args.subtitleId)) choices.subtitleIntent=Tracks.intent(selection.subtitle);
      const burnChanged=(selection.subtitle?.delivery==='burn' || current.selection.subtitle?.delivery==='burn') &&
        (selection.subtitle?.id!==current.selection.subtitle?.id || selection.subtitle?.delivery!==current.selection.subtitle?.delivery);
      if (selection.audio?.id!==current.selection.audio?.id || burnChanged || current.playbackError) {
        replacement = await (this.hub.plexFor?await this.hub.plexFor(actor):this.plex).prepare(room.media.id,viewer.quality,viewer.compatible,room.media,selection.subtitle?.delivery==='burn' ? undefined : viewer.fallback,
          {...choices,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.sessionId,version],authorized:async()=>permitted() && version===room.mediaVersion && viewer.media===current && await this.canView(room,actor) && (!viewer.alive || await viewer.alive())});
      }
      const alive = !viewer.alive || await viewer.alive();
      const access = await this.canView(room,actor);
      if (!alive || !access || !permitted() || version!==room.mediaVersion || viewer.media!==current || room.viewers.get(actor.watchViewerId)!==viewer) {
        if (replacement) await this.plex.stop(replacement);
        return {status:'unavailable',message:'Session changed or command expired.'};
      }
      if (replacement) {
        this.tracking.end(viewer,'stream-changed'); viewer.media=replacement; viewer.mediaVersion=version; viewer.streamVersion=randomUUID(); void this.plex.stop(current);
        if (selection.subtitle?.delivery==='burn') viewer.fallback=undefined;
      } else {
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
      if (replacement) await this.plex.stop(replacement);
      return {status:'failed',message:error instanceof PlaybackError ? error.message : 'Audio and subtitles could not be updated. Your previous selection is unchanged.'};
    } finally { viewer.updating=false; }
  }
  async refreshStream(room,viewer,args,actor,permitted) {
    const current=viewer.media, version=room.mediaVersion;
    if (!current || current.kind!=='plex' || !room.media || current.format!=='hls') return {status:'unsupported',message:'This stream cannot be refreshed.'};
    if (viewer.preparing || viewer.updating) return {status:'unavailable',message:'Wait for your stream to finish loading.'};
    if (args.mediaVersion!==version || args.streamVersion!==viewer.streamVersion) return {status:'unavailable',message:'Stream refresh expired.'};
    viewer.updating=true;
    let replacement;
    try {
      replacement=await (this.hub.plexFor?await this.hub.plexFor(actor):this.plex).prepare(room.media.id,viewer.quality,viewer.compatible,room.media,viewer.fallback,
        {...viewer.trackChoice,browserSubtitles:viewer.browserSubtitles,shareKey:[room.s.sessionId,version],excludeLease:current.hlsLease,authorized:async()=>permitted() && version===room.mediaVersion && viewer.media===current && await this.canView(room,actor) && (!viewer.alive || await viewer.alive())});
      if (!permitted() || version!==room.mediaVersion || room.viewers.get(actor.watchViewerId)!==viewer || viewer.media!==current ||
        !await this.canView(room,actor) || viewer.alive && !await viewer.alive()) {
        await this.plex.stop(replacement); return {status:'unavailable',message:'Session changed or command expired.'};
      }
      if (replacement.format!=='hls') { await this.plex.stop(replacement); return {status:'failed',message:'Plex could not refresh this stream.'}; }
      this.tracking.end(viewer,'stream-changed'); viewer.media=replacement; viewer.mediaVersion=version; viewer.streamVersion=randomUUID();
      void this.plex.stop(current);
      return {status:'applied',message:'Your stream refreshed.'};
    } catch(error) {
      if(replacement)await this.plex.stop(replacement);
      return {status:'failed',message:error instanceof PlaybackError ? error.message : 'Plex could not refresh this stream.'};
    } finally { viewer.updating=false; }
  }
  remove(id) {
    const room = this.rooms.get(id); if (!room) return;
    room.s.enabled = false; room.s.state.paused = true; room.s.epoch = randomUUID();
    this.dropMedia(room, 'room-closed');
    this.hub.cancel(id); this.hub.sessions.delete(id); this.rooms.delete(id); room.s.socket.readyState = 3; void this.plex.stop(room.media);
  }
  sweep() { for (const room of this.rooms.values()) this.refresh(room); }
  close() { for (const id of this.rooms.keys()) this.remove(id); this.tracking.close(); return this.plex.close?.(); }
}
module.exports = { Watch };
