'use strict';
// Runs one scripted room scenario against a real server on the scenario clock
// and returns its semantic trace: after each step, the room facts each tab sees
// that changed since the previous step, with random ids, people and instants
// normalised. Wire details stay in ./protocol.
const { installClock, realDelay, realNow, START } = require('./clock');
const { startServer } = require('./server');
const { Viewer } = require('./protocol');

const PERSONAS = { alice: 'host', bob: 'guest', carol: 'guest2' };
// After every tab is fresh, this long (real time) without a message or request
// means the server has finished reacting to the tick.
const QUIET_MS = 10;
const SETTLE_LIMIT_MS = 15000;

class Scenario {
  constructor(server, clock) {
    this.server = server;
    this.clock = clock;
    this.viewers = [];
    this.steps = [];
    this.previous = new Map();
    this.tokens = new Map();
    this.env = {
      server,
      pending: 0,
      lastActivity: realNow(),
      activity: () => {
        this.env.lastActivity = realNow();
      },
    };
  }
  /** A browser tab for one fixture person; `bob-tab2` is a second tab of bob's. */
  async tab(label, person = label.split('-')[0]) {
    const persona = PERSONAS[person];
    if (!persona) throw new Error('Unknown scenario person ' + person);
    const viewer = new Viewer(this.env, await this.server.login(persona), label);
    viewer.person = person;
    this.viewers.push(viewer);
    return viewer;
  }
  /**
   * Runs an action, lets `wait` milliseconds of scenario time pass (default one
   * server second), then records what every tab sees.
   */
  async step(description, action, { wait = 1000 } = {}) {
    const result = action ? await action() : undefined;
    await this.advance(wait);
    const views = {};
    for (const viewer of this.viewers) {
      const view = this.normalise(viewer.view()),
        before = this.previous.get(viewer);
      this.previous.set(viewer, view);
      // A tab's first view, or one in a different room situation, is recorded
      // whole; otherwise only the facts that changed.
      if (!before || before.connection !== view.connection || before.room !== view.room) {
        views[viewer.label] = view;
        continue;
      }
      const changed = Object.entries(view).filter(
        ([key, item]) => JSON.stringify(item) !== JSON.stringify(before[key]),
      );
      if (changed.length) views[viewer.label] = Object.fromEntries(changed);
    }
    this.steps.push({
      at: this.clock.elapsed(),
      step: description,
      ...(result === undefined ? {} : { result: this.normalise(result) }),
      views,
    });
    return result;
  }
  /**
   * Stops and restarts the server on the same database; every tab loses its
   * socket. Fixture sign-ins do not survive a restart, so each person signs in again.
   */
  async restart() {
    await Promise.all(this.viewers.map(viewer => viewer.disconnect()));
    await this.server.restart();
    for (const viewer of this.viewers) viewer.identity = await this.server.login(PERSONAS[viewer.person]);
  }
  /** Moves scenario time forward one server second at a time, settling after each. */
  async advance(ms) {
    await this.settle();
    for (let left = ms; left > 0; left -= 1000) {
      for (const viewer of this.viewers) viewer.beginTick();
      this.clock.tick(Math.min(1000, left));
      for (const viewer of this.viewers) viewer.heartbeat();
      await this.settle();
    }
  }
  /** Waits until every tab has seen the server at the current instant and I/O is quiet. */
  async settle() {
    const now = Date.now(),
      started = realNow();
    for (;;) {
      // Poll on event-loop turns (timers are coarse on Windows); back off once a wait is clearly long.
      await (realNow() - started < 200 ? new Promise(setImmediate) : realDelay(1));
      const stale = this.viewers.filter(viewer => !viewer.fresh(now));
      if (!stale.length && !this.env.pending && realNow() - this.env.lastActivity >= QUIET_MS) return;
      if (realNow() - started > SETTLE_LIMIT_MS)
        throw new Error(
          `Room scenario did not settle at ${now - START}ms: ${stale.map(v => v.label).join(', ') || 'requests in flight'}`,
        );
    }
  }
  person(kind, value) {
    const viewer = this.viewers.find(v => (kind === 'account' ? v.me?.accountId : v.me?.name) === value);
    return viewer ? viewer.person : kind === 'account' ? 'unknown account' : value;
  }
  normalise(value) {
    if (Array.isArray(value)) return value.map(item => this.normalise(item));
    if (typeof value === 'number') return Math.round(value * 1000) / 1000;
    if (!value || typeof value !== 'object') return value;
    if ('$token' in value) {
      const kind = value.$token,
        seen = this.tokens.get(kind) || new Map();
      this.tokens.set(kind, seen);
      if (!seen.has(value.value)) seen.set(value.value, seen.size + 1);
      return kind + '#' + seen.get(value.value);
    }
    if ('$time' in value) return value.$time - START;
    if ('$account' in value) return this.person('account', value.$account);
    if ('$person' in value) return this.person('name', value.$person);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.normalise(item)]));
  }
}

/** Runs a scenario definition `{ name, disk, run(scenario) }` and returns its trace. */
async function runScenario(definition) {
  const clock = installClock();
  let server, scenario;
  try {
    server = await startServer({ disk: !!definition.disk });
    scenario = new Scenario(server, clock);
    await definition.run(scenario);
    return { scenario: definition.name, steps: scenario.steps };
  } finally {
    try {
      await Promise.all((scenario?.viewers || []).map(viewer => viewer.disconnect({ abrupt: false })));
      await server?.close();
      // Late socket callbacks still clear scenario timers. Clearing a timer of
      // an uninstalled clock corrupts the next one, so let them run first.
      await realDelay(20);
    } finally {
      clock.uninstall();
    }
  }
}
module.exports = { runScenario };
