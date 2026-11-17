# Working on uburoom

Follow the owner's current task and the repo's approved boundaries. [README.md](README.md) covers the product, [SPEC.md](SPEC.md) the product contract, and [ROADMAP.md](ROADMAP.md) priorities and open gates. Planned work is not permission to implement unrelated features. Keep this file for durable agent rules, not status, handoffs or work diaries.

## Authority and workflow

- Use isolated local fixtures and media for development. Never start another process against production credentials or data. Production restarts/configuration, DNS/Cloudflare changes, provider registration, signing, publication and public push require explicit owner authorization. Do not run migrations or live-provider/device experiments without permission.
- **For UI work**, consult the relevant [design principles](docs/design-guide.md), [approved screen behavior](docs/ui-behavior.md), actual code/styles and rendered evidence. Read the entire guide only for a broad design-system change, not a targeted bug investigation.
- Preserve established, owner-approved UI decisions. Within an authorized task, **routine fixes that restore existing behavior** may be implemented and verified without asking the owner to re-approve every step. Before changing visual direction, interaction semantics, component boundaries or an unresolved product choice, present the concrete issue, relevant alternatives and a recommendation, and obtain approval. Explicit discretion in the current task counts; silence and agent suggestions do not.
- For material new UI decisions, record the approved rule in its owning design document. Inspect affected rendered surfaces before/after where practical; do not equate fixture screenshots with human acceptance. UI approval does not grant deployment permission.

## Architecture and code

- One Node server process, with bounded media child processes and worker threads where needed. Keep SQLite writes short and measured; no unbounded database work or heavy crypto on the playback/tick loop.
- Plain JavaScript: server CommonJS, browser native modules/scripts; 2 spaces, semicolons, single quotes. Use JSDoc and `// @ts-check` for complex contracts. No runtime framework, compiled TypeScript, JSX, transpilation or minification. `tsc --noEmit` is checking; Prettier/ESLint are development tools; esbuild is for vendor bundles.
- Use Node's built-in SQLite with one direct connection to the existing database; no ORM or second database. Preserve published schema migration discipline, without reviving private pre-release import/compatibility paths.
- Minimize dependencies and abstraction. Keep the reusable timeline, clock, readiness, drift, room-role, envelope and publication core in `shared/sync/` independent of Plex, Discord, FFmpeg, TLS, YAML and SQLite; see [sync core](docs/sync-core.md). Optional Cephalopod integration is documented separately and is not a self-hosted release requirement.

## Configuration, identity and access

- Private `config.yaml` is the sole configuration authority; `--config` selects another file and relative paths resolve beside it. No `.env` or application environment overrides. Validate before opening state/providers. Keep `config.example.yaml`, `server/config.js` and `scripts/doctor.js` in sync when settings change; run `npm run doctor`.
- Preserve canonical account UUIDs and the **original credential encryption key**. Never regenerate the key for an existing database. Store keys and data outside replaceable code/container storage; see [upgrading](docs/upgrading.md). Private pre-release migrations stay in ignored `personal/migrations/`, run only when authorized and never at startup.
- Keep identity, room admission, personal Plex entitlement, sponsored access, room roles and server administration separate. Authorization is checked per operation and again after awaited provider work. Required personal Plex access cannot be bypassed by fallback; Activity identity exceptions must be server-verified and do not transfer to browser handoffs. Delegated direct fallback needs an explicitly opted-in non-owner account.
- Enforce revocation and item restrictions; provider failure is not a grant or a denial of an admitted viewer's existing place. New admissions fail closed during an outage. Preserve fixed-owner/single-room reset rules and explicit Admin mode. Details: [accounts and access](docs/accounts-and-access.md), [rooms and queues](docs/rooms-and-queues.md), [self-hosting](docs/self-hosting.md).

## Rooms and playback

- Use **uburoom** and **room** for the product; reserve “session” for technical contexts. Do not restore retired room aliases.
- Use the one validated command engine for every room/playback mutation: check actor, room, permissions, generation and expiry. Hide inaccessible rooms; use room IDs; do not replay stale commands or restore consent from disk.
- The server owns the shared timeline, while viewers own quality, audio, subtitles and volume. Recovery and buffering are per-viewer and must not pause healthy viewers. Preserve per-viewer access and selected tracks across preparation, conversion and recovery; count jobs against shared capacity.
- Errors must be truthful. A command ack or codec hint is not proof of decoded playback. Do not add production mock/demo fallbacks. Consult [playback reliability](docs/playback-reliability.md), [wire protocol](docs/wire-protocol.md) and [sync core](docs/sync-core.md) for changes touching those boundaries.

## Verification and repository hygiene

- Write or extend **focused regression tests when a meaningful failure could recur**, especially authorization, consent, credentials, durability, protocol, playback and synchronization. Avoid tests for trivial markup, label/class spelling, mock self-confirmation, source-text matching and brittle visual snapshots. No coverage quotas or exhaustive matrices. New permanent smoke runners need a distinct high-risk boundary and owner approval.
- For UI fed by background updates, trace its subscriptions, resyncs and timers during review. Exercise the actual refresh path while the affected view is scrolled, a control is focused or a draft is being edited; verify that unchanged data preserves DOM identity, focus, scroll and drafts, and that changed data updates only the affected content. Initial-load screenshots alone do not verify refresh behavior. Extend an existing browser runner when this boundary needs a regression test.
- Run focused checks for affected behavior; full suite for broad regression/release claims, not documentation-only changes. Use Chrome and Firefox when rendered/browser checks matter. Report exact commands and failures/skips, distinguishing source review (A), isolated execution (B), real integration (C) and human acceptance (D). Live C requires permission. Keep current evidence and open gates in [testing](docs/testing.md); archive historical evidence.
- Do not stage, commit or publish `personal/`, secrets, config, private state, credentials or evidence. First-party code is GPL-3.0-only; preserve license, provenance and third-party notices ([third-party](docs/third-party.md)). Commands and diagnostics belong in [development](docs/development.md).
