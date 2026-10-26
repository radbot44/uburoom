# Persistent rooms and playback queues

P13-1–P13-5 are implemented. P13-6 acceptance and P13-7 real Plex/Activity, load and retained-state verification remain open. See [roadmap](../ROADMAP.md#m1-p13--persistent-rooms-and-playback-queues) and [testing](testing.md).

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

Empty-room retention, inactivity/capacity defaults and single-room reset are defined in [self-hosting](self-hosting.md#rooms-and-directory). Retention is independent of completion evidence. Closed rooms consume no active playback slot.

Previously open rooms reserve recovery slots, return paused and admit original participants with fresh authorization. Auto-resume requires prior playing intent, all expected accounts back before expiry, fresh readiness and a present authorized controller; otherwise remain paused. No old stream or countdown is restored.

## Roles and permissions

Creator > host > viewer, using canonical UUIDs. Hosts inherit viewer grants; defaults give viewers play/pause and hosts ordinary controls except deletion/Add hosts. Management capabilities cannot be granted to viewers.

- Reopen requires explicit durable host/creator membership or active Admin, not merely effective All hosts status.
- Admin mode is a server-authorized opt-in granting creator rights without changing membership/ownership. A request flag or unfinished check grants nothing; exiting removes the override.
- Host addition/self-demotion and leader-only All hosts follow the [directory contract](account-names-and-host-directory.md#host-authority).
- Creatorship transfer targets an explicit host; single-room mode forbids it.
- Without a creator/host, pause unless Continue without host permits playback. This permission grants no management authority.
- Visibility/role changes revoke ineligible subscriptions and pending work. Private rooms require explicit assignments even with All hosts enabled.

### Participant removal

`room.kick` requires `kickParticipants` (default on for hosts, off/ineligible for viewers). Leader/self are protected; authorized hosts can remove viewers, leader/active Admin can also remove hosts.

Remove all target tabs, reconnect reservations and streams; fence old viewer IDs. Preserve host assignments. A fresh explicit rejoin is allowed immediately under current policy: this is removal, not a ban.

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

Auto-queue chooses future items; autoplay starts them. Following generates a sequential successor; random draws without replacement from show/library/collection, persists its cycle and repeats after exhaustion excluding active occurrences. Existing pending order wins. Shuffle affects pending items only. A proposed continuation-priority override is not implemented.

Autoplay defaults on with a ten-second cancellable countdown. Natural ending or explicit endpoint seek immediately archives the completed occurrence to history, clears the active bookmark, unloads the stream, and presents the stage interstitial. Queue edits during a countdown preserve the running countdown if the head next item is unaffected, restart the countdown if the head next item changes, and cancel it if no next item remains. Adding to an empty queue while idle at the interstitial starts the added item immediately. Pause/seek, cancellation, role/epoch change, close or an empty room invalidate the countdown. Natural ending requires current-generation decoded sequential progress (two seconds, or half-duration for clips under four seconds), a fresh near-end sample and ended evidence. Clock-at-duration or a stale ended event alone is insufficient.

An authorized seek to or beyond the endpoint explicitly finishes the current occurrence through the same completion/autoplay flow, without requiring decoder readiness at the endpoint or adding watched-time credit. With no successor it archives the completed occurrence, unloads playback, and displays the interstitial with recent history and continuation offers. With autoplay disabled and a successor, it unloads and presents the upcoming item on the interstitial until an explicit selection or play action. Play at that completed interstitial selects the successor under video-selection permission or play/pause when idle; it does not restart the completed occurrence. Use Restart or history replay to watch it again.

Prepare the successor under current authority, recheck fences, then atomically commit old outcome, next occurrence, bookmark and generated successor. Live state adopts the committed generation. Preparation/storage failure reports an error without consuming entries, skipping media or retry loops.

## Persistence and concurrency

Use existing SQLite tables/mirror/writer; no separate database or persistence framework. Room, checkpoint and queue revisions are independent. Enforce one current occurrence, contiguous pending ranks and canonical memberships.

Checkpoint shared progress outside the sync tick and on lifecycle changes. Durable edits/Close acknowledge only after commit; shutdown waits for transitions. Fence awaits with live epoch, media/stream generation, occurrence IDs and expected revisions. Stale operations refresh rather than replay.

Page queue/history separately from frequent playback snapshots. Bound catalog expansion and socket messages; send show/season IDs rather than thousands of client entries. Protect saved metadata/artwork with current access checks.

Schema/transfer rules belong in [upgrading](upgrading.md). UI presentation belongs in [design](design-guide.md). Verify concurrent reopen/edit, crash/disk failure, duplicate endings, revocation, queue recovery and real mixed-viewer playback before broader claims.
