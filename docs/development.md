# Development

Use a local-disk checkout and Node 22.13.0+. Install from the committed lockfile; ordinary development needs no frontend build.

Chrome and Firefox are equal required web-client test targets. Run relevant browser checks in both. The current remote extension is Firefox-only; Chromium extension support is deferred to M2-P10.

The independent uburoom-remote snapshot carries its own configuration, packaging and ten Node tests without a runtime dependency on this checkout. For cross-repository checks, pass explicit artifact and fixture paths; the runner starts a disposable local TLS fixture without loading `.env` or restarting an installation:

```powershell
node scripts/remote-compatibility.js --extension=<remote-build-directory> --fixtures=<remote-repository>/tests/fixtures/remote-protocol-v1.json
node scripts/firefox-smoke.js --extension=<remote-build-directory> --startup-only
```

These integration tools use this checkout's development certificates. The TLS runner simulates browser APIs and player execution while using the artifact's real background/protocol source. The Firefox startup smoke installs an isolated copy against synthetic local pages; its localhost origins and content-script fixture matches do not change the distributed build. Full lifecycle and real YouTube TV verification remain separate checks.

```powershell
npm ci
.\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
npm test
node scripts/watch-demo.js --accounts
```

Generate certificates only on a fresh checkout. The script refuses to overwrite them and installs no trust root. Without test certificates, 13 tests skip: inspect the summary, not merely the exit status.

Keep production environment variables/configuration, databases, keys and certificates out of this checkout. Start/dev/demo npm scripts load `.env` if present. The explicit fixture-demo command does not load an environment file but still inherits process environment; use a clean shell without production Plex/Discord credentials.

Relevant Firefox fixtures:

```powershell
node scripts/watch-smoke.js --accounts
node scripts/watch-smoke.js --tracking --blocked
node scripts/watch-smoke.js
node scripts/plex-library-smoke.js
```

Use the standard Windows Firefox location or set `FIREFOX_BINARY`. Checks create disposable profiles. The full `scripts/firefox-smoke.js` check has an unresolved permission/rate-limit failure and is deferred; it binds localhost 6767/9443 when run. Fixtures do not prove real YouTube TV or Activity behavior.

## Isolated playback baseline

The current browser codec-test UI (`/watch/test` and `web/watch-test.*`) is diagnostic, not required for normal viewing. M1-P7 will hide it from standard navigation or isolate it in developer-only tooling, while retaining capability checks, fixtures and automated playback tests. If running the current diagnostic page, generate its test media first; absent fixtures can return 404.

With existing local test TLS, FFmpeg/FFprobe (libx264, libx265, libsvtav1, AAC and AC-3 encoders) and installed browsers:

```powershell
npm run test:playback
```

This generates four procedural sources and an HLS rendition, then exercises the actual watch player and authorized media routes in disposable headless Firefox, Chrome and Edge profiles. It never loads `.env`, connects a bot or calls a real Plex/Discord provider. Reports, probe output and generated media stay under a new ignored `artifacts/playback-baseline-*` directory. Existing output is never overwritten.

Use `--browsers=firefox,chrome` to select installed targets; a requested unavailable browser fails rather than skips. `FIREFOX_BINARY`, `CHROMIUM_BINARY` and `EDGE_BINARY` can select executable paths. `--ffmpeg=`, `--ffprobe=` and `--out=` are also supported. The default run explicitly disables accelerated video decoding; `--acceleration=default` leaves the browser default in place but does not prove hardware decoding is active.

