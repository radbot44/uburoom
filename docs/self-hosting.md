# Self-hosting

Self-hosting means running uburoom on a computer you control, using your own Plex server instead of a managed uburoom service. People can watch together in a browser, and you can add Discord Activity support if you want it.

**This is pre-release software.** Setup on a completely separate host, some operating systems and containers, and backup restoration still need real-world verification. See [testing status](testing.md). If you only want to try uburoom, start with the [local demo](../README.md#local-demo), which needs no Plex or Discord account.

## Before you begin

You will need:

- A computer or server to run uburoom, with **Node.js 22.13.0 or newer** and npm installed.
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

Some videos play directly in the viewer's browser. Others need *conversion* (also called transcoding) to a format the browser supports. Plex and uburoom can both do this, depending on your settings and available tools.

You can leave the defaults alone to start. Advanced options are in the `transcoding` section of the [example configuration](../config.example.yaml):

| Setting | In plain English |
| --- | --- |
| `policy: follow_plex` | Default. Respect Plex's rules about whether video may be converted; unknown or unavailable permission blocks conversion, but may still allow Original playback. |
| `policy: disabled` / `override` | Disable conversion, or deliberately allow uburoom conversion despite a Plex preference. Override cannot bypass restrictions that Plex itself enforces. |
| `plex` / `uburoom` | Turn the two conversion options on or off separately. |
| `max_jobs` | Maximum simultaneous conversion jobs (default 5, allowed 1–32). Viewers using the same suitable output can share a job. |
| `allow_original` / `qualities` | Choose whether to offer the original file and which converted quality options to show. |
| `formats` / `encoder` / `cpu_fallback` | Choose output formats, hardware or software encoding, and whether software may take over when hardware setup fails. |

FFmpeg and FFprobe are separate tools used for subtitle extraction and optional conversion. Set `tools.ffmpeg` and `tools.ffprobe` to their executable paths, or leave them blank so uburoom looks in the server's normal executable search paths. Missing tools disable dependent features, not the whole server. Installing a video encoder does not guarantee it works until tested.

More advanced details: local formats default to `[av1]` (VP9/VP8 are optional), audio uses Opus, and an empty formats list disables local output. Automatic encoding tries supported Intel QSV/NVIDIA NVENC before software where applicable. Software encoding needs the matching FFmpeg codec libraries. Quality pairs are `[video height, Mbps]`: height must be even (144–4320), bitrate 0.1–200, up to 32 distinct pairs. Original is controlled separately, and at least one quality option must remain. Conversion never upscales or silently removes required burned-in subtitles.

When the server is busy, new conversion can wait up to eight seconds; uburoom may reuse a compatible output instead. It does not eject an active viewer or exceed its configured job count. Other applications' Plex jobs are not included. See [Discord codec compatibility](discord-codec-compatibility.md).

## Rooms and directory

The defaults allow **5 open rooms**, **50 saved rooms**, **20 members per room**, and **100 connected people** across rooms and the lobby. Each room can hold 50 upcoming queue items and 150 history items. A reconnect has a 60-second recovery window. If a limit is reached, uburoom rejects new additions rather than removing current members. You can change these limits under `rooms`.

Saved rooms can reopen after a restart, but playback returns paused. Automatic resuming is only considered when the room was playing, the expected people return in time, playback is ready and an authorized controller is present. Otherwise, someone with permission must start playback.

Closed rooms can be cleaned up after 180 days of inactivity when more than 10 are retained; `rooms.inactive_days: 0` turns off inactivity cleanup. Empty disposable rooms may be removed sooner. A room is kept when configured to stay open, when there is an unfinished bookmark below 90%, upcoming items or automatic queueing. A bookmark percentage is **not** evidence that Plex marked something watched. Queue/history trimming preserves generation progress; the explicit reset action clears that progress.

Set `rooms.single_room: true` if you want one shared room instead of letting people create their own. It is always named **Room** and cannot be renamed, deleted, transferred or ordinarily closed. Its leader comes from the configured Plex leader ID, or the appropriate configured Discord/Plex owner identity; failed account lookup never grants leadership. Reset clears playback, queue and history while keeping the room, accounts and keys. Server administrators must explicitly enable Admin mode before using those privileges.

Host/viewer controls, room limits, administrator IDs and directory settings are all in [`config.example.yaml`](../config.example.yaml). The member directory shows eligible search results; by default Discord member discovery is on and Plex member discovery is off. Being listed does not grant room or media access. See [room rules](rooms-and-queues.md) and [host search](account-names-and-host-directory.md).

## Direct Plex delivery (advanced)

You can skip this section if your videos work well with the default settings.

By default, `plex.delivery: proxy` means uburoom sends Plex media to the browser. Setting `plex.delivery: auto` lets supported browsers try to fetch Original files or HLS video directly from Plex, falling back to uburoom's authorized proxy when needed. There is no direct-only setting, and direct access will not fix a codec the browser cannot decode.

- `plex.client_url` must be a trusted HTTPS address that viewers can reach for the selected Plex server. Use only the origin (no page path, query, login details or fragment).
- Local-network viewers can use Plex's authenticated address discovery or an explicit `plex.lan_client_url`. Browsers still need to be able to reach the address and pass cross-origin/range checks.
- Direct HLS sends the initial small playlist through uburoom but sends video and audio segments from Plex to the browser. Eligible viewers can share a conversion output while holding separate temporary credentials.
- Discord Activity, browsers needing native HLS, captions and local conversions can still use other delivery paths. Original quality can require conversion.
- Sharing **directly** from a fallback Plex account requires `plex.direct_fallback_enabled: true`, regular fallback enabled, and a separate `plex.fallback_token` verified by plex.tv as belonging to a **non-owner** account. A blank, owner or unverified token is not allowed.
- Temporary direct-access tokens carry the Plex source account's permissions; they are **not limited to one room or movie**. Plex documents a lifetime of up to 48 hours or until its server restarts. Removing uburoom access cannot guarantee that an already issued token immediately stops working.

Keep permanent and temporary credentials out of logs. Direct connection negotiation has a five-second budget; HLS playlist requests use five seconds to first byte and eight seconds total, with no internal retry. Any later proxy setup or conversion wait is separate.

For protocol details and security boundaries, see the [Plex delivery contract](plex-hls-delivery.md) and [Plex's developer documentation](https://developer.plex.tv/pms/).

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
