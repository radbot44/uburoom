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
