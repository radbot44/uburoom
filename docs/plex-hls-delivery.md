# Direct Plex delivery

Implemented for Original files and hls.js playback. Direct delivery makes uburoom the access/timeline coordinator while Plex sends media to each browser. [Evidence and open gates](testing.md#direct-plex-hls--2026-10-22).

## Transport boundaries

| Path | Media bytes | uburoom responsibility |
| --- | --- | --- |
| Direct file | Plex → browser | Access, temporary delegation, bounded observations |
| Direct HLS | Plex → browser, including timestamp anchor | Output preparation/lifecycle, retained initial playlist, viewer descriptor |
| Proxy HLS | Plex → uburoom → browser | Authorized rewriting/proxy and bounded anchor cache |
| Local AV1/VP9/VP8 | Plex → uburoom encoder → browser | Authorized source, conversion and delivery |

`proxy` is default; `auto` prefers direct and permits proxy recovery. Strict direct-only is future work. Activity/native-HLS-only clients retain proxy HLS; hls.js results do not certify those surfaces.

## Preparation and sharing

- Select direct intent **before** pool acquisition/cache warm-up. Direct preparation must never fetch video/audio bytes, including speculative probes. Metadata, decisions, track selection, keepalive/stop and bounded playlist text are control traffic.
- Keep separate direct/proxy pools. Share only matching room/media/source/quality/audio/burn outputs under independent viewer authority and existing capacity reservations.
- Capture the initial playlist while selected Plex track preferences are locked; do not blindly restart negotiation after restoring preferences.
- Give each viewer its own temporary delegation, pinned HTTPS origin and output session ID. Never use another viewer's or configured owner's fallback credential to bypass rejection.
- The retained initial playlist has absolute Plex resources. Nested playlists/segments are restricted to the pinned `/video/:/transcode/universal/session/<id>/` layout; reject foreign origins, redirects and uncontrolled query parameters. Do not forward uburoom cookies.
- Keep temporary credentials out of shared producer objects, room state, persistence and diagnostics. Delegation retains upstream account scope and cannot enforce immediate room revocation; see [operator implications](self-hosting.md#direct-plex-delivery).

## Timestamp and recovery contract

The browser reads segment zero directly from Plex to establish source-to-media timestamp mapping before joining the room position. Equal playback clocks do not prove equal pictures. Any nearby-anchor replacement needs picture-level evidence across discontinuities.

Direct failures replace only the affected viewer's route, preserving position, pause intent, quality and tracks. Retire superseded work and keep other viewers running. Unsupported decoding is a separate decision; proxying identical bytes cannot fix it.

Direct playlist loads use one attempt: five-second first-byte and eight-second total deadlines. Other HLS/fragment budgets remain independent. LAN viewers use authenticated Plex LAN-origin discovery or an explicit override; external viewers use the public origin. See [configuration](self-hosting.md#direct-plex-delivery).

## Verification

Instrument the server boundary: successful direct playback must decode with **zero server video/audio requests**, including failed warm-up/range probes. Record control traffic and deliberate proxy recovery separately.

Check credential/origin/session fencing, revocation after awaits, cancellation, capacity and last-reference cleanup. Browser checks need actual picture/audio through late/paused joins, seeks, track/quality replacement and CORS/auth failures.

Open real-provider gates: different Plex accounts reading shared output, prolonged joins/backward seeks, selected tracks, expiry/revocation, independent departure and cleanup. Same-account temporary-token probes and owner phone playback are narrower evidence, not full shared-account verification.
