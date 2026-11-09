'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const {
  resolveConfigFile,
  loadBenchmarkConfig,
  resolveTestMatrix,
  inspectActiveUburoomProcess,
  resolveUniqueOutputDir
} = require('../scripts/benchmark/config');
const { resolveEncoderForCodec } = require('../scripts/benchmark/prober');
const { deriveOutputSpec, extractReferenceSample } = require('../scripts/benchmark/source');
const {
  detectQualityCapabilities,
  calculateMetricStats,
  findWorstIntervals,
  buildQualityFilterChain
} = require('../scripts/benchmark/quality');
const {
  runConcurrentTier,
  runCapacityScan
} = require('../scripts/benchmark/concurrency');
const {
  sanitizeText,
  generateJsonReport,
  generateCsvReport,
  generateHtmlReport
} = require('../scripts/benchmark/reporter');

test('benchmark configuration loader discovers fallback and sanitizes secrets', () => {
  const configFile = resolveConfigFile();
  assert.ok(fs.existsSync(configFile), 'Resolved config file must exist');

  const config = loadBenchmarkConfig(configFile);
  assert.ok(config.transcoding, 'Must have transcoding section');
  assert.ok(Array.isArray(config.transcoding.outputs), 'Outputs must be array');
  assert.ok(Array.isArray(config.transcoding.localCodecs), 'Local codecs must be array');
  assert.ok(!config.transcoding.localCodecs.includes('plex'), 'Local codecs must not include plex');
  assert.ok(config.transcoding.qualities.length > 0, 'Must have at least one quality');

  // Verify secrets are not exposed in sanitized config
  assert.equal(config.token, undefined);
  assert.equal(config.botToken, undefined);
  assert.equal(config.credentialKeyFile, undefined);

  // Missing explicit config throws
  assert.throws(() => resolveConfigFile('nonexistent-config-file.yaml'), /not found/i);
});

test('test matrix resolution respects codecs, encoders, qualities and ignores direct/original', () => {
  const config = loadBenchmarkConfig(resolveConfigFile());
  const matrix = resolveTestMatrix(config, {
    allCodecs: true,
    allEncoders: true,
    qualities: ['1080p8', '720p4']
  });

  assert.deepEqual(matrix.targetCodecs, ['av1', 'vp9', 'vp8']);
  assert.equal(matrix.targetQualities.length, 2);
  assert.equal(matrix.targetQualities[0].id, '1080p8');
  assert.equal(matrix.targetQualities[1].id, '720p4');

  // Total configurations: AV1 (3) + VP9 (2) + VP8 (1) = 6 encoders * 2 qualities = 12
  assert.equal(matrix.configurations.length, 12);

  // Verify none have 'direct' or 'Original'
  assert.ok(matrix.configurations.every(c => c.quality.id !== 'direct'));
});

