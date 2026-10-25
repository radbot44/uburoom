#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const { ROOT, configPath, parseConfig, normalizeConfig } = require('../server/config');
const { findOnPath } = require('../server/media-tools');

/**
 * @typedef {{
 *   category: string,
 *   name: string,
 *   status: 'pass' | 'warn' | 'fail',
 *   message: string,
 *   remediation?: string,
 *   details?: any
 * }} DoctorCheck
 */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const color = {
  green: (t) => useColor ? `\x1b[32m${t}\x1b[0m` : t,
  yellow: (t) => useColor ? `\x1b[33m${t}\x1b[0m` : t,
  red: (t) => useColor ? `\x1b[31m${t}\x1b[0m` : t,
  bold: (t) => useColor ? `\x1b[1m${t}\x1b[0m` : t,
  dim: (t) => useColor ? `\x1b[2m${t}\x1b[0m` : t,
};

function formatStatus(status) {
  if (status === 'pass') return color.green('[PASS]');
  if (status === 'warn') return color.yellow('[WARN]');
  return color.red('[FAIL]');
}

async function checkRuntime() {
  /** @type {DoctorCheck[]} */
  const checks = [];

  // Node.js engine check
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20) {
    checks.push({
      category: 'Runtime',
      name: 'Node.js version',
      status: 'fail',
      message: `Node.js ${process.version} is unsupported. uburoom requires Node >= 20.0.0 (Node 22 LTS recommended).`,
      remediation: 'Download and install Node.js 22 LTS from https://nodejs.org'
    });
  } else if (major < 22 || (major === 22 && minor < 13)) {
    checks.push({
      category: 'Runtime',
      name: 'Node.js version',
      status: 'warn',
      message: `Node.js ${process.version} detected. Node >= 22.13.0 is recommended for native SQLite performance.`,
      remediation: 'Upgrade to Node.js 22 LTS (>= 22.13.0) when possible.'
    });
  } else {
    checks.push({
      category: 'Runtime',
      name: 'Node.js version',
      status: 'pass',
      message: `Node.js ${process.version} (${process.platform} ${process.arch})`
    });
  }

  // SQLite availability
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE _diag (id INTEGER PRIMARY KEY); INSERT INTO _diag VALUES (1);');
    const row = db.prepare('SELECT id FROM _diag').get();
    db.close();
    if (row && row.id === 1) {
      checks.push({
        category: 'Runtime',
        name: 'SQLite engine',
        status: 'pass',
        message: 'Built-in node:sqlite is operational'
      });
    } else {
      throw new Error('SQLite test query returned unexpected result');
    }
  } catch (error) {
    checks.push({
      category: 'Runtime',
      name: 'SQLite engine',
      status: 'fail',
      message: `Built-in node:sqlite failed to initialize: ${error.message}`,
      remediation: 'Ensure you are running an official Node.js build with SQLite support enabled (Node.js 22+).'
    });
  }

  return checks;
}

