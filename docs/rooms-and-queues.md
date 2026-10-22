# Persistent rooms and playback queues

Status: implementation authorized, 2026-10-18. P13-1 through P13-5 are implemented: durable records, live lifecycle/Admin mode, manual/bulk queues, following/random generation, shuffle and cancellable autoplay. Local verification and remaining live gates are recorded in [testing](archive/testing-2026-10-22.md#bulk-queues-generation-and-cancellable-autoplay-p13-4--p13-5-2026-10-18). Roadmap phase: [M1-P13](../ROADMAP.md#m1-p13--persistent-rooms-and-playback-queues). This document distinguishes recorded product decisions, implemented primitives and later increments.

## Current review point: P13-1 through P13-5

The P13-6 mobile presentation now uses Room/Queue/Media tabs and the fullscreen Menu. Current playback has a Skip control. History Go back to restores that point by selecting a fresh occurrence, placing newer history/current playback at the front of Upcoming with fresh identities and zero positions, retaining older history and existing pending order. Unfinished targets resume; completed targets restart. The shared validated command is `queue.history.goBack` with entry identity and optional expected revision; capacity, role and preparation failures preserve the prior timeline. See [verification](archive/testing-2026-10-22.md#mobile-section-tabs-names-and-queue-return-controls-2026-10-19).

- `server/room-policy.js` defines creator > host > viewer capabilities, creator-only host assignment/creatorship transfer/permission management, role defaults, full participant permissions and administrator-principal configuration. Creator always has every capability; hosts inherit viewer grants. Viewers initially have only shared play/pause; personal player choices remain personal. Hosts initially have the ordinary capabilities except permanent deletion, which the creator/operator can grant.
- `server/room-store.js` persists named rooms, creator and explicit hosts, permission snapshots and allowlisted media bookmarks. It implements revision-checked edits, transfer to an existing host, deletion, host/admin-only restore data and paged reopen listings. Bookmark revisions are separate from settings revisions. Restored data is paused and contains no live streams, consent, viewers or pending commands.
- `server/room-queue.js` implements the flat ordered queue with concrete playable entries and occurrence UUIDs, bounded to `MAX_PENDING = 100`, optimistic concurrency via `queueRevision`, Play now interruption archiving to history with saved position, shared `media.next` queue consumption, `media.previous` restart vs history replay (< 5s), history replay (resume vs start over), history clear, and lightweight snapshot `queueSummary`.
- `server/watch-rooms.js` and `web/watch-rooms-ui.js` integrate durable room lifecycles with live Watch/WebSocket transports: named room creation, reopen from paged saved listings, room settings UI, host assignment, creator transfer, granular permissions, close for everyone, deletion, room-management independence from saved video availability (`bookmark.clear`), and queue checkpointing.
- `web/watch-queue-ui.js` and `web/watch-queue.css` provide a safe-DOM queue interface. Cards show chronological history to the left of an initially centered current video, then upcoming entries. Native/wheel scrolling, browsing arrows, keyboard arrows/Home and recentering support navigation. The remembered List layout shows current playback above history/upcoming columns, stacking on narrow panels. Authenticated artwork loads lazily with bounded concurrency and a shared-icon fallback; room changes abort requests and release cached images. Both layouts expose Play now/Skip to directly, top-right Move earlier/later and removal, history outcomes/resume/start-over/requeue, shuffle, autoplay/generation settings and confirmed clearing. Card moves smoothly follow the selected entry. Upcoming headers include estimated start delays; history and upcoming rows share height/typography. Older history loads in bounded pages. Queue/history revisions fence rendering so current playback and both lists update together. Explicit history replay consumes the selected row into a fresh playback occurrence while archiving the interrupted current video. Library tiles/detail cards retain Add to queue. Chrome/Firefox presentation checks pass; actual Plex/Activity continuity remains open.
- Active Admin mode is a server-owned callback to the store. It grants creator rights for any room, including private/closed rooms and host/permission management, without assigning membership or changing the actual creator. A command-body flag or unfinished asynchronous check grants nothing. Candidate administrator eligibility alone does not activate this override. Exiting Admin mode revokes access to private rooms.
- Configuration parsing covers `ROOM_HOST_PERMISSIONS` / `ROOM_VIEWER_PERMISSIONS` (comma-separated capability names, `all` or `none`; blank uses defaults) and `ROOM_ADMIN_DISCORD_IDS`, `ROOM_ADMIN_PLEX_IDS`, `ROOM_ADMIN_DISCORD_ROLE_IDS` (exact stable IDs). Verified provider identities are required; Discord role checks require fresh trusted guild membership, with role removal/shard gaps failing closed.
- The original P13 SQLite baseline was version 4 with `watch_rooms` (including `queueRevision`, persisted `autoQueue` and `autoplay`), `watch_room_hosts`, and `watch_queue_entries`. Existing private earlier state is rejected unchanged, not upgraded/reset. No production database was opened or transferred. Review a matched backup/manual transfer before deploying this baseline against retained state.
- Integration tests in `tests/durable-rooms.test.js`, unit tests in `tests/room-queue.test.js`, and browser UI flows in `scripts/room-ui-smoke.js` (Chrome and Firefox) verify restart recovery, paused progress, fresh epochs, consent reset, cohosts, Admin mode, queue add/move/remove, Next/Previous, history replay, delete confirmation, Up Next and History UI rendering, and library queueing across desktop, phone and theater layouts. The P13-3 verification baseline was **292 tests passed, 0 failures, 0 skips**; see the current verification entry for P13-4/P13-5 results.
- **P13-4:** Paginated show/season expansion commits atomically, deduplicating current/pending identities and optionally excluding room-completed history or Specials. Following appends one sequential successor as the queue runs low. Random draws from a show, movie library or collection without replacement; a new cycle starts after pool exhaustion, excluding active occurrences. Scope, cycle and used identities survive reopening. Existing pending order retains priority. Shuffle reindexes only pending occurrences.
- **P13-5:** Current-generation observations require at least two seconds of sequential decoded progress (half duration for clips shorter than four seconds), a recent near-end sample and an explicit ended report. The room clock alone never completes an occurrence. Autoplay defaults on with a ten-second countdown; pause, seek, queue edit/replacement, Cancel, role/epoch change, close or an empty room invalidates it. Turning autoplay off persists independently of generation mode. Countdown state and evidence remain ephemeral.
- Advancement prepares the next source under current authorization, then commits completion at full duration, next current, bookmark and generated successor in one transaction. The live player adopts the new generation after the writer acknowledges. Transition fences include media generation, room epoch, current/next occurrence IDs and queue revision. Failed preparation retains the entry and surfaces an error without automatic retry loops. Shutdown and checkpoints wait for pending transition writes.
- Supported bounds: 100 pending entries, 500 retained history occurrences, 20,000 catalog/expansion rows and 200 paged expansion requests. Oversized or incomplete expansion fails explicitly without a partial addition. No new dependencies or Plex watched-state writes.
- **Remaining:** P13-6/P13-7 real Plex multi-viewer/Activity continuity, broader UI review and measured resource/sync checks. Current local evidence does not certify those environments.

Next integration contract: build policy/configuration at startup; construct the store from the existing Accounts registry; supply a synchronous, current, server-owned Admin-mode predicate; authenticate and recheck installation/Plex eligibility before domain edits/restoration; fence checkpoints by the current live epoch before calling the internal checkpoint API. `get` is an internal read, not an authorized transport endpoint. Default and participant policies do not authorize reopening by ordinary viewers.

## Requested behavior

- Offer **Create room** and **Reopen room**, alongside joining an active room.
- Give each room a persistent identity and editable name. Closing preserves its queue and progress so an authorized host can reopen it later.
- Allow multiple explicitly assigned hosts. Its creator/hosts can reopen it; an authorized server administrator with Admin mode on has creator rights in any room.
- Preserve the current video and its position, upcoming entries and past entries, including closing partway through a video.
- Add movies, whole shows, seasons or individual episodes; reorder and remove queue entries.
- Offer auto-queue for following episodes and a random auto-queue mode.
- Plan independently verifiable increments, with owner review before implementation.

## Findings in the current program

| Area | Current behavior and implementation consequence |
| --- | --- |
| Lifetime | `Watch.create`, `refresh`, `leave`, `transfer` and `remove` in `server/watch.js` maintain process-local maps. Close, last-viewer departure, failed host succession and expiry remove the room. Same-tab reconnect has a 60-second grace, not durable restoration. Separate saving/closing from permanent deletion. |
| Limits | Creation allows four active watch rooms; reconnect rooms count toward that limit. Saved closed rooms must not occupy active playback capacity. |
| Host identity | `server/core.js` treats `hostId` as the host. `Watch.transfer` can elect an ordinary viewer. Explicit durable host membership must not be granted by automatic live handoff. |
| Privacy | `viewEligible` currently admits the current host or active administrator to private rooms. Explicit cohosts need eligibility without bypassing installation or Plex authorization. |
| Playback | `Watch.position` owns the shared timeline. Engine media load/next/previous prepare sources, release streams and coordinate readiness. Next/previous currently use Plex neighbors, not a queue. Reuse this path. |
| End detection | `Watch.refresh` clamps the room clock at duration and pauses. It neither consumes entries nor proves a viewer decoded the ending. Advancement needs a guarded transition. |
| Storage | At investigation, `server/storage.js` validated schema version 1. P13-1 extends the first-release baseline to version 2 without implicit private-state upgrades. `server/database.js` still uses the same in-memory mirror and bounded writer worker. Never serialize live room objects or write disk in the sync loop. |
| Acknowledgements | Socket responses already await storage flush; Discord can dispatch directly through the Engine. New durable domain actions must await commit themselves so all permitted callers receive the same guarantee. |
| Identity/history | Accounts have stable UUIDs and canonical merges. `server/playback-tracking.js` retains per-viewer decoded observations for 90 days/up to 5,000 records. Room bookmarks/history need separate durable records unaffected by that pruning. |
| Catalog | `server/plex.js` already browses shows/seasons, paginates children and resolves cross-season neighbors. Persist Plex server identity with item ID and revalidate access when used. |
| UI | The lobby already offers creation/joining from library Play. Library movies/episodes have Play; shows/seasons have browsing. `web/remote-ui.js` has a disabled Queue permission placeholder, not a queue implementation. |
| Shutdown | `server/app.js` closes sockets/rooms before storage. Capture progress before teardown changes pause state or removes the last viewer, and await the final checkpoint. |

## Proposed room lifecycle

A saved room contains its identity, name, owner, explicit hosts, policy, queue and resume bookmark. Opening it creates fresh live state in the existing maps. The saved record exists while open or closed.

1. **Create:** An eligible account names the room and chooses visibility. Commit it with the creator as owner and implicit host before reporting success. Names are display text, not authorization keys; duplicate names are allowed and ambiguous command targets remain rejected.
2. **Reopen:** List rooms the account created/explicitly hosts; active server Admin mode permits all rooms. Recheck current account, installation eligibility and current authority. One active opening per room: concurrent reopen requests converge on it, and an already open room offers Join. Room/Admin authority never grants Plex access.
3. **Restore:** Keep the stable room UUID but allocate fresh live epochs, media/stream generations and viewers. Re-resolve media with current Plex access, restore a clamped position and start paused. Time spent closed does not advance it. Resume follows normal per-viewer preparation/readiness after explicit Play.
4. **Leave:** Remove only that viewer; remaining viewers can continue under the agreed live-host policy. Label it separately from Close for everyone. The existing `close-room` button actually sends Leave.
5. **Close:** A creator, active administrator or participant with Close permission ends live viewing for everyone, commits the bookmark and retains the saved room. Revoke consent, invalidate commands/countdowns and release streams. Closed rooms are not remote command targets.
6. **Empty:** Recommended: freeze playback when the last viewer disappears, retain bounded reconnect grace, then save/close. Intentional last-viewer Leave can save/close immediately. Never consume a queue or extrapolate progress through empty-room grace.
7. **Restart/crash:** Closed rooms remain closed. Previously open rooms now use the bounded paused restart recovery described below. Streams, scheduled starts and countdowns never resume automatically. Graceful shutdown saves final state; crash recovery restores the last committed checkpoint with possible loss of the uncommitted tail.
8. **Delete:** A separate, confirmed action in room settings removes the saved room and its queue/history. Creator always has this authority; other roles require the explicit deletion capability, and active administrators have creator rights. Ordinary cleanup and Close must not delete records. Automatic retention follows the owner-approved inactivity and disposable-room policy below.

If media disappeared, the configured Plex server changed or access was revoked, retain the bookmark and report the problem. Offer authorized retry/replacement/removal. Never silently substitute an edition, skip an entry or fall back to owner credentials. Apply current room/catalog authorization to saved metadata and artwork as well as streams.

## Proposed hosts and permissions

### Implemented participant removal (owner decisions, 2026-10-21)

`kickParticipants` defaults to true for hosts and false for viewers. Stored policies lacking this new flag receive the same default when normalized; explicit false values and operator overrides remain respected. The example host-permission list includes it. The permission is editable under Room management and cannot be granted to viewers. No SQL schema change or private configuration migration is performed.

The validated `room.kick` command accepts a canonical account UUID. The leader and self are protected; authorized hosts can remove viewers, while the leader or active administrator may also remove hosts. It removes every current viewing tab and remembered disconnected view for that person, closes the affected subscriptions, stops their streams and fences their old viewing IDs across the reconnect window. An explicit rejoin uses a fresh viewing ID and is immediately allowed under the existing access policy. Host assignments are retained; kicking does not ban an account. Confirmation, current authorization, command expiry and target-role checks apply. Ban support remains deferred.

Distinguish **creator**, **explicit hosts** and **current live controller**. Disconnect does not transfer creatorship. Membership uses canonical account UUIDs, never usernames/provider IDs. Merging accounts must preserve access, deduplicate membership and prevent removed roles from reappearing through a retired UUID. Creator has all permissions, hosts have many by default and inherit viewer grants, and viewers initially share only play/pause. Full participant permissions is a one-action creation preset for all ordinary capabilities, not permission to assign hosts or transfer creatorship.

| Action | Proposed authority |
| --- | --- |
| Reopen | Creator/explicit hosts, or authorized administrator with Admin mode on; current installation eligibility remains required |
| Rename, choose media, edit queue, configure auto-queue, close/delete | Creator always; hosts/viewers according to room capabilities; active administrators override as creator |
| Grant/revoke hosts, transfer creatorship, change role permissions | Creator or active administrator; transfer target must already be an explicit host |
| Join/watch | Existing public/private policy; cohosts can join their private room, still subject to eligibility and Plex access |
| Participant queue edits | Separate Add to queue/Edit queue capabilities; default off for viewers, included in full participant permissions |
| Shared playback/picture | Existing separately shared permissions and remote-consent rules |
| Administration | Operator-configured Discord/Plex accounts or Discord roles can opt into top-bar Admin mode for creator rights in any room; no automatic mode activation, durable membership or implicit ownership transfer |

Prefer present explicit hosts for live succession. Without a creator/host present, pause unless viewers have Continue without host permission. A viewer with that permission remains a viewer: it does not grant reopen/host-management authority; queue/deletion actions still follow individual capabilities. Keep one live controller for readiness/voice-channel targeting; multiple cohosts' voice channels cannot all define the room's channel.

Role/visibility changes revoke ineligible subscriptions and invalidate pending work. Check roles and Plex scope again after awaited catalog/preparation operations, including bulk expansion and automatic advance. Room sharing never shares a host token.

## Proposed queue behavior

Use one flat ordered list of concrete playable entries. Add show/season expands to episodes with grouping/provenance for display; it is not a second player or recursively executable playlist.

- Each occurrence has a UUID. Media ID is not entry identity: replaying an episode must not overwrite previous progress/outcomes.
- Present **Now playing**, **Up next** and **History**. Keep occurrence position, start/end times and outcomes such as completed, skipped or interrupted. Removal is not evidence of watching.
- **Add to queue** appends without disturbing playback. In an empty active timeline, its first entry becomes current through the shared preparation/transition path, and starts only when Auto-play is enabled. **Play now** interrupts the current entry and preserves partial progress in History with Resume. Never silently clear upcoming entries.
- **Add show/season** offers all available episodes or episodes unfinished by this room, in Plex season/episode order. Specials are optional and current/upcoming duplicates are excluded. Historical episodes may be rewatched as new occurrences. This uses room history rather than silently importing Plex watched flags.
- Bulk add is not a subscription to future releases. Resolve all pages within bounds, show the count before unusually large additions, allow cancellation and commit the expansion atomically. Do not silently truncate shows.
- Reorder/remove pending entries using stable IDs and an expected queue revision. Moving pending entries cannot replace the current item. Explicit current removal stops playback, clears its bookmark and leaves other history/pending entries intact. Its forward arrow removes it while advancing, without archiving the discarded occurrence. Both require chooseMedia and editQueue and commit through the shared transition with stable entry/revision checks.
- **Next** consumes the next queued entry, recording a skip/position if the old entry was unfinished. Proposed **Previous** retains restart-current behavior after the existing threshold, otherwise replays prior room history as a new occurrence. Review before replacing Plex-neighbor navigation.
- Preserve completed entries and allow replay/Resume/Start over from history. A room bookmark takes precedence over a viewer's personal Plex resume for that occurrence.
- Room history is independent of native per-viewer observations and Plex watched state. It does not claim every viewer finished or enable Plex history/resume writes; those remain separately scoped M1-P4 work.
- Bound pending entries, expansion work and response size. Page queue/history rather than adding the whole list to every one-second playback snapshot. Set supported limits using fixtures/measurements and report explicit errors instead of silent eviction.

### Auto-queue versus automatic playback

Auto-queue chooses future entries; automatic playback decides whether to start them at the end. Keep these choices distinct even if presented together.

- Selection includes following episodes and random auto-queue from the current show, movie library or collection. Queue shuffle is a separate choice that selects only among queued entries, supporting a handpicked random pool. Persist the scope and selected successor across reopen. The detailed presentation of these choices is deferred to a later UI review.
- Following mode starts after the chosen episode and follows the agreed season/Specials order. Repeated refreshes, viewer joins and ending reports cannot append duplicates.
- A possible Play next toggle would let following/random continuation override pending queue order. The owner suggested this direction without settling the interaction; record it as a later UI/behavior decision, not an approved always-manual-first rule. Keep generation scope, queue shuffle and playback priority distinct in the implementation contract.
- Random should draw without repeats until its pool is exhausted. Save its chosen entry and remaining cycle state so reopening cannot reroll/repeat it. Review whether exhaustion stops or repeats, and whether room-history entries are excluded.
- Autoplay has an announced, cancellable countdown and can be turned off, followed by existing readiness when enabled. Exact duration/defaults can be settled with the UI. Pause, cancellation, queue replacement, role revocation and close invalidate it; empty/closed rooms cannot auto-start.
- A room clock at duration, an isolated browser `ended`, buffering, stale observations or seeking to the end must not alone mark completion. Require current room/media generation, valid playback intent and fresh validated ending evidence before automatic transition. Specify seeking/end behavior separately; completion does not imply every viewer watched.
- Advance through the shared validated handler with current host authority. Fence by live epoch, current entry, queue revision and media generation; recheck after awaits. Commit old outcome, new current entry/bookmark and generated successor together so duplicate ending reports or restart cannot consume twice.
- Preparation failure preserves the entry and reports the error. Do not silently skip media or loop indefinitely through retries.

## Storage and command design

Extend the existing SQLite schema/writer. No extra database, ORM, service, event bus or general-purpose persistence framework. Start with direct registry operations and a small queue module only where it owns real queue decisions.

Implemented room tables and the later queue table:

| Table | Durable data |
| --- | --- |
| `watch_rooms` | UUID, creator UUID, name, visibility, permissions, timestamps, settings/checkpoint/queue revisions, current media bookmark, generation scope/cycle state and autoplay setting. Current occurrence is uniquely indexed in the queue table. |
| `watch_room_hosts` | Implemented: room/account membership with foreign keys and account index; creator is an implicit host; canonicalize verified account merges when checking/revoking membership |
| `watch_queue_entries` | Occurrence/room UUIDs, pending rank, pending/current/history state, Plex server/item identity/type, safe display metadata, show/season/group provenance, position/duration, outcome/timestamps |

Use ordinary ordering integers/array moves and transactional reindexing of the bounded pending list. Avoid fractional ranks, event sourcing and linked lists without measured need. Enforce one current entry and no dangling reference.

Never persist viewers, sockets, access grants, stream/transcode URLs/leases, credentials, readiness acknowledgements, live clocks, pending commands, remote enablement or timers. Persist room settings through an allowlist. Restored sharing preferences still start with consent off.

Checkpoint authoritative shared position periodically and on pause/seek, item change, close and graceful shutdown. Proposed periodic target: five seconds, coalescing dirty rooms outside the sync tick; measure before promising it. Crash loss includes delayed writes as well as the checkpoint interval. Explicit name/role/queue edits and Close acknowledge success only after commit. Disk failure reports saving failure and prevents destructive advancement.

Use expected durable revisions and fresh live epochs for concurrent edits. Keep pending room operations bounded; stale requests refresh state rather than replay automatically. Catalog/disk work must not block the playback event loop. Closed-room operations need authenticated lifecycle entry points because the active Hub map cannot resolve closed rooms. Active queue/playback actions continue through the Engine; both paths share role checks and durability rules.

Extend socket allowlists/validation deliberately. Mutation bodies currently allow 4 KiB and socket messages 8 KiB: send show/season identifiers for server expansion, not thousands of client IDs. Page bounded responses and keep secrets out of snapshots/diagnostics.

Storage rollout is a separate gate. Current pre-release policy rejects changed layouts and implicit upgrades. Define the revised first-release baseline plus reviewed matched backup/manual transfer or explicitly approved reset for retained state. If a published baseline exists by implementation time, use an explicit forward migration. Preserve UUIDs, native history, ciphertext and exact original key; test older-code refusal and matched-state rollback. This proposal authorizes no migration/deployment.

`shared/engine.js` negotiates exact room/viewport revisions with the independent remote extension. Review [remote compatibility](remote-protocol.md) and matching fixtures before changing its command contract. Queue work does not authorize YouTube TV queue execution or a second queue engine in the remote repository.

## Interface flow

The follow-up room control pass (2026-10-19) puts active Join rows and Reopen/New directly in the video lobby, retains display modes independently of playback, and adds creator/admin-only Play/pause, Seek and Add to queue policy switches. Ordinary hosts retain read-only policy. Permissions is a compact grouped editor with mobile role tabs; People is one roster. Queue exposes autoplay and settings at the top, and auto-queue uses an authenticated source picker with actual titles. Empty playback, countdown timing and room-change feedback have explicit states; no room access model or persistence schema changed.

The 2026-10-19 room redesign uses Active rooms and Your rooms with a distinct New room form. Creation and Settings offer Host control (no participant permissions), Play/Pause (only participant play/pause) and Queue (all Playback and Queue permissions). Presets grant hosts everything except permanent deletion; participant continuity remains off. Settings saves preset clicks immediately and shows Custom only for nonmatching policies. Participant Room management permissions are always off, including for old saved policies and direct API edits. The retired picture flag is ignored when reading saved/configured policies and is absent from editable capabilities; picture commands retain fixed creator/host authority and existing remote-consent gates. No schema change or destructive data migration is required. Settings has General, People, Permissions, Playback & queue and Manage sections. Queue settings opens the same Playback & queue controls. Private remains creator/hosts only; invited viewers are a later feature. All rooms remain saved normally.

- Lobby: Create, Reopen and accessible active rooms to Join. Reopen cards show name, last activity, resume title/position and pending count, with a clear empty state and private listings.
- Room: name, live controller, authorized Hosts/permission management, distinct Leave/Close and separately confirmed permission-checked Delete. Preserve visibility and existing design assets.
- Library: Add to queue on movies/episodes and Add show/season on details, plus explicit Play now. A title selected before Reopen must not overwrite the saved current item; offer room resume or adding that title.
- Queue: current bookmark, editable upcoming list, history, generation source/mode and automatic-playback choice. Offer keyboard/move buttons alongside drag, stable focus, status feedback and explicit interruption/destruction.
- Verify normal/theater/fullscreen, narrow/mobile and real Activity against existing layout rules, safe DOM, themes and icons.
- Existing Discord playback controls follow agreed queue Next/Previous semantics. Review any new bot management commands separately; never bypass the Engine or publish private queue details into shared channels.

## Ordered increments and agent handoff

The owner authorized implementation after the initial review, including expanded permissions and the Admin-mode clarification. P13-1 is the first review point. Finish each increment's outcome/checks before its dependents; these are assignment boundaries, not instructions to spawn agents or implement everything at once.

Apply the [A/B/C/D verification standard](testing.md#verification-standard-for-new-work) to new P13 results: B for isolated persistence/queue/race fixtures, C for real Plex/Activity and operator state-continuity checks, and D only for claimed room/queue UX acceptance. Operator approval for retained data or deployed systems is separate from these methods.

| Increment | Outcome / main files | Depends on | Completion evidence |
| --- | --- | --- | --- |
| P13-0 | Record lifecycle/role/queue decisions and expanded administrator authority | Complete, 2026-10-18 | Owner authorized implementation; recorded decisions below |
| P13-1 | Durable records, permission/admin policy primitives, canonical account handling and schema strategy; room-policy/room-store/storage/sharing | Core implemented for review | Focused restart/locking/conflict/roles/concurrency tests; runtime integration/config activation and actual state transfer are not part of this completed core |
| P13-2 | Create/list/reopen/rename/hosts/save/close; watch/core/watch-operations/watch-socket/app/web | P13-1 | Durable room lifecycle, bookmarks, settings UI, save/reopen, close/delete, Admin mode integration; Chrome/Firefox smoke flow and integration tests passed |
| P13-3 | Manual movie/episode queue, occurrence history/bookmarks, shared Next/Previous, and Queue UI slice; room-queue/watch/watch-operations/watch-socket/watch-rooms/watch-queue-ui | P13-2 | Backend and UI slice complete: add/move/remove/clear/playNow/next/previous/replay/history-clear survive restart; Up Next, History, and library Add to queue UI verified in Chrome/Firefox smoke and full test suite (292 tests total) |
| P13-4 | Bulk show/season and following/random generation; Plex/queue module | Implemented | Paging/season/Specials corpus, overlap/rewatch policy, revocation/cancellation/limits/atomicity, persisted random cycle and manual priority |
| P13-5 | Natural-end evidence, countdown and durable single consumption; observation/readiness/queue paths | Implemented | Duplicate/stale endings, seek/buffering/pause/cancel, revoked role, empty room, restart during commit/preparation, disk failure; no double consumption |
| P13-6 | Lobby/room/queue/catalog UI; watch.js, proposed native queue UI module, watch-library, HTML/styles/affected remote renderer | P13-2 onward; deliver alongside usable backend slices | Chrome/Firefox flows, keyboard and rendered normal/theater/fullscreen/mobile; actual Activity evidence tracked separately |
| P13-7 | Full continuity/regression and operator docs; SPEC/AGENTS/upgrading/self-hosting/testing/protocol docs | Prior increments | Full suite without unexpected skips, isolated real Plex multi-viewer resume/advance, browsers/Activity, writer/sync/resource bounds, reviewed state-transfer procedure |

Regression anchors: `tests/watch.test.js`, `tests/watch-socket.test.js`, `tests/storage-worker.test.js`, `tests/accounts.test.js`, `tests/plex-library.test.js`, playback observation tests and `tests/remote-protocol.test.js`. Use Node's existing runner and isolated fixtures before authorized real-account checks. Record actual evidence and unfinished gates in [testing status](testing.md).

## Recorded owner decisions (2026-10-18)

1. The creator assigns/removes hosts and can transfer creatorship to another host. Hosts can perform most other room actions, governed by granular permissions.
2. Creator > host > viewer. Creator has all rights; hosts have many defaults; viewers initially have only shared play/pause. Creation offers full participant permissions in one action. Server operators can configure defaults and administrator principals by Discord user, Plex user or Discord role.
3. Server administrators opt into top-bar Admin mode, which gives creator rights over any room, including private and closed rooms. Turning it off removes the override without changing actual membership/creatorship.
4. Random auto-queue draws from the current show, movie library or collection. Queue shuffle is separate, to randomize a handpicked pending pool. More complicated UI/priority decisions are deferred to a later pass; Play next overriding the queue is a suggested direction to evaluate.
5. Bulk additions offer all available episodes or room-unfinished episodes, with optional Specials. Autoplay has a cancellable countdown and an off switch.
6. Leave preserves other viewers; Close saves and ends for everyone; empty rooms freeze then close after reconnect grace. Room settings include Delete.
7. Play now preserves the interrupted video in History with Resume. Without a creator/host present, playback pauses unless the relevant viewer permission allows continuation.

No additional product answer blocks this core. The implementation repeats exhausted random cycles, excludes active occurrences and uses a ten-second countdown with autoplay initially enabled. Later UI review may revisit presentation and the continuation override; P13-6/P13-7 retain the real-provider and Activity verification gates.

The queue UI follow-up uses portrait poster cards and one chronological List viewport centered on Now playing. Auto-play and Auto-queue are separate header toggles; enabling Auto-queue without a selected source opens Playback & queue settings. Individual history entries can be removed through the permission/revision-checked queue removal command; current entries require a separate explicit playback transition as described above.


Room creation offers visibility and permission presets with explanations, with Create room and its settings shortcut in the footer. The shortcut opens a local prospective room: general settings, custom permissions, Auto-play and an authenticated Auto-queue source can be configured before the single creation request persists the record. Closing settings returns to the creation form with that draft; opening a fresh creation flow discards it. Saved-room settings can edit Playback & queue while closed and offer Reopen room in their footer. Custom is always visible in Permissions and has no mutation of its own.

The Queue toolbar keeps Center Now Playing and the layout switch on one row. Timeline arrows carry nonzero “past” and “queued” counts in Cards and List; the first pending item is NEXT. Both viewports hide their scrollbars while retaining scrolling and arrow/keyboard navigation. List rows reuse the authenticated artwork cache for a blurred, darkened poster backdrop. History is subdued except on hover, focus or selection. Mobile tab changes retain the queue viewport, and media title links activate Media before opening the item.


## Room lifecycle and capacity upgrade (2026-10-20)

Owner-approved defaults: 50 saved rooms, 5 open rooms, inactivity deletion after 180 days while above 10 retained rooms, 20 people per room and 100 connected people installation-wide. Lobby presence counts and canonical accounts are deduplicated across tabs. Room leaders/settings-capable hosts can lower room capacity within the server ceiling. Reconnect leases reserve places briefly; limits reject additions instead of evicting existing viewers.

Rooms persist creation and last-access times separately from background update/checkpoint times. New rooms are disposable unless **Keep room when empty** is enabled. Empty rooms survive if kept, if a Now playing bookmark is below 90%, if upcoming items remain, or if auto-queue is enabled. Hosts/permissions/history alone do not retain them. The inactivity floor does not prevent disposable-room deletion. Single-room mode fixes the name to **Room**, retains it permanently and rejects renaming on the server.

The version-5 SQLite baseline adds last access, keep-empty preference, per-room capacity, allowlisted recovery intent/expected account IDs, and compact completed-item identities. A private explicit offline version-4 transfer is required for retained pre-release state; startup never upgrades or resets it. Existing transferred rooms are kept and start a fresh inactivity period because historical access times cannot be reconstructed. Preserve exact account/key/credential bytes and a matched backup before transfer.

Previously open rooms recover paused for 60 seconds after listen. Original participants may reconnect with fresh authorization. Automatic resume requires previously playing intent, every expected account returning before expiry, fresh readiness and a present authorized controller. Missing accounts leave playback paused; permitted Play/Start now ends recovery early. Fresh command/media epochs and consent-off rules remain. The normal readiness and host-continuity rules apply after expiry.

Queue/history defaults are independently 50/150 with no combined limit. Trimming visible history preserves random-cycle used IDs, sequential generation cursor and completed-item exclusions. Reset auto-queue progress lives in Playback & queue settings, requires queue-edit authority and leaves upcoming/history entries intact. Retention reasons appear below saved-room names; settings expose creation/last activity, people/capacity and Keep room when empty with a deletion warning when disabled.
