# Browser accessibility walkthrough (Stage 2)

Post-Stage-2 verification of the `uburoom` browser client (`web/`) against [design-guide.md](design-guide.md), executed on `2026-11-13` on `main` (post-`9a3e064` working tree) against the isolated local fixture (`scripts/lib/ui-fixture.js`).

> Scope classification per [testing.md](testing.md): **A** (source inspection) and **B** (isolated Playwright Chromium + Firefox WebDriver BiDi execution against local fixture accounts and media). No live Plex, Discord, Activity, or production server was touched. Live two-browser playback (`C`), assistive-technology screen-reader / physical keyboard checks (including real Firefox initial-`Tab` `#skip-link` behaviour), and owner visual sign-off (`D`) remain open under `P7 UI`.

## Environment and run scope

| Item | Value |
| --- | --- |
| Chromium | `Chrome/157.0.8103.51` (CDP `Emulation.setEmulatedMedia` `forced-colors: active` dark palette: `rgb(0, 0, 0)` canvas, `rgb(255, 255, 255)` text, `rgb(26, 235, 255)` highlight) |
| Firefox | `160.0` (WebDriver BiDi; dedicated Forced Colours profile with `browser.display.document_color_use = 2` and `ui.use_standins_for_native_colors = true`, light palette: `rgb(255, 255, 255)` canvas, `rgb(0, 0, 0)` text, `rgb(51, 153, 255)` highlight) |
| Viewports tested | Desktop `1280×900`, zoom `200%` (`640×450`), zoom `400%` (`320×500`), short desktop `1280×480`, phone `390×844` |
| Fixture states | `?demo=none` (sign-in), `?demo=host` (lobby, dialogs, host room, queue, library, player, toasts/popovers, Forced Colours), `?demo=viewer` (viewer room), `?demo=ended` (ending interstitial) |
| Evidence outputs | External evidence folder `..\uburoom-evidence\artifacts\v5-accessibility\` (`walkthrough-data.json` + 80 PNG captures across Chrome and Firefox; stale Stage 1 `*-dialog-codec.png` captures removed) |

## Cross-cutting results

### 1. Focus indicators and skip link

- Keyboard focus uses `--text` (`rgb(248, 247, 244)`) `3px solid` outline with `3px` offset (`--space-3`) across interactive buttons, links, range inputs (`#player-volume`, `#timeline`), and `.watch-switch` tracks (with inset `-2px` offset inside overflow-clipped containers and `#player-settings-menu` items).
- `#skip-link` is the first focusable element in source order; pressing `Enter` moves focus directly to `#stage`.
- **Browser note:** In Chrome (`Chrome/157.0.8103.51`), synthetic `Tab` from a fresh Lobby load focuses `#skip-link` at `121.9×41.6 px` with `3px solid rgb(248, 247, 244)` outline (`offset: 3px`). In Firefox (`160.0`), `Enter` moves focus to `#stage`, while the pre-pointer synthetic WebDriver BiDi `Tab` reported `#skip-link` at `30×40 px` with `outlineStyle: "none"`; subsequent `Tab` stops across `signIn`, `lobby`, dialogs, and player transport controls render `3px solid rgb(248, 247, 244)` outlines in Firefox as well.

### 2. Target size and documented compact exceptions

- **`0` non-exempt undersized targets (`< 40×40 px`)** across every audited surface in both Chrome and Firefox.
- `.watch-switch` checkboxes are wrapped inside `.watch-switch-pill` (`>= 40 px` hit target); `0` unwrapped checkbox inputs appeared on any surface (`2` wrapped switches active in host room, viewer room, and queue views).
- `#timeline` and `#player-volume` retain slim visual bars with `40 px` hit boxes (`86×40 px` desktop `#player-volume`, `40×96 px` vertical phone `#player-volume`).
- Documented compact exceptions per [design-guide.md](design-guide.md):
  - `#identity` (`155.9×32 px` host / `164.3×32 px` viewer) and `#admin-mode` (`32×32 px`): `32 px` header controls.
  - `.library-filter-chip`: `min-height: 32 px` in stylesheet (`filterChips` empty in fixture Browse state).
  - `.room-roster-sync-quality`: `24×24 px` compact indicators (`2` in host/viewer roster).
  - Queue row timeline controls (`32×32 px` icon buttons) and `.queue-title-link` (`16.8 px` tall inline link): `20` compact queue items in host room, `19` in viewer room, `25` in the Queue panel view.
  - Toast action/dismiss controls (`watch-toast-action`, `watch-toast-dismiss`): `40 px` height in verified desktop toast fixtures; compact sizes permitted only in narrow/exception rules documented in [design-guide.md](design-guide.md).

