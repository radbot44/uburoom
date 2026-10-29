'use strict';
const {install}=require('./helpers/watch-sync');
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {clock,target,presentation,controlSignal,correction}=require('../web/playback-timing');
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
  assert.ok(f.c.read().clockStabilityMs<=30,'stable high-RTT path retains low clockStabilityMs');
  f.tick(700);assert.equal(f.sample(250,250),false,'jitter spike rejected');
  assert.ok(f.c.read().clockStabilityMs>100,'excess jitter inflates clockStabilityMs past cutoff');
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
    performance:{now:()=>100},document:{visibilityState:'visible'},syncCorrectionMode:'speed',pauseAlarm:{cancel(){}},driftCorrection:correction(),startKey:()=> 'fixture',presentationTiming:presentation(),playerWaiting:false,
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

test('presentation tracker manages EMA smoothing, reinitialization, interruption lifecycle and read validity', () => {
  const p = presentation();
  const ctx = 'room:m1:s1:0:0:0:undefined';

  const f1 = p.frame(1000, { mediaTime: 10.05, expectedDisplayTime: 1000, presentedFrames: 1 }, { target: 10.0, context: ctx, clockRevision: 1 });
  assert.ok(Math.abs(f1.presentationErrorMs - 50) < 1e-4);
  assert.ok(Math.abs(f1.smoothedPresentationErrorMs - 50) < 1e-4);
  assert.equal(f1.presentationReset, true);

  const r1 = p.read(1050, { context: ctx, clockRevision: 1 });
  assert.equal(r1.valid, true);
  assert.ok(Math.abs(r1.errorMs - 50) < 1e-4);
  assert.ok(Math.abs(r1.smoothedErrorMs - 50) < 1e-4);
  assert.equal(r1.ageMs, 50);
  assert.equal(r1.samples, 1);
  assert.equal(r1.reason, 'fresh');

  const f2 = p.frame(1040, { mediaTime: 10.07, expectedDisplayTime: 1040, presentedFrames: 2 }, { target: 10.0, context: ctx, clockRevision: 1 });
  assert.ok(Math.abs(f2.presentationErrorMs - 70) < 1e-4);
  assert.equal(Math.round(f2.smoothedPresentationErrorMs * 10) / 10, 57.0);
  assert.equal(f2.presentationReset, false);

  const r2 = p.read(1040, { context: ctx, clockRevision: 1 });
  assert.equal(r2.samples, 2);

  const rStale = p.read(2500, { context: ctx, clockRevision: 1 });
  assert.equal(rStale.valid, false);
  assert.equal(rStale.reason, 'stale');
  assert.ok(Math.abs(rStale.errorMs - 70) < 1e-4);
  assert.equal(rStale.ageMs, 1460);

  const f3 = p.frame(2600, { mediaTime: 11.6, expectedDisplayTime: 2600, presentedFrames: 3 }, { target: 11.5, context: ctx, clockRevision: 1 });
  assert.ok(Math.abs(f3.presentationErrorMs - 100) < 1e-4);
  assert.ok(Math.abs(f3.smoothedPresentationErrorMs - 100) < 1e-4);
  assert.equal(f3.presentationReset, true);

  const otherCtx = 'room2:m1:s1:0:0:0:undefined';
  assert.equal(p.read(2650, { context: otherCtx, clockRevision: 1 }).valid, false);
  assert.equal(p.read(2650, { context: otherCtx, clockRevision: 1 }).reason, 'context');
  const fContext = p.frame(2650, { mediaTime: 11.65, expectedDisplayTime: 2650, presentedFrames: 4 }, { target: 11.5, context: otherCtx, clockRevision: 1 });
  assert.equal(fContext.presentationReset, true);

  assert.equal(p.read(2660, { context: otherCtx, clockRevision: 2 }).valid, false);
  assert.equal(p.read(2660, { context: otherCtx, clockRevision: 2 }).reason, 'clock');
  const fClock = p.frame(2690, { mediaTime: 11.69, expectedDisplayTime: 2690, presentedFrames: 5 }, { target: 11.5, context: otherCtx, clockRevision: 2 });
  assert.equal(fClock.presentationReset, true);

  const fGap = p.frame(3000, { mediaTime: 12.0, expectedDisplayTime: 3000, presentedFrames: 6 }, { target: 11.8, context: otherCtx, clockRevision: 2 });
  assert.equal(fGap.presentationReset, true);

  for (let i = 0; i < 10; i++) {
    p.frame(3100 + i * 40, { mediaTime: 12.0 + (i + 1) * 0.04, expectedDisplayTime: 3100 + i * 40, presentedFrames: 7 + i }, { target: 12.0 + (i + 1) * 0.04, context: otherCtx, clockRevision: 2 });
  }
  assert.ok(p.cadence() > 0, 'cadence was learned');
  const learnedCadence = p.cadence();

  p.interrupt('pause');
  assert.equal(p.cadence(), learnedCadence, 'interrupt preserves cadence');
  const rInt = p.read(3600, { context: otherCtx, clockRevision: 2 });
  assert.equal(rInt.valid, false);
  assert.equal(rInt.smoothedErrorMs, undefined);
  assert.equal(rInt.reason, 'pause');

  const fAfterInt = p.frame(4000, { mediaTime: 13.0, expectedDisplayTime: 4000, presentedFrames: 20 }, { target: 13.02, context: otherCtx, clockRevision: 2 });
  assert.equal(fAfterInt.presentationReset, true);

  p.reset();
  assert.equal(p.cadence(), 0);
  const rReset = p.read(4100);
  assert.equal(rReset.valid, false);
  assert.equal(rReset.errorMs, undefined);
  assert.equal(rReset.reason, 'none');
});

