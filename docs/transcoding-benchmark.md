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
- `transcoding.outputs`: Local formats (`av1`, `vp9`, `vp8`). Non-local targets (such as `plex`) are ignored.
- `transcoding.encoder`: Selected encoder policy (`auto`, `hardware`, `nvenc`, `qsv`, `software`).
- `transcoding.cpu_fallback`: Whether to fall back to CPU software encoding if hardware fails.
- `transcoding.hardware_decode`: Whether GPU hardware decode acceleration is enabled.
- `transcoding.qualities`: Tested `[height, Mbps]` pairs.

**Privacy & Security:** The tool sanitizes all data before recording. Authentication tokens, passwords, database paths, and personal directory trees are never logged or exported into benchmark artifacts.

---

## 4. CLI Options & Examples

| Option | Description | Default |
|---|---|---|
| `-i, --input <file>` | Local video file to benchmark. | Synthetic generator |
| `-c, --config <file>` | Path to YAML configuration profile. | `config.yaml` / `config.example.yaml` |
| `-d, --duration <sec>` | Duration of video sample in seconds. | `60` |
| `--start <sec>` | Start position in source file in seconds. | `0` |
| `-m, --mode <mode>` | Encoding mode: `chunks`, `continuous`, or `both`. | `chunks` |
| `--all-encoders` | Test every supported encoder available on the system. | Disabled (uses configured encoder) |
| `--all-codecs` | Test all supported codecs (`av1`, `vp9`, `vp8`). | Disabled (uses configured outputs) |
| `-q, --qualities <list>` | Comma-separated list of qualities (e.g. `1080p8,720p4`). | All configured qualities |
| `-e, --encoders <list>` | Comma-separated list of encoders (`nvenc,qsv,software`). | Configured encoder |
| `--codecs <list>` | Comma-separated list of codecs (`av1,vp9,vp8`). | Configured outputs |
| `-o, --output <dir>` | Directory where artifacts and reports are saved. | `artifacts/transcode-benchmark/run-<timestamp>/` |
| `-r, --runs <number>` | Number of test iterations per configuration. | `1` |
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

# Quick 12-second dry run to verify test matrix:
node scripts/transcode-benchmark.js --all-codecs --qualities 720p4 --dry-run
```

---

## 5. Encoding Methodologies

### A. Chunked Benchmark (Primary)

Models uburoom's native on-demand WebM segment delivery (`server/av1.js`):
- Segments media into 6-second windows (`CHUNK = 6`).
- Keyframes are locked to segment boundaries (`-g 180` at 30 fps).
- Preserves constant frame rate cadence and colorspace metadata (`bt709`).
- Uses high-resolution monotonic timers (`process.hrtime.bigint()`) to time each chunk independently.
- Records process initialization, first-chunk latency, mean, median, P95, and maximum chunk durations.
- Assembles all generated chunks into a seekable review file (`assembled.webm`) using FFmpeg's concat demuxer without re-encoding, verifying duration and track synchronization.

### B. Continuous Benchmark (Comparison Baseline)

Encodes the entire sample duration in one continuous FFmpeg process using identical codec, resolution, bitrate, preset, and rate-control parameters.
- Measures total wall-clock encoding time, effective FPS, and throughput multiplier.
- Enables direct comparison between continuous encoding throughput and the process/pipe overhead of 6-second WebM chunking.

---

## 6. Interpreting Performance Metrics

- **Real-Time Speed Multiplier**: Calculated as `SampleDurationSeconds / TotalEncodingTimeSeconds`.
  - `>= 1.2x (Green)`: Comfortable real-time headroom.
  - `1.0x – 1.2x (Yellow)`: Marginal capacity. Vulnerable to frame drops or buffering stalls under system load.
  - `< 1.0x (Red)`: Slower than real time. Transcoding cannot keep up with playback; viewers will experience buffering.
- **First-Chunk Latency**: The time required to encode chunk 0. Directly determines how quickly playback starts after a viewer joins or seeks.
- **Deadline Misses**: The count of individual 6-second chunks whose encoding time exceeded 6.0 seconds. Each missed deadline represents an MSE buffer underrun risk for live viewers.
- **Effective FPS**: Average encoded frames per second across the test run.

---

## 7. Hardware & Software Fallback Reporting

The benchmark reports both requested backend and actual execution backend truthfully:
- If a hardware encoder is requested (or selected by `auto`) and fails during execution (e.g., missing CUDA runtime, unsupported device, or driver error), the tool records the failure reason and, if `cpu_fallback` is enabled, steps down to the CPU software encoder (`libsvtav1`, `libvpx-vp9`, `libvpx`).
- Reports and structured output explicitly display both the requested encoder and the actual encoder, with a clear `Fallback` badge and explanatory details.
- Software encoder performance is never labeled or presented as hardware acceleration.

---

## 8. Discrepancy Notice: Implementation vs Configuration Comments

During investigation of `config.example.yaml` and `server/av1.js`, an architectural discrepancy was identified:
- **`config.example.yaml` comment**: `# NVENC can only do AV1; Intel QSV can do AV1/VP9/VP8; software does all three.`
- **Actual implementation in `server/av1.js`**:
  ```javascript
  if (codec === 'vp8') throw new PlaybackError('VP8 requires the software backend. Enable CPU fallback or select software.');
  ```
- **Authoritative behavior**: In uburoom's codebase, QSV supports AV1 (`av1_qsv`) and VP9 (`vp9_qsv`). VP8 is software-only (`libvpx`). The benchmark adheres to the actual production implementation, running VP8 via `software` under `auto`.

---

## 9. Output Directory Structure

Each benchmark execution creates an isolated output directory:

```
artifacts/transcode-benchmark/run-<timestamp>/
├── report.html                           # Standalone offline comparison report
├── results.json                          # Complete structured JSON results (Schema v1.0.0)
├── results.csv                           # Spreadsheet-ready CSV summary
├── synthetic-reference-1080p30.mkv       # Reference source (when synthetic mode is used)
├── screenshots/                          # Visual comparison frame captures
│   ├── source-frame.jpg
│   └── <config-id>-frame.jpg
└── outputs/                              # Transcoded playable video files
    └── <config-id>/
        ├── assembled.webm                # Playable seekable review file (concat chunks)
        ├── chunks-list.txt               # Concat demuxer input
        └── chunks/                       # Individual measured 6-second WebM chunks
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
