# uburoom roadmap

Updated: 2026-10-23.

A map of priorities and unfinished work. Implementation does not imply live verification or release readiness. Detailed requirements belong in the linked plans; results belong in [testing](docs/testing.md). Phase IDs stay stable; retired M1-P8 transport work is owned by M1-P11.

## Priorities

1. **Configuration and administration (P14):** Finish the settings inventory, effective-access matrix and YAML editing/recovery contract before building the administration panel.
2. **Playback continuity (P1/P2/P13):** Verify real multi-viewer delivery, independent recovery, natural ending, queue transitions and resource cleanup on a bounded browser/provider configuration.
3. **Plex reporting (P4):** Resolve shared-producer lifecycle and attribution before adding product activity reporting and independent personal watch-state synchronization.
4. **Release closure:** Complete the supported-environment checks, operator recovery, branding and licensing gates below. Expand the supported matrix only with evidence.

## M1 — Verified self-hosted release

**Outcome:** Another person can install uburoom safely, preserve state across supported future upgrades and understand its supported configurations and limitations. Private pre-release revisions have no promised upgrade path.

### Release gates

- Declare the supported browser, Activity, codec and delivery combinations; verify actual picture, audio, captions, synchronization and recovery for those claims.
- Verify installation on an independent host/origin with fresh provider applications and profiles; verify backup/restore and rollback while preserving account UUIDs and the exact encryption key.
- Verify admission, revoked credentials, account changes and media authorization across browser and Activity. Configured sponsorship is implemented and enabled by default; it is not personal Plex entitlement. Direct fallback delegation requires an explicit opt-in and a dedicated non-owner account. Granular grants and sponsored reporting remain unfinished.
- Finish branding and asset provenance, dependency/font notices and GPL-3.0-only distribution review. Replace the demo builder's old branding reference and remove `assets/branding/old/` from active source before packaging.
- Audit source, publication history and ZIP contents for private material and required license/source obligations. Obtain explicit publication approval.

Architecture and implementation constraints remain in [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md). UI decisions remain governed by the [design guide](docs/design-guide.md). Neither a roadmap entry nor a passing test authorizes production changes, provider experiments or publication.

### Verification routing for M1

**A:** source/design review. **B:** isolated automated execution. **C:** real provider/device/network integration. **D:** human acceptance. Required methods and actual results belong in the [verification dashboard](docs/testing.md). Fixture passes cannot close real-environment gates; implementation approval cannot close acceptance gates.

### Phase map

“Implemented” below means the named code increment exists; open verification remains part of its completion gate. Future features within a phase are separate increments, not a requirement to reproduce every provider feature before a first release.

| ID | Area | Implemented | Remaining work |
| --- | --- | --- | --- |
| M1-P1 | Sustained playback | Recovery, diagnostics and scoped real two-hour playback evidence | Real Firefox/Activity and multi-viewer lifecycle coverage; unexplained unload/resource behavior and long-run accounting |
| M1-P2 | Automatic delivery | Direct file/HLS, proxy recovery, shared outputs, local codec selection and bounded capacity fallback | Complete source/version inventory, output validation, remux/audio-only selection, automatic quality and real cross-account/device coverage |
| M1-P3 | Content fidelity | Personal tracks and initial decoded audio/caption evidence | Real track switching/restoration, downmix, A/V/caption alignment, source cadence and device coverage; subtitle renderer work is P9 |
| M1-P4 | Plex viewing experience | Native viewer observations/history; activity-only and isolated HLS reporting research | Product reporting, shared-producer safety, personal-state consent/reconciliation and sponsored attribution; later parity increments below |
| M1-P5 | Synchronization | Clock estimation, scheduled controls, readiness and independent recovery | Physical/WAN presentation-skew measurements and calibration with P6; targets remain ≤50 ms p95 / ≤100 ms p99, unverified |
| M1-P6 | Frame pacing | Default correction policy and opt-in Occasional jumps | Joint skew/smoothness acceptance; accept or reject disabled experiments and remove rejected production wiring |
| M1-P7 | UI/UX | Layout split, Room/Queue/Media shared controls, sliding player settings with pinned Back, personal preferences and sync-module extraction | Current user-journey/accessibility review, physical mobile/Activity acceptance and bounded further modularization |
| M1-P9 | Browser subtitles | ASS/SSA, PGS/VobSub rendering, authorized resources and burn-in fallback | Complex fonts/authored content, lifecycle/resource and real Activity/mobile checks; licensing and corresponding-source obligations |
| M1-P10 | Room terminology | Canonical room names/protocol and removal of legacy aliases | Final current web/Activity terminology review; retain “session” for technical connections/auth/media contexts |
| M1-P11 | Architecture hardening | SQLite worker/mirror, WebSocket-native room operations, compatibility removal, fault boundaries and bounded tools | Real proxy/resource checks and operator backup/restore/rollback |
| M1-P12 | Viewer telemetry | Passive Room sync-quality indicator | Live accuracy/readability acceptance; richer telemetry and presence remain optional expansion |
| M1-P13 | Persistent rooms and queues | Durable rooms, roles, reopen, manual/bulk queues, generation, shuffle, cancellable autoplay and explicit endpoint completion | Real Plex/Activity continuity, accelerated-client endpoint retest, retained-state recovery, writer/load measurements and remaining UX acceptance |
| M1-P14 | Configuration and accounts | YAML policy, configured sponsorship, Activity handoff, single-room controls, editable names and host discovery/assignment | Administration panel contract/implementation, recent-auth and sensitive-account security, operator recovery and real policy verification |

