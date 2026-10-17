'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {CircuitBreaker,resilientFetch}=require('../server/resilience');
const {Plex}=require('../server/plex');
const {run}=require('../server/av1');

test('circuit breaker bounds failures, respects rate limits and allows exactly one recovery probe',async()=>{
  let now=0,calls=0;const circuit=new CircuitBreaker({threshold:2,cooldown:100,now:()=>now});
  const failed=()=>circuit.run(async()=>{calls++;throw Object.assign(new Error('Unavailable'),{status:503});});
  await assert.rejects(failed());await assert.rejects(failed());await assert.rejects(failed());assert.equal(calls,2);
  now=101;let finish;const probe=circuit.run(()=>new Promise(resolve=>{finish=resolve;}));
  await assert.rejects(circuit.run(()=>{throw new Error('Must not run');}));finish('ok');assert.equal(await probe,'ok');
  assert.equal(await circuit.run(async()=>42),42);
  for(let i=0;i<6;i++)await assert.rejects(circuit.run(()=>{throw Object.assign(new Error('Denied'),{status:403});}));
  assert.equal(await circuit.run(async()=>true),true,'user access denials do not trip an integration breaker');
});
test('Plex circuits isolate principals and bound 429 retries without exposing upstream bodies',async()=>{
  let calls=0;
  const plex=new Plex({plexUrl:'https://plex.invalid',plexToken:'owner'},async(url,options)=>{calls++;return options.headers['X-Plex-Token']==='bad'?new Response('secret',{status:429,headers:{'Retry-After':'60'}}):new Response('{}');});
  try{
    const bad=plex.scope('bad','bad'),good=plex.scope('good','good');
    await assert.rejects(bad.request('/'),error=>error.status===429&&!error.message.includes('secret'));
    await assert.rejects(bad.request('/'),error=>error.status===503);assert.equal(calls,1);
    assert.equal((await good.request('/')).status,200);assert.equal(calls,2);
  }finally{await plex.close();}
});
test('integration requests retain a hard deadline with a caller signal',async()=>{
  const request=resilientFetch(async(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  }),{timeoutMs:15});
  // AbortSignal.timeout is unref'ed; keep this isolated fake request alive.
  const timer=setTimeout(()=>{},1000);
  try{await assert.rejects(request('https://fixture.invalid',{signal:new AbortController().signal}),{name:'TimeoutError'});}finally{clearTimeout(timer);}
});
test('tool runner drains stderr, bounds output and kills timed-out or over-budget processes',async()=>{
  const binary=process.execPath;
  assert.equal((await run(binary,['-e','process.stderr.write("x".repeat(200000));process.stdout.write("ok")'],undefined,2000)).toString(),'ok');
  await assert.rejects(run(binary,['-e','process.stdout.write("x".repeat(200000))'],undefined,2000,1024),/output exceeded/);
  await assert.rejects(run(binary,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],undefined,100),/timed out/);
  await assert.rejects(run(binary,['-e','setInterval(()=>{},1000)'],undefined,2000,1024,undefined,{memory:async()=>2048,memoryLimit:1024,memoryInterval:10}),/memory limit/);
  await assert.rejects(run(binary,['-e','setInterval(()=>{},1000)'],undefined,2000,1024,undefined,{memory:async()=>{throw new Error('Unavailable');},memoryInterval:10}),/monitoring unavailable/);
  assert.ok(await require('../server/process-memory').processMemory(process.pid)>0,'native process inspection reports actual memory');
});
