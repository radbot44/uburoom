'use strict';
// Server settings → Sources, editing a folders source: libraries and their folders change through the
// folders module's own update, applied to the entry as config.yaml holds it. Library ids never change,
// the last folder or library cannot go, and everything not edited (comments, relative paths, keys left
// out) round-trips exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const YAML = require('yaml');
const { fixture } = require('./helpers/account-app');
const { loadConfig } = require('../server/config');

const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };

const SOURCES = `# Keep this sources comment
sources:
  - id: 'home'
    type: 'folders'
    name: 'Home'
    libraries:
      - id: 'films' # films keep this id
        name: 'Films'
        paths: ['media/films', 'media/more films'] # relative to this file
        parse_names: false
      - id: 'tv'
        name: 'TV'
        type: 'shows'
        paths:
          - 'media/tv'
  - id: 'other'
    type: 'folders'
    libraries:
      - id: 'kids'
        name: 'Kids'
        paths: ['media/kids']
`;

async function foldersFixture(t) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'uburoom-folders-edit-'));
  t.after(() => fs.promises.rm(directory, { recursive: true, force: true }));
  for (const name of ['films', 'more films', 'tv', 'kids', 'docs', 'extra'])
    fs.mkdirSync(path.join(directory, 'media', name), { recursive: true });
  fs.writeFileSync(path.join(directory, 'media', 'a file.txt'), '');
  const file = path.join(directory, 'config.yaml');
  await fs.promises.writeFile(
    file,
    `access:
  discord_server: true
operator:
  identities: ['discord:100000000000000002']
discord:
  client_id: '100000000000000010'
  client_secret: 'fixture-private-client-secret'
  owner_id: '100000000000000001'
  guild_id: '100000000000000020'
${SOURCES}storage:
  credential_key_file: './original.key'
`,
    { mode: 0o600 },
  );
  const f = await fixture(t, undefined, { ...loadConfig(file), accountFile: undefined, credentialKeyFile: undefined });
  const operator = f.browser();
  await operator.discord('guest');
  const media = name => path.join(directory, 'media', name);
  const read = () => YAML.parse(fs.readFileSync(file, 'utf8'));
  const text = () => fs.readFileSync(file, 'utf8');
  /** The libraries as the panel shows them: from the list answer. */
  const shown = async () =>
    (await operator.request('/api/operator/sources')).body.sources.find(source => source.id === 'home').folders;
  const edit = async (libraries, extra = {}) => {
    const { revision } = (await operator.request('/api/operator/sources')).body;
    return operator.post('/api/operator/sources', {
      revision,
      action: 'update',
      id: 'home',
      settings: { libraries },
      ...extra,
    });
  };
  return { ...f, file, directory, operator, media, read, text, shown, edit };
}
const wanted = libraries => libraries.map(({ id, name, type, paths }) => ({ id, name, type, paths: [...paths] }));

test('the panel sees each library of a folders source with its folders', tls, async t => {
  const f = await foldersFixture(t);
  assert.deepEqual(await f.shown(), [
    { id: 'films', name: 'Films', type: 'movies', paths: [f.media('films'), f.media('more films')] },
    { id: 'tv', name: 'TV', type: 'shows', paths: [f.media('tv')] },
  ]);
});