function checkConfiguration(configFile) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  let rawSource = '';
  let parsedConfig = null;
  let normalizedConfig = null;

  if (!fs.existsSync(configFile)) {
    checks.push({
      category: 'Configuration',
      name: 'Config file presence',
      status: 'fail',
      message: `Configuration file not found at: ${configFile}`,
      remediation: 'Copy config.example.yaml to config.yaml and edit your server settings.'
    });
    return { checks, config: null };
  }

  try {
    rawSource = fs.readFileSync(configFile, 'utf8');
    if (!rawSource.trim()) {
      checks.push({
        category: 'Configuration',
        name: 'Config content',
        status: 'fail',
        message: `Configuration file is empty: ${configFile}`,
        remediation: 'Copy settings from config.example.yaml into your config.yaml.'
      });
      return { checks, config: null };
    }
  } catch (err) {
    checks.push({
      category: 'Configuration',
      name: 'Config readability',
      status: 'fail',
      message: `Cannot read configuration file (${err.code}): ${configFile}`,
      remediation: 'Check file permissions on config.yaml.'
    });
    return { checks, config: null };
  }

  try {
    parsedConfig = parseConfig(rawSource);
  } catch (err) {
    checks.push({
      category: 'Configuration',
      name: 'YAML syntax',
      status: 'fail',
      message: `YAML parsing failed: ${err.message}`,
      remediation: 'Check config.yaml for syntax errors, improper indentation, or unescaped characters.'
    });
    return { checks, config: null };
  }

  try {
    normalizedConfig = normalizeConfig(parsedConfig, {
      base: path.dirname(path.resolve(configFile)),
      discoverTools: false
    });
    checks.push({
      category: 'Configuration',
      name: 'Config schema & validation',
      status: 'pass',
      message: `Valid YAML syntax and schema (${path.basename(configFile)})`
    });
  } catch (err) {
    checks.push({
      category: 'Configuration',
      name: 'Config schema & validation',
      status: 'fail',
      message: `Configuration validation error: ${err.message}`,
      remediation: 'Compare your config.yaml settings against config.example.yaml.'
    });
    return { checks, config: null };
  }

  // Public URL validation
  const pub = normalizedConfig.publicUrl;
  if (!pub.startsWith('https://')) {
    checks.push({
      category: 'Configuration',
      name: 'Public URL protocol',
      status: 'warn',
      message: `server.public_url uses ${pub.split(':')[0]}:// (${pub}). HTTPS is strongly recommended for production, Discord Activities, and browser security.`,
      remediation: 'Configure a valid HTTPS domain and TLS certificate.'
    });
  } else {
    checks.push({
      category: 'Configuration',
      name: 'Public URL protocol',
      status: 'pass',
      message: `HTTPS public origin: ${pub}`
    });
  }

  return { checks, config: normalizedConfig };
}

async function checkPortAvailability(host, port) {
  /** @type {DoctorCheck[]} */
  const checks = [];

  await new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        checks.push({
          category: 'Network',
          name: `Port ${port} availability`,
          status: 'fail',
          message: `Port ${port} on ${host} is already in use by another process.`,
          remediation: `Stop the existing uburoom or conflicting process, or change server.port in config.yaml.`
        });
      } else {
        checks.push({
          category: 'Network',
          name: `Port ${port} availability`,
          status: 'warn',
          message: `Port probe returned unexpected error (${err.code}): ${err.message}`
        });
      }
      resolve();
    });
    probe.once('listening', () => {
      probe.close(() => {
        checks.push({
          category: 'Network',
          name: `Port ${port} availability`,
          status: 'pass',
          message: `Port ${port} is available on ${host}`
        });
        resolve();
      });
    });
    try {
      probe.listen(port, host);
    } catch (e) {
      checks.push({
        category: 'Network',
        name: `Port ${port} availability`,
        status: 'warn',
        message: `Could not probe port ${port}: ${e.message}`
      });
      resolve();
    }
  });

  return checks;
}

