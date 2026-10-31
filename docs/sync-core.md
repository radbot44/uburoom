# Shared synchronization core (`shared/sync/`)

`shared/sync/` is Uburoom's reusable synchronization library. It provides one shared implementation of clock estimation, timeline math, readiness gating, drift control, command envelope fencing, generic room role policies, and room-scoped state publication for both:

1. **Self-hosted Uburoom** (`server/`, `web/`, `shared/room-protocol.js`) — integrated with Plex, Discord, FFmpeg, and SQLite.
2. **Future Uburoom Cephalopod** — a separate managed, multi-tenant Node.js synchronization service that imports `shared/sync/index.mjs` without loading `server/app.js`, Plex, Discord, TLS configuration, or SQLite.

Importing `shared/sync/` has **zero side effects**: it opens no sockets, starts no timers, reads no files or credentials, and adds zero npm dependencies.

---

## 1. Three-layer architecture

| Layer | Location | Responsibilities |
| --- | --- | --- |
| **A. Shared Synchronization Core** | `shared/sync/*.mjs`, `shared/sync/index.js` | Four-timestamp clock filter, server-authoritative timeline math, scheduled `startAt`/`pauseAt` lead coordination, initial/seek readiness gates and straggler bypass, client `PlayerAdapter` and Hybrid EMA drift/jump controllers, generic room roles/capabilities, command `epoch`/`expiresAt` envelope fencing, sync-quality scoring/aggregation, and room/tenant-scoped subscription coalescing. |
| **B. Self-Hosted Uburoom Integration** | `server/*`, `web/*`, `shared/engine.js`, `shared/room-protocol.js` | Plex library browsing, personal Plex entitlement checks, sponsored playback isolation, HLS/direct delivery and FFmpeg AV1 conversion, subtitle extraction/streaming, Discord OAuth/Activity/guild admission, encrypted SQLite account & durable queue storage, `config.yaml` validation, HTTPS/WSS hosting, and DOM player UI. |
| **C. Future Cephalopod Integration** | External Node.js service importing `shared/sync/index.mjs` | Multi-tenant authentication and account namespaces, tenant quota/subscription enforcement, custom persistence adapter (`onPersist`), WebSocket transport, and optional client-encrypted content payloads carried alongside plaintext coordination envelopes. |

### Component ownership boundary

| Concern | Owner | Notes |
| --- | --- | --- |
| Clock offset, RTT uncertainty, slew & outlier rejection | `shared/sync/timing.mjs` | Used by browser classic script (`/playback-timing.js`), ES modules, and tests. |
| Presentation EMA (`alpha = 0.35`) & hybrid control signal | `shared/sync/timing.mjs` | Feeds proportional rate controller (`<=90 ms` presentation, `90–180 ms` blend, `>180 ms` position). |
| Client playback loop & `PlayerAdapter` | `shared/sync/client-sync.mjs`, `shared/sync/player-adapter.mjs` | Synchronizes any `PlayerAdapter` (`HTMLVideoElement`, native `libmpv` bridge, or abstract player) without requiring `mediaUrl`. |
| Sync-quality scoring, wire validation & participant priority | `shared/sync/quality.mjs` | Shared across client telemetry (`web/sync-quality.js`), `server/watch-socket.js`, and `server/watch.js`. |
| Timeline command validation (`media.play`, `media.seek.*`, `media.ready.*`, `room.*`) | `shared/sync/protocol.mjs` | Media-agnostic; Plex catalog IDs, quality ladders, track IDs, and queue mutations stay in `shared/room-protocol.js`. |
| Generic room roles & capabilities (`creator`, `host`, `viewer`) | `shared/sync/policy.mjs` | Tenant-safe; YAML defaults and Discord/Plex operator eligibility stay in `server/room-policy.js`. |
| Command `epoch` / `expiresAt` / `expectedRevision` fencing & coordination/content split | `shared/sync/envelope.mjs` | Enforced in `server/watch-operations.js`, `server/core.js`, and `createRoomCoordinator`. |
| Authoritative room timeline, `controlLead`, readiness state machine, tenant-isolated coordinator | `shared/sync/room-authority.mjs` | Primitives called directly by `server/watch.js`; `createRoomCoordinator` provides standalone multi-tenant room management with per-room serialized mutations and authorized snapshots. |
| Room-scoped & tenant-scoped notification coalescing | `shared/sync/subscriptions.mjs` | Used by `server/watch-socket.js` so room-local playback updates do not wake or leak to unrelated rooms. |
| Durable room/queue SQLite persistence & Plex catalog queues | `server/watch-rooms.js`, `server/room-store.js`, `server/room-queue.js` | Intentionally kept in self-hosted Uburoom because queue items, bookmarks, and auto-queue continuation are coupled to Plex server/media identities and Uburoom's SQLite schema. |

