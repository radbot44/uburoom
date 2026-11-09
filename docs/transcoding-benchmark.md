# uburoom Transcoding Benchmark (Stage 1)

The transcoding benchmark is a standalone command-line diagnostic tool and comparison suite for evaluating hardware and software video transcoding performance in uburoom.

It reproduces the exact encoding parameters, rate control, frame pacing, scaling, WebM chunking, hardware acceleration, and fallback paths used by uburoom's native streaming engine without running the server, connecting to remote services, or modifying application state.

---

## 1. Prerequisites

- **Node.js**: Version >= 20.0.0 (Node 22 LTS recommended).
- **FFmpeg & FFprobe**: Configured via `tools.ffmpeg` / `tools.ffprobe` in `config.yaml`, passed via `--ffmpeg` / `--ffprobe`, or discoverable on `PATH`.
  - For hardware AV1 encoding on NVIDIA: an Ada Lovelace or newer GPU (e.g., RTX 40-series) with driver support for `av1_nvenc`.
  - For hardware AV1 / VP9 encoding on Intel: an Intel Arc GPU (Alchemist or newer) or 11th Gen+ Core processor with Quick Sync Video (`av1_qsv`, `vp9_qsv`).
  - For CPU encoding: multi-core CPU supporting `libsvtav1`, `libvpx-vp9`, and `libvpx`.

---

## 2. Basic Usage

Execute the benchmark using Node:

```powershell
# Windows PowerShell
node scripts/transcode-benchmark.js
```

```bash
# Linux / macOS
node scripts/transcode-benchmark.js
```

By default:
1. Discovers `config.yaml` (falling back to `config.example.yaml`).
2. Reads configured local output codecs and quality tiers.
3. If no input file is supplied, generates a local synthetic 1080p 30fps test pattern with audio.
4. Executes the primary **chunked benchmark** (6-second segments matching uburoom MSE delivery).
5. Assembles chunks into seekable, playable review artifacts without re-encoding.
6. Generates high-resolution performance metrics, structured `results.json`, `results.csv`, and an offline interactive `report.html`.

---

## 3. Configuration Discovery & Profiles

Configuration is resolved in the following priority:
1. `--config <path>`: Explicit configuration profile path. Fails clearly if the file is missing.
2. `config.yaml`: The repository's local configuration, if present.
3. `config.example.yaml`: The distributed example template.

The benchmark parses only the `transcoding` and `tools` sections:
- `transcoding.outputs`: Local formats (`av1`, `vp9`, `vp8`). Non-local targets (such as `plex`) are ignored. An explicitly empty `outputs: []` is respected without forcing default codecs.
- `transcoding.encoder`: Selected encoder policy (`auto`, `hardware`, `nvenc`, `qsv`, `software`).
- `transcoding.cpu_fallback`: Whether to fall back to CPU software encoding if hardware fails.
- `transcoding.hardware_decode`: Whether GPU hardware decode acceleration is enabled.
- `transcoding.qualities`: Tested `[height, Mbps]` pairs.
- `tools.ffmpeg` / `tools.ffprobe`: Relative paths resolve beside the active configuration file.

**Privacy & Security:** The tool sanitizes all data before recording. Authentication tokens, passwords, database paths, and personal directory trees are never logged or exported into benchmark artifacts.

---

## 4. CLI Options & Examples

| Option | Description | Default |
|---|---|---|
| `-i, --input <file>` | Local video file to benchmark. | Synthetic generator |
| `-c, --config <file>` | Path to YAML configuration profile. | `config.yaml` / `config.example.yaml` |
| `-d, --duration <sec>` | Duration of video sample in seconds (> 0). | `60` |
| `--start <sec>` | Start position in source file in seconds (>= 0). | `0` |
| `-m, --mode <mode>` | Encoding mode: `chunks`, `continuous`, or `both`. | `chunks` |
| `--all-encoders` | Test every supported encoder available on the system. | Disabled (uses configured encoder) |
| `--all-codecs` | Test all supported codecs (`av1`, `vp9`, `vp8`). | Disabled (uses configured outputs) |
| `-q, --qualities <list>` | Comma-separated list of qualities (e.g. `1080p8,720p4`). | All configured qualities |
| `-e, --encoders <list>` | Comma-separated list of encoders (`nvenc,qsv,software`). | Configured encoder |
| `--codecs <list>` | Comma-separated list of codecs (`av1,vp9,vp8`). | Configured outputs |
| `-o, --output <dir>` | Directory where artifacts and reports are saved. | `artifacts/transcode-benchmark/run-<timestamp>/` |
| `-r, --runs <number>` | Number of test iterations per configuration (>= 1). | `1` |
| `--probe-only` | Detect usable encoder capabilities, print summary, and exit. | Disabled |
| `--dry-run` | Print resolved test matrix without executing encodes. | Disabled |
| `--synthetic` | Force generation of local synthetic test media. | Disabled |
| `--ffmpeg <path>` | Explicit path to FFmpeg binary. | PATH discovery / config |
| `--ffprobe <path>` | Explicit path to FFprobe binary. | PATH discovery / config |
| `-h, --help` | Show command-line help screen. | |

