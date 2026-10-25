# Synthetic demo media

All seven fixtures are generated locally from FFmpeg's procedural `testsrc2` pattern, a synthetic 440 Hz sine tone and the transparent uburoom wordmark PNG in `assets/branding/uburoom-wordmark-brand.png`. No Plex footage, recording, music, external font or account data is used.

The 60-second synchronization sample is 640×360, 12 fps, H.264 High Level 2.2 with mono AAC LC at 48 kHz. Six 12-second variants cover H.264 Constrained Baseline/Main, VP8, VP9, AV1 and HEVC; MP4 uses AAC and WebM uses Opus. The WebM audio/container tail can extend duration by eight milliseconds. `metadata.json` records the inspected streams and durations of the committed files.

Regenerate when changing test media contracts or supported codec fixtures:

```powershell
node scripts/build-demo-media.js
```
