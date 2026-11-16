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

Automated rehearsal via Docker Compose (`desktop-linux`, container Node v22.23.4 / Debian 12, host Node v22.22.2 / Windows): clean installation, diagnosis, matched snapshot backup, destructive mutation rollback and credential key protection, without touching any production installation or data. `scripts/doctor.js --json` passed 14 checks against isolated `fake-plex`. Probe 7A: a missing `credentials.key` fails doctor without generating a replacement. Probe 7B: a mismatched key is rejected without overwriting credentials. Probe 7C: restoring the original key bytes passes every check and `/health` returns 200. Sanitized trace: `rehearsal/results/rehearsal-evidence.json` in the evidence folder.

## 2026-11-08 — M2-P3 / M2-P9 invites and Discord events (A/B)

Room invites with guest limits and the trusted server tier verified in isolated tests. Discord scheduled event lifecycle: start/end scheduling, room rename sync, cancellation with share removal, conflict resolution without room revision locking.

At 09befae watch nights became uburoom events (schema 11) with optional Discord posting. Isolated tests cover lobby visibility following room privacy, the `events.schedulers` tier, new-room scheduling leaving no room behind on a rejected form, room retention while an event is upcoming, Discord edits and interested count, persistence across restart and removal at the end time. Full suite 443 passed, 0 failed, 0 skipped. The v10→v11 transfer was run on a synthetic copy, including a repeat run, then on a live installation; the suite passed.

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

## 2026-11-13 — A6 direct SQLite storage (A/B, 25859ef)

Replaced the in-memory database mirror, changeset recorder/shipping, storage worker, statement proxies and HTTP response fence with one direct SQLite connection (WAL, synchronous=NORMAL, foreign keys enabled, bounded lock wait). Account, room, queue and history repositories own runtime SQL and reuse prepared statements; queue transitions, login saves and room/live-state/queue checkpoints commit as short transactions before acknowledgement. Failed login transactions leave their encoded cache retryable. Baseline/user_version remains 11; the numbered forward-migration list is empty. Graceful close checkpoints TRUNCATE. No permanent history-sized mirror remains; request projections still retain bounded temporary rows.

Playback-history retention remains 90 days / 5,000 rows. Audit retention is fixed at 365 days / 20,000 rows, pruned at startup and at most hourly on audit writes. History reduction runs locally in yielding slices, retaining the 32 MiB record and 500,000-interval budgets and rejecting a ninth concurrent read with 503 "History is busy". Prepared dynamic history-query shapes are also bounded to eight.

Commands and outcomes:

- `npm run check`: final combined working-tree run passed format, ESLint, TypeScript and all 453 tests, zero failures/skips. The tree included the concurrent, uncommitted Plex split; that work is excluded from 25859ef and was independently committed as 9b89202 during this task. A detached checkout of 25859ef with fresh fixture TLS and no private configuration also passed `npm run check`: all 453 tests, zero failures/skips.
- `node scripts/record-room-traces.js --check`: all 15 recordings unchanged, two identical runs each. `tests/authorization.test.js` and `tests/fixtures/authorization.json` unchanged; authorization passes in the full check and `node --test tests/room-queue.test.js tests/authorization.test.js` (26/26).
- `node --test tests/database.test.js tests/room-store.test.js`: 23/23 at the first direct-storage increment. After extending retention/admission and final-checkpoint rollback coverage, `node --test tests/database.test.js` passed 10/10, and `node --test tests/room-store.test.js tests/room-queue-races.test.js` passed 22/22.
- The database suite's HTTPS fixture obtains eight successful account/login/room/queue responses, kills the child with SIGKILL without closing the database, reopens its remaining WAL, checks integrity and finds every acknowledged record. The 16-viewer / 320-observation isolated workload measured event-loop p95 16.70 ms, maximum 17.09 ms; this is a local synthetic workload, not a production latency guarantee.
- An external one-off fixture script used the schema initializer from 3ab2d1d to build a baseline-11 database, copied it and opened the copy through createApp. Canonical UUID, ciphertext bytes, sqlite_master schema and version remained unchanged; WAL/NORMAL/foreign-key settings were verified. `npm run doctor -- --config <isolated-fixture.yaml>` passed 18 checks, zero warnings/failures. The fixture key was synthetic; no owner state/key was opened or migrated. Doctor source review found no dependency on the old worker or journal mode, so its code is unchanged.

