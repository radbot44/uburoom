# uburoom

Self-hosted Plex watch parties in a browser or Discord Activity. No managed hosting service is included.

**Pre-release:** Real Plex, Discord, browser/device and distribution verification is still open. See the [testing status](docs/testing.md) and [roadmap](ROADMAP.md) for evidence and release gates.

## Local demo

Requires Node **22.13.0+** and npm. In PowerShell:

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
node scripts/watch-demo.js --accounts
```

Open `https://localhost:6768/watch?demo=host` and `https://localhost:6768/watch?demo=guest` in separate browsers or profiles. Accept the local development certificate exception, create or join a room, and try shared playback controls. The demo uses disposable accounts and synthetic media, with no Plex or Discord credentials. See [development](docs/development.md) for test commands.

## Capabilities and limits

- Shared playback, late-join synchronization, public/private rooms, host permissions and persistent rooms/queues.
- Plex browsing and media-access checks, linked Plex/Discord accounts, browser/Activity handoff and personal volume, quality and track choices.
- Native per-viewer playback observations and history, plus decoupled Plex session reporting (activity-only by default for connected Plex accounts, with explicit per-viewer opt-in for personal watch-state sync and local-only isolation for sponsored viewers).

## Self-hosting

Follow the [self-hosting guide](docs/self-hosting.md) (or the [Docker guide](docs/docker.md)) to configure Plex, HTTPS and optional Discord integration. Copy [`config.example.yaml`](config.example.yaml) to a **private** `config.yaml`, supply your settings, verify with `npm run doctor`, then run `npm start` or `node server/index.js --config /path/to/config.yaml`.

Never commit or share configuration, tokens, databases or encryption keys. Preserve the **original encryption key** when restoring existing state; see [upgrading](docs/upgrading.md). Shared Plex fallback is enabled by default and can expand eligible viewers' media access; review its [access implications](docs/self-hosting.md#shared-plex-fallback).

## License

Original source code is **GPL-3.0-only**; see [LICENSE](LICENSE). Third-party components retain their own licenses and [notices](web/vendor/THIRD_PARTY_NOTICES.txt). First-party branding artwork is dual-licensed under **GPL-3.0-only OR CC-BY-4.0** with trademark terms in [docs/third-party.md](docs/third-party.md).
