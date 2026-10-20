/* Initial page data, matching lobby geometry and atomic saved-room entry. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {accountFixture}=require('./account-fixture');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main(){
  for(const name of ['chrome','firefox']){
    const fixture=accountFixture(),requests=[];
    const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',
      ownerId:fixture.subjects.host,guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:fixture.subjects,
      plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
    const app=createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access={isMember:()=>true,refresh:async()=>true,options:()=>({available:true})};
    app.server.prependListener('request',req=>requests.push(req.url));
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    let browser;
    try{
      browser=await playbackBrowser(name);
      const page=await browser.page(config.publicUrl+'/watch?demo=host');
      const run=expression=>browser.evaluate(page,expression),until=(expression,label)=>browser.until(page,expression,label);
      await until('transport?.ready && !!me','Fixture login');requests.length=0;
      await run('location.assign("/watch");true');await until('typeof transport!=="undefined" && transport?.ready && !!me && !document.body.classList.contains("auth-pending") && location.search===""','Page bootstrap');
      assert.equal(requests.some(url=>url==='/api/watch/config'||url==='/api/watch/me'),false,'Page supplies configuration and identity without API refetch');
      assert.equal(await run('pageBootstrap.rooms.status'),200);
      assert.equal(await run('knownRooms.length'),0);
      await browser.viewport(page,1360,1000);
      const geometry='(()=>{const r=$("stage").getBoundingClientRect();return {width:r.width,height:r.height,background:getComputedStyle($("stage")).backgroundColor}})()';
      const home=await run(geometry);
      assert.ok(Math.abs(home.width/home.height-16/9)<.01,'Home lobby uses video geometry');
      await browser.screenshot(page,path.resolve('artifacts/entry-'+name+'-home.png'));
      await run('$("create").click();$("room-name").value="Instant entry fixture";$("room-create").click()');
      await until('!!state && !$("room-dialog").open','Empty room');const id=await run('selected');
      const empty=await run(geometry);assert.deepEqual(empty,home,'Empty-room lobby matches home frame');
      await browser.screenshot(page,path.resolve('artifacts/entry-'+name+'-empty.png'));
      for(const media of [false,true]){
        if(media){await run('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');await run('execute({action:"media.pause"})');}
        await run('api("/api/watch/rooms/"+selected+"/close",{epoch:state.epoch})');await until('!selected','Closed room returns home');
        await run('$("lobby-reopen").click()');await until('!!document.querySelector("#saved-rooms button")','Saved rooms');
        let release;
        const gate=new Promise(resolve=>{release=resolve;}),original=app.watch.roomState.reopen.bind(app.watch.roomState);
        app.watch.roomState.reopen=async(...args)=>{await gate;return original(...args);};
        await run('globalThis.entryRequests=[];globalThis.originalEntryRequest=transport.request.bind(transport);transport.request=(...args)=>{entryRequests.push(args[0]);return originalEntryRequest(...args)};globalThis.entryStarted=performance.now();$("room-dialog").addEventListener("close",()=>{globalThis.entryElapsed=performance.now()-entryStarted},{once:true});[...document.querySelectorAll("#saved-rooms button")].find(button=>button.textContent==="Reopen").click()');
        await until('$("room-dialog").getAttribute("aria-busy")==="true"','Immediate opening feedback');
        await pause(1200);
        assert.equal(await run('$("room-saved-status").textContent'),'Opening room…','Socket updates do not replace pending action');
        const responseStarted=Date.now();release();
        await until('state?.id==='+JSON.stringify(id)+' && !$("room-dialog").open','One-step reentry');
        const paths=await run('entryRequests');
        assert.equal(paths.filter(url=>url.endsWith('/reopen')).length,1);
        assert.equal(paths.some(url=>url.startsWith('/api/watch/rooms/'+id+'?')),false,'Reopen response includes joined state');
        assert.equal(paths.includes('/api/watch/rooms'),false,'No room-list refetch on entry');
        console.log(name+': '+(media?'saved video':'empty room')+' reopened in '+(Date.now()-responseStarted)+' ms after releasing fixture gate');
        await run('transport.request=originalEntryRequest');app.watch.roomState.reopen=original;
      }
      await run('$("close-room").click()');await until('!selected','Leave room');
      await browser.viewport(page,390,844);const phone=await run(geometry);assert.ok(Math.abs(phone.width/phone.height-16/9)<.01,'Phone lobby keeps video size');
      await browser.screenshot(page,path.resolve('artifacts/entry-'+name+'-phone.png'));
    }finally{await browser?.close();await app.close();}
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
