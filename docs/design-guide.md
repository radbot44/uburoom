# UI design guide

Use established components, styles and interactions. Follow [AGENTS.md](../AGENTS.md#authority-and-workflow) for approval thresholds and rendered review. This guide records reusable rules and exceptions. It does not restate values: sizes, colours, radii, layers and spacing live in the token file [`web/styles/tokens.css`](../web/styles/tokens.css) and the component stylesheets in [`web/styles/`](../web/styles/), and the development gallery (`/__dev/gallery`, demo mode) shows every shared control in both themes. Feature-specific approved interaction choices are collected in [screen behavior](ui-behavior.md); code and tests remain the source for implementation details.

## 1. Principles

- **Safe DOM creation:** Build markup and icons with `createElement`, `createElementNS` and `textContent`. Never use `innerHTML`, `outerHTML` or `insertAdjacentHTML`. Icons come from the repository's own icon set and keep their accessible attributes.
- **People vocabulary:** People in a room are **Viewers** (roster heading, the Room settings section, counts and removal messages); **Hosts** is the role. The non-host role is labelled Viewer in permission tables. Never use "Participants", "Roomies" or "People" for people in a room.
- **Terse copy:** Leave access-policy, server-audience and room-lifecycle explanations out of forms. Prefer short action labels and truthful status or error text. Explain implementation only when it helps someone take a concrete action.
- **Motion:** Respect reduced motion. Hover and press change colour or surface, never scale or position.
- **Focus:** One focus ring everywhere, drawn by the shared focus style; never remove it without a replacement.
- **Labels:** Text labels may wrap to two lines; compact labels stay on one. Adapt labels to the available width while keeping their accessible names.
- **Themes:** Dark and light themes both carry full contrast; never rely on colour alone. High-contrast and forced-colours modes preserve control boundaries, active selection, switch states, and brand legibility without relying on background fill alone. The watch page opts out of third-party dark-mode extensions so they cannot recolour subtitles, player controls or the palette.
- **Tokens only:** Stylesheets use tokens, never literal font sizes, radii, layers, colours or pixel spacing. A new value is added to the token file first. Spacing, radius and alpha tokens are named by value; consolidating near-duplicates is a separate owner decision.
- **Type scale:** Text uses the scale steps only; a size between two steps takes the larger. Exceptions: viewer-chosen subtitle size, the player quality badge and the handoff code.
- **Layout and state in CSS:** Components style by class, keep IDs as scripting hooks, and read state from data attributes the store sets. The phone layout is one breakpoint, defined in `web/watch/breakpoints.js` and exposed as `body[data-layout]`. Positioned menus and popovers receive coordinates as custom properties; script never writes other geometry.
- **Cascade:** Stylesheets sit in the layers vendor, tokens, base, components, layout, exceptions. Overrides go in the exceptions layer, never through `!important`.

## 2. Controls

| Intent | Control |
| --- | --- |
| Action | Button |
| Live boolean setting | Switch |
| Pending form choice | Native checkbox |
| Short value selection | Segmented selector |
| Change panel | Tabs |
| Long or dynamic choices, and mobile video settings | Native dropdown |
| Permission | Allowed/Denied thumbs |
| Mute, Captions, Theater | Pressed icon button |

Keep action, selection, navigation and status distinct. Reuse established exceptions, such as the compact Admin and privacy controls, rather than forcing every boolean into a switch.

- **Switch pill:** the compact switch for toolbars where a full switch row does not fit, made by the one shared helper (`switchPill()`). State shows in the switch alone; hover changes the surface; disabled dims the whole pill and gives the reason as tooltip; read-only shows the switch at full strength without hover; focus rings the whole pill.
- **Targets:** every interactive control is at least the shared minimum target size, and sign-in actions use the larger entry size. Approved exceptions: the viewer sync badge in the roster; the compact account-bar identity, Admin mode, library filter chip and toast action controls; and inline titles and row action buttons on queue timeline rows. Range sliders keep their slim visual track inside a full-height hit area.
- **Shared classes:** primary, quiet, icon, destructive and title-bar buttons; the standard control, switch row, form checkbox, dialog footer and panel header. Use these instead of recreating their sizing in feature CSS; the gallery shows each.
- **Accents:** the primary accent (orange) marks primary actions, active states and Now Playing. The secondary accent (pink) is reserved for auto-queue and continuation offers.

### Typography

- Body and controls use Inter, shipped with the app so text wraps the same on every machine (provenance in [third-party notices](third-party.md)).
- Major headings, dialog headings and sidebar panel headings use Uburoom Sans at its natural weight only: never faux bold, no discretionary ligatures, no Color edition.

## 3. Dialogs

Shared modal dialogs have a semantic header containing a heading, and follow one of two archetypes.

- **Small prompts and confirmations** (browser sign-in approval, account removal, room change): no close button; a footer with Cancel (quiet) on the left and the action (primary or destructive) on the right.
- **Workspaces and settings** (player settings, account, rooms, room settings): a close button at the top right that takes initial focus. A Cancel button appears only when paired with an active counterpart (Submit, Create, Save, Schedule); browsing views have no footer and close from the header.
  - Player settings groups related controls in two columns on wide screens and stacks them in reading order on narrow ones.
  - The account dialog keeps Log out in a divided footer below the scrolling body.
  - The rooms dialog shows its footer (Cancel; Create room and Settings) only in New room mode.
  - Room settings uses section tabs that wrap onto a second row at phone width so every tab stays visible.
- **Share:** a small-width workspace covering the invite and the Discord room post only (scheduling has its own dialog). The invite bar has a read-only link without the scheme (clicking copies the full link), Copy and native Share. The Discord preview shows the channel, the post card and its status; unpublished rooms offer Publish now, published rooms View Discord post and Remove post.

### Watch nights

See [approved screen behavior](ui-behavior.md#watch-nights) for this feature's accepted interactions and states.

## 4. Panels and navigation

- **Section headings:** each panel heading has a solid primary-accent badge with dark artwork (Room `armchair-2`, Queue `player-track-next`, Media `video`), with the minimize chevron right after the title. When the room name and the header actions do not fit on one line, the actions wrap below and the name keeps the first line, truncating only beyond it.
- **Room panel:** header actions, the viewer list and the room buttons; no permission controls (those are in Room settings → Permissions only). An action the person cannot use is shown disabled with its reason as tooltip; actions the server does not offer at all stay hidden.
- **Queue header:** the first row holds the title and Queue settings (in a room only); panel header actions share the grey `watch-header-control` style. The second row holds the Auto-play and Auto-queue switch pills, then Center Now Playing. Pill labels are never dropped: pills wrap, and Center Now Playing drops to its icon when the queue is narrow.
- **Room URLs:** rooms use path slugs (`/room/<slug>`). The default name "Room <word>" gives a one-word slug; custom names give hyphenated slugs with numeric suffixes for collisions. Single-room mode and the lobby live at the root, and `/watch` redirects there or to the active room. An authorized room link renders straight into the room with no lobby flash; signed-out visits show sign-in and keep the destination; closed event rooms show Waiting for host.

## 5. States and playback

### Control states

- Disabled: the whole control dimmed and inert.
- Unavailable with a status: no background, a readable reason, focusable and `aria-disabled`.
- Available but ineffectual: normal background, dimmed icon, no hover or action.
- Loading: keep the geometry, dim the control, show the shared spinner, and prevent duplicate actions.
- Asynchronous previews track request generation and input snapshots: superseded responses are discarded without clearing drafts, duplicate requests are prevented, and confirmation checks the accepted snapshot.
- Keep selected, focused, disabled and read-only distinct. Pending work must not disable unrelated controls. Preserve focus and scroll across updates and keep revealed content below sticky headers.
- Switch rows keep the label left and the switch right; text wraps without moving the switch, and the real state shows even when disabled.
- Segmented selectors: arrows, Home and End move focus; Enter and Space select. Tabs activate on arrow. Selection never triggers a separate destructive or transfer action.

### Player

- **Center overlay:** toggles play and pause on hover for people who may manage playback, and is hidden whenever it would do nothing.
- **Personal toggles:** Mute, Captions, Picture-in-Picture and Theater report their state with `aria-pressed` and keep action labels.
- **Desktop fullscreen idle:** with the mouse at rest during playback, controls and pointer hide; they stay while paused, over player chrome, or with a menu or drawer open.
- **Phone transport:** the bar keeps Play, Previous, Next, Subtitles, Volume, Player settings and Fullscreen. Notifications and Picture-in-Picture move into a Player group in Player settings, shown only in the phone layout and mirroring the bar controls. Theater is not offered. In the lobby the bar also shows the settings gear, whose dialog then holds only the Notifications switch.
- **Phone volume:** the speaker button alone, its icon showing the level. Tapping opens a vertical slider with mute at the bottom, closing after a few seconds idle once keyboard focus leaves it, on outside tap and on Escape. Browsers that ignore page-set volume (iOS Safari) never show a slider; the button mutes directly.
- **iPhone fullscreen:** uses native video fullscreen with system controls; text subtitles become native captions and other formats need Burn-in.
- **Discord Rich Presence:** a live Switch in Player settings beside Plex reporting, shown only inside a Discord Activity when enabled by server config, and off by default. Private rooms show generic "Watching in uburoom" without the media title or room name.

### Quality and delivery

See [approved screen behavior](ui-behavior.md#quality-and-delivery) for this feature's accepted interactions and states.

### Subtitles and audio

See [approved screen behavior](ui-behavior.md#subtitles-and-audio) for this feature's accepted interactions and states.

### Picture-in-Picture

See [approved screen behavior](ui-behavior.md#picture-in-picture) for this feature's accepted interactions and states.

### Queue and auto-queue

See [approved screen behavior](ui-behavior.md#queue-and-auto-queue) for this feature's accepted interactions and states.

### Viewers

See [approved screen behavior](ui-behavior.md#viewers) for this feature's accepted interactions and states.

### Library and ending

See [approved screen behavior](ui-behavior.md#library-and-ending) for this feature's accepted interactions and states.

## 6. Feedback

### Which feedback to use

- **Anchored popovers — default for direct actions:** feedback for something the person just did (buttons, switch pills, copying, queue additions, inline saves) is a popover tethered to the control. No toasts or inline hint lines for direct actions.
- **Toasts — global, asynchronous or actionable events:** room-wide updates (joins, leaves, reconnecting), system and playback alerts, two-line prompts with actions (video check View, Pause to wait, Lower quality), and keyboard actions with no anchor.
- **Inline status — dialogs and static forms only:** where dedicated, non-shifting space exists. Never in dynamic panels or toolbars where it displaces controls.

### Toasts

Reuse the shared toast system and its placement, dismissal, timing and keyboard behaviour. Errors stay visible when notifications are muted; uncertain status never appears verified.

- **Two-line action toasts:** message first, compact action and Dismiss second. Deliberate dismissal suppresses repeats for the session.
- **Fullscreen errors:** never open the drawer; they show as the error toast with one action, the direct fix or "Open menu". Outside fullscreen the error line stays in the menu.
- **Preference recovery:** after a reconnect or reload, quality, volume, subtitles and audio language restore from saved preferences; fullscreen is re-entered by the viewer.

### Anchored popovers

The shared popover is a single-line capsule with a status icon and a caret pointing at its trigger, placed above or below and clamped to the viewport, on a solid card surface. Success uses the success colour, loading the shared spinner, and errors the danger surface matching the error toast. It auto-dismisses after a moment or on outside click or scroll, announces politely to assistive technology, and respects reduced motion.

### Subtitle loading

Loading and catch-up show a delayed spinner over the subtitle button, without a toast, and the button stays usable so subtitles can be turned off. A failed or unauthorized window never clears its error as if covered; subtitle recovery stays independent of video playback.

### Buffering and outages

- **Buffering notice:** buffering never pauses healthy viewers. After a few seconds of a remote viewer's sustained buffering, people who may manage playback get a toast with Pause to wait, and later one with Resume playback when that viewer is ready. Dismissal suppresses repeats for that viewer until they recover.
- **Degradation warnings:** the choppy playback toast with Lower quality fires once per episode and rearms only after healthy playback. Dismissal lasts for the viewing session and survives stream replacement, resetting on new media, room or exit.
- **Outages:** a media server outage (Plex, Jellyfin or another provider) stays silent while buffered playback covers it. If anyone is affected, everyone sees one shared "Media server connection problem" toast after a short delay, clearing once nobody is. Never say "room ended" for a server or provider outage.

### Video check and diagnostics

- **Delivery line:** Media information names how the stream reaches the viewer: "Original file", "Original picture, converted sound" (the picture copied and only the audio converted, by the media server or by uburoom), "Media server conversion", or "uburoom conversion".
- **Video check:** hosts get it in Player settings under Media information, listing file checks, and Plex checks for a video Plex serves, most serious first with an icon each and Check again. A problem or warning gives one action toast per video with View. Viewers never see it.
- **Diagnostic report:** "Copy diagnostic report" in Technical details copies a recent report and confirms with a popover, downloading a file if the clipboard is blocked. When the server keeps diagnostics, the hint states for how long.

## 7. Review and maintenance

Inspect affected controls in both themes, narrow layouts, 200% zoom and keyboard use. Automated checks and screenshots do not replace owner acceptance.

Add a rule here only when it guides future design or records a necessary exception. Do not restate values or selectors that a stylesheet already holds, and do not append feature labels, roster layouts, scoring formulas, preference inventories, timings or refactoring history owned by an established system.
