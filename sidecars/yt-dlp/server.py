#!/usr/bin/env python3
"""Optional rolling-cache yt-dlp sidecar service for Uburoom."""

from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import threading
import time
from typing import Any, Callable
from urllib.parse import parse_qs, urlparse
import uuid

VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
PLAYLIST_ID_RE = re.compile(r"^[A-Za-z0-9_-]{2,64}$")
TRACK_ID_RE = re.compile(r"^[A-Za-z0-9_.-]{1,64}$")

SHORT_HOSTS = {"youtu.be", "www.youtu.be"}
WEB_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}

CONTAINER_MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".mov": "video/quicktime",
}
MEDIA_EXTS = tuple(CONTAINER_MIME.keys())

MAX_JSON_BODY = 64 * 1024
CHUNK_SIZE = 64 * 1024
DEFAULT_MAX_CACHE_BYTES = 20 * 1024 * 1024 * 1024


class ApiError(Exception):
    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status
        self.message = message


def parse_youtube_url(raw: str) -> tuple[str, str, str]:
    """Validates a YouTube video or playlist URL and returns (kind, id, canonical_url)."""
    if not isinstance(raw, str) or not raw.strip():
        raise ApiError("Provide a YouTube URL", 400)
    parsed = urlparse(raw.strip())
    if parsed.scheme not in ("http", "https") or parsed.username or parsed.password:
        raise ApiError("URL must be http or https without credentials", 400)
    host = (parsed.hostname or "").lower()
    parts = [p for p in parsed.path.split("/") if p]
    qs = parse_qs(parsed.query)

    if host in SHORT_HOSTS:
        vid = parts[0] if parts else ""
        if not VIDEO_ID_RE.match(vid):
            raise ApiError("Invalid YouTube short link", 400)
        return ("video", vid, f"https://www.youtube.com/watch?v={vid}")

    if host not in WEB_HOSTS:
        raise ApiError("Only official YouTube URLs are accepted", 400)

    route = parts[0].lower() if parts else ""
    list_id = (qs.get("list") or [None])[0]
    if list_id and not PLAYLIST_ID_RE.match(list_id):
        list_id = None

    if route in ("", "watch"):
        vid = (qs.get("v") or [None])[0]
        if vid:
            if not VIDEO_ID_RE.match(vid):
                raise ApiError("Invalid YouTube video ID", 400)
            return ("video", vid, f"https://www.youtube.com/watch?v={vid}")
        if list_id:
            return ("playlist", list_id, f"https://www.youtube.com/playlist?list={list_id}")
        raise ApiError("Missing YouTube video or playlist ID", 400)

    if route == "playlist":
        if not list_id:
            raise ApiError("Invalid YouTube playlist ID", 400)
        return ("playlist", list_id, f"https://www.youtube.com/playlist?list={list_id}")

    if route in ("shorts", "live", "embed", "v", "e"):
        vid = parts[1] if len(parts) > 1 else ""
        if not VIDEO_ID_RE.match(vid):
            raise ApiError("Invalid YouTube video ID", 400)
        return ("video", vid, f"https://www.youtube.com/watch?v={vid}")

    raise ApiError("Unsupported YouTube link path", 400)


def safe_cache_path(cache_dir: Path, filename: str) -> Path | None:
    if not filename or "/" in filename or "\\" in filename or "\0" in filename or filename in (".", ".."):
        return None
    base = cache_dir.resolve()
    target = (base / filename).resolve()
    if target.parent != base:
        return None
    raw = cache_dir / filename
    if raw.is_symlink():
        return None
    return target


def now_ms() -> int:
    return int(time.time() * 1000)


def normalize_sub_tag(name: str, video_id: str) -> tuple[str, str]:
    # <video_id>.<track>.vtt -> track id/language
    prefix = f"{video_id}."
    stem = name[:-4]
    track = stem[len(prefix) :] if stem.startswith(prefix) else stem
    track = re.sub(r"[^A-Za-z0-9_.-]+", "_", track)[:64] or "und"
    lang = track.split(".")[0][:16] or "und"
    return track, lang


def year_from_upload_date(raw: Any) -> int | None:
    if isinstance(raw, str) and len(raw) >= 4 and raw[:4].isdigit():
        return int(raw[:4])
    return None