Failure history and deliberate test changes: the first focused account/queue/authorization run passed 33/47 while the concurrent Plex split temporarily omitted caches expected by plex-auth; the eventual full run passes. The first full check exposed four cancelled shutdown tests (unreferenced AbortSignal deadlines had depended on the removed worker keeping Node alive) and a restart-trace ECONNRESET. Cleanup now owns referenced, cleared real deadlines; all eight existing queue-race scenarios pass. Fixture demo-login requests use fresh TLS connections across restarts instead of reusing a closing idle connection. The next full check had only the known two-hour-MKV timing flake (NaN versus 0); `node --test --test-name-pattern="generated two-hour MKV windows" tests/subtitle-resources.test.js` passed 1/1, followed by the clean full check. No assertion was weakened to hide these failures.

Renamed storage-worker.test.js to database.test.js. Replaced its worker lock/event-loop test with direct locked-write rejection/rollback/retry, its changeset-conflict test with atomic login-failure/retry, and operation-fence tests with forced-process-kill recovery. Retained encrypted-login restart, unsupported-schema rejection, original-key offline restore, history overlap and local event-loop scenarios; extended history admission and retention coverage. In room-store.test.js, replaced locked-worker timing with rejected mutation/restart durability and removed mirror-conflict sealing, which no longer describes direct SQLite. In room-queue-races.test.js, replaced the mocked final flush failure with an actual SQLite trigger failure, proving the complete final room snapshot rolls back and provider/database cleanup still completes.

No Plex internals changed. No SQL statements remain inline in plex.js or plex-delivery.js in the reviewed tree. At the owner's explicit direction, operation.js retains a temporary no-op commitOperation export for the untouched plex-auth caller. Accounts.flush remains an async service settlement point for existing callers, with no queued storage or commit receipt behind it.

Normal update only: no schema/config migration or credential/key change is required. No push/deploy, production restart, live provider/device verification (C), human acceptance (D), sudden-power-loss test or operator restore was performed. WAL/NORMAL protects process-crash acknowledgements, not guaranteed power-loss durability. Online backups must use SQLite's backup mechanism or an atomic matched database/WAL snapshot; a graceful stopped backup is one file after checkpoint.

## 2026-11-13 — Queue controls smoke repair (B, on 38a4bdc)

Repaired `scripts/queue-controls-smoke.js` against the post-A5/A6/V3 codebase without modifying application code (`server/`, `web/`, `shared/`):

- Replaced `createApp` / `app.access` setup and `/watch?demo=host` navigation with `startFixtureServer()` and `openPage(browser, config.publicUrl + '/?demo=host')` from `scripts/lib/ui-fixture.js`, and closed the server via `app.close()`.
- Replaced removed `$` page-global calls with `document.getElementById(...)`, waited for `#room-dialog` and `#queue-auto-mode-group` visibility, and adapted the Auto-play pending-write probe to `WatchTransport.request(message, options)` (`message?.type === 'command' && message?.command?.action === 'media.autoplay.set'`).
- Updated the `OverlayScrollbars` check from exact `.os-scrollbar` count `2` (inner scroll areas now attach their own instances) to verifying `OverlayScrollbarsGlobal.OverlayScrollbars(document.body)` is active and not destroyed with at least two `.os-scrollbar` elements.
- Updated `#queue-auto-mode-group` assertions to match current shipped controls: `46px` outer segmented container height (`calc(var(--watch-control-height) + 6px)` with 3px padding, added in `5239525`) with `40px` `.group-button` height, and two `ArrowRight` presses (`off` → `continue` → `following`) before `Space` selection.

Checks:
- `npx prettier --check scripts`: passed.
- `npx eslint scripts`: passed.
- `node scripts/queue-controls-smoke.js` (two consecutive runs): both passed in Chrome and Firefox (`chrome: Queue controls and desktop/narrow captures passed`, `firefox: Queue controls and desktop/narrow captures passed`); screenshots written to the external evidence folder. Isolated fixture scope only; no real Plex, Discord, or production server touched.

## 2026-11-13 — V5 Stage 2 accessibility & visual verification (A/B, on main after `9a3e064`)

