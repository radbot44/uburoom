'use strict';
// Server settings → Sources over HTTP (phase 6 of docs/media-sources-plan.md): the operator lists,
// edits, adds and removes sources in config.yaml, applied after a restart. Only the operator may, every
// change rechecks the revision, and no answer carries a token, API key or password.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { fixture } = require('./helpers/account-app');
const { loadConfig } = require('../server/config');

const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };
const SECRETS = /fixture-owner|fixture-cabin-token|fixture-user-|jf-admin-token|jf-new-key|jf-password/;

/** plex.tv lists two servers for Alice: Cabin answers on its local address; Away never answers; relays are never tried. */
function plexFetch(input, options, provider, seen) {
  const url = new URL(input),
    token = options?.headers?.['X-Plex-Token'];
  seen.push(url.host + url.pathname);
  if (url.hostname === 'relay.invalid') throw new Error('A relay was tried');
  if (url.hostname === 'clients.plex.tv' && url.pathname === '/api/v2/resources' && token === 'fixture-user-101')
    return Response.json([
      {
        name: 'Cabin',
        clientIdentifier: 'machine-c',
        provides: 'server',
        owned: true,
        accessToken: 'fixture-cabin-token',
        connections: [
          { uri: 'https://relay.invalid:443', local: false, relay: true },
          { uri: 'http://plex-c.invalid:32400', local: true, relay: false },
        ],
      },
      {
        name: 'Away',
        clientIdentifier: 'machine-x',
        provides: 'server',
        accessToken: 'fixture-away-token',
        connections: [{ uri: 'http://away.invalid:32400', local: false, relay: false }],
      },
    ]);
  if (url.hostname === 'away.invalid') throw new Error('unreachable');
  if (url.hostname === 'plex-c.invalid') {
    if (url.pathname === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'machine-c' } });
    if (token !== 'fixture-cabin-token') return new Response('{}', { status: 401 });
    if (url.pathname === '/library/sections')
      return Response.json({
        MediaContainer: {
          Directory: [
            { key: '4', type: 'movie', title: 'Cabin Movies' },
            { key: '5', type: 'show', title: 'Cabin Shows' },
          ],
        },
      });
    if (/^\/library\/sections\/\d+\/all$/.test(url.pathname))
      return Response.json({ MediaContainer: { totalSize: url.pathname.includes('/4/') ? 12 : 3, size: 0 } });
  }
  if (url.pathname === '/identity') return Response.json({ MediaContainer: { machineIdentifier: 'fixture-machine' } });
  return provider.fetch(input, options);
}

/** A Jellyfin server: an administrator signs in once, uburoom makes its API key, and Viewer's libraries are offered. */
const JF_SERVER = '1'.repeat(32),
  JF_ADMIN = '2'.repeat(32),
  JF_VIEWER = '3'.repeat(32),
  JF_FILMS = '4'.repeat(32);
function jellyfinFetch(calls) {
  return async (input, options = {}) => {
    const url = new URL(input),
      auth = new Headers(options.headers).get('authorization') || '';
    calls.push(options.method + ' ' + url.pathname);
    if (url.pathname === '/System/Info/Public')
      return Response.json({ Id: JF_SERVER, ServerName: 'Den Jellyfin', ProductName: 'Jellyfin Server' });
    if (url.pathname === '/QuickConnect/Enabled') return Response.json(false);
    if (url.pathname === '/Users/AuthenticateByName') {
      const sent = JSON.parse(options.body);
      if (sent.Username !== 'admin' || sent.Pw !== 'jf-password') return new Response('', { status: 401 });
      return Response.json({
        User: { Id: JF_ADMIN, Name: 'admin', Policy: { IsAdministrator: true } },
        AccessToken: 'jf-admin-token',
        ServerId: JF_SERVER,
      });
    }
    if (url.pathname === '/Auth/Keys' && /Token="jf-admin-token"/.test(auth))
      return options.method === 'POST'
        ? new Response(null, { status: 204 })
        : Response.json({
            Items: [{ AppName: 'uburoom', AccessToken: 'jf-new-key-1', DateCreated: new Date().toISOString() }],
          });
    if (url.pathname === '/Sessions/Logout') return new Response(null, { status: 204 });
    if (!/Token="jf-new-key-1"/.test(auth)) return new Response('{}', { status: 401 });
    if (url.pathname === '/Users')
      return Response.json([
        { Id: JF_ADMIN, Name: 'admin', Policy: { IsAdministrator: true } },
        { Id: JF_VIEWER, Name: 'Viewer', Policy: {} },
      ]);
    if (url.pathname === '/UserViews')
      return Response.json({ Items: [{ Id: JF_FILMS, Name: 'Den Films', CollectionType: 'movies' }] });
    if (url.pathname === '/Items') return Response.json({ Items: [], TotalRecordCount: 7 });
    return Response.json({ Items: [] });
  };
}

