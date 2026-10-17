# Working on uburoom

uburoom is a self-hosted Plex watch-together app with a browser interface, Discord Activity, bot integration and linked accounts. The YouTube TV remote has an independent clean snapshot in uburoom-remote; its original source remains here until the M1-P8 cutover and remaining compatibility checks. Native-player integration is later work.

Read [ROADMAP.md](ROADMAP.md) before planning feature work or choosing the next increment. It consolidates priorities and links to detailed plans; keep its affected milestone current after material work. Record verification evidence and unfinished checks in [docs/testing.md](docs/testing.md). The owner's current task takes priority, and roadmap entries do not authorize unrelated implementation or deployment.

---

## Codebase Quick Map

| Domain | Primary Files |
| --- | --- |
| **Room state & lifecycle** | [server/watch.js](server/watch.js), [server/core.js](server/core.js) |
| **HTTP/WebSocket routing & auth** | [server/app.js](server/app.js), [server/login.js](server/login.js), [server/watch-http.js](server/watch-http.js) |
| **Shared command engine** | [extension/engine.js](extension/engine.js) |
| **Web watch client** | [web/watch.js](web/watch.js), [web/watch.html](web/watch.html), [web/playback-timing.js](web/playback-timing.js) |
| **Remote UI, SVGs & styles** | [extension/remote-ui.js](extension/remote-ui.js), [extension/popup.html](extension/popup.html) |
| **Accounts, SQLite & vault** | [server/accounts.js](server/accounts.js), [server/storage.js](server/storage.js), [server/database.js](server/database.js), [server/storage-worker.js](server/storage-worker.js) |
| **Plex integration** | [server/plex.js](server/plex.js), [server/plex-auth.js](server/plex-auth.js), [server/media-tracks.js](server/media-tracks.js) |
| **Discord bot & Activity** | [server/discord.js](server/discord.js), [web/vendor/discord-sdk.js](web/vendor/discord-sdk.js) |

---

## Architecture & Stack

- **Single Node process architecture.** `node server/index.js` — no multi-process server clustering (e.g., PM2 cluster mode or multi-instance orchestration). External media tools (`ffmpeg`/`ffprobe`) are spawned as bounded child processes. The server coordination loop runs on the main event loop, but Node built-in `node:worker_threads` may be used when necessary to offload CPU-heavy or blocking tasks (crypto, subtitle parsing) to protect the real-time sync loop.
- **No frameworks.** HTTP/HTTPS routing is a hand-rolled router in `server/app.js` (raw `node:https`). There is no Express, Koa, or Fastify. Do not introduce one.
- **Plain JavaScript with JSDoc type safety.** No TypeScript compiler, no JSX, no transpilers, no minifiers. Use standard JavaScript with JSDoc annotations (`@typedef`, `@param`, `@type`) and `// @ts-check` for complex contracts (sync timing, room epochs, track choices, auth tokens). Server code is CommonJS (`require`/`module.exports`); web client code uses standard native ES modules (`<script type="module">`) or plain scripts without build steps. 2-space indentation, semicolons, single quotes.
- **SQLite for persistence.** Primary database is `data/accounts.sqlite` using Node's built-in `node:sqlite` (`DatabaseSync` — synchronous API). `server/storage.js` defines the first-release baseline and rejects incomplete private pre-release layouts; legacy JSON imports and implicit schema upgrades have been removed. Keep schema versioning for forward migrations between published releases. Do not introduce ORMs (Prisma, TypeORM), external database servers, or secondary databases.
- **Minimal dependencies.** Production deps: `@discord/embedded-app-sdk`, `discord.js`, `hls.js`, `jassub`, `libbitsub`, `ws`. Dev dep: `esbuild` (for vendor bundle builds only). Justify any new dependency; prefer Node built-ins and vendoring small libraries into `web/vendor/` with proper license notices.
- **Node ≥ 22.13.0 required.** Tests use the built-in `node:test` runner and `node:assert/strict` — no Jest, Mocha, or external test framework.

---

## Configuration

