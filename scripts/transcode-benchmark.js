#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  resolveConfigFile,
  loadBenchmarkConfig,
  resolveTestMatrix,
  inspectActiveUburoomProcess
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
uburoom Transcoding Benchmark — Stage 1
Standalone performance measurement and output comparison tool for uburoom

USAGE:
  node scripts/transcode-benchmark.js [OPTIONS]

OPTIONS:
  -i, --input <file>         Select a local video file to benchmark. If omitted,
                             a local synthetic test pattern is generated.
  -c, --config <file>        Select YAML configuration file (default: config.yaml
                             or fallback to config.example.yaml).
  -d, --duration <sec>       Duration of sample segment in seconds (default: 60).
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
  -o, --output <dir>         Output directory for artifacts and reports
                             (default: artifacts/transcode-benchmark/run-<timestamp>/).
  -r, --runs <number>        Number of repetitions per configuration (default: 1).
      --probe-only           Probe available encoders and hardware acceleration,
                             print diagnostic results and exit.
      --dry-run              Print the resolved benchmark test matrix without encoding.
      --synthetic            Force generation and use of synthetic test pattern.
      --ffmpeg <path>        Explicit path to FFmpeg binary.
      --ffprobe <path>       Explicit path to FFprobe binary.
  -h, --help                 Show this documentation.

