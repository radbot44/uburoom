'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const playback = require('../web/playback-policy');
const {create:diagnosticLog}=require('../web/playback-diagnostics');
const source = fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8');
function load(context,name,next) {
  context.diagnostics ??= diagnosticLog();
  context.diagnosticSample ??= (event,fields)=>context.diagnostics.record(event,fields);
  if(context.Hls)context.Hls.ErrorDetails ??= {};
  vm.runInNewContext(source.slice(source.indexOf('function '+name+'('),source.indexOf('function '+next+'(')),context);
}
test('HLS retries the current stream with backoff, retains buffered media, and ignores superseded timers',() => {
  const timers = [], client = {loads:0,startLoad(){this.loads++;}};
  const context = {hls:client,Hls:{ErrorTypes:{NETWORK_ERROR:'network'}},state:{mediaUrl:'/current',mediaVersion:'media',streamVersion:'stream',state:{duration:60}},mediaSource:'/current',
    selected:'room',navigator:{onLine:true},performance:{now:()=>0},receivedAt:0,expected:()=>12,video:{readyState:4,currentTime:12},
    hlsNetworkRetries:0,hlsRecoveryTimer:undefined,hlsNetworkFailure:undefined,
    clearTimeout:()=>{},setTimeout:(action,delay)=>{timers.push({action,delay});return timers.length;}};
  load(context,'handleHlsError','unavailable');
  for (let i=0;i<4;i++) context.handleHlsError(client,{fatal:true,type:'network'});
  assert.deepEqual(timers.map(t=>t.delay),[1000,2000,4000,15000]);
  assert.equal(context.hls,client,'good MSE data stays attached after exhausted speculation');
  assert.match(context.hlsNetworkFailure,/connection/);
  timers[0].action(); assert.equal(client.loads,1);
  context.hls = undefined; timers[1].action(); assert.equal(client.loads,1,'old stream cannot restart');
});

