'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { Accounts, credentialVault } = require('../server/accounts');
const { initializeSchema } = require('../server/storage');
const { createUburoomAccounts } = require('../server/identity/accounts');
const { fixture } = require('./helpers/account-app');

// Everyone admitted (no entry rules), so a signed-in uburoom account is a usable session here;
// which entry rule admits uburoom accounts is the admission layer's business.
const OPEN = { accessPolicy: { discord: false, plex: false, password: '', publicWeb: true } };

async function operatorApp(t, overrides = {}) {
  const lines = [];
  const logger = {
    isLevelEnabled: () => true,
    tap: () => () => {},
    child: () => logger,
    ...Object.fromEntries(
      ['debug', 'info', 'warn', 'error'].map(level => [level, (...args) => lines.push(args.join(' '))]),
    ),
  };
  const f = await fixture(t, undefined, { logging: { requests: true }, ...OPEN, ...overrides }, { logger });
  f.config.serverOperator = { discordId: f.provider.subjects.host };
  const operator = f.browser();
  assert.equal((await operator.request('/api/account/demo-login', { persona: 'host' })).status, 200);
  return { ...f, operator, lines };
}
const tokenOf = url => new URL(url).hash.slice(1);

test('a version 12 database is refused, without changes, by the version 13 baseline', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-v12-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'accounts.sqlite');
  const db = new DatabaseSync(file);
  initializeSchema(db);
  // The version 12 layout: credentials keyed by subject alone, no uburoom accounts.
  db.exec(`DROP TABLE uburoom_accounts; DROP TABLE credentials;
    CREATE TABLE credentials(subject TEXT PRIMARY KEY,value TEXT NOT NULL); PRAGMA user_version=12;`);
  const before = db.prepare('SELECT name,sql FROM sqlite_master').all();
  assert.throws(() => initializeSchema(db), /Unsupported pre-release database/);
  assert.deepEqual(db.prepare('SELECT name,sql FROM sqlite_master').all(), before);
  db.close();
  assert.throws(() => new Accounts(file, credentialVault()), /Unsupported pre-release database/);
});

test('credentials are kept per provider and subject; unlinking removes only that provider', t => {
  const accounts = new Accounts(undefined, credentialVault());
  t.after(() => accounts.close());
  const user = accounts.resolve('plex', '101', 'Alice');
  accounts.link(user.id, 'discord', '101', 'Alice');
  accounts.credential('plex', '101', { token: 'fixture-plex' });
  accounts.credential('jellyfin:server', '101', { token: 'fixture-jellyfin' });
  assert.equal(accounts.credential('plex', '101').token, 'fixture-plex');
  assert.equal(accounts.credential('jellyfin:server', '101').token, 'fixture-jellyfin');
  assert.equal(accounts.hasCredential('discord', '101'), false);
  accounts.unlink(user.id, 'plex', '101');
  assert.equal(accounts.hasCredential('plex', '101'), false);
  assert.equal(accounts.credential('jellyfin:server', '101').token, 'fixture-jellyfin');
});

