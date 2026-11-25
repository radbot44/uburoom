/* Opt-in watch controls. Panel modules retain state, permissions and actions. */
import * as uburoomIcons from './icons.js';

const groups = new WeakMap();
const tablists = new WeakMap();
const busyStates = new WeakMap();
function content(control, { label, icon, iconOnly = false, responsive }) {
  const doc = typeof control.ownerDocument?.createElementNS === 'function' ? control.ownerDocument : document;
  const isResponsive = responsive !== undefined ? responsive : !!icon && !iconOnly;
  const prevIcon = control.dataset.watchControlIcon || '';
  const prevIconOnly = control.dataset.watchControlIconOnly === 'true';
  if (
    prevIcon === (icon || '') &&
    prevIconOnly === !!iconOnly &&
    control.classList.contains('watch-control') &&
    (!icon || control.querySelector('svg'))
  ) {
    let text = control.querySelector('.watch-control-label');
    if (!iconOnly) {
      if (!text) {
        text = doc.createElement('span');
        text.className = 'watch-control-label';
        control.append(text);
      }
      if (text.textContent !== label) text.textContent = label;
    } else if (text) {
      text.remove();
    }
  } else {
    control.replaceChildren();
    if (icon) control.append(uburoomIcons.icon(doc, icon));
    const text = doc.createElement('span');
    text.className = 'watch-control-label';
    text.textContent = label;
    if (!iconOnly) control.append(text);
    control.dataset.watchControlIcon = icon || '';
    control.dataset.watchControlIconOnly = String(!!iconOnly);
  }
  control.classList.add('watch-control');
  control.classList.toggle('watch-control-icon', iconOnly);
  control.classList.toggle('watch-control-responsive', !!isResponsive);
  if (control.getAttribute('aria-label') !== label) control.setAttribute('aria-label', label);
  if (control.title !== label) control.title = label;
  return control;
}
function button(doc, { label, icon, iconOnly = false, responsive, action, disabled = false }) {
  const control = doc.createElement('button');
  control.type = 'button';
  control.className = iconOnly ? 'icon-button' : 'quiet';
  control.disabled = disabled;
  content(control, { label, icon, iconOnly, responsive });
  if (action) control.addEventListener('click', action);
  return control;
}
// A label with a small switch (or an Allowed/Denied thumb) on a button-grey surface. `accent: 'secondary'`
// colours the switch with the auto-queue accent; `reason` replaces the tooltip while disabled.
function switchPill(
  doc,
  {
    label,
    checked = false,
    editable = true,
    disabled = false,
    reason = '',
    onChange,
    action,
    variant = 'switch',
    accent = 'primary',
  },
) {
  const element = doc.createElement('div');
  element.className = 'watch-switch-pill';
  const permission = variant === 'permission';
  element.classList.toggle('watch-permission-pill', permission);
  const controlLabel = doc.createElement('label'),
    badge = doc.createElement('span');
  controlLabel.className = badge.className = 'watch-switch-pill-body';
  const text = doc.createElement('span');
  text.className = 'watch-switch-pill-label';
  label.split('/').forEach((part, index) => {
    if (index) text.append(doc.createTextNode('/'), doc.createElement('wbr'));
    text.append(doc.createTextNode(part));
  });
  const state = doc.createElement('span');
  state.className = 'watch-switch-pill-state';
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.className = permission
    ? 'watch-permission-input'
    : 'watch-switch watch-switch-small' + (accent === 'secondary' ? ' watch-switch-secondary' : '');
  if (!permission) input.setAttribute('role', 'switch');
  const indicator = permission ? doc.createElement('span') : undefined;
  if (indicator) {
    indicator.className = 'watch-permission-indicator';
    indicator.setAttribute('aria-hidden', 'true');
  }
  let currentEditable = editable;
  const actionButton = action
    ? button(doc, { label: action.label, icon: action.icon || 'settings', iconOnly: true, action: action.onClick })
    : undefined;
  actionButton?.classList.add('watch-switch-pill-action');
  let currentReason = reason,
    currentDisabled = disabled;
  function update({
    checked = input.checked,
    editable = currentEditable,
    disabled = currentDisabled,
    reason = currentReason,
  } = {}) {
    currentEditable = editable;
    currentReason = reason;
    currentDisabled = disabled;
    input.checked = checked;
    // Read-only switches still show their state: a switch that cannot be changed, at full strength.
    input.disabled = disabled || !editable;
    element.classList.toggle('is-on', checked);
    element.classList.toggle('is-readonly', !editable);
    element.classList.toggle('is-disabled', disabled);
    element.classList.toggle('watch-switch-pill-split', !!actionButton && editable);
    const stateText = permission ? (checked ? ': Allowed' : ': Denied') : checked ? ': On' : ': Off';
    element.title = disabled && reason ? reason : label + stateText;
    if (indicator) {
      const slug = checked ? 'thumb-up' : 'thumb-down';
      indicator.replaceChildren(uburoomIcons.icon(doc, slug));
    }
    const body = editable ? controlLabel : badge;
    if (element.firstChild !== body) {
      if (editable) controlLabel.replaceChildren(text, input);
      else badge.replaceChildren(text, permission ? state : input);
      if (indicator) body.append(indicator);
      element.replaceChildren(body);
      if (editable && actionButton) element.append(actionButton);
    }
    state.textContent = stateText;
    if (actionButton) actionButton.disabled = disabled;
  }
  update({ checked, editable, disabled, reason });
  input.addEventListener('change', event => {
    update({ checked: input.checked });
    onChange?.(event);
  });
  return { element, input, update };
}
function permissionButton(doc, { label, checked = false, disabled = false, reason = '', action }) {
  const control = button(doc, { label, icon: checked ? 'thumb-up' : 'thumb-down', iconOnly: true, disabled, action });
  control.classList.add('watch-permission-button');
  control.dataset.icon = checked ? 'thumb-up' : 'thumb-down';
  function update({ checked, disabled, reason = '' }) {
    const icon = checked ? 'thumb-up' : 'thumb-down';
    if (control.dataset.icon !== icon) {
      control.dataset.icon = icon;
      content(control, { label, icon, iconOnly: true });
    }
    control.disabled = disabled;
    control.setAttribute('aria-pressed', String(checked));
    control.title = label + (checked ? ': Allowed' : ': Denied') + (reason ? '. ' + reason : '');
  }
  update({ checked, disabled, reason });
  return { element: control, update };
}
function segmented(group) {
  if (groups.has(group)) {
    groups.get(group)();
    return;
  }
  group.classList.add('watch-segmented');
  const buttons = () => [...group.querySelectorAll('button')].filter(control => !control.disabled && !control.hidden);
  function refresh() {
    const choices = buttons();
    const entry = choices.includes(group.ownerDocument.activeElement)
      ? group.ownerDocument.activeElement
      : choices.find(control => control.getAttribute('aria-pressed') === 'true') || choices[0];
    for (const control of group.querySelectorAll('button')) control.tabIndex = control === entry ? 0 : -1;
  }
  group.addEventListener('focusin', refresh);
  group.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const choices = buttons(),
      index = choices.indexOf(event.target);
    if (index < 0 || !choices.length) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
    choices[next].focus(); // Native Enter/Space activates; arrows never select.
  });
  new MutationObserver(refresh).observe(group, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['disabled', 'hidden', 'aria-pressed'],
  });
  groups.set(group, refresh);
  refresh();
}
function bindSelect(select, group) {
  function refresh() {
    for (const control of group.querySelectorAll('button')) {
      control.setAttribute('aria-pressed', String(control.dataset.value === select.value));
      control.disabled = select.disabled;
    }
    segmented(group);
  }
  group.addEventListener('click', event => {
    const control = event.target.closest('button');
    if (
      !control ||
      control.disabled ||
      control.dataset.value === 'custom' ||
      select.disabled ||
      select.value === control.dataset.value
    )
      return;
    select.value = control.dataset.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    refresh();
  });
  const prop = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    get() {
      return prop.get.call(this);
    },
    set(value) {
      prop.set.call(this, value);
      refresh();
    },
    configurable: true,
  });
  new MutationObserver(refresh).observe(select, { attributes: true, attributeFilter: ['disabled'] });
  select.addEventListener('change', refresh);
  refresh();
}
function busy(control, active, { label } = {}) {
  if (!control) return control;
  const isBusy = Boolean(active);
  const doc = typeof control.ownerDocument?.createElementNS === 'function' ? control.ownerDocument : document;
  if (isBusy) {
    if (!busyStates.has(control)) {
      busyStates.set(control, {
        disabled: Boolean(control.disabled),
        ariaLabel: control.getAttribute?.('aria-label') ?? null,
        title: control.title || '',
      });
    }
    if (!control.classList?.contains?.('is-busy') && typeof doc.createElement === 'function') {
      const nodes = Array.isArray(control.childNodes)
        ? [...control.childNodes]
        : typeof control.childNodes?.[Symbol.iterator] === 'function'
          ? [...control.childNodes]
          : Array.isArray(control.children)
            ? [...control.children]
            : [];
      if (nodes.length && typeof control.replaceChildren === 'function') {
        const wrap = doc.createElement('span');
        wrap.className = 'watch-busy-content';
        wrap.append(...nodes);
        const spin = doc.createElement('span');
        spin.className = 'watch-busy-spinner';
        spin.setAttribute('aria-hidden', 'true');
        spin.append(uburoomIcons.icon(doc, 'loader-4'));
        control.replaceChildren(wrap, spin);
      }
    }
    control.disabled = true;
    control.classList?.add?.('is-busy');
    control.setAttribute?.('aria-busy', 'true');
    if (label) {
      control.setAttribute?.('aria-label', label);
      control.title = label;
    }
  } else {
    const saved = busyStates.get(control);
    busyStates.delete(control);
    const wrap =
      typeof control.querySelector === 'function' ? control.querySelector(':scope > .watch-busy-content') : null;
    if (wrap && typeof wrap.childNodes?.[Symbol.iterator] === 'function') {
      control.replaceChildren(...wrap.childNodes);
    } else if (typeof control.querySelector === 'function') {
      control.querySelector(':scope > .watch-busy-spinner')?.remove?.();
    }
    control.classList?.remove?.('is-busy');
    control.removeAttribute?.('aria-busy');
    if (saved) {
      control.disabled = saved.disabled;
      if (saved.ariaLabel !== null) control.setAttribute?.('aria-label', saved.ariaLabel);
      else control.removeAttribute?.('aria-label');
      control.title = saved.title;
    }
  }
  return control;
}
function tabs(tablist, { onSelect, selector = 'button' } = {}) {
  if (!tablist) return;
  if (tablists.has(tablist)) {
    tablists.get(tablist)();
    return;
  }
  tablist.classList?.add?.('watch-tabs');
  const doc = typeof tablist.ownerDocument?.createElement === 'function' ? tablist.ownerDocument : document;
  const items = () =>
    [...(tablist.querySelectorAll?.(selector) || [])].filter(control => !control.disabled && !control.hidden);
  const isSelected = control =>
    control.getAttribute?.('aria-selected') === 'true' ||
    control.getAttribute?.('aria-current') === 'true' ||
    control.getAttribute?.('aria-current') === 'page';
  function refresh() {
    const choices = items();
    const entry = choices.includes(doc.activeElement) ? doc.activeElement : choices.find(isSelected) || choices[0];
    for (const control of tablist.querySelectorAll?.(selector) || []) {
      control.tabIndex = control === entry ? 0 : -1;
    }
  }
  tablist.addEventListener?.('focusin', refresh);
  tablist.addEventListener?.('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const choices = items(),
      index = choices.indexOf(event.target);
    if (index < 0 || !choices.length) return;
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? choices.length - 1
          : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
    const target = choices[next];
    target.focus();
    if (onSelect) onSelect(target);
    else target.click();
  });
  if (typeof MutationObserver === 'function') {
    new MutationObserver(refresh).observe(tablist, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled', 'hidden', 'aria-selected', 'aria-current'],
    });
  }
  tablists.set(tablist, refresh);
  refresh();
}
export { button, content, switchPill, permissionButton, segmented, bindSelect, busy, tabs };
