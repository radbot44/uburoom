'use strict';
// The only module that knows uburoom's wire protocol. Scenarios speak in
// semantic operations (join, command, ready, ...) and read semantic room facts;
// this adapter turns them into socket messages and reads server messages back
// into facts. A protocol change replaces this file; recorded traces stay valid.
//
// Current protocol: the browser's own WatchTransport over the authenticated
// /watch-socket, HTTP-shaped `request` paths, and a full `state` republish to
// each room subscriber every server second.
//
// Facts mark values the harness must normalise: token() for random ids whose
// identity matters but whose value does not, time() for scenario-clock instants,
// account() and person() for people. Everything else is recorded as given.
const { randomUUID } = require('node:crypto');
const { WebSocket } = require('ws');
const WatchTransport = require('../../../web/watch-transport');
const { realTimer } = require('./clock');

const ROOM = id => '/api/watch/rooms/' + id;
const COMMAND_TTL_MS = 2500;
const REQUEST_REAL_TIMEOUT_MS = 10000;
const token = (kind, value) => (value === undefined || value === null ? null : { $token: kind, value });
const time = value => (value === undefined || value === null ? null : { $time: value });
const account = value => ({ $account: value });
const person = value => (value === undefined || value === null ? null : { $person: value });

/**
 * One scripted browser tab: a persona's identity, one control socket and at
 * most one joined room with a stable viewer id (reused when it reconnects).
 * `env` supplies the server fixture and the harness's in-flight tracker.
 */
class Viewer {
  constructor(env, identity, label) {
    this.env = env;
    this.identity = identity;
    this.label = label;
    this.viewerId = randomUUID();
    this.roomId = undefined;
    this.subscription = undefined;
    this.latest = undefined;
    this.kicked = false;
    this.states = 0;
    this.lastClockAt = -1;
    this.lastStateAt = -1;
  }
  async connect() {
    const { cert, config } = this.env.server;
    class Socket extends WebSocket {
      constructor(url) {
        super(url, { ca: cert, origin: config.publicUrl });
      }
    }
    this.kicked = false;
    this.latest = undefined;
    this.subscription = undefined;
    this.transport = new WatchTransport({
      url: config.publicUrl.replace('https:', 'wss:') + '/watch-socket',
      WebSocket: Socket,
      identity: () => this.identity,
      clockIntervalMs: 1000,
      onClock: message => {
        this.env.activity();
        this.lastClockAt = message.serverNow;
      },
      onMessage: message => this.receive(message),
    });
    await this.transport.connect();
    if (!this.me) {
      const me = await this.request('/api/watch/me');
      if (!me.ok) throw new Error('Scenario identity unavailable: ' + me.error);
      this.me = { accountId: me.value.account?.id, name: me.value.name };
    }
  }
  receive(message) {
    this.env.activity();
    if (message.type === 'state' && this.subscription && message.path === this.subscription) {
      this.states++;
      this.latest = { status: message.status, value: message.value };
      if (message.status === 200) this.lastStateAt = message.value.serverNow;
    }
    if (message.type === 'room-kicked' && message.roomId === this.roomId) {
      this.kicked = true;
      this.subscription = undefined;
    }
  }
  /** Sends one request; scenario time is frozen meanwhile, so it must finish on real I/O alone. */
  async request(path, data, timeoutMs) {
    this.env.pending++;
    let cancel = () => {};
    try {
      const value = await Promise.race([
        this.transport.request(path, data, timeoutMs ? { timeoutMs } : {}),
        new Promise((_resolve, reject) => {
          cancel = realTimer(REQUEST_REAL_TIMEOUT_MS, () =>
            reject(new Error('Request waited on scenario time: ' + path.split('?')[0])),
          );
        }),
      ]);
      return { ok: true, value };
    } catch (error) {
      if (/scenario time/.test(error.message)) throw error;
      return { ok: false, status: error.status, error: error.message };
    } finally {
      cancel();
      this.env.pending--;
      this.env.activity();
    }
  }
  /**
   * Abrupt loss (network drop, crashed tab) or a planned page close. Resolves
   * once the socket has closed on this side.
   */
  disconnect({ abrupt = true } = {}) {
    const transport = this.transport,
      socket = transport?.socket;
    this.transport = undefined;
    this.subscription = undefined;
    this.latest = undefined;
    if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
    const closed = new Promise(resolve => socket.once('close', () => resolve()));
    // A scripted tab reconnects only when its scenario says so.
    transport.stopped = true;
    if (abrupt) socket.terminate();
    else transport.close();
    return closed;
  }
  get connected() {
    return !!this.transport?.ready;
  }

