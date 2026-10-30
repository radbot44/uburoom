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
| Command `epoch` / `expiresAt` fencing & coordination/content split | `shared/sync/envelope.mjs` | Enforced in `server/watch-operations.js`, `server/core.js`, and `createRoomCoordinator`. |
| Authoritative room timeline, `controlLead`, readiness state machine | `shared/sync/room-authority.mjs` | Primitives called directly by `server/watch.js`; `createRoomCoordinator` provides standalone multi-tenant room management. |
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
- `validateCommandEnvelope(input, { expectedEpoch, now, maxTtlMs })` — Enforces `epoch` equality and bounded `expiresAt` (`0 < expiresAt - now <= 3000 ms`) without inspecting inner command or content payloads.
- `resolveCommandDeadlines({ acceptedAt, expiresAt, commandTtlMs, extendedTtlMs })` — Computes admission and execution deadlines so stale commands are never replayed.
- `splitRoomSnapshot(snapshot)` / `composeRoomSnapshot({ coordination, content })` — Cleanly separates server-visible coordination metadata from media/application content payloads.

### `shared/sync/room-authority.mjs`
- **Low-level primitives** (used directly by `server/watch.js` on Uburoom rooms): `position` (`timelinePosition`), `controlLead`, `beginReadiness`, `promoteGroupReadinessLead`, `settle` (`settleRoomTimeline`), `invalidateEpoch`, `recordViewerReadiness`, `areInitialViewersReady`, `snapshotReadiness`, `applyReadinessDecision`, `applyTimelineCommand`.
- **`createRoomCoordinator(options)`** — Standalone, multi-tenant room coordinator managing `(tenantId, roomId)` namespaces, viewer presence/RTT samples (`joinViewer`, `leaveViewer`, `touchViewer`, `sweep`), abstract timeline loading (`loadTimeline`), readiness gates (`reportReadiness`), fenced command execution (`executeCommand`), sync-quality state (`recordSyncQuality`), and snapshots (`snapshot`, `listRooms`, `closeRoom`).

### `shared/sync/subscriptions.mjs`
- `createSubscriptionBroker({ publish, getRoomId, getTenantId, schedule })` — Coalesces bursts of mutations via `setImmediate` (or custom scheduler). `notify({ tenantId, roomId, includeLobby: false })` wakes **only** subscribers of `(tenantId, roomId)`, preventing cross-room wakeups and cross-room/cross-tenant state leakage.

---

## 3. Coordination envelope vs. content payload (future E2EE boundary)

End-to-end encryption is **not** implemented in Uburoom today; self-hosted Uburoom remains a trusted-server application that validates media entitlement server-side. However, `shared/sync/` separates server-visible coordination state from content metadata so Cephalopod can eventually support encrypted rooms without redesigning synchronization:

- **Server-visible coordination envelope (`coordination`):** `id`, `tenantId`, `transportSequence`, `epoch`, `revision`, `mediaVersion`, `streamVersion`, `observationEpoch`, `serverNow`, `startAt`, `pauseAt`, `waitingForReady`, `readinessVersion`, `readiness`, `visibility`, `roomRole`, `canPlayback`, `canManage`, `viewers`, `timeline` (`{ paused, position, duration, seekable }`), and `timing` (`{ serverReceivedAt, serverSentAt, serverProcessingMs, clockEpoch }`).
- **Application / media content payload (`content`):** In self-hosted Uburoom, plaintext Plex/media fields (`title`, `subtitle`, `mediaId`, `mediaUrl`, `tracks`, `queueSummary`, `ending`). In future Cephalopod encrypted rooms, `content` can hold an opaque client-encrypted object (e.g., `{ ciphertext, nonce, keyGeneration }`) that `createRoomCoordinator` stores and relays untouched alongside the authoritative timeline.

---

## 4. Example: Initializing `shared/sync/` in Uburoom Cephalopod

Below is a realistic Node.js ESM example showing how a multi-tenant **Uburoom Cephalopod** worker/server imports `shared/sync/index.mjs` and wires tenant-scoped authentication, persistence, clock exchange, and room-scoped WebSocket delivery without importing `server/app.js` or any Plex/Discord/SQLite code:

