# uburoom roadmap

Updated: 2026-10-27.

A map of priorities and unfinished work. Implementation does not imply live verification or release readiness. Detailed requirements belong in the linked plans; results belong in [testing](docs/testing.md). Phase IDs stay stable; retired M1-P8 transport work and baseline M2-P7/M2-P8 installation diagnostics and Docker/Compose packaging are owned by M1-P11.

## Priorities

1. **Configuration and administration (P14):** Three-outcome A/B verification complete: authorization boundaries, safe account mutations/session revocation, and supported settings with matched backup/restore. Real installation and recovery checks remain release gates.
2. **Playback continuity (P1/P2/P13):** Verify real multi-viewer delivery, independent recovery, natural ending, queue transitions and resource cleanup on a bounded browser/provider configuration.
3. **Plex reporting (P4):** Complete real PMS/Tautulli integration verification for decoupled session reporting, shared-producer safety and personal watch-state synchronization.
4. **Release closure:** Complete the supported-environment checks, operator recovery and publication audit gates below. Expand the supported matrix only with evidence.

## M1 — Verified self-hosted release

**Outcome:** Another person can install uburoom safely, preserve state across supported future upgrades and understand its supported configurations and limitations. Private pre-release revisions have no promised upgrade path.

### Release gates

- Declare the supported browser, Activity, codec and delivery combinations; verify actual picture, audio, captions, synchronization and recovery for those claims.
- Verify installation on an independent host/origin (including Docker/Compose and `npm run doctor` diagnostics) with fresh provider applications and profiles; verify backup/restore and rollback while preserving account UUIDs and the exact encryption key.
- Verify admission, revoked credentials, account changes and media authorization across browser and Activity. Configured sponsorship is implemented and enabled by default; it is not personal Plex entitlement. Direct fallback delegation requires an explicit opt-in and a dedicated non-owner account. Granular grants and sponsored reporting remain unfinished.
- Audit source, publication history and ZIP contents for private material and required license/source obligations. Obtain explicit publication approval.

Architecture and implementation constraints remain in [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md). UI decisions remain governed by the [design guide](docs/design-guide.md). Neither a roadmap entry nor a passing test authorizes production changes, provider experiments or publication.

### Verification routing for M1

**A:** source/design review. **B:** isolated automated execution. **C:** real provider/device/network integration. **D:** human acceptance. Required methods and actual results belong in the [verification dashboard](docs/testing.md). Fixture passes cannot close real-environment gates; implementation approval cannot close acceptance gates.

### Phase map

“Implemented” below means the named code increment exists; open verification remains part of its completion gate. Future features within a phase are separate increments, not a requirement to reproduce every provider feature before a first release.

