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
    for (const name of ['chrome','firefox']) {
      const browser = await playbackBrowser(name);
      try {
        const page = await browser.page(config.publicUrl+'/watch?demo=host');
        const evaluate = expression=>browser.evaluate(page,expression);
        await browser.until(page,'typeof me!=="undefined"&&!!me','Login');
        await evaluate('document.getElementById("create").click();true');
        await browser.until(page,'!!state&&document.querySelector(".library-home-card")','Library');
        await evaluate('document.querySelector(".library-home-card").click();true');
        await browser.until(page,'document.querySelector(".library-tile")','Library items');
        let normalWidth;
        const measure = async()=>JSON.parse(await evaluate('JSON.stringify((()=>{const rect=id=>{const r=document.getElementById(id).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};return {stage:rect("stage"),library:rect("library-panel"),room:rect("room-bar"),options:rect("options-panel"),overflow:document.documentElement.scrollWidth>innerWidth};})())'));
        for (const [label,width,height,wide] of [['1080p',1920,1080,false],['4k',3840,2160,false],['normal',1440,1000,false],['theater',1440,1000,true],['phone',390,844,false],['phone-theater',390,844,true]]) {
          await browser.viewport(page,width,height);
          await evaluate('setTheater('+wide+');window.scrollTo(0,0);true'); await pause(200);
          await browser.screenshot(page,path.join(output,name+'-'+label+'.png'));
          const r = await measure();
          if (!before) {
            assert.equal(r.overflow,false,name+' '+label+' horizontal overflow');
            assert.ok(r.room.y>=r.stage.bottom && r.options.y>=r.room.bottom,'Room and options below video');
            if (!(wide&&width>700)&&width>1100) assert.ok(r.library.x>=r.stage.right,'Normal library beside video');
            else assert.ok(r.library.y>=r.stage.bottom,'Stacked library');
            if (!(wide&&width>700)&&width>1100) assert.equal(await evaluate('getComputedStyle(document.querySelector(".library")).gridTemplateColumns.split(" ").length'),4,'Four normal-view posters per row');
            assert.equal(await evaluate('drawer.hidden&&document.getElementById("drawer-open").hidden'),true);
            if (label==='normal') normalWidth=r.stage.width;
            if (label==='theater') assert.ok(r.stage.width>normalWidth,'Theater enlarges video');
            if (label==='1080p'||label==='4k') {
              const content=r.library.right-r.stage.x;
              assert.ok(Math.abs(content-(label==='1080p'?1702:2052))<2,'Requested expanded content width');
              assert.ok(Math.abs(r.stage.width/r.library.width-2)<.02,'Columns expand proportionally');
            }
            if (wide&&width>700) {
              assert.ok(Math.abs(r.stage.x*2+r.stage.width-await evaluate('document.documentElement.clientWidth'))<2,'Theater player is horizontally centered');
              const section=await evaluate('document.getElementById("viewing-section").getBoundingClientRect().bottom');
              assert.ok(section<=height+2,'Theater fits the remaining viewport');
              assert.ok(r.stage.height<=r.stage.width,'Landscape theater player');
              assert.ok(r.room.bottom<=section,'Room bar fits black viewing section');
              assert.equal(await evaluate('getComputedStyle(document.getElementById("viewing-section")).backgroundColor'), 'rgb(16, 18, 23)','Normal background behind room bar');
              if (width>1100) {
                assert.ok(Math.abs(r.options.y-r.library.y)<2&&r.library.x>=r.options.right,'Theater options and library share a row');
                assert.ok(r.options.width/width>.2&&r.options.width/width<.26,'Theater options use about a quarter of the page');
                await evaluate('window.scrollTo(0,document.getElementById("options-panel").getBoundingClientRect().top+scrollY-18);true');
                await pause(220);
                await browser.screenshot(page,path.join(output,name+'-theater-panels.png'));
                await evaluate('window.scrollTo(0,0);true'); await pause(220);
              }
              assert.ok(await evaluate('Number(getComputedStyle(document.getElementById("room-bar")).opacity)<.5'),'Room bar dims at page top');
              await evaluate('window.scrollTo(0,20);true'); await pause(220);
              assert.equal(await evaluate('getComputedStyle(document.getElementById("room-bar")).opacity'),'1','Scrolling reveals room bar');
              await evaluate('window.scrollTo(0,0);true');
              await evaluate('document.getElementById("refresh").focus();true'); await pause(220);
              assert.equal(await evaluate('getComputedStyle(document.getElementById("room-bar")).opacity'),'1','Keyboard focus reveals room bar');
              await evaluate('document.activeElement.blur();true');
            }
            if (width<=700) {
              assert.equal(await evaluate('!theater&&getComputedStyle(document.getElementById("theater")).display==="none"'),true,'Mobile theater unavailable');
              assert.ok(Math.abs(r.stage.width-await evaluate('document.documentElement.clientWidth'))<2,'Edge-to-edge mobile player');
            }
            if (label==='normal') {
              const top=r.stage.y;
              await evaluate('document.getElementById("library-panel").scrollTop=500;true');
              assert.equal(await evaluate('document.getElementById("library-panel").scrollTop'),500,'Library scrolls independently');
              assert.equal((await measure()).stage.y,top,'Library scroll leaves video in place');
              await evaluate('document.getElementById("library-panel").scrollTop=0;true');
              assert.equal(await evaluate('!document.querySelector(".library-tabs")&&!document.getElementById("account-settings")&&document.getElementById("create").previousElementSibling.id==="refresh"'),true,'Toolbar and header arrangement');
              assert.equal(await evaluate('getComputedStyle(document.querySelector(".library-tools")).backgroundColor===getComputedStyle(document.getElementById("library-panel")).backgroundColor'),true,'Unified library surface');
              await browser.click(page,'identity');
              await browser.until(page,'document.getElementById("account-dialog").open','Username opens account');
              await evaluate('document.getElementById("account-dialog").close();document.activeElement.blur();true');
            }
          }
        }
        if (!before) {
          await evaluate('execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
          await browser.until(page,'!state.waitingForReady&&!video.paused&&videoFrames>5','Decoded playback');
          await evaluate('execute({action:"media.pause"}).then(()=>true)');
          await browser.until(page,'video.paused&&state.state.paused&&document.getElementById("stage").classList.contains("paused")','Pause');
          const position = await evaluate('video.currentTime');
          await browser.viewport(page,1440,1000); await evaluate('setTheater(true);window.scrollTo(0,0);true'); await pause(250);
          await browser.click(page,'fullscreen');
          await browser.until(page,'document.fullscreenElement?.id==="stage"&&immersive','Fullscreen');
          await browser.click(page,'drawer-open');
          assert.equal(await evaluate('!drawer.hidden&&drawer.parentElement===document.getElementById("stage")&&document.getElementById("library-panel").parentElement===drawer'),true,'Fullscreen drawer');
          await browser.screenshot(page,path.join(output,name+'-fullscreen.png'));
          await evaluate('document.exitFullscreen().then(()=>true)');
          await browser.until(page,'!immersive&&theater&&drawer.hidden','Restore theater');
          await evaluate('setTheater(false);true');
          await browser.click(page,'fullscreen');
          await browser.until(page,'immersive','Normal to fullscreen');
          await evaluate('document.exitFullscreen().then(()=>true)');
          await browser.until(page,'!immersive&&!theater','Restore normal');
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
        console.log(name+' '+browser.version+': '+(before?'before captures':'PASS'));
      } finally { await browser.close(); }
    }
  } finally { await app.close(); }
  console.log(output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
