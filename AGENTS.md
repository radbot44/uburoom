# Working on uburoom

uburoom is a self-hosted Plex watch-together app with a browser interface, Discord Activity, bot integration and linked accounts. The YouTube TV remote lives in the independent uburoom-remote repository; no extension source or build tools remain here. Native-player integration is later work.

Read [ROADMAP.md](ROADMAP.md) before planning feature work or choosing the next increment. It consolidates priorities and links to detailed plans; keep its affected milestone current after material work. Keep concise results, known failures and open gates in the [verification dashboard](docs/testing.md); preserve substantive historical evidence in the [dated archive](docs/archive/testing-2026-10-22.md) or linked artifacts. The owner's current task takes priority, and roadmap entries do not authorize unrelated implementation or deployment.

---

## Owner-controlled UI and design decisions — mandatory for every agent

**The owner retains ALL decisions about UI, styling, popup types, interactions, component boundaries, consistency rules, exceptions, sequencing, tests and implementation details.** This includes changes an agent might call minor, obvious, standard, accessibility-related, cleanup or a bug fix. An agent may investigate and recommend, but must not interpret a recommendation, existing code, unanswered question or past unapproved proposal as permission.

**Before ANY UI/design investigation, planning or code change, read [docs/design-guide.md](docs/design-guide.md) in full.** That guide is the canonical design reference and contains the owner-approval workflow and owner-approved type registry. Read the relevant actual files and test evidence too; investigate discrepancies rather than making independent design choices. In particular, popups, menus, dialogs, overlays, buttons and responsive behavior must follow the guide. Before implementation, provide an evidence-based inventory, exact issues and code locations, alternatives/trade-offs, a staged plan and explicit numbered owner questions for **every unresolved choice**. Then **stop and wait for explicit owner answers and authorization to implement**. Never silently choose a default, invent or change a canonical type, or implement a proposed refactor. A decision concerning one surface or property does not imply approval for another.

After approval, record the owner's canonical types, attributes, exceptions and decision references in **docs/design-guide.md** before changing affected UI code. Keep the guide synchronized with each later owner-approved revision and preserve the existing authorized design until a change is expressly approved. When new unanswered choices arise, stop and ask again. No unrelated implementation, branch merging, deployment or publishing is authorized by a design review.

---

## Codebase Quick Map

| Domain | Primary Files |
| --- | --- |
| **Room state & lifecycle** | [server/watch.js](server/watch.js), [server/core.js](server/core.js) |
| **HTTP/WebSocket routing & auth** | [server/app.js](server/app.js), [server/login.js](server/login.js), [server/watch-http.js](server/watch-http.js) |
| **Shared command engine** | [shared/engine.js](shared/engine.js), [shared/room-protocol.js](shared/room-protocol.js), [shared/viewport.js](shared/viewport.js) |
| **Web watch client** | [web/watch.js](web/watch.js), [web/watch.html](web/watch.html), [web/playback-timing.js](web/playback-timing.js), [web/watch-sync.mjs](web/watch-sync.mjs) |
| **Web Tabler icons, remote UI & styles** | [web/icons.js](web/icons.js), [web/remote-ui.js](web/remote-ui.js), [web/watch.css](web/watch.css) |
| **Accounts, SQLite & vault** | [server/accounts.js](server/accounts.js), [server/storage.js](server/storage.js), [server/database.js](server/database.js), [server/storage-worker.js](server/storage-worker.js) |
| **Durable rooms and queues (P13-1–P13-5)** | [server/room-store.js](server/room-store.js), [server/room-queue.js](server/room-queue.js), [server/playback-end.js](server/playback-end.js), [implementation and integration boundary](docs/rooms-and-queues.md) |
| **Plex integration** | [server/plex.js](server/plex.js), [server/plex-auth.js](server/plex-auth.js), [server/media-tracks.js](server/media-tracks.js) |
| **Discord bot & Activity** | [server/discord.js](server/discord.js), [web/vendor/discord-sdk.js](web/vendor/discord-sdk.js) |

---

## Architecture & Stack

