'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../web/watch-scrollbars.js'), 'utf8');

function start({ scrollbarsHiding = true, vendor = true } = {}) {
  const observers = new Map();
  const domEvents = new Map();
  const createElement = (id, extra = {}) => Object.assign({
    id,
    hidden: false,
    open: false,
    classList: {
      values: new Set(),
      contains(value) { return this.values.has(value); },
      add(value) { this.values.add(value); },
      remove(value) { this.values.delete(value); }
    }
  }, extra);
  const elements = new Map([
    ['room-column', createElement('room-column')],
    ['room-settings-dialog', createElement('room-settings-dialog')],
    ['room-settings-content', createElement('room-settings-content', { hidden: true })],
    ['room-settings-panels', createElement('room-settings-panels')]
  ]);
  const body = createElement('body');
  const doc = {
    body,
    currentScript: { dataset: { osStyleNonce: 'nonceTest123' } },
    readyState: 'loading',
    getElementById(id) { return elements.get(id) || null; },
    addEventListener(type, cb) { domEvents.set(type, cb); }
  };
  const media = new Map([
    ['(min-width: 1101px)', true],
    ['(pointer: fine)', true],
    ['(forced-colors: active)', false]
  ].map(([query, matches]) => [query, {
    matches,
    listeners: [],
    addEventListener(type, cb) { if (type === 'change') this.listeners.push(cb); },
    change(value) { this.matches = value; this.listeners.forEach(fn => fn()); }
  }]));
  const calls = [];
  function OverlayScrollbars(target, options) {
    const element = target.target || target;
    const entry = {
      element, target, options, destroyed: false,
      changes: [],
      state() { return { destroyed: this.destroyed }; },
      destroy() { this.destroyed = true; },
      options(value) { this.changes.push(value); }
    };
    calls.push(entry);
    return entry;
  }
  OverlayScrollbars.env = () => ({ scrollbarsHiding });
  OverlayScrollbars.nonce = value => { OverlayScrollbars.styleNonce = value; };
  class MutationObserver {
    constructor(fn) { this.fn = fn; }
    observe(element) {
      if (!observers.has(element)) observers.set(element, []);
      observers.get(element).push(this.fn);
    }
  }
  const ctx = {
    window: { OverlayScrollbarsGlobal: vendor ? { OverlayScrollbars } : undefined },
    document: doc,
    matchMedia: query => media.get(query),
    MutationObserver
  };
  vm.runInNewContext(script, ctx);
  const notify = element => (observers.get(element) || []).forEach(fn => fn());
  const active = element => calls.filter(call => call.element === element && !call.destroyed);
  const load = () => {
    elements.set('drawer', createElement('drawer', { hidden: true }));
    doc.readyState = 'complete';
    domEvents.get('DOMContentLoaded')?.();
  };
  return { calls, elements, body, doc, notify, active, load, media, OverlayScrollbars };
}

test('custom scrollbars handle the page, immersive drawer, and settings without touching Room/Queue', () => {
  const app = start();
  assert.equal(app.OverlayScrollbars.styleNonce, 'nonceTest123');
  assert.equal(app.active(app.body).length, 1);
  app.load();
  const column = app.elements.get('room-column');
  const drawer = app.elements.get('drawer');
  const panels = app.elements.get('room-settings-panels');
  assert.equal(app.active(column).length, 0, 'Room/Queue stack uses only page scrolling');
  assert.equal(app.active(drawer).length, 0);
  assert.equal(app.active(panels).length, 0);

  app.body.classList.add('immersive'); app.notify(app.body);
  assert.equal(app.active(app.body)[0].changes.at(-1).overflow.y, 'hidden');
  drawer.hidden = false; app.notify(drawer);
  assert.equal(app.active(drawer).length, 1);
  assert.equal(app.active(drawer)[0].target.elements.viewport, drawer);
  drawer.hidden = true; app.notify(drawer);
  assert.equal(app.active(drawer).length, 0);
  app.body.classList.remove('immersive'); app.notify(app.body);
  assert.equal(app.active(app.body)[0].changes.at(-1).overflow.y, 'scroll');
  assert.equal(app.active(column).length, 0);

  const dialog = app.elements.get('room-settings-dialog');
  const content = app.elements.get('room-settings-content');
  dialog.open = true; app.notify(dialog);
  assert.equal(app.active(panels).length, 0);
  content.hidden = false; app.notify(content);
  assert.equal(app.active(panels).length, 1);
  assert.equal(app.active(panels)[0].target.elements.viewport, panels);
  dialog.open = false; app.notify(dialog);
  assert.equal(app.active(panels).length, 0);
});

test('touch, high contrast, unsupported browsers and missing vendor use native inner scrollbars', () => {
  const app = start(); app.load();
  const dialog = app.elements.get('room-settings-dialog');
  const content = app.elements.get('room-settings-content');
  const panels = app.elements.get('room-settings-panels');
  dialog.open = true; content.hidden = false; app.notify(dialog);
  assert.equal(app.active(panels).length, 1);
  app.media.get('(pointer: fine)').change(false);
  assert.equal(app.active(panels).length, 0);
  app.media.get('(pointer: fine)').change(true);
  assert.equal(app.active(panels).length, 1);
  app.media.get('(forced-colors: active)').change(true);
  assert.equal(app.active(panels).length, 0);
  const unsupported = start({ scrollbarsHiding: false }); unsupported.load();
  assert.equal(unsupported.active(unsupported.elements.get('room-column')).length, 0);
  const missing = start({vendor: false});
  assert.equal(missing.calls.length, 0);
});
