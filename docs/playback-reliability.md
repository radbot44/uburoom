# Playback reliability and content coverage

Technical specification for playback delivery, synchronization, and recovery. [Roadmap](../ROADMAP.md) owns priorities; [testing](testing.md) owns results. Scope support to measured configurations.

## Playback decisions

A playback attempt includes edition/version/file, item timeline, video/color/cadence, selected audio/subtitles, container/transport, client support, network and server capacity.

1. Resolve current media authority and eligible source. Never silently replace an alternate cut; substitute encodes only when timing-compatible.
2. Treat codec/MSE/MediaCapabilities hints as candidates, not decode proof. Negotiation is therefore the delivery plan plus observed decode evidence and bounded fallback; clients do not pre-report capabilities. In Discord Activity environments (particularly with client hardware acceleration disabled), H.264 and HEVC decoders fail (emitting decoder `kUnsupportedConfig` / media error 4 or advancing clock without video frames) despite positive `canPlayType`, MSE, MediaCapabilities, or WebCodecs hints. Uburoom therefore negotiates candidate WebM formats (AV1 default, VP9/VP8 candidates) and requires verified decoded frame presentation before committing.
3. Prefer compatible direct output, then remux/audio-only conversion, then full conversion/burn-in. One delivery plan chooses the route and records why in diagnostics.
4. Validate actual Plex output and requested track/quality ceilings.
5. Confirm decoded picture; verify intended audio/captions independently.
6. Recover through bounded candidates while preserving position, pause intent and personal choices. Fence superseded work by attempt/stream generation.