To generate once and reuse the same sources across revisions:

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/playback-media
node scripts/playback-baseline.js --media=artifacts/playback-media --out=artifacts/playback-run --browsers=firefox,chrome,edge
```

The corpus includes 23.976/24/60 fps H.264/AAC, HEVC Main10 with two distinguishable AC-3 language tracks and embedded SRT/ASS, external WebVTT, and a pre-generated H.264/AAC HLS conversion. Samples use procedural patterns and sine tones; no external footage, fonts or recordings are packaged. FFmpeg remains an external dependency.

The report checks decoded picture pixels, CFR source cadence, a decoded PCM tone through Web Audio, startup, buffer stalls, room drift and pause/seek/resume. It does not establish physical audio output, caption rendering, source track switching, VFR/A/V/caption alignment, final end-of-stream semantics, live Plex negotiation, real Discord, Safari/mobile or sustained hardware encoding capacity. The HLS provider is simulated, and only this test instance substitutes a bounded software encoder for production AV1 hardware encoding. Generated track/caption inputs are available for subsequent coverage; their presence is not a passed feature check. A failed case produces evidence and a nonzero exit status. `--cases=av1-23976,av1-60` selects the cadence regressions.

For paused preloading, media interruption and cached/outside-cache seek checks, generate longer sources in a new directory:

```powershell
node scripts/build-playback-fixtures.js --duration=90 --out=artifacts/playback-media-buffering
node scripts/playback-baseline.js --media=artifacts/playback-media-buffering --out=artifacts/playback-buffering-run --cases=direct-23976,hls-hevc,av1-23976 --buffering=on
```

`--duration=` accepts integer seconds from 18 through 300. Buffering checks require at least 85 seconds. They pause the actual player, measure its loaded ranges, interrupt synthetic media delivery for ten seconds while authorized room control remains reachable, verify continuing frames/decoded audio with no rebuffer event, rewind into cached data during the outage and seek after delivery returns. When speculative AV1 encoding failed, recovery seeks into that failed chunk. Native file preloading is browser-managed; the native cache threshold is an evidence requirement for this small fixture, not a product guarantee. Reports also contain desktop/theater/phone screenshots for visual inspection. These checks do not simulate a full server disconnect or establish Plex event/live manifest behavior, memory pressure or real Activity delivery.

Use small branches, explicit reviewed staging and `git diff --check`. Run `npm run build:player` only when updating the SDK bundle; retain generated notices. Personal notes and upstream reference checkouts belong outside the repository. Read testing.md for unfinished checks and design-guide.md before UI changes.

### Audio and subtitle playback checks

Generate the extra synthetic HLS language and subtitle renditions once, then run the actual watch player:

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-tracks --tracks=on
node scripts/playback-tracks.js --media=artifacts/playback-media-tracks --out=artifacts/playback-track-run --browsers=firefox,chrome,edge
```

The same browser, TLS and FFmpeg prerequisites apply. Use a new output directory. Five cases per browser check native WebVTT, French SRT/Unicode/delay/Off, independent two-viewer audio via distinguishable decoded PCM tones, burned ASS dialogue/positioned colored signs via actual video pixels, and separate selected-audio AV1 caches with native text. Reports include desktop/theater/phone renders and synthetic provider events. The provider simulates Plex decisions, stored selections and session capture using generated media; it does not verify a real PMS decision, attachment font, PGS/VobSub, concurrent Plex seek/restart or Discord proxy. Test-only software AV1 substitution never enables production software fallback.

### Personal jump correction checks

Options → Sync correction offers Speed adjustments (the existing default) and Occasional jumps. This is a local player preference, stored for the account in this browser/origin when unified accounts are available, otherwise for this browser/origin. Storage refusal leaves a clearly labelled tab-only choice. It does not change room controls or other viewers, and persists independently of remote consent.

Occasional jumps holds 1.00× playback. Moderate drift must remain at least 250 ms in one direction for one second, with a valid clock whose uncertainty is at most 50 ms and less than half the error. The current position needs one second of forward buffer and the destination needs half a second (capped by remaining duration). A committed seek blocks further moderate corrections until playback resumes with advancing decoded frames, then for eight more seconds. Seeking, buffering, backgrounding and missing samples clear drift evidence without erasing this guard. A room/media/stream/epoch/readiness generation change or deliberate mode switch resets it. Errors above 650 ms retain the existing independent guarded recovery; scheduled controls and explicit shared seeks retain their existing coordination. These starting values do not establish the 50 ms presentation target.

Use disposable profiles and synthetic providers, one browser run at a time:

```powershell
node scripts/sync-jumps-smoke.js --browser=firefox
node scripts/sync-jumps-smoke.js --browser=chrome
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-recovery-120 --duration=120 --tracks=on
node scripts/sync-jumps-smoke.js --browser=firefox --hls
node scripts/sync-jumps-smoke.js --browser=chrome --hls
```

The HLS checks require the generated corpus above, local test TLS and FFmpeg/FFprobe; the direct-file checks use the built-in procedural demo. The runner injects forward/backward local drift, verifies cooldown through native seeks, 1.00× sampled rates, continued host decoding, unchanged room revision/readiness, mode switching and preference reload. Outputs under `artifacts/sync-jumps-<browser>[-hls]` contain screenshots, bounded diagnostics, signed jump sizes, all observed seek/refill events and residual currentTime error. A passing check establishes functional recovery rather than a skew or physical motion guarantee. Reports overwrite the matching local fixture directory. `--baseline` captures the same Options surfaces before a UI change.

