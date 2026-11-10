'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const cp = require('node:child_process');

const {
  resolveConfigFile,
  loadBenchmarkConfig,
  resolveTestMatrix,
  inspectActiveUburoomProcess,
  resolveUniqueOutputDir,
} = require('../scripts/benchmark/config');
const { resolveEncoderForCodec } = require('../scripts/benchmark/prober');
const { deriveOutputSpec, extractReferenceSample } = require('../scripts/benchmark/source');
const {
  detectQualityCapabilities,
  calculateMetricStats,
  findWorstIntervals,
  buildQualityFilterChain,
  validateTemporalAlignment,
  runQualityAnalysis,
  parseFinalDecodedFrames,
} = require('../scripts/benchmark/quality');
const { spawnSafe, resolveTools } = require('../scripts/benchmark/tools');
const { runConcurrentTier, runCapacityScan } = require('../scripts/benchmark/concurrency');
const {
  sanitizeText,
  generateJsonReport,
  generateCsvReport,
  generateHtmlReport,
} = require('../scripts/benchmark/reporter');
const {
  TelemetryCollector,
  detectTelemetryProvider,
  parseMetricNumber,
  decodeNvidiaThrottleReasons,
} = require('../scripts/benchmark/telemetry');
const {
  computeFileContentFingerprint,
  deriveSourceFingerprint,
  saveRunToHistory,
  loadHistoryIndex,
  importHistoricalReport,
  deleteRunFromHistory,
  compareRuns,
} = require('../scripts/benchmark/history');
const { calculateP95, runStabilityBenchmark } = require('../scripts/benchmark/stability');
const { generateConfigurationRecommendations } = require('../scripts/benchmark/recommendations');

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
    qualities: ['1080p8', '720p4'],
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

    assert.ok(thrownError, 'Must throw on malformed YAML');
    assert.ok(!thrownError.message.includes(secretText), 'Error message must not leak YAML secret values');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputDir safely avoids collisions and protects source directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-outdir-'));
  try {
    // 1. Target directory already exists and has files -> must allocate a safe suffix
    const existingTarget = path.join(tmpDir, 'my-benchmark');
    fs.mkdirSync(existingTarget);
    fs.writeFileSync(path.join(existingTarget, 'previous-results.json'), '{}', 'utf8');

    const res1 = resolveUniqueOutputDir(existingTarget, tmpDir);
    assert.ok(res1.collisionAvoided, 'Must flag collision on non-empty directory');
    assert.equal(res1.dir, `${existingTarget}-1`, 'Must divert to -1 suffix');
    assert.ok(fs.existsSync(res1.dir), 'Allocated directory must exist');

    // 2. Reject attempts to target source roots
    assert.throws(() => resolveUniqueOutputDir(path.join(tmpDir, 'server'), tmpDir), /source directories/i);
    assert.throws(() => resolveUniqueOutputDir(path.join(tmpDir, 'web'), tmpDir), /source directories/i);
    assert.throws(() => resolveUniqueOutputDir(path.join(tmpDir, '.git'), tmpDir), /source directories/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputDir atomically claims unique directories under concurrent invocations', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-atomic-'));
  try {
    const target = path.join(tmpDir, 'concurrent-target');
    // Launch 10 simultaneous allocations for the exact same target directory
    const allocations = await Promise.all(
      Array.from({ length: 10 }, () => Promise.resolve().then(() => resolveUniqueOutputDir(target, tmpDir))),
    );

    const allocatedDirs = allocations.map(a => a.dir);
    const uniqueDirs = new Set(allocatedDirs);

    assert.equal(uniqueDirs.size, 10, 'All 10 concurrent allocations must yield unique directories');
    for (const d of allocatedDirs) {
      assert.ok(fs.existsSync(d), `Allocated directory ${d} must exist on disk`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizeText strips personal home directories, Windows drive roots, and tokens', () => {
  const rawWindows = 'Error at C:\\Users\\Administrator\\Desktop\\uburoom\\server\\av1.js with token=secret123';
  const cleanWindows = sanitizeText(rawWindows);
  assert.ok(!cleanWindows.includes('Administrator'), 'Must redact username');
  assert.ok(cleanWindows.includes('[home]'), 'Must replace with [home]');
  assert.ok(cleanWindows.includes('token=[REDACTED]'), 'Must redact token parameter');

  const rawLinux = 'Traceback in /home/alice/uburoom/server.js: key=superpass';
  const cleanLinux = sanitizeText(rawLinux);
  assert.ok(!cleanLinux.includes('alice'), 'Must redact linux username');
  assert.ok(cleanLinux.includes('key=[REDACTED]'), 'Must redact key parameter');
});

test('prober encoder resolution correctly handles auto, fallback, and software VP8', () => {
  const sampleProbed = [
    { codec: 'av1', encoder: 'qsv', available: true },
    { codec: 'av1', encoder: 'nvenc', available: false },
    { codec: 'av1', encoder: 'software', available: true },
    { codec: 'vp9', encoder: 'qsv', available: false },
    { codec: 'vp9', encoder: 'software', available: true },
    { codec: 'vp8', encoder: 'software', available: true },
  ];

  // Auto AV1 should pick QSV when available
  const av1Auto = resolveEncoderForCodec('av1', 'auto', sampleProbed, true);
  assert.equal(av1Auto.actualEncoder, 'qsv');

  // Hardware AV1 when hardware is unavailable falls back to software if cpuFallback=true
  const hardwareOnlyNoHw = [
    { codec: 'av1', encoder: 'qsv', available: false },
    { codec: 'av1', encoder: 'nvenc', available: false },
    { codec: 'av1', encoder: 'software', available: true },
  ];
  const av1HwFallback = resolveEncoderForCodec('av1', 'hardware', hardwareOnlyNoHw, true);
  assert.equal(av1HwFallback.actualEncoder, 'software');
  assert.equal(av1HwFallback.isFallback, true);

  // VP8 only has software
  const vp8Res = resolveEncoderForCodec('vp8', 'auto', sampleProbed, true);
  assert.equal(vp8Res.actualEncoder, 'software');
});

test('--all-encoders mode disables CPU fallback to record unavailable encoders accurately', () => {
  const config = loadBenchmarkConfig(resolveConfigFile());
  const matrix = resolveTestMatrix(config, {
    allEncoders: true,
    codecs: ['av1'],
    qualities: ['1080p8'],
  });

  const nvencConfig = matrix.configurations.find(c => c.requestedEncoder === 'nvenc');
  const qsvConfig = matrix.configurations.find(c => c.requestedEncoder === 'qsv');
  const swConfig = matrix.configurations.find(c => c.requestedEncoder === 'software');

  assert.ok(nvencConfig, 'Must have nvenc configuration');
  assert.ok(qsvConfig, 'Must have qsv configuration');
  assert.ok(swConfig, 'Must have software configuration');

  // allowFallback must be explicitly false for comparative encoder matrix
  assert.equal(nvencConfig.allowFallback, false);
  assert.equal(qsvConfig.allowFallback, false);
});

test('outputSpec enforces strict no-upscaling rule', () => {
  const smallSource = {
    video: {
      width: 1280,
      height: 720,
      fps: 30,
      codec: 'h264',
    },
    audio: { available: true },
    hdr: { hdr: false },
    rawInfo: { streams: [{ codec_type: 'video', width: 1280, height: 720 }] },
  };

  const spec1080p = deriveOutputSpec(smallSource, '1080p8');
  // Dimensions must remain 720p (no upscaling); targetBitrateKbps reflects requested quality target
  assert.equal(spec1080p.targetWidth, 1280);
  assert.equal(spec1080p.targetHeight, 720);
  assert.equal(spec1080p.targetBitrateKbps, 8000);
});

test('quality metric calculations compute correct mean, harmonic mean, median, percentiles, and worst intervals', () => {
  const scores = [100, 95, 90, 85, 80, 75, 70, 65, 60, 50];
  const stats = calculateMetricStats(scores);

  assert.ok(stats);
  assert.equal(stats.mean, 77.0);
  assert.equal(stats.min, 50.0);
  assert.equal(stats.max, 100.0);
  assert.ok(stats.harmonicMean < stats.mean, 'Harmonic mean penalizes low scores more heavily than arithmetic mean');
  assert.ok(stats.p1 <= stats.p5 && stats.p5 <= stats.p10);

  // Worst interval detection across 2-second windows (at 30 fps)
  const timeline = [];
  for (let f = 0; f < 180; f++) {
    // Dip quality between frames 60 and 90
    const score = f >= 60 && f <= 90 ? 40 : 95;
    timeline.push({ frameNum: f, timestampSec: f / 30, vmaf: score });
  }

  const worst = findWorstIntervals(timeline, 'vmaf', 30, 2);
  assert.ok(worst.length > 0);
  // Worst interval must cover the dip around 2.0s
  assert.ok(worst[0].startSec >= 1.0 && worst[0].startSec <= 3.0);
  assert.ok(worst[0].averageScore < 70);
});

test('buildQualityFilterChain constructs correct VMAF scaling, time alignment, and rejects Dolby Vision P5', () => {
  const standardSource = {
    video: { width: 1920, height: 1080, fps: 30 },
    hdr: { hdr: false },
  };
  const target720p = { width: 1280, height: 720 };
  const mockCaps = {
    libvmaf: true,
    vmafFeatures: { cambi: true, psnr: true, float_ssim: true },
  };

  const chain = buildQualityFilterChain(standardSource, target720p, mockCaps, 'log.json', ['vmaf', 'cambi']);
  assert.ok(chain.supported);
  assert.ok(chain.filterGraph.includes('scale=1920:1080:flags=bicubic'));
  assert.ok(chain.filterGraph.includes('setpts=PTS-STARTPTS'));
  assert.ok(chain.filterGraph.includes('libvmaf=log_fmt=json'));
  assert.ok(chain.filterGraph.includes('name=cambi'));
  assert.ok(!chain.filterGraph.includes('name=float_ssim'), 'Must omit unrequested float_ssim metric');

  // Dolby Vision Profile 5 source must fail gracefully without Vulkan libplacebo
  const doviSource = {
    video: { width: 3840, height: 2160, fps: 24 },
    hdr: { hdr: true, doviP5: true },
  };
  const doviChain = buildQualityFilterChain(doviSource, target720p, mockCaps, 'log.json');
  assert.equal(doviChain.supported, false);
  assert.match(doviChain.reason, /Dolby Vision Profile 5 requires Vulkan libplacebo/i);
});

test('buildQualityFilterChain builds dual standalone SSIM and PSNR when libvmaf is unavailable', () => {
  const source = { video: { width: 1920, height: 1080, fps: 30 }, hdr: { hdr: false } };
  const target = { width: 1920, height: 1080 };
  const caps = { libvmaf: false, ssim: true, psnr: true };

  const chain = buildQualityFilterChain(source, target, caps, 'log.json', ['ssim', 'psnr']);
  assert.ok(chain.supported);
  assert.equal(chain.usesLibvmaf, false);
  assert.ok(chain.filterGraph.includes('ssim=stats_file=ssim.log'));
  assert.ok(chain.filterGraph.includes('psnr=stats_file=psnr.log'));
  assert.ok(chain.filterGraph.includes('split=2'));
});

test('buildQualityFilterChain supports independent CAMBI selection and accurate unsupported reason', () => {
  const source = { video: { width: 1920, height: 1080, fps: 30 }, hdr: { hdr: false } };
  const target = { width: 1920, height: 1080 };

  // 1. CAMBI selected alone without VMAF: must use libvmaf with feature=name=cambi
  const capsWithCambi = {
    libvmaf: true,
    vmafFeatures: { cambi: true, psnr: true, float_ssim: true },
    ssim: true,
    psnr: true,
  };
  const cambiOnly = buildQualityFilterChain(source, target, capsWithCambi, 'quality-metrics.json', ['cambi']);
  assert.ok(cambiOnly.supported);
  assert.ok(cambiOnly.usesLibvmaf, 'CAMBI evaluation requires libvmaf filter');
  assert.ok(cambiOnly.filterGraph.includes('feature=name=cambi'));
  assert.ok(!cambiOnly.filterGraph.includes('name=psnr'));
  assert.ok(!cambiOnly.filterGraph.includes('name=float_ssim'));

  // 2. CAMBI requested but unsupported by build: must report accurate unavailable status
  const capsNoCambi = {
    libvmaf: true,
    vmafFeatures: { cambi: false },
    ssim: true,
    psnr: true,
  };
  const unsuppCambi = buildQualityFilterChain(source, target, capsNoCambi, 'quality-metrics.json', ['cambi']);
  assert.equal(unsuppCambi.supported, false);
  assert.match(unsuppCambi.reason, /CAMBI feature is not available/i);
});

test('spawnSafe promptly terminates running subprocess on abort signal', async () => {
  const controller = new AbortController();
  const startTime = Date.now();

  // Launch a real FFmpeg child process that would run for 30 seconds if not cancelled
  const promise = spawnSafe(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30',
      '-t',
      '30',
      '-f',
      'null',
      '-',
    ],
    {
      signal: controller.signal,
      timeout: 30000,
    },
  );

  // Trigger abort after a brief delay so the process is genuinely running
  setTimeout(() => controller.abort(), 60);

  let caughtError;
  try {
    await promise;
  } catch (err) {
    caughtError = err;
  }

  const elapsedMs = Date.now() - startTime;
  assert.ok(caughtError, 'Must reject on abort signal');
  assert.match(caughtError.message, /cancelled by abort signal/i);
  assert.ok(elapsedMs < 3000, `Process termination must be prompt (took ${elapsedMs}ms, expected < 3000ms)`);
});

