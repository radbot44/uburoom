'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { writeCertificate } = require('../server/local-tls');
const { credentialVault } = require('../server/accounts');
const { openDatabase } = require('../server/database');
const { initializeSchema } = require('../server/storage');
const { Logger } = require('../server/logger');
const { normalizeConfig } = require('../server/config');
const foldersSource = require('../server/sources/folders');

function temporary(t, prefix = 'uburoom-priv-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function windowsAclSummary(targetPath, isDir = false) {
  const script = isDir
    ? `$acl = [System.IO.Directory]::GetAccessControl($env:UBU_ACL_PATH)
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + ':' + $_.AccessControlType })
[PSCustomObject]@{ protected = $acl.AreAccessRulesProtected; owner = $owner; rules = $rules } | ConvertTo-Json -Compress`
    : `$acl = [System.IO.File]::GetAccessControl($env:UBU_ACL_PATH)
$owner = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value + ':' + $_.AccessControlType })
[PSCustomObject]@{ protected = $acl.AreAccessRulesProtected; owner = $owner; rules = $rules } | ConvertTo-Json -Compress`;
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: { ...process.env, UBU_ACL_PATH: path.resolve(targetPath) }, encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(out);
}

function assertPrivateAcl(targetPath, isDir = false) {
  if (process.platform === 'win32') {
    const info = windowsAclSummary(targetPath, isDir);
    assert.equal(info.protected, true, `${targetPath} must disable ACL inheritance`);
    const allowed = new Set([`${info.owner}:Allow`, 'S-1-5-18:Allow']);
    assert.ok(info.rules.length >= 2, `${targetPath} must grant owner and SYSTEM`);
    for (const rule of info.rules) {
      assert.ok(allowed.has(rule), `Unexpected ACL rule on ${targetPath}: ${rule}`);
    }
  } else {
    const mode = fs.statSync(targetPath).mode & 0o777;
    assert.equal(mode, isDir ? 0o700 : 0o600, `${targetPath} mode should be private`);
  }
}

function makeExecutable(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, process.platform === 'win32' ? 'MZ' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return filePath;
}

test('VD-01: writeCertificate, credentialVault, and openDatabase enforce private ACLs and directory modes', t => {
  const root = temporary(t);

  const certsDir = path.join(root, 'certs');
  const { keyFile } = writeCertificate({ directory: certsDir });
  assertPrivateAcl(certsDir, true);
  assertPrivateAcl(keyFile, false);

  const keyPath = path.join(root, 'secrets', 'credentials.key');
  const vault = credentialVault(keyPath);
  assert.ok(vault.seal('probe').encrypted === 1);
  assertPrivateAcl(path.dirname(keyPath), true);
  assertPrivateAcl(keyPath, false);

  const dbPath = path.join(root, 'data', 'accounts.sqlite');
  const persistence = openDatabase(dbPath, initializeSchema);
  try {
    assertPrivateAcl(path.dirname(dbPath), true);
  } finally {
    persistence.close();
  }
});

test('VD-05: Logger protects logging.file and rotates cleanly at maxFileBytes with a single .1 backup', async t => {
  const root = temporary(t, 'uburoom-log-');
  const logFile = path.join(root, 'logs', 'uburoom.log');
  const logger = new Logger({ level: 'info', file: logFile, isTTY: false, maxFileBytes: 120 });
  logger.info('Boot', 'first message padding to exceed threshold 1234567890');
  logger.info('Boot', 'second message triggers rotation 1234567890abcdef');
  await logger.close();

  assertPrivateAcl(path.dirname(logFile), true);
  assertPrivateAcl(logFile, false);
  assert.ok(fs.existsSync(logFile + '.1'), 'rotated .1 log backup must exist');
  assertPrivateAcl(logFile + '.1', false);
  const currentText = fs.readFileSync(logFile, 'utf8');
  const backupText = fs.readFileSync(logFile + '.1', 'utf8');
  assert.match(currentText, /second message triggers rotation/);
  assert.match(backupText, /first message padding/);
});

