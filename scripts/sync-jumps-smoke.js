/* Disposable decoded browsers and local fixture only; never loads .env. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createApp} = require('../server/app');
const {playbackBrowser,pause} = require('./lib/playback-browser');
const {fixturePlex} = require('./playback-baseline');
async function main() {
  const root = path.resolve(__dirname,'..'), name = process.argv.find(arg => arg.startsWith('--browser='))?.slice(10) || 'firefox';
  const baseline = process.argv.includes('--baseline'), hls = process.argv.includes('--hls');
  const output = path.join(root,'artifacts','sync-jumps-' + name+(hls?'-hls':'')); fs.mkdirSync(output,{recursive:true});
  const directory=path.join(root,'artifacts/playback-media-recovery-120');
  const plexFetch=hls?fixturePlex(directory,JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')))):async()=>{throw new Error('Live Plex disabled');};
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['channel'],demo:true,
    ...(hls?{plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'}:{})};
  const app = createApp(config,{oauthFetch:async()=>{throw new Error('Live OAuth disabled');},plexFetch});
  app.hub.access = {refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  if(hls)app.hub.plexFor=async actor=>app.watch.plex.scope('synthetic-playback-only',actor.userId);
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl = 'https://localhost:' + app.server.address().port;
  let host,guest,h,g;
  try {
    host = await playbackBrowser(name); guest = await playbackBrowser(name);
    h = await host.page(config.publicUrl+'/watch?demo=host'); g = await guest.page(config.publicUrl+'/watch?demo=guest');
    for (const [browser,page] of [[host,h],[guest,g]]) await browser.until(page,'typeof transport!=="undefined" && transport?.ready','Fixture authentication');
    await host.evaluate(h,'preferredQuality='+JSON.stringify(hls?'1080p20':'direct')+';createRoom().then(()=>true)'); const roomId = await host.evaluate(h,'selected');
    await guest.evaluate(g,'preferredQuality='+JSON.stringify(hls?'1080p20':'direct')+';selectRoom('+JSON.stringify(roomId)+').then(()=>true)');
    await host.evaluate(h,'execute({action:"media.load",args:{mediaId:'+JSON.stringify(hls?'104':'demo')+',quality:'+JSON.stringify(hls?'1080p20':'direct')+'}}).then(()=>true)');
    await guest.until(g,'!state.waitingForReady && !video.paused && videoFrames>10 && video.currentTime>1','Guest decoded playback');
    if(!baseline)await guest.evaluate(g,'document.getElementById("sync-correction").value="jumps";document.getElementById("sync-correction").dispatchEvent(new Event("change"));true');
    for(const [browser,page,prefix] of [[guest,g,''],[host,h,'host-']]) {
      for (const [label,width,height,theater] of [['desktop',1360,900,false],['theater',1360,900,true],['phone',390,844,false],['phone-theater',390,844,true]]) {
        await browser.viewport(page,width,height);
        await browser.evaluate(page,'setTheater('+theater+');'+(theater?'toggleDrawer(true);':'')+'document.getElementById("options-panel").scrollIntoView({block:"center"});true');
        if(!baseline)await browser.evaluate(page,'document.getElementById("tracks-open").click();if(!document.getElementById("tracks-dialog").open)document.getElementById("settings-more").click();true');
        await browser.screenshot(page,path.join(output,(baseline?'before-':'after-')+prefix+label+'.png'));
        if(!baseline)assert.ok(await browser.evaluate(page,'(()=>{const r=document.getElementById("sync-correction").getBoundingClientRect();return r.width>0&&r.left>=0&&r.right<=innerWidth;})()'),'Sync selector fits '+prefix+label);
        if(!baseline)await browser.evaluate(page,'document.getElementById("tracks-dialog").close();true');
      }
      await browser.evaluate(page,'setTheater(false);true');
    }
    if (baseline) {console.log('Baseline Options renders saved to '+output);return;}
    await guest.evaluate(g,'setTheater(false);true');
    assert.equal(await host.evaluate(h,'syncCorrectionMode'),'speed','Host retains its own default');
    assert.equal(await guest.evaluate(g,'state.format'),hls?'hls':'file');
    await guest.until(g,'!video.seeking&&!playerWaiting&&uburoomPlayback.bufferedAhead(video.buffered,expected())>3','Buffered correction destination');
    const room=app.watch.rooms.get(roomId),revision=room.revision,readinessId=room.readinessId;
    const hostBefore=JSON.parse(await host.evaluate(h,'JSON.stringify({position:video.currentTime,frames:videoFrames})'));
    await guest.evaluate(g,'globalThis.jumpRates=[];globalThis.jumpEvents=[];globalThis.jumpTick=setInterval(()=>jumpRates.push(video.playbackRate),100);for(const event of ["seeking","seeked","waiting","playing"])video.addEventListener(event,()=>jumpEvents.push({event,at:performance.now(),position:video.currentTime,frames:videoFrames}));video.currentTime=expected()-.4;true');
    const count='diagnostics.snapshot().entries.filter(e=>e.event==="sync-jump").length';
    await guest.until(g,count+'===1','Behind viewer jumps forward',10000);
    const forwardFrames=await guest.evaluate(g,'videoFrames');
    await guest.until(g,'!video.seeking&&!playerWaiting&&videoFrames>'+ (forwardFrames+2),'Decoded forward recovery');
    const forwardResidualMs=await guest.evaluate(g,'(video.currentTime-expected())*1000');
    // Opposite drift during cooldown must stay at normal speed without another jump.
    await guest.evaluate(g,'video.currentTime=expected()+.4;true');await pause(4000);
    assert.equal(await guest.evaluate(g,count),1,'Cooldown survives seek/refill events');
    await guest.until(g,count+'===2','Ahead viewer jumps backward after cooldown',12000);
    const backwardFrames=await guest.evaluate(g,'videoFrames');
    await guest.until(g,'!video.seeking&&!playerWaiting&&videoFrames>'+(backwardFrames+2),'Decoded backward recovery');
    const backwardResidualMs=await guest.evaluate(g,'(video.currentTime-expected())*1000');
    const rates=JSON.parse(await guest.evaluate(g,'clearInterval(jumpTick);JSON.stringify(jumpRates)'));
    assert.ok(rates.length>50&&rates.every(rate=>rate===1),'Every observed jump-mode rate remains 1.00x');
    assert.equal(room.revision,revision,'Personal correction does not mutate shared timeline');
    assert.equal(room.readinessId,readinessId,'Personal correction never opens a shared readiness gate');
    const hostAfter=JSON.parse(await host.evaluate(h,'JSON.stringify({position:video.currentTime,frames:videoFrames})'));
    assert.ok(hostAfter.position>hostBefore.position+8&&hostAfter.frames>hostBefore.frames+100,'Host keeps decoding independently');
    await guest.evaluate(g,'setSyncPreference("speed");video.currentTime=expected()-.4;true');
    await guest.until(g,'video.playbackRate===1.04','Default speed correction remains available');
    await guest.evaluate(g,'document.getElementById("sync-correction").value="jumps";document.getElementById("sync-correction").dispatchEvent(new Event("change"));true');
    assert.equal(await guest.evaluate(g,'video.playbackRate'),1,'Mode change immediately cancels speed adjustment');
    const diagnostics=JSON.parse(await guest.evaluate(g,'JSON.stringify(diagnostics.snapshot())'));
    const events=JSON.parse(await guest.evaluate(g,'JSON.stringify(jumpEvents)'));
    const reloaded=await guest.page(config.publicUrl+'/watch?demo=guest');
    await guest.until(reloaded,'typeof me!=="undefined"&&!!me','Reloaded identity');
    assert.equal(await guest.evaluate(reloaded,'syncCorrectionMode'),'jumps','Preference survives page replacement');
    const report={browser:name,versions:[host.version,guest.version],format:hls?'hls':'file',passed:true,
      checks:{forwardJump:true,backwardJump:true,cooldown:true,normalSpeed:true,independentHost:true,modeSwitch:true,persisted:true},
      jumps:diagnostics.entries.filter(e=>e.event==='sync-jump'),rates:{samples:rates.length,min:Math.min(...rates),max:Math.max(...rates)},
      residualErrorsMs:{forward:forwardResidualMs,backward:backwardResidualMs},
      playbackEvents:events,hostBefore,hostAfter,limitations:'Local synthetic media and software decoding; includes seek/refill events. No WAN, physical display/audio or comparative motion/skew claim.'};
    fs.writeFileSync(path.join(output,'diagnostics.json'),JSON.stringify(diagnostics));
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  } catch(error) {
    if(guest&&g) {
      console.error(await guest.evaluate(g,'JSON.stringify({mode:syncCorrectionMode,position:video.currentTime,target:expected(),rate:video.playbackRate,paused:video.paused,seeking:video.seeking,waiting:playerWaiting,ready:video.readyState,roomPaused:state?.state.paused,readiness:state?.waitingForReady,error:playbackError,clock:playbackClock.read(),buffer:Array.from({length:video.buffered.length},(_,i)=>[video.buffered.start(i),video.buffered.end(i)])})').catch(()=>''));
      const log=await guest.evaluate(g,'JSON.stringify(diagnostics.snapshot())').catch(()=>undefined);
      if(log)fs.writeFileSync(path.join(output,'failed-diagnostics.json'),log);
    }
    throw error;
  } finally {await Promise.allSettled([host?.close(),guest?.close()]); await app.close();}
}
main().catch(error => {console.error(error);process.exitCode=1;});
