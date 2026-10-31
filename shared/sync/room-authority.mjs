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
 *   presenceAuthIntervalMs?:number,
 *   idPattern?:RegExp,
 *   authorize?:(context:{tenantId:string, room:any, actor:any, operation:string, command?:any})=>boolean|Promise<boolean>,
 *   isRevoked?:(context:{tenantId:string, roomId:string, actor:any, viewerId?:string})=>boolean,
 *   isAdmin?:(actor:any, room:any)=>boolean,
 *   validateExtensionCommand?:(command:any)=>({action:string, args:any}|undefined),
 *   onCreateRoom?:(room:any)=>void|Promise<void>,
 *   onPersist?:(room:any, meta?:{operation:string, reason:string, previousRevision?:number})=>void|Promise<void>,
 *   onDeleteRoom?:(context:{tenantId:string, roomId:string, epoch:string, revision:number, closedAt:number, room:any})=>void|Promise<void>,
 *   onPublish?:(event:{tenantId:string, roomId:string, includeLobby:boolean, reason:string})=>void
 * }} [options]
 */
export function createRoomCoordinator(options = {}) {
  const nowFn = options.now || Date.now;
  const monoNowFn = options.monoNow || defaultMonoNow;
  const createId = options.createId || defaultCreateId;
  const clockEpoch = options.clockEpoch || createId();
  const commandTtlMs = options.commandTtlMs ?? COMMAND_TTL_MS;
  const presenceAuthIntervalMs = options.presenceAuthIntervalMs ?? Math.floor(PRESENCE_TIMEOUT_MS / 2);
  const rooms = new Map();
  const roomLocks = new WeakMap();
  const keyLocks = new Map();

  function cloneValue(value) {
    if (value === undefined || value === null || typeof value !== 'object') return value;
    if (typeof globalThis.structuredClone === 'function') {
      return globalThis.structuredClone(value);
    }
    return JSON.parse(JSON.stringify(value));
  }

  function cloneViewer(viewer) {
    return {
      ...viewer,
      actor: viewer.actor ? { ...viewer.actor } : undefined,
      rtts: Array.isArray(viewer.rtts) ? viewer.rtts.map(sample => ({ ...sample })) : [],
      syncQuality: viewer.syncQuality ? cloneValue(viewer.syncQuality) : undefined
    };
  }

  function cloneRoomState(room) {
    const viewers = new Map();
    for (const [id, viewer] of room.viewers) {
      viewers.set(id, cloneViewer(viewer));
    }
    const disconnectedViewers = new Map();
    for (const [id, saved] of room.disconnectedViewers) {
      disconnectedViewers.set(id, {
        ...saved,
        syncQuality: saved.syncQuality ? cloneValue(saved.syncQuality) : undefined
      });
    }
    return {
      ...room,
      hosts: [...room.hosts],
      permissions: {
        host: { ...room.permissions.host },
        viewer: { ...room.permissions.viewer },
        allHosts: room.permissions.allHosts
      },
      controls: { ...room.controls },
      initialViewers: new Set(room.initialViewers),
      viewers,
      disconnectedViewers,
      kickedViewers: new Map(room.kickedViewers),
      content: cloneValue(room.content)
    };
  }

  function commitRoomDraft(room, draft) {
    const previousViewers = room.viewers;
    const mergedViewers = new Map();
    for (const [id, draftViewer] of draft.viewers) {
      const liveViewer = previousViewers.get(id);
      if (liveViewer && liveViewer.userId === draftViewer.userId) {
        if (liveViewer.revoked) {
          mergedViewers.set(id, { ...draftViewer, revoked: true });
          continue;
        }
        const liveTouchedMoreRecently =
          (liveViewer.touchSequence || 0) > (draftViewer.touchSequence || 0) ||
          liveViewer.at > draftViewer.at;
        const sameStream = liveViewer.streamVersion === draftViewer.streamVersion && draft.mediaVersion === room.mediaVersion;
        mergedViewers.set(id, {
          ...draftViewer,
          at: liveTouchedMoreRecently ? liveViewer.at : draftViewer.at,
          touchSequence: Math.max(draftViewer.touchSequence || 0, liveViewer.touchSequence || 0),
          authVerifiedAt: Math.max(draftViewer.authVerifiedAt ?? -Infinity, liveViewer.authVerifiedAt ?? -Infinity),
          rtts: liveTouchedMoreRecently && Array.isArray(liveViewer.rtts)
            ? liveViewer.rtts.map(sample => ({ ...sample }))
            : draftViewer.rtts,
          ...(sameStream && (liveViewer.lastSyncQualityAt ?? -Infinity) > (draftViewer.lastSyncQualityAt ?? -Infinity)
            ? {
                syncQuality: liveViewer.syncQuality ? cloneValue(liveViewer.syncQuality) : undefined,
                lastSyncQualityAt: liveViewer.lastSyncQualityAt,
                lastSyncQualityStatus: liveViewer.lastSyncQualityStatus,
                lastSyncQualityConfidence: liveViewer.lastSyncQualityConfidence
              }
            : {})
        });
      } else {
        mergedViewers.set(id, draftViewer);
      }
    }
    const nextSequence = Math.max(room.transportSequence || 0, draft.transportSequence || 0);
    Object.assign(room, draft, {
      viewers: mergedViewers,
      transportSequence: nextSequence
    });
  }

  function durableStateChanged(before, after) {
    return (
      before.visibility !== after.visibility ||
      before.epoch !== after.epoch ||
      before.mediaVersion !== after.mediaVersion ||
      before.hasMedia !== after.hasMedia ||
      before.paused !== after.paused ||
      before.position !== after.position ||
      before.duration !== after.duration ||
      before.seekable !== after.seekable ||
      before.changedAt !== after.changedAt ||
      before.startAt !== after.startAt ||
      before.pauseAt !== after.pauseAt ||
      before.initialGate !== after.initialGate ||
      before.manualPaused !== after.manualPaused ||
      Boolean(before.readinessTimedOut) !== Boolean(after.readinessTimedOut) ||
      before.readinessVersion !== after.readinessVersion
    );
  }

  function advanceRevision(baseRoom, draft) {
    const floor = Math.max(baseRoom.revision, baseRoom.reservedRevision || 0);
    draft.revision = Math.max(draft.revision, floor + 1);
  }

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

  function withKeyLock(key, fn) {
    const previous = keyLocks.get(key) || Promise.resolve();
    const current = previous.then(fn, fn);
    const settled = current.then(() => undefined, () => undefined);
    keyLocks.set(key, settled);
    settled.then(() => {
      if (keyLocks.get(key) === settled) keyLocks.delete(key);
    });
    return current;
  }

  function withRoomLock(room, fn) {
    const previous = roomLocks.get(room) || Promise.resolve();
    const current = previous.then(fn, fn);
    roomLocks.set(room, current.then(() => undefined, () => undefined));
    return current;
  }

  /**
   * Run a serialized per-room state transition. Any `queuePublish` events are emitted
   * only AFTER the lock releases and in-memory state has committed, preventing both
   * premature publication of failed transitions and re-entrant publication deadlocks.
   */
  async function runRoomTransaction(room, fn) {
    const pendingEvents = [];
    const outcome = await withRoomLock(room, () => fn(event => pendingEvents.push(event)));
    for (const event of pendingEvents) {
      options.onPublish?.(event);
    }
    return outcome;
  }

  async function persistRoomTransition(baseRoom, draft, meta) {
    if (!options.onPersist) return;
    advanceRevision(baseRoom, draft);
    const isolatedPayload = cloneRoomState(draft);
    try {
      await options.onPersist(isolatedPayload, {
        operation: meta.operation,
        reason: meta.reason,
        previousRevision: baseRoom.revision
      });
    } catch (err) {
      if (err && typeof err === 'object' && (err.ambiguous === true || err.persistenceUncertain === true)) {
        baseRoom.persistenceUncertain = true;
        baseRoom.reservedRevision = Math.max(baseRoom.reservedRevision || baseRoom.revision, draft.revision);
      }
      throw err;
    }
  }

  const checkAdmin = (actor, room) => Boolean(
    actor && room && resolveActorTenant(actor, room.tenantId) && options.isAdmin?.(actor, room)
  );

  function checkFastRevoked(room, actor, viewerId) {
    if (!room || !actor) return true;
    return Boolean(options.isRevoked?.({
      tenantId: room.tenantId,
      roomId: room.id,
      actor,
      viewerId
    }));
  }

  async function checkAuthorized(room, actor, operation, command, viewerId) {
    if (!room) return false;
    const actorTenant = resolveActorTenant(actor, room.tenantId);
    if (!actorTenant) return false;
    if (checkFastRevoked(room, actor, viewerId)) return false;
    const isAdmin = checkAdmin(actor, room);
    if (room.visibility === 'private' && !isAdmin && !Policy.assigned(room, actor.userId)) return false;
    if (options.authorize) {
      // Pass a cloned view of room so `authorize` cannot accidentally mutate live state.
      const allowedByHost = await options.authorize({
        tenantId: room.tenantId,
        room: cloneRoomState(room),
        actor: { ...actor },
        operation,
        command
      });
      if (!allowedByHost) return false;
    }
    return true;
  }

  function applyAutoStartOnDraft(draft, now, monoNow) {
    if (!areInitialViewersReady(draft)) return false;
    const hostViewer = [...draft.viewers.values()].find(
      v => v.userId === draft.hostId ||
           Policy.role(draft, v.userId) !== 'viewer' ||
           Policy.allowed(draft, v.userId, 'continueWithoutHost')
    );
    if (!hostViewer) return false;
    settle(draft, now, monoNow);
    if (!areInitialViewersReady(draft)) return false;
    draft.initialGate = false;
    applyTimelineCommand(draft, { action: 'media.play', args: {} }, {
      now,
      monoNow,
      autoplayVersion: draft.mediaVersion,
      createId
    });
    draft.revision++;
    draft.lastActivity = now;
    return true;
  }

  function settleAndPruneDraft(draft, now = nowFn(), monoNow = monoNowFn(), revokedViewerIds = undefined) {
    settle(draft, now, monoNow);
    for (const [id, expiry] of draft.kickedViewers) {
      if (expiry <= now) draft.kickedViewers.delete(id);
    }
    let pruned = false, hostRemoved = false, autoStarted = false;
    for (const [id, saved] of draft.disconnectedViewers) {
      if (saved.expires <= now || saved.mediaVersion !== draft.mediaVersion ||
          draft.visibility === 'private' && !Policy.assigned(draft, saved.userId)) {
        draft.disconnectedViewers.delete(id);
      }
    }
    for (const [id, viewer] of draft.viewers) {
      const revoked = Boolean(viewer.revoked || revokedViewerIds?.has(id) || checkFastRevoked(draft, viewer.actor, id));
      const unauthorizedPrivate = draft.visibility === 'private' &&
        !Policy.assigned(draft, viewer.userId) &&
        !checkAdmin(viewer.actor, draft);
      const timedOut = now - viewer.at > PRESENCE_TIMEOUT_MS;
      if (timedOut || unauthorizedPrivate || revoked) {
        if (timedOut && !unauthorizedPrivate && !revoked) {
          draft.disconnectedViewers.set(id, {
            userId: viewer.userId,
            mediaVersion: draft.mediaVersion,
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
          if (draft.disconnectedViewers.size > MAX_DISCONNECTED_VIEWERS) {
            draft.disconnectedViewers.delete(draft.disconnectedViewers.keys().next().value);
          }
        } else {
          draft.disconnectedViewers.delete(id);
        }
        if (viewer.userId === draft.hostId) hostRemoved = true;
        draft.viewers.delete(id);
        draft.initialViewers.delete(id);
        pruned = true;
      }
    }
    if (hostRemoved) invalidateEpoch(draft, { createId });
    else if (pruned) draft.revision++;
    if (pruned) {
      settle(draft, now, monoNow);
      autoStarted = applyAutoStartOnDraft(draft, now, monoNow);
    }
    if (draft.hasMedia && draft.duration > 0 && !draft.paused && position(draft, now) >= draft.duration) {
      draft.position = draft.duration;
      draft.changedAt = now;
      draft.paused = true;
      draft.revision++;
    }
    return { pruned, autoStarted };
  }

  /**
   * Project a read-only view of committed `room` state at `(receivedAt, receivedMono)`
   * without mutating authoritative room fields (`revision`, `paused`, `position`,
   * `viewers`, `initialGate`, etc.).
   */
  function projectRoomReadOnly(room, receivedAt, receivedMono) {
    const activeViewers = new Map();
    const projectedDisconnected = new Map();
    for (const [id, saved] of room.disconnectedViewers) {
      if (saved.expires > receivedAt && saved.mediaVersion === room.mediaVersion &&
          !(room.visibility === 'private' && !Policy.assigned(room, saved.userId))) {
        projectedDisconnected.set(id, saved);
      }
    }
    for (const [id, viewer] of room.viewers) {
      const revoked = Boolean(viewer.revoked || checkFastRevoked(room, viewer.actor, id));
      const unauthorizedPrivate = room.visibility === 'private' &&
        !Policy.assigned(room, viewer.userId) &&
        !checkAdmin(viewer.actor, room);
      const timedOut = receivedAt - viewer.at > PRESENCE_TIMEOUT_MS;
      if (revoked || unauthorizedPrivate) continue;
      if (timedOut) {
        const graceExpires = viewer.at + PRESENCE_TIMEOUT_MS + RECONNECT_GRACE_MS;
        if (graceExpires > receivedAt) {
          projectedDisconnected.set(id, {
            userId: viewer.userId,
            mediaVersion: room.mediaVersion,
            streamVersion: viewer.streamVersion,
            expires: graceExpires,
            joinedAt: viewer.joinedAt,
            syncQuality: viewer.syncQuality ? {
              ...viewer.syncQuality,
              status: 'disconnected',
              confidence: viewer.syncQuality.confidence === 'provisional' ? 'provisional' : 'reduced',
              updatedAt: viewer.at + PRESENCE_TIMEOUT_MS
            } : undefined
          });
        }
        continue;
      }
      activeViewers.set(id, viewer);
    }

    const singleViewer = activeViewers.size === 1;
    let effectiveStartAt = singleViewer && room.startAt > receivedAt ? receivedAt : room.startAt;
    let effectivePauseAt = singleViewer && room.pauseAt > receivedAt ? receivedAt : room.pauseAt;
    let effectivePaused = Boolean(room.paused);
    let effectivePosition = position({
      ...room,
      startAt: effectiveStartAt,
      pauseAt: effectivePauseAt,
      paused: effectivePaused
    }, receivedAt);
    if (effectivePauseAt && receivedAt >= effectivePauseAt) {
      effectivePaused = true;
      effectivePauseAt = undefined;
    }
    if (room.hasMedia && room.duration > 0 && !effectivePaused && effectivePosition >= room.duration) {
      effectivePosition = room.duration;
      effectivePaused = true;
    }

    const effectiveTimedOut = Boolean(
      room.readinessTimedOut ||
      (!room.recovery && room.initialGate && !room.manualPaused && receivedMono >= room.readinessDeadline)
    );
    const waitingForReady = Boolean(room.initialGate && !room.manualPaused && !effectiveTimedOut);
    let readiness;
    if (room.initialGate && !room.manualPaused) {
      const activeInitialIds = [...room.initialViewers].filter(id => activeViewers.has(id));
      const blockers = receivedMono - room.readinessSince >= READINESS_BLOCKER_REVEAL_MS
        ? activeInitialIds
            .map(id => activeViewers.get(id))
            .filter(v => v && (!v.ready || v.version !== room.mediaVersion))
            .map(v => v.name)
        : [];
      const canStart = activeInitialIds.some(id => {
        const v = activeViewers.get(id);
        return Boolean(v?.ready && v.version === room.mediaVersion);
      });
      readiness = {
        id: room.readinessId,
        timedOut: effectiveTimedOut,
        blockers,
        canStart
      };
    }

    return {
      activeViewers,
      projectedDisconnected,
      effectiveStartAt,
      effectivePauseAt,
      effectivePaused,
      effectivePosition,
      waitingForReady,
      readiness
    };
  }

  function formatRoomSnapshot(room, {
    actor,
    viewer,
    receivedAt,
    receivedMono,
    envelopeOnly = false,
    bumpSequence = false
  }) {
    const projected = projectRoomReadOnly(room, receivedAt, receivedMono);
    if (bumpSequence) room.transportSequence++;
    const memberIds = [...new Set([...projected.activeViewers.values()].map(v => v.userId))];
    const participants = aggregateParticipantSyncQuality(
      {
        mediaVersion: room.mediaVersion,
        viewers: projected.activeViewers,
        disconnectedViewers: projected.projectedDisconnected
      },
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
      startAt: projected.effectiveStartAt,
      pauseAt: projected.effectivePauseAt,
      waitingForReady: projected.waitingForReady,
      readinessVersion: room.readinessVersion,
      readiness: projected.readiness,
      visibility: room.visibility,
      roomRole: actor?.userId ? Policy.role(room, actor.userId) : undefined,
      canPlayback: actor?.userId ? Policy.allowed(room, actor.userId, 'playPause', { isAdmin }) : false,
      canManage: actor?.userId ? Policy.allowed(room, actor.userId, 'roomSettings', { isAdmin }) : false,
      viewers: memberIds.length,
      timeline: {
        paused: projected.effectivePaused,
        position: projected.effectivePosition,
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
      ...cloneValue(room.content),
      participants
    };
    return envelopeOnly ? { coordination, content } : composeRoomSnapshot({ coordination, content });
  }

  async function createRoom({
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
    let createdRoom;
    await withKeyLock(key, async () => {
      if (rooms.has(key)) throw new Error('Room already exists');
      const now = nowFn();
      const proposed = {
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
        persistenceUncertain: false,
        reservedRevision: 0,
        content: cloneValue(content || {})
      };
      if (actor !== undefined && !await checkAuthorized(proposed, actor, 'create')) {
        throw Object.assign(new Error('Room creation not authorized'), { status: 403 });
      }
      if (options.onCreateRoom) {
        await options.onCreateRoom(cloneRoomState(proposed));
      } else if (options.onPersist) {
        await options.onPersist(cloneRoomState(proposed), {
          operation: 'create',
          reason: 'room-created',
          previousRevision: undefined
        });
      }
      rooms.set(key, proposed);
      createdRoom = proposed;
    });
    options.onPublish?.({
      tenantId: createdRoom.tenantId,
      roomId: createdRoom.id,
      includeLobby: true,
      reason: 'room-created'
    });
    return createdRoom;
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
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'loadTimeline')) {
        return { status: 'forbidden', httpStatus: 403, message: 'Room unavailable or private' };
      }
      if (room.persistenceUncertain) {
        return { status: 'unavailable', httpStatus: 503, reason: 'persistence-uncertain', message: 'Room state requires persistence reconciliation.' };
      }
      if (!Policy.allowed(room, actor.userId, 'chooseMedia', { isAdmin: checkAdmin(actor, room) })) {
        return { status: 'forbidden', httpStatus: 403, message: 'Choose media permission required' };
      }
      if (expectedRevision !== undefined) {
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          return { status: 'unavailable', httpStatus: 400, reason: 'invalid-revision', message: 'Invalid expected revision' };
        }
        if (expectedRevision !== room.revision) {
          return { status: 'unavailable', httpStatus: 409, reason: 'revision-mismatch', message: 'Room revision changed; refresh and retry' };
        }
      }
      if (!Number.isFinite(duration) || duration < 0) throw new Error('Invalid timeline duration');

      const now = nowFn(), monoNow = monoNowFn();
      const draft = cloneRoomState(room);
      settleAndPruneDraft(draft, now, monoNow);
      draft.duration = duration;
      draft.position = Math.max(0, Math.min(duration || Infinity, initialPosition));
      draft.changedAt = now;
      draft.startAt = undefined;
      draft.pauseAt = undefined;
      draft.hasMedia = true;
      draft.seekable = duration > 0;
      draft.mediaVersion = createId();
      draft.readinessVersion = undefined;
      draft.paused = true;
      draft.manualPaused = !autoplay;
      draft.initialGate = true;
      draft.disconnectedViewers.clear();
      for (const viewer of draft.viewers.values()) {
        viewer.ready = false;
        viewer.streamVersion = createId();
        viewer.readinessBypassedVersion = undefined;
      }
      beginReadiness(draft, now, READINESS_WAIT_MS, { monoNow, createId });
      draft.initialViewers = new Set(draft.viewers.keys());
      draft.content = cloneValue(content || {});
      advanceRevision(room, draft);
      draft.lastActivity = now;

      await persistRoomTransition(room, draft, { operation: 'loadTimeline', reason: 'timeline-loaded' });
      commitRoomDraft(room, draft);
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'timeline-loaded' });
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
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'join', undefined, viewerId)) {
        throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
      }
      if (room.persistenceUncertain) {
        throw Object.assign(new Error('Room state requires persistence reconciliation.'), { status: 503 });
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

      const draft = cloneRoomState(room);
      draft.kickedViewers.delete(viewerId);
      const { autoStarted } = settleAndPruneDraft(draft, now, monoNow);
      const existing = draft.viewers.get(viewerId);
      const saved = !existing && draft.disconnectedViewers.get(viewerId);
      if (saved) draft.disconnectedViewers.delete(viewerId);
      const viewer = existing || {
        viewerId,
        userId: actor.userId,
        streamVersion: createId(),
        observationEpoch: createId(),
        readinessBypassedVersion: saved?.mediaVersion === draft.mediaVersion ? saved.readinessBypassedVersion : undefined,
        syncQuality: saved?.syncQuality ? cloneValue(saved.syncQuality) : undefined,
        ready: false,
        joinedAt: Math.min(now, saved?.joinedAt ?? now)
      };
      viewer.at = now;
      viewer.touchSequence = (existing?.touchSequence || 0) + 1;
      viewer.authVerifiedAt = now;
      viewer.revoked = false;
      viewer.name = senderName(actor.name, 'Participant');
      viewer.actor = { ...actor };
      viewer.rtts = Array.isArray(rtts) ? rtts.map(sample => ({ ...sample })) : [];
      draft.viewers.set(viewerId, viewer);
      draft.hadViewers = true;
      draft.lastActivity = now;
      if (!existing) {
        promoteGroupReadinessLead(draft, now);
        if (draft.initialGate) draft.initialViewers.add(viewerId);
      }

      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, { operation: 'joinViewer', reason: autoStarted ? 'ready-autostart' : 'viewer-joined' });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      if (!existing) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'viewer-joined' });
      }
      const committedViewer = room.viewers.get(viewerId);
      return formatRoomSnapshot(room, {
        actor,
        viewer: committedViewer,
        receivedAt: now,
        receivedMono: monoNow,
        envelopeOnly,
        bumpSequence: true
      });
    });
  }

  function removeViewerFromDraft(draft, viewerId, { reason = 'left', now, monoNow, preserveGrace = false } = {}) {
    if (!preserveGrace) {
      draft.disconnectedViewers.delete(viewerId);
    }
    const viewer = draft.viewers.get(viewerId);
    if (!viewer) return { removed: false, autoStarted: false };
    if (preserveGrace && !viewer.revoked) {
      const unauthorizedPrivate = draft.visibility === 'private' &&
        !Policy.assigned(draft, viewer.userId) &&
        !checkAdmin(viewer.actor, draft);
      if (!unauthorizedPrivate) {
        draft.disconnectedViewers.set(viewerId, {
          userId: viewer.userId,
          mediaVersion: draft.mediaVersion,
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
        if (draft.disconnectedViewers.size > MAX_DISCONNECTED_VIEWERS) {
          draft.disconnectedViewers.delete(draft.disconnectedViewers.keys().next().value);
        }
      } else {
        draft.disconnectedViewers.delete(viewerId);
      }
    }
    const hostLeft = viewer.userId === draft.hostId;
    draft.viewers.delete(viewerId);
    draft.initialViewers.delete(viewerId);
    draft.revision++;
    settle(draft, now, monoNow);
    if (hostLeft) {
      if (reason === 'left') draft.epoch = createId();
      else invalidateEpoch(draft, { createId });
    }
    const autoStarted = applyAutoStartOnDraft(draft, now, monoNow);
    return { removed: true, autoStarted };
  }

  async function evictRevokedViewer(room, viewerId, reason = 'revoked') {
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(room.id, room.tenantId) !== room) return false;
      const liveViewer = room.viewers.get(viewerId);
      const hadDisconnected = room.disconnectedViewers.has(viewerId);
      if (!liveViewer && !hadDisconnected) return false;
      const now = nowFn(), monoNow = monoNowFn();
      const draft = cloneRoomState(room);
      const { removed, autoStarted } = removeViewerFromDraft(draft, viewerId, {
        reason,
        now,
        monoNow,
        preserveGrace: false
      });
      if (!removed && !hadDisconnected) return false;
      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, { operation: 'revokeViewer', reason: 'viewer-left' });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      if (removed) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'viewer-left' });
      }
      return true;
    });
  }

  async function leaveViewer(roomId, actor, {
    viewerId,
    tenantId,
    reason = 'left',
    preserveReconnectGrace = reason === 'disconnected'
  }) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant || typeof viewerId !== 'string' || !viewerId) return false;
    const room = getRoom(roomId, resolvedTenant);
    if (!room) return false;
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room) return false;
      const disconnectedMatch = room.disconnectedViewers.get(viewerId)?.userId === actor.userId;
      const viewer = room.viewers.get(viewerId);
      if ((!viewer || viewer.userId !== actor.userId) && !disconnectedMatch) return false;
      const now = nowFn(), monoNow = monoNowFn();
      const draft = cloneRoomState(room);
      if (disconnectedMatch && !preserveReconnectGrace) draft.disconnectedViewers.delete(viewerId);
      if (!viewer || viewer.userId !== actor.userId) {
        commitRoomDraft(room, draft);
        return Boolean(disconnectedMatch && !preserveReconnectGrace);
      }
      const { autoStarted } = removeViewerFromDraft(draft, viewerId, {
        reason,
        now,
        monoNow,
        preserveGrace: Boolean(preserveReconnectGrace)
      });
      advanceRevision(room, draft);
      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, { operation: 'leaveViewer', reason: 'viewer-left' });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'viewer-left' });
      return true;
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
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room || !await checkAuthorized(room, actor, 'ready', undefined, viewerId)) {
        throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
      }
      if (room.persistenceUncertain) {
        throw Object.assign(new Error('Room state requires persistence reconciliation.'), { status: 503 });
      }
      const now = nowFn(), monoNow = monoNowFn();
      const draft = cloneRoomState(room);
      const viewer = draft.viewers.get(viewerId);
      if (!viewer || viewer.userId !== actor.userId || draft.mediaVersion !== mediaVersion ||
          typeof ready !== 'boolean' || draft.readinessVersion !== readinessVersion) {
        throw new Error('Invalid readiness');
      }
      viewer.authVerifiedAt = now;
      recordViewerReadiness(draft, { userId: actor.userId, viewerId, mediaVersion, ready, readinessVersion }, { now, monoNow });
      const autoStarted = applyAutoStartOnDraft(draft, now, monoNow);
      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, {
          operation: 'reportReadiness',
          reason: autoStarted ? 'ready-autostart' : 'viewer-ready'
        });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'viewer-ready' });
      return { ok: true };
    });
  }

  async function executeCommand(roomId, actor, envelopeInput, { tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    const room = resolvedTenant ? getRoom(roomId, resolvedTenant) : undefined;
    if (!room) {
      return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
    }
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room ||
          !await checkAuthorized(room, actor, 'command', envelopeInput?.command, envelopeInput?.viewerId)) {
        return { status: 'forbidden', httpStatus: 403, message: 'No controllable room.' };
      }
      if (room.persistenceUncertain) {
        return { status: 'unavailable', httpStatus: 503, reason: 'persistence-uncertain', message: 'Room state requires persistence reconciliation.' };
      }
      const now = nowFn(), monoNow = monoNowFn();
      const checkedEnvelope = validateCommandEnvelope(envelopeInput, {
        expectedEpoch: room.epoch,
        currentRevision: room.revision,
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
        if (!viewer || viewer.userId !== actor.userId || viewer.revoked || now - viewer.at > PRESENCE_TIMEOUT_MS) {
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

      const draft = cloneRoomState(room);
      if (checkedEnvelope.coordination.viewerId !== undefined) {
        const draftSenderViewer = draft.viewers.get(checkedEnvelope.coordination.viewerId);
        if (draftSenderViewer) draftSenderViewer.authVerifiedAt = now;
      }

      if (['media.play', 'media.toggle', 'media.ready.start'].includes(command.action) &&
          Policy.role(draft, actor.userId) === 'viewer' && !isAdmin &&
          ![...draft.viewers.values()].some(v => (now - v.at <= PRESENCE_TIMEOUT_MS) && (Policy.role(draft, v.userId) !== 'viewer' || checkAdmin(v.actor, draft)))) {
        if (!Policy.allowed(draft, actor.userId, 'continueWithoutHost', { isAdmin })) {
          return { status: 'forbidden', httpStatus: 403, message: 'Your room permissions do not allow this action.' };
        }
      }

      if (command.action === 'room.kick') {
        const targetUserId = command.args.userId;
        if (!Policy.canKickParticipant(draft, actor.userId, targetUserId, { isAdmin })) {
          return { status: 'forbidden', httpStatus: 403, message: 'You cannot kick this participant.' };
        }
        const targetViewers = [...draft.viewers.entries()].filter(([, v]) => v.userId === targetUserId);
        if (!targetViewers.length) return { status: 'unavailable', httpStatus: 409, message: 'This participant has already left.' };
        for (const [id] of targetViewers) draft.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
        for (const [id, v] of draft.disconnectedViewers) {
          if (v.userId === targetUserId) {
            draft.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
            draft.disconnectedViewers.delete(id);
          }
        }
        let autoStarted = false;
        for (const [id] of targetViewers) {
          const outcome = removeViewerFromDraft(draft, id, { reason: 'kicked', now, monoNow, preserveGrace: false });
          if (outcome.autoStarted) autoStarted = true;
        }
        advanceRevision(room, draft);
        if (durableStateChanged(room, draft)) {
          await persistRoomTransition(room, draft, { operation: 'executeCommand', reason: 'room.kick' });
        }
        commitRoomDraft(room, draft);
        if (autoStarted) {
          queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
        }
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'viewer-left' });
        return { status: 'applied', revision: room.revision, message: 'Participant removed. They may rejoin.' };
      }

      if (command.action === 'room.visibility') {
        draft.visibility = command.args.visibility;
        draft.disconnectedViewers.clear();
        invalidateEpoch(draft, { createId });
        const { autoStarted: prunedAutoStart } = settleAndPruneDraft(draft, now, monoNow);
        const gateAutoStart = !prunedAutoStart && draft.initialGate && !draft.manualPaused
          ? applyAutoStartOnDraft(draft, now, monoNow)
          : false;
        advanceRevision(room, draft);
        await persistRoomTransition(room, draft, { operation: 'executeCommand', reason: 'visibility-changed' });
        commitRoomDraft(room, draft);
        if (prunedAutoStart || gateAutoStart) {
          queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
        }
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'visibility-changed' });
        return { status: 'applied', epoch: room.epoch, revision: room.revision, message: 'Viewing room updated.' };
      }

      settleAndPruneDraft(draft, now, monoNow);

      if (command.action.startsWith('media.ready.')) {
        const outcome = applyReadinessDecision(draft, command.action, command.args.readinessId, { now, monoNow, createId });
        if (outcome.status !== 'applied') {
          return { status: outcome.status, httpStatus: 409, message: outcome.message };
        }
        const autoStarted = outcome.checkAutoStart ? applyAutoStartOnDraft(draft, now, monoNow) : false;
        advanceRevision(room, draft);
        await persistRoomTransition(room, draft, { operation: 'executeCommand', reason: command.action });
        commitRoomDraft(room, draft);
        if (autoStarted) {
          queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
        }
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: command.action });
        return { status: 'applied', revision: room.revision, message: outcome.message };
      }

      if (draft.readinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(command.action)) {
        return { status: 'unavailable', httpStatus: 409, message: 'The host must choose whether to start, wait or cancel.' };
      }
      if (!draft.viewers.size) return { status: 'unavailable', httpStatus: 409, message: 'No viewer is connected.' };
      if (command.action.startsWith('media.') && !draft.hasMedia) {
        return { status: 'unavailable', httpStatus: 409, message: 'Choose a video first.' };
      }
      if (!TIMELINE_ACTIONS.has(command.action)) {
        return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
      }

      const applied = applyTimelineCommand(draft, command, { now, monoNow, createId });
      if (!applied) {
        return { status: 'unsupported', httpStatus: 400, message: 'Unsupported command or value.' };
      }
      draft.revision++;
      draft.lastActivity = now;
      const autoStarted = ['media.play', 'media.toggle'].includes(command.action) && draft.initialGate && !draft.manualPaused
        ? applyAutoStartOnDraft(draft, now, monoNow)
        : false;
      advanceRevision(room, draft);
      await persistRoomTransition(room, draft, { operation: 'executeCommand', reason: command.action });
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: command.action });
      return { status: 'applied', revision: room.revision, message: 'Viewing room updated.' };
    });
  }

  async function recordSyncQuality(roomId, actor, message, { tenantId } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant) return { ok: false, code: 4003 };
    if (message?.tenantId !== undefined && message.tenantId !== resolvedTenant) return { ok: false, code: 4003 };
    const room = getRoom(roomId, resolvedTenant);
    if (!room || message?.roomId !== roomId) return { ok: false, code: 4003 };
    if (!validateSyncQualityMessage(message, { idPattern: options.idPattern })) return { ok: false, code: 4002 };

    const initialViewer = room.viewers.get(message.viewerId);
    if (!initialViewer || initialViewer.userId !== actor.userId || initialViewer.revoked) {
      return { ok: false, code: 4003 };
    }
    const nowCheck = nowFn();
    if ((room.kickedViewers.get(message.viewerId) || 0) > nowCheck ||
        checkFastRevoked(room, actor, message.viewerId) ||
        (room.visibility === 'private' && !checkAdmin(actor, room) && !Policy.assigned(room, actor.userId))) {
      await evictRevokedViewer(room, message.viewerId, 'revoked');
      return { ok: false, code: 4003 };
    }
    if (room.mediaVersion !== message.mediaVersion || initialViewer.streamVersion !== message.streamVersion) {
      return { ok: true, ignored: true };
    }
    // Check per-viewer telemetry rate limit BEFORE async `authorize` to prevent DB amplification.
    const statusChanged = initialViewer.lastSyncQualityStatus !== message.status;
    const confidenceChanged = initialViewer.lastSyncQualityConfidence !== message.confidence;
    const minimumInterval = statusChanged || confidenceChanged ? 500 : 4000;
    if (initialViewer.lastSyncQualityAt !== undefined && nowCheck - initialViewer.lastSyncQualityAt < minimumInterval) {
      return { ok: true, displayChanged: false };
    }

    if (!await checkAuthorized(room, actor, 'telemetry', undefined, message.viewerId)) {
      await evictRevokedViewer(room, message.viewerId, 'revoked');
      return { ok: false, code: 4003 };
    }

    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, resolvedTenant) !== room) return { ok: false, code: 4003 };
      const viewer = room.viewers.get(message.viewerId);
      if (!viewer || viewer.userId !== actor.userId || viewer.revoked || checkFastRevoked(room, actor, message.viewerId)) {
        return { ok: false, code: 4003 };
      }
      if (room.visibility === 'private' && !checkAdmin(actor, room) && !Policy.assigned(room, actor.userId)) {
        return { ok: false, code: 4003 };
      }
      if (room.mediaVersion !== message.mediaVersion || viewer.streamVersion !== message.streamVersion) {
        return { ok: true, ignored: true };
      }
      const now = nowFn();
      viewer.authVerifiedAt = now;
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
        if (outcome.displayChanged) {
          queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'sync-quality' });
        }
      }
      return { ok: true, displayChanged: outcome.displayChanged };
    });
  }

  /**
   * Retrieve an authorized, tenant-isolated, read-only room snapshot for `actor`.
   * Reads committed room state only; never mutates authoritative timeline, revision,
   * readiness, or membership state, and never exposes uncommitted transitions.
   */
  async function snapshot(roomId, actor, { viewerId, tenantId, envelopeOnly = false } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    const room = resolvedTenant ? getRoom(roomId, resolvedTenant) : undefined;
    if (!room || !await checkAuthorized(room, actor, 'snapshot', undefined, viewerId)) {
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
      if (existingViewer && (existingViewer.revoked || checkFastRevoked(room, actor, viewerId))) {
        throw Object.assign(new Error('Room unavailable or private'), { status: 403 });
      }
      const savedViewer = !existingViewer && room.disconnectedViewers.get(viewerId);
      if (savedViewer && savedViewer.userId !== actor.userId) {
        throw Object.assign(new Error('Viewer identity mismatch'), { status: 403 });
      }
    }
    const projected = projectRoomReadOnly(room, receivedAt, receivedMono);
    const viewer = viewerId ? projected.activeViewers.get(viewerId) : undefined;
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
   * Privileged server-internal room inspection for trusted diagnostics or monitoring.
   * Purely read-only over committed room state; never exposes uncommitted transitions
   * and never mutates `transportSequence` or presence state.
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
    for (const room of [...rooms.values()]) {
      if (room.tenantId !== resolvedTenant) continue;
      if (!await checkAuthorized(room, actor, 'list')) continue;
      if (getRoom(room.id, resolvedTenant) !== room) continue;
      const projected = projectRoomReadOnly(room, now, monoNow);
      const members = [...new Map([...projected.activeViewers.values()].map(v => [v.userId, v.name])).values()];
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
    return runRoomTransaction(room, async queuePublish => {
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
        if (expectedRevision !== room.revision) {
          return { status: 'unavailable', httpStatus: 409, reason: 'revision-mismatch', message: 'Room revision changed; refresh before closing' };
        }
      }
      if (epoch !== undefined && epoch !== room.epoch) {
        return { status: 'unavailable', httpStatus: 409, reason: 'epoch-mismatch', message: 'Room changed; refresh before closing' };
      }

      const closedAt = nowFn();
      const isolatedRoom = cloneRoomState(room);
      try {
        if (options.onDeleteRoom) {
          await options.onDeleteRoom({
            tenantId: room.tenantId,
            roomId: room.id,
            epoch: room.epoch,
            revision: room.revision,
            closedAt,
            room: isolatedRoom
          });
        } else if (options.onPersist) {
          await options.onPersist(
            { ...isolatedRoom, closed: true, closedAt },
            { operation: 'close', reason: 'room-closed', previousRevision: room.revision }
          );
        }
      } catch (err) {
        if (err && typeof err === 'object' && (err.ambiguous === true || err.persistenceUncertain === true)) {
          room.persistenceUncertain = true;
        }
        throw err;
      }

      rooms.delete(roomKey(resolvedTenant, roomId));
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'room-closed' });
      return { status: 'applied', ok: true };
    });
  }

  /**
   * Client-facing presence heartbeat & RTT sample recorder.
   * Enforces tenant isolation, viewer ownership, fast synchronous revocation, and bounded
   * periodic `options.authorize` revalidation (`presenceAuthIntervalMs`) without hitting
   * external storage on every rapid clock/pong frame.
   */
  async function touchViewer(roomId, actor, { viewerId, tenantId, rttMs } = {}) {
    const resolvedTenant = resolveActorTenant(actor, tenantId);
    if (!resolvedTenant || typeof viewerId !== 'string' || !viewerId) return false;
    const room = getRoom(roomId, resolvedTenant);
    const viewer = room?.viewers.get(viewerId);
    if (!room || !viewer || viewer.userId !== actor.userId || viewer.revoked) return false;
    const now = nowFn();
    if ((room.kickedViewers.get(viewerId) || 0) > now) return false;

    if (checkFastRevoked(room, actor, viewerId) ||
        (room.visibility === 'private' && !checkAdmin(actor, room) && !Policy.assigned(room, actor.userId))) {
      viewer.revoked = true;
      await evictRevokedViewer(room, viewerId, 'revoked');
      return false;
    }

    const needsAuthRecheck = Boolean(
      options.authorize &&
      (viewer.authVerifiedAt === undefined || now - viewer.authVerifiedAt >= presenceAuthIntervalMs)
    );
    if (needsAuthRecheck) {
      const stillAllowed = await checkAuthorized(room, actor, 'presence', undefined, viewerId);
      if (!stillAllowed) {
        viewer.revoked = true;
        await evictRevokedViewer(room, viewerId, 'revoked');
        return false;
      }
      const latestViewer = getRoom(roomId, resolvedTenant)?.viewers.get(viewerId);
      if (!latestViewer || latestViewer.userId !== actor.userId || latestViewer.revoked) return false;
      const refreshedNow = nowFn(), refreshedMono = monoNowFn();
      latestViewer.authVerifiedAt = refreshedNow;
      latestViewer.at = refreshedNow;
      latestViewer.touchSequence = (latestViewer.touchSequence || 0) + 1;
      if (Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 10000) {
        latestViewer.rtts = [...(latestViewer.rtts || []), { at: refreshedMono, ms: rttMs }]
          .filter(sample => refreshedMono - sample.at <= 30000)
          .slice(-16);
      }
      return true;
    }

    const monoNow = monoNowFn();
    viewer.at = now;
    viewer.touchSequence = (viewer.touchSequence || 0) + 1;
    if (Number.isFinite(rttMs) && rttMs >= 0 && rttMs <= 10000) {
      viewer.rtts = [...(viewer.rtts || []), { at: monoNow, ms: rttMs }]
        .filter(sample => monoNow - sample.at <= 30000)
        .slice(-16);
    }
    return true;
  }

  /**
   * Privileged server-internal immediate revocation helper.
   * Evicts matching viewer session(s) under per-room serialization so revoked users
   * lose presence, readiness membership, and snapshot access immediately.
   */
  async function revokeActor({ userId, tenantId = 'default', roomId, viewerId } = {}) {
    const normalizedTenant = normalizeTenantId(tenantId);
    if (!normalizedTenant || typeof userId !== 'string' || !userId) return 0;
    const candidateRooms = roomId !== undefined
      ? [getRoom(roomId, normalizedTenant)].filter(Boolean)
      : [...rooms.values()].filter(r => r.tenantId === normalizedTenant);
    let evictedCount = 0;
    await Promise.all(candidateRooms.map(room => runRoomTransaction(room, async queuePublish => {
      if (getRoom(room.id, normalizedTenant) !== room) return;
      const now = nowFn(), monoNow = monoNowFn();
      const draft = cloneRoomState(room);
      let roomChanged = false, autoStarted = false, removedLive = false;
      for (const [id, v] of [...draft.viewers.entries()]) {
        if (v.userId === userId && (viewerId === undefined || id === viewerId)) {
          const live = room.viewers.get(id);
          if (live) live.revoked = true;
          const res = removeViewerFromDraft(draft, id, { reason: 'revoked', now, monoNow, preserveGrace: false });
          if (res.removed) {
            removedLive = true;
            roomChanged = true;
            evictedCount++;
          }
          if (res.autoStarted) autoStarted = true;
        }
      }
      for (const [id, saved] of [...draft.disconnectedViewers.entries()]) {
        if (saved.userId === userId && (viewerId === undefined || id === viewerId)) {
          draft.disconnectedViewers.delete(id);
          roomChanged = true;
        }
      }
      if (!roomChanged) return;
      if (removedLive) advanceRevision(room, draft);
      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, { operation: 'revokeActor', reason: 'viewer-left' });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      if (removedLive) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'viewer-left' });
      }
    })));
    return evictedCount;
  }

  /**
   * Privileged server-internal startup restoration & ambiguous-persistence reconciliation helpers.
   */
  function restoreRoomInternal(persisted) {
    if (!persisted || typeof persisted !== 'object') throw new Error('Invalid persisted room');
    const normalizedTenant = normalizeTenantId(persisted.tenantId);
    if (!normalizedTenant) throw new Error('Invalid persisted tenantId');
    if (typeof persisted.id !== 'string' || !persisted.id) throw new Error('Invalid persisted roomId');
    if (typeof persisted.creatorId !== 'string' || !persisted.creatorId) throw new Error('Invalid persisted creatorId');
    const key = roomKey(normalizedTenant, persisted.id);
    if (rooms.has(key)) throw new Error('Room already exists');
    const now = nowFn();
    const baseRevision = Number.isSafeInteger(persisted.revision) && persisted.revision >= 0 ? persisted.revision : 0;
    const restored = {
      id: persisted.id,
      tenantId: normalizedTenant,
      name: persisted.name || '',
      creatorId: persisted.creatorId,
      hosts: [...new Set(persisted.hosts || [])],
      hostId: persisted.hostId || persisted.creatorId,
      hostName: senderName(persisted.hostName, 'Host'),
      visibility: persisted.visibility === 'private' ? 'private' : 'public',
      permissions: Policy.policy(persisted.permissions),
      controls: { ...CONTROLS },
      epoch: createId(),
      revision: baseRevision + 1,
      mediaVersion: persisted.mediaVersion || createId(),
      readinessVersion: undefined,
      hasMedia: Boolean(persisted.hasMedia),
      paused: true,
      position: Number.isFinite(persisted.position) ? Math.max(0, persisted.position) : 0,
      duration: Number.isFinite(persisted.duration) ? Math.max(0, persisted.duration) : 0,
      seekable: Boolean(persisted.hasMedia && persisted.duration > 0),
      changedAt: now,
      startAt: undefined,
      pauseAt: undefined,
      initialGate: false,
      manualPaused: Boolean(persisted.hasMedia),
      initialViewers: new Set(),
      hadViewers: false,
      viewers: new Map(),
      disconnectedViewers: new Map(),
      kickedViewers: new Map(),
      transportSequence: 0,
      lastActivity: now,
      persistenceUncertain: false,
      reservedRevision: baseRevision + 1,
      content: cloneValue(persisted.content || {})
    };
    rooms.set(key, restored);
    return restored;
  }

  async function reconcileRoomInternal(roomId, authoritative, { tenantId = 'default' } = {}) {
    const normalizedTenant = normalizeTenantId(tenantId);
    const room = normalizedTenant ? getRoom(roomId, normalizedTenant) : undefined;
    if (!room) return undefined;
    return runRoomTransaction(room, async queuePublish => {
      if (getRoom(roomId, normalizedTenant) !== room) return undefined;
      if (authoritative?.closed) {
        rooms.delete(roomKey(normalizedTenant, roomId));
        queuePublish({ tenantId: normalizedTenant, roomId, includeLobby: true, reason: 'room-closed' });
        return null;
      }
      const now = nowFn();
      const floor = Math.max(room.revision, room.reservedRevision || 0, authoritative?.revision || 0);
      if (authoritative && typeof authoritative === 'object') {
        if (authoritative.visibility && ['public', 'private'].includes(authoritative.visibility)) {
          room.visibility = authoritative.visibility;
        }
        if (typeof authoritative.epoch === 'string' && authoritative.epoch) room.epoch = authoritative.epoch;
        if (typeof authoritative.mediaVersion === 'string' && authoritative.mediaVersion) room.mediaVersion = authoritative.mediaVersion;
        if (typeof authoritative.hasMedia === 'boolean') room.hasMedia = authoritative.hasMedia;
        if (typeof authoritative.paused === 'boolean') room.paused = authoritative.paused;
        if (Number.isFinite(authoritative.position)) room.position = authoritative.position;
        if (Number.isFinite(authoritative.duration)) room.duration = authoritative.duration;
        if (typeof authoritative.seekable === 'boolean') room.seekable = authoritative.seekable;
        if ('startAt' in authoritative) room.startAt = authoritative.startAt;
        if ('pauseAt' in authoritative) room.pauseAt = authoritative.pauseAt;
        if (typeof authoritative.initialGate === 'boolean') room.initialGate = authoritative.initialGate;
        if (typeof authoritative.manualPaused === 'boolean') room.manualPaused = authoritative.manualPaused;
        if (typeof authoritative.readinessTimedOut === 'boolean') room.readinessTimedOut = authoritative.readinessTimedOut;
        if ('readinessVersion' in authoritative) room.readinessVersion = authoritative.readinessVersion;
        if (authoritative.content !== undefined) room.content = cloneValue(authoritative.content);
        room.changedAt = Number.isFinite(authoritative.changedAt) ? authoritative.changedAt : now;
      }
      room.revision = floor + 1;
      room.reservedRevision = room.revision;
      room.persistenceUncertain = false;
      queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: true, reason: 'room-reconciled' });
      return room;
    });
  }

  function roomNeedsSweep(room, now, monoNow) {
    const singleViewer = room.viewers.size === 1;
    if (singleViewer && (room.startAt > now || room.pauseAt > now)) return true;
    if (room.pauseAt && now >= room.pauseAt) return true;
    if (!room.recovery && room.initialGate && !room.manualPaused && !room.readinessTimedOut && monoNow >= room.readinessDeadline) {
      return true;
    }
    if (room.hasMedia && room.duration > 0 && !room.paused && position(room, now) >= room.duration) return true;
    for (const expiry of room.kickedViewers.values()) {
      if (expiry <= now) return true;
    }
    for (const saved of room.disconnectedViewers.values()) {
      if (saved.expires <= now || saved.mediaVersion !== room.mediaVersion ||
          (room.visibility === 'private' && !Policy.assigned(room, saved.userId))) {
        return true;
      }
    }
    for (const [id, viewer] of room.viewers) {
      if (viewer.revoked || now - viewer.at > PRESENCE_TIMEOUT_MS || checkFastRevoked(room, viewer.actor, id)) return true;
      if (room.visibility === 'private' && !Policy.assigned(room, viewer.userId) && !checkAdmin(viewer.actor, room)) return true;
      if (options.authorize && (viewer.authVerifiedAt === undefined || now - viewer.authVerifiedAt >= presenceAuthIntervalMs)) {
        return true;
      }
    }
    return false;
  }

  async function sweepRoom(room, now, monoNow) {
    if (!roomNeedsSweep(room, now, monoNow)) return;
    await runRoomTransaction(room, async queuePublish => {
      if (getRoom(room.id, room.tenantId) !== room || room.persistenceUncertain) return;
      const currentNow = options.now ? now : Math.max(now, nowFn());
      const currentMono = options.monoNow ? monoNow : Math.max(monoNow, monoNowFn());

      const revokedIds = new Set();
      const revalidatedIds = new Set();
      for (const [id, viewer] of room.viewers) {
        if (viewer.revoked || checkFastRevoked(room, viewer.actor, id)) {
          revokedIds.add(id);
          continue;
        }
        const alreadyExpiring = currentNow - viewer.at > PRESENCE_TIMEOUT_MS ||
          (room.visibility === 'private' && !Policy.assigned(room, viewer.userId) && !checkAdmin(viewer.actor, room));
        if (!alreadyExpiring && options.authorize &&
            (viewer.authVerifiedAt === undefined || currentNow - viewer.authVerifiedAt >= presenceAuthIntervalMs)) {
          const allowed = await checkAuthorized(room, viewer.actor, 'sweep', undefined, id);
          if (!allowed) revokedIds.add(id);
          else revalidatedIds.add(id);
        }
      }

      const draft = cloneRoomState(room);
      for (const id of revalidatedIds) {
        const dv = draft.viewers.get(id);
        if (dv) dv.authVerifiedAt = currentNow;
      }
      const prevRevision = draft.revision;
      const prevKickedSize = draft.kickedViewers.size;
      const prevDiscSize = draft.disconnectedViewers.size;
      const { pruned, autoStarted } = settleAndPruneDraft(draft, currentNow, currentMono, revokedIds);
      const changed = pruned || autoStarted ||
        draft.revision !== prevRevision ||
        draft.kickedViewers.size !== prevKickedSize ||
        draft.disconnectedViewers.size !== prevDiscSize ||
        durableStateChanged(room, draft);

      if (!changed) {
        for (const id of revalidatedIds) {
          const lv = room.viewers.get(id);
          if (lv) lv.authVerifiedAt = currentNow;
        }
        return;
      }
      if (draft.revision > room.revision) advanceRevision(room, draft);
      if (durableStateChanged(room, draft)) {
        await persistRoomTransition(room, draft, { operation: 'sweep', reason: autoStarted ? 'ready-autostart' : 'room-swept' });
      }
      commitRoomDraft(room, draft);
      if (autoStarted) {
        queuePublish({ tenantId: room.tenantId, roomId: room.id, includeLobby: false, reason: 'ready-autostart' });
      }
      queuePublish({
        tenantId: room.tenantId,
        roomId: room.id,
        includeLobby: pruned,
        reason: pruned ? 'viewer-pruned' : 'timeline-settled'
      });
    });
  }

  /**
   * Serialized maintenance sweep across active rooms. Each room settles independently
   * under its own room lock without locking unrelated rooms together.
   */
  async function sweep(now = nowFn(), monoNow = monoNowFn()) {
    await Promise.all([...rooms.values()].map(room => sweepRoom(room, now, monoNow)));
  }

  return {
    clockEpoch,
    rooms,
    createRoom,
    getRoom,
    inspectRoomInternal,
    restoreRoomInternal,
    reconcileRoomInternal,
    revokeActor,
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