---

## 2. Module reference

All relative imports inside `shared/sync/` use explicit `.mjs` extensions so the same files load natively in **Node.js ESM** (`import ... from './shared/sync/index.mjs'`), **Node.js CommonJS** (`require('./shared/sync')` on Node `>=22.13`), and **browser ES modules** (`/shared/sync/*.mjs`).

### `shared/sync/timing.mjs`
- `clock({ monotonic, wall })` — Four-timestamp offset estimator with `2 ms/s` slew limit, half-RTT uncertainty floor, 3-sample route reacquisition, and 3-sample server-step agreement.
- `target(roomSnapshot, receivedMono, nowMono, playbackClock)` — Computes authoritative playback target in seconds across `startAt` and `pauseAt` boundaries.
- `presentation()` / `controlSignal(...)` — Stage 2 Hybrid EMA presentation error tracker and divergence-bounded selector.
- `correction()` / `jumpCorrection()` — Default proportional speed controller (`0.96x–1.04x` with persistence/uncertainty deadbands) and opt-in occasional jump controller.
- `alarm({ now, set, clear })` — Sub-second monotonic timer re-arming for scheduled `startAt` and `pauseAt` deadlines.
- `bufferedAhead(buffered, position)`, `readinessBuffered(...)`, `observationClock()` — Forward buffer inspection and verified local decode advancement tracking.

### `shared/sync/player-adapter.mjs` & `shared/sync/client-sync.mjs`
- `createVideoElementAdapter(video, helpers)` — Wraps an `HTMLMediaElement` behind the abstract `PlayerAdapter` interface (`readyState`, `currentTime`, `seek`, `duration`, `paused`, `ended`, `seeking`, `playbackRate`, `setPlaybackRate`, `setAudio`, `play`, `pause`, `bufferedAhead`, `isBufferedAt`).
- `createSync(host)` — Client synchronization controller. Accepts either `{ player }` (any `PlayerAdapter`) or `{ video }` (`HTMLMediaElement`) and an optional `mediaReady(snapshot)` predicate so non-URL / local / Cephalopod timelines synchronize identically to HLS/direct streams.

### `shared/sync/protocol.mjs` & `shared/sync/policy.mjs`
- `validateSyncCommand(input, { userIdPattern })` — Validates media-agnostic synchronization commands (`media.play`, `media.pause`, `media.toggle`, `media.seek.*`, `media.ready.*`, `room.visibility`, `room.kick`). Returns `undefined` for host-specific extensions (such as Plex `media.load` or `queue.*`).
- `Policy.policy(input)`, `Policy.role(room, userId)`, `Policy.allowed(room, userId, capability, { isAdmin })`, `Policy.commandCapability(action)`, `Policy.canKickParticipant(room, actorUserId, targetUserId, { isAdmin })` — Pure role/capability checks with no global owner or Discord guild assumptions.

### `shared/sync/envelope.mjs`
- `validateCommandEnvelope(input, { expectedEpoch, currentRevision, now, maxTtlMs })` — Enforces `epoch` equality, bounded `expiresAt` (`0 < expiresAt - now <= 3000 ms`), and optional optimistic-concurrency `expectedRevision` (`400` `invalid-revision` when not a safe integer `>= 0`; `409` `revision-mismatch` when `currentRevision` is supplied and differs) without inspecting inner command or content payloads.
- `resolveCommandDeadlines({ acceptedAt, expiresAt, commandTtlMs, extendedTtlMs })` — Computes admission and execution deadlines so stale commands are never replayed.
- `splitRoomSnapshot(snapshot)` / `composeRoomSnapshot({ coordination, content })` — Cleanly separates server-visible coordination metadata from media/application content payloads.

