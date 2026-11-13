# Verification dashboard — M1

**Release status: open.** Current HEAD baseline: **509 passed, 0 failed, 0 skipped** on Node v22.13+. Results apply to their recorded revisions/scenarios; they do not combine into an assumed current-HEAD pass. [Release gates](../ROADMAP.md#m1--verified-self-hosted-release) · [Historical digest through 2026-10-22](archive/testing-2026-10-22.md) · [Historical digest 2026-10-23 to 2026-11-08](archive/testing-2026-11-08.md) · [Commands](development.md#tests).

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
| M2-P5 Subtitle sync | Client offset controls planned | Per-viewer offset adjustment and persistence |
| M2-P6 Native companion | Hybrid direct-Plex + uburoom sync architecture defined ([plezy-uburoom](../../plezy-uburoom/AGENTS.md)) | Native client integration and delivery=local testing |
| M2-P7 Diagnostics dashboard | Host diagnostics planned | Live operator health dashboard |
| M2-P8 Docker packaging | Rehearsal automated in Compose; production templates | Multi-arch build and release packaging |
| M2-P9 Discord scheduled events | Event creation/edit lifecycle, conflict handling, invite reconciliation, share cancellation | Live Discord guild event acceptance |

---

## Material verification status (Active high-water marks)

### M1-P11 / M1-P14 — Container rehearsal & key resilience
- **B (2026-11-08):** Automated rehearsal via Docker Compose (`desktop-linux`, container Node v22.23.4 / Debian 12, host Node v22.22.2 / Windows). Verified independent clean installation, diagnosis, matched snapshot backup, destructive mutation rollback, and credential key protection without touching Vigrid or production data.
- **Doctor check:** `scripts/doctor.js --json` passed **14 checks, zero failures** against isolated `fake-plex`.
- **Key resilience probes:**
  - *Probe 7A (Missing key guard):* Missing `credentials.key` fails doctor cleanly without generating an orphaned replacement key.
  - *Probe 7B (Mismatched key guard):* Mismatched random 32-byte key is rejected without overwriting existing credentials.
  - *Probe 7C (Legitimate recovery):* Restoring original key bytes passes 100% of doctor checks and restores HTTP 200 `/health`.
- **Evidence:** Sanitized trace logged in `artifacts/rehearsal/results/rehearsal-evidence.json`. Live operator recovery remains a C release gate.

### M1-P13 — Room recovery, autoplay & playback queues
- **A/B (2026-11-07):** Evaluated room teardown and writer contention. Final snapshots preserve room intent before teardown. Stale countdown timers retain cleanup ownership. Bounded preparation cleanup drains independently of commit receipts before normal provider closure.
- **AutoQueue & controls:** Verified single persisted tail preview (`autoQueue.next`), dynamic `continue` mode alongside `following` and `random`, `pin`/`skip`/`playNow` controls, and full-stage ending interstitials without per-item file-check waterfalls.
- **Open:** Real-provider multi-viewer continuity and endurance remain open.

### M1-P4 — Plex timeline reporting & session cleanup
- **C/D (2026-11-06):** Verified on a live watch party with owner acceptance recorded in Tautulli history. Confirmed correct activity-only attribution and rejection of ambiguous key-only identities.
- **Stream transitions (2026-11-07):** Decoded playback observations maintain stable reporting occurrence across seamless stream switches, quality changes, and reconnect grace intervals.
- **Address forwarding:** Forwarding external viewer IP addresses directly to Plex was deferred to avoid triggering PMS remote stream limits; reporting routes through the server-authoritative `/api/watch/rooms/:id/observe` endpoint.

### M1-P1 / M1-P2 — Automatic delivery & local conversion
- **A/B (2026-11-06):** Extracted unified `DeliveryPlan` module for direct file, direct HLS, local conversion, and proxy recovery. In-flight quality switches on local conversion seamlessly transition without resetting viewer positions.
- **Outage continuity:** During a Plex Media Server outage, admitted viewers continue playing from cached buffers; new admissions fail closed without leaking credentials or crashing.
- **Open:** Real-time frame-accurate 4K local conversion acceptance on real Plex input.

### M1-P11 — Room connection protocol (typed, pushed on change)
- **B (2026-11-12, on 74fa521 plus this change):** The room connection speaks typed messages ([protocol](wire-protocol.md), version 2) and pushes room, viewer and lobby state only when it changed. `npm run check` exit 0: **509 passed, 0 failed, 0 skipped**. All 15 room scenario traces replay unchanged through the replaced harness adapter, which now asks for an explicit resync after each scenario second. `tests/watch-socket.test.js` holds ten tabs in a playing room for three seconds and receives no room, viewer or lobby message, then one room message per tab for a pause and none on a connection outside the room; it also covers the version handshake refusal (close 4010) and the resync retry. `node scripts/room-ui-smoke.js --browsers=chrome,firefox` passed in both browsers.
- **Limits:** Fixture server and demo video on one machine. `scripts/playback-recovery.js` was adapted to the pushed state but not run. The native client (`plezy-uburoom`) was updated and its Dart tests pass; it was not run against this server.
- **Open:** Owner watch night on the deployed server; native client against a live server; behaviour past the default 256 connections is unmeasured.

### Browser client structure (ES modules, component stylesheets, one time base)

- **B (2026-11-13, on 7e0ec61 plus the client restructure commits):** the watch page is one ES module graph with mounted modules, a store and one scheduler tick; styles are per-component stylesheets in cascade layers; the browser reads time from one object and holds without a usable room clock. `npm run check` exit 0 (510 tests; a later full run had one unidentified failure, the next 510/510). Screenshots of all 156 captured surfaces (`npm run ui:capture` / `ui:compare`, tolerance 8) match the pre-restructure revision in Chrome and Firefox; one Chrome run differed in three images only by the timeline's buffered range, and the rerun matched. A computed-style model of every rule against the elements it matches in all 78 Chrome states found no changed winning declaration; two lobby-only differences remain in which hidden scroll areas OverlayScrollbars has attached before a room opens. All 15 room scenario traces replay unchanged apart from the `plexSessions` section added to the harness in 372bfd2 without re-recording (so `record-room-traces.js --check` already reported every scenario on 7e0ec61). `node scripts/room-ui-smoke.js --browsers=chrome,firefox` passed in both. `npm run sync:bench`: the noise case through the modelled presentation path settles under 20 ms in 7.5 s (7.5 ms residual); no existing row changed. **Not run:** the playback, sync and recovery browser runners in `scripts/` (their page bindings are kept as accessors but were not exercised), real two-browser playback, Discord Activity. Fixtures only.

### M1-P5 / M1-P6 — Synchronization core & presentation pacing
- **A/B (2026-10-30):** Extracted reusable synchronization core into `shared/sync/` (free of Plex, Discord, FFmpeg, TLS, YAML, and SQLite dependencies).
- **Stage 2 Hybrid EMA Pacing (2026-10-29):** Proportional rate correction (0.95x–1.05x) settles clock drift within ±50ms under synthetic latency without audible pitch warping or visual stepping.
- **Open:** Physical/WAN multi-viewer measurement (±50ms p95 / ±100ms p99).
- **Simulation bench (`scripts/lib/sync-bench.mjs`, `npm run sync:bench`):** runs the real `shared/sync/timing.mjs` clock filter and rate controller against seeded, deterministic network profiles (wired, Wi-Fi, mobile, bad) and a simple player model (rate-change lag, seek cost, start delay, frame quantisation, measurement noise). It records the owner-agreed targets as named constants (150 ms to under 20 ms within 15 s; two-viewer p95 spread under 50 ms; clock usable at least 99% on Wi-Fi and mobile; under 2% of steady-state time at a non-normal speed). `tests/sync-bench.test.js` asserts determinism, fails if any metric regresses past the recorded baseline in `scripts/lib/sync-bench-baseline.mjs`, and records unmet targets as data (`met: false`) until the controller and clock changes land. Since the converge-then-rest controller (2026-11-11), 150 ms settles under 20 ms in 11 s on the wired profile and every profile spends about 1% of steady-state time at a non-normal speed. Since clock validity follows estimated uncertainty (2026-11-12), the clock is usable 99.8% of the time on Wi-Fi and mobile (was 90.7% / 81.3%; longest gap 1.5 s / 1 s, the startup acquisition, was 9 s / 22 s) with no increase in actual clock error, and the uncertainty bound held on every simulated read; the mobile+bad spread (50.2 ms p95) and the compensated start spread for Wi-Fi+mobile (48.2 ms) and mobile+bad (71.7 ms) remain unmet. **Limits:** simulation only. It says nothing about real browsers, audio output delay or real networks; the player obeys rate changes after a fixed lag, the presentation-timing path (per-frame samples, smoothing, `controlSignal`) is modelled only in the `-presentation` noise row, and the server timeline is not modelled. Class B evidence at most; it does not replace two-browser confirmation.

### M1-P3 / M1-P9 — Format, language & subtitles
- **A/B (2026-10-29 / 2026-11-06):** Bounded PGS extraction prevents runaway memory allocations during high-bitrate bitmap subtitles; seek recovery cancels obsolete window extraction jobs. DOM text subtitle layer operates on a dedicated stage overlay.
- **Open:** Authored font review, Activity mobile subtitles, and corresponding-source licensing review.

### M2-P3 / M2-P9 — Invites & Discord scheduled events
- **A/B (2026-11-08):** Room invites with guest limits and trusted server tier verified in isolated tests. Discord scheduled events lifecycle verified: start/end scheduling, room rename synchronization, cancellation with share removal, and conflict resolution without room revision locking.
- **A/B (2026-11-08, 09befae):** Watch nights are now uburoom events (schema 11) with optional Discord posting. Isolated tests cover lobby visibility following room privacy, the `events.schedulers` tier, new-room scheduling leaving no room behind on a rejected form, room retention while an event is upcoming, Discord edits and interested count read back, persistence across restart and removal at the end time. Full suite 443 passed, 0 failed, 0 skipped. The private v10→v11 transfer was run on a synthetic copy, including a repeat run. Deployed to Vigrid after the v10→v11 transfer; the Vigrid suite passed. No lobby or scheduler UI yet.
- **B (2026-11-09, main after 09befae):** Watch-night UI checked in a local preview with the Discord test fixture: scheduler from Share, the lobby and the room header; error, loading and success popovers; edit; scheduling into a new room with and without Discord; Upcoming list with More, Cancel confirmation and Open room; lobby buttons above the lists at 1024px and 375px; a second demo account waiting on a closed room and joining once the host opened it. Copy invite was only checked as far as its error popover, because the hidden preview pane blocks the clipboard.
- **Open:** Live Discord guild acceptance and human usability review.

---

## Known failures and active limitations

| Issue | Disposition |
| --- | --- |
| Room smoke | B (2026-11-12, `program/v4-layout`): updated to the V4 Room panel (no quick permissions; a host's management permissions checked on the server and no permission controls in the panel; Schedule disabled with its reason for a viewer) and the list-only queue; full flow passed in Chrome and Firefox. The first run failed in Chrome at "Settings save completes": the 2.5-second Saved status had cleared while the runner waited on the viewer, so the runner now reads it first. `scripts/queue-controls-smoke.js` was updated for the removed queue view selector and the switch pills but still fails at its first step, before any changed assertion: its `/watch?demo=host` navigation times out, and with `/?demo=host` its OverlayScrollbars count assertion fails. Not repaired here. Earlier: B (2026-11-10, `program/v0-rendered-checks` at 7bf0fc4): navigation repaired, on-screen assertions; full flow including Bulk excludes Specials passed in Chrome and Firefox (Firefox alone 5/5, combined 3/3). Before 7bf0fc4 Firefox failed 4/5 at Auto-play: the runner pressed during the queue's smooth-scroll tail, whose scroll events close the confirmation popover. Same-commit `ui:capture` pairs compare identical at tolerance 8 (2 px of wordmark anti-aliasing in Chrome light phone at tolerance 0). Fixtures only; screenshots are not visual acceptance |
| AV1 ending | Prior live ~42ms final-buffer gap; 2026-10-23 C/D Discord AV1/QSV near-end replay finished cleanly and encoder child exited; broader media/multi-viewer/endurance coverage remains open |
| Real soak | First run unloaded/recovered; repeat run clean. Original trigger unproven (suspected transient internet dropout, not a confirmed current playback defect) |
| Resource/timing fixtures | A locked-disk timer assertion failed under extreme contention then passed alone/full rerun; no assertion weakened |
| Browser limits | Firefox Escape exits fullscreen, narrow drawer resize timeout, sparse high-rate frame callbacks; emulated touch is not real-device evidence |

Detailed historical failure analyses and retired runner logs are preserved in the [historical digest through 2026-10-22](archive/testing-2026-10-22.md) and [historical digest 2026-10-23 to 2026-11-08](archive/testing-2026-11-08.md).

---

## Maintenance

Update the affected result or gate only. Keep commands in `development.md`, requirements in owning plans, and detailed sanitized traces in `artifacts/` or archive digests. Maintain single-entry high-water marks for each active phase rather than appending daily commit diaries. Do not append UI specifications, repeat suite histories, restore retired runners, or convert old results into current green status.
