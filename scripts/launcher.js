#!/usr/bin/env node
'use strict';
/**
 * Plain-JS visible-console supervisor for uburoom standalone slots (versions/<slot>/app/scripts/launcher.js).
 * Resolves the active slot from <portable-root>/current.txt, prepends slot runtime/ffmpeg and runtime/node
 * to PATH, defaults --config to <portable-root>/config/config.yaml, opens the first-run setup URL once via
 * private Node IPC (unless --no-browser), forwards termination signals, and respawns on exit code 75.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RESTART_EXIT_CODE = 75;
const SLOT_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESTART_SETTLE_MS = 250;

function readActiveSlot(currentFile) {
  const raw = fs.readFileSync(currentFile, 'utf8').trim();
  if (!raw || raw === '.' || raw === '..' || !SLOT_PATTERN.test(raw)) {
    throw new Error(`Invalid active slot in ${currentFile}`);
  }
  return raw;
}

function prependPath(environment, dirs) {
  const existing = dirs.filter(dir => fs.existsSync(dir));
  if (!existing.length) return environment;
  const next = { ...environment };
  const pathKey = Object.keys(next).find(key =>
    process.platform === 'win32' ? key.toUpperCase() === 'PATH' : key === 'PATH',
  );
  const current = pathKey ? next[pathKey] : '';
  const combined = [...existing, ...(current ? [current] : [])].join(path.delimiter);
  next[pathKey || 'PATH'] = combined;
  return next;
}

function hasConfigFlag(args) {
  return args.some(arg => arg === '--config' || arg.startsWith('--config='));
}

function resolveLaunchTarget(baseDir = path.resolve(__dirname, '..'), args = process.argv.slice(2)) {
  const portableRoot = path.resolve(baseDir, '../../..');
  const currentFile = path.join(portableRoot, 'current.txt');
  const forwardedArgs = args.filter(arg => arg !== '--no-browser');
  const noBrowser = args.includes('--no-browser');
  if (!fs.existsSync(currentFile)) {
    const indexJs = path.join(baseDir, 'server', 'index.js');
    return {
      portableRoot: baseDir,
      slot: null,
      appDir: baseDir,
      indexJs,
      nodeExe: process.execPath,
      childArgs: forwardedArgs,
      env: process.env,
      noBrowser,
    };
  }
  const slot = readActiveSlot(currentFile);
  const slotDir = path.join(portableRoot, 'versions', slot);
  const appDir = path.join(slotDir, 'app');
  const indexJs = path.join(appDir, 'server', 'index.js');
  if (!fs.existsSync(indexJs)) {
    throw new Error(`Missing server entry point in slot ${slot}: ${indexJs}`);
  }
  const nodeCandidate = path.join(slotDir, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
  const nodeExe = fs.existsSync(nodeCandidate) ? nodeCandidate : process.execPath;
  const runtimeDirs = [path.join(slotDir, 'runtime', 'ffmpeg'), path.join(slotDir, 'runtime', 'node')];
  const childArgs = hasConfigFlag(forwardedArgs)
    ? forwardedArgs
    : [...forwardedArgs, '--config', path.join(portableRoot, 'config', 'config.yaml')];
  return {
    portableRoot,
    slot,
    appDir,
    indexJs,
    nodeExe,
    childArgs,
    env: prependPath(process.env, runtimeDirs),
    noBrowser,
  };
}

function openBrowser(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return;
  try {
    if (process.platform === 'win32') {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', 'Start-Process $env:UBUROOM_OPEN_URL'],
        {
          env: { ...process.env, UBUROOM_OPEN_URL: url },
          stdio: 'ignore',
          detached: true,
          windowsHide: true,
        },
      );
      child.on('error', () => {});
      child.unref();
      return;
    }
    const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(command, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

function runLauncher(baseDir = path.resolve(__dirname, '..'), args = process.argv.slice(2)) {
  let stopping = false;
  let browserOpened = false;
  let child = null;
  let respawnTimer = null;

  const forwardSignal = signal => {
    stopping = true;
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
      process.exit(0);
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill(signal);
      } catch {}
    }
  };
  process.on('SIGINT', () => forwardSignal('SIGINT'));
  process.on('SIGTERM', () => forwardSignal('SIGTERM'));
  process.on('SIGHUP', () => forwardSignal('SIGHUP'));

  function launch() {
    let target;
    try {
      target = resolveLaunchTarget(baseDir, args);
    } catch (error) {
      process.stderr.write(`[uburoom] ${error.message}\n`);
      process.exit(1);
      return;
    }
    child = spawn(target.nodeExe, [target.indexJs, ...target.childArgs], {
      cwd: target.appDir,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: target.env,
    });
    child.on('message', message => {
      if (
        !browserOpened &&
        !target.noBrowser &&
        message &&
        message.type === 'uburoom:setup-ready' &&
        typeof message.url === 'string'
      ) {
        browserOpened = true;
        openBrowser(message.url);
      }
    });
    child.on('error', error => {
      process.stderr.write(`[uburoom] Failed to start server: ${error.message}\n`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      child = null;
      if (stopping) {
        process.exit(typeof code === 'number' ? code : 0);
        return;
      }
      if (code === RESTART_EXIT_CODE) {
        process.stdout.write('[uburoom] Restarting uburoom...\n');
        respawnTimer = setTimeout(() => {
          respawnTimer = null;
          launch();
        }, RESTART_SETTLE_MS);
        return;
      }
      if (code === 0) {
        process.exit(0);
        return;
      }
      const status = code !== null ? code : signal || 1;
      process.stderr.write(`[uburoom] Server stopped with exit code ${status}.\n`);
      process.exit(typeof code === 'number' && code !== 0 ? code : 1);
    });
  }

  launch();
}

if (require.main === module) {
  runLauncher();
}

module.exports = { RESTART_EXIT_CODE, readActiveSlot, prependPath, resolveLaunchTarget, openBrowser, runLauncher };
