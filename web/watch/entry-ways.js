import { $ } from './page.js';

/* The entry page's list of ways in (docs/ui-behavior.md, Entry page): one button per enabled way,
 * and the forms that open inline under their button. One panel is open at a time; choosing another
 * way or pressing Escape closes it. Whatever appears is scrolled into view. */

/** Scrolls an element that just appeared (a form, an error, a status line) into view. */
export function reveal(element) {
  if (element && !element.hidden) element.scrollIntoView({ block: 'nearest' });
}

export function entryWays() {
  let open; // {button, panel, onClose}
  function close({ focus = false } = {}) {
    if (!open) return;
    const current = open;
    open = undefined;
    current.button.setAttribute('aria-expanded', 'false');
    current.panel.hidden = true;
    current.onClose?.();
    if (focus) current.button.focus();
  }
  /**
   * Opens `panel` directly under `button`, closing any other. Focuses its first field (or
   * `focus`), and scrolls the panel into view.
   * @param {HTMLElement} button
   * @param {HTMLElement} panel
   * @param {{focus?: HTMLElement, onClose?: () => void}} [options]
   */
  function show(button, panel, { focus, onClose } = {}) {
    if (open?.panel !== panel || open?.button !== button) close();
    if (button.nextElementSibling !== panel) button.after(panel);
    open = { button, panel, onClose };
    button.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    const target = focus || panel.querySelector('input:not([type=hidden]):not([hidden]), button, textarea, select');
    target?.focus({ preventScroll: true });
    reveal(panel);
  }
  /** A button that opens `panel` when chosen, or closes it when it is the open one. */
  function bind(button, panel, options) {
    button.addEventListener('click', () => {
      if (open?.button === button) close();
      else show(button, panel, typeof options === 'function' ? options() : options);
    });
  }
  $('welcome').addEventListener('keydown', event => {
    if (event.key === 'Escape' && open) {
      event.preventDefault();
      close({ focus: true });
    }
  });
  return { show, bind, close, isOpen: panel => open?.panel === panel };
}
