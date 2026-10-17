/* Initial scheduling UI/cancellation and independent ongoing recovery checks. */
'use strict';
const assert=require('node:assert/strict'),path=require('node:path');
const {pause}=require('./playback-browser');
async function startLifecycle({host,guest,h,g,app,room,output}) {
  const load=()=>host.evaluate(h,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
  const pending=()=>host.until(h,'state?.startAt>playbackClock.read().serverTime+300 && !state.waitingForReady && video.paused','Scheduled paused preparation');
  const result={cancelledLayouts:[]};
  for(const [layout,width,height,theater]of[['desktop',1280,800,false],['theater',1280,800,true],['phone',390,844,true]]) {
    await host.viewport(h,width,height);await host.evaluate(h,'setTheater('+theater+');true');
    await load();await pending();await host.evaluate(h,'renderTransport();true');
    assert.equal(await host.evaluate(h,'document.getElementById("ready-status").textContent'),'Starting together…');
    assert.equal(await host.evaluate(h,'document.documentElement.scrollWidth<=innerWidth'),true,'Scheduled status must fit the existing layout');
    await host.screenshot(h,path.join(output,'scheduled-'+layout+'.png'));
    const deadline=app.watch.rooms.get(room).startAt;
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>true)');
    await guest.evaluate(g,'refreshState().then(()=>true)');
    await pause(Math.max(0,deadline-Date.now())+250);
    for(const [browser,page]of[[host,h],[guest,g]])assert.equal(await browser.evaluate(page,'video.paused && state.state.paused && !state.startAt'),true,'Cancelled start cannot fire later');
    result.cancelledLayouts.push(layout);
  }
  await host.viewport(h,1280,800);await load();await pending();
  const oldDeadline=app.watch.rooms.get(room).startAt,oldVersion=app.watch.rooms.get(room).mediaVersion;
  // Separate the deadlines deliberately; fast local loads can finish within 200 ms.
  await pause(300);
  await load();await pending();
  const newDeadline=app.watch.rooms.get(room).startAt;
  assert.notEqual(app.watch.rooms.get(room).mediaVersion,oldVersion);
  assert.ok(newDeadline>oldDeadline+200,'Replacement must establish a separate later start');
  await pause(Math.max(0,oldDeadline-Date.now())+100);
  assert.equal(await host.evaluate(h,'video.paused'),true,'Superseded start cannot play replacement early');
  result.replacementCancelled=true;
  await Promise.all([[host,h],[guest,g]].map(([browser,page])=>browser.until(page,'!video.paused && videoFrames>24 && video.currentTime>1','Scheduled decoded playback')));
  const active=app.watch.rooms.get(room),streams=[...active.viewers.values()].map(v=>v.streamVersion),deadline=active.startAt;
  const before=await host.evaluate(h,'video.currentTime'),sequence=await host.evaluate(h,'diagnosticSample();diagnostics.snapshot().entries.at(-1).sequence');
  await guest.evaluate(g,'probing=true;video.pause();playerWaiting=true;api("/api/watch/rooms/"+selected+"/ready",{viewerId,mediaVersion:state.mediaVersion,ready:false}).then(()=>true)');
  await pause(3000);const after=await host.evaluate(h,'video.currentTime');assert.ok(after>before+2);
  assert.equal(active.s.state.paused,false);assert.equal(active.startAt,deadline,'Ongoing buffering cannot reschedule healthy viewers');
  assert.deepEqual([...active.viewers.values()].map(v=>v.streamVersion),streams);
  assert.equal(await host.evaluate(h,'diagnostics.snapshot().entries.some(r=>r.sequence>'+sequence+'&&["pause","waiting","stalled"].includes(r.event))'),false);
  await guest.evaluate(g,'probing=false;playerWaiting=false;sync.synchronize().then(()=>true)');
  await guest.until(g,'!video.paused && !video.seeking && Math.abs(video.currentTime-expected())<.3','Independent catch-up');
  result.independentRecovery={hostAdvancedSeconds:after-before,noHostPauseOrWait:true,streamsPreserved:true,startNotRescheduled:true};
  return result;
}
module.exports={startLifecycle};
