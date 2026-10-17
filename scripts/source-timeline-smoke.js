/* Decoded source-frame oracle, independent of video.currentTime and room counters. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {execute}=require('./build-playback-fixtures');
const {fixturePlex}=require('./playback-baseline');
const {createApp}=require('../server/app');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main(){
  const option=(name,fallback)=>process.argv.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
  const output=path.resolve(option('output','artifacts/source-timeline-'+Date.now())),browserName=option('browser','chrome');
  assert.ok(!fs.existsSync(output),'Use a new output directory');fs.mkdirSync(output,{recursive:true});
  const directory=path.join(output,'media');fs.mkdirSync(directory);fs.mkdirSync(path.join(directory,'hls'));
  const fps=24000/1001,bits=14,file=path.join(directory,'source.mp4');
  // A binary frame number is baked into pixels BEFORE either delivery path.
  const filters=Array.from({length:bits},(_,i)=>'drawbox=x='+i*32+':y=0:w=32:h=64:color=white:t=fill:enable=\'bitand(n,'+2**i+')\'').join(',');
  execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','color=c=black:s=640x360:r=24000/1001',
    '-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','600','-vf',filters,'-c:v','libx264','-preset','ultrafast','-crf','18','-g','24','-keyint_min','24','-sc_threshold','0','-bf','2',
    '-c:a','aac','-b:a','64k','-movflags','+faststart',file]);
  execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-i',file,'-c','copy','-hls_time','1','-hls_playlist_type','vod',
    '-hls_segment_filename',path.join(directory,'hls/segment-%03d.ts'),path.join(directory,'hls/start.m3u8')]);
  const probe=JSON.parse(execute('ffprobe',['-v','error','-show_streams','-of','json',file]));
  const manifest={sources:[{id:'104',file:'source.mp4',duration:600,probe}]},upstream=fixturePlex(directory,manifest),requests=[];
  const plexFetch=async(input,options)=>{
    const url=new URL(input),response=await upstream(input,options);
    if(url.pathname.includes('/renditions/'))requests.push(path.basename(url.pathname));
    if(url.pathname==='/library/metadata/104'){
      const body=await response.json();Object.assign(body.MediaContainer.Metadata[0].Media[0],{width:1920,height:1080});
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }
    if(/mpegurl/.test(response.headers.get('content-type')||'')){
      // Existing live Plex manifests advertise integer segment durations even
      // when 23.976 fps transport segments span 1.001 s. Exercise that boundary.
      const text=(await response.text()).replace(/#EXTINF:[\d.]+,/g,'#EXTINF:1,');
      return new Response(text,{headers:{'Content-Type':'application/vnd.apple.mpegurl'}});
    }
    return response;
  };
  const root=path.resolve(__dirname,'..'),config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const app=createApp(config,{plexFetch,oauthFetch:async()=>{throw new Error('Live OAuth disabled');}});
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  let host,guest;const report={browser:browserName,fps,cases:[],limitations:'Procedural frame numbers encoded into pixels before HLS packaging, integer playlist duration estimates, desktop software decoding. Does not certify live Plex conversions, Android, physical displays or speaker output.'};
  const capture=async(browser,page)=>JSON.parse(await browser.evaluate(page,`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');
    const read=metadata=>{
      ctx.drawImage(video,0,0);let frame=0;
      for(let i=0;i<14;i++)if(ctx.getImageData(i*32+16,32,1,1).data[0]>128)frame+=2**i;
      return {frame,sourceSeconds:frame/(24000/1001),position:video.currentTime,frameMediaTime:metadata?.mediaTime,
        sampleMediaTime:metadata?.mediaTime??video.currentTime,target:expected(),ready:video.readyState,seeking:video.seeking,paused:video.paused,log:diagnostics.snapshot()};
    };
    // In motion, capture pixels inside their own frame callback. The advancing
    // media clock may already lead the displayed frame by a scheduling interval.
    const value=video.paused?read():await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Decoded frame sample timed out')),3000);
      video.requestVideoFrameCallback((now,metadata)=>{clearTimeout(timer);resolve(read(metadata));});
    });
    return JSON.stringify(value);
  })()`));
  const save=async(name)=>{
    const a=await capture(host,h),b=await capture(guest,g);
    const row={name,host:a,guest:b,pictureSkewSeconds:(a.frame-b.frame)/fps,mappingSkewSeconds:(a.sourceSeconds-a.sampleMediaTime)-(b.sourceSeconds-b.sampleMediaTime)};report.cases.push(row);
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({name,host:{...a,log:undefined},guest:{...b,log:undefined},pictureSkewSeconds:row.pictureSkewSeconds,mappingSkewSeconds:row.mappingSkewSeconds}));
  };
  let h,g;
  try{
    host=await playbackBrowser(browserName);guest=await playbackBrowser(browserName);
    report.versions=[host.version,guest.version];
    h=await host.page(config.publicUrl+'/watch?demo=host');g=await guest.page(config.publicUrl+'/watch?demo=guest');
    for(const [browser,page]of[[host,h],[guest,g]])await browser.until(page,'typeof me!=="undefined"&&!!me','Login');
    await host.evaluate(h,'preferredQuality="720p4";document.getElementById("create").click();true');await host.until(h,'!!state','Room');
    const room=await host.evaluate(h,'selected');
    await host.evaluate(h,'execute({action:"media.load",args:{mediaId:"104",quality:"720p4"}}).then(()=>true)');
    await host.until(h,'!state.waitingForReady&&!video.paused&&videoFrames>5','Initial playback',30000);
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>execute({action:"media.seek.absolute",args:{seconds:480}})).then(()=>true)');
    await host.until(h,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-480)<.2','Host seek',30000);
    await guest.evaluate(g,'selectRoom('+JSON.stringify(room)+').then(()=>true)');
    await guest.until(g,'!!state&&video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-480)<.2','Paused late join',30000);
    await pause(500);await save('late-join');
    await guest.evaluate(g,'execute({action:"media.quality.set",args:{quality:"1080p8"}}).then(()=>true)');
    await guest.until(g,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-480)<.2','Paused quality switch',30000);
    await pause(500);await save('quality');
    await host.evaluate(h,'execute({action:"media.seek.absolute",args:{seconds:535}}).then(()=>true)');
    for(const [browser,page]of[[host,h],[guest,g]])await browser.until(page,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-535)<.2','Shared seek',30000);
    await pause(500);await save('seek');
    await host.evaluate(h,'execute({action:"media.play"}).then(()=>true)');
    await guest.until(g,'!video.paused&&!video.seeking&&video.readyState>=3','Resume');
    await guest.evaluate(g,'execute({action:"media.quality.set",args:{quality:"720p2"}}).then(()=>true)');
    await guest.until(g,'!video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-expected())<.2','Playing quality replacement',30000);
    await save('playing-quality');
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>true)');
    for(const [browser,page]of[[host,h],[guest,g]])await browser.until(page,'video.paused&&!video.seeking','Pause before backward seek');
    await host.evaluate(h,'execute({action:"media.seek.absolute",args:{seconds:240}}).then(()=>true)');
    for(const [browser,page]of[[host,h],[guest,g]])await browser.until(page,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-240)<.2','Outside-cache backward seek',30000);
    await pause(500);await save('backward-seek');
    await guest.evaluate(g,'execute({action:"media.stream.refresh",args:{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion}}).then(()=>true)');
    await guest.until(g,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-240)<.2','Private stream refresh',30000);
    await pause(500);await save('stream-refresh');
    await guest.evaluate(g,'hls.recoverMediaError();true');
    await guest.until(g,'video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-240)<.2','Decoder reset retains origin',30000);
    await pause(500);await save('decoder-reset');
    for(const row of report.cases){
      if(row.host.paused&&row.guest.paused)assert.ok(Math.abs(row.pictureSkewSeconds)<=2/fps,row.name+': paused decoded pictures agree within two source frames');
      assert.ok(Math.abs(row.mappingSkewSeconds)<=2/fps,row.name+': source-to-media mappings agree within two source frames');
      // MPEG-TS timestamps quantize at 90 kHz; allow one tick at the frame limit.
      for(const viewer of[row.host,row.guest])assert.ok(Math.abs(viewer.sourceSeconds-viewer.sampleMediaTime)<=3/fps+1/90000,row.name+': baked source time agrees with its media timestamp within three source frames');
    }
    app.watch.remove(room);
  }finally{await Promise.allSettled([host?.close(),guest?.close()]);await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
