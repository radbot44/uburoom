# Optional Cephalopod synchronization integration

This document preserves the multi-tenant adapter contract and potential encrypted-content boundary formerly mixed into [the self-hosted synchronization core](sync-core.md). It does **not** mean the self-hosted product supports end-to-end encryption or that future managed hosting work is approved. Validate external-service plans and their safety boundaries independently.

## 1. Coordination envelope vs. content payload (E2EE boundary)

Uburoom does not implement end-to-end encryption; self-hosted Uburoom operates as a trusted-server application that validates media entitlement server-side. However, `shared/sync/` maintains a strict separation between server-visible coordination state and content metadata so that Cephalopod can carry client-encrypted rooms without redesigning synchronization:

- **Server-visible coordination envelope (`coordination`):** `id`, `tenantId`, `transportSequence`, `epoch`, `revision`, `mediaVersion`, `streamVersion`, `observationEpoch`, `serverNow`, `startAt`, `pauseAt`, `waitingForReady`, `readinessVersion`, `readiness`, `visibility`, `roomRole`, `canPlayback`, `canManage`, `viewers`, `timeline` (`{ paused, position, duration, seekable }`), and `timing` (`{ serverReceivedAt, serverSentAt, serverProcessingMs, clockEpoch }`).
- **Application / media content payload (`content`):** In self-hosted Uburoom, plaintext Plex/media fields (`title`, `subtitle`, `mediaId`, `mediaUrl`, `tracks`, `queueSummary`, `ending`). In Cephalopod encrypted rooms, `content` can hold an opaque client-encrypted object (e.g., `{ ciphertext, nonce, keyGeneration }`) that `createRoomCoordinator` stores and relays untouched alongside the authoritative timeline.

---

## 2. Integration pattern: `createRoomCoordinator` & `createSubscriptionBroker`

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

### Tenant identity, ownership/billing, and cross-tenant room invitations

Cephalopod services must keep three identity and authorization concepts distinct:

1. **Global user identity (`userId`):** The authenticated person's canonical Cephalopod account identity across the service.
2. **Tenant ownership and billing (`tenantId`):** The organization or subscriber namespace that owns a room, governs storage/concurrency quotas and billing, and partitions `(tenantId, roomId)` durability.
3. **Individual room access:** Whether a specific authenticated `userId` is authorized to join, view, or control a particular room.

In cross-tenant invitation flows, a user whose personal account belongs to Tenant B can join an invited room owned and billed under Tenant A **only through a server-verified room grant** (for example, a Cephalopod-redeemed invitation record or room-scoped session grant verified on the server that binds that room context's authorized `tenantId` and `roomId` and validates ongoing access in `options.authorize`). Room invitations are unhandled by the core: `createRoomCoordinator` strictly enforces tenant isolation, never relaxes cross-tenant boundaries, and never allows clients to select arbitrary `tenantId` values.

---

## 3. Persistence contract and remaining Cephalopod host responsibilities

`createRoomCoordinator` enforces in-process per-room serialization and copy-on-write commit ordering around `onCreateRoom`, `onPersist`, and `onDeleteRoom`, while intentionally delegating database technology and cluster topology to its host service. Specifically:

- **Guaranteed by `createRoomCoordinator`:** each room's events are reduced one at a time in arrival order (an event submitted by an effect waits for the event that caused it); a state that asks to persist is committed only after `onPersist` resolves, and a rejection leaves the room unchanged with no effects; effects run only after commit; timers are armed from the committed state and arrive as `timer` events; rooms are created by the host (`createRoomState`) and registered with `add`, and `delete` drops pending events.
- **Remaining Cephalopod host responsibilities:**
  1. **Transactional storage & monotonic revision guards:** Cephalopod's `onCreateRoom`, `onPersist`, and `onDeleteRoom` implementations must execute atomic database writes partitioned by `(tenantId, roomId)` with optimistic revision guards (`WHERE tenant_id = ? AND room_id = ? AND revision < ?`) so split-brain or stale worker writes cannot overwrite newer checkpoints.
  2. **Wall-clock position checkpointing:** `onPersist` fires on discrete transitions, whereas playback between them is derived via `timelinePosition(room, now)`. For finer crash-resume granularity, read `coordinator.rooms` periodically and write bounded position bookmarks.
  3. **Durable deletion tombstones & payload retention:** `onDeleteRoom` must persist a durable closure tombstone and purge any associated encrypted/plaintext `content` blobs before resolving so closed rooms cannot be resurrected from earlier checkpoints after a restart.
  4. **Startup/lazy rehydration & safe crash recovery:** Skip tombstoned rooms; rebuild each active checkpoint with `createRoomState` (paused, at the checkpoint position, no viewers, a fresh `epoch` and process `clockEpoch`) and `add` it, so pre-crash command envelopes and client clock mappings cannot replay.
  5. **Ambiguous-commit reconciliation:** If a write's outcome is unknown, `onPersist` should reject; the room stays at its last committed state. Reload the authoritative record and replace the room (`delete`, then `add`) before resuming.
  6. **Single-owner residency, quotas & E2EE:** Horizontal scaling must route each active `(tenantId, roomId)` to a single authoritative worker/shard owner; connection authentication, WebSocket frame rate limits, per-tenant quotas, end-to-end `content` key exchange, and future server-verified cross-tenant room invitation grants remain Cephalopod service responsibilities outside `shared/sync/`.
