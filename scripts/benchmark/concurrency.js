'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { runChunkedBenchmark, runContinuousBenchmark } = require('./runner');

/**
 * Runs a set of N independent transcoding jobs simultaneously.
 * Each worker has its own isolated output path and executes FFmpeg in parallel.
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
    mode = 'chunks'
  } = options;

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
      runIndex: 1,
      probedEncoders,
      signal
    };

    const workerPromise = (async () => {
      const workerStartHr = process.hrtime.bigint();
      try {
        let result;
        if (mode === 'continuous') {
          result = await runContinuousBenchmark(tools, source, testConfig, workerOptions);
        } else {
          result = await runChunkedBenchmark(tools, source, testConfig, workerOptions);
        }
        const workerElapsedSec = Number(process.hrtime.bigint() - workerStartHr) / 1e9;
        return {
          ...result,
          workerId: w,
          workerElapsedSec: Math.round(workerElapsedSec * 1000) / 1000
        };
      } catch (err) {
        const workerElapsedSec = Number(process.hrtime.bigint() - workerStartHr) / 1e9;
        return {
          workerId: w,
          concurrency,
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
            totalBytes: 0,
            actualBitrateKbps: 0,
            processingType: 'production-like'
          },
          validation: { valid: false, errors: [err.message] }
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
  const speeds = [];

  for (const wr of workerResults) {
    const perf = wr.performance || {};
    const speed = perf.speedMultiplier || 0;
    speeds.push(speed);
    totalDeadlineMisses += perf.deadlineMisses || 0;

    // A worker passes if it completed without fatal error and achieved at least 1.0x real-time speed
    if (wr.status === 'pass' && speed >= 1.0) {
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
  const aggregateThroughputMultiplier = wallClockTimeSec > 0
    ? totalCompletedMediaSec / wallClockTimeSec
    : 0;

  // Sustainable acceptance criteria:
  // 1. Zero crashed or errored workers
  // 2. Minimum worker speed >= 1.0x (every single stream sustains real-time)
  // 3. Deadline misses <= 0 (or <= 5% of all chunks across workers)
  let isSustainable = true;
  let failureReason = null;

  if (failedWorkers > 0) {
    isSustainable = false;
    const failed = workerResults.find(w => w.status !== 'pass');
    failureReason = failed?.error || `${failedWorkers} worker(s) failed or dropped below 1.0x real-time.`;
  } else if (minWorkerSpeed < 1.0) {
    isSustainable = false;
    failureReason = `Slowest worker ran at ${minWorkerSpeed.toFixed(2)}x (below 1.0x real-time requirement).`;
  } else if (totalDeadlineMisses > 0) {
    const totalChunks = concurrency * Math.ceil(sampleDuration / 6);
    const missRate = totalDeadlineMisses / (totalChunks || 1);
    if (missRate > 0.05) {
      isSustainable = false;
      failureReason = `${totalDeadlineMisses} chunk deadline(s) missed (${(missRate * 100).toFixed(1)}% miss rate).`;
    }
  }

  return {
    concurrency,
    wallClockTimeSec: Math.round(wallClockTimeSec * 1000) / 1000,
    aggregateCompletedMediaSec: totalCompletedMediaSec,
    aggregateThroughputMultiplier: Math.round(aggregateThroughputMultiplier * 100) / 100,
    meanWorkerSpeed: Math.round(meanWorkerSpeed * 100) / 100,
    minWorkerSpeed: Math.round(minWorkerSpeed * 100) / 100,
    maxWorkerSpeed: Math.round(maxWorkerSpeed * 100) / 100,
    workerSpeedStdDev: Math.round(workerSpeedStdDev * 100) / 100,
    totalDeadlineMisses,
    passedWorkers,
    failedWorkers,
    isSustainable,
    failureReason,
    workers: workerResults
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
    mode = 'chunks'
  } = options;

  const testedTiers = [];
  let highestSustainableConcurrency = 0;
  let firstFailingConcurrency = null;
  let overallStoppingReason = null;

  for (let c = 1; c <= maxConcurrency; c++) {
    if (signal?.aborted) {
      overallStoppingReason = 'Capacity scan cancelled by operator.';
      break;
    }

    if (onTierStart) onTierStart(c, maxConcurrency);

    const tierResult = await runConcurrentTier({
      concurrency: c,
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
      mode
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
    stoppingReason: overallStoppingReason || (highestSustainableConcurrency === maxConcurrency ? 'Reached maximum requested concurrency ceiling.' : null),
    testedTiers,
    estimateNotice: 'Short-run sustainable capacity estimate based on chunk deadline preservation. Long-term production capacity requires extended thermal and memory soak testing.'
  };
}

module.exports = {
  runConcurrentTier,
  runCapacityScan
};
