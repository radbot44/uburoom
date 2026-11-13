# Shared synchronization core (`shared/sync/`)

`shared/sync/` is Uburoom's reusable synchronization library. It provides one shared implementation of clock estimation, timeline math, readiness gating, drift control, command envelope fencing, generic room role policies, and room-scoped state publication for both:

1. **Self-hosted Uburoom** (`server/`, `web/`, `shared/room-protocol.js`) — integrated with Plex, Discord, FFmpeg, and SQLite.
2. **Uburoom Cephalopod** — a managed, multi-tenant Node.js synchronization service that imports `shared/sync/index.mjs` without loading `server/app.js`, Plex, Discord, TLS configuration, or SQLite.

Importing `shared/sync/` has **zero side effects**: it opens no sockets, starts no timers, reads no files or credentials, and adds zero npm dependencies.

---

## 1. Three-layer architecture

| Layer | Location | Responsibilities |
| --- | --- | --- |
| **A. Shared Synchronization Core** | `shared/sync/*.mjs`, `shared/sync/index.js` | Four-timestamp clock filter, server-authoritative timeline math, scheduled `startAt`/`pauseAt` lead coordination, initial/seek readiness gates and straggler bypass, client `PlayerAdapter` and Hybrid EMA drift/jump controllers, generic room roles/capabilities, command `epoch`/`expiresAt` envelope fencing, sync-quality scoring/aggregation, and room/tenant-scoped subscription coalescing. |
| **B. Self-Hosted Uburoom Integration** | `server/*`, `web/*`, `shared/engine.js`, `shared/room-protocol.js` | Plex library browsing, personal Plex entitlement checks, sponsored playback isolation, HLS/direct delivery and FFmpeg AV1 conversion, subtitle extraction/streaming, Discord OAuth/Activity/guild admission, encrypted SQLite account & durable queue storage, `config.yaml` validation, HTTPS/WSS hosting, and DOM player UI. |
| **C. Cephalopod Multi-Tenant Service** | External Node.js service importing `shared/sync/index.mjs` | Multi-tenant authentication and account namespaces, tenant quota/subscription enforcement, custom persistence adapter (`onPersist`), WebSocket transport, and optional client-encrypted content payloads carried alongside plaintext coordination envelopes. |

### Component ownership boundary

| Concern | Owner | Notes |
| --- | --- | --- |
| Clock offset, RTT uncertainty, slew & outlier rejection | `shared/sync/timing.mjs` | Used by browser classic script (`/playback-timing.js`), ES modules, and tests. |
| Presentation EMA (`alpha = 0.35`) & hybrid control signal | `shared/sync/timing.mjs` | Feeds proportional rate controller (`<=90 ms` presentation, `90–180 ms` blend, `>180 ms` position). |
| Client playback loop & `PlayerAdapter` | `shared/sync/client-sync.mjs`, `shared/sync/player-adapter.mjs` | Synchronizes any `PlayerAdapter` (`HTMLVideoElement`, native `libmpv` bridge, or abstract player) without requiring `mediaUrl`. |
| Sync-quality scoring, wire validation & participant priority | `shared/sync/quality.mjs` | Shared across client telemetry (`web/sync-quality.js`), `server/watch-socket.js`, and `server/room/view.js`. |
| Timeline command validation (`media.play`, `media.seek.*`, `media.ready.*`, `room.*`) | `shared/sync/protocol.mjs` | Media-agnostic; Plex catalog IDs, quality ladders, track IDs, and queue mutations stay in `shared/room-protocol.js`. |
| Generic room roles & capabilities (`creator`, `host`, `viewer`) | `shared/sync/policy.mjs` | Tenant-safe; YAML defaults and Discord/Plex operator eligibility stay in `server/room-policy.js`. |
| Command `epoch` / `expiresAt` / `expectedRevision` fencing & coordination/content split | `shared/sync/envelope.mjs` | Enforced in `server/watch-operations.js`, `server/core.js`, and `createRoomCoordinator`. |
| Authoritative room timeline, `controlLead`, readiness state machine, tenant-isolated coordinator | `shared/sync/room-authority.mjs` | Primitives called directly by `server/room/`; `createRoomCoordinator` provides standalone multi-tenant room management with per-room serialized mutations and authorized snapshots. |
| Room-scoped & tenant-scoped notification coalescing | `shared/sync/subscriptions.mjs` | Used by `server/watch-socket.js` so room-local playback updates do not wake or leak to unrelated rooms. |
| Durable room/queue SQLite persistence & Plex catalog queues | `server/watch-rooms.js`, `server/room-store.js`, `server/room-queue.js` | Intentionally kept in self-hosted Uburoom because queue items, bookmarks, and auto-queue continuation are coupled to Plex server/media identities and Uburoom's SQLite schema. |