- **Single Node process architecture.** `node server/index.js` — no multi-process server clustering (e.g., PM2 cluster mode or multi-instance orchestration). External media tools (`ffmpeg`/`ffprobe`) are spawned as bounded child processes. The server coordination loop runs on the main event loop, but Node built-in `node:worker_threads` may be used when necessary to offload CPU-heavy or blocking tasks (crypto, subtitle parsing) to protect the real-time sync loop.
- **No frameworks.** HTTP/HTTPS routing is a hand-rolled router in `server/app.js` (raw `node:https`). There is no Express, Koa, or Fastify. Do not introduce one.
- **Plain JavaScript with JSDoc type safety.** No TypeScript compiler, no JSX, no transpilers, no minifiers. Use standard JavaScript with JSDoc annotations (`@typedef`, `@param`, `@type`) and `// @ts-check` for complex contracts (sync timing, room epochs, track choices, auth tokens). Server code is CommonJS (`require`/`module.exports`); web client code uses standard native ES modules (`<script type="module">`) or plain scripts without build steps. 2-space indentation, semicolons, single quotes.
- **SQLite for persistence.** Primary database is `data/accounts.sqlite` using Node's built-in `node:sqlite` (`DatabaseSync` — synchronous API). `server/storage.js` defines the first-release baseline and rejects incomplete private pre-release layouts; legacy JSON imports and implicit schema upgrades have been removed. Keep schema versioning for forward migrations between published releases. Do not introduce ORMs (Prisma, TypeORM), external database servers, or secondary databases.
- **Minimal dependencies.** Production deps: `@discord/embedded-app-sdk`, `discord.js`, `hls.js`, `jassub`, `libbitsub`, `ws`, `yaml` (configuration parsing). Dev dep: `esbuild` (for vendor bundle builds only). Justify any new dependency; prefer Node built-ins and vendoring small libraries into `web/vendor/` with proper license notices.
- **Node ≥ 22.13.0 required.** Tests use the built-in `node:test` runner and `node:assert/strict` — no Jest, Mocha, or external test framework.

---

## Configuration

- **All config via private `config.yaml`**, loaded by `server/config.js`; `--config <path>` selects a mounted/external file. No `.env` loading or application environment overrides. Relative paths resolve beside the YAML file. Never share, log, commit or package private configuration; only `config.example.yaml` is distributable.
- YAML sections: API/secrets first (`plex`, `discord`), then `server`, `storage`, `tools`, `rooms`. Quote IDs and secrets; use native YAML lists. Validate settings before opening state or contacting providers. Until the final release preparation steps, save private configuration and schema/data migration scripts in `personal/migrations/` outside the shipped application; configuration defaults may use a reusable script reading the current example, while database migrations remain task-specific; do not retain migration commands or run migrations automatically at startup/deployment. Preserve the original key and state paths. Keep Linux/macOS/container mounting and persistent-state needs in mind.
- Device, browser-login and playback-history state live in `data/accounts.sqlite`. Baseline version 6 includes room records/hosts, queue occurrences, auto-queue state, lifetime/capacity settings, bounded reboot recovery, first-sign-in markers and pending provider-bound host grants; earlier private state is rejected unchanged and requires a reviewed matched backup/manual transfer before deployment. Legacy JSON files are not runtime inputs. Runtime SQLite uses an in-memory mirror/bounded writer; await persistence before acknowledging durable changes. Saved rooms integrate with live viewing, while playback authority remains process-local. Remote consent always remains ephemeral.
- See [docs/self-hosting.md](docs/self-hosting.md) for the full configuration reference.
- Entry, personal Plex-server admission and playback credentials are separate policies (`server/access-policy.js`). The optional shared password is additional to provider rules. Fallback sharing is explicitly enabled by default and may use a dedicated token; never sponsor expired/revoked credentials, provider failures or item restrictions. Required personal Plex-server access cannot be bypassed by fallback; the explicit Activity exception applies only to server-verified Activity identities and never to browser handoffs. Activity-only viewing requires a verified Activity identity; browser linking remains separate from playback.
- Single-room mode fixes the creator to an explicit Plex leader ID, otherwise `discord.owner_id` for Discord sign-in or the verified `plex.token` account for Plex-only sign-in; both methods off retains the Discord owner. It assigns configured Discord/Plex admins as initial hosts, forbids leadership transfer and substitutes reset for deletion. Admin mode remains explicit and grants creator rights; ordinary hosts cannot edit management permissions. Conversion policy/counting is shared across Plex output jobs and uburoom conversion jobs, with hardware-first QSV/NVENC selection and configurable CPU fallback under the same reservation.

