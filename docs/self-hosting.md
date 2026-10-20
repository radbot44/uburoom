# Self-hosting

Each installation needs Node 22.13.0+, its own Plex access, its own Discord application and a reachable HTTPS origin. A TLS reverse proxy can forward to the single HTTPS Node server; no particular hostname/cloud service is required. Unrelated-host clean-install and backup/restore validation remain pending. There is no supported upgrade promise from private pre-release revisions to the first public release.

## Configuration

Run `npm ci`. Copy `config.example.yaml` to private `config.yaml` and supply your own values. **Never share your configuration file:** it contains Plex tokens, Discord secrets and private installation details. Do not attach it to issues, screenshots or support requests. Share only the blank example. Keep it readable only by the runtime account (Unix: `chmod 600 config.yaml`; Windows: restrict its Security permissions). Git and source packages exclude private YAML.

Start with `npm start`, or `node server/index.js --config /private/uburoom/config.yaml` (`npm start -- --config /private/uburoom/config.yaml` also works). The default file is at the project root, independent of the working directory. Relative file paths resolve from the YAML file's directory. Use absolute paths when mounting configuration separately. Use single quotes or forward slashes for Windows paths. Quote IDs and secrets; use YAML lists for channel IDs, administrator IDs and permissions. Restart after changes.

YAML is the single authority: `.env` and application environment overrides are no longer used. OS home-directory variables still locate the existing default encryption key. Unknown/duplicate keys and invalid values fail startup without printing configuration contents. Omit optional settings for defaults; use `''` for optional blank strings and `[]` for empty lists. Empty permission lists grant none; omission uses defaults.

| Setting | Purpose |
| --- | --- |
| `plex.url` / `plex.token` | Plex HTTP(S) origin and private configured server token. |
| `plex.machine_identifier` | Optional exact target; otherwise pinned after verification. |
| `discord.bot_token` | Server-only bot token; blank disables its connection. |
| `discord.client_id` / `discord.client_secret` | Your OAuth application. |
| `discord.owner_id` / `discord.guild_id` | Quoted owner and approved guild IDs. |
| `discord.command_channel_ids` | List of quoted permitted text-channel IDs. |
| `server.host` / `server.port` | Bind address/port; defaults loopback/5756. Port is an unquoted integer. |
| `server.public_url` | Exact public HTTPS origin, e.g. https://watch.example. |
| `server.tls_cert` / `server.tls_key` | PEM certificate/key accessible to the runtime account. |
| `storage.data_directory` | Persistent state directory; defaults to `data` beside the YAML file. |
| `storage.credential_key_file` | Key path outside the project; preserve the original key for existing data. |
| `tools.ffmpeg` / `tools.ffprobe` | Optional explicit executable paths for subtitles and local AV1/VP9/VP8 conversion. Blank/omitted searches the runtime user's PATH (`ffmpeg.exe`/`ffprobe.exe` on Windows, `ffmpeg`/`ffprobe` on Linux/macOS). Explicit paths override discovery; ffprobe falls back beside selected ffmpeg if absent from PATH. |
| `rooms.host_permissions` / `rooms.viewer_permissions` | Capability lists, `all` or `none`; see the annotated example for defaults and authority limits. |
| `rooms.admin_discord_ids` / `rooms.admin_plex_ids` / `rooms.admin_discord_role_ids` | Lists of exact quoted provider/role IDs allowed to enable room Admin mode. |

The credential key defaults to `%LOCALAPPDATA%/uburoom/credentials.key` on Windows, `$XDG_DATA_HOME/uburoom/credentials.key` on Linux (normally `~/.local/share/uburoom/credentials.key`), and `~/Library/Application Support/uburoom/credentials.key` on macOS. Linux ignores a relative `XDG_DATA_HOME`. An explicit `storage.credential_key_file` overrides these defaults; Docker installations should point it to a persistent private mount. No key search, relocation or migration is performed. Protect private configuration, data, TLS and external key with restrictive permissions. Linked viewers delegate Plex credentials to this server; encryption at rest does not eliminate trust in its operator.

Tool discovery uses the PATH inherited by the Node process when it starts, including under a service or inside a container. Restart after changing PATH. Discovery checks absolute PATH directories for executable files without a shell; aliases, Windows command wrappers and relative/empty PATH entries are not used. Missing tools do not prevent startup; features that need them report their unavailability. Finding FFmpeg does not prove AV1 hardware support: the existing encoder probe still applies.

### Pre-release changes to an installation

Configuration conversions and schema/data migrations use reviewed one-off scripts outside the shipped application until full release. There is no bundled converter and startup/deployment must not migrate existing state or rewrite configuration. Back up matched private configuration, data, TLS and the exact original credential key before any one-off transfer; verify the result before restarting. Unsupported state fails startup unchanged. Fresh installations use `config.example.yaml`.

