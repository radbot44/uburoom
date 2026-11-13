// @ts-check
/* The room core: the authoritative room timeline, readiness, presence and room
 * lifecycle, as a pure reducer over plain room state plus a per-room mailbox
 * (createRoomCoordinator). Requires no HTTP server, WebSocket, Plex, Discord or SQLite.
 *
 * One room-state shape is used everywhere (the self-hosted server's): `roomId`,
 * `state.paused`, `media.duration`, `viewers` keyed by viewer id, and so on.
 */
import { senderName, validateSyncCommand } from './protocol.mjs';
import * as Policy from './policy.mjs';
import { PRESENCE_TIMEOUT_MS, RECONNECT_GRACE_MS, COMMAND_TTL_MS } from './envelope.mjs';

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

const getPaused = room => !!room.state.paused;
const setPaused = (room, paused) => {
  room.state.paused = paused;
};
const getDuration = room => room.media?.duration || 0;
const setEpoch = (room, epoch) => {
  room.epoch = epoch;
};

export function position(room, now = Date.now()) {
  if (room.pauseAt) now = Math.min(now, room.pauseAt);
  const elapsed = room.startAt ? Math.max(0, now - Math.max(room.changedAt, room.startAt)) : now - room.changedAt;
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
    if (samples.length) lead = Math.max(lead, samples[Math.ceil(samples.length * 0.95) - 1] + 100);
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
    if (room.startAt > now) {
      room.startAt = now;
      room.changedAt = now;
      room.revision++;
    }
    if (room.pauseAt > now) room.pauseAt = now;
  }
  if (room.pauseAt && now >= room.pauseAt) {
    room.position = position(room, room.pauseAt);
    room.changedAt = room.pauseAt;
    room.pauseAt = undefined;
    setPaused(room, true);
    room.revision++;
  }
  if (
    !room.recovery &&
    room.initialGate &&
    !room.manualPaused &&
    !room.readinessTimedOut &&
    monoNow >= room.readinessDeadline
  ) {
    room.readinessTimedOut = true;
    room.readinessStartAt = undefined;
    room.revision++;
  }
}

/**
 * @param {any} room
 * @param {{createId?: () => string}} [options]
 */
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
  if (
    !viewer ||
    viewer.userId !== userId ||
    room.mediaVersion !== mediaVersion ||
    typeof ready !== 'boolean' ||
    room.readinessVersion !== readinessVersion
  ) {
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
  const blockers =
    monoNow - room.readinessSince >= READINESS_BLOCKER_REVEAL_MS
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
      canStart,
    },
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
  'media.seek.end',
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
      if (room.position >= duration - 0.1) room.position = 0;
      if (room.manualPaused && room.initialGate) beginReadiness(room, now, READINESS_WAIT_MS, { monoNow, createId });
      room.manualPaused = false;
      setPaused(room, room.initialGate);
      if (options.autoplayVersion === room.mediaVersion && !room.initialGate) {
        room.startAt = Math.max(
          room.viewers.size > 1 ? room.readinessStartAt || 0 : 0,
          now + controlLead(room, monoNow),
        );
      } else if (!room.initialGate && !wasPlaying) {
        room.startAt = now + controlLead(room, monoNow);
      }
      break;
    case 'media.toggle':
      if (room.position >= duration - 0.1) {
        room.position = 0;
        setPaused(room, true);
      }
      room.manualPaused = !pausePending && (!getPaused(room) || (room.initialGate && !room.manualPaused));
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
      room.position = Math.max(0, Math.min(duration - 0.05, room.position + args.seconds));
      break;
    case 'media.seek.absolute':
      room.position = Math.max(0, Math.min(duration - 0.05, args.seconds));
      break;
    case 'media.seek.start':
      room.position = 0;
      break;
    case 'media.seek.end':
      room.position = Math.max(0, duration - 0.05);
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

// ---------------------------------------------------------------------------
// Plain room state
// ---------------------------------------------------------------------------

/**
 * The room fields the core reads and writes. Everything else on a live room is a
 * resource its host owns (streams, sockets, timers, provider sessions), which the
 * reducer never sees. `media` and the role lists are referenced, never changed.
 */
export const ROOM_STATE_KEYS = Object.freeze([
  'roomId',
  'tenantId',
  'epoch',
  'revision',
  'visibility',
  'creatorId',
  'hosts',
  'invited',
  'guests',
  'permissions',
  'hostId',
  'hostName',
  'hostViewerId',
  'waitingForHost',
  'media',
  'mediaVersion',
  'readinessVersion',
  'readinessId',
  'readinessSince',
  'readinessDeadline',
  'readinessTimedOut',
  'readinessStartAt',
  'position',
  'changedAt',
  'startAt',
  'pauseAt',
  'state',
  'initialGate',
  'manualPaused',
  'initialViewers',
  'viewers',
  'disconnectedViewers',
  'kickedViewers',
  'hadViewers',
  'lastActivity',
  'frozen',
  'closed',
  'recovery',
  'disconnectedWasPlaying',
  'checkpointAt',
]);
/** The viewer fields the core reads and writes; the rest of a live viewer is its host's. */
export const VIEWER_STATE_KEYS = Object.freeze([
  'viewerId',
  'userId',
  'name',
  'actor',
  'at',
  'joinedAt',
  'ready',
  'version',
  'readinessBypassedVersion',
  'observationEpoch',
  'streamVersion',
  'syncQuality',
  'rtts',
]);

