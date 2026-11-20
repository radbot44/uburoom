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
- Verify admission, revoked credentials, account changes and media authorization across browser and Activity. Admitted people watch every source through its own credential ([media sources](docs/media-sources.md) phase 1); direct Plex delivery requires a dedicated non-owner `plex.direct_token`.
- Audit source, publication history and ZIP contents for private material and required license/source obligations. Obtain explicit publication approval.

Architecture and implementation constraints remain in [AGENTS.md](AGENTS.md) and [SPEC.md](SPEC.md). UI decisions are recorded in the [design guide](docs/design-guide.md) and [approved screen behavior](docs/ui-behavior.md). Neither a roadmap entry nor a passing test authorizes production changes, provider experiments or publication.

### Verification routing for M1

**A:** source/design review. **B:** isolated automated execution. **C:** real provider/device/network integration. **D:** human acceptance. Required methods and actual results belong in the [verification dashboard](docs/testing.md). Fixture passes cannot close real-environment gates; implementation approval cannot close acceptance gates.

### Phase map

“Implemented” below means the named code increment exists; open verification remains part of its completion gate. Future features within a phase are separate increments, not a requirement to reproduce every provider feature before a first release.

| ID | Area | Implemented | Remaining work |
| --- | --- | --- | --- |
| M1-P1 | Sustained playback | Recovery, diagnostics, early runtime degradation warnings and scoped real two-hour playback evidence; server-kept diagnostics (one daily timeline of server log lines and viewer player events, bounded by `diagnostics.keep_days`/`max_mb`), Copy diagnostic report, disconnect and slow-chunk logging; saved quality, volume, audio and subtitles restored for new viewers; fullscreen errors as toasts; optional room-owned fallback with bounded personal switching and shared preparation | Representative Firefox 4K/device verification, evidence-based HLS tuning, Activity and multi-viewer lifecycle coverage; unexplained unload/resource behavior and long-run accounting; real fallback encoder/load, source-access and device validation; live watch-night review of kept diagnostics |
| M1-P2 | Automatic delivery | Direct file/HLS, opportunistic audio-only remuxing and video stream-copy, proxy recovery, shared outputs, local codec selection, bounded capacity fallback, and negotiation through one delivery plan with observed decode evidence; one Plex session recipe shared by playback and checks; ownership reconcile that ends Plex conversions uburoom no longer holds; host video check (tracks against the file, Plex playback decision, HDR, image subtitles, late audio, peak bitrate, live transcode-drive space and sessions) | Live multi-viewer acceptance of real-time 4K local conversion with frame-accurate chunks (shared decode per source measured at about 2x real time for five qualities on an Arc A380, 2026-11-18), complete source/version inventory, automatic quality and real cross-account/device coverage; video check and session reconcile verified only against a stub Plex |
| M1-P3 | Content fidelity | Personal tracks and initial decoded audio/caption evidence; saved subtitle choice and audio language sent with the join so the first stream has them; first text subtitle window warmed on the server | Real track switching/restoration, downmix, A/V/caption alignment, source cadence and device coverage; subtitle renderer work is P9 |
| M1-P4 | Plex viewing experience | Native viewer observations/history; decoupled session reporting, shared-producer stop safety, activity-only default with personal watch-state opt-in, sponsored isolation, and chapters/intro/credits navigation; stable reporting identity across stream changes/reconnect grace implemented | Baseline live reporting owner-accepted; live continuity verification, deliberate multi-viewer stop/seek, natural completion and personal watch-state checks; viewer-address forwarding deferred for remote-limit risk; later parity increments below |
| M1-P5 | Synchronization | Clock estimation, scheduled controls, readiness, independent recovery, bounded sample expiry, Stage 2 Hybrid EMA presentation sync and reusable `shared/sync/` core | Physical/WAN presentation-skew measurements and calibration with P6; targets remain ≤50 ms p95 / ≤100 ms p99, unverified |
| M1-P6 | Frame pacing | Default proportional correction with Hybrid EMA filtering, opt-in Occasional jumps, and removal of retired precision policy | Joint skew/smoothness acceptance |
| M1-P7 | UI/UX | Layout split, Room/Queue/Media shared controls, sliding player menus, grouped two-column settings dialog with subtitle appearance and client-side sync offset controls, delayed subtitle loading indicator, full-stage ending interstitial, optional human readiness check overlay/roster status, personal preferences and sync-module extraction; host Video check in Player settings with a once-per-video toast; Copy diagnostic report; fullscreen error toasts with Open menu | Current user-journey/accessibility review, physical mobile/Activity acceptance and bounded further modularization |
| M1-P9 | Browser subtitles | ASS/SSA, bounded PGS window extraction/replay and progressive full-track streaming, VobSub rendering, truthful extraction errors, authorized resources and burn-in fallback | Original large-title PGS failure remains an open live retest; real Plex MKV seek/range/timing, complex authored content and Activity/mobile/resource acceptance |
| M1-P10 | Room terminology | Canonical room names/protocol, removal of legacy aliases, and web/Activity terminology audit; “session” retained for technical contexts and “watch parties” preserved for public context | Final packaging review |
| M1-P11 | Architecture hardening | One direct SQLite/WAL connection with prepared account/room/queue/history repositories, bounded retention and history reads, baseline-11 migration runner, typed room connection protocol with state pushed on change in versioned room/viewer/lobby lanes ([protocol](docs/wire-protocol.md)), room actor with one serialized authority, compatibility removal, fault boundaries, bounded tools, installation validator (`npm run doctor`) and Docker/Compose packaging | Real proxy/resource checks; independent container install, backup, restore and rollback rehearsal passed locally |
| M1-P12 | Viewer telemetry | Passive Room sync-quality indicator, detailed viewer telemetry cards, and voluntary host buffering notices; host-only viewer health (buffer, quality, stalls, dropped frames, offset, reconnects, device) with a roster warning from one shared issue rule | Live accuracy/readability acceptance; richer presence remains optional expansion |
| M1-P13 | Persistent rooms and queues | Durable rooms, roles, reopen, manual/bulk queues, single tail preview (`autoQueue.next`), `continue`/in-order/shuffle modes, `pin`/`skip`/`playNow` controls, host-approved ephemeral room media suggestions, cancellable autoplay, full-stage ending interstitial and explicit endpoint completion; countdown stream preparation/adoption; final shutdown snapshots, retained preload ownership and bounded preparation cleanup implemented locally | Broader retained-state/load verification, dual-browser tail-preview/`continue` checks, real Plex/Activity continuity and UX acceptance remain; endpoint-seek fix owner-verified |
| M1-P14 | Configuration and accounts | YAML policy, verified operator authorization, running/saved settings APIs, validated YAML saves and 18-key browser settings panel (Rooms, Directory, Transcoding), Activity handoff, single-room controls, editable names and host discovery/assignment | Three-outcome A/B verification complete; independent container install, backup/rollback and key resilience rehearsal verified locally; real provider admission/revocation remain release gates |

