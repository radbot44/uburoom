/* Matched, counterbalanced initial-load trials. Local fixtures only; no .env. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser,pause}=require('./lib/playback-browser');
const {execute}=require('./build-playback-fixtures');
const {compare,distribution,summarize}=require('./sync-report');
function compareTrial(a,b) {
  try{return compare(a,b,{sameTimeline:true});}
  catch(error) {
    if(!/continuous (clock|presentation) segment/.test(error.message))throw error;
    return {unavailable:error.message,viewers:[summarize(a),summarize(b)]};
  }
}
function trials(repeats,rtts,seed=20261016,comparison='unit') {
  let random=seed>>>0;const next=()=>{random=(Math.imul(random,1664525)+1013904223)>>>0;return random;};
  const rows=[];
  for(let round=0;round<repeats;round++)for(const rtt of rtts){
    const order=next()&0x10000?['controller',comparison]:[comparison,'controller'];
    for(const mode of order)rows.push({round:round+1,rtt,mode});
  }
  return rows;
}
function startup(log,states) {
  const frames=log.entries.filter(r=>r.event==='frame'&&r.roomPaused===false&&!r.paused&&!r.waiting&&!r.seeking&&Number.isFinite(r.frameServerTime));
  const first=frames[0],receipt=states.find(r=>!r.paused&&!r.waitingForReady);
  return {firstFrameServerTime:first?.frameServerTime??null,firstFrameMediaTime:first?.frameMediaTime??null,
    firstFrameErrorMs:first?.presentationErrorMs??null,initialErrorMs:distribution(frames.slice(0,24).map(r=>Math.abs(r.presentationErrorMs))),
    firstPlayingReceipt:receipt??null,frameCount:frames.length};
}
function compareStarts(a,b) {
  const frames=log=>log.entries.filter(r=>r.event==='frame'&&r.roomPaused===false&&!r.paused&&!r.waiting&&!r.seeking&&Number.isFinite(r.frameServerTime));
  const left=frames(a),right=frames(b),lookup=new Map(right.map(r=>[Math.round(r.frameMediaTime*1000),r])),matches=[];
  for(const l of left){const r=lookup.get(Math.round(l.frameMediaTime*1000));if(r)matches.push({mediaTime:l.frameMediaTime,displayDifferenceMs:Math.abs(l.frameServerTime-r.frameServerTime)});}
  return {firstCommonFrame:matches[0]??null,matchingFrameDifferencesMs:distribution(matches.map(r=>r.displayDifferenceMs))};
}
function installFixture(delay,gentle=true) {
  const apply=applyState,rate=Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype,'playbackRate');
  globalThis.startupFixture={delay,unit:false,legacy:false,states:[],attempts:0};
  const baseController=uburoomTiming.correction();
  const controller={
    policy:'gentle',
    get mode(){return startupFixture.legacy?'legacy':'gentle';},
    update(input){
      if(startupFixture.legacy) {
        return !input.eligible||Math.abs(input.error)<.15||Math.abs(input.error)>.65?1:input.error>0?1.04:.96;
      }
      return baseController.update(input);
    },
    reset(){baseController.reset();}
  };
  sync.driftCorrection=controller;
  if(sync.driftCorrection?.policy!=='gentle') {
    throw new Error('Requested policy is not active on the live controller');
  }
  Object.defineProperty(video,'playbackRate',{configurable:true,get(){return rate.get.call(this);},set(value){
    if(value!==rate.get.call(this))startupFixture.attempts++;rate.set.call(this,startupFixture.unit?1:value);
  }});
  // Delay the actual WebSocket control path, including clock exchanges. HTTP
  // fetch delays no longer exercise watch control after the socket migration.
  const socket=transport.socket,send=socket.send.bind(socket),receive=socket.onmessage;
  socket.send=data=>setTimeout(()=>{if(socket.readyState===1)send(data);},startupFixture.delay/2);
  socket.onmessage=event=>setTimeout(()=>receive(event),startupFixture.delay/2);
  applyState=function(next){
    const timing=playbackClock.read();
    startupFixture.states.push({receivedServerTime:timing.serverTime,serverNow:next.serverNow,position:next.state.position,
      paused:next.state.paused,waitingForReady:next.waitingForReady,startAt:next.startAt,revision:next.revision,
      localPosition:video.currentTime,localPaused:video.paused,ready:video.readyState,callbackFrames:videoFrames});
    if(startupFixture.states.length>100)startupFixture.states.shift();return apply(next);
  };
  return true;
}
function immediateStarts(watch) {
  const execute=watch.execute.bind(watch);
  watch.execute=async(room,command,actor,permitted)=>{
    const result=await execute(room,command,actor,permitted);
    if(result.status==='applied' && actor.watchAutoplayVersion===room.mediaVersion && room.startAt) {
      const now=Date.now();room.position=watch.position(room,now);room.changedAt=now;room.startAt=undefined;watch.refresh(room,now);
    }
    return result;
  };
}
async function main() {
  const option=(key,fallback)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
  const name=option('browser','firefox'),repeats=Number(option('repeats','5')),seconds=Number(option('seconds','6')),
    rtts=option('rtts','20,320').split(',').map(Number),seed=Number(option('seed','20261016')),fps=option('fps','24'),
    output=path.resolve(option('output','artifacts/startup-'+Date.now())),initialStart=option('initial-start','scheduled'),
    comparison=option('comparison','unit'),drift=Number(option('drift','0'));
  assert.ok(Number.isInteger(repeats)&&repeats>0&&repeats<=20&&seconds>=4&&seconds<=15&&rtts.every(n=>n>=0&&n<=1000)&&/^\d+(?:\/\d+)?$/.test(fps));
  assert.ok(['immediate','scheduled'].includes(initialStart));
  assert.ok(['unit','legacy'].includes(comparison)&&Number.isFinite(drift)&&Math.abs(drift)<=.6);
  if(initialStart==='immediate'&&option('lifecycle','off')==='on')throw new Error('Lifecycle checks require scheduled initial starts');
  if(fs.existsSync(output))throw new Error('Use a new output directory');fs.mkdirSync(output,{recursive:true});
  const media=path.join(output,'fixture.mp4'),root=path.resolve(__dirname,'..');
  execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate='+fps,
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','40','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-movflags','+faststart',media]);
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture-guild',channels:['fixture-channel'],demo:true};
  const app=createApp(config,{oauthFetch:async()=>{throw new Error('Live OAuth disabled');},plexFetch:async()=>{throw new Error('Live Plex disabled');}});
  if(initialStart==='immediate')immediateStarts(app.watch);
  app.watch.demoMedia={...app.watch.demoMedia,file:media,duration:40};
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'fixture-call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  const report={browser:name,initialStart,sourceFps:fps,seconds,seed,repeats,comparison,policy:'gentle',injectedGuestDriftSeconds:drift,results:[],limitations:'Two reused disposable headless software browsers, one machine; symmetric application WebSocket delays, including clock exchanges. Native protocol ping/pong is not delayed. Unit mode suppresses rate nudges only. Legacy mode uses the 4% gain/deadband with current recovery eligibility. All retain meaningful seeks. Optional guest drift is a local seek after startup. Trials are matched by round/RTT and counterbalanced, not physical output, motion quality or WAN certification.'};
  let host,guest;
  try {
    host=await playbackBrowser(name);guest=await playbackBrowser(name);report.versions=[host.version,guest.version];
    const h=await host.page(config.publicUrl+'/watch?demo=host'),g=await guest.page(config.publicUrl+'/watch?demo=guest'),clients=[[host,h],[guest,g]];
    for(const [browser,page]of clients){
      await browser.until(page,'typeof transport!=="undefined"&&transport?.ready','Fixture login');
      await browser.evaluate(page,'('+installFixture.toString()+')(20,true)');
      const activePolicy=await browser.evaluate(page,'sync?.driftCorrection?.policy');
      assert.equal(activePolicy,'gentle','Requested policy must be active on live controller');
    }
    await host.evaluate(h,'document.getElementById("create").click();document.getElementById("room-create").click();true');await host.until(h,'!!state','Fixture room');
    const room=await host.evaluate(h,'selected');await guest.evaluate(g,'selectRoom('+JSON.stringify(room)+').then(()=>true)');await guest.until(g,'!!state','Guest room');
    for(const trial of trials(repeats,rtts,seed,comparison)) {
      if(app.watch.rooms.get(room).media)await host.evaluate(h,'execute({action:"media.pause"}).then(()=>true)');
      await Promise.all(clients.map(([browser,page],i)=>browser.evaluate(page,`startupFixture.delay=${i?trial.rtt:20};startupFixture.unit=${trial.mode==='unit'};startupFixture.legacy=${trial.mode==='legacy'};sync.resetCorrection(true);startupFixture.attempts=0;startupFixture.states=[];playbackClock.reset();refreshState().then(()=>true)`)));
      for(const [browser,page]of clients){
        const activeMode=await browser.evaluate(page,'sync?.driftCorrection?.mode');
        const expectedMode=trial.mode==='legacy'?'legacy':'gentle';
        assert.equal(activeMode,expectedMode,'Live controller mode must match requested mode');
      }
      for(const [browser,page]of clients)await browser.until(page,'playbackClock.read().valid','Fresh clock');
      const boundaries=await Promise.all(clients.map(([browser,page])=>browser.evaluate(page,'diagnosticSample();diagnostics.snapshot().entries.at(-1).ms')));
      await host.evaluate(h,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
      await Promise.all(clients.map(([browser,page])=>browser.until(page,'!!state.mediaUrl&&!state.state.paused&&!state.waitingForReady&&!video.paused&&videoFrames>2','Decoded initial start')));
      let injection;
      if(drift) {
        await guest.until(g,'video.currentTime>1&&!video.seeking','Drift injection headroom');
        injection=JSON.parse(await guest.evaluate(g,`JSON.stringify((()=>{const before=video.currentTime,target=expected(),requested=target+${drift};video.currentTime=requested;return {before,target,requested};})())`));
      }
      await pause(seconds*1000);
      const captures=await Promise.all(clients.map(async([browser,page],i)=>JSON.parse(await browser.evaluate(page,`JSON.stringify((()=>{diagnosticSample();const log=diagnostics.snapshot();log.entries=log.entries.filter(r=>r.ms>=${boundaries[i]}&&r.media===log.entries.at(-1).media);return {log,states:startupFixture.states,rateAttempts:startupFixture.attempts};})())`))));
      const prefix=trial.round+'-'+trial.rtt+'-'+trial.mode;
      // Preserve evidence even when clock/coverage validation rejects a pair.
      captures.forEach((r,i)=>fs.writeFileSync(path.join(output,prefix+'-'+(i?'guest':'host')+'.json'),JSON.stringify(r)));
      const [a,b]=captures.map(r=>r.log),pair=compareTrial(a,b),starts=captures.map(r=>startup(r.log,r.states));
      const steadyLogs=captures.map(r=>{const start=r.log.entries.find(x=>x.event==='frame'&&x.roomPaused===false&&!x.paused)?.ms??Infinity;return {...r.log,entries:r.log.entries.filter(x=>x.ms>=start+2000)};});
      const steady=compareTrial(...steadyLogs),matching=compareStarts(a,b);
      const result={...trial,injection,status:steady.unavailable?'invalid-presentation-segment':steady.healthySkewMs.count>100&&steady.healthyCoverageFraction>=.8?'measured':'insufficient-presentation-coverage',starts,matching,pair,steady,
        rateAttempts:captures.map(r=>r.rateAttempts),receiptDifferenceMs:Math.abs(starts[0].firstPlayingReceipt?.receivedServerTime-starts[1].firstPlayingReceipt?.receivedServerTime)};
      report.results.push(result);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
      console.log(JSON.stringify({round:trial.round,rtt:trial.rtt,mode:trial.mode,status:result.status,receiptMs:result.receiptDifferenceMs,
        firstCommon:matching.firstCommonFrame,skew:steady.healthySkewMs,rates:steady.viewers.map(r=>r.rateChanges),initialErrors:starts.map(s=>s.firstFrameErrorMs)}));
    }
    if(option('lifecycle','off')==='on') {
      for(const [browser,page]of clients)await browser.evaluate(page,`startupFixture.unit=false;startupFixture.legacy=false;sync.resetCorrection(true);true`);
      report.lifecycle=await require('./lib/sync-start-lifecycle').startLifecycle({host,guest,h,g,app,room,output});
      fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({lifecycle:report.lifecycle}));
    }
    app.watch.remove(room);
  }finally{await Promise.allSettled([host?.close(),guest?.close()]);await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={trials,startup,compareStarts,immediateStarts,compareTrial};
