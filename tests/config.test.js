'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, spawn } = require('node:child_process');
const { ROOT, configPath, parseConfig, normalizeConfig, loadConfig } = require('../server/config');
const Policy = require('../server/room-policy');

function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('example YAML is usable, private inputs are absent and defaults preserve existing paths/policy', () => {
  const config = normalizeConfig(parseConfig(fs.readFileSync(path.join(ROOT, 'config.example.yaml'), 'utf8')));
  assert.equal(config.port, 5756);
  assert.equal(config.transcoding.maxJobs, 5);
  assert.equal(config.host, '127.0.0.1');
  assert.deepEqual(config.trustedProxies, []);
  assert.equal(config.trustedProxyHeader, 'x-forwarded-for');
  assert.deepEqual(config.sources, [], 'the example configures no source until one is filled in');
  assert.equal(config.botToken, '');
  assert.deepEqual(config.channels, []);
  assert.deepEqual(config.roomPermissions, Policy.policy());
  assert.equal(config.pauseOnBuffering, false);
  assert.deepEqual(config.roomAdministrators, { discord: [], plex: [], discordRoles: [] });
  assert.deepEqual(config.serverOperator, { identities: [] });
  assert.deepEqual(
    [config.accessPolicy.discordServer, config.accessPolicy.sourceMembers, config.accessPolicy.password],
    [true, [], false],
    'Discord server members are let in by default; nothing else is',
  );
  assert.equal(config.accountFile, path.join(ROOT, 'data/accounts.sqlite'));
  const environment = { HOME: path.join(os.tmpdir(), 'old-home') };
  assert.equal(
    normalizeConfig({}, { environment, platform: 'linux' }).credentialKeyFile,
    path.join(environment.HOME, '.local/share/uburoom/credentials.key'),
  );
});

test('room buffering policy defaults to keeping playback moving and accepts a boolean override', () => {
  assert.equal(normalizeConfig({}).pauseOnBuffering, false);
  assert.equal(normalizeConfig({ rooms: { pause_on_buffering: true } }).pauseOnBuffering, true);
  assert.throws(() => normalizeConfig({ rooms: { pause_on_buffering: 'true' } }), /rooms\.pause_on_buffering/);
});

test('custom file, mount paths, native lists and quoted snowflakes survive from a different cwd', t => {
  const dir = temporary(t),
    file = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    file,
    `
sources:
  - id: 'living-room'
    type: 'plex'
    url: 'http://127.0.0.1:32400'
    token: 'token:#with punctuation'
operator:
  identities: ['discord:456789012345678901', 'plex:102', 'uburoom:alice']
discord:
  client_id: '123456789012345678'
  command_channel_ids: ['234567890123456789']
server:
  host: '0.0.0.0'
  port: 7654
  public_url: 'https://watch.example'
  tls_cert: 'tls/cert.pem'
storage:
  data_directory: './persist'
  credential_key_file: './private/original.key'
rooms:
  viewer_permissions: [playPause, seek]
  admin_plex_ids: ['101']
  admin_discord_ids: ['345678901234567890']
`,
  );
  const config = loadConfig(file);
  assert.equal(config.configFile, file);
  assert.equal(config.tlsCert, path.join(dir, 'tls/cert.pem'));
  assert.equal(config.accountFile, path.join(dir, 'persist/accounts.sqlite'));
  assert.equal(config.credentialKeyFile, path.join(dir, 'private/original.key'));
  assert.equal(config.sources[0].token, 'token:#with punctuation');
  assert.deepEqual(config.serverOperator.identities, [
    { provider: 'discord', subject: '456789012345678901' },
    { provider: 'plex', subject: '102' },
    { provider: 'uburoom', subject: 'alice' },
  ]);
  assert.deepEqual(config.channels, ['234567890123456789']);
  assert.deepEqual(config.roomAdministrators.plex, ['101']);
  assert.equal(config.roomPermissions.viewer.seek, true);
  assert.equal(config.roomPermissions.viewer.chooseMedia, false);
  assert.equal(configPath(['--config', file]), file);
  assert.equal(configPath(['--config=' + file]), file);
  assert.equal(configPath([]), path.join(ROOT, 'config.yaml'));
  assert.throws(() => configPath(['--config']), /requires/);
  assert.throws(() => configPath(['--config=a', '--config=b']), /once/);
});

