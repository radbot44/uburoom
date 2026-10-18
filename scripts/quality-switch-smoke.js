/* Isolated quality replacement with delayed synthetic HLS; no live providers or .env. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main() {
  const option=(key,fallback)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
  const root=path.resolve(__dirname,'..'),directory=path.resolve(option('media','artifacts/playback-media-recovery-120')),
    output=path.resolve(option('output','artifacts/quality-switch-'+Date.now())),name=option('browser','chrome'),delay=Number(option('delay','1200'));
  assert.ok(delay>=0&&delay<=3000);assert.ok(!fs.existsSync(output),'Use a new output directory');fs.mkdirSync(output,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),control={requests:[]},upstream=fixturePlex(directory,manifest,control),requests=[];
  assert.ok(manifest.sources.find(s=>s.id==='104')?.duration>=115,'Use a synthetic corpus at least 120 seconds long');
  const fetch=async(input,options)=>{
    const url=new URL(input);
    if(url.pathname.endsWith('/decision')&&control.preparationDelay)await pause(control.preparationDelay);
    if(url.pathname.endsWith('/decision')&&control.rejectPreparation)return new Response('{}',{status:503});
    if(url.pathname.includes('/renditions/')) {
      requests.push({at:Date.now(),segment:path.basename(url.pathname)});await pause(delay);
    }
    const response=await upstream(input,options);
    if(url.pathname==='/library/metadata/104') {
      const body=await response.json();Object.assign(body.MediaContainer.Metadata[0].Media[0],{width:1920,height:1080});
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }
    return response;
  };
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,
    plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const app=createApp(config,{plexFetch:fetch,oauthFetch:async()=>{throw new Error('Live OAuth disabled');}});
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'fixture-call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  let host,guest;const report={browser:name,delayMs:delay,cases:[],limitations:'Synthetic pre-generated HLS, shared rendition bytes across quality labels, delayed fragments on localhost, software desktop decoding. Does not certify live Plex conversion throughput, Android or physical audio/motion.'};
  const capture=async(browser,page)=>JSON.parse(await browser.evaluate(page,'JSON.stringify((()=>{diagnosticSample();return {log:diagnostics.snapshot(),position:video.currentTime,target:expected(),frames:videoFrames,paused:video.paused,ready:video.readyState,roomPaused:state.state.paused,quality:state.quality,media:state.mediaVersion,stream:state.streamVersion,enabled:state.enabled};})())'));
  try {
    host=await playbackBrowser(name);guest=await playbackBrowser(name);report.versions=[host.version,guest.version];
    const h=await host.page(config.publicUrl+'/watch?demo=host'),g=await guest.page(config.publicUrl+'/watch?demo=guest');
    for(const [browser,page]of[[host,h],[guest,g]])await browser.until(page,'typeof me!=="undefined"&&!!me','Login');
    await host.evaluate(h,'preferredQuality="720p4";document.getElementById("create").click();document.getElementById("room-create").click();true');await host.until(h,'!!state','Room');
    const room=await host.evaluate(h,'selected');await guest.evaluate(g,'selectRoom('+JSON.stringify(room)+').then(()=>true)');await guest.until(g,'!!state','Guest');
    await host.evaluate(h,'execute({action:"media.load",args:{mediaId:"104",quality:"720p4"}}).then(()=>true)');
    await Promise.all([[host,h],[guest,g]].map(([browser,page])=>browser.until(page,'!state.waitingForReady&&!video.paused&&videoFrames>5','Initial playback',30000)));
    // Exercise the actual dropdown, a slow private conversion, ongoing polls,
    // and an ordinary pause while its preparation request is still in flight.
    control.preparationDelay=13000;
    await host.evaluate(h,'document.getElementById("quality").value="1080p8";document.getElementById("quality").dispatchEvent(new Event("change"));true');
    await host.until(h,'qualityPending','Slow quality request');
    await pause(500);
    assert.equal(await host.evaluate(h,'!pending&&!document.getElementById("player-play").disabled&&document.getElementById("quality").disabled'),true);
    for(const [layout,width,height]of[['normal',1280,900],['phone',390,844],['theater',1280,900]]) {
      await host.viewport(h,width,height);
      await host.evaluate(h,'setTheater('+JSON.stringify(layout==='theater')+');document.getElementById("tracks-open").click();if(!document.getElementById("tracks-dialog").open)document.getElementById("settings-more").click();document.getElementById("quality").scrollIntoView({block:"center"});true');
      await pause(250);
      await host.screenshot(h,path.join(output,'preparing-quality-'+layout+'.png'));
      await host.evaluate(h,'document.getElementById("tracks-dialog").close();true');
    }
    await host.evaluate(h,'setTheater(false);true');
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>true)');
    await pause(10500);
    assert.equal(await host.evaluate(h,'qualityPending&&state.state.paused&&performance.now()-receivedAt<2500'),true,'polling and pause survive the former request/viewer timeouts');
    await host.until(h,'!qualityPending&&state.quality==="1080p8"&&document.getElementById("quality").value==="1080p8"','Slow quality applied',20000);
    assert.equal(await host.evaluate(h,'state.state.paused'),true,'quality completion preserves pause');
    control.preparationDelay=0;control.rejectPreparation=true;
    await host.evaluate(h,'document.getElementById("quality").value="720p2";document.getElementById("quality").dispatchEvent(new Event("change"));true');
    await host.until(h,'!qualityPending&&document.getElementById("quality").value==="1080p8"','Rejected quality restores applied dropdown');
    control.rejectPreparation=false;
    report.slowPreparation={delayMs:13000,pauseAvailable:true,pollingContinued:true,qualityApplied:true,failureRestoresDropdown:true};
    if(option('preparation-only','false')==='true') {
      fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify(report.slowPreparation));app.watch.remove(room);return;
    }
    await host.evaluate(h,'execute({action:"media.play"}).then(()=>true)');
    await host.evaluate(h,'execute({action:"media.seek.absolute",args:{seconds:35}}).then(()=>true)');
    await Promise.all([[host,h],[guest,g]].map(([browser,page])=>browser.until(page,'!video.seeking&&video.readyState>=3&&video.currentTime>35&&Math.abs(video.currentTime-expected())<.5&&uburoomPlayback.bufferedAhead(video.buffered,video.currentTime)>2','Stable mid-video position',30000)));
    for(const quality of['1080p12','720p2','1080p20']) {
      const before=await capture(host,h),other=await capture(guest,g),started=Date.now(),requestIndex=requests.length;
      await host.evaluate(h,'execute({action:"media.quality.set",args:{quality:'+JSON.stringify(quality)+'}}).then(()=>true)');
      const samples=[];for(let i=0;i<60;i++){samples.push(await capture(host,h));await pause(200);}
      const after=samples.at(-1),otherAfter=await capture(guest,g),entries=after.log.entries.filter(e=>e.ms>before.log.entries.at(-1).ms&&e.stream===after.log.entries.at(-1).stream);
      const resumed=entries.find(e=>e.event==='frame'&&!e.paused&&!e.waiting&&!e.seeking)?.ms??Infinity;
      const result={quality,elapsedMs:Date.now()-started,before:{position:before.position,target:before.target},after:{position:after.position,target:after.target,ready:after.ready,paused:after.paused},
        firstPlayingFrameMs:Number.isFinite(resumed)?resumed-(entries[0]?.ms??resumed):null,
        lastSecondFrames:after.frames-samples.at(-6).frames,
        anchorSeeks:entries.filter(e=>e.event==='hls-anchor').length,syncSeeks:entries.filter(e=>e.event==='sync-seek').length,lateSyncSeeks:entries.filter(e=>e.event==='sync-seek'&&e.ms>resumed+500).length,
        waits:entries.filter(e=>e.event==='waiting').length,errors:entries.filter(e=>e.event==='hls-error'),requests:requests.slice(requestIndex).map(r=>({ms:r.at-started,segment:r.segment})),
        guestAdvanced:otherAfter.position-other.position,guestStreamUnchanged:otherAfter.stream===other.stream,mediaUnchanged:after.media===before.media,
        streamChanged:after.stream!==before.stream,roomPlaying:!after.roomPaused,consentOff:!after.enabled};
      fs.writeFileSync(path.join(output,quality+'-host.json'),JSON.stringify({before,after,samples:samples.map(s=>({position:s.position,target:s.target,frames:s.frames,ready:s.ready,paused:s.paused}))}));
      fs.writeFileSync(path.join(output,quality+'-guest.json'),JSON.stringify({before:other,after:otherAfter}));
      report.cases.push(result);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(result));
      assert.ok(result.guestAdvanced>9&&result.guestStreamUnchanged&&result.mediaUnchanged&&result.streamChanged&&result.roomPlaying&&result.consentOff,'Replacement stays local');
      assert.ok(!after.paused&&after.ready>=3&&Math.abs(after.position-after.target)<.65,'Replacement catches up');
      assert.ok(result.lastSecondFrames>3,'Decoded callbacks keep advancing after refill');
      assert.equal(result.lateSyncSeeks,0,'No recurring correction seeks after replacement settles');
      assert.ok(result.syncSeeks<=1,'At most one initial alignment');assert.equal(result.errors.length,0,'No HLS stalls/errors after quality replacement');
      assert.equal(result.anchorSeeks,1,'One target jump after establishing the stream origin');
      assert.equal(result.requests.filter(r=>r.segment==='segment-000.ts').length,1,'Each replacement anchors its timestamp origin exactly once');
    }
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>execute({action:"media.seek.absolute",args:{seconds:45}})).then(()=>true)');
    await host.until(h,'video.paused&&!video.seeking&&Math.abs(video.currentTime-45)<.5','Paused seek');
    await host.evaluate(h,'execute({action:"media.quality.set",args:{quality:"1080p12"}}).then(()=>true)');
    await host.until(h,'video.paused&&video.readyState>=3&&!video.seeking&&Math.abs(video.currentTime-45)<.5','Paused quality replacement',30000);
    await pause(1500);assert.equal(await host.evaluate(h,'video.paused&&state.state.paused'),true);
    report.lifecycle={pausedReplacement:true};
    await host.evaluate(h,'execute({action:"media.play"}).then(()=>true)');
    await host.until(h,'!video.paused&&video.readyState>=3&&Math.abs(video.currentTime-expected())<.5','Resume replaced stream',30000);
    await host.evaluate(h,'execute({action:"media.quality.set",args:{quality:"720p2"}}).then(()=>execute({action:"media.seek.absolute",args:{seconds:80}})).then(()=>true)');
    await host.until(h,'!video.paused&&!video.seeking&&video.currentTime>81&&Math.abs(video.currentTime-expected())<.5','Shared seek supersedes replacement preparation',30000);
    report.lifecycle.sharedSeekDuringPreparation=true;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({lifecycle:report.lifecycle}));
    app.watch.remove(room);
  }finally{await Promise.allSettled([host?.close(),guest?.close()]);await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
