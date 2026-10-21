/* Account names and host discovery in disposable Chrome/Firefox fixtures. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main(){
  const names=(process.argv.find(arg=>arg.startsWith('--browsers='))?.slice(11)||'chrome,firefox').split(',');
  for(const name of names){
    const subjects={host:'100000000000000001',guest:'100000000000000002',guest2:'100000000000000003'};
    const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:subjects.host,guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:subjects};
    const fixture=require('./account-fixture').accountFixture();
    const app=createApp(config,{plexDemo:fixture,plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch});let browser,host,guest;
    const offline=app.registry.resolve('plex','201','Offline friend');
    app.hub.access={isMember:()=>true,refresh:async()=>true,voiceChannel:()=>undefined,validVoiceChannel:()=>false,options:()=>({available:true}),
      directory:async()=>[{subject:'100000000000000088',name:'Future friend',alias:'future.user'}],discordOnline:()=>true};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    try{
      browser=await playbackBrowser(name);host=await browser.page(config.publicUrl+'/watch?demo=host');
      const run=async(page,code)=>{await pause(100);await browser.activate(page);return browser.evaluate(page,code);};
      const until=(page,code,label)=>browser.until(page,code,label);
      const shot=async(page,label)=>{await browser.activate(page);await browser.screenshot(page,path.resolve('artifacts/account-directory-'+name+'-'+label+'.png'));};
      await browser.viewport(host,1360,1000);await browser.activate(host);
      await until(host,'me?.durableRooms&&transport?.ready','Leader login');
      await run(host,'showAccount()');await until(host,'!$("account-content").hidden','Account loaded');
      await shot(host,'account-before-edit');
      await run(host,'$("account-display-name").value="Chosen leader";$("account-name-save").click()');
      await until(host,'$("account-name-status").textContent==="Saved"&&me.name==="Chosen leader"','Display name saved');
      await shot(host,'account');
      await run(host,'$("account-close").click();api("/api/watch/rooms",{name:"Directory room",keepEmpty:true}).then(room=>selectRoom(room.id))');
      await until(host,'state?.roomName==="Directory room"','Room created');
      const id=await run(host,'selected');
      guest=await browser.page(config.publicUrl+'/watch?demo=guest');await browser.activate(guest);
      await until(guest,'me?.durableRooms&&transport?.ready','Guest login');
      await run(guest,'selectRoom('+JSON.stringify(id)+')');await until(guest,'state?.id==='+JSON.stringify(id),'Guest joined');
      const guestId=await run(guest,'me.account.id');
      await run(host,'roomUI.open(selected,"people")');await until(host,'!$("room-settings-content").hidden','People loaded');
      const search=async query=>{
        await run(host,'$("room-person-search").value='+JSON.stringify(query)+';$("room-person-search").dispatchEvent(new Event("input"))');
        await until(host,'$("room-person-results").children.length>0','Search results for '+query);
      };
      await search('Future');
      assert.match(await run(host,'$("room-person-results").textContent'),/Not on uburoom yet.*Online on Discord/);
      await shot(host,'people-search');
      await browser.viewport(host,390,844);await shot(host,'people-phone');await browser.viewport(host,1360,1000);
      await run(host,'$("room-person-search").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
      assert.equal(app.watch.roomState.store.pendingHosts(id).length,0,'Enter without selection grants nothing');
      await run(host,'$("room-person-search").dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowDown",bubbles:true}));$("room-person-search").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
      await until(host,'$("room-current-people").textContent.includes("Awaiting Discord sign-in")','Pending grant shown');
      assert.equal(app.registry.identity('discord','100000000000000088'),undefined,'Discovery never creates account');
      await search('Offline');await run(host,'$("room-person-results").firstElementChild.click()');
      await until(host,'$("room-current-people").textContent.includes("Offline friend")','Offline host assigned');
      assert.ok(app.watch.roomState.store.get(id).hosts.includes(offline.id));
      await run(host,'$("room-host-'+guestId+'").click()');await until(host,'$("room-host-'+guestId+'").textContent==="Remove host"','Guest assigned');
      await run(host,'$("room-settings-dismiss").click();roomUI.open(selected,"permissions")');
      await until(host,'!!document.querySelector("input[data-role=host][data-permission=addHosts]")','Permissions loaded');
      assert.equal(await run(host,'document.querySelector("input[data-role=host][data-permission=addHosts]").checked'),false);
      await run(host,'document.querySelector("input[data-role=host][data-permission=addHosts]").click()');await until(host,'$("room-settings-status").textContent==="Saved"','Delegation saved');
      await shot(host,'permissions');
      await run(host,'$("room-all-hosts").click()');await until(host,'$("room-settings-status").textContent==="Saved"&&$("room-all-hosts").checked','All hosts enabled');
      assert.equal(await run(host,'getComputedStyle(document.querySelector("td[data-permission-role=viewer]")).display'),'none');
      await shot(host,'all-hosts');await browser.viewport(host,390,844);await shot(host,'all-hosts-phone');await browser.viewport(host,1360,1000);
      await run(host,'$("room-settings-dismiss").click()');
      await until(host,'state?.allHosts && !document.querySelector("[data-quick-permission=seek]").disabled','Host quick controls');
      assert.equal(await run(host,'$("room-quick-permissions").querySelector("h4").textContent'),'Host controls');
      await run(host,'document.querySelector("[data-quick-permission=seek]").click()');
      await until(host,'state.hostPermissions.seek===false && $("room-quick-status").textContent==="Saved"','Quick switch edits flattened host policy');
      assert.equal(app.watch.roomState.store.get(id).permissions.host.seek,false);
      await run(host,'document.querySelector("[data-quick-permission=seek]").click()');
      await until(host,'state.hostPermissions.seek===true && $("room-quick-status").textContent==="Saved"','Quick host policy restored');
      await run(host,'roomUI.open(selected,"permissions")');await until(host,'!$("room-settings-content").hidden','Leader mode settings');
      await run(guest,'roomUI.open(selected,"permissions")');await until(guest,'!$("room-settings-content").hidden','Host settings loaded');
      assert.equal(await run(guest,'$("room-all-hosts").disabled'),true,'Only leader changes the mode');
      await run(guest,'$("room-settings-dismiss").click();roomUI.open(selected,"people")');await until(guest,'!$("room-host-search").hidden','Delegated host search');
      assert.equal(await run(guest,'[...$("room-current-people").querySelectorAll("button")].some(b=>b.textContent==="Remove host"||b.textContent==="Remove assignment")'),false);
      await run(guest,'$("room-host-'+guestId+'").click()');await until(guest,'$("room-confirm-dialog").open','Self-demotion confirmation');
      assert.match(await run(guest,'$("room-confirm-message").textContent'),/remain a host while All hosts is on/);
      await run(guest,'$("room-confirm-dialog").querySelector("button[value=yes]").click()');
      await until(guest,'$("room-current-people").textContent.includes("All hosts mode")','Explicit role relinquished');
      assert.equal(app.watch.roomState.store.get(id).hosts.includes(guestId),false);
      await run(host,'$("room-settings-refresh").click()');await until(host,'!$("room-settings-content").hidden&&$("room-all-hosts").checked','Leader refreshed');
      await run(host,'$("room-all-hosts").click()');await until(host,'$("room-settings-status").textContent==="Saved"&&!$("room-all-hosts").checked','All hosts disabled');
      await run(guest,'$("room-settings-refresh").click()');await until(guest,'!$("room-settings-content").hidden&&$("room-host-search").hidden','Role returned to participant');
      assert.ok(app.watch.roomState.store.get(id).hosts.includes(offline.id),'Explicit offline assignment retained');
      console.log(JSON.stringify({browser:name,result:'pass',checks:'names, aliases, pending/known hosts, keyboard selection, delegation, self-demotion, reversible All hosts, desktop/phone'}));
    }catch(error){if(browser&&host){console.error(await browser.evaluate(host,'({error:$("error").textContent,settings:$("room-settings-status").textContent,search:$("room-person-search-status").textContent})'));await browser.screenshot(host,path.resolve('artifacts/account-directory-'+name+'-failure.png'));}throw error;}
    finally{await browser?.close();await app.close();}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
