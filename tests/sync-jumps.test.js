'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const {jumpCorrection,correction,precisionCorrection,presentation} = require('../web/playback-timing');
const {create} = require('../web/playback-diagnostics');
const source = fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8');
function policyFixture() {
  const policy=jumpCorrection();
  return {policy,update:(now,extra={})=>policy.update({now,error:.35,eligible:true,context:'room',uncertaintyMs:10,
    buffered:true,settled:true,frames:100,position:10,...extra})};
}
test('jumps require persistent same-direction resolvable drift and buffered decoded playback',()=>{
  const f=policyFixture();
  assert.equal(f.update(0),false);assert.equal(f.update(999),false);assert.equal(f.update(1000),true);
  for(const extra of [{error:.249},{error:.651},{error:NaN},{eligible:false},{buffered:false},{frames:undefined},{frames:0},
    {uncertaintyMs:51},{uncertaintyMs:undefined},{uncertaintyMs:-1}]) {
    f.policy.reset();assert.equal(f.update(0,extra),false);assert.equal(f.update(1000,extra),false);
    assert.equal(f.update(1500),false,'a rejected sample cannot contribute persistence');
    assert.equal(f.update(2500),true);
  }
  f.policy.reset();f.update(0);assert.equal(f.update(500,{error:-.35}),false);
  assert.equal(f.update(1499,{error:-.35}),false);assert.equal(f.update(1500,{error:-.35}),true);
  f.policy.reset();f.update(0);assert.equal(f.update(2000),false,'unobserved time is not persistence');
  assert.equal(f.update(3000),true);
});
test('jump cooldown starts after decoded recovery and survives interruptions and missed samples',()=>{
  const f=policyFixture();
  f.update(0);assert.equal(f.update(1000),true);
  f.policy.committed({frames:100,target:10,context:'room'});
  f.policy.interrupt();
  assert.equal(f.update(5000,{frames:102,settled:false}),false,'seeking/refill is still pending');
  assert.equal(f.update(5500,{frames:100}),false,'playing alone is not decoded evidence');
  assert.equal(f.update(6000,{frames:101}),false,'require advancing decoded frames');
  assert.equal(f.update(6500,{frames:102,position:8}),false,'old presentation cannot complete the new target');
  assert.equal(f.update(7000,{frames:102}),false,'confirmed recovery starts quiet period');
  f.policy.interrupt();
  assert.equal(f.update(14000,{frames:130}),false,'missing samples cannot clear cooldown');
  assert.equal(f.update(14999,{frames:140}),false);
  assert.equal(f.update(15000,{frames:150}),false,'collect fresh evidence after cooldown');
  assert.equal(f.update(16000,{frames:170}),true);
  f.policy.committed({frames:170,target:10,context:'room'});
  assert.equal(f.update(16500,{context:'replacement'}),false);
  assert.equal(f.update(17500,{context:'replacement'}),true,'new source has independent evidence');
});
test('unconfirmed jump and missing frame counters cannot cause a seek loop',()=>{
  const f=policyFixture();
  f.policy.committed({frames:undefined,target:10,context:'room'});
  for(let now=0;now<30000;now+=500)assert.equal(f.update(now,{frames:200}),false);
  f.policy.reset();assert.equal(f.update(30000),false);assert.equal(f.update(31000),true);
});
function playerFixture() {
  let now=0,frames=100,position=10,target=10.35,ranges=[[0,60]];const seeks=[],events=[];
  const ctx={selected:'room',mediaSource:'fixture',readyVersion:'m',state:{mediaUrl:'fixture',mediaVersion:'m',streamVersion:'s',epoch:'e',state:{duration:60,paused:false,volume:50,muted:false}},
    syncCorrectionMode:'jumps',jumpDriftCorrection:jumpCorrection(),driftCorrection:correction(),precisionDriftCorrection:precisionCorrection(),
    // Neither fixture-only candidate may override the user's normal-speed mode.
    precisionCorrectionEnabled:true,gentleCorrectionEnabled:true,
    expected:()=>target,startKey:()=> 'fixture',performance:{now:()=>now},document:{visibilityState:'visible'},
    playbackClock:{read:()=>({valid:true,clockUncertaintyMs:10})},presentationTiming:presentation(),decodedFrames:()=>frames,
    uburoomPlayback:require('../web/playback-policy'),pauseAlarm:{cancel(){}},
    video:{readyState:4,seeking:false,paused:false,playbackRate:1.04,duration:60,pause(){this.paused=true;},async play(){this.paused=false;},
      buffered:{get length(){return ranges.length;},start:i=>ranges[i][0],end:i=>ranges[i][1]}},
    probing:false,playbackError:'',playerWaiting:false,autoplayBlocked:false,hlsTimelinePending:false,hlsPreparationUntil:0,
    hlsNetworkFailure:undefined,syncSeekPending:false,diagnosticSample:(event,data)=>events.push({event,...data}),renderTransport(){},checkVideoFrames(){}};
  Object.defineProperty(ctx.video,'currentTime',{get:()=>position,set:value=>{position=value;seeks.push(value);ctx.video.seeking=true;}});
  vm.runInNewContext(source.slice(source.indexOf('async function synchronize('),source.indexOf('function applyState(')),ctx);
  return {ctx,seeks,events,step:async(time,extra={})=>{
    now=time;frames=extra.frames??frames;target=extra.target??target;position=extra.position??position;ranges=extra.ranges??ranges;
    await ctx.synchronize();
  }};
}
test('jump mode uses guarded local alignment at normal speed, cooldown, and independent large recovery',async()=>{
  const f=playerFixture();await f.step(0);assert.equal(f.ctx.video.playbackRate,1);
  await f.step(500);assert.equal(f.seeks.length,0);await f.step(1000);assert.deepEqual(f.seeks,[10.35]);
  assert.equal(f.events[0].event,'sync-jump');assert.ok(Math.abs(f.events[0].seekDeltaMs-350)<.001);
  f.ctx.jumpDriftCorrection.interrupt();f.ctx.video.seeking=false;
  await f.step(1500,{frames:102,position:10.5,target:10.85});
  for(let now=2000;now<=9000;now+=500)await f.step(now,{frames:120});
  assert.equal(f.seeks.length,1,'seek events cannot erase quiet time');
  await f.step(9500);await f.step(10500);assert.equal(f.seeks.length,2);
  f.ctx.video.seeking=false;await f.step(10750,{frames:122,position:10.9,target:10.9});f.ctx.playerWaiting=true;
  await f.step(11000,{target:30,ranges:[]});assert.equal(f.seeks.length,3,'large-error recovery can supersede moderate cooldown');
  await f.step(11500,{target:31});assert.equal(f.seeks.length,3,'in-flight unbuffered seek remains guarded');
  assert.equal(f.ctx.video.playbackRate,1);
});
test('moderate jumps refuse holes, hidden/uncertain clocks, pauses and readiness holds',async()=>{
  for(const change of [f=>{f.ctx.document.visibilityState='hidden';},f=>{f.ctx.playerWaiting=true;},
    f=>{f.ctx.playbackClock.read=()=>({valid:false});},f=>{f.ctx.playbackClock.read=()=>({valid:true,clockUncertaintyMs:80});},
    f=>{f.ctx.state.waitingForReady=true;f.ctx.state.state.paused=true;}]) {
    const f=playerFixture();change(f);await f.step(0);await f.step(1000);assert.equal(f.seeks.length,0);assert.equal(f.ctx.video.playbackRate,1);
  }
  const f=playerFixture();
  await f.step(0,{target:9.65,ranges:[[10,40]]});await f.step(1000);
  assert.equal(f.seeks.length,0,'destination must be buffered even when current playback is healthy');
});
test('personal preference survives reload, isolates accounts, immediately resets rate, and reports storage failure',()=>{
  const elements=new Map(),data=new Map();let resets=0;
  const ctx={me:{account:{id:'one'}},syncCorrectionMode:'speed',syncPreferenceStored:true,syncPreferenceKey:undefined,
    $:id=>{if(!elements.has(id))elements.set(id,{addEventListener(){}});return elements.get(id);},
    localStorage:{getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value)},
    jumpDriftCorrection:{reset:()=>resets++},resetDriftCorrection:()=>{ctx.video.playbackRate=1;},video:{playbackRate:1.04},diagnosticSample(){}};
  vm.runInNewContext(source.slice(source.indexOf('function renderSyncPreference('),source.indexOf('function renderAccount(')),ctx);
  ctx.loadSyncPreference();assert.equal(ctx.syncCorrectionMode,'speed');ctx.setSyncPreference('jumps');
  assert.equal(ctx.video.playbackRate,1);assert.equal(data.get('uburoom.syncCorrection.one'),'jumps');
  ctx.syncPreferenceKey=undefined;ctx.loadSyncPreference();assert.equal(ctx.syncCorrectionMode,'jumps');
  ctx.me.account.id='two';ctx.loadSyncPreference();assert.equal(ctx.syncCorrectionMode,'speed');
  ctx.me.account.id='one';ctx.loadSyncPreference();assert.equal(ctx.syncCorrectionMode,'jumps');
  const before=resets;ctx.setSyncPreference('invalid');assert.equal(resets,before);
  ctx.localStorage.setItem=()=>{throw new Error('Storage disabled');};ctx.setSyncPreference('speed');
  assert.equal(ctx.syncCorrectionMode,'speed');assert.match(elements.get('sync-correction-hint').textContent,/This tab only/);
});
test('jump diagnostics retain signed seek cost and mode without arbitrary fields',()=>{
  const log=create();log.record('sync-jump',{syncMode:'jumps',seekDeltaMs:-350,privateId:'secret'});
  const row=log.snapshot().entries.at(-1);assert.equal(row.seekDeltaMs,-350);assert.equal(row.syncMode,'jumps');
  assert.equal(row.privateId,undefined);
});