const DEFAULT_KEYS = Object.freeze({ room: ROOM_STATE_KEYS, viewer: VIEWER_STATE_KEYS });
// A cloned viewer remembers the live viewer it came from, so a commit updates that
// viewer in place and a viewer created by the reducer becomes a new live viewer.
const ORIGIN = new WeakMap();

function pick(source, keys) {
  const out = {};
  for (const key of keys) if (key in source) out[key] = source[key];
  return out;
}

/** A fresh room in the core's shape, for standalone hosts. */
export function createRoomState({
  roomId,
  tenantId = undefined,
  creatorId,
  creatorName = 'Host',
  visibility = 'public',
  hosts = [],
  invited = [],
  permissions = undefined,
  now = Date.now(),
  createId = defaultCreateId,
  media = null,
}) {
  if (typeof roomId !== 'string' || !roomId) throw new Error('roomId is required');
  if (typeof creatorId !== 'string' || !creatorId) throw new Error('creatorId is required');
  if (!['public', 'private'].includes(visibility)) throw new Error('Invalid room visibility');
  return {
    roomId,
    tenantId,
    epoch: createId(),
    revision: 0,
    visibility,
    creatorId,
    hosts: [...new Set(hosts)],
    invited: [...new Set(invited)],
    permissions: Policy.policy(permissions),
    hostId: creatorId,
    hostName: senderName(creatorName, 'Host'),
    media,
    mediaVersion: createId(),
    position: 0,
    changedAt: now,
    state: { paused: true, seekable: !!media },
    initialGate: false,
    manualPaused: false,
    initialViewers: new Set(),
    viewers: new Map(),
    disconnectedViewers: new Map(),
    kickedViewers: new Map(),
    hadViewers: false,
    lastActivity: now,
  };
}

/**
 * Copies a room's plain state. Collections are copied and viewers are copied field
 * by field; `media` and role records stay shared and are replaced, never changed.
 */
export function cloneRoomState(room, keys = DEFAULT_KEYS) {
  const draft = pick(room, keys.room);
  draft.state = { ...room.state };
  draft.viewers = new Map();
  for (const [id, viewer] of room.viewers) {
    const copy = pick(viewer, keys.viewer);
    ORIGIN.set(copy, viewer);
    draft.viewers.set(id, copy);
  }
  draft.disconnectedViewers = new Map(room.disconnectedViewers || []);
  draft.kickedViewers = new Map(room.kickedViewers || []);
  draft.initialViewers = new Set(room.initialViewers || []);
  return draft;
}

/**
 * Writes a reduced draft back onto its live room. The live viewer map keeps its
 * identity and viewers still present keep their live objects (with the resources
 * on them). Returns the live viewers that left, for the effects that release them.
 */
export function commitRoomState(room, draft, keys = DEFAULT_KEYS) {
  for (const key of keys.room) if (key !== 'viewers' && key in draft) room[key] = draft[key];
  const next = [];
  for (const [id, viewer] of draft.viewers) {
    const live = ORIGIN.get(viewer);
    if (live) {
      for (const key of keys.viewer) if (key in viewer) live[key] = viewer[key];
      next.push([id, live]);
    } else next.push([id, viewer]);
  }
  const kept = new Set(next.map(([, viewer]) => viewer));
  const nextIds = new Set(next.map(([id]) => id));
  const removed = new Map();
  for (const [id, viewer] of room.viewers) if (!kept.has(viewer)) removed.set(id, viewer);
  // Update the live map in place. Clearing and refilling it would make anyone
  // iterating room.viewers across an event revisit every entry, without end.
  for (const id of [...room.viewers.keys()]) if (!nextIds.has(id)) room.viewers.delete(id);
  for (const [id, viewer] of next) if (room.viewers.get(id) !== viewer) room.viewers.set(id, viewer);
  return removed;
}

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

const ALLOW = Object.freeze({ ok: true });
const NO_ROOM = Object.freeze({ ok: false, reason: 'room' });
const NO_PERMISSION = Object.freeze({ ok: false, reason: 'permission' });

/**
 * The standalone authorization policy: room roles and capabilities only. A host
 * service passes its own `authorize`; the self-hosted server passes Hub.authorize.
 * @param {{userId: string}} actor @param {any} room @param {string} action
 * @returns {{ok: boolean, reason?: string}}
 */
export function policyAuthorize(actor, room, action) {
  if (!actor?.userId) return NO_ROOM;
  const view = room.visibility === 'public' || Policy.admitted(room, actor.userId);
  if (action === 'room.view' || action === 'room.remain') return view ? ALLOW : NO_ROOM;
  if (!view) return NO_ROOM;
  if (action === 'room.host') return Policy.role(room, actor.userId) !== 'viewer' ? ALLOW : NO_PERMISSION;
  const capability = [...Policy.CAPABILITIES, ...Policy.CREATOR_ONLY].includes(action)
    ? action
    : Policy.commandCapability(action);
  return capability && Policy.allowed(room, actor.userId, capability) ? ALLOW : NO_PERMISSION;
}