EXAMPLES:
  # Quick baseline benchmark using synthetic 60-second video:
  node scripts/transcode-benchmark.js

  # Benchmark a custom movie clip for 1080p and 720p:
  node scripts/transcode-benchmark.js --input "C:/videos/sample.mkv" --start 120 --duration 60 --qualities 1080p8,720p4

  # Compare all available encoders (NVENC, QSV, Software) across all codecs:
  node scripts/transcode-benchmark.js --all-encoders --all-codecs --mode both

  # Probe hardware capabilities only:
  node scripts/transcode-benchmark.js --probe-only
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
  if (!['chunks', 'continuous', 'both'].includes(options.mode)) {
    throw new Error(`Invalid --mode "${options.mode}": must be one of "chunks", "continuous", or "both".`);
  }

  console.log('===========================================================');
  console.log('   uburoom Transcoding Benchmark Suite (Stage 1)');
  console.log('===========================================================');

  // 1. Passive process check
  const activeProc = inspectActiveUburoomProcess();
  if (activeProc.detected) {
    console.log(`\n[WARNING] ${activeProc.message}\n`);
  }

  // 2. Configuration loading
  const configPath = resolveConfigFile(options.config);
  const benchmarkConfig = loadBenchmarkConfig(configPath);
  console.log(`Using configuration profile: ${benchmarkConfig.profileName}`);

  // 3. Tool resolution
  const tools = resolveTools(benchmarkConfig.tools, {
    ffmpeg: options.ffmpeg,
    ffprobe: options.ffprobe
  });
  console.log(`FFmpeg:  ${tools.ffmpegVersion}`);
  console.log(`FFprobe: ${tools.ffprobeVersion}`);

  // 4. System Environment
  const envInfo = collectEnvironmentInfo();
  console.log(`Host:    ${envInfo.platform} (${envInfo.arch}) · ${envInfo.cpu.model} (${envInfo.cpu.cores} cores)`);
  console.log(`GPU:     ${envInfo.gpu}`);
  console.log(`Memory:  ${envInfo.memoryFreeMB} MB free / ${envInfo.memoryTotalMB} MB total`);

  // 5. Hardware & Encoder Probing
  console.log('\nProbing encoder capabilities...');
  const probedEncoders = await probeAllEncoders(tools.ffmpeg);
  const hwaccels = probeHwaccels(tools.ffmpeg);

  console.log('\nDiscovered Encoders:');
  for (const p of probedEncoders) {
    const status = p.available ? '[AVAILABLE]' : '[UNAVAILABLE]';
    const detail = p.available ? `(${p.durationMs}ms)` : `(${p.error || 'unsupported'})`;
    console.log(`  ${p.codec.toUpperCase().padEnd(5)} / ${p.encoder.padEnd(9)} (${p.ffmpegEncoder.padEnd(11)}): ${status.padEnd(14)} ${detail}`);
  }
  console.log(`Hardware decode accelerators: ${hwaccels.join(', ') || 'none'}`);

  if (options.probeOnly) {
    console.log('\n--probe-only requested. Exiting successfully.');
    return;
  }

  // 6. Test Matrix Resolution
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

  // 7. Output directory preparation
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const defaultOutputDir = path.resolve(__dirname, '..', 'artifacts', 'transcode-benchmark', `run-${timestamp}`);
  const outputDir = path.resolve(process.cwd(), options.output || defaultOutputDir);
  fs.mkdirSync(outputDir, { recursive: true });
  console.log(`\nOutput directory: ${outputDir}`);

  // 8. Source Media Resolution
  let sourceFilePath;
  let isSynthetic = false;

  if (options.input && !options.synthetic) {
    sourceFilePath = path.resolve(process.cwd(), options.input);
    if (!fs.existsSync(sourceFilePath)) {
      throw new Error(`Input file not found: ${options.input}`);
    }
  } else {
    console.log('\nNo local input file specified (or --synthetic requested). Generating synthetic test source...');
    // Ensure synthetic video is long enough for startOffset + sampleDuration
    const requiredSec = Math.max(60, options.start + options.duration + 2);
    sourceFilePath = generateSyntheticSource(tools.ffmpeg, outputDir, requiredSec);
    isSynthetic = true;
  }

  const sourceInfo = inspectSourceVideo(tools.ffprobe, sourceFilePath);
  console.log(`\nSource Media Properties:`);
  console.log(`  File:       ${sourceInfo.fileName} (${(sourceInfo.fileSizeBytes / (1024 * 1024)).toFixed(1)} MB)`);
  console.log(`  Resolution: ${sourceInfo.video.resolution} @ ${sourceInfo.video.fps} fps (${sourceInfo.video.codec})`);
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

  // Extract reference sample clip for web report comparison
  console.log('Extracting lightweight reference sample for offline report...');
  const refSampleRelative = extractReferenceSample(tools, sourceInfo, startOffset, sampleDuration, outputDir);

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

  // 9. Execute Benchmark Runs
  const benchmarkResults = [];
  const totalTests = testMatrix.configurations.length * runModes.length * options.runs;
  let testIndex = 0;

  console.log(`\n===========================================================`);
  console.log(`   Executing Benchmark Runs (${totalTests} total, ${options.runs} run${options.runs > 1 ? 's' : ''})`);
  console.log(`===========================================================\n`);

  for (let run = 1; run <= options.runs; run++) {
    for (const testConfig of testMatrix.configurations) {
      // Check if requested encoder is available
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
          console.log(`   -> PASS in ${perf.totalEncodingTimeSec}s | Speed: ${perf.speedMultiplier}x | FPS: ${perf.effectiveFps} | Deadlines missed: ${perf.deadlineMisses}`);
          if (result.fallbackEvents?.length) {
            for (const f of result.fallbackEvents) {
              console.log(`   [NOTICE] Fallback occurred: ${f.from} -> ${f.to} (${f.reason})`);
            }
          }

          // Extract screenshot from transcoded output
          const targetVideoPath = result.output?.assembledFile ? path.join(outputDir, result.output.assembledFile) : null;
          if (targetVideoPath && fs.existsSync(targetVideoPath)) {
            const shotPath = path.join(screenshotsDir, `run-${run}-${result.configId}-frame.jpg`);
            if (extractScreenshot(tools.ffmpeg, targetVideoPath, sampleDuration * 0.5, shotPath)) {
              screenshots.push({
                label: `${testConfig.codec.toUpperCase()} (${result.actualEncoder}) ${testConfig.quality.label || testConfig.quality.id}${options.runs > 1 ? ` [Run ${run}]` : ''}`,
                timestampSeconds: Math.round(sampleDuration * 0.5 * 10) / 10,
                relativePath: path.relative(outputDir, shotPath).replace(/\\/g, '/')
              });
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

  // 10. Generate Reports
  console.log(`\n===========================================================`);
  console.log(`   Generating Benchmark Reports`);
  console.log(`===========================================================\n`);

  const benchmarkPayload = {
    benchmarkVersion: 'Stage 1',
    configProfile: benchmarkConfig.profileName,
    sampleDuration,
    startOffset,
    options: {
      mode: options.mode,
      runs: options.runs
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
      referenceVideoRelative: refSampleRelative
    },
    probedEncoders,
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
