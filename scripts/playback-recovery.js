/* Bounded long playback and Plex session-expiry fixture; no live credentials. */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex,installMeter}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');

async function main(){
  const args=process.argv.slice(2),option=(name,fallback)=>args.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
  if(args.some(arg=>!/^--(media|out|browser|soak)=.+/.test(arg)))throw new Error('Use --media=corpus --out=new-directory [--browser=firefox|chrome|edge --soak=5..180]');
  const root=path.resolve(__dirname,'..'),directory=path.resolve(option('media','artifacts/playback-media-recovery-120'));
  const output=path.resolve(option('out','artifacts/playback-recovery-'+Date.now()));
  const name=option('browser','firefox');
  const soak=Number(option('soak','45'));
  if(!Number.isInteger(soak)||soak<5||soak>180)throw new Error('Choose a five to 180 second soak.');
  if(!['firefox','chrome','edge'].includes(name)||fs.existsSync(output))throw new Error('Choose a browser and a new output directory.');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const sourceDuration=manifest.sources.find(s=>s.id==='104')?.duration;
  if(manifest.kind!=='uburoom-synthetic-playback'||!manifest.trackRenditions||sourceDuration<Math.max(110,soak+35))
    throw new Error('Generate a track corpus at least 35 seconds longer than the soak.');
  fs.mkdirSync(output,{recursive:true});
  const control={events:[],requests:[],expiredSessions:new Set(),blocked:false};
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'synthetic-guild',channels:['synthetic-commands'],
    plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const app=createApp(config,{plexFetch:fixturePlex(directory,manifest,control),oauthFetch:async()=>{throw new Error('Live OAuth disabled.');}});
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  const report={createdAt:new Date().toISOString(),browser:name,scope:'Isolated Plex simulation, actual browser video/PCM, no Discord or physical speakers',checks:[],status:'failed'};
  let browser,host,guest;
  const write=()=>{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    fs.writeFileSync(path.join(output,'report.md'),'# Long playback and session recovery\n\n'+report.scope+'\n\n'+
      '| Check | Result | Detail |\n| --- | --- | --- |\n'+report.checks.map(c=>`| ${c.name} | ${c.status} | ${c.detail||c.error||''} |`).join('\n')+
      '\n\nOverall: '+report.status+'\n');
  };
  try{
    browser=await playbackBrowser(name);report.version=browser.version;
    host=await browser.page(config.publicUrl+'/watch?demo=host&playbackProbe=1');
    const evaluate=(page,code)=>browser.evaluate(page,code),until=(page,code,label,timeout)=>browser.until(page,code,label,timeout);
    await until(host,'!!me','Host login');
    await evaluate(host,'preferredQuality="direct";document.getElementById("create").click();true');await until(host,'!!state','Room creation');
    await evaluate(host,'('+installMeter.toString()+')()');await evaluate(host,'playbackMeter.resumeAudio()');
    const command=async(page,action,args)=>{await until(page,'!!state && !pending','Available command');return evaluate(page,`execute({action:${JSON.stringify(action)},args:${JSON.stringify(args||{})}}).then(()=>true)`);};
    const choose=async(page,settings)=>{await until(page,'!!state && !pending','Available tracks');return evaluate(page,`execute({action:"media.tracks.set",args:{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,...${JSON.stringify(settings)}}}).then(()=>true)`);};
    const sample=page=>evaluate(page,'playbackMeter.sample();true');
    const snapshot=page=>evaluate(page,'JSON.stringify({position:video.currentTime,frames:video.getVideoPlaybackQuality().totalVideoFrames,error:playbackError,ready:video.readyState,buffered:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime),stream:state?.streamVersion,observationEpoch:state?.observationEpoch,mediaUrl:state?.mediaUrl,tracks:state?.tracks,paused:video.paused,remote:state?.enabled,hlsRetries:hlsNetworkRetries,hlsFailure:hlsNetworkFailure,hlsRefreshes:hlsRefreshTimes.length})').then(JSON.parse);
    const check=async(name,action)=>{const row={name,status:'failed'};report.checks.push(row);try{Object.assign(row,await action());row.status='passed';}catch(error){row.error=error.message;row.state=await snapshot(host).catch(()=>null);throw error;}finally{write();console.log('[Recovery]',name,row.status,row.error||'');}};
    await command(host,'media.load',{mediaId:'104',quality:'direct'});
    await until(host,'state.format==="hls" && video.readyState>=2','Host HLS');
    const roomId=await evaluate(host,'selected');guest=await browser.page(config.publicUrl+'/watch?demo=guest');
    await until(guest,'!!me','Guest login');await evaluate(guest,`preferredQuality="direct";selectRoom(${JSON.stringify(roomId)}).then(()=>true)`);
    await until(guest,'state.format==="hls" && video.readyState>=2','Guest HLS');
    // Frame assertions below measure the visible host. Creating the guest tab
    // otherwise leaves Chromium free to suspend hidden-tab video decoding.
    await browser.activate(host);await until(host,'document.visibilityState==="visible"','Visible host for decoded-frame checks');
    await choose(host,{audioId:'1042',subtitleId:'1044'});await choose(guest,{subtitleId:'off'});
    await until(host,'state.tracks.audioId==="1042" && state.tracks.subtitleId==="1044" && video.readyState>=2','Personal host tracks');
    await evaluate(host,'playbackMeter.reset("104","hls");true');
    await check('paused fill and cached rewind',async()=>{
      await command(host,'media.pause');
      await command(host,'media.seek.absolute',{seconds:10});
      await until(host,'video.paused && !video.seeking && Math.abs(video.currentTime-10)<.7','Paused source position');
      await pause(15000);
      const filled=await snapshot(host);
      assert.ok(filled.buffered>=10,'HLS fills while paused');
      await command(host,'media.seek.absolute',{seconds:7.5});
      await until(host,'video.paused && !video.seeking && Math.abs(video.currentTime-7.5)<.7','Cached rewind');
      const rewound=await snapshot(host);assert.equal(rewound.error,'');
      await browser.screenshot(host,path.join(output,'paused-burn.png'));
      return {detail:'15 s pause; '+filled.buffered.toFixed(1)+' s ahead; cached rewind and ASS choice retained.',filled,rewound};
    });
    await check('sustained playback with media interruption',async()=>{
      const initial=await snapshot(host),memoryStart=process.memoryUsage();
      await command(host,'media.play');await until(host,'!video.paused && video.readyState>=3','Playback start');
      const started=Date.now(),startElapsed=await evaluate(host,'playbackMeter.sample().elapsedMs');let blocked=false,unblocked=false;
      try{
        while(Date.now()-started<soak*1000){
          const elapsed=Date.now()-started;
          if(soak>=40&&elapsed>16000&&!blocked){control.blocked=true;blocked=true;}
          if(soak>=40&&elapsed>24000&&!unblocked){control.blocked=false;unblocked=true;}
          await sample(host);await pause(250);
        }
      }finally{control.blocked=false;}
      const data=JSON.parse(await evaluate(host,'JSON.stringify(playbackMeter.report())'));
      const final=await snapshot(host),memoryEnd=process.memoryUsage();
      assert.ok(final.position-initial.position>soak-6,'shared playback advances for the sustained window');
      assert.ok(final.frames-initial.frames>soak*17,'actual decoded frames advance');
      assert.ok(data.samples.filter(s=>s.audioDb>-65&&Math.abs(s.audioHz-880)<20).length>soak*2,'French decoded PCM remains audible in the pipeline');
      const outageStalls=data.events.filter(e=>['waiting','stalled'].includes(e.event)&&e.elapsedMs>startElapsed+16000&&e.elapsedMs<startElapsed+25000).length;
      if(soak>=40)assert.equal(outageStalls,0,'buffer covers the eight-second outage');
      assert.equal(final.error,'');
      await command(host,'media.pause');
      return {detail:soak+' s playback'+(soak>=40?', 8 s delivery outage':'')+', decoded frames/880 Hz PCM.',initial,final,
        memory:{heapStart:memoryStart.heapUsed,heapEnd:memoryEnd.heapUsed,rssStart:memoryStart.rss,rssEnd:memoryEnd.rss},
        samples:data.samples.length,outageStalls:soak>=40?outageStalls:null};
    });
    await check('expired Plex session recovery',async()=>{
      const before=await snapshot(host),guestBefore=await snapshot(guest);
      const destination=Math.min(sourceDuration-25,Math.max(95,soak+30));
      const oldSession=control.events.filter(e=>e.event==='start'&&e.audioId==='1042'&&e.subtitleId==='1044').at(-1)?.session;
      assert.ok(oldSession,'selected audio and subtitle session exists');control.expiredSessions.add(oldSession);
      const started=Date.now();await command(host,'media.seek.absolute',{seconds:destination});
      await until(host,`state.streamVersion!==${JSON.stringify(before.stream)} && video.readyState>=2 && !video.seeking && Math.abs(video.currentTime-${destination})<1`,'Fresh HLS stream after expiry',30000);
      const recovered=await snapshot(host),guestAfter=await snapshot(guest);
      assert.equal(recovered.tracks.audioId,'1042');assert.equal(recovered.tracks.subtitleId,'1044');
      assert.equal(recovered.remote,false,'recovery cannot enable remote consent');
      assert.equal(guestAfter.stream,guestBefore.stream,'other viewer keeps their stream');
      assert.equal(guestAfter.tracks.audioId,'1041');assert.equal(guestAfter.tracks.subtitleChoice,'off');
      const fresh=control.events.filter(e=>e.event==='start'&&e.session!==oldSession&&e.audioId==='1042'&&e.subtitleId==='1044').at(-1);
      assert.ok(fresh,'Plex captures the same selected source tracks in a new session');
      const oldStatus=await evaluate(host,`fetch(${JSON.stringify(before.mediaUrl)},{headers:token?{Authorization:'Bearer '+token}:{}}).then(r=>r.status)`);
      assert.equal(oldStatus,403,'old media grant is revoked');
      await command(host,'media.play');await until(host,`!video.paused && video.currentTime>${destination+1}`,'Playback resumes after session refresh',15000);
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(tones>=5,'selected French audio still decodes after recovery');
      await command(host,'media.pause');
      await browser.screenshot(host,path.join(output,'recovered-player.png'));
      const trace=JSON.parse(await evaluate(host,'JSON.stringify(diagnostics.snapshot())'));
      const expiry=trace.entries.findIndex(row=>row.event==='hls-error'&&row.status===410);
      assert.ok(expiry>=0,'diagnostics identify expired media delivery');
      assert.ok(trace.entries.slice(expiry).some(row=>row.event==='stream-refresh'),'expiry requests a new stream');
      assert.ok(trace.entries.slice(expiry).some(row=>row.event==='state-change'&&row.streamChanged),'replacement has a new stream generation');
      fs.writeFileSync(path.join(output,'expiry-diagnostics.json'),JSON.stringify(trace,null,2)+'\n');
      return {detail:'New HLS session in '+(Date.now()-started)+' ms; 880 Hz PCM and selected burn confirmed; guest unchanged.',
        oldSession,freshSession:fresh.session,recovered,guestBefore,guestAfter,oldStatus,tones};
    });
    await check('control reconnect keeps captured tracks',async()=>{
      const before=await snapshot(host);
      const traceStart=await evaluate(host,'diagnostics.snapshot().entries.at(-1).sequence');
      await evaluate(host,'(()=>{const original=window.fetch.bind(window);let fail=true;window.fetch=(input,options)=>{if(fail&&String(input).startsWith("/api/watch/rooms/"+selected+"?viewer=")){fail=false;window.__controlFailed=true;return Promise.reject(new TypeError("Fixture control interruption"));}return original(input,options);};return true;})()');
      await until(host,'window.__controlFailed && state===undefined && mediaSource===undefined','Control loss unloads player',6000);
      await until(host,`state?.streamVersion===${JSON.stringify(before.stream)} && video.readyState>=2 && !video.seeking`,'Fresh state after control reconnect',15000);
      const after=await snapshot(host);
      assert.equal(after.mediaUrl,before.mediaUrl,'same captured master reloads');
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
      assert.equal(after.remote,false);
      await command(host,'media.play');await until(host,'!video.paused && video.readyState>=3','Playback after control reconnect');
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(tones>=5,'captured French stream still decodes after reload');
      await command(host,'media.pause');
      const trace=JSON.parse(await evaluate(host,'JSON.stringify(diagnostics.snapshot())'));
      const entries=trace.entries.filter(row=>row.sequence>traceStart),failure=entries.findIndex(row=>row.event==='request-failed'&&row.request==='room-poll'&&row.failure==='network');
      assert.ok(failure>=0,'diagnostics identify failed control fetch');
      assert.ok(entries.slice(failure+1).some(row=>row.event==='player-clear'&&row.reason==='room-poll'),'failed poll precedes reasoned teardown');
      assert.ok(!entries.some(row=>row.event==='state-change'&&row.streamChanged),'control reconnect keeps the same stream generation');
      assert.ok(entries.some(row=>row.event==='playing'),'diagnostics observe playback resuming after reload');
      assert.ok(entries.some(row=>(row.event==='sample'||row.event==='pause')&&row.decoded>0),'diagnostics observe decoded frames after reload');
      assert.ok(!JSON.stringify(trace).includes(before.mediaUrl),'diagnostics never retain the media grant');
      fs.writeFileSync(path.join(output,'control-diagnostics.json'),JSON.stringify(trace,null,2)+'\n');
      return {detail:'Control poll failed once; player unloaded and reattached with selected French/ASS stream.',before,after,tones};
    });
    await check('six-second control outage keeps personal tracks',async()=>{
      const before=await snapshot(host),guestBefore=await snapshot(guest);
      await evaluate(host,'(()=>{const original=window.fetch.bind(window),recoverAt=Date.now()+6000;window.fetch=(input,options)=>String(input).startsWith("/api/watch/rooms/"+selected+"?viewer=")&&Date.now()<recoverAt?Promise.reject(new TypeError("Fixture control outage")):original(input,options);return true;})()');
      await until(host,'state===undefined && mediaSource===undefined','Control outage unloads player',6000);
      await until(host,`state?.streamVersion===${JSON.stringify(before.stream)} && video.readyState>=2 && !video.seeking`,'Selected stream after six-second outage',15000);
      const after=await snapshot(host),guestAfter=await snapshot(guest);
      assert.equal(after.mediaUrl,before.mediaUrl,'reconnect keeps the captured stream');
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
      assert.equal(after.remote,false,'reconnect cannot enable remote consent');
      assert.equal(guestAfter.stream,guestBefore.stream,'other viewer remains unaffected');
      await command(host,'media.play');await until(host,'!video.paused && video.readyState>=3','Playback after sustained control outage');
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(tones>=5,'selected French audio decodes after sustained control outage');
      await command(host,'media.pause');
      return {detail:'Six seconds without control responses; captured French/ASS stream and guest survived, remote consent stayed off.',before,after,tones};
    });
    await check('rejoin after viewer timeout keeps personal tracks',async()=>{
      await choose(guest,{audioId:'1042',subtitleId:'off'});
      await until(guest,'state.tracks.audioId==="1042" && state.tracks.subtitleChoice==="off"','Guest personal track selection');
      await evaluate(guest,'('+installMeter.toString()+')()');await evaluate(guest,'playbackMeter.resumeAudio()');
      await evaluate(guest,'playbackMeter.reset("104","hls");true');
      const before=await snapshot(guest),hostBefore=await snapshot(host);
      await evaluate(guest,'(()=>{const original=window.fetch.bind(window),recoverAt=Date.now()+12000;window.fetch=(input,options)=>String(input).startsWith("/api/watch/rooms/"+selected+"?viewer=")&&Date.now()<recoverAt?Promise.reject(new TypeError("Fixture control outage")):original(input,options);return true;})()');
      await until(guest,'state===undefined && mediaSource===undefined','Long control outage unloads guest',6000);
      await until(guest,`state?.streamVersion!==${JSON.stringify(before.stream)} && video.readyState>=2`,'Guest rejoins after viewer timeout',25000);
      const after=await snapshot(guest),hostAfter=await snapshot(host);
      assert.equal(after.tracks.audioId,'1042','guest selected audio survives rejoin');
      assert.equal(after.tracks.subtitleChoice,'off','guest subtitle choice survives rejoin');
      assert.equal(after.remote,false,'rejoin does not enable remote consent');
      assert.equal(hostAfter.stream,hostBefore.stream,'host stream stays unchanged');
      const oldStatus=await evaluate(guest,`fetch(${JSON.stringify(before.mediaUrl)},{headers:token?{Authorization:'Bearer '+token}:{}}).then(r=>r.status)`);
      assert.equal(oldStatus,403,'old media grant stays revoked');
      await command(host,'media.play');await until(guest,'!video.paused && video.readyState>=3','Guest playback after rejoin');
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(guest,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(tones>=5,'selected French audio decodes after rejoin');
      await command(host,'media.pause');
      return {detail:'Twelve-second control outage removed and rejoined guest; French audio/Off choice returned without changing host or consent.',before,after,oldStatus,tones};
    });
    await check('buffer exhaustion recovers after delivery returns',async()=>{
      await command(host,'media.seek.absolute',{seconds:10});
      await until(host,'video.paused && !video.seeking && Math.abs(video.currentTime-10)<.7','Paused before long delivery outage');
      await pause(3000);
      const before=await snapshot(host);
      await command(host,'media.play');await until(host,'!video.paused && video.readyState>=3','Playback before long delivery outage');
      control.blocked=true;
      try { await pause(30000); } finally { control.blocked=false; }
      const interrupted=await snapshot(host);
      assert.equal(interrupted.buffered,0,'the outage must actually exhaust buffered media');
      const returnedAt=Date.now();
      await until(host,'!video.paused && video.readyState>=3 && !playbackError && Math.abs(video.currentTime-expected())<1','Playback after buffer exhaustion',30000);
      const recoveryMs=Date.now()-returnedAt;
      const recovered=await snapshot(host);
      await pause(3000);
      const after=await snapshot(host);
      assert.ok(after.position-recovered.position>2,'decoded playback advances after delivery returns');
      assert.ok(after.frames-recovered.frames>35,'video frames decode after delivery returns');
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(tones>=5,'selected French PCM decodes after delivery returns');
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
      await command(host,'media.pause');
      return {detail:'Thirty-second media outage exhausted the buffer; player caught up in '+recoveryMs+' ms, then decoded frames and selected audio continued.',before,interrupted,recovered,after,tones,recoveryMs};
    });
    await check('fatal HLS retry exhaustion recovers on a slow retry',async()=>{
      const before=await snapshot(host),guestBefore=await snapshot(guest);
      // Exhaust the real hls.js loader with actual failed segment requests.
      // Only this disposable client's internal retry budget is shortened;
      // application retry delays and production configuration stay unchanged.
      await evaluate(host,'(()=>{window.__fatalHls=[];window.__fragPolicy=hls.config.fragLoadPolicy;hls.config.fragLoadPolicy=JSON.parse(JSON.stringify(hls.config.fragLoadPolicy));hls.config.fragLoadPolicy.default.errorRetry.maxNumRetry=0;hls.config.fragLoadPolicy.default.timeoutRetry.maxNumRetry=0;hls.on(Hls.Events.ERROR,(_,data)=>{if(data.fatal&&data.type===Hls.ErrorTypes.NETWORK_ERROR)window.__fatalHls.push({at:Date.now(),details:data.details,retries:hlsNetworkRetries});});return true;})()');
      const started=Date.now();
      control.blocked=true;
      let interrupted;
      try {
        await command(host,'media.seek.absolute',{seconds:Math.min(sourceDuration-40,Math.max(60,before.position+25))});
        await command(host,'media.play');
        await until(host,'hlsNetworkRetries>=4 && !!hlsNetworkFailure','Actual fatal HLS retry exhaustion',60000);
        interrupted=await snapshot(host);
      } finally {control.blocked=false;}
      const returnedAt=Date.now();
      await until(host,'!video.paused && video.readyState>=3 && !playbackError && !hlsNetworkFailure && Math.abs(video.currentTime-expected())<1','Slow HLS recovery',35000);
      const recoveryMs=Date.now()-returnedAt,recovered=await snapshot(host);
      await pause(3000);const after=await snapshot(host),guestAfter=await snapshot(guest);
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      const events=JSON.parse(await evaluate(host,'JSON.stringify(window.__fatalHls)'));
      await evaluate(host,'hls.config.fragLoadPolicy=window.__fragPolicy;true');
      assert.ok(events.length>=4,'real hls.js fatal events exhaust all three quick retries');
      assert.ok(recoveryMs>=10000,'recovery uses the low-frequency timer');
      assert.ok(after.frames-recovered.frames>35);assert.ok(after.position-recovered.position>2);assert.ok(tones>=5);
      assert.equal(after.stream,before.stream);assert.equal(after.mediaUrl,before.mediaUrl);
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
      assert.equal(guestAfter.stream,guestBefore.stream);assert.equal(after.remote,false);
      await command(host,'media.pause');
      return {detail:'Actual failed fragments exhausted three quick restarts; a slow retry resumed decoded frames and French PCM without replacing the stream.',before,interrupted,recovered,after,events,recoveryMs,elapsedMs:Date.now()-started,tones};
    });
    await check('sole host rejoins an empty room after timeout',async()=>{
      await evaluate(guest,'selectRoom(undefined).then(()=>true)');
      await until(host,'state.viewers===1','Sole host');
      await command(host,'session.enable');
      const before=await snapshot(host);
      await evaluate(host,'(()=>{const original=window.fetch.bind(window),recoverAt=Date.now()+12000;window.fetch=(input,options)=>String(input).startsWith("/api/watch/rooms/"+selected+"?viewer=")&&Date.now()<recoverAt?Promise.reject(new TypeError("Fixture sole-host outage")):original(input,options);return true;})()');
      await until(host,'state===undefined && mediaSource===undefined','Host disconnect unloads playback',6000);
      await until(host,`!!state?.streamVersion && state.streamVersion!==${JSON.stringify(before.stream)} && video.readyState>=2`,'Host rejoins retained room',25000);
      const after=await snapshot(host);
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
      assert.notEqual(after.observationEpoch,before.observationEpoch);assert.equal(after.remote,false);
      const oldStatus=await evaluate(host,`fetch(${JSON.stringify(before.mediaUrl)},{headers:token?{Authorization:'Bearer '+token}:{}}).then(r=>r.status)`);
      assert.equal(oldStatus,403);
      await command(host,'media.play');await until(host,'!video.paused && video.readyState>=3','Playback after sole-host rejoin');
      const resumed=await snapshot(host);await pause(3000);const played=await snapshot(host);
      let tones=0;for(let i=0;i<15;i++){await pause(100);if(await evaluate(host,'(()=>{const s=playbackMeter.sample();return s&&s.audioDb>-65&&Math.abs(s.audioHz-880)<20;})()'))tones++;}
      assert.ok(played.frames-resumed.frames>35);assert.ok(tones>=5);
      await command(host,'media.pause');
      return {detail:'A twelve-second sole-host control outage retained the empty room; selected French/ASS playback resumed with fresh stream/observation state, old grant revoked and remote consent off.',before,after,oldStatus,tones};
    });
    await check('opt-in private control reconnect probe',async()=>{
      assert.equal(await evaluate(guest,'document.getElementById("probe-control").hidden'),true,'ordinary pages have no probe control');
      assert.equal(await evaluate(host,'document.getElementById("probe-control").disabled'),true,'public rooms cannot run the probe');
      await command(host,'session.visibility',{visibility:'private'});
      await until(host,'!document.getElementById("probe-control").disabled','Private single-viewer probe eligibility');
      const before=await snapshot(host);
      await evaluate(host,'document.getElementById("probe-control").click();true');
      await until(host,'state===undefined && mediaSource===undefined','Probe unloads only this tab',6000);
      await until(host,'!!state?.mediaUrl && video.readyState>=2 && !controlProbe.active()','Live control polling resumes',15000);
      const after=await snapshot(host);
      assert.equal(after.stream,before.stream);assert.equal(after.mediaUrl,before.mediaUrl);
      assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');assert.equal(after.remote,false);
      const trace=JSON.parse(await evaluate(host,'JSON.stringify(diagnostics.snapshot())'));
      assert.ok(trace.entries.some(row=>row.event==='probe-start'));
      assert.ok(trace.entries.some(row=>row.event==='probe-end'));
      fs.writeFileSync(path.join(output,'probe-diagnostics.json'),JSON.stringify(trace,null,2)+'\n');
      return {detail:'Six-second opt-in room-poll interruption reattached the same captured stream; private tracks and off consent retained.',before,after};
    });
    await check('diagnostics download layouts',async()=>{
      for(const [layout,width,height] of [['desktop',1280,900],['theater',1280,900],['phone',390,844]]){
        await browser.viewport(host,width,height);
        await evaluate(host,`setTheater(${layout==='desktop'?'false':'true'});true`);
        if(layout!=='desktop')await evaluate(host,'toggleDrawer(true);true');
        await pause(200);
        const bounds=JSON.parse(await evaluate(host,'(()=>{const button=document.getElementById("save-diagnostics");button.scrollIntoView({block:"center"});const r=button.getBoundingClientRect();return JSON.stringify({width:innerWidth,left:r.left,right:r.right,height:r.height,visible:!!button.getClientRects().length});})()'));
        assert.ok(bounds.visible&&bounds.left>=0&&bounds.right<=bounds.width&&bounds.height>=30,'diagnostic download is reachable in '+layout);
        await browser.screenshot(host,path.join(output,'diagnostics-'+layout+'.png'));
      }
      const downloaded=JSON.parse(await evaluate(host,'(async()=>{const original=URL.createObjectURL,click=HTMLAnchorElement.prototype.click;let blob;try{URL.createObjectURL=value=>{blob=value;return original(value);};HTMLAnchorElement.prototype.click=function(){};document.getElementById("save-diagnostics").click();return await blob.text();}finally{URL.createObjectURL=original;HTMLAnchorElement.prototype.click=click;}})()'));
      assert.equal(downloaded.schema,1);assert.ok(downloaded.entries.some(row=>row.event==='sample'),'download contains playback measurements');
      return {detail:'Download control is visible and fits desktop, theater drawer and portrait phone.'};
    });
    report.status='passed';
  }catch(error){report.error=error.stack||error.message;console.error('[Recovery]',error.stack||error.message);process.exitCode=1;}
  finally{
    control.blocked=false;
    if(browser)for(const [label,page] of [['host',host],['guest',guest]])if(page){
      try{const trace=await browser.evaluate(page,'JSON.stringify(diagnostics.snapshot())');fs.writeFileSync(path.join(output,label+'-final-diagnostics.json'),trace+'\n');}
      catch{report.diagnosticExportIncomplete=true;}
    }
    report.providerEvents=control.events;write();await browser?.close();await app.close();
  }
  console.log('[Recovery] Report:',path.join(output,'report.md'));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
