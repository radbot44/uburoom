'use strict';
const {install}=require('./helpers/watch-sync');
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {clock,target,presentation,correction}=require('../web/playback-timing');
const {create}=require('../web/playback-diagnostics');
const {compare}=require('../scripts/sync-report');
function fixture() {
  let mono=0,wall=100000;const c=clock({monotonic:()=>mono,wall:()=>wall});
  const tick=(ms,date=ms)=>{mono+=ms;wall+=date;};
  function sample(up=10,down=up,processing=0,step=0) {
    const request=c.begin();tick(up);const received=wall+500+step;tick(processing);const sent=wall+500+step;tick(down);
    return c.add(request,{serverReceivedAt:received,serverSentAt:sent,serverProcessingMs:processing,clockEpoch:'server'});
  }
  return {c,tick,sample,now:()=>mono};
}
test('four timestamps separate processing and RTT, bound asymmetric delay, and ignore client wall offsets',()=>{
  for(const rtt of [20,100,200,300,450]) {
    const f=fixture();assert.equal(f.sample(rtt/2,rtt/2,83),true);
    const t=f.c.read();assert.equal(t.networkRttMs,rtt);assert.equal(t.clockOffsetMs,500);
    assert.equal(t.serverTime,100500+f.now());assert.ok(t.clockUncertaintyMs>=rtt/2);
  }
  const f=fixture();f.sample(20,280,70);const t=f.c.read();
  assert.equal(t.clockOffsetMs,370);assert.ok(Math.abs(t.serverTime-(100500+f.now()))<=t.clockUncertaintyMs);
});
test('clock rejects jitter/malformed/reordered exchanges; refinements slew without target jumps',()=>{
  const f=fixture();f.sample();const first=f.c.read();f.tick(1000);assert.equal(f.sample(10,700),false);
  assert.equal(f.c.read().clockOffsetMs,500);assert.equal(f.c.read().clockReason,'jitter');
  f.tick(1000);f.sample(10,10,0,20);assert.equal(f.c.read().clockOffsetMs,500);
  f.tick(1000);assert.ok(Math.abs(f.c.read().clockOffsetMs-500)<=2.001);
  const request=f.c.begin();f.tick(10);assert.equal(f.c.add(request,{serverReceivedAt:NaN}),false);
  f.c.reset();assert.equal(f.c.add(request,{serverReceivedAt:1,serverSentAt:1,serverProcessingMs:0,clockEpoch:'server'}),false);
  assert.equal(first.valid,true);assert.equal(f.c.read().valid,false);
});
test('clock expires, detects sleep/wake and both directions of wall jumps, and requires agreement on server steps',()=>{
  for(const jump of [-4745,4745]){const f=fixture();f.sample();f.tick(1000,1000+jump);assert.equal(f.c.read().valid,false);assert.equal(f.sample(),true);}
  const f=fixture();f.sample();f.tick(5100);assert.equal(f.c.read().valid,false);assert.equal(f.sample(),true);
  const revision=f.c.read().clockRevision;
  assert.equal(f.sample(10,10,0,2000),false);assert.equal(f.sample(10,10,0,2000),false);assert.equal(f.sample(10,10,0,2000),true);
  assert.ok(f.c.read().clockRevision>revision);assert.equal(f.c.read().clockOffsetMs,2500);
});
test('a stable slower route is reacquired without a thirty-second clock outage',()=>{
  const f=fixture();f.sample();
  f.tick(700);assert.equal(f.sample(150,150),false);
  f.tick(700);assert.equal(f.sample(150,150),false);
  f.tick(700);assert.equal(f.sample(150,150),true);
  assert.equal(f.c.read().networkMinRttMs,300);assert.equal(f.c.read().clockOffsetMs,500);assert.ok(f.c.read().clockUncertaintyMs>=150);
});
test('shared target removes response-arrival bias and follows pause, seek, replacement and bounds',()=>{
  const state={serverNow:100000,state:{position:10,duration:60,paused:false}};
  assert.equal(target(state,100150),10.15);assert.equal(target(state,200000),60);
  assert.equal(target({...state,state:{...state.state,paused:true}},100150),10);
  assert.equal(target({...state,state:{position:42,duration:100,paused:false}},101000),43);
  assert.equal(target({...state,state:{position:0,duration:5,paused:true}},101000),0);
  assert.equal(target(state,undefined),undefined);
});
test('player uses the mapped server target and tolerates clock loss without drift corrections',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8');
  let valid=true,serverTime=100300;
  const ctx={state:{mediaUrl:'fixture',format:'file',serverNow:100000,state:{position:10,duration:60,paused:false,volume:50,muted:false}},
    playbackClock:{read:()=>({valid,serverTime:valid?serverTime:undefined})},uburoomTiming:{target},receivedAt:100,
    performance:{now:()=>100},document:{visibilityState:'visible'},syncCorrectionMode:'speed',precisionCorrectionEnabled:false,pauseAlarm:{cancel(){}},gentleCorrectionEnabled:false,driftCorrection:correction(),startKey:()=> 'fixture',presentationTiming:presentation(),playerWaiting:false,
    uburoomPlayback:require('../web/playback-policy'),video:{currentTime:10.3,readyState:4,seeking:false,playbackRate:1,paused:false,buffered:{length:0}},
    hlsPreparationUntil:0,hlsTimelinePending:false,syncSeekPending:false,probing:false,playbackError:'',hlsNetworkFailure:undefined,autoplayBlocked:false,diagnosticSample(){},renderTransport(){},checkVideoFrames(){}};
  vm.runInNewContext(source.slice(source.indexOf('function expected('),source.indexOf('async function reportObservation(')),ctx);
  await install(ctx);
  assert.equal(ctx.expected(),10.3);await ctx.synchronize();assert.equal(ctx.video.playbackRate,1);
  valid=false;ctx.video.currentTime=5;await ctx.synchronize();assert.equal(ctx.video.currentTime,5);assert.equal(ctx.video.playbackRate,1);
  valid=true;await ctx.synchronize();assert.equal(ctx.video.currentTime,10.3,'fresh clock permits meaningful catch-up');
});
test('late room polls and failures cannot overwrite a newer authorized state',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8'),pending=[],applied=[];
  const ctx={selected:'room',stateRequestSequence:0,stateTransportSequence:0,Date,performance,viewerId:'viewer',preferredQuality:'direct',URLSearchParams,viewerPreferences:()=>({viewer:'viewer',quality:'direct'}),
    playbackClock:{begin:()=>({sent:performance.now()}),add(){},read:()=>({})},diagnostics:{record(){}},
    api:()=>new Promise((resolve,reject)=>pending.push({resolve,reject})),observationClock:{update:()=>0},observationClockRevision:0,
    playbackError:'',applyState:v=>applied.push(v.marker),fail(){},reportReadiness(){},unavailable(){throw new Error('Old failure must not clear new state');}};
  vm.runInNewContext(source.slice(source.indexOf('async function refreshState('),source.indexOf('async function selectRoom(')),ctx);
  const first=ctx.refreshState(),second=ctx.refreshState();
  pending[1].resolve({marker:'new',serverNow:Date.now()});await second;
  pending[0].resolve({marker:'old',serverNow:Date.now()});await first;assert.deepEqual(applied,['new']);
  const third=ctx.refreshState(),fourth=ctx.refreshState();pending[3].resolve({marker:'newest',serverNow:Date.now()});await fourth;
  pending[2].reject(new Error('old failure'));await third;assert.deepEqual(applied,['new','newest']);
});
test('command deadlines use fresh mapped time and never queue controls without a clock',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8'),sent=[];
  let valid=true;
  const ctx={switchingRoom:false,reconnecting:false,transport:{ready:true},selected:'room',viewerId:'viewer',state:{epoch:'current',state:{paused:false}},pending:false,qualityPending:false,
    playbackClock:{read:()=>({valid,serverTime:100000})},diagnosticSample(){},diagnostics:{record(){}},fail(){},
    api:async(path,data)=>{sent.push({path,data});return {status:'applied'};},refreshState:async()=>{},renderLibrary(){},renderVisibility(){},renderTransport(){},pumpVolume(){}};
  vm.runInNewContext(source.slice(source.indexOf('async function execute('),source.indexOf('function renderMediaInformation(')),ctx);
  await ctx.execute({action:'media.pause'});assert.equal(sent[0].data.expiresAt,102500);assert.equal(sent[0].data.epoch,'current');
  valid=false;await assert.rejects(ctx.execute({action:'media.pause'}),/timing is refreshing/);assert.equal(sent.length,1);assert.equal(ctx.pending,false);
  valid=true;ctx.reconnecting=true;await assert.rejects(ctx.execute({action:'media.pause'}),/Reconnecting/);assert.equal(sent.length,1,'controls are not queued during reconnect');
  ctx.reconnecting=false;ctx.volumePending=false;ctx.savePlayerPreferences=()=>{};
  const releases=[];ctx.api=()=>new Promise(resolve=>releases.push(resolve));
  const volume=ctx.execute({action:'media.volume.set',args:{percent:17}});
  assert.equal(ctx.pending,false,'personal volume does not lock unrelated controls');
  const shared=ctx.execute({action:'media.pause'});
  assert.equal(ctx.pending,true);
  releases[0]({status:'applied'});await volume;
  assert.equal(ctx.pending,true,'volume completion cannot unlock a concurrent shared command');
  releases[1]({status:'applied'});await shared;assert.equal(ctx.pending,false);

});

