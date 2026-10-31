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
  const roomLocks = new WeakMap();

  function normalizeTenantId(value) {
    if (value === undefined) return 'default';
    if (typeof value !== 'string' || value.length === 0) return undefined;
    return value;
  }

  function resolveActorTenant(actor, requestedTenantId) {
    if (!actor || typeof actor !== 'object' || typeof actor.userId !== 'string' || !actor.userId) {
      return undefined;
    }
    const actorTenant = normalizeTenantId(actor.tenantId);
    if (!actorTenant) return undefined;
    if (requestedTenantId !== undefined) {
      const requested = normalizeTenantId(requestedTenantId);
      if (!requested || requested !== actorTenant) return undefined;
    }
    return actorTenant;
  }

  const roomKey = (tenantId, roomId) => `${encodeURIComponent(tenantId)}::${roomId}`;

  function getRoom(roomId, tenantId = 'default') {
    const normalizedTenant = normalizeTenantId(tenantId);
    if (!normalizedTenant || typeof roomId !== 'string' || !roomId) return undefined;
    return rooms.get(roomKey(normalizedTenant, roomId));
  }

  function withRoomLock(room, fn) {
    const previous = roomLocks.get(room) || Promise.resolve();
    const current = previous.then(fn, fn);
    roomLocks.set(room, current.then(() => undefined, () => undefined));
    return current;
  }

  const checkAdmin = (actor, room) => Boolean(
    actor && room && resolveActorTenant(actor, room.tenantId) && options.isAdmin?.(actor, room)
  );

  async function checkAuthorized(room, actor, operation, command) {
    if (!room) return false;
    const actorTenant = resolveActorTenant(actor, room.tenantId);
    if (!actorTenant) return false;
    const isAdmin = checkAdmin(actor, room);
    if (room.visibility === 'private' && !isAdmin && !Policy.assigned(room, actor.userId)) return false;
    if (options.authorize) {
      const allowedByHost = await options.authorize({ tenantId: room.tenantId, room, actor, operation, command });
      if (!allowedByHost) return false;
    }
    return true;
  }

  function pendingSettlementRevisions(room, now, monoNow) {
    let delta = 0;
    const singleViewer = room.viewers.size === 1;
    if (singleViewer && room.startAt > now) delta++;
    const effectivePauseAt = singleViewer && room.pauseAt > now ? now : room.pauseAt;
    if (effectivePauseAt && now >= effectivePauseAt) delta++;
    if (!room.recovery && room.initialGate && !room.manualPaused && !room.readinessTimedOut && monoNow >= room.readinessDeadline) {
      delta++;
    }
    return delta;
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

  function refreshRoom(room, now = nowFn(), monoNow = monoNowFn(), { triggerAutoStart = false } = {}) {
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
      if (triggerAutoStart) void maybeAutoStart(room);
    }
    if (room.hasMedia && room.duration > 0 && !room.paused && position(room, now) >= room.duration) {
      room.position = room.duration;
      room.changedAt = now;
      room.paused = true;
      room.revision++;
    }
    return { pruned };
  }

  function formatRoomSnapshot(room, {
    actor,
    viewer,
    receivedAt,
    receivedMono,
    envelopeOnly = false,
    bumpSequence = false
  }) {
    const { waitingForReady, readiness } = snapshotReadiness(room, receivedMono);
    if (bumpSequence) room.transportSequence++;
    const memberIds = [...new Set([...room.viewers.values()].map(v => v.userId))];
    const participants = aggregateParticipantSyncQuality(
      room,
      memberIds.map(id => ({ id })),
      receivedAt
    );
    const isAdmin = actor ? checkAdmin(actor, room) : false;
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

  function createRoom({
    roomId = createId(),
    tenantId,
    actor,
    creatorId = actor?.userId,
    creatorName = actor?.name || 'Host',
    name = '',
    visibility = 'public',
    hosts = [],
    permissions: customPermissions,
    content = {}
  }) {
    const resolvedTenant = actor !== undefined
      ? resolveActorTenant(actor, tenantId)
      : normalizeTenantId(tenantId);
    if (!resolvedTenant) {
      throw Object.assign(new Error('Invalid or unauthorized tenant'), { status: 403 });
    }
    if (actor !== undefined && creatorId !== actor.userId) {
      throw Object.assign(new Error('Creator identity mismatch'), { status: 403 });
    }
    if (typeof roomId !== 'string' || !roomId) throw new Error('roomId is required');
    if (typeof creatorId !== 'string' || !creatorId) throw new Error('creatorId is required');
    if (!['public', 'private'].includes(visibility)) throw new Error('Invalid room visibility');
    const key = roomKey(resolvedTenant, roomId);
    if (rooms.has(key)) throw new Error('Room already exists');
    const now = nowFn();
    const room = {
      id: roomId,
      tenantId: resolvedTenant,
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
    tenantId,
    expectedRevision,
    duration = 0,
    position: initialPosition = 0,
    autoplay = true,
    content = {}
  } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
    }
    const room = getRoom(roomId, resolvedTenant);
    if (!room) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
    }
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'loadTimeline')) {
        return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
      }
      if (!Policy.allowed(room, actor.userId, 'chooseMedia', { isAdmin: checkAdmin(actor, room) })) {
        return { status: 'forbidden', httpStatus: 403, message: 'Choose media permission required' };
      }
      const now = nowFn(), monoNow = monoNowFn();
      if (expectedRevision !== undefined) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          return { status: 'unavailable', httpStatus: 400, reason: 'invalid-revision', message: 'Invalid expected revision' };
        }
        const effectiveRevision = room.revision + pendingSettlementRevisions(room, now, monoNow);
        if (expectedRevision !== effectiveRevision) {
          return { status: 'unavailable', httpStatus: 409, reason: 'revision-mismatch', message: 'Room revision changed; refresh and retry' };
        }
      }
      if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid timeline duration');
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
    });
  }

  async function joinViewer(roomId, actor, {
    viewerId,
    tenantId,
    rtts = [],
    envelopeOnly = false
  }) {
    if (typeof viewerId !== 'string' || !viewerId) {
      throw Object.assign(new Error('Invalid viewer identifier'), { status: 400 });
    }
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    const room = getRoom(roomId, resolvedTenant);
    if (!room) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'join')) {
        throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
      }
      const now = nowFn(), monoNow = monoNowFn();
      if ((room.kickedViewers.get(viewerId) || 0) > now) {
        throw Object.assign(new Error('You were removed from this room. You may rejoin.'), { status: 403 });
      }
      const existingBeforeRefresh = room.viewers.get(viewerId);
      if (existingBeforeRefresh && existingBeforeRefresh.userId !== actor.userId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
      const savedBeforeRefresh = !existingBeforeRefresh && room.disconnectedViewers.get(viewerId);
      if (savedBeforeRefresh && savedBeforeRefresh.userId !== actor.userId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
      room.kickedViewers.delete(viewerId);
      const { pruned } = refreshRoom(room, now, monoNow);
      if (pruned) await maybeAutoStart(room);
      const existing = room.viewers.get(viewerId);
      const saved = !existing && room.disconnectedViewers.get(viewerId);
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
      return formatRoomSnapshot(room, {
        actor,
        viewer,
        receivedAt: now,
        receivedMono: monoNow,
        envelopeOnly,
        bumpSequence: true
      });
    });
  }

  async function leaveViewerUnlocked(room, actor, { viewerId, reason = 'left' }) {
    if (typeof viewerId !== 'string' || !viewerId) return false;
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

  async function leaveViewer(roomId, actor, {
    viewerId,
    tenantId,
    reason = 'left'
  }) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) return false;
    const room = getRoom(roomId, resolvedTenant);
    if (!room) return false;
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room) return false;
      return leaveViewerUnlocked(room, actor, { viewerId, reason });
    });
  }

  async function reportReadiness(roomId, actor, {
    viewerId,
    mediaVersion,
    ready,
    readinessVersion,
    tenantId
  }) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    const room = resolvedTenant ? getRoom(roomId, resolvedTenant) : undefined;
    if (!room) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'ready')) {
        throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
      }
      const now = nowFn(), monoNow = monoNowFn();
      const viewer = room.viewers.get(viewerId);
      if (!viewer || viewer.userId !== actor.userId || room.mediaVersion !== mediaVersion ||
          typeof ready !== 'boolean' || room.readinessVersion !== readinessVersion) {
        throw new Error('Invalid readiness');
      }
      recordViewerReadiness(room, { userId: actor.userId, viewerId, mediaVersion, ready, readinessVersion }, { now, monoNow });
      await maybeAutoStart(room);
      emitChange(room, false, 'viewer-ready');
      return { ok: true };
    });
  }

  async function executeCommand(roomId, actor, envelopeInput, { tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    const room = resolvedTenant ? getRoom(roomId, resolvedTenant) : undefined;
    if (!room) {
      return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
    }
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'command', envelopeInput?.command)) {
        return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
      }
      const now = nowFn(), monoNow = monoNowFn();
      const effectiveRevision = room.revision + pendingSettlementRevisions(room, now, monoNow);
      const checkedEnvelope = validateCommandEnvelope(envelopeInput, {
        expectedEpoch: room.epoch,
        currentRevision: effectiveRevision,
        now,
        maxTtlMs: commandTtlMs
      });
      if (!checkedEnvelope.ok) {
        return { status: 'unavailable', httpStatus: checkedEnvelope.status, reason: checkedEnvelope.reason, message: checkedEnvelope.error };
      }
      if (checkedEnvelope.coordination.tenantId !== undefined && checkedEnvelope.coordination.tenantId !== resolvedTenant) {
        return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
      }
      if (checkedEnvelope.coordination.roomId !== undefined && checkedEnvelope.coordination.roomId !== roomId) {
        return { status: 'unavailable', httpStatus: 400, reason: 'room-mismatch', message: 'Invalid command target.' };
      }
      if (checkedEnvelope.coordination.senderId !== undefined && checkedEnvelope.coordination.senderId !== actor.userId) {
        return { status: 'forbidden', httpStatus: 403, message: 'Invalid command sender.' };
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
          await leaveViewerUnlocked(room, v.actor, { viewerId: id, reason: 'kicked' });
        }
        return { status: 'applied', revision: room.revision, message: 'Participant removed. They may rejoin.' };
      }

      if (command.action === 'room.visibility') {
        room.visibility = command.args.visibility;
        room.disconnectedViewers.clear();
        invalidateEpoch(room, { createId });
        const { pruned } = refreshRoom(room, now, monoNow);
        if (pruned) await maybeAutoStart(room);
        await options.onPersist?.(room);
        if (room.initialGate && !room.manualPaused) await maybeAutoStart(room);
        emitChange(room, true, 'visibility-changed');
        return { status: 'applied', epoch: room.epoch, revision: room.revision, message: 'Viewing room updated.' };
      }

      const effectiveReadinessTimedOut = Boolean(
        room.readinessTimedOut ||
        (!room.recovery && room.initialGate && !room.manualPaused && monoNow >= room.readinessDeadline)
      );

      if (command.action.startsWith('media.ready.')) {
        if (!room.initialGate || !effectiveReadinessTimedOut || command.args.readinessId !== room.readinessId) {
          return { status: 'unavailable', httpStatus: 409, message: 'This readiness choice expired.' };
        }
        if (command.action === 'media.ready.start') {
          const hasReadyViewer = [...room.initialViewers].some(id => {
            const v = room.viewers.get(id);
            return Boolean(v?.ready && v.version === room.mediaVersion);
          });
          if (!hasReadyViewer) {
            return { status: 'unavailable', httpStatus: 409, message: 'No viewer is ready yet.' };
          }
        }
        settle(room, now, monoNow);
        const outcome = applyReadinessDecision(room, command.action, command.args.readinessId, { now, monoNow, createId });
        if (outcome.status === 'applied') {
          const { pruned } = refreshRoom(room, now, monoNow);
          if (pruned || outcome.checkAutoStart) await maybeAutoStart(room);
          await options.onPersist?.(room);
          emitChange(room, false, command.action);
          return { status: 'applied', revision: room.revision, message: outcome.message };
        }
        return { status: outcome.status, httpStatus: 409, message: outcome.message };
      }

      if (effectiveReadinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(command.action)) {
        return { status: 'unavailable', httpStatus: 409, message: 'The host must choose whether to start, wait or cancel.' };
      }
      if (!room.viewers.size) return { status: 'unavailable', httpStatus: 409, message: 'No viewer is connected.' };
      if (command.action.startsWith('media.') && !room.hasMedia) {
        return { status: 'unavailable', httpStatus: 409, message: 'Choose a video first.' };
      }
      if (!TIMELINE_ACTIONS.has(command.action)) {
        return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
      }

      settle(room, now, monoNow);
      const applied = applyTimelineCommand(room, command, { now, monoNow, createId });
      if (!applied) {
        return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
      }
      room.revision++;
      room.lastActivity = now;
      const { pruned } = refreshRoom(room, now, monoNow);
      if (pruned) await maybeAutoStart(room);
      await options.onPersist?.(room);
      if (['media.play', 'media.toggle'].includes(command.action) && room.initialGate && !room.manualPaused) {
        await maybeAutoStart(room);
      }
      emitChange(room, false, command.action);
      return { status: 'applied', revision: room.revision, message: 'Viewing room updated.' };
    });
  }

  function recordSyncQuality(roomId, actor, message, { tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) return { ok: false, code: 4003 };
    if (message?.tenantId !== undefined && message.tenantId !== resolvedTenant) return { ok: false, code: 4003 };
    const room = getRoom(roomId, resolvedTenant);
    if (!room || message?.roomId !== roomId) return { ok: false, code: 4003 };
    if (room.visibility === 'private' && !checkAdmin(actor, room) && !Policy.assigned(room, actor.userId)) {
      return { ok: false, code: 4003 };
    }
    if (!validateSyncQualityMessage(message, { idPattern: options.idPattern })) return { ok: false, code: 4002 };
    const viewer = room.viewers.get(message.viewerId);
    if (!viewer || viewer.userId !== actor.userId) return { ok: false, code: 4003 };
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

  /**
   * Retrieve an authorized, tenant-isolated room snapshot for a specific `actor`.
   * Rejects missing, cross-tenant, private-unauthorized, kicked, and revoked requests
   * without mutating room state or leaking room existence across authorization boundaries.
   */
  async function snapshot(roomId, actor, { viewerId, tenantId, envelopeOnly = false } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    const room = resolvedTenant ? getRoom(roomId, resolvedTenant) : undefined;
    if (!room || !await checkAuthorized(room, actor, 'snapshot')) {
      throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
    }
    const receivedAt = nowFn(), receivedMono = monoNowFn();
    if (viewerId !== undefined) {
      if (typeof viewerId !== 'string' || !viewerId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
      if ((room.kickedViewers.get(viewerId) || 0) > receivedAt) {
        throw Object.assign(new Error('You were removed from this room. You may rejoin.'), { status: 403 });
      }
      const existingViewer = room.viewers.get(viewerId);
      if (existingViewer && existingViewer.userId !== actor.userId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
      const savedViewer = !existingViewer && room.disconnectedViewers.get(viewerId);
      if (savedViewer && savedViewer.userId !== actor.userId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
    }
    const { pruned } = refreshRoom(room, receivedAt, receivedMono);
    if (pruned) await maybeAutoStart(room);
    const viewer = viewerId ? room.viewers.get(viewerId) : undefined;
    return formatRoomSnapshot(room, {
      actor,
      viewer,
      receivedAt,
      receivedMono,
      envelopeOnly,
      bumpSequence: true
    });
  }

  /**
   * Privileged server-internal room inspection for trusted persistence, diagnostics, or
   * administrative sweeps. Does not mutate `transportSequence` or room presence state.
   *
   * Trust boundary: NEVER wire `inspectRoomInternal` directly to untrusted client requests
   * or caller-supplied `tenantId` values; use `await coordinator.snapshot(roomId, actor, ...)`
   * for all user-facing reads and WebSocket subscriber publications.
   */
  function inspectRoomInternal(roomId, { tenantId = 'default', envelopeOnly = true } = {}) {
    const room = getRoom(roomId, tenantId);
    if (!room) return undefined;
    const receivedAt = nowFn(), receivedMono = monoNowFn();
    return formatRoomSnapshot(room, {
      actor: undefined,
      viewer: undefined,
      receivedAt,
      receivedMono,
      envelopeOnly,
      bumpSequence: false
    });
  }

  async function listRooms(actor, { tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) {
      throw Object.assign(new Error('Unauthorized tenant access'), { status: 403 });
    }
    const visible = [];
    const now = nowFn(), monoNow = monoNowFn();
    for (const room of rooms.values()) {
      if (room.tenantId !== resolvedTenant) continue;
      if (!await checkAuthorized(room, actor, 'list')) continue;
      const { pruned } = refreshRoom(room, now, monoNow);
      if (pruned) await maybeAutoStart(room);
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

  async function closeRoom(roomId, actor, { epoch, expectedRevision, tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
    }
    const room = getRoom(roomId, resolvedTenant);
    if (!room) {
      return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
    }
    return withRoomLock(room, async () => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'close')) {
        return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
      }
      if (!Policy.allowed(room, actor.userId, 'closeRoom', { isAdmin: checkAdmin(actor, room) })) {
        return { status: 'forbidden', httpStatus: 403, message: 'Room close permission required' };
      }
      if (expectedRevision !== undefined) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          return { status: 'unavailable', httpStatus: 400, reason: 'invalid-revision', message: 'Invalid expected revision' };
        }
        const effectiveRevision = room.revision + pendingSettlementRevisions(room, nowFn(), monoNowFn());
        if (expectedRevision !== effectiveRevision) {
          return { status: 'unavailable', httpStatus: 409, reason: 'revision-mismatch', message: 'Room revision changed; refresh before closing' };
        }
      }
      if (epoch !== undefined && epoch !== room.epoch) {
        return { status: 'unavailable', httpStatus: 409, reason: 'epoch-mismatch', message: 'Room changed; refresh before closing' };
      }
      rooms.delete(roomKey(resolvedTenant, roomId));
      emitChange(room, true, 'room-closed');
      return { status: 'applied', ok: true };
    });
  }

  function touchViewer(roomId, viewerId, { tenantId, actor, rttMs } = {}) {
    const resolvedTenant = actor !== undefined
      ? resolveActorTenant(actor, tenantId)
      : normalizeTenantId(tenantId);
    if (!resolvedTenant || typeof viewerId !== 'string' || !viewerId) return false;
    const room = getRoom(roomId, resolvedTenant);
    const viewer = room?.viewers.get(viewerId);
    if (!viewer || (actor !== undefined && viewer.userId !== actor.userId)) return false;
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
    for (const room of rooms.values()) refreshRoom(room, now, monoNow, { triggerAutoStart: true });
  }

  return {
    clockEpoch,
    rooms,
    createRoom,
    getRoom,
    inspectRoomInternal,
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