### M1-P4 — Plex viewing experience

**Implemented:** Decoupled Plex reporting, stable viewing identity across eligible reconnects and stream changes, activity-only default with opt-in personal watch-state writes, sponsored isolation, chapters and edition navigation. Live Tautulli reporting baseline has owner acceptance.

**Open:** Live PMS/Tautulli identity continuity, deliberate multi-viewer stop/seek, natural ending and personal watch-state checks. Address forwarding remains deferred due to remote-stream limit risk. See [accounts and reporting](docs/accounts-and-access.md), [investigation archive](docs/archive/plex-reporting-investigation.md) and [testing](docs/testing.md). Later Plex parity features are separate scope.

### M1-P12 — Viewer telemetry

**Implemented:** Viewer health cards, host-only issue indicators and buffering notices, plus room offset-spread summaries. One shared sync-quality classifier handles health reporting; no healthy viewer is automatically interrupted.

**Open:** Multi-device accuracy, readability and guest acceptance. Other monitoring surfaces are optional. See [sync core](docs/sync-core.md) and [testing](docs/testing.md).

### M1-P13 — Persistent rooms and playback queues

**Implemented:** Durable rooms, histories and queues; single tail auto-queue preview, continue/in-order/shuffle, autoplay countdown and ending state. Final snapshots and bounded cleanup preserve retained intent without restoring live viewers or consent.