| ID | Area | Implemented | Remaining work |
| --- | --- | --- | --- |
| M1-P1 | Sustained playback | Recovery, diagnostics, early runtime degradation warnings and scoped real two-hour playback evidence | Representative Firefox 4K/device verification, evidence-based HLS tuning, Activity and multi-viewer lifecycle coverage; unexplained unload/resource behavior and long-run accounting |
| M1-P2 | Automatic delivery | Direct file/HLS, proxy recovery, shared outputs, local codec selection and bounded capacity fallback | Complete source/version inventory, output validation, remux/audio-only selection, automatic quality and real cross-account/device coverage |
| M1-P3 | Content fidelity | Personal tracks and initial decoded audio/caption evidence | Real track switching/restoration, downmix, A/V/caption alignment, source cadence and device coverage; subtitle renderer work is P9 |
| M1-P4 | Plex viewing experience | Native viewer observations/history; decoupled session reporting, shared-producer stop safety, activity-only default with personal watch-state opt-in and sponsored isolation | Live PMS/Tautulli validation, multi-viewer stop/seek transitions and natural playback completion; later parity increments below |
| M1-P5 | Synchronization | Clock estimation, scheduled controls, readiness, independent recovery, and bounded 5s sample expiry decoupled from socket watchdog | Physical/WAN presentation-skew measurements and calibration with P6; targets remain ≤50 ms p95 / ≤100 ms p99, unverified |
| M1-P6 | Frame pacing | Default correction policy, opt-in Occasional jumps, and removal of rejected experimental production wiring | Joint skew/smoothness acceptance |
| M1-P7 | UI/UX | Layout split, Room/Queue/Media shared controls, sliding player menus, grouped two-column settings dialog with subtitle appearance controls, delayed subtitle loading indicator, full-stage ending interstitial, personal preferences and sync-module extraction | Current user-journey/accessibility review, physical mobile/Activity acceptance and bounded further modularization |
| M1-P9 | Browser subtitles | ASS/SSA, bounded PGS window extraction/replay and progressive full-track streaming, VobSub rendering, truthful extraction errors, authorized resources and burn-in fallback | Original large-title PGS failure remains an open live retest; real Plex MKV seek/range/timing, complex authored content and Activity/mobile/resource acceptance |
| M1-P10 | Room terminology | Canonical room names/protocol, removal of legacy aliases, and web/Activity terminology audit; “session” retained for technical contexts and “watch parties” preserved for public context | Final packaging review |
| M1-P11 | Architecture hardening | SQLite worker/mirror, WebSocket-native room operations, compatibility removal, fault boundaries, bounded tools, installation validator (`npm run doctor`) and Docker/Compose packaging | Real proxy/container/resource checks and operator backup/restore/rollback |
| M1-P12 | Viewer telemetry | Passive Room sync-quality indicator | Live accuracy/readability acceptance; richer telemetry and presence remain optional expansion |
| M1-P13 | Persistent rooms and queues | Durable rooms, roles, reopen, manual/bulk queues, single tail preview (`autoQueue.next`), `continue`/in-order/shuffle modes, `pin`/`skip`/`playNow` controls, cancellable autoplay, full-stage ending interstitial and explicit endpoint completion | Dual-browser rendered UI checks for tail preview/`continue` mode, real Plex/Activity continuity, retained-state recovery, writer/load measurements and remaining UX acceptance; endpoint-seek fix owner-verified, broader device coverage open |
| M1-P14 | Configuration and accounts | YAML policy, verified operator authorization, running/saved settings APIs, validated YAML saves and 19-key browser settings panel (Rooms, Directory, Transcoding), configured sponsorship, Activity handoff, single-room controls, editable names and host discovery/assignment | Three-outcome A/B verification complete; real admission/revocation and independent operator recovery remain release gates |

### M1-P4 — Plex viewing experience

**Status:** Decoupled reporting architecture, shared-producer safety (preventing viewer teardowns from terminating pooled HLS transcode slots), activity-only default with explicit per-user personal watch-state opt-in, and sponsored viewer isolation are implemented and covered by unit/lifecycle tests on main.

**Next:** Complete live validation against physical PMS/Tautulli instances; verify multi-viewer stop/seek transitions and natural playback completion.

**Later increments:** Content versions and split-file timelines; resume/start-over, chapters, intro/credits markers, previews/extras; subtitle search and supported presentation/audio controls. Episode continuation uses P13's queue transition, not a second advance path.

Details: [accounts and reporting](docs/accounts-and-access.md), [reporting investigation](docs/plex-reporting-investigation.md), [playback plan](docs/playback-reliability.md).

### M1-P12 — Viewer telemetry

Expansion candidates: timeline viewer indicators, detailed viewer cards, buffering notices with voluntary host pause, an operator resource HUD and optional presence cues. Select small increments after the current indicator is accepted; none may automatically interrupt healthy viewers.

### M1-P13 — Persistent rooms and playback queues

P13-1 through P13-5 are implemented, including single persisted tail previews (`autoQueue.next`), dynamic `continue` mode alongside `following` (In order) and `random` (Shuffle), `pin`/`skip`/`playNow` controls, full-stage ending interstitials, and bounded Plex catalog expansion without per-item file-check waterfalls. P13-6 UI has substantial local coverage; dual-browser rendered checks for the tail-preview/`continue` UI, remaining acceptance and P13-7 real continuity/recovery checks stay open. Durable records preserve room identity, permissions, bookmarks, queue and history; live viewers, consent and streams are never restored. Auto-queue generation and automatic playback remain separate.

Details: [rooms and queues](docs/rooms-and-queues.md).

### M1-P14 — Configuration, administration and account authorization

