'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const quality=require('../web/sync-quality');

const clean={measuredSeconds:60,outOfSync250Seconds:0,outOfSync500Seconds:0,automaticCorrectionCount:0,
  automaticCorrectionMagnitudeMs:0,rateAdjustedSeconds:0,rateAdjustmentSeconds:0,bufferingSeconds:0};
function ready(tracker,from=0,to=12000,context='room:viewer:media:stream') {
  for(let at=from;at<=to;at+=1000)tracker.sample({at,errorMs:20,playbackRate:1,eligible:true,context,clockRevision:1});
  return context;
}
function refresh(tracker,at,overrides={}) {
  return tracker.refresh({at,rttSampleCount:10,clockValid:true,clockAgeMs:0,clockUncertaintyMs:20,playbackStatus:'playing',...overrides});
}

test('scoring rewards clean playback and ignores large RTT or jitter variation',()=>{
  assert.equal(quality.calculate(clean),1);
  assert.equal(quality.calculate({...clean,networkRttMs:1000,networkJitterMs:900}),1,'mobile network latency/range is diagnostic only');
  const tracker=quality.create();ready(tracker);
  const first=refresh(tracker,12000);
  for(let at=13000;at<=17000;at+=1000)tracker.sample({at,errorMs:20,playbackRate:1,eligible:true,context:'room:viewer:media:stream',clockRevision:1});
  const jitterSpike=refresh(tracker,17000,{rttSampleCount:16});
  assert.equal(first.status,'playing');assert.equal(first.score,1);
  assert.equal(jitterSpike.score,first.score,'network timing variation is not a direct score input');
  assert.equal(quality.calculate({...clean,bufferingSeconds:undefined}),undefined,'missing measurements remain unavailable');
  assert.equal(quality.calculate({...clean,bufferingSeconds:-1}),undefined);
});

test('out-of-sync time degrades playback even without automatic corrections',()=>{
  const drifting={...clean,measuredSeconds:60,outOfSync250Seconds:60,outOfSync500Seconds:60};
  const score=quality.calculate(drifting);
  assert.ok(score<.1,'continuous drift beyond 500 ms scores poorly without correction events');
  assert.ok(quality.calculate({...clean,outOfSync250Seconds:30})<1,'time beyond 250 ms is represented');
});

test('hard correction frequency and magnitude plus speed-correction duty reduce quality',()=>{
  const corrected=quality.calculate({...clean,automaticCorrectionCount:8,automaticCorrectionMagnitudeMs:12000,
    rateAdjustedSeconds:20,rateAdjustmentSeconds:.8});
  assert.ok(corrected<.5,'frequent large seeks and sustained playback-rate correction affect quality');
  assert.ok(corrected>0);
});

test('actual rebuffering lowers the score while healthy prebuffered playback does not',()=>{
  assert.equal(quality.calculate(clean),1);
  const stalled=quality.calculate({...clean,bufferingSeconds:15});
  assert.ok(stalled<.6&&stalled>.4,'a genuine 15-second stall causes a prompt rating drop');
});

test('viewers start at provisional 100% and the first valid interval begins refining the score',()=>{
  let at=0;const tracker=quality.create({now:()=>at}),context='room:viewer:media:stream';
  const initial=refresh(tracker,0,{clockValid:false});
  assert.equal(initial.score,1);assert.equal(initial.level,'excellent');assert.equal(initial.confidence,'provisional');
  at=0;tracker.sample({at,errorMs:800,eligible:true,context,clockRevision:1});
  at=1000;tracker.sample({at,errorMs:800,eligible:true,context,clockRevision:1});
  const first=refresh(tracker,1000,{rttSampleCount:1});
  assert.equal(first.status,'playing');assert.equal(first.updated,true);assert.ok(first.score<.5,'first valid interval can lower the provisional estimate');
  assert.equal(first.confidence,'confident','the first usable interval qualifies playback without five RTT exchanges');
  assert.equal(refresh(tracker,2000,{clockValid:false}).score,first.score,'clock interruptions retain the estimate');
  assert.equal(refresh(tracker,2000,{clockValid:false}).confidence,'confident','brief clock loss retains recent evidence');
  assert.equal(refresh(tracker,2000,{clockUncertaintyMs:900}).score,first.score,'uncertain clocks do not erase the score');
});

