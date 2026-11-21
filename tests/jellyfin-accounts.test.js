'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { Accounts, credentialVault } = require('../server/accounts');
const { jellyfinProvider } = require('../server/sources/jellyfin/provider');
const connect = require('../server/sources/jellyfin/connect');
const { fakeJellyfin } = require('./helpers/fake-jellyfin');

const ITEM = 'a'.repeat(32);

function setup(t, options) {
  const fake = fakeJellyfin(options);
  const registry = new Accounts(undefined, credentialVault());
  t.after(() => registry.close());
  let pinned;
  const pin = { get: () => pinned, set: async id => (pinned = id) };
  const provider = jellyfinProvider({
    source: { url: fake.base, apiKey: fake.state.apiKey, user: 'Library' },
    pipeline: {},
    pin,
    registry,
    fetcher: fake.fetch,
  });
  return { fake, registry, provider, provider_id: () => 'jellyfin:' + fake.state.serverId };
}

test('password sign-in sends the password once, keeps only the token (encrypted) and names a verified identity', async t => {
  const { fake, registry, provider } = setup(t);
  const alice = fake.addUser('Alice', 'alice-secret');
  fake.addUser('Dora', 'dora-secret', { disabled: true });
  const identity = await provider.signIn.password(' alice ', 'alice-secret');
  assert.deepEqual(
    { ...identity, token: undefined },
    { provider: 'jellyfin:' + fake.state.serverId, subject: alice, name: 'Alice', token: undefined },
  );
  assert.equal(registry.credential(identity.provider, alice).token, identity.token);
  const stored = JSON.stringify(registry.db.prepare('SELECT * FROM credentials').all());
  assert.ok(!stored.includes(identity.token), 'the token is stored encrypted');
  assert.ok(
    !stored.includes('alice-secret') &&
      !JSON.stringify(registry.db.prepare('SELECT * FROM audit').all()).includes('alice-secret'),
  );

  const attempts = () => fake.state.calls.filter(call => call.path === 'Users/AuthenticateByName').length;
  const before = attempts();
  await assert.rejects(provider.signIn.password('alice', 'wrong'), {
    code: 'JELLYFIN_REFUSED',
    message: 'Wrong Jellyfin username or password',
  });
  assert.equal(attempts(), before + 1, 'a wrong password is never retried (Jellyfin locks users out)');
  await assert.rejects(provider.signIn.password('nobody', 'wrong'), { message: 'Wrong Jellyfin username or password' });
  await assert.rejects(provider.signIn.password('dora', 'dora-secret'), { code: 'JELLYFIN_REFUSED' });
  fake.state.down = true;
  await assert.rejects(provider.signIn.password('alice', 'alice-secret'), { code: 'JELLYFIN_UNANSWERED' });
});

test('a sign-in answered by a different server than the pinned one is refused', async t => {
  const { fake, provider } = setup(t);
  fake.addUser('Alice', 'alice-secret');
  await provider.identity();
  fake.state.serverId = 'e'.repeat(32);
  await assert.rejects(provider.signIn.password('alice', 'alice-secret'), { code: 'JELLYFIN_SERVER' });
});

test('Quick Connect: code, approval, one exchange, and expiry', async t => {
  const { fake, provider, registry } = setup(t);
  const bob = fake.addUser('Bob', 'bob-secret');
  fake.state.quickConnect = false;
  assert.equal(await provider.signIn.quickConnect(), false);
  await assert.rejects(provider.signIn.startQuickConnect(), { code: 'JELLYFIN_NO_QUICK_CONNECT' });
  fake.state.quickConnect = true;
  assert.equal(await provider.signIn.quickConnect(), true);
  const started = await provider.signIn.startQuickConnect();
  assert.match(started.code, /^\d{6}$/);
  assert.ok(
    !JSON.stringify(started).includes([...fake.state.pending.keys()][0]),
    'the Jellyfin secret stays server-side',
  );
  assert.equal(await provider.signIn.poll(started.id), false);
  await assert.rejects(provider.signIn.finish(started.id), { code: 'JELLYFIN_NOT_APPROVED' });

  const again = await provider.signIn.startQuickConnect();
  fake.approve(again.code, bob);
  assert.equal(await provider.signIn.poll(again.id), true);
  const identity = await provider.signIn.finish(again.id);
  assert.equal(identity.subject, bob);
  assert.equal(registry.credential(identity.provider, bob).token, identity.token);
  await assert.rejects(provider.signIn.finish(again.id), { code: 'JELLYFIN_EXPIRED' }, 'an attempt works once');
  await assert.rejects(provider.signIn.poll('made-up'), { code: 'JELLYFIN_EXPIRED' });
});

