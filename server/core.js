// @ts-check
'use strict';
/** @typedef {import('./types').Actor} Actor */
/** @typedef {import('./types').RoomDescriptor} RoomDescriptor */
/** @typedef {import('./types').Viewer} Viewer */
/** @typedef {import('./types').EngineCommand} EngineCommand */

const { randomUUID, createHash } = require('node:crypto');
const Engine = require('../shared/engine');
const RoomPolicy = require('./room-policy');
const hash = text => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ALIAS = /^[a-z0-9][a-z0-9.-]{0,47}$/;
const PRESENCE_MS = 10000;
const COMMAND_MS = 3000;
const MODES = new Set(['owner', 'voice', 'guild']);
const isOwner = (actor,config) => (actor?.discordId||actor?.userId)===config.ownerId;
const isHost = (room, actor) => room.kind==='watch' ? room.creatorId ? actor.userId===room.creatorId || room.hosts.includes(actor.userId) : actor.userId===room.hostId : (actor.discordId||actor.userId)===room.ownerId;
const privileged = (room, actor, config, admin = false) => isHost(room, actor) || admin && (room.kind === 'watch' || isOwner(actor,config));
const canWatch = (access,id) => access?.canWatch ? access.canWatch(id) : !!access?.isMember(id);
function sameVoice(room, actor, access) {
  const channel = access?.voiceChannel?.(room.hostId || room.ownerId);
  return !!channel && !!access?.validVoiceChannel?.(channel) && access.voiceChannel(actor.userId) === channel;
}
function watching(room, actor, now = Date.now()) {
  return room.kind === 'watch' && [...(room.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

function viewEligible(room, actor, config, now = Date.now(), access, admin = false) {
  return room.kind === 'watch' && actor.guildId === config.guildId && config.channels.includes(actor.channelId) &&
    canWatch(access,actor.userId) && room.reachable && now - room.lastSeen < PRESENCE_MS && room.socket.readyState === 1 &&
    (privileged(room, actor, config, admin) || room.visibility === 'public');
}
function eligible(room, actor, config, now = Date.now(), access, manage = false, admin = false) {
  const manager = privileged(room, actor, config, admin);
  const managing = room.kind === 'watch' && admin || (manage || room.kind === 'watch') && actor.surface === 'web' &&
    (manager || room.permissions && watching(room, actor, now));
  if (actor.guildId !== config.guildId || !config.channels.includes(actor.channelId) ||
    (room.kind !== 'watch' && room.ownerId !== config.ownerId) || !MODES.has(room.mode) || (!room.enabled && !managing) || !room.reachable ||
    now - room.lastSeen >= PRESENCE_MS || room.socket.readyState !== 1) return false;
  if (room.kind === 'watch' && !viewEligible(room, actor, config, now, access, admin)) return false;
  if (room.kind !== 'watch' && isHost(room,actor)) return true;
  if (room.kind !== 'watch' && !isOwner(actor,config) && !access?.isMember(actor.userId)) return false;
  if (manager) return true;
  return sameVoice(room, actor, access) || watching(room, actor, now);
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
  constructor(config, devices) {
    this.config = config; this.devices = devices;
    this.rooms = new Map(); this.connections = new Map(); this.pending = new Map();
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
    if (personal || ['status.get', 'help.get'].includes(command.action)) return true;
    const capability = RoomPolicy.commandCapability(command.action);
    if (!capability || !this.canRoom(room, actor, capability)) return false;
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
      for (const [id, pending] of this.pending) if (pending.actor.userId === actor.userId) this.finish(id,{status:'unavailable',message:'Admin mode changed.'});
    }
  }
  setAdminMode(actor, enabled) {
    if (actor.surface !== 'web' || !this.canAdmin(actor) || actor.guildId !== this.config.guildId ||
      !this.config.channels.includes(actor.channelId) || !canWatch(this.access,actor.userId) || typeof enabled !== 'boolean') throw new Error('Only an authorized administrator can change Admin mode');
    if (!enabled) { this.clearAdmin(actor); return; }
    if (this.isAdmin(actor)) return;
    if (this.isOwner(actor)) this.adminMode = true;
    else this.adminUsers.add(actor.userId);
    this.adminEpoch++;
    for (const [id, pending] of this.pending) if (pending.actor.userId === actor.userId) this.finish(id,{status:'unavailable',message:'Admin mode changed.'});
  }
  authenticate(socket, deviceId, credential) {
    const device = this.devices.find(d => d.id === deviceId && d.credentialHash === hash(credential || ''));
    if (!device || device.ownerId !== this.config.ownerId) return false;
    const old = this.connections.get(device.id);
    if (old) { this.drop(old); old.close(4001, 'Replaced connection'); }
    socket.device = device;
    socket.lastSeen = Date.now();
    this.connections.set(device.id, socket);
    return true;
  }
  update(socket, message) {
    if (socket.readyState !== 1 || !socket.device || this.connections.get(socket.device.id) !== socket) throw new Error('Device disconnected');
    if (Object.hasOwn(message, 'sessionId') || !UUID.test(message.roomId) || !UUID.test(message.epoch) || typeof message.alias !== 'string' || message.alias !== '' && !ALIAS.test(message.alias) ||
      !MODES.has(message.mode) || typeof message.enabled !== 'boolean' || typeof message.reachable !== 'boolean') throw new Error('Invalid room');
    const old = this.rooms.get(message.roomId);
    if (old && old.socket !== socket) throw new Error('Invalid room');
    if (!old && [...this.rooms.values()].filter(s => s.socket === socket).length >= 20) throw new Error('Too many rooms');
    const controls = Engine.controls(message.controls);
    if (message.autoJoin !== undefined && typeof message.autoJoin !== 'boolean') throw new Error('Invalid room');
    if (old && (old.epoch !== message.epoch || old.mode !== message.mode || !message.enabled || !message.reachable ||
      old.controls.playback !== controls.playback || old.controls.transform !== controls.transform)) this.cancel(old.roomId);
    const room = {
      roomId: message.roomId, epoch: message.epoch, alias: message.alias,
      mode: message.mode, controls, autoJoin: message.autoJoin === true,
      enabled: message.enabled, reachable: message.reachable,
      state: Engine.snapshot(message.state),
      ownerId: socket.device.ownerId, ownerName: this.ownerName, socket, lastSeen: Date.now()
    };
    this.rooms.set(room.roomId, room);
    socket.send(JSON.stringify({ type: 'room-ack', roomId: room.roomId, epoch: room.epoch,
      live: room.enabled && room.reachable, serverNow: Date.now() }));
  }
  remove(socket, roomId) {
    if (this.rooms.get(roomId)?.socket === socket) { this.cancel(roomId); this.rooms.delete(roomId); }
  }
  cancel(roomId) {
    for (const [id, p] of this.pending) if (p.roomId === roomId) this.finish(id, { status: 'unavailable', message: 'Room became unavailable.' });
  }
  drop(socket) {
    for (const s of this.rooms.values()) if (s.socket === socket) this.remove(socket, s.roomId);
    if (this.connections.get(socket.device?.id) === socket) this.connections.delete(socket.device.id);
  }
  sweep() {
    for (const s of this.rooms.values()) if (Date.now() - s.lastSeen >= PRESENCE_MS) {
      s.enabled = false; s.reachable = false; this.cancel(s.roomId);
    }
    for (const ws of this.connections.values()) if (Date.now() - ws.lastSeen >= PRESENCE_MS) { this.drop(ws); ws.terminate(); }
  }
  async dispatch(actor, input) {
    if (Object.hasOwn(input, 'sessionId')) return { status: 'unsupported', message: 'Use the current room protocol.' };
    actor=this.accountActor?.(actor)||actor;
    if (this.refreshAdmin) await this.refreshAdmin(actor);
    if (actor.guildId !== this.config.guildId || !this.config.channels.includes(actor.channelId)) return { status: 'forbidden', message: 'No controllable room.' };
    if (!this.isOwner(actor) || [...this.rooms.values()].some(s => s.kind === 'watch')) {
      try { if (!await (this.access?.refreshWatch||this.access?.refresh)?.(actor.userId)) return { status: 'forbidden', message: 'No controllable room.' }; }
      catch { return { status: 'forbidden', message: 'No controllable room.' }; }
    }
    if (input.roomId && !UUID.test(input.roomId)) return { status: 'forbidden', message: 'No controllable room.' };
    let command;
    try { command = Engine.validate(input); } catch { return { status: 'unsupported', message: 'Unsupported command or value.' }; }
    if (command.action.startsWith('queue.') && !this.rooms.has(input.roomId) && this.savedQueueExecute) {
      const acceptedAt = Date.now(), admissionDeadline = Math.min(acceptedAt + COMMAND_MS, Number.isFinite(input.expiresAt) ? input.expiresAt : Infinity);
      if (acceptedAt >= admissionDeadline) return {status:'unavailable',message:'Room changed or command expired.'};
      const deadline = acceptedAt + (['queue.bulk','queue.auto'].includes(command.action) ? 30000 : COMMAND_MS), adminEpoch = this.adminEpoch;
      const permitted = () => Date.now() < deadline && this.adminEpoch === adminEpoch && !this.rooms.has(input.roomId) && canWatch(this.access,actor.userId);
      try { return await this.savedQueueExecute(input.roomId, command, actor, permitted); }
      catch (error) { return { status:error.status === 403 ? 'forbidden' : 'failed', message:error.message, httpStatus:error.status || 400 }; }
    }
    // Only the authenticated watch endpoint can attach a viewer identity.
    // Personal audio/quality never changes an extension player or the room.
    const personal = this.rooms.get(input.roomId)?.kind === 'watch' && actor.surface === 'web' && !!actor.watchViewerId &&
      ['media.quality.set', 'media.tracks.set', 'media.stream.refresh', 'media.volume.set', 'media.mute', 'media.unmute'].includes(command.action);
    const manage = Engine.MANAGEMENT.includes(command.action) && !personal;
    if (manage && (actor.surface !== 'web' && !this.isAdmin(actor) || !input.roomId)) return { status: 'forbidden', message: 'This action requires the host website or local extension.' };
    if (command.action === 'room.sharing' && command.args.mode !== 'owner' && this.rooms.get(input.roomId)?.kind!=='watch' && !this.access?.options?.().available) return { status: 'unavailable', message: 'Wait for Discord to connect before sharing.' };
    const found = resolve(this.rooms.values(), actor, this.config, input.target, Date.now(), this.access, input.roomId, manage, personal, this.isAdmin(actor));
    if (!found.room) return found;
    const s = found.room;
    if(s.kind==='watch'&&this.watchCanView&&!await this.watchCanView(s,actor))return {status:'forbidden',message:'No controllable room.'};
    if (command.action === 'room.visibility' && s.kind !== 'watch') return { status: 'unsupported', message: 'Visibility applies to viewing rooms.' };
    if (s.permissions) {
      if (!this.roomCommandAllowed(s, actor, command, personal)) return { status:'forbidden', message:'Your room permissions do not allow this action.' };
    } else {
      if (!this.canManage(s, actor) && (manage || ['profile.save', 'room.disable'].includes(command.action))) return { status: 'forbidden', message: 'This action requires the host.' };
      if (!personal && !this.canManage(s, actor) && !Engine.controlAllowed(s.controls, command)) return { status: 'forbidden', message: 'This control is not shared.' };
    }
    if (s.execute) {
      const acceptedAt = Date.now();
      const admissionDeadline = Math.min(acceptedAt + COMMAND_MS, Number.isFinite(input.expiresAt) ? input.expiresAt : Infinity);
      if (acceptedAt >= admissionDeadline) return { status: 'unavailable', message: 'Room changed or command expired.' };
      // A fresh personal quality request starts immediately, but Plex room
      // preparation can take longer than a remote button's delivery lifetime.
      // Keep completion bounded and recheck the same live authorization below.
      const preparing = personal && command.action === 'media.quality.set' || s.permissions &&
        ['queue.bulk','queue.auto','queue.history.replay','queue.history.goBack','queue.playNow','queue.playEntry','queue.skipTo','media.load','media.next','media.previous'].includes(command.action);
      const deadline = preparing ? acceptedAt + 30000 : admissionDeadline;
      const epoch = s.epoch, mode = s.mode, adminEpoch = this.adminEpoch;
      const permitted = () => this.rooms.get(s.roomId) === s && s.epoch === epoch && s.mode === mode && Date.now() < deadline &&
        (s.permissions || this.isOwner(actor) ? this.adminEpoch === adminEpoch : true) &&
        (personal ? viewEligible(s, actor, this.config, Date.now(), this.access, this.isAdmin(actor)) : eligible(s, actor, this.config, Date.now(), this.access, manage, this.isAdmin(actor))) &&
        (s.permissions ? this.roomCommandAllowed(s, actor, command, personal) : personal || this.canManage(s, actor) || !manage && Engine.controlAllowed(s.controls, command));
      try { return await s.execute(command, actor, permitted); }
      catch (error) { return command.action.startsWith('queue.') ?
        { status:error.status === 403 ? 'forbidden' : 'failed', message:error.message, httpStatus:error.status || 400 } :
        { status: 'failed', message: error instanceof Error && error.status ? error.message : 'Playback could not be updated.' }; }
    }
    const id = randomUUID(); const sentAt = Date.now(); const expiresAt = sentAt + COMMAND_MS;
    return new Promise(resolveReply => {
      const timer = setTimeout(() => this.finish(id, { status: 'unavailable', message: 'No execution acknowledgement before expiry.' }), COMMAND_MS);
      this.pending.set(id, { actor: { ...actor }, command, manage, roomId: s.roomId, epoch: s.epoch, mode: s.mode,
        hostVoiceChannelId: !this.canManage(s, actor) ? this.access?.voiceChannel?.(s.ownerId) : undefined,
        socket: s.socket, timer, resolveReply, sentAt });
      // Never accept a sender label from command JSON: it comes from the authenticated actor.
      const senderName = Engine.senderName(actor.name, isHost(s,actor) ? Engine.senderName(this.ownerName) : 'Discord user');
      try { s.socket.send(JSON.stringify({ type: 'command', id, roomId: s.roomId, epoch: s.epoch, ownerId: s.ownerId, actorId: actor.discordId||actor.userId, expiresAt, senderName, ...command })); }
      catch { this.finish(id, { status: 'unavailable', message: 'Device disconnected.' }); }
    });
  }
  async ack(socket, message) {
    const p = this.pending.get(message.id);
    if (!p || p.socket !== socket || p.roomId !== message.roomId || p.epoch !== message.epoch) return;
    if (!this.isOwner(p.actor)) {
      try {
        if (!await this.access?.refresh(p.actor.userId)) { this.finish(message.id, { status: 'unavailable', message: 'Room became unavailable.' }); return; }
      } catch { this.finish(message.id, { status: 'unavailable', message: 'Room became unavailable.' }); return; }
      if (this.pending.get(message.id) !== p) return;
    }
    const s = this.rooms.get(p.roomId);
    const disabling = message.disabled === true;
    if (!s || s.epoch !== p.epoch || s.mode !== p.mode ||
      (p.hostVoiceChannelId && this.access?.voiceChannel(s.ownerId) !== p.hostVoiceChannelId) ||
      Date.now() - p.sentAt >= COMMAND_MS || !eligible(s, p.actor, this.config, Date.now(), this.access, p.manage, this.isAdmin(p.actor)) ||
      !this.canManage(s, p.actor) && !Engine.controlAllowed(s.controls, p.command)) {
      this.finish(message.id, { status: 'unavailable', message: 'Room became unavailable.' }); return;
    }
    const status = ['applied', 'unsupported', 'unavailable', 'failed'].includes(message.status) ? message.status : 'failed';
    // Never post private player titles or state into a shared Discord channel.
    const state = Engine.snapshot(message.state);
    if (state && status === 'applied') s.state = state;
    this.finish(message.id, { status, message: status === 'applied' ? 'Action applied.' : 'Action could not be applied.',
      latencyMs: Date.now() - p.sentAt, ...(p.actor.surface === 'web' && state ? { state } : {}) });
    if (status === 'applied' && p.command.action === 'room.enable') s.enabled = true;
    if (status === 'applied' && p.command.action === 'room.sharing') { s.mode = p.command.args.mode; this.cancel(s.roomId); }
    if (status === 'applied' && p.command.action === 'room.controls') { s.controls[p.command.args.control] = p.command.args.allowed; this.cancel(s.roomId); }
    if (status === 'applied' && p.command.action === 'room.autojoin') s.autoJoin = p.command.args.enabled;
    if (disabling && p.command.action === 'room.disable' && status === 'applied') { s.enabled = false; this.cancel(s.roomId); }
  }
  finish(id, result) {
    const p = this.pending.get(id); if (!p) return;
    clearTimeout(p.timer); this.pending.delete(id); p.resolveReply(result);
  }
  async list(actor) {
    actor=this.accountActor?.(actor)||actor;
    if (actor.guildId !== this.config.guildId || !this.config.channels.includes(actor.channelId)) return [];
    if (!this.isOwner(actor) || actor.surface === 'web' && !canWatch(this.access,actor.userId)) {
      try { if (!await (this.access?.refreshWatch||this.access?.refresh)?.(actor.userId)) return []; } catch { return []; }
    }
    const visible=[];
    for(const entry of labels([...this.rooms.values()].filter(s => eligible(s, actor, this.config, Date.now(), this.access,
      actor.surface === 'web' && this.canManage(s, actor), this.isAdmin(actor)))))if(entry.room.kind!=='watch'||!this.watchCanView||await this.watchCanView(entry.room,actor))visible.push(entry);
    return visible
      .map(({ room: s, label }) => ({ id: s.roomId, alias: label, state: s.state, canSave: this.canManage(s, actor),
        ...(s.kind ? { kind: s.kind, hostName: s.hostName, visibility: s.visibility } : {}),
        canPlayback: this.canManage(s, actor) || s.controls.playback, canTransform: this.canManage(s, actor) || s.controls.transform,
        ...(this.canManage(s, actor) ? { canManage: true, enabled: s.enabled, mode: s.mode, controls: { ...s.controls }, autoJoin: s.autoJoin,
          sharingAvailable: !!this.access?.options?.().available } : {}) }));
  }
  voiceMessage(joined = false, forceUnavailable = false) {
    const available = !forceUnavailable && !!this.access?.options?.().available;
    const id = available && this.access?.voiceChannel(this.config.ownerId);
    const channelId = id && this.access.validVoiceChannel(id) ? id : null;
    const serverNow = Date.now();
    this.voiceSequence = (this.voiceSequence || 0) + 1;
    return { type: 'voice-state', sequence: this.voiceSequence, available, channelId, joined: !!channelId && joined,
      serverNow, expiresAt: serverNow + COMMAND_MS };
  }
  publishVoice(joined = false, forceUnavailable = false) {
    const message = JSON.stringify(this.voiceMessage(joined, forceUnavailable));
    for (const ws of this.connections.values()) if (ws.readyState === 1 && Date.now() - ws.lastSeen < PRESENCE_MS) {
      try { ws.send(message); } catch { /* No queue or replay for absent devices. */ }
    }
  }
  revoke(deviceId) {
    const ws = this.connections.get(deviceId);
    if (ws) { this.drop(ws); ws.close(4003, 'Device revoked'); }
  }
  close() {
    for (const ws of this.connections.values()) { this.drop(ws); ws.close(); }
    for (const id of this.pending.keys()) this.finish(id, { status: 'unavailable' });
  }
}
module.exports = { Hub, eligible, viewEligible, isHost, sameVoice, watching, resolve, hash, UUID, PRESENCE_MS, COMMAND_MS, canWatch };
