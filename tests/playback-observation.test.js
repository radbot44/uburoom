'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {PlaybackTracking}=require('../server/playback-tracking');
const policy=require('../web/playback-policy');
const source=fs.readFileSync(require('node:path').join(__dirname,'../web/watch.js'),'utf8');
function client() {
  let mono=1000,wall=100000;const sent=[];
  const clock=policy.observationClock?.();clock?.update('epoch',100000,1000,1000);
  const ctx={observationPending:false,observationQueued:false,observing:true,selected:'room',state:{mediaUrl:'url',streamVersion:'stream',mediaVersion:'media',observationEpoch:'epoch'},mediaSource:'url',
    playbackError:'',autoplayBlocked:false,probing:false,playerWaiting:false,viewerId:'viewer',observationSequence:0,observationBreak:0,videoFrames:30,
    performance:{now:()=>mono},Date:{now:()=>wall},offset:0,observationClock:clock,uburoomPlayback:policy,
    video:{currentTime:0,playbackRate:1,readyState:4,requestVideoFrameCallback(){},getVideoPlaybackQuality:()=>({totalVideoFrames:100,droppedVideoFrames:0})},
    diagnostics:{record(){}},api:async(_,data)=>{sent.push(data);return {credit:{reason:'baseline',creditedSeconds:0}};}};
  vm.runInNewContext(source.slice(source.indexOf('async function reportObservation('),source.indexOf("for (const event of ['playing'",source.indexOf('async function reportObservation('))),ctx);
  return {ctx,sent,tick(ms=1000,wallMs=ms){mono+=ms;wall+=wallMs;clock?.update('epoch',100000+mono-1000,mono,mono);ctx.video.currentTime+=ms/1000;ctx.videoFrames+=30;}};
}
test('observations keep monotonic duration through client wall steps and poll offset jitter',async()=>{
  const f=client();await f.ctx.reportObservation();f.tick(1000,5745);f.ctx.offset=-2300;await f.ctx.reportObservation();
  assert.equal(f.sent[1].observedAt-f.sent[0].observedAt,1000);
  let resolveFlight;
  f.ctx.api=(_,data)=>new Promise(r=>{f.sent.push(data);resolveFlight=r;});
  const first=f.ctx.reportObservation();
  assert.equal(f.ctx.observationPending,true);
  f.ctx.video.ended=true;
  f.ctx.reportObservation();
  assert.equal(f.ctx.observationQueued,true);
  assert.equal(f.sent.length,3);
  resolveFlight({credit:{reason:'baseline'}});
  await first;
  await new Promise(r=>setTimeout(r,10));
  assert.equal(f.sent.length,4);
  assert.equal(f.sent[3].state,'ended','in-flight ended observation drained after pending request');
  assert.equal(f.ctx.observationQueued,false);
});
test('observations use advancing frame callbacks when native total-minus-dropped is flat',async()=>{
  const f=client();await f.ctx.reportObservation();f.tick();await f.ctx.reportObservation();
  assert.equal(f.sent[1].frames-f.sent[0].frames,30);
});
test('frozen supported frame callbacks cannot be replaced with advancing native counters',async()=>{
  const f=client();await f.ctx.reportObservation();f.tick();f.ctx.videoFrames=30;f.ctx.video.getVideoPlaybackQuality=()=>({totalVideoFrames:130,droppedVideoFrames:0});await f.ctx.reportObservation();
  assert.equal(f.sent[1].frames,f.sent[0].frames);
});
test('client clock steps in both directions retain exactly observed decoded credit',async()=>{
  const f=client(),tracking=new PlaybackTracking(undefined,()=>f.sent.at(-1)?.sampleAt+99000||100000);
  const room={s:{roomId:'room'},mediaVersion:'media',media:{id:'fixture',duration:100}},viewer={userId:'user',observationEpoch:'epoch',streamVersion:'stream',mediaVersion:'media',media:{kind:'demo'}};
  try {
    for(const wallStep of [0,5745,-9000,1000]){
      if(f.sent.length)f.tick(1000,wallStep);
      await f.ctx.reportObservation();tracking.observe(room,viewer,'tab',f.sent.at(-1));
    }
    assert.equal(viewer.tracking.record.watchedSeconds,3);
    assert.equal(viewer.tracking.record.sourceSeconds,3);
  } finally {tracking.close();}
});
test('observation clock ignores bounded poll jitter and refuses slow or stale clock evidence',()=>{
  const clock=policy.observationClock();const revision=clock.update('a',100000,0,100);
  assert.equal(clock.sample(1100),101050);
  assert.equal(clock.update('a',100900,1000,1600),revision,'600 ms RTT cannot perturb existing duration');
  assert.equal(clock.sample(2100),102050);
  clock.update('a',999999,2000,3200);assert.equal(clock.sample(4601),undefined,'slow poll does not refresh evidence');
  assert.equal(clock.sample(1500),undefined,'monotonic time cannot run backwards');
  clock.update('b',103000,3000,4200);assert.equal(clock.sample(4200),undefined,'new epoch cannot inherit old anchor');
});
test('server clock steps rebase with a discontinuity and never backfill the boundary',()=>{
  for(const step of [-4745,4745]){
    const clock=policy.observationClock(),revision=clock.update('a',100000,0,0);
    assert.equal(clock.sample(1000),101000);
    assert.ok(clock.update('a',101000+step,1000,1000)>revision);
    assert.equal(clock.sample(1000),101000+step);
    assert.equal(clock.update('a',102000+step,2000,2000),revision+1);
    assert.equal(clock.sample(2000),102000+step);
  }
});
test('native frame fallback requires absent callback support and retains resets/freezes',()=>{
  let frames=30;const video={getVideoPlaybackQuality:()=>({totalVideoFrames:frames,droppedVideoFrames:10})};
  assert.equal(policy.observationFrames(video,999),20);frames=10;assert.equal(policy.observationFrames(video,999),0);
  assert.equal(policy.observationFrames({},999),0,'no decoder evidence cannot earn credit');
});
test('missing fresh clock evidence suppresses reports with a classified local reason',async()=>{
  const f=client(),rows=[];f.ctx.diagnostics.record=(event,fields)=>rows.push({event,...fields});
  f.ctx.observationClock=policy.observationClock();await f.ctx.reportObservation();
  assert.equal(f.sent.length,0);assert.equal(rows[0].creditReason,'clock-unavailable');
});
