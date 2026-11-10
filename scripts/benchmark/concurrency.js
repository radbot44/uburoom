'use strict';
const { runChunkedBenchmark, runContinuousBenchmark } = require('./runner');

/**
 * Runs a set of N independent transcoding jobs simultaneously.
 * Each worker has its own isolated output path and executes FFmpeg in parallel.
 *
 * Acceptance Criteria (Short-run sustainable capacity estimate):
 * 1. Every worker completes without transcode or validation error.
 * 2. Hardware encoder is preserved (no silent fallback to CPU software if hardware requested).
 * 3. Zero missed chunk deadlines (transcode time > 6.0s for any 6s chunk).
 * 4. Minimum worker throughput satisfies real-time margin (default >= 1.05x).
 * 5. P95 chunk latency remains below 85% of chunk duration (default <= 5.1s for 6s chunks).
 */
async function runConcurrentTier(options) {
  const {
    concurrency,
    tools,
    source,
    testConfig,
    sampleDuration = 60,
    startOffset = 0,
    hardwareDecode = true,
    cpuFallback = true,
    probedEncoders = [],
    outputDir,
    signal,
    mode = 'chunks',
    runIndex = 1,
    tierIndex = null,
    minRealtimeMargin = 1.05,
    maxChunkP95ThresholdSec = 5.1,
    requireHardwarePreserved = true,
    workerRunner = null, // For unit testing and injection
  } = options;

  if (signal?.aborted) {
    throw new Error('Concurrent tier cancelled before start.');
  }

  const tierStartTime = process.hrtime.bigint();
  const workerPromises = [];

  // Launch all N workers concurrently
  for (let w = 1; w <= concurrency; w++) {
    const workerOptions = {
      startOffset,
      sampleDuration,
      hardwareDecode,
      cpuFallback,
      outputDir,
      workerId: w,
      concurrency,
      tierIndex,
      runIndex,
      probedEncoders,
      signal,
    };

    const workerPromise = (async () => {
      const workerStartHr = process.hrtime.bigint();
      try {
        let result;
        if (workerRunner) {
          result = await workerRunner(tools, source, testConfig, workerOptions);
        } else if (mode === 'continuous') {
          result = await runContinuousBenchmark(tools, source, testConfig, workerOptions);
        } else {
          result = await runChunkedBenchmark(tools, source, testConfig, workerOptions);
        }
        const workerElapsedSec = Number(process.hrtime.bigint() - workerStartHr) / 1e9;
        return {
          ...result,
          workerId: w,
          concurrency,
          tierIndex,
          runIndex,
          workerElapsedSec: Math.round(workerElapsedSec * 1000) / 1000,
        };
      } catch (err) {
        const workerElapsedSec = Number(process.hrtime.bigint() - workerStartHr) / 1e9;
        return {
          workerId: w,
          concurrency,
          tierIndex,
          runIndex,
          configId: `${testConfig.codec}-${testConfig.requestedEncoder}-${testConfig.quality.id}-${mode}`,
          mode,
          status: 'fail',
          error: err.message,
          codec: testConfig.codec,
          requestedEncoder: testConfig.requestedEncoder,
          actualEncoder: testConfig.requestedEncoder,
          quality: testConfig.quality,
          workerElapsedSec: Math.round(workerElapsedSec * 1000) / 1000,
          performance: {
            sampleDuration,
            totalEncodingTimeSec: Math.round(workerElapsedSec * 1000) / 1000,
            successfulEncodeTimeSec: 0,
            speedMultiplier: 0,
            totalElapsedSpeedMultiplier: 0,
            effectiveFps: 0,
            firstChunkDurationSec: 0,
            firstChunkStartupSec: 0,
            deadlineMisses: 0,
            chunkP95DurationSec: 0,
            totalBytes: 0,
            actualBitrateKbps: 0,
            processingType: 'production-like',
          },
          validation: { valid: false, errors: [err.message] },
        };
      }
    })();

    workerPromises.push(workerPromise);
  }

  const workerResults = await Promise.all(workerPromises);
  const wallClockTimeSec = Number(process.hrtime.bigint() - tierStartTime) / 1e9;

  // Aggregate measurements across all workers in this tier
  let passedWorkers = 0;
  let failedWorkers = 0;
  let totalDeadlineMisses = 0;
  let fallbackDetected = false;
  let maxWorkerP95ChunkSec = 0;
  const speeds = [];

  for (const wr of workerResults) {
    const perf = wr.performance || {};
    const speed = perf.speedMultiplier || 0;
    speeds.push(speed);
    totalDeadlineMisses += perf.deadlineMisses || 0;

    const p95 = perf.chunkP95DurationSec || 0;
    if (p95 > maxWorkerP95ChunkSec) {
      maxWorkerP95ChunkSec = p95;
    }

    if (testConfig.requestedEncoder !== 'software' && (wr.actualEncoder === 'software' || wr.fallback)) {
      fallbackDetected = true;
    }

    if (wr.status === 'pass') {
      passedWorkers++;
    } else {
      failedWorkers++;
    }
  }

  const sortedSpeeds = [...speeds].sort((a, b) => a - b);
  const minWorkerSpeed = sortedSpeeds[0] || 0;
  const maxWorkerSpeed = sortedSpeeds[sortedSpeeds.length - 1] || 0;
  const meanWorkerSpeed = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;

  const variance = speeds.length
    ? speeds.reduce((acc, v) => acc + Math.pow(v - meanWorkerSpeed, 2), 0) / speeds.length
    : 0;
  const workerSpeedStdDev = Math.sqrt(variance);

  // Aggregate media-seconds completed per wall-clock second
  const totalCompletedMediaSec = passedWorkers * sampleDuration;
  const aggregateThroughputMultiplier = wallClockTimeSec > 0 ? totalCompletedMediaSec / wallClockTimeSec : 0;

  // Evaluate Sustainable Acceptance Criteria
  let isSustainable = true;
  let failureReason = null;

  if (failedWorkers > 0) {
    isSustainable = false;
    const failed = workerResults.find(w => w.status !== 'pass');
    failureReason = failed?.error || `${failedWorkers} worker(s) failed or dropped below 1.0x real-time.`;
  } else if (requireHardwarePreserved && fallbackDetected) {
    isSustainable = false;
    failureReason = `Hardware encoder ${testConfig.requestedEncoder} fell back to software encoding on one or more workers.`;
  } else if (totalDeadlineMisses > 0) {
    isSustainable = false;
    failureReason = `${totalDeadlineMisses} chunk deadline(s) missed (transcode time exceeded 6.0s chunk duration).`;
  } else if (minWorkerSpeed < minRealtimeMargin) {
    isSustainable = false;
    failureReason = `Slowest worker ran at ${minWorkerSpeed.toFixed(2)}x (below required ${minRealtimeMargin.toFixed(2)}x real-time margin).`;
  } else if (mode === 'chunks' && maxWorkerP95ChunkSec > maxChunkP95ThresholdSec) {
    isSustainable = false;
    failureReason = `Worker P95 chunk latency (${maxWorkerP95ChunkSec.toFixed(2)}s) exceeded ${maxChunkP95ThresholdSec.toFixed(2)}s threshold.`;
  }

  return {
    concurrency,
    tierIndex,
    runIndex,
    wallClockTimeSec: Math.round(wallClockTimeSec * 1000) / 1000,
    aggregateCompletedMediaSec: totalCompletedMediaSec,
    aggregateThroughputMultiplier: Math.round(aggregateThroughputMultiplier * 100) / 100,
    meanWorkerSpeed: Math.round(meanWorkerSpeed * 100) / 100,
    minWorkerSpeed: Math.round(minWorkerSpeed * 100) / 100,
    maxWorkerSpeed: Math.round(maxWorkerSpeed * 100) / 100,
    workerSpeedStdDev: Math.round(workerSpeedStdDev * 100) / 100,
    totalDeadlineMisses,
    maxWorkerP95ChunkSec: Math.round(maxWorkerP95ChunkSec * 1000) / 1000,
    passedWorkers,
    failedWorkers,
    fallbackDetected,
    isSustainable,
    failureReason,
    workers: workerResults,
  };
}