### M1-P4 — Plex viewing experience

**Next:** Verify shared-output stop behavior and AV1 natural ending, then implement reporting with separate activity and personal-state controls. Keep viewer identity distinct from source credentials; never write another account's personal history on behalf of sponsored viewers. Reporting remains unimplemented despite successful research probes.

**Later increments:** Content versions and split-file timelines; resume/start-over, chapters, intro/credits markers, previews/extras; subtitle search and supported presentation/audio controls. Episode continuation uses P13's queue transition, not a second advance path.

Details: [accounts and reporting](docs/accounts-and-access.md), [reporting investigation](docs/plex-reporting-investigation.md), [playback plan](docs/playback-reliability.md).

### M1-P12 — Viewer telemetry

Expansion candidates: timeline viewer indicators, detailed viewer cards, buffering notices with voluntary host pause, an operator resource HUD and optional presence cues. Select small increments after the current indicator is accepted; none may automatically interrupt healthy viewers.

### M1-P13 — Persistent rooms and playback queues

P13-1 through P13-5 are implemented. P13-6 UI has substantial local coverage; remaining acceptance and P13-7 real continuity/recovery checks stay open. Durable records preserve room identity, permissions, bookmarks, queue and history; live viewers, consent and streams are never restored. Auto-queue generation and automatic playback remain separate.

Details: [rooms and queues](docs/rooms-and-queues.md).

### M1-P14 — Configuration, administration and account authorization

**Next:** Inventory settings, defaults, secrets, authority, persistence, restart requirements and effects on active viewers. Define effective access and administrator recovery before implementing mutable settings; YAML remains authoritative until a different contract is approved.

Configured sharing for eligible viewers without personal Plex access is an approved policy, not the obsolete implicit-fallback defect. Expired/revoked credentials, provider errors and item restrictions must fail closed. Keep sign-in, admission, media entitlement, room roles and server administration separate. Preserve Discord sign-in and authorized Activity-to-browser handoff.

**Remaining:** Recent proof for sensitive link/unlink/merge changes, session revocation and adversarial account checks; finer-grained sponsorship/invitation authority; operator bootstrap/recovery. Editable names and existing host assignment are implemented; native login and owner name-lock rules are deferred. Guest passes remain M2-P3.

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
| M2-P7 | Installation validator | CLI checks for configuration, keys, TLS, providers and media tools, with actionable failures |
| M2-P8 | Docker / Compose | Persistent state/external key mounts and optional hardware acceleration; reuse configuration validation |
| M2-P9 | Discord presence and room invites | Discoverable room embeds with lifecycle updates; scope separately from removed bot commands |

Further directions: native-player integration, managed/project-hosted rooms, and Live TV/DVR. Each needs a separate feasibility and authorization scope.

## Document ownership and maintenance

- **This roadmap:** priorities, phase status, remaining outcomes and dependencies. Update the affected row after material work; delete superseded status.
- **[Testing](docs/testing.md):** evidence, failures and open verification gates. Keep dated results and test counts out of this roadmap.
- **[Playback](docs/playback-reliability.md), [delivery](docs/plex-hls-delivery.md), [rooms](docs/rooms-and-queues.md), [accounts](docs/accounts-and-access.md):** detailed requirements and implementation contracts.
- **[Design](docs/design-guide.md), [development](docs/development.md), [self-hosting](docs/self-hosting.md), [upgrading](docs/upgrading.md), [third-party review](docs/third-party.md):** UI decisions, commands, operator procedures and licensing.

Do not append work diaries, UI dimensions, commit narratives, repeated disclaimers or completed test reports here. Preserve substantive evidence in its owning document or history. Private suggestion audits stay in the ignored personal queue.
