# Browser playback reliability and content coverage

Use the [project roadmap](../ROADMAP.md) for current priorities and milestone status. This document owns detailed playback requirements and architecture; [testing status](testing.md) owns completed evidence and remaining verification.

## Product requirement

The primary player goal is reliable, smooth playback for someone who knows nothing about codecs or transcoding. A viewer chooses a title and presses Play; uburoom chooses a suitable delivery path and handles ordinary failures automatically. Discord Activity is a primary playback surface and a release gate.

Aim for Plex-level coverage of the actual video content: playable versions and files, audio languages and accessibility tracks, subtitles, accurate picture and timing, resume, chapters, intro/credits markers and episode continuation. Keep the existing uburoom visual language and shared command authorization.

Coverage means delivering the chosen content through a verified compatible path. It does not require every browser to decode every original file. Hardware, operating-system codecs, network capacity and server conversion capacity affect the available paths. Record these boundaries with actual playback evidence and provide a useful recovery action when no path is available.

This document records an investigation and implementation plan. Items below are requirements or proposed work unless explicitly described as existing. No browser or Activity certification is implied. See [verification status](testing.md).

## Findings from the current source

| Area | Existing behavior | Gap to resolve |
| --- | --- | --- |
| Source selection | `server/plex.js` selects `Media[0].Part[0]`. | Enumerate playable versions, files and streams; support a complete item timeline for split files. |
| Delivery | Original file, Plex H.264/AAC HLS, and an optional custom AV1/Opus WebM path. | Choose using the complete source and client configuration; evaluate remux and audio-only conversion before a full video conversion. |
| Quality | Non-Original presets request full Plex transcoding; the picker filters presets using the first source's size and bitrate. | Add an automatic default based on measured sustainable delivery and decode performance; distinguish requested quality from actual output. |
| Audio | Personal source track picker, language/role intent across titles; selected source audio in Plex AAC or custom AV1/Opus conversion. Multiple audio tracks currently require full conversion. | Live Plex track confirmation; broader codecs, downmix fidelity and multichannel output; remux/audio-only optimization. |
| Subtitles | Personal Automatic/Off/source picker; external SRT/WebVTT in native text tracks; embedded text, ASS/SSA and image formats request Plex burn-in. Native text delay and bounded fetch recovery. | Live Plex burn/font/seek fidelity, image inputs, broader languages and real Activity rendering. |
| AV1 fallback | Intel QSV encoding; six-second independent chunks; measured CFR source rate; selected audio; stereo Opus; external text captions; some HDR sources tone mapped to SDR. | Burned subtitles require Plex HLS; this fallback refuses unsupported combinations. Verify VFR timing, color, chunk boundaries, audio continuity, end-of-stream completion and sustained hardware encoding under load. |
| Readiness | Browser decoded-frame checks and per-viewer observations exist; an initial room gate waits for readiness. | Model startup, ongoing stalls, track changes and recovery explicitly; separate playback evidence from UI and command acknowledgement. |
| Buffering | A shared policy targets 60 seconds ahead, 30 seconds behind and a 64 MiB encoded-data budget for managed transports; the timeline displays actual buffered ranges. | Verify high-bitrate peaks, browser eviction, long pauses, real Plex transcode manifests/expiry and Activity memory/lifecycle behavior. Native file/HLS caching remains browser-managed. |
| Synchronization | Periodic room polling, playback-rate nudges and hard seeks. | Measure clock/latency bias, correction frequency and seek settling before tuning. Avoid repeatedly seeking a decoder that is still recovering. |
| Verification | Real Firefox decoding fixtures and synthetic codec samples exist. | Establish other-browser and real Activity coverage, realistic media profiles, audio/caption verification and long playback tests. |

The existing access checks, stream grants, per-viewer streams, stale-command protections and decoded-frame observations are useful foundations.

## Shared playback timing

The room remains authoritative and each viewer retains their own streams, tracks and recovery. Room-state polls include server receive/send timestamps, monotonic server processing duration and an in-memory server-clock epoch. The browser estimates server time against `performance.now()` using the midpoint exchange with server processing removed from RTT. A rolling low-delay filter rejects queueing spikes; three consistent samples reacquire a persistently slower path. Mapping refinements slew at at most 2 ms/s, expire after five seconds without accepted evidence, and reset on disconnect, server replacement or detected wall/monotonic discontinuity. Large server-clock steps require three agreeing samples. These filter constants are initial engineering choices, not experimentally certified optimal settings.

