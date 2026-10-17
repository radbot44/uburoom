'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create,requestKind,controlProbe}=require('../web/playback-diagnostics');
const vm=require('node:vm');
const fs=require('node:fs');
const path=require('node:path');

test('diagnostics retain bounded independent event and sample histories',()=>{
  let time=0;const log=create({now:()=>100000+time,monotonic:()=>time});
  for(let i=0;i<1000;i++){time++;log.record('sample',{position:i});}
  log.record('player-clear',{reason:'room-poll'});
  for(let i=0;i<1000;i++)log.record('request-failed',{request:'observe',failure:'network'});
  const saved=log.snapshot();
  assert.equal(saved.entries.length,900);assert.equal(saved.discardedSamples,400);assert.equal(saved.discardedEvents,702);
  assert.equal(saved.entries.filter(row=>row.event==='sample').length,600);
  assert.equal(saved.entries.find(row=>row.event==='sample').position,400);
  assert.ok(saved.entries.every((row,i,rows)=>i===0||row.sequence>rows[i-1].sequence));
  saved.entries[0].position=-100;assert.notEqual(log.snapshot().entries[0].position,-100);
});

test('diagnostics whitelist fields and replace private stream identifiers with generations',()=>{
  const secret='https://private.invalid/video?token=secret';const log=create();
  const original={id:secret,mediaVersion:secret,streamVersion:secret,mediaUrl:secret,observationEpoch:secret};
  log.state(original);log.state(original);log.state({...original,mediaUrl:secret+'2'});
  log.record('request-failed',{request:secret,failure:secret,message:secret,url:secret,constructor:secret,toString:secret,status:503,elapsedMs:123.45678,enabled:secret,position:Infinity,
    ranges:[[0,2],[secret,4],[-1,3],[0,NaN]],reason:secret});
  log.record(secret,{message:secret});
  const saved=log.snapshot(),changes=saved.entries.filter(row=>row.event==='state-change'),failure=saved.entries.at(-1);
  assert.equal(changes.length,2);assert.equal(changes[1].grant,2);assert.equal(changes[1].stream,1);
  assert.equal(changes[1].grantChanged,true);assert.equal(changes[1].streamChanged,undefined);
  assert.equal(failure.status,503);assert.equal(failure.elapsedMs,123.457);assert.deepEqual(failure.ranges,[[0,2]]);
  assert.ok(!JSON.stringify(saved).includes('private'));assert.ok(!JSON.stringify(saved).includes('secret'));
});

test('request categories never include room IDs, query grants or arbitrary routes',()=>{
  assert.equal(requestKind('/api/watch/rooms/private-id?viewer=secret'),'room-poll');
  assert.equal(requestKind('/api/watch/rooms/private-id/observe'),'observe');
  assert.equal(requestKind('/api/watch/activity-login'),'identity');
  assert.equal(requestKind('/api/watch/rooms/private-id/private-secret'),'other');
});

test('opt-in soak retains two hours of one-second samples with finite caps',()=>{
  const log=create({soak:true});log.record('soak-start');
  for(let second=0;second<7201;second++)log.record('sample',{position:second,jsHeapUsed:123456});
  let saved=log.snapshot();assert.equal(saved.discardedSamples,0);assert.equal(saved.entries.filter(row=>row.event==='sample').length,7201);
  assert.deepEqual(saved.limits,{events:2400,samples:8100,frames:36000});
  for(let second=7201;second<10000;second++)log.record('sample',{position:second});
  saved=log.snapshot();assert.equal(saved.discardedSamples,1900);assert.equal(saved.entries.filter(row=>row.event==='sample').length,8100);
});

test('failed control requests preserve errors while recording safe HTTP, decoding and transport evidence',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8');
  for(const [failure,response,error] of [
    ['http',{status:503,ok:false,json:async()=>({error:'private server error'})}],
    ['decode',{status:200,ok:true,json:async()=>{throw new SyntaxError('private HTML');}}],
    ['network',undefined,new TypeError('private URL')],
    ['timeout',undefined,new DOMException('private URL','TimeoutError')],
    ['abort',undefined,new DOMException('private URL','AbortError')]
  ]){
    const diagnostics=create(),context={transport:undefined,token:undefined,me:undefined,controlProbe:undefined,diagnostics,uburoomDiagnostics:{requestKind},performance,AbortSignal,TypeError,
      fetch:async()=>{if(error)throw error;return response;}};
    vm.runInNewContext(source.slice(source.indexOf('async function api('),source.indexOf('function acceptIdentity(')),context);
    await assert.rejects(context.api('/api/watch/rooms/private-room?viewer=secret'),error?value=>value===error:undefined);
    const row=diagnostics.snapshot().entries.at(-1);
    assert.equal(row.event,'request-failed');assert.equal(row.request,'room-poll');assert.equal(row.failure,failure);
    assert.equal(row.status,response?.status);assert.ok(row.elapsedMs>=0);
    assert.ok(!JSON.stringify(row).includes('private'));assert.ok(!JSON.stringify(row).includes('secret'));
  }
});