async function sourcesFixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uburoom-sources-http-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'Home Films'));
  const file = path.join(directory, 'config.yaml');
  await fs.promises.writeFile(
    file,
    `secrets:
  server_password: 'fixture-private-password'
access:
  password: true
  source_members: ['plex'] # members of the first Plex
operator:
  identities: ['discord:100000000000000002']
discord:
  client_id: '100000000000000010'
  client_secret: 'fixture-private-client-secret'
  owner_id: '100000000000000001'
  guild_id: '100000000000000020'
# Keep this sources comment
sources:
  - id: 'plex'
    type: 'plex'
    url: 'http://plex-fixture.invalid:32400'
    token: 'fixture-owner'
storage:
  credential_key_file: './original.key'
`,
    { mode: 0o600 },
  );
  const seen = [],
    jellyfinCalls = [];
  const f = await fixture(
    t,
    (input, options, provider) => plexFetch(input, options, provider, seen),
    { ...loadConfig(file), accountFile: undefined, credentialKeyFile: undefined },
    { jellyfinFetch: jellyfinFetch(jellyfinCalls) },
  );
  const operator = f.browser();
  await operator.discord('guest');
  const call = async (route, data) => {
    const response = await operator.post(route, data);
    assert.doesNotMatch(JSON.stringify(response.body), SECRETS, route + ' answered a secret');
    return response;
  };
  const step = async (flow, name, data = {}) => call('/api/operator/sources/setup/step', { flow, step: name, ...data });
  const read = () => YAML.parse(fs.readFileSync(file, 'utf8'));
  return { ...f, file, directory, operator, call, step, read, seen, jellyfinCalls };
}

test('only the operator reads or changes sources, and every answer leaves secrets out', tls, async t => {
  const f = await sourcesFixture(t);
  const other = f.browser();
  await other.discord('host');
  assert.equal((await other.request('/api/operator/sources')).status, 403);
  assert.equal((await other.post('/api/operator/sources/setup', { type: 'plex' })).status, 403);
  assert.equal((await f.browser().request('/api/operator/sources')).status, 401);
  // A POST without the CSRF proof is refused even for the operator.
  assert.equal((await f.operator.request('/api/operator/sources', { action: 'remove', id: 'plex' })).status, 403);

  const listed = await f.operator.request('/api/operator/sources');
  assert.equal(listed.status, 200);
  assert.doesNotMatch(JSON.stringify(listed.body), SECRETS);
  assert.deepEqual(
    listed.body.sources.map(source => [source.id, source.type, source.offered, source.pending]),
    [['plex', 'plex', null, false]],
  );
  const details = await f.operator.request('/api/operator/sources/details?id=plex');
  assert.equal(details.body.status.status, 'pass');
  assert.deepEqual(details.body.libraries, [
    { id: '1', name: 'Fixture Movies', type: 'movies', count: 0, offered: true },
  ]);
});

