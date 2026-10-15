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

The SDK build's input metadata identifies only @discord/embedded-app-sdk as a bundled npm package. `web/vendor/THIRD_PARTY_NOTICES.txt` preserves its MIT notice and hls.js's upstream notice, including attribution to Dailymotion and derived Brightcove code. The complete Apache-2.0 text is also retained in `web/vendor/licenses/Apache-2.0.txt`. Installed npm dependencies retain their upstream license files; do not remove them when redistributing dependencies.

Optional FFmpeg/FFprobe are supplied by the installation operator, not bundled here. Their build options and codec licensing need review if a future distribution includes binaries. Node, Firefox, Discord and Plex are external products, not relicensed by uburoom.

## Project branding

The approved vector authoring source is `assets/branding/uburoom-master.svg`, supplied for this project. Cropped wordmark and oo exports preserve its paths, colors, clipping and gradient shadows; only the background/canvas and the icon's surrounding letters are removed. Raster exports derive from those vectors. No external fonts, images or icon libraries are used. The retired wordmark is not included in the current source distributions.

## Remaining asset review

- Confirm branding authorship and any separate asset terms as part of final release review; retain the supplied vector master and any applicable source notices.
- Seven synthetic media fixtures: preserve or document source/generation recipes and audio/video provenance before public release. The fixture files' codec formats alone do not establish their copyright terms.
- Preserve any upstream source notices for copied code or artwork found during review; do not label third-party material as newly GPL-licensed.

The project's GPL declaration does not clear these asset questions or authorize publication. Source/history/privacy, packaging and live/upgrade checks remain separate release gates.