---

## Room Model & Command Engine

- **Terminology rule:** Use **"room"** for watch parties, UI elements, lobby dialogs, and Discord commands. Reserve **"session"** strictly for low-level technical contexts (HTTP cookie sessions, WebSocket connections, Plex transcode sessions).
- Live watch rooms remain **in-memory** (`Map` in `server/core.js` and `server/watch.js`). M1-P13 is explicitly authorized: P13-1 through P13-5 implement durable records, live lifecycle, manual/bulk queues, following/random generation, shuffle and verified cancellable autoplay. Read [the current review point and handoff](docs/rooms-and-queues.md) before continuing. Never persist remote consent or treat a stored record as current playback authority.
- Rooms have an owner, viewers, media, playback state (position, paused, muted, volume, seekable), visibility (public/private), mode, controls, epochs, and optional scheduled starts.
- **Every control surface** — web watch page, extension remote, Discord bot, Discord Activity — sends commands through the shared validated handler in `core.js` via the shared `Engine` (`shared/engine.js`). Never bypass it with direct state mutation or a parallel control path.
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
- Plex OAuth tokens are encrypted with **AES-256-GCM** using a 32-byte key. The key file defaults to `LOCALAPPDATA/uburoom/credentials.key` on Windows, `XDG_DATA_HOME/uburoom/credentials.key` (normally `~/.local/share/uburoom/credentials.key`) on Linux, and `~/Library/Application Support/uburoom/credentials.key` on macOS and **must be stored outside the project folder** (startup validates this).
- Credentials belong in **private server configuration** (`config.yaml`, gitignored) or **extension storage** (`browser.storage.local`). Never log, commit, or package secrets, private state, TLS certificates, or key files.
- See [docs/upgrading.md](docs/upgrading.md) for current pre-release transition notes and rules preserving UUIDs and exact original key bytes when retaining state.

---

## Naming & Branding

- Use **uburoom** names throughout all code, UI, docs, and assets. `/ubu` and `!ubu` are the only Discord commands (not `!uburoom`). The `session.*`/`/api/sessions` watch-room aliases are removed; all clients must use the canonical room protocol.
- The brand transition is tracked in the roadmap. Public GitHub repository creation is deferred until the transition is complete.

---

## Extension (YouTube TV Remote)

- **Firefox MV3.** The extension is Manifest V3 (Gecko ID `uburoom@uburoom.com`, min Firefox 115.0). Keep permissions narrow — only explicitly configured HTTPS origins, never `<all_urls>`.
- The current extension is Firefox-only. Chromium extension support is deferred to M2-P10; it is not part of M1-P8 extraction. This does not establish a Firefox-first policy for the web app.
- **Configured builds** are generated and packaged in uburoom-remote, with explicit HTTPS origins and matching permissions/CSP. No unrestricted host access. This repository owns the server integration and optional cross-repository fixtures only.
- Communication flow: `content.js` ↔ `background.js` (via `browser.runtime` messaging) ↔ server (via WebSocket with device ID + credential auth). The popup (`popup.js`) also talks to `background.js`.
- `shared/engine.js` is this repository's command engine. uburoom-remote owns its own versioned copy. Keep the common protocol/validation contract stable through matching fixtures and separately versioned builds; never import another checkout's source at runtime.
- `room-protocol.js` owns room/playback validation and `viewport.js` owns transform/profile validation and picture calculations. The engine dispatches between them. Keep both protocol revisions and matching fixtures coordinated; see [remote integration contract](docs/remote-protocol.md).
- The known full extension smoke timing issue is deferred; do not weaken permissions or throttling to hide it.

---

## Web Client & Player

