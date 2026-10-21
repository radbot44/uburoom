/* Popup contracts in disposable Chrome/Firefox profiles and isolated accounts. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const {createApp} = require('../server/app');
const {accountFixture} = require('./account-fixture');
const {playbackBrowser, pause} = require('./lib/playback-browser');

async function main() {
  const output = path.resolve('artifacts/popup-ui-' + Date.now()); fs.mkdirSync(output,{recursive:true});
  for (const name of (process.argv.find(arg=>arg.startsWith('--browsers='))?.slice(11) || 'chrome,firefox').split(',')) {
    const fixture = accountFixture();
    const config = {cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',
      ownerId:fixture.subjects.host,guildId:'fixture',channels:['fixture'],demo:true,unifiedAccounts:true,demoSubjects:fixture.subjects,
      plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
    const app = createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access = {isMember:()=>true,refresh:async()=>true,voiceChannel:()=> 'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); config.publicUrl += ':' + app.server.address().port;
    let browser, page;
    try {
      browser = await playbackBrowser(name); page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = async expression => { await pause(80); return browser.evaluate(page,expression); };
      const until = (expression,label) => browser.until(page,expression,label);
      const shot = label => browser.screenshot(page,path.join(output,name + '-' + label + '.png'));
      const outside = async () => { await browser.tap(page,4,4); await pause(150); };
      await browser.viewport(page,1360,1000); await until('me?.durableRooms && transport?.ready','Login');
      await run('$("identity").click()'); await until('!$("account-content").hidden','Account');
      assert.equal(await run('$("account-dialog").contains(document.activeElement)'),true);
      for (let i = 0; i < 15; i++) await browser.key(page,'Tab');
      assert.equal(await run('$("account-dialog").contains(document.activeElement)'),true,'Native modal traps Tab');
      await outside(); assert.equal(await run('$("account-dialog").open'),false,'Clean account outside dismisses');
      await run('$("identity").click()'); await until('!$("account-content").hidden','Reload account');
      await run('$("account-display-name").value="Unfinished name";$("account-display-name").dispatchEvent(new Event("input"))');
      await outside(); assert.equal(await run('$("account-dialog").open'),true,'Outside protects name draft');
      await browser.key(page,'Escape'); assert.equal(await run('$("account-dialog").open'),true,'Escape protects name draft');
      await run('$("account-close").click();$("identity").click()'); await until('!$("account-content").hidden','Account draft reopen');
      assert.equal(await run('$("account-display-name").value'),'Unfinished name','Explicit close retains name draft');
      await run('$("account-display-name").value=accountValue.name;$("account-display-name").dispatchEvent(new Event("input"))');
      await run('globalThis.releasePopup=uburoomDialogs.hold($("account-dialog"));$("account-close").click()');
      await outside(); await browser.key(page,'Escape');
      assert.equal(await run('$("account-dialog").open'),true,'Critical operation blocks all dismissals');
      await run('releasePopup()'); await browser.key(page,'Escape'); await until('!$("account-dialog").open','Account Escape');
      assert.equal(await run('document.activeElement.id'),'identity','Account restores focus');

      await run('$("create").click();$("room-name").value="Popup fixture";$("room-name").dispatchEvent(new Event("input"))');
      await outside(); assert.equal(await run('$("room-dialog").open'),true,'Room draft protected');
      await run('$("room-create-visibility").value="private";$("room-create-visibility").dispatchEvent(new Event("change"));$("room-create-preset").value="play-pause";$("room-create-preset").dispatchEvent(new Event("change"));$("room-dialog").querySelector("button[value=cancel]").click()');
      await until('!$("room-dialog").open','Cancel room draft'); await run('$("create").click()');
      assert.deepEqual(await run('[$("room-name").value,$("room-create-visibility").value,$("room-create-preset").value]'),['Popup fixture','private','play-pause'],'Creation choices retained');
      await run('$("room-create-visibility").value="public";$("room-create-visibility").dispatchEvent(new Event("change"));$("room-create-preset").value="host-control";$("room-create-preset").dispatchEvent(new Event("change"))');
      await run('$("room-create").click()'); await until('state?.roomName==="Popup fixture"','Create');
      await run('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}})');
      await until('videoFrames>2','Decoded synthetic video');
      await run('$("room-settings-open").click()'); await until('!$("room-settings-content").hidden','Settings');
      assert.equal(await run('(()=>{const r=$("room-settings-dialog").getBoundingClientRect();return r.width===920 && r.height===780 && r.top>=32;})()'),true,'Modest desktop geometry');
      await shot('desktop-general-dark');
      await run('$("room-rename").value="Room draft";$("room-rename").dispatchEvent(new Event("input"));$("room-member-limit").value="19";$("room-member-limit").dispatchEvent(new Event("input"))');
      await outside(); await browser.key(page,'Escape'); assert.equal(await run('$("room-settings-dialog").open'),true,'Settings draft protected');
      await run('$("room-settings-dismiss").click();$("room-settings-open").click()'); await until('!$("room-settings-content").hidden','Settings draft reopen');
      assert.equal(await run('$("room-rename").value'),'Room draft');
      assert.equal(await run('$("room-member-limit").value'),'19','Capacity draft retained');
      await run('$("room-rename").value=state.roomName;$("room-rename").dispatchEvent(new Event("input"));$("room-member-limit").value="20";$("room-member-limit").dispatchEvent(new Event("input"))');
      await run('$("room-settings-section").value="playback";$("room-settings-section").dispatchEvent(new Event("change"))');
      assert.equal(await run('getComputedStyle($("room-autoplay")).width'),'36px','Queue switch track and thumb agree');
      await run('$("queue-auto-mode").value="random";$("queue-auto-mode").dispatchEvent(new Event("change"))');
      await outside(); assert.equal(await run('$("room-settings-dialog").open'),true,'Auto-queue draft protected');
      await run('$("queue-auto-save").previousElementSibling.click()');
      await run('$("room-settings-section").value="permissions";$("room-settings-section").dispatchEvent(new Event("change"))');
      assert.equal(await run('document.querySelector(".room-permission-table").getBoundingClientRect().width<=600'),true,'Constrained permissions');
      await shot('desktop-permissions-dark');
      await run('document.documentElement.dataset.theme="light";document.documentElement.dataset.accent="pink"'); await shot('desktop-permissions-light');
      await browser.viewport(page,390,844); await pause(200); await shot('phone-permissions-light');
      await run('$("room-settings-nav").querySelector("[data-section=manage]").click()');
      await until('!$("room-settings-navigation").classList.contains("hidden-after")','Selected last tab centered');
      assert.equal(await run('$("room-settings-navigation").classList.contains("hidden-before")'),true);
      await shot('phone-manage-light');
      await run('$("room-settings-nav").scrollLeft=0'); await pause(250);
      assert.equal(await run('$("room-settings-nav").scrollLeft'),0,'Manual scroll stays put');
      assert.equal(await run('$("room-settings-navigation").classList.contains("hidden-before")'),false);
      assert.equal(await run('$("room-settings-navigation").classList.contains("hidden-after")'),true);
      await shot('phone-tabs-light');
      await run('$("room-settings-nav").querySelector("[data-section=general]").focus()'); await browser.key(page,'End');
      await until('document.activeElement.dataset.section==="manage"','Keyboard section selection');
      for (const width of [320,390,620]) {
        await browser.viewport(page,width,844); await pause(150);
        assert.equal(await run('(()=>{const d=$("room-settings-dialog"),r=d.getBoundingClientRect(),p=$("room-settings-panels").getBoundingClientRect();return r.left>=15 && r.right<=innerWidth-15 && r.top>=15 && r.bottom<=innerHeight-15 && p.bottom<=r.bottom && d.scrollWidth<=d.clientWidth;})()'),true,'Viewport bounds at ' + width);
      }
      await browser.viewport(page,390,844); await run('document.documentElement.dataset.theme="dark";document.documentElement.dataset.accent="orange"'); await shot('phone-manage-dark');
      await run('$("room-settings-delete").click()'); await until('$("room-confirm-dialog").open','Destructive confirmation');
      assert.equal(await run('$("room-confirm-yes").className'),'danger-button');
      await outside(); assert.equal(await run('$("room-confirm-dialog").open'),true,'Destructive outside blocked');
      await browser.key(page,'Escape'); await until('!$("room-confirm-dialog").open','Destructive cancel');
      assert.equal(await run('$("room-settings-dialog").open'),true,'Only foremost dialog closes');
      await run('void uburoomDialogs.confirm("Reversible confirmation")');
      assert.equal(await run('$("room-confirm-yes").className'),'primary');
      await outside(); assert.equal(await run('$("room-confirm-dialog").open'),false,'Ordinary confirmation outside closes');
      await run('$("room-settings-dismiss").click()');
      await browser.viewport(page,1360,1000);
      await run('globalThis.originalMatchMedia=matchMedia;globalThis.originalScrollTo=$("room-settings-nav").scrollTo;globalThis.tabMotion=[];window.matchMedia=q=>q.includes("reduced-motion")?{matches:true}:originalMatchMedia(q);$("room-settings-nav").scrollTo=function(options){tabMotion.push(options.behavior);originalScrollTo.call(this,options)}');
      await browser.viewport(page,390,844); await run('$("room-settings-open").click()'); await until('!$("room-settings-content").hidden','Reduced motion settings');
      await run('$("room-settings-nav").querySelector("[data-section=manage]").click()'); await pause(100);
      assert.equal(await run('tabMotion.length>0 && tabMotion.every(value=>value==="instant")'),true,'Reduced-motion selection branch');
      await run('window.matchMedia=originalMatchMedia;$("room-settings-nav").scrollTo=originalScrollTo;$("room-settings-dismiss").click()');
      await browser.viewport(page,1360,1000);
      await browser.click(page,'tracks-open'); await until('$("player-settings-menu").matches(":popover-open")','Player menu');
      await browser.key(page,'ArrowRight'); await browser.key(page,'Escape');
      assert.equal(await run('$("player-settings-menu").matches(":popover-open")'),false,'Menu Escape');
      await browser.click(page,'tracks-open'); await browser.click(page,'settings-more');
      assert.equal(await run('$("tracks-dialog").contains(document.activeElement)'),true,'Player dialog focus entry');
      await outside(); await until('!$("tracks-dialog").open','Player dialog outside');
      await run('if(!me.adminMode)$("admin-mode").click()'); await until('me?.adminMode && !$("admin-mode").disabled','Fixture admin mode');

      // Use an independent browser profile for the actual fullscreen matrix.
      const roomId = await run('selected');
      await browser.close(); browser = await playbackBrowser(name);
      page = await browser.page(config.publicUrl + '/watch?demo=host');
      await browser.viewport(page,1360,1000); await until('me?.durableRooms && transport?.ready','Fullscreen page login');
      await run('selectRoom(' + JSON.stringify(roomId) + ')');
      await run('execute({action:"media.play"})'); await until('videoFrames>2','Fullscreen decoded video');
      await run('if(!me.adminMode)$("admin-mode").click()'); await until('me?.adminMode && !$("admin-mode").disabled','Fullscreen fixture admin mode');
      // Genuine user input enters Fullscreen API mode; assert it survives every modal.
      await run('globalThis.fullscreenEvents=[];$("fullscreen").addEventListener("click",e=>fullscreenEvents.push({click:true,trusted:e.isTrusted,active:navigator.userActivation.isActive}));document.addEventListener("fullscreenchange",()=>fullscreenEvents.push({fullscreen:document.fullscreenElement?.id}));window.scrollTo(0,0);playerUI.showChrome();$("fullscreen").focus()');
      await browser.click(page,'fullscreen'); await until('document.fullscreenElement===$("stage")','Actual video fullscreen');
      await run('toggleDrawer(true)');
      await run('$("room-settings-open").click()'); await until('!$("room-settings-content").hidden','Fullscreen settings');
      await shot('fullscreen-settings');
      await browser.key(page,'Escape');
      if (name === 'firefox') {
        await until('!document.fullscreenElement','Firefox reserves fullscreen Escape');
        assert.equal(await run('$("room-settings-dialog").open'),true,'Firefox leaves dialog open after reserved fullscreen exit');
        await run('$("room-settings-dismiss").click()'); await until('!$("room-settings-dialog").open','Explicit settings close');
        await run('window.scrollTo(0,0);playerUI.showChrome()'); await browser.click(page,'fullscreen');
        await until('document.fullscreenElement===$("stage")','Reenter Firefox fullscreen'); await run('toggleDrawer(true)');
      } else {
        await until('!$("room-settings-dialog").open','Fullscreen dialog Escape');
        assert.equal(await run('!!document.fullscreenElement && !drawer.hidden'),true,'Dialog Escape preserves drawer and fullscreen');
      }
      for (const id of ['tracks-dialog','handoff-dialog','account-dialog','account-remove-dialog','room-dialog','room-confirm-dialog','codec-test-dialog','privacy-dialog','queue-bulk-dialog']) {
        await run('uburoomDialogs.open($(' + JSON.stringify(id) + '));true');
        assert.equal(await run('(()=>{const d=$(' + JSON.stringify(id) + '),r=d.getBoundingClientRect();return d.matches(":modal") && d.parentElement===document.fullscreenElement && r.width>0 && r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight && d.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2));})()'),true,id + ' above fullscreen');
        await shot('fullscreen-' + id);
        await run('uburoomDialogs.close($(' + JSON.stringify(id) + '));true');
        assert.equal(await run('document.fullscreenElement===$("stage")'),true,id + ' close keeps fullscreen');
      }
      await run('document.exitFullscreen()'); await until('!document.fullscreenElement','Desktop fullscreen exit');
      await browser.viewport(page,390,844); await run('toggleDrawer(false);playerUI.showChrome()');
      await browser.click(page,'fullscreen'); await until('document.fullscreenElement===$("stage")','Phone actual fullscreen');
      await browser.click(page,'tracks-open'); await until('$("tracks-dialog").open','Mobile fullscreen settings'); await shot('phone-fullscreen-player');
      await run('$("tracks-close").click()'); assert.equal(await run('!!document.fullscreenElement'),true);
      await run('document.exitFullscreen()'); await until('!document.fullscreenElement','Fullscreen exit');
      console.log(name + ' ' + browser.version + ' PASS: dismissal/drafts/busy/focus/keyboard, button roles, tab centering/edges/manual scroll/reduced motion, geometry/themes, decoded video and actual fullscreen dialogs');
    } catch (error) {
      if (browser && page) {
        await browser.screenshot(page,path.join(output,name + '-failure.png'));
        console.error(await browser.evaluate(page,'({error:$("error")?.textContent,settings:$("room-settings-status")?.textContent,dialogs:[...document.querySelectorAll("dialog[open]")].map(d=>d.id),fullscreenEvents:globalThis.fullscreenEvents,fullscreenEnabled:document.fullscreenEnabled,focus:document.activeElement.id})'));
      }
      throw error;
    } finally {
      if (browser) await browser.close();
      await app.close();
    }
  }
  console.log('Screenshots: ' + output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
