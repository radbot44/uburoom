'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const {
  CHUNK,
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
 * Performs deep packet-level inspection and full decoding verification of an output video file.
 * Verifies stream headers, actual decoded start/end timestamps, real A/V alignment without
 * relying on container duration fallbacks, complete video frame coverage, and chunk boundary continuity.
 */
function validateOutputVideo(ffprobePath, ffmpegPath, filePath, options = {}) {
  const { expectedCodec, hasAudio, sampleDuration, fps = 30, isVfr = false, signal = null } = options;
  const errors = [];

  if (signal?.aborted) {
    return { valid: false, errors: ['Video validation cancelled by abort signal.'] };
  }

  if (!fs.existsSync(filePath)) {
    return { valid: false, errors: ['Output file does not exist.'] };
  }
  const size = fs.statSync(filePath).size;
  if (size < 1000) {
    return { valid: false, errors: [`Output file is too small (${size} bytes).`] };
  }

  let probe;
  try {
    const raw = cp.execFileSync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=index,codec_type,codec_name,width,height:format=duration',
      '-of', 'json',
      filePath
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    probe = JSON.parse(raw);
  } catch (err) {
    return { valid: false, errors: [`FFprobe inspection failed: ${err.message}`] };
  }

  const videoStream = probe.streams?.find(s => s.codec_type === 'video');
  if (!videoStream) {
    errors.push('No video stream found in output.');
  } else if (expectedCodec && videoStream.codec_name !== expectedCodec) {
    errors.push(`Video codec mismatch: expected ${expectedCodec}, found ${videoStream.codec_name}.`);
  }

  const audioStream = probe.streams?.find(s => s.codec_type === 'audio');
  if (hasAudio) {
    if (!audioStream) {
      errors.push('Expected audio stream in output, but none found.');
    } else if (audioStream.codec_name !== 'opus') {
      errors.push(`Expected opus audio codec, found ${audioStream.codec_name}.`);
    }
  } else if (audioStream) {
    errors.push('Found unexpected audio stream in video-only output.');
  }

  // 1. Packet-level video timestamps, packet count, and continuity
  const videoPackets = [];
  let videoStartPts = 0;
  let videoEndPts = 0;
  let videoDecodedDuration = 0;
  try {
    const videoCsv = cp.execFileSync(ffprobePath, [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'packet=pts_time,duration_time',
      '-of', 'csv=p=0',
      filePath
    ], { encoding: 'utf8', windowsHide: true, timeout: Math.max(15000, Math.ceil((sampleDuration || 60) * 500)) });

    for (const line of videoCsv.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(',');
      const pts = parseFloat(parts[0]);
      const dur = parseFloat(parts[1]) || (fps ? 1 / fps : 0.033);
      if (!isNaN(pts)) videoPackets.push({ pts, dur });
    }
  } catch (err) {
    errors.push(`Failed to demux video packets: ${err.message}`);
  }

  if (videoPackets.length === 0) {
    errors.push('No readable video packets in output file.');
  } else {
    videoStartPts = videoPackets[0].pts;
    const lastPkt = videoPackets[videoPackets.length - 1];
    videoEndPts = lastPkt.pts + lastPkt.dur;
    videoDecodedDuration = Math.max(0, videoEndPts - videoStartPts);

    // Packet coverage check (applies to constant-frame-rate sources; VFR sources naturally fluctuate in packet count)
    if (!isVfr && sampleDuration && fps) {
      const expectedPackets = Math.round(sampleDuration * fps);
      const actualPackets = videoPackets.length;
      const deltaPackets = Math.abs(actualPackets - expectedPackets);
      // Allow at most 3 packets tolerance for partial container packets / cadence rounding
      if (deltaPackets > 3) {
        errors.push(`Incomplete video packet coverage: expected ~${expectedPackets} packets, got ${actualPackets} packets (delta ${deltaPackets}).`);
      }
    }

    // Packet continuity & chunk boundary gap check
    for (let i = 1; i < videoPackets.length; i++) {
      const prevEnd = videoPackets[i - 1].pts + videoPackets[i - 1].dur;
      const currentPts = videoPackets[i].pts;
      const gap = currentPts - prevEnd;
      // Gaps larger than 2.5 frame intervals (~85ms at 30fps) indicate dropped or missing frames at chunk boundaries
      // For VFR, gaps can legitimately be slightly larger, but shouldn't exceed 0.25s
      const maxGap = isVfr ? 0.25 : 0.085;
      if (gap > maxGap) {
        errors.push(`Packet discontinuity detected: ${gap.toFixed(3)}s gap between ${prevEnd.toFixed(3)}s and ${currentPts.toFixed(3)}s.`);
        break;
      }
    }

    // Tight duration check based on real packet timestamps
    if (sampleDuration && Math.abs(videoDecodedDuration - sampleDuration) > 0.35) {
      errors.push(`Decoded video duration (${videoDecodedDuration.toFixed(3)}s) deviates from requested sample duration (${sampleDuration}s) by >0.35s.`);
    }
  }

  // 2. Packet-level audio timestamps and true A/V alignment
  let audioStartPts = 0;
  let audioEndPts = 0;
  let audioDecodedDuration = 0;
  let audioPacketsCount = 0;

  if (hasAudio) {
    const audioPackets = [];
    try {
      const audioCsv = cp.execFileSync(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'a:0',
        '-show_entries', 'packet=pts_time,duration_time',
        '-of', 'csv=p=0',
        filePath
      ], { encoding: 'utf8', windowsHide: true, timeout: Math.max(15000, Math.ceil((sampleDuration || 60) * 500)) });

      for (const line of audioCsv.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const parts = trimmed.split(',');
        const pts = parseFloat(parts[0]);
        const dur = parseFloat(parts[1]) || 0.02;
        if (!isNaN(pts)) audioPackets.push({ pts, dur });
      }
    } catch (err) {
      errors.push(`Failed to demux audio packets: ${err.message}`);
    }

    audioPacketsCount = audioPackets.length;
    if (audioPackets.length === 0) {
      errors.push('Expected audio stream in output, but no audio packets could be demuxed.');
    } else {
      audioStartPts = audioPackets[0].pts;
      const lastAudio = audioPackets[audioPackets.length - 1];
      audioEndPts = lastAudio.pts + lastAudio.dur;
      audioDecodedDuration = Math.max(0, audioEndPts - audioStartPts);

      // Verify real decoded A/V start alignment (independent of container headers)
      const avStartDelta = Math.abs(videoStartPts - audioStartPts);
      if (avStartDelta > 0.08) {
        errors.push(`Audio/video start PTS misalignment: video starts at ${videoStartPts.toFixed(3)}s, audio at ${audioStartPts.toFixed(3)}s (delta ${avStartDelta.toFixed(3)}s).`);
      }

      // Verify real decoded A/V end alignment
      const avEndDelta = Math.abs(videoEndPts - audioEndPts);
      if (avEndDelta > 0.12) {
        errors.push(`Audio/video end PTS misalignment: video ends at ${videoEndPts.toFixed(3)}s, audio at ${audioEndPts.toFixed(3)}s (delta ${avEndDelta.toFixed(3)}s).`);
      }

      // Verify real decoded A/V duration alignment
      const avDurationDelta = Math.abs(videoDecodedDuration - audioDecodedDuration);
      if (avDurationDelta > 0.12) {
        errors.push(`Audio/video duration mismatch: video=${videoDecodedDuration.toFixed(3)}s, audio=${audioDecodedDuration.toFixed(3)}s (delta ${avDurationDelta.toFixed(3)}s).`);
      }
    }
  }

  // 3. Full decoding integrity test
  try {
    const decodeTimeout = Math.max(30000, Math.ceil((sampleDuration || 60) * 2000));
    cp.execFileSync(ffmpegPath, [
      '-v', 'error',
      '-i', filePath,
      '-f', 'null',
      '-'
    ], { encoding: 'utf8', windowsHide: true, timeout: decodeTimeout });
  } catch (err) {
    errors.push(`Full decoding verification failed: ${err.message}`);
  }

  return {
    valid: errors.length === 0,
    videoStartPts: Math.round(videoStartPts * 1000) / 1000,
    videoEndPts: Math.round(videoEndPts * 1000) / 1000,
    videoDecodedDuration: Math.round(videoDecodedDuration * 1000) / 1000,
    videoPacketCount: videoPackets.length,
    audioStartPts: Math.round(audioStartPts * 1000) / 1000,
    audioEndPts: Math.round(audioEndPts * 1000) / 1000,
    audioDecodedDuration: Math.round(audioDecodedDuration * 1000) / 1000,
    audioPacketCount: audioPacketsCount,
    formatDuration: videoDecodedDuration,
    videoStream,
    audioStream,
    sizeBytes: size,
    errors
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
    runIndex = 1,
    onProgress,
    probedEncoders = []
  } = options;

  const { codec, requestedEncoder, quality } = testConfig;
  const configId = `${codec}-${requestedEncoder}-${quality.id}-chunked`;
  let subFolder;
  if (options.tierIndex) {
    subFolder = `capacity-tier-${options.tierIndex}/run-${runIndex}/worker-${options.workerId || 1}`;
  } else if (options.concurrency && options.concurrency > 1) {
    subFolder = `concurrency-${options.concurrency}/run-${runIndex}/worker-${options.workerId || 1}`;
  } else if (options.workerId) {
    subFolder = `run-${runIndex}/worker-${options.workerId}`;
  } else {
    subFolder = `run-${runIndex}`;
  }
  const runOutputDir = path.join(outputDir, 'outputs', subFolder, configId);
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
  } else if (requestedEncoder === 'software') {
    actualEncoder = 'software';
  }

  const allowFallback = cpuFallback && testConfig.allowFallback !== false;

  // Determine decode routes (mirroring server/av1.js)
  const candidateRoutes = specForRoute.doviP5
    ? [
        ...(hardwareDecode ? [decodeRoute(specForRoute, actualEncoder)] : []),
        cpuPlaceboRoute(specForRoute)
      ].filter((route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i)
    : [
        ...(hardwareDecode ? [decodeRoute(specForRoute, actualEncoder), decodeRoute(specForRoute, actualEncoder, undefined, false)].filter((route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i) : []),
        undefined
      ];

  if (specForRoute.doviP5 && !candidateRoutes.length) {
    throw new Error('Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping.');
  }

  const numChunks = Math.ceil(sampleDuration / CHUNK);
  const chunkResults = [];
  const fallbackEvents = [];
  let activeRoute = candidateRoutes[0];

  const totalRunStartHr = process.hrtime.bigint();
  const firstChunkStartHr = process.hrtime.bigint();
  let firstChunkStartupSec = 0;
  let accumulatedSuccessfulSec = 0;

  for (let i = 0; i < numChunks; i++) {
    if (options.signal?.aborted) {
      throw new Error('Benchmark cancelled by abort signal.');
    }
    const chunkStart = startOffset + i * CHUNK;
    const chunkDuration = Math.min(CHUNK, sampleDuration - i * CHUNK);
    const chunkFile = path.join(chunksDir, `chunk-${String(i).padStart(3, '0')}.webm`);

    const buildArgs = (encoderToUse, route) => {
      const vFilter = route?.filter || rawSpec.filter;
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-threads', '2',
        ...(route?.input || []),
        '-ss', String(chunkStart),
        '-i', sourceInfo.filePath,
        '-t', String(chunkDuration),
        '-map', '0:v:0',
        '-filter_threads', '2',
        '-vf', vFilter,
        '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
        ...encoderArgs(encoderToUse, codec),
        ...rateArgs(encoderToUse, codec, rawSpec.targetBitrateKbps)
      ];

      if (rawSpec.frameRate) {
        args.push('-r', rawSpec.frameRate, '-fps_mode', 'cfr');
      }

      args.push(
        '-g', '180',
        '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'
      );

      if (rawSpec.hasAudio) {
        args.push(
          '-map', '0:a:0',
          '-c:a', 'libopus',
          '-b:a', '128k',
          '-ac', '2',
          '-ar', '48000',
          '-af', 'asetpts=PTS-STARTPTS'
        );
      } else {
        args.push('-an');
      }

      args.push('-f', 'webm', '-cluster_time_limit', '1000', chunkFile);
      return args;
    };

    let encoded = false;
    let encodeDurationSec = 0;
    let attempts = 0;
    const initialFallbackCount = fallbackEvents.length;

    while (!encoded && attempts < 4) {
      if (options.signal?.aborted) {
        throw new Error('Benchmark cancelled by abort signal.');
      }
      attempts++;
      const currentArgs = buildArgs(actualEncoder, activeRoute);
      let stderrOutput = '';

      const t0 = process.hrtime.bigint();
      try {
        await spawnSafe(tools.ffmpeg, currentArgs, {
          timeout: 45000,
          signal: options.signal,
          onStderr: chunk => { stderrOutput += chunk.toString(); }
        });
        if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size < 100) {
          throw new Error('FFmpeg completed but chunk output file is missing or empty.');
        }
        const t1 = process.hrtime.bigint();
        encodeDurationSec = Number(t1 - t0) / 1e9;
        accumulatedSuccessfulSec += encodeDurationSec;
        encoded = true;

        if (i === 0) {
          firstChunkStartupSec = Number(process.hrtime.bigint() - firstChunkStartHr) / 1e9;
        }
      } catch (err) {
        if (options.signal?.aborted) {
          throw err;
        }
        // Step down route first (hardware decode -> CPU decode / placebo)
        const currentRouteIdx = candidateRoutes.indexOf(activeRoute);
        if (currentRouteIdx >= 0 && currentRouteIdx < candidateRoutes.length - 1) {
          const nextRoute = candidateRoutes[currentRouteIdx + 1];
          fallbackEvents.push({
            type: 'decode_route',
            from: activeRoute ? (activeRoute.input ? 'hardware-decode' : 'gpu-route') : 'default-route',
            to: nextRoute ? 'cpu-placebo' : 'cpu-decode',
            reason: `Decode route failed on chunk ${i}: ${err.message}`
          });
          activeRoute = nextRoute;
          continue;
        }

        // Then step down encoder (hardware encoder -> CPU software encoder) if allowed
        if (actualEncoder !== 'software' && allowFallback) {
          const prev = actualEncoder;
          actualEncoder = 'software';
          activeRoute = specForRoute.doviP5 ? cpuPlaceboRoute(specForRoute) : undefined;
          fallbackEvents.push({
            type: 'encoder',
            from: prev,
            to: 'software',
            reason: `Hardware encoder (${prev}) failed on chunk ${i}: ${stderrOutput.slice(-200) || err.message}`
          });
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

    const chunkHadFallback = fallbackEvents.length > initialFallbackCount;

    onProgress?.({
      type: 'chunk',
      configId,
      chunkIndex: i,
      totalChunks: numChunks,
      encodeDurationSec,
      realTimeSpeed,
      deadlineMissed,
      fallbackOccurred: chunkHadFallback,
      totalFallbacks: fallbackEvents.length,
      fallbackEvents: [...fallbackEvents]
    });
  }

  const totalRunDurationSec = Number(process.hrtime.bigint() - totalRunStartHr) / 1e9;
  const chunkTimes = chunkResults.map(c => c.encodeDurationSec);
  const stats = calculateStats(chunkTimes);
  const totalBytes = chunkResults.reduce((acc, c) => acc + c.sizeBytes, 0);
  const deadlineMissCount = chunkResults.filter(c => c.deadlineMissed).length;
  const totalFrames = Math.round(sampleDuration * (sourceInfo.video.fps || 30));
  const effectiveFps = Math.round((totalFrames / accumulatedSuccessfulSec) * 100) / 100;
  const speedMultiplier = Math.round((sampleDuration / accumulatedSuccessfulSec) * 100) / 100;
  const totalElapsedSpeedMultiplier = Math.round((sampleDuration / totalRunDurationSec) * 100) / 100;
  const actualBitrateKbps = Math.round((totalBytes * 8) / (sampleDuration * 1000));

  if (options.signal?.aborted) {
    throw new Error('Benchmark cancelled by abort signal.');
  }

  // Assemble measured chunks into a seekable review file without re-encoding
  const assembledFile = path.join(runOutputDir, 'assembled.webm');
  const concatListFile = path.join(runOutputDir, 'chunks-list.txt');
  const listLines = chunkResults.map(c => `file '${path.resolve(path.join(outputDir, c.relativePath)).replace(/\\/g, '/')}'`);
  fs.writeFileSync(concatListFile, listLines.join('\n') + '\n', 'utf8');

  let validationResult = { valid: false, errors: [] };
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

    validationResult = validateOutputVideo(tools.ffprobe, tools.ffmpeg, assembledFile, {
      expectedCodec: codec,
      hasAudio: rawSpec.hasAudio,
      sampleDuration,
      fps: sourceInfo.video.fps || 30,
      signal: options.signal
    });
    assembledDuration = validationResult.videoDecodedDuration || 0;
    assembledSuccess = validationResult.valid;
  } catch (err) {
    assembledSuccess = false;
    validationResult.errors.push(`Concat assembly error: ${err.message}`);
  }

  const isPassed = assembledSuccess && validationResult.valid;

  return {
    runIndex,
    workerId: options.workerId || 1,
    concurrency: options.concurrency || 1,
    tierIndex: options.tierIndex || null,
    configId,
    mode: 'chunked',
    status: isPassed ? 'pass' : 'fail',
    error: isPassed ? null : (validationResult.errors.join('; ') || 'Assembled validation failed'),
    codec,
    requestedEncoder,
    actualEncoder,
    fallback: fallbackEvents.length > 0 ? fallbackEvents[fallbackEvents.length - 1] : null,
    fallbackEvents,
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
      successfulEncodeTimeSec: Math.round(accumulatedSuccessfulSec * 1000) / 1000,
      speedMultiplier,
      totalElapsedSpeedMultiplier,
      effectiveFps,
      firstChunkDurationSec: chunkResults[0]?.encodeDurationSec || 0,
      firstChunkStartupSec: Math.round(firstChunkStartupSec * 1000) / 1000,
      meanChunkSec: stats.mean,
      medianChunkSec: stats.median,
      p95ChunkSec: stats.p95,
      chunkP95DurationSec: stats.p95,
      maxChunkSec: stats.max,
      deadlineMisses: deadlineMissCount,
      totalBytes,
      actualBitrateKbps,
      processingType: 'production-like'
    },
    validation: validationResult,
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
    runIndex = 1,
    onProgress,
    probedEncoders = []
  } = options;

  const { codec, requestedEncoder, quality } = testConfig;
  const configId = `${codec}-${requestedEncoder}-${quality.id}-continuous`;
  let subFolder;
  if (options.tierIndex) {
    subFolder = `capacity-tier-${options.tierIndex}/run-${runIndex}/worker-${options.workerId || 1}`;
  } else if (options.concurrency && options.concurrency > 1) {
    subFolder = `concurrency-${options.concurrency}/run-${runIndex}/worker-${options.workerId || 1}`;
  } else if (options.workerId) {
    subFolder = `run-${runIndex}/worker-${options.workerId}`;
  } else {
    subFolder = `run-${runIndex}`;
  }
  const runOutputDir = path.join(outputDir, 'outputs', subFolder, configId);
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
  } else if (requestedEncoder === 'software') {
    actualEncoder = 'software';
  }

  const allowFallback = cpuFallback && testConfig.allowFallback !== false;

  const candidateRoutes = specForRoute.doviP5
    ? [
        ...(hardwareDecode ? [decodeRoute(specForRoute, actualEncoder)] : []),
        cpuPlaceboRoute(specForRoute)
      ].filter((route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i)
    : [
        ...(hardwareDecode ? [decodeRoute(specForRoute, actualEncoder), decodeRoute(specForRoute, actualEncoder, undefined, false)].filter((route, i, all) => route && all.findIndex(other => other?.filter === route.filter) === i) : []),
        undefined
      ];

  if (specForRoute.doviP5 && !candidateRoutes.length) {
    throw new Error('Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping.');
  }

  let activeRoute = candidateRoutes[0];
  const fallbackEvents = [];

  const buildArgs = (encoderToUse, route) => {
    const vFilter = route?.filter || rawSpec.filter;
    const args = [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-threads', '2',
      ...(route?.input || []),
      '-ss', String(startOffset),
      '-t', String(sampleDuration),
      '-i', sourceInfo.filePath,
      '-map', '0:v:0',
      '-filter_threads', '2',
      '-vf', vFilter,
      '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
      ...encoderArgs(encoderToUse, codec),
      ...rateArgs(encoderToUse, codec, rawSpec.targetBitrateKbps)
    ];

    if (rawSpec.frameRate) {
      args.push('-r', rawSpec.frameRate, '-fps_mode', 'cfr');
    }

    args.push(
      '-g', '180',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'
    );

    if (rawSpec.hasAudio) {
      args.push(
        '-map', '0:a:0',
        '-c:a', 'libopus',
        '-b:a', '128k',
        '-ac', '2',
        '-ar', '48000',
        '-af', 'asetpts=PTS-STARTPTS'
      );
    } else {
      args.push('-an');
    }

    args.push('-f', 'webm', outputFile);
    return args;
  };

  let encoded = false;
  let successfulDurationSec = 0;
  let attempts = 0;
  const totalRunStartHr = process.hrtime.bigint();

  while (!encoded && attempts < 4) {
    if (options.signal?.aborted) {
      throw new Error('Benchmark cancelled by abort signal.');
    }
    attempts++;
    const args = buildArgs(actualEncoder, activeRoute);
    let stderrOutput = '';
    const t0 = process.hrtime.bigint();
    try {
      await spawnSafe(tools.ffmpeg, args, {
        timeout: 180000,
        signal: options.signal,
        onStderr: chunk => { stderrOutput += chunk.toString(); }
      });
      if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 100) {
        throw new Error('Continuous encode completed but output file is missing or empty.');
      }
      const t1 = process.hrtime.bigint();
      successfulDurationSec = Number(t1 - t0) / 1e9;
      encoded = true;
    } catch (err) {
      if (options.signal?.aborted) {
        throw err;
      }
      const currentRouteIdx = candidateRoutes.indexOf(activeRoute);
      if (currentRouteIdx >= 0 && currentRouteIdx < candidateRoutes.length - 1) {
        const nextRoute = candidateRoutes[currentRouteIdx + 1];
        fallbackEvents.push({
          type: 'decode_route',
          from: activeRoute ? 'hardware-decode' : 'gpu-route',
          to: nextRoute ? 'cpu-placebo' : 'cpu-decode',
          reason: `Continuous decode route failed: ${err.message}`
        });
        activeRoute = nextRoute;
        continue;
      }
      if (actualEncoder !== 'software' && allowFallback) {
        const prev = actualEncoder;
        actualEncoder = 'software';
        activeRoute = specForRoute.doviP5 ? cpuPlaceboRoute(specForRoute) : undefined;
        fallbackEvents.push({
          type: 'encoder',
          from: prev,
          to: 'software',
          reason: `Continuous hardware encoder (${prev}) failed: ${stderrOutput.slice(-200) || err.message}`
        });
        continue;
      }
      throw new Error(`Continuous encoding failed (${actualEncoder}/${codec}): ${err.message}\n${stderrOutput.slice(-300)}`);
    }
  }

  const totalRunDurationSec = Number(process.hrtime.bigint() - totalRunStartHr) / 1e9;
  const outputSizeBytes = fs.existsSync(outputFile) ? fs.statSync(outputFile).size : 0;
  const totalFrames = Math.round(sampleDuration * (sourceInfo.video.fps || 30));
  const effectiveFps = Math.round((totalFrames / successfulDurationSec) * 100) / 100;
  const speedMultiplier = Math.round((sampleDuration / successfulDurationSec) * 100) / 100;
  const totalElapsedSpeedMultiplier = Math.round((sampleDuration / totalRunDurationSec) * 100) / 100;
  const actualBitrateKbps = Math.round((outputSizeBytes * 8) / (sampleDuration * 1000));

  const validationResult = validateOutputVideo(tools.ffprobe, tools.ffmpeg, outputFile, {
    expectedCodec: codec,
    hasAudio: rawSpec.hasAudio,
    sampleDuration,
    fps: sourceInfo.video.fps || 30,
    signal: options.signal
  });

  const isPassed = validationResult.valid;

  return {
    runIndex,
    workerId: options.workerId || 1,
    concurrency: options.concurrency || 1,
    tierIndex: options.tierIndex || null,
    configId,
    mode: 'continuous',
    status: isPassed ? 'pass' : 'fail',
    error: isPassed ? null : validationResult.errors.join('; '),
    codec,
    requestedEncoder,
    actualEncoder,
    fallback: fallbackEvents.length > 0 ? fallbackEvents[fallbackEvents.length - 1] : null,
    fallbackEvents,
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
      successfulEncodeTimeSec: Math.round(successfulDurationSec * 1000) / 1000,
      effectiveFps,
      speedMultiplier,
      totalElapsedSpeedMultiplier,
      firstChunkDurationSec: null,
      firstChunkStartupSec: null,
      meanChunkSec: null,
      medianChunkSec: null,
      p95ChunkSec: null,
      maxChunkSec: null,
      deadlineMisses: 0,
      totalBytes: outputSizeBytes,
      actualBitrateKbps,
      processingType: 'continuous-baseline'
    },
    validation: validationResult,
    output: {
      assembledFile: path.relative(outputDir, outputFile).replace(/\\/g, '/'),
      assembledDuration: validationResult.videoDecodedDuration || sampleDuration,
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
      '-ss', String(Math.max(0, timestampSeconds)),
      '-i', videoPath,
      '-an',
      '-vframes', '1',
      '-q:v', '2',
      outputPath
    ], { windowsHide: true, timeout: 10000 });
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
      return true;
    }
  } catch {}

  // Fallback to start frame if seeking to target timestamp failed
  try {
    cp.execFileSync(ffmpegPath, [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-ss', '0',
      '-i', videoPath,
      '-an',
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
  extractScreenshot,
  validateOutputVideo
};
