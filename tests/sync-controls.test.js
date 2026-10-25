'use strict';
const {install}=require('./helpers/watch-sync');
const test = require('node:test'), assert = require('node:assert/strict');
const {randomUUID} = require('node:crypto');
const {Hub} = require('../server/core'), {Watch} = require('../server/watch');
const {target, precisionCorrection} = require('../web/playback-timing');

function fixture(t) {
  let now = 100000, mono = 1000;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(performance, 'now', () => mono);
  const hub = new Hub({ownerId:'host',guildId:'guild',channels:['channel']}, []);
  hub.access = {isMember:()=>true,refresh:async()=>true,options:()=>({available:true})};
  const watch = new Watch(hub, {stop:async()=>{}}, {kind:'demo',format:'file',duration:120});
  t.after(() => watch.close());
  const host = {userId:'host',name:'Host',surface:'web',guildId:'guild',channelId:'channel'}, guest = {...host,userId:'guest',name:'Guest'};
  const room = watch.rooms.get(watch.create(host)), h = randomUUID(), g = randomUUID();
  watch.snapshot(room, host, h); watch.snapshot(room, guest, g);
  const dispatch = (action,args,actor=host) => hub.dispatch(actor,{roomId:room.s.roomId,action,args});
  const ready = (viewer,value=true) => watch.ready(room,viewer===h?host:guest,viewer,room.mediaVersion,value,room.readinessVersion);
  const advance = ms => { now += ms; mono += ms; for (const viewer of room.viewers.values()) viewer.at = now; watch.refresh(room); };
  const load = () => dispatch('media.load',{mediaId:'demo',quality:'direct'});
  return {watch,room,host,guest,h,g,dispatch,ready,advance,load,now:()=>now,mono:()=>mono};
}

test('a durable room holds an ended player until verified advancement, while an explicit restart can play', async () => {
  let plays = 0, targetPosition = 60;
  const ctx = {
    state:{durable:true,mediaUrl:'fixture',mediaVersion:'one',state:{duration:60,paused:false,volume:50,muted:false}},
    mediaSource:'fixture',selected:'room',expected:()=>targetPosition,
    video:{ended:true,readyState:4,currentTime:60,paused:true,seeking:false,playbackRate:1,buffered:{length:0},
      async play(){plays++;this.paused=false;},pause(){this.paused=true;}},
    playbackClock:{read:()=>({valid:true})}
  };
  await install(ctx);
  await ctx.synchronize(); await ctx.synchronize();
  assert.equal(plays,0,'native play on an ended element would restart the old occurrence');
  assert.equal(ctx.video.currentTime,60);
  targetPosition = 0;
  await ctx.synchronize();
  assert.equal(ctx.video.currentTime,0,'a shared restart still aligns the player');
  assert.equal(plays,1);
});

test('pause and resume share deadlines, project the pause target, and supersede pending controls', async t => {
  const f = fixture(t); await f.load(); await f.ready(f.h); await f.ready(f.g); f.advance(2000);
  await f.dispatch('media.pause');
  const at = f.room.pauseAt, before = f.watch.position(f.room);
  assert.equal(at,f.now()+400); assert.equal(f.room.s.state.paused,false);
  const snapshot = f.watch.snapshot(f.room,f.host,f.h);
  assert.equal(target(snapshot,at+1000),before+.4);
  f.advance(200); assert.equal(f.watch.position(f.room),before+.2);
  f.advance(200); assert.equal(f.room.s.state.paused,true);
  assert.equal(f.watch.position(f.room),before+.4);
  await f.dispatch('media.play'); assert.equal(f.room.startAt,f.now()+400);
  f.advance(200); assert.equal(f.watch.position(f.room),before+.4);
  await f.dispatch('media.pause'); assert.equal(f.room.startAt,undefined); assert.equal(f.room.s.state.paused,true);
  await f.dispatch('media.play'); f.advance(500);
  await f.dispatch('media.pause'); f.advance(100); await f.dispatch('media.toggle');
  assert.equal(f.room.pauseAt,undefined); assert.equal(f.room.startAt,undefined);
  assert.equal(f.room.s.state.paused,false,'toggle cancels a pending pause without freezing healthy playback');
});

test('control lead uses fresh bounded server round trips and discards stale evidence', t => {
  const f = fixture(t);
  f.room.viewers.get(f.h).watchSocket = {watchRtts:[{at:f.mono(),ms:550}]};
  assert.equal(f.watch.controlLead(f.room),650);
  f.room.viewers.get(f.g).watchSocket = {watchRtts:[{at:f.mono(),ms:5000}]};
  assert.equal(f.watch.controlLead(f.room),1000);
  f.advance(31000); assert.equal(f.watch.controlLead(f.room),400);
});