- **All config via `.env` file** (loaded by `--env-file-if-exists=.env`). Not `config.json`, not environment variables set externally. The `.env` file is gitignored.
- Key variables: `HOST`, `PORT`, `PUBLIC_URL` (must be HTTPS), `TLS_CERT`/`TLS_KEY`, Discord credentials (`DISCORD_BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_OWNER_ID`, `DISCORD_GUILD_ID`, `DISCORD_COMMAND_CHANNEL_IDS`), Plex credentials (`PLEX_URL`, `PLEX_TOKEN`, `PLEX_MACHINE_IDENTIFIER`), `UBUROOM_CREDENTIAL_KEY_FILE`, `FFMPEG_PATH`/`FFPROBE_PATH`.
- Device, browser-login and playback-history state live in `data/accounts.sqlite`. Legacy JSON files are not runtime inputs. Existing private pre-release state requires a matched backup and baseline verification, or a reviewed manual transfer/reset, before deployment. Runtime SQLite work uses an in-memory mirror and a bounded writer worker; await persistence before acknowledging durable changes. Rooms and consent remain ephemeral for M1.
- See [docs/self-hosting.md](docs/self-hosting.md) for the full configuration reference.

---

## Room Model & Command Engine

- **Terminology rule:** Use **"room"** for watch parties, UI elements, lobby dialogs, and Discord commands. Reserve **"session"** strictly for low-level technical contexts (HTTP cookie sessions, WebSocket connections, Plex transcode sessions).
- Watch rooms are **in-memory** (`Map` in `server/core.js` and `server/watch.js`). They are intentionally ephemeral for M1. Playback queues and restart-persistent rooms are planned for later scoped work; do not add them as incidental refactors or persist remote consent.
- Rooms have an owner, viewers, media, playback state (position, paused, muted, volume, seekable), visibility (public/private), mode, controls, epochs, and optional scheduled starts.
- **Every control surface** — web watch page, extension remote, Discord bot, Discord Activity — sends commands through the shared validated handler in `core.js` via the shared `Engine` (`extension/engine.js`). Never bypass it with direct state mutation or a parallel control path.
- The **server owns the shared timeline**. Viewers own quality, audio, subtitles, and volume. Server acknowledgement is not proof of client playback.

---

## Authorization & Consent

- **Remote consent starts off** after session/tab/browser/server restart or disconnect. This is a hard rule — never auto-enable remote consent. `turnOff()` disables remote on every disconnect.
- Authorize **actor, guild/channel, room eligibility and current permissions** for every command. This applies equally to WebSocket commands, REST API calls, and Discord-originated commands.
- Access model: owner > host > voice-channel members > active watchers, with visibility (public/private) gates. Check guild membership, command channel whitelist, and voice channel matching for Discord commands.
- **Hide inaccessible/private rooms** from room lists, **reject ambiguous targets**, and **never replay stale commands**. Short TTLs on pending commands.

---

## Negative Constraints & Agent Guardrails

- **No unsafe DOM or HTML string injection:** Never use `innerHTML`, `outerHTML`, or `insertAdjacentHTML`. Always use safe DOM creation (`document.createElement` + `textContent`).
- **No event-loop blocking during playback:** Never execute synchronous disk I/O (`DatabaseSync`) or heavy cryptography (`credentialVault` AES-256-GCM) inside the high-frequency playback/tick loop. Protect the ≤50ms sync target.
- **No silent fake/mock fallbacks in production code:** If Plex access, authentication, or network requests fail in live flows, fail truthfully and report the genuine error. Never silently fall back to demo fixtures or mock streams.
- **Never regenerate encryption keys:** Never generate a replacement key for an existing database — this silently corrupts all stored Plex OAuth tokens.

---

## Accounts, Credentials & Encryption

- Accounts use **stable UUIDs** — never regenerate them. Account merging retires one UUID into another via `retiredInto`; `canonical()` follows the chain.
- Plex OAuth tokens are encrypted with **AES-256-GCM** using a 32-byte key. The key file defaults to `LOCALAPPDATA/uburoom/credentials.key` and **must be stored outside the project folder** (startup validates this).
- Credentials belong in **private server configuration** (`.env`, gitignored) or **extension storage** (`browser.storage.local`). Never log, commit, or package secrets, private state, TLS certificates, or key files.
- See [docs/upgrading.md](docs/upgrading.md) for current pre-release transition notes and rules preserving UUIDs and exact original key bytes when retaining state.

