'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { normalizeConfig } = require('../server/config');
const { LocalIndex, token } = require('../server/local/index');

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
    { id: 'film', name: 'Film', paths: [path.join(base, 'films'), path.join(base, 'more')], parseNames: true },
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
  const { LocalMedia } = require('../server/local-provider');
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
  const { LocalMedia } = require('../server/local-provider');
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
