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
test('streaming responses allow continuous slow bodies beyond header deadline but bound idle stalls',async()=>{
  const slowFetcher=async(url,{signal})=>{
    const stream=new ReadableStream({
      async start(controller){
        for(let i=0;i<4;i++){
          await new Promise(r=>setTimeout(r,15));
          if(signal.aborted)return;
          controller.enqueue(new Uint8Array([i]));
        }
        controller.close();
      }
    });
    return new Response(stream);
  };
  const streamingRequest=resilientFetch(slowFetcher,{timeoutMs:25,idleTimeoutMs:30});
  const res=await streamingRequest('https://stream.invalid',{streaming:true});
  const reader=res.body.getReader();
  const chunks=[];
  while(true){
    const {done,value}=await reader.read();
    if(done)break;
    chunks.push(...value);
  }
  assert.deepEqual(chunks,[0,1,2,3],'continuous slow body completes past the header deadline');

  const stalledFetcher=async(url,{signal})=>{
    const stream=new ReadableStream({
      async start(controller){
        controller.enqueue(new Uint8Array([1]));
        await new Promise(r=>{signal.addEventListener('abort',r,{once:true});});
      }
    });
    return new Response(stream);
  };
  const stalledRequest=resilientFetch(stalledFetcher,{timeoutMs:30,idleTimeoutMs:25});
  const stalledRes=await stalledRequest('https://stalled.invalid',{streaming:true});
  const stalledReader=stalledRes.body.getReader();
  const first=await stalledReader.read();
  assert.equal(first.value[0],1);
  await assert.rejects(stalledReader.read(),error=>error.name==='TimeoutError'||error.message.includes('idle'));

  const backpressureFetcher=async()=>{
    const stream=new ReadableStream({
      async start(controller){
        controller.enqueue(new Uint8Array([10]));
        controller.enqueue(new Uint8Array([20]));
        controller.close();
      }
    });
    return new Response(stream);
  };
  const backpressureRequest=resilientFetch(backpressureFetcher,{timeoutMs:30,idleTimeoutMs:25});
  const backpressureRes=await backpressureRequest('https://backpressure.invalid',{streaming:true});
  const bpReader=backpressureRes.body.getReader();
  const bpFirst=await bpReader.read();
  assert.equal(bpFirst.value[0],10);
  // Consumer pauses reading longer than idleTimeoutMs (50ms > 25ms)
  await new Promise(r=>setTimeout(r,50));
  const bpSecond=await bpReader.read();
  assert.equal(bpSecond.value[0],20);
  const bpThird=await bpReader.read();
  assert.equal(bpThird.done,true);
});

test('streaming response promptly cancels on caller disconnect or abort',async()=>{
  let upstreamCancelled=false;
  const abort=new AbortController();
  const fetcher=async(url,{signal})=>{
    const stream=new ReadableStream({
      start(controller){
        controller.enqueue(new Uint8Array([42]));
      },
      cancel(){
        upstreamCancelled=true;
      }
    });
    signal.addEventListener('abort',()=>{upstreamCancelled=true;},{once:true});
    return new Response(stream);
  };
  const req=resilientFetch(fetcher,{timeoutMs:50,idleTimeoutMs:50});
  const res=await req('https://stream.invalid',{streaming:true,signal:abort.signal});
  const reader=res.body.getReader();
  await reader.read();
  abort.abort();
  await new Promise(r=>setTimeout(r,10));
  assert.equal(upstreamCancelled,true,'caller abort promptly cancels streaming body');
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
