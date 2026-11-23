'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const https = require('node:https');
const WebSocket = require('ws');
const { fixture } = require('./helpers/account-app');
const { accessPolicy } = require('./helpers/access');
const { PROTOCOL_VERSION } = require('../shared/wire-protocol.mjs');
const { detectLanOrigins, isAllowedBrowserOrigin } = require('../server/origins');

const LAN_ORIGIN = 'https://192.168.88.10:5756';
const LAN_HOST = '192.168.88.10:5756';

function tokenOf(url) {
  return new URL(url).hash.slice(1);
}

/** Sends a raw HTTPS request to the test server with explicit Host/Origin headers and a cookie jar. */
function makeClient(port, origin, host) {
  const jar = new Map();
  const cookieHeader = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const request = (route, data, extraHeaders = {}) =>
    new Promise((resolve, reject) => {
      const headers = {
        Host: host,
        ...(data !== undefined ? { 'Content-Type': 'application/json', Origin: origin } : {}),
        ...(jar.size ? { Cookie: cookieHeader() } : {}),
        ...extraHeaders,
      };
      const req = https.request(
        {
          hostname: '127.0.0.1',
          port,
          path: route,
          method: data === undefined ? 'GET' : 'POST',
          rejectUnauthorized: false,
          headers,
        },
        res => {
          for (const rawCookie of res.headers['set-cookie'] || []) {
            const pair = rawCookie.split(';')[0];
            const eq = pair.indexOf('=');
            const name = pair.slice(0, eq);
            if (/;\s*Max-Age=0\b/i.test(rawCookie)) jar.delete(name);
            else jar.set(name, pair.slice(eq + 1));
          }
          const chunks = [];
          res.on('data', chunk => chunks.push(chunk));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString();
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: res.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  return { request, cookieHeader, jar };
}

test('server.lan_url allows native uburoom account sign-in, room creation, WebSocket, and logout while blocking foreign origins', async t => {
  const { app, config, provider, browser } = await fixture(t, undefined, {
    lanUrl: LAN_ORIGIN,
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  config.serverOperator = { identities: [{ provider: 'discord', subject: provider.subjects.host }] };
  const port = app.server.address().port;

  // Create a native uburoom account via the operator on public_url.
  const operator = browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  const created = (await operator.post('/api/operator/accounts', { username: 'alice' })).body;
  assert.ok(created.link?.url.startsWith(config.publicUrl + '/account/password#'), 'password links stay on public_url');

  // Set password and sign in from the LAN origin.
  const lan = makeClient(port, LAN_ORIGIN, LAN_HOST);
  const setPw = await lan.request('/api/uburoom-accounts/password', {
    token: tokenOf(created.link.url),
    password: 'alice lan password',
  });
  assert.equal(setPw.status, 200);

  const me = await lan.request('/api/watch/me');
  assert.equal(me.status, 200);
  assert.ok(me.body.csrf);

  // Connect to /watch-socket from the LAN origin, authenticate with the LAN session cookie + CSRF, and create a room.
  const ws = new WebSocket(`wss://127.0.0.1:${port}/watch-socket`, {
    rejectUnauthorized: false,
    origin: LAN_ORIGIN,
    headers: { Host: LAN_HOST, Cookie: lan.cookieHeader() },
  });
  t.after(() => ws.terminate());
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, csrf: me.body.csrf }));
  const [raw] = await once(ws, 'message');
  const welcome = JSON.parse(raw.toString());
  assert.equal(welcome.type, 'welcome');

  const resultPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for rooms.create ack')), 5000);
    const onMessage = data => {
      const msg = JSON.parse(data.toString());
      if ((msg.type === 'ack' || msg.type === 'error') && msg.id === 1) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(msg);
      }
    };
    ws.on('message', onMessage);
  });
  ws.send(JSON.stringify({ type: 'call', id: 1, op: 'rooms.create', args: {} }));
  const createdRoom = await resultPromise;
  assert.equal(createdRoom.type, 'ack');
  assert.ok(createdRoom.value?.id);

  // Explicit sign-in via /api/uburoom-accounts/sign-in also works from the LAN origin.
  const lan2 = makeClient(port, LAN_ORIGIN, LAN_HOST);
  const signIn = await lan2.request('/api/uburoom-accounts/sign-in', {
    username: 'alice',
    password: 'alice lan password',
  });
  assert.equal(signIn.status, 200);
  assert.equal((await lan2.request('/api/me')).body.loggedIn, true);

  // A foreign origin is still rejected on both HTTP POST and WebSocket upgrade.
  const evil = makeClient(port, 'https://evil.example', 'evil.example');
  const evilSignIn = await evil.request('/api/uburoom-accounts/sign-in', {
    username: 'alice',
    password: 'alice lan password',
  });
  assert.equal(evilSignIn.status, 403);

  const evilWs = new WebSocket(`wss://127.0.0.1:${port}/watch-socket`, {
    rejectUnauthorized: false,
    origin: 'https://evil.example',
    headers: { Cookie: lan.cookieHeader() },
  });
  const [wsErr] = await once(evilWs, 'error');
  assert.ok(wsErr, 'foreign origin WebSocket upgrade must be rejected');

  // Logout works from the LAN origin and clears the session.
  const logout = await lan.request('/api/logout', {}, { 'X-CSRF-Token': me.body.csrf });
  assert.equal(logout.status, 200);
  assert.equal((await lan.request('/api/me')).body.loggedIn, false);
});

