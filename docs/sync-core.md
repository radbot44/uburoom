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
- **`createRoomCoordinator(options)`** — Standalone, multi-tenant room coordinator managing `(tenantId, roomId)` namespaces with per-room serialized state transitions, copy-on-write persistence atomicity, and strict separation between actor-authorized request handlers and privileged server-internal APIs:
  - **Actor-authorized async methods** (`await createRoom` with `actor`, `await snapshot`, `await listRooms`, `await joinViewer`, `await leaveViewer`, `await touchViewer`, `await reportReadiness`, `await executeCommand`, `await recordSyncQuality`, `await closeRoom`): Bind every operation to `actor.tenantId` (caller-supplied `tenantId` options never override `actor.tenantId`), enforce private-room membership (`creator`/`host`/admin) plus optional `options.authorize`, reject kicked `viewerId`s and viewer impersonation, and return uniform `403` errors across missing, cross-tenant, and private rooms without mutating state or revealing room existence.
  - **Per-room serialization & read-only queries:** Every authoritative state transition (`createRoom`, `loadTimeline`, `joinViewer`, `leaveViewer`, `reportReadiness` + synchronous auto-start, `executeCommand`, `recordSyncQuality`, `closeRoom`, `revokeActor`, `reconcileRoomInternal`, and `await sweep`) executes inside an independent per-room FIFO lock (`withRoomLock`) so unrelated rooms never block one another and timers/sweeps/auto-starts never interleave with pending `authorize` or `onPersist` promises. `snapshot()`, `listRooms()`, and `inspectRoomInternal()` are genuinely read-only projections over committed room state: they never mutate `revision`, `paused`, `position`, `viewers`, or readiness gates, never expose in-flight uncommitted proposals, and never deadlock if called from `onPersist` or `onPublish`.
  - **Persistence atomicity & lifecycle contract:** Durable transitions compute changes on a deep-cloned `draft` (`Map`, `Set`, viewer state, permissions, and `content`), pass an isolated clone to `onCreateRoom(room)`, `onPersist(room, meta)`, or `onDeleteRoom(context)` while holding the room lock, commit `draft` to live memory **only after** persistence resolves, and flush `onPublish` notifications **only after** releasing the room lock. Definite persistence failures leave prior committed state and `revision` intact with zero `onPublish` events. If a storage adapter throws an error marked `{ ambiguous: true }` (e.g., network drop after write submission), live state remains unmutated without publishing success, `room.persistenceUncertain` fences further mutations with `503` `persistence-uncertain` while reserving the attempted revision, and the host resolves the room via `await coordinator.reconcileRoomInternal(...)`. When `onCreateRoom`/`onPersist`/`onDeleteRoom` are omitted, the coordinator operates purely in memory.
  - **Revocation-aware presence & telemetry:** `await touchViewer(roomId, actor, { viewerId, tenantId, rttMs })` enforces tenant isolation, viewer ownership, optional synchronous `options.isRevoked`, and bounded periodic `options.authorize` revalidation every `presenceAuthIntervalMs` (default `5000 ms`, half of `PRESENCE_TIMEOUT_MS`) so rapid clock/pong frames avoid per-message database lookups while externally revoked viewers are evicted before presence timeout without receiving reconnect grace. `await recordSyncQuality(roomId, actor, message, { tenantId })` checks per-viewer rate limits before calling `options.authorize` and evicts revoked senders under the room lock. `await leaveViewer(roomId, actor, { viewerId, tenantId, reason })` cleans up active presence immediately, preserving `RECONNECT_GRACE_MS` state when `reason === 'disconnected'` and clearing grace when `reason === 'left'`.
  - **Revision & epoch semantics:** Every room starts at `revision = 0` and increments `revision` monotonically on committed authoritative transitions. When `expectedRevision` is supplied to `executeCommand`, `loadTimeline`, or `closeRoom`, it must match the room's committed `revision` (`409` `revision-mismatch` otherwise, with zero state mutation). When `expectedRevision` is omitted (`undefined`), real-time playback commands (`media.play`, `media.pause`, `media.toggle`, `media.seek.*`) continue using `epoch` + `expiresAt` fencing. (Self-hosted Uburoom durable queue commands continue using their separate `queueRevision` inside `command.args.expectedRevision`.)
  - **Privileged server-internal methods** (`inspectRoomInternal`, `restoreRoomInternal`, `await reconcileRoomInternal`, `await revokeActor`, `await sweep`, `getRoom`, `rooms`, `createRoom` without `actor`): For trusted server-side diagnostics, startup rehydration, ambiguous-write reconciliation, push session revocation, and periodic maintenance only. Never wire internal methods directly to untrusted client inputs.