**Open:** Dual-browser preview/continue UX, real Plex/Activity recovery, retained-state/load and measured transition timing. See [rooms and queues](docs/rooms-and-queues.md), [recovery investigation archive](docs/archive/room-recovery-investigation.md) and [testing](docs/testing.md).

### M1-P14 — Configuration, administration and account authorization

**Implemented (A/B):** Verified operator-only settings, protected account linking and session revocation, and validated 19-key browser configuration with YAML-only security settings. Local restore/rollback and key-safety rehearsal retain the original encryption key and account identities.

**Open:** Independent installation, actual provider/device authorization, operator recovery and release acceptance. See [accounts and access](docs/accounts-and-access.md), [self-hosting](docs/self-hosting.md) and [testing](docs/testing.md).

## M2 — Future planned capabilities

Select and scope these individually after the relevant foundations are ready. This list is not implementation authorization.

| ID | Capability | Boundary / prerequisite |
| --- | --- | --- |
| M2-P1 | HDR | Implemented: Dolby Vision profile classification (Profile 5 `IPTPQc2` vs Profile 7/8.1 HDR10 base, 8.4 HLG base and 8.2 SDR base), Vulkan `libplacebo` (`apply_dolbyvision=1`) and CPU `zscale` HDR-to-SDR tone mapping, and display-aware Original HDR passthrough with SDR fallback; live HDR/DV media and display acceptance open |
| M2-P2 | Subtitle-aware Picture-in-Picture | Implemented: Document Picture-in-Picture with stage reparenting, full hover transport bar, and vector/bitmap subtitle canvas layers; native video PiP fallback with client-subtitle burn-in recommendation toast; live browser acceptance open |
| M2-P3 | Room invites and guests | Single invite per room with Allow guests and the trusted tier is implemented; source review and isolated execution pass. Real-provider (Discord share link) and human acceptance remain open. Invites and guests never imply media or host authority |
| M2-P4 | Local library and Jellyfin integration | Implemented through the shared provider registry; local folders and Jellyfin browsing, queues and conversions have isolated fixture coverage. Real library/server, decoded browser playback and owner acceptance remain open. Emby support is future scope; see [playback reliability](docs/playback-reliability.md) |
| M2-P5 | Shared YouTube playback | Use P5 timeline and P11 command transport; account for embed, ad and buffering constraints |
| M2-P6 | Dialogue Boost / Night Mode | Implemented: personal client-side Web Audio dynamic range compression, speech peaking EQ and 3-choice selector (Normal/Dialogue/Night) in player dialog and sliding menu; live browser acceptance open |
| M2-P9 | Discord presence and room invites | Host publishing, room/event invitations, watch-night scheduling and opt-in Activity Rich Presence implemented. Real Discord Activity and owner acceptance remain open; see [Discord sharing](docs/self-hosting.md#publish-rooms-to-discord) |
| M2-P10 | Native client integration (`plezy-uburoom`) | Companion Flutter/`libmpv` client using authenticated `/watch-socket` sync on the typed room protocol (version 2), expiring handoff bearer tokens, and `delivery=local` for downloaded Plex files without upstream transcode allocation |

Further directions: managed/project-hosted rooms and Live TV/DVR. Each needs a separate feasibility and authorization scope.

## Document ownership and maintenance

- **This roadmap:** priorities, phase status, remaining outcomes and dependencies. Update the affected row after material work; delete superseded status.
- **[Testing](docs/testing.md):** evidence, failures and open verification gates. Keep dated results and test counts out of this roadmap.
- **[Playback & delivery](docs/playback-reliability.md), [sync core](docs/sync-core.md), [rooms](docs/rooms-and-queues.md), [accounts](docs/accounts-and-access.md):** detailed requirements and implementation contracts.
- **[Design](docs/design-guide.md), [screen behavior](docs/ui-behavior.md), [development](docs/development.md), [self-hosting](docs/self-hosting.md), [Docker](docs/docker.md), [upgrading](docs/upgrading.md), [third-party review](docs/third-party.md):** UI decisions, commands, operator procedures and licensing.

Do not append work diaries, UI dimensions, commit narratives, repeated disclaimers or completed test reports here. Preserve substantive evidence in its owning document or history. Private suggestion audits stay in the ignored personal queue.