- The watch page (`web/watch.html` + `web/watch.js`) is an SPA. It uses a standard `<video>` element, HLS.js for HLS streams, and native playback for direct streams.
- **Sync timing:** Clock offset estimation (midpoint exchange, rolling low-delay filter, bounded slew). Initial readiness publishes a start 1.75s in the future. Drift correction via `web/playback-timing.js`.
- **Playback decisions:** Resolve Plex access → gather runtime codec support → prefer direct → consider remux/audio-only → fall back to full conversion. Delivery paths: Original (direct file), Plex HLS (H.264/AAC), local WebM/Opus: AV1 (QSV/NVENC/software), VP9 (probed QSV/software) and VP8 (software). Ordered allowed codecs participate in conversion sharing and bounded fallback; use decoded frames rather than positive support hints to claim playback.
- **Recovery:** Bounded retries, HLS session refresh, 60s reconnect grace, host heartbeat loss revokes consent. See [docs/playback-reliability.md](docs/playback-reliability.md).
- Report unsupported or site-dependent behavior honestly — do not silently swallow codec/browser limitations.

---

## UI & Design

- Read [docs/design-guide.md](docs/design-guide.md), the self-hosted SVG pack in `web/icons.js`, and relevant web styles before UI work. UI assets have per-repository ownership without cross-repository filesystem imports. **Inspect affected rendered surfaces** before and after changes.
- **Color tokens:** background `#101217`, card `#1B1E26`, elevated `#292E38`, border `#393F4D`, text `#F8F7F4`, muted `#AAB0BC`, orange `#FF9954` (main accent), pink `#FF7197` (brand accent), green `#158761` (remote enabled).
- **Icons:** The ONLY active icon provider is `web/icons.js`: vendored **Tabler outline** SVGs with 24×24 viewBox, `currentColor` strokes and rounded ends/joins, plus the original monochrome `oomark` for Room. `web/remote-ui.js` contains an inert, commented-out archive of prior SVG paths — do not reuse or uncomment it.
- **Adding a future icon:** When the owner names a Tabler icon (usually by its exact Tabler slug), get the official outline SVG from `https://github.com/tabler/tabler-icons/blob/main/icons/outline/<slug>.svg`; verify it exists and append its inner SVG elements as a quoted string under the exact slug in `glyphs` inside `web/icons.js`. Preserve the official paths/geometry; use the existing `icon(doc, 'slug')` entry point. If existing code uses a semantic name, add a matching entry in `aliases`. keep the Tabler MIT notice in `web/vendor/THIRD_PARTY_NOTICES.txt`, and inspect Chrome/Firefox rendering. No CDN, webfonts, arbitrary generated icons, additional runtime fetches, or dependency on `remote-ui.js` for icons. See [docs/design-guide.md](docs/design-guide.md#icon-button-rules).
- **Stateful icons:** `captions` always uses outline `badge-cc` (the active state uses `aria-pressed` and styling); `volumeName(percent, muted)` picks `volume-off`, `volume-4`, `volume-2`, or `volume`; configurable seek intervals use Tabler 15/30/60 backward/forward icons. Refresh spinners rotate counter-clockwise.
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
- Quality defaults: Original, 1080p at 20/12/8 Mbps, 720p at 4/2 Mbps; owners can configure validated [height, Mbps] pairs. Server-side offered choices remain authoritative.
- Optional FFmpeg/FFprobe for AV1 encoding (`server/av1.js`) and subtitle extraction.

---

## Testing — lean, risk-based, and deliberately finite

**Default: do not add a test.** The owner wants a small, meaningful regression suite, not a new test for every change, bug report, UI detail or implementation branch. Reducing test maintenance is a feature, not a deficiency to be compensated for. Do not rebuild retired suites or smoke scripts just because an old document mentions them.

- **Keep tests for costly failures:** authentication/authorization, consent, credential isolation, private data, durable SQLite state and room/queue commands, protocol compatibility, and actual media/playback/sync correctness. Favor a few black-box invariants over many implementation-level assertions.
- **Do not add tests for:** HTML/CSS class or markup spelling, icon geometry/aliases, theme toggles, trivial formatters, labels, reexports, one-line wrappers, obvious defaults, static source-text searches, or mocked behaviors that only restate the mock. Visual changes are verified through approved rendered inspection, not brittle DOM snapshots.
- **Before writing a test, ask:** Does this catch a plausible important failure that a *retained* test cannot? Can one scenario in an existing file cover it? Is the expected result independent of the implementation under test? If not, stop. A bug fix does not automatically require a new permanent test.
- **Prefer consolidation and deletion:** Remove redundant, obsolete, flaky, superseded, or slow cases as part of related work. Prefer one targeted end-to-end or contract test to a matrix of synthetic edge permutations. No coverage targets, assertion counts, exhaustive parameter matrices or test-file quotas.
- **Smoke tests are exceptional:** Keep the small set of runnable `scripts/*-smoke.js` checks for distinct browser boundaries. Run them only when the changed area needs browser evidence. Do not create a feature-specific smoke runner as a reflex; a new permanent smoke runner requires a clearly unique high-risk failure mode and explicit owner approval. Existing broad `npm run test:playback` is preferred for decoded video/audio evidence.
- **Run proportionately:** Use `node --test tests/<relevant-file>.test.js` while working on risky logic, and `npm test` or `npm run test:full` before broadly claiming regression confidence or preparing a release. Do not require a full-suite rerun or browser sweep for every text, style or documentation edit. Report exactly what ran and any skips; do not claim passes from reading code.
- **Never replace real evidence with fixture confidence.** Preserve distinct verification levels: A (source review), B (isolated automated execution), C (authorized real-provider/device integration), D (human acceptance). C and production/deployment changes require separate explicit permission. Chrome and Firefox remain equal targets when browser checks are actually warranted. Tests do not substitute for the owner's design approval or release acceptance.

Keep [docs/testing.md](docs/testing.md) as a concise, current verification dashboard and [docs/archive/testing-2026-10-22.md](docs/archive/testing-2026-10-22.md) as historical evidence. Old script names and historical pass counts are archival, **not a mandate to restore removed tests**. Record material new evidence with date/commit, scope, method, command and limitations; don't churn the dashboard for routine unexecuted changes.

---

## Development Workflow

- **Develop and install on local disk.** Use isolated fixture accounts/media; never run a second process against production bot credentials or data.
- **Setup:** `npm ci`, generate a dev certificate and run `node scripts/watch-demo.js --accounts` for a synthetic demo. Run relevant tests when the change warrants them; use `npm test` for full regression confidence, not as an automatic condition of every edit.
- **Extension dev:** Use uburoom-remote's source, build/configuration scripts and independent tests. Integration fixtures here require an explicit external build path; no sibling checkout layout is assumed.
- **Vendor builds:** `npm run build:player` bundles Discord SDK, HLS.js, and subtitle renderers via esbuild into `web/vendor/`.
- **Database:** `data/accounts.sqlite` is created automatically on first run. The credential key file must exist and be outside the project folder.
- See [docs/development.md](docs/development.md) for the full dev guide. Codec tester access is in Other during active Admin mode, with protected synthetic samples. M1-P11 uses transport-neutral room operations directly from WebSockets while preserving necessary HTTP resources.

---

## Commits, Releases & Publication

- Keep commits **small and focused**. Documentation should be generic and public-facing.
- Keep personal deployment notes, scripts, and configs in the **ignored `/personal/` folder**. Never stage, commit, package, or publish them. Keep personal paths, screenshots, migration diaries, and reference projects out of publication history.
- **No production changes without explicit approval:** no restart, config, DNS, Cloudflare, or Discord-registration changes; no signing, publication, or public push.
- Deliver the application source as a **timestamped ZIP** via `scripts/package.ps1` (filtered `git ls-files`, including `shared/` and LICENSE). Extension/source/MV2 fallback archives belong to uburoom-remote's packaging script. Audit source, full publication history, assets, notices, and ZIP contents before release.
- **License:** First-party source is `GPL-3.0-only`. Preserve third-party licenses/notices (see [docs/third-party.md](docs/third-party.md) and `web/vendor/THIRD_PARTY_NOTICES.txt`). Include `LICENSE` in all distributions. Artwork/media provenance remains a release gate.
