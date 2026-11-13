// @ts-check
'use strict';
const { WebSocketServer } = require('ws');
const { clientAddress } = require('./plex-delivery');
const { runOperation, waitFor, commitOperation } = require('./operation');
const {
  validateSyncQualityMessage,
  reduceViewerSyncQuality,
  sampleSyncSpread,
  createSubscriptionBroker,
} = require('../shared/sync');
const { PROTOCOL_VERSION, RESYNC_MS, CALLS, clientMessageError } = require('../shared/wire-protocol.mjs');
/** @typedef {import('ws').WebSocket & {watchKick?: (roomId: string) => void, watchRtts?: Array<{at:number,ms:number}>}} WatchSocket */
/** @typedef {{roomId: string, viewerId: string, sentRoom: number, stamp: string | undefined, viewerVersion: number}} Subscription */

/**
 * The room connection: typed messages (shared/wire-protocol.mjs) over one authenticated
 * WebSocket per tab. Each kind of message has one handler, which calls the matching
 * operation (server/watch-operations.js). State is pushed in three lanes (`room`,
 * `viewer`, `lobby`), each only when its version changed, plus a slow resync of every
 * lane as a safety net. Commands are never replayed.
 */
function watchSockets({
  server,
  config,
  routes,
  watch,
  hub,
  throttle,
  publishTimeoutMs = 12000,
  resyncMs = RESYNC_MS,
}) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.once('listening', () => watch.roomState.startRecovery());
  const clockEpoch = routes.clockEpoch,
    operations = routes.operations,
    maxConnections = config.maxConnections ?? 256;
  const allowed = origin =>
    origin === config.publicUrl ||
    (/^\d{17,20}$/.test(config.clientId || '') && origin === `https://${config.clientId}.discordsays.com`);
  // Wakes a room's subscribers for a room change and every connection for a lobby change.
  const broker = createSubscriptionBroker({
    publish: (client, scope) => publish(client, scope),
    getRoomId: client => client.room?.roomId,
  });
  const clients = broker.clients;
  let nextConnectionId = 0,
    lobbyVersion = 1;
  // Recent unplanned disconnects per account, so repeat trouble shows in the log.
  const disconnects = new Map();
  function noteDisconnect(userId, at) {
    const recent = (disconnects.get(userId) || []).filter(time => at - time < 3600000);
    recent.push(at);
    if (disconnects.size >= 500 && !disconnects.has(userId)) disconnects.delete(disconnects.keys().next().value);
    disconnects.set(userId, recent.slice(-50));
    return recent.length;
  }
  function send(client, message) {
    if (client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > 1024 * 1024) {
      client.terminationCause = 'backpressure';
      client.ws.terminate();
      return;
    }
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw) > 1024 * 1024) {
      client.ws.close(4009, 'Room response too large');
      return;
    }
    client.ws.send(raw);
  }
  /** A refusal as an `error` message: `id` answers a request, `roomId` is about a room's state. */
  const refused = (code, result, extra = {}) => ({
    type: 'error',
    ...extra,
    code,
    status: result.status,
    message: result.value?.error || 'Request failed',
    ...(result.value?.rejoin ? { rejoin: true } : {}),
    ...(result.value?.rejection ? { rejection: result.value.rejection } : {}),
  });
  /** Who is asking, for the operations: the connection's credentials, socket and an abort signal. */
  const context = (client, signal = client.lifetime.signal) => ({
    signal,
    get headers() {
      return client.headers;
    },
    controlSocket: client.ws,
    remoteAddress: client.remoteAddress || client.socket?.remoteAddress,
  });
  const perform = (client, signal, work) =>
    runOperation(signal, async () => {
      const result = await work(context(client, signal));
      await commitOperation();
      return result;
    });

  // ---- Publication -------------------------------------------------------
  // A lobby change wakes everyone; a room change wakes that room's subscribers.
  function notify(change) {
    if (change?.includeLobby !== false || !change?.roomId) lobbyVersion++;
    broker.notify(change);
  }
  // Commands, room events and timers are published by their room (Watch.changed).
  watch.onPublish = (_room, change) => notify(change);
  function publish(client, { roomOnly = false } = {}) {
    void client.lanes.room.request(false);
    if (!roomOnly) void client.lanes.lobby.request(false);
  }
  /**
   * One lane's publications for one connection, one at a time. A request made while
   * one is being sent runs right after it; `force` sends the lane whether or not its
   * version changed (a resync). Resolves once a publication that began after the
   * request has finished.
   */
  function lane(client, name, run) {
    const state = { running: false, dirty: false, force: false, waiters: [] };
    async function pump() {
      if (state.running) return;
      state.running = true;
      while (state.dirty && client.authenticated && client.ws.readyState === 1) {
        const { force, waiters } = state;
        state.dirty = state.force = false;
        state.waiters = [];
        const signal = AbortSignal.any([client.lifetime.signal, AbortSignal.timeout(publishTimeoutMs)]);
        try {
          await run(force, signal);
        } catch {
          // Discovery failure must not invalidate a separately authorized stream. A
          // slow preparation is not a lost connection either: publish again instead
          // of making a healthy client reconnect and clear its player.
          if (signal.aborted) {
            state.dirty = !client.lifetime.signal.aborted;
            state.force ||= force;
          } else if (name === 'room' && !client.lifetime.signal.aborted)
            send(client, {
              type: 'error',
              code: 'unavailable',
              status: 503,
              message: 'Room connection temporarily unavailable',
            });
        }
        for (const done of waiters) done();
      }
      state.running = false;
      for (const done of state.waiters.splice(0)) done();
    }
    return {
      request(force) {
        state.dirty = true;
        state.force ||= force;
        const done = new Promise(resolve => state.waiters.push(resolve));
        void pump();
        return done;
      },
    };
  }
  function signedOut(client, result) {
    send(client, refused('auth', result));
    client.ws.close(4003, 'Sign in again');
  }
  async function publishLobby(client, force, signal) {
    const version = lobbyVersion;
    if (!force && client.sentLobby === version) return;
    const result = await waitFor(
      perform(client, signal, ctx => operations.lobby(ctx)),
      signal,
    );
    if (client.ws.readyState !== 1) return;
    if (result.status === 401) return signedOut(client, result);
    if (result.status !== 200) return;
    client.sentLobby = version;
    send(client, { type: 'lobby', version, identity: result.value.identity, rooms: result.value.rooms });
  }
  async function publishRoom(client, force, signal) {
    /** @type {Subscription | undefined} */
    const subscription = client.room;
    if (!subscription) return;
    const { roomId, viewerId } = subscription;
    const room = watch.rooms.get(roomId),
      viewer = room?.viewers.get(viewerId);
    const version = room ? watch.roomVersion(room) : 0,
      stamp = viewer ? watch.viewerStamp(room, viewer) : undefined;
    const wantRoom = force || version !== subscription.sentRoom,
      wantViewer = force || stamp !== subscription.stamp;
    if (!wantRoom && !wantViewer) return;
    const result = await waitFor(
      perform(client, signal, ctx => operations.lanes(ctx, roomId, viewerId, { room: wantRoom, viewer: wantViewer })),
      signal,
    );
    if (client.room !== subscription || client.ws.readyState !== 1) return;
    if (result.status === 401) return signedOut(client, result);
    if (result.status >= 500) return send(client, refused('unavailable', result, { roomId }));
    // A refusal answers for both lanes as they stood when it was decided.
    const sent = result.status === 200 ? result.value : { version, stamp };
    if (wantRoom || result.status !== 200) subscription.sentRoom = sent.version;
    if (wantViewer || result.status !== 200) subscription.stamp = sent.stamp;
    if (result.status !== 200) return send(client, refused('room', result, { roomId, viewerId }));
    if (result.value.room)
      send(client, { type: 'room', roomId, viewerId, version: sent.version, state: result.value.room });
    if (result.value.viewer)
      send(client, {
        type: 'viewer',
        roomId,
        viewerId,
        version: ++subscription.viewerVersion,
        state: result.value.viewer,
      });
  }

  // ---- Presence ----------------------------------------------------------
  // The tabs this connection holds, by room: its presence and its close go straight to them.
  const holds = (client, roomId, viewerId) => client.viewers.set(roomId, viewerId);
  function release(client, roomId) {
    client.viewers.delete(roomId);
    if (client.room?.roomId === roomId) client.room = undefined;
  }
  // The tab's own connection is its presence: it keeps the tab in its room and renews its media grants.
  function present(client) {
    for (const [roomId, viewerId] of client.viewers) {
      if (!watch.present(client.ws, roomId, viewerId)) client.viewers.delete(roomId);
      else routes.renewGrants?.(client.ws, viewerId);
    }
  }

  // ---- Message handlers --------------------------------------------------
  async function hello(client, message, timer) {
    const ws = client.ws;
    // An older client is told plainly, before any sign-in, that it has to be updated.
    if (message.type !== 'hello' || (Number.isSafeInteger(message.protocol) && message.protocol !== PROTOCOL_VERSION)) {
      send(client, {
        type: 'error',
        code: 'protocol',
        status: 426,
        message: `This server speaks room protocol ${PROTOCOL_VERSION}; update this app to connect.`,
        supported: [PROTOCOL_VERSION],
      });
      return ws.close(4010, 'Protocol mismatch');
    }
    if (clientMessageError(message)) return ws.close(4003, 'Authentication failed');
    if (client.authenticating) return ws.close(4003, 'Authentication required');
    client.authenticating = true;
    const headers = { ...client.headers };
    if (message.token !== undefined) headers.authorization = 'Bearer ' + message.token;
    headers['x-csrf-token'] = message.csrf;
    const auth = await routes.authorized({ headers }, true);
    if (!auth || (client.userId && client.userId !== auth.actor.userId) || ws.readyState !== 1)
      return ws.close(4003, 'Authentication failed');
    try {
      watch.roomState.people.enter(auth.actor.userId);
    } catch {
      send(client, { type: 'error', code: 'full', status: 429, message: 'Server full; try again when someone leaves' });
      return ws.close(4029, 'Server full');
    }
    const first = !client.authenticated;
    client.headers = headers;
    client.userId = auth.actor.userId;
    client.userName = auth.actor.name;
    client.authenticating = false;
    client.authenticated = true;
    hub.directory?.connected(ws, client.userId);
    clearTimeout(timer);
    send(client, { type: 'welcome', protocol: PROTOCOL_VERSION, connectionId: client.connectionId, resyncMs });
    if (!first) return;
    client.resyncAt = watch.clock.now();
    void client.lanes.lobby.request(true);
    config.logger?.info(
      'Socket',
      `conn=${client.connectionId} User authenticated: ${auth.actor.name || auth.actor.userId} (total clients: ${clients.size})`,
    );
  }
  async function clock(client, message) {
    if (client.clocking) return;
    client.clocking = true;
    try {
      const serverReceivedAt = watch.clock.now(),
        received = performance.now();
      if (!(await routes.authorized({ headers: client.headers }, true))) return client.ws.close(4003, 'Sign in again');
      present(client);
      send(client, {
        type: 'clock',
        id: message.id,
        serverNow: watch.clock.now(),
        timing: {
          serverReceivedAt,
          serverSentAt: watch.clock.now(),
          serverProcessingMs: performance.now() - received,
          clockEpoch,
        },
      });
    } finally {
      client.clocking = false;
    }
  }
  async function quality(client, message) {
    if (!validateSyncQualityMessage(message)) return client.ws.close(4002, 'Invalid sync quality message');
    const room = watch.rooms.get(message.roomId),
      viewer = room?.viewers.get(message.viewerId);
    // A report can cross the viewer's own leave. Only a foreign identity is misuse.
    if (!room || !viewer) return;
    if (viewer.userId !== client.userId) return client.ws.close(4003, 'Playback viewer unavailable');
    const stale = () =>
      room.viewers.get(message.viewerId) !== viewer ||
      viewer.watchSocket !== client.ws ||
      room.mediaVersion !== message.mediaVersion ||
      viewer.streamVersion !== message.streamVersion;
    if (
      client.room?.roomId !== message.roomId ||
      client.room.viewerId !== message.viewerId ||
      client.ws.readyState !== 1 ||
      stale()
    )
      return;
    const auth = await routes.authorized({ headers: client.headers, controlSocket: client.ws }, true);
    if (!auth || auth.actor.userId !== viewer.userId || !(await watch.canView(room, auth.actor)))
      return client.ws.close(4003, 'Sign in again');
    // The room can move on while sign-in is checked. That report is just stale.
    if (stale()) return;
    const now = watch.clock.now();
    const statusChanged = client.lastSyncQualityStatus !== message.status;
    const confidenceChanged = client.lastSyncQualityConfidence !== message.confidence;
    const minimumInterval = statusChanged || confidenceChanged ? 500 : 4000;
    if (client.lastSyncQualityAt !== undefined && now - client.lastSyncQualityAt < minimumInterval) return;
    const { next, displayChanged } = reduceViewerSyncQuality(viewer.syncQuality, message, {
      now,
      mediaVersion: room.mediaVersion,
      streamVersion: viewer.streamVersion,
    });
    viewer.syncQuality = next;
    client.lastSyncQualityAt = now;
    client.lastSyncQualityStatus = message.status;
    client.lastSyncQualityConfidence = message.confidence;
    // The viewer spread rides on the same publications as health cards: it is sampled
    // here and shown at the next one, never published on its own.
    const spread = sampleSyncSpread(room.syncSpread, room, now);
    room.syncSpread = spread.tracker;
    const logSpread = (summary, label) =>
      config.logger?.info(
        'Sync',
        `room=${room.roomId} ${label} viewer spread p50=${summary.p50Ms}ms p95=${summary.p95Ms}ms ` +
          `within50=${summary.within50Percent}% within100=${summary.within100Percent}% samples=${summary.samples}`,
      );
    if (spread.finished) logSpread(spread.finished, 'video');
    else if (spread.sampled && spread.tracker.summary && spread.tracker.taken % 120 === 0)
      logSpread(spread.tracker.summary, 'running');
    // Open health cards stay current without republishing the room on every report.
    const healthDue = !!next.health && now - (room.healthPublishedAt || 0) >= 10000;
    if (displayChanged || healthDue) {
      room.healthPublishedAt = now;
      watch.changed(room);
    }
  }
  /** Each request a client may make: the operation it runs and what follows a success. */
  const requests = {
    join: {
      run: (ctx, message) => operations.join(ctx, message),
      done(client, message, result) {
        const { roomId, viewerId } = message;
        holds(client, roomId, viewerId);
        /** @type {Subscription} */
        const subscription = (client.room = {
          roomId,
          viewerId,
          sentRoom: result.value.version,
          stamp: result.value.stamp,
          viewerVersion: (client.room?.viewerVersion || 0) + 1,
        });
        const { room: roomLane, viewer: viewerLane, timing } = result.value;
        return {
          roomId,
          viewerId,
          room: { version: subscription.sentRoom, state: roomLane },
          viewer: { version: subscription.viewerVersion, state: viewerLane },
          timing,
        };
      },
    },
    leave: {
      run: (ctx, message) => operations.leave(ctx, message),
      settled: (client, message) => release(client, message.roomId),
    },
    command: { run: (ctx, message) => operations.command(ctx, message) },
    ready: { run: (ctx, message) => operations.ready(ctx, message) },
    observe: { run: (ctx, message) => operations.observe(ctx, message) },
    call: {
      run: (ctx, message) => operations.call(ctx, message.op, { roomId: message.roomId, args: message.args }),
      done(client, message, result) {
        if (message.op === 'room.close') release(client, message.roomId);
        // A management change can alter what the lobby lists and what the room's tabs see.
        if (CALLS[message.op].write) watch.changed(watch.rooms.get(message.roomId), { lobby: true });
        return result.value;
      },
    },
  };
  async function respond(client, message) {
    const ws = client.ws,
      kind = requests[message.type];
    if (client.inflight.has(message.id) || client.inflight.size >= 8) return ws.close(4002, 'Invalid message');
    if (client.running.size >= 16)
      return send(
        client,
        refused(
          'refused',
          { status: 429, value: { error: 'Previous work is still retiring; retry shortly' } },
          { id: message.id },
        ),
      );
    const controller = new AbortController();
    const timeout = Number.isFinite(message.timeoutMs) ? Math.min(120000, Math.max(1000, message.timeoutMs)) : 12000;
    const signal = AbortSignal.any([controller.signal, client.lifetime.signal, AbortSignal.timeout(timeout)]);
    client.inflight.set(message.id, controller);
    try {
      const operation = perform(client, signal, ctx => kind.run(ctx, message));
      client.running.add(operation);
      operation.finally(() => client.running.delete(operation)).catch(() => {});
      const result = await waitFor(operation, signal);
      kind.settled?.(client, message);
      if (result.status >= 400) return send(client, refused('refused', result, { id: message.id }));
      send(client, {
        type: 'ack',
        id: message.id,
        value: kind.done ? kind.done(client, message, result) : result.value,
      });
    } catch (error) {
      if (!signal.aborted) throw error;
      if (!controller.signal.aborted)
        send(
          client,
          refused(
            'refused',
            { status: 503, value: { error: 'Operation timed out; refresh state before retrying a change' } },
            { id: message.id },
          ),
        );
    } finally {
      client.inflight.delete(message.id);
    }
  }
  /**
   * A client asks for every lane again, as the slow resync does. The ack follows the
   * room's lanes; the lobby is sent when it is ready, since listing rooms can wait on
   * a provider and must not hold up a room's state.
   */
  async function resync(client, message) {
    void client.lanes.lobby.request(true);
    await client.lanes.room.request(true);
    send(client, { type: 'ack', id: message.id, value: { serverNow: watch.clock.now() } });
  }

  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/watch-socket') return socket.destroy();
    if (
      !allowed(req.headers.origin) ||
      !throttle('watch-socket:' + (clientAddress(req) || 'local'), 30) ||
      clients.size >= maxConnections
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (/** @type {WatchSocket} */ ws) => {
      /** @type {Record<string, any>} */
      const client = {
        ws,
        socket: req.socket,
        remoteAddress: clientAddress(req),
        headers: /** @type {Record<string, string | undefined>} */ ({
          cookie: req.headers.cookie,
          origin: req.headers.origin,
          'content-type': 'application/json',
        }),
        lastSeen: watch.clock.now(),
        inflight: new Map(),
        running: new Set(),
        /** @type {Map<string, string>} Room id to this connection's viewer id there. */
        viewers: new Map(),
        /** @type {Subscription | undefined} The room whose state this connection is sent. */
        room: undefined,
        lifetime: new AbortController(),
        connectionId: ++nextConnectionId,
        openedAt: watch.clock.now(),
      };
      client.lanes = {
        room: lane(client, 'room', (force, signal) => publishRoom(client, force, signal)),
        lobby: lane(client, 'lobby', (force, signal) => publishLobby(client, force, signal)),
      };
      Object.defineProperty(ws, 'watchHeaders', {
        get() {
          return client.headers;
        },
        configurable: true,
      });
      clients.add(client);
      config.logger?.debug(
        'Socket',
        `conn=${client.connectionId} opened from ${client.remoteAddress || 'local'} (total: ${clients.size})`,
      );
      ws.watchKick = roomId => {
        release(client, roomId);
        send(client, {
          type: 'error',
          code: 'removed',
          status: 403,
          roomId,
          message: 'You were removed from the room.',
        });
      };
      ws.watchRtts = [];
      ws.on('pong', () => {
        // Native pongs keep presence alive even when the client throttles its
        // own timers. Sign-in is still checked by every clock exchange and request.
        client.lastSeen = watch.clock.now();
        if (client.authenticated) watch.roomState.people.reserve(client.userId, client.lastSeen + 60000);
        if (client.pingAt !== undefined) {
          const now = performance.now(),
            ms = now - client.pingAt;
          client.pingAt = undefined;
          if (ms >= 0 && ms <= 10000)
            ws.watchRtts = [...ws.watchRtts, { at: now, ms }].filter(sample => now - sample.at <= 30000).slice(-16);
        }
        if (!client.authenticated) return;
        present(client);
        // A tab whose own timers are throttled is still signed out promptly.
        void Promise.resolve(routes.authorized({ headers: client.headers }, true)).then(
          auth => {
            if (!auth && ws.readyState === 1) ws.close(4003, 'Sign in again');
          },
          () => {},
        );
      });
      const timer = setTimeout(() => ws.close(4003, 'Authentication required'), 5000);
      let windowAt = watch.clock.now(),
        count = 0;
      ws.on('error', () => {});
      ws.on('message', raw => {
        void (async () => {
          if (watch.clock.now() - windowAt > 1000) {
            windowAt = watch.clock.now();
            count = 0;
          }
          if (++count > 40) return ws.close(4008, 'Rate limit');
          const message = JSON.parse(raw.toString());
          if (!client.authenticated || message?.type === 'hello') return hello(client, message || {}, timer);
          const invalid = clientMessageError(message);
          if (invalid) {
            // A malformed request is refused by name; anything else malformed ends the connection.
            if (!requests[message?.type] || !Number.isSafeInteger(message.id) || message.id < 0)
              return ws.close(4002, 'Invalid message');
            return send(client, { type: 'error', id: message.id, code: 'invalid', status: 400, message: invalid });
          }
          client.lastSeen = watch.clock.now();
          hub.directory?.connected(ws, client.userId);
          switch (message.type) {
            case 'cancel':
              return client.inflight.get(message.id)?.abort();
            case 'clock':
              return clock(client, message);
            case 'quality':
              if (client.measuring) return;
              client.measuring = true;
              try {
                return await quality(client, message);
              } finally {
                client.measuring = false;
              }
            case 'resync':
              return resync(client, message);
            default:
              return respond(client, message);
          }
        })().catch(() => ws.close(4002, 'Request failed'));
      });
      ws.on('close', (code, rawReason) => {
        client.lifetime.abort();
        const reason =
          rawReason
            ?.toString('utf8')
            .slice(0, 80)
            .replace(/[^\x20-\x7e]/g, '') || '';
        const attached = [...client.viewers].filter(
          ([roomId, viewerId]) => watch.rooms.get(roomId)?.viewers.get(viewerId)?.watchSocket === ws,
        );
        config.logger?.debug(
          'Socket',
          `conn=${client.connectionId} closed code=${code} reason=${JSON.stringify(reason)} source=${client.terminationCause || 'peer-or-network'} account=${JSON.stringify(client.userName || client.userId || 'unauthenticated')} ageMs=${watch.clock.now() - client.openedAt} attachedViewers=${attached.length} (remaining: ${clients.size - 1})`,
        );
        if (attached.length) {
          const planned = code === 1000 || code === 1001 || client.terminationCause === 'server-shutdown',
            now = watch.clock.now();
          const count = planned ? 0 : noteDisconnect(client.userId, now),
            quoted = reason ? ` ("${reason}")` : '';
          config.logger?.[planned ? 'info' : 'warn'](
            'Socket',
            `Viewer ${JSON.stringify(client.userName || client.userId)} ${planned ? 'closed the page' : 'disconnected'}: code ${code}${quoted}, cause ${client.terminationCause || 'browser or network'}, connected ${Math.round((now - client.openedAt) / 1000)}s, last message ${((now - client.lastSeen) / 1000).toFixed(1)}s ago${count > 1 ? `, ${count} unplanned disconnects in the last hour` : ''}`,
          );
        }
        hub.directory?.disconnected(ws);
        clearTimeout(timer);
        clients.delete(client);
        // A transient close can precede the next authenticated socket by only
        // a second. Do not tear down the Plex session and revoke its HLS grant
        // before the same viewer has an opportunity to reattach. The viewer's
        // 10-second presence deadline still expires a truly disconnected viewer.
        // Graceful tab exits and protocol/authorization closures retain the
        // prior immediate-cleanup behavior.
        const unexpected =
          (code === 1005 || code === 1006) &&
          client.terminationCause !== 'server-shutdown' &&
          client.terminationCause !== 'backpressure';
        for (const [roomId, viewerId] of attached) watch.disconnected(ws, !unexpected, roomId, viewerId);
        client.viewers.clear();
      });
    });
  });
  // Liveness and the slow resync. Nothing here publishes because time passed, except
  // the resync: every lane again, changed or not, in case a change was never signalled.
  const timer = setInterval(() => {
    const now = watch.clock.now();
    for (const client of clients) {
      if (now - client.lastSeen >= 10000) {
        client.terminationCause = 'server-idle-timeout';
        client.ws.terminate();
        continue;
      }
      if (client.pingAt === undefined && client.ws.readyState === 1) {
        client.pingAt = performance.now();
        client.ws.ping();
      }
      if (client.authenticated && now - client.resyncAt >= resyncMs) {
        client.resyncAt = now;
        void client.lanes.room.request(true);
        void client.lanes.lobby.request(true);
      }
    }
  }, 1000);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      for (const client of clients) {
        client.terminationCause = 'server-shutdown';
        client.ws.terminate();
      }
      wss.close();
    },
  };
}
module.exports = { watchSockets };
