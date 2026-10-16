'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {create,requestKind}=require('../web/playback-diagnostics');
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

test('failed control requests preserve errors while recording safe HTTP, decoding and transport evidence',async()=>{
  const source=fs.readFileSync(path.join(__dirname,'../web/watch.js'),'utf8');
  for(const [failure,response,error] of [
    ['http',{status:503,ok:false,json:async()=>({error:'private server error'})}],
    ['decode',{status:200,ok:true,json:async()=>{throw new SyntaxError('private HTML');}}],
    ['network',undefined,new TypeError('private URL')],
    ['timeout',undefined,new DOMException('private URL','TimeoutError')],
    ['abort',undefined,new DOMException('private URL','AbortError')]
  ]){
    const diagnostics=create(),context={token:undefined,me:undefined,diagnostics,uburoomDiagnostics:{requestKind},performance,AbortSignal,TypeError,
      fetch:async()=>{if(error)throw error;return response;}};
    vm.runInNewContext(source.slice(source.indexOf('async function api('),source.indexOf('function acceptIdentity(')),context);
    await assert.rejects(context.api('/api/watch/rooms/private-room?viewer=secret'),error?value=>value===error:undefined);
    const row=diagnostics.snapshot().entries.at(-1);
    assert.equal(row.event,'request-failed');assert.equal(row.request,'room-poll');assert.equal(row.failure,failure);
    assert.equal(row.status,response?.status);assert.ok(row.elapsedMs>=0);
    assert.ok(!JSON.stringify(row).includes('private'));assert.ok(!JSON.stringify(row).includes('secret'));
  }
});