### Representative Examples

```powershell
# Probe hardware capabilities and discovered encoders:
node scripts/transcode-benchmark.js --probe-only

# Benchmark a custom movie clip (60-second window starting at 2 minutes):
node scripts/transcode-benchmark.js --input "D:\Media\sample.mkv" --start 120 --duration 60 --qualities 1080p8,720p4

# Compare all available encoders across all supported codecs:
node scripts/transcode-benchmark.js --all-encoders --all-codecs --mode both

# Quick dry run to verify test matrix:
node scripts/transcode-benchmark.js --all-codecs --qualities 720p4 --dry-run
```

---

## 5. Encoding Methodologies & Production Parity

### A. Chunked Benchmark (Primary)

Models uburoom's native on-demand WebM segment delivery (`server/av1.js`):
- Segments media into 6-second windows (`CHUNK = 6`).
- Keyframes are locked to segment boundaries (`-g 180` at 30 fps).
- Preserves constant frame rate cadence and colorspace metadata (`bt709`).
- Uses high-resolution monotonic timers (`process.hrtime.bigint()`) to time each chunk independently.
- Records process initialization, first-chunk latency, mean, median, P95, and maximum chunk durations.
- Assembles all generated chunks into a seekable review file (`assembled.webm`) using FFmpeg's concat demuxer without re-encoding, verifying duration and track synchronization.

### B. Production Audio & Timing Comparison

In production (`server/av1.js`), uburoom prepares chunks for browser Media Source Extensions (MSE):
1. **Split-Stream Pipes**: Production outputs video over `pipe:1` (`-map 0:v:0 -an ...`) and audio over `pipe:3` (`-map 1:a:0 -vn ...`) into separate buffers for `SourceBuffer.appendBuffer()`.
2. **Audio Lead-In**: Production provides an audio run-in of `AUDIO_LEAD = 9912 / 48000 = 0.2065s` (`-ss start-AUDIO_LEAD`, `adelay=9912S:all=1`, duration + 0.24s) so browser MSE decoders can cross-fade and splice chunks without clicks.
3. **Benchmark Single-Container WebM**: The benchmark outputs standard single-container WebM files containing both video (`-map 0:v:0`) and audio (`-map 0:a:0 -c:a libopus -b:a 128k -ac 2 -ar 48000 -af asetpts=PTS-STARTPTS`) when audio is present. Video-only sources apply `-an`. Audio and video start synchronously at PTS 0, avoiding 206ms accumulated drift per chunk in concatenated files.
4. **Performance Impact**: Muxing audio into the single WebM container adds negligible CPU overhead (~0.5-1% libopus encoding) while ensuring output files and concatenated review media are immediately playable in desktop and web players.

### C. Continuous Benchmark (Comparison Baseline)

Encodes the entire sample duration in one continuous FFmpeg process using identical codec, resolution, bitrate, preset, and rate-control parameters.
- Measures total wall-clock encoding time, effective FPS, and throughput multiplier.
- Enables direct comparison between continuous encoding throughput and the process/pipe overhead of 6-second WebM chunking.

---

## 6. Color Processing, Viewing Proxies & Privacy