test('slow fatal HLS recovery is capped and requires the current online stream, fresh control and valid timeline',() => {
  const timers=[],loads=[],client={startLoad:target=>loads.push(target)};
  let now=0,target=12;
  const context={hls:client,Hls:{ErrorTypes:{NETWORK_ERROR:'network'}},state:{mediaUrl:'/current',mediaVersion:'media',streamVersion:'stream',state:{duration:60}},
    mediaSource:'/current',selected:'room',navigator:{onLine:true},performance:{now:()=>now},receivedAt:0,expected:()=>target,video:{readyState:4,currentTime:12},
    hlsNetworkRetries:3,hlsRecoveryTimer:undefined,hlsNetworkFailure:undefined,clearTimeout:()=>{},
    setTimeout:(action,delay)=>{timers.push({action,delay});return timers.length;}};
  load(context,'handleHlsError','unavailable');
  const fatal=()=>context.handleHlsError(client,{fatal:true,type:'network'});
  fatal();assert.equal(timers[0].delay,15000);
  context.navigator.onLine=false;timers[0].action();assert.deepEqual(loads,[],'offline cannot load');
  context.navigator.onLine=true;now=4000;timers[1].action();assert.deepEqual(loads,[],'stale authorization cannot load');
  context.receivedAt=now;target=24;timers[2].action();assert.deepEqual(loads,[24],'fresh authorization uses the current shared position');
  assert.equal(context.video.currentTime,24,'a delivery error must not leave MSE loading around its paused local position');
  fatal();assert.equal(timers.at(-1).delay,30000);timers.at(-1).action();
  fatal();assert.equal(timers.at(-1).delay,60000);timers.at(-1).action();
  const count=timers.length;
  for(let i=0;i<10;i++)fatal();
  assert.equal(timers.length,count,'a persistent outage cannot schedule unlimited recovery attempts');
  assert.deepEqual(loads,[24,24,24]);
  for (const change of [()=>{context.selected='other';},()=>{context.state.mediaVersion='other';},()=>{context.state.streamVersion='other';},
    ()=>{context.state.mediaUrl='/replacement';},()=>{context.hls={};},()=>{context.state=undefined;},()=>{target=60;},()=>{target=NaN;}]) {
    context.hls=client;context.state={mediaUrl:'/current',mediaVersion:'media',streamVersion:'stream',state:{duration:60}};context.selected='room';
    context.hlsNetworkRetries=3;target=12;fatal();const timer=timers.at(-1);change();timer.action();
    assert.equal(loads.length,3,'obsolete or out-of-range playback cannot restart');
  }
});
test('exhausted HLS delivery failure allows cached playback and surfaces the error only when needed',async () => {
  let paused = false, message;
  const context = {state:{mediaUrl:'/current',state:{paused:false,volume:50,muted:false}},probing:false,playbackError:'',
    video:{readyState:4,currentTime:12,paused:false,buffered:{length:1,start:()=>0,end:()=>20},pause:()=>{paused=true;}},
    hlsNetworkFailure:'Connection failed',expected:()=>12,uburoomPlayback:playback,playbackClock:{read:()=>({valid:true})},
    fail:value=>{message=value;},renderTransport:()=>{},checkVideoFrames:()=>{}};
  // This function is async; retain its declaration keyword when isolating it.
  vm.runInNewContext(source.slice(source.indexOf('async function synchronize('),source.indexOf('function applyState(')),context);
  await context.synchronize(); assert.equal(paused,false); assert.equal(context.playbackError,'');
  context.expected = ()=>21;
  await context.synchronize(); assert.equal(paused,true); assert.equal(message,'Connection failed');
});
test('a fresh outside-cache HLS seek supersedes old network backoff while cached rewind keeps its data',() => {
  const actions = [], client = {stopLoad:()=>actions.push('stop'),startLoad:time=>actions.push(time)};
  const context = {hls:client,hlsNetworkInterrupted:true,state:{mediaUrl:'/current'},mediaSource:'/current',
    video:{buffered:{length:1,start:()=>10,end:()=>30}},uburoomPlayback:playback,hlsRecoveryTimer:1,
    hlsNetworkRetries:3,hlsNetworkFailure:'Connection failed',playbackError:'Connection failed',clearTimeout:()=>actions.push('cancel')};
  load(context,'restartHlsForSeek','handleHlsError');
  context.restartHlsForSeek(20); assert.deepEqual(actions,[],'cached rewind needs no network restart');
  context.restartHlsForSeek(80); assert.deepEqual(actions,['cancel','stop',80]);
  assert.equal(context.hls,client); assert.equal(context.hlsNetworkRetries,0); assert.equal(context.playbackError,'');
  context.hlsNetworkInterrupted = true; context.state.mediaUrl = '/replacement';
  context.restartHlsForSeek(90); assert.equal(actions.length,3,'old stream cannot restart for replacement content');
});
test('expired HLS session requests one personal refresh per stream with a bounded rate',async () => {
  const timers=[], commands=[];
  const client={startLoad(){}};
  const context={hls:client,Hls:{ErrorTypes:{NETWORK_ERROR:'network'},ErrorDetails:{MEDIA_SOURCE_REQUIRES_RESET:'reset'}},state:{format:'hls',mediaUrl:'/current',mediaVersion:'media',streamVersion:'stream'},
    mediaSource:'/current',selected:'room',pending:false,hlsRefreshPending:false,hlsRefreshVersion:undefined,hlsRefreshTimes:[],
    hlsNetworkRetries:0,hlsRecoveryTimer:undefined,hlsNetworkFailure:undefined,
    execute:async command=>{commands.push(command);},clearTimeout:()=>{},setTimeout:(action,delay)=>{timers.push({action,delay});return timers.length;}};
  vm.runInNewContext(source.slice(source.indexOf('async function refreshHlsSession('),source.indexOf('function handleHlsError(')),context);
  load(context,'handleHlsError','unavailable');
  context.handleHlsError(client,{fatal:true,type:'network',response:{code:410}});
  context.handleHlsError(client,{fatal:true,type:'network',response:{code:410}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(commands.length,1);
  assert.equal(commands[0].action,'media.stream.refresh');
  assert.equal(commands[0].args.streamVersion,'stream');
  const trace=context.diagnostics.snapshot().entries;
  assert.ok(trace.some(row=>row.event==='hls-error'&&row.status===410));
  assert.equal(trace.filter(row=>row.event==='stream-refresh').length,1);
  assert.ok(trace.some(row=>row.event==='stream-refresh-ok'));
  context.handleHlsError(client,{fatal:false,type:'network',response:{code:410}});
  for(let i=0;i<4;i++) {context.handleHlsError(client,{fatal:true,type:'network',response:{code:410}});await new Promise(resolve=>setImmediate(resolve));}
  assert.equal(commands.length,3,'repeated expiry cannot create an unbounded refresh loop');
  context.hls=undefined;
  context.handleHlsError(client,{fatal:true,type:'network',response:{code:410}});
  assert.equal(commands.length,3,'superseded media cannot refresh');
});
test('fresh HLS media clears an exhausted delivery error and resumes synchronization',async () => {
  const client = {}, calls = [];
  const context = {hls:client,hlsRecoveryTimer:7,hlsNetworkRetries:3,
    hlsNetworkFailure:'Connection failed',hlsNetworkInterrupted:true,playbackError:'Connection failed',
    state:{mediaUrl:'/current',state:{duration:60}},mediaSource:'/current',expected:()=>12,uburoomPlayback:playback,
    video:{buffered:{length:1,start:()=>0,end:()=>5}},
    clearTimeout:id=>calls.push(['cancel',id]),fail:value=>calls.push(['error',value]),
    synchronize:()=>{calls.push(['synchronize']);}};
  load(context,'handleHlsFragmentBuffered','handleHlsError');
  context.handleHlsFragmentBuffered({});
  assert.equal(context.playbackError,'Connection failed','obsolete stream cannot clear an active error');
  context.state = undefined;
  context.handleHlsFragmentBuffered(client);
  assert.equal(context.playbackError,'Connection failed','teardown cannot resume a stale player');
  context.state = {mediaUrl:'/current',state:{duration:60}};
  context.handleHlsFragmentBuffered(client);
  assert.equal(context.playbackError,'Connection failed','an unrelated fragment cannot recover the playback position');
  context.video.buffered = {length:1,start:()=>10,end:()=>20};
  context.handleHlsFragmentBuffered(client);
  assert.equal(context.playbackError,'');
  assert.equal(context.hlsNetworkFailure,undefined);
  assert.equal(context.hlsNetworkRetries,0);
  assert.equal(context.hlsNetworkInterrupted,false);
  assert.deepEqual(calls,[['cancel',7],['error',''],['synchronize']]);
});
