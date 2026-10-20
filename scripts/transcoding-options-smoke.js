/* Disposable UI fixture; no private configuration or live providers. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {qualityDefinition}=require('../shared/room-protocol');
const {playbackBrowser}=require('./lib/playback-browser');
async function main(){
  const name=process.argv.find(a=>a.startsWith('--browser='))?.slice(10)||'chrome';
  const output=path.resolve('artifacts/transcoding-options-'+name);fs.mkdirSync(output,{recursive:true});
  const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,
    transcoding:{policy:'override',plex:true,uburoom:true,encoder:'software',cpuFallback:true,formats:['av1'],maxJobs:5,qualities:['direct','900p5.5','720p2'].map(qualityDefinition)}};
  const app=createApp(config);let browser;
  app.hub.access={refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    browser=await playbackBrowser(name);const page=await browser.page(config.publicUrl+'/watch?demo=host');await browser.viewport(page,1200,1000);
    await browser.until(page,'typeof transport!=="undefined"&&transport?.ready','Identity');
    await browser.evaluate(page,'createRoom().then(()=>true)');await browser.until(page,'!!state','Room');
    await browser.evaluate(page,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
    await browser.until(page,'video.videoWidth>0','Decoded fixture');
    const value=await browser.evaluate(page,'JSON.stringify([...document.getElementById("quality").options].map(o=>o.value))');assert.deepEqual(JSON.parse(value),['direct','900p5.5','720p2']);
    await browser.evaluate(page,'renderMediaInformation(state);document.getElementById("tracks-dialog").showModal();true');
    assert.ok(await browser.evaluate(page,'!!document.getElementById("media-information").textContent'));
    await browser.screenshot(page,path.join(output,'settings-desktop.png'));
    await browser.viewport(page,390,844);assert.equal(await browser.evaluate(page,'document.documentElement.scrollWidth<=innerWidth'),true);
    await browser.screenshot(page,path.join(output,'settings-phone.png'));
    console.log(JSON.stringify({passed:true,browser:name,version:browser.version,checks:['configured pair menu','media information dialog','phone overflow'],limits:'Synthetic Original playback; no live PMS custom output or Discord compatibility claim.'}));
  }finally{await browser?.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
