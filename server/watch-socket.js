// @ts-check
'use strict';
const { WebSocketServer } = require('ws');
/**
 * @typedef {Object} ControlRequest
 * @property {'request'} type
 * @property {number} id Connection-local correlation ID; never replayed.
 * @property {string} path Allowlisted resource and optional query.
 * @property {Object} [data] Mutation body, including existing epoch/expiry fences.
 */

// WebSocket framing calls shared operations directly; commands are never replayed.
function watchSockets({ server, config, routes, watch, hub, throttle, flush = async () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  const clockEpoch = routes.clockEpoch;
  const allowed = origin => origin === config.publicUrl || /^\d{17,20}$/.test(config.clientId || '') && origin === `https://${config.clientId}.discordsays.com`;
  const clients = new Set();
  function send(client, message) {
    if (client.ws.readyState !== 1) return;
    if (client.ws.bufferedAmount > 1024 * 1024) { client.ws.terminate(); return; }
    const raw=JSON.stringify(message);
    if(Buffer.byteLength(raw)>1024*1024){client.ws.close(4009,'Room response too large');return;}
    client.ws.send(raw);
  }
  const request = (client, path, data) => routes.execute({ headers: client.headers, controlSocket: client.ws }, path, data);
  async function publish(client) {
    if (!client.authenticated || client.ws.readyState !== 1) return;
    if(client.publishing){client.dirty=true;return;}
    client.publishing = true;
    const path = client.subscription;
    try {
      const me = await request(client, '/api/watch/me');
      if (client.ws.readyState !== 1) return;
      if (me.status !== 200) { send(client, { type: 'unavailable', ...me }); client.ws.close(4003, 'Sign in again'); return; }
      send(client, { type: 'identity', value: me.value });
      const rooms = await request(client, '/api/watch/rooms');
      send(client, { type: 'rooms', ...rooms });
      if (path && client.subscription === path) {
        const result = await request(client, path);
        if (client.subscription === path) send(client, { type: 'state', path, ...result });
      }
    } catch { send(client, { type: 'unavailable', value: { error: 'Room connection temporarily unavailable' } }); }
    finally { client.publishing = false; if(client.dirty){client.dirty=false;queueMicrotask(()=>{void publish(client);});} }
  }
  let changeQueued=false;
  function changed() {
    if(changeQueued)return;changeQueued=true;
    setImmediate(()=>{changeQueued=false;for(const client of clients)void publish(client);});
  }
  // Commands from Discord also wake subscriptions immediately.
  const dispatch = hub.dispatch.bind(hub);
  hub.dispatch = async (...args) => { try { return await dispatch(...args); } finally { changed(); } };
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/watch-socket') return;
    if (!allowed(req.headers.origin) || !throttle('watch-socket:' + req.socket.remoteAddress, 30) || clients.size >= 128) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => {
      const client = { ws, socket: req.socket, headers: { cookie: req.headers.cookie, origin: req.headers.origin, 'content-type': 'application/json' }, lastSeen: Date.now(), inflight: new Set() };
      clients.add(client);
      ws.watchRtts = [];
      ws.on('pong', () => {
        if (client.pingAt === undefined) return;
        const now = performance.now(), ms = now - client.pingAt; client.pingAt = undefined;
        if (ms >= 0 && ms <= 10000) ws.watchRtts = [...ws.watchRtts, {at:now, ms}].filter(sample => now - sample.at <= 30000).slice(-16);
      });
      const timer = setTimeout(() => ws.close(4003, 'Authentication required'), 5000);
      let windowAt = Date.now(), count = 0;
      ws.on('error', () => {});
      ws.on('message', raw => {
        void (async () => {
          if (Date.now() - windowAt > 1000) { windowAt = Date.now(); count = 0; }
          if (++count > 40) return ws.close(4008, 'Rate limit');
          const message = JSON.parse(raw.toString());
          if (!client.authenticated || message.type === 'auth') {
            if (message.type !== 'auth' || client.authenticating) return ws.close(4003, 'Authentication required');
            client.authenticating = true;
            const headers={...client.headers};
            if (message.token !== undefined) {
              if (!/^[a-f0-9]{64}$/.test(message.token)) return ws.close(4003, 'Authentication failed');
              headers.authorization = 'Bearer ' + message.token;
            }
            headers['x-csrf-token'] = message.csrf;
            const auth=await routes.authorized({ headers }, true);
            if (!auth || client.userId && client.userId !== auth.actor.userId || ws.readyState !== 1) return ws.close(4003, 'Authentication failed');
            client.headers=headers;
            client.userId=auth.actor.userId;client.authenticating=false;
            client.authenticated = true; clearTimeout(timer); send(client, { type: 'auth-ok' }); return;
          }
          client.lastSeen = Date.now();
          if (message.type === 'clock') {
            if(!Number.isSafeInteger(message.id)||message.id<0)return ws.close(4002,'Invalid clock message');
            const serverReceivedAt = Date.now(), received = performance.now();
            if (!await routes.authorized({ headers: client.headers }, true)) return ws.close(4003, 'Sign in again');
            for(const room of watch.rooms.values())for(const viewer of room.viewers.values())if(viewer.watchSocket===ws)viewer.at=Date.now();
            send(client, { type: 'clock', id: message.id, serverNow: Date.now(), timing: { serverReceivedAt, serverSentAt: Date.now(), serverProcessingMs: performance.now() - received, clockEpoch } }); return;
          }
          if (message.type !== 'request' || !Number.isSafeInteger(message.id) || message.id < 0 || client.inflight.has(message.id) || client.inflight.size >= 8 ||
            typeof message.path !== 'string' || message.path.length > 1024 || !/^\/api\/(?:rooms|command|watch\/(?:me|admin-mode|playback|rooms(?:\/[a-f0-9-]{36}(?:\/(?:command|close|leave|ready|observe))?)?|library(?:\/(?:item|filters))?))(?:\?[^#]*)?$/.test(message.path)) return ws.close(4002, 'Invalid message');
          client.inflight.add(message.id);
          try {
            const result = await request(client, message.path, message.data);
            if (/^\/api\/watch\/rooms\/[a-f0-9-]{36}\?/.test(message.path) && result.status === 200) client.subscription = message.path;
            if (/\/(leave|close)$/.test(message.path) && client.subscription?.split('?')[0] === message.path.replace(/\/(leave|close)$/, '')) client.subscription = undefined;
            await flush();
            send(client, { type: 'response', id: message.id, ...result });
            if (message.data !== undefined&&!message.path.endsWith('/observe')) changed();
          } finally { client.inflight.delete(message.id); }
        })().catch(() => ws.close(4002, 'Request failed'));
      });
      ws.on('close', () => {
        clearTimeout(timer); clients.delete(client);
        for (const room of watch.rooms.values()) {
          for (const viewer of room.viewers.values()) if (viewer.watchSocket === ws) viewer.at = Date.now() - 10001;
          watch.refresh(room);
        }
        changed();
      });
    });
  });
  const timer = setInterval(() => {
    for (const client of clients) {
      if (Date.now() - client.lastSeen >= 10000) client.ws.terminate();
      else { if (client.pingAt === undefined && client.ws.readyState === 1) { client.pingAt = performance.now(); client.ws.ping(); } void publish(client); }
    }
  }, 1000); timer.unref();
  return { close() { clearInterval(timer); for (const client of clients) client.ws.terminate(); wss.close(); } };
}
module.exports = { watchSockets };
