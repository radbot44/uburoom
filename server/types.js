// @ts-check
'use strict';

/**
 * @file Type definitions for uburoom core domains.
 * Provides compile-time and IDE type safety via JSDoc and `// @ts-check`.
 */

/**
 * An entity interacting with the system (from web browser or Discord).
 * @typedef {Object} Actor
 * @property {string} userId - Stable internal account or visitor UUID.
 * @property {string} name - Sanitized display name.
 * @property {string} [discordId] - Raw Discord user ID if available.
 * @property {boolean} [activity] - Set by the server after verified Activity sign-in.
 * @property {string} [guestRoomId] - The one room a guest session may open.
 * @property {string} [watchViewerId] - The sender's own watch tab, attached only by the authenticated watch endpoint.
 */

/**
 * Media playback state in a room.
 * @typedef {Object} RoomPlaybackState
 * @property {boolean} paused - Whether playback is currently paused.
 * @property {boolean} [waitingForReady] - Playback intent is playing while startup/seek preparation holds the timeline.
 * @property {boolean} muted - Whether audio is muted.
 * @property {number} volume - Volume percentage (0-100).
 * @property {boolean} seekable - Whether the current stream supports seeking.
 * @property {number} [position] - Current playback position in seconds.
 * @property {number} [duration] - Total media duration in seconds.
 */

/**
 * Room identity, roles and shared playback state that the Hub authorizes against.
 * @typedef {Object} RoomDescriptor
 * @property {string} roomId - Unique room UUID.
 * @property {string} epoch - Epoch UUID rotated on consent revocation or host changes.
 * @property {string} ownerId - Account UUID of the room creator.
 * @property {string} ownerName - Display name of the room creator.
 * @property {string} hostId - Account UUID of the current room host.
 * @property {string} hostName - Display name of the current room host.
 * @property {'public'|'private'} visibility - Room visibility gate.
 * @property {RoomPlaybackState} state - Live playback and picture state.
 * @property {Map<string, Viewer>} [viewers] - Active viewers in the room.
 * @property {Function} [execute] - Command execution delegate.
 */

/**
 * Personal track preferences for a viewer.
 * @typedef {Object} ViewerTrackChoice
 * @property {string} audioId - Selected audio stream ID or 'auto'.
 * @property {string} subtitleId - Selected subtitle stream ID or 'off' | 'auto'.
 * @property {boolean} [browserSubtitles] - Whether subtitles should be rendered in-browser.
 */

/**
 * An individual viewer inside a watch room.
 * @typedef {Object} Viewer
 * @property {string} userId - Account UUID of the viewer.
 * @property {string} [viewerId] - Per-tab viewing ID this viewer is keyed by.
 * @property {Actor} actor - Actor context for this viewer.
 * @property {boolean} [plexReporting] - Viewer consent to Plex activity reporting (absent means allowed).
 * @property {boolean} [plexWatchState] - Viewer consent to Plex watch-state updates.
 * @property {string} [observationEpoch] - Playback observation generation used to fence stale Plex reports.
 * @property {number} at - Timestamp (ms) of last viewer poll/heartbeat.
 * @property {string} [preferredQuality] - Explicit quality preference, retained independently of effective output.
 * @property {string} quality - Selected quality preset ID (e.g. 'direct', '1080p8', '720p4').
 * @property {boolean} ready - Whether the viewer's player is buffered and ready.
 * @property {boolean} compatible - Whether the viewer supports direct/compatible playback.
 * @property {string} [fallback] - Fallback codec or transcode profile if incompatible.
 * @property {boolean} browserSubtitles - Whether client supports browser-rendered subtitles.
 * @property {boolean} [activity] - Server-verified Activity identity; excludes direct Plex delivery.
 * @property {string} [directProxyVersion] - Media generation pinned to proxy recovery for this viewer.
 * @property {any} [directDelivery] - Current personal media object using direct delivery.
 * @property {number} subtitleOffset - User's personal subtitle timing delay in seconds.
 * @property {ViewerTrackChoice} trackChoice - User's active track selections.
 * @property {number} volume - Personal volume level (0-100).
 * @property {boolean} muted - Personal mute toggle.
 * @property {number} [joinedAt] - Timestamp (ms) when viewer joined.
 * @property {Array<{id:string,mediaId:string,title:string}>} [unavailableMedia] - Missing current or pending queue entries.
 * @property {any} [media] - Resolved personal media/stream descriptor from Plex.
 * @property {string} [mediaVersion] - Version token matching room media generation.
 * @property {string} [streamVersion] - Unique generation token for current personal stream.
 * @property {{status:string,score:number,lastKnownScore?:number,lastKnownLevel?:string,lastKnownAt?:number,updatedAt:number,
 *   confidence?:'confident'|'reduced'|'provisional',measurementFreshnessMs?:number,mediaVersion:string,streamVersion:string,
 *   reason?:string}} [syncQuality] - Ephemeral per-tab playback quality from the viewer's authenticated socket.
 * @property {InstanceType<typeof import('./operation').SharedTask> & {bootstrap?:Promise<void>}} [preparing] - One chosen-output preparation lifetime, optionally publishing authorized fallback metadata first.
 * @property {number} [fallbackRetryAt] - Next allowed retry of an unavailable chosen output while fallback plays.
 * @property {Function} [alive] - Optional liveness check callback.
 * @property {() => Promise<boolean>} [reportingAuthorized] - Current login check independent of control-socket liveness, for bounded reporting continuity.
 * @property {{watchRtts?: Array<{at:number,ms:number}>,watchKick?: (roomId: string) => void}} [watchSocket] - Active socket's bounded round trips and subscription-removal notification.
 */