**Status:** Private `config.yaml` remains the sole configuration authority. The browser Server Settings panel and `/api/operator/settings/saved` cover the complete M1 browser-editable scope (the 19-key allowlist across Rooms, Directory and Transcoding, requiring a manual restart to take effect), while access policy, single-room mode, retention/history deletion, operator IDs, credentials, connections and paths remain YAML-only.

**Complete (A/B):** P14 is bounded to three verified outcomes:

1. **Authorization boundaries:** Verified operator identities alone authorize server settings. Room roles grant no Plex entitlement. Detected provider/item revocation rejects media, captions and subtitle windows and aborts active proxy streams.
2. **Account safety:** Last usable login, conflicting identity and stale mutation protections are verified. Linking advances account revision; account changes revoke prior sessions, Activity tokens, media grants and viewers. Logout revokes the selected browser and its viewers.
3. **Configuration and recovery:** All 19 supported keys pass the validated settings API; comments/private values and conflict handling are preserved. A consistent live SQLite snapshot plus YAML and the original key restores accounts, encrypted credentials, durable rooms/queues and settings, including rollback of subsequent fixture changes.

Provider detection retains existing cache/polling bounds; direct Plex delivery depends on PMS enforcement. Real-provider/device integration and independent installation recovery remain release checks, with limits recorded in [testing](docs/testing.md).

Configured sharing for eligible viewers without personal Plex access is an approved policy, not the obsolete implicit-fallback defect. Expired/revoked credentials, provider errors and item restrictions must fail closed. Editable names and existing host assignment are implemented; native login and owner name-lock rules are deferred. Guest passes remain M2-P3.

Details: [accounts and access](docs/accounts-and-access.md), [names and host directory](docs/account-names-and-host-directory.md).

## M2 — Future planned capabilities

Select and scope these individually after the relevant foundations are ready. This list is not implementation authorization.

| ID | Capability | Boundary / prerequisite |
| --- | --- | --- |
| M2-P1 | HDR | Verify capable-client passthrough and HDR-to-SDR tone mapping; distinguish Dolby Vision profiles |
| M2-P2 | Subtitle-aware Picture-in-Picture | Build on P9; evaluate Document PiP or compositing against actual browser support |
| M2-P3 | Guest room passes | Approved for future work after P14 authorization, P4 attribution and P13 roles; revocable, bounded room passes never imply media or host authority |
| M2-P4 | Local video library | Operator-selected folders, basic playback/conversion; no Plex-style metadata platform |
| M2-P5 | Shared YouTube playback | Use P5 timeline and P11 command transport; account for embed, ad and buffering constraints |
| M2-P6 | Dialogue Boost / Night Mode | Personal client-side audio compression compatible with volume/mute |
| M2-P9 | Discord presence and room invites | Discoverable room embeds with lifecycle updates; scope separately from removed bot commands |
| M2-P10 | Native client integration (`plezy-uburoom`) | Companion Flutter/`libmpv` client using authenticated `/watch-socket` sync, expiring handoff bearer tokens, and `delivery=local` for downloaded Plex files without upstream transcode allocation |

Further directions: managed/project-hosted rooms and Live TV/DVR. Each needs a separate feasibility and authorization scope.

## Document ownership and maintenance

- **This roadmap:** priorities, phase status, remaining outcomes and dependencies. Update the affected row after material work; delete superseded status.
- **[Testing](docs/testing.md):** evidence, failures and open verification gates. Keep dated results and test counts out of this roadmap.
- **[Playback](docs/playback-reliability.md), [delivery](docs/plex-hls-delivery.md), [rooms](docs/rooms-and-queues.md), [accounts](docs/accounts-and-access.md):** detailed requirements and implementation contracts.
- **[Design](docs/design-guide.md), [development](docs/development.md), [self-hosting](docs/self-hosting.md), [Docker](docs/docker.md), [upgrading](docs/upgrading.md), [third-party review](docs/third-party.md):** UI decisions, commands, operator procedures and licensing.

Do not append work diaries, UI dimensions, commit narratives, repeated disclaimers or completed test reports here. Preserve substantive evidence in its owning document or history. Private suggestion audits stay in the ignored personal queue.