- **HDR10 & HLG**: GPU routes use `libplacebo` with Vulkan (`-init_hw_device vulkan=v`) for tone-mapping with peak detection off (`bt.2390`). CPU fallback uses `zscale` linear tone-mapping (`zscale=t=linear:npl=100 ... tonemap=hable`).
- **Dolby Vision Profile 5 (`doviP5`)**: Uses proprietary IPTPQc2 color reshaping without an HDR10 base layer. CPU `zscale` cannot decode IPTPQc2. Profile 5 strictly requires Vulkan `libplacebo` (`apply_dolbyvision=1`). If Vulkan/libplacebo is unavailable or fails, the benchmark fails closed with `Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping`, preventing corrupt purple/green outputs from being reported as successful.
- **Viewing Proxy (Lossy 8-bit SDR)**: The HTML report generates a lightweight `reference-proxy.mp4` aligned to the sample window for side-by-side inspection. It is clearly labeled as a lossy viewing proxy, not the untouched master. For HDR10/HLG inputs, the proxy is tonemapped using `zscale`. If an input is Dolby Vision Profile 5 and Vulkan `libplacebo` is absent, proxy generation is disabled with an explanatory notice to avoid displaying false colors.
- **Privacy & Redaction**: All error logs, fallback reasons, validation strings, and JSON/CSV/HTML metadata pass through path and URL sanitizers that strip local usernames (`[home]`), drive prefixes, network shares, tokens, and credentials across both Windows and POSIX environments.

---

## 7. Interpreting Performance Metrics

- **Real-Time Speed Multiplier**: Calculated as `SampleDurationSeconds / SuccessfulEncodingTimeSeconds`.
  - `>= 1.2x (Green)`: Comfortable real-time headroom.
  - `1.0x – 1.2x (Yellow)`: Marginal capacity. Vulnerable to frame drops or buffering stalls under system load.
  - `< 1.0x (Red)`: Slower than real time. Transcoding cannot keep up with playback; viewers will experience buffering.
- **First-Chunk Latency**: The time required to encode chunk 0. Directly determines how quickly playback starts after a viewer joins or seeks.
- **Deadline Misses**: The count of individual 6-second chunks whose encoding time exceeded 6.0 seconds. Each missed deadline represents an MSE buffer underrun risk for live viewers.
- **Effective FPS**: Average encoded frames per second across the test run.
- **Total Elapsed vs. Successful Encode Time**: The benchmark reports both total elapsed time (including any failed attempts prior to fallback) and successful encode time. Speed multiplier and effective FPS reflect the successful attempt.

---

## 8. Fallback & Matrix Rules

- **`--all-encoders` Mode**: In comparative encoder testing, unavailable hardware encoders (e.g. QSV on NVIDIA-only machines) are recorded as `skipped` / `unavailable`, rather than silently converted into duplicate software benchmarks.
- **Configured Fallback Mode**: When running with `--encoder auto` (or configured hardware), runtime errors trigger step-downs (first GPU decode to CPU decode, then hardware encoder to CPU software). All fallback steps are recorded in `fallbackEvents` and displayed in reports.
- **Repetition Isolation (`--runs N`)**: Each run writes to isolated directories (`outputs/run-${N}/<configId>/`) and unique screenshot filenames (`screenshots/run-${N}-<configId>-frame.jpg`), preventing file collision.
- **Collision-Safe Output Directories**: Every benchmark invocation uses a unique, collision-free directory (e.g. `artifacts/transcode-benchmark/run-<timestamp>-<pid>/`). If an explicit `--output` points to an existing directory containing files, the benchmark automatically diverts to a safe suffix (`<output>-1`, `<output>-2`) with an operator notice, preventing accidental data loss or clobbering of previous runs. Project source roots (`server`, `web`, `shared`, `.git`) are strictly rejected.

---

## 9. Output Validation & Stream Health

