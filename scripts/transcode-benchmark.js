#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveConfigFile,
  loadBenchmarkConfig,
  resolveTestMatrix,
  inspectActiveUburoomProcess,
  resolveUniqueOutputDir
} = require('./benchmark/config');
const { resolveTools, collectEnvironmentInfo } = require('./benchmark/tools');
const { probeAllEncoders, probeHwaccels } = require('./benchmark/prober');
const {
  inspectSourceVideo,
  generateSyntheticSource,
  extractReferenceSample,
  deriveOutputSpec
} = require('./benchmark/source');
const {
  runChunkedBenchmark,
  runContinuousBenchmark,
  extractScreenshot
} = require('./benchmark/runner');
const {
  detectQualityCapabilities,
  runQualityAnalysis
} = require('./benchmark/quality');
const {
  runConcurrentTier,
  runCapacityScan
} = require('./benchmark/concurrency');
const {
  generateJsonReport,
  generateCsvReport,
  generateHtmlReport
} = require('./benchmark/reporter');

function parseArgs(args) {
  const options = {
    input: null,
    config: null,
    start: 0,
    duration: 60,
    mode: 'chunks',
    allEncoders: false,
    allCodecs: false,
    qualities: null,
    encoders: null,
    codecs: null,
    output: null,
    runs: 1,
    probeOnly: false,
    dryRun: false,
    synthetic: false,
    ffmpeg: null,
    ffprobe: null,
    // Stage 2 additions
    concurrency: 1,
    capacityScan: false,
    maxConcurrency: 6,
    qualityMetrics: false,
    warmup: false,
    help: false
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--input' || arg === '-i') {
      options.input = args[++i];
    } else if (arg.startsWith('--input=')) {
      options.input = arg.slice(8);
    } else if (arg === '--config' || arg === '-c') {
      options.config = args[++i];
    } else if (arg.startsWith('--config=')) {
      options.config = arg.slice(9);
    } else if (arg === '--start') {
      options.start = Number(args[++i]);
    } else if (arg.startsWith('--start=')) {
      options.start = Number(arg.slice(8));
    } else if (arg === '--duration' || arg === '-d') {
      options.duration = Number(args[++i]);
    } else if (arg.startsWith('--duration=')) {
      options.duration = Number(arg.slice(11));
    } else if (arg === '--mode' || arg === '-m') {
      options.mode = args[++i];
    } else if (arg.startsWith('--mode=')) {
      options.mode = arg.slice(7);
    } else if (arg === '--all-encoders') {
      options.allEncoders = true;
    } else if (arg === '--all-codecs') {
      options.allCodecs = true;
    } else if (arg === '--qualities' || arg === '-q') {
      options.qualities = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--qualities=')) {
      options.qualities = arg.slice(12).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--encoders' || arg === '-e') {
      options.encoders = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--encoders=')) {
      options.encoders = arg.slice(11).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--codecs') {
      options.codecs = args[++i].split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg.startsWith('--codecs=')) {
      options.codecs = arg.slice(9).split(',').map(s => s.trim()).filter(Boolean);
    } else if (arg === '--output' || arg === '-o') {
      options.output = args[++i];
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice(9);
    } else if (arg === '--runs' || arg === '-r') {
      options.runs = Number(args[++i]);
    } else if (arg.startsWith('--runs=')) {
      options.runs = Number(arg.slice(7));
    } else if (arg === '--concurrency' || arg === '-j') {
      options.concurrency = Number(args[++i]);
    } else if (arg.startsWith('--concurrency=')) {
      options.concurrency = Number(arg.slice(14));
    } else if (arg === '--capacity-scan') {
      options.capacityScan = true;
    } else if (arg === '--max-concurrency') {
      options.maxConcurrency = Number(args[++i]);
    } else if (arg.startsWith('--max-concurrency=')) {
      options.maxConcurrency = Number(arg.slice(18));
    } else if (arg === '--allow-load-test') {
      options.allowLoadTest = true;
    } else if (arg === '--force-concurrent-with-server') {
      options.forceConcurrentWithServer = true;
    } else if (arg === '--quality-metrics' || arg === '-Q') {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        i++;
        options.qualityMetrics = next.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      } else {
        options.qualityMetrics = ['vmaf', 'ssim', 'psnr', 'cambi'];
      }
    } else if (arg.startsWith('--quality-metrics=')) {
      options.qualityMetrics = arg.slice(18).split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    } else if (arg === '--no-quality-metrics') {
      options.qualityMetrics = false;
    } else if (arg === '--warmup') {
      options.warmup = true;
    } else if (arg === '--probe-only') {
      options.probeOnly = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--synthetic') {
      options.synthetic = true;
    } else if (arg === '--ffmpeg') {
      options.ffmpeg = args[++i];
    } else if (arg.startsWith('--ffmpeg=')) {
      options.ffmpeg = arg.slice(9);
    } else if (arg === '--ffprobe') {
      options.ffprobe = args[++i];
    } else if (arg.startsWith('--ffprobe=')) {
      options.ffprobe = arg.slice(10);
    } else {
      console.warn(`[WARN] Unknown argument: ${arg}`);
    }
  }

  return options;
}

