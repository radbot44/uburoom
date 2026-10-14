# Verification status

Automated tests cover parsing/target resolution, permissions/private visibility, stale commands, account linking/encryption/persistence, native tracking, isolated HTTP/media boundaries and configured extension origins. Generate local test TLS first; a suite with skipped tests is not a full baseline.

Firefox watch/account/tracking fixtures use real browser decoding with synthetic media/providers. Activity layout/metadata in fixtures is simulated; real Activity delivery and Plex permissions remain separate checks.

The full extension Firefox fixture has an unresolved failure around restoring guest controls/rate-limit disconnects. Investigation is deferred. Do not describe it as passed or relax authorization/throttling to hide it.

Before release, separately verify:

- Clean install with unrelated domains, Plex/Discord credentials and fresh browser profiles.
- Upgrade retaining original account key/data, browser auth, extension identity/settings/pairing and commands.
- Restricted Plex accounts/revocation and per-viewer Original/HLS/AV1, without owner-token fallback.
- Native observations under buffering, seek/reconnect, quality/host changes and multiple viewers. Plex timeline/watch-state reporting remains disabled; actual monitoring experiments require consenting accounts and must account for resume/history effects.
- Real Activity SDK authorization, browser handoff, proxy media and PIP events.
- Actual Firefox/YouTube TV controls/audio/seek, tab-close/offline consent and latency; MV3 idle/sleep-wake and optional MV2 comparison.
- Full publication history, ZIP contents, private information/secrets and code/media/artwork attribution.

Server acknowledgement is not playback evidence. Never replay stale commands or restore remote consent.
