/* Disposable browsers and an explicitly enabled local diagnostic server. No .env. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser}=require('./lib/playback-browser');
async function main(){
  const root=path.resolve(__dirname,'..'),name=process.argv.find(arg=>arg.startsWith('--browser='))?.slice(10)||'firefox';
  const output=path.join(root,'artifacts','codec-diagnostics-'+name);fs.mkdirSync(output,{recursive:true});
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['channel'],demo:true};
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
    assert.equal(await browser.evaluate(page,'fetch("/__diagnostics/media/av1.webm").then(r=>r.status)'),403);
    await browser.evaluate(page,'document.getElementById("admin-mode").click();true');
    await browser.until(page,'!!document.getElementById("library-codec-test")','Admin codec entry');
    await browser.screenshot(page,path.join(output,'library-admin.png'));
    await browser.evaluate(page,'document.getElementById("library-codec-test").click();true');
    await browser.until(page,'document.getElementById("codec-test-frame").contentDocument?.getElementById("codec")?.options.length===7','Embedded tester');
    // Drive the nested document while preserving the actual parent authorization.
    const evaluate = (code) => browser.evaluate(page,'(()=>{const document=globalThis.document.getElementById("codec-test-frame").contentDocument;return ('+code+');})()');
    const until = async (code,label) => browser.until(page,'(()=>{const document=globalThis.document.getElementById("codec-test-frame").contentDocument;return ('+code+');})()',label);
    await evaluate('(document.getElementById("codec").value="5",document.getElementById("codec").dispatchEvent(new Event("change")),true)');
    await until('!document.getElementById("play").disabled','Authenticated AV1 sample');

    await evaluate('(document.getElementById("test-video").muted=true,document.getElementById("play").click(),true)');
    try { await until('document.getElementById("test-video").currentTime>.5 && document.getElementById("test-video").getVideoPlaybackQuality().totalVideoFrames>0','Diagnostic decoded frames'); } catch(error) { console.log(await evaluate('document.getElementById("diagnostics").value')); await browser.screenshot(page,path.join(output,'failure.png')); throw error; }
    await until('Array.isArray(JSON.parse(document.getElementById("diagnostics").value).capabilities)','Capability report');
    await browser.screenshot(page,path.join(output,'codec-desktop.png'));
    await browser.viewport(page,390,844);
    assert.equal(await browser.evaluate(page,'document.documentElement.scrollWidth<=innerWidth'),true);
    await browser.screenshot(page,path.join(output,'codec-phone.png'));
    await browser.evaluate(page,'document.getElementById("codec-test-close").click();document.getElementById("admin-mode").click();true');
    await browser.until(page,'!document.getElementById("library-codec-test")','Admin entry removed');
    assert.equal(await browser.evaluate(page,'fetch("/__diagnostics/media/av1.webm").then(r=>r.status)'),403);
    console.log(JSON.stringify({passed:true,browser:name,version:browser.version,checks:['ordinary sample denial','admin entry and revocation','embedded AV1 decoding','capability report','phone overflow'],limitations:'Local synthetic fixtures; no physical audio/motion or real Discord Activity claim.'}));
  }finally{await browser?.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
