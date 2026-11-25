#!/usr/bin/env node
'use strict';
/**
 * Programmatic FFmpeg & FFprobe capability, license, and runtime execution verifier for standalone builds.
 * Verifies GPLv3/nonfree flags, required encoders/decoders/hwaccels/filters/muxers/demuxers, and executes
 * live synthetic frame passes (WebM AV1/VP9/VP8+Opus, Vulkan libplacebo + apply_dolbyvision=1, CPU zscale+tonemap,
 * libass burn-in, and host GPU NVENC/QSV probes). Halts with non-zero exit if any required check fails.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { isValidWebm, cpuTonemap } = require('../server/media-tools');

const runFile = promisify(execFile);

const REQUIRED_ENCODERS = [
  'libsvtav1',
  'av1_nvenc',
  'av1_qsv',
  'libvpx-vp9',
  'vp9_qsv',
  'libvpx',
  'libopus',
  'aac',
  'flac',
  'pcm_s16le',
  'pcm_f32le',
];
const OPTIONAL_ENCODERS = ['av1_amf'];
const REQUIRED_DECODERS = [
  'truehd',
  'mlp',
  'dca',
  'eac3',
  'ac3',
  'aac',
  'flac',
  'alac',
  'opus',
  'vorbis',
  'mp3',
  'hevc',
  'h264',
  'av1',
  'libdav1d',
  'vp9',
  'vp8',
  'vc1',
  'mpeg2video',
  'mpeg4',
  'subrip',
  'webvtt',
  'ass',
  'pgssub',
  'dvdsub',
];
const REQUIRED_HWACCELS = ['vulkan', 'cuda', 'd3d11va', 'qsv', 'dxva2'];
const REQUIRED_FILTERS = [
  'libplacebo',
  'scale_cuda',
  'vpp_qsv',
  'hwupload',
  'hwdownload',
  'zscale',
  'tonemap',
  'setparams',
  'scale',
  'format',
  'thumbnail',
  'boxblur',
  'overlay',
  'subtitles',
  'ass',
];
const REQUIRED_MUXERS = ['webm', 'segment', 'matroska', 'mp4', 'mpegts', 'hls'];
const REQUIRED_DEMUXERS = ['matroska', 'mov', 'webm', 'mpegts', 'hls', 'srt', 'webvtt', 'ass', 'sup', 'vobsub'];

function hasToken(output, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<!\\S)${escaped}(?!\\S)`, 'm').test(output);
}

function hasFilter(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*\\S+\\s+${escaped}\\s`, 'm').test(output);
}

function hasFormat(output, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\s*[DE.]{1,3}\\s+(?:[^\\s,]+,)*${escaped}(?:,[^\\s,]+)*\\s`, 'm').test(output);
}

async function execTool(binary, args, { timeout = 25000, cwd } = {}) {
  const { stdout, stderr } = await runFile(binary, args, {
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    encoding: 'utf8',
    ...(cwd ? { cwd } : {}),
  });
  return { stdout, stderr };
}

async function verifyFfmpeg({
  ffmpegPath,
  ffprobePath,
  licenseFile,
  expectedVersion = 'n8.1.3-41-ga8029b6528',
  requireNvenc = false,
  requireQsv = false,
} = {}) {
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error(`FFmpeg binary not found: ${ffmpegPath}`);
  if (!ffprobePath || !fs.existsSync(ffprobePath)) throw new Error(`FFprobe binary not found: ${ffprobePath}`);

  const { stdout: versionOut } = await execTool(ffmpegPath, ['-hide_banner', '-version']);
  const versionLine = versionOut.split(/\r?\n/)[0] || '';
  if (expectedVersion && !versionLine.includes(expectedVersion)) {
    throw new Error(`FFmpeg version mismatch: expected ${expectedVersion}, got "${versionLine}"`);
  }
  const { stdout: buildconfOut } = await execTool(ffmpegPath, ['-hide_banner', '-buildconf']);
  const confText = versionOut + '\n' + buildconfOut;
  if (!confText.includes('--enable-gpl') || !confText.includes('--enable-version3')) {
    throw new Error('FFmpeg build must include --enable-gpl and --enable-version3');
  }
  if (confText.includes('--enable-nonfree')) {
    throw new Error('FFmpeg build must NOT include --enable-nonfree');
  }

  const resolvedLicense = licenseFile || path.join(path.dirname(ffmpegPath), 'LICENSE.txt');
  if (fs.existsSync(resolvedLicense)) {
    const text = fs.readFileSync(resolvedLicense, 'utf8');
    if (!/GNU GENERAL PUBLIC LICENSE/i.test(text) || !/Version 3/i.test(text)) {
      throw new Error(`Unexpected FFmpeg license text in ${resolvedLicense}`);
    }
  } else if (licenseFile) {
    throw new Error(`Missing FFmpeg license file: ${resolvedLicense}`);
  }

  const { stdout: probeVersionOut } = await execTool(ffprobePath, ['-hide_banner', '-version']);
  const probeVersionLine = probeVersionOut.split(/\r?\n/)[0] || '';
  if (expectedVersion && !probeVersionLine.includes(expectedVersion)) {
    throw new Error(`FFprobe version mismatch: expected ${expectedVersion}, got "${probeVersionLine}"`);
  }

  const [encodersOut, decodersOut, hwaccelsOut, filtersOut, placeboHelpOut, muxersOut, demuxersOut] = await Promise.all(
    [
      execTool(ffmpegPath, ['-hide_banner', '-encoders']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-decoders']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-hwaccels']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-filters']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-h', 'filter=libplacebo']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-muxers']).then(r => r.stdout),
      execTool(ffmpegPath, ['-hide_banner', '-demuxers']).then(r => r.stdout),
    ],
  );

  const missingEncoders = REQUIRED_ENCODERS.filter(name => !hasToken(encodersOut, name));
  if (missingEncoders.length) throw new Error(`Missing required FFmpeg encoders: ${missingEncoders.join(', ')}`);

  const optionalEncoders = Object.fromEntries(OPTIONAL_ENCODERS.map(name => [name, hasToken(encodersOut, name)]));

  const missingDecoders = REQUIRED_DECODERS.filter(name => !hasToken(decodersOut, name));
  if (missingDecoders.length) throw new Error(`Missing required FFmpeg decoders: ${missingDecoders.join(', ')}`);

  const hwaccelLines = new Set(
    hwaccelsOut
      .replace(/\r/g, '')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean),
  );
  const missingHwaccels = REQUIRED_HWACCELS.filter(name => !hwaccelLines.has(name));
  if (missingHwaccels.length) throw new Error(`Missing required FFmpeg hwaccels: ${missingHwaccels.join(', ')}`);

  const missingFilters = REQUIRED_FILTERS.filter(name => !hasFilter(filtersOut, name));
  if (missingFilters.length) throw new Error(`Missing required FFmpeg filters: ${missingFilters.join(', ')}`);

  for (const option of ['apply_dolbyvision', 'tonemapping', 'peak_detect']) {
    if (!placeboHelpOut.includes(option)) {
      throw new Error(`libplacebo filter missing required option: ${option}`);
    }
  }

  const missingMuxers = REQUIRED_MUXERS.filter(name => !hasFormat(muxersOut, name));
  if (missingMuxers.length) throw new Error(`Missing required FFmpeg muxers: ${missingMuxers.join(', ')}`);

  const missingDemuxers = REQUIRED_DEMUXERS.filter(name => !hasFormat(demuxersOut, name));
  if (missingDemuxers.length) throw new Error(`Missing required FFmpeg demuxers: ${missingDemuxers.join(', ')}`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-verify-ffmpeg-'));
  const probes = {};
  try {
    // 1. Software WebM encodes (AV1, VP9, VP8 + Opus) + ffprobe JSON readback
    for (const [key, encoder, expectedCodec] of [
      ['svtAv1Webm', 'libsvtav1', 'av1'],
      ['vp9Webm', 'libvpx-vp9', 'vp9'],
      ['vp8Webm', 'libvpx', 'vp8'],
    ]) {
      const outPath = path.join(tmpDir, `${key}.webm`);
      await execTool(ffmpegPath, [
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=160x90:r=24:d=0.4',
        '-f',
        'lavfi',
        '-i',
        'sine=f=440:r=48000:d=0.4',
        '-c:v',
        encoder,
        '-b:v',
        '250k',
        '-c:a',
        'libopus',
        '-b:a',
        '64k',
        outPath,
      ]);
      const bytes = fs.readFileSync(outPath);
      if (!isValidWebm(bytes)) {
        throw new Error(`WebM validation failed for ${encoder} probe`);
      }
      const { stdout: probeJson } = await execTool(ffprobePath, [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        outPath,
      ]);
      const parsed = JSON.parse(probeJson);
      const videoStream = parsed.streams?.find(s => s.codec_type === 'video');
      const audioStream = parsed.streams?.find(s => s.codec_type === 'audio');
      if (videoStream?.codec_name !== expectedCodec || audioStream?.codec_name !== 'opus') {
        throw new Error(
          `FFprobe stream mismatch for ${encoder}: got ${videoStream?.codec_name}/${audioStream?.codec_name}`,
        );
      }
      probes[key] = { status: 'pass', codec: videoStream.codec_name, audio: audioStream.codec_name };
    }

    // 2. Vulkan + libplacebo + apply_dolbyvision=1 shader linkage probe
    await execTool(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-init_hw_device',
      'vulkan=v',
      '-filter_hw_device',
      'v',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=320x180:r=24:d=0.1',
      '-vf',
      'format=p010le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv,hwupload,libplacebo=w=320:h=180:format=nv12:colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv:tonemapping=bt.2390:peak_detect=0:apply_dolbyvision=1,hwdownload,format=nv12',
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    probes.vulkanLibplaceboDovi = { status: 'pass' };

    // 3. CPU HDR zscale + tonemap probe
    const tonemapChain = cpuTonemap({ hdr: true, doviP5: false, transfer: 'smpte2084' }).join(',');
    await execTool(ffmpegPath, [
      '-hide_banner',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=blue:s=160x90:r=24:d=0.1',
      '-vf',
      `format=yuv420p10le,${tonemapChain},format=yuv420p`,
      '-frames:v',
      '1',
      '-f',
      'null',
      '-',
    ]);
    probes.cpuZscaleTonemap = { status: 'pass' };

    // 4. libass subtitle burn-in probe
    const assFile = path.join(tmpDir, 'probe.ass');
    fs.writeFileSync(
      assFile,
      [
        '[Script Info]',
        'ScriptType: v4.00+',
        'PlayResX: 320',
        'PlayResY: 180',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        'Style: Default,Arial,18,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1',
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
        'Dialogue: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,uburoom probe',
        '',
      ].join('\n'),
    );
    await execTool(
      ffmpegPath,
      [
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=24:d=0.1',
        '-vf',
        'ass=probe.ass',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ],
      { cwd: tmpDir },
    );
    probes.libassBurnIn = { status: 'pass' };

    // 5. Host GPU probes (NVENC CUDA->Vulkan derived device + scale_cuda + av1_nvenc; QSV d3d11va + vpp_qsv + av1_qsv/vp9_qsv)
    try {
      await execTool(ffmpegPath, [
        '-hide_banner',
        '-y',
        '-init_hw_device',
        'cuda=cu',
        '-init_hw_device',
        'vulkan=v@cu',
        '-filter_hw_device',
        'cu',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=24:d=0.1',
        '-vf',
        'format=nv12,hwupload,scale_cuda=w=320:h=180:format=nv12',
        '-c:v',
        'av1_nvenc',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      probes.nvencAv1 = { status: 'pass', executed: true };
    } catch (error) {
      if (requireNvenc) throw new Error(`Required NVENC probe failed: ${error.stderr || error.message}`);
      probes.nvencAv1 = {
        status: 'unavailable',
        executed: false,
        reason: String(error.stderr || error.message)
          .trim()
          .slice(0, 200),
      };
    }

    try {
      await execTool(ffmpegPath, [
        '-hide_banner',
        '-y',
        '-init_hw_device',
        'd3d11va=d3d',
        '-init_hw_device',
        'qsv=q@d3d',
        '-filter_hw_device',
        'q',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=24:d=0.1',
        '-vf',
        'format=nv12,hwupload,vpp_qsv=w=320:h=180',
        '-c:v',
        'av1_qsv',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      probes.qsvAv1 = { status: 'pass', executed: true };
    } catch (error) {
      if (requireQsv) throw new Error(`Required QSV probe failed: ${error.stderr || error.message}`);
      probes.qsvAv1 = {
        status: 'unavailable',
        executed: false,
        reason: String(error.stderr || error.message)
          .trim()
          .slice(0, 200),
      };
    }

    try {
      await execTool(ffmpegPath, [
        '-hide_banner',
        '-y',
        '-init_hw_device',
        'd3d11va=d3d',
        '-init_hw_device',
        'qsv=q@d3d',
        '-filter_hw_device',
        'q',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=s=320x180:r=24:d=0.1',
        '-vf',
        'format=nv12,hwupload,vpp_qsv=w=320:h=180',
        '-c:v',
        'vp9_qsv',
        '-frames:v',
        '1',
        '-f',
        'null',
        '-',
      ]);
      probes.qsvVp9 = { status: 'pass', executed: true };
    } catch (error) {
      if (requireQsv) throw new Error(`Required QSV VP9 probe failed: ${error.stderr || error.message}`);
      probes.qsvVp9 = {
        status: 'unavailable',
        executed: false,
        reason: String(error.stderr || error.message)
          .trim()
          .slice(0, 200),
      };
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }

  return {
    ok: true,
    ffmpegVersion: versionLine,
    ffprobeVersion: probeVersionLine,
    gplv3: true,
    nonfree: false,
    optionalEncoders,
    probes,
  };
}

function parseCliArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') opts.json = true;
    else if (arg === '--require-nvenc') opts.requireNvenc = true;
    else if (arg === '--require-qsv') opts.requireQsv = true;
    else if (arg === '--no-version-check') opts.expectedVersion = null;
    else if (arg === '--ffmpeg') opts.ffmpegPath = argv[++i];
    else if (arg === '--ffprobe') opts.ffprobePath = argv[++i];
    else if (arg === '--license-file') opts.licenseFile = argv[++i];
    else if (arg === '--expected-version') opts.expectedVersion = argv[++i];
  }
  return opts;
}

if (require.main === module) {
  const opts = parseCliArgs(process.argv.slice(2));
  verifyFfmpeg(opts)
    .then(result => {
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`[verify-ffmpeg] PASS: ${result.ffmpegVersion}`);
        console.log(`[verify-ffmpeg] GPLv3: ${result.gplv3}, nonfree: ${result.nonfree}`);
        for (const [name, detail] of Object.entries(result.probes)) {
          console.log(
            `[verify-ffmpeg] probe ${name}: ${detail.status}${detail.reason ? ' (' + detail.reason + ')' : ''}`,
          );
        }
      }
    })
    .catch(err => {
      console.error(`[verify-ffmpeg] FAIL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = {
  verifyFfmpeg,
  REQUIRED_ENCODERS,
  OPTIONAL_ENCODERS,
  REQUIRED_DECODERS,
  REQUIRED_HWACCELS,
  REQUIRED_FILTERS,
  REQUIRED_MUXERS,
  REQUIRED_DEMUXERS,
};
