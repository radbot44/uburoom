#!/usr/bin/env bash
# Reproducible builder for Uburoom's custom single-threaded libav.js WebAssembly bundle.
# Requires: git, node (>=22), npm, python3, make, pkg-config, m4, and Emscripten (emcc >= 4.0).
# Outputs:
#   web/vendor/libav/libav-uburoom.mjs
#   web/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.mjs
#   web/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.wasm
#   web/vendor/libav/THIRD_PARTY_NOTICES.txt
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="${ROOT_DIR}/web/vendor/libav"
WORK_DIR="${LIBAV_BUILD_DIR:-/tmp/uburoom-libav-build}"
LIBAV_COMMIT="2baa971a01bdea4545c1c7e4d42855a33d5b8cc2"

if ! command -v emcc >/dev/null 2>&1; then
  echo "Error: emcc not found in PATH. Activate emsdk first (source emsdk_env.sh)." >&2
  exit 1
fi

mkdir -p "${WORK_DIR}" "${OUT_DIR}"
if [ ! -d "${WORK_DIR}/libav.js/.git" ]; then
  git clone https://github.com/Yahweasel/libav.js.git "${WORK_DIR}/libav.js"
fi

cd "${WORK_DIR}/libav.js"
git fetch --all --tags
git checkout "${LIBAV_COMMIT}"
npm install --no-audit --no-fund

# Generate the 'uburoom' variant configuration from the exact fragment list.
node configs/mkconfig.js uburoom '[
  "avformat","avcodec","avbsf","avfilter","swresample","zlib",
  "demuxer-matroska","demuxer-mp4","demuxer-mpegts","demuxer-avi","demuxer-ogg",
  "demuxer-flac","demuxer-mp3","demuxer-wav","demuxer-aac","demuxer-srt","demuxer-ass","demuxer-webvtt","demuxer-sup",
  "muxer-mp4","muxer-webm","muxer-flac","muxer-adts","muxer-srt","muxer-ass","muxer-webvtt",
  "parser-h264","parser-hevc","parser-av1","parser-vp8","parser-vp9","parser-mpeg4video","parser-mpegvideo","parser-vc1",
  "parser-aac","parser-aac_latm","parser-ac3","parser-dca","parser-mlp","parser-flac","parser-opus","parser-vorbis","parser-mpegaudio",
  "bsf-aac_adtstoasc","bsf-dovi_rpu","bsf-dovi_split","bsf-dts2pts","bsf-extract_extradata","bsf-filter_units",
  "bsf-h264_metadata","bsf-h264_mp4toannexb","bsf-hevc_metadata","bsf-hevc_mp4toannexb","bsf-mov2textsub","bsf-null",
  "bsf-pgs_frame_merge","bsf-vp9_metadata","bsf-vp9_superframe","bsf-av1_metadata",
  "filter-aresample","filter-aformat","filter-anull","filter-pan","filter-volume","filter-acompressor",
  "decoder-dca","decoder-truehd","decoder-mlp","decoder-ac3","decoder-eac3","decoder-aac","decoder-aac_latm",
  "decoder-flac","decoder-alac","decoder-wavpack","decoder-opus","decoder-vorbis","decoder-mp1","decoder-mp2","decoder-mp3",
  "decoder-wmav1","decoder-wmav2","decoder-wmapro","decoder-wmalossless",
  "decoder-pcm_s8","decoder-pcm_u8","decoder-pcm_s16le","decoder-pcm_s16be","decoder-pcm_s24le","decoder-pcm_s24be",
  "decoder-pcm_s32le","decoder-pcm_s32be","decoder-pcm_f32le","decoder-pcm_f32be","decoder-pcm_f64le",
  "decoder-pcm_alaw","decoder-pcm_mulaw","decoder-pcm_bluray","decoder-pcm_dvd",
  "decoder-srt","decoder-subrip","decoder-movtext","decoder-ass","decoder-ssa","decoder-webvtt",
  "encoder-srt","encoder-subrip","encoder-ass","encoder-ssa","encoder-webvtt",
  "encoder-flac","encoder-aac","encoder-opus","encoder-pcm_s16le","encoder-pcm_f32le"
]'

JOBS="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
make -j"${JOBS}" build-uburoom RELEASE=1 TARGETS="wasm" INTERFACES="mjs"

VER="$(cat Makefile | sed -n 's/^LIBAVJS_VERSION *= *//p' | tr -d '[:space:]')"
FFVER="$(cat Makefile | sed -n 's/^FFMPEG_VERSION *= *//p' | tr -d '[:space:]')"
FULLVER="${VER}.${FFVER}"

cp "dist/libav-${FULLVER}-uburoom.mjs" "${OUT_DIR}/libav-uburoom.mjs"
cp "dist/libav-${FULLVER}-uburoom.wasm.mjs" "${OUT_DIR}/"
cp "dist/libav-${FULLVER}-uburoom.wasm.wasm" "${OUT_DIR}/"

{
  echo "Uburoom Custom libav.js WebAssembly Bundle (${FULLVER}-uburoom)"
  echo "Upstream repository: https://github.com/Yahweasel/libav.js (commit ${LIBAV_COMMIT})"
  echo "FFmpeg source: https://ffmpeg.org/releases/ffmpeg-${FFVER}.tar.xz (LGPL-2.1-or-later)"
  echo "zlib source: https://www.zlib.net/fossils/zlib-1.3.2.tar.gz (Zlib)"
  echo "emfiberthreads: https://github.com/Yahweasel/emfiberthreads/releases/tag/v1.3 (0BSD)"
  echo ""
  sed 's/^ \* \{0,1\}//; s/^\/\*//; s/\*\///' "configs/configs/uburoom/license.js"
} > "${OUT_DIR}/THIRD_PARTY_NOTICES.txt"

echo "Built libav-uburoom (${FULLVER}) into ${OUT_DIR}"
