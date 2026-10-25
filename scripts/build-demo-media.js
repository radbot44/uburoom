/* Recreate synthetic, credential-free diagnostic fixtures; FFmpeg is not bundled. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(ffmpeg|ffprobe|out)=/.test(arg))) throw new Error('Use optional --ffmpeg=path --ffprobe=path --out=new-directory');
  const option = (name, fallback) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
  const ffmpeg = option('ffmpeg', 'ffmpeg'), ffprobe = option('ffprobe', 'ffprobe');
  const output = path.resolve(option('out', path.join(root, 'artifacts/demo-media')));
  if (fs.existsSync(output)) throw new Error('Use a new output directory; existing fixtures are never overwritten.');
  function run(binary, parameters) {
    const result = spawnSync(binary, parameters, { windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr || 'Fixture generation failed');
    return result.stdout;
  }
  const encoders = run(ffmpeg, ['-hide_banner', '-encoders']);
  for (const encoder of ['libx264', 'libx265', 'libvpx', 'libvpx-vp9', 'libaom-av1', 'aac', 'libopus']) {
    if (!new RegExp('\\s' + encoder + '\\s').test(encoders)) throw new Error('FFmpeg lacks required encoder: ' + encoder);
  }
  run(ffprobe, ['-version']);
  fs.mkdirSync(output, { recursive: true });
  const basic = ['-hide_banner', '-loglevel', 'error', '-n'];
  const h264 = ['-c:v', 'libx264', '-preset', 'fast', '-crf', '25', '-pix_fmt', 'yuv420p', '-threads', '2'];
  const aac = ['-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-ar', '48000'];
  const opus = ['-c:a', 'libopus', '-b:a', '64k', '-ac', '1', '-ar', '48000'];
  const source = path.join(output, 'sync-test.mp4');
  run(ffmpeg, [...basic, '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-loop', '1', '-i', path.join(root, 'assets/branding/uburoom-wordmark-brand.png'),
    '-filter_complex', '[2:v]scale=320:-2,format=rgba[logo];[0:v]drawbox=x=12:y=12:w=344:h=124:color=0x101217@0.85:t=fill[bg];[bg][logo]overlay=24:24,format=yuv420p[v]',
    '-map', '[v]', '-map', '1:a', '-t', '60', '-r', '12', ...h264, '-profile:v', 'high', '-level:v', '2.2', ...aac, '-movflags', '+faststart', source]);
  const variants = [
    ['h264-baseline.mp4', [...h264, '-profile:v', 'baseline', '-level:v', '3.1'], aac],
    ['h264-main.mp4', [...h264, '-profile:v', 'main', '-level:v', '3.1'], aac],
    ['vp8.webm', ['-c:v','libvpx','-crf','30','-b:v','600k','-deadline','good','-cpu-used','8','-threads','2'], opus],
    ['vp9.webm', ['-c:v','libvpx-vp9','-crf','34','-b:v','0','-deadline','good','-cpu-used','5','-row-mt','1','-threads','2'], opus],
    ['av1.webm', ['-c:v','libaom-av1','-crf','38','-b:v','0','-cpu-used','8','-row-mt','1','-threads','2'], opus],
    ['hevc.mp4', ['-c:v','libx265','-crf','28','-preset','fast','-x265-params','pools=2:frame-threads=1:log-level=error:level-idc=3.1','-tag:v','hvc1'], aac]
  ];
  for (const [name, video, audio] of variants) {
    run(ffmpeg, [...basic, '-i', source, '-t', '12', '-map', '0:v', '-map', '0:a', ...video, ...audio, '-pix_fmt', 'yuv420p', ...(name.endsWith('.mp4') ? ['-movflags', '+faststart'] : []), path.join(output, name)]);
    console.log('Generated ' + name);
  }
  const metadata = {};
  for (const name of ['sync-test.mp4', ...variants.map(row => row[0])]) {
    const info = JSON.parse(run(ffprobe, ['-v','error','-show_entries','stream=codec_name,profile,level,width,height,r_frame_rate,pix_fmt,sample_rate,channels,bit_rate:format=duration','-of','json',path.join(output,name)]));
    const video = info.streams.find(s => s.width), audio = info.streams.find(s => s.sample_rate);
    if (video.width !== 640 || video.height !== 360 || video.r_frame_rate !== '12/1' || video.pix_fmt !== 'yuv420p' || audio.sample_rate !== '48000' || audio.channels !== 1) throw new Error('Unexpected fixture properties: ' + name);
    metadata[name] = info;
  }
  fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n');
  console.log('Validated synthetic fixtures in ' + output + '; inspect before replacing tracked assets.');
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
