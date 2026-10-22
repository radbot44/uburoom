# Direct Plex HLS design

## Owner direction — 2026-10-22

The owner requested that uburoom be able to coordinate Plex playback without receiving or inspecting the video. This supersedes the earlier recommendation to retain a server-cached first segment for direct HLS. The owner subsequently requested continued implementation and testing of shared Plex output. The path below is implemented, with isolated browser evidence, a bounded same-account real Plex protocol probe and owner-reported external phone playback through personal and fallback access. A subsequent direct-playlist recovery improvement remains local; broader live validation is still pending. See [verification](testing.md#direct-plex-hls-2026-10-22).

For direct delivery, uburoom acts as the access and room coordinator. The browser receives media from Plex and interprets its timestamps. The server owns the shared timeline, commands, access checks and Plex playback lifecycle; it must not require video bytes to establish synchronization or readiness.

## Transport boundaries

| Path | uburoom server responsibilities | Media bytes |
| --- | --- | --- |
| Direct original file | Authorize, delegate credentials, coordinate room state and consume bounded viewer observations. | Plex → browser, as implemented today. |
| Direct Plex HLS, local candidate | Authorize, prepare and manage Plex output, provide a viewer-specific playback descriptor and coordinate room state. | Plex → browser for every video/audio segment, including any timestamp anchor. No server cache warm-up or media probe. |
| Proxied Plex HLS | Retain existing authorized manifest rewriting, segment proxying and cached timestamp anchor. | Plex → uburoom → browser. |
| uburoom AV1/VP9/VP8 conversion | Read authorized source media, encode and serve output under the existing conversion policy. | Necessarily passes through the conversion server. This is a separate optional capability, not a prerequisite for direct delivery. |

`auto` is a route-selection policy, not a third transport. A successful direct attempt must meet the no-media-bytes requirement. If it recovers through the proxy, the proxy's existing caching behavior applies and the reported delivery route must change. The existing `proxy` default remains unchanged. A strict mode that refuses proxy/conversion recovery is a separate configuration decision; do not introduce one implicitly.

Direct playback still permits metadata and control traffic to Plex: access validation, output decisions, track selection, session keepalive/stop and, if needed to preserve selected tracks, bounded playlist text. The goal is browser loading of Plex playlists as well, but preserving a captured playlist does not justify fetching its media on the server. Do not repeat a Plex start request blindly after temporary track preferences have been restored. Validate the playlist handoff before committing to an all-playlist-direct implementation.

## Existing dependencies to remove from direct preparation

- `server/watch.js`, `prepareQuality` and replacement preparation pass a room/media sharing key before delivery negotiation. `server/plex.js`, `prepare` may consequently enter `HLSPool.acquire` before `server/watch-operations.js` selects direct playback. Select the intended transport before this work; changing the final URL alone cannot satisfy the requirement.
- `server/hls-pool.js`, `anchor` downloads and checks an MPEG-TS segment. Sharing currently depends on that retained anchor. Direct preparation must bypass this entire dependency, including failed/speculative warm-up requests. Preserve it for the proxy path.
- `server/plex.js` captures a start playlist while holding track-selection locks for requested audio/burned subtitles. Retain the selected-output guarantees without allowing the browser to start a different output after preferences are restored.
- `web/watch.js`, `handleHlsFragmentBuffered`, and `web/watch-sync.mjs`, `anchor`, establish the client's timestamp reference before seeking to the room position. This work belongs in the browser. Delivery from a server cache is not intrinsic to that synchronization operation.
- `server/watch-http.js`, `rewriteManifest`, currently sends all referenced resources through media grants. Direct descriptors/playlist handoff must handle Plex-relative URLs, per-request credentials, HTTPS origin validation and redirects without exposing a persistent credential.

## Implementation

1. Carry direct/proxy transport intent through viewer preparation, fenced by current actor access, room/media/stream generation and selected tracks. Direct intent must prevent server media fetches even before the final descriptor is returned.
2. Share matching direct output in a separate pool without fetching an anchor. Every viewer retains their own temporary credentials, even when the producer uses another authorized account. If Plex rejects a viewer's access to the shared session, that viewer recovers through the existing proxy pool; other direct consumers retain their output. Keep existing conversion reservations, limits, cancellation, keepalives and cleanup. Do not substitute a producer's or owner's temporary token to bypass a rejection. Independent direct outputs are a future alternative if real-provider evidence justifies them, not a prerequisite assumed by this increment.
3. Reuse verified HTTPS origin binding and viewer-specific temporary delegation. Personal access or explicitly enabled dedicated non-owner fallback remains the source of authority. Never expose configured owner fallback credentials, reuse another viewer's delegated credential or assume that different accounts can read one shared transcode. Verify temporary-token access to the prepared session.
4. Serve the retained initial playlist through the viewer's media grant, with absolute Plex session resource URLs. Give the browser its own temporary token, pinned origin and output session ID. hls.js uses the fetch loader to validate destinations, reject redirects and add only controlled temporary credentials/session identifiers to nested playlists and segments. Strip arbitrary upstream query parameters. Never forward uburoom cookies to Plex. Keep tokens out of shared room state, producer objects, persistence and diagnostics. This increment supports the pinned `/video/:/transcode/universal/session/<id>/` resource layout; unexpected layouts recover to the proxy.
5. First preserve the proven client timestamp anchoring behavior by fetching the required initial segment directly from Plex into the browser. This does not require uburoom to fetch it. Only replace segment-zero anchoring with a nearby-segment strategy after picture-level evidence proves the mapping to the movie timeline across Plex output timestamps and discontinuities. Matching `currentTime` values alone is insufficient.
6. On a direct transport failure, preserve room position, pause intent, quality and tracks. Under `auto`, replace only that viewer's transport with the existing authorized proxy path and retire obsolete direct work. A codec failure remains a separate compatibility decision: proxying identical bytes cannot make them decodable. Optional local conversion continues under its own policy and reservations.

Direct master/child playlist requests use a single attempt with a 5-second first-byte and 8-second total deadline before per-viewer proxy recovery. This avoids spending the normal HLS retry budget on an unreachable public origin from the LAN. Proxy HLS and fragment policies retain their existing budgets. The deadline does not include subsequent Plex preparation or capacity waiting, and does not make an unreachable address reachable; direct LAN playback requires a usable route to the configured Plex HTTPS origin.

Discord Activity retains its existing path for this browser HLS increment. Direct HLS for native-HLS browsers needs separate evidence; hls.js success does not certify native playback or Activity networking.

## Verification and stopping points

Use isolated providers/media for local implementation. Instrument the server media boundary and fail a direct-path check on any video/audio segment request, including cache warm-up, byte-range probes and failed direct preparation. Metadata/playlist traffic and an explicitly selected proxy recovery must be recorded separately. Verify that direct playback decodes with server media fetching denied.

Extend existing focused authorization/lifecycle tests for transport selection before preparation, temporary credential isolation, non-owner fallback, foreign/redirected resources, stale responses, capacity accounting and cleanup. Use the existing browser verification infrastructure for Chrome and Firefox; no new permanent smoke runner is implied.

Browser checks must compare recognizable picture frames and sound at late join, paused join, seek, quality/track replacement and recovery, including clients using different delivery paths. Exercise direct CORS/authentication failures and verify bounded recovery without affecting other viewers. Do not infer exact synchronization from command acknowledgements or equal playback clocks.

Real Plex behavior remains a distinct gate: temporary-token access to prepared HLS sessions; nested playlist URLs and token propagation; availability of the initial segment; late joins/backward seeks without disturbing another viewer; track preservation; transcode expiry and cleanup. Seek specific authorization for controlled real-provider execution once the local candidate and bounded probe are ready. No deployment, production restart or configuration migration is authorized by this design work.