---

## 2. Module reference

All relative imports inside `shared/sync/` use explicit `.mjs` extensions so the same files load natively in **Node.js ESM** (`import ... from './shared/sync/index.mjs'`), **Node.js CommonJS** (`require('./shared/sync')` on Node `>=22.13`), and **browser ES modules** (`/shared/sync/*.mjs`).

### `shared/sync/timing.mjs`
- `clock({ monotonic, wall })` — Four-timestamp offset estimator with `2 ms/s` slew limit, half-RTT uncertainty floor, 3-sample route reacquisition, and 3-sample server-step agreement. The mapping follows the lowest-RTT sample of the last 30 s; during acquisition (the first 8 accepted samples) a mapping outside a better sample's possible range steps to its edge, afterwards it only slews. **Validity is by uncertainty, not recency:** every exchange in the last 30 s, accepted or rejected as jitter, bounds the true offset to its own offset ± (RTT/2 + 2 ms), widening at an assumed 100 ppm since it arrived. `clockUncertaintyMs` is the tightest such bound on the current mapping, raised if any exchange's range excludes the mapping by more (the drift assumption or the server clock is off). The clock is valid while a mapping and a lowest-RTT sample exist, no server step is pending, and uncertainty is at most 1000 ms (`CLOCK_MAX_UNCERTAINTY_MS`, wide enough for any accepted RTT so a stable high-latency path stays usable). `clockAgeMs` is the time since the last exchange that confirmed the mapping (accepted, or slow with the mapping inside its range). Reset rules are unchanged: a gap of more than 5 s between reads (`CLOCK_DISCONTINUITY_MS`), a monotonic/wall mismatch, a server epoch change, a disconnect, `offline` or `pagehide`. Consumers widen with uncertainty rather than gate on recency: the drift controller's resting band is at least 0.75 × uncertainty (0.5 × while settling) and it rests above 250 ms; corrective jumps need uncertainty at most 125 ms and under half the error; scheduled starts fire on the mapped time, so their error is bounded by the uncertainty; start-delay compensation is measured only for starts whose alarm fired within 150 ms.
- `target(state, serverTime)` — Computes authoritative playback target in seconds across `startAt` and `pauseAt` boundaries.
- `presentation()` / `controlSignal(...)` — Stage 2 Hybrid EMA presentation error tracker and divergence-bounded selector.
- `correction()` / `jumpCorrection()` — Default proportional speed controller (`0.96x–1.04x`) and opt-in occasional jump controller. The default controller converges, then rests: it keeps its own smoothed error estimate (predicted from the rate it commanded, so a lagging or noisy input cannot carry it past zero), starts once that estimate stays outside a resting band for 1 s (the largest of 30 ms, half a frame plus 10 ms, and 0.75 × clock uncertainty), and runs at estimate ÷ 6 s, between 1% and 4%, until the estimate is within 8 ms or changes sign. After a reset (start, seek, stream change, stall, tab return) the first correction may start after 0.5 s from 20 ms (or 0.5 × clock uncertainty). Instead of a fixed time limit, it backs off when the estimate has shrunk by less than 10 ms over 5 s, resting 5 s and doubling up to 60 s on repeated failures. Errors over 0.65 s are left to a seek in `client-sync.mjs`.
- `startDelay()` — Per-stream-kind estimate of how long a player takes from `play()` to its first advancing frame: median of the last 9 measured delays (samples over 1.5 s or negative are ignored), no estimate until 2 samples, compensation capped at 250 ms. In memory per page only (a device's delay is cheap to relearn and differs by browser state, so nothing is persisted).
- `alarm({ now, set, clear })` — Sub-second monotonic timer re-arming for scheduled `startAt` and `pauseAt` deadlines.
- `bufferedAhead(buffered, position)`, `readinessBuffered(...)`, `observationClock()` — Forward buffer inspection and verified local decode advancement tracking.

### `shared/sync/player-adapter.mjs` & `shared/sync/client-sync.mjs`
- `createVideoElementAdapter(video, helpers)` / `normalizePlayerAdapter(host)` — Wraps an `HTMLMediaElement` behind the abstract `PlayerAdapter` interface (`readyState`, `currentTime`, `seek`, `duration`, `paused`, `ended`, `seeking`, `playbackRate`, `setPlaybackRate`, `setAudio`, `play`, `pause`, `bufferedAhead`, `isBufferedAt`, and optional `measureStart()`, called just before `play()`, which resolves with the milliseconds to the first presented frame that advanced past the starting position, via `requestVideoFrameCallback`; it resolves `undefined` where that is unsupported, on pause or seek, or after 2 s). `normalizePlayerAdapter` resolves either an explicit `PlayerAdapter` or an element host.
- **Start-delay compensation (`createSync`).** While holding for a scheduled `startAt`, the paused player is aligned once to the room position *plus* the stream kind's compensation (`host.streamKind(snapshot)`: the browser uses `directHls`, else `state.format`), so the first moving frame lands on the room position. A start whose alarm fired on time (within 150 ms) after that preparation is measured with `measureStart()` and recorded for its kind. With no estimate the seek-ahead is 0 and the drift controller's settling period handles the residue, as before.
- `createSync(host)` — Client synchronization controller. Accepts either `{ player }` (any `PlayerAdapter`) or `{ video }` (`HTMLMediaElement`) and an optional `mediaReady(snapshot)` predicate so non-URL / local / Cephalopod timelines synchronize identically to HLS/direct streams.

### `shared/sync/protocol.mjs` & `shared/sync/policy.mjs`
- `validateSyncCommand(input, { userIdPattern, readinessIdPattern })` — Validates media-agnostic synchronization commands (`media.play`, `media.pause`, `media.toggle`, `media.seek.*`, `media.ready.*`, `media.autoplay.*`, `media.volume.*`, `media.mute`, `media.unmute`, `room.visibility`, `room.kick`). Returns `undefined` for host-specific extensions (such as Plex `media.load` or `queue.*`).
- `Policy.policy(input)`, `Policy.role(room, userId)`, `Policy.admitted(room, userId)`, `Policy.assigned(room, userId)`, `Policy.allowed(room, userId, capability, { isAdmin })`, `Policy.commandCapability(action)`, `Policy.canKickParticipant(room, actorId, targetUserId, { isAdmin })` — Pure role/capability checks with no global owner or Discord guild assumptions.

### `shared/sync/envelope.mjs`
- `validateCommandEnvelope(input, { expectedEpoch, currentRevision, now, maxTtlMs })` — Enforces `epoch` equality, bounded `expiresAt` (`0 < expiresAt - now <= 3000 ms`), and optional optimistic-concurrency `expectedRevision` (`400` `invalid-revision` when not a safe integer `>= 0`; `409` `revision-mismatch` when `currentRevision` is supplied and differs) without inspecting inner command or content payloads.
- `resolveCommandDeadlines({ acceptedAt, expiresAt, commandTtlMs, extendedTtlMs })` — Computes admission and execution deadlines so stale commands are never replayed.
- `splitRoomSnapshot(snapshot)` / `composeRoomSnapshot({ coordination, content })` — Cleanly separates server-visible coordination metadata from media/application content payloads.

### `shared/sync/server-clock.mjs`
- `createServerClock({ wallNow, monoNow })` — The server's one time base for room timelines. It reads the wall clock once, at creation (process start), then returns `floor(wall0 + (mono - mono0))` ms from the monotonic clock only, so a wall-clock step (NTP, manual change) never moves a room's position, `changedAt`/`startAt`/`pauseAt`, `serverNow`, or the clock-exchange replies. Clients map to whatever the server reports, so reported time stays continuous across the step; it can drift from true wall time (that is the point) and does not advance while the machine sleeps. `server/core.js` `Hub` owns the instance (`hub.clock`); `Watch`, `WatchRooms`, the socket and the operations layer read it. Every in-memory deadline (presence, reconnect grace, kicks, recovery, command `expiresAt`, autoplay countdown) uses it too. `Date.now()` stays only for stored or external times (playback history, Plex session reconciliation, logins, Discord, scheduled events). Persisted checkpoints hold positions, never live instants. Pass the same clock's `now` to `room-authority.mjs` functions and to `createRoomCoordinator({ now })`.

### `shared/sync/room-authority.mjs`
- **Timeline primitives:** `position` (`timelinePosition`), `controlLead`, `beginReadiness`, `promoteGroupReadinessLead`, `settle` (`settleRoomTimeline`), `invalidateEpoch`, `recordViewerReadiness`, `areInitialViewersReady`, `snapshotReadiness`, `applyReadinessDecision`, `applyTimelineCommand`. One room shape everywhere: `roomId`, `state.paused`, `media.duration`, `viewers` keyed by viewer id.
- **The room core, a pure reducer:** `reduce(state, event, context) → { state, effects, error?, value?, persist? }` (exported as `reduceRoom`). It copies the room's plain state (`ROOM_STATE_KEYS`, `VIEWER_STATE_KEYS`, plus a host's extension keys), applies one event, and returns the new state with the effects its host runs after commit. No `await`, no I/O; `now`, `monoNow`, `createId` and the `authorize` hook come from `context`. Events: `join`, `leave`, `disconnect`, `touch`, `ready`, `stream`, `kick`, `visibility`, `identity`, `roles`, `elect`, `close`, `timer`, `review` (recheck after an outside change) and, for standalone hosts, timeline/readiness `command`. Lifecycle reviews expire presence and reconnect grace, freeze an empty room (only its host's own tab may wake it within the grace), hand over the host and close unused rooms. When everyone the room waits for is ready, the reducer starts the room itself (no host actor, no provider call). `nextDeadline` (`nextRoomDeadline`) names when the room next needs a `timer` event. Everything on a live room outside the state keys (streams, sockets, provider sessions, timers) is its host's resource and is never seen by the reducer; `commitRoomState` writes a draft back and keeps live viewer objects.
- **`createRoomCoordinator(options)`** — one room registry with a mailbox per room: events are reduced one at a time; when an event asks to persist and `onPersist` is given, the state is committed only after it resolves (a failure leaves the room as it was); `onEffect` runs each effect after commit; after every commit the room's next deadline is armed as a timer, rounded up to `timerResolutionMs`. `authorize(actor, room, action)` is required and is the one authorization decision (the self-hosted server passes `Hub.authorize`; `policyAuthorize` is a role/capability policy for standalone use); `join`, `ready` and `command` events are checked with it before they are reduced. `run` reduces at once when nothing must be persisted; `dispatch` queues. `step(room, fn)` runs a synchronous host step on the live room in the same mailbox order (a host's own command phases; a step never waits, and events it sends run right after it). With `checkpointMs`, each room's timer also emits a `checkpoint` effect on that period, on one grid from `timerOrigin`. `publish(room, change)` hands a publication to `onPublish` in the same mailbox order. Host-specific fields and hooks plug in through `extensions`. A multi-tenant host keeps one coordinator per tenant (`tenantId`).
### `shared/sync/subscriptions.mjs`
- `createSubscriptionBroker({ publish, getRoomId, getTenantId, onError, schedule })` — Coalesces bursts of mutations via `setImmediate` (or custom scheduler) and isolates async `publish` errors per subscriber. `notify({ tenantId, roomId, includeLobby: false })` wakes **only** subscribers of `(tenantId, roomId)`, preventing cross-room wakeups and cross-room/cross-tenant state leakage.

