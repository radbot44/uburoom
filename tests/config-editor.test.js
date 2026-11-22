'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { loadConfig } = require('../server/config');
const { createConfigEditor } = require('../server/config-editor');

// The YAML editor's own file: its Windows permission steps launch PowerShell, so it runs beside config.test.js.
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function editingFixture(t) {
  const directory = temporary(t),
    file = path.join(directory, "selected [fixture] 'config'.yaml");
  const source = [
    '# Private fixture header',
    'sources:',
    "  - id: 'plex'",
    "    type: 'plex'",
    "    url: 'http://127.0.0.1:32400'",
    "    token: 'fixture-secret:#not-a-comment' # keep secret comment",
    'storage:',
    "  credential_key_file: './keys/original.key' # keep original key path",
    'tools:',
    "  ffmpeg: './bin/ffmpeg'",
    "  ffprobe: './bin/ffprobe'",
    'rooms:',
    '  max_members: 20 # capacity comment',
    '  inactive_days: 180 # do not change retention',
    '  viewer_permissions:',
    '    # Preserve list comments even if items are replaced',
    '    - playPause # old item comment',
    'transcoding:',
    "  encoder: 'auto' # encoder comment",
    '# Footer stays',
    '',
  ].join('\r\n');
  await fs.promises.writeFile(file, source, { mode: 0o600 });
  // Give the Windows fixture a restrictive source DACL, then inspect real ACLs
  // after replacement. All paths/content here are disposable test inputs.
  if (process.platform === 'win32') {
    const script = `$acl=[System.Security.AccessControl.FileSecurity]::new();
      $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
      $acl.SetOwner($owner);$acl.SetAccessRuleProtection($true,$false);
      foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
        [void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))
      };[System.IO.File]::SetAccessControl($env:UBUROOM_TEST_CONFIG,$acl)`;
    await windowsAcl(file, script);
  }
  return { directory, file, source, editor: createConfigEditor(file) };
}
async function windowsAcl(file, script = '[System.IO.File]::GetAccessControl($env:UBUROOM_TEST_CONFIG).Sddl') {
  const run = require('node:util').promisify(require('node:child_process').execFile);
  const result = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from("$ErrorActionPreference='Stop';" + script, 'utf16le').toString('base64'),
    ],
    { windowsHide: true, env: { ...process.env, UBUROOM_TEST_CONFIG: file } },
  );
  return result.stdout.trim();
}

test('YAML editor preserves comments/private settings, protects backup/replacement and requires restart', async t => {
  const { file, source } = await editingFixture(t);
  const argv = process.argv;
  let editor;
  try {
    process.argv = [...argv.slice(0, 2), '--config', file];
    editor = createConfigEditor();
  } finally {
    process.argv = argv;
  }
  const initial = await editor.read(),
    running = loadConfig(file);
  const originalAcl = process.platform === 'win32' ? await windowsAcl(file) : undefined;
  const result = await editor.save({
    revision: initial.revision,
    changes: {
      'rooms.max_members': 12,
      'rooms.viewer_permissions': ['playPause', 'seek'],
      'directory.expose_discord_members': false,
      'transcoding.encoder': 'software',
      'transcoding.qualities': [[480, 1]],
      'transcoding.allow_original': false,
    },
  });
  assert.equal(result.restartRequired, true);
  assert.notEqual(result.revision, initial.revision);
  assert.equal((await editor.read()).revision, result.revision);
  assert.equal(initial.source, 'file');
  assert.equal(JSON.stringify(initial).includes('fixture-secret'), false);
  const saved = await fs.promises.readFile(file, 'utf8'),
    after = loadConfig(file);
  for (const comment of [
    'Private fixture header',
    'keep secret comment',
    'keep original key path',
    'capacity comment',
    'do not change retention',
    'Preserve list comments even if items are replaced',
    'old item comment',
    'encoder comment',
    'Footer stays',
  ])
    assert.ok(saved.includes(comment));
  assert.equal(saved.replace(/\r\n/g, '').includes('\n'), false, 'preserve CRLF convention');
  assert.equal(after.sources[0].token, running.sources[0].token);
  assert.equal(after.credentialKeyFile, path.join(path.dirname(file), 'keys/original.key'));
  assert.equal(after.roomLimits.inactiveDays, 180);
  assert.equal(after.roomLimits.maxMembers, 12);
  assert.equal(running.roomLimits.maxMembers, 20);
  assert.equal(after.roomPermissions.viewer.seek, true);
  assert.equal(after.directory.discord, false);
  assert.equal(after.transcoding.encoder, 'software');
  assert.equal(await fs.promises.readFile(result.backupPath, 'utf8'), source);
  if (process.platform === 'win32') {
    assert.equal(await windowsAcl(file), originalAcl, 'preserve the protected source DACL');
    const backupAcl = await windowsAcl(result.backupPath);
    assert.match(backupAcl, /S-1-5-18|SY/);
    assert.equal(
      await windowsAcl(
        path.dirname(result.backupPath),
        '[System.IO.Directory]::GetAccessControl($env:UBUROOM_TEST_CONFIG).AreAccessRulesProtected',
      ),
      'True',
    );
  } else {
    assert.equal((await fs.promises.stat(file)).mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(result.backupPath)).mode & 0o777, 0o600);
    assert.equal((await fs.promises.stat(path.dirname(result.backupPath))).mode & 0o777, 0o700);
  }
});

