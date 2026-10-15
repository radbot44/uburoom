# Working on uburoom

uburoom is a self-hosted Plex watch-together app with a browser interface, Discord Activity, bot integration and linked accounts. The Firefox YouTube TV remote stays in this repository; native-player integration and a remote split are future milestones.

1. Prefer one Node process, ordinary JavaScript, built-in SQLite and minimal dependencies. No unrelated rewrites or infrastructure.
2. Develop/install on local disk. Use isolated fixture accounts/media; never run a second process against production bot credentials or data.
3. Remote consent starts off after session/tab/browser/server restart or disconnect. Authorize actor, guild/channel, session eligibility and current permissions for every command. Hide inaccessible/private sessions, reject ambiguous targets and never replay stale commands.
4. All control surfaces use the shared validated command engine. Preserve synchronization, linking and per-user Plex scopes. Server acknowledgement is not proof of client playback.
5. Use uburoom names throughout, with `/ubu` and `!ubu` as the only Discord commands. No legacy aliases or wrappers. Preserve account UUIDs, encrypted credentials and the exact original key bytes when moving state; see docs/upgrading.md.
6. Credentials belong in private server configuration or extension storage. Never log, commit or package secrets, private state or TLS/key files. Keep the original encryption key matched to account data; never generate a replacement for an existing database.
7. Use safe DOM creation/textContent in the player, never unsafe HTML sinks. Use standard media APIs and report unsupported/site-dependent behavior honestly.
8. Title indicators are independent: 🟢 only for that session's confirmed reachable remote enablement; 🔵 only for non-default transforms. Preserve SPA titles without duplicate prefixes.
9. Read docs/design-guide.md and the shared styles/SVGs in extension/remote-ui.js before UI work. Inspect affected rendered surfaces. Preserve colors, typography, icons, spacing, accessibility and layout. Do not invent replacement graphics.
10. Firefox-first; keep permissions narrow. Configured builds accept explicit HTTPS origins with matching permissions/CSP. No unrestricted host access. Real lifecycle/latency checks are separate from fixtures.
11. Run relevant tests without unexpected skips. Keep unfinished work in docs/testing.md. The known full extension smoke issue is deferred; do not weaken permissions/throttling to hide it.
12. Keep commits small and documentation generic/public-facing. Personal deployment notes, paths, screenshots, migration diaries and reference projects belong outside this checkout and publication history.
13. No production restart/config/DNS/Cloudflare/Discord-registration changes, signing/publication or public push without explicit approval. GitHub creation is deferred until the brand transition is complete.
14. Deliver distributable bundles as ZIPs. Audit source, full publication history, assets, notices and ZIP contents before release. First-party source is GPL-3.0-only; preserve third-party licenses/notices and include LICENSE in distributions. Artwork/media provenance remains a release gate.
