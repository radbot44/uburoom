'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeText } = require('./reporter');

const HISTORY_SCHEMA_VERSION = '3.0.0';

/**
 * Computes a fast deterministic canonical content fingerprint (v1:<sha256>)
 * by sampling head, mid, and tail chunks plus file byte size.
 * Contains NO local paths or personal filenames.
 */
function computeFileContentFingerprint(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    const size = stat.size;
    if (size === 0) return 'v1:00000000000000000000000000000000';

    const fd = fs.openSync(filePath, 'r');
    try {
      const chunkSize = 64 * 1024; // 64 KB
      const headBuf = Buffer.alloc(Math.min(chunkSize, size));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);

      const midOffset = Math.max(0, Math.floor((size - chunkSize) / 2));
      const midLen = Math.min(chunkSize, Math.max(0, size - midOffset));
      const midBuf = Buffer.alloc(midLen);
      fs.readSync(fd, midBuf, 0, midBuf.length, midOffset);

      const tailOffset = Math.max(0, size - chunkSize);
      const tailLen = Math.min(chunkSize, size - tailOffset);
      const tailBuf = Buffer.alloc(tailLen);
      fs.readSync(fd, tailBuf, 0, tailBuf.length, tailOffset);

      const hash = crypto.createHash('sha256');
      hash.update(headBuf);
      hash.update(midBuf);
      hash.update(tailBuf);
      hash.update(String(size));
      return `v1:${hash.digest('hex').slice(0, 32)}`;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Derives a stable, privacy-preserving fingerprint for the source media.
 * Prefers canonical content hashing (v1:<hash>). If file access is unavailable,
 * classifies source identity with appropriate confidence rating without fabricating matches.
 */
function deriveSourceFingerprint(source) {
  if (!source) return 'unknown';

  // 1. If raw file is accessible on disk, compute canonical content fingerprint
  if (source.filePath && typeof source.filePath === 'string') {
    const contentFp = computeFileContentFingerprint(source.filePath);
    if (contentFp) return contentFp;
  }

  // 2. Preserve existing valid fingerprint if present
  if (source.sourceFingerprint && typeof source.sourceFingerprint === 'string') {
    return source.sourceFingerprint;
  }

  // 3. Synthetic source media
  if (source.isSynthetic || source.synthetic) {
    const synthName = source.fileName || 'synthetic';
    return `synthetic:${synthName}`;
  }

  // 4. Fallback for unverified sources lacking disk file access (e.g., imported historical runs)
  const baseName = path.basename(source.fileName || source.filePath || 'source');
  const res = `${source.video?.width || 0}x${source.video?.height || 0}`;
  const fps = source.video?.fps || 0;
  const codec = source.video?.codec || 'unknown';
  const size = source.fileSizeBytes || source.sizeBytes || 0;
  const hash = crypto.createHash('sha256').update(`${baseName}:${res}:${fps}:${codec}:${size}`).digest('hex').slice(0, 16);
  return `unverified:${hash}`;
}

/**
 * Initializes or resolves the history repository directory.
 */
function resolveHistoryDir(customDir = null, repoRoot = null) {
  if (customDir) {
    const dir = path.resolve(process.cwd(), customDir);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const dir = path.join(root, 'artifacts', 'transcode-benchmark', 'history');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Loads the local history index (`history-index.json`).
 */
function loadHistoryIndex(historyDir) {
  const indexPath = path.join(historyDir, 'history-index.json');
  if (!fs.existsSync(indexPath)) {
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      runs: []
    };
  }

  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const data = JSON.parse(raw);
    data.runs = Array.isArray(data.runs) ? data.runs : [];
    return data;
  } catch {
    return {
      schemaVersion: HISTORY_SCHEMA_VERSION,
      updatedAt: new Date().toISOString(),
      runs: []
    };
  }
}

/**
 * Concurrency-safe index writing using atomic write-and-rename.
 */
function saveHistoryIndex(historyDir, indexData) {
  const indexPath = path.join(historyDir, 'history-index.json');
  const tempPath = path.join(historyDir, `history-index.tmp.${process.pid}.${Date.now()}`);
  indexData.updatedAt = new Date().toISOString();
  fs.writeFileSync(tempPath, JSON.stringify(indexData, null, 2), 'utf8');
  fs.renameSync(tempPath, indexPath);
}

/**
 * Saves a benchmark execution payload into local history.
 * Strips large outputs, preserves measurements, environment fingerprints, and telemetry summaries.
 */
function saveRunToHistory(benchmarkPayload, historyDir) {
  const index = loadHistoryIndex(historyDir);

  const timestamp = benchmarkPayload.timestamp || new Date().toISOString();
  const runId = `run-${timestamp.replace(/[:.]/g, '-')}-${process.pid || Math.floor(Math.random() * 10000)}`;

  const sanitizedEnvironment = {
    gpu: benchmarkPayload.environment?.gpu || 'Unknown GPU',
    cpu: benchmarkPayload.environment?.cpu || 'Unknown CPU',
    ffmpeg: benchmarkPayload.environment?.ffmpeg ? sanitizeText(benchmarkPayload.environment.ffmpeg.split('\n')[0]) : 'Unknown FFmpeg',
    os: `${benchmarkPayload.environment?.platform || process.platform} (${benchmarkPayload.environment?.arch || process.arch})`,
    configProfile: benchmarkPayload.configProfile || 'default'
  };

  const sourceFingerprint = benchmarkPayload.sourceFingerprint || deriveSourceFingerprint(benchmarkPayload.source);

  const compactResults = (benchmarkPayload.results || []).map(r => ({
    configId: r.configId,
    codec: r.codec,
    requestedEncoder: r.requestedEncoder,
    actualEncoder: r.actualEncoder,
    qualityId: r.quality?.id || 'unknown',
    qualityLabel: r.quality?.label || r.quality?.id || 'unknown',
    resolution: r.quality ? `${r.quality.width}x${r.quality.height}` : 'unknown',
    targetBitrateMbps: r.quality?.bitrate || null,
    mode: r.mode,
    status: r.status,
    concurrency: r.concurrency || 1,
    workerId: r.workerId || 1,
    runIndex: r.runIndex || 1,
    hardwareDecode: r.hardwareDecode !== undefined ? r.hardwareDecode : true,
    speedRatio: r.performance?.speedMultiplier ?? r.measurements?.speedRatio ?? null,
    fps: r.performance?.effectiveFps ?? r.measurements?.fps ?? null,
    totalElapsedSeconds: r.performance?.totalEncodingTimeSec ?? r.measurements?.totalElapsedSeconds ?? null,
    firstChunkLatencySeconds: r.performance?.firstChunkDurationSec ?? r.measurements?.firstChunkLatencySeconds ?? null,
    p95ChunkLatencySeconds: r.performance?.p95ChunkSec ?? r.measurements?.p95ChunkLatencySeconds ?? null,
    deadlinesMissed: r.performance?.deadlineMisses ?? r.measurements?.deadlinesMissed ?? 0,
    qualityMetrics: r.qualityMetrics ? {
      status: r.qualityMetrics.status,
      vmaf: r.qualityMetrics.vmaf?.mean || null,
      ssim: r.qualityMetrics.ssim?.mean || null,
      psnr: r.qualityMetrics.psnr?.mean || null,
      cambi: r.qualityMetrics.cambi?.mean || null
    } : null,
    telemetry: r.telemetry ? {
      avgGpuUtilization: r.telemetry.encoding?.metrics?.gpuUtilization?.mean ?? null,
      avgEncoderUtilization: r.telemetry.encoding?.metrics?.encoderUtilization?.mean ?? null,
      avgTemperatureC: r.telemetry.encoding?.metrics?.temperatureC?.mean ?? null,
      avgPowerWatts: r.telemetry.encoding?.metrics?.powerWatts?.mean ?? null,
      thermalClimbC: r.telemetry.encoding?.thermalClimbC ?? 0,
      throttlingDetected: r.telemetry.encoding?.throttlingDetected ?? false,
      activeThrottleReasons: r.telemetry.encoding?.activeThrottleReasons || []
    } : null
  }));

  const record = {
    runId,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp,
    benchmarkVersion: benchmarkPayload.benchmarkVersion || 'Stage 3',
    sourceFingerprint,
    sourceFileName: benchmarkPayload.source?.fileName || 'unknown',
    sampleDuration: benchmarkPayload.sampleDuration || 60,
    startOffset: benchmarkPayload.startOffset || 0,
    environment: sanitizedEnvironment,
    concurrencySummary: benchmarkPayload.concurrencySummary || null,
    resultsCount: compactResults.length,
    passedCount: compactResults.filter(r => r.status === 'pass').length,
    failedCount: compactResults.filter(r => r.status === 'fail').length,
    results: compactResults
  };

  const recordFilePath = path.join(historyDir, `${runId}.json`);
  fs.writeFileSync(recordFilePath, JSON.stringify(record, null, 2), 'utf8');

  // Add summary entry to index
  index.runs.unshift({
    runId,
    timestamp,
    benchmarkVersion: record.benchmarkVersion,
    sourceFingerprint: record.sourceFingerprint,
    sourceFileName: record.sourceFileName,
    resultsCount: record.resultsCount,
    passedCount: record.passedCount,
    failedCount: record.failedCount,
    gpu: sanitizedEnvironment.gpu,
    recordFile: `${runId}.json`
  });

  saveHistoryIndex(historyDir, index);
  return record;
}

/**
 * Imports an existing Stage 1, Stage 2, or Stage 3 results.json into the local history system.
 */
function importHistoricalReport(resultsJsonPath, historyDir) {
  if (!fs.existsSync(resultsJsonPath)) {
    throw new Error(`Results file does not exist: ${resultsJsonPath}`);
  }
  const raw = fs.readFileSync(resultsJsonPath, 'utf8');
  const payload = JSON.parse(raw);
  return saveRunToHistory(payload, historyDir);
}

/**
 * Safely deletes a benchmark run record from history.
 * Validates run ID against path traversal; never touches or deletes media files.
 */
function deleteRunFromHistory(runId, historyDir) {
  if (!runId || typeof runId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(`Invalid runId format: "${runId}". Run IDs must contain only alphanumeric characters, underscores, and hyphens.`);
  }

  const resolvedDir = path.resolve(historyDir);
  const recordFile = path.resolve(historyDir, `${runId}.json`);

  // Ensure record file is strictly contained within history directory
  if (!recordFile.startsWith(resolvedDir + path.sep)) {
    throw new Error(`Path traversal attempt rejected for runId: ${runId}`);
  }

  const index = loadHistoryIndex(historyDir);
  index.runs = index.runs.filter(r => r.runId !== runId);
  saveHistoryIndex(historyDir, index);

  if (fs.existsSync(recordFile)) {
    fs.rmSync(recordFile, { force: true });
  }
}

/**
 * Compares two benchmark runs and produces a rigorous, honest regression analysis.
 * Classifies pairs as matched, cross_hardware_comparison, partially_matched, or not_comparable.
 * Never labels differences as regressions if run conditions or hardware differ.
 */
function compareRuns(baseRun, targetRun) {
  const baseFingerprint = baseRun.sourceFingerprint || deriveSourceFingerprint(baseRun.source);
  const targetFingerprint = targetRun.sourceFingerprint || deriveSourceFingerprint(targetRun.source);

  const baseGpu = baseRun.environment?.gpu;
  const targetGpu = targetRun.environment?.gpu;
  const isSameGpu = Boolean(baseGpu && targetGpu && baseGpu.trim().toLowerCase() === targetGpu.trim().toLowerCase());

  const comparison = {
    baseRunId: baseRun.runId || 'baseline',
    baseTimestamp: baseRun.timestamp || baseRun.generatedAt || null,
    targetRunId: targetRun.runId || 'current',
    targetTimestamp: targetRun.timestamp || targetRun.generatedAt || new Date().toISOString(),
    isCrossHardware: !isSameGpu,
    environmentDiff: {
      gpuMatch: isSameGpu,
      baseGpu: baseGpu || 'Unknown GPU',
      targetGpu: targetGpu || 'Unknown GPU',
      cpuMatch: baseRun.environment?.cpu === targetRun.environment?.cpu,
      baseCpu: baseRun.environment?.cpu || 'Unknown CPU',
      targetCpu: targetRun.environment?.cpu || 'Unknown CPU',
      ffmpegMatch: baseRun.tools?.ffmpegVersion === targetRun.tools?.ffmpegVersion,
      baseFfmpeg: baseRun.tools?.ffmpegVersion || baseRun.environment?.ffmpeg,
      targetFfmpeg: targetRun.tools?.ffmpegVersion || targetRun.environment?.ffmpeg
    },
    matchedComparisons: [],
    crossHardwareComparisons: [],
    partiallyMatchedComparisons: [],
    incomparableItems: []
  };

  const isVerifiedFingerprint = baseFingerprint && baseFingerprint.startsWith('v1:') && targetFingerprint && targetFingerprint.startsWith('v1:');
  const isSameSource = Boolean(baseFingerprint && targetFingerprint && baseFingerprint === targetFingerprint);
  const isSameDuration = baseRun.sampleDuration === targetRun.sampleDuration && baseRun.startOffset === targetRun.startOffset;

  for (const targetRes of targetRun.results || []) {
    const targetQualityId = targetRes.qualityId || targetRes.quality?.id;
    const targetCodec = targetRes.codec;

    // Find candidate matching results in baseRun
    const candidateMatches = (baseRun.results || []).filter(b => {
      const bQualityId = b.qualityId || b.quality?.id;
      return b.codec === targetCodec && bQualityId === targetQualityId;
    });

    if (candidateMatches.length === 0) {
      comparison.incomparableItems.push({
        targetConfigId: targetRes.configId,
        reason: 'Configuration not tested in baseline run.'
      });
      continue;
    }

    const exactMatch = candidateMatches.find(b =>
      b.requestedEncoder === targetRes.requestedEncoder &&
      (b.mode === targetRes.mode || (b.mode === 'chunked' && targetRes.mode === 'chunks') || (b.mode === 'chunks' && targetRes.mode === 'chunked')) &&
      (b.concurrency || 1) === (targetRes.concurrency || 1) &&
      (b.hardwareDecode ?? true) === (targetRes.hardwareDecode ?? true)
    );

    const speedTarget = targetRes.speedRatio ?? targetRes.performance?.speedMultiplier ?? 0;
    const p95Target = targetRes.p95ChunkLatencySeconds ?? targetRes.performance?.p95ChunkSec ?? 0;
    const vmafTarget = targetRes.qualityMetrics?.vmaf?.mean ?? (typeof targetRes.qualityMetrics?.vmaf === 'number' ? targetRes.qualityMetrics.vmaf : null);
    const targetDeadlines = targetRes.deadlinesMissed ?? targetRes.performance?.deadlineMisses ?? 0;
    const qualityLabel = targetRes.qualityLabel || targetRes.quality?.label || targetRes.quality?.id || targetRes.configId;

    if (exactMatch && isSameSource && isSameDuration) {
      const speedBase = exactMatch.speedRatio ?? exactMatch.performance?.speedMultiplier ?? 0;
      const speedDeltaPercent = speedBase > 0 ? Math.round(((speedTarget - speedBase) / speedBase) * 1000) / 10 : 0;

      const p95Base = exactMatch.p95ChunkLatencySeconds ?? exactMatch.performance?.p95ChunkSec ?? 0;
      const p95DeltaPercent = p95Base > 0 ? Math.round(((p95Target - p95Base) / p95Base) * 1000) / 10 : 0;

      const vmafBase = exactMatch.qualityMetrics?.vmaf?.mean ?? (typeof exactMatch.qualityMetrics?.vmaf === 'number' ? exactMatch.qualityMetrics.vmaf : null);
      const vmafDelta = (vmafBase !== null && vmafTarget !== null) ? Math.round((vmafTarget - vmafBase) * 100) / 100 : null;

      // Handle Failed Trials
      const isBaseFailed = exactMatch.status && exactMatch.status !== 'pass';
      const isTargetFailed = targetRes.status && targetRes.status !== 'pass';
      if (isBaseFailed || isTargetFailed) {
        comparison.matchedComparisons.push({
          configId: targetRes.configId,
          codec: targetRes.codec,
          encoder: targetRes.actualEncoder || targetRes.requestedEncoder,
          qualityLabel,
          classification: 'failed_trial',
          speedBase,
          speedTarget,
          speedDeltaPercent: 0,
          notice: `One or both trials failed validation (base: ${exactMatch.status}, target: ${targetRes.status}). Not evaluated for regression.`
        });
        continue;
      }

      // Handle Cross-Hardware Comparison
      if (!isSameGpu) {
        const crossItem = {
          configId: targetRes.configId,
          codec: targetRes.codec,
          encoder: targetRes.actualEncoder || targetRes.requestedEncoder,
          qualityLabel,
          classification: 'cross_hardware_comparison',
          baseGpu: baseGpu || 'Unknown GPU',
          targetGpu: targetGpu || 'Unknown GPU',
          speedBase,
          speedTarget,
          speedDeltaPercent,
          p95LatencyBase: p95Base,
          p95LatencyTarget: p95Target,
          vmafBase,
          vmafTarget,
          vmafDelta,
          notice: `Cross-hardware comparison (${baseGpu} vs ${targetGpu}). Differences reflect distinct hardware capabilities, not a software performance regression.`
        };
        comparison.matchedComparisons.push(crossItem);
        comparison.crossHardwareComparisons.push(crossItem);
        continue;
      }

      // Same-Hardware Comparison: evaluate regression vs improvement
      let classification = 'stable';
      if (speedDeltaPercent <= -10) {
        classification = 'regression';
      } else if (speedDeltaPercent >= 10) {
        classification = 'improvement';
      }

      comparison.matchedComparisons.push({
        configId: targetRes.configId,
        codec: targetRes.codec,
        encoder: targetRes.actualEncoder || targetRes.requestedEncoder,
        qualityLabel,
        classification,
        speedBase,
        speedTarget,
        speedDeltaPercent,
        p95LatencyBase: p95Base,
        p95LatencyTarget: p95Target,
        p95DeltaPercent,
        vmafBase,
        vmafTarget,
        vmafDelta,
        deadlinesMissedBase: exactMatch.deadlinesMissed ?? exactMatch.performance?.deadlineMisses ?? 0,
        deadlinesMissedTarget: targetDeadlines
      });
    } else {
      // Partially matched comparison
      const partial = candidateMatches[0];
      const speedBase = partial.speedRatio ?? partial.performance?.speedMultiplier ?? 0;
      const reasons = [];
      if (!isSameSource) {
        reasons.push(isVerifiedFingerprint ? 'Different source media content' : 'Unverified source fingerprint match');
      }
      if (!isSameDuration) reasons.push('Different sample interval');
      if (partial.requestedEncoder !== targetRes.requestedEncoder) reasons.push(`Different encoder (${partial.requestedEncoder} vs ${targetRes.requestedEncoder})`);
      if (partial.mode !== targetRes.mode) reasons.push(`Different mode (${partial.mode} vs ${targetRes.mode})`);
      if ((partial.concurrency || 1) !== (targetRes.concurrency || 1)) reasons.push(`Different concurrency (${partial.concurrency || 1} vs ${targetRes.concurrency || 1})`);
      if ((partial.hardwareDecode ?? true) !== (targetRes.hardwareDecode ?? true)) reasons.push('Different hardware decode setting');

      comparison.partiallyMatchedComparisons.push({
        targetConfigId: targetRes.configId,
        baseConfigId: partial.configId,
        differingConditions: reasons,
        speedBase,
        speedTarget,
        notice: 'Not directly comparable as a performance regression because test conditions differ.'
      });
    }
  }

  return comparison;
}

module.exports = {
  HISTORY_SCHEMA_VERSION,
  computeFileContentFingerprint,
  deriveSourceFingerprint,
  resolveHistoryDir,
  loadHistoryIndex,
  saveHistoryIndex,
  saveRunToHistory,
  importHistoricalReport,
  deleteRunFromHistory,
  compareRuns
};
