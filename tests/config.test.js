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
  assert.equal(config.plexToken, '');
  assert.deepEqual(config.plexDelivery, { mode: 'proxy', clientUrl: '', lanClientUrl: '', fallback: false });
  assert.equal(config.botToken, '');
  assert.deepEqual(config.channels, []);
  assert.deepEqual(config.roomPermissions, Policy.policy());
  assert.deepEqual(config.roomAdministrators, { discord: [], plex: [], discordRoles: [] });
  assert.deepEqual(config.serverOperator, { discordId: '', plexId: '' });
  assert.equal(config.accountFile, path.join(ROOT, 'data/accounts.sqlite'));
  const environment = { HOME: path.join(os.tmpdir(), 'old-home') };
  assert.equal(
    normalizeConfig({}, { environment, platform: 'linux' }).credentialKeyFile,
    path.join(environment.HOME, '.local/share/uburoom/credentials.key'),
  );
});

test('custom file, mount paths, native lists and quoted snowflakes survive from a different cwd', t => {
  const dir = temporary(t),
    file = path.join(dir, 'config.yaml');
  fs.writeFileSync(
    file,
    `
plex:
  token: 'token:#with punctuation'
operator:
  discord_id: '456789012345678901'
  plex_id: '102'
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
  assert.equal(config.plexToken, 'token:#with punctuation');
  assert.deepEqual(config.serverOperator, { discordId: '456789012345678901', plexId: '102' });
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

test('direct Plex delivery requires an explicit secure origin and cannot inherit owner fallback credentials', () => {
  assert.deepEqual(
    normalizeConfig({ plex: { delivery: 'auto', client_url: 'https://plex.example:32400/' } }).plexDelivery,
    { mode: 'auto', clientUrl: 'https://plex.example:32400', lanClientUrl: '', fallback: false },
  );
  assert.deepEqual(
    normalizeConfig({
      plex: {
        delivery: 'auto',
        client_url: 'https://plex.example:32400',
        lan_client_url: 'https://plex-lan.example:32400/',
      },
    }).plexDelivery,
    {
      mode: 'auto',
      clientUrl: 'https://plex.example:32400',
      lanClientUrl: 'https://plex-lan.example:32400',
      fallback: false,
    },
  );
  for (const plex of [
    { delivery: 'direct' },
    { delivery: 'auto' },
    { client_url: 'http://plex.example' },
    { client_url: 'https://user:secret@plex.example' },
    { client_url: 'https://plex.example/path' },
    { delivery: 'auto', client_url: 'https://plex.example:32400', lan_client_url: 'http://plex-lan.example' },
    { delivery: 'auto', client_url: 'https://plex.example:32400', lan_client_url: 'https://plex-lan.example/path' },
    { direct_fallback_enabled: true },
    { token: 'owner', fallback_token: 'owner', direct_fallback_enabled: true },
    { fallback_token: 'dedicated', fallback_enabled: false, direct_fallback_enabled: true },
  ])
    assert.throws(() => normalizeConfig({ plex }));
  assert.equal(
    normalizeConfig({
      plex: { url: 'http://plex.example', fallback_token: 'dedicated', direct_fallback_enabled: true },
    }).plexDelivery.fallback,
    true,
  );
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
    { operator: { discord_id: 123456789012345678 } },
    { operator: { plex_id: 102 } },
    { operator: { discord_id: 'alice' } },
    { operator: { discord_id: '123' } },
    { operator: { plex_id: 'alice@example.invalid' } },
    { operator: { plex_id: ' 102' } },
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
    { access: { require_plex_in_activity: 'false' } },
    { guests: { default_allow: 'false' } },
    { access: { discord: false }, rooms: { single_room: true } },
    { rooms: { single_room_leader_plex_id: 'alice' } },
  ]) {
    assert.throws(() => normalizeConfig(value));
  }
  assert.equal(normalizeConfig({}).accessPolicy.requirePlexInActivity, true);
  assert.equal(
    normalizeConfig({ access: { require_plex_in_activity: false } }).accessPolicy.requirePlexInActivity,
    false,
  );
  assert.equal(normalizeConfig({}).guests.defaultAllow, true);
  assert.equal(normalizeConfig({ guests: { default_allow: false } }).guests.defaultAllow, false);
  assert.equal(
    normalizeConfig({ rooms: { single_room: true, single_room_leader_plex_id: '101' } }).singleRoomLeaderPlexId,
    '101',
  );
  assert.equal(
    normalizeConfig({ access: { discord: false }, plex: { token: 'fixture-token' }, rooms: { single_room: true } })
      .singleRoom,
    true,
  );
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
      watch: { providers: { has: () => false }, demoMedia: false },
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
