# Discord Activity codec observations

Owner run, **2026-10-20**, tester `0fc8c87`: Windows x64, Discord 1.0.1226, Electron 42.11.15, Chromium 148.0.7778.280, acceleration **Off**. Native video samples: 640×360, 12fps, ~12s; all fetches HTTP 200. Audio/picture observations are human evidence; frames/errors are instrumentation.

| Sample | Observed output | Instrumentation |
| --- | --- | --- |
| H.264 High / Constrained Baseline / Main, MP4 + AAC | Neither picture nor sound in all three | 0 frames, decoder `kUnsupportedConfig`, media error 4 |
| VP8/WebM + Opus | Picture and sound | 144 frames/callbacks, 0 drops, 12.008s |
| VP9 Profile 0/WebM + Opus | Picture and sound | 144 frames/callbacks, 0 drops, 12.008s |
| AV1 Main/WebM + Opus | Picture and sound | 144 frames, 142 callbacks, 2 drops, 12.008s |
| HEVC Main/MP4 + AAC | Sound only | 0 frames, 0×0 picture, clock reached 12s without media error |

All H.264 profiles had positive canPlayType/MSE/MediaCapabilities/WebCodecs hints despite decoder failure. Advancing time likewise did not prove HEVC picture. Require decoded frames and preserve failure recovery.

AV1 remains the default local output; VP8/VP9 are additional candidates. This run does not certify high-resolution performance, acceleration-on, other OS/client versions, HDR/subtitles, live Plex, or the split-stream MediaSource chunk pipeline. Local VP8/VP9 Chrome/Firefox fixture passes are separate from real Activity streaming, which remains open.

The private owner export is the source; sanitized results above are retained for future compatibility decisions. See [verification](testing.md).
