'use strict';
// Backup & restore regression tests:
// - WAL-safe snapshot fidelity (VACUUM INTO captures uncheckpointed WAL writes + encrypted credentials)
// - Missing/mismatched credentials.key, corrupt SQLite, and hash-tamper rejection
// - Existing config.yaml / credentials.key overwrite refusal
// - Path-traversal, absolute-path, and symlink rejection inside uploaded ZIPs
// - End-to-end operator download (/api/operator/backup) -> first-run setup restore (/setup/api/restore) -> live server handoff
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { createHash, randomBytes } = require('node:crypto');

const { MANIFEST_NAME, createZip, readZip, createBackupArchive, inspectAndRestoreBackup } = require('../server/backup');
const { Accounts, credentialVault } = require('../server/accounts');
const { loadConfig } = require('../server/config');
const { SCHEMA_VERSION } = require('../server/storage');
const { writeCertificate, writePrivateFileSync, ensurePrivateDirectorySync } = require('../server/local-tls');
const { createApp } = require('../server/app');
const { startWithSetup } = require('../server/start');
const { silentLogger } = require('../server/logger');

const sha256 = buf => createHash('sha256').update(buf).digest('hex');

function tempDir(t, prefix = 'uburoom-backup-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function makeConfigYaml({ port, keyFile, mediaDir, operatorIdentity = 'uburoom:op-sub-1' }) {
  const quote = v => `'${String(v).replace(/'/g, "''")}'`;
  return [
    'operator:',
    '  identities:',
    `    - ${quote(operatorIdentity)}`,
    'server:',
    `  host: '127.0.0.1'`,
    `  port: ${port}`,
    `  public_url: ${quote('https://127.0.0.1:' + port)}`,
    `  tls_cert: 'data/certs/server-cert.pem'`,
    `  tls_key: 'data/certs/server-key.pem'`,
    'storage:',
    `  data_directory: 'data'`,
    ...(keyFile ? [`  credential_key_file: ${quote(keyFile)}`] : []),
    'access:',
    '  discord_server: false',
    '  accounts: true',
    '  password: false',
    'sources:',
    '  - type: folders',
    `    id: 'local-movies'`,
    `    name: 'Local Movies'`,
    '    libraries:',
    `      - id: 'movies'`,
    `        name: 'Movies'`,
    `        type: 'movies'`,
    '        paths:',
    `          - ${quote(mediaDir)}`,
    '',
  ].join('\n');
}

/** Creates an installation fixture on disk with active WAL writes, encrypted credentials, and TLS certs. */
function createInstallation(t, { port, includeKeyInConfig = false } = {}) {
  const root = tempDir(t, 'uburoom-src-');
  const installDir = path.join(root, 'install');
  const keyDir = path.join(root, 'key-store');
  const mediaDir = path.join(root, 'media');
  fs.mkdirSync(installDir, { recursive: true });
  fs.mkdirSync(mediaDir, { recursive: true });
  ensurePrivateDirectorySync(keyDir);

  const keyFile = path.join(keyDir, 'credentials.key');
  const configFile = path.join(installDir, 'config.yaml');
  const certsDir = path.join(installDir, 'data', 'certs');
  writeCertificate({ directory: certsDir, dnsNames: ['localhost'], ipAddresses: ['127.0.0.1'] });

  const resolvedPort = port || 5756;
  const yaml = makeConfigYaml({
    port: resolvedPort,
    keyFile: includeKeyInConfig ? keyFile : undefined,
    mediaDir,
  });
  writePrivateFileSync(configFile, yaml);

  const env = { ...process.env, LOCALAPPDATA: keyDir, XDG_DATA_HOME: keyDir };
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_DATA_HOME;
  process.env.LOCALAPPDATA = keyDir;
  process.env.XDG_DATA_HOME = keyDir;
  let config;
  try {
    config = loadConfig(configFile, []);
  } finally {
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
  }

  return { root, installDir, keyDir, mediaDir, configFile, keyFile: config.credentialKeyFile, certsDir, config, env };
}