function failure(message, status = undefined) {
  const error = new Error(message);
  if (status !== undefined) Object.assign(error, { status });
  return error;
}

const allowed = (ctx, actor, room, action) => !!actor && ctx.authorize(actor, room, action)?.ok === true;
const startPending = room => !!room.initialGate && !room.manualPaused && !room.readinessTimedOut;

// Fields older readers take from room.state between events.
function derive(room, now) {
  room.state.waitingForReady = room.initialGate && !room.manualPaused && !room.readinessTimedOut;
  room.state.position = position(room, now);
  room.state.duration = room.media?.duration || 0;
}

function close(room, ctx, save = true) {
  if (room.closed) return;
  room.closed = true;
  ctx.emit('remove', { save });
}

function invalidateControls(room, ctx) {
  ctx.emit('cancel-autoplay');
  invalidateEpoch(room, { createId: ctx.createId });
}

// Stops the room where it is. An election keeps a start everyone is still getting
// ready for: someone allowed to already asked for it to play.
function freeze(room, ctx, at = ctx.now, { keepStart = false } = {}) {
  ctx.emit('cancel-autoplay');
  room.position = position(room, Math.max(room.changedAt, at));
  room.changedAt = ctx.now;
  room.pauseAt = room.startAt = undefined;
  room.state.paused = true;
  if (!(keepStart && startPending(room))) room.manualPaused = true;
  room.revision++;
}

function disconnectedRecord(room, viewer, ctx) {
  const now = ctx.now;
  return {
    userId: viewer.userId,
    mediaVersion: room.mediaVersion,
    streamVersion: viewer.streamVersion,
    expires: now + RECONNECT_GRACE_MS,
    readinessBypassedVersion: viewer.readinessBypassedVersion,
    joinedAt: viewer.joinedAt,
    ...ctx.extensions.retain?.(viewer),
    syncQuality: viewer.syncQuality
      ? {
          ...viewer.syncQuality,
          status: 'disconnected',
          confidence: viewer.syncQuality.confidence === 'provisional' ? 'provisional' : 'reduced',
          updatedAt: now,
        }
      : undefined,
  };
}

/**
 * Hands the room to the first present host, or to a participant allowed to continue
 * without one. Freezes first; a playing room resumes through the new host's play.
 */
function elect(room, ctx, exclude = new Set()) {
  if (room.closed) return;
  const now = ctx.now;
  const hostish = viewer => allowed(ctx, viewer.actor, room, 'room.host');
  const continues = viewer => allowed(ctx, viewer.actor, room, 'continueWithoutHost');
  const candidates = [...room.viewers.entries()]
    .filter(([id]) => !exclude.has(id))
    .sort((a, b) => Number(hostish(b[1])) - Number(hostish(a[1])) || a[1].joinedAt - b[1].joinedAt);
  const current = exclude.has(room.hostViewerId) ? undefined : room.viewers.get(room.hostViewerId);
  const hostCandidate = candidates.some(([, viewer]) => hostish(viewer));
  if (current && now - current.at < PRESENCE_TIMEOUT_MS && (hostish(current) || (!hostCandidate && continues(current))))
    return;
  if (room.waitingForHost && !candidates.some(([, viewer]) => hostish(viewer) || continues(viewer))) return;
  const wasPlaying = !room.state.paused;
  freeze(room, ctx, now, { keepStart: true });
  invalidateControls(room, ctx);
  for (const [viewerId, viewer] of candidates) {
    if ((!hostish(viewer) && !continues(viewer)) || now - viewer.at >= PRESENCE_TIMEOUT_MS) continue;
    room.hostId = viewer.userId;
    room.hostName = viewer.name;
    room.hostViewerId = viewerId;
    room.waitingForHost = false;
    ctx.emit('host-elected', { viewerId, replay: wasPlaying && allowed(ctx, viewer.actor, room, 'playPause') });
    ctx.emit('save');
    return;
  }
  room.hostViewerId = undefined;
  room.waitingForHost = room.viewers.size > 0;
  ctx.emit('save');
}

/**
 * S6: once everyone the room waits for is ready, the room starts by itself. No host
 * and no provider is involved: the start completes a play that was already asked for.
 */
function autoStart(room, ctx) {
  if (room.closed || ctx.hold) return false;
  if (room.recovery) {
    if (!ctx.extensions.recoveryReady?.(room, ctx)) return false;
    room.recovery = undefined;
    ctx.emit('recovery-finished');
  }
  if (!areInitialViewersReady(room)) return false;
  settle(room, ctx.now, ctx.monoNow);
  if (!areInitialViewersReady(room)) return false;
  room.initialGate = false;
  ctx.emit('cancel-autoplay');
  ctx.extensions.starting?.(room, ctx);
  applyTimelineCommand(
    room,
    { action: 'media.play', args: {} },
    { now: ctx.now, monoNow: ctx.monoNow, autoplayVersion: room.mediaVersion, createId: ctx.createId },
  );
  room.revision++;
  room.lastActivity = ctx.now;
  settle(room, ctx.now, ctx.monoNow);
  derive(room, ctx.now);
  ctx.emit('started');
  return true;
}

