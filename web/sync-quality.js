/* Playback quality evidence; independent from synchronization correction. */
(function(root) {
  'use strict';
  const WINDOW_MS=60000, SAMPLE_INTERVAL_MS=1000, INTERVAL_SLOTS=64, BUFFER_SLOTS=32, CORRECTION_SLOTS=64;
  const MAX_CLOCK_AGE_MS=5000, MAX_CLOCK_UNCERTAINTY_MS=1000;
  const RECENT_EVIDENCE_MS=12000, PAUSED_EVIDENCE_MS=120000;
  // Omit over-age evidence from reports to older servers that reject it with socket code 4002.
  const MAX_REPORT_FRESHNESS_MS=300000;
  const REFRESH_INTERVAL_MS=5000, STALE_AFTER_MS=15000;
  const finite=Number.isFinite;
  function clamp(value,min,max) { return Math.max(min,Math.min(max,value)); }
  function reportableMeasurementFreshnessMs(age) {
    return finite(age)&&age>=0&&age<=MAX_REPORT_FRESHNESS_MS?age:undefined;
  }
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
    if(!finite(measuredSeconds)||measuredSeconds<=0||!finite(outOfSync250Seconds)||outOfSync250Seconds<0||
      !finite(outOfSync500Seconds)||outOfSync500Seconds<0||!finite(automaticCorrectionCount)||automaticCorrectionCount<0||
      !finite(automaticCorrectionMagnitudeMs)||automaticCorrectionMagnitudeMs<0||!finite(rateAdjustedSeconds)||rateAdjustedSeconds<0||
      !finite(rateAdjustmentSeconds)||rateAdjustmentSeconds<0||!finite(bufferingSeconds)||bufferingSeconds<0)return undefined;
    const out250=clamp(outOfSync250Seconds/measuredSeconds,0,1);
    const out500=clamp(outOfSync500Seconds/measuredSeconds,0,1);
    const rateDuty=clamp(rateAdjustedSeconds/measuredSeconds,0,1);
    const penalty=out250+2*out500+.03*automaticCorrectionCount+.00004*automaticCorrectionMagnitudeMs+
      1.4*rateDuty+.15*rateAdjustmentSeconds+2.5*(bufferingSeconds/60);
    const score=Math.exp(-penalty);
    return finite(score)?clamp(score,0,1):undefined;
  }
  function create({now=()=>performance.now()}={}) {
    const intervals=Array.from({length:INTERVAL_SLOTS},()=>({start:0,end:0,errorMs:0,playbackRate:1,source:'presentation'}));
    const buffers=Array.from({length:BUFFER_SLOTS},()=>({start:0,end:0}));
    const corrections=Array.from({length:CORRECTION_SLOTS},()=>({at:0,magnitudeMs:0}));
    let intervalCount=0,bufferCount=0,correctionCount=0;
    let context,clockRevision,previousPoint,latestSource,bufferStart,lastCalculatedAt,lastValidAt,lastActivityAt,lastRawScore;
    let smoothedScore=1,smoothedLevel='excellent',hasMeasuredScore=false;
    function clearWindow() {
      intervalCount=bufferCount=correctionCount=0;
      previousPoint=latestSource=bufferStart=lastCalculatedAt=lastRawScore=undefined;
    }
    function reset(nextContext,{preserveLast=true}={}) {
      if(!preserveLast){smoothedScore=1;smoothedLevel='excellent';lastValidAt=undefined;hasMeasuredScore=false;}
      context=nextContext;clockRevision=undefined;lastActivityAt=undefined;clearWindow();
    }
    function sample({at=now(),errorMs,playbackRate=1,eligible,source='presentation',context:nextContext,clockRevision:nextRevision}={}) {
      if(context!==nextContext)reset(nextContext);
      if(!finite(at))return false;
      if(clockRevision!==nextRevision){clockRevision=nextRevision;clearWindow();}
      if(!eligible||!finite(errorMs)||!finite(playbackRate)||playbackRate<=0){previousPoint=undefined;return false;}
      if(previousPoint&&at<previousPoint.at){previousPoint=undefined;return false;}
      if(previousPoint&&at-previousPoint.at<SAMPLE_INTERVAL_MS-50)return false;
      if(previousPoint&&at-previousPoint.at<=2500) {
        const slot=intervals[intervalCount++%INTERVAL_SLOTS];
        slot.start=previousPoint.at;slot.end=at;slot.errorMs=previousPoint.errorMs;
        slot.playbackRate=previousPoint.playbackRate;slot.source=previousPoint.source;
      }
      latestSource=source==='position'?'position':'presentation';
      previousPoint={at,errorMs:Math.abs(errorMs),playbackRate,source:latestSource};
      lastActivityAt=at;return true;
    }
    function breakSample(at=now()) { previousPoint=undefined;if(finite(at)&&bufferStart!==undefined&&at<bufferStart)bufferStart=undefined; }
    function startBuffer({at=now(),eligible=false}={}) {
      if(!eligible||!finite(at))return false;
      if(bufferStart===undefined)bufferStart=at;
      return true;
    }
    function endBuffer({at=now()}={}) {
      if(bufferStart===undefined)return false;
      if(!finite(at)||at<bufferStart){bufferStart=undefined;return false;}
      const slot=buffers[bufferCount++%BUFFER_SLOTS];
      slot.start=bufferStart;slot.end=at;bufferStart=undefined;return true;
    }
    function recordCorrection({at=now(),magnitudeMs,kind='seek'}={}) {
      if(!finite(at)||!finite(magnitudeMs)||magnitudeMs<0||(kind!=='seek'&&kind!=='jump'))return false;
      const slot=corrections[correctionCount++%CORRECTION_SLOTS];
      slot.at=at;slot.magnitudeMs=magnitudeMs;return true;
    }
    function metricsAt(at) {
      const cutoff=at-WINDOW_MS;
      let measuredMs=0,out250Ms=0,out500Ms=0,rateAdjustedMs=0,rateAdjustmentMs=0,bufferMs=0,presentationMs=0,positionMs=0;
      let autoCount=0,autoMagnitudeMs=0,sampleCount=0;
      const intervalLimit=Math.min(intervalCount,INTERVAL_SLOTS);
      for(let i=0;i<intervalLimit;i++) {
        const slot=intervals[i],duration=Math.min(at,slot.end)-Math.max(cutoff,slot.start);
        if(!(duration>0))continue;
        sampleCount++;measuredMs+=duration;
        if(slot.source==='position')positionMs+=duration;else presentationMs+=duration;
        if(slot.errorMs>250)out250Ms+=duration;
        if(slot.errorMs>500)out500Ms+=duration;
        const rateDelta=Math.abs(slot.playbackRate-1);
        if(rateDelta>.0005){rateAdjustedMs+=duration;rateAdjustmentMs+=duration*rateDelta;}
      }
      if(previousPoint&&previousPoint.at>=cutoff&&previousPoint.at<=at)sampleCount++;
      const bufferLimit=Math.min(bufferCount,BUFFER_SLOTS);
      for(let i=0;i<bufferLimit;i++) {
        const slot=buffers[i],duration=Math.min(at,slot.end)-Math.max(cutoff,slot.start);
        if(duration>0)bufferMs+=duration;
      }
      if(bufferStart!==undefined&&at>bufferStart)bufferMs+=Math.max(0,at-Math.max(cutoff,bufferStart));
      const correctionLimit=Math.min(correctionCount,CORRECTION_SLOTS);
      for(let i=0;i<correctionLimit;i++) {
        const slot=corrections[i];
        if(slot.at>=cutoff&&slot.at<=at){autoCount++;autoMagnitudeMs+=slot.magnitudeMs;}
      }
      return {measuredSeconds:measuredMs/1000,presentationMeasuredSeconds:presentationMs/1000,positionMeasuredSeconds:positionMs/1000,
        outOfSync250Seconds:out250Ms/1000,outOfSync500Seconds:out500Ms/1000,automaticCorrectionCount:autoCount,
        automaticCorrectionMagnitudeMs:autoMagnitudeMs,rateAdjustedSeconds:rateAdjustedMs/1000,
        correctionDutyCycle:measuredMs?rateAdjustedMs/measuredMs:undefined,rateAdjustmentSeconds:rateAdjustmentMs/1000,
        bufferingSeconds:bufferMs/1000,measurementFreshnessMs:lastActivityAt===undefined?undefined:Math.max(0,at-lastActivityAt),
        latestSource:sampleCount?latestSource:undefined,sampleCount};
    }
    function report(status,reason,metrics,rawScore,updated=false,confidence) {
      return {status,reason,score:smoothedScore,level:smoothedLevel,lastScore:smoothedScore,lastLevel:smoothedLevel,
        confidence:confidence||(hasMeasuredScore?'reduced':'provisional'),rawScore,updated,lastValidAt,metrics};
    }
    function refresh({at=now(),clockValid,clockAgeMs,clockUncertaintyMs,playbackStatus='unknown',unknownReason}={}) {
      if(!finite(at))return report(playbackStatus,'invalid-measurement-time',undefined,undefined);
      const metrics=metricsAt(at),reduced=reason=>report(playbackStatus,reason,metrics,undefined,false,hasMeasuredScore?'reduced':'provisional');
      const evidenceAge=lastActivityAt===undefined?Infinity:Math.max(0,at-lastActivityAt);
      const retained=(reason,longPause=false)=>hasMeasuredScore&&evidenceAge<=(longPause?PAUSED_EVIDENCE_MS:RECENT_EVIDENCE_MS)
        ?report(playbackStatus,reason,metrics,undefined,false,'confident'):reduced(reason);
      if(playbackStatus==='error')return reduced(unknownReason||'playback-error');
      if(playbackStatus==='paused')return retained(unknownReason||'paused',true);
      if(playbackStatus==='seeking')return retained(unknownReason||'seeking');
      if(playbackStatus==='starting')return reduced(unknownReason||'starting');
      if(!clockValid)return retained(unknownReason||'clock-unavailable');
      if(!finite(clockAgeMs)||clockAgeMs>MAX_CLOCK_AGE_MS)return retained(unknownReason||'clock-stale');
      if(!finite(clockUncertaintyMs)||clockUncertaintyMs>MAX_CLOCK_UNCERTAINTY_MS)return retained(unknownReason||'clock-low-confidence');
      const buffering=playbackStatus==='buffering'&&bufferStart!==undefined;
      const freshPoint=previousPoint!==undefined&&at-previousPoint.at<=2500;
      if(!(freshPoint||buffering))return retained(unknownReason||'measurement-stale');
      if(metrics.measuredSeconds<=0&&!buffering)return retained('awaiting-sync-interval');
      const rawScore=calculate(metrics);
      if(rawScore===undefined)return retained('invalid-measurements');
      if(lastCalculatedAt===undefined||at-lastCalculatedAt>=REFRESH_INTERVAL_MS) {
        if(!hasMeasuredScore)smoothedScore=rawScore;
        else if(lastRawScore!==undefined&&rawScore>lastRawScore)smoothedScore=clamp(smoothedScore+(rawScore-lastRawScore)*.25,0,1);
        else if(rawScore<smoothedScore)smoothedScore=smoothedScore*.35+rawScore*.65;
        else smoothedScore=smoothedScore*.75+rawScore*.25;
        lastRawScore=rawScore;hasMeasuredScore=true;smoothedLevel=level(smoothedScore,smoothedLevel);
        lastCalculatedAt=at;lastValidAt=at;
        return report(playbackStatus,metrics.latestSource==='position'?'position-timing-estimate':undefined,metrics,rawScore,true,'confident');
      }
      return report(playbackStatus,metrics.latestSource==='position'?'position-timing-estimate':undefined,metrics,rawScore,false,'confident');
    }
    return {sample,breakSample,startBuffer,endBuffer,recordCorrection,refresh,reset,metricsAt};
  }
  const api={WINDOW_MS,REFRESH_INTERVAL_MS,MAX_CLOCK_AGE_MS,MAX_CLOCK_UNCERTAINTY_MS,RECENT_EVIDENCE_MS,PAUSED_EVIDENCE_MS,
    MAX_REPORT_FRESHNESS_MS,reportableMeasurementFreshnessMs,calculate,level,create};
  if(typeof module==='object'&&module.exports)module.exports=api;else root.uburoomSyncQuality=api;
})(typeof globalThis==='object'?globalThis:this);
