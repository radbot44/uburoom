'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {
  CHUNK,
  AUDIO_LEAD,
  encoderArgs,
  rateArgs,
  decodeRoute,
  cpuPlaceboRoute
} = require('../../server/av1');
const { deriveOutputSpec } = require('./source');
const { spawnSafe } = require('./tools');

/**
 * Calculates statistical percentiles (mean, median, p95, max) from a list of numbers.
 */
function calculateStats(numbers) {
  if (!numbers || !numbers.length) {
    return { mean: 0, median: 0, p95: 0, max: 0 };
  }
  const sorted = [...numbers].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  const p95 = sorted[p95Index];
  const max = sorted[sorted.length - 1];

  return {
    mean: Math.round(mean * 1000) / 1000,
    median: Math.round(median * 1000) / 1000,
    p95: Math.round(p95 * 1000) / 1000,
    max: Math.round(max * 1000) / 1000
  };
}

/**
 * Executes a chunked benchmark run modeling uburoom's 6-second WebM chunk conversion.
 */
async function runChunkedBenchmark(tools, sourceInfo, testConfig, options = {}) {
  const {
    startOffset = 0,
    sampleDuration = 60,
    hardwareDecode = true,
    cpuFallback = true,
    outputDir,
    onProgress,
    probedEncoders = []
  } = options;

  const { codec, requestedEncoder, quality } = testConfig;
  const configId = `${codec}-${requestedEncoder}-${quality.id}-chunked`;
  const runOutputDir = path.join(outputDir, 'outputs', configId);
  const chunksDir = path.join(runOutputDir, 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });

  const rawSpec = deriveOutputSpec(sourceInfo, quality.id);
  const specForRoute = {
    ...rawSpec,
    width: rawSpec.targetWidth,
    height: rawSpec.targetHeight,
    bitrate: rawSpec.targetBitrateKbps,
    sourceFormat: rawSpec.sourceFormat,
    doviP5: sourceInfo.hdr?.doviP5,
    hdr: rawSpec.hdr,
    tonemap: rawSpec.tonemap,
    filter: rawSpec.filter
  };

  let actualEncoder = requestedEncoder;
  if (requestedEncoder === 'auto' || requestedEncoder === 'hardware') {
    const preferred = codec === 'av1' ? ['qsv', 'nvenc'] : codec === 'vp9' ? ['qsv'] : [];
    const found = preferred.find(enc => probedEncoders.find(p => p.codec === codec && p.encoder === enc && p.available));
    actualEncoder = found || (cpuFallback ? 'software' : preferred[0] || 'software');
  }

  // Determine decode routes (mirroring server/av1.js)
  const candidateRoutes = [];
  if (hardwareDecode) {
    const hwRoute = decodeRoute(specForRoute, actualEncoder);
    if (hwRoute) candidateRoutes.push(hwRoute);
  }
  candidateRoutes.push(undefined); // CPU route fallback

  const numChunks = Math.ceil(sampleDuration / CHUNK);
  const chunkResults = [];
  let fallbackEvent = null;
  let activeRoute = candidateRoutes[0];

  const totalRunStartHr = process.hrtime.bigint();

  for (let i = 0; i < numChunks; i++) {
    const chunkStart = startOffset + i * CHUNK;
    const chunkDuration = Math.min(CHUNK, sampleDuration - i * CHUNK);
    const chunkFile = path.join(chunksDir, `chunk-${String(i).padStart(3, '0')}.webm`);

    const buildArgs = (encoderToUse, route) => {
      const vFilter = route?.filter || rawSpec.filter;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-threads', '2',
        ...(route?.input || []),
        '-ss', String(chunkStart), '-i', sourceInfo.filePath
      ];

      if (rawSpec.hasAudio) {
        args.push(
          '-ss', String(Math.max(0, chunkStart - AUDIO_LEAD)), '-i', sourceInfo.filePath
        );
      }

      args.push(
        '-t', String(chunkDuration),
        '-map', '0:v:0', '-an', '-filter_threads', '2', '-vf', vFilter,
        '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        ...encoderArgs(encoderToUse, codec),
        ...rateArgs(encoderToUse, codec, rawSpec.targetBitrateKbps)
      );

      if (rawSpec.frameRate) {
        args.push('-r', rawSpec.frameRate, '-fps_mode', 'cfr');
      }

      args.push(
        '-g', '180',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'
      );

      if (rawSpec.hasAudio) {
        args.push(
          '-map', '1:a:0',
          '-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-ar', '48000',
          '-af', 'asetpts=PTS-STARTPTS'
        );
      }

      args.push('-f', 'webm', '-cluster_time_limit', '1000', chunkFile);
      return args;
    };

    let encoded = false;
    let encodeDurationSec = 0;
    let attempts = 0;

    while (!encoded && attempts < 4) {
      attempts++;
      const currentArgs = buildArgs(actualEncoder, activeRoute);
      let stderrOutput = '';

      const t0 = process.hrtime.bigint();
      try {
        await spawnSafe(tools.ffmpeg, currentArgs, {
          timeout: 45000,
          onStderr: chunk => { stderrOutput += chunk.toString(); }
        });
        if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size < 100) {
          throw new Error('FFmpeg completed but chunk output file is missing or empty.');
        }
        const t1 = process.hrtime.bigint();
        encodeDurationSec = Number(t1 - t0) / 1e9;
        encoded = true;
      } catch (err) {
        // Step down route first (hardware decode -> CPU decode)
        if (activeRoute && candidateRoutes.length > 1) {
          activeRoute = undefined;
          fallbackEvent = {
            from: 'hardware-decode',
            to: 'cpu-decode',
            reason: `Hardware decode route failed: ${err.message}`
          };
          continue;
        }

        // Then step down encoder (hardware encoder -> CPU software encoder)
        if (actualEncoder !== 'software' && cpuFallback) {
          const prev = actualEncoder;
          actualEncoder = 'software';
          activeRoute = undefined;
          fallbackEvent = {
            from: prev,
            to: 'software',
            reason: `Hardware encoder (${prev}) failed: ${stderrOutput.slice(-200) || err.message}`
          };
          continue;
        }

        // Fatal chunk failure
        throw new Error(`Chunk ${i} encoding failed (${actualEncoder}/${codec}): ${err.message}\n${stderrOutput.slice(-300)}`);
      }
    }

    const chunkSizeBytes = fs.existsSync(chunkFile) ? fs.statSync(chunkFile).size : 0;
    const realTimeSpeed = chunkDuration / encodeDurationSec;
    const deadlineMissed = encodeDurationSec > chunkDuration;

    chunkResults.push({
      index: i,
      chunkStart,
      chunkDuration,
      encodeDurationSec: Math.round(encodeDurationSec * 1000) / 1000,
      realTimeSpeed: Math.round(realTimeSpeed * 100) / 100,
      deadlineMissed,
      sizeBytes: chunkSizeBytes,
      relativePath: path.relative(outputDir, chunkFile).replace(/\\/g, '/')
    });

    onProgress?.({
      type: 'chunk',
      configId,
      chunkIndex: i,
      totalChunks: numChunks,
      encodeDurationSec,
      realTimeSpeed,
      deadlineMissed
    });
  }

  const totalRunDurationSec = Number(process.hrtime.bigint() - totalRunStartHr) / 1e9;
  const chunkTimes = chunkResults.map(c => c.encodeDurationSec);
  const stats = calculateStats(chunkTimes);
  const totalBytes = chunkResults.reduce((acc, c) => acc + c.sizeBytes, 0);
  const deadlineMissCount = chunkResults.filter(c => c.deadlineMissed).length;
  const totalFrames = Math.round(sampleDuration * (sourceInfo.video.fps || 30));
  const effectiveFps = Math.round((totalFrames / totalRunDurationSec) * 100) / 100;
  const speedMultiplier = Math.round((sampleDuration / totalRunDurationSec) * 100) / 100;
  const actualBitrateKbps = Math.round((totalBytes * 8) / (sampleDuration * 1000));

  // Assemble measured chunks into a seekable review file without re-encoding
  const assembledFile = path.join(runOutputDir, 'assembled.webm');
  const concatListFile = path.join(runOutputDir, 'chunks-list.txt');
  const listLines = chunkResults.map(c => `file '${path.resolve(path.join(outputDir, c.relativePath)).replace(/\\/g, '/')}'`);
  fs.writeFileSync(concatListFile, listLines.join('\n') + '\n', 'utf8');

  let assembledSuccess = false;
  let assembledDuration = 0;
  try {
    cp.execFileSync(tools.ffmpeg, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'concat', '-safe', '0',
      '-i', concatListFile,
      '-c', 'copy',
      assembledFile
    ], { windowsHide: true, timeout: 20000 });

    const probeRaw = cp.execFileSync(tools.ffprobe, [
      '-v', 'error',
      '-show_entries', 'format=duration:stream=codec_type',
      '-of', 'json',
      assembledFile
    ], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    const probe = JSON.parse(probeRaw);
    assembledDuration = Number(probe?.format?.duration) || 0;
    assembledSuccess = assembledDuration > 0 && fs.statSync(assembledFile).size > 1000;
  } catch (err) {
    assembledSuccess = false;
  }

  return {
    configId,
    mode: 'chunked',
    status: 'pass',
    codec,
    requestedEncoder,
    actualEncoder,
    fallback: fallbackEvent,
    quality: {
      id: quality.id,
      label: quality.label,
      width: rawSpec.targetWidth,
      height: rawSpec.targetHeight,
      targetBitrateKbps: rawSpec.targetBitrateKbps
    },
    performance: {
      sampleDuration,
      totalEncodingTimeSec: Math.round(totalRunDurationSec * 1000) / 1000,
      effectiveFps,
      speedMultiplier,
      firstChunkDurationSec: chunkResults[0]?.encodeDurationSec || 0,
      meanChunkSec: stats.mean,
      medianChunkSec: stats.median,
      p95ChunkSec: stats.p95,
      maxChunkSec: stats.max,
      deadlineMisses: deadlineMissCount,
      totalBytes,
      actualBitrateKbps
    },
    output: {
      assembledFile: assembledSuccess ? path.relative(outputDir, assembledFile).replace(/\\/g, '/') : null,
      assembledDuration,
      isReviewFile: true,
      reviewLabel: 'Assembled from measured chunks (no re-encoding)',
      chunks: chunkResults
    }
  };
}

