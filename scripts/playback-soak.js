/* Long local watch-player soak. Procedural media and simulated Plex only. */
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {createApp}=require('../server/app');
const {fixturePlex,installMeter}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');

function browserMemory(pid){
  if(process.platform!=='win32'||!Number.isInteger(pid))return null;
  try{
    const script='Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,PrivatePageCount | ConvertTo-Json -Compress';
    const rows=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
      {encoding:'utf8',timeout:15000,windowsHide:true,maxBuffer:4*1024*1024}));
    const all=Array.isArray(rows)?rows:[rows],tree=new Set([pid]);
    for(let changed=true;changed;){changed=false;for(const row of all)if(tree.has(row.ParentProcessId)&&!tree.has(row.ProcessId)){tree.add(row.ProcessId);changed=true;}}
    const members=all.filter(row=>tree.has(row.ProcessId));
    return {processes:members.length,workingSetBytes:members.reduce((n,row)=>n+Number(row.WorkingSetSize||0),0),
      privateBytes:members.reduce((n,row)=>n+Number(row.PrivatePageCount||0),0)};
  }catch{return null;}
}

async function main(){
  const args=process.argv.slice(2),option=(name,fallback)=>args.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3)||fallback;
  if(args.some(arg=>!/^--(media|out|minutes|expiry-seconds|outage-seconds|control-seconds|identity-seconds)=.+/.test(arg)))
    throw new Error('Use --media=corpus --out=new-directory [--minutes=1..120 --expiry-seconds=1200 --outage-seconds=900 --control-seconds=3600 --identity-seconds=0]');
  const minutes=Number(option('minutes','120')),expiryEvery=Number(option('expiry-seconds','1200')),
    outageEvery=Number(option('outage-seconds','900')),controlAt=Number(option('control-seconds','3600')),
    identitySeconds=Number(option('identity-seconds','0'));
  if(!Number.isInteger(minutes)||minutes<1||minutes>120||
    ![expiryEvery,outageEvery,controlAt].every(value=>Number.isInteger(value)&&value>=0&&value<=7200)||
    !Number.isInteger(identitySeconds)||identitySeconds<0||identitySeconds>3600||identitySeconds>0&&identitySeconds<10)throw new Error('Invalid soak schedule.');
  const root=path.resolve(__dirname,'..'),directory=path.resolve(option('media','artifacts/playback-media-recovery-240')),
    output=path.resolve(option('out','artifacts/playback-soak-'+Date.now()));
  if(fs.existsSync(output))throw new Error('Use a new output directory.');
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const duration=manifest.sources.find(source=>source.id==='104')?.duration;
  if(manifest.kind!=='uburoom-synthetic-playback'||!manifest.trackRenditions||duration<200)
    throw new Error('Generate a track corpus at least 200 seconds long.');
  fs.mkdirSync(output,{recursive:true});
  const control={events:[],requests:[],expiredSessions:new Set(),blocked:false};
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'synthetic-guild',channels:['synthetic-commands'],
    plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  if(identitySeconds)config.demoIdentityMs=identitySeconds*1000;
  const app=createApp(config,{plexFetch:fixturePlex(directory,manifest,control),oauthFetch:async()=>{throw new Error('Live OAuth disabled.');}});
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  const report={createdAt:new Date().toISOString(),status:'running',requestedMinutes:minutes,sourceSeconds:duration,
    scope:'Looped synthetic HLS source; real browser decode, simulated Plex, no live credentials or Discord',
    browser:'firefox',checkpoints:[],incidents:[],resourceSamples:[],summary:{}};
  const write=()=>{
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');
    fs.writeFileSync(path.join(output,'report.md'),'# Local browser playback soak\n\n'+report.scope+'\n\n'+
      `Status: ${report.status}. Elapsed: ${Math.round(report.elapsedSeconds||0)} s of ${minutes*60} s.\n\n`+
      '| Event | At (s) | Result | Detail |\n| --- | ---: | --- | --- |\n'+report.incidents.map(row=>
        `| ${row.kind} | ${row.atSeconds.toFixed(0)} | ${row.status} | ${row.detail||row.error||''} |`).join('\n')+
      '\n\n## Measurements\n\n'+JSON.stringify(report.summary,null,2)+'\n\n'+
      'Checkpoints and memory samples are in report.json. Browser memory is the Windows process tree working set/private bytes; provider offered bytes are not measured network throughput. A looped source does not certify an uninterrupted feature-length title or real Plex session lifetime.\n');
  };
  let browser,host,guest,started;
  try{
    browser=await playbackBrowser('firefox');report.version=browser.version;
    host=await browser.page(config.publicUrl+'/watch?demo=host');
    const evaluate=(page,code)=>browser.evaluate(page,code),until=(page,code,label,timeout)=>browser.until(page,code,label,timeout);
    await until(host,'!!me','Host login');
    await evaluate(host,'preferredQuality="direct";document.getElementById("create").click();document.getElementById("room-create").click();true');await until(host,'!!state','Room creation');
    await evaluate(host,'('+installMeter.toString()+')()');await evaluate(host,'playbackMeter.resumeAudio()');
    const command=async(page,action,args)=>{await until(page,'!!state&&!pending','Available control');return evaluate(page,
      `execute({action:${JSON.stringify(action)},args:${JSON.stringify(args||{})}}).then(()=>true)`);};
    const choose=async(page,settings)=>{await until(page,'!!state&&!pending','Available tracks');return evaluate(page,
      `execute({action:"media.tracks.set",args:{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,...${JSON.stringify(settings)}}}).then(()=>true)`);};
    const snapshot=page=>evaluate(page,'(()=>{const s=globalThis.playbackMeter?.sample()||{};return JSON.stringify({position:video.currentTime,target:expected(),frames:video.getVideoPlaybackQuality().totalVideoFrames,ready:video.readyState,paused:video.paused,waiting:playerWaiting,error:playbackError,buffered:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime),audioHz:s.audioHz,audioDb:s.audioDb,mediaVersion:state?.mediaVersion,streamVersion:state?.streamVersion,tracks:state?.tracks,remote:state?.enabled,mediaUrl:state?.mediaUrl,identityGeneration});})()').then(JSON.parse);
    const record=async(kind,action)=>{
      const incident={kind,atSeconds:(Date.now()-started)/1000,status:'failed'};report.incidents.push(incident);
      try{Object.assign(incident,await action());incident.status='passed';}
      catch(error){incident.error=error.message;throw error;}
      finally{write();console.log('[Soak]',kind,incident.status,incident.error||'');}
    };
    await command(host,'media.load',{mediaId:'104',quality:'direct'});
    await until(host,'state.format==="hls"&&video.readyState>=2','Host HLS');
    const roomId=await evaluate(host,'selected');guest=await browser.page(config.publicUrl+'/watch?demo=guest');
    await until(guest,'!!me','Guest login');await evaluate(guest,`preferredQuality="direct";selectRoom(${JSON.stringify(roomId)}).then(()=>true)`);
    await until(guest,'state.format==="hls"&&video.readyState>=2','Guest HLS');
    await choose(host,{audioId:'1042',subtitleId:'1044'});await choose(guest,{subtitleId:'off'});
    await until(host,'state.tracks.audioId==="1042"&&state.tracks.subtitleId==="1044"','Selected tracks');
    await command(host,'media.seek.absolute',{seconds:12});await command(host,'media.play');
    await until(host,'!video.paused&&video.readyState>=3','Decoded playback');
    await evaluate(host,'playbackMeter.reset("104","hls");true');
    started=Date.now();let lastPosition,lastProgressAt=started,settleUntil=0,nextCheckpoint=0,
      nextExpiry=expiryEvery||Infinity,nextOutage=outageEvery||Infinity,controlDone=false,lastBrowserMemory=0;
    let decodedFrames=0,previousFrames,audioMatches=0,driftMax=0,stalls=0,loops=0;
    const drifts=[];
    while(Date.now()-started<minutes*60000){
      const elapsed=(Date.now()-started)/1000;
      if(elapsed>=nextExpiry){
        await record('expired HLS session',async()=>{
          const before=await snapshot(host),guestBefore=await snapshot(guest),old=control.events.filter(e=>e.event==='start'&&e.audioId==='1042'&&e.subtitleId==='1044').at(-1)?.session;
          assert.ok(old,'current selected Plex session exists');control.expiredSessions.add(old);
          const destination=before.position>100?50:Math.min(duration-40,170),at=Date.now();
          await command(host,'media.seek.absolute',{seconds:destination});
          await until(host,`state.streamVersion!==${JSON.stringify(before.streamVersion)}&&video.readyState>=2&&!video.seeking`,'Expired session replacement',30000);
          const after=await snapshot(host),guestAfter=await snapshot(guest);
          assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');
          assert.equal(guestAfter.streamVersion,guestBefore.streamVersion);assert.equal(after.remote,false);
          assert.ok(control.events.some(e=>e.event==='start'&&e.session!==old&&e.audioId==='1042'&&e.subtitleId==='1044'));
          settleUntil=Date.now()+10000;lastPosition=undefined;
          return {detail:'New selected stream in '+(Date.now()-at)+' ms; guest unchanged.',recoveryMs:Date.now()-at};
        });
        nextExpiry+=expiryEvery;
      }
      if(elapsed>=nextOutage){
        await record('media delivery outage',async()=>{
          const before=await snapshot(host),at=Date.now();control.blocked=true;
          try{await pause(8000);}finally{control.blocked=false;}
          await until(host,'!playbackError&&video.readyState>=3','Delivery recovery',15000);
          const after=await snapshot(host);assert.ok(after.position-before.position>5,'buffered playback advanced during outage');
          return {detail:'Eight-second delivery outage; playback advanced '+(after.position-before.position).toFixed(1)+' s.',durationMs:Date.now()-at};
        });
        nextOutage+=outageEvery;
      }
      if(!controlDone&&controlAt&&elapsed>=controlAt){
        await record('control poll interruption',async()=>{
          const before=await snapshot(host);
          await evaluate(host,'(()=>{const original=transport.onMessage;let fail=true;transport.onMessage=message=>{if(fail&&message.type==="state"){fail=false;window.__soakControlFailed=true;unavailable("Fixture control interruption","room-poll");return;}original(message);};return true;})()');
          await until(host,'window.__soakControlFailed&&state===undefined&&mediaSource===undefined','Control loss unloads player',6000);
          await until(host,`state?.streamVersion===${JSON.stringify(before.streamVersion)}&&video.readyState>=3&&!video.paused`,'Control reconnect playback',20000);
          const after=await snapshot(host);assert.equal(after.mediaUrl,before.mediaUrl);assert.equal(after.tracks.audioId,'1042');assert.equal(after.tracks.subtitleId,'1044');assert.equal(after.remote,false);
          settleUntil=Date.now()+10000;lastPosition=undefined;
          return {detail:'Player unloaded and resumed the same captured audio and subtitle stream.'};
        });controlDone=true;
      }
      const state=await snapshot(host),now=Date.now();
      assert.equal(state.error,'','Player reported a playback error');
      assert.equal(state.tracks?.audioId,'1042','French audio selection changed');
      assert.equal(state.tracks?.subtitleId,'1044','ASS subtitle selection changed');
      assert.equal(state.remote,false,'Remote consent changed');
      if(previousFrames!==undefined&&state.frames>=previousFrames)decodedFrames+=state.frames-previousFrames;
      previousFrames=state.frames;
      if(state.position>duration-25){
        await record('source loop',async()=>{await command(host,'media.seek.absolute',{seconds:12});
          await until(host,'!video.seeking&&Math.abs(video.currentTime-12)<2','Loop seek',15000);
          settleUntil=Date.now()+10000;lastPosition=undefined;loops++;return {detail:'Shared seek to 12 s; tracks retained.'};});
      }else if(now>settleUntil){
        if(lastPosition!==undefined&&state.position-lastPosition<.25&&now-lastProgressAt>15000)throw new Error('Playback remained stalled for over 15 seconds');
        if(lastPosition===undefined||state.position-lastPosition>.25)lastProgressAt=now;
        lastPosition=state.position;
        const drift=Math.abs(state.position-state.target);drifts.push(drift);driftMax=Math.max(driftMax,drift);
        if(state.waiting||state.ready<3)stalls++;
      }
      if(state.audioDb>-65&&Math.abs(state.audioHz-880)<20)audioMatches++;
      if(elapsed>=nextCheckpoint){
        const room=app.watch.rooms.get(roomId),viewer=[...room.viewers.values()].find(v=>v.userId==='demo-host'),memory=process.memoryUsage();
        const offeredBytes=control.requests.reduce((sum,row)=>sum+(row.offeredBytes||0),0);
        const point={elapsedSeconds:elapsed,position:state.position,frames:state.frames,bufferedSeconds:state.buffered,driftSeconds:state.position-state.target,
          ready:state.ready,waiting:state.waiting,audioHz:state.audioHz,audioDb:state.audioDb,identityGeneration:state.identityGeneration,
          offeredBytes,serverHeapBytes:memory.heapUsed,serverRssBytes:memory.rss,resources:viewer?.media?.resources?.size||0,
          requests:control.requests.length};
        if(elapsed-lastBrowserMemory>=300||!report.resourceSamples.length){point.browserMemory=browserMemory(browser.pid);lastBrowserMemory=elapsed;}
        report.checkpoints.push(point);if(point.browserMemory)report.resourceSamples.push({elapsedSeconds:elapsed,...point.browserMemory});
        report.elapsedSeconds=elapsed;report.summary={loops,stalls,decodedFrames,audioMatches,identityGeneration:state.identityGeneration,driftMaxSeconds:driftMax,
          offeredMiB:Number((offeredBytes/1048576).toFixed(1)),serverHeapMiB:Number((memory.heapUsed/1048576).toFixed(1)),
          serverRssMiB:Number((memory.rss/1048576).toFixed(1)),browserMemory:point.browserMemory||report.resourceSamples.at(-1)||null};
        write();console.log('[Soak]',Math.floor(elapsed)+'s',JSON.stringify(report.summary));nextCheckpoint+=30;
      }
      await pause(5000);
    }
    const final=await snapshot(host),first=report.checkpoints[0],last=report.checkpoints.at(-1);
    assert.ok(report.checkpoints.length>=minutes*2-1,'Missing soak checkpoints');
    assert.equal(stalls,0,'Playback entered a sampled waiting state');
    assert.ok(decodedFrames>=minutes*60*15,'Too few decoded video frames');
    assert.ok(audioMatches>=minutes*6,'Too few decoded French audio samples');
    if(identitySeconds||minutes>=61)assert.ok(final.identityGeneration>=2,'Bearer identity did not renew');
    assert.equal(final.error,'');assert.equal(final.tracks.audioId,'1042');assert.equal(final.tracks.subtitleId,'1044');
    report.elapsedSeconds=(Date.now()-started)/1000;
    drifts.sort((a,b)=>a-b);
    report.summary={...report.summary,loops,stalls,decodedFrames,audioMatches,driftMaxSeconds:driftMax,
      driftP95Seconds:drifts.length?drifts[Math.floor((drifts.length-1)*.95)]:null,
      providerOfferedMbps:Number(((last.offeredBytes-first.offeredBytes)*8/Math.max(1,last.elapsedSeconds-first.elapsedSeconds)/1e6).toFixed(2)),
      serverHeapDeltaMiB:Number(((last.serverHeapBytes-first.serverHeapBytes)/1048576).toFixed(1)),
      serverRssDeltaMiB:Number(((last.serverRssBytes-first.serverRssBytes)/1048576).toFixed(1)),
      browserWorkingSetDeltaMiB:report.resourceSamples.length>1?Number(((report.resourceSamples.at(-1).workingSetBytes-report.resourceSamples[0].workingSetBytes)/1048576).toFixed(1)):null,
      browserPrivateDeltaMiB:report.resourceSamples.length>1?Number(((report.resourceSamples.at(-1).privateBytes-report.resourceSamples[0].privateBytes)/1048576).toFixed(1)):null};
    await browser.screenshot(host,path.join(output,'final-player.png'));
    report.status='passed';
  }catch(error){report.status='failed';if(started)report.elapsedSeconds=(Date.now()-started)/1000;report.error=error.stack||error.message;console.error('[Soak]',report.error);process.exitCode=1;}
  finally{control.blocked=false;report.providerEvents=control.events;write();await browser?.close();await app.close();}
  console.log('[Soak] Report:',path.join(output,'report.md'));
}

main().catch(error=>{console.error(error.stack);process.exitCode=1;});
