'use strict';
// A source's `libraries:` list (docs/media-sources.md): absent offers every library on the server,
// present offers only those named, so a library the server gains later stays off. Media in a library
// that is off is unreachable through every path, and refused as unavailable rather than denied.
const test = require('node:test');
const assert = require('node:assert/strict');
const { Plex } = require('../server/sources/plex/plex');
const { Jellyfin } = require('../server/sources/jellyfin/provider');
const { validateSources, sourceType } = require('../server/sources');

const json = body => new Response(JSON.stringify({ MediaContainer: body }));
const media = [{ id: 1, Part: [{ key: '/library/parts/1/0/file.mp4' }] }];

/** A Plex server with Movies (1), Shows (2) and Home Videos (3); `extra` adds sections later. */
function plexServer(extra = []) {
  const sections = [
    { key: '1', type: 'movie', title: 'Movies' },
    { key: '2', type: 'show', title: 'Shows' },
    { key: '3', type: 'movie', title: 'Home Videos' },
    ...extra,
  ];
  const items = {
    10: { ratingKey: '10', type: 'movie', title: 'Feature', librarySectionID: 1, addedAt: 100, Media: media },
    20: { ratingKey: '20', type: 'show', title: 'Series', librarySectionID: 2, addedAt: 90 },
    30: { ratingKey: '30', type: 'movie', title: 'Birthday', librarySectionID: 3, addedAt: 200, Media: media },
    40: { ratingKey: '40', type: 'movie', title: 'New Thing', librarySectionID: 4, addedAt: 300, Media: media },
  };
  for (let i = 0; i < extra.extraSectionItems; i++) {
    const rk = String(300 + i);
    items[rk] = {
      ratingKey: rk,
      type: 'movie',
      title: 'Off Section ' + rk,
      librarySectionID: 3,
      addedAt: 500 + i,
      Media: media,
    };
  }
  const requests = [];
  const fetcher = async url => {
    const p = url.pathname;
    requests.push(p);
    if (p === '/library/sections') return json({ Directory: sections });
    const section = /^\/library\/sections\/(\d+)\/(all|collections|genre|year|recentlyAdded|onDeck)$/.exec(p);
    if (section) {
      const rows = Object.values(items).filter(item => String(item.librarySectionID) === section[1]);
      return json({
        Metadata: ['all', 'recentlyAdded', 'onDeck'].includes(section[2]) ? rows : [],
        totalSize: rows.length,
        size: 0,
      });
    }
    if (p === '/library/recentlyAdded' || p === '/library/onDeck') return json({ Metadata: Object.values(items) });
    const one = /^\/library\/metadata\/([\d,]+)$/.exec(p);
    if (one) {
      const rows = one[1].split(',').flatMap(id => (items[id] ? [items[id]] : []));
      // Plex names the library on the answer for one item, as well as on the item.
      return json({ Metadata: rows, ...(rows.length === 1 ? { librarySectionID: rows[0].librarySectionID } : {}) });
    }
    if (p === '/library/metadata/20/children')
      return json({
        librarySectionID: 2,
        Metadata: [{ ratingKey: '21', type: 'season', title: 'Season 1', index: 1, parentRatingKey: '20' }],
      });
    return new Response('{}', { status: 404 });
  };
  return { fetcher, requests };
}
const plexEntry = libraries =>
  validateSources([
    {
      id: 'living-room',
      type: 'plex',
      url: 'http://plex.invalid:32400',
      token: 'fixture-token',
      ...(libraries ? { libraries } : {}),
    },
  ])[0];
const plexWith = (libraries, extra) => {
  const server = plexServer(extra);
  const plex = new Plex(plexEntry(libraries), server.fetcher, { pipeline: {} });
  return { plex, server };
};
const offOrUnavailable = error => error.libraryOff === true && error.unavailable === true && error.status === 409;

