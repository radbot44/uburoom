'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { normalizeConfig } = require('../server/config');
const { fixture } = require('./helpers/account-app');

// Saved operator settings over HTTP; split from accounts.test.js so the two run side by side.
const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };

async function savedSettingsFixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uburoom-settings-http-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'selected.yaml'),
    other = path.join(directory, 'other.yaml');
  const source = `# Keep this private fixture comment
secrets:
  entry_password: 'fixture-private-password'
operator:
  discord_id: '100000000000000002'
  plex_id: '101'
discord:
  client_id: '100000000000000010'
  client_secret: 'fixture-private-client-secret'
  owner_id: '100000000000000001'
  guild_id: '100000000000000020'
sources:
  - id: 'plex'
    type: 'plex'
    url: 'http://plex-fixture.invalid:32400'
    token: 'fixture-owner'
storage:
  credential_key_file: './original.key'
rooms:
  max_members: 20 # keep this capacity comment
`;
  await fs.promises.writeFile(file, source, { mode: 0o600 });
  await fs.promises.writeFile(other, source.replace('max_members: 20', 'max_members: 77'), { mode: 0o600 });
  const { loadConfig } = require('../server/config');
  const f = await fixture(t, undefined, { ...loadConfig(file), accountFile: undefined, credentialKeyFile: undefined });
  const save = async (browser, data, extra = {}) =>
    browser.request('/api/operator/settings/saved', data, {
      'X-CSRF-Token': (await browser.request('/api/me')).body.csrf || '',
      ...extra,
    });
  return { ...f, directory, file, other, source, save };
}

