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

test('initial score requires 10 sync samples, 8 measured seconds, 5 RTT samples and a reliable fresh clock',()=>{
  let at=0;const tracker=quality.create({now:()=>at}),context='room:viewer:media:stream';
  for(let i=0;i<9;i++){at=i*1000;tracker.sample({at,errorMs:0,eligible:true,context,clockRevision:1});}
  assert.equal(refresh(tracker,8000).status,'unknown');
  at=9000;tracker.sample({at,errorMs:0,eligible:true,context,clockRevision:1});
  assert.equal(refresh(tracker,9000,{rttSampleCount:4}).reason,'insufficient-clock-samples');
  assert.equal(refresh(tracker,9000,{clockValid:false}).reason,'clock-unavailable');
  assert.equal(refresh(tracker,9000,{clockUncertaintyMs:900}).reason,'clock-low-confidence');
  const first=refresh(tracker,9000);assert.equal(first.status,'playing');assert.equal(first.updated,true);assert.equal(first.score,1);
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

test('pause, normal seek, temporary clock loss and clock revision preserve the last valid rating',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';ready(tracker,0,12000,context);
  const first=refresh(tracker,12000),level=first.lastLevel;
  const paused=refresh(tracker,13000,{playbackStatus:'paused'});
  assert.equal(paused.status,'paused');assert.equal(paused.lastScore,first.score);assert.equal(paused.lastLevel,level);
  tracker.breakSample(14000);
  const stale=refresh(tracker,14000,{clockValid:false});
  assert.equal(stale.status,'stale');assert.equal(stale.lastScore,first.score);
  tracker.sample({at:15000,errorMs:1,eligible:true,context,clockRevision:2});
  const resumed=refresh(tracker,15000);
  assert.equal(resumed.status,'playing');assert.equal(resumed.lastLevel,level);
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
