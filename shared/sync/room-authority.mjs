// @ts-check
/* Server-side authoritative room timeline, readiness coordination, control-lead
 * scheduling, and multi-tenant room coordinator.
 * Pure JS state machine: requires no HTTP server, WebSocket, Plex, Discord, or SQLite.
 */
import { validateSyncCommand, senderName, CONTROLS } from './protocol.mjs';
import * as Policy from './policy.mjs';
import {
  COMMAND_TTL_MS,
  PRESENCE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  validateCommandEnvelope,
  composeRoomSnapshot
} from './envelope.mjs';
import {
  validateSyncQualityMessage,
  reduceViewerSyncQuality,
  aggregateParticipantSyncQuality
} from './quality.mjs';

export const INITIAL_START_LEAD_MS = 1750;
export const READY_START_MARGIN_MS = 400;
export const MAX_CONTROL_LEAD_MS = 1000;
export const READINESS_WAIT_MS = 10000;
export const READINESS_EXTEND_MS = 15000;
export const READINESS_BLOCKER_REVEAL_MS = 3000;
export const IDLE_ROOM_TIMEOUT_MS = 30000;
export const MAX_DISCONNECTED_VIEWERS = 128;
export { PRESENCE_TIMEOUT_MS, RECONNECT_GRACE_MS, COMMAND_TTL_MS };

const defaultCreateId = () => globalThis.crypto.randomUUID();
const defaultMonoNow = () => globalThis.performance.now();

function getPaused(room) {
  return room.s?.state ? room.s.state.paused : Boolean(room.paused);
}

function setPaused(room, paused) {
  if (room.s?.state) room.s.state.paused = paused;
  else room.paused = paused;
}

function getDuration(room) {
  if (Number.isFinite(room.duration)) return room.duration;
  return room.media?.duration || 0;
}

function getEpoch(room) {
  return room.s ? room.s.epoch : room.epoch;
}

function setEpoch(room, epoch) {
  if (room.s) room.s.epoch = epoch;
  else room.epoch = epoch;
}

export function position(room, now = Date.now()) {
  if (room.pauseAt) now = Math.min(now, room.pauseAt);
  const elapsed = room.startAt
    ? Math.max(0, now - Math.max(room.changedAt, room.startAt))
    : now - room.changedAt;
  return Math.min(getDuration(room), Math.max(0, room.position + (getPaused(room) ? 0 : elapsed / 1000)));
}

export function controlLead(room, monoNow = defaultMonoNow()) {
  if (room.viewers.size <= 1) return 0;
  let lead = READY_START_MARGIN_MS;
  for (const viewer of room.viewers.values()) {
    const rawRtts = viewer.watchSocket?.watchRtts || viewer.rtts || [];
    const samples = rawRtts
      .filter(sample => monoNow - sample.at <= 30000 && monoNow >= sample.at)
      .map(sample => sample.ms)
      .sort((a, b) => a - b);
    if (samples.length) lead = Math.max(lead, samples[Math.ceil(samples.length * .95) - 1] + 100);
  }
  return Math.min(MAX_CONTROL_LEAD_MS, Math.ceil(lead));
}

export function beginReadiness(room, now = Date.now(), waitMs = READINESS_WAIT_MS, options = {}) {
  const monoNow = options.monoNow ?? defaultMonoNow();
  const createId = options.createId || defaultCreateId;
  room.readinessId = createId();
  room.readinessSince = monoNow;
  room.readinessDeadline = room.readinessSince + waitMs;
  room.readinessTimedOut = false;
  room.readinessStartAt = now + (room.viewers.size > 1 ? INITIAL_START_LEAD_MS : 0);
}

export function promoteGroupReadinessLead(room, now = Date.now()) {
  if (room.viewers.size === 2 && room.initialGate) {
    room.readinessStartAt = Math.max(room.readinessStartAt || 0, now + INITIAL_START_LEAD_MS);
  }
}

export function settle(room, now = Date.now(), monoNow = defaultMonoNow()) {
  if (room.viewers.size === 1) {
    if (room.startAt > now) { room.startAt = now; room.changedAt = now; room.revision++; }
    if (room.pauseAt > now) room.pauseAt = now;
  }
  if (room.pauseAt && now >= room.pauseAt) {
    room.position = position(room, room.pauseAt);
    room.changedAt = room.pauseAt;
    room.pauseAt = undefined;
    setPaused(room, true);
    room.revision++;
  }
  if (!room.recovery && room.initialGate && !room.manualPaused && !room.readinessTimedOut && monoNow >= room.readinessDeadline) {
    room.readinessTimedOut = true;
    room.readinessStartAt = undefined;
    room.revision++;
  }
}