### 3. Forced Colours (`@media (forced-colors: active)`)

- Interactive controls (`#theme-toggle` track, `#admin-mode`, `.watch-switch` input and pill, `.primary`, `.quiet`, `.watch-toast`, `.watch-toast-action`) render explicit `1px solid` borders in both Chrome (dark Forced Colours) and Firefox (light Forced Colours).
- Active section tabs (`#room-settings-nav [aria-current="true"]`) and toggled group buttons (`[aria-pressed="true"]`) switch to system `Highlight` / `HighlightText` pairs in both browsers (`rgb(26, 235, 255)` / `rgb(0, 0, 0)` in Chrome; `rgb(51, 153, 255)` / `rgb(255, 255, 255)` in Firefox), distinct from inactive/unpressed controls.
- Wordmark `"room"` legibility: `web/assets/uburoom-wordmark-brand.svg` keeps plain static fill, `web/styles/exceptions.css` sets `body { background: Canvas; color: CanvasText; }` inside `@media (forced-colors: active)`, and `web/theme.js` selects dark `#242329` vs light `#F8F7F4` `"room"` lettering from resolved canvas/text luminance on `DOMContentLoaded`, `load`, and `forced-colors` changes (`usesDarkWordmarkForLightCanvas: false` on Chrome dark canvas; `true` on Firefox light canvas). Verified across Lobby, Room, and Ending Forced Colours screenshots.

### 4. Headings, landmarks, reflow, and CSS custom-property positioning

- `0` skipped heading levels (`skippedHeadings: []`) and `0` unlabelled `<nav>` landmarks across all audited surfaces (`#room-bar` carries `role="navigation"` and `aria-label="Workspace"`).
- Visible `<h1>` count is `1` on Sign-in (`#empty-title`), Lobby (`#empty-title`), Room (`#title`), and Ending (`#ending-title`, promoted from `<h2>` when ending stage is active).
- At `<= 620 px`, `#room-settings-dialog` retains desktop subheadings in the heading tree without level jumps (`1:title` -> `2:Friday room` -> `3:Viewers` -> `2:room-settings-title` -> `3:Manage` -> `4:Transfer room leadership` / `4:Saved room`).
- `overflowX: false` across `1280×900`, `640×450`, `320×500`, and `390×844` on Sign-in, Lobby, Room Host, and Toasts in both Chrome and Firefox.
- Dynamic overlay/layout offsets use CSS custom properties rather than direct inline `top`/`left`/`maxWidth`: `#toasts` uses `--max-width`, `--x`, `--y`; tooltips use `--arrow-x`, `--x`, `--y`; `#room-column` uses `--sidebar-top` (`22px` Lobby, `-328px` Room `1280×900`, `-478px` Room `1280×480`, cleared to `""` on `<= 1100 px` single-column/phone layouts).

## Surface-by-surface verification summary

