# uburoom product specification

See [ROADMAP.md](ROADMAP.md) for priorities and milestone status. This specification defines product behavior and boundaries; detailed verification evidence stays in [docs/testing.md](docs/testing.md).

uburoom is a self-hosted Plex watch-together application. Each installation supplies its own Plex server, Discord application/bot/guild, public HTTPS origin and credentials. One Node process serves the website, authenticated room WebSockets, HTTP auth/catalog/media APIs, Discord integration and media transport; SQLite stores linked accounts and native playback history.

Reliable, smooth playback for nontechnical viewers is the primary player goal. Browser and Discord Activity playback should automatically select and recover compatible delivery while preserving the chosen video content, audio and subtitles. Plex-level video content coverage and real client verification are tracked in [the playback reliability plan](docs/playback-reliability.md); that plan is not a claim of completed support.

On-demand playback must preload useful video while paused, retain a bounded rewind cache, show actual loaded ranges and recover from seeks and temporary delivery failures. Buffer targets must account for bitrate and memory; native browser caching and real Plex/Activity behavior require separate verification.

## Watch rooms


Retain durable per-viewer playback history and decoupled Plex session reporting across clients/servers; connected Plex accounts default to activity-only reporting while personal resume and watched-state writes require explicit per-viewer opt-in, and sponsored viewers remain local-only. Check access before and after awaited catalog/media operations. A linked Plex user's denied/revoked access must never fall back to the configured owner token. Account UUIDs remain stable across verified links/merges. Device/browser/provider credentials stay private; encrypted records require the original key.

## Watch-room commands



## Boundaries

Keep one uburoom application/service repository, with a stable, authenticated room protocol. The main site should enter the watch interface; browser codec probes belong in explicit development diagnostics, not normal viewer navigation. Companion native-client integration (`plezy-uburoom`), project-hosted rooms and managed room URLs remain optional M2 extensions, not M1 installation requirements; native clients use the authenticated `/watch-socket` protocol, expiring handoff bearer tokens and `delivery=local` local-file synchronization without altering server authority. Before the first public release, remove private pre-release JSON/schema migrations and obsolete room/session compatibility; do not make promises to upgrade unpublished private revisions. Preserve schema evolution and safe upgrade/rollback for subsequent published releases, the established UI design, native history, stable account identities and encryption-key safety. Third-party, font, WASM and branding provenance is recorded in docs/third-party.md; backup/restore, publication history/ZIP audit and unrelated-host clean-install/live checks remain release gates. See docs/testing.md and docs/upgrading.md.
