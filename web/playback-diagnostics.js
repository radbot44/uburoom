/* Local, bounded playback evidence. Exports exclude URLs, IDs, titles and error text. */
(function(root) {
  'use strict';
  const choices = {
    reason:['state-change','room-select','room-poll','identity-poll','room-unavailable','leave','end','logout','fallback','decoder','fatal','complete','source-changed','unavailable'],
    action:['media.load','media.play','media.pause','media.toggle','media.seek.absolute','media.seek.relative','media.quality.set','media.tracks.set','media.stream.refresh','session.enable','session.disable','session.visibility'],
    request:['room-poll','rooms','observe','ready','command','identity','other'],
    failure:['http','network','timeout','abort','decode','other'],
    category:['network','media','other'],
    detail:['reset','fragment','manifest','other'],
    format:['hls','file','av1'], delivery:['text','burn','off'],
    visibility:['visible','hidden','prerender'],
    rejection:['media-unavailable','media-changed','stream-changed','epoch-changed','invalid-discontinuity','invalid-state','invalid-sequence','sequence-replayed',
      'invalid-sample','sample-replayed','invalid-clock','sample-stale','sample-future','invalid-position','invalid-rate','invalid-frames','observation-timeout','storage-failure'],
    creditReason:['baseline','not-playing','discontinuity','frames-not-advancing','sample-gap','receive-gap','delivery-jitter','clock-discontinuity','position-discontinuity','interval-limit','clock-unavailable','credited'],
    clockReason:['startup','disconnect','discontinuity','server-change','invalid','delay','jitter','outlier','accepted']
  };
  const events = new Set(['start','sample','state-change','request-failed','player-clear','hls-stop','hls-error','retry-scheduled','retry-deferred','retry-start',
    'stream-refresh','stream-refresh-ok','stream-refresh-failed','identity-renewed','identity-renew-failed','fallback','buffer-recovered',
    'playing','pause','waiting','stalled','seeking','seeked','ended','error','emptied','loadstart','loadedmetadata','canplay','abort',
    'soak-start','soak-end','probe-start','probe-end','command-start','command-ok','command-failed','online','offline','visibilitychange','pagehide','observation-uncredited',
    'frame','clock-sample','ratechange','sync-seek','start-prepare','start-timer']);
  const numbers = new Set(['elapsedMs','status','attempt','delayMs','position','target','ready','network','rate','bufferAhead','frames','decoded','dropped',
    'callbackFrames','width','height','viewportFraction','jsHeapUsed','jsHeapTotal','jsHeapLimit','mediaError','audio','subtitle','identity','room','media','stream','grant','observation',
    'receivedMs','clockDeltaMs','positionDelta','frameDelta','creditedSeconds','serverTime','clockRevision','clockAccepted','clockRejected','clockOffsetMs','clockAgeMs',
    'clockUncertaintyMs','networkRttMs','networkMinRttMs','networkJitterMs','requestRttMs','serverProcessingMs','timelineRevision','sharedTarget','positionErrorMs',
    'frameMediaTime','frameDisplayMonoMs','framePresentationMonoMs','frameCallbackLatenessMs','frameProcessingMs','presentedFrames',
    'frameIntervalMs','frameMediaIntervalMs','frameCallbackGap','presentationErrorMs','arrivalTarget','frameServerTime']);
  const flags = new Set(['paused','roomPaused','seeking','waiting','online','inViewport','fatal','enabled','cleanup','roomChanged','mediaChanged','streamChanged','grantChanged','observationChanged','clockValid','frameRepeated','settling']);
  function requestKind(path) {
    const route = String(path).split('?')[0];
    if (/^\/api\/watch\/rooms\/[^/]+$/.test(route)) return 'room-poll';
    if (route === '/api/watch/rooms') return 'rooms';
    const action = /^\/api\/watch\/rooms\/[^/]+\/(observe|ready|command)$/.exec(route)?.[1];
    if (action) return action;
    return /^\/api\/(watch\/(me|.*login)|account\/.*login)$/.test(route) ? 'identity' : 'other';
  }
  function create({now=Date.now,monotonic=()=>performance.now(),soak=false}={}) {
    const limits=soak?{events:2400,samples:8100,frames:36000}:{events:300,samples:600,frames:7200};
    const startedAt=now(), start=monotonic(), buckets={events:[],samples:[],frames:[]}, generations={room:0,media:0,stream:0,grant:0,observation:0};
    let previous={}, sequence=0, discardedEvents=0, discardedSamples=0, discardedFrames=0, frameCursor=0;
    function record(event,fields={}) {
      if (!events.has(event)) return;
      const row={sequence:++sequence,at:now(),ms:Math.round(monotonic()-start),event,...generations};
      for (const [key,value] of Object.entries(fields)) {
        if (numbers.has(key) && Number.isFinite(value) && Math.abs(value)<=Number.MAX_SAFE_INTEGER) row[key]=Math.round(value*1000)/1000;
        else if (flags.has(key) && typeof value==='boolean') row[key]=value;
        else if (Object.hasOwn(choices,key) && choices[key].includes(value)) row[key]=value;
        else if (key==='ranges' && Array.isArray(value)) row.ranges=value.slice(0,8).filter(pair=>Array.isArray(pair)&&pair.length===2&&pair.every(n=>Number.isFinite(n)&&n>=0&&n<=1e9)).map(pair=>pair.map(n=>Math.round(n*1000)/1000));
      }
      const sample=event==='sample', frame=event==='frame', bucket=frame?buckets.frames:sample?buckets.samples:buckets.events, limit=frame?limits.frames:sample?limits.samples:limits.events;
      if(frame && bucket.length===limit){bucket[frameCursor]=row;frameCursor=(frameCursor+1)%limit;discardedFrames++;return;}
      if (bucket.length===limit) { bucket.shift(); if(frame)discardedFrames++;else if(sample)discardedSamples++;else discardedEvents++; }
      bucket.push(row);
    }
    function state(value) {
      const current={room:value.id,media:value.mediaVersion,stream:value.streamVersion,grant:value.mediaUrl,observation:value.observationEpoch}, changed={};
      for (const key of Object.keys(generations)) if (previous[key]!==current[key]) {generations[key]++;changed[key+'Changed']=true;}
      previous=current;
      if(Object.keys(changed).length)record('state-change',changed);
    }
    record('start');
    return {record,state,snapshot:()=>JSON.parse(JSON.stringify({schema:2,startedAt,exportedAt:now(),limits,discardedEvents,discardedSamples,discardedFrames,
      entries:[...buckets.events,...buckets.samples,...buckets.frames].sort((a,b)=>a.sequence-b.sequence)}))};
  }
  function controlProbe(now=()=>performance.now()) {
    let room,until=0;
    return {
      start(id) {if(!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id||'')||now()<until)return false;room=id;until=now()+6000;return true;},
      active:()=>now()<until,
      rejects:(path,id)=>id===room && now()<until && String(path).split('?')[0]==='/api/watch/rooms/'+room
    };
  }
  const api={create,requestKind,controlProbe};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.uburoomDiagnostics=api;
})(typeof globalThis==='object'?globalThis:this);
