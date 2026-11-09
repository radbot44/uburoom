'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_VERSION = '1.0.0';

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
  const headers = [
    'Run',
    'ConfigID',
    'Mode',
    'Codec',
    'RequestedEncoder',
    'ActualEncoder',
    'QualityID',
    'Resolution',
    'TargetBitrateKbps',
    'ActualBitrateKbps',
    'Status',
    'SpeedMultiplier',
    'EffectiveFPS',
    'SuccessfulTimeSec',
    'TotalElapsedSec',
    'FirstChunkSec',
    'MeanChunkSec',
    'P95ChunkSec',
    'MaxChunkSec',
    'DeadlineMisses',
    'TotalBytes',
    'FallbackEvents'
  ];

  const rows = (benchmarkData.results || []).map(r => {
    const perf = r.performance || {};
    const q = r.quality || {};
    const fallbacks = (r.fallbackEvents || (r.fallback ? [r.fallback] : []))
      .map(f => `${f.type || 'step'}:${f.from}->${f.to} (${(f.reason || '').replace(/[\r\n]+/g, ' ').trim()})`)
      .join('; ');

    return [
      r.runIndex || 1,
      r.configId,
      r.mode,
      r.codec,
      r.requestedEncoder,
      r.actualEncoder,
      q.id || '',
      `${q.width}x${q.height}`,
      q.targetBitrateKbps || '',
      perf.actualBitrateKbps || '',
      r.status,
      perf.speedMultiplier || '',
      perf.effectiveFps || '',
      perf.successfulEncodeTimeSec !== undefined ? perf.successfulEncodeTimeSec : (perf.totalEncodingTimeSec || ''),
      perf.totalEncodingTimeSec || '',
      perf.firstChunkDurationSec !== null && perf.firstChunkDurationSec !== undefined ? perf.firstChunkDurationSec : '',
      perf.meanChunkSec !== null && perf.meanChunkSec !== undefined ? perf.meanChunkSec : '',
      perf.p95ChunkSec !== null && perf.p95ChunkSec !== undefined ? perf.p95ChunkSec : '',
      perf.maxChunkSec !== null && perf.maxChunkSec !== undefined ? perf.maxChunkSec : '',
      perf.deadlineMisses || 0,
      perf.totalBytes || 0,
      fallbacks ? `"${fallbacks.replace(/"/g, '""')}"` : 'None'
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
    const label = `${r.codec.toUpperCase()} ${r.actualEncoder} (${r.quality?.label || r.quality?.id}) [${r.mode}]${runTag}`;
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
 * Generates the complete, standalone offline HTML report.
 */
function generateHtmlReport(benchmarkData, outputPath) {
  const env = benchmarkData.environment || {};
  const src = benchmarkData.source || {};
  const results = benchmarkData.results || [];
  const probed = benchmarkData.probedEncoders || [];

  const speedChartSvg = buildSpeedChartSvg(results.filter(r => r.status === 'pass'));

  const chunkedRuns = results.filter(r => r.mode === 'chunked' && r.output?.chunks?.length);

  const referenceVideoRel = src.referenceVideoRelative || null;
  const passResults = results.filter(r => r.status === 'pass' && r.output?.assembledFile);
  const firstPassResult = passResults[0] || null;
  const firstTargetRel = firstPassResult ? firstPassResult.output.assembledFile : null;

  const hasMultipleRuns = results.some(r => r.runIndex > 1);

  const screenshots = benchmarkData.screenshots || [];

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="darkreader-lock" content="true">
  <title>uburoom Transcoding Benchmark Report</title>
  <style>
    :root {
      --background: #101217;
      --card: #1B1E26;
      --elevated: #292E38;
      --border: #393F4D;
      --text: #F8F7F4;
      --muted: #AAB0BC;
      --orange: #FF9954;
      --pink: #FF7197;
      --primary: var(--orange);
      --secondary: var(--pink);
      --success: #44C78A;
      --warning: #E8B45C;
      --error: #ff9ca1;
      --danger: #b6263c;
      --good: #A5C96B;
      color-scheme: dark;
      font: 14px/1.5 Inter, system-ui, -apple-system, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--background);
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { padding: 24px 20px 60px; max-width: 1400px; margin: 0 auto; }
    
    header { margin-bottom: 24px; border-bottom: 1px solid var(--border); padding-bottom: 16px; }
    .header-top { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; }
    h1 { font-size: 24px; font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 12px; }
    h1 .badge { font-size: 12px; padding: 3px 8px; border-radius: 6px; background: color-mix(in srgb, var(--primary) 20%, transparent); border: 1px solid var(--primary); color: var(--primary); }
    .timestamp { font-size: 13px; color: var(--muted); }

    .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin: 20px 0; }
    .card { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 16px 20px; }
    .card h2 { font-size: 15px; font-weight: 600; color: var(--primary); margin-bottom: 12px; display: flex; align-items: center; justify-content: space-between; }
    .info-list dt { font-size: 12px; color: var(--muted); margin-top: 8px; }
    .info-list dd { font-size: 14px; font-weight: 500; color: var(--text); overflow-wrap: anywhere; }

    .notice-box { background: color-mix(in srgb, var(--elevated) 80%, var(--card)); border-left: 4px solid var(--primary); border-radius: 8px; padding: 12px 16px; margin: 16px 0 24px; font-size: 13px; color: var(--text); }
    .notice-box.warning { border-left-color: var(--warning); background: color-mix(in srgb, #E8B45C 10%, var(--card)); }

    section { margin-top: 36px; }
    section > h2 { font-size: 18px; font-weight: 600; margin-bottom: 16px; color: var(--text); display: flex; align-items: center; gap: 8px; }

    /* Filters */
    .filter-bar { display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }
    .filter-btn { background: var(--elevated); border: 1px solid var(--border); color: var(--muted); padding: 6px 14px; border-radius: 8px; font-size: 12px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
    .filter-btn:hover { background: color-mix(in srgb, var(--elevated), var(--text) 8%); color: var(--text); }
    .filter-btn.active { background: color-mix(in srgb, var(--primary) 15%, var(--elevated)); border-color: var(--primary); color: var(--primary); font-weight: 600; }

    /* Table */
    .table-container { overflow-x: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--card); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th { background: var(--elevated); color: var(--muted); font-size: 12px; font-weight: 600; padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; white-space: nowrap; }
    th:hover { color: var(--text); }
    td { padding: 10px 14px; border-bottom: 1px solid color-mix(in srgb, var(--border) 40%, transparent); vertical-align: middle; white-space: nowrap; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: color-mix(in srgb, var(--elevated) 40%, transparent); }

    .pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 500; }
    .pill.success { background: color-mix(in srgb, var(--success) 15%, transparent); border: 1px solid var(--success); color: var(--success); }
    .pill.warn { background: color-mix(in srgb, var(--warning) 15%, transparent); border: 1px solid var(--warning); color: var(--warning); }
    .pill.error { background: color-mix(in srgb, var(--error) 15%, transparent); border: 1px solid var(--error); color: var(--error); }
    .pill.info { background: color-mix(in srgb, var(--primary) 15%, transparent); border: 1px solid var(--primary); color: var(--primary); }

    /* Synchronized Player */
    .player-workspace { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 18px; margin-top: 16px; }
    .player-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 14px; }
    @media (max-width: 900px) { .player-grid { grid-template-columns: 1fr; } }
    .player-box { background: #000; border-radius: 8px; overflow: hidden; border: 1px solid var(--border); position: relative; aspect-ratio: 16/9; display: flex; align-items: center; justify-content: center; }
    .player-box video { width: 100%; height: 100%; object-fit: contain; }
    .player-label { position: absolute; top: 10px; left: 10px; background: rgba(16, 18, 23, 0.85); backdrop-filter: blur(4px); padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; color: #fff; z-index: 2; border: 1px solid var(--border); }
    
    .player-controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding: 12px 16px; background: var(--elevated); border-radius: 10px; margin-top: 12px; }
    .player-btn { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
    .player-btn:hover { background: color-mix(in srgb, var(--primary) 15%, var(--card)); border-color: var(--primary); }
    .seek-slider { flex: 1; min-width: 140px; cursor: pointer; accent-color: var(--primary); }
    .time-readout { font-size: 13px; font-family: monospace; color: var(--muted); }

    .selector-bar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 14px; padding: 10px 14px; background: var(--elevated); border-radius: 8px; }
    .custom-select { background: var(--card); border: 1px solid var(--border); color: var(--text); padding: 6px 12px; border-radius: 6px; font-size: 13px; outline: none; }
    .custom-select:focus { border-color: var(--primary); }

    /* Wipe / Split Comparison */
    .wipe-container { position: relative; width: 100%; max-width: 960px; aspect-ratio: 16/9; background: #000; border-radius: 10px; overflow: hidden; border: 1px solid var(--border); margin: 0 auto; }
    .wipe-video { position: absolute; top: 0; left: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
    .wipe-top-wrapper { position: absolute; top: 0; left: 0; width: 100%; height: 100%; overflow: hidden; clip-path: polygon(0 0, var(--wipe-pct, 50%) 0, var(--wipe-pct, 50%) 100%, 0 100%); }
    .wipe-divider { position: absolute; top: 0; bottom: 0; left: var(--wipe-pct, 50%); width: 3px; background: var(--primary); transform: translateX(-50%); pointer-events: none; box-shadow: 0 0 8px rgba(0,0,0,0.8); }
    .wipe-slider-input { position: absolute; top: 0; left: 0; width: 100%; height: 100%; opacity: 0; cursor: ew-resize; margin: 0; z-index: 10; }

    /* Screenshots */
    .screenshots-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; margin-top: 16px; }
    .screenshot-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; }
    .screenshot-card img { width: 100%; aspect-ratio: 16/9; object-fit: cover; display: block; border-bottom: 1px solid var(--border); cursor: zoom-in; }
    .screenshot-caption { padding: 10px 14px; font-size: 12px; color: var(--muted); display: flex; justify-content: space-between; align-items: center; }

    /* Zoom Viewer */
    .zoom-active { transform: scale(2.2); cursor: move; }

    /* Links */
    a.file-link { color: var(--primary); text-decoration: none; font-weight: 500; }
    a.file-link:hover { text-decoration: underline; }
  </style>
</head>
<body>

  <header>
    <div class="header-top">
      <h1>
        uburoom Transcoding Benchmark
        <span class="badge">Stage 1</span>
      </h1>
      <div class="timestamp">Generated: ${escapeHtml(new Date().toLocaleString())}</div>
    </div>
  </header>

  <!-- High-Level Summary Cards -->
  <div class="summary-grid">
    <div class="card">
      <h2>Hardware & System</h2>
      <dl class="info-list">
        <dt>CPU</dt>
        <dd>${escapeHtml(env.cpu?.model)} (${escapeHtml(env.cpu?.cores)} cores)</dd>
        <dt>GPU</dt>
        <dd>${escapeHtml(env.gpu || 'Not detected')}</dd>
        <dt>Platform</dt>
        <dd>${escapeHtml(env.platform)} (${escapeHtml(env.arch)}), Node ${escapeHtml(env.nodeVersion)}</dd>
        <dt>RAM</dt>
        <dd>${escapeHtml(env.memoryFreeMB)} MB free / ${escapeHtml(env.memoryTotalMB)} MB total</dd>
      </dl>
    </div>

    <div class="card">
      <h2>Configuration Profile</h2>
      <dl class="info-list">
        <dt>Profile Name</dt>
        <dd>${escapeHtml(benchmarkData.configProfile || 'config.yaml')}</dd>
        <dt>Configured Encoder Setting</dt>
        <dd>${escapeHtml(benchmarkData.transcodingSettings?.encoder || 'auto')}</dd>
        <dt>Hardware Decode / CPU Fallback</dt>
        <dd>${benchmarkData.transcodingSettings?.hardwareDecode ? 'Enabled' : 'Disabled'} / ${benchmarkData.transcodingSettings?.cpuFallback ? 'Enabled' : 'Disabled'}</dd>
        <dt>Git Revision</dt>
        <dd>${escapeHtml(env.gitRevision ? env.gitRevision.slice(0, 10) : 'Unknown')}</dd>
      </dl>
    </div>

    <div class="card">
      <h2>Source Video Properties</h2>
      <dl class="info-list">
        <dt>Source File</dt>
        <dd>${escapeHtml(src.fileName || 'Synthetic Reference')}</dd>
        <dt>Resolution & Cadence</dt>
        <dd>${escapeHtml(src.video?.resolution)} @ ${escapeHtml(src.video?.fps)} fps (${escapeHtml(src.video?.codec)})</dd>
        <dt>Color & HDR Classification</dt>
        <dd>${escapeHtml(src.hdr?.label || 'SDR')}</dd>
        <dt>Sample Duration</dt>
        <dd>${escapeHtml(benchmarkData.sampleDuration || 60)}s (offset ${escapeHtml(benchmarkData.startOffset || 0)}s)</dd>
      </dl>
    </div>

    <div class="card">
      <h2>FFmpeg & Tools</h2>
      <dl class="info-list">
        <dt>FFmpeg Version</dt>
        <dd>${escapeHtml(benchmarkData.tools?.ffmpegVersion || 'FFmpeg')}</dd>
        <dt>FFprobe Version</dt>
        <dd>${escapeHtml(benchmarkData.tools?.ffprobeVersion || 'FFprobe')}</dd>
        <dt>Discovered HW Encoders</dt>
        <dd>${escapeHtml(probed.filter(p => p.available).map(p => `${p.codec.toUpperCase()} (${p.encoder})`).join(', ') || 'Software only')}</dd>
      </dl>
    </div>
  </div>

  <div class="notice-box">
    <strong>Benchmark Reliability Notice:</strong> These results measure single-stream transcoding throughput and chunk latency on this machine. High single-stream throughput does not prove sustainable multi-viewer capacity under server load. Stage 2 will introduce multi-stream concurrency and endurance testing.
  </div>

  <!-- Performance Comparison Chart -->
  <section>
    <h2>Throughput Comparison (Real-Time Speed Multiplier)</h2>
    <div class="card" style="overflow-x: auto;">
      ${speedChartSvg || '<p style="color:var(--muted)">No successful benchmark results to display.</p>'}
    </div>
  </section>

  <!-- Results Table -->
  <section>
    <h2>Configuration Matrix & Performance Results</h2>
    
    <div class="filter-bar">
      <span style="font-size:12px;color:var(--muted);margin-right:6px;">Filter Codec:</span>
      <button class="filter-btn active" onclick="filterTable('all')">All</button>
      <button class="filter-btn" onclick="filterTable('av1')">AV1</button>
      <button class="filter-btn" onclick="filterTable('vp9')">VP9</button>
      <button class="filter-btn" onclick="filterTable('vp8')">VP8</button>
    </div>

    <div class="table-container">
      <table id="results-table">
        <thead>
          <tr>
            ${hasMultipleRuns ? '<th onclick="sortTable(0)">Run</th>' : ''}
            <th onclick="sortTable(${hasMultipleRuns ? 1 : 0})">Codec / Mode</th>
            <th onclick="sortTable(${hasMultipleRuns ? 2 : 1})">Encoder (Actual / Req)</th>
            <th onclick="sortTable(${hasMultipleRuns ? 3 : 2})">Target Quality</th>
            <th onclick="sortTable(${hasMultipleRuns ? 4 : 3})">Resolution</th>
            <th onclick="sortTable(${hasMultipleRuns ? 5 : 4})">Target Bitrate</th>
            <th onclick="sortTable(${hasMultipleRuns ? 6 : 5})">Actual Bitrate</th>
            <th onclick="sortTable(${hasMultipleRuns ? 7 : 6})">Speed Multiplier</th>
            <th onclick="sortTable(${hasMultipleRuns ? 8 : 7})">Effective FPS</th>
            <th onclick="sortTable(${hasMultipleRuns ? 9 : 8})">1st Chunk</th>
            <th onclick="sortTable(${hasMultipleRuns ? 10 : 9})">P95 Chunk</th>
            <th onclick="sortTable(${hasMultipleRuns ? 11 : 10})">Missed Deadlines</th>
            <th onclick="sortTable(${hasMultipleRuns ? 12 : 11})">Status</th>
            <th>Playable Output</th>
          </tr>
        </thead>
        <tbody>
          ${results.map(r => {
            const perf = r.performance || {};
            const q = r.quality || {};
            const speed = perf.speedMultiplier || 0;
            const speedClass = speed >= 1.2 ? 'success' : speed >= 1.0 ? 'warn' : 'error';
            const statusClass = r.status === 'pass' ? 'success' : r.status === 'fail' ? 'error' : 'warn';
            
            const allFallbacks = r.fallbackEvents || (r.fallback ? [r.fallback] : []);
            const fallbackSummary = allFallbacks.map(f => `${f.type || 'step'}: ${f.from}->${f.to} (${f.reason || ''})`).join('\n');
            const encoderText = allFallbacks.length > 0
              ? `${r.actualEncoder} <span class="pill warn" title="${escapeHtml(fallbackSummary)}">Fallback from ${r.requestedEncoder} (${allFallbacks.length})</span>`
              : `${r.actualEncoder || '-'} (${r.requestedEncoder})`;

            const outLink = r.output?.assembledFile
              ? `<a class="file-link" href="${escapeHtml(r.output.assembledFile)}" target="_blank">Play Output</a>`
              : '<span style="color:var(--muted)">None</span>';

            return `
              <tr data-codec="${escapeHtml(r.codec)}">
                ${hasMultipleRuns ? `<td><strong>#${r.runIndex || 1}</strong></td>` : ''}
                <td><strong>${escapeHtml(r.codec.toUpperCase())}</strong> <span style="color:var(--muted);font-size:11px;">(${escapeHtml(r.mode)})</span></td>
                <td>${encoderText}</td>
                <td>${escapeHtml(q.label || q.id)}</td>
                <td>${escapeHtml(q.width || '-')}x${escapeHtml(q.height || '-')}</td>
                <td>${escapeHtml(q.targetBitrateKbps || '-')} kbps</td>
                <td>${escapeHtml(perf.actualBitrateKbps || '-')} kbps</td>
                <td><span class="pill ${speedClass}"><strong>${speed.toFixed(2)}x</strong></span></td>
                <td>${escapeHtml(perf.effectiveFps || '-')} fps</td>
                <td>${perf.firstChunkDurationSec ? perf.firstChunkDurationSec.toFixed(2) + 's' : '-'}</td>
                <td>${perf.p95ChunkSec ? perf.p95ChunkSec.toFixed(2) + 's' : '-'}</td>
                <td>${perf.deadlineMisses > 0 ? `<span class="pill error">${perf.deadlineMisses}</span>` : '0'}</td>
                <td><span class="pill ${statusClass}">${escapeHtml(r.status.toUpperCase())}</span></td>
                <td>${outLink}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    </div>
  </section>

  <!-- Chunk Latency Charts for Chunked Runs -->
  ${chunkedRuns.length ? `
  <section>
    <h2>Chunk Completion Breakdown (6-Second Playback Windows)</h2>
    <div style="display:flex;gap:16px;flex-direction:column;">
      ${chunkedRuns.map(cr => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:8px;">
            <h3>${escapeHtml(cr.codec.toUpperCase())} ${escapeHtml(cr.actualEncoder)} &bull; ${escapeHtml(cr.quality?.label)} &bull; 1st Chunk: ${cr.performance?.firstChunkDurationSec}s &bull; Mean: ${cr.performance?.meanChunkSec}s &bull; P95: ${cr.performance?.p95ChunkSec}s</h3>
            <span class="pill ${cr.performance?.deadlineMisses > 0 ? 'error' : 'success'}">
              ${cr.performance?.deadlineMisses > 0 ? `${cr.performance.deadlineMisses} Deadline Misses` : 'Zero Missed Deadlines'}
            </span>
          </div>
          ${buildChunkLatencySvg(cr.output.chunks, 6)}
        </div>
      `).join('')}
    </div>
  </section>
  ` : ''}

  <!-- Synchronized Side-by-Side Video Inspection Workspace -->
  ${referenceVideoRel && passResults.length > 0 ? `
  <section>
    <h2>Synchronized Playback Inspection & Wipe Comparison</h2>
    <div class="player-workspace">
      <div class="selector-bar">
        <label for="target-selector" style="font-weight:600;font-size:13px;color:var(--text);">Select Output to Compare:</label>
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
          <div class="player-label">Source / Reference (${escapeHtml(src.fileName || 'Reference')})</div>
          <video id="player-ref" src="${escapeHtml(referenceVideoRel)}" playsinline preload="metadata"></video>
        </div>
        <div class="player-box">
          <div class="player-label" id="target-box-label">Transcoded Output: ${escapeHtml(firstPassResult.configId)}</div>
          <video id="player-target" src="${escapeHtml(firstTargetRel)}" playsinline preload="metadata"></video>
        </div>
      </div>

      <!-- Wipe View -->
      <div id="view-wipe" style="display:none;margin-bottom:14px;">
        <div class="wipe-container" id="wipe-stage">
          <video id="wipe-ref" class="wipe-video" src="${escapeHtml(referenceVideoRel)}" playsinline preload="metadata"></video>
          <div class="wipe-top-wrapper">
            <video id="wipe-target" class="wipe-video" src="${escapeHtml(firstTargetRel)}" playsinline preload="metadata"></video>
          </div>
          <div class="wipe-divider"></div>
          <input type="range" min="0" max="100" value="50" class="wipe-slider-input" id="wipe-range" oninput="updateWipe(this.value)">
        </div>
        <div style="text-align:center;font-size:12px;color:var(--muted);margin-top:8px;">
          Drag slider horizontally across the video frame to compare source (right) and encode (left).
        </div>
      </div>

      <!-- Unified Controls -->
      <div class="player-controls">
        <button class="player-btn" id="play-pause-btn" onclick="togglePlayPause()">Play</button>
        <input type="range" class="seek-slider" id="seek-bar" min="0" max="100" value="0" step="0.1" oninput="seekVideos(this.value)">
        <span class="time-readout" id="time-display">0:00 / 0:00</span>
      </div>
    </div>
  </section>
  ` : ''}

  <!-- Screenshots / Contact Sheet -->
  ${screenshots.length ? `
  <section>
    <h2>Visual Frame Inspection (Contact Sheet)</h2>
    <div class="screenshots-grid">
      ${screenshots.map(s => `
        <div class="screenshot-card">
          <img src="${escapeHtml(s.relativePath)}" alt="${escapeHtml(s.label)}" onclick="window.open('${escapeHtml(s.relativePath)}', '_blank')">
          <div class="screenshot-caption">
            <span><strong>${escapeHtml(s.label)}</strong></span>
            <span>${escapeHtml(s.timestampSeconds)}s</span>
          </div>
        </div>
      `).join('')}
    </div>
  </section>
  ` : ''}

  <!-- File Downloads & Raw Outputs -->
  <section>
    <h2>Artifacts & Machine-Readable Output Files</h2>
    <div class="card">
      <ul style="list-style:none;display:flex;flex-direction:column;gap:10px;">
        <li><strong>results.json:</strong> <a class="file-link" href="results.json" target="_blank">View Raw JSON (Schema v${SCHEMA_VERSION})</a></li>
        <li><strong>results.csv:</strong> <a class="file-link" href="results.csv" target="_blank">Download CSV Summary</a></li>
        ${referenceVideoRel ? `<li><strong>Reference Sample:</strong> <a class="file-link" href="${escapeHtml(referenceVideoRel)}" target="_blank">${escapeHtml(referenceVideoRel)}</a></li>` : ''}
      </ul>
    </div>
  </section>

  <script>
    // Filtering
    function filterTable(codec) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      const rows = document.querySelectorAll('#results-table tbody tr');
      rows.forEach(r => {
        if (codec === 'all' || r.getAttribute('data-codec') === codec) {
          r.style.display = '';
        } else {
          r.style.display = 'none';
        }
      });
    }

    // Sorting
    let sortAsc = true;
    function sortTable(colIndex) {
      const table = document.getElementById('results-table');
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      rows.sort((a, b) => {
        const aVal = a.cells[colIndex].textContent.trim();
        const bVal = b.cells[colIndex].textContent.trim();
        const aNum = parseFloat(aVal);
        const bNum = parseFloat(bVal);
        if (!isNaN(aNum) && !isNaN(bNum)) {
          return sortAsc ? aNum - bNum : bNum - aNum;
        }
        return sortAsc ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      });
      sortAsc = !sortAsc;
      rows.forEach(r => tbody.appendChild(r));
    }

    // Switch Target Video in Comparison Player
    function switchTargetVideo(fileRel) {
      const select = document.getElementById('target-selector');
      const opt = select ? select.options[select.selectedIndex] : null;
      const label = opt ? opt.getAttribute('data-label') : fileRel;
      const targetBoxLabel = document.getElementById('target-box-label');
      if (targetBoxLabel) targetBoxLabel.textContent = 'Transcoded Output: ' + label;
      
      const vT = document.getElementById('player-target');
      const wT = document.getElementById('wipe-target');
      if (vT) { vT.src = fileRel; vT.currentTime = 0; }
      if (wT) { wT.src = fileRel; wT.currentTime = 0; }
      const vR = document.getElementById('player-ref');
      const wR = document.getElementById('wipe-ref');
      if (vR) vR.currentTime = 0;
      if (wR) wR.currentTime = 0;
      const playBtn = document.getElementById('play-pause-btn');
      if (playBtn) playBtn.textContent = 'Play';
    }

    // Synchronized Player Controls
    const vRef = document.getElementById('player-ref');
    const vTarget = document.getElementById('player-target');
    const wRef = document.getElementById('wipe-ref');
    const wTarget = document.getElementById('wipe-target');
    const playBtn = document.getElementById('play-pause-btn');
    const seekBar = document.getElementById('seek-bar');
    const timeDisplay = document.getElementById('time-display');

    function allVideos() {
      return [vRef, vTarget, wRef, wTarget].filter(Boolean);
    }

    function togglePlayPause() {
      const vids = allVideos();
      if (!vids.length) return;
      const isPaused = vids[0].paused;
      vids.forEach(v => isPaused ? v.play().catch(() => {}) : v.pause());
      if (playBtn) playBtn.textContent = isPaused ? 'Pause' : 'Play';
    }

    function seekVideos(pct) {
      const vids = allVideos();
      if (!vids.length || !vids[0].duration) return;
      const targetTime = (pct / 100) * vids[0].duration;
      vids.forEach(v => { v.currentTime = targetTime; });
    }

    if (vRef) {
      vRef.addEventListener('timeupdate', () => {
        if (!vRef.duration) return;
        const pct = (vRef.currentTime / vRef.duration) * 100;
        if (seekBar) seekBar.value = pct;
        if (timeDisplay) {
          const cur = formatTime(vRef.currentTime);
          const dur = formatTime(vRef.duration);
          timeDisplay.textContent = cur + ' / ' + dur;
        }
      });
    }

    function formatTime(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    // Wipe Comparison
    function updateWipe(val) {
      const stage = document.getElementById('wipe-stage');
      if (stage) stage.style.setProperty('--wipe-pct', val + '%');
    }

    function togglePlayerView(view) {
      const side = document.getElementById('view-side-by-side');
      const wipe = document.getElementById('view-wipe');
      const btnSide = document.getElementById('btn-view-side');
      const btnWipe = document.getElementById('btn-view-wipe');
      if (view === 'side-by-side') {
        if (side) side.style.display = 'grid';
        if (wipe) wipe.style.display = 'none';
        btnSide?.classList.add('active');
        btnWipe?.classList.remove('active');
      } else {
        if (side) side.style.display = 'none';
        if (wipe) wipe.style.display = 'block';
        btnSide?.classList.remove('active');
        btnWipe?.classList.add('active');
      }
    }

    // Zoom Toggle
    let isZoomed = false;
    function toggleZoom() {
      isZoomed = !isZoomed;
      const boxes = document.querySelectorAll('.player-box video, .wipe-container video');
      boxes.forEach(v => v.classList.toggle('zoom-active', isZoomed));
      const btn = document.getElementById('btn-zoom');
      if (btn) btn.textContent = isZoomed ? 'Reset Zoom' : 'Zoom 2x';
    }
  </script>
</body>
</html>`;

  fs.writeFileSync(outputPath, html, 'utf8');
}

module.exports = {
  generateJsonReport,
  generateCsvReport,
  generateHtmlReport
};
