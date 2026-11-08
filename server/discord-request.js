'use strict';
const {setTimeout:delay} = require('node:timers/promises');
function retryDelay(error) {
  const wait=Number(error?.retryAfter || error?.timeToReset || error?.retry_after*1000);
  return Number.isFinite(wait)&&wait>0?Math.ceil(wait):0;
}
// The bot's REST client rejects pre-emptive rate limits so admission never queues
// stale work. Explicit sharing operations may wait briefly, checking their own
// current authority again before each attempt. Never retry ambiguous failures.
async function discordRequest(action,{current=()=>true,signal,timeoutMs=8000}={}) {
  const deadline=Date.now()+timeoutMs;
  for(;;) {
    signal?.throwIfAborted();
    if(!await current())throw Object.assign(new Error('This action is no longer available.'),{status:403});
    try{return await action();}
    catch(error) {
      const wait=retryDelay(error);
      if(!wait || !(error.name==='RateLimitError'||error.status===429))throw error;
      error.status=429;
      if(Date.now()+wait>=deadline)throw error;
      await delay(wait+25,undefined,{signal});
    }
  }
}
module.exports={discordRequest,retryDelay};