export function invalidateEpoch(room, { createId = defaultCreateId } = {}) {
  const next = createId();
  setEpoch(room, next);
  room.revision++;
  return next;
}

export function recordViewerReadiness(room, { userId, viewerId, mediaVersion, ready, readinessVersion }, options = {}) {
  const now = options.now ?? Date.now();
  const monoNow = options.monoNow ?? defaultMonoNow();
  settle(room, now, monoNow);
  const viewer = room.viewers.get(viewerId);
  if (!viewer || viewer.userId !== userId || room.mediaVersion !== mediaVersion || typeof ready !== 'boolean' || room.readinessVersion !== readinessVersion) {
    throw new Error('Invalid readiness');
  }
  if (ready === true) viewer.readinessBypassedVersion = undefined;
  viewer.ready = ready;
  viewer.version = mediaVersion;
  viewer.at = now;
  return viewer;
}

export function areInitialViewersReady(room) {
  if (!room.initialGate || room.manualPaused || room.readinessTimedOut) return false;
  const viewers = [...room.initialViewers].map(id => room.viewers.get(id)).filter(Boolean);
  if (!viewers.length) return false;
  return viewers.every(v => v.ready && v.version === room.mediaVersion);
}

export function snapshotReadiness(room, monoNow = defaultMonoNow()) {
  const waitingForReady = Boolean(room.initialGate && !room.manualPaused && !room.readinessTimedOut);
  if (!room.initialGate || room.manualPaused) {
    return { waitingForReady, readiness: undefined };
  }
  const blockers = monoNow - room.readinessSince >= READINESS_BLOCKER_REVEAL_MS
    ? [...room.initialViewers]
        .map(id => room.viewers.get(id))
        .filter(v => v && (!v.ready || v.version !== room.mediaVersion))
        .map(v => v.name)
    : [];
  const canStart = [...room.initialViewers].some(id => {
    const v = room.viewers.get(id);
    return Boolean(v?.ready && v.version === room.mediaVersion);
  });
  return {
    waitingForReady,
    readiness: {
      id: room.readinessId,
      timedOut: !!room.readinessTimedOut,
      blockers,
      canStart
    }
  };
}

export function applyReadinessDecision(room, action, readinessId, options = {}) {
  const now = options.now ?? Date.now();
  const monoNow = options.monoNow ?? defaultMonoNow();
  const createId = options.createId || defaultCreateId;
  if (!room.initialGate || !room.readinessTimedOut || readinessId !== room.readinessId) {
    return { status: 'unavailable', message: 'This readiness choice expired.', checkAutoStart: false };
  }
  if (action === 'media.ready.start') {
    const ready = [...room.initialViewers].filter(id => {
      const v = room.viewers.get(id);
      return v?.ready && v.version === room.mediaVersion;
    });
    if (!ready.length) return { status: 'unavailable', message: 'No viewer is ready yet.', checkAutoStart: false };
    for (const id of room.initialViewers) {
      const v = room.viewers.get(id);
      if (v && (!v.ready || v.version !== room.mediaVersion)) {
        v.readinessBypassedVersion = room.mediaVersion;
      }
    }
    room.initialViewers = new Set(ready);
    room.initialGate = false;
    room.readinessTimedOut = false;
    room.readinessStartAt = undefined;
    room.changedAt = now;
    setPaused(room, false);
    room.startAt = room.changedAt + controlLead(room, monoNow);
    room.revision++;
    return { status: 'applied', message: 'Readiness choice applied.', checkAutoStart: false };
  }
  if (action === 'media.ready.wait') {
    beginReadiness(room, now, READINESS_EXTEND_MS, { monoNow, createId });
    room.revision++;
    return { status: 'applied', message: 'Readiness choice applied.', checkAutoStart: true };
  }
  room.manualPaused = true;
  room.readinessTimedOut = false;
  room.readinessStartAt = undefined;
  room.revision++;
  return { status: 'applied', message: 'Readiness choice applied.', checkAutoStart: false };
}

const TIMELINE_ACTIONS = new Set([
  'media.pause',
  'media.play',
  'media.toggle',
  'media.seek.relative',
  'media.seek.absolute',
  'media.seek.start',
  'media.seek.end'
]);

