/* Layout and fullscreen checks with isolated identities; no live providers or .env. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createApp } = require('../server/app');
const { accountFixture } = require('./account-fixture');
const { playbackBrowser, pause } = require('./lib/playback-browser');
async function main() {
  const before = process.argv.includes('--before');
  const output = path.resolve('artifacts/watch-layout-' + (before ? 'before-' : '') + Date.now());
  fs.mkdirSync(output,{recursive:true});
  for (const name of (process.argv.find(arg=>arg.startsWith('--browsers='))?.slice(11)||'chrome,firefox').split(',')) {
    const fixture = accountFixture();
    const config = {cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),
      publicUrl:'https://localhost',ownerId:fixture.subjects.host,guildId:'fixture',channels:['fixture'],demo:true,
      unifiedAccounts:true,demoSubjects:fixture.subjects,clientId:'100000000000000010',clientSecret:'fixture-secret',
      plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
    const plexFetch = async (input,options) => {
      if (new URL(input).pathname==='/library/sections/1/all') return new Response(JSON.stringify({MediaContainer:{totalSize:48,
        Metadata:Array.from({length:48},(_,i)=>({ratingKey:String(i+1),type:'movie',title:'Layout fixture '+(i+1),year:2026,duration:60000}))}}),{headers:{'Content-Type':'application/json'}});
      return fixture.fetch(input,options);
    };
    const app = createApp(config,{plexFetch,oauthFetch:fixture.discordFetch,plexDemo:fixture});
    app.hub.access = {refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
    config.publicUrl = 'https://localhost:' + app.server.address().port;
    try {
      const browser = await playbackBrowser(name);
      try {
        const page = await browser.page(config.publicUrl+'/watch?demo=host');
        const evaluate = expression=>browser.evaluate(page,expression);
        await browser.until(page,'typeof me!=="undefined"&&!!me&&transport?.ready','Login');
        await evaluate('document.getElementById("create").click();document.getElementById("room-create").click();true');
        await browser.until(page,'!!state&&document.querySelector(".library-home-card")','Library');
        await evaluate('document.querySelector(".library-home-card").click();true');
        await browser.until(page,'document.querySelector(".library-tile")','Library items');
        let normalWidth;
        const measure = async()=>JSON.parse(await evaluate('JSON.stringify((()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};return {stage:rect("stage"),library:rect("library-panel"),room:rect("room-bar"),options:rect("options-panel"),column:rect("room-column"),overflow:document.documentElement.scrollWidth>innerWidth};})())'));
        for (const [label,width,height,wide] of [['1080p',1920,1080,false],['4k',3840,2160,false],['normal',1440,1000,false],['sidebar-small',1101,900,false],['stacked',1000,1000,false],['theater',1440,1000,true],['phone',390,844,false],['phone-theater',390,844,true]]) {
          await browser.viewport(page,width,height);
          await evaluate('setTheater('+wide+');window.scrollTo(0,0);true'); await pause(200);
          if (width <= 700) await evaluate('selectSection("media");true');
          await browser.screenshot(page,path.join(output,name+'-'+label+'.png'));
          const r = await measure();
          if (!before) {
            assert.equal(r.overflow,false,name+' '+label+' horizontal overflow');
            assert.equal(await evaluate('document.getElementById("options-content").contains(document.getElementById("room-bar"))'),true,'Room bar lives inside Room');
            if (width > 700) {
              const q=JSON.parse(await evaluate('JSON.stringify(document.getElementById("queue-panel").getBoundingClientRect().toJSON())'));
              assert.ok(q.y>=r.options.bottom,'Queue follows Room');
              assert.ok(r.library.y>=r.stage.bottom,'Media below player');
              if (width>1100) {
                assert.ok(r.column.x>=r.library.right,'Room and Queue on the right');
                if (wide) {
                  assert.ok(Math.abs(r.column.y-r.library.y)<2,'Theater columns share a row');
                  const ratio=r.library.width/(r.library.width+r.column.width);
                  assert.ok(ratio>.68&&ratio<.72,'Theater Media uses about 70%');
                } else assert.ok(Math.abs(r.options.y-r.stage.y)<2,'Normal Room beside video');
                await evaluate('window.scrollTo(0,document.getElementById("room-column").getBoundingClientRect().top+scrollY);true'); await pause(120);
                const top=(await measure()).column.y;
                const tall=await evaluate('document.getElementById("room-column").offsetHeight > innerHeight - 44');
                assert.equal(await evaluate('getComputedStyle(document.getElementById("room-column")).overflowY'), 'visible', 'Room/Queue has no independent scroll pane');
                await evaluate('window.scrollBy(0,300);true'); await pause(120);
                const after=(await measure()).column;
                if (tall) {
                  assert.ok(after.y<top,label+' tall Room/Queue follows page down');
                  const remaining=await evaluate('Math.max(0,document.getElementById("room-column").getBoundingClientRect().bottom-innerHeight+22)+300');
                  await evaluate('window.scrollBy(0,'+remaining+');true'); await pause(120);
                  const pinned=(await measure()).column;
                  assert.ok(pinned.bottom<=height-20,label+' tall Room/Queue bottom sticks to viewport');
                  await evaluate('window.scrollBy(0,300);true'); await pause(120);
                  assert.ok(Math.abs((await measure()).column.bottom-pinned.bottom)<2,label+' bottom remains sticky');
                  await evaluate('window.scrollBy(0,-100);true'); await pause(120);
                  assert.ok((await measure()).column.y>pinned.y+20,label+' reverse scroll reveals Room/Queue top');
                } else {
                  assert.ok(Math.abs(after.y-top)<2,label+' short Room/Queue sticks at top');
                }
                assert.equal(await evaluate('document.getElementById("room-column").scrollTop'),0,'Room/Queue has no separate scroll');
                await browser.screenshot(page,path.join(output,name+'-'+label+'-panels.png'));
                await evaluate('window.scrollTo(0,0);true');
              }
              assert.equal(await evaluate('JSON.stringify([document.querySelector("#options-panel>.library-header"),document.querySelector(".queue-header"),document.getElementById("library-header")].map(h=>[h.offsetHeight,getComputedStyle(h).paddingTop]))'), '[[80,"20px"],[80,"20px"],[80,"20px"]]','Shared Queue-sized section headers');
              for (const [button,content] of [['options-collapse','options-content'],['queue-collapse','queue-body'],['media-collapse','library-content']]) {
                await evaluate(`document.getElementById('${button}').click();true`);
                assert.equal(await evaluate(`document.getElementById('${button}').getAttribute('aria-expanded')==='false'&&getComputedStyle(document.getElementById('${content}')).display==='none'`),true,'Section collapses: '+button);
                await evaluate(`document.getElementById('${button}').click();true`);
                assert.equal(await evaluate(`getComputedStyle(document.getElementById('${content}')).display!=='none'`),true,'Section reopens: '+button);
              }
            } else {
              assert.equal(await evaluate('getComputedStyle(document.getElementById("library-header")).paddingTop'),'20px','Mobile Media uses the shared top inset');
              assert.equal(await evaluate('getComputedStyle(document.getElementById("options-panel")).display==="none"&&document.getElementById("media-collapse").disabled'),true,'Mobile uses exclusive tabs without collapse');
              assert.ok(Math.abs(r.stage.width-await evaluate('document.documentElement.clientWidth'))<2,'Edge-to-edge mobile player');
            }
            assert.equal(await evaluate('getComputedStyle(document.getElementById("library-panel")).overflowY'),'visible','Media uses page scrolling');
            await evaluate('document.querySelector(".library-tile:last-child").scrollIntoView({block:"end"});true');
            assert.ok(await evaluate('scrollY>0&&document.getElementById("library-panel").scrollTop===0'),'Media uses page scrolling');
            assert.equal(await evaluate('(()=>{const h=document.getElementById("library-header").getBoundingClientRect(),t=document.querySelector(".library-tools").getBoundingClientRect();return Math.abs(h.top)<2&&Math.abs(t.top-h.bottom)<2;})()'),true,'Entire Media navbar sticks together');
            assert.equal(await evaluate('(()=>{const h=document.getElementById("library-header"),r=h.getBoundingClientRect();return [r.left+1,r.right-1].every(x=>document.elementFromPoint(x,r.top+1)?.closest(".library-header")===h);})()'),true,'Sticky header corners cover catalog');
            for (const view of ['list','normal']) {
              const anchor=JSON.parse(await evaluate('JSON.stringify((()=>{const top=Math.max(0,document.querySelector(".library-tools").getBoundingClientRect().bottom),tile=[...document.querySelectorAll(".library-tile")].find(t=>t.getBoundingClientRect().bottom>top);return {id:tile.dataset.item,offset:tile.getBoundingClientRect().top-top};})())'));
              await evaluate(`document.querySelector('.library-views [data-view="${view}"]').click();true`); await pause(120);
              const tile=JSON.parse(await evaluate(`JSON.stringify(document.querySelector('.library-tile[data-item="${anchor.id}"]').getBoundingClientRect().toJSON())`));
              const top=await evaluate('Math.max(0,document.querySelector(".library-tools").getBoundingClientRect().bottom)');
              assert.ok(Math.abs(tile.top-top-Math.max(anchor.offset,-Math.max(0,tile.height-44)))<2,'View change preserves visible item: '+label);
            }
            await evaluate('window.scrollTo(0,0);true');
            if (label==='normal') normalWidth=r.stage.width;
            if (label==='theater') assert.ok(r.stage.width>normalWidth,'Theater enlarges video');
          }
        }
        if (!before) {
          await browser.viewport(page,1440,1000);
          await evaluate('document.getElementById("options-collapse").click();document.getElementById("queue-collapse").click();document.getElementById("media-collapse").click();true');
          await browser.viewport(page,390,844); await pause(100);
          for (const [key,content] of [['room','options-content'],['queue','queue-body'],['media','library-content']]) {
            await evaluate(`selectSection('${key}');true`);
            assert.equal(await evaluate(`getComputedStyle(document.getElementById('${content}')).display!=='none'`),true,'Mobile tab opens desktop-collapsed panel: '+key);
          }
          await browser.viewport(page,1440,1000); await pause(100);
          assert.equal(await evaluate('sectionToggles.every(({button})=>button.getAttribute("aria-expanded")==="false")'),true,'Desktop collapse state survives mobile tabs');
          await evaluate('document.getElementById("options-collapse").click();document.getElementById("queue-collapse").click();document.getElementById("media-collapse").click();true');
          await evaluate('document.getElementById("library-home").click();true');
          await browser.until(page,'document.querySelector("[data-play=demo]")','Synchronization video in library');
          await evaluate('document.querySelector("[data-play=demo]").scrollIntoView();true');
          assert.ok(await evaluate('scrollY>0'),'Playback selection begins below video');
          await evaluate('document.querySelector("[data-play=demo]").click();true');
          await browser.until(page,'state?.mediaId==="demo"&&scrollY===0&&document.activeElement.id==="stage"','Library Play returns to video');
          await browser.until(page,'!state.waitingForReady&&!video.paused&&videoFrames>5','Decoded playback');
          await evaluate('execute({action:"media.pause"}).then(()=>true)');
          await browser.until(page,'video.paused&&state.state.paused&&document.getElementById("stage").classList.contains("paused")','Pause');
          const position = await evaluate('video.currentTime');
          await browser.viewport(page,1440,1000); await evaluate('setTheater(true);window.scrollTo(0,0);true'); await pause(250);
          await browser.click(page,'fullscreen');
          await browser.until(page,'document.fullscreenElement?.id==="stage"&&immersive','Fullscreen');
          await browser.click(page,'drawer-open');
          assert.equal(await evaluate('!drawer.hidden&&drawer.parentElement===document.getElementById("stage")&&document.getElementById("library-panel").parentElement===drawer'),true,'Fullscreen drawer');
          assert.equal(await evaluate('JSON.stringify([...drawer.children].filter(e=>["options-panel","queue-panel","library-panel"].includes(e.id)).map(e=>e.id))'),'["options-panel","queue-panel","library-panel"]','Fullscreen order is Room, Queue, Media');
          await browser.screenshot(page,path.join(output,name+'-fullscreen.png'));
          assert.equal(await evaluate('(()=>{const c=document.getElementById("drawer-close").getBoundingClientRect(),d=drawer.getBoundingClientRect();return !drawer.contains(document.getElementById("drawer-close"))&&c.right<d.left&&c.top<24;})()'),true,'Close button outside drawer top left');
          await browser.click(page,'title');
          assert.equal(await evaluate('drawer.hidden'),true,'Outside click closes fullscreen drawer');
          await browser.click(page,'drawer-open');
          await browser.click(page,'drawer-close');
          assert.equal(await evaluate('drawer.hidden'),true,'External close button closes drawer');
          await evaluate('document.exitFullscreen().then(()=>true)');
          await pause(250);
          await browser.until(page,'!immersive&&theater&&drawer.hidden','Restore theater');
          await browser.viewport(page,390,844);
          await browser.click(page,'fullscreen');
          await browser.until(page,'immersive','Phone fullscreen');
          await evaluate('toggleDrawer(true);selectSection("media");document.querySelector(".library-home-card").click();true');
          await browser.until(page,'document.querySelectorAll(".library-tile").length>20','Phone Menu catalog');
          await evaluate('drawer.scrollTop=1200;true'); await pause(150);
          assert.equal(await evaluate('(()=>{const t=document.getElementById("section-tabs"),h=document.getElementById("library-header").getBoundingClientRect(),m=document.querySelector(".library-tools").getBoundingClientRect(),d=drawer.getBoundingClientRect();return getComputedStyle(t).position==="static"&&t.getBoundingClientRect().bottom<d.top&&Math.abs(h.top-d.top)<2&&Math.abs(m.top-h.bottom)<2;})()'),true,'Phone Menu tabs scroll away while the entire Media navbar pins');
          assert.equal(await evaluate('(()=>{const h=document.getElementById("library-header"),r=h.getBoundingClientRect();return [r.left+1,r.right-1].every(x=>document.elementFromPoint(x,r.top+1)?.closest(".library-header")===h);})()'),true,'Phone Menu header corners cover the catalog');
          await browser.screenshot(page,path.join(output,name+'-phone-menu-media-pinned.png'));
          await evaluate('document.getElementById("library-header").style.minHeight="180px";true'); await pause(150);
          assert.equal(await evaluate('Math.abs(document.querySelector(".library-tools").getBoundingClientRect().top-document.getElementById("library-header").getBoundingClientRect().bottom)<2'),true,'Sticky toolbar follows Media header height changes');
          await evaluate('document.getElementById("library-header").style.minHeight="";drawer.scrollTop=0;true');
          await evaluate('document.exitFullscreen().then(()=>true)');
          await browser.until(page,'!immersive','Exit phone fullscreen');
          await browser.viewport(page,1440,1000); await pause(150);
          await evaluate('setTheater(false);true');
          await browser.click(page,'fullscreen');
          await browser.until(page,'immersive','Normal to fullscreen');
          await evaluate('document.exitFullscreen().then(()=>true)');
          await browser.until(page,'!immersive&&!theater','Restore normal');
          await browser.click(page,'fullscreen');
          await browser.until(page,'immersive','Fullscreen before theater selection');
          await browser.click(page,'theater');
          await browser.until(page,'!document.fullscreenElement&&!immersive&&theater','Fullscreen Theater button exits into theater');
          assert.ok(Math.abs(await evaluate('video.currentTime')-position)<1,'Layout changes preserve paused position');
          await evaluate('execute({action:"media.play"}).then(()=>true)');
          await browser.until(page,'!video.paused&&video.currentTime>'+position+'+0.5','Resume after fullscreen');
          await browser.screenshot(page,path.join(output,name+'-playing.png'));
        }
        const activity = await browser.page(config.publicUrl+'/watch?demo=host&frame_id=fixture');
        await browser.viewport(activity,1280,900);
        await browser.until(activity,'typeof me!=="undefined"&&!!me','Activity login');
        await browser.evaluate(activity,'toggleDrawer(true);true'); await pause(200);
        await browser.screenshot(activity,path.join(output,name+'-activity.png'));
        if (!before) {
          assert.equal(await browser.evaluate(activity,'immersive&&!theater&&document.getElementById("theater").hidden&&document.getElementById("fullscreen").hidden&&document.getElementById("library-panel").parentElement===drawer'),true);
          await browser.evaluate(activity,'setTheater(true);updateActivityLayout({layout_mode:1});true');
          assert.equal(await browser.evaluate(activity,'!theater&&drawer.hidden&&document.body.classList.contains("activity-pip")'),true,'Activity rejects theater; PIP hides drawer');
          await browser.screenshot(activity,path.join(output,name+'-pip.png'));
        }
        if (!before) {
          await evaluate('setTheater(true);true');
          const restored=await browser.page(config.publicUrl+'/watch?mode-probe=theater');
          await browser.until(restored,'typeof theater==="boolean"','Restored mode initialization');
          assert.equal(await browser.evaluate(restored,'theater&&document.body.classList.contains("theater")'),true,'Page restores saved theater mode');
          assert.ok(fs.readFileSync(path.resolve('web/watch.html'),'utf8').indexOf('/watch-layout.js')<fs.readFileSync(path.resolve('web/watch.html'),'utf8').indexOf('<main'),'Saved mode script blocks before page content');
          await evaluate('setTheater(false);true');
          const normal=await browser.page(config.publicUrl+'/watch?mode-probe=normal');
          await browser.until(normal,'typeof theater==="boolean"','Normal mode initialization');
          assert.equal(await browser.evaluate(normal,'!theater&&!document.body.classList.contains("theater")'),true,'Page restores normal mode');
        }
        console.log(name+' '+browser.version+': '+(before?'before captures':'PASS'));
      } finally { await browser.close(); }
    } finally { await app.close(); }
  }
  console.log(output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