def entry_to_video_meta(raw: dict[str, Any], fallback_id: str = "") -> dict[str, Any]:
    vid = str(raw.get("id") or fallback_id or "")
    duration = float(raw.get("duration") or 0)
    is_live = bool(raw.get("is_live")) or raw.get("live_status") in ("is_live", "is_upcoming")
    return {
        "id": vid,
        "title": raw.get("title") or "YouTube video",
        "channelTitle": raw.get("channel") or raw.get("uploader") or "",
        "duration": duration if duration > 0 else 0,
        "thumbnailUrl": raw.get("thumbnail") if isinstance(raw.get("thumbnail"), str) else None,
        "description": str(raw.get("description") or "")[:500],
        "year": year_from_upload_date(raw.get("upload_date")),
        "isLive": is_live,
    }


@dataclass
class SidecarConfig:
    cache_dir: Path
    max_cache_bytes: int = DEFAULT_MAX_CACHE_BYTES
    token: str = ""
    max_concurrent: int = 2
    cookies_file: str = ""
    po_token_url: str = ""
    ytdlp_bin: str = "yt-dlp"
    ffprobe_bin: str = "ffprobe"
    ffmpeg_bin: str = "ffmpeg"


def default_command_runner(argv: list[str], cwd: Path | None = None, timeout: int = 180) -> tuple[int, str, str]:
    proc = subprocess.run(
        argv,
        cwd=str(cwd) if cwd else None,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


class SidecarState:
    def __init__(
        self,
        config: SidecarConfig,
        run_cmd: Callable[..., tuple[int, str, str]] = default_command_runner,
    ) -> None:
        self.config = config
        self.run_cmd = run_cmd
        self.cache_dir = config.cache_dir.resolve()
        self.tmp_dir = self.cache_dir / "_tmp"
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        shutil.rmtree(self.tmp_dir, ignore_errors=True)
        self.tmp_dir.mkdir(parents=True, exist_ok=True)

        self.lock = threading.RLock()
        self.executor = ThreadPoolExecutor(max_workers=max(1, config.max_concurrent), thread_name_prefix="ytdlp")
        self.ready: dict[str, dict[str, Any]] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.active_ids: set[str] = set()
        self._load_existing()

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=False)

    def _base_ytdlp_args(self) -> list[str]:
        args = [self.config.ytdlp_bin, "--no-config", "--no-call-home", "--no-update"]
        if self.config.cookies_file:
            args.extend(["--cookies", self.config.cookies_file])
        if self.config.po_token_url:
            args.extend(["--extractor-args", f"youtubepot-bgutilhttp:base_url={self.config.po_token_url}"])
        return args

    def _meta_path(self, video_id: str) -> Path:
        return self.cache_dir / f"{video_id}.meta.json"

    def _write_meta(self, record: dict[str, Any]) -> None:
        target = self._meta_path(record["id"])
        tmp = self.cache_dir / f".{record['id']}.meta.tmp"
        tmp.write_text(json.dumps(record), encoding="utf-8")
        os.replace(tmp, target)

    def _load_existing(self) -> None:
        for meta_file in self.cache_dir.glob("*.meta.json"):
            try:
                data = json.loads(meta_file.read_text(encoding="utf-8"))
                vid = data.get("id", "")
                filename = data.get("filename", "")
                if not VIDEO_ID_RE.match(vid):
                    continue
                media_path = safe_cache_path(self.cache_dir, filename)
                if not media_path or not media_path.is_file():
                    meta_file.unlink(missing_ok=True)
                    continue
                data["size"] = media_path.stat().st_size
                data["status"] = "ready"
                self.ready[vid] = data
            except Exception:
                continue

    def _entry_files(self, record: dict[str, Any]) -> list[Path]:
        files: list[Path] = []
        vid = record["id"]
        media = safe_cache_path(self.cache_dir, record.get("filename", ""))
        if media and media.exists():
            files.append(media)
        for sub in record.get("subtitles") or []:
            sub_file = sub.get("file")
            path = safe_cache_path(self.cache_dir, sub_file) if sub_file else None
            if path and path.exists():
                files.append(path)
        meta = self._meta_path(vid)
        if meta.exists():
            files.append(meta)
        return files

    def _entry_bytes(self, record: dict[str, Any]) -> int:
        total = int(record.get("size") or 0)
        for sub in record.get("subtitles") or []:
            path = safe_cache_path(self.cache_dir, sub.get("file", ""))
            if path and path.is_file():
                total += path.stat().st_size
        return total

    def cache_stats(self) -> dict[str, int]:
        with self.lock:
            total = sum(self._entry_bytes(r) for r in self.ready.values())
            return {
                "files": len(self.ready),
                "bytes": total,
                "maxBytes": self.config.max_cache_bytes,
            }

    def _evict_if_needed(self, protect: set[str] | None = None) -> None:
        if self.config.max_cache_bytes <= 0:
            return
        protected = (protect or set()) | self.active_ids
        with self.lock:
            total = sum(self._entry_bytes(r) for r in self.ready.values())
            if total <= self.config.max_cache_bytes:
                return
            candidates = sorted(
                (r for vid, r in self.ready.items() if vid not in protected),
                key=lambda r: int(r.get("lastUsedMs") or r.get("mtimeMs") or 0),
            )
            for rec in candidates:
                if total <= self.config.max_cache_bytes:
                    break
                vid = rec["id"]
                total -= self._entry_bytes(rec)
                for path in self._entry_files(rec):
                    path.unlink(missing_ok=True)
                self.ready.pop(vid, None)

    def _tool_version(self) -> dict[str, Any]:
        ytdlp_ver = None
        ffmpeg_ok = bool(shutil.which(self.config.ffmpeg_bin))
        try:
            code, out, _ = self.run_cmd([self.config.ytdlp_bin, "--version"], timeout=5)
            if code == 0:
                ytdlp_ver = out.strip().splitlines()[0][:40]
        except Exception:
            ytdlp_ver = None
        return {
            "ok": ytdlp_ver is not None,
            "ytdlp": ytdlp_ver,
            "ffmpeg": ffmpeg_ok,
            "cache": self.cache_stats(),
        }

    def health(self) -> dict[str, Any]:
        return self._tool_version()

    def recent(self, limit: int = 30) -> list[dict[str, Any]]:
        capped = max(1, min(int(limit), 100))
        with self.lock:
            ordered = sorted(
                self.ready.values(),
                key=lambda r: int(r.get("lastUsedMs") or r.get("mtimeMs") or 0),
                reverse=True,
            )
            return [self._public_record(r) for r in ordered[:capped]]

    def _public_record(self, rec: dict[str, Any]) -> dict[str, Any]:
        return {
            "id": rec["id"],
            "status": rec.get("status", "ready"),
            "title": rec.get("title", "YouTube video"),
            "channelTitle": rec.get("channelTitle", ""),
            "duration": rec.get("duration", 0),
            "size": rec.get("size", 0),
            "filename": rec.get("filename", ""),
            "container": rec.get("container", "mp4"),
            "videoCodec": rec.get("videoCodec"),
            "audioCodec": rec.get("audioCodec"),
            "width": rec.get("width"),
            "height": rec.get("height"),
            "mtimeMs": rec.get("mtimeMs", 0),
            "thumbnailUrl": rec.get("thumbnailUrl"),
            "description": rec.get("description", ""),
            "year": rec.get("year"),
            "isLive": bool(rec.get("isLive")),
            "subtitles": [
                {"id": s["id"], "language": s["language"], "label": s["label"], "format": "vtt"}
                for s in (rec.get("subtitles") or [])
            ],
        }

    def metadata(self, url: str, limit: int = 50) -> dict[str, Any]:
        kind, target_id, canonical = parse_youtube_url(url)
        capped = max(1, min(int(limit), 200))
        if kind == "video":
            argv = self._base_ytdlp_args() + ["--dump-single-json", "--skip-download", "--no-playlist", "--", canonical]
            code, out, err = self.run_cmd(argv, timeout=30)
            if code != 0:
                raise ApiError(self._clean_ytdlp_error(err) or "Could not fetch YouTube metadata", 502)
            raw = json.loads(out)
            return {"kind": "video", "video": entry_to_video_meta(raw, target_id)}

        argv = self._base_ytdlp_args() + [
            "--dump-single-json",
            "--flat-playlist",
            "--playlist-end",
            str(capped),
            "--",
            canonical,
        ]
        code, out, err = self.run_cmd(argv, timeout=45)
        if code != 0:
            raise ApiError(self._clean_ytdlp_error(err) or "Could not fetch YouTube playlist metadata", 502)
        raw = json.loads(out)
        items: list[dict[str, Any]] = []
        for entry in raw.get("entries") or []:
            if not isinstance(entry, dict):
                continue
            vid = str(entry.get("id") or "")
            if not VIDEO_ID_RE.match(vid):
                continue
            item = entry_to_video_meta(entry, vid)
            if item["isLive"] or not (item["duration"] and float(item["duration"]) > 0):
                continue
            items.append(item)
        thumbs = raw.get("thumbnails") or []
        thumb_url = thumbs[-1].get("url") if thumbs and isinstance(thumbs[-1], dict) else None
        return {
            "kind": "playlist",
            "id": str(raw.get("id") or target_id),
            "title": raw.get("title") or "YouTube playlist",
            "channelTitle": raw.get("channel") or raw.get("uploader") or "",
            "itemCount": int(raw.get("playlist_count") or len(items)),
            "thumbnailUrl": thumb_url,
            "items": items,
        }

    def status(self, video_id: str) -> dict[str, Any] | None:
        if not VIDEO_ID_RE.match(video_id):
            raise ApiError("Invalid video ID", 400)
        with self.lock:
            if video_id in self.ready:
                media = safe_cache_path(self.cache_dir, self.ready[video_id].get("filename", ""))
                if media and media.is_file():
                    return self._public_record(self.ready[video_id])
                self.ready.pop(video_id, None)
                self._meta_path(video_id).unlink(missing_ok=True)
            job = self.jobs.get(video_id)
            return dict(job) if job else None

    def prepare(self, video_id: str, url: str = "") -> tuple[int, dict[str, Any]]:
        if not VIDEO_ID_RE.match(video_id):
            raise ApiError("Invalid video ID", 400)
        canonical = f"https://www.youtube.com/watch?v={video_id}"
        if url:
            kind, parsed_id, canonical = parse_youtube_url(url)
            if kind != "video" or parsed_id != video_id:
                raise ApiError("URL does not match video ID", 400)
        with self.lock:
            existing = self.ready.get(video_id)
            if existing:
                media = safe_cache_path(self.cache_dir, existing.get("filename", ""))
                if media and media.is_file():
                    existing["lastUsedMs"] = now_ms()
                    self._write_meta(existing)
                    return 200, self._public_record(existing)
                self.ready.pop(video_id, None)
            job = self.jobs.get(video_id)
            if job and job.get("status") == "preparing":
                return 202, dict(job)
            job_info = {"id": video_id, "status": "preparing"}
            self.jobs[video_id] = job_info
            self.active_ids.add(video_id)
            self.executor.submit(self._run_download, video_id, canonical)
            return 202, dict(job_info)

    def warm(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        queued: list[str] = []
        for entry in (items or [])[:3]:
            vid = str((entry or {}).get("id") or "")
            url = str((entry or {}).get("url") or "")
            if not VIDEO_ID_RE.match(vid):
                continue
            with self.lock:
                if vid in self.ready or (vid in self.jobs and self.jobs[vid].get("status") == "preparing"):
                    continue
            code, _ = self.prepare(vid, url)
            if code == 202:
                queued.append(vid)
        return {"queued": queued}

    def _clean_ytdlp_error(self, stderr: str) -> str:
        lines = [line.strip() for line in (stderr or "").splitlines() if line.strip()]
        for line in reversed(lines):
            if line.startswith("ERROR:"):
                return line[6:].strip()[:240]
        return lines[-1][:240] if lines else ""

    def _probe_media(self, path: Path) -> dict[str, Any]:
        if not shutil.which(self.config.ffprobe_bin):
            return {}
        try:
            code, out, _ = self.run_cmd(
                [
                    self.config.ffprobe_bin,
                    "-v",
                    "error",
                    "-print_format",
                    "json",
                    "-show_format",
                    "-show_streams",
                    str(path),
                ],
                timeout=15,
            )
            if code != 0:
                return {}
            data = json.loads(out)
            streams = data.get("streams") or []
            video = next((s for s in streams if s.get("codec_type") == "video"), None)
            audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
            fmt = data.get("format") or {}
            duration = float(fmt.get("duration") or 0)
            return {
                **({"duration": duration} if duration > 0 else {}),
                **({"videoCodec": video.get("codec_name")} if video and video.get("codec_name") else {}),
                **({"audioCodec": audio.get("codec_name")} if audio and audio.get("codec_name") else {}),
                **({"width": int(video["width"])} if video and video.get("width") else {}),
                **({"height": int(video["height"])} if video and video.get("height") else {}),
            }
        except Exception:
            return {}

    def _run_download(self, video_id: str, canonical: str) -> None:
        stage = self.tmp_dir / f"{video_id}-{uuid.uuid4().hex[:8]}"
        stage.mkdir(parents=True, exist_ok=True)
        try:
            out_template = str(stage / f"{video_id}.%(ext)s")
            argv = self._base_ytdlp_args() + [
                "--no-playlist",
                "--write-info-json",
                "--write-subs",
                "--write-auto-subs",
                "--sub-langs",
                "en.*,en",
                "--sub-format",
                "vtt",
                "--merge-output-format",
                "mp4",
                "--format",
                "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[ext=mp4]/bv*+ba/b",
                "-o",
                out_template,
                "--",
                canonical,
            ]
            code, _out, err = self.run_cmd(argv, cwd=stage, timeout=600)
            if code != 0:
                raise RuntimeError(self._clean_ytdlp_error(err) or "yt-dlp failed to download this video")

            media_files = [p for p in stage.iterdir() if p.is_file() and p.suffix.lower() in MEDIA_EXTS]
            if not media_files:
                raise RuntimeError("yt-dlp did not produce a video file")
            media_src = media_files[0]
            info_path = stage / f"{video_id}.info.json"
            raw_info: dict[str, Any] = {}
            if info_path.is_file():
                raw_info = json.loads(info_path.read_text(encoding="utf-8"))
            meta = entry_to_video_meta(raw_info, video_id)
            if meta["isLive"]:
                raise RuntimeError("Live streams and upcoming premieres are not supported")

            ext = media_src.suffix.lower()
            dest_filename = f"{video_id}{ext}"
            dest_media = self.cache_dir / dest_filename
            os.replace(media_src, dest_media)

            subtitles: list[dict[str, str]] = []
            for vtt_src in sorted(stage.glob("*.vtt")):
                track_id, lang = normalize_sub_tag(vtt_src.name, video_id)
                sub_filename = f"{video_id}.{track_id}.vtt"
                os.replace(vtt_src, self.cache_dir / sub_filename)
                subtitles.append({"id": track_id, "language": lang, "label": lang.upper(), "file": sub_filename})

            probed = self._probe_media(dest_media)
            ts = now_ms()
            stat = dest_media.stat()
            record = {
                **meta,
                **probed,
                "status": "ready",
                "filename": dest_filename,
                "container": ext.lstrip("."),
                "size": stat.st_size,
                "mtimeMs": ts,
                "lastUsedMs": ts,
                "subtitles": subtitles,
            }
            with self.lock:
                self._write_meta(record)
                self.ready[video_id] = record
                self.jobs.pop(video_id, None)
            self._evict_if_needed(protect={video_id})
        except Exception as exc:
            with self.lock:
                self.jobs[video_id] = {
                    "id": video_id,
                    "status": "failed",
                    "error": str(exc)[:240] or "Download failed",
                }
        finally:
            with self.lock:
                self.active_ids.discard(video_id)
            shutil.rmtree(stage, ignore_errors=True)

    def resolve_media_file(self, video_id: str) -> tuple[Path, str] | None:
        if not VIDEO_ID_RE.match(video_id):
            raise ApiError("Invalid video ID", 400)
        with self.lock:
            rec = self.ready.get(video_id)
            if not rec:
                return None
            media = safe_cache_path(self.cache_dir, rec.get("filename", ""))
            if not media or not media.is_file():
                self.ready.pop(video_id, None)
                return None
            rec["lastUsedMs"] = now_ms()
            self._write_meta(rec)
            mime = CONTAINER_MIME.get(media.suffix.lower(), "video/mp4")
            return media, mime

    def resolve_subtitle_file(self, video_id: str, track_id: str) -> Path | None:
        if not VIDEO_ID_RE.match(video_id) or not TRACK_ID_RE.match(track_id):
            raise ApiError("Invalid subtitle track", 400)
        with self.lock:
            rec = self.ready.get(video_id)
            if not rec:
                return None
            sub = next((s for s in (rec.get("subtitles") or []) if s.get("id") == track_id), None)
            if not sub:
                return None
            path = safe_cache_path(self.cache_dir, sub.get("file", ""))
            return path if path and path.is_file() else None


def parse_byte_range(header: str, size: int) -> tuple[int, int]:
    match = re.match(r"^bytes=(\d*)-(\d*)$", header.strip())
    if not match:
        raise ApiError("Invalid Range header", 416)
    g1, g2 = match.group(1), match.group(2)
    if not g1 and not g2:
        raise ApiError("Invalid Range header", 416)
    if not g1:
        suffix = int(g2)
        if suffix <= 0 or size == 0:
            raise ApiError("Requested range is not satisfiable", 416)
        start = max(0, size - suffix)
        end = size - 1
    else:
        start = int(g1)
        end = int(g2) if g2 else size - 1
        end = min(end, size - 1)
    if size <= 0 or start < 0 or start > end or start >= size:
        raise ApiError("Requested range is not satisfiable", 416)
    return start, end


def make_handler(state: SidecarState) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            return

        def _authorized(self) -> bool:
            token = state.config.token
            if not token:
                return True
            auth = self.headers.get("Authorization") or ""
            if not auth.startswith("Bearer "):
                return False
            supplied = auth[7:]
            return hmac.compare_digest(supplied.encode("utf-8"), token.encode("utf-8"))

        def _send_json(self, status: int, payload: Any) -> None:
            raw = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(raw)

        def _read_json(self) -> dict[str, Any]:
            raw_len = self.headers.get("Content-Length")
            try:
                length = int(raw_len or "0")
            except ValueError:
                raise ApiError("Invalid Content-Length", 400)
            if length < 0 or length > MAX_JSON_BODY:
                raise ApiError("Request body too large", 413)
            body = self.rfile.read(length) if length else b"{}"
            try:
                parsed = json.loads(body.decode("utf-8"))
            except Exception:
                raise ApiError("Invalid JSON request body", 400)
            if not isinstance(parsed, dict):
                raise ApiError("Expected JSON object", 400)
            return parsed

        def _serve_file(self, path: Path, content_type: str, head_only: bool) -> None:
            size = path.stat().st_size
            range_hdr = self.headers.get("Range")
            if range_hdr and size > 0:
                start, end = parse_byte_range(range_hdr, size)
                status = HTTPStatus.PARTIAL_CONTENT
            else:
                start = 0
                end = max(0, size - 1)
                status = HTTPStatus.OK
            length = 0 if size == 0 else (end - start + 1)
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(length))
            self.send_header("Cache-Control", "no-store")
            if range_hdr and size > 0:
                self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
            self.end_headers()
            if head_only or length == 0:
                return
            try:
                with path.open("rb") as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(CHUNK_SIZE, remaining))
                        if not chunk:
                            break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            except (BrokenPipeError, ConnectionResetError):
                return

        def _dispatch(self, method: str) -> None:
            if not self._authorized():
                self._send_json(401, {"error": "Unauthorized"})
                return
            parsed = urlparse(self.path)
            path = parsed.path
            qs = parse_qs(parsed.query)
            try:
                if method in ("GET", "HEAD") and path == "/health":
                    self._send_json(200, state.health())
                elif method in ("GET", "HEAD") and path == "/recent":
                    limit = int((qs.get("limit") or ["30"])[0])
                    self._send_json(200, {"items": state.recent(limit)})
                elif method == "POST" and path == "/metadata":
                    data = self._read_json()
                    res = state.metadata(str(data.get("url") or ""), limit=int(data.get("limit") or 50))
                    self._send_json(200, res)
                elif method == "POST" and path == "/warm":
                    data = self._read_json()
                    res = state.warm(data.get("items") or [])
                    self._send_json(202, res)
                elif method == "POST" and path == "/prepare":
                    data = self._read_json()
                    status_code, info = state.prepare(str(data.get("id") or ""), str(data.get("url") or ""))
                    self._send_json(status_code, info)
                elif method in ("GET", "HEAD") and path.startswith("/status/"):
                    vid = path[len("/status/") :]
                    info = state.status(vid)
                    if not info:
                        self._send_json(404, {"error": "Video not found in sidecar cache"})
                    else:
                        self._send_json(200, info)
                elif method in ("GET", "HEAD") and path.startswith("/files/"):
                    vid = path[len("/files/") :]
                    resolved = state.resolve_media_file(vid)
                    if not resolved:
                        self._send_json(404, {"error": "Video file is not cached"})
                    else:
                        self._serve_file(resolved[0], resolved[1], head_only=(method == "HEAD"))
                elif method in ("GET", "HEAD") and path.startswith("/subtitles/"):
                    rest = path[len("/subtitles/") :]
                    parts = rest.split("/", 1)
                    if len(parts) != 2:
                        self._send_json(404, {"error": "Subtitle track not found"})
                        return
                    sub_path = state.resolve_subtitle_file(parts[0], parts[1])
                    if not sub_path:
                        self._send_json(404, {"error": "Subtitle track is not cached"})
                    else:
                        self._serve_file(sub_path, "text/vtt; charset=utf-8", head_only=(method == "HEAD"))
                else:
                    self._send_json(404, {"error": "Not found"})
            except ApiError as err:
                self._send_json(err.status, {"error": err.message})
            except Exception as exc:
                self._send_json(500, {"error": str(exc)[:200] or "Sidecar internal error"})

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_HEAD(self) -> None:
            self._dispatch("HEAD")

        def do_POST(self) -> None:
            self._dispatch("POST")

    return Handler