### Playback synchronization baseline

For source-picture alignment, use the independent decoded pixel clock. It generates a ten-minute procedural source with binary frame numbers, then exercises coarse HLS playlist duration estimates through the actual watch player. It checks late join, paused/playing quality changes, forward/backward seek, private stream refresh and decoder reset. FFmpeg/FFprobe, local test TLS and the requested installed browser are required; no `.env`, production credentials or live providers are used. Run browsers sequentially with fresh output directories.

```powershell
node scripts/source-timeline-smoke.js --browser=chrome --output=artifacts/source-timeline-chrome
node scripts/source-timeline-smoke.js --browser=firefox --output=artifacts/source-timeline-firefox
```

`report.json` retains source-frame numbers, media clocks, room targets, picture differences, source-to-media mapping differences and local diagnostics. Paused pictures and the two source-to-media mappings must match within two source frames; baked source time must agree with its media timestamp within three frames. Playing pixels are captured inside their own `requestVideoFrameCallback` and paired with its `mediaTime`, because `currentTime` can lead or lag the displayed frame. The two viewers are sampled sequentially, so their moving-picture difference is informational and mapping agreement is checked separately. These checks establish source mapping, not photon/speaker timing, Plex transcoding capacity or Android support. Each fresh HLS stream intentionally requests segment zero once to establish its origin; subsequent loading targets the current room position.

The player records `requestVideoFrameCallback` media/compositor timestamps when available, frame intervals/callback gaps, clock offset/uncertainty, request/network RTT and server processing time, shared-timeline presentation/position errors, rate changes and seeks. Schema 2 exports retain 7,200 recent frames separately from events and one-second samples (36,000 frames in soak mode). Frame eviction counts are explicit; this is a recent-frame window, not a full two-hour frame trace. Full physical refresh repetitions, exact photon timing and speaker timing cannot be measured through these APIs. No automatic upload or new server-side viewer telemetry is added.

Use local test TLS, installed Firefox and FFmpeg. This runner creates an isolated localhost service, procedural media and two disposable browser processes; it never reads `.env` or uses live providers. Output directories must be new. Delay injection affects room-state fetches only, symmetrically in each direction; the recovery test locally interrupts just the guest. This does not simulate a whole network link or packet loss.

```powershell
node scripts/sync-baseline.js --controller=arrival --rtts=20,100,200,320 --seconds=10 --output=artifacts/sync-arrival
node scripts/sync-baseline.js --controller=shared --rtts=20,100,200,320 --seconds=10 --output=artifacts/sync-shared
node scripts/sync-report.js artifacts/sync-shared/320-host.json artifacts/sync-shared/320-guest.json --same-timeline
```

`arrival` overrides the target only inside the disposable fixture to reproduce the original controller. `shared` uses the current player target. `--browser=chrome`, `--fps=24000/1001`, `--fps=25`, `--fps=30000/1001`, `--fps=50` and `--fps=60000/1001` select other browser/cadence cases. Keep the same machine/workload/settings when comparing runs. `report.json` contains separate steady/recovery reports and exclusion counts; per-viewer files retain the recovery interval. Confirm content and timeline before using `--same-timeline` on manual exports: sanitized local generation numbers cannot establish cross-viewer identity. Use one continuous room/media/clock segment per pair. Browser frame evidence unavailable on either side is an error, not a passing skew measurement.

The report requires at least 80% healthy grid coverage and more than 100 healthy points before the baseline labels a case `measured`. This is an evidence-quality label, not a synchronization performance pass. Callback intervals containing unobserved presented frames are excluded as `callback-gap`, and their skew remains separate. A run with sparse callbacks can successfully verify local recovery while reporting `insufficient-presentation-coverage`. Steady per-viewer files are saved separately from the files that include recovery. The offline report also refuses clock resets/regressions; select a continuous interval before comparing.

### Matched startup and callback coverage

The startup runner reuses two disposable browser processes and one room, loading fresh media generations for each trial. Within every round and guest RTT, a seeded order counterbalances the current controller against a fixture-only 1.00× mode. That mode suppresses rate nudges while retaining meaningful hard seeks; it never changes production defaults. `roomPaused` frame evidence separates decoded readiness probes from the actual shared start. Reports retain first playing-state receipt, first matching observed content-frame timing, initial error, per-trial steady skew/coverage, correction requests and frame intervals. Steady windows start two seconds after the first shared-playing callback. Raw traces and per-trial reports remain separate, avoiding a pooled percentile that hides a bad trial.