### `shared/sync/room-authority.mjs`
- **Low-level primitives** (used directly by `server/watch.js` on Uburoom rooms): `position` (`timelinePosition`), `controlLead`, `beginReadiness`, `promoteGroupReadinessLead`, `settle` (`settleRoomTimeline`), `invalidateEpoch`, `recordViewerReadiness`, `areInitialViewersReady`, `snapshotReadiness`, `applyReadinessDecision`, `applyTimelineCommand`.
- **`createRoomCoordinator(options)`** — Standalone, multi-tenant room coordinator managing `(tenantId, roomId)` namespaces with strict separation between actor-authorized request handlers and privileged server-internal APIs:
  - **Actor-authorized methods** (`await snapshot`, `listRooms`, `joinViewer`, `leaveViewer`, `loadTimeline`, `reportReadiness`, `executeCommand`, `recordSyncQuality`, `closeRoom`, and `touchViewer` when `actor` is passed): Bind every operation to `actor.tenantId` (caller-supplied `tenantId` options never override `actor.tenantId`), enforce private-room membership (`creator`/`host`/admin) plus optional `options.authorize`, reject kicked `viewerId`s and viewer impersonation, and return uniform `403` errors across missing, cross-tenant, and private rooms without mutating state or revealing room existence.
  - **Revision & epoch semantics:** Every room starts at `revision = 0` and increments `revision` monotonically on authoritative state changes (`loadTimeline`, `executeCommand`, `leaveViewer`, auto-start, and settled scheduled transitions). Mutations on a room are serialized through a per-room async queue so concurrent `authorize` / `onPersist` callbacks cannot interleave. When `expectedRevision` is supplied to `executeCommand`, `loadTimeline`, or `closeRoom`, it must match the room's current effective revision (`409` `revision-mismatch` otherwise, with zero state mutation). When `expectedRevision` is omitted (`undefined`), real-time playback commands (`media.play`, `media.pause`, `media.toggle`, `media.seek.*`) continue using `epoch` + `expiresAt` fencing so concurrent viewer presence or scheduled settlements do not cause false conflicts on live transport controls. (Self-hosted Uburoom durable queue commands continue using their separate `queueRevision` inside `command.args.expectedRevision`.)
  - **Privileged server-internal methods** (`inspectRoomInternal`, `getRoom`, `rooms`, `createRoom` without `actor`, `sweep`): For trusted server-side persistence, health sweeps, or diagnostics only. `inspectRoomInternal(roomId, { tenantId, envelopeOnly })` reads coordination/content state without an `actor` and without incrementing `transportSequence`. Never wire internal methods directly to untrusted client inputs.

### `shared/sync/subscriptions.mjs`
- `createSubscriptionBroker({ publish, getRoomId, getTenantId, onError, schedule })` — Coalesces bursts of mutations via `setImmediate` (or custom scheduler) and isolates async `publish` errors per subscriber. `notify({ tenantId, roomId, includeLobby: false })` wakes **only** subscribers of `(tenantId, roomId)`, preventing cross-room wakeups and cross-room/cross-tenant state leakage.

---

## 3. Coordination envelope vs. content payload (future E2EE boundary)

End-to-end encryption is **not** implemented in Uburoom today; self-hosted Uburoom remains a trusted-server application that validates media entitlement server-side. However, `shared/sync/` separates server-visible coordination state from content metadata so Cephalopod can eventually support encrypted rooms without redesigning synchronization:

- **Server-visible coordination envelope (`coordination`):** `id`, `tenantId`, `transportSequence`, `epoch`, `revision`, `mediaVersion`, `streamVersion`, `observationEpoch`, `serverNow`, `startAt`, `pauseAt`, `waitingForReady`, `readinessVersion`, `readiness`, `visibility`, `roomRole`, `canPlayback`, `canManage`, `viewers`, `timeline` (`{ paused, position, duration, seekable }`), and `timing` (`{ serverReceivedAt, serverSentAt, serverProcessingMs, clockEpoch }`).
- **Application / media content payload (`content`):** In self-hosted Uburoom, plaintext Plex/media fields (`title`, `subtitle`, `mediaId`, `mediaUrl`, `tracks`, `queueSummary`, `ending`). In future Cephalopod encrypted rooms, `content` can hold an opaque client-encrypted object (e.g., `{ ciphertext, nonce, keyGeneration }`) that `createRoomCoordinator` stores and relays untouched alongside the authoritative timeline.

