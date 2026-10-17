/* Playback timing only; never supplies watch-time credit or shared commands. */
(function(root) {
  'use strict';
  const MAX_AGE=5000, WINDOW=30000;
  function clock({monotonic=()=>performance.now(),wall=Date.now}={}) {
    let samples=[], delays=[], delayed=[], mapping, desired, adjustedAt, lastGood, lastTick, lastWall, lastSent, epoch, uncertain=false, revision=0, rejected=0, accepted=0, reason='startup';
    function reset(why='disconnect') {
      samples=[];delays=[];delayed=[];uncertain=false;mapping=desired=adjustedAt=lastGood=lastTick=lastWall=lastSent=epoch=undefined;revision++;reason=why;
    }
    function tick() {
      const now=monotonic(), date=wall();
      if(lastTick!==undefined && (now<lastTick || now-lastTick>MAX_AGE || Math.abs((date-lastWall)-(now-lastTick))>250))reset('discontinuity');
      lastTick=now;lastWall=date;
      if(mapping!==undefined) {
        // Refine at <=2 ms/s. Reading a future frame timestamp cannot slew the clock.
        const limit=Math.max(0,now-adjustedAt)*.002;
        mapping+=Math.max(-limit,Math.min(limit,desired-mapping));adjustedAt=now;
      }
      return now;
    }
    function begin() {return {sent:tick(),revision};}
    function add(request,timing) {
      const received=tick(), duration=received-request.sent;
      const {serverReceivedAt:t2,serverSentAt:t3,serverProcessingMs:processing,clockEpoch}=timing||{};
      const reject=why=>{rejected++;reason=why;return false;};
      if(request.revision!==revision)return reject('discontinuity');
      if(lastSent!==undefined && request.sent<=lastSent)return reject('invalid');
      lastSent=request.sent;
      if(![t2,t3,processing,duration].every(Number.isFinite) || duration<0 || processing<0 || t3<t2 ||
        Math.abs(t3-t2-processing)>5 || processing>duration+5 || typeof clockEpoch!=='string' || !clockEpoch)return reject('invalid');
      const rtt=Math.max(0,duration-processing);
      if(epoch!==undefined && clockEpoch!==epoch){reset('server-change');lastTick=received;lastWall=wall();lastSent=request.sent;}
      epoch=clockEpoch;
      delays.push({at:received,rtt});delays=delays.filter(s=>received-s.at<=WINDOW).slice(-32);
      if(rtt>1500)return reject('delay');
      const offset=(t2+t3-request.sent-received)/2;
      samples=samples.filter(s=>received-s.at<=WINDOW);
      // A low-delay sample gives the narrowest possible offset interval. Do
      // not assume path symmetry: uncertainty retains half the network RTT.
      const best=samples.filter(s=>!s.suspect).reduce((a,b)=>!a||b.rtt<a.rtt?b:a,undefined);
      if(best && rtt>best.rtt+Math.max(20,best.rtt*.5)) {
        delayed.push({rtt,offset});delayed=delayed.slice(-3);
        // Reacquire a persistently slower route without waiting for the old
        // minimum to age out. Isolated queueing spikes cannot replace it.
        if(delayed.length<3 || !delayed.every(s=>Math.abs(s.rtt-rtt)<=Math.max(20,rtt*.2) && Math.abs(s.offset-offset)<=20))return reject('jitter');
        samples=[];
      }
      delayed=[];
      if(mapping!==undefined && Math.abs(offset-mapping)>Math.max(250,rtt/2+(best?.rtt||0)/2+10)) {
        uncertain=true;
        // A server wall-clock step changes the authoritative timeline. Require
        // three agreeing exchanges before rebasing; one outlier cannot jump it.
        samples.push({at:received,rtt,offset,suspect:true});samples=samples.slice(-32);
        const recent=samples.slice(-3);
        if(recent.length<3 || !recent.every(s=>s.suspect && Math.abs(s.offset-offset)<10))return reject('outlier');
        samples=[];mapping=undefined;revision++;
      }
      samples.push({at:received,rtt,offset});samples=samples.slice(-32);
      const reliable=samples.filter(s=>!s.suspect).sort((a,b)=>a.rtt-b.rtt || b.at-a.at);
      desired=reliable[0].offset;
      if(mapping===undefined)mapping=desired;
      adjustedAt=received;lastGood=received;uncertain=false;accepted++;reason='accepted';return true;
    }
    function read(at) {
      const now=tick();at??=now;
      const reliable=samples.filter(s=>!s.suspect && now-s.at<=WINDOW), best=reliable.reduce((a,b)=>!a||b.rtt<a.rtt?b:a,undefined);
      const valid=mapping!==undefined && best && now-lastGood<=MAX_AGE && !uncertain;
      const rtts=delays.filter(s=>now-s.at<=WINDOW).map(s=>s.rtt), jitter=rtts.length?Math.max(...rtts)-Math.min(...rtts):undefined;
      return {valid:!!valid,serverTime:valid?at+mapping:undefined,clockRevision:revision,clockAccepted:accepted,clockRejected:rejected,clockReason:reason,
        clockOffsetMs:valid?now+mapping-wall():undefined,clockAgeMs:lastGood===undefined?undefined:now-lastGood,
        clockUncertaintyMs:valid?best.rtt/2+2+Math.abs(desired-mapping)+(now-best.at)*.0001:undefined,
        networkRttMs:rtts.at(-1),networkMinRttMs:best?.rtt,networkJitterMs:jitter};
    }
    return {begin,add,read,reset};
  }
  function target(state,serverTime) {
    if(!state || !Number.isFinite(serverTime) || !Number.isFinite(state.serverNow))return undefined;
    if (Number.isFinite(state.pauseAt)) serverTime = Math.min(serverTime, state.pauseAt);
    const elapsed=Number.isFinite(state.startAt)?Math.max(0,serverTime-Math.max(state.serverNow,state.startAt)):serverTime-state.serverNow;
    return Math.max(0,Math.min(state.state.duration||0,state.state.position+(state.state.paused?0:elapsed/1000)));
  }
  function alarm({now,set=setTimeout,clear=clearTimeout}) {
    let timer,key,generation=0;
    const cancel=()=>{generation++;if(timer!==undefined)clear(timer);timer=key=undefined;};
    function arm(nextKey,at,fire) {
      if(key===nextKey && timer!==undefined)return;
      cancel();key=nextKey;const current=generation;
      const check=()=>{
        if(current!==generation)return;
        const time=now();
        if(!Number.isFinite(time)){cancel();return;}
        if(time<at){timer=set(check,Math.min(2500,at-time));return;}
        timer=key=undefined;generation++;fire();
      };
      check();
    }
    return {arm,cancel};
  }
  function presentation() {
    let previous, intervals=[];
    return {
      reset(){previous=undefined;intervals=[];},
      cadence(){return intervals.length>=8?[...intervals].sort((a,b)=>a-b)[Math.floor(intervals.length/2)]:0;},
      frame(now,metadata) {
        const {mediaTime,expectedDisplayTime,presentationTime,presentedFrames,processingDuration}=metadata;
        if(![mediaTime,expectedDisplayTime,presentedFrames].every(Number.isFinite))return undefined;
        const current={mediaTime,expectedDisplayTime,presentedFrames};
        const advancing=previous && mediaTime>previous.mediaTime && expectedDisplayTime>previous.expectedDisplayTime && presentedFrames>previous.presentedFrames;
        if(advancing && presentedFrames===previous.presentedFrames+1) {
          const interval=mediaTime-previous.mediaTime;
          if(interval>=1/120 && interval<=.1){intervals.push(interval);intervals=intervals.slice(-24);}
        }
        const result={frameMediaTime:mediaTime,frameDisplayMonoMs:expectedDisplayTime,framePresentationMonoMs:presentationTime,
          frameCallbackLatenessMs:now-expectedDisplayTime,frameProcessingMs:Number.isFinite(processingDuration)?processingDuration*1000:undefined,
          presentedFrames,frameIntervalMs:advancing?expectedDisplayTime-previous.expectedDisplayTime:undefined,
          frameMediaIntervalMs:advancing?(mediaTime-previous.mediaTime)*1000:undefined,
          // Gaps mean callbacks were missed; they do not prove repeated/dropped pixels.
          frameCallbackGap:advancing?Math.max(0,presentedFrames-previous.presentedFrames-1):undefined,
          frameRepeated:!!previous&&mediaTime===previous.mediaTime};
        previous=current;return result;
      }
    };
  }
  // Local drift correction only. Frame intervals widen tolerance; they never
  // authorize a shared action or imply that physical display cadence is known.
  function correction() {
    let since, direction=0, activeUntil=0, quietUntil=0, last, key;
    function reset() {since=last=key=undefined;direction=activeUntil=quietUntil=0;}
    function update({now,error,eligible,context,uncertaintyMs=0,frameSeconds=0}) {
      if(context!==key || !Number.isFinite(now) || last!==undefined&&(now<last||now-last>3000))reset();
      key=context;last=now;
      const stop=()=>{if(direction)quietUntil=now+10000;direction=0;activeUntil=0;since=undefined;};
      const tolerance=Math.max(.15+Math.min(.1,Math.max(0,frameSeconds)),Math.min(.25,uncertaintyMs/1000));
      if(!eligible || !Number.isFinite(error) || !Number.isFinite(now)){stop();return 1;}
      const sign=Math.sign(error),magnitude=Math.abs(error);
      if(direction) {
        if(sign!==direction || magnitude<=tolerance*.6 || magnitude>.65 || now>=activeUntil)stop();
        else return 1+direction*.005;
      }
      if(magnitude<=tolerance+.05 || magnitude>.65 || now<quietUntil){since=undefined;return 1;}
      if(since===undefined || since.sign!==sign)since={at:now,sign};
      if(now-since.at<2000)return 1;
      direction=sign;activeUntil=now+10000;since=undefined;return 1+direction*.005;
    }
    return {update,reset};
  }
  // Candidate policy: require sustained, resolvable error and separate entry
  // and exit thresholds. Clock uncertainty never authorizes a correction.
  function precisionCorrection() {
    let key, last, since, sign = 0, active = false;
    function reset() { key = last = since = undefined; sign = 0; active = false; }
    function update({now,error,eligible,context,uncertaintyMs}) {
      if (key !== context || last !== undefined && (now < last || now - last > 3000)) reset();
      key = context; last = now;
      const magnitude = Math.abs(error), direction = Math.sign(error);
      if (!eligible || !Number.isFinite(now) || !Number.isFinite(error) || !Number.isFinite(uncertaintyMs) ||
          uncertaintyMs < 0 || uncertaintyMs > 50 || uncertaintyMs / 1000 >= magnitude / 2 || magnitude > .65 || magnitude <= .05) {
        since = undefined; sign = 0; active = false; return 1;
      }
      if (direction !== sign) { since = undefined; active = false; sign = direction; }
      if (active) return 1 + sign * .04;
      if (magnitude <= .1) { since = undefined; return 1; }
      since ??= now;
      if (now - since < 1000) return 1;
      active = true; return 1 + sign * .04;
    }
    return {update,reset};
  }
  const api={clock,target,presentation,alarm,correction,precisionCorrection};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.uburoomTiming=api;
})(typeof globalThis==='object'?globalThis:this);