/**
 * The lifecycle review that timers and changes trigger: settles the timeline, expires
 * presence and reconnect grace, freezes or closes an empty room, hands over the host
 * and starts the room once everyone is ready.
 */
function review(room, ctx) {
  if (room.closed || ctx.hold) return { elected: false };
  const { now, monoNow } = ctx;
  settle(room, now, monoNow);
  derive(room, now);
  let pruned = false,
    hostTimedOut = false,
    lastPresence = 0;
  for (const [id, saved] of room.disconnectedViewers)
    if (
      saved.expires <= now ||
      saved.mediaVersion !== room.mediaVersion ||
      !allowed(ctx, { userId: saved.userId }, room, 'room.remain')
    )
      room.disconnectedViewers.delete(id);
  for (const [id, viewer] of room.viewers) {
    const timedOut = now - viewer.at > PRESENCE_TIMEOUT_MS,
      remains = allowed(ctx, viewer.actor, room, 'room.remain');
    if (!timedOut && remains) continue;
    lastPresence = Math.max(lastPresence, viewer.at);
    if (timedOut && remains) {
      // Only personal playback settings survive, for the same tab's short reconnect.
      room.disconnectedViewers.set(id, disconnectedRecord(room, viewer, ctx));
      if (room.disconnectedViewers.size > MAX_DISCONNECTED_VIEWERS)
        room.disconnectedViewers.delete(room.disconnectedViewers.keys().next().value);
    }
    if (viewer.userId === room.hostId && timedOut) hostTimedOut = true;
    ctx.emit('viewer-removed', {
      viewerId: id,
      tracking: room.visibility === 'private' ? 'privacy-revoked' : 'disconnected',
      reporting: 'disconnected',
    });
    room.viewers.delete(id);
    room.initialViewers.delete(id);
    pruned = true;
  }
  if (hostTimedOut) invalidateControls(room, ctx);
  if (pruned) settle(room, now, monoNow);
  if (room.recovery && !room.viewers.size) return { elected: false };
  if (room.hadViewers && !room.viewers.size) {
    ctx.emit('cancel-autoplay');
    ctx.emit('clear-playback-end');
    if (room.disconnectedViewers.size) {
      if (!room.frozen) {
        room.disconnectedWasPlaying = !room.state.paused || (room.initialGate && !room.manualPaused);
        freeze(room, ctx, lastPresence || now);
        ctx.emit('save');
      }
      // An empty room takes no commands. Only its host's own tab may wake it, within the grace.
      room.frozen = true;
      ctx.emit('hide');
      return { elected: false };
    }
    if (!room.frozen) freeze(room, ctx, lastPresence || now);
    close(room, ctx);
    return { elected: false };
  }
  let elected = false;
  if (room.hadViewers && !room.recovery && ![...room.viewers.values()].some(viewer => viewer.userId === room.hostId)) {
    elect(room, ctx);
    elected = true;
  }
  autoStart(room, ctx);
  if (!room.hadViewers && now - room.lastActivity > IDLE_ROOM_TIMEOUT_MS) close(room, ctx);
  return { elected };
}

function join(room, event, ctx) {
  const { viewerId, actor } = event,
    now = ctx.now;
  if (room.closed) return ctx.fail('Room unavailable');
  if ((room.kickedViewers.get(viewerId) || 0) > now)
    return ctx.fail('You were removed from this room. You may rejoin.', 403);
  room.kickedViewers.delete(viewerId);
  review(room, ctx);
  room.lastActivity = now;
  if (room.closed) return ctx.fail('Room unavailable');
  // Existing viewers can keep the room alive between host tabs.
  const full = ctx.extensions.capacity?.(room, actor.userId, ctx);
  if (full) return ctx.fail(full.message, full.status);
  const oldViewer = room.viewers.get(viewerId);
  if (oldViewer && oldViewer.userId !== actor.userId) return ctx.fail('Viewer identity mismatch');
  const saved = !oldViewer && room.disconnectedViewers.get(viewerId);
  if (saved && saved.userId !== actor.userId) return ctx.fail('Viewer identity mismatch');
  // A frozen room wakes only for its returning host (any of the host's tabs), within the grace.
  if (room.frozen && actor.userId !== room.hostId) return ctx.fail('Room unavailable or private', 403);
  if (saved) room.disconnectedViewers.delete(viewerId);
  if (room.frozen) {
    room.frozen = false;
    ctx.emit('reveal');
  }
  const currentHost = room.viewers.get(room.hostViewerId);
  const hostPresent = !!currentHost && allowed(ctx, currentHost.actor, room, 'room.host');
  const controller =
    actor.userId === room.hostId ||
    (allowed(ctx, actor, room, 'room.host') && !hostPresent) ||
    (!room.viewers.has(room.hostViewerId) && allowed(ctx, actor, room, 'continueWithoutHost'));
  if (controller && !oldViewer && room.hostViewerId && room.hostViewerId !== viewerId) {
    room.epoch = ctx.createId();
    room.revision++;
  }
  if (controller && !oldViewer) {
    room.hostViewerId = viewerId;
    room.hostId = actor.userId;
    room.hostName = actor.name;
    room.waitingForHost = false;
  }
  room.hadViewers = true;
  const viewer = oldViewer || {
    observationEpoch: ctx.createId(),
    readinessBypassedVersion: saved?.mediaVersion === room.mediaVersion ? saved?.readinessBypassedVersion : undefined,
    ...ctx.extensions.admit?.(saved || undefined, event, ctx),
    syncQuality: saved?.syncQuality,
    joinedAt: Math.min(
      now,
      saved?.joinedAt ?? now,
      ...[...room.viewers.values()].filter(other => other.userId === actor.userId).map(other => other.joinedAt),
    ),
  };
  Object.assign(viewer, {
    at: now,
    userId: actor.userId,
    viewerId,
    name: ctx.extensions.displayName ? ctx.extensions.displayName(actor) : senderName(actor.name, 'Participant'),
    actor: { ...actor },
    ...(event.rtts ? { rtts: event.rtts.map(sample => ({ ...sample })) } : {}),
  });
  room.viewers.set(viewerId, viewer);
  if (saved) ctx.emit('viewer-reconnected', { viewerId, saved });
  if (!oldViewer) {
    ctx.emit('viewer-joined', { viewerId });
    promoteGroupReadinessLead(room, now);
    if (room.initialGate) room.initialViewers.add(viewerId);
  }
  return viewerId;
}