- Scope: completed Stage 2 accessibility fixes across `web/` and [accessibility-walkthrough.md](../accessibility-walkthrough.md) against [design-guide.md](../design-guide.md) (commit `9a3e064`), including `#tracks-dialog` fixed positioning and focus fallback (`web/styles/dialogs.css`, `web/watch-player-ui.js`), Forced Colours SVG `"room"` wordmark contrast (`web/assets/uburoom-wordmark-brand.svg`, `web/styles/exceptions.css`, `web/theme.js`), `--text` `3 px` focus rings with `3 px` offset, `>= 40 px` targets and documented `32 px` / `24 px` / queue-link compact exceptions, Forced Colours borders/`Highlight` selection states, keyboard containment and single-`Tab` sliding menu dismissal, CSS custom-property positioning, and removal of `#library-codec-test` / `#codec-test-dialog` from `web/`.
- Isolated browser accessibility walkthrough in Chrome (`Chrome/157.0.8103.51`) and Firefox (`160.0`) against `scripts/lib/ui-fixture.js`: `0` non-exempt `< 40 px` interactive controls across all tested surfaces (`0` skipped headings, `0` unlabelled navs, `overflowX: false` across `1280×900`, `640×450`, `320×500`, and `390×844`, Forced Colours verified dark/light with dark/light SVG `"room"` contrast, `#tracks-dialog` opening unclipped at `scrollTop: 0`, phone `#volume-panel` holding open `> 3.3 s` while focused, `#library-codec-test` / `#codec-test-dialog` absent); `80` PNGs + `walkthrough-data.json` written to `..\uburoom-evidence\artifacts\v5-accessibility\`. Open observation: Firefox `Enter` on `#skip-link` focuses `#stage`, while pre-pointer synthetic WebDriver BiDi `Tab` rendered `#skip-link` at `30×40 px` with `outlineStyle: "none"`; conditional `#entry-form`/`#guest-join`/`#invite-code-form`, `#handoff-dialog`, and `#server-settings-dialog` were not opened in default `?demo=host` fixture runs.
- `node scripts/room-ui-smoke.js --browsers=chrome,firefox`: passed in both Chrome and Firefox (`chrome: ... passed`, `firefox: ... passed`).
- `npm run ui:capture` and `npm run ui:compare`: captured `156` screenshots in Chrome and Firefox (`..\uburoom-evidence\artifacts\ui-capture\20261113-214739-9a3e064-dirty`); comparison against pre-Stage-2 baseline (`20261113-211248-a65b619`) reported `142 of 156 images differ` consistent with Stage 2 focus/spacing/target/codec-removal changes, with manual inspection confirming `#tracks-dialog`, Lobby Light, and Forced Colours alignment.
- `npm run check` first run hit one known concurrent-load timing flake in `tests/subtitle-resources.test.js:973` (`NaN !== 0`, already listed in [testing.md](../testing.md)); immediate re-run of `npm run check` passed cleanly.
- Final verification on the `web/` tree: `npm run format:check`, `npm run lint`, `npm run typecheck`, and `npm run test:full` (`node --test tests/*.test.js`: `453` tests, `453` passed, `0` failed, `0` skipped) all passed cleanly. Isolated fixture scope only; no real Plex, Discord, or production server touched. Physical assistive-technology/screen-reader traversal, real keyboard check on Firefox `#skip-link`, and owner acceptance remain open (`D`).

## 2026-11-13 — Codec tester server cleanup (A)

0888c60: the server no longer pre-renders the codec tester button that V5 removed from the client, so the library home it renders matches the client's. `tests/watch-page.test.js` passes.

## 2026-11-15 — M2-P4 media providers and local library (A/B, on main at `31cb808`)

- Scope: `f12ce32`..`31cb808`. Sidecar subtitle resources on track descriptors; the server id threaded through every provider lookup; pipeline-level release and qualities; the written provider contract (`server/media-provider.js`); per-provider queue availability and opaque track ids; the local folder provider (`server/local-provider.js`, `server/local/index.js`) with `local_media.libraries`, doctor checks and Libraries home cards.
- Isolated protocol run: a scratch server built from `createApp` with a fake Plex (two movies backed by the demo MP4), one local library (an H.264/AAC MP4 with a Windows-1252 `.en.srt` sidecar, and an HEVC/AC-3 Matroska file with an embedded SRT in a subfolder), a persistent database and real FFmpeg/FFprobe, driven over real HTTPS and `/watch-socket`. 30/30 checks: the library home lists both providers' libraries with their server ids; media ids are opaque tokens; a Plex item and both local files queue under their own server ids; the Plex item and the MP4 play as the original file with ranged and suffix-ranged bytes equal to the file on disk; the Matroska file converts locally to VP9 with WebM video and audio chunks; sidecar and embedded subtitles load; no path or provider resource appears in the viewer's state; traversal attempts through item and section ids are refused.
- Restart on the same database, 6/6 checks: the room stays saved, history keeps the Plex and local entries under their own servers, the room reopens with the local file restored, and its 14-second position is kept.
- Doctor against scratch configs: a readable library folder passes, a missing folder fails with remediation, and an invalid library id fails configuration validation.
- Rendered in headless Chrome (dark theme, 1400 px wide) against the same server: Libraries home shows the local library card after the Plex library with no Collections card; the local library lists both files, with filters and the auto-queue action hidden.
- `npm run test:full` (`478` tests, `478` passed, `0` failed, `0` skipped), `format:check`, `lint` and `typecheck` pass. The known concurrent-load flake in `tests/subtitle-resources.test.js` (`NaN !== 0`) appeared in some full runs and passed on re-run and alone.
- Not covered: a real Plex server or a real library, decoded picture and sound in a browser, a second viewer, guests, Firefox, light theme, phone width, 200% zoom, a local-only install without Plex, and owner acceptance. Nothing was deployed.

