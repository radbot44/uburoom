import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function buildCoherent51Mkv(dir) {
  // -1.0 dBFS (0.891 peak) coherent 440 Hz sine on all 5.1 channels (lavfi sine is 0.125 = -18.06 dBFS; * 7.128 = 0.891)
  const out = path.join(dir, 'coherent_51_minus1dbfs.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-filter_complex',
    '[1:a]volume=7.128,pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[aout]',
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'flac',
    out,
  ]);
  return out;
}

export function buildSoloCenterSpeechMkv(dir) {
  // -18.06 dBFS (0.125 peak) solo Center channel reference for dialogue loudness preservation
  const out = path.join(dir, 'solo_center_minus18dbfs.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=1',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=1',
    '-filter_complex',
    '[1:a]pan=5.1|FC=c0[aout]',
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'flac',
    out,
  ]);
  return out;
}

export function buildPtsGapMkv(dir) {
  // Drops [0.80s..1.05s] (~241.3ms) of audio packets while preserving 1.500s container PTS on a 1 kHz tone burst
  const out = path.join(dir, 'audio_pts_gap.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=2.5',
    '-f',
    'lavfi',
    '-i',
    'sine=f=1000:r=48000:d=2.0',
    '-filter_complex',
    "[1:a]volume=0:enable='not(between(t,1.5,1.52))',aselect='not(between(t,0.8,1.05))'[aout]",
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'flac',
    '-fps_mode',
    'passthrough',
    out,
  ]);
  return out;
}

export function buildOpusPreSkipMkv(dir) {
  // Opus encodes 312 priming samples (negative PTS = -6.5ms at 48kHz) before a sharp 1.000s marker impulse
  const out = path.join(dir, 'opus_preskip.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=2.0',
    '-f',
    'lavfi',
    '-i',
    'sine=f=1000:r=48000:d=1.8',
    '-filter_complex',
    "[1:a]volume=0:enable='not(between(t,1.0,1.02))'[aout]",
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'libopus',
    '-b:a',
    '128k',
    out,
  ]);
  return out;
}

export function buildOffsetStartTimeTs(dir, offsetSec = 12.345) {
  const out = path.join(dir, 'offset_start_time.ts');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=1.5',
    '-f',
    'lavfi',
    '-i',
    'sine=f=1000:r=48000:d=1.5',
    '-filter_complex',
    "[1:a]volume=0:enable='not(between(t,0.5,0.52))'[aout]",
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-output_ts_offset',
    String(offsetSec),
    out,
  ]);
  return out;
}

export function buildOversizeFontsMkv(dir, count = 5, eachMiB = 4) {
  // 5 x 4 MiB = 20 MiB total TTF attachments (> 16 MiB aggregate cap, though each <= 16 MiB)
  const attachArgs = [];
  for (let i = 0; i < count; i++) {
    const fp = path.join(dir, `Font${i}.ttf`);
    const buf = Buffer.alloc(eachMiB * 1024 * 1024);
    for (let j = 0; j < buf.length; j += 4) buf.writeUInt32LE((j * 2654435761 + i) >>> 0, j);
    fs.writeFileSync(fp, buf);
    attachArgs.push(
      '-attach',
      fp,
      `-metadata:s:t:${i}`,
      'mimetype=application/x-truetype-font',
      `-metadata:s:t:${i}`,
      `filename=Font${i}.ttf`,
    );
  }
  const assPath = path.join(dir, 'sub.ass');
  fs.writeFileSync(
    assPath,
    '[Script Info]\nScriptType: v4.00+\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.10,0:00:01.50,Default,,0,0,0,,Test\n',
  );
  const out = path.join(dir, 'fonts_20mib.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=24:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=2',
    '-i',
    assPath,
    ...attachArgs,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-map',
    '2:s:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'ac3',
    '-b:a',
    '192k',
    '-c:s',
    'ass',
    out,
  ]);
  return out;
}

export function buildSparseForcedSubMkv(dir) {
  // ~42 MiB 60s H.264 + AC3 MKV with a single Forced SRT cue at t = 55.0s
  const srtPath = path.join(dir, 'forced.srt');
  fs.writeFileSync(srtPath, '1\n00:00:55,000 --> 00:00:58,000\nForced sign at 55s.\n\n');
  const out = path.join(dir, 'sparse_sub_60s.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1280x720:rate=24:duration=60',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=60',
    '-i',
    srtPath,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-map',
    '2:s:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '5500k',
    '-maxrate',
    '6000k',
    '-bufsize',
    '6000k',
    '-g',
    '24',
    '-c:a',
    'ac3',
    '-ac',
    '6',
    '-b:a',
    '448k',
    '-c:s',
    'srt',
    out,
  ]);
  return out;
}
