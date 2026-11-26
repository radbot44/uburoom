'use strict';
// First-run setup (docs/first-run-setup.md): setup mode starts only without a config file, every step
// is behind the setup code and session, each step is checked by the server, the first config is
// written once (valid, private, never over an existing file) and the operator arrives in the normal
// app on the same port already signed in. No answer carries a token, key or password.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const YAML = require('yaml');

// Setup's config leaves the credential key at its default place: keep it in a temporary folder.
const KEYS = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-setup-keys-'));
process.env.LOCALAPPDATA = KEYS;
process.env.XDG_DATA_HOME = KEYS;
test.after(() => fs.rmSync(KEYS, { recursive: true, force: true }));

const { startWithSetup } = require('../server/start');
const { needsSetup, allowedHost, setupOptions } = require('../server/setup');
const { createSetupGuard, MAX_WRONG, SESSION_MS } = require('../server/setup/code');
const { probeTailscale, enableTailscaleFunnel } = require('../server/setup/tailscale');
const { createConfigFile } = require('../server/config-editor');
const { loadConfig } = require('../server/config');
const { silentLogger } = require('../server/logger');
const { plexFake, jellyfinFake, discordFake, DISCORD } = require('./helpers/setup-fakes');

const SECRETS =
  /fixture-living-room-token|fixture-plex-account|jf-new-key|jf-admin-token|jf-password|fixture-discord-secret|fixture-discord-bot-token|setup password 1|server pass 1/;

/** A logger that keeps what setup announces (the setup code). */
function capture() {
  const lines = [];
  const child = { ...silentLogger, info: message => lines.push(message) };
  return { lines, logger: { ...silentLogger, child: tag => (tag === 'Setup' ? child : silentLogger) } };
}
const codeOf = lines =>
  [...lines]
    .reverse()
    .find(line => line.startsWith('Setup code: '))
    ?.slice(12);

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Raw requests (any Host, self-signed HTTPS), keeping one cookie jar. */
function client(base, { host, secure = base.startsWith('https:') } = {}) {
  let cookie = '';
  const seen = [];
  async function request(route, data, headers = {}) {
    const url = new URL(route, base);
    const body = data === undefined ? undefined : JSON.stringify(data);
    const answer = await new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(
        url,
        {
          method: data === undefined ? 'GET' : 'POST',
          rejectUnauthorized: false,
          agent: false,
          headers: {
            ...(host ? { host } : {}),
            ...(body ? { 'content-type': 'application/json', origin: url.origin } : {}),
            ...(cookie ? { cookie } : {}),
            ...headers,
          },
        },
        res => {
          let text = '';
          res.setEncoding('utf8');
          res.on('data', chunk => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
        },
      );
      req.on('error', reject);
      req.end(body);
    });
    const set = answer.headers['set-cookie'];
    if (set) cookie = set.map(line => line.split(';')[0]).join('; ');
    seen.push(answer.text);
    let json;
    try {
      json = JSON.parse(answer.text);
    } catch {
      json = undefined;
    }
    return { ...answer, body: json };
  }
  return { request, post: (route, data, headers) => request(route, data, headers), seen, cookie: () => cookie };
}

