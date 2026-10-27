# Self-hosting

Run uburoom alongside your Plex Media Server to host watch parties in a browser or Discord Activity. It uses your existing Plex library and accounts; Discord integration is optional. There is no managed hosting service.

**Pre-release:** Independent-host installation, some platform/container setups, restore procedures and live client/provider coverage are not fully verified. See [testing](testing.md) before treating a configuration as supported.

## Requirements

- Node.js **22.13.0+** and npm.
- A reachable Plex server and an authorized Plex token.
- An HTTPS origin and certificate/key for uburoom, including when behind a reverse proxy.
- A Discord application if using Discord login or Activity.
- FFmpeg/FFprobe for subtitle extraction and optional local transcoding.

## Install

From the project directory:

```sh
npm ci
cp config.example.yaml config.yaml
# Edit config.yaml, then verify your installation environment:
npm run doctor
# Start the server:
npm start
```

Set these values in your private `config.yaml`:

| Setting | Value |
| --- | --- |
| `plex.url` | Plex address reachable from the uburoom host (not necessarily its public URL). |
| `plex.token` | Plex access token used by the server. |
| `server.public_url` | Public HTTPS origin, with port if needed; no path. |
| `server.tls_cert` / `server.tls_key` | Certificate and key paths for uburoom's HTTPS listener. |
| `access.discord` | Set `false` for a Plex-only installation; otherwise configure Discord below. |

