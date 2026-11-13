'use strict';
// Mounts one web/watch module in Node for a test. The test gives one flat object of values; each name goes
// where the page keeps it: a store field (web/watch/store.js), a browser global (installed until `restore`),
// or a dependency passed to mount(). `view` reads and writes every name back from that place, so a test can
// set `view.hlsRecoveryCount = 2` and read `view.playbackError` after a call. Elements the module looks up
// are inert stand-ins; a module under test gets its real behaviour from the values the test supplies.
const { store } = require('../../web/watch/store.js');

const defaults = structuredClone(
  Object.fromEntries(Object.entries(store).map(([area, fields]) => [area, { ...fields }])),
);
const AREA = Object.fromEntries(
  Object.entries(store).flatMap(([area, fields]) => Object.keys(fields).map(name => [name, area])),
);
const GLOBALS = new Set([
  'performance',
  'Date',
  'document',
  'navigator',
  'Hls',
  'location',
  'window',
  'fetch',
  'MediaSource',
  'localStorage',
  'sessionStorage',
  'innerWidth',
  'innerHeight',
  'requestAnimationFrame',
  'cancelAnimationFrame',
]);

/** An element stand-in: records listeners, accepts any property, answers queries with more stand-ins. */
function element(tag = 'div') {
  const listeners = {};
  const own = {
    tagName: tag.toUpperCase(),
    listeners,
    children: [],
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    hidden: false,
    disabled: false,
    textContent: '',
    value: '',
    addEventListener: (type, run) => (listeners[type] = run),
    removeEventListener() {},
    querySelector: () => element(),
    querySelectorAll: () => [],
    closest: () => null,
    contains: () => false,
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    getAttribute: () => null,
    getClientRects: () => [],
  };
  return new Proxy(own, {
    get(target, key) {
      if (key in target) return target[key];
      if (typeof key === 'symbol') return undefined;
      return (...args) =>
        /^(append|prepend|replaceChildren|before|after|remove|focus|blur|set|toggle|scroll)/.test(key)
          ? undefined
          : element(String(args[0] || 'div'));
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  });
}

function stubDocument(overrides = {}) {
  const byId = new Map();
  const doc = {
    visibilityState: 'visible',
    body: element('body'),
    documentElement: element('html'),
    getElementById: id => byId.get(id) || byId.set(id, element()).get(id),
    createElement: tag => element(tag),
    createElementNS: (ns, tag) => element(tag),
    createTextNode: text => ({ textContent: text }),
    querySelector: () => element(),
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    ...overrides,
  };
  return doc;
}

/**
 * @param {{mount: (host: any, deps: any) => any}} module
 * @param {Record<string, any>} values
 * @returns {{view: Record<string, any>, api: Record<string, any>, deps: Record<string, any>, restore: () => void}}
 */
function mountModule(module, values = {}) {
  for (const [area, fields] of Object.entries(defaults)) {
    for (const key of Object.keys(store[area])) delete store[area][key];
    Object.assign(store[area], structuredClone(fields));
  }
  const saved = new Map();
  const install = (name, value) => {
    if (!saved.has(name)) saved.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  install('document', stubDocument(values.document));
  if (!('window' in values))
    install('window', {
      addEventListener() {},
      removeEventListener() {},
      matchMedia: () => ({ matches: false, addEventListener() {} }),
    });
  const deps = {};
  for (const [name, value] of Object.entries(values)) {
    if (name === 'document') continue;
    if (AREA[name]) store[AREA[name]][name] = value;
    else if (GLOBALS.has(name)) install(name, value);
    else deps[name] = value;
  }
  // A test's time object only needs what the module under test reads; the rest is real time.
  deps.time = Object.setPrototypeOf(deps.time || {}, {
    mono: () => performance.now(),
    wall: () => Date.now(),
    setTimeout: (run, ms) => setTimeout(run, ms),
    clearTimeout: id => clearTimeout(id),
  });
  deps.video ??= element('video');
  deps.video.addEventListener ??= () => {};
  deps.video.removeEventListener ??= () => {};
  deps.every ??= () => () => {};
  const depsView = new Proxy(deps, {
    get: (target, key) => (key in target ? target[key] : typeof key === 'string' ? () => undefined : undefined),
  });
  const api = module.mount(element(), depsView);
  Object.assign(deps, api);
  const view = new Proxy(
    {},
    {
      get: (_, key) =>
        AREA[key] ? store[AREA[key]][key] : GLOBALS.has(key) ? globalThis[key] : key === 'store' ? store : deps[key],
      set: (_, key, value) => {
        if (AREA[key]) store[AREA[key]][key] = value;
        else if (GLOBALS.has(key)) install(key, value);
        else deps[key] = value;
        return true;
      },
    },
  );
  const restore = () => {
    for (const [name, descriptor] of saved)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    saved.clear();
  };
  return { view, api, deps, restore };
}

module.exports = { mountModule, element, stubDocument, AREA };