```powershell
node scripts/sync-startup.js --initial-start=immediate --repeats=5 --seconds=6 --rtts=20,320 --output=artifacts/startup-immediate
node scripts/sync-startup.js --initial-start=scheduled --repeats=5 --seconds=6 --rtts=20,320 --output=artifacts/startup-scheduled
node scripts/sync-startup.js --repeats=1 --seconds=4 --rtts=320 --lifecycle=on --output=artifacts/startup-lifecycle
node scripts/sync-startup.js --browser=chrome --fps=60000/1001 --repeats=2 --seconds=6 --output=artifacts/startup-high-rate
node scripts/frame-callback-probe.js --browsers=firefox,chrome --fps=24,60000/1001 --seconds=8 --output=artifacts/frame-probe
```

The immediate-start comparison removes only the local fixture's accepted autoplay deadline, through an instance wrapper around the normal validated execution path. The scheduled mode uses production behavior. Use the same seed, source, browser and workload for comparisons. Lifecycle checks require scheduled mode and cover pause cancellation, replacement, desktop/theater/phone renders and a guest-only interruption after playback starts. The minimal probe serves procedural media on localhost without the watch app/controller and records native frame counts, callbacks, animation intervals and callback work. It helps separate browser reporting limits from application work; it does not measure physical panel refresh or speaker timing. Firefox's sparse callbacks must remain excluded when they leave presentation unknown. No browser permissions, privacy settings or throttling are weakened to improve coverage.

### Frame-pacing correction comparisons

The runner now delays the actual application WebSocket send/receive path, including clock exchanges, rather than obsolete HTTP room fetches. Native WebSocket ping/pong is unaffected by this fixture delay. Use `--policy=precision --comparison=legacy` for the separate sustained 100 ms entry / 50 ms exit candidate; the original gentle experiment remains the default experimental policy. Both candidates are disabled in ordinary players. M1-P6 will use these comparisons to decide whether to promote or remove the candidates, then prune production flags/wiring and retire isolated runners that no longer test supported behavior; this is not an instruction to enable either now. Precision trials retain ±4% gain, require one second of persistent same-direction error, and require uncertainty at most 50 ms and less than half the error. Reconnect, physical output and real asymmetric paths require separate checks.

```powershell
node scripts/sync-startup.js --policy=precision --comparison=legacy --browser=chrome --fps=24 --drift=-0.3 --repeats=2 --seconds=10 --rtts=20,320 --output=artifacts/precision-chrome
node scripts/sync-controls-smoke.js --browser=firefox
node scripts/sync-controls-smoke.js --browser=chrome
```

The controls smoke uses two disposable decoded clients to exercise blocker feedback, host-only timeout choices, scheduled pause/resume and independent recovery, and captures normal/theater/phone timeout layouts. Only the smoke's server readiness deadline is shortened for prompt checks; unit tests verify the actual three/ten/fifteen-second boundaries. No live accounts or `.env` are used.

The startup runner also supports `--comparison=legacy --drift=-0.3`. In this mode, `controller` explicitly enables the experimental bounded gentle policy in the disposable tabs; `legacy` uses the default ±4% gain/150 ms deadband, with the same recovery eligibility. The candidate is disabled by default in ordinary players after observed drop/skew regressions. The normal `--comparison=unit` startup comparison continues to use the default policy. After the guest passes one second of playback, a local seek places it 300 ms behind the mapped shared target; `--drift=0.3` places it ahead. The report records the requested injection explicitly. Each trial retains its raw traces, skew/coverage, native dropped-frame counters, callback gaps/intervals, rate magnitude and observed time away from 1.00×. Rate-duration gaps over 1.5 seconds are classified as unknown. These measurements cannot establish physical judder, display repetition or audio output.

```powershell
node scripts/sync-startup.js --browser=firefox --fps=24 --comparison=legacy --drift=-0.3 --repeats=1 --seconds=15 --rtts=20 --output=artifacts/pacing-firefox-24
node scripts/sync-startup.js --browser=chrome --fps=60 --comparison=legacy --drift=-0.3 --repeats=1 --seconds=15 --rtts=20 --output=artifacts/pacing-chrome-60
node scripts/sync-startup.js --browser=chrome --fps=24 --comparison=legacy --drift=0.3 --repeats=1 --seconds=15 --rtts=320 --lifecycle=on --output=artifacts/pacing-ahead-lifecycle
```

