/* Media shared controls and sticky layout in disposable Chrome/Firefox rooms. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');

async function main() {
  for (const name of ['chrome','firefox']) {
    const fixture = accountFixture();
    const config = {cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),
      publicUrl:'https://localhost',ownerId:fixture.subjects.host,guildId:'fixture',channels:['fixture'],demo:true,
      unifiedAccounts:true,demoSubjects:fixture.subjects,plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
    const plexFetch = async (input,options) => {
      const pathname = new URL(input).pathname;
      if (pathname === '/library/sections') return new Response(JSON.stringify({MediaContainer:{Directory:[
        {key:'1',type:'movie',title:'Fixture Movies'},{key:'2',type:'movie',title:'Fixture Extras'}]}}),{headers:{'Content-Type':'application/json'}});
      if (/^\/library\/sections\/[12]\/(genre|year)$/.test(pathname)) return new Response(JSON.stringify({MediaContainer:{Directory:[{key:pathname.endsWith('/genre')?'1':'2026',title:pathname.endsWith('/genre')?'Drama':'2026'}]}}),{headers:{'Content-Type':'application/json'}});
      if (['/library/sections/1/all','/library/sections/2/all'].includes(pathname)) return new Response(JSON.stringify({MediaContainer:{totalSize:48,
        Metadata:Array.from({length:48},(_,i) => ({ratingKey:String(i+1),type:'movie',title:'Media control '+(i+1),year:2026,duration:60000}))}}),{headers:{'Content-Type':'application/json'}});
      return fixture.fetch(input,options);
    };
    const app = createApp(config,{plexFetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    let browser;
    try {
      browser = await playbackBrowser(name);
      const page = await browser.page(config.publicUrl + '/watch?demo=host');
      const run = expression => browser.evaluate(page,expression);
      const until = (expression,label) => browser.until(page,expression,label);
      const shot = label => browser.screenshot(page,path.resolve('artifacts/media-controls-' + name + '-after-' + label + '.png'));
      await browser.viewport(page,1440,1000);
      await until('me?.durableRooms && transport?.ready','Login');
      await run('$("create").click();$("room-create").click()');
      await until('document.querySelector(".library-home-card")','Media home');
      await pause(300);
      await run('document.querySelector(".library-home-card").click()');
      await until('document.querySelector(".library-tile")','Media items');
      await run('$("library-panel").scrollIntoView({block:"start"})');
      await pause(180);
      assert.equal(await run('getComputedStyle($("library-heading")).fontSize'),'24px');
      assert.equal(await run('(()=>{const a=$("media-symbol").getBoundingClientRect(),b=$("library-heading").querySelector(".section-toggle>span:last-of-type").getBoundingClientRect();return Math.round(b.left-a.right)})()'),8);
      assert.equal(await run('$("media-symbol").querySelector("svg").getBoundingClientRect().width'),24);
      assert.equal(await run('(()=>{const ids=["library-back","library-forward","library-home","library-direction","library-filters-toggle"];const elevated=getComputedStyle($("switch-room")).backgroundColor;return ids.every(id=>{const e=$(id),r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.height===40 && s.borderRadius==="10px" && s.borderTopWidth==="0px" && s.backgroundColor===elevated})})()'),true,'Media actions use the Room control surface even while disabled');
      assert.equal(await run('["library-back","library-forward","library-home","library-direction"].every(id=>$(id).getBoundingClientRect().width===40)'),true);
      assert.equal(await run('$("search").getBoundingClientRect().height===40 && $("library-sort").getBoundingClientRect().height===40 && getComputedStyle($("search")).borderTopWidth==="1px" && getComputedStyle($("library-sort")).borderTopWidth==="1px"'),true);
      assert.equal(await run('$("library-forward").disabled && $("library-forward").title.includes("No later")'),true,'Disabled navigation explains its state');
      assert.equal(await run('(()=>{const b=document.querySelector(".library-scope-actions .watch-control"),r=b.getBoundingClientRect(),s=getComputedStyle(b);return r.height===40 && s.borderTopWidth==="0px" && b.querySelector("svg").getBoundingClientRect().width===24})()'),true,'Header auto-queue uses shared controls');
      await run('$("search").focus()');
      assert.equal(await run('getComputedStyle($("search")).outlineWidth'),'2px');
      assert.equal(await run('document.querySelector(".library-views").getBoundingClientRect().height===40 && document.querySelector(".library-choices").getBoundingClientRect().height===40'),true);
      assert.equal(await run('document.querySelector(".library-views .group-button>svg").getBoundingClientRect().width'),24);
      assert.equal(await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'),'cards');
      assert.equal(await run('[...document.querySelectorAll(".library-views button")].filter(b=>b.tabIndex===0).length'),1);
      await run('document.querySelector(".library-views [data-view=cards]").focus()');
      await browser.key(page,'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.view'),'list');
      assert.equal(await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'),'cards','Arrow focus does not select');
      await browser.key(page,'Enter');
      assert.equal(await run('document.querySelector(".library-views [aria-pressed=true]").dataset.view'),'list');
      assert.equal(await run('getComputedStyle(document.activeElement).outlineWidth'),'2px');
      const libraryChoices = await run('[...document.querySelectorAll(".library-choices button")].map(b=>[b.dataset.section,b.textContent])');
      assert.equal(libraryChoices.length,2,'Fixture has two library choices: ' + JSON.stringify(libraryChoices));
      await run('document.querySelector(".library-choices button:first-child").focus()');
      await browser.key(page,'ArrowRight');
      assert.equal(await run('document.activeElement.dataset.section'),libraryChoices[1][0]);
      assert.equal(await run('document.querySelector(".library-choices [aria-pressed=true]").dataset.section'),libraryChoices[0][0],'Library arrows move focus without navigating');
      await browser.key(page,'Enter');
      await until('document.querySelector(".library-choices button:nth-child(2)[aria-pressed=true]")','Choose second library');
      assert.equal(await run('document.activeElement.dataset.section'),libraryChoices[1][0],'Focused library choice survives rerender');
      await run('document.querySelector(".library-choices button:first-child").click()');
      await until('document.querySelector(".library-choices button:first-child[aria-pressed=true]")','Return to first library');
      await run('document.querySelector(".library-views [data-view=cards]").click();$("library-panel").scrollIntoView({block:"start"})');
      await run('$("media-collapse").click()');
      assert.equal(await run('$("library-panel").classList.contains("section-collapsed") && getComputedStyle($("library-content")).display==="none"'),true,'Media collapse preserves panel behavior');
      await run('$("media-collapse").click()');
      assert.equal(await run('!$("library-panel").classList.contains("section-collapsed")'),true);
      await shot('desktop');
      await run('$("theme-toggle").click()');
      assert.equal(await run('getComputedStyle(document.querySelector(".library-views [aria-pressed=true]")).backgroundColor===getComputedStyle(document.documentElement).getPropertyValue("--primary").trim()'),true,'Media selected view follows the active theme');
      await shot('light');
      await run('$("theme-toggle").click()');
      await run('document.querySelector(".library-tile:last-child").scrollIntoView({block:"end"})');
      await pause(180);
      assert.equal(await run('(()=>{const h=$("library-header").getBoundingClientRect(),t=document.querySelector(".library-tools").getBoundingClientRect();return Math.abs(h.top)<2 && Math.abs(t.top-h.bottom)<2 && $("library-panel").scrollTop===0 && getComputedStyle($("library-panel")).getPropertyValue("--media-header-height").trim()===Math.round(h.height)+"px"})()'),true,'Header and tools remain sticky with measured offset and page scrolling');
      await shot('scrolled');
      await run('setTheater(true);document.querySelector(".library-tile:last-child").scrollIntoView({block:"end"})');
      await pause(180);
      assert.equal(await run('(()=>{const h=$("library-header").getBoundingClientRect(),t=document.querySelector(".library-tools").getBoundingClientRect();return Math.abs(h.top)<2 && Math.abs(t.top-h.bottom)<2 && $("library-panel").scrollTop===0})()'),true,'Theater retains the sticky Media pair and page scroll');
      assert.equal(await run('$("library-top").getBoundingClientRect().height===40'),true,'Back to top uses shared 40px control');
      await shot('theater');
      await run('window.scrollTo(0,0)');
      await browser.click(page,'fullscreen');
      await until('immersive && document.fullscreenElement','Fullscreen');
      await browser.click(page,'drawer-open');
      await until('!drawer.hidden','Fullscreen Menu');
      await run('drawer.scrollTop=1200');
      await pause(180);
      assert.equal(await run('(()=>{const d=drawer.getBoundingClientRect(),h=$("library-header").getBoundingClientRect(),t=document.querySelector(".library-tools").getBoundingClientRect();return Math.abs(h.top-d.top)<2 && Math.abs(t.top-h.bottom)<2 && getComputedStyle($("library-panel")).getPropertyValue("--media-header-height").trim()===Math.round(h.height)+"px"})()'),true,'Menu keeps the measured sticky Media header and toolbar');
      await shot('drawer');
      if (name === 'chrome') {
        await browser.viewport(page,390,844);
        await run('selectSection("media");drawer.scrollTop=1200');
        await pause(180);
        assert.equal(await run('(()=>{const d=drawer.getBoundingClientRect(),h=$("library-header").getBoundingClientRect(),t=document.querySelector(".library-tools").getBoundingClientRect();return h.height>40 && t.height>0 && Math.abs(h.top-d.top)<2 && Math.abs(t.top-h.bottom)<2 && getComputedStyle($("library-panel")).getPropertyValue("--media-header-height").trim()===Math.round(h.height)+"px"})()'),true,'Phone Menu follows the visible wrapped Media header height');
        await shot('phone-drawer');
      }
      await browser.click(page,'drawer-close');
      await until('drawer.hidden','Close Menu');
      await browser.click(page,'fullscreen');
      await until('!immersive','Exit fullscreen');
      await run('setTheater(false)');
      await browser.viewport(page,390,844);
      await run('$("section-tab-media").click();$("library-panel").scrollIntoView({block:"start"})');
      await pause(180);
      assert.equal(await run('(()=>{const h=$("library-heading").getBoundingClientRect(),n=document.querySelector(".library-navigation-history").getBoundingClientRect(),a=document.querySelector(".library-scope-actions .watch-control").getBoundingClientRect(),t=$("library-top").getBoundingClientRect();return Math.abs(h.top-n.top)<2 && Math.abs(h.top-a.top)<2 && Math.abs(h.top-t.top)<2 && t.width===40})()'),true,'Media, navigation, auto-queue and Back to top share the phone header row');
      assert.equal(await run('$("library-top").querySelector("svg").getAttribute("data-tabler-icon")==="arrow-bar-to-up" && getComputedStyle($("library-top").querySelector(".watch-control-label")).display==="none" && $("library-top").getAttribute("aria-label")==="Back to top"'),true,'Back to top has the requested icon and accessible compact label');
      assert.equal(await run('getComputedStyle(document.querySelector(".library-choices")).display==="none" && !$("library-home").disabled'),true,'Phone hides the switcher but keeps Libraries home navigation');
      assert.equal(await run('getComputedStyle(document.querySelector(".library-views .group-button span")).display'),'none');
      assert.equal(await run('getComputedStyle(document.querySelector("#library-filters-toggle .filter-label")).display==="none" && getComputedStyle(document.querySelector(".library-scope-actions .queue-label")).display==="none"'),true,'Narrow toolbar labels hide with accessible button names');
      assert.equal(await run('document.querySelector(".library-views .group-button").getBoundingClientRect().width>=40 && document.documentElement.scrollWidth<=innerWidth+1'),true);
      assert.equal(await run('Math.abs($("library-sort").getBoundingClientRect().top-document.querySelector(".library-views").getBoundingClientRect().top)<2'),true,'Phone view selector shares the sort row');
      await run('$("library-filters-toggle").click()');
      assert.equal(await run('(()=>{const s=[...document.querySelectorAll(".library-filters select")],status=document.querySelector(".library-filters>.hint");return s.length===2 && Math.abs(s[0].getBoundingClientRect().top-s[1].getBoundingClientRect().top)<2 && s.every(x=>x.getBoundingClientRect().width>70) && (getComputedStyle(status).display==="none" || status.getBoundingClientRect().top>=s[0].getBoundingClientRect().bottom)})()'),true,'Usable Genre and Year dropdowns share one row with status below');
      await shot('phone-filters');
      await run('$("library-filters-toggle").click()');
      await shot('phone');
      if (name === 'chrome') {
        await browser.mobileViewport(page,390,844);
        await pause(180);
        assert.equal(await run('matchMedia("(pointer: coarse)").matches'),true,'Chrome fixture emulates touch input');
        assert.equal(await run('(()=>{const b=document.querySelector("[data-view=cards] .library-tile .library-play"),a=b.closest(".library-art"),r=b.getBoundingClientRect(),ar=a.getBoundingClientRect(),s=getComputedStyle(b);return s.opacity==="0" && s.pointerEvents==="none" && Math.abs(r.left+r.width/2-ar.left-ar.width/2)<2 && Math.abs(r.top+r.height/2-ar.top-ar.height/2)<2})()'),true,'Touch Cards play affordance stays hidden and centered until revealed');
        await shot('phone-touch');
        await run('document.querySelector(".library-tile .library-open").click()');
        await until('!document.querySelector(".library-overview").hidden && !!document.querySelector(".library-detail-actions .library-play-now")','Cards poster opens Play details');
        await shot('phone-touch-detail');
        await run('$("library-back").click()');
        await until('!!document.querySelector(".library-tile") && document.querySelector(".library-overview").hidden','Return to Cards');
      }
      await browser.viewport(page,320,844);
      await pause(180);
      assert.equal(await run('document.documentElement.scrollWidth<=innerWidth+1'),true,'320px Media fits');
      await shot('narrow');
      console.log(name + ': Media controls and sticky desktop/phone checks passed');
    } finally {
      await browser?.close();
      await new Promise(resolve=>app.server.close(resolve));
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
