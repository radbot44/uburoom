# UI design guide

Use established components, styles and interactions. Follow [AGENTS.md](../AGENTS.md#ui-and-design) for owner approval and rendered review. This guide records reusable rules and exceptions; settled feature behavior belongs in its implementation, not a second specification here.

## 1. Principles & General Rules

- **Safe DOM creation:** Construct SVG icons and DOM structures safely using `createElementNS` with static attribute dictionaries and safe DOM methods (`createElement`, `textContent`). Never use `innerHTML`, `outerHTML` or `insertAdjacentHTML`, preserving the public icon API, local asset set and accessible attributes.
- **People vocabulary:** People in a room are **Viewers** (the roster heading, the Room settings Viewers section, counts and removal messages); **Hosts** is the role. The non-host role is labelled Viewer in permission tables. Do not use "Participants", "Roomies" or "People" as headings or labels for people in a room.
- **Terse copy & form design:** Omit explanatory access-policy, server-audience and room-lifecycle prose from forms. Prefer short action labels and truthful status or error text. Avoid implementation explanations in end-user flows unless they help someone take a concrete action.
- **Motion & interaction:** Respect `prefers-reduced-motion`; hover and press changes color or surface, not scale or position. Focus uses a visible 2px outline with a 2px offset (`var(--primary)`). Text labels may wrap to two lines; compact labels stay single-line.
- **Theming & external extensions:** Support dark and light themes (`[data-theme=light]`) with high-contrast semantics. The watch page declares `<meta name="darkreader-lock">` so third-party dark mode extensions cannot recolor subtitle outlines, player controls or palette tokens.

## 2. Control Types & Shared Tokens

### Control types

| Intent | Control |
| --- | --- |
| Action | Button |
| Live boolean setting | Switch |
| Pending form choice | Native square checkbox (`.form-checkbox`) |
| Short value selection | Segmented selector |
| Change panel | Tabs |
| Long/dynamic choices or mobile video settings | Native dropdown |
| Permission | Allowed/Denied thumbs |
| Mute, Captions, Theater | Pressed icon button |

Keep action, selection, navigation and status distinct. Reuse established exceptions such as compact Admin/privacy controls rather than forcing every boolean into a switch.

### Sizing & token standards

Use existing theme tokens and shared control classes; do not recreate their sizing in feature-specific CSS.

| Element | Standard |
| --- | --- |
| Text button | Minimum 40px height, 12px radius |
| Sign-in/entry action | Minimum 44px height (e.g. 46px provider button) |
| Icon button | Minimum 40×40px target, 10px radius; 24px artwork |
| Inline icon | 20px artwork; 8px gap, 6px compact |
| Label | 14px normal / 12px compact; 600 primary/destructive, 500 secondary |
| Horizontal padding | 16px normal / 12px compact |
| Adjacent icon actions | 4px gap (`var(--watch-icon-gap)`) |
| Focus | Visible 2px outline, 2px offset |
| Switch | 36×22px component (`input.watch-switch`); 44px minimum row/target (`.watch-switch-label`) |
| Segmented selector | 40px inner button height; 46px group height with 3px padding (`.watch-segmented`) |

### Scales and token families

Tokens are declared once, in the `:root` block at the top of `web/watch.css`. Outside that block, stylesheets use tokens rather than literal font sizes, radii, `z-index` values, colours, or pixel gaps, padding and margins.

| Family | Tokens |
| --- | --- |
| Type scale | 12 / 14 / 16 / 20 / 24 px: `--font-size-12` … `--font-size-24`. No other sizes; a size between two steps takes the larger. |
| Spacing | `--space-<px>` for gap, padding and margin |
| Radius | `--radius-<px>`, `--radius-pill` (capsule), `--radius-round` (circle) |
| Layers | `--z-local-<n>` and `--z-behind*` inside a component; named page layers from `--z-ending` up to `--z-popover` |
| Fixed colours | `--chrome-*` (dark palette for video chrome in both themes), `--black` / `--white` and their `-a<percent>` alpha steps, `--discord` |

Spacing, radius and alpha tokens are named by value and currently mirror every value in use; consolidating near-duplicates is a separate owner decision. Breakpoints cannot be custom properties; the widths in use are listed in the comment above the token block.

Type scale exceptions: subtitle text (viewer-chosen size), the player quality badge (8px) and the handoff code (32px). Sizes outside the scale were folded to the nearest step on adoption (10, 11 → 12; 13 → 14; 15, 17 → 16; 18, 19, 22 → 20).

### Shared semantic classes

- **Actions:** `.primary` for primary actions, `.quiet` for secondary, `.icon-button` for icon actions, `.danger-button` for destructive actions, and `.solid-button` for player title-bar controls only.
- **Accents:** Primary accent is orange (`var(--primary)`) and secondary accent is pink (`var(--secondary)`). `var(--secondary)` is the designated accent color for auto-queue and continuation offers.
- **Form & structural components:** `.watch-control` for standard interactive controls, `.watch-switch-label` with `input.watch-switch` (`36×22px`, `flex: none`) for standard switch rows, `.form-checkbox` for form checkboxes, `.dialog-actions` for button rows, `.watch-panel-header` for section headers, and `.room-invited-item` for invited member rows in Room settings.

### Typography

- Body and controls: `Inter, system-ui, -apple-system, "Segoe UI", sans-serif`.
- Headings: `Uburoom Sans` (`UburoomSans-Regular.woff2`, 400 weight).
  - Scope: Major headings (`h1`, `h2`), dialog headers (`dialog h2`, `.watch-dialog h2`), and sidebar panel headers (`.watch-panel-heading`).
  - Section panel headings (`.watch-panel-heading`): 24px size, 400 weight.
  - Fallback stack: `'Uburoom Sans', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`.
  - Weight & styling: Headings strictly use natural 400 weight (`font-weight: 400`), never faux-bold (`font-weight: 700`). Discretionary ligatures (`dlig`) and the Color edition are excluded in the web application.

## 3. Dialog Archetypes

Shared modal dialogs use `.watch-dialog` with a semantic `<header>` containing an `<h2>`. Modal dialogs strictly follow two structural archetypes:

### Archetype 1: Small Prompts & Confirmations (`.dialog-small`)

- Structure: Semantic `<header>` containing `<h2>`. Omit top-right close ("X") button.
- Footer: Action footers use `.dialog-footer` with paired `[Cancel (.quiet)]` on the left and `[Action (.primary | .danger-button)]` on the right (`justify-content: flex-end; gap: 10px; margin-top: 20px`).
- Canonical surfaces: Browser sign-in approval (`#handoff-dialog`), Account removal confirmation (`#account-remove-dialog`), and Room change confirmation (`#room-confirm-dialog`).

### Archetype 2: Modal Workspaces & Settings Dialogs

- Header: Semantic `<header>` containing `<h2>`, optional toolbar controls, and a mandatory top-right Close ("X") button (`.icon-button`, 40×40px target, 10px radius, 24px artwork, `autofocus`, `aria-label="Close"`, `title="Close"`).
- Footer & Dismissal: Standalone Cancel buttons are eliminated: a Cancel button appears only when paired with an active counterpart (Submit, Create, Save, Schedule). In pure browsing or inspection views (such as the room list in `#room-dialog`), no footer is shown and the header Close button serves as canonical dismiss.
- Standard dialog surfaces:
  - **Player settings (`#tracks-dialog`):** Groups related controls in two columns on wide screens, stacking in reading order on narrow screens.
  - **Account dialog (`#account-dialog`):** Houses Log out in `.dialog-footer.with-divider` separated from the scrollable account body.
  - **Rooms dialog (`#room-dialog`):** Places list tabs in `#room-chooser-nav`, uses the standard header Close button, and displays `.dialog-footer` (`[Cancel (.quiet)]` left, `[Create room (.primary)]` and `[Settings (.icon-button)]` right) only while in New room mode.
  - **Room settings dialog (`#room-settings-dialog`):** Full settings workspace with navigation tabs, section panels, and header Close button.
  - **Codec tester (`#codec-test-dialog`):** Semantic `<header>` with title and top-right Close button.

### Share Dialog (`#room-share-dialog`)

A compact modal workspace utilizing the narrow width of `.dialog-small` (`max-width: 420px`) while adhering to Archetype 2 header controls. Share covers the invite and the Discord room post only; scheduling has its own dialog.
- **Header:** Features a top-right close icon button (`#room-share-dismiss`).
- **Invite link bar:** Unified invite bar with a read-only URL input omitting `https://` (clicking or tapping copies the full URL), an icon-only Copy button, and a native Share icon button.
- **Discord publication preview:** Displays an inline channel badge pill (`.room-share-channel-pill`), a preview card with a primary accent left border (`border-left: 4px solid var(--primary)`), title, and status dot. Unpublished rooms show Publish now (`.primary`). Published rooms provide View Discord post (`.quiet`) and Remove post (`.danger-button`).

### Watch nights (scheduled events)

A watch night is a room with a time on it: every event belongs to one saved room, and choosing media stays in the room's queue (movies, episodes or several items), never in the scheduler.
- **Entry points:** The lobby room bar shows **Schedule** (`.quiet`, calendar icon) between Reopen room and New room. Inside a room, a calendar icon button in the room header actions (beside Share) opens the same scheduler with that room selected. Only people the server's `events.schedulers` tier allows see these entry points; guests never do.
- **Event scheduler dialog:** One shared Archetype 2 dialog for both entry points and for editing. Its first row is **Room**: a dropdown defaulting to **New room** (named after the event title) that also lists rooms the person hosts; single-room mode shows no Room row. It keeps the established form: a 100-character counter on event title; start time quick chips (Next half-hour as default, Tonight 8:00 PM, Tomorrow 8:00 PM), split Date and 15-minute Time dropdowns, and a collapsible time zone toggle; duration pills (1h, 2h, 3h, Custom) with an auto-calculated end time badge. A **Post to Discord** form checkbox follows, on by default when Discord is configured and hidden otherwise. Footer: `[Cancel (.quiet)]` with `[Schedule (.primary)]` (Save when editing). Event drafts follow shared save/cancel boundaries without locking to playback epoch.
- **Scheduler feedback:** Submitting shows a loading popover and then any error popover on the Schedule/Save button. On success the dialog closes and the success popover anchors to the control that opened it. The dialog's inline status line is kept only for persistent messages that no click caused, such as a failed load or scheduling being limited on the server.
- **Lobby Upcoming list:** Above the lobby room list, shows the next 3 events the person can see (an event follows its room's visibility), with a More link for the rest. Each card shows the title, room, time ("Tonight · 8:00 PM") and, when posted to Discord, its interested count. From the start time until the end time the card reads **Starting now** with Join as its main action; at the end time it leaves the list.
- **Card actions:** The main action follows the room: **Join** when it is open; when it is closed, hosts get **Open room** (also how they queue media ahead of time) and everyone else sees "Waiting for host". The main action turns `.primary` once the event is Starting now. Hosts also get Edit, Copy invite (also for events not posted to Discord) and Cancel as 36px icon buttons (`edit`, `copy`, `trash`); Cancel asks for confirmation first. Feedback uses anchored popovers: errors and Copy invite on their own button, a canceled event's confirmation on the lobby Schedule button because the card leaves the list.
- **Lobby order:** The lobby button row (Reopen room, Schedule, New room) comes first, directly under the intro, so it stays in view; the lobby error line follows it, then the Upcoming list, then the active rooms, which scroll beneath when the video area is short.
- **Upcoming rows:** Same row style as the lobby's active rooms, with a `calendar-event` icon before the title and "time · room · N interested" as the hint line, under a small uppercase "Upcoming" heading. More (n) expands the full list in place and Show fewer collapses it.
- **Waiting for host:** Opening the invite of a closed room that has a watch night shows "Starts 8:00 PM · Waiting for host" until a host opens the room; uburoom never opens it automatically.

## 4. Panel Headings & Navigation

- **Section heading icon badges:** 40×40px solid orange (`var(--primary)`) square, 10px radius (`var(--watch-control-radius)`), with dark artwork (`var(--on-primary): #101217`, 24px icon) using `armchair-2` for Room, `player-track-next` for Queue, and `video` for Media.
- **Section toggle layout:** The minimize chevron stays immediately adjacent to the heading title with an 8px gap (`var(--watch-control-gap)`). `#options-title` sizes to the room name; when the name and the header actions do not fit on one line, the actions wrap to a row below and the name keeps the full first line, truncating with ellipsis only beyond it.
- **Room panel:** The panel shows the room header actions, the viewer list and the room buttons; it has no permission controls. Permissions are edited in Room settings → Permissions only. A header action the person cannot use is shown disabled with its reason as tooltip (for example Schedule: "Only hosts can schedule events") rather than hidden; actions the server does not offer at all (scheduling limited by the server, guests) stay hidden. Panel heading titles (`.watch-panel-title`) use a 2px vertical offset (`position: relative; top: 2px;`) to optically center uppercase glyphs with the 40×40px badge icon, while the minimize chevron remains vertically centered in the row.
- **Continuation toggles:** Compact split-style toggle pills (40px tall, 10px radius, button grey `var(--elevated)` surface without borders or outlines) featuring an accented 32×32px left minibutton (8px radius) with 24×24px stroke icon (`fill: none`), and normal button font text label on the right (`Inter`, 14px, 500 weight). When ON, the minibutton is filled with the accent color (orange `var(--primary)` with Play icon for Auto-play; pink `var(--secondary)` with Sparkle icon for Auto-queue) with dark artwork (`var(--on-primary): #101217`). When OFF, the minibutton and label are neutral/muted. The pill retains its button grey background without tints. Responsive collapse to icon-only buttons occurs only when labels do not fit (`<= 440px` queue width). Queue settings gear button (`#queue-auto-open`) remains standalone beside Auto-queue.
- **Room navigation & URLs:** Room URLs use clean path slugs (`/room/<slug>`) instead of query parameters (`/watch?room=<id>`). The default room name format "Room <UbumfaWord>" generates a single-word slug (`<ubumfa-word>`), while custom room names generate hyphenated alphanumeric slugs with numeric suffixes for collisions (`slug-2`). Single-room mode and the multi-room lobby live at root (`/`), and `/watch` redirects to root or the active room slug. When opening an authorized room link (`/room/<slug>`), the page renders directly in room context without flashing outside-room lobby controls or unjoined placeholder states; unauthenticated visits show the sign-in form with return destination preserved, and closed event rooms show waiting-for-host without flashing lobby controls.

## 5. States and Playback Interaction

### General control states

- Disabled actions: entire control at 40%, inert.
- Unavailable actions carrying status: no background, readable reason, focusable `aria-disabled`, inert.
- Available but ineffectual: normal background, icon at 40%, no hover/action.
- Loading: preserve geometry, dim original control, use the shared white spinner and prevent duplicate action.
- Asynchronous preview actions (such as account match preview) track request generation and normalized input snapshots. Responses for superseded inputs or closed contexts are discarded without clearing draft inputs, duplicate requests while in flight are prevented, and confirmation actions validate against the accepted input snapshot.
- Keep selected, focused, disabled and read-only distinct; do not rely on color alone. Pending work must not disable unrelated controls.
- Switch labels stay left and switches right; wrap text without shrinking or moving the switch. Show the actual checked state even when disabled.
- Segmented arrows/Home/End move focus; Enter/Space selects. Tab arrows activate immediately. Selection alone must not trigger a separate destructive or transfer action.
- Adapt labels to available control width while retaining accessible names. Preserve focus and scroll during asynchronous updates; keep revealed content below sticky headers.

### Player controls & Fullscreen

- **Hit box sizing:** Player controls and queue controls maintain a minimum 40×40px interactive hit box across responsive viewports while preserving their distinct visual icon artwork sizes, position, and responsive wrapping. As an approved exception, icon action buttons inside the Playback queue timeline (move actions and remove actions) are 32×32px with 24×24px icons.
- **Center player overlay:** Circular center player overlay toggles play/pause on hover for viewers authorized to manage playback, but remains hidden whenever disabled (for unauthorized viewers, spectators, or while commands are pending) so no faint or ineffectual overlay obscures video playback.
- **Personal playback toggles:** Mute, Captions, Picture-in-Picture, and Theater use `aria-pressed` reflecting authoritative local state (`aria-pressed="true"` when active/muted) while retaining action labels, title cues, and volume state presentation.
- **Desktop fullscreen idle:** In desktop fullscreen, a mouse at rest for 2.5 seconds hides the controls and pointer during playback. Controls stay visible while paused, hovered over player chrome, or with a menu or drawer open.
- **Mobile & iPhone fullscreen:** On iPhone, the Fullscreen button activates native video fullscreen using Apple's system controls; text subtitles use native captions there, and other subtitle formats require Burn-in.

### Quality & Stream Delivery

- **Source passthrough vs converted:** "Original" indicates the viewer receives untouched source media. When Original is selected but the output is converted, the quality option reads "Maximum" with a line naming the output codec, and the player badge reads `MAX` instead of `ORIG`. Subtitles burned in without explicit selection display "Automatic (burned in)" with a status line explaining the conversion.
- **Automatic fallback:** Automatic fallback keeps the viewer's selected quality in the quality controls. While active, the sliding quality menu and player settings display "Using fallback · <height>p · <Mbps> Mbps" as status, and the settings badge displays `FB`. Shared short toasts announce "Switched to fallback to keep playing." (with "Using default audio." when audio differs) and "Returned to your selected quality." on return. Fallback is a delivery status, not a selectable quality.
- **Stream swaps:** A quality change between stream types keeps the current stream playing until the new one is ready, holding the last frame on screen through the transition swap.

### Subtitle & Audio Controls

- **Sliding menu:** Desktop player settings use one sliding menu: right-facing arrows open choices in place, final selections close it, and Back remains below the independently scrolling choices (Quality, Audio track, Audio mode, Chapters, Subtitle track). The seekbar timeline renders chapter notch breaks on the scrub track, and hovering displays chapter title and timestamp tooltips. Floating "Skip intro" and "Skip credits" actions appear above the transport bar exclusively for viewers authorized to manage seeking/playback in the room.
- **Subtitle rendering naming:** The subtitle rendering option is named **Burn-in** (not "Plex burn-in"), because uburoom or Plex may perform the transcoding. Subtitle help and error text does not name a provider.
- **Subtitle appearance & placement:** Text subtitles draw in their own layer over the player, not as browser cues. They default to a solid VLC-style outline (labelled Shadow), scale with the player through Small, Medium and Large, and stay on the visible picture unless Text position is set to "On player". They remain visible when controls hide and lift dynamically only when the controls would cover them. ASS and bitmap subtitles keep their authored placement. Player settings provide curated color presets (White, Yellow, Cyan, Green), a 7-character hex code input, a native 40×40px color swatch, a 3-choice background style segmented selector (Off, Background, Shadow), and a 20%–100% overlay brightness range slider.
- **Audio mode:** Grouped under Audio in player settings, providing a 3-choice segmented selector (Normal, Dialogue, Night) with dynamic descriptive hints; operates entirely client-side via the Web Audio API without affecting server transcoding, delivery, or other viewers.

### Picture-in-Picture (PiP)

- Button (`#pip`) sits in `.player-tools` adjacent to Theater and Fullscreen, operable via click or the `P` key (`KeyP`).
- **Document PiP:** In browsers supporting the Document Picture-in-Picture API, PiP reparents `#stage` into the always-on-top window with the full hover-revealed transport bar, skip marker overlays, and client subtitle canvas layers intact, while displaying a centered `#pip-placeholder` with a Return video button on the main stage; closing the floating window or clicking return restores `#stage` cleanly to the page.
- **Native video PiP fallback:** In browsers lacking Document PiP support, `#pip` falls back to native `<video>.requestPictureInPicture()`; when client-rendered subtitles (ASS, PGS, VobSub) are active, an informative action toast directs viewers to choose Burn-in in Subtitle settings to retain subtitles in PiP.

### Queue & Auto-Queue

- **Now Playing outline:** Now Playing retains the primary accent outline (`outline: 2px solid var(--primary)` in cards view; inset box-shadow in list view) instead of a transient selected-item state.
- **Auto-queue preview card:** Auto-queue maintains at most one preview card (`autoQueue.next`) at the tail of Upcoming, styled with `var(--secondary)` border and inset accent (including an explicit 2px `var(--secondary)` outline in cards view), an `AUTO` rank badge (`Auto-queue` / `Auto · Up in …` caption), and dedicated actions (Add to queue, Skip suggestion, Play now, Skip to) with no reorder arrows.
- **Auto-queue options:** Queue settings offer four auto-queue modes (`Off`, `Continue`, `In order`, `Shuffle`) highlighting active selections with `var(--secondary)`. Auto-queue switches (`#queue-auto-toggle` and `#queue-auto-specials`) use `var(--secondary)` when active. In Media and library views, auto-queue source actions use `.library-auto-queue` and `.library-auto-queue-label` with the designated `sparkle` icon, `var(--secondary)` accent, 40px minimum height, 12px radius, 14px label, and label text "Set as auto-queue".

### Room Viewers & Telemetry

- **Viewer telemetry cards:** In the room's Viewers roster, sync quality badges operate as interactive 24×24px buttons with transparent backgrounds (including on hover) opening an anchored floating viewer telemetry card (`.viewer-telemetry-card`). The card is interactive in fullscreen and its close button leaves the drawer open. Displays username, role badge, live playback status pill (Playing, Buffering, Paused, Seeking, Starting, Disconnected), sync score percentage, level badge, confidence, plain-language diagnostic explanation, measurement freshness, and multi-session device breakdown. Dismisses on Escape, outside click, or close button.
- **Viewer health alerts:** In the roster, a guest's sync icon becomes `alert-triangle` while they experience an issue (warning color; danger for player error), held 15 seconds after it clears. Their telemetry card adds an issue line and host-only details list: quality and format, buffered seconds, stalls in the last minute, dropped frames, sync offset, reconnects, and device. Issues and limits are defined once in sync core: error; 2 stalls or 3 seconds stuck per minute; under 2 seconds buffered while playing; 10% dropped frames; Poor sync.
- **Roles & guest presentation:** Host role badge and icon use theme-aware text (`var(--text)`), maintaining high contrast against both dark and light surfaces while room leader retains accent coloring (`var(--accent-text)`). Active library filter labels use `var(--accent-text)`. In the roster, guests whose name is not verified show their name in italics with the `user-question` icon, with accessible label and tooltip reading "Guest (name not verified)". People in a room as guests are never offered Make host, and the Account dialog offers guests no Connect buttons.
- **Account provider rows:** Present actionable connect and reconnect controls based on identity state: Connect <Provider> when unlinked; Sign in to <Provider> when awaiting credentials; Reconnect when connected. Unlink remains separate and disabled whenever removing the identity would leave no enabled, usable sign-in method.

### Library & Ending Interstitial

- **Watched progress:** Library cards and details artwork display a 4px horizontal progress track with an orange (`var(--primary)`) fill bar anchored to the bottom edge of the poster whenever actionable watched progress exists (between 10 seconds and 92% completion), prioritizing the room's watch party history over personal Plex progress. In the details drawer, Play now remains on top, with a dedicated Resume at MM:SS button rendered directly below it when progress exists. Alternate cuts and multi-version files appear separately labeled by edition or resolution/codec, and the details drawer renders an "Other editions" section below the summary with 1-click navigation to sibling cuts.
- **Ending interstitial:** When a video ends (naturally or via explicit endpoint seek), the occurrence completes to history and unloads, and the full-stage ending interstitial takes over the player with dimmed/blurred artwork, a center play button (with a countdown ring during autoplay countdowns), up to three lines of episode summary (`-webkit-line-clamp: 3`), Watch again, and Browse media. Plain `#empty-stage` is shown only when a room has no current video, no history, and no upcoming queue/auto-queue item. Play at a finished occurrence selects the queued successor under existing video-selection authorization or play/pause when idle; restart remains an explicit separate action.

## 6. Feedback, Toasts & Diagnostics

### Feedback Selection Hierarchy

Follow a clear hierarchy for user and system feedback:
- **Anchored popovers (`.watch-popover`) — Default for direct interactions:** The primary, general-purpose method for feedback triggered by an explicit user action (button clicks, toggle pills, copy operations, queue additions, inline saves). Do not show toasts or append inline `<p class="hint">` status lines for direct control interactions; tether a precision pill popover directly to the triggering control.
- **Toasts (`.watch-toast`) — Reserved for global, async, or actionable room events:** Reserved strictly for asynchronous or room-wide events occurring independently of a focused button, including background room updates (participant joined/left, disconnected/reconnecting), system and playback alerts (Plex connection issues, stream fallback, subtitle errors), actionable two-line prompts with buttons (host video checks with "View", remote viewer buffering with "Pause to wait", choppy playback with "Lower quality"), and keyboard-triggered actions where no mouse focus or trigger anchor exists (e.g. PiP hotkey).
- **Inline status hints — Reserved for dialogs and static forms:** Reserved only for static containers (such as modal `<dialog>` windows or onboarding/login cards) that have dedicated, non-shifting space for multi-line explanations or persistent validation messages. Never use inline status hints in dynamic content panels or toolbars where they displace neighboring controls.

### Shared toast system

Reuse the shared toast system (`.watch-toast`); preserve established placement, dismissal, timing, keyboard and error behavior instead of adding feature-specific variants. Errors must remain visible when ordinary notifications are muted; uncertain status must not appear verified.
- **Two-line action toasts:** Present the message on the first line and compact action and Dismiss buttons on the second line. Deliberate dismissal suppresses repeat warnings for the session.
- **Fullscreen error behavior:** In fullscreen, errors never open the drawer. They display as the shared error toast with one action: the fix when there is a direct one, otherwise "Open menu", which opens the drawer over fullscreen. Outside fullscreen, the error line stays in the menu.
- **Saved preference recovery:** After a reconnect or reload, quality, volume, subtitles (language and Burn-in) and audio language restore automatically from saved preferences; fullscreen is re-entered by the viewer.

### Anchored popover system

Use the shared anchored popover (`.watch-popover`) for immediate, localized feedback tethered directly to interactive triggers (e.g. Auto-queue and Auto-play pills, quick permissions, roster host/kick actions, copy buttons, and account name saving), replacing distant inline layout notices and localized toasts.
- **Silhouette & Geometry (Precision Pill):** Full capsule (`border-radius: 999px`, 32px height, `0 12px` padding), single-line 12px text (`font-weight: 600`), and a 14×14px status icon. Uses a centered 7×7px diamond caret pointing to the trigger, automatically positioning above or below the control with viewport edge clamping.
- **Surface & Material:** Solid `var(--card)` background (no glassmorphism/backdrop blur) with a 1px solid border (`var(--border)`) and `0 6px 20px rgba(0, 0, 0, 0.45)` shadow.
- **Semantic States:**
  - *Success:* Green icon (`var(--success)`) with subtle green border tint (`color-mix(in srgb, var(--success) 35%, var(--border))`).
  - *Loading:* Rotating loader (`loader-4`) in `var(--primary)` with muted text (`var(--muted)`).
  - *Error:* Solid `var(--danger)` background (`#b6263c`) with pure white text and alert icon (`alert-triangle`), directly matching the error toast theme.
- **Dismissal & Accessibility:** Auto-dismisses after 2.5 seconds (`2500ms`), or on outside click / window scroll. Declares `role="status"` and `aria-live="polite"` for assistive technology. Respects `prefers-reduced-motion`.

### Subtitle loading & catch-up

Subtitle loading and progressive catch-up display a delayed (`250ms`) top-right spinning `loader-4` icon in orange (`var(--primary)`) over the subtitle button without showing a toast, keeping the button interactive so subtitles can be disabled during loading. Bounded subtitle-window recovery uses existing loading/error feedback and explicit Burn-in choice; a failed or unauthorized window must not clear its error as successful caption coverage, and subtitle recovery remains independent of video playback.

### Buffering & Outage Resilience

- **Buffering notice:** Ongoing buffering never pauses healthy viewers automatically. When a remote viewer experiences sustained buffering (>= 3 seconds), an actionable buffering notice toast appears exclusively for viewers authorized to manage playback (room leader/hosts) with an optional "Pause to wait" action. If the host pauses and the buffering viewer catches up, a follow-up action toast notifies the host that the viewer is ready with a "Resume playback" action. Explicit dismissal suppresses repeats for that viewer until healthy playback resumes.
- **Degradation warnings:** Playback degradation warnings extend the choppy playback detector and Lower quality toast. Deliberate dismissal belongs to the viewing session and survives same-media stream replacement, resetting on new media, room, or session exit. Warnings fire once per continuous degradation episode, requiring healthy playback before rearming.
- **Outage silence & shared error:** A Plex outage stays silent while buffered playback covers it. If anyone in the room is affected, including while recovering after Plex returns, everyone in the room sees one shared error toast ("Plex connection problem") after a 3-second delay, clearing once nobody is affected. Never display "room ended" for a server or provider outage.

### Video Check & Diagnostics

- **Host video check:** Hosts receive a Video check in Player settings under Media information, listing file and Plex checks most serious first (problem, warning, information, fine) with an icon each, and a quiet "Check again" button. When a check finds a problem or warning, hosts get one two-line action toast per video with "View", which opens Player settings at the check. Viewers never see it.
- **Diagnostic report:** "Copy diagnostic report" is a quiet button with the `copy` icon inside Technical details in the player settings Media information section. It copies a recent player report to clipboard and confirms with an anchored tooltip popover on the button; if clipboard access is blocked, the report downloads directly as a file. When the server retains diagnostics, its hint indicates retention duration without requiring a separate privacy notice.

## 7. Review and Maintenance

Inspect affected controls across themes (light and dark), narrow layouts, 200% zoom and keyboard use. Automated checks and screenshots do not replace owner acceptance.

Add a rule here only when it guides future design or records a necessary exception. Do not append feature labels, roster layouts, scoring formulas, preference inventories, toast timings, internal buffer transport ledgers, or refactoring history already owned by an established system.
