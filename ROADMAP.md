# uburoom roadmap

A map of priorities and unfinished work. Implementation does not imply live verification or release readiness. Detailed requirements belong in the linked plans; results belong in [testing](docs/testing.md). Phase IDs stay stable; retired M1-P8 transport work and baseline M2-P7/M2-P8 installation diagnostics and Docker/Compose packaging are owned by M1-P11.

## Priorities

1. **Configuration and administration (P14):** Three-outcome A/B verification complete: authorization boundaries, safe account mutations/session revocation, and supported settings with matched backup/restore. Real installation and recovery checks remain release gates.
2. **Playback continuity (P1/P2/P13):** Verify real multi-viewer delivery, independent recovery, natural ending, queue transitions and resource cleanup on a bounded browser/provider configuration.
3. **Plex reporting (P4):** Live reporting baseline is owner-accepted based on watch-night Tautulli history ([testing](docs/testing.md)). Stable viewing identity across stream changes/reconnect grace implemented; live continuity verification remains. Address forwarding deferred for remote-limit risk. Deliberate stop/seek, natural-completion and personal watch-state checks remain.
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
| M1-P1 | Sustained playback | Recovery, diagnostics, early runtime degradation warnings and scoped real two-hour playback evidence; server-kept diagnostics (one daily timeline of server log lines and viewer player events, bounded by `diagnostics.keep_days`/`max_mb`), Copy diagnostic report, disconnect and slow-chunk logging; saved quality, volume, audio and subtitles restored for new viewers; fullscreen errors as toasts; optional room-owned fallback with bounded personal switching and shared preparation | Representative Firefox 4K/device verification, evidence-based HLS tuning, Activity and multi-viewer lifecycle coverage; unexplained unload/resource behavior and long-run accounting; real fallback encoder/load, source-access and device validation; live watch-night review of kept diagnostics |
| M1-P2 | Automatic delivery | Direct file/HLS, opportunistic audio-only remuxing and video stream-copy, proxy recovery, shared outputs, local codec selection, bounded capacity fallback, and negotiation through one delivery plan with observed decode evidence; one Plex session recipe shared by playback and checks; ownership reconcile that ends Plex conversions uburoom no longer holds; host video check (tracks against the file, Plex playback decision, HDR, image subtitles, late audio, peak bitrate, live transcode-drive space and sessions) | Real-time 4K local conversion with frame-accurate chunks, complete source/version inventory, automatic quality and real cross-account/device coverage; video check and session reconcile verified only against a stub Plex |
| M1-P3 | Content fidelity | Personal tracks and initial decoded audio/caption evidence; saved subtitle choice and audio language sent with the join so the first stream has them; first text subtitle window warmed on the server | Real track switching/restoration, downmix, A/V/caption alignment, source cadence and device coverage; subtitle renderer work is P9 |
| M1-P4 | Plex viewing experience | Native viewer observations/history; decoupled session reporting, shared-producer stop safety, activity-only default with personal watch-state opt-in, sponsored isolation, and chapters/intro/credits navigation; stable reporting identity across stream changes/reconnect grace implemented | Baseline live reporting owner-accepted; live continuity verification, deliberate multi-viewer stop/seek, natural completion and personal watch-state checks; viewer-address forwarding deferred for remote-limit risk; later parity increments below |
| M1-P5 | Synchronization | Clock estimation, scheduled controls, readiness, independent recovery, bounded sample expiry, Stage 2 Hybrid EMA presentation sync and reusable `shared/sync/` core | Physical/WAN presentation-skew measurements and calibration with P6; targets remain ≤50 ms p95 / ≤100 ms p99, unverified |
| M1-P6 | Frame pacing | Default proportional correction with Hybrid EMA filtering, opt-in Occasional jumps, and removal of retired precision policy | Joint skew/smoothness acceptance |
| M1-P7 | UI/UX | Layout split, Room/Queue/Media shared controls, sliding player menus, grouped two-column settings dialog with subtitle appearance controls, delayed subtitle loading indicator, full-stage ending interstitial, personal preferences and sync-module extraction; host Video check in Player settings with a once-per-video toast; Copy diagnostic report; fullscreen error toasts with Open menu | Current user-journey/accessibility review, physical mobile/Activity acceptance and bounded further modularization |
| M1-P9 | Browser subtitles | ASS/SSA, bounded PGS window extraction/replay and progressive full-track streaming, VobSub rendering, truthful extraction errors, authorized resources and burn-in fallback | Original large-title PGS failure remains an open live retest; real Plex MKV seek/range/timing, complex authored content and Activity/mobile/resource acceptance |
| M1-P10 | Room terminology | Canonical room names/protocol, removal of legacy aliases, and web/Activity terminology audit; “session” retained for technical contexts and “watch parties” preserved for public context | Final packaging review |
| M1-P11 | Architecture hardening | SQLite worker/mirror, WebSocket-native room operations, room-scoped state notifications, compatibility removal, fault boundaries, bounded tools, installation validator (`npm run doctor`) and Docker/Compose packaging | Real proxy/resource checks; independent container install, backup, restore and rollback rehearsal passed locally |
| M1-P12 | Viewer telemetry | Passive Room sync-quality indicator, detailed viewer telemetry cards, and voluntary host buffering notices; host-only viewer health (buffer, quality, stalls, dropped frames, offset, reconnects, device) with a roster warning from one shared issue rule | Live accuracy/readability acceptance; richer presence remains optional expansion |
| M1-P13 | Persistent rooms and queues | Durable rooms, roles, reopen, manual/bulk queues, single tail preview (`autoQueue.next`), `continue`/in-order/shuffle modes, `pin`/`skip`/`playNow` controls, cancellable autoplay, full-stage ending interstitial and explicit endpoint completion; countdown stream preparation/adoption; final shutdown snapshots, retained preload ownership and bounded preparation cleanup implemented locally | Broader retained-state/load verification, dual-browser tail-preview/`continue` checks, real Plex/Activity continuity and UX acceptance remain; endpoint-seek fix owner-verified |
| M1-P14 | Configuration and accounts | YAML policy, verified operator authorization, running/saved settings APIs, validated YAML saves and 19-key browser settings panel (Rooms, Directory, Transcoding), configured sponsorship, Activity handoff, single-room controls, editable names and host discovery/assignment | Three-outcome A/B verification complete; independent container install, backup/rollback and key resilience rehearsal verified locally; real provider admission/revocation remain release gates |

