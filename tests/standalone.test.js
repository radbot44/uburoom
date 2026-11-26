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
const APP_VERSION = require('../package.json').version;

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
      JSON.stringify({
        uburoom: {
          version: APP_VERSION,
          commit: marker.padEnd(40, marker[0]),
          shortCommit: marker,
          dirty: false,
          slot: path.basename(slotDir),
        },
      }),
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

    // A newly active viewer must win if they join while the restart audit is being flushed.
    room.state.paused = true;
    const { audit, flush } = app.registry;
    let requested = false;
    let reachedAuditFlush;
    const atAuditFlush = new Promise(resolve => (reachedAuditFlush = resolve));
    let releaseAuditFlush;
    const waitForViewer = new Promise(resolve => (releaseAuditFlush = resolve));
    app.registry.audit = function (actor, action, data) {
      if (action === 'operator-restart') requested = true;
      return audit.call(this, actor, action, data);
    };
    app.registry.flush = async function () {
      if (requested) {
        requested = false;
        reachedAuditFlush();
        await waitForViewer;
      }
      return flush.call(this);
    };
    const pendingRestart = browser.post('/api/operator/restart', {}, { 'x-csrf-token': csrf });
    let overlapping;
    try {
      // Race the gate against the request so a missing flush fails instead of hanging the suite.
      await Promise.race([atAuditFlush, pendingRestart]);
      overlapping = await browser.post('/api/operator/restart', { confirmActive: true }, { 'x-csrf-token': csrf });
      room.viewers.set('v-1', { userId: guestUser.userId, actor: { userId: guestUser.userId, name: 'Viewer' } });
    } finally {
      releaseAuditFlush();
    }
    const lateViewer = await pendingRestart;
    app.registry.audit = audit;
    app.registry.flush = flush;
    assert.equal(overlapping.status, 409, 'an unaccepted restart must not report success to another request');
    assert.equal(lateViewer.status, 409);
    assert.equal(lateViewer.body.code, 'ACTIVE_ROOMS');
    assert.equal(lateViewer.body.activeViewers, 1);
    assert.equal(restartCalls, 0);

    const health = await browser.request('/health');
    assert.equal(health.headers['cache-control'], 'no-store');
    assert.equal(health.body.service, 'uburoom');
    assert.ok(health.body.bootId);

    const confirmed = await browser.post('/api/operator/restart', { confirmActive: true }, { 'x-csrf-token': csrf });
    assert.equal(confirmed.status, 202);
    assert.equal(confirmed.body.restarting, true);
    assert.equal(confirmed.body.bootId, health.body.bootId);
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

  const slot1 = `${APP_VERSION}-g1111111`;
  const slot2 = `${APP_VERSION}-g2222222`;
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
    const before = await waitForHealth(appBase).catch(err => {
      throw new Error(`${err.message}\nsupervisor output:\n${supOut}`);
    });
    assert.ok(fs.readFileSync(logFile, 'utf8').includes(`uburoom v${APP_VERSION} (g1111111) listening`));

    // The same copied app is invoked by the bundled doctor wrapper. A nonexistent config is
    // intentional here: avoid competing with the running server or contacting external providers.
    const doctor = require(path.join(app1, 'scripts', 'doctor.js'));
    const report = await doctor.runDoctor({
      args: ['--config', path.join(root, 'missing-doctor-config.yaml'), '--json'],
      silent: true,
    });
    assert.equal(report.build, `v${APP_VERSION} (g1111111)`);
    assert.equal(report.commit, '1'.repeat(40));

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
    assert.equal(restartRes.body.bootId, before.bootId);

    // Wait for respawn on the same port and confirm slot2 booted cleanly with WAL/lock intact
    await new Promise(resolve => setTimeout(resolve, 700));
    const after = await waitForHealth(appBase);
    assert.equal(after.version, before.version);
    assert.notEqual(after.bootId, before.bootId);
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