test('direct Plex delivery is per source: a secure origin and a dedicated non-owner token', () => {
  const plex = settings => normalizeConfig({ sources: [{ id: 'p', type: 'plex', ...settings }] }).sources[0];
  const direct = { url: 'http://plex.example', token: 'owner', direct_token: 'dedicated' };
  assert.deepEqual(plex({ ...direct, delivery: 'auto', client_url: 'https://plex.example:32400/' }).delivery, {
    mode: 'auto',
    clientUrl: 'https://plex.example:32400',
    lanClientUrl: '',
    token: 'dedicated',
  });
  assert.deepEqual(
    plex({
      ...direct,
      delivery: 'auto',
      client_url: 'https://plex.example:32400',
      lan_client_url: 'https://plex-lan.example:32400/',
    }).delivery,
    {
      mode: 'auto',
      clientUrl: 'https://plex.example:32400',
      lanClientUrl: 'https://plex-lan.example:32400',
      token: 'dedicated',
    },
  );
  const base = { url: 'http://plex.example', token: 'owner' };
  for (const [settings, message] of [
    [{ ...base, delivery: 'direct' }, /delivery must be proxy or auto/],
    [{ ...direct, delivery: 'auto' }, /client_url/],
    [{ ...base, client_url: 'http://plex.example' }, /HTTPS origin/],
    [{ ...base, client_url: 'https://user:secret@plex.example' }, /HTTPS origin/],
    [{ ...base, client_url: 'https://plex.example/path' }, /HTTPS origin/],
    [
      { ...direct, delivery: 'auto', client_url: 'https://plex.example', lan_client_url: 'http://plex-lan.example' },
      /HTTPS/,
    ],
    // auto needs the dedicated account, never the source's own token, and the token means nothing without auto.
    [{ ...base, delivery: 'auto', client_url: 'https://plex.example' }, /direct_token is required/],
    [{ ...base, direct_token: 'owner', delivery: 'auto', client_url: 'https://plex.example' }, /non-owner/],
    [{ ...direct }, /only with delivery: 'auto'/],
    [{ token: 'owner' }, /url must be/],
    [{ url: 'http://plex.example' }, /token is required/],
    [{ ...base, fallback_token: 'x' }, /unknown Plex setting/],
  ])
    assert.throws(() => plex(settings), message);
  // The old single-source sections and phase 1's removed keys are gone.
  for (const section of [{ plex: { url: 'http://plex.example' } }, { jellyfin: {} }, { local_media: {} }])
    assert.throws(() => normalizeConfig(section), /Unknown|unknown/);
  for (const access of [{ require_plex: true }, { require_plex_in_activity: false }])
    assert.throws(() => normalizeConfig({ access }), /Unknown|unknown/);
  assert.throws(() => normalizeConfig({ directory: { expose_plex_members: true } }), /Unknown|unknown/);
});

