# Self-hosting

Each installation needs Node 22.13.0+, its own Plex access, its own Discord application and a reachable HTTPS origin. A TLS reverse proxy can forward to the single HTTPS Node server; no particular hostname/cloud service is required. Unrelated-host clean-install and backup/restore validation remain pending. There is no supported upgrade promise from private pre-release revisions to the first public release.

## Configuration

Run `npm ci`. Copy `.env.example` to private `.env` and supply your own values:

| Setting | Purpose |
| --- | --- |
| HOST / PORT | Bind address/port; defaults loopback/6767. |
| PUBLIC_URL | Exact public HTTPS origin, e.g. https://watch.example. |
| TLS_CERT / TLS_KEY | PEM certificate/key accessible to the runtime account. |
| DISCORD_BOT_TOKEN | Server-only bot token; blank disables its connection. |
| DISCORD_CLIENT_ID / DISCORD_CLIENT_SECRET | Your OAuth application. |
| DISCORD_OWNER_ID / DISCORD_GUILD_ID | Owner and approved guild IDs. |
| DISCORD_COMMAND_CHANNEL_IDS | Permitted text-channel IDs, comma-separated. |
| PLEX_URL / PLEX_TOKEN | Your Plex origin and private configured server token. |
| PLEX_MACHINE_IDENTIFIER | Optional exact target; otherwise pinned after verification. |
| UBUROOM_CREDENTIAL_KEY_FILE | Optional absolute key path outside the project. |
| FFMPEG_PATH / FFPROBE_PATH | Optional existing binaries for Intel AV1 fallback. |

The key defaults to the runtime user's LOCALAPPDATA/uburoom/credentials.key (or equivalent home fallback). Protect private environment, data, TLS and external key with restrictive permissions. Linked viewers delegate Plex credentials to this server; encryption at rest does not eliminate trust in its operator.

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

Select a tested revision in a separate local code directory; install/test before attaching production state. Current server paths place data/ beneath code; use a deliberately tested state link or reviewed configuration change to separate releases. Keep prior working code and matched backups. Restart only after operator approval. Compatible code rollback should retain current user data; schema/encryption changes need an explicit matched restore strategy.
