'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const quality=require('../web/sync-quality');

test('sync quality uses p95 excess presentation error and measured buffering, never jitter',()=>{
  const errors=Array.from({length:19},()=>200).concat(300);
  assert.equal(quality.percentile95(errors),200);
  const score=quality.calculate({errorsMs:errors,bufferSeconds:0});
  assert.equal(score,Math.exp(-(((200-100)/250)**2)));
  assert.equal(quality.calculate({errorsMs:errors,jitterMs:100000,bufferSeconds:0}),score);
  assert.equal(quality.calculate({errorsMs:Array(10).fill(100),bufferSeconds:0}),1);
  assert.equal(quality.calculate({errorsMs:errors,bufferSeconds:undefined}),undefined);
  assert.equal(quality.calculate({errorsMs:errors,bufferSeconds:-1}),undefined);
});

test('sync quality levels preserve the specified inclusive boundaries',()=>{
  assert.equal(quality.level(1),'excellent');assert.equal(quality.level(.90),'excellent');
  assert.equal(quality.level(.8999),'good');assert.equal(quality.level(.75),'good');
  assert.equal(quality.level(.7499),'fair');assert.equal(quality.level(.50),'fair');
  assert.equal(quality.level(.4999),'poor');assert.equal(quality.level(undefined),undefined);
});

test('tracker samples at most once per second, waits for valid clock and RTT evidence, and refreshes every five seconds',()=>{
  let at=0;const tracker=quality.create({now:()=>at}),context='room:viewer:media:stream',clockRevision=3;
  for(let i=0;i<10;i++) {
    at=i*1000;assert.equal(tracker.sample({at,errorMs:10,eligible:true,context,clockRevision}),true);
    if(i===0)assert.equal(tracker.sample({at:at+10,errorMs:500,eligible:true,context,clockRevision}),false);
  }
  const timing={rttSampleCount:4,clockValid:true,clockAgeMs:0,active:true};
  assert.deepEqual(tracker.refresh({at:9000,...timing}),{status:'unknown'});
  tracker.sample({at:10000,errorMs:10,eligible:true,context,clockRevision});
  const first=tracker.refresh({at:10000,...timing,rttSampleCount:5,jitterMs:10000});
  assert.equal(first.status,'known');assert.equal(first.updated,true);assert.equal(first.score,1);
  const held=tracker.refresh({at:12000,...timing,rttSampleCount:5});assert.equal(held.updated,false);assert.equal(held.score,first.score);
  const stale=tracker.refresh({at:14000,...timing,rttSampleCount:5,active:false});assert.deepEqual(stale,{status:'unknown'});
});

test('RTT jitter does not affect score; actual buffer duration does',()=>{
  const context='room:viewer:media:stream',tracker=quality.create();
  for(let i=0;i<10;i++)tracker.sample({at:i*1000,errorMs:0,eligible:true,context,clockRevision:1});
  tracker.sample({at:10000,errorMs:0,eligible:true,context,clockRevision:1});
  const stable=tracker.refresh({at:10000,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true,jitterMs:1});
  for(let i=11;i<=15;i++)tracker.sample({at:i*1000,errorMs:0,eligible:true,context,clockRevision:1});
  const jittered=tracker.refresh({at:15000,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true,jitterMs:100000});
  assert.equal(stable.score,1);assert.equal(jittered.score,stable.score);
  assert.equal(tracker.startBuffer({at:15001,eligible:true}),true);
  assert.equal(tracker.endBuffer({at:18001}),true);
  assert.equal(tracker.bufferedSeconds(18001),3);
  tracker.sample({at:19000,errorMs:0,eligible:true,context,clockRevision:1});
  const buffered=tracker.refresh({at:20000,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true});
  assert.equal(buffered.status,'known');assert.ok(buffered.score<stable.score);
});

test('clock revision, playback gaps and unavailable clocks clear old evidence',()=>{
  const tracker=quality.create(),context='room:viewer:media:stream';
  for(let i=0;i<10;i++)tracker.sample({at:i*1000,errorMs:1,eligible:true,context,clockRevision:1});
  assert.equal(tracker.refresh({at:10000,jitterMs:0,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true}).status,'known');
  tracker.sample({at:11000,errorMs:1,eligible:true,context,clockRevision:2});
  assert.deepEqual(tracker.refresh({at:11000,jitterMs:0,rttSampleCount:5,clockValid:false,clockAgeMs:undefined,active:true}),{status:'unknown'});
  for(let i=0;i<10;i++)tracker.sample({at:12000+i*1000,errorMs:1,eligible:true,context,clockRevision:2});
  assert.equal(tracker.refresh({at:22000,jitterMs:0,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true}).status,'known');
  tracker.sample({at:26000,errorMs:1,eligible:true,context,clockRevision:2});
  assert.deepEqual(tracker.refresh({at:26000,jitterMs:0,rttSampleCount:5,clockValid:true,clockAgeMs:0,active:true}),{status:'unknown'});
});
