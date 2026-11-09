'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = '3.0.0';

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Sanitizes arbitrary text (such as FFmpeg error logs or stack traces)
 * to prevent leaking personal paths, username directories, private URLs, or tokens.
 */
function sanitizeText(text) {
  if (!text || typeof text !== 'string') return '';
  let s = text.replace(/\\/g, '/');

  // Strip user home directories:
  // e.g. C:/Users/<username> -> [home]
  // e.g. /home/<username> or /Users/<username> -> [home]
  s = s.replace(/(?:[a-zA-Z]:)?\/(?:Users|home)\/[^/\s"':]+/gi, '[home]');

  // Strip sensitive local paths, keeping benchmark artifact references
  s = s.replace(/[a-zA-Z]:\/[^/\s"':]+\/[^/\s"':]+/g, (m) => {
    if (m.includes('artifacts/') || m.includes('outputs/') || m.includes('screenshots/')) {
      const idx = m.indexOf('artifacts/');
      if (idx >= 0) return m.slice(idx);
      const outIdx = m.indexOf('outputs/');
      if (outIdx >= 0) return m.slice(outIdx);
    }
    return '[local]';
  });

  // Strip URLs with tokens, IPs, or credentials
  s = s.replace(/https?:\/\/[^\s"']+/gi, '[url]');
  s = s.replace(/((?:token|key|secret|password|auth))=[^&\s"']+/gi, '$1=[REDACTED]');

  return s;
}

/**
 * Sanitizes data for export to ensure no personal absolute paths or credentials appear.
 */
function sanitizeForExport(benchmarkData) {
  const sanitized = JSON.parse(JSON.stringify(benchmarkData));
  if (sanitized.tools) {
    if (sanitized.tools.ffmpeg) sanitized.tools.ffmpeg = path.basename(sanitized.tools.ffmpeg);
    if (sanitized.tools.ffprobe) sanitized.tools.ffprobe = path.basename(sanitized.tools.ffprobe);
  }
  if (sanitized.source) {
    delete sanitized.source.filePath;
    delete sanitized.source.rawInfo;
    if (sanitized.source.fileName) sanitized.source.fileName = path.basename(sanitized.source.fileName);
  }
  if (sanitized.environment?.gpu) {
    sanitized.environment.gpu = sanitizeText(sanitized.environment.gpu);
  }

  if (Array.isArray(sanitized.results)) {
    for (const r of sanitized.results) {
      if (r.error) r.error = sanitizeText(r.error);
      if (r.fallback?.reason) r.fallback.reason = sanitizeText(r.fallback.reason);
      if (Array.isArray(r.fallbackEvents)) {
        for (const fe of r.fallbackEvents) {
          if (fe.reason) fe.reason = sanitizeText(fe.reason);
        }
      }
      if (Array.isArray(r.validation?.errors)) {
        r.validation.errors = r.validation.errors.map(sanitizeText);
      }
      if (r.output?.assembledFile) {
        r.output.assembledFile = r.output.assembledFile.replace(/\\/g, '/');
      }
    }
  }

  if (Array.isArray(sanitized.screenshots)) {
    for (const s of sanitized.screenshots) {
      if (s.relativePath) s.relativePath = s.relativePath.replace(/\\/g, '/');
    }
  }

  return sanitized;
}

/**
 * Generates results.json
 */
function generateJsonReport(benchmarkData, outputPath) {
  const cleanData = sanitizeForExport(benchmarkData);
  const jsonContent = JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    ...cleanData
  }, null, 2);

  fs.writeFileSync(outputPath, jsonContent, 'utf8');
}

/**
 * Generates results.csv
 */
function generateCsvReport(benchmarkData, outputPath) {
  const cleanData = sanitizeForExport(benchmarkData);
  const headers = [
    'Run',
    'Tier',
    'Concurrency',
    'WorkerId',
    'ConfigID',
    'Mode',
    'ProcessingType',
    'Codec',
    'RequestedEncoder',
    'ActualEncoder',
    'QualityID',
    'Resolution',
    'TargetBitrateKbps',
    'ActualBitrateKbps',
    'Status',
    'SpeedMultiplier',
    'TotalElapsedSpeed',
    'EffectiveFPS',
    'SuccessfulTimeSec',
    'TotalElapsedSec',
    'FirstChunkSec',
    'FirstChunkStartupSec',
    'MeanChunkSec',
    'P95ChunkSec',
    'MaxChunkSec',
    'DeadlineMisses',
    'TotalBytes',
    'FrameCoveragePct',
    'AVStartDeltaSec',
    'AVEndDeltaSec',
    'VMAF_Mean',
    'VMAF_P1',
    'VMAF_Min',
    'SSIM',
    'PSNR_dB',
    'CAMBI',
    'Avg_GPU_Util',
    'Avg_Enc_Util',
    'Avg_Temp_C',
    'Avg_Power_W',
    'Thermal_Climb_C',
    'Throttling',
    'FallbackEvents',
    'Errors'
  ];

  const rows = (cleanData.results || []).map(r => {
    const perf = r.performance || {};
    const q = r.quality || {};
    const val = r.validation || {};
    const qm = r.qualityMetrics || {};
    const telem = r.telemetry?.encoding?.metrics || {};
    const fallbacks = (r.fallbackEvents || (r.fallback ? [r.fallback] : []))
      .map(f => `${f.type || 'step'}:${f.from}->${f.to} (${(f.reason || '').replace(/[\r\n]+/g, ' ').trim()})`)
      .join('; ');

    const err = r.error || (val.errors?.length ? val.errors.join('; ') : '');

    const frameCov = val.videoPacketCount && val.expectedFrames
      ? Math.round((val.videoPacketCount / val.expectedFrames) * 100)
      : '';

    const avStart = val.videoStartPts !== undefined && val.audioStartPts !== undefined
      ? Math.round(Math.abs(val.videoStartPts - val.audioStartPts) * 1000) / 1000
      : '';

    const avEnd = val.videoEndPts !== undefined && val.audioEndPts !== undefined
      ? Math.round(Math.abs(val.videoEndPts - val.audioEndPts) * 1000) / 1000
      : '';

    return [
      r.runIndex || 1,
      r.tierIndex || '',
      r.concurrency || 1,
      r.workerId || 1,
      r.configId,
      r.mode,
      perf.processingType || 'production-like',
      r.codec,
      r.requestedEncoder,
      r.actualEncoder,
      q.id || '',
      `${q.width || ''}x${q.height || ''}`,
      q.targetBitrateKbps || '',
      perf.actualBitrateKbps || '',
      r.status,
      perf.speedMultiplier || '',
      perf.totalElapsedSpeedMultiplier || '',
      perf.effectiveFps || '',
      perf.successfulEncodeTimeSec !== undefined ? perf.successfulEncodeTimeSec : (perf.totalEncodingTimeSec || ''),
      perf.totalEncodingTimeSec || '',
      perf.firstChunkDurationSec !== null && perf.firstChunkDurationSec !== undefined ? perf.firstChunkDurationSec : '',
      perf.firstChunkStartupSec !== null && perf.firstChunkStartupSec !== undefined ? perf.firstChunkStartupSec : '',
      perf.meanChunkSec !== null && perf.meanChunkSec !== undefined ? perf.meanChunkSec : '',
      perf.p95ChunkSec !== null && perf.p95ChunkSec !== undefined ? perf.p95ChunkSec : '',
      perf.maxChunkSec !== null && perf.maxChunkSec !== undefined ? perf.maxChunkSec : '',
      perf.deadlineMisses || 0,
      perf.totalBytes || 0,
      frameCov,
      avStart,
      avEnd,
      qm.vmaf?.mean || '',
      qm.vmaf?.p1 || '',
      qm.vmaf?.min || '',
      qm.ssim?.mean || '',
      qm.psnr?.mean || '',
      qm.cambi?.mean || '',
      telem.gpuUtilization?.mean !== undefined && telem.gpuUtilization?.mean !== null ? telem.gpuUtilization.mean : (cleanData.telemetry?.unavailableFields?.includes('gpuUtilization') ? 'N/A' : ''),
      telem.encoderUtilization?.mean !== undefined && telem.encoderUtilization?.mean !== null ? telem.encoderUtilization.mean : (cleanData.telemetry?.unavailableFields?.includes('encoderUtilization') ? 'N/A' : ''),
      telem.temperatureC?.mean !== undefined && telem.temperatureC?.mean !== null ? telem.temperatureC.mean : (cleanData.telemetry?.unavailableFields?.includes('temperatureC') ? 'N/A' : ''),
      telem.powerWatts?.mean !== undefined && telem.powerWatts?.mean !== null ? telem.powerWatts.mean : (cleanData.telemetry?.unavailableFields?.includes('powerWatts') ? 'N/A' : ''),
      r.telemetry?.encoding?.thermalClimbC !== undefined && r.telemetry?.encoding?.thermalClimbC !== null ? r.telemetry.encoding.thermalClimbC : '',
      cleanData.telemetry?.throttlingSupported === false || r.telemetry?.encoding?.throttlingSupported === false
        ? 'N/A'
        : (r.telemetry?.encoding?.throttlingDetected ? (r.telemetry.encoding.activeThrottleReasons?.join(';') || 'Active') : 'None'),
      fallbacks ? `"${fallbacks.replace(/"/g, '""')}"` : 'None',
      err ? `"${err.replace(/"/g, '""')}"` : ''
    ].join(',');
  });

  const csvContent = [headers.join(','), ...rows].join('\n');
  fs.writeFileSync(outputPath, csvContent, 'utf8');
}

/**
 * Builds SVG Speed Multiplier Comparison Chart
 */
function buildSpeedChartSvg(results) {
  if (!results.length) return '';
  const barHeight = 26;
  const gap = 10;
  const labelWidth = 260;
  const chartWidth = 500;
  const width = labelWidth + chartWidth + 120;
  const height = results.length * (barHeight + gap) + 40;

  const maxSpeed = Math.max(2.5, ...results.map(r => r.performance?.speedMultiplier || 0));

  let barsSvg = '';
  results.forEach((r, idx) => {
    const y = 30 + idx * (barHeight + gap);
    const speed = r.performance?.speedMultiplier || 0;
    const barW = Math.max(4, Math.round((speed / maxSpeed) * chartWidth));
    const runTag = r.runIndex ? ` [R${r.runIndex}]` : '';
    const workerTag = r.workerId && r.concurrency && r.concurrency > 1 ? ` (W${r.workerId})` : '';
    const label = `${r.codec.toUpperCase()} ${r.actualEncoder} (${r.quality?.label || r.quality?.id}) [${r.mode}]${runTag}${workerTag}`;
    const color = speed >= 1.2 ? '#44C78A' : speed >= 1.0 ? '#E8B45C' : '#ff9ca1';

    barsSvg += `
      <text x="${labelWidth - 10}" y="${y + 18}" text-anchor="end" fill="#F8F7F4" font-size="12" font-family="Inter,sans-serif">${escapeHtml(label)}</text>
      <rect x="${labelWidth}" y="${y}" width="${barW}" height="${barHeight}" rx="4" fill="${color}" opacity="0.9"/>
      <text x="${labelWidth + barW + 8}" y="${y + 18}" fill="#F8F7F4" font-size="12" font-weight="600" font-family="Inter,sans-serif">${speed.toFixed(2)}x (${r.performance?.effectiveFps || 0} fps)</text>
    `;
  });

  // Vertical real-time 1.0x baseline
  const realTimeX = labelWidth + Math.round((1.0 / maxSpeed) * chartWidth);

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:${width}px;">
      <line x1="${realTimeX}" y1="20" x2="${realTimeX}" y2="${height - 10}" stroke="#FF9954" stroke-dasharray="4,4" stroke-width="2"/>
      <text x="${realTimeX}" y="15" text-anchor="middle" fill="#FF9954" font-size="11" font-weight="600" font-family="Inter,sans-serif">1.0x Real-time Threshold</text>
      ${barsSvg}
    </svg>
  `;
}

/**
 * Builds SVG Chunk Latency Chart for a chunked run
 */
function buildChunkLatencySvg(chunkResults, chunkDuration = 6) {
  if (!chunkResults || !chunkResults.length) return '';
  const svgWidth = 700;
  const svgHeight = 220;
  const paddingLeft = 50;
  const paddingRight = 20;
  const paddingTop = 30;
  const paddingBottom = 40;
  const plotWidth = svgWidth - paddingLeft - paddingRight;
  const plotHeight = svgHeight - paddingTop - paddingBottom;

  const maxVal = Math.max(chunkDuration * 1.5, ...chunkResults.map(c => c.encodeDurationSec));
  const numChunks = chunkResults.length;
  const barWidth = Math.max(6, Math.min(36, Math.floor((plotWidth / numChunks) * 0.75)));
  const step = plotWidth / numChunks;

  const deadlineY = paddingTop + plotHeight - Math.round((chunkDuration / maxVal) * plotHeight);

  let barsSvg = '';
  chunkResults.forEach((c, i) => {
    const x = paddingLeft + i * step + (step - barWidth) / 2;
    const h = Math.round((c.encodeDurationSec / maxVal) * plotHeight);
    const y = paddingTop + plotHeight - h;
    const color = c.deadlineMissed ? '#ff9ca1' : '#44C78A';

    barsSvg += `
      <rect x="${x}" y="${y}" width="${barWidth}" height="${h}" rx="3" fill="${color}">
        <title>Chunk ${i}: ${c.encodeDurationSec}s (${c.realTimeSpeed}x)</title>
      </rect>
      <text x="${x + barWidth / 2}" y="${paddingTop + plotHeight + 16}" text-anchor="middle" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">#${i}</text>
    `;
  });

  return `
    <svg viewBox="0 0 ${svgWidth} ${svgHeight}" width="100%" height="${svgHeight}" xmlns="http://www.w3.org/2000/svg" style="max-width:${svgWidth}px;">
      <line x1="${paddingLeft}" y1="${paddingTop + plotHeight}" x2="${svgWidth - paddingRight}" y2="${paddingTop + plotHeight}" stroke="#393F4D" stroke-width="1"/>
      <line x1="${paddingLeft}" y1="${deadlineY}" x2="${svgWidth - paddingRight}" y2="${deadlineY}" stroke="#FF7197" stroke-dasharray="4,4" stroke-width="2"/>
      <text x="${svgWidth - paddingRight}" y="${deadlineY - 6}" text-anchor="end" fill="#FF7197" font-size="11" font-weight="600" font-family="Inter,sans-serif">6.0s Deadline (Buffer Stall Threshold)</text>
      ${barsSvg}
    </svg>
  `;
}

/**
 * Builds Quality vs Bitrate / Performance Tradeoff Chart (Scatter plot)
 */
function buildQualityPerformanceSvg(results) {
  const scored = results.filter(r => r.qualityMetrics?.vmaf?.mean > 0);
  if (!scored.length) return '';

  const width = 740;
  const height = 300;
  const padL = 60;
  const padR = 40;
  const padT = 30;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxBitrate = Math.max(12000, ...scored.map(r => r.performance?.actualBitrateKbps || r.quality?.targetBitrateKbps || 8000));
  const minVmaf = Math.max(0, Math.floor(Math.min(...scored.map(r => r.qualityMetrics.vmaf.min || 70)) / 10) * 10);
  const maxVmaf = 100;

  const codecColors = {
    av1: '#FF9954',
    vp9: '#38BDF8',
    vp8: '#A78BFA'
  };

  let pointsSvg = '';
  scored.forEach(r => {
    const qm = r.qualityMetrics;
    const bitrate = r.performance?.actualBitrateKbps || r.quality?.targetBitrateKbps || 8000;
    const vmaf = qm.vmaf.mean;

    const x = padL + Math.round((bitrate / maxBitrate) * plotW);
    const y = padT + plotH - Math.round(((vmaf - minVmaf) / (maxVmaf - minVmaf)) * plotH);
    const color = codecColors[r.codec] || '#FF9954';
    const efficiency = (vmaf / (bitrate / 1000)).toFixed(1);

    pointsSvg += `
      <circle cx="${x}" cy="${y}" r="7" fill="${color}" stroke="#0E1117" stroke-width="2" opacity="0.95">
        <title>${r.codec.toUpperCase()} (${r.actualEncoder}) ${r.quality?.label || r.quality?.id}&#10;VMAF: ${vmaf.toFixed(1)} (p1: ${qm.vmaf.p1})&#10;Bitrate: ${bitrate} kbps&#10;Efficiency: ${efficiency} VMAF/Mbps&#10;Speed: ${r.performance?.speedMultiplier}x</title>
      </circle>
      <text x="${x + 10}" y="${y + 4}" fill="#F8F7F4" font-size="11" font-family="Inter,sans-serif">${r.codec.toUpperCase()} ${r.quality?.id || ''} (${vmaf.toFixed(1)})</text>
    `;
  });

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:${width}px;">
      <!-- Grid lines -->
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <!-- Axis Labels -->
      <text x="${width - padR}" y="${padT + plotH + 30}" text-anchor="end" fill="#AAB0BC" font-size="11" font-family="Inter,sans-serif">Bitrate (kbps) &rarr;</text>
      <text x="${padL}" y="${padT - 10}" text-anchor="start" fill="#AAB0BC" font-size="11" font-family="Inter,sans-serif">&uarr; VMAF Quality Score (0-100)</text>
      ${pointsSvg}
    </svg>
  `;
}

/**
 * Builds SVG Timeline Chart showing frame-level VMAF scores over sample duration
 */
function buildTimelineSvg(timeline, worstIntervals = []) {
  if (!timeline || timeline.length === 0) return '';
  const width = 740;
  const height = 180;
  const padL = 45;
  const padR = 20;
  const padT = 20;
  const padB = 30;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const valid = timeline.filter(f => typeof f.vmaf === 'number');
  if (valid.length === 0) return '';

  const maxTime = Math.max(1, valid[valid.length - 1].timestampSec);
  const minScore = Math.max(0, Math.floor(Math.min(...valid.map(f => f.vmaf)) / 10) * 10);
  const maxScore = 100;

  const points = valid.map(f => {
    const x = padL + (f.timestampSec / maxTime) * plotW;
    const y = padT + plotH - ((f.vmaf - minScore) / (maxScore - minScore)) * plotH;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');

  // Highlight worst intervals
  let intervalSvg = '';
  worstIntervals.forEach(wi => {
    const x1 = padL + (wi.startSec / maxTime) * plotW;
    const x2 = padL + (wi.endSec / maxTime) * plotW;
    intervalSvg += `
      <rect x="${x1}" y="${padT}" width="${Math.max(4, x2 - x1)}" height="${plotH}" fill="#FF7197" opacity="0.15">
        <title>Worst interval: ${wi.startSec}s - ${wi.endSec}s (Avg VMAF: ${wi.averageScore})</title>
      </rect>
    `;
  });

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:${width}px;">
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <text x="${padL - 6}" y="${padT + 10}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">${maxScore}</text>
      <text x="${padL - 6}" y="${padT + plotH}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">${minScore}</text>
      ${intervalSvg}
      <polyline points="${points}" fill="none" stroke="#FF9954" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="${width - padR}" y="${padT + plotH + 20}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">Time (${maxTime.toFixed(1)}s) &rarr;</text>
    </svg>
  `;
}

/**
 * Builds SVG Hardware Telemetry Timeline Chart
 */
function buildTelemetryTimelineSvg(telemetryTimeline) {
  if (!telemetryTimeline || !telemetryTimeline.length) return '';
  const width = 850;
  const height = 240;
  const padL = 50;
  const padR = 140;
  const padT = 30;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const validSamples = telemetryTimeline.filter(s => s.elapsedSec !== undefined);
  if (validSamples.length < 2) return '';

  const maxTime = Math.max(1, validSamples[validSamples.length - 1].elapsedSec || 1);
  const getX = t => padL + Math.round((t / maxTime) * plotW);

  const powerVals = validSamples.map(s => s.metrics?.powerWatts).filter(v => typeof v === 'number');
  const maxPower = Math.max(100, Math.ceil(Math.max(100, ...powerVals) / 50) * 50);

  const encPoints = [];
  const tempPoints = [];
  const powerPoints = [];

  for (const s of validSamples) {
    const x = getX(s.elapsedSec);
    if (typeof s.metrics?.encoderUtilization === 'number') {
      const y = padT + plotH - Math.round((Math.min(100, Math.max(0, s.metrics.encoderUtilization)) / 100) * plotH);
      encPoints.push(`${x},${y}`);
    }
    if (typeof s.metrics?.temperatureC === 'number') {
      const y = padT + plotH - Math.round((Math.min(100, Math.max(0, s.metrics.temperatureC)) / 100) * plotH);
      tempPoints.push(`${x},${y}`);
    }
    if (typeof s.metrics?.powerWatts === 'number') {
      const y = padT + plotH - Math.round((Math.min(maxPower, Math.max(0, s.metrics.powerWatts)) / maxPower) * plotH);
      powerPoints.push(`${x},${y}`);
    }
  }

  return `
    <svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" xmlns="http://www.w3.org/2000/svg" style="max-width:${width}px;">
      <!-- Grid & Axis -->
      <line x1="${padL}" y1="${padT + plotH}" x2="${width - padR}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#393F4D" stroke-width="1"/>
      <text x="${padL - 8}" y="${padT + 10}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">100% / 100°C</text>
      <text x="${padL - 8}" y="${padT + plotH / 2}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">50% / 50°C</text>
      <text x="${padL - 8}" y="${padT + plotH}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">0</text>

      <!-- Plot lines -->
      ${encPoints.length ? `<polyline points="${encPoints.join(' ')}" fill="none" stroke="#44C78A" stroke-width="2" stroke-linecap="round"/>` : ''}
      ${tempPoints.length ? `<polyline points="${tempPoints.join(' ')}" fill="none" stroke="#FF9954" stroke-width="2" stroke-linecap="round"/>` : ''}
      ${powerPoints.length ? `<polyline points="${powerPoints.join(' ')}" fill="none" stroke="#FF7197" stroke-width="1.5" stroke-dasharray="3,3" stroke-linecap="round"/>` : ''}

      <!-- Legend -->
      <g transform="translate(${width - padR + 15}, ${padT + 10})">
        <line x1="0" y1="0" x2="16" y2="0" stroke="#44C78A" stroke-width="2"/>
        <text x="22" y="4" fill="#F8F7F4" font-size="11" font-family="Inter,sans-serif">Encoder Util %</text>
        <line x1="0" y1="20" x2="16" y2="20" stroke="#FF9954" stroke-width="2"/>
        <text x="22" y="24" fill="#F8F7F4" font-size="11" font-family="Inter,sans-serif">Temp (°C)</text>
        <line x1="0" y1="40" x2="16" y2="40" stroke="#FF7197" stroke-width="1.5" stroke-dasharray="3,3"/>
        <text x="22" y="44" fill="#F8F7F4" font-size="11" font-family="Inter,sans-serif">Power (${maxPower}W max)</text>
      </g>

      <text x="${width - padR}" y="${padT + plotH + 20}" text-anchor="end" fill="#AAB0BC" font-size="10" font-family="Inter,sans-serif">Elapsed Time (${maxTime.toFixed(1)}s) &rarr;</text>
    </svg>
  `;
}

/**
 * Generates the complete, standalone offline HTML report.
 */
function generateHtmlReport(benchmarkData, outputPath) {
  const cleanData = sanitizeForExport(benchmarkData);
  const env = cleanData.environment || {};
  const src = cleanData.source || {};
  const results = cleanData.results || [];
  const probed = cleanData.probedEncoders || [];
  const concurrencySummary = cleanData.concurrencySummary;

  const passResults = results.filter(r => r.status === 'pass' && r.output?.assembledFile);
  const referenceVideoRel = src.referenceVideoRelative ? src.referenceVideoRelative.replace(/\\/g, '/') : null;
  const chunkedRuns = results.filter(r => r.mode === 'chunked' && r.status === 'pass' && r.output?.chunks?.length);
  const scoredRuns = results.filter(r => r.qualityMetrics?.vmaf?.mean > 0);

  // Statistics
  const passedCount = results.filter(r => r.status === 'pass').length;
  const failedCount = results.filter(r => r.status === 'fail').length;
  const skippedCount = results.filter(r => r.status === 'skipped').length;
  const totalCount = results.length;
  const hasMultipleRuns = (cleanData.options?.runs || 1) > 1;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="darkreader-lock" content="true">
  <title>uburoom Transcoding Benchmark Report</title>
  <style>
    :root {
      --bg: #0E1117;
      --card-bg: #181C24;
      --card-border: #242A38;
      --card-hover: #1E232E;
      --primary: #FF9954;
      --primary-hover: #FFAA6B;
      --secondary: #FF7197;
      --accent: #FF9954;
      --text: #F8F7F4;
      --muted: #AAB0BC;
      --success: #44C78A;
      --success-bg: rgba(68,199,138,0.12);
      --error: #FF7197;
      --error-bg: rgba(255,113,151,0.12);
      --warn: #E8B45C;
      --warn-bg: rgba(232,180,92,0.12);
      --font-family: 'Inter', system-ui, -apple-system, sans-serif;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font-family);
      line-height: 1.5;
      padding: 32px 24px;
      -webkit-font-smoothing: antialiased;
    }

    .container { max-width: 1200px; margin: 0 auto; display: flex; flex-direction: column; gap: 32px; }

    header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      flex-wrap: wrap;
      gap: 16px;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 24px;
    }

    h1 { font-size: 26px; font-weight: 600; color: var(--text); letter-spacing: -0.5px; }
    h2 { font-size: 18px; font-weight: 600; color: var(--text); margin-bottom: 16px; letter-spacing: -0.3px; }
    h3 { font-size: 15px; font-weight: 600; color: var(--text); }
    p { color: var(--muted); font-size: 14px; }

    .header-badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 4px 10px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 500;
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--muted);
    }
    .badge.highlight { color: var(--primary); border-color: rgba(255,153,84,0.3); background: rgba(255,153,84,0.08); }
    .badge.stat-pass { color: var(--success); border-color: rgba(68,199,138,0.3); background: var(--success-bg); font-weight: 600; }
    .badge.stat-fail { color: var(--error); border-color: rgba(255,113,151,0.3); background: var(--error-bg); font-weight: 600; }
    .badge.stat-skip { color: var(--warn); border-color: rgba(232,180,92,0.3); background: var(--warn-bg); font-weight: 600; }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 24px;
    }

    .grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .grid-4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }

    .stat-label { font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
    .stat-val { font-size: 18px; font-weight: 600; color: var(--text); }

    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .pill.success { background: var(--success-bg); color: var(--success); border: 1px solid rgba(68,199,138,0.3); }
    .pill.error { background: var(--error-bg); color: var(--error); border: 1px solid rgba(255,113,151,0.3); }
    .pill.warn { background: var(--warn-bg); color: var(--warn); border: 1px solid rgba(232,180,92,0.3); }

    table { width: 100%; border-collapse: collapse; font-size: 13px; text-align: left; }
    th {
      background: #14171F;
      color: var(--muted);
      font-weight: 600;
      padding: 12px 14px;
      border-bottom: 1px solid var(--card-border);
      cursor: pointer;
      user-select: none;
    }
    th:hover { color: var(--text); }
    td { padding: 12px 14px; border-bottom: 1px solid var(--card-border); color: var(--text); }
    tr:hover td { background: var(--card-hover); }

    .file-link { color: var(--primary); text-decoration: none; font-weight: 500; }
    .file-link:hover { text-decoration: underline; color: var(--primary-hover); }

    .filter-bar {
      display: flex;
      gap: 12px;
      margin-bottom: 16px;
      flex-wrap: wrap;
      align-items: center;
    }

    button.filter-btn, button.player-btn {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
    }
    button.filter-btn:hover, button.player-btn:hover {
      background: var(--card-hover);
      border-color: var(--primary);
    }
    button.filter-btn.active, button.player-btn.active {
      background: rgba(255,153,84,0.12);
      border-color: var(--primary);
      color: var(--primary);
      font-weight: 600;
    }
    button.player-btn.primary {
      background: var(--primary);
      color: #0E1117;
      border-color: var(--primary);
      font-weight: 600;
    }
    button.player-btn.primary:hover {
      background: var(--primary-hover);
    }

    .player-workspace {
      background: #12151D;
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .selector-bar {
      display: flex;
      gap: 12px;
      align-items: center;
      flex-wrap: wrap;
    }
    .custom-select {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      cursor: pointer;
    }
    .custom-select:focus { border-color: var(--primary); }

    .player-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 800px) {
      .player-grid { grid-template-columns: 1fr; }
    }

    .player-box {
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--card-border);
      position: relative;
    }
    .player-box video {
      width: 100%;
      height: auto;
      display: block;
      max-height: 440px;
      object-fit: contain;
    }
    .player-label {
      background: rgba(14,17,23,0.85);
      backdrop-filter: blur(4px);
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      border-bottom: 1px solid var(--card-border);
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    /* Wipe Container */
    .wipe-container {
      position: relative;
      width: 100%;
      max-height: 440px;
      overflow: hidden;
      background: #000;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }
    .wipe-container video {
      width: 100%;
      height: auto;
      display: block;
      max-height: 440px;
      object-fit: contain;
    }
    .wipe-overlay {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: 50%;
      overflow: hidden;
      border-right: 2px solid var(--primary);
    }
    .wipe-overlay video {
      width: 100%;
      max-height: 440px;
      object-fit: contain;
    }
    .wipe-slider {
      position: absolute;
      top: 0; left: 0; width: 100%; height: 100%;
      opacity: 0;
      cursor: ew-resize;
      z-index: 10;
    }

    .controls-bar {
      display: flex;
      gap: 12px;
      align-items: center;
      background: var(--card-bg);
      padding: 10px 16px;
      border-radius: 8px;
      border: 1px solid var(--card-border);
    }
    .seek-slider {
      flex: 1;
      accent-color: var(--primary);
      cursor: pointer;
    }
    .time-display { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted); min-width: 90px; }

    /* Zoom */
    .zoomed video {
      transform: scale(2);
      transform-origin: center center;
    }

    .blind-box {
      border: 1px solid var(--card-border);
      border-radius: 12px;
      padding: 20px;
      background: #141720;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .star-rating {
      display: inline-flex;
      gap: 6px;
      cursor: pointer;
    }
    .star {
      font-size: 20px;
      color: #393F4D;
      transition: color 0.1s;
    }
    .star.selected { color: var(--primary); }
  </style>
</head>
<body>
<div class="container">

  <!-- Header -->
  <header>
    <div>
      <h1>uburoom Transcoding Benchmark Report</h1>
      <p style="margin-top:4px;">Stage 3: Telemetry, Stability Trends, Historical Regressions &amp; Recommendations</p>
    </div>
    <div class="header-badges">
      <span class="badge stat-pass">${passedCount} Passed</span>
      ${failedCount > 0 ? `<span class="badge stat-fail">${failedCount} Failed</span>` : ''}
      ${skippedCount > 0 ? `<span class="badge stat-skip">${skippedCount} Skipped</span>` : ''}
      <span class="badge highlight">${escapeHtml(cleanData.configProfile)}</span>
      <span class="badge">Git: ${escapeHtml(env.gitRevision ? env.gitRevision.slice(0, 7) : 'Unknown')}</span>
      <span class="badge">${new Date(cleanData.generatedAt || Date.now()).toLocaleDateString()}</span>
    </div>
  </header>

  <!-- System & Transcoding Summary -->
  <section class="grid-2">
    <div class="card">
      <h2>Host Environment</h2>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">OS / Platform:</span><strong>${escapeHtml(env.platform)} (${escapeHtml(env.arch)})</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">CPU:</span><strong>${escapeHtml(env.cpu?.model)} (${env.cpu?.cores} cores)</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">GPU:</span><strong>${escapeHtml(env.gpu)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">RAM:</span><strong>${env.memoryFreeMB} MB free / ${env.memoryTotalMB} MB total</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">FFmpeg:</span><strong style="max-width:320px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escapeHtml(cleanData.tools?.ffmpegVersion)}">${escapeHtml(cleanData.tools?.ffmpegVersion?.split('\n')[0])}</strong></div>
      </div>
    </div>

    <div class="card">
      <h2>Source Media &amp; Pipeline</h2>
      <div style="display:flex;flex-direction:column;gap:10px;font-size:13px;">
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">Source File:</span><strong>${escapeHtml(src.fileName)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">Master Format:</span><strong>${escapeHtml(src.video?.resolution)} @ ${src.video?.fps} fps (${escapeHtml(src.video?.codec)}) [${escapeHtml(src.hdr?.label || 'SDR')}]</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">Tested Interval:</span><strong>${cleanData.sampleDuration}s window (starting at ${cleanData.startOffset}s)</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">Hardware Decode:</span><strong>${cleanData.transcodingSettings?.hardwareDecode ? 'Enabled' : 'Disabled'}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span style="color:var(--muted)">Processing Engine:</span><strong style="color:var(--primary);">Production-Like (Single-Container WebM with synchronized Opus audio)</strong></div>
      </div>
    </div>
  </section>

  <!-- Hardware Telemetry Section -->
  ${cleanData.telemetry ? `
  <section class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <h2>Hardware Telemetry &amp; Resource Utilization</h2>
      <span class="badge highlight">Provider: ${escapeHtml(cleanData.telemetry.provider)} (${escapeHtml(cleanData.telemetry.device)})</span>
    </div>
    <div class="grid-4" style="margin-bottom:16px;">
      <div>
        <div class="stat-label">Avg GPU Encoder Util</div>
        <div class="stat-val" style="color:var(--success);">${cleanData.telemetry.encoding?.metrics?.encoderUtilization?.mean !== undefined ? `${cleanData.telemetry.encoding.metrics.encoderUtilization.mean}%` : 'N/A'}</div>
      </div>
      <div>
        <div class="stat-label">Avg GPU Core Temp</div>
        <div class="stat-val" style="color:var(--primary);">${cleanData.telemetry.encoding?.metrics?.temperatureC?.mean !== undefined ? `${cleanData.telemetry.encoding.metrics.temperatureC.mean}°C` : 'N/A'}</div>
      </div>
      <div>
        <div class="stat-label">Thermal Climb (ΔT)</div>
        <div class="stat-val" style="color:${(cleanData.telemetry.encoding?.thermalClimbC || 0) > 8 ? 'var(--warn)' : 'var(--text)'};">
          ${cleanData.telemetry.encoding?.thermalClimbC !== undefined ? `+${cleanData.telemetry.encoding.thermalClimbC}°C` : '0°C'}
        </div>
      </div>
      <div>
        <div class="stat-label">Hardware Throttling</div>
        <div class="stat-val" style="font-size:14px;color:${cleanData.telemetry.encoding?.throttlingSupported === false ? 'var(--muted)' : (cleanData.telemetry.encoding?.throttlingDetected ? 'var(--error)' : 'var(--success)')};">
          ${cleanData.telemetry.encoding?.throttlingSupported === false ? 'N/A (Unsupported)' : (cleanData.telemetry.encoding?.throttlingDetected ? escapeHtml(cleanData.telemetry.encoding.activeThrottleReasons?.join(', ') || 'Active') : 'None')}
        </div>
      </div>
    </div>
    ${cleanData.telemetry.timeline?.length ? `
      <div style="margin-top:16px;">
        <div class="stat-label" style="margin-bottom:8px;">Real-Time Telemetry Timeline (Encoding Phase Isolated)</div>
        ${buildTelemetryTimelineSvg(cleanData.telemetry.timeline)}
      </div>
    ` : ''}
  </section>
  ` : ''}

  <!-- Stability & Soak Performance Section -->
  ${cleanData.stability ? `
  <section class="card" style="border-color: rgba(68,199,138,0.4); background: rgba(68,199,138,0.02);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <h2>Stability &amp; Soak Benchmark Trends</h2>
      <span class="badge highlight">Duration: ${cleanData.stability.testedDurationSeconds}s (${cleanData.stability.chunksCompleted} chunks)</span>
    </div>
    <div class="grid-4" style="margin-bottom:16px;">
      <div>
        <div class="stat-label">Throughput Evolution (1st vs 2nd Half)</div>
        <div class="stat-val" style="color:${cleanData.stability.throughputChangePercent < -10 ? 'var(--warn)' : 'var(--success)'};">
          ${cleanData.stability.throughputChangePercent > 0 ? `+${cleanData.stability.throughputChangePercent}%` : `${cleanData.stability.throughputChangePercent}%`}
        </div>
      </div>
      <div>
        <div class="stat-label">P95 Chunk Latency Evolution</div>
        <div class="stat-val">${cleanData.stability.latencyChangePercent > 0 ? `+${cleanData.stability.latencyChangePercent}%` : `${cleanData.stability.latencyChangePercent}%`}</div>
      </div>
      <div>
        <div class="stat-label">First-Chunk Startup Penalty</div>
        <div class="stat-val">${cleanData.stability.firstChunkLatencySeconds ? `${cleanData.stability.firstChunkLatencySeconds.toFixed(2)}s` : '-'}</div>
      </div>
      <div>
        <div class="stat-label">Observed Thermal Rise</div>
        <div class="stat-val">+${cleanData.stability.thermalClimbC}°C</div>
      </div>
    </div>
    <div style="padding:12px;background:#14171F;border-radius:6px;border:1px solid var(--card-border);font-size:13px;line-height:1.5;">
      <strong>Stability Assessment:</strong> ${escapeHtml(cleanData.stability.degradationSummary)}
      <div style="margin-top:6px;color:var(--muted);font-size:12px;">${escapeHtml(cleanData.stability.notice)}</div>
    </div>
  </section>
  ` : ''}

  <!-- Historical Comparisons & Regression Tracking Section -->
  ${cleanData.historyComparison && (cleanData.historyComparison.matchedComparisons?.length || cleanData.historyComparison.partiallyMatchedComparisons?.length) ? `
  <section class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <h2>Historical Comparisons &amp; Regression Tracking</h2>
      <span class="badge highlight">Baseline: ${escapeHtml(cleanData.historyComparison.baseRunId)}</span>
    </div>
    <div style="overflow-x:auto;">
      <table>
        <thead>
          <tr>
            <th>Configuration</th>
            <th>Baseline Speed</th>
            <th>Current Speed</th>
            <th>Throughput Δ</th>
            <th>P95 Latency Δ</th>
            <th>VMAF Δ</th>
            <th>Assessment</th>
          </tr>
        </thead>
        <tbody>
          ${(cleanData.historyComparison.matchedComparisons || []).map(m => {
            const badgeClass = m.classification === 'regression' ? 'pill error' : (m.classification === 'improvement' ? 'pill success' : (m.classification === 'cross_hardware_comparison' ? 'pill highlight' : 'pill'));
            const displayClassification = m.classification === 'cross_hardware_comparison' ? 'CROSS HARDWARE' : m.classification.toUpperCase();
            const deltaColor = m.classification === 'cross_hardware_comparison' ? 'var(--text)' : (m.speedDeltaPercent > 0 ? 'var(--success)' : m.speedDeltaPercent < 0 ? 'var(--error)' : 'var(--muted)');
            const noticeRow = m.notice ? `<div style="font-size:11px;color:var(--muted);margin-top:2px;">${escapeHtml(m.notice)}</div>` : '';
            return `
              <tr>
                <td><strong>${escapeHtml(m.codec.toUpperCase())} (${escapeHtml(m.encoder)})</strong> ${escapeHtml(m.qualityLabel)}${noticeRow}</td>
                <td>${m.speedBase.toFixed(2)}x</td>
                <td><strong>${m.speedTarget.toFixed(2)}x</strong></td>
                <td style="color:${deltaColor};font-weight:600;">${m.speedDeltaPercent > 0 ? `+${m.speedDeltaPercent}%` : `${m.speedDeltaPercent}%`}</td>
                <td>${m.p95DeltaPercent > 0 ? `+${m.p95DeltaPercent}%` : `${m.p95DeltaPercent}%`}</td>
                <td>${m.vmafDelta !== null ? (m.vmafDelta > 0 ? `+${m.vmafDelta}` : `${m.vmafDelta}`) : '-'}</td>
                <td><span class="${badgeClass}">${escapeHtml(displayClassification)}</span></td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
    ${cleanData.historyComparison.partiallyMatchedComparisons?.length ? `
      <div style="margin-top:14px;font-size:12px;color:var(--muted);">
        <strong>Note on Partially Matched Runs:</strong> ${cleanData.historyComparison.partiallyMatchedComparisons.length} configuration(s) were tested under differing conditions (${cleanData.historyComparison.partiallyMatchedComparisons.map(p => p.differingConditions.join(', ')).join('; ')}). These are strictly marked non-comparable and are not evaluated as performance regressions.
      </div>
    ` : ''}
  </section>
  ` : ''}

  <!-- Evidence-Based Configuration Advice Section -->
  ${cleanData.recommendations ? `
  <section class="card" style="border-color: rgba(255,153,84,0.5); background: rgba(255,153,84,0.02);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <h2>Evidence-Based Configuration Advice</h2>
      <span class="badge highlight">Read-Only Advisory</span>
    </div>
    <div style="margin-bottom:16px;padding:12px;background:#14171F;border-radius:6px;border:1px solid rgba(255,153,84,0.3);font-size:13px;color:var(--text);">
      <strong>Operator Notice:</strong> ${escapeHtml(cleanData.recommendations.operatorNotice)}
    </div>

    ${cleanData.recommendations.recommendations?.length ? `
      <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(320px, 1fr));gap:16px;margin-bottom:16px;">
        ${cleanData.recommendations.recommendations.map(rec => `
          <div style="background:#14171F;padding:16px;border-radius:8px;border:1px solid var(--card-border);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
              <strong style="color:var(--primary);font-size:14px;">${escapeHtml(rec.setting)}</strong>
              <span class="pill ${rec.confidence === 'high' ? 'success' : 'warn'}">${escapeHtml(rec.confidence.toUpperCase())} CONFIDENCE</span>
            </div>
            <div style="display:flex;gap:12px;margin-bottom:10px;font-size:13px;">
              <div>Current: <code style="color:var(--muted);">${escapeHtml(JSON.stringify(rec.currentValue))}</code></div>
              <div>&rarr;</div>
              <div>Recommended: <code style="color:var(--success);font-weight:600;">${escapeHtml(JSON.stringify(rec.recommendedValue))}</code></div>
            </div>
            <div style="font-size:13px;margin-bottom:6px;color:var(--text);">${escapeHtml(rec.reason)}</div>
            <div style="font-size:12px;color:var(--muted);margin-bottom:6px;"><strong>Expected Benefit:</strong> ${escapeHtml(rec.expectedBenefit)}</div>
            <div style="font-size:11px;color:var(--muted);"><strong>Evidence:</strong> ${escapeHtml(rec.supportingEvidence)}</div>
          </div>
        `).join('')}
      </div>
    ` : `
      <div style="padding:14px;color:var(--muted);font-size:13px;">No configuration changes recommended based on current benchmark observations. Current settings match verified hardware capabilities.</div>
    `}

    ${cleanData.recommendations.yamlSnippet ? `
      <div style="margin-top:16px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <div class="stat-label">Proposed config.yaml Snippet</div>
          <button class="player-btn" onclick="copyYamlSnippet()">Copy YAML</button>
        </div>
        <pre id="yaml-snippet-block" style="background:#0F1218;padding:14px;border-radius:8px;border:1px solid var(--card-border);font-family:monospace;font-size:13px;color:#44C78A;overflow-x:auto;">${escapeHtml(cleanData.recommendations.yamlSnippet)}</pre>
      </div>
    ` : ''}

    ${cleanData.recommendations.insufficientEvidence?.length ? `
      <div style="margin-top:14px;padding:12px;background:#14171F;border-radius:6px;font-size:12px;color:var(--muted);">
        <strong>Settings with Insufficient Evidence:</strong>
        <ul style="margin:4px 0 0 16px;">
          ${cleanData.recommendations.insufficientEvidence.map(ie => `<li><strong>${escapeHtml(ie.setting)}:</strong> ${escapeHtml(ie.reason)} <em>(Required: ${escapeHtml(ie.neededTests)})</em></li>`).join('')}
        </ul>
      </div>
    ` : ''}
  </section>
  ` : ''}

  <!-- Sustainable Capacity Summary (if tested) -->
  ${concurrencySummary ? `
  <section class="card" style="border-color: rgba(255,153,84,0.4); background: rgba(255,153,84,0.03);">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
      <h2>Sustainable Transcoding Capacity</h2>
      <span class="badge highlight">${escapeHtml(concurrencySummary.estimateNotice)}</span>
    </div>
    <div class="grid-4" style="margin-bottom:16px;">
      <div>
        <div class="stat-label">Highest Sustainable Jobs</div>
        <div class="stat-val" style="color:var(--success);font-size:24px;">${concurrencySummary.highestSustainableConcurrency || 0} Streams</div>
      </div>
      <div>
        <div class="stat-label">First Failing Concurrency</div>
        <div class="stat-val" style="color:${concurrencySummary.firstFailingConcurrency ? 'var(--error)' : 'var(--muted)'};">
          ${concurrencySummary.firstFailingConcurrency ? `${concurrencySummary.firstFailingConcurrency} Streams` : 'None (All Passed)'}
        </div>
      </div>
      <div>
        <div class="stat-label">Max Tested Concurrency</div>
        <div class="stat-val">${concurrencySummary.maxTestedConcurrency || 0} Streams</div>
      </div>
      <div>
        <div class="stat-label">Scan Stopping Condition</div>
        <div class="stat-val" style="font-size:13px;font-weight:500;color:var(--muted);">${escapeHtml(concurrencySummary.stoppingReason || 'Completed')}</div>
      </div>
    </div>
  </section>
  ` : ''}

  <!-- Quality vs Performance Section (if quality metrics present) -->
  ${scoredRuns.length > 0 ? `
  <section class="card">
    <h2>Objective Video Quality vs. Bitrate Tradeoffs</h2>
    <p style="margin-bottom:16px;">Compares measured VMAF score against actual bitrate. Evaluated against the untouched master source (not the viewing proxy).</p>
    ${buildQualityPerformanceSvg(scoredRuns)}
  </section>
  ` : ''}

  <!-- Throughput Chart -->
  <section class="card">
    <h2>Transcoding Throughput (Real-Time Speed Multiplier)</h2>
    <p style="margin-bottom:16px;">Speed $\ge$ 1.0x indicates the transcode operates faster than real-time playback.</p>
    ${buildSpeedChartSvg(passResults)}
  </section>

  <!-- Detailed Results Table -->
  <section class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;flex-wrap:wrap;gap:12px;">
      <h2>Benchmark Execution Results</h2>
      <div class="filter-bar" style="margin-bottom:0;">
        <button class="filter-btn active" onclick="filterCodec('all')">All Codecs</button>
        <button class="filter-btn" onclick="filterCodec('av1')">AV1</button>
        <button class="filter-btn" onclick="filterCodec('vp9')">VP9</button>
        <button class="filter-btn" onclick="filterCodec('vp8')">VP8</button>
      </div>
    </div>

    <div style="overflow-x:auto;">
      <table id="results-table">
        <thead>
          <tr>
            ${hasMultipleRuns ? '<th onclick="sortTable(0)">Run</th>' : ''}
            <th>Codec</th>
            <th>Encoder</th>
            <th>Quality</th>
            <th>Resolution</th>
            <th onclick="sortTable(${hasMultipleRuns ? 5 : 4})">Bitrate</th>
            <th onclick="sortTable(${hasMultipleRuns ? 6 : 5})">Speed</th>
            <th onclick="sortTable(${hasMultipleRuns ? 7 : 6})">FPS</th>
            ${scoredRuns.length > 0 ? `<th>VMAF (p1)</th><th>SSIM</th><th>PSNR</th>` : ''}
            <th onclick="sortTable(${hasMultipleRuns ? 8 : 7})">1st Chunk</th>
            <th>Status</th>
            <th>Playable Output</th>
          </tr>
        </thead>
        <tbody>
          ${results.map(r => {
            const perf = r.performance || {};
            const q = r.quality || {};
            const qm = r.qualityMetrics || {};
            const speed = perf.speedMultiplier || 0;
            const speedClass = speed >= 1.2 ? 'success' : speed >= 1.0 ? 'warn' : 'error';
            const statusClass = r.status === 'pass' ? 'success' : r.status === 'fail' ? 'error' : 'warn';

            const allFallbacks = r.fallbackEvents || (r.fallback ? [r.fallback] : []);
            const fallbackSummary = allFallbacks.map(f => `${f.type || 'step'}: ${f.from}->${f.to} (${f.reason || ''})`).join('\n');
            const encoderText = allFallbacks.length > 0
              ? `${r.actualEncoder} <span class="pill warn" title="${escapeHtml(fallbackSummary)}">Fallback (${allFallbacks.length})</span>`
              : `${r.actualEncoder || '-'} (${r.requestedEncoder})`;

            const outLink = r.output?.assembledFile
              ? `<a class="file-link" href="${escapeHtml(r.output.assembledFile)}" target="_blank">Play</a>`
              : '<span style="color:var(--muted)">None</span>';

            const errTooltip = r.error ? `title="${escapeHtml(r.error)}"` : '';

            const firstChunkText = perf.firstChunkDurationSec
              ? (perf.firstChunkStartupSec && perf.firstChunkStartupSec > perf.firstChunkDurationSec
                ? `<span title="Startup latency: ${perf.firstChunkStartupSec}s (chunk: ${perf.firstChunkDurationSec.toFixed(2)}s)">${perf.firstChunkDurationSec.toFixed(2)}s</span>`
                : `${perf.firstChunkDurationSec.toFixed(2)}s`)
              : '-';

            const vmafText = qm.vmaf?.mean ? `<strong>${qm.vmaf.mean.toFixed(1)}</strong> <span style="font-size:11px;color:var(--muted);">(${qm.vmaf.p1?.toFixed(1) || '-'})</span>` : '-';
            const ssimText = qm.ssim?.mean ? `${qm.ssim.mean.toFixed(3)}` : '-';
            const psnrText = qm.psnr?.mean ? `${qm.psnr.mean.toFixed(1)} dB` : '-';

            return `
              <tr data-codec="${escapeHtml(r.codec)}">
                ${hasMultipleRuns ? `<td><strong>#${r.runIndex || 1}</strong></td>` : ''}
                <td><strong>${escapeHtml(r.codec.toUpperCase())}</strong> <span style="color:var(--muted);font-size:11px;">(${escapeHtml(r.mode)})</span></td>
                <td>${encoderText}</td>
                <td>${escapeHtml(q.label || q.id)}</td>
                <td>${escapeHtml(q.width || '-')}x${escapeHtml(q.height || '-')}</td>
                <td>${escapeHtml(perf.actualBitrateKbps || q.targetBitrateKbps || '-')} kbps</td>
                <td><span class="pill ${speedClass}"><strong>${speed.toFixed(2)}x</strong></span></td>
                <td>${escapeHtml(perf.effectiveFps || '-')}</td>
                ${scoredRuns.length > 0 ? `<td>${vmafText}</td><td>${ssimText}</td><td>${psnrText}</td>` : ''}
                <td>${firstChunkText}</td>
                <td><span class="pill ${statusClass}" ${errTooltip}>${escapeHtml(r.status.toUpperCase())}</span></td>
                <td>${outLink}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Chunk Latency Breakdown -->
  ${chunkedRuns.length ? `
  <section>
    <h2>Chunk Completion Breakdown (6-Second Playback Windows)</h2>
    <div style="display:flex;gap:16px;flex-direction:column;">
      ${chunkedRuns.map(cr => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
            <h3>${escapeHtml(cr.codec.toUpperCase())} ${escapeHtml(cr.actualEncoder)} &bull; ${escapeHtml(cr.quality?.label)} &bull; Mean: ${cr.performance?.meanChunkSec}s &bull; P95: ${cr.performance?.p95ChunkSec}s</h3>
            <span class="pill ${cr.performance?.deadlineMisses > 0 ? 'error' : 'success'}">
              ${cr.performance?.deadlineMisses > 0 ? `${cr.performance.deadlineMisses} Misses` : 'Zero Missed Deadlines'}
            </span>
          </div>
          ${buildChunkLatencySvg(cr.output.chunks, 6)}
        </div>
      `).join('')}
    </div>
  </section>
  ` : ''}

  <!-- Quality Timeline & Worst-Moment Inspection -->
  ${scoredRuns.some(r => r.qualityMetrics?.timeline?.length > 0) ? `
  <section class="card">
    <h2>Quality Score Timeline &amp; Worst-Moment Inspector</h2>
    <p style="margin-bottom:16px;">Frame-level VMAF timeline across the sample duration. Dips indicate potential scene complexity or compression artifacts.</p>
    ${scoredRuns.filter(r => r.qualityMetrics?.timeline?.length > 0).map(r => `
      <div style="margin-bottom:20px;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <h3>${escapeHtml(r.codec.toUpperCase())} (${escapeHtml(r.actualEncoder)}) ${escapeHtml(r.quality?.label || r.quality?.id)} &bull; Mean VMAF: ${r.qualityMetrics.vmaf.mean}</h3>
          <span style="font-size:12px;color:var(--muted)">Min: ${r.qualityMetrics.vmaf.min} &bull; 1st Percentile: ${r.qualityMetrics.vmaf.p1}</span>
        </div>
        ${buildTimelineSvg(r.qualityMetrics.timeline, r.qualityMetrics.worstIntervals)}
      </div>
    `).join('')}
  </section>
  ` : ''}

  <!-- Synchronized Side-by-Side Video Inspection Workspace -->
  ${referenceVideoRel && passResults.length > 0 ? `
  <section>
    <h2>Synchronized Playback Inspection &amp; Wipe Comparison</h2>
    <div class="player-workspace">
      <div class="selector-bar">
        <label for="target-selector" style="font-weight:600;font-size:13px;color:var(--text);">Select Encoded Output:</label>
        <select id="target-selector" class="custom-select" onchange="switchTargetVideo(this.value)">
          ${passResults.map(r => `
            <option value="${escapeHtml(r.output.assembledFile)}" data-label="${escapeHtml(r.configId)}">${escapeHtml(r.codec.toUpperCase())} ${escapeHtml(r.actualEncoder)} (${escapeHtml(r.quality?.label || r.quality?.id)}) [${escapeHtml(r.mode)}]${r.runIndex ? ` (Run ${r.runIndex})` : ''}</option>
          `).join('')}
        </select>
        <div style="margin-left:auto;display:flex;gap:8px;">
          <button class="player-btn" onclick="togglePlayerView('side-by-side')" id="btn-view-side">Side-by-Side</button>
          <button class="player-btn" onclick="togglePlayerView('wipe')" id="btn-view-wipe">Wipe Comparison</button>
          <button class="player-btn" onclick="toggleZoom()" id="btn-zoom">Zoom 2x</button>
        </div>
      </div>

      <!-- Side-by-Side View -->
      <div id="view-side-by-side" class="player-grid">
        <div class="player-box">
          <div class="player-label">
            <span>Viewing Proxy (Lossy 8-bit H.264/AAC Preview)</span>
          </div>
          <video id="ref-video-side" src="${escapeHtml(referenceVideoRel)}" preload="metadata" muted playsinline></video>
        </div>
        <div class="player-box">
          <div class="player-label">
            <span id="target-label-side">Selected Encoded Output</span>
          </div>
          <video id="target-video-side" src="${escapeHtml(passResults[0].output.assembledFile)}" preload="metadata" muted playsinline></video>
        </div>
      </div>

      <!-- Wipe Comparison View -->
      <div id="view-wipe" class="wipe-container" style="display:none;">
        <video id="ref-video-wipe" src="${escapeHtml(referenceVideoRel)}" preload="metadata" muted playsinline></video>
        <div id="wipe-overlay" class="wipe-overlay">
          <video id="target-video-wipe" src="${escapeHtml(passResults[0].output.assembledFile)}" preload="metadata" muted playsinline></video>
        </div>
        <input type="range" min="0" max="100" value="50" class="wipe-slider" oninput="updateWipe(this.value)">
      </div>

      <!-- Synchronized Controls -->
      <div class="controls-bar">
        <button class="player-btn primary" onclick="togglePlay()" id="btn-play">Play</button>
        <input type="range" id="seek-bar" class="seek-slider" min="0" max="100" value="0" step="0.1" oninput="onSeekInput(this.value)" onchange="onSeekChange(this.value)">
        <span id="time-display" class="time-display">0:00 / 0:00</span>
      </div>
    </div>
  </section>
  ` : ''}

  <!-- Blind A/B Subjective Testing Workspace -->
  ${passResults.length >= 2 ? `
  <section class="card" id="blind-ab-section">
    <h2>Blind A/B Subjective Quality Comparison</h2>
    <p style="margin-bottom:8px;">Compare two encoded outputs without knowing which encoder, codec, or bitrate produced them. Rate visual quality, vote your preference, and reveal identities after voting.</p>
    <p style="font-size:12px;color:var(--muted);margin-bottom:16px;">
      <em>Offline Blinding Note:</em> Candidate identities are randomized and concealed in the UI. In an offline HTML report, technical users can inspect network requests or DOM properties to discern sources. This workflow is intended for unbiased self-evaluation, not cryptographically secure double-blind protocols.
    </p>

    <!-- Embedded Candidate Data -->
    <script id="blind-candidates-json" type="application/json">
      ${JSON.stringify(passResults.map((r, i) => ({
        index: i,
        src: r.output.assembledFile,
        configId: r.configId,
        label: `${r.codec.toUpperCase()} ${r.actualEncoder} (${r.quality?.label || r.quality?.id}) [${r.mode}]`,
        codec: r.codec,
        encoder: r.actualEncoder,
        quality: r.quality?.label || r.quality?.id,
        resolution: `${r.quality?.width || '-'}x${r.quality?.height || '-'}`,
        bitrateKbps: r.performance?.actualBitrateKbps || r.quality?.targetBitrateKbps || null,
        vmaf: r.qualityMetrics?.vmaf?.mean || null,
        ssim: r.qualityMetrics?.ssim?.mean || null,
        psnr: r.qualityMetrics?.psnr?.mean || null,
        cambi: r.qualityMetrics?.cambi?.mean || null
      })))}
    </script>

    <div class="blind-box">
      <!-- Candidate Selection Setup Bar -->
      <div class="selector-bar" id="blind-setup-bar" style="flex-wrap:wrap;gap:12px;align-items:center;">
        <label for="blind-select-1" style="font-size:13px;font-weight:600;">Candidate 1:</label>
        <select id="blind-select-1" class="custom-select">
          ${passResults.map((r, i) => `<option value="${i}" ${i === 0 ? 'selected' : ''}>${escapeHtml(r.codec.toUpperCase())} ${escapeHtml(r.actualEncoder)} (${escapeHtml(r.quality?.label || r.quality?.id)}) [${escapeHtml(r.mode)}]</option>`).join('')}
        </select>
        <label for="blind-select-2" style="font-size:13px;font-weight:600;margin-left:8px;">Candidate 2:</label>
        <select id="blind-select-2" class="custom-select">
          ${passResults.map((r, i) => `<option value="${i}" ${i === 1 ? 'selected' : ''}>${escapeHtml(r.codec.toUpperCase())} ${escapeHtml(r.actualEncoder)} (${escapeHtml(r.quality?.label || r.quality?.id)}) [${escapeHtml(r.mode)}]</option>`).join('')}
        </select>
        <label style="font-size:12px;color:var(--muted);display:flex;align-items:center;gap:6px;cursor:pointer;margin-left:8px;">
          <input type="checkbox" id="blind-allow-identical"> Allow identical candidates (calibration)
        </label>
        <button class="player-btn primary" onclick="startBlindAB()" style="margin-left:auto;">Start Blind Trial</button>
      </div>

      <div id="blind-setup-error" style="display:none;color:var(--error);font-size:13px;margin:8px 0;font-weight:500;"></div>

      <!-- Active Blind Trial Workspace -->
      <div id="blind-workspace" style="display:none;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
          <div style="display:flex;gap:8px;align-items:center;">
            <span style="font-weight:600;font-size:14px;color:var(--primary);">Blind Comparison Active</span>
            <span style="font-size:12px;color:var(--muted);">(Identities masked as Candidate A &amp; Candidate B)</span>
          </div>
          <div style="display:flex;gap:6px;">
            <button class="player-btn active" id="btn-blind-mode-side" onclick="setBlindViewMode('side')">Side-by-Side</button>
            <button class="player-btn" id="btn-blind-mode-wipe" onclick="setBlindViewMode('wipe')">Wipe Curtain</button>
            <button class="player-btn" id="btn-blind-mode-zoom" onclick="toggleBlindZoom()">Zoom 2x</button>
            <button class="player-btn quiet" onclick="resetBlindAB()" style="margin-left:8px;">Change Candidates</button>
          </div>
        </div>

        <!-- Side-by-Side View -->
        <div id="blind-view-side" class="player-grid">
          <div class="player-box">
            <div class="player-label"><span id="blind-label-a">Candidate A</span></div>
            <video id="blind-video-a" preload="metadata" muted playsinline></video>
          </div>
          <div class="player-box">
            <div class="player-label"><span id="blind-label-b">Candidate B</span></div>
            <video id="blind-video-b" preload="metadata" muted playsinline></video>
          </div>
        </div>

        <!-- Wipe Curtain View -->
        <div id="blind-view-wipe" class="wipe-container" style="display:none;">
          <video id="blind-wipe-bg" preload="metadata" muted playsinline></video>
          <div id="blind-wipe-overlay" class="wipe-overlay">
            <video id="blind-wipe-fg" preload="metadata" muted playsinline></video>
          </div>
          <input type="range" min="0" max="100" value="50" class="wipe-slider" oninput="updateBlindWipe(this.value)">
        </div>

        <!-- Synchronized Controls -->
        <div class="controls-bar" style="margin-top:12px;">
          <button class="player-btn primary" onclick="toggleBlindPlay()" id="btn-blind-play">Play</button>
          <input type="range" id="blind-seek-bar" class="seek-slider" min="0" max="100" value="0" step="0.1" oninput="onBlindSeek(this.value)">
          <span id="blind-time" class="time-display">0:00 / 0:00</span>
          <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
            <span style="font-size:12px;color:var(--muted)">Speed:</span>
            <select id="blind-speed-select" class="custom-select" style="padding:4px 8px;font-size:12px;" onchange="setBlindSpeed(this.value)">
              <option value="0.25">0.25x</option>
              <option value="0.5">0.5x</option>
              <option value="1" selected>1.0x</option>
              <option value="2">2.0x</option>
            </select>
          </div>
        </div>

        <!-- 5-Level Rating & Notes Panel -->
        <div id="blind-voting-card" style="background:#181C24;border:1px solid var(--card-border);padding:16px;border-radius:8px;margin-top:16px;">
          <div style="font-weight:600;margin-bottom:10px;">Subjective Visual Quality Preference (5-Level Scale):</div>
          <div style="display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;">
            <button class="player-btn" onclick="setBlindVote('strongly-a')" id="btn-vote-strongly-a">Strongly Prefer A</button>
            <button class="player-btn" onclick="setBlindVote('slightly-a')" id="btn-vote-slightly-a">Slightly Prefer A</button>
            <button class="player-btn" onclick="setBlindVote('equal')" id="btn-vote-equal">Equal / No Difference</button>
            <button class="player-btn" onclick="setBlindVote('slightly-b')" id="btn-vote-slightly-b">Slightly Prefer B</button>
            <button class="player-btn" onclick="setBlindVote('strongly-b')" id="btn-vote-strongly-b">Strongly Prefer B</button>
          </div>

          <div style="margin-bottom:12px;">
            <label for="blind-notes-input" style="font-size:12px;color:var(--muted);display:block;margin-bottom:4px;">Evaluation Notes &amp; Observations (optional):</label>
            <textarea id="blind-notes-input" style="width:100%;height:54px;background:#13161c;border:1px solid var(--card-border);color:var(--text);border-radius:6px;padding:8px;font-family:inherit;font-size:13px;box-sizing:border-box;" placeholder="Note any ringing, blockiness, gradient banding, text sharpness, or artifact differences..."></textarea>
          </div>

          <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
            <button class="player-btn highlight" onclick="revealBlindIdentities()" id="btn-blind-reveal">Reveal Identities</button>
            <button class="player-btn quiet" onclick="resetBlindAB()" style="margin-left:auto;">Reset / Next Comparison</button>
          </div>

          <!-- Reveal Panel (Safe DOM generated) -->
          <div id="blind-reveal-card" style="display:none;padding:16px;border-radius:8px;background:#1E232E;border:1px solid var(--primary);margin-top:14px;">
            <h3 style="color:var(--primary);margin-bottom:12px;">Candidate Identities Revealed</h3>
            <div id="blind-reveal-content"></div>
            <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
              <button class="player-btn primary" onclick="exportBlindResults()">Export Evaluation Results (JSON)</button>
              <button class="player-btn" onclick="resetBlindAB()">Start Another Comparison</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
  ` : ''}

  <!-- Screenshots Contact Sheet -->
  ${cleanData.screenshots && cleanData.screenshots.length > 0 ? `
  <section class="card">
    <h2>Screenshot Contact Sheet (Matching Timestamps)</h2>
    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(280px, 1fr));gap:16px;margin-top:16px;">
      ${cleanData.screenshots.map(s => `
        <div style="background:#000;border:1px solid var(--card-border);border-radius:8px;overflow:hidden;">
          <div style="padding:6px 10px;background:rgba(20,23,31,0.9);font-size:11px;font-weight:600;color:var(--text);border-bottom:1px solid var(--card-border);">
            ${escapeHtml(s.label)} (${s.timestampSeconds}s)
          </div>
          <a href="${escapeHtml(s.relativePath)}" target="_blank">
            <img src="${escapeHtml(s.relativePath)}" alt="${escapeHtml(s.label)}" style="width:100%;height:auto;display:block;" loading="lazy">
          </a>
        </div>
      `).join('')}
    </div>
  </section>
  ` : ''}

</div>

<script>
  let isPlaying = false;
  let isZoomed = false;
  let currentMode = 'side-by-side';

  const refSide = document.getElementById('ref-video-side');
  const targetSide = document.getElementById('target-video-side');
  const refWipe = document.getElementById('ref-video-wipe');
  const targetWipe = document.getElementById('target-video-wipe');
  const wipeOverlay = document.getElementById('wipe-overlay');
  const seekBar = document.getElementById('seek-bar');
  const timeDisplay = document.getElementById('time-display');
  const btnPlay = document.getElementById('btn-play');

  function togglePlay() {
    isPlaying = !isPlaying;
    const v1 = currentMode === 'side-by-side' ? refSide : refWipe;
    const v2 = currentMode === 'side-by-side' ? targetSide : targetWipe;
    if (!v1 || !v2) return;
    if (isPlaying) {
      v1.play(); v2.play();
      if (btnPlay) btnPlay.textContent = 'Pause';
    } else {
      v1.pause(); v2.pause();
      if (btnPlay) btnPlay.textContent = 'Play';
    }
  }

  function switchTargetVideo(src) {
    if (targetSide) targetSide.src = src;
    if (targetWipe) targetWipe.src = src;
    const sel = document.getElementById('target-selector');
    const label = sel ? sel.options[sel.selectedIndex].text : 'Selected Output';
    const sideLbl = document.getElementById('target-label-side');
    if (sideLbl) sideLbl.textContent = label;
    if (isPlaying) {
      if (targetSide) targetSide.play();
      if (targetWipe) targetWipe.play();
    }
  }

  function updateWipe(pct) {
    if (wipeOverlay) wipeOverlay.style.width = pct + '%';
  }

  function togglePlayerView(mode) {
    currentMode = mode;
    const sideEl = document.getElementById('view-side-by-side');
    const wipeEl = document.getElementById('view-wipe');
    const btnSide = document.getElementById('btn-view-side');
    const btnWipe = document.getElementById('btn-view-wipe');

    if (mode === 'side-by-side') {
      if (sideEl) sideEl.style.display = 'grid';
      if (wipeEl) wipeEl.style.display = 'none';
      if (btnSide) btnSide.classList.add('active');
      if (btnWipe) btnWipe.classList.remove('active');
    } else {
      if (sideEl) sideEl.style.display = 'none';
      if (wipeEl) wipeEl.style.display = 'block';
      if (btnWipe) btnWipe.classList.add('active');
      if (btnSide) btnSide.classList.remove('active');
    }
  }

  function toggleZoom() {
    isZoomed = !isZoomed;
    const sideEl = document.getElementById('view-side-by-side');
    const wipeEl = document.getElementById('view-wipe');
    const btn = document.getElementById('btn-zoom');
    if (sideEl) sideEl.classList.toggle('zoomed', isZoomed);
    if (wipeEl) wipeEl.classList.toggle('zoomed', isZoomed);
    if (btn) btn.classList.toggle('active', isZoomed);
  }

  function onSeekInput(pct) {
    const v1 = currentMode === 'side-by-side' ? refSide : refWipe;
    if (!v1 || !v1.duration) return;
    const targetTime = (pct / 100) * v1.duration;
    seekBothPlayers(targetTime);
  }

  function seekBothPlayers(sec) {
    if (refSide) refSide.currentTime = sec;
    if (targetSide) targetSide.currentTime = sec;
    if (refWipe) refWipe.currentTime = sec;
    if (targetWipe) targetWipe.currentTime = sec;
  }

  if (refSide) {
    refSide.addEventListener('timeupdate', () => {
      if (!refSide.duration) return;
      const pct = (refSide.currentTime / refSide.duration) * 100;
      if (seekBar) seekBar.value = pct;
      if (timeDisplay) {
        timeDisplay.textContent = formatTime(refSide.currentTime) + ' / ' + formatTime(refSide.duration);
      }
    });
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  /* Table Filtering */
  function filterCodec(codec) {
    const rows = document.querySelectorAll('#results-table tbody tr');
    const btns = document.querySelectorAll('.filter-btn');
    btns.forEach(b => b.classList.remove('active'));
    event.target.classList.add('active');

    rows.forEach(r => {
      const c = r.getAttribute('data-codec');
      if (codec === 'all' || c === codec) {
        r.style.display = '';
      } else {
        r.style.display = 'none';
      }
    });
  }

  /* Blind A/B Implementation */
  let blindCandidateA = null;
  let blindCandidateB = null;
  let blindVote = null;
  let blindIsZoomed = false;

  function getBlindCandidates() {
    try {
      const el = document.getElementById('blind-candidates-json');
      return el ? JSON.parse(el.textContent) : [];
    } catch (e) { return []; }
  }

  function startBlindAB() {
    const sel1 = document.getElementById('blind-select-1');
    const sel2 = document.getElementById('blind-select-2');
    const errEl = document.getElementById('blind-setup-error');
    if (!sel1 || !sel2) return;

    const idx1 = parseInt(sel1.value, 10);
    const idx2 = parseInt(sel2.value, 10);
    const allowIdentical = document.getElementById('blind-allow-identical')?.checked;

    if (idx1 === idx2 && !allowIdentical) {
      if (errEl) {
        errEl.textContent = 'Please select two different outputs to compare (or check "Allow identical candidates" for calibration).';
        errEl.style.display = 'block';
      }
      return;
    }
    if (errEl) errEl.style.display = 'none';

    const candidates = getBlindCandidates();
    const cand1 = candidates[idx1];
    const cand2 = candidates[idx2];
    if (!cand1 || !cand2) return;

    // Randomize Candidate A and Candidate B assignment
    const swap = Math.random() >= 0.5;
    blindCandidateA = swap ? cand2 : cand1;
    blindCandidateB = swap ? cand1 : cand2;
    blindVote = null;

    // Set video sources
    const vidA = document.getElementById('blind-video-a');
    const vidB = document.getElementById('blind-video-b');
    const wipeBg = document.getElementById('blind-wipe-bg');
    const wipeFg = document.getElementById('blind-wipe-fg');

    if (vidA && vidB) {
      vidA.src = blindCandidateA.src;
      vidB.src = blindCandidateB.src;
    }
    if (wipeBg && wipeFg) {
      wipeBg.src = blindCandidateA.src;
      wipeFg.src = blindCandidateB.src;
    }

    // Hide setup, show active workspace
    document.getElementById('blind-setup-bar').style.display = 'none';
    document.getElementById('blind-workspace').style.display = 'block';
    document.getElementById('blind-reveal-card').style.display = 'none';

    // Clear previous vote styling
    ['strongly-a', 'slightly-a', 'equal', 'slightly-b', 'strongly-b'].forEach(k => {
      document.getElementById('btn-vote-' + k)?.classList.remove('active');
    });
    const notesInput = document.getElementById('blind-notes-input');
    if (notesInput) notesInput.value = '';
    setBlindViewMode('side');
  }

  function resetBlindAB() {
    const vidA = document.getElementById('blind-video-a');
    const vidB = document.getElementById('blind-video-b');
    const wipeBg = document.getElementById('blind-wipe-bg');
    const wipeFg = document.getElementById('blind-wipe-fg');
    if (vidA) { vidA.pause(); vidA.removeAttribute('src'); vidA.load(); }
    if (vidB) { vidB.pause(); vidB.removeAttribute('src'); vidB.load(); }
    if (wipeBg) { wipeBg.pause(); wipeBg.removeAttribute('src'); wipeBg.load(); }
    if (wipeFg) { wipeFg.pause(); wipeFg.removeAttribute('src'); wipeFg.load(); }

    document.getElementById('blind-workspace').style.display = 'none';
    document.getElementById('blind-setup-bar').style.display = 'flex';
    document.getElementById('blind-reveal-card').style.display = 'none';
    blindCandidateA = null;
    blindCandidateB = null;
    blindVote = null;
  }

  function setBlindViewMode(mode) {
    const sideEl = document.getElementById('blind-view-side');
    const wipeEl = document.getElementById('blind-view-wipe');
    const btnSide = document.getElementById('btn-blind-mode-side');
    const btnWipe = document.getElementById('btn-blind-mode-wipe');

    if (mode === 'side') {
      if (sideEl) sideEl.style.display = 'grid';
      if (wipeEl) wipeEl.style.display = 'none';
      btnSide?.classList.add('active');
      btnWipe?.classList.remove('active');
    } else {
      if (sideEl) sideEl.style.display = 'none';
      if (wipeEl) wipeEl.style.display = 'block';
      btnSide?.classList.remove('active');
      btnWipe?.classList.add('active');
      updateBlindWipe(50);
    }
  }

  function toggleBlindZoom() {
    blindIsZoomed = !blindIsZoomed;
    const sideEl = document.getElementById('blind-view-side');
    const wipeEl = document.getElementById('blind-view-wipe');
    const btn = document.getElementById('btn-blind-mode-zoom');
    if (sideEl) sideEl.classList.toggle('zoomed', blindIsZoomed);
    if (wipeEl) wipeEl.classList.toggle('zoomed', blindIsZoomed);
    if (btn) btn.classList.toggle('active', blindIsZoomed);
  }

  function updateBlindWipe(pct) {
    const overlay = document.getElementById('blind-wipe-overlay');
    if (overlay) overlay.style.width = pct + '%';
  }

  function setBlindSpeed(rate) {
    const num = parseFloat(rate);
    const vidA = document.getElementById('blind-video-a');
    const vidB = document.getElementById('blind-video-b');
    const wipeBg = document.getElementById('blind-wipe-bg');
    const wipeFg = document.getElementById('blind-wipe-fg');
    if (vidA) vidA.playbackRate = num;
    if (vidB) vidB.playbackRate = num;
    if (wipeBg) wipeBg.playbackRate = num;
    if (wipeFg) wipeFg.playbackRate = num;
  }

  function toggleBlindPlay() {
    const vidA = document.getElementById('blind-video-a');
    const vidB = document.getElementById('blind-video-b');
    const wipeBg = document.getElementById('blind-wipe-bg');
    const wipeFg = document.getElementById('blind-wipe-fg');
    const btn = document.getElementById('btn-blind-play');
    if (!vidA) return;

    if (vidA.paused) {
      vidA.play().catch(() => {});
      vidB?.play().catch(() => {});
      wipeBg?.play().catch(() => {});
      wipeFg?.play().catch(() => {});
      if (btn) btn.textContent = 'Pause';
    } else {
      vidA.pause();
      vidB?.pause();
      wipeBg?.pause();
      wipeFg?.pause();
      if (btn) btn.textContent = 'Play';
    }
  }

  function onBlindSeek(pct) {
    const vidA = document.getElementById('blind-video-a');
    const vidB = document.getElementById('blind-video-b');
    const wipeBg = document.getElementById('blind-wipe-bg');
    const wipeFg = document.getElementById('blind-wipe-fg');
    if (!vidA || !vidA.duration) return;
    const time = (pct / 100) * vidA.duration;
    vidA.currentTime = time;
    if (vidB) vidB.currentTime = time;
    if (wipeBg) wipeBg.currentTime = time;
    if (wipeFg) wipeFg.currentTime = time;
  }

  function setBlindVote(preference) {
    blindVote = preference;
    ['strongly-a', 'slightly-a', 'equal', 'slightly-b', 'strongly-b'].forEach(k => {
      document.getElementById('btn-vote-' + k)?.classList.remove('active');
    });
    document.getElementById('btn-vote-' + preference)?.classList.add('active');
  }

  function revealBlindIdentities() {
    if (!blindCandidateA || !blindCandidateB) return;
    const card = document.getElementById('blind-reveal-card');
    const content = document.getElementById('blind-reveal-content');
    if (!card || !content) return;

    // Clear previous content
    while (content.firstChild) {
      content.removeChild(content.firstChild);
    }

    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    table.style.fontSize = '13px';

    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    ['Attribute', 'Candidate A', 'Candidate B'].forEach(t => {
      const th = document.createElement('th');
      th.textContent = t;
      th.style.padding = '8px';
      th.style.textAlign = 'left';
      th.style.borderBottom = '1px solid var(--card-border)';
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    const rows = [
      ['Codec', blindCandidateA.codec.toUpperCase(), blindCandidateB.codec.toUpperCase()],
      ['Encoder', blindCandidateA.encoder, blindCandidateB.encoder],
      ['Quality Tier', blindCandidateA.quality, blindCandidateB.quality],
      ['Resolution', blindCandidateA.resolution, blindCandidateB.resolution],
      ['Bitrate', blindCandidateA.bitrateKbps ? blindCandidateA.bitrateKbps + ' kbps' : '-', blindCandidateB.bitrateKbps ? blindCandidateB.bitrateKbps + ' kbps' : '-'],
      ['VMAF (Mean)', blindCandidateA.vmaf ? blindCandidateA.vmaf.toFixed(1) : '-', blindCandidateB.vmaf ? blindCandidateB.vmaf.toFixed(1) : '-'],
      ['SSIM (Mean)', blindCandidateA.ssim ? blindCandidateA.ssim.toFixed(4) : '-', blindCandidateB.ssim ? blindCandidateB.ssim.toFixed(4) : '-'],
      ['PSNR (dB)', blindCandidateA.psnr ? blindCandidateA.psnr.toFixed(1) + ' dB' : '-', blindCandidateB.psnr ? blindCandidateB.psnr.toFixed(1) + ' dB' : '-'],
      ['CAMBI', blindCandidateA.cambi ? blindCandidateA.cambi.toFixed(4) : '-', blindCandidateB.cambi ? blindCandidateB.cambi.toFixed(4) : '-']
    ];

    rows.forEach(([attr, valA, valB]) => {
      const tr = document.createElement('tr');
      const tdAttr = document.createElement('td');
      tdAttr.style.padding = '6px 8px';
      tdAttr.style.color = 'var(--muted)';
      tdAttr.textContent = attr;

      const tdA = document.createElement('td');
      tdA.style.padding = '6px 8px';
      tdA.style.fontWeight = '600';
      tdA.textContent = valA;

      const tdB = document.createElement('td');
      tdB.style.padding = '6px 8px';
      tdB.style.fontWeight = '600';
      tdB.textContent = valB;

      tr.appendChild(tdAttr);
      tr.appendChild(tdA);
      tr.appendChild(tdB);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    content.appendChild(table);

    // Vote summary box
    const voteBox = document.createElement('div');
    voteBox.style.marginTop = '12px';
    voteBox.style.padding = '10px';
    voteBox.style.borderRadius = '6px';
    voteBox.style.background = '#13161c';
    voteBox.style.border = '1px solid var(--card-border)';

    const voteLabels = {
      'strongly-a': 'Strongly Prefer Candidate A',
      'slightly-a': 'Slightly Prefer Candidate A',
      'equal': 'Equal / No Difference',
      'slightly-b': 'Slightly Prefer Candidate B',
      'strongly-b': 'Strongly Prefer Candidate B'
    };

    const voteLine = document.createElement('div');
    voteLine.style.fontWeight = '600';
    voteLine.style.color = 'var(--primary)';
    voteLine.textContent = 'Your Recorded Preference: ' + (voteLabels[blindVote] || 'None Recorded');
    voteBox.appendChild(voteLine);

    const notesVal = document.getElementById('blind-notes-input')?.value?.trim();
    if (notesVal) {
      const notesLine = document.createElement('div');
      notesLine.style.marginTop = '6px';
      notesLine.style.fontSize = '12px';
      notesLine.style.color = 'var(--muted)';
      notesLine.textContent = 'Notes: ' + notesVal;
      voteBox.appendChild(notesLine);
    }

    content.appendChild(voteBox);
    card.style.display = 'block';
  }

  function exportBlindResults() {
    const voteLabels = {
      'strongly-a': 'Strongly Prefer Candidate A',
      'slightly-a': 'Slightly Prefer Candidate A',
      'equal': 'Equal / No Difference',
      'slightly-b': 'Slightly Prefer Candidate B',
      'strongly-b': 'Strongly Prefer Candidate B'
    };
    const payload = {
      timestamp: new Date().toISOString(),
      evaluationMode: 'blind_ab',
      preference: blindVote,
      preferenceLabel: voteLabels[blindVote] || 'None',
      notes: document.getElementById('blind-notes-input')?.value || '',
      candidateA: blindCandidateA,
      candidateB: blindCandidateB
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'blind-ab-evaluation-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  function copyYamlSnippet() {
    const el = document.getElementById('yaml-snippet-block');
    if (el) {
      navigator.clipboard.writeText(el.textContent).then(() => {
        alert('YAML configuration snippet copied to clipboard.');
      }).catch(() => {
        // Fallback for non-https/clipboard permission
        const range = document.createRange();
        range.selectNode(el);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(range);
        document.execCommand('copy');
        alert('YAML configuration snippet copied to clipboard.');
      });
    }
  }
</script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = {
  SCHEMA_VERSION,
  sanitizeText,
  sanitizeForExport,
  generateJsonReport,
  generateCsvReport,
  generateHtmlReport,
  buildSpeedChartSvg,
  buildChunkLatencySvg,
  buildQualityPerformanceSvg,
  buildTimelineSvg,
  buildTelemetryTimelineSvg
};
