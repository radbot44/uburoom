# uburoom product specification

See [ROADMAP.md](ROADMAP.md) for priorities and milestone status. This specification defines product behavior and boundaries; detailed verification evidence stays in [docs/testing.md](docs/testing.md).

uburoom is a self-hosted Plex watch-together application. Each installation supplies its own Plex server, Discord application/bot/guild, public HTTPS origin and credentials. One Node process serves the website, authenticated room WebSockets, HTTP auth/catalog/media APIs, Discord integration and media transport; SQLite stores linked accounts and native playback history.

Reliable, smooth playback for nontechnical viewers is the primary player goal. Browser and Discord Activity playback should automatically select and recover compatible delivery while preserving the chosen video content, audio and subtitles. Plex-level video content coverage and real client verification are tracked in [the playback reliability plan](docs/playback-reliability.md); that plan is not a claim of completed support.

On-demand playback must preload useful video while paused, retain a bounded rewind cache, show actual loaded ranges and recover from seeks and temporary delivery failures. Buffer targets must account for bitrate and memory; native browser caching and real Plex/Activity behavior require separate verification.

## Watch rooms

Authenticated eligible users create/join rooms in a browser or Discord Activity. M1 rooms are in memory; durable room restoration and playback queues are planned later and require their own authorization/recovery design. Public/private viewing is independent of remote command consent. The host chooses media/manages the room; eligible remaining viewers can inherit hosting. Shared play/pause/seek/picture use a server-owned timeline with readiness and late-join behavior. Volume/mute/quality remain personal.

Retain durable per-viewer playback history for future Plex timeline, resume and watched-state updates across clients/servers; these Plex writes are not enabled yet and must honor each viewer’s permission and consent. Check access before and after awaited catalog/media operations. A linked Plex user's denied/revoked access must never fall back to the configured owner token. Account UUIDs remain stable across verified links/merges. Device/browser/provider credentials stay private; encrypted records require the original key.

## Commands and remote interoperability

Keyboard, extension, web and Discord controls use one validated engine. The first release uses canonical `room.*` commands without pre-release `session.*` aliases. Room operations use transport-neutral services over authenticated WebSockets; retired HTTP room-control routes return 404. Remote consent starts off and clears on disconnect/restart. Commands have short TTLs, truthful acknowledgements and no replay; ambiguous or unavailable targets are rejected.

The YouTube TV extension is maintained in the independent uburoom-remote repository. Its current Firefox picture controls work locally without a server; Chromium extension support is future work. Remote connectivity uses a versioned authenticated protocol, configured HTTPS origins and narrow permissions. Seek/channel behavior depends on the actual site; no public YouTube TV control API is assumed. Safe DOM, existing shortcuts/OSD and independent title indicators are required.

## Boundaries

Keep one uburoom application/service repository, with a separately maintained Firefox remote extension and a stable, authenticated protocol. The main site should enter the watch interface; browser codec probes belong in explicit development diagnostics, not normal viewer navigation. Native-player integration, project-hosted rooms and managed room URLs remain future work, not installation requirements. Before the first public release, remove private pre-release JSON/schema migrations and obsolete room/session compatibility; do not make promises to upgrade unpublished private revisions. Preserve schema evolution and safe upgrade/rollback for subsequent published releases, the established UI design, native history, stable account identities and encryption-key safety. Graphics, licensing/provenance, backup/restore and unrelated-host clean-install/live checks remain release gates. See docs/testing.md and docs/upgrading.md.