test('validateTemporalAlignment detects start presentation delays and duration mismatches', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-temporal-'));
  try {
    // Generate a reference 2-second video at 30 fps
    const refFile = path.join(tmpDir, 'ref.mp4');
    const cp = require('child_process');
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        refFile,
      ],
      { windowsHide: true },
    );

    // Generate matching encode (start PTS ~ 0, duration 2s)
    const matchingFile = path.join(tmpDir, 'matching.webm');
    cp.execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', refFile, '-c:v', 'libvpx', matchingFile],
      { windowsHide: true },
    );

    // Validate matching
    const resMatching = validateTemporalAlignment('ffprobe', refFile, matchingFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30,
    });
    assert.equal(resMatching.status, 'verified');
    assert.ok(resMatching.encodedFirstPts <= 0.08);

    // Generate deliberately time-delayed encode (start PTS = 1.0s)
    const delayedFile = path.join(tmpDir, 'delayed.webm');
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        refFile,
        '-vf',
        'setpts=PTS-STARTPTS+1.0/TB',
        '-c:v',
        'libvpx',
        delayedFile,
      ],
      { windowsHide: true },
    );

    // Validate delayed
    const resDelayed = validateTemporalAlignment('ffprobe', refFile, delayedFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30,
    });
    assert.equal(resDelayed.status, 'misaligned');
    assert.match(resDelayed.reason, /presentation start delay/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runCapacityScan exercises real progression, stopping on sub-real-time speed', async () => {
  // Mock worker runner that simulates:
  // Tier 1: 1 worker at 2.5x speed (pass)
  // Tier 2: 2 workers at 2.2x speed (pass)
  // Tier 3: 3 workers, but worker 3 drops to 0.95x speed (fails 1.05x margin!)
  const mockWorker = async (tools, source, config, opts) => {
    const isTier3Worker3 = opts.concurrency === 3 && opts.workerId === 3;
    const speed = isTier3Worker3 ? 0.95 : 2.2;
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: {
        speedMultiplier: speed,
        deadlineMisses: 0,
        chunkP95DurationSec: 2.5,
      },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 5,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    minRealtimeMargin: 1.05,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.highestSustainableConcurrency, 2, 'Should sustain tier 2');
  assert.equal(scanResult.firstFailingConcurrency, 3, 'Should fail tier 3');
  assert.equal(scanResult.testedTiers.length, 3, 'Scan must stop immediately after tier 3 fails');
  assert.match(scanResult.stoppingReason, /below required 1\.05x real-time margin/);
});

test('runCapacityScan stops immediately when a worker fails transcode', async () => {
  const mockWorker = async (tools, source, config, opts) => {
    if (opts.concurrency === 2 && opts.workerId === 2) {
      throw new Error('GPU NVENC session allocation exhausted');
    }
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: { speedMultiplier: 2.0, deadlineMisses: 0, chunkP95DurationSec: 2.5 },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.highestSustainableConcurrency, 1);
  assert.equal(scanResult.firstFailingConcurrency, 2);
  assert.equal(scanResult.testedTiers.length, 2);
  assert.match(scanResult.stoppingReason, /GPU NVENC session allocation exhausted/);
});

test('runCapacityScan stops immediately when a worker misses a 6s chunk deadline', async () => {
  const mockWorker = async (tools, source, config, opts) => {
    const misses = opts.concurrency === 2 && opts.workerId === 1 ? 1 : 0;
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: { speedMultiplier: 1.2, deadlineMisses: misses, chunkP95DurationSec: 4.0 },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.highestSustainableConcurrency, 1);
  assert.equal(scanResult.firstFailingConcurrency, 2);
  assert.match(scanResult.stoppingReason, /1 chunk deadline\(s\) missed/);
});

test('runCapacityScan stops immediately when P95 chunk latency exceeds threshold', async () => {
  const mockWorker = async (tools, source, config, opts) => {
    // P95 latency is 5.4s on tier 2, exceeding 5.1s threshold
    const p95 = opts.concurrency === 2 ? 5.4 : 3.0;
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: { speedMultiplier: 1.2, deadlineMisses: 0, chunkP95DurationSec: p95 },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    maxChunkP95ThresholdSec: 5.1,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.highestSustainableConcurrency, 1);
  assert.equal(scanResult.firstFailingConcurrency, 2);
  assert.match(scanResult.stoppingReason, /P95 chunk latency \(5\.40s\) exceeded 5\.10s threshold/);
});

test('runCapacityScan stops when hardware encoder falls back to software', async () => {
  const mockWorker = async (tools, source, config, opts) => {
    // Worker falls back to software on tier 1
    return {
      status: 'pass',
      actualEncoder: 'software',
      fallback: { from: 'nvenc', to: 'software' },
      performance: { speedMultiplier: 1.5, deadlineMisses: 0, chunkP95DurationSec: 3.0 },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 3,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.highestSustainableConcurrency, 0);
  assert.equal(scanResult.firstFailingConcurrency, 1);
  assert.match(scanResult.stoppingReason, /fell back to software encoding/);
});

test('runCapacityScan terminates early when AbortSignal is triggered', async () => {
  const controller = new AbortController();
  const mockWorker = async (tools, source, config, opts) => {
    if (opts.concurrency === 1) {
      controller.abort(); // Cancel during tier 1
    }
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: { speedMultiplier: 2.0, deadlineMisses: 0, chunkP95DurationSec: 2.0 },
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    signal: controller.signal,
    workerRunner: mockWorker,
  });

  assert.equal(scanResult.testedTiers.length, 1);
  assert.match(scanResult.stoppingReason, /cancelled by operator/i);
});

