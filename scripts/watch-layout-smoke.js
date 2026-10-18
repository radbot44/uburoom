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
    if (new URL(input).pathname==='/library/sections/1/all') return new Response(JSON.stringify({MediaContainer:{totalSize:4,
      Metadata:Array.from({length:4},(_,i)=>({ratingKey:String(i+1),type:'movie',title:'Layout fixture '+(i+1),year:2026,duration:60000}))}}),{headers:{'Content-Type':'application/json'}});
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
        for (const [label,width,height,wide] of [['normal',1440,1000,false],['theater',1440,1000,true],['phone',390,844,false],['phone-theater',390,844,true]]) {
          await browser.viewport(page,width,height);
          await evaluate('setTheater('+wide+');window.scrollTo(0,0);true'); await pause(200);
          await browser.screenshot(page,path.join(output,name+'-'+label+'.png'));
          const r = await measure();
          if (!before) {
            assert.equal(r.overflow,false,name+' '+label+' horizontal overflow');
            assert.ok(r.room.y>=r.stage.bottom && r.options.y>=r.room.bottom,'Room and options below video');
            if (label==='normal') assert.ok(r.library.x>=r.stage.right,'Normal library beside video');
            else assert.ok(r.library.y>=r.stage.bottom,'Stacked library');
            assert.equal(await evaluate('drawer.hidden&&document.getElementById("drawer-open").hidden'),true);
            if (label==='normal') normalWidth=r.stage.width;
            if (label==='theater') assert.ok(r.stage.width>normalWidth,'Theater enlarges video');
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
