/* Disposable decoded browsers and local fixture only; never loads .env. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createApp} = require('../server/app');
const {playbackBrowser,pause} = require('./lib/playback-browser');
async function main() {
  const root = path.resolve(__dirname,'..'), name = process.argv.find(arg => arg.startsWith('--browser='))?.slice(10) || 'firefox';
  const output = path.join(root,'artifacts','sync-controls-' + name); fs.mkdirSync(output,{recursive:true});
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['channel'],demo:true};
  const app = createApp(config,{oauthFetch:async()=>{throw new Error('Live OAuth disabled');},plexFetch:async()=>{throw new Error('Live Plex disabled');}});
  app.hub.access = {refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  const ready = app.watch.ready.bind(app.watch); let held = true;
  app.watch.ready = (room,actor,viewer,version,value,generation) => ready(room,actor,viewer,version,held && actor.userId === 'demo-guest' ? false : value,generation);
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl = 'https://localhost:' + app.server.address().port;
  let host,guest;
  try {
    host = await playbackBrowser(name); guest = await playbackBrowser(name);
    const h = await host.page(config.publicUrl+'/watch?demo=host'), g = await guest.page(config.publicUrl+'/watch?demo=guest');
    const clients = [[host,h],[guest,g]];
    for (const [browser,page] of clients) await browser.until(page,'typeof transport!=="undefined" && transport?.ready','Fixture authentication');
    await host.evaluate(h,'createRoom().then(()=>true)'); const roomId = await host.evaluate(h,'selected');
    await guest.evaluate(g,'selectRoom('+JSON.stringify(roomId)+').then(()=>true)');
    await host.evaluate(h,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
    const room = app.watch.rooms.get(roomId);
    await host.until(h,'state?.readiness?.blockers.includes("Demo guest")','Named blocker after three seconds');
    // Unit tests verify exact deadlines; shorten only this fixture's wait for UI checks.
    room.readinessDeadline = performance.now()-1; app.watch.refresh(room);
    await host.until(h,'state?.readiness?.timedOut && !document.getElementById("readiness-choice").hidden','Host timeout choices');
    assert.equal(await guest.evaluate(g,'document.getElementById("readiness-choice").hidden'),true);
    await host.viewport(h,1360,900); await host.screenshot(h,path.join(output,'timeout-desktop.png'));
    await host.evaluate(h,'setTheater(true);true'); await host.screenshot(h,path.join(output,'timeout-theater.png'));
    await host.viewport(h,390,844); await host.screenshot(h,path.join(output,'timeout-phone.png'));
    await host.evaluate(h,'setTheater(false);true'); await host.screenshot(h,path.join(output,'timeout-phone-normal.png'));
    await host.evaluate(h,'document.getElementById("ready-wait").click();true');
    await host.until(h,'!state.readiness.timedOut && !pending','Wait extends preparation');
    assert.ok(room.readinessDeadline-performance.now()>13000);
    room.readinessDeadline = performance.now()-1; app.watch.refresh(room);
    await host.until(h,'state.readiness.timedOut','Second timeout');
    await host.evaluate(h,'document.getElementById("ready-cancel").click();true');
    await host.until(h,'!state.readiness && state.state.paused && !pending','Cancel stays paused');
    await host.evaluate(h,'execute({action:"media.play"}).then(()=>true)');
    await host.until(h,'state.waitingForReady','Explicit play opens another gate');
    room.readinessDeadline = performance.now()-1; app.watch.refresh(room);
    await host.until(h,'state.readiness?.timedOut && !document.getElementById("ready-start").disabled','Ready subset can start');
    await host.evaluate(h,'document.getElementById("ready-start").click();true');
    await host.until(h,'!video.paused && video.currentTime>.5 && !pending','Host starts ready subset');
    held = false; await guest.evaluate(g,'readinessSent=undefined;reportReadiness().then(()=>true)');
    await guest.until(g,'!video.paused && videoFrames>10','Guest joins moving timeline');
    for (const [browser,page] of clients) await browser.evaluate(page,'globalThis.controlEvents=[];for(const kind of ["pause","playing"])video.addEventListener(kind,()=>controlEvents.push({kind,time:playbackClock.read().serverTime,position:video.currentTime}));true');
    await host.evaluate(h,'execute({action:"media.pause"}).then(()=>true)');
    for (const [browser,page] of clients) await browser.until(page,'video.paused && state.state.paused','Scheduled pause');
    const paused = await Promise.all(clients.map(([browser,page]) => browser.evaluate(page,'video.currentTime')));
    await host.evaluate(h,'execute({action:"media.play"}).then(()=>true)');
    for (const [browser,page] of clients) await browser.until(page,'!video.paused && !state.state.paused','Scheduled resume');
    const before = await host.evaluate(h,'video.currentTime');
    await guest.evaluate(g,'probing=true;video.pause();playerWaiting=true;true'); await pause(1500);
    assert.ok(await host.evaluate(h,'video.currentTime') > before+1,'A local stall must not stop healthy viewers');
    await guest.evaluate(g,'probing=false;playerWaiting=false;synchronize().then(()=>true)');
    const report = {browser:name,versions:[host.version,guest.version],passed:true,pausedPositions:paused,
      events:await Promise.all(clients.map(async([browser,page]) => JSON.parse(await browser.evaluate(page,'JSON.stringify(controlEvents)')))),
      limitations:'Local synthetic direct media; fixture-shortened timeout, no physical presentation or WAN accuracy claim.'};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify(report));
  } finally {await Promise.allSettled([host?.close(),guest?.close()]); await app.close();}
}
main().catch(error => {console.error(error);process.exitCode=1;});
