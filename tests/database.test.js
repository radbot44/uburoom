'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { Accounts, credentialVault } = require('../server/accounts');
const { loginStore } = require('../server/storage');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-storage-'));
  t.after(() => {
    assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, file: path.join(directory, 'accounts.sqlite'), vault: credentialVault() };
}
test('SQLite alone preserves contexts and encrypted logins across restart', async t => {
  const { directory, file, vault } = fixture(t),
    loginFile = path.join(directory, 'logins.json');
  const id = 'a'.repeat(64),
    value = {
      userId: 'user',
      name: 'Alice',
      csrf: 'b'.repeat(64),
      expires: null,
      oauth: { refreshToken: 'private-test-token', expires: 9999999999999 },
    };
  fs.writeFileSync(loginFile, 'invalid legacy data');
  let accounts = new Accounts(file, vault);
  const logins = loginStore('one', vault, accounts);
  assert.equal(logins.logins.size, 0);
  logins.logins.set(id, value);
  await logins.save();
  assert.equal(logins.logins.get(id).oauth.refreshToken, value.oauth.refreshToken);
  await accounts.flush();
  const read = new DatabaseSync(file);
  assert.ok(!read.prepare('SELECT record FROM browser_logins').get().record.includes('private-test-token'));
  read.close();
  logins.logins.delete(id);
  await logins.save();
  await accounts.close();
  accounts = new Accounts(file, vault);
  try {
    assert.equal(loginStore('one', vault, accounts).logins.size, 0, 'legacy login is not reimported after logout');
    const next = loginStore('two', vault, accounts);
    next.logins.set(id, value);
    await next.save();
    assert.equal(
      loginStore('two', vault, accounts).logins.size,
      1,
      'new sign-in survives an authorization context change',
    );
    assert.equal(loginStore('one', vault, accounts).logins.size, 0, 'old context cannot reuse a login');
  } finally {
    await accounts.close();
  }
});
test('locked direct writes fail before acknowledgement and can be retried after rollback', async t => {
  const { file, vault } = fixture(t),
    accounts = new Accounts(file, vault);
  const lock = new DatabaseSync(file);
  lock.exec('BEGIN IMMEDIATE');
  try {
    assert.throws(() => accounts.resolve('plex', '101', 'Alice'), /locked/);
    assert.equal(accounts.identity('plex', '101'), undefined);
    assert.equal(accounts.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
  } finally {
    lock.exec('ROLLBACK');
    lock.close();
  }
  const id = accounts.resolve('plex', '101', 'Alice').id;
  const read = new DatabaseSync(file);
  assert.equal(read.prepare('SELECT name FROM users WHERE id=?').get(id).name, 'Alice');
  read.close();
  await accounts.close();
  assert.equal(fs.existsSync(file + '-wal'), false, 'graceful close leaves a single database file');
});

test('failed login transactions roll back all writes and retry without losing cached changes', async t => {
  const { file, vault } = fixture(t),
    accounts = new Accounts(file, vault);
  try {
    const store = loginStore('fixture', vault, accounts);
    store.logins.set('login', { userId: 'fixture', expires: null });
    accounts.db.exec(
      "CREATE TRIGGER reject_login_context BEFORE UPDATE ON meta WHEN new.key='loginContext' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END",
    );
    assert.throws(() => store.save(), /fixture storage failure/);
    assert.equal(accounts.db.prepare('SELECT COUNT(*) AS n FROM browser_logins').get().n, 0);
    accounts.db.exec('DROP TRIGGER reject_login_context');
    await store.save();
    const read = new DatabaseSync(file);
    assert.equal(JSON.parse(read.prepare('SELECT record FROM browser_logins').get().record).userId, 'fixture');
    read.close();
  } finally {
    await accounts.close();
  }
});

test('direct playback writes keep the local event-loop p95 below the synchronization budget', async t => {
  const { monitorEventLoopDelay } = require('node:perf_hooks'),
    { randomUUID } = require('node:crypto');
  const { PlaybackTracking } = require('../server/playback-tracking');
  const { file, vault } = fixture(t),
    accounts = new Accounts(file, vault),
    tracking = new PlaybackTracking(accounts);
  const user = accounts.resolve('plex', '101', 'Load fixture');
  const room = { roomId: randomUUID(), media: { id: '42', duration: 300 }, mediaVersion: randomUUID() };
  const viewers = Array.from({ length: 16 }, () => ({
    userId: user.id,
    observationEpoch: randomUUID(),
    streamVersion: randomUUID(),
    mediaVersion: room.mediaVersion,
    media: { kind: 'plex', format: 'hls' },
  }));
  await accounts.flush();
  const delay = monitorEventLoopDelay({ resolution: 5 });
  delay.enable();
  try {
    for (let sequence = 0; sequence < 20; sequence++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      for (const [i, viewer] of viewers.entries())
        tracking.observe(room, viewer, String(i), {
          observationEpoch: viewer.observationEpoch,
          streamVersion: viewer.streamVersion,
          mediaVersion: room.mediaVersion,
          sequence,
          sampleAt: performance.now(),
          observedAt: Date.now(),
          position: 0,
          state: 'paused',
          frames: 0,
          rate: 1,
          discontinuity: 0,
        });
    }
    await accounts.flush();
    delay.disable();
    const p95 = delay.percentile(95) / 1e6,
      max = delay.max / 1e6;
    t.diagnostic(
      `16 paused viewers, 320 durable observations: event-loop p95 ${p95.toFixed(2)} ms; max ${max.toFixed(2)} ms (isolated local workload)`,
    );
    assert.ok(p95 < 50, 'local synthetic storage load stays inside the 50 ms event-loop budget');
  } finally {
    delay.disable();
    for (const viewer of viewers) tracking.end(viewer, 'test-end');
    await accounts.close();
  }
});

test('unsupported pre-release schema fails startup without leaving an open database', async t => {
  const { directory } = fixture(t),
    keyFile = path.join(directory, 'key');
  fs.writeFileSync(keyFile, Buffer.alloc(32, 7));
  const old = new DatabaseSync(path.join(directory, 'accounts.sqlite'));
  old.exec('CREATE TABLE users(id TEXT); PRAGMA user_version=1;');
  old.close();
  const config = {
    publicUrl: 'https://localhost',
    accountFile: path.join(directory, 'accounts.sqlite'),
    credentialKeyFile: keyFile,
  };
  const source = `try { require(${JSON.stringify(path.join(__dirname, '../server/app'))}).createApp(${JSON.stringify(config)}); process.exitCode=1; } catch(error) { console.log(error.message); }`;
  const output = await new Promise((resolve, reject) =>
    require('node:child_process').execFile(
      process.execPath,
      ['-e', source],
      { windowsHide: true, timeout: 5000, maxBuffer: 4096 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );
  assert.match(output, /Unsupported pre-release database/);
});

test('unsupported schemas fail without changing existing data or installing missing tables', t => {
  const { initializeSchema } = require('../server/storage');
  for (const [version, sql, message] of [
    [0, 'CREATE TABLE old_state(id TEXT);', 'pre-release'],
    [10, 'CREATE TABLE users(id TEXT);', 'pre-release'],
    [12, 'CREATE TABLE future_state(id TEXT);', 'newer'],
  ]) {
    const db = new DatabaseSync(':memory:');
    db.exec(sql + 'PRAGMA user_version=' + version);
    const before = db.prepare('SELECT name,sql FROM sqlite_master').all();
    assert.throws(() => initializeSchema(db), new RegExp(message));
    assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master').all(), before);
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, version);
    db.close();
  }
  const previous = new DatabaseSync(':memory:');
  initializeSchema(previous);
  previous.exec(
    'DROP TABLE watch_queue_entries; DROP TABLE watch_room_hosts; DROP TABLE watch_rooms; PRAGMA user_version=1;',
  );
  previous.prepare('INSERT INTO meta VALUES(?,?)').run('retained-private-state', 'original');
  const before = previous.prepare('SELECT name,sql FROM sqlite_master').all();
  assert.throws(() => initializeSchema(previous), /Unsupported pre-release database/);
  assert.deepEqual(previous.prepare('SELECT name,sql FROM sqlite_master').all(), before);
  assert.equal(previous.prepare('SELECT value FROM meta WHERE key=?').get('retained-private-state').value, 'original');
  assert.equal(previous.prepare('PRAGMA user_version').get().user_version, 1);
  previous.close();
});

test('matched offline SQLite and original-key backup restores UUIDs, credentials, logins and playback history', async t => {
  const { directory, file } = fixture(t),
    key = path.join(directory, 'original.key');
  fs.writeFileSync(key, Buffer.alloc(32, 19));
  const vault = credentialVault(key);
  const accounts = new Accounts(file, vault),
    user = accounts.resolve('plex', '101', 'Alice');
  accounts.credential('101', { token: 'private-restore-fixture' });
  const logins = loginStore('baseline', vault, accounts);
  logins.logins.set('b'.repeat(64), {
    userId: user.id,
    name: 'Alice',
    csrf: 'c'.repeat(64),
    expires: null,
    oauth: { refreshToken: 'private-login-fixture', expires: 9999999999999 },
  });
  await logins.save();
  accounts.db
    .prepare('INSERT INTO playback_history VALUES(?,?,?,?)')
    .run('viewing', user.id, 1, JSON.stringify({ roomId: 'room', watchedSeconds: 12 }));
  await accounts.close();
  const copy = path.join(directory, 'restored.sqlite'),
    copyKey = path.join(directory, 'restored.key');
  fs.copyFileSync(file, copy);
  fs.copyFileSync(key, copyKey);
  const restored = new Accounts(copy, credentialVault(copyKey));
  try {
    assert.equal(restored.db.prepare('PRAGMA user_version').get().user_version, 11);
    assert.equal(restored.identity('plex', '101').userId, user.id);
    assert.equal(restored.credential('101').token, 'private-restore-fixture');
    assert.equal(
      loginStore('baseline', restored.vault, restored).logins.get('b'.repeat(64)).oauth.refreshToken,
      'private-login-fixture',
    );
    assert.equal(restored.db.prepare('SELECT userId FROM playback_history').get().userId, user.id);
    assert.equal(restored.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(fs.readFileSync(copyKey), fs.readFileSync(key));
  } finally {
    await restored.close();
  }
});

test('HTTP acknowledgements survive a forced process kill without graceful close', { timeout: 20000 }, async t => {
  const { file, vault } = fixture(t);
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const https = require('node:https');
  const root = path.resolve(__dirname, '..');
  // Fixture-only routes exercise the actual HTTP server and account/login/room/
  // queue services. No provider, production config or credentials are loaded.
  const source = `
    const root = ${JSON.stringify(root)};
    const fs = require('node:fs'), path = require('node:path');
    const { Accounts, credentialVault } = require(path.join(root, 'server/accounts'));
    const { loginStore } = require(path.join(root, 'server/storage'));
    const { RoomStore } = require(path.join(root, 'server/room-store'));
    const { RoomQueue } = require(path.join(root, 'server/room-queue'));
    const accounts = new Accounts(${JSON.stringify(file)}, credentialVault());
    const logins = loginStore('crash', accounts.vault, accounts);
    const rooms = new RoomStore(accounts), queue = new RoomQueue(accounts, rooms);
    const json = (res, status, value) => { res.writeHead(status, {'Content-Type':'application/json'}); res.end(JSON.stringify(value)); };
    const server = require(path.join(root, 'server/http/server')).createHttpServer({
      config: { publicUrl: 'https://localhost' }, logger: {}, json,
      tls: { cert: fs.readFileSync(path.join(root,'certs/server-cert.pem')), key: fs.readFileSync(path.join(root,'certs/server-key.pem')) },
      route: async ({res, url}) => {
        const name = url.searchParams.get('name');
        const user = accounts.resolve('plex', name, name);
        const room = await rooms.create(user.id, {name});
        await queue.add(room.id, user.id, {serverId:'fixture',mediaId:'42',type:'movie',title:'Fixture',duration:60,position:0});
        logins.logins.set(user.id, {userId:user.id, expires:null});
        await logins.save();
        json(res, 200, {userId:user.id, roomId:room.id});
        return true;
      }
    });
    server.listen(0, '127.0.0.1', () => process.send(server.address().port));
  `;
  const child = spawn(process.execPath, ['-e', source], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let errors = '';
  child.stderr.on('data', data => (errors += data));
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  });
  const [port] = await Promise.race([
    once(child, 'message'),
    exited.then(() => {
      throw new Error(errors);
    }),
  ]);
  const acknowledged = [];
  for (let i = 0; i < 8; i++) {
    const result = await new Promise((resolve, reject) => {
      const req = https.request(
        { hostname: '127.0.0.1', port, path: '/fixture?name=Crash' + i, method: 'POST', rejectUnauthorized: false },
        res => {
          let body = '';
          res.on('data', data => (body += data));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(result.status, 200, errors);
    acknowledged.push(result.body);
  }
  child.kill('SIGKILL');
  await exited;
  assert.ok(fs.existsSync(file + '-wal'), 'unclean shutdown leaves committed WAL to recover');
  const reopened = new Accounts(file, vault);
  try {
    assert.equal(reopened.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    for (const { userId, roomId } of acknowledged) {
      assert.ok(reopened.canonical(userId));
      assert.equal(reopened.db.prepare('SELECT creatorId FROM watch_rooms WHERE id=?').get(roomId).creatorId, userId);
      assert.equal(
        reopened.db.prepare('SELECT mediaId FROM watch_queue_entries WHERE roomId=?').get(roomId).mediaId,
        '42',
      );
      assert.equal(
        JSON.parse(reopened.db.prepare('SELECT record FROM browser_logins WHERE id=?').get(userId).record).userId,
        userId,
      );
    }
  } finally {
    await reopened.close();
  }
});

test('history projections preserve overlapping totals while bounded reductions yield to concurrent writes', async t => {
  const { PlaybackTracking } = require('../server/playback-tracking');
  const { file, vault } = fixture(t),
    accounts = new Accounts(file, vault),
    tracking = new PlaybackTracking(accounts);
  const user = accounts.resolve('plex', 'history', 'Fixture');
  try {
    const intervals = Array.from({ length: 500 }, (_, i) => [i * 2, i * 2 + 1]);
    for (let i = 0; i < 300; i++)
      tracking.save({
        id: String(i),
        userId: user.id,
        mediaId: '1',
        lastReceivedAt: Date.now() - i,
        wallIntervals: intervals,
        sourceIntervals: intervals,
      });
    await accounts.flush();
    let ticked = false;
    const timer = setTimeout(() => (ticked = true), 0);
    const read = tracking.history(user.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    accounts.meta('during-history', 'committed');
    await accounts.flush();
    const history = await read;
    clearTimeout(timer);
    assert.ok(ticked);
    assert.equal(history.sessions.length, 100);
    assert.deepEqual(history.totals, [{ mediaId: '1', watchedSeconds: 0.5, sourceSeconds: 500 }]);
    assert.ok(!history.sessions.some(row => row.wallIntervals || row.sourceIntervals));
    assert.equal(accounts.meta('during-history'), 'committed');
    const reads = Array.from({ length: 8 }, () => tracking.history(user.id));
    await assert.rejects(
      Promise.resolve().then(() => tracking.history(user.id)),
      error => error.status === 503 && /History is busy/.test(error.message),
    );
    await Promise.all(reads);
    assert.equal((await tracking.history(user.id)).sessions.length, 100, 'read slots are released');
  } finally {
    await accounts.close();
  }
});

test('history and audit retention bound age and row count without deleting recent account evidence', async t => {
  const { file, vault } = fixture(t),
    accounts = new Accounts(file, vault);
  const { repositories } = require('../server/repositories');
  const { history, accounts: repo } = repositories(accounts.db);
  const now = Date.now(),
    day = 86400000;
  try {
    accounts.transaction(() => {
      for (let i = 0; i < 5002; i++) history.save(String(i), 'fixture', now - i, '{}');
      history.save('expired', 'fixture', now - 91 * day, '{}');
      for (let i = 0; i < 20002; i++) repo.insertAudit(now - i, 'fixture', 'account-change', '{}');
      repo.insertAudit(now - 366 * day, 'fixture', 'expired', '{}');
      history.prune(now);
      repo.pruneAudit(now);
    });
    assert.equal(accounts.db.prepare('SELECT COUNT(*) AS n FROM playback_history').get().n, 5000);
    assert.equal(accounts.db.prepare('SELECT MIN(at) AS at FROM playback_history').get().at, now - 4999);
    assert.equal(accounts.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 20000);
    assert.equal(accounts.db.prepare('SELECT MIN(at) AS at FROM audit').get().at, now - 19999);
  } finally {
    await accounts.close();
  }
});
