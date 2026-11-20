'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Plex } = require('../server/sources/plex/plex');
const { plexProvider } = require('../server/sources/plex/provider');
const { MediaProviders } = require('../server/media-providers');

test("Continue watching is only ever a viewer's own Plex progress, never the shared account's", async () => {
  const own = [{ id: '1', title: 'Mine', viewOffset: 120 }],
    shared = [{ id: '2', title: 'Shared account', viewOffset: 60 }];
  const registry = {
    identities: userId => (userId === 'signed-in' ? [{ provider: 'plex', verified: true, subject: 'plex-1' }] : []),
    hasCredential: () => true,
  };
  const plexAuth = {
    forUser: async () => ({ continueWatching: async () => own }),
    fallback: () => ({ continueWatching: async () => shared }),
  };
  const provider = plexProvider({ plex: { configured: true }, registry, plexAuth });
  assert.deepEqual(await provider.continueWatching({ userId: 'signed-in' }), own);
  assert.deepEqual(
    await provider.continueWatching({ userId: 'no-plex' }),
    [],
    'a viewer on the shared fallback sees no Continue watching',
  );
  const noPeople = plexProvider({ plex: { configured: true, continueWatching: async () => shared } });
  assert.deepEqual(await noPeople.continueWatching({ userId: 'anyone' }), [], "one configured token is nobody's own");
});

test('Media Home rows merge every server, newest additions first, each item naming its server', async () => {
  const entry = (serverId, { recent = [], resume, fails } = {}) => ({
    kind: serverId,
    root: { configured: true },
    identity: async () => serverId,
    scopeFor: async () => {
      if (fails) throw new Error('offline');
      return { recentlyAdded: async () => recent };
    },
    ...(resume ? { continueWatching: async () => resume } : {}),
  });
  const providers = new MediaProviders([
    entry('plex-a', {
      recent: [
        { id: 'p1', addedAt: 10 },
        { id: 'p2', addedAt: 30 },
      ],
      resume: [{ id: 'p9' }],
    }),
    entry('jellyfin-b', { recent: [{ id: 'j1', addedAt: 20 }] }),
    entry('plex-c', { fails: true }),
  ]);
  const rows = await providers.shelves({ userId: 'viewer' });
  assert.deepEqual(
    rows.recentlyAdded.map(item => [item.id, item.serverId]),
    [
      ['p2', 'plex-a'],
      ['j1', 'jellyfin-b'],
      ['p1', 'plex-a'],
    ],
  );
  assert.deepEqual(rows.continueWatching, [{ id: 'p9', serverId: 'plex-a' }], 'only providers that know your progress');
});

test('the Plex catalog reads On Deck and recent additions twenty at a time, keeping progress', async t => {
  const requests = [];
  const episode = {
    ratingKey: '7',
    type: 'episode',
    title: 'Halfway',
    index: 4,
    parentIndex: 2,
    grandparentTitle: 'Show',
    duration: 1800000,
    viewOffset: 900000,
  };
  const plex = new Plex({ plexUrl: 'http://127.0.0.1:32400', plexToken: 'fixture-private-token' }, url => {
    requests.push(url.pathname + '?' + url.searchParams.get('X-Plex-Container-Size'));
    return new Response(JSON.stringify({ MediaContainer: { Metadata: [episode] } }));
  });
  t.after(() => plex.close());
  const [resume] = await plex.continueWatching();
  assert.equal(resume.title, 'Halfway');
  assert.equal(resume.viewOffset, 900);
  await plex.recentlyAdded();
  assert.deepEqual(requests, ['/library/onDeck?20', '/library/recentlyAdded?20']);
});

test("a room's Continue watching lists what it left unfinished, newest first, through the viewer's own access", async () => {
  const { roomContinue } = require('../server/watch-operations');
  const row = (mediaId, position, duration, outcome = 'stopped', serverId = 'plex') => ({
    serverId,
    mediaId,
    position,
    duration,
    outcome,
  });
  const rows = [
    row('1', 600, 6000), // newest: unfinished
    row('2', 5, 6000), // barely started
    row('3', 5900, 6000), // past 92%: finished in all but name
    row('4', 3000, 6000, 'completed'),
    row('1', 100, 6000), // an older stop of the same film
    row('5', 1200, 6000), // hidden from this viewer
    row('6', 300, 2400, 'stopped', 'local-media'),
  ];
  const items = await roomContinue(rows, async serverId => ({
    playableItem: async id => {
      if (id === '5') throw Object.assign(new Error('Not yours'), { status: 403 });
      return { id, title: 'Item ' + id, server: serverId };
    },
  }));
  assert.deepEqual(
    items.map(item => [item.id, item.serverId, item.viewOffset]),
    [
      ['1', 'plex', 600],
      ['6', 'local-media', 300],
    ],
  );
});