## 2026-11-16 — Media library UI, queue scroll button and MKV flake (A/B, on main after `e8e4a55`)

- Scope: `434d8d9`..`e8e4a55` plus this change. Queue card-layout leftovers removed, suggestions box, no empty hints; Media header on one row with a More menu, single-button fallback and "Find a library" filter past ten libraries; tool rows tuck while scrolling down; details pages with one action row, backdrops and title logos (preloaded on open and tile hover, shown without a fade once fetched); tile actions hidden on unavailable titles and the suggestion bulb as a pill; the "N queued" scroll button and its strip shown only while something is queued.
- `tests/plex-library.test.js` and `tests/jellyfin.test.js`: backdrop and logo artwork (allowed paths, sizes, PNG logos, episodes without logos, invalid kinds refused before any provider request).
- `tests/subtitle-resources.test.js` "generated two-hour MKV windows": the `NaN !== 0` flake reproduced in 4 of 14 concurrent runs. FFprobe reported no container `start_time` for some generated files (`format: {}`), which the reference check required; the app's own probe already falls back to the first packet time. The reference now uses the offset the file was written with: 14/14 concurrent runs pass.
- `node --test tests/*.test.js`: `483` tests, `483` passed, `0` failed, `0` skipped.
- `node scripts/room-ui-smoke.js --browsers=chrome,firefox`, `node scripts/media-controls-smoke.js` (Chrome, Firefox) and `node scripts/plex-library-smoke.js` (Firefox): passed. The two Media runners were repaired for the current client in `14bb5e1`.
- Owner check on Vigrid (D, partial): title logos load ahead on hover-then-open against the real Plex. Not covered: Jellyfin artwork against a real server, and a hidden "N queued" button with nothing queued was not separately rendered.

## 2026-11-16 — One smoke command (B, on main after `ca08105`)

- `npm run smoke` (`scripts/smoke.js`) runs `room-ui-smoke.js`, `queue-controls-smoke.js`, `media-controls-smoke.js` and `plex-library-smoke.js` one after another and prints a pass/fail summary; `--browsers=` passes through to each (media-controls gained the option).
- `plex-library-smoke.js` moved from its own Firefox WebDriver BiDi client to the shared `scripts/lib/playback-browser.js`, so it now runs in Chrome and Firefox; evidence files are prefixed with the browser. The port exposed a race the old timing hid: the runner clicked Create and the chooser's Create together, before the chooser had loaded rooms; it now waits for the chooser.
- `npm run smoke`: all four pass in Chrome and Firefox (room UI 120 s, queue controls 23 s, Media controls 17 s, Plex library 71 s).
- Unit overlap review: no unit test duplicates what the smokes check. The unit suite covers server state, permissions, protocol and playback policy, which the fixture-driven smokes never reach. `node --test tests/*.test.js` takes about 32 s; its slowest tests wait real time (WebSocket pong presence 12 s, two conversion-capacity tests 8 s each).

## 2026-11-16 — Faster unit suite (A/B, on main after `573e673`)

- The WebSocket pong presence test waited 11.5 s past the production idle deadline. `watchSockets` now takes `idleMs`/`livenessMs` (production defaults 10000/1000, set through `createApp` `socketTiming`); the test uses 1000/100 and waits 2.5 s. It still fails when pongs stop refreshing the connection (checked by disabling that line). 12 s to about 3.5 s.
- The two conversion-capacity tests each waited the 8 s a viewer waits for a free conversion job. `ConversionPolicy.waitMs` (default 8000) is now a property; the tests set 100 ms. 8 s each to about 0.15 s.
- `accounts.test.js` (26 s alone) and `config.test.js` (22 s alone) were mostly Windows permission steps run through PowerShell (about 0.3 s per launch: four per config save, one per credential key at app start). That security code is unchanged; the files are split so their halves run in parallel: saved operator settings moved to `saved-settings.test.js` with the shared app fixture in `tests/helpers/account-app.js`, and the YAML editor tests moved to `config-editor.test.js`. Test count unchanged.
- `node --test tests/*.test.js`: `483` passed, `0` failed, `0` skipped, about 24-25 s (was about 32 s). `lint`, `format:check`, `typecheck` pass.

