# uburoom roadmap

Updated: 2026-10-19.

uburoom is a self-hosted Plex watch-together app for browsers and Discord Activity. The YouTube TV remote is maintained in the independent uburoom-remote repository, with versioned integration and remaining live verification tracked in M1. The goal is simple: choose a title and watch together, with the intended picture, audio and subtitles surviving ordinary failures.

This is a working map for one maintainer and their agents. Milestones define broad outcomes; phases are the smaller bodies of work within each milestone. Plan in small, useful increments within these phases. The order can change with the owner's priorities; there are no sprint commitments or promised release dates. This document consolidates existing plans, not new feature approvals or permission to deploy them.

## Where we are

The shared player, room timeline, linked accounts, per-user Plex access, command engine and remote consent model are implemented. Personal tracks, buffered rewind, bounded recovery, private HLS session refresh and short same-tab reconnect are also present. Synthetic browser tests include two-hour playback runs and decoded picture/audio/caption checks.

The main gap is evidence and completeness across real Plex sessions, Discord surfaces, content combinations and devices. A first two-hour real Plex HLS browser baseline is recorded, with one observed automatic unload/recovery and unresolved process memory growth. Passing a fixture or receiving a command acknowledgement does not establish live playback support. See [current verification and known gaps](docs/testing.md); keep detailed results there rather than copying them into this roadmap.

## Architecture to preserve

| Boundary | Direction |
| --- | --- |
| Service and state | Keep one Node process, ordinary JavaScript, built-in SQLite and minimal dependencies. Develop on local disk; keep runtime state and credentials private. Keep device, login and playback-history persistence in SQLite, while removing private pre-release migration paths before the first public release. Protect the single event loop from synchronous disk/crypto spikes during playback synchronization. |
| Room and viewer | The server owns the shared item timeline and playback intent. Each viewer owns their quality, audio, subtitles, volume and authorized media stream. M1-P13 durable records, live-room integration, queues, generation and cancellable autoplay use the existing SQLite writer; real Plex/Activity continuity checks remain. Current viewing rooms are still process-local. Preserve native playback history for future per-viewer Plex watch-state reporting. |
| Commands and access | Every control surface uses the shared validated engine. Recheck current access around awaited operations, reject stale work, and keep remote consent off after disconnect/restart. |
| Media delivery | Grow the existing direct, Plex HLS and optional AV1 paths into measured source/track/capability negotiation. Share output only when content and authorization boundaries allow it. Make authenticated WebSockets the native room-control transport; retain HTTP where appropriate for auth/bootstrap, catalog, artwork, media and health. |
| Interfaces | Preserve the existing design, safe DOM components and shared remote styles/icons. Chrome and Firefox are equal required web test targets, alongside real Discord Activity coverage. Keep a single primary `/watch` entry point after the remote split, and keep diagnostics/experimental tools outside normal viewer navigation. Maintain native ES modularity in the browser without bundlers or frameworks. |

The [product specification](SPEC.md) and [project instructions](AGENTS.md) define the enduring rules. These milestones do not call for a service split, a framework rewrite or a new dependency stack.

## M1 — Verified self-hosted release

**Current milestone. Outcome:** Another person can install the first public uburoom release safely, preserve state across supported future upgrades, and understand exactly what is supported. Private pre-release revisions have no promised upgrade path.

- Verify a clean installation on an unrelated host/origin with separate provider applications and fresh profiles. Test backup/restore, stable account UUIDs and exact original encryption-key preservation for retained state, code/state separation and rollback. The sole pre-release installation may be reset or manually transferred with an explicit backup; do not add compatibility migrations solely for it or silently discard its data.
- Verify restricted/revoked Plex access, linked accounts, `/ubu` and `!ubu`, real Activity setup and the claimed browser/transport combinations without owner-token fallback.
- Complete real Firefox/YouTube TV lifecycle, consent, latency and configured-origin checks. The known full extension smoke failure remains deferred; preserve that exception explicitly and do not weaken permissions or throttling to conceal it.
- Finish branding/artwork/media provenance, dependency notices and GPL-3.0-only distribution review. Switch `scripts/build-demo-media.js` to approved current branding and remove `assets/branding/old/` from the active source before packaging; retain prior artwork in Git history. Audit source, full publication history, assets and ZIP contents for private material; include LICENSE and required notices.
- **Final M1 pre-release cleanup gate:** Remove obsolete `session.*`/`/api/sessions` compatibility, private pre-release JSON imports/schema upgrade paths and legacy HTTP room-control compatibility routes after their callers/tests are switched to the canonical room/WebSocket contract. Keep post-release database schema versioning and future migration capability; this is not permission to discard a public release user’s data. Complete the remote split and production-vs-diagnostic entry-point cleanup before the first public source/package cut.
- Source packaging now includes ROADMAP.md; local ZIP inventory verification confirms it is present alongside the existing private-file exclusions. Retain that coverage in later package reviews.
- Keep signing, publication, public push, provider registration and production configuration/restarts behind their existing explicit approval requirements. Public repository creation remains deferred until the brand transition is complete.

**Done for a release:** Claims match recorded evidence, required install/upgrade and provenance gates are satisfied, and audited ZIPs can be reviewed for publication. Completing a phase alone does not authorize a release.

