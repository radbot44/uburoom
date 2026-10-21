/* Native dialog lifecycle shared by watch surfaces; no playback ownership. */
(function(root) {
  'use strict';
  const policies = new WeakMap(), triggers = new WeakMap(), holds = new WeakMap();
  function register(dialog, policy = {}) {
    if (policies.has(dialog)) { policies.get(dialog).push(policy); return; }
    policies.set(dialog, [policy]);
    let pressedOutside = false;
    const outside = event => {
      const box = dialog.getBoundingClientRect();
      return event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom);
    };
    dialog.addEventListener('pointerdown', event => { pressedOutside = outside(event); });
    dialog.addEventListener('click', event => {
      if (pressedOutside && outside(event) && !blocked(dialog, true) && dialog.dataset.destructive !== 'true') close(dialog, 'cancel');
      pressedOutside = false;
    });
    dialog.addEventListener('cancel', event => { if (blocked(dialog, true)) event.preventDefault(); });
    dialog.addEventListener('submit', event => { if (blocked(dialog)) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (dialog.open) return;
      pressedOutside = false;
      const trigger = triggers.get(dialog); triggers.delete(dialog);
      queueMicrotask(() => {
        if (dialog.open || !trigger?.isConnected || !trigger.getClientRects().length || trigger.disabled) return;
        const modal = dialog.ownerDocument.querySelector('dialog:modal');
        if (!modal || modal.contains(trigger)) trigger.focus({preventScroll:true});
      });
    });
  }
  function blocked(dialog, drafts = false) {
    return !!holds.get(dialog) || dialog.getAttribute('aria-busy') === 'true' ||
      (policies.get(dialog) || []).some(policy => policy.busy?.() || drafts && policy.dirty?.());
  }
  function open(dialog, trigger = dialog.ownerDocument.activeElement) {
    if (dialog.open) return;
    if (!policies.has(dialog)) register(dialog);
    const doc = dialog.ownerDocument, parent = doc.fullscreenElement || doc.body;
    if (dialog.parentElement !== parent) parent.append(dialog);
    triggers.set(dialog, trigger); dialog.returnValue = ''; dialog.showModal();
  }
  function close(dialog, value = 'cancel') {
    if (!blocked(dialog)) dialog.close(value);
  }
  function hold(dialog) {
    holds.set(dialog, (holds.get(dialog) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true; holds.set(dialog, holds.get(dialog) - 1);
    };
  }
  function confirm(message, {destructive = false} = {}) {
    const dialog = document.getElementById('room-confirm-dialog');
    if (dialog.open) return Promise.resolve(false);
    document.getElementById('room-confirm-message').textContent = message;
    document.getElementById('room-confirm-yes').className = destructive ? 'danger-button' : 'primary';
    dialog.dataset.destructive = String(destructive);
    const result = new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), {once:true}));
    open(dialog); return result;
  }
  root.uburoomDialogs = {register, open, close, hold, confirm};
  for (const dialog of document.querySelectorAll('dialog')) register(dialog);
})(globalThis);
