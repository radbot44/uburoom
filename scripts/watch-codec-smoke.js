/* Live Plex decode verification in an isolated Chromium profile with GPU decoding off.
   Usage: node --env-file=.env scripts/watch-codec-smoke.js --plex-url=http://host:32400 --media-id=123 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { WebSocket } = require('ws');
const { createApp } = require('../server/app');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function main() {
  const root = path.resolve(__dirname, '..'), mediaId = process.argv.find(x => x.startsWith('--media-id='))?.slice(11);
  assert.match(mediaId || '', /^\d+$/);
  const config = {cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'demo-guild',channels:['demo-commands'],demo:true,
    plexUrl:process.argv.find(x => x.startsWith('--plex-url='))?.slice(11),plexToken:process.env.PLEX_TOKEN};
  const app = createApp(config);
  app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl=`https://localhost:${app.server.address().port}`;
  const profile=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-codec-chromium-'));
  let browser, driver;
  try {
    const runtime=process.argv.find(x=>x.startsWith('--runtime='))?.slice(10);
    browser=spawn(runtime || process.env.CHROMIUM_BINARY || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      ['--headless=new','--disable-gpu','--disable-accelerated-video-decode','--no-first-run','--no-default-browser-check','--ignore-certificate-errors',
        '--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],
      {windowsHide:true,stdio:['ignore','pipe','pipe']});
    const address=await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Chromium startup timed out')),20000);
      browser.stderr.on('data',chunk=>{const m=/DevTools listening on (ws:\/\/[^\s]+)/.exec(chunk.toString());if(m){clearTimeout(timer);resolve(m[1]);}});
      browser.on('error',reject);
    });
    driver=new WebSocket(address);await once(driver,'open');let seq=0;const requests=new Map();
    driver.on('message',raw=>{const m=JSON.parse(raw),r=requests.get(m.id);if(r){requests.delete(m.id);clearTimeout(r.timer);m.error?r.reject(new Error(m.error.message)):r.resolve(m.result);}});
    const command=(method,params={},sessionId)=>new Promise((resolve,reject)=>{
      const id=++seq,timer=setTimeout(()=>{requests.delete(id);reject(new Error(method+' timed out'));},15000);
      requests.set(id,{resolve,reject,timer});driver.send(JSON.stringify({id,method,params,sessionId}));
    });
    const evaluate=async(session,expression)=>{const r=await command('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},session);if(r.exceptionDetails)throw new Error(r.exceptionDetails.text+': '+r.result.description);return r.result.value;};
    const until=async(session,expression,label)=>{await command('Page.bringToFront',{},session);for(let n=0;n<150;n++){if(await evaluate(session,expression))return;await pause(200);}throw new Error(label+': '+await evaluate(session,'JSON.stringify({error:document.getElementById("error").textContent,mediaError:globalThis.codecProbeError,codecs:globalThis.codecProbeCodecs,format:state?.format,compatible:state?.compatible,frames:videoFrames,width:video.videoWidth,ready:video.readyState,paused:video.paused,time:video.currentTime,blocked:autoplayBlocked,pending})'));};
    const usedTargets=new Set(), expectUnsupported=process.argv.includes('--expect-unsupported');
    const page=async persona=>{
      const {targetId}=runtime ? (await command('Target.getTargets')).targetInfos.find(x=>x.type==='page' && !usedTargets.has(x.targetId)) :
        await command('Target.createTarget',{url:config.publicUrl+'/watch?demo='+persona+(expectUnsupported?'&frame_id=fixture':'')});
      usedTargets.add(targetId);
      const {sessionId}=await command('Target.attachToTarget',{targetId,flatten:true});
      if(runtime)await command('Page.navigate',{url:config.publicUrl+'/watch?demo='+persona+(expectUnsupported?'&frame_id=fixture':'')},sessionId);
      await until(sessionId,'typeof me!=="undefined" && !!me',persona+' login');
      await evaluate(sessionId,"video.addEventListener('error',()=>{globalThis.codecProbeError=video.error?.message;});true");
      return sessionId;
    };
    console.log('[Codec Chromium]',(await command('Browser.getVersion')).product,'GPU and accelerated video decoding disabled');
    const host=await page('host');await evaluate(host,'document.getElementById("create").click()');await until(host,'!!state','session created');
    await evaluate(host,`execute({action:'media.load',args:{mediaId:${JSON.stringify(mediaId)},quality:'720p'}}).then(()=>true)`);
    await evaluate(host,"hls?.on(Hls.Events.BUFFER_CODECS,(_,data)=>{globalThis.codecProbeCodecs=Object.values(data).map(x=>x.codec);});true");
    if(expectUnsupported){
      await until(host,'!document.getElementById("acceleration-help").hidden && playbackError.includes("hardware acceleration off") && !hls','unsupported Discord decoder notice');
      const error=await evaluate(host,'playbackError');await pause(4500);
      assert.equal(await evaluate(host,'playbackError'),error,'reset errors do not obscure the decoder cause');
      assert.equal(await evaluate(host,'document.getElementById("watch-website").href'),config.publicUrl+'/watch');
      await evaluate(host,'toggleDrawer(false)');await pause(1300);
      assert.equal(await evaluate(host,'drawer.hidden'),true,'unchanged decoder error does not reopen the drawer');
      console.log('[Codec Chromium] PASS: unsupported Discord software decoder stops HLS, preserves the acceleration explanation and offers the website.');
      await command('Browser.close').catch(()=>{});return;
    }
    await until(host,'videoFrames>0 && !video.paused && video.currentTime>1','720p H.264 frames');
    console.log('[Codec Chromium] PASS: 720p H.264 has decoded frames and audio.');
    const framesBeforeRecovery=await evaluate(host,'videoFrames');
    await evaluate(host,"hls.trigger(Hls.Events.ERROR,{type:Hls.ErrorTypes.MEDIA_ERROR,details:Hls.ErrorDetails.MEDIA_SOURCE_REQUIRES_RESET,fatal:true});true");
    await until(host,`hlsRecoveryCount===1 && !!hls && !playbackError && videoFrames>${framesBeforeRecovery} && !video.paused`,'bounded MediaSource recovery');
    console.log('[Codec Chromium] PASS: MediaSource reset recovers the authorized stream without changing the room.');
    const oldHostSource=await evaluate(host,'state.mediaUrl');
    await evaluate(host,"execute({action:'session.sharing',args:{mode:'guild'}}).then(()=>execute({action:'session.enable'})).then(()=>true)");
    const guest=await page('guest');
    await until(guest,'document.getElementById("rooms").querySelector("button")','session chooser');
    await evaluate(guest,'document.getElementById("rooms").querySelector("button").click()');
    await until(guest,'videoFrames>0 && !video.paused','second viewer decoded');
    // Diagnose raw Original independently, without allowing fallback to obscure the result.
    await evaluate(host,"fallbackVersion=state.mediaVersion; execute({action:'media.quality.set',args:{quality:'direct'}}).then(()=>true)");
    await pause(6000);
    console.log('[Codec Chromium] Raw Original:',await evaluate(host,'JSON.stringify({codec:state.videoCodec,width:video.videoWidth,frames:videoFrames,error:video.error?.code,time:video.currentTime})'));
    await evaluate(host,'fallbackVersion=undefined; compatibleFallback("Raw original decode check").then(()=>true)');
    await until(host,'state.compatible && state.quality==="direct" && videoFrames>0 && !video.paused','source-resolution H.264 fallback');
    assert.equal(await evaluate(host,`fetch(${JSON.stringify(oldHostSource)}).then(r=>r.status)`),403,'quality change revokes only the old viewer stream');
    console.log('[Codec Chromium] PASS: Original H.264 fallback decodes; dimensions:',await evaluate(host,'video.videoWidth+"x"+video.videoHeight'));
    const guestSource=await evaluate(guest,'state.mediaUrl');
    await evaluate(host,"execute({action:'media.quality.set',args:{quality:'1080p'}}).then(()=>true)");
    await until(host,'state.quality==="1080p" && videoFrames>0 && !video.paused','1080p H.264 frames');
    assert.equal(await evaluate(guest,'state.quality'),'720p');assert.equal(await evaluate(guest,'state.mediaUrl'),guestSource);
    await evaluate(host,"execute({action:'media.pause'}).then(()=>true)");await until(guest,'video.paused','shared pause');
    await evaluate(guest,"execute({action:'media.quality.set',args:{quality:'direct'}}).then(()=>true)");
    await until(guest,'state.compatible && state.format==="hls" && video.readyState>=2','automatic HEVC capability fallback');
    console.log('[Codec Chromium] PASS: 1080p decodes; quality isolation, shared pause, and automatic Original fallback verified.');
    await command('Browser.close').catch(()=>{});
  } finally {driver?.close();browser?.kill();await app.close();}
}
main().catch(error=>{console.error('[Codec Chromium] FAIL:',error.stack);process.exitCode=1;});
