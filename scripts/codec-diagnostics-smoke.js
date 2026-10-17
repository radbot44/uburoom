/* Disposable browsers and an explicitly enabled local diagnostic server. No .env. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser}=require('./lib/playback-browser');
async function main(){
  const root=path.resolve(__dirname,'..'),name=process.argv.find(arg=>arg.startsWith('--browser='))?.slice(10)||'firefox';
  const output=path.join(root,'artifacts','codec-diagnostics-'+name);fs.mkdirSync(output,{recursive:true});
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['channel'],demo:true,diagnostics:true};
  const app=createApp(config);let browser;
  app.hub.access={refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    browser=await playbackBrowser(name);
    const page=await browser.page(config.publicUrl+'/watch?demo=host');
    await browser.viewport(page,1200,1000);
    await browser.until(page,'typeof transport!=="undefined"&&transport?.ready','Authentication');
    await browser.evaluate(page,'createRoom().then(()=>true)');
    await browser.until(page,'!!state && !!document.querySelector(".library-other")','Library home in a room');
    assert.equal(await browser.evaluate(page,'!!document.getElementById("library-playback-test") || !!document.getElementById("playback-dialog")'),false);
    await browser.evaluate(page,'document.getElementById("library-panel").scrollIntoView();true');
    await browser.screenshot(page,path.join(output,'library.png'));
    await browser.evaluate(page,'location.assign("/__diagnostics/codec");true');
    await browser.until(page,'!!document.getElementById("test-video")','Explicit diagnostic page');
    await browser.evaluate(page,'document.getElementById("test-video").muted=true;document.getElementById("play").click();true');
    await browser.until(page,'document.getElementById("test-video").currentTime>.5 && document.getElementById("test-video").getVideoPlaybackQuality().totalVideoFrames>0','Diagnostic decoded frames');
    await browser.until(page,'Array.isArray(JSON.parse(document.getElementById("diagnostics").value).capabilities)','Capability report');
    await browser.screenshot(page,path.join(output,'codec-desktop.png'));
    await browser.viewport(page,390,844);
    assert.equal(await browser.evaluate(page,'document.documentElement.scrollWidth<=innerWidth'),true);
    await browser.screenshot(page,path.join(output,'codec-phone.png'));
    console.log(JSON.stringify({passed:true,browser:name,version:browser.version,checks:['watch navigation isolation','explicit diagnostic decoding','capability report','phone overflow'],limitations:'Local synthetic fixtures; no physical audio/motion or real Discord Activity claim.'}));
  }finally{await browser?.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
