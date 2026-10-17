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
function resilientFetch(fetcher,{timeoutMs=12000}={}) {
  const circuit=new CircuitBreaker();
  return (url,options={})=>circuit.run(async()=>{
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
