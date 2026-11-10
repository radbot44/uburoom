'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { findOnPath } = require('../../server/media-tools');

const activeProcesses = new Set();
let registeredCleanup = false;

/**
 * Ensures child processes are killed and temporary files cleaned up on exit.
 */
function registerProcessLifecycle() {
  if (registeredCleanup) return;
  registeredCleanup = true;

  const cleanup = () => {
    for (const child of activeProcesses) {
      try {
        if (!child.killed) {
          if (process.platform === 'win32' && child.pid) {
            cp.execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
          } else if (child.pid) {
            child.kill('SIGKILL');
          }
        }
      } catch {
        // Process might have already exited
      }
    }
    activeProcesses.clear();
  };

  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
  process.once('exit', cleanup);
}

/**
 * Resolves FFmpeg and FFprobe binary paths.
 */
function resolveTools(configTools = {}, overrides = {}) {
  registerProcessLifecycle();

  const ffmpeg = overrides.ffmpeg || configTools.ffmpeg || findOnPath('ffmpeg');
  if (!ffmpeg || !fs.existsSync(ffmpeg)) {
    throw new Error(
      'FFmpeg executable not found. Configure tools.ffmpeg in config.yaml, pass --ffmpeg, or install FFmpeg on PATH.',
    );
  }

  const defaultProbe = ffmpeg
    ? path.join(path.dirname(ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
    : undefined;
  const ffprobeCandidate =
    overrides.ffprobe ||
    configTools.ffprobe ||
    (defaultProbe && fs.existsSync(defaultProbe) ? defaultProbe : findOnPath('ffprobe'));
  if (!ffprobeCandidate || !fs.existsSync(ffprobeCandidate)) {
    throw new Error(
      'FFprobe executable not found. Configure tools.ffprobe in config.yaml, pass --ffprobe, or install FFprobe on PATH.',
    );
  }

  // Probe version information
  let ffmpegVersion = '';
  let ffmpegBuildInfo = '';
  try {
    const raw = cp.execFileSync(ffmpeg, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    const lines = raw.split(/\r?\n/);
    ffmpegVersion = lines[0] || '';
    ffmpegBuildInfo = lines.find(l => l.startsWith('configuration:')) || '';
  } catch (err) {
    throw new Error(`Failed to execute FFmpeg at ${ffmpeg}: ${err.message}`);
  }

  let ffprobeVersion = '';
  try {
    const raw = cp.execFileSync(ffprobeCandidate, ['-version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });
    ffprobeVersion = raw.split(/\r?\n/)[0] || '';
  } catch (err) {
    throw new Error(`Failed to execute FFprobe at ${ffprobeCandidate}: ${err.message}`);
  }

  return {
    ffmpeg: path.resolve(ffmpeg),
    ffprobe: path.resolve(ffprobeCandidate),
    ffmpegVersion,
    ffprobeVersion,
    ffmpegBuildInfo,
  };
}

/**
 * Collects host environment information: OS, CPU, RAM, GPU, Git commit.
 */
function collectEnvironmentInfo() {
  const cpus = os.cpus() || [];
  const cpuModel = cpus[0]?.model?.trim() || 'Unknown CPU';
  const cpuCores = cpus.length;

  let gpuModel = 'Not detected';
  // 1. Try nvidia-smi
  try {
    const smi = cp.execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,driver_version,memory.total', '--format=csv,noheader,nounits'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
        windowsHide: true,
      },
    );
    if (smi && smi.trim()) {
      const parts = smi
        .trim()
        .split(/\r?\n/)[0]
        .split(',')
        .map(s => s.trim());
      gpuModel = `${parts[0]} (Driver ${parts[1]}, ${Math.round(Number(parts[2]) / 1024)}GB VRAM)`;
    }
  } catch {
    // 2. Try Windows WMI / CimInstance
    if (process.platform === 'win32') {
      try {
        const out = cp.execFileSync(
          'powershell.exe',
          ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'],
          { encoding: 'utf8', timeout: 3000, windowsHide: true },
        );
        const gpus = out
          .split(/\r?\n/)
          .map(s => s.trim())
          .filter(s => s && !/virtual|parsec|remote|basic display/i.test(s));
        if (gpus.length) {
          gpuModel = gpus.join(', ');
        }
      } catch {
        // Fallback
      }
    } else {
      // 3. Try Linux lspci
      try {
        const lspci = cp.execFileSync('lspci', [], { encoding: 'utf8', timeout: 3000 });
        const match = lspci.split(/\r?\n/).filter(line => /vga|3d controller|display/i.test(line));
        if (match.length) {
          gpuModel = match.map(l => l.replace(/^[^:]+:\s*/, '').trim()).join(', ');
        }
      } catch {
        // Fallback
      }
    }
  }

  // Git revision
  let gitRevision = 'Unknown';
  try {
    gitRevision = cp
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: path.resolve(__dirname, '../..'),
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    // Not a git clone or git unavailable
  }

  return {
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    nodeVersion: process.version,
    cpu: {
      model: cpuModel,
      cores: cpuCores,
    },
    memoryTotalMB: Math.round(os.totalmem() / (1024 * 1024)),
    memoryFreeMB: Math.round(os.freemem() / (1024 * 1024)),
    gpu: gpuModel,
    gitRevision,
  };
}

/**
 * Spawns an executable safely using argument arrays with tracking and timeout.
 */
function spawnSafe(binary, args, options = {}) {
  const { timeout = 30000, signal, onStdout, onStderr, windowsHide = true, cwd } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Process cancelled before start.'));

    const child = cp.spawn(binary, args, {
      windowsHide,
      cwd,
      stdio: ['ignore', onStdout ? 'pipe' : 'ignore', onStderr ? 'pipe' : 'ignore'],
    });

    activeProcesses.add(child);

    let settled = false;
    let timer;
    let abortHandler = null;

    const finish = (err, code, signalCode) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (signal && abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }
      activeProcesses.delete(child);
      if (err) return reject(err);
      resolve({ code, signal: signalCode });
    };

    if (timeout > 0) {
      timer = setTimeout(() => {
        try {
          if (process.platform === 'win32' && child.pid) {
            cp.execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
        finish(new Error(`Process timed out after ${timeout}ms: ${binary} ${args.slice(0, 4).join(' ')}...`));
      }, timeout);
    }

    if (signal) {
      abortHandler = () => {
        try {
          if (process.platform === 'win32' && child.pid) {
            cp.execSync(`taskkill /T /F /PID ${child.pid}`, { stdio: 'ignore' });
          } else {
            child.kill('SIGKILL');
          }
        } catch {}
        finish(new Error('Process cancelled by abort signal.'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    if (onStdout && child.stdout) {
      child.stdout.on('data', onStdout);
    }
    if (onStderr && child.stderr) {
      child.stderr.on('data', onStderr);
    }

    child.on('error', err => finish(err));
    child.on('close', (code, signalCode) => {
      if (code !== 0 && code !== null) {
        return finish(new Error(`Process exited with non-zero code ${code}`));
      }
      finish(null, code, signalCode);
    });
  });
}

module.exports = {
  resolveTools,
  collectEnvironmentInfo,
  spawnSafe,
  activeProcesses,
};
