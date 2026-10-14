# uburoom

Self-hosted Plex watch parties with a web interface and Discord integration.

Run your own server, connect your own Plex and Discord applications, and watch together in a browser or Discord Activity. The same server supports the included Firefox YouTube TV picture-control remote. An independent remote and native-player integration are future milestones.

This source is undergoing release preparation. Replacement graphics and the full license/asset audit are pending. No managed room-hosting service is included.

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

## Features and limits

- Shared playback, readiness/late-join synchronization, host succession, public/private rooms and independent remote permissions.
- Plex browsing and linked Plex/Discord accounts; personal volume, quality and media-access checks.
- Discord Activity and browser handoff, plus bot commands through the shared validated command engine.
- Firefox local zoom/stretch/pan and profiles, with optional explicitly enabled remote control.
- Native per-viewer observations; Plex timeline/watch-state reporting is not enabled.

Fixtures do not establish compatibility with every Plex server, Discord client or YouTube TV player. See [remaining verification](docs/testing.md). Preserve account data and the original encryption key on upgrades; see [compatibility](docs/compatibility.md).

## License and attribution

uburoom's original source code is licensed under **GPL-3.0-only**: GNU General Public License version 3 only. See [LICENSE](LICENSE). It comes without warranty, as described in that license.

Third-party code retains its own licenses and [bundled notices](web/vendor/THIRD_PARTY_NOTICES.txt); it is not relicensed by this declaration. See [attribution and remaining review](docs/third-party.md). Artwork and media provenance need final review before public distribution.
