'use strict';
class IntegrationUnavailable extends Error {
  constructor() { super('External service temporarily unavailable; retry shortly'); this.status=503; }
}
// One breaker per authorization scope. User denials and missing media never
// poison another account's circuit. One half-open probe prevents retry bursts.
class CircuitBreaker {
  constructor({threshold=5,cooldown=10000,now=Date.now}={}) { Object.assign(this,{threshold,cooldown,now});this.failures=0;this.until=0;this.probing=false; }
  async run(action) {
    if(this.until>this.now()||this.probing)throw new IntegrationUnavailable();
    const probe=!!this.until;if(probe)this.probing=true;
    try {const value=await action();this.failures=0;this.until=0;return value;}
    catch(error) {
      const status=error.status;
      if(error.name!=='AbortError'&&(!status||status===429||status>=500)) {
        if(++this.failures>=this.threshold||probe||status===429)this.until=this.now()+Math.max(this.cooldown,error.retryAfterMs||0);
      } else if(probe){this.until=0;this.failures=0;}
      throw error;
    } finally {if(probe)this.probing=false;}
  }
}
function resilientFetch(fetcher,{timeoutMs=12000,idleTimeoutMs=12000}={}) {
  const circuit=new CircuitBreaker();
  return (url,options={})=>circuit.run(async()=>{
    if(options.streaming) {
      const internalAbort=new AbortController();
      let aborted=false;
      const onCallerAbort=()=>{aborted=true;internalAbort.abort(options.signal.reason);};
      if(options.signal){
        if(options.signal.aborted)onCallerAbort();
        else options.signal.addEventListener('abort',onCallerAbort,{once:true});
      }
      const headerTimeout=options.headerTimeoutMs||timeoutMs;
      const headerTimer=setTimeout(()=>{
        internalAbort.abort(Object.assign(new Error('Response header timeout'),{name:'TimeoutError'}));
      },headerTimeout);
      let response;
      try {
        response=await fetcher(url,{...options,signal:internalAbort.signal});
      } finally {
        clearTimeout(headerTimer);
      }
      if(response.status===429||response.status>=500) {
        const error=new IntegrationUnavailable();error.status=response.status;
        const retry=response.headers.get('retry-after'),seconds=Number(retry);
        error.retryAfterMs=Math.min(60000,Math.max(0,Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()||0));
        void response.body?.cancel().catch(()=>{});throw error;
      }
      if(response.body&&typeof response.body.getReader==='function') {
        const idle=options.idleTimeoutMs||idleTimeoutMs;
        const reader=response.body.getReader();
        let idleTimer;
        const clearIdle=()=>{clearTimeout(idleTimer);};
        internalAbort.signal.addEventListener('abort',clearIdle,{once:true});
        const stream=new ReadableStream({
          async pull(controller){
            clearIdle();
            idleTimer=setTimeout(()=>{
              const err=Object.assign(new Error('Stream idle timeout'),{name:'TimeoutError'});
              try{controller.error(err);}catch{}
              internalAbort.abort(err);
            },idle);
            try {
              const {done,value}=await reader.read();
              clearIdle();
              if(done){
                controller.close();
              } else {
                controller.enqueue(value);
              }
            } catch(err){
              clearIdle();
              try{controller.error(err);}catch{}
            }
          },
          cancel(reason){
            clearIdle();
            internalAbort.abort(reason);
            return reader.cancel(reason);
          }
        });
        response=new Response(stream,{
          status:response.status,
          statusText:response.statusText,
          headers:response.headers
        });
      }
      return response;
    }
    const response=await fetcher(url,{...options,signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(timeoutMs)]):AbortSignal.timeout(timeoutMs)});
    if(response.status===429||response.status>=500) {
      const error=new IntegrationUnavailable();error.status=response.status;
      const retry=response.headers.get('retry-after'),seconds=Number(retry);
      error.retryAfterMs=Math.min(60000,Math.max(0,Number.isFinite(seconds)?seconds*1000:Date.parse(retry)-Date.now()||0));
      void response.body?.cancel().catch(()=>{});throw error;
    }
    return response;
  });
}
module.exports={CircuitBreaker,resilientFetch,IntegrationUnavailable};
