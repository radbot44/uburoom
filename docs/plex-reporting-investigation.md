# Plex reporting investigation

Decoupled session reporting, shared-producer stop safety, activity-only default with personal watch-state opt-in, and sponsored viewer isolation are implemented on `main` (`server/plex-reporting.js`); see [accounts and reporting](accounts-and-access.md#plex-activity-and-viewer-attribution) for the current contract and [testing](testing.md) for evidence and remaining live PMS/Tautulli gates. The owner approved viewing continuity on 2026-11-07; it is implemented on main. Address forwarding remains deferred. The later sections preserve the historical 2026-10-19/20 investigation; its original implicit-fallback recommendation is superseded.

## Viewer addresses and viewing continuity — 2026-11-07

### Address forwarding: risk and evidence

**Risk first:** If PMS uses a forwarded viewer address as its remote address, uburoom viewers can become remote streams for Plex policy. The owner's remote streams per user, remote bandwidth budget and per-stream quality limits may then apply, changing playback decisions or refusing streams. This is more than a display change. Plex documents the [remote-stream count and local-network distinction](https://support.plex.tv/articles/200430283-network/) and [bandwidth/transcoding limits](https://support.plex.tv/articles/227715247-server-settings-bandwidth-and-transcoding-limits/). Whether each policy is triggered by reporting alone is unverified. Do not implement forwarding before the owner accepts this risk.

**What public evidence establishes:** A [first-hand Plex forum experiment](https://forums.plex.tv/t/native-support-for-x-forwarded-for-proxy-protocol-for-client-ip-detection/944016/6) on PMS 1.43.5.11029 reports that `X-Forwarded-For` is honored through private/loopback peers, selecting the rightmost non-private address across the header and TCP peer. All-private chains reportedly retain the peer address; public peers are not trusted. Earlier posts show a request-parser log and matching session/Tautulli public IPv6 address. These are version-specific user observations, not an official compatibility guarantee or evidence for uburoom's exact requests. No equivalent support was established for `X-Real-IP`, standard `Forwarded`, or PROXY protocol. The current [PMS API reference](https://developer.plex.tv/pms/) does not document forwarded-address handling.

**Tautulli's boundary:** Its own [PMS session parser](https://github.com/Tautulli/Tautulli/blob/master/plexpy/pmsconnect.py) reads `Player.address`, `remotePublicAddress` and `local`, plus `Session.location`. Sending a header to Tautulli's web server would not fix Plex activity attribution.

**uburoom's boundary:** `clientAddress` in `server/plex-delivery.js` already normalizes mapped IPv4 and accepts validated proxy IP headers only when uburoom's immediate peer is local/private. This is a network trust assumption, not authenticated proof of the viewer's address: private peers can supply headers. `server/watch-operations.js` assigns the result to `viewer.remoteAddress`; HTTP and WebSocket entry points use the same helper. `PlexReporting.enqueue` currently sends only the Plex client/session identity headers, and `Plex.request` does not add forwarded-address headers. The generic request method can carry an explicitly supplied header, as verified using an injected fetch fixture; that proves transport plumbing only.

**Reporting versus streaming:** A single normalized viewer address could be attached to that viewer's timeline reports without changing the reporting/transcode identity separation. Forwarding on stream requests is a separate scope: `Plex.transcodeParams`, decision/start, pooled HLS fetches, proxied file/segment requests and local-conversion source reads do not all belong to an individual viewer. One shared producer cannot truthfully have several simultaneous viewer source addresses. Do not put a mutable viewer address on cached account scopes, the global Plex client, or shared producer requests. Browser-direct delivery has its own network peer. A reporting-only experiment must establish whether timeline headers alone change `Player.address`, `local` and stream policy; it cannot justify forwarding on all stream paths.

**Conclusion:** `X-Forwarded-For` is a credible candidate for public viewer addresses over the current loopback topology. Its effect on uburoom reporting, Vigrid's installed PMS version, private viewer addresses and stream limits remains unknown. No request to Vigrid/PMS, live test, configuration change or forwarding implementation was made for this follow-up.

### Baseline causes of split viewing sessions

Source review and isolated execution on `9798cab5684caa3876549bb6670dcf98a4308e64` identify independent causes:

- `PlexReporting.observe` ends the occurrence on any `streamVersion` or `observationEpoch` change as well as media changes. The existing reporting fixture explicitly expects a new identity for stream rotation.
- `Watch.replaceViewer` and local delivery preparation call `reporting.end(..., 'stream-changed')`; direct/proxy delivery changes also end reporting in `server/watch-operations.js`.
- `PlaybackTracking.expire` resets the observation epoch after a five-second observation gap; `Watch.refresh` then ends reporting with `observation-timeout`.
- Viewer presence expires after ten seconds. `Watch.refresh` preserves eligible reconnect settings for the existing 60-second `RECONNECT_GRACE_MS`, but immediately ends reporting and removes the old viewer object. A reconnect creates another object, epoch and stream.

The disposable reporter fixture reproduced two identities and `playing → stopped → playing` for stream rotation, epoch rotation, explicit stream/delivery changes, observation timeout and disconnect/replacement. Real leave and a new media occurrence behaved the same, correctly for those controls. This establishes uburoom's request behavior, not how many rows a particular PMS/Tautulli version persists.

### Approved reporting architecture — implemented

**Owner decision, 2026-11-07:** Implement viewing continuity independently of address forwarding; defer forwarding and live tests. `PlexReporting` now owns a viewing occurrence and its stable Plex client/session identity. The occurrence belongs to the same authorized viewer/tab, room instance, verified Plex subject/server and version-qualified video occurrence (`mediaVersion`). A stream or observation epoch is only the current attachment to that occurrence. The reporting identity remains permanently distinct from every `transcodeId`; duplicate tabs and different video occurrences stay separate, even when the title is the same.

1. Centralize active, suspended and terminal lifecycle policy in the reporter. Treat stream/delivery replacement, observation timeout and an eligible short disconnect as suspension, preserving identity. Bind the next accepted observation to its new viewer object/stream/epoch after checking the same occurrence and present authority. Retain all existing observation validation; never reuse old observations, credit the missing interval, or advance position from room time.
2. Bound suspension by the existing reconnect grace and the actual reconnect record's expiry; stream recovery also has a finite deadline. Continuity reports use `buffering` at the last accepted position, omit `duration` during the gap and stop when the deadline expires. They never claim continued playing or personal watch progress. PMS may still expire activity despite stable headers, so one Tautulli row remains a live verification gate.
3. Preserve stale-work fencing separately from occurrence identity. Capture the attachment generation with each queued desired report; discard obsolete queued observations after an await. Recheck verified subject/server, current credentials, consent and room/viewer ownership at dispatch. An already-dispatched request cannot be recalled; serialize its completion before terminal teardown/replacement.
4. Explicit leave, video replacement/replay, completion, activity opt-out, kick, revoked access, room closure and shutdown terminate the occurrence. Authorization loss must not fall back to owner credentials. Terminate suspended occurrences too: current room cleanup often iterates only active viewers, and explicit leave can target a saved disconnected viewer. Expired/evicted reconnect records must not leave reporting alive. Never persist reporting continuity across a process restart or restore old consent for a fresh join.

Integration changes supply the reporter with actual reconnect eligibility/expiry and room/viewer terminal lifecycle events, including disconnected viewers. The reporter owns classification, attachment changes, deadlines and cleanup; quality, track and fallback paths do not independently preserve/recreate Plex IDs. `server/watch.js` supplies lifecycle events and authorization; `server/watch-operations.js` supplies a credential check independent of the socket's connected state; `server/watch-http.js` removes saved reconnect viewers on logout/account invalidation. The callback is documented in `server/types.js`. Fallback behavior and local tracking's observation/credit rules were not changed.

**A/B verification:** Extended existing reporting, room, account/logout and real loopback socket fixtures. They cover quality/delivery rotation, observation reset, a recreated viewer inside/outside grace, explicit leave during suspension, media occurrence change, duplicate tabs, opt-out/authorization denial, subject/server changes, delayed authorization/requests and shutdown. Assertions establish stable reporting headers without intermediate `stopped` for recoverable changes, finite cleanup, new identity at terminal boundaries, current consent and producer isolation. The final full fixture suite passed 539 tests with no failures/cancellations/skips; commands, the corrected legacy expectation and limitations are in [testing](testing.md). This is not real PMS/Tautulli acceptance.

**Separate live gate:** After fixtures, present a concrete bounded experiment for owner approval before every live test and every request to the owner's Plex, including read-only discovery/baselines. For address support, separate timeline-only and individually owned stream-request experiments; compare header-off/on session address/local/location, decisions/limits and exact account/item identity. For continuity, compare PMS session keys and ungrouped Tautulli history through quality/reconnect/leave, plus consent-scoped personal-state read-back. Stop on changed policy, ambiguous identity or unexpected writes. Implementation approval is not permission for these experiments, deployment, history cleanup or a commit.

## Conclusions

Keep **Plex activity**, **personal resume/watched/history**, and **uburoom viewer observations/history** separate. HTTP 200, segment delivery or a running encoder proves none of the other outcomes.

- A verified Plex account can report observed playback under its own identity.
- Omitting timeline duration preserved activity without further personal-state writes in the tested Original/HLS/AV1 cases. This is empirical, version/path-specific behavior.
- Matching playback-session identity fixed isolated HLS classification, but a linked stopped report also terminated the encoder during this investigation; production reporting on `main` decouples `viewerSessionId` from `transcodeId` so viewer teardowns never stop shared HLS jobs.
- PMS ignored external AV1 output declarations; truthful AV1 delivery telemetry belongs in uburoom unless a supported PMS association is established.
- Sponsored/guest viewers have local identities, not invented Plex accounts. Source activity and side effects require separate validation; never write owner personal history for them.

## Identity and protocol

| Identifier | Purpose |
| --- | --- |
| Verified Plex token/subject | Personal reporting authority |
| Source/producer credential | Entitlement for upstream bytes; may differ from consumer |
| X-Plex-Client-Identifier | Actual viewer client |
| X-Plex-Session-Identifier | Playback occurrence, consistent across decision/start/timeline |
| Transcode session parameter | Encoder job; distinct from client and occurrence |
| uburoom UUID/viewer/stream epochs | Local identity, observations and stale-work fencing |

Client/device labels cannot create a Plex user. Separate temporary transport delegation from reporting credentials.

The [Plex API](https://developer.plex.tv/pms/) documents timeline states `buffering/playing/paused/stopped`, millisecond position and periodic/state-change reports. Scrobble explicitly marks played but does not itself create view history. Read back `/status/sessions`, user metadata and `/status/sessions/history/all?metadataItemID=…`; use proper pagination and exact user/item/client matching.

HLS preparation may temporarily PUT audio/subtitle part preferences even with reporting off. The local lock/check/restore cannot eliminate external-app races. Playback probes therefore require consent for these effects too.

## Live Original-mode follow-up (2026-10-19)

Dedicated consenting account/movie; PMS **1.43.0.10231-ca3956848**, Chrome, Original MP4/H.264 2160p/AAC, duration **716.542s**. Isolated loopback/SSH path; owner credential used only for read-only observation. No production application/configuration changes.

| Probe | Observation |
| --- | --- |
| ~40s without reports | ~1,200 decoded frames; no matched activity; personal state unchanged |
| ~40s with timeline | Exact user/client activity in PMS and Tautulli; stopped cleared it; short run showed no saved-state change |
| 90s including 3s pause | ~87s advance/~2,611 frames; saved resume became 86.975s and lastViewedAt changed |
| History/control | viewCount stayed 0, correctly filtered movie history empty, owner metadata/audio unchanged |

An initial unsupported history filter was invalid evidence; corrected item-filtered queries established the narrower result. Native Plex Dashboard UI was not separately inspected. The created test resume was retained. A short no-write result does not prove activity-only behavior.

## Activity-only reporting and personal state separation

Keep actual token, `ratingKey`, metadata `key`, position, state and client identity; omit **duration** on every timeline state.

| Candidate | Result |
| --- | --- |
| Omit ratingKey, keep key | **Rejected:** deeper read-back attributed a different collection/title despite correct user |
| Keep both item IDs, omit duration | ~90s plus pause/resume/stop retained resume 86.975s, viewCount 0, lastViewedAt and empty matching history |
| Same-client sync on → off → natural ending | Sync-on advanced resume to 601.180s; after opt-out playback reached 716.554s while that state stayed frozen; ~3,795 frames over the final ~126.5s |

Correct movie/account/position remained visible in PMS/Tautulli; stopped cleared activity. This was an ending segment, not a full-title soak.

Fresh no-duration responses said `playbackState: ignore`; same-client responses could still say `progress` after writes stopped. **Do not use that response field as a persistence capability test.** Account-attributed PMS logs were observed; persisted aggregate usage counters were not established. Tautulli history is not Plex personal history.

## HLS and AV1 separation follow-up (2026-10-20)

Same account/movie/server, separate ~20s no-report controls, reporting runs starting at 590s, duration omitted after 610s. Fresh per-run baselines were used.

| Delivery | Decoded outcome | State after opt-out |
| --- | --- | --- |
| HLS H.264/AAC, 2Mbps ceiling | 3,972 frames; natural end 716.602s | Resume frozen 602.569s; count/lastViewed/history unchanged |
| Local AV1/Opus 1280×720 | 3,813 frames; buffer ended ~716.500s; explicit stop required | Resume frozen 601.855s; count/lastViewed/history unchanged |

Owner state/audio stayed unchanged. Single-audio/no-subtitle media did not test preference mutation/restoration. Initially both activity cards described original 4K Direct Play rather than delivered output. AV1 stopped ~42ms short; later code fix `3a1100e` adds end-of-stream/probe recovery with automated evidence, **real natural-ending retest remains open**.

## Plex delivery association investigation (2026-10-20)

### Isolated HLS association

Consistent playback-session identity across decision/start/timeline attached actual Session, TranscodeSession and output Media. PMS/Tautulli then showed hardware H.264, AAC direct stream, MPEG-TS/HLS, **720×404**, ~**1.5Mbps**, under a 2Mbps ceiling.

Fresh ~50s and ~40s confirmations omitted duration; the latter kept viewer-client, playback-occurrence and encoder-job IDs distinct. `hasMDE` alone did not create linkage. Personal resume remained 601.855s, viewCount 0, other metadata/audio/history unchanged.

### Shared-producer failure

Linked stopped timeline terminated its HLS job: PMS logged **Client stopped playback**, subsequent pings returned 404 before the helper called producer stop. Later phases of that terminated experiment are not valid independent comparisons.

Stopping under an unrelated playback-session ID preserved the job **but left the original activity playing**. Exact matched cleanup removed it. A later setup refused overlap with that stale entry and decoded nothing. Neither workaround establishes safe pooled reporting.

### External AV1

A real ~50s AV1 run sent truthful codec/container/protocol/decision/dimension fields and `hasMDE=1`, without duration. PMS accepted reports but retained original MP4/H.264 4K classification and no TranscodeSession. User/item/position were correct; saved state stayed unchanged.

No supported external-encoder registration mechanism was established. Do not fabricate jobs, create shadow transcodes or claim labels repair bandwidth/codec accounting. All test helpers/encoders were stopped and stale test activity cleared.

## Implementation and verification gates

1. Serialize reports from accepted decoded observations, pinned to subject/server/item/occurrence. Fence stale stream/epoch/policy/revocation work.
2. Make activity and personal-state synchronization independent. Settle dispatched sync-on writes before acknowledging opt-out; cancel queued old writes. Unknown compatibility cannot silently enable personal sync.
3. Resolve shared producer leave/pause/replacement/last-consumer cleanup and same-account/external-player resume conflicts.
4. Verify additional PMS versions, Firefox/Activity, repeated off/on toggles, preexisting played state, delayed history, long runs, revocation and process loss.
5. Test dedicated sponsored-source behavior separately before any guest reporting claims.

For each authorized experiment capture a no-report baseline, exact subject/item/session, decoded observations, active read-back, post-stop resume/count/lastViewed/history and preference changes. Stop on ambiguous attribution or unexpected writes; never clear history/reset state without permission. Preserve private evidence outside Git.

Initial source/fixture research passed **20 tests** on Node 22.16.0; HLS/handoff test loading failed for missing `ws`. This was not a full-suite or live pass. Later live results above supersede only their measured cases.

Sources: [Plex dashboard](https://support.plex.tv/articles/200871837-status-and-dashboard/), [watch-state sync](https://support.plex.tv/articles/sync-watch-state-and-ratings/), [completion settings](https://support.plex.tv/articles/200289526-library/), [Plex for Kodi reporter](https://github.com/plexinc/plex-for-kodi/blob/master/lib/_included_packages/plexnet/nowplayingmanager.py). Public Plex Web 4.163.0 source inspection found no explicit no-write switch; the duration omission result comes from live read-back, not documentation.