---

## 3. Coordination envelope vs. content payload (E2EE boundary)

Uburoom does not implement end-to-end encryption; self-hosted Uburoom operates as a trusted-server application that validates media entitlement server-side. However, `shared/sync/` maintains a strict separation between server-visible coordination state and content metadata so that Cephalopod can carry client-encrypted rooms without redesigning synchronization:

- **Server-visible coordination envelope (`coordination`):** `id`, `tenantId`, `transportSequence`, `epoch`, `revision`, `mediaVersion`, `streamVersion`, `observationEpoch`, `serverNow`, `startAt`, `pauseAt`, `waitingForReady`, `readinessVersion`, `readiness`, `visibility`, `roomRole`, `canPlayback`, `canManage`, `viewers`, `timeline` (`{ paused, position, duration, seekable }`), and `timing` (`{ serverReceivedAt, serverSentAt, serverProcessingMs, clockEpoch }`).
- **Application / media content payload (`content`):** In self-hosted Uburoom, plaintext Plex/media fields (`title`, `subtitle`, `mediaId`, `mediaUrl`, `tracks`, `queueSummary`, `ending`). In Cephalopod encrypted rooms, `content` can hold an opaque client-encrypted object (e.g., `{ ciphertext, nonce, keyGeneration }`) that `createRoomCoordinator` stores and relays untouched alongside the authoritative timeline.

