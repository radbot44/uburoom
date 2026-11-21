'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { normalizeConfig } = require('../server/config');
const { fixture } = require('./helpers/account-app');
const { fakeJellyfin } = require('./helpers/fake-jellyfin');

const route = '/api/account/jellyfin';
const binding = 'uburoom_jellyfin';
const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };

async function setup(t) {
  const selected = fakeJellyfin({ base: 'http://jellyfin.invalid:8096/services/film' });
  const other = fakeJellyfin({ base: 'http://other.invalid:8096/jf', serverId: 'e'.repeat(32) });
  const unlisted = fakeJellyfin({ base: 'http://unlisted.invalid:8096/media', serverId: 'd'.repeat(32) });
  const byId = { cabin: selected, other, unlisted };
  for (const fake of Object.values(byId)) fake.addUser('Library', 'fixture-library-secret');
  const config = normalizeConfig({
    sources: Object.entries(byId).map(([id, fake]) => ({
      id,
      type: 'jellyfin',
      name: id === 'cabin' ? 'Cabin' : id,
      url: fake.base,
      api_key: fake.state.apiKey,
      user: 'Library',
    })),
    access: { discord_server: false, source_members: ['cabin', 'other'] },
  });
  const f = await fixture(
    t,
    undefined,
    { accessPolicy: config.accessPolicy, sources: config.sources },
    {
      jellyfinFetch: (input, options) => {
        const fake = Object.values(byId).find(item => new URL(input).origin === new URL(item.base).origin);
        assert.ok(fake, 'request uses a configured fixture origin');
        assert.ok(new URL(input).href.startsWith(fake.base + '/'), 'request preserves the configured base path');
        if (new URL(input).pathname === new URL(fake.base).pathname + '/UserViews') {
          const authorization = new Headers(options.headers).get('authorization');
          assert.ok(authorization.includes('Token="' + fake.state.apiKey + '"'));
          return Response.json({
            Items: [
              {
                Id: 'a'.repeat(32),
                Name: 'Fixture library at ' + new URL(fake.base).hostname,
                CollectionType: 'movies',
              },
            ],
          });
        }
        return fake.fetch(input, options);
      },
    },
  );
  return { ...f, selected, other, unlisted };
}

test('Jellyfin Quick Connect uses the selected member source and a single-use browser cookie', tls, async t => {
  const f = await setup(t);
  const alice = f.selected.addUser('Alice', 'alice-secret');
  const browser = f.browser();
  const outsider = f.browser();
  const start = { source: 'cabin', action: 'start' };
  const poll = { source: 'cabin', action: 'poll' };
  const config = (await browser.request('/api/watch/config')).body.access;
  assert.deepEqual(config.jellyfin, [
    { id: 'cabin', name: 'Cabin' },
    { id: 'other', name: 'other' },
  ]);
  assert.equal((await browser.request(route, { ...start, source: 'unlisted' })).status, 404);
  assert.equal(f.unlisted.state.calls.length, 0);
  assert.equal((await browser.request(route, start, { Origin: 'https://cross-origin.invalid' })).status, 403);
  assert.equal((await browser.request(route, start, { Authorization: 'Bearer fixture-activity' })).status, 403);
  const initiated = await browser.request(route, start);
  assert.equal(initiated.status, 200);
  assert.deepEqual(Object.keys(initiated.body).sort(), ['code']);
  assert.match(initiated.headers['set-cookie'][0], /HttpOnly; Secure; SameSite=Lax/);
  const handle = browser.jar.get(binding);
  assert.ok(handle);
  assert.deepEqual((await browser.request(route, poll)).body, { pending: true });
  f.selected.approve(initiated.body.code, alice);
  assert.equal((await outsider.request(route, { ...poll, id: handle })).status, 400);
  assert.equal((await browser.request(route, { ...poll, source: 'other' })).status, 400);
  assert.deepEqual((await browser.request(route, poll)).body, { ok: true });
  const me = await browser.request('/api/watch/me');
  assert.equal(me.status, 200);
  const provider = 'jellyfin:' + f.selected.state.serverId;
  assert.equal(f.app.registry.identity(provider, alice).userId, me.body.account.id);
  const calls = f.selected.state.calls;
  assert.ok(calls.some(call => call.path === 'Users/' + alice && call.token === f.selected.state.apiKey));
  const token = f.app.registry.credential(provider, alice).token;
  assert.notEqual(token, f.selected.state.apiKey);
  assert.ok(calls.some(call => call.path === 'Users/Me' && call.token === token));
  assert.equal(JSON.stringify(me.body).includes(token), false);
  assert.equal((await outsider.request(route, poll, { Cookie: binding + '=' + handle })).status, 400);
  assert.equal((await outsider.request('/api/watch/me')).status, 401);
  const catalog = await browser.request('/api/watch/library?server=' + f.unlisted.state.serverId);
  assert.equal(catalog.status, 200);
  assert.match(JSON.stringify(catalog.body), /Fixture library at unlisted.invalid/);
});