function leave(room, event, ctx) {
  const { viewerId, actor, reason = 'left' } = event;
  if (room.disconnectedViewers.get(viewerId)?.userId === actor.userId) {
    ctx.emit('reporting-ended', { viewerId, reason });
    room.disconnectedViewers.delete(viewerId);
    if (room.frozen && viewerId === room.hostViewerId) {
      close(room, ctx);
      return;
    }
  }
  const viewer = room.viewers.get(viewerId);
  if (viewer?.userId !== actor.userId) return;
  const hostLeft = actor.userId === room.hostId;
  ctx.emit('viewer-removed', { viewerId, tracking: reason, reporting: reason, left: true });
  room.viewers.delete(viewerId);
  room.initialViewers.delete(viewerId);
  room.revision++;
  if (ctx.extensions.countdownViewer?.(room) === viewerId || !room.viewers.size) ctx.emit('cancel-autoplay');
  settle(room, ctx.now, ctx.monoNow);
  if (!room.viewers.size) {
    close(room, ctx);
    return;
  }
  if (hostLeft) {
    // An intentional handoff keeps the room's settings, but never its old commands.
    if (reason === 'left') room.epoch = ctx.createId();
    else invalidateControls(room, ctx);
  }
  if (![...room.viewers.values()].some(other => other.userId === room.hostId)) elect(room, ctx);
  autoStart(room, ctx);
}

function kick(room, { userId }, ctx) {
  const now = ctx.now,
    viewers = [...room.viewers.entries()].filter(([, viewer]) => viewer.userId === userId);
  for (const [id, until] of room.kickedViewers) if (until <= now) room.kickedViewers.delete(id);
  for (const [id] of viewers) room.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
  for (const [id, saved] of room.disconnectedViewers)
    if (saved.userId === userId) {
      room.kickedViewers.set(id, now + RECONNECT_GRACE_MS);
      room.disconnectedViewers.delete(id);
    }
  ctx.emit('kicked', { viewerIds: viewers.map(([id]) => id) });
  for (const [id, viewer] of viewers) leave(room, { viewerId: id, actor: viewer.actor, reason: 'kicked' }, ctx);
  return viewers.length;
}

// Timeline and readiness commands for standalone hosts. The self-hosted server's
// commands still run through its own command engine.
function command(room, { command: input }, ctx) {
  const { now, monoNow } = ctx;
  let parsed;
  try {
    parsed = validateSyncCommand(input);
  } catch {
    parsed = undefined;
  }
  if (!parsed) return ctx.fail('Unsupported command or value.', 400);
  settle(room, now, monoNow);
  if (parsed.action.startsWith('media.ready.')) {
    const outcome = applyReadinessDecision(room, parsed.action, parsed.args.readinessId, {
      now,
      monoNow,
      createId: ctx.createId,
    });
    if (outcome.status !== 'applied') return ctx.fail(outcome.message, 409);
  } else {
    if (room.readinessTimedOut && ['media.play', 'media.toggle', 'media.pause'].includes(parsed.action))
      return ctx.fail('The host must choose whether to start, wait or cancel.', 409);
    if (!room.viewers.size) return ctx.fail('No viewer is connected.', 409);
    if (!room.media) return ctx.fail('Choose a video first.', 409);
    if (!applyTimelineCommand(room, parsed, { now, monoNow, createId: ctx.createId }))
      return ctx.fail('Unsupported command or value.', 400);
  }
  room.revision++;
  room.lastActivity = now;
  review(room, ctx);
  ctx.persist(parsed.action);
  return room.revision;
}

