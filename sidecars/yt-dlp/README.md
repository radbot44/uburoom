# Uburoom yt-dlp Sidecar

Optional rolling-cache sidecar for Uburoom's `youtube` source (`delivery: 'sidecar'`). Pre-warms queued YouTube videos onto a bounded local LRU disk cache using `yt-dlp` and serves seekable MP4/WebM files and WebVTT subtitles to Uburoom with frame-accurate local sync, full Web Audio enhancements, and Discord Activity proxy compatibility.

## Quick start (local)

Requires **Python 3.10+**, `yt-dlp` on `PATH` (or installed in a virtualenv via `pip install -r requirements.txt`), and **FFmpeg / ffprobe** on `PATH` (for merging high-bitrate video+audio streams into MP4 and probing exact codecs/duration).

```bash
pip install -r requirements.txt
python server.py
```

By default it listens on `http://127.0.0.1:8780` and stores cached files in `./cache` (up to 20 GiB).

## Docker

```bash
docker build -t uburoom-ytdlp sidecars/yt-dlp
docker run -d --name uburoom-ytdlp \
  -p 127.0.0.1:8780:8780 \
  -v /path/to/yt-cache:/cache \
  -e UBUROOM_YTDLP_TOKEN=replace-with-a-long-random-secret \
  uburoom-ytdlp
```

## Configuration (`uburoom` `config.yaml`)

```yaml
sources:
  - id: 'youtube'
    type: 'youtube'
    name: 'YouTube'
    delivery: 'sidecar'
    sidecar_url: 'http://127.0.0.1:8780'
    sidecar_token: '' # Set identically to UBUROOM_YTDLP_TOKEN if bound beyond loopback
    cache_directory: '' # Optional local path to the sidecar cache directory for direct file reads
    api_key: '' # Optional YouTube Data API v3 key for fast metadata and playlists
```

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `UBUROOM_YTDLP_HOST` | `127.0.0.1` | Bind address (`127.0.0.1` keeps it local-only) |
| `UBUROOM_YTDLP_PORT` | `8780` | HTTP listening port |
| `UBUROOM_YTDLP_CACHE_DIR` | `./cache` | Bounded LRU disk cache directory |
| `UBUROOM_YTDLP_MAX_CACHE_BYTES` | `21474836480` (20 GiB) | Automatic LRU eviction ceiling |
| `UBUROOM_YTDLP_TOKEN` | _(empty)_ | Bearer token required on every request when set |
| `UBUROOM_YTDLP_MAX_CONCURRENT` | `2` | Maximum concurrent `yt-dlp` downloads |
| `UBUROOM_YTDLP_COOKIES_FILE` | _(empty)_ | Optional Netscape cookies file passed to `yt-dlp` |
| `UBUROOM_YTDLP_POT_URL` | _(empty)_ | Optional `bgutil` PO Token provider HTTP URL (`http://127.0.0.1:4416`) |
| `UBUROOM_YTDLP_BIN` | `yt-dlp` | Path or command name for `yt-dlp` |
| `UBUROOM_FFPROBE_BIN` | `ffprobe` | Path or command name for `ffprobe` |
| `UBUROOM_FFMPEG_BIN` | `ffmpeg` | Path or command name for `ffmpeg` |

## Security notes

- Keep `UBUROOM_YTDLP_HOST=127.0.0.1` unless Uburoom runs on a separate container/host; if exposed beyond loopback, always set a strong `UBUROOM_YTDLP_TOKEN`.
- Only official YouTube watch/short/playlist URLs are accepted; arbitrary URLs are rejected.
