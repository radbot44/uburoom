# Verification dashboard — M1

> **Historical evidence cutoff: 2026-10-21; test-suite pruning: 2026-10-22.** No runtime tests or integrations were executed for the pruning PR. Results below belong to their original revisions, environments and scopes; they are not a newly verified current checkout.
>
> **M1 release status: OPEN.** [Entire historical record](archive/testing-2026-10-22.md) · [M1 release requirements](../ROADMAP.md#m1--verified-self-hosted-release)

## Current status and provenance

- **This dashboard owns** current commands, verification methods, last evidenced results, known failures and unfinished M1 gates. [ROADMAP](../ROADMAP.md) owns scope and priorities; [development](development.md) owns procedures; the [dated archive](archive/testing-2026-10-22.md) retains detailed prior findings.
- Different archived passes concern distinct commits or uncommitted trees. **No combined green current HEAD is established** by comparing old full-suite counts or narrower smokes.
- Latest **documented full TAP**: **461 passed, 0 failed, 0 skipped**, recorded for the combined Queue/OverlayScrollbars checkout on 2026-10-21 (no single final-tree commit identified). This is historical **B** evidence, not rerun for this dashboard ([source](archive/testing-2026-10-22.md#2026-10-21---shared-controls-queue-increment-m1-p7)).
- Later/parallel Room and Media findings carry their own revision-scoped counts and exceptions. The archive preserves all superseded results, measured observations, failed attempts and owner commentary.
- **Release claims are not certified** while required C real-provider/device or D human acceptance remains incomplete. Test consent, state transfers, deployments and publishing always require their own approval.

## Verification standard for new work

| Method | Qualifying evidence | Does not prove alone |
| --- | --- | --- |
| **A — Review** | Source, contract, specification, rendered/static evidence inspection | New runtime or provider success |
| **B — Automated** | Executed fixtures, disposable accounts, local faults, browser DOM, decoded frames/PCM | Real Plex/Discord/physical device or human acceptance |
| **C — Integration** | Observed real provider, installed client, physical device/network/hardware | Other platforms, versions, media or account combinations |
| **D — Human** | Recorded picture, sound, UX, accessibility observation or owner acceptance | Numeric sync, performance, authentication or universal compatibility |

- Report each **required** method as **pass / fail / blocked / not run** and label partial scenarios explicitly. A is not an executed B result; B fixtures cannot replace C; D cannot replace numeric engineering proof.
- Record gate, evidence date, commit/worktree, relevant OS/browser/provider/device version, real or simulated identity, command/procedure, expected and actual outcome, pass/fail/skip counts when available, sanitized evidence and remaining levels.
- API 200, command acknowledgement, advertised codec support, advancing media time, screenshots or agent assertions do not alone establish actual decoded picture/sound, Plex watch state or presentation-time skew.
- Chrome **and** Firefox are equal required web-client targets. Preserve explicit actual Plex/Discord Activity, installed remote, physical-device, accessible UX, provenance and release gates.
- No unexpected skips for a full-suite pass. Generate development TLS first: missing certificates can cause skips and failures. `npm test` dot output does not report skips; use `npm run test:full`.
- C may be agent-executed with separately authorized, isolated/consenting real accounts. C or D classification does not itself grant permission to restart, migrate, write production state, deploy or publish.
- Protect keys, personal host paths, private screenshots, user identities and media; link only sanitized evidence from tracked files.

## Test commands and verification procedures

**Current runnable checks only.** A 2026-10-22 cleanup retired 27 test files and 27 one-off smoke scripts; older logs, run counts and failure descriptions below are *historical evidence*, not commands to resurrect. Choose only checks relevant to the code being changed.

| Check | Command | Scope |
| --- | --- | --- |
| Focused Node regression | `node --test tests/<relevant-file>.test.js` | Prefer one affected, retained test file |
| Remaining Node suite | `npm test` | 34 suites; dot output omits skip counts |
| Full TAP details | `npm run test:full` | Pass/fail/skip counts; release or broader verification |
| Durable rooms and queue | `node --test tests/durable-rooms.test.js` | High-value isolated state/lifecycle boundary |
| Room browser boundary | `node scripts/room-ui-smoke.js --browsers=chrome,firefox` | Disposable cross-browser accounts |
| Media controls | `node scripts/media-controls-smoke.js` | Two browsers, synthetic media |
| Queue controls | `node scripts/queue-controls-smoke.js` | Two browsers, synthetic queue |
| Library browser | `node scripts/plex-library-smoke.js` | Disposable Plex fixture (Firefox) |
| Scheduled sync controls | `node scripts/sync-controls-smoke.js --browser=chrome` | Repeat Firefox when relevant |
| Local WebM decode | `node scripts/local-webm-smoke.js --browser=chrome --codec=vp9` | Repeat other codec/browser when relevant |
| Decoded media baseline | `npm run test:playback` | Actual pixels/PCM from isolated generated media |

Development TLS may be required: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/new-dev-cert.ps1`. A missing certificate can yield failures or skips. Browser tools can start isolated servers and write ignored `artifacts/`; they do not use production accounts. Preserve separate C/D verification for live PMS/Discord, hardware/physical playback, and owner review; no synthetic runner certifies those.

## Latest evidenced results (historical; not rerun)

| Date / scope | Last recorded pass or observation | Limitation and evidence |
| --- | --- | --- |
| **2026-10-21 Queue/OverlayScrollbars** | B complete TAP **461/0/0**; focused Queue controls and navigation pass Chrome/Firefox | Broad Queue smoke failure; C/D open ([Queue](archive/testing-2026-10-22.md#2026-10-21---shared-controls-queue-increment-m1-p7)) |
| **2026-10-21 Media controls** | B Chrome/Firefox Media, library, Room regressions; `npm test` reportedly passed; Chrome touch emulated | No new full TAP/skip count; Firefox narrow drawer resize and real touch unproven; D open ([Media](archive/testing-2026-10-22.md#2026-10-21---shared-controls-media-increment-m1-p7)) |
| **2026-10-21 Room UI** | A/B Chrome/Firefox roster, permissions and layout; heading/gutter checkout **456/0/0** TAP | Separate Room revisions and Player timeout; C physical Activity/mobile and D owner visual acceptance open ([Room](archive/testing-2026-10-22.md#2026-10-21---centered-room-subheadings-and-overlay-only-gutter-m1-p7)) |
| **2026-10-21 Tabler remote regression** | B reproduced **452 passed / 3 failed**, later local repair full TAP **455/0/0** | Initial failure remains historical; installed client unverified ([repair](archive/testing-2026-10-22.md#2026-10-21---restore-remote-tabler-wiring-after-legacy-regression)) |
| **2026-10-21 Vigrid fixture repair** | A/B 12 focused recovery passes and local full TAP **455/0/0** | C deployed restart/health not run ([record](archive/testing-2026-10-22.md#2026-10-21---vigrid-recovery-test-fixture-repair)) |
| **2026-10-20 owner Discord Activity codec run** | C native VP8/VP9/AV1 picture+sound; H.264 decoder failures and HEVC sound-only; D owner observation | Windows acceleration Off, one native sample client, 640×360/12fps; streamed VP8/VP9 MSE not certified ([matrix](discord-codec-compatibility.md)) |
| **2026-10-19/20 Plex provider research** | C real Original/HLS/AV1 activity, opt-out read-backs and isolated truthful HLS transcode association | Reporter unimplemented; pooled producer and external AV1 attribution open ([association](archive/testing-2026-10-22.md#plex-delivery-association-and-direct-play-classification-2026-10-20)) |
| **2026-10-17–20 sync/pacing** | B simulated skew, decoding and readiness; selected Plex Chrome observations and experimental cadence measurements | Physical inter-viewer percentiles unproven, owner D pending, Chrome correction-candidate drops ([sync](archive/testing-2026-10-22.md#real-time-playback-synchronization), [pacing](archive/testing-2026-10-22.md#frame-pacing-preservation-during-synchronization)) |

## Known failures and evidence limitations

**Archive note:** Several runners named in the table below were deliberately retired in the lean-test cleanup. Their observed failures remain real historical evidence; the commands are no longer part of the supported developer workflow.

These are **documented failures or incomplete observations**, not claims that every issue still reproduces on today's HEAD. Preserve any narrower passes separately.

| Check / issue | Last observed outcome | Verification disposition |
| --- | --- | --- |
| `watch-layout-smoke.js` | 2026-10-21 Media work still stopped on old `normal` library-view assertion at line 102 | **Fail documented / not re-executed** ([Media](archive/testing-2026-10-22.md#2026-10-21---shared-controls-media-increment-m1-p7)) |
| Broad `queue-ui-smoke.js` | Chrome stopped at old Room oomark mask assertion, line 266; navigation-only and controls pass both browsers | **Broad fail remains unclosed** ([Queue](archive/testing-2026-10-22.md#2026-10-21---shared-controls-queue-increment-m1-p7)) |
| `player-ui-smoke.js` | Firefox room-create timed out, then Chrome retry timed out before playback/icon assertions | **Incomplete**, cause not established ([Room icons](archive/testing-2026-10-22.md#2026-10-21---room-door-canonical-oomark-and-subheading-spacing-m1-p7)) |
| `room-redesign-smoke.js` | Earlier popup-era expected “No active rooms” vs “Join or create a room”; reproduced on untouched baseline | **Historical fail**, current broader run not established ([popup](archive/testing-2026-10-22.md#2026-10-20---popup-consistency-m1-p7)) |
| `theme-smoke.js` | Popup-era Chrome/Firefox stopped on missing `remote-settings`; no independent baseline reproduction | **Historical fail**, no verified current repair ([popup](archive/testing-2026-10-22.md#2026-10-20---popup-consistency-m1-p7)) |
| Installed Firefox extension full smoke | Popup height observed 600px vs required under 600px; separate deferred guest-control/rate-limit failure | **Full run incomplete**, bounded extension fixture insufficient ([remote](archive/testing-2026-10-22.md#room-terminology-m1-p10)) |
| P5/P6 correction candidates | Slower convergence and concerning Chrome native drops in local comparisons | **Disabled/gated**, investigate/dispose before release ([pacing](archive/testing-2026-10-22.md#frame-pacing-preservation-during-synchronization)) |
| Real Plex AV1 natural ending | Historic AV1 stopped ~42ms before declared duration, later fix only B-tested; PMS ignored external AV1 telemetry | **C retest open** ([Plex](archive/testing-2026-10-22.md#plex-hlsav1-activity-only-follow-up-2026-10-20)) |
| Browser/fixture exceptions | Firefox Escape leaves fullscreen; Firefox narrow Media fullscreen resize timeout; Chrome synthesized tap not a real phone; one timing-sensitive storage-worker failure passed alone/full rerun | Scope limits, not broad product certification; original observations archived |

### Historical failures with recorded repairs

- The three Tabler icon regression tests were later repaired on the recorded local worktree; the earlier failed run remains a real historical failure.
- Missing TLS certificates historically caused test skips/failures; only complete zero-unexpected-skip runs are suitable B full-suite evidence.
- Prior initial encoding, synthetic-provider, startup, playback and browser errors are retained **verbatim** rather than erased or rewritten as successful first attempts.

## Outstanding M1 verification register

**Open gates** below use the required methods for each claim. Past success is valid only for the described subcase, not the entire required matrix.

| Gate / required methods | Existing scoped evidence | Still open |
| --- | --- | --- |
| **Overall M1 — A/B/C, D for UX** | Local ZIP/source and limited installation observations | Independent host/origin/providers, exact key/SQLite backup/restore/rollback, complete source/history/ZIP/privacy/brand/license audit, owner release acceptance |
| **M1-P1 Endurance — B/C, D fidelity** | Real two-hour Plex Chrome and synthetic browser soaks/recovery | Real Firefox/Activity multi-hour, network/hardware/resources, unload root cause and physical picture/audio |
| **M1-P2 Delivery — A/B/C** | Local codec/quality/encoder/fallback and partial real PMS checks | Real Plex/device codec/quality and resource/capacity matrix |
| **M1-P3 Audio/subtitles — B/C/D** | Fixture PCM/pixels and selected Plex stream tracks | Real language/layout/downmix/audio, styled/bitmap captions, switching and owner fidelity acceptance |
| **M1-P4 Reporting — A/B/C** | Real Plex activity-only research and isolated HLS association | Product **not implemented**; history/resume/completion, shared producer, external AV1 telemetry, sponsorship/owner-token fallback and revoked identity |
| **M1-P5 Sync — B/C/D** | Synthetic clock/readiness/controls and selected Plex observations | Actual presentation **≤50ms p95 / ≤100ms p99 unverified**, real WAN/physical display and joint owner check |
| **M1-P6 Pacing — B/C/D** | Local cadence comparisons and opt-in occasional jumps | Chrome candidate drops, disabled-policy disposition/removal, physical smoothness and P5/P6 D |
| **M1-P7 UI/UX — A/B/C/D** | Owner-approved design iterations and Chrome/Firefox fixture layouts | Broader journeys, physical mobile/Activity, screen readers, owner final visual/usability acceptance |
| **M1-P8 Remote — B/C** | Local protocol and bounded Firefox installed fixture | Full failed extension smoke, real YouTube TV/Firefox/Chromium, consent/origins/sleep/wake lifecycle |
| **M1-P9 Subtitles — B/C/D** | Local ASS/PGS/VobSub parser/render/fixture tests | Real Plex/Activity/fonts/readability, lifecycle, compatibility and licensing |
| **M1-P10 Terminology — A/B/C** | Canonical contract and fixture actions | Real bot, Activity and installed extension interoperability |
| **M1-P11 Architecture — A/B/C** | Local WebSocket/SQLite/worker/fault and backup fixtures | Real proxy, operator backup/restore/rollback, OS/hardware/resources |
| **M1-P12 Telemetry — A/B/C, D readability** | Planned, no product result | Authorize implementation, then define and execute full test/clarity matrix |
| **M1-P13 Rooms/queues — B/C, D UX** | Local persistence/queue/autoplay/concurrency and browser flows | Real multi-viewer Plex/Activity, writer/sync/load, operator state recovery, UX |
| **M1-P14 Config/admin/access — A/B/C, D operator UX** | YAML/access/host-account fixtures and browser checks | Broader admin/security, real admission/revocation, sponsorship, Linux/macOS/container and operator recovery |

### Human and release authorization gates

- **P5/P6 D pending:** owner views a shared title for approximately three minutes (motion, lip-sync, same moment), pauses/resumes/seeks, and backgrounds one tab ~10 seconds before returning. Technical inter-viewer timing remains separately unverified ([full owner checklist](archive/testing-2026-10-22.md#joint-m1-p5m1-p6-human-verification)).
- **P7 D pending:** screenshots in ignored artifacts are review material, not approved reference baselines or pixel tolerances. Design authorization does not equal visual acceptance.
- **Independent approvals:** consent for real tests, account/history changes, private-state transfer, production restart, public push, signing, deployment and publication cannot be inferred from A/B/C/D evidence.

## Evidence index and maintenance protocol

- **Verbatim historical file:** [docs/archive/testing-2026-10-22.md](archive/testing-2026-10-22.md) retains all past methods, results, failures, counts, measurements, worktree context and owner observations.
- **Owning plans:** [ROADMAP](../ROADMAP.md), [development](development.md), [playback](playback-reliability.md), [Plex reporting](plex-reporting-investigation.md), [codec matrix](discord-codec-compatibility.md), [room/queue](rooms-and-queues.md), [access](accounts-and-access.md).
- **Do not append exhaustive chronological reports.** Update the relevant last-result, known-failure or open-gate row when actually new evidence is recorded; preserve existing unresolved wider failures and links.
- **Concise result update:** date/revision, gate, required/completed levels, exact scope and command, observed outcome and counts, limitations, sanitized evidence pointer and next open check. Avoid repeated fixture disclaimers and historical suite-count progressions.
- **Detailed evidence location:** ignored `artifacts/` for TAP, screenshots and transient logs, approved private storage for sensitive runs; a **new sanitized dated archive** for material durable failure investigations, measurements or owner observations.
- **Cross-reference rule:** current-status links point here; former dated section/measurement anchors point to the verbatim archive. Keep requirements in ROADMAP and technical plans, not duplicated narratives here.
- **No certification by inference:** docs-only changes, isolated-fixture passes, owner design approvals or old green counts do not pass an unverified gate.

### Minimum record checklist

1. Identify the precise milestone and behavior, not merely a feature name.
2. State execution date and exact commit or working tree.
3. List required A/B/C/D methods before recording completed levels.
4. Use pass/fail/blocked/not run for each required level.
5. Scope browsers, account/media/provider identity and simulated vs real context.
6. Include reproducible commands or procedures and actual observable outcome.
7. Record pass/fail/skip counts and identify unexpected skips explicitly.
8. Separate intermediate errors, final reruns and unreproduced issues.
9. Link sanitized detailed logs or a new dated archive when warranted.
10. Keep broader known failures visible if only a narrower check passed.
11. Update the affected M1 gate, without changing unrelated phase priorities.
12. Keep raw private artifacts and credentials out of the tracked source tree.
13. Validate redirected historical links and active dashboard anchors.
14. Distinguish D owner acceptance from C integration test consent.
15. Preserve separate deployment, state-migration and release permission.
16. If editing docs only, explicitly say that no tests were executed.
