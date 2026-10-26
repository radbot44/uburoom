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

Classes: `.primary` for primary actions, `.quiet` for secondary, `.icon-button` for icon actions, `.danger-button` for destructive, `.solid-button` for player title-bar controls only. Primary accent is orange (`var(--primary)`) and secondary accent is pink (`var(--secondary)`); `var(--secondary)` is the designated accent color for auto-queue and continuation offers. Owner approved 2026-10-26.

## States and interaction

- Disabled actions: entire control at 40%, inert.
- Unavailable actions carrying status: no background, readable reason, focusable `aria-disabled`, inert.
- Available but ineffectual: normal background, icon at 40%, no hover/action.
- Loading: preserve geometry, dim original control, use the shared white spinner and prevent duplicate action.
- Asynchronous preview actions (such as account match preview) track request generation and normalized input snapshots. Responses for superseded inputs or closed contexts are discarded without clearing draft inputs, duplicate requests while in flight are prevented, and confirmation actions validate against the accepted input snapshot.
- When a video ends (naturally or via explicit endpoint seek), the occurrence is completed to history and unloaded, and the full-stage ending interstitial takes over the player with dimmed/blurred artwork, a center play button (with a countdown ring during autoplay countdowns), up to three lines of episode summary, Watch again, and Browse media. Plain `#empty-stage` is shown only when a room has no current video, no history, and no upcoming queue/auto-queue item. Play at a finished occurrence selects the queued successor under existing video-selection authorization or play/pause when idle; restart remains an explicit separate action. Owner approved 2026-10-23, updated 2026-10-26.
- Auto-queue maintains at most one preview card (`autoQueue.next`) at the tail of Upcoming, styled with `var(--secondary)` border/accent, an `AUTO` rank badge (`Auto-queue` / `Auto · Up in …` caption), and dedicated actions (Add to queue, Skip suggestion, Play now, Skip to) with no reorder arrows. Queue settings offer four auto-queue modes (`Off`, `Continue`, `In order`, `Shuffle`). Owner approved 2026-10-25.
- Account provider rows present actionable connect and reconnect controls based on identity state: when unlinked, display Connect <Provider>; when linked but awaiting sign-in or credentials, display Sign in to <Provider>; when connected, provide a secondary Reconnect action to refresh credentials without requiring unlinking. Destruction (unlink/remove) remains separate and disabled whenever removing the identity would leave no enabled, usable sign-in method.
- Host role badge and icon use theme-aware text (`var(--text)`), maintaining high contrast against both dark and light surfaces while room leader retains accent coloring. Active library filter labels use theme-aware accent text (`var(--accent-text)`).
- Player controls and queue controls maintain a minimum 40×40px interactive hit box across responsive viewports while preserving their distinct visual icon artwork sizes, position, and responsive wrapping.
- Personal playback toggles (Mute, Captions, Theater) use `aria-pressed` reflecting authoritative local state (`aria-pressed="true"` when active/muted) while retaining action labels, title cues, and volume state presentation.
- The circular center player overlay toggles play/pause on hover for viewers authorized to manage playback, but remains hidden whenever disabled (for unauthorized viewers, spectators, or while commands are pending) so no faint or ineffectual overlay obscures video playback. Owner approved 2026-10-25.
- Desktop player settings use one sliding menu: right-facing arrows open choices in place, final selections close it, and Back remains below the independently scrolling choices. Respect reduced motion. Quality changes do not show player notifications; Original includes the source bitrate rounded to whole Mbps when known. Owner requested 2026-10-23.
- The full player settings dialog groups related controls in two columns on wide screens, keeping subtitle selection, rendering and timing together. Media information comes last; narrow screens stack groups in reading order. Owner requested 2026-10-23.
- Keep selected, focused, disabled and read-only distinct; do not rely on color alone. Pending work must not disable unrelated controls.
- Server settings reuse the shared dialog, tabs, pending checkboxes and permission thumbs. Explicit Cancel/Close discards its draft; Escape/backdrop preserve dirty drafts. Conflicts retain edits and require inline choices for overlapping changes before saving. Routine design/implementation delegated by the owner, 2026-10-24.
- Switch labels stay left and switches right; wrap text without shrinking or moving the switch. Show the actual checked state even when disabled.
- Segmented arrows/Home/End move focus; Enter/Space selects. Tab arrows activate immediately. Selection alone must not trigger a separate destructive or transfer action.
- Adapt labels to available control width while retaining accessible names. Preserve focus and scroll during asynchronous updates; keep revealed content below sticky headers.

## Reuse and feedback

Reuse the shared toast, dialog, menu, permission and status systems. Preserve their established placement, dismissal, timing, keyboard and error behavior instead of adding feature-specific variants. Errors must remain visible when ordinary notifications are muted; uncertain status must not appear verified. Toasts with interactive actions use a container element sharing `.watch-toast` styling; two-line action toasts present the message on the first line and compact action and Dismiss buttons on the second line. Deliberate dismissal suppresses repeat warnings for the session. Subtitle loading and progressive subtitle catch-up surface a delayed (`250ms`) top-right toast with the `subtitles` icon, `"Loading subtitles..."`, and no spinner until subtitles are ready at the active playback timestamp. Owner approved 2026-10-25, updated 2026-10-26.

Keep existing draft/save/cancel boundaries explicit and report failures truthfully. Preserve independent personal preferences and shared room authority. Put technical details in existing diagnostics surfaces, never credentials or private playback URLs.

## Review and maintenance

Inspect affected controls across themes (light and dark), narrow layouts, 200% zoom and keyboard use. Automated checks and screenshots do not replace owner acceptance.

Add a rule here only when it guides future design or records a necessary exception. Do not append feature labels, roster layouts, scoring formulas, preference inventories, toast timings or implementation history already owned by an established system.