test('a sole viewing tab skips startup, resume, pause and seek leads while retaining readiness and RTT evidence', async t => {
  const f=fixture(t); await f.watch.leave(f.room,f.guest,f.g);
  const rtts=[{at:f.mono(),ms:900}];
  f.room.viewers.get(f.h).watchSocket={watchRtts:rtts};
  assert.equal(f.watch.controlLead(f.room),0);
  await f.load(); assert.equal(f.room.readinessStartAt,f.now());
  assert.equal(f.room.s.state.paused,true,'decoding readiness is still required');
  await f.ready(f.h); assert.equal(f.room.startAt,f.now());
  f.advance(1000); assert.equal(f.watch.position(f.room),1);
  await f.dispatch('media.pause'); assert.equal(f.room.pauseAt,undefined); assert.equal(f.room.s.state.paused,true);
  await f.dispatch('media.play'); assert.equal(f.room.startAt,f.now());
  f.advance(1000); await f.dispatch('media.toggle'); assert.equal(f.room.s.state.paused,true);
  await f.dispatch('media.toggle'); assert.equal(f.room.startAt,f.now());
  await f.dispatch('media.seek.absolute',{seconds:40});
  const old=f.room.readinessVersion;
  assert.equal(f.room.readinessStartAt,f.now());assert.equal(f.room.s.state.paused,true);
  await f.dispatch('media.seek.absolute',{seconds:45});
  await assert.rejects(f.watch.ready(f.room,f.host,f.h,f.room.mediaVersion,true,old),/Invalid readiness/);
  await f.ready(f.h);assert.equal(f.room.startAt,f.now());assert.equal(f.watch.position(f.room),45);
  assert.equal(f.room.viewers.get(f.h).watchSocket.watchRtts,rtts,'timing samples survive solo playback');
});

test('a second tab of the same account restores group readiness and delivery leads', async t => {
  const f=fixture(t);await f.watch.leave(f.room,f.guest,f.g);await f.load();
  f.advance(200);
  const second=randomUUID(); f.watch.snapshot(f.room,f.host,second);
  assert.equal(f.room.viewers.size,2);assert.equal(f.watch.snapshot(f.room,f.host,f.h).viewers,1,'account presence is distinct from viewing tabs');
  assert.equal(f.room.readinessStartAt,f.now()+1750);
  await f.ready(f.h);assert.equal(f.room.initialGate,true);
  await f.watch.ready(f.room,f.host,second,f.room.mediaVersion,true,f.room.readinessVersion);
  assert.equal(f.room.startAt,f.now()+1750);assert.equal(f.watch.controlLead(f.room),400);
  f.advance(2000);await f.dispatch('media.pause');assert.equal(f.room.pauseAt,f.now()+400);
});

test('joining an already playing solo room does not stop its timeline and restores shared control deadlines', async t => {
  const f=fixture(t);await f.watch.leave(f.room,f.guest,f.g);await f.load();await f.ready(f.h);f.advance(1000);
  const position=f.watch.position(f.room);
  f.watch.snapshot(f.room,f.guest,f.g);
  assert.equal(f.room.initialGate,false);assert.equal(f.room.s.state.paused,false);assert.equal(f.watch.position(f.room),position);
  await f.dispatch('media.pause');assert.equal(f.room.pauseAt,f.now()+400);
  f.advance(400);await f.dispatch('media.play');assert.equal(f.room.startAt,f.now()+400);
});

test('departure releases an already scheduled group start or pause without a timeline jump', async t => {
  const f=fixture(t);await f.load();await f.ready(f.h);await f.ready(f.g);
  f.advance(100);await f.watch.leave(f.room,f.guest,f.g);
  assert.equal(f.room.startAt,f.now());assert.equal(f.watch.position(f.room),0);
  f.advance(1000);assert.equal(f.watch.position(f.room),1);
  f.watch.snapshot(f.room,f.guest,f.g);await f.dispatch('media.pause');
  f.advance(100);await f.watch.leave(f.room,f.guest,f.g);
  assert.equal(f.room.pauseAt,undefined);assert.equal(f.room.s.state.paused,true);assert.equal(f.watch.position(f.room),1.1);
});

test('expired viewers release coordination delays; leaving during readiness retains only the sole decoder gate', async t => {
  const f=fixture(t);await f.load();await f.ready(f.h);await f.ready(f.g);
  f.room.viewers.get(f.g).at=f.now()-10001;f.watch.refresh(f.room);
  assert.equal(f.room.viewers.size,1);assert.equal(f.room.startAt,f.now());
  f.watch.snapshot(f.room,f.guest,f.g);
  await f.dispatch('media.seek.absolute',{seconds:30});await f.ready(f.h);
  await f.watch.leave(f.room,f.guest,f.g);
  assert.equal(f.room.initialGate,false);assert.equal(f.room.startAt,f.now());assert.equal(f.watch.position(f.room),30);
});

