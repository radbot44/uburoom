// @ts-check
/* Public interface for the shared Uburoom synchronization core.
 * Safe to import in Node.js (ESM or CJS) and native browser ES modules without
 * starting servers, opening sockets, reading config files, or loading Plex/Discord.
 */

export * as Timing from './timing.mjs';
export * as PlayerAdapter from './player-adapter.mjs';
export * as ClientSync from './client-sync.mjs';
export * as Quality from './quality.mjs';
export * as Protocol from './protocol.mjs';
export * as Policy from './policy.mjs';
export * as Envelope from './envelope.mjs';
export * as RoomAuthority from './room-authority.mjs';
export * as Subscriptions from './subscriptions.mjs';

export {
  MAX_CLOCK_SAMPLE_AGE_MS,
  CLOCK_WINDOW_MS,
  clock,
  target,
  presentation,
  controlSignal,
  alarm,
  correction,
  jumpCorrection,
  bufferedAhead,
  readinessBuffered,
  observationClock
} from './timing.mjs';

export {
  createVideoElementAdapter,
  normalizePlayerAdapter
} from './player-adapter.mjs';

export { createSync } from './client-sync.mjs';

export {
  WINDOW_MS as QUALITY_WINDOW_MS,
  REFRESH_INTERVAL_MS as QUALITY_REFRESH_INTERVAL_MS,
  STALE_AFTER_MS as QUALITY_STALE_AFTER_MS,
  MAX_CLOCK_AGE_MS,
  MAX_CLOCK_UNCERTAINTY_MS,
  RECENT_EVIDENCE_MS,
  PAUSED_EVIDENCE_MS,
  MAX_REPORT_FRESHNESS_MS,
  QUALITY_STATUSES,
  QUALITY_REASONS,
  QUALITY_CONFIDENCES,
  reportableMeasurementFreshnessMs,
  calculate as calculateSyncQuality,
  level as syncQualityLevel,
  create as createSyncQualityTracker,
  validateSyncQualityMessage,
  reduceViewerSyncQuality,
  aggregateParticipantSyncQuality
} from './quality.mjs';

export {
  CONTROLS,
  SYNC_MANAGEMENT_ACTIONS,
  SYNC_ACTIONS,
  controls,
  controlFor,
  controlAllowed,
  senderName,
  validateSyncCommand
} from './protocol.mjs';

export {
  CAPABILITIES,
  VIEWER_BLOCKED,
  CREATOR_ONLY,
  DEFAULTS as ROLE_PERMISSION_DEFAULTS,
  preset as permissionPreset,
  permissions as validateRolePermissions,
  policy as roomPermissionPolicy,
  permissionList,
  role as roomRole,
  assigned as isAssignedRoomMember,
  allowed as isCapabilityAllowed,
  commandCapability,
  canKickParticipant
} from './policy.mjs';

export {
  COMMAND_TTL_MS,
  PRESENCE_TIMEOUT_MS,
  RECONNECT_GRACE_MS,
  validateCommandEnvelope,
  resolveCommandDeadlines,
  splitRoomSnapshot,
  composeRoomSnapshot
} from './envelope.mjs';

export {
  INITIAL_START_LEAD_MS,
  READY_START_MARGIN_MS,
  MAX_CONTROL_LEAD_MS,
  READINESS_WAIT_MS,
  READINESS_EXTEND_MS,
  READINESS_BLOCKER_REVEAL_MS,
  IDLE_ROOM_TIMEOUT_MS,
  MAX_DISCONNECTED_VIEWERS,
  position as timelinePosition,
  controlLead,
  beginReadiness,
  promoteGroupReadinessLead,
  settle as settleRoomTimeline,
  invalidateEpoch,
  recordViewerReadiness,
  areInitialViewersReady,
  snapshotReadiness,
  applyReadinessDecision,
  applyTimelineCommand,
  createRoomCoordinator
} from './room-authority.mjs';

export {
  isRoomLocalAction,
  extractSubscribedRoomId,
  classifyMutationScope,
  createSubscriptionBroker
} from './subscriptions.mjs';
