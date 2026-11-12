/* Development-only control gallery. Builds each shared control with the shipped helpers and classes,
 * in each state they support. Served only by isolated demo servers (see server/app.js). */
'use strict';
(() => {
  const controls = globalThis.uburoomControls,
    icons = globalThis.uburoomIcons;
  const root = document.getElementById('gallery');

  function element(tag, { className, text, attrs } = {}, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attrs || {})) node.setAttribute(name, value);
    node.append(...children);
    return node;
  }
  function section(title, note, { wide = false } = {}) {
    const grid = element('div', { className: 'gallery-grid' + (wide ? ' gallery-wide' : '') });
    const block = element('section', { className: 'gallery-section', attrs: { 'aria-label': title } });
    block.append(element('h2', { text: title }));
    if (note) block.append(element('p', { className: 'hint', text: note }));
    block.append(grid);
    root.append(block);
    return grid;
  }
  function cell(grid, label, ...content) {
    const box = element('div', { className: 'gallery-cell' }, ...content);
    box.append(element('p', { className: 'hint', text: label }));
    grid.append(box);
    return box;
  }
  function missing(grid, label) {
    return cell(grid, label, element('p', { className: 'hint', text: 'No shared implementation.' }));
  }
  function textButton(className, label, { icon, disabled = false, ariaDisabled, title } = {}) {
    const button = element('button', { className, attrs: { type: 'button' } });
    if (icon) button.append(icons.icon(document, icon));
    button.append(document.createTextNode(label));
    button.disabled = disabled;
    if (ariaDisabled) button.setAttribute('aria-disabled', 'true');
    if (title) button.title = title;
    return button;
  }

  // Buttons: shared classes from the design guide and uburoomControls.button().
  const buttons = section(
    'Buttons',
    '.primary, .quiet, .danger-button and .solid-button are shared classes; .quiet and .icon-button also come from uburoomControls.button().',
  );
  const focused = textButton('primary', 'Create room');
  cell(buttons, 'Primary · focus', focused);
  cell(buttons, 'Primary · default', textButton('primary', 'Create room'));
  cell(buttons, 'Primary · disabled', textButton('primary', 'Create room', { disabled: true }));
  cell(
    buttons,
    'Primary · unavailable (aria-disabled)',
    textButton('primary', 'Publish now', { ariaDisabled: true, title: 'Connect Discord first' }),
  );
  cell(buttons, 'Quiet · default', textButton('quiet', 'Cancel'));
  cell(buttons, 'Quiet · disabled', textButton('quiet', 'Cancel', { disabled: true }));
  cell(buttons, 'Quiet · controls.button with icon', controls.button(document, { label: 'Share', icon: 'share' }));
  cell(
    buttons,
    'Quiet · controls.button disabled',
    controls.button(document, { label: 'Share', icon: 'share', disabled: true }),
  );
  cell(buttons, 'Danger · default', textButton('danger-button', 'Remove post'));
  cell(buttons, 'Danger · disabled', textButton('danger-button', 'Remove post', { disabled: true }));
  cell(buttons, 'Solid (player title bar) · default', textButton('solid-button', 'Join', { icon: 'login' }));
  cell(buttons, 'Solid · private', textButton('solid-button private', 'Private', { icon: 'lock' }));
  cell(buttons, 'Solid · disabled', textButton('solid-button', 'Join', { icon: 'login', disabled: true }));
  missing(buttons, 'Busy / loading button');

  // Icon buttons.
  const iconButtons = section(
    'Icon buttons',
    'uburoomControls.button({ iconOnly: true }) gives .icon-button; pressed icon buttons are .player-button with aria-pressed.',
  );
  cell(
    iconButtons,
    'Icon · default',
    controls.button(document, { label: 'Settings', icon: 'settings', iconOnly: true }),
  );
  cell(
    iconButtons,
    'Icon · disabled',
    controls.button(document, { label: 'Settings', icon: 'settings', iconOnly: true, disabled: true }),
  );
  const unavailableIcon = controls.button(document, { label: 'Refresh', icon: 'refresh', iconOnly: true });
  unavailableIcon.setAttribute('aria-disabled', 'true');
  cell(iconButtons, 'Icon · unavailable (aria-disabled)', unavailableIcon);
  for (const [label, pressed, disabled] of [
    ['Player button · default', false, false],
    ['Player button · pressed', true, false],
    ['Player button · disabled', false, true],
  ]) {
    const button = element('button', {
      className: 'player-button',
      attrs: { type: 'button', 'aria-label': 'Captions', title: 'Captions', 'aria-pressed': String(pressed) },
    });
    button.append(icons.icon(document, 'captions'));
    button.disabled = disabled;
    cell(iconButtons, label + ' (outside the dark player chrome)', button);
  }

  // Switches.
  const switches = section('Switches', 'input.watch-switch in .watch-switch-label, and uburoomControls.switchPill().');
  for (const [label, checked, disabled, secondary] of [
    ['Switch · off', false, false, false],
    ['Switch · on', true, false, false],
    ['Switch · on (secondary)', true, false, true],
    ['Switch · disabled off', false, true, false],
    ['Switch · disabled on', true, true, false],
  ]) {
    const input = element('input', {
      className: 'watch-switch' + (secondary ? ' watch-switch-secondary' : ''),
      attrs: { type: 'checkbox', role: 'switch' },
    });
    input.checked = checked;
    input.disabled = disabled;
    cell(switches, label, element('label', { className: 'watch-switch-label' }, input, 'Keep room when empty'));
  }
  for (const [label, options] of [
    ['Switch pill · off', { label: 'Auto-play', checked: false }],
    ['Switch pill · on', { label: 'Auto-play', checked: true }],
    ['Switch pill · on (secondary)', { label: 'Auto-queue', checked: true, accent: 'secondary' }],
    ['Switch pill · read-only', { label: 'Auto-play', checked: true, editable: false }],
    [
      'Switch pill · disabled',
      { label: 'Auto-queue', checked: false, disabled: true, reason: 'Queue editing is unavailable for your role.' },
    ],
    [
      'Switch pill · with action',
      {
        label: 'Auto-queue',
        checked: true,
        accent: 'secondary',
        action: { label: 'Auto-queue settings', icon: 'settings', onClick: () => {} },
      },
    ],
  ])
    cell(switches, label, controls.switchPill(document, options).element);

  // Segmented selectors.
  const segmented = section('Segmented selectors', '.watch-segmented groups wired by uburoomControls.segmented().', {
    wide: true,
  });
  function segmentedGroup(choices, { selected, disabled = [], view = false } = {}) {
    const group = element('div', {
      className: 'button-group watch-segmented' + (view ? ' watch-segmented-view' : ''),
      attrs: { role: 'group', 'aria-label': 'Audio mode' },
    });
    for (const [value, label, icon] of choices) {
      const button = element('button', {
        className: 'group-button',
        attrs: { type: 'button', 'aria-pressed': String(value === selected), 'data-value': value },
      });
      if (icon) {
        button.append(icons.icon(document, icon));
        button.setAttribute('aria-label', label);
        button.title = label;
      } else button.textContent = label;
      button.disabled = disabled.includes(value);
      group.append(button);
    }
    controls.segmented(group);
    return group;
  }
  const audio = [
    ['normal', 'Normal'],
    ['dialogue', 'Dialogue'],
    ['night', 'Night'],
  ];
  cell(segmented, 'Selected first', segmentedGroup(audio, { selected: 'normal' }));
  cell(segmented, 'Selected middle', segmentedGroup(audio, { selected: 'dialogue' }));
  cell(segmented, 'One choice disabled', segmentedGroup(audio, { selected: 'normal', disabled: ['night'] }));
  cell(
    segmented,
    'Whole group disabled',
    segmentedGroup(audio, { selected: 'normal', disabled: audio.map(([value]) => value) }),
  );
  cell(
    segmented,
    'View selector (icons)',
    segmentedGroup(
      [
        ['cards', 'Cards', 'libraryCards'],
        ['list', 'List', 'libraryList'],
      ],
      { selected: 'cards', view: true },
    ),
  );
  const select = element('select', { attrs: { 'aria-label': 'Episodes' } });
  for (const [value, label] of [
    ['all', 'All episodes'],
    ['unfinished', 'Unfinished'],
  ])
    select.append(element('option', { text: label, attrs: { value } }));
  const bound = segmentedGroup(
    [
      ['all', 'All'],
      ['unfinished', 'Unfinished'],
    ],
    { selected: 'all' },
  );
  controls.bindSelect(select, bound);
  cell(segmented, 'Bound to a select (bindSelect)', bound);

  // Native controls the guide names.
  const native = section('Checkboxes and dropdowns', '.form-checkbox for pending form choices; native select.');
  for (const [label, checked, disabled] of [
    ['Checkbox · unchecked', false, false],
    ['Checkbox · checked', true, false],
    ['Checkbox · disabled', true, true],
  ]) {
    const input = element('input', { attrs: { type: 'checkbox' } });
    input.checked = checked;
    input.disabled = disabled;
    cell(
      native,
      label,
      element('label', { className: 'form-checkbox' }, input, element('span', { text: 'Post to Discord' })),
    );
  }
  cell(native, 'Dropdown · default', select);
  const disabledSelect = select.cloneNode(true);
  disabledSelect.disabled = true;
  cell(native, 'Dropdown · disabled', disabledSelect);

  // Tabs have no shared implementation: each surface builds its own.
  missing(section('Tabs', 'Each surface builds its own tabs.'), 'Tabs');

  // Permissions.
  const permissions = section(
    'Permissions',
    'Allowed/Denied thumbs from uburoomControls.permissionButton() and switchPill({ variant: "permission" }).',
  );
  for (const [label, options] of [
    ['Thumb · allowed', { checked: true }],
    ['Thumb · denied', { checked: false }],
    ['Thumb · disabled', { checked: true, disabled: true, reason: 'Only the creator can change this' }],
  ])
    cell(permissions, label, controls.permissionButton(document, { label: 'Seek', ...options }).element);
  for (const [label, options] of [
    ['Permission pill · allowed', { checked: true }],
    ['Permission pill · denied', { checked: false }],
    ['Permission pill · read-only', { checked: true, editable: false }],
  ])
    cell(
      permissions,
      label,
      controls.switchPill(document, { label: 'Play/pause', variant: 'permission', ...options }).element,
    );

  // Popovers: each state from uburoomPopover.show(), kept beside its own trigger.
  const popovers = section('Popovers', 'uburoomPopover.show() states. The app shows one at a time; here each is kept.');
  for (const [label, options] of [
    ['Success', { text: 'Saved', state: 'success' }],
    ['Loading', { text: 'Saving…', state: 'loading' }],
    ['Error', { text: 'Could not save', state: 'error' }],
    ['Normal with symbol', { text: 'Saved report as file', state: 'normal', symbol: 'copy' }],
  ]) {
    const trigger = textButton('quiet', 'Trigger');
    const anchor = cell(popovers, label, trigger);
    anchor.classList.add('gallery-anchor');
    const shown = globalThis.uburoomPopover.show(trigger, { ...options, duration: 0, placement: 'top' });
    const copy = shown.element.cloneNode(true);
    shown.dismiss();
    copy.classList.add('visible');
    anchor.append(copy);
    // Re-anchor from the viewport to the cell, keeping the offset uburoomPopover chose.
    const place = () => {
      const cellBox = anchor.getBoundingClientRect(),
        triggerBox = trigger.getBoundingClientRect(),
        box = copy.getBoundingClientRect();
      copy.style.left = Math.round(triggerBox.left - cellBox.left + triggerBox.width / 2 - box.width / 2) + 'px';
      copy.style.top = Math.round(triggerBox.top - cellBox.top - box.height - 8) + 'px';
      copy.style.setProperty('--arrow-x', Math.round(box.width / 2) + 'px');
    };
    requestAnimationFrame(place);
  }

  // Toasts: each from uburoomToasts.create(), without a stage so nothing positions them over a player.
  const toasts = section('Toasts', 'uburoomToasts.create() states. In the app the region floats over the player.', {
    wide: true,
  });
  for (const [label, options] of [
    ['Normal', { title: 'Demo guest joined', symbol: 'user' }],
    [
      'Normal with hint',
      { title: 'Switched to fallback to keep playing.', hint: 'Using default audio.', symbol: 'info-circle' },
    ],
    ['Loading', { title: 'Reconnecting…', symbol: 'loader-4', loading: true }],
    ['Error', { type: 'error', title: 'Plex connection problem', symbol: 'alert-triangle' }],
    [
      'Two-line action',
      { title: 'Demo guest is buffering', symbol: 'alert-triangle', action: { label: 'Pause to wait', run: () => {} } },
    ],
  ]) {
    const region = element('div', { className: 'watch-toast-region', attrs: { 'aria-live': 'polite' } });
    cell(toasts, label, region);
    globalThis.uburoomToasts.create(region).show('gallery', { ...options, persistent: true });
  }

  // Dialog archetypes, shown open in place (non-modal) with the shared dialog classes.
  const dialogs = section(
    'Dialog archetypes',
    'Shared .watch-dialog classes; each surface writes its own dialog markup, so these are samples, not a shared builder.',
    { wide: true },
  );
  function dialog(title, { small = false, close = false, body, actions }) {
    const node = element('dialog', {
      className: 'watch-dialog' + (small ? ' dialog-small' : ''),
      attrs: { 'aria-label': title },
    });
    const header = element('header', {}, element('h2', { text: title }));
    if (close) header.append(controls.button(document, { label: 'Close', icon: 'close', iconOnly: true }));
    node.append(header, element('p', { text: body }));
    if (actions) node.append(element('div', { className: 'dialog-footer' }, ...actions));
    return node;
  }
  const archetypes = [
    [
      'Archetype 1 · small confirmation',
      dialog('Close room?', {
        small: true,
        body: 'Everyone in the room leaves.',
        actions: [textButton('quiet', 'Cancel'), textButton('danger-button', 'Close room')],
      }),
    ],
    [
      'Archetype 1 · small prompt',
      dialog('Approve sign-in?', {
        small: true,
        body: 'A browser asked to sign in as you.',
        actions: [textButton('quiet', 'Cancel'), textButton('primary', 'Approve')],
      }),
    ],
    [
      'Archetype 2 · workspace with close',
      dialog('Room settings', {
        close: true,
        body: 'Settings content.',
        actions: [textButton('quiet', 'Cancel'), textButton('primary', 'Save')],
      }),
    ],
    ['Archetype 2 · browsing, no footer', dialog('Rooms', { close: true, body: 'Room list.' })],
  ];
  for (const [label, node] of archetypes) {
    cell(dialogs, label, node);
    node.show();
  }

  focused.focus({ preventScroll: true });
  document.body.dataset.galleryReady = 'true';
})();
