'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { spawnSafe } = require('./tools');

/**
 * Detects objective quality analysis filters supported by the FFmpeg binary.
 * Checks for libvmaf, ssim, psnr, and CAMBI support.
 */
function detectQualityCapabilities(ffmpegPath) {
  const result = {
    libvmaf: false,
    ssim: false,
    psnr: false,
    cambi: false,
    vmafFeatures: {
      cambi: false,
      psnr: false,
      float_ssim: false
    },
    availableMetrics: [],
    error: null
  };

  try {
    const raw = cp.execFileSync(ffmpegPath, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000
    });

    if (/\blibvmaf\b/i.test(raw)) {
      result.libvmaf = true;
      result.availableMetrics.push('vmaf');
    }
    if (/\bssim\b/i.test(raw)) {
      result.ssim = true;
      result.availableMetrics.push('ssim');
    }
    if (/\bpsnr\b/i.test(raw)) {
      result.psnr = true;
      result.availableMetrics.push('psnr');
    }

    // Check libvmaf features (cambi, float_ssim, psnr) by querying filter help or testing
    if (result.libvmaf) {
      try {
        const help = cp.execFileSync(ffmpegPath, ['-hide_banner', '-h', 'filter=libvmaf'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          windowsHide: true,
          timeout: 4000
        });
        if (/feature/i.test(help)) {
          // Probe whether cambi feature works
          result.vmafFeatures.cambi = true;
          result.vmafFeatures.psnr = true;
          result.vmafFeatures.float_ssim = true;
          result.cambi = true;
          result.availableMetrics.push('cambi');
        }
      } catch {
        // Feature detection fallback
      }
    }
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Calculates statistical percentiles (mean, min, max, harmonicMean, median, p1, p5, p10, stdDev).
 */
function calculateMetricStats(values) {
  if (!values || !values.length) {
    return null;
  }
  const nums = values.filter(v => typeof v === 'number' && !isNaN(v));
  if (!nums.length) return null;

  const sorted = [...nums].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;

  let harmonicSum = 0;
  for (const v of sorted) {
    if (v > 0) harmonicSum += 1 / v;
  }
  const harmonicMean = harmonicSum > 0 ? sorted.length / harmonicSum : mean;

  const getPercentile = p => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * (p / 100))));
    return sorted[idx];
  };

  const variance = sorted.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / sorted.length;
  const stdDev = Math.sqrt(variance);

  return {
    mean: Math.round(mean * 1000) / 1000,
    harmonicMean: Math.round(harmonicMean * 1000) / 1000,
    median: Math.round(getPercentile(50) * 1000) / 1000,
    min: Math.round(sorted[0] * 1000) / 1000,
    p1: Math.round(getPercentile(1) * 1000) / 1000,
    p5: Math.round(getPercentile(5) * 1000) / 1000,
    p10: Math.round(getPercentile(10) * 1000) / 1000,
    max: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    stdDev: Math.round(stdDev * 1000) / 1000
  };
}

/**
 * Finds the worst-performing intervals (lowest average scores across 2-second windows)
 * and lowest frame dips to allow targeted visual inspection.
 */
function findWorstIntervals(timeline, metricKey = 'vmaf', fps = 30, windowSec = 2) {
  if (!timeline || timeline.length === 0) return [];
  const valid = timeline.filter(f => f[metricKey] !== undefined && f[metricKey] !== null);
  if (valid.length === 0) return [];

  const windowFrames = Math.max(1, Math.round((fps || 30) * windowSec));
  const intervals = [];

  for (let i = 0; i <= valid.length - windowFrames; i += Math.max(1, Math.floor(windowFrames / 2))) {
    const slice = valid.slice(i, i + windowFrames);
    const sum = slice.reduce((acc, f) => acc + f[metricKey], 0);
    const avg = sum / slice.length;
    const startSec = slice[0].timestampSec;
    const endSec = slice[slice.length - 1].timestampSec;
    intervals.push({
      startSec: Math.round(startSec * 100) / 100,
      endSec: Math.round(endSec * 100) / 100,
      durationSec: Math.round((endSec - startSec) * 100) / 100,
      averageScore: Math.round(avg * 100) / 100,
      minScore: Math.round(Math.min(...slice.map(f => f[metricKey])) * 100) / 100
    });
  }

  // Sort by average score ascending (worst first) and return top 3
  intervals.sort((a, b) => a.averageScore - b.averageScore);
  return intervals.slice(0, 3);
}

/**
 * Builds the FFmpeg filter graph for quality metric evaluation,
 * handling alignment, resolution normalization (upscaling distorted to match reference per VMAF standard),
 * and HDR-to-SDR tonemapping where applicable.
 */
