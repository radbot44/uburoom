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
        ROOT_WHITELIST.has(file) ||
        /^(assets|shared|server|web|diagnostics|scripts|tests|docs|tools|installer)\//.test(file);
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
    '"%UBUROOM_NODE%" --no-warnings=ExperimentalWarning "%UBUROOM_LAUNCHER%" %*',
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
    '"%UBUROOM_NODE%" --no-warnings=ExperimentalWarning "%UBUROOM_DOCTOR%" --config "%~dp0config\\config.yaml" %*',
    'set "UBUROOM_EXIT=%errorlevel%"',
    'popd',
    'exit /b %UBUROOM_EXIT%',
    '',
  ].join('\r\n');
}

function buildTrayLauncher(outExePath, { repoRoot = ROOT, iconPath } = {}) {
  const buildScript = path.join(repoRoot, 'tools', 'tray-win', 'build.ps1');
  if (!fs.existsSync(buildScript)) {
    throw new Error(`Missing tray build script: ${buildScript}`);
  }
  const resolvedIcon = iconPath || path.join(repoRoot, 'web', 'assets', 'uburoom-favicon.ico');
  if (!fs.existsSync(resolvedIcon)) {
    throw new Error(`Missing tray icon file: ${resolvedIcon}`);
  }
  const resolvedOut = path.resolve(outExePath);
  fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      buildScript,
      '-OutPath',
      resolvedOut,
      '-IconPath',
      path.resolve(resolvedIcon),
    ],
    { windowsHide: true, stdio: 'inherit' },
  );
  if (!fs.existsSync(resolvedOut) || fs.statSync(resolvedOut).size === 0) {
    throw new Error(`Tray launcher build did not produce ${resolvedOut}`);
  }
  return { exePath: resolvedOut, sha256: sha256File(resolvedOut) };
}