| Surface | Visible targets (`non-exempt < 40 px`) | Key Stage 2 behaviour verified (Chrome & Firefox) |
| --- | --- | --- |
| **Sign-in** (`?demo=none`) | `18` (`0`) | Single visible `<h1>` (`#empty-title`), `0` skipped headings, `0` unlabelled navs, cyclic keyboard trace with `--text` `3px` outline + `3px` offset, `overflowX: false` at all 4 widths |
| **Lobby** (`?demo=host`) | `41` (`0`; `2` compact: `#identity`, `#admin-mode`) | Single `<h1>`, `Lobby` `Upcoming` `<h2>` preserved, `#skip-link` jumps to `#stage`, `#admin-mode` and `#identity` at `32 px` height |
| **Rooms dialog** (`#room-dialog`) | `10` (`0`) | Initial focus on `#room-name`, `focusEscapedDialog: false`, `40 px` tab/filter buttons with focus outlines |
| **Event dialog** (`#event-dialog`) | `16` (`0`) | Initial focus on `#event-title`, `focusEscapedDialog: false`, `Escape` returns focus cleanly |
| **Host room** (`?demo=host`) | `70` (`0`; `2` wrapped switches; `24` compact: header `32 px`, `2` × `24×24` sync pills, queue controls) | Single `<h1>` (`#title`), `0` skipped headings, telemetry card opens on `40×40` close button with `1` visible target (`0` undersized) and `Escape` restores focus to `#room-roster-sync-quality` |
| **Viewer room** (`?demo=viewer`) | `66` (`0`; `2` wrapped switches; `23` compact) | Single `<h1>`, `0` skipped headings, `0` missing accessible names |
| **Player & transport** | Desktop `14` (`0`); Phone `8` (`0`) | All transport buttons `>= 40×40 px`; phone section tabs `44 px` tall (`116×44`); phone `#volume-panel` stays open `> 3300 ms` while focus rests on `#player-volume` (`40×96 px`), returns focus to `#player-mute` on `Escape`; phone extras row keeps notifications switch & PiP (`40 px`) accessible |
| **Player settings** | Sliding main `6` (`0`), submenu `4` (`0`); `#tracks-dialog` `25` (`0`) | Sliding menu closes on `1` `Tab` from main menu and submenu (moving focus to `#player-mute`); `Escape` closes submenu to `#settings-audio-mode`, then main menu to `#tracks-open`; `#tracks-dialog` opens unclipped at `scrollTop: 0`, `dialogTop: 16`, `closeTop: 41` (`clippedTop: false`) with initial focus on `#sync-correction` (`361×41 px`), `0` skipped headings, `focusEscapedDialog: false`, `Escape` returns to `#tracks-open` |
| **Queue & bulk dialog** | Queue `34` (`0`; `2` wrapped switches; `25` compact); Bulk `4` (`0`) | Compact queue action icon buttons (`32×32 px`) and `.queue-title-link` documented; `#queue-bulk-dialog` keeps focus strictly inside dialog (`focusEscapedDialog: false`) |
| **Library** | Home `10` (`0`); Browse `25` (`0`) | **Codec tester removed from client (`web/`)**: `#library-codec-test` and `#codec-test-dialog` absent (`codecTestRemoved: true`), `0` skipped headings in Browse |
| **Share & Confirm dialogs** | Share `4` (`0`); Confirm `2` (`0`) | `#room-share-url-input` (`264×40 px`) shows `--text` `3px` outline; both dialogs trap `Tab` inside (`focusEscapedDialog: false`) |
| **Room settings** (`#room-settings-dialog`) | General `14` (`0`), People `12` (`0`), Permissions `36` (`0`), Playback `17` (`0`), Manage `9` (`0`); Phone `9` (`0`) | `focusEscapedDialog: false`; active nav tab + pressed group buttons render `Highlight`/`HighlightText` in Forced Colours; `<= 620 px` keeps valid heading hierarchy (`h1` -> `h2` -> `h3` -> `h2` -> `h3` -> `h4`) |
| **Account dialog** (`#account-dialog`) | `7` (`0`) | `0` skipped headings (`h1` -> `h2` -> `h3`), `focusEscapedDialog: false`, closes cleanly on `Escape` |
| **Toasts & popovers** | Toasts `3` (`0`) | Toast `.with-action` buttons `40 px` tall, `role="status"` / `aria-live="polite"`, CSS custom-property positioning, `overflowX: false` across zoom levels; telemetry tooltip renders `31 px` height (`role="status"`, `aria-live="polite"`) |
| **Ending interstitial** (`?demo=ended`) | Desktop `4` (`0`); Phone `4` (`0`) | `#ending-title` promoted to `<h1>` (`visibleH1Count: 1`), `0` skipped headings |

## Intentional boundary and remaining open items

- **Codec-test removal boundary:** `#library-codec-test` and `#codec-test-dialog` were removed from `web/` (`web/watch.html`, `web/watch.js`, `web/watch-library.js`, `web/watch/session.js`, `web/styles/dialogs.css`) and [design-guide.md](design-guide.md). Per the Stage 2 client-only change boundary, `server/watch-page.js` and `tests/watch-page.test.js` were left untouched and still retain the server-side reference until a server cleanup change updates them together.
- **Unexercised conditional dialogs / flows in default fixture:** `#entry-form`, `#guest-join`, and `#invite-code-form` (unauthenticated room join/unlock variants), `#handoff-dialog` (Discord Activity handoff), `#server-settings-dialog` (`#account-server-settings` absent in non-admin fixture state; `hasServerSettingsBtn: false`), and live populated `.library-filter-chip` pills (verified via `min-height: 32px` stylesheet rule and targeted checks, not populated in the minimal Browse fixture).
- **Open acceptance gates (P7 UI):** Assistive-technology screen-reader traversal, real physical keyboard verification (including Firefox initial-`Tab` `#skip-link` behaviour), physical mobile/Activity layout checks, and owner visual sign-off (`D`).