test('sources: ids, types and names are checked, and two entries cannot be the same server', () => {
  const plex = (id, extra = {}) => ({ id, type: 'plex', url: 'http://' + id + '.example', token: 't', ...extra });
  const config = normalizeConfig({
    sources: [
      plex('living-room', { name: 'Living Room' }),
      plex('cabin'),
      { id: 'jf', type: 'jellyfin', url: 'http://jf.example/base/', api_key: 'k', user: 'Viewer' },
      { id: 'films', type: 'folders', libraries: [{ id: 'films', name: 'Films', paths: ['films'] }] },
      { id: 'tv', type: 'folders', libraries: [{ id: 'tv', name: 'TV', type: 'shows', paths: ['tv'] }] },
    ],
  });
  assert.deepEqual(
    config.sources.map(source => [source.id, source.type, source.name]),
    [
      ['living-room', 'plex', 'Living Room'],
      ['cabin', 'plex', ''],
      ['jf', 'jellyfin', ''],
      ['films', 'folders', ''],
      ['tv', 'folders', ''],
    ],
  );
  assert.equal(config.sources[2].url, 'http://jf.example/base');
  assert.equal(config.sources[4].libraries[0].type, 'shows');
  for (const [sources, message] of [
    ['plex', /sources must be a list/],
    [[{ type: 'plex' }], /id must be/],
    [[{ id: 'bad id', type: 'plex' }], /id must be/],
    [[{ id: 'x', type: 'emby' }], /type must be one of/],
    [[{ ...plex('x'), name: 7 }], /name must be/],
    [[plex('x'), plex('x', { url: 'http://other.example' })], /must not repeat an id/],
    [[plex('a'), plex('b', { url: 'http://a.example' })], /same url/],
    [[plex('a', { machine_identifier: 'm' }), plex('b', { machine_identifier: 'm' })], /same machine_identifier/],
    [
      [
        { id: 'a', type: 'folders', libraries: [{ id: 'films', name: 'A', paths: ['a'] }] },
        { id: 'b', type: 'folders', libraries: [{ id: 'films', name: 'B', paths: ['b'] }] },
      ],
      /repeat a library id/,
    ],
    [
      [
        { id: 'a', type: 'folders', libraries: [{ id: 'one', name: 'A', paths: ['same'] }] },
        { id: 'b', type: 'folders', libraries: [{ id: 'two', name: 'B', paths: ['same'] }] },
      ],
      /repeat a folder/,
    ],
    [[{ id: 'f', type: 'folders', libraries: [] }], /libraries requires/],
    [[{ id: 'j', type: 'jellyfin', url: 'http://jf.example' }], /api_key is required/],
  ])
    assert.throws(() => normalizeConfig({ sources }), message);
});

test('malformed YAML and unsupported structures never echo secret source text', () => {
  const secret = 'super-private-token';
  for (const source of [
    `plex: {token: '${secret}'\n`,
    `plex:\n  token: '${secret}'\n  token: other`,
    `plex: !unknown '${secret}'`,
    `plex: &anchor {token: '${secret}'}\ndiscord: *anchor`,
    `plex: {}\n---\nplex: {token: '${secret}'}`,
  ]) {
    assert.throws(
      () => parseConfig(source),
      error => !error.message.includes(secret),
    );
  }
  for (const value of [
    null,
    [],
    { server: null },
    { server: [] },
    { server: { prot: 42 } },
    { typo: {} },
    { server: { port: '5756' } },
    { server: { port: 0 } },
    { server: { port: 65536 } },
    { server: { host: '' } },
    { discord: { client_id: 123456789012345678 } },
    { discord: { command_channel_ids: [123456789012345678] } },
    { discord: { share_channel_id: 123456789012345678 } },
    { discord: { share_channel_id: 'not-a-channel' } },
    { discord: { share_channel_id: '123456789012345678' } },
    { operator: { identities: [123456789012345678] } },
    { operator: { identities: ['discord:alice'] } },
    { operator: { identities: ['discord:123'] } },
    { operator: { identities: ['plex:alice@example.invalid'] } },
    { operator: { identities: ['plex: 102'] } },
    { operator: { identities: ['jellyfin:1'] } },
    { operator: { discord_id: '123456789012345678' } },
    { rooms: { viewer_permissions: ['manageHosts'] } },
    { rooms: { admin_plex_ids: ['name'] } },
    { transcoding: { fallback: { enabled: 'true' } } },
    { transcoding: { fallback: { height: 721 } } },
    { transcoding: { fallback: { bitrate: 0 } } },
    { transcoding: { fallback: { unknown: true } } },
    { transcoding: { outputs: ['provider'], fallback: { enabled: true } } },
    { server: { public_url: 'http://localhost' } },
    { server: { public_url: 'https://private:token@example.com' } },
    { server: { public_url: 'https://example.com/path' } },
    { plex: { url: 'file:///secret' } },
    { storage: { credential_key_file: path.join(ROOT, 'key') } },
    { guests: { default_allow: 'false' } },
    {
      access: { discord_server: false, password: true },
      secrets: { server_password: 'x' },
      rooms: { single_room: true },
    },
    { rooms: { single_room_leader_plex_id: 'alice' } },
  ]) {
    assert.throws(() => normalizeConfig(value));
  }
  assert.equal(normalizeConfig({}).guests.defaultAllow, true);
  assert.equal(normalizeConfig({ guests: { default_allow: false } }).guests.defaultAllow, false);
  assert.equal(
    normalizeConfig({ rooms: { single_room: true, single_room_leader_plex_id: '101' } }).singleRoomLeaderPlexId,
    '101',
  );
  assert.equal(
    normalizeConfig({
      access: { discord_server: false, source_members: ['p'] },
      sources: [{ id: 'p', type: 'plex', url: 'http://plex.example', token: 'fixture-token' }],
      rooms: { single_room: true },
    }).singleRoom,
    true,
  );
});

