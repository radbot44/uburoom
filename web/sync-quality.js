/* Rolling playback quality evidence; independent from synchronization correction. */
(function(root) {
  'use strict';
  const WINDOW_MS=60000, SAMPLE_INTERVAL_MS=1000, MAX_POINTS=72, MAX_INTERVALS=72, MAX_CORRECTIONS=128;
  const MAX_CLOCK_AGE_MS=5000, MAX_CLOCK_UNCERTAINTY_MS=1000;
   const RECENT_EVIDENCE_MS=12000, PAUSED_EVIDENCE_MS=120000;
  const REFRESH_INTERVAL_MS=5000, STALE_AFTER_MS=15000;
  const finite=Number.isFinite;
  function clamp(value,min,max) { return Math.max(min,Math.min(max,value)); }
  function level(score,previous) {
    if(!finite(score)||score<0||score>1)return undefined;
    if(previous==='excellent')return score>=.87?'excellent':score>=.72?'good':score>=.47?'fair':'poor';
    if(previous==='good')return score>=.93?'excellent':score>=.72?'good':score>=.47?'fair':'poor';
    if(previous==='fair')return score>=.93?'excellent':score>=.78?'good':score>=.47?'fair':'poor';
    if(previous==='poor')return score>=.93?'excellent':score>=.78?'good':score>=.53?'fair':'poor';
    return score>=.90?'excellent':score>=.75?'good':score>=.50?'fair':'poor';
  }
  function calculate({measuredSeconds,outOfSync250Seconds,outOfSync500Seconds,automaticCorrectionCount,
    automaticCorrectionMagnitudeMs,rateAdjustedSeconds,rateAdjustmentSeconds,bufferingSeconds}={}) {
    const values=[measuredSeconds,outOfSync250Seconds,outOfSync500Seconds,automaticCorrectionCount,
      automaticCorrectionMagnitudeMs,rateAdjustedSeconds,rateAdjustmentSeconds,bufferingSeconds];
    if(values.some(value=>!finite(value)||value<0)||measuredSeconds<=0)return undefined;
    const out250=clamp(outOfSync250Seconds/measuredSeconds,0,1);
    const out500=clamp(outOfSync500Seconds/measuredSeconds,0,1);
    const rateDuty=clamp(rateAdjustedSeconds/measuredSeconds,0,1);
    // Drift and correction effort both matter. All penalties describe observed
    // playback only; RTT, jitter and buffered-ahead duration are deliberately absent.
    const penalty=1.0*out250+2.0*out500+.03*automaticCorrectionCount+
      .00004*automaticCorrectionMagnitudeMs+1.4*rateDuty+.15*rateAdjustmentSeconds+2.5*(bufferingSeconds/60);
    const score=Math.exp(-penalty);
    return finite(score)?clamp(score,0,1):undefined;
  }
  function create({now=()=>performance.now()}={}) {
    let context,clockRevision,points=[],intervals=[],buffers=[],corrections=[];
    let bufferStart,previousPoint,lastCalculatedAt,lastValidAt,lastActivityAt,lastRawScore;
    let smoothedScore=1,smoothedLevel='excellent',hasMeasuredScore=false;
    function reset(nextContext,{preserveLast=true}={}) {
      const oldScore=preserveLast?smoothedScore:1,oldLevel=preserveLast?smoothedLevel:'excellent',oldValid=preserveLast?lastValidAt:undefined;
      const oldMeasured=preserveLast&&hasMeasuredScore;
      context=nextContext;clockRevision=undefined;points=[];intervals=[];buffers=[];corrections=[];
      bufferStart=previousPoint=lastCalculatedAt=undefined;lastRawScore=undefined;
      smoothedScore=oldScore;smoothedLevel=oldLevel;lastValidAt=oldValid;lastActivityAt=undefined;hasMeasuredScore=oldMeasured;
    }
    function trim(at) {
      const cutoff=at-WINDOW_MS;
      points=points.filter(point=>point.at>=cutoff).slice(-MAX_POINTS);
      intervals=intervals.filter(interval=>interval.end>cutoff).slice(-MAX_INTERVALS);
      buffers=buffers.filter(interval=>interval.end>cutoff).slice(-MAX_INTERVALS);
      corrections=corrections.filter(event=>event.at>=cutoff).slice(-MAX_CORRECTIONS);
      if(lastActivityAt!==undefined&&at-lastActivityAt>STALE_AFTER_MS)previousPoint=undefined;
    }
    function sample({at=now(),errorMs,playbackRate=1,eligible,source='presentation',context:nextContext,clockRevision:nextRevision}={}) {
      if(context!==nextContext)reset(nextContext);
      if(!finite(at))return false;
      if(clockRevision!==nextRevision) {
        clockRevision=nextRevision;points=[];intervals=[];buffers=[];corrections=[];
        bufferStart=previousPoint=lastCalculatedAt=lastRawScore=undefined;
      }
      if(!eligible||!finite(errorMs)||!finite(playbackRate)||playbackRate<=0) { previousPoint=undefined;trim(at);return false; }
      if(previousPoint&&at<previousPoint.at){previousPoint=undefined;return false;}
      if(previousPoint&&at-previousPoint.at<SAMPLE_INTERVAL_MS-50)return false;
      if(previousPoint&&at-previousPoint.at<=2500)intervals.push({start:previousPoint.at,end:at,errorMs:previousPoint.errorMs,playbackRate:previousPoint.playbackRate,source:previousPoint.source});
      const point={at,errorMs:Math.abs(errorMs),playbackRate,source:source==='position'?'position':'presentation'};
      points.push(point);points=points.slice(-MAX_POINTS);previousPoint=point;lastActivityAt=at;trim(at);return true;
    }
    function breakSample(at=now()) { previousPoint=undefined;if(finite(at))trim(at); }
    function startBuffer({at=now(),eligible=false}={}) {
      if(!eligible||!finite(at))return false;
      if(bufferStart===undefined)bufferStart=at;
      return true;
    }
    function endBuffer({at=now()}={}) {
      if(bufferStart===undefined)return false;
      if(!finite(at)||at<bufferStart){bufferStart=undefined;return false;}
      buffers.push({start:bufferStart,end:at});buffers=buffers.slice(-MAX_INTERVALS);bufferStart=undefined;trim(at);return true;
    }
    function recordCorrection({at=now(),magnitudeMs,kind='seek'}={}) {
      if(!finite(at)||!finite(magnitudeMs)||magnitudeMs<0||!['seek','jump'].includes(kind))return false;
      corrections.push({at,magnitudeMs,kind});corrections=corrections.slice(-MAX_CORRECTIONS);trim(at);return true;
    }
    function metricsAt(at) {
      trim(at);
      const cutoff=at-WINDOW_MS;
      let measuredMs=0,out250Ms=0,out500Ms=0,rateAdjustedMs=0,rateAdjustmentMs=0,bufferMs=0,presentationMs=0,positionMs=0;
      for(const interval of intervals) {
        const duration=Math.max(0,Math.min(at,interval.end)-Math.max(cutoff,interval.start));
        if(!duration)continue;
        measuredMs+=duration;
        if(interval.source==='position')positionMs+=duration;else presentationMs+=duration;
        if(interval.errorMs>250)out250Ms+=duration;
        if(interval.errorMs>500)out500Ms+=duration;
        if(Math.abs(interval.playbackRate-1)>.0005) {
          rateAdjustedMs+=duration;
          rateAdjustmentMs+=duration*Math.abs(interval.playbackRate-1);
        }
      }
      for(const interval of buffers)bufferMs+=Math.max(0,Math.min(at,interval.end)-Math.max(cutoff,interval.start));
      if(bufferStart!==undefined)bufferMs+=Math.max(0,at-Math.max(cutoff,bufferStart));
      return {measuredSeconds:measuredMs/1000,presentationMeasuredSeconds:presentationMs/1000,positionMeasuredSeconds:positionMs/1000,
        outOfSync250Seconds:out250Ms/1000,outOfSync500Seconds:out500Ms/1000,
        automaticCorrectionCount:corrections.length,automaticCorrectionMagnitudeMs:corrections.reduce((total,event)=>total+event.magnitudeMs,0),
        rateAdjustedSeconds:rateAdjustedMs/1000,correctionDutyCycle:measuredMs?rateAdjustedMs/measuredMs:undefined,
        rateAdjustmentSeconds:rateAdjustmentMs/1000,bufferingSeconds:bufferMs/1000,
        measurementFreshnessMs:lastActivityAt===undefined?undefined:Math.max(0,at-lastActivityAt),
         latestSource:points.at(-1)?.source,sampleCount:points.length};
    }
    function report(status,reason,metrics,rawScore,updated=false,confidence) {
      return {status,reason,score:smoothedScore,level:smoothedLevel,lastScore:smoothedScore,lastLevel:smoothedLevel,confidence:confidence||
        (hasMeasuredScore?'reduced':'provisional'),rawScore,updated,lastValidAt,metrics};
    }
    function refresh({at=now(),rttSampleCount,clockValid,clockAgeMs,clockUncertaintyMs,playbackStatus='unknown',unknownReason}={}) {
      if(!finite(at))return report(playbackStatus,'invalid-measurement-time',undefined,undefined);
      const metrics=metricsAt(at);
      const reduced=reason=>report(playbackStatus,reason,metrics,undefined,false,hasMeasuredScore?'reduced':'provisional');
      const evidenceAge=lastActivityAt===undefined?Infinity:Math.max(0,at-lastActivityAt);
      // Recent measured playback remains useful during a brief clock/frame gap
      // or pause. Retaining it never creates new samples or refreshes its age.
      const retained=(reason,longPause=false)=>hasMeasuredScore&&evidenceAge<=(longPause?PAUSED_EVIDENCE_MS:RECENT_EVIDENCE_MS)
        ?report(playbackStatus,reason,metrics,undefined,false,'confident'):reduced(reason);
      if(playbackStatus==='error')return reduced(unknownReason||'playback-error');
      if(playbackStatus==='paused')return retained(unknownReason||'paused',true);
      if(playbackStatus==='seeking')return retained(unknownReason||'seeking');
      if(playbackStatus==='starting')return reduced(unknownReason||'starting');
      if(!clockValid)return retained(unknownReason||'clock-unavailable');
      if(!finite(clockAgeMs)||clockAgeMs>MAX_CLOCK_AGE_MS)return retained(unknownReason||'clock-stale');
      if(!finite(clockUncertaintyMs)||clockUncertaintyMs>MAX_CLOCK_UNCERTAINTY_MS)
        return retained(unknownReason||'clock-low-confidence');
      const buffering=playbackStatus==='buffering'&&bufferStart!==undefined;
      const freshPoint=previousPoint!==undefined&&at-previousPoint.at<=2500;
      if(!(freshPoint||buffering))return retained(unknownReason||'measurement-stale');
      if(metrics.measuredSeconds<=0&&!buffering)return retained('awaiting-sync-interval');
      const rawScore=calculate({...metrics,bufferingSeconds:metrics.bufferingSeconds});
      if(rawScore===undefined)return retained('invalid-measurements');
      if(lastCalculatedAt===undefined||at-lastCalculatedAt>=REFRESH_INTERVAL_MS) {
        if(!hasMeasuredScore)smoothedScore=rawScore;
        else if(lastRawScore!==undefined&&rawScore>lastRawScore)smoothedScore=clamp(smoothedScore+(rawScore-lastRawScore)*.25,0,1);
        else if(rawScore<smoothedScore)smoothedScore=smoothedScore*.35+rawScore*.65;
        else smoothedScore=smoothedScore*.75+rawScore*.25;
        lastRawScore=rawScore;
        hasMeasuredScore=true;smoothedLevel=level(smoothedScore,smoothedLevel);lastCalculatedAt=at;lastValidAt=at;
        return report(playbackStatus,metrics.latestSource==='position'?'position-timing-estimate':undefined,metrics,rawScore,true,'confident');
      }
      return report(playbackStatus,metrics.latestSource==='position'?'position-timing-estimate':undefined,metrics,rawScore,false,'confident');
    }
    return {sample,breakSample,startBuffer,endBuffer,recordCorrection,refresh,reset,metricsAt};
  }
  const api={WINDOW_MS,REFRESH_INTERVAL_MS,MAX_CLOCK_AGE_MS,MAX_CLOCK_UNCERTAINTY_MS,RECENT_EVIDENCE_MS,PAUSED_EVIDENCE_MS,calculate,level,create};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.uburoomSyncQuality=api;
})(typeof globalThis==='object'?globalThis:this);