test('repeated concurrent trials produce completely isolated artifact directories without collision', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-repeat-'));
  try {
    const writtenFiles = [];
    const mockWorker = async (tools, source, config, opts) => {
      // Simulate writing chunk files to the resolved output directory
      const workerDir = path.join(
        opts.outputDir,
        'outputs',
        `concurrency-${opts.concurrency}`,
        `run-${opts.runIndex}`,
        `worker-${opts.workerId}`,
        config.id,
      );
      fs.mkdirSync(workerDir, { recursive: true });
      const testFile = path.join(workerDir, 'assembled.webm');
      fs.writeFileSync(testFile, `Trial data run=${opts.runIndex} worker=${opts.workerId}`, 'utf8');
      writtenFiles.push(testFile);
      return {
        status: 'pass',
        runIndex: opts.runIndex,
        workerId: opts.workerId,
        concurrency: opts.concurrency,
        output: { assembledFile: path.relative(opts.outputDir, testFile) },
        performance: { speedMultiplier: 2.0, deadlineMisses: 0 },
      };
    };

    // Run trial 1
    const trial1 = await runConcurrentTier({
      concurrency: 2,
      runIndex: 1,
      outputDir: tmpDir,
      testConfig: { id: 'test-config', codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
      workerRunner: mockWorker,
    });

    // Run trial 2
    const trial2 = await runConcurrentTier({
      concurrency: 2,
      runIndex: 2,
      outputDir: tmpDir,
      testConfig: { id: 'test-config', codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
      workerRunner: mockWorker,
    });

    assert.equal(writtenFiles.length, 4, 'Must write 4 distinct files across 2 trials');
    // Ensure all 4 paths are unique
    const uniquePaths = new Set(writtenFiles);
    assert.equal(uniquePaths.size, 4, 'All 4 files must have unique paths');

    // Verify file contents were not overwritten
    const f1 = fs.readFileSync(writtenFiles[0], 'utf8');
    const f2 = fs.readFileSync(writtenFiles[1], 'utf8');
    const f3 = fs.readFileSync(writtenFiles[2], 'utf8');
    const f4 = fs.readFileSync(writtenFiles[3], 'utf8');
    assert.match(f1, /run=1 worker=1/);
    assert.match(f2, /run=1 worker=2/);
    assert.match(f3, /run=2 worker=1/);
    assert.match(f4, /run=2 worker=2/);
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
        ffprobe: 'C:\\Users\\alice\\AppData\\Local\\ffprobe.exe',
      },
      environment: {
        platform: 'win32',
        arch: 'x64',
        cpu: { model: 'Intel i9', cores: 24 },
        memoryTotalMB: 64000,
        memoryFreeMB: 32000,
        gpu: 'NVIDIA RTX 4090',
      },
      source: {
        fileName: 'reference.mkv',
        filePath: 'C:\\Users\\alice\\secret_home_video\\reference.mkv',
        durationSeconds: 120,
        video: { resolution: '1920x1080', fps: 30, codec: 'h264', isVfr: false },
        hdr: { label: 'SDR' },
        referenceVideoRelative: 'reference-proxy.mp4',
      },
      probedEncoders: [],
      screenshots: [{ label: 'Reference Frame', timestampSeconds: 30, relativePath: 'screenshots/source.jpg' }],
      concurrencySummary: {
        isCapacityScan: true,
        highestSustainableConcurrency: 4,
        firstFailingConcurrency: 5,
        maxTestedConcurrency: 5,
        stoppingReason: 'Worker 5 dropped below real-time (0.92x)',
        estimateNotice: 'Short-run capacity estimate based on chunk deadline preservation.',
      },
      results: [
        {
          runIndex: 1,
          tierIndex: null,
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
            processingType: 'production-like',
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
            errors: [],
          },
          qualityMetrics: {
            available: true,
            status: 'pass',
            vmaf: {
              mean: 94.5,
              harmonicMean: 94.2,
              median: 94.7,
              min: 86.2,
              p1: 88.0,
              p5: 90.1,
              p10: 91.5,
              max: 98.1,
              stdDev: 2.1,
            },
            ssim: { mean: 0.985, min: 0.965, max: 0.995 },
            psnr: { mean: 42.5, min: 38.0, max: 48.0 },
            cambi: { mean: 0.045, p95: 0.082 },
            worstIntervals: [{ startSec: 12.0, endSec: 14.0, averageScore: 88.5, minScore: 86.2 }],
            timeline: [
              { frameNum: 0, timestampSec: 0.0, vmaf: 95.0, ssim: 0.98, psnr: 43.0, cambi: 0.04 },
              { frameNum: 30, timestampSec: 1.0, vmaf: 94.0, ssim: 0.98, psnr: 42.5, cambi: 0.05 },
            ],
          },
          output: {
            assembledFile: 'outputs/run-1/av1-nvenc-1080p8-chunked/assembled.webm',
            chunks: [],
          },
        },
        {
          runIndex: 2,
          tierIndex: null,
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
            processingType: 'production-like',
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
            errors: [],
          },
          qualityMetrics: {
            available: true,
            status: 'pass',
            vmaf: {
              mean: 91.2,
              harmonicMean: 90.8,
              median: 91.5,
              min: 82.0,
              p1: 83.5,
              p5: 86.0,
              p10: 87.5,
              max: 96.0,
              stdDev: 3.2,
            },
            ssim: { mean: 0.972, min: 0.95, max: 0.988 },
            psnr: { mean: 39.8, min: 35.0, max: 44.0 },
            cambi: { mean: 0.062, p95: 0.095 },
            worstIntervals: [{ startSec: 10.0, endSec: 12.0, averageScore: 83.0, minScore: 82.0 }],
            timeline: [
              { frameNum: 0, timestampSec: 0.0, vmaf: 92.0, ssim: 0.97, psnr: 40.0, cambi: 0.06 },
              { frameNum: 30, timestampSec: 1.0, vmaf: 91.0, ssim: 0.97, psnr: 39.5, cambi: 0.06 },
            ],
          },
          output: {
            assembledFile: 'outputs/run-2/vp9-software-1080p8-chunked/assembled.webm',
            chunks: [],
          },
        },
      ],
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
    assert.equal(json.schemaVersion, '3.0.0');
    assert.equal(json.benchmarkVersion, 'Stage 2');
    assert.equal(json.results.length, 2);
    assert.equal(json.results[0].qualityMetrics.vmaf.mean, 94.5);
    assert.equal(json.concurrencySummary.highestSustainableConcurrency, 4);

    const csv = fs.readFileSync(csvPath, 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    assert.equal(lines.length, 3, 'CSV must have header and two rows for two runs');
    assert.match(lines[0], /Run,Tier,Concurrency,WorkerId/);
    assert.match(lines[0], /VMAF_Mean,VMAF_P1,VMAF_Min,SSIM,PSNR_dB,CAMBI/);
    assert.match(lines[1], /94\.5,88,86\.2,0\.985,42\.5,0\.045/);

    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /Stage 3: Telemetry, Stability Trends, Historical Regressions &amp; Recommendations/);
    assert.match(html, /Sustainable Transcoding Capacity/);
    assert.match(html, /4 Streams/);
    assert.match(html, /Blind A\/B Subjective Quality Comparison/);
    assert.match(html, /5-Level Scale/);
    assert.match(html, /Strongly Prefer A/);
    assert.match(html, /Objective Video Quality vs\. Bitrate Tradeoffs/);
    assert.match(html, /Quality Score Timeline/);

    // Verify offline requirement: no CDN or external URLs
    assert.ok(
      !html.includes('src="http://') && !html.includes('src="https://'),
      'Must not load external media or scripts',
    );
    assert.ok(
      !html.includes('href="http://') && !html.includes('href="https://'),
      'Must not load external stylesheets',
    );
    assert.ok(!html.includes('alice'), 'Username must not appear in HTML');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildQualityFilterChain handles partial metric availability cleanly without suppressing supported metrics', () => {
  const source = { video: { width: 1920, height: 1080, fps: 30 }, hdr: { hdr: false } };
  const target = { width: 1920, height: 1080 };

  // 1. libvmaf available, but CAMBI unavailable: must compute VMAF, SSIM, PSNR and mark CAMBI unavailable
  const capsNoCambi = {
    libvmaf: true,
    vmafFeatures: { cambi: false, psnr: true, float_ssim: true },
    ssim: true,
    psnr: true,
  };
  const chain1 = buildQualityFilterChain(source, target, capsNoCambi, 'test.json', ['vmaf', 'ssim', 'psnr', 'cambi']);
  assert.ok(chain1.supported, 'Should remain supported for VMAF/SSIM/PSNR');
  assert.ok(chain1.usesLibvmaf);
  assert.equal(chain1.activeMetrics.length, 3);
  assert.ok(!chain1.activeMetrics.includes('cambi'));
  assert.equal(chain1.unavailableMetrics.length, 1);
  assert.equal(chain1.unavailableMetrics[0].metric, 'cambi');

  // 2. libvmaf unavailable: must fall back to standalone SSIM and PSNR
  const capsNoVmaf = {
    libvmaf: false,
    ssim: true,
    psnr: true,
  };
  const chain2 = buildQualityFilterChain(source, target, capsNoVmaf, 'test.json', ['vmaf', 'ssim', 'psnr', 'cambi']);
  assert.ok(chain2.supported, 'Should remain supported for standalone SSIM/PSNR');
  assert.ok(!chain2.usesLibvmaf);
  assert.deepEqual(chain2.activeMetrics, ['ssim', 'psnr']);
  assert.equal(chain2.unavailableMetrics.length, 2);
  assert.ok(chain2.unavailableMetrics.some(u => u.metric === 'vmaf'));
  assert.ok(chain2.unavailableMetrics.some(u => u.metric === 'cambi'));
  assert.ok(chain2.filterGraph.includes('split=2'));

  // 3. All selected metrics unavailable: returns supported: false with individual reasons
  const capsNone = { libvmaf: false, ssim: false, psnr: false };
  const chain3 = buildQualityFilterChain(source, target, capsNone, 'test.json', ['vmaf', 'cambi']);
  assert.equal(chain3.supported, false);
  assert.equal(chain3.unavailableMetrics.length, 2);
});

