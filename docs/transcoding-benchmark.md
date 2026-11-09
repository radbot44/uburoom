# uburoom Transcoding Benchmark (Stage 2)

The transcoding benchmark is a standalone command-line diagnostic tool, capacity analyzer, and quality evaluation suite for video transcoding in uburoom.

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
| `--concurrency <N>` | Run N simultaneous independent transcode streams (max 16). | `1` |
| `--capacity-scan` | Progressively scan concurrency from 1 stream upward to find limit (requires `--allow-load-test`). | Disabled |
| `--allow-load-test` | Operator safety acknowledgment required for progressive `--capacity-scan` load testing. | Disabled |
| `--force-concurrent-with-server` | Force concurrent benchmarking even if an active uburoom server process is detected. | Disabled |
| `--max-concurrency <N>` | Upper bound for concurrency scanning (clamped to max 16). | `8` |
| `--quality-metrics[=list]` | Compute objective quality metrics (VMAF, SSIM, PSNR, CAMBI) post-encode. Optional list: `--quality-metrics=vmaf,ssim,psnr`. | Disabled |
| `--warmup` | Run an untimed single-chunk transcode before starting measurements. | Disabled |
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

# Benchmark with post-encode objective quality metrics (VMAF, SSIM, PSNR, CAMBI):
node scripts/transcode-benchmark.js --codecs av1 --encoders nvenc --qualities 1080p8 --quality-metrics

# Fixed 3-stream concurrent load test:
node scripts/transcode-benchmark.js --codecs av1 --encoders nvenc --qualities 1080p8 --concurrency 3

# Progressive sustainable capacity scan up to 6 streams:
node scripts/transcode-benchmark.js --codecs av1 --encoders nvenc --qualities 1080p8 --capacity-scan --max-concurrency 6

# Compare all available encoders across all supported codecs:
node scripts/transcode-benchmark.js --all-encoders --all-codecs --mode both
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
- **Collision-Safe Atomic Output Allocation**: Every benchmark invocation uses a unique, collision-free directory (e.g. `artifacts/transcode-benchmark/run-<timestamp>-<pid>/`). If an explicit `--output` is provided, the benchmark claims an exclusively created directory, incrementing to a safe suffix (`<output>-1`, `<output>-2`) on any collision without reusing an existing directory merely because it is empty. Project source roots (`server`, `web`, `shared`, `.git`) are strictly rejected.
- **Process Cancellation & Cleanup**: Abort signals (`AbortController`) propagate promptly to every active FFmpeg encoder subprocess. On cancellation, active child processes are terminated, further chunks and retries are suppressed, and event listeners are cleanly deregistered to prevent memory leaks and warning accumulation. Emergency signal hooks ensure orphaned encoder processes are cleared on exit.

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

## 10. Objective Quality Metrics & Analysis

When `--quality-metrics` (or `--quality-metrics=<vmaf,ssim,psnr,cambi>`) is enabled, the benchmark runs post-encode objective quality evaluation strictly outside timed benchmark loops:
1. **Reference Media**: Evaluates distorted encoded outputs against the **untouched reference source** (never the lossy viewing proxy).
2. **Metrics Evaluated & Probing**:
   - **Executable Probing**: Probes `libvmaf`, `ssim`, `psnr`, and `cambi` using a micro test execution (`testsrc=s=256x256:d=0.08`) rather than documentation regex.
   - **VMAF (`libvmaf`)**: Uses default `vmaf_v0.6.1` model, yielding 0-100 perceptual quality scores.
   - **SSIM (`ssim`)**: Structural similarity index (0.0 to 1.0).
   - **PSNR (`psnr`)**: Peak signal-to-noise ratio in decibels (dB).
   - **CAMBI (`cambi`)**: Contrast Aware Multiscale Banding Index, detecting compression banding and false contouring artifacts. Supported independently via `--quality-metrics=cambi` or in any combination with VMAF, SSIM, and PSNR.
   - **Standalone Fallback**: If `libvmaf` is unavailable or not compiled in FFmpeg, the benchmark falls back to a standalone dual filter graph (`split=2`) calculating SSIM and PSNR simultaneously.