Distinguish network failure, unsupported decoding, missing source, overload and authorization denial. No credential substitution to bypass denial, oscillating quality or indefinite spinner. Capacity fallback must respect saved quality ceilings. See [direct Plex delivery](#direct-plex-delivery-hls-and-direct-file) for route, delegation, and timeout details. Companion native clients (`plezy-uburoom`) playing a verified local download subscribe with `delivery=local` to participate in room readiness, clock synchronization and `observe` reporting without allocating server HLS or proxy media grants; when no local download exists, they fall back to the room's authorized `mediaUrl` or `directHls` stream.

## Optional room fallback

When `transcoding.fallback.enabled` is on, one room-owned local output warms up to 30 seconds ahead of the current video, including an autoplay countdown. Preparation idles while paused and releases on empty rooms, media replacement and room closure. It follows the room timeline through seeks and uses the existing encoder scheduler, conversion policy and aggregate encoded-byte budget. Speculative warming yields to viewer output; limits are never increased. The source still comes through the authorized Plex file route, so this survives Plex transcoder refusals, not a loss of access to the source itself.

Healthy viewers do not fetch fallback chunks. A viewer below 8 seconds buffered prepares an approximately 18-second window; a 1.5-second continuous stall or buffer below the shared 2-second health limit can swap to it. Joins/reconnects may start there while their authorized chosen output prepares. Return probes require 20 seconds ready (or the remaining video near its end), at most one return per minute; two failed returns keep fallback for that video. These decisions are defined in `shared/sync/quality.mjs`, use current health rather than historical stalls, and ignore seeks, pauses and interrupted observations. Preparation, cache adoption and last-frame swaps share the quality-change path.

Fallback does not replace the viewer's selected quality, audio or subtitle preferences. It uses default audio with an explanatory toast if that differs; client-rendered subtitles continue. Viewers requiring Burn-in receive no fallback, so captions cannot disappear silently. Normal and fallback resources have separate per-viewer grants with the same admission, current-media, selection, liveness and bounded source-window checks. Local/native delivery never receives a fallback resource.

## Shared playback timing

The server owns the timeline. Authenticated WebSockets carry revisioned state and independent clock exchanges; the HTTP-shaped adapter is removed.

Use server receive/send timestamps with monotonic RTT minus server processing. The low-delay clock filter slews refinements, expires stale mappings and resets on disconnect/clock discontinuity. Playing target is snapshot position plus elapsed estimated server time; pause freezes position. Reject old revisions and expired commands; never replay stale controls.

Group startup/shared seeks combine decoder readiness with a scheduled lead. Ordinary pause/resume uses a bounded RTT-derived deadline. A single viewing tab skips group leads; count tabs, not account identities. After readiness timeout, the host chooses Start with ready viewers, Wait or Cancel.

Ongoing buffering/late join recovers locally and never pauses healthy viewers. Missing clock confidence suppresses drift correction while preserving authoritative intent. Default speed correction uses a per-frame exponential moving average (alpha = 0.35) with a hybrid divergence policy (<=90 ms selects presentation error, 90-180 ms blends presentation and position, >180 ms falls back to position error); opt-in Occasional jumps and hard seeks use position-based error exclusively.

Measure presented-frame skew, cadence, correction rate and dropped frames separately. Frame callbacks estimate compositor timing, not physical pixels/audio; sparse callbacks require explicit exclusion/coverage counts. Targets ≤50ms p95 / ≤100ms p99 remain unverified on real separated displays.

## Buffering and recovery

- A Plex outage is not a denial. Admitted viewers keep their room, stream and commands until Plex answers, when any real denial applies; new admission fails closed. A dead Plex session is replaced only when under 15s of buffer remains, because replacing it discards that media. Viewers are told only as the [design guide](design-guide.md#reuse-and-feedback) describes.
- Managed output targets 60s ahead/30s behind under a 64MiB encoded-data budget. Bitrate/segment/quota pressure reduces windows; this does not cap total browser/server RAM. Native caching remains browser-managed.
- Seek supersedes speculative work; partial audio/video pairs and late cancelled output cannot corrupt the new buffer. Preserve playable data during speculative failure.
- Keep finite transport retries, stream refresh and terminal errors. A fresh seek supersedes irrelevant retry delay. Recover paused playback to the shared position without restarting healthy viewers.
- Same-tab reconnect may preserve personal choices briefly, but needs fresh authorization, epochs, grants and decoded readiness. Leave, close, new tab or changed media cannot inherit old consent.
- Account revocation/relink fences cached and in-flight credential work.
- Local WebM recovery trusts actual audio/video buffered ranges over its append ledger: it refills only missing chunks within a bounded retry count and bounds each append to its source window, so an out-of-order refill cannot damage the next chunk.
- A quality change between uburoom outputs of the same codec, audio and burned subtitle keeps the player: buffered chunks keep playing and the new stream takes over at a chunk boundary, dynamically scaled between 2 seconds (`MIN_SWITCH_MARGIN`) and 5 seconds (`SWITCH_MARGIN`) based on observed chunk arrival speed so the new chunk can arrive safely. Other changes reload the player.

## Operation and durability boundaries

- A request owns its work only until it settles. Cancellation reaches provider calls, queue waits and preparation while it runs; timers and detached work it started do not inherit it afterwards.
- Shared work has its own lifetime and consumer count. One consumer leaving never cancels another's work, and preparation tolerates a short gap between polls so a slow start is not restarted by each one.
- Selected-room publication runs independently of lobby discovery. A slow publication retries; it does not report a lost connection. Superseded preparation is not a room failure for the viewers waiting on it.
- A response waits only for storage its own operation touched, so static and media-only responses never wait for unrelated writes. Mutations stay unacknowledged until committed. History totals are computed in the storage worker from committed rows.
- Verify real Plex manifests, backward segment availability, long pause/expiry and cleanup; synthetic VOD fixtures do not establish them.

### Runtime degradation warnings

The existing choppiness detector retains its 10-second dropped-frame and stall paths. An additional candidate path evaluates two consecutive non-overlapping windows of approximately 2 seconds after startup settling, each with at least 20 total frames, 6 dropped frames and an 8% drop ratio. These parameters are adjustable detector options, not device-validated limits. Waiting, visibility transitions, seeks, pauses, stream replacement, counter discontinuities and sampling gaps invalidate frame evidence; stalls remain a separate signal.

Reuse the existing Playback seems choppy / Lower quality toast. Warn once per continuous degradation episode and require 10 seconds of consecutive, sufficiently sampled healthy playback before rearming. Deliberate dismissal survives stream/quality replacement for the current media/viewing session; a new media occurrence, room change or session exit resets it. Quality changes are explicit viewer actions and retain their cooldown across replacement. This feedback does not issue shared pause/seek commands or change synchronization policy.

MediaCapabilities is best-effort diagnostic context only, using declared H.264 output metadata when complete. Missing profile, dimensions, bitrate or frame rate is inconclusive; direct-file metadata is not fabricated from quality presets. Unsupported, rejected, timed-out and superseded probes do not alter playback. Neither smoothness nor power-efficiency predictions alone trigger warnings or quality changes. Sanitized bounded exports distinguish runtime drops/stalls, quota exceptions, buffer-full/append errors and network failures without identifying media or credentials.

Production HLS.js retains its 256MiB buffer-size target, 30-second forward minimum, 180-second forward ceiling and 30-second back buffer. Its byte target is not a SourceBuffer memory guarantee, and it does not govern direct-file caching. Smaller byte targets require actual quota and continuity measurements before adoption.

HLS.js can recover a native quota exception internally before emitting an error event. Exported HLS errors therefore do not count every recovered append exception; zero exported quota errors is not proof of zero quota pressure. Explicit disposable browser experiments may instrument native appends to establish that distinction without changing production SourceBuffer behavior.

## Audio and subtitle completeness

| Area | Contract / remaining evidence |
| --- | --- |
| Track identity | Source IDs plus language/role flags; do not carry unrelated numeric IDs across titles |
| Switching | Replace only the requesting viewer at shared position/pause; preserve or truthfully fail intended tracks |
| Plex preference capture | Serialize part selection, confirm decision, capture output, restore prior preference without overwriting an observed newer choice |
| Restoration limitation | Final check/restore are separate requests and can race external Plex apps; same-identity concurrent viewers need real checks |
| Text | Authorized bounded extraction/fetch and native cues; embedded text loads in windows; retain timing/positioning, reject arbitrary HTML |
| Styled/bitmap | Lazy JASSUB ASS/SSA and libbitsub PGS/VobSub are implemented; preserve authored fonts/layout and explicit burn-in fallback |
| Local conversion | Opus paths retain personal browser captions and burn required subtitles per chunk; a burned stream is shared only by viewers on that subtitle. External image subtitles fall to the next output |
| Fidelity | Verify language, downmix/channel order/clipping, fonts/signs/karaoke, PGS/VobSub, forced/SDH, CJK/RTL and A/V/caption alignment |
| Lifecycle | Cancel obsolete loads, prevent double captions, dispose workers/resources, recover visibly through seek/quality changes |

Embedded PGS uses complete bounded windows (normally 15s behind / 60s ahead), with lookahead prefetch and immediate cancellation outside pending coverage. FFprobe first inspects timestamps across all streams; filtering that inspection to sparse subtitles can read far beyond a quiet interval. FFmpeg then copies only the known subtitle packet bytes, retaining source timestamps and subtracting the verified container origin. Packet timestamps and byte counts must match the inspection before coverage is accepted. Inspected intervals containing media packets but no PGS packets establish quiet coverage; empty or failed extraction does not. HTTP byte ranges must work; neither FFmpeg limits nor a Range header alone proves efficient seeking on a particular source.

Subtitle extraction retains its two-job concurrency limit, 25s tool / 30s window budgets, and 16MiB per-window output/metadata limits. Window caches retain at most 16 entries / 16MiB per media and 128 entries globally, sharing the existing 96MiB completed-resource budget. Cache eviction releases completed bytes without invalidating active consumers; explicit media/authorization invalidation still cancels their jobs. A coalesced job ends only when its final consumer leaves or its shared media authority expires. Browser PGS keeps at most three windows within one 16MiB encoded-data budget covering retained windows, parser input, incoming assembly, replay and transfer reservations; conservative four-copy replay reservation limits retained input to 4MiB. It resets/replays chronological data and removes exact overlapping segments. This accounting includes the parser's encoded copy, not measured decoded WASM/GPU memory or total RAM. Missing bitmap initialization permits a bounded 60s lookback retry, followed by truthful failure and the existing explicit Plex burn-in choice. Other subtitle formats retain their existing delivery paths.

Personal browser preferences retain subtitle language/mode, not audio language or subtitle timing.

Full multichannel/lossless/Atmos guarantees and efficient audio-only conversion remain unfinished. Subtitle rendering verification and [third-party attribution](third-party.md) are tracked separately.

## Shared conversions

Match output-affecting source, quality, audio, burned subtitles, color/timing, decoder fallback compatibility and room/media generation. Browser captions remain personal. Every consumer has its own media authority; a producer credential never authorizes a consumer.

Proxy HLS uses a bounded timestamp-anchor cache; direct HLS anchors in the browser. A slow first segment never fails a lone viewer: they keep the private output, while viewers already waiting stay on one encoder for a bounded time and then get a retryable error instead of each starting another. Local WebM output can share chunks. Release on last reference, preserve other viewers on departure/replacement and fence producer credential failure. Local WebM reserves encoded bytes against an aggregate budget, serves work near the shared position ahead of speculation, and keeps a learned software fallback for that output. Real cross-account behavior and hardware throughput require their own evidence.

## Content fidelity and playback UX

Preserve source cadence, VFR/interlacing handling, aspect ratio, anamorphic pixels, rotation and color. HDR10/HLG/Dolby Vision need distinct verified paths; HDR expansion is future scope, not implied by SDR success.

Split-file item timelines, version selection, chapters/markers/extras and broader Plex parity remain planned. Queue continuation and durable rooms are governed by [rooms and queues](rooms-and-queues.md); do not build a parallel advance path. Personal Plex reporting is documented in [Plex reporting](archive/plex-reporting-investigation.md).

## Verification corpus and failure scenarios

Use licensed/generated media with known frames, audio and captions. Select representative cases for the claimed scope rather than an exhaustive permutation suite.

| Dimension | Cases |
| --- | --- |
| Source | Relevant codecs/containers, frame rates, timestamp offsets, missing/damaged metadata, split parts and selected tracks |
| Load | Bitrate peaks, weak decoder, multiple shared/distinct outputs and capacity exhaustion |
| Lifecycle | Startup, pause/resume, late join, seeks, replacement, natural ending, replay, queue cancellation and cleanup |
| Failure | Delay/loss, expiry/restart, 403/404/429/5xx, credential revocation, disconnect, sleep/background and Activity transitions |

Chrome/Firefox fixture coverage is distinct from real Safari/iOS/Android, Discord desktop/web/mobile, hardware and physical output. Record exact versions and acceleration state. Test actual Activity SDK/proxy/CSP/URLs/grant renewal; hardware-acceleration prompts can restart Discord and are user actions.

Measure first frame/audio, stall duration, seek recovery, drift/cadence, track fidelity, encoding headroom and cleanup. Proposed warm direct/remux startup/seek p95 3s/2s and cold conversion 8s/5s are calibration targets, not guarantees. Require scoped two-hour endurance without unexplained interruptions/resource growth before claiming sustained support.

References: [clock filtering](https://www.rfc-editor.org/rfc/rfc5905.html), [media synchronization](https://www.rfc-editor.org/rfc/rfc7272.html), [frame callbacks](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback), [Plex API](https://developer.plex.tv/pms/), [Discord development](https://docs.discord.com/developers/activities/development-guides/local-development).

## Late audio

Some films start their audio well after their video, so opening HLS segments declare audio but hold none. The player would build no audio track from them and fail when audio arrives. The browser adds silent 48 kHz stereo AAC to those segments, up to the first real audio, and leaves the video untouched. This relies on Plex's stereo AAC output and an audio track declared in each segment; anything else keeps the existing recovery and fallback.

## Quality swaps

A quality change that needs a new stream type plays out the current buffer while the new stream loads in a hidden element, which fills a memory cache the real player then reads. The swap happens once that stream reaches the room position, or before the buffer runs out if it is too slow. Phones and Activity keep the plain swap. Seeking, pausing or changing the video ends the wait at once.

## Direct Plex delivery (HLS and direct file)

Direct delivery makes uburoom the access and timeline coordinator while Plex streams media directly to each browser for Original files and HLS playback. See [Direct Plex verification](testing.md#direct-plex-hls).

### Transport boundaries

| Path | Media bytes | uburoom responsibility |
| --- | --- | --- |
| Direct file | Plex → browser | Access, temporary delegation, bounded observations |
| Direct HLS | Plex → browser, including timestamp anchor | Output preparation/lifecycle, retained initial playlist, viewer descriptor |
| Proxy HLS | Plex → uburoom → browser | Authorized rewriting/proxy and bounded anchor cache |
| Local AV1/VP9/VP8 | Plex → uburoom encoder → browser | Authorized source, conversion and delivery |

`proxy` is default; `auto` prefers direct and permits proxy recovery. Direct-only delivery without proxy recovery is unsupported. Activity and native-HLS-only clients retain proxy HLS.

### Preparation and sharing

- Select direct intent **before** pool acquisition or cache warm-up. Direct preparation must never fetch video or audio bytes, including speculative probes. Metadata, playback decisions, track selection, keepalive/stop, and bounded playlist text are control traffic.
- Keep separate direct and proxy pools. Share only matching room, media, source, quality, audio, and burn outputs under independent viewer authority and existing capacity reservations.
- Capture the initial playlist while selected Plex track preferences are locked; do not restart negotiation after restoring preferences.
- Give each viewer its own temporary delegation, pinned HTTPS origin, and output session ID. Never use another viewer's or configured owner's fallback credential to bypass rejection.
- The retained initial playlist uses absolute Plex resources. Nested playlists and segments are restricted to the pinned `/video/:/transcode/universal/session/<id>/` layout; reject foreign origins, redirects, and uncontrolled query parameters. Do not forward uburoom cookies.
- Keep temporary credentials out of shared producer objects, room state, persistence, and diagnostics. Delegation retains upstream account scope and cannot enforce immediate room revocation; see [operator implications](self-hosting.md#direct-plex-delivery).

### Timestamp and recovery contract

The browser reads segment zero directly from Plex to establish source-to-media timestamp mapping before joining the room position. Equal playback clocks do not prove equal pictures; nearby-anchor replacement requires picture-level evidence across discontinuities.

Direct failures replace only the affected viewer's route, preserving position, pause intent, quality, and tracks. Retire superseded work and keep other viewers running. Unsupported decoding is a separate decision; proxying identical bytes cannot fix decoder rejection.

Under direct HLS, manifest, playlist, and fragment loads all enforce single-attempt deadlines: a five-second first-byte deadline and an eight-second total load deadline (`maxTimeToFirstByteMs: 5000, maxLoadTimeMs: 8000, timeoutRetry: null, errorRetry: null`). LAN viewers use authenticated Plex LAN-origin discovery or an explicit override; external viewers use the public origin. See [configuration](self-hosting.md#direct-plex-delivery).

### Verification

Instrument the server boundary: successful direct playback must decode with **zero server video/audio requests**, including failed warm-up or range probes. Record control traffic and deliberate proxy recovery separately. Check credential, origin, and session fencing, revocation after awaits, cancellation, capacity, and last-reference cleanup. Browser verification requires decoded picture and audio through late/paused joins, seeks, track/quality replacement, and CORS/auth failures.
