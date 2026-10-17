# uburoom roadmap

Updated: 2026-10-16.

uburoom is a self-hosted Plex watch-together app for browsers and Discord Activity, with an included Firefox YouTube TV remote. The goal is simple: choose a title and watch together, with the intended picture, audio and subtitles surviving ordinary failures.

This is a working map for one maintainer and their agents. Milestones define broad outcomes; phases are the smaller bodies of work within each milestone. Plan in small, useful increments within these phases. The order can change with the owner's priorities; there are no sprint commitments or promised release dates. This document consolidates existing plans, not new feature approvals or permission to deploy them.

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

## M1 — Verified self-hosted release

**Current milestone. Outcome:** Another person can install or upgrade uburoom safely and understand exactly what is supported.

- Verify a clean installation on an unrelated host/origin with separate provider applications and fresh profiles, plus an existing-instance upgrade with stable account UUIDs and the exact original encryption key bytes. Test the chosen code/state separation and rollback procedure.
- Verify restricted/revoked Plex access, linked accounts, `/ubu` and `!ubu`, real Activity setup and the claimed browser/transport combinations without owner-token fallback.
- Complete real Firefox/YouTube TV lifecycle, consent, latency and configured-origin checks. The known full extension smoke failure remains deferred; preserve that exception explicitly and do not weaken permissions or throttling to conceal it.
- Finish branding/artwork/media provenance, dependency notices and GPL-3.0-only distribution review. Audit source, full publication history, assets and ZIP contents for private material; include LICENSE and required notices.
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
| M1-P6 | Frame-pacing preservation during synchronization | In progress; cadence comparisons recorded, gentle candidate gated after regressions; joint live verification pending | Presentation-interval diagnostics and coordinated design with M1-P5 |
| M1-P7 | In-depth UI/UX review and restructure | Planned; review complete user journeys before restructuring | Existing design guide, rendered surfaces and playback/permission behavior |
| M1-P8 | Separate remote extension repository and uburoom compatibility | Planned; define the integration and shared-source boundaries before extraction | Stable command/protocol contract and cross-repository compatibility checks |

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
- Work through the existing parity inventory for subtitle search/download, renderer-supported presentation controls, available audio timing and shared playback speed. Decide and verify each control's behavior before exposing it.
- Define the per-user resume/history reporting lifecycle before enabling Plex timeline/watch-state writes. Reporting is currently disabled; experiments must use consenting accounts and account for resume/history effects.

