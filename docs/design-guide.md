# uburoom design guide

Keep the established philosophy and palette. The shared source is `extension/remote-ui.js` (styles, SVGs, controls/badges); shells live in `extension/popup.css`, `web/style.css` and `web/watch*.css`. Inspect affected renders before UI changes and use shared safe-DOM components.

## Visual language

Use Inter/system-ui/-apple-system/Segoe UI/sans-serif with existing fallbacks. Text #e7e9ee; secondary #9ca4b1/#aab1bc; main #101217; keys #2c333e; hover #394351; web background #030406. Keep semantic blue #318fff for primary/Zoom, green #26ca96 for Width, yellow #f6bd35 for Height and #158761 for enabled remote.

Reuse 24×24 shared SVG paths, currentColor strokes, rounded ends/joins and approximately 1.9px width. Preserve rounded surfaces, subtle borders, spacing, focus and accessible names. Do not substitute emoji/icon libraries. Header graphic paths stay compatible until replacement artwork is supplied; do not invent a logo/palette.

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