3. **Pacing, Color Range Normalization and Alignment**:
   - Both reference and encoded streams normalize color ranges (`scale=in_range=auto:out_range=tv`) to eliminate false MSE/PSNR penalties from broadcast TV vs full-range video flags.
   - Distorted video is scaled to reference dimensions using bicubic interpolation per VMAF recommendations (`scale=W:H:flags=bicubic`).
   - Timestamps and frame pacing are strictly aligned using `[0:v]setpts=PTS-STARTPTS,fps=N` and `[1:v]setpts=PTS-STARTPTS,fps=N`.
   - Threading is bounded (`:n_threads=8`) with `:shortest=1` to prevent framesync stalls.
4. **Summary Statistics**:
   - Computes mean, harmonic mean, median, min, max, stdDev, and 1st, 5th, and 10th percentiles (`p1`, `p5`, `p10`). Percentiles expose brief quality dips and stutter that aggregate means conceal.
   - Identifies worst 2-second intervals across the video timeline.
5. **Trustworthy Temporal Validation & Packet Inspection**:
   - Demuxes real packet-level presentation timestamps from both the source sample interval and the encoded output via FFprobe (`validateTemporalAlignment`).
   - Verifies presentation start offset ($\le 0.08\text{s}$), total decoded duration coverage ($\pm 0.25\text{s}$), and frame count agreement ($\pm 3$ frames for CFR; $\ge 85\%$ duration for VFR).
   - Does not invent or synthesize presentation timestamps from frame numbers. If packet presentation timestamps cannot be extracted, temporal alignment is truthfully recorded as `unverified` with the reason.
   - Deliberately time-shifted or desynchronized inputs are detected and flagged as `misaligned`, failing quality validation.
6. **HDR & Dolby Vision Handling**:
   - HDR10 sources are tonemapped to SDR BT.709 using `zscale` linear transfer.
   - Dolby Vision Profile 5 without Vulkan `libplacebo` is gracefully rejected to prevent invalid color comparisons.

---

## 11. Multi-Stream Concurrency & Sustainable Capacity

The benchmark supports evaluating multi-user party loads:
1. **Fixed Concurrency (`--concurrency N`, max 16)**:
   - Launches $N$ simultaneous, independent transcode workers in parallel.
   - Each worker runs in an isolated directory (`outputs/concurrency-${N}/run-${run}/worker-${w}/<configId>/`).
   - Repeats (`--runs M`) maintain full trial-level isolation (`run-1`, `run-2`), guaranteeing no file or metric clobbering.
   - Measures aggregate throughput, slowest worker bottleneck speed, and individual chunk deadline misses.
2. **Progressive Capacity Scan (`--capacity-scan`, requires `--allow-load-test`)**:
   - Iteratively tests concurrency levels from 1 up to `--max-concurrency N` (clamped to max 16).
   - Formally designated as a **short-run sustainable capacity estimate based on chunk deadline preservation**.
   - **Strict Capacity Acceptance Criteria**: A concurrency tier is accepted as sustainable *only* if:
     - **0 Missed Deadlines**: Every chunk across all workers finishes in $\le 6.0\text{s}$ (`totalDeadlineMisses === 0`).
     - **Real-Time Margin**: Every worker achieves $\ge 1.05\times$ real-time speed (`minWorkerSpeed >= 1.05`).
     - **P95 Chunk Latency**: Worst worker P95 chunk duration does not exceed $5.1\text{s}$ (`maxWorkerP95ChunkSec <= 5.1`).
     - **Hardware Backend Preserved**: No hardware-to-software encoder fallback occurs during the run.
     - **Zero Worker Failures**: All workers achieve status `pass`.
   - **Conservative Stopping Rule**: Scanning stops immediately upon the first failed tier to prevent runaway GPU queueing or system lockups.
3. **Warmup (`--warmup`)**:
   - Executes an untimed single-chunk transcode prior to starting measurements to eliminate cold GPU driver, shader cache, or thread-pool startup penalties.

