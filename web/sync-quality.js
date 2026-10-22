/* Rolling playback synchronization quality; independent from sync correction. */
(function(root) {
  'use strict';
  const WINDOW_MS = 30000, SAMPLE_INTERVAL_MS = 1000, MAX_SAMPLES = 32;
  const MIN_SYNC_SAMPLES = 10, MIN_RTT_SAMPLES = 5, REFRESH_INTERVAL_MS = 5000;
  const finite = Number.isFinite;
  function percentile95(values) {
    if (!Array.isArray(values) || values.length < MIN_SYNC_SAMPLES || values.some(value => !finite(value) || value < 0)) return undefined;
    const sorted = values.slice().sort((a,b) => a-b);
    return sorted[Math.max(0,Math.ceil(sorted.length*.95)-1)];
  }
  function calculate({errorsMs,jitterMs,bufferSeconds}) {
    const error95Ms = percentile95(errorsMs);
    if (error95Ms === undefined || !finite(jitterMs) || jitterMs < 0 || !finite(bufferSeconds) || bufferSeconds < 0) return undefined;
    const score = Math.exp(-(((error95Ms/150)**2) + ((jitterMs/100)**2) + (bufferSeconds/3)));
    return finite(score) ? Math.max(0,Math.min(1,score)) : undefined;
  }
  function level(score) {
    if (!finite(score) || score < 0 || score > 1) return undefined;
    if (score >= .90) return 'excellent';
    if (score >= .75) return 'good';
    if (score >= .50) return 'fair';
    return 'poor';
  }
  function create({now = () => performance.now()} = {}) {
    let context, clockRevision, errors = [], buffers = [], bufferStart, lastSampleAt, lastCalculatedAt, smoothed;
    function reset(nextContext, nextRevision) {
      context = nextContext; clockRevision = nextRevision;
      errors = []; buffers = []; bufferStart = lastSampleAt = lastCalculatedAt = smoothed = undefined;
    }
    function sample({at = now(),errorMs,eligible,context:nextContext,clockRevision:nextRevision}) {
      if (context !== nextContext || clockRevision !== nextRevision) reset(nextContext,nextRevision);
      if (!eligible || !finite(at) || !finite(errorMs)) return false;
      if (lastSampleAt !== undefined && at < lastSampleAt) { reset(nextContext,nextRevision); }
      if (lastSampleAt !== undefined && at-lastSampleAt < SAMPLE_INTERVAL_MS-50) return false;
      const gapWasMeasuredBuffering = buffers.some(value => value.start <= at && value.end >= lastSampleAt);
      if (lastSampleAt !== undefined && at-lastSampleAt > 2500 && bufferStart === undefined && !gapWasMeasuredBuffering) {
        errors = []; buffers = []; smoothed = lastCalculatedAt = undefined;
      }
      errors.push({at,error:Math.abs(errorMs)});
      errors = errors.filter(value => at-value.at <= WINDOW_MS).slice(-MAX_SAMPLES);
      lastSampleAt = at;
      return true;
    }
    function startBuffer({at = now(),eligible = false} = {}) {
      if (!eligible || !finite(at) || lastSampleAt === undefined || at-lastSampleAt > 2500 || at < lastSampleAt) return false;
      if (bufferStart === undefined) bufferStart = at;
      return true;
    }
    function endBuffer({at = now()} = {}) {
      if (bufferStart === undefined) return false;
      if (!finite(at) || at < bufferStart) { bufferStart = undefined; return false; }
      buffers.push({start:bufferStart,end:at}); buffers = buffers.slice(-MAX_SAMPLES); bufferStart = undefined;
      return true;
    }
    function bufferedSeconds(at) {
      const start = at-WINDOW_MS;
      return buffers.reduce((total,entry) => total+Math.max(0,Math.min(at,entry.end)-Math.max(start,entry.start))/1000,0) +
        (bufferStart === undefined ? 0 : Math.max(0,at-Math.max(start,bufferStart))/1000);
    }
    function refresh({at = now(),jitterMs,rttSampleCount,clockValid,clockAgeMs,active = false} = {}) {
      if (!finite(at)) return {status:'unknown'};
      errors = errors.filter(value => at-value.at <= WINDOW_MS);
      buffers = buffers.filter(value => at-value.end <= WINDOW_MS);
      const buffering = bufferStart !== undefined;
      const freshPlayback = lastSampleAt !== undefined && at-lastSampleAt <= 2500;
      if (!clockValid || !finite(clockAgeMs) || clockAgeMs > 2500 || !(active && (freshPlayback || buffering))) {
        if (!clockValid || !finite(clockAgeMs) || clockAgeMs > 2500) reset(context,clockRevision);
        return {status:'unknown'};
      }
      const raw = errors.length >= MIN_SYNC_SAMPLES && finite(rttSampleCount) && rttSampleCount >= MIN_RTT_SAMPLES ?
        calculate({errorsMs:errors.map(value => value.error),jitterMs,bufferSeconds:bufferedSeconds(at)}) : undefined;
      if (raw === undefined) return {status:'unknown'};
      if (lastCalculatedAt !== undefined && at-lastCalculatedAt < REFRESH_INTERVAL_MS) return smoothed === undefined ? {status:'unknown'} : {status:'known',score:smoothed,updated:false};
      smoothed = smoothed === undefined ? raw : smoothed*.65+raw*.35;
      lastCalculatedAt = at;
      return {status:'known',score:Math.max(0,Math.min(1,smoothed)),updated:true};
    }
    return {sample,startBuffer,endBuffer,refresh,reset:() => reset(undefined,undefined),bufferedSeconds:at => bufferedSeconds(at)};
  }
  const api = {WINDOW_MS,MIN_SYNC_SAMPLES,MIN_RTT_SAMPLES,calculate,percentile95,level,create};
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.uburoomSyncQuality = api;
})(typeof globalThis === 'object' ? globalThis : this);
