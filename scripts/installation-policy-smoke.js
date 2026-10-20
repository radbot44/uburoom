'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {accountFixture}=require('./account-fixture');
const {playbackBrowser,pause}=require('./lib/playback-browser');

async function main(){
  const output=path.resolve('artifacts/installation-policy-ui-'+Date.now());fs.mkdirSync(output,{recursive:true});
  for(const name of (process.argv.find(arg=>arg.startsWith('--browsers='))?.slice(11)||'chrome,firefox').split(',')){
    let browser;
    try{
      browser=await playbackBrowser(name);
      for(const scenario of ['password','plex-required','single-room','activity-only']){
        const fixture=accountFixture(),config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:fixture.subjects.host,guildId:'fixture',channels:['fixture'],clientId:'100000000000000010',clientSecret:'fixture-secret',demo:true,unifiedAccounts:true,demoSubjects:fixture.subjects,plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',
          plexFallback:{enabled:true,token:''},accessPolicy:{discord:scenario!=='single-room',plex:scenario!=='single-room',requirePlex:scenario==='plex-required',password:scenario==='password'?'fixture-entry':'',publicWeb:scenario!=='activity-only'},singleRoom:scenario==='single-room',singleRoomName:'Shared room'};
        const app=createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
        app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'voice',validVoiceChannel:()=>true,options:()=>({available:true})};
        await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
        try{
          const page=await browser.page(config.publicUrl+'/watch');await browser.viewport(page,1200,850);
          const evaluate=expression=>browser.evaluate(page,expression),until=(expression,label)=>browser.until(page,expression,label);
          if(scenario==='password'){
            await until('!document.getElementById("entry-form").hidden','Password gate');
            await browser.screenshot(page,path.join(output,name+'-password-gate.png'));
            assert.equal(await evaluate('document.querySelector(".discord-button").hidden'),true);
            await evaluate('document.getElementById("entry-password").value="fixture-entry";document.getElementById("entry-form").requestSubmit();true');
            await until('document.getElementById("entry-form").hidden&&!document.querySelector(".discord-button").hidden','Providers after password');
          }else if(scenario==='plex-required'){
            await until('document.getElementById("entry-status").textContent.includes("confirmed Plex access")','Plex requirement explanation');
            assert.equal(await evaluate('document.getElementById("plex-login").hidden'),false);
          }else if(scenario==='single-room'){
            await until('typeof state!=="undefined"&&!!state&&transport?.ready','Automatic shared-room entry');
            assert.equal(await evaluate('document.getElementById("create").hidden&&document.getElementById("switch-room").hidden'),true);
            assert.equal(await evaluate('state.roomName'),'Shared room');
            await browser.screenshot(page,path.join(output,name+'-single-room-guest.png'));
            await evaluate('location.assign("/watch?demo=host");true');
            await until('typeof state!=="undefined"&&state?.roomRole==="creator"&&transport?.ready','Fixed owner');
            await evaluate('roomUI.open(state.id,"manage").then(()=>true)');
            await until('document.getElementById("room-settings-delete").textContent==="Reset room"','Reset settings');
            assert.equal(await evaluate('document.getElementById("room-transfer").closest(".room-actions").hidden'),true);
          }else await until('document.getElementById("entry-status").textContent.includes("Discord Activity")','Activity-only explanation');
          await pause(150);await browser.screenshot(page,path.join(output,name+'-'+scenario+'.png'));
          console.log(name+' '+scenario+' PASS');
        }finally{await app.close();}
      }
      console.log(name+' '+browser.version+' PASS');
    }finally{await browser?.close();}
  }
  console.log('Policy UI artifacts: '+output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
