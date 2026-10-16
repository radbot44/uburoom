'use strict';
const { randomUUID, createHash } = require('node:crypto');
const Engine = require('../extension/engine');
const hash = text => createHash('sha256').update(text).digest('hex');
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const ALIAS = /^[a-z0-9][a-z0-9.-]{0,47}$/;
const PRESENCE_MS = 10000;
const COMMAND_MS = 3000;
const MODES = new Set(['owner', 'voice', 'guild']);
const isOwner = (actor,config) => (actor?.discordId||actor?.userId)===config.ownerId;
const isHost = (session, actor) => session.kind==='watch'?actor.userId===session.hostId:(actor.discordId||actor.userId)===session.ownerId;
const privileged = (session, actor, config, admin = false) => isHost(session, actor) || admin && isOwner(actor,config);
const canWatch = (access,id) => access?.canWatch ? access.canWatch(id) : !!access?.isMember(id);
function sameVoice(session, actor, access) {
  const channel = access?.voiceChannel?.(session.hostId || session.ownerId);
  return !!channel && !!access?.validVoiceChannel?.(channel) && access.voiceChannel(actor.userId) === channel;
}
function watching(session, actor, now = Date.now()) {
  return session.kind === 'watch' && [...(session.viewers?.values() || [])].some(v => v.userId === actor.userId && now - v.at < PRESENCE_MS);
}

