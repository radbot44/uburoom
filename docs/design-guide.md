# UI design guide

Use established components, styles and interactions. Follow [AGENTS.md](../AGENTS.md#ui-and-design) for owner approval and rendered review. This guide records reusable rules and exceptions; settled feature behavior belongs in its implementation, not a second specification here.

## Control types

| Intent | Control |
| --- | --- |
| Action | Button |
| Live boolean setting | Switch |
| Pending form choice | Native square checkbox |
| Short value selection | Segmented selector |
| Change panel | Tabs |
| Long/dynamic choices or mobile video settings | Native dropdown |
| Permission | Allowed/Denied thumbs |
| Mute, Captions, Theater | Pressed icon button |

Keep action, selection, navigation and status distinct. Reuse established exceptions such as compact Admin/privacy controls rather than forcing every boolean into a switch.

## Shared styling

Use existing theme tokens and shared control classes; do not recreate their sizing in feature-specific CSS.

| Element | Standard |
| --- | --- |
| Text button | Minimum 40px height, 12px radius |
| Sign-in/entry action | Minimum 44px height |
| Icon button | Minimum 40×40px target, 10px radius; 24px artwork |
| Inline icon | 20px artwork; 8px gap, 6px compact |
| Label | 14px normal / 12px compact; 600 primary/destructive, 500 secondary |
| Horizontal padding | 16px normal / 12px compact |
| Adjacent icon actions | 4px gap |
| Focus | Visible 2px outline, 2px offset |
| Switch | Existing 36×22px component; 44px minimum row/target |
| Segmented selector | 40px high |

Use local Tabler assets with accessible names. Preserve the circular main Play overlay. SVG icons are constructed safely using `createElementNS` with static attribute dictionaries and appended without `innerHTML`, preserving the public icon API, local asset set and accessible attributes. Text labels may wrap to two lines; compact labels stay single-line. Respect reduced motion; hover/press changes color or surface, not scale or position.

Classes: `.primary` for primary actions, `.quiet` for secondary, `.icon-button` for icon actions, `.danger-button` for destructive, `.solid-button` for player title-bar controls only. Primary accent is orange (`var(--primary)`) and secondary accent is pink (`var(--secondary)`); `var(--secondary)` is the designated accent color for auto-queue and continuation offers.

### Typography

- Body and controls: `Inter, system-ui, -apple-system, "Segoe UI", sans-serif`.
- Headings: `Uburoom Sans` (`UburoomSans-Regular.woff2`, 400 weight).
  - Scope: Major headings (`h1`, `h2`), dialog headers (`dialog h2`, `.privacy-dialog h2`, `.room-actions h2`), and sidebar panel headers (`.watch-panel-heading`).
  - Section panel headings (`.watch-panel-heading`): 24px size, 400 weight.
  - Fallback stack: `'Uburoom Sans', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif`.
  - Weight & styling: Headings strictly use natural 400 weight (`font-weight: 400`), never faux-bold (`font-weight: 700`). Discretionary ligatures (`dlig`) and the Color edition are excluded in the web application.

### Panel headings & quick toggles

- Section heading icon badges: 40×40px solid orange (`var(--primary)`) square, 10px radius (`var(--watch-control-radius)`), with dark artwork (`var(--on-primary): #101217`, 24px icon) using `armchair-2` for Room, `player-track-next` for Queue, and `video` for Media.
- Section toggle layout: The minimize chevron stays immediately adjacent to the heading title with an 8px gap (`var(--watch-control-gap)`). `#options-title` sizes to content and truncates with ellipsis for long room names rather than expanding to fill the header. Panel heading titles (`.watch-panel-title`) use a 2px vertical offset (`position: relative; top: 2px;`) to optically center uppercase glyphs with the 40×40px badge icon, while the minimize chevron remains vertically centered in the row.
- Continuation toggles: Compact split-style toggle pills (40px tall, 10px radius, button grey `var(--elevated)` surface without borders or outlines) featuring an accented 32×32px left minibutton (8px radius) with 24×24px stroke icon (`fill: none`), and normal button font text label on the right (`Inter`, 14px, 500 weight). When ON, the minibutton is filled with the accent color (orange `var(--primary)` with Play icon for Auto-play; pink `var(--secondary)` with Sparkle icon for Auto-queue) with dark artwork (`var(--on-primary): #101217`). When OFF, the minibutton and label are neutral/muted. The pill retains its button grey background without tints. Responsive collapse to icon-only buttons occurs only when labels do not fit (`<= 440px` queue width). Queue settings gear button (`#queue-auto-open`) remains standalone beside Auto-queue.

## States and interaction

- Disabled actions: entire control at 40%, inert.
- Unavailable actions carrying status: no background, readable reason, focusable `aria-disabled`, inert.
- Available but ineffectual: normal background, icon at 40%, no hover/action.
- Loading: preserve geometry, dim original control, use the shared white spinner and prevent duplicate action.
- Asynchronous preview actions (such as account match preview) track request generation and normalized input snapshots. Responses for superseded inputs or closed contexts are discarded without clearing draft inputs, duplicate requests while in flight are prevented, and confirmation actions validate against the accepted input snapshot.
- When a video ends (naturally or via explicit endpoint seek), the occurrence is completed to history and unloaded, and the full-stage ending interstitial takes over the player with dimmed/blurred artwork, a center play button (with a countdown ring during autoplay countdowns), up to three lines of episode summary, Watch again, and Browse media. Plain `#empty-stage` is shown only when a room has no current video, no history, and no upcoming queue/auto-queue item. Play at a finished occurrence selects the queued successor under existing video-selection authorization or play/pause when idle; restart remains an explicit separate action.
- Auto-queue maintains at most one preview card (`autoQueue.next`) at the tail of Upcoming, styled with `var(--secondary)` border/accent (including an explicit 2px `var(--secondary)` outline in cards view), an `AUTO` rank badge (`Auto-queue` / `Auto · Up in …` caption), and dedicated actions (Add to queue, Skip suggestion, Play now, Skip to) with no reorder arrows. Queue settings offer four auto-queue modes (`Off`, `Continue`, `In order`, `Shuffle`) highlighting active selections with `var(--secondary)`. Auto-queue switches (`#queue-auto-toggle` and `#queue-auto-specials`) use `var(--secondary)` when active. In Media and library views, auto-queue source actions use the designated `sparkle` icon with `var(--secondary)` accent, 40px minimum height, 12px radius, 14px label, and label text "Set as auto-queue".
- Account provider rows present actionable connect and reconnect controls based on identity state: when unlinked, display Connect <Provider>; when linked but awaiting sign-in or credentials, display Sign in to <Provider>; when connected, provide a secondary Reconnect action to refresh credentials without requiring unlinking. Destruction (unlink/remove) remains separate and disabled whenever removing the identity would leave no enabled, usable sign-in method.
- Host role badge and icon use theme-aware text (`var(--text)`), maintaining high contrast against both dark and light surfaces while room leader retains accent coloring. Active library filter labels use theme-aware accent text (`var(--accent-text)`).
- Player controls and queue controls maintain a minimum 40×40px interactive hit box across responsive viewports while preserving their distinct visual icon artwork sizes, position, and responsive wrapping; as an approved exception, icon action buttons inside the Playback queue timeline (move actions and entry actions) are 32×32px with 24×24px icons. Now Playing retains the primary accent outline instead of a transient selected-item state.
- Personal playback toggles (Mute, Captions, Picture-in-Picture, Theater) use `aria-pressed` reflecting authoritative local state (`aria-pressed="true"` when active/muted) while retaining action labels, title cues, and volume state presentation.
- Picture-in-Picture (`#pip`) sits in `.player-tools` adjacent to Theater and Fullscreen, operable via click or the `P` key (`KeyP`). In browsers supporting the Document Picture-in-Picture API, PiP reparents `#stage` into the always-on-top window with the full hover-revealed transport bar, skip marker overlays, and client subtitle canvas layers intact, while displaying a centered `#pip-placeholder` with a Return video button in the main viewing section; closing the floating window or clicking return restores `#stage` cleanly to the page. In browsers lacking Document PiP support, `#pip` falls back to native `<video>.requestPictureInPicture()`; when client-rendered subtitles (ASS, PGS, VobSub) are active, an informative action toast directs viewers to choose Plex burn-in in Subtitle settings to retain subtitles in PiP.
- In the room participants roster, sync quality badges operate as interactive buttons opening an anchored floating viewer telemetry card (`.viewer-telemetry-card`). The 24×24px badges use an icon on a transparent background, including on hover. The card is interactive in fullscreen and its close button leaves the drawer open. The card displays the participant's username, role badge, live playback status pill (Playing, Buffering, Paused, Seeking, Starting, Disconnected), sync score percentage, level badge, confidence, plain-language diagnostic explanation, measurement freshness, and multi-session device breakdown. Dismisses on Escape, outside click, or close button.
- Library cards and details artwork display a 4px horizontal progress track with an orange (`var(--primary)`) fill bar anchored to the bottom edge of the poster whenever actionable watched progress exists (between 10 seconds and 92% completion), prioritizing the room's watch party history over personal Plex progress. In the details drawer, Play now remains on top, with a dedicated Resume at MM:SS button rendered directly below it when progress exists. Alternate cuts and multi-version files appear separately in library browsing labeled by edition or resolution/codec, and the details drawer renders an 'Other editions' section below the summary with 1-click navigation to sibling cuts.
- Ongoing buffering never pauses healthy viewers automatically. When a remote viewer experiences sustained buffering (>= 3 seconds), an actionable buffering notice toast appears exclusively for viewers authorized to manage playback (room leader/hosts) with an optional 'Pause to wait' action. If the host chooses to pause and the buffering viewer catches up, a follow-up action toast notifies the host that the viewer is ready with a 'Resume playback' action. Explicit dismissal of the buffering notice suppresses repeats for that viewer until healthy playback resumes.
- The circular center player overlay toggles play/pause on hover for viewers authorized to manage playback, but remains hidden whenever disabled (for unauthorized viewers, spectators, or while commands are pending) so no faint or ineffectual overlay obscures video playback.
- Desktop player settings use one sliding menu: right-facing arrows open choices in place, final selections close it, and Back remains below the independently scrolling choices. Choices include Quality, Audio track, Audio mode, Chapters (when present on the active video), and Subtitle track; choice buttons present terse captions explaining their function. The seekbar timeline renders chapter notch breaks on the scrub track, and hovering displays chapter title and timestamp tooltips. Floating 'Skip intro' and 'Skip credits' actions appear above the transport bar exclusively for viewers authorized to manage seeking/playback in the room. Respect reduced motion. Quality changes do not show player notifications; Original includes the source bitrate rounded to whole Mbps when known.
- The full player settings dialog groups related controls in two columns on wide screens, keeping subtitle selection, rendering, appearance and timing together. Media information comes last; narrow screens stack groups in reading order. Audio controls group Audio track and Audio mode under Audio: Audio mode provides a 3-choice segmented selector (Normal, Dialogue, Night) with dynamic descriptive hints; it operates as an entirely client-side personal preference via the Web Audio API without affecting server transcoding, network delivery, or other viewers. Subtitle appearance controls keep text color, background style and overlay brightness grouped under Subtitles: text color provides curated presets (White, Yellow, Cyan, Green), a 7-character hex code input and a native 40×40px color swatch; background style uses a 3-choice segmented selector (Off, Background, Shadow); overlay brightness uses a 20%–100% range slider applying CSS brightness to both bitmap and script subtitle layers. These controls remain always enabled as personal viewer preferences and update immediately without server interaction.
- Keep selected, focused, disabled and read-only distinct; do not rely on color alone. Pending work must not disable unrelated controls.
- Server settings reuse the shared dialog, tabs, pending checkboxes and permission thumbs. Explicit Cancel/Close discards its draft; Escape/backdrop preserve dirty drafts. Conflicts retain edits and require inline choices for overlapping changes before saving.
- Switch labels stay left and switches right; wrap text without shrinking or moving the switch. Show the actual checked state even when disabled.
- Segmented arrows/Home/End move focus; Enter/Space selects. Tab arrows activate immediately. Selection alone must not trigger a separate destructive or transfer action.
- Adapt labels to available control width while retaining accessible names. Preserve focus and scroll during asynchronous updates; keep revealed content below sticky headers.

## Reuse and feedback

Reuse the shared toast, dialog, menu, permission and status systems. Preserve their established placement, dismissal, timing, keyboard and error behavior instead of adding feature-specific variants. Errors must remain visible when ordinary notifications are muted; uncertain status must not appear verified. Toasts with interactive actions use a container element sharing `.watch-toast` styling; two-line action toasts present the message on the first line and compact action and Dismiss buttons on the second line. Deliberate dismissal suppresses repeat warnings for the session. Subtitle loading and progressive catch-up display a delayed (`250ms`) top-right spinning `loader-4` icon in orange (`var(--primary)`) over the subtitle button without showing a toast, keeping the button interactive so subtitles can be disabled during loading.

Owner-approved 2026-10-29: bounded subtitle-window recovery uses the existing loading/error feedback and explicit burn-in choice. A failed or unauthorized window must not clear its error as successful caption coverage; subtitle recovery remains independent of video playback.

Owner-approved 2026-10-29: playback degradation extends the existing detector and unchanged Lower quality toast. Deliberate dismissal belongs to the current media/viewing session and survives same-media stream replacement; a new media item, room or session exit resets it. Runtime evidence alone drives warnings, once per continuous degradation episode with healthy playback required before rearming. Capability hints remain diagnostic context; quality changes remain explicit viewer actions. Buffer tuning requires measured justification.

Owner-approved 2026-11-06: a Plex outage stays silent while buffered playback covers it. If anyone in the room is affected, including while recovering after Plex returns, everyone in the room sees one shared error toast after the established 3-second delay, and it clears once nobody is affected. Do not show "room ended" for an outage.

Keep existing draft/save/cancel boundaries explicit and report failures truthfully. Preserve independent personal preferences and shared room authority. Put technical details in existing diagnostics surfaces, never credentials or private playback URLs.

## Review and maintenance

Inspect affected controls across themes (light and dark), narrow layouts, 200% zoom and keyboard use. Automated checks and screenshots do not replace owner acceptance.

Add a rule here only when it guides future design or records a necessary exception. Do not append feature labels, roster layouts, scoring formulas, preference inventories, toast timings or implementation history already owned by an established system.

Owner-approved 2026-11-06: under the optimization/hardening task's blanket design discretion, local WebM recovery reconciles its append ledger against actual audio/video buffered coverage. Refill only missing chunks, tolerate codec boundary gaps, preserve useful buffered playback and existing feedback, and bound repeated eviction recovery. Request cancellation follows superseded work through the transport; no control or styling changes.

Owner-approved 2026-11-06: the subtitle rendering option is named Burn-in, not Plex burn-in, because uburoom or Plex may do the work. Subtitle help and error text does not name a provider.

Owner-approved 2026-11-06: Original means the viewer is getting the source. When Original is selected but the output is converted, the quality option reads Maximum with a line naming the output codec, and the player badge reads MAX instead of ORIG. Rendering stays Automatic when subtitles are burned without being chosen, and reads Automatic (burned in) with a status line saying why.

Owner-approved 2026-11-07: in desktop fullscreen a mouse at rest for 2.5 seconds hides the controls and pointer during playback. They stay while paused, over the controls, or with a menu or drawer open. On iPhone the Fullscreen button uses native video fullscreen, which has Apple's controls; text subtitles use native captions there and other subtitle formats need Burn-in.

Owner-approved 2026-11-07: a quality change between stream types keeps the current stream playing until the new one is ready, and the last frame stays on screen through the swap.

Owner-approved 2026-11-07: automatic fallback keeps the viewer's selected quality in the quality controls. While active, show “Using fallback · <height>p · <Mbps> Mbps” as status in the sliding quality menu and player settings, and FB on the settings badge. Use the shared short toast “Switched to fallback to keep playing.”, with “Using default audio.” when the audio differs, and “Returned to your selected quality.” on return. Fallback is a delivery status, not a selectable quality. Preserve client-rendered subtitles; do not offer an uncaptioned fallback when subtitles require Burn-in. Joins and reconnects use the same status and return path.

Owner-approved 2026-11-07: in fullscreen, errors never open the drawer. They show as the shared error toast with one action: the fix when there is a direct one, otherwise Open menu, which opens the drawer over fullscreen. Outside fullscreen the error line stays in the menu; the Discord Activity still opens the menu. After a reconnect or reload, quality, volume, subtitles (language and Burn-in) and audio language come back from the viewer's saved choices; fullscreen is re-entered by the viewer.

Owner-approved 2026-11-07: hosts get a Video check in Player settings under Media information, listing the server's file and Plex checks most serious first (problem, warning, information, fine) with an icon each, and a quiet Check again button. When a check finds a problem or warning, hosts get one two-line action toast per video with View, which opens Player settings at the check. Viewers never see it.

Owner-approved 2026-11-07: hosts see viewer health. In the room roster, a guest's sync icon becomes `alert-triangle` while they have an issue (warning color; danger for a player error), held 15 seconds after it clears. Their telemetry card adds one issue line and a details list: quality and format, buffered seconds, stalls in the last minute, dropped frames, sync offset, reconnects and device. Only hosts receive these details. Issues and limits are defined once in the shared sync core: error; 2 stalls or 3 seconds stuck per minute; under 2 seconds buffered while playing; 10% dropped frames; Poor sync.

Owner-approved 2026-11-07: Copy diagnostic report is a quiet button with the `copy` icon inside Technical details in the player settings Media information section, with a one-line hint. It copies a recent player report and confirms with the shared toast; if the clipboard is blocked, the toast says so and the report downloads as a file. When the server keeps diagnostics, its hint adds how many days they are kept; there is no separate privacy notice.

Owner-approved 2026-11-07: the watch page declares `darkreader-lock` so Dark Reader cannot recolour the subtitle outline. uburoom has its own dark and light themes.

Owner-approved 2026-11-06: text subtitles draw in their own layer over the player, not as browser cues. They default to a solid VLC-style outline (labelled Shadow), scale with the player through Small, Medium and Large, and stay on the visible picture unless Text position is On player. They remain visible when controls hide and lift only when the controls would cover them. ASS and bitmap subtitles keep their authored placement.

Owner-approved 2026-11-07: room URLs use clean path slugs (`/room/<slug>`) instead of query parameters (`/watch?room=<id>`). The default room name format "Room <UbumfaWord>" generates a single-word slug (`<ubumfa-word>`), while custom room names generate hyphenated alphanumeric slugs with numeric suffixes for collisions (`slug-2`). Clearing or resetting a custom name reverts to the room's original assigned ubumfa word and slug. Single-room mode and the multi-room lobby live at root (`/`), and `/watch` redirects to `/` or the room slug.

Owner-approved 2026-11-07: guest passes. Room settings get a Guests tab beside People, shown only to people who may issue passes in that room. It creates passes (lifetime as a segmented selector capped by the server, a use count, and a pending checkbox for "Guests must sign in", forced on when the server requires it) and lists the room's passes with who made them, uses, expiry and status. A pass's link is shown once, with a Copy button, right after it is made, because only a hash is kept. Each live pass has an On/Off switch (off stops new entries; guests already in stay) and a Revoke danger button (ends it and removes its guests). A pass link opens a join screen: a Name field pre-filled with a random ubunym, an `arrows-shuffle` icon button that rolls a new one, a Join button and, when the server allows it, Discord and Plex sign-in. Sign-in-only passes show just the sign-in buttons. In the roster, guests whose name is not verified show their name in italics with the `user-question` icon in place of the participant icon, and their name's tooltip and accessible label say "Guest (name not verified)". People in a room through a pass are never offered Make host, and the Account dialog offers guests no Connect buttons.
