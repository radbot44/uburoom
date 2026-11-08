# Persistent rooms and playback queues

Uburoom persistent rooms and playback queues provide crash-resilient playback state, bounded preparation, sequential history, and configurable auto-queueing backed by SQLite. The room lifecycle enforces shutdown checkpoint capture, retained preload ownership, and bounded preparation and cleanup draining.

## Room lifecycle

| Action | Contract |
| --- | --- |
| Create | Commit stable UUID, name, creator and policy before success; names are not authority and may repeat |
| Reopen | Creator/explicit host or active Admin; recheck admission, converge concurrent opens, re-resolve media, restore committed bookmark paused with fresh epochs |
| Leave | Remove only this viewer; remaining playback follows current permissions |
| Close | Save and end for everyone; distinct from deletion |
| Delete | Confirm and check deletion authority; remove room/queue/history |
| Crash/restart | Restore committed state, never streams, commands or consent; uncommitted tail may be lost |

Missing media/access retains the bookmark with an error and authorized retry/replacement/removal. No silent edition substitution or queue skipping. Room authority does not imply Plex access.

Empty-room retention, inactivity/capacity defaults and single-room reset are defined in [self-hosting](self-hosting.md#rooms-and-retention). Playback in progress (< 90% of duration) retains an empty room; completed or idle rooms without keep-when-empty or single-room protection are reclaimed during cleanup. Room retention is independent of PMS personal watch-state reporting. Closed rooms consume no active playback slot.

Previously open rooms reserve recovery slots, return paused and admit original participants with fresh authorization. Auto-resume requires prior playing intent, all expected accounts back before expiry, fresh readiness and a present authorized controller; otherwise remain paused. No old stream or countdown is restored.

## Roles and permissions

Creator > host > viewer, using canonical UUIDs. Hosts inherit viewer grants; defaults give viewers play/pause and hosts ordinary controls except deletion/Add hosts. Management capabilities cannot be granted to viewers.

- **Add hosts** is a host-only capability (`addHosts`), off by default. Authorized hosts can assign known accounts or exact provider subjects but cannot remove other hosts or pending grants. Removal belongs to the room leader or an active administrator; explicit hosts may relinquish their own role (`host.leave`) with a warning about lost private/closed-room access.
- **All hosts** is persistent, reversible, and controlled only by the actual room leader (`userId === room.creatorId`)—even an administrator cannot toggle it. It makes admitted members effective hosts without creating persistent assignments. Presets preserve the mode; disabling it restores explicit roles. Private entry and reopening still require explicit assignment (`assigned()`) or active Admin authority. Relinquishing an explicit role while All hosts is active does not remove the mode-derived role.
- **Reopen** requires explicit durable host/creator membership or active Admin, not merely effective All hosts status.
- **Admin mode** is a server-authorized opt-in granting creator rights without changing membership/ownership. A request flag or unfinished check grants nothing; exiting removes the override.
- **Creatorship transfer** targets an explicit assigned host; single-room mode forbids it.
- **Without a creator/host**, playback pauses unless Continue without host permits it. This permission grants no management authority.
- **Visibility and role changes** revoke ineligible subscriptions and pending work. Private rooms require explicit assignments even with All hosts enabled.

### Participant removal

`room.kick` requires `kickParticipants` (default on for hosts, off and ineligible for viewers). Leader and self are protected; authorized hosts can remove viewers, while the room leader and active administrators can also remove hosts.

Removal tears down all target tabs, reconnect reservations and active streams, and fences old viewer IDs in `room.kickedViewers` for the reconnect window (60 seconds). Host assignments are preserved. Rejoining rules depend on participant type:
- **Ordinary admitted members** in public rooms are removed but may rejoin immediately with fresh authorization; removal is not a permanent ban.
- **Invited members of private rooms** have their invite revoked (`DELETE FROM watch_room_invites`) and their account blocked in `watch_room_invite_blocks` (`user:<uuid>`). They cannot rejoin until re-invited or until the invite code is rerolled.
- **Guest sessions** have their session ended immediately (`endGuestSessions`), and both their account (`user:<uuid>`) and browser marker (`device:<hash>`) are recorded in `watch_room_invite_blocks`. They cannot rejoin until a host rerolls the room invite code.

## Queue and history

Use a bounded flat list of concrete playable occurrences, each with its own UUID, not media ID as identity. Keep Now playing, Upcoming and History distinct.

- Add appends without interrupting; the first item in an empty timeline becomes current and starts only if Auto-play is enabled.
- Play now archives interrupted progress; Next consumes pending order. Previous restarts current after the threshold or replays prior history. Explicit replay uses a fresh occurrence.
- Go back to restores the chosen historical point, prepending newer history/current items as fresh zero-position occurrences. Unfinished target resumes; completed target restarts. Failed authority/capacity/preparation leaves the timeline intact.
- Reorder/remove by stable IDs and expected queue revision. Removing current requires explicit discard/stop or discard/advance, with both selection and edit authority; discarded current is not archived.
- Bulk show/season expansion is atomic, paginated and bounded; exclude current/pending duplicates, optionally Specials and room-completed items. Never silently truncate or subscribe to future releases.
- Bookmarks outrank personal Plex resume for the room occurrence. Room completion/history never claims every viewer watched and never enables Plex reporting.
- History trimming/clearing preserves compact completion and generation progress. Explicit Reset auto-queue progress clears those separately.

## Auto-queue and autoplay

Auto-queue chooses future items; autoplay starts them. Auto-queue is a standing rule (`off`, `continue`, `following` / "In order", or `random` / "Shuffle", defaulting to `off`) that maintains at most one persisted preview item (`autoQueue.next` in `watch_rooms.autoQueue`) at the tail of Upcoming rather than inserting `'pending'` rows into `watch_queue_entries`. `continue` dynamically follows the last TV episode in `[current, ...pending]` (or recent history when idle) to offer its next sequential episode without a fixed source scope; `following` uses a fixed show source in episode order; `random` draws one item without replacement from a show/library/collection source, persists its cycle and used pool, and repeats after exhaustion excluding active occurrences. Manual additions always append to `pending` ahead of `autoQueue.next`; `queue.shuffle`, `queue.clear`, `queue.move`, and `maxPending` apply only to `pending` rows. `autoQueue.next` materializes directly into `'current'` only when advancing (`media.next`, autoplay countdown completion, or `queue.auto.playNow`) with an empty `pending` list, or converts into a regular manual `'pending'` row when pinned (`queue.auto.pin`). Turning auto-queue on in an idle room with Auto-play enabled immediately materializes `autoQueue.next` and starts playback.

Autoplay defaults on with a ten-second cancellable countdown. Natural ending or explicit endpoint seek immediately archives the completed occurrence to history, clears the active bookmark, unloads the stream, and presents the stage interstitial. Queue edits during a countdown preserve the running countdown if the head next item is unaffected, restart the countdown if the head next item changes, and cancel it if no next item remains. Adding to an empty queue while idle at the interstitial starts the added item immediately. Pause/seek, cancellation, role/epoch change, close or an empty room invalidate the countdown. Natural ending requires current-generation decoded sequential progress (two seconds, or half-duration for clips under four seconds), a fresh near-end sample and ended evidence. Clock-at-duration or a stale ended event alone is insufficient.

An authorized seek to or beyond the endpoint explicitly finishes the current occurrence through the same completion/autoplay flow, without requiring decoder readiness at the endpoint or adding watched-time credit. With no successor it archives the completed occurrence, unloads playback, and displays the interstitial with recent history and continuation offers. With autoplay disabled and a successor, it unloads and presents the upcoming item on the interstitial until an explicit selection or play action. Play at that completed interstitial selects the successor under video-selection permission or play/pause when idle; it does not restart the completed occurrence. Use Restart or history replay to watch it again.

Prepare the successor under current authority, recheck fences, then atomically commit old outcome, next occurrence, bookmark and generated successor. Live state adopts the committed generation. Preparation/storage failure reports an error without consuming entries, skipping media or retry loops.

## Persistence and concurrency

Use existing SQLite tables/mirror/writer; no separate database or persistence framework. Room, checkpoint and queue revisions are independent. Enforce one current occurrence, contiguous pending ranks and canonical memberships.

Checkpoint shared progress outside the sync tick and on lifecycle changes. Durable edits and Close acknowledge only after commit; shutdown waits for transitions. Fence awaits with live epoch, media/stream generation, occurrence IDs and expected revisions. Stale operations refresh rather than replay. In-flight room operations use a bounded 30-second abort signal to prevent stalled external dependencies from hanging the server loop.

Final removal captures the resulting occurrence at the removal cutoff, before pausing/detaching its runtime state, and serializes that allowlisted snapshot behind earlier checkpoints. Explicit Close clears restart participation/intent; server shutdown retains those existing fields. Ordinary deferred saves cannot resurrect detached rooms. Operation ownership covers preparation and cleanup independently of the durable commit receipt, so Close can cancel uncommitted work and wait for outputs to be released without creating a checkpoint cycle. Cleanup is resilient: room detachment and resource cleanup proceed even if a final checkpoint persistence step fails or errors. Shutdown uses one 35-second drain deadline (`mediaDrainMs = 35000`) and attempts provider, reporting, and database closure on failure; an operation ignoring cancellation beyond it makes shutdown fail rather than claim complete cleanup.

Page queue/history separately from frequent playback snapshots. Bound catalog expansion and socket messages; send show/season IDs rather than thousands of client entries. Protect saved metadata/artwork with current access checks.

Schema/transfer rules belong in [upgrading](upgrading.md). UI presentation belongs in [design](design-guide.md).