test('validateTemporalAlignment rejects deliberately content-shifted encode despite matching duration and frame counts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-content-shift-'));
  const cameraSample = path.join(__dirname, 'fixtures', 'camera-sample.mp4');

  if (!fs.existsSync(cameraSample)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return; // Skip if fixture not generated
  }

  try {
    const cp = require('child_process');
    // Encode segment A: from startOffset 0.0s for 0.8s
    const fileA = path.join(tmpDir, 'encode-a.webm');
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '0.0',
        '-t',
        '0.8',
        '-i',
        cameraSample,
        '-c:v',
        'libvpx',
        fileA,
      ],
      { windowsHide: true },
    );

    // Encode segment B: from startOffset 1.0s for 0.8s (content shifted by 1 second)
    const fileB = path.join(tmpDir, 'encode-b.webm');
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '1.0',
        '-t',
        '0.8',
        '-i',
        cameraSample,
        '-c:v',
        'libvpx',
        fileB,
      ],
      { windowsHide: true },
    );

    // 1. Matching validation: segment A compared against source at startOffset 0.0
    const resMatching = validateTemporalAlignment('ffprobe', cameraSample, fileA, {
      startOffset: 0.0,
      sampleDuration: 0.8,
      fps: 24,
      ffmpegPath: 'ffmpeg',
    });
    assert.equal(resMatching.status, 'verified', 'Matching segment must be verified');

    // 2. Deliberately shifted comparison: segment B compared against source at startOffset 0.0
    // Segment B has 0.8s duration and starts at PTS 0, but content is from 1.0s!
    const resShifted = validateTemporalAlignment('ffprobe', cameraSample, fileB, {
      startOffset: 0.0,
      sampleDuration: 0.8,
      fps: 24,
      ffmpegPath: 'ffmpeg',
    });
    assert.equal(resShifted.status, 'misaligned', 'Content-shifted encode must be flagged misaligned');
    assert.match(resShifted.reason, /Content correspondence check failed/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateTemporalAlignment verifies exact source interval with B-frames and non-keyframe start offset', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-nonkey-'));
  const cameraSample = path.join(__dirname, 'fixtures', 'camera-sample.mp4');

  if (!fs.existsSync(cameraSample)) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  try {
    const cp = require('child_process');
    // Start at non-keyframe offset 0.5s in 24fps video with B-frames for 1.0s
    const matchingFile = path.join(tmpDir, 'nonkey-encode.webm');
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        '0.5',
        '-t',
        '1.0',
        '-i',
        cameraSample,
        '-c:v',
        'libvpx',
        matchingFile,
      ],
      { windowsHide: true },
    );

    const res = validateTemporalAlignment('ffprobe', cameraSample, matchingFile, {
      startOffset: 0.5,
      sampleDuration: 1.0,
      fps: 24,
      ffmpegPath: 'ffmpeg',
    });

    assert.equal(res.status, 'verified', 'Non-keyframe start offset on B-frame clip must be verified');
    assert.ok(res.encodedFirstPts <= 0.08);
    assert.ok(Math.abs(res.encodedDuration - 1.0) <= 0.25);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('TelemetryCollector tracks lifecycle phases, strictly isolates encoding metrics, and detects thermal climb', () => {
  const collector = new TelemetryCollector({ provider: 'system', intervalMs: 1000 });
  assert.equal(collector.phase, 'idle_baseline');

  // Push sample into idle_baseline
  collector.recordSample({
    gpuUtilization: 5,
    encoderUtilization: 0,
    temperatureC: 42,
    powerWatts: 30,
    throttling: false,
    throttleReasons: [],
  });

  // Switch to warmup
  collector.setPhase('warmup');
  collector.recordSample({
    gpuUtilization: 40,
    encoderUtilization: 35,
    temperatureC: 46,
    powerWatts: 60,
    throttling: false,
    throttleReasons: [],
  });

  // Switch to encoding (measurements must isolate to this phase)
  collector.setPhase('encoding');
  collector.recordSample({
    gpuUtilization: 75,
    encoderUtilization: 65,
    temperatureC: 50,
    powerWatts: 120,
    throttling: false,
    throttleReasons: [],
  });
  collector.recordSample({
    gpuUtilization: 85,
    encoderUtilization: 75,
    temperatureC: 56,
    powerWatts: 140,
    throttling: true,
    throttleReasons: ['thermal_slowdown'],
  });

  // Switch to quality analysis (should NOT distort encoding phase thermal climb or utilization)
  collector.setPhase('quality_analysis');
  collector.recordSample({
    gpuUtilization: 10,
    encoderUtilization: 0,
    temperatureC: 68, // higher temp during CPU quality analysis
    powerWatts: 50,
    throttling: false,
    throttleReasons: [],
  });

  const summary = collector.getSummary();
  assert.ok(summary.encoding, 'Must have encoding phase summary');
  assert.equal(summary.encoding.sampleCount, 2, 'Encoding phase must contain exactly 2 samples');
  assert.equal(summary.encoding.metrics.encoderUtilization.mean, 70);
  assert.equal(summary.encoding.metrics.temperatureC.min, 50);
  assert.equal(summary.encoding.metrics.temperatureC.max, 56);
  assert.equal(summary.encoding.thermalClimbC, 6, 'Thermal climb in encoding phase must be 56 - 50 = 6C');
  assert.equal(summary.encoding.throttlingDetected, true, 'Throttling must be detected');
  assert.deepEqual(summary.encoding.activeThrottleReasons, ['thermal_slowdown']);

  // Quality analysis phase must be isolated
  assert.ok(summary.qualityAnalysis, 'Must have quality_analysis phase summary');
  assert.equal(summary.qualityAnalysis.sampleCount, 1);
  assert.equal(summary.qualityAnalysis.metrics.temperatureC.mean, 68);
});

test('detectTelemetryProvider probes host capabilities returning standard provider schema', () => {
  const provider = detectTelemetryProvider();
  assert.ok(provider, 'Provider must not be null');
  assert.ok(['nvidia-smi', 'windows-pdh', 'system'].includes(provider.provider));
  assert.ok(typeof provider.displayName === 'string' && provider.displayName.length > 0);
  assert.equal(provider.available, true);
});

test('history management derives fingerprints, saves runs, updates index, and safely deletes', () => {
  const tmpHistoryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-history-'));

  try {
    const mockSource = {
      fileName: 'test-source.mkv',
      durationSeconds: 120,
      video: { resolution: '1920x1080', fps: 24, codec: 'hevc' },
    };
    const fingerprint = deriveSourceFingerprint(mockSource);
    assert.ok(fingerprint, 'Fingerprint must be generated');
    assert.ok(
      fingerprint.startsWith('unverified:') || fingerprint.startsWith('v1:'),
      'Fingerprint must follow versioned scheme',
    );
    assert.equal(fingerprint, deriveSourceFingerprint(mockSource), 'Fingerprint must be deterministic');

    const mockPayload = {
      benchmarkVersion: 'Stage 3',
      source: mockSource,
      sampleDuration: 60,
      startOffset: 0,
      environment: { gpu: 'Test GPU RTX', cpu: 'Test CPU' },
      concurrencySummary: null,
      results: [
        {
          configId: 'av1-1080p8-chunks',
          codec: 'av1',
          requestedEncoder: 'nvenc',
          actualEncoder: 'nvenc',
          quality: { id: '1080p8', label: '1080p 8Mbps', width: 1920, height: 1080, bitrate: 8 },
          mode: 'chunks',
          status: 'pass',
          concurrency: 1,
          performance: {
            speedMultiplier: 2.45,
            effectiveFps: 58.8,
            totalEncodingTimeSec: 24.5,
            firstChunkDurationSec: 2.1,
            p95ChunkSec: 2.3,
            deadlineMisses: 0,
          },
        },
      ],
    };

    // 1. Save run to history
    const savedRecord = saveRunToHistory(mockPayload, tmpHistoryDir);
    assert.ok(savedRecord.runId, 'Must generate runId');
    assert.equal(savedRecord.sourceFingerprint, fingerprint);
    assert.equal(savedRecord.results[0].speedRatio, 2.45);

    // 2. Load history index
    const index = loadHistoryIndex(tmpHistoryDir);
    assert.equal(index.schemaVersion, '3.0.0');
    assert.equal(index.runs.length, 1);
    assert.equal(index.runs[0].runId, savedRecord.runId);

    // 3. Delete run from history
    deleteRunFromHistory(savedRecord.runId, tmpHistoryDir);
    const indexAfter = loadHistoryIndex(tmpHistoryDir);
    assert.equal(indexAfter.runs.length, 0, 'Index must be empty after deletion');
    assert.ok(!fs.existsSync(path.join(tmpHistoryDir, `${savedRecord.runId}.json`)), 'Record file must be deleted');
  } finally {
    fs.rmSync(tmpHistoryDir, { recursive: true, force: true });
  }
});

test('compareRuns produces matched regression/improvement classifications and flags differing conditions', () => {
  const sourceFp = 'v1:11223344556677889900aabbccddeeff';

  const baselineRun = {
    runId: 'base-01',
    timestamp: '2026-11-01T00:00:00Z',
    sourceFingerprint: sourceFp,
    sampleDuration: 60,
    startOffset: 0,
    environment: { gpu: 'Test GPU', cpu: 'Test CPU' },
    results: [
      {
        configId: 'av1-1080p-nvenc',
        codec: 'av1',
        qualityId: '1080p',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 2.0,
        p95ChunkLatencySeconds: 2.5,
        qualityMetrics: { vmaf: 92.0 },
      },
      {
        configId: 'vp9-720p-nvenc',
        codec: 'vp9',
        qualityId: '720p',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.0,
        p95ChunkLatencySeconds: 1.8,
        qualityMetrics: { vmaf: 88.0 },
      },
    ],
  };

  const currentRun = {
    runId: 'curr-02',
    timestamp: '2026-11-09T00:00:00Z',
    sourceFingerprint: sourceFp,
    sampleDuration: 60,
    startOffset: 0,
    environment: { gpu: 'Test GPU', cpu: 'Test CPU' },
    results: [
      // 1. Matched regression: 2.0x -> 1.6x (-20%)
      {
        configId: 'av1-1080p-nvenc',
        codec: 'av1',
        qualityId: '1080p',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 1.6,
        p95ChunkLatencySeconds: 3.1,
        qualityMetrics: { vmaf: 91.5 },
      },
      // 2. Matched improvement: 3.0x -> 3.6x (+20%)
      {
        configId: 'vp9-720p-nvenc',
        codec: 'vp9',
        qualityId: '720p',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.6,
        p95ChunkLatencySeconds: 1.5,
        qualityMetrics: { vmaf: 88.5 },
      },
      // 3. Different concurrency -> partially matched
      {
        configId: 'vp9-720p-nvenc-c4',
        codec: 'vp9',
        qualityId: '720p',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 4,
        speedRatio: 5.2,
        p95ChunkLatencySeconds: 3.2,
      },
    ],
  };

  const comp = compareRuns(baselineRun, currentRun);
  assert.equal(comp.matchedComparisons.length, 2);

  const regMatch = comp.matchedComparisons.find(m => m.codec === 'av1');
  assert.ok(regMatch);
  assert.equal(regMatch.classification, 'regression');
  assert.equal(regMatch.speedDeltaPercent, -20);
  assert.equal(regMatch.vmafDelta, -0.5);

  const impMatch = comp.matchedComparisons.find(m => m.codec === 'vp9');
  assert.ok(impMatch);
  assert.equal(impMatch.classification, 'improvement');
  assert.equal(impMatch.speedDeltaPercent, 20);

  assert.equal(comp.partiallyMatchedComparisons.length, 1);
  assert.ok(comp.partiallyMatchedComparisons[0].differingConditions.some(c => c.includes('concurrency')));
});