function printHelp() {
  console.log(`
uburoom Transcoding Benchmark — Stage 2
Standalone performance measurement, sustainable concurrency, and objective quality analysis

USAGE:
  node scripts/transcode-benchmark.js [OPTIONS]

PRIMARY OPTIONS:
  -i, --input <file>         Select a local video file to benchmark. If omitted,
                             a local synthetic test pattern is generated.
  -c, --config <file>        Select YAML configuration file (default: config.yaml
                             or fallback to config.example.yaml).
  -d, --duration <sec>       Duration of video sample in seconds (default: 60).
      --start <sec>          Start position in source video in seconds (default: 0).
  -m, --mode <mode>          Encoding methodology: chunks | continuous | both
                             (default: chunks).
      --all-encoders         Test all available hardware and software encoders for
                             the selected codecs.
      --all-codecs           Include all supported codecs (av1, vp9, vp8) beyond
                             the configured outputs list.
  -q, --qualities <list>     Comma-separated list of quality IDs or heights to test
                             (e.g., "1080p8,720p4" or "720p").
  -e, --encoders <list>      Comma-separated list of encoders to test (nvenc,qsv,software).
      --codecs <list>        Comma-separated list of codecs to test (av1,vp9,vp8).
  -o, --output <dir>         Output directory for artifacts and reports.
                             Collision-safe: automatically avoids overwriting files.
  -r, --runs <number>        Number of repetitions per configuration (default: 1).

STAGE 2 CONCURRENCY & CAPACITY:
  -j, --concurrency <N>      Run N independent transcode jobs simultaneously (default: 1).
      --capacity-scan        Progressively test increasing concurrency (1, 2, 3...) to discover
                             the machine's maximum sustainable transcode capacity.
      --max-concurrency <N>  Ceiling for capacity discovery scan (default: 6).
      --warmup               Run a short 1-chunk warmup before measured benchmark trials.

STAGE 2 OBJECTIVE QUALITY METRICS:
  -Q, --quality-metrics      Enable objective quality analysis (VMAF, SSIM, PSNR, CAMBI).
                             Scoring runs strictly after encoding and uses the untouched
                             master video as reference.
      --no-quality-metrics   Explicitly disable quality metrics analysis.

DIAGNOSTIC & TOOL OPTIONS:
      --probe-only           Probe available encoders and hardware acceleration,
                             print diagnostic results and exit.
      --dry-run              Print the resolved benchmark test matrix without encoding.
      --synthetic            Force generation and use of synthetic test pattern.
      --ffmpeg <path>        Explicit path to FFmpeg binary.
      --ffprobe <path>       Explicit path to FFprobe binary.
  -h, --help                 Show this documentation.
`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  // Input validation
  if (!Number.isFinite(options.duration) || options.duration <= 0) {
    throw new Error(`Invalid --duration "${options.duration}": must be a positive number of seconds.`);
  }
  if (!Number.isFinite(options.start) || options.start < 0) {
    throw new Error(`Invalid --start "${options.start}": must be a non-negative number of seconds.`);
  }
  if (!Number.isInteger(options.runs) || options.runs < 1) {
    throw new Error(`Invalid --runs "${options.runs}": must be a positive integer >= 1.`);
  }
  const ABSOLUTE_MAX_CONCURRENCY = 16;
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error(`Invalid --concurrency "${options.concurrency}": must be a positive integer >= 1.`);
  }
  if (options.concurrency > ABSOLUTE_MAX_CONCURRENCY) {
    throw new Error(`Requested --concurrency (${options.concurrency}) exceeds the safe operational ceiling (${ABSOLUTE_MAX_CONCURRENCY}).`);
  }
  if (!Number.isInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error(`Invalid --max-concurrency "${options.maxConcurrency}": must be a positive integer >= 1.`);
  }
  if (options.maxConcurrency > ABSOLUTE_MAX_CONCURRENCY) {
    throw new Error(`Requested --max-concurrency (${options.maxConcurrency}) exceeds the safe operational ceiling (${ABSOLUTE_MAX_CONCURRENCY}).`);
  }
  if (!['chunks', 'continuous', 'both'].includes(options.mode)) {
    throw new Error(`Invalid --mode "${options.mode}": must be one of "chunks", "continuous", or "both".`);
  }

  if (Array.isArray(options.qualityMetrics)) {
    const valid = ['vmaf', 'ssim', 'psnr', 'cambi'];
    for (const m of options.qualityMetrics) {
      if (!valid.includes(m)) {
        throw new Error(`Invalid metric in --quality-metrics: "${m}". Supported metrics: ${valid.join(', ')}`);
      }
    }
  }

  // 1. Process Safety Check
  const activeNodeCheck = inspectActiveUburoomProcess();
  if (activeNodeCheck.detected) {
    console.warn(`[WARNING] ${activeNodeCheck.message}`);
    if (options.capacityScan || options.concurrency > 1) {
      console.warn(`[WARNING] Heavy concurrent load testing requested while uburoom may be running.`);
      console.warn(`          Concurrent transcoding may contend for GPU/CPU resources with live viewers.\n`);
      if (!options.forceConcurrentWithServer) {
        throw new Error(`Concurrent load requested while uburoom is running on this machine. Pass --force-concurrent-with-server to acknowledge and proceed.`);
      }
    }
  }

  if (options.capacityScan && !options.allowLoadTest) {
    throw new Error(`Automatic capacity scanning executes progressive multi-process load. Pass --allow-load-test to acknowledge and proceed.`);
  }

  // Abort controller for clean child process termination
  const abortController = new AbortController();
  const onSignal = () => {
    console.log('\n[ABORT] Cancellation signal received. Terminating child processes and halting benchmark...');
    abortController.abort();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // 2. Configuration Resolution
  const configPath = resolveConfigFile(options.config);
  const benchmarkConfig = loadBenchmarkConfig(configPath);
  console.log(`Using configuration profile: ${benchmarkConfig.profileName}`);

  // 3. Resolve Tools & Environment
  const tools = resolveTools(benchmarkConfig.tools, {
    ffmpeg: options.ffmpeg,
    ffprobe: options.ffprobe
  });
  console.log(`FFmpeg:  ${tools.ffmpegVersion}`);
  console.log(`FFprobe: ${tools.ffprobeVersion}`);

  const envInfo = collectEnvironmentInfo();
  console.log(`Host:    ${envInfo.platform} (${envInfo.arch}) · ${envInfo.cpu.model} (${envInfo.cpu.cores} cores)`);
  console.log(`GPU:     ${envInfo.gpu}`);
  console.log(`Memory:  ${envInfo.memoryFreeMB} MB free / ${envInfo.memoryTotalMB} MB total`);

  // 4. Probe Encoders & Quality Filters
  console.log(`\nProbing encoder and filter capabilities...`);
  const probedEncoders = await probeAllEncoders(tools.ffmpeg);
  const probedHwaccels = probeHwaccels(tools.ffmpeg);
  const qualityCapabilities = detectQualityCapabilities(tools.ffmpeg);

  console.log(`\nDiscovered Encoders:`);
  for (const item of probedEncoders) {
    const status = item.available ? `[AVAILABLE]    (${item.durationMs}ms)` : `[UNAVAILABLE]  (${item.error || 'unknown error'})`;
    console.log(`  ${item.codec.toUpperCase().padEnd(5)} / ${item.encoder.padEnd(9)} (${item.ffmpegEncoder.padEnd(11)}): ${status}`);
  }
  console.log(`Hardware decode accelerators: ${probedHwaccels.join(', ') || 'none'}`);
  console.log(`Quality analysis metrics:     ${qualityCapabilities.availableMetrics.join(', ') || 'none'}`);

  if (options.probeOnly) {
    console.log(`\n--probe-only completed successfully.`);
    return;
  }

  // 5. Test Matrix Resolution
  const testMatrix = resolveTestMatrix(benchmarkConfig, {
    allCodecs: options.allCodecs,
    allEncoders: options.allEncoders,
    codecs: options.codecs,
    encoders: options.encoders,
    qualities: options.qualities
  });

  const runModes = options.mode === 'both' ? ['chunks', 'continuous'] : [options.mode];

  console.log(`\nResolved Test Matrix:`);
  console.log(`  Codecs:         ${testMatrix.targetCodecs.join(', ') || 'None'}`);
  console.log(`  Qualities:      ${testMatrix.targetQualities.map(q => q.label || q.id).join(', ') || 'None'}`);
  console.log(`  Modes:          ${runModes.join(', ')}`);
  console.log(`  Concurrency:    ${options.capacityScan ? `Capacity Scan (1 to ${options.maxConcurrency})` : options.concurrency}`);
  console.log(`  Quality Metrics:${options.qualityMetrics ? (Array.isArray(options.qualityMetrics) ? options.qualityMetrics.join(', ') : 'Enabled (vmaf, ssim, psnr, cambi)') : 'Disabled'}`);
  console.log(`  Configurations: ${testMatrix.configurations.length * runModes.length}`);

  if (!testMatrix.configurations.length) {
    console.log('\nNo matching transcode configurations to test. Exiting.');
    return;
  }

  if (options.dryRun) {
    console.log('\nConfigurations to be tested:');
    for (const c of testMatrix.configurations) {
      for (const m of runModes) {
        console.log(`  - [${m}] ${c.codec.toUpperCase()} (${c.requestedEncoder}) @ ${c.quality.label || c.quality.id}`);
      }
    }
    console.log('\n--dry-run requested. Exiting successfully.');
    return;
  }

  // 6. Output directory preparation (atomic, collision-free & safe)
  const outputResolution = resolveUniqueOutputDir(options.output, path.resolve(__dirname, '..'));
  const outputDir = outputResolution.dir;
  if (outputResolution.collisionAvoided) {
    console.log(`\n[NOTICE] Destination "${outputResolution.original}" exists and contains files.`);
    console.log(`Using collision-free unique output directory: ${outputDir}`);
  } else {
    console.log(`\nOutput directory: ${outputDir}`);
  }

  // 7. Source Media Resolution
  let sourceFilePath;
  let isSynthetic = false;

  if (options.input && !options.synthetic) {
    sourceFilePath = path.resolve(process.cwd(), options.input);
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error(`Input file not found: ${options.input}`);
    }
  } else {
    console.log('\nNo local input file specified (or --synthetic requested). Generating synthetic test source...');
    const requiredSec = Math.max(60, options.start + options.duration + 2);
    sourceFilePath = generateSyntheticSource(tools.ffmpeg, outputDir, requiredSec);
    isSynthetic = true;
  }

  const sourceInfo = inspectSourceVideo(tools.ffprobe, sourceFilePath);
  console.log(`\nSource Media Properties:`);
  console.log(`  File:       ${sourceInfo.fileName} (${(sourceInfo.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)`);
  console.log(`  Resolution: ${sourceInfo.video.resolution} @ ${sourceInfo.video.fps} fps (${sourceInfo.video.codec}) [${sourceInfo.video.isVfr ? 'VFR' : 'CFR'}]`);
  console.log(`  Color/HDR:  ${sourceInfo.hdr.label}`);
  console.log(`  Audio:      ${sourceInfo.audio.available ? `${sourceInfo.audio.count} stream(s)` : 'None (video-only)'}`);

  // Clamp duration to source length if necessary
  let sampleDuration = options.duration;
  const startOffset = Math.max(0, options.start);
  if (startOffset >= sourceInfo.durationSeconds) {
    throw new Error(`Start offset (${startOffset}s) exceeds source duration (${sourceInfo.durationSeconds.toFixed(1)}s).`);
  }
  if (startOffset + sampleDuration > sourceInfo.durationSeconds) {
    sampleDuration = Math.max(1, sourceInfo.durationSeconds - startOffset);
    console.log(`Clamped sample duration to ${sampleDuration.toFixed(1)}s to fit source length.`);
  }

  // Extract reference viewing proxy for web report comparison
  console.log('Extracting lightweight reference viewing proxy for offline report...');
  const refProxy = extractReferenceSample(tools, sourceInfo, startOffset, sampleDuration, outputDir);
  if (refProxy?.notice) {
    console.log(`[NOTICE] ${refProxy.notice}`);
  }

  // Extract reference screenshot from source
  const screenshotsDir = path.join(outputDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const refScreenshotPath = path.join(screenshotsDir, 'source-frame.jpg');
  const screenshotTimestamp = Math.min(sourceInfo.durationSeconds - 0.5, startOffset + sampleDuration * 0.5);
  extractScreenshot(tools.ffmpeg, sourceFilePath, screenshotTimestamp, refScreenshotPath);

  const screenshots = [];
  if (fs.existsSync(refScreenshotPath)) {
    screenshots.push({
      label: `Source Reference Frame (${sourceInfo.fileName})`,
      timestampSeconds: Math.round(screenshotTimestamp * 10) / 10,
      relativePath: path.relative(outputDir, refScreenshotPath).replace(/\\/g, '/')
    });
  }

  // Optional Encoder Warm-Up
  if (options.warmup && testMatrix.configurations.length > 0) {
    console.log('\n[WARMUP] Executing 1-chunk encoder warm-up...');
    try {
      const warmupConfig = testMatrix.configurations[0];
      await runChunkedBenchmark(tools, sourceInfo, warmupConfig, {
        startOffset,
        sampleDuration: 6,
        runIndex: 0,
        hardwareDecode: benchmarkConfig.transcoding.hardwareDecode,
        cpuFallback: benchmarkConfig.transcoding.cpuFallback,
        outputDir,
        probedEncoders
      });
      console.log('[WARMUP] Warm-up complete.\n');
    } catch (warmupErr) {
      console.log(`[WARMUP] Warm-up encountered error (non-fatal): ${warmupErr.message}\n`);
    }
  }

  // 8. Execute Benchmark Runs
  const benchmarkResults = [];
  let concurrencySummary = null;

  if (options.capacityScan) {
    // Stage 2: Progressive Capacity Discovery Scan
    const primaryConfig = testMatrix.configurations[0];
    console.log(`\n===========================================================`);
    console.log(`   Executing Sustainable Capacity Scan`);
    console.log(`   Target: ${primaryConfig.codec.toUpperCase()} (${primaryConfig.requestedEncoder}) @ ${primaryConfig.quality.label || primaryConfig.quality.id}`);
    console.log(`   Scanning concurrency 1 to ${options.maxConcurrency}...`);
    console.log(`===========================================================\n`);

    const scanResult = await runCapacityScan({
      maxConcurrency: options.maxConcurrency,
      tools,
      source: sourceInfo,
      testConfig: primaryConfig,
      sampleDuration,
      startOffset,
      hardwareDecode: benchmarkConfig.transcoding.hardwareDecode,
      cpuFallback: benchmarkConfig.transcoding.cpuFallback,
      probedEncoders,
      outputDir,
      signal: abortController.signal,
      mode: options.mode === 'continuous' ? 'continuous' : 'chunks',
      onTierStart: (c, max) => {
        process.stdout.write(`Testing Concurrency ${c}/${max}... `);
      },
      onTierComplete: tier => {
        const passText = tier.isSustainable ? 'PASS' : 'FAIL';
        console.log(`[${passText}] ${tier.passedWorkers}/${tier.concurrency} passed | Throughput: ${tier.aggregateThroughputMultiplier}x | Slowest: ${tier.minWorkerSpeed}x | Deadlines missed: ${tier.totalDeadlineMisses}`);
        if (!tier.isSustainable && tier.failureReason) {
          console.log(`   -> Stopping rule triggered: ${tier.failureReason}`);
        }
      }
    });

    concurrencySummary = scanResult;

    // Collect all worker results across tested tiers
    for (const tier of scanResult.testedTiers) {
      for (const w of tier.workers) {
        benchmarkResults.push(w);
      }
    }

    console.log(`\nCapacity Scan Complete!`);
    console.log(`Highest Sustainable Concurrency: ${scanResult.highestSustainableConcurrency} simultaneous stream(s)`);
    if (scanResult.firstFailingConcurrency) {
      console.log(`First Failing Concurrency:       ${scanResult.firstFailingConcurrency} simultaneous stream(s) (${scanResult.stoppingReason})`);
    }
  } else if (options.concurrency > 1) {
    // Stage 2: Fixed N-Worker Concurrency Run
    console.log(`\n===========================================================`);
    console.log(`   Executing Concurrent Benchmark (${options.concurrency} simultaneous workers)`);
    console.log(`===========================================================\n`);

    const concurrencyTrials = [];
    for (let run = 1; run <= options.runs; run++) {
      for (const testConfig of testMatrix.configurations) {
        for (const mode of runModes) {
          const runTag = options.runs > 1 ? ` [Run ${run}/${options.runs}]` : '';
          console.log(`Launching ${options.concurrency} concurrent workers for ${testConfig.codec.toUpperCase()} (${testConfig.requestedEncoder}) @ ${testConfig.quality.label || testConfig.quality.id} [${mode}]${runTag}...`);
          const tierResult = await runConcurrentTier({
            concurrency: options.concurrency,
            runIndex: run,
            tools,
            source: sourceInfo,
            testConfig,
            sampleDuration,
            startOffset,
            hardwareDecode: benchmarkConfig.transcoding.hardwareDecode,
            cpuFallback: benchmarkConfig.transcoding.cpuFallback,
            probedEncoders,
            outputDir,
            signal: abortController.signal,
            mode
          });

          console.log(`   -> ${tierResult.passedWorkers}/${options.concurrency} passed | Aggregate throughput: ${tierResult.aggregateThroughputMultiplier}x | Slowest: ${tierResult.minWorkerSpeed}x | Deadlines missed: ${tierResult.totalDeadlineMisses}`);

          for (const w of tierResult.workers) {
            benchmarkResults.push(w);
          }
          concurrencyTrials.push(tierResult);
        }
      }
    }

    concurrencySummary = {
      isCapacityScan: false,
      concurrency: options.concurrency,
      trials: concurrencyTrials,
      highestSustainableConcurrency: concurrencyTrials.every(t => t.isSustainable) ? options.concurrency : 0,
      totalTrials: concurrencyTrials.length,
      passedTrials: concurrencyTrials.filter(t => t.isSustainable).length,
      stoppingReason: concurrencyTrials.every(t => t.isSustainable) ? null : concurrencyTrials.find(t => !t.isSustainable)?.failureReason,
      estimateNotice: 'Short-run capacity estimate based on chunk deadline preservation. Long-term production capacity requires extended thermal and memory soak testing.'
    };
  } else {
    // Stage 1: Standard Single-Stream Execution
    const totalTests = testMatrix.configurations.length * runModes.length * options.runs;
    let testIndex = 0;

    console.log(`\n===========================================================`);
    console.log(`   Executing Benchmark Runs (${totalTests} total, ${options.runs} run${options.runs > 1 ? 's' : ''})`);
    console.log(`===========================================================\n`);

    for (let run = 1; run <= options.runs; run++) {
      for (const testConfig of testMatrix.configurations) {
        const probeCheck = probedEncoders.find(p => p.codec === testConfig.codec && p.encoder === testConfig.requestedEncoder);
        if (probeCheck && !probeCheck.available && (!testConfig.allowFallback || options.allEncoders)) {
          console.log(`[SKIP] ${testConfig.codec.toUpperCase()} (${testConfig.requestedEncoder}) is unavailable on this machine.`);
          benchmarkResults.push({
            runIndex: run,
            configId: `${testConfig.id}${options.runs > 1 ? `-r${run}` : ''}`,
            mode: 'skipped',
            status: 'skipped',
            codec: testConfig.codec,
            requestedEncoder: testConfig.requestedEncoder,
            actualEncoder: null,
            quality: testConfig.quality,
            error: `Encoder ${testConfig.requestedEncoder} is unavailable on this machine.`
          });
          continue;
        }

        for (const mode of runModes) {
          testIndex++;
          const runTag = options.runs > 1 ? ` [Run ${run}/${options.runs}]` : '';
          const label = `[${testIndex}/${totalTests}]${runTag} ${testConfig.codec.toUpperCase()} (${testConfig.requestedEncoder}) @ ${testConfig.quality.label || testConfig.quality.id} [${mode}]`;
          console.log(`${label}...`);

          let result;
          try {
            if (mode === 'chunks') {
              result = await runChunkedBenchmark(tools, sourceInfo, testConfig, {
                startOffset,
                sampleDuration,
                runIndex: run,
                hardwareDecode: benchmarkConfig.transcoding.hardwareDecode,
                cpuFallback: benchmarkConfig.transcoding.cpuFallback,
                outputDir,
                probedEncoders,
                onProgress: prog => {
                  const pct = Math.round(((prog.chunkIndex + 1) / prog.totalChunks) * 100);
                  process.stdout.write(`   Chunk ${prog.chunkIndex + 1}/${prog.totalChunks} (${pct}%): ${prog.encodeDurationSec.toFixed(2)}s (${prog.realTimeSpeed.toFixed(2)}x)${prog.deadlineMissed ? ' [MISSED DEADLINE]' : ''}\r`);
                }
              });
              process.stdout.write('\n');
            } else {
              result = await runContinuousBenchmark(tools, sourceInfo, testConfig, {
                startOffset,
                sampleDuration,
                runIndex: run,
                hardwareDecode: benchmarkConfig.transcoding.hardwareDecode,
                cpuFallback: benchmarkConfig.transcoding.cpuFallback,
                outputDir,
                probedEncoders
              });
            }

            const perf = result.performance;
            if (result.status === 'pass') {
              const retryNote = perf.totalEncodingTimeSec > perf.successfulEncodeTimeSec
                ? ` (Total elapsed: ${perf.totalEncodingTimeSec}s, ${perf.totalElapsedSpeedMultiplier}x)`
                : '';
              const startupNote = perf.firstChunkStartupSec !== null && perf.firstChunkStartupSec > perf.firstChunkDurationSec
                ? ` | 1st chunk startup: ${perf.firstChunkStartupSec}s`
                : (perf.firstChunkDurationSec ? ` | 1st chunk: ${perf.firstChunkDurationSec}s` : '');
              console.log(`   -> PASS in ${perf.successfulEncodeTimeSec}s | Speed: ${perf.speedMultiplier}x${retryNote} | FPS: ${perf.effectiveFps}${startupNote} | Deadlines missed: ${perf.deadlineMisses}`);
            } else {
              const failReason = result.error || (result.validation?.errors?.length ? result.validation.errors.join('; ') : 'Validation failed');
              console.log(`   -> FAIL: ${failReason}`);
            }

            if (result.fallbackEvents?.length) {
              for (const f of result.fallbackEvents) {
                console.log(`   [NOTICE] Fallback occurred: ${f.from} -> ${f.to} (${f.reason})`);
              }
            }

            benchmarkResults.push(result);
          } catch (err) {
            console.log(`   -> FAIL: ${err.message}`);
            benchmarkResults.push({
              runIndex: run,
              configId: `${testConfig.id}-${mode}${options.runs > 1 ? `-r${run}` : ''}`,
              mode,
              status: 'fail',
              codec: testConfig.codec,
              requestedEncoder: testConfig.requestedEncoder,
              actualEncoder: null,
              quality: testConfig.quality,
              error: err.message
            });
          }
        }
      }
    }
  }

  // Extract representative screenshots from all successful outputs (single-stream, concurrent, capacity)
  for (const result of benchmarkResults) {
    if (result.status === 'pass' && result.output?.assembledFile) {
      const targetVideoPath = path.join(outputDir, result.output.assembledFile);
      if (fs.existsSync(targetVideoPath)) {
        const rIndex = result.runIndex || 1;
        const workerTag = result.workerId ? `-worker-${result.workerId}` : '';
        const tierTag = result.tierIndex ? `-tier-${result.tierIndex}` : (result.concurrency && result.concurrency > 1 ? `-c${result.concurrency}` : '');
        const shotFilename = `run-${rIndex}${tierTag}${workerTag}-${result.configId}-frame.jpg`;
        const shotPath = path.join(screenshotsDir, shotFilename);
        if (!fs.existsSync(shotPath)) {
          const shotTimestamp = Math.min(30, Math.max(1, Math.floor(sampleDuration * 0.5)));
          if (extractScreenshot(tools.ffmpeg, targetVideoPath, shotTimestamp, shotPath)) {
            screenshots.push({
              label: `${result.codec.toUpperCase()} (${result.actualEncoder}) ${result.quality?.label || result.quality?.id}${tierTag ? ` [${tierTag.slice(1)}]` : ''}${workerTag ? ` [${workerTag.slice(1)}]` : ''}${rIndex > 1 ? ` (Run ${rIndex})` : ''}`,
              timestampSeconds: Math.round(shotTimestamp * 10) / 10,
              relativePath: path.relative(outputDir, shotPath).replace(/\\/g, '/')
            });
          }
        }
      }
    }
  }

  // 9. Objective Quality Metrics Analysis (Stage 2)
  if (options.qualityMetrics) {
    const selectedMetricsList = Array.isArray(options.qualityMetrics)
      ? options.qualityMetrics
      : ['vmaf', 'ssim', 'psnr', 'cambi'];

    console.log(`\n===========================================================`);
    console.log(`   Evaluating Objective Video Quality (${selectedMetricsList.join(', ').toUpperCase()})`);
    console.log(`   Reference: ${sourceInfo.fileName} (untouched master)`);
    console.log(`===========================================================\n`);

    for (const r of benchmarkResults) {
      if (r.status !== 'pass' || !r.output?.assembledFile) continue;
      const assembledFullPath = path.join(outputDir, r.output.assembledFile);
      if (!fs.existsSync(assembledFullPath)) continue;

      const qOutputDir = path.dirname(assembledFullPath);
      process.stdout.write(`Analyzing ${r.codec.toUpperCase()} (${r.actualEncoder}) @ ${r.quality?.label || r.quality?.id}... `);

      const qResult = await runQualityAnalysis(tools.ffmpeg, {
        source: sourceInfo,
        encodedFilePath: assembledFullPath,
        startOffset,
        sampleDuration,
        targetQuality: r.quality,
        outputDir: qOutputDir,
        capabilities: qualityCapabilities,
        selectedMetrics: selectedMetricsList,
        signal: abortController.signal
      });

      r.qualityMetrics = qResult;

      if (qResult.available && qResult.status === 'pass') {
        const vmafStr = qResult.vmaf?.mean ? `VMAF ${qResult.vmaf.mean} (p1: ${qResult.vmaf.p1}, min: ${qResult.vmaf.min})` : '';
        const ssimStr = qResult.ssim?.mean ? `SSIM ${qResult.ssim.mean}` : '';
        const psnrStr = qResult.psnr?.mean ? `PSNR ${qResult.psnr.mean} dB` : '';
        const cambiStr = qResult.cambi?.mean ? `CAMBI ${qResult.cambi.mean}` : '';
        const parts = [vmafStr, ssimStr, psnrStr, cambiStr].filter(Boolean);
        console.log(`[PASS] ${parts.join(' | ')}`);
      } else {
        console.log(`[${qResult.status ? qResult.status.toUpperCase() : 'SKIPPED'}] ${qResult.reason || 'Not evaluated'}`);
      }
    }
  }

  // Summary counts
  const passedCount = benchmarkResults.filter(r => r.status === 'pass').length;
  const failedCount = benchmarkResults.filter(r => r.status === 'fail').length;
  const skippedCount = benchmarkResults.filter(r => r.status === 'skipped').length;
  console.log(`\nBenchmark Summary: ${benchmarkResults.length} total | ${passedCount} passed | ${failedCount} failed | ${skippedCount} skipped\n`);

  // 10. Generate Reports
  console.log(`===========================================================`);
  console.log(`   Generating Benchmark Reports (JSON, CSV, HTML)`);
  console.log(`===========================================================\n`);

  const benchmarkPayload = {
    schemaVersion: '2.0.0',
    benchmarkVersion: 'Stage 2',
    configProfile: benchmarkConfig.profileName,
    sampleDuration,
    startOffset,
    options: {
      mode: options.mode,
      runs: options.runs,
      concurrency: options.concurrency,
      capacityScan: options.capacityScan,
      maxConcurrency: options.maxConcurrency,
      qualityMetrics: Boolean(options.qualityMetrics)
    },
    tools: {
      ffmpeg: tools.ffmpeg,
      ffprobe: tools.ffprobe,
      ffmpegVersion: tools.ffmpegVersion,
      ffprobeVersion: tools.ffprobeVersion
    },
    environment: envInfo,
    transcodingSettings: benchmarkConfig.transcoding,
    source: {
      fileName: sourceInfo.fileName,
      durationSeconds: sourceInfo.durationSeconds,
      video: sourceInfo.video,
      hdr: sourceInfo.hdr,
      referenceVideoRelative: refProxy?.relativePath || null,
      referenceNotice: refProxy?.notice || null
    },
    probedEncoders,
    concurrencySummary,
    screenshots,
    results: benchmarkResults
  };

  const jsonPath = path.join(outputDir, 'results.json');
  const csvPath = path.join(outputDir, 'results.csv');
  const htmlPath = path.join(outputDir, 'report.html');

  generateJsonReport(benchmarkPayload, jsonPath);
  generateCsvReport(benchmarkPayload, csvPath);
  generateHtmlReport(benchmarkPayload, htmlPath);

  console.log(`[OK] results.json generated: ${jsonPath}`);
  console.log(`[OK] results.csv  generated: ${csvPath}`);
  console.log(`[OK] report.html  generated: ${htmlPath}`);

  console.log(`\nBenchmark run complete! View the interactive report by opening:\n  file:///${htmlPath.replace(/\\/g, '/')}\n`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`\n[FATAL ERROR] ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { main };