test('adding and removing a folder keeps library ids and everything not edited', tls, async t => {
  const f = await foldersFixture(t);
  const before = f.text();
  // Add a folder to TV.
  let libraries = wanted(await f.shown());
  libraries[1].paths.push(f.media('docs'));
  const added = await f.edit(libraries);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  assert.deepEqual(f.read().sources[0].libraries[1], {
    id: 'tv',
    name: 'TV',
    type: 'shows',
    paths: ['media/tv', f.media('docs')],
  });
  // The films library, its relative folders, its comments and the other source are as written.
  assert.match(f.text(), /- id: 'films' # films keep this id/);
  assert.match(f.text(), /paths: \['media\/films', 'media\/more films'\] # relative to this file/);
  assert.match(f.text(), /parse_names: false/);
  assert.match(f.text(), /# Keep this sources comment/);
  assert.equal(f.text().slice(f.text().indexOf("  - id: 'other'")), before.slice(before.indexOf("  - id: 'other'")));
  // Remove one of the films folders: the other stays exactly as written.
  libraries = wanted(await f.shown());
  libraries[0].paths = [f.media('more films')];
  assert.equal((await f.edit(libraries)).status, 200);
  assert.deepEqual(f.read().sources[0].libraries[0], {
    id: 'films',
    name: 'Films',
    paths: ['media/more films'],
    parse_names: false,
  });
  // Rename and change the type: the id stays.
  libraries = wanted(await f.shown());
  libraries[0].name = 'Movies';
  libraries[0].type = 'shows';
  assert.equal((await f.edit(libraries)).status, 200);
  assert.deepEqual(f.read().sources[0].libraries[0], {
    id: 'films',
    name: 'Movies',
    paths: ['media/more films'],
    parse_names: false,
    type: 'shows',
  });
});

test('adding and removing a library gives a new id unique across every folders source', tls, async t => {
  const f = await foldersFixture(t);
  const libraries = wanted(await f.shown());
  // A new library named like another source's library gets its own id.
  libraries.push({ name: 'Kids', type: 'movies', paths: [f.media('extra')] });
  const added = await f.edit(libraries);
  assert.equal(added.status, 200, JSON.stringify(added.body));
  const saved = f.read().sources[0].libraries;
  assert.deepEqual(
    saved.map(library => library.id),
    ['films', 'tv', 'kids-2'],
  );
  assert.deepEqual(saved[2], { id: 'kids-2', name: 'Kids', paths: [f.media('extra')], type: 'movies' });
  // Remove TV: the others keep their ids, and TV's id is never given to a later library.
  const kept = wanted(await f.shown()).filter(library => library.id !== 'tv');
  assert.equal((await f.edit(kept)).status, 200);
  assert.deepEqual(
    f.read().sources[0].libraries.map(library => library.id),
    ['films', 'kids-2'],
  );
  assert.ok(!/id: 'tv'/.test(f.text().slice(0, f.text().indexOf("- id: 'other'"))));
});

test(
  'the last folder, the last library, unreadable folders and repeats are refused; nothing is written',
  tls,
  async t => {
    const f = await foldersFixture(t);
    const before = f.text();
    const libraries = wanted(await f.shown());
    const refused = async (change, pattern, extra) => {
      const response = await f.edit(change, extra);
      assert.equal(response.status, 400, JSON.stringify(response.body));
      assert.match(response.body.error, pattern);
      assert.equal(f.text(), before);
    };
    await refused([{ ...libraries[0], paths: [] }, libraries[1]], /at least one folder/);
    await refused([], /at least one library/);
    await refused([libraries[0], { ...libraries[1], paths: [f.media('missing')] }], /can’t be opened/);
    await refused([libraries[0], { ...libraries[1], paths: ['media/docs'] }], /Choose a folder/);
    await refused(
      [libraries[0], { ...libraries[1], paths: [path.join(f.directory, 'media', 'a file.txt')] }],
      /Choose a folder/,
    );
    await refused([libraries[0], { ...libraries[1], id: 'gone' }], /no longer saved/);
    await refused([libraries[0], { ...libraries[1], type: 'music' }], /Movies or Shows/);
    // A folder in two libraries is refused by the whole-file check.
    await refused(
      [libraries[0], { ...libraries[1], paths: [f.media('tv'), f.media('films')] }],
      /must not repeat a folder/,
    );
    // The same folder twice in one library is kept once.
    const twice = await f.edit([
      libraries[0],
      { ...libraries[1], paths: [f.media('tv'), f.media('tv'), f.media('docs')] },
    ]);
    assert.equal(twice.status, 200);
    assert.deepEqual(f.read().sources[0].libraries[1].paths, ['media/tv', f.media('docs')]);
    // Plex and Jellyfin keep their library switches; a folders source has no switch list.
    const { revision } = (await f.operator.request('/api/operator/sources')).body;
    assert.equal(
      (await f.operator.post('/api/operator/sources', { revision, action: 'update', id: 'home', libraries: [] }))
        .status,
      400,
    );
  },
);

test('an unchanged edit leaves the file byte for byte as written', tls, async t => {
  const f = await foldersFixture(t);
  const before = f.text();
  assert.equal((await f.edit(wanted(await f.shown()))).status, 200);
  assert.equal(f.text(), before);
});
