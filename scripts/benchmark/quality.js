'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { spawnSafe } = require('./tools');

/**
 * Detects objective quality analysis filters supported by the FFmpeg binary.
 * Performs executable test runs to confirm libvmaf and individual features (cambi, psnr, float_ssim).
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

    const hasLibvmafFilter = /\blibvmaf\b/i.test(raw);
    const hasSsimFilter = /\bssim\b/i.test(raw);
    const hasPsnrFilter = /\bpsnr\b/i.test(raw);

    // 1. Executable probe for libvmaf
    if (hasLibvmafFilter) {
      try {
        cp.execFileSync(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
          '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
          '-filter_complex', '[0:v][1:v]libvmaf',
          '-f', 'null',
          '-'
        ], { windowsHide: true, timeout: 5000 });

        result.libvmaf = true;
        result.availableMetrics.push('vmaf');

        // Probe optional libvmaf features individually with executable checks
        // A. CAMBI
        try {
          cp.execFileSync(ffmpegPath, [
            '-v', 'error',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-filter_complex', '[0:v][1:v]libvmaf=feature=name=cambi',
            '-f', 'null',
            '-'
          ], { windowsHide: true, timeout: 5000 });
          result.vmafFeatures.cambi = true;
          result.cambi = true;
          result.availableMetrics.push('cambi');
        } catch {}

        // B. PSNR
        try {
          cp.execFileSync(ffmpegPath, [
            '-v', 'error',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-filter_complex', '[0:v][1:v]libvmaf=feature=name=psnr',
            '-f', 'null',
            '-'
          ], { windowsHide: true, timeout: 5000 });
          result.vmafFeatures.psnr = true;
        } catch {}

        // C. float_ssim
        try {
          cp.execFileSync(ffmpegPath, [
            '-v', 'error',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-f', 'lavfi', '-i', 'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-filter_complex', '[0:v][1:v]libvmaf=feature=name=float_ssim',
            '-f', 'null',
            '-'
          ], { windowsHide: true, timeout: 5000 });
          result.vmafFeatures.float_ssim = true;
        } catch {}
      } catch {
        // libvmaf execution failed
        result.libvmaf = false;
      }
    }

    // 2. Executable probe for standalone SSIM filter
    if (hasSsimFilter) {
      try {
        cp.execFileSync(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi', '-i', 'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
          '-f', 'lavfi', '-i', 'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
          '-filter_complex', '[0:v][1:v]ssim',
          '-f', 'null',
          '-'
        ], { windowsHide: true, timeout: 4000 });
        result.ssim = true;
        if (!result.availableMetrics.includes('ssim')) {
          result.availableMetrics.push('ssim');
        }
      } catch {}
    }

    // 3. Executable probe for standalone PSNR filter
    if (hasPsnrFilter) {
      try {
        cp.execFileSync(ffmpegPath, [
          '-v', 'error',
          '-f', 'lavfi', '-i', 'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
          '-f', 'lavfi', '-i', 'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
          '-filter_complex', '[0:v][1:v]psnr',
          '-f', 'null',
          '-'
        ], { windowsHide: true, timeout: 4000 });
        result.psnr = true;
        if (!result.availableMetrics.includes('psnr')) {
          result.availableMetrics.push('psnr');
        }
      } catch {}
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
function buildQualityFilterChain(source, targetQuality, capabilities, jsonLogPath, selectedMetrics = ['vmaf', 'ssim', 'psnr', 'cambi']) {
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
  // Time alignment, frame pacing, range normalization to TV range, and YUV420p format
  let refFilter = `[0:v]setpts=PTS-STARTPTS,fps=fps=${refFps},scale=in_range=auto:out_range=tv`;
  if (source.hdr?.hdr) {
    refFilter += `,zscale=t=linear:npl=100,tonemap=hable,zscale=p=bt709:t=bt709:m=bt709`;
  }
  refFilter += `,format=pix_fmts=yuv420p[ref_norm]`;
  parts.push(refFilter);

  // 2. Distorted stream processing (input 1)
  // Time alignment, frame pacing, range normalization, and scaling to reference resolution
  let distFilter = `[1:v]setpts=PTS-STARTPTS,fps=fps=${refFps},scale=in_range=auto:out_range=tv`;
  if (targetQuality.width < refWidth || targetQuality.height < refHeight) {
    // Upscale encoded frame to reference resolution using bicubic filter (standard VMAF methodology)
    distFilter += `,scale=${refWidth}:${refHeight}:flags=bicubic`;
  }
  distFilter += `,format=pix_fmts=yuv420p[dist_norm]`;
  parts.push(distFilter);

  // 3. Metric filter resolution
  let metricFilter = '';
  const wantsVmaf = selectedMetrics.includes('vmaf');
  const wantsCambi = selectedMetrics.includes('cambi');
  const wantsSsim = selectedMetrics.includes('ssim');
  const wantsPsnr = selectedMetrics.includes('psnr');

  // libvmaf is used whenever VMAF or CAMBI is requested (CAMBI is evaluated via libvmaf)
  const needsLibvmaf = wantsVmaf || wantsCambi;

  if (needsLibvmaf) {
    if (!capabilities.libvmaf) {
      return {
        supported: false,
        reason: wantsCambi && !wantsVmaf
          ? 'CAMBI requires libvmaf which is not available in the current FFmpeg installation.'
          : 'libvmaf is not available in the current FFmpeg installation.'
      };
    }

    if (wantsCambi && !capabilities.vmafFeatures?.cambi) {
      return {
        supported: false,
        reason: 'CAMBI feature is not available in the current FFmpeg libvmaf build.'
      };
    }

    const features = [];
    if (wantsCambi && capabilities.vmafFeatures?.cambi) {
      features.push('name=cambi');
    }
    if (wantsPsnr && capabilities.vmafFeatures?.psnr) {
      features.push('name=psnr');
    }
    if (wantsSsim && capabilities.vmafFeatures?.float_ssim) {
      features.push('name=float_ssim');
    }

    const featureArg = features.length ? `:feature=${features.join('|')}` : '';
    const logFilename = path.basename(jsonLogPath);
    metricFilter = `[dist_norm][ref_norm]libvmaf=log_fmt=json:log_path=${logFilename}${featureArg}:n_threads=8:shortest=1[out]`;
  } else {
    // Standalone metric fallback when neither VMAF nor CAMBI is requested
    const wantsStandaloneSsim = wantsSsim && capabilities.ssim;
    const wantsStandalonePsnr = wantsPsnr && capabilities.psnr;

    if (wantsStandaloneSsim && wantsStandalonePsnr) {
      metricFilter = `[dist_norm]split=2[d1][d2];[ref_norm]split=2[r1][r2];[d1][r1]ssim=stats_file=ssim.log:shortest=1[s_out];[d2][r2]psnr=stats_file=psnr.log:shortest=1[p_out];[s_out][p_out]overlay[out]`;
    } else if (wantsStandaloneSsim) {
      metricFilter = `[dist_norm][ref_norm]ssim=stats_file=ssim.log:shortest=1[out]`;
    } else if (wantsStandalonePsnr) {
      metricFilter = `[dist_norm][ref_norm]psnr=stats_file=psnr.log:shortest=1[out]`;
    } else {
      return {
        supported: false,
        reason: 'None of the requested quality metrics are available in the current FFmpeg installation.'
      };
    }
  }

  parts.push(metricFilter);

  return {
    supported: true,
    usesLibvmaf: needsLibvmaf,
    filterGraph: parts.join(';'),
    normalization: {
      method: 'VMAF standard (distorted upscaled to reference resolution with bicubic)',
      refResolution: `${refWidth}x${refHeight}`,
      distResolution: `${targetQuality.width}x${targetQuality.height}`,
      colorTransform: source.hdr?.hdr ? 'HDR-to-SDR tonemapped (hable/bt709, TV range)' : 'Native SDR BT.709 (TV range)',
      refFps
    }
  };
}

/**
 * Validates real presentation timestamps and decoded-frame timing between source interval
 * and encoded output. Demuxes actual packet timestamps rather than synthesizing from frame counts.
 * Returns { status: 'verified' | 'unverified' | 'misaligned', errors: [], details: {} }.
 */
