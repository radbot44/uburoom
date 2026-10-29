# Playback reliability and content coverage

M1-P1/P2/P3/P5/P6/P9 technical contract. [Roadmap](../ROADMAP.md) owns priorities; [testing](testing.md) owns results. Scope support to measured configurations.

## Playback decisions

A playback attempt includes edition/version/file, item timeline, video/color/cadence, selected audio/subtitles, container/transport, client support, network and server capacity.

1. Resolve current media authority and eligible source. Never silently replace an alternate cut; substitute encodes only when timing-compatible.
2. Treat codec/MSE/MediaCapabilities hints as candidates, not decode proof.
3. Prefer compatible direct output, then remux/audio-only conversion, then full conversion/burn-in. Complete automatic source/output negotiation remains unfinished.
4. Validate actual Plex output and requested track/quality ceilings.
5. Confirm decoded picture; verify intended audio/captions independently.
6. Recover through bounded candidates while preserving position, pause intent and personal choices. Fence superseded work by attempt/stream generation.

Distinguish network failure, unsupported decoding, missing source, overload and authorization denial. No credential substitution to bypass denial, oscillating quality or indefinite spinner. Capacity fallback must respect saved quality ceilings. [Direct HLS](plex-hls-delivery.md) owns route/delegation details. Companion native clients (`plezy-uburoom`) playing a verified local download subscribe with `delivery=local` to participate in room readiness, clock synchronization and `observe` reporting without allocating server HLS or proxy media grants; when no local download exists, they fall back to the room's authorized `mediaUrl` or `directHls` stream.

## Shared playback timing

The server owns the timeline. Authenticated WebSockets carry revisioned state and independent clock exchanges; the HTTP-shaped adapter is removed.

Use server receive/send timestamps with monotonic RTT minus server processing. The low-delay clock filter slews refinements, expires stale mappings and resets on disconnect/clock discontinuity. Playing target is snapshot position plus elapsed estimated server time; pause freezes position. Reject old revisions and expired commands; never replay stale controls.

Group startup/shared seeks combine decoder readiness with a scheduled lead. Ordinary pause/resume uses a bounded RTT-derived deadline. A single viewing tab skips group leads; count tabs, not account identities. After readiness timeout, the host chooses Start with ready viewers, Wait or Cancel.

Ongoing buffering/late join recovers locally and never pauses healthy viewers. Missing clock confidence suppresses drift correction while preserving authoritative intent. Default speed correction and opt-in Occasional jumps remain separate; disabled experimental policies need disposition before release.

Measure presented-frame skew, cadence, correction rate and dropped frames separately. Frame callbacks estimate compositor timing, not physical pixels/audio; sparse callbacks require explicit exclusion/coverage counts. Targets ≤50ms p95 / ≤100ms p99 remain unverified on real separated displays.

## Buffering and recovery

- Managed output targets 60s ahead/30s behind under a 64MiB encoded-data budget. Bitrate/segment/quota pressure reduces windows; this does not cap total browser/server RAM. Native caching remains browser-managed.
- Seek supersedes speculative work; partial audio/video pairs and late cancelled output cannot corrupt the new buffer. Preserve playable data during speculative failure.
- Keep finite transport retries, stream refresh and terminal errors. A fresh seek supersedes irrelevant retry delay. Recover paused playback to the shared position without restarting healthy viewers.
- Same-tab reconnect may preserve personal choices briefly, but needs fresh authorization, epochs, grants and decoded readiness. Leave, close, new tab or changed media cannot inherit old consent.
- Account revocation/relink fences cached and in-flight credential work.
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
| Text | Authorized bounded extraction/fetch and native cues; retain timing/positioning, reject arbitrary HTML |
| Styled/bitmap | Lazy JASSUB ASS/SSA and libbitsub PGS/VobSub are implemented; preserve authored fonts/layout and explicit burn-in fallback |
| Local conversion | Opus paths retain personal browser captions; reject required Plex burn-in rather than silently dropping it |
| Fidelity | Verify language, downmix/channel order/clipping, fonts/signs/karaoke, PGS/VobSub, forced/SDH, CJK/RTL and A/V/caption alignment |
| Lifecycle | Cancel obsolete loads, prevent double captions, dispose workers/resources, recover visibly through seek/quality changes |

Embedded PGS uses complete bounded windows (normally 15s behind / 60s ahead), with lookahead prefetch and immediate cancellation outside pending coverage. FFprobe first inspects timestamps across all streams; filtering that inspection to sparse subtitles can read far beyond a quiet interval. FFmpeg then copies only the known subtitle packet bytes, retaining source timestamps and subtracting the verified container origin. Packet timestamps and byte counts must match the inspection before coverage is accepted. Inspected intervals containing media packets but no PGS packets establish quiet coverage; empty or failed extraction does not. HTTP byte ranges must work; neither FFmpeg limits nor a Range header alone proves efficient seeking on a particular source.

Subtitle extraction retains its two-job concurrency limit, 25s tool / 30s window budgets, and 16MiB per-window output/metadata limits. Window caches retain at most 16 entries / 16MiB per media and 128 entries globally, sharing the existing 96MiB completed-resource budget. Cache eviction releases completed bytes without invalidating active consumers; explicit media/authorization invalidation still cancels their jobs. A coalesced job ends only when its final consumer leaves or its shared media authority expires. Browser PGS keeps at most three windows within one 16MiB encoded-data budget covering retained windows, parser input, incoming assembly, replay and transfer reservations; conservative four-copy replay reservation limits retained input to 4MiB. It resets/replays chronological data and removes exact overlapping segments. This accounting includes the parser's encoded copy, not measured decoded WASM/GPU memory or total RAM. Missing bitmap initialization permits a bounded 60s lookback retry, followed by truthful failure and the existing explicit Plex burn-in choice. Other subtitle formats retain their existing delivery paths.

Personal browser preferences retain subtitle language/mode, not audio language or subtitle timing.

Full multichannel/lossless/Atmos guarantees and efficient audio-only conversion remain unfinished. Subtitle rendering verification and [third-party attribution](third-party.md) are tracked separately.

## Shared conversions

Match output-affecting source, quality, audio, burned subtitles, color/timing and room/media generation. Browser captions remain personal. Every consumer has its own media authority; a producer credential never authorizes a consumer.

Proxy HLS uses a bounded timestamp-anchor cache; direct HLS anchors in the browser. Local WebM output can share chunks. Release on last reference, preserve other viewers on departure/replacement and fence producer credential failure. Real cross-account behavior and hardware throughput require their own evidence.

## Content fidelity and playback UX

Preserve source cadence, VFR/interlacing handling, aspect ratio, anamorphic pixels, rotation and color. HDR10/HLG/Dolby Vision need distinct verified paths; HDR expansion is future scope, not implied by SDR success.

Split-file item timelines, version selection, chapters/markers/extras and broader Plex parity remain planned. Queue continuation and durable rooms are implemented under [P13](rooms-and-queues.md); do not build a parallel advance path. Personal Plex reporting is separate [P4 work](plex-reporting-investigation.md).

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
