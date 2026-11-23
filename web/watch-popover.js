/* Shared anchored tooltip popover component for localized status feedback. */
import * as uburoomIcons from './icons.js';

let currentPopover = null;
let activeTimer = null;
let activeDismissListener = null;
let activeDoc = null;
let activeWin = null;

function dismiss() {
  if (activeTimer) {
    clearTimeout(activeTimer);
    activeTimer = null;
  }
  if (activeDismissListener) {
    const win = activeWin || window;
    const doc = activeDoc || document;
    win.removeEventListener('scroll', activeDismissListener, true);
    doc.removeEventListener('pointerdown', activeDismissListener, true);
    win.removeEventListener('keydown', activeDismissListener, true);
    activeDismissListener = null;
  }
  const win = activeWin || window;
  activeDoc = null;
  activeWin = null;
  if (!currentPopover) return;
  const el = currentPopover;
  currentPopover = null;
  el.classList.remove('visible');
  const prefersReducedMotion = win.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (prefersReducedMotion) {
    el.remove();
  } else {
    setTimeout(() => el.remove(), 160);
  }
}

function show(trigger, options = {}) {
  if (!trigger || !trigger.isConnected) return null;
  const text = typeof options === 'string' ? options : options.text || '';
  const state = options.state || 'success';
  const duration = options.duration !== undefined ? options.duration : state === 'loading' ? 0 : 2500;
  const placement = options.placement || 'auto';
  const iconName =
    options.symbol ||
    (state === 'success'
      ? 'check'
      : state === 'loading'
        ? 'loader-4'
        : state === 'error'
          ? 'alert-triangle'
          : undefined);

  dismiss();

  const doc = trigger.ownerDocument || document;
  const win = doc.defaultView || window;
  activeDoc = doc;
  activeWin = win;
  const modal = trigger.closest('dialog[open]');
  const container = modal || doc.fullscreenElement || doc.body;

  const popover = doc.createElement('div');
  popover.className = 'watch-popover state-' + state;
  popover.setAttribute('role', 'status');
  popover.setAttribute('aria-live', 'polite');

  if (iconName) {
    const iconSpan = doc.createElement('span');
    iconSpan.className = 'popover-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.append(uburoomIcons.icon(doc, iconName));
    popover.append(iconSpan);
  }

  const labelSpan = doc.createElement('span');
  labelSpan.className = 'popover-text';
  labelSpan.textContent = text;
  popover.append(labelSpan);

  container.append(popover);
  currentPopover = popover;

  function position() {
    if (!trigger.isConnected || !popover.isConnected) {
      dismiss();
      return;
    }
    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const viewportWidth = win.innerWidth;

    let chosenPlacement = placement;
    if (chosenPlacement === 'auto') {
      const spaceAbove = triggerRect.top;
      const requiredAbove = popoverRect.height + 10;
      chosenPlacement = spaceAbove >= requiredAbove ? 'top' : 'bottom';
    }
    popover.dataset.placement = chosenPlacement;

    const margin = 8;
    const triggerCenter = triggerRect.left + triggerRect.width / 2;
    let left = triggerCenter - popoverRect.width / 2;
    const minLeft = margin;
    const maxLeft = Math.max(minLeft, viewportWidth - popoverRect.width - margin);
    left = Math.max(minLeft, Math.min(left, maxLeft));

    const arrowX = Math.round(Math.max(12, Math.min(popoverRect.width - 12, triggerCenter - left)));
    popover.style.setProperty('--arrow-x', arrowX + 'px');

    let top;
    if (chosenPlacement === 'top') {
      top = triggerRect.top - popoverRect.height - 8;
    } else {
      top = triggerRect.bottom + 8;
    }

    popover.style.setProperty('--x', Math.round(left) + 'px');
    popover.style.setProperty('--y', Math.round(top) + 'px');
  }

  position();

  win.requestAnimationFrame(() => {
    if (currentPopover === popover) {
      popover.classList.add('visible');
    }
  });

  if (duration > 0) {
    activeTimer = setTimeout(() => {
      if (currentPopover === popover) dismiss();
    }, duration);
  }

  activeDismissListener = event => {
    if (event.type === 'scroll') {
      const target = event.target;
      if (
        target !== doc &&
        target !== doc.documentElement &&
        target !== doc.body &&
        !(typeof target?.contains === 'function' && target.contains(trigger))
      )
        return;
    }
    if (event.type === 'pointerdown' && popover.contains(event.target)) return;
    if (event.type === 'keydown') {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
    }
    dismiss();
  };
  win.addEventListener('scroll', activeDismissListener, { capture: true, passive: true });
  doc.addEventListener('pointerdown', activeDismissListener, { capture: true, passive: true });
  win.addEventListener('keydown', activeDismissListener, { capture: true });

  return {
    element: popover,
    dismiss() {
      if (currentPopover === popover) dismiss();
    },
    update(nextText, nextState = state) {
      if (currentPopover !== popover) return;
      labelSpan.textContent = nextText;
      if (nextState !== state) {
        popover.className = 'watch-popover state-' + nextState + ' visible';
      }
      position();
    },
  };
}

export { show, dismiss };