test('sampling is capped near one observation per second and scores refresh every five seconds',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';
  for(let at=0;at<=10000;at+=1000)tracker.sample({at,errorMs:10,eligible:true,context,clockRevision:1});
  assert.equal(tracker.sample({at:10010,errorMs:5000,eligible:true,context,clockRevision:1}),false);
  const first=refresh(tracker,10000);assert.equal(first.updated,true);
  const held=refresh(tracker,12000);assert.equal(held.updated,false);assert.equal(held.score,first.score);
  for(let at=11000;at<=15000;at+=1000)tracker.sample({at,errorMs:900,eligible:true,context,clockRevision:1});
  const due=refresh(tracker,15000);assert.equal(due.updated,true);assert.ok(due.rawScore<first.rawScore);
});

test('pause, seek, temporary clock loss and clock revision preserve the latest score and reduce confidence',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';ready(tracker,0,12000,context);
  const first=refresh(tracker,12000),level=first.lastLevel;
  const paused=refresh(tracker,13000,{playbackStatus:'paused'});
  assert.equal(paused.status,'paused');assert.equal(paused.score,first.score);assert.equal(paused.lastLevel,level);assert.equal(paused.confidence,'confident');
  const seeking=refresh(tracker,13500,{playbackStatus:'seeking'});
  assert.equal(seeking.status,'seeking');assert.equal(seeking.score,first.score);assert.equal(seeking.confidence,'confident');
  tracker.breakSample(14000);
  const stale=refresh(tracker,14000,{clockValid:false});
  assert.equal(stale.status,'playing');assert.equal(stale.score,first.score);assert.equal(stale.confidence,'confident');
  tracker.sample({at:15000,errorMs:1,eligible:true,context,clockRevision:2});
  const resumed=refresh(tracker,15000);
  assert.equal(resumed.status,'playing');assert.equal(resumed.lastLevel,level);
  assert.equal(resumed.score,first.score);assert.equal(resumed.confidence,'confident');assert.equal(resumed.metrics.measuredSeconds,0,'clock resets invalidate the old evidence window');
});

test('position fallback is usable measured evidence while diagnostics keep its precision distinction',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';
  tracker.sample({at:0,errorMs:20,eligible:true,source:'position',context,clockRevision:1});
  tracker.sample({at:1000,errorMs:20,eligible:true,source:'position',context,clockRevision:1});
  const result=refresh(tracker,1000,{rttSampleCount:10});
  assert.equal(result.updated,true);assert.equal(result.score,1);assert.equal(result.confidence,'confident');
  assert.equal(result.reason,'position-timing-estimate');assert.equal(result.metrics.positionMeasuredSeconds,1);
  assert.equal(result.metrics.presentationMeasuredSeconds,0);
});

test('recovery is gradual after a real playback problem while routine pauses do not degrade the estimate',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';
  for(let at=0;at<=10000;at+=1000)tracker.sample({at,errorMs:20,eligible:true,context,clockRevision:1});
  const clean=refresh(tracker,10000);assert.equal(clean.score,1);
  const paused=refresh(tracker,11000,{playbackStatus:'paused'});assert.equal(paused.score,1);
  for(let at=11000;at<=15000;at+=1000)tracker.sample({at,errorMs:900,eligible:true,context,clockRevision:1});
  const degraded=refresh(tracker,15000);assert.ok(degraded.score<clean.score);
  for(let at=16000;at<=20000;at+=1000)tracker.sample({at,errorMs:20,eligible:true,context,clockRevision:1});
  const recovering=refresh(tracker,20000);assert.ok(recovering.score>degraded.score&&recovering.score<1);
});