/** Rebuilds a ZIP archive with updated manifest hashes after mutating entries. */
function repackWithUpdatedManifest(entriesMap, { mutateManifest } = {}) {
  const manifest = JSON.parse(entriesMap.get(MANIFEST_NAME).toString('utf8'));
  const files = {};
  const list = [];
  for (const [name, data] of entriesMap) {
    if (name === MANIFEST_NAME) continue;
    files[name] = sha256(data);
    list.push({ name, data });
  }
  manifest.files = files;
  if (mutateManifest) mutateManifest(manifest);
  return createZip([{ name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2)) }, ...list]);
}

function rawRequest(urlString, { method = 'GET', headers = {}, body, secure } = {}) {
  const url = new URL(urlString);
  const useHttps = secure ?? url.protocol === 'https:';
  return new Promise((resolve, reject) => {
    const req = (useHttps ? https : http).request(
      url,
      { method, headers, rejectUnauthorized: false, agent: false },
      res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          const buffer = Buffer.concat(chunks);
          let json;
          try {
            json = JSON.parse(buffer.toString('utf8'));
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, buffer, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.end(body);
    else req.end();
  });
}

test('WAL-safe snapshot fidelity captures uncheckpointed WAL writes and cleans up temp files', t => {
  const fixture = createInstallation(t);
  const vault = credentialVault(fixture.keyFile);
  const accounts = new Accounts(fixture.config.accountFile, vault);
  let restoredAccounts;
  try {
    // Confirm SQLite is in WAL mode and write data while keeping WAL uncheckpointed.
    assert.equal(accounts.db.prepare('PRAGMA journal_mode').get().journal_mode.toLowerCase(), 'wal');
    const user = accounts.resolve('plex', '424242', 'Alice');
    accounts.credential('plex', '424242', { token: 'super-secret-plex-token-wal-test' });
    accounts.meta('backupTestMarker', 'wal-committed-value');
    assert.ok(fs.existsSync(fixture.config.accountFile + '-wal'), 'WAL file should exist with committed frames');

    const backup = createBackupArchive({ config: fixture.config, db: accounts.db });
    const archiveDir = path.dirname(backup.archivePath);
    const zipBytes = fs.readFileSync(backup.archivePath);

    // Temp snapshot accounts.sqlite should already be deleted; only the archive remains before cleanup.
    assert.deepEqual(fs.readdirSync(archiveDir), [backup.filename]);
    assert.equal(backup.manifest.schemaVersion, SCHEMA_VERSION);
    assert.ok(backup.manifest.files['config.yaml']);
    assert.ok(backup.manifest.files['accounts.sqlite']);
    assert.ok(backup.manifest.files['credentials.key']);
    assert.ok(backup.manifest.files['data/certs/server-cert.pem']);
    assert.ok(backup.manifest.files['data/certs/server-key.pem']);

    backup.cleanup();
    assert.equal(fs.existsSync(archiveDir), false, 'cleanup() must remove temporary backup directory');

    // Restore into a completely fresh target location and verify WAL writes + encrypted credential survived.
    const targetRoot = tempDir(t, 'uburoom-wal-restore-');
    const targetConfigFile = path.join(targetRoot, 'restored', 'config.yaml');
    const targetKeyDir = path.join(targetRoot, 'keys');
    const targetEnv = { ...process.env, LOCALAPPDATA: targetKeyDir, XDG_DATA_HOME: targetKeyDir };

    const restored = inspectAndRestoreBackup({
      zipBuffer: zipBytes,
      configFile: targetConfigFile,
      environment: targetEnv,
    });

    assert.equal(restored.manifest.schemaVersion, SCHEMA_VERSION);
    assert.ok(fs.existsSync(targetConfigFile));
    assert.ok(fs.existsSync(restored.config.credentialKeyFile));
    assert.ok(fs.existsSync(restored.config.accountFile));
    assert.ok(fs.existsSync(path.join(path.dirname(restored.config.accountFile), 'certs', 'server-cert.pem')));

    const restoredVault = credentialVault(restored.config.credentialKeyFile);
    restoredAccounts = new Accounts(restored.config.accountFile, restoredVault);

    assert.equal(restoredAccounts.canonical(user.id)?.name, 'Alice');
    assert.deepEqual(restoredAccounts.credential('plex', '424242'), { token: 'super-secret-plex-token-wal-test' });
    assert.equal(restoredAccounts.meta('backupTestMarker'), 'wal-committed-value');
  } finally {
    restoredAccounts?.close();
    accounts.close();
  }
});

test('missing or mismatched credentials.key, corrupt DB, hash mismatch, and existing targets are rejected without writing', t => {
  const fixture = createInstallation(t);
  const vault = credentialVault(fixture.keyFile);
  const accounts = new Accounts(fixture.config.accountFile, vault);
  accounts.resolve('plex', '1001', 'Bob');
  accounts.credential('plex', '1001', { token: 'bob-secret-token' });

  const backup = createBackupArchive({ config: fixture.config, db: accounts.db });
  const goodZip = fs.readFileSync(backup.archivePath);
  backup.cleanup();
  accounts.close();

  const targetRoot = tempDir(t, 'uburoom-reject-');
  const targetConfigFile = path.join(targetRoot, 'fresh', 'config.yaml');
  const targetKeyDir = path.join(targetRoot, 'keys');
  const targetEnv = { ...process.env, LOCALAPPDATA: targetKeyDir, XDG_DATA_HOME: targetKeyDir };

  const assertNothingWritten = () => {
    assert.equal(fs.existsSync(targetConfigFile), false, 'config.yaml must not be written on failure');
    assert.equal(
      fs.existsSync(path.join(targetRoot, 'fresh', 'data')),
      false,
      'data dir must not be written on failure',
    );
    assert.equal(fs.existsSync(targetKeyDir), false, 'key dir must not be written on failure');
  };

  // 1. Missing credentials.key
  const withoutKey = readZip(goodZip);
  withoutKey.delete('credentials.key');
  const missingKeyZip = repackWithUpdatedManifest(withoutKey);
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: missingKeyZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_KEY_MISMATCH',
  );
  assertNothingWritten();

  // 2. Mismatched 32-byte credentials.key (even with matching manifest hash)
  const wrongKeyEntries = readZip(goodZip);
  wrongKeyEntries.set('credentials.key', randomBytes(32));
  const wrongKeyZip = repackWithUpdatedManifest(wrongKeyEntries);
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: wrongKeyZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_KEY_MISMATCH',
  );
  assertNothingWritten();

  // 3. Corrupt accounts.sqlite (even with updated manifest hash)
  const corruptDbEntries = readZip(goodZip);
  corruptDbEntries.set('accounts.sqlite', Buffer.from('not a sqlite database at all'));
  const corruptDbZip = repackWithUpdatedManifest(corruptDbEntries);
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: corruptDbZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_INVALID_DATABASE',
  );
  assertNothingWritten();

  // 4. Tampered config.yaml without updating manifest hash -> SHA-256 mismatch
  const tamperedEntries = readZip(goodZip);
  tamperedEntries.set(
    'config.yaml',
    Buffer.concat([tamperedEntries.get('config.yaml'), Buffer.from('\n# tampered\n')]),
  );
  const tamperedZip = createZip([...tamperedEntries].map(([name, data]) => ({ name, data })));
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: tamperedZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_HASH_MISMATCH',
  );
  assertNothingWritten();

  // 5. Refuse to overwrite existing config.yaml
  fs.mkdirSync(path.dirname(targetConfigFile), { recursive: true });
  fs.writeFileSync(targetConfigFile, '# existing config\n');
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: goodZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_TARGET_EXISTS',
  );
  assert.equal(fs.readFileSync(targetConfigFile, 'utf8'), '# existing config\n');

  // 6. Refuse to overwrite existing credentials.key even when config.yaml is missing
  fs.rmSync(targetConfigFile);
  const existingKey = path.join(targetKeyDir, 'uburoom', 'credentials.key');
  fs.mkdirSync(path.dirname(existingKey), { recursive: true });
  const sentinelKey = randomBytes(32);
  fs.writeFileSync(existingKey, sentinelKey);
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: goodZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_TARGET_EXISTS',
  );
  assert.deepEqual(fs.readFileSync(existingKey), sentinelKey);
  assert.equal(fs.existsSync(targetConfigFile), false);
});