test('generateConfigurationRecommendations produces conservative advice adhering to server/config.js schema', () => {
  const currentConfig = {
    transcoding: {
      encoder: 'auto',
      maxJobs: 2,
      outputs: ['plex'],
      hardwareDecode: true,
      cpuFallback: true,
    },
  };

  const benchmarkPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'real-feature.mkv' },
    results: [
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8', label: '1080p 8Mbps' },
        performance: { speedMultiplier: 2.2, effectiveFps: 66.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 94.0 } },
        fallbackEvents: [],
      },
      {
        runIndex: 2,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8', label: '1080p 8Mbps' },
        performance: { speedMultiplier: 2.4, effectiveFps: 72.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 94.5 } },
        fallbackEvents: [],
      },
    ],
    concurrencySummary: {
      highestSustainableConcurrency: 4,
      totalTrials: 4,
      passedTrials: 4,
    },
  };

  const advice = generateConfigurationRecommendations(benchmarkPayload, currentConfig);
  assert.ok(advice.recommendations.length >= 2);

  // 1. Encoder recommended
  const encRec = advice.recommendations.find(r => r.setting === 'transcoding.encoder');
  assert.ok(encRec);
  assert.equal(encRec.recommendedValue, 'nvenc');
  assert.equal(encRec.confidence, 'high');

  // 2. Max jobs recommended with 1-job conservative headroom (4 tested -> 3 recommended)
  const jobRec = advice.recommendations.find(r => r.setting === 'transcoding.max_jobs');
  assert.ok(jobRec);
  assert.equal(jobRec.recommendedValue, 3);

  // 3. Outputs recommended (AV1 added)
  const outRec = advice.recommendations.find(r => r.setting === 'transcoding.outputs');
  assert.ok(outRec);
  assert.ok(outRec.recommendedValue.includes('av1'));

  // 4. YAML snippet valid
  assert.ok(advice.yamlSnippet);
  assert.match(advice.yamlSnippet, /encoder: 'nvenc'/);
  assert.match(advice.yamlSnippet, /max_jobs: 3/);
  assert.match(advice.yamlSnippet, /- 'av1'/);
  assert.ok(advice.operatorNotice.includes('never automatically alters'));
});

test('decodeNvidiaThrottleReasons correctly classifies idle, active throttle bitmasks, and unavailable sensors', () => {
  // Idle GPU: normal idle clock state (0x01) or explicit None
  const idleHex = decodeNvidiaThrottleReasons('0x0000000000000001');
  assert.equal(idleHex.isSupported, true);
  assert.equal(idleHex.isThrottling, false);
  assert.deepEqual(idleHex.reasons, []);

  const noneStr = decodeNvidiaThrottleReasons('None');
  assert.equal(noneStr.isSupported, true);
  assert.equal(noneStr.isThrottling, false);
  assert.deepEqual(noneStr.reasons, []);

  // Applications and display clocks setting (0x02, 0x100) are not throttle reasons
  const appClocks = decodeNvidiaThrottleReasons('0x0000000000000002');
  assert.equal(appClocks.isThrottling, false);

  const dispClocks = decodeNvidiaThrottleReasons('0x0000000000000100');
  assert.equal(dispClocks.isThrottling, false);

  // Confirmed hardware thermal slowdown (0x40)
  const thermalHw = decodeNvidiaThrottleReasons('0x0000000000000040');
  assert.equal(thermalHw.isSupported, true);
  assert.equal(thermalHw.isThrottling, true);
  assert.deepEqual(thermalHw.reasons, ['hw_thermal_slowdown']);

  // Confirmed power cap (0x04) + SW thermal slowdown (0x20)
  const powerAndThermal = decodeNvidiaThrottleReasons('0x0000000000000024');
  assert.equal(powerAndThermal.isSupported, true);
  assert.equal(powerAndThermal.isThrottling, true);
  assert.deepEqual(powerAndThermal.reasons, ['sw_power_cap', 'sw_thermal_slowdown']);

  // Unsupported or unavailable sensors
  assert.equal(decodeNvidiaThrottleReasons('N/A').isSupported, false);
  assert.equal(decodeNvidiaThrottleReasons('[Not Supported]').isSupported, false);
  assert.equal(decodeNvidiaThrottleReasons(null).isSupported, false);
});

test('parseMetricNumber handles N/A, unsupported strings, and valid numbers without fabricating zeros', () => {
  assert.equal(parseMetricNumber('N/A'), null);
  assert.equal(parseMetricNumber('[Not Supported]'), null);
  assert.equal(parseMetricNumber('None'), null);
  assert.equal(parseMetricNumber(''), null);
  assert.equal(parseMetricNumber(null), null);
  assert.equal(parseMetricNumber(undefined), null);
  assert.equal(parseMetricNumber(NaN), null);

  assert.equal(parseMetricNumber(' 42.5 '), 42.5);
  assert.equal(parseMetricNumber(100), 100);
  assert.equal(parseMetricNumber(0), 0);
  assert.equal(parseMetricNumber('0'), 0);
});

test('computeFileContentFingerprint generates deterministic v1 fingerprints based on content, not paths', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-fp-'));
  try {
    const fileA = path.join(tmpDir, 'video-original.mkv');
    const fileB = path.join(tmpDir, 'different-name-same-content.mp4');
    const fileC = path.join(tmpDir, 'video-original.mkv.modified');

    const sampleContent = Buffer.alloc(128 * 1024, 0x5a); // 128 KB
    fs.writeFileSync(fileA, sampleContent);
    fs.writeFileSync(fileB, sampleContent);

    const differentContent = Buffer.alloc(128 * 1024, 0xa5);
    fs.writeFileSync(fileC, differentContent);

    const fpA = computeFileContentFingerprint(fileA);
    const fpB = computeFileContentFingerprint(fileB);
    const fpC = computeFileContentFingerprint(fileC);

    assert.ok(fpA.startsWith('v1:'), 'Must use canonical v1: prefix');
    assert.equal(fpA.length, 35, 'v1: + 32-character hex hash');
    assert.equal(
      fpA,
      fpB,
      'Files with identical content must yield identical fingerprints regardless of filename or path',
    );
    assert.notEqual(fpA, fpC, 'Files with different content must yield different fingerprints');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compareRuns classifies cross-hardware comparisons and ignores false regressions', () => {
  const baselineRun = {
    runId: 'base-rtx4090',
    environment: { gpu: 'NVIDIA GeForce RTX 4090' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.5,
        status: 'pass',
      },
    ],
  };

  const targetRun = {
    runId: 'target-arc-a380',
    environment: { gpu: 'Intel(R) Arc(TM) A380 Graphics' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 1.1,
        status: 'pass',
      },
    ],
  };

  const comp = compareRuns(baselineRun, targetRun);
  assert.equal(comp.isCrossHardware, true);
  assert.equal(comp.matchedComparisons.length, 1);
  assert.equal(comp.matchedComparisons[0].classification, 'cross_hardware_comparison');
  assert.ok(
    !comp.matchedComparisons.some(m => m.classification === 'regression'),
    'Cross-hardware run must NEVER be classified as a regression',
  );
});

test('deleteRunFromHistory strictly rejects path traversal attempts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-del-'));
  try {
    assert.throws(() => deleteRunFromHistory('../traversal', tmpDir), /invalid runid format/i);
    assert.throws(() => deleteRunFromHistory('run/sub', tmpDir), /invalid runid format/i);
    assert.throws(() => deleteRunFromHistory('..\\windows\\traversal', tmpDir), /invalid runid format/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('generateConfigurationRecommendations caps synthetic runs and short durations at preliminary confidence', () => {
  // Case A: 6-second synthetic run
  const synthPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 1,
    sampleDuration: 6,
    source: { isSynthetic: true, fileName: 'synthetic-test.mkv' },
    results: [
      {
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.5, effectiveFps: 75.0, deadlineMisses: 0 },
        fallbackEvents: [],
      },
    ],
  };
  const synthAdvice = generateConfigurationRecommendations(synthPayload);
  assert.equal(synthAdvice.recommendations[0]?.confidence, 'preliminary');
  assert.ok(synthAdvice.warningsAndUncertainties.some(w => w.includes('synthetic test media')));

  // Case B: Hardware encoder output with quality failure withholds encoder recommendation
  const qualityFailPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'camera.mp4' },
    results: [
      {
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.5, effectiveFps: 75.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'failed' },
        fallbackEvents: [],
      },
    ],
  };
  const failAdvice = generateConfigurationRecommendations(qualityFailPayload);
  assert.ok(
    !failAdvice.recommendations.some(r => r.setting === 'transcoding.encoder'),
    'Must withhold encoder recommendation if visual quality failed',
  );
  assert.ok(failAdvice.warningsAndUncertainties.some(w => w.includes('quality validation failed')));

  // Case C: Insufficient concurrency scan evidence suggests --allow-load-test
  const noScanAdvice = generateConfigurationRecommendations({ results: [] });
  const maxJobEvidence = noScanAdvice.insufficientEvidence.find(e => e.setting === 'transcoding.max_jobs');
  assert.ok(maxJobEvidence);
  assert.ok(
    maxJobEvidence.neededTests.includes('--allow-load-test'),
    'Must recommend --allow-load-test, not obsolete flag',
  );
});

test('runStabilityBenchmark verifies source duration and rejects inputs shorter than test interval', async () => {
  await assert.rejects(
    () => runStabilityBenchmark(null, { durationSeconds: 20 }, null, { duration: 60, startOffset: 0 }),
    /shorter than requested stability test interval/i,
  );
});

