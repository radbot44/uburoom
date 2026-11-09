'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const YAML = require('yaml');
const { QUALITIES, qualityDefinition } = require('../../shared/room-protocol');
const Playback = require('../../web/playback-policy');

const ROOT = path.resolve(__dirname, '../..');

/**
 * Resolves configuration file path according to rules:
 * 1. Explicit --config <path>
 * 2. Repository config.yaml if present
 * 3. Fallback to config.example.yaml
 */
function resolveConfigFile(explicitPath) {
  if (explicitPath) {
    const resolved = path.resolve(process.cwd(), explicitPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Configuration file not found: ${explicitPath}`);
    }
    return resolved;
  }
  const primary = path.join(ROOT, 'config.yaml');
  if (fs.existsSync(primary)) return primary;
  const fallback = path.join(ROOT, 'config.example.yaml');
  if (fs.existsSync(fallback)) return fallback;
  throw new Error('Neither config.yaml nor config.example.yaml could be found.');
}

/**
 * Loads and sanitizes configuration.
 * Returns only parameters required for benchmarking, never secrets or personal paths.
 */
function loadBenchmarkConfig(configFilePath) {
  const content = fs.readFileSync(configFilePath, 'utf8');
  let parsed;
  try {
    const doc = YAML.parseDocument(content, { prettyErrors: false, uniqueKeys: true, version: '1.2', stringKeys: true });
    const problem = doc.errors[0] || doc.warnings[0];
    if (problem) throw new Error('Invalid YAML syntax (' + problem.code + ')');
    parsed = doc.toJS({ maxAliasCount: 0 });
  } catch (err) {
    throw new Error(`Invalid configuration YAML in ${path.basename(configFilePath)}: ${err.message.split(/\r?\n/)[0]}`);
  }

  const rawTrans = parsed?.transcoding || {};
  const rawTools = parsed?.tools || {};

  // Enabled outputs from YAML. Honor explicitly empty outputs: []
  const hasConfiguredOutputs = Array.isArray(rawTrans.outputs);
  const outputs = hasConfiguredOutputs ? rawTrans.outputs : ['av1', 'plex'];
  const localCodecs = outputs.filter(o => o !== 'plex' && Playback.localFormat(o));

  const encoder = ['auto', 'hardware', 'qsv', 'nvenc', 'software'].includes(rawTrans.encoder)
    ? rawTrans.encoder
    : 'auto';

  const cpuFallback = rawTrans.cpu_fallback !== false;
  const hardwareDecode = rawTrans.hardware_decode !== false;
  const maxJobs = Number.isInteger(rawTrans.max_jobs) && rawTrans.max_jobs > 0 ? rawTrans.max_jobs : 5;

  // Qualities: array of [height, bitrateMbps]
  let qualities = [];
  if (Array.isArray(rawTrans.qualities)) {
    for (const pair of rawTrans.qualities) {
      if (Array.isArray(pair) && pair.length === 2) {
        const [height, mbps] = pair;
        const def = qualityDefinition(`${height}p${mbps}`);
        if (def && !qualities.some(q => q.id === def.id)) qualities.push(def);
      }
    }
  } else {
    // Default to uburoom's built-in non-direct qualities
    qualities = QUALITIES.filter(q => q.id !== 'direct');
  }

  const isExample = path.basename(configFilePath) === 'config.example.yaml';
  const configDir = path.dirname(configFilePath);

  const resolveTool = val => {
    if (typeof val !== 'string' || !val.trim()) return undefined;
    return path.isAbsolute(val.trim()) ? val.trim() : path.resolve(configDir, val.trim());
  };

  return {
    configFilePath,
    profileName: isExample ? 'config.example.yaml (Default Template)' : path.basename(configFilePath),
    tools: {
      ffmpeg: resolveTool(rawTools.ffmpeg),
      ffprobe: resolveTool(rawTools.ffprobe)
    },
    transcoding: {
      outputs,
      localCodecs,
      hasConfiguredOutputs,
      encoder,
      cpuFallback,
      hardwareDecode,
      maxJobs,
      qualities
    }
  };
}

/**
 * Builds the resolved test matrix combining codecs, encoders, and qualities,
 * incorporating command-line overrides.
 */
function resolveTestMatrix(config, options = {}) {
  const allSupportedCodecs = ['av1', 'vp9', 'vp8'];

  // 1. Resolve Codecs
  let targetCodecs;
  if (options.allCodecs) {
    targetCodecs = allSupportedCodecs;
  } else if (options.codecs && options.codecs.length) {
    targetCodecs = options.codecs.filter(c => allSupportedCodecs.includes(c));
    if (!targetCodecs.length) {
      throw new Error(`Invalid --codecs selection. Supported codecs: ${allSupportedCodecs.join(', ')}`);
    }
  } else {
    targetCodecs = config.transcoding.localCodecs;
  }

  if (!targetCodecs || !targetCodecs.length) {
    return {
      targetCodecs: [],
      targetQualities: [],
      configurations: []
    };
  }

  // 2. Resolve Encoders
  // Map of known supported encoders per codec
  const CODEC_ENCODERS = {
    av1: ['nvenc', 'qsv', 'software'],
    vp9: ['qsv', 'software'],
    vp8: ['software']
  };

  // 3. Resolve Qualities
  let targetQualities = config.transcoding.qualities;
  if (options.qualities && options.qualities.length) {
    const selected = [];
    for (const qArg of options.qualities) {
      const match = targetQualities.find(q =>
        q.id.toLowerCase() === qArg.toLowerCase() ||
        `${q.height}p`.toLowerCase() === qArg.toLowerCase() ||
        `${q.height}` === qArg
      );
      if (match && !selected.some(s => s.id === match.id)) {
        selected.push(match);
      } else {
        // Try parsing custom height/bitrate specification e.g. 1080p8 or 1080p10
        const customDef = qualityDefinition(qArg);
        if (customDef && !selected.some(s => s.id === customDef.id)) {
          selected.push(customDef);
        }
      }
    }
    if (!selected.length) {
      throw new Error(`No matching qualities found for --qualities: ${options.qualities.join(', ')}`);
    }
    targetQualities = selected;
  }

  // Sort qualities descending by height then bitrate
  targetQualities.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));

  // Build configurations array
  const configurations = [];
  for (const codec of targetCodecs) {
    let encodersForCodec;
    if (options.allEncoders) {
      encodersForCodec = CODEC_ENCODERS[codec] || ['software'];
    } else if (options.encoders && options.encoders.length) {
      encodersForCodec = options.encoders.filter(e => (CODEC_ENCODERS[codec] || []).includes(e));
    } else {
      // Use configured encoder setting
      const enc = config.transcoding.encoder;
      if (enc === 'auto' || enc === 'hardware') {
        encodersForCodec = ['auto'];
      } else {
        if ((CODEC_ENCODERS[codec] || []).includes(enc)) {
          encodersForCodec = [enc];
        } else if (config.transcoding.cpuFallback) {
          encodersForCodec = ['software'];
        } else {
          encodersForCodec = [];
        }
      }
    }

    for (const encoder of encodersForCodec) {
      for (const quality of targetQualities) {
        configurations.push({
          id: `${codec}-${encoder}-${quality.id}`,
          codec,
          requestedEncoder: encoder,
          allowFallback: !options.allEncoders && (options.encoders ? false : config.transcoding.cpuFallback),
          quality,
          resolution: `${quality.width || (Math.round(quality.height * 16 / 9 / 2) * 2)}x${quality.height}`,
          targetBitrateKbps: quality.bitrate
        });
      }
    }
  }

  return {
    targetCodecs,
    targetQualities,
    configurations
  };
}

/**
 * Passively inspects operating system processes to check if an uburoom server
 * process appears to be active. Best-effort; never touches or alters processes.
 */
function inspectActiveUburoomProcess() {
  try {
    if (process.platform === 'win32') {
      const output = cp.execFileSync('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-Process node -ErrorAction SilentlyContinue | Select-Object -Property Id, ProcessName | ConvertTo-Json'
      ], { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

      if (output && output.trim()) {
        let list;
        try {
          const parsed = JSON.parse(output);
          list = Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          list = [];
        }
        const foreignNodes = list.filter(p => p && p.Id !== process.pid);
        if (foreignNodes.length > 0) {
          return {
            detected: true,
            message: `Found ${foreignNodes.length} active Node.js process(es) (e.g. PID ${foreignNodes[0].Id}). If uburoom is running, benchmarking may impact playback for active viewers.`
          };
        }
      }
    } else {
      const output = cp.execFileSync('pgrep', ['-f', 'server/index.js'], {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      });
      const pids = output.trim().split(/\s+/).map(Number).filter(p => p && p !== process.pid);
      if (pids.length > 0) {
        return {
          detected: true,
          message: `Detected active uburoom process (PID ${pids.join(', ')}). Benchmarking may impact live playback performance.`
        };
      }
    }
  } catch {
    // Process inspection is best effort; absence of detection is not proof of idle.
  }
  return { detected: false };
}

/**
 * Resolves a unique, collision-free output directory.
 * Prevents accidental overwriting of unrelated files, previous benchmark runs,
 * or concurrent runs launched in the same second.
 */
function resolveUniqueOutputDir(requestedPath, cwd = process.cwd()) {
  const resolvedCwd = path.resolve(cwd);

  if (requestedPath) {
    const target = path.resolve(resolvedCwd, requestedPath);
    // Safety check: ensure target is not project root or critical source directory
    const rel = path.relative(resolvedCwd, target);
    if (!rel || rel === '.' || rel.startsWith('..') || ['server', 'web', 'shared', '.git', 'node_modules'].includes(rel.split(path.sep)[0])) {
      throw new Error(`Output directory cannot point to project root or source directories: ${requestedPath}`);
    }

    // Ensure parent directory exists
    const parent = path.dirname(target);
    fs.mkdirSync(parent, { recursive: true });

    // Atomic allocation loop: claim an exclusively created directory.
    // Never reuse an existing directory even if empty to prevent concurrent collision.
    let counter = 0;
    while (true) {
      const candidate = counter === 0 ? target : `${target}-${counter}`;
      try {
        fs.mkdirSync(candidate);
        return { dir: candidate, collisionAvoided: counter > 0, original: target };
      } catch (err) {
        if (err.code === 'EEXIST') {
          counter++;
          continue;
        }
        throw err;
      }
    }
  }

  // Default output directory under artifacts/transcode-benchmark/run-<timestamp>-<pid>
  const artifactsDir = path.resolve(resolvedCwd, 'artifacts', 'transcode-benchmark');
  fs.mkdirSync(artifactsDir, { recursive: true });

  const now = new Date();
  const timestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `run-${timestamp}-${process.pid}`;

  let counter = 0;
  while (true) {
    const candidateName = counter === 0 ? baseName : `${baseName}-${counter}`;
    const candidatePath = path.join(artifactsDir, candidateName);
    try {
      fs.mkdirSync(candidatePath);
      return { dir: candidatePath, collisionAvoided: counter > 0 };
    } catch (err) {
      if (err.code === 'EEXIST') {
        counter++;
        continue;
      }
      throw err;
    }
  }
}

module.exports = {
  resolveConfigFile,
  loadBenchmarkConfig,
  resolveTestMatrix,
  inspectActiveUburoomProcess,
  resolveUniqueOutputDir
};
