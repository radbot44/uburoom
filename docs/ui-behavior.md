# Approved screen behavior

This reference holds owner-approved, feature-specific UI decisions moved from the [design guide](design-guide.md). Consult only the relevant section for the surface being changed. These decisions are not permission to redesign unrelated surfaces; common controls, tokens, focus, layout and feedback principles remain in the design guide.

## Watch nights

A watch night is a room with a time on it: every event belongs to one saved room, and choosing media stays in the room's queue, never in the scheduler.

- **Entry points:** the lobby room bar shows Schedule between Reopen room and New room; inside a room, a calendar button beside Share opens the same scheduler for that room. Only people who can schedule there see them (the server's scheduler tier, and hosting for the room button); nobody else sees a disabled one, and guests never do.
- **Scheduler:** one workspace dialog for both entry points and for editing. Its first row is Room, defaulting to New room (named after the event) and listing rooms the person hosts; single-room mode has no Room row. Then title (with counter), start time chips (next half-hour, tonight, tomorrow), date and 15-minute time dropdowns with a collapsible time zone, duration pills with a calculated end time, and Post to Discord (on by default when Discord is configured, hidden otherwise). Footer: Cancel and Schedule (Save when editing).
- **Scheduler feedback:** submitting shows a loading popover, then any error popover, on the Schedule button. On success the dialog closes and the success popover anchors to the control that opened it. The inline status line is only for persistent messages no click caused, such as a failed load.
- **Lobby Upcoming:** above the room list, the next three events the person can see (an event follows its room's visibility), with More for the rest, expanding in place. Rows look like the active-room rows with a calendar icon and "time · room · N interested". From start to end the card reads Starting now with Join as its main, primary action; at the end it leaves the list.
- **Card actions:** Join when the room is open; when closed, hosts get Open room and others see "Waiting for host". Hosts also get Edit, Copy invite and Cancel (with confirmation). A canceled event's confirmation anchors to the lobby Schedule button because the card leaves the list.
- **Lobby order:** the button row comes first under the intro, then the error line, Upcoming, and the active rooms, which scroll beneath when the video area is short.
- **Waiting for host:** a closed room's invite with a watch night shows the start time and "Waiting for host" until a host opens it; uburoom never opens it automatically.

## Quality and delivery

- **Original versus converted:** Original means untouched source media. When Original is selected but the output is converted, the option reads Maximum with the output codec and the badge reads `MAX`. Subtitles burned in without being chosen read "Automatic (burned in)" with a status line.
- **Automatic fallback:** keeps the viewer's selected quality in the controls and shows "Using fallback · <height>p · <Mbps> Mbps" as status with an `FB` badge. Toasts announce switching to fallback and returning. Fallback is a delivery status, not a selectable quality.
- **Stream swaps:** a quality change keeps the current stream playing, and its last frame on screen, until the new one is ready.

## Subtitles and audio

- **Sliding menu:** desktop player settings use one sliding menu: arrows open choices in place, final choices and `Tab` close it, and Back stays below the scrolling choices. The timeline shows chapter breaks with title and time on hover. Skip intro and Skip credits appear only for people who may manage playback.
- **Naming:** the rendering option is **Burn-in**; help and error text never names a provider.
- **Appearance:** text subtitles draw in their own layer, default to the outline style labelled Shadow, scale with the player (Small, Medium, Large), stay on the visible picture unless set to "On player", remain when controls hide, and lift only when controls would cover them. ASS and bitmap subtitles keep their authored placement. Settings offer colour presets, a hex input, a swatch, a background style selector (Off, Background, Shadow) and a brightness slider.
- **Audio mode:** Normal, Dialogue or Night, with hints; entirely in the browser, affecting no one else.
- **Subtitle sync:** Player settings provides `−0.5 s`, a numeric input (`±30 s`, `0.1 s` step), `+0.5 s` and `Reset`, saved client-side per media item and track, with a "Subtitle sync" link from the desktop player settings menu. Keyboard adjustments (`G`, `H`, `\`) show a single coalesced toast; **Burn-in** disables the offset controls while preserving the saved non-burn offset.

## Picture-in-Picture

- The button sits beside Theater and Fullscreen (in Player settings on phones) and answers the `P` key.
- Where Document Picture-in-Picture exists, the whole stage moves into the floating window with its controls, skip overlays and subtitle layers, and the page shows a placeholder with Return video.
- Elsewhere it falls back to native video Picture-in-Picture; with client-drawn subtitles active, a toast suggests Burn-in to keep subtitles.

## Queue and auto-queue

- **Outside a room:** the Queue panel stays, reading "The queue lives in a room" with one line of explanation and Browse media, and no room buttons. Inside a room an empty queue reads "The queue is empty" with Browse media.
- **One layout:** a single scrolling list of history, Now Playing and Upcoming; no card view or layout selector.
- **Rows:** in the dark theme rows sit on a darkened blur of their artwork; in the light theme they use ordinary surfaces with the Now Playing tint and no artwork.
- **Scroll buttons:** "N past" and "N queued" float in strips above and below the list so neither covers a row; "N past" and its strip exist only with history.
- **No history:** a single "No playback history yet." line followed directly by Now Playing, starting at the top.
- **Now Playing:** keeps the primary-accent outline rather than a transient selected state.
- **Auto-queue preview:** at most one preview row at the end of Upcoming, in the secondary accent with an `AUTO` badge and "Auto · Up in …" caption, offering Add to queue, Skip suggestion, Play now and Skip to, with no reorder arrows.
- **Auto-queue options:** four modes (Off, Continue, In order, Shuffle) and its switches use the secondary accent. In Media views the source action reads "Set as auto-queue" with the `sparkle` icon in the secondary accent.
- **Media suggestions (queue):** pending suggestions sit between Now Playing and Upcoming as one collapsed row (`bulb` icon, "N suggestions", chevron), absent when there are none and never a header badge or popup. Expanded, each is a queue-style row ranked by agreement then age, captioned "Suggested by Name +N": the top actions are the agree toggle (`bulb` with the count, filled while you agree) and Dismiss; the bottom actions are Add to queue and Play now. Buttons a person lacks permission for stay visible but disabled, as on queue rows.

## Viewers

- **Telemetry cards:** sync badges in the roster are buttons opening an anchored viewer card (interactive in fullscreen; closing it leaves the drawer open). The card shows name, role, playback status, sync score and level, confidence, a plain-language explanation, freshness and per-device breakdown, and dismisses on Escape, outside click or close.
- **Health alerts:** a guest's sync icon becomes `alert-triangle` while they have an issue (warning, or danger for a player error), held briefly after it clears. Their card adds an issue line and host-only details. Issues and limits are defined once in sync core.
- **Sync spread:** people who can change room settings see the room's viewer spread at the end of the Viewers heading, as "Spread 18 ms · p95 42 ms", once the video has a minute of samples. Its tooltip says it is reported by the players themselves and leaves out screen and speaker delay. Other viewers never see it.
- **Roles and guests:** the host badge uses ordinary text colour for contrast in both themes; the room leader keeps the accent. Unverified guests show their name in italics with `user-question` and the label "Guest (name not verified)". Guests are never offered Make host, and the Account dialog offers them no Connect buttons.
- **Account providers:** Connect <Provider> when unlinked, Sign in to <Provider> when awaiting credentials, Reconnect when connected. Unlink is separate and disabled when removing it would leave no usable sign-in.
- **Human readiness check:** people who can control playback start or cancel it from a `help` icon button at the end of the Viewers heading; it never adds rows or controls to the Room panel beyond an answer icon (`check` or `clock`) beside each name. Answering happens on one stage card in the readiness-choice style ("Ready to play?", "1 of 2 ready · Waiting for Name", then "Everyone is ready"): viewers get Ready and Need a moment, people who can play get Play and Cancel. Play never starts by itself. The room's own readiness choices and recovery take precedence over the card; it auto-expires after 120 s, clears on Play and never touches decoder readiness or playback consent.

## Library and ending

- **Watched progress:** cards and details artwork show a primary-accent progress bar along the bottom of the poster when progress is actionable (between 10 seconds and 92%), preferring the room's history over personal Plex progress. In details, Play now stays on top with Resume at MM:SS below it. Editions and versions appear separately labelled, with an Other editions section in details.
- **Local libraries:** each configured local library is one more card on Libraries home, after the Plex libraries, using the existing home card and the `film` icon. It opens one title-sorted list of every video in the folder, with the subfolder as the subtitle line, and has no Collections card, filters, artwork or auto-queue source.
- **Jellyfin libraries:** each movie or show library of the configured Jellyfin user is one more card on Libraries home, after the Plex libraries, using the existing home card. Shows, seasons, posters, genre and year filters, sorting and auto-queue sources behave as they do for Plex; there is no Collections card.
- **Ending interstitial:** when a video ends, the occurrence completes to history and unloads, and the ending screen takes the stage with dimmed artwork, a center play button (with a countdown ring during autoplay), a short summary, Watch again and Browse media. The plain empty stage appears only with no current video, history or upcoming item. Play there selects the queued successor; restart stays a separate action.
- **Media suggestions (library):** in cards and posters views everyone who can suggest gets a top-left `bulb` button, alongside top-right Add to queue for people who can add directly. A suggested video's bulb stays lit without hovering and shows the agreement count once more than one person agrees; clicking it suggests, agrees or stops agreeing, and the last person to stop removes the suggestion. There is no "Suggested" badge.