test('launcher.js --tray-pipe reports active setup/server URLs and handles clean restart and shutdown', async t => {
  const { parseLauncherArgs } = require('../scripts/launcher');
  const parsed = parseLauncherArgs(['--no-browser', '--tray-pipe', '\\\\.\\pipe\\sample', '--setup-port', '1234']);
  assert.equal(parsed.noBrowser, true);
  assert.equal(parsed.trayPipe, '\\\\.\\pipe\\sample');
  assert.deepEqual(parsed.forwardedArgs, ['--setup-port', '1234']);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-tray-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const keysDir = path.join(root, 'keys');
  fs.mkdirSync(keysDir, { recursive: true });
  const credKeyFile = path.join(keysDir, 'credentials.key');

  const slot1 = `${APP_VERSION}-g3333333`;
  const slot2 = `${APP_VERSION}-g4444444`;
  const app1 = linkSlotApp(path.join(root, 'versions', slot1), { marker: '3333333' });
  linkSlotApp(path.join(root, 'versions', slot2), { marker: '4444444' });
  fs.writeFileSync(path.join(root, 'current.txt'), `${slot1}\n`);

  const launcherPath = path.join(app1, 'scripts', 'launcher.js');

  function createPipeServer(pipePath) {
    const events = [];
    let clientSocket = null;
    const waiters = [];
    const server = net.createServer(socket => {
      clientSocket = socket;
      socket.setEncoding('utf8');
      let buf = '';
      socket.on('data', chunk => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          events.push(msg);
          for (let i = waiters.length - 1; i >= 0; i--) {
            if (waiters[i].predicate(msg)) {
              const { resolve, timer } = waiters.splice(i, 1)[0];
              clearTimeout(timer);
              resolve(msg);
            }
          }
        }
      });
    });
    const waitForEvent = (predicate, timeoutMs = 15000) => {
      const existing = events.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`Timed out waiting for tray pipe event; saw: ${JSON.stringify(events)}`)),
          timeoutMs,
        );
        waiters.push({ predicate, resolve, timer });
      });
    };
    const sendCommand = cmd => {
      assert.ok(clientSocket && !clientSocket.destroyed, 'tray pipe client must be connected');
      clientSocket.write(`${JSON.stringify(cmd)}\n`);
    };
    return { server, events, waitForEvent, sendCommand };
  }

  // 1. Setup mode over --tray-pipe emits setup URL and exits 0 cleanly on shutdown command
  const setupPort = await freePort();
  const setupPipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\uburoom-test-setup-${process.pid}-${Date.now()}`
      : path.join(root, 'setup.sock');
  const setupPipe = createPipeServer(setupPipePath);
  await new Promise(resolve => setupPipe.server.listen(setupPipePath, resolve));
  t.after(() => setupPipe.server.close());

  const setupLauncher = spawn(
    process.execPath,
    [launcherPath, '--no-browser', '--tray-pipe', setupPipePath, '--setup-port', String(setupPort)],
    {
      env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  try {
    const setupMsg = await setupPipe.waitForEvent(ev => ev.type === 'status' && ev.state === 'setup');
    assert.match(setupMsg.url, new RegExp(`^http://localhost:${setupPort}/setup#code=`));
    setupPipe.sendCommand({ type: 'shutdown' });
    const code = await new Promise(resolve => setupLauncher.once('exit', resolve));
    assert.equal(code, 0, 'launcher must exit cleanly with code 0 on tray shutdown');
  } finally {
    killTree(setupLauncher);
  }

  // 2. Normal server mode emits running URL, switches slot on restart command, and shuts down cleanly
  const port = await freePort();
  const certDir = path.join(root, 'config', 'certs');
  fs.mkdirSync(certDir, { recursive: true });
  const { certPem, keyPem } = createCertificate();
  fs.writeFileSync(path.join(certDir, 'server-cert.pem'), certPem);
  fs.writeFileSync(path.join(certDir, 'server-key.pem'), keyPem);
  const configFile = path.join(root, 'config', 'config.yaml');
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
      "  identities: ['uburoom:op-tray']",
      'logging:',
      "  level: 'info'",
      '  requests: false',
      "  file: ''",
      '',
    ].join('\n'),
  );

  const serverPipePath =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\uburoom-test-server-${process.pid}-${Date.now()}`
      : path.join(root, 'server.sock');
  const serverPipe = createPipeServer(serverPipePath);
  await new Promise(resolve => serverPipe.server.listen(serverPipePath, resolve));
  t.after(() => serverPipe.server.close());

  const serverLauncher = spawn(process.execPath, [launcherPath, '--no-browser', '--tray-pipe', serverPipePath], {
    env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const firstReady = await serverPipe.waitForEvent(ev => ev.type === 'status' && ev.state === 'running');
    assert.equal(firstReady.url, `https://localhost:${port}`);
    const beforeHealth = await waitForHealth(`https://localhost:${port}`);

    fs.writeFileSync(path.join(root, 'current.txt'), `${slot2}\n`);
    const prevRunningCount = serverPipe.events.filter(ev => ev.state === 'running').length;
    serverPipe.sendCommand({ type: 'restart' });
    await serverPipe.waitForEvent(
      () => serverPipe.events.filter(ev => ev.state === 'running').length > prevRunningCount,
    );
    const afterHealth = await waitForHealth(`https://localhost:${port}`);
    assert.notEqual(afterHealth.bootId, beforeHealth.bootId);

    serverPipe.sendCommand({ type: 'shutdown' });
    const code = await new Promise(resolve => serverLauncher.once('exit', resolve));
    assert.equal(code, 0, 'server launcher must exit cleanly with code 0 on tray shutdown');
  } finally {
    killTree(serverLauncher);
  }
});