test('YAML editor rejects forbidden/invalid edits and validates the entire file without leaking private text', async t => {
  const { editor, file, source } = await editingFixture(t),
    { revision } = await editor.read();
  for (const key of [
    'access.discord',
    'server.public_web_app',
    'rooms.single_room',
    'rooms.min_retained',
    'rooms.inactive_days',
    'rooms.max_history',
    'operator.plex_id',
    'plex.token',
    'plex.url',
    'rooms.admin_discord_ids',
    'storage.credential_key_file',
    'tools.ffmpeg',
    '__proto__.polluted',
  ]) {
    await assert.rejects(editor.save({ revision, changes: { [key]: 'private-invalid-value' } }), {
      code: 'CONFIG_FORBIDDEN',
    });
  }
  for (const changes of [
    { 'rooms.max_open': 100 },
    { 'transcoding.max_jobs': 0 },
    { 'transcoding.encoder': 'private-invalid-value' },
    { 'rooms.viewer_permissions': ['manageHosts'] },
    { 'directory.expose_discord_members': null },
    { 'transcoding.allow_original': false, 'transcoding.qualities': [] },
  ]) {
    await assert.rejects(
      editor.save({ revision, changes }),
      error => error.code === 'CONFIG_INVALID' && !error.message.includes('private-invalid-value'),
    );
  }
  await assert.rejects(editor.save({ revision, changes: { 'directory.expose_plex_members': true } }), {
    code: 'CONFIG_FORBIDDEN',
  });
  await assert.rejects(editor.save(null), { code: 'CONFIG_INVALID' });
  assert.equal(await fs.promises.readFile(file, 'utf8'), source);
  // Even untouched invalid settings must prevent persistence, with parser and
  // validator errors hidden from callers.
  for (const invalid of [
    source + "server: {port: 'fixture-secret'}\n",
    "sources: [{id: 'plex', token: 'fixture-secret'\n",
  ]) {
    await fs.promises.writeFile(file, invalid);
    const hash = require('node:crypto').createHash('sha256').update(invalid).digest('hex');
    await assert.rejects(
      editor.save({ revision: hash, changes: { 'rooms.max_members': 10 } }),
      error => error.code === 'CONFIG_INVALID' && !error.message.includes('fixture-secret'),
    );
    assert.equal(await fs.promises.readFile(file, 'utf8'), invalid);
  }
});

test('YAML editor serializes instances, rejects stale revisions and detects external edits before replacement', async t => {
  const { editor, file, source } = await editingFixture(t),
    { revision } = await editor.read();
  const results = await Promise.allSettled([
    editor.save({ revision, changes: { 'rooms.max_members': 12 } }),
    createConfigEditor(file).save({ revision, changes: { 'transcoding.max_jobs': 2 } }),
  ]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'CONFIG_CONFLICT');
  const current = await editor.read(),
    external = source + '# External editor change\r\n';
  const open = fs.promises.open.bind(fs.promises);
  const mock = t.mock.method(fs.promises, 'open', async (target, ...args) => {
    const handle = await open(target, ...args);
    if (path.basename(target) === 'replacement.yaml') {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        await sync();
        await fs.promises.writeFile(file, external);
      };
    }
    return handle;
  });
  await assert.rejects(editor.save({ revision: current.revision, changes: { 'rooms.max_members': 11 } }), {
    code: 'CONFIG_CONFLICT',
  });
  mock.mock.restore();
  assert.equal(await fs.promises.readFile(file, 'utf8'), external);
  assert.equal(loadConfig(file).roomLimits.maxMembers, 20);
});