test('Quick Connect attempts expire before Jellyfin forgets them', async t => {
  const fake = fakeJellyfin();
  let clock = 1000;
  const { jellyfinSignIn } = require('../server/sources/jellyfin/sign-in');
  const { jellyfinClient } = require('../server/sources/jellyfin/client');
  const signIn = jellyfinSignIn({
    client: jellyfinClient({ url: fake.base, fetcher: fake.fetch }),
    serverId: async () => fake.state.serverId,
    now: () => clock,
  });
  t.after(() => signIn.close());
  const started = await signIn.startQuickConnect();
  clock += 9 * 60000;
  await assert.rejects(signIn.poll(started.id), { code: 'JELLYFIN_EXPIRED' });
});

test('members: a member, another server, a removed or disabled user, a revoked sign-in, and an outage', async t => {
  const { fake, provider, registry } = setup(t);
  const alice = fake.addUser('Alice', 'alice-secret');
  const identity = await provider.signIn.password('alice', 'alice-secret');
  const own = { provider: identity.provider, subject: alice };
  assert.equal(await provider.members(own), true);
  assert.equal(
    await provider.members({ provider: own.provider, subject: alice.toUpperCase() }),
    true,
    'ids in any case',
  );
  await assert.rejects(provider.members({ provider: 'jellyfin:' + 'e'.repeat(32), subject: alice }), {
    noServerAccess: true,
  });
  await assert.rejects(provider.members({ provider: 'plex', subject: alice }), { noServerAccess: true });

  fake.state.tokens.clear();
  const revoked = await provider.members(own).catch(error => error);
  assert.equal(revoked.revoked, true);
  assert.notEqual(revoked.noServerAccess, true);

  const carol = fake.addUser('Carol', 'carol-secret');
  const carolIdentity = { provider: own.provider, subject: carol };
  assert.equal(await provider.members(carolIdentity), true, 'membership needs no stored token');
  fake.state.users.get(carol).Policy.IsDisabled = true;
  await assert.rejects(provider.members(carolIdentity), { noServerAccess: true });
  fake.state.users.delete(carol);
  await assert.rejects(provider.members(carolIdentity), { noServerAccess: true });

  fake.state.down = true;
  const outage = await provider.members(carolIdentity).catch(error => error);
  assert.ok(outage instanceof Error);
  assert.equal(!!outage.noServerAccess || !!outage.revoked, false, 'no answer is never a denial');
  assert.ok(registry);
});

async function reportingFixture(t, { watchState = true } = {}) {
  const f = setup(t);
  const alice = f.fake.addUser('Alice', 'alice-secret');
  const identity = await f.provider.signIn.password('alice', 'alice-secret');
  await f.provider.identity();
  const account = f.registry.resolve(identity.provider, identity.subject, identity.name);
  const reporting = f.provider.reporting({});
  t.after(() => reporting.close());
  const viewer = {
    userId: account.id,
    viewerId: 'viewer',
    streamVersion: 's',
    observationEpoch: 'e',
    plexWatchState: watchState,
  };
  const room = { media: { kind: 'jellyfin', id: ITEM + ':source-1', duration: 120 }, mediaVersion: 'm' };
  const observe = (state, position) =>
    reporting.observe(room, viewer, 'viewer', { state, position }, { credit: { reason: 'credited' } });
  const settle = () => reporting.sessions.get('viewer')?.dispatched;
  return { ...f, alice, identity, reporting, viewer, room, observe, settle };
}

test('Jellyfin watch-state sync reports start, progress, stop and played with the viewer’s own token only', async t => {
  const f = await reportingFixture(t);
  assert.equal(f.reporting.isEligible(f.viewer.userId), true);
  await f.observe('playing', 1);
  await f.settle();
  await f.observe('playing', 20);
  await f.settle();
  await f.observe('paused', 21);
  await f.settle();
  await f.observe('ended', 120);
  await f.reporting.close();
  assert.deepEqual(
    f.fake.state.reports.map(report => report.path),
    [
      'Sessions/Playing',
      'Sessions/Playing/Progress',
      'Sessions/Playing/Progress',
      'Sessions/Playing/Stopped',
      'UserPlayedItems/' + ITEM,
    ],
  );
  const [start, progress, paused, stopped] = f.fake.state.reports.map(report => report.body);
  assert.equal(start.ItemId, ITEM);
  assert.equal(start.MediaSourceId, 'source-1');
  assert.equal(start.PositionTicks, 10000000);
  assert.equal(progress.PositionTicks, 200000000);
  assert.equal(paused.IsPaused, true);
  assert.equal(stopped.PositionTicks, 1200000000);
  assert.equal(new Set(f.fake.state.reports.map(report => report.body?.PlaySessionId).filter(Boolean)).size, 1);
  for (const report of f.fake.state.reports) {
    assert.equal(report.token, f.identity.token);
    assert.equal(report.userId, f.alice);
  }
  assert.ok(!f.fake.state.calls.some(call => call.path.startsWith('Sessions') && call.token === f.fake.state.apiKey));
});