### Entry and account policies

`access.discord` and `access.plex` select ordinary sign-in methods (both default true). Discord requires current membership in the configured guild; Plex verifies the account identity. Set both false for anonymous entry: each browser receives a separate 24-hour guest login with a canonical account ID and no owner/admin privileges. These are ordinary anonymous visitors, not revocable guest passes; passes remain future work. Guests can use explicitly enabled fallback media. Discord text-channel IDs are not required for a browser-only installation.

`access.require_plex: true` requires verified personal access to the configured Plex server and at least one accessible library before entry. Discord membership and fallback do not satisfy this requirement. `access.require_plex_in_activity` defaults to true; set it false to exempt verified Discord Activities from this Plex requirement. Activity sign-in still verifies Discord membership, and any entry password still applies. Browser access, including a browser opened through an Activity handoff, keeps the Plex requirement; the exception cannot be enabled with a URL parameter. Exempt Activities can use enabled media fallback, including confirmed Plex nonmembership; expired/revoked credentials and item restrictions still fail closed. It requires enabled Plex authorization and server credentials. The sign-in screen explains the requirement before login. Discord-only users retain a pending identity so Connect Plex can link the same account. Provider failures and missing/revoked credentials fail closed.

`secrets.entry_password` is an optional shared password **in addition to** all enabled provider and Plex-access requirements. Blank disables it. The password belongs at the top of the private YAML with other secrets. Entry is rate-limited, compared without a timing-dependent string comparison, and recorded through an opaque 12-hour browser grant or the authenticated Activity identity. It is never sent in a URL. A password does not grant owner rights or personal Plex access. Changing provider/admission policy invalidates stored browser logins; password grants are cleared on restart. Restart after configuration changes.

The configured `discord.owner_id` can use `/auth/owner` for owner-only OAuth recovery even when ordinary Discord sign-in is disabled. A different Discord identity is rejected. Password, required personal Plex access and Activity-only playback restrictions still apply. Configure the owner application's OAuth credentials before relying on this recovery path; a shared entry password never identifies an owner.

Set `server.public_web_app: false` for Activity-only viewing. This requires Discord authorization, application credentials, an owner ID, and a configured bot/guild for verified membership. Playback, catalog, room operations, sockets and media grants require an authenticated Activity bearer; a browser cookie or forged `frame_id` query does not grant access. The public page explains how to enter instead of exposing playback. The existing browser handoff remains available for account linking/management, with its browser claim and Activity approval; it does not turn into browser playback. When Plex access is required, Connect Plex opens that account-linking flow, then the Activity can check access again. Actual Discord SDK/proxy behavior needs live verification for the installation.

### Shared Plex fallback

`plex.fallback_enabled` defaults to **true**. This explicitly sponsors eligible viewers who have no attached Plex account, or whose authenticated Plex account is confirmed not to belong to this server when personal server access is not required. **They can access the fallback account's libraries and media, which may exceed their own account's permissions.** The example and startup warning make this sharing policy visible to the owner.

Blank `plex.fallback_token` uses `plex.token`; set it to a different account's server-access token to use a dedicated fallback identity. Keep both tokens private. A personally authorized Plex account always uses its own scope. Expired/revoked credentials, outages, identity mismatches, empty/restricted libraries and item-level denials never silently switch to fallback. Requiring personal Plex server access prevents fallback from granting admission. Setting fallback false makes media require personal Plex server access even if another method grants entry. Fallback does not attach that account to the viewer or attribute personal Plex history; Plex watch-state reporting remains separate work.

### Single shared room

`rooms.single_room` defaults false. When enabled, `rooms.single_room_name` names one persistent shared room. The app joins it automatically and hides room creation/selection. Set `rooms.single_room_leader_plex_id` to a quoted Plex account ID to choose its fixed leader explicitly. With that field blank, Discord sign-in uses `discord.owner_id`; Plex-only sign-in identifies the account belonging to `plex.token` through Plex's account API. If both methods are disabled, the configured Discord owner remains the fixed leader. Discovery identifies the token account, not necessarily the Plex server owner; a separate `plex.fallback_token` never selects leadership. Tokens that Plex cannot identify require an explicit leader ID. A failed lookup does not create a room or grant leadership to the requesting viewer, and may be retried. Leadership transfer, room deletion and ordinary closing are rejected on the server. Existing other saved rooms remain stored but unavailable in this mode.

