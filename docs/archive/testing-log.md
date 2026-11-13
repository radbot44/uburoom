# Verification log

Dated run-by-run evidence, oldest first. **Append new entries at the end; do not edit earlier ones.** Each entry applies only to its recorded revision and environment. Current gates and their state live in [testing](../testing.md); earlier digests are [through 2026-10-22](testing-2026-10-22.md) and [2026-10-23 to 2026-11-08](testing-2026-11-08.md). Fixtures are B evidence, real providers and devices C, human observations D.

Entries up to 2026-11-13 were moved here unchanged in substance from the "Material verification status" and "Known failures" sections of `docs/testing.md` when it became a gate register.

---

## 2026-10-29 / 2026-11-06 — M1-P3 / M1-P9 format, language and subtitles (A/B)

Bounded PGS extraction prevents runaway memory during high-bitrate bitmap subtitles; seek recovery cancels obsolete window extraction jobs. The DOM text subtitle layer runs on a dedicated stage overlay.

## 2026-10-29 / 2026-10-30 — M1-P5 / M1-P6 synchronization core and pacing (A/B)

The reusable synchronization core was extracted into `shared/sync/` (free of Plex, Discord, FFmpeg, TLS, YAML and SQLite). Stage 2 hybrid EMA pacing: proportional rate correction (0.95x–1.05x) settles clock drift within ±50 ms under synthetic latency without audible pitch warping or visual stepping.

## 2026-11-06 — M1-P4 Plex timeline reporting (C/D)

Verified on a live watch party, with owner acceptance recorded in Tautulli history: correct activity-only attribution and rejection of ambiguous key-only identities. Forwarding external viewer IP addresses to Plex was deferred to avoid PMS remote stream limits; reporting goes through the server-authoritative `/api/watch/rooms/:id/observe`.

## 2026-11-06 — M1-P1 / M1-P2 automatic delivery and local conversion (A/B)

A unified `DeliveryPlan` covers direct file, direct HLS, local conversion and proxy recovery. In-flight quality switches on local conversion move without resetting viewer positions. During a Plex outage admitted viewers keep playing from buffers; new admissions fail closed without leaking credentials or crashing.

## 2026-11-07 — M1-P4 stream transitions (A/B)

Decoded playback observations keep a stable reporting occurrence across stream switches, quality changes and reconnect grace.

## 2026-11-07 — M1-P13 room recovery, autoplay and queues (A/B)

Room teardown and writer contention: final snapshots preserve room intent before teardown; stale countdown timers keep cleanup ownership; bounded preparation cleanup drains independently of commit receipts. Auto-queue: single persisted tail preview (`autoQueue.next`), `continue` alongside `following` and `random`, `pin`/`skip`/`playNow`, and full-stage ending interstitials without per-item file-check waterfalls.

## 2026-11-08 — M1-P11 / M1-P14 container rehearsal and key resilience (B)

Automated rehearsal via Docker Compose (`desktop-linux`, container Node v22.23.4 / Debian 12, host Node v22.22.2 / Windows): clean installation, diagnosis, matched snapshot backup, destructive mutation rollback and credential key protection, without touching Vigrid or production data. `scripts/doctor.js --json` passed 14 checks against isolated `fake-plex`. Probe 7A: a missing `credentials.key` fails doctor without generating a replacement. Probe 7B: a mismatched key is rejected without overwriting credentials. Probe 7C: restoring the original key bytes passes every check and `/health` returns 200. Sanitized trace: `rehearsal/results/rehearsal-evidence.json` in the evidence folder.

## 2026-11-08 — M2-P3 / M2-P9 invites and Discord events (A/B)

Room invites with guest limits and the trusted server tier verified in isolated tests. Discord scheduled event lifecycle: start/end scheduling, room rename sync, cancellation with share removal, conflict resolution without room revision locking.

At 09befae watch nights became uburoom events (schema 11) with optional Discord posting. Isolated tests cover lobby visibility following room privacy, the `events.schedulers` tier, new-room scheduling leaving no room behind on a rejected form, room retention while an event is upcoming, Discord edits and interested count, persistence across restart and removal at the end time. Full suite 443 passed, 0 failed, 0 skipped. The private v10→v11 transfer was run on a synthetic copy, including a repeat run, then on Vigrid; the Vigrid suite passed.

## 2026-11-09 — M2-P9 watch-night UI (B, main after 09befae)

Checked in a local preview with the Discord test fixture: scheduler from Share, the lobby and the room header; error, loading and success popovers; edit; scheduling into a new room with and without Discord; Upcoming with More, Cancel confirmation and Open room; lobby buttons above the lists at 1024 px and 375 px; a second demo account waiting on a closed room and joining once the host opened it. Copy invite only as far as its error popover (the hidden preview pane blocks the clipboard).

