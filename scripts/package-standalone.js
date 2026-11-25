#!/usr/bin/env node
'use strict';
/**
 * Deterministic Windows x64 standalone builder and GPLv3 Corresponding Source archiver.
 * Reads pinned dependencies from scripts/standalone-dependencies.json, verifies SHA-256 digests before
 * extraction, runs scripts/verify-ffmpeg.js, stages versions/<slot>/ (app + runtime + BUILD_INFO.json),
 * archives Corresponding Source independently of upstream retention, and emits portable ZIPs in releases/.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { verifyFfmpeg } = require('./verify-ffmpeg');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(__dirname, 'standalone-dependencies.json');

// Exact SHA-256 digests documented in docs/third-party.md for UbuPlayer WASM vendor files.
const LIBAV_EXPECTED_HASHES = Object.freeze({
  'web/vendor/libav/libav-uburoom.mjs': 'ae717959bb375ffbde6910d78f7cb88142154ddcc7eb38820894c5b0d0c2002f',
  'web/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.mjs':
    '27e7a05cf6b00962e6d0d34b38d2a97aceba3e71f4734b68b4f60a90aeb04d6c',
  'web/vendor/libav/libav-6.11.9.0.2-uburoom.wasm.wasm':
    'd4d9a7b65af23d0325a9fc59291376c8c97693d9540e2f3aef084810bab8436d',
});

const REQUIRED_APP_ASSETS = Object.freeze([
  'web/ubuplayer.js',
  'web/ubuplayer-worker.js',
  'web/ubuplayer-worklet.js',
  'web/ubuplayer-gpu.js',
  'web/media-surface.js',
  'web/vendor/subtitles/jassub-worker.wasm',
  'web/vendor/subtitles/jassub-worker-modern.wasm',
  'web/vendor/subtitles/libbitsub_bg.wasm',
  'web/vendor/discord-sdk.js',
  'node_modules/hls.js/dist/hls.min.js',
]);

const ROOT_WHITELIST = new Set([
  'README.md',
  'ROADMAP.md',
  'SPEC.md',
  'AGENTS.md',
  'LICENSE',
  'package.json',
  'package-lock.json',
  'config.example.yaml',
  '.gitignore',
  '.gitattributes',
  'Dockerfile',
  'docker-compose.yml',
  '.dockerignore',
  'eslint.config.mjs',
  'tsconfig.json',
  'run-uburoom.bat',
  'install-uburoom.bat',
  'test-uburoom.bat',
  'run-watch-demo.bat',
]);

const APP_TOP_LEVEL_FILES = new Set([
  'LICENSE',
  'README.md',
  'package.json',
  'package-lock.json',
  'config.example.yaml',
]);
const APP_DIR_PREFIXES = ['server/', 'shared/', 'web/', 'diagnostics/', 'assets/demo/', 'scripts/', 'docs/'];

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
      hash.update(buf.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || !manifest['win32-x64']) {
    throw new Error('Manifest must define win32-x64 dependencies');
  }
  const target = manifest['win32-x64'];
  for (const key of ['node', 'ffmpeg']) {
    const entry = target[key];
    if (!entry || typeof entry !== 'object') throw new Error(`Manifest missing win32-x64.${key}`);
    for (const field of ['version', 'upstream', 'archiveFile', 'url', 'sha256', 'license']) {
      if (typeof entry[field] !== 'string' || !entry[field].trim()) {
        throw new Error(`Manifest win32-x64.${key} missing required field: ${field}`);
      }
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256)) {
      throw new Error(`Manifest win32-x64.${key} has invalid sha256 digest`);
    }
    let parsed;
    try {
      parsed = new URL(entry.url);
    } catch {
      throw new Error(`Manifest win32-x64.${key} has invalid url`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`Manifest win32-x64.${key} url must use https:`);
    }
    if (/(?:^|[/-])latest(?:[./-]|$)/i.test(entry.url) || /(?:^|[/-])latest(?:[./-]|$)/i.test(entry.version)) {
      throw new Error(`Manifest win32-x64.${key} must not reference floating latest URLs or tags`);
    }
  }
  const ff = target.ffmpeg;
  for (const field of ['releaseTag', 'variant', 'gitCommit']) {
    if (typeof ff[field] !== 'string' || !ff[field].trim()) {
      throw new Error(`Manifest win32-x64.ffmpeg missing required field: ${field}`);
    }
  }
  return target;
}

function verifyFileSha256(filePath, expectedSha256, { deleteOnMismatch = true } = {}) {
  const actual = sha256File(filePath);
  if (actual !== expectedSha256.toLowerCase()) {
    if (deleteOnMismatch) {
      try {
        fs.rmSync(filePath, { force: true });
      } catch {}
    }
    throw new Error(`SHA-256 mismatch for ${filePath}: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}

async function downloadToFile(url, destFile, fetchImpl = fetch) {
  const tmpFile = `${destFile}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(destFile), { recursive: true });
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok) {
      throw new Error(`Download failed (${response.status} ${response.statusText}) for ${url}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(arrayBuffer));
    fs.renameSync(tmpFile, destFile);
  } catch (error) {
    fs.rmSync(tmpFile, { force: true });
    throw error;
  }
}

async function ensureCachedBinary(entry, binariesDir, { fetchImpl = fetch } = {}) {
  const dest = path.join(binariesDir, entry.archiveFile);
  if (fs.existsSync(dest)) {
    verifyFileSha256(dest, entry.sha256, { deleteOnMismatch: true });
    return dest;
  }
  const tmp = path.join(binariesDir, `${entry.archiveFile}.download-${process.pid}`);
  fs.mkdirSync(binariesDir, { recursive: true });
  try {
    await downloadToFile(entry.url, tmp, fetchImpl);
    verifyFileSha256(tmp, entry.sha256, { deleteOnMismatch: true });
    fs.renameSync(tmp, dest);
    return dest;
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}

function runPowerShellScript(script, environment = {}) {
  const encoded = Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    env: { ...process.env, ...environment },
    windowsHide: true,
    stdio: 'inherit',
  });
}

function extractZip(zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  runPowerShellScript(
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:UBU_ZIP, $env:UBU_DEST)',
    { UBU_ZIP: path.resolve(zipPath), UBU_DEST: path.resolve(destDir) },
  );
}

function createZipFromDir(sourceDir, destZip) {
  fs.mkdirSync(path.dirname(destZip), { recursive: true });
  runPowerShellScript(
    `Add-Type -AssemblyName System.IO.Compression
$src = [IO.Path]::GetFullPath($env:UBU_SRC)
$dst = [IO.Path]::GetFullPath($env:UBU_DST)
$stream = [IO.File]::Open($dst, [IO.FileMode]::CreateNew)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
  $files = Get-ChildItem -LiteralPath $src -Recurse -File
  foreach ($f in $files) {
    $rel = $f.FullName.Substring($src.Length).TrimStart('\\', '/').Replace('\\', '/')
    $entry = $zip.CreateEntry($rel, [IO.Compression.CompressionLevel]::Optimal)
    $out = $entry.Open()
    try {
      $in = [IO.File]::OpenRead($f.FullName)
      try { $in.CopyTo($out) } finally { $in.Dispose() }
    } finally { $out.Dispose() }
  }
} finally {
  $zip.Dispose()
  $stream.Dispose()
}`,
    { UBU_SRC: path.resolve(sourceDir), UBU_DST: path.resolve(destZip) },
  );
}

function gitMetadata(repoRoot = ROOT) {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const commit = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const shortCommit = commit.slice(0, 7);
  const dirty = execFileSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  const slot = `${pkg.version}-g${shortCommit}${dirty ? '-dirty' : ''}`;
  return { version: pkg.version, commit, shortCommit, dirty, slot };
}

function trackedRepoFiles(repoRoot = ROOT) {
  const raw = execFileSync('git', ['-C', repoRoot, 'ls-files'], { encoding: 'utf8' });
  return raw
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(file => {
      const full = path.join(repoRoot, file);
      if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
      const inAllowedArea =
        ROOT_WHITELIST.has(file) || /^(assets|shared|server|web|diagnostics|scripts|tests|docs)\//.test(file);
      if (!inAllowedArea) return false;
      if (file === 'config.example.yaml' || file === 'docker-compose.yml') return true;
      if (/(^|\/)\.env($|\.)/.test(file)) return false;
      if (/\.(yaml|yml|key|pem|pfx|p12|sqlite|db|zip|log)$/i.test(file)) return false;
      return true;
    });
}

function isStandaloneAppFile(relPath) {
  if (APP_TOP_LEVEL_FILES.has(relPath)) return true;
  if (APP_DIR_PREFIXES.some(prefix => relPath.startsWith(prefix))) {
    // Exclude maintainer-only build scripts that are not part of runtime app execution if needed, keeping runtime scripts
    return true;
  }
  return false;
}

function verifyVendorAssets(appDir) {
  for (const [relPath, expectedHash] of Object.entries(LIBAV_EXPECTED_HASHES)) {
    const full = path.join(appDir, relPath);
    if (!fs.existsSync(full)) throw new Error(`Missing required UbuPlayer vendor asset: ${relPath}`);
    verifyFileSha256(full, expectedHash, { deleteOnMismatch: false });
  }
  for (const relPath of REQUIRED_APP_ASSETS) {
    const full = path.join(appDir, relPath);
    if (!fs.existsSync(full)) throw new Error(`Missing required standalone asset: ${relPath}`);
  }
}

function timestampSlug(now = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-` +
    `${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

function buildStartBat() {
  return [
    '@echo off',
    'setlocal',
    'set "UBUROOM_EXIT=1"',
    'pushd "%~dp0"',
    'if errorlevel 1 goto fail',
    'set "UBUROOM_PUSHED=1"',
    'if not exist "current.txt" (',
    '  echo [uburoom] Missing current.txt in standalone root.',
    '  goto fail',
    ')',
    'set /p UBUROOM_SLOT=<current.txt',
    'for /f "tokens=* delims= " %%A in ("%UBUROOM_SLOT%") do set "UBUROOM_SLOT=%%A"',
    'set "UBUROOM_NODE=versions\\%UBUROOM_SLOT%\\runtime\\node\\node.exe"',
    'set "UBUROOM_LAUNCHER=versions\\%UBUROOM_SLOT%\\app\\scripts\\launcher.js"',
    'if not exist "%UBUROOM_NODE%" (',
    '  echo [uburoom] Missing bundled Node.js runtime: %UBUROOM_NODE%',
    '  goto fail',
    ')',
    'if not exist "%UBUROOM_LAUNCHER%" (',
    '  echo [uburoom] Missing launcher script: %UBUROOM_LAUNCHER%',
    '  goto fail',
    ')',
    '"%UBUROOM_NODE%" "%UBUROOM_LAUNCHER%" %*',
    'set "UBUROOM_EXIT=%errorlevel%"',
    'if "%UBUROOM_EXIT%"=="0" goto done',
    ':fail',
    'echo [uburoom] Server stopped. Exit code: %UBUROOM_EXIT%',
    'pause',
    ':done',
    'if defined UBUROOM_PUSHED popd',
    'exit /b %UBUROOM_EXIT%',
    '',
  ].join('\r\n');
}

function buildDoctorBat() {
  return [
    '@echo off',
    'setlocal',
    'pushd "%~dp0"',
    'if errorlevel 1 exit /b 1',
    'if not exist "current.txt" (',
    '  echo [uburoom] Missing current.txt in standalone root.',
    '  popd',
    '  exit /b 1',
    ')',
    'set /p UBUROOM_SLOT=<current.txt',
    'for /f "tokens=* delims= " %%A in ("%UBUROOM_SLOT%") do set "UBUROOM_SLOT=%%A"',
    'set "UBUROOM_NODE=versions\\%UBUROOM_SLOT%\\runtime\\node\\node.exe"',
    'set "UBUROOM_DOCTOR=versions\\%UBUROOM_SLOT%\\app\\scripts\\doctor.js"',
    '"%UBUROOM_NODE%" "%UBUROOM_DOCTOR%" --config "%~dp0config\\config.yaml" %*',
    'set "UBUROOM_EXIT=%errorlevel%"',
    'popd',
    'exit /b %UBUROOM_EXIT%',
    '',
  ].join('\r\n');
}

async function archiveCorrespondingSource({ manifest, archiveDir, outDir, meta, stamp, fetchImpl = fetch }) {
  const sourcesDir = path.join(archiveDir, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-src-archive-'));
  const provenance = { generatedAt: new Date().toISOString(), uburoom: meta, artifacts: [] };
  try {
    const ff = manifest.ffmpeg;
    const nodeDep = manifest.node;

    const recordArtifact = (role, url, destPath) => {
      const sha256 = sha256File(destPath);
      const size = fs.statSync(destPath).size;
      provenance.artifacts.push({
        role,
        file: path.relative(sourcesDir, destPath).replace(/\\/g, '/'),
        url,
        sha256,
        size,
      });
      return sha256;
    };

    const ensureSourceFile = async (role, url, fileName) => {
      const dest = path.join(sourcesDir, fileName);
      if (!fs.existsSync(dest)) {
        await downloadToFile(url, dest, fetchImpl);
      }
      recordArtifact(role, url, dest);
      return dest;
    };

    // 1. FFmpeg commit snapshot
    const ffmpegSrcUrl = `https://github.com/FFmpeg/FFmpeg/archive/${ff.gitCommit}.zip`;
    const ffmpegSrcZip = await ensureSourceFile('ffmpeg-source', ffmpegSrcUrl, `ffmpeg-${ff.version}.zip`);

    // 2. FFmpeg-Builds tag snapshot
    const buildsUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/archive/refs/tags/${ff.releaseTag}.zip`;
    const buildsZip = await ensureSourceFile('ffmpeg-builds-recipes', buildsUrl, `FFmpeg-Builds-${ff.releaseTag}.zip`);

    // 3. Node.js source tarball verified against official SHASUMS256.txt
    const shasumsDest = path.join(sourcesDir, `node-${nodeDep.version}-SHASUMS256.txt`);
    if (!fs.existsSync(shasumsDest)) {
      await downloadToFile(nodeDep.shasumsUrl, shasumsDest, fetchImpl);
    }
    const shasumsText = fs.readFileSync(shasumsDest, 'utf8');
    const nodeSourceLine = shasumsText
      .split(/\r?\n/)
      .find(line => line.trim().endsWith(`  ${nodeDep.sourceFile}`) || line.trim().endsWith(` ${nodeDep.sourceFile}`));
    if (!nodeSourceLine) {
      throw new Error(`Could not find ${nodeDep.sourceFile} checksum in ${nodeDep.shasumsUrl}`);
    }
    const expectedNodeSrcSha = nodeSourceLine.trim().split(/\s+/)[0];
    const nodeSrcDest = path.join(sourcesDir, nodeDep.sourceFile);
    if (!fs.existsSync(nodeSrcDest)) {
      await downloadToFile(nodeDep.sourceUrl, nodeSrcDest, fetchImpl);
    }
    verifyFileSha256(nodeSrcDest, expectedNodeSrcSha, { deleteOnMismatch: true });
    recordArtifact('node-source', nodeDep.sourceUrl, nodeSrcDest);
    recordArtifact('node-shasums', nodeDep.shasumsUrl, shasumsDest);

    // Stage into archive zip directory
    const stageSrc = path.join(stage, 'corresponding-source');
    const stageUpstream = path.join(stageSrc, 'upstream');
    const stageUburoom = path.join(stageSrc, 'uburoom');
    fs.mkdirSync(stageUpstream, { recursive: true });
    fs.mkdirSync(stageUburoom, { recursive: true });

    fs.copyFileSync(ffmpegSrcZip, path.join(stageUpstream, path.basename(ffmpegSrcZip)));
    fs.copyFileSync(buildsZip, path.join(stageUpstream, path.basename(buildsZip)));
    fs.copyFileSync(nodeSrcDest, path.join(stageUpstream, path.basename(nodeSrcDest)));
    fs.copyFileSync(shasumsDest, path.join(stageUpstream, path.basename(shasumsDest)));

    // Copy any already-archived dependency snapshots from sourcesDir/deps if populated
    const depsDir = path.join(sourcesDir, 'deps');
    if (fs.existsSync(depsDir)) {
      fs.cpSync(depsDir, path.join(stageUpstream, 'deps'), { recursive: true });
      for (const name of fs.readdirSync(depsDir).sort()) {
        const full = path.join(depsDir, name);
        if (fs.statSync(full).isFile()) {
          recordArtifact('ffmpeg-static-dependency', 'FFmpeg-Builds scripts.d', full);
        }
      }
    }

    for (const file of trackedRepoFiles(ROOT)) {
      const dest = path.join(stageUburoom, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), dest);
    }

    const provenanceFile = path.join(sourcesDir, 'SOURCE_PROVENANCE.json');
    fs.writeFileSync(provenanceFile, JSON.stringify(provenance, null, 2) + '\n');
    fs.writeFileSync(path.join(stageSrc, 'SOURCE_PROVENANCE.json'), JSON.stringify(provenance, null, 2) + '\n');

    const destZip = path.join(outDir, `uburoom-corresponding-source-${meta.slot}_${stamp}.zip`);
    createZipFromDir(stageSrc, destZip);
    return { zipPath: destZip, provenance };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function findSingleSubdir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory());
  if (entries.length === 1) return path.join(dir, entries[0].name);
  return dir;
}

function buildBuildInfo({ meta, manifest, nodeExeSha, ffmpegSha, ffprobeSha, ffmpegVerification }) {
  return {
    uburoom: {
      version: meta.version,
      commit: meta.commit,
      shortCommit: meta.shortCommit,
      dirty: meta.dirty,
      slot: meta.slot,
      builtAt: new Date().toISOString(),
      target: 'win32-x64',
    },
    dependencies: {
      node: {
        ...manifest.node,
        extractedSha256: {
          'runtime/node/node.exe': nodeExeSha,
        },
      },
      ffmpeg: {
        ...manifest.ffmpeg,
        extractedSha256: {
          'runtime/ffmpeg/ffmpeg.exe': ffmpegSha,
          'runtime/ffmpeg/ffprobe.exe': ffprobeSha,
        },
        verification: ffmpegVerification,
      },
    },
  };
}

function buildThirdPartyNotices({ nodeLicensePath, ffmpegLicensePath }) {
  const parts = [
    'uburoom Windows x64 Standalone Bundle — Third-Party Notices and Corresponding Source',
    '===================================================================================',
    '',
    'First-party uburoom code is licensed under GPL-3.0-only (see LICENSE).',
    'Bundled FFmpeg static binaries are licensed under GPL-3.0-or-later.',
    'Bundled Node.js runtime binaries are licensed under the MIT License.',
    '',
  ];
  for (const [label, filePath] of [
    ['Web Vendor Notices (web/vendor/THIRD_PARTY_NOTICES.txt)', path.join(ROOT, 'web/vendor/THIRD_PARTY_NOTICES.txt')],
    [
      'Subtitle Vendor Notices (web/vendor/subtitles/THIRD_PARTY_NOTICES.txt)',
      path.join(ROOT, 'web/vendor/subtitles/THIRD_PARTY_NOTICES.txt'),
    ],
    [
      'Libav Vendor Notices (web/vendor/libav/THIRD_PARTY_NOTICES.txt)',
      path.join(ROOT, 'web/vendor/libav/THIRD_PARTY_NOTICES.txt'),
    ],
    ['Node.js v22.23.5 LICENSE', nodeLicensePath],
    ['FFmpeg GPLv3 LICENSE.txt', ffmpegLicensePath],
  ]) {
    if (filePath && fs.existsSync(filePath)) {
      parts.push(`--- ${label} ---`, fs.readFileSync(filePath, 'utf8').trim(), '');
    }
  }
  return parts.join('\n');
}

async function packageStandalone({
  archiveDir = path.join(ROOT, 'releases', 'vendor-archive'),
  outDir = path.join(ROOT, 'releases'),
  requireNvenc = false,
  requireQsv = false,
  skipSourceArchive = false,
  fetchImpl = fetch,
} = {}) {
  const rawManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const manifest = validateManifest(rawManifest);
  const meta = gitMetadata(ROOT);
  const stamp = timestampSlug();

  const binariesDir = path.join(archiveDir, 'binaries');
  const nodeZip = await ensureCachedBinary(manifest.node, binariesDir, { fetchImpl });
  const ffmpegZip = await ensureCachedBinary(manifest.ffmpeg, binariesDir, { fetchImpl });

  fs.writeFileSync(
    path.join(binariesDir, 'SHA256SUMS.txt'),
    [
      `${manifest.node.sha256} *${manifest.node.archiveFile}`,
      `${manifest.ffmpeg.sha256} *${manifest.ffmpeg.archiveFile}`,
      '',
    ].join('\n'),
  );

  let sourceArchive = null;
  if (!skipSourceArchive) {
    sourceArchive = await archiveCorrespondingSource({ manifest, archiveDir, outDir, meta, stamp, fetchImpl });
  }

  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-standalone-stage-'));
  try {
    const portableRoot = path.join(stage, 'portable');
    const slotDir = path.join(portableRoot, 'versions', meta.slot);
    const nodeRuntimeDir = path.join(slotDir, 'runtime', 'node');
    const ffmpegRuntimeDir = path.join(slotDir, 'runtime', 'ffmpeg');
    const appDir = path.join(slotDir, 'app');

    fs.mkdirSync(nodeRuntimeDir, { recursive: true });
    fs.mkdirSync(ffmpegRuntimeDir, { recursive: true });
    fs.mkdirSync(appDir, { recursive: true });

    // Extract Node.js
    const nodeExtract = path.join(stage, 'extract-node');
    extractZip(nodeZip, nodeExtract);
    const nodeRoot = findSingleSubdir(nodeExtract);
    const nodeExeSrc = path.join(nodeRoot, 'node.exe');
    const nodeLicenseSrc = path.join(nodeRoot, 'LICENSE');
    if (!fs.existsSync(nodeExeSrc)) throw new Error('Extracted Node archive missing node.exe');
    fs.copyFileSync(nodeExeSrc, path.join(nodeRuntimeDir, 'node.exe'));
    if (fs.existsSync(nodeLicenseSrc)) fs.copyFileSync(nodeLicenseSrc, path.join(nodeRuntimeDir, 'LICENSE'));

    const nodeVersionOut = execFileSync(path.join(nodeRuntimeDir, 'node.exe'), ['-v'], { encoding: 'utf8' }).trim();
    if (nodeVersionOut !== manifest.node.version) {
      throw new Error(`Bundled node.exe version mismatch: expected ${manifest.node.version}, got ${nodeVersionOut}`);
    }

    // Extract FFmpeg
    const ffExtract = path.join(stage, 'extract-ffmpeg');
    extractZip(ffmpegZip, ffExtract);
    const ffRoot = findSingleSubdir(ffExtract);
    const ffmpegExeSrc = path.join(ffRoot, 'bin', 'ffmpeg.exe');
    const ffprobeExeSrc = path.join(ffRoot, 'bin', 'ffprobe.exe');
    const ffLicenseSrc = path.join(ffRoot, 'LICENSE.txt');
    if (!fs.existsSync(ffmpegExeSrc) || !fs.existsSync(ffprobeExeSrc)) {
      throw new Error('Extracted FFmpeg archive missing bin/ffmpeg.exe or bin/ffprobe.exe');
    }
    const ffmpegExeDest = path.join(ffmpegRuntimeDir, 'ffmpeg.exe');
    const ffprobeExeDest = path.join(ffmpegRuntimeDir, 'ffprobe.exe');
    const ffLicenseDest = path.join(ffmpegRuntimeDir, 'LICENSE.txt');
    fs.copyFileSync(ffmpegExeSrc, ffmpegExeDest);
    fs.copyFileSync(ffprobeExeSrc, ffprobeExeDest);
    if (fs.existsSync(ffLicenseSrc)) fs.copyFileSync(ffLicenseSrc, ffLicenseDest);

    // Run mandatory FFmpeg capability & licensing gate
    const ffmpegVerification = await verifyFfmpeg({
      ffmpegPath: ffmpegExeDest,
      ffprobePath: ffprobeExeDest,
      licenseFile: fs.existsSync(ffLicenseDest) ? ffLicenseDest : undefined,
      expectedVersion: manifest.ffmpeg.version,
      requireNvenc,
      requireQsv,
    });

    // Stage app files
    for (const file of trackedRepoFiles(ROOT)) {
      if (!isStandaloneAppFile(file)) continue;
      const dest = path.join(appDir, file);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(ROOT, file), dest);
    }

    // Install production-only pure-JS node_modules
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts'], {
      cwd: appDir,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    // Verify UbuPlayer libav hashes, subtitle WASM, Discord SDK, and hls.js
    verifyVendorAssets(appDir);

    const buildInfo = buildBuildInfo({
      meta,
      manifest,
      nodeExeSha: sha256File(path.join(nodeRuntimeDir, 'node.exe')),
      ffmpegSha: sha256File(ffmpegExeDest),
      ffprobeSha: sha256File(ffprobeExeDest),
      ffmpegVerification,
    });

    fs.writeFileSync(path.join(slotDir, 'BUILD_INFO.json'), JSON.stringify(buildInfo, null, 2) + '\n');
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(slotDir, 'LICENSE'));
    fs.writeFileSync(
      path.join(slotDir, 'THIRD_PARTY_NOTICES.txt'),
      buildThirdPartyNotices({
        nodeLicensePath: path.join(nodeRuntimeDir, 'LICENSE'),
        ffmpegLicensePath: ffLicenseDest,
      }),
    );

    fs.writeFileSync(path.join(portableRoot, 'current.txt'), `${meta.slot}\n`);
    fs.writeFileSync(path.join(portableRoot, 'start-uburoom.bat'), buildStartBat());
    fs.writeFileSync(path.join(portableRoot, 'doctor.bat'), buildDoctorBat());

    const bundleZip = path.join(outDir, `uburoom-win-x64-${meta.slot}_${stamp}.zip`);
    createZipFromDir(portableRoot, bundleZip);
    const bundleSha = sha256File(bundleZip);

    return {
      bundleZip,
      bundleSha,
      correspondingSourceZip: sourceArchive?.zipPath || null,
      slot: meta.slot,
      buildInfo,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--archive-dir') opts.archiveDir = path.resolve(argv[++i]);
    else if (arg === '--out-dir') opts.outDir = path.resolve(argv[++i]);
    else if (arg === '--require-nvenc') opts.requireNvenc = true;
    else if (arg === '--require-qsv') opts.requireQsv = true;
    else if (arg === '--skip-source-archive') opts.skipSourceArchive = true;
  }
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  packageStandalone(opts)
    .then(result => {
      console.log(`[package-standalone] Built: ${result.bundleZip} (sha256: ${result.bundleSha})`);
      if (result.correspondingSourceZip) {
        console.log(`[package-standalone] Corresponding Source: ${result.correspondingSourceZip}`);
      }
    })
    .catch(err => {
      console.error(`[package-standalone] FAIL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  LIBAV_EXPECTED_HASHES,
  REQUIRED_APP_ASSETS,
  sha256File,
  validateManifest,
  verifyFileSha256,
  ensureCachedBinary,
  verifyVendorAssets,
  buildBuildInfo,
  packageStandalone,
};
