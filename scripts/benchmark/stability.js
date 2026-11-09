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
    probedEncoders = []
  } = opts;

  const stabilityOutputDir = path.join(outputDir, `stability-${config.id}`);
  fs.mkdirSync(stabilityOutputDir, { recursive: true });

  const totalChunks = Math.max(2, Math.ceil(duration / chunkDuration));
  const chunkResults = [];
  let consecutiveFailures = 0;
  let earlyStopReason = null;

  if (telemetryCollector) {
    telemetryCollector.setPhase('encoding', { mode: 'stability', configId: config.id });
  }

  // Execute chunked transcoding over the stability duration
  const benchmarkResult = await runChunkedBenchmark(tools, source, config, {
    startOffset,
    sampleDuration: duration,
    outputDir: stabilityOutputDir,
    signal,
    hardwareDecode,
    cpuFallback,
    probedEncoders,
    onProgress: prog => {
      chunkResults.push({
        chunkIndex: prog.chunkIndex,
        totalChunks: prog.totalChunks,
        encodeTimeSeconds: prog.encodeDurationSec,
        speedRatio: prog.realTimeSpeed,
        fps: 0,
        missedDeadline: prog.deadlineMissed,
        fallbackOccurred: false
      });

      opts.onProgress?.({
        chunkIndex: prog.chunkIndex,
        totalChunks: prog.totalChunks,
        elapsedSec: (prog.chunkIndex + 1) * chunkDuration,
        chunkLatencySec: prog.encodeDurationSec,
        realTimeSpeed: prog.realTimeSpeed
      });

      // Safety check: disk usage
      const currentDiskBytes = getDirectorySize(stabilityOutputDir);
      if (currentDiskBytes > maxDiskBytes) {
        earlyStopReason = `Maximum allowed disk consumption exceeded (${(currentDiskBytes / (1024 * 1024)).toFixed(1)} MB > ${(maxDiskBytes / (1024 * 1024)).toFixed(1)} MB)`;
        throw new Error(earlyStopReason);
      }

      if (prog.encodeDurationSec > chunkDuration * 1.5) {
        consecutiveFailures++;
        if (consecutiveFailures >= maxConsecutiveFailures) {
          earlyStopReason = `Aborted after ${consecutiveFailures} consecutive severe chunk performance failures or fallbacks.`;
          throw new Error(earlyStopReason);
        }
      } else {
        consecutiveFailures = 0;
      }
    }
  });

  // Trend Analysis: compare first half vs second half
  const halfCount = Math.floor(chunkResults.length / 2);
  let firstHalfSpeed = null;
  let secondHalfSpeed = null;
  let throughputChangePercent = 0;
  let latencyChangePercent = 0;

  if (halfCount >= 1) {
    const firstHalf = chunkResults.slice(0, halfCount);
    const secondHalf = chunkResults.slice(halfCount);

    const avg = arr => arr.reduce((acc, c) => acc + c.speedRatio, 0) / arr.length;
    const avgLatency = arr => arr.reduce((acc, c) => acc + c.encodeTimeSeconds, 0) / arr.length;

    firstHalfSpeed = Math.round(avg(firstHalf) * 100) / 100;
    secondHalfSpeed = Math.round(avg(secondHalf) * 100) / 100;

    const firstHalfLat = avgLatency(firstHalf);
    const secondHalfLat = avgLatency(secondHalf);

    if (firstHalfSpeed > 0) {
      throughputChangePercent = Math.round(((secondHalfSpeed - firstHalfSpeed) / firstHalfSpeed) * 1000) / 10;
    }
    if (firstHalfLat > 0) {
      latencyChangePercent = Math.round(((secondHalfLat - firstHalfLat) / firstHalfLat) * 1000) / 10;
    }
  }

  // Telemetry correlation
  const telemetrySummary = telemetryCollector ? telemetryCollector.getSummary() : null;
  const thermalClimb = telemetrySummary?.encoding?.thermalClimbC || 0;
  const throttlingConfirmed = telemetrySummary?.encoding?.throttlingDetected || false;
  const activeThrottles = telemetrySummary?.encoding?.activeThrottleReasons || [];

  let degradationSummary = 'Steady performance maintained across the stability test.';
  if (throughputChangePercent <= -10) {
    if (throttlingConfirmed) {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% under active hardware throttling (${activeThrottles.join(', ')}). Temperature rose by ${thermalClimb}°C.`;
    } else if (thermalClimb >= 5) {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% while temperature increased by ${thermalClimb}°C. No hardware throttle flag was asserted.`;
    } else {
      degradationSummary = `Performance declined by ${Math.abs(throughputChangePercent)}% over the course of the test.`;
    }
  }

  return {
    ...benchmarkResult,
    stability: {
      testedDurationSeconds: duration,
      totalChunksRequested: totalChunks,
      chunksCompleted: chunkResults.length,
      earlyStopReason,
      firstChunkLatencySeconds: chunkResults[0]?.encodeTimeSeconds || null,
      firstHalfSpeedRatio: firstHalfSpeed,
      secondHalfSpeedRatio: secondHalfSpeed,
      throughputChangePercent,
      latencyChangePercent,
      thermalClimbC: thermalClimb,
      throttlingConfirmed,
      activeThrottles,
      degradationSummary,
      chunkTimeline: chunkResults,
      notice: 'Stability benchmark measures short-to-medium duration thermal and throughput trends. Full 24/7 production capacity requires extended continuous soak testing under diverse multi-user concurrency.'
    }
  };
}

module.exports = {
  getDirectorySize,
  runStabilityBenchmark
};
