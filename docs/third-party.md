# Licensing and attribution

First-party source code is **GPL-3.0-only** (Copyright © 2026 radbot44); preserve [LICENSE](../LICENSE). Third-party components retain their own licenses and notices.

## Dependency and vendor inventory

| Component | Version | License | Scope / location |
| --- | --- | --- | --- |
| @discord/embedded-app-sdk | 2.5.0 | MIT | Bundled in `web/vendor/discord-sdk.js` |
| discord.js | 14.27.0 | Apache-2.0 | Server runtime (`package-lock.json`) |
| hls.js | 1.7.3 | Apache-2.0 | Browser HLS playback; notice in `web/vendor/THIRD_PARTY_NOTICES.txt` |
| OverlayScrollbars | 2.17.0 | MIT | `web/vendor/overlayscrollbars/`; notice in `web/vendor/THIRD_PARTY_NOTICES.txt` |
| jassub | 2.5.21 | LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 | `web/vendor/subtitles/jassub*` |
| libbitsub | 1.13.0 | MIT | `web/vendor/subtitles/libbitsub*` |
| libav.js (`uburoom` variant, FFmpeg 9.0.2 + zlib 1.3.2 + emfiberthreads 1.3) | 6.11.9.0.2 | LGPL-2.1-or-later AND 0BSD AND Zlib | `web/vendor/libav/libav*`; notice in `web/vendor/libav/THIRD_PARTY_NOTICES.txt` |
| Liberation Sans Bold (`default.woff2`) | 2.5.21 bundle | OFL-1.1 | `web/vendor/subtitles/default.woff2`; full text in `web/vendor/licenses/OFL-1.1.txt` |
| ws | 8.22.0 | MIT | Server WebSocket runtime (`package-lock.json`) |
| yaml | 2.9.1 | ISC | Server configuration parser (`package-lock.json`) |
| esbuild | 0.28.2 | MIT | Development-only vendor bundler |

`@discord/embedded-app-sdk` also embeds `eventemitter3`, `zod`, `big-integer`, `uuid`, `decimal.js-light`, `lodash.transform` and `tslib`. [Player vendor notices](../web/vendor/THIRD_PARTY_NOTICES.txt) preserve embedded-source comments, `hls.js` Dailymotion/Brightcove attribution, `OverlayScrollbars` and `Tabler Icons`; [Apache-2.0](../web/vendor/licenses/Apache-2.0.txt) is retained in full.

In source-only checkouts, FFmpeg and FFprobe are operator-supplied external system binaries, not bundled or distributed by uburoom. Docker configurations (`Dockerfile`, `docker-compose.yml`) are distributed as source build definitions.

## Windows x64 standalone bundle provenance and Corresponding Source

For local Windows x64 standalone builds produced by `scripts/package-standalone.js` (not publicly published without owner approval), `scripts/standalone-dependencies.json` pins exact, SHA-256-verified upstream runtimes coupled inside `versions/<slot>/runtime/`:

- **Node.js `v22.23.5` (win-x64):** Official MIT-licensed Node.js 22 LTS binary (`node-v22.23.5-win-x64.zip`, SHA-256 `4a191082e9706866830379d577d2cc8a50c776fcd9436a8d061b063ed0d9a0e3`), bundled with its `LICENSE`.
- **FFmpeg `n8.1.3-41-ga8029b6528` (`win64-gpl-8.1`):** Static GPLv3 build (`--enable-gpl --enable-version3`, no `--enable-nonfree`) from `FFmpeg-Builds/FFmpeg-Builds` release `autobuild-2026-11-25-12-41` (`ffmpeg-n8.1.3-41-ga8029b6528-win64-gpl-8.1.zip`, SHA-256 `a1ef44f882e103d297156be744bf138eb5de1054e864218d43a65d1801570917`), verified by `scripts/verify-ffmpeg.js` and bundled with `LICENSE.txt` and `THIRD_PARTY_NOTICES.txt`.

Because upstream `FFmpeg-Builds` `autobuild-*` releases are pruned on a rolling schedule, `scripts/package-standalone.js` caches verified binary archives in `releases/vendor-archive/binaries/` and archives complete GPL-3.0 Corresponding Source (`FFmpeg` commit `a8029b6528`, `FFmpeg-Builds` tag `autobuild-2026-11-25-12-41` build recipes/patches and statically linked library source snapshots, `Node.js v22.23.5` source tarball provenance, and tracked `uburoom` source) locally in `releases/vendor-archive/sources/` and `releases/uburoom-corresponding-source-*.zip`.

## Subtitle bundles, WASM provenance and fallback font

`scripts/build-subtitle-vendor.js` bundles `jassub 2.5.21` and `libbitsub 1.13.0` from locked npm artifacts into `web/vendor/subtitles/` and generates [subtitle notices](../web/vendor/subtitles/THIRD_PARTY_NOTICES.txt):