/**
 * Progressively tests increasing concurrency levels up to maxConcurrency.
 * Uses a conservative stopping rule: as soon as a concurrency tier fails
 * the sustainability criteria, testing stops immediately to prevent runaway load.
 */
async function runCapacityScan(options) {
  const {
    maxConcurrency = 6,
    tools,
    source,
    testConfig,
    sampleDuration = 60,
    startOffset = 0,
    hardwareDecode = true,
    cpuFallback = true,
    probedEncoders = [],
    outputDir,
    onTierStart,
    onTierComplete,
    signal,
    mode = 'chunks',
    runIndex = 1,
    minRealtimeMargin = 1.05,
    maxChunkP95ThresholdSec = 5.1,
    requireHardwarePreserved = true,
    workerRunner = null,
  } = options;

  // Hard clamp on maxConcurrency to prevent unbounded subprocess explosion
  const boundedMaxConcurrency = Math.min(16, Math.max(1, maxConcurrency));

  const testedTiers = [];
  let highestSustainableConcurrency = 0;
  let firstFailingConcurrency = null;
  let overallStoppingReason = null;

  for (let c = 1; c <= boundedMaxConcurrency; c++) {
    if (signal?.aborted) {
      overallStoppingReason = 'Capacity scan cancelled by operator.';
      break;
    }

    if (onTierStart) onTierStart(c, boundedMaxConcurrency);

    const tierResult = await runConcurrentTier({
      concurrency: c,
      tierIndex: c,
      runIndex,
      tools,
      source,
      testConfig,
      sampleDuration,
      startOffset,
      hardwareDecode,
      cpuFallback,
      probedEncoders,
      outputDir,
      signal,
      mode,
      minRealtimeMargin,
      maxChunkP95ThresholdSec,
      requireHardwarePreserved,
      workerRunner,
    });

    testedTiers.push(tierResult);
    if (onTierComplete) onTierComplete(tierResult);

    if (tierResult.isSustainable) {
      highestSustainableConcurrency = c;
    } else {
      firstFailingConcurrency = c;
      overallStoppingReason = tierResult.failureReason;
      // Conservative stopping rule: stop immediately when a tier fails
      break;
    }
  }

  return {
    isCapacityScan: true,
    highestSustainableConcurrency,
    firstFailingConcurrency,
    maxTestedConcurrency: testedTiers[testedTiers.length - 1]?.concurrency || 0,
    stoppingReason:
      overallStoppingReason ||
      (highestSustainableConcurrency === boundedMaxConcurrency
        ? 'Reached maximum requested concurrency ceiling.'
        : null),
    criteria: {
      zeroMissedDeadlines: true,
      minRealtimeMargin,
      maxChunkP95ThresholdSec,
      hardwarePreserved: requireHardwarePreserved,
    },
    testedTiers,
    estimateNotice:
      'Short-run capacity estimate based on chunk deadline preservation and P95 latency headroom. Long-term production capacity requires extended thermal and memory soak testing.',
  };
}

module.exports = {
  runConcurrentTier,
  runCapacityScan,
};
