// @ts-check
/* The room connection: typed messages (shared/wire-protocol.mjs), bounded reconnect and
 * no command replay. Requests are answered by `ack` or `error`; room, viewer and lobby
 * state arrive as pushes and go to `onMessage`. */
/** @typedef {{token?: string, csrf?: string}} WatchSocketIdentity */
/** @typedef {{timeoutMs?: number, signal?: AbortSignal}} WatchRequestOptions */
import * as Wire from '../shared/wire-protocol.mjs';

const CLOCK_TIMEOUT_MS = 5000,
  HEARTBEAT_TIMEOUT_MS = 30000;
class WatchTransport {
  constructor(options = {}) {
    const {
      url,
      identity,
      onReady = () => {},
      onClose = () => {},
      onMessage = () => {},
      beginClock = () => {},
      onClock = () => {},
      clockTimeoutMs = CLOCK_TIMEOUT_MS,
      heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    } = options;
    Object.assign(
      this,
      { url, identity, onReady, onClose, onMessage, beginClock, onClock, clockTimeoutMs, heartbeatTimeoutMs },
      options,
    );
    this.pending = new Map();
    this.clockPending = undefined;
    this.queue = [];
    this.sequence = 0;
    this.attempt = 0;
    this.stopped = false;
    this.connectionAttempt = 0;
    this.connectionId = undefined;
    this.closeInitiator = undefined;
  }
  connect() {
    if (this.ready && this.socket?.readyState === 1) return Promise.resolve();
    if (this.connecting) return this.connecting;
    // A manual reconnect supersedes any pending automatic retry. Otherwise
    // its orphan timer can later resurrect a deliberately closed transport.
    clearTimeout(this.retry);
    this.retry = undefined;
    this.stopped = false;
    this.connecting = new Promise((resolve, reject) => {
      this.authResolve = resolve;
      this.authReject = reject;
      const socket = (this.socket = new (this.WebSocket || WebSocket)(this.url));
      const connectionAttempt = ++this.connectionAttempt,
        openedAt = Date.now();
      this.connectionId = undefined;
      this.closeInitiator = undefined;
      this.authTimer = setTimeout(() => {
        if (socket === this.socket) {
          this.closeInitiator = 'auth-timeout';
          socket.close();
        }
      }, 5000);
      socket.onopen = () => this.hello(socket);
      socket.onerror = () => {};
      socket.onmessage = event => {
        if (socket !== this.socket) return;
        this.lastReceivedAt = Date.now();
        if (this.ready) this.scheduleHeartbeat();
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'welcome') {
            this.connectionId =
              Number.isSafeInteger(message.connectionId) && message.connectionId > 0 ? message.connectionId : undefined;
            const initial = !this.ready;
            clearTimeout(this.authTimer);
            this.ready = true;
            this.attempt = 0;
            this.connecting = undefined;
            this.authResolve?.();
            this.authResolve = this.authReject = undefined;
            if (initial) {
              this.scheduleClock();
              this.clock();
              this.scheduleHeartbeat();
              Promise.resolve(this.onReady()).catch(() => {});
            }
            return;
          }
          if (message.type === 'clock') {
            const pending = this.clockPending?.id === message.id ? this.clockPending : undefined;
            if (!pending) return;
            this.clockPending = undefined;
            clearTimeout(pending.timer);
            this.onClock(message, pending.exchange);
            return;
          }
          if (message.type === 'ack' || (message.type === 'error' && message.id >= 0)) {
            const pending = this.pending.get(message.id);
            if (!pending) return;
            this.pending.delete(message.id);
            clearTimeout(pending.timer);
            pending.cleanup?.();
            if (message.type === 'error') pending.reject(refusal(message));
            else pending.resolve(message.value);
            this.drainQueue();
            return;
          }
          // A server that speaks another protocol version will not change its mind:
          // stop reconnecting and let the page say so.
          if (message.type === 'error' && message.code === 'protocol') {
            this.stopped = true;
            this.protocolError = refusal(message);
          }
          this.onMessage(message);
        } catch {
          this.closeInitiator = 'protocol-error';
          socket.close(4002, 'Invalid server message');
        }
      };
      socket.onclose = event => {
        if (socket !== this.socket) return;
        const wasReady = this.ready;
        this.ready = false;
        this.connecting = undefined;
        clearTimeout(this.authTimer);
        clearTimeout(this.heartbeat);
        clearTimeout(this.heartbeatTimer);
        const error = this.protocolError || new TypeError('Room connection lost; reconnecting');
        this.authReject?.(error);
        this.authResolve = this.authReject = undefined;
        clearTimeout(this.clockPending?.timer);
        this.clockPending = undefined;
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer);
          pending.cleanup?.();
          pending.reject(error);
        }
        this.pending.clear();
        for (const queued of this.queue.splice(0)) {
          clearTimeout(queued.timer);
          queued.cleanup?.();
          queued.reject(error);
        }
        this.onClose({
          code: event?.code,
          reason: event?.reason,
          clean: event?.wasClean,
          connectionAttempt,
          connectionId: this.connectionId,
          connectionAgeMs: Date.now() - openedAt,
          closeInitiator: this.closeInitiator || 'none',
          wasReady,
        });
        if (!this.stopped) {
          const delay = Math.max(
            this.resumeAt - Date.now() || 0,
            Math.min(15000, 500 * 2 ** Math.min(this.attempt++, 5)),
          );
          this.retry = setTimeout(() => {
            this.retry = undefined;
            if (!this.stopped) void this.connect().catch(() => {});
          }, delay);
        }
      };
    });
    return this.connecting;
  }
  /** States the protocol version this client speaks, with its sign-in. */
  hello(socket) {
    socket.send(JSON.stringify({ type: 'hello', protocol: Wire.PROTOCOL_VERSION, ...this.identity() }));
  }
  reauthenticate() {
    if (this.ready && this.socket?.readyState === 1) this.hello(this.socket);
  }
  scheduleHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    const timeoutMs = this.heartbeatTimeoutMs || HEARTBEAT_TIMEOUT_MS;
    const socket = this.socket,
      deadline = Date.now() + timeoutMs;
    this.heartbeatTimer = setTimeout(() => {
      if (socket !== this.socket) return;
      // A late timer also means receive callbacks may still be queued. Give
      // a waking tab a fresh exchange rather than closing a healthy socket.
      if (Date.now() - deadline < 1000 && Date.now() - this.lastReceivedAt >= timeoutMs) {
        this.closeInitiator = 'heartbeat-timeout';
        socket.close(4000, 'Server heartbeat timed out');
      } else if (!this.stopped && this.ready) {
        this.scheduleHeartbeat();
        this.clock();
      }
    }, timeoutMs);
  }
  scheduleClock() {
    clearTimeout(this.heartbeat);
    if (this.stopped || !this.ready) return;
    const delay = this.clockIntervalMs || 850 + Math.floor(Math.random() * 300);
    this.heartbeat = setTimeout(() => {
      if (this.stopped || !this.ready) return;
      this.clock();
      this.scheduleClock();
    }, delay);
  }
  clock() {
    if (!this.ready || this.socket?.readyState !== 1) return;
    // One outstanding sample is enough. Keep clock exchange separate from
    // request capacity so clock maintenance never stalls behind commands.
    if (this.clockPending) return;
    const id = ++this.sequence,
      exchange = this.beginClock();
    const timer = setTimeout(() => {
      if (this.clockPending?.id === id) this.clockPending = undefined;
    }, this.clockTimeoutMs || CLOCK_TIMEOUT_MS);
    this.clockPending = { id, timer, exchange };
    this.socket.send(JSON.stringify({ type: 'clock', id }));
  }
  /** Reports this tab's sync quality; unanswered. */
  quality(value) {
    if (!this.ready || this.socket?.readyState !== 1) return false;
    this.socket.send(JSON.stringify({ type: 'quality', ...value }));
    return true;
  }
  /**
   * Sends one request and resolves with its `ack` value, or rejects with its `error`.
   * @param {{type: string} & Record<string, any>} message
   * @param {WatchRequestOptions} options
   */
  drainQueue() {
    while (this.ready && this.socket?.readyState === 1 && this.pending.size < 8 && this.queue.length) {
      const entry = this.queue.shift();
      entry.send();
    }
  }
  request(message, { timeoutMs = 12000, signal } = {}) {
    if (!this.ready || this.socket?.readyState !== 1)
      return Promise.reject(new TypeError('Room connection unavailable; retry after reconnecting'));
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: undefined, cleanup: undefined, sentId: undefined, send: undefined };
      const cancel = () => {
        if (entry.sentId !== undefined) {
          const id = entry.sentId;
          if (!this.pending.delete(id)) return;
          if (this.socket?.readyState === 1) this.socket.send(JSON.stringify({ type: 'cancel', id }));
          this.drainQueue();
        } else {
          const idx = this.queue.indexOf(entry);
          if (idx === -1) return;
          this.queue.splice(idx, 1);
        }
        clearTimeout(entry.timer);
        entry.cleanup?.();
        reject(signal?.reason || new DOMException('Request timed out', 'TimeoutError'));
      };
      entry.timer = setTimeout(cancel, timeoutMs);
      entry.cleanup = () => signal?.removeEventListener('abort', cancel);
      signal?.addEventListener('abort', cancel, { once: true });
      entry.send = () => {
        const id = (entry.sentId = ++this.sequence);
        this.pending.set(id, entry);
        this.socket.send(JSON.stringify({ ...message, id, timeoutMs }));
      };
      if (this.pending.size < 8) entry.send();
      else this.queue.push(entry);
    });
  }
  /** Joins a room as `viewerId`; resolves with both lanes of the tab's view. */
  join(roomId, viewerId, preferences, options) {
    return this.request({ type: 'join', roomId, viewerId, preferences }, options);
  }
  leave(roomId, viewerId, options) {
    return this.request({ type: 'leave', roomId, viewerId }, options);
  }
  /** @param {{viewerId?: string, epoch?: string, expiresAt?: number, command: {action: string, args?: Object}}} envelope */
  command(roomId, envelope, options) {
    return this.request({ type: 'command', roomId, ...envelope }, options);
  }
  // Named apart from the `ready` flag (the connection is signed in).
  reportReady(roomId, viewerId, report, options) {
    return this.request({ type: 'ready', roomId, viewerId, ...report }, options);
  }
  observe(roomId, viewerId, observation, options) {
    return this.request({ type: 'observe', roomId, viewerId, observation }, options);
  }
  /** One named request (`CALLS` in shared/wire-protocol.mjs). */
  call(op, { roomId, args } = {}, options) {
    return this.request({ type: 'call', op, roomId, args }, options);
  }
  /** Asks for every lane again; resolves once the server has sent them. */
  resync(options) {
    return this.request({ type: 'resync' }, options);
  }
  interrupt(milliseconds = 6000) {
    this.resumeAt = Date.now() + milliseconds;
    this.closeInitiator = 'interrupt';
    this.socket?.close();
  }
  close() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.retry = undefined;
    clearTimeout(this.heartbeat);
    clearTimeout(this.heartbeatTimer);
    this.closeInitiator = 'manual-close';
    this.socket?.close(1000);
  }
}
/** A server refusal as the error a caller catches. */
function refusal(message) {
  return Object.assign(new Error(message.message || 'Request failed'), {
    status: message.status,
    code: message.code,
    rejection: message.rejection,
    rejoin: !!message.rejoin,
    reconnect: message.reconnect,
  });
}
export { WatchTransport };