---

## Naming & Branding

- Use **uburoom** names throughout all code, UI, docs, and assets. `/ubu` and `!ubu` are the only Discord commands (not `!uburoom`). The `session.*`/`/api/sessions` watch-room aliases are removed; all clients must use the canonical room protocol.
- The brand transition is tracked in the roadmap. Public GitHub repository creation is deferred until the transition is complete.

---

## Extension (YouTube TV Remote)

- **Firefox MV3.** The extension is Manifest V3 (Gecko ID `uburoom@uburoom.com`, min Firefox 115.0). Keep permissions narrow — only explicitly configured HTTPS origins, never `<all_urls>`.
- The current extension is Firefox-only. Chromium extension support is deferred to M2-P10; it is not part of M1-P8 extraction. This does not establish a Firefox-first policy for the web app.
- **Configured builds** accept explicit HTTPS origins with matching `permissions` and CSP entries. Configure with `scripts/configure-remote.js --server=https://origin`. No unrestricted host access.
- Communication flow: `content.js` ↔ `background.js` (via `browser.runtime` messaging) ↔ server (via WebSocket with device ID + credential auth). The popup (`popup.js`) also talks to `background.js`.
- `engine.js` is the shared command engine — same file used by extension, web client, and server. Changes currently affect all three surfaces; after M1-P8, keep the common protocol/validation contract stable through separately versioned builds instead of importing source across repositories.
- `room-protocol.js` owns room/playback validation and `viewport.js` owns transform/profile validation and picture calculations. The engine dispatches between them. Keep both protocol revisions and matching fixtures coordinated; see [remote integration contract](docs/remote-protocol.md).
- The known full extension smoke timing issue is deferred; do not weaken permissions or throttling to hide it.

---

## Web Client & Player

- The watch page (`web/watch.html` + `web/watch.js`) is an SPA. It uses a standard `<video>` element, HLS.js for HLS streams, and native playback for direct streams.
- **Sync timing:** Clock offset estimation (midpoint exchange, rolling low-delay filter, bounded slew). Initial readiness publishes a start 1.75s in the future. Drift correction via `web/playback-timing.js`.
- **Playback decisions:** Resolve Plex access → gather runtime codec support → prefer direct → consider remux/audio-only → fall back to full conversion. Delivery paths: Original (direct file), Plex HLS (H.264/AAC), custom AV1/Opus (Intel QSV via FFmpeg).
- **Recovery:** Bounded retries, HLS session refresh, 60s reconnect grace, host heartbeat loss revokes consent. See [docs/playback-reliability.md](docs/playback-reliability.md).
- Report unsupported or site-dependent behavior honestly — do not silently swallow codec/browser limitations.

---

## UI & Design

- Read [docs/design-guide.md](docs/design-guide.md) and the currently shared styles/SVGs in `extension/remote-ui.js` before any UI work. After M1-P8, shared UI assets must have clear per-repository ownership without cross-repository filesystem imports. **Inspect affected rendered surfaces** before and after changes.
- **Color tokens:** background `#101217`, card `#1B1E26`, elevated `#292E38`, border `#393F4D`, text `#F8F7F4`, muted `#AAB0BC`, orange `#FF9954` (main accent), pink `#FF7197` (brand accent), green `#158761` (remote enabled).
- **Icons:** 24×24 SVGs, `currentColor` strokes, rounded ends/joins, ~1.9px stroke width. ~40 icon paths defined inline in `remote-ui.js`. No emoji or icon library substitution. Do not invent replacement graphics.
- **Title indicators are independent:**
  - 🟢 — only for that room's confirmed reachable remote enablement.
  - 🔵 — only for non-default transforms active.
  - Never combine, conflate, or condition one on the other. Preserve SPA titles without duplicate prefixes.

---

## Discord Integration

