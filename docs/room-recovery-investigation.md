# Room recovery and writer investigation

## Scope and authority

2026-11-07, baseline revision `262debbce4122ce0941116eb3107dd1358ce72e0`, Node v22.22.2 / Windows. The owner approved all three lifecycle fixes after the investigation below. They are implemented in the local working tree, uncommitted. No schema, configuration or new permanent smoke runner was added; existing lifecycle fixtures were extended.

All execution used isolated accounts/media, injected Plex implementations, temporary SQLite databases and disposable child processes. No production credentials/data, real Plex/Discord, deployment or live playback was used. Results are A source review and B isolated execution, not C integration or D acceptance. Commands and counts are in [testing](testing.md#m1-p13--recovery-preparation-ownership-and-writer-investigation--2026-11-07).

## Implemented lifecycle contract

- Preloads remain attached through admission and target checks. Ownership transfers only inside the transition's cleanup scope. Cancellation registers a tracked cleanup operation synchronously, including already-settled preparation promises; source/viewer outputs are reclaimed without permitting stale playback. Existing synchronous media release is preserved so HLS cache/lease teardown is immediate.
- `WatchRooms.capture` separates an allowlisted final snapshot from its serialized write. Removal records its cutoff time, waits for owned transitions/cleanup, then captures the resulting occurrence before pause, detachment and media teardown. A final save can persist that captured state after detachment; ordinary background saves still reject detached room generations. Explicit room Close clears recovery intent; server shutdown retains the existing participation/playing-intent fields. Streams, reporting IDs, commands and consent are never restored.
- `Watch` owns preparation, transition and cleanup promises independently of `transitionCommit`, which remains the durable receipt. Removal blocks new work, cancels uncommitted preparation and waits for its cleanup; an already-committing occurrence settles and is adopted before final capture. The existing deferred-checkpoint/successor-generation case still completes without a cycle.
- Owned preparation uses a 30-second operation signal. Server shutdown shares one 35-second drain deadline across its room/media/lifecycle waits. Provider/reporting cleanup and application database closure are attempted even when the final checkpoint fails. A provider ignoring cancellation beyond the deadline produces a failed shutdown result; available subsystems are closed, but that failure does not claim the offending operation was successfully drained. Normal real-provider cancellation/cleanup remains a live gate.

### Verification after implementation

The final full fixture run passed **544 tests, zero failures/cancellations/skips**. New or extended scenarios cover stale countdown ownership, exact cleanup of ready preloads, final disk bookmark and playing-intent capture behind a pending checkpoint, cancellation with a late output, an unfinished preload exceeding the drain deadline, provider/reporting/database cleanup after a failed final write, and Close waiting for canceled preparation. Existing commit-phase shutdown, deferred checkpoint, natural ending/autoplay, shared HLS and reporting scenarios remain covered. See [testing](testing.md#m1-p13--approved-shutdown-checkpoint-and-preparation-cleanup-fixes--2026-11-07) for actual commands and initial failures.

The disposable real-disk/child-process controls were repeated: shutdown/restart now retains **80 seconds**, while abrupt exit before commit still retains the original video at **25 seconds**, exit after acknowledgement retains the successor at zero, and a real changeset conflict still fences the failed transition without overwriting the injected external position. Original fixture key/account checks and SQLite integrity passed in all four cases. Fresh runtimes were paused with new media generations and no old viewers, reporting sessions or preloads.

The same short mixed-write sample repeated after implementation: four rooms/80 viewers, 480 synthetic observations and 48 queue/checkpoint receipts over 5.42 seconds, one 250 ms lock. Event-loop p95/p99/max **16.09/16.57/24.41 ms**; write-receipt p50/p95/max **12.21/281.92/282.99 ms**. Acknowledgements waited for the lock; integrity passed, no writer failure. These individual samples are not a controlled performance comparison or an endurance claim.

## Baseline reproductions (before fixes)

### 1. A stale countdown can orphan its prepared source and viewer outputs

Locations: `Watch.changeQueueMedia` in `server/watch.js`, specifically preload detachment before the `valid()` gate/target checks and before the `try/finally`; `Watch.snapshot` rotates the controller epoch when another host tab joins; `cancelAutoplay`/`dropPreload` clean up only the objects still owned by the room or explicitly supplied to cleanup.

Fixture procedure:

1. Complete the current occurrence through the existing queue API, unload it, and start the normal autoplay countdown for a pending item.
2. Let the actual preload methods prepare one source and one viewer output using injected media objects; wait for both promises.
3. Join another tab as the same authorized host with `Watch.snapshot`. Its controller epoch changes while the countdown still references the previous epoch.
4. Dispatch `media.next` through `Hub.dispatch` with the original countdown, as the autoplay timer does. The stale selection correctly returns `unavailable`.
5. Cancel the countdown. `room.preload` is already absent, the detached preload was never marked dropped, and neither its source nor viewer output received `stop`.

Explicitly supplying that detached object to `dropPreload` then stops both outputs, demonstrating that cleanup works when ownership is retained. The fixture establishes lost ownership/cleanup of prepared objects; it does not measure a real encoder/Plex process leak or its eventual upstream timeout. The playback authorization rejection itself is correct and must remain.

**Proposed fix:** Keep the preload attached through admission, then transfer ownership only inside a cleanup-protected preparation/adoption scope. Every rejected, canceled, failed or expired transition must retain a known owner until source/viewer cleanup has settled. Reuse the existing preload cleanup path; preserve host-tab/epoch and stale-command behavior. Do not repair this by permitting a stale countdown or assigning cleanup independently to every command path.

### 2. Orderly server shutdown skips the final room checkpoint

Locations: `Watch.close` and `Watch.remove` in `server/watch.js`; `WatchRooms.save` in `server/watch-rooms.js`.

`Watch.close` sets `shuttingDown`, then `remove` requests `save(room, {closing:false})` so restart participation/playing intent can be retained. `save` runs after an awaited previous save, while `remove` immediately removes the room from `watch.rooms`. The save's `!closing && room-is-no-longer-live` guard therefore returns before writing the final checkpoint. `closing` currently conflates permission to save a detached room with whether recovery intent should be cleared. `remove` also pauses live state before the asynchronous capture, so simply removing the guard would not safely preserve the final timeline/playing intent.

A disk fixture committed bookmark **25 seconds**, advanced its controlled room timeline to **80 seconds**, performed normal `Watch.close` and database close, then reopened the same database with the same original key/account. Disk and restarted room still contained **25 seconds**. A separate playing-clock fixture likewise retained its earlier bookmark instead of its current 80-second position. Periodic checkpoint timers were disabled to isolate the final save. In ordinary healthy operation the likely loss is the tail since the last periodic checkpoint (normally a five-second cadence), not necessarily the 55 seconds deliberately exposed here; writer delays can make that tail older.

**Proposed fix:** Capture a final lifecycle snapshot after transitions settle and before pausing, detaching or dropping media. Serialize its durable write with existing checkpoint writes. Distinguish explicit room Close (clear recovery intent) from server shutdown (retain permitted restart participation/playing intent), independently of whether the runtime room is still attached. Keep ordinary background saves fenced against stale/closed room generations. Persist only the existing allowlisted bookmark/participation/intent fields, never streams, reporting identities, commands or consent. Cleanup must still run if the final write fails, while the shutdown result reports the failure truthfully.

### 3. Shutdown can close the provider before queue preparation finishes

Locations: `Watch.changeQueueMedia`, `Watch.remove`, `Watch.close` in `server/watch.js`; application shutdown in `server/app.js`.

The existing `transitionCommit` promise covers the storage phase, not the preceding asynchronous source preparation. An injected provider held preparation of the pending video before that phase. With `mediaTransition === true` and `transitionCommit === undefined`, `Watch.close` resolved and the provider's `close` callback ran. Releasing preparation afterward caused the stale transition to return `unavailable` and invoke the output's `stop` **after** provider close.

The stale transition did not adopt or advance the queue. This proved shutdown/cleanup ordering at the room/provider boundary; it did not prove that a particular real fetch, Plex transcode or FFmpeg job survived application shutdown. Real implementations can honor cancellation and enforce their own deadlines. That dependency was absent from the baseline Watch lifecycle fixture contract.

**Proposed fix:** Track ownership of the complete transition from preparation through commit/adoption and final cleanup. Shutdown first prevents new work, cancels work that cannot be adopted, and drains bounded cleanup before closing the provider and storage. Preserve the durable commit receipt as a separate concept: broadening `transitionCommit` to include all preparation/generation could deadlock checkpoint saves that await it. Use existing operation cancellation/deadline machinery; do not introduce unbounded shutdown waits or a new scheduler/framework.

## Passing durability and recovery controls

Disposable child processes used the real SQLite worker and a retained original fixture key/account. The parent terminated only its own child process at the named boundary, then reopened the resulting database and instantiated a fresh runtime.

| Boundary | Disk result | Fresh recovery |
| --- | --- | --- |
| Worker commit blocked by a parent-held exclusive lock; process terminated while the in-memory queue had advanced | Original video current at 25 seconds; successor still pending; no history advance | Same account/key, fresh media generation, paused room, no viewers/reporting sessions/preload restored |
| Queue advance acknowledged, then process terminated | Successor current at zero; one archived prior occurrence; bookmark matches successor | Same account/key and fresh paused runtime without old viewers/streams/consent |
| Real changeset conflict introduced on the current entry's position | Entire queue advance rejected; external position 77 retained; original bookmark/current item retained; no partial history advance | Room-store failure fence rejected further operations before restart; the unchanged disk could be reopened |

All four disk cases, including orderly shutdown above, returned `PRAGMA integrity_check = ok`; fixture key hashes and canonical account UUIDs were unchanged. The deliberately conflicting external write is fault injection, not a supported multi-writer deployment. Speculative in-memory state after a failed write is not a rollback receipt; preserve the existing fail-closed fence rather than guessing which state to restore.

Existing recovery/queue/storage suites also passed, including delayed commits, shutdown during a storage-phase transition, readiness/missing-participant restart behavior, replay/permission checks, changeset conflicts and checkpoint ordering. Those scenarios do not cover the earlier preparation and final-snapshot boundaries reproduced here.

## Bounded writer/load measurement

One local run used **four rooms / 80 fixture accounts and viewers**, six synthetic sequential observations per viewer at approximately 1 Hz (**480 observations**), and **48 acknowledged queue-add/checkpoint operations**. It ran for **5.42 seconds**, included one **250 ms exclusive SQLite lock**, and used the real worker/memory mirror with injected media metadata. These are synthetic observations, not evidence of decoded playback. This is a short contention sample, not endurance, capacity certification or a comparison against another implementation.

| Measurement | Observed |
| --- | --- |
| Event-loop delay p95 / p99 / maximum | 16.16 / 16.67 / 29.15 ms |
| Queue/checkpoint receipt latency p50 / p95 / maximum | 14.53 / 275.99 / 277.52 ms |
| Acknowledgement during the held lock | Still pending at 100 ms; completed after release |
| Persistent history / database | 80 viewing records; 237,568 bytes; integrity `ok`; no writer failure |

The existing separate 16-paused-viewer/320-observation storage fixture measured event-loop p95 **16.49 ms**, maximum **17.25 ms** during the scoped baseline suite. The different workloads are not a speedup comparison. These measurements provide no reason to introduce speculative batching, schema changes or additional workers in this increment.

## Approved implementation and remaining gates

1. Preload ownership transfer and final-snapshot capture are implemented using the existing lifecycle APIs. Stale-command rejection, explicit Close/restart distinctions, per-viewer authorization and atomic queue/bookmark outcomes remain.
2. Preparation/teardown cancellation and draining are implemented with the existing operation machinery. Commit receipts remain separate; failure cleanup includes provider/reporting and database closure. No UI, schema, configuration or production change was made.
3. Existing lifecycle scenarios were extended, focused and full fixture suites executed, and the child-process commit controls and bounded load sample repeated. Actual results and remaining limits are in [testing](testing.md).
4. A commit, deployment, any request to the owner's Plex and every live test still require their respective explicit authorization.

Broader real Plex/Activity continuity, independent host/network/device checks, long-running resource accounting and perceptual acceptance remain open regardless of fixture results.