test('Discord and Plex sign-in and linking fail clearly on server.lan_url while still working on server.public_url', async t => {
  const { app, config, provider, browser } = await fixture(t, undefined, {
    lanUrl: LAN_ORIGIN,
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  config.serverOperator = { identities: [{ provider: 'discord', subject: provider.subjects.host }] };
  const port = app.server.address().port;

  // Create a native account so we can also test account-linking routes on LAN.
  const operator = browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  const created = (await operator.post('/api/operator/accounts', { username: 'bob' })).body;

  const lan = makeClient(port, LAN_ORIGIN, LAN_HOST);

  // GET /auth/discord on LAN redirects to /auth/error with a clear message pointing to public_url.
  const discordStart = await lan.request('/auth/discord');
  assert.equal(discordStart.status, 302);
  assert.equal(discordStart.headers.location, '/auth/error');
  const discordErr = await lan.request('/api/account/auth-error');
  assert.equal(discordErr.status, 200);
  assert.match(discordErr.body.error, new RegExp(config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // GET /auth/plex on LAN redirects to /auth/error with a clear message pointing to public_url.
  const plexStart = await lan.request('/auth/plex');
  assert.equal(plexStart.status, 302);
  assert.equal(plexStart.headers.location, '/auth/error');
  const plexErr = await lan.request('/api/account/auth-error');
  assert.equal(plexErr.status, 200);
  assert.match(plexErr.body.error, new RegExp(config.publicUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

  // Signed-in LAN user trying to link Discord or Plex gets a clear 400 JSON error.
  await lan.request('/api/uburoom-accounts/password', {
    token: tokenOf(created.link.url),
    password: 'bob lan password',
  });
  const csrf = (await lan.request('/api/watch/me')).body.csrf;

  const linkDiscord = await lan.request('/api/account/discord/connect', {}, { 'X-CSRF-Token': csrf });
  assert.equal(linkDiscord.status, 400);
  assert.match(linkDiscord.body.error, /only available at/);

  const linkPlex = await lan.request('/api/account/plex/connect', {}, { 'X-CSRF-Token': csrf });
  assert.equal(linkPlex.status, 400);
  assert.match(linkPlex.body.error, /only available at/);

  // Public URL OAuth still works normally.
  const pub = browser();
  const pubDiscord = await pub.discord('host');
  assert.equal(pubDiscord.status, 302);
  assert.equal((await pub.request('/api/me')).body.loggedIn, true);
});

test('server.lan_url: auto detects local private IPs and hostname on server.port and enforces local peers', async t => {
  const detected = detectLanOrigins(
    { port: 5756, publicUrl: 'https://watch.example' },
    {
      hostname: 'Vigrid',
      interfaces: {
        eth0: [
          { address: '192.168.88.10', family: 'IPv4', internal: false },
          { address: '203.0.113.5', family: 'IPv4', internal: false },
          { address: 'fd12:3456::1', family: 'IPv6', internal: false },
          { address: 'fe80::1%eth0', family: 'IPv6', internal: false },
        ],
      },
    },
  );
  assert.ok(detected.has('https://192.168.88.10:5756'));
  assert.ok(detected.has('https://vigrid:5756'));
  assert.ok(detected.has('https://vigrid.local:5756'));
  assert.ok(detected.has('https://[fd12:3456::1]:5756'));
  assert.ok(detected.has('https://localhost:5756'));
  assert.equal(detected.has('https://203.0.113.5:5756'), false, 'public IPv4 is not a LAN origin');
  assert.equal(detected.has('https://watch.example'), false, 'public_url is never classified as a LAN origin');

  const autoCfg = {
    publicUrl: 'https://watch.example',
    lanUrl: 'auto',
    listen: 'https',
    lanAutoOrigins: ['https://192.168.88.10:5756', 'https://vigrid:5756'],
  };
  assert.equal(
    isAllowedBrowserOrigin(autoCfg, 'https://vigrid:5756', { socket: { remoteAddress: '192.168.88.42' } }),
    true,
  );
  assert.equal(
    isAllowedBrowserOrigin(autoCfg, 'https://vigrid:5756', { socket: { remoteAddress: '203.0.113.99' } }),
    false,
    'non-local peer cannot use lan_url: auto',
  );
  assert.equal(
    isAllowedBrowserOrigin({ ...autoCfg, listen: 'http-proxy' }, 'https://vigrid:5756', {
      socket: { remoteAddress: '192.168.88.42' },
    }),
    false,
    'http-proxy mode disables lan_url: auto',
  );

  // End-to-end: both IP and hostname origins work under lan_url: 'auto'.
  const { app, config, provider, browser } = await fixture(t, undefined, {
    lanUrl: 'auto',
    lanAutoOrigins: ['https://192.168.88.10:5756', 'https://vigrid:5756'],
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  config.serverOperator = { identities: [{ provider: 'discord', subject: provider.subjects.host }] };
  const port = app.server.address().port;
  const operator = browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  const created = (await operator.post('/api/operator/accounts', { username: 'carol' })).body;

  const byHost = makeClient(port, 'https://vigrid:5756', 'vigrid:5756');
  assert.equal(
    (
      await byHost.request('/api/uburoom-accounts/password', {
        token: tokenOf(created.link.url),
        password: 'carol auto password',
      })
    ).status,
    200,
  );
  const byIp = makeClient(port, 'https://192.168.88.10:5756', '192.168.88.10:5756');
  assert.equal(
    (await byIp.request('/api/uburoom-accounts/sign-in', { username: 'carol', password: 'carol auto password' }))
      .status,
    200,
  );
  assert.equal((await byIp.request('/api/me')).body.loggedIn, true);
});
