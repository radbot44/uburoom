# uburoom — UI Controls Design Guide

Use this guide when creating or updating buttons, switches, checkboxes, and selection controls in **Watch**. Reuse the existing component styles instead of inventing a new look for each screen.

## 1. Pick the right control

| You need to… | Use… | Example |
|---|---|---|
| Perform an action | **Button** | Create room, Cancel, Refresh |
| Turn an existing setting on/off | **Switch** | Auto-play, Auto-queue |
| Include an option in a form being submitted later | **Checkbox** | Include Specials, Keep room when empty while creating a room |
| Choose one of 2–3 short values or layouts | **Segmented selector** | Cards / List, Public / Private, Off / Following / Random |
| Move between actual panels | **Tabs** | Room / Queue / Media; Room Settings sections |
| Choose from a long or dynamic list | **Dropdown** | Sort, genre, year, audio track |
| Show a permission | **Thumb icon button** | Allowed / Denied |
| Toggle a media viewing mode | **Pressed-state icon button** | Mute, Captions, Theater |

**Do not make everything a switch.** A form choice, navigation tab, permission, and live setting should look different.

## 2. Shared sizing and styling

| Item | Make it like this |
|---|---|
| Normal text button | **40px minimum height**, **12px radius** |
| Prominent sign-in/entry button | **44px minimum height** |
| Icon-only button | **40 × 40px minimum clickable area**, **10px radius** |
| Standalone button icon | **24 × 24px** artwork |
| Icon beside text | **20 × 20px** artwork |
| Normal button label | **14px** |
| Compact button label | **12px** |
| Primary/destructive label | **600 (semibold)** |
| Secondary label | **500 (medium)** |
| Horizontal button padding | **16px** normal; **12px** compact |
| Space between icon and label | **8px** normal; **6px** compact |
| Space between adjacent icon buttons | **4px** |
| Keyboard focus | Visible **2px outline, 2px offset** |

Use theme-aware colors and existing design tokens. Check the result in **Light/Dark × Orange/Pink**. The visible artwork may be smaller than its clickable area.

## 3. Buttons

### Choose a button style

| Style | Existing class | Appearance | Use it for |
|---|---|---|---|
| **Primary** | `.primary` | Filled accent surface, semibold text | One main action in a context: **Create room**, **Save** |
| **Secondary** | `.quiet` | Elevated, quieter surface, medium text | **Cancel**, **Browse**, routine actions |
| **Icon-only** | `.icon-button` | Elevated square-ish surface, icon centered | **Refresh**, header and toolbar actions |
| **Destructive** | `.danger-button` | Red filled surface, semibold text | Irreversible destructive actions |
| **Player title-bar** | `.solid-button` | Solid, readable against video gradient | Player title-bar controls only |

Keep the main video **Play** overlay circular. Use the project's Tabler outline icons; icon-only buttons need an accessible name and a helpful tooltip/title.

Example markup using the existing styles:

```html
<button class="primary">Create room</button>
<button class="quiet">Cancel</button>
<button class="icon-button" aria-label="Refresh" title="Refresh">
  <!-- project Refresh icon -->
</button>
```

### Button states

| State | What it should look like |
|---|---|
| **Hover** | Slight surface or text-color change; **no scaling or movement** |
| **Pressed** | Temporarily deepen the background; **no scaling or movement** |
| **Focused** | 2px visible outline, 2px offset |
| **Disabled action** | Entire button at **40% opacity**; cannot activate |
| **Unavailable action that also shows a status** | No button background; icon/text and status stay fully readable; focusable with `aria-disabled="true"` and a reason, but cannot activate |
| **Available but ineffectual** | Normal button background; **only icon at 40% opacity**; no hover feedback or action (e.g., Back at first page) |
| **Loading** | Original button at **40% opacity**, with centered, fully opaque **white Tabler `loader-2`** spinner over it; same size as before loading |

Keep disabled, unavailable, ineffectual, and loading distinct. A loading action must not be submitted twice.

### Button layouts

- Normal text labels can wrap to **two lines**; compact labels stay on one line.
- Use natural-width buttons on desktop. On narrow screens, major form/dialog actions may stack full-width when necessary.
- Keep toolbar icon groups compact, with **4px** between adjacent icon actions.

## 4. Switches and checkboxes

### Live switches

A standard setting row looks like this:

```text
Auto-play                                      [○──]
Play the next item automatically
```

Keep the **label and optional description on the left**, and the **switch on the right**. Align the switch with the text block. When the screen gets narrow, **wrap the text** and let the row grow; never move the switch under the label or shrink it.

| Switch piece | Size |
|---|---|
| Track | **36 × 22px** |
| Track radius | **11px** (pill) |
| Thumb | **16 × 16px** |
| Thumb inset | **3px** from either end |
| Thumb movement | **14px** |
| Row height | **44px minimum** |
| Click/touch target | Aim for **44 × 44px**, even though the track is smaller |

- **Off:** thumb left, neutral track.
- **On:** thumb right, accent-colored track (`--primary`).
- **Disabled:** show the actual On/Off position, but subdued and clearly noninteractive.
- **Focus:** 2px ring with 2px offset. **Motion:** about **150ms**, disabled when reduced motion is preferred.
- **Header Theme and Accent controls:** use the same switch geometry, within their compact header positions.

Use a stable control name and accurate checked state (`role="switch"` / `aria-checked`, or equivalent native semantics).

### Form checkboxes

Use a **square native checkbox** for options chosen as part of a pending form, not a sliding switch. Place it next to its label and make checked/unchecked obvious.

Examples: **Include Specials** in Add Episodes or Auto-queue setup; **Keep room when empty** during Create Room. That same Keep-empty setting in an **existing** room uses a switch.

## 5. Segmented selectors, tabs, and dropdowns

