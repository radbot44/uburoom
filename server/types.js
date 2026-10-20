// @ts-check
'use strict';

/**
 * @file Type definitions for uburoom core domains.
 * Provides compile-time and IDE type safety via JSDoc and `// @ts-check`.
 */

/**
 * An entity interacting with the system (from web browser, Discord, or extension).
 * @typedef {Object} Actor
 * @property {string} userId - Stable internal account or visitor UUID.
 * @property {string} name - Sanitized display name.
 * @property {'web'|'discord'|'extension'} surface - Surface origin.
 * @property {string} [guildId] - Discord guild snowflake if origin is linked to Discord.
 * @property {string} [channelId] - Discord command or text channel snowflake.
 * @property {string} [discordId] - Raw Discord user ID if available.
 * @property {boolean} [activity] - Set by the server after verified Activity sign-in.
 */

/**
 * Viewport picture transformation parameters (zoom, stretch, and pan).
 * @typedef {Object} PictureState
 * @property {number} zoom - Zoom factor (0.1 to 16, default 1).
 * @property {number} stretchX - Horizontal stretch multiplier (0.1 to 16, default 1).
 * @property {number} stretchY - Vertical stretch multiplier (0.1 to 16, default 1).
 * @property {number} x - Horizontal pan offset in pixels (-129 to 129, default 0).
 * @property {number} y - Vertical pan offset in pixels (-129 to 129, default 0).
 */

/**
 * Control permission flags for a room or remote.
 * @typedef {Object} Controls
 * @property {boolean} playback - Whether media transport controls (play, pause, seek) are enabled.
 * @property {boolean} transform - Whether picture adjustments (zoom, stretch, pan) are enabled.
 */

/**
 * Media playback state in a room.
 * @typedef {Object} RoomPlaybackState
 * @property {PictureState} picture - Current viewport transformation state.
 * @property {boolean} paused - Whether playback is currently paused.
 * @property {boolean} [waitingForReady] - Playback intent is playing while startup/seek preparation holds the timeline.
 * @property {boolean} muted - Whether audio is muted.
 * @property {number} volume - Volume percentage (0-100).
 * @property {boolean} seekable - Whether the current stream supports seeking.
 * @property {number} [position] - Current playback position in seconds.
 * @property {number} [duration] - Total media duration in seconds.
 * @property {Array<any>} [profileSlots] - Saved picture profile slots.
 */

/**
 * Room descriptor managed by the Hub.
 * @typedef {Object} RoomDescriptor
 * @property {string} roomId - Unique room UUID.
 * @property {string} epoch - Epoch UUID rotated on consent revocation or host changes.
 * @property {string} alias - User-facing or generated room alias (e.g. 'plex', 'plex.ab12cd34').
 * @property {'watch'|'remote'} kind - Room type ('watch' for watch rooms, 'remote' for extension).
 * @property {string} ownerId - Account UUID of the room creator.
 * @property {string} ownerName - Display name of the room creator.
 * @property {string} hostId - Account UUID of the current room host.
 * @property {string} hostName - Display name of the current room host.
 * @property {'public'|'private'} visibility - Room visibility gate.
 * @property {'owner'|'voice'|'guild'} mode - Authorization mode.
 * @property {boolean} enabled - Whether remote control consent is currently granted.
 * @property {boolean} reachable - Whether the room is actively connected and reachable.
 * @property {number} lastSeen - Timestamp (ms) of last presence ping or activity.
 * @property {Controls} controls - Current allowed control categories.
 * @property {RoomPlaybackState} state - Live playback and picture state.
 * @property {any} socket - WebSocket or virtual socket connection object.
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
 * @property {Actor} actor - Actor context for this viewer.
 * @property {number} at - Timestamp (ms) of last viewer poll/heartbeat.
 * @property {string} quality - Selected quality preset ID (e.g. 'direct', '1080p8', '720p4').
 * @property {boolean} ready - Whether the viewer's player is buffered and ready.
 * @property {boolean} compatible - Whether the viewer supports direct/compatible playback.
 * @property {string} [fallback] - Fallback codec or transcode profile if incompatible.
 * @property {boolean} browserSubtitles - Whether client supports browser-rendered subtitles.
 * @property {number} subtitleOffset - User's personal subtitle timing delay in seconds.
 * @property {ViewerTrackChoice} trackChoice - User's active track selections.
 * @property {number} volume - Personal volume level (0-100).
 * @property {boolean} muted - Personal mute toggle.
 * @property {number} [joinedAt] - Timestamp (ms) when viewer joined.
 * @property {any} [media] - Resolved personal media/stream descriptor from Plex.
 * @property {string} [mediaVersion] - Version token matching room media generation.
 * @property {string} [streamVersion] - Unique generation token for current personal stream.
 * @property {Promise<any>} [preparing] - In-flight media resolution promise if polling.
 * @property {Function} [alive] - Optional liveness check callback.
 * @property {{watchRtts?: Array<{at:number,ms:number}>}} [watchSocket] - Active socket's bounded server-measured round trips; `at` is monotonic.
 */

/**
 * An active watch room instance managing shared timeline and viewers.
 * @typedef {Object} Room
 * @property {RoomDescriptor} s - Underlying hub room descriptor.
 * @property {any} media - Currently loaded Plex media metadata object (or null).
 * @property {string} mediaVersion - Random UUID rotated on media load/change.
 * @property {number} revision - Monotonically increasing room revision counter.
 * @property {number} position - Base timeline position in seconds at `changedAt`.
 * @property {number} changedAt - Timestamp (ms) when position or pause state last changed.
 * @property {Map<string, Viewer>} viewers - Active viewers keyed by viewer ID.
 * @property {Map<string, any>} disconnectedViewers - Recently disconnected viewers preserving state across reconnects.
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
 */

/**
 * A validated command parsed by the shared engine.
 * @typedef {Object} EngineCommand
 * @property {string} action - Action name (e.g. 'media.play', 'media.seek.end', 'zoom.set').
 * @property {Record<string, any>} [args] - Action arguments validated by the engine.
 * @property {string} [sender] - Display name of the command initiator.
 */

module.exports = {};