test('access: entry rules are checked, and each sign-in method is offered only for a rule that needs it', () => {
  const plex = { id: 'living-room', type: 'plex', url: 'http://plex.example', token: 't' },
    folders = { id: 'films', type: 'folders', libraries: [{ id: 'films', name: 'Films', paths: ['films'] }] };
  const policy = (access, extra = {}) => normalizeConfig({ sources: [plex, folders], access, ...extra }).accessPolicy;
  assert.deepEqual(policy({ discord_server: true }), {
    discordServer: true,
    sourceMembers: [],
    password: false,
    accounts: false,
    publicWeb: true,
    discord: true,
    plex: false,
  });
  const members = policy({ discord_server: false, source_members: ['living-room'] });
  assert.deepEqual([members.discord, members.plex], [false, true], 'a Plex member rule offers Plex sign-in');
  const password = normalizeConfig({
    access: { discord_server: false, password: true },
    secrets: { server_password: 'swordfish' },
  });
  assert.equal(password.accessPolicy.password, true);
  assert.equal(password.serverPassword, 'swordfish');
  assert.equal(JSON.stringify(password.accessPolicy).includes('swordfish'), false, 'the rule never holds the secret');
  assert.equal(policy({ discord_server: false, accounts: true }).accounts, true);
  for (const [access, message, extra] of [
    [{ discord_server: false }, /at least one entry rule/],
    [{ source_members: ['cabin'] }, /not in sources/],
    [{ source_members: ['films'] }, /folders sources have no members/],
    [{ source_members: ['living-room', 'living-room'] }, /repeat/],
    [{ password: true }, /requires secrets.server_password/],
    [{ discord_server: true }, /used only with access.password/, { secrets: { server_password: 'x' } }],
    [{ discord: true }, /Unknown|unknown/],
    [{ plex: true }, /Unknown|unknown/],
  ])
    assert.throws(() => policy(access, extra), message);
  assert.throws(() => normalizeConfig({ secrets: { entry_password: 'x' } }), /Unknown|unknown/);
});

test('missing YAML fails before TLS or providers and never falls back to .env/environment', t => {
  const dir = temporary(t),
    file = path.join(dir, 'config.yaml');
  fs.writeFileSync(path.join(dir, '.env'), 'PORT=9999');
  const child = spawnSync(process.execPath, [path.join(ROOT, 'server/index.js'), '--config', file], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, PORT: '9999', PLEX_TOKEN: 'inherited-secret' },
  });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /Missing config.yaml/);
  assert.doesNotMatch(child.stderr, /inherited-secret|Missing TLS/);
});

test(
  'real entry point serves health from external YAML with isolated persistent state',
  // A real server start takes about 6 s on Vigrid alone and more beside the rest of the suite; these limits
  // catch a server that never starts, not a slow one.
  { timeout: 60000 },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-start-')),
      file = path.join(dir, 'config.yaml');
    const net = require('node:net'),
      https = require('node:https');
    const probe = net.createServer();
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
    const port = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const YAML = require('yaml');
    fs.writeFileSync(
      file,
      YAML.stringify({
        server: {
          port,
          public_url: `https://localhost:${port}`,
          tls_cert: path.join(ROOT, 'certs/server-cert.pem'),
          tls_key: path.join(ROOT, 'certs/server-key.pem'),
        },
        storage: { data_directory: './state', credential_key_file: './original.key' },
      }),
    );
    const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), '--config', file], {
      cwd: dir,
      windowsHide: true,
      env: {
        ...process.env,
        PORT: '1',
        PLEX_TOKEN: 'ignored-inherited-token',
        DISCORD_BOT_TOKEN: 'ignored-inherited-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await new Promise(resolve => child.once('exit', resolve));
      }
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    let status;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && child.exitCode === null) {
      status = await new Promise(resolve => {
        const request = https.get(
          { hostname: '127.0.0.1', port, path: '/health', rejectUnauthorized: false },
          response => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on('error', () => resolve(undefined));
        request.setTimeout(500, () => request.destroy());
      });
      if (status === 200) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status, 200, output);
    assert.match(
      output,
      /Watch rooms are available in the browser/,
      'startup finishes logging and reaches normal initialization',
    );
    assert.ok(fs.existsSync(path.join(dir, 'state/accounts.sqlite')));
    assert.equal(fs.readFileSync(path.join(dir, 'original.key')).length, 32);
    assert.doesNotMatch(output, /ignored-inherited-token/);
  },
);

