/* Queue shared-control contract in disposable Chrome/Firefox rooms. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');

async function main() {
  for (const name of ['chrome', 'firefox']) {
    const fixture = accountFixture();
    const config = { cert:fs.readFileSync('certs/server-cert.pem'), key:fs.readFileSync('certs/server-key.pem'),
      publicUrl:'https://localhost', ownerId:fixture.subjects.host, guildId:'fixture', channels:['fixture'],
      demo:true, unifiedAccounts:true, demoSubjects:fixture.subjects,
      plexUrl:'http://plex-fixture.invalid:32400', plexToken:'fixture-owner' };
    const app = createApp(config,{plexFetch:fixture.fetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    let browser, page;
    try {
      browser = await playbackBrowser(name);
      page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = expression => browser.evaluate(page,expression);
      const until = (expression,label) => browser.until(page,expression,label);
      const shot = label => browser.screenshot(page,path.resolve('artifacts/queue-controls-' + name + '-after-' + label + '.png'));
      await browser.viewport(page,1600,1050);
      await until('me?.durableRooms && transport?.ready','Login');
      assert.equal(await run('!!window.OverlayScrollbarsGlobal && document.querySelectorAll(".os-scrollbar").length===2'),true,'OverlayScrollbars initializes on the page');
      assert.equal(await run('$("queue-auto-open").disabled && $("queue-auto-open").title.includes("Join a room")'),true);
      await shot('outside-room');
      await run('$("create").click();$("room-name").value="Queue controls fixture";$("room-create").click()');
      await until('state?.durable && !pending','Create room');
      await run('queueUI.add({mediaId:"demo",title:"Current video",duration:60})');
      await until('state?.mediaId==="demo"','Current item');
      await run('queueUI.add({mediaId:"demo",title:"Next video",duration:60})');
      await until('document.querySelector(".queue-entry")','Queued item');
      assert.deepEqual(await run(`(()=>{const ids=['queue-center','queue-auto-open'];return ids.map(id=>{const e=$(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return [r.height,s.borderTopWidth,s.borderRadius]})})()`),
        [[40,'0px','10px'],[40,'0px','10px']]);
      assert.deepEqual(await run('(()=>{const r=$("queue-auto-open").getBoundingClientRect();return [r.width,r.height]})()'),[40,40]);
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).fontSize'),'17px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).gap'),'8px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-quick-controls")).gap'),'8px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-header")).rowGap'),'16px');
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-view-switch")).borderRadius'),'12px');
      assert.equal(await run('document.querySelector(".queue-view-button>svg").getBoundingClientRect().width'),24);
      assert.equal(await run('$("queue-view-cards").getBoundingClientRect().width >= 40'),true,'Selected Queue view has at least 40px width');
      const footerGeometry = await run(`(()=>{const room=getComputedStyle($("switch-room"));return ["queue-clear-history","queue-shuffle","queue-clear-queue"].map(id=>{const e=$(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return [id,e.className,r.height,s.borderRadius,s.backgroundColor,s.borderTopWidth,room.borderRadius,room.backgroundColor]})})()`);
      assert.equal(footerGeometry.every(([,classes,height,radius,background,border,roomRadius,roomBackground]) => classes.includes('watch-control') && height===40 && radius===roomRadius && background===roomBackground && border==='0px'),true,'Queue footer shares Room button appearance and height, including disabled actions: ' + JSON.stringify(footerGeometry));
      assert.equal(await run('$("queue-clear-history").disabled && $("queue-shuffle").disabled && getComputedStyle($("queue-clear-history")).opacity==="1" && getComputedStyle($("queue-shuffle")).opacity==="1"'),true,'Disabled footer buttons keep a visible background');
      assert.equal(await run('$("queue-clear-history").title.includes("no playback history") && $("queue-shuffle").title.includes("at least two")'),true,'Disabled footer actions explain their prerequisites');
      assert.deepEqual(await run('(()=>{const r=$("queue-shuffle").getBoundingClientRect();return [r.width,r.height]})()'),[40,40]);
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-footer-actions")).gap'),'8px');
      assert.equal(await run('$("room-settings-open").getBoundingClientRect().height===40 && getComputedStyle($("room-settings-open")).borderTopWidth==="0px"'),true,'Room header remains unchanged');
      assert.equal(await run('$("queue-view-cards").getBoundingClientRect().height < 40 && document.querySelector(".queue-view-switch").getBoundingClientRect().height===40'),true);
      assert.equal(await run('getComputedStyle($("queue-view-cards")).backgroundColor===getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()'),true);
      assert.equal(await run('$("queue-view-cards").getAttribute("aria-pressed")'), 'true');
      assert.equal(await run('$("queue-view-list").tabIndex'),-1);
      await run('$("queue-view-cards").focus()');
      await browser.key(page,'ArrowRight');
      assert.equal(await run('document.activeElement.id'),'queue-view-list');
      assert.equal(await run('$("queue-view-cards").getAttribute("aria-pressed")'),'true','Arrows move focus only');
      await browser.key(page,'Enter');
      assert.equal(await run('$("queue-view-list").getAttribute("aria-pressed")'),'true');
      assert.equal(await run('$("queue-content").dataset.view'),'list');
      assert.equal(await run('getComputedStyle($("queue-view-list")).outlineWidth'),'2px');
      assert.equal(await run('getComputedStyle($("queue-view-list")).outlineColor===getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()'),true);
      assert.equal(await run('["queue-autoplay","queue-auto-toggle"].every(id=>$(id).getAttribute("role")==="switch" && $(id).getBoundingClientRect().width===36 && $(id).getBoundingClientRect().height===22 && $(id).closest("label").getBoundingClientRect().height>=44)'),true);
      const autoplay = await run('$("queue-autoplay").checked');
      await run(`globalThis.originalQueueRequest=transport.request.bind(transport);globalThis.queueWrites=0;
        transport.request=async(path,data,options)=>{if(data?.command?.action==='media.autoplay.set'){queueWrites++;await new Promise(resolve=>setTimeout(resolve,700));}return originalQueueRequest(path,data,options)};
        $("queue-autoplay").closest("label").click()`);
      assert.equal(await run('$("queue-autoplay").disabled && !$("queue-auto-open").disabled && document.querySelector(".queue-notice").textContent==="Saving Auto-play…"'),true);
      await shot('processing');
      await run('$("queue-autoplay").click()');
      await until('$("queue-autoplay").checked===' + String(!autoplay),'Label switches Auto-play');
      await until('!$("queue-autoplay").disabled','Auto-play save');
      assert.equal(await run('queueWrites'),1,'Pending toggle ignores duplicate click');
      assert.equal(await run('state.autoplay.enabled'),!autoplay);
      await run('transport.request=originalQueueRequest');
      await run('$("queue-auto-open").click()');
      await until('$("room-settings-dialog").open','Queue settings');
      assert.equal(await run('$("queue-auto-mode-group").getBoundingClientRect().height'),40);
      assert.equal(await run('[...$("queue-auto-mode-group").querySelectorAll("button")].filter(e=>e.tabIndex===0).length'),1);
      await run('$("queue-auto-mode-group").querySelector("button").focus()');
      await browser.key(page,'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.value'),'following');
      assert.equal(await run('$("queue-auto-mode-group").querySelector("[aria-pressed=true]").dataset.value'),'off');
      await browser.key(page,' ');
      assert.equal(await run('$("queue-auto-mode-group").querySelector("[aria-pressed=true]").dataset.value'),'following');
      assert.equal(await run('$("queue-auto-mode").value'),'following');
      assert.equal(await run('[$("room-autoplay"),$("queue-auto-specials")].every(e=>e.getAttribute("role")==="switch")'),true);
      assert.equal(await run('$("room-autoplay").closest("label").getBoundingClientRect().height'),44);
      await shot('desktop-settings');
      await run('$("room-settings-dialog").close()');
      await run('$("queue-view-cards").click();$("queue-panel").scrollIntoView({block:"start"})');
      await pause(1500);
      assert.equal(await run('getComputedStyle($("room-column")).overflowY==="visible" && [...document.querySelectorAll(".os-scrollbar")].every(e=>e.classList.contains("os-scrollbar-auto-hide-hidden") && getComputedStyle(e).opacity==="0")'),true,'Page overlay hides after scrolling settles; Room/Queue do not gain a nested scroller');
      await shot('desktop');
      const hoverPoint = await run('(()=>{const r=$("queue-center").getBoundingClientRect();return [r.left+r.width/2,r.top+r.height/2]})()');
      const normalBackground = await run('getComputedStyle($("queue-center")).backgroundColor');
      await browser.move(page,...hoverPoint);
      assert.notEqual(await run('getComputedStyle($("queue-center")).backgroundColor'),normalBackground);
      await shot('hover');
      await browser.move(page,0,0);
      await browser.viewport(page,390,844);
      await run('$("section-tab-queue").click()');
      await run('$("queue-view-cards").click()');
      await pause(1500);
      assert.equal(await run('getComputedStyle(document.querySelector(".queue-heading")).fontSize'),'17px');
      assert.equal(await run('$("queue-view-list").querySelector("span").getBoundingClientRect().width'),0,'Narrow view label hidden');
      assert.equal(await run('!!$("queue-view-list").getAttribute("aria-label") && !!$("queue-view-list").title'),true);
      const viewInsets = await run('(()=>{const b=$("queue-view-cards").getBoundingClientRect(),i=$("queue-view-cards").querySelector("svg").getBoundingClientRect();return [b.width,i.width,i.left-b.left,b.right-i.right]})()');
      assert.equal(viewInsets[0]>=40 && viewInsets[2]>=8 && viewInsets[3]>=8,true,'Selected narrow view gives its icon at least 8px on either side: ' + JSON.stringify(viewInsets));
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth + 1'),true,'No phone overflow');
      await shot('narrow');
      await run('document.querySelector(".queue-footer").scrollIntoView({block:"end"})');
      await pause(1200);
      await shot('narrow-footer');
      await browser.viewport(page,320,844);
      await pause(1500);
      assert.equal(await run('document.documentElement.scrollWidth <= innerWidth + 1'),true,'No 320px overflow');
      assert.equal(await run('(()=>{const f=document.querySelector(".queue-footer").getBoundingClientRect();return ["queue-clear-history","queue-shuffle","queue-clear-queue"].every(id=>{const r=$(id).getBoundingClientRect();return r.height===40 && r.left>=f.left-1 && r.right<=f.right+1})})()'),true,'Standard footer buttons fit inside the 320px Queue');
      assert.equal(await run('$("queue-center").getBoundingClientRect().width===40 && getComputedStyle($("queue-center").querySelector(".watch-control-label")).display==="none"'),true);
      await shot('narrow-320');
      await run('document.querySelector(".queue-footer").scrollIntoView({block:"end"})');
      await pause(1200);
      await shot('narrow-320-footer');
      console.log(name + ': Queue controls and desktop/narrow captures passed');
    } finally {
      await browser?.close();
      await new Promise(resolve=>app.server.close(resolve));
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