test('ordinary unlocked resume does not play a probe before its shared deadline',async()=>{
  const source=fs.readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8');
  let probes=0;
  const ctx={switchingRoom:false,reconnecting:false,transport:{ready:true},selected:'room',viewerId:'viewer',readyVersion:'media',autoplayBlocked:false,
    state:{epoch:'current',mediaVersion:'media',state:{paused:true,duration:120}},pending:false,qualityPending:false,expected:()=>10,
    unlockLocal:async()=>{probes++;},playbackClock:{read:()=>({valid:true,serverTime:100000})},diagnosticSample(){},diagnostics:{record(){}},fail(){},
    api:async()=>({status:'applied'}),refreshState:async()=>{},renderLibrary(){},renderVisibility(){},renderTransport(){},pumpVolume(){}};
  vm.runInNewContext(source.slice(source.indexOf('async function execute('),source.indexOf('function renderMediaInformation(')),ctx);
  await ctx.execute({action:'media.play'});assert.equal(probes,0);
  ctx.autoplayBlocked=true;await ctx.execute({action:'media.play'});assert.equal(probes,1,'blocked playback still unlocks in the user gesture');
});
test('presentation measures compositor cadence and callback gaps, never equating them to dropped pixels',()=>{
  const p=presentation();const a=p.frame(20,{mediaTime:1,expectedDisplayTime:22,presentationTime:18,presentedFrames:1,processingDuration:.003});
  assert.equal(a.frameIntervalMs,undefined);assert.equal(a.frameCallbackLatenessMs,-2);assert.equal(a.frameProcessingMs,3);
  const b=p.frame(63,{mediaTime:1+1/24,expectedDisplayTime:64,presentedFrames:3});
  assert.equal(b.frameIntervalMs,42);assert.equal(b.frameCallbackGap,1);
  assert.equal(p.frame(64,{mediaTime:1+1/24,expectedDisplayTime:65,presentedFrames:4}).frameRepeated,true);
  p.reset();assert.equal(p.frame(200,{mediaTime:9,expectedDisplayTime:200,presentedFrames:1}).frameIntervalMs,undefined);
});
test('frame diagnostics have their own bounded sanitized ring',()=>{
  const d=create();for(let i=0;i<7300;i++)d.record('frame',{frameMediaTime:i,frameServerTime:100000+i,clockEpoch:'secret',url:'secret'});
  const log=d.snapshot();assert.equal(log.discardedFrames,100);assert.equal(log.entries.filter(r=>r.event==='frame').length,7200);
  assert.equal(log.entries.filter(r=>r.event==='frame')[0].frameMediaTime,100);assert.ok(!JSON.stringify(log).includes('secret'));
});
test('sync-quality diagnostics retain bounded scoring contributors and sanitize device identity',()=>{
  const d=create();d.record('sync-quality',{qualityStatus:'playing',qualityConfidence:'reduced',qualityReason:'position-timing-estimate',rawQualityScore:.3,smoothedQualityScore:.8,
    measuredPlaybackSeconds:50,outOfSync250Seconds:12,outOfSync500Seconds:4,automaticCorrectionCount:3,
    automaticCorrectionMagnitudeMs:1900,correctionDutyCycle:.2,rateAdjustedSeconds:10,rateAdjustmentSeconds:.4,
    bufferingSeconds:2,qualityMeasurementFreshnessMs:2800,presentationMeasuredSeconds:40,positionMeasuredSeconds:10,
    lastKnownQualityLevel:'good',deviceLabel:'Firefox · Android'});
  const row=d.snapshot().entries.find(entry=>entry.event==='sync-quality');
  assert.equal(row.qualityStatus,'playing');assert.equal(row.qualityConfidence,'reduced');assert.equal(row.qualityReason,'position-timing-estimate');assert.equal(row.rawQualityScore,.3);
  assert.equal(row.automaticCorrectionCount,3);assert.equal(row.bufferingSeconds,2);assert.equal(row.lastKnownQualityLevel,'good');
  assert.equal(row.presentationMeasuredSeconds,40);assert.equal(row.positionMeasuredSeconds,10);
  assert.equal(Object.hasOwn(row,'deviceLabel'),false);
});
function trace(delay=0,changes={}) {
  return {entries:Array.from({length:301},(_,i)=>({event:'frame',room:1,media:1,timelineRevision:1,frameServerTime:100000+i*20,
    frameMediaTime:i*.02-delay,clockValid:true,clockUncertaintyMs:10,paused:false,seeking:false,waiting:false,ready:4,bufferAhead:5,visibility:'visible',rate:1,...changes}))};
}
test('pairwise report uses held presented frames, reports excluded recovery and refuses unrelated/absent evidence',()=>{
  assert.throws(()=>compare(trace(),trace()),/Confirm/);
  const report=compare(trace(),trace(.04),{sameTimeline:true});assert.ok(Math.abs(report.healthySkewMs.p95-40)<.001);
  assert.equal(report.combinedClockUncertaintyMs.p95,20);
  const recovering=trace(.3);for(let i=100;i<200;i++)recovering.entries[i].waiting=true;
  const recovery=compare(trace(),recovering,{sameTimeline:true});assert.ok(recovery.excludedGridSamples.buffering>0);
  assert.ok(recovery.excludedSkewMs.p95>=299);assert.ok(recovery.healthySkewMs.p95>=299);
  assert.throws(()=>compare(trace(),{entries:[]},{sameTimeline:true}),/unavailable/);
  const mixed=trace();mixed.entries[200].media=2;assert.throws(()=>compare(trace(),mixed,{sameTimeline:true}),/generation/);
  const lostClock=trace();for(const r of lostClock.entries){r.frameDisplayMonoMs=r.frameServerTime-100000;}
  for(let i=100;i<200;i++){lostClock.entries[i].clockValid=false;delete lostClock.entries[i].frameServerTime;}
  assert.ok(compare(trace(),lostClock,{sameTimeline:true}).excludedGridSamples['clock-unavailable']>0);
  const reset=trace();reset.entries[200].clockRevision=2;assert.throws(()=>compare(trace(),reset,{sameTimeline:true}),/continuous/);
  const sparse=trace();for(const r of sparse.entries)r.frameCallbackGap=1;
  const gapReport=compare(trace(),sparse,{sameTimeline:true});assert.ok(gapReport.excludedGridSamples['callback-gap']>500);assert.ok(gapReport.healthyCoverageFraction<.01);
});