const EVENTS = {
  /** A deadline came due. A periodic checkpoint is an effect: its host saves the room. */
  timer(room, _event, ctx) {
    if (ctx.checkpointMs && room.checkpointAt <= ctx.now) {
      while (room.checkpointAt <= ctx.now) room.checkpointAt += ctx.checkpointMs;
      ctx.emit('checkpoint');
    }
    review(room, ctx);
  },
  /** Something outside the core changed the room (a command, new media); recheck its lifecycle. */
  review: (room, _event, ctx) => void review(room, ctx),
  join,
  leave,
  /** A tab's connection closed: a planned close leaves now, any other when presence lapses. */
  disconnect(room, { viewerId, planned }, ctx) {
    const viewer = room.viewers.get(viewerId);
    if (viewer) viewer.at = planned ? ctx.now - PRESENCE_TIMEOUT_MS - 1 : ctx.now;
    review(room, ctx);
  },
  /** Presence from the tab's own connection (clock and pong), with its recent round trips. */
  touch(room, { viewerId, rtts = undefined }, ctx) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer) return false;
    viewer.at = ctx.now;
    if (rtts) viewer.rtts = rtts.map(sample => ({ ...sample }));
    return true;
  },
  ready(room, { actor, viewerId, mediaVersion, ready, readinessVersion }, ctx) {
    try {
      recordViewerReadiness(
        room,
        { userId: actor.userId, viewerId, mediaVersion, ready, readinessVersion },
        { now: ctx.now, monoNow: ctx.monoNow },
      );
    } catch (error) {
      return ctx.fail(error.message);
    }
    autoStart(room, ctx);
  },
  /** A viewer's stream became playable (`available`), or can never be played. */
  stream(room, { viewerId, available }, ctx) {
    if (!room.initialGate) return;
    if (available) room.initialViewers.add(viewerId);
    else room.initialViewers.delete(viewerId);
    autoStart(room, ctx);
  },
  kick,
  /** The room's visibility changed: reconnect grace never survives it. */
  visibility(room, _event, ctx) {
    room.disconnectedViewers.clear();
    review(room, ctx);
  },
  /** A person's display name changed. */
  identity(room, { userId, name }, ctx) {
    if (room.hostId === userId) room.hostName = name;
    ctx.extensions.renamed?.(room, userId, name);
    for (const viewer of room.viewers.values())
      if (viewer.userId === userId) {
        viewer.name = name;
        viewer.actor = { ...viewer.actor, name };
      }
  },
  /** Room roles changed: re-elect the host, voiding commands issued under the old roles unless told not to. */
  roles(room, { invalidate = true }, ctx) {
    if (invalidate) invalidateControls(room, ctx);
    if (!review(room, ctx).elected) elect(room, ctx);
  },
  /** Elects again without the given tabs (a chosen host turned out to be unavailable). */
  elect(room, { exclude = [] }, ctx) {
    elect(room, ctx, new Set(exclude));
    autoStart(room, ctx);
  },
  /** Closes the room; save: false skips its final checkpoint (a deleted room). */
  close: (room, { save = true }, ctx) => close(room, ctx, save),
  command,
};

/**
 * The room core as a pure function: applies one event to a copy of the room's plain
 * state and returns the new state with the effects its host runs after commit. No
 * `await` and no I/O; time and identifiers come from `context`.
 * @param {any} state A live room or plain room state; never modified.
 * @param {{type: string} & Record<string, any>} event
 * @param {{now: number, monoNow: number, createId?: () => string,
 *   authorize: (actor: any, room: any, action: string) => {ok: boolean, reason?: string},
 *   extensions?: any, keys?: {room: readonly string[], viewer: readonly string[]}, hold?: boolean,
 *   checkpointMs?: number}} context
 * @returns {{state: any, effects: Array<{type: string} & Record<string, any>>, error?: Error, value?: any, persist?: string}}
 */
export function reduce(state, event, context) {
  const extensions = context.extensions || {};
  const draft = cloneRoomState(state, context.keys || DEFAULT_KEYS);
  const effects = [];
  /** @type {{state: any, effects: any[], error?: Error, value?: any, persist?: string}} */
  const outcome = { state: draft, effects };
  const ctx = {
    now: context.now,
    monoNow: context.monoNow,
    createId: context.createId || defaultCreateId,
    authorize: context.authorize,
    extensions,
    hold: !!context.hold,
    checkpointMs: context.checkpointMs || 0,
    emit: (type, fields = {}) => {
      effects.push({ type, ...fields });
    },
    fail(message, status = undefined) {
      outcome.error = failure(message, status);
    },
    persist(reason) {
      outcome.persist = reason;
    },
  };
  const handler = EVENTS[event.type] || extensions.events?.[event.type];
  if (!handler) throw new Error('Unknown room event ' + event.type);
  const value = handler(draft, event, ctx);
  if (!outcome.error && value !== undefined) outcome.value = value;
  return outcome;
}

/**
 * When the room next needs a timer event: the earliest of a scheduled pause, the
 * readiness deadline, a presence lapse, the end of a reconnect grace and an unused
 * room expiring. Undefined when nothing is due.
 */
export function nextDeadline(room, now, monoNow) {
  if (room.closed) return undefined;
  let due = Infinity;
  const consider = at => {
    if (Number.isFinite(at) && at < due) due = at;
  };
  if (room.pauseAt) consider(room.pauseAt);
  if (!room.recovery && startPending(room) && Number.isFinite(room.readinessDeadline))
    consider(now + (room.readinessDeadline - monoNow));
  for (const viewer of room.viewers.values()) consider(viewer.at + PRESENCE_TIMEOUT_MS + 1);
  for (const saved of room.disconnectedViewers.values()) consider(saved.expires);
  if (!room.hadViewers) consider(room.lastActivity + IDLE_ROOM_TIMEOUT_MS + 1);
  if (room.checkpointAt !== undefined) consider(room.checkpointAt);
  return due === Infinity ? undefined : due;
}

