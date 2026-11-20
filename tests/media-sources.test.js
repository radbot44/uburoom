'use strict';
// Any number of sources (phase 2 of docs/media-sources-plan.md): every source is equal, media is
// routed by the server identity it is recorded under, and a source that is gone leaves its media
// unavailable rather than deleted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./helpers/account-app');
const { validateSources } = require('../server/sources');
const { MediaProviders } = require('../server/media-providers');

const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };
const JELLYFIN_SERVER = 'f'.repeat(32);

/** A Jellyfin server with one user and one film library. */
async function jellyfinFetch(input, options = {}) {
  const url = new URL(input);
  if (!/Token="fixture-jellyfin-key"/.test(new Headers(options.headers).get('authorization') || ''))
    return new Response('{}', { status: 401 });
  if (url.pathname === '/System/Info/Public')
    return Response.json({ Id: JELLYFIN_SERVER, ServerName: 'Fixture Jellyfin' });
  if (url.pathname === '/Users') return Response.json([{ Id: 'a'.repeat(32), Name: 'Viewer' }]);
  if (url.pathname === '/UserViews')
    return Response.json({ Items: [{ Id: 'c'.repeat(32), Name: 'Jellyfin Films', CollectionType: 'movies' }] });
  return Response.json({ Items: [], TotalRecordCount: 0 });
}

/**
 * Plex server A is the account fixture's own (`fixture-machine`). Plex server B answers at another
 * address with machine id `machine-b`; on plex.tv only Bob (102) can reach it, and Alice (101) only A.
 */
function twoPlexFetch(input, options, provider, { sameMachine = false } = {}) {
  const url = new URL(input),
    token = options.headers?.['X-Plex-Token'];
  if (url.hostname === 'plex-b.invalid' && url.pathname === '/')
    return Response.json({
      MediaContainer: { machineIdentifier: sameMachine ? 'fixture-machine' : 'machine-b', friendlyName: 'Cabin Plex' },
    });
  if (url.hostname === 'plex-b.invalid' && url.pathname === '/library/sections' && token === 'fixture-owner-b')
    return Response.json({ MediaContainer: { Directory: [{ key: '7', type: 'movie', title: 'Cabin Movies' }] } });
  if (url.hostname === 'clients.plex.tv' && url.pathname === '/api/v2/resources' && token === 'fixture-user-102')
    return Response.json([{ clientIdentifier: 'machine-b', provides: 'server', accessToken: 'fixture-server-102' }]);
  if (token === 'fixture-owner-b')
    return provider.fetch(input, { ...options, headers: { ...options.headers, 'X-Plex-Token': 'fixture-owner' } });
  return provider.fetch(input, options);
}

async function sources(t, list, { sameMachine = false, disk = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-sources-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const name of ['films', 'tv']) {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, name + ' (2020).mp4'), '');
  }
  const all = {
    a: { id: 'living-room', type: 'plex', url: 'http://plex-fixture.invalid:32400', token: 'fixture-owner' },
    b: { id: 'cabin', type: 'plex', name: 'The Cabin', url: 'http://plex-b.invalid:32400', token: 'fixture-owner-b' },
    jf: {
      id: 'jf',
      type: 'jellyfin',
      url: 'http://jellyfin.invalid:8096',
      api_key: 'fixture-jellyfin-key',
      user: 'Viewer',
    },
    films: {
      id: 'films',
      type: 'folders',
      name: 'Film Folder',
      libraries: [{ id: 'films', name: 'Films', paths: ['films'] }],
    },
    tv: { id: 'tv', type: 'folders', libraries: [{ id: 'tv', name: 'TV', type: 'shows', paths: ['tv'] }] },
  };
  const f = await fixture(
    t,
    (input, options, provider) => twoPlexFetch(input, options, provider, { sameMachine }),
    {
      accessPolicy: { discord: true, plex: true, password: '', publicWeb: true },
      ...disk,
      sources: validateSources(
        list.map(key => all[key]),
        { base: dir, platform: process.platform, dataDirectory: path.join(dir, 'data') },
      ),
    },
    { jellyfinFetch },
  );
  return f;
}

test(
  'two Plex servers, a Jellyfin server and two folder sources list together, each named and routed by identity',
  tls,
  async t => {
    const f = await sources(t, ['a', 'b', 'jf', 'films', 'tv']);
    const viewer = f.browser();
    await viewer.discord('guest');
    const userId = (await viewer.request('/api/watch/me')).body.account.id;
    const home = await viewer.request('/api/watch/library');
    assert.equal(home.status, 200);
    const cards = home.body.items.map(item => [item.title, item.sourceId, item.serverId, item.serverName || '']);
    assert.deepEqual(cards, [
      ['Fixture Movies', 'living-room', 'fixture-machine', 'Fixture Plex'],
      ['Cabin Movies', 'cabin', 'machine-b', 'The Cabin'],
      ['Jellyfin Films', 'jf', JELLYFIN_SERVER, 'Fixture Jellyfin'],
      ['Films', 'films', 'folders:films', 'Film Folder'],
      ['TV', 'tv', 'folders:tv', ''],
    ]);
    // Each server id reaches its own source, never another of the same type.
    const providers = f.app.watch.providers;
    for (const [serverId, id] of [
      ['fixture-machine', 'living-room'],
      ['machine-b', 'cabin'],
      [JELLYFIN_SERVER, 'jf'],
      ['folders:films', 'films'],
      ['folders:tv', 'tv'],
    ]) {
      const provider = await providers.select(serverId);
      assert.equal(provider.id, id);
      assert.equal(await f.app.hub.mediaFor({ userId }, serverId), await provider.scopeFor({ userId }));
    }
    assert.notEqual(
      await providers.select('fixture-machine').then(p => p.root),
      await providers.select('machine-b').then(p => p.root),
    );
    // The page learns each source's id, name, type and availability, and nothing else.
    const config = (await viewer.request('/api/watch/config')).body;
    assert.deepEqual(
      config.sources.map(source => [source.id, source.type, source.available]),
      [
        ['living-room', 'plex', true],
        ['cabin', 'plex', true],
        ['jf', 'jellyfin', true],
        ['films', 'folders', true],
        ['tv', 'folders', true],
      ],
    );
    assert.equal(config.sources[1].name, 'The Cabin');
    const text = JSON.stringify(config) + JSON.stringify(home.body);
    for (const secret of ['fixture-owner', 'fixture-jellyfin-key', 'plex-b.invalid', 'jellyfin.invalid', os.tmpdir()])
      assert.equal(text.includes(secret), false, secret + ' never reaches a browser');
    // Each source pins its own server identity under its own id.
    assert.equal(f.app.registry.meta('source:living-room:identity'), 'fixture-machine');
    assert.equal(f.app.registry.meta('source:cabin:identity'), 'machine-b');
    assert.equal(f.app.registry.meta('source:jf:identity'), JELLYFIN_SERVER);
    assert.equal(f.app.registry.meta('plexMachineIdentifier'), undefined, 'no global Plex pin');
  },
);

