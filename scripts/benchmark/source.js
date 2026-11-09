'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { classifyHdr, outputSpec } = require('../../server/av1');
const { qualityDefinition } = require('../../shared/room-protocol');

/**
 * Inspects a source video file using FFprobe and returns comprehensive metadata.
 */
function inspectSourceVideo(ffprobePath, filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Source video file does not exist: ${filePath}`);
  }

  const raw = cp.execFileSync(ffprobePath, [
    '-v', 'error',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,pix_fmt,color_space,color_primaries,color_transfer,r_frame_rate,avg_frame_rate:stream_side_data=side_data_type,dv_profile,bl_signal_compatibility_id:format=duration,bit_rate,size',
    '-of', 'json',
    filePath
  ], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10000,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse FFprobe JSON output for ${filePath}: ${err.message}`);
  }

  const videoStream = parsed.streams?.find(s => s.codec_type === 'video');
  if (!videoStream || !(videoStream.width > 0 && videoStream.height > 0)) {
    throw new Error(`The source file has no readable video streams: ${filePath}`);
  }

  const audioStreams = (parsed.streams || []).filter(s => s.codec_type === 'audio');
  const duration = Number(parsed.format?.duration) || Number(videoStream.duration) || 0;
  const bitrate = Number(parsed.format?.bit_rate) || Number(videoStream.bit_rate) || 0;
  const fileSize = Number(parsed.format?.size) || fs.statSync(filePath).size;

  // Frame rate calculation
  let fps = 0;
  for (const rate of [videoStream.r_frame_rate, videoStream.avg_frame_rate]) {
    const match = /^(\d+)\/(\d+)$/.exec(rate || '');
    if (match && Number(match[2]) > 0) {
      fps = Number(match[1]) / Number(match[2]);
      if (fps > 0 && fps <= 240) break;
    }
  }

  const hdrInfo = classifyHdr(videoStream);
  const isVfr = Boolean(
    videoStream.r_frame_rate &&
    videoStream.avg_frame_rate &&
    videoStream.r_frame_rate !== videoStream.avg_frame_rate
  );

  return {
    filePath: path.resolve(filePath),
    fileName: path.basename(filePath),
    fileSizeBytes: fileSize,
    durationSeconds: duration,
    bitrateKbps: Math.round(bitrate / 1000),
    video: {
      codec: videoStream.codec_name,
      width: videoStream.width,
      height: videoStream.height,
      resolution: `${videoStream.width}x${videoStream.height}`,
      pixelFormat: videoStream.pix_fmt,
      colorSpace: videoStream.color_space || 'unknown',
      colorPrimaries: videoStream.color_primaries || 'unknown',
      colorTransfer: videoStream.color_transfer || 'unknown',
      frameRate: videoStream.r_frame_rate || videoStream.avg_frame_rate || '30/1',
      fps: Math.round(fps * 100) / 100,
      isVfr
    },
    audio: {
      available: audioStreams.length > 0,
      count: audioStreams.length,
      streams: audioStreams.map(s => ({
        index: s.index,
        codec: s.codec_name
      }))
    },
    hdr: hdrInfo,
    rawInfo: parsed
  };
}

/**
 * Generates a local synthetic video file using FFmpeg if no user input was provided.
 * Ensures the synthetic video duration satisfies startOffset + sampleDuration.
 */
function generateSyntheticSource(ffmpegPath, outputDir, requiredDuration = 60) {
  fs.mkdirSync(outputDir, { recursive: true });
  const syntheticFile = path.join(outputDir, 'synthetic-reference-1080p30.mkv');
  const targetDuration = Math.max(10, Math.ceil(requiredDuration));

  // Check if an existing synthetic file with sufficient duration already exists
  if (fs.existsSync(syntheticFile)) {
    try {
      const stats = fs.statSync(syntheticFile);
      if (stats.size > 50000) {
        // Quick ffprobe check if ffprobe is alongside ffmpeg
        const probePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
        if (fs.existsSync(probePath)) {
          const raw = cp.execFileSync(probePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            syntheticFile
          ], { encoding: 'utf8', timeout: 5000, windowsHide: true });
          const dur = parseFloat(raw.trim());
          if (dur >= targetDuration) {
            return syntheticFile;
          }
        }
      }
    } catch {}
  }

  // Generate synthetic 1080p 30fps video using testsrc2 and sine wave audio
  // Uses libx264 ultrafast so generation takes only ~1-2 seconds
  cp.execFileSync(ffmpegPath, [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', String(targetDuration),
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-color_range', 'tv',
    '-colorspace', 'bt709',
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-c:a', 'aac',
    '-b:a', '192k',
    syntheticFile
  ], {
    windowsHide: true,
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'ignore']
  });

  return syntheticFile;
}

/**
 * Extracts a lightweight, web-compatible reference proxy from the source video
 * matching the exact [startOffset, startOffset + sampleDuration] interval.
 * Returns an object with relativePath, label, and notice explaining that this is
 * a lossy 8-bit SDR preview proxy for inspection rather than the untouched master.
 * For HDR sources (HDR10, HLG, Dolby Vision), applies appropriate tonemapping;
 * if trustworthy tonemapping cannot be performed (e.g. DV P5 without Vulkan libplacebo),
 * proxy generation is skipped with an explicit notice to prevent misleading color display.
 */
