/* Local end-to-end fixture only. Explicitly substitutes a bounded software
   encoder for tests; production always requires av1_qsv. Never loads .env. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { createApp } = require('../server/app');
const { AV1, run } = require('../server/av1');
const root = path.resolve(__dirname,'..'), pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function main() {
  const ffmpeg = process.argv.find(a => a.startsWith('--ffmpeg='))?.slice(9) || 'C:/ffmpeg/bin/ffmpeg.exe';
  const ffprobe = path.join(path.dirname(ffmpeg),process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost:6768',ownerId:'demo-host',guildId:'demo-guild',channels:['demo-commands'],demo:true,plexUrl:'http://fixture:32400',plexToken:'test-only'};
  const app = createApp(config), plex = app.watch.plex, file = path.join(root,'assets/demo/sync-test.mp4');
  const source = {type:'movie',title:'AV1 synthetic fixture',duration:60000,Media:[{videoCodec:'h264',height:1080,bitrate:24000,Part:[{key:'/library/parts/123/0/file.mp4'}]}]};
  plex.fetch = async (url,options) => {
    if (!url.pathname.startsWith('/library/parts/')) return new Response(JSON.stringify({MediaContainer:{Metadata:[source]}}));
    const size=fs.statSync(file).size, range=/^bytes=(\d+)-(\d*)$/.exec(options.headers.Range || '');
    const start=Number(range?.[1] || 0), end=range?.[2] ? Math.min(Number(range[2]),size-1) : size-1;
    return new Response(options.method === 'HEAD' ? null : Readable.toWeb(fs.createReadStream(file,{start,end})),{status:range?206:200,
      headers:{'Content-Type':'video/mp4','Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})}});
  };
  let encoded=0;
  plex.av1 = new AV1(plex,{ffmpegPath:ffmpeg,ffprobePath:ffprobe}, async (binary,args,signal) => {
    args=[...args];
    if (args.includes('av1_qsv')) {
      args[args.indexOf('av1_qsv')]='libsvtav1'; args[args.indexOf('veryfast')]='12'; args[args.indexOf('nv12')]='yuv420p';
      for (const option of ['-maxrate','-bufsize']) if (args.includes(option)) args.splice(args.indexOf(option),2);
      args.splice(args.indexOf('pipe:1')-4,0,'-svtav1-params','lp=2:pred-struct=1:rc=2');
      if (args.includes('-ss')) encoded++;
    }
    return run(binary,args,signal,20000,48*1024*1024);
  });
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl=`https://localhost:${app.server.address().port}`;
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-av1-firefox-'));
  fs.writeFileSync(path.join(profile,'user.js'),'user_pref("media.autoplay.default",0);\nuser_pref("media.hardware-video-decoding.enabled",false);');
  let firefox,driver;
  try {
    firefox=spawn(process.env.FIREFOX_BINARY || 'C:/Program Files/Mozilla Firefox/firefox.exe',['--headless','--no-remote','--profile',profile,'--remote-debugging-port','0'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    const address=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Firefox timed out')),20000);
      const inspect=chunk=>{const match=/WebDriver BiDi listening on (ws:\/\/127\.0\.0\.1:\d+)/.exec(chunk.toString());if(match){clearTimeout(timer);resolve(match[1]+'/session');}};
      firefox.stdout.on('data',inspect);firefox.stderr.on('data',inspect);firefox.on('error',reject);
    });
    driver=new WebSocket(address);await once(driver,'open');let seq=0;const waiting=new Map();
    driver.on('message',raw=>{const message=JSON.parse(raw),entry=waiting.get(message.id);if(!entry)return;waiting.delete(message.id);clearTimeout(entry.timer);message.type==='error'?entry.reject(new Error(message.message)):entry.resolve(message.result);});
    const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq,timer=setTimeout(()=>reject(new Error(method+' timed out')),25000);waiting.set(id,{resolve,reject,timer});driver.send(JSON.stringify({id,method,params}));});
    const evaluate=async(context,expression)=>{const r=await command('script.evaluate',{expression,target:{context},awaitPromise:true});if(r.type==='exception')throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    const until=async(context,expression,label)=>{await command('browsingContext.activate',{context});for(let n=0;n<150;n++){if(await evaluate(context,expression))return;await pause(100);}throw new Error(label+': '+await evaluate(context,'JSON.stringify({playbackError,pending,probing,time:video.currentTime,expected:expected(),frames:videoFrames,total:video.getVideoPlaybackQuality().totalVideoFrames,paused:video.paused,sharedPaused:state?.state.paused,ready:video.readyState})'));};
    await command('session.new',{capabilities:{alwaysMatch:{acceptInsecureCerts:true}}});
    const {context:host}=await command('browsingContext.create',{type:'tab'}),{context:guest}=await command('browsingContext.create',{type:'tab'});
    await command('browsingContext.navigate',{context:host,url:config.publicUrl+'/watch?demo=host',wait:'complete'});
    await until(host,'!!me','login');
    await evaluate(host,'preferredQuality="direct";document.getElementById("create").click()');await until(host,'!!state','room');
    await evaluate(host,'execute({action:"media.load",args:{mediaId:"123",quality:"direct"}}).then(()=>true)');
    await until(host,'videoFrames>0','original decoded');assert.equal(await evaluate(host,'state.format'),'file');
    await evaluate(host,'execute({action:"session.sharing",args:{mode:"guild"}}).then(()=>execute({action:"session.enable"})).then(()=>true)');
    await evaluate(host,'compatibleFallback("Simulated H.264 decode failure").then(()=>true)');
    await until(host,'state.format==="av1" && videoFrames>0','AV1 frames');
    console.log('PASS: original retained until simulated decode failure; AV1 WebM/Opus decodes through actual MediaSource.');
    const id=await evaluate(host,'selected');
    await command('browsingContext.navigate',{context:guest,url:config.publicUrl+'/watch?demo=guest',wait:'complete'});
    await until(guest,'!!me','guest login');await evaluate(guest,`preferredQuality="direct";selectRoom(${JSON.stringify(id)}).then(()=>true)`);
    await until(guest,'state.format==="hls" || state.format==="file"','guest stream');
    await evaluate(guest,'execute({action:"media.quality.set",args:{quality:"direct"}}).then(()=>true)');
    await evaluate(guest,'compatibleFallback("Simulated H.264 decode failure").then(()=>true)');
    await until(guest,'state.format==="av1" && videoFrames>0','guest AV1 frames');
    console.log('PASS: second viewer decodes the shared AV1 tier.');
    const firstCount=encoded;assert.ok(firstCount<=Math.ceil(source.duration/1000/6),'same tier shares the bounded ahead cache rather than encoding each viewer separately');
    await evaluate(host,'window.smokePlay=execute({action:"media.play"}).then(()=>true); true');
    // The procedural source is 12 fps. The encoder now retains that cadence;
    // requiring 180 frames here accidentally required the old 30 fps conversion.
    await until(host,'video.currentTime>7 && video.getVideoPlaybackQuality().totalVideoFrames>70','cross WebM chunk boundary');
    await until(guest,'video.currentTime>7 && Math.abs(video.currentTime-expected())<1','guest sync');
    console.log('PASS: continuous playback across WebM chunks.');
    await evaluate(host,'execute({action:"media.seek.absolute",args:{seconds:25}}).then(()=>execute({action:"media.pause"})).then(()=>true)');
    await until(guest,'video.paused && Math.abs(video.currentTime-25)<.7 && videoFrames>0','seek offset and pause');
    assert.equal(await evaluate(guest,'Math.abs(video.currentTime-expected())<.7'),true);
    console.log('PASS: shared seek offset 25 and pause.');
    await evaluate(host,'execute({action:"media.quality.set",args:{quality:"720p2"}}).then(()=>true)');
    await until(host,'state.quality==="720p2" && videoFrames>0 && video.paused && Math.abs(video.currentTime-25)<.7','personal quality');
    assert.equal(await evaluate(guest,'state.quality'),'direct');
    console.log('PASS: personal AV1 quality retains shared position/pause.');
    await evaluate(host,'execute({action:"media.seek.absolute",args:{seconds:59}}).then(()=>execute({action:"media.play"})).then(()=>true)');
    await until(host,'state.state.paused && expected()>59.8','end');
    await evaluate(host,'execute({action:"media.play"}).then(()=>true)');await until(host,'video.currentTime>.3 && video.currentTime<5 && video.getVideoPlaybackQuality().totalVideoFrames>10 && video.readyState>=3 && !video.paused','restart');
    await command('browsingContext.setViewport',{context:host,viewport:{width:1360,height:1050}});
    await evaluate(host,'execute({action:"media.pause"}).then(()=>true)');
    await pause(2800);
    const shot=await command('browsingContext.captureScreenshot',{context:host,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts/watch-av1-desktop-qa.png'),Buffer.from(shot.data,'base64'));
    await command('browsingContext.setViewport',{context:host,viewport:{width:390,height:1100}});
    assert.equal(await evaluate(host,'document.documentElement.scrollWidth<=390'),true);
    const phone=await command('browsingContext.captureScreenshot',{context:host,origin:'viewport'});fs.writeFileSync(path.join(root,'artifacts/watch-av1-mobile-qa.png'),Buffer.from(phone.data,'base64'));
    console.log('PASS: chunk continuity, shared seeking/pausing, source-time mapping, personal quality, restart, and desktop/phone layout.');
    await command('browser.close').catch(()=>{});
  } finally {driver?.close();firefox?.kill();await app.close();assert.equal(plex.av1.groups.size,0);}
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