test('opt-in control probe affects only one room poll for a fixed six seconds',()=>{
  let time=100;const probe=controlProbe(()=>time),room='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
  assert.equal(probe.start('invalid'),false);assert.equal(probe.active(),false);
  assert.equal(probe.start(room),true);assert.equal(probe.start(other),false);
  assert.equal(probe.rejects('/api/watch/rooms/'+room+'?viewer=secret',room),true);
  for(const route of ['/api/watch/me','/api/watch/rooms','/api/watch/rooms/'+room+'/observe','/api/watch/rooms/'+room+'/command','/api/watch/media/private/start'])assert.equal(probe.rejects(route,room),false);
  assert.equal(probe.rejects('/api/watch/rooms/'+other+'?viewer=secret',other),false);
  time=6099;assert.equal(probe.active(),true);time=6100;assert.equal(probe.active(),false);
  assert.equal(probe.rejects('/api/watch/rooms/'+room,room),false);assert.equal(probe.start(other),true);
});

test('automatic soak cleanup refuses changed rooms, media, permissions and concurrent commands',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8');
  const base={mediaVersion:'original',visibility:'private',viewers:1,canManage:true};
  for(const change of [ctx=>{ctx.selected='other';},ctx=>{ctx.state.mediaVersion='new';},ctx=>{ctx.state.visibility='public';},
    ctx=>{ctx.state.viewers=2;},ctx=>{ctx.state.canManage=false;},ctx=>{ctx.pending=true;},ctx=>{ctx.state=undefined;}]){
    const events=[],calls=[],element={},ctx={soak:{room:'room',media:'original',startedAt:0},selected:'room',state:{...base},pending:false,performance:{now:()=>7200000},
      execute:()=>{calls.push('command');throw new Error('Must not command this session');},api:()=>{calls.push('leave');throw new Error('Must not leave this session');},
      diagnosticSample:(event,fields)=>events.push({event,...fields}),saveDiagnostics:()=>events.push({event:'export'}),$:()=>element};
    change(ctx);vm.runInNewContext(source.slice(source.indexOf('async function finishSoak('),source.indexOf('const controlProbe=')),ctx);
    await ctx.finishSoak('complete');await ctx.finishSoak('complete');
    assert.deepEqual(calls,[]);assert.equal(events.filter(row=>row.event==='export').length,1);assert.equal(events.find(row=>row.event==='soak-end').cleanup,false);
  }
});

test('observation diagnostics retain only known rejection/credit reasons and bounded ring entries',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8'),diagnostics=create();
  const ctx={transport:undefined,token:undefined,me:undefined,controlProbe:undefined,diagnostics,uburoomDiagnostics:{requestKind},performance,AbortSignal,TypeError,
    fetch:async()=>({status:409,ok:false,json:async()=>({error:'secret token URL',rejection:'sample-stale'})})};
  vm.runInNewContext(source.slice(source.indexOf('async function api('),source.indexOf('function acceptIdentity(')),ctx);
  await assert.rejects(ctx.api('/api/watch/rooms/secret/observe',{}));
  assert.equal(diagnostics.snapshot().entries.at(-1).rejection,'sample-stale');
  ctx.fetch=async()=>({status:409,ok:false,json:async()=>({error:'secret',rejection:'secret'})});
  await assert.rejects(ctx.api('/api/watch/rooms/secret/observe',{}));
  assert.equal(diagnostics.snapshot().entries.at(-1).rejection,undefined);
  for(let i=0;i<400;i++)diagnostics.record('observation-uncredited',{creditReason:'frames-not-advancing',elapsedMs:1000,frameDelta:0,url:'secret',playbackId:'secret'});
  assert.equal(diagnostics.snapshot().entries.length,300);assert.ok(diagnostics.snapshot().discardedEvents>0);
  diagnostics.record('observation-uncredited',{creditReason:'secret',rejection:'secret',positionDelta:Infinity});
  assert.equal(diagnostics.snapshot().entries.at(-1).creditReason,undefined);
  assert.ok(!JSON.stringify(diagnostics.snapshot()).includes('secret'));
});
