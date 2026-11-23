'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { X509Certificate } = require('node:crypto');
const https = require('node:https');
const WebSocket = require('ws');
const { fixture } = require('./helpers/account-app');
const { accessPolicy } = require('./helpers/access');
const { PROTOCOL_VERSION } = require('../shared/wire-protocol.mjs');
const { detectLanOrigins, isAllowedBrowserOrigin } = require('../server/origins');
const { generateDevCert } = require('../scripts/new-dev-cert');

const LAN_ORIGIN = 'https://192.168.1.10:5756';
const LAN_HOST = '192.168.1.10:5756';

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

test('Discord and Plex sign-in and linking work on server.lan_url via one-time handoff and enforce ticket/nonce binding', async t => {
  const { app, config, provider, browser } = await fixture(t, undefined, {
    lanUrl: LAN_ORIGIN,
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  config.serverOperator = { identities: [{ provider: 'discord', subject: provider.subjects.host }] };
  const port = app.server.address().port;
  const pubHost = new URL(config.publicUrl).host;

  // Separate cookie jars simulate the browser's per-origin __Host- cookie isolation.
  const lan = makeClient(port, LAN_ORIGIN, LAN_HOST);
  const pub = makeClient(port, config.publicUrl, pubHost);

  // 1. Discord sign-in started on LAN with a return target bounces through public_url and signs in on LAN only.
  const dStart = await lan.request('/auth/discord?return=%2Froom%2Fmovie-night');
  assert.equal(dStart.status, 302);
  assert.ok(dStart.headers.location.startsWith(config.publicUrl + '/auth/lan-start?t='));
  assert.ok(lan.jar.has('__Host-uburoom_lan_handoff'));

  const startUrl = new URL(dStart.headers.location);
  const dPubStart = await pub.request(startUrl.pathname + startUrl.search);
  assert.equal(dPubStart.status, 302);
  assert.ok(pub.jar.has('__Host-uburoom_oauth'));
  // Start token is single-use.
  const reusedStart = await pub.request(startUrl.pathname + startUrl.search);
  assert.equal(reusedStart.status, 302);
  assert.equal(reusedStart.headers.location, '/auth/error');

  const dState = new URL(dPubStart.headers.location, config.publicUrl).searchParams.get('state');
  const dCallback = await pub.request('/auth/callback?' + new URLSearchParams({ state: dState, code: 'host' }));
  assert.equal(dCallback.status, 302);
  assert.ok(dCallback.headers.location.startsWith(LAN_ORIGIN + '/auth/lan#ticket='));
  assert.equal(pub.jar.has('__Host-uburoom'), false, 'public_url must not receive a session cookie for a LAN sign-in');

  const dTicket = new URL(dCallback.headers.location).hash.slice('#ticket='.length);

  // A different LAN browser without the matching LAN handoff nonce cookie cannot steal the ticket.
  const thief = makeClient(port, LAN_ORIGIN, LAN_HOST);
  // First verify wrong origin (public_url) is rejected 403 without consuming the ticket.
  assert.equal((await pub.request('/api/auth/lan-handoff', { ticket: dTicket })).status, 403);
  // Verify the /auth/lan page is served with no-referrer.
  const lanPage = await lan.request('/auth/lan');
  assert.equal(lanPage.status, 200);
  assert.equal(lanPage.headers['referrer-policy'], 'no-referrer');

  // Redeem on the originating LAN browser.
  const dRedeem = await lan.request('/api/auth/lan-handoff', { ticket: dTicket });
  assert.equal(dRedeem.status, 200);
  assert.equal(dRedeem.body.destination, '/room/movie-night');
  assert.equal((await lan.request('/api/me')).body.loggedIn, true);
  assert.equal((await pub.request('/api/me')).body.loggedIn, false);
  // Ticket is single-use.
  assert.equal((await lan.request('/api/auth/lan-handoff', { ticket: dTicket })).status, 400);

  // 2. Plex sign-in started on LAN completes on LAN via handoff, and missing nonce fails.
  const lan2 = makeClient(port, LAN_ORIGIN, LAN_HOST);
  const pub2 = makeClient(port, config.publicUrl, pubHost);
  const pStart = await lan2.request('/auth/plex');
  assert.equal(pStart.status, 302);
  assert.ok(pStart.headers.location.startsWith(config.publicUrl + '/auth/lan-start?t='));

  const pStartUrl = new URL(pStart.headers.location);
  const pPubStart = await pub2.request(pStartUrl.pathname + pStartUrl.search);
  assert.equal(pPubStart.status, 302);
  const pState = new URL(pPubStart.headers.location, config.publicUrl).searchParams.get('state');
  const pDemo = await pub2.request('/auth/plex/demo?' + new URLSearchParams({ state: pState, persona: 'alice' }));
  assert.equal(pDemo.status, 302);
  const pCallback = await pub2.request(pDemo.headers.location);
  assert.equal(pCallback.status, 302);
  assert.ok(pCallback.headers.location.startsWith(LAN_ORIGIN + '/auth/lan#ticket='));

  const pTicket = new URL(pCallback.headers.location).hash.slice('#ticket='.length);
  // Thief without the LAN nonce cookie fails (and consumes the ticket).
  assert.equal((await thief.request('/api/auth/lan-handoff', { ticket: pTicket })).status, 400);

  // Fresh Plex sign-in succeeds on the originating LAN browser.
  const pStart2 = await lan2.request('/auth/plex');
  const pPubStart2 = await pub2.request(
    new URL(pStart2.headers.location).pathname + new URL(pStart2.headers.location).search,
  );
  const pState2 = new URL(pPubStart2.headers.location, config.publicUrl).searchParams.get('state');
  const pDemo2 = await pub2.request('/auth/plex/demo?' + new URLSearchParams({ state: pState2, persona: 'alice' }));
  const pCallback2 = await pub2.request(pDemo2.headers.location);
  const pTicket2 = new URL(pCallback2.headers.location).hash.slice('#ticket='.length);
  const pRedeem = await lan2.request('/api/auth/lan-handoff', { ticket: pTicket2 });
  assert.equal(pRedeem.status, 200);
  assert.equal(pRedeem.body.destination, '/');
  assert.equal((await lan2.request('/api/me')).body.loggedIn, true);

  // 3. Linking Plex to an existing native uburoom account on LAN works via handoff.
  const operator = browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  const created = (await operator.post('/api/operator/accounts', { username: 'bob' })).body;

  const lanBob = makeClient(port, LAN_ORIGIN, LAN_HOST);
  const pubBob = makeClient(port, config.publicUrl, pubHost);
  await lanBob.request('/api/uburoom-accounts/password', {
    token: tokenOf(created.link.url),
    password: 'bob lan password',
  });
  const bobCsrf = (await lanBob.request('/api/watch/me')).body.csrf;

  const linkPlex = await lanBob.request('/api/account/plex/connect', {}, { 'X-CSRF-Token': bobCsrf });
  assert.equal(linkPlex.status, 200);
  assert.ok(linkPlex.body.url.startsWith(config.publicUrl + '/auth/lan-start?t='));
  const lpStart = await pubBob.request(new URL(linkPlex.body.url).pathname + new URL(linkPlex.body.url).search);
  const lpState = new URL(lpStart.headers.location, config.publicUrl).searchParams.get('state');
  const lpDemo = await pubBob.request('/auth/plex/demo?' + new URLSearchParams({ state: lpState, persona: 'bob' }));
  const lpCallback = await pubBob.request(lpDemo.headers.location);
  assert.equal(lpCallback.status, 302);
  assert.ok(lpCallback.headers.location.startsWith(LAN_ORIGIN + '/auth/lan#ticket='));
  const lpTicket = new URL(lpCallback.headers.location).hash.slice('#ticket='.length);
  const lpRedeem = await lanBob.request('/api/auth/lan-handoff', { ticket: lpTicket });
  assert.equal(lpRedeem.status, 200);
  assert.equal(lpRedeem.body.destination, '/?account=1');
  const bobAccount = (await lanBob.request('/api/account')).body.account;
  assert.ok(bobAccount.identities.some(id => id.provider === 'plex' && id.verified));

  // Public URL OAuth still works normally.
  const pubDirect = browser();
  const pubDiscord = await pubDirect.discord('host');
  assert.equal(pubDiscord.status, 302);
  assert.equal((await pubDirect.request('/api/me')).body.loggedIn, true);
});

test('server.lan_url: auto detects local private IPs and hostname on server.port and enforces local peers', async t => {
  const detected = detectLanOrigins(
    { port: 5756, publicUrl: 'https://watch.example' },
    {
      hostname: 'MediaBox',
      interfaces: {
        eth0: [
          { address: '192.168.1.10', family: 'IPv4', internal: false },
          { address: '203.0.113.5', family: 'IPv4', internal: false },
          { address: 'fd12:3456::1', family: 'IPv6', internal: false },
          { address: 'fe80::1%eth0', family: 'IPv6', internal: false },
        ],
      },
    },
  );
  assert.ok(detected.has('https://192.168.1.10:5756'));
  assert.ok(detected.has('https://mediabox:5756'));
  assert.ok(detected.has('https://mediabox.local:5756'));
  assert.ok(detected.has('https://[fd12:3456::1]:5756'));
  assert.ok(detected.has('https://localhost:5756'));
  assert.equal(detected.has('https://203.0.113.5:5756'), false, 'public IPv4 is not a LAN origin');
  assert.equal(detected.has('https://watch.example'), false, 'public_url is never classified as a LAN origin');

  const autoCfg = {
    publicUrl: 'https://watch.example',
    lanUrl: 'auto',
    listen: 'https',
    lanAutoOrigins: ['https://192.168.1.10:5756', 'https://mediabox:5756'],
  };
  assert.equal(
    isAllowedBrowserOrigin(autoCfg, 'https://mediabox:5756', { socket: { remoteAddress: '192.168.1.42' } }),
    true,
  );
  assert.equal(
    isAllowedBrowserOrigin(autoCfg, 'https://mediabox:5756', { socket: { remoteAddress: '203.0.113.99' } }),
    false,
    'non-local peer cannot use lan_url: auto',
  );
  assert.equal(
    isAllowedBrowserOrigin({ ...autoCfg, listen: 'http-proxy' }, 'https://mediabox:5756', {
      socket: { remoteAddress: '192.168.1.42' },
    }),
    false,
    'http-proxy mode disables lan_url: auto',
  );

  // End-to-end: both IP and hostname origins work under lan_url: 'auto'.
  const { app, config, provider, browser } = await fixture(t, undefined, {
    lanUrl: 'auto',
    lanAutoOrigins: ['https://192.168.1.10:5756', 'https://mediabox:5756'],
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  config.serverOperator = { identities: [{ provider: 'discord', subject: provider.subjects.host }] };
  const port = app.server.address().port;
  const operator = browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  const created = (await operator.post('/api/operator/accounts', { username: 'carol' })).body;

  const byHost = makeClient(port, 'https://mediabox:5756', 'mediabox:5756');
  assert.equal(
    (
      await byHost.request('/api/uburoom-accounts/password', {
        token: tokenOf(created.link.url),
        password: 'carol auto password',
      })
    ).status,
    200,
  );
  const byIp = makeClient(port, 'https://192.168.1.10:5756', '192.168.1.10:5756');
  assert.equal(
    (await byIp.request('/api/uburoom-accounts/sign-in', { username: 'carol', password: 'carol auto password' }))
      .status,
    200,
  );
  assert.equal((await byIp.request('/api/me')).body.loggedIn, true);
});

test('unconfigured LAN sign-in gives an actionable error and new-dev-cert --lan includes LAN SANs', async t => {
  const { app, config } = await fixture(t, undefined, {
    accessPolicy: accessPolicy({ discordServer: true, accounts: true }),
  });
  const port = app.server.address().port;
  const lan = makeClient(port, LAN_ORIGIN, LAN_HOST);

  const dStart = await lan.request('/auth/discord');
  assert.equal(dStart.status, 302);
  assert.equal(dStart.headers.location, '/auth/error');
  const dErr = await lan.request('/api/account/auth-error');
  assert.match(dErr.body.error, /server\.lan_url/);
  assert.ok(dErr.body.error.includes(config.publicUrl));

  const pStart = await lan.request('/auth/plex');
  assert.equal(pStart.status, 302);
  assert.equal(pStart.headers.location, '/auth/error');
  const pErr = await lan.request('/api/account/auth-error');
  assert.match(pErr.body.error, /server\.lan_url/);

  const nativeSignIn = await lan.request('/api/uburoom-accounts/sign-in', {
    username: 'alice',
    password: 'some password',
  });
  assert.equal(nativeSignIn.status, 403);
  assert.match(nativeSignIn.body.error, /server\.lan_url/);

  const evil = makeClient(port, 'https://evil.example', 'evil.example');
  const evilSignIn = await evil.request('/api/uburoom-accounts/sign-in', {
    username: 'alice',
    password: 'some password',
  });
  assert.equal(evilSignIn.status, 403);
  assert.equal(evilSignIn.body.error, 'Not authorized');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-lan-cert-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const res = generateDevCert({
    directory: dir,
    lan: true,
    lanEnv: {
      hostname: 'MediaBox',
      interfaces: {
        eth0: [{ address: '192.168.1.10', family: 'IPv4', internal: false }],
      },
    },
  });
  const cert = new X509Certificate(fs.readFileSync(res.certFile));
  assert.match(cert.subjectAltName, /DNS:localhost/);
  assert.match(cert.subjectAltName, /DNS:mediabox/);
  assert.match(cert.subjectAltName, /DNS:mediabox\.local/);
  assert.match(cert.subjectAltName, /IP Address:192\.168\.1\.10/);
});
