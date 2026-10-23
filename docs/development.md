# Development

Use a local-disk checkout, **Node 22.13.0+** and the committed lockfile. This project uses plain JavaScript, Node's built-in test runner and no frontend build step for everyday work.

## Local setup

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
node scripts/watch-demo.js --accounts
```

The development certificate generator refuses to overwrite an existing keypair. Synthetic `--accounts` mode uses disposable identities and fixtures; it does not load private credentials or contact live Plex/Discord. Normal `npm start` uses `config.yaml` (or `--config <path>`). Keep all secrets, databases, certs, user data and local artifacts out of git. No `.env` or application environment override is supported.

## How to verify changes without growing a test empire

Follow [AGENTS.md](../AGENTS.md#testing--lean-risk-based-and-deliberately-finite): **the default is no new permanent test**. Review the affected code first. For an important behavioral invariant, extend an existing test instead of writing a feature-specific suite. Run focused checks while developing; only use the full suite when broader confidence is justified.

```powershell
node --test tests/installation-policy.test.js
node --test tests/durable-rooms.test.js
npm test
npm run test:full
```

The latter two run the same remaining Node suites; full TAP exposes skips. They are not mandatory for minor design-text or documentation changes. Do not assert a clean run if certificates are absent or a test skipped unexpectedly. The historical 461-test record predates test pruning and must not be presented as today's count.

### Retained browser smoke checks

There are **six** distinct smoke scripts, run only when the associated flow changes:

| Boundary | Invocation |
| --- | --- |
| Room creation, permissions and state | `node scripts/room-ui-smoke.js --browsers=chrome,firefox` |
| Queue controls | `node scripts/queue-controls-smoke.js` |
| Media controls | `node scripts/media-controls-smoke.js` |
| Plex library browsing | `node scripts/plex-library-smoke.js` |
| Scheduled sync controls | `node scripts/sync-controls-smoke.js --browser=chrome` (then Firefox when relevant) |
| VP8/VP9 local streaming | `node scripts/local-webm-smoke.js --browser=chrome --codec=vp9` (adapt browser/codec as needed) |

These use local TLS, disposable browsers, simulated providers and outputs under ignored `artifacts/`. They do not authorize real accounts or prove actual provider/device fidelity. Retired `*-smoke.js` script names found in old plans and archived logs are **not** a backlog to recreate. Chrome and Firefox are equal targets for relevant web behavior; native mobile, Discord Activity and real Plex are separate integration gates.

## Actual decoded playback and targeted probes

For changes to the player, use the existing decoded-video/audio baseline rather than creating a seventh smoke runner:

```powershell
npm run test:playback
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-tracks --tracks=on
node scripts/playback-tracks.js --media=artifacts/playback-media-tracks --out=artifacts/playback-track-run --browsers=firefox,chrome
```

The baseline checks displayed pixels, decoded PCM tone, cadence, buffering, playback position and pause/seek/resume across synthetic codecs. Browser binaries and FFmpeg/FFprobe are required. Fixture providers do not establish real PMS output, GPU support or physical A/V synchronization. Use existing `scripts/playback-recovery.js`, `scripts/sync-baseline.js`, `scripts/sync-startup.js` and `scripts/av1-probe.js` only for the corresponding specialized investigation; these are opt-in tools, not a required battery.

`node scripts/codec-diagnostics.js` serves the existing isolated codec tester. `npm run build:player` is only needed when changing the vendored player/subtitle bundles.

## Owner design review and integrations

**Any UI/design decisions belong to the owner.** Read the entire [design guide](design-guide.md) before UI investigation or edits. Obtain explicit decisions for unresolved design choices before implementing them, and verify approved visual changes in the actual rendered surfaces. Screenshots and automated smokes are not visual sign-off.


Room control uses the validated shared engine, socket operations and explicit room IDs. Never bypass room permission checks or treat stored room state as active playback authority. See [rooms and queues](rooms-and-queues.md) and the [verification dashboard](testing.md) for current gates. Do not restart live services, load private providers or deploy without separate authorization.

The [testing archive](archive/testing-2026-10-22.md) preserves older detailed test procedures, including retired runners and documented failures. Historical evidence is not current green status.
