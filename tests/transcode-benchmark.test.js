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
  buildQualityFilterChain,
  validateTemporalAlignment,
  runQualityAnalysis
} = require('../scripts/benchmark/quality');
const { spawnSafe } = require('../scripts/benchmark/tools');
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
      Array.from({ length: 10 }, () => Promise.resolve().then(() => resolveUniqueOutputDir(target, tmpDir)))
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
    { codec: 'vp8', encoder: 'software', available: true }
  ];

  // Auto AV1 should pick QSV when available
  const av1Auto = resolveEncoderForCodec('av1', 'auto', sampleProbed, true);
  assert.equal(av1Auto.actualEncoder, 'qsv');

  // Hardware AV1 when hardware is unavailable falls back to software if cpuFallback=true
  const hardwareOnlyNoHw = [
    { codec: 'av1', encoder: 'qsv', available: false },
    { codec: 'av1', encoder: 'nvenc', available: false },
    { codec: 'av1', encoder: 'software', available: true }
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
    qualities: ['1080p8']
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
      codec: 'h264'
    },
    audio: { available: true },
    hdr: { hdr: false },
    rawInfo: { streams: [{ codec_type: 'video', width: 1280, height: 720 }] }
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
    const score = (f >= 60 && f <= 90) ? 40 : 95;
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
    hdr: { hdr: false }
  };
  const target720p = { width: 1280, height: 720 };
  const mockCaps = {
    libvmaf: true,
    vmafFeatures: { cambi: true, psnr: true, float_ssim: true }
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
    hdr: { hdr: true, doviP5: true }
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
    psnr: true
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
    psnr: true
  };
  const unsuppCambi = buildQualityFilterChain(source, target, capsNoCambi, 'quality-metrics.json', ['cambi']);
  assert.equal(unsuppCambi.supported, false);
  assert.match(unsuppCambi.reason, /CAMBI feature is not available/i);
});

test('spawnSafe promptly terminates running subprocess on abort signal', async () => {
  const controller = new AbortController();
  const startTime = Date.now();

  // Launch a real FFmpeg child process that would run for 30 seconds if not cancelled
  const promise = spawnSafe('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=30',
    '-t', '30',
    '-f', 'null', '-'
  ], {
    signal: controller.signal,
    timeout: 30000
  });

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
    cp.execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30',
      '-t', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast',
      refFile
    ], { windowsHide: true });

    // Generate matching encode (start PTS ~ 0, duration 2s)
    const matchingFile = path.join(tmpDir, 'matching.webm');
    cp.execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', refFile,
      '-c:v', 'libvpx',
      matchingFile
    ], { windowsHide: true });

    // Validate matching
    const resMatching = validateTemporalAlignment('ffprobe', refFile, matchingFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30
    });
    assert.equal(resMatching.status, 'verified');
    assert.ok(resMatching.encodedFirstPts <= 0.08);

    // Generate deliberately time-delayed encode (start PTS = 1.0s)
    const delayedFile = path.join(tmpDir, 'delayed.webm');
    cp.execFileSync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-i', refFile,
      '-vf', 'setpts=PTS-STARTPTS+1.0/TB',
      '-c:v', 'libvpx',
      delayedFile
    ], { windowsHide: true });

    // Validate delayed
    const resDelayed = validateTemporalAlignment('ffprobe', refFile, delayedFile, {
      startOffset: 0,
      sampleDuration: 2,
      fps: 30
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
        chunkP95DurationSec: 2.5
      }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 5,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    minRealtimeMargin: 1.05,
    workerRunner: mockWorker
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
      performance: { speedMultiplier: 2.0, deadlineMisses: 0, chunkP95DurationSec: 2.5 }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker
  });

  assert.equal(scanResult.highestSustainableConcurrency, 1);
  assert.equal(scanResult.firstFailingConcurrency, 2);
  assert.equal(scanResult.testedTiers.length, 2);
  assert.match(scanResult.stoppingReason, /GPU NVENC session allocation exhausted/);
});

test('runCapacityScan stops immediately when a worker misses a 6s chunk deadline', async () => {
  const mockWorker = async (tools, source, config, opts) => {
    const misses = (opts.concurrency === 2 && opts.workerId === 1) ? 1 : 0;
    return {
      status: 'pass',
      actualEncoder: config.requestedEncoder,
      performance: { speedMultiplier: 1.2, deadlineMisses: misses, chunkP95DurationSec: 4.0 }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker
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
      performance: { speedMultiplier: 1.2, deadlineMisses: 0, chunkP95DurationSec: p95 }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    maxChunkP95ThresholdSec: 5.1,
    workerRunner: mockWorker
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
      performance: { speedMultiplier: 1.5, deadlineMisses: 0, chunkP95DurationSec: 3.0 }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 3,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    workerRunner: mockWorker
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
      performance: { speedMultiplier: 2.0, deadlineMisses: 0, chunkP95DurationSec: 2.0 }
    };
  };

  const scanResult = await runCapacityScan({
    maxConcurrency: 4,
    testConfig: { codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
    sampleDuration: 60,
    signal: controller.signal,
    workerRunner: mockWorker
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
      const workerDir = path.join(opts.outputDir, 'outputs', `concurrency-${opts.concurrency}`, `run-${opts.runIndex}`, `worker-${opts.workerId}`, config.id);
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
        performance: { speedMultiplier: 2.0, deadlineMisses: 0 }
      };
    };

    // Run trial 1
    const trial1 = await runConcurrentTier({
      concurrency: 2,
      runIndex: 1,
      outputDir: tmpDir,
      testConfig: { id: 'test-config', codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
      workerRunner: mockWorker
    });

    // Run trial 2
    const trial2 = await runConcurrentTier({
      concurrency: 2,
      runIndex: 2,
      outputDir: tmpDir,
      testConfig: { id: 'test-config', codec: 'av1', requestedEncoder: 'nvenc', quality: { id: '1080p8' } },
      workerRunner: mockWorker
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
        estimateNotice: 'Short-run capacity estimate based on chunk deadline preservation.'
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
    assert.equal(json.schemaVersion, '2.1.0');
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
    assert.match(html, /Stage 2: Performance, Sustainable Concurrency &amp; Objective Video Quality/);
    assert.match(html, /Sustainable Transcoding Capacity/);
    assert.match(html, /4 Streams/);
    assert.match(html, /Blind A\/B Subjective Quality Comparison/);
    assert.match(html, /5-Level Scale/);
    assert.match(html, /Strongly Prefer A/);
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