test('YAML editor leaves originals usable on backup, partial-write and replacement failures', async t => {
  const { editor, file, source, directory } = await editingFixture(t),
    { revision } = await editor.read();
  const alias = path.join(directory, 'hardlink.yaml');
  await fs.promises.link(file, alias);
  await assert.rejects(editor.save({ revision, changes: { 'rooms.max_members': 12 } }), { code: 'CONFIG_UNSAFE_PATH' });
  await fs.promises.unlink(alias);
  for (const stage of ['backup', 'write', 'replace']) {
    const open = fs.promises.open.bind(fs.promises);
    const mock =
      stage === 'replace'
        ? t.mock.method(fs.promises, 'rename', async () => {
            throw new Error('fixture-secret ' + file);
          })
        : t.mock.method(fs.promises, 'open', async (target, ...args) => {
            if (stage === 'backup' && path.basename(target) === 'original.yaml')
              throw new Error('fixture-secret ' + file);
            const handle = await open(target, ...args);
            if (stage === 'write' && path.basename(target) === 'replacement.yaml') {
              const write = handle.writeFile.bind(handle);
              handle.writeFile = async bytes => {
                await write(bytes.subarray(0, 8));
                throw new Error('fixture-secret ' + file);
              };
            }
            return handle;
          });
    await assert.rejects(
      editor.save({ revision, changes: { 'rooms.max_members': 12 } }),
      error =>
        error.code === 'CONFIG_IO' &&
        !error.message.includes('fixture-secret') &&
        !error.message.includes(file) &&
        error.cause === undefined,
    );
    mock.mock.restore();
    assert.equal(await fs.promises.readFile(file, 'utf8'), source);
    assert.equal(loadConfig(file).roomLimits.maxMembers, 20);
  }
  for (const entry of await fs.promises.readdir(directory))
    if (entry.startsWith('.uburoom-config-')) {
      assert.equal(await fs.promises.readFile(path.join(directory, entry, 'original.yaml'), 'utf8'), source);
      assert.equal((await fs.promises.readdir(path.join(directory, entry))).includes('replacement.yaml'), false);
    }
  assert.equal(
    (await editor.save({ revision, changes: { 'rooms.max_members': 13 } })).restartRequired,
    true,
    'failed writes do not poison the queue',
  );
  // Failed recovery backups stay preserved while routine saves prune to newest 3.
  let nextRev = (await editor.read()).revision;
  await assert.rejects(editor.save({ revision: '0'.repeat(64), changes: { 'rooms.max_members': 14 } }), {
    code: 'CONFIG_CONFLICT',
  });
  for (let i = 0; i < 4; i++) {
    const saved = await editor.save({ revision: nextRev, changes: { 'rooms.max_members': 15 + i } });
    nextRev = saved.revision;
  }
  const backupDirs = (await fs.promises.readdir(directory)).filter(name => name.startsWith('.uburoom-config-'));
  let preservedCount = 0;
  let routineCount = 0;
  for (const name of backupDirs) {
    const files = await fs.promises.readdir(path.join(directory, name));
    if (files.includes('.preserve')) preservedCount++;
    else routineCount++;
  }
  assert.equal(preservedCount, 2, 'write and replace failure backups stay preserved');
  assert.equal(routineCount, 3, 'routine backup folders are pruned to newest 3');
});