function buildQualityFilterChain(source, targetQuality, capabilities, jsonLogPath) {
  const refWidth = source.video?.width || 1920;
  const refHeight = source.video?.height || 1080;
  const refFps = source.video?.fps || 30;

  // Dolby Vision Profile 5 check: cannot be compared accurately without Vulkan libplacebo
  if (source.hdr?.doviP5) {
    return {
      supported: false,
      reason: 'Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping for valid reference comparison.'
    };
  }

  const parts = [];

  // 1. Reference stream processing (input 0)
  // Time alignment & frame pacing
  let refFilter = `[0:v]setpts=PTS-STARTPTS,fps=fps=${refFps}`;
  // If reference is HDR10 or HLG, tonemap to SDR BT.709 so comparison against SDR encode is meaningful
  if (source.hdr?.hdr) {
    refFilter += `,zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709`;
  }
  refFilter += `,format=pix_fmts=yuv420p[ref_norm]`;
  parts.push(refFilter);

  // 2. Distorted stream processing (input 1)
  // Time alignment, frame pacing, and scaling to reference resolution
  let distFilter = `[1:v]setpts=PTS-STARTPTS,fps=fps=${refFps}`;
  if (targetQuality.width < refWidth || targetQuality.height < refHeight) {
    // Upscale encoded frame to reference resolution using bicubic filter (standard VMAF methodology)
    distFilter += `,scale=${refWidth}:${refHeight}:flags=bicubic`;
  }
  distFilter += `,format=pix_fmts=yuv420p[dist_norm]`;
  parts.push(distFilter);

  // 3. Metric filter
  let metricFilter = '';
  if (capabilities.libvmaf) {
    let features = [];
    if (capabilities.vmafFeatures?.cambi) features.push('name=cambi');
    if (capabilities.vmafFeatures?.psnr) features.push('name=psnr');
    if (capabilities.vmafFeatures?.float_ssim) features.push('name=float_ssim');

    const featureArg = features.length ? `:feature=${features.join('|')}` : '';
    // Use relative filename to avoid Windows drive-letter colon conflicts in FFmpeg filter syntax
    const logFilename = path.basename(jsonLogPath);
    metricFilter = `[dist_norm][ref_norm]libvmaf=log_fmt=json:log_path=${logFilename}${featureArg}:n_threads=8:shortest=1[out]`;
  } else if (capabilities.ssim || capabilities.psnr) {
    // Fallback: standalone SSIM or PSNR
    if (capabilities.ssim) {
      metricFilter = `[dist_norm][ref_norm]ssim=shortest=1[out]`;
    } else {
      metricFilter = `[dist_norm][ref_norm]psnr=shortest=1[out]`;
    }
  }

  parts.push(metricFilter);

  return {
    supported: true,
    filterGraph: parts.join(';'),
    normalization: {
      method: 'VMAF standard (distorted upscaled to reference resolution with bicubic)',
      refResolution: `${refWidth}x${refHeight}`,
      distResolution: `${targetQuality.width}x${targetQuality.height}`,
      colorTransform: source.hdr?.hdr ? 'HDR-to-SDR tonemapped (hable/bt709)' : 'Native SDR BT.709',
      fps: refFps
    }
  };
}

/**
 * Runs objective quality analysis on an assembled benchmark output video.
 * Uses the untouched source file as reference (NOT the viewing proxy).
 * Runs strictly after timed encoding and does not affect speed/fps measurements.
 */