/**
 * Apply a validated timeline coordination command (`media.pause`, `media.play`,
 * `media.toggle`, `media.seek.*`) to an authoritative room state.
 */
export function applyTimelineCommand(room, command, options = {}) {
  const { action, args = {} } = command;
  if (!TIMELINE_ACTIONS.has(action)) return false;
  const now = options.now ?? Date.now();
  const monoNow = options.monoNow ?? defaultMonoNow();
  const createId = options.createId || defaultCreateId;
  const duration = getDuration(room);
  const pausePending = !!room.pauseAt;
  const wasPlaying = !getPaused(room) && !(room.startAt > now);
  const oldPosition = position(room, now);
  room.position = oldPosition;
  room.changedAt = now;
  if (pausePending && action.startsWith('media.seek.')) setPaused(room, true);
  room.pauseAt = undefined;
  room.startAt = undefined;

  switch (action) {
    case 'media.pause':
      room.manualPaused = true;
      room.readinessStartAt = undefined;
      room.readinessTimedOut = false;
      if (wasPlaying && !room.initialGate) room.pauseAt = now + controlLead(room, monoNow);
      else setPaused(room, true);
      break;
    case 'media.play':
      if (room.position >= duration - .1) room.position = 0;
      if (room.manualPaused && room.initialGate) beginReadiness(room, now, READINESS_WAIT_MS, { monoNow, createId });
      room.manualPaused = false;
      setPaused(room, room.initialGate);
      if (options.autoplayVersion === room.mediaVersion && !room.initialGate) {
        room.startAt = Math.max(room.viewers.size > 1 ? room.readinessStartAt || 0 : 0, now + controlLead(room, monoNow));
      } else if (!room.initialGate && !wasPlaying) {
        room.startAt = now + controlLead(room, monoNow);
      }
      break;
    case 'media.toggle':
      if (room.position >= duration - .1) { room.position = 0; setPaused(room, true); }
      room.manualPaused = !pausePending && (!getPaused(room) || room.initialGate && !room.manualPaused);
      if (room.initialGate) {
        if (room.manualPaused) room.readinessStartAt = undefined;
        else beginReadiness(room, now, READINESS_WAIT_MS, { monoNow, createId });
        setPaused(room, true);
      } else if (room.manualPaused && wasPlaying) {
        room.pauseAt = now + controlLead(room, monoNow);
      } else {
        setPaused(room, room.manualPaused);
        if (!getPaused(room) && !wasPlaying) room.startAt = now + controlLead(room, monoNow);
      }
      break;
    case 'media.seek.relative':
      room.position = Math.max(0, Math.min(duration - .05, room.position + args.seconds));
      break;
    case 'media.seek.absolute':
      room.position = Math.max(0, Math.min(duration - .05, args.seconds));
      break;
    case 'media.seek.start':
      room.position = 0;
      break;
    case 'media.seek.end':
      room.position = Math.max(0, duration - .05);
      break;
    default:
      return false;
  }

  if (action.startsWith('media.seek.')) {
    // Freeze the new target and discard acknowledgements from earlier seeks.
    // An explicit pause remains paused; seeking during playback resumes together.
    if (!getPaused(room) || room.initialGate) {
      room.readinessVersion = createId();
      room.initialGate = true;
      beginReadiness(room, now, READINESS_WAIT_MS, { monoNow, createId });
      const activeViewers = [...room.viewers.entries()]
        .filter(([, v]) => v.readinessBypassedVersion !== room.mediaVersion)
        .map(([id]) => id);
      room.initialViewers = activeViewers.length ? new Set(activeViewers) : new Set(room.viewers.keys());
      setPaused(room, true);
      for (const viewer of room.viewers.values()) viewer.ready = false;
    }
  }
  return true;
}

/**
 * Create a self-contained, multi-tenant-ready room synchronization coordinator.
 * Does not start servers, timers, or I/O. Persistence, authorization, and event
 * delivery are injected by the host service (such as future Cephalopod).
 * @param {{
 *   now?:()=>number,
 *   monoNow?:()=>number,
 *   createId?:()=>string,
 *   clockEpoch?:string,
 *   commandTtlMs?:number,
 *   idPattern?:RegExp,
 *   authorize?:(context:{tenantId:string, room:any, actor:any, operation:string, command?:any})=>boolean|Promise<boolean>,
 *   isAdmin?:(actor:any, room:any)=>boolean,
 *   validateExtensionCommand?:(command:any)=>({action:string, args:any}|undefined),
 *   onPersist?:(room:any)=>void|Promise<void>,
 *   onPublish?:(event:{tenantId:string, roomId:string, includeLobby:boolean, reason:string})=>void
 * }} [options]
 */
