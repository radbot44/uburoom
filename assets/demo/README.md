# Synthetic demo media

All seven fixtures are generated locally from FFmpeg's procedural `testsrc2` pattern, a synthetic 440 Hz sine tone and the transparent uburoom wordmark PNG in `assets/branding/uburoom-wordmark-brand.png`. No Plex footage, recording, music, external font or account data is used.

The 60-second synchronization sample is 640×360, 12 fps, H.264 High Level 2.2 with mono AAC LC at 48 kHz. Six 12-second variants cover H.264 Constrained Baseline/Main, VP8, VP9, AV1 and HEVC; MP4 uses AAC and WebM uses Opus. The WebM audio/container tail can extend duration by eight milliseconds. `metadata.json` records the inspected streams and durations of the committed files.

To regenerate, supply an existing FFmpeg/FFprobe installation with libx264, libx265, libvpx, libvpx-vp9, libaom-av1, AAC and libopus encoders:

```powershell
node scripts/build-demo-media.js --out=artifacts/demo-media
```

Optional `--ffmpeg=` and `--ffprobe=` select executable paths. The output must be a new directory; the script does not overwrite committed media. Inspect the result and metadata before copying into this directory. If bitrate facts change, update the MP4 capability hints in `diagnostics/codec.js`. Encoding bytes may vary with FFmpeg versions; visual content, duration and stream properties are reproducible from the recipe.

These project fixtures and their recipe use the project's GPL-3.0-only terms. FFmpeg and its encoders are external software with their own licensing and are not bundled. Capability hints are not proof that a particular client decodes a sample.