test('Jellyfin password fallback preserves the UUID and denies unqualified or revoked users', tls, async t => {
  const f = await setup(t);
  const alice = f.selected.addUser('Alice', 'alice-secret');
  f.selected.addUser('Disabled', 'disabled-secret', { disabled: true });
  f.unlisted.addUser('Unlisted', 'unlisted-secret');
  const browser = f.browser();
  const login = (username, password, b = browser) =>
    b.request(route, { source: 'cabin', action: 'password', username, password });
  const provider = 'jellyfin:' + f.selected.state.serverId;
  const preexisting = f.app.registry.resolve(provider, alice, 'Previously known');
  assert.equal((await login('Alice', 'alice-secret')).status, 409, 'Quick Connect is preferred');
  f.selected.state.quickConnect = false;
  const start = await browser.request(route, { source: 'cabin', action: 'start' });
  assert.deepEqual(start.body, { password: true });
  assert.equal((await login('Alice', 'wrong')).status, 401);
  assert.equal((await login('Disabled', 'disabled-secret')).status, 401);
  assert.equal((await login('Unlisted', 'unlisted-secret')).status, 401);
  assert.equal((await browser.request('/api/watch/me')).status, 401);
  assert.equal(f.unlisted.state.calls.length, 0);
  const signedIn = await login('Alice', 'alice-secret');
  assert.deepEqual(signedIn.body, { ok: true });
  assert.equal((await browser.request('/api/watch/me')).body.account.id, preexisting.id);
  assert.equal(f.app.registry.credential(provider, alice).password, undefined);
  const lost = f.selected.addUser('Lost viewer', 'lost-secret');
  const fetch = f.selected.fetch;
  f.selected.fetch = (input, options) =>
    new URL(input).pathname.endsWith('/Users/' + lost)
      ? Promise.resolve(new Response(null, { status: 404 }))
      : fetch(input, options);
  const refused = f.browser();
  assert.equal((await login('Lost viewer', 'lost-secret', refused)).status, 403);
  assert.equal((await refused.request('/api/watch/me')).status, 401);
  await f.app.watch.providers.list.find(source => source.id === 'other').identity();
  f.other.state.down = true;
  f.selected.state.tokens.clear();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301000);
  assert.equal((await browser.request('/api/watch/me')).status, 401, 'an unrelated outage cannot mask revocation');
  assert.equal((await browser.request('/api/watch/library')).status, 401);
});

test('a verified Jellyfin identity from a source outside the entry rule does not qualify', tls, async t => {
  const f = await setup(t);
  const id = f.unlisted.addUser('Viewer', 'fixture-secret');
  const source = f.app.watch.providers.list.find(source => source.id === 'unlisted');
  const signIn = await source.signIn.password('Viewer', 'fixture-secret');
  const account = f.app.registry.resolve(signIn.provider, id, signIn.name);
  assert.equal(await f.app.access.refreshWatch(account.id), false);
});