**Done per increment:** One complete viewing flow works across its declared surfaces, including cancellation and room synchronization. This phase is several small features, not a promise to reproduce every Plex screen at once. Details: [content fidelity and playback UX](docs/playback-reliability.md#content-fidelity-and-playback-ux).

### M1-P5 — Real-time playback synchronization — Design requirements

**Goal:** Minimize the actual real-world playback difference between healthy viewers so reactions over Discord voice chat don't arrive before other viewers see the corresponding event.

**Target:** Aim for ≤50 ms p95 presentation-time skew, with ≤100 ms p99 as an initial engineering target, subject to real-world testing.

**Current increment:** Timing/clock/shared-target diagnostics now include repeated, counterbalanced startup comparisons and a minimal browser callback probe. Initial readiness releases use a shared future start with paused preparation; ongoing buffering and ordinary resume remain independent/immediate. Local Firefox 24 fps and Chrome 59.94 fps startup trials needed no rate corrections. M1-P6 adds recovery/visibility guards and an experimental bounded gentle policy; its observed skew/drop regressions prevent default enablement. Default rate gain/deadband and hard-seek thresholds remain unchanged. Scheduled ordinary controls, prompt event delivery, alternative frame-aware correction experiments and physical/geographic validation remain open. Firefox's sparse high-rate callbacks and interval outliers remain measurement limits. See [measurements and open gates](docs/testing.md#real-time-playback-synchronization).

**Architecture:**

- Use a shared server-authoritative playback timeline with accurate clock-offset and network-latency estimation.
- Synchronize actual frame presentation times, not just `video.currentTime`.
- Use scheduled timestamps for coordinated play/pause/seek events.
- Use gradual drift correction and hard seeks when necessary, within the frame-pacing requirements in M1-P6.
- Ensure latency differences between viewers don't translate directly into playback differences.

**Critical constraint — independent buffering:**

- Never pause or delay healthy viewers because another viewer buffers, disconnects or experiences poor performance during ongoing playback.
- Buffering viewers recover independently and catch up to the current authoritative timeline.
- Preserve individual quality selection and stream recovery.
- Preserve the initial readiness gate for starting new media, separately from ongoing playback recovery.

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

**Current increment:** Rate correction now stops during buffering, seeking, hidden/offline state and local lifecycle changes. An experimental ±0.5% policy adds sustained-drift evidence, cadence/clock-informed tolerance, hysteresis, bounded bursts and a quiet interval. Local comparisons across all six requested cadences found slower catch-up and additional Chrome native drops in several candidate trials, so the candidate remains disabled by default and available to the isolated runner. The owner will test M1-P5 alongside M1-P6 during the live human checks. Drop investigation, threshold calibration, alternative recovery methods and the physical display/network/transport matrix remain open. Record separate skew/smoothness results in [testing status](docs/testing.md#frame-pacing-preservation-during-synchronization).

### M1-P7 — In-depth UI/UX review and restructure

**Goal:** Review the interface and complete user experience in depth, then restructure navigation, information hierarchy and interactions so common tasks are clear, consistent and easy to complete.

- Map and inspect end-to-end journeys: sign-in and account linking, library browsing, room creation/joining, playback and personal tracks/quality, remote permissions, browser/Discord handoff and recovery from failures.
- Identify confusing navigation, duplicated controls, hidden state, unnecessary steps, inconsistent terminology and unclear loading, empty, error or recovery feedback. Evaluate desktop, mobile and real Discord Activity layouts, including keyboard and assistive-technology use.
- Develop a coherent information architecture and reviewable flow/layout proposals, then implement the restructure in bounded increments. Use the [design guide](docs/design-guide.md) and shared styles/SVGs as the visual foundation; preserve safe DOM creation, accessibility and clear separation of shared room actions from personal settings.
- Validate discoverability and task completion with representative user journeys. Inspect rendered surfaces across supported layouts and verify that focus, menus, dialogs and player controls remain usable without disrupting playback.

**Success criteria:** Common journeys have clear entry points, understandable state and recovery, consistent controls and fewer unnecessary steps. The restructured interface works across its declared surfaces without regressions in playback, account scopes, privacy or remote consent. Record findings, before/after evidence and unfinished checks in [testing status](docs/testing.md#uiux-review-and-restructure).

### M1-P8 — Separate remote extension repository and uburoom compatibility

**Goal:** Move the Firefox remote extension into a separate repository while keeping it fully interoperable with uburoom and preserving its existing YouTube TV functionality.

- Inventory extension code, assets, notices, build/configuration tools and tests. Define ownership and distribution of shared command validation, remote styles/icons and protocol fixtures so both repositories can build and test independently without incompatible copies drifting apart.
- Define and document the extension/server integration contract, supported version combinations, configured HTTPS origins, authentication, connection lifecycle and compatibility failure behavior. Preserve the shared validated command engine, per-user scopes, private-session visibility and stale-command rejection.
- Extract the extension with its required source, licenses and notices; update uburoom imports, asset serving, setup documentation and packaging so neither repository depends on the other's checkout layout.
- Verify real Firefox installation, connection and permitted controls against uburoom, alongside isolated protocol/integration tests. Cover reconnect, tab/browser/server restart, revoked access, incompatible versions and configured-origin builds. Remote consent must remain off after disconnect/restart, with narrow permissions and matching CSP.
- Preserve existing remote capabilities and shared web/Discord controls through the split. Keep the known full extension smoke exception explicit until resolved; do not weaken permissions or throttling to obtain a pass. Audit both histories and ZIP contents for private material and preserve GPL-3.0-only source and third-party notices before release.

**Success criteria:** The extension builds and installs from its own repository, uburoom builds and runs independently, and supported extension/server combinations pass integration and real lifecycle checks with the existing authorization and consent safeguards. Keep the extension in this repository until extraction and compatibility are verified. Repository publication and signing retain their existing approval requirements. Record the compatibility matrix, evidence and unfinished checks in [testing status](docs/testing.md#remote-extension-repository-separation).

## Future direction and decisions still open

These are already identified directions or placeholders, outside the current delivery sequence. Define a small scope when the owner selects one.

| Direction | Current boundary |
| --- | --- |
| Native-player integration | Future milestone. Establish the integration and control contract while preserving the shared engine, account scopes and consent lifecycle. |
| Project-hosted rooms and managed room URLs | Future work in the specification. Self-hosting remains the current product; hosting and account/isolation responsibilities need a separate scope. |
| Live TV/DVR | Separate feasibility work for live manifests, moving seek windows, tuning and authorization. On-demand video coverage does not imply live support. |
| Queue controls | A disabled UI placeholder exists; queue behavior and authorization are not specified. Keep it disabled until its scope is chosen. |

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
| [Testing status](docs/testing.md) | Actual evidence, limitations, deferred failures and remaining verification |
| [Development](docs/development.md) | Reproducible local/isolated commands and fixture prerequisites |
| [Design guide](docs/design-guide.md) | Established interface and asset rules |
| [Self-hosting](docs/self-hosting.md) / [upgrading](docs/upgrading.md) | Operator setup, state/key preservation and upgrade procedures |
| [Third-party review](docs/third-party.md) | Licensing, notices and asset provenance gates |
