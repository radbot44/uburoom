# uburoom

Self-hosted Plex watch parties with a web interface and Discord integration.

Run your own server, connect your own Plex and Discord applications, and watch together in a browser or Discord Activity. The main site enters `/watch`. The optional YouTube TV remote is maintained separately in uburoom-remote and connects through the versioned authenticated protocol. Remaining verification is tracked in [Milestone 1](ROADMAP.md#m1--verified-self-hosted-release); native-player integration remains future work.

This source is undergoing release preparation. The approved wordmark and oo icons are integrated; the remaining asset-provenance and integration checks are pending. No managed room-hosting service is included.

## Local demonstration

Requires Node **22.13.0+** and npm. The demo uses synthetic media and simulated providers without Plex or Discord credentials.

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
npm test
node scripts/watch-demo.js --accounts
```

Open `https://localhost:6768/watch?demo=host`. Inspect/accept the localhost certificate exception, create a room and choose Libraries → Other → Synchronization video. Open `https://localhost:6768/watch?demo=guest` in a second browser/profile to join. Check shared play/pause/seek, private-room revocation and logout. Ctrl+C stops this demo; accounts are temporary. Keep production configuration out of the demo checkout.

See [self-hosting](docs/self-hosting.md) for your own server and [development](docs/development.md) for isolated checks.

Server settings live in private `config.yaml`; copy the annotated `config.example.yaml` or run `npm run config:migrate` for an existing `.env`. **Never share your config file:** it contains secrets and API tokens. Use `node server/index.js --config /private/config.yaml` for external/container configuration. Keep persistent data and the original encryption key when replacing an installation.

## Features and limits

- Shared playback, readiness/late-join synchronization, host succession, public/private rooms and independent remote permissions.
- Plex browsing and linked Plex/Discord accounts; personal volume, quality and media-access checks.
- Discord Activity and browser handoff, plus bot commands through the shared validated command engine.
- Integration with the separate Firefox YouTube TV remote for local zoom/stretch/pan and profiles, with optional explicitly enabled remote control.
- Native per-viewer observations and persisted playback history, retained for planned Plex resume/watched-state updates across clients and servers; Plex reporting is not enabled yet. Queueing and durable room restoration are later work.

See the [roadmap](ROADMAP.md) for priorities, milestones and release gates. Playback development prioritizes smooth automatic delivery in browsers and Discord Activity, with complete video/audio/subtitle coverage; the [playback reliability plan](docs/playback-reliability.md) contains the detailed requirements.

The player includes personal audio/subtitle selection, external SRT/WebVTT captions and Plex burn-in requests for styled or embedded subtitles. Live Plex and Discord coverage remains under verification; see [testing status](docs/testing.md).

Discord commands are `/ubu` and `!ubu`; there are no previous-name aliases. Fixtures do not establish compatibility with every Plex server, Discord client or YouTube TV player. See [remaining verification](docs/testing.md). Preserve account data and the original encryption key when retaining existing state; private pre-release migration support will be removed before the first public release. See [upgrading](docs/upgrading.md).

## License and attribution

uburoom's original source code is licensed under **GPL-3.0-only**: GNU General Public License version 3 only. See [LICENSE](LICENSE). It comes without warranty, as described in that license.

Third-party code retains its own licenses and [bundled notices](web/vendor/THIRD_PARTY_NOTICES.txt); it is not relicensed by this declaration. See [attribution and remaining review](docs/third-party.md). Artwork and media provenance need final review before public distribution.
