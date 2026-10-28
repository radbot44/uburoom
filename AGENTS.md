# Working on uburoom

## Scope and authority

- Follow the owner's current task. Read [ROADMAP.md](ROADMAP.md) before planning features; update affected status after material work. Plans do not authorize unrelated implementation or deployment.
- Develop on local disk with isolated fixture accounts/media. Never run a second instance against production credentials or data.
- Production restarts/configuration, DNS/Cloudflare, provider registration, signing, public push and publication require explicit owner approval. Public repository creation waits for the brand transition.

## UI and design

- Before any UI/design investigation, planning or change, read [docs/design-guide.md](docs/design-guide.md) in full, then inspect relevant code, styles, icons and evidence.
- The owner controls UI, styling, interactions, component boundaries, exceptions, sequencing, tests and implementation choices, including fixes and cleanup. Existing code, agent recommendations and silence are not approval; approval for one surface does not cover another.
- Before implementation, present concrete issues/code locations, alternatives, a staged plan and numbered questions for unresolved choices. Wait for explicit answers and implementation authorization; honor choices or discretion already explicitly granted. Ask again when new unresolved choices arise.
- Record approved decisions in the design guide before changing affected code. Inspect rendered surfaces before and after; preserve unmodified approved behavior. Design review does not authorize merging or deployment.
- Use repository-owned assets and safe DOM creation (`createElement` / `textContent`); never use `innerHTML`, `outerHTML` or `insertAdjacentHTML`.

## Architecture

- One Node server process; no clustering. Bounded media child processes and built-in worker threads are allowed. Keep synchronous disk/SQLite I/O and heavy crypto off the playback/tick loop.
- Plain JavaScript: server CommonJS, browser native modules/scripts; 2 spaces, semicolons, single quotes. Use JSDoc and `// @ts-check` for complex contracts. No framework, TypeScript compiler, JSX, transpilation or minification; esbuild is only for vendor bundles.
- Use built-in SQLite and the existing storage worker/database. No ORM, external or secondary database. Preserve schema versioning for published upgrades; do not restore private pre-release import/compatibility paths.
- Minimize dependencies; justify additions and prefer Node built-ins. Tests use `node:test` and `node:assert/strict`. Runtime requirements and dependencies belong in `package.json`.

## State, configuration and access

- Private `config.yaml` is the sole configuration authority; `--config` selects another file and relative paths resolve beside it. No `.env` loading or application environment overrides. Validate before opening state/contacting providers; distribute only `config.example.yaml`. When adding or modifying configuration settings, keep `config.example.yaml`, schema validation in `server/config.js`, and installation diagnostics in `scripts/doctor.js` synchronized; verify changes with `npm run doctor`.
- Preserve canonical account UUIDs and the exact original credential-encryption key. Never generate a replacement key for an existing database. Keys must remain outside the project; see [upgrading](docs/upgrading.md). In container deployments, persist data and the encryption key via external host directory mounts outside replaceable container storage; bind `server.host: '0.0.0.0'`.
- Until final release preparation, keep private config/data migration scripts in ignored `personal/migrations/`. Run only explicitly authorized migrations, never automatically at startup/deployment; preserve original key and state paths.
- Separate sign-in, admission, personal Plex entitlement, sponsored media, room roles and server administration. Shared passwords supplement provider rules. Configured sponsorship is enabled by default, but expired/revoked credentials, provider failures and item restrictions must fail closed.
- Required personal Plex access cannot be bypassed by fallback. Its Activity exception requires server-verified Activity identity and never transfers to browser handoffs. Direct fallback delegation requires explicit opt-in and a dedicated non-owner account.
- Preserve single-room fixed ownership/reset rules and explicit Admin mode; ordinary hosts cannot edit management permissions. Detailed policy lives in [accounts/access](docs/accounts-and-access.md), [rooms/queues](docs/rooms-and-queues.md) and [self-hosting](docs/self-hosting.md).

## Room and playback invariants

- Use **uburoom** and **room** throughout. Reserve “session” for technical connections/auth/media contexts; do not restore legacy room aliases.
- Every control surface uses the shared validated command engine. Never bypass it with direct mutations or a parallel control path. Authorize actor, applicable guild/channel, room eligibility and current permissions on every operation.
- Hide inaccessible rooms, reject ambiguous targets and expire pending commands; never replay stale commands or restore viewer consent from durable room state.
- The server owns the shared timeline; viewers own quality, audio, subtitles and volume. Keep ongoing buffering/recovery independent so a struggling viewer does not pause healthy viewers.
- Preserve per-viewer authorization and track choices through preparation, shared conversion and recovery. Count Plex/local conversion jobs under the shared capacity policy; server-offered quality choices remain authoritative.
- Use bounded recovery and truthful errors, never production mock/demo fallbacks. Command acknowledgements and codec hints do not prove decoded playback. Detailed delivery/sync behavior belongs in [playback reliability](docs/playback-reliability.md).

## Testing

- **Default: do not add a test.** Retain tests for costly authorization, consent, credential/data, persistence, protocol and actual playback/sync failures. Prefer extending an existing meaningful scenario; consolidate or delete redundant tests.
- No tests for markup/class spelling, icon geometry, trivial labels/defaults/wrappers, source-text matching or mocks that restate themselves. No coverage quotas, exhaustive permutation matrices or brittle visual snapshots. Do not resurrect retired suites from historical references.
- New permanent smoke runners require a distinct high-risk boundary and explicit owner approval. Prefer existing playback checks for decoded picture/audio.
- Run focused tests for affected risky logic; run the full suite before broad regression/release claims. Avoid full sweeps for documentation/style edits. Treat Chrome and Firefox equally when browser verification is warranted.
- Report actual commands, failures and skips. Distinguish A source review, B isolated execution, C real integration and D human acceptance. C requires explicit permission; fixtures cannot establish live support and tests cannot replace design/release acceptance.
- Put material results and open gates in [testing](docs/testing.md), with date/revision, scope and limitations. Keep detailed historical evidence in linked archives/artifacts, not AGENTS or ROADMAP.

## Repository hygiene

- Keep commits focused and public docs generic. Never stage, commit, package or publish `personal/`, private configuration, credentials, personal paths or private evidence.
- First-party code is GPL-3.0-only. Include LICENSE in distributions and preserve third-party notices/source obligations; maintain provenance and attribution in [docs/third-party.md](docs/third-party.md).
- Use [development](docs/development.md) for setup, commands and diagnostics. Keep this file limited to durable agent rules; do not append feature status, implementation inventories or work diaries.
