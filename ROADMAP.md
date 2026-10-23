# uburoom roadmap

Updated: 2026-10-20.


This is a working map for one maintainer and their agents. Milestones define broad outcomes; phases are the smaller bodies of work within each milestone. Plan in small, useful increments within these phases. The order can change with the owner's priorities; there are no sprint commitments or promised release dates. This document consolidates existing plans, not new feature approvals or permission to deploy them.

## Where we are

The shared player, room timeline, linked accounts, per-user Plex access and command engine are implemented. Personal tracks, buffered rewind, bounded recovery, private HLS session refresh and short same-tab reconnect are also present. Synthetic browser tests include two-hour playback runs and decoded picture/audio/caption checks.

The main gap is evidence and completeness across real Plex sessions, Discord surfaces, content combinations and devices. A first two-hour real Plex HLS browser baseline is recorded, with one observed automatic unload/recovery and unresolved process memory growth. Passing a fixture or receiving a command acknowledgement does not establish live playback support. See the [current verification dashboard](docs/testing.md); detailed dated results belong in the [testing archive](docs/archive/testing-2026-10-22.md), not in this roadmap.

**Next planning priority:** Review configuration in depth and define a proper in-app administration panel with explicit account admission and media authorization (M1-P14). Plex activity and watch-state reporting is a high-priority M1-P4 track alongside that foundation. Preserve Discord sign-in and the Activity's authorized **Open in web app** handoff. Configuration and access policies are implemented, including a verified Activity exception to required personal Plex entry, OS-specific credential-key paths and configurable Plex single-room leadership; hardware-first AV1 backends, CPU fallback, custom quality pairs and bounded capacity/shared-quality recovery are implemented locally with integration gates remaining; the broader admin panel and remaining reporting features are future work. The [Plex reporting investigation](docs/plex-reporting-investigation.md) now includes a working activity-only candidate on the tested PMS/Chrome Original, HLS and AV1 paths. HLS also passed natural ending; the earlier AV1 live probe required explicit stop at the final-buffer gap. Commit `3a1100e` (2026-10-20) implements AV1 MediaSource end-of-stream signaling and transient encoder-probe recovery with focused automated tests; real Plex/browser natural-ending verification remains pending. The delivery-association follow-up verified truthful isolated HLS transcode classification with distinct viewer/playback/job IDs. Shared-producer stop behavior and external AV1 telemetry remain unresolved; investigate those boundaries before broad reporting claims. The AV1 end-of-stream fix is implemented but not yet live-verified; other server versions and sponsorship remain unverified. The wider configuration inventory, admission/media policy matrix and admin persistence/recovery contract remain to be completed under [accounts, administration and Plex reporting](docs/accounts-and-access.md).

## Architecture to preserve

| Boundary | Direction |
| --- | --- |
| Service and state | Keep one Node process, ordinary JavaScript, built-in SQLite and minimal dependencies. Develop on local disk; keep runtime state and credentials private. Keep device, login and playback-history persistence in SQLite, while removing private pre-release migration paths before the first public release. Protect the single event loop from synchronous disk/crypto spikes during playback synchronization. |
| Room and viewer | The server owns the shared item timeline and playback intent. Each viewer owns their quality, audio, subtitles, volume and authorized media stream. M1-P13 durable records, live-room integration, queues, generation and cancellable autoplay use the existing SQLite writer; real Plex/Activity continuity checks remain. Current viewing rooms are still process-local. Preserve native playback history for future per-viewer Plex watch-state reporting. |
| Identity and authorization | Keep one canonical account UUID independent of display names and login provider. Separate sign-in, admission, media entitlement, room roles and server administration. Replace implicit owner-token fallback with explicit media grants; sponsored viewers must not be attributed to another person's Plex watch history. M1-P14 defines the policy/configuration foundation; M1-P4 owns Plex reporting. |
| Media delivery | Grow the existing direct, Plex HLS and optional AV1 paths into measured source/track/capability negotiation. Share output only when content and authorization boundaries allow it. Make authenticated WebSockets the native room-control transport; retain HTTP where appropriate for auth/bootstrap, catalog, artwork, media and health. |

The [product specification](SPEC.md) and [project instructions](AGENTS.md) define the enduring rules. These milestones do not call for a service split, a framework rewrite or a new dependency stack.

## M1 — Verified self-hosted release

**Current milestone. Outcome:** Another person can install the first public uburoom release safely, preserve state across supported future upgrades, and understand exactly what is supported. Private pre-release revisions have no promised upgrade path.

- Verify a clean installation on an unrelated host/origin with separate provider applications and fresh profiles. Test backup/restore, stable account UUIDs and exact original encryption-key preservation for retained state, code/state separation and rollback. The sole pre-release installation may be reset or manually transferred with an explicit backup; do not add compatibility migrations solely for it or silently discard its data.
- Verify restricted/revoked Plex access, linked accounts, `/ubu` and `!ubu`, real Activity setup and the claimed browser/transport combinations without owner-token fallback.
- Close the confirmed media-access expansion when a restricted Plex identity is removed from a Discord-eligible account. Require an explicit authorization policy for viewers without personal Plex entitlement; verify admission, media grants and reporting attribution independently. Complete the M1-P14 configuration/security foundation before exposing expanded sharing controls.
- Finish branding/artwork/media provenance, dependency notices and GPL-3.0-only distribution review. Switch `scripts/build-demo-media.js` to approved current branding and remove `assets/branding/old/` from the active source before packaging; retain prior artwork in Git history. Audit source, full publication history, assets and ZIP contents for private material; include LICENSE and required notices.
- Source packaging now includes ROADMAP.md; local ZIP inventory verification confirms it is present alongside the existing private-file exclusions. Retain that coverage in later package reviews.
- Keep signing, publication, public push, provider registration and production configuration/restarts behind their existing explicit approval requirements. Public repository creation remains deferred until the brand transition is complete.

**Done for a release:** Claims match recorded evidence, required install/upgrade and provenance gates are satisfied, and audited ZIPs can be reviewed for publication. Completing a phase alone does not authorize a release.

**Verification gate:** Apply the A/B/C/D methods below and record the evidence in [docs/testing.md](docs/testing.md). B fixture coverage cannot close a C real-environment gate; D covers targeted human acceptance, not authorization to deploy or publish. An open required level keeps the corresponding claim open.

