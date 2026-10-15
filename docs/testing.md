# Verification status

Automated tests cover parsing/target resolution, permissions/private visibility, stale commands, account linking/encryption/persistence, native tracking, isolated HTTP/media boundaries and configured extension origins. Generate local test TLS first; a suite with skipped tests is not a full baseline.

Firefox watch/account/tracking fixtures use real browser decoding with synthetic media/providers. Activity layout/metadata in fixtures is simulated; real Activity delivery and Plex permissions remain separate checks.

## Local migration checks

The migration baseline completed 66 automated tests, a fresh-checkout dependency install and shared-watch Firefox playback, plus blocked-autoplay/native-tracking checks with regenerated synthetic media. The complete naming transition passes 67 automated tests with zero skips/failures, including `/ubu` registration/routing, Firefox shared-watch playback and startup of the new extension identity. An offline copied-state startup retained account/identity/credential/device records with unchanged key bytes and no network calls; rooms, remote consent and Admin mode began off. Missing-key startup was refused. The naming transition requires browser sign-in and a new extension installation/pairing.

These checks used one development machine, local test TLS and offline/simulated providers. They do not replace an unrelated-host setup or actual provider/extension upgrade. Public ZIP and complete-history privacy checks remain required for each release revision.

The full extension Firefox fixture has an unresolved failure around restoring guest controls/rate-limit disconnects. Investigation is deferred. Do not describe it as passed or relax authorization/throttling to hide it.

Before release, separately verify:

- Clean install with unrelated domains, Plex/Discord credentials and fresh browser profiles.
- Upgrade retaining the original account key/data, with fresh browser sign-in and new-extension pairing; verify `/ubu` and `!ubu` against the real configured guild.
- Restricted Plex accounts/revocation and per-viewer Original/HLS/AV1, without owner-token fallback.
- Native observations under buffering, seek/reconnect, quality/host changes and multiple viewers. Plex timeline/watch-state reporting remains disabled; actual monitoring experiments require consenting accounts and must account for resume/history effects.
- Real Activity SDK authorization, browser handoff, proxy media and PIP events.
- Actual Firefox/YouTube TV controls/audio/seek, tab-close/offline consent and latency; MV3 idle/sleep-wake and optional MV2 comparison.
- Full publication history, ZIP contents, private information/secrets and code/media/artwork attribution.

Server acknowledgement is not playback evidence. Never replay stale commands or restore remote consent.