---

## 4. Integration pattern: `createRoomCoordinator` & `createSubscriptionBroker`

```js
import { createRoomCoordinator, createRoomState, createSubscriptionBroker } from './shared/sync/index.mjs';

const broker = createSubscriptionBroker({ async publish(client) { /* project and send the client's room */ } });
const coordinator = createRoomCoordinator({
  tenantId: 'tenant-a',                               // one coordinator per tenant
  authorize: (actor, room, action) => policy.authorize(actor, room, action), // required, synchronous
  async onPersist(state, meta) { await rooms.saveCheckpoint(state, meta); }, // commit waits for it
  onEffect(room, effect) {
    if (effect.type === 'remove') coordinator.delete(room.roomId);
    broker.notify({ tenantId: 'tenant-a', roomId: room.roomId, includeLobby: effect.type === 'remove' });
  },
  timerResolutionMs: 1000,
});
const room = coordinator.add(createRoomState({ roomId, creatorId: actor.userId, creatorName: actor.name }));
coordinator.run(room, { type: 'join', actor, viewerId });          // presence, readiness and starting are events
await coordinator.dispatch(room, { type: 'command', actor, command: { action: 'media.play' } });
```

The self-hosted server runs one coordinator (tenant `default`) as its room registry (`server/watch.js`): it passes `Hub.authorize`, keeps saves as effects rather than `onPersist`, and adds its personal-settings fields and hooks through `extensions`. Its commands run in two phases through the mailbox: `Hub.dispatch` admits a command under a plain ticket (deadline, Admin epoch, room and epoch), and `Watch.execute` checks that ticket with `Hub.current` and reserves the room (`room.transition`, `viewer.change`) in a `step`, so a command that went stale while queued is refused as it is dequeued. Plex preparation, preloads and durable queue writes then run outside the mailbox, and their result is applied in another step only if the room has not moved on; otherwise what was prepared is stopped. Commands the command table marks `persists` are acknowledged after their save is confirmed, and the periodic save is the coordinator's `checkpoint` effect. A finished command is published through its room's mailbox (`Hub.onCommand` → `Watch.published` → `onPublish`). The server's room code lives in `server/room/` (view, viewer streams, personal and room commands, queue commands and transitions, effects, core extensions), composed onto `Watch` in `server/watch.js`.
### Tenant identity, ownership/billing, and cross-tenant room invitations

