# Development

Use a local checkout, Node 22.13.0+ and the committed lockfile. Ordinary development needs no frontend build step.

## Local setup

```sh
npm ci
# Generate development TLS certificates (cross-platform Node or PowerShell):
node scripts/new-dev-cert.js
# Or on Windows PowerShell: .\scripts\new-dev-cert.ps1 -DnsNames @('localhost')
node scripts/watch-demo.js --accounts
```

The certificate script refuses to overwrite an existing keypair. Demo accounts/media are disposable and do not load production credentials. Normal startup uses private YAML; see [self-hosting](self-hosting.md). Keep generated artifacts, state and secrets out of Git.

## Browser client

The watch page is one ES module graph from `web/watch.js` (`web/package.json` marks `web/` as modules; the server and tests `require` the ones they share). The entry builds the page bootstrap, the scheduler (`web/watch/scheduler.js`, one 250 ms tick for all periodic work), the time base (`web/watch/time.js`: room clock, monotonic and wall time and timers; nothing else reads `Date.now()` or `performance.now()`) and mounts each module in `web/watch/` with `mount(host, deps)`. A module returns the functions other modules call through `deps`; state that more than one module needs lives in `web/watch/store.js`, by area. `shared/` modules are imported directly from `/shared/…`. `theme.js` and `watch-layout.js` stay classic scripts because they run before first paint. `tests/helpers/watch-module.js` mounts one module in Node with stand-in elements, so tests exercise the real code.