/**
 * Live state of an active watch room: shared timeline, viewers and in-flight work.
 * @typedef {Object} RoomRuntime
 * @property {boolean} [saved] - Whether the room is backed by a saved room record.
 * @property {any} media - Currently loaded Plex media metadata object (or null).
 * @property {InstanceType<typeof import('./fallback-stream').FallbackStream>} [fallbackStream] - Ephemeral room-owned fallback; never persisted.
 * @property {string} mediaVersion - Random UUID rotated on media load/change.
 * @property {number} revision - Monotonically increasing room revision counter.
 * @property {number} position - Base timeline position in seconds at `changedAt`.
 * @property {number} changedAt - Timestamp (ms) when position or pause state last changed.
 * @property {Map<string, Viewer>} viewers - Active viewers keyed by viewer ID.
 * @property {Map<string, any>} disconnectedViewers - Recently disconnected viewers preserving state across reconnects.
 * @property {Map<string, number>} [kickedViewers] - Short-lived fences for removed viewing IDs; accounts may rejoin with a new viewing ID.
 * @property {number} [startAt] - Confirmed synchronized startup/seek release timestamp (ms).
 * @property {number} [pauseAt] - Authoritative UTC deadline for a coordinated pause.
 * @property {string} [readinessId] - Token fencing host choices for a single waiting period.
 * @property {number} [readinessSince] - Monotonic preparation start for blocker feedback.
 * @property {number} [readinessDeadline] - Monotonic deadline for host intervention.
 * @property {boolean} [readinessTimedOut] - Latched until an explicit host choice.
 * @property {number} [readinessStartAt] - Earliest release timestamp, counted alongside buffering.
 * @property {string} [readinessVersion] - Shared seek readiness generation.
 * @property {boolean} initialGate - Whether startup or seek readiness is currently held.
 * @property {boolean} manualPaused - Whether playback was paused deliberately by user action.
 * @property {Set<string>} initialViewers - Viewers present when media was loaded.
 * @property {boolean} hadViewers - Whether any viewer has ever joined this room.
 * @property {number} [lastPing] - Timestamp (ms) of last transcode session keep-alive ping.
 * @property {number} lastActivity - Timestamp (ms) of last command or viewer interaction.
 * @property {number} [playbackIntent] - Generation of the latest explicit play/pause intent.
 * @property {boolean} [closed] - Set by the room core once the room is closing.
 * @property {boolean} [frozen] - Empty, waiting for its host's tab within the reconnect grace.
 * @property {boolean} [mediaTransition] - Set while queued media is being prepared and adopted.
 * @property {boolean} [queueEditing] - Set while a queue edit is being committed.
 * @property {boolean} [waitingForHost] - Playback is held until a host returns.
 * @property {string} [endedVersion] - Media generation whose natural end has been handled.
 * @property {any} [autoplayCountdown] - Active cancellable autoplay countdown.
 * @property {ReturnType<typeof setTimeout>} [autoplayTimer] - Timer that fires the autoplay countdown.
 * @property {string} [autoplayError] - Last autoplay failure shown to the room.
 */

/**
 * An active watch room: one object the Hub and Watch share.
 * @typedef {RoomDescriptor & RoomRuntime} Room
 */

/**
 * A validated command parsed by the shared engine.
 * @typedef {Object} EngineCommand
 * @property {string} action - Action name (e.g. 'media.play', 'media.seek.end').
 * @property {Record<string, any>} [args] - Action arguments validated by the engine.
 * @property {string} [sender] - Display name of the command initiator.
 */

module.exports = {};
