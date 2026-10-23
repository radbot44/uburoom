# Self-hosting

Requires Node 22.13.0+, authorized Plex access, TLS and a reachable HTTPS origin. Discord features require your own application. Independent-host installation, native Linux/macOS/container operation and operator restore verification remain open in [testing](testing.md).

## Install and start

```powershell
npm ci
# Copy config.example.yaml to private config.yaml and edit it.
npm start
# Or:
node server/index.js --config /private/uburoom/config.yaml
```

Supply your own certificates. Forward WebSocket upgrades at `/watch-socket` through any reverse proxy; the Node upstream also uses HTTPS. Check `/health`. Do not use production credentials in a second test instance.

## Configuration

[config.example.yaml](../config.example.yaml) is the complete key/default reference. YAML is the sole authority; no application environment overrides or .env loading. The default file is project-root `config.yaml`; relative paths resolve beside the selected YAML. Quote IDs/secrets and Windows paths, use native lists, and restart after changes. Unknown/duplicate keys and invalid values fail startup.

**Never share private YAML, tokens, databases, TLS keys or credential keys.** Restrict access to the runtime account (`chmod 600` for private YAML on Unix; Windows Security permissions). Use absolute paths for independently mounted state/configuration.

| Area | Settings / operational meaning |
| --- | --- |
| Plex | `plex.url`, `token`, optional pinned `machine_identifier`; server-side endpoint may be private |
| Discord | `bot_token`, OAuth `client_id/client_secret`, `owner_id/guild_id`; blank bot token disables the connection |
| HTTPS | `server.host/port` default loopback/5756; `public_url` is an exact HTTPS origin; `tls_cert/tls_key` are PEM files |
| State | `storage.data_directory` defaults to `data` beside YAML; persist it independently of releases |
| Credential key | `storage.credential_key_file` must be outside the project; preserve exact original bytes for retained state |
| Media tools | `tools.ffmpeg/ffprobe`: explicit paths override runtime PATH; ffprobe can fall back beside ffmpeg |
| Roles | `rooms.host_permissions/viewer_permissions` and provider/role admin-ID lists; Admin mode is opt-in |

Key defaults: Windows `%LOCALAPPDATA%/uburoom/credentials.key`; Linux `$XDG_DATA_HOME/uburoom/credentials.key` or `~/.local/share/uburoom/credentials.key`; macOS `~/Library/Application Support/uburoom/credentials.key`. Relative XDG values are ignored. Existing databases require their original key; there is no automatic relocation.

Tool discovery uses absolute PATH directories inherited at startup, not aliases/shell wrappers. Missing tools disable dependent features rather than server startup. Discovery does not prove encoder support.

## Entry and account policies

- `access.discord` and `access.plex` default true. Discord verifies guild membership; Plex proves identity. Both false creates separate 24-hour anonymous browser logins without owner/admin rights; these are not revocable guest passes.
- `access.require_plex: true` requires personal access to the pinned server and an accessible library. Fallback/password cannot satisfy it. `require_plex_in_activity: false` exempts only server-verified Activities; browser handoffs retain the browser requirement.
- `secrets.entry_password` adds a password to provider rules. Grants last 12 hours and clear on restart; it never grants ownership. Admission-policy changes invalidate stored browser logins.
- `/auth/owner` permits only the configured Discord owner's OAuth recovery, even with ordinary Discord sign-in disabled. Configure OAuth first; other access/password restrictions still apply.
- `server.public_web_app: false` allows Activity playback only and requires working Discord application/bot/guild verification. Browser handoff remains for account linking/management. Cookies or a forged `frame_id` never grant Activity playback.

## Shared Plex fallback

`plex.fallback_enabled` defaults **true**: eligible users without an attached Plex account or with confirmed server nonmembership may receive the fallback account's media scope. **This can exceed their own permissions.** Required personal Plex admission still applies.

Blank `fallback_token` uses `plex.token`; a dedicated account limits that scope. A configured account token rejected by PMS with 401 can resolve to the same account's server token. Other denials, expired/revoked credentials, outages, identity mismatches and item restrictions never switch to another identity. Personal access takes precedence. Disabling fallback requires personal media entitlement even when entry is otherwise allowed.

Sponsorship neither links that Plex account to the viewer nor enables personal Plex reporting.

## Direct Plex delivery

Default `plex.delivery: proxy` sends media through uburoom. `auto` prefers direct Original/hls.js delivery and recovers through the authorized proxy per viewer.