test('calculateP95 calculates true 95th percentile latency', () => {
  // 20 values from 1 to 20: 95th percentile index is 19 -> value 20
  const values = Array.from({ length: 20 }, (_, i) => i + 1);
  assert.equal(calculateP95(values), 20);

  // Array with outlier
  const latencyList = [1.0, 1.1, 1.0, 1.2, 1.0, 1.1, 1.0, 1.1, 1.0, 10.5];
  assert.equal(calculateP95(latencyList), 10.5);
});

test('buildQualityFilterChain builds secondary standalone pass when libvmaf lacks float_ssim or psnr', () => {
  const source = { video: { width: 1920, height: 1080, fps: 24 } };
  const targetQuality = { width: 1920, height: 1080 };
  const capabilities = {
    libvmaf: true,
    ssim: true,
    psnr: true,
    vmafFeatures: { cambi: false, psnr: false, float_ssim: false },
  };

  const chain = buildQualityFilterChain(source, targetQuality, capabilities, 'metrics.json', ['vmaf', 'ssim', 'psnr']);
  assert.equal(chain.supported, true);
  assert.equal(chain.usesLibvmaf, true);
  assert.equal(chain.needsSecondaryStandalonePass, true);
  assert.deepEqual(chain.secondaryMetrics, ['ssim', 'psnr']);
  assert.ok(chain.secondaryFilterGraph.includes('ssim=stats_file=ssim.log'));
  assert.ok(chain.secondaryFilterGraph.includes('psnr=stats_file=psnr.log'));
});

test('runStabilityBenchmark validates duration bounds (< 6s, > 3600s rejected)', async () => {
  await assert.rejects(
    () => runStabilityBenchmark(null, { durationSeconds: 100 }, { id: 'cfg' }, { duration: 5, outputDir: os.tmpdir() }),
    /Invalid stability test duration/i,
  );
  await assert.rejects(
    () =>
      runStabilityBenchmark(null, { durationSeconds: 4000 }, { id: 'cfg' }, { duration: 3601, outputDir: os.tmpdir() }),
    /Invalid stability test duration/i,
  );
});

test('TelemetryCollector handles providerInfo and string fallback correctly', () => {
  // Case A: Full providerInfo
  const providerInfo = {
    provider: 'pdh',
    deviceAttribution: 'unverified',
    throttlingSupported: false,
    device: 'Windows GPU (PDH)',
    supportedFields: ['memory_used', 'clock'],
    unavailableFields: ['throttling', 'temperature'],
  };
  const collector1 = new TelemetryCollector({ providerInfo });
  assert.equal(collector1.providerInfo.deviceAttribution, 'unverified');
  assert.equal(collector1.providerInfo.throttlingSupported, false);

  // Case B: String fallback for pdh
  const collector2 = new TelemetryCollector({ provider: 'pdh' });
  assert.equal(collector2.providerInfo.deviceAttribution, 'unverified');
  assert.equal(collector2.providerInfo.throttlingSupported, false);

  // Case C: String fallback for nvidia-smi
  const collector3 = new TelemetryCollector({ provider: 'nvidia-smi' });
  assert.equal(collector3.providerInfo.deviceAttribution, 'verified');
  assert.equal(collector3.providerInfo.throttlingSupported, true);
});

test('TelemetryCollector getSummary(configId) returns 0 samples when requested config has no samples without fallback', () => {
  const collector = new TelemetryCollector({ provider: 'nvidia-smi' });
  collector.setPhase('encoding', { configId: 'config-a' });
  collector.recordSample({ gpuUtilization: 55, temperatureC: 60 });
  collector.recordSample({ gpuUtilization: 65, temperatureC: 62 });

  // Summary for config-a has 2 samples
  const summaryA = collector.getSummary('config-a');
  assert.equal(summaryA.sampleCount, 2);
  assert.equal(summaryA.encoding.sampleCount, 2);
  assert.equal(summaryA.encoding.metrics.gpuUtilization.mean, 60);

  // Summary for nonexistent config-b must return 0 samples and NOT fall back to config-a
  const summaryB = collector.getSummary('config-b');
  assert.equal(summaryB.sampleCount, 0);
  assert.equal(summaryB.encoding.sampleCount, 0);
  assert.deepEqual(summaryB.encoding.metrics, {});
  assert.equal(summaryB.encoding.throttlingDetected, null);
});

test('TelemetryCollector getSummary() strictly distinguishes true, false, and unknown throttling states', () => {
  // 1. True state: active throttling detected (e.g. SW_POWER or reason)
  const colTrue = new TelemetryCollector({ provider: 'nvidia-smi' });
  colTrue.setPhase('encoding', { configId: 'cfg-1' });
  colTrue.recordSample({ gpuUtilization: 99, throttling: 'SW_POWER', throttleReasons: ['SW_POWER'] });
  const sumTrue = colTrue.getSummary('cfg-1');
  assert.equal(sumTrue.encoding.throttlingDetected, true);
  assert.deepEqual(sumTrue.encoding.activeThrottleReasons, ['SW_POWER']);

  // 2. False state: valid readings confirming absence of throttling ('None' / false)
  const colFalse = new TelemetryCollector({ provider: 'nvidia-smi' });
  colFalse.setPhase('encoding', { configId: 'cfg-1' });
  colFalse.recordSample({ gpuUtilization: 50, throttling: 'None', throttleReasons: [] });
  const sumFalse = colFalse.getSummary('cfg-1');
  assert.equal(sumFalse.encoding.throttlingDetected, false);
  assert.deepEqual(sumFalse.encoding.activeThrottleReasons, []);

  // 3. Unknown state (failed queries): provider supports throttling but queries returned null / no throttle data
  const colFailed = new TelemetryCollector({ provider: 'nvidia-smi' });
  colFailed.setPhase('encoding', { configId: 'cfg-1' });
  colFailed.recordSample({ gpuUtilization: 50, throttling: null, throttleReasons: null });
  const sumFailed = colFailed.getSummary('cfg-1');
  assert.equal(sumFailed.encoding.throttlingDetected, null, 'Failed query must result in null throttlingDetected');

  // 4. Unknown state (empty config samples): zero matching samples for requested config
  const sumEmpty = colFalse.getSummary('cfg-nonexistent');
  assert.equal(
    sumEmpty.encoding.throttlingDetected,
    null,
    'Empty config samples must result in null throttlingDetected',
  );

  // 5. Unsupported provider (e.g. PDH on Windows without GPU throttle sensor)
  const colUnsupported = new TelemetryCollector({
    provider: 'pdh',
    providerInfo: { provider: 'pdh', throttlingSupported: false },
  });
  colUnsupported.setPhase('encoding', { configId: 'cfg-1' });
  colUnsupported.recordSample({ hostCpuUtilization: 30 });
  const sumUnsupported = colUnsupported.getSummary('cfg-1');
  assert.equal(sumUnsupported.encoding.throttlingDetected, null);
  assert.equal(sumUnsupported.encoding.throttlingSupported, false);
});

test('saveRunToHistory serializes concurrent updates across multiple child processes preventing lost records', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-lock-'));
  const workerScript = path.join(tmpDir, 'save-worker.js');
  const historyModulePath = path.resolve(__dirname, '../scripts/benchmark/history.js');

  try {
    fs.writeFileSync(
      workerScript,
      `
      const { saveRunToHistory } = require(${JSON.stringify(historyModulePath)});
      const historyDir = process.argv[2];
      const workerId = process.argv[3];
      const payload = {
        timestamp: new Date().toISOString(),
        benchmarkVersion: 'Stage 3',
        sourceFingerprint: 'v1:source' + workerId,
        source: { fileName: 'test' + workerId + '.mp4' },
        environment: { gpu: 'Test GPU ' + workerId },
        results: [
          { configId: 'cfg-' + workerId, codec: 'av1', requestedEncoder: 'nvenc', status: 'pass' }
        ]
      };
      saveRunToHistory(payload, historyDir);
    `,
      'utf8',
    );

    const workerCount = 5;
    const workers = [];

    for (let i = 0; i < workerCount; i++) {
      workers.push(
        new Promise((resolve, reject) => {
          const proc = cp.spawn(process.execPath, [workerScript, tmpDir, String(i)], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
          let stderr = '';
          proc.stderr.on('data', d => {
            stderr += d.toString();
          });
          proc.on('error', reject);
          proc.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(`Worker ${i} failed with code ${code}: ${stderr}`));
          });
        }),
      );
    }

    await Promise.all(workers);

    // 1. Raw file content must be valid JSON
    const rawIndex = fs.readFileSync(path.join(tmpDir, 'history-index.json'), 'utf8');
    const parsedIndex = JSON.parse(rawIndex);
    assert.ok(parsedIndex && Array.isArray(parsedIndex.runs));

    // 2. Load history index helper
    const index = loadHistoryIndex(tmpDir);
    assert.equal(index.runs.length, workerCount, 'All 5 runs must be preserved in history index');

    // 3. Confirm every run appears exactly once with distinct runIds
    const runIds = new Set(index.runs.map(r => r.runId));
    assert.equal(runIds.size, workerCount, 'Every run must have a unique runId');

    // 4. Confirm all individual record files exist on disk
    for (const run of index.runs) {
      assert.ok(run.recordFile, 'Run entry must point to recordFile');
      const recPath = path.join(tmpDir, run.recordFile);
      assert.ok(fs.existsSync(recPath), `Record file ${run.recordFile} must exist on disk`);
      const record = JSON.parse(fs.readFileSync(recPath, 'utf8'));
      assert.equal(record.runId, run.runId);
    }

    // 5. Confirm no sources disappeared
    const sourceNames = index.runs.map(r => r.sourceFileName);
    for (let i = 0; i < workerCount; i++) {
      assert.ok(sourceNames.includes(`test${i}.mp4`), `Index must contain test${i}.mp4`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('compareRuns distinguishes GPU driver updates on same hardware from cross-hardware comparisons', () => {
  const baseRun = {
    runId: 'base-driver-old',
    environment: { gpu: 'NVIDIA GeForce RTX 4090 (Driver 566.03, 24GB VRAM)' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.0,
        status: 'pass',
      },
    ],
  };

  const targetRun = {
    runId: 'target-driver-new',
    environment: { gpu: 'NVIDIA GeForce RTX 4090 (Driver 566.14, 24GB VRAM)' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.2,
        status: 'pass',
      },
    ],
  };

  const comp = compareRuns(baseRun, targetRun);
  // Driver update on the same RTX 4090 is NOT cross-hardware!
  assert.equal(comp.isCrossHardware, false, 'Driver update on same GPU must not be classified as cross-hardware');
  assert.equal(comp.environmentDiff.gpuMatch, true);
  assert.equal(comp.environmentDiff.driverMatch, false);
  assert.equal(comp.environmentDiff.driverDiff, '566.03 -> 566.14');
  assert.equal(comp.matchedComparisons.length, 1);
  assert.equal(comp.matchedComparisons[0].classification, 'stable');
});