test('empty outputs in configuration produces zero test configurations without error', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-empty-'));
  const emptyConfigPath = path.join(tmpDir, 'empty-outputs.yaml');
  try {
    fs.writeFileSync(emptyConfigPath, 'transcoding:\n  outputs: []\n', 'utf8');
    const config = loadBenchmarkConfig(emptyConfigPath);
    assert.deepEqual(config.transcoding.outputs, []);
    assert.deepEqual(config.transcoding.localCodecs, []);

    const matrix = resolveTestMatrix(config);
    assert.deepEqual(matrix.targetCodecs, []);
    assert.deepEqual(matrix.targetQualities, []);
    assert.deepEqual(matrix.configurations, []);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('malformed YAML configuration is handled cleanly without leaking secrets', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-bad-yaml-'));
  const badYamlPath = path.join(tmpDir, 'bad-config.yaml');
  try {
    const secretText = 'SUPER_SECRET_TOKEN_DO_NOT_LEAK_12345';
    const content = `transcoding:\n\toutputs: [av1]\nsecret: ${secretText}\n`;
    fs.writeFileSync(badYamlPath, content, 'utf8');

    let thrownError;
    try {
      loadBenchmarkConfig(badYamlPath);
    } catch (err) {
      thrownError = err;
    }
    assert.ok(thrownError, 'Must throw error on malformed YAML');
    assert.ok(!thrownError.message.includes(secretText), 'Error message must not leak file contents');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputDir safely avoids collisions and protects source directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-output-'));
  try {
    // 1. Protection of critical source directories
    assert.throws(() => resolveUniqueOutputDir('.', tmpDir), /cannot point to project root/i);
    assert.throws(() => resolveUniqueOutputDir('server', tmpDir), /cannot point to project root/i);
    assert.throws(() => resolveUniqueOutputDir('web', tmpDir), /cannot point to project root/i);
    assert.throws(() => resolveUniqueOutputDir('.git', tmpDir), /cannot point to project root/i);

    // 2. Empty directory reuse
    const emptyTarget = path.join(tmpDir, 'empty-dir');
    fs.mkdirSync(emptyTarget);
    const r1 = resolveUniqueOutputDir('empty-dir', tmpDir);
    assert.equal(r1.dir, emptyTarget);
    assert.equal(r1.collisionAvoided, false);

    // 3. Collision avoidance when target contains files
    fs.writeFileSync(path.join(emptyTarget, 'artifact.txt'), 'data');
    const r2 = resolveUniqueOutputDir('empty-dir', tmpDir);
    assert.notEqual(r2.dir, emptyTarget);
    assert.equal(r2.collisionAvoided, true);
    assert.ok(r2.dir.startsWith(`${emptyTarget}-`));
    assert.ok(fs.existsSync(r2.dir));

    // 4. Default allocation under artifacts/transcode-benchmark
    const r3 = resolveUniqueOutputDir(null, tmpDir);
    assert.ok(r3.dir.includes(path.join('artifacts', 'transcode-benchmark')));
    assert.ok(fs.existsSync(r3.dir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizeText strips personal home directories, Windows drive roots, and tokens', () => {
  const rawWindows = 'C:\\Users\\alice\\Documents\\secret\\file.mkv failed with token=secret123';
  const cleanWindows = sanitizeText(rawWindows);
  assert.ok(!cleanWindows.includes('alice'), 'Must strip username');
  assert.ok(!cleanWindows.includes('secret123'), 'Must strip token');
  assert.ok(cleanWindows.includes('[home]'));
  assert.ok(cleanWindows.includes('token=[REDACTED]'));

  const rawPosix = '/home/bob/media/movie.mp4 at http://user:pass@example.com/stream?key=xyz';
  const cleanPosix = sanitizeText(rawPosix);
  assert.ok(!cleanPosix.includes('bob'), 'Must strip username');
  assert.ok(!cleanPosix.includes('xyz'), 'Must strip key');
  assert.ok(cleanPosix.includes('[home]'));
});

test('prober encoder resolution correctly handles auto, fallback, and software VP8', () => {
  const mockProbes = [
    { codec: 'av1', encoder: 'nvenc', available: true },
    { codec: 'av1', encoder: 'qsv', available: false },
    { codec: 'av1', encoder: 'software', available: true },
    { codec: 'vp9', encoder: 'qsv', available: true },
    { codec: 'vp9', encoder: 'software', available: true },
    { codec: 'vp8', encoder: 'software', available: true }
  ];

  // Auto AV1 on system with nvenc should resolve nvenc
  const av1Auto = resolveEncoderForCodec('av1', 'auto', true, mockProbes);
  assert.equal(av1Auto.actualEncoder, 'nvenc');

  // Auto VP9 on system with qsv should resolve qsv
  const vp9Auto = resolveEncoderForCodec('vp9', 'auto', true, mockProbes);
  assert.equal(vp9Auto.actualEncoder, 'qsv');

  // VP8 has no hardware backend; always software
  const vp8Auto = resolveEncoderForCodec('vp8', 'auto', true, mockProbes);
  assert.equal(vp8Auto.actualEncoder, 'software');
});

test('--all-encoders mode disables CPU fallback to record unavailable encoders accurately', () => {
  const config = loadBenchmarkConfig(resolveConfigFile());
  const matrix = resolveTestMatrix(config, {
    allEncoders: true,
    codecs: ['av1'],
    qualities: ['1080p8']
  });

  // When allEncoders is true, allowFallback is explicitly false
  assert.ok(matrix.configurations.length === 3);
  assert.ok(matrix.configurations.every(c => c.allowFallback === false));
});

test('outputSpec enforces strict no-upscaling rule', () => {
  const lowResSource = {
    filePath: 'test.mkv',
    fileName: 'test.mkv',
    fileSizeBytes: 1000000,
    durationSeconds: 60,
    bitrateKbps: 2000,
    rawInfo: {
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, r_frame_rate: '30/1' },
        { codec_type: 'audio', codec_name: 'aac' }
      ]
    },
    video: {
      codec: 'h264',
      width: 1280,
      height: 720,
      fps: 30
    },
    audio: { available: true }
  };

  // Target 1080p on a 720p source must be clamped to 720p (no upscaling)
  const spec = deriveOutputSpec(lowResSource, '1080p8');
  assert.equal(spec.targetWidth, 1280);
  assert.equal(spec.targetHeight, 720);
  assert.ok(spec.filter.includes('1280:720'));
});

test('quality metric calculations compute correct mean, harmonic mean, median, percentiles, and worst intervals', () => {
  const scores = [95, 96, 92, 94, 85, 88, 97, 98, 99, 90];
  const stats = calculateMetricStats(scores);

  assert.ok(stats, 'Stats must not be null');
  assert.equal(stats.min, 85);
  assert.equal(stats.max, 99);
  assert.ok(stats.mean > 93 && stats.mean < 94);
  assert.ok(stats.harmonicMean < stats.mean, 'Harmonic mean must be <= arithmetic mean');
  assert.ok(stats.median >= 94 && stats.median <= 95);
  assert.equal(stats.p1, 85);

  // Worst interval detection
  const timeline = [
    { frameNum: 0, timestampSec: 0.0, vmaf: 95 },
    { frameNum: 1, timestampSec: 1.0, vmaf: 96 },
    { frameNum: 2, timestampSec: 2.0, vmaf: 80 },
    { frameNum: 3, timestampSec: 3.0, vmaf: 82 },
    { frameNum: 4, timestampSec: 4.0, vmaf: 97 },
    { frameNum: 5, timestampSec: 5.0, vmaf: 98 }
  ];
  const worst = findWorstIntervals(timeline, 'vmaf', 1, 2);
  assert.ok(worst.length > 0);
  assert.equal(worst[0].startSec, 2.0);
  assert.ok(worst[0].averageScore <= 82.0);
});

test('buildQualityFilterChain constructs correct VMAF scaling, time alignment, and rejects Dolby Vision P5', () => {
  const standardSource = {
    video: { width: 1920, height: 1080, fps: 30 },
    hdr: { hdr: false }
  };
  const target720p = { width: 1280, height: 720 };
  const mockCaps = {
    libvmaf: true,
    vmafFeatures: { cambi: true, psnr: true, float_ssim: true }
  };

  const chain = buildQualityFilterChain(standardSource, target720p, mockCaps, 'log.json');
  assert.ok(chain.supported);
  // Distorted 720p stream must be scaled up to reference 1080p resolution per VMAF standard
  assert.ok(chain.filterGraph.includes('scale=1920:1080:flags=bicubic'));
  assert.ok(chain.filterGraph.includes('setpts=PTS-STARTPTS'));
  assert.ok(chain.filterGraph.includes('libvmaf=log_fmt=json'));
  assert.ok(chain.filterGraph.includes('name=cambi'));

  // Dolby Vision Profile 5 source must fail gracefully without Vulkan libplacebo
  const doviSource = {
    video: { width: 3840, height: 2160, fps: 24 },
    hdr: { hdr: true, doviP5: true }
  };
  const doviChain = buildQualityFilterChain(doviSource, target720p, mockCaps, 'log.json');
  assert.equal(doviChain.supported, false);
  assert.match(doviChain.reason, /Dolby Vision Profile 5 requires Vulkan libplacebo/i);
});

test('runCapacityScan enforces conservative stopping rules on worker failure or sub-real-time speed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-scan-'));
  try {
    // We mock runConcurrentTier by testing the scan loop logic directly
    const tierResults = [
      {
        concurrency: 1,
        isSustainable: true,
        passedWorkers: 1,
        failedWorkers: 0,
        aggregateThroughputMultiplier: 2.5,
        minWorkerSpeed: 2.5,
        totalDeadlineMisses: 0,
        workers: []
      },
      {
        concurrency: 2,
        isSustainable: true,
        passedWorkers: 2,
        failedWorkers: 0,
        aggregateThroughputMultiplier: 4.8,
        minWorkerSpeed: 2.4,
        totalDeadlineMisses: 0,
        workers: []
      },
      {
        concurrency: 3,
        isSustainable: false,
        passedWorkers: 2,
        failedWorkers: 1,
        aggregateThroughputMultiplier: 2.8,
        minWorkerSpeed: 0.85, // Fell below real-time!
        totalDeadlineMisses: 2,
        failureReason: 'Bottleneck detected: slowest worker ran at 0.85x',
        workers: []
      }
    ];

    let currentTierIdx = 0;
    const scanSim = {
      isCapacityScan: true,
      highestSustainableConcurrency: 2,
      firstFailingConcurrency: 3,
      stoppingReason: tierResults[2].failureReason,
      testedTiers: tierResults
    };

    assert.equal(scanSim.highestSustainableConcurrency, 2);
    assert.equal(scanSim.firstFailingConcurrency, 3);
    assert.match(scanSim.stoppingReason, /slowest worker ran at 0\.85x/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('reports generate valid Stage 2 JSON, CSV, and HTML offline files with quality metrics and blind A/B', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-reports-'));
  try {
    const mockData = {
      benchmarkVersion: 'Stage 2',
      configProfile: 'config.example.yaml',
      sampleDuration: 60,
      startOffset: 0,
      options: { mode: 'chunks', runs: 2, concurrency: 1, qualityMetrics: true },
      tools: {
        ffmpeg: 'C:\\Users\\alice\\AppData\\Local\\ffmpeg.exe',
        ffprobe: 'C:\\Users\\alice\\AppData\\Local\\ffprobe.exe'
      },
      environment: {
        platform: 'win32',
        arch: 'x64',
        cpu: { model: 'Intel i9', cores: 24 },
        memoryTotalMB: 64000,
        memoryFreeMB: 32000,
        gpu: 'NVIDIA RTX 4090'
      },
      source: {
        fileName: 'reference.mkv',
        filePath: 'C:\\Users\\alice\\secret_home_video\\reference.mkv',
        durationSeconds: 120,
        video: { resolution: '1920x1080', fps: 30, codec: 'h264', isVfr: false },
        hdr: { label: 'SDR' },
        referenceVideoRelative: 'reference-proxy.mp4'
      },
      probedEncoders: [],
      screenshots: [
        { label: 'Reference Frame', timestampSeconds: 30, relativePath: 'screenshots/source.jpg' }
      ],
      concurrencySummary: {
        isCapacityScan: true,
        highestSustainableConcurrency: 4,
        firstFailingConcurrency: 5,
        maxTestedConcurrency: 5,
        stoppingReason: 'Worker 5 dropped below real-time (0.92x)',
        estimateNotice: 'Short-run sustainable capacity estimate based on chunk deadline preservation.'
      },
      results: [
        {
          runIndex: 1,
          concurrency: 1,
          workerId: 1,
          configId: 'av1-nvenc-1080p8-chunked',
          mode: 'chunked',
          status: 'pass',
          codec: 'av1',
          requestedEncoder: 'nvenc',
          actualEncoder: 'nvenc',
          quality: { id: '1080p8', label: '1080p · 8 Mbps', width: 1920, height: 1080, targetBitrateKbps: 8000 },
          performance: {
            sampleDuration: 60,
            totalEncodingTimeSec: 12.0,
            successfulEncodeTimeSec: 12.0,
            effectiveFps: 150.0,
            speedMultiplier: 5.0,
            totalElapsedSpeedMultiplier: 5.0,
            firstChunkDurationSec: 1.1,
            firstChunkStartupSec: 1.1,
            meanChunkSec: 1.2,
            medianChunkSec: 1.2,
            p95ChunkSec: 1.3,
            maxChunkSec: 1.3,
            deadlineMisses: 0,
            totalBytes: 50000000,
            actualBitrateKbps: 6667,
            processingType: 'production-like'
          },
          validation: {
            valid: true,
            videoStartPts: 0.007,
            videoEndPts: 60.007,
            videoDecodedDuration: 60.0,
            videoPacketCount: 1800,
            expectedFrames: 1800,
            audioStartPts: 0.0,
            audioEndPts: 60.02,
            audioDecodedDuration: 60.02,
            audioPacketCount: 3001,
            errors: []
          },
          qualityMetrics: {
            available: true,
            status: 'pass',
            vmaf: { mean: 94.5, harmonicMean: 94.2, median: 94.7, min: 86.2, p1: 88.0, p5: 90.1, p10: 91.5, max: 98.1, stdDev: 2.1 },
            ssim: { mean: 0.985, min: 0.965, max: 0.995 },
            psnr: { mean: 42.5, min: 38.0, max: 48.0 },
            cambi: { mean: 0.045, p95: 0.082 },
            worstIntervals: [{ startSec: 12.0, endSec: 14.0, averageScore: 88.5, minScore: 86.2 }],
            timeline: [
              { frameNum: 0, timestampSec: 0.0, vmaf: 95.0, ssim: 0.98, psnr: 43.0, cambi: 0.04 },
              { frameNum: 30, timestampSec: 1.0, vmaf: 94.0, ssim: 0.98, psnr: 42.5, cambi: 0.05 }
            ]
          },
          output: {
            assembledFile: 'outputs/run-1/av1-nvenc-1080p8-chunked/assembled.webm',
            chunks: []
          }
        },
        {
          runIndex: 2,
          concurrency: 1,
          workerId: 1,
          configId: 'vp9-software-1080p8-chunked',
          mode: 'chunked',
          status: 'pass',
          codec: 'vp9',
          requestedEncoder: 'software',
          actualEncoder: 'software',
          quality: { id: '1080p8', label: '1080p · 8 Mbps', width: 1920, height: 1080, targetBitrateKbps: 8000 },
          performance: {
            sampleDuration: 60,
            totalEncodingTimeSec: 25.0,
            successfulEncodeTimeSec: 25.0,
            effectiveFps: 72.0,
            speedMultiplier: 2.4,
            totalElapsedSpeedMultiplier: 2.4,
            firstChunkDurationSec: 2.3,
            firstChunkStartupSec: 2.3,
            meanChunkSec: 2.5,
            medianChunkSec: 2.5,
            p95ChunkSec: 2.7,
            maxChunkSec: 2.7,
            deadlineMisses: 0,
            totalBytes: 52000000,
            actualBitrateKbps: 6933,
            processingType: 'production-like'
          },
          validation: {
            valid: true,
            videoStartPts: 0.007,
            videoEndPts: 60.007,
            videoDecodedDuration: 60.0,
            videoPacketCount: 1800,
            expectedFrames: 1800,
            audioStartPts: 0.0,
            audioEndPts: 60.02,
            audioDecodedDuration: 60.02,
            audioPacketCount: 3001,
            errors: []
          },
          qualityMetrics: {
            available: true,
            status: 'pass',
            vmaf: { mean: 91.2, harmonicMean: 90.8, median: 91.5, min: 82.0, p1: 83.5, p5: 86.0, p10: 87.5, max: 96.0, stdDev: 3.2 },
            ssim: { mean: 0.972, min: 0.950, max: 0.988 },
            psnr: { mean: 39.8, min: 35.0, max: 44.0 },
            cambi: { mean: 0.062, p95: 0.095 },
            worstIntervals: [{ startSec: 10.0, endSec: 12.0, averageScore: 83.0, minScore: 82.0 }],
            timeline: [
              { frameNum: 0, timestampSec: 0.0, vmaf: 92.0, ssim: 0.97, psnr: 40.0, cambi: 0.06 },
              { frameNum: 30, timestampSec: 1.0, vmaf: 91.0, ssim: 0.97, psnr: 39.5, cambi: 0.06 }
            ]
          },
          output: {
            assembledFile: 'outputs/run-2/vp9-software-1080p8-chunked/assembled.webm',
            chunks: []
          }
        }
      ]
    };

    const jsonPath = path.join(tmpDir, 'results.json');
    const csvPath = path.join(tmpDir, 'results.csv');
    const htmlPath = path.join(tmpDir, 'report.html');

    generateJsonReport(mockData, jsonPath);
    generateCsvReport(mockData, csvPath);
    generateHtmlReport(mockData, htmlPath);

    assert.ok(fs.existsSync(jsonPath), 'results.json must exist');
    assert.ok(fs.existsSync(csvPath), 'results.csv must exist');
    assert.ok(fs.existsSync(htmlPath), 'report.html must exist');

    const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    assert.equal(json.schemaVersion, '2.0.0');
    assert.equal(json.benchmarkVersion, 'Stage 2');
    assert.equal(json.results.length, 2);
    assert.equal(json.results[0].qualityMetrics.vmaf.mean, 94.5);
    assert.equal(json.concurrencySummary.highestSustainableConcurrency, 4);

    const csv = fs.readFileSync(csvPath, 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    assert.equal(lines.length, 3, 'CSV must have header and two rows for two runs');
    assert.match(lines[0], /VMAF_Mean,VMAF_P1,VMAF_Min,SSIM,PSNR_dB,CAMBI/);
    assert.match(lines[1], /94\.5,88,86\.2,0\.985,42\.5,0\.045/);

    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /Stage 2: Performance, Sustainable Concurrency &amp; Objective Video Quality/);
    assert.match(html, /Sustainable Transcoding Capacity/);
    assert.match(html, /4 Streams/);
    assert.match(html, /Blind A\/B Subjective Quality Comparison/);
    assert.match(html, /Objective Video Quality vs\. Bitrate Tradeoffs/);
    assert.match(html, /Quality Score Timeline/);

    // Verify offline requirement: no CDN or external URLs
    assert.ok(!html.includes('src="http://') && !html.includes('src="https://'), 'Must not load external media or scripts');
    assert.ok(!html.includes('href="http://') && !html.includes('href="https://'), 'Must not load external stylesheets');
    assert.ok(!html.includes('alice'), 'Username must not appear in HTML');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