test('rolling metrics expire outside 60 seconds and active buffering records exact duration',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';ready(tracker,0,19000,context);
  assert.equal(tracker.startBuffer({at:19500,eligible:true}),true);
  assert.equal(tracker.endBuffer({at:29500}),true);
  tracker.sample({at:30000,errorMs:20,eligible:true,context,clockRevision:1});
  const afterBuffer=refresh(tracker,30000);
  assert.equal(afterBuffer.metrics.bufferingSeconds,10);
  assert.ok(afterBuffer.score<1);
  const old=tracker.metricsAt(95000);
  assert.equal(old.measuredSeconds,0);assert.equal(old.bufferingSeconds,0);
});

test('four quality bands use the existing inclusive boundaries with hysteresis',()=>{
  assert.equal(quality.level(1),'excellent');assert.equal(quality.level(.90),'excellent');
  assert.equal(quality.level(.8999),'good');assert.equal(quality.level(.75),'good');
  assert.equal(quality.level(.7499),'fair');assert.equal(quality.level(.50),'fair');
  assert.equal(quality.level(.4999),'poor');assert.equal(quality.level(undefined),undefined);
  assert.equal(quality.level(.88,'excellent'),'excellent');assert.equal(quality.level(.86,'excellent'),'good');
  assert.equal(quality.level(.77,'fair'),'fair');assert.equal(quality.level(.78,'fair'),'good');
});

test('Chrome-style startup and imperfect mixed sampling color promptly without perfect history',()=>{
  const tracker=quality.create(),context='chrome';
  assert.equal(refresh(tracker,0,{clockValid:false}).confidence,'provisional');
  tracker.sample({at:2500,errorMs:35,source:'position',eligible:true,context,clockRevision:1});
  tracker.sample({at:3500,errorMs:30,source:'presentation',eligible:true,context,clockRevision:1});
  assert.equal(refresh(tracker,3500,{rttSampleCount:2,clockAgeMs:1200}).confidence,'confident');
  for(let at=4500;at<=70000;at+=1000) {
    tracker.sample({at,errorMs:40,source:at===24000?'position':'presentation',eligible:true,context,clockRevision:1});
    const result=refresh(tracker,at,{clockAgeMs:1800,clockUncertaintyMs:150,rttSampleCount:2});
    assert.equal(result.confidence,'confident','an isolated fallback does not poison a 60-second window');
  }
});

test('Android-style clock variability and missed probes do not flicker, but prolonged loss greys',()=>{
  const tracker=quality.create(),context='android';
  tracker.sample({at:0,errorMs:45,source:'position',eligible:true,context,clockRevision:1});
  tracker.sample({at:1000,errorMs:65,source:'position',eligible:true,context,clockRevision:1});
  assert.equal(refresh(tracker,1000,{rttSampleCount:1,clockAgeMs:4300,clockUncertaintyMs:900}).confidence,'confident');
  tracker.breakSample(2000);
  assert.equal(refresh(tracker,9500,{clockValid:false}).confidence,'confident');
  assert.equal(refresh(tracker,9500,{clockValid:false}).metrics.measurementFreshnessMs,8500);
  assert.equal(refresh(tracker,15000,{clockValid:false}).confidence,'reduced');
  assert.equal(refresh(tracker,15000,{clockValid:false}).score,1);
  tracker.sample({at:16000,errorMs:70,source:'position',eligible:true,context,clockRevision:1});
  tracker.sample({at:17000,errorMs:70,source:'position',eligible:true,context,clockRevision:1});
  assert.equal(refresh(tracker,17000,{rttSampleCount:1}).confidence,'confident');
});

test('pauses retain measured ratings, then expire, without a long resume warmup',()=>{
  const tracker=quality.create(),context='paused';
  tracker.sample({at:0,errorMs:10,eligible:true,context,clockRevision:1});
  tracker.sample({at:1000,errorMs:10,eligible:true,context,clockRevision:1});
  refresh(tracker,1000);
  assert.equal(refresh(tracker,50000,{playbackStatus:'paused',clockValid:false}).confidence,'confident');
  assert.equal(refresh(tracker,122000,{playbackStatus:'paused',clockValid:false}).confidence,'reduced');
  tracker.sample({at:123000,errorMs:15,eligible:true,context,clockRevision:1});
  tracker.sample({at:124000,errorMs:15,eligible:true,context,clockRevision:1});
  assert.equal(refresh(tracker,124000).confidence,'confident');
});
