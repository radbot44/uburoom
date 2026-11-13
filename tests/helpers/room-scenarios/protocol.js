'use strict';
// The only module that knows uburoom's wire protocol. Scenarios speak in
// semantic operations (join, command, ready, ...) and read semantic room facts;
// this adapter turns them into socket messages and reads server messages back
// into facts. A protocol change replaces this file; recorded traces stay valid.
//
// Current protocol: the browser's own WatchTransport over the authenticated
// /watch-socket, typed messages (shared/wire-protocol.mjs), and room state pushed
// in two lanes when it changes. After every scenario second each tab asks for an
// explicit `resync`, so its view is the server's at that instant.
//
// Facts mark values the harness must normalise: token() for random ids whose
// identity matters but whose value does not, time() for scenario-clock instants,
// account() and person() for people. Everything else is recorded as given.
const { randomUUID } = require('node:crypto');
const https = require('node:https');
const { WebSocket } = require('ws');
const { WatchTransport } = require('../../../web/watch-transport');
const { mergeView, lanesAgree } = require('../../../shared/wire-protocol.mjs');
const { realTimer, scenarioNow } = require('./clock');

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
    this.subscribed = false;
    this.lanes = undefined;
    this.latest = undefined;
    this.kicked = false;
    this.lastClockAt = -1;
    this.lastResyncAt = -1;
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
    this.subscribed = false;
    this.lastResyncAt = scenarioNow();
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
      const me = await this.request('me', transport => transport.call('me'));
      if (!me.ok) throw new Error('Scenario identity unavailable: ' + me.error);
      this.me = { accountId: me.value.account?.id, name: me.value.name };
    }
  }
  receive(message) {
    this.env.activity();
    if (!this.subscribed || message.roomId !== this.roomId) return;
    if ((message.type === 'room' || message.type === 'viewer') && message.viewerId === this.viewerId) {
      this.lanes[message.type] = message.state;
      // A tab shows its two lanes together once they describe the same video.
      if (lanesAgree(this.lanes.room, this.lanes.viewer))
        this.latest = { status: 200, value: mergeView(this.lanes.room, this.lanes.viewer) };
    }
    if (message.type === 'error' && message.code === 'room')
      this.latest = { status: message.status, value: { error: message.message } };
    if (message.type === 'error' && message.code === 'removed') {
      this.kicked = true;
      this.subscribed = false;
    }
  }
  /** Sends one request; scenario time is frozen meanwhile, so it must finish on real I/O alone. */
  async request(label, send) {
    const detached = this.detaching;
    this.detaching = false;
    if (!detached) this.env.pending++;
    let cancel = () => {};
    try {
      const value = await Promise.race([
        send(this.transport),
        new Promise((_resolve, reject) => {
          cancel = realTimer(REQUEST_REAL_TIMEOUT_MS, () =>
            reject(new Error('Request waited on scenario time: ' + label)),
          );
        }),
      ]);
      return { ok: true, value };
    } catch (error) {
      if (/scenario time/.test(error.message)) throw error;
      return { ok: false, status: error.status, error: error.message };
    } finally {
      cancel();
      if (!detached) this.env.pending--;
      this.env.activity();
    }
  }
  /**
   * Starts one operation (join, command, ...) without making the harness wait
   * for its answer, for a request the fake Plex is holding. Returns the
   * operation's promise; await it after the gate is released.
   */
  background(operation) {
    this.detaching = true;
    try {
      return operation();
    } finally {
      this.detaching = false;
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
    this.subscribed = false;
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

  call(op, input, timeoutMs) {
    return this.request(op, transport => transport.call(op, input, timeoutMs ? { timeoutMs } : {}));
  }
  async createRoom({ name, visibility = 'public', keepEmpty = false }) {
    const result = await this.call('rooms.create', { args: { name, visibility, keepEmpty } });
    if (result.ok) this.roomId = result.value.id;
    return ack(result);
  }
  /** Joins (or rejoins, keeping this tab's viewer id) and subscribes to room state. */
  async join(roomId = this.roomId) {
    this.roomId = roomId;
    const result = await this.request('join', transport =>
      transport.join(roomId, this.viewerId, { quality: 'direct' }, { timeoutMs: 35000 }),
    );
    if (result.ok) {
      this.subscribed = true;
      this.kicked = false;
      this.lanes = { room: result.value.room.state, viewer: result.value.viewer.state };
      this.latest = { status: 200, value: mergeView(this.lanes.room, this.lanes.viewer) };
    }
    return ack(result);
  }
  async leave() {
    const result = await this.request('leave', transport => transport.leave(this.roomId, this.viewerId));
    this.subscribed = false;
    this.latest = undefined;
    return ack(result);
  }
  /** Sends a room command fenced by the room epoch this tab sees (or, with `stale`, an outdated one). */
  async command(action, args, { stale = false } = {}) {
    const envelope = {
      viewerId: this.viewerId,
      epoch: stale ? randomUUID() : this.latest?.value?.epoch,
      expiresAt: scenarioNow() + COMMAND_TTL_MS,
      command: { action, ...(args ? { args } : {}) },
    };
    return ack(
      await this.request('command', transport => transport.command(this.roomId, envelope, { timeoutMs: 35000 })),
    );
  }
  /** Reports buffered readiness for the media version this tab currently sees. */
  async ready(ready = true) {
    const state = this.latest?.value,
      report = { mediaVersion: state?.mediaVersion, ready, readinessVersion: state?.readinessVersion };
    return ack(await this.request('ready', transport => transport.reportReady(this.roomId, this.viewerId, report)));
  }
  async queueAdd(item) {
    return ack(
      await this.call(
        'room.queue.command',
        { roomId: this.roomId, args: { action: 'add', item: { mediaId: 'demo', ...item } } },
        35000,
      ),
    );
  }
  /** Applies one durable room-settings change at the current settings revision. */
  async settings(change) {
    const current = await this.call('room.settings', { roomId: this.roomId });
    if (!current.ok) return ack(current);
    return ack(
      await this.call('room.settings.edit', {
        roomId: this.roomId,
        args: { revision: current.value.revision, change },
      }),
    );
  }
  async closeRoom() {
    const result = await this.call('room.close', { roomId: this.roomId, args: { epoch: this.latest?.value?.epoch } });
    if (result.ok) {
      this.subscribed = false;
      this.latest = undefined;
    }
    return ack(result);
  }
  /** Reopens a closed room from the database and joins it. */
  async reopen() {
    const result = await this.call('room.reopen', { roomId: this.roomId }, 35000);
    return result.ok ? this.join() : ack(result);
  }

  /**
   * HTTP status the server gives this tab's current media URL right now: 200
   * while its viewing grant is valid, 403 once it has lapsed; null with no URL.
   */
  async mediaStatus() {
    const { cert, config } = this.env.server,
      url = this.latest?.value?.mediaUrl;
    if (!url) return null;
    this.env.pending++;
    let cancel = () => {};
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          const request = https.request(config.publicUrl + url, { method: 'HEAD', ca: cert }, response => {
            response.resume();
            resolve(response.statusCode);
          });
          request.on('error', reject);
          request.end();
        }),
        new Promise((_resolve, reject) => {
          cancel = realTimer(REQUEST_REAL_TIMEOUT_MS, () => reject(new Error('Media request waited on scenario time')));
        }),
      ]);
    } finally {
      cancel();
      this.env.pending--;
      this.env.activity();
    }
  }

  /** Marks the start of a tick. */
  beginTick() {}
  /**
   * After a tick: a browser exchanges a clock sample about once a second, and the
   * tab asks for an explicit resync so its view is the server's at this instant.
   * (The server's own slow resync does the same, less often.)
   */
  heartbeat() {
    if (!this.connected) return;
    const transport = this.transport;
    transport.clock();
    transport.resync({ timeoutMs: 35000 }).then(
      value => {
        if (this.transport === transport) this.lastResyncAt = value.serverNow;
        this.env.activity();
      },
      () => this.env.activity(),
    );
  }
  /**
   * True once this tab's view reflects the server at scenario time `now`: a
   * clock exchange and a resync, both answered at `now`. Between ticks the view
   * moves only by what the server pushes.
   */
  fresh(now) {
    if (!this.connected) return true;
    return this.lastClockAt >= now && this.lastResyncAt >= now;
  }

  /** Semantic room facts as this tab sees them. */
  view() {
    if (!this.transport) return { connection: 'closed' };
    if (this.kicked) return { connection: 'open', room: 'removed' };
    if (!this.subscribed || !this.latest) return { connection: 'open', room: 'none' };
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
      // This tab's own stream: what it was given to play and whether it may fetch it.
      stream: {
        format: s.format ?? null,
        version: token('stream', s.streamVersion),
        granted: !!s.mediaUrl,
      },
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