- Set `plex.client_url` to a trusted HTTPS origin without path/query/credentials/fragment, belonging to the pinned Plex server.
- LAN viewers use authenticated Plex LAN-origin discovery or `plex.lan_client_url`. Exact advertised non-relay origins avoid a server-side public-address probe; custom origins still need identity validation. Browser reachability/CORS/range checks remain independent.
- Direct HLS retains a small initial playlist in uburoom; all video/audio segments, including the timestamp anchor, go Plex → browser. Matching viewers can share output with separate temporary credentials.
- Activity, native-HLS-only playback, captions and local conversions retain their existing paths. Strict direct-only mode is not supported. Original quality can still require conversion for compatibility/tracks.
- Direct fallback requires `direct_fallback_enabled: true`, enabled sharing and a dedicated `fallback_token` verified by plex.tv as non-owner. Blank, configured-owner, ambiguous or unverifiable credentials stay prohibited for direct fallback.
- Temporary tokens retain the source account's permissions: they are not movie/room-scoped, and ending uburoom access cannot guarantee their immediate revocation. Plex's documented lifetime is up to 48 hours or PMS restart. Keep permanent credentials server-side and temporary tokens out of logs/persistence.

Direct negotiation has a five-second budget; HLS playlist requests use five seconds to first byte/eight seconds total without internal retries. Subsequent proxy preparation/capacity waits are separate. Proxying cannot repair unsupported decoding. See [delivery contract](plex-hls-delivery.md) and [Plex delegation API](https://developer.plex.tv/pms/).

## Conversion policies and limits

| Setting | Behavior |
| --- | --- |
| `policy: follow_plex` | Default: honor Plex video-encoding restrictions; unavailable/unknown preference fails conversion closed while Original remains available |
| `policy: disabled / override` | Disable conversion, or deliberately permit local conversion despite the preference; override cannot bypass PMS-enforced restrictions |
| `plex / uburoom` | Independently enable conversion providers |
| `formats` | Ordered local output codecs; default `[av1]`, optional VP9/VP8, empty disables local output; all use Opus |
| `encoder` | Auto probes AV1 QSV then NVENC, VP9 QSV; VP8 software. Explicit backend remains selected unless CPU fallback is allowed |
| `cpu_fallback` | Covers failed hardware probe/initialization, not cancellation, upstream denial or resource-limit failures |
| `max_jobs` | Default 5, range 1–32; shared Plex/local reservations and active jobs; matching consumers count once |
| `qualities` | Up to 32 unique [even height 144–4320, Mbps 0.1–200] pairs, bitrate up to three decimals |
| `allow_original` | Independent Original offering; at least one quality must remain |

Software requires `libsvtav1`, `libvpx-vp9` or `libvpx` plus Opus. Hardware capability needs an actual probe; Plex controls its own encoders. Local conversion does not upscale or silently drop required burned captions.

At capacity, new work waits up to eight seconds in a bounded queue, then may use compatible shared output within the viewer's saved quality ceiling. Never evict an existing player, exceed the job limit or change tracks/authority. Other applications' Plex jobs are outside this counter. See [Discord codec evidence](discord-codec-compatibility.md).

## Rooms and directory

Limits/defaults are in YAML: 50 saved/5 open rooms, 20 members/room, 100 connected people including lobby, 50 upcoming/150 history entries, 60-second reconnect/recovery. Canonical accounts count once across tabs. Limits reject additions rather than evict users.

Inactivity cleanup deletes oldest closed rooms after 180 days while above 10 retained rooms; zero days disables it. Empty disposable rooms can disappear below that floor. Retain an empty room if Keep room when empty is on, a bookmark is below 90%, upcoming entries exist or auto-queue is on. The 90% rule is retention only, not watched-state evidence. History trimming preserves completion/generation progress; explicit Reset auto-queue progress clears that progress without clearing visible queue/history.

Previously open rooms recover paused. Auto-resume requires prior playing intent, all expected accounts returning within the recovery window, fresh readiness and an authorized controller. Otherwise remain paused; permitted Play/Start now can end recovery early.

Single-room mode fixes the name to **Room** and disables create/rename/ordinary close/delete/transfer. Leader: explicit Plex ID, otherwise Discord owner when Discord sign-in is on, Plex token account for Plex-only, Discord owner when both off. Lookup failure never makes the visitor leader. Reset preserves room/account/key/creator identity but clears playback/queue/history and restores configured policy/hosts. Admin rights require explicit Admin mode; delegated host addition follows the normal permission.

Directory defaults: Discord exposure on, Plex off. Discovery grants no access; see [host directory](account-names-and-host-directory.md).

## Providers

Discord: invite the bot with `bot` scope; no Administrator/message-content/voice-connection permission is required. Optional directory discovery needs Server Members/Presence intents. Set OAuth callback to `https://your-origin/auth/callback`. Enable Activities and map the root to the installation origin; verify real SDK, proxy and layout behavior. Bot commands are removed.

Plex: configure private access and verify restricted accounts, revocation and claimed delivery paths. Matching an account name is never entitlement.

## Backups and deployment

Use [upgrading](upgrading.md) for matched SQLite/key/config/TLS backups and rollback. No JSON import or automatic private migration remains.

On Linux/macOS, launch Node directly. For containers, persist data/key, mount private YAML read-only, bind `0.0.0.0`, use absolute container paths and provide runtime ownership/chmod access to the key. Container loopback is not the host; TLS remains required upstream. A maintained, validated container image is future work.
