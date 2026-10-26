// @ts-check
'use strict';
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').EngineCommand} EngineCommand */

const { createHash } = require('node:crypto');
const Engine = require('../shared/engine');
const RoomPolicy = require('./room-policy');
const hash = text => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PRESENCE_MS = 10000;
const COMMAND_MS = 3000;
const isOwner = (actor,config) => (actor?.discordId||actor?.userId)===config.ownerId;
const isHost = (room, actor) => room.creatorId ? RoomPolicy.role(room,actor.userId) !== 'viewer' : actor.userId===room.hostId;
const privileged = (room, actor, config, admin = false) => isHost(room, actor) || admin;
const canWatch = (access,id,actor) => access?.canWatch ? access.canWatch(id,actor) : !!access?.isMember(id);
function sameVoice(room, actor, access) {
  const channel = access?.voiceChannel?.(room.hostId || room.ownerId);
  return !!channel && !!access?.validVoiceChannel?.(channel) && access.voiceChannel(actor.userId) === channel;
}
function watching(room, actor, now = Date.now()) {
  return room.kind === 'watch' && [...(room.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

function viewEligible(room, actor, config, now = Date.now(), access, admin = false) {
  return room.kind === 'watch' && actor.guildId === config.guildId && (!config.channels?.length || config.channels.includes(actor.channelId)) &&
    canWatch(access,actor.userId,actor) && room.reachable && now - room.lastSeen < PRESENCE_MS && room.socket.readyState === 1 &&
    (admin || room.visibility === 'public' || (room.creatorId ? RoomPolicy.assigned(room,actor.userId) : isHost(room,actor)));
}
function eligible(room, actor, config, now = Date.now(), access, manage = false, admin = false) {
  if (actor.surface !== 'web' && !admin) return false;
  if (!viewEligible(room, actor, config, now, access, admin)) return false;
  if (privileged(room, actor, config, admin)) return true;
  return watching(room, actor, now);
}
function labels(rooms) {
  // Number only the caller's visible rooms: hidden players never affect labels.
  const unnamed = rooms.filter(s => !s.alias), counts = new Map(), numbers = new Map();
  for (const s of unnamed) counts.set(s.ownerId, (counts.get(s.ownerId) || 0) + 1);
  return rooms.map(s => {
    let label = s.alias;
    if (!label) {
      const number = (numbers.get(s.ownerId) || 0) + 1; numbers.set(s.ownerId, number);
      label = s.ownerName || 'Discord user';
      if (counts.get(s.ownerId) > 1) label += ' #' + number;
    }
    return { room: s, label };
  });
}
function resolve(rooms, actor, config, target, now = Date.now(), access, roomId, manage = false, personal = false, admin = false) {
  const visible = [...rooms].filter(s => personal ? viewEligible(s, actor, config, now, access, admin) : eligible(s, actor, config, now, access, manage, admin));
  const candidates = labels(visible).filter(({ room: s, label }) => (!roomId || s.roomId === roomId) &&
    (!target || label.toLowerCase() === target.toLowerCase().replace(/\s*#/, ' #') ||
      !s.alias && (s.ownerName || 'Discord user').toLowerCase() === target.toLowerCase() ||
      s.alias && (s.alias === target || s.alias.startsWith(target + '.')))).map(entry => entry.room);
  if (!candidates.length) return { status: 'forbidden', message: 'No controllable room.' };
  if (candidates.length !== 1) return { status: 'ambiguous', message: 'Specify an explicit, unique room alias.' };
  return { room: candidates[0] };
}

class Hub {
  constructor(config) {
    this.config = config;
    this.rooms = new Map();
    this.adminMode = false; this.adminEpoch = 0; this.adminUsers = new Set();
  }
  isOwner(actor) {return isOwner(actor,this.config);}
  canAdmin(actor) { return this.isOwner(actor) || this.adminEligible?.(actor) === true; }
  isAdmin(actor) {
    if (!this.canAdmin(actor)) { this.adminUsers.delete(actor.userId); return false; }
    return this.isOwner(actor) ? this.adminMode : this.adminUsers.has(actor.userId);
  }
  canRoom(room, actor, capability) {
    return room.permissions ? this.isAdmin(actor) || RoomPolicy.allowed(room, actor.userId, capability) : this.canManage(room, actor);
  }
  canManage(room, actor) { return room.permissions ? this.canRoom(room, actor, 'roomSettings') : privileged(room, actor, this.config, this.isAdmin(actor)); }
  roomCommandAllowed(room, actor, command, personal = false) {
    if (personal) return true;
    const capability = RoomPolicy.commandCapability(command.action);
    if (command.action === 'queue.auto.playNow') {
      if (!this.canRoom(room, actor, 'chooseMedia') && !(this.watchIdle?.(room.roomId) && this.canRoom(room, actor, 'playPause'))) return false;
    } else if (!capability || !this.canRoom(room, actor, capability)) return false;
    if (command.action === 'queue.offer.start' && !this.canRoom(room, actor, 'playPause')) return false;
    if (actor.surface !== 'web' && !isHost(room, actor) && !this.isAdmin(actor) && !Engine.controlAllowed(room.controls,command)) return false;
    if (['media.play','media.toggle','media.ready.start'].includes(command.action) && !isHost(room, actor) && !this.isAdmin(actor) &&
        ![...(room.viewers?.values() || [])].some(viewer => isHost(room, viewer.actor) || this.isAdmin(viewer.actor))) {
      return this.canRoom(room, actor, 'continueWithoutHost');
    }
    return true;
  }
  clearAdmin(actor) {
    const changed = this.adminUsers.delete(actor.userId) || this.isOwner(actor) && this.adminMode;
    if (this.isOwner(actor)) this.adminMode = false;
    if (changed) {
      this.adminEpoch++;
    }
  }
  setAdminMode(actor, enabled) {
    if (actor.surface !== 'web' || !this.canAdmin(actor) || actor.guildId !== this.config.guildId ||
      (this.config.channels?.length && !this.config.channels.includes(actor.channelId)) || !canWatch(this.access,actor.userId,actor) || typeof enabled !== 'boolean') throw new Error('Only an authorized administrator can change Admin mode');
    if (!enabled) { this.clearAdmin(actor); return; }
    if (this.isAdmin(actor)) return;
    if (this.isOwner(actor)) this.adminMode = true;
    else this.adminUsers.add(actor.userId);
    this.adminEpoch++;
  }
  async dispatch(actor, input) {
    if (Object.hasOwn(input, 'sessionId')) return { status: 'unsupported', message: 'Use the current room protocol.' };
    actor=this.accountActor?.(actor)||actor;
    if (this.refreshAdmin) await this.refreshAdmin(actor);
    if (actor.surface !== 'web' || actor.guildId !== this.config.guildId || (this.config.channels?.length && !this.config.channels.includes(actor.channelId))) return { status: 'forbidden', message: 'No controllable room.' };
    if (!this.isOwner(actor) || this.rooms.size) {
      try { if (!await (this.access?.refreshWatch||this.access?.refresh)?.(actor.userId,actor)) return { status: 'forbidden', message: 'No controllable room.' }; }
      catch { return { status: 'forbidden', message: 'No controllable room.' }; }
    }
    if (input.roomId && !UUID.test(input.roomId)) return { status: 'forbidden', message: 'No controllable room.' };
    if(this.config.singleRoom&&input.roomId&&!this.rooms.has(input.roomId))return {status:'forbidden',message:'Only the configured shared room is available.'};
    let command;
    try { command = Engine.validate(input); } catch { return { status: 'unsupported', message: 'Unsupported command or value.' }; }
    if (command.action.startsWith('queue.') && !this.rooms.has(input.roomId) && this.savedQueueExecute) {
      const acceptedAt = Date.now(), admissionDeadline = Math.min(acceptedAt + COMMAND_MS, Number.isFinite(input.expiresAt) ? input.expiresAt : Infinity);
      if (acceptedAt >= admissionDeadline) return {status:'unavailable',message:'Room changed or command expired.'};
      const deadline = acceptedAt + (['queue.bulk','queue.auto','queue.auto.skip','queue.auto.pin'].includes(command.action) ? 30000 : COMMAND_MS), adminEpoch = this.adminEpoch;
      const permitted = () => Date.now() < deadline && this.adminEpoch === adminEpoch && !this.rooms.has(input.roomId) && canWatch(this.access,actor.userId,actor);
      try { return await this.savedQueueExecute(input.roomId, command, actor, permitted); }
      catch (error) { return { status:error.status === 403 ? 'forbidden' : 'failed', message:error.message, httpStatus:error.status || 400 }; }
    }
    // Only the authenticated watch endpoint can attach a viewer identity.
    // Personal audio/quality never changes the room for other viewers.
    const personal = this.rooms.get(input.roomId)?.kind === 'watch' && actor.surface === 'web' && !!actor.watchViewerId &&
      ['media.quality.set', 'media.tracks.set', 'media.stream.refresh', 'media.volume.set', 'media.mute', 'media.unmute', 'media.reporting.set'].includes(command.action);
    const manage = Engine.MANAGEMENT.includes(command.action) && !personal;
    if (manage && (actor.surface !== 'web' && !this.isAdmin(actor) || !input.roomId)) return { status: 'forbidden', message: 'This action requires an authorized room manager.' };
    const found = resolve(this.rooms.values(), actor, this.config, input.target, Date.now(), this.access, input.roomId, manage, personal, this.isAdmin(actor));
    if (!found.room) return found;
    const s = found.room;
    if(s.kind==='watch'&&this.watchCanView&&!await this.watchCanView(s,actor))return {status:'forbidden',message:'No controllable room.'};
    if (s.permissions) {
      if (!this.roomCommandAllowed(s, actor, command, personal)) return { status:'forbidden', message:'Your room permissions do not allow this action.' };
    } else {
      if (!this.canManage(s, actor) && (manage || command.action === 'profile.save')) return { status: 'forbidden', message: 'This action requires the host.' };
      if (!personal && !this.canManage(s, actor) && !Engine.controlAllowed(s.controls, command)) return { status: 'forbidden', message: 'This control is not shared.' };
    }
    if (s.execute) {
      const acceptedAt = Date.now();
      const admissionDeadline = Math.min(acceptedAt + COMMAND_MS, Number.isFinite(input.expiresAt) ? input.expiresAt : Infinity);
      if (acceptedAt >= admissionDeadline) return { status: 'unavailable', message: 'Room changed or command expired.' };
      // A fresh personal quality request starts immediately, but Plex room
      // preparation can take longer than the default command deadline.
      // Keep completion bounded and recheck the same live authorization below.
      const preparing = personal && command.action === 'media.quality.set' || s.permissions &&
        ['queue.bulk','queue.auto','queue.auto.skip','queue.auto.pin','queue.auto.playNow','queue.offer.start','queue.history.replay','queue.history.goBack','queue.playNow','queue.playEntry','queue.skipTo','media.load','media.next','media.previous'].includes(command.action);
      const deadline = preparing ? acceptedAt + 30000 : admissionDeadline;
      const epoch = s.epoch, adminEpoch = this.adminEpoch;
      const permitted = () => this.rooms.get(s.roomId) === s && s.epoch === epoch && Date.now() < deadline &&
        (s.permissions || this.isOwner(actor) ? this.adminEpoch === adminEpoch : true) &&
        (personal ? viewEligible(s, actor, this.config, Date.now(), this.access, this.isAdmin(actor)) : eligible(s, actor, this.config, Date.now(), this.access, manage, this.isAdmin(actor))) &&
        (s.permissions ? this.roomCommandAllowed(s, actor, command, personal) : personal || this.canManage(s, actor) || !manage && Engine.controlAllowed(s.controls, command));
      try { return await s.execute(command, actor, permitted); }
      catch (error) { return command.action.startsWith('queue.') ?
        { status:error.status === 403 ? 'forbidden' : 'failed', message:error.message, httpStatus:error.status || 400 } :
        { status: 'failed', message: error instanceof Error && error.status ? error.message : 'Playback could not be updated.' }; }
    }
    return { status: 'unavailable', message: 'Room is no longer active.' };
  }
  close() { this.rooms.clear(); }
  async list(actor) {
    actor=this.accountActor?.(actor)||actor;
    if (actor.guildId !== this.config.guildId || (this.config.channels?.length && !this.config.channels.includes(actor.channelId))) return [];
    if (!this.isOwner(actor) || actor.surface === 'web' && !canWatch(this.access,actor.userId,actor)) {
      try { if (!await (this.access?.refreshWatch||this.access?.refresh)?.(actor.userId,actor)) return []; } catch { return []; }
    }
    const visible=[];
    for(const entry of labels([...this.rooms.values()].filter(s => eligible(s, actor, this.config, Date.now(), this.access,
      actor.surface === 'web' && this.canManage(s, actor), this.isAdmin(actor)))))if(!this.watchCanView||await this.watchCanView(entry.room,actor))visible.push(entry);
    return visible
      .map(({ room: s, label }) => ({ id: s.roomId, alias: label, state: s.state, canSave: this.canManage(s, actor),
        kind:'watch', hostName:s.hostName, visibility:s.visibility,
        canPlayback:this.canManage(s, actor) || s.controls.playback, canTransform:this.canManage(s, actor) || s.controls.transform }));
  }
}
module.exports = { Hub, eligible, viewEligible, isHost, sameVoice, watching, resolve, hash, UUID, PRESENCE_MS, COMMAND_MS, canWatch };