### Segmented selectors — choose a value, not a page

Make the whole control **40px tall**. Use two visual strengths:

- **Prominent selected state:** layout/view controls such as Queue **Cards / List** and Media **Cards / List / Posters**.
- **Subtle selected state:** setting values such as **Public / Private**, permission presets, and **Off / Following / Random**.

Show icon **and** text when they fit. Hide the text based on the **control's available space**, not only the viewport width; icon-only choices must retain complete accessible names.

**Keyboard:** Arrow keys and Home/End move **focus only**. **Enter/Space** selects the focused option. Focus and selection must look different.

For permission presets, show **only actionable named presets**—**no Custom tab**. If settings match none of them, it's fine for **none** to appear selected.

### Tabs — move between panels

Use actual tabs for mobile **Room / Queue / Media** and the Room Settings sections (**General, People, Permissions, Playback & Queue, Manage**).

- A selected tab has a restrained surface treatment. Room Settings adds an **accent vertical rail** on desktop or **accent underline** on mobile.
- **Arrow keys activate the new panel immediately** (unlike segmented selectors).
- Room Settings uses **Up/Down** on desktop's vertical tabs; **Left/Right** on mobile's horizontal tabs.
- Keep focus, selected tab, and visible panel in sync. Use `tablist`, `tab`, and `tabpanel` semantics.

### Navigation and dropdowns

- **Media library names** are subnavigation, not segmented choices. Mark the current library with `aria-current`. Hide this subnavigation in the existing narrow Media container layout (around **440px**), while leaving other navigation available.
- Use native dropdowns for **long or dynamic** lists and for video settings on mobile; desktop video settings can keep nested menus.
- Show known-but-unavailable fixed options as **disabled with a readable reason**. Don't invent unavailable audio/subtitle tracks that aren't present in the data.
- For leadership transfer: **2–3 eligible hosts → segmented selector; 4+ → labeled dropdown**. Choosing someone does not trigger the separate **Transfer** button.

## 6. Special icon controls

| Control | Design |
|---|---|
| **Permissions** | Keep **thumbs-up = Allowed** (positive/active) and **thumbs-down = Denied** (neutral/inactive) in both quick controls and the settings matrix. Include a visible **Allowed / Denied** legend in the matrix. |
| **Mute, Captions, Theater** | Icon buttons with a clear persistent pressed state; **not** sliding switches. |
| **Admin Mode** | Compact icon-only control; **not** a sliding switch. |
| **Room Privacy** | Compact globe/lock icon-only control; **not** a sliding switch. Clearly indicate Public vs Private; pressed = Private. |

Use stable accessible names: **Admin mode** uses checked switch state; **Room privacy**, permission thumbs, **Mute**, **Captions**, and **Theater mode** use accurate pressed state. Don't rely on color alone. **Denied** and **read-only** are different: a permission can be allowed *and* read-only.

## 7. Saving and feedback

- A choice made during **Create Room** stays in the form until **Create room**.
- Editing **existing-room visibility or permission presets** is a draft until the user presses **Save**; provide Cancel/discard, pending, and error feedback. **Auto-queue mode/source** follows its existing **Save auto-queue** form.
- Queue and Media view choices are remembered **independently**. Volume and mute are device/browser preferences; portable preferences such as theme and layouts can sync when account support exists, with local fallback.
- Show clear pending/error states without claiming an unsuccessful save has applied.

### General toasts

All Watch notifications use the shared toast component. Toasts are **40px tall**, with **12px corner radii**, no border or outline, and a **24 × 24px icon**. Use the standard dark player card, white text, muted grey text and accent color tokens. Media actions appear in the main row at **14px in white**; the username appears below at **12px in grey**. Participant feedback lasts 2.5 seconds. Reconnect notifications remain until the connection recovers or the player is cleared.

All toasts share one stack at the **bottom-left of the video**, on desktop and mobile. Keep the stack inside the visible page: when scrolling would move it above the viewport, pin it to the **top edge of the page**. Move it just above the visible media-control content whenever there is room, ignoring the control container’s gradient padding. Theater and fullscreen buttons alone do not count as media controls; in the lobby, keep the stack at the bottom-left of the black video area. **Visibility takes priority:** if avoiding the controls would push the stack offscreen, keep it visible even when it overlaps the controls. Keep the same positioning behavior in theater and fullscreen modes.

Fade each toast in while it rises slightly, and reverse that motion when it leaves. Use a brief **180ms** animation with **6px** of travel. Smoothly animate stack movement when media controls appear or disappear. Scrolling keeps the stack anchored immediately. Respect reduced-motion preferences.

Show at most **three** at once, stacked with **newest at the bottom**; queue the rest.

| Toast | Duration |
|---|---|
| Loading | Until the operation finishes or the toast is dismissed |
| Success | **4 seconds** of visible time |
| Error | **10 seconds** of visible time |

Every toast has an **X**. Hover/focus pauses a success/error countdown and then resumes it. A queued toast gets its full duration after becoming visible. Prioritize errors when the stack fills, without displacing a toast the user is hovering over or focusing. Dismissing a loading toast **does not cancel** the action.

## 8. Quick checks before shipping

- Is this the **right type** of control (button, switch, checkbox, selection, or tab)?
- Are its **size, radius, padding, icon size, and label weight** from this guide?
- Can you tell **selected, focused, disabled, loading, and read-only** states apart without relying on color?
- Does it work by **keyboard**, with a clear name and visible focus?
- Does it fit on **narrow screens and 200% zoom** without clipped labels or tiny targets?
- Does it look right in **Light/Dark × Orange/Pink**?

**Scope note:** This guide describes the main Watch controls. The button styling can also inform web Remote actions, but the switch and selection redesign rules do not apply to the separate Remote interface.