Repeat at `24000/1001`, `24`, `25`, `30`, `50` and `60` fps, in each browser, with fresh output paths and sequential runs to avoid competing fixtures. Use more repeats for calibration; a single trial per mode/cadence is only a regression probe. Raw captures are saved before comparison. A clock reset or regressing presentation timestamp withholds that segment's skew report; `invalid-presentation-segment` is not a pass. Full startup/injection and steady segments are validated separately, so an invalid transition does not invalidate an independently continuous steady window. Other fixture errors still fail the runner. The live M1-P5/M1-P6 procedure is in [testing](testing.md#joint-m1-p5m1-p6-human-verification).

### Shared room conversion check

`shared-transcode-smoke.js` starts three disposable browser processes against local TLS and synthetic Plex scopes. Use a generated track corpus at least 120 seconds long and run browsers sequentially with fresh output directories:

```powershell
node scripts/shared-transcode-smoke.js --media=artifacts/playback-media-recovery-120 --output=artifacts/shared-chrome
node scripts/shared-transcode-smoke.js --browser=firefox --media=artifacts/playback-media-recovery-120 --output=artifacts/shared-firefox
```

The runner never loads `.env`. It checks two matching qualities plus a different one, independent text captions, joining an existing output, producer departure and final cache/session cleanup. Reports record conversion counts and browser evidence. Synthetic quality labels share rendition bytes; live PMS encoder counts and Android need separate checks. Automated pool/HTTP tests additionally cover burned subtitles, audio separation, independent account authorization and credential refresh.

### Browser subtitle rendering

Build pinned browser modules with `npm run build:player`. The native SRT/WebVTT path remains available. Capable watch pages request JASSUB for ASS/SSA and libbitsub for PGS/VobSub; other clients retain Plex burn-in. The Audio and subtitles dialog also offers explicit Plex burn-in. It may require a new video conversion. Browser overlays are retained in the Activity PIP layout; browser/OS video-only PIP does not automatically include them.

Original external tracks are proxied through private viewing grants. Embedded tracks require operator-supplied `FFMPEG_PATH` and `FFPROBE_PATH` (or the existing adjacent-FFprobe default). Extraction copies the selected subtitle stream without video encoding; it does not require the AV1 hardware encoder probe. FFprobe/FFmpeg receive a short-lived loopback source capability, never a Plex token. A source may need to be scanned for the full subtitle track; extraction is bounded by time, output size and concurrency, rather than promising cheap random access for every container.

Limits: two concurrent original-resource jobs, 60 seconds per FFmpeg extraction, 20 seconds for font probing, 64 MiB subtitle output (4 MiB for ASS), 32 font attachments/16 MiB combined, and an eight-entry/96 MiB asset cache. Track changes and departures cancel stale work. All resource responses recheck the active viewing grant/selection, including cache hits. Limits or delivery failures offer retry/burn-in rather than silently removing captions. Workers/fonts/WASM are self-hosted; only WASM compilation is added to the watch CSP, not general JavaScript eval or unrestricted origins.

With a generated track corpus and local fixture TLS:

```powershell
node scripts/subtitle-rendering-smoke.js --browser=firefox --repeats=2 --media=artifacts/playback-media-tracks --out=artifacts/subtitles-firefox
node scripts/subtitle-rendering-smoke.js --browser=chrome --repeats=2 --media=artifacts/playback-media-tracks --out=artifacts/subtitles-chrome
```

