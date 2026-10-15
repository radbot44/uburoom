/* Procedural playback corpus. No accounts, network inputs, fonts or downloaded media. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

function execute(binary, args, options = {}) {
  const result = spawnSync(binary, args, { ...options,windowsHide:true, encoding:'utf8', timeout:120000, maxBuffer:8 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || 'Synthetic media generation failed');
  return result.stdout;
}

function buildPlaybackFixtures({ output, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', duration = 18, tracks = false }) {
  if (!Number.isInteger(duration) || duration < 18 || duration > 300) throw new Error('Fixture duration must be an integer from 18 to 300 seconds.');
  output = path.resolve(output);
  if (fs.existsSync(output)) throw new Error('Use a new fixture directory; existing media is never overwritten.');
  const version = execute(ffmpeg, ['-version']).split(/\r?\n/)[0];
  execute(ffprobe, ['-version']);
  fs.mkdirSync(output, { recursive:true });
  const basic = ['-hide_banner','-loglevel','error','-nostdin','-n'];
  const encode = args => execute(ffmpeg, [...basic, ...args],{cwd:output});
  const probe = file => JSON.parse(execute(ffprobe, ['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]));
  const video = fps => ['-f','lavfi','-i',`testsrc2=size=640x360:rate=${fps}`];
  const tone = hz => ['-f','lavfi','-i',`sine=frequency=${hz}:sample_rate=48000`];
  // A white pulse marks each source second; the pattern remains entirely procedural.
  const picture = "drawbox=x=0:y=0:w=64:h=64:color=black:t=fill,drawbox=x=0:y=0:w=64:h=64:color=white:t=fill:enable='lt(mod(t,1),0.1)'";
  const h264 = ['-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-threads','2'];
  const sources = [];
  function record(id, file, fps, expectedAudioHz, extra = {}) {
    const info = probe(path.join(output,file));
    const stream = info.streams.find(s => s.codec_type === 'video');
    const actualFps = stream.avg_frame_rate.split('/').map(Number).reduce((a,b) => a / b);
    if (Math.abs(actualFps - fps) > .01 || stream.width !== 640 || stream.height !== 360) throw new Error('Unexpected generated video: ' + file);
    if (!info.streams.some(s => s.codec_type === 'audio')) throw new Error('Missing generated audio: ' + file);
    // Do not copy ffprobe's local filename into a shareable manifest.
    delete info.format.filename;
    sources.push({ id, file, expectedFps:fps, expectedAudioHz, duration:Number(info.format.duration),
      sha256:createHash('sha256').update(fs.readFileSync(path.join(output,file))).digest('hex'), probe:info, ...extra });
  }
  for (const [id, rate, fps, name] of [['101','24000/1001',24000/1001,'cadence-23976.mp4'],['102','24',24,'cadence-24.mp4'],['103','60',60,'cadence-60.mp4']]) {
    encode([...video(rate), ...tone(440), '-t',String(duration), '-map','0:v:0','-map','1:a:0','-vf',picture,
      ...h264,'-c:a','aac','-b:a','96k','-metadata:s:a:0','language=eng','-movflags','+faststart',path.join(output,name)]);
    record(id,name,fps,440);
  }
  fs.writeFileSync(path.join(output,'captions.srt'), '1\n00:00:01,000 --> 00:00:04,000\nuburoom: first caption\n\n2\n00:00:07,000 --> 00:00:10,000\nSecond caption across a segment boundary\n\n3\n00:00:13,000 --> 00:00:16,000\nFinal caption\n');
  fs.writeFileSync(path.join(output,'captions.vtt'), 'WEBVTT\n\n00:01.000 --> 00:04.000\nuburoom: first caption\n\n00:07.000 --> 00:10.000\nSecond caption across a segment boundary\n\n00:13.000 --> 00:16.000\nFinal caption\n');
  fs.writeFileSync(path.join(output,'captions-fr.srt'),'1\n00:00:01,000 --> 00:00:04,000\nuburoom : premier sous-titre\n\n2\n00:00:07,000 --> 00:00:10,000\nDeuxième sous-titre\n\n3\n00:00:13,000 --> 00:00:16,000\nDernier sous-titre\n');
  fs.writeFileSync(path.join(output,'captions.ass'), '[Script Info]\nScriptType: v4.00+\nPlayResX: 640\nPlayResY: 360\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,28,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,16,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.00,Default,,0,0,0,,Styled caption\nDialogue: 0,0:00:07.00,0:00:10.00,Default,,0,0,0,,{\\an8\\c&H00FFFF&}Positioned sign\n');
  encode([...video('24000/1001'), ...tone(440), ...tone(880), '-i',path.join(output,'captions.srt'),'-i',path.join(output,'captions.ass'),
    '-t',String(duration),'-map','0:v:0','-map','1:a:0','-map','2:a:0','-map','3:s:0','-map','4:s:0','-vf',picture,
    '-c:v','libx265','-preset','fast','-crf','28','-pix_fmt','yuv420p10le','-x265-params','pools=2:frame-threads=1:log-level=error',
    '-c:a','ac3','-b:a','192k','-ac','6','-c:s','copy','-metadata:s:a:0','language=eng','-metadata:s:a:0','title=English 440 Hz',
    '-metadata:s:a:1','language=fra','-metadata:s:a:1','title=French 880 Hz','-metadata:s:s:0','language=eng','-metadata:s:s:1','language=eng',
    '-disposition:a:0','default','-disposition:a:1','0',path.join(output,'hevc-tracks.mkv')]);
  record('104','hevc-tracks.mkv',24000/1001,440,{ audioChoices:[{language:'eng',frequency:440},{language:'fra',frequency:880}],
    captions:['subrip','ass'], captionCues:[{start:1,end:4},{start:7,end:10},{start:13,end:16}] });
  const multi = sources.at(-1).probe.streams;
  if (multi.filter(s => s.codec_type === 'audio').length !== 2 || multi.filter(s => s.codec_type === 'subtitle').length !== 2 ||
    multi.find(s => s.codec_type === 'video').pix_fmt !== 'yuv420p10le') throw new Error('Incomplete multi-track fixture');
  fs.mkdirSync(path.join(output,'hls'));
  encode(['-i',path.join(output,'hevc-tracks.mkv'),'-map','0:v:0','-map','0:a:0','-sn',...h264,'-c:a','aac','-b:a','96k','-ac','2',
    '-force_key_frames','expr:gte(t,n_forced*2)','-hls_time','2','-hls_playlist_type','vod',
    '-hls_segment_filename',path.join(output,'hls','segment-%03d.ts'),path.join(output,'hls','start.m3u8')]);
  if(tracks)for(const [name,audio,subtitle] of [['hls-french',1],['hls-srt',0,0],['hls-srt-french',1,0],['hls-ass',0,1],['hls-ass-french',1,1]]) {
    fs.mkdirSync(path.join(output,name));
    encode(['-i',path.join(output,'hevc-tracks.mkv'),'-map','0:v:0','-map','0:a:'+audio,'-sn',
      ...(subtitle!==undefined ? ['-vf','subtitles=filename=hevc-tracks.mkv:si='+subtitle] : []),...h264,'-c:a','aac','-b:a','96k','-ac','2',
      '-force_key_frames','expr:gte(t,n_forced*2)','-hls_time','2','-hls_playlist_type','vod',
      '-hls_segment_filename',path.join(output,name,'segment-%03d.ts'),path.join(output,name,'start.m3u8')]);
  }
  const manifest = { schema:1, kind:'uburoom-synthetic-playback', generator:version, sources,
    hls:{ sourceId:'104', directory:'hls', note:'Pre-generated H.264/AAC conversion; Plex negotiation is simulated, not a live server test.' },
    trackRenditions:tracks,
    notCovered:['PGS/VobSub image captions','HDR/Dolby Vision','live Plex negotiation','hardware encoding capacity','real Discord Activity','physical audio output'] };
  fs.writeFileSync(path.join(output,'manifest.json'), JSON.stringify(manifest,null,2) + '\n');
  return manifest;
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.some(arg => !/^--(ffmpeg|ffprobe|out|duration|tracks)=.+/.test(arg))) throw new Error('Use --out=new-directory [--duration=18..300 --tracks=on --ffmpeg=path --ffprobe=path]');
    const option = (name, fallback) => args.find(arg => arg.startsWith('--' + name + '='))?.slice(name.length + 3) || fallback;
    const output = path.resolve(option('out','artifacts/playback-media-' + Date.now()));
    if(!['on','off'].includes(option('tracks','off')))throw new Error('Use --tracks=on|off');
    const manifest = buildPlaybackFixtures({output,ffmpeg:option('ffmpeg','ffmpeg'),ffprobe:option('ffprobe','ffprobe'),duration:Number(option('duration','18')),tracks:option('tracks','off')==='on'});
    console.log('Generated and probed ' + manifest.sources.length + ' synthetic sources plus HLS in ' + output);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { buildPlaybackFixtures, execute };
