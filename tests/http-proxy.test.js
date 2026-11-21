'use strict';
// server.listen: 'http-proxy' (docs/tls-and-remote-access.md T1-T3): plain HTTP only for the
// configured proxies, proof the browser used HTTPS, and /health for this machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const { normalizeConfig } = require('../server/config');

const PUBLIC = 'https://watch.example.test';

async function proxyApp(t, trustedProxies, host = '127.0.0.1') {
  const app = createApp({
    publicUrl: PUBLIC,
    listen: 'http-proxy',
    trustedProxies,
    trustedProxyHeader: 'x-forwarded-for',
    ownerId: '100000000000000001',
    clientId: '100000000000000010',
    clientSecret: 'fixture-secret',
    guildId: 'guild',
    channels: ['commands'],
    sources: [],
  });
  await new Promise(resolve => app.server.listen(0, host, resolve));
  t.after(() => app.close());
  return { app, port: app.server.address().port };
}

/** One plain HTTP request; resolves {status, headers, body} or {error} when the server drops the connection. */
function get(address, port, path, headers = {}) {
  return new Promise(resolve => {
    const req = http.request({ host: address, port, path, headers: { Connection: 'close', ...headers } }, res => {
      let body = '';
      res.on('data', chunk => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', error => resolve({ error: error.code || error.message }));
    req.end();
  });
}

test("server.listen: 'http-proxy' needs trusted proxies; https stays the default", () => {
  assert.equal(normalizeConfig({}).listen, 'https');
  assert.throws(() => normalizeConfig({ server: { listen: 'http-proxy' } }), /trusted_proxies/);
  assert.throws(() => normalizeConfig({ server: { listen: 'http' } }), /server\.listen/);
  const config = normalizeConfig({ server: { listen: 'http-proxy', trusted_proxies: ['172.30.0.0/24'] } });
  assert.equal(config.listen, 'http-proxy');
  assert.equal(config.publicUrl.startsWith('https://'), true);
  assert.throws(
    () =>
      normalizeConfig({
        server: { listen: 'http-proxy', trusted_proxies: ['127.0.0.1'], public_url: 'http://watch.example.test' },
      }),
    /HTTPS/,
    'public_url stays HTTPS behind a proxy',
  );
});

test('a trusted proxy must say the browser used HTTPS; cookies stay Secure; /health needs no proof', async t => {
  const { port } = await proxyApp(t, ['127.0.0.1']);
  const plain = await get('127.0.0.1', port, '/api/watch/config');
  assert.equal(plain.status, 421);
  assert.match(JSON.parse(plain.body).error, /X-Forwarded-Proto: https/);
  assert.equal((await get('127.0.0.1', port, '/api/watch/config', { 'X-Forwarded-Proto': 'http' })).status, 421);
  assert.equal((await get('127.0.0.1', port, '/health')).status, 200);
  const page = await get('127.0.0.1', port, '/auth/handoff', { 'X-Forwarded-Proto': 'https' });
  assert.equal(page.status, 200);
  assert.match(String(page.headers['set-cookie']), /; Secure;/);
  assert.equal((await get('127.0.0.1', port, '/api/watch/config', { 'X-Forwarded-Proto': 'https' })).status, 200);
});

test('room connections through the proxy need the HTTPS proof too', async t => {
  const { port } = await proxyApp(t, ['127.0.0.1']);
  const connect = headers =>
    new Promise(resolve => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/watch-socket`, { headers: { Origin: PUBLIC, ...headers } });
      ws.once('open', () => {
        ws.close();
        resolve('open');
      });
      ws.once('unexpected-response', (_req, res) => resolve(res.statusCode));
      ws.once('error', () => resolve('refused'));
    });
  assert.equal(await connect({}), 421);
  assert.equal(await connect({ 'X-Forwarded-Proto': 'https' }), 'open');
});

test('this machine, when it is not a trusted proxy, may only ask /health', async t => {
  const { port } = await proxyApp(t, ['::1']);
  assert.equal((await get('127.0.0.1', port, '/health')).status, 200);
  const page = await get('127.0.0.1', port, '/api/watch/config', { 'X-Forwarded-Proto': 'https' });
  assert.ok(page.error, 'the connection is dropped, not answered');
  const ws = new WebSocket(`ws://127.0.0.1:${port}/watch-socket`, {
    headers: { Origin: PUBLIC, 'X-Forwarded-Proto': 'https' },
  });
  const [outcome] = await Promise.race([once(ws, 'error'), once(ws, 'open').then(() => ['open'])]);
  assert.notEqual(outcome, 'open');
  ws.terminate();
});

const lan = Object.values(os.networkInterfaces())
  .flat()
  .find(item => item && item.family === 'IPv4' && !item.internal)?.address;

test(
  'a peer that is not a trusted proxy is disconnected before any request',
  { skip: !lan && 'no LAN address' },
  async t => {
    const { port } = await proxyApp(t, ['127.0.0.1'], '0.0.0.0');
    for (const path of ['/health', '/api/watch/config'])
      assert.ok((await get(lan, port, path, { 'X-Forwarded-Proto': 'https' })).error, path);
    assert.equal((await get('127.0.0.1', port, '/api/watch/config', { 'X-Forwarded-Proto': 'https' })).status, 200);
  },
);