test(
  'real entry point cleans up application resources and exits nonzero on listen failure',
  { timeout: 60000 },
  async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-fail-')),
      file = path.join(dir, 'config.yaml');
    const net = require('node:net');
    const blocker = net.createServer();
    await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
    const port = blocker.address().port;
    t.after(async () => {
      await new Promise(resolve => blocker.close(resolve));
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    });
    const YAML = require('yaml');
    fs.writeFileSync(
      file,
      YAML.stringify({
        server: {
          port,
          host: '127.0.0.1',
          public_url: `https://localhost:${port}`,
          tls_cert: path.join(ROOT, 'certs/server-cert.pem'),
          tls_key: path.join(ROOT, 'certs/server-key.pem'),
        },
        storage: { data_directory: './state', credential_key_file: './original.key' },
      }),
    );
    const child = spawn(process.execPath, [path.join(ROOT, 'server/index.js'), '--config', file], {
      cwd: dir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
    });
    child.stderr.on('data', chunk => {
      output += chunk;
    });
    const exitPromise = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    const timer = setTimeout(() => child.kill(), 45000);
    t.after(() => clearTimeout(timer));
    const { code } = await exitPromise;
    clearTimeout(timer);
    assert.equal(code, 1);
    assert.match(output, /EADDRINUSE/);
  },
);

test('credential key defaults follow each OS and honor explicit paths without migration', t => {
  const home = temporary(t),
    local = path.join(home, 'local'),
    xdg = path.join(home, 'xdg');
  const key = (platform, environment) => normalizeConfig({}, { platform, environment }).credentialKeyFile;
  assert.equal(key('win32', { HOME: home, LOCALAPPDATA: local }), path.join(local, 'uburoom/credentials.key'));
  assert.equal(key('win32', { USERPROFILE: home }), path.join(home, 'AppData/Local/uburoom/credentials.key'));
  assert.equal(key('linux', { HOME: home }), path.join(home, '.local/share/uburoom/credentials.key'));
  assert.equal(
    key('linux', { HOME: home, XDG_DATA_HOME: xdg, LOCALAPPDATA: local }),
    path.join(xdg, 'uburoom/credentials.key'),
  );
  assert.equal(
    key('linux', { HOME: home, XDG_DATA_HOME: 'relative' }),
    path.join(home, '.local/share/uburoom/credentials.key'),
  );
  assert.equal(
    key('darwin', { HOME: home, XDG_DATA_HOME: xdg, LOCALAPPDATA: local }),
    path.join(home, 'Library/Application Support/uburoom/credentials.key'),
  );
  const original = path.join(home, 'original.key');
  fs.writeFileSync(original, 'unchanged');
  assert.equal(
    normalizeConfig({ storage: { credential_key_file: original } }, { platform: 'linux' }).credentialKeyFile,
    original,
  );
  assert.equal(fs.readFileSync(original, 'utf8'), 'unchanged');
});

test('installation doctor validates healthy configurations and reports actionable failures', async () => {
  const { runDoctor } = require('../scripts/doctor');
  const valid = await runDoctor({ args: ['--config', path.join(ROOT, 'config.example.yaml'), '--json'], silent: true });
  assert.equal(valid.ok, true);
  assert.ok(valid.passed >= 5);
  assert.equal(valid.failures, 0);

  const missing = await runDoctor({
    args: ['--config', path.join(ROOT, 'missing-config.yaml'), '--json'],
    silent: true,
  });
  assert.equal(missing.ok, false);
  assert.ok(missing.failures >= 1);
  const configFail = missing.checks.find(c => c.name === 'Config file presence');
  assert.equal(configFail.status, 'fail');
  assert.match(configFail.remediation, /config\.example\.yaml/);
});