function checkStorageAndKey(config) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const keyFile = config.credentialKeyFile;
  const dataDir = path.dirname(config.accountFile);
  const dbFile = config.accountFile;

  // 1. Key file verification
  if (!fs.existsSync(keyFile)) {
    if (fs.existsSync(dbFile)) {
      checks.push({
        category: 'Storage & Keys',
        name: 'Credential encryption key',
        status: 'fail',
        message: `Database exists at ${dbFile}, but credential key is missing at: ${keyFile}`,
        remediation: 'Existing tokens and account secrets cannot be decrypted without the original 32-byte key. Restore your backup credentials.key.'
      });
    } else {
      checks.push({
        category: 'Storage & Keys',
        name: 'Credential encryption key',
        status: 'warn',
        message: `Credential key does not exist yet at: ${keyFile} (will be generated automatically on first server startup).`
      });
    }
  } else {
    try {
      const stats = fs.statSync(keyFile);
      if (stats.size !== 32) {
        checks.push({
          category: 'Storage & Keys',
          name: 'Credential encryption key',
          status: 'fail',
          message: `Key file size is ${stats.size} bytes. Credential encryption requires an exact 32-byte (256-bit) AES key.`,
          remediation: 'Ensure the key was generated with crypto.randomBytes(32). Never truncate or pad an existing database key.'
        });
      } else {
        checks.push({
          category: 'Storage & Keys',
          name: 'Credential encryption key',
          status: 'pass',
          message: `Valid 32-byte credential key (${keyFile})`
        });
      }
    } catch (err) {
      checks.push({
        category: 'Storage & Keys',
        name: 'Credential encryption key',
        status: 'fail',
        message: `Cannot access credential key file (${err.code}): ${keyFile}`
      });
    }
  }

  // 2. Data directory verification
  try {
    if (!fs.existsSync(dataDir)) {
      checks.push({
        category: 'Storage & Keys',
        name: 'Data directory',
        status: 'pass',
        message: `Data directory will be created at: ${dataDir}`
      });
    } else {
      fs.accessSync(dataDir, fs.constants.R_OK | fs.constants.W_OK);
      checks.push({
        category: 'Storage & Keys',
        name: 'Data directory',
        status: 'pass',
        message: `Data directory is writable (${dataDir})`
      });
    }
  } catch (err) {
    checks.push({
      category: 'Storage & Keys',
      name: 'Data directory',
      status: 'fail',
      message: `Data directory at ${dataDir} is not writable (${err.code}).`,
      remediation: 'Verify write permissions for the user account running uburoom.'
    });
  }

  // 3. Existing SQLite integrity check
  if (fs.existsSync(dbFile)) {
    try {
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const result = db.prepare('PRAGMA integrity_check;').get();
      db.close();
      if (result && (result.integrity_check === 'ok' || Object.values(result)[0] === 'ok')) {
        checks.push({
          category: 'Storage & Keys',
          name: 'SQLite database integrity',
          status: 'pass',
          message: `SQLite database integrity verified (${path.basename(dbFile)})`
        });
      } else {
        checks.push({
          category: 'Storage & Keys',
          name: 'SQLite database integrity',
          status: 'fail',
          message: `SQLite database failed integrity check: ${JSON.stringify(result)}`,
          remediation: 'Database appears corrupted. Check storage disk health or restore from a recent backup.'
        });
      }
    } catch (err) {
      checks.push({
        category: 'Storage & Keys',
        name: 'SQLite database integrity',
        status: 'warn',
        message: `Could not verify database integrity: ${err.message}`
      });
    }
  }

  // 4. Log file destination check (if configured)
  if (config.logging?.file) {
    const logFile = config.logging.file;
    const logDir = path.dirname(logFile);
    try {
      if (!fs.existsSync(logDir)) {
        checks.push({
          category: 'Storage & Keys',
          name: 'Log directory',
          status: 'pass',
          message: `Log directory will be created at: ${logDir}`
        });
      } else {
        fs.accessSync(logDir, fs.constants.R_OK | fs.constants.W_OK);
        checks.push({
          category: 'Storage & Keys',
          name: 'Log directory',
          status: 'pass',
          message: `Log directory is writable (${logDir})`
        });
      }
    } catch (err) {
      checks.push({
        category: 'Storage & Keys',
        name: 'Log directory',
        status: 'fail',
        message: `Log directory at ${logDir} is not writable (${err.code}).`,
        remediation: 'Verify write permissions for the user account running uburoom or choose a different logging.file path.'
      });
    }
  }

  return checks;
}