def create_server(host: str, port: int, state: SidecarState) -> ThreadingHTTPServer:
    ThreadingHTTPServer.allow_reuse_address = True
    return ThreadingHTTPServer((host, port), make_handler(state))


def config_from_env(args: argparse.Namespace | None = None) -> tuple[str, int, SidecarConfig]:
    host = (args.host if args and args.host else None) or os.environ.get("UBUROOM_YTDLP_HOST", "127.0.0.1")
    port = int((args.port if args and args.port is not None else None) or os.environ.get("UBUROOM_YTDLP_PORT", "8780"))
    cache_dir = Path(
        (args.cache_dir if args and args.cache_dir else None)
        or os.environ.get("UBUROOM_YTDLP_CACHE_DIR")
        or str(Path(__file__).resolve().parent / "cache")
    )
    max_cache_bytes = int(
        (args.max_cache_bytes if args and args.max_cache_bytes is not None else None)
        or os.environ.get("UBUROOM_YTDLP_MAX_CACHE_BYTES", str(DEFAULT_MAX_CACHE_BYTES))
    )
    max_concurrent = int(
        (args.max_concurrent if args and args.max_concurrent is not None else None)
        or os.environ.get("UBUROOM_YTDLP_MAX_CONCURRENT", "2")
    )
    cfg = SidecarConfig(
        cache_dir=cache_dir,
        max_cache_bytes=max_cache_bytes,
        token=os.environ.get("UBUROOM_YTDLP_TOKEN", ""),
        max_concurrent=max_concurrent,
        cookies_file=os.environ.get("UBUROOM_YTDLP_COOKIES_FILE", ""),
        po_token_url=os.environ.get("UBUROOM_YTDLP_POT_URL", ""),
        ytdlp_bin=os.environ.get("UBUROOM_YTDLP_BIN", "yt-dlp"),
        ffprobe_bin=os.environ.get("UBUROOM_FFPROBE_BIN", "ffprobe"),
        ffmpeg_bin=os.environ.get("UBUROOM_FFMPEG_BIN", "ffmpeg"),
    )
    return host, port, cfg


def main() -> None:
    parser = argparse.ArgumentParser(description="Uburoom rolling-cache yt-dlp sidecar")
    parser.add_argument("--host", default=None)
    parser.add_argument("--port", type=int, default=None)
    parser.add_argument("--cache-dir", default=None)
    parser.add_argument("--max-cache-bytes", type=int, default=None)
    parser.add_argument("--max-concurrent", type=int, default=None)
    args = parser.parse_args()
    host, port, cfg = config_from_env(args)
    state = SidecarState(cfg)
    httpd = create_server(host, port, state)
    print(f"uburoom yt-dlp sidecar listening on http://{host}:{httpd.server_address[1]} (cache: {state.cache_dir})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
        state.close()


if __name__ == "__main__":
    main()
