'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const { spawn, execFileSync } = require('node:child_process');

const {
  validateManifest,
  verifyFileSha256,
  ensureCachedBinary,
  verifyVendorAssets,
} = require('../scripts/package-standalone');
const { createCertificate } = require('../server/local-tls');
const { createApp } = require('../server/app');
const { runningSettings } = require('../server/operator-settings');
const { silentLogger } = require('../server/logger');

const REPO_ROOT = path.resolve(__dirname, '..');

async function freePort() {
  const srv = net.createServer();
  await new Promise(resolve => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise(resolve => srv.close(resolve));
  return port;
}

function client(base) {
  let cookie = '';
  async function request(route, data, headers = {}) {
    const url = new URL(route, base);
    const body = data === undefined ? undefined : JSON.stringify(data);
    const secure = url.protocol === 'https:';
    const answer = await new Promise((resolve, reject) => {
      const req = (secure ? https : http).request(
        url,
        {
          method: data === undefined ? 'GET' : 'POST',
          rejectUnauthorized: false,
          agent: false,
          headers: {
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
    let json;
    try {
      json = JSON.parse(answer.text);
    } catch {
      json = undefined;
    }
    return { ...answer, body: json };
  }
  return { request, post: (route, data, headers) => request(route, data, headers) };
}

async function waitForHealth(base, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const c = client(base);
  while (Date.now() < deadline) {
    try {
      const res = await c.request('/health');
      if (res.status === 200 && res.body?.ok) return res.body;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Timed out waiting for ${base}/health`);
}

function linkSlotApp(slotDir, { marker } = {}) {
  const appDir = path.join(slotDir, 'app');
  fs.mkdirSync(appDir, { recursive: true });
  for (const dir of ['server', 'shared', 'scripts']) {
    fs.cpSync(path.join(REPO_ROOT, dir), path.join(appDir, dir), { recursive: true });
  }
  for (const dir of ['web', 'node_modules']) {
    fs.symlinkSync(path.join(REPO_ROOT, dir), path.join(appDir, dir), 'junction');
  }
  fs.copyFileSync(path.join(REPO_ROOT, 'config.example.yaml'), path.join(appDir, 'config.example.yaml'));
  fs.copyFileSync(path.join(REPO_ROOT, 'package.json'), path.join(appDir, 'package.json'));
  if (marker) {
    fs.writeFileSync(
      path.join(slotDir, 'BUILD_INFO.json'),
      JSON.stringify({ uburoom: { version: '0.5.3', shortCommit: marker, dirty: false, slot: marker } }),
    );
  }
  return appDir;
}

test('D2: manifest rejects floating latest URLs and malformed digests, and verifyFileSha256 deletes 1-bit mismatches', async t => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scripts', 'standalone-dependencies.json'), 'utf8'));
  const valid = validateManifest(manifest);
  assert.equal(valid.node.version, 'v22.23.5');
  assert.equal(valid.ffmpeg.version, 'n8.1.3-41-ga8029b6528');

  const floating = structuredClone(manifest);
  floating['win32-x64'].ffmpeg.url =
    'https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/latest/ffmpeg-latest.zip';
  assert.throws(() => validateManifest(floating), /latest/);

  const badDigest = structuredClone(manifest);
  badDigest['win32-x64'].node.sha256 = 'not-a-sha256';
  assert.throws(() => validateManifest(badDigest), /sha256/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-sha-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const corrupt = path.join(dir, 'sample.zip');
  fs.writeFileSync(corrupt, Buffer.from('exact-payload-for-hash'));
  assert.throws(() => verifyFileSha256(corrupt, '0'.repeat(64), { deleteOnMismatch: true }), /SHA-256 mismatch/);
  assert.equal(fs.existsSync(corrupt), false, 'corrupt archive must be deleted on mismatch');

  const cacheDir = path.join(dir, 'binaries');
  await assert.rejects(
    ensureCachedBinary(
      {
        archiveFile: 'bad.zip',
        url: 'https://example.invalid/bad.zip',
        sha256: 'a'.repeat(64),
      },
      cacheDir,
      {
        fetchImpl: async () => new Response(Buffer.from('corrupt-bytes'), { status: 200 }),
      },
    ),
    /SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(cacheDir, 'bad.zip')), false);
});

test('D2: verifyVendorAssets confirms UbuPlayer libav SHA-256 digests, subtitles WASM, Discord SDK, and hls.js', () => {
  verifyVendorAssets(REPO_ROOT);
});

test('createApp() unsupervised hides Restart now (canRestart === false) and guards /api/operator/restart', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-unsupervised-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const port = await freePort();
  const { certPem, keyPem } = createCertificate();
  const config = {
    host: '127.0.0.1',
    port,
    publicUrl: `https://localhost:${port}`,
    accountFile: path.join(dir, 'data', 'accounts.sqlite'),
    credentialKeyFile: path.join(dir, 'keys', 'credentials.key'),
    serverOperator: { identities: [{ provider: 'uburoom', subject: 'op-1' }] },
    accessPolicy: { discordServer: false, sourceMembers: [], password: false, accounts: true, publicWeb: true },
    guests: { enabled: false },
    sources: [],
    logging: { level: 'error', requests: false, file: '' },
  };
  let restartCalls = 0;
  const app = createApp(config, {
    logger: silentLogger,
    tls: { cert: certPem, key: keyPem },
    onRestart: () => {
      restartCalls++;
    },
  });
  await app.completeSetup();
  await new Promise(resolve => app.server.listen(port, '127.0.0.1', resolve));

  try {
    assert.equal(runningSettings(config, { canRestart: false }).canRestart, false);

    const op = await app.uburoomAccounts.createFirst({
      username: 'operator',
      name: 'Operator',
      password: 'operator password 1',
      subject: 'op-1',
    });
    await app.registry.flush();

    const anon = client(config.publicUrl);
    assert.equal((await anon.post('/api/operator/restart', {})).status, 401);

    const browser = client(config.publicUrl);
    assert.equal(
      (await browser.post('/api/uburoom-accounts/sign-in', { username: 'operator', password: 'operator password 1' }))
        .status,
      200,
    );
    const csrf = (await browser.request('/api/me')).body.csrf;
    assert.ok(csrf);

    // Missing CSRF / bad Origin rejected
    assert.equal((await browser.post('/api/operator/restart', {})).status, 403);
    assert.equal(
      (await browser.post('/api/operator/restart', {}, { 'x-csrf-token': csrf, origin: 'https://evil.invalid' }))
        .status,
      403,
    );

    // Unsupervised createApp() keeps canRestart false
    const running = (await browser.request('/api/operator/settings')).body;
    assert.equal(running.canRestart, false);

    // Non-operator returns 403
    const createdViewer = app.uburoomAccounts.create({
      username: 'viewer',
      name: 'Viewer',
      actor: op.userId,
    });
    await app.uburoomAccounts.setPassword(createdViewer.link.token, 'viewer password 1');
    const guestUser = createdViewer.account;
    await app.registry.flush();
    const viewerBrowser = client(config.publicUrl);
    assert.equal(
      (
        await viewerBrowser.post('/api/uburoom-accounts/sign-in', {
          username: 'viewer',
          password: 'viewer password 1',
        })
      ).status,
      200,
    );
    const viewerCsrf = (await viewerBrowser.request('/api/me')).body.csrf;
    assert.equal((await viewerBrowser.post('/api/operator/restart', {}, { 'x-csrf-token': viewerCsrf })).status, 403);

    // Active viewer in room requires confirmActive: true
    const roomId = await app.watch.roomState.create(
      { userId: op.userId, name: 'Operator' },
      { name: 'Movie Night', visibility: 'public' },
    );
    const room = app.watch.rooms.get(roomId);
    room.viewers.set('v-1', { userId: guestUser.userId, actor: { userId: guestUser.userId, name: 'Viewer' } });

    const conflict = await browser.post('/api/operator/restart', {}, { 'x-csrf-token': csrf });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'ACTIVE_ROOMS');
    assert.equal(conflict.body.openRooms, 1);
    assert.equal(conflict.body.activeViewers, 1);
    assert.equal(restartCalls, 0);

    // Unpaused room with active media (even at 0 connected sockets during reconnect grace) still requires confirmActive
    room.viewers.clear();
    room.media = {
      roomServerId: 'test-src',
      id: 'm-1',
      type: 'movie',
      title: 'Test Movie',
      duration: 120000,
    };
    room.state = { ...(room.state || {}), paused: false };
    const playingConflict = await browser.post('/api/operator/restart', {}, { 'x-csrf-token': csrf });
    assert.equal(playingConflict.status, 409);
    assert.equal(playingConflict.body.code, 'ACTIVE_ROOMS');
    assert.equal(playingConflict.body.openRooms, 1);
    assert.equal(playingConflict.body.activeViewers, 0);
    assert.equal(restartCalls, 0);

    const confirmed = await browser.post('/api/operator/restart', { confirmActive: true }, { 'x-csrf-token': csrf });
    assert.equal(confirmed.status, 202);
    assert.equal(confirmed.body.restarting, true);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(restartCalls, 1);
  } finally {
    await app.close();
  }
});

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    } catch {}
  } else {
    try {
      child.kill('SIGTERM');
    } catch {}
  }
}

test('launcher.js supervises setup IPC, exit 75 slot-switching restart, and non-looping error exit', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keysDir = path.join(root, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const credKeyFile = path.join(keysDir, 'credentials.key');

  const slot1 = '0.5.3-g1111111';
  const slot2 = '0.5.3-g2222222';
  const app1 = linkSlotApp(path.join(root, 'versions', slot1), { marker: '1111111' });
  linkSlotApp(path.join(root, 'versions', slot2), { marker: '2222222' });
  fs.writeFileSync(path.join(root, 'current.txt'), `${slot1}\n`);

  // 1. Direct IPC check: server/index.js in loopback setup mode emits uburoom:setup-ready with #code=...
  const ipcPort = await freePort();
  const ipcConfig = path.join(root, 'ipc-missing.yaml');
  const ipcProc = spawn(
    process.execPath,
    [path.join(app1, 'server', 'index.js'), '--config', ipcConfig, '--setup-port', String(ipcPort)],
    { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  try {
    const msg = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for uburoom:setup-ready IPC')), 10000);
      ipcProc.on('message', payload => {
        if (payload?.type === 'uburoom:setup-ready') {
          clearTimeout(timer);
          resolve(payload);
        }
      });
      ipcProc.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`Setup exited prematurely with ${code}`));
      });
    });
    assert.match(msg.url, new RegExp(`^http://localhost:${ipcPort}/setup#code=`));
  } finally {
    killTree(ipcProc);
    await new Promise(resolve => ipcProc.once('exit', resolve));
  }

  const launcherPath = path.join(app1, 'scripts', 'launcher.js');
  const setupPort = await freePort();

  // 2. Launcher in setup mode boots /health cleanly
  const setupProc = spawn(process.execPath, [launcherPath, '--no-browser', '--setup-port', String(setupPort)], {
    env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const setupBase = `http://localhost:${setupPort}`;
    const health = await waitForHealth(setupBase);
    assert.equal(health.setup, true);
  } finally {
    killTree(setupProc);
    await new Promise(resolve => setupProc.once('exit', resolve));
  }

  // 3. Write valid config and verify launcher + exit 75 respawn + slot switch to slot2
  const port = await freePort();
  const certDir = path.join(root, 'config', 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const { certPem, keyPem } = createCertificate();
  fs.writeFileSync(path.join(certDir, 'server-cert.pem'), certPem);
  fs.writeFileSync(path.join(certDir, 'server-key.pem'), keyPem);

  const configFile = path.join(root, 'config', 'config.yaml');
  const logFile = path.join(root, 'config', 'data', 'server.log');
  fs.writeFileSync(
    configFile,
    [
      'server:',
      "  host: '127.0.0.1'",
      `  port: ${port}`,
      `  public_url: 'https://localhost:${port}'`,
      "  tls_cert: 'certs/server-cert.pem'",
      "  tls_key: 'certs/server-key.pem'",
      'storage:',
      `  credential_key_file: '${credKeyFile.replace(/\\/g, '/')}'`,
      'access:',
      '  discord_server: false',
      '  accounts: true',
      'operator:',
      "  identities: ['uburoom:op-launch']",
      'logging:',
      "  level: 'info'",
      '  requests: false',
      `  file: '${logFile.replace(/\\/g, '/')}'`,
      '',
    ].join('\n'),
  );

  // Seed operator uburoom account via temporary createApp before launching supervisor
  const { loadConfig } = require('../server/config');
  const seededConfig = loadConfig(configFile, []);
  const seedApp = createApp(seededConfig, { logger: silentLogger, tls: { cert: certPem, key: keyPem } });
  await seedApp.uburoomAccounts.createFirst({
    username: 'alex',
    name: 'Alex',
    password: 'launch password 1',
    subject: 'op-launch',
  });
  await seedApp.close();

  const supervisor = spawn(process.execPath, [launcherPath, '--no-browser'], {
    env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let supOut = '';
  supervisor.stdout.on('data', chunk => (supOut += chunk.toString()));
  supervisor.stderr.on('data', chunk => (supOut += chunk.toString()));
  try {
    const appBase = `https://localhost:${port}`;
    await waitForHealth(appBase).catch(err => {
      throw new Error(`${err.message}\nsupervisor output:\n${supOut}`);
    });
    assert.match(fs.readFileSync(logFile, 'utf8'), /g1111111/);

    const browser = client(appBase);
    assert.equal(
      (await browser.post('/api/uburoom-accounts/sign-in', { username: 'alex', password: 'launch password 1' })).status,
      200,
    );
    const running = (await browser.request('/api/operator/settings')).body;
    assert.equal(running.canRestart, true);
    const csrf = (await browser.request('/api/me')).body.csrf;
    assert.ok(csrf);

    // Point current.txt to slot2 before restarting
    fs.writeFileSync(path.join(root, 'current.txt'), `${slot2}\n`);
    const restartRes = await browser.post('/api/operator/restart', {}, { 'x-csrf-token': csrf });
    assert.equal(restartRes.status, 202);
    assert.equal(restartRes.body.supervised, true);

    // Wait for respawn on the same port and confirm slot2 booted cleanly with WAL/lock intact
    await new Promise(resolve => setTimeout(resolve, 700));
    await waitForHealth(appBase);
    assert.match(fs.readFileSync(logFile, 'utf8'), /g2222222/);
    assert.match(supOut, /Restarting uburoom/);
  } finally {
    killTree(supervisor);
    await new Promise(resolve => supervisor.once('exit', resolve));
  }

  // 4. Corrupt config.yaml exits non-zero ONCE without restart-looping
  fs.writeFileSync(configFile, 'access: [broken');
  const failLauncher = spawn(process.execPath, [launcherPath, '--no-browser'], {
    env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitCode = await new Promise(resolve => failLauncher.once('exit', code => resolve(code)));
  assert.notEqual(exitCode, 0);
  assert.notEqual(exitCode, 75);
});