// ---------------------------------------------------------------------------
// The coordinator: one mailbox per room around the reducer
// ---------------------------------------------------------------------------

const EVENT_ACTIONS = Object.freeze({ join: 'room.view', ready: 'room.view' });
// The mailbox entry for a host step (see `step` below); never a reducer event.
const STEP = Symbol('step');

/**
 * One room registry. Each room's events are reduced one at a time, in order. When a
 * reduced event asks to persist and `onPersist` is given, the new state is committed
 * only after it resolves; effects run only after commit. With `checkpointMs`, each room
 * also asks for a `checkpoint` effect on that period, which its host saves. Timers are effects too: after
 * every commit the room's next deadline is armed, rounded up to `timerResolutionMs`.
 *
 * Every actor event (`join`, `ready`, `command`) is checked with `authorize`, the one
 * authorization decision, before it is reduced; the reducer uses the same hook for
 * room membership. A multi-tenant host keeps one coordinator per tenant.
 * @param {{
 *   authorize: (actor: any, room: any, action: string) => {ok: boolean, reason?: string},
 *   now?: () => number, monoNow?: () => number, createId?: () => string, tenantId?: string,
 *   extensions?: {roomKeys?: string[], viewerKeys?: string[], events?: Record<string, Function>, [hook: string]: any},
 *   onPersist?: (state: any, meta: {event: string, reason: string, revision: number}) => Promise<void>,
 *   onEffect?: (room: any, effect: {type: string} & Record<string, any>, removed: Map<string, any>) => void,
 *   onError?: (error: unknown) => void,
 *   hold?: (room: any) => boolean,
 *   checkpointMs?: number,
 *   timerResolutionMs?: number, timerOrigin?: number,
 *   setTimer?: (action: () => void, ms: number) => any, clearTimer?: (timer: any) => void,
 * }} options
 */
