/* Offline, opt-in comparison of local diagnostic exports; no network or uploads. */
'use strict';
const fs=require('node:fs');
function distribution(values) {
  const rows=values.filter(Number.isFinite).sort((a,b)=>a-b), q=p=>rows.length?rows[Math.max(0,Math.ceil(p*rows.length)-1)]:null;
  return {count:rows.length,p50:q(.5),p95:q(.95),p99:q(.99),max:rows.at(-1)??null};
}
function summarize(log) {
  const rows=log.entries||[], frames=rows.filter(r=>r.event==='frame'), samples=rows.filter(r=>r.event==='sample');
  let dropped=0;
  for(let i=1;i<samples.length;i++)if(samples[i].stream===samples[i-1].stream && samples[i].dropped>=samples[i-1].dropped)dropped+=samples[i].dropped-samples[i-1].dropped;
  return {frames:frames.length,discardedFrames:log.discardedFrames||0,
    presentationErrorMs:distribution(frames.map(r=>Math.abs(r.presentationErrorMs))),
    frameIntervalMs:distribution(frames.map(r=>r.frameIntervalMs)),
    callbackLatenessMs:distribution(frames.map(r=>r.frameCallbackLatenessMs)),
    clockUncertaintyMs:distribution(frames.map(r=>r.clockUncertaintyMs)),
    requestRttMs:distribution(rows.filter(r=>r.event==='clock-sample').map(r=>r.requestRttMs)),
    callbackGaps:frames.reduce((n,r)=>n+(r.frameCallbackGap||0),0),repeatedCallbackMediaTimes:frames.filter(r=>r.frameRepeated).length,
    observedDroppedFrames:dropped,seeks:rows.filter(r=>r.event==='seeking').length,syncSeeks:rows.filter(r=>r.event==='sync-seek').length,
    rateChanges:rows.filter(r=>r.event==='ratechange').length,nonUnitRateFrames:frames.filter(r=>r.rate!==1).length,
    waits:rows.filter(r=>r.event==='waiting').length,stalls:rows.filter(r=>r.event==='stalled').length};
}
function compare(a,b,{sameTimeline=false,stepMs=10}={}) {
  if(!sameTimeline)throw new Error('Confirm both exports cover the same content and room timeline with --same-timeline.');
  if(!Number.isFinite(stepMs)||stepMs<1)throw new Error('Invalid comparison interval');
  const prepare=log=>{
    const rows=log.entries?.filter(r=>r.event==='frame'&&Number.isFinite(r.frameServerTime)&&Number.isFinite(r.frameMediaTime))||[];
    if(!rows.length)throw new Error('Frame presentation/clock evidence is unavailable.');
    if(new Set(rows.map(r=>r.room+':'+r.media)).size!==1)throw new Error('Use exports from one room/media generation per run.');
    if(new Set(rows.map(r=>r.clockRevision)).size!==1 || rows.some((r,i)=>i>0&&r.frameServerTime<rows[i-1].frameServerTime))throw new Error('Select a continuous clock segment before comparing; a reset cannot be aligned reliably.');
    return rows;
  };
  const left=prepare(a),right=prepare(b), start=Math.max(left[0].frameServerTime,right[0].frameServerTime),
    end=Math.min(left.at(-1).frameServerTime,right.at(-1).frameServerTime);
  if(end<=start)throw new Error('No overlapping presentation evidence');
  let i=0,j=0;const healthy=[],outliers=[],uncertainty=[],excluded={};
  const classify=(r,t)=>!r.clockValid?'clock-unavailable':t-r.frameServerTime>100?'missing-frame':r.paused?'paused':r.seeking?'seeking':
    r.waiting||r.ready<3||r.bufferAhead<.5?'buffering':r.visibility!=='visible'?'hidden':r.settling?'settling':undefined;
  // Hold the last presented media frame at a uniform real-time grid. Linear
  // extrapolation of currentTime would conceal frame cadence and held frames.
  for(let t=start;t<=end;t+=stepMs) {
    while(i+1<left.length&&left[i+1].frameServerTime<=t)i++;
    while(j+1<right.length&&right[j+1].frameServerTime<=t)j++;
    const l=left[i],r=right[j], reason=classify(l,t)||classify(r,t)||(l.timelineRevision!==r.timelineRevision?'timeline-transition':undefined);
    const skew=Math.abs(l.frameMediaTime-r.frameMediaTime)*1000;
    if(reason){excluded[reason]=(excluded[reason]||0)+1;outliers.push(skew);}else{
      healthy.push(skew);uncertainty.push(l.clockUncertaintyMs+r.clockUncertaintyMs);
    }
  }
  return {comparisonStepMs:stepMs,overlapMs:end-start,healthySkewMs:distribution(healthy),excludedSkewMs:distribution(outliers),
    excludedGridSamples:excluded,combinedClockUncertaintyMs:distribution(uncertainty),viewers:[summarize(a),summarize(b)],
    limitations:'Compositor estimates, not physical display/audio measurements. Asymmetry is unresolved. Missing callbacks are not proof of dropped or repeated physical frames. Exclusions remain reported separately.'};
}
if(require.main===module) {
  try {
    const files=process.argv.slice(2).filter(s=>!s.startsWith('--'));
    if(files.length!==2)throw new Error('Usage: node scripts/sync-report.js first.json second.json --same-timeline');
    console.log(JSON.stringify(compare(...files.map(file=>JSON.parse(fs.readFileSync(file,'utf8'))),{sameTimeline:process.argv.includes('--same-timeline')}),null,2));
  }catch(error){console.error(error.message);process.exitCode=1;}
}
module.exports={distribution,summarize,compare};