FFprobe frequently omits individual stream durations for WebM containers, causing traditional container-level duration checks to miss audio/video desync. The benchmark implements deep packet-level stream inspection:
1. **Packet Demuxing**: Uses FFprobe packet-level queries (`-show_entries packet=pts_time,duration_time`) to extract true start PTS, end PTS, packet counts, and exact decoded duration for both video and audio.
2. **Frame Coverage**: Compares decoded video packet count against expected frames (`Math.round(sampleDuration * fps)`), flagging missing or dropped frames within a tight tolerance (+/-3 frames).
3. **Chunk Boundary Continuity**: Inspects consecutive video packet timestamps across 6-second chunk joins to verify seamless GOP transitions and detect timestamp jumps or gaps (> 0.085s).
4. **Audio/Video Alignment**: Verifies that video and audio start within 0.08s of each other, end within 0.12s, and have duration deltas under 0.12s.
5. **Full Decode Verification**: Executes a bounded FFmpeg null sink decode (`-f null -`) ensuring all bitstream packets are valid and decodable without fatal errors.
6. **Truthful Status Reporting**: If validation fails, the benchmark reports `FAIL` (never `PASS`), displays the exact validation error reasons, preserves all timing measurements, and updates summary counters (`total`, `passed`, `failed`, `skipped`).

---

## 9. Output Directory Structure

Each benchmark execution creates an isolated output directory:

```
artifacts/transcode-benchmark/run-<timestamp>/
├── report.html                           # Standalone offline comparison report
├── results.json                          # Complete structured JSON results (Schema v1.0.0)
├── results.csv                           # Spreadsheet-ready CSV summary
├── reference-sample.mp4                  # Lightweight playable reference sample (aligned to sample interval)
├── screenshots/                          # Visual comparison frame captures
│   ├── source-frame.jpg
│   └── run-1-<config-id>-frame.jpg
└── outputs/                              # Transcoded playable video files
    └── run-1/
        └── <config-id>/
            ├── assembled.webm            # Playable seekable review file (concat chunks)
            ├── chunks-list.txt           # Concat demuxer input
            └── chunks/                   # Individual measured 6-second WebM chunks
                ├── chunk-000.webm
                ├── chunk-001.webm
                └── ...
```

---

## 10. Offline HTML Comparison Report

Opening `report.html` locally in any web browser (`file:///...`) provides:
1. **System & Environment Overview**: Hardware CPU/GPU specs, memory, FFmpeg build details, and sanitized profile metadata.
2. **Interactive Performance Table**: Sortable and filterable by codec, encoder, resolution, bitrate, status, and speed multiplier.
3. **Throughput Charts**: Visual inline SVG bar charts highlighting the 1.0x real-time threshold.
4. **Chunk Latency Breakdowns**: Per-chunk completion timelines for chunked runs showing the 6.0-second deadline threshold.
5. **Synchronized Video Player**:
   - Target selector dropdown allowing comparison of *any* successful benchmark output.
   - Side-by-side synchronized players with unified play/pause and seek controls.
   - Interactive wipe/split overlay slider allowing the operator to drag a vertical divider across matching frames.
   - Zoom 2x toggle for pixel-level artifact and ringing inspection.
6. **Contact Sheet**: Matching timestamp frame screenshots.
7. **Zero CDN Dependencies**: Self-contained CSS and SVG; functions without network access or local web servers.

---

## 11. Safety & Production Isolation

- **Zero Server Interaction**: Operates independently of any running uburoom process. Never pings endpoints, opens WebSockets, or inspects application memory.
- **Passive Process Inspection**: Scans the OS process list for active `node` instances running uburoom. If detected, issues a non-blocking warning that benchmarking may contend for GPU/CPU resources with live party viewers.
- **Process Lifecycle Safety**: All child processes are spawned safely using argument arrays (preventing shell injection) and registered with a process lifecycle tracker. Canceling the benchmark via `Ctrl+C` (SIGINT) cleanly terminates all FFmpeg processes and removes incomplete temporary files.
- **State & Database Protection**: Never accesses `accounts.sqlite`, private keys, or `.env` files.
- **Storage Protection**: All generated outputs stay contained within the operator-selected output directory.

---

## 12. Stage 1 Scope & Deferred Capabilities

Stage 1 provides single-stream transcoding baseline benchmarking and playable output comparison. The following capabilities are intentionally reserved for subsequent stages:
- Interactive terminal setup wizard (Stage 2)
- Multi-stream concurrency and maximum stream capacity discovery (Stage 2)
- Automated objective quality metrics (VMAF, SSIM, PSNR, CAMBI) (Stage 2)
- Subjective blind A/B comparison workflow (Stage 2)
- Extended endurance / thermal stress testing (Stage 3)
- Direct GPU hardware sensor telemetry (power, clock, thermals) (Stage 3)
- Automated configuration profile recommendations (Stage 3)