---

## 12. Offline HTML Comparison Report

Opening `report.html` locally in any web browser (`file:///...`) provides:
1. **System & Environment Overview**: Hardware CPU/GPU specs, memory, FFmpeg build details, and sanitized profile metadata.
2. **Interactive Performance & Quality Table**: Sortable and filterable by codec, encoder, resolution, bitrate, concurrency, status, speed multiplier, VMAF (mean/p1), SSIM, PSNR, and CAMBI.
3. **Quality vs Performance Scatter Plot**: Visual inline SVG plotting bitrate against VMAF with an efficiency index ($E = \text{VMAF} / \text{Mbps}$).
4. **Timeline Quality Inspector**: Frame-by-frame VMAF timeline chart with highlighted worst-moment dips.
5. **Throughput Charts**: Visual inline SVG bar charts highlighting the 1.0x real-time threshold.
6. **Chunk Latency Breakdowns**: Per-chunk completion timelines for chunked runs showing the 6.0-second deadline threshold.
7. **Synchronized Video Player**:
   - Target selector dropdown allowing comparison of *any* successful benchmark output.
   - Side-by-side synchronized players with unified play/pause and seek controls.
   - Interactive wipe/split overlay slider allowing the operator to drag a vertical divider across matching frames.
   - Zoom 2x toggle for pixel-level artifact and ringing inspection.
8. **Blind A/B Subjective Quality Evaluation Workspace**:
   - Operator selects two candidate encodes to evaluate.
   - Candidates are randomized as "Candidate A" and "Candidate B" with all identifying names, codecs, bitrates, and tooltips masked.
   - Candidate selection dropdowns are hidden during active evaluation to preserve blinding.
   - Calibration check alerts if identical candidates are chosen.
   - Standard 5-level preference rating scale: *Strongly Prefer A*, *Slightly Prefer A*, *Equal*, *Slightly Prefer B*, *Strongly Prefer B*.
   - Free-form observations textarea for operator notes.
   - View modes: Side-by-side, Wipe curtain divider, and 2x Zoom.
   - Speed controls: 0.25x, 0.5x, 0.75x, 1.0x, 1.25x, 1.5x, 2.0x.
   - Identity reveal button displaying true candidate identities using safe DOM APIs (`createElement`/`textContent`).
   - Offline JSON export of subjective trial evaluations.
   - Repeat/Reset button to conduct fresh blinded trials.
   - Explicit offline blinding notice.
9. **Contact Sheet**: Matching timestamp frame screenshots.
10. **Zero CDN Dependencies**: Self-contained CSS and SVG; functions without network access or local web servers.

---

## 13. Safety & Production Isolation

- **Zero Server Interaction**: Operates independently of any running uburoom process. Never pings endpoints, opens WebSockets, or inspects application memory.
- **Passive Process Inspection**: Scans the OS process list for active `node` instances running uburoom. If detected, issues a non-blocking warning that benchmarking may contend for GPU/CPU resources with live party viewers.
- **Process Lifecycle Safety**: All child processes are spawned safely using argument arrays (preventing shell injection) and registered with a process lifecycle tracker. Canceling the benchmark via `Ctrl+C` (SIGINT) cleanly terminates all FFmpeg processes and removes incomplete temporary files.
- **State & Database Protection**: Never accesses `accounts.sqlite`, private keys, or `.env` files.
- **Storage Protection**: All generated outputs stay contained within the operator-selected output directory.

---

## 14. Stage 2 Scope & Deferred Capabilities

Stage 2 completes objective video quality analysis, multi-stream concurrency/capacity testing, and the offline visual/blind A/B comparison workflow. The following capabilities are intentionally reserved for Stage 3:
- Extended endurance / thermal stress testing (Stage 3)
- Direct GPU hardware sensor telemetry (power, clock, thermals) via NVML / Intel sysfs (Stage 3)
- Automated cross-run regression tracking and SQLite historical database (Stage 3)
- Automated configuration profile recommendations (Stage 3)
