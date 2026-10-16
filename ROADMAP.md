# uburoom roadmap

Updated: 2026-10-16.

uburoom is a self-hosted Plex watch-together app for browsers and Discord Activity, with an included Firefox YouTube TV remote. The goal is simple: choose a title and watch together, with the intended picture, audio and subtitles surviving ordinary failures.

This is a working map for one maintainer and their agents. Plan in small, useful increments within these broad milestones. The order can change with the owner's priorities; there are no sprint commitments or promised release dates. This document consolidates existing plans, not new feature approvals or permission to deploy them.

## Where we are

The shared player, room timeline, linked accounts, per-user Plex access, command engine and remote consent model are implemented. Personal tracks, buffered rewind, bounded recovery, private HLS session refresh and short same-tab reconnect are also present. Synthetic browser tests include two-hour playback runs and decoded picture/audio/caption checks.

The main gap is evidence and completeness across real Plex sessions, Discord surfaces, content combinations and devices. A first two-hour real Plex HLS browser baseline is recorded, with one observed automatic unload/recovery and unresolved process memory growth. Passing a fixture or receiving a command acknowledgement does not establish live playback support. See [current verification and known gaps](docs/testing.md); keep detailed results there rather than copying them into this roadmap.

## Architecture to preserve

| Boundary | Direction |
| --- | --- |
| Service and state | Keep one Node process, ordinary JavaScript, built-in SQLite and minimal dependencies. Develop on local disk; keep runtime state and credentials private. |
| Room and viewer | The server owns the shared item timeline and playback intent. Each viewer owns their quality, audio, subtitles, volume and authorized media stream. |
| Commands and access | Every control surface uses the shared validated engine. Recheck current access around awaited operations, reject stale work, and keep remote consent off after disconnect/restart. |
| Media delivery | Grow the existing direct, Plex HLS and optional AV1 paths into measured source/track/capability negotiation. Share output only when content and authorization boundaries allow it. |
| Interfaces | Preserve the existing design, safe DOM components and shared remote styles/icons. Firefox and real Discord Activity remain primary targets. |

The [product specification](SPEC.md) and [project instructions](AGENTS.md) define the enduring rules. These milestones do not call for a service split, a framework rewrite or a new dependency stack.

## Milestone map

"Now" is the current focus, "Next" is the suggested sequence, and "Later" is planned direction with details still to settle. A release gate can run alongside feature work and applies before publishing the corresponding support claim.

| ID | Milestone | Position | Depends on |
| --- | --- | --- | --- |
| M1 | Prove sustained real playback and room continuity | Now; implementation exists, live coverage remains | Existing playback and fixture baseline |
| M2 | Choose compatible delivery automatically | Next; partial implementation | M1 measurements and complete source inventory |
| M3 | Complete audio, subtitles and content fidelity | Next; first slice implemented | M2 delivery model; validation can start now |
| M4 | Complete the Plex viewing experience | Later; planned | Stable source/track selection and item timeline |
| M5 | Make a verified self-hosted release | Release gate; preparation underway | Evidence for the combinations being shipped |
| M6 | Low-latency playback synchronization | Planned; clock synchronization and latency compensation first | M1 playback diagnostics and multi-client measurements |

### M1 — Sustained real playback and room continuity

**Outcome:** Long viewing sessions remain usable through ordinary delivery problems, with truthful recovery and preserved personal settings.

- Build on the first bounded **real Plex playback soak** with event-level diagnostics for its observed unload/recovery and process memory growth. Cover long pauses, cached rewind and outside-cache seeks, transcode expiry/restart, control reconnect and normal hls.js retry timing. Verify the captured audio/burned subtitle session still works after restoring saved Plex preferences.
- Measure decoded frames, intended audio/captions, stalls, drift, seek/recovery time and resource cleanup. Verify real conversion throughput, including sustained Intel QSV AV1 and simultaneous viewers; fixture software encoding does not prove hardware capacity.
- Exercise mixed transports/tracks, late joins, host transfer, tab sleep/wake, disconnect and rejoin. Tune synchronization and ongoing stall/refill policy from evidence, avoiding repeated seeks while a decoder is recovering.
- Complete real Discord Activity coverage: SDK authentication, browser handoff, proxy media/captions, identity/grant renewal, focused/grid/PIP transitions and background/return. Existing spot checks do not certify every desktop, web or mobile combination.

**Done for a declared environment:** A measured two-hour run and relevant fault/lifecycle checks preserve the intended content, shared timeline and authorization, with bounded recovery and no unexplained resource growth. Record actual limitations. Start with a controlled Plex account/media set; production interruptions and history-changing experiments need their existing authorization.