- The bot uses `discord.js` for gateway + REST. It registers a single slash command (`/ubu` with `command` and optional `target` parameters) and a prefix command (`!ubu`), replacing application commands in the configured guild at startup.
- Discord Activity is an embedded iframe app (`@discord/embedded-app-sdk`). The watch page detects Activity mode via `frame_id` query param and uses short-lived bearer tokens from SDK authentication.
- **All Discord commands route through the shared `Engine`** — Discord is just another command surface. Check guild membership, command channel whitelist, linked-account status, and voice channel matching for every command.
- Requires **Message Content Intent** enabled in the Discord developer portal.

---

## Plex Integration

- The server connects to Plex using the configured `PLEX_URL` and `PLEX_TOKEN` (owner token for library browsing/metadata).
- Per-viewer media preparation: resolves Plex access, handles quality selection, compatibility, track choices, browser subtitles, shared conversion keys. Collapses concurrent polls per viewer.
- Quality presets: Original, 1080p at 20/12/8 Mbps, 720p at 4/2 Mbps.
- Optional FFmpeg/FFprobe for AV1 encoding (`server/av1.js`) and subtitle extraction.

---

## Testing

- Run `npm test` (invokes `node --test tests/*.test.js`). All tests must pass without unexpected skips.
- Chrome and Firefox are equal required web-client test targets. Run relevant browser checks in both; there is no Firefox-first policy. Until M2-P10, extension installation/lifecycle checks apply to the supported Firefox build.
- **No unexpected skips.** 13 tests skip without test certificates (expected). If a test is otherwise skipped, document why in [docs/testing.md](docs/testing.md).
- Smoke and integration scripts live in `scripts/` and require a running server with fixture data (`scripts/account-fixture.js`). They are not part of the `npm test` suite. The playback baseline exercises actual watch playback in headless Firefox/Chrome/Edge, checking decoded pixels, PCM tones, startup, stalls, drift, pause/seek/resume across multiple codecs and frame rates.
- Record verification evidence and unfinished checks in [docs/testing.md](docs/testing.md).

---

## Development Workflow

- **Develop and install on local disk.** Use isolated fixture accounts/media; never run a second process against production bot credentials or data.
- **Setup:** `npm ci`, generate dev cert, `npm test`, then `node scripts/watch-demo.js --accounts` for a synthetic demo (no real Plex/Discord needed).
- **Extension dev:** Load `extension/` as a temporary add-on in Firefox via `about:debugging`. Configure the server URL in the extension popup.
- **Vendor builds:** `npm run build:player` bundles Discord SDK, HLS.js, and subtitle renderers via esbuild into `web/vendor/`.
- **Database:** `data/accounts.sqlite` is created automatically on first run. The credential key file must exist and be outside the project folder.
- See [docs/development.md](docs/development.md) for the full dev guide. M1-P7 will isolate the browser codec-test page from normal viewing, and M1-P11 uses transport-neutral room operations directly from WebSockets while preserving necessary HTTP resources.

---

## Commits, Releases & Publication

- Keep commits **small and focused**. Documentation should be generic and public-facing.
- Keep personal deployment notes, scripts, and configs in the **ignored `/personal/` folder**. Never stage, commit, package, or publish them. Keep personal paths, screenshots, migration diaries, and reference projects out of publication history.
- **No production changes without explicit approval:** no restart, config, DNS, Cloudflare, or Discord-registration changes; no signing, publication, or public push.
- Deliver distributable bundles as **timestamped ZIPs** via `scripts/package.ps1`. Current outputs: extension ZIP (explicit file whitelist + LICENSE), source ZIP (from `git ls-files`, filtered), optional MV2 persistent fallback ZIP. Update packaging ownership after the planned separate remote repository is verified. Audit source, full publication history, assets, notices, and ZIP contents before release.
- **License:** First-party source is `GPL-3.0-only`. Preserve third-party licenses/notices (see [docs/third-party.md](docs/third-party.md) and `web/vendor/THIRD_PARTY_NOTICES.txt`). Include `LICENSE` in all distributions. Artwork/media provenance remains a release gate.