/** Setup mode on a free port in an empty folder, with fake Plex, Jellyfin and Discord. */
async function setupFixture(t, { host, args = [], youtubeRunner, tailscaleRunner } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-setup-'));
  fs.mkdirSync(path.join(directory, 'Films'));
  const configFile = path.join(directory, 'config', 'config.yaml');
  const { lines, logger } = capture();
  const plex = plexFake(),
    jellyfin = jellyfinFake(),
    discord = discordFake();
  const port = await freePort();
  const { setup, started } = await startWithSetup({
    configFile,
    args: ['--setup-port', String(port), ...(host ? ['--setup-host', host] : []), ...args],
    logger,
    signals: false,
    botStarter: async () => undefined,
    setup: {
      plexFetch: plex.plexFetch,
      jellyfinFetch: jellyfin.jellyfinFetch,
      jellyfinDiscover: jellyfin.jellyfinDiscover,
      discordFetch: discord.discordFetch,
      ...(youtubeRunner ? { youtubeRunner } : {}),
      ...(tailscaleRunner ? { tailscaleRunner } : {}),
    },
    appOptions: {
      plexFetch: plex.plexFetch,
      jellyfinFetch: jellyfin.jellyfinFetch,
      ...(youtubeRunner ? { youtubeRunner } : {}),
    },
  });
  t.after(async () => {
    await setup.close();
    const normal = await Promise.race([started, new Promise(resolve => setTimeout(resolve, 10))]).catch(() => {});
    await normal?.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const base = (host && host !== '127.0.0.1' ? 'https' : 'http') + '://localhost:' + port;
  const browser = client(base);
  return { directory, configFile, lines, port, base, browser, started, plex, discord };
}
async function signIn(f) {
  const answer = await f.browser.post('/setup/api/code', { code: codeOf(f.lines) });
  assert.equal(answer.status, 200);
  return answer;
}
const step = (f, flow, name, data = {}) =>
  f.browser.post('/setup/api/sources/setup/step', { flow, step: name, ...data });

test('setup starts only when the config file is missing', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-setup-start-'));
  try {
    const file = path.join(directory, 'config.yaml');
    assert.equal(needsSetup(file), true);
    // An invalid config is not missing: it fails to load as before, never falling back to setup.
    fs.writeFileSync(file, 'access: [nonsense');
    assert.equal(needsSetup(file), false);
    assert.throws(() => loadConfig(file, []), /Invalid config.yaml/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the setup code: wrong guesses count, the tenth makes a new code, and a session expires', () => {
  const codes = [];
  let now = 1000;
  const guard = createSetupGuard({ announce: code => codes.push(code), now: () => now });
  assert.match(codes[0], /^[A-Z2-7]{4}(-[A-Z2-7]{4}){5}-[A-Z2-7]{2}$/);
  for (let i = 1; i < MAX_WRONG; i++) assert.deepEqual(guard.exchange('WRONG-CODE'), { error: 'wrong' });
  assert.deepEqual(guard.exchange('WRONG-CODE'), { error: 'locked' });
  assert.equal(codes.length, 2);
  assert.deepEqual(guard.exchange(codes[0]), { error: 'wrong' }, 'the old code stops working');
  // Typed in lowercase without dashes still matches.
  const first = guard.exchange(codes[1].toLowerCase().replace(/-/g, ' '));
  assert.ok('session' in first);
  assert.equal(guard.valid(first.session), true);
  const second = guard.exchange(codes[1]);
  assert.equal(guard.valid(first.session), false, 'a new exchange ends the old session');
  now += SESSION_MS;
  assert.equal(guard.valid(second.session), false, 'sessions last 30 minutes');
});

test('setup answers only its own host and origin, and nothing without the session', async t => {
  const f = await setupFixture(t);
  assert.equal((await f.browser.request('/health')).status, 200);
  assert.equal(allowedHost('evil.example:5756'), undefined);
  assert.equal(allowedHost('192.168.1.5:5756'), '192.168.1.5');
  const rebound = client(f.base, { host: 'evil.example:' + f.port });
  assert.equal((await rebound.request('/setup')).status, 421, 'a DNS-rebinding page is refused');
  assert.equal((await f.browser.request('/setup/api/state')).status, 401);
  // A cross-site page can't post the code.
  const foreign = await f.browser.post(
    '/setup/api/code',
    { code: codeOf(f.lines) },
    { origin: 'https://evil.example' },
  );
  assert.equal(foreign.status, 403);
  const wrong = await f.browser.post('/setup/api/code', { code: 'AAAA-BBBB' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.code, 'wrong');
  for (let i = 1; i < MAX_WRONG - 1; i++) await f.browser.post('/setup/api/code', { code: 'AAAA-BBBB' });
  const locked = await f.browser.post('/setup/api/code', { code: 'AAAA-BBBB' });
  assert.equal(locked.status, 429);
  assert.equal(f.lines.filter(line => line.startsWith('Setup code: ')).length, 2, 'a new code is shown');
  assert.match(
    f.lines.find(line => line.startsWith('Open ')),
    /\/setup#code=[A-Z2-7-]+$/,
  );
  const signed = await signIn(f);
  assert.match(signed.headers['set-cookie'][0], /HttpOnly; SameSite=Strict/);
  assert.equal((await f.browser.request('/setup/api/state')).status, 200);
  // With the session, a post from another origin is still refused.
  const crossSite = await f.browser.post('/setup/api/account/clear', {}, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403);
});

test('each step is checked by the server', async t => {
  const f = await setupFixture(t);
  await signIn(f);
  const { post } = f.browser;
  // 2. Your account
  assert.match((await post('/setup/api/account/create', { username: 'alex', password: 'short' })).body.error, /10/);
  assert.equal(
    (await post('/setup/api/account/create', { username: '-bad name-', password: 'setup password 1' })).status,
    400,
  );
  const created = await post('/setup/api/account/create', { username: 'Alex', password: 'setup password 1' });
  assert.deepEqual(created.body.account, { provider: 'uburoom', name: 'alex' });
  // 3. Sources: a folder through the folders module's own steps.
  assert.equal((await post('/setup/api/sources/setup', { type: 'nothing' })).status, 400);
  const { flow } = (await post('/setup/api/sources/setup', { type: 'folders' })).body;
  assert.equal((await step(f, flow, 'nonsense')).status, 400);
  assert.equal(
    (await step(f, flow, 'choose', { path: path.join(f.directory, 'missing'), type: 'movies' })).status,
    404,
  );
  assert.equal((await step(f, flow, 'choose', { path: path.join(f.directory, 'Films'), type: 'movies' })).status, 200);
  const added = await post('/setup/api/sources', { action: 'add', flow, name: 'Films' });
  assert.deepEqual(
    added.body.sources.map(source => [source.id, source.type, source.name]),
    [['films', 'folders', 'Films']],
  );
  assert.equal((await post('/setup/api/sources', { action: 'add', flow })).status, 400, 'a flow adds once');
  // 4. Who can get in
  const access = (await f.browser.request('/setup/api/access')).body;
  assert.deepEqual(access.operator, { accounts: true, sources: [] });
  const rules = { sourceMembers: [], password: null, accounts: true, guests: true, discord: false };
  assert.match(
    (await post('/setup/api/access', { ...rules, accounts: false, password: 'server pass 1' })).body.error,
    /uburoom accounts/,
  );
  assert.match((await post('/setup/api/access', { ...rules, password: 'short' })).body.error, /8 characters/);
  assert.match((await post('/setup/api/access', { ...rules, discord: true })).body.error, /Discord/);
  assert.match((await post('/setup/api/access', { ...rules, sourceMembers: ['films'] })).body.error, /from the list/);
  assert.equal(
    (
      await post('/setup/api/access/discord', {
        clientId: DISCORD.application,
        clientSecret: 'wrong',
        botToken: DISCORD.token,
      })
    ).status,
    400,
  );
  assert.equal(
    (await post('/setup/api/access/discord', { clientId: '1', clientSecret: 'x', botToken: DISCORD.token })).status,
    400,
  );
  const discord = await post('/setup/api/access/discord', {
    clientId: DISCORD.application,
    clientSecret: DISCORD.secret,
    botToken: DISCORD.token,
  });
  assert.equal(discord.status, 200);
  assert.deepEqual(discord.body.discordSetup.servers, [{ id: '100000000000000020', name: 'Movie Night Crew' }]);
  assert.match(discord.body.discordSetup.inviteUrl, /client_id=100000000000000010&scope=bot/);
  assert.equal(
    (await post('/setup/api/access', { ...rules, discord: true, excludedGuildIds: ['forged'] })).status,
    400,
  );
  const exclusions = await post('/setup/api/access', {
    ...rules,
    discord: true,
    excludedGuildIds: ['100000000000000020'],
  });
  assert.deepEqual(exclusions.body.excludedGuildIds, ['100000000000000020']);
  assert.equal((await post('/setup/api/access', { ...rules, discord: true, password: 'server pass 1' })).status, 200);
  // 5. Where people watch
  assert.equal((await post('/setup/api/network', { where: 'computer', port: 70000 })).status, 400);
  assert.equal((await post('/setup/api/network', { where: 'moon', port: 5756 })).status, 400);
  const network = await post('/setup/api/network', { where: 'computer', port: '5757' });
  assert.equal(network.body.computer, 'https://localhost:5757');
  assert.equal((await f.browser.request('/setup/api/access')).body.redirectUrl, 'https://localhost:5757/auth/callback');
  const checks = await post('/setup/api/check', {});
  assert.equal(checks.status, 200);
  assert.equal(checks.body.discordRedirect, 'https://localhost:5757/auth/callback');
  // Nothing written yet, and nothing secret in any answer.
  assert.equal(fs.existsSync(f.configFile), false);
  for (const text of f.browser.seen) assert.doesNotMatch(text, SECRETS);
});

test('finishing writes one valid private config and hands over, signed in, on the same port', async t => {
  const f = await setupFixture(t);
  await signIn(f);
  const { post } = f.browser;
  // 2. Plex sign-in: waiting until plex.tv approves the PIN.
  assert.match((await post('/setup/api/account/plex', {})).body.url, /^https:\/\/app\.plex\.tv\/auth#\?/);
  assert.deepEqual((await post('/setup/api/account/plex', { poll: true })).body, { waiting: true });
  assert.deepEqual((await post('/setup/api/account/plex', { poll: true })).body.account, {
    provider: 'plex',
    name: 'alexwatches',
  });
  // 3. A Plex source through the Plex module's steps, with the step 2 sign-in; relays never tried.
  const { flow } = (await post('/setup/api/sources/setup', { type: 'plex' })).body;
  assert.deepEqual((await step(f, flow, 'start')).body, { signedIn: true, ready: false });
  const servers = (await step(f, flow, 'servers')).body.servers;
  assert.deepEqual(
    servers.map(server => [server.name, server.reachable]),
    [
      ['Living Room', true],
      ['Mom’s server', false],
    ],
  );
  assert.ok(!f.plex.state.seen.some(seen => seen.startsWith('relay.invalid')));
  const chosen = await step(f, flow, 'choose', { server: 'machine-lr' });
  assert.equal(chosen.body.libraries.length, 4);
  const added = await post('/setup/api/sources', { action: 'add', flow, libraries: ['1', '2'] });
  assert.equal(added.body.sources[0].id, 'living-room');
  const renamed = await post('/setup/api/sources', {
    action: 'update',
    id: 'living-room',
    name: 'Den',
    libraries: ['1'],
  });
  assert.deepEqual(renamed.body.sources[0].offered, ['1']);
  // 4. The operator's own way in is their Plex source.
  const access = (await f.browser.request('/setup/api/access')).body;
  assert.deepEqual(access.operator, { accounts: false, sources: ['living-room'] });
  const rules = { sourceMembers: ['living-room'], password: null, accounts: true, guests: true, discord: false };
  assert.match((await post('/setup/api/access', { ...rules, sourceMembers: [] })).body.error, /Plex sources/);
  assert.equal((await post('/setup/api/access', rules)).status, 200);
  // 5. The port setup listens on now: the app takes it over.
  assert.equal((await post('/setup/api/network', { where: 'computer', port: f.port })).status, 200);
  // 6. Check, then finish.
  const checks = (await post('/setup/api/check', {})).body.checks;
  assert.deepEqual(
    checks.map(row => [row.id, row.status]),
    [
      ['port', 'pass'],
      ['sources', 'pass'],
      ['certificate', 'pass'],
      ['storage', 'pass'],
      ['key', 'pass'],
    ],
  );
  const finished = await post('/setup/api/finish', {});
  assert.equal(finished.status, 200, finished.text);
  const { app } = await f.started;
  for (const text of f.browser.seen) assert.doesNotMatch(text, SECRETS);

  // The config: valid as the server loads it, private, and never written again.
  const config = loadConfig(f.configFile, []);
  assert.deepEqual(config.serverOperator.identities, [{ provider: 'plex', subject: '101' }]);
  assert.deepEqual(config.accessPolicy.sourceMembers, ['living-room']);
  assert.equal(config.accessPolicy.discordServer, false);
  assert.equal(config.guests.enabled, true);
  assert.equal(config.port, f.port);
  assert.equal(config.host, '127.0.0.1');
  const raw = YAML.parse(fs.readFileSync(f.configFile, 'utf8'));
  assert.deepEqual(raw.sources[0], {
    id: 'living-room',
    type: 'plex',
    name: 'Den',
    url: 'http://plex-lr.invalid:32400',
    token: 'fixture-living-room-token',
    machine_identifier: 'machine-lr',
    libraries: ['1'],
  });
  assert.match(fs.readFileSync(f.configFile, 'utf8'), /# NEVER SHARE THE SECTION BELOW! #/, 'comments are kept');
  if (process.platform !== 'win32') assert.equal(fs.statSync(f.configFile).mode & 0o077, 0);
  assert.equal(
    fs.readdirSync(path.dirname(f.configFile)).filter(name => name.startsWith('.uburoom-config-')).length,
    0,
  );
  await assert.rejects(createConfigFile(f.configFile, fs.readFileSync(f.configFile)), { code: 'CONFIG_EXISTS' });

  // The normal app answers on the same port; setup's routes are gone.
  const ticket = new URL(finished.body.url).hash.slice('#ticket='.length);
  assert.equal(new URL(finished.body.url).origin, 'https://localhost:' + f.port);
  const browser = client('https://localhost:' + f.port);
  assert.equal((await browser.request('/health')).status, 200);
  assert.notEqual((await browser.post('/setup/api/code', { code: codeOf(f.lines) })).status, 200);
  assert.equal((await browser.request('/setup/api/state')).status, 404);
  // The ticket signs the operator in once, from the app's own origin only.
  assert.equal((await browser.post('/api/setup-handoff', { ticket }, { origin: f.base })).status, 403);
  assert.equal((await browser.post('/api/setup-handoff', { ticket: 'wrong' })).status, 400);
  assert.equal((await browser.post('/api/setup-handoff', { ticket })).status, 200);
  assert.equal((await browser.post('/api/setup-handoff', { ticket })).status, 400, 'the ticket works once');
  const me = (await browser.request('/api/me')).body;
  assert.equal(me.loggedIn, true);
  assert.equal(me.name, 'alexwatches');
  const account = (await browser.request('/api/account')).body;
  assert.equal(account.serverOperator, true);
  // Admitted through the Plex source's members rule, with the Plex sign-in setup stored.
  assert.equal(await app.access.refreshWatch(account.account.id), true);
});

test('a uburoom account is created when the app starts, ticket or not', async t => {
  const f = await setupFixture(t);
  await signIn(f);
  const { post } = f.browser;
  await post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const { flow } = (await post('/setup/api/sources/setup', { type: 'folders' })).body;
  await step(f, flow, 'choose', { path: path.join(f.directory, 'Films'), type: 'movies' });
  await post('/setup/api/sources', { action: 'add', flow });
  await post('/setup/api/access', { sourceMembers: [], password: null, accounts: true, guests: false, discord: false });
  await post('/setup/api/network', { where: 'computer', port: f.port });
  const finished = await post('/setup/api/finish', {});
  assert.equal(finished.status, 200, finished.text);
  const { app } = await f.started;
  const config = loadConfig(f.configFile, []);
  assert.equal(config.serverOperator.identities[0].provider, 'uburoom');
  assert.equal(config.accessPolicy.accounts, true);
  assert.equal(config.guests.enabled, false);
  // Signs in with the password chosen in setup, without using the ticket.
  const browser = client('https://localhost:' + f.port);
  assert.equal(
    (await browser.post('/api/uburoom-accounts/sign-in', { username: 'alex', password: 'setup password 1' })).status,
    200,
  );
  const account = (await browser.request('/api/account')).body;
  assert.equal(account.serverOperator, true);
  assert.equal(app.uburoomAccounts.list()[0].username, 'alex');
});

test('in a container: an empty config folder, HTTPS setup and a server reachable through its published port', async t => {
  const f = await setupFixture(t, { host: '0.0.0.0', args: ['--setup-published'] });
  const forward = net.createServer(socket => {
    const target = net.connect(f.port, '127.0.0.1');
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
    socket.pipe(target).pipe(socket);
  });
  await new Promise(resolve => forward.listen(0, '127.0.0.1', resolve));
  t.after(() => forward.close());
  const publishedPort = forward.address().port;
  const published = `https://127.0.0.1:${publishedPort}`;
  f.browser = client(published);
  assert.equal(fs.existsSync(path.dirname(f.configFile)), false, 'the config folder starts empty (or missing)');
  // The image's health check reaches setup over HTTPS.
  assert.deepEqual((await f.browser.request('/health')).body, { ok: true, service: 'uburoom', setup: true });
  const signed = await signIn(f);
  assert.match(signed.headers['set-cookie'][0], /; Secure/);
  const options = (await f.browser.request('/setup/api/network')).body;
  assert.equal(options.port, f.port);
  assert.equal(options.computer, published);
  assert.equal(options.home, undefined);
  assert.equal((await f.browser.post('/setup/api/network', { where: 'computer', port: publishedPort })).status, 400);
  assert.match((await f.browser.post('/setup/api/network', { where: 'home', port: f.port })).body.error, /LAN address/);
  const lanHost = `192.168.1.8:${publishedPort}`;
  const lan = await f.browser.post(
    '/setup/api/network',
    { where: 'home', port: f.port },
    {
      host: lanHost,
      origin: `https://${lanHost}`,
    },
  );
  assert.equal(lan.body.home, `https://${lanHost}`);
  await f.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const { flow } = (await f.browser.post('/setup/api/sources/setup', { type: 'folders' })).body;
  await step(f, flow, 'choose', { path: path.join(f.directory, 'Films'), type: 'shows' });
  await f.browser.post('/setup/api/sources', { action: 'add', flow });
  await f.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: true,
    discord: false,
  });
  await f.browser.post('/setup/api/network', { where: 'computer', port: f.port });
  const finished = await f.browser.post('/setup/api/finish', {});
  assert.equal(finished.status, 200, finished.text);
  await f.started;
  const config = loadConfig(f.configFile, []);
  // "This computer" in a container still listens on every interface, or the published port can't reach it.
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, f.port);
  assert.equal(config.publicUrl, published);
  assert.equal(new URL(finished.body.url).origin, published);
  assert.ok(fs.existsSync(config.tlsCert) && fs.existsSync(config.tlsKey));
  assert.ok(config.tlsCert.startsWith(path.dirname(f.configFile)));
  const browser = client(published);
  assert.equal((await browser.request('/health')).status, 200);
  const ticket = new URLSearchParams(new URL(finished.body.url).hash.slice(1)).get('ticket');
  assert.equal((await browser.post('/api/setup-handoff', { ticket })).status, 200);
});

test('setup options on the command line', () => {
  assert.deepEqual(setupOptions([]), { host: '127.0.0.1', port: 5756 });
  assert.deepEqual(setupOptions(['--setup-host', '0.0.0.0', '--setup-port=6000']), { host: '0.0.0.0', port: 6000 });
  assert.throws(() => setupOptions(['--setup-host', 'example.com']), /IP address/);
  assert.throws(() => setupOptions(['--setup-host']), /requires a value/);
});

test('setup wizard supports internet remote-access routes and direct HTTPS with lan_url: auto', async t => {
  const f = await setupFixture(t);
  await signIn(f);
  await f.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const { flow } = (await f.browser.post('/setup/api/sources/setup', { type: 'folders' })).body;
  await step(f, flow, 'choose', { path: path.join(f.directory, 'Films'), type: 'movies' });
  await f.browser.post('/setup/api/sources', { action: 'add', flow });
  await f.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: true,
    discord: false,
  });

  // Invalid public URL is rejected.
  assert.equal(
    (
      await f.browser.post('/setup/api/network', {
        where: 'internet',
        port: f.port,
        route: 'cloudflare',
        publicUrl: 'http://watch.example.com',
      })
    ).status,
    400,
  );

  // Cloudflare Tunnel route produces valid http-proxy config and passes checks without a local TLS cert.
  const cf = await f.browser.post('/setup/api/network', {
    where: 'internet',
    port: f.port,
    route: 'cloudflare',
    publicUrl: 'https://watch.example.com',
    trustedProxies: '127.0.0.1, ::1',
  });
  assert.equal(cf.status, 200);
  assert.equal(cf.body.where, 'internet');
  assert.equal(cf.body.route, 'cloudflare');
  const cfCheck = await f.browser.post('/setup/api/check', {});
  assert.equal(cfCheck.status, 200);
  assert.ok(
    cfCheck.body.checks.every(row => row.status === 'pass'),
    JSON.stringify(cfCheck.body.checks),
  );

  // Direct HTTPS route with allowLan writes lan_url: 'auto' and passes checks.
  const direct = await f.browser.post('/setup/api/network', {
    where: 'internet',
    port: f.port,
    route: 'https',
    publicUrl: 'https://watch.example.com',
    allowLan: true,
  });
  assert.equal(direct.status, 200);
  assert.equal(direct.body.allowLan, true);
  const directCheck = await f.browser.post('/setup/api/check', {});
  assert.equal(directCheck.status, 200);
  assert.ok(
    directCheck.body.checks.every(row => row.status === 'pass'),
    JSON.stringify(directCheck.body.checks),
  );
});

test('VD-04: setup Step 3 adds and edits a YouTube source in embed and auto modes and finishes cleanly', async t => {
  const youtubeRunner = async (_bin, args) => {
    if (args.includes('--version')) return { code: 0, stdout: '2026.11.01\n', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const f = await setupFixture(t, { youtubeRunner });
  const stubYtDlp = path.join(f.directory, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  fs.writeFileSync(stubYtDlp, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await signIn(f);
  await f.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });

  // Embed mode without yt-dlp works out of the box
  const { flow } = (await f.browser.post('/setup/api/sources/setup', { type: 'youtube' })).body;
  const probe = await step(f, flow, 'probe', {});
  assert.equal(probe.status, 200);
  const configured = await step(f, flow, 'configure', { delivery: 'embed' });
  assert.equal(configured.status, 200);
  assert.equal(configured.body.delivery, 'embed');
  const added = await f.browser.post('/setup/api/sources', { action: 'add', flow, name: 'YouTube Embed' });
  assert.equal(added.status, 200);
  assert.equal(added.body.sources.length, 1);
  assert.equal(added.body.sources[0].type, 'youtube');
  assert.equal(added.body.sources[0].delivery, 'embed');

  // Update YouTube source to auto mode with stubbed yt-dlp + youtubeRunner
  const updated = await f.browser.post('/setup/api/sources', {
    action: 'update',
    id: added.body.sources[0].id,
    name: 'YouTube Auto',
    settings: { delivery: 'auto', maxCacheGb: 1.375, ytDlp: stubYtDlp },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.sources[0].delivery, 'auto');
  assert.equal(updated.body.sources[0].maxCacheGb, 1.375);

  await f.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: true,
    discord: false,
  });
  await f.browser.post('/setup/api/network', { where: 'computer', port: f.port });
  const finished = await f.browser.post('/setup/api/finish', {});
  assert.equal(finished.status, 200, finished.text);
  await f.started;
  const config = loadConfig(f.configFile, []);
  assert.equal(config.sources[0].type, 'youtube');
  assert.equal(config.sources[0].delivery, 'auto');
  assert.equal(config.sources[0].maxCacheGb, 1.375);
});

test('VD-03 / D4: internet https + allowLan returns localUrl handoff, and http-proxy sets /health CORS while keeping guardProxy strict', async t => {
  // 1. Direct HTTPS + allowLan returns both publicUrl and localUrl, and localUrl redeems the handoff ticket
  const f1 = await setupFixture(t);
  await signIn(f1);
  await f1.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const flow1 = (await f1.browser.post('/setup/api/sources/setup', { type: 'folders' })).body.flow;
  await step(f1, flow1, 'choose', { path: path.join(f1.directory, 'Films'), type: 'movies' });
  await f1.browser.post('/setup/api/sources', { action: 'add', flow: flow1 });
  await f1.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: false,
    discord: false,
  });
  await f1.browser.post('/setup/api/network', {
    where: 'internet',
    port: f1.port,
    route: 'https',
    publicUrl: 'https://watch.example.com',
    allowLan: true,
  });
  const fin1 = await f1.browser.post('/setup/api/finish', {});
  assert.equal(fin1.status, 200, fin1.text);
  assert.equal(new URL(fin1.body.url).origin, 'https://watch.example.com');
  assert.equal(new URL(fin1.body.localUrl).origin, `https://localhost:${f1.port}`);
  await f1.started;
  const localTicket = new URLSearchParams(new URL(fin1.body.localUrl).hash.slice(1)).get('ticket');
  const localClient = client(`https://localhost:${f1.port}`);
  assert.equal((await localClient.post('/api/setup-handoff', { ticket: localTicket })).status, 200);

  // 2. Cloudflare http-proxy mode returns proxy metadata on /setup/api/check and /health permits browser CORS probe
  const f2 = await setupFixture(t);
  await signIn(f2);
  await f2.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const flow2 = (await f2.browser.post('/setup/api/sources/setup', { type: 'folders' })).body.flow;
  await step(f2, flow2, 'choose', { path: path.join(f2.directory, 'Films'), type: 'movies' });
  await f2.browser.post('/setup/api/sources', { action: 'add', flow: flow2 });
  await f2.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: false,
    discord: false,
  });
  await f2.browser.post('/setup/api/network', {
    where: 'internet',
    port: f2.port,
    route: 'cloudflare',
    publicUrl: 'https://watch.example.com',
    trustedProxies: '127.0.0.1, ::1',
  });
  const check2 = await f2.browser.post('/setup/api/check', {});
  assert.equal(check2.status, 200);
  assert.equal(check2.body.httpProxy.port, f2.port);
  assert.equal(check2.body.httpProxy.publicUrl, 'https://watch.example.com');
  const fin2 = await f2.browser.post('/setup/api/finish', {});
  assert.equal(fin2.status, 200, fin2.text);
  assert.equal(fin2.body.listen, 'http-proxy');
  await f2.started;

  // Direct plain HTTP /health works with CORS header, while non-/health without X-Forwarded-Proto: https still gets 421
  const proxyClient = client(`http://127.0.0.1:${f2.port}`, { secure: false });
  const health = await proxyClient.request('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers['access-control-allow-origin'], '*');
  const missingProto = await proxyClient.request('/api/account');
  assert.equal(missingProto.status, 421);
});