Styles live in `web/styles/`, one stylesheet per component, each named after and owned by the module that mounts the component, inside cascade layers declared in `tokens.css`: `vendor` (OverlayScrollbars and its theme), `tokens`, `base`, `components`, `layout`, `exceptions`. Style by class; IDs are script hooks (a few rules that win by ID specificity still use them). Overrides that must beat every component go in `exceptions.css`, not `!important`. The phone layout has one breakpoint (`web/watch/breakpoints.js`): `web/watch/layout.js` keeps the result in the store and mirrors it to `body[data-layout]`, which stylesheets and scripts both read (it stays `phone` while fullscreen lasts). Popovers, the player settings menu, the timeline tooltip and the viewer card are placed by script, which measures and sets only `--x`/`--y` (and the menu's `--menu-height`); the stylesheet applies them. CSS anchor positioning can replace that measuring once it is dependable in Firefox. Pages other than the watch page load `styles/all.css`.

## Tests

Follow the [lean testing rules](../AGENTS.md#testing). Extend existing meaningful scenarios; do not recreate retired tests referenced in old logs.

| Need | Command |
| --- | --- |
| Format / check formatting | `npm run format` / `npm run format:check` |
| Lint (unused bindings, undeclared globals) | `npm run lint` |
| Type check (`// @ts-check` files in `server/` and `shared/`, no emit) | `npm run typecheck` |
| All of the above plus the Node suite | `npm run check` |
| Focused regression | `node --test tests/<relevant-file>.test.js` |
| Installation diagnostics / doctor | `npm run doctor` / `node scripts/doctor.js` |
| Node suite | `npm test` |
| Full pass/fail/skip output | `npm run test:full` |
| Re-record room scenario traces after an intended room behaviour change (review the diff) | `npm run traces:record` (`-- <name> --runs=10`, or `--check` to compare only) |
| Decoded video/audio baseline | `npm run test:playback` |
| Converter with real FFmpeg (CPU, about 30 s) | `npm run test:ffmpeg` |
| UI smoke before a deploy (all four runners below, Chrome and Firefox) | `npm run smoke` (`node scripts/smoke.js`; `-- --browsers=chrome` for one browser, `-- --sequential` for one runner at a time with live output) |
| Room lifecycle/permissions | `node scripts/room-ui-smoke.js --browsers=chrome,firefox` |
| Quick first playback and same-tab reconnect in Chrome and Firefox | `node scripts/room-ui-smoke.js --playback-only` |
| Queue / Media controls | `node scripts/queue-controls-smoke.js` / `node scripts/media-controls-smoke.js` |
| Library browsing | `node scripts/plex-library-smoke.js` (Chrome and Firefox; `--browsers=` to choose) |
| Scheduled controls | `node scripts/sync-controls-smoke.js --browser=chrome` |
| Local WebM | `node scripts/local-webm-smoke.js --browser=chrome --codec=vp9` |

`tests/room-scenarios.test.js` replays scripted multi-viewer room scenarios (`tests/helpers/room-scenarios/`) against a real fixture server over real sockets on a controlled clock, and compares each viewer's semantic room facts with `tests/fixtures/room-traces/`. Only `protocol.js` there knows the wire format.

## Evidence folder

Scripts that write screenshots, generated media or reports put them outside the repository, in `../uburoom-evidence/artifacts/` (set `UBUROOM_EVIDENCE` to use another folder; see `scripts/lib/evidence.js`). The transcode benchmark lives beside it in `../uburoom-evidence/transcode-benchmark/` with its own README and tests; it reads this checkout's code and configuration.

## Rendered checks

Run on request; not part of `npm test` or a pass/fail gate. Fixture accounts and media only.

| Need | Command |
| --- | --- |
| Screenshot set: fixed surfaces × dark/light × 390/820/1360 px, Chrome and Firefox, into `ui-capture/<date>-<revision>/` in the evidence folder | `npm run ui:capture` (`-- --browsers=chrome --surfaces=lobby,gallery --out=<folder>`) |
| Pixel comparison of two capture folders; per-image changed pixels and bounding box, HTML report in `ui-compare/` in the evidence folder, exit 1 on any difference | `npm run ui:compare -- <folderA> <folderB>` (`--tolerance=8` per channel) |
| Shared-control gallery from the shipped helpers and stylesheets | `/__dev/gallery` on a demo server (`node scripts/watch-demo.js --accounts`); 404 otherwise |

Captures switch theme through the appearance toggle and freeze motion, overlay scrollbars, the invite URL and room times in the capture context only; `manifest.json` lists what is hidden.

Use both Chrome and Firefox for relevant browser checks. TLS, browser binaries and FFmpeg/FFprobe may be required. Missing prerequisites or unexpected skips are not a clean pass. Fixtures establish isolated behavior, not real Plex/Activity/device support.

## Targeted media tools

```powershell
node scripts/build-playback-fixtures.js --out=../uburoom-evidence/artifacts/playback-media-tracks --tracks=on
node scripts/playback-tracks.js --media=../uburoom-evidence/artifacts/playback-media-tracks --out=../uburoom-evidence/artifacts/playback-track-run --browsers=firefox,chrome
```

Use `scripts/playback-recovery.js`, `scripts/sync-baseline.js`, `scripts/sync-startup.js` and `scripts/av1-probe.js` only for their corresponding investigation. `node scripts/codec-diagnostics.js` launches the isolated codec tester; it is not part of the normal server UI. `npm run build:player` rebuilds vendored player/subtitle bundles.

**Kept diagnostics.** With `diagnostics.enabled` (on by default), the server writes one JSON Lines file per local day to `diagnostics/` in the data folder. Each line is a server log line at info or above (`source: "server"`) or a viewer's player row (`source: "viewer"`, with room, viewer name and title). Players upload every 30 seconds and on page close through `POST /api/watch/diagnostics`, outside the room command path. `shared/playback-diagnostics.mjs` holds the one field allowlist that the browser and server both apply, so player rows never carry links, sign-in details or error text. `diagnostics.keep_days` and `diagnostics.max_mb` bound the folder; the oldest days go first, and today's file stops growing at the limit. Player settings → Technical details → Copy diagnostic report gives the same rows for one viewer when a server is not keeping them. A host's report also has `sync-spread` rows (the room's viewer spread, at most one a minute), and the server logs a `Sync` line with the spread every 10 minutes of samples and when the video changes.

**Running FFmpeg by hand.** To test or time a conversion outside the server, start from the arguments `server/av1.js` builds (capture them from `AV1` with a stub executor) rather than retyping them:

- Put `-t` after `-i`, on every output. Before `-i`, with D3D11VA decode, libplacebo and `av1_qsv`, FFmpeg can stall indefinitely with no error. After `-i`, a single `-t` limits only the first output; with several outputs the rest run to the end of the source.
- An output `-to` does not bound reading for a sparse subtitle stream: FFmpeg demuxes every stream until that stream's next packet after the end. An input `-to` with `-copyts` did not stop reading at all. Bound subtitle reads by an all-stream ffprobe `-read_intervals` inspection, as `server/subtitle-resources.js` does.
- Keep `-pix_fmt nv12 -flags +global_header` for `av1_qsv` into WebM, as `encoderArgs` does.
- Conversion is one process per source. Video goes through the segment muxer (`-f segment -segment_time 6 -reset_timestamps 1`) with `-force_key_frames expr:gte(t,n_forced*6)` and, for `av1_qsv` and `av1_nvenc`, `-forced_idr 1`, so every 6-second segment starts with a key frame and carries its own codec header. A segment is complete once the next one opens. The same process copies the chosen audio streams out as Matroska on stdout (`-c:a copy -output_ts_offset <seek + container start time>`), and one decoder per audio choice turns that into 48 kHz stereo floats in memory, so the source is read once. Each chunk then gets its own short Opus encode from its window of those samples, streamed from stdout (live Opus needs no seekable file). The decoder pads with silence where the copy has no sound yet. A seek copies sound from the keyframe before the seek point, so the process's first chunk takes decoded sound only when the copy began at least 0.5 s before its lead (read from the copy's first Matroska blocks), or at the file's start. Otherwise that chunk, silence, and any chunk the process stopped before supplying still read the source in a process of their own. To time a run by hand, add `-t` after each video output's `-map`.
- Cap each test process with a timeout, so a stalled run cannot hold the GPU for the runs after it.
- Expected noise, not failures: ffprobe prints `Error parsing Opus packet header` for every converted chunk's audio, and Intel's runtime prints `TEELIB … SendIOCTL` lines when QSV sessions start together.
- Found on Windows with an Intel Arc A380 (driver 32.0.101.6647, FFmpeg build of July 2025): D3D11-to-Vulkan and Vulkan-to-QSV frame mapping are not implemented, and Vulkan decode fails to start for 10-bit HEVC, so HDR frames cross to libplacebo through system memory. `av1_qsv` rejects QVBR; `-b:v` equal to `-maxrate` selects CBR, and a lower `-b:v` selects VBR. `vpp_qsv` tonemapping crushes shadows, while its scaling matches libplacebo (SSIM 0.99). Recheck these after a driver or FFmpeg update. With driver 32.0.101.9175 and FFmpeg 9.0.2, Vulkan HEVC decode crashes instead, and the driver has no Vulkan video encode, so `av1_vulkan` cannot open.
- Found on Windows with an RTX 4090 (FFmpeg 2024-08 and 9.0.2): CUDA frames cannot be mapped or copied into Vulkan, but Vulkan decode works. The NVENC HDR route decodes on Vulkan, tonemaps with libplacebo, copies to CUDA (`hwupload=derive_device=cuda`), scales smaller qualities with `scale_cuda` and gives NVENC the CUDA frames: five qualities ran at 10.5x real time, against 7x through CUDA decode and system memory, with the same picture (SSIM 0.995). When Vulkan setup fails, FFmpeg decodes on the CPU without an error, so the route watches for `Failed setup for format vulkan` and steps down. From FFmpeg 8, encoders negotiate colour tags: GPU frames still tagged BT.2020 cannot reach an encoder told `-colorspace bt709`, which is why every HDR route ends in libplacebo's BT.709 output.
- Converted sound must join without a click. Each chunk's sound is its own Opus encode, starting `AUDIO_LEAD` early, and the player keeps it from exactly its boundary (Chrome and Firefox trim audio to the append window sample-exactly; a 2 ms early margin overlapped the previous chunk and clicked). Matroska stores audio packet times in whole milliseconds, so separately seeking processes placed samples up to a millisecond apart. Each process snaps its first decoded frame onto the stream's frame grid, anchored at the stream's first packet (from the probe's first half second), counts samples from there and pads or trims to the chunk's sample (`PAD`), so every process, the run's decoder included, lays sound on one timeline. Grids: AAC 1024, AC-3 1536, E-AC-3 256, MP3 576, MP2 1152, DTS 256 (512 at 96 kHz); a grid only needs every frame to be a whole number of steps and half a step wider than the timestamp error. Decoders drop encoder delay from the first packet they decode, after a seek as well as at the start (AC-3 and E-AC-3 1280 of 1536 samples, MP3 47 of 1152), so for these codecs the first frame's end is snapped, not its start. FLAC and PCM snap their first frame's start on its own size, when the probe's packets are all of one size. TrueHD's access units are 40 samples, but its sound starts at a major sync, so its grid is the major sync interval (Blu-ray: 128 units, 5120 samples, after a first interval of any length; FFmpeg's encoder: 16), counted in units from the first packet rather than from the second sync's rounded time. FFmpeg's TrueHD decoder makes one frame too many when it opens: at the stream's start it delays everything by one access unit, and after a seek it comes from the cluster's first packet, 50 ms ahead of the first major sync on a UHD remux, so counting samples across the gap misplaced everything. The commands drop that frame and anything before the first frame at the stream's start or on the grid (`aselect`). The AC-3 and E-AC-3 decoders dither from a generator seeded when they open, so they run with `-cons_noisegen 1`; FFmpeg's AAC decoder fills noise-substituted bands from its own generator, leaving differences around 1e-5 (-100 dB) between processes. `asetpts` truncates its result, so the expression rounds it. Checked offline against one continuous decode, for chunk reads at every boundary and runs from several seeks: maximum difference 0 (AAC: placement exact, with its noise difference) on DTS (`sync-tone.mkv`), DTS-HD MA with a 0.042 s start time, AC-3 and E-AC-3 with `initial_padding`, AAC in Matroska and in MP4 with an edit list, MP3, TrueHD (synthetic and a UHD Blu-ray remux), FLAC and PCM, and sound starting 1.5 s and 7.5 s after the picture. Not snapped, so a join between processes can still be off by up to a millisecond: Vorbis, Opus, ALAC and other codecs without a grid; TrueHD with uneven major syncs or several access units per packet; FLAC and PCM with packets of several sizes. AAC-LD and ELD (480 or 512-sample frames) do not fit AAC's grid and are not handled. A stream whose first packet is later than the probe's first half second is snapped on a grid from zero (codecs with a fixed grid) or not at all (TrueHD, FLAC, PCM). The copy's times must add back both the seek point and the file's start time; leaving out a 0.042 s start time put DTS-HD MA four frames early. One continuous Opus stream cut into WebM segments does not work: browsers treat every segment as a new stream, reset the decoder and drop the encoder delay again. Check with a steady tone, not speech or music.

For UI work, consult the relevant [design guide](design-guide.md) sections and [approved screen behavior](ui-behavior.md) before changing an established interaction. Record results and limitations in [testing](testing.md); historical scripts/counts are not current instructions. Real-provider tests and production changes require separate authorization.

## P1/P2/P13 live two-viewer continuity check

Run only with owner-approved test media, consenting accounts and a known installed revision. This is a **manual real-provider acceptance procedure**, not an automated smoke runner or a replacement for isolated fixture tests. Do not restart or reconfigure production, change another account's Plex state or revoke provider access as a test without separate explicit authorization.

**Record before testing:** installed commit SHA; Node/Plex versions; exact Chrome and Firefox or Discord versions and hardware-acceleration settings; separate Plex viewer account identities (use anonymized labels in published notes); host/device/network; media/container/codecs; quality and direct/proxy/local route for each viewer. Use the existing browser playback diagnostics export, a wall-clock incident log and read-only Plex transcode/process observations. Never upload URLs, tokens, cookies or personal watch history.

1. **Clean baseline (P1/P2, aim for two hours):** Open one saved room on two real viewers with the same title and known-good 720p/4Mbps delivery. Observe uninterrupted picture, dialogue, caption expectations, clock/presentation behavior, dropped frames, unexplained stream replacement, memory/process growth and individual stalls. Do not inject failures during this baseline; report each browser separately, including recording gaps.
2. **Continuity exercise (P1/P2, separate short run):** With both viewers playing, have only viewer B select a different offered quality. Verify A continues normally and B resumes at the shared position with their own tracks. Have B leave/rejoin. If testing a host departure, assign an authorized surviving host first; otherwise the documented host-presence pause is expected. Inspect read-only Plex sessions before and after the final viewer leaves; unrelated jobs must remain untouched.
3. **Queue exercise (P13):** Queue three short authorized items as distinct occurrences. Let A reach its natural end, observe one cancellable ten-second countdown and exactly one next item starting for both viewers. During the next countdown, cancel it once and confirm the queue/current item are not consumed. Resume or explicitly choose the next video under normal room permissions; confirm the final natural end clears active playback and owned resources. Do not interpret an explicit endpoint seek as watched-time credit.
4. **Retained-state exercise (P13):** Pause partway through an item, close the room using its supported UI, then reopen with authorized viewers. Confirm saved item, position and queue order, plus fresh admission/readiness rather than resurrected live streams or consent. A process restart/crash test is **not** part of this procedure without separate restart approval.
5. **Failure and cleanup (P1/P2/P13):** In an isolated test environment only, repeat a brief single-viewer connection loss while the other remains online. Check that the healthy viewer is not interrupted, the returning viewer gets a fresh authorized stream, and final departure releases only owned Plex/FFmpeg work. Avoid altering live Plex credentials, deleting media or disrupting unrelated jobs.

**Pass/fail reporting:** For each stage record A (source/code review), B (isolated regression), C (actual provider/device), D (human picture/audio acceptance) separately. Report deviations, timestamps, client-specific diagnostics, expected-versus-actual room/queue state, Plex output count and cleanup; a missing diagnostic trace is **not verified**, not a pass. Put dated, scoped outcomes and open items in [testing](testing.md), not this procedure. If the clean baseline stalls, keep that as an observed event and examine network/browser/Plex data before assigning root cause.
