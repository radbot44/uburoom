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
| Liberation Sans Bold (`default.woff2`) | 2.5.21 bundle | OFL-1.1 | `web/vendor/subtitles/default.woff2`; full text in `web/vendor/licenses/OFL-1.1.txt` |
| ws | 8.22.0 | MIT | Server WebSocket runtime (`package-lock.json`) |
| yaml | 2.9.1 | ISC | Server configuration parser (`package-lock.json`) |
| esbuild | 0.28.2 | MIT | Development-only vendor bundler |

`@discord/embedded-app-sdk` also embeds `eventemitter3`, `zod`, `big-integer`, `uuid`, `decimal.js-light`, `lodash.transform` and `tslib`. [Player vendor notices](../web/vendor/THIRD_PARTY_NOTICES.txt) preserve embedded-source comments, `hls.js` Dailymotion/Brightcove attribution, `OverlayScrollbars` and `Tabler Icons`; [Apache-2.0](../web/vendor/licenses/Apache-2.0.txt) is retained in full.

FFmpeg and FFprobe are operator-supplied external system binaries, not bundled or distributed by uburoom. Docker configurations (`Dockerfile`, `docker-compose.yml`) are distributed as source build definitions.

## Subtitle bundles, WASM provenance and fallback font

`scripts/build-subtitle-vendor.js` bundles `jassub 2.5.21` and `libbitsub 1.13.0` from locked npm artifacts into `web/vendor/subtitles/` and generates [subtitle notices](../web/vendor/subtitles/THIRD_PARTY_NOTICES.txt):

- **JASSUB (`jassub.js`, `jassub-worker.js`, `jassub-worker.wasm`, `jassub-worker-modern.wasm`):** Built from locked npm artifact `https://registry.npmjs.org/jassub/-/jassub-2.5.21.tgz` (`sha512-ejG8oNWOV9iYLEAjPbYnZmjeCFwfuw67SWzJntWqQVPDqUtDVkt88ntSKNmqnRi9Yqbry0XmCb1YiTCiM9IQHQ==`), corresponding to upstream revision [`816f1dc536e9bface9bef82f7c214690b81aaee3`](https://github.com/ThaUnknown/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3) and mirrored for Corresponding Source availability at [`radbot44/jassub`](https://github.com/radbot44/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3). Statically linked WASM C/C++ library notices (`libass`, `FreeType`, `FriBidi`, `HarfBuzz`, `Brotli`, `Highway`) are retained in [`web/vendor/licenses/JASSUB-components.txt`](../web/vendor/licenses/JASSUB-components.txt). Transitive JS helpers by the same upstream author (`abslink 1.3.1` under Apache-2.0, `lfa-ponyfill 1.1.1` under MIT, `throughput 1.0.2` under MIT) have their `package.json` SPDX declarations and lockfile provenance recorded in `web/vendor/licenses/`.
- **libbitsub (`libbitsub-renderer.js`, `libbitsub.js`, `libbitsub_bg.wasm`):** Built from locked npm artifact `https://registry.npmjs.org/libbitsub/-/libbitsub-1.13.0.tgz` (`sha512-b1UWpSObYeyBiYF6JuUDXmmtE1/yCecLbu+DlnNYajcBCquL044oG42iqGmaAdjFPYrwo9CscffUGB3BG/Fo3Q==`) under the MIT License (Copyright © 2026 Jaruwit Jaiya; Copyright © 2024 David Schulte and Libpgs contributors; [`https://github.com/altqx/libbitsub`](https://github.com/altqx/libbitsub)).
- **Fallback font (`web/vendor/subtitles/default.woff2`):** Unmodified **Liberation Sans Bold** distributed by JASSUB as the default `liberation sans` fallback font under the **SIL Open Font License 1.1** (Copyright © 2010 Google Corporation, Red Hat, Inc., and Ascender Corp.). Full license text is retained in [`web/vendor/licenses/OFL-1.1.txt`](../web/vendor/licenses/OFL-1.1.txt) and `web/vendor/subtitles/THIRD_PARTY_NOTICES.txt`.
- **uburoom integration modifications:** `scripts/build-subtitle-vendor.js` bounds JASSUB worker disposal to 1 second, selects JASSUB transparent Canvas2D composition, and adapts `libbitsub` asset URLs, layout-box measurement, initialization readiness (`whenReady()`) and forced manual repaints. All modifications are produced reproducibly from `scripts/build-subtitle-vendor.js`.

## Artwork, branding, typography and synthetic media

| Asset | Source and license terms |
| --- | --- |
| **Uburoom Sans font** (`web/assets/fonts/UburoomSans-Regular.woff2`) | Original first-party typeface (Copyright © 2026 radbot44, with Reserved Font Name "Uburoom Sans" and "Uburoom"), licensed under **SIL Open Font License 1.1 (OFL-1.1)**; full text in [`web/assets/fonts/OFL.txt`](../web/assets/fonts/OFL.txt). |
| **uburoom wordmarks, custom letterforms and `oomark` icons** (`assets/branding/*`, `oomark` in `web/icons.js`) | Original first-party vector and raster artwork (Copyright © 2026 radbot44), dual-licensed under **GPL-3.0-only OR CC-BY-4.0**. Vector sources are retained in `assets/branding/*.svg`. |
| **Tabler outline icons** (`web/icons.js`) | Selected outline SVGs from [Tabler Icons](https://github.com/tabler/tabler-icons) (MIT, Copyright © 2020–2026 Paweł Kuna); notice retained in `web/vendor/THIRD_PARTY_NOTICES.txt`. |
| **Discord symbol** (`web/icons.js`) | Unmodified [official asset](https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg), retrieved 2026-10-18; used strictly for Discord sign-in/Activity identification under [Discord brand guidelines](https://discord.com/branding). Excluded from GPL/CC licenses. |
| **Plex icon** (`web/icons.js`) | Unmodified 600×600 favicon from [official portal](https://brand.plex.tv/) (`frontify/accounts/9a/58813/favicons/ce/58857/be5042f43a60cad2dc92024389bd5720-1571820507.png`), retrieved 2026-10-18; used strictly for Plex sign-in/integration identification under [Plex trademark guidelines](https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/). Excluded from GPL/CC licenses. |
| **Synthetic demo media** (`assets/demo/*`) | First-party procedural FFmpeg `testsrc2` patterns, 440 Hz sine audio and the first-party `uburoom-wordmark-brand.png` overlay generated by `scripts/build-demo-media.js` ([details](../assets/demo/README.md)). Contains no third-party footage, music or fonts. |

### Brand and trademark policy (GPL-3.0 §7(e))

All original `uburoom` wordmarks, custom letterforms and `oomark` icons in `assets/branding/` and `web/icons.js` are dual-licensed under **GPL-3.0-only** and **Creative Commons Attribution 4.0 International (CC-BY-4.0)**, and `Uburoom Sans` (`web/assets/fonts/UburoomSans-Regular.woff2`) is licensed under **SIL Open Font License 1.1 (OFL-1.1)**, so community members and users may freely use, remix and share the artwork and font for any creative, personal or self-hosted purpose.

Per **GPL-3.0 Section 7(e)** (and the OFL-1.1 Reserved Font Name provision), these copyright licenses do not grant trademark permissions to misrepresent origin: modified forks, commercial redistributions or third-party hosted services may not use the **uburoom** name or logos in a manner that implies official endorsement or confuses users into believing a modified or third-party service is the official `uburoom` project.
