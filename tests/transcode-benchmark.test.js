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

  // Total configurations: AV1 has 3 encoders (nvenc, qsv, software) * 2 qualities = 6
  // VP9 has 2 encoders (qsv, software) * 2 qualities = 4
  // VP8 has 1 encoder (software) * 2 qualities = 2
  // Total = 12
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
    // Malformed YAML syntax with tabs / invalid indentation
    const content = `transcoding:\n\toutputs: [av1]\nsecret: ${secretText}\n`;
    fs.writeFileSync(badYamlPath, content, 'utf8');

    let thrownError;
    try {
      loadBenchmarkConfig(badYamlPath);
    } catch (err) {
      thrownError = err;
    }

    assert.ok(thrownError, 'Must throw on malformed YAML');
    assert.match(thrownError.message, /Invalid configuration YAML in bad-config\.yaml/);
    assert.ok(!thrownError.message.includes(secretText), 'Must not leak secret text in error message');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('resolveUniqueOutputDir safely avoids collisions and protects source directories', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-out-dir-'));
  try {
    // 1. Rejects project root / critical source directories
    assert.throws(() => resolveUniqueOutputDir('.', tmpDir), /cannot point to project root/i);
    assert.throws(() => resolveUniqueOutputDir('server', tmpDir), /cannot point to project root/i);
    assert.throws(() => resolveUniqueOutputDir('.git', tmpDir), /cannot point to project root/i);

    // 2. Fresh requested directory is created directly
    const custom1 = path.join(tmpDir, 'my-test-run');
    const res1 = resolveUniqueOutputDir(custom1, tmpDir);
    assert.equal(res1.dir, custom1);
    assert.equal(res1.collisionAvoided, false);
    assert.ok(fs.existsSync(custom1));

    // 3. Put a file inside custom1 so it is non-empty
    fs.writeFileSync(path.join(custom1, 'results.json'), '{}', 'utf8');

    // 4. Second invocation targeting the same directory must NOT overwrite
    const res2 = resolveUniqueOutputDir(custom1, tmpDir);
    assert.notEqual(res2.dir, custom1);
    assert.equal(res2.collisionAvoided, true);
    assert.equal(res2.dir, `${custom1}-1`);
    assert.ok(fs.existsSync(res2.dir));

    // 5. Default directory creates a unique timestamp-pid path
    const resDefault1 = resolveUniqueOutputDir(null, tmpDir);
    assert.match(resDefault1.dir, /run-\d{4}-\d{2}-\d{2}T/);
    assert.ok(fs.existsSync(resDefault1.dir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('sanitizeText strips personal home directories, Windows drive roots, and tokens', () => {
  const winHome = 'Error loading C:\\Users\\alice\\AppData\\Local\\uburoom\\secret.key';
  const sanitizedWin = sanitizeText(winHome);
  assert.ok(!sanitizedWin.includes('alice'), 'Must strip username');
  assert.ok(sanitizedWin.includes('[home]'), 'Must replace with [home]');

  const posixHome = 'Failed to open /home/bob/videos/my_private_movie.mkv';
  const sanitizedPosix = sanitizeText(posixHome);
  assert.ok(!sanitizedPosix.includes('bob'), 'Must strip username');
  assert.ok(sanitizedPosix.includes('[home]'), 'Must replace with [home]');

  const tokenStr = 'Connection failed: https://myplex.example.com?token=superSecretToken123&user=admin';
  const sanitizedToken = sanitizeText(tokenStr);
  assert.ok(!sanitizedToken.includes('superSecretToken123'), 'Must strip token value');
  assert.ok(sanitizedToken.includes('[REDACTED]') || sanitizedToken.includes('[url]'));
});

test('prober encoder resolution correctly handles auto, fallback, and software VP8', () => {
  const mockProbedArc = [
    { codec: 'av1', encoder: 'qsv', available: true },
    { codec: 'av1', encoder: 'nvenc', available: false },
    { codec: 'av1', encoder: 'software', available: true },
    { codec: 'vp9', encoder: 'qsv', available: true },
    { codec: 'vp9', encoder: 'software', available: true },
    { codec: 'vp8', encoder: 'software', available: true }
  ];

  // On Intel Arc (QSV available), auto AV1 picks qsv
  const arcAv1 = resolveEncoderForCodec('av1', 'auto', true, mockProbedArc);
  assert.equal(arcAv1.actualEncoder, 'qsv');
  assert.equal(arcAv1.isFallback, false);

  // On Intel Arc, auto VP9 picks qsv
  const arcVp9 = resolveEncoderForCodec('vp9', 'auto', true, mockProbedArc);
  assert.equal(arcVp9.actualEncoder, 'qsv');
  assert.equal(arcVp9.isFallback, false);

  // VP8 auto always selects software without attempting QSV
  const arcVp8 = resolveEncoderForCodec('vp8', 'auto', true, mockProbedArc);
  assert.equal(arcVp8.actualEncoder, 'software');

  const mockProbedNvidia = [
    { codec: 'av1', encoder: 'qsv', available: false },
    { codec: 'av1', encoder: 'nvenc', available: true },
    { codec: 'av1', encoder: 'software', available: true },
    { codec: 'vp9', encoder: 'qsv', available: false },
    { codec: 'vp9', encoder: 'software', available: true },
    { codec: 'vp8', encoder: 'software', available: true }
  ];

  // On NVIDIA (QSV unavailable, NVENC available), auto AV1 picks nvenc
  const nvdAv1 = resolveEncoderForCodec('av1', 'auto', true, mockProbedNvidia);
  assert.equal(nvdAv1.actualEncoder, 'nvenc');
  assert.equal(nvdAv1.isFallback, false);

  // On NVIDIA, auto VP9 falls back from QSV to software
  const nvdVp9 = resolveEncoderForCodec('vp9', 'auto', true, mockProbedNvidia);
  assert.equal(nvdVp9.actualEncoder, 'software');
  assert.equal(nvdVp9.isFallback, true);
  assert.match(nvdVp9.fallbackReason, /fell back to CPU software/i);
});

test('--all-encoders mode disables CPU fallback to record unavailable encoders accurately', () => {
  const config = loadBenchmarkConfig(resolveConfigFile());
  const matrix = resolveTestMatrix(config, {
    allEncoders: true,
    codecs: ['av1']
  });

  // Under allEncoders: true, allowFallback must be false
  for (const c of matrix.configurations) {
    assert.equal(c.allowFallback, false, `Configuration ${c.id} must not allow CPU fallback under --all-encoders`);
  }
});

test('outputSpec enforces strict no-upscaling rule', () => {
  const source720p = {
    streams: [
      { codec_type: 'video', width: 1280, height: 720, pix_fmt: 'yuv420p', r_frame_rate: '30/1' }
    ],
    format: { duration: '60', bit_rate: '5000000' }
  };

  // Targeting 1080p from a 720p source must NOT upscale to 1080p
  const spec = deriveOutputSpec(source720p, '1080p8');
  assert.equal(spec.targetHeight, 720, 'Height must not exceed source height (720)');
  assert.equal(spec.targetWidth, 1280, 'Width must not exceed source width (1280)');
});

test('reports generate valid JSON, CSV, and HTML offline files with viewing proxy labels and stats', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-test-rep-'));
  try {
    const mockData = {
      benchmarkVersion: 'Stage 1',
      configProfile: 'config.example.yaml',
      sampleDuration: 60,
      startOffset: 0,
      options: {
        mode: 'chunks',
        runs: 2
      },
      tools: {
        ffmpeg: 'C:\\Users\\alice\\tools\\ffmpeg.exe',
        ffprobe: 'C:\\Users\\alice\\tools\\ffprobe.exe',
        ffmpegVersion: 'ffmpeg 7.0',
        ffprobeVersion: 'ffprobe 7.0'
      },
      environment: {
        platform: 'win32',
        arch: 'x64',
        cpu: { model: 'Test CPU', cores: 8 },
        memoryFreeMB: 8000,
        memoryTotalMB: 16000,
        gpu: 'NVIDIA GeForce RTX 4090 (Driver C:\\Windows\\System32\\nvldumdx.dll)'
      },
      source: {
        filePath: 'C:\\Users\\alice\\Videos\\secret_home_video.mkv',
        fileName: 'sample.mkv',
        durationSeconds: 120,
        video: { resolution: '1920x1080', fps: 30, codec: 'h264' },
        hdr: { label: 'SDR' },
        referenceVideoRelative: 'reference-proxy.mp4',
        referenceNotice: 'Transcoded lightweight 8-bit SDR preview proxy for web browser inspection.'
      },
      results: [
        {
          runIndex: 1,
          configId: 'av1-nvenc-1080p8-chunked-r1',
          mode: 'chunks',
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
          output: {
            assembledFile: 'outputs/run-1/av1-nvenc-1080p8-chunked/assembled.webm',
            chunks: []
          }
        },
        {
          runIndex: 2,
          configId: 'av1-nvenc-1080p8-chunked-r2',
          mode: 'chunks',
          status: 'pass',
          codec: 'av1',
          requestedEncoder: 'nvenc',
          actualEncoder: 'nvenc',
          quality: { id: '1080p8', label: '1080p · 8 Mbps', width: 1920, height: 1080, targetBitrateKbps: 8000 },
          performance: {
            sampleDuration: 60,
            totalEncodingTimeSec: 11.5,
            successfulEncodeTimeSec: 11.5,
            effectiveFps: 156.0,
            speedMultiplier: 5.2,
            totalElapsedSpeedMultiplier: 5.2,
            firstChunkDurationSec: 1.0,
            firstChunkStartupSec: 1.0,
            meanChunkSec: 1.15,
            medianChunkSec: 1.15,
            p95ChunkSec: 1.2,
            maxChunkSec: 1.2,
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
          output: {
            assembledFile: 'outputs/run-2/av1-nvenc-1080p8-chunked/assembled.webm',
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
    assert.equal(json.schemaVersion, '1.0.0');
    assert.equal(json.results.length, 2);
    // Absolute paths must be sanitized in exported json
    assert.equal(json.tools.ffmpeg, 'ffmpeg.exe');
    assert.equal(json.source.filePath, undefined);
    assert.ok(!JSON.stringify(json).includes('alice'), 'Must not leak username in JSON report');

    const csv = fs.readFileSync(csvPath, 'utf8');
    const lines = csv.trim().split(/\r?\n/);
    assert.equal(lines.length, 3, 'CSV must have header and two rows for two runs');
    assert.match(lines[0], /^Run,ConfigID,Mode,ProcessingType/);
    assert.match(lines[1], /^1,av1-nvenc/);
    assert.match(lines[2], /^2,av1-nvenc/);
    assert.ok(!csv.includes('alice'), 'Must not leak username in CSV report');

    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.match(html, /uburoom Transcoding Benchmark/);
    assert.match(html, /Viewing Proxy \(Lossy 8-bit H\.264\/AAC Preview/);
    assert.match(html, /Production-Like/);
    assert.match(html, /2 Passed/);

    // Offline verification: must not load remote CDN resources
    assert.ok(!html.includes('src="http://') && !html.includes('src="https://'), 'Must not load external media or scripts');
    assert.ok(!html.includes('href="http://') && !html.includes('href="https://'), 'Must not load external stylesheets');

    // Verify personal path is not in HTML
    assert.ok(!html.includes('secret_home_video'), 'Personal absolute path must not appear in HTML');
    assert.ok(!html.includes('alice'), 'Username must not appear in HTML');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
