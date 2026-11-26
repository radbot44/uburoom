# uburoom

Watch together, in sync. uburoom is a server you run yourself: friends join a room in their browser (or as a Discord Activity) and everyone sees the same moment of the same video, with shared pause, seek and queue. It plays from the media you already have in Plex, Jellyfin or a folder on your disk. There is no subscription and no hosted service.

**Pre-release:** Real Plex, Discord, browser/device and distribution verification is still open. See the [testing status](docs/testing.md) and [roadmap](ROADMAP.md) for evidence and release gates. A first-run setup wizard configures uburoom in the browser; an installer is still to come.

## Install

You need a computer that stays on and a media source: a Plex server, a Jellyfin server, a folder of videos, or YouTube.

**Windows (release ZIP — recommended)**

The Windows release ZIP (`uburoom-win-x64-….zip`) includes Node.js and FFmpeg — no separate install needed.

1. [Download for Windows (x64, 185 MiB)](https://github.com/radbot44/uburoom/releases/download/v0.6.1/uburoom-win-x64-0.6.1-g87f9804_20261126-204721.zip) and unzip the file.
2. Run `start-uburoom.bat` to start the server. Keep its window open.
3. The first time, the window shows a setup link. Open it and follow [first-time setup](#first-time-setup).
4. Run `doctor.bat` any time to check your configuration and media tools.

**Windows, from source**

Requires [Node.js](https://nodejs.org/) **22.13.0 or later**, plus FFmpeg for subtitles and converting video a browser cannot play.

1. Download or clone this repository.
2. Run `install-uburoom.bat` once. It installs dependencies.
3. Run `run-uburoom.bat` to start the server. Keep its window open.
4. The first time, the window shows a setup link. Open it and follow [first-time setup](#first-time-setup).

**Linux or macOS, from source**

Requires [Node.js](https://nodejs.org/) **22.13.0 or later** and FFmpeg.

```sh
npm ci
npm start
```

The first time, open the setup link it prints and follow [first-time setup](#first-time-setup).

**Docker**

Follow the [Docker guide](docs/docker.md). It mounts one `config/` folder for your settings, certificates and data, and a `secrets/` folder for the encryption key. Start it with an empty `config/` folder, run `docker logs uburoom` for the setup code, and open `https://<Docker host address>:<published port>/setup`.

## First-time setup

When uburoom starts and finds no config file, it starts **first-run setup** instead of the server. Its window shows a setup code and a local link such as `http://localhost:5756/setup#code=ABCD-…`. In Docker, open setup at the published port and enter the code from `docker logs uburoom`. A new code appears after ten wrong tries.

The wizard has six steps:

1. **Setup code.** Filled in from the link.
2. **Your account.** Sign in with Plex, or create a uburoom account. This account becomes the server operator.
3. **Media sources.** Add any number of Plex servers, Jellyfin servers, folders, and YouTube, and choose which libraries each offers.
4. **Who can get in.** Members of your Plex or Jellyfin servers, a server password, uburoom accounts, room invites, and members of your Discord servers.
5. **Where people watch.** This computer, or your home network, and the port.
6. **Check and finish.** uburoom checks the port, sources, certificate, data folder and encryption key, writes `config.yaml` (with a self-signed certificate in its `data/certs` folder) and opens uburoom with you signed in. Browsers warn about the certificate the first time; accept it once.

To add more uburoom accounts after setup, open your profile menu → **Server settings** → **Accounts** and send each person their one-time password link (or share a room invite link for guests).

Setup runs only while the config file is missing. A config that exists but has a mistake stops startup with the reason instead. To set up again, stop uburoom and move `config.yaml` away. Everything the wizard sets, and much more, can also be changed by hand: [`config.example.yaml`](config.example.yaml) lists every setting, and `doctor.bat` (or `npm run doctor`) checks a config you edited.

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