test('compareRuns rejects synthetic or unverified source media from matched regression evaluation', () => {
  const baseRun = {
    runId: 'base-real',
    environment: { gpu: 'NVIDIA GeForce RTX 4090' },
    sourceFingerprint: 'synthetic:test-pattern',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.0,
        status: 'pass',
      },
    ],
  };

  const targetRun = {
    runId: 'target-synth',
    environment: { gpu: 'NVIDIA GeForce RTX 4090' },
    sourceFingerprint: 'synthetic:test-pattern',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 1.5,
        status: 'pass',
      },
    ],
  };

  const comp = compareRuns(baseRun, targetRun);
  // Synthetic media lacks verified v1: content hash, so cannot evaluate performance regression
  assert.equal(comp.matchedComparisons.length, 0, 'Synthetic media must not be evaluated as matched regression');
  assert.equal(comp.partiallyMatchedComparisons.length, 1);
  assert.ok(
    comp.partiallyMatchedComparisons[0].differingConditions.some(c => c.includes('verified content fingerprint')),
  );
});

test('compareRuns rejects mismatched actual encoder backends from matched regression evaluation', () => {
  const baseRun = {
    runId: 'base-nvenc',
    environment: { gpu: 'NVIDIA GeForce RTX 4090' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 3.0,
        status: 'pass',
      },
    ],
  };

  const targetRun = {
    runId: 'target-fallback-software',
    environment: { gpu: 'NVIDIA GeForce RTX 4090' },
    sourceFingerprint: 'v1:11223344556677889900aabbccddeeff',
    sampleDuration: 60,
    startOffset: 0,
    results: [
      {
        configId: 'av1-1080p8-chunks',
        codec: 'av1',
        qualityId: '1080p8',
        requestedEncoder: 'nvenc',
        actualEncoder: 'software', // Fell back to software
        mode: 'chunks',
        concurrency: 1,
        speedRatio: 0.5,
        status: 'pass',
      },
    ],
  };

  const comp = compareRuns(baseRun, targetRun);
  // Mismatched actualEncoder (nvenc vs software) must NOT be compared directly as regression
  assert.equal(comp.matchedComparisons.length, 0);
  assert.equal(comp.partiallyMatchedComparisons.length, 1);
  assert.ok(comp.partiallyMatchedComparisons[0].differingConditions.some(c => c.includes('actual encoder backend')));
});

test('generateConfigurationRecommendations strictly gates high confidence on real media, verified quality, 0 fallbacks and 0 missed deadlines', () => {
  // Case 1: Real media + 2 runs + 60s + 0 fallbacks + 0 missed deadlines + VERIFIED QUALITY -> HIGH confidence
  const highPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'reference.mkv' },
    results: [
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.8, effectiveFps: 84.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 94.2 } },
        fallbackEvents: [],
      },
      {
        runIndex: 2,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.9, effectiveFps: 87.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 94.5 } },
        fallbackEvents: [],
      },
    ],
  };
  const highAdvice = generateConfigurationRecommendations(highPayload);
  assert.equal(highAdvice.recommendations[0]?.confidence, 'high');

  // Case 2: Same conditions but quality metrics were omitted -> capped at MEDIUM confidence
  const noQualityPayload = {
    ...highPayload,
    results: highPayload.results.map(r => ({
      ...r,
      qualityMetrics: null,
    })),
  };
  const mediumAdvice = generateConfigurationRecommendations(noQualityPayload);
  assert.equal(
    mediumAdvice.recommendations[0]?.confidence,
    'medium',
    'Unverified visual quality must cap confidence at medium',
  );

  // Case 3: Same conditions but with 1 missed deadline -> capped at MEDIUM confidence
  const deadlineMissPayload = {
    ...highPayload,
    results: [
      highPayload.results[0],
      {
        ...highPayload.results[1],
        performance: { speedMultiplier: 2.8, effectiveFps: 84.0, deadlineMisses: 1 },
        deadlinesMissed: 1,
      },
    ],
  };
  const deadlineAdvice = generateConfigurationRecommendations(deadlineMissPayload);
  assert.equal(deadlineAdvice.recommendations[0]?.confidence, 'medium', 'Missed deadline must prevent high confidence');

  // Case 4: Multiple 6s runs on synthetic media -> capped at PRELIMINARY confidence
  const multiSynthPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 3,
    sampleDuration: 6,
    source: { isSynthetic: true, fileName: 'synthetic-pattern.mkv' },
    results: [
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 3.5, effectiveFps: 105.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 98.0 } },
        fallbackEvents: [],
      },
      {
        runIndex: 2,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 3.5, effectiveFps: 105.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 98.0 } },
        fallbackEvents: [],
      },
    ],
  };
  const multiSynthAdvice = generateConfigurationRecommendations(multiSynthPayload);
  assert.equal(
    multiSynthAdvice.recommendations[0]?.confidence,
    'preliminary',
    'Synthetic media must always be capped at preliminary',
  );

  // Regression Test 1: Declared runs: 2 but only 1 actual result -> capped at preliminary
  const singleResultPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'reference.mkv' },
    results: [highPayload.results[0]], // only 1 measured trial
  };
  const singleAdvice = generateConfigurationRecommendations(singleResultPayload);
  assert.equal(
    singleAdvice.recommendations[0]?.confidence,
    'preliminary',
    'Single measured result despite runs: 2 must cap confidence at preliminary',
  );
  assert.ok(
    singleAdvice.recommendations[0]?.confidenceReasons.some(r => r.includes('requires at least 2 independent runs')),
  );

  // Regression Test 2: Mixed successes and failures for the same configuration -> not high confidence
  const mixedPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'reference.mkv' },
    results: [
      highPayload.results[0],
      {
        ...highPayload.results[1],
        status: 'fail',
        error: 'Encoder crash',
      },
    ],
  };
  const mixedAdvice = generateConfigurationRecommendations(mixedPayload);
  assert.notEqual(
    mixedAdvice.recommendations[0]?.confidence,
    'high',
    'Mixed pass and fail trials must disqualify high confidence',
  );

  // Regression Test 3: Quality PASS on unrelated software encoder cannot qualify NVENC recommendation
  const unrelatedQualityPayload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'reference.mkv' },
    results: [
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.8, effectiveFps: 84.0, deadlineMisses: 0 },
        qualityMetrics: null, // No quality check on NVENC!
        fallbackEvents: [],
      },
      {
        runIndex: 2,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.9, effectiveFps: 87.0, deadlineMisses: 0 },
        qualityMetrics: null, // No quality check on NVENC!
        fallbackEvents: [],
      },
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'software',
        actualEncoder: 'software',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 0.8, effectiveFps: 24.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'pass', vmaf: { mean: 95.0 } }, // Pass on SOFTWARE, not NVENC!
        fallbackEvents: [],
      },
    ],
  };
  const unrelatedAdvice = generateConfigurationRecommendations(unrelatedQualityPayload);
  const nvencRec = unrelatedAdvice.recommendations.find(r => r.recommendedValue === 'nvenc');
  assert.ok(nvencRec);
  assert.equal(nvencRec.confidence, 'medium', 'Quality pass on software cannot qualify nvenc for high confidence');
  assert.ok(
    nvencRec.confidenceReasons.some(r => r.includes('visual quality was not verified with objective quality metrics')),
  );
});