test('without the opt-in, or without a personal sign-in, nothing reaches Jellyfin', async t => {
  const f = await reportingFixture(t, { watchState: false });
  await f.observe('playing', 1);
  await f.settle();
  await f.observe('ended', 120);
  await f.reporting.close();
  assert.deepEqual(f.fake.state.reports, []);

  const g = await reportingFixture(t);
  g.registry.db.prepare('DELETE FROM credentials').run();
  g.registry.credentialCache.clear();
  assert.equal(g.reporting.isEligible(g.viewer.userId), false);
  await g.observe('playing', 1);
  await g.settle();
  await g.reporting.close();
  assert.deepEqual(g.fake.state.reports, []);
});

test('a revoked Jellyfin sign-in ends the reporting occurrence', async t => {
  const f = await reportingFixture(t);
  await f.observe('playing', 1);
  await f.settle();
  f.fake.state.tokens.clear();
  await f.observe('playing', 20);
  await f.settle();
  assert.equal(f.reporting.sessions.has('viewer'), false);
  assert.equal(f.fake.state.reports.length, 1);
});

test('connect: discovery answers, public info, administrator-only API key, then the admin token is signed out', async t => {
  // A stand-in for Jellyfin's discovery responder, on loopback instead of broadcast.
  const responder = dgram.createSocket('udp4');
  t.after(() => responder.close());
  responder.on('message', (message, from) => {
    if (!/who is JellyfinServer\?/i.test(message.toString())) return;
    for (const answer of [
      { Address: 'http://192.168.1.10:8096', Id: 'F'.repeat(32), Name: 'Den' },
      { Address: 'http://192.168.1.10:8096', Id: 'f'.repeat(32), Name: 'Den again' },
      { Address: 'not an address', Id: 'b'.repeat(32), Name: 'Broken' },
    ])
      responder.send(JSON.stringify(answer), from.port, from.address);
    responder.send('not json', from.port, from.address);
  });
  await new Promise(resolve => responder.bind(0, '127.0.0.1', resolve));
  const found = await connect.discover({ address: '127.0.0.1', port: responder.address().port, timeoutMs: 400 });
  assert.deepEqual(found, [{ id: 'f'.repeat(32), name: 'Den', address: 'http://192.168.1.10:8096' }]);

  const fake = fakeJellyfin({ base: 'http://jellyfin.invalid:8096/media' });
  const admin = fake.addUser('Admin', 'admin-secret', { admin: true });
  fake.addUser('Viewer', 'viewer-secret');
  const info = await connect.publicInfo(fake.base + '/', { fetcher: fake.fetch });
  assert.deepEqual(info, {
    url: 'http://jellyfin.invalid:8096/media',
    id: fake.state.serverId,
    name: 'Fixture Jellyfin',
    version: '12.4.0',
    setupComplete: true,
  });
  await assert.rejects(connect.publicInfo('http://elsewhere.invalid', { fetcher: fake.fetch }), {
    code: 'JELLYFIN_UNREACHABLE',
  });

  const signIn = connect.adminSignIn(info.url, info.id, { fetcher: fake.fetch });
  await assert.rejects(signIn.password('viewer', 'viewer-secret'), { code: 'JELLYFIN_NOT_ADMIN' });
  const session = await signIn.password('admin', 'admin-secret');
  assert.equal(session.subject, admin);
  const { deviceId } = require('../server/sources/jellyfin/client');
  const setupDevice = fake.state.calls.find(call => call.path === 'Users/AuthenticateByName').device;
  assert.ok(
    setupDevice && setupDevice !== deviceId(new URL(info.url + '/').href),
    'setup never ends a person’s own Jellyfin session',
  );
  const key = await connect.createApiKey(info.url, session.token, { fetcher: fake.fetch });
  assert.equal(key, fake.state.keys[0].AccessToken);
  assert.equal(fake.state.tokens.has(session.token), false, "the administrator's token is signed out");
  fake.state.apiKey = key;
  assert.deepEqual(
    (await connect.listUsers(info.url, key, { fetcher: fake.fetch })).map(user => [user.name, user.administrator]),
    [
      ['Admin', true],
      ['Viewer', false],
    ],
  );
  const viewerToken = fake.issue([...fake.state.users.values()].find(user => user.Name === 'Viewer').Id);
  await assert.rejects(connect.createApiKey(info.url, viewerToken, { fetcher: fake.fetch }), {
    code: 'JELLYFIN_NOT_ADMIN',
  });
});

test('a Jellyfin source can turn watch-state sync off for everyone', async t => {
  const { validate } = require('../server/sources/jellyfin');
  const entry = { url: 'http://jellyfin.invalid:8096', api_key: 'fixture-api-key', user: 'Library' };
  assert.equal(validate(entry, { id: 'j' }).reporting.watchState, true);
  assert.equal(validate({ ...entry, reporting_watch_state: false }, { id: 'j' }).reporting.watchState, false);
  assert.throws(() => validate({ ...entry, reporting_watch_state: 'no' }, { id: 'j' }), /true or false/);
  const f = await reportingFixture(t);
  f.reporting.settings.watchState = false;
  assert.equal(f.reporting.isEligible(f.viewer.userId), false);
  assert.equal(f.reporting.watchStateAllowed(f.room.media), false);
});
