/* Actual disposable browsers and retained SQLite, with synthetic media/accounts only. */
'use strict';
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main() {
  for(const name of ['chrome','firefox']) {
    const directory=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-recovery-ui-'));
    const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',
      ownerId:'100000000000000001',guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:false,
      demoSubjects:{host:'100000000000000001',guest:'100000000000000002'},roomLimits:{recoverySeconds:60},
      accountFile:path.join(directory,'accounts.sqlite'),credentialKeyFile:path.join(directory,'original.key')};
    let app,browser,host,guest,port=0;
    const start=async()=>{
      app=createApp(config);app.hub.access={isMember:()=>true,refresh:async()=>true,voiceChannel:()=>undefined,validVoiceChannel:()=>false,options:()=>({available:true})};
      await new Promise(resolve=>app.server.listen(port,'127.0.0.1',resolve));port=app.server.address().port;config.publicUrl='https://localhost:'+port;
    };
    const run=async(page,code)=>{await browser.activate(page);await pause(120);return browser.evaluate(page,code);};
    try {
      await start();browser=await playbackBrowser(name);
      host=await browser.page(config.publicUrl+'/watch?demo=host');
      await browser.until(host,'me?.durableRooms && transport?.ready','Host connected');
      await run(host,'$("create").click();$("room-create").click()');
      await browser.until(host,'!!state?.id','Room created');
      const id=await run(host,'selected');
      await run(host,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');
      await browser.until(host,'state?.mediaId==="demo" && !state.state.paused','Demo playing');
      guest=await browser.page(config.publicUrl+'/watch?demo=guest');
      await browser.until(guest,'transport?.ready','Guest connected');
      await run(guest,'selectRoom('+JSON.stringify(id)+')');
      await browser.until(guest,'state?.mediaId==="demo"','Guest joined');
      const originalEpoch=await run(host,'state.epoch');
      const key=fs.readFileSync(config.credentialKeyFile);
      await app.close();app=undefined;
      await pause(700);await start();
      await browser.until(host,'transport?.ready && state?.epoch!=='+JSON.stringify(originalEpoch)+' && state?.mediaId==="demo" && !state.state.paused && !state.recovery','Host resumed after reboot',45000);
      await browser.until(guest,'transport?.ready && state?.mediaId==="demo" && !state.state.paused && !state.recovery','Guest resumed after reboot',45000);
      assert.equal(await run(host,'selected'),id);assert.equal(await run(guest,'selected'),id);
      assert.equal(await run(host,'state.enabled'),false);assert.deepEqual(fs.readFileSync(config.credentialKeyFile),key);
      await app.close();app=undefined;
      await run(guest,'transport.close()');
      await pause(700);await start();
      await browser.until(host,'transport?.ready && state?.recovery?.missing===1 && state.state.paused','Missing guest pauses recovery',45000);
      await browser.screenshot(host,path.resolve('artifacts/room-recovery-'+name+'.png'));
      await run(host,'$("room-recovery-start").click()');
      await browser.until(host,'!state?.recovery && state?.mediaId==="demo" && !state.state.paused','Permitted Start now',45000);
      assert.equal(await run(host,'state.enabled'),false);
      console.log(name+': automatic retained-room reconnect, bearer renewal, all-returned resume, missing-member pause, Start now and consent off passed');
    } catch(error) {
      if(app)console.error('server recovery',JSON.stringify([...app.watch.rooms.values()].map(r=>({recovery:r.recovery,paused:r.s.state.paused,manual:r.manualPaused,gate:r.initialGate,viewers:[...r.viewers.values()].map(v=>({id:v.userId,ready:v.ready,version:v.version,media:r.mediaVersion}))}))));
      if(browser&&host){console.error(await run(host,'({selected,ready:transport?.ready,error:$("error").textContent,state:state&&{media:state.mediaId,recovery:state.recovery,paused:state.state.paused,readiness:state.readiness}})'));await browser.screenshot(host,path.resolve('artifacts/room-recovery-'+name+'-failure.png'));}
      throw error;
    } finally {
      await browser?.close();if(app)await app.close();
      assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('uburoom-recovery-ui-'));fs.rmSync(directory,{recursive:true,force:true});
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