---

## 4. Example: Initializing `shared/sync/` in Uburoom Cephalopod

Below is a realistic Node.js ESM example showing how a multi-tenant **Uburoom Cephalopod** worker/server imports `shared/sync/index.mjs` and wires tenant-scoped authentication, authorized snapshot delivery, optimistic-concurrency command envelopes, and privileged internal checkpointing without importing `server/app.js` or any Plex/Discord/SQLite code:

```js
import { WebSocketServer } from 'ws';
import {
  createRoomCoordinator,
  createSubscriptionBroker,
  classifyMutationScope
} from './shared/sync/index.mjs';

export function createCephalopodSyncNode({ authService, roomRepository, quotaService }) {
  let coordinator;

  // 1. Create the room-scoped & tenant-scoped publication broker.
  //    Every subscriber push re-runs `await coordinator.snapshot(...)` with the client's
  //    authenticated `actor` so kicked or revoked viewers immediately lose access.
  const broker = createSubscriptionBroker({
    getTenantId: client => client.tenantId,
    getRoomId: client => client.subscribedRoomId,
    async publish(client, { roomOnly }) {
      if (client.ws.readyState !== 1) return;
      if (!await authService.isSessionActive(client.sessionId)) {
        client.ws.close(4003, 'Session expired');
        return;
      }
      if (!roomOnly) {
        const rooms = await coordinator.listRooms(client.actor, { tenantId: client.tenantId });
        client.ws.send(JSON.stringify({ type: 'rooms', status: 200, value: { rooms } }));
      }
      const roomId = client.subscribedRoomId;
      if (roomId) {
        try {
          const state = await coordinator.snapshot(roomId, client.actor, {
            viewerId: client.viewerId,
            tenantId: client.tenantId,
            envelopeOnly: true // Keeps `coordination` and opaque/encrypted `content` separated
          });
          if (client.subscribedRoomId === roomId && client.ws.readyState === 1) {
            client.ws.send(JSON.stringify({ type: 'state', roomId, status: 200, value: state }));
          }
        } catch (err) {
          if (err?.status === 403) {
            client.subscribedRoomId = undefined;
            client.viewerId = undefined;
            client.ws.send(JSON.stringify({
              type: 'state',
              roomId,
              status: 403,
              value: { error: 'Room unavailable or private' }
            }));
            return;
          }
          throw err;
        }
      }
    }
  });

  // 2. Create the multi-tenant authoritative room coordinator.
  coordinator = createRoomCoordinator({
    idPattern: /^[a-zA-Z0-9_-]{8,64}$/,
    isAdmin: (actor, room) => actor.tenantRole === 'tenant-admin' && actor.tenantId === room.tenantId,
    async authorize({ tenantId, room, actor, operation }) {
      return quotaService.allowsOperation(tenantId, room.id, actor.userId, operation);
    },
    async onPersist(room) {
      // Trusted internal boundary: `onPersist` runs inside the per-room mutation lock
      // in monotonic `room.revision` order; `inspectRoomInternal` can also read a room
      // for server-side checkpointing without an end-user `actor`.
      const internal = coordinator.inspectRoomInternal(room.id, {
        tenantId: room.tenantId,
        envelopeOnly: true
      });
      if (!internal) return;
      await roomRepository.saveRoomCheckpoint({
        tenantId: room.tenantId,
        roomId: room.id,
        epoch: internal.coordination.epoch,
        revision: internal.coordination.revision,
        visibility: internal.coordination.visibility,
        timeline: internal.coordination.timeline,
        content: room.content // Plaintext descriptor or opaque E2EE ciphertext blob
      });
    },
    onPublish({ tenantId, roomId, includeLobby }) {
      broker.notify({ tenantId, roomId, includeLobby });
    }
  });

  // 3. Attach a transport (e.g. WebSocketServer) provided by Cephalopod.
  //    `session` is verified by Cephalopod's HTTP upgrade authenticator; client messages
  //    never supply or override `tenantId` or `actor`.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  wss.on('connection', (ws, session) => {
    const client = {
      ws,
      sessionId: session.id,
      tenantId: session.tenantId,
      actor: Object.freeze({
        userId: session.userId,
        name: session.displayName,
        tenantId: session.tenantId,
        tenantRole: session.role
      }),
      subscribedRoomId: undefined,
      viewerId: undefined
    };
    broker.add(client);

    ws.on('pong', () => {
      if (client.subscribedRoomId && client.viewerId && client.pingSentMono !== undefined) {
        coordinator.touchViewer(client.subscribedRoomId, client.viewerId, {
          tenantId: client.tenantId,
          actor: client.actor,
          rttMs: performance.now() - client.pingSentMono
        });
      }
    });

    ws.on('message', async raw => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        ws.close(4002, 'Invalid JSON');
        return;
      }

      if (msg.type === 'clock') {
        const serverReceivedAt = Date.now(), receivedMono = performance.now();
        if (client.subscribedRoomId && client.viewerId) {
          coordinator.touchViewer(client.subscribedRoomId, client.viewerId, {
            tenantId: client.tenantId,
            actor: client.actor
          });
        }
        ws.send(JSON.stringify({
          type: 'clock',
          id: msg.id,
          serverNow: Date.now(),
          timing: {
            serverReceivedAt,
            serverSentAt: Date.now(),
            serverProcessingMs: performance.now() - receivedMono,
            clockEpoch: coordinator.clockEpoch
          }
        }));
        return;
      }

      if (msg.type === 'join') {
        try {
          const snapshot = await coordinator.joinViewer(msg.roomId, client.actor, {
            viewerId: msg.viewerId,
            tenantId: client.tenantId,
            envelopeOnly: true
          });
          // Subscribe the connection ONLY after `joinViewer` authorizes membership.
          client.subscribedRoomId = msg.roomId;
          client.viewerId = msg.viewerId;
          ws.send(JSON.stringify({ type: 'joined', id: msg.id, roomId: msg.roomId, status: 200, value: snapshot }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'response',
            id: msg.id,
            status: err?.status || 403,
            value: { error: 'Room unavailable or private' }
          }));
        }
        return;
      }

      if (msg.type === 'load-timeline') {
        // Coordinates an abstract timeline; optional `expectedRevision` prevents lost updates.
        const outcome = await coordinator.loadTimeline(msg.roomId, client.actor, {
          tenantId: client.tenantId,
          expectedRevision: msg.expectedRevision,
          duration: msg.duration,
          position: msg.position || 0,
          autoplay: msg.autoplay !== false,
          content: msg.content
        });
        ws.send(JSON.stringify({ type: 'response', id: msg.id, value: outcome }));
        return;
      }

      if (msg.type === 'ready') {
        try {
          const outcome = await coordinator.reportReadiness(msg.roomId, client.actor, {
            viewerId: client.viewerId,
            mediaVersion: msg.mediaVersion,
            ready: msg.ready,
            readinessVersion: msg.readinessVersion,
            tenantId: client.tenantId
          });
          ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 200, value: outcome }));
        } catch (err) {
          ws.send(JSON.stringify({
            type: 'response',
            id: msg.id,
            status: err?.status || 400,
            value: { error: 'Readiness update rejected' }
          }));
        }
        return;
      }

      if (msg.type === 'command') {
        // Bind `viewerId` and `tenantId` to the authenticated connection; `epoch` and
        // `expiresAt` are required, and `expectedRevision` is enforced whenever supplied.
        const envelope = {
          epoch: msg.envelope?.epoch,
          expiresAt: msg.envelope?.expiresAt,
          ...(msg.envelope?.expectedRevision !== undefined
            ? { expectedRevision: msg.envelope.expectedRevision }
            : {}),
          ...(client.viewerId !== undefined ? { viewerId: client.viewerId } : {}),
          command: msg.envelope?.command
        };
        const outcome = await coordinator.executeCommand(msg.roomId, client.actor, envelope, {
          tenantId: client.tenantId
        });
        ws.send(JSON.stringify({ type: 'response', id: msg.id, value: outcome }));
        return;
      }

      if (msg.type === 'leave') {
        if (client.subscribedRoomId && client.viewerId) {
          await coordinator.leaveViewer(client.subscribedRoomId, client.actor, {
            viewerId: client.viewerId,
            tenantId: client.tenantId
          });
        }
        client.subscribedRoomId = undefined;
        client.viewerId = undefined;
        ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 200, value: { ok: true } }));
        return;
      }

      if (msg.type === 'sync-quality') {
        const outcome = coordinator.recordSyncQuality(msg.roomId, client.actor, msg, {
          tenantId: client.tenantId
        });
        if (!outcome.ok) ws.close(outcome.code, 'Invalid sync quality');
      }
    });

    ws.on('close', () => {
      broker.delete(client);
    });
  });

  return { coordinator, broker, wss, classifyMutationScope };
}
```