test(
  'uburoom-tray.exe builds cleanly with inbox csc.exe, supervises launcher with rotating log, and quits cleanly',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-tray-exe-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const keysDir = path.join(root, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });

    const slot = `${APP_VERSION}-g5555555`;
    linkSlotApp(path.join(root, 'versions', slot), { marker: '5555555' });
    fs.writeFileSync(path.join(root, 'current.txt'), `${slot}\n`);

    const trayExe = path.join(root, 'uburoom-tray.exe');
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(REPO_ROOT, 'tools', 'tray-win', 'build.ps1'),
        '-OutPath',
        trayExe,
      ],
      { stdio: 'pipe', windowsHide: true },
    );
    assert.equal(fs.existsSync(trayExe), true);
    assert.ok(fs.statSync(trayExe).size > 4096);

    const setupPort = await freePort();
    const logPath = path.join(root, 'config', 'data', 'uburoom-launcher.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, `${'previous-log-entry-'.repeat(64)}\n`);

    const trayProc = spawn(
      trayExe,
      [
        '--root',
        root,
        '--node',
        process.execPath,
        '--no-browser',
        '--max-log-bytes',
        '1024',
        '--setup-port',
        String(setupPort),
      ],
      {
        env: { ...process.env, LOCALAPPDATA: keysDir, XDG_DATA_HOME: keysDir },
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    try {
      const health = await waitForHealth(`http://localhost:${setupPort}`);
      assert.equal(health.setup, true);

      const deadline = Date.now() + 5000;
      let logText = '';
      while (Date.now() < deadline) {
        if (fs.existsSync(logPath)) {
          logText = fs.readFileSync(logPath, 'utf8');
          if (logText.includes('[tray] Status: setup')) break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.ok(fs.existsSync(logPath), 'uburoom-launcher.log must be created under config/data/');
      assert.ok(fs.existsSync(`${logPath}.1`), 'oversized uburoom-launcher.log must rotate to .1');
      assert.match(fs.readFileSync(`${logPath}.1`, 'utf8'), /previous-log-entry-/);
      assert.match(logText, /\[tray\] Status: setup \(http:\/\/localhost:\d+\/setup\)/);
      // Tray's own status log line must never include the setup #code fragment.
      const trayStatusLine = logText.split(/\r?\n/).find(line => line.includes('[tray] Status: setup'));
      assert.ok(trayStatusLine && !trayStatusLine.includes('#code='));

      // Cleanly quit via --quit (same code path as clicking "Quit uburoom")
      execFileSync(trayExe, ['--root', root, '--quit'], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
      const exitCode = await new Promise((resolve, reject) => {
        if (trayProc.exitCode !== null) return resolve(trayProc.exitCode);
        const timer = setTimeout(() => reject(new Error('Timed out waiting for uburoom-tray.exe to exit')), 10000);
        trayProc.once('exit', code => {
          clearTimeout(timer);
          resolve(code);
        });
      });
      assert.equal(exitCode, 0);
    } finally {
      killTree(trayProc);
    }
  },
);