Details: [self-hosting](docs/self-hosting.md), [upgrading](docs/upgrading.md), [attribution](docs/third-party.md), [verification gates](docs/testing.md#local-migration-checks).

### Phase map

"Now" is the current focus, "Next" is the suggested sequence, and "Later" is planned direction with details still to settle. Phase IDs use `M1-Pn` within milestone M1. Release verification runs alongside phase work and applies before publishing the corresponding support claim. The high-priority frame-pacing requirements in M1-P6 constrain synchronization work in M1-P5 from the outset.

| ID | Phase | Position | Depends on |
| --- | --- | --- | --- |
| M1-P1 | Prove sustained real playback and room continuity | Now; implementation exists, live coverage remains | Existing playback and fixture baseline |
| M1-P2 | Choose compatible delivery automatically | Next; partial implementation | M1-P1 measurements and complete source inventory |
| M1-P3 | Complete audio, subtitles and content fidelity | Next; first slice implemented | M1-P2 delivery model; validation can start now |
| M1-P4 | Complete the Plex viewing experience | Later; planned | Stable source/track selection and item timeline |
| M1-P5 | Real-time playback synchronization | In progress; timing instrumentation and clock estimation implemented, live targets unverified | M1-P1 diagnostics and multi-client measurements; M1-P6 frame-pacing constraints |
| M1-P6 | Frame-pacing preservation during synchronization | In progress; experimental candidates gated, disposition/production cleanup and joint live verification pending | Presentation-interval diagnostics and coordinated design with M1-P5 |
| M1-P7 | In-depth UI/UX review and restructure | In progress; normal/theater/fullscreen layout split implemented, broader UI review remains | Existing design guide, rendered surfaces and playback/permission behavior |
| M1-P8 | Separate remote extension repository and uburoom compatibility | Source, UI/assets and packaging cutover complete; local compatibility verified, full lifecycle/release verification pending | Stable command/protocol contract and cross-repository compatibility checks |
| M1-P9 | Render styled and bitmap subtitles in the browser | Implementation complete; verification and licensing pending | M1-P2/M1-P3 track delivery; existing player and shared conversion boundaries |
| M1-P10 | Transition "session" terminology to "room" | Canonical room protocol verified locally across repositories; full live surface verification pending | M1-P7 UI/UX review and command engine consistency |
| M1-P11 | Architecture hardening: persistence unification, event-loop protection and fault isolation | Local hardening and compatibility removal complete; live checks pending | M1-P1 and M1-P5 real-world measurements |
| M1-P12 | Rich viewer telemetry, sync health and room presence | Planned; elevates room awareness and host diagnostics | M1-P5 sync engine, M1-P7 UI review, and M1-P10 room terminology |
| M1-P13 | Persistent rooms and playback queues | In progress; P13-1 durable core, P13-2 live integration/Admin mode, P13-3 manual queues, P13-4 bulk/generation/shuffle and P13-5 verified cancellable autoplay implemented | M1-P11 SQLite/WebSocket foundation, M1-P7 lobby/library UI, shared timeline and recorded lifecycle/role decisions |

### M1-P1 — Sustained real playback and room continuity

**Outcome:** Long viewing sessions remain usable through ordinary delivery problems, with truthful recovery and preserved personal settings.

- Build on the first bounded **real Plex playback soak** with event-level diagnostics for its observed unload/recovery and process memory growth. Cover long pauses, cached rewind and outside-cache seeks, transcode expiry/restart, control reconnect and normal hls.js retry timing. Verify the captured audio/burned subtitle session still works after restoring saved Plex preferences.
- Measure decoded frames, intended audio/captions, stalls, drift, seek/recovery time and resource cleanup. Verify real conversion throughput, including sustained Intel QSV AV1 and simultaneous viewers; fixture software encoding does not prove hardware capacity.
- Exercise mixed transports/tracks, late joins, host transfer, tab sleep/wake, disconnect and rejoin. Tune synchronization and ongoing stall/refill policy from evidence, avoiding repeated seeks while a decoder is recovering.
- Complete real Discord Activity coverage: SDK authentication, browser handoff, proxy media/captions, identity/grant renewal, focused/grid/PIP transitions and background/return. Existing spot checks do not certify every desktop, web or mobile combination.

**Done for a declared environment:** A measured two-hour run and relevant fault/lifecycle checks preserve the intended content, shared timeline and authorization, with bounded recovery and no unexplained resource growth. Record actual limitations. Start with a controlled Plex account/media set; production interruptions and history-changing experiments need their existing authorization.

**Next useful slice:** Bounded local playback diagnostics are deployed. Short real Plex pause, rewind, outside-cache seek, injected control-poll failure, actual conversion expiry/replacement and room cleanup checks passed in Chrome; the owner confirmed intended audio/subtitles after replacement. A repeat two-hour real playback run completed without recorded stalls or unloads, retained track selections and timeline, and automatically cleaned up its room/conversion. The resource tail shows Node memory falling after cleanup and no returning test transcoder. Watch-time regressions now reproduce and fix polling-offset/client-clock artifacts and disagreement between native frame counters and continuing frame callbacks. Sanitized rejection and uncredited-interval reasons remain bounded in the client diagnostic ring; stale-observation and decoded-playback safeguards remain enforced. Focused tests, the Firefox tracking smoke and a short real Plex Chrome check pass; the live credited interval was continuous and pause earned no additional time. The saved soak trace cannot establish the exact historical rejection causes. Continue long-run accounting, live Firefox/Discord and physical network lifecycle coverage. General resource bounds, the original overnight unload trigger and the broader M1-P1 gate remain open. Details: [reliability and continuity plan](docs/playback-reliability.md), [evidence and remaining gates](docs/testing.md#watch-time-accounting-investigation), [fixture commands](docs/development.md#bounded-playback-and-recovery-check).

### M1-P2 — Compatible automatic delivery

**Outcome:** Viewers normally press Play without choosing codecs or troubleshooting conversion paths.

- **Preparation audit completed (2026-10-17):** Traced initial preparation, quality/track replacement, recovery and shared conversion ownership. Identified repeated viewer replacement lifecycle, first-source assumptions spanning tracks/delivery, and incomplete confirmation of Plex output. Isolated reproductions and 49 focused passing tests support reviewable proposals; implementation choices remain pending owner review. Preserve the existing authorization, track-restoration and lease boundaries when selecting the next increment.
- Inventory eligible content versions, files and streams instead of assuming the first media/part. Keep alternate cuts distinct; only substitute timing-compatible encodes automatically.
- Model one playback attempt from complete source, selected tracks, client capability, network observations and server capacity. Confirm the output Plex actually agreed to deliver.
- Prefer suitable direct playback, then evaluate remux/audio-only conversion before full conversion or burn-in. Keep native HLS, hls.js and custom AV1 choices explicit and tested.
- Add stable automatic quality with a user ceiling, measured network/decode headroom and useful feedback when quality changes. Cancel superseded attempts and preserve position, pause intent and personal tracks across replacements.

**Done for a declared configuration:** Known compatible cases choose a suitable path; failed candidates terminate or recover within a finite policy, without language/caption loss, credential fallback or an indefinite spinner. Calibrate startup/seek targets before claiming them as guarantees.

Details: [playback decisions and implementation order](docs/playback-reliability.md).

**Quality replacement follow-up:** Local refill and a seek guard address repeated HLS catch-up seeks; a separate preparation budget keeps polling and playback controls available during slow Plex decisions. A source-frame oracle then exposed matching clocks with pictures half a second apart after a late join or quality change: cold HLS starts normalized transport timestamps against coarse middle-of-playlist estimates. Fresh players now anchor their timestamp origin from segment zero before jumping to the current room position and refilling. Chrome/Firefox source-frame and delayed-fragment checks pass; other viewers keep their streams and timeline. Complete actual Plex/Android picture/audio validation; local evidence does not establish every reported timeout or stutter's cause. Evidence: [mid-playback quality replacement](docs/testing.md#mid-playback-quality-replacement).

**Shared conversions:** Matching Plex HLS and custom AV1 outputs now reuse work within one room/media generation across independently authorized accounts. Audio and burned subtitles participate in matching; browser text captions remain personal. Bounded anchor caching preserves the source timestamp origin for HLS late joins. Live Plex process counts and Android playback remain verification gates. Evidence: [shared room transcodes](docs/testing.md#shared-room-transcodes).

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

**Done per increment:** One complete viewing flow works across its declared surfaces, including cancellation and room synchronization. This phase is several small features, not a promise to reproduce every Plex screen at once. Details: [content fidelity and playback UX](docs/playback-reliability.md#content-fidelity-and-playback-ux).

### M1-P5 — Real-time playback synchronization — Design requirements

**Single-viewer refinement (2026-10-18):** A sole viewing tab skips startup/seek countdowns and pause/resume delivery margins while retaining decoder readiness, clock samples and drift tracking. Joining restores group coordination without interrupting ongoing playback; departure releases any remaining group countdown. Count viewing tabs rather than account identities. See [verification](docs/testing.md#single-viewer-coordination-delays-2026-10-18).

**Goal:** Minimize the actual real-world playback difference between healthy viewers so reactions over Discord voice chat don't arrive before other viewers see the corresponding event.

**Target:** Aim for ≤50 ms p95 presentation-time skew, with ≤100 ms p99 as an initial engineering target, subject to real-world testing.

**Current increment:** Authenticated WebSocket updates now carry coordinated ordinary pause/resume deadlines. A bounded 400–1,000 ms lead uses recent server-measured round trips; missed deadlines reconcile locally. Startup and shared seeks retain buffered readiness and overlap the preparation countdown. After three seconds, waiting viewers are named; after ten seconds, automatic release latches until the host starts with ready viewers, waits another fifteen seconds, or cancels. Ongoing buffering remains independent. Bounded leading HLS timestamp gaps at zero are covered by three-viewer Chrome/Firefox startup and restart checks. Default drift rate/deadband and hard-seek thresholds remain unchanged: the new sustained 100/50 ms candidate remains gated after local skew/drop regressions. A personal Occasional jumps mode now provides opt-in moderate local seeks at normal speed. Physical/geographic validation, lead and correction calibration, Firefox high-rate callback limits and subjective motion remain open. See [measurements and open gates](docs/testing.md#real-time-playback-synchronization).

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

**Verification:** Measure actual inter-viewer presentation-time skew across different network RTTs, including 20–300+ ms, and test that a buffering viewer doesn't interrupt healthy viewers. Record actual percentiles and limitations in [testing status](docs/testing.md#real-time-playback-synchronization).

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

**Current increment:** Rate correction stops during buffering, seeking, hidden/offline state and local lifecycle changes. The earlier ±0.5% experiment remains gated. A second candidate requires one second of same-direction error above 100 ms, exits at 50 ms, and suppresses correction when clock uncertainty is too large. It retains ±4% gain to isolate threshold behavior. Local 24 fps Chrome/Firefox comparisons found larger post-injection p95 skew, longer low-latency rate exposure and additional Chrome native drops, so it also remains disabled by default and available to the isolated runner. The default 150 ms deadband is retained. The first opt-in Occasional jumps implementation uses 250–650 ms of same-direction error for one second, trustworthy clock estimates and a buffered destination, then waits for decoded recovery plus eight seconds before another moderate correction. It reuses local alignment and preserves independent large-error recovery. Comparative motion/skew and threshold calibration remain open, alongside the physical display/network/transport matrix. **Before the M1 release, choose the supported correction policies:** keep the ordinary default and personal Occasional jumps mode, use reproducible isolated comparisons to accept or reject the disabled gentle/precision candidates, then remove rejected implementations and their production flags/wiring from `web/playback-timing.js` and `web/watch.js`. Retain diagnostic runners only where they still test supported behavior or a documented regression; do not silently enable an unverified algorithm. Record separate skew/smoothness results in [testing status](docs/testing.md#frame-pacing-preservation-during-synchronization).

### M1-P7 — In-depth UI/UX review and restructure

**Room flow redesign (2026-10-19):** Rooms now separates discovery, saved-room reopening and creation. Current-room identity, consistent Leave/Close/Delete labels, task-based settings, permission presets and shared queue settings are implemented. Existing policies are preserved; new Host-managed rooms grant play/pause and seeking. Private remains creator/hosts only, with invitations deferred. Chrome/Firefox fixture flows and rendered desktop/phone/theater/fullscreen checks pass; see [verification](docs/testing.md#room-flow-redesign-2026-10-19). Real-provider and Activity gates remain.

**Mobile navbar and appearance follow-up (2026-10-19):** Section tabs now scroll normally, while the full Media heading/navigation and search/filter/view toolbar pin together in mobile page and fullscreen Menu layouts. Synchronous header measurement preserves view-switch scroll anchors. Favicon links remain static through appearance changes and Sunrise Mode. Chrome/Firefox layout and appearance checks plus all 347 tests pass; [verification](docs/testing.md#mobile-media-navbar-and-static-favicon-2026-10-19).

**Watch section layout (2026-10-19):** Normal mode places Media below the video and Room/Queue in a sticky right column. Theater uses Media/Room-and-Queue columns at approximately 70%/30%, with the right column sticky. Fullscreen orders Room, Queue, Media. The room bar is inside Room; desktop panels collapse independently while mobile keeps tabs. Headers share Queue-sized spacing. See [verification](docs/testing.md#watch-section-layout-2026-10-19).

**Sticky Media follow-up (2026-10-19):** Opaque header/tab backing closes exposed corners and gaps. Measured mobile tab/header heights keep sticky Media navigation and fullscreen Menu toolbars separated. Chrome/Firefox layout checks and all 347 tests pass; [verification](docs/testing.md#sticky-media-coverage-and-mobile-tab-spacing-2026-10-19).

**Queue layout increment (2026-10-19):** Playback queue offers a centered, horizontally scrollable card timeline (history left, upcoming right), navigation/recenter controls and a remembered list layout with both sections visible. The queue spans the theater page and adapts to phones and fullscreen drawers using the existing appearance tokens, icons and permission-aware commands. Chrome/Firefox fixtures cover layout, navigation, artwork and retained queue behavior; actual Plex/Activity continuity remains open. See [verification](docs/testing.md#playback-queue-layout-2026-10-19).

**Login/account increment (2026-10-18):** Sign-in checking overlays an inactive watch layout. Discord and Plex have official provider icons, username-only summaries and matching remove/confirm/Connect flows; Connect stays at the right of its provider row. Removal preserves the account UUID, protects the last sign-in and invalidates prior credentials/logins. Owner matching is collapsed. See [verification](docs/testing.md#login-and-account-experience-2026-10-18).

**Appearance increment (2026-10-18):** Compact Light/Dark and Orange/Pink header switches apply explicit, persistent palettes across page, dialog, menu and remote surfaces. Canonical SVG branding adapts its neutral ink and accent portions; video retains black/dark chrome. Appearance changes recolor cached local SVG data URLs without network requests. Accents fade over 100 ms; rapid toggle clicks reveal the local Sunrise/dud easter eggs. Sunrise tolerates continued rapid clicking and exits on a separate click after a pause. See [appearance verification](docs/testing.md#appearance-themes-and-accents-2026-10-18).

**Track-menu refinement (2026-10-18):** Quality labels include 1080p/720p; automatic audio/subtitle summaries show resolved tracks, with separate track-name captions and an indication of which track Automatic uses. Selected choices retain orange text without an edge stripe. See [verification](docs/testing.md#player-track-menu-labels-2026-10-18).

**Goal:** Review the interface and complete user experience in depth, then restructure navigation, information hierarchy and interactions so common tasks are clear, consistent and easy to complete.

- Map and inspect end-to-end journeys: sign-in and account linking, library browsing, room creation/joining, playback and personal tracks/quality, remote permissions, browser/Discord handoff and recovery from failures.
- Identify confusing navigation, duplicated controls, hidden state, unnecessary steps, inconsistent terminology and unclear loading, empty, error or recovery feedback. Evaluate desktop, mobile and real Discord Activity layouts, including keyboard and assistive-technology use. M1-P8 now routes `/` into `/watch` and retires the standalone remote homepage; retain the watch page’s authenticated remote drawer.
- Develop a coherent information architecture and reviewable flow/layout proposals, then implement the restructure in bounded increments. Use the [design guide](docs/design-guide.md) and shared styles/SVGs as the visual foundation; preserve safe DOM creation, accessibility and clear separation of shared room actions from personal settings.
- **Completed technical increment (2026-10-17):** Codec diagnostics moved to `diagnostics/` behind an explicit local developer launcher; the normal server and library expose no diagnostic page, assets or sample routes. Capability checks, reproducible samples and automated decoded playback remain available.
- **Completed first modularization increment (2026-10-17):** `web/watch-sync.mjs` owns local synchronization lifecycle, scheduled alarms, alignment/refill state and correction resets, using existing timing/buffering primitives. Synchronization tests import the module directly. Chrome/Firefox checks cover startup, quality replacement, shared seek and media recovery without changing correction policies or consent. See [verification and remaining limits](docs/testing.md#p7-technical-foundation).
- **First layout increment (2026-10-17):** Normal viewing places the library to the right, with the room bar and Options beneath the player. Theater enlarges the player and stacks the library below. Actual browser fullscreen and Discord Activity retain the drawer layout; Activity cannot enter theater. See [layout verification](docs/testing.md#watch-layout-modes-2026-10-17).
- **Layout refinement (2026-10-18):** Expanded normal content for 1080p/4K with four posters per desktop row, independent library scrolling, centered theater video above a fading room bar, 25%/75% theater Options/Library columns, username account access and a simpler library toolbar. Chrome/Firefox layout checks and isolated library/account flows pass; live Activity and owner review remain. See [refinement evidence](docs/testing.md#watch-layout-refinement-2026-10-18).
- **Player controls increment (2026-10-18):** Two-row mobile transport, edge-to-edge landscape player, settings drop-up/full dialog, CC toggle, quality badges and bounded touch seeks/auto-hide are implemented. Room options exclude personal Sync correction; theater dims all content below the player and is unavailable on mobile. Chrome/Firefox interactions and decoded track checks pass; physical touch devices and real Activity remain verification gates. See [player evidence](docs/testing.md#player-controls-and-mobile-settings-2026-10-18).
- **Library responsiveness correction (2026-10-18):** Poster counts adapt to library width. Only wide normal layouts beside the player use independent library scrolling; theater/narrow libraries scroll with the page. The pinned sidebar heading covers the top padding to prevent artwork leaking above it. Theater Room options remain sticky alongside the library; its quiet Back to top action and accepted Play selections return to the player. Follow-up restores saved normal/theater mode before rendering, exits fullscreen into theater on request, adds outside-drawer dismissal/external close, and pins theater library navigation with truncated breadcrumbs and theater-only Back to top.
- Modularize the client application without frameworks or build tools: refactor monolithic scripts (`web/watch.js`) into focused native ES modules (`watch-player.js`, `watch-sync.js`, `watch-activity.js`, `watch-ui.js`) using standard `<script type="module">`.
- **Lobby library increment (2026-10-18):** Room options remain faded and disabled outside a room while the authenticated library stays accessible. Library Play opens a public/private room creator and accessible active-room chooser; joining preserves existing playback. Chrome/Firefox fixture flows and layout checks pass; real Activity/provider checks remain open. See [lobby verification](docs/testing.md#lobby-library-and-room-chooser-2026-10-18).
- Validate discoverability and task completion with representative user journeys. Inspect rendered surfaces across supported layouts and verify that focus, menus, dialogs and player controls remain usable without disrupting playback.

**Success criteria:** Common journeys have clear entry points, understandable state and recovery, consistent controls and fewer unnecessary steps. Normal installs have one watch entry point and no fixture-dependent codec-test navigation; development can still run capability checks. The restructured interface works across its declared surfaces without regressions in playback, account scopes, privacy or remote consent. Record findings, before/after evidence and unfinished checks in [testing status](docs/testing.md#uiux-review-and-restructure).

### M1-P8 — Separate remote extension repository and uburoom compatibility

**Goal:** Move the Firefox remote extension into a separate repository while keeping it fully interoperable with uburoom and preserving its existing YouTube TV functionality.

**Current increment:** The extension, assets, notices, configuration, packaging and standalone tests now live in uburoom-remote. uburoom owns its command modules under `shared/`, web renderer/branding under `web/`, and the fixed authenticated remote integration contract; its original extension directory and standalone remote homepage are removed. `/` enters `/watch` while preserving the query, and application packaging produces source ZIPs only. Matching fixtures, TLS command/revocation checks, Chrome/Firefox decoded playback and remote-drawer checks, and installed Firefox startup pass. Full Firefox smoke testing (`scripts/firefox-smoke.js`) passes cleanly end-to-end with compact popup height (503px, well under the 600px browser limit) and verified management dispatch. Chromium Manifest V3 extension support (service worker execution, `storage.session` tab state, server-side OAuth redirect and origin validation) is implemented and verified across both repositories. See [contract](docs/remote-protocol.md) and [evidence](docs/testing.md#remote-extension-repository-separation).

- Maintain the distinct Room/Playback and Viewport/Transform protocols, so YouTube TV presentation controls do not intertwine with room synchronization. Keep ownership and distribution of command validation, remote styles/icons and protocol fixtures explicit so both repositories build and test independently without incompatible copies drifting apart.
- Define and document the extension/server integration contract, supported version combinations, configured HTTPS origins, authentication, connection lifecycle and failure behavior. M1 supports the **canonical `room.*` protocol only**, not old pre-release `session.*` aliases; coordinate both repositories before removal. Preserve shared command validation, per-user scopes, private-room visibility and stale-command rejection.
- Extract the extension with its required source, licenses and notices; update uburoom imports, asset serving, setup documentation and packaging so neither repository depends on the other's checkout layout. Retire the standalone remote-only site (`web/index.html`, `web/setup.js`, `web/style.css` where no longer shared); make `/` enter `/watch` while retaining the remote drawer and authenticated remote protocol. Ensure the new extension repository owns its own UI/assets without importing uburoom filesystem paths.
- Verify real Firefox installation, connection and permitted controls against uburoom, alongside isolated protocol/integration tests. Cover reconnect, tab/browser/server restart, revoked access, incompatible versions and configured-origin builds. Remote consent must remain off after disconnect/restart, with narrow permissions and matching CSP.
- Preserve existing remote capabilities and shared web/Discord controls through the split. Keep the known full extension smoke exception explicit until resolved; do not weaken permissions or throttling to obtain a pass. Audit both histories and ZIP contents for private material and preserve GPL-3.0-only source and third-party notices before release.

**Success criteria:** The extension builds and installs from its own repository, uburoom builds and runs independently with `/watch` as its main interface, and the documented current-protocol extension/server combinations pass integration and real lifecycle checks with the existing authorization and consent safeguards. Keep both checkouts independently buildable/testable; do not restore cross-repository filesystem imports. Repository publication and signing retain their existing approval requirements. Record the compatibility matrix, evidence and unfinished checks in [testing status](docs/testing.md#remote-extension-repository-separation).

### M1-P9 — Browser rendering for styled and bitmap subtitles

**Outcome:** Each viewer can select faithful ASS/SSA, PGS and VobSub subtitles without forcing a video conversion solely for subtitle burn-in.

- Keep the existing video player, controls, shared timeline and native SRT/WebVTT path. Use one subtitle controller with lazy-loaded JASSUB for ASS/SSA and libbitsub for PGS/VobSub; only the selected renderer runs.
- Deliver original tracks, VobSub indexes/palettes and ASS fonts through viewer-authorized resources. Bound extraction, downloads, caches and worker lifetimes; never expose Plex credentials or use another viewer's access as authority.
- Preserve authored layout, personal delay and picture transforms across track changes, pause/seek, quality replacements, late joins and recovery. Keep video outputs reusable across different browser-rendered subtitle selections.
- Retain explicit Plex burn-in fallback when original resources or browser capabilities are insufficient. Verify video-only PIP limitations and actual Discord Activity delivery without requiring cross-origin isolation globally.
- Self-host pinned worker/WASM/font assets with narrow CSP changes and complete upstream notices/source obligations. Validate difficult ASS fonts/signs/karaoke, PGS compositions and VobSub palettes in both Chrome and Firefox, and in real Activity.

**Status: Implementation complete; verification and licensing pending.** Authorized original-resource delivery, bounded embedded stream-copy/font extraction, lazy JASSUB/libbitsub integration and explicit Plex burn-in fallback are implemented and deployed. Firefox/Chrome fixtures cover external and embedded ASS/PGS/VobSub, full initialization, paused repaints, personal delay, transforms and overlay cleanup. Rendering mode persists across track changes, cancelled retries no longer block loading, and ASS uses transparent Canvas2D composition. The owner confirmed PGS and VobSub work and subsequently confirmed normal loading after the ASS fix. Remaining gates are complex authored subtitles/fonts, quality replacement/recovery and mixed-viewer lifecycle checks, actual Discord Activity/mobile coverage, broader real-source/resource testing, and third-party licensing/font provenance/corresponding-source review. The phase remains open until those gates are satisfied. See [testing](docs/testing.md#browser-subtitle-rendering-m1-p9).

**Done:** Intended subtitles survive the declared lifecycle/layout matrix with bounded resources and per-viewer access, with honest fallback behavior and recorded rendering evidence. This phase implements the subtitle portion of M1-P3 and delivery choices in M1-P2; it does not replace the video engine or authorize deployment.

### M1-P10 — Transition "session" terminology to "room"

**Outcome so far:** Canonical room terminology and protocol are implemented locally on 2026-10-17. Legacy management actions, HTTP routes, room-ID/response aliases, shared UI options and extension wire translations are removed. The independent extension uses `room.*`, `roomId` and `room`/`room-ack`; authentication, browser automation and Plex transcode sessions retain their technical names. The host-handoff behavior remains covered. Unit/integration and full Firefox watch smoke checks pass; the separately built extension passes TLS compatibility and installed startup/sign-in checks, while its full fixture run remains incomplete. Detailed extension coverage belongs to M1-P8. See [verification and limitations](docs/testing.md#room-terminology-m1-p10).

- Inventory and rename all user-facing instances of "session" in the web UI, dialogs, status toasts, Discord bot command options/descriptions (`/ubu`, `!ubu`), and Discord Activity lobby views to "room" (e.g. "Room Lobby", "Create Room", "Room Settings").
- Reserve the technical term "session" strictly for low-level connection and auth contexts: HTTP cookie sessions, WebSocket connection sessions, and Plex transcode sessions.
- Remove all watch-room `session.*` action aliases (including `session.enable`, `session.visibility` and `session.controls`), `/api/sessions`, legacy ID/response shapes and extension wire translations after all in-repo callers and the M1-P8 extension use canonical `room.*`/`rooms`. Keep actual HTTP cookie, WebSocket connection and Plex transcode **sessions** as technical concepts; do not mass-rename them.
- Update user documentation, developer docs, protocol fixtures and tests to use only canonical room terminology. Replace alias-acceptance tests with rejection/no-reintroduction coverage; this is an intentional breaking change to private pre-release clients.

**Success criteria:** All UI, bot and Activity touchpoints consistently present "room"; developer docs distinguish rooms from technical sessions; server, web client, bot and separately built extension speak the canonical room protocol without compatibility aliases. Confirm endpoint/action removal and real extension interoperability before M1 publication.

### M1-P11 — Architecture hardening: persistence unification, event-loop protection and fault isolation

**Goal:** Consolidate server persistence, protect the single Node.js event loop from synchronization-blocking latency spikes, and isolate component failures.

- **Storage unification and first-release pruning:** Keep devices, browser logins, linked accounts, credentials and native playback history in the single built-in SQLite database (`data/accounts.sqlite`), with atomic writes/backups. The runtime no longer imports JSON, tracks import markers or upgrades private pre-release layouts implicitly. The current explicit baseline is schema version 2, extended with room records/hosts in M1-P13; unsupported layouts fail without adding missing tables. Tests and operator transfer/restore instructions cover this boundary. There are no external users to support yet; make a reviewed backup/manual reset or transfer plan for the owner’s existing state. Preserve stable UUIDs and the original key for any retained encrypted data. Keep an intentional schema baseline/version and add forward migrations once public releases exist. Live rooms are currently ephemeral; M1-P13's durable core awaits Watch integration. Remote consent must remain ephemeral after that work too.
- **Event-loop latency protection:** Keep the high-frequency playback/tick loop free from synchronous disk I/O and CPU-bound cryptography. Audit `DatabaseSync` calls and `AES-256-GCM` token encryption/decryption (`credentialVault`) to ensure they only execute during infrequent operations (auth/linking) or offload via asynchronous task batching, safeguarding the ≤50ms p95 sync target in M1-P5.
- **WebSocket-native room operations:** Keep authenticated room negotiation, viewer preparation, state changes, commands, readiness and observations on WebSockets. The dispatcher in `server/watch-socket.js` calls transport-neutral operations directly. Obsolete authenticated HTTP **room-control** endpoints and compatibility routing are retired; the setup client and integration tooling use sockets. Retain HTTP for login/account bootstrap, library/catalog requests as needed, media/artwork/health and other genuinely request-response resources; do not duplicate business logic or weaken authentication, revocation, epochs or acknowledgements.
- **Stream fault isolation:** Rejected periodic media access checks in direct Plex and local demo streaming paths now end only the affected stream. Regression checks cover rejected login renewal, timer cleanup and a subsequent authorized resource request.
- **Fault isolation and resilience:** Enforce strict error boundaries and circuit breakers around external integrations (`discord.js` gateway/REST client, Plex API requests) so external outages or rate limits do not crash or stall active rooms. Enforce hard execution timeouts, stdio drain safeguards, and memory caps on spawned FFmpeg child processes (`server/av1.js`).

**Success criteria:** SQLite is the sole runtime persistence for accounts and native history, without private pre-release JSON/schema import paths; existing owner state is handled deliberately. Disk I/O and credential crypto introduce no measurable jitter in sync tick intervals. Watch room operations run through transport-neutral services and authenticated WebSockets rather than HTTP-shaped adapters or public HTTP control aliases; third-party network failures fail gracefully without disrupting unaffected rooms.

**Status:** Runtime SQLite reads use an in-memory mirror with bounded, atomic worker writes to the same database; credential reads are cached and unchanged logins are not re-encrypted by lifecycle sweeps. The watch client uses authenticated, bounded WebSocket requests and server pushes, with revision ordering, independent clock exchanges, current permission checks and off-by-default reconnect consent. Plex and Discord requests have failure boundaries/deadlines and circuit breakers; bot startup failure leaves HTTPS available. AV1 tools enforce hard timeouts/output limits, drain pipes and enforce a sampled 1 GiB process-memory ceiling. Local regression, latency and browser recovery evidence is recorded in [M1-P11 verification](docs/testing.md#architecture-hardening-m1-p11). Pre-release JSON/schema imports and the HTTP compatibility/adapter layer are removed. A matched offline baseline backup/restore fixture passes with preserved UUIDs and original key bytes. Real Activity/proxy WebSockets, operator backup/restore and hardware/resource ceilings remain release checks; this work does not authorize deployment.

### M1-P12 — Rich viewer telemetry, sync health and room presence

**Goal:** Transform the viewer list and player surface into a rich, transparent, and empathetic social watch interface, providing live sync status, stream pipeline visibility, and subtle presence cues.

- **Playhead avatar indicators on the timeline:** Render subtle viewer avatar pips directly on the timeline scrubber. Cluster avatars on the playhead when viewers are in sync; detach and display trailing pips when a viewer is buffering or recovering so the room visually understands who is catching up without voice chat confusion.
- **Interactive viewer cards:** Expand the viewer roster so hovering or clicking any viewer reveals a detailed telemetry popover: live sync offset (±ms), forward buffer health (seconds cached), stream delivery path (Direct Play vs. HLS/AV1 Transcode vs. Shared Conversion Pool), active personal audio/subtitle track choices, and client surface (browser/device).
- **Empathy buffering micro-toasts & host pause prompt:** When a viewer encounters a buffer stall during playback, display a discreet, non-blocking toast (e.g. `Alice is buffering at 01:24:12`). Provide the room host with a gentle one-click voluntary pause prompt (`[Pause for Alice?]`) while upholding the core rule that healthy viewers never freeze automatically. Display a confirmation when the viewer catches up.
- **Host "Stats for Nerds" overlay (HUD mode):** Add a toggleable HUD (e.g., via keyboard shortcut or header icon) showing a live multi-viewer skew radar, active server FFmpeg transcoding processes/QSV hardware utilization, shared transcode pool efficiency, and real-time outbound bandwidth metrics per viewer.
- **Subtle presence cues:** Display lightweight presence indicators in the roster, including local player mute status (to avoid asking if someone heard dialogue) and optional on-pause cursor/ping markers for pointing out on-screen details.

**Success criteria:** Viewers and hosts can immediately observe room synchronization, delivery pipelines, and buffer health at a glance without verbal back-and-forth; server resource consumption is transparent to operators; social presence is deepened while preserving the cinema layout and independent playback boundaries.

### M1-P13 — Persistent rooms and playback queues

**Status:** P13-1 through P13-5 are implemented and locally verified, including durable rooms/permissions, live integration/Admin mode, manual/bulk queues, following/random generation, shuffle and cancellable autoplay. The full automated suite passes 344 tests with zero failures/skips; Chrome and Firefox room smoke flows pass. P13-6 UI completion/review and P13-7 real Plex/Activity continuity, resource measurements and retained-state verification remain open. No deployment or retained-state transfer has occurred.

**Requested outcome:** Create a named room or reopen one you created/explicitly host; authorized server administrators can opt into top-bar Admin mode for creator rights in every room. Closing preserves current video/position, upcoming queue and room history. Support creator > host > viewer permissions, operator defaults/admin identities, full participant permissions in one action, creatorship transfer, movies/shows/seasons/episodes, following/random auto-queue and queue shuffle.

**Design:** Keep live playback in memory and save room identity, explicit hosts, permissions, bookmarks and later queue occurrences in existing SQLite/writer. Reopen one live instance with fresh authority/epochs and paused playback; never restore consent, streams, viewers or commands. Separate durable roles from live control; pause without a host unless Continue without host is granted. Distinguish Leave, saved Close and permission-checked confirmed Delete. Closed rooms do not consume active playback slots.

- **Implemented P13-1 core:** `server/room-policy.js` and `server/room-store.js` cover granular role/default policy, creator-only role/permission management, full ordinary participant rights, assigned-host/admin-only restore data, canonical account merges/revocation, rename/visibility/delete, creator transfer and separate bookmark/settings revisions.
- **Implemented P13-2 live integration & Admin mode:** `server/watch-rooms.js`, `web/watch-rooms-ui.js`, live WebSocket integration, save/reopen, close/delete, Admin mode integration, and independent room settings management.
- **Implemented P13-3 queue backend & UI slice:** `server/room-queue.js`, `web/watch-queue-ui.js`, `web/watch-library.js`. Flat ordered queue with occurrence UUIDs, optimistic concurrency via `queueRevision`, Up Next list with ranks/reordering/removal/clear, History with outcome badges/resume/start-over/clear, library "Add to queue" buttons, Next/Previous queue coordination, and Safe-DOM UI rendering.
- **Implemented P13-4:** Atomic paginated show/season expansion, room-unfinished/Specials filters, following/random generation with persistent cycles and pending-only shuffle.
- **Implemented P13-5:** Verified decoded ending evidence, announced ten-second cancellable autoplay/off switch, fenced atomic advancement and successor generation. Failed preparation preserves the queue; shutdown waits for committed transitions.
- **P13-6 queue presentation (2026-10-19):** Centered history/current/upcoming cards, list columns, saved view selection, navigation, authenticated lazy artwork, responsive theater/phone/drawer layouts and existing queue actions are locally verified in Chrome and Firefox. Remaining P13-6/P13-7 live-provider and Activity gates stay open.
- **P13-6 interaction follow-up:** Shared validation now accepts pending-entry Play now/Skip to, Skip to retains contiguous ranks, and explicit history replay consumes the selected row into a fresh occurrence. Direct controls, movement with scroll following, wheel navigation, matching history/upcoming rows, start-time estimates and coherent queue/current rendering pass expanded Chrome/Firefox checks and all 345 automated tests. See [verification](docs/testing.md#queue-selection-replay-and-interaction-follow-up-2026-10-19).
- **P13-6 mobile/navigation follow-up:** Equal-width Room/Queue/Media tabs replace mobile stacking; shortened headings and monochrome Room/Media icons accompany the fullscreen Menu. Native vertical wheel behavior is restored. Current Skip and history Go back to use existing validated playback paths; Go back restores newer history/current playback ahead of pending items. All 347 tests pass, with browser checks and remaining live gates recorded in [verification](docs/testing.md#mobile-section-tabs-names-and-queue-return-controls-2026-10-19).
- Keep auto-queue generation separate from automatic playback. Continue P13-6/P13-7 real Plex multi-viewer and Activity continuity checks, including provider failures and writer/sync/resource measurements.
- Verification covers Chrome/Firefox normal/theater/fullscreen/mobile surfaces; real Activity evidence tracked separately.
- Define the storage baseline/retained-state procedure before schema changes; preserve UUIDs, native history and original credentials/key. Checkpoint outside the sync tick, await durable edit/close acknowledgements and final shutdown saves, page bounded queue responses, and review shared protocol compatibility with the independent remote.

**Implementation sequence:** P13-0 decisions recorded; P13-1 record/permission core implemented for review; P13-2 live lifecycle/Admin-mode/checkpoint integration; P13-3 manual queue/history/navigation and Queue UI slice; P13-4 bulk/generation/shuffle; P13-5 cancellable/off-switch autoplay; P13-6 remaining UI alongside usable backend slices; P13-7 continuity/regression/operator documentation. The detailed plan defines handoff boundaries and unfinished checks. No deployment or retained-state transfer has occurred.

**Done:** An authorized cohost can reopen the same named room after close or server restart at its committed bookmark, edit/play the same queue and inspect past outcomes. Private listings, revocations/account merges, concurrent edits/reopens, duplicate endings, crash recovery and storage/preparation failure behave truthfully. Browser/Activity and real Plex evidence, remaining limits and schema/backup checks are recorded before support claims.

Details: [implemented core, recorded owner decisions, remaining design and increment gates](docs/rooms-and-queues.md). Evidence and limitations: [P13-4/P13-5 verification](docs/testing.md#bulk-queues-generation-and-cancellable-autoplay-p13-4--p13-5-2026-10-18).

## M2 — Future planned capabilities

**Outcome:** Broaden media sources, accessibility, and frictionless room entry beyond the initial self-hosted release baseline.

These phases expand uburoom's feature set after the M1 release gates are satisfied. The priority and ordering will be adjusted as the owner's focus evolves.

### Phase map

| ID | Phase | Position | Depends on |
| --- | --- | --- | --- |
| M2-P1 | High Dynamic Range (HDR) support | Planned | M1-P2/M1-P3 delivery model and capability negotiation |
| M2-P2 | Enhanced browser Picture-in-Picture with subtitles | Planned | M1-P9 browser subtitle rendering |
| M2-P3 | Guest room codes | Planned | M1-P10 room terminology, M1-P11 unified persistence |
| M2-P4 | Rudimentary uburoom-hosted video library | Planned | M1-P2 direct playback and local storage |
| M2-P5 | Shared YouTube video playback | Planned | M1-P5 synchronization engine and M1-P8 protocol split |
| M2-P6 | Web Audio dynamic range compression (Dialogue Boost / Night Mode) | Planned | M1-P3 audio playback pipeline |
| M2-P7 | Self-hosting installation validator (`--doctor` CLI check) | Planned | M1-P11 configuration and storage unification |
| M2-P8 | Official containerization (Docker & Docker Compose) | Planned | M2-P7 configuration validation |
| M2-P9 | Discord voice channel presence and room invite embeds | Planned | M1-P10 room terminology and Discord bot integration |
| M2-P10 | Chromium remote extension support | Completed & verified | M1-P8 independent remote repository and versioned protocol |

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

### M2-P3 — Guest room codes

**Goal:** Enable frictionless room entry via temporary invite codes without requiring Discord OAuth or linked Plex accounts.

- Allow room hosts to generate temporary, time-bounded guest invite codes or shareable links.
- Grant guest viewers synchronized playback, personal volume, and audio/subtitle track choices within the room.
- Maintain safe permission boundaries: guests cannot manage room settings, transfer host status, access Plex server libraries, or view private credentials.

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
- Automatically verify `.env` variable syntax, credential key file location and restrictive permissions, Plex server connectivity and token validity, Discord bot gateway connection and application guild settings, TLS certificate/key pair validity, and local FFmpeg/FFprobe availability.
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

### M2-P10 — Chromium remote extension support

**Goal:** Support the remote extension in Chrome and other explicitly tested Chromium browsers alongside Firefox.

- Add Chromium Manifest V3 service-worker builds and browser API handling without weakening configured-origin permissions, CSP or off-by-default consent.
- Define stable extension identity and proof-bound sign-in return URLs; retain per-tab metadata and safe behavior across worker suspension, reconnect and browser restart.
- Verify installation, local/remote controls, authentication, revoked access and lifecycle behavior in both Chrome and Firefox. Test other claimed Chromium browsers explicitly.

Chromium Manifest V3 extension support is implemented and verified. `uburoom-remote` provides multi-target build and packaging (`npm run build:all`, `npm run package:all`, `scripts/package-all.ps1`), a Manifest V3 background service worker, and `chrome.storage.session` for active tab state. `uburoom` validates Chrome extension origin headers (`chrome-extension://[a-p]{32}`) and proof-bound Chromium OAuth redirect URLs (`https://<id>.chromiumapp.org/`), with full automated regression testing.

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

## Document map

| Document | Owns |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | Broad priorities, milestone and phase status, sequencing and open directions |
| [SPEC.md](SPEC.md) | Product behavior and enduring boundaries |
| [Playback reliability plan](docs/playback-reliability.md) | Detailed playback architecture, requirements, corpus and proposed performance targets |
| [Persistent rooms and queues](docs/rooms-and-queues.md) | M1-P13 implemented core, recorded lifecycle/role/admin/queue decisions, remaining integration and ordered increments |
| [Testing status](docs/testing.md) | Actual evidence, limitations, deferred failures and remaining verification |
| [Development](docs/development.md) | Reproducible local/isolated commands and fixture prerequisites |
| [Design guide](docs/design-guide.md) | Established interface and asset rules |
| [Self-hosting](docs/self-hosting.md) / [upgrading](docs/upgrading.md) | Operator setup, state/key preservation and upgrade procedures |
| [Third-party review](docs/third-party.md) | Licensing, notices and asset provenance gates |