test('a Plex source with a library list offers only those libraries, everywhere its media is reachable', async () => {
  const { plex } = plexWith(['1', '2']);
  const home = await plex.browse({});
  assert.deepEqual(
    home.items.map(item => item.title),
    ['Movies', 'Shows'],
  );
  assert.deepEqual(
    (await plex.browse({ section: '1' })).items.map(item => item.id),
    ['10'],
  );
  // The library itself, its search and its filters are refused as unavailable.
  await assert.rejects(plex.browse({ section: '3' }), offOrUnavailable);
  await assert.rejects(plex.browse({ section: '3', q: 'Birth' }), offOrUnavailable);
  await assert.rejects(plex.filters('3'), offOrUnavailable);
  await assert.rejects(plex.queueItems({ type: 'library', id: '3' }), offOrUnavailable);
  // Its items: details, artwork, playback and the access gates.
  await assert.rejects(plex.details('30'), offOrUnavailable);
  await assert.rejects(plex.artwork('30', 'poster'), offOrUnavailable);
  await assert.rejects(plex.playableItem('30'), offOrUnavailable);
  assert.equal(await plex.allows('30'), false);
  assert.equal(await plex.visible('30', 'movie'), false);
  assert.equal(await plex.allows('10'), true);
  assert.equal((await plex.playableItem('10')).id, '10');
  // Shelves and availability leave it out.
  assert.deepEqual(
    (await plex.recentlyAdded()).map(item => item.id),
    ['10', '20'],
  );
  assert.deepEqual(
    (await plex.continueWatching()).map(item => item.id),
    ['10', '20'],
  );
  const available = await plex.availability(['10', '30']);
  assert.equal(available.get('10'), true);
  assert.equal(available.get('30'), false);
  // An offered show's seasons still browse; their answer names the show's library.
  assert.equal((await plex.browse({ parent: '20' })).items.length, 1);
  // Every scope of the source, such as the dedicated delivery account's, sees the same libraries.
  await assert.rejects(plex.scope('other-token', 'dedicated').details('30'), offOrUnavailable);
  // Shelves query offered sections directly so >20 newer un-offered items cannot starve offered sections.
  const crowded = plexWith(['1', '2'], Object.assign([], { extraSectionItems: 25 })).plex;
  assert.deepEqual(
    (await crowded.recentlyAdded()).map(item => item.id),
    ['10', '20'],
  );
  assert.deepEqual(
    (await crowded.continueWatching()).map(item => item.id),
    ['10', '20'],
  );
});

test('a library added to the server later is off while a list exists, and offered when there is none', async () => {
  const later = [{ key: '4', type: 'movie', title: 'Added Later' }];
  const listed = plexWith(['1', '2', '3'], later).plex;
  assert.deepEqual(
    (await listed.browse({})).items.map(item => item.id),
    ['1', '2', '3'],
  );
  await assert.rejects(listed.details('40'), offOrUnavailable);
  const all = plexWith(undefined, later).plex;
  assert.deepEqual(
    (await all.browse({})).items.map(item => item.id),
    ['1', '2', '3', '4'],
  );
  assert.equal((await all.details('40')).id, '40');
  assert.equal(await all.allows('30'), true);
});

test('a Plex source lists every library on its server for the operator, with counts', async () => {
  const server = plexServer();
  const listed = await sourceType('plex').libraries(plexEntry(['1']), { plexFetch: server.fetcher });
  assert.deepEqual(listed, [
    { id: '1', name: 'Movies', type: 'movies', count: 1 },
    { id: '2', name: 'Shows', type: 'shows', count: 1 },
    { id: '3', name: 'Home Videos', type: 'movies', count: 1 },
  ]);
});

test('library lists are validated: server ids only, no repeats', () => {
  assert.deepEqual(plexEntry(['1', 2, '1']).libraries, ['1', '2']);
  assert.equal(plexEntry().libraries, null);
  assert.deepEqual(plexEntry([]).libraries, []);
  assert.throws(() => plexEntry(['movies']), /libraries must be a list/);
  assert.throws(() => plexEntry('1'), /libraries must be a list/);
  const jf = libraries =>
    validateSources([
      { id: 'jf', type: 'jellyfin', url: 'http://jf.invalid', api_key: 'key', user: 'Viewer', libraries },
    ])[0];
  assert.deepEqual(jf(['C'.repeat(32)]).libraries, ['c'.repeat(32)]);
  assert.throws(() => jf(['nope']), /libraries must be a list/);
  assert.throws(
    () =>
      validateSources([{ id: 'f', type: 'folders', libraries: [{ id: 'a', name: 'A', paths: ['a'] }], extra: true }]),
    /unknown folders setting/,
  );
});

// Jellyfin: films (f…) and shows (s…) libraries, and a home videos library (h…) the list leaves off.
const FILMS = 'f'.repeat(32),
  SHOWS = 'e'.repeat(32),
  HOME = 'd'.repeat(32),
  LATER = 'c'.repeat(32);
