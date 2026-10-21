/* Opt-in watch controls. Panel modules retain state, permissions and actions. */
(function(root) {
  'use strict';
  const groups = new WeakMap();
  function content(control, {label, icon, iconOnly = false}) {
    const doc = control.ownerDocument;
    control.replaceChildren();
    if (icon) control.append(root.uburoomIcons.icon(doc,icon));
    const text = doc.createElement('span'); text.className = 'watch-control-label'; text.textContent = label;
    if (!iconOnly) control.append(text);
    control.classList.add('watch-control');
    control.classList.toggle('watch-control-icon',iconOnly);
    control.classList.toggle('watch-control-responsive',!!icon && !iconOnly);
    control.setAttribute('aria-label',label); control.title = label;
    return control;
  }
  function button(doc, {label, icon, iconOnly = false, action, disabled = false}) {
    const control = doc.createElement('button'); control.type = 'button';
    control.className = iconOnly ? 'icon-button' : 'quiet'; control.disabled = disabled;
    content(control,{label,icon,iconOnly});
    if (action) control.addEventListener('click',action);
    return control;
  }
  function switchPill(doc, {label, checked = false, editable = true, disabled = false, onChange, action, variant = 'switch'}) {
    const element = doc.createElement('div'); element.className = 'watch-switch-pill';
    const permission = variant === 'permission';
    element.classList.toggle('watch-permission-pill',permission);
    const controlLabel = doc.createElement('label'), badge = doc.createElement('span');
    controlLabel.className = badge.className = 'watch-switch-pill-body';
    const text = doc.createElement('span'); text.className = 'watch-switch-pill-label';
    label.split('/').forEach((part,index) => { if (index) text.append(doc.createTextNode('/'),doc.createElement('wbr')); text.append(doc.createTextNode(part)); });
    const state = doc.createElement('span'); state.className = 'watch-switch-pill-state';
    const input = doc.createElement('input'); input.type = 'checkbox';
    input.className = permission ? 'watch-permission-input' : 'watch-switch';
    if (!permission) input.setAttribute('role','switch');
    const indicator = permission ? doc.createElement('span') : undefined;
    if (indicator) { indicator.className = 'watch-permission-indicator'; indicator.setAttribute('aria-hidden','true'); }
    let currentEditable = editable;
    const actionButton = action ? button(doc,{label:action.label,icon:action.icon || 'settings',iconOnly:true,action:action.onClick}) : undefined;
    actionButton?.classList.add('watch-switch-pill-action');
    function update({checked = input.checked, editable = currentEditable, disabled = input.disabled} = {}) {
      currentEditable = editable;
      input.checked = checked; input.disabled = disabled;
      element.classList.toggle('is-on',checked); element.classList.toggle('is-readonly',!editable);
      element.classList.toggle('is-disabled',disabled);
      element.classList.toggle('watch-switch-pill-split',!!actionButton && editable);
      const stateText = permission ? (checked ? ': Allowed' : ': Denied') : (checked ? ': On' : ': Off');
      element.title = label + stateText;
      if (indicator) {
        const slug = checked ? 'thumb-up' : 'thumb-down';
        const normal = root.uburoomIcons.icon(doc,slug), hover = root.uburoomIcons.icon(doc,slug + '-off');
        normal.classList.add('watch-permission-normal'); hover.classList.add('watch-permission-hover');
        indicator.replaceChildren(normal,hover);
      }
      const body = editable ? controlLabel : badge;
      if (element.firstChild !== body) {
        if (editable) controlLabel.replaceChildren(text,input);
        else badge.replaceChildren(text,state);
        if (indicator) body.append(indicator);
        element.replaceChildren(body);
        if (editable && actionButton) element.append(actionButton);
      }
      state.textContent = stateText;
      if (actionButton) actionButton.disabled = disabled;
    }
    update({checked,editable,disabled});
    input.addEventListener('change',event => { update({checked:input.checked,editable:currentEditable,disabled:input.disabled}); onChange?.(event); });
    return {element,input,update};
  }
  function segmented(group) {
    if (groups.has(group)) { groups.get(group)(); return; }
    group.classList.add('watch-segmented');
    const buttons = () => [...group.querySelectorAll('button')].filter(control => !control.disabled && !control.hidden);
    function refresh() {
      const choices = buttons();
      const entry = choices.includes(group.ownerDocument.activeElement) ? group.ownerDocument.activeElement :
        choices.find(control => control.getAttribute('aria-pressed') === 'true') || choices[0];
      for (const control of group.querySelectorAll('button')) control.tabIndex = control === entry ? 0 : -1;
    }
    group.addEventListener('focusin',refresh);
    group.addEventListener('keydown',event => {
      if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
      const choices = buttons(), index = choices.indexOf(event.target);
      if (index < 0 || !choices.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 :
        (index + (['ArrowRight','ArrowDown'].includes(event.key) ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus(); // Native Enter/Space activates; arrows never select.
    });
    new MutationObserver(refresh).observe(group,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','aria-pressed']});
    groups.set(group,refresh); refresh();
  }
  function bindSelect(select, group) {
    function refresh() {
      for (const control of group.querySelectorAll('button')) {
        control.setAttribute('aria-pressed',String(control.dataset.value === select.value));
        control.disabled = select.disabled;
      }
      segmented(group);
    }
    group.addEventListener('click',event => {
      const control = event.target.closest('button');
      if (!control || control.disabled || control.dataset.value === 'custom' || select.disabled || select.value === control.dataset.value) return;
      select.value = control.dataset.value;
      select.dispatchEvent(new Event('change',{bubbles:true})); refresh();
    });
    const prop = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value');
    Object.defineProperty(select,'value',{get() { return prop.get.call(this); },set(value) { prop.set.call(this,value); refresh(); },configurable:true});
    new MutationObserver(refresh).observe(select,{attributes:true,attributeFilter:['disabled']});
    select.addEventListener('change',refresh); refresh();
  }
  root.uburoomControls = {button,content,switchPill,segmented,bindSelect};
})(globalThis);
