# Licensing and attribution

uburoom's original source is **GPL-3.0-only**, GNU General Public License version 3 only. The complete unmodified GNU text is in [LICENSE](../LICENSE); this project chooses version 3 only, regardless of the illustrative "or later" notice in the license appendix. Identifier: [SPDX GPL-3.0-only](https://spdx.org/licenses/GPL-3.0-only.html).

## Dependency inventory

The version 0.5.3 lockfile contains 70 dependency entries, including optional platform packages. In addition to MIT, Apache-2.0, Unlicense and 0BSD declarations, JASSUB declares the native/font component terms listed below. These declarations are an inventory, not a substitute for the upstream notices or a completed provenance review.

| Direct dependency | Locked version | Declared license | Distribution/use |
| --- | --- | --- | --- |
| @discord/embedded-app-sdk | 2.5.0 | MIT | Bundled browser SDK |
| discord.js | 14.27.0 | Apache-2.0 | Installed server dependency |
| hls.js | 1.7.3 | Apache-2.0 | Installed dependency served to browsers |
| jassub | 2.5.21 | LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 | Browser ASS/SSA renderer, worker and WASM |
| libbitsub | 1.13.0 | MIT | Browser PGS/VobSub renderer and WASM |
| ws | 8.22.0 | MIT | Installed server/test dependency |
| esbuild | 0.28.2 | MIT | Development bundler |

The SDK's published modules also embed eventemitter3, zod, big-integer, uuid, decimal.js-light, lodash.transform and tslib below their own `output/lib` directory. These are identified from actual bundle inputs, even though the outer package path is the SDK. Published embedded versions are not consistently specified: notice headings distinguish the embedded copy from the locked package whose upstream license text is reproduced.

`web/vendor/THIRD_PARTY_NOTICES.txt` preserves SDK/library license texts, copyright/license comments present in embedded sources, and hls.js's upstream notice including Dailymotion/Brightcove attribution. The full Apache-2.0 text is retained in `web/vendor/licenses/Apache-2.0.txt`. Rebuilding fails if a discovered component has no upstream license file. Installed dependencies retain their own notices; do not remove them when redistributing dependencies.

Optional FFmpeg/FFprobe are supplied by the installation operator, not bundled here. Their build options and codec licensing need review if a future distribution includes binaries. Node, Firefox, Discord and Plex are external products, not relicensed by uburoom.

### Subtitle bundles and outstanding notices

`scripts/build-subtitle-vendor.js` builds the pinned subtitle packages into `web/vendor/subtitles/` and inventories their actual JavaScript bundle inputs. `THIRD_PARTY_NOTICES.txt` in that directory retains the available package notices and declared license metadata. Workers, WASM and the package's fallback font are served locally; automatic local/remote font discovery is disabled. Movie font attachments are private viewer-authorized resources, not bundled application assets.

The build applies documented integration changes: libbitsub asset URLs/layout measurements fit the host picture transform; its initialization completion and forced manual repaint are exposed for paused startup/delay updates; and JASSUB worker disposal is bounded if initialization or IPC hangs. JASSUB uses its transparent Canvas2D compositor with synchronized presentation instead of a second GPU surface over decoded video. This preserves libass layout/fonts but may cost more CPU for complex animated subtitles. Upstream licenses remain unchanged. Generated files are rebuilt from the locked npm artifacts; no personal checkout paths or runtime data are inputs.

The JASSUB source/build reference is [revision 816f1dc](https://github.com/ThaUnknown/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3). Its native dependencies include libass, FriBidi, FreeType, HarfBuzz and Brotli. `web/vendor/licenses/JASSUB-components.txt` preserves that revision's standard component license texts; it is not a complete binary provenance or copyright inventory. Before publication, verify the npm WASM's exact matching native source/build revisions, collect complete component copyright notices and corresponding source/build materials, and resolve the bundled fallback font's provenance and applicable license.

The published abslink 1.3.1, lfa-ponyfill 1.1.1 and throughput 1.0.2 packages and their inspected repositories omit dedicated license files. Their Apache-2.0/MIT declarations, public author metadata where present, and standard license texts are recorded explicitly without inventing copyright notices. Upstream attribution clarification remains a publication gate. New unrecognized missing notices still fail the build; these recorded exceptions do not authorize release.

## Project branding

The supplied Slate vector assets are `assets/branding/uburoom-wordmark-brand.svg`, `uburoom-wordmark-white.svg`, `uburoom-oomark-brand.svg`, and `uburoom-oomark-white.svg`. Web runtime branding and favicon are owned under `web/assets/`; the favicon derives from the brand oomark. The independent remote repository owns its extension icons and branding copies. Earlier blue/green branding sources and exports are archived in `assets/branding/old/`; the diagnostic demo media still use that wordmark. UI typography remains system-based; the subtitle renderer's bundled fallback font is separately reviewed above. No external image or icon libraries are used.

## Provider account icons

`web/assets/discord-symbol-white.svg` is the unmodified white Discord symbol from [Discord's official brand assets](https://discord.com/branding), retrieved 2026-10-18 ([original SVG](https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg)). It appears with the Discord name on the sign-in button and linked-account row, using Discord's #5865F2 blurple background. Discord's logo and other marks belong to Discord Inc. and remain subject to its brand guidelines; they are not first-party GPL artwork.

`web/assets/plex-icon.png` is the Plex application icon served as the favicon by [Plex's official brand portal](https://brand.plex.tv/), retrieved 2026-10-18 without editing the artwork. The portal's Frontify-hosted source is `frontify/accounts/9a/58813/favicons/ce/58857/be5042f43a60cad2dc92024389bd5720-1571820507.png` (600 × 600). It identifies Plex account/sign-in controls. Plex and the Plex Play logo are trademarks of Plex, Inc.; see [Plex's trademark guidelines](https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/). This third-party artwork is not relicensed as first-party GPL source.

## Remaining asset review

- Confirm branding authorship and any separate asset terms as part of final release review; retain the supplied vector master and any applicable source notices.
- Seven synthetic media fixtures are now generated from procedural patterns, a sine tone and project branding, using `scripts/build-demo-media.js`. `assets/demo/README.md` documents their source and regeneration; no third-party footage/music/fonts are included. Review metadata/codec distribution requirements if the build or distribution changes.
- Preserve any upstream source notices for copied code or artwork found during review; do not label third-party material as newly GPL-licensed.

The project's GPL declaration does not clear these asset questions or authorize publication. Source/history/privacy, packaging and live/upgrade checks remain separate release gates.
