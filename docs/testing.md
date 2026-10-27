# Verification dashboard — M1

**Release status: open.** Results below belong to their recorded revisions/scenarios; they do not combine into a current-HEAD pass. [Release gates](../ROADMAP.md#m1--verified-self-hosted-release) · [Historical evidence digest](archive/testing-2026-10-22.md) · [Commands](development.md#tests).

## Verification standard for new work

| Method | Evidence | Limit |
| --- | --- | --- |
| A — Review | Source/contracts/rendered inspection | Not execution |
| B — Automated | Isolated fixtures, browser pixels/PCM, fault tests | Not real provider/device acceptance |
| C — Integration | Actual named provider/device/network/hardware | Only the measured configuration |
| D — Human | Recorded perceptual/usability acceptance | Not numerical/security proof |

Record date/revision, scope/environment, command/procedure, actual outcome and failures/skips, remaining methods and sanitized evidence. Label each required method pass/fail/blocked/not run. API success, capability hints and advancing clocks are not decoded playback, persisted history or physical synchronization. Unexpected skips invalidate a full-suite pass. C and production/history changes require explicit authorization.

## Latest scoped evidence

### M1-P14 — Configuration, administration and account authorization — 2026-10-27

A/B on local changes based on `7a55f1da6d9157572ddabea3f160898ced782603`, Node v22.22.2 on Windows. P14 closes with three outcomes; the existing architecture and UI surfaces are retained.

| Outcome | A — source review | B — isolated execution |
| --- | --- | --- |
| Authorization boundaries | Operator policy and both settings routes require a current session and verified configured subject; room roles do not enter Plex entitlement checks. Media/caption grants recheck identity, room and personal item scope. | Ordinary viewers, creators/hosts, room Admin mode, Discord owner and token ownership confer no implicit operator authority. Restricted items remain denied for All hosts, assigned hosts and Admin mode. Revoked access rejects media, captions and subtitle windows; an open proxy response aborts after detection. Direct delivery fixtures preserve personal delegation and reject owner fallback delegation. |
| Account safety | Provider removal requires another enabled, verified, usable login. Operator IDs do not enable disabled providers; the Discord owner's existing reserved sign-in remains available. Callback/merge/assignment proofs bind browser, expiry, revision and authority. | Existing scenarios cover disabled/missing/revoked remaining credentials, membership loss, conflicting identities, browser mismatch, stale previews and body/provider races. Linking now advances revision, rotates the initiating browser login, rejects old browser/Activity tokens and grants, evicts viewers and closes their sockets. Merge/assignment repeat revision/participation checks after awaited authentication; logout preserves independently authenticated sessions and provider links. |
| Configuration and recovery | The browser and editor share the 19-key Rooms/Directory/Transcoding scope; doctor uses the same parser/normalizer as startup. SQLite worker acknowledgements and original-key decryption preserve the storage contract. | All editable keys traverse the settings save API. Invalid/forbidden keys, stale revisions, authority loss, write failures and audit-after-save failures retain their existing protections. An online SQLite `VACUUM INTO` snapshot with stable fixture YAML and original key restores UUIDs, verified links, encrypted Plex/Discord credentials, durable room/queue records and saved settings into a clean directory. Later source changes do not alter the restored snapshot. Missing/mismatched keys fail closed without replacement; the original key restores access. |

- `node --test tests/accounts.test.js tests/config.test.js tests/installation-policy.test.js`: **59 passed, 0 failed/cancelled/skipped**.
- Broader focused regression including `tests/account-directory.test.js` and `tests/plex-library.test.js`: **80 passed, 0 failed/cancelled/skipped**.
- `npm test`: **450 passed, 0 failed/cancelled/skipped**, including the existing storage-worker persistence/backup scenarios.
- `npm run doctor -- --config config.example.yaml --json`: **12 passed, 0 failures, 1 warning** for unreachable example Plex at loopback; no provider credentials were supplied. Config fixtures also exercise healthy and missing-file diagnostics. `git diff --check` passed.
- Intermediate failures: the initial focused run was **58 passed / 1 failed**, exposing the old expectation that Activity authentication survives linking. The first full run also exposed an obsolete link-revision expectation and object-reference assumptions in the new post-await login check, with dependent library cases cancelled. The Activity/name scenarios now assert mutation revocation; post-await checks compare canonical account ID and revision. Final results above supersede those runs.
- Limits: provider access caches last up to 30 seconds, item checks 3 seconds, proxy stream checks 2 seconds and subtitle-resource checks 1 second. Revocation fixtures clear the provider cache to exercise detected denial; they do not establish instant upstream detection. Already-issued direct Plex URLs rely on PMS enforcement. Snapshot YAML/key files are held stable; this is not an atomic backup across independent external writers. Real provider/device integration, independent installation recovery and human acceptance (C/D) were not run and remain release gates.

### Auto-queue tail preview and Continue mode — 2026-10-26

A/B on local changes based on `853fe8e`; isolated SQLite/Plex fixtures only, not deployed. Replaces `pending` row insertion during auto-queue generation with a single persisted tail preview (`autoQueue.next` in `watch_rooms.autoQueue`), adds dynamic `continue` mode alongside `following` (In order) and `random` (Shuffle), materializes `autoQueue.next` into `current` only when `pending` is empty (or via explicit `queue.auto.playNow` / idle `queue.auto` with Auto-play enabled), adds `queue.auto.pin` / `queue.auto.skip` / `queue.auto.playNow` commands and tail card UI, and removes synchronous per-item `?checkFiles=1` expansion in `Plex.prototype.queueItems` in favor of cached catalog expansion and `cachedAvailability`.

- `node --test tests/plex-library.test.js tests/room-store.test.js tests/room-queue.test.js tests/room-queue-races.test.js tests/room-autoplay.test.js tests/durable-rooms.test.js`: **119 passed, 0 failed, 0 skipped**. Covers `autoQueue.next` preview persistence without `pending` rows, atomic materialization on advance, `continue` mode across shows/movies/series finales, `random` pool stability and exhaustion cycling, `skipAuto` / `pinAuto` / `playAutoNow`, next-episode interstitial `queue.offer.start` activating `continue` mode, immediate playback start when enabling auto-queue in an idle room with Auto-play enabled, and bounded Plex queue expansion without per-item file-check waterfalls. `git diff --check` and `node --check` passed.
- Limits: Isolated fixture execution and source review only; full suite, dual-browser rendered UI checks, live Plex provider integration (C) and owner acceptance (D) not run.

### Browser operator settings dialog — 2026-10-25

A/B on local changes based on `88357cb`; temporary Windows/NTFS configurations, isolated fixture accounts and disposable browser profiles only, not deployed. Reuses the shared dialog, tabs, control builders and session authentication without extra confirmation dialogs or restart controls.

- `node personal/operator-panel/verify.cjs`: **Chrome 155.0.8059.84 and Firefox 158.0.1 PASSED**. Covers Account dialog "Server settings" entry visibility for verified operators, non-operator guest hiding, keyboard navigation (Tab/Arrow/Home/End), section switching (Rooms, Directory, Transcoding), dirty tracking and Escape/backdrop preservation vs Cancel draft discard, diff-only POST payloads (`directory.expose_plex_members`), duplicate save suppression while saving, revision conflict review with live file modifications ("Use saved value" vs "Keep my change"), honest reporting for post-save audit failures without claiming save failure, stale reply suppression after close/reopen, and responsive layout across narrow viewports (390×844), zoomed viewports (450×400) and light theme without horizontal overflow. Visual captures recorded in `personal/operator-panel/`.
- `npm test`: **42 suites, 215 tests passed, 0 failed, 0 skipped**.
- Limits: Isolated browser and fixture execution only; does not restart uburoom or reload running configuration into active memory. C/D real-environment acceptance not performed.

### Saved operator settings API — 2026-10-24

A/B on local changes based on `d4c3f0f`; temporary Windows/NTFS configurations and fixture accounts only, not deployed. The working tree was clean and the discarded fresh-authentication increment was absent; it remains absent. Saved settings use the current operator session, existing origin/CSRF protection and the editor's unchanged allowlist, with authorization checks after queueing and just before replacement.

- `node --test --test-reporter=tap tests/accounts.test.js tests/config.test.js tests/installation-policy.test.js`: **58 passed, 0 failed, 0 skipped**. Covers startup path pinning, editable-only/private-free responses, authorized saves, unauthorized/CSRF/origin rejection, stale revisions, forbidden/invalid edits, queued logout, authority loss during staging, sanitized write failures, actor/name-only audit events and honest post-save audit failure reporting. Existing running settings and watching/admission behavior passed. Initial targeted run: 2 passed / 1 failed because the new fixture tried enabling room Admin mode without satisfying its entry password; corrected fixture setup without changing admission. `git diff --check` and syntax checks passed.
- Limits: YAML replacement and SQLite audit storage are separate operations; audit durability failure can follow a committed file. No automatic restart, extra authentication flow or UI. Full suite and C/D not run; the editor's external-writer race and platform/durability limits remain.

### Internal YAML settings persistence — 2026-10-24

A/B on local changes based on `5074f86`; disposable Windows/NTFS fixtures only, not deployed. The internal editor validates complete YAML, preserves comments/private values, serializes revision-checked writes and retains protected backups before verified replacement. No write HTTP endpoint or running-configuration mutation.

- `node --test --test-reporter=tap tests/config.test.js`: **16 passed, 0 failed, 0 skipped**. Covers selected `--config` and relative paths, comments/secrets, real Windows DACL preservation/protected backup directories, forbidden/invalid edits, cross-instance stale writes, an external edit during staging, hard-link refusal, injected backup/partial-write/rename failures and queue recovery. `git diff --check` passed. Initial targeted runs: 4 failures from ACL copying marking audit permissions for update (fixed by selecting only owner/group/access sections); then 3 passes / 1 failure from a test expecting rejection of a viewer permission the existing validator deliberately removes (corrected to an unsupported permission).
- Limits: Unix ownership/mode handling reviewed but not executed here; full suite, network filesystems, power-loss durability and C/D not run. External writers can race the final check/rename; there is no cross-process lock. YAML restoration does not restore deleted application data. Remote writes still require a future fresh-operator-authentication increment.

### Operator-only running settings API — 2026-10-24

A/B on local changes based on `36d33a1`, including the preceding operator-identity increment; not deployed. `GET /api/operator/settings` uses browser-session identity and an explicit nonprivate running-settings allowlist, with no-store responses and final session/operator checks after persistence waits.

- `node --test --test-reporter=tap tests/accounts.test.js tests/config.test.js tests/installation-policy.test.js`: **51 passed, 0 failed, 0 skipped**. HTTP cases cover verified Plex/Discord operators, unauthenticated/anonymous/ordinary/Admin/pending-assignment denial, invalidated sessions, logout/unverification/unlink during a held persistence wait, private-value exclusion and independent playback admission/media entitlement. An intermediate targeted run had 1 pass / 1 failure because the new revoked-media assertion expected 403; the existing library endpoint returns 400 with an error. Corrected that assertion without changing media behavior. `git diff --check` passed.
- Limits: running configuration only, not pending file edits; no settings writes, UI, restart controls or recovery flow. Full suite, real provider integration (C) and human acceptance (D) not run.

### Explicit server-operator authorization — 2026-10-24

A/B on local changes based on `36d33a1`; not deployed. YAML `operator.discord_id` / `operator.plex_id` select verified provider identities for the reusable `isServerOperator` check. Ordinary users, room administrators, token owners and unverified manual assignments gain no implicit authority. Existing room/account operations retain their authorization.

- `node --test --test-reporter=tap tests/config.test.js tests/accounts.test.js`: **28 passed, 0 failed, 0 skipped**. Covers settings validation, either verified provider, pending identities, independent room/media authority and unlink revocation. Initial run: 27 passed / 1 failed because the new fixture attempted to unlink its last usable sign-in; corrected the fixture, then reran successfully. `git diff --check` passed.
- Limits: helper requires a current authenticated canonical account UUID; no new administration operation, settings UI/API, recent-auth or recovery flow. Full suite, real provider integration (C) and human acceptance (D) not run.

### Player settings dialog organization — 2026-10-23

A/B on local changes based on `fc21ab9`; not deployed. The dialog uses two columns for Playback/Audio and Subtitles, keeping subtitle selection, rendering and delay together. Media information comes last with source and technical details side by side; narrow layouts stack the groups.

- **Rendered verification:** Private disposable fixture runner reused actual dialog markup, player styles and the existing playback browser helper. Chrome 155.0.8059.84 and Firefox 158.0.1 passed two-column desktop and single-column narrow checks, no horizontal overflow with technical details collapsed/expanded, Tab from Close to Quality and native Escape dismissal. Screenshots inspected in dark and light themes, at 390×844, and at a 450×400 CSS viewport representing a 900×800 display at 200% browser zoom. An initial CSS `zoom` simulation enlarged the dialog beyond the viewport; that simulation was replaced by the reduced layout viewport used by browser zoom, not treated as a real browser-zoom pass.
- **Template checks:** `node --test --test-reporter=tap tests/watch-page.test.js`: 3 passed, 0 failed, 0 skipped. `git diff --check` passed. No new permanent tests; private screenshots and runner remain ignored.
- **Limits:** Presentation-only changes; no playback logic changes. Full suite, live provider/device integration (C), actual browser zoom and owner acceptance (D) not run.

### Player settings flow — 2026-10-23

A/B on local changes based on `6a89046`; not deployed. Removed the top quality fallback banner and quality command notification. Original quality labels include the selected source bitrate rounded to whole Mbps when known. Desktop choices slide within one menu, final choices close it, and Back stays outside the scrolling list. Mobile retains its existing dialog.

- **Focused tests:** `node --test --test-reporter=tap tests/watch.test.js tests/watch-page.test.js tests/plex-library.test.js`: 35 passed, 0 failed, 0 skipped. Syntax checks passed for the changed player UI, watch client and Plex modules; `git diff --check` passed.
- **Isolated rendered checks:** Disposable Chrome 155.0.8059.84 and Firefox 158.0.1, using the actual player UI module/styles with fixture selects. Navigation, final selection dismissal for quality/audio/subtitles, selection dispatch before settings context cleanup, Escape/arrow/Enter handling, restored focus, and fixed Back placement while scrolling 45 choices passed. Dark/orange, light/pink and narrow 200% CSS zoom screenshots were inspected. An initial zoom-position assertion failed; placement was corrected and both browsers passed. Source-label fixture checks covered rounding, changed bitrate with the same quality IDs, unknown bitrate and preservation of shared preset labels.
- **Limits:** No new permanent test suite; private disposable review runner and screenshots remain ignored. Full suite, live Plex track switching/playback (C), physical mobile/Activity and owner acceptance (D) were not run.

### Endpoint completion fix — 2026-10-23

A/B on local changes based on `5cfb4a25ddbea92a94c07a399db0bb0a69111eb8`; not deployed. Owner selected explicit completion when seeking fully right and reported Play restarting the stuck occurrence. Endpoint commands now use the existing queue completion/countdown flow without decoded readiness or watched-time credit. Play at a finished occurrence selects the queued successor with video-selection authorization; stale readiness cannot restart it. Empty-queue completion fences the durable writer before unloading.

- **Automated:** `node --test --test-reporter=tap tests/*.test.js`: **398 passed, 0 failed/cancelled/skipped** on Node v22.22.2. Existing queue scenarios cover endpoint absolute/relative/end commands, duplicate completion, watched credit, stale readiness, Play/permission behavior, empty-queue resource release and held-writer shutdown. Natural-ending evidence checks remain intact. The added regressions failed before the fix.
- **Browsers:** A private disposable runner reused the existing synthetic account/media app and playback browser helper. Chrome 155.0.8059.84 and Firefox 158.0.1 passed with default and software-decoding flags (four runs): native timeline End started the queued countdown, successor decoded playback resumed, and final endpoint input/change events returned an empty queue to idle. Screenshots inspected in both browsers. Early Firefox attempts timed out because the second native End input sent no command; final empty-queue verification used explicit range input/change events and is not a claim that the repeated native-key fixture issue was fixed. Expected experimental SQLite warning only in the final runs.
- **Owner follow-up (reported 2026-10-24):** The owner confirms the formerly failing fully-right endpoint seek has been verified on the affected hardware-accelerated Chrome/Discord clients after the fix. The previous live endpoint blocker is no longer outstanding in that owner-tested scope. Exact installed revision, media/client versions, detailed procedure and sanitized diagnostics were not supplied with this update; broader hardware/device certification and independent reproducibility remain open. The A/B results above still describe the earlier tested revision; this confirmation is not a new automated-suite pass.

### Real browser continuity — 2026-10-23

C/D, bounded live integration at `5cfb4a25ddbea92a94c07a399db0bb0a69111eb8` (installed revision verified over SSH). Two owner-designated Plex accounts on one Windows device: Chrome with hardware acceleration enabled and owner-operated Firefox with acceleration disabled. Firefox automation was unavailable; Firefox picture/audio and synchronization results are human reports, not captured numerical measurements.

- **Passed in scope:** 720p/4 Mbps direct Plex HLS playback, Firefox leave/rejoin with owner-reported quick synchronized recovery, Chrome replacement to 2 Mbps while Firefox continued at 4 Mbps, shared seeking, one natural ending followed by automatic queued playback after a 10-second countdown, and final natural ending to idle. Final seek required the leader to select Start with ready viewers after the readiness wait; this was not an unattended seek-recovery pass.
- **Host-survivor departure:** With owner approval, temporarily promoted the Firefox viewer to room host, left from Chrome, and obtained owner confirmation that Firefox continued without error. Rejoined Chrome and verified restoration to participant before cleanup. The observed H.264 output retained the same fingerprint across departure and disappeared after the final viewer left; unrelated Plex playback continued.
- **Cleanup:** Read-only Plex transcode/session inspection returned empty after the first ending and again after both viewers left. In the separate host-survivor check, the test H.264 output disappeared after final departure while an unrelated HEVC output/session remained. The observed subtitle ffmpeg child exited; the original application Node process and an unrelated Node process remained running. No service restart or configuration change was made.
- **Observed failures/concerns:** Firefox Original selected a 3840×2160 H.264/AAC stream through uburoom and stuttered heavily; restoring 720p/4 Mbps restored smooth playback. Automatic English PGS subtitle extraction on the second title failed with a supported-limits error while video continued. The owner also reported a faint disabled Pause overlay. No fixes were implemented during verification.
- **Discord AV1 ending:** Separate owner-operated Discord Activity with client hardware acceleration disabled reported smooth 1280×720 AV1/Opus via uburoom, QSV encoder. Owner sought near the end of the approved short title and confirmed natural completion. Read-only server inspection identified an AV1/QSV ffmpeg child of the existing application process before ending; that child was absent after completion and after departure. Application Node PID and installed revision remained unchanged; unrelated Plex playback continued. C/D pass for this single title/environment; no captured frame-gap measurement, multi-viewer AV1 or AV1 queue-transition claim.
- **Endpoint-seek failure (historical 2026-10-23, before the owner-confirmed fix):** Dragging the timeline fully right stalled at the readiness prompt on hardware-accelerated Chrome/Discord. The named blocker followed the accelerated client across account/leader/host changes; the owner reported no failure with both clients' acceleration disabled. This differs from letting the last seconds play naturally and is not established as AV1-specific. Source review found a seek target clamped 50 ms before declared duration, strict tail-buffer readiness, and intentional rejection of seek-only natural-ending evidence. An isolated call to the existing readiness function rejected a 42 ms tail shortfall; no accelerated-client buffered-range/readyState capture or root-cause proof yet. That failure was later reported resolved by the owner following the endpoint-command fix; see the 2026-10-24 owner follow-up above.
- **Open:** One observed test Plex transcode while both browser viewers used 4 Mbps, preserved across leader departure, supports reuse but does not establish each viewer's producer identity. Leader departure with only an ordinary participant correctly paused under the host-presence rule; the separate remaining-host scenario continued. Physical skew, WAN/mobile, broader Activity coverage, resource endurance and subtitle success remain unverified. Detailed private observations and screenshots are retained in the owner evidence workspace.

### Implementation verification — 2026-10-23

A/B on `af86fdb` combined working tree: all 14 corrective tasks from the 2026-10-23 audit (F1–F9, U1–U5) implemented and verified.
- **Node test suite:** `npm test` (`node --test tests/*.test.js`): **393 passed, 0 failed, 0 skipped** on Node v22.22.2 (retired 2 redundant source-spelling assertions from `tests/removed-client.test.js`; endpoint rejection remains verified in `tests/web.test.js`).
- **Playback decoding baseline:** `npm run test:playback` (`node scripts/playback-baseline.js`): **33 passed, 0 failed** across Firefox, Chrome, and Edge, verifying synthetic decoded direct streams, HLS HEVC, AV1 23.976/60, and VP8/VP9. Production subtitle delivery and rendering are excluded from this baseline and remain open gates.
- **Dual-browser rendered verification:** Chrome and Firefox verified for account-match preview generation fencing, reconnect without unlinking, owner-reserved login exception for Plex removal, theme-aware host and active filter contrast, 40×40px minimum player, queue, and segmented control hit targets across desktop, narrow, and coarse-pointer layouts, Mute toggle `aria-pressed` state, and static descriptor `createElementNS` icon DOM construction.
- **Risky boundary checks:**
  - Streaming idle progress timeout and response header deadlines (`tests/resilience.test.js`, 6 passes).
  - Direct-HLS preparation pool cancellation and group lifecycle (`tests/hls-pool.test.js`, 4 passes).
  - Account assignment authority fencing and revocation race (`tests/accounts.test.js`, 33 passes).
  - Last-login unlink protection and owner-reserved Discord login exception (`tests/installation-policy.test.js`, 1 combined scenario pass).
  - Unsupported WebSocket upgrade rejection with prompt socket destruction (`tests/watch-socket.test.js`, 8 passes).
  - Listen failure server cleanup and storage worker release (`tests/config.test.js`, 12 passes).
  - Asynchronous static asset serving with bounded cache (`tests/web.test.js`, `tests/watch-page.test.js`, 17 passes).
- **Limitations:** Fixtures and synthetic responses only; intermediate measurements (which recorded 40×34 segmented view buttons and 36×40 mobile player buttons prior to Step 6 completion) are superseded by full 40×40px interactive target enforcement; no live external Plex provider, production subtitle delivery/rendering, multi-viewer WAN soak, or physical mobile hardware certification performed. Release gates remain open.

### Repository audit — 2026-10-23

A/B on `fb349f428d538f4297a8bd53754d758a095d94a4`: two independent audits each ran the full Node suite with **387 pass, zero failures/cancellations/skips** on Node v22.22.2 (`node --test tests/*.test.js`, one with `--test-reporter=tap`). The advisory query reported zero known npm vulnerabilities. Isolated probes reproduced a streaming body deadline abort, account assignment after login/Admin revocation during body reading, direct-HLS adoption of a disposed group, disabled-provider unlink acceptance and missing unknown-upgrade socket disposal. Startup-failure cleanup and synchronous asset I/O were source-reviewed; production performance impact was not measured.

The follow-up UI pass used isolated Chrome 155.0.8059.84 and Firefox 158.0.1 fixtures at desktop/narrow sizes. Both reproduced a late account-match preview restoring assignment for earlier IDs after editing; actual assignment was verified in memory-only fixture state. Rendered inspection also found an unusable sole-provider reconnect instruction, undersized player/queue targets, faint light-theme host/filter colors and missing Mute pressed state. Segmented keyboard selection, focus return, 680×500 dialog reflow and error toasts with ordinary notifications muted passed. Three private investigation scripts completed in both browsers after correcting probe assumptions; details, screenshots and limitations are retained with the consolidated private audit and pending queue (14 distinct tasks). They are not permanent smoke runners.

Application code remains unchanged. Library fixtures did not cover populated content/facets; CSS zoom stress is not browser-zoom evidence, and emulated coarse pointer is not a physical device. No C/D, real-provider, screen-reader or physical-device checks were performed. No decoded-playback qualification is claimed. Passing baseline tests and fixture UI checks do not close reported defects or existing release gates. The duplicate standalone audit was consolidated into the private audit record; proposals remain pending owner review.

A subsequent bounded source-only synchronization review identified two improvement candidates: uncertainty gating in default drift correction and clock-sample reacquisition versus connection liveness. Neither was execution-validated; no tests or browser checks were run for that follow-up. Detailed proposals remain in the private audit.

### Earlier scoped results — 2026-10-22

| Area | Recorded evidence | Open / limitation |
| --- | --- | --- |
| Browser preferences | B: 403/0/0 full Node; Chrome/Firefox storage, 30% default, quality/subtitle preference behavior. Slider follow-up: 13 focused passes and independent pending-state checks | No new decoded-track sweep or provider certification |
| Room permissions/privacy | B: 402/0/0 full Node; focused Chrome/Firefox browsing, columns and private-member removal | Broad Room smoke stopped at **Bulk excludes Specials**; owner acceptance open |
| Sync-quality scoring | B: final ring-buffer/1Hz change passed 42 focused tests; earlier confidence UI passed 36 focused and dual-browser roster checks | Earlier 395 full-suite pass predates final changes; final full-suite and real-device repeat not run |
| Missing media | B: 370/0/0 full suite and dual-browser unavailable/queue feedback; C read-only PMS metadata exposed missing files with checkFiles=1 | Ordinary listing omitted flags; no live queue mutation |
| Background availability | B: 371/0/0; Chrome/Firefox held-provider checks preserved catalog rendering, focus and scroll | No real-server performance claim |
| Toasts/tracks/navigation | A/B Chrome/Firefox focused rendered checks across desktop/phone, themes, dismissal/errors, disabled tracks, poster clicks and scrolling | No full-suite rerun or human/live-device acceptance; touch was emulated |

Counts are historical pass/fail/skip, not test quotas. The [design guide](design-guide.md) owns UI behavior; code owns the sync-score formula.

## Direct Plex HLS — 2026-10-22

- **B:** Candidate based on `161ff1e`, recovery on `1da23a8`, LAN discovery on `38a1ab4`: recorded full suites **377/0/0**. Chrome 155.0.8059.84 / Firefox 158.0.1 synthetic direct/shared late join, 440Hz PCM, paused picture/seek/resume, CORS recovery and token exclusion passed. Successful direct cases made zero server video requests.
- **C partial:** Two temporary tokens from one non-owner account read matching initial/later segments from one real output; server preparation fetched zero video bytes. Owned session stop/disappearance verified. This was not different-account browser playback.
- **Owner C/D:** External personal and Discord-only fallback phone viewers reported direct HLS; Safari screenshot showed H.264/AAC 720p/4Mbps. Shared producer reuse was not proven.
- **Recovery:** Refused/hung fixtures improved from Chrome 3345/12253ms to 417/5273ms, Firefox 12207/12182ms to 5269/5254ms. Installed minute-long delay was not reproduced. LAN/public-origin refusal is not proof of account rejection.
- **Open:** Different real accounts, long-run external synchronization, selected tracks, expiry/revocation and cleanup. Native-HLS-only/Activity remain separate proxy paths.

## Direct Plex file delivery — 2026-10-22

B candidate based on `dc31aa4`: **374/0/0**, Chrome/Firefox direct decode and failed-CORS proxy recovery; conversion baseline HLS/AV1 **4/0**. NAT-loopback follow-up on `94a5b67` passed **374/0/0**; same-account fallback token resolution on `e1856c6` passed **375/0/0**, plus read-only real metadata/library checks.

Owner reported external 4G Original with direct-file state and later successful normal Plex linking. The earlier callback failure's cause remains unestablished. Label checks based on `4e1f848` passed both browsers. Broad real delegation/revocation, captions, interruptions and device coverage remain open; strict direct-only is unimplemented.

## Known failures and evidence limitations

| Issue | Disposition |
| --- | --- |
| Current Room smoke: Bulk excludes Specials | Stopped before later flows; focused checks do not close it |
| Retired layout/queue smokes | Old normal-view and oomark assertions failed; not rerun, not a mandate to restore scripts |
| Retired Player smoke | Firefox and Chrome creation timeouts; playback assertions not reached |
| Retired room-redesign smoke | Expected old empty-state text; reproduced on unchanged baseline |
| Sync experiments | Slower convergence/Chrome drops; disabled, disposition pending |
| AV1 ending | Prior live ~42ms final-buffer gap; 2026-10-23 C/D Discord AV1/QSV near-end replay finished cleanly and encoder child exited; broader media/multi-viewer/endurance coverage remains open |
| Real soak | First run unloaded/recovered; repeat run clean. Original trigger remains unproven; owner suspects a transient internet dropout, not a confirmed current playback defect |
| Resource/timing fixtures | A locked-disk timer assertion failed under contention then passed alone/full rerun; no assertion weakened |
| Browser limits | Firefox Escape exits fullscreen, narrow drawer resize timeout, sparse high-rate frame callbacks; emulated touch is not real-device evidence |

Detailed measurements and repaired historical failures are retained in the [digest](archive/testing-2026-10-22.md).

## Outstanding M1 verification register

| Gate | Required methods | Remaining |
| --- | --- | --- |
| Release | A/B/C, D UX | Independent install/origin/providers, operator restore/rollback, source/history/ZIP privacy and licensing |
| P1 endurance | B/C/D | Real Firefox/Activity/multi-viewer endurance, hardware/resources, unload cause and physical fidelity |
| P2 delivery | A/B/C | Source/output negotiation and real cross-account/codec/capacity matrix |
| P3 fidelity | B/C/D | Real languages/downmix/captions and switching |
| P4 reporting | C/D (A/B on main) | Live PMS/Tautulli validation, multi-viewer shared-producer stop/seek transitions, natural completion, external AV1 telemetry and personal-state/sponsorship isolation |
| P5/P6 sync/pacing | B/C/D | Physical/WAN ≤50ms p95 / ≤100ms p99, supported-policy disposition and joint smoothness acceptance |
| P7 UI | A/B/C/D | Broader journeys, physical mobile/Activity/accessibility and owner acceptance |
| P9 subtitles | B/C/D; A licensing | Real authored fonts/content, lifecycle/resources and corresponding-source review |
| P10 terminology | A; B/C where affected | Final current web/Activity sweep; canonical protocol has historical local evidence |
| P11 architecture | A/B/C | Real proxy/resources and operator backup/restore/rollback |
| P12 telemetry | A/B/C/D | Repeat actual-device score/confidence and readability; richer features remain future scope |
| P13 rooms/queues | B/C/D | Real multi-viewer continuation, recovery, writer/load and UX |
| P14 access/admin | A/B complete; C/D release checks | Three-outcome local scope closed; real admission/revocation/handoff and independent operator recovery remain release gates |

P5/P6 human check: watch together ~3 minutes, pause/resume/seek, background one tab ~10 seconds and return. Technical timing remains separate. Design authorization is not visual acceptance; neither permits deployment.

## Maintenance

Update the affected result/gate only. Keep commands in development, requirements in owning plans, and detailed sanitized investigations in dated evidence. Do not append UI specifications, repeat suite histories, restore retired runners or turn old results into current green status.
