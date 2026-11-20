# uburoom

Watch together, in sync. uburoom is a server you run yourself: friends join a room in their browser (or as a Discord Activity) and everyone sees the same moment of the same video, with shared pause, seek and queue. It plays from the media you already have in Plex, Jellyfin or a folder on your disk. There is no subscription and no hosted service.

**Pre-release:** Real Plex, Discord, browser/device and distribution verification is still open. See the [testing status](docs/testing.md) and [roadmap](ROADMAP.md) for evidence and release gates. Easier setup (a first-run wizard and installer) is in progress; until then, installation means editing a config file.

## Install

You need a computer that stays on, [Node.js](https://nodejs.org/) **22.13.0 or later**, and a media source: a Plex server (and its token), a Jellyfin server (and an API key) or a folder of videos. FFmpeg is needed for subtitles and for converting video a browser cannot play.

**Windows, from source**

1. Download or clone this repository.
2. Run `install-uburoom.bat` once. It installs dependencies.
3. Finish [first-time setup](#first-time-setup) below.
4. Run `run-uburoom.bat` to start the server. Keep its window open.

**Linux or macOS, from source**

```sh
npm ci
npm start
```

Do this after first-time setup.

**Docker**

Follow the [Docker guide](docs/docker.md). It mounts one `config/` folder for your settings, certificates and data, and a `secrets/` folder for the encryption key.

## First-time setup

1. Copy [`config.example.yaml`](config.example.yaml) to `config.yaml` (in Docker, `config/config.yaml`). Keep it private.
2. Connect a media source in `config.yaml`: `plex` (URL and token), `jellyfin` (URL and API key) or `local_media` (folders). See [self-hosting](docs/self-hosting.md) for each.
3. Set `server.public_url` to the HTTPS address people will use, and give uburoom a certificate and key (`server.tls_cert`, `server.tls_key`). uburoom always serves HTTPS. For a quick test on your own computer, [development](docs/development.md) shows how to make a local certificate.
4. Run `npm run doctor`. It checks your configuration, tools and storage and tells you what to fix.
5. Start uburoom and open `https://<your address>/watch`. Check sign-in and playback from another device, not just your own computer.

To invite people from outside your home network, you need a public HTTPS address. [Self-hosting](docs/self-hosting.md#network-and-deployment) covers reverse proxies and trusted proxies.

> [!WARNING]
> Never commit or share configuration, tokens, databases or encryption keys. Preserve the **original encryption key** when restoring or moving existing state; see [upgrading](docs/upgrading.md).

## What you get

- Rooms where everyone watches in sync. Late joiners catch up. Rooms can be public or private, with host permissions and a shared queue that can last between sessions.
- Plex, Jellyfin and local folders, browsed from one library view. uburoom converts video a browser cannot play. Everyone you let in can watch every library.
- Sign in with Plex or Discord, or invite guests to a room. Each viewer chooses their own volume, quality, audio and subtitles without affecting the room.
- Use it in a browser, or as an Activity inside a Discord voice channel. Optionally post rooms and watch nights to Discord.
- Each person's watch history and, if they opt in, their own Plex watch state.

## Documentation

- [Self-hosting](docs/self-hosting.md): configuration, access, Discord, backups, troubleshooting.
- [Docker](docs/docker.md) and [upgrading](docs/upgrading.md).
- [Accounts and access](docs/accounts-and-access.md) and [rooms and queues](docs/rooms-and-queues.md).
- [Product spec](SPEC.md), [roadmap](ROADMAP.md) and [testing status](docs/testing.md).

Developers: build, tests and a local demo with disposable accounts and synthetic media are in [development](docs/development.md#local-demo).

## License

Original source code is **GPL-3.0-only**; see [LICENSE](LICENSE). Third-party components retain their own licenses and [notices](web/vendor/THIRD_PARTY_NOTICES.txt). First-party branding artwork is dual-licensed under **GPL-3.0-only OR CC-BY-4.0** and `Uburoom Sans` is licensed under **SIL OFL-1.1** ([OFL.txt](web/assets/fonts/OFL.txt)), with trademark terms in [docs/third-party.md](docs/third-party.md).
