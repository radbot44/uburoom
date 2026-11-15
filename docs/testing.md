# Verification dashboard — M1

**Release status: open.** Last full-suite baseline: **478 passed, 0 failed, 0 skipped** (2026-11-15, at `31cb808`) on Node v22.13+. Results apply to their recorded revisions/scenarios; they do not combine into an assumed current-HEAD pass. [Release gates](../ROADMAP.md#m1--verified-self-hosted-release) · [Verification log](archive/testing-log.md) · [Historical digest through 2026-10-22](archive/testing-2026-10-22.md) · [Historical digest 2026-10-23 to 2026-11-08](archive/testing-2026-11-08.md) · [Commands](development.md#tests).

---

## Verification standard for new work

| Method | Evidence | Limit |
| --- | --- | --- |
| A — Review | Source/contracts/rendered inspection | Not execution |
| B — Automated | Isolated fixtures, browser pixels/PCM, fault tests | Not real provider/device acceptance |
| C — Integration | Actual named provider/device/network/hardware | Only the measured configuration |
| D — Human | Recorded perceptual/usability acceptance | Not numerical/security proof |

Record date/revision, scope/environment, command/procedure, actual outcome and failures/skips, remaining methods, and sanitized evidence. Label each required method pass/fail/blocked/not run. API success, capability hints, and advancing clocks are not decoded playback, persisted history, or physical synchronization. Unexpected skips invalidate a full-suite pass. C integration and production/history changes require explicit authorization.

---

## Active verification commands

| Need | Command |
| --- | --- |
| Node test suite | `npm test` (`node --test --test-reporter=dot tests/*.test.js`) |
| Full pass/fail/skip output | `npm run test:full` (`node --test tests/*.test.js`) |
| Installation diagnostics / doctor | `npm run doctor` (`node scripts/doctor.js`) |
| Clock and drift-controller simulation | `npm run sync:bench` (also runs in `npm test` as `tests/sync-bench.test.js`) |
| Decoded video/audio baseline | `npm run test:playback` (`node scripts/playback-baseline.js`) |
| Room lifecycle / permissions | `node scripts/room-ui-smoke.js --browsers=chrome,firefox` |
| Queue / Media controls | `node scripts/queue-controls-smoke.js` / `node scripts/media-controls-smoke.js` |
| Library browsing | `node scripts/plex-library-smoke.js` |
| Scheduled controls | `node scripts/sync-controls-smoke.js --browser=chrome` |
| Local WebM | `node scripts/local-webm-smoke.js --browser=chrome --codec=vp9` |

Use both Chrome and Firefox for relevant browser checks. TLS, browser binaries, and FFmpeg/FFprobe may be required. Missing prerequisites or unexpected skips are not a clean pass. Fixtures establish isolated behavior, not real Plex/Activity/device support.

---

## Outstanding M1 verification register

| Gate | Required methods | Remaining |
| --- | --- | --- |
| Release | A/B/C, D UX | Independent install/origin/providers, operator restore/rollback, source/history/ZIP privacy and licensing |
| P1 endurance | B/C/D | Real Firefox/Activity/multi-viewer endurance, hardware/resources, unload cause, and physical fidelity |
| P2 delivery | A/B/C | Owner acceptance of real-time frame-accurate 4K local conversion on real Plex input, Linux/macOS decode routes, and real cross-account/codec/capacity matrix; negotiation closed as scoped in [playback reliability](playback-reliability.md#playback-decisions) |
| P3 fidelity | B/C/D | Real languages/downmix/captions and switching |
| P4 reporting | C/D (A/B on main) | Live PMS/Tautulli validation, multi-viewer shared-producer stop/seek transitions, natural completion, external AV1 telemetry, and personal-state/sponsorship isolation |
| P5/P6 sync/pacing | B/C/D | Physical/WAN ±50ms p95 / ±100ms p99, supported-policy disposition, and joint smoothness acceptance |
| P7 UI | A/B/C/D | Broader journeys, physical mobile/Activity/accessibility, and owner acceptance |
| P9 subtitles | B/C/D; A licensing | Real authored fonts/content, lifecycle/resources, and corresponding-source review |
| P10 terminology | A; B/C where affected | Final current web/Activity sweep; canonical protocol has historical local evidence |
| P11 architecture | A/B/C | Real proxy/resources and operator backup/restore/rollback |
| P12 telemetry | A/B/C/D | Repeat actual-device score/confidence and readability; richer features remain future scope |
| P13 rooms/queues | B/C/D | Real multi-viewer continuation, recovery, writer/load, and UX |
| P14 access/admin | A/B complete; C/D release checks | Three-outcome local scope closed; real admission/revocation/handoff and independent operator recovery remain release gates |

P5/P6 human check: watch together ~3 minutes, pause/resume/seek, background one tab ~10 seconds and return. Technical timing remains separate. Design authorization is not visual acceptance; neither permits deployment.

---

## Outstanding M2 capability register

| Capability | Implemented scope | Remaining gates |
| --- | --- | --- |
| M2-P1 HDR | Tone mapping and profile detection planned | Passthrough and HDR-to-SDR tone mapping verification |
| M2-P2 Picture-in-Picture | Document PiP with stage reparenting, hover controls, subtitle canvas; native video PiP fallback | Live browser perceptual acceptance |
| M2-P3 Invites & guests | Invite token generation, guest limits, trusted server tier | Real-provider OAuth and human acceptance |
| M2-P4 Granular permissions | Role model planned | Fine-grained seek/queue authorization |
| M2-P4 Local video library | Provider registry with Plex and local folders; `local_media.libraries`, direct play, local conversion, embedded and sidecar subtitles, queue and resume across a restart at `31cb808` (B) | Real library and real Plex beside it, decoded browser playback, second viewer and guests, Firefox/light/phone rendering, owner acceptance (C/D). Jellyfin provider at `bde6228` (B, fake server): every real-server behaviour, rendered library, room playback and owner acceptance (C/D) |
| M2-P5 Subtitle sync | Client-side subtitle sync offset controls (`±30 s`, `±0.5 s`/Reset, `KeyG`/`KeyH`/`Backslash`, 100-entry `localStorage` LRU per `(mediaId, track)`, disabled in Burn-in while preserving saved offset) at `fe01959` (B) | Live multi-viewer playback & owner acceptance (C/D) |
| M2-P6 Native companion | Hybrid direct-Plex + uburoom sync architecture defined ([plezy-uburoom](../../plezy-uburoom/AGENTS.md)) | Native client integration and delivery=local testing |
| M2-P7 Diagnostics dashboard | Host diagnostics planned | Live operator health dashboard |
| M2-P8 Docker packaging | Rehearsal automated in Compose; production templates | Multi-arch build and release packaging |
| M2-P9 Discord scheduled events & Rich Presence | Event creation/edit lifecycle, conflict handling, invite reconciliation, share cancellation; opt-in Activity personal Discord Rich Presence (`rpc.activities.write`, private-room redaction, `discord.rich_presence` config switch) at `fe01959` (B) | Live Discord guild event & Activity Rich Presence acceptance (C/D) |

---

## Current state

One line per area: the latest result and what is still open. The dated evidence behind each line is in the [verification log](archive/testing-log.md).

| Area | Latest result | Open |
| --- | --- | --- |
| M1-P11 direct storage | A/B 2026-11-13 at 25859ef: direct WAL/NORMAL connection, atomic room/login writes, forced-kill acknowledgement recovery, baseline-11 copy startup and doctor 18/18; 453 tests and all 15 traces pass | Real operator backup/restore and power-loss behavior (C); temporary Plex receipt compatibility export remains |
| M1-P11 / P14 rehearsal and keys | B 2026-11-08: Compose rehearsal, doctor 14/14, missing/mismatched key guards, key recovery | Live operator recovery (C) |
| M1-P13 rooms and queues | A/B 2026-11-14 at `fe01959`: host-approved ephemeral room media suggestions (`suggestMedia`) and optional human readiness check (`check.ask`/`check.clear`/`check.reply`) alongside teardown, writer contention, auto-queue preview and controls; `npm run test:full` (`478/478`), `format:check`, `lint`, `typecheck`, Chrome/Firefox `room-ui-smoke.js` and `queue-controls-smoke.js` pass, `doctor.js` (`16 passed, 1 warning` local Plex offline) | Real multi-viewer continuity, endurance, and live C/D acceptance |
| M1-P4 Plex reporting | C/D 2026-11-06: live watch party in Tautulli; B 2026-11-07: stable occurrence across stream switches | Live PMS/Tautulli multi-viewer transitions |
| M1-P1 / P2 delivery | A/B 2026-11-06: unified delivery plan; outage continuity | Real-time 4K local conversion on real Plex input |
| M1-P11 connection protocol | B 2026-11-12 at c158444: typed, pushed on change; idle room sends nothing | Watch night on the deployed server; native client against a live server; above 256 connections |
| Browser client structure | B 2026-11-13: modules, store, one tick, layered component styles, one time base; 156 screenshots unchanged in Chrome and Firefox | Playback, sync and recovery runners in `scripts/`; real two-browser playback; Activity |
| Browser UI accessibility | B 2026-11-13: Stage 2 verified in Chrome (`157.0.8103.51`) and Firefox (`160.0`) with `0` non-exempt `< 40 px` targets, `0` skipped headings, Forced Colours borders/highlights/wordmarks, unclipped `#tracks-dialog`, `room-ui-smoke.js` pass, `156` UI captures (`142` differ vs pre-Stage-2 baseline), and `453/453` unit tests; see [accessibility-walkthrough](accessibility-walkthrough.md) | Assistive-technology screen reader, physical keyboard (incl. Firefox initial-`Tab` `#skip-link`), physical mobile/Activity hardware, and owner acceptance |
| M1-P5 / P6 sync and pacing | B 2026-11-13: sync bench (`npm run sync:bench`), simulation only; viewer spread now reported by the server (S7) | Physical/WAN ±50 ms p95 / ±100 ms p99; a watch-night spread figure |
| M2-P4 media providers and local library | A/B 2026-11-15 at `31cb808`: scratch server with a fake Plex and a local library over real HTTPS and the room connection with real FFmpeg, 30/30 play checks and 6/6 after a restart on the same database; doctor against scratch configs; Libraries home and the local library rendered in headless Chrome (dark, desktop); `test:full` (`478/478`), `format:check`, `lint`, `typecheck` | Real Plex and a real library (C); decoded picture and sound in a browser; second viewer and guests; Firefox, light theme, phone width; local-only install without Plex; owner acceptance (D) |
| M2-P4 Jellyfin provider | A/B 2026-11-15 at `bde6228`: provider driven against a fake Jellyfin written from the API documentation, 14/14 checks (config, server-id pinning, libraries, paging, search, year, seeded shuffle, shows/seasons/episodes, queue sources, filters, details, artwork, availability, URL confinement, ranged original bytes equal to the file, external SRT, no provider transcode, and a real FFmpeg conversion of the original read through ranged provider requests); full app booted with a Jellyfin-only configuration; `npm test`, `lint`, `format:check`, `typecheck` | No real Jellyfin server (C): the authorization header, endpoint and field names, stream indexes for embedded subtitles when external ones exist, and servers before 10.9 are unconfirmed. Not rendered in a browser; no room-level play through a Jellyfin item; owner acceptance (D) |
| M2-P4 Plex behind the provider | A/B 2026-11-15 at `562b1a4`: reporting, direct delivery, session cleanup and video-check items moved onto the Plex provider; shared room code and messages name a provider; `npm test`, `lint`, `format:check`, `typecheck`; `npm run doctor` on a local-only and an empty configuration; app booted with Jellyfin only (no Plex sign-in offered, no direct origins, no reporting, empty provider checks) | No install without Plex used in a browser; Plex direct delivery and reporting not re-run against a real server after the move (C); owner acceptance (D) |
| M1-P3 / P9 subtitles | A/B 2026-11-14 at `fe01959`: client-side subtitle sync offset (`±30 s`, per `(mediaId, track)` LRU, Burn-in guard) and bounded PGS extraction/seek cancellation verified in `478/478` tests and Chrome/Firefox smoke checks | Authored fonts, Activity mobile subtitles, live C/D offset acceptance, licensing review |
| M2-P3 / P9 invites, events & Rich Presence | B 2026-11-14 at `fe01959`: watch-night UI in preview with Discord fixture plus opt-in Activity personal Rich Presence (`discord.rich_presence`, `478/478` unit tests, `format:check`, `lint`, `typecheck`, `doctor.js`) | Live Discord guild & Activity Rich Presence acceptance (C/D); usability review |

---

## Known failures and active limitations

| Issue | Disposition |
| --- | --- |
| Queue controls smoke | Repaired 2026-11-13 on `38a4bdc`: updated to `startFixtureServer()`, `openPage` at `/?demo=host`, current page-global accessors, `transport.request(message, options)` interception, `OverlayScrollbars` body-instance check, `continue` mode step, and 46px segmented group / 40px button heights; passes twice consecutively in Chrome and Firefox |
| AV1 ending | Prior live ~42 ms final-buffer gap; 2026-10-23 C/D Discord AV1/QSV near-end replay finished cleanly; broader media/multi-viewer/endurance coverage open |
| Real soak | First run unloaded and recovered; repeat run clean. Original trigger unproven (suspected transient internet dropout) |
| Timing tests under load | Known to flake when the machine is busy: "generated two-hour MKV windows" can fail under concurrent load and passes alone; obsolete worker/lock timing assertions were replaced by direct-write failure/retry and crash recovery checks in A6 |
| Browser limits | Firefox Escape exits fullscreen, narrow drawer resize timeout, sparse high-rate frame callbacks; emulated touch is not real-device evidence |

---

## Maintenance

This page is a gate register: update the affected gate or current-state line in place, never append a history. Record each run as a new dated entry at the end of the [verification log](archive/testing-log.md); never edit earlier entries. Keep commands in `development.md`, requirements in owning plans, and screenshots and raw traces in the evidence folder outside the repository. Do not restore retired runners or turn old results into current green status.
