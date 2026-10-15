# Self-hosting

Each installation needs Node 22.13.0+, its own Plex access, its own Discord application and a reachable HTTPS origin. A TLS reverse proxy can forward to the single HTTPS Node server; no particular hostname/cloud service is required. Unrelated-host clean-install and existing-instance upgrade validation remain pending.

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

Source permits localhost only. Prepare an isolated build for your server:

```powershell
node scripts/configure-remote.js --server=https://watch.example --out=releases/remote
.\scripts\package.ps1 -ExtensionDirectory releases/remote
```

Repeat `--server=` for additional explicitly permitted origins, including an existing profile's stored origin when upgrading. The first origin is the default for unpaired profiles; paired profiles keep their selection/device credential. The generator never overwrites an existing build and does not install/sign/publish it. Host permissions cover only those hosts and YouTube TV; CSP/runtime checks constrain exact origins and ports. IPv6 origins are currently unsupported.

Temporary test: use a separate Firefox profile, about:debugging → This Firefox → Load Temporary Add-on → select the generated manifest.json. The retained Gecko ID matches existing installs, so protect paired production profiles. Permanent normal Firefox distribution requires a separate signing step.

## Backups and upgrades

Back up accounts.sqlite through SQLite online backup or an approved maintenance stop, plus all device/login files, private configuration/TLS and the original external key. Verify integrity/authenticated decryption offline. Raw live SQLite copying is insufficient; independently copied state files are not one transaction. Use an approved final stop/copy at cutover.

Select a tested revision in a separate local code directory; install/test before attaching production state. Current server paths place data/ beneath code; use a deliberately tested state link or reviewed configuration change to separate releases. Keep prior working code and matched backups. Restart only after operator approval. Compatible code rollback should retain current user data; schema/encryption changes need an explicit matched restore strategy.
