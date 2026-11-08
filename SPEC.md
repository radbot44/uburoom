# uburoom product specification

See [ROADMAP.md](ROADMAP.md) for priorities and milestone status. This specification defines product behavior and boundaries; detailed verification evidence stays in [docs/testing.md](docs/testing.md).

uburoom is a self-hosted Plex watch-together application. Each installation supplies its own Plex server, Discord application/bot/guild, public HTTPS origin and credentials. One Node process serves the website, authenticated room WebSockets, HTTP auth/catalog/media APIs, Discord integration and media transport; SQLite stores linked accounts and native playback history.

Reliable, smooth playback for nontechnical viewers is the primary player goal. Browser and Discord Activity playback should automatically select and recover compatible delivery while preserving the chosen video content, audio and subtitles. Plex-level video content coverage and real client verification are tracked in [the playback reliability plan](docs/playback-reliability.md); that plan is not a claim of completed support.

On-demand playback must preload useful video while paused, retain a bounded rewind cache, show actual loaded ranges and recover from seeks and temporary delivery failures. Buffer targets must account for bitrate and memory; native browser caching and real Plex/Activity behavior require separate verification.

## Watch rooms

Authenticated eligible users create and join watch rooms in a web browser or Discord Activity. Multi-room is the default; `rooms.single_room` provides a dedicated single-room mode. Room creators act as room leaders; host permissions can be shared or inherited by remaining viewers when a host departs. Server administration requires explicit Admin mode; host privileges alone do not grant server administration.

Rooms may be public or private. Each room maintains a distinct invite code (`/join/<code>`) for sharing via the device share sheet, clipboard, or Discord Activity. When enabled (`guests.enabled`), room invites can admit external guests without host or administrative rights, isolated to their room and using shared fallback media without Plex reporting.

Durable rooms, hosts, permission overrides, bookmarks, playback queues and history persist in SQLite across server restarts. Auto-resume requires previous play intent, expected viewers returning inside the recovery window, fresh readiness and an authorized controller; live viewer sessions, consent and streams are never restored from disk.

Retain durable per-viewer playback history and decoupled Plex session reporting across clients/servers; connected Plex accounts default to activity-only reporting while personal resume and watched-state writes require explicit per-viewer opt-in, and sponsored viewers remain local-only. Check access before and after awaited catalog/media operations. A linked Plex user's denied/revoked access must never fall back to the configured owner token. Account UUIDs remain stable across verified links/merges. Device/browser/provider credentials stay private; encrypted records require the original key. See [rooms and queues](docs/rooms-and-queues.md) and [accounts and access](docs/accounts-and-access.md).

## Watch-room commands & synchronization

Room interactions and playback mutations route through an authenticated WebSocket protocol (`/watch-socket`) powered by a shared, validated command engine. The engine verifies actor permissions, room state, media version and command eligibility on every operation. Ambiguous targets, stale commands and unauthorized requests fail closed with truthful acknowledgements.

Room state advances with monotonic revisions. The server owns the authoritative playback timeline: play, pause, seek, epoch calculation and stream readiness. Viewers maintain clock estimation against server time. Scheduled actions ensure coordinated playback transitions across distributed clients.

Late-joining or seeking viewers pass through server readiness gates before playback begins, preventing desynchronized starts. Active synchronization uses proportional drift correction with Hybrid EMA filtering to maintain smooth frame pacing without audible pitch distortion or visual stutter. Buffer stalls and recovery remain strictly independent per viewer so struggling clients do not interrupt healthy playback. Personal preferences (volume, audio language, subtitle track and appearance) remain client-owned. See [sync core](docs/sync-core.md).

## Boundaries

Keep one uburoom application/service repository, with a stable, authenticated room protocol and a reusable synchronization core in `shared/sync/` (see [docs/sync-core.md](docs/sync-core.md)). The main site should enter the watch interface; browser codec probes belong in explicit development diagnostics, not normal viewer navigation. Companion native-client integration (`plezy-uburoom`), project-hosted rooms and managed room URLs remain optional M2 extensions, not M1 installation requirements; native clients use the authenticated `/watch-socket` protocol, expiring handoff bearer tokens and `delivery=local` local-file synchronization without altering server authority. Before the first public release, remove private pre-release JSON/schema migrations and obsolete room/session compatibility; do not make promises to upgrade unpublished private revisions. Preserve schema evolution and safe upgrade/rollback for subsequent published releases, the established UI design, native history, stable account identities and encryption-key safety. Third-party, font, WASM and branding provenance is recorded in docs/third-party.md; backup/restore, publication history/ZIP audit and unrelated-host clean-install/live checks remain release gates. See docs/testing.md and docs/upgrading.md.