---

## 5. Remaining Cephalopod persistence and recovery requirements

`createRoomCoordinator` intentionally keeps room state in memory and delegates storage I/O to its host service. Today, `options.onPersist(room)` is awaited inside the per-room mutation lock in monotonic `room.revision` order when:

- a timeline is loaded (`loadTimeline`),
- room visibility changes (`room.visibility`),
- initial readiness auto-starts playback (`maybeAutoStart`),
- a timed-out readiness decision is applied (`media.ready.start`, `media.ready.wait`, `media.ready.cancel`), or
- a timeline coordination command (`media.play`, `media.pause`, `media.toggle`, `media.seek.*`) is applied.

Because `shared/sync/` does not prescribe a database engine or cluster topology, **Uburoom Cephalopod** must implement the following persistence and recovery behaviors around `createRoomCoordinator`:

1. **Room creation and initial persistence:** `createRoom(...)` allocates an in-memory room at `revision = 0` and does not invoke `onPersist`. Cephalopod's room-creation handler must enforce per-tenant room quotas and durably persist initial room metadata (`tenantId`, `roomId`, `creatorId`, `hosts`, `visibility`, `permissions`, initial `epoch`, `revision`, and `content`) before returning or advertising the room to clients.
2. **State checkpointing:** `onPersist` captures discrete state transitions, while elapsed wall-clock playback between commands is derived via `timelinePosition(room, now)` and natural-ending sweeps (`sweep()`). Cephalopod should guard checkpoint writes with monotonic revision preconditions (`WHERE tenant_id = ? AND room_id = ? AND revision < ?`) and add bounded periodic position bookmarks if crash-resume granularity finer than the last command is required.
3. **Room closure and deletion:** `closeRoom(...)` removes the room from `coordinator.rooms` and emits `room-closed`, but does not call `onPersist`. Cephalopod must persist closure/deletion tombstones (and delete stored content payloads according to retention policy) before acknowledging closure so deleted rooms are never resurrected on restart.
4. **Loading persisted rooms on startup:** `createRoomCoordinator` begins with an empty `rooms` map. Cephalopod must rehydrate active durable rooms on worker startup or lazy room access (`createRoom` + restoring saved timeline/permission fields) while leaving `viewers`, `disconnectedViewers`, and `initialViewers` empty until live clients authenticate and join.
5. **Recovery after process crashes:** If a node crashes while `paused === false`, actual viewer playback progress during the outage is unknown and no viewers are initially connected. Consistent with self-hosted Uburoom's durable room recovery (`server/watch-rooms.js`), Cephalopod should restore crashed rooms in a safe paused or readiness-gated state at the last verified checkpoint position rather than extrapolating `now - changedAt` across server downtime.
6. **Revision and epoch consistency during restoration:** Rehydrating a persisted room must set `room.revision` to at least `persistedRevision + 1` (never resetting `revision` to `0`) so pre-crash `expectedRevision` preconditions cannot collide with post-restore revisions, and must assign a fresh `room.epoch` and coordinator `clockEpoch` on process startup so pre-crash command envelopes and client clock mappings are invalidated.
7. **Prevention of stale-command replay:** Cephalopod must never persist unapplied client commands or replay queued WebSocket mutations across reconnects or worker failovers. Stale commands must fail closed via `COMMAND_TTL_MS` (`expiresAt`), rotated `epoch`s on recovery/host/visibility transitions, and connection-local request correlation IDs.
8. **Tenant isolation during persistence and recovery:** All durable tables, caches, and object keys must be partitioned by composite `(tenantId, roomId)` keys. Lazy room recovery and administrative queries must verify the authenticated session's `tenantId` before loading or exposing any persisted room record.