test('timeout names blockers, latches despite late readiness, and only the host may force a generation', async t => {
  const f = fixture(t); await f.load(); await f.ready(f.h);
  f.advance(3000); assert.deepEqual(f.watch.snapshot(f.room,f.host,f.h).readiness.blockers,['Guest']);
  f.advance(7000); const id = f.room.readinessId;
  assert.equal(f.room.readinessTimedOut,true);
  await f.ready(f.g); assert.equal(f.room.s.state.paused,true,'late readiness cannot surprise the host');
  assert.equal((await f.dispatch('media.play')).status,'unavailable');
  assert.equal((await f.dispatch('media.pause',undefined,f.guest)).status,'unavailable','shared pause cannot dismiss the host decision');
  assert.equal((await f.dispatch('media.ready.start',{readinessId:id},f.guest)).status,'forbidden');
  await f.ready(f.g,false);
  assert.equal((await f.dispatch('media.ready.start',{readinessId:id})).status,'applied');
  assert.equal(f.room.initialGate,false); assert.equal(f.room.startAt,f.now()+400);
  f.advance(500); await f.ready(f.g,false);
  assert.equal(f.room.s.state.paused,false,'unready viewers recover independently after force-start');
  assert.equal((await f.dispatch('media.ready.start',{readinessId:id})).status,'unavailable');
});

test('wait extends by fifteen seconds, cancel stays paused, and superseded choices cannot act', async t => {
  const f = fixture(t); await f.load(); f.advance(10000);
  let id = f.room.readinessId;
  assert.equal((await f.dispatch('media.ready.start',{readinessId:id})).status,'unavailable','nobody ready');
  await f.dispatch('media.ready.wait',{readinessId:id});
  assert.notEqual(f.room.readinessId,id); assert.equal(f.room.readinessTimedOut,false);
  assert.equal((await f.dispatch('media.ready.cancel',{readinessId:id})).status,'unavailable');
  f.advance(14999); assert.equal(f.room.readinessTimedOut,false);
  f.advance(1); assert.equal(f.room.readinessTimedOut,true);
  id = f.room.readinessId; await f.dispatch('media.ready.cancel',{readinessId:id});
  await f.ready(f.h); await f.ready(f.g); assert.equal(f.room.s.state.paused,true);
  await f.dispatch('media.play'); assert.equal(f.room.s.state.paused,false);
  f.advance(2000); await f.dispatch('media.seek.absolute',{seconds:30}); f.advance(10000);
  assert.equal(f.room.readinessTimedOut,true,'shared seeks have the same bounded wait');
  await f.dispatch('media.load',{mediaId:'demo',quality:'direct'});
  assert.equal((await f.dispatch('media.ready.wait',{readinessId:id})).status,'unavailable','replacement invalidates choices');
});

test('precision candidate requires sustained trustworthy drift and has a distinct exit threshold', () => {
  const policy = precisionCorrection();
  const update = (now,error,extra={}) => policy.update({now,error,eligible:true,context:'room',uncertaintyMs:10,...extra});
  assert.equal(update(0,.12),1); assert.equal(update(999,.12),1); assert.equal(update(1000,.12),1.04);
  assert.equal(update(1500,.08),1.04); assert.equal(update(2000,.05),1);
  assert.equal(update(2500,.08),1); assert.equal(update(3000,.12),1);
  assert.equal(update(4000,.12,{uncertaintyMs:80}),1,'uncertain clocks cannot drive corrections');
  assert.equal(update(4500,.12),1); assert.equal(update(5500,.12),1.04);
  assert.equal(update(6000,-.12),1,'direction changes require new sustained evidence');
  assert.equal(update(7000,-.12),.96); assert.equal(update(7500,-.12,{eligible:false}),1);
  assert.equal(update(8000,-.12),1); assert.equal(update(9000,-.12,{context:'replacement'}),1);
  assert.equal(update(10000,-.7),1,'large errors belong to seek recovery');
});

test('client pauses at the common deadline and cancels a superseded pause alarm', async () => {
  let now=1500,key='first',callback,pauses=0;
  const ctx={state:{mediaUrl:'fixture',pauseAt:2000,state:{paused:false,duration:60,volume:50,muted:false}},
    playbackClock:{read:()=>({valid:true,serverTime:now})},expected:()=>10+Math.min(now-1000,1000)/1000,
    startKey:()=>key,pauseAlarm:{arm:(_,at,fire)=>{assert.equal(at,2000);callback=fire;},cancel(){}},
    performance:{now:()=>now},document:{visibilityState:'visible'},syncCorrectionMode:'speed',
    presentationTiming:{cadence:()=>0},video:{readyState:4,currentTime:10.5,seeking:false,paused:false,playbackRate:1,
      buffered:{length:1,start:()=>0,end:()=>40},pause(){pauses++;this.paused=true;}},
    probing:false,playbackError:'',playerWaiting:false,autoplayBlocked:false,hlsTimelinePending:false,hlsPreparationUntil:0,
    hlsNetworkFailure:undefined,syncSeekPending:false,uburoomPlayback:require('../web/playback-policy'),
    renderTransport(){},checkVideoFrames(){}};
  await install(ctx);
  await ctx.synchronize(); assert.equal(pauses,0);
  key='replacement';now=2000;callback();assert.equal(pauses,0,'old callback cannot pause a replacement');
  key='first';ctx.video.currentTime=11;await ctx.synchronize();assert.equal(pauses,1);
});
