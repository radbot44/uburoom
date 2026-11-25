import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runDemuxArchWorkload } from './ubuplayer-archc-proto.mjs';

function buildW1Mkv(dir, durationSec = 45) {
  const srt = path.join(dir, 'w1_forced.srt');
  const cueAt = Math.max(2, durationSec - 5);
  fs.writeFileSync(
    srt,
    `1\n00:00:${String(cueAt).padStart(2, '0')},000 --> 00:00:${String(cueAt + 2).padStart(2, '0')},000\nForced sign\n\n`,
  );
  const out = path.join(dir, 'w1_truehd_ac3_sparse.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=24:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=660:sample_rate=48000:duration=${durationSec}`,
    '-i',
    srt,
    '-filter_complex',
    '[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a0];[2:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a1]',
    '-map',
    '0:v:0',
    '-map',
    '[a0]',
    '-map',
    '[a1]',
    '-map',
    '3:s:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '5000k',
    '-maxrate',
    '5500k',
    '-bufsize',
    '5500k',
    '-g',
    '24',
    '-c:a:0',
    'ac3',
    '-b:a:0',
    '448k',
    '-c:a:1',
    'truehd',
    '-strict',
    '-2',
    '-c:s',
    'srt',
    out,
  ]);
  return out;
}

function buildW2NonInterleavedMp4(dir, durationSec = 30) {
  const out = path.join(dir, 'w2_non_interleaved.mp4');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=24:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${durationSec}`,
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '4800k',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-chunk_duration',
    '30000000',
    out,
  ]);
  return out;
}

function buildW3FontsMkv(dir) {
  const attachArgs = [];
  for (let i = 0; i < 5; i++) {
    const fp = path.join(dir, `W3Font${i}.ttf`);
    const buf = Buffer.alloc(4 * 1024 * 1024);
    for (let j = 0; j < buf.length; j += 4) buf.writeUInt32LE((j * 2654435761 + i) >>> 0, j);
    fs.writeFileSync(fp, buf);
    attachArgs.push(
      '-attach',
      fp,
      `-metadata:s:t:${i}`,
      'mimetype=application/x-truetype-font',
      `-metadata:s:t:${i}`,
      `filename=W3Font${i}.ttf`,
    );
  }
  const out = path.join(dir, 'w3_fonts_20mib.mkv');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=24:duration=4',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000:duration=4',
    ...attachArgs,
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-c:a',
    'ac3',
    '-b:a',
    '192k',
    out,
  ]);
  return out;
}

function buildW4OffsetGapTs(dir, durationSec = 30) {
  const out = path.join(dir, 'w4_offset_gap.ts');
  execFileSync('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=24:duration=${durationSec}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=1000:sample_rate=48000:duration=${durationSec}`,
    '-filter_complex',
    "[1:a]aselect='not(between(t,4.0,4.25))'[aout]",
    '-map',
    '0:v:0',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-b:v',
    '2000k',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-output_ts_offset',
    '12.345',
    out,
  ]);
  return out;
}

function mib(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  const jsonOnly = args.has('--json');
  const quick = args.has('--quick');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ubu-t2-bench-'));

  try {
    const w1Buf = fs.readFileSync(buildW1Mkv(tmpDir, quick ? 15 : 45));
    const w2Buf = fs.readFileSync(buildW2NonInterleavedMp4(tmpDir, quick ? 10 : 30));
    const w3Buf = fs.readFileSync(buildW3FontsMkv(tmpDir));
    const w4Buf = fs.readFileSync(buildW4OffsetGapTs(tmpDir, quick ? 10 : 30));

    const workloads = [
      {
        id: 'W1',
        label: `TrueHD+AC3+SparseSRT MKV (${mib(w1Buf.byteLength)} MiB)`,
        buffer: w1Buf,
        opts: { windowSeconds: quick ? 10 : 12, switchAtSec: 5.0, switchAudioOrdinal: 1, enableLocalSubtitle: true },
      },
      {
        id: 'W2',
        label: `Non-Interleaved MP4 (${mib(w2Buf.byteLength)} MiB)`,
        buffer: w2Buf,
        opts: { windowSeconds: 10, switchAtSec: 0, enableLocalSubtitle: false },
      },
      {
        id: 'W3',
        label: `5x4MiB Font MKV + Reopen (${mib(w3Buf.byteLength)} MiB)`,
        buffer: w3Buf,
        opts: { windowSeconds: 3, switchAtSec: 0, enableLocalSubtitle: false, reopenCount: 2 },
      },
      {
        id: 'W4',
        label: `MPEG-TS +12.345s Offset & 250ms Gap (${mib(w4Buf.byteLength)} MiB)`,
        buffer: w4Buf,
        opts: { windowSeconds: 8, switchAtSec: 0, enableLocalSubtitle: false },
      },
    ];

    const rows = [];
    for (const w of workloads) {
      for (const arch of ['arch-a', 'arch-b', 'arch-c']) {
        const res = await runDemuxArchWorkload({ arch, buffer: w.buffer, ...w.opts });
        rows.push({ workload: w.id, description: w.label, ...res });
      }
    }

    if (jsonOnly) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }

    console.log('## Track 2A Demuxer Benchmark Matrix\n');
    console.log(
      '| Workload | Arch | Mode | Read (MiB) | Dup Video (MiB) | onblockread | Bridge (MiB) | Peak HEAP (MiB) | Switch (ms) | Total (ms) |',
    );
    console.log('| :--- | :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const r of rows) {
      console.log(
        `| ${r.workload} | ${r.arch} | ${r.mode} | ${mib(r.uniqueReadBytes)} | ${mib(r.duplicateVideoBytes)} | ${r.onblockreadCalls} | ${mib(r.bridgeCopyBytes)} | ${mib(r.peakHeapU8Bytes)} | ${r.switchWallMs.toFixed(1)} | ${r.totalWallMs.toFixed(1)} |`,
      );
    }
    console.log('\n```json');
    console.log(JSON.stringify(rows, null, 2));
    console.log('```');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch(err => {
  console.error(err);
  process.exitCode = 1;
});