test('VD-02: normalizeConfig resolves sibling ffprobe when tools.ffprobe is blank and prefers bundled ../runtime/ffmpeg over PATH', async t => {
  const root = temporary(t, 'uburoom-tools-');
  const exe = name => (process.platform === 'win32' ? name + '.exe' : name);
  const dataDir = path.join(root, 'data');
  const mediaDir = path.join(root, 'Films');
  fs.mkdirSync(mediaDir, { recursive: true });

  // 1. Explicit tools.ffmpeg + blank tools.ffprobe + empty PATH resolves sibling ffprobe and passes folders check
  const customDir = path.join(root, 'custom-ffmpeg');
  const customFfmpeg = makeExecutable(path.join(customDir, exe('ffmpeg')));
  const customFfprobe = makeExecutable(path.join(customDir, exe('ffprobe')));
  const explicitCfg = normalizeConfig(
    {
      storage: {
        credential_key_file: path.join(os.tmpdir(), 'uburoom-test-key-' + Date.now() + '.key'),
        data_directory: dataDir,
      },
      tools: { ffmpeg: customFfmpeg, ffprobe: '' },
      sources: [{ id: 'films', type: 'folders', libraries: [{ id: 'movies', name: 'Movies', paths: [mediaDir] }] }],
    },
    { base: root, root: path.join(root, 'slot', 'app'), environment: { PATH: '' }, discoverTools: true },
  );
  assert.equal(explicitCfg.ffmpegPath, customFfmpeg);
  assert.equal(explicitCfg.ffprobePath, customFfprobe);
  const folderChecks = await foldersSource.check(explicitCfg.sources[0], {
    ffmpeg: explicitCfg.ffmpegPath,
    ffprobe: explicitCfg.ffprobePath,
  });
  const toolRow = folderChecks.find(row => row.name === 'Folder media tools');
  assert.equal(toolRow?.status, 'pass');

  // 2. Blank tools.ffmpeg/ffprobe prefers <root>/../runtime/ffmpeg over PATH
  const slotDir = path.join(root, 'versions', '0.5.3-test');
  const slotAppDir = path.join(slotDir, 'app');
  const bundledFfmpeg = makeExecutable(path.join(slotDir, 'runtime', 'ffmpeg', exe('ffmpeg')));
  const bundledFfprobe = makeExecutable(path.join(slotDir, 'runtime', 'ffmpeg', exe('ffprobe')));
  const pathDir = path.join(root, 'system-path');
  makeExecutable(path.join(pathDir, exe('ffmpeg')));
  makeExecutable(path.join(pathDir, exe('ffprobe')));
  fs.mkdirSync(slotAppDir, { recursive: true });

  const bundledCfg = normalizeConfig(
    {
      storage: {
        credential_key_file: path.join(os.tmpdir(), 'uburoom-test-key2-' + Date.now() + '.key'),
        data_directory: dataDir,
      },
      tools: { ffmpeg: '', ffprobe: '' },
    },
    { base: root, root: slotAppDir, environment: { PATH: pathDir }, discoverTools: true },
  );
  assert.equal(bundledCfg.ffmpegPath, bundledFfmpeg);
  assert.equal(bundledCfg.ffprobePath, bundledFfprobe);

  // 3. Explicit tools.ffmpeg overrides both bundled and PATH
  const overrideCfg = normalizeConfig(
    {
      storage: {
        credential_key_file: path.join(os.tmpdir(), 'uburoom-test-key3-' + Date.now() + '.key'),
        data_directory: dataDir,
      },
      tools: { ffmpeg: customFfmpeg, ffprobe: '' },
    },
    { base: root, root: slotAppDir, environment: { PATH: pathDir }, discoverTools: true },
  );
  assert.equal(overrideCfg.ffmpegPath, customFfmpeg);
});