function checkTlsCertificates(config) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const certPath = config.tlsCert;
  const keyPath = config.tlsKey;

  const isHttps = config.publicUrl.startsWith('https:');
  if (!isHttps) {
    checks.push({
      category: 'TLS / Certificates',
      name: 'TLS configuration',
      status: 'pass',
      message: 'Plain HTTP configured; TLS certificate verification skipped.'
    });
    return checks;
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    const isLocal = config.publicUrl.includes('localhost') || config.publicUrl.includes('127.0.0.1');
    checks.push({
      category: 'TLS / Certificates',
      name: 'TLS files presence',
      status: isLocal ? 'warn' : 'fail',
      message: `Certificate or key file missing (Cert: ${certPath}, Key: ${keyPath})`,
      remediation: isLocal
        ? 'Generate a local self-signed certificate with: node scripts/new-dev-cert.js'
        : 'Provide a valid TLS certificate and private key matching your domain.'
    });
    return checks;
  }

  try {
    const certRaw = fs.readFileSync(certPath);
    const keyRaw = fs.readFileSync(keyPath);
    const cert = new crypto.X509Certificate(certRaw);

    const validTo = new Date(cert.validTo);
    const validFrom = new Date(cert.validFrom);
    const now = new Date();
    const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));

    if (now < validFrom) {
      checks.push({
        category: 'TLS / Certificates',
        name: 'Certificate validity dates',
        status: 'fail',
        message: `Certificate is not yet valid (valid from ${validFrom.toISOString()}).`,
        remediation: 'Check server clock or re-issue certificate.'
      });
    } else if (daysUntilExpiry < 0) {
      checks.push({
        category: 'TLS / Certificates',
        name: 'Certificate validity dates',
        status: 'fail',
        message: `Certificate expired on ${validTo.toISOString().slice(0, 10)} (${Math.abs(daysUntilExpiry)} days ago).`,
        remediation: 'Renew or re-issue your TLS certificate.'
      });
    } else if (daysUntilExpiry < 14) {
      checks.push({
        category: 'TLS / Certificates',
        name: 'Certificate validity dates',
        status: 'warn',
        message: `Certificate expires soon in ${daysUntilExpiry} days (valid until ${validTo.toISOString().slice(0, 10)}).`,
        remediation: 'Plan certificate renewal.'
      });
    } else {
      checks.push({
        category: 'TLS / Certificates',
        name: 'Certificate validity dates',
        status: 'pass',
        message: `Certificate is valid until ${validTo.toISOString().slice(0, 10)} (${daysUntilExpiry} days remaining)`
      });
    }

    // Verify key matches cert public key
    try {
      crypto.createSign('SHA256').update('test').sign(keyRaw);
      checks.push({
        category: 'TLS / Certificates',
        name: 'Private key format',
        status: 'pass',
        message: 'Private key is valid and readable'
      });
    } catch (keyErr) {
      checks.push({
        category: 'TLS / Certificates',
        name: 'Private key format',
        status: 'fail',
        message: `Failed to parse private key: ${keyErr.message}`,
        remediation: 'Ensure server.tls_key points to an unencrypted PEM private key.'
      });
    }
  } catch (err) {
    checks.push({
      category: 'TLS / Certificates',
      name: 'Certificate validation',
      status: 'fail',
      message: `Failed to inspect TLS certificate: ${err.message}`
    });
  }

  return checks;
}