test('sync-quality reporting rejects interrupted presentation samples while retaining the 2500ms window for uninterrupted samples', () => {
  const source = fs.readFileSync(require('node:path').join(__dirname, '../web/watch.js'), 'utf8');
  const p = presentation();
  const samples = [];
  const ctx = {
    selected: 'room',
    viewerId: 'viewer',
    mediaSource: 'https://media',
    state: { id: 'room', mediaUrl: 'https://media', streamVersion: 's', mediaVersion: 'm', state: { paused: false }, waitingForReady: false },
    video: { currentTime: 10.0, paused: false, seeking: false, readyState: 4, playbackRate: 1 },
    playerWaiting: false,
    probing: false,
    playbackError: false,
    autoplayBlocked: false,
    readyVersion: 'm',
    document: { visibilityState: 'visible' },
    syncQualityContext: 'room:viewer:m:s',
    syncQualityClockRevision: 1,
    syncQualitySettleUntil: 0,
    lastPresentationBreak: 0,
    sync: { timelinePending: false, contextKey: () => 'room:viewer:m:s' },
    presentationTiming: p,
    uburoomTiming: { target: () => 10.0 },
    uburoomSyncQuality: require('../web/sync-quality'),
    syncQuality: { reset() {}, breakSample() {}, sample(data) { samples.push(data); } }
  };
  const code = source.slice(source.indexOf('function syncQualityClockUsable('), source.indexOf('function refreshSyncQuality('));
  vm.runInNewContext(code, ctx);

  const timingClock = { valid: true, clockAgeMs: 50, clockUncertaintyMs: 20, clockRevision: 1, serverTime: 100000 };
  const syncKey = 'room:viewer:m:s';

  // 1. Frame recorded at t=1000 with presentation error = +120ms (currentTime=10.0, target=10.0 => position error=0ms)
  p.frame(1000, { mediaTime: 10.12, expectedDisplayTime: 1000, presentedFrames: 1 }, { target: 10.0, context: syncKey, clockRevision: 1 });

  // 2. Uninterrupted sample at t=2500: age=1500ms > 1000ms controller freshness, but <= 2500ms sync quality window
  ctx.sampleSyncQuality(timingClock, 2500);
  assert.equal(samples.length, 1);
  assert.equal(samples[0].source, 'presentation');
  assert.ok(Math.abs(samples[0].errorMs - 120) < 1e-4, 'uninterrupted sample contributes presentation error up to 2500ms');

  // 3. Interrupted by pause at t=2600 (sample age 1600ms <= 2500ms): must NOT contribute presentation error
  p.interrupt('pause');
  ctx.sampleSyncQuality(timingClock, 2600);
  assert.equal(samples[1].source, 'position');
  assert.equal(samples[1].errorMs, 0, 'interrupted sample (pause) falls back to position error');

  // 4. Interrupted by seek at t=2700 (sample age 1700ms <= 2500ms): must NOT contribute presentation error
  p.interrupt('seek');
  ctx.sampleSyncQuality(timingClock, 2700);
  assert.equal(samples[2].source, 'position');
  assert.equal(samples[2].errorMs, 0, 'interrupted sample (seek) falls back to position error');

  // 5. Interrupted by waiting at t=2800 (sample age 1800ms <= 2500ms): must NOT contribute presentation error
  p.interrupt('waiting');
  ctx.sampleSyncQuality(timingClock, 2800);
  assert.equal(samples[3].source, 'position');
  assert.equal(samples[3].errorMs, 0, 'interrupted sample (waiting) falls back to position error');

  // 6. Interrupted by visibilitychange at t=2900 (sample age 1900ms <= 2500ms): must NOT contribute presentation error
  p.interrupt('visibilitychange');
  ctx.sampleSyncQuality(timingClock, 2900);
  assert.equal(samples[4].source, 'position');
  assert.equal(samples[4].errorMs, 0, 'interrupted sample (visibilitychange) falls back to position error');

  // 7. Resumption: new frame arrives at t=3000
  p.frame(3000, { mediaTime: 10.05, expectedDisplayTime: 3000, presentedFrames: 2 }, { target: 10.0, context: syncKey, clockRevision: 1 });
  ctx.sampleSyncQuality(timingClock, 3050);
  assert.equal(samples[5].source, 'presentation');
  assert.ok(Math.abs(samples[5].errorMs - 50) < 1e-4, 'fresh frames after interruption resume presentation reporting');
});

