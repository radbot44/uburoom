'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runChunkedBenchmark } = require('./runner');

/**
 * Calculates disk usage in bytes for a directory recursively.
 */
function getDirectorySize(dirPath) {
  let totalBytes = 0;
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        totalBytes += getDirectorySize(fullPath);
      } else if (entry.isFile()) {
        totalBytes += fs.statSync(fullPath).size;
      }
    }
  } catch {}
  return totalBytes;
}

/**
 * Calculates P95 percentile of an array of numeric values.
 */
function calculateP95(arr) {
  if (!arr || !arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return Math.round(sorted[idx] * 1000) / 1000;
}

/**
 * Executes a bounded stability benchmark session measuring performance trends,
 * latency evolution, thermal climb, and resource saturation over extended chunks.
 */
async function runStabilityBenchmark(toolsOrOptions, sourceInfo, testConfig, options = {}) {
  let tools = toolsOrOptions;
  let source = sourceInfo;
  let config = testConfig;
  let opts = options;

  if (toolsOrOptions && !sourceInfo && toolsOrOptions.tools) {
    tools = toolsOrOptions.tools;
    source = toolsOrOptions.source || toolsOrOptions.sourceInfo;
    config = toolsOrOptions.testConfig;
    opts = toolsOrOptions;
  }

  const {
    duration = opts.targetDurationSec || opts.duration || 120,
    startOffset = 0,
    outputDir,
    telemetryCollector = null,
    signal = null,
    maxDiskBytes = 4 * 1024 * 1024 * 1024, // 4 GB safety ceiling
    maxConsecutiveFailures = 3,
    chunkDuration = 6,
    hardwareDecode = true,
    cpuFallback = true,
    probedEncoders = [],
    chunkedRunner = null,
  } = opts;

  // 1. Validate duration bounds (6s to 3600s)
  if (!Number.isFinite(duration) || duration < 6 || duration > 3600) {
    throw new Error(
      `Invalid stability test duration (${duration}): must be a positive number between 6 and 3600 seconds.`,
    );
  }

  // 2. Validate source media duration: fail fast if source is shorter than requested interval
  const sourceDuration = source?.durationSeconds ?? source?.duration ?? source?.format?.duration ?? null;
  if (sourceDuration !== null && typeof sourceDuration === 'number' && !isNaN(sourceDuration)) {
    if (sourceDuration < startOffset + duration) {
      throw new Error(
        `Source duration (${sourceDuration}s) is shorter than requested stability test interval (${startOffset + duration}s). Provide a longer source media file.`,
      );
    }
  }

  const stabilityOutputDir = path.join(outputDir, `stability-${config.id}`);
  fs.mkdirSync(stabilityOutputDir, { recursive: true });

  const totalChunks = Math.max(2, Math.ceil(duration / chunkDuration));
  const chunkResults = [];
  let consecutiveFailures = 0;
  let earlyStopReason = null;
  let fallbackCount = 0;
  const stabilityStartTime = process.hrtime.bigint();

  if (telemetryCollector) {
    telemetryCollector.setPhase('encoding', { mode: 'stability', configId: config.id });
  }

  const internalAbort = new AbortController();
  if (signal) {
    if (signal.aborted) {
      internalAbort.abort(signal.reason);
    } else {
      signal.addEventListener('abort', () => internalAbort.abort(signal.reason), { once: true });
    }
  }
  const linkedSignal = internalAbort.signal;

  let benchmarkResult = null;

  try {
    const runner = chunkedRunner || runChunkedBenchmark;
    benchmarkResult = await runner(tools, source, config, {
      startOffset,
      sampleDuration: duration,
      outputDir: stabilityOutputDir,
      signal: linkedSignal,
      hardwareDecode,
      cpuFallback,
      probedEncoders,
      onProgress: prog => {
        const isFallback = Boolean(prog.fallbackOccurred || prog.fallback);
        if (isFallback) fallbackCount++;

        chunkResults.push({
          chunkIndex: prog.chunkIndex,
          totalChunks: prog.totalChunks,
          encodeTimeSeconds: prog.encodeDurationSec,
          speedRatio: prog.realTimeSpeed,
          fps: 0,
          missedDeadline: prog.deadlineMissed,
          fallbackOccurred: isFallback,
        });

        opts.onProgress?.({
          chunkIndex: prog.chunkIndex,
          totalChunks: prog.totalChunks,
          elapsedSec: (prog.chunkIndex + 1) * chunkDuration,
          chunkLatencySec: prog.encodeDurationSec,
          realTimeSpeed: prog.realTimeSpeed,
          fallbackOccurred: isFallback,
        });

        // Safety check 1: disk consumption ceiling (4GB)
        const currentDiskBytes = getDirectorySize(stabilityOutputDir);
        if (currentDiskBytes > maxDiskBytes) {
          earlyStopReason = `Maximum allowed disk consumption exceeded (${(currentDiskBytes / (1024 * 1024)).toFixed(1)} MB > ${(maxDiskBytes / (1024 * 1024)).toFixed(1)} MB)`;
          internalAbort.abort(earlyStopReason);
          return;
        }

        // Safety check 2: consecutive severe chunk performance failures
        if (prog.encodeDurationSec > chunkDuration * 1.5) {
          consecutiveFailures++;
          if (consecutiveFailures >= maxConsecutiveFailures) {
            earlyStopReason = `Early stop triggered after ${consecutiveFailures} consecutive severe chunk performance failures or fallbacks.`;
            internalAbort.abort(earlyStopReason);
            return;
          }
        } else {
          consecutiveFailures = 0;
        }
      },
    });
  } catch (err) {
    // If early stop was triggered or cancelled by signal, preserve all completed measurements without failing the test run
    if (earlyStopReason || linkedSignal.aborted) {
      if (!earlyStopReason) {
        earlyStopReason =
          signal?.reason || internalAbort.signal.reason || 'Stability test cancelled by operator signal.';
      }
      benchmarkResult = {
        configId: config.id,
        mode: 'chunks',
        status: 'early_stopped',
        codec: config.codec,
        requestedEncoder: config.requestedEncoder,
        actualEncoder: config.requestedEncoder,
        quality: config.quality,
        performance: {
          speedMultiplier: chunkResults.length
            ? Math.round((chunkResults.reduce((acc, c) => acc + c.speedRatio, 0) / chunkResults.length) * 100) / 100
            : 0,
          effectiveFps: 0,
          totalEncodingTimeSec: chunkResults.reduce((acc, c) => acc + c.encodeTimeSeconds, 0),
          successfulEncodeTimeSec: chunkResults.reduce((acc, c) => acc + c.encodeTimeSeconds, 0),
          firstChunkDurationSec: chunkResults[0]?.encodeTimeSeconds || null,
          deadlineMisses: chunkResults.filter(c => c.missedDeadline).length,
        },
        fallbackEvents: [],
      };
    } else {
      throw err;
    }
  }

  // Trend Analysis: compare first half vs second half
  const halfCount = Math.floor(chunkResults.length / 2);
  let firstHalfSpeed = null;
  let secondHalfSpeed = null;
  let throughputChangePercent = 0;
  let p95LatencyFirstHalf = null;
  let p95LatencySecondHalf = null;
  let p95LatencyChangePercent = 0;

  if (halfCount >= 1) {
    const firstHalf = chunkResults.slice(0, halfCount);
    const secondHalf = chunkResults.slice(halfCount);

    const avg = arr => arr.reduce((acc, c) => acc + c.speedRatio, 0) / arr.length;

    firstHalfSpeed = Math.round(avg(firstHalf) * 100) / 100;
    secondHalfSpeed = Math.round(avg(secondHalf) * 100) / 100;

    p95LatencyFirstHalf = calculateP95(firstHalf.map(c => c.encodeTimeSeconds));
    p95LatencySecondHalf = calculateP95(secondHalf.map(c => c.encodeTimeSeconds));

    if (firstHalfSpeed > 0) {
      throughputChangePercent = Math.round(((secondHalfSpeed - firstHalfSpeed) / firstHalfSpeed) * 1000) / 10;
    }
    if (p95LatencyFirstHalf > 0) {
      p95LatencyChangePercent =
        Math.round(((p95LatencySecondHalf - p95LatencyFirstHalf) / p95LatencyFirstHalf) * 1000) / 10;
    }
  }

  // Telemetry correlation
  const telemetrySummary = telemetryCollector ? telemetryCollector.getSummary(config.id) : null;
  const thermalClimb =
    typeof telemetrySummary?.encoding?.thermalClimbC === 'number' ? telemetrySummary.encoding.thermalClimbC : null;
  const throttlingConfirmed = telemetrySummary?.encoding?.throttlingDetected || false;
  const activeThrottles = telemetrySummary?.encoding?.activeThrottleReasons || [];

  let degradationSummary = 'Steady performance maintained across the stability test.';
  if (earlyStopReason) {
    degradationSummary = `Stability test stopped early: ${earlyStopReason}`;
  } else if (throughputChangePercent <= -10) {
    if (throttlingConfirmed) {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% under active hardware throttling (${activeThrottles.join(', ')}).${thermalClimb !== null ? ` Temperature rose by ${thermalClimb}°C.` : ''}`;
    } else if (typeof thermalClimb === 'number' && thermalClimb >= 5) {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% while temperature increased by ${thermalClimb}°C. No hardware throttle flag was asserted.`;
    } else {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% over the course of the test.`;
    }
  }

  const actualElapsedDurationSec = Number(process.hrtime.bigint() - stabilityStartTime) / 1e9;
  const isEarlyStopped = Boolean(earlyStopReason || linkedSignal.aborted);
  const fallbacksObserved = fallbackCount > 0 || benchmarkResult?.fallbackEvents?.length > 0;

  return {
    ...benchmarkResult,
    stability: {
      status: isEarlyStopped ? 'early_stopped' : benchmarkResult.status,
      testedDurationSeconds: duration,
      actualElapsedDurationSec: Math.round(actualElapsedDurationSec * 100) / 100,
      totalChunksRequested: totalChunks,
      chunksCompleted: chunkResults.length,
      earlyStopReason,
      firstChunkLatencySeconds: chunkResults[0]?.encodeTimeSeconds || null,
      firstHalfSpeedRatio: firstHalfSpeed,
      secondHalfSpeedRatio: secondHalfSpeed,
      throughputChangePercent,
      p95LatencyFirstHalf,
      p95LatencySecondHalf,
      p95LatencyChangePercent,
      latencyChangePercent: p95LatencyChangePercent,
      fallbacksObserved,
      fallbackCount,
      thermalClimbC: thermalClimb,
      throttlingConfirmed,
      activeThrottles,
      degradationSummary,
      chunkTimeline: chunkResults,
      notice:
        'Stability benchmark measures short-to-medium duration thermal and throughput trends. Full 24/7 production capacity requires extended continuous soak testing under diverse multi-user concurrency.',
    },
  };
}

module.exports = {
  getDirectorySize,
  calculateP95,
  runStabilityBenchmark,
};