### `shared/sync/subscriptions.mjs`
- `createSubscriptionBroker({ publish, getRoomId, getTenantId, onError, schedule })` — Coalesces bursts of mutations via `setImmediate` (or custom scheduler) and isolates async `publish` errors per subscriber. `notify({ tenantId, roomId, includeLobby: false })` wakes **only** subscribers of `(tenantId, roomId)`, preventing cross-room wakeups and cross-room/cross-tenant state leakage.

---

## 3. Coordination envelope vs. content payload (future E2EE boundary)

End-to-end encryption is **not** implemented in Uburoom today; self-hosted Uburoom remains a trusted-server application that validates media entitlement server-side. However, `shared/sync/` separates server-visible coordination state from content metadata so Cephalopod can eventually support encrypted rooms without redesigning synchronization:

- **Server-visible coordination envelope (`coordination`):** `id`, `tenantId`, `transportSequence`, `epoch`, `revision`, `mediaVersion`, `streamVersion`, `observationEpoch`, `serverNow`, `startAt`, `pauseAt`, `waitingForReady`, `readinessVersion`, `readiness`, `visibility`, `roomRole`, `canPlayback`, `canManage`, `viewers`, `timeline` (`{ paused, position, duration, seekable }`), and `timing` (`{ serverReceivedAt, serverSentAt, serverProcessingMs, clockEpoch }`).
- **Application / media content payload (`content`):** In self-hosted Uburoom, plaintext Plex/media fields (`title`, `subtitle`, `mediaId`, `mediaUrl`, `tracks`, `queueSummary`, `ending`). In future Cephalopod encrypted rooms, `content` can hold an opaque client-encrypted object (e.g., `{ ciphertext, nonce, keyGeneration }`) that `createRoomCoordinator` stores and relays untouched alongside the authoritative timeline.

---

## 4. Example: Initializing `shared/sync/` in Uburoom Cephalopod

