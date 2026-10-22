# Discord Activity codec observations

These results come from the owner's real Windows Discord Activity run on 2026-10-20, using the admin codec tester deployed at `0fc8c87`. Hardware acceleration was reported **Off**. The exported user agent identifies Discord **1.0.1226**, Electron **42.11.15** and Chromium **148.0.7778.280**, on Windows x64.

The samples were 640 × 360, 12 fps, approximately 12 seconds each, played through the tester's native video element inside the Activity. All sample fetches returned HTTP 200. Audio outcomes below are the owner's observations; frame counts and decoder errors are exported instrumentation.

| Sample | Audio | Owner observation | Video evidence |
| --- | --- | --- | --- |
| H.264 High / MP4 | AAC LC | Neither picture nor sound | 0 frames; decoder initialization failed with `kUnsupportedConfig`, media error 4 |
| H.264 Constrained Baseline / MP4 | AAC LC | Neither picture nor sound | 0 frames; same decoder initialization error |
| H.264 Main / MP4 | AAC LC | Neither picture nor sound | 0 frames; same decoder initialization error |
| VP8 / WebM | Opus | Picture and sound | 144 total frames, 0 dropped, 144 frame callbacks; reached 12.008 s |
| VP9 Profile 0 / WebM | Opus | Picture and sound | 144 total frames, 0 dropped, 144 frame callbacks; reached 12.008 s |
| AV1 Main / WebM | Opus | Picture and sound | 144 total frames, 2 dropped, 142 frame callbacks; reached 12.008 s |
| HEVC Main / MP4 | AAC LC | Sound only | 0 frames, 0 × 0 video dimensions; reached 12 s without a media error |

Keep AV1 available by default. VP9 and VP8 are also demonstrated software-decoding candidates on this client; AV1 is not the only observed working option. H.264 and HEVC cannot replace that compatibility path on this tested setup. HEVC's advancing clock without video also shows why time advancement or a resolved Play request alone is insufficient proof of playback.

For all three H.264 profiles, `canPlayType` returned `probably`; MediaSource support, MediaCapabilities support and WebCodecs' `prefer-software` configuration support were also positive. Those hints contradicted the actual decoder initialization failures. Treat capability APIs as hints, preserve recovery after failed decoding, and require observed video frames before declaring playback successful. The two reported AV1 dropped frames remain part of the evidence; this short run is not a smoothness or throughput guarantee.

These are observations for one client/configuration and these sample profiles, not universal Discord guarantees. They do not establish performance at higher resolutions/bitrates, acceleration-on behavior, other operating systems, HDR, subtitles, or live Plex delivery. The tester's native WebM playback does not certify the application's split-stream MediaSource chunk pipeline for VP8/VP9. The local VP8/VP9 output pipelines are now implemented and have passed synthetic Chrome/Firefox encoder, chunk playback, decoded audio and seek/continuity checks. Actual Activity playback through those new chunk pipelines remains unverified; these native sample observations do not close that integration gate. See [implementation verification](archive/testing-2026-10-22.md#2026-10-20---vp8vp9-local-conversion-m1-p2p3).

The original export remains a private owner-supplied attachment. This document retains its relevant, sanitized results so future codec work can find them without relying on chat history. See [verification status](archive/testing-2026-10-22.md#2026-10-20---discord-activity-codec-results-owner-run).
