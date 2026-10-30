// @ts-check
/* Server-visible coordination envelope vs. content/media payload separation.
 * Designed so self-hosted Uburoom continues plaintext validation today while future
 * Cephalopod rooms can carry opaque/client-encrypted content payloads without changing
 * routing, epoch/revision fencing, or playback timeline coordination.
 */

export const COMMAND_TTL_MS = 3000;
export const PRESENCE_TIMEOUT_MS = 10000;
export const RECONNECT_GRACE_MS = 60000;

const COORDINATION_KEYS = Object.freeze([
  'id',
  'tenantId',
  'transportSequence',
  'epoch',
  'revision',
  'mediaVersion',
  'streamVersion',
  'observationEpoch',
  'serverNow',
  'startAt',
  'pauseAt',
  'waitingForReady',
  'readinessVersion',
  'readiness',
  'waitingForHost',
  'recovery',
  'visibility',
  'viewers',
  'maxMembers',
  'durable',
  'roomRole',
  'allHosts',
  'hostPermissions',
  'participantPermissions',
  'capabilities',
  'canManage',
  'canPlayback',
  'canTransform',
  'isHost',
  'adminMode',
  'controls',
  'timing'
]);

/**
 * Validate server-visible command fencing (`epoch`, `expiresAt`, and optional routing IDs)
 * without inspecting or mutating the inner media/content payload.
 * @param {any} input
 * @param {{
 *   expectedEpoch:string|number,
 *   now?:number,
 *   maxTtlMs?:number
 * }} context
 */
export function validateCommandEnvelope(input, { expectedEpoch, now = Date.now(), maxTtlMs = COMMAND_TTL_MS }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {
      ok: false,
      status: 400,
      reason: 'invalid-envelope',
      error: 'Invalid command data'
    };
  }
  if (input.epoch !== expectedEpoch) {
    return {
      ok: false,
      status: 409,
      reason: 'epoch-mismatch',
      error: 'Room changed or command expired; retry manually'
    };
  }
  if (!Number.isFinite(input.expiresAt) || input.expiresAt <= now || input.expiresAt > now + maxTtlMs) {
    return {
      ok: false,
      status: 409,
      reason: Number.isFinite(input.expiresAt) && input.expiresAt <= now ? 'expired' : 'invalid-ttl',
      error: 'Room changed or command expired; retry manually'
    };
  }
  const coordination = {
    ...(input.roomId !== undefined ? { roomId: input.roomId } : {}),
    ...(input.tenantId !== undefined ? { tenantId: input.tenantId } : {}),
    ...(input.viewerId !== undefined ? { viewerId: input.viewerId } : {}),
    ...(input.senderId !== undefined ? { senderId: input.senderId } : {}),
    epoch: input.epoch,
    expiresAt: input.expiresAt,
    ...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {})
  };
  return {
    ok: true,
    coordination,
    payload: input.command !== undefined ? input.command : input.contentPayload
  };
}

/**
 * Compute bounded admission and execution deadlines for a command.
 * Preserves Uburoom's rule that stale `expiresAt` timestamps never execute.
 */
export function resolveCommandDeadlines({
  acceptedAt = Date.now(),
  expiresAt,
  commandTtlMs = COMMAND_TTL_MS,
  extendedTtlMs
} = {}) {
  const admissionDeadline = Math.min(
    acceptedAt + commandTtlMs,
    Number.isFinite(expiresAt) ? expiresAt : Infinity
  );
  if (acceptedAt >= admissionDeadline) {
    return { admitted: false, admissionDeadline, executionDeadline: admissionDeadline };
  }
  const executionDeadline = Number.isFinite(extendedTtlMs) ? acceptedAt + extendedTtlMs : admissionDeadline;
  return { admitted: true, admissionDeadline, executionDeadline };
}

/**
 * Partition a flat room state snapshot into:
 * - `coordination`: server-visible routing, authorization, readiness, and timeline fields
 * - `content`: media identity, tracks, URLs, queue metadata, or opaque client payload
 * @param {Record<string, any>} snapshot
 */
export function splitRoomSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new Error('Invalid room snapshot');
  }
  const coordination = {};
  const content = {};
  const coordKeySet = new Set(COORDINATION_KEYS);

  for (const [key, value] of Object.entries(snapshot)) {
    if (key === 'state' && value && typeof value === 'object') {
      const { paused, position, duration, seekable, volume, muted, ...restState } = value;
      coordination.timeline = {
        paused: Boolean(paused),
        position: Number.isFinite(position) ? position : 0,
        duration: Number.isFinite(duration) ? duration : 0,
        ...(seekable !== undefined ? { seekable: Boolean(seekable) } : {}),
        ...(volume !== undefined ? { volume } : {}),
        ...(muted !== undefined ? { muted } : {})
      };
      if (Object.keys(restState).length > 0) {
        content.playerState = restState;
      }
    } else if (coordKeySet.has(key)) {
      coordination[key] = value;
    } else {
      content[key] = value;
    }
  }
  return { coordination, content };
}

/**
 * Recompose a coordination envelope and a plaintext or opaque content payload
 * into the wire room snapshot shape expected by clients.
 * @param {{coordination:Record<string, any>, content?:Record<string, any>}} parts
 */
export function composeRoomSnapshot({ coordination, content = {} }) {
  if (!coordination || typeof coordination !== 'object') {
    throw new Error('Invalid coordination envelope');
  }
  const { timeline, ...coordFields } = coordination;
  const { playerState, ...contentFields } = content || {};
  const mergedState = timeline || playerState
    ? { ...(playerState || {}), ...(timeline || {}) }
    : undefined;
  return {
    ...contentFields,
    ...coordFields,
    ...(mergedState !== undefined ? { state: mergedState } : {})
  };
}
