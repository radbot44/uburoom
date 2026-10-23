# Licensing and attribution

First-party source is **GPL-3.0-only**; preserve [LICENSE](../LICENSE). Third-party components retain their own licenses. This inventory does not close publication/provenance gates.

## Dependency inventory

Recorded lockfile versions; review against the selected release and actual bundle inputs.

| Dependency | Version | Declared license |
| --- | --- | --- |
| @discord/embedded-app-sdk | 2.5.0 | MIT |
| discord.js | 14.27.0 | Apache-2.0 |
| hls.js | 1.7.3 | Apache-2.0 |
| jassub | 2.5.21 | LGPL-2.1-or-later AND (FTL OR GPL-2.0-or-later) AND MIT AND MIT-Modern-Variant AND ISC AND NTP AND Zlib AND BSL-1.0 |
| libbitsub | 1.13.0 | MIT |
| ws | 8.22.0 | MIT |
| yaml | 2.9.1 | ISC |
| esbuild (development) | 0.28.2 | MIT |

The SDK also embeds eventemitter3, zod, big-integer, uuid, decimal.js-light, lodash.transform and tslib. Embedded versions are not always specified; preserve their actual source notices separately from similarly named installed packages.

[Vendor notices](../web/vendor/THIRD_PARTY_NOTICES.txt) include embedded-source comments and hls.js Dailymotion/Brightcove attribution; [Apache-2.0](../web/vendor/licenses/Apache-2.0.txt) is retained in full. The build rejects unrecognized missing licenses. Preserve installed dependency notices when distributing them.

FFmpeg/FFprobe are operator-supplied, not bundled; review their build/codec obligations before distributing binaries. External products are not relicensed by uburoom.

## Subtitle bundles and outstanding notices

Integration patches adapt libbitsub asset URLs/transforms/initialization/manual repaint and bound JASSUB worker disposal. JASSUB uses transparent Canvas2D composition. Rebuild from locked npm artifacts; upstream licenses remain unchanged.

Reference JASSUB source: [816f1dc536e9bface9bef82f7c214690b81aaee3](https://github.com/ThaUnknown/jassub/tree/816f1dc536e9bface9bef82f7c214690b81aaee3). [Component texts](../web/vendor/licenses/JASSUB-components.txt) cover libass, FriBidi, FreeType, HarfBuzz and Brotli, but are not complete binary provenance.

**Before publication:** establish exact WASM native-source/build revisions, full copyright notices, corresponding source/build materials and fallback-font provenance/license.

Inspected abslink 1.3.1, lfa-ponyfill 1.1.1 and throughput 1.0.2 lacked dedicated license files. Recorded Apache/MIT declarations, available author metadata and standard texts do not invent copyright notices; upstream clarification remains open. These exceptions do not authorize release.

## Artwork and media

| Asset | Source / terms |
| --- | --- |
| Tabler outline icons in web/icons.js | [Tabler](https://github.com/tabler/tabler-icons), MIT, copyright 2020–2026 Paweł Kuna; notice retained locally |
| Custom oomark | uburoom branding, not Tabler; confirm project artwork authorship/terms and retain vector source |
| Discord symbol | Unmodified [official asset](https://cdn.prod.website-files.com/6257adef93867e50d84d30e2/66e3d7f4ef6498ac018f2c55_Symbol.svg), retrieved 2026-10-18; [brand guidelines](https://discord.com/branding), not GPL artwork |
| Plex icon | Unmodified 600×600 favicon from [official portal](https://brand.plex.tv/), retrieved 2026-10-18; [trademark terms](https://www.plex.tv/about/privacy-legal/plex-trademarks-and-guidelines/), not GPL artwork |
| Synthetic media | Procedural patterns, sine tone and branding; [source/regeneration](../assets/demo/README.md); no third-party footage/music/fonts recorded |

Plex source identifier: `frontify/accounts/9a/58813/favicons/ce/58857/be5042f43a60cad2dc92024389bd5720-1571820507.png`.

Resolve branding/font terms, preserve copied-source notices and review fixture codec/metadata distribution if changed. GPL declaration alone clears none of these questions. Privacy/history/ZIP and operator verification remain separate [release gates](../ROADMAP.md#m1--verified-self-hosted-release).
