/* Actual watch player + synthetic Plex responses. Never loads .env or live credentials. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { createApp } = require('../server/app');
const { AV1, run } = require('../server/av1');
const { buildPlaybackFixtures, execute:executeTool } = require('./build-playback-fixtures');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { checkBuffering } = require('./lib/playback-buffering');
const root = path.resolve(__dirname,'..');

function fixturePlex(directory, manifest, control = {}) {
  const selectedSubtitles=new Map(), selectedAudio=new Map(), sessions=new Map();
  const streams = source => [...source.probe.streams.map((s,i)=>({id:Number(source.id)*10+i,index:s.index,streamType:{video:1,audio:2,subtitle:3}[s.codec_type],
    codec:s.codec_name,language:s.tags?.language,languageCode:s.tags?.language,displayTitle:s.tags?.title,channels:s.channels,
    selected:s.codec_type==='audio' ? selectedAudio.has(source.id) ? String(Number(source.id)*10+i)===selectedAudio.get(source.id) : !!s.disposition?.default : s.codec_type==='subtitle' && String(Number(source.id)*10+i)===selectedSubtitles.get(source.id)})),
    {id:Number(source.id+'90'),streamType:3,codec:'webvtt',language:'English',languageCode:'eng',displayTitle:'English SDH (WebVTT)',hearingImpaired:1,key:'/library/streams/'+source.id+'90',selected:selectedSubtitles.get(source.id)===source.id+'90'},
    ...(fs.existsSync(path.join(directory,'captions-fr.srt')) ? [{id:Number(source.id+'91'),streamType:3,codec:'srt',language:'French',languageCode:'fra',displayTitle:'French (SRT)',key:'/library/streams/'+source.id+'91',selected:selectedSubtitles.get(source.id)===source.id+'91'}] : []),
    {id:Number(source.id+'92'),streamType:3,codec:'ass',language:'English',languageCode:'eng',displayTitle:'English styled (ASS)',key:'/library/streams/'+source.id+'92',selected:selectedSubtitles.get(source.id)===source.id+'92'}];
  const json = value => new Response(JSON.stringify({MediaContainer:value}),{headers:{'Content-Type':'application/json'}});
  const send = (file,options,type) => {
    const request={file:path.relative(directory,file).replaceAll('\\','/'),range:options.headers?.Range || null};
    control.requests?.push(request);
    if (control.blocked) {request.status=503;return new Response(null,{status:503});}
    const size = fs.statSync(file).size, header = options.headers?.Range;
    let start = 0, end = size - 1;
    if (header) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(header);
      if (!match || !match[1] && !match[2]) return new Response(null,{status:416});
      if (!match[1]) start = Math.max(0,size - Number(match[2]));
      else { start = Number(match[1]); if (match[2]) end = Math.min(end,Number(match[2])); }
      if (!Number.isSafeInteger(start) || start > end || start >= size) return new Response(null,{status:416});
    }
    request.status=header ? 206 : 200;request.offeredBytes=options.method==='HEAD' ? 0 : end-start+1;
    return new Response(options.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file,{start,end})),{
      status:header ? 206 : 200,headers:{'Content-Type':type,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes',
        ...(header ? {'Content-Range':`bytes ${start}-${end}/${size}`} : {})}
    });
  };
  return async (input,options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'http://playback-fixture.invalid:32400' || options.headers?.['X-Plex-Token'] !== 'synthetic-playback-only') throw new Error('Unexpected fixture upstream');
    if (url.pathname === '/library/sections') return json({Directory:[]});
    const select=/^\/library\/parts\/(\d+)$/.exec(url.pathname);
    if(select && options.method==='PUT') {
      const source=manifest.sources.find(s=>s.id===select[1]), audioChoice=url.searchParams.get('audioStreamID'), choice=url.searchParams.get('subtitleStreamID');
      if(!source || audioChoice && !streams(source).some(s=>s.streamType===2 && String(s.id)===audioChoice) || choice && !streams(source).some(s=>s.streamType===3 && String(s.id)===choice))return new Response(null,{status:404});
      if(choice)selectedSubtitles.set(source.id,choice);
      if(audioChoice)selectedAudio.set(source.id,audioChoice);
      control.events?.push({event:'select',source:source.id,subtitleId:choice,audioId:audioChoice}); return json({});
    }
    const metadata = /^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    const part = /^\/library\/parts\/(\d+)\/file$/.exec(url.pathname);
    const source = manifest.sources.find(s => s.id === (metadata?.[1] || part?.[1]));
    if (metadata && source) {
      const v = source.probe.streams.find(s => s.codec_type === 'video');
      return json({Metadata:[{ratingKey:source.id,type:'movie',title:'Synthetic ' + source.file,duration:Math.round(source.duration * 1000),
        Media:[{videoCodec:v.codec_name,bitrate:24000,width:v.width,height:v.height,Part:[{id:Number(source.id),key:'/library/parts/' + source.id + '/file',
          Stream:streams(source)}]}]}]});
    }
    if (part && source) return send(path.join(directory,source.file),options,source.file.endsWith('.mkv') ? 'video/x-matroska' : 'video/mp4');
    const sidecar=/^\/library\/streams\/(\d+)\.[a-z]+$/.exec(url.pathname);
    if(sidecar)for(const source of manifest.sources){const row=streams(source).find(s=>s.streamType===3 && String(s.id)===sidecar[1] && s.key);if(row)return send(path.join(directory,row.codec==='srt' ? 'captions-fr.srt' : row.codec==='ass' ? 'captions.ass' : 'captions.vtt'),options,'text/plain; charset=utf-8');}
    if (['/video/:/transcode/universal/decision','/video/:/transcode/universal/start.m3u8'].includes(url.pathname)) {
      const source=manifest.sources.find(s=>'/library/metadata/'+s.id===url.searchParams.get('path'));
      if(!source)return new Response(null,{status:404});
      const catalog=streams(source), audioId=String(catalog.find(s=>s.streamType===2 && s.selected)?.id || catalog.find(s=>s.streamType===2).id);
      const audio=catalog.find(s=>String(s.id)===audioId && s.streamType===2);
      const subtitle=url.searchParams.get('subtitles')==='burn' ? catalog.find(s=>s.streamType===3 && s.selected) : undefined;
      if(!audio)return new Response(null,{status:400});
      if(url.pathname.endsWith('/decision')) {
        control.events?.push({event:'decision',session:url.searchParams.get('session'),audioId,subtitleId:subtitle && String(subtitle.id)});
        return json({generalDecisionCode:1001,Metadata:[{Media:[{videoCodec:'h264',audioCodec:'aac',subtitleDecision:subtitle ? 'burn' : 'none',Part:[{Stream:[{streamType:1,codec:'h264'},{streamType:2,id:audio.id,codec:'aac',selected:1},...(subtitle ? [{streamType:3,id:subtitle.id,codec:subtitle.codec,decision:'burn'}] : [])]}]}]}]});
      }
      const french=audio.languageCode==='fra', styled=subtitle && ['ass','ssa'].includes(subtitle.codec);
      const rendition=subtitle ? 'hls-'+(styled ? 'ass' : 'srt')+(french ? '-french' : '') : french ? 'hls-french' : 'hls';
      if(!fs.existsSync(path.join(directory,rendition,'start.m3u8')))return new Response(null,{status:503});
      sessions.set(url.searchParams.get('session'),{audioId,subtitleId:subtitle && String(subtitle.id),rendition});
      control.events?.push({event:'start',session:url.searchParams.get('session'),...sessions.get(url.searchParams.get('session'))});
      if(control.blocked)return new Response(null,{status:503});
      const text=fs.readFileSync(path.join(directory,rendition,'start.m3u8'),'utf8').replace(/^(segment-\d{3}\.ts)$/gm,
        '/video/:/transcode/universal/renditions/'+rendition+'/$1?session='+encodeURIComponent(url.searchParams.get('session')));
      return new Response(text,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    }
    const rendition=/^\/video\/:\/transcode\/universal\/renditions\/(hls(?:-(?:french|srt|ass)(?:-french)?)?)\/(segment-\d{3}\.ts)$/.exec(url.pathname);
    if(rendition){
      const session=url.searchParams.get('session');
      if(!session || sessions.get(session)?.rendition!==rendition[1] || control.expiredSessions?.has(session)){
        control.events?.push({event:'expired-fragment',session});return new Response(null,{status:404});
      }
      return send(path.join(directory,rendition[1],rendition[2]),options,'video/mp2t');
    }
    const segment = /^\/video\/:\/transcode\/universal\/(segment-\d{3}\.ts)$/.exec(url.pathname);
    if (segment) return send(path.join(directory,'hls',segment[1]),options,'video/mp2t');
    if (/^\/video\/:\/transcode\/universal\/(stop|ping)$/.test(url.pathname)) return json({});
    return new Response(null,{status:404});
  };
}

// Runs in the disposable browser against the actual #video element. Web Audio
// measures decoded PCM, not speaker output; canvas checks sampled picture pixels.
function installMeter() {
  const video = document.getElementById('video');
  const context = new AudioContext(), analyser = context.createAnalyser(); analyser.fftSize = 8192;
  const audioSource = context.createMediaElementSource(video); audioSource.connect(analyser); analyser.connect(context.destination);
  const spectrum = new Float32Array(analyser.frequencyBinCount);
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2;
  const picture = canvas.getContext('2d',{willReadFrequently:true});
  let data;
  const meter = globalThis.playbackMeter = {
    reset(id,format) { data = {id,format,started:performance.now(),firstFrameMs:null,samples:[],events:[],callbacks:0}; },
    sample() {
      if (!data || state?.mediaId !== data.id || data.format && state.format !== data.format) return null;
      const quality = video.getVideoPlaybackQuality();
      if (data.firstFrameMs === null && !video.paused && video.currentTime > .1 && decodedFrames() > 0) data.firstFrameMs = performance.now() - data.started;
      analyser.getFloatFrequencyData(spectrum);
      let peak = 0; for (let i = 1; i < spectrum.length; i++) if (spectrum[i] > spectrum[peak]) peak = i;
      let pixels = null;
      try { picture.drawImage(video,0,0,2,2); pixels = [...picture.getImageData(0,0,2,2).data].filter((_,i) => i % 4 !== 3).reduce((a,b) => a+b,0); } catch {}
      const sample = {elapsedMs:performance.now()-data.started,position:video.currentTime,target:expected(),rate:video.playbackRate,
        frames:quality.totalVideoFrames,dropped:quality.droppedVideoFrames,width:video.videoWidth,height:video.videoHeight,
        paused:video.paused,seeking:video.seeking,readyState:video.readyState,buffering:playerWaiting,
        audioHz:peak * context.sampleRate / analyser.fftSize,audioDb:Number.isFinite(spectrum[peak]) ? spectrum[peak] : null,
        audioContext:context.state,pixels,format:state.format,error:playbackError || null,
        buffered:Array.from({length:video.buffered.length},(_,i) => [video.buffered.start(i),video.buffered.end(i)])};
      data.samples.push(sample); return sample;
    },
    report() { return {...data,started:undefined}; },
    async resumeAudio() { await Promise.race([context.resume(),new Promise(resolve => setTimeout(resolve,1500))]); return context.state; }
  };
  for (const event of ['playing','waiting','stalled','seeking','seeked','pause','ended','error']) video.addEventListener(event,() => {
    if (data && state?.mediaId === data.id && (!data.format || state.format === data.format)) data.events.push({event,elapsedMs:performance.now()-data.started,position:video.currentTime});
  });
  function frame() { if (data) data.callbacks++; video.requestVideoFrameCallback(frame); }
  video.requestVideoFrameCallback(frame);
  return true;
}

function summarize(data, source) {
  const samples = data.samples.filter(s => !s.paused && !s.seeking && s.readyState >= 3 && s.elapsedMs > data.firstFrameMs + 800);
  const first = samples[0], last = samples.at(-1), elapsed = first && last ? last.position-first.position : 0;
  const fps = elapsed > 1 ? (last.frames-first.frames)/elapsed : null;
  const audio = samples.filter(s => s.audioDb !== null && s.audioDb > -65 && Math.abs(s.audioHz-source.expectedAudioHz) < 20);
  const drift = samples.map(s => Math.abs(s.position-s.target)).sort((a,b) => a-b);
  const driftP95 = drift.length ? drift[Math.floor((drift.length-1)*.95)] : null;
  const errors = [];
  if (samples.length < 10 || elapsed < 3) errors.push('Insufficient sustained playback');
  if (fps === null || Math.abs(fps-source.expectedFps) > source.expectedFps * .12) errors.push('Video cadence differs from the source');
  if (audio.length < 3) errors.push('Expected decoded audio tone was not confirmed');
  if (!samples.some(s => s.pixels > 100 && s.width === 640 && s.height === 360)) errors.push('Decoded picture pixels were not confirmed');
  const stalls = data.events.filter(e => ['waiting','stalled'].includes(e.event) && e.elapsedMs > data.firstFrameMs + 1000);
  if (stalls.length) errors.push('Playback stalled after startup');
  if (samples.some(s => s.error)) errors.push('Player reported a playback error');
  if (driftP95 !== null && driftP95 > .75) errors.push('Room drift persisted beyond the correction band');
  return {firstFrameMs:data.firstFrameMs,expectedFps:source.expectedFps,observedFps:fps,
    frames:first && last ? last.frames-first.frames : 0,droppedFrames:first && last ? last.dropped-first.dropped : 0,
    audioEvidence:'Decoded PCM tone via Web Audio; physical output not tested',audioSamples:audio.length,
    driftP95Seconds:driftP95,steadyStalls:stalls.length,errors};
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => !/^--(out|media|ffmpeg|ffprobe|browsers|acceleration|cases|buffering)=.+/.test(arg))) throw new Error('Use --out=new-directory [--media=generated-corpus --browsers=firefox,chrome,edge --acceleration=software|default --cases=id,... --buffering=on --ffmpeg=path --ffprobe=path]');
  const option = (name,fallback) => args.find(arg => arg.startsWith('--'+name+'='))?.slice(name.length+3) || fallback;
  const output = path.resolve(option('out',path.join(root,'artifacts','playback-baseline-' + Date.now())));
  if (fs.existsSync(output)) throw new Error('Use a new report directory; earlier evidence is never overwritten.');
  fs.mkdirSync(output,{recursive:true});
  const ffmpeg = option('ffmpeg','ffmpeg'), ffprobe = option('ffprobe','ffprobe');
  const directory = path.resolve(option('media',path.join(output,'media')));
  const manifest = args.some(arg => arg.startsWith('--media=')) ? JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8')) : buildPlaybackFixtures({output:directory,ffmpeg,ffprobe});
  if (manifest.kind !== 'uburoom-synthetic-playback' || manifest.schema !== 1 || !Array.isArray(manifest.sources)) throw new Error('Use the generated synthetic playback manifest');
  for (const source of manifest.sources) if (!/^\d+$/.test(source.id) || !/^[\w.-]+$/.test(source.file) || !Number.isFinite(source.duration) || source.duration < 16) throw new Error('Invalid synthetic source');
  const browsers = option('browsers','firefox,chrome,edge').split(',');
  if (browsers.some(name => !['firefox','chrome','edge'].includes(name))) throw new Error('Unknown browser');
  const acceleration = option('acceleration','software');
  if (!['software','default'].includes(acceleration)) throw new Error('Unknown acceleration mode');
  const selected = option('cases','').split(',').filter(Boolean);
  const allCases = [
    {id:'direct-23976',sourceId:'101',format:'file'},{id:'direct-24',sourceId:'102',format:'file'},{id:'direct-60',sourceId:'103',format:'file'},
    {id:'auto-hevc-tracks',sourceId:'104'},{id:'hls-hevc',sourceId:'104',format:'hls'},
    {id:'av1-23976',sourceId:'101',format:'av1'},{id:'av1-60',sourceId:'103',format:'av1'}
  ];
  if (selected.some(id => !allCases.some(c => c.id === id))) throw new Error('Unknown playback case');
  const cases = allCases.filter(c => !selected.length || selected.includes(c.id));
  const buffering = option('buffering','off');
  if (!['on','off'].includes(buffering)) throw new Error('Use --buffering=on|off');
  if (buffering === 'on' && cases.some(c => manifest.sources.find(s => s.id === c.sourceId).duration < 85)) throw new Error('Buffering checks require a synthetic corpus at least 85 seconds long. Generate with --duration=90.');
  const report = {schema:1,createdAt:new Date().toISOString(),environment:{platform:process.platform,node:process.version,headless:true,acceleration},
    isolation:{liveAccounts:false,livePlex:false,realDiscordActivity:false,productionEncoder:'av1_qsv',testEncoder:'libsvtav1'},
    results:[],encodedVideo:[],notCovered:[...manifest.notCovered,'Source audio switching','Production subtitle delivery/rendering',
      'VFR timing, A/V and caption alignment, final end-of-stream semantics','Safari/iOS/Android','Two-hour soak and bandwidth/load tests']};
  const writeReport = () => {
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    const rows = report.results.map(r => `| ${r.browser} ${r.version || ''} | ${r.case} | ${r.status} | ${r.metrics?.firstFrameMs?.toFixed(0) ?? '-'} | ${r.metrics?.observedFps?.toFixed(2) ?? '-'} / ${r.metrics?.expectedFps?.toFixed(2) ?? '-'} | ${r.metrics?.audioSamples ?? '-'} | ${(r.errors || []).join('; ')} |`);
    const buffered = report.results.filter(r=>r.buffering).map(r=>`| ${r.browser} | ${r.case} | ${r.buffering.filled.loaded.toFixed(1)} | ${(r.buffering.outageEnd.position-r.buffering.outageStart.position).toFixed(1)} | ${r.buffering.distantSeek.recoveryMs} |`);
    fs.writeFileSync(path.join(output,'report.md'),'# Isolated playback baseline\n\nSynthetic sources and simulated Plex responses; actual watch player and authorized media routes. AV1 uses a test-only software encoder. Headless ' + acceleration + ' decode mode; this is not Discord or hardware certification.\n\n' +
      '| Browser | Case | Result | Startup ms | Observed / source fps | Audio tone samples | Failure |\n| --- | --- | --- | --- | --- | --- | --- |\n' + rows.join('\n') +
      '\n\nAudio evidence measures decoded PCM, not speakers. HLS is pre-generated and does not establish live Plex negotiation. Metrics are single-run observations, not performance percentiles.\n' +
      (buffered.length ? '\n## Buffering and media interruption\n\nControl stayed reachable during a ten-second media delivery outage. Cached rewind, recovery and desktop/theater/phone renders were also checked. JSON records exact ranges, frames and decoded audio evidence.\n\n| Browser | Case | Ahead while paused (s) | Advanced during outage (s) | Distant seek/resume (ms) |\n| --- | --- | --- | --- | --- |\n'+buffered.join('\n')+'\n' : '') +
      '\n## Not exercised\n\n' + report.notCovered.map(s => '- '+s).join('\n') + '\n');
  };
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'synthetic-guild',channels:['synthetic-commands'],demo:true,
    plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const mediaControl = {requests:[],blocked:false};
  const app = createApp(config,{plexFetch:fixturePlex(directory,manifest,mediaControl),oauthFetch:async () => { throw new Error('Live OAuth is disabled in the baseline'); }});
  // Substitute the encoder only in this fixture's instance. Production policy stays intact.
  const originalAV1 = app.watch.plex.av1;
  let encoded = 0;
  app.watch.plex.av1 = new AV1(app.watch.plex,{ffmpegPath:ffmpeg,ffprobePath:ffprobe},async (binary,parameters,signal) => {
    const encoding = parameters.includes('av1_qsv');
    let actual = [...parameters];
    if (encoding) {
      actual = actual.map(value => value === 'av1_qsv' ? 'libsvtav1' : value === 'veryfast' ? '12' : value === 'nv12' ? 'yuv420p' : value.replaceAll('format=nv12','format=yuv420p'));
      for (const flag of ['-maxrate','-bufsize']) { const index = actual.indexOf(flag); if (index !== -1) actual.splice(index,2); }
      actual.splice(actual.indexOf('-c:v'),0,'-svtav1-params','lp=2:pred-struct=1:rc=2');
    }
    const bytes = await run(binary,actual,signal,30000,48 * 1024 * 1024);
    if (encoding && actual.includes('-ss')) {
      const file = path.join(output,'encoded-' + (++encoded) + '.webm'); fs.writeFileSync(file,bytes.video);
      const info = JSON.parse(executeTool(ffprobe,['-v','error','-count_frames','-show_entries','stream=r_frame_rate,avg_frame_rate,nb_read_frames:format=duration','-of','json',file]));
      report.encodedVideo.push({file:path.basename(file),sourceStartSeconds:Number(actual[actual.indexOf('-ss')+1]),probe:info});
    }
    return bytes;
  });
  app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'synthetic-call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl = 'https://localhost:' + app.server.address().port;
  try {
    for (const name of browsers) {
      let browser;
      try {
        browser = await playbackBrowser(name,{acceleration});
        const page = await browser.page(config.publicUrl + '/watch?demo=host');
        await browser.until(page,'typeof me !== "undefined" && !!me','Synthetic login');
        await browser.evaluate(page,'preferredQuality="direct"; document.getElementById("create").click(); true');
        await browser.until(page,'!!state','Room creation');
        await browser.evaluate(page,'(' + installMeter.toString() + ')()');
        await browser.evaluate(page,'playbackMeter.resumeAudio()');
        for (const entry of cases) {
          const source = manifest.sources.find(s => s.id === entry.sourceId);
          const result = {browser:name,version:browser.version,case:entry.id,source:source.file,status:'failed',errors:[]};
          console.log('[Playback]',name,entry.id);
          try {
            await browser.evaluate(page,'state?.mediaId ? execute({action:"media.pause"}).then(()=>true) : true');
            await browser.evaluate(page,`playbackMeter.reset(${JSON.stringify(source.id)},${JSON.stringify(entry.format || null)}); true`);
            await browser.evaluate(page,`execute({action:"media.load",args:{mediaId:${JSON.stringify(source.id)},quality:"direct"}}).then(()=>true)`);
            if (['hls','av1'].includes(entry.format)) {
              await browser.evaluate(page,`playbackMeter.reset(${JSON.stringify(source.id)},${JSON.stringify(entry.format)}); execute({action:"media.quality.set",args:{quality:"direct",compatible:true${entry.format === 'av1' ? ',fallback:"av1"' : ''}}}).then(()=>true)`);
            }
            await browser.until(page,'(()=>{ const s=playbackMeter.sample(); return s && !s.error && !s.paused && s.position>.15 && s.frames>0 && s.readyState>=3; })()','Decoded playback',25000);
            const until = Date.now() + 7200;
            while (Date.now() < until) { await browser.evaluate(page,'playbackMeter.sample(); true'); await pause(200); }
            const data = JSON.parse(await browser.evaluate(page,'JSON.stringify(playbackMeter.report())'));
            result.metrics = summarize(data,source); result.errors.push(...result.metrics.errors); delete result.metrics.errors;
            const seekAt = Date.now();
            await browser.evaluate(page,'execute({action:"media.pause"}).then(()=>execute({action:"media.seek.absolute",args:{seconds:12}})).then(()=>true)');
            await browser.until(page,'video.paused && !video.seeking && video.readyState>=2 && Math.abs(video.currentTime-12)<.7','Paused seek',15000);
            result.metrics.pausedSeekMs = Date.now()-seekAt;
            await browser.evaluate(page,'execute({action:"media.play"}).then(()=>true)');
            await browser.until(page,'!video.paused && !video.seeking && video.currentTime>13.25','Resume after seek',15000);
            await browser.evaluate(page,'playbackMeter.sample(); true');
            if (buffering === 'on') result.buffering = await checkBuffering({browser,page,source,mediaControl,output,label:entry.id+'-'+name});
            result.status = result.errors.length ? 'failed' : 'passed';
            result.evidence = entry.id + '-' + name + '.json';
            fs.writeFileSync(path.join(output,result.evidence),JSON.stringify(JSON.parse(await browser.evaluate(page,'JSON.stringify(playbackMeter.report())')),null,2)+'\n');
          } catch (error) {
            result.errors.push(error.message);
            result.diagnostic = JSON.parse(await browser.evaluate(page,'JSON.stringify({error:playbackError,format:state?.format,position:video.currentTime,ready:video.readyState,paused:video.paused,frames:decodedFrames(),buffered:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])})').catch(() => 'null'));
            result.evidence = entry.id + '-' + name + '.json';
            const evidence = await browser.evaluate(page,'JSON.stringify(playbackMeter.report())').catch(() => 'null');
            fs.writeFileSync(path.join(output,result.evidence),JSON.stringify(JSON.parse(evidence),null,2)+'\n');
          }
          report.results.push(result); writeReport();
          console.log('[Playback]',result.status,entry.id,result.errors.join('; '));
        }
      } catch (error) { report.results.push({browser:name,case:'browser-startup',status:'failed',errors:[error.message]}); writeReport(); }
      finally { await browser?.close(); }
    }
  } finally { await app.close(); await originalAV1.close(); writeReport(); }
  const failures = report.results.filter(result => result.status !== 'passed').length;
  console.log('[Playback]',report.results.length-failures,'passed,',failures,'failed. Report:',path.join(output,'report.md'));
  if (failures) process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error('[Playback]',error.stack); process.exitCode = 1; });
module.exports = { summarize, fixturePlex, installMeter };