```js
import { WebSocketServer } from 'ws';
import {
  createRoomCoordinator,
  createSubscriptionBroker,
  classifyMutationScope
} from './shared/sync/index.mjs';

export function createCephalopodSyncNode({ authService, roomRepository, quotaService }) {
  // 1. Create the room-scoped & tenant-scoped publication broker.
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
      if (client.subscribedRoomId) {
        const state = coordinator.snapshot(client.subscribedRoomId, client.actor, {
          viewerId: client.viewerId,
          tenantId: client.tenantId,
          envelopeOnly: true // Keeps `coordination` and opaque/encrypted `content` cleanly separated
        });
        client.ws.send(JSON.stringify({ type: 'state', roomId: client.subscribedRoomId, status: 200, value: state }));
      }
    }
  });

  // 2. Create the multi-tenant authoritative room coordinator.
  const coordinator = createRoomCoordinator({
    idPattern: /^[a-zA-Z0-9_-]{8,64}$/,
    isAdmin: (actor, room) => actor.tenantRole === 'tenant-admin' && actor.tenantId === room.tenantId,
    async authorize({ tenantId, room, actor, operation }) {
      return quotaService.allowsOperation(tenantId, room.id, actor.userId, operation);
    },
    async onPersist(room) {
      await roomRepository.saveRoomCheckpoint({
        tenantId: room.tenantId,
        roomId: room.id,
        epoch: room.epoch,
        revision: room.revision,
        position: room.position,
        duration: room.duration,
        paused: room.paused,
        content: room.content // Plaintext descriptor or opaque E2EE ciphertext blob
      });
    },
    onPublish({ tenantId, roomId, includeLobby }) {
      broker.notify({ tenantId, roomId, includeLobby });
    }
  });

  // 3. Attach a transport (e.g. WebSocketServer) provided by Cephalopod.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

  wss.on('connection', (ws, session) => {
    const client = {
      ws,
      sessionId: session.id,
      tenantId: session.tenantId,
      actor: { userId: session.userId, name: session.displayName, tenantId: session.tenantId, tenantRole: session.role },
      subscribedRoomId: undefined,
      viewerId: undefined
    };
    broker.add(client);

    ws.on('pong', () => {
      if (client.subscribedRoomId && client.viewerId && client.pingSentMono !== undefined) {
        coordinator.touchViewer(client.subscribedRoomId, client.viewerId, {
          tenantId: client.tenantId,
          rttMs: performance.now() - client.pingSentMono
        });
      }
    });

    ws.on('message', async raw => {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'clock') {
        const serverReceivedAt = Date.now(), receivedMono = performance.now();
        if (client.subscribedRoomId && client.viewerId) {
          coordinator.touchViewer(client.subscribedRoomId, client.viewerId, { tenantId: client.tenantId });
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
        client.subscribedRoomId = msg.roomId;
        client.viewerId = msg.viewerId;
        const snapshot = await coordinator.joinViewer(msg.roomId, client.actor, {
          viewerId: msg.viewerId,
          tenantId: client.tenantId
        });
        ws.send(JSON.stringify({ type: 'joined', roomId: msg.roomId, value: snapshot }));
        return;
      }

      if (msg.type === 'load-timeline') {
        // Coordinates an abstract timeline; `msg.content` may be opaque E2EE metadata.
        const outcome = await coordinator.loadTimeline(msg.roomId, client.actor, {
          tenantId: client.tenantId,
          duration: msg.duration,
          position: msg.position || 0,
          autoplay: msg.autoplay !== false,
          content: msg.content
        });
        ws.send(JSON.stringify({ type: 'response', id: msg.id, value: outcome }));
        return;
      }

      if (msg.type === 'ready') {
        const outcome = await coordinator.reportReadiness(msg.roomId, client.actor, {
          viewerId: client.viewerId,
          mediaVersion: msg.mediaVersion,
          ready: msg.ready,
          readinessVersion: msg.readinessVersion,
          tenantId: client.tenantId
        });
        ws.send(JSON.stringify({ type: 'response', id: msg.id, value: outcome }));
        return;
      }

      if (msg.type === 'command') {
        const outcome = await coordinator.executeCommand(msg.roomId, client.actor, msg.envelope, {
          tenantId: client.tenantId
        });
        ws.send(JSON.stringify({ type: 'response', id: msg.id, value: outcome }));
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
