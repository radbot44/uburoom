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
      assert.equal(await run('getComputedStyle(document.querySelector(".transport")).display'), 'flex');
      assert.equal(await run('getComputedStyle(document.querySelector(".timeline-row")).display'), 'none');
      assert.equal(await run('$("empty-title").textContent'),'No active rooms');
      await browser.click(host,'fullscreen'); await until('!!document.fullscreenElement','Lobby fullscreen');
      await run('document.exitFullscreen()'); await until('!document.fullscreenElement','Lobby fullscreen exit');
      assert.equal(await run('!$("room-lobby").hidden'),true);
      await run('$("lobby-create").click()');
      await until('$("room-dialog").open && !$("room-create-form").hidden','Discovery first'); await shot('chooser');
      await run('$("room-chooser-new").click()');
      await until('!$("room-create-form").hidden','Separate creation'); await shot('new');
      assert.deepEqual(await run('[...$("room-create-preset-group").querySelectorAll("button")].map(button=>button.textContent)'), ['Host control','Play/Pause','Queue']);
      assert.equal(await run('!!$("room-create-summary") || !!$("room-create-preset").querySelector("[value=custom]")'),false);
      await run('$("room-name").value="Friday room";$("room-create-back").click()');
      await until('!$("room-reopen").hidden','Direct creation to reopen');
      await run('$("room-chooser-new").click()');
      assert.equal(await run('$("room-name").value'),'Friday room');
      await run('$("room-create").click()');
      await until('state?.roomName==="Friday room"','Named room');
      const id = await run('selected');
      assert.equal(await run('Object.values(state.participantPermissions).some(Boolean)'),false,'Host control starts with no participant grants');
      assert.equal(await run('state.capabilities.seek && state.roomRole==="creator"'),true);
      assert.match(await run('$("current-room-meta").textContent'),/Room Leader/);
      assert.equal(await run('document.querySelectorAll(".queue-now-playing progress").length'),0);
      assert.equal(await run('$("queue-autoplay").closest(".queue-header")!==null'),true);
      await run('document.querySelector("[data-quick-permission=addQueue]").click()');
      await until('state?.participantPermissions.addQueue && $("room-quick-status").textContent==="Saved"','Independent queue grant');
      assert.equal(await run('!state.participantPermissions.editQueue && !state.participantPermissions.chooseMedia'),true);
      await shot('active');
      guest = await browser.page(config.publicUrl + '/watch?demo=guest');
      await browser.until(guest,'me?.durableRooms && transport?.ready && $("lobby-rooms").querySelector("button")','Direct active lobby');
      assert.match(await browser.evaluate(guest,'$("lobby-rooms").textContent'),/Friday room/);
      assert.equal(await browser.evaluate(guest,'$("options-panel").hidden'),false);
      await browser.viewport(guest,390,844);
      assert.equal(await browser.evaluate(guest,'(()=>{const stage=$("stage").getBoundingClientRect(),reopen=$("lobby-reopen").getBoundingClientRect(),create=$("lobby-create").getBoundingClientRect();return reopen.top>=stage.top && reopen.bottom<=stage.bottom-32 && create.bottom<=stage.bottom-32;})()'),true);
      await browser.screenshot(guest,path.resolve('artifacts/room-refinement-'+name+'-phone-lobby.png'));
      await browser.evaluate(guest,'document.querySelector("#lobby-rooms button").click()');
      await browser.until(guest,'!!state && state.roomName==="Friday room"','Direct lobby Join');
      assert.equal(await browser.evaluate(guest,'[...document.querySelectorAll("[data-quick-permission]")].every(input=>input.disabled)'),true);
      await browser.evaluate(guest,'$("badge").classList.add("visible");$("close-room").click()'); await browser.until(guest,'!selected','Guest leaves');
      assert.equal(await browser.evaluate(guest,'$("badge").classList.contains("visible")'),false);
      await browser.activate(host);
      await run('$("room-settings-open").click()');
      await until('$("room-settings-dialog").open && !$("room-settings-content").hidden','Settings');
      await shot('settings');
      await run('$("room-rename").value="Unfinished rename";$("room-rename").dispatchEvent(new Event("input"));$("room-settings-visibility").value="private";$("room-settings-visibility").dispatchEvent(new Event("change"))');
      await until('state?.visibility==="private" && $("room-settings-status").textContent==="Saved"','Immediate feedback');
      assert.equal(await run('$("room-rename").value'),'Unfinished rename');
      await run('$("room-settings-section").value="permissions";$("room-settings-section").dispatchEvent(new Event("change"));$("room-permission-custom").open=true');
      await shot('permissions');
      assert.ok(await run('document.querySelector("#room-permissions input[role=switch]")!==null'));
      assert.equal(await run('!!$("room-permission-apply") || !!$("room-permission-summary") || !!document.querySelector("[data-permission=picture]")'),false);
      assert.equal(await run('$("room-permission-preset").value'), 'custom');
      assert.equal(await run('$("room-permission-preset-group").querySelector("[data-value=custom]").hidden'),false);
      assert.equal(await run('[...document.querySelectorAll("#room-permissions input[data-role=viewer]")].filter(input=>["roomSettings","closeRoom","deleteRoom"].includes(input.dataset.permission)).every(input=>input.disabled&&!input.checked)'),true);
      assert.ok(await run('Math.abs($("room-permission-preset-group").getBoundingClientRect().width-document.querySelector("[data-room-section=permissions]").getBoundingClientRect().width)<2'));
      for (const [preset,granted] of [['host-control',[]],['play-pause',['playPause']],['queue',['playPause','seek','chooseMedia','addQueue','editQueue','autoplay']]]) {
        await run('$("room-preset-' + preset + '").focus();$("room-preset-' + preset + '").click()');
        await until('$("room-settings-status").textContent==="Saved" && $("room-permission-preset").value==="' + preset + '"','Immediate preset save');
        assert.deepEqual(await run('Object.keys(state.participantPermissions).filter(key=>state.participantPermissions[key])'),granted);
        assert.equal(await run('document.activeElement.id'),'room-preset-' + preset,'Preset keyboard focus survives saving');
        assert.equal(await run('$("room-permission-preset-group").querySelector("[data-value=custom]").hidden'),true);
        assert.equal(await run('[...document.querySelectorAll("#room-permissions input[data-role=host]")].every(input=>input.checked===(input.dataset.permission!=="deleteRoom"))'),true);
      }
      await shot('permissions-presets');
      await run('document.querySelector("#room-permissions input[data-role=viewer][data-permission=seek]").click()');
      await until('$("room-permission-preset").value==="custom" && !$("room-permission-preset-group").querySelector("[data-value=custom]").hidden','Custom after an individual edit');
      await shot('permissions-custom');
      await run('document.querySelector("#room-permissions input[data-role=viewer][data-permission=seek]").click()');
      await until('$("room-permission-preset").value==="queue" && $("room-permission-preset-group").querySelector("[data-value=custom]").hidden','Preset recognized again');
      assert.equal(await run('$("room-rename").value'),'Unfinished rename');
      await browser.viewport(host,390,844); await shot('phone-permissions');
      await run('$("room-permission-host").click()');
      assert.equal(await run('getComputedStyle(document.querySelector("#room-permissions [data-permission-role=viewer]")).display'),'none');
      await shot('phone-host-permissions');
      await run('$("room-permission-viewer").click()');
      assert.equal(await run('$("room-settings-dialog").scrollWidth <= $("room-settings-dialog").clientWidth'),true);
      await run('$("room-settings-section").value="people";$("room-settings-section").dispatchEvent(new Event("change"))');
      assert.equal(await run('$("room-current-people").children.length'),1); await shot('phone-people');
      await run('$("room-settings-dismiss").click()');
      await browser.viewport(host,1360,1000);
      await run('$("queue-auto-open").click()');
      await until('$("room-settings-dialog").open && $("room-settings-section").value==="playback"','Queue settings unified'); await shot('playback');
      assert.equal(await run('getComputedStyle($("queue-auto-specials").parentElement).display'),'none');
      await run('$("queue-auto-mode").value="random";$("queue-auto-mode").dispatchEvent(new Event("change"));$("queue-source-change").click()');
      await until('$("queue-source-picker").textContent.includes("Fixture Movies")','Source picker libraries');
      await run('[...$("queue-source-picker").querySelectorAll("button")].find(button=>button.textContent==="Use library").click()');
      assert.equal(await run('$("queue-auto-source").textContent'),'Fixture Movies');
      assert.equal(await run('getComputedStyle($("queue-auto-specials").parentElement).display'),'none');
      await browser.viewport(host,390,844); await shot('phone-source');
      await run('$("queue-auto-mode").value="off";$("queue-auto-mode").dispatchEvent(new Event("change"));$("queue-auto-save").click()');
      await until('!$("queue-auto-save").disabled','Draft saved');
      await browser.viewport(host,1360,1000);
      await run('$("room-autoplay").click()');
      await until('state?.autoplay?.enabled===false && !$("queue-autoplay").checked','Shared autoplay controls');
      await run('$("room-settings-dismiss").click()');
      await run('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');
      await until('state?.mediaId==="demo"','Media');
      await run('$("badge").classList.add("visible")');

      await run('execute({action:"media.pause"})');
      await run('execute({action:"media.seek.absolute",args:{seconds:17}})');
      await until('state?.state.paused && Math.abs(state.state.position-17)<.1','Saved position');
      await run('$("theater").click();roomUI.open(selected,"manage")');
      await until('$("room-settings-dialog").open && !$("room-settings-close-live").disabled','Manage'); await shot('theater-manage');
      await run('$("room-settings-close-live").click()');
      await until('$("room-confirm-dialog").open','Close confirmation');
      await run('$("room-confirm-yes").click()');
      await until('!selected','Closed');
      assert.equal(await run('$("badge").classList.contains("visible")'),false);
      await run('$("lobby-reopen").click()');
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