### M1-P4 — Plex viewing experience

**Status:** Decoupled reporting architecture, shared-producer safety (preventing viewer teardowns from terminating pooled HLS transcode slots), activity-only default with explicit per-user personal watch-state opt-in, sponsored viewer isolation, chapter markers/intro-credit skip navigation, library watch progress with room-priority resume actions, multi-edition separation, and details drawer sibling edition navigation are implemented and covered by unit/lifecycle tests on main. Version-qualified media identity now round-trips through queue, bookmark, provider and reporting paths, and reporting sends one current desired state under present consent.

Reporter-owned viewing continuity is now implemented on main: one occurrence survives stream/observation changes and eligible reconnects, while bounded gap updates remain activity-only and terminal events include suspended viewers. The reporting and producer identities stay separate.

**Next:** Baseline live reporting is owner-accepted from watch-night Tautulli history ([testing](docs/testing.md)). Verify continuity against actual PMS session keys and ungrouped Tautulli history under separately authorized tests; deliberate multi-viewer stop/seek, natural-completion and personal watch-state checks remain open. [Address forwarding](docs/plex-reporting-investigation.md) is deferred pending the owner's remote-stream/quality-limit risk decision and authorized live validation.

**Later increments:** Split-file timelines, previews/extras; subtitle search and supported presentation/audio controls. Episode continuation uses P13's queue transition, not a second advance path.