## 2026-11-16 — Vigrid deploy stopped by entry point test limits (C deploy, `db75a0e` then `cec36f8`)

- Deploying `db75a0e` (episode steps) failed twice on Vigrid's own `npm test`: only "real entry point serves health from external YAML" (12.5 s) and "real entry point cleans up ... on listen failure" (8.2 s) timed out, and the updater kept uburoom stopped as designed. Run alone on Vigrid both passed, each needing about 6 s to start a server; beside the full suite they passed their 12 s and 8 s limits.
- `cec36f8` gives both tests 45 s to start (60 s per test): they check that the real entry point starts and cleans up, not its speed. The next deploy passed Vigrid's full suite and restarted with `/health` OK. uburoom was down on Vigrid from the first failed run until that restart.

## 2026-11-16 — Smoke runners side by side (B, on main after `9f3a7f1`)

- Running the four runners at once failed 3 of 4 runs and two lanes 1 of 4, each in a different step that acted on a page still settling: Libraries home cards pressed while a room selection reset Media (media-controls, plex-library Activity, the new cross-provider check), a settings dismiss lost while the page resized (room UI "Settings closed"), Back to top read before the scroll handler's frame, and a room reopening that took longer than a page step under load.
- Fixes: `act.pressUntil(selector, done)` in `scripts/lib/ui-fixture.js` for presses safe to repeat; waits for the created room's title before browsing; Back to top waited for instead of read once; 45 s for the reopened room to reach 0:17.
- `node scripts/smoke.js --lanes`, ten consecutive runs: 10 of 10 passed in Chrome and Firefox, 150-171 s each (sequential about 290 s). Two lanes are now the default; `--sequential` remains.

## 2026-11-16 — Jellyfin provider against a real Jellyfin (C, isolated, at `fe3fc01`)

- `C:\dev\uburoom-demo` profile `jellyfin`: `jellyfin/jellyfin:12.4` (digest `sha256:fea863d0…`) on the internal `jellyfin-only` network (checked: no DNS, no route out), with a generated library (`jellyfin/make-media.js`: one movie; a show with Season 1, Season 2 and a Special; local poster, backdrop and logo). `jellyfin/check.js` completes the setup wizard, creates an API key and Films/Shows libraries with internet metadata and image fetchers off, then drives `server/jellyfin-provider.js` from the live checkout.
- 8/8: libraries through the provider's authorization header; browsing; details naming their library via `Items/{id}/Ancestors`; poster, backdrop and logo images; seasons and episodes; episode steps (S01E02: previous S01E01, next S02E01, nothing before S01E01 because the Special is left out); `source()` (30.0 s, h264/aac, next episode known); a ranged read of the stream (HTTP 206) equal to bytes 1000-5999 of the file on disk.
- Without internet metadata Jellyfin names items from folders and files ("Rehearsal Show - S01E02 - Second"), which the check matches.
- Not covered: servers before 10.9, subtitles, conversion, room-level play through a Jellyfin item, a browser, owner acceptance.

## 2026-11-16 — Media Home rows (A/B; Jellyfin part C, isolated)

- `library.shelves`: Continue watching only through a viewer's own verified Plex sign-in (`plexProvider.continueWatching`), never the shared fallback or a single configured token; Recently added from every provider with `recentlyAdded()` (Plex `/library/recentlyAdded`, Jellyfin `Items/Latest`), merged newest first, each item stamped with its server. `tests/media-home.test.js` covers the own-progress rule, the merge and the Plex endpoints.
- Fixture preview in Chrome and Firefox (desktop and phone): both rows render above the library cards and scroll sideways; a Continue watching tile reads "Queue fixture show · S1 · E1"; a tile opens from its own server with its library current; Back returns to Home with both rows. Continue watching was previewed by answering it as a signed-in viewer would (scratch only); the demo host has no Plex sign-in of their own, so the real fixture shows no Continue watching, as intended.
- Found while running the smoke set: hidden Home tiles lingered behind the page being browsed; Home's content is now emptied when it is left and rebuilt on return.
- Real Jellyfin 12.4 (uburoom-demo): Recently added lists the movie and the show (a new episode shows as its show), 9/9 checks.
- `node --test` 489/489, lint, typecheck, format; `npm run smoke` 4/4.

