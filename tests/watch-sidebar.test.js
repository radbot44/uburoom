'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../web/watch-sidebar.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../web/watch.css'), 'utf8');

function start({ height = 1320, viewport = 900, desktop = true } = {}) {
  const events = new Map();
  const column = {
    offsetHeight: height,
    scrollTop: 0,
    style: {
      top: '',
      removeProperty(property) { if (property === 'top') this.top = ''; }
    }
  };
  const body = {
    classList: {
      values: new Set(),
      contains(name) { return this.values.has(name); },
      add(name) { this.values.add(name); },
      remove(name) { this.values.delete(name); }
    }
  };
  const win = {
    innerHeight: viewport,
    scrollY: 0,
    addEventListener(name, callback) { events.set(name, callback); }
  };
  const media = {
    matches: desktop,
    addEventListener(name, callback) { this.onChange = callback; }
  };
  let resizeColumn, bodyChanged;
  class ResizeObserver {
    constructor(callback) { this.callback = callback; }
    observe(element) { if (element === column) resizeColumn = this.callback; }
  }
  class MutationObserver {
    constructor(callback) { this.callback = callback; }
    observe(element) { if (element === body) bodyChanged = this.callback; }
  }
  vm.runInNewContext(script, {
    document: { body, getElementById: id => id === 'room-column' ? column : null },
    window: win,
    matchMedia: () => media,
    ResizeObserver, MutationObserver,
    requestAnimationFrame: callback => callback()
  });

  return {
    column, body, win, media,
    top: () => Number.parseFloat(column.style.top),
    scroll(y) { win.scrollY = y; events.get('scroll')(); },
    resize(height, viewport) {
      column.offsetHeight = height;
      win.innerHeight = viewport;
      resizeColumn();
    },
    setDesktop(value) { media.matches = value; media.onChange(); },
    bodyChanged: () => bodyChanged()
  };
}

test('Room and Queue use page scroll instead of a constrained scroll pane', () => {
  assert.match(css, /body:not\(\.immersive\) #room-column\{[^}]*position:sticky[^}]*max-height:none;overflow:visible\}/);
  const app = start();
  assert.equal(app.column.scrollTop, 0);
  assert.equal(app.top(), 22);
  app.scroll(300);
  assert.equal(app.top(), -278, 'a tall column travels upwards with the page');
  app.scroll(900);
  assert.equal(app.top(), -442, 'the column bottom rests 22px from viewport bottom');
  app.scroll(1300);
  assert.equal(app.top(), -442, 'bottom remains sticky on further downward scroll');
  app.scroll(1100);
  assert.equal(app.top(), -242, 'scrolling back up reveals top of the stack');
  app.scroll(500);
  assert.equal(app.top(), 22, 'top sticks when scrolling farther up');
  assert.equal(app.column.scrollTop, 0, 'the column is never scrolled independently');
});

test('short stack stays top-sticky; mobile, immersive, and resize reset naturally', () => {
  const app = start({height:620,viewport:900});
  app.scroll(500);
  assert.equal(app.top(), 22);
  app.resize(1250,900);
  app.scroll(650);
  assert.equal(app.top(), -128);
  app.setDesktop(false);
  assert.equal(app.column.style.top, '', 'stacked layout uses normal flow');
  app.scroll(750);
  app.setDesktop(true);
  assert.equal(app.top(), 22);
  app.body.classList.add('immersive'); app.bodyChanged();
  assert.equal(app.column.style.top, '', 'fullscreen layout has no page sticky offset');
  app.body.classList.remove('immersive'); app.bodyChanged();
  assert.equal(app.top(), 22);
  app.body.classList.add('activity-pip'); app.bodyChanged();
  assert.equal(app.column.style.top, '');
  app.body.classList.remove('activity-pip'); app.bodyChanged();
  app.body.classList.add('mobile-player'); app.bodyChanged();
  assert.equal(app.column.style.top, '', 'mobile player uses its existing layout');
});
