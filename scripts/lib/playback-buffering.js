/* Real browser buffer behavior against isolated, generated on-demand sources. */
'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { pause } = require('./playback-browser');
async function checkBuffering({browser,page,source,mediaControl,output,label}) {
  const evaluate = expression => browser.evaluate(page,expression);
  const snapshot = () => evaluate('JSON.stringify({position:video.currentTime,frames:decodedFrames(),error:playbackError,paused:video.paused,seeking:video.seeking,ready:video.readyState,format:state.format,loaded:uburoomPlayback.bufferedAhead(video.buffered,video.currentTime),ranges:uburoomPlayback.ranges(video.buffered,state.state.duration),retainedBytes:av1?.retainedBytes ?? null,sample:playbackMeter.sample()})').then(JSON.parse);
  await evaluate('execute({action:"media.pause"}).then(()=>true)');
  await browser.until(page,'video.paused && !video.seeking','Pause before filling');
  const goal = await evaluate('state.format === "av1" ? 54 : state.format === "hls" && hls ? Math.min(50,hls.config.maxBufferLength-1) : 40');
  await browser.until(page,`uburoomPlayback.bufferedAhead(video.buffered,video.currentTime)>=${goal} && !playbackError`,'Paused ahead buffer',60000);
  const filled = await snapshot();
  assert.ok(filled.retainedBytes === null || filled.retainedBytes <= 64*1024*1024,'encoded AV1 cache respects its byte budget');
  await browser.viewport(page,1360,1050); await pause(2800);
  await browser.screenshot(page,path.join(output,label+'-desktop.png'));
  await evaluate('setTheater(true); true'); await pause(150);
  await browser.screenshot(page,path.join(output,label+'-theater.png'));
  await evaluate('setTheater(false); true');
  await browser.viewport(page,390,1000); await pause(150);
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'phone layout fits');
  await browser.screenshot(page,path.join(output,label+'-phone.png'));
  await browser.viewport(page,1360,1050);
  // Only media delivery is interrupted. Control polls must keep renewing the
  // authorized viewer; a full control disconnect still unloads the player.
  mediaControl.blocked = true;
  let outageStart, outageEnd;
  try {
    await evaluate('execute({action:"media.play"}).then(()=>true)');
    await browser.until(page,'!video.paused && !video.seeking','Resume from cached data');
    outageStart = await snapshot();
    for (let i = 0; i < 40; i++) { await pause(250); await evaluate('playbackMeter.sample(); true'); }
    outageEnd = await snapshot();
    assert.equal(outageEnd.error,'');
    assert.ok(outageEnd.position-outageStart.position > 9,'playback advances through a ten-second media outage');
    assert.ok(outageEnd.frames-outageStart.frames > source.expectedFps*8,'picture continues decoding during the outage');
    const audioSamples = await evaluate('playbackMeter.report().samples.slice(-40).filter(s=>s.audioDb > -65 && Math.abs(s.audioHz-440)<20).length');
    assert.ok(audioSamples > 20,'decoded audio continues during the outage');
    const stalls = await evaluate(`playbackMeter.report().events.filter(e=>["waiting","stalled"].includes(e.event) && e.elapsedMs > ${outageStart.sample.elapsedMs}).length`);
    assert.equal(stalls,0,'no rebuffer event during the media outage');
    outageEnd.audioSamples = audioSamples; outageEnd.stalls = stalls;
    await evaluate('execute({action:"media.pause"}).then(()=>true)');
    await browser.until(page,'video.paused && !video.seeking','Pause after outage');
    const current = await snapshot(), rewind = current.position - 5;
    assert.ok(current.ranges.some(([start,end])=>rewind>=start && rewind<end),'rewind target is cached');
    const requests = mediaControl.requests.length;
    await evaluate(`execute({action:"media.seek.absolute",args:{seconds:${rewind}}}).then(()=>true)`);
    await browser.until(page,`video.paused && !video.seeking && video.readyState>=2 && Math.abs(video.currentTime-${rewind})<.7`,'Cached rewind during media outage',10000);
    assert.equal((await snapshot()).error,'');
    // New ahead prefetches may still fail while rewinding. Record them rather
    // than claiming zero network traffic; the cached seek itself must complete.
    outageEnd.rewind = {target:rewind,requestsDuringSeek:mediaControl.requests.length-requests};
  } finally { mediaControl.blocked = false; }
  const beforeSeek = await snapshot();
  const failedChunk = await evaluate('av1?.prefetchFailure?.index ?? null');
  // When the outage broke speculative AV1 preparation, seek into that very
  // chunk to verify recovery rather than bypassing the failed source time.
  const destination = failedChunk !== null && failedChunk*6 < source.duration-3 ? failedChunk*6+.3 : source.duration-4;
  const destinationWasBuffered = beforeSeek.ranges.some(([start,end])=>destination>=start && destination<end);
  const started = Date.now();
  await evaluate(`execute({action:"media.seek.absolute",args:{seconds:${destination}}}).then(()=>true)`);
  await browser.until(page,`!video.seeking && video.readyState>=2 && Math.abs(video.currentTime-${destination})<.7 && !playbackError`,'Distant seek after media recovery',30000);
  await evaluate('execute({action:"media.play"}).then(()=>true)');
  await browser.until(page,`!video.paused && video.currentTime>${destination+1}`,'Playback after distant seek',15000);
  const recovered = await snapshot();
  assert.equal(recovered.error,'');
  return {goalSeconds:goal,filled,outageSeconds:10,outageStart,outageEnd,distantSeek:{destination,failedChunk,destinationWasBuffered,recoveryMs:Date.now()-started},recovered,
    limitation:'Synthetic media delivery outage only. Control remains reachable; decoded PCM is not physical audio output.'};
}
module.exports = {checkBuffering};