test('operator creates an account; its one-time link sets the password once and signs in', async t => {
  const { operator, browser, app, lines } = await operatorApp(t);
  const outsider = browser();
  assert.equal((await outsider.post('/api/operator/accounts', { username: 'x' })).status, 403);
  await outsider.request('/api/account/demo-login', { persona: 'guest' });
  assert.equal((await outsider.request('/api/operator/accounts')).status, 403);

  const created = await operator.post('/api/operator/accounts', { username: ' Alice.B ', name: 'Alice B' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.account.username, 'alice.b');
  assert.equal(created.body.account.passwordSet, false);
  assert.match(created.body.link.url, /\/account\/password#[\w-]{43}$/);
  const token = tokenOf(created.body.link.url);
  assert.equal(
    (await operator.post('/api/operator/accounts', { username: 'ALICE.b' })).status,
    400,
    'case-insensitive',
  );

  // Nothing but the creation answer ever carries the link, and the database holds only its hash.
  const listed = await operator.request('/api/operator/accounts');
  assert.equal(listed.body.accounts.length, 1);
  assert.doesNotMatch(JSON.stringify(listed.body), new RegExp(token));
  assert.doesNotMatch(JSON.stringify(listed.body), /hash|salt/i);
  const row = app.registry.db.prepare('SELECT * FROM uburoom_accounts').get();
  assert.notEqual(row.linkHash, token);
  assert.equal(app.registry.identity('uburoom', row.subject).verified, 0, 'unverified until a password is set');
  assert.equal(app.uburoomAccounts.admits(created.body.account.userId), false);

  const visitor = browser();
  assert.deepEqual((await visitor.request('/api/uburoom-accounts/link', { token })).body, {
    username: 'alice.b',
    name: 'Alice B',
    purpose: 'set',
  });
  const short = await visitor.request('/api/uburoom-accounts/password', { token, password: 'too short' });
  assert.equal(short.status, 400);
  assert.match(short.body.error, /10/);
  const set = await visitor.request('/api/uburoom-accounts/password', { token, password: 'correct horse battery' });
  assert.equal(set.status, 200);
  const me = (await visitor.request('/api/me')).body;
  assert.equal(me.loggedIn, true);
  assert.equal(me.name, 'Alice B');
  assert.equal(app.uburoomAccounts.admits(created.body.account.userId), true);

  const reused = await browser().request('/api/uburoom-accounts/password', { token, password: 'another password!' });
  assert.equal(reused.status, 400);
  assert.match(reused.body.error, /expired or was already used/);
  assert.equal((await browser().request('/api/uburoom-accounts/link', { token })).status, 400);

  const stored = app.registry.db.prepare('SELECT * FROM uburoom_accounts').get();
  assert.equal(stored.linkHash, null);
  assert.equal(JSON.parse(stored.passwordParams).N, 2 ** 15);
  assert.doesNotMatch(stored.passwordHash, /correct horse/);
  const audit = JSON.stringify(app.registry.db.prepare('SELECT * FROM audit').all());
  const logged = lines.join('\n');
  assert.match(logged, /\/api\/uburoom-accounts\/password/, 'requests are logged');
  for (const secret of [token, 'correct horse battery', stored.passwordHash, row.linkHash]) {
    assert.ok(!audit.includes(secret), 'audit holds no secret');
    assert.ok(!logged.includes(secret), 'logs hold no secret');
  }
});

test('links expire, a new link replaces the old one, and the new password ends older sessions', async t => {
  const { operator, browser, app } = await operatorApp(t);
  const created = (await operator.post('/api/operator/accounts', { username: 'bob' })).body;
  const first = tokenOf(created.link.url);
  app.registry.db.prepare('UPDATE uburoom_accounts SET linkExpires=?').run(Date.now() - 1);
  const expired = await browser().request('/api/uburoom-accounts/password', {
    token: first,
    password: 'long enough pw',
  });
  assert.equal(expired.status, 400);
  assert.equal(app.registry.db.prepare('SELECT passwordHash FROM uburoom_accounts').get().passwordHash, null);

  const second = tokenOf(
    (await operator.post('/api/operator/accounts/link', { subject: created.account.subject })).body.link.url,
  );
  const old = browser();
  assert.equal(
    (await old.request('/api/uburoom-accounts/password', { token: second, password: 'first password' })).status,
    200,
  );
  assert.equal((await old.request('/api/me')).body.loggedIn, true);

  const reissued = await operator.post('/api/operator/accounts/link', { subject: created.account.subject });
  assert.equal(reissued.body.link.expires > Date.now() + 71 * 3600000, true);
  assert.equal(reissued.body.account.link.purpose, 'reset');
  const third = tokenOf(reissued.body.link.url);
  assert.equal(
    (await browser().request('/api/uburoom-accounts/link', { token: second })).status,
    400,
    'old link is gone',
  );
  // The current password keeps working until the new link is used.
  assert.equal(
    (await browser().request('/api/uburoom-accounts/sign-in', { username: 'bob', password: 'first password' })).status,
    200,
  );
  assert.equal(
    (await browser().request('/api/uburoom-accounts/password', { token: third, password: 'second password' })).status,
    200,
  );
  assert.equal((await old.request('/api/me')).body.loggedIn, false, 'recovery ends earlier sessions');
  assert.equal(
    (await browser().request('/api/uburoom-accounts/sign-in', { username: 'bob', password: 'first password' })).status,
    401,
  );
  assert.equal(
    (await browser().request('/api/uburoom-accounts/sign-in', { username: 'BOB', password: 'second password' })).status,
    200,
  );
});

test('wrong passwords get one uniform answer and are rate-limited per username and per address', async t => {
  const { operator, browser, app } = await operatorApp(t);
  const created = (await operator.post('/api/operator/accounts', { username: 'carol' })).body;
  await browser().request('/api/uburoom-accounts/password', {
    token: tokenOf(created.link.url),
    password: 'carol password',
  });
  const attacker = browser();
  const unknown = await attacker.request('/api/uburoom-accounts/sign-in', {
    username: 'nobody',
    password: 'whatever pw',
  });
  const wrong = await attacker.request('/api/uburoom-accounts/sign-in', { username: 'carol', password: 'whatever pw' });
  assert.equal(unknown.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  for (let i = 0; i < 4; i++)
    assert.equal(
      (await attacker.request('/api/uburoom-accounts/sign-in', { username: 'Carol', password: 'nope nope' })).status,
      401,
    );
  // Five failures for carol: even the right password waits now, from any address.
  const limited = await browser().request('/api/uburoom-accounts/sign-in', {
    username: 'carol',
    password: 'carol password',
  });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers['set-cookie'], undefined);

  // Per address: twenty failures across any usernames stop this address.
  for (let i = 0; i < 14; i++)
    assert.equal(
      (await attacker.request('/api/uburoom-accounts/sign-in', { username: 'user' + i, password: 'nope nope' })).status,
      401,
    );
  assert.equal(
    (await attacker.request('/api/uburoom-accounts/sign-in', { username: 'dave', password: 'nope nope' })).status,
    429,
  );
  // Cross-site posts are refused before any check.
  assert.equal(
    (
      await browser().request(
        '/api/uburoom-accounts/sign-in',
        { username: 'carol', password: 'x' },
        { Origin: 'https://evil.invalid' },
      )
    ).status,
    403,
  );
  assert.ok(app);
});

test('disabling an account ends its sessions and sign-in; enabling restores sign-in', async t => {
  const { operator, browser, app } = await operatorApp(t);
  const created = (await operator.post('/api/operator/accounts', { username: 'erin' })).body;
  const erin = browser();
  await erin.request('/api/uburoom-accounts/password', { token: tokenOf(created.link.url), password: 'erin password' });
  const other = browser();
  assert.equal(
    (await other.request('/api/uburoom-accounts/sign-in', { username: 'erin', password: 'erin password' })).status,
    200,
  );
  assert.equal((await erin.request('/api/me')).body.loggedIn, true);

  const disabled = await operator.post('/api/operator/accounts/disable', { subject: created.account.subject });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.body.account.disabled, true);
  assert.equal((await erin.request('/api/me')).body.loggedIn, false);
  assert.equal((await other.request('/api/me')).body.loggedIn, false);
  assert.equal(app.registry.identity('uburoom', created.account.subject).verified, 0);
  assert.equal(app.uburoomAccounts.admits(created.account.userId), false);
  const refused = await browser().request('/api/uburoom-accounts/sign-in', {
    username: 'erin',
    password: 'erin password',
  });
  assert.equal(refused.status, 401);
  assert.equal(refused.body.error, 'Wrong username or password');
  assert.equal((await operator.post('/api/operator/accounts/link', { subject: created.account.subject })).status, 400);

  assert.equal(
    (await operator.post('/api/operator/accounts/enable', { subject: created.account.subject })).status,
    200,
  );
  assert.equal(
    (await browser().request('/api/uburoom-accounts/sign-in', { username: 'erin', password: 'erin password' })).status,
    200,
  );
  assert.equal(app.uburoomAccounts.admits(created.account.userId), true);
});

test('operator authority is checked again after awaited work, before any change', async t => {
  const { operator, app, config } = await operatorApp(t);
  const flush = app.registry.flush.bind(app.registry);
  app.registry.flush = async () => {
    config.serverOperator = { discordId: '999999999999999999' };
    return flush();
  };
  const refused = await operator.post('/api/operator/accounts', { username: 'frank' });
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /authorization changed/);
  assert.equal(app.registry.db.prepare('SELECT count(*) AS n FROM uburoom_accounts').get().n, 0);
});

test('setup can create the first account directly, signed in by its password', async t => {
  const accounts = new Accounts(undefined, credentialVault());
  t.after(() => accounts.close());
  const uburoom = createUburoomAccounts({ registry: accounts });
  await assert.rejects(uburoom.createFirst({ username: 'owner', password: 'short' }), /10/);
  const first = await uburoom.createFirst({ username: 'Owner', name: 'The owner', password: 'owner password' });
  assert.equal(first.passwordSet, true);
  assert.equal(first.link, null);
  assert.equal(accounts.identity('uburoom', first.subject).verified, 1);
  assert.notEqual(first.subject, 'owner', 'the subject is a stable id, not the username');
  assert.equal(await uburoom.verify('owner', 'owner password'), first.userId);
  assert.equal(await uburoom.verify('owner', 'wrong password'), undefined);
  assert.equal(uburoom.admits(first.userId), true);
});
