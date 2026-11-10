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
      float_ssim: false,
    },
    availableMetrics: [],
    error: null,
  };

  try {
    const raw = cp.execFileSync(ffmpegPath, ['-hide_banner', '-filters'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 5000,
    });

    const hasLibvmafFilter = /\blibvmaf\b/i.test(raw);
    const hasSsimFilter = /\bssim\b/i.test(raw);
    const hasPsnrFilter = /\bpsnr\b/i.test(raw);

    // 1. Executable probe for libvmaf
    if (hasLibvmafFilter) {
      try {
        cp.execFileSync(
          ffmpegPath,
          [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
            '-filter_complex',
            '[0:v][1:v]libvmaf',
            '-f',
            'null',
            '-',
          ],
          { windowsHide: true, timeout: 5000 },
        );

        result.libvmaf = true;
        result.availableMetrics.push('vmaf');

        // Probe optional libvmaf features individually with executable checks
        // A. CAMBI
        try {
          cp.execFileSync(
            ffmpegPath,
            [
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-filter_complex',
              '[0:v][1:v]libvmaf=feature=name=cambi',
              '-f',
              'null',
              '-',
            ],
            { windowsHide: true, timeout: 5000 },
          );
          result.vmafFeatures.cambi = true;
          result.cambi = true;
          result.availableMetrics.push('cambi');
        } catch {}

        // B. PSNR
        try {
          cp.execFileSync(
            ffmpegPath,
            [
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-filter_complex',
              '[0:v][1:v]libvmaf=feature=name=psnr',
              '-f',
              'null',
              '-',
            ],
            { windowsHide: true, timeout: 5000 },
          );
          result.vmafFeatures.psnr = true;
        } catch {}

        // C. float_ssim
        try {
          cp.execFileSync(
            ffmpegPath,
            [
              '-v',
              'error',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-f',
              'lavfi',
              '-i',
              'testsrc=s=256x256:d=0.08:r=25,format=yuv420p',
              '-filter_complex',
              '[0:v][1:v]libvmaf=feature=name=float_ssim',
              '-f',
              'null',
              '-',
            ],
            { windowsHide: true, timeout: 5000 },
          );
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
        cp.execFileSync(
          ffmpegPath,
          [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
            '-filter_complex',
            '[0:v][1:v]ssim',
            '-f',
            'null',
            '-',
          ],
          { windowsHide: true, timeout: 4000 },
        );
        result.ssim = true;
        if (!result.availableMetrics.includes('ssim')) {
          result.availableMetrics.push('ssim');
        }
      } catch {}
    }

    // 3. Executable probe for standalone PSNR filter
    if (hasPsnrFilter) {
      try {
        cp.execFileSync(
          ffmpegPath,
          [
            '-v',
            'error',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
            '-f',
            'lavfi',
            '-i',
            'testsrc=s=128x128:d=0.04:r=25,format=yuv420p',
            '-filter_complex',
            '[0:v][1:v]psnr',
            '-f',
            'null',
            '-',
          ],
          { windowsHide: true, timeout: 4000 },
        );
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
    stdDev: Math.round(stdDev * 1000) / 1000,
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
      minScore: Math.round(Math.min(...slice.map(f => f[metricKey])) * 100) / 100,
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
function buildQualityFilterChain(
  source,
  targetQuality,
  capabilities,
  jsonLogPath,
  selectedMetrics = ['vmaf', 'ssim', 'psnr', 'cambi'],
) {
  const refWidth = source.video?.width || 1920;
  const refHeight = source.video?.height || 1080;
  const refFps = source.video?.fps || 30;

  // Dolby Vision Profile 5 check: cannot be compared accurately without Vulkan libplacebo
  if (source.hdr?.doviP5) {
    return {
      supported: false,
      reason: 'Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping for valid reference comparison.',
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

  // 3. Metric filter resolution & partial availability tracking
  const unavailableMetrics = [];

  for (const metric of selectedMetrics) {
    if (metric === 'cambi') {
      if (!capabilities.libvmaf) {
        unavailableMetrics.push({
          metric: 'cambi',
          reason: 'CAMBI requires libvmaf which is not available in FFmpeg build.',
        });
      } else if (!capabilities.vmafFeatures?.cambi) {
        unavailableMetrics.push({ metric: 'cambi', reason: 'CAMBI feature is not available in FFmpeg libvmaf build.' });
      }
    } else if (metric === 'vmaf') {
      if (!capabilities.libvmaf) {
        unavailableMetrics.push({ metric: 'vmaf', reason: 'libvmaf filter is not available in FFmpeg build.' });
      }
    } else if (metric === 'ssim') {
      const hasVmafSsim = capabilities.libvmaf && capabilities.vmafFeatures?.float_ssim;
      if (!hasVmafSsim && !capabilities.ssim) {
        unavailableMetrics.push({
          metric: 'ssim',
          reason: 'Neither libvmaf float_ssim nor standalone ssim filter is available in FFmpeg build.',
        });
      }
    } else if (metric === 'psnr') {
      const hasVmafPsnr = capabilities.libvmaf && capabilities.vmafFeatures?.psnr;
      if (!hasVmafPsnr && !capabilities.psnr) {
        unavailableMetrics.push({
          metric: 'psnr',
          reason: 'Neither libvmaf psnr nor standalone psnr filter is available in FFmpeg build.',
        });
      }
    }
  }

  const activeMetrics = selectedMetrics.filter(m => !unavailableMetrics.some(u => u.metric === m));

  if (activeMetrics.length === 0) {
    return {
      supported: false,
      reason: unavailableMetrics.map(u => `${u.metric.toUpperCase()}: ${u.reason}`).join('; '),
      unavailableMetrics,
      activeMetrics: [],
    };
  }

  let metricFilter = '';
  const wantsVmaf = activeMetrics.includes('vmaf');
  const wantsCambi = activeMetrics.includes('cambi');
  const wantsSsim = activeMetrics.includes('ssim');
  const wantsPsnr = activeMetrics.includes('psnr');

  // Use libvmaf if VMAF or CAMBI is active and libvmaf is available
  const canUseLibvmaf = (wantsVmaf || wantsCambi) && capabilities.libvmaf;
  const secondaryMetrics = [];
  let secondaryFilterGraph = null;

  if (canUseLibvmaf) {
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

    // When libvmaf lacks optional float_ssim or psnr but standalone filters exist,
    // prepare a secondary standalone filter graph so metrics are not silently omitted.
    const needsStandaloneSsim = wantsSsim && !capabilities.vmafFeatures?.float_ssim && capabilities.ssim;
    const needsStandalonePsnr = wantsPsnr && !capabilities.vmafFeatures?.psnr && capabilities.psnr;

    if (needsStandaloneSsim || needsStandalonePsnr) {
      if (needsStandaloneSsim) secondaryMetrics.push('ssim');
      if (needsStandalonePsnr) secondaryMetrics.push('psnr');

      let secondaryMetricFilter = '';
      if (needsStandaloneSsim && needsStandalonePsnr) {
        secondaryMetricFilter = `[dist_norm]split=2[d1][d2];[ref_norm]split=2[r1][r2];[d1][r1]ssim=stats_file=ssim.log:shortest=1[s_out];[d2][r2]psnr=stats_file=psnr.log:shortest=1[p_out];[s_out][p_out]overlay[out]`;
      } else if (needsStandaloneSsim) {
        secondaryMetricFilter = `[dist_norm][ref_norm]ssim=stats_file=ssim.log:shortest=1[out]`;
      } else if (needsStandalonePsnr) {
        secondaryMetricFilter = `[dist_norm][ref_norm]psnr=stats_file=psnr.log:shortest=1[out]`;
      }
      secondaryFilterGraph = `${parts[0]};${parts[1]};${secondaryMetricFilter}`;
    }
  } else {
    // Standalone metric fallback when libvmaf is not used or unavailable
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
        reason: 'None of the requested quality metrics are available in the current FFmpeg installation.',
        unavailableMetrics,
        activeMetrics: [],
      };
    }
  }

  parts.push(metricFilter);

  return {
    supported: true,
    usesLibvmaf: canUseLibvmaf,
    filterGraph: parts.join(';'),
    needsSecondaryStandalonePass: secondaryMetrics.length > 0,
    secondaryMetrics,
    secondaryFilterGraph,
    unavailableMetrics,
    activeMetrics,
    normalization: {
      method: 'VMAF standard (distorted upscaled to reference resolution with bicubic)',
      refResolution: `${refWidth}x${refHeight}`,
      distResolution: `${targetQuality.width}x${targetQuality.height}`,
      colorTransform: source.hdr?.hdr
        ? 'HDR-to-SDR tonemapped (hable/bt709, TV range)'
        : 'Native SDR BT.709 (TV range)',
      refFps,
    },
  };
}

/**
 * Parses the final decoded frame count from FFmpeg progress output.
 * Reads the last reported frame count rather than premature intermediate progress lines.
 */
function parseFinalDecodedFrames(stderr) {
  if (!stderr || typeof stderr !== 'string') return null;
  const matches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
  if (!matches.length) return null;
  const lastMatch = matches[matches.length - 1];
  const count = parseInt(lastMatch[1], 10);
  return Number.isFinite(count) ? count : null;
}

/**
 * Validates real presentation timestamps and decoded-frame timing between source interval
 * and encoded output. Demuxes actual packet timestamps rather than synthesizing from frame counts.
 * Returns { status: 'verified' | 'unverified' | 'misaligned', errors: [], details: {} }.
 */
function validateTemporalAlignment(ffprobePath, sourcePath, encodedPath, options = {}) {
  const { startOffset = 0, sampleDuration = 60, fps = 30, isVfr = false, probeTimeoutMs = null } = options;
  const errors = [];

  // 1. Demux packet timestamps from encoded output
  const encodedPackets = [];
  try {
    const rawEncoded = cp.execFileSync(
      ffprobePath,
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'packet=pts_time,duration_time',
        '-of',
        'csv=p=0',
        encodedPath,
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 },
    );

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
      errors: [`Encoded packet inspection failed: ${err.message}`],
    };
  }

  if (encodedPackets.length === 0) {
    return {
      status: 'misaligned',
      reason: 'Encoded video stream contains no demuxable video packets.',
      errors: ['No video packets found in encoded video.'],
    };
  }

  const encodedFirstPts = encodedPackets[0].pts;
  const encodedLastPts = encodedPackets[encodedPackets.length - 1].pts;
  const encodedDuration = encodedLastPts - encodedFirstPts + encodedPackets[encodedPackets.length - 1].dur;

  // 2. Inspect decoded frames from the exact requested source interval [-ss startOffset -t sampleDuration]
  // Note: FFprobe -read_intervals seeks to the preceding keyframe, which on long-GOP / B-frame content
  // begins earlier than startOffset. Decoding through FFmpeg extracts the exact frames presented to the quality filter.
  const ffmpegPath =
    options.ffmpegPath ||
    (path.isAbsolute(ffprobePath) ? ffprobePath.replace(/ffprobe(\.exe)?$/i, 'ffmpeg$1') : 'ffmpeg');
  let sourceDecodedFrameCount = null;
  let sourceProbeCompleted = false;
  let sourceProbeReason = null;

  if (ffmpegPath) {
    // Bounded duration-aware timeout (scales with sample duration, minimum 30s, up to 180s)
    const timeoutMs = probeTimeoutMs || Math.min(180000, Math.max(30000, Math.ceil(sampleDuration * 3000)));
    const probeArgs = [
      '-v',
      'info',
      '-hwaccel',
      'auto',
      '-ss',
      String(startOffset),
      '-t',
      String(sampleDuration),
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-f',
      'null',
      '-',
    ];

    try {
      const probeRes = cp.spawnSync(ffmpegPath, probeArgs, {
        encoding: 'utf8',
        windowsHide: true,
        timeout: timeoutMs,
      });

      if (probeRes.error) {
        if (probeRes.error.code === 'ETIMEDOUT') {
          sourceProbeReason = `Source frame count decode timed out after ${timeoutMs}ms`;
        } else {
          sourceProbeReason = `Source frame count decode failed: ${probeRes.error.message}`;
        }
      } else if (probeRes.signal) {
        sourceProbeReason = `Source frame count decode terminated by signal ${probeRes.signal}`;
      } else if (probeRes.status !== 0) {
        sourceProbeReason = `Source frame count decode exited with non-zero status ${probeRes.status}`;
      } else {
        // Process completed successfully with exit code 0
        const finalCount = parseFinalDecodedFrames(probeRes.stderr || '');
        if (finalCount !== null) {
          sourceDecodedFrameCount = finalCount;
          sourceProbeCompleted = true;
        } else {
          sourceProbeReason = 'Could not parse final decoded frame count from FFmpeg output';
        }
      }
    } catch (err) {
      sourceProbeReason = `Source frame count probe execution error: ${err.message}`;
    }
  }

  // Presentation start check: encoded video should start at 0.0s (<= 0.08s)
  if (encodedFirstPts > 0.08) {
    errors.push(
      `Encoded presentation start delay: first packet begins at ${encodedFirstPts.toFixed(3)}s (expected <= 0.08s).`,
    );
  }

  // Duration check
  if (Math.abs(encodedDuration - sampleDuration) > 0.25) {
    errors.push(`Encoded duration mismatch: ${encodedDuration.toFixed(2)}s vs requested ${sampleDuration}s.`);
  }

  // Frame count / coverage check
  const expectedFrames = Math.round(sampleDuration * fps);
  if (!isVfr) {
    if (Math.abs(encodedPackets.length - expectedFrames) > 3) {
      errors.push(
        `Encoded frame count mismatch: expected ~${expectedFrames} frames, demuxed ${encodedPackets.length}.`,
      );
    }
    // Only enforce source vs encoded count divergence when the source decode probe actually completed to status 0
    if (
      sourceProbeCompleted &&
      sourceDecodedFrameCount !== null &&
      Math.abs(encodedPackets.length - sourceDecodedFrameCount) > 3
    ) {
      errors.push(
        `Source/encoded frame count divergence: source interval decoded ${sourceDecodedFrameCount} frames, encoded has ${encodedPackets.length}.`,
      );
    }
  } else {
    if (encodedDuration < sampleDuration * 0.85) {
      errors.push(
        `VFR duration coverage below threshold: ${encodedDuration.toFixed(2)}s is below 85% of ${sampleDuration}s.`,
      );
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
      sourcePacketCount: sourceDecodedFrameCount,
    };
  }

  // 3. Content correspondence verification
  // Verify that the decoded frames of the encoded video visually correspond to the source interval,
  // rather than a time-shifted or content-divergent stream whose timestamps were reset to 0.
  // Performs multi-anchor checking (start and midpoint) and distinguishes high vs heuristic confidence.
  let contentCheckResult = {
    status: 'unverified',
    confidence: 'unverified',
    reason: 'FFmpeg binary not available for content correspondence check.',
  };

  if (ffmpegPath) {
    try {
      const probeDuration = Math.min(1.0, Math.max(0.4, sampleDuration * 0.2));
      const runProbe = (srcSeek, encSeek) => {
        const probeArgs = ['-v', 'info', '-ss', String(srcSeek), '-t', String(probeDuration), '-i', sourcePath];
        if (encSeek > 0) {
          probeArgs.push('-ss', String(encSeek));
        }
        probeArgs.push(
          '-t',
          String(probeDuration),
          '-i',
          encodedPath,
          '-filter_complex',
          '[0:v]scale=160:90,format=yuv420p[r];[1:v]scale=160:90,format=yuv420p[e];[e][r]ssim',
          '-f',
          'null',
          '-',
        );
        const res = cp.spawnSync(ffmpegPath, probeArgs, {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 15000,
        });
        const combinedOutput = (res.stderr || '') + '\n' + (res.stdout || '');
        const match = /All:([0-9.]+)/.exec(combinedOutput);
        return match ? parseFloat(match[1]) : null;
      };

      const startScore = runProbe(startOffset, 0);

      if (startScore !== null && !isNaN(startScore)) {
        if (startScore < 0.8) {
          contentCheckResult = {
            status: 'misaligned',
            confidence: 'high',
            score: startScore,
            reason: `Content correspondence check failed at start anchor: encoded frames visually diverge from requested source interval (correlation SSIM: ${startScore.toFixed(3)} < 0.80). Content appears shifted or mismatched.`,
          };
        } else {
          // If sample interval is sufficiently long, test second temporal anchor at midpoint
          let midScore = null;
          if (sampleDuration >= 4.0) {
            const midOffset = startOffset + Math.round(sampleDuration * 0.5 * 100) / 100;
            const encMidOffset = Math.round(sampleDuration * 0.5 * 100) / 100;
            midScore = runProbe(midOffset, encMidOffset);
          }

          if (midScore !== null && !isNaN(midScore)) {
            if (midScore < 0.8) {
              contentCheckResult = {
                status: 'misaligned',
                confidence: 'high',
                score: midScore,
                reason: `Content correspondence check failed at midpoint anchor: encoded stream drifted or diverged from source (correlation SSIM: ${midScore.toFixed(3)} < 0.80).`,
              };
            } else {
              const avgScore = Math.round(((startScore + midScore) / 2) * 1000) / 1000;
              contentCheckResult = {
                status: 'verified',
                confidence: 'high',
                score: avgScore,
                anchorScores: { start: startScore, mid: midScore },
              };
            }
          } else {
            // Single anchor probe (short duration or midpoint probe unparseable)
            contentCheckResult = {
              status: 'verified',
              confidence: 'heuristic',
              score: startScore,
              anchorScores: { start: startScore },
            };
          }
        }
      } else {
        contentCheckResult = {
          status: 'unverified',
          confidence: 'unverified',
          reason: 'Could not extract content correlation score from verification probe.',
        };
      }
    } catch (checkErr) {
      contentCheckResult = {
        status: 'unverified',
        confidence: 'unverified',
        reason: `Content correspondence probe could not be completed: ${checkErr.message}`,
      };
    }
  }

  if (contentCheckResult.status === 'misaligned') {
    return {
      status: 'misaligned',
      confidence: contentCheckResult.confidence || 'high',
      reason: contentCheckResult.reason,
      errors: [contentCheckResult.reason],
      encodedFirstPts,
      encodedDuration: Math.round(encodedDuration * 1000) / 1000,
      encodedPacketCount: encodedPackets.length,
      sourcePacketCount: sourceDecodedFrameCount,
      contentScore: contentCheckResult.score,
      anchorScores: contentCheckResult.anchorScores || null,
    };
  }

  if (contentCheckResult.status === 'unverified') {
    return {
      status: 'unverified',
      confidence: 'unverified',
      reason: contentCheckResult.reason,
      errors: [],
      encodedFirstPts,
      encodedDuration: Math.round(encodedDuration * 1000) / 1000,
      encodedPacketCount: encodedPackets.length,
      sourcePacketCount: sourceDecodedFrameCount,
    };
  }

  // If source frame count probe was incomplete or timed out, report as unverified rather than full verified
  if (!sourceProbeCompleted && sourceProbeReason) {
    return {
      status: 'unverified',
      confidence: 'heuristic',
      reason: sourceProbeReason,
      errors: [],
      encodedFirstPts,
      encodedDuration: Math.round(encodedDuration * 1000) / 1000,
      encodedPacketCount: encodedPackets.length,
      sourcePacketCount: null,
      sourceProbeIncomplete: true,
      contentScore: contentCheckResult.score,
      anchorScores: contentCheckResult.anchorScores || null,
    };
  }

  return {
    status: 'verified',
    confidence: contentCheckResult.confidence || 'high',
    reason: null,
    errors: [],
    encodedFirstPts,
    encodedDuration: Math.round(encodedDuration * 1000) / 1000,
    encodedPacketCount: encodedPackets.length,
    sourcePacketCount: sourceDecodedFrameCount,
    contentScore: contentCheckResult.score,
    anchorScores: contentCheckResult.anchorScores || null,
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
    signal,
  } = options;

  if (!capabilities) {
    return {
      available: false,
      status: 'skipped',
      reason: 'Quality analysis capabilities not probed.',
    };
  }

  if (!capabilities.libvmaf && !capabilities.ssim && !capabilities.psnr) {
    return {
      available: false,
      status: 'unavailable',
      reason: 'No supported quality metrics (libvmaf, ssim, psnr) found in FFmpeg installation.',
    };
  }

  if (!source || !source.filePath || !fs.existsSync(source.filePath)) {
    return {
      available: false,
      status: 'skipped',
      reason: 'Reference source file not available on local disk.',
    };
  }

  if (!encodedFilePath || !fs.existsSync(encodedFilePath)) {
    return {
      available: false,
      status: 'failed',
      reason: 'Encoded output file does not exist.',
    };
  }

  let ffprobePath = options.ffprobePath;
  if (ffprobePath && !fs.existsSync(ffprobePath)) {
    try {
      const { resolveTools } = require('./tools');
      ffprobePath = resolveTools({}, { ffprobe: ffprobePath }).ffprobe;
    } catch {}
  }

  if (!ffprobePath || !fs.existsSync(ffprobePath)) {
    return {
      available: false,
      status: 'failed',
      reason: 'Resolved FFprobe binary path was not provided or does not exist.',
    };
  }

  const fps = source.video?.fps || 30;
  const isVfr = Boolean(source.video?.isVfr);
  const expectedFrames = Math.round(sampleDuration * fps);

  // Validate actual presentation timestamps, exact requested source interval,
  // and visual content correspondence between source and encode
  const temporal = validateTemporalAlignment(ffprobePath, source.filePath, encodedFilePath, {
    startOffset,
    sampleDuration,
    fps,
    isVfr,
    ffmpegPath,
  });

  if (temporal.status === 'misaligned') {
    return {
      available: true,
      status: 'failed',
      reason: `Temporal alignment validation failed: ${temporal.reason}`,
      temporalAlignment: temporal,
      validation: { valid: false, errors: temporal.errors },
    };
  }

  const jsonLogPath = path.join(outputDir, 'quality-metrics.json');
  const chain = buildQualityFilterChain(source, targetQuality, capabilities, jsonLogPath, selectedMetrics);

  if (!chain.supported) {
    return {
      available: false,
      status: 'skipped',
      reason: chain.reason,
    };
  }

  // FFmpeg command to execute quality analysis
  // Input 0: reference source interval
  // Input 1: encoded output file
  const args = [
    '-v',
    'error',
    '-ss',
    String(startOffset),
    '-t',
    String(sampleDuration),
    '-i',
    source.filePath,
    '-t',
    String(sampleDuration),
    '-i',
    encodedFilePath,
    '-filter_complex',
    chain.filterGraph,
    '-map',
    '[out]',
    '-f',
    'null',
    '-',
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
      },
    });
  } catch (err) {
    return {
      available: true,
      status: 'failed',
      reason: `Quality analysis execution failed: ${err.message}`,
      stderr: stderrOutput.slice(-300),
    };
  }

  // Execute secondary standalone pass if libvmaf lacked requested SSIM or PSNR
  let secondaryPassError = null;
  if (chain.needsSecondaryStandalonePass && chain.secondaryFilterGraph) {
    const secArgs = [
      '-v',
      'error',
      '-ss',
      String(startOffset),
      '-t',
      String(sampleDuration),
      '-i',
      source.filePath,
      '-t',
      String(sampleDuration),
      '-i',
      encodedFilePath,
      '-filter_complex',
      chain.secondaryFilterGraph,
      '-map',
      '[out]',
      '-f',
      'null',
      '-',
    ];
    try {
      await spawnSafe(ffmpegPath, secArgs, {
        cwd: outputDir,
        timeout: timeoutMs,
        signal,
        onStderr: chunk => {
          stderrOutput += chunk.toString();
        },
      });
    } catch (secErr) {
      secondaryPassError = secErr.message;
      stderrOutput += '\nSecondary standalone pass error: ' + secErr.message;
    }
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
          validationErrors.push(
            `Temporal misalignment in metric log: first scored frame begins at ${frames[0].metrics.timestampSec.toFixed(3)}s (expected <= 0.08s).`,
          );
        }

        if (!isVfr && Math.abs(frames.length - expectedFrames) > 3) {
          validationErrors.push(
            `Incomplete metric sequence: expected ~${expectedFrames} frames, scored only ${frames.length} frames.`,
          );
        }
      }

      if (validationErrors.length > 0) {
        return {
          available: true,
          status: 'failed',
          reason: validationErrors.join('; '),
          validation: { valid: false, errors: validationErrors },
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
          timestampSec,
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

      // If secondary standalone pass was executed, parse ssim.log and/or psnr.log
      if (chain.needsSecondaryStandalonePass) {
        const ssimLogPath = path.join(outputDir, 'ssim.log');
        const psnrLogPath = path.join(outputDir, 'psnr.log');

        if (chain.secondaryMetrics?.includes('ssim')) {
          if (fs.existsSync(ssimLogPath) && ssimValues.length === 0) {
            try {
              const ssimRaw = fs.readFileSync(ssimLogPath, 'utf8');
              const lines = ssimRaw.split(/\r?\n/).filter(Boolean);
              for (let i = 0; i < lines.length; i++) {
                const match = /All:([0-9.]+)/.exec(lines[i]);
                if (match) {
                  const val = parseFloat(match[1]);
                  ssimValues.push(val);
                  if (timeline[i]) {
                    timeline[i].ssim = Math.round(val * 10000) / 10000;
                  }
                }
              }
            } catch {}
          }
          if (ssimValues.length === 0) {
            chain.unavailableMetrics.push({
              metric: 'ssim',
              status: 'failed',
              reason: secondaryPassError
                ? `Secondary standalone SSIM filter pass failed: ${secondaryPassError}`
                : 'Secondary standalone SSIM filter pass did not produce valid score records.',
            });
          }
        }

        if (chain.secondaryMetrics?.includes('psnr')) {
          if (fs.existsSync(psnrLogPath) && psnrValues.length === 0) {
            try {
              const psnrRaw = fs.readFileSync(psnrLogPath, 'utf8');
              const lines = psnrRaw.split(/\r?\n/).filter(Boolean);
              for (let i = 0; i < lines.length; i++) {
                const match = /psnr_avg:([0-9.]+|inf)/.exec(lines[i]);
                if (match) {
                  const val = match[1] === 'inf' ? 60 : parseFloat(match[1]);
                  psnrValues.push(val);
                  if (timeline[i]) {
                    timeline[i].psnr = Math.round(val * 100) / 100;
                  }
                }
              }
            } catch {}
          }
          if (psnrValues.length === 0) {
            chain.unavailableMetrics.push({
              metric: 'psnr',
              status: 'failed',
              reason: secondaryPassError
                ? `Secondary standalone PSNR filter pass failed: ${secondaryPassError}`
                : 'Secondary standalone PSNR filter pass did not produce valid score records.',
            });
          }
        }
      }

      const vmafStats = selectedMetrics.includes('vmaf') ? calculateMetricStats(vmafValues) : null;
      const ssimStats = selectedMetrics.includes('ssim')
        ? ssimValues.length > 0
          ? calculateMetricStats(ssimValues)
          : chain.secondaryMetrics?.includes('ssim')
            ? { status: 'failed', reason: secondaryPassError || 'Secondary standalone SSIM filter pass failed' }
            : null
        : null;
      const psnrStats = selectedMetrics.includes('psnr')
        ? psnrValues.length > 0
          ? calculateMetricStats(psnrValues)
          : chain.secondaryMetrics?.includes('psnr')
            ? { status: 'failed', reason: secondaryPassError || 'Secondary standalone PSNR filter pass failed' }
            : null
        : null;
      const cambiStats = selectedMetrics.includes('cambi') ? calculateMetricStats(cambiValues) : null;

      const metricForWorstInterval = selectedMetrics.includes('vmaf')
        ? 'vmaf'
        : selectedMetrics.includes('ssim')
          ? 'ssim'
          : selectedMetrics.includes('psnr')
            ? 'psnr'
            : selectedMetrics.includes('cambi')
              ? 'cambi'
              : null;

      const worstIntervals = metricForWorstInterval ? findWorstIntervals(timeline, metricForWorstInterval, fps, 2) : [];

      const coveragePercent = Math.round((frames.length / (expectedFrames || 1)) * 1000) / 10;
      const fullCoverageAchieved = frames.length > 0 && Math.abs(frames.length - expectedFrames) <= 3;
      let finalStatus = 'pass';
      let finalReason = null;

      if (temporal.status === 'unverified') {
        if (fullCoverageAchieved || coveragePercent >= 95) {
          finalStatus = 'pass';
          finalReason = null;
        } else {
          finalStatus = 'unverified';
          finalReason = `Temporal alignment unverified: ${temporal.reason}`;
        }
      }

      return {
        available: true,
        status: finalStatus,
        reason: finalReason,
        vmaf: vmafStats,
        ssim: ssimStats,
        psnr: psnrStats,
        cambi: cambiStats,
        unavailableMetrics: chain.unavailableMetrics || [],
        worstIntervals,
        timeline,
        totalFramesEvaluated: frames.length,
        normalization: {
          ...chain.normalization,
          expectedFrames,
          evaluatedFrames: frames.length,
          coveragePercent,
          isVfr,
        },
        temporalAlignment: temporal,
        validation: { valid: temporal.status !== 'misaligned', errors: temporal.errors || [] },
        rawLogRelative: path.basename(jsonLogPath),
      };
    } catch (parseErr) {
      return {
        available: true,
        status: 'failed',
        reason: `Failed to parse libvmaf output: ${parseErr.message}`,
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
      reason: 'No metric data was produced by standalone quality filters.',
    };
  }

  if (!isVfr && Math.abs(scoredCount - expectedFrames) > 3) {
    return {
      available: true,
      status: 'failed',
      reason: `Incomplete metric sequence: expected ~${expectedFrames} frames, scored only ${scoredCount} frames.`,
      validation: { valid: false, errors: [`Scored ${scoredCount} frames out of ${expectedFrames} expected`] },
    };
  }

  const standaloneCoveragePercent = Math.round((scoredCount / (expectedFrames || 1)) * 1000) / 10;
  const standaloneFullCoverageAchieved = scoredCount > 0 && Math.abs(scoredCount - expectedFrames) <= 3;
  let standaloneFinalStatus = 'pass';
  let standaloneFinalReason = null;

  if (temporal.status === 'unverified') {
    if (standaloneFullCoverageAchieved || standaloneCoveragePercent >= 95) {
      standaloneFinalStatus = 'pass';
      standaloneFinalReason = null;
    } else {
      standaloneFinalStatus = 'unverified';
      standaloneFinalReason = `Temporal alignment unverified: ${temporal.reason}`;
    }
  }

  return {
    available: true,
    status: standaloneFinalStatus,
    reason: standaloneFinalReason,
    vmaf: null,
    ssim: selectedMetrics.includes('ssim') ? calculateMetricStats(ssimValues) : null,
    psnr: selectedMetrics.includes('psnr') ? calculateMetricStats(psnrValues) : null,
    cambi: null,
    unavailableMetrics: chain.unavailableMetrics || [],
    worstIntervals: ssimValues.length ? findWorstIntervals(timeline, 'ssim', fps, 2) : [],
    timeline,
    totalFramesEvaluated: scoredCount,
    normalization: {
      ...chain.normalization,
      expectedFrames,
      evaluatedFrames: scoredCount,
      coveragePercent: standaloneCoveragePercent,
      isVfr,
    },
    temporalAlignment: temporal,
    validation: { valid: temporal.status !== 'misaligned', errors: temporal.errors || [] },
  };
}

module.exports = {
  detectQualityCapabilities,
  calculateMetricStats,
  findWorstIntervals,
  buildQualityFilterChain,
  validateTemporalAlignment,
  runQualityAnalysis,
  parseFinalDecodedFrames,
};