test('path-traversal, absolute-path, unexpected files, and symlink entries inside ZIPs are rejected', t => {
  const targetRoot = tempDir(t, 'uburoom-traversal-');
  const targetConfigFile = path.join(targetRoot, 'install', 'config.yaml');
  const targetKeyDir = path.join(targetRoot, 'keys');
  const targetEnv = { ...process.env, LOCALAPPDATA: targetKeyDir, XDG_DATA_HOME: targetKeyDir };

  const maliciousNames = [
    '../escaped.txt',
    'data/certs/../../escaped.pem',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'data/certs/nested/evil.pem',
    'data\\certs\\evil.pem',
    'unexpected.txt',
  ];

  for (const evilName of maliciousNames) {
    const zip = createZip([
      {
        name: MANIFEST_NAME,
        data: Buffer.from(JSON.stringify({ version: '0.6.1', schemaVersion: SCHEMA_VERSION, files: {} })),
      },
      { name: evilName, data: Buffer.from('evil') },
    ]);
    assert.throws(
      () => inspectAndRestoreBackup({ zipBuffer: zip, configFile: targetConfigFile, environment: targetEnv }),
      error => error.code === 'BACKUP_UNSAFE_PATH',
      `Should reject unsafe archive entry: ${evilName}`,
    );
  }

  // Symlink entry (Unix external file attributes S_IFLNK = 0o120000 in upper 16 bits)
  const symlinkZip = createZip([{ name: 'config.yaml', data: Buffer.from('/etc/passwd') }]);
  const cdOffset = symlinkZip.readUInt32LE(symlinkZip.length - 6);
  symlinkZip.writeUInt32LE((0o120777 << 16) >>> 0, cdOffset + 38);
  assert.throws(
    () => inspectAndRestoreBackup({ zipBuffer: symlinkZip, configFile: targetConfigFile, environment: targetEnv }),
    error => error.code === 'BACKUP_UNSAFE_PATH',
    'Should reject symbolic link entry inside ZIP',
  );

  assert.equal(fs.existsSync(path.join(targetRoot, 'escaped.txt')), false);
  assert.equal(fs.existsSync(targetConfigFile), false);
});

