'use strict';
const {install}=require('./helpers/watch-sync');
const test=require('node:test'),assert=require('node:assert/strict');
const {trials,startup,compareStarts,immediateStarts}=require('../scripts/sync-startup');
const {alarm,target}=require('../web/playback-timing');
const {Hub}=require('../server/core'),{Watch}=require('../server/watch'),{randomUUID}=require('node:crypto');
test('startup trials are reproducible, balanced within each RTT/round, and use both mode orders',()=>{
  const plan=trials(5,[20,320]);assert.deepEqual(plan,trials(5,[20,320]));assert.equal(plan.length,20);
  for(let round=1;round<=5;round++)for(const rtt of[20,320])assert.deepEqual(plan.filter(r=>r.round===round&&r.rtt===rtt).map(r=>r.mode).sort(),['controller','unit']);
  assert.ok(plan.some((r,i)=>i%2===0&&r.mode==='controller'));assert.ok(plan.some((r,i)=>i%2===0&&r.mode==='unit'));
});
test('startup metrics exclude decoded readiness probes and compare only observed matching media frames',()=>{
  const row=(media,time,extra={})=>({event:'frame',roomPaused:false,frameMediaTime:media,frameServerTime:time,presentationErrorMs:5,...extra});
  const a={entries:[row(0,100,{roomPaused:true}),row(.042,180),row(.083,222)]},b={entries:[row(.042,200),row(.083,242)]};
  assert.equal(startup(a,[]).firstFrameServerTime,180);assert.equal(compareStarts(a,b).firstCommonFrame.mediaTime,.042);
  assert.equal(compareStarts(a,b).matchingFrameDifferencesMs.p95,20);assert.equal(startup({entries:[]},[]).firstFrameServerTime,null);
});
test('scheduled targets hold nonzero positions and then interpolate from the shared deadline',()=>{
  const state={serverNow:100000,startAt:101750,state:{position:35,paused:false,duration:120}};
  assert.equal(target(state,100500),35);assert.equal(target(state,101750),35);assert.equal(target(state,102750),36);
  assert.equal(target({...state,serverNow:102000,state:{...state.state,position:35.25}},102750),36);
});
test('start alarms recheck clock refinements, reject stale timers, and stop on clock loss',()=>{
  let time=1000;const timers=[],fired=[];
  const a=alarm({now:()=>time,set:(callback,delay)=>{timers.push({callback,delay});return timers.length;},clear:()=>{}});
  a.arm('first',2000,()=>fired.push('first'));assert.equal(timers[0].delay,1000);
  a.arm('first',2000,()=>fired.push('duplicate'));assert.equal(timers.length,1);
  time=1998;timers[0].callback();assert.equal(timers[1].delay,2);
  a.cancel();time=2001;timers[1].callback();assert.deepEqual(fired,[]);
  a.arm('new',2100,()=>fired.push('new'));time=undefined;timers[2].callback();time=2200;timers[2].callback();assert.deepEqual(fired,[]);
  a.arm('current',2250,()=>fired.push('current'));time=2251;timers.at(-1).callback();assert.deepEqual(fired,['current']);
  timers.at(-1).callback();assert.deepEqual(fired,['current'],'a completed alarm is one-shot');
});
test('a superseded native play promise cannot mark replacement media ready or autoplay-blocked',async()=>{
  for(const rejected of[false,true]) {
    let resolve,reject;const play=new Promise((a,b)=>{resolve=a;reject=b;});
    const ctx={state:{mediaUrl:'fixture',mediaVersion:'old',streamVersion:'old-stream',state:{paused:false,volume:50,muted:false}},
      selected:'room',mediaSource:'old-source',readyVersion:undefined,playbackClock:{read:()=>({valid:true})},expected:()=>0,
      hlsPreparationUntil:0,hlsTimelinePending:false,syncSeekPending:false,probing:false,playbackError:'',hlsNetworkFailure:undefined,autoplayBlocked:false,
      performance:{now:()=>0},document:{visibilityState:'visible'},syncCorrectionMode:'speed',pauseAlarm:{cancel(){}},driftCorrection:require('../web/playback-timing').correction(),startKey:()=> 'fixture',
      presentationTiming:require('../web/playback-timing').presentation(),uburoomPlayback:require('../web/playback-policy'),playerWaiting:false,
      video:{readyState:4,currentTime:0,seeking:false,paused:true,playbackRate:1,buffered:{length:0},play:()=>play},
      renderTransport(){},checkVideoFrames(){}};
    await install(ctx);
    const pending=ctx.synchronize();ctx.state.mediaVersion='replacement';ctx.state.streamVersion='replacement-stream';ctx.mediaSource='replacement-source';
    if(rejected)reject(Object.assign(new Error('Old play blocked'),{name:'NotAllowedError'}));else resolve();
    await pending;assert.equal(ctx.readyVersion,undefined);assert.equal(ctx.autoplayBlocked,false);
  }
});
test('scheduled preparation stays paused on clock loss and fences stale or expired callbacks',async()=>{
  let key='old',callback,cancelled=0,plays=0,now=0;const events=[];let clock={valid:false};
  const ctx={state:{startAt:2000,serverNow:0,mediaUrl:'fixture',state:{paused:false,duration:60,volume:50,muted:false}},mediaSource:'fixture',
    video:{currentTime:.1,readyState:4,seeking:false,paused:false,buffered:{length:0},playbackRate:1.04,pause(){this.paused=true;},async play(){plays++;this.paused=false;}},
    startKey:()=>key,startAlarm:{cancel:()=>{cancelled++;},arm:(_,at,fire)=>{assert.equal(at,2000);callback=fire;}},
    expected:()=>0,diagnosticSample:e=>events.push(e),performance:{now:()=>now},receivedAt:0,playbackClock:{read:()=>clock}};
  const sync=await install(ctx);
  await sync.synchronize();assert.equal(cancelled,1);assert.equal(callback,undefined);assert.equal(ctx.video.playbackRate,1);
  assert.equal(ctx.video.currentTime,0);assert.deepEqual(events,['start-prepare']);
  clock={valid:true,serverTime:1000};await sync.synchronize();assert.deepEqual(events,['start-prepare'],'paused alignment happens once per start');
  key='replacement';callback();assert.equal(plays,0);key='old';now=4000;callback();assert.equal(plays,0);
  now=0;clock={valid:true,serverTime:2001};callback();assert.equal(plays,1);assert.deepEqual(events,['start-prepare','start-timer']);
});
test('sync owner resets replacement state and closes its timer and scheduled alarms',async()=>{
  let interval,cleared,starts=0,pauses=0;
  const ctx={video:{playbackRate:1.04},repeat:(callback,delay)=>{assert.equal(delay,500);interval=callback;return 17;},
    cancelRepeat:id=>{cleared=id;},startAlarm:{cancel:()=>starts++},pauseAlarm:{cancel:()=>pauses++}};
  const sync=await install(ctx);
  assert.equal(typeof interval,'function');interval();
  sync.prepare({until:10000,timeline:true});
  sync.reset();assert.equal(sync.timelinePending,false);assert.equal(sync.preparationUntil,0);assert.equal(sync.seekPending,false);
  assert.equal(ctx.video.playbackRate,1);assert.equal(starts,1);assert.equal(pauses,1);
  sync.close();assert.equal(cleared,17);assert.equal(starts,2);assert.equal(pauses,2);
});
function roomFixture() {
  const hub=new Hub({ownerId:'host',guildId:'fixture',channels:['channel']},[]);
  hub.access={refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  const watch=new Watch(hub,{stop:async()=>{}},{kind:'demo',format:'file',duration:120});
  const actor=userId=>({userId,name:userId,surface:'web',guildId:'fixture',channelId:'channel'}),host=actor('host'),guest=actor('guest');
  const room=watch.rooms.get(watch.create(host)),h=randomUUID(),g=randomUUID();watch.snapshot(room,host,h);watch.snapshot(room,guest,g);
  const dispatch=async(action,args)=>{const result=await hub.dispatch(host,{roomId:room.s.roomId,action,args:action==='media.load'?{quality:'direct',...args}:args});assert.equal(result.status,'applied',action);return result;};
  return {hub,watch,room,host,guest,h,g,dispatch};
}
test('readiness schedules one initial start without advancing early; ordinary commands supersede it',async()=>{
  const f=roomFixture();try{
    await f.dispatch('media.load',{mediaId:'demo'});await f.watch.ready(f.room,f.host,f.h,f.room.mediaVersion,true);
    assert.equal(f.room.startAt,undefined);await f.watch.ready(f.room,f.guest,f.g,f.room.mediaVersion,true);
    const deadline=f.room.startAt;assert.ok(deadline>Date.now()+1500);assert.equal(f.room.s.state.paused,false);
    assert.equal(f.watch.position(f.room,deadline-500),0);assert.equal(f.watch.position(f.room,deadline+1000),1);
    // Unrelated picture commands cannot accidentally advance the scheduled anchor.
    await f.dispatch('zoom.set',{value:1.2});assert.equal(f.watch.position(f.room,deadline-1),0);
    const late=randomUUID();f.watch.snapshot(f.room,f.guest,late);await f.watch.ready(f.room,f.guest,late,f.room.mediaVersion,false);
    assert.equal(f.room.startAt,deadline,'a late unready viewer cannot delay the group');
    await f.dispatch('media.pause');assert.equal(f.room.startAt,undefined);assert.equal(f.room.s.state.paused,true);
    await f.dispatch('media.play');assert.ok(f.room.startAt>=Date.now()+390,'ordinary resume is scheduled');
    await f.dispatch('media.load',{mediaId:'demo'});assert.equal(f.room.startAt,undefined,'replacement cannot inherit the old start');
  }finally{f.watch.close();}
});
test('explicit initial pause survives readiness; seeking cancels a pending scheduled start',async()=>{
  const f=roomFixture();try{
    await f.dispatch('media.load',{mediaId:'demo'});await f.dispatch('media.pause');
    await f.watch.ready(f.room,f.host,f.h,f.room.mediaVersion,true);await f.watch.ready(f.room,f.guest,f.g,f.room.mediaVersion,true);
    assert.equal(f.room.startAt,undefined);assert.equal(f.room.s.state.paused,true);
    await f.dispatch('media.play');assert.ok(f.room.startAt>Date.now());
    await f.dispatch('media.seek.absolute',{seconds:35});assert.equal(f.room.startAt,undefined);assert.ok(f.watch.position(f.room)>=35);
  }finally{f.watch.close();}
});
test('immediate comparison removes only the fixture autoplay deadline and retains validation',async()=>{
  const f=roomFixture();try {
    immediateStarts(f.watch);await f.dispatch('media.load',{mediaId:'demo'});
    await f.watch.ready(f.room,f.host,f.h,f.room.mediaVersion,true);await f.watch.ready(f.room,f.guest,f.g,f.room.mediaVersion,true);
    assert.equal(f.room.startAt,undefined);assert.equal(f.room.s.state.paused,false);
    const denied=await f.watch.execute(f.room,{action:'media.pause'},f.host,()=>false);
    assert.equal(denied.status,'unavailable');assert.equal(f.room.s.state.paused,false);
  }finally{f.watch.close();}
});


test('startup and seek buffering consume the start lead; late readiness uses only the delivery margin',async(t)=>{
  let now=100000;
  t.mock.method(Date,'now',()=>now);
  const f=roomFixture();
  const ready=viewer=>f.watch.ready(f.room,viewer===f.h?f.host:f.guest,viewer,f.room.mediaVersion,true,f.room.readinessVersion);
  try {
    await f.dispatch('media.load',{mediaId:'demo'});
    const startup=f.room.readinessStartAt;
    assert.equal(startup,now+1750);
    now+=1000; await ready(f.h); await ready(f.g);
    assert.equal(f.room.startAt,startup,'startup buffering overlaps the countdown');
    await f.dispatch('media.seek.relative',{seconds:15});
    const seek=f.room.readinessStartAt;
    now+=1200; await ready(f.h); await ready(f.g);
    assert.equal(f.room.startAt,seek,'buffered seek retains its original deadline');
    assert.equal(f.watch.position(f.room,seek-1),15);
    await f.dispatch('media.seek.absolute',{seconds:40});
    const slow=f.room.readinessStartAt;
    now+=2500; await ready(f.h);
    assert.equal(f.room.s.state.paused,true,'expiry alone cannot release unready viewers');
    assert.equal(f.watch.position(f.room),40);
    await ready(f.g);
    assert.ok(f.room.startAt>slow);
    assert.equal(f.room.startAt,now+400,'slow buffering adds a delivery margin, not a second full lead');
    await f.dispatch('media.seek.start'); await f.dispatch('media.pause');
    assert.equal(f.room.readinessStartAt,undefined);
    now+=2000; await ready(f.h); await ready(f.g);
    assert.equal(f.room.s.state.paused,true);
    await f.dispatch('media.play');
    assert.equal(f.room.startAt,now+1750,'deliberate pause cancels the old countdown');
  } finally {f.watch.close();}
});