**Next useful slice:** Bounded local playback diagnostics are deployed. Short real Plex pause, rewind, outside-cache seek, injected control-poll failure, actual conversion expiry/replacement and room cleanup checks passed in Chrome; the owner confirmed intended audio/subtitles after replacement. A repeat two-hour real playback run completed without recorded stalls or unloads, retained track selections and timeline, and automatically cleaned up its room/conversion. The resource tail shows Node memory falling after cleanup and no returning test transcoder. Local watch-time regressions now reproduce and fix polling-offset/client-clock artifacts and disagreement between native frame counters and continuing frame callbacks. Sanitized rejection and uncredited-interval reasons remain bounded in the client diagnostic ring; stale-observation and decoded-playback safeguards remain enforced. Focused tests and the Firefox tracking smoke pass; a short live check of this patch remains pending the owner's manual stop/update/restart. The saved soak trace cannot establish the exact historical rejection causes. Continue live Firefox/Discord and physical network lifecycle coverage. General resource bounds, the original overnight unload trigger and the broader M1 gate remain open. Details: [reliability and continuity plan](docs/playback-reliability.md), [evidence and remaining gates](docs/testing.md#watch-time-accounting-investigation), [fixture commands](docs/development.md#bounded-playback-and-recovery-check).

### M2 — Compatible automatic delivery

**Outcome:** Viewers normally press Play without choosing codecs or troubleshooting conversion paths.

- Inventory eligible content versions, files and streams instead of assuming the first media/part. Keep alternate cuts distinct; only substitute timing-compatible encodes automatically.
- Model one playback attempt from complete source, selected tracks, client capability, network observations and server capacity. Confirm the output Plex actually agreed to deliver.
- Prefer suitable direct playback, then evaluate remux/audio-only conversion before full conversion or burn-in. Keep native HLS, hls.js and custom AV1 choices explicit and tested.
- Add stable automatic quality with a user ceiling, measured network/decode headroom and useful feedback when quality changes. Cancel superseded attempts and preserve position, pause intent and personal tracks across replacements.

**Done for a declared configuration:** Known compatible cases choose a suitable path; failed candidates terminate or recover within a finite policy, without language/caption loss, credential fallback or an indefinite spinner. Calibrate startup/seek targets before claiming them as guarantees.

Details: [playback decisions and implementation order](docs/playback-reliability.md).

### M3 — Audio, subtitles and content fidelity

**Outcome:** The selected content is delivered faithfully through a verified path, including non-default and accessibility tracks.

- Validate real Plex track selection, simultaneous viewers sharing an identity, stored-preference restoration and external preference changes. Cover success, failure, seek and session restart; retain the documented check/restore race limitation.
- Broaden audio codec/layout and downmix coverage. Investigate efficient audio-only conversion and verified multichannel output without promising lossless/Atmos passthrough generally.
- Complete styled/image subtitle evidence: ASS/SSA fonts, signs, karaoke and overlap; PGS/VobSub; forced/SDH choices; text extraction/encoding, CJK/right-to-left and caption presentation across player layouts.
- Verify VFR and source cadence, A/V/caption alignment, chunk/part boundaries and actual end-of-stream behavior. Validate aspect ratio, rotation and SDR/HDR handling, treating Dolby Vision profiles separately.
- Expand the claimed browser/device matrix incrementally, including real Safari/iOS, Android and Discord mobile. Document unsupported combinations instead of inheriting another browser's results.

**Done for a claimed combination:** Recognizable picture, intended audio and captions pass together on the actual target surface, including switching and recovery. Keep the detailed corpus and support matrix in the [playback plan](docs/playback-reliability.md) and [testing status](docs/testing.md).

### M4 — Plex viewing experience

**Outcome:** Common Plex viewing tasks fit the shared room model without sacrificing per-user choices.

- Support content versions and a complete item timeline across split files, then carry seeks, captions, chapters, markers and progress consistently across part boundaries.
- Add resume/start-over, chapters, intro/credits markers, previews, available extras and cancellable next-episode continuation. Shared skips/continuation stay authorized room actions.
- Work through the existing parity inventory for subtitle search/download, renderer-supported presentation controls, available audio timing and shared playback speed. Decide and verify each control's behavior before exposing it.
- Define the per-user resume/history reporting lifecycle before enabling Plex timeline/watch-state writes. Reporting is currently disabled; experiments must use consenting accounts and account for resume/history effects.