Below is a realistic Node.js ESM example showing how a multi-tenant **Uburoom Cephalopod** worker/server imports `shared/sync/index.mjs` and wires session validation, server-derived tenant identity, atomic room creation/closure persistence, revocation-aware heartbeats and telemetry, disconnect reconnect-grace cleanup, and periodic sweeps without importing `server/app.js` or any Plex/Discord/SQLite code:

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
  //    Every subscriber push validates session liveness and re-runs `await coordinator.snapshot(...)`
  //    with the client's server-verified `actor` so kicked or revoked viewers lose access immediately.
  const broker = createSubscriptionBroker({
    getTenantId: client => client.tenantId,
    getRoomId: client => client.subscribedRoomId,
    async publish(client, { roomOnly }) {
      if (client.ws.readyState !== 1) return;
      if (!await authService.isSessionActive(client.sessionId)) {
        client.terminationCause = 'session-revoked';
        client.ws.close(4003, 'Session expired');
        return;
      }
      if (!roomOnly) {
        const rooms = await coordinator.listRooms(client.actor, { tenantId: client.tenantId });
        if (client.ws.readyState === 1) {
          client.ws.send(JSON.stringify({ type: 'rooms', status: 200, value: { rooms } }));
        }
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
            if (client.ws.readyState === 1) {
              client.ws.send(JSON.stringify({
                type: 'state',
                roomId,
                status: 403,
                value: { error: 'Room unavailable or private' }
              }));
            }
            return;
          }
          throw err;
        }
      }
    }
  });

  // 2. Create the multi-tenant authoritative room coordinator.
  //    Privileged methods (`inspectRoomInternal`, `restoreRoomInternal`, `reconcileRoomInternal`,
  //    `revokeActor`, `sweep`) remain strictly inside trusted server callbacks.
  coordinator = createRoomCoordinator({
    idPattern: /^[a-zA-Z0-9_-]{8,64}$/,
    presenceAuthIntervalMs: 5000,
    isAdmin: (actor, room) => actor.tenantRole === 'tenant-admin' && actor.tenantId === room.tenantId,
    isRevoked: ({ tenantId, actor }) => authService.isRevokedCached(tenantId, actor.userId),
    async authorize({ tenantId, room, actor, operation }) {
      return quotaService.allowsOperation(tenantId, room.id, actor.userId, operation);
    },
    async onCreateRoom(proposedRoom) {
      // Runs before the room enters `coordinator.rooms` or emits `room-created`.
      await roomRepository.insertRoom({
        tenantId: proposedRoom.tenantId,
        roomId: proposedRoom.id,
        creatorId: proposedRoom.creatorId,
        hosts: proposedRoom.hosts,
        visibility: proposedRoom.visibility,
        permissions: proposedRoom.permissions,
        epoch: proposedRoom.epoch,
        revision: proposedRoom.revision,
        content: proposedRoom.content
      });
    },
    async onPersist(proposedRoom, meta) {
      // `proposedRoom` is an isolated proposed snapshot inside the per-room lock;
      // live memory commits and publishes ONLY after this promise resolves.
      await roomRepository.saveRoomCheckpoint({
        tenantId: proposedRoom.tenantId,
        roomId: proposedRoom.id,
        previousRevision: meta?.previousRevision,
        epoch: proposedRoom.epoch,
        revision: proposedRoom.revision,
        mediaVersion: proposedRoom.mediaVersion,
        visibility: proposedRoom.visibility,
        hasMedia: proposedRoom.hasMedia,
        paused: proposedRoom.paused,
        position: proposedRoom.position,
        duration: proposedRoom.duration,
        seekable: proposedRoom.seekable,
        startAt: proposedRoom.startAt,
        pauseAt: proposedRoom.pauseAt,
        initialGate: proposedRoom.initialGate,
        manualPaused: proposedRoom.manualPaused,
        changedAt: proposedRoom.changedAt,
        content: proposedRoom.content
      });
    },
    async onDeleteRoom({ tenantId, roomId, epoch, revision, closedAt }) {
      // Runs before the room is removed from `coordinator.rooms` or `room-closed` is published.
      await roomRepository.recordRoomTombstone({ tenantId, roomId, epoch, revision, closedAt });
    },
    onPublish({ tenantId, roomId, includeLobby }) {
      broker.notify({ tenantId, roomId, includeLobby });
    }
  });

  // Push immediate eviction when Cephalopod's auth tier revokes an account or tenant membership.
  const unsubscribeRevocations = authService.onRevoke(({ tenantId, userId }) => {
    void coordinator.revokeActor({ tenantId, userId }).catch(() => {});
  });

  async function reconcileIfUncertain(tenantId, roomId, err) {
    if (!err?.ambiguous && !err?.persistenceUncertain) return;
    const saved = await roomRepository.loadRoom(tenantId, roomId);
    await coordinator.reconcileRoomInternal(roomId, saved || { closed: true }, { tenantId });
  }

  // 3. Attach a transport (e.g. WebSocketServer) provided by Cephalopod.
  //    `session` is verified by Cephalopod's HTTP upgrade authenticator; client frames
  //    never supply or override `tenantId` or `actor`.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });
  const clients = new Set();

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
      viewerId: undefined,
      lastSeen: Date.now(),
      pingSentMono: undefined,
      terminationCause: undefined
    };
    clients.add(client);
    broker.add(client);

    ws.on('pong', async () => {
      client.lastSeen = Date.now();
      const sentMono = client.pingSentMono;
      client.pingSentMono = undefined;
      if (client.subscribedRoomId && client.viewerId && sentMono !== undefined) {
        const ok = await coordinator.touchViewer(client.subscribedRoomId, client.actor, {
          viewerId: client.viewerId,
          tenantId: client.tenantId,
          rttMs: performance.now() - sentMono
        });
        if (!ok && ws.readyState === 1) {
          client.subscribedRoomId = undefined;
          client.viewerId = undefined;
          ws.close(4003, 'Room access revoked');
        }
      }
    });

    ws.on('message', raw => {
      void (async () => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          ws.close(4002, 'Invalid JSON');
          return;
        }
        if (!await authService.isSessionActive(client.sessionId)) {
          client.terminationCause = 'session-revoked';
          ws.close(4003, 'Session expired');
          return;
        }
        client.lastSeen = Date.now();

        if (msg.type === 'clock') {
          const serverReceivedAt = Date.now(), receivedMono = performance.now();
          if (client.subscribedRoomId && client.viewerId) {
            const ok = await coordinator.touchViewer(client.subscribedRoomId, client.actor, {
              viewerId: client.viewerId,
              tenantId: client.tenantId
            });
            if (!ok) {
              client.subscribedRoomId = undefined;
              client.viewerId = undefined;
              ws.close(4003, 'Room access revoked');
              return;
            }
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

        if (msg.type === 'create-room') {
          try {
            const room = await coordinator.createRoom({
              actor: client.actor,
              tenantId: client.tenantId,
              name: msg.name || '',
              visibility: msg.visibility === 'private' ? 'private' : 'public',
              content: msg.content || {}
            });
            ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 201, value: { id: room.id } }));
          } catch (err) {
            ws.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: err?.status || 503,
              value: { error: err?.status === 403 ? 'Room creation not authorized' : 'Unable to persist new room' }
            }));
          }
          return;
        }

        if (msg.type === 'join') {
          try {
            const snapshot = await coordinator.joinViewer(msg.roomId, client.actor, {
              viewerId: msg.viewerId,
              tenantId: client.tenantId,
              envelopeOnly: true
            });
            // Subscribe the connection ONLY after `joinViewer` authorizes & commits membership.
            client.subscribedRoomId = msg.roomId;
            client.viewerId = msg.viewerId;
            ws.send(JSON.stringify({ type: 'joined', id: msg.id, roomId: msg.roomId, status: 200, value: snapshot }));
          } catch (err) {
            await reconcileIfUncertain(client.tenantId, msg.roomId, err);
            ws.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: err?.status || 503,
              value: { error: err?.status === 403 ? 'Room unavailable or private' : 'Room temporarily unavailable' }
            }));
          }
          return;
        }

        if (msg.type === 'load-timeline') {
          try {
            const outcome = await coordinator.loadTimeline(msg.roomId, client.actor, {
              tenantId: client.tenantId,
              expectedRevision: msg.expectedRevision,
              duration: msg.duration,
              position: msg.position || 0,
              autoplay: msg.autoplay !== false,
              content: msg.content
            });
            ws.send(JSON.stringify({ type: 'response', id: msg.id, status: outcome.httpStatus || 200, value: outcome }));
          } catch (err) {
            await reconcileIfUncertain(client.tenantId, msg.roomId, err);
            ws.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: 503,
              value: { status: 'unavailable', error: 'Timeline update could not be persisted' }
            }));
          }
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
            await reconcileIfUncertain(client.tenantId, msg.roomId, err);
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
          const envelope = {
            epoch: msg.envelope?.epoch,
            expiresAt: msg.envelope?.expiresAt,
            ...(msg.envelope?.expectedRevision !== undefined
              ? { expectedRevision: msg.envelope.expectedRevision }
              : {}),
            ...(client.viewerId !== undefined ? { viewerId: client.viewerId } : {}),
            command: msg.envelope?.command
          };
          try {
            const outcome = await coordinator.executeCommand(msg.roomId, client.actor, envelope, {
              tenantId: client.tenantId
            });
            ws.send(JSON.stringify({ type: 'response', id: msg.id, status: outcome.httpStatus || 200, value: outcome }));
          } catch (err) {
            await reconcileIfUncertain(client.tenantId, msg.roomId, err);
            ws.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: 503,
              value: { status: 'unavailable', error: 'Command could not be durably committed' }
            }));
          }
          return;
        }

        if (msg.type === 'close-room') {
          try {
            const outcome = await coordinator.closeRoom(msg.roomId, client.actor, {
              tenantId: client.tenantId,
              epoch: msg.epoch,
              expectedRevision: msg.expectedRevision
            });
            ws.send(JSON.stringify({ type: 'response', id: msg.id, status: outcome.httpStatus || 200, value: outcome }));
          } catch (err) {
            await reconcileIfUncertain(client.tenantId, msg.roomId, err);
            ws.send(JSON.stringify({
              type: 'response',
              id: msg.id,
              status: 503,
              value: { status: 'unavailable', error: 'Room closure could not be persisted' }
            }));
          }
          return;
        }

        if (msg.type === 'leave') {
          const roomId = client.subscribedRoomId;
          const viewerId = client.viewerId;
          client.subscribedRoomId = undefined;
          client.viewerId = undefined;
          if (roomId && viewerId) {
            await coordinator.leaveViewer(roomId, client.actor, {
              viewerId,
              tenantId: client.tenantId,
              reason: 'left'
            }).catch(() => {});
          }
          ws.send(JSON.stringify({ type: 'response', id: msg.id, status: 200, value: { ok: true } }));
          return;
        }

        if (msg.type === 'sync-quality') {
          const outcome = await coordinator.recordSyncQuality(msg.roomId, client.actor, msg, {
            tenantId: client.tenantId
          });
          if (!outcome.ok) {
            if (outcome.code === 4003) {
              client.subscribedRoomId = undefined;
              client.viewerId = undefined;
            }
            ws.close(outcome.code, 'Invalid or unauthorized sync quality');
          }
        }
      })().catch(() => ws.close(4002, 'Request failed'));
    });

    ws.on('close', code => {
      const roomId = client.subscribedRoomId;
      const viewerId = client.viewerId;
      client.subscribedRoomId = undefined;
      client.viewerId = undefined;
      clients.delete(client);
      broker.delete(client);
      if (roomId && viewerId) {
        // Unexpected network drops (`1005`/`1006`) clean up active presence immediately while
        // retaining `RECONNECT_GRACE_MS` reconnect state; clean/auth exits drop grace immediately.
        const unexpectedDrop = (code === 1005 || code === 1006) && !client.terminationCause;
        void coordinator.leaveViewer(roomId, client.actor, {
          viewerId,
          tenantId: client.tenantId,
          reason: unexpectedDrop ? 'disconnected' : 'left'
        }).catch(() => {});
      }
    });
  });

  // 4. Periodic heartbeat ping/stale-socket eviction and serialized coordinator maintenance sweeps.
  const maintenanceTimer = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (now - client.lastSeen >= 10_000) {
        client.terminationCause = 'idle-timeout';
        client.ws.terminate();
      } else if (client.pingSentMono === undefined && client.ws.readyState === 1) {
        client.pingSentMono = performance.now();
        client.ws.ping();
      }
    }
    void coordinator.sweep().catch(() => {});
  }, 1000);
  maintenanceTimer.unref?.();

  return {
    coordinator,
    broker,
    wss,
    classifyMutationScope,
    close() {
      clearInterval(maintenanceTimer);
      unsubscribeRevocations?.();
      for (const client of clients) {
        client.terminationCause = 'server-shutdown';
        client.ws.terminate();
      }
      wss.close();
    }
  };
}
```

### Tenant identity, ownership/billing, and cross-tenant room invitations

Future **Uburoom Cephalopod** development must keep three identity and authorization concepts distinct:

1. **Global user identity (`userId`):** The authenticated person's canonical Cephalopod account identity across the service.
2. **Tenant ownership and billing (`tenantId`):** The organization or subscriber namespace that owns a room, governs storage/concurrency quotas and billing, and partitions `(tenantId, roomId)` durability.
3. **Individual room access:** Whether a specific authenticated `userId` is authorized to join, view, or control a particular room.

In future Cephalopod invitation flows, a user whose personal account belongs to Tenant B must be able to join an invited room owned and billed under Tenant A **only through a server-verified room grant** (for example, a Cephalopod-redeemed invitation record or room-scoped session grant verified on the server that binds that room context's authorized `tenantId` and `roomId` and validates ongoing access in `options.authorize`). Room invitations are **not** implemented today: `createRoomCoordinator` strictly enforces tenant isolation, never relaxes cross-tenant boundaries, and never allows clients to select arbitrary `tenantId` values.

---

## 5. Persistence contract and remaining Cephalopod host responsibilities

`createRoomCoordinator` enforces in-process per-room serialization and copy-on-write commit ordering around `onCreateRoom`, `onPersist`, and `onDeleteRoom`, while intentionally delegating database technology and cluster topology to its host service. Specifically:

- **Guaranteed by `createRoomCoordinator`:**
  - `createRoom` awaits `onCreateRoom` (or `onPersist` with `{ operation: 'create' }`) under a `(tenantId, roomId)` key lock before inserting the room into `coordinator.rooms` or emitting `room-created`.
  - Durable transitions (`loadTimeline`, `executeCommand`, `leaveViewer`, auto-start in `reportReadiness`/`joinViewer`, `revokeActor`, and `sweep` settlements) compute changes on an isolated deep copy, await `onPersist(proposedRoom, meta)` inside `withRoomLock`, commit in-memory state **only after** `onPersist` resolves, and emit `onPublish` **only after** releasing the room lock.
  - `closeRoom` awaits `onDeleteRoom` (or `onPersist` with `{ operation: 'close', closed: true }`) inside `withRoomLock` before removing the room from `coordinator.rooms` or emitting `room-closed`.
  - Definite persistence rejections leave the previously committed room state and `revision` intact and emit zero `onPublish` notifications; errors flagged `{ ambiguous: true }` fence subsequent mutations with `503` `persistence-uncertain` and reserve the uncertain revision until `reconcileRoomInternal` runs.

- **Remaining Cephalopod host responsibilities:**
  1. **Transactional storage & monotonic revision guards:** Cephalopod's `onCreateRoom`, `onPersist`, and `onDeleteRoom` implementations must execute atomic database writes partitioned by `(tenantId, roomId)` with optimistic revision guards (`WHERE tenant_id = ? AND room_id = ? AND revision < ?`) so split-brain or stale worker writes cannot overwrite newer checkpoints.
  2. **Wall-clock position checkpointing:** `onPersist` fires on discrete transitions and settlements, whereas continuous wall-clock playback between commands is derived via `timelinePosition(room, now)`. If Cephalopod requires crash-resume granularity finer than the latest command or settlement, it can inspect rooms periodically via `inspectRoomInternal` and write bounded position bookmarks.
  3. **Durable deletion tombstones & payload retention:** `onDeleteRoom` must persist a durable closure tombstone and purge any associated encrypted/plaintext `content` blobs before resolving so closed rooms cannot be resurrected from earlier checkpoints after a restart.
  4. **Startup/lazy rehydration & safe crash recovery:** On worker startup or lazy room activation, Cephalopod must skip tombstoned rooms and pass active persisted checkpoints to `coordinator.restoreRoomInternal(checkpoint)`. `restoreRoomInternal` restores rooms in a safe `paused: true` state at the last verified checkpoint position with empty `viewers`/`disconnectedViewers`, `revision = persistedRevision + 1`, and a fresh `epoch` (paired with a fresh process `clockEpoch`) so pre-crash command envelopes, `expectedRevision` preconditions, and client clock mappings cannot collide or replay.
  5. **Ambiguous-commit reconciliation:** If a database driver drops a connection after sending a write (so commit vs. rollback is unknown), the adapter should throw an error with `err.ambiguous = true`, query authoritative storage for `(tenantId, roomId)`, and invoke `await coordinator.reconcileRoomInternal(roomId, savedRecord, { tenantId })` before resuming mutations.
  6. **Single-owner residency, quotas & E2EE:** Horizontal scaling must route each active `(tenantId, roomId)` to a single authoritative worker/shard owner; connection authentication, WebSocket frame rate limits, per-tenant quotas, end-to-end `content` key exchange, and future server-verified cross-tenant room invitation grants remain Cephalopod service responsibilities outside `shared/sync/`.