function extractReferenceSample(tools, sourceInfo, startOffset, sampleDuration, outputDir) {
  const sampleFileName = 'reference-proxy.mp4';
  const targetPath = path.join(outputDir, sampleFileName);

  const hasAudio = !!sourceInfo.audio?.available;
  const isHdr = !!sourceInfo.hdr?.hdr;
  const isDoviP5 = !!sourceInfo.hdr?.doviP5;

  // Dolby Vision Profile 5 requires Vulkan libplacebo for color tonemapping
  if (isDoviP5) {
    try {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-y',
        '-init_hw_device', 'vulkan=v',
        '-filter_hw_device', 'v',
        '-ss', String(startOffset),
        '-t', String(sampleDuration),
        '-i', sourceInfo.filePath,
        '-map', '0:v:0',
        '-vf', 'libplacebo=w=\'min(1920,iw)\':h=-2:format=yuv420p:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:apply_dolbyvision=1',
        '-c:v', 'libx264',
        '-preset', 'veryfast',
        '-crf', '22'
      ];
      if (hasAudio) {
        args.push('-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-af', 'asetpts=PTS-STARTPTS');
      } else {
        args.push('-an');
      }
      args.push('-movflags', '+faststart', targetPath);

      cp.execFileSync(tools.ffmpeg, args, {
        windowsHide: true,
        timeout: 90000,
        stdio: ['ignore', 'pipe', 'ignore']
      });

      if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
        return {
          relativePath: sampleFileName,
          isLossyProxy: true,
          label: 'Viewing Proxy (Tonemapped Dolby Vision P5 — 8-bit SDR Preview)',
          notice: 'Tonemapped via Vulkan libplacebo for browser preview; not the uncompressed master.'
        };
      }
    } catch {
      // Vulkan libplacebo is unavailable or failed; fail closed to avoid purple/green colors
      return {
        relativePath: null,
        isLossyProxy: true,
        label: 'Viewing Proxy Unavailable (Dolby Vision Profile 5)',
        notice: 'Dolby Vision Profile 5 requires Vulkan libplacebo tone-mapping. Direct viewing proxy playback disabled to avoid misleading color representation.'
      };
    }
  }

  // HDR10 / HLG tone-mapping using zscale
  let vFilter = 'scale=w=\'min(1920,iw)\':h=-2:force_original_aspect_ratio=decrease,format=yuv420p';
  if (isHdr) {
    const transfer = sourceInfo.hdr.transfer || 'smpte2084';
    vFilter = `setparams=color_primaries=bt2020:color_trc=${transfer}:colorspace=bt2020nc,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,scale=w='min(1920,iw)':h=-2:force_original_aspect_ratio=decrease,format=yuv420p`;
  }

  try {
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-ss', String(startOffset),
      '-t', String(sampleDuration),
      '-i', sourceInfo.filePath,
      '-map', '0:v:0',
      '-vf', vFilter,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '22'
    ];

    if (hasAudio) {
      args.push(
        '-map', '0:a:0',
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-af', 'asetpts=PTS-STARTPTS'
      );
    } else {
      args.push('-an');
    }

    args.push('-movflags', '+faststart', targetPath);

    cp.execFileSync(tools.ffmpeg, args, {
      windowsHide: true,
      timeout: Math.max(60000, Math.ceil(sampleDuration * 2000)),
      stdio: ['ignore', 'pipe', 'ignore']
    });

    if (fs.existsSync(targetPath) && fs.statSync(targetPath).size > 1000) {
      return {
        relativePath: sampleFileName,
        isLossyProxy: true,
        label: isHdr
          ? 'Viewing Proxy (Tonemapped HDR — 8-bit SDR Preview)'
          : 'Viewing Proxy (Lossy 8-bit H.264/AAC Preview — Not Untouched Master)',
        notice: isHdr
          ? 'Viewing proxy tonemapped from HDR to 8-bit SDR (BT.709) for standard browser inspection.'
          : 'Viewing proxy transcoded to lightweight 8-bit H.264/AAC for browser side-by-side inspection; not the untouched master.'
      };
    }
  } catch (err) {
    return {
      relativePath: null,
      isLossyProxy: true,
      label: 'Viewing Proxy Unavailable',
      notice: isHdr
        ? 'HDR tone-mapping could not be completed for the viewing proxy; proxy disabled to prevent misleading color representation.'
        : 'Could not generate viewing proxy from source media.'
    };
  }

  return {
    relativePath: null,
    isLossyProxy: true,
    label: 'Viewing Proxy Unavailable',
    notice: 'No viewing proxy generated.'
  };
}

/**
 * Derives target output specifications for a given quality using production outputSpec.
 * Ensures strict enforcement of no-upscaling rules.
 */
function deriveOutputSpec(sourceInfo, qualityIdOrDef) {
  const qId = typeof qualityIdOrDef === 'string' ? qualityIdOrDef : qualityIdOrDef?.id;
  const qDef = qualityDefinition(qId);
  if (!qDef) throw new Error(`Invalid quality definition: ${JSON.stringify(qualityIdOrDef)}`);

  const raw = sourceInfo.rawInfo || sourceInfo;
  // Call production outputSpec with raw FFprobe structure and string quality ID
  const spec = outputSpec(raw, qId);

  return {
    qualityId: qDef.id,
    label: qDef.label,
    targetWidth: spec.width,
    targetHeight: spec.height,
    targetBitrateKbps: spec.bitrate,
    frameRate: spec.frameRate,
    filter: spec.filter,
    tonemap: spec.tonemap,
    hdr: spec.hdr,
    hdrLabel: spec.hdrLabel,
    hasAudio: spec.audio,
    sourceFormat: spec.sourceFormat
  };
}

module.exports = {
  inspectSourceVideo,
  generateSyntheticSource,
  extractReferenceSample,
  deriveOutputSpec
};