Accounts listed in `rooms.admin_discord_ids` or `rooms.admin_plex_ids` are assigned as hosts by default. They receive creator rights only after explicitly enabling Admin mode. Ordinary hosts cannot edit permissions, assign/remove hosts or transfer leadership. The fixed creator and active admins can use **Reset room**: it stops playback, revokes consent, clears queue/history and saved progress, and restores the configured name, public visibility, permission defaults and configured hosts. The room ID, accounts, original encryption key and fixed creator are preserved. Reset waits for pending storage and rejects an active queue/media transition. The server owner can use the owner-only recovery route in anonymous installations.

### Conversion policies and limits

`transcoding.policy` defaults to `follow_plex`. uburoom reads Plex's `TranscoderCanOnlyRemuxVideo` preference through the configured server account, caching it for 30 seconds. When Plex prohibits video encoding, uburoom's AV1/VP9/VP8 conversion is prohibited too. Plex delivery may still use a confirmed copied video stream with audio conversion/remuxing; a video-transcode decision is rejected. If the preference cannot be read or recognized, conversion fails with an explanation while Original delivery remains available. This follows [Plex's distinction between video transcoding and audio/remuxing](https://support.plex.tv/articles/transcoder/).

`disabled` blocks conversion delivery paths. `override` deliberately allows uburoom conversion despite that Plex preference; it does **not** change PMS settings or bypass restrictions enforced by Plex itself. `transcoding.plex` and `transcoding.uburoom` independently enable providers, and `transcoding.formats` is an ordered list of local video codecs: `av1`, `vp9` and `vp8`. The default remains `[av1]`; use `[av1, vp9, vp8]` for alternatives or `[vp9, av1, vp8]` to prefer VP9. `[]` disables local video conversion. This selects output codecs, not allowed source formats. All three use Opus audio and the same bounded WebM chunk transport. Original playback remains preferred when compatible; when local conversion is needed, the client tries configured codecs in order, excluding explicit negative MediaSource support and codecs already failed for that video. Real decode/encoder failures can move to the next allowed codec. Positive browser support hints alone do not establish playback. Codec diagnostics stay in full Player settings, with no user-facing codec menu.

`transcoding.encoder` defaults to `auto`, with real encoder probes cached separately for each codec. For AV1 it probes QSV then NVENC; for VP9 it probes QSV. VP8 currently uses software. Explicit `qsv`/`nvenc` choices stay on that backend unless `transcoding.cpu_fallback: true` permits software. NVENC is supported for AV1 only; VP8/VP9 with NVENC require CPU fallback or an explicit software choice. QSV VP9 availability depends on the installed device/FFmpeg and is not established by AV1 support.

Software encoders are `libsvtav1` (AV1), `libvpx-vp9` (VP9) and `libvpx` (VP8). FFmpeg must include the selected encoder and Opus support. VP8/VP9 use bounded-thread realtime libvpx settings; see [FFmpeg encoder documentation](https://www.ffmpeg.org/ffmpeg-codecs.html#libvpx) and [Google's VP9 live-encoding parameters](https://developers.google.com/media/vp9/live-encoding/). All paths retain the same conversion limit. CPU fallback can follow a failed hardware probe or encoder initialization, but not cancellation, upstream errors or resource-limit failures. Plex controls its own encoding settings in PMS; device passthrough in containers remains the host's responsibility. `hardware` remains an alias for `auto`.

`transcoding.qualities` is a YAML list of `[maximum height, Mbps]` pairs, for example `[[1080, 20], [900, 5.5], [720, 2]]`. Height must be even and within 144-4320; bitrate is 0.1-200 Mbps with up to three decimal places. At most 32 unique pairs are accepted. Original is separately controlled with `transcoding.allow_original: true`; at least one choice must be offered. Defaults retain the familiar five converted qualities and Original. Custom definitions produce numerical Plex resolution/bitrate requests and local output ceilings; the Plex application's menu is not used as an allowlist. Actual custom PMS output still needs integration verification. Returned Plex output is checked against requested ceilings; configurations never promise unsupported codecs or upscale local video.

`transcoding.max_jobs` defaults to 5 (range 1-32). It counts active uburoom chunk conversions and Plex output sessions created by uburoom, including reservations during preparation. Identical viewers sharing an output share its job. Independent qualities/audio/burned subtitles may need additional jobs. Plex sessions from other applications are outside this counter. The local worker bound follows this configured maximum. New work waits up to eight seconds in a bounded queue while rechecking authorization/cancellation. It never evicts a playing output or bypasses the limit through CPU fallback.

If a selected quality is unavailable for the source, the player selects the highest lower configured quality, or the lowest offered quality when none is lower. At capacity, after the bounded wait it attempts compatible existing shared outputs in that order, preserving audio/subtitle choices and access checks. Compatible Original can avoid conversion when it is offered. A short notice identifies an automatic switch; the menu reflects the quality actually playing. With no compatible output or capacity, the player explains the condition and allows a later retry. Existing players remain untouched. Media information and expandable delivery/encoder details appear only in the full Player settings dialog.

AV1 remains the default local format. The owner's tested Windows Discord Activity with acceleration Off also decoded VP8/Opus and VP9/Opus, while H.264 failed and HEVC produced audio only. Keep at least one usable local codec if supporting that client; do not assume Plex H.264 replaces this path. See [the measured matrix](discord-codec-compatibility.md). The implemented VP8/VP9 chunk pipelines pass local Chrome/Firefox decoding, audio and seeking checks; real Discord streaming of these new output pipelines still needs verification. Browser-rendered captions remain supported independently; local conversions reject required Plex subtitle burn-in instead of silently dropping captions.

### Linux, macOS and containers

The loader is a portable Node module; PowerShell launchers are optional. Supply certificates using your platform's tooling, then run `npm ci` and `node server/index.js --config /absolute/path/config.yaml`. Native Linux/macOS and Docker runtime validation remains pending; this change does not provide a tested container image.

For containers, mount private YAML read-only and set `server.host: '0.0.0.0'`. Use absolute container paths for TLS, `storage.data_directory` (for example `/var/lib/uburoom`) and `storage.credential_key_file` (for example `/run/uburoom-private/credentials.key`, outside the application directory). Persist data and the exact credential key across replacements. The runtime creates/protects a key only for an empty installation; existing key mounts must support the runtime user's ownership/chmod. Publish the required HTTPS port and set the public HTTPS origin. Container loopback refers to the container; use a reachable Plex hostname/service. TLS is still required between a reverse proxy and Node. Secret-file references, proxy trust and a maintained Docker image are separate future features.

## Providers

In your Discord application's Developer Portal, enable Message Content Intent. Invite the bot with bot/applications.commands, View Channels, Send Messages and Read Message History; no Administrator/voice connection permission is needed. Configure `https://watch.example/auth/callback` using your own origin. Start with `npm start` and check `/health`.

For an Activity, enable Activities and map its root to the installation's origin. Activity root requests redirect to `/watch`; player/API/media routes are relative. Use your actual application settings and verify SDK authorization, proxy playback and PIP delivery live. A project marketing website is not the installation endpoint.

Configure your Plex server token privately. Linked viewers use their verified access to the pinned server; account matching alone grants no credentials/media permission. Verify restricted accounts, revocation and Original/HLS/AV1 delivery before inviting users.

## Optional Firefox remote

The optional extension is maintained and packaged in the independent uburoom-remote repository. From that checkout, prepare an isolated build for your server (the unconfigured source permits localhost only):

```powershell
node scripts/configure-remote.js --server=https://watch.example --out=releases/remote
.\scripts\package.ps1 -ExtensionDirectory releases/remote
```

Repeat `--server=` for additional explicitly permitted origins, including an existing profile's stored origin when upgrading. The first origin is the default for unpaired profiles; paired profiles keep their selection/device credential. The generator never overwrites an existing build and does not install/sign/publish it. Host permissions cover only those hosts and YouTube TV; CSP/runtime checks constrain exact origins and ports. IPv6 origins are currently unsupported.

Temporary test: use a separate Firefox profile, about:debugging → This Firefox → Load Temporary Add-on → select the generated manifest.json. The retained Gecko ID matches existing installs, so protect paired production profiles. Permanent normal Firefox distribution requires a separate signing step.

## Backups and upgrades

Devices, browser logins, account links, encrypted credentials and playback history live in `accounts.sqlite`. The current pre-release build may import old JSON files once; that import is being removed before the first public release, so private pre-release data requires an intentional owner-only backup and reset or manual transfer, not an automatic migration guarantee. Back up SQLite through its online backup mechanism or an approved maintenance stop, plus private configuration/TLS and the original external key. Until the cleanup is implemented, retain any old JSON with the matched private rollback backup, not as current runtime state. Verify integrity/authenticated decryption offline. Raw live SQLite copying is insufficient. Use an approved final stop/copy at cutover; see [upgrading](upgrading.md).

Forward WebSocket upgrades at `/watch-socket` for the watch client and `/ws` for the Firefox remote. The watch connection uses the HTTPS origin's cookie plus CSRF, or an Activity bearer sent inside the encrypted socket, never in the URL. Heartbeats detect dead connections; consent stays off after reconnect. Verify the actual Discord Activity proxy mapping separately. Discord startup/network failure is logged and retried every 30 seconds without shutting down HTTPS; current authorization still fails closed when provider access cannot be established.

Select a tested revision in a separate local code directory; install/test before attaching production state. Set an absolute `storage.data_directory` and preserve the original `storage.credential_key_file` to keep state independent of releases. Keep prior working code and matched backups. Restart only after operator approval. Compatible code rollback should retain current user data; schema/encryption changes need an explicit matched restore strategy.
