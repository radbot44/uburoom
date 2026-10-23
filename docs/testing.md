# Verification dashboard — M1

**Release status: open.** Results below belong to their recorded revisions/scenarios; they do not combine into a current-HEAD pass. This documentation cleanup ran no runtime tests. [Release gates](../ROADMAP.md#m1--verified-self-hosted-release) · [Historical evidence digest](archive/testing-2026-10-22.md) · [Commands](development.md#tests).

## Verification standard for new work

| Method | Evidence | Limit |
| --- | --- | --- |
| A — Review | Source/contracts/rendered inspection | Not execution |
| B — Automated | Isolated fixtures, browser pixels/PCM, fault tests | Not real provider/device acceptance |
| C — Integration | Actual named provider/device/network/hardware | Only the measured configuration |
| D — Human | Recorded perceptual/usability acceptance | Not numerical/security proof |

Record date/revision, scope/environment, command/procedure, actual outcome and failures/skips, remaining methods and sanitized evidence. Label each required method pass/fail/blocked/not run. API success, capability hints and advancing clocks are not decoded playback, persisted history or physical synchronization. Unexpected skips invalidate a full-suite pass. C and production/history changes require explicit authorization.

## Latest scoped evidence — 2026-10-22

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
| AV1 ending | Live ~42ms final-buffer gap; automated end-of-stream fix exists, C retest open |
| Real soak | First run unloaded/recovered; repeat run clean, original trigger unresolved |
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
| P4 reporting | A/B/C | Product absent; shared-producer lifecycle, external AV1 telemetry, personal-state/concurrency/sponsorship |
| P5/P6 sync/pacing | B/C/D | Physical/WAN ≤50ms p95 / ≤100ms p99, supported-policy disposition and joint smoothness acceptance |
| P7 UI | A/B/C/D | Broader journeys, physical mobile/Activity/accessibility and owner acceptance |
| P9 subtitles | B/C/D; A licensing | Real authored fonts/content, lifecycle/resources and corresponding-source review |
| P10 terminology | A; B/C where affected | Final current web/Activity sweep; canonical protocol has historical local evidence |
| P11 architecture | A/B/C | Real proxy/resources and operator backup/restore/rollback |
| P12 telemetry | A/B/C/D | Repeat actual-device score/confidence and readability; richer features remain future scope |
| P13 rooms/queues | B/C/D | Real multi-viewer continuation, recovery, writer/load and UX |
| P14 access/admin | A/B/C/D | Admin/security implementation, real admission/revocation/handoff and operator recovery |

P5/P6 human check: watch together ~3 minutes, pause/resume/seek, background one tab ~10 seconds and return. Technical timing remains separate. Design authorization is not visual acceptance; neither permits deployment.

## Maintenance

Update the affected result/gate only. Keep commands in development, requirements in owning plans, and detailed sanitized investigations in dated evidence. Do not append UI specifications, repeat suite histories, restore retired runners or turn old results into current green status.