function findIscc() {
  if (process.env.ISCC_EXE && fs.existsSync(process.env.ISCC_EXE)) {
    return process.env.ISCC_EXE;
  }
  const candidates = [
    'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe',
    'C:\\Program Files\\Inno Setup 6\\ISCC.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Inno Setup 6', 'ISCC.exe') : '',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.platform === 'win32') {
    try {
      const found = execFileSync('where.exe', ['iscc.exe'], {
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
        .split(/\r?\n/)
        .map(line => line.trim())
        .find(line => line && fs.existsSync(line));
      if (found) return found;
    } catch {}
  }
  return null;
}

function buildInstallerArgs({
  issFile,
  version,
  slot,
  sourceDir,
  iconFile,
  licenseFile,
  outputDir,
  outputBaseFilename,
}) {
  return [
    `/DAppVersion=${version}`,
    `/DAppSlot=${slot}`,
    `/DSourceDir=${path.resolve(sourceDir)}`,
    `/DIconFile=${path.resolve(iconFile)}`,
    `/DLicenseFile=${path.resolve(licenseFile)}`,
    `/DOutputDir=${path.resolve(outputDir)}`,
    `/DOutputBaseFilename=${outputBaseFilename}`,
    path.resolve(issFile),
  ];
}

function buildInstaller({
  sourceDir,
  version,
  slot,
  outDir,
  outputBaseFilename = `uburoom-${slot}-setup`,
  repoRoot = ROOT,
  isccPath = null,
}) {
  const iscc = isccPath || findIscc();
  if (!iscc) {
    throw new Error('Inno Setup compiler (ISCC.exe) not found. Install Inno Setup 6 or set ISCC_EXE.');
  }
  const issFile = path.join(repoRoot, 'installer', 'uburoom.iss');
  const iconFile = path.join(repoRoot, 'web', 'assets', 'uburoom-favicon.ico');
  const licenseFile = path.join(repoRoot, 'LICENSE');
  for (const [label, filePath] of [
    ['installer script', issFile],
    ['installer icon', iconFile],
    ['license file', licenseFile],
  ]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing required ${label}: ${filePath}`);
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  const args = buildInstallerArgs({
    issFile,
    version,
    slot,
    sourceDir,
    iconFile,
    licenseFile,
    outputDir: outDir,
    outputBaseFilename,
  });
  execFileSync(iscc, args, { windowsHide: true, stdio: 'inherit' });
  const installerExe = path.join(outDir, `${outputBaseFilename}.exe`);
  if (!fs.existsSync(installerExe) || fs.statSync(installerExe).size === 0) {
    throw new Error(`Inno Setup did not produce expected installer: ${installerExe}`);
  }
  return { installerExe, installerSha: sha256File(installerExe) };
}

function findBashExe() {
  if (process.platform !== 'win32') return 'bash';
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'bash.exe',
  ];
  return candidates.find(candidate => candidate === 'bash.exe' || fs.existsSync(candidate));
}

function resolveFfmpegBuildDeps(ffbRoot, stageDir) {
  const bashExe = findBashExe();
  const listScript = path.join(stageDir, 'list-deps.sh');
  fs.writeFileSync(
    listScript,
    [
      'set -e',
      'cd "$1"',
      'source util/vars.sh win64 gpl 8.1',
      'for s in scripts.d/*.sh scripts.d/*/*.sh; do',
      '  SCRIPT_REPO=""',
      '  SCRIPT_COMMIT=""',
      '  SCRIPT_MIRROR=""',
      '  SCRIPT_REPO2=""',
      '  SCRIPT_COMMIT2=""',
      '  SCRIPT_MIRROR2=""',
      '  SCRIPT_SKIP=""',
      '  ffbuild_enabled() { return 0; }',
      '  source "$s"',
      '  if [ -z "$SCRIPT_SKIP" ] && ffbuild_enabled >/dev/null 2>&1 && [ -n "$SCRIPT_REPO" ]; then',
      '    printf "%s|%s|%s|%s|%s|%s|%s\\n" "$s" "$SCRIPT_REPO" "$SCRIPT_COMMIT" "$SCRIPT_MIRROR" "$SCRIPT_REPO2" "$SCRIPT_COMMIT2" "$SCRIPT_MIRROR2"',
      '  fi',
      'done',
      '',
    ].join('\n'),
  );
  const unixRoot = ffbRoot.replace(/\\/g, '/');
  const unixScript = listScript.replace(/\\/g, '/');
  const raw = execFileSync(bashExe, [unixScript, unixRoot], { encoding: 'utf8', windowsHide: true });
  const deps = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [scriptPath, repo, commit, mirror, repo2, commit2, mirror2] = line.split('|');
    const baseName = path.basename(scriptPath, '.sh').replace(/^\d+-/, '');
    if (repo && commit) {
      deps.push({ name: baseName, scriptPath, repo, commit, mirror });
    }
    if (repo2 && commit2) {
      deps.push({ name: `${baseName}-extra`, scriptPath, repo: repo2, commit: commit2, mirror: mirror2 });
    }
  }
  return deps;
}

function directArchiveCandidates(repo, commit) {
  const cleanRepo = repo.replace(/\.git$/i, '').replace(/\/+$/, '');
  const urls = [];
  if (/^https:\/\/github\.com\/[^/]+\/[^/]+$/i.test(cleanRepo)) {
    urls.push(`${cleanRepo}/archive/${commit}.tar.gz`);
  } else if (/^https:\/\/(?:gitlab\.freedesktop\.org|code\.videolan\.org)\//i.test(cleanRepo)) {
    const project = path.basename(cleanRepo);
    urls.push(`${cleanRepo}/-/archive/${commit}/${project}-${commit}.tar.gz`);
  }
  return urls;
}

async function fetchDepSourceTarball(dep, destPath, stageDir, fetchImpl = fetch) {
  if (fs.existsSync(destPath) && fs.statSync(destPath).size > 0) return destPath;
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const tmpFile = `${destPath}.tmp-${process.pid}`;
  try {
    for (const url of directArchiveCandidates(dep.repo, dep.commit)) {
      try {
        const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) {
          fs.writeFileSync(tmpFile, buf);
          fs.renameSync(tmpFile, destPath);
          return destPath;
        }
      } catch {}
    }

    const repos = [dep.mirror, dep.repo].filter(Boolean);
    for (const repoUrl of repos) {
      const gitDir = fs.mkdtempSync(path.join(stageDir, 'git-'));
      try {
        execFileSync('git', ['init', '--quiet', gitDir], { windowsHide: true, stdio: 'ignore' });
        let fetched = false;
        try {
          execFileSync('git', ['-C', gitDir, 'fetch', '--quiet', '--depth=1', repoUrl, dep.commit], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 180000,
          });
          fetched = true;
        } catch {
          try {
            execFileSync('git', ['-C', gitDir, 'fetch', '--quiet', repoUrl], {
              windowsHide: true,
              stdio: 'ignore',
              timeout: 300000,
            });
            fetched = true;
          } catch {}
        }
        if (fetched) {
          execFileSync('git', ['-C', gitDir, 'archive', '--format=tar.gz', '-o', tmpFile, dep.commit], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 60000,
          });
          if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
            fs.renameSync(tmpFile, destPath);
            return destPath;
          }
        }
      } catch {
      } finally {
        fs.rmSync(gitDir, { recursive: true, force: true });
      }
    }
    throw new Error(`Could not archive Corresponding Source for ${dep.name} (${dep.repo} @ ${dep.commit})`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

async function runPool(items, limit, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

async function archiveCorrespondingSource({ manifest, archiveDir, outDir, meta, stamp, fetchImpl = fetch }) {
  const sourcesDir = path.join(archiveDir, 'sources');
  fs.mkdirSync(sourcesDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-src-archive-'));
  const provenance = { generatedAt: new Date().toISOString(), uburoom: meta, artifacts: [] };
  try {
    const ff = manifest.ffmpeg;
    const nodeDep = manifest.node;

    const recordArtifact = (role, url, destPath, extra = {}) => {
      const sha256 = sha256File(destPath);
      const size = fs.statSync(destPath).size;
      provenance.artifacts.push({
        role,
        file: path.relative(sourcesDir, destPath).replace(/\\/g, '/'),
        url,
        sha256,
        size,
        ...extra,
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

    // 2. FFmpeg-Builds tag snapshot + statically linked win64-gpl-8.1 dependency snapshots
    const buildsUrl = `https://github.com/FFmpeg-Builds/FFmpeg-Builds/archive/refs/tags/${ff.releaseTag}.zip`;
    const buildsZip = await ensureSourceFile('ffmpeg-builds-recipes', buildsUrl, `FFmpeg-Builds-${ff.releaseTag}.zip`);

    const ffbExtract = path.join(stage, 'ffb');
    extractZip(buildsZip, ffbExtract);
    const ffbRoot = findSingleSubdir(ffbExtract);
    const deps = resolveFfmpegBuildDeps(ffbRoot, stage);
    const depsDir = path.join(sourcesDir, 'deps');
    fs.mkdirSync(depsDir, { recursive: true });

    const depResults = new Array(deps.length);
    await runPool(deps, 6, async (dep, idx) => {
      const safeCommit = dep.commit.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 16);
      const fileName = `${dep.name}-${safeCommit}.tar.gz`;
      const destPath = path.join(depsDir, fileName);
      await fetchDepSourceTarball(dep, destPath, stage, fetchImpl);
      depResults[idx] = { dep, destPath };
    });
    for (const item of depResults) {
      recordArtifact('ffmpeg-static-dependency', item.dep.repo, item.destPath, {
        name: item.dep.name,
        commit: item.dep.commit,
        recipe: item.dep.scriptPath,
      });
    }

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

    const stageDeps = path.join(stageUpstream, 'deps');
    fs.mkdirSync(stageDeps, { recursive: true });
    for (const item of depResults) {
      fs.copyFileSync(item.destPath, path.join(stageDeps, path.basename(item.destPath)));
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

function buildBuildInfo({ meta, manifest, nodeExeSha, ffmpegSha, ffprobeSha, trayExeSha, ffmpegVerification }) {
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
    ...(trayExeSha
      ? {
          launcher: {
            file: 'uburoom-tray.exe',
            sha256: trayExeSha,
          },
        }
      : {}),
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
  requireVulkan = true,
  skipSourceArchive = false,
  buildInstallerExe = false,
  installerName = null,
  trayExePath = null,
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
    if (!fs.existsSync(ffmpegExeSrc) || !fs.existsSync(ffprobeExeSrc) || !fs.existsSync(ffLicenseSrc)) {
      throw new Error('Extracted FFmpeg archive missing bin/ffmpeg.exe, bin/ffprobe.exe, or LICENSE.txt');
    }
    const ffmpegExeDest = path.join(ffmpegRuntimeDir, 'ffmpeg.exe');
    const ffprobeExeDest = path.join(ffmpegRuntimeDir, 'ffprobe.exe');
    const ffLicenseDest = path.join(ffmpegRuntimeDir, 'LICENSE.txt');
    fs.copyFileSync(ffmpegExeSrc, ffmpegExeDest);
    fs.copyFileSync(ffprobeExeSrc, ffprobeExeDest);
    fs.copyFileSync(ffLicenseSrc, ffLicenseDest);

    // Run mandatory FFmpeg capability & licensing gate
    const ffmpegVerification = await verifyFfmpeg({
      ffmpegPath: ffmpegExeDest,
      ffprobePath: ffprobeExeDest,
      licenseFile: ffLicenseDest,
      expectedVersion: manifest.ffmpeg.version,
      requireNvenc,
      requireQsv,
      requireVulkan,
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

    // Build (or copy pre-built/pre-signed) native Windows system-tray launcher alongside start-uburoom.bat and doctor.bat
    const trayExeDest = path.join(portableRoot, 'uburoom-tray.exe');
    let trayExeSha;
    if (trayExePath) {
      fs.copyFileSync(path.resolve(trayExePath), trayExeDest);
      trayExeSha = sha256File(trayExeDest);
    } else {
      trayExeSha = buildTrayLauncher(trayExeDest, { repoRoot: ROOT }).sha256;
    }

    const buildInfo = buildBuildInfo({
      meta,
      manifest,
      nodeExeSha: sha256File(path.join(nodeRuntimeDir, 'node.exe')),
      ffmpegSha: sha256File(ffmpegExeDest),
      ffprobeSha: sha256File(ffprobeExeDest),
      trayExeSha,
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
    // Place key user-facing docs at the portable root so paths referenced by the setup wizard exist out of the box.
    fs.copyFileSync(path.join(ROOT, 'README.md'), path.join(portableRoot, 'README.md'));
    fs.copyFileSync(path.join(ROOT, 'LICENSE'), path.join(portableRoot, 'LICENSE'));
    const remoteAccessDoc = path.join(ROOT, 'docs', 'remote-access.md');
    if (fs.existsSync(remoteAccessDoc)) {
      fs.mkdirSync(path.join(portableRoot, 'docs'), { recursive: true });
      fs.copyFileSync(remoteAccessDoc, path.join(portableRoot, 'docs', 'remote-access.md'));
    }

    const bundleZip = path.join(outDir, `uburoom-win-x64-${meta.slot}_${stamp}.zip`);
    createZipFromDir(portableRoot, bundleZip);
    const bundleSha = sha256File(bundleZip);

    let installer = null;
    if (buildInstallerExe) {
      installer = buildInstaller({
        sourceDir: portableRoot,
        version: meta.version,
        slot: meta.slot,
        outDir,
        outputBaseFilename: installerName || `uburoom-${meta.slot}-setup`,
        repoRoot: ROOT,
      });
    }

    return {
      bundleZip,
      bundleSha,
      installerExe: installer?.installerExe || null,
      installerSha: installer?.installerSha || null,
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
    else if (arg === '--allow-no-vulkan') opts.requireVulkan = false;
    else if (arg === '--skip-source-archive') opts.skipSourceArchive = true;
    else if (arg === '--installer') opts.buildInstallerExe = true;
    else if (arg === '--installer-name') opts.installerName = argv[++i];
    else if (arg === '--tray-exe') opts.trayExePath = path.resolve(argv[++i]);
  }
  return opts;
}

if (require.main === module) {
  const opts = parseArgs(process.argv.slice(2));
  packageStandalone(opts)
    .then(result => {
      console.log(`[package-standalone] Built: ${result.bundleZip} (sha256: ${result.bundleSha})`);
      if (result.installerExe) {
        console.log(`[package-standalone] Installer: ${result.installerExe} (sha256: ${result.installerSha})`);
      }
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
  buildTrayLauncher,
  findIscc,
  buildInstallerArgs,
  buildInstaller,
  buildBuildInfo,
  packageStandalone,
};