/**
 * Executes a continuous encode benchmark over the entire sample duration for comparison.
 */
async function runContinuousBenchmark(tools, sourceInfo, testConfig, options = {}) {
  const {
    startOffset = 0,
    sampleDuration = 60,
    hardwareDecode = true,
    cpuFallback = true,
    outputDir,
    onProgress,
    probedEncoders = []
  } = options;

  const { codec, requestedEncoder, quality } = testConfig;
  const configId = `${codec}-${requestedEncoder}-${quality.id}-continuous`;
  const runOutputDir = path.join(outputDir, 'outputs', configId);
  fs.mkdirSync(runOutputDir, { recursive: true });

  const rawSpec = deriveOutputSpec(sourceInfo, quality.id);
  const specForRoute = {
    ...rawSpec,
    width: rawSpec.targetWidth,
    height: rawSpec.targetHeight,
    bitrate: rawSpec.targetBitrateKbps,
    sourceFormat: rawSpec.sourceFormat,
    doviP5: sourceInfo.hdr?.doviP5,
    hdr: rawSpec.hdr,
    tonemap: rawSpec.tonemap,
    filter: rawSpec.filter
  };

  const outputFile = path.join(runOutputDir, 'continuous.webm');

  let actualEncoder = requestedEncoder;
  if (requestedEncoder === 'auto' || requestedEncoder === 'hardware') {
    const preferred = codec === 'av1' ? ['qsv', 'nvenc'] : codec === 'vp9' ? ['qsv'] : [];
    const found = preferred.find(enc => probedEncoders.find(p => p.codec === codec && p.encoder === enc && p.available));
    actualEncoder = found || (cpuFallback ? 'software' : preferred[0] || 'software');
  }

  let activeRoute = hardwareDecode ? decodeRoute(specForRoute, actualEncoder) : undefined;
  let fallbackEvent = null;

  const buildArgs = (encoderToUse, route) => {
    const vFilter = route?.filter || rawSpec.filter;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-threads', '2',
      ...(route?.input || []),
      '-ss', String(startOffset), '-i', sourceInfo.filePath
    ];

    if (rawSpec.hasAudio) {
      args.push(
        '-ss', String(Math.max(0, startOffset - AUDIO_LEAD)), '-i', sourceInfo.filePath
      );
    }

    args.push(
      '-t', String(sampleDuration),
      '-map', '0:v:0', '-an', '-filter_threads', '2', '-vf', vFilter,
      '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      ...encoderArgs(encoderToUse, codec),
      ...rateArgs(encoderToUse, codec, rawSpec.targetBitrateKbps)
    );

    if (rawSpec.frameRate) {
      args.push('-r', rawSpec.frameRate, '-fps_mode', 'cfr');
    }

    args.push(
      '-g', '180',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'
    );

    if (rawSpec.hasAudio) {
      args.push(
        '-map', '1:a:0',
        '-c:a', 'libopus', '-b:a', '128k', '-ac', '2', '-ar', '48000',
        '-af', 'asetpts=PTS-STARTPTS'
      );
    }

    args.push('-f', 'webm', outputFile);
    return args;
  };

  let encoded = false;
  let totalDurationSec = 0;
  let attempts = 0;

  while (!encoded && attempts < 3) {
    attempts++;
    const args = buildArgs(actualEncoder, activeRoute);
    let stderrOutput = '';
    const t0 = process.hrtime.bigint();
    try {
      await spawnSafe(tools.ffmpeg, args, {
        timeout: 180000,
        onStderr: chunk => { stderrOutput += chunk.toString(); }
      });
      if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 100) {
        throw new Error('Continuous encode completed but output file is missing or empty.');
      }
      const t1 = process.hrtime.bigint();
      totalDurationSec = Number(t1 - t0) / 1e9;
      encoded = true;
    } catch (err) {
      if (activeRoute) {
        activeRoute = undefined;
        fallbackEvent = {
          from: 'hardware-decode',
          to: 'cpu-decode',
          reason: `Continuous hardware decode failed: ${err.message}`
        };
        continue;
      }
      if (actualEncoder !== 'software' && cpuFallback) {
        const prev = actualEncoder;
        actualEncoder = 'software';
        fallbackEvent = {
          from: prev,
          to: 'software',
          reason: `Continuous hardware encoder (${prev}) failed: ${stderrOutput.slice(-200) || err.message}`
        };
        continue;
      }
      throw new Error(`Continuous encoding failed (${actualEncoder}/${codec}): ${err.message}\n${stderrOutput.slice(-300)}`);
    }
  }

  const outputSizeBytes = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
  const totalFrames = Math.round(sampleDuration * (sourceInfo.video.fps || 30));
  const effectiveFps = Math.round((totalFrames / totalDurationSec) * 100) / 100;
  const speedMultiplier = Math.round((sampleDuration / totalDurationSec) * 100) / 100;
  const actualBitrateKbps = Math.round((outputSizeBytes * 8) / (sampleDuration * 1000));

  return {
    configId,
    mode: 'continuous',
    status: 'pass',
    codec,
    requestedEncoder,
    actualEncoder,
    fallback: fallbackEvent,
    quality: {
      id: quality.id,
      label: quality.label,
      width: rawSpec.targetWidth,
      height: rawSpec.targetHeight,
      targetBitrateKbps: rawSpec.targetBitrateKbps
    },
    performance: {
      sampleDuration,
      totalEncodingTimeSec: Math.round(totalDurationSec * 1000) / 1000,
      effectiveFps,
      speedMultiplier,
      firstChunkDurationSec: null,
      meanChunkSec: null,
      medianChunkSec: null,
      p95ChunkSec: null,
      maxChunkSec: null,
      deadlineMisses: 0,
      totalBytes: outputSizeBytes,
      actualBitrateKbps
    },
    output: {
      assembledFile: path.relative(outputDir, outputFile).replace(/\\/g, '/'),
      assembledDuration: sampleDuration,
      isReviewFile: false,
      reviewLabel: 'Continuous encode',
      chunks: []
    }
  };
}

/**
 * Extracts a comparison screenshot at a target timestamp using FFmpeg.
 */
function extractScreenshot(ffmpegPath, videoPath, timestampSeconds, outputPath) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  try {
    cp.execFileSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', String(timestampSeconds),
      '-i', videoPath,
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ], { windowsHide: true, timeout: 10000 });
    return fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000;
  } catch {
    return false;
  }
}

module.exports = {
  runChunkedBenchmark,
  runContinuousBenchmark,
  extractScreenshot
};
