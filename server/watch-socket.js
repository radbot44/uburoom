// @ts-check
'use strict';
const { WebSocketServer } = require('ws');
const { clientAddress } = require('./plex-delivery');
const { runOperation, waitFor, commitOperation } = require('./operation');
const {
  validateSyncQualityMessage,
  reduceViewerSyncQuality,
  createSubscriptionBroker,
  isRoomLocalAction,
  classifyMutationScope,
} = require('../shared/sync');
/** @typedef {import('ws').WebSocket & {watchKick?: (roomId: string) => void, watchRtts?: Array<{at:number,ms:number}>}} WatchSocket */
/**
 * @typedef {Object} ControlRequest
 * @property {'request'} type
 * @property {number} id Connection-local correlation ID; never replayed.
 * @property {string} path Allowlisted resource and optional query.
 * @property {Object} [data] Mutation body, including existing epoch/expiry fences.
 */

// WebSocket framing calls shared operations directly; commands are never replayed.
function watchSockets({ server, config, routes, watch, hub, throttle, publishTimeoutMs = 12000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.once('listening', () => watch.roomState?.startRecovery());
  const clockEpoch = routes.clockEpoch;
  const allowed = origin =>
    origin === config.publicUrl ||
    (/^\d{17,20}$/.test(config.clientId || '') && origin === `https://${config.clientId}.discordsays.com`);
  const broker = createSubscriptionBroker({ publish: (client, ctx) => publish(client, ctx) });
  const clients = broker.clients;
  let nextConnectionId = 0;
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
  const request = (client, path, data, signal = client.lifetime.signal) =>
    runOperation(signal, async () => {
      const result = await routes.execute(
        {
          signal,
          get headers() {
            return client.headers;
          },
          controlSocket: client.ws,
          remoteAddress: client.remoteAddress || client.socket?.remoteAddress,
        },
        path,
        data,
      );
      await commitOperation();
      return result;
    });
  async function syncQuality(client, message) {
    if (!validateSyncQualityMessage(message)) return client.ws.close(4002, 'Invalid sync quality message');
    const room = watch.rooms.get(message.roomId),
      viewer = room?.viewers.get(message.viewerId);
    // A report can cross the viewer's own leave. Only a foreign identity is misuse.
    if (!room || !viewer) return;
    if (room.roomId !== message.roomId || viewer.userId !== client.userId)
      return client.ws.close(4003, 'Playback viewer unavailable');
    let subscription;
    try {
      subscription = new URL(client.subscription, 'https://room.invalid');
    } catch {
      return;
    }
    if (
      subscription.pathname !== '/api/watch/rooms/' + message.roomId ||
      subscription.searchParams.get('viewer') !== message.viewerId ||
      viewer.watchSocket !== client.ws ||
      client.ws.readyState !== 1 ||
      room.mediaVersion !== message.mediaVersion ||
      viewer.streamVersion !== message.streamVersion
    )
      return;
    const auth = await routes.authorized({ headers: client.headers, controlSocket: client.ws }, true);
    if (!auth || auth.actor.userId !== viewer.userId || !(await watch.canView(room, auth.actor)))
      return client.ws.close(4003, 'Sign in again');
    // The room can move on while sign-in is checked. That report is just stale.
    if (
      room.viewers.get(message.viewerId) !== viewer ||
      viewer.watchSocket !== client.ws ||
      room.mediaVersion !== message.mediaVersion ||
      viewer.streamVersion !== message.streamVersion
    )
      return;
    const now = Date.now();
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
    // Open health cards stay current without republishing the room on every report.
    const healthDue = !!next.health && now - (room.healthPublishedAt || 0) >= 10000;
    if (displayChanged || healthDue) {
      room.healthPublishedAt = now;
      broker.notify({ roomId: message.roomId, includeLobby: false });
    }
  }
  function publish(client, { roomOnly = false } = {}) {
    void publishLane(client, 'room');
    if (!roomOnly || client.lastRoomsJson === undefined) void publishLane(client, 'lobby');
  }
  async function publishLane(client, lane) {
    if (!client.authenticated || client.ws.readyState !== 1) return;
    const key = lane + 'Publication';
    const previous = client[key];
    if (previous) {
      previous.dirty = true;
      return;
    }
    const job = (client[key] = { dirty: false });
    const signal = AbortSignal.any([client.lifetime.signal, AbortSignal.timeout(publishTimeoutMs)]);
    const path = client.subscription;
    try {
      if (lane === 'lobby') {
        const rooms = await waitFor(request(client, '/api/watch/rooms', undefined, signal), signal);
        const raw = JSON.stringify(rooms);
        if (client.ws.readyState === 1 && raw !== client.lastRoomsJson) {
          client.lastRoomsJson = raw;
          send(client, { type: 'rooms', ...rooms });
        }
        // Record only transitions in selected-room visibility, not every periodic publication.
        const selectedRoom = /^\/api\/watch\/rooms\/([a-f0-9-]{36})(?:\?|$)/.exec(path || '')?.[1];
        if (selectedRoom) {
          const listed =
            rooms.status === 200 && Array.isArray(rooms.value?.rooms)
              ? rooms.value.rooms.find(room => room.id === selectedRoom)
              : undefined;
          const availability =
            rooms.status !== 200
              ? 'list-error-' + rooms.status
              : !listed
                ? 'missing'
                : listed.locked
                  ? 'locked'
                  : 'available';
          if (client.lastPublishedRoomId !== selectedRoom || client.lastPublishedRoomAvailability !== availability) {
            const serverRoom = watch.rooms.get(selectedRoom);
            config.logger?.debug(
              'Socket',
              `conn=${client.connectionId} selected-room=${availability} serverExists=${!!serverRoom} viewers=${serverRoom?.viewers.size ?? 0}`,
            );
            client.lastPublishedRoomId = selectedRoom;
            client.lastPublishedRoomAvailability = availability;
          }
        }
      } else {
        const me = await waitFor(request(client, '/api/watch/me', undefined, signal), signal);
        if (client.ws.readyState !== 1) return;
        if (me.status !== 200) {
          send(client, { type: 'unavailable', ...me });
          client.ws.close(4003, 'Sign in again');
          return;
        }
        const raw = JSON.stringify(me.value);
        if (raw !== client.lastIdentityJson) {
          client.lastIdentityJson = raw;
          send(client, { type: 'identity', value: me.value });
        }
        if (path && client.subscription === path) {
          const result = await waitFor(request(client, path, undefined, signal), signal);
          if (client.subscription === path) send(client, { type: 'state', path, ...result });
        }
      }
    } catch {
      // Discovery failure must not invalidate a separately authorized stream. A
      // slow preparation is not a lost connection either: publish again instead
      // of making a healthy browser reconnect and clear its player.
      if (signal.aborted) job.dirty = !client.lifetime.signal.aborted;
      else if (lane === 'room' && !client.lifetime.signal.aborted)
        send(client, { type: 'unavailable', value: { error: 'Room connection temporarily unavailable' } });
    } finally {
      client[key] = undefined;
      if (job.dirty)
        queueMicrotask(() => {
          void publishLane(client, lane);
        });
    }
  }
  // Commands from Discord or internal room timers wake only affected room subscribers when local.
  const dispatch = hub.dispatch.bind(hub);
  hub.dispatch = async (...args) => {
    const cmd = args[1];
    const roomId = cmd?.roomId;
    const hadMedia = Boolean(roomId && watch.rooms.get(roomId)?.media);
    try {
      return await dispatch(...args);
    } finally {
      const hasMedia = Boolean(roomId && watch.rooms.get(roomId)?.media);
      const roomOnly = Boolean(roomId && isRoomLocalAction(cmd?.action) && hadMedia === hasMedia);
      broker.notify(roomOnly ? { roomId, includeLobby: false } : { includeLobby: true });
    }
  };
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/watch-socket') return socket.destroy();
    if (
      !allowed(req.headers.origin) ||
      !throttle('watch-socket:' + (clientAddress(req) || 'local'), 30) ||
      clients.size >= 128
    )
      return socket.destroy();
    wss.handleUpgrade(req, socket, head, (/** @type {WatchSocket} */ ws) => {
      const client = {
        ws,
        socket: req.socket,
        remoteAddress: clientAddress(req),
        headers: /** @type {Record<string, string | undefined>} */ ({
          cookie: req.headers.cookie,
          origin: req.headers.origin,
          'content-type': 'application/json',
        }),
        lastSeen: Date.now(),
        inflight: new Map(),
        running: new Set(),
        lifetime: new AbortController(),
        connectionId: ++nextConnectionId,
        openedAt: Date.now(),
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
        if (client.subscription?.split('?')[0] === '/api/watch/rooms/' + roomId) client.subscription = undefined;
        send(client, { type: 'room-kicked', roomId });
      };
      ws.watchRtts = [];
      ws.on('pong', () => {
        // Native pongs keep presence alive even when the browser throttles its
        // JavaScript timers. Authorization is still checked by publish/requests.
        client.lastSeen = Date.now();
        if (client.authenticated) watch.roomState?.people.reserve(client.userId, client.lastSeen + 60000);
        if (client.authenticated)
          for (const room of watch.rooms.values())
            for (const viewer of room.viewers.values()) if (viewer.watchSocket === ws) viewer.at = client.lastSeen;
        if (client.pingAt === undefined) return;
        const now = performance.now(),
          ms = now - client.pingAt;
        client.pingAt = undefined;
        if (ms >= 0 && ms <= 10000)
          ws.watchRtts = [...ws.watchRtts, { at: now, ms }].filter(sample => now - sample.at <= 30000).slice(-16);
      });
      const timer = setTimeout(() => ws.close(4003, 'Authentication required'), 5000);
      let windowAt = Date.now(),
        count = 0;
      ws.on('error', () => {});
      ws.on('message', raw => {
        void (async () => {
          if (Date.now() - windowAt > 1000) {
            windowAt = Date.now();
            count = 0;
          }
          if (++count > 40) return ws.close(4008, 'Rate limit');
          const message = JSON.parse(raw.toString());
          if (!client.authenticated || message.type === 'auth') {
            if (message.type !== 'auth' || client.authenticating) return ws.close(4003, 'Authentication required');
            client.authenticating = true;
            const headers = { ...client.headers };
            if (message.token !== undefined) {
              if (!/^[a-f0-9]{64}$/.test(message.token)) return ws.close(4003, 'Authentication failed');
              headers.authorization = 'Bearer ' + message.token;
            }
            headers['x-csrf-token'] = message.csrf;
            const auth = await routes.authorized({ headers }, true);
            if (!auth || (client.userId && client.userId !== auth.actor.userId) || ws.readyState !== 1)
              return ws.close(4003, 'Authentication failed');
            try {
              watch.roomState?.people.enter(auth.actor.userId);
            } catch {
              send(client, {
                type: 'unavailable',
                status: 429,
                value: { error: 'Server full; try again when someone leaves' },
              });
              return ws.close(4029, 'Server full');
            }
            client.headers = headers;
            client.userId = auth.actor.userId;
            client.userName = auth.actor.name;
            client.authenticating = false;
            client.authenticated = true;
            hub.directory?.connected(ws, client.userId);
            clearTimeout(timer);
            send(client, { type: 'auth-ok', connectionId: client.connectionId });
            config.logger?.info(
              'Socket',
              `conn=${client.connectionId} User authenticated: ${auth.actor.name || auth.actor.userId} (total clients: ${clients.size})`,
            );
            return;
          }
          client.lastSeen = Date.now();
          hub.directory?.connected(ws, client.userId);
          if (message.type === 'cancel') {
            if (!Number.isSafeInteger(message.id) || message.id < 0) return ws.close(4002, 'Invalid cancellation');
            client.inflight.get(message.id)?.abort();
            return;
          }
          if (message.type === 'clock') {
            if (client.clocking) return;
            client.clocking = true;
            try {
              if (!Number.isSafeInteger(message.id) || message.id < 0) return ws.close(4002, 'Invalid clock message');
              const serverReceivedAt = Date.now(),
                received = performance.now();
              if (!(await routes.authorized({ headers: client.headers }, true))) return ws.close(4003, 'Sign in again');
              for (const room of watch.rooms.values())
                for (const viewer of room.viewers.values()) if (viewer.watchSocket === ws) viewer.at = Date.now();
              send(client, {
                type: 'clock',
                id: message.id,
                serverNow: Date.now(),
                timing: {
                  serverReceivedAt,
                  serverSentAt: Date.now(),
                  serverProcessingMs: performance.now() - received,
                  clockEpoch,
                },
              });
              return;
            } finally {
              client.clocking = false;
            }
          }
          if (message.type === 'sync-quality') {
            if (client.measuring) return;
            client.measuring = true;
            try {
              await syncQuality(client, message);
            } finally {
              client.measuring = false;
            }
            return;
          }
          if (
            message.type !== 'request' ||
            !Number.isSafeInteger(message.id) ||
            message.id < 0 ||
            client.inflight.has(message.id) ||
            client.inflight.size >= 8 ||
            typeof message.path !== 'string' ||
            message.path.length > 1024 ||
            !/^\/api\/(?:watch\/(?:me|profile|admin-mode|playback|events|rooms(?:\/saved|\/[a-f0-9-]{36}(?:\/(?:command|close|leave|ready|observe|delivery|reopen|settings|queue|history|people|check|share|events))?)?|library(?:\/(?:item|filters|availability))?))(?:\?[^#]*)?$/.test(
              message.path,
            )
          )
            return ws.close(4002, 'Invalid message');
          if (client.running.size >= 16) {
            send(client, {
              type: 'response',
              id: message.id,
              status: 429,
              value: { error: 'Previous work is still retiring; retry shortly' },
            });
            return;
          }
          const controller = new AbortController();
          const timeout = Number.isFinite(message.timeoutMs)
            ? Math.min(120000, Math.max(1000, message.timeoutMs))
            : 12000;
          const signal = AbortSignal.any([controller.signal, client.lifetime.signal, AbortSignal.timeout(timeout)]);
          client.inflight.set(message.id, controller);
          try {
            const scope =
              message.data !== undefined && !message.path.endsWith('/observe')
                ? classifyMutationScope(message.path, message.data)
                : undefined;
            const hadMedia = Boolean(scope?.roomId && watch.rooms.get(scope.roomId)?.media);
            const operation = request(client, message.path, message.data, signal);
            client.running.add(operation);
            operation.finally(() => client.running.delete(operation)).catch(() => {});
            const result = await waitFor(operation, signal);
            if (result.status === 200 && result.subscription) client.subscription = result.subscription;
            if (/^\/api\/watch\/rooms\/[a-f0-9-]{36}\?/.test(message.path) && result.status === 200)
              client.subscription = message.path;
            if (
              /\/(leave|close)$/.test(message.path) &&
              client.subscription?.split('?')[0] === message.path.replace(/\/(leave|close)$/, '')
            )
              client.subscription = undefined;

            send(client, { type: 'response', id: message.id, status: result.status, value: result.value });
            if (scope) {
              const hasMedia = Boolean(scope.roomId && watch.rooms.get(scope.roomId)?.media);
              broker.notify(!scope.includeLobby && hadMedia === hasMedia ? scope : { includeLobby: true });
            }
          } catch (error) {
            if (!signal.aborted) throw error;
            if (!controller.signal.aborted)
              send(client, {
                type: 'response',
                id: message.id,
                status: 503,
                value: { error: 'Operation timed out; refresh state before retrying a change' },
              });
          } finally {
            client.inflight.delete(message.id);
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
        const attached = [...watch.rooms.values()].reduce(
          (n, room) => n + [...room.viewers.values()].filter(viewer => viewer.watchSocket === ws).length,
          0,
        );
        config.logger?.debug(
          'Socket',
          `conn=${client.connectionId} closed code=${code} reason=${JSON.stringify(reason)} source=${client.terminationCause || 'peer-or-network'} account=${JSON.stringify(client.userName || client.userId || 'unauthenticated')} ageMs=${Date.now() - client.openedAt} attachedViewers=${attached} (remaining: ${clients.size - 1})`,
        );
        if (attached) {
          const planned = code === 1000 || code === 1001 || client.terminationCause === 'server-shutdown',
            now = Date.now();
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
        // before the same viewer has an opportunity to reattach. The normal
        // 10-second presence sweep still expires truly disconnected viewers.
        // Graceful tab exits and protocol/authorization closures retain the
        // prior immediate-cleanup behavior.
        const unexpected =
          (code === 1005 || code === 1006) &&
          client.terminationCause !== 'server-shutdown' &&
          client.terminationCause !== 'backpressure';
        const disconnectedAt = Date.now();
        for (const room of watch.rooms.values()) {
          for (const viewer of room.viewers.values())
            if (viewer.watchSocket === ws) {
              viewer.at = unexpected ? disconnectedAt : disconnectedAt - 10001;
            }
          watch.refresh(room);
        }
        if (client.authenticated) broker.notify({ includeLobby: true });
      });
    });
  });
  const timer = setInterval(() => {
    for (const client of clients) {
      if (Date.now() - client.lastSeen >= 10000) {
        client.terminationCause = 'server-idle-timeout';
        client.ws.terminate();
      } else {
        if (client.pingAt === undefined && client.ws.readyState === 1) {
          client.pingAt = performance.now();
          client.ws.ping();
        }
        void publish(client);
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