test('controlSignal selects presentation, blend, or position based on 90/180 ms divergence and validity', () => {
  const presAhead = { valid: true, errorMs: 50, smoothedErrorMs: 50, ageMs: 40, reason: 'fresh' };
  const sigAhead = controlSignal({ target: 10.0, currentTime: 10.05, presentation: presAhead, clockValid: true, visible: true, eligible: true });
  assert.equal(sigAhead.source, 'presentation');
  assert.equal(sigAhead.error, -0.05);
  assert.equal(sigAhead.divergenceMs, 0);

  const presBehind = { valid: true, errorMs: -80, smoothedErrorMs: -80, ageMs: 30, reason: 'fresh' };
  const sigBehind = controlSignal({ target: 10.0, currentTime: 9.92, presentation: presBehind, clockValid: true, visible: true, eligible: true });
  assert.equal(sigBehind.source, 'presentation');
  assert.equal(sigBehind.error, 0.08);

  const pres80 = { valid: true, errorMs: -100, smoothedErrorMs: -100, ageMs: 20, reason: 'fresh' };
  const sig80 = controlSignal({ target: 10.0, currentTime: 9.82, presentation: pres80, clockValid: true, visible: true, eligible: true });
  assert.equal(sig80.source, 'presentation');
  assert.equal(sig80.error, 0.10);
  assert.equal(sig80.divergenceMs, 80);

  const pres90 = { valid: true, errorMs: -100, smoothedErrorMs: -100, ageMs: 20, reason: 'fresh' };
  const sig90 = controlSignal({ target: 10.0, currentTime: 9.81, presentation: pres90, clockValid: true, visible: true, eligible: true });
  assert.equal(sig90.source, 'presentation');
  assert.equal(sig90.divergenceMs, 90);

  const pres120 = { valid: true, errorMs: -100, smoothedErrorMs: -100, ageMs: 20, reason: 'fresh' };
  const sig120 = controlSignal({ target: 10.0, currentTime: 9.78, presentation: pres120, clockValid: true, visible: true, eligible: true });
  assert.equal(sig120.source, 'blend');
  assert.equal(sig120.divergenceMs, 120);
  assert.equal(Math.round(sig120.error * 1000), Math.round((0.5 * 0.10 + 0.5 * 0.22) * 1000));

  const pres180 = { valid: true, errorMs: -100, smoothedErrorMs: -100, ageMs: 20, reason: 'fresh' };
  const sig180 = controlSignal({ target: 10.0, currentTime: 9.72, presentation: pres180, clockValid: true, visible: true, eligible: true });
  assert.equal(sig180.source, 'blend');
  assert.equal(sig180.divergenceMs, 180);

  const pres200 = { valid: true, errorMs: -100, smoothedErrorMs: -100, ageMs: 20, reason: 'fresh' };
  const sig200 = controlSignal({ target: 10.0, currentTime: 9.70, presentation: pres200, clockValid: true, visible: true, eligible: true });
  assert.equal(sig200.source, 'position');
  assert.ok(Math.abs(sig200.error - 0.30) < 1e-4);
  assert.equal(sig200.divergenceMs, 200);
  assert.equal(sig200.reason, 'divergent');

  const sigMissing = controlSignal({ target: 10.0, currentTime: 9.8, presentation: undefined, clockValid: true, visible: true, eligible: true });
  assert.equal(sigMissing.source, 'position');
  assert.ok(Math.abs(sigMissing.error - 0.20) < 1e-4);
  assert.equal(sigMissing.reason, 'none');

  const presStale = { valid: false, errorMs: -100, smoothedErrorMs: -100, ageMs: 1200, reason: 'stale' };
  const sigStale = controlSignal({ target: 10.0, currentTime: 9.8, presentation: presStale, clockValid: true, visible: true, eligible: true });
  assert.equal(sigStale.source, 'position');
  assert.equal(sigStale.reason, 'stale');

  const sigHidden = controlSignal({ target: 10.0, currentTime: 9.8, presentation: pres80, clockValid: true, visible: false, eligible: true });
  assert.equal(sigHidden.source, 'position');
  assert.equal(sigHidden.reason, 'hidden');

  const sigClock = controlSignal({ target: 10.0, currentTime: 9.8, presentation: pres80, clockValid: false, visible: true, eligible: true });
  assert.equal(sigClock.source, 'position');
  assert.equal(sigClock.reason, 'clock-invalid');

  const sigIneligible = controlSignal({ target: 10.0, currentTime: 9.8, presentation: pres80, clockValid: true, visible: true, eligible: false });
  assert.equal(sigIneligible.source, 'position');
  assert.equal(sigIneligible.reason, 'ineligible');
});
test('frame diagnostics have their own bounded sanitized ring',()=>{
  const d=create();for(let i=0;i<7300;i++)d.record('frame',{frameMediaTime:i,frameServerTime:100000+i,clockEpoch:'secret',url:'secret'});
  const log=d.snapshot();assert.equal(log.discardedFrames,100);assert.equal(log.entries.filter(r=>r.event==='frame').length,7200);
  assert.equal(log.entries.filter(r=>r.event==='frame')[0].frameMediaTime,100);assert.ok(!JSON.stringify(log).includes('secret'));
});

test('degradation and capability diagnostics remain bounded and exclude media/credential/device identifiers',()=>{
  const d=create();for(let i=0;i<400;i++)d.record('decode-capability',{capabilityStatus:'reported',capabilitySupported:true,capabilitySmooth:false,
    capabilityPowerEfficient:false,roomId:'secret-room',mediaId:'secret-media',url:'https://secret-media',token:'secret-token',device:'secret-device',error:'secret-error'});
  d.record('playback-degraded',{degradation:'severe-drops',severeRatio:.5,severeTotal:48,severeDropped:24,sampleGapMs:500});
  const log=d.snapshot();assert.equal(log.entries.length,300);assert.equal(log.discardedEvents,102);
  assert.equal(log.entries.at(-1).severeDropped,24);assert.ok(!JSON.stringify(log).includes('secret'));
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