test('a server id with no configured source is unavailable, not deleted, and comes back when its source returns', async () => {
  const cabin = {
    id: 'cabin',
    type: 'plex',
    kind: 'plex',
    root: { configured: true },
    identity: async () => 'machine-b',
  };
  const films = {
    id: 'films',
    type: 'folders',
    kind: 'local',
    root: { configured: true },
    identity: async () => 'folders:films',
  };
  const without = new MediaProviders([films]);
  assert.equal(await without.available('machine-b'), false);
  assert.equal(await without.recorded({ serverId: 'machine-b', mediaId: '1' }), false);
  await assert.rejects(without.select('machine-b'), error => error.unavailable === true && error.status === 409);
  assert.equal((await without.select('folders:films')).id, 'films', 'the other sources are unaffected');
  // Adding the same server back, under any source id, restores what was recorded under it.
  const back = new MediaProviders([films, { ...cabin, id: 'cabin-again' }]);
  assert.equal(await back.available('machine-b'), true);
  assert.equal((await back.select('machine-b')).id, 'cabin-again');
});

test('a removed source leaves its queue entries in place, unavailable, until it is configured again', tls, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-removed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const disk = { accountFile: path.join(dir, 'accounts.sqlite'), credentialKeyFile: path.join(dir, 'original.key') };
  const run = async list => {
    const f = await sources(t, list, { disk });
    const actor = { userId: f.app.registry.resolve('discord', f.provider.subjects.host, 'Host').id, name: 'Host' };
    return { f, actor };
  };
  // Record an entry under Plex server B in a durable room.
  let { f, actor } = await run(['a', 'b']);
  const roomId = await f.app.watch.roomState.create(actor, { keepEmpty: true });
  await f.app.watch.roomState.queue.add(roomId, actor.userId, {
    mediaId: '7',
    serverId: 'machine-b',
    type: 'movie',
    title: 'Cabin film',
    duration: 120,
  });
  await f.app.close();
  // Restarted without Cabin: the entry is still there, and its server is unavailable.
  ({ f } = await run(['a']));
  assert.deepEqual(
    f.app.watch.roomState.queue.pending(roomId).map(entry => [entry.mediaId, entry.serverId]),
    [['7', 'machine-b']],
    'removing a source deletes nothing',
  );
  await assert.rejects(f.app.watch.providers.select('machine-b'), { unavailable: true });
  await f.app.close();
  // Cabin back, under a new source id: the same server, so the same entry plays again.
  ({ f } = await run(['a', 'b']));
  assert.equal(f.app.watch.roomState.queue.pending(roomId)[0].serverId, 'machine-b');
  assert.equal((await f.app.watch.providers.select('machine-b')).id, 'cabin');
  await f.app.close();
});

test('two sources that report the same server are refused rather than guessed between', tls, async t => {
  const f = await sources(t, ['a', 'b'], { sameMachine: true });
  await assert.rejects(f.app.watch.providers.verify(), /living-room and cabin report the same server/);
  await assert.rejects(f.app.watch.providers.select('fixture-machine'), error => error.status === 503);
});

test('until entry rules exist, a Plex sign-in admits whoever can reach any configured Plex source', tls, async t => {
  // Bob (102) can reach only Plex server B; Alice (101) only A.
  const both = await sources(t, ['a', 'b']);
  for (const persona of ['alice', 'bob']) {
    const browser = both.browser();
    assert.equal((await browser.plex(persona)).status, 302);
    assert.equal((await browser.request('/api/watch/me')).status, 200, persona + ' reaches one of the two servers');
  }
  const onlyA = await sources(t, ['a']);
  const bob = onlyA.browser();
  assert.equal((await bob.plex('bob')).headers.location, '/auth/error', 'membership of B does not admit through A');
  assert.equal((await bob.request('/api/watch/me')).status, 401);
  // With no Plex source at all, a Plex sign-in still proves who someone is, but admits nobody.
  const none = await sources(t, ['jf']);
  const alice = none.browser();
  assert.equal((await alice.plex('alice')).status, 302);
  assert.equal((await alice.request('/api/watch/admission')).body.identity, true);
  assert.equal((await alice.request('/api/watch/me')).status, 401);
  assert.equal((await alice.request('/api/watch/config')).body.plexSignIn, false);
  assert.equal((await both.browser().request('/api/watch/config')).body.plexSignIn, true);
});
