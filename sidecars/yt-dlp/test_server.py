import io
import json
from pathlib import Path
import shutil
import tempfile
import threading
import time
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


class FakeRunner:
    def __init__(self, fail_ids=None, delay_s=0.0):
        self.calls = []
        self.fail_ids = set(fail_ids or [])
        self.delay_s = delay_s

    def __call__(self, argv, cwd=None, timeout=180):
        self.calls.append(list(argv))
        if argv[1:2] == ["--version"]:
            return 0, "2026.01.01\n", ""
        if "--dump-single-json" in argv:
            url = argv[-1]
            if "playlist?list=" in url:
                return 0, json.dumps({
                    "id": "PLtest123",
                    "title": "Test Playlist",
                    "channel": "Curator",
                    "playlist_count": 2,
                    "thumbnails": [{"url": "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"}],
                    "entries": [
                        {"id": "dQw4w9WgXcQ", "title": "First Clip", "uploader": "Chan", "duration": 212},
                        {"id": "live1234567", "title": "Live One", "is_live": True, "duration": 0},
                        {"id": "jNQXAC9IVRw", "title": "Second Clip", "uploader": "Jawed", "duration": 19},
                    ],
                }), ""
            vid = url.split("v=")[-1][:11]
            return 0, json.dumps({
                "id": vid,
                "title": f"Title {vid}",
                "channel": "Demo Channel",
                "duration": 95,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "upload_date": "20240501",
            }), ""
        if "-o" in argv:
            if self.delay_s:
                time.sleep(self.delay_s)
            url = argv[-1]
            vid = url.split("v=")[-1][:11]
            if vid in self.fail_ids:
                return 1, "", "ERROR: Video unavailable\n"
            stage = Path(cwd)
            (stage / f"{vid}.mp4").write_bytes(b"0123456789ABCDEF" * 4)
            (stage / f"{vid}.en.vtt").write_text("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello world\n", encoding="utf-8")
            (stage / f"{vid}.info.json").write_text(json.dumps({
                "id": vid,
                "title": f"Title {vid}",
                "channel": "Demo Channel",
                "duration": 42,
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg",
                "upload_date": "20240501",
            }), encoding="utf-8")
            return 0, "", ""
        return 1, "", "unknown command"


