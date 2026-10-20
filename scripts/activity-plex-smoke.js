/* Isolated admission UI checks with synthetic providers and disposable browser profiles. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {accountFixture}=require('./account-fixture');
const {playbackBrowser}=require('./lib/playback-browser');
async function main(){
  const name=process.argv.find(value=>value.startsWith('--browser='))?.slice(10)||'chrome';
  const output=path.resolve('artifacts/activity-plex-'+name);fs.mkdirSync(output,{recursive:true});
  const provider=accountFixture();
  const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:provider.subjects.host,clientId:'100000000000000010',clientSecret:'fixture-secret',guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:provider.subjects,plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',
    accessPolicy:{discord:true,plex:true,requirePlex:true,requirePlexInActivity:false,password:'fixture-password',publicWeb:true},plexFallback:{enabled:true,token:''}};
  const app=createApp(config,{plexFetch:provider.fetch,oauthFetch:provider.discordFetch,plexDemo:provider});let browser;
  const members=new Set(Object.values(provider.subjects));
  app.hub.access={refresh:async id=>members.has(id),isMember:id=>members.has(id),options:()=>({available:true})};
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    browser=await playbackBrowser(name);
    const page=await browser.page(config.publicUrl+'/watch');await browser.viewport(page,1200,900);
    await browser.until(page,'!document.getElementById("entry-form").hidden','Extra password');
    await browser.screenshot(page,path.join(output,'password.png'));
    await browser.evaluate(page,'document.getElementById("entry-password").value="fixture-password";true');await browser.click(page,'entry-submit');
    await browser.until(page,'document.getElementById("entry-status").textContent.includes("requires confirmed Plex access")','Browser Plex requirement');
    await browser.screenshot(page,path.join(output,'browser-plex.png'));
    const activity=await browser.page(config.publicUrl+'/watch?demo=guest&frame_id=fixture');await browser.viewport(activity,1200,900);
    await browser.until(activity,'typeof transport!=="undefined"&&transport?.ready','Activity admitted without Plex');
    const admission=JSON.parse(await browser.evaluate(activity,'api("/api/watch/admission").then(JSON.stringify)'));
    assert.equal(admission.admitted,true);assert.equal(admission.plexRequired,false);
    await browser.evaluate(activity,'createRoom().then(()=>true)');await browser.until(activity,'!!state','Activity room socket');
    await browser.screenshot(activity,path.join(output,'activity-room.png'));
    const browserAdmission=JSON.parse(await browser.evaluate(page,'api("/api/watch/admission").then(JSON.stringify)'));
    assert.equal(browserAdmission.admitted,false);assert.equal(browserAdmission.plexRequired,true);
    const report={browser:name,version:browser.version,scope:'Synthetic browser password, required Plex browser entry, exempt Activity room/control socket, browser remains blocked',passed:4,failed:0,screenshots:['password.png','browser-plex.png','activity-room.png']};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));process.stdout.write(JSON.stringify(report)+'\n');
  }finally{await browser?.close();await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