const USER = 'a'.repeat(32);
const id = n => String(n).padStart(32, '0');
function jellyfinServer(views = [FILMS, SHOWS, HOME]) {
  const names = { [FILMS]: 'Films', [SHOWS]: 'Shows', [HOME]: 'Home Videos', [LATER]: 'Added Later' };
  const items = [
    { Id: id(1), Name: 'Feature', Type: 'Movie', library: FILMS, MediaSources: [{ Id: 'a1' }] },
    { Id: id(2), Name: 'Series', Type: 'Series', library: SHOWS },
    { Id: id(3), Name: 'Birthday', Type: 'Movie', library: HOME, MediaSources: [{ Id: 'a3' }] },
  ];
  const ancestors = { [id(1)]: [FILMS], [id(2)]: [SHOWS], [id(3)]: [HOME] };
  const fetcher = async input => {
    const url = new URL(input),
      p = url.pathname,
      q = url.searchParams;
    if (p === '/Users') return Response.json([{ Id: USER, Name: 'Viewer' }]);
    if (p === '/UserViews')
      return Response.json({
        Items: views.map(view => ({
          Id: view,
          Name: names[view],
          CollectionType: view === SHOWS ? 'tvshows' : 'movies',
        })),
      });
    const ancestry = /^\/Items\/([a-f0-9]{32})\/Ancestors$/.exec(p);
    if (ancestry)
      return Response.json([
        ...(ancestors[ancestry[1]] || []).map(view => ({ Id: view })),
        { Id: 'b'.repeat(32), Name: 'root' },
      ]);
    if (p === '/Items/Latest') {
      const parent = q.get('parentId');
      return Response.json(items.filter(item => !parent || item.library === parent));
    }
    if (p === '/Items') {
      const ids = q.get('ids')?.split(','),
        parent = q.get('parentId');
      const found = items.filter(item => (!ids || ids.includes(item.Id)) && (!parent || item.library === parent));
      return Response.json({ Items: found, TotalRecordCount: found.length });
    }
    return Response.json({ Items: [], TotalRecordCount: 0 });
  };
  return fetcher;
}
const jellyfinWith = (libraries, views) =>
  new Jellyfin(
    { url: 'http://jf.invalid', apiKey: 'key', user: 'Viewer', libraries },
    { pipeline: {}, fetcher: jellyfinServer(views) },
  );

test('a Jellyfin source with a library list offers only those libraries, everywhere its media is reachable', async () => {
  const jellyfin = jellyfinWith([FILMS, SHOWS]);
  assert.deepEqual(
    (await jellyfin.browse({})).items.map(item => item.title),
    ['Films', 'Shows'],
  );
  assert.deepEqual(
    (await jellyfin.browse({ section: FILMS })).items.map(item => item.id),
    [id(1)],
  );
  await assert.rejects(jellyfin.browse({ section: HOME }), offOrUnavailable);
  await assert.rejects(jellyfin.browse({ section: HOME, q: 'Birth' }), offOrUnavailable);
  await assert.rejects(jellyfin.filters(HOME), offOrUnavailable);
  await assert.rejects(jellyfin.queueItems({ type: 'library', id: HOME }), offOrUnavailable);
  await assert.rejects(jellyfin.details(id(3)), offOrUnavailable);
  await assert.rejects(jellyfin.playableItem(id(3)), offOrUnavailable);
  await assert.rejects(jellyfin.artwork(id(3), 'poster'), offOrUnavailable);
  await assert.rejects(jellyfin.source(id(3)), offOrUnavailable);
  assert.equal(await jellyfin.allows(id(3)), false);
  assert.equal(await jellyfin.allows(id(1)), true);
  assert.deepEqual(
    (await jellyfin.recentlyAdded()).map(item => item.id),
    [id(1), id(2)],
  );
  const available = await jellyfin.availability([id(1), id(3)]);
  assert.equal(available.get(id(1)), true);
  assert.equal(available.get(id(3)), false);
  // A library the server gains later is off while the list exists.
  const later = jellyfinWith([FILMS], [FILMS, SHOWS, HOME, LATER]);
  assert.deepEqual(
    (await later.browse({})).items.map(item => item.id),
    [FILMS],
  );
  await assert.rejects(later.browse({ section: LATER }), offOrUnavailable);
});

test('a Jellyfin source without a list offers every library, and lists them all for the operator', async () => {
  const jellyfin = jellyfinWith(null, [FILMS, SHOWS, HOME, LATER]);
  assert.equal((await jellyfin.browse({})).items.length, 4);
  assert.equal(await jellyfin.allows(id(3)), true);
  assert.deepEqual(
    await sourceType('jellyfin').libraries(
      { url: 'http://jf.invalid', apiKey: 'key', user: 'Viewer', libraries: [FILMS] },
      { jellyfinFetch: jellyfinServer() },
    ),
    [
      { id: FILMS, name: 'Films', type: 'movies', count: 1 },
      { id: SHOWS, name: 'Shows', type: 'shows', count: 1 },
      { id: HOME, name: 'Home Videos', type: 'movies', count: 1 },
    ],
  );
});