function validateTemporalAlignment(ffprobePath, sourcePath, encodedPath, options = {}) {
  const { startOffset = 0, sampleDuration = 60, fps = 30, isVfr = false } = options;
  const errors = [];

  // 1. Demux packet timestamps from encoded output
  const encodedPackets = [];
  try {
    const rawEncoded = cp.execFileSync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-of', 'csv=p=0',
      encodedPath
    ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });

    for (const line of rawEncoded.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ptsStr, durStr] = trimmed.split(',');
      const pts = parseFloat(ptsStr);
      const dur = parseFloat(durStr) || (fps ? 1 / fps : 0.033);
      if (!isNaN(pts)) encodedPackets.push({ pts, dur });
    }
  } catch (err) {
    return {
      status: 'unverified',
      reason: `Could not demux encoded video packet timestamps: ${err.message}`,
      errors: [`Encoded packet inspection failed: ${err.message}`]
    };
  }

  if (encodedPackets.length === 0) {
    return {
      status: 'misaligned',
      reason: 'Encoded video stream contains no demuxable video packets.',
      errors: ['No video packets found in encoded video.']
    };
  }

  const encodedFirstPts = encodedPackets[0].pts;
  const encodedLastPts = encodedPackets[encodedPackets.length - 1].pts;
  const encodedDuration = encodedLastPts - encodedFirstPts + encodedPackets[encodedPackets.length - 1].dur;

  // 2. Demux packet timestamps from source interval [startOffset, startOffset + sampleDuration]
  const sourcePackets = [];
  let sourceReadFailed = false;
  try {
    const rawSource = cp.execFileSync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-read_intervals', `${startOffset}%+${sampleDuration}`,
      '-of', 'csv=p=0',
      sourcePath
    ], { encoding: 'utf8', windowsHide: true, timeout: 25000 });

    for (const line of rawSource.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [ptsStr, durStr] = trimmed.split(',');
      const pts = parseFloat(ptsStr);
      const dur = parseFloat(durStr) || (fps ? 1 / fps : 0.033);
      if (!isNaN(pts)) sourcePackets.push({ pts, dur });
    }
  } catch {
    // If -read_intervals is unsupported by this container/demuxer, try -ss / -t fallback
    try {
      const rawSource = cp.execFileSync(ffprobePath, [
        '-v', 'error',
        '-ss', String(startOffset),
        '-t', String(sampleDuration),
        '-select_streams', 'v:0',
        '-show_entries', 'packet=pts_time,duration_time',
        '-of', 'csv=p=0',
        sourcePath
      ], { encoding: 'utf8', windowsHide: true, timeout: 25000 });
      for (const line of rawSource.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [ptsStr, durStr] = trimmed.split(',');
        const pts = parseFloat(ptsStr);
        const dur = parseFloat(durStr) || (fps ? 1 / fps : 0.033);
        if (!isNaN(pts)) sourcePackets.push({ pts, dur });
      }
    } catch {
      sourceReadFailed = true;
    }
  }

  // Presentation start check: encoded video should start at 0.0s (<= 0.08s)
  if (encodedFirstPts > 0.08) {
    errors.push(`Encoded presentation start delay: first packet begins at ${encodedFirstPts.toFixed(3)}s (expected <= 0.08s).`);
  }

  // Duration check
  if (Math.abs(encodedDuration - sampleDuration) > 0.25) {
    errors.push(`Encoded duration mismatch: ${encodedDuration.toFixed(2)}s vs requested ${sampleDuration}s.`);
  }

  // Frame count / coverage check
  const expectedFrames = Math.round(sampleDuration * fps);
  if (!isVfr) {
    if (Math.abs(encodedPackets.length - expectedFrames) > 3) {
      errors.push(`Encoded frame count mismatch: expected ~${expectedFrames} frames, demuxed ${encodedPackets.length}.`);
    }
    if (sourcePackets.length > 0 && Math.abs(encodedPackets.length - sourcePackets.length) > 3) {
      errors.push(`Source/encoded frame count divergence: source interval has ${sourcePackets.length} frames, encoded has ${encodedPackets.length}.`);
    }
  } else {
    if (encodedDuration < sampleDuration * 0.85) {
      errors.push(`VFR duration coverage below threshold: ${encodedDuration.toFixed(2)}s is below 85% of ${sampleDuration}s.`);
    }
  }

  if (errors.length > 0) {
    return {
      status: 'misaligned',
      reason: errors.join('; '),
      errors,
      encodedFirstPts,
      encodedDuration: Math.round(encodedDuration * 1000) / 1000,
      encodedPacketCount: encodedPackets.length,
      sourcePacketCount: sourcePackets.length
    };
  }

  if (sourceReadFailed || sourcePackets.length === 0) {
    return {
      status: 'unverified',
      reason: 'Source interval packet timestamps could not be extracted; temporal alignment verified from encoded presentation timing only.',
      errors: [],
      encodedFirstPts,
      encodedDuration: Math.round(encodedDuration * 1000) / 1000,
      encodedPacketCount: encodedPackets.length
    };
  }

  return {
    status: 'verified',
    reason: null,
    errors: [],
    encodedFirstPts,
    encodedDuration: Math.round(encodedDuration * 1000) / 1000,
    encodedPacketCount: encodedPackets.length,
    sourcePacketCount: sourcePackets.length
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
    selectedMetrics = ['vmaf', 'ssim', 'psnr', 'cambi'],
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

  const ffprobePath = options.ffprobePath || ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
  const fps = source.video?.fps || 30;
  const isVfr = Boolean(source.video?.isVfr);
  const expectedFrames = Math.round(sampleDuration * fps);

  // Validate actual presentation timestamps and decoded-frame timing between source and encode
  const temporal = validateTemporalAlignment(ffprobePath, source.filePath, encodedFilePath, {
    startOffset,
    sampleDuration,
    fps,
    isVfr
  });

  if (temporal.status === 'misaligned') {
    return {
      available: true,
      status: 'failed',
      reason: `Temporal alignment validation failed: ${temporal.reason}`,
      temporalAlignment: temporal,
      validation: { valid: false, errors: temporal.errors }
    };
  }

  const jsonLogPath = path.join(outputDir, 'quality-metrics.json');
  const chain = buildQualityFilterChain(source, targetQuality, capabilities, jsonLogPath, selectedMetrics);

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
      available: true,
      status: 'failed',
      reason: `Quality analysis execution failed: ${err.message}`,
      stderr: stderrOutput.slice(-300)
    };
  }

  // 1. Parse libvmaf JSON log if libvmaf was executed
  if (chain.usesLibvmaf && fs.existsSync(jsonLogPath)) {
    try {
      const raw = fs.readFileSync(jsonLogPath, 'utf8');
      const data = JSON.parse(raw);

      const frames = data.frames || [];
      const validationErrors = [];

      // Frame count and coverage verification
      if (frames.length === 0) {
        validationErrors.push('No video frames were analyzed by the quality filter.');
      } else {
        const hasExplicitPts = frames[0]?.metrics?.timestampSec !== undefined;
        if (hasExplicitPts && frames[0].metrics.timestampSec > 0.08) {
          validationErrors.push(`Temporal misalignment in metric log: first scored frame begins at ${frames[0].metrics.timestampSec.toFixed(3)}s (expected <= 0.08s).`);
        }

        if (!isVfr && Math.abs(frames.length - expectedFrames) > 3) {
          validationErrors.push(`Incomplete metric sequence: expected ~${expectedFrames} frames, scored only ${frames.length} frames.`);
        }
      }

      if (validationErrors.length > 0) {
        return {
          available: true,
          status: 'failed',
          reason: validationErrors.join('; '),
          validation: { valid: false, errors: validationErrors }
        };
      }

      const timeline = [];
      const vmafValues = [];
      const ssimValues = [];
      const psnrValues = [];
      const cambiValues = [];

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

      const vmafStats = selectedMetrics.includes('vmaf') ? calculateMetricStats(vmafValues) : null;
      const ssimStats = selectedMetrics.includes('ssim') ? calculateMetricStats(ssimValues) : null;
      const psnrStats = selectedMetrics.includes('psnr') ? calculateMetricStats(psnrValues) : null;
      const cambiStats = selectedMetrics.includes('cambi') ? calculateMetricStats(cambiValues) : null;

      const metricForWorstInterval = selectedMetrics.includes('vmaf') ? 'vmaf'
        : (selectedMetrics.includes('ssim') ? 'ssim'
        : (selectedMetrics.includes('psnr') ? 'psnr'
        : (selectedMetrics.includes('cambi') ? 'cambi' : null)));

      const worstIntervals = metricForWorstInterval ? findWorstIntervals(timeline, metricForWorstInterval, fps, 2) : [];

      return {
        available: true,
        status: 'pass',
        vmaf: vmafStats,
        ssim: ssimStats,
        psnr: psnrStats,
        cambi: cambiStats,
        worstIntervals,
        timeline,
        totalFramesEvaluated: frames.length,
        normalization: {
          ...chain.normalization,
          expectedFrames,
          evaluatedFrames: frames.length,
          coveragePercent: Math.round((frames.length / (expectedFrames || 1)) * 1000) / 10,
          isVfr
        },
        temporalAlignment: temporal,
        validation: { valid: true, errors: [] },
        rawLogRelative: path.basename(jsonLogPath)
      };
    } catch (parseErr) {
      return {
        available: true,
        status: 'failed',
        reason: `Failed to parse libvmaf output: ${parseErr.message}`
      };
    }
  }

  // 2. Parse standalone SSIM and PSNR logs if standalone filters were executed
  const ssimLogPath = path.join(outputDir, 'ssim.log');
  const psnrLogPath = path.join(outputDir, 'psnr.log');

  const ssimValues = [];
  const psnrValues = [];
  const timeline = [];

  if (fs.existsSync(ssimLogPath)) {
    try {
      const ssimRaw = fs.readFileSync(ssimLogPath, 'utf8');
      const lines = ssimRaw.split(/\r?\n/).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const match = /All:([0-9.]+)/.exec(lines[i]);
        if (match) {
          const val = parseFloat(match[1]);
          ssimValues.push(val);
          timeline.push({ frameNum: i, timestampSec: Math.round((i / fps) * 1000) / 1000, ssim: val });
        }
      }
    } catch {}
  }

  if (fs.existsSync(psnrLogPath)) {
    try {
      const psnrRaw = fs.readFileSync(psnrLogPath, 'utf8');
      const lines = psnrRaw.split(/\r?\n/).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const match = /psnr_avg:([0-9.]+|inf)/.exec(lines[i]);
        if (match) {
          const val = match[1] === 'inf' ? 60 : parseFloat(match[1]);
          psnrValues.push(val);
          if (timeline[i]) {
            timeline[i].psnr = val;
          } else {
            timeline.push({ frameNum: i, timestampSec: Math.round((i / fps) * 1000) / 1000, psnr: val });
          }
        }
      }
    } catch {}
  }

  const scoredCount = Math.max(ssimValues.length, psnrValues.length);
  if (scoredCount === 0) {
    return {
      available: true,
      status: 'failed',
      reason: 'No metric data was produced by standalone quality filters.'
    };
  }

  if (!isVfr && Math.abs(scoredCount - expectedFrames) > 3) {
    return {
      available: true,
      status: 'failed',
      reason: `Incomplete metric sequence: expected ~${expectedFrames} frames, scored only ${scoredCount} frames.`,
      validation: { valid: false, errors: [`Scored ${scoredCount} frames out of ${expectedFrames} expected`] }
    };
  }

  return {
    available: true,
    status: 'pass',
    vmaf: null,
    ssim: selectedMetrics.includes('ssim') ? calculateMetricStats(ssimValues) : null,
    psnr: selectedMetrics.includes('psnr') ? calculateMetricStats(psnrValues) : null,
    cambi: null,
    worstIntervals: ssimValues.length ? findWorstIntervals(timeline, 'ssim', fps, 2) : [],
    timeline,
    totalFramesEvaluated: scoredCount,
    normalization: {
      ...chain.normalization,
      expectedFrames,
      evaluatedFrames: scoredCount,
      coveragePercent: Math.round((scoredCount / (expectedFrames || 1)) * 1000) / 10,
      isVfr
    },
    temporalAlignment: temporal,
    validation: { valid: true, errors: [] }
  };
}

module.exports = {
  detectQualityCapabilities,
  calculateMetricStats,
  findWorstIntervals,
  buildQualityFilterChain,
  validateTemporalAlignment,
  runQualityAnalysis
};
