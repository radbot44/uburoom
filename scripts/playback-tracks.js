/* Actual watch-player track changes against generated media; no .env/live users. */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createApp}=require('../server/app');
const {AV1,run}=require('../server/av1');
const {fixturePlex,installMeter}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');
const root=path.resolve(__dirname,'..');
async function main() {
  const args=process.argv.slice(2), option=(name,fallback)=>args.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3) || fallback;
  if(args.some(arg=>!/^--(media|out|browsers|ffmpeg|ffprobe)=.+/.test(arg)))throw new Error('Use --media=track-corpus --out=new-directory [--browsers=firefox,chrome,edge --ffmpeg=path --ffprobe=path]');
  const directory=path.resolve(option('media','artifacts/playback-media-tracks')), output=path.resolve(option('out','artifacts/playback-tracks-'+Date.now()));
  if(fs.existsSync(output))throw new Error('Use a new output directory.');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  if(manifest.kind!=='uburoom-synthetic-playback' || !manifest.trackRenditions)throw new Error('Generate the synthetic corpus with --tracks=on first.');
  const browsers=option('browsers','firefox,chrome,edge').split(',');
  if(browsers.some(name=>!['firefox','chrome','edge'].includes(name)))throw new Error('Unknown browser.');
  fs.mkdirSync(output,{recursive:true});
  const ffmpeg=option('ffmpeg','ffmpeg'), ffprobe=option('ffprobe','ffprobe');
  const control={events:[]}, report={createdAt:new Date().toISOString(),results:[],isolation:{livePlex:false,realDiscord:false,hardwareEncoding:false,physicalAudio:false},
    limitations:['Pre-generated HLS simulates Plex negotiation and burn-in.','PGS/VobSub input and actual Plex attachment fonts not exercised.','Real Plex selection/start/seek isolation and other Plex clients require controlled-account verification.','Real Discord, Safari/mobile, multichannel fidelity and long playback are separate gates.']};
  const write=()=>{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    fs.writeFileSync(path.join(output,'report.md'),'# Audio and subtitle browser checks\n\nActual watch player, generated media and simulated Plex. Software AV1 encoding only in this fixture; decoded PCM is not speaker evidence.\n\n| Browser | Case | Result | Details |\n| --- | --- | --- | --- |\n'+report.results.map(r=>`| ${r.browser} | ${r.case} | ${r.status} | ${r.error || r.detail || ''} |`).join('\n')+'\n\n## Still to verify\n\n'+report.limitations.map(s=>'- '+s).join('\n')+'\n');
  };
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),publicUrl:'https://localhost',
    demo:true,ownerId:'demo-host',guildId:'synthetic-guild',channels:['synthetic-commands'],plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  let app, originalAV1;
  async function openApp() {
  app=createApp(config,{plexFetch:fixturePlex(directory,manifest,control),oauthFetch:async()=>{throw new Error('Live OAuth disabled.');}}); originalAV1=app.watch.plex.av1;
  app.watch.plex.av1=new AV1(app.watch.plex,{ffmpegPath:ffmpeg,ffprobePath:ffprobe},async(binary,parameters,signal)=>{
    let actual=[...parameters];
    if(actual.includes('av1_qsv')){
      actual=actual.map(v=>v==='av1_qsv'?'libsvtav1':v==='veryfast'?'12':v==='nv12'?'yuv420p':v.replaceAll('format=nv12','format=yuv420p'));
      for(const flag of ['-maxrate','-bufsize']){const index=actual.indexOf(flag);if(index!==-1)actual.splice(index,2);}
      actual.splice(actual.indexOf('-c:v'),0,'-svtav1-params','lp=2:pred-struct=1:rc=2');
    }
    return run(binary,actual,signal,30000,48*1024*1024);
  });
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl='https://localhost:'+app.server.address().port;
  }
  const masks=new Map();
  function mask(rendition,at,top) {
    const key=rendition+':'+at; if(masks.has(key))return masks.get(key);
    const frame=name=>{
      const result=spawnSync(ffmpeg,['-v','error','-i',path.join(directory,name,'start.m3u8'),'-ss',String(at),'-frames:v','1','-pix_fmt','rgb24','-f','rawvideo','pipe:1'],{windowsHide:true,maxBuffer:2*1024*1024});
      if(result.status!==0 || result.stdout.length!==640*360*3)throw new Error('Cannot probe generated subtitle reference frame.');
      return result.stdout;
    };
    const burned=frame(rendition), plain=frame('hls-french'), pixels=[];
    for(let y=top?8:270;y<(top?90:356);y++)for(let x=80;x<560;x++){
      const i=(y*640+x)*3, color=[burned[i],burned[i+1],burned[i+2]], delta=color.reduce((sum,v,c)=>sum+Math.abs(v-plain[i+c]),0);
      if(delta>200 && (top ? color[0]>190 && color[1]>190 && color[2]<100 : color.every(v=>v>215)))pixels.push({x,y,color});
    }
    assert.ok(pixels.length>60,'reference contains recognizable subtitle glyphs');
    const sample=pixels.filter((_,i)=>i%Math.max(1,Math.floor(pixels.length/400))===0).slice(0,500);masks.set(key,sample);return sample;
  }
  try {
    for(const name of browsers){let browser;
      try {
        // Each browser gets independent saved Plex choices, sessions and rate
        // budgets. Keep the production throttles intact in these real routes.
        await openApp();
        browser=await playbackBrowser(name);const host=await browser.page(config.publicUrl+'/watch?demo=host');
        const evaluate=(page,code)=>browser.evaluate(page,code), until=(page,code,label,timeout)=>browser.until(page,code,label,timeout);
        await until(host,'!!me','Login'); await evaluate(host,'preferredQuality="direct";document.getElementById("create").click();true');await until(host,'!!state','Room');
        await evaluate(host,'('+installMeter.toString()+')()');await evaluate(host,'playbackMeter.resumeAudio()');
        const command=async(page,action,args)=>{
          await until(page,'!!state && !pending','Available controls');
          return evaluate(page,`execute({action:${JSON.stringify(action)},args:${JSON.stringify(args || {})}}).then(()=>true)`);
        };
        const choose=async(page,settings)=>{
          await until(page,'!!state && !pending','Available track controls');
          return evaluate(page,`execute({action:"media.tracks.set",args:{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,...${JSON.stringify(settings)}}}).then(()=>true)`);
        };
        const position=async(seconds)=>{await command(host,'media.pause');await command(host,'media.seek.absolute',{seconds});await until(host,`video.paused && !video.seeking && video.readyState>=2 && Math.abs(video.currentTime-${seconds})<.1`,'Paused source time',20000);};
        const tone=async(page,hz)=>{
          await command(host,'media.play');
          await until(page,'!video.paused && !video.seeking && video.readyState>=3','Audio playback has started',15000);
          let matches=0;
          for(let i=0;i<12;i++){await pause(100);if(await evaluate(page,`(()=>{const s=playbackMeter.sample();return s && s.audioDb>-65 && Math.abs(s.audioHz-${hz})<20;})()`))matches++;}
          await command(host,'media.pause');assert.ok(matches>=5,'expected '+hz+' Hz decoded audio');return matches;
        };
        const check=async(id,action)=>{
          const result={browser:name,version:browser.version,case:id,status:'failed'};
          try{const evidence=await action();Object.assign(result,evidence);result.status='passed';}
          catch(error){result.error=error.message;result.state=JSON.parse(await evaluate(host,'JSON.stringify({playbackError,tracks:state?.tracks,format:state?.format,time:video.currentTime,captionError:trackNotice})').catch(()=>'null'));}
          report.results.push(result);write();console.log('[Tracks]',name,id,result.status,result.error || '');
          if(result.status!=='passed')throw new Error(id+': '+result.error);
        };
        await command(host,'media.load',{mediaId:'101',quality:'direct'});await until(host,'video.readyState>=3 && decodedFrames()>0','Direct playback');await position(2);
        await evaluate(host,'playbackMeter.reset("101",null);true');
        await check('native-WebVTT',async()=>{
          const stream=await evaluate(host,'state.streamVersion');
          await evaluate(host,'document.getElementById("tracks-open").click();document.getElementById("subtitle-track").value="10190";document.getElementById("subtitle-track").dispatchEvent(new Event("change",{bubbles:true}));true');
          await until(host,'state.tracks.subtitleId==="10190" && captions.loaded && captions.track.activeCues?.[0]?.text.includes("first caption")','Visible WebVTT cue');
          assert.equal(await evaluate(host,'state.streamVersion'),stream,'text selection keeps the current video');
          await evaluate(host,'document.getElementById("tracks-close").click();true');
          await browser.viewport(host,1360,1050);await pause(2800);await browser.screenshot(host,path.join(output,name+'-native-vtt.png'));
          return {detail:'Native cue active at its source time; video stream unchanged.'};
        });
        await check('SRT-Unicode-and-offset',async()=>{
          await choose(host,{subtitleId:'10191'});await position(7.5);await until(host,'captions.loaded && captions.track.activeCues?.[0]?.text.includes("Deuxième")','French SRT cue');
          await choose(host,{subtitleOffset:1});await until(host,'captions.track.activeCues?.length===0','Positive delay');await position(8.5);
          await until(host,'captions.track.activeCues?.[0]?.text.includes("Deuxième")','Shifted cue');
          await choose(host,{subtitleId:'off'});assert.equal(await evaluate(host,'captions.track.mode'),'disabled');
          return {detail:'French Unicode cue, +1 second delay and explicit Off confirmed.'};
        });
        await command(host,'media.load',{mediaId:'104',quality:'direct'});await until(host,'video.readyState>=3 && decodedFrames()>0','Multi-track playback');await position(2);
        const roomId=await evaluate(host,'selected'),guest=await browser.page(config.publicUrl+'/watch?demo=guest');
        await until(guest,'!!me','Guest login');await evaluate(guest,`preferredQuality="direct";selectRoom(${JSON.stringify(roomId)}).then(()=>true)`);
        await until(guest,'video.readyState>=2','Guest media');await choose(guest,{subtitleId:'off'});
        await until(guest,'!state.tracks.subtitleId && video.readyState>=2','Guest subtitles off');
        await evaluate(guest,'('+installMeter.toString()+')()');await evaluate(guest,'playbackMeter.resumeAudio()');
        await evaluate(host,'playbackMeter.reset("104",null);true');await evaluate(guest,'playbackMeter.reset("104",null);true');
        await check('personal-audio-language',async()=>{
          await choose(host,{audioId:'1042'});await until(host,'video.readyState>=2 && Math.abs(video.currentTime-2)<.1 && video.paused','Audio replacement keeps paused position');
          const french=await tone(host,880);await position(2);const english=await tone(guest,440);
          assert.equal(await evaluate(guest,'state.tracks.audioId'),'1041');assert.equal(await evaluate(host,'state.enabled'),false);
          return {detail:'French 880 Hz / guest English 440 Hz, independent with remote consent off.',frenchSamples:french,englishSamples:english};
        });
        await check('ASS-style-and-sign-position',async()=>{
          await position(2);await choose(host,{subtitleId:'1044'});
          await until(host,'state.tracks.subtitleId==="1044" && video.readyState>=2 && !video.seeking && Math.abs(video.currentTime-2)<.1','ASS burn at paused position');
          const evidence=[];
          for(const [at,top] of [[2,false],[8.5,true]]){
            await position(at);const pixels=mask('hls-ass-french',at,top);
            const actual=JSON.parse(await evaluate(host,`(()=>{const c=document.createElement("canvas");c.width=640;c.height=360;const x=c.getContext("2d");x.drawImage(video,0,0);const p=x.getImageData(0,0,640,360).data;return JSON.stringify(${JSON.stringify(pixels.map(p=>[p.x,p.y]))}.map(([a,b])=>Array.from(p.slice((b*640+a)*4,(b*640+a)*4+3))));})()`));
            const matched=actual.filter((color,i)=>color.reduce((sum,v,c)=>sum+Math.abs(v-pixels[i].color[c]),0)<130).length/pixels.length;
            assert.ok(matched>.65,'burned ASS glyphs match the generated '+(top?'top sign':'bottom caption'));evidence.push({at,matched,pixels:pixels.length});
            await browser.screenshot(host,path.join(output,name+'-ass-'+(top?'sign':'caption')+'.png'));
          }
          assert.equal(await evaluate(host,'captions.track.mode'),'disabled','burned captions have no duplicate native text');
          assert.equal(await evaluate(guest,'!state.tracks.subtitleId'),true,'guest subtitles stay off');
          await evaluate(host,'document.getElementById("tracks-open").click();true');
          assert.equal(await evaluate(host,'document.getElementById("subtitle-offset").disabled'),true);
          assert.equal(await evaluate(host,'document.getElementById("subtitle-delay-hint").textContent.includes("fixed by Plex")'),true);
          await browser.screenshot(host,path.join(output,name+'-ass-dialog.png'));
          await evaluate(host,'document.getElementById("tracks-close").click();true');
          await choose(host,{subtitleId:'off'});await until(host,'video.readyState>=2 && !video.seeking','Burn off');
          return {detail:'Bottom styled caption and positioned colored sign matched actual decoded pixels; Off replaces burned video.',evidence};
        });
        await check('AV1-selected-audio-and-text',async()=>{
          await position(2);await command(host,'media.quality.set',{quality:'direct',compatible:true,fallback:'av1'});
          await until(host,'state.format==="av1" && video.readyState>=2','French AV1',30000);
          await choose(host,{subtitleId:'10490'});await until(host,'captions.loaded && captions.track.activeCues?.[0]?.text.includes("first caption")','AV1 native captions');
          const french=await tone(host,880);await position(2);
          await command(guest,'media.quality.set',{quality:'direct',compatible:true,fallback:'av1'});await until(guest,'state.format==="av1" && video.readyState>=2','English AV1',30000);
          const english=await tone(guest,440);assert.equal(await evaluate(host,'state.tracks.audioId'),'1042');
          await command(host,'media.pause');await evaluate(host,'setTheater(true);true');await browser.screenshot(host,path.join(output,name+'-theater.png'));
          await evaluate(host,'document.getElementById("tracks-open").click();true');await browser.viewport(host,390,1000);
          await until(host,'captions.defaultLine===-7','Phone caption clearance');await pause(250);
          await browser.screenshot(host,path.join(output,name+'-phone-tracks.png'));
          assert.equal(await evaluate(host,'document.documentElement.scrollWidth<=innerWidth'),true);
          await evaluate(host,'document.getElementById("tracks-close").click();true');await browser.screenshot(host,path.join(output,name+'-phone-captions.png'));
          await evaluate(host,'setTheater(false);true');
          return {detail:'Separate AV1 audio cache entries preserve French/English; text captions remain active.',frenchSamples:french,englishSamples:english};
        });
      }catch(error){console.error('[Tracks]',name,error.message);if(!report.results.some(r=>r.browser===name && r.status==='failed'))report.results.push({browser:name,case:'setup',status:'failed',error:error.message});write();}
      finally{await browser?.close();await app?.close();await originalAV1?.close();app=undefined;}
    }
  }finally{await app?.close();report.providerEvents=control.events;write();}
  const failures=report.results.filter(r=>r.status!=='passed').length;console.log('[Tracks]',report.results.length-failures,'passed,',failures,'failed. Report:',path.join(output,'report.md'));if(failures)process.exitCode=1;
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
