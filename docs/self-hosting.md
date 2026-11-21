# Self-hosting

Run uburoom alongside your Plex Media Server to host watch parties in a browser or Discord Activity. It uses your existing Plex library and accounts; Discord integration is optional. There is no managed hosting service.

**Pre-release:** Independent-host installation, some platform/container setups, restore procedures and live client/provider coverage are not fully verified. See [testing](testing.md) before treating a configuration as supported.

## Requirements

- Node.js **22.13.0+** and npm.
- A reachable Plex server and an authorized Plex token.
- An HTTPS origin, and a certificate/key for uburoom unless a trusted proxy or tunnel serves HTTPS in front of it (`server.listen: 'http-proxy'`).
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
| `sources` | One entry per media source: Plex, Jellyfin or folders on this machine; see [media sources](#media-sources). |
| `server.public_url` | Public HTTPS origin, with port if needed; no path. |
| `server.listen` | `https` (default): uburoom serves HTTPS itself. `http-proxy`: plain HTTP for the proxies in `server.trusted_proxies` only; see [remote access](remote-access.md). |
| `server.tls_cert` / `server.tls_key` | Certificate and key paths for uburoom's HTTPS listener (`listen: https`). |
| `access` | The [entry rules](#sign-in-and-access): who gets in. Discord server members by default; configure Discord below. |

**Everyone uburoom admits can watch every library of every media source through that source's own account.** Choose who gets in with the [sign-in and access](#sign-in-and-access) settings, and give each source's account (a Plex token, a Jellyfin user) only the libraries people may watch here.

Open `https://your-origin/watch`. The health endpoint is `/health`. For a config file outside the checkout, run `node server/index.js --config /path/to/config.yaml`.

[`config.example.yaml`](../config.example.yaml) is the complete settings/default reference. Restart after config changes. Invalid, unknown or duplicate YAML keys fail startup. `config.yaml` is the only configuration authority; there are no `.env` or application environment overrides. Relative file paths resolve beside the selected YAML file.

Set `rooms.pause_on_buffering: true` to pause playback for everyone when an active viewer stalls. The default is `false`. Room settings → Playback & queue shows the effective policy. People with room settings permission can set a room override.

## Network and deployment

The server defaults to `127.0.0.1:5756`. Configure `server.host`/`server.port` for your deployment and set `server.public_url` to the exact external HTTPS origin.

Reverse proxies must forward WebSocket upgrades on `/watch-socket`. The upstream connection to uburoom is HTTPS by default. With `server.listen: 'http-proxy'` it is plain HTTP instead and no certificate is needed: only peers in `server.trusted_proxies` (required) may connect, other connections are dropped before a request is read, every request must carry `X-Forwarded-Proto: https` (else 421), and `GET /health` from the same machine is always answered. `server.public_url` stays HTTPS and cookies stay `Secure`; there is no plain-HTTP mode for browsers on the LAN. [Remote access](remote-access.md) has Cloudflare Tunnel, Tailscale and Caddy setups.

By default (`server.trusted_proxies: []`), uburoom ignores all forwarding headers and uses the direct socket address for rate limiting and LAN vs. WAN delivery detection. When running behind a reverse proxy, list the proxy's quoted IPv4/IPv6 addresses or CIDRs in `server.trusted_proxies` (for example `['127.0.0.1', '::1']` on the same host, or a container bridge CIDR such as `['172.16.0.0/12']`) and set `server.trusted_proxy_header` to `'x-forwarded-for'` (default, walked right-to-left skipping trusted proxies), `'cf-connecting-ip'`, or `'x-real-ip'`. Both settings are YAML-only and require a restart to take effect; only list proxy addresses you control.

For Linux/macOS, run Node directly. For containerized deployments, see [Docker guide](docker.md) for running with Docker and Docker Compose: bind `server.host: '0.0.0.0'`, use absolute paths, and persist the data directory and encryption key outside replaceable container storage. Mount private YAML with restricted access. Container loopback is not host loopback.

Do not start a second instance using your live credentials or database. Check sign-in and actual playback from an external device, not just `/health`.

## Sign-in and access

Sign-in proves who someone is; **entry rules** decide whether they get in, and **any one** matching rule is enough. Being admitted is the only media gate: admitted people, guests included, browse and play every library of every source with the source's own credential. Server administration is a separate check. Turn on at least one rule:

| Setting | Behavior |
| --- | --- |
| `access.discord_server` | `true` (default): members of `discord.guild_id` who sign in with Discord. |
| `access.source_members` | Source ids whose members may come in, e.g. `['living-room']`. For a Plex source, a Plex account that can reach that server. For Jellyfin, an enabled user on that Jellyfin server. Members of one source never get in through a rule naming another, and the rule never hides any source's media from people admitted another way. |
| `access.password` | `true`: anyone who enters `secrets.server_password` comes in as a guest under a name they type (or a random one they keep). The browser keeps that sign-in; another browser is another guest. Changing the password signs out everyone who got in with the old one. Wrong guesses are limited per address. |
| `access.accounts` | `true`: uburoom's own accounts, while enabled and with a password; their sign-in form is shown on the entry page. |
| `secrets.server_password` | The password for `access.password`; required with it and refused without it. |
| `server.max_connections: 256` | Open room connections (one per browser tab or app window) accepted at once; 1–4096. Further connections are refused until one closes. |
| `server.public_web_app: false` | Restrict playback to verified Discord Activity. Browser handoff remains available for account linking/management. |
| `operator.identities` | Exact verified identities, quoted `'discord:<id>'`, `'plex:<id>'`, `'uburoom:<subject>'` or `'jellyfin:<server id>:<user id>'`, authorized to open **Server settings** in the browser (the 18-key allowlist across Rooms, Directory and Transcoding). Saved edits write to `config.yaml` and require a manual restart to take effect. |

The entry page shows only what the rules offer: Discord sign-in with `discord_server`, Plex sign-in when a member rule names a Plex source, and the password step with `password`. Plex can still be linked from Account for personal watch-state sync whenever a Plex source is configured. Outside visitors who match no rule can come in through a `/join/<code>` room invite with `guests.enabled: true`. Changing the rules signs everyone out. `/auth/owner` supports the configured Discord owner's OAuth recovery; the owner is always admitted.

### Room invites and guests

Every room has an invite code, like `ubumfa-ogdave`. Anyone in the room can share it with the room's Share button (the device share sheet, the clipboard, or Discord's share link in an Activity), as a `/join/<code>` link or a code typed on the sign-in screen. People who can already enter the server use it to reach the room, including private rooms, which then remember them until a host revokes them. Hosts can make a new code at any time; that removes nobody.

Guests let a room's invite admit people who couldn't otherwise get in. Turn the feature on with `guests.enabled: true`; each room then has an **Allow guests** switch in Room settings → Viewers.

| Setting | Behavior |
| --- | --- |
| `guests.default_allow` | `true` (default) turns on Allow guests in newly created rooms when guests are enabled. |
| `guests.issuers` | Lowest server tier that may turn on guests in a room they host: `operator`, `admins`, `trusted` or `members` (default `admins`). Admin mode always counts. |
| `rooms.trusted_discord_ids` / `trusted_plex_ids` / `trusted_discord_role_ids` | The trusted tier, between admins and everyone else. Exact quoted IDs, matched only against verified sign-ins. Trusted grants nothing else today. |
| `guests.require_sign_in` | `true` makes every guest sign in with Discord or Plex. |
| `guests.max_per_room` | Most guests in one room at once (1–50, default 10). |
| `guests.session_hours` | How long a guest stays signed in before re-entering the code (1–720, default 24). |

Guests are always participants: never hosts (All hosts mode skips them), never Admin mode, and they only see their room. Guests who don't sign in pick a name (prefilled with a random ubunym). It isn't verified, so the roster shows it in italics, and a guest can't take the name of someone signed in who is in the room. Like anyone admitted, they watch every library, and they are never reported to Plex.

Turning Allow guests off keeps current guests. **Remove all guests** removes them all at once and makes a new code. Kicking a guest, or someone who joined a private room by invite, removes them and keeps them out until the code changes.

See [accounts and access](accounts-and-access.md) for the authorization model.

## Media sources

`sources:` lists every media source, all equal: any number of Plex servers, Jellyfin servers and folders sources, in the order their libraries are shown. Each entry has:

| Setting | Behavior |
| --- | --- |
| `id` | Quoted permanent name for the source in config and logs (letters, digits, dots, hyphens, underscores). Never reuse it for a different server. |
| `type` | `plex`, `jellyfin` or `folders`. |
| `name` | Optional label on its libraries' cards; blank uses the name the server reports (folders: "Local folders"). |
| `libraries` | Plex and Jellyfin only, optional: the server's own library ids to offer (Plex section keys, Jellyfin library ids), such as `libraries: ['1', '4']`. Absent offers every movie and show library, including ones added to the server later. Present offers only those listed, so a library added to the server later stays off until you switch it on. Media in a library that is off is unavailable everywhere (library lists, search, shelves, artwork, subtitles and playback); it never affects who gets in. |

and its type's settings below. Queue entries, resume positions and bookmarks are recorded under the **server identity** a source reports (Plex machine id, Jellyfin server id, `folders:<id>` for a folders source), so renaming or reordering entries orphans nothing. Each Plex and Jellyfin source remembers its server's identity the first time it answers; a different server at the same address is refused. Two entries with the same address, or reporting the same server, are refused: their media stays unavailable until one is removed. A source that is offline or removed leaves its queue entries and resume positions in place, shown as unavailable; adding the same server back, under any `id`, restores them. Adding or removing a source takes effect after a restart. A source never lets anyone in by itself.

### Managing sources in Server settings

The server operator can manage sources in the browser: **Server settings → Sources**. It lists each saved source with its status and how many of its server's libraries it offers, and marks changes that wait for a restart. **Edit** renames a source and switches a Plex or Jellyfin source's libraries on or off (saved as `libraries:`). On a folders source it edits the libraries themselves: rename a library, switch it between Movies and Shows, add or remove its folders (a library keeps at least one), and add or remove libraries (a source keeps at least one; remove the whole source with Remove). Library ids never change, so queues and resume positions stay with them, and a new library gets an id no folders source uses. Folders and settings you didn't touch, comments included, stay exactly as written in `config.yaml`; new folders are written as full paths. **Remove** takes the source out of `sources:` and out of `access.source_members`; its queue history and resume positions are kept and come back if the same server is added again. Three add flows write a new entry:

- **Add Plex:** sign in with Plex in a pop-up window (the account doesn't have to own the server). uburoom lists the account's servers and tests each one's connections from the uburoom machine, local addresses first and never Plex relays; a server it can't reach is shown but can't be chosen. An address can be typed instead. Then choose the libraries.
- **Add Jellyfin:** pick a server found on the network or type its address, sign in once as a Jellyfin administrator (password or Quick Connect), and choose the user whose libraries are offered, then the libraries. uburoom creates its own API key named "uburoom" (visible and revocable in Jellyfin's dashboard) and signs the administrator out; it keeps no password.
- **Add a folder:** browse the folders on the uburoom machine (in Docker, the container's mounted paths), then give a name and choose Movies or Shows.

New sources get an `id` made from their name. Changes are written to `config.yaml` with the same validation, revision check and private backup as other saved settings, and apply after restarting uburoom. Tokens and keys stay on the server: the browser never receives them.

### Plex source

| Setting | Behavior |
| --- | --- |
| `url` | Plex address reachable from the uburoom host (not necessarily its public URL); no path. |
| `token` | The Plex token uburoom reads this server with. |
| `machine_identifier` | Optional; blank detects the server once and remembers it. |
| `delivery`, `client_url`, `lan_client_url`, `direct_token` | See [delivery](#delivery). |
| `reporting_enabled`, `reporting_watch_state` | See [reporting](#reporting). |

Until per-source entry rules arrive, a Plex sign-in admits people whose Plex account can reach **any** configured Plex source. With no Plex source, signing in with Plex still proves who someone is but admits nobody.

### Jellyfin source

A `type: 'jellyfin'` entry adds a Jellyfin server. Each movie or show library that user may see appears as a card on Libraries home, with seasons, posters, genre and year filters, sorting and auto-queue sources.

| Setting | Behavior |
| --- | --- |
| `url` | The server's address, including any base path. |
| `api_key` | A key from the Jellyfin dashboard (API Keys). It is sent only as a request header to that server. |
| `user` | A Jellyfin username. Libraries and parental limits follow this user, so give it only what people may watch here. |
| `reporting_watch_state` | Default `true`: viewers signed in to this Jellyfin server may opt in to resume and watched sync on their own Jellyfin user. `false` turns it off for everyone. Has no effect until Jellyfin sign-in is offered. |

Jellyfin accounts are not linked to uburoom accounts: everyone uburoom admits, including guests in their room, watches through the configured user, and Jellyfin never becomes another way in.

Original files play as they are, and files a browser cannot play need FFmpeg and a local output in `transcoding.outputs`: uburoom converts them itself and Jellyfin's transcoder is not used. When only the sound is the problem, or a viewer picks another audio track, the picture is copied untouched (HDR included) and only the chosen track is converted. Embedded subtitles are read from the file; external text subtitles (SRT, WebVTT, ASS) are offered as tracks and other external formats are left out. The source's key never reports anything back to Jellyfin: no play state, progress or watched marks. Collections, multiple versions of one item and intro and credit markers are not supported, and personal Jellyfin sign-in is not offered yet. With a `libraries:` list, items outside a listed library (including collections outside them) are unavailable. `npm run doctor` checks the address, key and user.

### Folders source

A `type: 'folders'` entry lists, under `libraries:`, libraries of videos in folders on the server's own disk. Its media is recorded under `folders:<id>`, so changing a folders source's `id` forgets its queue history. Each library appears as a card on Libraries home and opens one title-sorted list of every video beneath it, subfolders included.

| Setting | Behavior |
| --- | --- |
| `id` | Short permanent name (lowercase letters, digits and hyphens, starting with a letter), unique across all folders sources. Queue entries and resume positions are recorded under it: the folder may move, but a changed `id` forgets them. |
| `name` | The card's title. |
| `paths` | One or more folders (up to 16), shown together as one library. Relative paths resolve beside `config.yaml`. Symbolic links are not followed. A file is known by its place inside its folder, so a folder can move to another drive and keep its queues and resume positions; when two folders hold a file at the same place, the first listed is used. |
| `parse_names` | `true` (default) reads each name as a film's title, year and edition, the way Plex reads file names: everything after the year (resolution, source, codec, release group) is dropped, so `65.2023.2160p.UHD.BluRay.x265-GROUP.mkv` is *65* (2023) and `Blade Runner 2049 (2017).mkv` is *Blade Runner 2049* (2017). Plex's `{edition-…}` marker sets the edition. A file without a year that is the only video in its folder takes the folder's name, as in `Heat (1995)/movie.mkv`. Nothing is looked up online. `false` shows each file name as it is. |
| `type` | `movies` (default) or `shows`. A shows library groups episodes into shows and seasons the way Plex does: the show is the first folder inside the library (`Show (2005)/…`, its year taken from the name) or else the name before the episode number; `S01E02`, `s1e2`, `S01E02E03` or `1x02` give season and episode, and in a `Season 2` folder a name starting with a number (`03 - Title.mkv`) is that episode; `Specials` is season 0, and a file with no number is a special. The text after the number, up to the first release tag, is the episode's title. Pictures in a show's own folder (`poster.jpg`, `fanart.jpg`, `logo.png`) are the show's; otherwise its first episode's frame is used. Episodes step to their neighbours, whole shows and seasons queue in order (Specials only when asked), and a new episode shows in Recently added as its show. |

Local media has no accounts of its own: everyone uburoom admits, including guests in their room, may browse and watch it, and it never becomes another way in. Viewers name a file only by an opaque token, never a path.

FFprobe is required to read a file's duration and tracks. Files a browser cannot play as they are need FFmpeg and a local output in `transcoding.outputs`; there is no Plex transcode for local files. When only the sound is the problem, or a viewer picks another audio track, the picture is copied untouched (HDR included) and only the chosen track is converted, which costs little; Dolby Vision Profile 5 and video the browser cannot decode are still converted. Subtitle files beside a video that share its name (`Film.srt`, `Film.en.srt`, `Film.en.forced.ass`, `.vtt`, `.sup`, `.sub` with `.idx`) are offered as tracks. Folders are re-read at most once a minute. Pictures need FFmpeg. A picture file beside a video is used first: `Film-poster.jpg` (or `Film.jpg`), `Film-fanart.jpg`, `Film-landscape.jpg` and `Film-logo.png` beside `Film.mkv`, and in a film's own folder also `poster`, `folder`, `cover`, `fanart`, `backdrop`, `logo` and similar (`.jpg`, `.png` or `.webp`). Otherwise uburoom looks at 5%, 10%, 15% and 20% of the running time (never later, so nothing is spoiled) and uses the best-lit, most detailed of those frames, tone-mapping HDR (Dolby Vision Profile 5 gets none). Pictures are made ahead of time in the background, newest files first and one at a time, pausing while uburoom converts video for playback (and on demand, two at a time, for anything not yet made), and kept in `local-art` in the data folder (up to 256 MB, least recently shown removed first); nothing is ever written beside the media. Local libraries sort by title, release year, date added (the file's creation time), runtime and at random, filter by release year when `parse_names` is on, and their newest files join Media Home's Recently added. There are no collections and no genres; a shows library filters by its shows' years. `npm run doctor` checks each folder and the tools.

## Plex delivery, reporting and transcoding

### Delivery

Delivery is set per Plex source. `delivery: proxy` (default) sends Plex media through uburoom. `delivery: auto` attempts direct Original/HLS delivery in supported browsers, with authorized proxy recovery when direct delivery fails.

For `auto`, configure `client_url` as a trusted, viewer-reachable HTTPS origin belonging to your selected Plex server (no path/query). LAN clients use authenticated origin discovery or `lan_client_url`. Browser reachability, CORS, range handling and decoding support still apply. Discord Activity, native-HLS-only clients, captions and local conversions retain their respective proxy/conversion paths; there is no direct-only mode.

`auto` also needs `direct_token`: a dedicated Plex account with access to your libraries that does **not** own the server. Browsers receive temporary tokens derived from it, never from the source's `token`, so with `auto` everyone watches that source through that account and sees what it can see. Startup rejects `auto` without it, a `direct_token` equal to `token`, or one set with `proxy`; plex.tv must also confirm the account is not the owner before any token is issued, otherwise playback stays on the proxy. To get its token, sign in at app.plex.tv as that account in a private window and run `localStorage.myPlexAccessToken` in the browser console (F12). It works only while that browser sign-in exists; once it stops working, that source's media is unavailable until you replace it or switch back to `proxy`. Temporary Plex tokens are not restricted to the current movie or room; they can remain valid for up to 48 hours or until PMS restart, and revoking uburoom access may not revoke them immediately. Keep all tokens out of logs and persistent client storage.

Technical details, failure budgets and provider boundaries: [Plex delivery](playback-reliability.md#direct-plex-delivery-hls-and-direct-file) and [Plex developer reference](https://developer.plex.tv/pms/).

### Reporting

Per Plex source, `reporting_enabled: true` (default) reports active playback sessions to Plex for viewers with verified personal Plex credentials using a decoupled viewer session ID so individual viewer departures never stop shared HLS transcodes. Connected Plex accounts default to activity-only reporting (omitting timeline duration so playback appears in Now Playing without mutating personal resume offsets or watch history). `reporting_watch_state: true` (default) allows viewers with connected Plex accounts to explicitly opt in to personal watch-state synchronization in player settings. Viewers without their own Plex sign-in, guests included, remain local-only and never report to Plex.

### Transcoding

The `transcoding` section controls Plex conversion and uburoom's local encoder independently:

| Setting | Behavior |
| --- | --- |
| `policy` | Applies to every media source. `follow_provider` (default) respects the media server's own restrictions; today only Plex has one. `disabled` turns conversion off. `override` permits local conversion despite the Plex preference, but cannot bypass PMS-enforced restrictions. |
| `outputs` | Ordered conversion outputs, default `[av1, provider]`; use `av1`, `vp9`, `vp8` and `provider`. `provider` is the media server's own transcoder, which only Plex has; it is skipped for Jellyfin and local folders. Leaving one out disables it, and `[]` disables conversion. Original still comes first. Each viewer takes the first output their browser reports it can decode and moves down the list if playback fails. A local codec waits behind Plex without a working hardware encoder, unless `encoder` is `software`. Choosing one audio track from several, or H.264 or HEVC video with audio the browser cannot play, keeps the video unchanged and converts only the sound: through Plex when listed, and by uburoom itself for Jellyfin and local folders (needs FFmpeg; no conversion job is used, and `policy: disabled` turns it off). Local outputs use Opus audio and can burn subtitles; burned streams are shared only by viewers using the same subtitle. |
| `encoder` / `cpu_fallback` | Automatic hardware-first probing (supported QSV/NVENC paths), explicit backend selection and optional CPU fallback for hardware setup failures. |
| `hardware_decode` | Default on. Decodes and scales every source on the GPU that matches the encoder: CUDA for NVENC; D3D11VA (Windows) or VAAPI (Linux) mapped to QSV; for software encoders D3D11VA, VAAPI or VideoToolbox. HDR tonemaps through libplacebo on Vulkan when FFmpeg has it; with NVENC, HDR HEVC, H.264 and AV1 sources first decode on Vulkan so the picture never leaves the GPU, then fall back to CUDA decode if that fails. A stream that fails steps down to CPU tonemapping, then CPU decode. FFmpeg wrapper decoders such as `hevc_qsv` are not used because they start chunks up to three frames early. |
| `max_jobs` | Shared Plex/local job limit: default 5, allowed 1–32. Compatible consumers may share one output. Local conversion runs one long-running job per source, which decodes and tonemaps once for every quality viewers are playing near the same point and converts up to a minute ahead of them; a job that waits 10 seconds with nothing wanted stops, and a job gives up its place at the next chunk when other work is waiting. Burned subtitles convert alone. |
| `qualities` / `allow_original` | Ordered height/Mbps pairs and separate Original option. Conversion does not upscale. |
| `fallback.enabled` / `fallback.height` / `fallback.bitrate` | Optional room fallback, off by default, with a 720p maximum height and 2 Mbps target. Requires a local output. Uses uburoom's encoder and the same job/group/byte limits; speculative fallback work yields to viewers. No extra Plex transcode session is created. |

FFmpeg and FFprobe are found on the service user's PATH or at `tools.ffmpeg`/`tools.ffprobe`. Missing tools disable the features that depend on them. Software conversion needs the corresponding AV1/VP9/VP8 encoders and Opus; capability detection is not proof of successful playback.

At capacity, a conversion may wait briefly or reuse an existing compatible output. uburoom will not evict viewers or exceed its job limit; conversions started by other Plex applications are outside that counter. See [playback decisions](playback-reliability.md#playback-decisions).

## Discord (optional)

Create an application in the [Discord Developer Portal](https://discord.com/developers/applications) and fill in `discord.bot_token`, `client_id`, `client_secret`, `owner_id` and `guild_id`.

- Invite the bot with the `bot` scope. Administrator, Message Content and voice-connection permissions are not required.
- Set OAuth callback to `https://your-origin/auth/callback`.
- For Activity, enable Activities, map the root to the uburoom HTTPS origin and verify it in a real Discord client.
- Bot commands are no longer supported; rooms are controlled in the browser or Activity.

Optional host-directory discovery can use Discord Server Members/Presence intents. `directory.expose_discord_members` defaults to `true`. Directory results are not invitations or access grants. See [member directory](accounts-and-access.md#provider-directory-and-member-search).

### Publish rooms to Discord

Set `discord.share_channel_id` to one quoted text-channel ID in `discord.guild_id`; blank disables new publishing. Give the bot **View Channel**, **Send Messages**, **Embed Links** and **Read Message History** in that channel, then restart uburoom. No additional privileged Gateway intent or bot commands are needed.

In the Room section or Room settings → Viewers, **Share** shows the full invite URL with Copy invite link and Share invite… for everyone. Room leaders, hosts (including All hosts, excluding room guests) and active admins can explicitly **Publish** a preview to the configured channel, view the post or remove it. Publishing is independent of the editable Room settings permission. It sends no participant names or automatic mentions. Publishing uses current room details and checks current host/access permissions; settings changes, playback changes and people joining do not require reopening Share. Removal checks current host authority and the room's current post independently of the preview.

One post shows the room name, selected movie/episode and its poster when available, Playing/Paused/Waiting status, unique viewer count and Join room. The same post updates on meaningful changes, including invite rerolls, with changes grouped at five-second intervals. Public and private rooms can be published; existing entry, guest and Plex requirements still apply. Publishing never enables guests or grants media/host access. Poster URLs serve only a bounded cached image for the currently published room/media, with no anonymous provider lookup or Plex token exposure. They stop resolving after removal, closure or a media change; Discord may retain an already fetched image.

Closing or resetting the room marks its post Closed and removes Join; reopening requires explicit Publish. An empty room retains publication while it remains open. Known message IDs survive a server restart and are reconciled after reconnect. Removing a post while Discord is unavailable records pending removal and reports that it has not completed. Provider failures can delay edits/removal; playback stays independent. Deleted posts are not automatically recreated. An uncertain creation response is recovered from the bot's nonce in the latest 100 channel messages when possible; if it cannot be confirmed, fresh creation stops and the host is told to check Discord, preventing automatic duplicate posts.

Publication records use the existing SQLite metadata store; this increment introduces no database schema change. `discord.share_channel_id` is YAML-only.

### Personal Discord Rich Presence (Activity)

Inside the Discord Activity, viewers can opt into sharing their watching status from **Player settings** (`discord.rich_presence` defaults to `true` in `config.yaml`, YAML-only). Baseline login remains silent (`identify` only); toggling Rich Presence on incrementally requests `rpc.activities.write`. Public rooms show the active media title, subtitle/room name and live playback timestamps while playing; private rooms show only generic `Watching in uburoom` status, and no Plex URLs or room invite links are sent. Setting `discord.rich_presence: false` disables and hides the control server-wide.

### Post watch nights to Discord

Watch nights (see [Watch nights](#watch-nights)) can also appear in Discord as native external events. Give the bot **Create Events** at server level; the scheduler then offers **Post to Discord**, on by default. The Discord event's location is the room's current invite, Discord shows its time in each viewer's own zone, and its interested count appears on the lobby card. Posting is independent of channel publishing and works for closed rooms.

uburoom keeps Discord in step: invite rerolls update the location on the next reconciliation (normally within 30 seconds while Discord is available), and title, description and time edits made in Discord flow back into the event. An event canceled or deleted in Discord is canceled in uburoom too. Edit conflicts compare title, description and start/end times; automatic invite changes do not conflict. Brief Discord rate limits are retried with current authorization; longer cancellation waits are retained, completed automatically and shown as Canceling… meanwhile. A create response that cannot be confirmed is matched against the bot's own events rather than resubmitted, and further Discord posting for that room stops until it is resolved. The bot only manages events it created. Permanently deleting a room leaves its Discord event for the server's event managers.

## Watch nights

A watch night is a scheduled event that belongs to one saved room. Hosts at or above `events.schedulers` (`operator | admins | trusted | members`, default `trusted`; higher tiers included) schedule from the lobby's **Schedule** button or the calendar button in a room's header. The scheduler picks a room (by default a new closed room named after the event), title, description, start time, duration and an explicit time zone; nonexistent or repeated local times at daylight-saving changes are rejected. Changing or canceling an event needs hosting its room; guests never schedule. Choosing what to watch stays in the room's queue.

The lobby's **Upcoming** list shows the next three events in rooms the viewer can see (a private room's events stay hidden from people outside it), with More for the rest. From its start time until its end time an event reads **Starting now**, and at its end time it leaves the list. **Join** enters an open room; when the room is closed, hosts get **Open room** and everyone else, including people arriving through the invite, sees "Starts 8:00 PM · Waiting for host" and joins automatically once a host opens it. uburoom never opens a room or starts playback by itself.

An upcoming event keeps its room from empty-room and inactivity cleanup until the event ends. Events are stored in SQLite and survive closure and restart.

## Rooms and retention

Defaults in `rooms`: **50 saved rooms**, **5 open**, **20 members per room**, **100 connected people** (including lobby), **50 upcoming queue items**, **150 history items**, and a **60-second reconnect window**. A full room/capacity limit rejects new additions rather than evicting existing viewers.

Persistent rooms reopen paused after a restart. Auto-resume requires previous play intent, the expected viewers returning inside the recovery window, fresh readiness and an authorized controller. Otherwise someone with permission starts playback.

Closed inactive rooms are cleaned up after 180 days while more than 10 rooms are retained (`inactive_days: 0` disables inactivity cleanup). Empty disposable rooms may be removed earlier; keep-when-empty, an upcoming watch night, an unfinished bookmark, queued items and auto-queueing can retain a room. Queue/history retention does not imply a Plex watched-state update.

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
- **Login works, playback fails:** Separate admission, delivery reachability and browser codec support when diagnosing.
- **Transcoding/subtitles unavailable:** Check the selected FFmpeg/FFprobe binaries, encoders and actual decode behavior.

See [development](development.md) for isolated checks and [testing](testing.md) for verified configurations and open release gates.