export function createRoomCoordinator(options = {}) {
  const nowFn = options.now || Date.now;
  const monoNowFn = options.monoNow || defaultMonoNow;
  const createId = options.createId || defaultCreateId;
  const clockEpoch = options.clockEpoch || createId();
  const commandTtlMs = options.commandTtlMs ?? COMMAND_TTL_MS;
  const rooms = new Map();

  const roomKey = (tenantId, roomId) => `${tenantId || 'default'}::${roomId}`;

  const getRoom = (roomId, tenantId = 'default') => rooms.get(roomKey(tenantId, roomId));

  const checkAdmin = (actor, room) => Boolean(options.isAdmin?.(actor, room));

  async function checkAuthorized(room, actor, operation, command) {
    if (!actor?.userId) return false;
    if (actor.tenantId !== undefined && actor.tenantId !== room.tenantId) return false;
    const isAdmin = checkAdmin(actor, room);
    if (room.visibility === 'private' && !isAdmin && !Policy.assigned(room, actor.userId)) return false;
    if (options.authorize) {
      const allowedByHost = await options.authorize({ tenantId: room.tenantId, room, actor, operation, command });
      if (!allowedByHost) return false;
    }
    return true;
  }

  function emitChange(room, includeLobby, reason) {
    options.onPublish?.({ tenantId: room.tenantId, roomId: room.id, includeLobby, reason });
  }

  async function maybeAutoStart(room) {
    if (!areInitialViewersReady(room) || room.starting) return false;
    const hostViewer = [...room.viewers.values()].find(v => v.userId === room.hostId || Policy.role(room, v.userId) !== 'viewer' || Policy.allowed(room, v.userId, 'continueWithoutHost'));
    if (!hostViewer) return false;
    room.starting = true;
    try {
      const now = nowFn(), monoNow = monoNowFn();
      settle(room, now, monoNow);
      if (!areInitialViewersReady(room)) return false;
      room.initialGate = false;
      applyTimelineCommand(room, { action: 'media.play', args: {} }, {
        now,
        monoNow,
        autoplayVersion: room.mediaVersion,
        createId
      });
      room.revision++;
      room.lastActivity = now;
      await options.onPersist?.(room);
      emitChange(room, false, 'ready-autostart');
      return true;
    } finally {
      room.starting = false;
    }
  }

  function refreshRoom(room, now = nowFn(), monoNow = monoNowFn()) {
    settle(room, now, monoNow);
    let pruned = false, hostTimedOut = false;
    for (const [id, saved] of room.disconnectedViewers) {
      if (saved.expires <= now || saved.mediaVersion !== room.mediaVersion ||
          room.visibility === 'private' && !Policy.assigned(room, saved.userId)) {
        room.disconnectedViewers.delete(id);
      }
    }
    for (const [id, viewer] of room.viewers) {
      const unauthorizedPrivate = room.visibility === 'private' && !Policy.assigned(room, viewer.userId) && !checkAdmin(viewer.actor, room);
      const timedOut = now - viewer.at > PRESENCE_TIMEOUT_MS;
      if (timedOut || unauthorizedPrivate) {
        if (timedOut && !unauthorizedPrivate) {
          room.disconnectedViewers.set(id, {
            userId: viewer.userId,
            mediaVersion: room.mediaVersion,
            streamVersion: viewer.streamVersion,
            expires: now + RECONNECT_GRACE_MS,
            readinessBypassedVersion: viewer.readinessBypassedVersion,
            joinedAt: viewer.joinedAt,
            syncQuality: viewer.syncQuality ? {
              ...viewer.syncQuality,
              status: 'disconnected',
              confidence: viewer.syncQuality.confidence === 'provisional' ? 'provisional' : 'reduced',
              updatedAt: now
            } : undefined
          });
          if (room.disconnectedViewers.size > MAX_DISCONNECTED_VIEWERS) {
            room.disconnectedViewers.delete(room.disconnectedViewers.keys().next().value);
          }
        }
        if (timedOut && viewer.userId === room.hostId) hostTimedOut = true;
        room.viewers.delete(id);
        room.initialViewers.delete(id);
        pruned = true;
      }
    }
    if (hostTimedOut) invalidateEpoch(room, { createId });
    if (pruned) {
      settle(room, now, monoNow);
      void maybeAutoStart(room);
    }
    if (room.hasMedia && room.duration > 0 && !room.paused && position(room, now) >= room.duration) {
      room.position = room.duration;
      room.changedAt = now;
      room.paused = true;
      room.revision++;
    }
  }

  function createRoom({
    roomId = createId(),
    tenantId = 'default',
    creatorId,
    creatorName = 'Host',
    name = '',
    visibility = 'public',
    hosts = [],
    permissions: customPermissions,
    content = {}
  }) {
    if (!creatorId) throw new Error('creatorId is required');
    if (!['public', 'private'].includes(visibility)) throw new Error('Invalid room visibility');
    const key = roomKey(tenantId, roomId);
    if (rooms.has(key)) throw new Error('Room already exists');
    const now = nowFn();
    const room = {
      id: roomId,
      tenantId,
      name,
      creatorId,
      hosts: [...new Set(hosts)],
      hostId: creatorId,
      hostName: senderName(creatorName, 'Host'),
      visibility,
      permissions: Policy.policy(customPermissions),
      controls: { ...CONTROLS },
      epoch: createId(),
      revision: 0,
      mediaVersion: createId(),
      readinessVersion: undefined,
      hasMedia: false,
      paused: true,
      position: 0,
      duration: 0,
      seekable: false,
      changedAt: now,
      startAt: undefined,
      pauseAt: undefined,
      initialGate: false,
      manualPaused: false,
      initialViewers: new Set(),
      hadViewers: false,
      viewers: new Map(),
      disconnectedViewers: new Map(),
      kickedViewers: new Map(),
      transportSequence: 0,
      lastActivity: now,
      content: { ...content }
    };
    rooms.set(key, room);
    emitChange(room, true, 'room-created');
    return room;
  }

  async function loadTimeline(roomId, actor, {
    tenantId = actor?.tenantId || 'default',
    duration = 0,
    position: initialPosition = 0,
    autoplay = true,
    content = {}
  } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room) return { status: 'unavailable', httpStatus: 404, message: 'Room unavailable' };
    if (!await checkAuthorized(room, actor, 'loadTimeline')) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
    }
    if (!Policy.allowed(room, actor.userId, 'chooseMedia', { isAdmin: checkAdmin(actor, room) })) {
      return { status: 'forbidden', httpStatus: 403, message: 'Choose media permission required' };
    }
    if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid timeline duration');
    const now = nowFn(), monoNow = monoNowFn();
    room.duration = duration;
    room.position = Math.max(0, Math.min(duration || Infinity, initialPosition));
    room.changedAt = now;
    room.startAt = undefined;
    room.pauseAt = undefined;
    room.hasMedia = true;
    room.seekable = duration > 0;
    room.mediaVersion = createId();
    room.readinessVersion = undefined;
    room.paused = true;
    room.manualPaused = !autoplay;
    room.initialGate = true;
    room.disconnectedViewers.clear();
    for (const viewer of room.viewers.values()) {
      viewer.ready = false;
      viewer.streamVersion = createId();
      viewer.readinessBypassedVersion = undefined;
    }
    beginReadiness(room, now, READINESS_WAIT_MS, { monoNow, createId });
    room.initialViewers = new Set(room.viewers.keys());
    room.content = { ...content };
    room.revision++;
    room.lastActivity = now;
    await options.onPersist?.(room);
    emitChange(room, true, 'timeline-loaded');
    return { status: 'applied', mediaVersion: room.mediaVersion, revision: room.revision };
  }

  async function joinViewer(roomId, actor, {
    viewerId,
    tenantId = actor?.tenantId || 'default',
    rtts = []
  }) {
    const room = getRoom(roomId, tenantId);
    if (!room) throw Object.assign(new Error('Room unavailable'), { status: 404 });
    if (!await checkAuthorized(room, actor, 'join')) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    const now = nowFn(), monoNow = monoNowFn();
    if ((room.kickedViewers.get(viewerId) || 0) > now) {
      throw Object.assign(new Error('You were removed from this room. You may rejoin.'), { status: 403 });
    }
    room.kickedViewers.delete(viewerId);
    refreshRoom(room, now, monoNow);
    const existing = room.viewers.get(viewerId);
    if (existing && existing.userId !== actor.userId) {
      throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
    }
    const saved = !existing && room.disconnectedViewers.get(viewerId);
    if (saved && saved.userId !== actor.userId) {
      throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
    }
    if (saved) room.disconnectedViewers.delete(viewerId);
    const viewer = existing || {
      viewerId,
      userId: actor.userId,
      streamVersion: createId(),
      observationEpoch: createId(),
      readinessBypassedVersion: saved?.mediaVersion === room.mediaVersion ? saved.readinessBypassedVersion : undefined,
      syncQuality: saved?.syncQuality,
      ready: false,
      joinedAt: Math.min(now, saved?.joinedAt ?? now)
    };
    viewer.at = now;
    viewer.name = senderName(actor.name, 'Participant');
    viewer.actor = { ...actor };
    viewer.rtts = rtts;
    room.viewers.set(viewerId, viewer);
    room.hadViewers = true;
    room.lastActivity = now;
    if (!existing) {
      promoteGroupReadinessLead(room, now);
      if (room.initialGate) room.initialViewers.add(viewerId);
      emitChange(room, true, 'viewer-joined');
    }
    return snapshot(roomId, actor, { viewerId, tenantId });
  }

  async function leaveViewer(roomId, actor, {
    viewerId,
    tenantId = actor?.tenantId || 'default',
    reason = 'left'
  }) {
    const room = getRoom(roomId, tenantId);
    if (!room) return false;
    if (room.disconnectedViewers.get(viewerId)?.userId === actor.userId) {
      room.disconnectedViewers.delete(viewerId);
    }
    const viewer = room.viewers.get(viewerId);
    if (!viewer || viewer.userId !== actor.userId) return false;
    const now = nowFn(), monoNow = monoNowFn();
    const hostLeft = actor.userId === room.hostId;
    room.viewers.delete(viewerId);
    room.initialViewers.delete(viewerId);
    room.revision++;
    settle(room, now, monoNow);
    if (hostLeft) {
      if (reason === 'left') room.epoch = createId();
      else invalidateEpoch(room, { createId });
    }
    await maybeAutoStart(room);
    emitChange(room, true, 'viewer-left');
    return true;
  }

  async function reportReadiness(roomId, actor, {
    viewerId,
    mediaVersion,
    ready,
    readinessVersion,
    tenantId = actor?.tenantId || 'default'
  }) {
    const room = getRoom(roomId, tenantId);
    if (!room || !await checkAuthorized(room, actor, 'ready')) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    const now = nowFn(), monoNow = monoNowFn();
    recordViewerReadiness(room, { userId: actor.userId, viewerId, mediaVersion, ready, readinessVersion }, { now, monoNow });
    await maybeAutoStart(room);
    emitChange(room, false, 'viewer-ready');
    return { ok: true };
  }

  async function executeCommand(roomId, actor, envelopeInput, { tenantId = actor?.tenantId || 'default' } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room || !await checkAuthorized(room, actor, 'command', envelopeInput?.command)) {
      return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
    }
    const now = nowFn(), monoNow = monoNowFn();
    const checkedEnvelope = validateCommandEnvelope(envelopeInput, {
      expectedEpoch: room.epoch,
      now,
      maxTtlMs: commandTtlMs
    });
    if (!checkedEnvelope.ok) {
      return { status: 'unavailable', httpStatus: checkedEnvelope.status, reason: checkedEnvelope.reason, message: checkedEnvelope.error };
    }
    if (checkedEnvelope.coordination.viewerId !== undefined) {
      const viewer = room.viewers.get(checkedEnvelope.coordination.viewerId);
      if (!viewer || viewer.userId !== actor.userId) {
        return { status: 'forbidden', httpStatus: 400, message: 'Invalid viewer' };
      }
    }
    let command;
    try {
      command = validateSyncCommand(checkedEnvelope.payload, { userIdPattern: options.idPattern })
        || options.validateExtensionCommand?.(checkedEnvelope.payload);
      if (!command) throw new Error('Unsupported command');
    } catch {
      return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
    }

    const isAdmin = checkAdmin(actor, room);
    const capability = Policy.commandCapability(command.action);
    if (capability && !Policy.allowed(room, actor.userId, capability, { isAdmin })) {
      return { status: 'forbidden', httpStatus: 403, message: 'Your room permissions do not allow this action.' };
    }
    if (['media.play', 'media.toggle', 'media.ready.start'].includes(command.action) &&
        Policy.role(room, actor.userId) === 'viewer' && !isAdmin &&
        ![...room.viewers.values()].some(v => Policy.role(room, v.userId) !== 'viewer' || checkAdmin(v.actor, room))) {
      if (!Policy.allowed(room, actor.userId, 'continueWithoutHost', { isAdmin })) {
        return { status: 'forbidden', httpStatus: 403, message: 'Your room permissions do not allow this action.' };
      }
    }

    if (command.action === 'room.kick') {
      const targetUserId = command.args.userId;
      if (!Policy.canKickParticipant(room, actor.userId, targetUserId, { isAdmin })) {
        return { status: 'forbidden', httpStatus: 403, message: 'You cannot kick this participant.' };
      }
      const targetViewers = [...room.viewers.entries()].filter(([, v]) => v.userId === targetUserId);
      if (!targetViewers.length) return { status: 'unavailable', httpStatus: 409, message: 'This participant has already left.' };
      for (const [id] of targetViewers) room.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
      for (const [id, v] of room.disconnectedViewers) {
        if (v.userId === targetUserId) {
          room.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
          room.disconnectedViewers.delete(id);
        }
      }
      for (const [id, v] of targetViewers) {
        await leaveViewer(roomId, v.actor, { viewerId: id, tenantId, reason: 'kicked' });
      }
      return { status: 'applied', message: 'Participant removed. They may rejoin.' };
    }

    if (command.action === 'room.visibility') {
      room.visibility = command.args.visibility;
      room.disconnectedViewers.clear();
      invalidateEpoch(room, { createId });
      refreshRoom(room, now, monoNow);
      await options.onPersist?.(room);
      if (room.initialGate && !room.manualPaused) await maybeAutoStart(room);
      emitChange(room, true, 'visibility-changed');
      return { status: 'applied', message: 'Viewing room updated.' };
    }

    settle(room, now, monoNow);

    if (command.action.startsWith('media.ready.')) {
      const outcome = applyReadinessDecision(room, command.action, command.args.readinessId, { now, monoNow, createId });
      if (outcome.status === 'applied') {
        refreshRoom(room, now, monoNow);
        if (outcome.checkAutoStart) await maybeAutoStart(room);
        await options.onPersist?.(room);
        emitChange(room, false, command.action);
      }
      return { status: outcome.status, message: outcome.message };
    }

    if (room.readinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(command.action)) {
      return { status: 'unavailable', httpStatus: 409, message: 'The host must choose whether to start, wait or cancel.' };
    }
    if (!room.viewers.size) return { status: 'unavailable', httpStatus: 409, message: 'No viewer is connected.' };
    if (command.action.startsWith('media.') && !room.hasMedia) {
      return { status: 'unavailable', httpStatus: 409, message: 'Choose a video first.' };
    }

    const applied = applyTimelineCommand(room, command, { now, monoNow, createId });
    if (!applied) {
      return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
    }
    room.revision++;
    room.lastActivity = now;
    refreshRoom(room, now, monoNow);
    await options.onPersist?.(room);
    if (['media.play', 'media.toggle'].includes(command.action) && room.initialGate && !room.manualPaused) {
      await maybeAutoStart(room);
    }
    emitChange(room, false, command.action);
    return { status: 'applied', revision: room.revision, message: 'Viewing room updated.' };
  }

  function recordSyncQuality(roomId, actor, message, { tenantId = actor?.tenantId || 'default' } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room || message?.roomId !== roomId) return { ok: false, code: 4003 };
    if (!validateSyncQualityMessage(message, { idPattern: options.idPattern })) return { ok: false, code: 4002 };
    const viewer = room.viewers.get(message.viewerId);
    if (!viewer || viewer.userId !== actor?.userId) return { ok: false, code: 4003 };
    if (room.mediaVersion !== message.mediaVersion || viewer.streamVersion !== message.streamVersion) {
      return { ok: true, ignored: true };
    }
    const now = nowFn();
    const outcome = reduceViewerSyncQuality(viewer.syncQuality, message, {
      now,
      mediaVersion: room.mediaVersion,
      streamVersion: viewer.streamVersion,
      lastAt: viewer.lastSyncQualityAt,
      lastStatus: viewer.lastSyncQualityStatus,
      lastConfidence: viewer.lastSyncQualityConfidence
    });
    if (!outcome.throttled) {
      viewer.syncQuality = outcome.next;
      viewer.lastSyncQualityAt = now;
      viewer.lastSyncQualityStatus = message.status;
      viewer.lastSyncQualityConfidence = message.confidence;
      if (outcome.displayChanged) emitChange(room, false, 'sync-quality');
    }
    return { ok: true, displayChanged: outcome.displayChanged };
  }

  function snapshot(roomId, actor, { viewerId, tenantId = actor?.tenantId || 'default', envelopeOnly = false } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room) throw Object.assign(new Error('Room unavailable'), { status: 404 });
    const receivedAt = nowFn(), receivedMono = monoNowFn();
    refreshRoom(room, receivedAt, receivedMono);
    const viewer = viewerId ? room.viewers.get(viewerId) : undefined;
    const { waitingForReady, readiness } = snapshotReadiness(room, receivedMono);
    room.transportSequence++;
    const memberIds = [...new Set([...room.viewers.values()].map(v => v.userId))];
    const participants = aggregateParticipantSyncQuality(
      room,
      memberIds.map(id => ({ id })),
      receivedAt
    );
    const isAdmin = checkAdmin(actor, room);
    const coordination = {
      id: room.id,
      tenantId: room.tenantId,
      transportSequence: room.transportSequence,
      epoch: room.epoch,
      revision: room.revision,
      mediaVersion: room.mediaVersion,
      streamVersion: viewer?.streamVersion,
      observationEpoch: viewer?.observationEpoch,
      serverNow: receivedAt,
      startAt: room.startAt,
      pauseAt: room.pauseAt,
      waitingForReady,
      readinessVersion: room.readinessVersion,
      readiness,
      visibility: room.visibility,
      roomRole: actor?.userId ? Policy.role(room, actor.userId) : undefined,
      canPlayback: actor?.userId ? Policy.allowed(room, actor.userId, 'playPause', { isAdmin }) : false,
      canManage: actor?.userId ? Policy.allowed(room, actor.userId, 'roomSettings', { isAdmin }) : false,
      viewers: memberIds.length,
      timeline: {
        paused: room.paused,
        position: position(room, receivedAt),
        duration: room.duration,
        seekable: room.seekable
      },
      timing: {
        serverReceivedAt: receivedAt,
        serverSentAt: nowFn(),
        serverProcessingMs: monoNowFn() - receivedMono,
        clockEpoch
      }
    };
    const content = {
      ...room.content,
      participants
    };
    return envelopeOnly ? { coordination, content } : composeRoomSnapshot({ coordination, content });
  }

  async function listRooms(actor, { tenantId = actor?.tenantId || 'default' } = {}) {
    const visible = [];
    const now = nowFn(), monoNow = monoNowFn();
    for (const room of rooms.values()) {
      if (room.tenantId !== tenantId) continue;
      refreshRoom(room, now, monoNow);
      if (!await checkAuthorized(room, actor, 'list')) continue;
      const members = [...new Map([...room.viewers.values()].map(v => [v.userId, v.name])).values()];
      visible.push({
        id: room.id,
        tenantId: room.tenantId,
        name: room.name,
        hostName: room.hostName,
        visibility: room.visibility,
        viewers: members.length,
        members
      });
    }
    return visible;
  }

  async function closeRoom(roomId, actor, { epoch, tenantId = actor?.tenantId || 'default' } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room) return { status: 'unavailable', httpStatus: 404, message: 'Room unavailable' };
    if (!await checkAuthorized(room, actor, 'close') ||
        !Policy.allowed(room, actor.userId, 'closeRoom', { isAdmin: checkAdmin(actor, room) })) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room close permission required' };
    }
    if (epoch !== undefined && epoch !== room.epoch) {
      return { status: 'unavailable', httpStatus: 409, message: 'Room changed; refresh before closing' };
    }
    rooms.delete(roomKey(tenantId, roomId));
    emitChange(room, true, 'room-closed');
    return { status: 'applied', ok: true };
  }

  function touchViewer(roomId, viewerId, { tenantId = 'default', rttMs } = {}) {
    const room = getRoom(roomId, tenantId);
    const viewer = room?.viewers.get(viewerId);
    if (!viewer) return false;
    const now = nowFn(), monoNow = monoNowFn();
    viewer.at = now;
    if (Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 10000) {
      viewer.rtts = [...(viewer.rtts || []), { at: monoNow, ms: rttMs }]
        .filter(sample => monoNow - sample.at <= 30000)
        .slice(-16);
    }
    return true;
  }

  function sweep(now = nowFn(), monoNow = monoNowFn()) {
    for (const room of rooms.values()) refreshRoom(room, now, monoNow);
  }

  return {
    clockEpoch,
    rooms,
    createRoom,
    getRoom,
    listRooms,
    closeRoom,
    loadTimeline,
    joinViewer,
    leaveViewer,
    touchViewer,
    reportReadiness,
    executeCommand,
    recordSyncQuality,
    snapshot,
    sweep
  };
}