test('round-trip: operator backup download streams with security headers and restores cleanly via first-run setup handoff', async t => {
  const port = await freePort();
  const fixture = createInstallation(t, { port });
  const tls = {
    cert: fs.readFileSync(fixture.config.tlsCert),
    key: fs.readFileSync(fixture.config.tlsKey),
  };

  const app = createApp(fixture.config, { logger: silentLogger, tls });
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));

  // Populate live server state: operator uburoom account, encrypted Plex credential, and a saved room.
  const opUser = app.registry.resolve('uburoom', 'op-sub-1', 'Operator');
  app.registry.credential('plex', '999001', { token: 'roundtrip-secret-token' });
  app.registry.meta('roundtripMarker', 'preserved-across-restore');

  // Seed an active operator session cookie & CSRF token.
  const sessionToken = randomBytes(32).toString('hex');
  const csrfToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(sessionToken).digest('hex');
  app.registry.db.prepare('INSERT INTO browser_logins(id, record) VALUES (?, ?)').run(
    tokenHash,
    JSON.stringify({
      userId: opUser.id,
      name: opUser.name,
      accountRevision: opUser.revision,
      csrf: csrfToken,
      expires: null,
    }),
  );
  // Also attach to in-memory logins map via /api/operator/settings check: restart app cleanly or seed via loginStore
  // Close & reopen once so loginStore loads the persisted operator session cleanly into memory.
  await app.close();

  const liveApp = createApp(fixture.config, { logger: silentLogger, tls });
  await new Promise(resolve => liveApp.server.listen(port, '127.0.0.1', resolve));
  let liveClosed = false;
  let setup;
  let running;
  const prevLocal = process.env.LOCALAPPDATA;
  const prevXdg = process.env.XDG_DATA_HOME;
  try {
    const baseUrl = `https://127.0.0.1:${port}`;
    const cookieHeader = `__Host-uburoom=${sessionToken}`;

    // Unauthenticated download must be rejected (401).
    const unauth = await rawRequest(baseUrl + '/api/operator/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(unauth.status, 401);

    // Missing CSRF must be rejected (403).
    const noCsrf = await rawRequest(baseUrl + '/api/operator/backup', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: baseUrl, cookie: cookieHeader },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(noCsrf.status, 403);

    // Missing explicit confirmation must be rejected (400).
    const noConfirm = await rawRequest(baseUrl + '/api/operator/backup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ confirm: false }),
    });
    assert.equal(noConfirm.status, 400);

    // Write a fresh uncheckpointed WAL record right before download.
    liveApp.registry.meta('liveWalWrite', 'captured-while-running');

    // Authorized operator backup download.
    const download = await rawRequest(baseUrl + '/api/operator/backup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseUrl,
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(download.status, 200);
    assert.equal(download.headers['cache-control'], 'no-store');
    assert.equal(download.headers['content-type'], 'application/zip');
    assert.match(download.headers['content-disposition'] || '', /^attachment; filename="uburoom-backup-[\d-]+\.zip"$/);
    assert.ok(download.buffer.length > 100);

    // Stop the original server so the restored server can bind the same port cleanly.
    await liveApp.close();
    liveClosed = true;

    // Start first-run setup in a fresh empty directory + fresh key directory.
    const restoreRoot = tempDir(t, 'uburoom-setup-restore-');
    const restoreConfigFile = path.join(restoreRoot, 'server', 'config.yaml');
    const restoreKeyDir = path.join(restoreRoot, 'keys');
    process.env.LOCALAPPDATA = restoreKeyDir;
    process.env.XDG_DATA_HOME = restoreKeyDir;

    const lines = [];
    const captureLogger = {
      ...silentLogger,
      child: tag => (tag === 'Setup' ? { ...silentLogger, info: msg => lines.push(msg) } : silentLogger),
    };

    let started;
    ({ setup, started } = await startWithSetup({
      configFile: restoreConfigFile,
      args: ['--setup-port', String(port)],
      logger: captureLogger,
      signals: false,
      botStarter: async () => undefined,
    }));

    const setupCode = lines
      .slice()
      .reverse()
      .find(line => line.startsWith('Setup code: '))
      ?.slice(12);
    assert.ok(setupCode, 'Setup should announce a setup code');
    const setupBase = `http://127.0.0.1:${port}`;

    // Restore without setup session cookie must fail (401).
    const unauthRestore = await rawRequest(setupBase + '/setup/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', origin: setupBase },
      body: download.buffer,
      secure: false,
    });
    assert.equal(unauthRestore.status, 401);

    // Exchange setup code for session cookie.
    const authRes = await rawRequest(setupBase + '/setup/api/code', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: setupBase },
      body: JSON.stringify({ code: setupCode }),
      secure: false,
    });
    assert.equal(authRes.status, 200);
    const setupCookie = authRes.headers['set-cookie'].map(line => line.split(';')[0]).join('; ');

    // Path-traversal ZIP must be rejected (400) while keeping setup alive.
    const evilZip = createZip([{ name: '../evil.txt', data: Buffer.from('nope') }]);
    const evilRes = await rawRequest(setupBase + '/setup/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', origin: setupBase, cookie: setupCookie },
      body: evilZip,
      secure: false,
    });
    assert.equal(evilRes.status, 400);
    assert.equal(fs.existsSync(restoreConfigFile), false);

    // Upload the valid backup archive and verify handoff to the running server.
    const restoreRes = await rawRequest(setupBase + '/setup/api/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/zip', origin: setupBase, cookie: setupCookie },
      body: download.buffer,
      secure: false,
    });
    assert.equal(restoreRes.status, 200, JSON.stringify(restoreRes.json));
    assert.equal(restoreRes.json.restored, true);
    assert.equal(restoreRes.json.publicUrl, baseUrl);

    running = await started;

    // Confirm restored server is live over HTTPS and preserves UUID, encrypted credentials, and WAL writes.
    const health = await rawRequest(baseUrl + '/health', { secure: true });
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    assert.equal(health.json.setup, undefined);

    assert.equal(running.app.registry.canonical(opUser.id)?.name, 'Operator');
    assert.deepEqual(running.app.registry.credential('plex', '999001'), { token: 'roundtrip-secret-token' });
    assert.equal(running.app.registry.meta('roundtripMarker'), 'preserved-across-restore');
    assert.equal(running.app.registry.meta('liveWalWrite'), 'captured-while-running');
  } finally {
    if (running) await running.stop();
    if (setup) await setup.close().catch(() => {});
    if (!liveClosed) await liveApp.close();
    if (prevLocal === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = prevLocal;
    if (prevXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = prevXdg;
  }
});
