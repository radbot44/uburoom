# Development

Use a local-disk checkout and Node 22.13.0+. Install from the committed lockfile; ordinary development needs no frontend build.

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

### Bounded playback and recovery check

The watch page keeps a local diagnostic ring: up to 600 one-second playback samples and 300 events, with separate eviction counts. **Save playback diagnostics** downloads a JSON snapshot from the current tab, including after a control disconnect. Reloading or closing the tab loses the capture; background timer throttling can reduce sample frequency. Nothing is uploaded automatically. Exports contain wall/monotonic timing, decoded/dropped frame counters where available, buffer/readiness state, track ordinals/delivery, classified request failures, teardown reasons and local generation counters for room/media/stream/grant/observation changes. They exclude URLs, credentials, account/room/source IDs, titles, track labels and raw error text. Frame counters do not prove the intended audio or subtitle content, and browser diagnostics do not measure server/Plex memory or explain every upstream failure.

The recovery fixture asserts distinct traces for an expired Plex stream and a failed control poll, saves both snapshots, and checks the download control in desktop, theater and portrait phone layouts. It explicitly activates the host tab before visible decoded-video checks; creating the guest tab can otherwise leave Chromium's host hidden with video decoding suspended. Background playback and sleep/wake need separate lifecycle checks. Browser throttling and application recovery timing remain unchanged.

For an explicitly controlled live reconnect check, open `/watch?playbackProbe=1` before creating the test room. **Test control reconnect (6 seconds)** is available only with loaded media in a private, single-viewer room with remote consent off. It locally rejects this tab's room polls for a fixed six seconds and then resumes normal requests. Media, identity, observation and command requests remain normal; this simulates a control failure, not a physical network outage. The export marks probe start/end and ordinary failure/recovery events. Normal pages have no probe control. Samples also report geometric player intersection with the viewport; this does not detect occlusion by other windows or overlays.

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