test('tailscale probe and funnel helper detect state and degrade gracefully without live tailscale', async () => {
  // Missing tailscale binary (ENOENT)
  assert.deepEqual(
    await probeTailscale({
      runner: async () => ({ code: null, stdout: '', stderr: '', errorCode: 'ENOENT' }),
    }),
    {
      installed: false,
      loggedIn: false,
      dnsName: '',
      funnelEnabled: false,
      funnelActive: false,
      funnelPort: null,
    },
  );

  // Installed but logged out
  assert.deepEqual(
    await probeTailscale({
      runner: async () => ({
        code: 0,
        stdout: JSON.stringify({ BackendState: 'NeedsLogin', Self: { DNSName: 'old.tail1234.ts.net.' } }),
        stderr: '',
      }),
    }),
    {
      installed: true,
      loggedIn: false,
      dnsName: '',
      funnelEnabled: false,
      funnelActive: false,
      funnelPort: null,
    },
  );

  // Timed out daemon degrades cleanly
  assert.deepEqual(
    await probeTailscale({
      runner: async () => ({ code: null, stdout: '', stderr: '', timedOut: true }),
    }),
    {
      installed: true,
      loggedIn: false,
      dnsName: '',
      funnelEnabled: false,
      funnelActive: false,
      funnelPort: null,
    },
  );

  // Logged in with MagicDNS name, Funnel capability, and active Funnel forwarding to 5756
  const calls = [];
  const detected = await probeTailscale({
    runner: async args => {
      calls.push(args);
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: JSON.stringify({
            BackendState: 'Running',
            Self: {
              DNSName: 'MediaBox.tail1234.ts.net.',
              CapMap: { 'https://tailscale.com/cap/funnel': [] },
            },
          }),
          stderr: '',
        };
      }
      if (args[0] === 'funnel' && args[1] === 'status') {
        return {
          code: 0,
          stdout: JSON.stringify({
            AllowFunnel: { 'mediabox.tail1234.ts.net:443': true },
            Web: {
              'mediabox.tail1234.ts.net:443': {
                Handlers: { '/': { Proxy: 'http://127.0.0.1:5756' } },
              },
            },
          }),
          stderr: '',
        };
      }
      return { code: 1, stdout: '', stderr: 'unexpected' };
    },
  });
  assert.deepEqual(calls, [
    ['status', '--json'],
    ['funnel', 'status', '--json'],
  ]);
  assert.deepEqual(detected, {
    installed: true,
    loggedIn: true,
    dnsName: 'https://mediabox.tail1234.ts.net',
    funnelEnabled: true,
    funnelActive: true,
    funnelPort: 5756,
  });

  // enableTailscaleFunnel passes exact argument array (no shell) and handles ACL fallback cleanly
  const blockedArgs = [];
  const blocked = await enableTailscaleFunnel(5756, {
    runner: async args => {
      blockedArgs.push(args);
      return {
        code: 1,
        stdout: '',
        stderr:
          'Funnel is not enabled on your tailnet.\nTo enable, visit: https://login.tailscale.com/f/funnel?node=abc123\n',
      };
    },
  });
  assert.deepEqual(blockedArgs, [['funnel', '--bg', '5756']]);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.command, 'tailscale funnel --bg 5756');
  assert.equal(blocked.enableUrl, 'https://login.tailscale.com/f/funnel?node=abc123');
  assert.match(blocked.error, /not enabled/i);

  // If enable succeeds but follow-up probe reports no active Funnel, do not claim active
  const unverified = await enableTailscaleFunnel(5756, {
    runner: async args => {
      if (args[0] === 'funnel' && args[1] === '--bg')
        return { code: 0, stdout: 'Available on the internet\n', stderr: '' };
      if (args[0] === 'status') {
        return {
          code: 0,
          stdout: JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'box.tail123.ts.net.', CapMap: {} } }),
          stderr: '',
        };
      }
      return { code: 0, stdout: JSON.stringify({}), stderr: '' };
    },
  });
  assert.equal(unverified.ok, true);
  assert.equal(unverified.verified, false);
  assert.equal(unverified.status.funnelActive, false);
  assert.equal(unverified.status.funnelPort, null);

  // Invalid ports are rejected
  await assert.rejects(() => enableTailscaleFunnel(0, { runner: async () => ({ code: 0, stdout: '', stderr: '' }) }), {
    status: 400,
  });
  await assert.rejects(
    () =>
      enableTailscaleFunnel(/** @type {any} */ ('5756 && echo hi'), {
        runner: async () => ({ code: 0, stdout: '', stderr: '' }),
      }),
    { status: 400 },
  );
});

