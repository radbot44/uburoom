# Plex reporting investigation

**Historical investigation record (2026-10-19/20).** Decoupled session reporting, shared-producer stop safety, activity-only default with personal watch-state opt-in, and sponsored viewer isolation are now implemented on `main` (`server/plex-reporting.js`); see [accounts and reporting](accounts-and-access.md#plex-activity-and-viewer-attribution) for the current contract and [testing](testing.md) for remaining live PMS/Tautulli verification gates. The original implicit-fallback recommendation is superseded.

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
