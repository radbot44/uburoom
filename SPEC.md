# uburoom product specification

uburoom is a self-hosted Plex watch-together application. Each installation supplies its own Plex server, Discord application/bot/guild, public HTTPS origin and credentials. One Node process serves the website, APIs, Discord integration and media transport; SQLite stores linked accounts and native playback history.

## Watch rooms

Authenticated eligible users create/join rooms in a browser or Discord Activity. Public/private viewing is independent of remote command consent. The host chooses media/manages the room; eligible remaining viewers can inherit hosting. Shared play/pause/seek/picture use a server-owned timeline with readiness and late-join behavior. Volume/mute/quality remain personal.

Check access before and after awaited catalog/media operations. A linked Plex user's denied/revoked access must never fall back to the configured owner token. Account UUIDs remain stable across verified links/merges. Device/browser/provider credentials stay private; encrypted records require the original key.

## Commands and included remote

Keyboard, extension, web and Discord controls use one validated engine. Remote consent starts off and clears on disconnect/restart. Commands have short TTLs, truthful acknowledgements and no replay; ambiguous or unavailable targets are rejected.

Firefox YouTube TV picture controls work locally without a server. Remote connectivity uses configured HTTPS origins and narrow permissions. Seek/channel behavior depends on the actual site; no public YouTube TV control API is assumed. Safe DOM, existing shortcuts/OSD and independent title indicators are required.

## Boundaries

Keep one repository initially. An independent remote, native-player integration, project-hosted rooms and managed room URLs are future work, not installation requirements. Preserve the established UI design. Graphics, licensing/provenance, existing-instance upgrade and unrelated-host clean-install/live checks remain release gates. See docs/testing.md and docs/upgrading.md.