test('doctor validates database schema, envelope authentication, and cert-key pair match', async t => {
  const { checkStorageAndKey, checkTlsCertificates } = require('../scripts/doctor');
  const dir = temporary(t);
  const dbFile = path.join(dir, 'test.sqlite');
  const keyFile = path.join(dir, 'credentials.key');
  const { DatabaseSync } = require('node:sqlite');
  const crypto = require('node:crypto');

  // 1. Unsupported PRAGMA user_version
  const db1 = new DatabaseSync(dbFile);
  db1.exec('PRAGMA user_version = 99; CREATE TABLE dummy(id TEXT);');
  db1.close();
  const schemaFail = checkStorageAndKey({ accountFile: dbFile, credentialKeyFile: keyFile });
  const schemaCheck = schemaFail.find(c => c.name === 'Database schema compatibility');
  assert.equal(schemaCheck?.status, 'fail');

  // 2. Schema-valid db with mismatched 32-byte key vs matching key
  fs.unlinkSync(dbFile);
  const { initializeSchema } = require('../server/storage');
  const { credentialVault } = require('../server/accounts');
  const originalKey = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, originalKey);
  const vault = credentialVault(keyFile);

  const db2 = new DatabaseSync(dbFile);
  initializeSchema(db2);
  const sealed = vault.seal({ secret: 'supersecret' });
  db2.prepare('INSERT INTO credentials(subject, value) VALUES (?, ?)').run('test-user', JSON.stringify(sealed));
  db2.close();

  // Test matching key
  const matchPass = checkStorageAndKey({ accountFile: dbFile, credentialKeyFile: keyFile });
  const matchCheck = matchPass.find(c => c.name === 'Credential key match');
  assert.equal(matchCheck?.status, 'pass');

  // Test mismatched 32-byte key
  const wrongKeyFile = path.join(dir, 'wrong.key');
  fs.writeFileSync(wrongKeyFile, crypto.randomBytes(32));
  const mismatchFail = checkStorageAndKey({ accountFile: dbFile, credentialKeyFile: wrongKeyFile });
  const mismatchCheck = mismatchFail.find(c => c.name === 'Credential key match');
  assert.equal(mismatchCheck?.status, 'fail');

  // 3. TLS cert-key pair check
  const certFile = path.join(ROOT, 'certs', 'server-cert.pem');
  const validKeyFile = path.join(ROOT, 'certs', 'server-key.pem');
  const certPass = checkTlsCertificates({
    publicUrl: 'https://localhost:5756',
    tlsCert: certFile,
    tlsKey: validKeyFile,
  });
  const certMatchPass = certPass.find(c => c.name === 'Certificate & key match');
  assert.equal(certMatchPass?.status, 'pass');

  // Generate mismatched private key
  const { privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const wrongKeyPath = path.join(dir, 'wrong-server-key.pem');
  fs.writeFileSync(wrongKeyPath, wrongPrivateKey.export({ type: 'pkcs8', format: 'pem' }));
  const certFail = checkTlsCertificates({
    publicUrl: 'https://localhost:5756',
    tlsCert: certFile,
    tlsKey: wrongKeyPath,
  });
  const certMatchFail = certFail.find(c => c.name === 'Certificate & key match');
  assert.equal(certMatchFail?.status, 'fail');
});

