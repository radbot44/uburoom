'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeConfig } = require('../server/config');
const { LocalIndex, token } = require('../server/sources/folders/index');

function folder(t, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-local-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const file of files) {
    fs.mkdirSync(path.join(dir, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), '');
  }
  return dir;
}

test('a library lists every folder it names, and a file keeps its id when its folder moves', async t => {
  const first = folder(t, ['Heat (1995)/Heat.mkv', 'Alien.mp4']),
    second = folder(t, ['Heat (1995)/Heat.mkv', 'Old/Metropolis.mkv']);
  const warnings = [];
  const index = new LocalIndex([{ id: 'film', name: 'Film', paths: [first, second] }], {
    logger: { warn: (...args) => warnings.push(args.join(' ')) },
  });
  await index.refresh();
  const entries = index.list('film');
  assert.deepEqual(entries.map(entry => entry.relative).sort(), [
    'Alien.mp4',
    'Heat (1995)/Heat.mkv',
    'Old/Metropolis.mkv',
  ]);
  // The same place in two folders is one file, taken from the first folder listed.
  const heat = index.get(token('film', 'Heat (1995)/Heat.mkv'));
  assert.equal(heat.path, path.join(first, 'Heat (1995)', 'Heat.mkv'));
  assert.match(warnings.join('\n'), /1 files at the same place/);
  // A file's id names its library and place, never the drive, so moving a folder keeps queues and resume positions.
  const moved = new LocalIndex([{ id: 'film', name: 'Film', paths: [second] }]);
  await moved.refresh();
  assert.equal(moved.get(heat.token).path, path.join(second, 'Heat (1995)', 'Heat.mkv'));
});

test('release names list as films, sorted without their article, unless the library keeps file names', async t => {
  const films = folder(t, [
    'The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv',
    '65.2023.2160p.UHD.BluRay.x265-B0MBARDiERS.mkv',
    'Heat (1995)/movie.mkv',
  ]);
  const index = new LocalIndex([
    { id: 'film', name: 'Film', paths: [films] },
    { id: 'raw', name: 'Raw', paths: [films], parseNames: false },
  ]);
  await index.refresh();
  assert.deepEqual(
    index.list('film').map(entry => [entry.title, entry.year]),
    [
      ['65', 2023],
      ['Heat', 1995],
      ['The Matrix', 1999],
    ],
  );
  assert.deepEqual(
    index.list('raw').map(entry => [entry.title, entry.year]),
    [
      ['65 2023 2160p UHD BluRay x265-B0MBARDiERS', 0],
      ['The Matrix 1999 1080p BluRay x264-GROUP', 0],
      ['movie', 0],
    ],
  );
});

test('a folder that cannot be read leaves the library its other folders', async t => {
  const present = folder(t, ['Alien.mp4']);
  const index = new LocalIndex([{ id: 'film', name: 'Film', paths: [path.join(present, 'missing'), present] }], {
    logger: { warn() {} },
  });
  await index.refresh();
  assert.deepEqual(
    index.list('film').map(entry => entry.relative),
    ['Alien.mp4'],
  );
});

test('local_media libraries take a list of folders, resolved beside the config, each used once', () => {
  const base = path.resolve(os.tmpdir(), 'uburoom-base');
  const library = paths => ({ local_media: { libraries: [{ id: 'film', name: 'Film', paths }] } });
  assert.deepEqual(normalizeConfig(library(['films', 'more']), { base, discoverTools: false }).localMedia.libraries, [
    {
      id: 'film',
      name: 'Film',
      paths: [path.join(base, 'films'), path.join(base, 'more')],
      parseNames: true,
      type: 'movies',
    },
  ]);
  const plain = { local_media: { libraries: [{ id: 'home', name: 'Home', paths: ['home'], parse_names: false }] } };
  assert.equal(normalizeConfig(plain, { base, discoverTools: false }).localMedia.libraries[0].parseNames, false);
  assert.throws(
    () =>
      normalizeConfig(
        { local_media: { libraries: [{ id: 'home', name: 'Home', paths: ['home'], parse_names: 'yes' }] } },
        { base, discoverTools: false },
      ),
    /parse_names/,
  );
  for (const paths of [[], 'films', [''], Array(17).fill('x')])
    assert.throws(() => normalizeConfig(library(paths), { base, discoverTools: false }), /paths/);
  assert.throws(
    () =>
      normalizeConfig(
        { local_media: { libraries: [{ id: 'film', name: 'Film', path: 'films' }] } },
        { base, discoverTools: false },
      ),
    /paths/,
  );
  assert.throws(
    () => normalizeConfig(library(['F:/Film', 'f:/film']), { base, platform: 'win32', discoverTools: false }),
    /repeat a folder/,
  );
});

test('Recently added lists local videos newest first, by when each file arrived', async t => {
  const films = folder(t, ['Old.mkv']);
  const old = new Date(Date.now() - 86400000);
  fs.utimesSync(path.join(films, 'Old.mkv'), old, old);
  await new Promise(resolve => setTimeout(resolve, 30));
  fs.writeFileSync(path.join(films, 'New.mkv'), '');
  const { LocalMedia } = require('../server/sources/folders/provider');
  const local = new LocalMedia([{ id: 'film', name: 'Film', paths: [films] }], { pipeline: {} });
  t.after(() => local.close());
  const recent = await local.recentlyAdded();
  assert.deepEqual(
    recent.map(item => item.title),
    ['New', 'Old'],
  );
  assert.ok(recent[0].addedAt >= recent[1].addedAt && recent[0].addedAt > 1e9, 'seconds since 1970, like Plex');
});

