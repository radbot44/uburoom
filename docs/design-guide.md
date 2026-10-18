# uburoom design guide

Keep the established layout and behavior. The main site enters `/watch`; the standalone remote-only homepage is retired. The web-owned remote renderer is `web/remote-ui.js` (styles, SVGs, controls/badges), with the watch shell in `web/watch*.css`. uburoom-remote owns its own renderer and popup; do not import another checkout's UI files. Inspect affected renders before UI changes and use safe-DOM components.

## Visual language

Use Inter/system-ui/-apple-system/Segoe UI/sans-serif with existing fallbacks. Slate tokens: background #101217, card #1B1E26, elevated #292E38, border #393F4D, text #F8F7F4, muted #AAB0BC, orange #FF9954, pink #FF7197. Orange is the main interaction accent; pink is a supporting brand accent. Keep semantic green #158761 for enabled remote and semantic red for destructive/error states. Keep playback surfaces black where viewing quality requires it.

Reuse 24×24 shared SVG paths, currentColor strokes, rounded ends/joins and approximately 1.9px width. Preserve rounded surfaces, subtle borders, spacing, focus and accessible names. Do not substitute emoji/icon libraries.

## Approved branding

The primary wordmark is `assets/branding/uburoom-wordmark-brand.svg` (944.16 × 293.5061): orange `ubu`, off-white `room`, pink underline. Runtime headers use its web-owned copy under `web/assets/` at its natural aspect ratio. `uburoom-wordmark-white.svg` is available for monochrome dark contexts.

The primary standalone oomark is `assets/branding/uburoom-oomark-brand.svg` (298.99 × 249.1061): off-white eyes and a pink mouth. `uburoom-oomark-white.svg` is its monochrome variant. The extension uses a square framed copy and PNG exports at 16, 32, 48, 64, 96, 128, 256 and 512 pixels; the favicon ICO includes 16/32/48 sizes.

Use the full-color wordmark for site headers and the oomark for favicons and toolbar icons. Do not stretch the wordmark into a square icon.

Raster/source exports in `assets/branding` include the 1848 px wide transparent wordmark PNG, 512 px transparent square icon, and 1024 px background square wordmark/oomark PNGs with matching SVGs. The prior blue/green assets currently reside in `assets/branding/old/`; M1 release cleanup will replace the old wordmark dependency in demo-media generation and remove that archive from the active tree (Git history retains it).

Use the canonical uburoom logo asset/HTTP path. Preserve the established typography and component layout rules above.

## Components

- Compact/normal remotes use one renderer. Enable is master, Playback/Picture are independent, Queue disabled, On join a remembered preference. Consent itself is never restored.
- Transport retains central double-height Play/Pause, ±15 seconds, icon-only actual-boundary Start/End, mute/volume. Slider drafts stay stable; web commands are throttled and unsent values dropped on disconnect/target change.
- Picture retains separate Zoom/Width/Height rows: minus above reset at left, editable value/label in the middle, larger plus at right, beside the pad. Resets are independent; Reset all is quiet gray. Keep hold/Ctrl, profiles and phone layouts.
- Applied-command badges use a 112px shared symbol, useful applied value and literal sender name; each command restarts the 2.5-second lifetime. Avoid verbose status.
- Watch places the library beside the video on wide screens, with the room bar below the video and above Room options. Narrow screens stack the library below. Personal quality/audio are separate from shared playback/picture. The centered Play/Pause button appears on hover or keyboard focus; a plain video-surface click does not toggle play.
- Normal content expands proportionally from a 1,750px cap at 1080p to 2,100px at 4K, with four posters per row in the desktop library grid. Theater centers the landscape player above a room bar on the normal page background; cap player height so portrait screens cannot make it taller than wide. At the page top, dim all content below the video, revealing it on hover/focus below the player or page scroll. Put Room options and Library in approximately 25%/75% columns, stacking on narrow screens. Keep the logo/header on the normal background.
- Mobile has no theater option and uses an edge-to-edge player with square corners. Desktop corners are subtly rounded; theater and fullscreen are square. The mobile transport has two rows: timestamps/progress, then Play, Beginning, End, CC, Settings, mute/visible volume slider and Fullscreen. Keep mute adjacent to its slider. Side double-taps seek 15 seconds; each extra tap adds 15 seconds in that direction. Touch controls hide after inactivity, including after slider use, while blocked playback and active menus remain reachable.
- Player settings use a desktop drop-up ordered Quality, Audio track, Subtitle track, More settings, with choice menus opening left. Mobile opens the full dialog, including in fullscreen. The dialog groups playback/Sync correction, tracks and subtitle rendering/delay. CC is an outlined rounded rectangle when off and solid with cutout letters when on; it restores the previous/default available track and fades when no track is available. Quality badges on the cog show ORIG or HD for Original/1080p, with no badge below that. Native captions clear the actual control height and return down when touch controls hide; explicit cue positioning stays intact.
- Browser fullscreen uses actual fullscreen and provides a half-width drawer, full width on portrait phones. Exiting restores the prior normal/theater layout. Activity uses this viewport-filling layout with theater unavailable; PIP is video-only. Preserve private confirmation/revocation and room chooser behavior.
- Library scrolls independently of the player/options column, with its heading and toolbar pinned inside the panel. Use the same card background for the library toolbar and elevated backgrounds for button groups. Omit the Library/Collections selector; collections remain reachable from Libraries home. Preserve poster/list views, explicit library/show/season/episode breadcrumbs, navigation/view selectors, paging and search/scroll restoration. Episodes use scene-only detail art; movie posters match grid sizing. Row details stay separate from enlarged Play controls. Artwork is authenticated.
- Account/privacy/handoff dialogs use existing dark inputs, quiet/primary buttons and shared symbols. Browser logout retains bottom placement/spacing and is hidden for Activity bearer identity.
- The username opens account settings; do not add a separate account cog. Refresh rooms belongs in the room bar immediately before New room.

Test affected normal/theater/phone surfaces using isolated fixtures. Actual player/Activity results stay separate. Private design transcripts and historical screenshots are not public documentation.