test('YAML editor saves access rules, write-only server password, and source member opt-in safely', async t => {
  const { editor, file } = await editingFixture(t);
  let current = await editor.readEditable();
  assert.equal(current.settings['access.discord_server'], true);
  assert.deepEqual(current.settings['access.source_members'], []);
  assert.equal(current.settings['access.accounts'], false);
  assert.equal(current.settings['access.password'], false);
  assert.equal(current.settings['guests.enabled'], false);
  assert.equal(Object.hasOwn(current.settings, 'secrets.server_password'), false);
  assert.deepEqual(current.access.sources, [{ id: 'plex', type: 'plex', name: 'plex' }]);

  // Turning off all entry rules is rejected and leaves the file unchanged.
  await assert.rejects(
    editor.save({
      revision: current.revision,
      changes: { 'access.discord_server': false },
    }),
    { code: 'CONFIG_INVALID' },
  );

  // Enabling Plex members, uburoom accounts, server password and guests succeeds.
  const secret = 'correct-horse-battery-staple';
  let saved = await editor.save({
    revision: current.revision,
    changes: {
      'access.discord_server': false,
      'access.source_members': ['plex'],
      'access.accounts': true,
      'access.password': true,
      'secrets.server_password': secret,
      'guests.enabled': true,
    },
  });
  let after = loadConfig(file);
  assert.equal(after.accessPolicy.discordServer, false);
  assert.deepEqual(after.accessPolicy.sourceMembers, ['plex']);
  assert.equal(after.accessPolicy.accounts, true);
  assert.equal(after.accessPolicy.password, true);
  assert.equal(after.serverPassword, secret);
  assert.equal(after.guests.enabled, true);

  // readEditable() never exposes the write-only password.
  current = await editor.readEditable();
  assert.equal(current.revision, saved.revision);
  assert.equal(current.settings['access.password'], true);
  assert.equal(Object.hasOwn(current.settings, 'secrets.server_password'), false);
  assert.equal(JSON.stringify(current).includes(secret), false);

  // Disabling access.password automatically clears secrets.server_password so validation passes.
  saved = await editor.save({
    revision: current.revision,
    changes: { 'access.password': false },
  });
  after = loadConfig(file);
  assert.equal(after.accessPolicy.password, false);
  assert.equal(after.serverPassword, '');

  // Adding a Jellyfin source with allowMembers appends its id to access.source_members.
  saved = await editor.saveSources({
    revision: saved.revision,
    change: {
      action: 'add',
      allowMembers: true,
      entry: {
        id: 'jf-home',
        type: 'jellyfin',
        url: 'http://127.0.0.1:8096',
        api_key: 'jf-secret-key',
        user: 'viewer',
      },
    },
  });
  after = loadConfig(file);
  assert.deepEqual(after.accessPolicy.sourceMembers, ['plex', 'jf-home']);
});

test('YAML backup pruning is scoped to the owning config and preserves ambiguous older backups', async t => {
  const { directory, file: fileA, editor: editorA, source } = await editingFixture(t);
  const fileB = path.join(directory, 'other.yaml');
  await fs.promises.writeFile(fileB, source, 'utf8');
  const editorB = createConfigEditor(fileB);

  // Create an older ambiguous backup directory without an .owner marker.
  const legacyDir = path.join(directory, '.uburoom-config-legacy-0001');
  await fs.promises.mkdir(legacyDir, { recursive: true });
  await fs.promises.writeFile(path.join(legacyDir, 'original.yaml'), source, 'utf8');

  // Save B twice so B owns 2 backup directories in the same folder.
  let revB = (await editorB.read()).revision;
  for (let i = 0; i < 2; i++) {
    revB = (await editorB.save({ revision: revB, changes: { 'rooms.max_members': 11 + i } })).revision;
  }

  // Save A five times so A's pruning runs past the keep=3 limit.
  let revA = (await editorA.read()).revision;
  for (let i = 0; i < 5; i++) {
    revA = (await editorA.save({ revision: revA, changes: { 'rooms.max_members': 21 + i } })).revision;
  }

  const dirs = (await fs.promises.readdir(directory)).filter(name => name.startsWith('.uburoom-config-'));
  let ownedByA = 0;
  let ownedByB = 0;
  let legacyPresent = false;
  for (const name of dirs) {
    const ownerPath = path.join(directory, name, '.owner');
    if (name === '.uburoom-config-legacy-0001') {
      legacyPresent = true;
      continue;
    }
    const owner = (await fs.promises.readFile(ownerPath, 'utf8')).trim();
    if (owner === path.basename(fileA)) ownedByA++;
    else if (owner === path.basename(fileB)) ownedByB++;
  }
  assert.equal(ownedByA, 3, 'config A routine backups are pruned to newest 3');
  assert.equal(ownedByB, 2, 'saving config A does not prune config B backups');
  assert.equal(legacyPresent, true, 'ambiguous older backups without .owner are preserved');
});