def http_call(base_url, method, path, body=None, headers=None):
    req_headers = dict(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = Request(base_url + path, data=data, method=method, headers=req_headers)
    try:
        with urlopen(req) as resp:
            return resp.status, dict(resp.headers.items()), resp.read()
    except HTTPError as err:
        return err.code, dict(err.headers.items()), err.read()


class SidecarTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="uburoom-ytdlp-test-"))
        self.runner = FakeRunner(fail_ids={"FAIL0000001"})
        cfg = server.SidecarConfig(
            cache_dir=self.tmp,
            max_cache_bytes=160,
            token="secret-token",
            max_concurrent=1,
        )
        self.state = server.SidecarState(cfg, run_cmd=self.runner)
        self.httpd = server.create_server("127.0.0.1", 0, self.state)
        self.port = self.httpd.server_address[1]
        self.base = f"http://127.0.0.1:{self.port}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        self.state.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_auth_and_url_validation(self):
        status, _, _ = http_call(self.base, "GET", "/health")
        self.assertEqual(status, 401)
        headers = {"Authorization": "Bearer secret-token"}
        status, _, raw = http_call(self.base, "GET", "/health", headers=headers)
        self.assertEqual(status, 200)
        self.assertTrue(json.loads(raw)["ok"])

        status, _, _ = http_call(
            self.base,
            "POST",
            "/metadata",
            body={"url": "http://127.0.0.1:8080/internal"},
            headers=headers,
        )
        self.assertEqual(status, 400)

        status, _, _ = http_call(
            self.base,
            "GET",
            "/subtitles/dQw4w9WgXcQ/..%2F..%2Fetc%2Fpasswd",
            headers=headers,
        )
        self.assertEqual(status, 400)

    def test_metadata_prepare_range_subtitles_and_lru(self):
        headers = {"Authorization": "Bearer secret-token"}
        status, _, raw = http_call(
            self.base,
            "POST",
            "/metadata",
            body={"url": "https://youtu.be/dQw4w9WgXcQ"},
            headers=headers,
        )
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(raw)["video"]["id"], "dQw4w9WgXcQ")

        status, _, raw = http_call(
            self.base,
            "POST",
            "/metadata",
            body={"url": "https://www.youtube.com/playlist?list=PLtest123"},
            headers=headers,
        )
        self.assertEqual(status, 200)
        pl = json.loads(raw)
        self.assertEqual(pl["kind"], "playlist")
        self.assertEqual([i["id"] for i in pl["items"]], ["dQw4w9WgXcQ", "jNQXAC9IVRw"])

        status, _, _ = http_call(
            self.base,
            "POST",
            "/prepare",
            body={"id": "dQw4w9WgXcQ", "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ"},
            headers=headers,
        )
        self.assertIn(status, (200, 202))

        deadline = time.time() + 5
        info = None
        while time.time() < deadline:
            s, _, r = http_call(self.base, "GET", "/status/dQw4w9WgXcQ", headers=headers)
            if s == 200 and json.loads(r).get("status") == "ready":
                info = json.loads(r)
                break
            time.sleep(0.05)
        self.assertIsNotNone(info)
        self.assertEqual(info["filename"], "dQw4w9WgXcQ.mp4")

        # Range request (bytes=4-15 -> 12 bytes)
        status, resp_hdrs, data = http_call(
            self.base,
            "GET",
            "/files/dQw4w9WgXcQ",
            headers={**headers, "Range": "bytes=4-15"},
        )
        self.assertEqual(status, 206)
        self.assertEqual(data, b"456789ABCDEF")
        self.assertEqual(resp_hdrs.get("Content-Range"), "bytes 4-15/64")

        # Out-of-bounds range
        status, _, _ = http_call(
            self.base,
            "GET",
            "/files/dQw4w9WgXcQ",
            headers={**headers, "Range": "bytes=999-1000"},
        )
        self.assertEqual(status, 416)

        # Subtitles
        status, resp_hdrs, vtt = http_call(self.base, "GET", "/subtitles/dQw4w9WgXcQ/en", headers=headers)
        self.assertEqual(status, 200)
        self.assertIn("text/vtt", resp_hdrs.get("Content-Type", ""))
        self.assertIn(b"WEBVTT", vtt)

        # Failed download surfaces failed state
        http_call(
            self.base,
            "POST",
            "/prepare",
            body={"id": "FAIL0000001"},
            headers=headers,
        )
        deadline = time.time() + 5
        fail_info = None
        while time.time() < deadline:
            s, _, r = http_call(self.base, "GET", "/status/FAIL0000001", headers=headers)
            if s == 200 and json.loads(r).get("status") == "failed":
                fail_info = json.loads(r)
                break
            time.sleep(0.05)
        self.assertIsNotNone(fail_info)
        self.assertIn("unavailable", fail_info["error"].lower())

        # Prepare a second video -> should trigger LRU eviction (> 160 bytes with vtt!)
        http_call(self.base, "POST", "/warm", body={"items": [{"id": "jNQXAC9IVRw"}]}, headers=headers)
        deadline = time.time() + 5
        while time.time() < deadline:
            s, _, r = http_call(self.base, "GET", "/status/jNQXAC9IVRw", headers=headers)
            if s == 200 and json.loads(r).get("status") == "ready":
                break
            time.sleep(0.05)
        self.assertLessEqual(self.state.cache_stats()["bytes"], 160)
        self.assertFalse((self.tmp / "dQw4w9WgXcQ.mp4").exists())
        self.assertTrue((self.tmp / "jNQXAC9IVRw.mp4").exists())


if __name__ == "__main__":
    unittest.main()