test('server.trusted_proxies and server.trusted_proxy_header validate addresses, CIDRs and header choices', () => {
  const valid = normalizeConfig({
    server: {
      trusted_proxies: ['127.0.0.1', '::1', '10.0.0.0/8', '172.16.0.0/12', 'fc00::/7', '::ffff:127.0.0.1'],
      trusted_proxy_header: 'cf-connecting-ip',
    },
  });
  assert.deepEqual(valid.trustedProxies, [
    '127.0.0.1',
    '::1',
    '10.0.0.0/8',
    '172.16.0.0/12',
    'fc00::/7',
    '::ffff:127.0.0.1',
  ]);
  assert.equal(valid.trustedProxyHeader, 'cf-connecting-ip');
  assert.equal(normalizeConfig({ server: { trusted_proxy_header: 'x-real-ip' } }).trustedProxyHeader, 'x-real-ip');
  assert.deepEqual(normalizeConfig({ server: { trusted_proxies: [] } }).trustedProxies, []);
  for (const server of [
    { trusted_proxies: '127.0.0.1' },
    { trusted_proxies: [123] },
    { trusted_proxies: [''] },
    { trusted_proxies: ['not-an-ip'] },
    { trusted_proxies: ['127.0.0.1,10.0.0.1'] },
    { trusted_proxies: [' 127.0.0.1 '] },
    { trusted_proxies: ['10.0.0.0/33'] },
    { trusted_proxies: ['10.0.0.0/-1'] },
    { trusted_proxies: ['10.0.0.0/'] },
    { trusted_proxies: ['10.0.0.0/08'] },
    { trusted_proxies: ['10.0.0.0/8/1'] },
    { trusted_proxies: ['::1/129'] },
    { trusted_proxy_header: 'forwarded' },
    { trusted_proxy_header: 'X-Forwarded-For' },
    { trusted_proxy_header: 123 },
  ]) {
    assert.throws(() => normalizeConfig({ server }));
  }
});

test('discord.rich_presence validates boolean configuration and defaults enabled in bootstrap', () => {
  const { pageBootstrap } = require('../server/http/watch/bootstrap');
  assert.equal(normalizeConfig({}).discordRichPresence, true);
  assert.equal(normalizeConfig({ discord: { rich_presence: false } }).discordRichPresence, false);
  assert.throws(() => normalizeConfig({ discord: { rich_presence: 'yes' } }));

  const boot = config =>
    pageBootstrap({
      config,
      watch: { providers: { summary: () => [] }, demoMedia: false },
      hub: { guestsEnabled: () => false },
    }).publicConfig();
  assert.equal(boot(normalizeConfig({})).discordRichPresence, true);
  assert.equal(boot(normalizeConfig({ discord: { rich_presence: false } })).discordRichPresence, false);
});

test('.dockerignore excludes secrets, keys, databases and config backups while keeping runtime build files', () => {
  const raw = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
  const patterns = raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && !line.startsWith('!'))
    .map(pattern => pattern.replace(/\/+$/, ''));
  const ignored = candidate => {
    const parts = candidate.split('/');
    const prefixes = parts.map((_, index) => parts.slice(0, index + 1).join('/'));
    return patterns.some(pattern => prefixes.some(prefix => path.posix.matchesGlob(prefix, pattern)));
  };
  for (const sensitive of [
    'secrets/credentials.key',
    '.uburoom-config-20261117/original.yaml',
    'root.key',
    'nested/dir/private.key',
    'certs/server-cert.pem',
    'nested/tls/cert.pem',
    'nested/cert.pfx',
    'nested/cert.p12',
    'data/accounts.sqlite',
    'backup/accounts.sqlite-wal',
    'backup/archive.db',
    'config.yaml',
    'config/config.yaml',
    'config/data/accounts.sqlite',
  ]) {
    assert.equal(ignored(sensitive), true, `expected .dockerignore to exclude ${sensitive}`);
  }
  for (const required of [
    'package.json',
    'package-lock.json',
    'server/index.js',
    'shared/engine.mjs',
    'web/index.html',
    'diagnostics/report.js',
    'assets/demo/sync-test.mp4',
    'scripts/doctor.js',
    'config.example.yaml',
    'LICENSE',
  ]) {
    assert.equal(ignored(required), false, `expected .dockerignore to preserve ${required}`);
  }
});

test('Dockerfile supports opt-in GPU_DRIVERS build arg while defaulting to none', () => {
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'Dockerfile'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
  assert.match(dockerfile, /^ARG GPU_DRIVERS=none$/m);
  for (const token of ['none)', 'vulkan)', 'all)', 'mesa-vulkan-drivers', 'mesa-va-drivers', 'intel-media-va-driver']) {
    assert.ok(dockerfile.includes(token), `expected Dockerfile to contain ${token}`);
  }
  assert.ok(compose.includes('GPU_DRIVERS'), 'expected docker-compose.yml to document GPU_DRIVERS');
});
