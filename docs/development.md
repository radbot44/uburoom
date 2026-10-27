# Development

Use a local checkout, Node 22.13.0+ and the committed lockfile. Ordinary development needs no frontend build step.

## Local setup

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
node scripts/watch-demo.js --accounts
```

The certificate script refuses to overwrite an existing keypair. Demo accounts/media are disposable and do not load production credentials. Normal startup uses private YAML; see [self-hosting](self-hosting.md). Keep generated artifacts, state and secrets out of Git.

## Tests

Follow the [lean testing rules](../AGENTS.md#testing). Extend existing meaningful scenarios; do not recreate retired tests referenced in old logs.

| Need | Command |
| --- | --- |
| Focused regression | `node --test tests/<relevant-file>.test.js` |
| Installation diagnostics / doctor | `npm run doctor` / `node scripts/doctor.js` |
| Node suite | `npm test` |
| Full pass/fail/skip output | `npm run test:full` |
| Decoded video/audio baseline | `npm run test:playback` |
| Room lifecycle/permissions | `node scripts/room-ui-smoke.js --browsers=chrome,firefox` |
| Queue / Media controls | `node scripts/queue-controls-smoke.js` / `node scripts/media-controls-smoke.js` |
| Library browsing | `node scripts/plex-library-smoke.js` |
| Scheduled controls | `node scripts/sync-controls-smoke.js --browser=chrome` |
| Local WebM | `node scripts/local-webm-smoke.js --browser=chrome --codec=vp9` |

Use both Chrome and Firefox for relevant browser checks. TLS, browser binaries and FFmpeg/FFprobe may be required. Missing prerequisites or unexpected skips are not a clean pass. Fixtures establish isolated behavior, not real Plex/Activity/device support.

## Targeted media tools

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-tracks --tracks=on
node scripts/playback-tracks.js --media=artifacts/playback-media-tracks --out=artifacts/playback-track-run --browsers=firefox,chrome
```

Use `scripts/playback-recovery.js`, `scripts/sync-baseline.js`, `scripts/sync-startup.js` and `scripts/av1-probe.js` only for their corresponding investigation. `node scripts/codec-diagnostics.js` launches the isolated codec tester; it is not part of the normal server UI. `npm run build:player` rebuilds vendored player/subtitle bundles.

Read the [design guide](design-guide.md) before UI work. Record results and limitations in [testing](testing.md); historical scripts/counts are not current instructions. Real-provider tests and production changes require separate authorization.

## P1/P2/P13 live two-viewer continuity check

Run only with owner-approved test media, consenting accounts and a known installed revision. This is a **manual real-provider acceptance procedure**, not an automated smoke runner or a replacement for isolated fixture tests. Do not restart or reconfigure production, change another account's Plex state or revoke provider access as a test without separate explicit authorization.

**Record before testing:** installed commit SHA; Node/Plex versions; exact Chrome and Firefox or Discord versions and hardware-acceleration settings; separate Plex viewer account identities (use anonymized labels in published notes); host/device/network; media/container/codecs; quality and direct/proxy/local route for each viewer. Use the existing browser playback diagnostics export, a wall-clock incident log and read-only Plex transcode/process observations. Never upload URLs, tokens, cookies or personal watch history.

1. **Clean baseline (P1/P2, aim for two hours):** Open one saved room on two real viewers with the same title and known-good 720p/4Mbps delivery. Observe uninterrupted picture, dialogue, caption expectations, clock/presentation behavior, dropped frames, unexplained stream replacement, memory/process growth and individual stalls. Do not inject failures during this baseline; report each browser separately, including recording gaps.
2. **Continuity exercise (P1/P2, separate short run):** With both viewers playing, have only viewer B select a different offered quality. Verify A continues normally and B resumes at the shared position with their own tracks. Have B leave/rejoin. If testing a host departure, assign an authorized surviving host first; otherwise the documented host-presence pause is expected. Inspect read-only Plex sessions before and after the final viewer leaves; unrelated jobs must remain untouched.
3. **Queue exercise (P13):** Queue three short authorized items as distinct occurrences. Let A reach its natural end, observe one cancellable ten-second countdown and exactly one next item starting for both viewers. During the next countdown, cancel it once and confirm the queue/current item are not consumed. Resume or explicitly choose the next video under normal room permissions; confirm the final natural end clears active playback and owned resources. Do not interpret an explicit endpoint seek as watched-time credit.
4. **Retained-state exercise (P13):** Pause partway through an item, close the room using its supported UI, then reopen with authorized viewers. Confirm saved item, position and queue order, plus fresh admission/readiness rather than resurrected live streams or consent. A process restart/crash test is **not** part of this procedure without separate restart approval.
5. **Failure and cleanup (P1/P2/P13):** In an isolated test environment only, repeat a brief single-viewer connection loss while the other remains online. Check that the healthy viewer is not interrupted, the returning viewer gets a fresh authorized stream, and final departure releases only owned Plex/FFmpeg work. Avoid altering live Plex credentials, deleting media or disrupting unrelated jobs.

**Pass/fail reporting:** For each stage record A (source/code review), B (isolated regression), C (actual provider/device), D (human picture/audio acceptance) separately. Report deviations, timestamps, client-specific diagnostics, expected-versus-actual room/queue state, Plex output count and cleanup; a missing diagnostic trace is **not verified**, not a pass. Put dated, scoped outcomes and open items in [testing](testing.md), not this procedure. If the clean baseline stalls, keep that as an observed event and examine network/browser/Plex data before assigning root cause.