Details: [self-hosting](docs/self-hosting.md), [upgrading](docs/upgrading.md), [attribution](docs/third-party.md), [verification gates](docs/archive/testing-2026-10-22.md#local-migration-checks).

### Phase map

"Now" is the current focus, "Next" is the suggested sequence, and "Later" is planned direction with details still to settle. Phase IDs use `M1-Pn` within milestone M1. Release verification runs alongside phase work and applies before publishing the corresponding support claim. The high-priority frame-pacing requirements in M1-P6 constrain synchronization work in M1-P5 from the outset.

| ID | Phase | Position | Depends on |
| --- | --- | --- | --- |
| M1-P1 | Prove sustained real playback and room continuity | Now; implementation exists, live coverage remains | Existing playback and fixture baseline |
| M1-P2 | Choose compatible delivery automatically | Next; partial implementation | M1-P1 measurements and complete source inventory |
| M1-P3 | Complete audio, subtitles and content fidelity | Next; first slice implemented | M1-P2 delivery model; validation can start now |
| M1-P4 | Complete the Plex viewing experience | Next: research and isolated live Original activity/resume probe recorded; broader provider verification open, product reporting not implemented; other parity work later | Native playback observations/history, M1-P14 authorization/attribution contract; source/track selection and item timeline for broader parity |
| M1-P5 | Real-time playback synchronization | In progress; timing instrumentation and clock estimation implemented, live targets unverified | M1-P1 diagnostics and multi-client measurements; M1-P6 frame-pacing constraints |
| M1-P6 | Frame-pacing preservation during synchronization | In progress; experimental candidates gated, disposition/production cleanup and joint live verification pending | Presentation-interval diagnostics and coordinated design with M1-P5 |
| M1-P7 | In-depth UI/UX review and restructure | In progress; normal/theater/fullscreen layout split implemented, broader UI review remains | Existing design guide, rendered surfaces and playback/permission behavior |
| M1-P9 | Render styled and bitmap subtitles in the browser | Implementation complete; verification and licensing pending | M1-P2/M1-P3 track delivery; existing player and shared conversion boundaries |
| M1-P10 | Transition "session" terminology to "room" | Canonical room protocol verified locally across repositories; full live surface verification pending | M1-P7 UI/UX review and command engine consistency |
| M1-P11 | Architecture hardening: persistence unification, event-loop protection and fault isolation | Local hardening and compatibility removal complete; live checks pending | M1-P1 and M1-P5 real-world measurements |
| M1-P12 | Rich viewer telemetry, sync health and room presence | In progress; per-participant sync-quality indicator and simplified ring-buffered 1 Hz scoring locally verified; broader telemetry and live-device acceptance remain open | M1-P5 sync engine, M1-P7 UI review, and M1-P10 room terminology |
| M1-P13 | Persistent rooms and playback queues | In progress; P13-1 durable core, P13-2 live integration/Admin mode, P13-3 manual queues, P13-4 bulk/generation/shuffle and P13-5 verified cancellable autoplay implemented; room lifetime/capacity and reboot recovery follow-up verified with fixtures and Chrome/Firefox; live gates remain | M1-P11 SQLite/WebSocket foundation, M1-P7 lobby/library UI, shared timeline and recorded lifecycle/role decisions |
| M1-P14 | Configuration, administration and account authorization | YAML, entry/fallback/Activity/single-room, conversion policies and editable names/host discovery/All hosts implemented locally; admin UI, broader identity security and live verification pending | Existing accounts/SQLite, M1-P11 transport/auth foundation and M1-P13 durable roles; coordinates with M1-P4 reporting and M2-P3 guests |

### Verification routing for M1

**A — Review** checks code and existing evidence; **B — Automated** runs isolated tests; **C — Integration** uses actual providers, hardware, apps or networks; **D — Human** is targeted perceptual/UX acceptance. These are methods, not agent types or pass grades. Multiple methods may be required for one claim. C requires separate permission for real-account/history/production-impacting operations; D does not replace technical measurements. The requirements below are **open verification routes**, not claims that any level has passed. Concise per-check status belongs in the [verification dashboard](docs/testing.md#verification-standard-for-new-work); dated archived proof remains linked there.

| Phase | Required verification routes for claimed behavior |
| --- | --- |
| M1-P1 — Playback continuity | B: recovery/soak diagnostics; C: real multi-hour Plex, hardware and lifecycle/resource evidence; D: perceptual track/picture checks for claimed combinations |
| M1-P2 — Automatic delivery | A: negotiation/selection audit; B: compatibility/failure matrix; C: actual Plex decisions, codecs, platforms and resources |
| M1-P3 — Audio/subtitle fidelity | B: decoded audio/pixels and track races; C: real media/browser/device/Discord combinations; D: audible language, sound and subtitle-fidelity acceptance |
| M1-P4 — Plex viewing/reporting | A: identity/attribution design; B: replay, stale request and history checks; C: consenting Plex dashboard/resume/history and shared-output evidence |
| M1-P5 — Synchronization | B: skew/clock and buffering isolation; C: physical/WAN/client presentation timing; D: the joint viewing check with P6 |
| M1-P6 — Frame pacing | B: correction/cadence comparisons; C: physical display/refresh/transport measurements; D: smooth-motion acceptance with P5 |
| M1-P7 — UI/UX | A: flow/accessibility review; B: browser/layout/keyboard automation; C: installed mobile/Activity interaction; D: task clarity/usability acceptance |
| M1-P9 — Styled/bitmap subtitles | B: parser/renderer/pixel/font/cleanup coverage; C: live Plex/Activity/device/resource evidence; D: readability and authored-fidelity acceptance |
| M1-P11 — Architecture hardening | A: failure/upgrade boundary review; B: fault, worker, latency and restore fixtures; C: operator backup/restore and live resource/proxy checks |
| M1-P12 — Viewer telemetry | A/B design and regression when implemented; C for actual observer/platform claims; D for clarity of new status UI |
| M1-P13 — Durable rooms/queues | B: queue, concurrent edit, crash/reopen and autoplay fixtures; C: live Plex multi-viewer/Activity and retained-state evidence; D: queue/room UX acceptance when claimed |
| M1-P14 — Admin/access | A: policy matrix and privilege review; B: revocation, unlink/merge, recovery and handoff regressions; C: real identity/provider denial and handoff checks; D: operator usability/recovery acceptance |

For all phases, operator approval for real-system tests, policy decisions, credential changes, state transfer, deployment and release is an **authorization gate**, separate from A–D verification. Phases not yet implemented are not marked test-complete.

### M1-P1 — Sustained real playback and room continuity

**Outcome:** Long viewing sessions remain usable through ordinary delivery problems, with truthful recovery and preserved personal settings.

- Build on the first bounded **real Plex playback soak** with event-level diagnostics for its observed unload/recovery and process memory growth. Cover long pauses, cached rewind and outside-cache seeks, transcode expiry/restart, control reconnect and normal hls.js retry timing. Verify the captured audio/burned subtitle session still works after restoring saved Plex preferences.
- Measure decoded frames, intended audio/captions, stalls, drift, seek/recovery time and resource cleanup. Verify real conversion throughput, including sustained Intel QSV AV1 and simultaneous viewers; fixture software encoding does not prove hardware capacity.
- Exercise mixed transports/tracks, late joins, host transfer, tab sleep/wake, disconnect and rejoin. Tune synchronization and ongoing stall/refill policy from evidence, avoiding repeated seeks while a decoder is recovering.
- Complete real Discord Activity coverage: SDK authentication, browser handoff, proxy media/captions, identity/grant renewal, focused/grid/PIP transitions and background/return. Existing spot checks do not certify every desktop, web or mobile combination.

**Done for a declared environment:** A measured two-hour run and relevant fault/lifecycle checks preserve the intended content, shared timeline and authorization, with bounded recovery and no unexplained resource growth. Record actual limitations. Start with a controlled Plex account/media set; production interruptions and history-changing experiments need their existing authorization.

**Next useful slice:** Bounded local playback diagnostics are deployed. Short real Plex pause, rewind, outside-cache seek, injected control-poll failure, actual conversion expiry/replacement and room cleanup checks passed in Chrome; the owner confirmed intended audio/subtitles after replacement. A repeat two-hour real playback run completed without recorded stalls or unloads, retained track selections and timeline, and automatically cleaned up its room/conversion. The resource tail shows Node memory falling after cleanup and no returning test transcoder. Watch-time regressions now reproduce and fix polling-offset/client-clock artifacts and disagreement between native frame counters and continuing frame callbacks. Sanitized rejection and uncredited-interval reasons remain bounded in the client diagnostic ring; stale-observation and decoded-playback safeguards remain enforced. Focused tests, the Firefox tracking smoke and a short real Plex Chrome check pass; the live credited interval was continuous and pause earned no additional time. The saved soak trace cannot establish the exact historical rejection causes. Continue long-run accounting, live Firefox/Discord and physical network lifecycle coverage. General resource bounds, the original overnight unload trigger and the broader M1-P1 gate remain open. Details: [reliability and continuity plan](docs/playback-reliability.md), [evidence and remaining gates](docs/archive/testing-2026-10-22.md#watch-time-accounting-investigation), [fixture commands](docs/development.md#bounded-playback-and-recovery-check).

### M1-P2 — Compatible automatic delivery

**Outcome:** Viewers normally press Play without choosing codecs or troubleshooting conversion paths.

**Direct HLS increment (2026-10-22):** The local candidate selects direct delivery before HLS cache warm-up and shares matching direct output without server video/audio requests. Each viewer uses their own temporary credential and reads the timestamp anchor directly from Plex. The server retains only the small initial playlist; proxy playback keeps its separate pool/cache. All 377 tests pass; Chrome/Firefox synthetic direct, shared late-join, decoded audio/picture and proxy recovery checks pass. A bounded real Plex probe confirmed two temporary tokens from one dedicated non-owner account can read the same output, revisit segment zero and retain later-segment bytes; the test session was stopped. Different real accounts, external HLS browser playback and sustained lifecycle coverage remain open. See the [implementation boundaries](docs/plex-hls-delivery.md) and [scoped evidence](docs/testing.md#direct-plex-hls-2026-10-22). Deployment remains separate.

**Original-file delivery increment (2026-10-22):** Owner-approved optional `plex.delivery: auto` supports direct original files in ordinary browsers, with an explicit HTTPS client origin, verified server identity, per-viewer temporary credentials and bounded recovery to the authorized proxy. Dedicated non-owner fallback delegation requires a separate opt-in and verified Plex ownership metadata; configured owner credentials are never delegated as fallback. Activity and local conversion retain their existing delivery. Strict direct-only mode remains later work. Local automated/browser evidence and open real-provider gates are recorded in the [verification dashboard](docs/testing.md#direct-plex-file-delivery-2026-10-22).

**External HLS/recovery follow-up (2026-10-22):** The owner subsequently reported successful cellular direct HLS and a second external Safari viewer using browser Discord sign-in with fallback access. Local Firefox/Chrome could not reach the public Plex endpoint from the LAN and recovered through the proxy; this does not test different-account Plex session authorization. A local follow-up removes direct playlist retries and bounds the first response to five seconds, reducing isolated recovery from about 3–12 seconds to about 0.4–5.3 seconds. Full tests and Chrome/Firefox direct/shared/recovery checks pass; the reported minute-long installed delay was not reproduced. LAN routing, different real Plex-account sharing and sustained external synchronization remain separate gates. No network configuration or deployment was performed for this follow-up.

Authenticated Plex discovery now verifies exact advertised HTTPS non-relay origins without requiring server-side NAT loopback. Unlisted origins retain the identity probe; viewer reachability and decoded playback remain independent checks. The owner subsequently confirmed successful Original playback with direct-file state on a phone over 4G; that external check does not establish direct HLS support.

Configured fallback account credentials now resolve that same account's PMS token when the raw credential is rejected with HTTP 401; account discovery and media credentials remain separate. Local regressions and read-only real PMS library checks pass. Following the earlier callback failure and diagnostic PIN success, the owner confirmed normal Plex linking now succeeds; the earlier failure's precise cause was not independently established.

- **Preparation audit completed (2026-10-17):** Traced initial preparation, quality/track replacement, recovery and shared conversion ownership. Identified repeated viewer replacement lifecycle, first-source assumptions spanning tracks/delivery, and incomplete confirmation of Plex output. Isolated reproductions and 49 focused passing tests support reviewable proposals; implementation choices remain pending owner review. Preserve the existing authorization, track-restoration and lease boundaries when selecting the next increment.
- Inventory eligible content versions, files and streams instead of assuming the first media/part. Keep alternate cuts distinct; only substitute timing-compatible encodes automatically.
- Model one playback attempt from complete source, selected tracks, client capability, network observations and server capacity. Confirm the output Plex actually agreed to deliver.
- Prefer suitable direct playback, then evaluate remux/audio-only conversion before full conversion or burn-in. Keep native HLS, hls.js and custom AV1 choices explicit and tested.
- Add stable automatic quality with a user ceiling, measured network/decode headroom and useful feedback when quality changes. Cancel superseded attempts and preserve position, pause intent and personal tracks across replacements.

**Done for a declared configuration:** Known compatible cases choose a suitable path; failed candidates terminate or recover within a finite policy, without language/caption loss, credential fallback or an indefinite spinner. Calibrate startup/seek targets before claiming them as guarantees.

Details: [playback decisions and implementation order](docs/playback-reliability.md).

**Quality replacement follow-up:** Local refill and a seek guard address repeated HLS catch-up seeks; a separate preparation budget keeps polling and playback controls available during slow Plex decisions. A source-frame oracle then exposed matching clocks with pictures half a second apart after a late join or quality change: cold HLS starts normalized transport timestamps against coarse middle-of-playlist estimates. Fresh players now anchor their timestamp origin from segment zero before jumping to the current room position and refilling. Chrome/Firefox source-frame and delayed-fragment checks pass; other viewers keep their streams and timeline. Complete actual Plex/Android picture/audio validation; local evidence does not establish every reported timeout or stutter's cause. Evidence: [mid-playback quality replacement](docs/archive/testing-2026-10-22.md#mid-playback-quality-replacement).

**Discord codec evidence (2026-10-20):** The owner's Windows Activity run with acceleration Off produced picture and sound for VP8, VP9 and AV1; H.264 profiles failed and HEVC produced audio only. Positive H.264 support hints contradicted decoding. AV1 remains the default. VP8/VP9 local output pipelines, configured ordering, bounded recovery and per-codec probes are implemented and pass synthetic Chrome/Firefox playback/sharing/seek checks; real Activity streaming and broader clients remain integration gates. See the [recorded codec matrix](docs/discord-codec-compatibility.md).

**Shared conversions:** Matching Plex HLS and custom AV1 outputs now reuse work within one room/media generation across independently authorized accounts. Audio and burned subtitles participate in matching; browser text captions remain personal. Bounded anchor caching preserves the source timestamp origin for HLS late joins. Live Plex process counts and Android playback remain verification gates. Evidence: [shared room transcodes](docs/archive/testing-2026-10-22.md#shared-room-transcodes).

### M1-P3 — Audio, subtitles and content fidelity

**Outcome:** The selected content is delivered faithfully through a verified path, including non-default and accessibility tracks.

- Validate real Plex track selection, simultaneous viewers sharing an identity, stored-preference restoration and external preference changes. Cover success, failure, seek and session restart; retain the documented check/restore race limitation.
- Broaden audio codec/layout and downmix coverage. Investigate efficient audio-only conversion and verified multichannel output without promising lossless/Atmos passthrough generally.
- Complete styled/image subtitle evidence: ASS/SSA fonts, signs, karaoke and overlap; PGS/VobSub; forced/SDH choices; text extraction/encoding, CJK/right-to-left and caption presentation across player layouts.
- Verify VFR and source cadence, A/V/caption alignment, chunk/part boundaries and actual end-of-stream behavior. Validate aspect ratio, rotation and SDR/HDR handling, treating Dolby Vision profiles separately.
- Expand the claimed browser/device matrix incrementally, including real Safari/iOS, Android and Discord mobile. Document unsupported combinations instead of inheriting another browser's results.

**Done for a claimed combination:** Recognizable picture, intended audio and captions pass together on the actual target surface, including switching and recovery. Keep the detailed corpus and support matrix in the [playback plan](docs/playback-reliability.md) and [testing status](docs/testing.md).

### M1-P4 — Plex viewing experience

**Outcome:** Common Plex viewing tasks fit the shared room model without sacrificing per-user choices.

- Support content versions and a complete item timeline across split files, then carry seeks, captions, chapters, markers and progress consistently across part boundaries.
- Add resume/start-over, chapters, intro/credits markers, previews, available extras and cancellable next-episode continuation. Shared skips/continuation stay authorized room actions.
- Coordinate continuation with M1-P13's queue/current-entry transition; do not build a second episode-advance path. Room bookmarks/history and per-viewer Plex reporting have different authority and retention.
- Work through the existing parity inventory for subtitle search/download, renderer-supported presentation controls, available audio timing and shared playback speed. Decide and verify each control's behavior before exposing it.
- Retain native per-viewer playback observations **and durable history** as the foundation for planned Plex timeline, resume and watched-state updates across linked clients/servers. Define per-user reporting, cross-device reconciliation, consent/authorization and idempotency before enabling Plex writes. Reporting is currently disabled; experiments must use consenting accounts and account for resume/history effects. Do not remove playback history as part of pre-release storage cleanup.
- **High-priority Plex activity/reporting track:** Design alongside M1-P14, ahead of guest media delivery. Attribute actual observed playback to each verified Plex viewer independently of shared transcodes; handle duplicate tabs, Activity/browser handoff, concurrent devices, revoked access and stale retries without conflicting progress or identity reassignment. Verify Plex dashboard presence, resume and completion separately across Original, HLS and AV1; a successful API request or running transcode is insufficient evidence.
- **Viewers without an authorized Plex account:** Specify separately how the operator-authorized source appears on Plex and how each guest/Discord-only viewer is tracked in uburoom. Keep transport/source credentials separate from personal reporting credentials. Preserve distinct local viewer progress and truthful reporting status; never invent a Plex identity, label shared producer activity as proof of every viewer, or write the owner's personal resume/watched state on behalf of guests. Establish actual Plex behavior and any unavoidable source-account side effects before choosing or advertising a sponsored-reporting mode.

Reporting requirements and open decisions: [accounts and access — Plex reporting](docs/accounts-and-access.md#plex-activity-and-viewer-attribution). The [activity-only investigation](docs/plex-reporting-investigation.md#activity-only-reporting-and-personal-state-separation) found that omitting timeline duration while retaining real item IDs, user and position preserves correct Plex/Tautulli activity without further personal-state updates on the tested PMS/Chrome Original, HLS and AV1 paths. Same-client sync-on → off tests retained the saved resume/played/history baseline; Original/HLS reached natural ending in these trials, while AV1 needed explicit stop at a final-buffer gap. A subsequent AV1 end-of-stream fix has automated regression coverage but still needs real-browser playback and natural-ending confirmation. Plan an independent personal-sync toggle, with compatibility and stale-report fencing verified before implementation. Account-attributed Plex log events were observed; persisted aggregate usage counters remain unverified. The [association follow-up](docs/plex-reporting-investigation.md#plex-delivery-association-investigation-2026-10-20) resolves isolated HLS classification using consistent playback-session identity; linked stopped reports terminate the job, so pooled reporting is not yet safe. External AV1 output declarations did not change PMS source classification. AV1 natural ending, shared output, Activity and sponsorship remain open. **Product reporting and explicit sponsorship remain unimplemented; the owner-token fallback defect remains open.**

**Done per increment:** One complete viewing flow works across its declared surfaces, including cancellation and room synchronization. This phase is several small features, not a promise to reproduce every Plex screen at once. Details: [content fidelity and playback UX](docs/playback-reliability.md#content-fidelity-and-playback-ux).

### M1-P5 — Real-time playback synchronization — Design requirements

**Single-viewer refinement (2026-10-18):** A sole viewing tab skips startup/seek countdowns and pause/resume delivery margins while retaining decoder readiness, clock samples and drift tracking. Joining restores group coordination without interrupting ongoing playback; departure releases any remaining group countdown. Count viewing tabs rather than account identities. See [verification](docs/archive/testing-2026-10-22.md#single-viewer-coordination-delays-2026-10-18).

**Goal:** Minimize the actual real-world playback difference between healthy viewers so reactions over Discord voice chat don't arrive before other viewers see the corresponding event.

**Target:** Aim for ≤50 ms p95 presentation-time skew, with ≤100 ms p99 as an initial engineering target, subject to real-world testing.

**Current increment:** Authenticated WebSocket updates now carry coordinated ordinary pause/resume deadlines. A bounded 400–1,000 ms lead uses recent server-measured round trips; missed deadlines reconcile locally. Startup and shared seeks retain buffered readiness and overlap the preparation countdown. After three seconds, waiting viewers are named; after ten seconds, automatic release latches until the host starts with ready viewers, waits another fifteen seconds, or cancels. Ongoing buffering remains independent. Bounded leading HLS timestamp gaps at zero are covered by three-viewer Chrome/Firefox startup and restart checks. Default drift rate/deadband and hard-seek thresholds remain unchanged: the new sustained 100/50 ms candidate remains gated after local skew/drop regressions. A personal Occasional jumps mode now provides opt-in moderate local seeks at normal speed. Physical/geographic validation, lead and correction calibration, Firefox high-rate callback limits and subjective motion remain open. See [measurements and open gates](docs/archive/testing-2026-10-22.md#real-time-playback-synchronization).

**Architecture:**

- Use a shared server-authoritative playback timeline with accurate clock-offset and network-latency estimation.
- Synchronize actual frame presentation times, not just `video.currentTime`.
- Use scheduled timestamps for coordinated play/pause/seek events.
- Use gradual drift correction and hard seeks when necessary, within the frame-pacing requirements in M1-P6. An opt-in personal Occasional jumps mode keeps playback at 1.00×, requires sustained buffered drift, and limits moderate seeks with a decoded-recovery cooldown; the default remains Speed adjustments.
- Ensure latency differences between viewers don't translate directly into playback differences.
- Unify room control and state synchronization onto WebSockets, eliminating HTTP polling jitter and request stampedes.
- Protect event loop latency: keep heavy crypto and synchronous SQLite writes off the high-frequency tick loop so that disk/crypto stalls do not delay scheduled broadcast ticks.

**Critical constraint — independent buffering:**

- Never pause or delay healthy viewers because another viewer buffers, disconnects or experiences poor performance during ongoing playback.
- Buffering viewers recover independently and catch up to the current authoritative timeline.
- Preserve individual quality selection and stream recovery.
- Preserve readiness gates for starting new media and explicit shared seeks, separately from ongoing playback recovery.

**Verification:** Measure actual inter-viewer presentation-time skew across different network RTTs, including 20–300+ ms, and test that a buffering viewer doesn't interrupt healthy viewers. Record actual percentiles and limitations in [testing status](docs/archive/testing-2026-10-22.md#real-time-playback-synchronization).

**References:** [IETF RFC 7272 — Inter-Destination Media Synchronization](https://www.rfc-editor.org/info/rfc7272/) and [W3C Timing Object specification — Community Group report](https://www.w3.org/community/reports/webtiming/CG-FINAL-timingobject-20241203/).

### M1-P6 — Frame-pacing preservation during synchronization

**Priority: High — Visual smoothness must not be sacrificed for unnecessarily precise synchronization.**

uburoom must prioritize consistent native frame pacing alongside low inter-viewer playback latency.

**Requirements:**

- Preserve the source video's original frame rate and maintain 1.00× playback whenever possible.
- Avoid frequent or aggressive playback-rate adjustments that introduce judder, duplicated frames or uneven frame pacing.
- Prefer accurate clock synchronization and scheduled playback over continuous reactive corrections.
- Establish a sensible synchronization tolerance rather than constantly correcting insignificant deviations.
- Investigate low-disruption recovery methods for meaningful drift, including frame-aware corrections, limited seeks and exceptionally subtle speed adjustments where justified.
- Maintain independent recovery: buffering viewers correct locally without disturbing healthy viewers.
- Measure real frame presentation intervals, dropped/repeated frames and inter-viewer synchronization independently.
- Test 23.976, 24, 25, 30, 50 and 60 fps sources across common display refresh rates.

**Success criteria:** Achieve the lowest practical presentation-time difference between healthy viewers (ideally ≤50 ms p95) without introducing perceptible judder, stuttering or unnecessary frame drops.

**Guiding principle:** A consistent, smooth video presentation with 30 ms synchronization error is preferable to a theoretically perfect 0 ms synchronization error achieved through distracting playback corrections.

**Current increment:** Rate correction stops during buffering, seeking, hidden/offline state and local lifecycle changes. The earlier ±0.5% experiment remains gated. A second candidate requires one second of same-direction error above 100 ms, exits at 50 ms, and suppresses correction when clock uncertainty is too large. It retains ±4% gain to isolate threshold behavior. Local 24 fps Chrome/Firefox comparisons found larger post-injection p95 skew, longer low-latency rate exposure and additional Chrome native drops, so it also remains disabled by default and available to the isolated runner. The default 150 ms deadband is retained. The first opt-in Occasional jumps implementation uses 250–650 ms of same-direction error for one second, trustworthy clock estimates and a buffered destination, then waits for decoded recovery plus eight seconds before another moderate correction. It reuses local alignment and preserves independent large-error recovery. Comparative motion/skew and threshold calibration remain open, alongside the physical display/network/transport matrix. **Before the M1 release, choose the supported correction policies:** keep the ordinary default and personal Occasional jumps mode, use reproducible isolated comparisons to accept or reject the disabled gentle/precision candidates, then remove rejected implementations and their production flags/wiring from `web/playback-timing.js` and `web/watch.js`. Retain diagnostic runners only where they still test supported behavior or a documented regression; do not silently enable an unverified algorithm. Record separate skew/smoothness results in [testing status](docs/archive/testing-2026-10-22.md#frame-pacing-preservation-during-synchronization).

### M1-P7 — In-depth UI/UX review and restructure

**Media navigation and posters:** Library navigation uses movie/TV buttons in the Back/Forward/Home group, collapsing to icons before hiding at narrow widths. Collections use Tabler `layout-grid`. Unavailable poster Play overlays are hidden; caption and gradient areas open details on click or first tap.

**Media scrolling:** Browse, Home, library tabs and item navigation share a visibility-aware reveal. Partially visible content keeps its position; required jumps include the sticky header above the first row. Page, mobile and fullscreen-drawer behavior is verified with disposable browser fixtures.

**Toasts:** Reconnect and participant feedback share a compact toast component and one bottom-left video stack. The stack stays visible while scrolling and moves above visible playback controls when space allows. Visibility takes priority over avoiding controls. Toasts use a 40px card with separate action/username rows and brief entrance, exit and control-avoidance animations. Lobby layout buttons do not displace the stack. Toasts dismiss on activation; a bell control toggles normal notifications. Error toasts use the shared delete-button red, stay for 10 seconds and bypass the toggle; subtitle playback errors use this class. Subtitle controls use on/off icons with white active styling. Unavailable audio/subtitle choices show explicit labels and stay disabled, with plain Automatic and no subtitle Off choice when none are available. Missing Plex files are dimmed and labeled in Media, blocked from play/queue actions, and reported by persistent error toasts for existing queue entries. Media listings render before background availability checks; the server reuses per-item results within each Plex access scope. Queue and lifetime refinements remain open.

**Shared controls — Media (2026-10-21):** The owner approved Queue and authorized Media. Media now opts into the shared heading, toolbar, segmented and control contracts, retaining its sticky header/tools, dynamic `--media-header-height`, page/drawer scrolling, catalog/detail actions and responsive layouts. Owner mobile corrections remove the always-visible corner Play affordance, compact the phone header and toolbar, and align the two filter selects; Media detail action buttons stay as they were after owner clarification. Focused Chrome/Firefox browser checks, Room/Queue regressions and the Node suite pass. Before/after captures and limitations are in [Media verification](docs/archive/testing-2026-10-22.md#2026-10-21---shared-controls-media-increment-m1-p7). Owner visual acceptance remains pending; no deployment is authorized.

**Shared controls — Queue (2026-10-21):** The owner authorized Queue after completing Room. Queue now opts into the approved shared header, toolbar, segmented, switch, focus and spacing contracts, while retaining its specialized timeline and action behavior. Owner review identified a cramped selected view icon and nonstandard footer buttons; both are corrected on local `main`, including the follow-up requirement that disabled Clear history and Shuffle retain visible elevated backgrounds. Narrow footer wrapping and Chrome/Firefox focused and Room regression checks pass. Before/after review captures and the remaining broad-smoke limitation are recorded in [Queue verification](docs/archive/testing-2026-10-22.md#2026-10-21---shared-controls-queue-increment-m1-p7). The owner separately directed that Queue and the OverlayScrollbars branch be combined on local `main`, then approved Queue and authorized Media. No deployment is authorized.

**Shared controls — Room (2026-10-21):** Owner-approved toolbar dimensions, segmented keyboard behavior, switch visuals and panel-heading foundations are documented and implemented with opt-in shared helpers/styles. Room is the only migrated panel. Focused Chrome/Firefox checks, existing Room/popup regressions and all 447 Node tests pass; see [verification](docs/archive/testing-2026-10-22.md#2026-10-21---shared-controls-room-increment-m1-p7). Owner visual approval is pending before Queue; Media and its sticky machinery remain untouched. No merge or deployment is authorized.


The subsequent owner-directed Room Settings Permissions increment adds compact thumb rows, captions/condensed tooltips, an always-visible cosmetic Custom preset, and the merged Everyone is host row. Thumb hover substitutions are removed and standard icon backgrounds restored. See [current verification](docs/archive/testing-2026-10-22.md#2026-10-21---room-settings-permissions-matrix-m1-p7); Queue/Media migration and owner visual acceptance remain pending.

The 2026-10-22 owner follow-up removes Condensed view, keeps equal centered Host/Participant columns, replaces Choose video with Skip / replay, makes Media browsing available to all admitted viewers and splits Room columns equally. Kick-column space follows permission, and private transitions remove unassigned viewers even in Everyone is host mode. See [current verification](docs/testing.md#room-permissions-and-privacy-follow-up---2026-10-22).

Owner follow-up replaces Room quick pills with eight aligned Participant/Host rows and a naturally sized Roomies list with matching dividers and overflow expansion; mobile Settings shows both role columns without tabs. Shared thumb-button behavior is reused across Room/Settings. See [follow-up verification](docs/archive/testing-2026-10-22.md#2026-10-21---room-role-rows-and-mobile-permission-columns-m1-p7). Owner visual review still gates Queue.

The roster's leading role indicator now doubles as the authorized host action; inaccessible kick/action placeholders are removed, Kick uses karate, and ordinary-host promotions confirm their inability to demote the recipient. Chrome/Firefox and full-suite evidence is in [roster action verification](docs/archive/testing-2026-10-22.md#2026-10-21---combined-roster-role-and-host-actions-m1-p7).

Room now uses Tabler door; Roomies carries the canonical oomark with protected flat mouth geometry. Room row separators are removed and subsection contents inset downward within unchanged rows. See [icon/spacing verification](docs/archive/testing-2026-10-22.md#2026-10-21---room-door-canonical-oomark-and-subheading-spacing-m1-p7), including the separate Player smoke startup limitation.

Owner-expanded icon-spacing scope adds shared 4px clearance beyond the header, using 44px Room row slots around unchanged 40px buttons, plus gaps in tighter Queue/Media/mobile-player icon groups. Logical-group spacing and Media sticky machinery remain intact; verification is recorded in [icon button clearance](docs/archive/testing-2026-10-22.md#2026-10-21---icon-button-clearance-m1-p7).

Room's two-column content is now centered with a 500px total width cap and subtle section separators between columns/above Hosts. Medium-width browser coverage is recorded in [Room width verification](docs/archive/testing-2026-10-22.md#2026-10-21---centered-room-content-and-section-dividers-m1-p7); header/footer, row sizes and controls retain their existing behavior.

The owner then removed those separators and centered the subsection icon/text groups. Roster scrollbar space is automatic; bottom gutter padding is tied directly to the visible expand/collapse button. See [heading/gutter verification](docs/archive/testing-2026-10-22.md#2026-10-21---centered-room-subheadings-and-overlay-only-gutter-m1-p7).

The owner's subsequent Room revisions place transparent, contiguous header actions beside an ellipsized name, with controls and a participant roster in two columns. Room/Settings consistently order self first, then leader/hosts/viewers alphabetically. Updated focused browser checks and 448 Node tests pass; further participant-control guidance and visual acceptance remain pending.

The latest owner revision uses a 40/60 split, aligned nonwrapping role/name/host/kick cells, and scrolling 10/30-row rosters. Confirmed participant removal is implemented through the shared validated command engine with default-on host permission, protected leader/self, host-target restrictions and immediate manual rejoin. Focused dual-browser checks and all 450 Node tests pass; visual acceptance remains pending before Queue.

The current owner refinement changes roster heights to 8/16 rows and Room quick permissions to label-first switch pills with accent On states and switch-free read-only badges. A reusable split-action variant is prepared and fixture-tested; Queue adoption and visual acceptance remain pending. The Settings permission matrix retains its existing controls.

**Popup consistency (2026-10-20):** The seven owner-approved decisions are implemented with shared native-dialog lifecycle handling, protected drafts/destructive confirmations, modest Room Settings geometry, mobile scrolling-tab hints and fullscreen placement. Chrome/Firefox fixture coverage and remaining browser/human limitations are recorded in [verification](docs/archive/testing-2026-10-22.md#2026-10-20---popup-consistency-m1-p7). Routine implementation choices were explicitly delegated for this pass; future material changes remain owner-controlled.

**Shared lobbies and room entry speed (2026-10-19):** Home and empty-room lobbies now use the same video-sized frame and presentation. Initial browser identity/active rooms are served with the page; reopen returns its joined state in one response and commits the room/dialog transition together. Redundant chooser/entry reads and one-second saved-list reloads are removed. Local Chrome/Firefox entry checks and all 366 tests pass; real Plex preparation/network timing remains open. See [verification](docs/archive/testing-2026-10-22.md#shared-lobby-layout-and-room-entry-latency-2026-10-19).


**Room control refinement (2026-10-19):** The video lobby now exposes Join/Reopen/New directly while display modes remain available without playback. Compact permissions, creator/admin-only participant shortcuts, a single People roster, Queue-header autoplay, an auto-queue source picker and smaller mobile settings are implemented. Empty queue and countdown/badge states are cleaned up. See [verification](docs/archive/testing-2026-10-22.md#room-control-refinement-2026-10-19).

**Room flow redesign (2026-10-19):** Rooms now separates discovery, saved-room reopening and creation. Current-room identity, consistent Leave/Close/Delete labels, task-based settings, permission presets and shared queue settings are implemented. Existing policies are preserved; new Host-managed rooms grant play/pause and seeking. Private remains creator/hosts only, with invitations deferred. Chrome/Firefox fixture flows and rendered desktop/phone/theater/fullscreen checks pass; see [verification](docs/archive/testing-2026-10-22.md#room-flow-redesign-2026-10-19). Real-provider and Activity gates remain.

**Mobile navbar and appearance follow-up (2026-10-19):** Section tabs now scroll normally, while the full Media heading/navigation and search/filter/view toolbar pin together in mobile page and fullscreen Menu layouts. Synchronous header measurement preserves view-switch scroll anchors. Favicon links remain static through appearance changes and Sunrise Mode. Chrome/Firefox layout and appearance checks plus all 347 tests pass; [verification](docs/archive/testing-2026-10-22.md#mobile-media-navbar-and-static-favicon-2026-10-19).

**Watch section layout (2026-10-19):** Normal mode places Media below the video and Room/Queue in a sticky right column. Theater uses Media/Room-and-Queue columns at approximately 70%/30%, with the right column sticky. Fullscreen orders Room, Queue, Media. The room bar is inside Room; desktop panels collapse independently while mobile keeps tabs. Headers share Queue-sized spacing. See [verification](docs/archive/testing-2026-10-22.md#watch-section-layout-2026-10-19).

**Sticky Media follow-up (2026-10-19):** Opaque header/tab backing closes exposed corners and gaps. Measured mobile tab/header heights keep sticky Media navigation and fullscreen Menu toolbars separated. Chrome/Firefox layout checks and all 347 tests pass; [verification](docs/archive/testing-2026-10-22.md#sticky-media-coverage-and-mobile-tab-spacing-2026-10-19).

**Queue layout increment (2026-10-19):** Playback queue offers a centered, horizontally scrollable card timeline (history left, upcoming right), navigation/recenter controls and a remembered list layout with both sections visible. The queue spans the theater page and adapts to phones and fullscreen drawers using the existing appearance tokens, icons and permission-aware commands. Chrome/Firefox fixtures cover layout, navigation, artwork and retained queue behavior; actual Plex/Activity continuity remains open. See [verification](docs/archive/testing-2026-10-22.md#playback-queue-layout-2026-10-19).

**Login/account increment (2026-10-18):** Sign-in checking overlays an inactive watch layout. Discord and Plex have official provider icons, username-only summaries and matching remove/confirm/Connect flows; Connect stays at the right of its provider row. Removal preserves the account UUID, protects the last sign-in and invalidates prior credentials/logins. Owner matching is collapsed. See [verification](docs/archive/testing-2026-10-22.md#login-and-account-experience-2026-10-18).


**Track-menu refinement (2026-10-18):** Quality labels include 1080p/720p; automatic audio/subtitle summaries show resolved tracks, with separate track-name captions and an indication of which track Automatic uses. Selected choices retain orange text without an edge stripe. See [verification](docs/archive/testing-2026-10-22.md#player-track-menu-labels-2026-10-18).

**Owner design gate:** For further UI/UX and popup consistency work, all proposed visual types, dimensions, component boundaries, interaction changes, tests and exceptions are owner decisions. Agents must consult [the canonical design guide](docs/design-guide.md), inventory current surfaces and present explicit alternatives/questions before implementing any new standard. Owner-approved canonical popup/component types belong in that guide; roadmap tasks and prior recorded implementations alone are not authorization to select them.

**Goal:** Review the interface and complete user experience in depth, then restructure navigation, information hierarchy and interactions so common tasks are clear, consistent and easy to complete.

- Develop a coherent information architecture and reviewable flow/layout proposals, then implement the restructure in bounded increments. Use the [design guide](docs/design-guide.md) and shared styles/SVGs as the visual foundation; preserve safe DOM creation, accessibility and clear separation of shared room actions from personal settings.
- **Completed technical increment (2026-10-17):** Codec diagnostics moved to `diagnostics/` behind an explicit local developer launcher; the normal server and library expose no diagnostic page, assets or sample routes. Capability checks, reproducible samples and automated decoded playback remain available.
- **Completed first modularization increment (2026-10-17):** `web/watch-sync.mjs` owns local synchronization lifecycle, scheduled alarms, alignment/refill state and correction resets, using existing timing/buffering primitives. Synchronization tests import the module directly. Chrome/Firefox checks cover startup, quality replacement, shared seek and media recovery without changing correction policies or consent. See [verification and remaining limits](docs/archive/testing-2026-10-22.md#p7-technical-foundation).
- **First layout increment (2026-10-17):** Normal viewing places the library to the right, with the room bar and Options beneath the player. Theater enlarges the player and stacks the library below. Actual browser fullscreen and Discord Activity retain the drawer layout; Activity cannot enter theater. See [layout verification](docs/archive/testing-2026-10-22.md#watch-layout-modes-2026-10-17).
- **Layout refinement (2026-10-18):** Expanded normal content for 1080p/4K with four posters per desktop row, independent library scrolling, centered theater video above a fading room bar, 25%/75% theater Options/Library columns, username account access and a simpler library toolbar. Chrome/Firefox layout checks and isolated library/account flows pass; live Activity and owner review remain. See [refinement evidence](docs/archive/testing-2026-10-22.md#watch-layout-refinement-2026-10-18).
- **Player controls increment (2026-10-18):** Two-row mobile transport, edge-to-edge landscape player, settings drop-up/full dialog, CC toggle, quality badges and bounded touch seeks/auto-hide are implemented. Room options exclude personal Sync correction; theater dims all content below the player and is unavailable on mobile. Chrome/Firefox interactions and decoded track checks pass; physical touch devices and real Activity remain verification gates. See [player evidence](docs/archive/testing-2026-10-22.md#player-controls-and-mobile-settings-2026-10-18).
- **Browser player preferences (2026-10-22):** Remember personal volume/mute and video settings, default volume to 30%, and retain explicit quality separately from the best available output at or below its resolution/bitrate ceiling; Original eligibility uses bitrate only. Subtitle language persists across videos; audio language and subtitle timing do not. Explicit Original remains Original. See [verification](docs/testing.md#browser-player-preferences---2026-10-22).
- **Library responsiveness correction (2026-10-18):** Poster counts adapt to library width. Only wide normal layouts beside the player use independent library scrolling; theater/narrow libraries scroll with the page. The pinned sidebar heading covers the top padding to prevent artwork leaking above it. Theater Room options remain sticky alongside the library; its quiet Back to top action and accepted Play selections return to the player. Follow-up restores saved normal/theater mode before rendering, exits fullscreen into theater on request, adds outside-drawer dismissal/external close, and pins theater library navigation with truncated breadcrumbs and theater-only Back to top.
- Modularize the client application without frameworks or build tools: refactor monolithic scripts (`web/watch.js`) into focused native ES modules (`watch-player.js`, `watch-sync.js`, `watch-activity.js`, `watch-ui.js`) using standard `<script type="module">`.
- **Lobby library increment (2026-10-18):** Room options remain faded and disabled outside a room while the authenticated library stays accessible. Library Play opens a public/private room creator and accessible active-room chooser; joining preserves existing playback. Chrome/Firefox fixture flows and layout checks pass; real Activity/provider checks remain open. See [lobby verification](docs/archive/testing-2026-10-22.md#lobby-library-and-room-chooser-2026-10-18).
- Validate discoverability and task completion with representative user journeys. Inspect rendered surfaces across supported layouts and verify that focus, menus, dialogs and player controls remain usable without disrupting playback.


### M1-P9 — Browser rendering for styled and bitmap subtitles

**Outcome:** Each viewer can select faithful ASS/SSA, PGS and VobSub subtitles without forcing a video conversion solely for subtitle burn-in.

- Keep the existing video player, controls, shared timeline and native SRT/WebVTT path. Use one subtitle controller with lazy-loaded JASSUB for ASS/SSA and libbitsub for PGS/VobSub; only the selected renderer runs.
- Deliver original tracks, VobSub indexes/palettes and ASS fonts through viewer-authorized resources. Bound extraction, downloads, caches and worker lifetimes; never expose Plex credentials or use another viewer's access as authority.
- Preserve authored layout, personal delay and picture transforms across track changes, pause/seek, quality replacements, late joins and recovery. Keep video outputs reusable across different browser-rendered subtitle selections.
- Retain explicit Plex burn-in fallback when original resources or browser capabilities are insufficient. Verify video-only PIP limitations and actual Discord Activity delivery without requiring cross-origin isolation globally.
- Self-host pinned worker/WASM/font assets with narrow CSP changes and complete upstream notices/source obligations. Validate difficult ASS fonts/signs/karaoke, PGS compositions and VobSub palettes in both Chrome and Firefox, and in real Activity.

**Status: Implementation complete; verification and licensing pending.** Authorized original-resource delivery, bounded embedded stream-copy/font extraction, lazy JASSUB/libbitsub integration and explicit Plex burn-in fallback are implemented and deployed. Firefox/Chrome fixtures cover external and embedded ASS/PGS/VobSub, full initialization, paused repaints, personal delay, transforms and overlay cleanup. Rendering mode persists across track changes, cancelled retries no longer block loading, and ASS uses transparent Canvas2D composition. The owner confirmed PGS and VobSub work and subsequently confirmed normal loading after the ASS fix. Remaining gates are complex authored subtitles/fonts, quality replacement/recovery and mixed-viewer lifecycle checks, actual Discord Activity/mobile coverage, broader real-source/resource testing, and third-party licensing/font provenance/corresponding-source review. The phase remains open until those gates are satisfied. See [testing](docs/archive/testing-2026-10-22.md#browser-subtitle-rendering-m1-p9).

**Done:** Intended subtitles survive the declared lifecycle/layout matrix with bounded resources and per-viewer access, with honest fallback behavior and recorded rendering evidence. This phase implements the subtitle portion of M1-P3 and delivery choices in M1-P2; it does not replace the video engine or authorize deployment.

### M1-P10 — Transition "session" terminology to "room"


- Inventory and rename all user-facing instances of "session" in the web UI, dialogs, status toasts, Discord bot command options/descriptions (`/ubu`, `!ubu`), and Discord Activity lobby views to "room" (e.g. "Room Lobby", "Create Room", "Room Settings").
- Reserve the technical term "session" strictly for low-level connection and auth contexts: HTTP cookie sessions, WebSocket connection sessions, and Plex transcode sessions.
- Update user documentation, developer docs, protocol fixtures and tests to use only canonical room terminology. Replace alias-acceptance tests with rejection/no-reintroduction coverage; this is an intentional breaking change to private pre-release clients.


### M1-P11 — Architecture hardening: persistence unification, event-loop protection and fault isolation

**Goal:** Consolidate server persistence, protect the single Node.js event loop from synchronization-blocking latency spikes, and isolate component failures.

- **Event-loop latency protection:** Keep the high-frequency playback/tick loop free from synchronous disk I/O and CPU-bound cryptography. Audit `DatabaseSync` calls and `AES-256-GCM` token encryption/decryption (`credentialVault`) to ensure they only execute during infrequent operations (auth/linking) or offload via asynchronous task batching, safeguarding the ≤50ms p95 sync target in M1-P5.
- **WebSocket-native room operations:** Keep authenticated room negotiation, viewer preparation, state changes, commands, readiness and observations on WebSockets. The dispatcher in `server/watch-socket.js` calls transport-neutral operations directly. Obsolete authenticated HTTP **room-control** endpoints and compatibility routing are retired; the setup client and integration tooling use sockets. Retain HTTP for login/account bootstrap, library/catalog requests as needed, media/artwork/health and other genuinely request-response resources; do not duplicate business logic or weaken authentication, revocation, epochs or acknowledgements.
- **Stream fault isolation:** Rejected periodic media access checks in direct Plex and local demo streaming paths now end only the affected stream. Regression checks cover rejected login renewal, timer cleanup and a subsequent authorized resource request.
- **Fault isolation and resilience:** Enforce strict error boundaries and circuit breakers around external integrations (`discord.js` gateway/REST client, Plex API requests) so external outages or rate limits do not crash or stall active rooms. Enforce hard execution timeouts, stdio drain safeguards, and memory caps on spawned FFmpeg child processes (`server/av1.js`).

**Success criteria:** SQLite is the sole runtime persistence for accounts and native history, without private pre-release JSON/schema import paths; existing owner state is handled deliberately. Disk I/O and credential crypto introduce no measurable jitter in sync tick intervals. Watch room operations run through transport-neutral services and authenticated WebSockets rather than HTTP-shaped adapters or public HTTP control aliases; third-party network failures fail gracefully without disrupting unaffected rooms.

**Status:** Runtime SQLite reads use an in-memory mirror with bounded, atomic worker writes to the same database; credential reads are cached and unchanged logins are not re-encrypted by lifecycle sweeps. The watch client uses authenticated, bounded WebSocket requests and server pushes, with revision ordering, independent clock exchanges, current permission checks and off-by-default reconnect consent. Plex and Discord requests have failure boundaries/deadlines and circuit breakers; bot startup failure leaves HTTPS available. AV1 tools enforce hard timeouts/output limits, drain pipes and enforce a sampled 1 GiB process-memory ceiling. Local regression, latency and browser recovery evidence is recorded in [M1-P11 verification](docs/archive/testing-2026-10-22.md#architecture-hardening-m1-p11). Pre-release JSON/schema imports and the HTTP compatibility/adapter layer are removed. A matched offline baseline backup/restore fixture passes with preserved UUIDs and original key bytes. Real Activity/proxy WebSockets, operator backup/restore and hardware/resource ceilings remain release checks; this work does not authorize deployment.

### M1-P12 — Rich viewer telemetry, sync health and room presence

**Goal:** Transform the viewer list and player surface into a rich, transparent, and empathetic social watch interface, providing live sync status, stream pipeline visibility, and subtle presence cues.

- **Playhead avatar indicators on the timeline:** Render subtle viewer avatar pips directly on the timeline scrubber. Cluster avatars on the playhead when viewers are in sync; detach and display trailing pips when a viewer is buffering or recovering so the room visually understands who is catching up without voice chat confusion.
- **Interactive viewer cards:** Expand the viewer roster so hovering or clicking any viewer reveals a detailed telemetry popover: live sync offset (±ms), forward buffer health (seconds cached), stream delivery path (Direct Play vs. HLS/AV1 Transcode vs. Shared Conversion Pool), active personal audio/subtitle track choices, and client surface (browser/device).
- **Empathy buffering micro-toasts & host pause prompt:** When a viewer encounters a buffer stall during playback, display a discreet, non-blocking toast (e.g. `Alice is buffering at 01:24:12`). Provide the room host with a gentle one-click voluntary pause prompt (`[Pause for Alice?]`) while upholding the core rule that healthy viewers never freeze automatically. Display a confirmation when the viewer catches up.
- **Host "Stats for Nerds" overlay (HUD mode):** Add a toggleable HUD (e.g., via keyboard shortcut or header icon) showing a live multi-viewer skew radar, active server FFmpeg transcoding processes/QSV hardware utilization, shared transcode pool efficiency, and real-time outbound bandwidth metrics per viewer.
- **Subtle presence cues:** Display lightweight presence indicators in the roster, including local player mute status (to avoid asking if someone heard dialogue) and optional on-pause cursor/ping markers for pointing out on-screen details.

**Success criteria:** Viewers and hosts can immediately observe room synchronization, delivery pipelines, and buffer health at a glance without verbal back-and-forth; server resource consumption is transparent to operators; social presence is deepened while preserving the cinema layout and independent playback boundaries.

**Status:** Initial playback sync-quality indicator implemented for the main Room participant list only. It derives a rolling 30-second score from p95 excess presented-frame error and measured rebuffering; existing RTT samples and clock validity qualify measurement availability, while jitter remains diagnostic and does not directly lower the score. It publishes a compact ephemeral score through the authenticated viewer socket. Local tracker/socket tests and the focused Chrome/Firefox Room roster smoke pass. Broader P12 timeline indicators, viewer cards, buffering prompts, resource HUD and presence cues remain open; real Plex/Activity conditions and human readability acceptance remain unverified. See [current verification](docs/testing.md#room-synchronization-quality-indicator-2026-10-22).

### M1-P13 — Persistent rooms and playback queues

Room creation now suggests a title-cased Ubumfa name and uses that suggestion for blank input; custom names remain editable. The reusable Ubumfa word generator also supports positive-length and multiword output via `generateName(3, 6, 3)`, while the six-letter room suggestion stays unchanged; guest passes and room codes are unchanged.

Queue UI follow-up: portrait poster cards, a centered chronological List, separate Auto-play/Auto-queue controls, history removal, consistent Media view names and Browse media feedback are implemented locally. First additions select empty playback while honoring Auto-play. Browser and regression evidence is recorded in docs/testing.md. Room permission presets now use Host control, Play/Pause and Queue, save immediately in Settings, and keep participant management locked off. The timeline now tracks its centered selection, supports directional section navigation and neutral empty states, and provides explicit discard/stop or discard/advance controls for Now playing.

**Status:** P13-1 through P13-5 are implemented and locally verified, including durable rooms/permissions, live integration/Admin mode, manual/bulk queues, following/random generation, shuffle and cancellable autoplay. The full automated suite passes 344 tests with zero failures/skips; Chrome and Firefox room smoke flows pass. P13-6 UI completion/review and P13-7 real Plex/Activity continuity, resource measurements and retained-state verification remain open. No deployment or retained-state transfer has occurred.

**Requested outcome:** Create a named room or reopen one you created/explicitly host; authorized server administrators can opt into top-bar Admin mode for creator rights in every room. Closing preserves current video/position, upcoming queue and room history. Support creator > host > viewer permissions, operator defaults/admin identities, full participant permissions in one action, creatorship transfer, movies/shows/seasons/episodes, following/random auto-queue and queue shuffle.

**Design:** Keep live playback in memory and save room identity, explicit hosts, permissions, bookmarks and later queue occurrences in existing SQLite/writer. Reopen one live instance with fresh authority/epochs and paused playback; never restore consent, streams, viewers or commands. Separate durable roles from live control; pause without a host unless Continue without host is granted. Distinguish Leave, saved Close and permission-checked confirmed Delete. Closed rooms do not consume active playback slots.

- **Implemented P13-1 core:** `server/room-policy.js` and `server/room-store.js` cover granular role/default policy, creator-only role/permission management, full ordinary participant rights, assigned-host/admin-only restore data, canonical account merges/revocation, rename/visibility/delete, creator transfer and separate bookmark/settings revisions.
- **Implemented P13-2 live integration & Admin mode:** `server/watch-rooms.js`, `web/watch-rooms-ui.js`, live WebSocket integration, save/reopen, close/delete, Admin mode integration, and independent room settings management.
- **Implemented P13-3 queue backend & UI slice:** `server/room-queue.js`, `web/watch-queue-ui.js`, `web/watch-library.js`. Flat ordered queue with occurrence UUIDs, optimistic concurrency via `queueRevision`, Up Next list with ranks/reordering/removal/clear, History with outcome badges/resume/start-over/clear, library "Add to queue" buttons, Next/Previous queue coordination, and Safe-DOM UI rendering.
- **Implemented P13-4:** Atomic paginated show/season expansion, room-unfinished/Specials filters, following/random generation with persistent cycles and pending-only shuffle.
- **Implemented P13-5:** Verified decoded ending evidence, announced ten-second cancellable autoplay/off switch, fenced atomic advancement and successor generation. Failed preparation preserves the queue; shutdown waits for committed transitions.
- **P13-6 queue presentation (2026-10-19):** Centered history/current/upcoming cards, list columns, saved view selection, navigation, authenticated lazy artwork, responsive theater/phone/drawer layouts and existing queue actions are locally verified in Chrome and Firefox. Remaining P13-6/P13-7 live-provider and Activity gates stay open.
- **P13-6 interaction follow-up:** Shared validation now accepts pending-entry Play now/Skip to, Skip to retains contiguous ranks, and explicit history replay consumes the selected row into a fresh occurrence. Direct controls, movement with scroll following, wheel navigation, matching history/upcoming rows, start-time estimates and coherent queue/current rendering pass expanded Chrome/Firefox checks and all 345 automated tests. See [verification](docs/archive/testing-2026-10-22.md#queue-selection-replay-and-interaction-follow-up-2026-10-19).
- **P13-6 mobile/navigation follow-up:** Equal-width Room/Queue/Media tabs replace mobile stacking; shortened headings and monochrome Room/Media icons accompany the fullscreen Menu. Native vertical wheel behavior is restored. Current Skip and history Go back to use existing validated playback paths; Go back restores newer history/current playback ahead of pending items. All 347 tests pass, with browser checks and remaining live gates recorded in [verification](docs/archive/testing-2026-10-22.md#mobile-section-tabs-names-and-queue-return-controls-2026-10-19).
- **P13-6 room setup and queue presentation:** Prospective settings remain local until creation; closed rooms edit playback configuration before reopening. Creation/footer actions, explained presets and always-visible cosmetic Custom accompany compact counted queue arrows, styled List rows, mobile tab/scroll continuity and equal intermediate panel widths. Evidence is recorded in [testing](docs/testing.md).
- Keep auto-queue generation separate from automatic playback. Continue P13-6/P13-7 real Plex multi-viewer and Activity continuity checks, including provider failures and writer/sync/resource measurements.
- Verification covers Chrome/Firefox normal/theater/fullscreen/mobile surfaces; real Activity evidence tracked separately.

**Implementation sequence:** P13-0 decisions recorded; P13-1 record/permission core implemented for review; P13-2 live lifecycle/Admin-mode/checkpoint integration; P13-3 manual queue/history/navigation and Queue UI slice; P13-4 bulk/generation/shuffle; P13-5 cancellable/off-switch autoplay; P13-6 remaining UI alongside usable backend slices; P13-7 continuity/regression/operator documentation. The detailed plan defines handoff boundaries and unfinished checks. No deployment or retained-state transfer has occurred.

**Done:** An authorized cohost can reopen the same named room after close or server restart at its committed bookmark, edit/play the same queue and inspect past outcomes. Private listings, revocations/account merges, concurrent edits/reopens, duplicate endings, crash recovery and storage/preparation failure behave truthfully. Browser/Activity and real Plex evidence, remaining limits and schema/backup checks are recorded before support claims.

Details: [implemented core, recorded owner decisions, remaining design and increment gates](docs/rooms-and-queues.md). Evidence and limitations: [P13-4/P13-5 verification](docs/archive/testing-2026-10-22.md#bulk-queues-generation-and-cancellable-autoplay-p13-4--p13-5-2026-10-18).

### M1-P14 — Configuration, administration and account authorization

**Status:** Configuration and policy implementation includes private YAML, validated provider/password/Plex-server admission, explicit fallback sharing/dedicated token, Activity-only viewing with account-linking handoff, single-room fixed ownership/reset, media-tool PATH discovery, Plex-policy-aware conversion switches, explicit local encoder/output selection and job limits. YAML remains the sole configuration authority. Browser/fixture coverage and remaining live checks are recorded in testing.md. The in-app administration panel, broader account-security work and guest passes remain planned; review the storage/editing contract before adding mutable settings.

**Outcome:** Operators can understand and deliberately control who signs in, enters rooms, receives media and administers the installation, with consistent behavior in the web app, Discord Activity and bot. Users retain one stable account and a secure, understandable way to manage connected identities.

- **Configuration and admin panel:** Inventory current settings, defaults, secrets, ownership and restart requirements. Define validated settings, protected secret handling, operator bootstrap/recovery with Plex-only or Discord sign-in, effective-policy previews, durable audited changes and live revocation. Distinguish server administration from room hosts and the existing opt-in Admin mode. Preserve a recovery path when disabling a provider.
- **Explicit authorization:** Independently choose available login methods (Plex, Discord or either) and admission requirements (Plex access, Discord membership/roles, both or an invitation). Require personal Plex entitlement by default; sponsored media requires an explicit operator grant with a source/library/item ceiling. Absence, removal, expiry or revocation of a provider must never silently broaden access. Apply canonical-account deny rules and current policy across all media/catalog/caption/artwork and control surfaces.
- **Sensitive account changes:** Require recent proof of the initiating account before linking, unlinking or merging, plus proof of any incoming provider. Preserve conflict rejection, canonical UUIDs and last-usable-login checks; show identity/role/history effects, provide session revocation and test stale/concurrent operations. Keep ordinary watching and authorized Activity-to-web handoff usable without treating every transition as a new sensitive account change.
- **Discord Activity and Open in web app:** Preserve Discord login and the existing authorization-based browser handoff. Also support Plex-only admission with verified Discord Activity context and securely bound Plex proof. Carry the same account and current policy through one-use, expiring handoff authorization; require confirmation for an existing browser-account mismatch. Context verification must not silently enroll a permanent login or bypass disabled providers/admission rules.
- **Names and invitations:** Seed display name from first login, allow an independently editable uburoom name and search both verified aliases as one canonical account result with collision labels/privacy limits. Extend existing UUID-based durable hosts to searchable offline assignment and provider-subject-bound pending invitations. Name changes do not change roles or Plex attribution; unlinked accounts remain separate until verified merging.
- **Guest boundary:** Define temporary room passes and operator-delegated sponsorship under the same policy. Implementation remains M2-P3; invitation permission alone does not grant Plex media, host status or server administration. Coordinate attribution with M1-P4 before guest playback is enabled.

**Next useful slice:** Use the [reporting investigation and bounded delivery evidence](docs/plex-reporting-investigation.md) as the reporting input; finish the wider configuration inventory, admission/media/role matrix, admin authority, persistence/restart behavior and safe defaults. Model Plex activity and personal-state synchronization as independent controls using the verified activity-only candidate where supported; use the verified isolated HLS association, resolve shared-producer lifecycle and external AV1 telemetry boundaries, then verify lifecycle behavior before implementing the user toggle; The AV1 natural-ending fix and focused automated tests are implemented; verify real Chrome/Firefox Plex playback, end-of-stream, rewind/replay and queue/autoplay handoff before claiming this case resolved. Initially track sponsored/guest viewers in uburoom while separately resolving truthful Plex attribution. **First implementation priority remains closing the confirmed absent/unlinked Plex-credential → owner-token fallback**, without breaking Discord sign-in or authorized Activity-to-browser handoff. Broader personal/shared-output and sponsored-source claims require their remaining consenting live checks before feature claims or guest playback.

**Done:** Operators can configure and inspect effective access through the admin panel, including Plex-only operation, without losing administration. Link conflicts, recent-auth checks, policy changes, provider revocation, account merges and browser/Activity handoff pass adversarial regression checks. Chrome/Firefox and real provider/Activity behavior are verified before support claims; guest delivery remains subject to M2-P3's separate completion gates.

Details and ordered increments: [accounts, administration and Plex reporting](docs/accounts-and-access.md). The [account-name and host-directory contract](docs/account-names-and-host-directory.md) implements canonical editable names, delegated host additions/self-demotion, leader-only reversible All hosts, ranked search and optional Discord/Plex discovery. SQLite baseline 6 and configuration v2d require explicit retained-state preparation; local fixture/browser verification is recorded, while real-provider checks and deployment remain open. Owner name-lock rules and native login are deferred.

## M2 — Future planned capabilities

The same [verification levels](#verification-routing-for-m1) apply when an M2 phase is selected. Define its required A/B/C/D methods and evidence before making support claims; planning alone does not authorize integration tests or deployment.

**Outcome:** Broaden media sources, accessibility, and frictionless room entry beyond the initial self-hosted release baseline.

These phases expand uburoom's feature set after the M1 release gates are satisfied. The priority and ordering will be adjusted as the owner's focus evolves.

### Phase map

| ID | Phase | Position | Depends on |
| --- | --- | --- | --- |
| M2-P1 | High Dynamic Range (HDR) support | Planned | M1-P2/M1-P3 delivery model and capability negotiation |
| M2-P2 | Enhanced browser Picture-in-Picture with subtitles | Planned | M1-P9 browser subtitle rendering |
| M2-P3 | Guest room passes | Approved for future work; after authorization and reporting foundations | M1-P14 explicit grants/admin configuration, M1-P4 attribution contract and M1-P13 room roles |
| M2-P4 | Rudimentary uburoom-hosted video library | Planned | M1-P2 direct playback and local storage |
| M2-P5 | Shared YouTube video playback | Planned | M1-P5 synchronization engine and M1-P8 protocol split |
| M2-P6 | Web Audio dynamic range compression (Dialogue Boost / Night Mode) | Planned | M1-P3 audio playback pipeline |
| M2-P7 | Self-hosting installation validator (`--doctor` CLI check) | Planned | M1-P11 configuration and storage unification |
| M2-P8 | Official containerization (Docker & Docker Compose) | Planned | M2-P7 configuration validation |
| M2-P9 | Discord voice channel presence and room invite embeds | Planned | M1-P10 room terminology and Discord bot integration |

### M2-P1 — High Dynamic Range (HDR) support

**Goal:** Deliver faithful HDR content (HDR10, Dolby Vision) across supported displays and conversion paths.

- Detect display and client HDR capabilities via browser media capabilities APIs.
- Handle HDR-to-SDR tone mapping dynamically on server transcoding paths when viewers on SDR displays watch HDR sources.
- Support direct passthrough of HDR streams to capable browser targets without color banding, clipping, or incorrect color space signaling.

### M2-P2 — Enhanced browser Picture-in-Picture with subtitles

**Goal:** Allow viewers to watch in browser Picture-in-Picture (PiP) mode without losing active subtitles.

- Address native `<video>` PiP limitations that strip HTML/canvas-rendered subtitles (ASS/SSA, PGS, styled captions from M1-P9).
- Implement subtitle-aware PiP using the Document Picture-in-Picture API where supported, or canvas video-stream compositing as a fallback.
- Preserve viewer-selected subtitle styling, positioning, and language tracks within the PiP surface.

### M2-P3 — Guest room passes

**Goal:** Enable frictionless room entry via temporary invite codes without requiring Discord OAuth or linked Plex accounts.

- Allow room hosts to generate temporary, time-bounded guest invite codes or shareable links only within operator-delegated authority. Keep room invitations and explicit sponsored media grants separate; guests without Plex entitlement cannot receive an implicit owner-token fallback.
- Grant guest viewers synchronized playback, personal volume, and audio/subtitle track choices within the room.
- Maintain safe permission boundaries: guests cannot manage room settings, transfer host status, access Plex server libraries, or view private credentials.
- Use revocable room-scoped passes with hashed high-entropy tokens, expiry, atomic redemption/use limits, attendance/concurrency ceilings and bounded reconnect. Mark guest names as unverified; rate-limit redemption and prevent a forwarded pass from claiming a named host invitation.
- Revocation must stop existing sockets and media/caption/artwork grants. Cap guest authority independently of generous room participant presets; require fresh provider proof for conversion to a regular account.
- Keep local guest playback identity/progress separate from Plex source activity and personal watch-state writes. Resolve the [M1-P4 investigation's](docs/plex-reporting-investigation.md) still-unverified PMS sponsored-viewer attribution and watch-state side-effect questions before enabling guest media; never impersonate a guest as the Plex owner.

**Done:** Operators can deliberately allow limited guest viewing, inspect its actual uburoom/Plex reporting behavior and revoke it during playback. Expired, reused, forwarded and concurrently redeemed passes fail within defined limits, and personal Plex restrictions and host/admin boundaries remain intact. See [guest requirements](docs/accounts-and-access.md#guest-passes).

### M2-P4 — Rudimentary uburoom-hosted video library

**Goal:** Allow streaming video files directly from local server folders without requiring a Plex Media Server.

- Provide a lightweight directory/file scanner for operator-configured media directories.
- Support direct file playback and basic transcoding for supported container/codec combinations.
- **Explicit non-goal:** Not a full Plex replacement. Does not include metadata scraping, poster generation, TV/movie matching, or complex watch-state tracking; strictly intended as a simple file-and-folder video player for rooms.

### M2-P5 — Shared YouTube video playback

**Goal:** Allow watch rooms to load and synchronize public YouTube videos.

- Support pasting YouTube URLs in rooms to initiate shared viewing.
- Integrate the YouTube IFrame Player API with uburoom's server-authoritative playback timeline and sync engine.
- Coordinate play, pause, seek, and rate adjustments across viewers while respecting YouTube embed constraints and viewer-local ad/buffering states.

### M2-P6 — Web Audio dynamic range compression (Dialogue Boost / Night Mode)

**Goal:** Solve the "whisper quiet dialogue, deafening explosions" problem in downmixed multi-channel audio tracks.

- Implement a client-side Web Audio `DynamicsCompressorNode` processing graph attached to the `<video>` element.
- Expose an intuitive user toggle in the player audio settings (Off / Dialogue Boost / Night Mode).
- Ensure zero server CPU overhead, zero external dependencies, and seamless compatibility with personal volume and mute controls.

### M2-P7 — Self-hosting installation validator (`--doctor` CLI check)

**Goal:** Provide single-command validation for self-hosters to verify their environment, permissions, and network integrations before startup.

- Add a CLI diagnostic flag (`node server/index.js --doctor` or `npm run check`).
- Automatically verify `config.yaml` settings, credential key file location and restrictive permissions, Plex server connectivity and token validity, Discord bot gateway connection and application guild settings, TLS certificate/key pair validity, and local FFmpeg/FFprobe availability.
- Provide actionable, human-readable troubleshooting steps when a verification check fails.

### M2-P8 — Official containerization (Docker & Docker Compose)

**Goal:** Simplify deployment for homelab, NAS (Unraid, TrueNAS, Synology), and Linux server operators.

- Provide an official, minimal Alpine/Debian-slim `Dockerfile` and `docker-compose.yml`.
- Standardize volume mounts for persistent data (`/data`) and external credential keys outside the container root.
- Support optional hardware acceleration passthrough (`/dev/dri` for Intel QuickSync AV1/H.264 transcoding).

### M2-P9 — Discord voice channel presence and room invite embeds

**Goal:** Make rooms easily discoverable from Discord voice channels without manual link sharing.

- When a room begins playback, automatically post a rich Discord embed in the matched text/voice channel featuring media metadata (title, poster, year, duration) and a one-click "Join Room" button.
- Update bot status and rich presence dynamically with current watching activity.
- Automatically update or clean up the active embed when the room session ends or media changes.

## Future direction and decisions still open

These are already identified directions or placeholders, outside the current delivery sequence. Define a small scope when the owner selects one.

| Direction | Current boundary |
| --- | --- |
| Native-player integration | Future milestone. Establish the integration and control contract while preserving the shared engine, account scopes and consent lifecycle. |
| Project-hosted rooms and managed room URLs | Future work in the specification. Self-hosting remains the current product; hosting and account/isolation responsibilities need a separate scope. |
| Live TV/DVR | Separate feasibility work for live manifests, moving seek windows, tuning and authorization. On-demand video coverage does not imply live support. |

## How agents should use and maintain this roadmap

1. Read this map and the linked detail/status documents for the assigned area. The owner's current request takes priority; roadmap entries are not instructions to implement every listed feature.
2. Work on one bounded increment with a clear user-visible outcome and relevant evidence. Name its milestone and phase ID (for example, `M1-P1`) in a work summary when useful; do not create a parallel task tracker or duplicate the full plan.
3. Distinguish implementation from verification. Reuse existing results where applicable, reproduce a specific gap, and add meaningful checks. Record failures, unsupported cases and unfinished validation in `docs/testing.md`; commands belong in `docs/development.md`.
4. After a material increment, update only the affected milestone/phase status or next slice and its detail documents. Keep this file short enough to scan; put completed evidence in testing status and code history.
5. Keep private decisions, deployment instructions and identifying evidence out of public planning files. Explicit suggestion audits use their separate personal review workflow; ordinary assigned tasks and casual advice do not populate suggestion queues. Declined ideas do not become planned work through consolidation.
6. Assign required A/B/C/D verification methods to each new or materially changed gate, and link its actual pass/fail/blocked/not-run evidence in `docs/testing.md`. Do not treat a lower-evidence method as closing a real-provider or human-acceptance gate.

## Document map

| Document | Owns |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | Broad priorities, milestone and phase status, sequencing and open directions |
| [SPEC.md](SPEC.md) | Product behavior and enduring boundaries |
| [Playback reliability plan](docs/playback-reliability.md) | Detailed playback architecture, requirements, corpus and proposed performance targets |
| [Persistent rooms and queues](docs/rooms-and-queues.md) | M1-P13 implemented core, recorded lifecycle/role/admin/queue decisions, remaining integration and ordered increments |
| [Accounts, administration and Plex reporting](docs/accounts-and-access.md) | M1-P14 configuration/admin/security model, M1-P4 personal/sponsored reporting, account names/invitations and M2-P3 guest boundaries |
| [Plex reporting investigation](docs/plex-reporting-investigation.md) | Read-only Plex API/code evidence, scenario capability matrix, personal vs sponsored reporting recommendations, authorization/admin implications and consenting live-test gates |
| [Testing status](docs/testing.md) | Actual evidence, limitations, deferred failures and remaining verification |
| [Development](docs/development.md) | Reproducible local/isolated commands and fixture prerequisites |
| [Design guide](docs/design-guide.md) | Established interface and asset rules |
| [Self-hosting](docs/self-hosting.md) / [upgrading](docs/upgrading.md) | Operator setup, state/key preservation and upgrade procedures |
| [Third-party review](docs/third-party.md) | Licensing, notices and asset provenance gates |