export function createRoomCoordinator(options) {
  if (typeof options?.authorize !== 'function')
    throw new TypeError('createRoomCoordinator needs authorize(actor, room, action)');
  const now = options.now || Date.now,
    monoNow = options.monoNow || defaultMonoNow,
    createId = options.createId || defaultCreateId,
    extensions = options.extensions || {},
    resolution = options.timerResolutionMs || 0,
    origin = options.timerOrigin ?? now();
  const keys = {
    room: [...ROOM_STATE_KEYS, ...(extensions.roomKeys || [])],
    viewer: [...VIEWER_STATE_KEYS, ...(extensions.viewerKeys || [])],
  };
  const setTimer =
    options.setTimer ||
    ((action, ms) => {
      const timer = setTimeout(action, ms);
      timer.unref?.();
      return timer;
    });
  const clearTimer = options.clearTimer || (timer => clearTimeout(timer));
  /** @type {Map<string, any>} */
  const rooms = new Map();
  const mailboxes = new WeakMap(),
    timers = new Map();
  const report = error => {
    if (options.onError) options.onError(error);
    else
      globalThis.queueMicrotask(() => {
        throw error;
      });
  };
  const refused = message => ({ error: failure(message), effects: [] });

  // Deadlines are acted on at the timer resolution, as one periodic sweep would.
  function align(at, current) {
    if (at <= current) return current + (resolution || 1000);
    if (!resolution) return at;
    return origin + Math.ceil((at - origin) / resolution) * resolution;
  }
  function arm(room) {
    const id = room.roomId,
      existing = timers.get(id),
      current = now();
    const due = rooms.get(id) === room ? nextDeadline(room, current, monoNow()) : undefined;
    if (due === undefined) {
      if (existing) clearTimer(existing.timer);
      timers.delete(id);
      return;
    }
    const at = align(due, current);
    // An earlier timer is kept: it finds nothing due yet and arms the next one.
    if (existing && existing.at <= at) return;
    if (existing) clearTimer(existing.timer);
    const entry = { at, timer: undefined };
    entry.timer = setTimer(() => {
      if (timers.get(id) !== entry) return;
      timers.delete(id);
      if (rooms.get(id) === room) submit(room, { type: 'timer' });
    }, at - current);
    timers.set(id, entry);
  }
  function mailboxFor(room) {
    let mailbox = mailboxes.get(room);
    if (!mailbox) mailboxes.set(room, (mailbox = { busy: false, queue: [] }));
    return mailbox;
  }
  function finish(room, result) {
    const removed = commitRoomState(room, result.state, keys);
    for (const effect of result.effects)
      try {
        options.onEffect?.(room, effect, removed);
      } catch (error) {
        report(error);
      }
    arm(room);
    return result;
  }
  // Reduces one event; returns its result, or a promise of it while persisting.
  function process(room, event) {
    if (event.type === STEP) {
      const value = event.step(room);
      if (typeof value?.then === 'function') throw new TypeError('A room step must not wait');
      arm(room);
      return { value, effects: [] };
    }
    const action = event.type === 'command' ? event.command?.action : EVENT_ACTIONS[event.type];
    if (action && event.actor) {
      const decision = options.authorize(event.actor, room, action);
      if (!decision?.ok)
        return {
          error: failure(
            decision?.reason === 'permission'
              ? 'Your room permissions do not allow this action.'
              : 'Room unavailable or private',
            403,
          ),
          effects: [],
        };
    }
    const result = reduce(room, event, {
      now: now(),
      monoNow: monoNow(),
      createId,
      authorize: options.authorize,
      extensions,
      keys,
      hold: !!options.hold?.(room),
      checkpointMs: options.checkpointMs,
    });
    if (!result.persist || !options.onPersist) return finish(room, result);
    const persisting = options.onPersist(cloneRoomState(result.state, keys), {
      event: event.type,
      reason: result.persist,
      revision: result.state.revision,
    });
    return Promise.resolve(persisting).then(
      () => (rooms.get(room.roomId) === room ? finish(room, result) : refused('Room unavailable')),
      error => ({ error, effects: [] }),
    );
  }
  function drain(room, mailbox) {
    while (!mailbox.busy && mailbox.queue.length) {
      const { event, settle: resolve } = mailbox.queue.shift();
      if (rooms.get(room.roomId) !== room) {
        resolve(refused('Room unavailable'));
        continue;
      }
      mailbox.busy = true;
      let outcome;
      try {
        outcome = process(room, event);
      } catch (error) {
        mailbox.busy = false;
        resolve({ error, effects: [] });
        continue;
      }
      if (typeof outcome?.then === 'function') {
        outcome.then(result => {
          mailbox.busy = false;
          resolve(result);
          drain(room, mailbox);
        });
        return;
      }
      mailbox.busy = false;
      resolve(outcome);
    }
  }
  function submit(room, event) {
    const mailbox = mailboxFor(room);
    const entry = { done: false, result: undefined, promise: undefined };
    entry.promise = new Promise(resolve => {
      mailbox.queue.push({
        event,
        settle: value => {
          entry.done = true;
          entry.result = value;
          resolve(value);
        },
      });
    });
    // An event submitted by an effect waits until the event that caused it is done.
    if (!mailbox.busy) drain(room, mailbox);
    return entry;
  }
  const resolveRoom = idOrRoom => (typeof idOrRoom === 'string' ? rooms.get(idOrRoom) : idOrRoom);

  return {
    tenantId: options.tenantId ?? 'default',
    /** The live rooms by id. Read it; change it only through add, delete and events. */
    rooms,
    get: id => rooms.get(id),
    /** Registers a live room (built by its host in the core's shape) and arms its timer. */
    add(room) {
      if (rooms.has(room.roomId)) throw new Error('Room already exists');
      // Checkpoints fall on one grid from the timer origin, whenever the room was added.
      if (options.checkpointMs)
        room.checkpointAt ??= origin + (Math.floor((now() - origin) / options.checkpointMs) + 1) * options.checkpointMs;
      rooms.set(room.roomId, room);
      arm(room);
      return room;
    },
    /** Forgets a room; its pending events are refused. */
    delete(id) {
      const timer = timers.get(id);
      if (timer) clearTimer(timer.timer);
      timers.delete(id);
      return rooms.delete(id);
    },
    /**
     * Reduces an event and returns its result at once when the room's mailbox is free and
     * nothing has to be persisted first; otherwise returns a promise of the result.
     */
    run(idOrRoom, event) {
      const room = resolveRoom(idOrRoom);
      if (!room || rooms.get(room.roomId) !== room) return refused('Room unavailable');
      const entry = submit(room, event);
      return entry.done ? entry.result : entry.promise;
    },
    /**
     * Runs a host step on the live room inside its mailbox, in order with its events.
     * A host's own commands are steps: admission (check and reserve) is one, and the
     * completion of the work it started outside, applied only if the room has not moved
     * on, is another. A step never waits: slow work (a provider, storage) runs outside
     * between steps. Events the step sends run right after it. Returns `{value}` (or
     * `{error}` when the step threw or the room is gone) at once when the mailbox is
     * free, otherwise a promise of it.
     * @param {any} idOrRoom
     * @param {(room: any) => any} step
     */
    step(idOrRoom, step) {
      const room = resolveRoom(idOrRoom);
      if (!room || rooms.get(room.roomId) !== room) return refused('Room unavailable');
      const entry = submit(room, { type: STEP, step });
      return entry.done ? entry.result : entry.promise;
    },
    /** Queues an event in the room's mailbox; resolves with its result. */
    dispatch(idOrRoom, event) {
      const room = resolveRoom(idOrRoom);
      if (!room || rooms.get(room.roomId) !== room) return Promise.resolve(refused('Room unavailable'));
      return submit(room, event).promise;
    },
    /** Re-arms a room's timer after its host changed a deadline outside an event. */
    schedule(idOrRoom) {
      const room = resolveRoom(idOrRoom);
      if (room && rooms.get(room.roomId) === room) arm(room);
    },
    /** When the room's timer is next due, for diagnostics and tests. */
    timerAt: id => timers.get(id)?.at,
    close() {
      for (const { timer } of timers.values()) clearTimer(timer);
      timers.clear();
    },
  };
}