Cephalopod services must keep three identity and authorization concepts distinct:

1. **Global user identity (`userId`):** The authenticated person's canonical Cephalopod account identity across the service.
2. **Tenant ownership and billing (`tenantId`):** The organization or subscriber namespace that owns a room, governs storage/concurrency quotas and billing, and partitions `(tenantId, roomId)` durability.
3. **Individual room access:** Whether a specific authenticated `userId` is authorized to join, view, or control a particular room.

In cross-tenant invitation flows, a user whose personal account belongs to Tenant B can join an invited room owned and billed under Tenant A **only through a server-verified room grant** (for example, a Cephalopod-redeemed invitation record or room-scoped session grant verified on the server that binds that room context's authorized `tenantId` and `roomId` and validates ongoing access in `options.authorize`). Room invitations are unhandled by the core: `createRoomCoordinator` strictly enforces tenant isolation, never relaxes cross-tenant boundaries, and never allows clients to select arbitrary `tenantId` values.

---

## 5. Persistence contract and remaining Cephalopod host responsibilities

`createRoomCoordinator` enforces in-process per-room serialization and copy-on-write commit ordering around `onCreateRoom`, `onPersist`, and `onDeleteRoom`, while intentionally delegating database technology and cluster topology to its host service. Specifically:

- **Guaranteed by `createRoomCoordinator`:** each room's events are reduced one at a time in arrival order (an event submitted by an effect waits for the event that caused it); a state that asks to persist is committed only after `onPersist` resolves, and a rejection leaves the room unchanged with no effects; effects run only after commit; timers are armed from the committed state and arrive as `timer` events; rooms are created by the host (`createRoomState`) and registered with `add`, and `delete` drops pending events.
- **Remaining Cephalopod host responsibilities:**
  1. **Transactional storage & monotonic revision guards:** Cephalopod's `onCreateRoom`, `onPersist`, and `onDeleteRoom` implementations must execute atomic database writes partitioned by `(tenantId, roomId)` with optimistic revision guards (`WHERE tenant_id = ? AND room_id = ? AND revision < ?`) so split-brain or stale worker writes cannot overwrite newer checkpoints.
  2. **Wall-clock position checkpointing:** `onPersist` fires on discrete transitions, whereas playback between them is derived via `timelinePosition(room, now)`. For finer crash-resume granularity, read `coordinator.rooms` periodically and write bounded position bookmarks.
  3. **Durable deletion tombstones & payload retention:** `onDeleteRoom` must persist a durable closure tombstone and purge any associated encrypted/plaintext `content` blobs before resolving so closed rooms cannot be resurrected from earlier checkpoints after a restart.
  4. **Startup/lazy rehydration & safe crash recovery:** Skip tombstoned rooms; rebuild each active checkpoint with `createRoomState` (paused, at the checkpoint position, no viewers, a fresh `epoch` and process `clockEpoch`) and `add` it, so pre-crash command envelopes and client clock mappings cannot replay.
  5. **Ambiguous-commit reconciliation:** If a write's outcome is unknown, `onPersist` should reject; the room stays at its last committed state. Reload the authoritative record and replace the room (`delete`, then `add`) before resuming.
  6. **Single-owner residency, quotas & E2EE:** Horizontal scaling must route each active `(tenantId, roomId)` to a single authoritative worker/shard owner; connection authentication, WebSocket frame rate limits, per-tenant quotas, end-to-end `content` key exchange, and future server-verified cross-tenant room invitation grants remain Cephalopod service responsibilities outside `shared/sync/`.