- **JASSUB (`jassub.js`, `jassub-worker.js`, `jassub-worker.wasm`, `jassub-worker-modern.wasm`):** Built from locked npm artifact `https://registry.npmjs.org/jassub/-/jassub-2.5.21.tgz` (`sha512-ejG8oNWOV9iYLEAjPbYnZmjeCFwfuw67SWzJntWqQVPDqUtDVkt88ntSKNmqnRi9Yqbry0XmCb1YiTCiM9IQHQ==`), corresponding to upstream revision [`816f1dc536e9bface9bef82f7c214690b81aaee3`](https://github.com/ThaUnknown/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3) and mirrored for Corresponding Source availability at [`radbot44/jassub`](https://github.com/radbot44/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3). Statically linked WASM C/C++ library notices (`libass`, `FreeType`, `FriBidi`, `HarfBuzz`, `Brotli`, `Highway`) are retained in [`web/vendor/licenses/JASSUB-components.txt`](../web/vendor/licenses/JASSUB-components.txt). Transitive JS helpers by the same upstream author (`abslink 1.3.1` under Apache-2.0, `lfa-ponyfill 1.1.1` under MIT, `throughput 1.0.2` under MIT) have their `package.json` SPDX declarations and lockfile provenance recorded in `web/vendor/licenses/`.
- **libbitsub (`libbitsub-renderer.js`, `libbitsub.js`, `libbitsub_bg.wasm`):** Built from locked npm artifact `https://registry.npmjs.org/libbitsub/-/libbitsub-1.13.0.tgz` (`sha512-b1UWpSObYeyBiYF6JuUDXmmtE1/yCecLbu+DlnNYajcBCquL044oG42iqGmaAdjFPYrwo9CscffUGB3BG/Fo3Q==`) under the MIT License (Copyright © 2026 Jaruwit Jaiya; Copyright © 2024 David Schulte and Libpgs contributors; [`https://github.com/altqx/libbitsub`](https://github.com/altqx/libbitsub)).
- **Fallback font (`web/vendor/subtitles/default.woff2`):** Unmodified **Liberation Sans Bold** distributed by JASSUB as the default `liberation sans` fallback font under the **SIL Open Font License 1.1** (Copyright © 2010 Google Corporation, Red Hat, Inc., and Ascender Corp.). Full license text is retained in [`web/vendor/licenses/OFL-1.1.txt`](../web/vendor/licenses/OFL-1.1.txt) and `web/vendor/subtitles/THIRD_PARTY_NOTICES.txt`.
- **uburoom integration modifications:** `scripts/build-subtitle-vendor.js` bounds JASSUB worker disposal to 1 second, selects JASSUB transparent Canvas2D composition, and adapts `libbitsub` asset URLs, layout-box measurement, initialization readiness (`whenReady()`) and forced manual repaints. PGS pending-render cleanup also removes the exact completed promise before rejecting an obsolete generation, preventing repeated stale repaint callbacks during window reset/replay. All modifications are produced reproducibly from `scripts/build-subtitle-vendor.js`.

## Browser container demuxer and audio decoder (`web/vendor/libav/`)

`scripts/build-libav-vendor.sh` compiles the custom single-threaded `uburoom` WebAssembly variant of [`Yahweasel/libav.js`](https://github.com/Yahweasel/libav.js) (commit `2baa971a01bdea4545c1c7e4d42855a33d5b8cc2`, 0BSD wrapper) against [FFmpeg 9.0.2](https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz) (**LGPL-2.1-or-later**, without `--enable-gpl` or `--enable-nonfree`), [zlib 1.3.2](https://www.zlib.net/fossils/zlib-1.3.2.tar.gz) (**Zlib**), and [`emfiberthreads` 1.3](https://github.com/Yahweasel/emfiberthreads/releases/tag/v1.3) (**0BSD**) into `web/vendor/libav/`:

- `libav-uburoom.mjs` (SHA-256 `ae717959bb375ffbde6910d78f7cb88142154ddcc7eb38820894c5b0d0c2002f`)
- `libav-6.11.9.0.2-uburoom.wasm.mjs` (SHA-256 `27e7a05cf6b00962e6d0d34b38d2a97aceba3e71f4734b68b4f60a90aeb04d6c`)
- `libav-6.11.9.0.2-uburoom.wasm.wasm` (SHA-256 `d4d9a7b65af23d0325a9fc59291376c8c97693d9540e2f3aef084810bab8436d`)

Full copyright and license texts are retained in [`web/vendor/libav/THIRD_PARTY_NOTICES.txt`](../web/vendor/libav/THIRD_PARTY_NOTICES.txt), and the exact FFmpeg configure flags and Emscripten build commands are preserved in [`scripts/build-libav-vendor.sh`](../scripts/build-libav-vendor.sh).

## Artwork, branding, typography and synthetic media

| Asset | Source and license terms |
| --- | --- |
| **Inter font** (`web/assets/fonts/InterVariable.woff2`, `InterVariable-Italic.woff2`) | Unmodified variable WOFF2 files from the official **Inter 4.1** release (<https://github.com/rsms/inter/releases/tag/v4.1>, asset `Inter-4.1.zip`, SHA-256 `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`; files taken from its `web/` folder). Copyright © 2016 The Inter Project Authors, licensed under **SIL Open Font License 1.1 (OFL-1.1)**; licence text in [`web/assets/fonts/Inter-OFL.txt`](../web/assets/fonts/Inter-OFL.txt) (the release `LICENSE.txt`, SHA-256 `262481e844521b326f5ecd053e59b98c8b2da78c8ee1bdbb6e8174305e54935a`). File SHA-256: `InterVariable.woff2` `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` (352,240 bytes); `InterVariable-Italic.woff2` `e564f652916db6c139570fefb9524a77c4d48f30c92928de9db19b6b5c7a262a` (387,976 bytes). Served by the app itself; no CDN. |
| **Uburoom Sans font** (`web/assets/fonts/UburoomSans-Variable.woff2`) | Original first-party typeface (Copyright © 2026 radbot44, with Reserved Font Name "Uburoom Sans" and "Uburoom"), licensed under **SIL Open Font License 1.1 (OFL-1.1)**; full text in [`web/assets/fonts/OFL.txt`](../web/assets/fonts/OFL.txt). |
| **uburoom wordmarks, custom letterforms and `oomark` icons** (`assets/branding/*`, `oomark` in `shared/icons-data.mjs`) | Original first-party vector and raster artwork (Copyright © 2026 radbot44), dual-licensed under **GPL-3.0-only OR CC-BY-4.0**. Vector sources are retained in `assets/branding/*.svg`. |
| **Tabler outline icons** (`shared/icons-data.mjs`) | Selected outline SVGs from [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT, Copyright © 2020–2026 Paweł Kuna); notice retained in `web/vendor/THIRD_PARTY_NOTICES.txt`. |
| **Discord symbol** (`shared/icons-data.mjs`) | Unmodified [official asset](https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg), retrieved 2026-10-18; used strictly for Discord sign-in/Activity identification under [Discord brand guidelines](https://discord.com/branding). Excluded from GPL/CC licenses. |
| **Plex icon** (`web/assets/plex-icon.png`) | Unmodified 600×600 favicon from [official portal](https://brand.plex.tv/) (`frontify/accounts/9a/58813/favicons/ce/58857/be5042f43a60cad2dc92024389bd5720-1571820507.png`), retrieved 2026-10-18; used strictly for Plex sign-in/integration identification under [Plex trademark guidelines](https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/). Excluded from GPL/CC licenses. |
| **Jellyfin icon** (`web/assets/jellyfin-icon.svg`) | Unmodified `branding/SVG/icon-transparent.svg` from [jellyfin/jellyfin-ux](https://github.com/jellyfin/jellyfin-ux) at commit `9e27258e873f64edaa9c5955e753978975ed5589`, retrieved 2026-11-16, licence block retained; Copyright the Jellyfin contributors, licensed [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/). Used to identify Jellyfin libraries. Excluded from GPL/CC-BY licenses of first-party work. |
| **Synthetic demo media** (`assets/demo/*`) | First-party procedural FFmpeg `testsrc2` patterns, 440 Hz sine audio and the first-party `uburoom-wordmark-brand.png` overlay generated by `scripts/build-demo-media.js` ([details](../assets/demo/README.md)). Contains no third-party footage, music or fonts. |

### Brand and trademark policy (GPL-3.0 §7(e))

All original `uburoom` wordmarks, custom letterforms and `oomark` icons in `assets/branding/` and `shared/icons-data.mjs` are dual-licensed under **GPL-3.0-only** and **Creative Commons Attribution 4.0 International (CC-BY-4.0)**, and `Uburoom Sans` (`web/assets/fonts/UburoomSans-Variable.woff2`) is licensed under **SIL Open Font License 1.1 (OFL-1.1)**, so community members and users may freely use, remix and share the artwork and font for any creative, personal or self-hosted purpose.

Per **GPL-3.0 Section 7(e)** (and the OFL-1.1 Reserved Font Name provision), these copyright licenses do not grant trademark permissions to misrepresent origin: modified forks, commercial redistributions or third-party hosted services may not use the **uburoom** name or logos in a manner that implies official endorsement or confuses users into believing a modified or third-party service is the official `uburoom` project.