test('setup Step 5 Tailscale probe, Funnel enable fallback/success, and http-proxy finish flow', async t => {
  let allowFunnel = false;
  let activePort = null;
  const seenArgs = [];
  const tailscaleRunner = async args => {
    seenArgs.push(args);
    if (args[0] === 'status') {
      return {
        code: 0,
        stdout: JSON.stringify({
          BackendState: 'Running',
          Self: {
            DNSName: 'livingroom.tail9999.ts.net.',
            Capabilities: allowFunnel ? ['https://tailscale.com/cap/funnel'] : [],
          },
        }),
        stderr: '',
      };
    }
    if (args[0] === 'funnel' && args[1] === 'status') {
      return {
        code: 0,
        stdout: JSON.stringify(
          activePort
            ? {
                AllowFunnel: { 'livingroom.tail9999.ts.net:443': true },
                Web: {
                  'livingroom.tail9999.ts.net:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${activePort}` } } },
                },
              }
            : {},
        ),
        stderr: '',
      };
    }
    if (args[0] === 'funnel' && args[1] === '--bg') {
      if (!allowFunnel) {
        return {
          code: 1,
          stdout: '',
          stderr: 'Access denied: tailscale operator permission required.\n',
        };
      }
      activePort = Number(args[2]);
      return { code: 0, stdout: 'Available on the internet:\nhttps://livingroom.tail9999.ts.net/\n', stderr: '' };
    }
    return { code: 1, stdout: '', stderr: 'unknown command' };
  };

  const f = await setupFixture(t, { tailscaleRunner });
  // Unauthenticated access to Tailscale endpoints is rejected.
  assert.equal((await f.browser.request('/setup/api/network/tailscale')).status, 401);
  await signIn(f);

  // Probe returns detected HTTPS origin before Funnel is active.
  const probed = await f.browser.request('/setup/api/network/tailscale');
  assert.equal(probed.status, 200);
  assert.deepEqual(probed.body, {
    installed: true,
    loggedIn: true,
    dnsName: 'https://livingroom.tail9999.ts.net',
    funnelEnabled: false,
    funnelActive: false,
    funnelPort: null,
  });

  // Invalid port rejected on Funnel endpoint.
  assert.equal((await f.browser.post('/setup/api/network/tailscale/funnel', { port: 70000 })).status, 400);

  // When permissions block Funnel, endpoint returns clean fallback with exact command.
  const denied = await f.browser.post('/setup/api/network/tailscale/funnel', { port: f.port });
  assert.equal(denied.status, 200);
  assert.equal(denied.body.ok, false);
  assert.equal(denied.body.command, `tailscale funnel --bg ${f.port}`);
  assert.match(denied.body.error, /operator permission/i);

  // Once allowed, 1-click enable succeeds and reports active Funnel status.
  allowFunnel = true;
  const enabled = await f.browser.post('/setup/api/network/tailscale/funnel', { port: f.port });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.ok, true);
  assert.equal(enabled.body.command, `tailscale funnel --bg ${f.port}`);
  assert.equal(enabled.body.status.funnelActive, true);
  assert.equal(enabled.body.status.funnelPort, f.port);
  assert.ok(seenArgs.some(args => args.join(' ') === `funnel --bg ${f.port}`));

  // Complete setup using the detected Tailscale HTTPS address.
  await f.browser.post('/setup/api/account/create', { username: 'alex', password: 'setup password 1' });
  const { flow } = (await f.browser.post('/setup/api/sources/setup', { type: 'folders' })).body;
  await step(f, flow, 'choose', { path: path.join(f.directory, 'Films'), type: 'movies' });
  await f.browser.post('/setup/api/sources', { action: 'add', flow });
  await f.browser.post('/setup/api/access', {
    sourceMembers: [],
    password: null,
    accounts: true,
    guests: true,
    discord: false,
  });
  const savedNet = await f.browser.post('/setup/api/network', {
    where: 'internet',
    port: f.port,
    route: 'tailscale',
    publicUrl: probed.body.dnsName,
    trustedProxies: '127.0.0.1, ::1',
  });
  assert.equal(savedNet.status, 200);
  assert.equal(savedNet.body.route, 'tailscale');
  assert.equal(savedNet.body.publicUrl, 'https://livingroom.tail9999.ts.net');

  const check = await f.browser.post('/setup/api/check', {});
  assert.equal(check.status, 200);
  assert.ok(
    check.body.checks.every(row => row.status === 'pass'),
    JSON.stringify(check.body.checks),
  );
  assert.equal(check.body.httpProxy.route, 'tailscale');
  assert.equal(check.body.httpProxy.publicUrl, 'https://livingroom.tail9999.ts.net');

  const fin = await f.browser.post('/setup/api/finish', {});
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.body.listen, 'http-proxy');
  assert.equal(fin.body.route, 'tailscale');
  assert.equal(fin.body.publicUrl, 'https://livingroom.tail9999.ts.net');
  await f.started;

  const config = loadConfig(f.configFile, []);
  assert.equal(config.listen, 'http-proxy');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.publicUrl, 'https://livingroom.tail9999.ts.net');
  assert.deepEqual(config.trustedProxies, ['127.0.0.1', '::1']);
  assert.equal(config.trustedProxyHeader, 'x-forwarded-for');
});