## 2026-11-10 / 2026-11-12 — Room UI smoke (B)

2026-11-10, `program/v0-rendered-checks` at 7bf0fc4: navigation repaired, on-screen assertions; the full flow including Bulk excludes Specials passed in Chrome and Firefox (Firefox alone 5/5, combined 3/3). Before 7bf0fc4 Firefox failed 4/5 at Auto-play: the runner pressed during the queue's smooth-scroll tail, whose scroll events close the confirmation popover. Same-commit `ui:capture` pairs compare identical at tolerance 8 (2 px of wordmark anti-aliasing in Chrome light phone at tolerance 0).

2026-11-12, `program/v4-layout`: updated to the V4 Room panel (no quick permissions; management permissions checked on the server; Schedule disabled with its reason for a viewer) and the list-only queue; full flow passed in Chrome and Firefox. The first Chrome run failed at "Settings save completes" because the 2.5-second Saved status had cleared while the runner waited on the viewer; the runner now reads it first. `scripts/queue-controls-smoke.js` was updated for the removed view selector and the switch pills but still fails at its first step: its `/watch?demo=host` navigation times out, and with `/?demo=host` its OverlayScrollbars count assertion fails. Not repaired.

## 2026-11-11 / 2026-11-12 — Sync simulation bench (B)

`scripts/lib/sync-bench.mjs` (`npm run sync:bench`) runs the real `shared/sync/timing.mjs` clock filter and rate controller against seeded network profiles (wired, Wi-Fi, mobile, bad) and a simple player model. It records the owner-agreed targets as constants (150 ms to under 20 ms within 15 s; two-viewer p95 spread under 50 ms; clock usable at least 99% on Wi-Fi and mobile; under 2% of steady-state time at a non-normal speed); `tests/sync-bench.test.js` fails on regression past `scripts/lib/sync-bench-baseline.mjs` and records unmet targets as data.

Since the converge-then-rest controller (2026-11-11), 150 ms settles under 20 ms in 11 s on wired and every profile spends about 1% of steady-state time at a non-normal speed. Since clock validity follows estimated uncertainty (2026-11-12), the clock is usable 99.8% of the time on Wi-Fi and mobile (was 90.7% / 81.3%; longest gap 1.5 s / 1 s, was 9 s / 22 s) with no increase in clock error. Unmet: mobile+bad spread (50.2 ms p95) and compensated start spread for Wi-Fi+mobile (48.2 ms) and mobile+bad (71.7 ms). Simulation only: no real browsers, audio output delay or networks.

## 2026-11-12 — M1-P11 room connection protocol (B, on 74fa521 plus c158444)

Typed messages ([protocol](../wire-protocol.md), version 2), pushing room, viewer and lobby state only on change. `npm run check` exit 0: 509 passed, 0 failed, 0 skipped. All 15 room traces replay unchanged through the replaced harness adapter, which asks for an explicit resync after each scenario second. `tests/watch-socket.test.js` holds ten tabs in a playing room for three seconds with no room, viewer or lobby message, then one room message per tab for a pause and none outside the room; it covers the version refusal (close 4010) and resync retry. Room UI smoke passed in Chrome and Firefox. `scripts/playback-recovery.js` was adapted but not run. `plezy-uburoom` was updated and its Dart tests pass; not run against a server. Past 256 connections unmeasured.

## 2026-11-13 — Browser client structure (B, on 7e0ec61 plus the restructure commits)

One ES module graph with mounted modules, a store and one scheduler tick; per-component stylesheets in cascade layers; one browser time object that holds without a usable room clock. `npm run check` exit 0 (510 tests; a later full run had one unidentified failure, the next 510/510). All 156 captured surfaces (`ui:capture` / `ui:compare`, tolerance 8) match the pre-restructure revision in Chrome and Firefox; one Chrome run differed in three images only by the timeline's buffered range, and the rerun matched. A computed-style model of every rule against its matched elements in all 78 Chrome states found no changed winning declaration; two lobby-only differences remain in which hidden scroll areas OverlayScrollbars has attached before a room opens. Room traces unchanged apart from the `plexSessions` section (re-recorded in 8608ef2). Room UI smoke passed in both browsers. `sync:bench`: the noise case through the modelled presentation path settles under 20 ms in 7.5 s (7.5 ms residual). Not run: the playback, sync and recovery runners in `scripts/`, real two-browser playback, Discord Activity.