test('a local library sorts by release year, date added and title, and filters by year', async t => {
  const films = folder(t, ['Heat.1995.mkv', 'Alien.1979.mkv', 'Arrival.2016.mkv', 'Home video.mkv']);
  const { LocalMedia } = require('../server/sources/folders/provider');
  const local = new LocalMedia([{ id: 'film', name: 'Film', paths: [films] }], { pipeline: {} });
  t.after(() => local.close());
  const titles = async query => (await local.browse({ section: 'film', ...query })).items.map(item => item.title);
  assert.deepEqual(await titles({}), ['Alien', 'Arrival', 'Heat', 'Home video']);
  // A video without a year goes last whichever way the years run.
  assert.deepEqual(await titles({ sort: 'year', order: 'asc' }), ['Alien', 'Heat', 'Arrival', 'Home video']);
  assert.deepEqual(await titles({ sort: 'year', order: 'desc' }), ['Arrival', 'Heat', 'Alien', 'Home video']);
  assert.deepEqual(await titles({ year: '1995' }), ['Heat']);
  assert.deepEqual(await local.filters('film'), {
    genres: [],
    years: ['2016', '1995', '1979'].map(year => ({ id: year, title: year })),
  });
  await assert.rejects(local.browse({ section: 'film', year: 'nineteen' }), /Invalid library query/);
  assert.equal((await local.browse({})).items[0].filters, true);
});

test('a shows library groups episodes into shows and seasons in playing order', async t => {
  const tv = folder(t, [
    'Show (2005)/Season 1/Show.S01E02.Second.1080p.mkv',
    'Show (2005)/Season 1/Show.S01E01.Pilot.1080p.mkv',
    'Show (2005)/Season 2/01 - Return.mkv',
    'Show (2005)/Specials/Behind the scenes.mkv',
    'Other.Show.S01E01.720p.mkv',
  ]);
  const { LocalMedia } = require('../server/sources/folders/provider');
  const local = new LocalMedia([{ id: 'tv', name: 'TV', paths: [tv], type: 'shows' }], { pipeline: {} });
  t.after(() => local.close());
  const [library] = (await local.browse({})).items;
  assert.equal(library.mediaType, 'show');
  const shows = (await local.browse({ section: 'tv' })).items;
  assert.deepEqual(
    shows.map(item => [item.type, item.title, item.year, item.count, item.episodeCount]),
    [
      ['show', 'Other Show', undefined, 1, 1],
      ['show', 'Show', 2005, 3, 4],
    ],
  );
  const seasons = (await local.browse({ parent: shows[1].id })).items;
  assert.deepEqual(
    seasons.map(item => [item.type, item.title, item.count]),
    [
      ['season', 'Season 1', 2],
      ['season', 'Season 2', 1],
      ['season', 'Specials', 1],
    ],
  );
  const episodes = (await local.browse({ parent: seasons[0].id })).items;
  assert.deepEqual(
    episodes.map(item => [item.type, item.title, item.index, item.seasonIndex, item.subtitle]),
    [
      ['episode', 'Pilot', 1, 1, 'Show · Season 1 · Episode 1'],
      ['episode', 'Second', 2, 1, 'Show · Season 1 · Episode 2'],
    ],
  );
  assert.equal(episodes[0].showId, shows[1].id);
  assert.equal(episodes[0].parentId, seasons[0].id);
  // An episode steps to its neighbours across seasons, Specials left out.
  const second = await local.details(episodes[1].id).catch(error => error);
  assert.ok(second instanceof Error, 'empty fixture files cannot be read as video');
  assert.deepEqual(local.neighbors(local.index.get(episodes[1].id)), {
    previous: { id: episodes[0].id, title: 'Pilot', index: 1, seasonIndex: 1 },
    next: {
      id: (await local.browse({ parent: seasons[1].id })).items[0].id,
      title: 'Return',
      index: 1,
      seasonIndex: 2,
    },
  });
  // A whole show queues in playing order, without its Specials unless asked.
  local.described = async () => ({ info: {} });
  assert.deepEqual(
    (await local.queueItems({ type: 'show', id: shows[1].id })).map(item => item.title),
    ['Pilot', 'Second', 'Return'],
  );
  assert.deepEqual(
    (await local.queueItems({ type: 'show', id: shows[1].id, includeSpecials: true })).map(item => item.title),
    ['Pilot', 'Second', 'Return', 'Behind the scenes'],
  );
  // A new episode shows in Recently added as its show, once.
  assert.deepEqual((await local.recentlyAdded()).map(item => [item.type, item.title]).sort(), [
    ['show', 'Other Show'],
    ['show', 'Show'],
  ]);
  assert.ok(await local.allows(shows[1].id), 'a show is visible like its episodes');
});