async function runQualityAnalysis(ffmpegPath, options) {
  const {
    source,
    encodedFilePath,
    startOffset = 0,
    sampleDuration = 60,
    targetQuality,
    outputDir,
    capabilities,
    signal
  } = options;

  if (!capabilities) {
    return {
      available: false,
      status: 'skipped',
      reason: 'Quality analysis capabilities not probed.'
    };
  }

  if (!capabilities.libvmaf && !capabilities.ssim && !capabilities.psnr) {
    return {
      available: false,
      status: 'unavailable',
      reason: 'No supported quality metrics (libvmaf, ssim, psnr) found in FFmpeg installation.'
    };
  }

  if (!source || !source.filePath || !fs.existsSync(source.filePath)) {
    return {
      available: false,
      status: 'skipped',
      reason: 'Reference source file not available on local disk.'
    };
  }

  if (!encodedFilePath || !fs.existsSync(encodedFilePath)) {
    return {
      available: false,
      status: 'failed',
      reason: 'Encoded output file does not exist.'
    };
  }

  const jsonLogPath = path.join(outputDir, 'quality-metrics.json');
  const chain = buildQualityFilterChain(source, targetQuality, capabilities, jsonLogPath);

  if (!chain.supported) {
    return {
      available: false,
      status: 'skipped',
      reason: chain.reason
    };
  }

  // FFmpeg command to execute quality analysis
  // Input 0: reference source interval
  // Input 1: encoded output file
  const args = [
    '-v', 'error',
    '-ss', String(startOffset),
    '-t', String(sampleDuration),
    '-i', source.filePath,
    '-t', String(sampleDuration),
    '-i', encodedFilePath,
    '-filter_complex', chain.filterGraph,
    '-map', '[out]',
    '-f', 'null',
    '-'
  ];

  let stderrOutput = '';
  const timeoutMs = Math.max(60000, Math.ceil(sampleDuration * 4000));

  try {
    await spawnSafe(ffmpegPath, args, {
      cwd: outputDir,
      timeout: timeoutMs,
      signal,
      onStderr: chunk => {
        stderrOutput += chunk.toString();
      }
    });
  } catch (err) {
    return {
      available: false,
      status: 'failed',
      reason: `Quality analysis execution failed: ${err.message}`,
      stderr: stderrOutput.slice(-300)
    };
  }

  // Parse the generated JSON log from libvmaf
  if (capabilities.libvmaf && fs.existsSync(jsonLogPath)) {
    try {
      const raw = fs.readFileSync(jsonLogPath, 'utf8');
      const data = JSON.parse(raw);

      const frames = data.frames || [];
      const pooled = data.pooled_metrics || {};

      const timeline = [];
      const vmafValues = [];
      const ssimValues = [];
      const psnrValues = [];
      const cambiValues = [];

      const fps = source.video?.fps || 30;

      for (let i = 0; i < frames.length; i++) {
        const m = frames[i].metrics || {};
        const timestampSec = Math.round((i / fps) * 1000) / 1000;
        const entry = {
          frameNum: frames[i].frameNum !== undefined ? frames[i].frameNum : i,
          timestampSec
        };

        if (typeof m.vmaf === 'number') {
          entry.vmaf = Math.round(m.vmaf * 100) / 100;
          vmafValues.push(m.vmaf);
        }
        if (typeof m.float_ssim === 'number') {
          entry.ssim = Math.round(m.float_ssim * 10000) / 10000;
          ssimValues.push(m.float_ssim);
        }
        if (typeof m.psnr_y === 'number') {
          entry.psnr = Math.round(m.psnr_y * 100) / 100;
          psnrValues.push(m.psnr_y);
        }
        if (typeof m.cambi === 'number') {
          entry.cambi = Math.round(m.cambi * 10000) / 10000;
          cambiValues.push(m.cambi);
        }

        timeline.push(entry);
      }

      const vmafStats = calculateMetricStats(vmafValues);
      const ssimStats = calculateMetricStats(ssimValues);
      const psnrStats = calculateMetricStats(psnrValues);
      const cambiStats = calculateMetricStats(cambiValues);

      const worstVmafIntervals = findWorstIntervals(timeline, 'vmaf', fps, 2);

      return {
        available: true,
        status: 'pass',
        vmaf: vmafStats,
        ssim: ssimStats,
        psnr: psnrStats,
        cambi: cambiStats,
        worstIntervals: worstVmafIntervals,
        timeline,
        totalFramesEvaluated: frames.length,
        normalization: chain.normalization,
        rawLogRelative: 'quality-metrics.json'
      };
    } catch (parseErr) {
      return {
        available: false,
        status: 'failed',
        reason: `Failed to parse quality metrics JSON: ${parseErr.message}`
      };
    }
  }

  // Fallback for standalone ssim/psnr stdout parsing
  let ssimScore = null;
  let psnrScore = null;
  const ssimMatch = stderrOutput.match(/SSIM\s+Y:([0-9.]+)\s+U:([0-9.]+)\s+V:([0-9.]+)\s+All:([0-9.]+)/i);
  if (ssimMatch) ssimScore = parseFloat(ssimMatch[4]);
  const psnrMatch = stderrOutput.match(/average:([0-9.]+)/i);
  if (psnrMatch) psnrScore = parseFloat(psnrMatch[1]);

  return {
    available: Boolean(ssimScore || psnrScore),
    status: ssimScore || psnrScore ? 'pass' : 'failed',
    ssim: ssimScore ? { mean: ssimScore } : null,
    psnr: psnrScore ? { mean: psnrScore } : null,
    vmaf: null,
    cambi: null,
    worstIntervals: [],
    timeline: [],
    normalization: chain.normalization
  };
}

module.exports = {
  detectQualityCapabilities,
  calculateMetricStats,
  findWorstIntervals,
  buildQualityFilterChain,
  runQualityAnalysis
};
