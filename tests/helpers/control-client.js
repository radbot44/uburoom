'use strict';
const https = require('node:https');
const { WebSocket } = require('ws');
const { requestByPath, hello } = require('./wire-paths');

// Integration fixtures retain authenticated sockets, just like a browser tab.
// HTTP bootstrap/media requests remain in each fixture's ordinary HTTP helper.
function controlClient(t, config, cert) {
  const clients = new Map();
  const handles = path => /^\/api\/(?:rooms|command|watch\/(?:rooms|admin-mode))(?:[/?]|$)/.test(path);
  t.after(() => {
    for (const client of clients.values()) client.ws?.terminate();
  });
  async function request(path, data, supplied = {}) {
    const headers = Object.fromEntries(
      Object.entries({ Origin: config.publicUrl, ...supplied }).map(([key, value]) => [key.toLowerCase(), value]),
    );
    if (headers.cookie && !headers['x-csrf-token'] && data === undefined) {
      headers['x-csrf-token'] = await new Promise((resolve, reject) => {
        const req = https.get(config.publicUrl + '/api/watch/me', { ca: cert, headers }, res => {
          let raw = '';
          res.on('data', bytes => (raw += bytes));
          res.on('end', () => resolve(JSON.parse(raw).csrf));
        });
        req.on('error', reject);
      });
    }
    const key = JSON.stringify(headers);
    let client = clients.get(key);
    if (!client || client.ws.readyState >= 2) {
      client = { pending: new Map(), sequence: 0 };
      clients.set(key, client);
      const wsHeaders = { ...(headers.cookie ? { Cookie: headers.cookie } : {}) };
      for (const h of ['cf-connecting-ip', 'x-forwarded-for', 'x-real-ip']) if (headers[h]) wsHeaders[h] = headers[h];
      const ws = (client.ws = new WebSocket(config.publicUrl.replace('https:', 'wss:') + '/watch-socket', {
        ca: cert,
        origin: headers.origin,
        headers: wsHeaders,
      }));
      client.auth = new Promise(resolve => {
        const timer = setTimeout(() => {
          ws.terminate();
          resolve(false);
        }, 5000);
        ws.on('open', () =>
          ws.send(
            JSON.stringify(
              hello({ token: headers.authorization?.replace(/^Bearer /, ''), csrf: headers['x-csrf-token'] }),
            ),
          ),
        );
        ws.on('message', raw => {
          const message = JSON.parse(raw);
          if (message.type === 'welcome') {
            clearTimeout(timer);
            client.heartbeat = setInterval(() => {
              if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'clock', id: 0 }));
            }, 1000);
            resolve(true);
          }
          if (message.type === 'error' && message.id === undefined)
            client.denial = { status: message.status, value: { error: message.message } };
          if (message.type === 'ack' || (message.type === 'error' && message.id !== undefined))
            client.pending.get(message.id)?.(message);
        });
        ws.on('error', () => {});
        ws.on('close', () => {
          clearInterval(client.heartbeat);
          clearTimeout(timer);
          resolve(false);
          for (const done of client.pending.values())
            done({ type: 'error', status: 401, message: 'Connection closed' });
        });
      });
    }
    if (!(await client.auth))
      return {
        status: client.denial?.status || 401,
        body: client.denial?.value || { error: 'Authentication failed' },
        headers: {},
      };
    const send = message =>
      new Promise((resolve, reject) => {
        const id = ++client.sequence;
        const timer = setTimeout(() => {
          client.pending.delete(id);
          reject(new Error('Control fixture timed out: ' + path));
        }, 15000);
        client.pending.set(id, answer => {
          clearTimeout(timer);
          client.pending.delete(id);
          resolve(answer);
        });
        client.ws.send(JSON.stringify({ ...message, id }));
      });
    return { ...(await requestByPath(send, path, data)), headers: {} };
  }
  return { handles, request };
}
module.exports = { controlClient };
