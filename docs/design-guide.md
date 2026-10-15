# uburoom design guide

Keep the established philosophy and palette. The shared source is `extension/remote-ui.js` (styles, SVGs, controls/badges); shells live in `extension/popup.css`, `web/style.css` and `web/watch*.css`. Inspect affected renders before UI changes and use shared safe-DOM components.

## Visual language

Use Inter/system-ui/-apple-system/Segoe UI/sans-serif with existing fallbacks. Text #e7e9ee; secondary #9ca4b1/#aab1bc; main #101217; keys #2c333e; hover #394351; web background #030406. Keep semantic blue #318fff for primary/Zoom, green #26ca96 for Width, yellow #f6bd35 for Height and #158761 for enabled remote.

Reuse 24×24 shared SVG paths, currentColor strokes, rounded ends/joins and approximately 1.9px width. Preserve rounded surfaces, subtle borders, spacing, focus and accessible names. Do not substitute emoji/icon libraries.

## Approved branding

The selected wordmark is `assets/branding/uburoom-master.svg`. Preserve its paths, white lettering, blue #2D8DFE, green #1DC57A and symmetric gradient overlap shadows. Runtime headers use the tightly cropped transparent `extension/assets/uburoom-logo.svg`. The original square background is retained only in the editable master; do not stretch the wordmark to fill existing image boxes.

Icons contain only the original interlocking **oo** paths and clipped shadows. `assets/branding/uburoom-oo.svg` is tightly cropped; `extension/assets/uburoom-icon.svg` is a centered square with padding for toolbar/favicon use. Transparent PNG exports are provided at 16, 32, 48, 64, 96, 128, 256 and 512 pixels. The favicon ICO includes 16/32/48 sizes. Preserve the ligature geometry rather than redrawing it for individual sizes.

For square placements, `assets/branding/uburoom-oo-square.svg` and `uburoom-wordmark-square.svg` center the oo icon or full wordmark on the existing #101217 background. Each has a 1024×1024 PNG export beside it. `assets/branding/uburoom-icon.svg` and `uburoom-icon-512.png` provide the transparent square icon. Use the cropped wordmark for site headers and the oo icon for favicons; do not stretch the full wordmark into an icon.

Use the canonical uburoom logo asset/HTTP path. All palette, typography and component layout rules above remain unchanged.

## Components

- Compact/normal remotes use one renderer. Enable is master, Playback/Picture are independent, Queue disabled, On join a remembered preference. Consent itself is never restored.
- Transport retains central double-height Play/Pause, ±15 seconds, icon-only actual-boundary Start/End, mute/volume. Slider drafts stay stable; web commands are throttled and unsent values dropped on disconnect/target change.
- Picture retains separate Zoom/Width/Height rows: minus above reset at left, editable value/label in the middle, larger plus at right, beside the pad. Resets are independent; Reset all is quiet gray. Keep hold/Ctrl, profiles and phone layouts.
- Applied-command badges use a 112px shared symbol, useful applied value and literal sender name; each command restarts the 2.5-second lifetime. Avoid verbose status.
- Watch retains reading order, hover/focus overlays, pause feedback and theater behavior. Personal quality/audio are separate from shared playback/picture. Video-surface click does not toggle play.
- Theater has a half-width drawer, full width on portrait phones. Activity is locked to theater; PIP is video-only. Preserve private confirmation/revocation and session chooser behavior.
- Library preserves poster/list views, explicit library/show/season/episode breadcrumbs, navigation/view selectors, paging and search/scroll restoration. Episodes use scene-only detail art; movie posters match grid sizing. Row details stay separate from enlarged Play controls. Artwork is authenticated.
- Account/privacy/handoff dialogs use existing dark inputs, quiet/primary buttons and shared symbols. Browser logout retains bottom placement/spacing and is hidden for Activity bearer identity.

Test affected normal/theater/phone surfaces using isolated fixtures. Actual player/Activity results stay separate. Private design transcripts and historical screenshots are not public documentation.
