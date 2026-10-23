# Self-hosting

Self-hosting means running uburoom on a computer you control, using your own Plex server instead of a managed uburoom service. People can watch together in a browser, and you can add Discord Activity support if you want it.

**This is pre-release software.** Setup on a completely separate host, some operating systems and containers, and backup restoration still need real-world verification. See [testing status](testing.md). If you only want to try uburoom, start with the [local demo](../README.md#local-demo), which needs no Plex or Discord account.

## Before you begin

You will need:

- A computer or server to run uburoom, with [**Node.js 22.13.0 or newer**](https://nodejs.org/en/download) and npm installed.
- A Plex server you are allowed to access, including a Plex token for uburoom's connection. A *token* is a secret that lets software access an account; protect it like a password.
- An **HTTPS address** people can reach and a matching TLS certificate and private key. HTTPS encrypts the connection. uburoom needs these files even when another web server handles the public connection.
- Your own Discord application **only if** you want Discord sign-in or Discord Activity.

[FFmpeg and FFprobe](#video-conversion) are optional tools for features such as subtitle extraction and video conversion. A browser demo is not a substitute for checking your real server and devices.

## Install and start

1. Download or clone the uburoom source onto the computer that will run it. Open a terminal in the project folder (the one containing `package.json`).
2. Install the required packages:

   ```sh
   npm ci
   ```

3. Make a copy of [`config.example.yaml`](../config.example.yaml) named `config.yaml`. Keep this copy private. On Windows PowerShell, use `Copy-Item config.example.yaml config.yaml`; on Linux or macOS, use `cp config.example.yaml config.yaml`.
4. Open `config.yaml` in a text editor and fill in at least these settings:

   | Setting | What it means |
   | --- | --- |
   | `plex.url` | The address uburoom uses to reach your Plex server, such as `http://127.0.0.1:32400` if Plex runs on the same computer. |
   | `plex.token` | The private Plex account token used by uburoom. |
   | `server.public_url` | The full HTTPS address people should use to reach uburoom, including a port if needed. Do not add `/watch`. |
   | `server.tls_cert` and `server.tls_key` | Paths to your HTTPS certificate and its private key. |
   | `access.discord` | Set to `false` if you are not offering Discord sign-in. Leave it `true` only when setting up Discord. |

   The example contains the other available settings and their defaults. If Plex is on a different computer, use the Plex address reachable **from the uburoom server**, not necessarily from every viewer's browser.

5. **Review [Shared Plex fallback](#shared-plex-fallback) before inviting anyone.** By default, some eligible viewers can watch using the Plex account configured for uburoom, even if they do not have their own Plex server access. You can turn this off.
6. Start uburoom:

   ```sh
   npm start
   ```

   Open `https://your-uburoom-address/watch` in your browser, using the address and port you configured. For a basic server check, visit `https://your-uburoom-address/health`.

If the settings file is stored elsewhere, start with `node server/index.js --config /path/to/config.yaml`. This is useful when running uburoom in a container or keeping private settings outside the source folder.

**Important:** A working local page does not mean your setup is ready for outside users. Test the actual HTTPS address, Plex access and playback from a separate device before relying on it.

## Configuration

`config.yaml` is uburoom's settings file. [`config.example.yaml`](../config.example.yaml) lists every setting and the default values; you do not need to change everything. Restart uburoom after saving changes. If a setting is misspelled, duplicated or invalid, uburoom stops with an error instead of silently ignoring it.

YAML uses indentation to group settings. Keep that indentation, put IDs, secrets and Windows paths in single quotes, and use brackets for lists as shown in the example. The file is the only source of application settings: `.env` files and environment-variable overrides are not supported.

**Never publish or send anyone your `config.yaml`, Plex/Discord tokens, database, HTTPS private key or credential-encryption key.** On Linux/macOS, limit access to your server account (for example, `chmod 600 config.yaml`). On Windows, restrict permissions using the file's Security settings.

### Where uburoom listens

By default, `server.host` is `127.0.0.1` (only this computer), and `server.port` is `5756`. To make uburoom available on the internet, use your own HTTPS address and either a correctly configured reverse proxy or an appropriate network binding and firewall rules.

A *reverse proxy* is another web server that forwards incoming requests to uburoom. If you use one, it must pass WebSocket connections at `/watch-socket`, and its connection to uburoom must also use HTTPS. Set `server.public_url` to the exact public HTTPS origin (address plus optional port, no page path). Never expose private settings or keys through your web server.

## Entry and account policies

There are two separate decisions: **who can enter uburoom**, and **which Plex videos they can watch**. Signing in does not automatically grant access to every item in a Plex library.

- `access.plex` and `access.discord` enable Plex and Discord sign-in (both default to `true`). Discord sign-in checks membership in your configured Discord server. Turning both off allows temporary anonymous browser sign-ins for 24 hours, without owner/admin rights; these are not managed guest passes.
- `access.require_plex: true` requires each person to have their **own** confirmed access to your Plex server and a library before entering. A shared password or the fallback feature cannot replace that requirement. `access.require_plex_in_activity: false` can exempt verified Discord Activities, but not browser visits or handoffs.
- `secrets.entry_password` adds another password check on top of whichever sign-in rules you use. That access lasts 12 hours and is cleared by a server restart. The password does not make someone an administrator.
- `server.public_web_app: false` allows playback only through a verified Discord Activity. Browser handoff remains available for account management. Do not use this option without a working Discord setup.

Changing who is allowed in invalidates existing browser logins. If you need to recover the owner account, `/auth/owner` uses the configured Discord owner's login, provided OAuth is set up; other admission and password rules still apply. Room hosts and server administrators are separate roles.

For the full authorization model, see [accounts and access](accounts-and-access.md).

## Shared Plex fallback

**Check this setting carefully.** `plex.fallback_enabled` defaults to `true`. This means an eligible viewer without a linked Plex account, or whose lack of server membership is confirmed, may watch media using the Plex account you configured for uburoom. **They may be able to watch more than their own Plex permissions would normally allow.**

Choose the policy that fits your server:

- Set `plex.fallback_enabled: false` if every viewer should need their own media access. This does not change the separate sign-in requirements.
- Leave it on if you deliberately want to share the configured account's available media with eligible viewers.
- To limit what the shared account can reach, use a dedicated Plex account token in `plex.fallback_token`. If left blank, fallback uses `plex.token`.

Fallback never bypasses `access.require_plex: true`. An expired or revoked token, a Plex outage, an unexpected error or an item-level denial does **not** trigger fallback. Personal Plex access takes priority, and shared playback does not attach the fallback Plex account to the viewer or update their personal Plex watch history.

Direct browser-to-Plex sharing has **additional safeguards**, explained below; turning on ordinary fallback does not turn on direct fallback.

## Providers

### Plex

Use `plex.url` and `plex.token` for a Plex server and account you are authorized to use. You can optionally set `plex.machine_identifier` to lock uburoom to a particular server; when blank, it can detect and remember the server identity.

Check that a restricted Plex user can only see allowed media and that revoked access really stops working. A person's display name is never proof that they have permission to watch.

### Discord (optional)

You need your own application in the [Discord Developer Portal](https://discord.com/developers/applications).

1. Put its bot token, OAuth client ID and client secret in the `discord` settings, and set the owner and Discord server (guild) IDs.
2. Invite the bot with the `bot` scope. It does **not** need Administrator, Message Content or voice-connection permissions.
3. Set the OAuth callback to `https://your-uburoom-address/auth/callback`, using the exact HTTPS origin of your installation.
4. For Discord Activity, enable Activities and point the Activity's root to your installation origin. Verify the result in a real Discord client.

Discord bot commands have been removed; rooms are controlled through the web interface or Activity. Optional discovery of Discord members/presence requires the matching Server Members/Presence intents. See [host search and directory](account-names-and-host-directory.md). Enabling discovery only helps authorized people find accounts to assign; it does not grant access.

## Video conversion

Some videos cannot play in a browser as they are. *Conversion* (or transcoding) changes them into a compatible format. Plex or uburoom can do this, depending on what your server supports. **Most people can leave the defaults alone.**

The options are under `transcoding` in [`config.example.yaml`](../config.example.yaml):

| Setting | What it controls |
| --- | --- |
| `policy` | `follow_plex` (default) respects Plex's rules. `disabled` turns conversion off. `override` permits local conversion despite a Plex preference, but cannot bypass a restriction Plex itself enforces. |
| `plex` / `uburoom` | Whether each service can perform conversion. |
| `max_jobs` | How many conversions can run at once (5 by default, 1–32 allowed). People watching the same compatible output may share one. |
| `allow_original` / `qualities` | Whether viewers can choose the original file and which converted resolutions/bitrates are offered. |
| `formats` / `encoder` / `cpu_fallback` | Video formats, hardware/software encoding and fallback when hardware setup fails. |

**FFmpeg and FFprobe** are optional programs used for subtitle extraction and local conversion. Set `tools.ffmpeg` and `tools.ffprobe` to their paths, or leave them blank to search the server's normal program paths. Missing tools disable dependent features, not the whole server.

For manual tuning: local conversion defaults to AV1 video with Opus audio; VP9/VP8 are alternatives. Automatic encoding tries supported hardware first, then software when allowed. Quality options are height/bitrate pairs. Converted video is not upscaled, and required burned-in captions are not silently dropped. Jobs above the limit can wait briefly or share an existing compatible output; active viewers are not displaced. See [configuration defaults](../config.example.yaml) and [Discord codec compatibility](discord-codec-compatibility.md) for formats and restrictions.

## Rooms and directory

The defaults allow **5 open rooms**, **50 saved rooms**, **20 people per room** and **100 connected people** in total, including the lobby. Each room can keep 50 upcoming items and 150 history entries. People have a 60-second window to reconnect. These limits are editable under `rooms`; reaching one does not remove somebody already connected.

Saved rooms reopen paused after a restart. They resume automatically only if the room was previously playing, the expected people return in time, playback is ready and someone authorized is present. Otherwise, an authorized person starts playback.

Old closed rooms may be cleared after 180 days of inactivity when more than 10 rooms are retained. `rooms.inactive_days: 0` disables inactivity cleanup. Empty disposable rooms can disappear sooner; rooms with a keep-when-empty choice, unfinished bookmarks, queued items or auto-queueing are retained. Bookmarks do **not** prove that Plex marked a video watched. See [room and queue rules](rooms-and-queues.md) for the full behavior.

Want everyone in one shared space? Set `rooms.single_room: true`. The room is named **Room** and cannot be renamed, deleted or transferred. Its leader comes from the configured owner/leader identity, not from whoever arrives first; a failed lookup grants no leadership. Reset clears playback and queues but keeps the room, accounts and keys. Administrator powers require explicitly enabled Admin mode.

The optional host directory helps authorized users find people to assign as hosts. Discord member discovery is on by default; Plex discovery is off. Being found does **not** grant access. Settings are in the [configuration example](../config.example.yaml); details are in the [host directory guide](account-names-and-host-directory.md).

## Direct Plex delivery (advanced)

You can skip this section if the default playback works for you. With `plex.delivery: proxy` (the default), video travels through uburoom. Setting `plex.delivery: auto` lets supported browsers try a direct connection to Plex and return to the authorized proxy if needed. This does not fix unsupported video formats, and there is no direct-only mode.

Direct delivery needs `plex.client_url`: a trusted, viewer-reachable **HTTPS origin** for the same Plex server, without a path or query. Local-network viewers can use Plex's authenticated address discovery or `plex.lan_client_url`. Actual browser reachability and permissions still matter. Discord Activity, captions and some other playback paths continue through uburoom.

**Direct fallback sharing is a separate opt-in.** It requires `plex.direct_fallback_enabled: true`, normal fallback enabled and a dedicated `plex.fallback_token` verified as belonging to a **non-owner** Plex account. Owner, blank or unverified credentials are not accepted. Temporary direct-access tokens can expose that Plex account's broader library permissions, not just one movie or room. They can last up to 48 hours or until Plex restarts; revoking uburoom access may not end them immediately. Never log tokens.

See the [direct-delivery technical contract](plex-hls-delivery.md) and [Plex developer reference](https://developer.plex.tv/pms/) for URL validation, segment routing, token lifetime and timeout behavior.

## Backups and deployment

**Keep your data and encryption key together.** If you want to keep existing accounts, rooms and history, back up the database/data directory, private YAML, HTTPS certificate/key and **the exact original credential-encryption key**. Replacing that key can make saved Plex credentials unreadable. It must live outside the project folder; the default path depends on your operating system:

| System | Default key location |
| --- | --- |
| Windows | `%LOCALAPPDATA%/uburoom/credentials.key` |
| Linux | `$XDG_DATA_HOME/uburoom/credentials.key`, usually `~/.local/share/uburoom/credentials.key` |
| macOS | `~/Library/Application Support/uburoom/credentials.key` |

For a custom location, use `storage.credential_key_file`. Persistent application data defaults to `data` beside the selected YAML file; keep it outside any folder you replace during deployment. The program does not automatically move keys or import old private databases. Read [upgrading and recovery](upgrading.md) **before** replacing an existing installation; test restores on an isolated copy.

For Linux/macOS, run Node directly. For containers, mount the private YAML, data directory and external key persistently, use absolute paths inside the container, set `server.host` to `0.0.0.0`, and make sure the running user can read the files. A container's `127.0.0.1` is not your host computer. TLS is still required between a reverse proxy and uburoom. There is no maintained, verified container image yet.

### If something goes wrong

- **Page won't open:** Check the public HTTPS address, port, certificate, `server.host` and firewall. With a reverse proxy, confirm `/watch-socket` forwards WebSocket traffic.
- **Server refuses to start:** Check YAML indentation, quotes, duplicate names, missing files and the error shown in the terminal.
- **Can sign in but cannot play:** Check the account's Plex entitlement, the sharing policy and whether the browser can decode that video. A successful login alone does not prove media access.
- **Subtitles or conversion missing:** Check FFmpeg/FFprobe installation and the actual encoder capabilities.

For deeper diagnostics and safe local tests, see [development](development.md) and the [verification dashboard](testing.md). Do not start a second instance against your live credentials or data.
