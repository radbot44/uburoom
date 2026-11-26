#!/usr/bin/env node
'use strict';
/**
 * Plain-JS supervisor for uburoom standalone slots (versions/<slot>/app/scripts/launcher.js).
 * Resolves the active slot from <portable-root>/current.txt, prepends slot runtime/ffmpeg and runtime/node
 * to PATH, defaults --config to <portable-root>/config/config.yaml, opens the active setup/server URL once
 * via private Node IPC (unless --no-browser), optionally reports status and accepts clean shutdown/restart
 * commands over --tray-pipe (used by uburoom-tray.exe), forwards termination signals, and respawns on exit 75.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');

const RESTART_EXIT_CODE = 75;
const SLOT_PATTERN = /^[A-Za-z0-9._-]+$/;
const RESTART_SETTLE_MS = 250;
const SHUTDOWN_GRACE_MS = 15000;

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

function parseLauncherArgs(args) {
  const forwardedArgs = [];
  let noBrowser = false;
  let trayPipe = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--no-browser') {
      noBrowser = true;
      continue;
    }
    if (arg === '--tray-pipe') {
      const value = args[i + 1];
      if (typeof value === 'string' && value.trim()) {
        trayPipe = value.trim();
        i++;
      }
      continue;
    }
    if (arg.startsWith('--tray-pipe=')) {
      const value = arg.slice('--tray-pipe='.length).trim();
      if (value) trayPipe = value;
      continue;
    }
    forwardedArgs.push(arg);
  }
  return { forwardedArgs, noBrowser, trayPipe };
}

function resolveLaunchTarget(baseDir = path.resolve(__dirname, '..'), args = process.argv.slice(2)) {
  const portableRoot = path.resolve(baseDir, '../../..');
  const currentFile = path.join(portableRoot, 'current.txt');
  const { forwardedArgs, noBrowser, trayPipe } = parseLauncherArgs(args);
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
      trayPipe,
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
    trayPipe,
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

function connectTrayPipe(pipePath, { onCommand, onDisconnect } = {}) {
  if (!pipePath) return null;
  let connected = false;
  let closedIntentionally = false;
  let buffer = '';
  const pending = [];
  const socket = net.connect(pipePath);
  socket.setEncoding('utf8');

  const writeLine = payload => {
    const line = `${JSON.stringify(payload)}\n`;
    if (connected && !socket.destroyed) {
      try {
        socket.write(line);
      } catch {}
    } else if (!closedIntentionally && pending.length < 32) {
      pending.push(line);
    }
  };

  socket.on('connect', () => {
    connected = true;
    while (pending.length > 0 && !socket.destroyed) {
      try {
        socket.write(pending.shift());
      } catch {
        break;
      }
    }
  });

  socket.on('data', chunk => {
    buffer += chunk;
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message && typeof message === 'object' && typeof onCommand === 'function') {
          onCommand(message);
        }
      } catch {}
    }
  });

  socket.on('error', () => {});
  socket.on('close', () => {
    if (connected && !closedIntentionally && typeof onDisconnect === 'function') {
      onDisconnect();
    }
  });

  return {
    send: writeLine,
    close() {
      closedIntentionally = true;
      try {
        socket.end();
      } catch {}
    },
  };
}

function runLauncher(baseDir = path.resolve(__dirname, '..'), args = process.argv.slice(2)) {
  const { trayPipe } = parseLauncherArgs(args);
  let stopping = false;
  let restarting = false;
  let browserOpened = false;
  let child = null;
  let respawnTimer = null;
  let killFallbackTimer = null;
  let tray = null;

  const clearKillFallback = () => {
    if (killFallbackTimer) {
      clearTimeout(killFallbackTimer);
      killFallbackTimer = null;
    }
  };

  const sendTrayStatus = (state, extra) => {
    if (!tray) return;
    tray.send({ type: 'status', state, ...(extra || {}) });
  };

  const stopChild = (ipcType, signal) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) return false;
    const active = child;
    if (active.connected) {
      try {
        active.send({ type: ipcType });
        clearKillFallback();
        killFallbackTimer = setTimeout(() => {
          killFallbackTimer = null;
          if (active.exitCode === null && active.signalCode === null) {
            try {
              active.kill(signal || 'SIGTERM');
            } catch {}
          }
        }, SHUTDOWN_GRACE_MS);
        killFallbackTimer.unref();
        return true;
      } catch {}
    }
    try {
      active.kill(signal || 'SIGTERM');
    } catch {}
    return true;
  };

  const requestShutdown = signal => {
    if (stopping) return;
    stopping = true;
    restarting = false;
    sendTrayStatus('stopping');
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
      tray?.close();
      process.exit(0);
      return;
    }
    if (!stopChild('uburoom:shutdown', signal)) {
      tray?.close();
      process.exit(0);
    }
  };

  const requestRestart = () => {
    if (stopping) return;
    restarting = true;
    sendTrayStatus('restarting');
    if (respawnTimer) {
      clearTimeout(respawnTimer);
      respawnTimer = null;
      restarting = false;
      launch();
      return;
    }
    if (!stopChild('uburoom:restart', 'SIGTERM')) {
      restarting = false;
      launch();
    }
  };

  tray = connectTrayPipe(trayPipe, {
    onCommand(message) {
      if (message.type === 'shutdown') requestShutdown('SIGTERM');
      else if (message.type === 'restart') requestRestart();
    },
    onDisconnect() {
      // If the tray supervisor exits unexpectedly, shut down cleanly rather than leaving a headless orphan.
      requestShutdown('SIGTERM');
    },
  });

  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGHUP', () => requestShutdown('SIGHUP'));

  function launch() {
    let target;
    try {
      target = resolveLaunchTarget(baseDir, args);
    } catch (error) {
      sendTrayStatus('error', { message: error.message });
      tray?.close();
      process.stderr.write(`[uburoom] ${error.message}\n`);
      process.exit(1);
      return;
    }
    sendTrayStatus('starting');
    child = spawn(target.nodeExe, ['--no-warnings=ExperimentalWarning', target.indexJs, ...target.childArgs], {
      cwd: target.appDir,
      stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
      env: target.env,
      windowsHide: Boolean(target.trayPipe),
    });
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'uburoom:setup-ready' && typeof message.url === 'string') {
        sendTrayStatus('setup', { url: message.url });
        if (!browserOpened && !target.noBrowser) {
          browserOpened = true;
          openBrowser(message.url);
        }
      } else if (message.type === 'uburoom:server-ready' && typeof message.url === 'string') {
        sendTrayStatus('running', { url: message.url });
        if (!browserOpened && !target.noBrowser && !message.fromSetup) {
          browserOpened = true;
          openBrowser(message.url);
        }
      }
    });
    child.on('error', error => {
      clearKillFallback();
      sendTrayStatus('error', { message: error.message });
      tray?.close();
      process.stderr.write(`[uburoom] Failed to start server: ${error.message}\n`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      clearKillFallback();
      child = null;
      if (stopping) {
        tray?.close();
        process.exit(typeof code === 'number' ? code : 0);
        return;
      }
      if (code === RESTART_EXIT_CODE || restarting) {
        restarting = false;
        sendTrayStatus('restarting');
        process.stdout.write('[uburoom] Restarting uburoom...\n');
        respawnTimer = setTimeout(() => {
          respawnTimer = null;
          launch();
        }, RESTART_SETTLE_MS);
        return;
      }
      if (code === 0) {
        sendTrayStatus('stopped', { exitCode: 0 });
        tray?.close();
        process.exit(0);
        return;
      }
      const status = code !== null ? code : signal || 1;
      sendTrayStatus('error', { exitCode: typeof code === 'number' ? code : 1 });
      tray?.close();
      process.stderr.write(`[uburoom] Server stopped with exit code ${status}.\n`);
      process.exit(typeof code === 'number' && code !== 0 ? code : 1);
    });
  }

  launch();
}

if (require.main === module) {
  runLauncher();
}

module.exports = {
  RESTART_EXIT_CODE,
  readActiveSlot,
  prependPath,
  parseLauncherArgs,
  resolveLaunchTarget,
  openBrowser,
  connectTrayPipe,
  runLauncher,
};
