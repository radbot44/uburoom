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
});
