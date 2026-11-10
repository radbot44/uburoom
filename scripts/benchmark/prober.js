'use strict';
const cp = require('node:child_process');
const { probeEncoder, run } = require('../../server/av1');

// Canonical list of encoder combinations supported in uburoom
const MATRIX = [
  { codec: 'av1', encoder: 'nvenc', ffmpegEncoder: 'av1_nvenc', type: 'hardware' },
  { codec: 'av1', encoder: 'qsv', ffmpegEncoder: 'av1_qsv', type: 'hardware' },
  { codec: 'av1', encoder: 'software', ffmpegEncoder: 'libsvtav1', type: 'software' },
  { codec: 'vp9', encoder: 'qsv', ffmpegEncoder: 'vp9_qsv', type: 'hardware' },
  { codec: 'vp9', encoder: 'software', ffmpegEncoder: 'libvpx-vp9', type: 'software' },
  { codec: 'vp8', encoder: 'software', ffmpegEncoder: 'libvpx', type: 'software' },
];

/**
 * Probes all supported encoder combinations using execution tests.
 */
async function probeAllEncoders(ffmpegPath, signal) {
  const results = [];

  for (const item of MATRIX) {
    let lastStderr = '';
    let lastCode = 0;
    const diagnosticRun = (bin, args, sig, timeout, maxOut) =>
      run(bin, args, sig, timeout, maxOut, (code, stderr) => {
        lastCode = code;
        lastStderr = stderr ? stderr.trim() : '';
      });

    const startHr = process.hrtime.bigint();
    try {
      const bytes = await probeEncoder(ffmpegPath, signal, diagnosticRun, item.encoder, item.codec);
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      results.push({
        ...item,
        available: true,
        bytes: bytes.length,
        durationMs: Math.round(durationMs),
        error: null,
      });
    } catch (err) {
      const durationMs = Number(process.hrtime.bigint() - startHr) / 1e6;
      let failureReason = err.message;
      if (lastStderr) {
        // Extract relevant error snippet
        const lines = lastStderr.split(/\r?\n/).filter(l => /error|failed|cannot|unsupported|invalid/i.test(l));
        if (lines.length) failureReason = lines.slice(-2).join('; ');
      }
      results.push({
        ...item,
        available: false,
        bytes: 0,
        durationMs: Math.round(durationMs),
        exitCode: lastCode,
        error: failureReason,
      });
    }
  }

  return results;
}

/**
 * Probes hardware decode accelerators supported by FFmpeg binary.
 */
function probeHwaccels(ffmpegPath) {
  try {
    const raw = cp.execFileSync(ffmpegPath, ['-hide_banner', '-hwaccels'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 4000,
    });
    return raw
      .split(/\r?\n/)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('Hardware acceleration methods:') && !s.startsWith('==='));
  } catch {
    return [];
  }
}

/**
 * Resolves which encoder to use for a given codec according to uburoom's
 * configured policy, taking into account probe availability.
 */
function resolveEncoderForCodec(codec, configuredEncoder, cpuFallback = true, probedResults = []) {
  if (Array.isArray(cpuFallback)) {
    const tmp = cpuFallback;
    cpuFallback = typeof probedResults === 'boolean' ? probedResults : true;
    probedResults = tmp;
  }
  const getAvailability = (c, enc) => {
    const match = probedResults.find(r => r.codec === c && r.encoder === enc);
    return match ? match.available : false;
  };

  const preferredOrder = [];
  if (configuredEncoder === 'auto' || configuredEncoder === 'hardware') {
    if (codec === 'av1') preferredOrder.push('qsv', 'nvenc');
    else if (codec === 'vp9') preferredOrder.push('qsv');
    // Note: VP8 has no hardware backend in uburoom
  } else {
    preferredOrder.push(configuredEncoder);
  }

  // Attempt preferred
  for (const enc of preferredOrder) {
    if (getAvailability(codec, enc)) {
      return {
        requestedEncoder: configuredEncoder,
        actualEncoder: enc,
        isFallback: enc !== configuredEncoder && configuredEncoder !== 'auto' && configuredEncoder !== 'hardware',
        fallbackReason: null,
      };
    }
  }

  // Fallback to software if allowed
  if (cpuFallback && getAvailability(codec, 'software')) {
    const failedEncoders = preferredOrder.join(', ');
    return {
      requestedEncoder: configuredEncoder,
      actualEncoder: 'software',
      isFallback: configuredEncoder !== 'software',
      fallbackReason: preferredOrder.length
        ? `Hardware encoder (${failedEncoders}) unavailable on this system; fell back to CPU software encoder.`
        : null,
    };
  }

  // No usable encoder
  return {
    requestedEncoder: configuredEncoder,
    actualEncoder: null,
    isFallback: false,
    fallbackReason: `No working encoder found for ${codec.toUpperCase()} (preferred: ${preferredOrder.join(', ') || 'none'}, CPU fallback: ${cpuFallback}).`,
  };
}

module.exports = {
  MATRIX,
  probeAllEncoders,
  probeHwaccels,
  resolveEncoderForCodec,
};