  async createRoom({ name, visibility = 'public', keepEmpty = false }) {
    const result = await this.request('/api/watch/rooms', { name, visibility, keepEmpty });
    if (result.ok) this.roomId = result.value.id;
    return ack(result);
  }
  /** Joins (or rejoins, keeping this tab's viewer id) and subscribes to room state. */
  async join(roomId = this.roomId) {
    this.roomId = roomId;
    const path = ROOM(roomId) + '?' + new URLSearchParams({ viewer: this.viewerId, quality: 'direct' });
    const result = await this.request(path, undefined, 35000);
    if (result.ok) this.subscribed(path, result.value);
    return ack(result);
  }
  subscribed(path, state) {
    this.subscription = path;
    this.kicked = false;
    this.latest = { status: 200, value: state };
    this.lastStateAt = state.serverNow;
  }
  async leave() {
    const result = await this.request(ROOM(this.roomId) + '/leave', { viewerId: this.viewerId });
    this.subscription = undefined;
    this.latest = undefined;
    return ack(result);
  }
  /** Sends a room command fenced by the room epoch this tab sees (or, with `stale`, an outdated one). */
  async command(action, args, { stale = false } = {}) {
    const result = await this.request(
      ROOM(this.roomId) + '/command',
      {
        viewerId: this.viewerId,
        epoch: stale ? randomUUID() : this.latest?.value?.epoch,
        expiresAt: Date.now() + COMMAND_TTL_MS,
        command: { action, ...(args ? { args } : {}) },
      },
      35000,
    );
    return ack(result);
  }
  /** Reports buffered readiness for the media version this tab currently sees. */
  async ready(ready = true) {
    const state = this.latest?.value;
    return ack(
      await this.request(ROOM(this.roomId) + '/ready', {
        viewerId: this.viewerId,
        mediaVersion: state?.mediaVersion,
        ready,
        readinessVersion: state?.readinessVersion,
      }),
    );
  }
  async queueAdd(item) {
    return ack(
      await this.request(ROOM(this.roomId) + '/queue', { action: 'add', item: { mediaId: 'demo', ...item } }, 35000),
    );
  }
  /** Applies one durable room-settings change at the current settings revision. */
  async settings(change) {
    const current = await this.request(ROOM(this.roomId) + '/settings');
    if (!current.ok) return ack(current);
    return ack(await this.request(ROOM(this.roomId) + '/settings', { revision: current.value.revision, change }));
  }
  async closeRoom() {
    const result = await this.request(ROOM(this.roomId) + '/close', { epoch: this.latest?.value?.epoch });
    if (result.ok) {
      this.subscription = undefined;
      this.latest = undefined;
    }
    return ack(result);
  }
  async reopen() {
    const result = await this.request(
      ROOM(this.roomId) + '/reopen',
      { viewerId: this.viewerId, quality: 'direct' },
      35000,
    );
    if (result.ok && result.value.state)
      this.subscribed(
        ROOM(this.roomId) + '?' + new URLSearchParams({ viewer: this.viewerId, quality: 'direct' }),
        result.value.state,
      );
    return ack(result);
  }

  /** Marks the start of a tick, for fresh(). */
  beginTick() {
    this.statesAtTick = this.states;
  }
  /** After a tick: a browser exchanges a clock sample about once a second. */
  heartbeat() {
    if (this.connected) this.transport.clock();
  }
  /**
   * True once this tab's view reflects the server at scenario time `now`: a
   * clock exchange answered at `now` and, while subscribed, a room state
   * computed at `now` (or a refusal delivered after the tick began). This
   * relies on the server's once-a-second state republish; a push-on-change
   * protocol must give this adapter an equivalent "view is current" signal
   * (for example an explicit resync) without changing what the views contain.
   */
  fresh(now) {
    if (!this.connected) return true;
    if (this.lastClockAt < now) return false;
    if (!this.subscription) return true;
    return this.latest?.status === 200 ? this.lastStateAt >= now : this.states > this.statesAtTick;
  }

  /** Semantic room facts as this tab sees them. */
  view() {
    if (!this.transport) return { connection: 'closed' };
    if (this.kicked) return { connection: 'open', room: 'removed' };
    if (!this.subscription || !this.latest) return { connection: 'open', room: 'none' };
    if (this.latest.status !== 200)
      return { connection: 'open', room: 'refused', refusal: this.latest.status + ' ' + this.latest.value?.error };
    const s = this.latest.value,
      summary = s.queueSummary;
    return {
      connection: 'open',
      room: 'joined',
      role: s.roomRole,
      host: person(s.hostName),
      isHost: !!s.isHost,
      waitingForHost: !!s.waitingForHost,
      canPlayback: !!s.canPlayback,
      participants: (s.participants || []).map(p => ({ who: account(p.id), role: p.role, present: !!p.present })),
      epoch: token('epoch', s.epoch),
      media: s.mediaId ? { id: s.mediaId, title: s.title, version: token('media', s.mediaVersion) } : null,
      timeline: {
        paused: !!s.state?.paused,
        position: s.state?.position,
        duration: s.state?.duration,
        startAt: time(s.startAt),
        pauseAt: time(s.pauseAt),
      },
      readiness: {
        waiting: !!s.waitingForReady,
        gate: s.readiness
          ? {
              id: token('readiness', s.readiness.id),
              timedOut: !!s.readiness.timedOut,
              canStart: !!s.readiness.canStart,
              blockers: (s.readiness.blockers || []).map(person),
            }
          : null,
      },
      queue: summary
        ? {
            current: summary.current?.title ?? null,
            next: summary.next?.title ?? null,
            pending: summary.pendingCount,
            history: summary.historyCount,
          }
        : null,
      autoplay: s.autoplay
        ? {
            enabled: !!s.autoplay.enabled,
            countdown: s.autoplay.countdown
              ? { title: s.autoplay.countdown.title, endsAt: time(s.autoplay.countdown.endsAt) }
              : null,
          }
        : null,
      ending: s.ending
        ? { state: s.ending.state, completed: s.ending.completed?.title ?? null, next: s.ending.next?.title ?? null }
        : null,
      recovery: s.recovery ? { missing: s.recovery.missing } : null,
      errors: [s.mediaError, s.saveError, s.autoplay?.error, s.ending?.error].filter(Boolean),
    };
  }
}

/** A request's observable acknowledgement: outcome, or HTTP-like refusal. */
function ack(result) {
  if (!result.ok) return { ok: false, status: result.status ?? 'connection', error: result.error };
  const outcome = result.value?.status;
  // Room commands answer with their own applied/refused outcome.
  if (typeof outcome !== 'string') return { ok: true };
  return outcome === 'applied' ? { ok: true, outcome } : { ok: false, outcome, message: result.value.message };
}

module.exports = { Viewer };
