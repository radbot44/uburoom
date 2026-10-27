'use strict';
const {install}=require('./helpers/watch-sync');
const test=require('node:test'),assert=require('node:assert/strict');
const {correction,presentation}=require('../web/playback-timing');
const {summarize}=require('../scripts/sync-report');

function fixture() {
  const policy=correction();let now=0;
  return {policy,step:(ms=500,extra={})=>policy.update({now:now+=ms,error:.3,eligible:true,context:'one',...extra})};
}

test('small drift stays at native speed at every required cadence and within clock uncertainty',()=>{
  for(const fps of[24000/1001,24,25,30,50,60]) {
    const f=fixture();for(let i=0;i<100;i++)assert.equal(f.step(500,{error:.04,frameSeconds:1/fps,uncertaintyMs:10}),1);
  }
  const f=fixture();for(let i=0;i<20;i++)assert.equal(f.step(500,{error:.29,uncertaintyMs:250}),1);
});

test('persistent drift uses bounded subtle bursts with a quiet interval and hysteresis',()=>{
  const f=fixture();
  for(let i=0;i<2;i++)assert.equal(f.step(),1);
  assert.equal(f.step(),1.025);
  for(let i=0;i<19;i++)assert.equal(f.step(),1.025);
  assert.equal(f.step(),1,'ten second limit');
  for(let i=0;i<9;i++)assert.equal(f.step(),1,'quiet interval');
  assert.equal(f.step(),1,'fresh persistence required');
  assert.equal(f.step(),1);
  assert.equal(f.step(),1.025);
  assert.equal(f.step(500,{error:.12}),1.01,'proportional taper as error shrinks');
  assert.equal(f.step(500,{error:.05}),1.005,'hysteresis avoids threshold chatter');
  assert.equal(f.step(500,{error:.02}),1,'clean exit inside deadband');
});

test('transient/sign-changing drift never accumulates evidence; interrupted playback cancels a burst',()=>{
  const f=fixture();for(let i=0;i<20;i++)assert.equal(f.step(500,{error:i%2?.3:-.3}),1);
  for(const extra of[{eligible:false},{context:'replacement'},{error:-.3},{error:NaN},{error:1}]) {
    const g=fixture();for(let i=0;i<3;i++)g.step();assert.equal(g.step(500,extra),1);
  }
  const g=fixture();for(let i=0;i<3;i++)g.step();assert.equal(g.step(4000),1,'sleep cannot continue a burst');
  g.policy.reset();assert.equal(g.step(),1);
  const ahead=fixture();for(let i=0;i<2;i++)ahead.step(500,{error:-.3});
  assert.equal(ahead.step(500,{error:-.3}),.975);
  assert.equal(ahead.step(500,{error:-.05}),.995);
});

test('cadence estimate needs contiguous frames and resets across source/seek boundaries',()=>{
  for(const fps of[24000/1001,24,25,30,50,60]) {
    const p=presentation();for(let i=0;i<9;i++)p.frame(i*1000/fps,{mediaTime:i/fps,expectedDisplayTime:i*1000/fps,presentedFrames:i});
    assert.ok(Math.abs(p.cadence()-1/fps)<1e-8);p.reset();assert.equal(p.cadence(),0);
    for(let i=0;i<20;i++)p.frame(i*1000/fps,{mediaTime:i/fps,expectedDisplayTime:i*1000/fps,presentedFrames:i*2});
    assert.equal(p.cadence(),0,'missed callbacks cannot establish source cadence');
  }
});

test('rate exposure uses observed time separately from sparse frame counts and unknown gaps',()=>{
  const r=summarize({entries:[{ms:0,rate:1},{ms:250,rate:.995},{ms:750,rate:.995},{ms:1000,rate:1},{ms:4000,rate:1}]});
  assert.equal(r.observedRateMs,1000);assert.equal(r.nonUnitRateMs,750);assert.equal(r.unknownRateMs,3000);
});

test('pause, buffering, seek, teardown, offline and hidden events immediately restore native speed',async()=>{
  const f=fixture();for(let i=0;i<3;i++)f.step();
  const ctx={driftCorrection:f.policy,video:{playbackRate:1.005},document:{hidden:true}};
  const sync=await install(ctx);
  for(const event of ['pause','waiting','seeking','emptied','offline','pagehide','visibilitychange']) {
    ctx.video.playbackRate=1.005;sync.event(event);assert.equal(ctx.video.playbackRate,1,event);assert.equal(f.step(),1,event+' cancels persistence');
  }
});

test('correction runner retains invalid presentation segments without inventing skew percentiles',()=>{
  const {compareTrial}=require('../scripts/sync-startup');
  const log={entries:[0,1,2].map(i=>({event:'frame',room:1,media:1,clockRevision:1,frameMediaTime:i/24,
    frameServerTime:1000+(i===2?20:i*40),clockValid:true,clockUncertaintyMs:10}))};
  const r=compareTrial(log,log);assert.match(r.unavailable,/Presentation timestamps regressed/);
  assert.equal(r.healthySkewMs,undefined);assert.equal(r.viewers[0].frames,3);
  assert.throws(()=>compareTrial({entries:[]},log),/unavailable/,'unrelated fixture errors still fail');
});

test('default uses proportional drift correction with persistence and recovery guards',async()=>{
  let now=0;
  const ctx={state:{mediaUrl:'fixture',state:{paused:false,volume:50,muted:false}},expected:()=>10.3,
    playbackClock:{read:()=>({valid:true,clockUncertaintyMs:12})},startKey:()=> 'fixture',
    driftCorrection:correction(),presentationTiming:presentation(),syncCorrectionMode:'speed',pauseAlarm:{cancel(){}},performance:{now:()=>now},document:{visibilityState:'visible'},
    video:{currentTime:10,readyState:4,seeking:false,paused:false,playbackRate:1,buffered:{length:1,start:()=>0,end:()=>40}},
    hlsPreparationUntil:0,hlsTimelinePending:false,syncSeekPending:false,uburoomPlayback:require('../web/playback-policy'),playerWaiting:false,probing:false,playbackError:'',hlsNetworkFailure:undefined,
    renderTransport(){},checkVideoFrames(){}};
  await install(ctx);
  await ctx.synchronize();assert.equal(ctx.video.playbackRate,1,'waits for sustained drift before adjusting speed');
  now=500;await ctx.synchronize();assert.equal(ctx.video.playbackRate,1);
  now=1000;await ctx.synchronize();assert.equal(ctx.video.playbackRate,1.025,'applies proportional speed adjustment');
  ctx.video.currentTime=10.25;now=1500;await ctx.synchronize();assert.equal(ctx.video.playbackRate,1.005,'tapers rate smoothly as viewer catches up');
  ctx.playerWaiting=true;now=2000;await ctx.synchronize();assert.equal(ctx.video.playbackRate,1);
  ctx.playerWaiting=false;ctx.document.visibilityState='hidden';now=2500;await ctx.synchronize();assert.equal(ctx.video.playbackRate,1);
});