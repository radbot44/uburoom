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
- **Direct-delivery increment, 2026-10-22:** `npm run test:full` passed **374 tests, 0 failed, 0 skipped** on the uncommitted increment based on `dc31aa4`. Chrome/Firefox synthetic direct-file and recovery checks also passed; this is current-tree B evidence, with real Plex/Discord gates still open. [Scope and limits](#direct-plex-file-delivery-2026-10-22).

## Direct Plex HLS — 2026-10-22

- **A/B pass, local candidate based on `161ff1e`:** `npm run test:full`: **377 passed / 0 failed / 0 skipped**. Focused account/pool tests cover selecting direct before segment cache warm-up, matching output sharing with separate viewer tokens, no delegated credential on the shared producer, independent proxy pooling/recovery, session/origin/query credential fencing and revoked/stale/foreign viewers. Existing track and conversion-policy regressions remain green. No configuration keys or migration are added.
- **Browser B pass:** Disposable Chrome **155.0.8059.84** and Firefox **158.0.1**, synthetic HTTPS Plex origin, actual watch player and dedicated fixture fallback account. Each decoded direct HLS, admitted a mid-playback second viewer into the same output with a distinct temporary token, decoded expected 440 Hz PCM, compared paused picture pixels after a seek to 35 seconds and resumed. Direct cases made zero proxy video requests. Missing-CORS/503 cases recovered through the proxy with HLS output and seek/resume retained. Diagnostic exports excluded temporary credentials. The private fixture used a fresh app per browser; no new permanent smoke runner was added.
- **C partial pass:** Two distinct temporary tokens from one real dedicated non-owner account read the same prepared Plex HLS session: both child playlists, first/later segments, a late-client segment-zero request and a subsequent first-client later-segment request returned HTTP 200. Anchor/later bytes matched across those reads. Instrumented uburoom preparation made **zero video requests**; standalone probe clients read the media. The owned test session's stop returned HTTP 200 and its disappearance from Plex's transcode listing was verified. TLS used the verified public hostname with the socket routed to the known LAN address to avoid absent NAT loopback; this does **not** verify external reachability or browser playback. No production restart, configuration write or watch-history reporting occurred.
- **Open C/D gates:** Different real Plex accounts sharing one output; actual external-browser HLS picture/audio/synchronization; prolonged late joins and seeks; selected audio/burned captions on direct output; expiry/revocation and cleanup under real load. Native-HLS-only browsers and Activity retain proxy HLS. Initial playlist text remains in uburoom; every direct video/audio segment, including the timestamp anchor, is fetched by the browser. [Architecture](plex-hls-delivery.md) · [Detailed record](archive/testing-2026-10-22.md#direct-plex-hls-follow-up).

## Direct Plex file delivery — 2026-10-22

- **Delivery label, B pass:** The working-tree UI follow-up based on `4e1f848` shows **Direct from Plex** or **Through uburoom** in Player settings → Media information → Technical details. A disposable synthetic browser check passed direct playback and failed-direct-probe proxy recovery in Chrome 155.0.8059.84 and Firefox 158.0.1, including decoded video, paused seek/resume and the corresponding label. Desktop/narrow screenshots were captured across Light/Dark × Orange/Pink, with no text overflow; representative before/after renders were visually inspected. `node --check web/watch.js` and `git diff --check` passed. This check used no live Plex/Discord credentials.
- **Owner-reported C/D follow-up:** Normal Plex linking subsequently succeeded. On a phone over 4G, playback succeeded with `format: hls`, `quality: 720p4`, `direct: false`; selecting Original then played with `format: file`, `quality: direct`, `direct: true`. This establishes the reported external original-file path, not universal device support or direct HLS.
- **Credential-resolution follow-up, A/B pass:** Configured account fallback tokens rejected by PMS now resolve the same account's server-specific token; discovery retains the account credential. Resolution is coalesced/cached per configured credential and does not retry item denials or change identity. `npm run test:full`: **375 passed / 0 failed / 0 skipped**, uncommitted follow-up based on `e1856c6`. Consolidated tests cover direct delegation with resolved tokens, discovery/account isolation, revoked credentials, item restrictions, concurrent resolution and non-401 denials.
- **C partial / linking issue open:** Read-only real PMS checks reproduced raw fallback-token HTTP 401 and confirmed its resolved server token reads libraries with non-owner access; candidate direct metadata checks also passed without owner substitution. A separately authorized fresh owner PIN login passed library validation, but the owner still reported the normal account-link callback failing on the installed version. That separate callback failure is not claimed fixed or explained by the fallback change. No production configuration/token replacement was performed by these diagnostic checks.

- **NAT loopback follow-up, A/B pass:** Uncommitted fix based on `94a5b67` accepts exact authenticated Plex-advertised HTTPS non-relay origins for the pinned server, while preserving probes for unlisted origins. `npm run test:full`: **374 passed / 0 failed / 0 skipped**. Chrome 155.0.8059.84 and Firefox 158.0.1 passed four direct-file/failed-CORS recovery scenarios with server-side public probes disabled; direct playback, paused seek/resume and diagnostic token exclusion passed. Consolidated account checks reject lookalike origins, other-server metadata and relay entries.
- **C partial:** Read-only real Plex discovery confirmed the configured non-owner fallback account and its exact public HTTPS origin; no temporary credential was minted. The owner confirmed the HTTPS identity endpoint opens on a phone over cellular. Real browser CORS/range/media decoding over that external route remains unverified. The follow-up fix is local; production activation was not performed by this check.

- **A/B pass:** Optional `plex.delivery: auto` with explicit HTTPS client origin; personal temporary delegation; dedicated non-owner fallback opt-in; rejection of configured-owner/ambiguous fallback credentials and mismatched endpoint identity; stale/foreign delivery requests and late revocation; five-second negotiation timeout with late-result fencing. Full suite: `npm run test:full`, **374 passed / 0 failed / 0 skipped**, uncommitted increment based on `dc31aa4`.
- **Browser B pass:** Disposable Chrome **155.0.8059.84** and Firefox **158.0.1**, synthetic HTTPS Plex origin and dedicated fallback identity. Each decoded direct original-file video without proxy file requests, paused/seeks to 35 seconds and resumed; each recovered a missing-CORS/503 direct probe through the authorized proxy while retaining original-file output. Diagnostic exports excluded the temporary credential. Four scenarios passed. A test-harness close request was corrected to include the existing required room epoch before the successful final run.
- **Conversion B pass:** Existing `scripts/playback-baseline.js`, cases `hls-hevc,av1-23976`, Chrome/Firefox: **4 passed / 0 failed**. Decoded video/audio, paused seeking and resume passed for Plex-style synthetic HLS and software AV1. This is not real PMS negotiation, hardware encoding or Activity evidence.
- **C/D not run:** Real Plex delegation/ownership metadata, public TLS/CORS/range reachability, real subtitles, prolonged interruptions and actual Discord clients. No private configuration migration, production restart or deployment performed. Strict direct-only mode and direct HLS remain unimplemented. [Detailed evidence and boundaries](archive/testing-2026-10-22.md#direct-plex-file-delivery).

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

## Toast positioning — 2026-10-22

A/B: Chrome and Firefox checks at 1280px/390px pass 40px height, 24px icons, 14px/12px text, no border, action/username rows, entrance/exit and control-avoidance animation, lobby bottom placement, actual media-control spacing, scroll visibility priority, theater and fullscreen entry/exit. Temporary procedure: `node artifacts/toast-position-inspect.cjs`; captures in ignored `artifacts/toast-ui-1792648132726/`. Existing `node scripts/toast-ui-smoke.js` passes in both browsers across light/dark and orange/pink. Desktop/mobile renders inspected. Layout states and synthetic notifications used disposable accounts; no new permanent tests. Full-suite and real-provider/device checks were not run for this styling change; human acceptance remains open. Previous positioning work also passed the retained 12 recovery tests.

## Toast and subtitle controls — 2026-10-22

A/B: Chrome/Firefox rendered checks pass click/keyboard toast dismissal, fullscreen dismissal without playback activation, bell on/off states, suppression without replay, subtitle on/off icons and white active color, and disabled subtitles when none are available. Toolbar fits at 1280/390/320px. Temporary procedure: `node artifacts/toast-toggle-inspect.cjs`; captures in ignored `artifacts/toast-ui-1792682915764/`. Official Tabler outline SVGs vendored with the existing MIT notice retained. No permanent tests added; full suite and real-provider/device checks not run. Human visual acceptance remains open.

## Unavailable media tracks — 2026-10-22

A/B: Chrome/Firefox desktop and 390px mobile inspection passes empty/all-unavailable track lists, exact unavailable labels, disabled track menu rows/selectors, plain Automatic, omitted subtitle Off, and restoration when usable tracks return. Temporary procedure: `node artifacts/track-availability-inspect.cjs`; captures in ignored `artifacts/toast-ui-1792683850084/`. No permanent tests added; full suite and real-provider checks not run. Human acceptance remains open.

## Media navigation scrolling — 2026-10-22

A/B: Chrome/Firefox fixture checks pass partially visible content preserving page position for Browse, Home and new/cached library tabs; out-of-view Browse and Home jumps leave first cards below the sticky header. Desktop, 390px mobile and fullscreen drawer checked and captures inspected. Procedure: `node artifacts/media-scroll-inspect.cjs`; ignored captures `artifacts/media-scroll-chrome/` and `artifacts/media-scroll-firefox/`. No permanent tests added; full suite, real-provider checks and human acceptance not run.

## Error toasts — 2026-10-22

A/B: Chrome/Firefox fixture checks pass subtitle preparation and renderer errors using red error toasts, normal suppression while errors bypass the toggle, preserving visible errors when muted, foreground 10-second lifetime without render resets, dismissal without reappearing, later failure notification, and retained settings/retry feedback. Dark/light desktop/390px captures inspected. Procedure: `node artifacts/subtitle-error-toast-inspect.cjs`; ignored captures `artifacts/toast-ui-1792685399659/`. No permanent tests added; full suite, actual subtitle-provider failure and human acceptance not run.

## Media navigation and poster clicks — 2026-10-22

A/B: Chrome/Firefox disposable browser fixtures pass Collections `layout-grid`, library buttons inside the history group with movie/TV icons and `aria-current`, text/icon/hidden responsive stages, and no header overflow across 390–1800px viewports. Rendered unavailable Cards/Posters Play overlays are fully hidden. Hit tests across poster and caption regions resolve to item-opening controls; clicks open available and unavailable details. Chrome touch emulation verifies that the first tap opens details. Procedure: `node artifacts/media-poster-navigation-ui.cjs`; log and captures are ignored under `artifacts/`. Syntax and diff checks pass. No permanent tests added or full-suite rerun for these UI changes; live deployment and human acceptance not performed.

## Library availability second pass — 2026-10-22

A/B: Current uncommitted worktree passes **371 Node tests, 0 failed, 0 skipped** (`npm run test:full`, ignored `artifacts/availability-second-pass-full.log`). Library and detail reads return without file checks; a separate authenticated operation checks the displayed items. Server checks reuse pending/completed per-item results within a Plex scope, while playback and queue additions retain fresh validation. Retained tests cover a held scan with catalog reads still completing, overlapping requests, scope isolation and access revocation. Chrome/Firefox fixtures hold the Plex response, verify the full listing is already rendered, then release it and confirm card identity, focus, scroll, and Cards/Posters/List unavailable states. Temporary procedure: `node artifacts/availability-second-pass-ui.cjs`; captures are ignored. No live deployment or real-server performance measurement performed.

## Missing Plex media — 2026-10-22

A/B: Current uncommitted worktree passes the full Node suite: **370 passed, 0 failed, 0 skipped** (`npm run test:full`, ignored `artifacts/unavailable-final-full.log`). Retained Plex/room tests cover checked file flags, unavailable queue filtering, rejection before subtitle preparation, a usable alternate version, raw queue rejection, missing-current restoration without a media grant, close/reopen and removal. Chrome/Firefox disposable fixtures pass Cards/Posters/List opacity and labels, disabled play/add controls, a persistent error surviving 10 seconds while muted, click dismissal without replay, removal and file recovery clearing the warning. Temporary procedure: `node artifacts/unavailable-ui.cjs`; captures are ignored. No deployment performed; human acceptance and live UI verification of this implementation remain open.

C (read-only): The owner-authorized missing-title example on the real Plex server returns `exists:false` and `accessible:false` only when its metadata is requested with `checkFiles=1`. The ordinary library listing omits these flags even with that parameter; batched metadata checks return them. No live queue or playback state was changed.

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