For an accepted snapshot, the current target is `snapshot.position + (estimatedServerNow - snapshot.serverNow) / 1000` while playing, clamped to the item duration; pause freezes the snapshot position. The calculation uses the shared timestamp rather than the state response's arrival time. Replacement/seek/play/pause still come from the existing command engine and room revision. Older in-flight poll results cannot overwrite newer state. Command TTLs use the same fresh server mapping; absent clock evidence asks the user to retry after reconciliation, without saving or replaying a command. An untrusted clock suppresses automatic playing-state drift seeks/rate nudges, retains normal speed and leaves shared pause/play intent intact. The arrival-based estimate remains a limited rendering/loading fallback.

Clock uncertainty is a model, not proof of exact synchronization: half the best network RTT, a 2 ms timestamp allowance, remaining slew distance and 100 ppm sample-age allowance. Asymmetry, coarse privacy-reduced timers, suspension and physical output timing can exceed these assumptions. Export request RTT, server processing, filtered network RTT/variation, clock uncertainty and frame error separately. `requestVideoFrameCallback` metadata supplies media/compositor timestamps and presentation counts where supported; it cannot establish physical pixel or speaker timing. Intervals whose next callback reports unobserved presented frames are excluded from healthy pairwise estimates, with explicit coverage/exclusion counts. Native dropped-frame counters remain separate.

The first comparison deliberately retains the existing 150/650 ms and ±4% correction policy. No evidence yet justifies adopting smaller speed changes, cadence-aware deadbands or more frequent seeks as defaults. Next compare correction candidates and scheduled future actions against both skew and cadence, across direct/HLS/AV1, source rates, physical refresh rates and real separated viewers. A notification path must retain authenticated, revision/epoch-fenced state reconciliation and polling/reconnect; adding SSE/WebSockets alone does not coordinate action presentation. Ongoing stalls must remain local and must never delay healthy viewers. The initial new-media readiness gate remains separate.

