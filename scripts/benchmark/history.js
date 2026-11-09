'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sanitizeText } = require('./reporter');

const HISTORY_SCHEMA_VERSION = '3.0.0';

/**
 * Derives a stable, privacy-preserving fingerprint for the source media.
 * Avoids storing personal paths while ensuring two test runs on the same media can be matched.
 */
function deriveSourceFingerprint(source) {
  if (!source) return 'unknown';
  const name = path.basename(source.filePath || source.fileName || 'source');
  const res = `${source.video?.width || 0}x${source.video?.height || 0}`;
  const fps = source.video?.fps || 0;
  const codec = source.video?.codec || 'unknown';
  const size = source.fileSizeBytes || 0;
  const hash = crypto.createHash('sha256').update(`${name}:${res}:${fps}:${codec}:${size}`).digest('hex').slice(0, 16);
  return `${name}#${hash}`;
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
 * Saves the local history index.
 */
function saveHistoryIndex(historyDir, indexData) {
  const indexPath = path.join(historyDir, 'history-index.json');
  indexData.updatedAt = new Date().toISOString();
  fs.writeFileSync(indexPath, JSON.stringify(indexData, null, 2), 'utf8');
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
      avgGpuUtilization: r.telemetry.encoding?.metrics?.gpuUtilization?.mean || null,
      avgEncoderUtilization: r.telemetry.encoding?.metrics?.encoderUtilization?.mean || null,
      avgTemperatureC: r.telemetry.encoding?.metrics?.temperatureC?.mean || null,
      avgPowerWatts: r.telemetry.encoding?.metrics?.powerWatts?.mean || null,
      thermalClimbC: r.telemetry.encoding?.thermalClimbC || 0,
      throttlingDetected: r.telemetry.encoding?.throttlingDetected || false
    } : null
  }));

  const record = {
    runId,
    schemaVersion: HISTORY_SCHEMA_VERSION,
    timestamp,
    benchmarkVersion: benchmarkPayload.benchmarkVersion || 'Stage 3',
    sourceFingerprint: deriveSourceFingerprint(benchmarkPayload.source),
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
 * Imports an existing Stage 1 or Stage 2 results.json into the local history system.
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
 * Never touches or deletes source media files.
 */
function deleteRunFromHistory(runId, historyDir) {
  const index = loadHistoryIndex(historyDir);
  index.runs = index.runs.filter(r => r.runId !== runId);
  saveHistoryIndex(historyDir, index);

  const recordFile = path.join(historyDir, `${runId}.json`);
  if (fs.existsSync(recordFile)) {
    fs.rmSync(recordFile, { force: true });
  }
}

/**
 * Compares two benchmark runs and produces a rigorous, honest regression analysis.
 * Classifies pairs as matched, partially_matched, or not_comparable.
 * Never labels differences as regressions if run conditions differ.
 */
function compareRuns(baseRun, targetRun) {
  const baseFingerprint = baseRun.sourceFingerprint || deriveSourceFingerprint(baseRun.source);
  const targetFingerprint = targetRun.sourceFingerprint || deriveSourceFingerprint(targetRun.source);

  const comparison = {
    baseRunId: baseRun.runId || 'baseline',
    baseTimestamp: baseRun.timestamp || baseRun.generatedAt || null,
    targetRunId: targetRun.runId || 'current',
    targetTimestamp: targetRun.timestamp || targetRun.generatedAt || new Date().toISOString(),
    environmentDiff: {
      gpuMatch: baseRun.environment?.gpu === targetRun.environment?.gpu,
      baseGpu: baseRun.environment?.gpu,
      targetGpu: targetRun.environment?.gpu,
      cpuMatch: baseRun.environment?.cpu?.model === targetRun.environment?.cpu?.model,
      baseCpu: baseRun.environment?.cpu?.model || baseRun.environment?.cpu,
      targetCpu: targetRun.environment?.cpu?.model || targetRun.environment?.cpu,
      ffmpegMatch: baseRun.tools?.ffmpegVersion === targetRun.tools?.ffmpegVersion,
      baseFfmpeg: baseRun.tools?.ffmpegVersion,
      targetFfmpeg: targetRun.tools?.ffmpegVersion
    },
    matchedComparisons: [],
    partiallyMatchedComparisons: [],
    incomparableItems: []
  };

  const isSameSource = Boolean(baseFingerprint && targetFingerprint && baseFingerprint === targetFingerprint);
  const isSameDuration = baseRun.sampleDuration === targetRun.sampleDuration && baseRun.startOffset === targetRun.startOffset;

  for (const targetRes of targetRun.results || []) {
    const targetQualityId = targetRes.qualityId || targetRes.quality?.id;
    const targetCodec = targetRes.codec;

    // Find candidate matching result in baseRun
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
      (b.concurrency || 1) === (targetRes.concurrency || 1)
    );

    const speedTarget = targetRes.speedRatio ?? targetRes.performance?.speedMultiplier ?? 0;
    const p95Target = targetRes.p95ChunkLatencySeconds ?? targetRes.performance?.p95ChunkSec ?? 0;
    const vmafTarget = targetRes.qualityMetrics?.vmaf?.mean ?? (typeof targetRes.qualityMetrics?.vmaf === 'number' ? targetRes.qualityMetrics.vmaf : null);
    const targetDeadlines = targetRes.deadlinesMissed ?? targetRes.performance?.deadlineMisses ?? 0;
    const qualityLabel = targetRes.qualityLabel || targetRes.quality?.label || targetRes.quality?.id || targetRes.configId;

    if (exactMatch && isSameSource && isSameDuration) {
      // Exactly matched comparison
      const speedBase = exactMatch.speedRatio ?? exactMatch.performance?.speedMultiplier ?? 0;
      const speedDeltaPercent = speedBase > 0 ? Math.round(((speedTarget - speedBase) / speedBase) * 1000) / 10 : 0;

      const p95Base = exactMatch.p95ChunkLatencySeconds ?? exactMatch.performance?.p95ChunkSec ?? 0;
      const p95DeltaPercent = p95Base > 0 ? Math.round(((p95Target - p95Base) / p95Base) * 1000) / 10 : 0;

      const vmafBase = exactMatch.qualityMetrics?.vmaf?.mean ?? (typeof exactMatch.qualityMetrics?.vmaf === 'number' ? exactMatch.qualityMetrics.vmaf : null);
      const vmafDelta = (vmafBase !== null && vmafTarget !== null) ? Math.round((vmafTarget - vmafBase) * 100) / 100 : null;

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
      if (!isSameSource) reasons.push('Different source media');
      if (!isSameDuration) reasons.push('Different sample interval');
      if (partial.requestedEncoder !== targetRes.requestedEncoder) reasons.push(`Different encoder (${partial.requestedEncoder} vs ${targetRes.requestedEncoder})`);
      if (partial.mode !== targetRes.mode) reasons.push(`Different mode (${partial.mode} vs ${targetRes.mode})`);
      if ((partial.concurrency || 1) !== (targetRes.concurrency || 1)) reasons.push(`Different concurrency (${partial.concurrency || 1} vs ${targetRes.concurrency || 1})`);

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
  deriveSourceFingerprint,
  resolveHistoryDir,
  loadHistoryIndex,
  saveHistoryIndex,
  saveRunToHistory,
  importHistoricalReport,
  deleteRunFromHistory,
  compareRuns
};