function checkMediaTools(config) {
  /** @type {DoctorCheck[]} */
  const checks = [];
  const ffmpeg = config.ffmpegPath || findOnPath('ffmpeg');
  const ffprobe = config.ffprobePath || findOnPath('ffprobe');

  // FFmpeg check
  if (!ffmpeg) {
    checks.push({
      category: 'Media Tools',
      name: 'FFmpeg binary',
      status: 'warn',
      message: 'FFmpeg was not found on PATH or in tools.ffmpeg.',
      remediation: 'Install FFmpeg (https://ffmpeg.org) and add to PATH or configure tools.ffmpeg in config.yaml for video conversion, PGS subtitles, and AV1 streaming.'
    });
  } else {
    try {
      const verOutput = cp.execFileSync(ffmpeg, ['-version'], { timeout: 4000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const firstLine = verOutput.split(/\r?\n/)[0] || 'FFmpeg';
      checks.push({
        category: 'Media Tools',
        name: 'FFmpeg binary',
        status: 'pass',
        message: `${firstLine} (${ffmpeg})`
      });

      // Codecs / Encoders probe
      try {
        const encodersOutput = cp.execFileSync(ffmpeg, ['-encoders'], { timeout: 4000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
        const hasH264 = /libx264|h264_qsv|h264_nvenc|h264_amf/.test(encodersOutput);
        const hasAac = /aac/.test(encodersOutput);
        const hasOpus = /libopus|opus/.test(encodersOutput);
        const hasQsv = /qsv/.test(encodersOutput);
        const hasNvenc = /nvenc/.test(encodersOutput);

        const hw = [hasQsv ? 'Intel QSV' : '', hasNvenc ? 'NVIDIA NVENC' : ''].filter(Boolean).join(', ');

        if (hasH264 && hasAac && hasOpus) {
          checks.push({
            category: 'Media Tools',
            name: 'Required encoders',
            status: 'pass',
            message: `H.264, AAC, and Opus encoders available.${hw ? ` Hardware acceleration: ${hw}.` : ' (Software encoding available)'}`
          });
        } else {
          checks.push({
            category: 'Media Tools',
            name: 'Required encoders',
            status: 'warn',
            message: `Some encoders missing (H.264: ${hasH264}, AAC: ${hasAac}, Opus: ${hasOpus}).`,
            remediation: 'Use a full FFmpeg build that includes libx264 and libopus.'
          });
        }
      } catch {}
    } catch (err) {
      checks.push({
        category: 'Media Tools',
        name: 'FFmpeg binary execution',
        status: 'fail',
        message: `FFmpeg failed to execute: ${err.message}`,
        remediation: 'Check executable permissions for FFmpeg.'
      });
    }
  }

  // FFprobe check
  if (!ffprobe) {
    checks.push({
      category: 'Media Tools',
      name: 'FFprobe binary',
      status: 'warn',
      message: 'FFprobe was not found on PATH or in tools.ffprobe.',
      remediation: 'Install FFprobe alongside FFmpeg to enable media stream inspection.'
    });
  } else {
    try {
      const probeOutput = cp.execFileSync(ffprobe, ['-version'], { timeout: 4000, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      const firstLine = probeOutput.split(/\r?\n/)[0] || 'FFprobe';
      checks.push({
        category: 'Media Tools',
        name: 'FFprobe binary',
        status: 'pass',
        message: `${firstLine} (${ffprobe})`
      });
    } catch (err) {
      checks.push({
        category: 'Media Tools',
        name: 'FFprobe binary execution',
        status: 'warn',
        message: `FFprobe failed to execute: ${err.message}`
      });
    }
  }

  return checks;
}

async function checkProviderConnectivity(config) {
  /** @type {DoctorCheck[]} */
  const checks = [];

  // Plex reachability probe (non-destructive)
  if (config.plexUrl) {
    await new Promise((resolve) => {
      let client = config.plexUrl.startsWith('https:') ? https : http;
      const targetUrl = new URL('/identity', config.plexUrl);
      const req = client.get(targetUrl, { timeout: 3500 }, (res) => {
        if (res.statusCode >= 200 && res.statusCode < 500) {
          checks.push({
            category: 'Providers',
            name: 'Plex Media Server reachability',
            status: 'pass',
            message: `Plex server reachable at ${config.plexUrl} (HTTP ${res.statusCode})`
          });
        } else {
          checks.push({
            category: 'Providers',
            name: 'Plex Media Server reachability',
            status: 'warn',
            message: `Plex server returned HTTP ${res.statusCode} at ${config.plexUrl}`
          });
        }
        res.resume();
        resolve();
      });
      req.on('timeout', () => {
        req.destroy();
        checks.push({
          category: 'Providers',
          name: 'Plex Media Server reachability',
          status: 'warn',
          message: `Connection timed out reaching Plex server at ${config.plexUrl}`,
          remediation: 'Verify Plex server URL and that PMS is running and accessible on the local network.'
        });
        resolve();
      });
      req.on('error', (err) => {
        checks.push({
          category: 'Providers',
          name: 'Plex Media Server reachability',
          status: 'warn',
          message: `Could not connect to Plex server at ${config.plexUrl}: ${err.message}`,
          remediation: 'Verify plex.url in config.yaml and network routing.'
        });
        resolve();
      });
    });
  }

  // Discord bot config presence
  if (config.botToken) {
    if (config.botToken.length < 20) {
      checks.push({
        category: 'Providers',
        name: 'Discord bot token',
        status: 'warn',
        message: 'discord.bot_token appears too short or invalid.',
        remediation: 'Check bot token generated in Discord Developer Portal.'
      });
    } else {
      checks.push({
        category: 'Providers',
        name: 'Discord bot token',
        status: 'pass',
        message: 'Discord bot credentials configured'
      });
    }
  }

  return checks;
}

async function runDoctor(options = {}) {
  const args = options.args || process.argv.slice(2);
  const jsonMode = args.includes('--json');
  let customConfig = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i].startsWith('--config=')) {
      customConfig = args[i] === '--config' ? args[++i] : args[i].slice(9);
    }
  }

  const selectedFile = customConfig ? path.resolve(customConfig) : path.resolve(ROOT, 'config.yaml');
  /** @type {DoctorCheck[]} */
  const allChecks = [];

  // 1. Runtime
  allChecks.push(...(await checkRuntime()));

  // 2. Configuration
  const { checks: configChecks, config } = checkConfiguration(selectedFile);
  allChecks.push(...configChecks);

  // 3. Dependent checks (only if config is valid)
  if (config) {
    allChecks.push(...(await checkPortAvailability(config.host, config.port)));
    allChecks.push(...checkStorageAndKey(config));
    allChecks.push(...checkTlsCertificates(config));
    allChecks.push(...checkMediaTools(config));
    allChecks.push(...(await checkProviderConnectivity(config)));
  }

  const passCount = allChecks.filter(c => c.status === 'pass').length;
  const warnCount = allChecks.filter(c => c.status === 'warn').length;
  const failCount = allChecks.filter(c => c.status === 'fail').length;

  if (jsonMode) {
    const summary = {
      timestamp: new Date().toISOString(),
      ok: failCount === 0,
      passed: passCount,
      warnings: warnCount,
      failures: failCount,
      summary: { passed: passCount, warnings: warnCount, failures: failCount },
      checks: allChecks
    };
    if (!options.silent) console.log(JSON.stringify(summary, null, 2));
    return summary;
  }

  // Terminal human-readable output
  console.log(color.bold(`\nuburoom doctor v0.5.3 — Installation Diagnostics`));
  console.log(color.dim(`Target configuration: ${selectedFile}\n`));

  let currentCategory = '';
  for (const check of allChecks) {
    if (check.category !== currentCategory) {
      currentCategory = check.category;
      console.log(color.bold(`\n${currentCategory}:`));
    }
    console.log(`  ${formatStatus(check.status)} ${check.name}: ${check.message}`);
    if (check.remediation && check.status !== 'pass') {
      console.log(`         ${color.dim('-> Remediation:')} ${check.remediation}`);
    }
  }

  console.log(color.bold('\n------------------------------------------------------------'));
  const summaryLine = `Result: ${passCount} passed, ${warnCount} warning${warnCount === 1 ? '' : 's'}, ${failCount} failure${failCount === 1 ? '' : 's'}.`;
  if (failCount > 0) {
    console.log(color.red(color.bold(summaryLine)));
    console.log(color.red('Issues detected. Address the failures above before starting uburoom.\n'));
  } else if (warnCount > 0) {
    console.log(color.yellow(color.bold(summaryLine)));
    console.log(color.green('Ready to run (review warnings above if applicable).\n'));
  } else {
    console.log(color.green(color.bold(summaryLine)));
    console.log(color.green('All systems operational! Installation is ready.\n'));
  }

  return { ok: failCount === 0, passed: passCount, warnings: warnCount, failures: failCount, checks: allChecks };
}

if (require.main === module) {
  runDoctor().then((res) => {
    if (!res.ok) process.exitCode = 1;
  }).catch((err) => {
    console.error('Doctor CLI error:', err);
    process.exit(1);
  });
}

module.exports = {
  runDoctor,
  checkRuntime,
  checkConfiguration,
  checkPortAvailability,
  checkStorageAndKey,
  checkTlsCertificates,
  checkMediaTools,
  checkProviderConnectivity
};