Architectural references checked on 2026-10-16: [RFC 5905](https://www.rfc-editor.org/rfc/rfc5905.html) (timestamp exchange/filtering), [Timing Object](https://www.w3.org/community/reports/webtiming/CG-FINAL-timingobject-20241203/) (shared timestamped motion), [RFC 7272](https://www.rfc-editor.org/rfc/rfc7272.html) (inter-destination presentation measurements), and [requestVideoFrameCallback](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback) (compositor metadata and limits). These are references rather than protocol implementations; group-delay behavior from IDMS examples does not override independent buffering.

## Playback decisions

Treat a playback request as one complete configuration: content/edition, version, file, item position, video profile/level/bit depth/frame rate/color, selected audio and channel layout, selected subtitle and rendering method, container, transport, client capabilities, network observations and server capabilities.

1. Resolve current per-user Plex access and an eligible source. Keep all viewers on the same content and item timeline. Alternate encodes need verified timing compatibility; an alternate cut must not become an automatic replacement.
2. Gather runtime support for the exact media configuration using file/MSE type checks and Media Capabilities where available. Browser name is context, not proof of decoding. Missing/optimistic capability data is not a successful playback result.
3. Prefer a verified direct path when suitable. Otherwise consider remuxing compatible streams, converting only incompatible audio, and then full video conversion or subtitle burn-in as necessary. Evaluate the complete configuration again after any choice changes.
4. Validate what Plex actually agreed to produce: container, video/audio format, selected tracks, dimensions, bitrate ceiling, subtitle delivery and timing. A successful HTTP response is insufficient.
5. Start with bounded buffering and confirm rendered video. Test actual audio and caption output separately: standard browser media state does not prove that a person heard the intended language or saw a caption.
6. Recover through a finite set of compatible candidates. Preserve room position, pause intent, personal settings and chosen tracks across replacements. Cancel superseded requests and fence late events by playback attempt and stream revision.

H.264 with AAC in an appropriate HLS/MP4 pipeline is a candidate broad-compatibility output, not a promise that it works in every Discord/client configuration. AV1, HEVC and other outputs are additional candidates only where client and server evidence support them. Keep native HLS and hls.js/MSE selection explicit and tested.

Separate network failure, unsupported decoding, sustained dropped frames, server overload, missing source and authorization failure. Retry transient delivery problems with a bounded policy; avoid retry storms, repeating a failed candidate, oscillating quality or changing credentials to bypass a denial. Quality recovery must not silently change the language, remove captions or choose a different cut.

The automatic quality policy should keep stable headroom for both the network and decoder. An explicit user ceiling remains a ceiling; automatic recovery must communicate a material reduction simply. Installation diagnostics should establish conversion availability and sustainable capacity, including simultaneous viewers with different tracks. Viewers should not need a codec test page to start normal playback.

## Buffered on-demand playback

On-demand playback must have a stable item timeline, useful preloading while paused, cached rewind and recovery after seeking outside the cache. Using HLS does not itself make a title a live stream. Verify the manifest's actual VOD/event/live behavior, available seek ranges and Plex conversion session lifetime; a pre-generated VOD fixture cannot establish those server behaviors.

The first implementation uses `web/playback-policy.js` in the browser and server:

- The AV1 client fills independent six-second chunks toward 60 seconds ahead, retaining up to 30 seconds behind. Chunk alignment can extend a range by less than one chunk. Retained encoded audio plus video is bounded to 64 MiB; forward data takes priority over rewind under byte pressure. MSE quota pressure reduces the window and removes partial track pairs before retrying required data. This is not a bound on total browser RAM, decoded frames, in-flight requests or server memory.
- hls.js has explicit ahead, back and maximum ahead durations. Its horizon shrinks using the requested bitrate ceiling toward the same encoded-data budget; for example, 24 Mbps selects 14 seconds ahead and 7 seconds behind. Segment boundaries and variable bitrate affect actual occupancy. The byte setting is a buffering target, not a measured total-memory ceiling.
- Native file playback keeps `preload=auto`; native file and native HLS caching remain controlled by the browser. Actual `video.buffered` ranges drive the played/loaded timeline and accessible buffer description. Do not promise a fixed native cache size or equate seekable duration with downloaded media.
- AV1 requests stay inside the current authorized room window, with stream revision, identity and access checks retained. Seeks supersede in-flight speculative work, including a seek during buffer eviction, and an immediate retry replaces a cancelled chunk without accepting its late output. Replacing a title resets compatibility fallback while preserving personal quality.
- Transient AV1 chunk requests use backoff: up to six speculative attempts, then a separate three-attempt budget if that data becomes required. Failed server chunks have a five-second cooldown rather than a permanent rejected cache entry. Non-transient failures remain terminal when needed. hls.js retains its internal retries and adds three quick fatal-network restarts at 1/2/4 seconds, then at most three slow attempts at 15/30/60 seconds. Loading requires the current room/media/stream, a recent authorized poll, online state and a valid shared position; recovery retargets paused local playback to that position. A fresh shared seek outside cached data supersedes the previous segment's network retry wait. Already playable data remains attached during failed speculation; exhausted delivery becomes an error when playback needs missing data. Fresh media buffered at the current position clears that delivery error and resumes synchronization. Actual fatal retry exhaustion and slow recovery pass isolated Firefox/Chrome fault checks; normal internal retry timing, live Plex and proxy faults remain separate verification gates.
- If Plex reports that a captured HLS conversion has disappeared, its authorized viewer can request a fresh private stream for the same room media. The request names the current media and stream revisions; the server rechecks access and carries that viewer's quality, audio and subtitle choices into a new captured session. The client accepts at most three such refresh attempts per media minute. Replaced grants are revoked, while the shared position, pause state and remote consent remain unchanged. A temporary delivery outage still uses the existing HLS retry path. Live Plex session expiry and long-running transcode behavior remain unverified.
- If a control outage exceeds the ten-second viewer timeout, the server briefly retains that tab's personal quality, audio and subtitle settings in memory. The same authenticated viewer ID can rejoin the same media revision within 60 seconds; the old stream and observation epoch are never reused. An empty host room can survive for that grace, counts toward the room limit, is hidden from other accounts and has no command target until the original eligible host tab rejoins. A new tab, changed media, explicit leave or closed room cannot inherit those settings. The browser still has to confirm fresh decoded playback. This recovery is verified only with isolated Plex simulation.
- Host heartbeat loss or explicit host leave revokes remote consent, returns sharing to owner mode and rotates the command epoch before another viewer takes over. The successor must opt in again; an old command cannot re-enable control.
- Relinking or revoking a Plex account invalidates cached and in-flight scope validation; an older response cannot restore the previous credential after that change.

The initial codec preflight only skips explicitly unsupported HEVC families or known unsupported audio formats and asks for the existing H.264/AAC conversion. Positive/unknown hints still require observed video playback. This is an initial latency improvement, not complete profile/container/track negotiation.

Plezy's native cache work offers two useful lessons: budget forward and rewind memory together, and measure the seconds of protection that those bytes actually provide at the current bitrate. Its host recovery coordinator also waits for refill headroom with hysteresis after a stall, reducing repeated stop/start cycles. Browser equivalents need measured ranges and an explicit room recovery policy; native mpv properties and Android heap/memory signals are not browser APIs. Relevant upstream areas are `android/app/src/main/kotlin/com/edde746/plezy/mpv/DemuxerBudget.kt`, `lib/widgets/video_controls/widgets/performance_overlay/performance_stats_service.dart` and `lib/watch_together/services/host_playback_coordinator.dart`.

## Audio and subtitle completeness

### Implemented first slice

The player exposes personal audio and subtitle choices using source stream IDs and language/accessibility labels. Switching audio or burned subtitles replaces only that viewer's stream at the shared position and pause intent. External text selection and delay leave video attached. Explicit Off survives title changes within the viewer session; other choices become language/role intent rather than carrying another title's numeric ID. Automatic starts from available Plex selected flags; choices are not stored across a new viewer/browser session.

External SRT/WebVTT captions use the viewer's authorized Plex sidecar endpoint, bounded UTF-8 content and native TextTrack/VTTCue rendering. Arbitrary document HTML, stylesheet and font injection are not used. Cue positioning is retained where supported; default captions clear visible transport controls. Basic text timing is adjustable by up to 30 seconds. Unsupported formats and failed loads remain visible errors with recovery; stale or revoked caption URLs cannot return old cues.

Embedded text, ASS/SSA and known image formats request Plex H.264/AAC burn-in. ASS is not flattened to plain text: Plex owns its fonts, signs and styling. Burn-in first sets and confirms the scoped user's stored part subtitle selection, validates the decision, then captures the private conversion master while holding a part queue. It restores the original subtitle preference, including Off, after capture or preparation failure, and preserves a newer different preference observed before restoration. Audio cleanup still runs if subtitle restoration fails. The queue protects starts within this process; the final preference check and restore remain separate requests with an external-change race window. Real PMS restoration and captured-session restart/seek behavior are still unverified. A refused personal replacement keeps the previous playable stream; a failed initial automatic burn keeps the picker available for Off/another track.

Conversion targets stereo AAC for Plex HLS and stereo Opus for custom AV1. Live PMS investigation found that the universal `audioStreamID` query hint can be ignored: the decision continues to name the user's stored part audio selection. HLS preparation now serializes starts for a part, temporarily sets and confirms the requested scoped audio, validates the decision and captures the private session master before restoring the prior audio preference. Default-audio sessions also start inside the queue. Repeated master loads reuse that captured manifest rather than renegotiating against restored preferences. Cleanup also runs when preparation fails; a newer different choice made by another Plex app is not overwritten. These operations do not change the shared room's audio selection, position or pause state.

The AV1 cache includes source audio and viewer Plex principal. Custom AV1 supports native external text but cannot preserve a Plex burn: requesting styled/image subtitles returns to Plex HLS, and a subsequent incompatible AV1 attempt fails visibly. Full video conversion for multiple audio tracks is a conservative first implementation; lossless/Atmos output, multichannel preservation and efficient audio-only conversion are unfinished. Native text delay is adjustable; the picker separately explains that timing is fixed for Plex burned subtitles even when another operation reports an error.

Plezy also establishes why embedded streams must not be treated as external `/library/streams` files. The [Plex API reference](https://developer.plex.tv/pms/) distinguishes sidecar conversion from embedded extraction and documents per-user part selection. Jellyfin's [subtitle filter implementation](https://github.com/jellyfin/jellyfin/blob/master/MediaBrowser.Controller/MediaEncoding/EncodingHelper.cs) explicitly handles attachment fonts, character encoding and timestamp preservation. These are fidelity checks for the Plex path; replacing an FFmpeg binary alone does not implement them. No Jellyfin binaries or source are bundled.

### Remaining coverage requirements

| Content | Required handling and evidence |
| --- | --- |
| Audio catalog | Stable source IDs plus language, title, codec, channel layout, default, commentary and audio description flags when available. Match language/role preferences across episodes; never reuse an unrelated item's numeric stream ID. |
| Audio switching | Personal selection with a compatible source/HLS path or a fresh conversion when needed. Maintain position, pause intent and A/V sync; rollback or report failure if the intended choice cannot be delivered. Do not depend on universal `HTMLMediaElement.audioTracks` support. |
| Audio conversion | Cover AAC, AC-3/E-AC-3, DTS, TrueHD, Opus, FLAC and legacy inputs through tested server paths. Test dialogue, channel order, stereo downmix, clipping and volume stability. Preserve multichannel output only where verified; do not promise lossless/Atmos passthrough across browsers. |
| Text subtitles | WebVTT delivery for browser text tracks, with tested extraction/conversion of other Plex text formats. Include SRT, SMI, embedded text, UTF-8/BOM and supported legacy encodings. Test timing, line breaks, overlap, CJK and right-to-left text. |
| ASS/SSA | Preserve meaningful positioning, signs, styling and fonts. Compare a browser renderer with server burn-in for fidelity, startup cost, maintenance and server capacity. Converting styled captions to plain text must not be presented as equivalent support. |
| Image subtitles | Provide a tested burn-in or rendering route for PGS and VobSub/SUB/IDX. The selected language/forced stream must be the one delivered. Classify other formats explicitly instead of claiming general support. |
| Selection | Distinguish explicit off, automatic, forced-only, full subtitles and SDH/CC. Respect current Plex language selections/preferences where available and personal choices across reloads. Keep missing/delayed tracks distinct from explicit off. |
| Presentation | Readable size/color/background/position controls where the renderer supports them. Verify captions in fullscreen, theater, phones, Discord focused/grid/PIP and browser-native PIP; their compositing behavior can differ. |
| Track lifecycle | Caption fetch/render failures need recovery with feedback. Do not silently disable requested captions. Ensure local and burned captions cannot appear twice. Stop old track loads when playback changes. |

Subtitle burn negotiation may require changes to Plex's stored part selection. Establish the account/session scope and test simultaneous viewers, including two viewers sharing one Plex identity, before relying on that mechanism. Session-specific parameters are preferable when they actually work; investigate isolation or serialization where necessary. Keep every subtitle and attachment fetch within current per-user media authorization and narrow upstream paths.

Any shared conversion/cache key must include all output-affecting choices: eligible source/version/file, audio, subtitles/rendering, quality, color and timing. Share bytes only when content and authorization boundaries permit it; never share a viewer's credentials as the authority for another viewer.

## Browser and Discord verification targets

The matrix below describes required test targets, not current support claims. Record exact browser/client, OS, device/GPU and acceleration state for results. Establish supported versions from completed tests and repeat on meaningful browser, SDK, server or player changes.

| Surface | Required environments and checks |
| --- | --- |
| Firefox | Primary development coverage on Windows, macOS and Linux; representative hardware, including software decoding and missing system codecs. |
| Chrome and Edge | Windows and macOS, plus Chrome on Linux; test each claimed browser rather than inheriting a Chromium result. |
| Safari | Real macOS, iPhone and iPad; test native HLS, inline/fullscreen playback, user gesture requirements, captions, rotation and background/return behavior. |
| Android browsers | Chrome and Firefox on representative physical devices; weak hardware, changing networks and orientation. |
| Other iOS browsers | Test the actual supported browser/OS combination; a shared engine assumption does not replace lifecycle tests. |
| Discord desktop Activity | Windows, macOS and Linux; acceleration enabled and disabled where possible; focused, grid and PIP transitions, long playback, voice coexistence and rejoin. |
| Discord web Activity | Real embedded Activity within supported desktop browsers, using actual Discord authentication, proxy and URL mappings. A standalone website run is separate evidence. |
| Discord mobile Activity | Real iOS and Android clients where available; SDK behavior, playback gestures, audio focus, orientation, background/return and all available layouts. |

Discord's proxy/CSP, relative manifest/segment/subtitle/font/image URLs, response headers, range requests, cookies/bearer flow and grant renewal must work through the real Activity. Test expired/revoked grants, stalled requests and proxy failures during playback. Keep private Plex URLs and tokens out of the client and diagnostic logs.

Discord documents that encouraging hardware acceleration can prompt a client restart. Treat this as an explicit user action with truthful wording and a tested return flow, never as a harmless automatic retry. A browser handoff is a useful recovery action when a host cannot play the media; Activity playback must still have its own coverage gate.

## Content fidelity and playback UX

- Preserve source cadence for 23.976/24/25/29.97/30/50/59.94/60 fps and handle variable frame rate/interlacing deliberately. Conversion must not uniformly force 30 fps. Validate motion at segment boundaries as well as average decode rate.
- Preserve display aspect ratio, anamorphic pixels, rotation, range and color information. Support HDR only on verified paths, with correct SDR tone mapping otherwise. Separate HDR10, HLG and Dolby Vision profiles; transfer-function detection alone cannot establish correct Dolby Vision conversion.
- Keep one item timeline across split files, seeks, captions, chapters, markers and progress reports. Detect the actual final end; a part boundary or stalled decoder must not finish the title.
- Provide audio/subtitle and version/quality controls with plain labels and confirmed active selections. Explain material recovery actions briefly; keep technical diagnostics available on demand.
- Show useful loading, buffering and recovery feedback promptly. A user gesture blocked by autoplay should produce one clear Play action. Prevent indefinite spinners, silent black screens and repeated acceleration prompts.
- Keep controls visible during keyboard focus, scrubbing, menus and errors. Preserve the existing video-surface click behavior, shared icons, phone layout and accessibility rules.
- Add resume/start-over, chapters, intro/credits skip, previews and a cancellable next-episode flow. Shared seeks/skips/continuation remain authorized room commands. Personal track/quality changes must not change everyone else's preferences.
- Include subtitle search/download through available Plex providers, subtitle timing adjustment and available audio timing controls in the parity audit. Playback-speed controls require an explicit shared room rate, with synchronization nudges applied relative to it. Test capabilities and failures before exposing each control.
- Include Plex content versions, split files and available extras in the parity inventory. Resume/history reporting to Plex needs a deliberate per-user lifecycle and controlled-account validation; it is currently disabled.
- Inventory recorded TV, trailers and other Plex video extras alongside movies/episodes. Live TV/DVR playback requires a separate feasibility pass for live manifests, moving seek windows, tuning and authorization; completion of the on-demand pipeline must not imply live coverage.

## Verification corpus and failure scenarios

Use generated or properly licensed isolated media with known visual frames, audio signals and caption cues. Keep private library files and identifying metadata out of the repository and public test results.

| Dimension | Required representative coverage |
| --- | --- |
| Video | H.264 profiles/levels including an unsupported 10-bit case; HEVC Main/Main10; AV1; VP9; MPEG-2 and other common legacy inputs; SDR/HDR10/HLG and separately identified Dolby Vision samples. |
| Container and timing | MP4/MKV/WebM/TS and representative legacy containers; audio/video start offsets, negative/nonzero timestamps, rotation/anamorphic sources, variable frame rate, split files, missing metadata and damaged media. |
| Load | SD/HD/4K, high bitrate peaks, high frame rate, slow hardware, several viewers with shared and distinct conversion outputs, encoder queue pressure and a server unable to convert. |
| Tracks | Multiple languages, commentary/audio description, stereo/5.1/7.1, silent video, text/styled/image captions, forced/SDH, embedded/external tracks, missing fonts and unavailable subtitle providers. |
| Interaction | Cold start, resume, late join, play/pause bursts, large/repeated/backward seeks, quality/track changes while paused/playing/buffering, end/restart, episode continuation and cancellation. |
| Delivery and lifecycle | Delay/loss/bandwidth changes, Wi-Fi handover, Plex restart, paused transcode expiry, interrupted segments, 403/404/429/5xx, credential revocation, host transfer, tab sleep/wake, Activity layout changes, leave/rejoin and server disconnect. |

Automated policy/HTTP tests, real browser decoding tests, hardware/server tests and live Discord tests provide different evidence. Browser emulation and simulated Activity layouts cannot certify real Safari, hardware acceleration or Discord proxy delivery. Pairwise combinations are useful for breadth; run explicit difficult combinations such as HDR + image subtitles + multichannel audio and track changes during recovery.

Measure time to first visible frame and verified audio, rebuffer frequency/duration, seek recovery, dropped frames, A/V and caption alignment, room drift, hard-seek frequency, encode speed/headroom and resource cleanup. Verify picture, sound and captions together with recognizable samples; media events alone cannot establish all three.

Proposed initial targets for a declared capable server, device and controlled network are: p95 startup within 3 seconds for warm direct/remux and 8 seconds for cold conversion; p95 seek recovery within 2/5 seconds respectively; a two-hour playback run without unplanned stalls; no caption/language loss; no sustained A/V mismatch; and no periodic hard-seek cycle during steady healthy playback. Measure cold direct starts separately. Calibrate and freeze numeric limits against the corpus before claiming them as supported performance. Define failure-feedback and retry deadlines in the same policy, with no indefinite wait.

## Implementation order and completion gates

1. **Establish the baseline and playback model.** Extend the existing diagnostics/corpus to record complete source and output configurations, real timing and failures without secrets. Define client/server capabilities and a small attempt lifecycle in ordinary JavaScript. Add realistic frame-rate, audio and caption samples. Reproduce current behavior in Firefox and a real Discord Activity before selecting new defaults.
2. **Build compatible automatic delivery and recovery.** Implement source/stream inventory and validated per-viewer negotiation; compare direct, remux/audio conversion and full conversion paths. Preserve native cadence and verify color. Gate custom AV1 on measured capability and sustained server throughput. Complete bounded recovery, cancellation and cleanup with tests for superseded requests and denied access.
3. **Complete audio and subtitle delivery.** Implement source selections, preferences, text delivery and styled/image subtitle routes on the same model. Verify source IDs, output truth, track switching and combinations across every primary transport. The baseline content gate includes non-default audio and captions; transport work alone does not complete it.
4. **Prove room and Activity continuity.** Tune synchronization using measurements, add explicit ongoing stall/recovery policy, and verify all real Discord surfaces. Test mixed clients with different delivery paths and tracks, host transfer, backgrounding, repeated seeks and long playback under load.
5. **Complete Plex video UX and certify coverage.** Add resume integration, split-file transitions, chapters/markers/previews, extras and next-episode behavior. Maintain a feature/surface results matrix with pass/fail/blocked evidence. Release only the claimed combinations; keep remaining work in `docs/testing.md`.

Each increment must preserve the single Node service, per-user Plex scopes, validated command engine and off-by-default remote consent. Production changes and live history experiments remain subject to the project's existing approval requirements.

## Plezy lessons and primary references

Plezy provides useful examples of source selection, stable track intent, complete item timelines, first-frame gates, superseded-operation guards, track confirmation and bounded synchronization. Relevant upstream source areas are `lib/services/plex_client.dart`, `lib/services/playback_subtitle_resolver.dart`, `lib/services/playback_open_outcome.dart`, `lib/media/media_part_timeline.dart`, `lib/widgets/video_controls/` and `lib/watch_together/services/`.

Its native decoder assumptions, hardware probing and rendering APIs need browser-specific equivalents. Its broad codec acceptance on unprobed native desktops must not become a browser capability claim. Treat upstream code/comments as implementation evidence to investigate, and validate Plex endpoint behavior independently. Any code or asset reuse requires the repository's license/notice/provenance review.

Primary references checked on 2026-10-15 for this investigation:

- [Media Capabilities decoding information](https://developer.mozilla.org/en-US/docs/Web/API/MediaCapabilities/decodingInfo): support, smoothness and power estimates; estimates can initially be optimistic.
- [MediaSource type checks](https://developer.mozilla.org/en-US/docs/Web/API/MediaSource/isTypeSupported_static): likely type support is not a playback guarantee.
- [hls.js supported environments and codecs](https://github.com/video-dev/hls.js/blob/master/README.md): runtime codec support and native HLS are separate concerns.
- [Browser audio track API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/audioTracks) and [text tracks](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/track): audio switching availability varies; browser text tracks use WebVTT.
- [Plex Direct Play/Direct Stream](https://support.plex.tv/articles/200250387-streaming-media-direct-play-and-direct-stream/): remux, partial conversion and subtitle burn-in tradeoffs.
- [Plex subtitle formats](https://support.plex.tv/articles/200471133-adding-local-subtitles-to-your-media/) and [Plex Web settings](https://support.plex.tv/articles/200289408-plex-web-app-settings/): text/image/styled subtitle behavior and client rendering settings.
- [Plex HDR to SDR tone mapping](https://support.plex.tv/articles/hdr-to-sdr-tone-mapping/): hardware/server dependencies and subtitle conversion cost; verify specific Dolby Vision profiles separately.
- [Discord Activity local development](https://docs.discord.com/developers/activities/development-guides/local-development), [layout](https://docs.discord.com/developers/activities/development-guides/layout) and [user actions](https://docs.discord.com/developers/activities/development-guides/user-actions): proxy/CSP, layout lifecycle and acceleration restart behavior.