test('editing renames a source and saves the libraries it offers, waiting for a restart', tls, async t => {
  const f = await sourcesFixture(t);
  const { revision } = (await f.operator.request('/api/operator/sources')).body;
  const saved = await f.call('/api/operator/sources', {
    revision,
    action: 'update',
    id: 'plex',
    name: 'Living Room',
    libraries: ['1'],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.restartRequired, true);
  assert.deepEqual(saved.body.sources[0], {
    id: 'plex',
    type: 'plex',
    name: 'Living Room',
    address: 'plex-fixture.invalid:32400',
    offered: ['1'],
    selectLibraries: true,
    pending: true,
  });
  const text = fs.readFileSync(f.file, 'utf8');
  assert.match(text, /# Keep this sources comment/);
  assert.equal(f.read().sources[0].name, 'Living Room');
  assert.deepEqual(f.read().sources[0].libraries, ['1']);
  // The running server is unchanged until a restart.
  assert.equal(f.config.sources[0].libraries, null);
  // A stale revision is refused, and nothing is written.
  const stale = await f.call('/api/operator/sources', { revision, action: 'update', id: 'plex', name: 'Other' });
  assert.equal(stale.status, 409);
  assert.equal(f.read().sources[0].name, 'Living Room');
});

test('adding Plex: PIN sign-in, servers tested from here without relays, then libraries', tls, async t => {
  const f = await sourcesFixture(t);
  const { flow } = (await f.call('/api/operator/sources/setup', { type: 'plex' })).body;
  const started = await f.step(flow, 'start');
  assert.match(started.body.url, /^https:\/\/app\.plex\.tv\/auth#\?/);
  assert.equal((await f.step(flow, 'servers')).body.waiting, true);
  const pin = new URLSearchParams(started.body.url.split('#?')[1]).get('code').replace('fixture-code-', '');
  f.provider.choose(pin, 'alice');
  const servers = await f.step(flow, 'servers');
  assert.equal(servers.status, 200);
  assert.deepEqual(
    servers.body.servers.map(server => [server.id, server.reachable, server.address || server.reason]),
    [
      ['machine-c', true, 'plex-c.invalid:32400'],
      ['machine-x', false, 'uburoom can’t reach this server from this computer'],
    ],
  );
  assert.ok(!f.seen.some(where => where.startsWith('relay.invalid')), 'a relay connection was never tried');
  assert.equal((await f.step(flow, 'choose', { server: 'machine-x' })).status, 400);
  const chosen = await f.step(flow, 'choose', { server: 'machine-c' });
  assert.equal(chosen.body.ready, true);
  assert.deepEqual(chosen.body.libraries, [
    { id: '4', name: 'Cabin Movies', type: 'movies', count: 12 },
    { id: '5', name: 'Cabin Shows', type: 'shows', count: 3 },
  ]);
  const { revision } = (await f.operator.request('/api/operator/sources')).body;
  // Only libraries the server has can be offered.
  assert.equal(
    (await f.call('/api/operator/sources', { revision, action: 'add', flow, libraries: ['9'] })).status,
    400,
  );
  const added = await f.call('/api/operator/sources', {
    revision,
    action: 'add',
    flow,
    name: 'Cabin',
    libraries: ['4'],
  });
  assert.equal(added.status, 200);
  assert.deepEqual(f.read().sources[1], {
    id: 'cabin',
    type: 'plex',
    name: 'Cabin',
    url: 'http://plex-c.invalid:32400',
    token: 'fixture-cabin-token',
    machine_identifier: 'machine-c',
    libraries: ['4'],
  });
  // The flow is used up.
  assert.equal((await f.step(flow, 'choose', { server: 'machine-c' })).status, 410);
});

test('adding Jellyfin: administrator sign-in makes an API key, then a user and its libraries', tls, async t => {
  const f = await sourcesFixture(t);
  const { flow } = (await f.call('/api/operator/sources/setup', { type: 'jellyfin' })).body;
  const server = await f.step(flow, 'server', { url: 'http://jf.invalid:8096' });
  assert.deepEqual(server.body, {
    name: 'Den Jellyfin',
    address: 'http://jf.invalid:8096',
    quickConnect: false,
    ready: false,
  });
  assert.equal((await f.step(flow, 'password', { username: 'admin', password: 'wrong' })).status, 401);
  const signed = await f.step(flow, 'password', { username: 'admin', password: 'jf-password' });
  assert.equal(signed.status, 200);
  assert.deepEqual(
    signed.body.users.map(user => user.name),
    ['admin', 'Viewer'],
  );
  assert.ok(f.jellyfinCalls.includes('POST /Sessions/Logout'), "the administrator's sign-in is ended");
  const user = await f.step(flow, 'user', { user: JF_VIEWER });
  assert.deepEqual(user.body.libraries, [{ id: JF_FILMS, name: 'Den Films', type: 'movies', count: 7 }]);
  const { revision } = (await f.operator.request('/api/operator/sources')).body;
  assert.equal(
    (await f.call('/api/operator/sources', { revision, action: 'add', flow, libraries: [JF_FILMS] })).status,
    200,
  );
  assert.deepEqual(f.read().sources[1], {
    id: 'den-jellyfin',
    type: 'jellyfin',
    name: 'Den Jellyfin',
    url: 'http://jf.invalid:8096',
    api_key: 'jf-new-key-1',
    user: 'Viewer',
    libraries: [JF_FILMS],
  });
  assert.doesNotMatch(fs.readFileSync(f.file, 'utf8'), /jf-password|jf-admin-token/);
});

test('adding a folder browses this machine, and removing a source keeps the rest valid', tls, async t => {
  const f = await sourcesFixture(t);
  const { flow } = (await f.call('/api/operator/sources/setup', { type: 'folders' })).body;
  const listing = await f.step(flow, 'browse', { path: f.directory });
  // The fixture's data folder sits beside it.
  assert.deepEqual(
    listing.body.folders.map(folder => folder.name),
    ['data', 'Home Films'],
  );
  assert.equal(listing.body.path, f.directory);
  assert.equal((await f.step(flow, 'browse', { path: 'relative/path' })).status, 400);
  const films = listing.body.folders.find(folder => folder.name === 'Home Films');
  const chosen = await f.step(flow, 'choose', { path: films.path, type: 'movies' });
  assert.equal(chosen.body.name, 'Home Films');
  let { revision } = (await f.operator.request('/api/operator/sources')).body;
  const added = await f.call('/api/operator/sources', { revision, action: 'add', flow, name: 'Home Films' });
  assert.equal(added.status, 200);
  assert.deepEqual(f.read().sources[1], {
    id: 'home-films',
    type: 'folders',
    name: 'Home Films',
    libraries: [
      { id: 'home-films', name: 'Home Films', paths: [path.join(f.directory, 'Home Films')], type: 'movies' },
    ],
  });
  // A folders source's libraries are its folders, not a list to switch.
  revision = added.body.revision;
  assert.equal(
    (await f.call('/api/operator/sources', { revision, action: 'update', id: 'home-films', libraries: [] })).status,
    400,
  );
  // Removing the Plex source also takes it out of the member rule that named it.
  const removed = await f.call('/api/operator/sources', { revision, action: 'remove', id: 'plex' });
  assert.equal(removed.status, 200);
  assert.deepEqual(
    f.read().sources.map(source => source.id),
    ['home-films'],
  );
  assert.deepEqual(f.read().access.source_members, []);
  assert.deepEqual(
    removed.body.removed.map(source => source.id),
    ['plex'],
  );
});
