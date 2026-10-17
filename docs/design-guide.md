# uburoom design guide

Keep the established layout and behavior. The remote-only homepage is slated for retirement in M1-P8; the watch remote drawer remains part of the product. The shared remote source is `extension/remote-ui.js` (styles, SVGs, controls/badges); shells live in `extension/popup.css`, `web/style.css` and `web/watch*.css`. Inspect affected renders before UI changes and use shared safe-DOM components.

## Visual language

Use Inter/system-ui/-apple-system/Segoe UI/sans-serif with existing fallbacks. Slate tokens: background #101217, card #1B1E26, elevated #292E38, border #393F4D, text #F8F7F4, muted #AAB0BC, orange #FF9954, pink #FF7197. Orange is the main interaction accent; pink is a supporting brand accent. Keep semantic green #158761 for enabled remote and semantic red for destructive/error states. Keep playback surfaces black where viewing quality requires it.

Reuse 24×24 shared SVG paths, currentColor strokes, rounded ends/joins and approximately 1.9px width. Preserve rounded surfaces, subtle borders, spacing, focus and accessible names. Do not substitute emoji/icon libraries.

## Approved branding

The primary wordmark is `assets/branding/uburoom-wordmark-brand.svg` (944.16 × 293.5061): orange `ubu`, off-white `room`, pink underline. Runtime headers use this asset or its extension copy at its natural aspect ratio. `uburoom-wordmark-white.svg` is available for monochrome dark contexts.

The primary standalone oomark is `assets/branding/uburoom-oomark-brand.svg` (298.99 × 249.1061): off-white eyes and a pink mouth. `uburoom-oomark-white.svg` is its monochrome variant. The extension uses a square framed copy and PNG exports at 16, 32, 48, 64, 96, 128, 256 and 512 pixels; the favicon ICO includes 16/32/48 sizes.

Use the full-color wordmark for site headers and the oomark for favicons and toolbar icons. Do not stretch the wordmark into a square icon.

Raster/source exports in `assets/branding` include the 1848 px wide transparent wordmark PNG, 512 px transparent square icon, and 1024 px background square wordmark/oomark PNGs with matching SVGs. The prior blue/green assets currently reside in `assets/branding/old/`; M1 release cleanup will replace the old wordmark dependency in demo-media generation and remove that archive from the active tree (Git history retains it).

Use the canonical uburoom logo asset/HTTP path. Preserve the established typography and component layout rules above.

## Components

- Compact/normal remotes use one renderer. Enable is master, Playback/Picture are independent, Queue disabled, On join a remembered preference. Consent itself is never restored.
- Transport retains central double-height Play/Pause, ±15 seconds, icon-only actual-boundary Start/End, mute/volume. Slider drafts stay stable; web commands are throttled and unsent values dropped on disconnect/target change.
- Picture retains separate Zoom/Width/Height rows: minus above reset at left, editable value/label in the middle, larger plus at right, beside the pad. Resets are independent; Reset all is quiet gray. Keep hold/Ctrl, profiles and phone layouts.
- Applied-command badges use a 112px shared symbol, useful applied value and literal sender name; each command restarts the 2.5-second lifetime. Avoid verbose status.
- Watch retains reading order, hover/focus overlays, pause feedback and theater behavior. Personal quality/audio are separate from shared playback/picture. Video-surface click does not toggle play.
- Theater has a half-width drawer, full width on portrait phones. Activity is locked to theater; PIP is video-only. Preserve private confirmation/revocation and room chooser behavior.
- Library preserves poster/list views, explicit library/show/season/episode breadcrumbs, navigation/view selectors, paging and search/scroll restoration. Episodes use scene-only detail art; movie posters match grid sizing. Row details stay separate from enlarged Play controls. Artwork is authenticated.
- Account/privacy/handoff dialogs use existing dark inputs, quiet/primary buttons and shared symbols. Browser logout retains bottom placement/spacing and is hidden for Activity bearer identity.

Test affected normal/theater/phone surfaces using isolated fixtures. Actual player/Activity results stay separate. Private design transcripts and historical screenshots are not public documentation.