test('runStabilityBenchmark stops on internal failure threshold with external signal present without launching further chunks', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-stability-thresh-'));
  const externalAbort = new AbortController();
  let chunksLaunched = 0;

  try {
    const mockChunkedRunner = async (tools, source, config, options) => {
      for (let i = 0; i < 5; i++) {
        if (options.signal?.aborted) {
          const err = new Error('Aborted');
          err.name = 'AbortError';
          throw err;
        }
        chunksLaunched++;
        // Each chunk takes 10s (exceeds chunkDuration * 1.5 = 6 * 1.5 = 9s threshold)
        options.onProgress?.({
          chunkIndex: i,
          totalChunks: 5,
          encodeDurationSec: 10,
          realTimeSpeed: 0.6,
          deadlineMissed: true,
          fallbackOccurred: false,
        });
      }
      return { status: 'pass' };
    };

    const source = {
      filePath: 'C:/media/test.mkv',
      durationSeconds: 120,
      video: { width: 1920, height: 1080, fps: 30, codec: 'h264' },
    };
    const config = {
      id: 'test-stability-cfg',
      codec: 'av1',
      requestedEncoder: 'nvenc',
      quality: { id: '1080p8', label: '1080p 8Mbps' },
    };

    const result = await runStabilityBenchmark(
      {}, // tools
      source,
      config,
      {
        duration: 30, // 5 chunks of 6s
        chunkDuration: 6,
        maxConsecutiveFailures: 2,
        outputDir: tmpDir,
        signal: externalAbort.signal,
        chunkedRunner: mockChunkedRunner,
      },
    );

    // 1. External signal was NOT aborted by caller
    assert.equal(externalAbort.signal.aborted, false, 'External signal must remain unaborted');

    // 2. Chunks stopped after exactly 2 consecutive failures
    assert.equal(chunksLaunched, 2, 'No further chunks should be launched after threshold exceeded');

    // 3. Status reflects early stop
    assert.equal(result.stability.status, 'early_stopped');

    // 4. Completed chunk count matches
    assert.equal(result.stability.chunksCompleted, 2);

    // 5. Early stop reason accurately records consecutive severe performance failures
    assert.ok(result.stability.earlyStopReason);
    assert.ok(
      result.stability.earlyStopReason.includes('consecutive severe chunk performance failures'),
      `Expected early stop reason to mention consecutive failures, got: ${result.stability.earlyStopReason}`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('parseFinalDecodedFrames reads final decoded frame count rather than intermediate progress lines', () => {
  const multiProgressStderr = [
    'frame=   77 fps=0.0 q=-0.0 size=N/A time=00:00:03.20 bitrate=N/A speed=6.4x',
    'frame=  150 fps=49.8 q=-0.0 size=N/A time=00:00:06.25 bitrate=N/A speed=12.2x',
    'frame=  720 fps=60.1 q=-0.0 size=N/A time=00:00:30.00 bitrate=N/A speed=15.0x',
    'frame= 1440 fps=65.2 q=-0.0 Lsize=N/A time=00:01:00.00 bitrate=N/A speed=16.3x',
    'video:64KiB audio:0KiB subtitle:0KiB other streams:0KiB global headers:0KiB muxing overhead: unknown',
  ].join('\r\n');

  const finalFrames = parseFinalDecodedFrames(multiProgressStderr);
  assert.equal(finalFrames, 1440, 'Must extract the final 1440 frames, not the initial 77 progress frame');

  assert.equal(parseFinalDecodedFrames(''), null);
  assert.equal(parseFinalDecodedFrames(null), null);
  assert.equal(parseFinalDecodedFrames('no frames mentioned here'), null);
});

test('validateTemporalAlignment reports unverified rather than misaligned when source probe times out or is incomplete', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-timeout-probe-'));
  try {
    const refFile = path.join(tmpDir, 'ref.mp4');
    const matchingFile = path.join(tmpDir, 'matching.webm');

    // Generate 2-second reference video (60 frames at 30 fps)
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        refFile,
      ],
      { windowsHide: true },
    );

    // Generate matching encode (2 seconds, 60 frames)
    cp.execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', refFile, '-c:v', 'libvpx', matchingFile],
      { windowsHide: true },
    );

    // Validate with an impossibly short probeTimeoutMs (1ms) to force probe timeout
    const resTimeout = validateTemporalAlignment('ffprobe', refFile, matchingFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30,
      probeTimeoutMs: 1,
    });

    // An incomplete probe must be reported as unverified, NOT misaligned
    assert.equal(resTimeout.status, 'unverified', 'Incomplete or timed-out probe must be unverified, not misaligned');
    assert.equal(resTimeout.sourceProbeIncomplete, true);
    assert.equal(resTimeout.sourcePacketCount, null);
    assert.equal(resTimeout.errors.length, 0, 'Incomplete source probe must not generate misalignment errors');
    assert.ok(resTimeout.reason && resTimeout.reason.includes('timed out'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('validateTemporalAlignment enforces real source/encoded frame divergence when probe completes', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-real-diverge-'));
  try {
    const refFile = path.join(tmpDir, 'ref.mp4');
    const divergentFile = path.join(tmpDir, 'divergent.webm');

    // Generate 2-second reference video (60 frames at 30 fps)
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        refFile,
      ],
      { windowsHide: true },
    );

    // Generate 4-second divergent encode (120 frames at 30 fps)
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '4',
        '-c:v',
        'libvpx',
        divergentFile,
      ],
      { windowsHide: true },
    );

    // Validate 2-second requested window against 4-second encode (real duration & frame divergence)
    const resDivergent = validateTemporalAlignment('ffprobe', refFile, divergentFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30,
    });

    assert.equal(resDivergent.status, 'misaligned', 'Real frame and duration divergence must fail as misaligned');
    assert.ok(resDivergent.errors.length > 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runQualityAnalysis promotes unverified temporal alignment to pass when quality filter achieves verified frame coverage', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-qa-promote-'));
  try {
    const refFile = path.join(tmpDir, 'ref.mp4');
    const encodedFile = path.join(tmpDir, 'enc.webm');

    // Generate 2-second reference video (60 frames at 30 fps)
    cp.execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=320x240:rate=30',
        '-t',
        '2',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        refFile,
      ],
      { windowsHide: true },
    );

    // Encode matching 2-second webm
    cp.execFileSync(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-y', '-i', refFile, '-c:v', 'libvpx', encodedFile],
      { windowsHide: true },
    );

    const source = {
      filePath: refFile,
      fileName: 'ref.mp4',
      durationSeconds: 2,
      video: { width: 320, height: 240, fps: 30 },
    };
    const targetQuality = { id: 'test', width: 320, height: 240 };
    const capabilities = detectQualityCapabilities('ffmpeg');

    const tools = resolveTools();
    const result = await runQualityAnalysis(tools.ffmpeg, {
      ffprobePath: tools.ffprobe,
      ffmpegPath: tools.ffmpeg,
      source,
      encodedFilePath: encodedFile,
      startOffset: 0,
      sampleDuration: 2,
      targetQuality,
      outputDir: tmpDir,
      capabilities,
      selectedMetrics: ['ssim', 'psnr'],
    });

    assert.equal(result.status, 'pass');
    assert.ok(result.ssim?.mean > 0.9, `SSIM mean should be high (> 0.9), got: ${result.ssim?.mean}`);
    assert.ok(
      result.normalization.coveragePercent >= 95,
      `Coverage must be >= 95%, got: ${result.normalization.coveragePercent}%`,
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('generateCsvReport and generateHtmlReport correctly present unavailable Windows PDH telemetry as N/A and separate host CPU from encoder util', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-pdh-report-'));
  try {
    const mockData = {
      schemaVersion: '3.0.0',
      benchmarkVersion: 'Stage 3',
      timestamp: new Date().toISOString(),
      telemetry: {
        provider: 'windows-pdh',
        device: 'Intel Arc A380 (DirectX / QSV)',
        throttlingSupported: false,
        unavailableFields: ['temperatureC', 'powerWatts', 'gpuUtilization'],
        encoding: {
          metrics: {
            encoderUtilization: { mean: 65.5 },
            hostCpuUtilization: { mean: 18.2 },
          },
          thermalClimbC: null,
          throttlingSupported: false,
          throttlingDetected: null,
        },
      },
      results: [
        {
          runIndex: 1,
          configId: 'av1-qsv-1080p8',
          codec: 'av1',
          requestedEncoder: 'qsv',
          actualEncoder: 'qsv',
          mode: 'chunks',
          status: 'pass',
          quality: { id: '1080p8', width: 1920, height: 1080, targetBitrateKbps: 8000 },
          performance: { speedMultiplier: 2.1, effectiveFps: 63.0 },
          qualityMetrics: {
            status: 'failed',
            reason: 'Temporal alignment probe failed',
          },
          telemetry: {
            encoding: {
              metrics: {
                encoderUtilization: { mean: 65.5 },
                hostCpuUtilization: { mean: 18.2 },
              },
              thermalClimbC: null,
              throttlingSupported: false,
              throttlingDetected: null,
            },
          },
        },
      ],
    };

    const csvPath = path.join(tmpDir, 'report.csv');
    const htmlPath = path.join(tmpDir, 'report.html');

    generateCsvReport(mockData, csvPath);
    generateHtmlReport(mockData, htmlPath);

    const csv = fs.readFileSync(csvPath, 'utf8');
    const csvLines = csv.trim().split(/\r?\n/);
    assert.equal(csvLines.length, 2);

    // Headers must include Quality_Status, Quality_Reason, and Avg_Host_CPU
    assert.ok(csvLines[0].includes('Quality_Status'));
    assert.ok(csvLines[0].includes('Quality_Reason'));
    assert.ok(csvLines[0].includes('Avg_Host_CPU'));

    // Data row: Status is PASS, Quality_Status is FAILED, Temp & Thermal Climb are N/A (never 0)
    const row = csvLines[1];
    assert.ok(
      row.includes(',pass,FAILED,"Temporal alignment probe failed",'),
      'CSV must separate encode pass from quality failed',
    );
    assert.ok(
      row.includes(',65.5,18.2,N/A,N/A,N/A,'),
      'CSV must report N/A for temperature and thermal climb on Windows PDH, not 0',
    );

    const html = fs.readFileSync(htmlPath, 'utf8');
    // HTML must display both GPU Encoder Util and Host CPU Util
    assert.ok(html.includes('Avg GPU Encoder Util'));
    assert.ok(html.includes('Avg Host CPU Util'));
    assert.ok(html.includes('65.5%'));
    assert.ok(html.includes('18.2%'));
    // HTML must display N/A for GPU Core Temp and Thermal Climb, never 0°C or +0°C
    assert.ok(html.includes('N/A (Unsupported)'));
    assert.ok(
      html.includes(
        '<div class="stat-label">Thermal Climb (ΔT)</div>\n        <div class="stat-val" style="color:var(--text);">\n          N/A',
      ),
    );
    // HTML must display Quality Status failure and failure banner
    assert.ok(html.includes('Objective Quality Analysis Failure'));
    assert.ok(html.includes('FAILED'));
    assert.ok(html.includes('Temporal alignment probe failed'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('generateConfigurationRecommendations withholds AV1 output recommendation when AV1 quality failed', () => {
  const payload = {
    benchmarkVersion: 'Stage 3',
    runs: 2,
    sampleDuration: 60,
    source: { isSynthetic: false, fileName: 'reference.mkv' },
    results: [
      {
        runIndex: 1,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.5, effectiveFps: 75.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'failed', reason: 'Temporal misalignment' },
        fallbackEvents: [],
      },
      {
        runIndex: 2,
        codec: 'av1',
        requestedEncoder: 'nvenc',
        actualEncoder: 'nvenc',
        status: 'pass',
        quality: { id: '1080p8' },
        performance: { speedMultiplier: 2.6, effectiveFps: 78.0, deadlineMisses: 0 },
        qualityMetrics: { status: 'failed', reason: 'Temporal misalignment' },
        fallbackEvents: [],
      },
    ],
  };

  const advice = generateConfigurationRecommendations(payload, { transcoding: { outputs: ['plex'] } });
  const outRec = advice.recommendations.find(r => r.setting === 'transcoding.outputs');
  assert.equal(outRec, undefined, 'AV1 output recommendation must be withheld when AV1 quality analysis failed');
  assert.ok(
    advice.warningsAndUncertainties.some(w =>
      w.includes('AV1 encoding achieved real-time throughput, but objective quality analysis failed'),
    ),
  );
});