test(
  'saved operator settings HTTP uses the startup path, preserves the allowlist, rejects stale/unauthorized saves and audits names only',
  tls,
  async t => {
    const f = await savedSettingsFixture(t),
      endpoint = '/api/operator/settings/saved';
    const browser = f.browser(),
      ordinary = f.browser(),
      admin = f.browser(),
      anonymous = f.browser();
    assert.equal((await anonymous.request(endpoint)).status, 401);
    assert.equal(
      (await f.save(anonymous, { revision: 'a'.repeat(64), changes: { 'rooms.max_members': 12 } })).status,
      401,
    );
    await browser.discord('guest');
    await ordinary.discord('guest2');
    await admin.discord();
    assert.equal((await browser.request('/api/account')).body.serverOperator, true);
    assert.equal((await ordinary.request('/api/account')).body.serverOperator, false);
    assert.equal(
      (await admin.request('/api/account')).body.serverOperator,
      false,
      'room owner authority is not server-operator capability',
    );
    const password = f.config.accessPolicy.password;
    f.config.accessPolicy.password = '';
    assert.equal((await admin.post('/api/watch/admin-mode', { enabled: true })).status, 200);
    f.config.accessPolicy.password = password;
    for (const denied of [ordinary, admin]) {
      assert.equal((await denied.request(endpoint)).status, 403);
      assert.equal(
        (await f.save(denied, { revision: 'a'.repeat(64), changes: { 'rooms.max_members': 12 } })).status,
        403,
      );
    }
    let response = await browser.request(endpoint + '?path=' + encodeURIComponent(f.other));
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const initial = response.body;
    assert.equal(initial.source, 'file');
    assert.match(initial.revision, /^[a-f0-9]{64}$/);
    assert.equal(initial.settings['rooms.max_members'], 20);
    assert.deepEqual(initial.settings['transcoding.formats'], ['av1']);
    for (const key of [
      'access.discord',
      'rooms.single_room',
      'rooms.inactive_days',
      'rooms.min_retained',
      'rooms.max_history',
      'operator.discord_id',
      'plex.token',
      'storage.credential_key_file',
    ])
      assert.equal(Object.hasOwn(initial.settings, key), false);
    const payload = {
      revision: initial.revision,
      changes: { ...initial.settings, 'rooms.max_members': 12, 'transcoding.max_jobs': 2 },
    };
    assert.equal((await browser.request(endpoint, payload)).status, 403, 'save requires CSRF proof');
    assert.equal((await f.save(browser, payload, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal(
      (await f.save(browser, { ...payload, path: f.other })).status,
      400,
      'client-selected paths are rejected',
    );
    // The editor is fixed at app creation, even if this internal property changes.
    f.config.configFile = f.other;
    response = await f.save(browser, payload);
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, restartRequired: true });
    assert.equal(response.headers['cache-control'], 'no-store');
    const saved = await browser.request(endpoint);
    assert.equal(saved.body.settings['rooms.max_members'], 12);
    assert.notEqual(saved.body.revision, initial.revision);
    assert.equal(
      (await browser.request('/api/operator/settings')).body.settings.rooms.limits.maxMembers,
      20,
      'saving does not change running configuration',
    );
    assert.equal(
      (await browser.request('/api/watch/me')).status,
      401,
      'operator writes do not bypass playback admission',
    );
    const contents = await fs.promises.readFile(f.file, 'utf8');
    assert.ok(contents.includes('fixture-private-password'));
    assert.ok(contents.includes('keep this capacity comment'));
    assert.equal(await fs.promises.readFile(f.other, 'utf8'), f.source.replace('max_members: 20', 'max_members: 77'));
    response = await f.save(browser, payload);
    assert.equal(response.status, 409);
    assert.equal(response.body.code, 'CONFIG_CONFLICT');
    assert.equal(
      (await f.save(browser, { revision: saved.body.revision, changes: { 'secrets.entry_password': 'do-not-save' } }))
        .body.code,
      'CONFIG_FORBIDDEN',
    );
    assert.equal(
      (await f.save(browser, { revision: saved.body.revision, changes: { 'rooms.max_open': 100 } })).body.code,
      'CONFIG_INVALID',
    );
    const events = f.app.registry.db
      .prepare("SELECT actor,detail FROM audit WHERE action='operator-settings-save'")
      .all();
    assert.equal(events.length, 1);
    assert.equal(events[0].actor, f.app.registry.identity('discord', f.provider.subjects.guest).userId);
    assert.deepEqual(JSON.parse(events[0].detail), { settings: Object.keys(payload.changes).sort() });
    const exposed = JSON.stringify([initial, saved.body, response.body, events]);
    for (const value of [
      'fixture-private-password',
      'fixture-private-client-secret',
      'fixture-owner',
      f.file,
      f.other,
      f.directory,
      'backupPath',
    ])
      assert.equal(exposed.includes(value), false);
  },
);

test(
  'saved operator settings rechecks authorization after queueing and immediately before replacement',
  { ...tls, timeout: 30000 },
  async t => {
    const f = await savedSettingsFixture(t),
      browser = f.browser(),
      endpoint = '/api/operator/settings/saved';
    await browser.discord('guest');
    const initial = (await browser.request(endpoint)).body;
    const { createConfigEditor } = require('../server/config-editor'),
      blocker = createConfigEditor(f.other),
      revision = (await blocker.read()).revision;
    const rename = fs.promises.rename.bind(fs.promises);
    let entered, release;
    const waiting = new Promise(resolve => (entered = resolve)),
      held = new Promise(resolve => (release = resolve));
    const mock = t.mock.method(fs.promises, 'rename', async (from, to) => {
      if (to === f.other) {
        entered();
        await held;
      }
      return rename(from, to);
    });
    const blocking = blocker.save({ revision, changes: { 'rooms.max_members': 70 } });
    await waiting;
    const csrf = (await browser.request('/api/me')).body.csrf;
    const received = new Promise(resolve => {
      const listener = req => {
        if (req.url !== endpoint || req.method !== 'POST') return;
        f.app.server.removeListener('request', listener);
        req.once('end', () => setImmediate(resolve));
      };
      f.app.server.on('request', listener);
    });
    const pending = browser.request(
      endpoint,
      { revision: initial.revision, changes: { 'rooms.max_members': 12 } },
      { 'X-CSRF-Token': csrf },
    );
    try {
      await received;
      assert.equal((await browser.request('/api/logout', {}, { 'X-CSRF-Token': csrf })).status, 200);
    } finally {
      release();
    }
    await blocking;
    assert.equal((await pending).status, 401);
    mock.mock.restore();
    assert.equal(await fs.promises.readFile(f.file, 'utf8'), f.source, 'logout while queued leaves YAML untouched');
    await browser.discord('guest');
    const readFile = fs.promises.readFile.bind(fs.promises);
    const stage = t.mock.method(fs.promises, 'readFile', async (target, ...args) => {
      const bytes = await readFile(target, ...args);
      if (path.basename(target) === 'replacement.yaml')
        f.app.registry.db
          .prepare('UPDATE identities SET verified=0 WHERE provider=? AND subject=?')
          .run('discord', f.provider.subjects.guest);
      return bytes;
    });
    assert.equal(
      (await f.save(browser, { revision: initial.revision, changes: { 'rooms.max_members': 11 } })).status,
      403,
    );
    stage.mock.restore();
    assert.equal(
      await fs.promises.readFile(f.file, 'utf8'),
      f.source,
      'authority lost during staging prevents replacement',
    );
    assert.equal(
      f.app.registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='operator-settings-save'").get().n,
      0,
    );
  },
);

test(
  'saved operator settings sanitize write failures and report an audit failure after committed YAML honestly',
  tls,
  async t => {
    const f = await savedSettingsFixture(t),
      browser = f.browser(),
      endpoint = '/api/operator/settings/saved';
    await browser.discord('guest');
    const initial = (await browser.request(endpoint)).body,
      payload = { revision: initial.revision, changes: { 'rooms.max_members': 12 } };
    const mock = t.mock.method(fs.promises, 'rename', async () => {
      throw new Error('private-storage-details ' + f.file);
    });
    let response = await f.save(browser, payload);
    assert.equal(response.status, 503);
    mock.mock.restore();
    assert.equal(await fs.promises.readFile(f.file, 'utf8'), f.source);
    const audit = f.app.registry.audit.bind(f.app.registry),
      flush = f.app.registry.flush.bind(f.app.registry);
    let fail = false;
    const auditMock = t.mock.method(f.app.registry, 'audit', (...args) => {
      audit(...args);
      fail = true;
    });
    const flushMock = t.mock.method(f.app.registry, 'flush', async () => {
      if (fail) {
        fail = false;
        throw new Error('private-storage-details ' + f.file);
      }
      return flush();
    });
    response = await f.save(browser, payload);
    assert.equal(response.status, 503);
    auditMock.mock.restore();
    flushMock.mock.restore();
    assert.equal(response.body.saved, true);
    assert.equal(response.body.restartRequired, true);
    assert.match(response.body.error, /audit persistence/);
    assert.equal(JSON.stringify(response.body).includes('private-storage-details'), false);
    assert.equal(JSON.stringify(response.body).includes(f.file), false);
    assert.equal(
      (await browser.request(endpoint)).body.settings['rooms.max_members'],
      12,
      'audit failure does not roll back the already-saved file',
    );
  },
);

test(
  'operator settings HTTP uses verified session identities and exposes only nonprivate running settings',
  tls,
  async t => {
    const settings = normalizeConfig({
      rooms: { max_members: 12 },
      directory: { expose_discord_members: false },
      transcoding: { encoder: 'software', qualities: [[480, 1]] },
    });
    const f = await fixture(t, undefined, {
      accessPolicy: settings.accessPolicy,
      roomLimits: settings.roomLimits,
      roomPermissions: settings.roomPermissions,
      directory: settings.directory,
      transcoding: settings.transcoding,
    });
    f.config.serverOperator = { discordId: f.provider.subjects.guest2, plexId: '101' };
    const endpoint = '/api/operator/settings',
      anonymous = f.browser(),
      ordinary = f.browser(),
      admin = f.browser(),
      operator = f.browser(),
      pending = f.browser();
    let response = await anonymous.request(endpoint + '?userId=101');
    assert.equal(response.status, 401);
    assert.equal(response.headers['cache-control'], 'no-store');
    await ordinary.discord('guest');
    await admin.discord();
    await pending.plex('bob');
    assert.equal((await admin.post('/api/watch/admin-mode', { enabled: true })).status, 200);
    for (const browser of [ordinary, admin, pending]) {
      response = await browser.request(endpoint + '?userId=101', undefined, { 'X-User-Id': '101' });
      assert.equal(response.status, 403);
      assert.equal(response.headers['cache-control'], 'no-store');
    }
    f.app.registry.assign(f.app.registry.preview(f.provider.subjects.guest2, '102'), 'fixture-admin');
    assert.equal((await pending.request(endpoint)).status, 401, 'assignment invalidates the previous session revision');
    await pending.plex('bob');
    assert.equal(
      (await pending.request(endpoint)).status,
      403,
      'a session with an unverified assigned operator identity is denied',
    );
    await operator.plex('alice');
    // Seed private fields at every object depth to catch accidental object spreads.
    const secret = 'settings-private-marker';
    f.config.unlistedPrivateValue = secret;
    f.config.accountFile = secret;
    f.config.credentialKeyFile = secret;
    f.config.tlsCert = secret;
    f.config.tlsKey = secret;
    f.config.ffmpegPath = secret;
    f.config.ffprobePath = secret;
    f.config.sources[0].delivery = { mode: 'proxy', clientUrl: secret, lanClientUrl: secret, token: secret };
    f.config.accessPolicy.password = secret;
    for (const object of [
      f.config.accessPolicy,
      f.config.roomLimits,
      f.config.roomPermissions,
      f.config.roomPermissions.host,
      f.config.roomPermissions.viewer,
      f.config.directory,
      f.config.transcoding,
      f.config.transcoding.qualities[0],
    ])
      object.futurePrivate = secret;
    response = await operator.request(endpoint);
    assert.equal(response.status, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.body.source, 'running');
    assert.deepEqual(response.body.settings.access, {
      discord: true,
      plex: true,
      publicWeb: true,
    });
    assert.equal(response.body.settings.rooms.limits.maxMembers, 12);
    assert.equal(response.body.settings.rooms.hostPermissions.seek, true);
    assert.deepEqual(response.body.settings.directory, { discord: false });
    assert.deepEqual(response.body.settings.transcoding.qualities, [{ height: 480, mbps: 1 }]);
    assert.equal(response.body.settings.transcoding.encoder, 'software');
    const serialized = JSON.stringify(response.body);
    for (const privateValue of [
      secret,
      f.config.sources[0].token,
      f.config.sources[0].url,
      f.config.publicUrl,
      f.config.clientSecret,
      f.config.clientId,
      f.config.ownerId,
      f.config.guildId,
      f.provider.subjects.guest2,
      '101',
      '102',
      'commands',
    ]) {
      assert.equal(serialized.includes(JSON.stringify(privateValue)), false, 'private value excluded: ' + privateValue);
    }
    assert.equal(
      (await operator.request('/api/watch/me')).status,
      401,
      'operator status does not bypass the entry password',
    );
    assert.equal((await operator.request(endpoint, {})).status, 404, 'no settings write operation');
    f.config.accessPolicy.password = '';
    f.config.accessPolicy.discord = false;
    f.config.accessPolicy.plex = false;
    await anonymous.request('/api/watch/entry', {});
    assert.equal((await anonymous.request(endpoint)).status, 403, 'anonymous guest sessions gain no authority');
  },
);

test(
  'operator settings rechecks logout, account validity and operator identity after persistence waits',
  { ...tls, timeout: 15000 },
  async t => {
    const f = await fixture(t, undefined, {
      accessPolicy: {
        discord: true,
        plex: true,
        password: '',
        publicWeb: true,
      },
    });
    f.config.serverOperator = { discordId: f.provider.subjects.guest, plexId: '' };
    const browser = f.browser(),
      endpoint = '/api/operator/settings';
    await browser.discord('guest');
    const account = f.app.registry.identity('discord', f.provider.subjects.guest);
    assert.equal(
      (await browser.request(endpoint)).status,
      200,
      'verified Discord operator is independent of room Admin mode',
    );
    const duringFlush = async change => {
      const flush = f.app.registry.flush.bind(f.app.registry);
      let entered, release;
      const waiting = new Promise(resolve => (entered = resolve)),
        held = new Promise(resolve => (release = resolve));
      f.app.registry.flush = async () => {
        f.app.registry.flush = flush;
        entered();
        await held;
        return flush();
      };
      const request = browser.request(endpoint);
      try {
        await waiting;
        await change();
      } finally {
        release();
        f.app.registry.flush = flush;
      }
      return request;
    };
    const unverified = await duringFlush(async () => {
      f.app.registry.db
        .prepare('UPDATE identities SET verified=0 WHERE provider=? AND subject=?')
        .run('discord', account.subject);
    });
    assert.equal(unverified.status, 403);
    assert.equal(unverified.body.settings, undefined);
    f.app.registry.resolve('discord', account.subject, 'Verified again');
    const loggedOut = await duringFlush(async () => {
      assert.equal((await browser.post('/api/logout', {})).status, 200);
    });
    assert.equal(loggedOut.status, 401);
    assert.equal(loggedOut.body.settings, undefined);
    await browser.discord('guest');
    await browser.plex('bob', true);
    f.provider.revoked.add('102');
    f.app.plexAuth.clear();
    assert.equal((await browser.request(endpoint)).status, 200);
    // A revoked personal Plex sign-in takes no media from someone Discord admits:
    // every library is served with the source's own credential.
    assert.equal((await browser.request('/api/watch/library')).status, 200);
    f.provider.revoked.clear();
    f.app.plexAuth.clear();
    const staleCookie = browser.jar.get('uburoom');
    const removed = await duringFlush(async () => {
      assert.equal((await browser.post('/api/account/discord/remove', { subject: account.subject })).status, 200);
    });
    assert.equal(removed.status, 401);
    assert.equal(removed.body.settings, undefined);
    assert.equal(
      (await browser.request(endpoint)).status,
      403,
      'remaining Plex identity is not the configured operator',
    );
    assert.equal((await browser.request(endpoint, undefined, { Cookie: 'uburoom=' + staleCookie })).status, 401);
  },
);