function viewEligible(session, actor, config, now = Date.now(), access, admin = false) {
  return session.kind === 'watch' && actor.guildId === config.guildId && config.channels.includes(actor.channelId) &&
    canWatch(access,actor.userId) && session.reachable && now - session.lastSeen < PRESENCE_MS && session.socket.readyState === 1 &&
    (privileged(session, actor, config, admin) || session.visibility === 'public');
}
function eligible(session, actor, config, now = Date.now(), access, manage = false, admin = false) {
  const manager = privileged(session, actor, config, admin);
  const managing = session.kind === 'watch' && admin && isOwner(actor,config) || (manage || session.kind === 'watch') && actor.surface === 'web' && manager;
  if (actor.guildId !== config.guildId || !config.channels.includes(actor.channelId) ||
    (session.kind !== 'watch' && session.ownerId !== config.ownerId) || !MODES.has(session.mode) || (!session.enabled && !managing) || !session.reachable ||
    now - session.lastSeen >= PRESENCE_MS || session.socket.readyState !== 1) return false;
  if (session.kind === 'watch' && !viewEligible(session, actor, config, now, access, admin)) return false;
  if (session.kind !== 'watch' && isHost(session,actor)) return true;
  if (session.kind !== 'watch' && !isOwner(actor,config) && !access?.isMember(actor.userId)) return false;
  if (manager) return true;
  return sameVoice(session, actor, access) || watching(session, actor, now);
}
function labels(sessions) {
  // Number only the caller's visible sessions: hidden players never affect labels.
  const unnamed = sessions.filter(s => !s.alias), counts = new Map(), numbers = new Map();
  for (const s of unnamed) counts.set(s.ownerId, (counts.get(s.ownerId) || 0) + 1);
  return sessions.map(s => {
    let label = s.alias;
    if (!label) {
      const number = (numbers.get(s.ownerId) || 0) + 1; numbers.set(s.ownerId, number);
      label = s.ownerName || 'Discord user';
      if (counts.get(s.ownerId) > 1) label += ' #' + number;
    }
    return { session: s, label };
  });
}
function resolve(sessions, actor, config, target, now = Date.now(), access, sessionId, manage = false, personal = false, admin = false) {
  const visible = [...sessions].filter(s => personal ? viewEligible(s, actor, config, now, access, admin) : eligible(s, actor, config, now, access, manage, admin));
  const candidates = labels(visible).filter(({ session: s, label }) => (!sessionId || s.sessionId === sessionId) &&
    (!target || label.toLowerCase() === target.toLowerCase().replace(/\s*#/, ' #') ||
      !s.alias && (s.ownerName || 'Discord user').toLowerCase() === target.toLowerCase() ||
      s.alias && (s.alias === target || s.alias.startsWith(target + '.')))).map(entry => entry.session);
  if (!candidates.length) return { status: 'forbidden', message: 'No controllable session.' };
  if (candidates.length !== 1) return { status: 'ambiguous', message: 'Specify an explicit, unique session alias.' };
  return { session: candidates[0] };
}

class Hub {
  constructor(config, devices) {
    this.config = config; this.devices = devices;
    this.sessions = new Map(); this.connections = new Map(); this.pending = new Map();
    this.adminMode = false; this.adminEpoch = 0;
  }
  isOwner(actor) {return isOwner(actor,this.config);}
  isAdmin(actor) { return this.adminMode && this.isOwner(actor); }
  canManage(session, actor) { return privileged(session, actor, this.config, this.isAdmin(actor)); }
  setAdminMode(actor, enabled) {
    if (actor.surface !== 'web' || !this.isOwner(actor) || actor.guildId !== this.config.guildId ||
      !this.config.channels.includes(actor.channelId) || !canWatch(this.access,actor.userId) || typeof enabled !== 'boolean') throw new Error('Only the owner can change Admin mode');
    if (enabled === this.adminMode) return;
    this.adminMode = enabled; this.adminEpoch++;
    for (const [id, pending] of this.pending) if (this.isOwner(pending.actor)) this.finish(id,{status:'unavailable',message:'Admin mode changed.'});
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
    if (!UUID.test(message.sessionId) || !UUID.test(message.epoch) || typeof message.alias !== 'string' || message.alias !== '' && !ALIAS.test(message.alias) ||
      !MODES.has(message.mode) || typeof message.enabled !== 'boolean' || typeof message.reachable !== 'boolean') throw new Error('Invalid session');
    const old = this.sessions.get(message.sessionId);
    if (old && old.socket !== socket) throw new Error('Invalid session');
    if (!old && [...this.sessions.values()].filter(s => s.socket === socket).length >= 20) throw new Error('Too many sessions');
    const controls = Engine.controls(message.controls);
    if (message.autoJoin !== undefined && typeof message.autoJoin !== 'boolean') throw new Error('Invalid session');
    if (old && (old.epoch !== message.epoch || old.mode !== message.mode || !message.enabled || !message.reachable ||
      old.controls.playback !== controls.playback || old.controls.transform !== controls.transform)) this.cancel(old.sessionId);
    const session = {
      sessionId: message.sessionId, epoch: message.epoch, alias: message.alias,
      mode: message.mode, controls, autoJoin: message.autoJoin === true,
      enabled: message.enabled, reachable: message.reachable,
      state: Engine.snapshot(message.state),
      ownerId: socket.device.ownerId, ownerName: this.ownerName, socket, lastSeen: Date.now()
    };
    this.sessions.set(session.sessionId, session);
    socket.send(JSON.stringify({ type: 'session-ack', sessionId: session.sessionId, epoch: session.epoch,
      live: session.enabled && session.reachable, serverNow: Date.now() }));
  }
  remove(socket, sessionId) {
    if (this.sessions.get(sessionId)?.socket === socket) { this.cancel(sessionId); this.sessions.delete(sessionId); }
  }
  cancel(sessionId) {
    for (const [id, p] of this.pending) if (p.sessionId === sessionId) this.finish(id, { status: 'unavailable', message: 'Session became unavailable.' });
  }
  drop(socket) {
    for (const s of this.sessions.values()) if (s.socket === socket) this.remove(socket, s.sessionId);
    if (this.connections.get(socket.device?.id) === socket) this.connections.delete(socket.device.id);
  }
  sweep() {
    for (const s of this.sessions.values()) if (Date.now() - s.lastSeen >= PRESENCE_MS) {
      s.enabled = false; s.reachable = false; this.cancel(s.sessionId);
    }
    for (const ws of this.connections.values()) if (Date.now() - ws.lastSeen >= PRESENCE_MS) { this.drop(ws); ws.terminate(); }
  }
  async dispatch(actor, input) {
    actor=this.accountActor?.(actor)||actor;
    if (actor.guildId !== this.config.guildId || !this.config.channels.includes(actor.channelId)) return { status: 'forbidden', message: 'No controllable session.' };
    if (!this.isOwner(actor) || [...this.sessions.values()].some(s => s.kind === 'watch')) {
      try { if (!await (this.access?.refreshWatch||this.access?.refresh)?.(actor.userId)) return { status: 'forbidden', message: 'No controllable session.' }; }
      catch { return { status: 'forbidden', message: 'No controllable session.' }; }
    }
    if (input.sessionId && !UUID.test(input.sessionId)) return { status: 'forbidden', message: 'No controllable session.' };
    let command;
    try { command = Engine.validate(input); } catch { return { status: 'unsupported', message: 'Unsupported command or value.' }; }
    // Only the authenticated watch endpoint can attach a viewer identity.
    // Personal audio/quality never changes an extension player or the room.
    const personal = this.sessions.get(input.sessionId)?.kind === 'watch' && actor.surface === 'web' && !!actor.watchViewerId &&
      ['media.quality.set', 'media.tracks.set', 'media.stream.refresh', 'media.volume.set', 'media.mute', 'media.unmute'].includes(command.action);
    const manage = Engine.MANAGEMENT.includes(command.action) && !personal;
    if (manage && (actor.surface !== 'web' && !this.isAdmin(actor) || !input.sessionId)) return { status: 'forbidden', message: 'This action requires the host website or local extension.' };
    if (command.action === 'session.sharing' && command.args.mode !== 'owner' && this.sessions.get(input.sessionId)?.kind!=='watch' && !this.access?.options?.().available) return { status: 'unavailable', message: 'Wait for Discord to connect before sharing.' };
    const found = resolve(this.sessions.values(), actor, this.config, input.target, Date.now(), this.access, input.sessionId, manage, personal, this.isAdmin(actor));
    if (!found.session) return found;
    const s = found.session;
    if(s.kind==='watch'&&this.watchCanView&&!await this.watchCanView(s,actor))return {status:'forbidden',message:'No controllable session.'};
    if (command.action === 'session.visibility' && s.kind !== 'watch') return { status: 'unsupported', message: 'Visibility applies to viewing sessions.' };
    if (!this.canManage(s, actor) && (manage || ['profile.save', 'session.disable'].includes(command.action))) return { status: 'forbidden', message: 'This action requires the host.' };
    if (!personal && !this.canManage(s, actor) && !Engine.controlAllowed(s.controls, command)) return { status: 'forbidden', message: 'This control is not shared.' };
    if (s.execute) {
      const epoch = s.epoch, mode = s.mode, adminEpoch = this.adminEpoch, deadline = Math.min(Date.now() + COMMAND_MS, Number.isFinite(input.expiresAt) ? input.expiresAt : Infinity);
      const permitted = () => this.sessions.get(s.sessionId) === s && s.epoch === epoch && s.mode === mode && Date.now() < deadline &&
        (!this.isOwner(actor) || this.adminEpoch === adminEpoch) &&
        (personal ? viewEligible(s, actor, this.config, Date.now(), this.access, this.isAdmin(actor)) : eligible(s, actor, this.config, Date.now(), this.access, manage, this.isAdmin(actor))) &&
        (personal || this.canManage(s, actor) || !manage && Engine.controlAllowed(s.controls, command));
      try { return await s.execute(command, actor, permitted); }
      catch { return { status: 'failed', message: 'Playback could not be updated.' }; }
    }
    const id = randomUUID(); const sentAt = Date.now(); const expiresAt = sentAt + COMMAND_MS;
    return new Promise(resolveReply => {
      const timer = setTimeout(() => this.finish(id, { status: 'unavailable', message: 'No execution acknowledgement before expiry.' }), COMMAND_MS);
      this.pending.set(id, { actor: { ...actor }, command, manage, sessionId: s.sessionId, epoch: s.epoch, mode: s.mode,
        hostVoiceChannelId: !this.canManage(s, actor) ? this.access?.voiceChannel?.(s.ownerId) : undefined,
        socket: s.socket, timer, resolveReply, sentAt });
      // Never accept a sender label from command JSON: it comes from the authenticated actor.
      const senderName = Engine.senderName(actor.name, isHost(s,actor) ? Engine.senderName(this.ownerName) : 'Discord user');
      try { s.socket.send(JSON.stringify({ type: 'command', id, sessionId: s.sessionId, epoch: s.epoch, ownerId: s.ownerId, actorId: actor.discordId||actor.userId, expiresAt, senderName, ...command })); }
      catch { this.finish(id, { status: 'unavailable', message: 'Device disconnected.' }); }
    });
  }
  async ack(socket, message) {
    const p = this.pending.get(message.id);
    if (!p || p.socket !== socket || p.sessionId !== message.sessionId || p.epoch !== message.epoch) return;
    if (!this.isOwner(p.actor)) {
      try {
        if (!await this.access?.refresh(p.actor.userId)) { this.finish(message.id, { status: 'unavailable', message: 'Session became unavailable.' }); return; }
      } catch { this.finish(message.id, { status: 'unavailable', message: 'Session became unavailable.' }); return; }
      if (this.pending.get(message.id) !== p) return;
    }
    const s = this.sessions.get(p.sessionId);
    const disabling = message.disabled === true;
    if (!s || s.epoch !== p.epoch || s.mode !== p.mode ||
      (p.hostVoiceChannelId && this.access?.voiceChannel(s.ownerId) !== p.hostVoiceChannelId) ||
      Date.now() - p.sentAt >= COMMAND_MS || !eligible(s, p.actor, this.config, Date.now(), this.access, p.manage, this.isAdmin(p.actor)) ||
      !this.canManage(s, p.actor) && !Engine.controlAllowed(s.controls, p.command)) {
      this.finish(message.id, { status: 'unavailable', message: 'Session became unavailable.' }); return;
    }
    const status = ['applied', 'unsupported', 'unavailable', 'failed'].includes(message.status) ? message.status : 'failed';
    // Never post private player titles or state into a shared Discord channel.
    const state = Engine.snapshot(message.state);
    if (state && status === 'applied') s.state = state;
    this.finish(message.id, { status, message: status === 'applied' ? 'Action applied.' : 'Action could not be applied.',
      latencyMs: Date.now() - p.sentAt, ...(p.actor.surface === 'web' && state ? { state } : {}) });
    if (status === 'applied' && p.command.action === 'session.enable') s.enabled = true;
    if (status === 'applied' && p.command.action === 'session.sharing') { s.mode = p.command.args.mode; this.cancel(s.sessionId); }
    if (status === 'applied' && p.command.action === 'session.controls') { s.controls[p.command.args.control] = p.command.args.allowed; this.cancel(s.sessionId); }
    if (status === 'applied' && p.command.action === 'session.autojoin') s.autoJoin = p.command.args.enabled;
    if (disabling && p.command.action === 'session.disable' && status === 'applied') { s.enabled = false; this.cancel(s.sessionId); }
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
    for(const entry of labels([...this.sessions.values()].filter(s => eligible(s, actor, this.config, Date.now(), this.access,
      actor.surface === 'web' && this.canManage(s, actor), this.isAdmin(actor)))))if(entry.session.kind!=='watch'||!this.watchCanView||await this.watchCanView(entry.session,actor))visible.push(entry);
    return visible
      .map(({ session: s, label }) => ({ id: s.sessionId, alias: label, state: s.state, canSave: this.canManage(s, actor),
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