**Done per increment:** One complete viewing flow works across its declared surfaces, including cancellation and room synchronization. This milestone is several small features, not a promise to reproduce every Plex screen at once. Details: [content fidelity and playback UX](docs/playback-reliability.md#content-fidelity-and-playback-ux).

### M5 — Verified self-hosted release

**Outcome:** Another person can install or upgrade uburoom safely and understand exactly what is supported.

- Verify a clean installation on an unrelated host/origin with separate provider applications and fresh profiles, plus an existing-instance upgrade with stable account UUIDs and the exact original encryption key bytes. Test the chosen code/state separation and rollback procedure.
- Verify restricted/revoked Plex access, linked accounts, `/ubu` and `!ubu`, real Activity setup and the claimed browser/transport combinations without owner-token fallback.
- Complete real Firefox/YouTube TV lifecycle, consent, latency and configured-origin checks. The known full extension smoke failure remains deferred; preserve that exception explicitly and do not weaken permissions or throttling to conceal it.
- Finish branding/artwork/media provenance, dependency notices and GPL-3.0-only distribution review. Audit source, full publication history, assets and ZIP contents for private material; include LICENSE and required notices.
- Keep signing, publication, public push, provider registration and production configuration/restarts behind their existing explicit approval requirements. Public repository creation remains deferred until the brand transition is complete.

**Done for a release:** Claims match recorded evidence, required install/upgrade and provenance gates are satisfied, and audited ZIPs can be reviewed for publication. A feature milestone alone does not authorize a release.

Details: [self-hosting](docs/self-hosting.md), [upgrading](docs/upgrading.md), [attribution](docs/third-party.md), [verification gates](docs/testing.md#local-migration-checks).

### M6 — Low-latency playback synchronization

**Goal:** Synchronize playback between geographically separated viewers with a delay equal to or lower than typical Discord voice-call latency, targeting a playback difference of **≤100 ms at p95**. This is a performance goal to validate, not an established support claim.

**Current issues:** Playback does not compensate for network latency; existing clock-offset estimation is not used for playback synchronization; play/pause updates rely on one-second polling; drift correction is reactive and relatively slow.

**Planned improvements, in priority order:**

1. **Latency-aware synchronization:** Measure network RTT and server/client clock offsets, filtering out unreliable samples.
2. **Server-time-based playback:** Calculate the correct playback position using synchronized server timestamps rather than response arrival times.
3. **Real-time updates:** Use WebSockets or Server-Sent Events instead of polling for immediate play/pause/seek notifications, preserving the shared validated command engine, authorization and stale-command rejection.
4. **Scheduled playback:** Coordinate playback starts using shared future server timestamps to account for network delays.
5. **Improved drift correction:** Tune playback-speed adjustments and seeking to minimize noticeable desynchronization without disrupting buffering or decoder recovery.
6. **Sync diagnostics:** Add multi-client testing that measures actual playback differences, including audio timing where possible, with p95/p99 metrics. Separate geographically distributed evidence from local fixtures and command acknowledgements.

**Success criteria:**

- ≤100 ms playback difference at p95.
- ≤200 ms playback difference at p99.
- Play/pause/seek events remain tightly synchronized across distant clients.
- Minimal buffering, stuttering or noticeable playback-speed changes.

**Next useful slice:** Focus first on clock synchronization and latency-compensated playback calculations, followed by real-time event delivery and improved drift correction. Record the measurement conditions, actual playback percentiles and remaining limitations in [testing status](docs/testing.md#low-latency-playback-synchronization).

## Future direction and decisions still open

These are already identified directions or placeholders, outside the current delivery sequence. Define a small scope when the owner selects one.

| Direction | Current boundary |
| --- | --- |
| Native-player integration | Future milestone. Establish the integration and control contract while preserving the shared engine, account scopes and consent lifecycle. |
| Independent remote | Future milestone. The Firefox remote stays in this repository for now; decide the split boundary before extracting it. |
| Project-hosted rooms and managed room URLs | Future work in the specification. Self-hosting remains the current product; hosting and account/isolation responsibilities need a separate scope. |
| Live TV/DVR | Separate feasibility work for live manifests, moving seek windows, tuning and authorization. On-demand video coverage does not imply live support. |
| Queue controls | A disabled UI placeholder exists; queue behavior and authorization are not specified. Keep it disabled until its scope is chosen. |

## How agents should use and maintain this roadmap

1. Read this map and the linked detail/status documents for the assigned area. The owner's current request takes priority; roadmap entries are not instructions to implement every listed feature.
2. Work on one bounded increment with a clear user-visible outcome and relevant evidence. Name its milestone ID in a work summary when useful; do not create a parallel task tracker or duplicate the full plan.
3. Distinguish implementation from verification. Reuse existing results where applicable, reproduce a specific gap, and add meaningful checks. Record failures, unsupported cases and unfinished validation in `docs/testing.md`; commands belong in `docs/development.md`.
4. After a material increment, update only the affected roadmap status/next slice and its detail documents. Keep this file short enough to scan; put completed evidence in testing status and code history.
5. Keep private decisions, deployment instructions and identifying evidence out of public planning files. Explicit suggestion audits use their separate personal review workflow; ordinary assigned tasks and casual advice do not populate suggestion queues. Declined ideas do not become planned work through consolidation.

## Document map

| Document | Owns |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | Broad priorities, milestone status, sequencing and open directions |
| [SPEC.md](SPEC.md) | Product behavior and enduring boundaries |
| [Playback reliability plan](docs/playback-reliability.md) | Detailed playback architecture, requirements, corpus and proposed performance targets |
| [Testing status](docs/testing.md) | Actual evidence, limitations, deferred failures and remaining verification |
| [Development](docs/development.md) | Reproducible local/isolated commands and fixture prerequisites |
| [Design guide](docs/design-guide.md) | Established interface and asset rules |
| [Self-hosting](docs/self-hosting.md) / [upgrading](docs/upgrading.md) | Operator setup, state/key preservation and upgrade procedures |
| [Third-party review](docs/third-party.md) | Licensing, notices and asset provenance gates |