Use fresh output directories and run browsers sequentially. `--repeats=1..5` repeats the six format/delivery cases. The runner never loads `.env`: it generates ASS, PGS/VobSub rectangles and an MKV containing those tracks plus a font attachment. It checks real overlay pixels against the same paused video with subtitles Off, startup without another seek, paused delay changes, embedded stream-copy/font delivery, cleanup, transforms and normal/theater/phone/Activity-PIP layouts. The Activity check is CSS/layout only, not a real Discord SDK/proxy test. Review [subtitle licensing gates](third-party.md#subtitle-bundles-and-outstanding-notices) before any distribution.

### Bounded playback and recovery check

For mid-playback HLS quality replacement, use a generated corpus at least 120 seconds long. This runner delays each synthetic two-second HLS fragment by 1.2 seconds, starts two separate browser processes and switches only the host's quality around the middle of the source. It checks repeated up/down switches, current-position fragment selection, decoded advancement, drift, absence of recurring alignment/stall errors and the other viewer's unchanged stream. It also checks a paused quality switch and a shared seek during replacement preparation. Quality labels share pre-generated rendition bytes, so the check does not measure live Plex conversion or bandwidth requirements of different encodes.

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/quality-media --duration=120
node scripts/quality-switch-smoke.js --media=artifacts/quality-media --output=artifacts/quality-chrome
node scripts/quality-switch-smoke.js --browser=firefox --media=artifacts/quality-media --output=artifacts/quality-firefox
node scripts/quality-switch-smoke.js --preparation-only=true --media=artifacts/quality-media --output=artifacts/quality-preparation
```

Keep runs sequential and use fresh output directories. `report.json` records requests, refill/first-frame timing, seek/wait/error counts and viewer isolation. Raw per-viewer diagnostics stay in the output directory. `--delay=0` removes the fixture delivery delay; the default exercises a cold replacement with limited initial headroom. Desktop software decoding does not certify Android or physical A/V output.

The watch page keeps a local diagnostic ring: up to 600 one-second playback samples and 300 events, with separate eviction counts. **Save playback diagnostics** downloads a JSON snapshot from the current tab, including after a control disconnect. Reloading or closing the tab loses the capture; background timer throttling can reduce sample frequency. Nothing is uploaded automatically. Exports contain wall/monotonic timing, decoded/dropped frame counters where available, buffer/readiness state, track ordinals/delivery, classified request failures, teardown reasons and local generation counters for room/media/stream/grant/observation changes. They exclude URLs, credentials, account/room/source IDs, titles, track labels and raw error text. Frame counters do not prove the intended audio or subtitle content, and browser diagnostics do not measure server/Plex memory or explain every upstream failure.

Observation failures also include allowlisted rejection reasons. Accepted reports that earned no watch-time credit record a reason and bounded interval deltas; credited reports do not add an event every second. Reports suppressed without fresh clock evidence are classified locally. Reasons distinguish replay/staleness/stream changes from frozen frames, discontinuities, timing jitter and position mismatch. Unexpected processing/storage failures fail truthfully; a failed storage writer prevents successful durability acknowledgements. These events share the existing event cap and are not persisted server-side. Run `node scripts/watch-smoke.js --tracking --blocked` for isolated decoded-playback, client clock-step/WebSocket-delay, frame-counter disagreement and overlap/expiry coverage; it uses separate visible windows and checks both callback counters before asserting overlap credit. The timing probe verifies that no HTTP room polling occurs. The current `server/watch-socket.js` still dispatches through HTTP-shaped handlers; M1-P11 will extract transport-neutral room operations and remove obsolete HTTP room-control routes after converting direct callers and fixtures.

The recovery fixture asserts distinct traces for an expired Plex stream and an interrupted pushed-state delivery, saves both snapshots, and checks the download control in desktop, theater and portrait phone layouts. Short state-message interruption leaves the connection's stream intact; a real socket disconnect obtains a new stream on rejoin. It explicitly activates the host tab before visible decoded-video checks; creating the guest tab can otherwise leave Chromium's host hidden with video decoding suspended. Background playback and sleep/wake need separate lifecycle checks. Browser throttling and application recovery timing remain unchanged.

For an explicitly controlled live reconnect check, open `/watch?playbackProbe=1` before creating the test room. **Test control reconnect (6 seconds)** is available only with loaded media in a private, single-viewer room with remote consent off. It locally rejects this tab's room polls for a fixed six seconds and then resumes normal requests. Media, identity, observation and command requests remain normal; this simulates a control failure, not a physical network outage. The export marks probe start/end and ordinary failure/recovery events. Normal pages have no probe control. Samples also report geometric player intersection with the viewport; this does not detect occlusion by other windows or overlays.

For an unattended two-hour measurement, open `/watch?soak=1`, prepare a private single-viewer room, then press **Start two-hour soak** during playback with remote consent off. This opt-in page retains up to 8,100 one-second samples and 2,400 events in memory; the ordinary ten-minute ring remains unchanged. Retained diagnostic data deliberately grows within those caps, so account for recorder overhead when interpreting browser heap. At two hours it attempts to pause and leave only the unchanged private test room through existing authorized controls, then requests a download named `uburoom-playback-soak.json`. A changed room/item cancels recording without commanding the new target. Concurrent commands, lost access or unavailable control can prevent cleanup; check the exported end event. Keep the tab open and the computer awake: reload/closure loses the in-memory archive, background throttling can delay sampling/completion, and a blocked download requires using **Save playback diagnostics** afterward. Optional Chromium heap counters are approximate browser-reported values, not complete per-tab memory. The recorder requires no model calls while playback runs.

Generate a longer track corpus, then run one isolated browser at a time:

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-recovery --duration=120 --tracks=on
node scripts/playback-recovery.js --media=artifacts/playback-media-recovery --out=artifacts/playback-recovery-run --browser=firefox
```

The default checks 45 seconds of decoded playback, an eight-second media-only outage, paused fill and rewind, a forced expiry of one captured HLS session, control poll failures, guest and sole-host rejoin after timeout, buffer exhaustion, and fatal HLS retry exhaustion followed by a slow recovery attempt. It confirms that the selected audio and burn source survive recovery, the other viewer is unaffected and the old grant is revoked. The fatal-retry case shortens only the disposable hls.js client's internal fragment retry budget to produce real fatal errors from failed requests; application retry delays and production settings remain unchanged. `--browser=chrome` or `--browser=edge` selects another installed browser. `--soak=5` gives a shorter recovery check without the eight-second outage; the other outage/recovery cases still run. For a two-minute playback window, generate a 240-second corpus and pass `--soak=120`; the source must be at least 35 seconds longer than the requested soak. Outputs remain in a new ignored artifacts directory. This fixture cannot establish real Plex transcode lifetime, multi-hour memory growth, physical audio or Discord Activity behavior.

For a sustained local Firefox run, use a track corpus of at least 200 seconds and a new output directory:

```powershell
node scripts/build-playback-fixtures.js --out=artifacts/playback-media-soak --duration=240 --tracks=on
node scripts/playback-soak.js --media=artifacts/playback-media-soak --out=artifacts/playback-soak-run --minutes=120
```

The soak loops the procedural source with shared seeks near its end. It records decoded frames, French audio samples, buffering and room drift, 30-second checkpoints, server memory, and periodic browser process-tree memory. It forces an eight-second media-delivery outage every 15 minutes, expires the selected HLS session every 20 minutes, and interrupts one control poll after an hour. Each refresh checks the viewer's audio/subtitle choices, the other viewer's unchanged stream and off-by-default remote consent. `--minutes=`, `--expiry-seconds=`, `--outage-seconds=` and `--control-seconds=` can shorten the schedule for diagnostics; use `0` to disable an event. `--identity-seconds=45` shortens only the isolated demo bearer lifetime to exercise login renewal. The default keeps the normal one-hour bearer lifetime. Provider offered bytes estimate fixture delivery load, not measured network throughput. The looped synthetic source does not establish real Plex session lifetime or uninterrupted feature-length playback.

## Room terminology and compatibility

A room is the shared watching space or controllable remote target. Use session for authentication, browser/WebSocket connections and Plex/transcode lifetimes. Playback-history sessions describe technical observation intervals, not separate rooms.

All callers use `room.enable`, `room.disable`, `room.sharing`, `room.visibility`, `room.controls` and `room.autojoin`. The shared Engine rejects the corresponding `session.*` aliases. Discord text commands retain their existing syntax.

Authenticated `/watch-socket` request messages carry `{type:'request', id, path, data?}`. The optional data object selects a mutation; paths identify operations, not public HTTP control endpoints. `/api/rooms` returns `{rooms:[...]}` for remote targets and `/api/command` requires `roomId` and a validated command. Watch operations use `/api/watch/rooms` and its room/viewer resources. These paths return 404 over HTTP; the server dispatches socket requests directly to `server/watch-operations.js`. Integration fixtures retain real authenticated sockets in `tests/helpers/control-client.js`. Login/account bootstrap, library/catalog/artwork, playback history and private media resources remain available over HTTP.

Watch library requests require the `room` query parameter. The extension registers `{type:'room', roomId, epoch, ...}` and receives `{type:'room-ack', roomId, epoch, ...}`. Command acknowledgements and removals also use `roomId`. Shared remote rendering accepts the `room` option only. Firefox's actual `browser.sessions` API, browser automation sessions, auth cookies and Plex transcode sessions retain their technical names. No aliases restore consent or replay commands.