**Before inviting viewers, check [shared Plex fallback](#shared-plex-fallback): it is enabled by default and may give viewers media access through the configured Plex account.**

Open `https://your-origin/watch`. The health endpoint is `/health`. For a config file outside the checkout, run `node server/index.js --config /path/to/config.yaml`.

[`config.example.yaml`](../config.example.yaml) is the complete settings/default reference. Restart after config changes. Invalid, unknown or duplicate YAML keys fail startup. `config.yaml` is the only configuration authority; there are no `.env` or application environment overrides. Relative file paths resolve beside the selected YAML file.

## Network and deployment

The server defaults to `127.0.0.1:5756`. Configure `server.host`/`server.port` for your deployment and set `server.public_url` to the exact external HTTPS origin.

Reverse proxies must forward WebSocket upgrades on `/watch-socket`. The upstream connection to uburoom is also HTTPS. Supply a certificate/key for the Node listener even if the reverse proxy terminates public TLS.

For Linux/macOS, run Node directly. For containerized deployments, see [Docker guide](docker.md) for running with Docker and Docker Compose: bind `server.host: '0.0.0.0'`, use absolute paths, and persist the data directory and encryption key outside replaceable container storage. Mount private YAML with restricted access. Container loopback is not host loopback.

Do not start a second instance using your live credentials or database. Check sign-in and actual playback from an external device, not just `/health`.

## Sign-in and access

Sign-in, permission to enter uburoom, Plex media access, and server administration are separate checks.

| Setting | Behavior |
| --- | --- |
| `access.plex` / `access.discord` | Enable Plex and/or Discord login; both default to `true`. Discord login checks membership in the configured guild. |
| `access.require_plex: true` | Require each viewer's own access to the pinned Plex server and a library. Neither a password nor shared fallback satisfies this. |
| `access.require_plex_in_activity: false` | Exempt **verified Discord Activities** from the personal-Plex entry requirement, not web visits or browser handoff. |
| `secrets.entry_password` | Optional extra entry password alongside provider rules. Access lasts 12 hours and resets on restart; it does not grant admin access. |
| `server.public_web_app: false` | Restrict playback to verified Discord Activity. Browser handoff remains available for account linking/management. |
| `operator.discord_id` / `operator.plex_id` | Exact quoted provider account IDs authorized to open **Server settings** in the browser (the 19-key allowlist across Rooms, Directory and Transcoding). Saved edits write to `config.yaml` and require a manual restart to take effect. |

With both sign-in methods off, uburoom allows separate 24-hour anonymous browser logins without owner/admin rights; these are not managed guest passes. Admission changes invalidate existing browser logins. `/auth/owner` supports the configured Discord owner's OAuth recovery, subject to the remaining admission rules.

See [accounts and access](accounts-and-access.md) for the authorization model.

## Shared Plex fallback

`plex.fallback_enabled` is **true by default**. An eligible viewer without a linked Plex account, or with confirmed lack of server membership, can use a fallback account's media access. **That may expose libraries or items beyond the viewer's personal Plex permissions.**

- Set `plex.fallback_enabled: false` to require personal media entitlement.
- Leave it enabled only if you intend to share the fallback account's scope.
- Set `plex.fallback_token` to a dedicated, restricted Plex account token to limit that scope. If blank, uburoom uses `plex.token`.

Fallback does not bypass `access.require_plex: true`. Revoked/expired credentials, Plex errors or outages, and item-level restrictions fail closed. Personal entitlement takes priority. Shared access does not link the fallback identity to the viewer or write their personal Plex history.

**Direct fallback** is a separate opt-in with stricter requirements; see [direct Plex delivery](#direct-plex-delivery).

## Plex delivery, reporting and transcoding

### Delivery

`plex.delivery: proxy` (default) sends Plex media through uburoom. `plex.delivery: auto` attempts direct Original/HLS delivery in supported browsers, with authorized proxy recovery when direct delivery fails.

For `auto`, configure `plex.client_url` as a trusted, viewer-reachable HTTPS origin belonging to your selected Plex server (no path/query). LAN clients use authenticated origin discovery or `plex.lan_client_url`. Browser reachability, CORS, range handling and decoding support still apply. Discord Activity, native-HLS-only clients, captions and local conversions retain their respective proxy/conversion paths; there is no direct-only mode.

**Direct fallback** needs all three: `plex.fallback_enabled: true`, `plex.direct_fallback_enabled: true` and a dedicated `plex.fallback_token` verified as a **non-owner** Plex account. Blank, owner, ambiguous or unverifiable fallback credentials are rejected for direct delegation. Temporary Plex tokens are not restricted to the current movie or room; they can remain valid for up to 48 hours or until PMS restart, and revoking uburoom access may not revoke them immediately. Keep all tokens out of logs and persistent client storage.

Technical details, failure budgets and provider boundaries: [Plex delivery](plex-hls-delivery.md) and [Plex developer reference](https://developer.plex.tv/pms/).

### Reporting

`plex.reporting_enabled: true` (default) reports active playback sessions to Plex for viewers with verified personal Plex credentials using a decoupled viewer session ID so individual viewer departures never stop shared HLS transcodes. Connected Plex accounts default to activity-only reporting (omitting timeline duration so playback appears in Now Playing without mutating personal resume offsets or watch history). `plex.reporting_watch_state: true` (default) allows viewers with connected Plex accounts to explicitly opt in to personal watch-state synchronization in player settings. Sponsored and guest viewers without personal Plex credentials remain local-only and never report to Plex.

### Transcoding

The `transcoding` section controls Plex conversion and uburoom's local encoder independently:

| Setting | Behavior |
| --- | --- |
| `policy` | `follow_plex` (default) respects Plex restrictions. `disabled` turns conversion off. `override` permits local conversion despite the Plex preference, but cannot bypass PMS-enforced restrictions. |
| `plex` / `uburoom` | Enable either conversion provider. |
| `formats` | Local codec preference, default `[av1]`; VP9/VP8 are alternatives and all use Opus audio. Empty disables local conversion. |
| `encoder` / `cpu_fallback` | Automatic hardware-first probing (supported QSV/NVENC paths), explicit backend selection and optional CPU fallback for hardware setup failures. |
| `max_jobs` | Shared Plex/local job limit: default 5, allowed 1–32. Compatible consumers may share one output. |
| `qualities` / `allow_original` | Ordered height/Mbps pairs and separate Original option. Conversion does not upscale. |

FFmpeg and FFprobe are found on the service user's PATH or at `tools.ffmpeg`/`tools.ffprobe`. Missing tools disable the features that depend on them. Software conversion needs the corresponding AV1/VP9/VP8 encoders and Opus; capability detection is not proof of successful playback.

At capacity, a conversion may wait briefly or reuse an existing compatible output. uburoom will not evict viewers or exceed its job limit; conversions started by other Plex applications are outside that counter. See [codec compatibility](discord-codec-compatibility.md).

## Discord (optional)

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and fill in `discord.bot_token`, `client_id`, `client_secret`, `owner_id` and `guild_id`.

- Invite the bot with the `bot` scope. Administrator, Message Content and voice-connection permissions are not required.
- Set OAuth callback to `https://your-origin/auth/callback`.
- For Activity, enable Activities, map the root to the uburoom HTTPS origin and verify it in a real Discord client.
- Bot commands are no longer supported; rooms are controlled in the browser or Activity.

Optional host-directory discovery can use Discord Server Members/Presence intents. `directory.expose_discord_members` defaults to `true`, and `directory.expose_plex_members` defaults to `false`. Directory results are not invitations or access grants. See [host directory](account-names-and-host-directory.md).

## Rooms and retention

Defaults in `rooms`: **50 saved rooms**, **5 open**, **20 members per room**, **100 connected people** (including lobby), **50 upcoming queue items**, **150 history items**, and a **60-second reconnect window**. A full room/capacity limit rejects new additions rather than evicting existing viewers.

Persistent rooms reopen paused after a restart. Auto-resume requires previous play intent, the expected viewers returning inside the recovery window, fresh readiness and an authorized controller. Otherwise someone with permission starts playback.

Closed inactive rooms are cleaned up after 180 days while more than 10 rooms are retained (`inactive_days: 0` disables inactivity cleanup). Empty disposable rooms may be removed earlier; keep-when-empty, an unfinished bookmark, queued items and auto-queueing can retain a room. Queue/history retention does not imply a Plex watched-state update.

`rooms.single_room: true` uses one fixed room called **Room**, with no regular create/rename/delete/transfer flow. Its leader follows the configured Plex/Discord owner policy. Reset clears playback, queue and history but retains room/account/key identity. Admin privileges require explicit Admin mode; host permission alone is not server administration.

See [rooms and queues](rooms-and-queues.md) for detailed recovery, cleanup and permissions behavior.

## Backups and upgrades

Back up the SQLite data, private `config.yaml`, TLS files and the **exact original credential-encryption key** as a matched set. Never replace the key for an existing installation; doing so makes encrypted Plex credentials unreadable.

`storage.data_directory` defaults to `data` beside the selected YAML file. The credential key must be outside the project directory; `storage.credential_key_file` selects a custom location. Platform defaults are:

| OS | Credential key path |
| --- | --- |
| Windows | `%LOCALAPPDATA%/uburoom/credentials.key` |
| Linux | `$XDG_DATA_HOME/uburoom/credentials.key` (normally `~/.local/share/uburoom/credentials.key`) |
| macOS | `~/Library/Application Support/uburoom/credentials.key` |

Keep data and keys out of replaceable code/container directories. Private pre-release databases have no automatic migration/import path; do not reset state or generate a new key just to bypass a schema error. Follow [upgrading and rollback](upgrading.md) before replacing an installation, and verify a restore on an isolated copy.

Restrict access to `config.yaml`, tokens, databases, TLS keys and credential keys. Never commit or share them.

## Troubleshooting

- **Startup/config errors:** Check the YAML key names, duplicates, paths and startup output. Configuration is validated before opening state or contacting providers.
- **HTTPS/WebSocket failures:** Check `server.public_url`, certificates, bind address and proxy forwarding of `/watch-socket`.
- **Login works, playback fails:** Separate admission, Plex media entitlement, delivery reachability and browser codec support when diagnosing.
- **Transcoding/subtitles unavailable:** Check the selected FFmpeg/FFprobe binaries, encoders and actual decode behavior.

See [development](development.md) for isolated checks and [testing](testing.md) for verified configurations and open release gates.
