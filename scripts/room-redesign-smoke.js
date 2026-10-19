/* Durable room controls in disposable browsers/accounts. No .env or real providers. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { playbackBrowser, pause } = require('./lib/playback-browser');
const { accountFixture } = require('./account-fixture');

async function main() {
  const browsers = (process.argv.find(arg => arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',');
  for (const name of browsers) {
    const fixture = accountFixture();
    const subjects = {host:'100000000000000001',guest:'100000000000000002',guest2:'100000000000000003'};
    const config = {cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',
      ownerId:subjects.host,guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:subjects,
      plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',
      roomAdministrators:{discord:[subjects.guest2],plex:[],discordRoles:[]}};
    const app = createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture}); let browser, host, guest;
    app.hub.access = {isMember:()=>true,refresh:async()=>true,voiceChannel:()=> 'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    try {
      browser = await playbackBrowser(name);
      host = await browser.page(config.publicUrl + '/watch?demo=host');
      // Stay within the unchanged 40 messages/second production request budget.
      const run = async expression => { await pause(100); await browser.activate(host); return browser.evaluate(host,expression); };
      const until = (expression,label) => browser.until(host,expression,label);
      const shot = label => browser.screenshot(host,path.resolve('artifacts/room-redesign-' + name + '-' + label + '.png'));
      await browser.viewport(host,1360,1000);
      await browser.activate(host);
      await until('me?.durableRooms && transport?.ready','Durable room login');

      await shot('empty');
      assert.equal(await run('getComputedStyle(document.querySelector(".transport")).display'), 'none');
      assert.equal(await run('$("drawer-visibility").hidden && !$("room-lobby").hidden'),true);
      await run('$("empty-choose").click()');
      await until('$("room-dialog").open && $("room-create-form").hidden','Discovery first'); await shot('chooser');
      await run('$("room-chooser-new").click()');
      await until('!$("room-create-form").hidden','Separate creation'); await shot('new');
      await run('$("room-name").value="Friday room";$("room-create").click()');
      await until('state?.roomName==="Friday room"','Named room');
      const id = await run('selected');
      assert.equal(await run('state.capabilities.seek && state.roomRole==="creator"'),true);
      assert.match(await run('$("current-room-meta").textContent'),/creator/);
      await shot('active');
      await run('$("room-settings-open").click()');
      await until('$("room-settings-dialog").open && !$("room-settings-content").hidden','Settings');
      await shot('settings');
      await run('$("room-rename").value="Unfinished rename";$("room-rename").dispatchEvent(new Event("input"));$("room-settings-visibility").value="private";$("room-settings-visibility").dispatchEvent(new Event("change"))');
      await until('state?.visibility==="private" && $("room-settings-status").textContent==="Saved"','Immediate feedback');
      assert.equal(await run('$("room-rename").value'),'Unfinished rename');
      await run('$("room-settings-section").value="permissions";$("room-settings-section").dispatchEvent(new Event("change"));$("room-permission-custom").open=true');
      await shot('permissions');
      assert.ok(await run('$("room-permissions").textContent.includes("Included from participants")'));
      await run('$("room-permission-preset").value="shared-queue";$("room-permission-apply").click()');
      await until('$("room-settings-status").textContent==="Saved" && $("room-permission-preset").value==="shared-queue"','Apply preset');
      assert.equal(await run('$("room-rename").value'),'Unfinished rename');
      await browser.viewport(host,390,844); await shot('phone-permissions');
      assert.equal(await run('$("room-settings-dialog").scrollWidth <= $("room-settings-dialog").clientWidth'),true);
      await run('$("room-settings-section").value="people";$("room-settings-section").dispatchEvent(new Event("change"))');
      assert.equal(await run('!$("room-host-empty").hidden'),true); await shot('phone-people');
      await run('$("room-settings-dismiss").click()');
      await browser.viewport(host,1360,1000);
      await run('$("queue-auto-open").click()');
      await until('$("room-settings-dialog").open && $("room-settings-section").value==="playback"','Queue settings unified'); await shot('playback');
      await run('$("room-autoplay").click()');
      await until('state?.autoplay?.enabled===false && !$("queue-autoplay").checked','Shared autoplay controls');
      await run('$("room-settings-dismiss").click()');
      await run('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');
      await until('state?.mediaId==="demo"','Media');
      await run('execute({action:"media.pause"})');
      await run('execute({action:"media.seek.absolute",args:{seconds:17}})');
      await until('state?.state.paused && Math.abs(state.state.position-17)<.1','Saved position');
      await run('$("theater").click();roomUI.open(selected,"manage")');
      await until('$("room-settings-dialog").open && !$("room-settings-close-live").disabled','Manage'); await shot('theater-manage');
      await run('$("room-settings-close-live").click()');
      await until('$("room-confirm-dialog").open','Close confirmation');
      await run('$("room-confirm-yes").click()');
      await until('!selected','Closed');
      await run('$("reopen").click()');
      await until('$("room-dialog").open && !$("room-reopen").hidden && document.querySelectorAll("#saved-rooms button").length===2','Your rooms directly');
      assert.equal(await run('$("room-create-form").hidden && $("room-saved-previous").hidden && $("room-saved-next").hidden'),true); await shot('saved');
      await run('document.querySelector("#saved-rooms button").click()');
      await until('state?.id && state?.state.paused && Math.abs(state.state.position-17)<.1','Restored paused');
      assert.equal(await run('selected'),id);
      assert.equal(await run('$("close-room").textContent'),'Leave room');
      await run('$("switch-room").click()'); await until('$("room-dialog").open','Switch chooser');
      assert.equal(await run('$("room-create-form").hidden'),true);
      await run('$("room-dialog").close("cancel")');
      await browser.click(host,"fullscreen");
      await until('!!document.fullscreenElement','Fullscreen');
      await run('roomUI.open(selected,"people")');
      await until('$("room-settings-dialog").open && $("room-settings-dialog").parentElement===$("stage")','Fullscreen settings'); await shot('fullscreen');
      console.log(name+': room discovery/create, presets, draft retention, save feedback, mobile sections, queue settings, close/reopen and fullscreen passed');
    } catch (error) {
      if (browser && host) { console.error(await browser.evaluate(host,'({error:$("error").textContent,settings:$("room-settings-status").textContent,dialog:$("room-dialog-error").textContent})')); await browser.screenshot(host,path.resolve('artifacts/room-redesign-'+name+'-failure.png')); }
      throw error;
    } finally { await browser?.close(); await app.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
