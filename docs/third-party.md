# Licensing and attribution

uburoom's original source is **GPL-3.0-only**, GNU General Public License version 3 only. The complete unmodified GNU text is in [LICENSE](../LICENSE); this project chooses version 3 only, regardless of the illustrative "or later" notice in the license appendix. Identifier: [SPDX GPL-3.0-only](https://spdx.org/licenses/GPL-3.0-only.html).

## Dependency inventory

The version 0.5.3 lockfile contains 63 dependency entries, including optional platform packages. Their declared licenses are MIT, Apache-2.0, Unlicense and 0BSD. These declarations are an inventory, not a substitute for the upstream notices or a completed provenance review.

| Direct dependency | Locked version | Declared license | Distribution/use |
| --- | --- | --- | --- |
| @discord/embedded-app-sdk | 2.5.0 | MIT | Bundled browser SDK |
| discord.js | 14.27.0 | Apache-2.0 | Installed server dependency |
| hls.js | 1.7.3 | Apache-2.0 | Installed dependency served to browsers |
| ws | 8.22.0 | MIT | Installed server/test dependency |
| esbuild | 0.28.2 | MIT | Development bundler |

The SDK's published modules also embed eventemitter3, zod, big-integer, uuid, decimal.js-light, lodash.transform and tslib below their own `output/lib` directory. These are identified from actual bundle inputs, even though the outer package path is the SDK. Published embedded versions are not consistently specified: notice headings distinguish the embedded copy from the locked package whose upstream license text is reproduced.

`web/vendor/THIRD_PARTY_NOTICES.txt` preserves SDK/library license texts, copyright/license comments present in embedded sources, and hls.js's upstream notice including Dailymotion/Brightcove attribution. The full Apache-2.0 text is retained in `web/vendor/licenses/Apache-2.0.txt`. Rebuilding fails if a discovered component has no upstream license file. Installed dependencies retain their own notices; do not remove them when redistributing dependencies.

Optional FFmpeg/FFprobe are supplied by the installation operator, not bundled here. Their build options and codec licensing need review if a future distribution includes binaries. Node, Firefox, Discord and Plex are external products, not relicensed by uburoom.

## Project branding

The supplied Slate vector assets are `assets/branding/uburoom-wordmark-brand.svg`, `uburoom-wordmark-white.svg`, `uburoom-oomark-brand.svg`, and `uburoom-oomark-white.svg`. Runtime raster icons and the favicon derive from the brand oomark. Earlier blue/green branding sources and exports are archived in `assets/branding/old/`; the diagnostic demo media still use that wordmark. No external fonts, images or icon libraries are used.

## Remaining asset review

- Confirm branding authorship and any separate asset terms as part of final release review; retain the supplied vector master and any applicable source notices.
- Seven synthetic media fixtures are now generated from procedural patterns, a sine tone and project branding, using `scripts/build-demo-media.js`. `assets/demo/README.md` documents their source and regeneration; no third-party footage/music/fonts are included. Review metadata/codec distribution requirements if the build or distribution changes.
- Preserve any upstream source notices for copied code or artwork found during review; do not label third-party material as newly GPL-licensed.

The project's GPL declaration does not clear these asset questions or authorize publication. Source/history/privacy, packaging and live/upgrade checks remain separate release gates.