Details: [accounts and reporting](docs/accounts-and-access.md), [reporting investigation](docs/plex-reporting-investigation.md), [playback plan](docs/playback-reliability.md).

### M1-P12 — Viewer telemetry

**Status:** Passive Room sync-quality indicator, interactive viewer telemetry cards (with live status pills, sync score %, diagnostic explanation, and freshness), and host-gated voluntary buffering notices (`Pause to wait` and `Resume playback`) are implemented and covered by unit/lifecycle tests on main. Each sync report also carries playback health, validated in `shared/sync/quality.mjs`, which alone decides whether a viewer has an issue (error, stalling, low buffer, dropped frames or poor sync, held 15 seconds). Hosts see a warning in the roster and the details on the card; other viewers never receive them. Deployed to Vigrid; not yet checked with real guests.

**Next:** Complete live accuracy and readability acceptance across multi-device viewing parties. Further expansions (timeline viewer indicators, operator resource HUD, optional presence cues) remain optional. None may automatically interrupt healthy viewers.

### M1-P13 — Persistent rooms and playback queues

P13-1 through P13-5 are implemented, including single persisted tail previews (`autoQueue.next`), dynamic `continue` mode alongside `following` (In order) and `random` (Shuffle), `pin`/`skip`/`playNow` controls, full-stage ending interstitials, and bounded Plex catalog expansion without per-item file-check waterfalls. P13-6 UI has substantial local coverage; dual-browser rendered checks for the tail-preview/`continue` UI, remaining acceptance and P13-7 real continuity/recovery checks stay open. Durable records preserve room identity, permissions, bookmarks, queue and history; live viewers, consent and streams are never restored. The autoplay countdown prepares the next video (metadata, video check, every viewer's stream) through the normal paths; viewers adopt their prepared stream at the switch, and anything unadopted or cancelled is stopped. Start-time gains are not yet measured against real Plex. Auto-queue generation and automatic playback remain separate.

Details: [rooms and queues](docs/rooms-and-queues.md).

Owner-approved fixes from the [recovery/writer investigation](docs/room-recovery-investigation.md) are implemented in the local working tree: final snapshots preserve progress/intent before teardown, stale countdowns retain cleanup ownership, and bounded preparation cleanup drains independently of commit receipts before normal provider closure. Fixture, atomic commit/restart and short load checks passed in scope; real continuity, endurance and device gates remain open.

### M1-P14 — Configuration, administration and account authorization

**Status:** Private `config.yaml` remains the sole configuration authority. The browser Server Settings panel and `/api/operator/settings/saved` cover the complete M1 browser-editable scope (the 19-key allowlist across Rooms, Directory and Transcoding, requiring a manual restart to take effect), while access policy, single-room mode, retention/history deletion, operator IDs, credentials, connections and paths remain YAML-only.

**Complete (A/B):** P14 is bounded to three verified outcomes:

1. **Authorization boundaries:** Verified operator identities alone authorize server settings. Room roles grant no Plex entitlement. Detected provider/item revocation rejects media, captions and subtitle windows and aborts active proxy streams.
2. **Account safety:** Last usable login, conflicting identity and stale mutation protections are verified. Linking advances account revision; account changes revoke prior sessions, Activity tokens, media grants and viewers. Logout revokes the selected browser and its viewers.
3. **Configuration and recovery:** All 19 supported keys pass the validated settings API; comments/private values and conflict handling are preserved. A consistent live SQLite snapshot plus YAML and the original key restores accounts, encrypted credentials, durable rooms/queues and settings, including rollback of subsequent fixture changes.

Provider detection retains existing cache/polling bounds; direct Plex delivery depends on PMS enforcement. Real-provider/device integration and live operator recovery remain release checks, with independent container install, backup/rollback, and key-guard rehearsal limits recorded in [testing](docs/testing.md).

Configured sharing for eligible viewers without personal Plex access is an approved policy, not the obsolete implicit-fallback defect. Expired/revoked credentials, provider errors and item restrictions must fail closed; during a provider outage admitted viewers keep their place while new admission fails closed. Editable names and existing host assignment are implemented; native login and owner name-lock rules are deferred. Room invites with guests (M2-P3) and the trusted server tier are implemented and pass isolated checks; real-provider and human acceptance remain.

Details: [accounts and access](docs/accounts-and-access.md).

## M2 — Future planned capabilities

Select and scope these individually after the relevant foundations are ready. This list is not implementation authorization.

| ID | Capability | Boundary / prerequisite |
| --- | --- | --- |
| M2-P1 | HDR | Verify capable-client passthrough and HDR-to-SDR tone mapping; distinguish Dolby Vision profiles |
| M2-P2 | Subtitle-aware Picture-in-Picture | Implemented: Document Picture-in-Picture with stage reparenting, full hover transport bar, and vector/bitmap subtitle canvas layers; native video PiP fallback with client-subtitle burn-in recommendation toast; live browser acceptance open |
| M2-P3 | Room invites and guests | Single invite per room with Allow guests and the trusted tier is implemented; source review and isolated execution pass. Real-provider (Discord share link) and human acceptance remain open. Invites and guests never imply media or host authority |
| M2-P4 | Local video library | Operator-selected folders, basic playback/conversion; no Plex-style metadata platform |
| M2-P5 | Shared YouTube playback | Use P5 timeline and P11 command transport; account for embed, ad and buffering constraints |
| M2-P6 | Dialogue Boost / Night Mode | Implemented: personal client-side Web Audio dynamic range compression, speech peaking EQ and 3-choice selector (Normal/Dialogue/Night) in player dialog and sliding menu; live browser acceptance open |
| M2-P9 | Discord presence and room invites | Deployed: explicit host publishing through Share, live room cards and native scheduled events, including removal/event-cancellation fixes, simpler copy, full invite URLs and poster thumbnails. Local follow-up removes stale room/playback checks from publishing and event changes, narrows edit conflicts to event details, permits same-time events and removes invite validation from cancellation. Stage 1 of lobby watch nights is local and uncommitted: events are stored by uburoom (schema 11), Discord posting is optional, the `events.schedulers` tier (default trusted) controls scheduling, events follow room visibility and keep their room until they end. The lobby Schedule button, shared scheduler, Upcoming cards and waiting-for-host page are the next stages. Real Discord and owner acceptance remain open; personal Rich Presence is separately scoped. See [Discord sharing](docs/self-hosting.md#publish-rooms-to-discord) |
| M2-P10 | Native client integration (`plezy-uburoom`) | Companion Flutter/`libmpv` client using authenticated `/watch-socket` sync, expiring handoff bearer tokens, and `delivery=local` for downloaded Plex files without upstream transcode allocation |

Further directions: managed/project-hosted rooms and Live TV/DVR. Each needs a separate feasibility and authorization scope.

## Document ownership and maintenance

- **This roadmap:** priorities, phase status, remaining outcomes and dependencies. Update the affected row after material work; delete superseded status.
- **[Testing](docs/testing.md):** evidence, failures and open verification gates. Keep dated results and test counts out of this roadmap.
- **[Playback & delivery](docs/playback-reliability.md), [sync core](docs/sync-core.md), [rooms](docs/rooms-and-queues.md), [accounts](docs/accounts-and-access.md):** detailed requirements and implementation contracts.
- **[Design](docs/design-guide.md), [development](docs/development.md), [self-hosting](docs/self-hosting.md), [Docker](docs/docker.md), [upgrading](docs/upgrading.md), [third-party review](docs/third-party.md):** UI decisions, commands, operator procedures and licensing.

Do not append work diaries, UI dimensions, commit narratives, repeated disclaimers or completed test reports here. Preserve substantive evidence in its owning document or history. Private suggestion audits stay in the ignored personal queue.
