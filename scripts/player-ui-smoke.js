/* Real browser pointer input and decoded media against isolated synthetic Plex. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main() {
  const media=path.resolve('artifacts/playback-media-tracks'),manifest=JSON.parse(fs.readFileSync(path.join(media,'manifest.json')));
  const output=path.resolve('artifacts/player-ui-'+Date.now());fs.mkdirSync(output,{recursive:true});
  for(const name of ['chrome','firefox']) {
    const upstream=fixturePlex(media,manifest),commands=[];
    const plexFetch=async(input,options)=>{
      const response=await upstream(input,options),url=new URL(input);
      if(!/^\/library\/metadata\/\d+$/.test(url.pathname))return response;
      const data=await response.json();
      for(const item of data.MediaContainer.Metadata)for(const media of item.Media) {
        media.width=1920;media.height=1080;
        for(const part of media.Part) {
          if(url.pathname.endsWith('/103'))part.Stream=part.Stream.filter(s=>s.streamType!==3);
          for(const stream of part.Stream)if(String(stream.id)==='10190')stream.default=1;
        }
      }
      return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
    };
    const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'fixture',channels:['fixture'],plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
    const app=createApp(config,{plexFetch});
    app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'fixture',validVoiceChannel:()=>true,options:()=>({available:true})};
    const execute=app.watch.execute.bind(app.watch);
    app.watch.execute=async(...args)=>{const result=await execute(...args);commands.push(args[1]);return result;};
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    let browser,page;
    try {
      browser=await playbackBrowser(name);page=await browser.page(config.publicUrl+'/watch?demo=host');
      const evaluate=code=>browser.evaluate(page,code),until=(code,label)=>browser.until(page,code,label),shot=label=>browser.screenshot(page,path.join(output,name+'-'+label+'.png'));
      await browser.viewport(page,1440,1000);await until('typeof me!=="undefined"&&!!me','Login');
      await evaluate('preferredQuality="direct";document.getElementById("create").click();document.getElementById("room-create").click();true');await until('!!state','Room');
      await evaluate('execute({action:"media.load",args:{mediaId:"101",quality:"direct"}}).then(()=>true)');
      await until('!video.paused&&videoFrames>5','Decoded playback');
      const bounds=async id=>JSON.parse(await evaluate('JSON.stringify((()=>{const r=document.getElementById('+JSON.stringify(id)+').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};})())'));
      let stage=await bounds('stage');await browser.move(page,Math.round(stage.x+stage.width/2),Math.round(stage.y+stage.height/2));await pause(220);
      assert.equal(await evaluate('getComputedStyle(document.getElementById("join-playback")).opacity'),'1','Hover shows center Pause');
      assert.equal(await evaluate('document.getElementById("join-playback").getAttribute("aria-label")'),'Pause');
      await browser.move(page,0,0);await pause(220);assert.equal(await evaluate('getComputedStyle(document.getElementById("join-playback")).opacity'),'0','Center hides outside player');
      await evaluate('execute({action:"media.pause"}).then(()=>true)');await until('video.paused&&state.state.paused','Paused');
      await evaluate('globalThis.playerUITestErrors=[];window.addEventListener("error",e=>playerUITestErrors.push(e.message));true');
      await browser.click(page,'tracks-open');await pause(100);
      assert.equal(await evaluate('document.getElementById("player-settings-menu").matches(":popover-open")'),true,'Desktop drop-up: '+await evaluate('JSON.stringify(playerUITestErrors)'));
      assert.equal(await evaluate('[...document.querySelectorAll("#player-settings-menu>button")].map(b=>b.childNodes[0].textContent).join("|")'),'Quality|Audio track|Subtitle track|More settings');
      await browser.click(page,'settings-subtitle-track');await shot('subtitle-menu');
      assert.equal(await evaluate('(()=>{const a=document.querySelector(".settings-submenu").getBoundingClientRect(),b=document.getElementById("player-settings-menu").getBoundingClientRect();return a.width>0&&b.width>0&&a.right<=b.left&&a.left>=0;})()'),true,'Submenu opens to the left');
      await browser.click(page,'settings-more');await until('document.getElementById("tracks-dialog").open','Full settings');
      assert.equal(await evaluate('document.getElementById("sync-correction").closest("dialog").id'),'tracks-dialog');await shot('full-settings');
      await browser.click(page,'tracks-close');await browser.click(page,'captions-toggle');await until('state.tracks.subtitleId==="10190"&&captions.loaded','Default CC track');
      assert.equal(await evaluate('document.getElementById("captions-toggle").getAttribute("aria-pressed")'),'true');
      await browser.click(page,'captions-toggle');await until('!state.tracks.subtitleId','CC off');
      await browser.click(page,'captions-toggle');await until('state.tracks.subtitleId==="10190"','CC restored');
      await browser.click(page,'tracks-open');await browser.click(page,'settings-quality');
      await evaluate('document.querySelector(".settings-submenu [data-value=\\\"1080p8\\\"]").click();true');
      await until('!qualityPending&&state.quality==="1080p8"&&video.readyState>=2','Quality selection through submenu');
      assert.equal(await evaluate('document.getElementById("quality-badge").textContent'),'HD');
      await evaluate('playerUI.closeSettings();true');
      for(const width of [320,390,700]) {
        await browser.viewport(page,width,1000);await evaluate('window.scrollTo(0,0);true');await pause(200);
        stage=await bounds('stage');assert.ok(Math.abs(stage.width-await evaluate('document.documentElement.clientWidth'))<2,'Edge-to-edge mobile');
        const row=await bounds('player-play'),time=await bounds('time');assert.ok(time.bottom<=row.y+2,'Progress row precedes buttons');
        const ids=['player-play','previous','next','captions-toggle','tracks-open','player-mute','player-volume','fullscreen'];
        let last=-1;for(const id of ids){const r=await bounds(id);assert.ok(Math.abs(r.y+r.height/2-row.y-row.height/2)<2,id+' stays in second row');assert.ok(r.x>=last&&r.right<=stage.right+1,id+' fits in order');last=r.right;}
        const mute=await bounds('player-mute'),volume=await bounds('player-volume');assert.ok(volume.x-mute.right<=3,'Mute and slider remain adjacent');
        await browser.click(page,'tracks-open');await until('document.getElementById("tracks-dialog").open','Mobile opens full dialog');await shot('mobile-settings-'+width);await browser.click(page,'tracks-close');
        await shot('mobile-'+width);
      }
      await browser.viewport(page,900,1400);await evaluate('setTheater(true);true');await pause(220);stage=await bounds('stage');assert.ok(stage.height<=stage.width,'Portrait theater stays landscape');await shot('portrait-theater');
      await browser.viewport(page,390,1000);await evaluate('window.scrollTo(0,0);true');await pause(220);assert.equal(await evaluate('theater'),false,'Resize exits unavailable theater');
      stage=await bounds('stage');const x=Math.round(stage.x+stage.width*.88),y=Math.round(stage.y+stage.height*.45);
      await browser.tap(page,x,y);await until('document.getElementById("stage").classList.contains("controls-visible")','Touch reveals controls');
      await pause(2900);assert.equal(await evaluate('getComputedStyle(document.querySelector(".transport")).opacity'),'0','Touch controls auto-hide');
      await browser.tap(page,x,y);
      const volume=await bounds('player-volume');await browser.tap(page,Math.round(volume.x+volume.width*.75),Math.round(volume.y+volume.height/2));
      await pause(2900);assert.equal(await evaluate('getComputedStyle(document.querySelector(".transport")).opacity'),'0','Focused volume slider does not pin touch controls');
      for(const [count,side] of [[2,1],[3,-1],[4,1]]) {
        const before=commands.length;
        for(let n=0;n<count;n++){await browser.tap(page,side>0?x:Math.round(stage.x+stage.width*.12),y);await pause(70);}
        await pause(600);
        assert.deepEqual(commands.slice(before).filter(c=>c.action==='media.seek.relative').map(c=>c.args.seconds),[side*15*(count-1)],'Repeated tap seek progression');
      }
      await evaluate('execute({action:"media.load",args:{mediaId:"103",quality:"direct"}}).then(()=>true)');await until('video.readyState>=2&&state.mediaId==="103"','No-subtitle media');
      assert.equal(await evaluate('document.getElementById("captions-toggle").disabled'),true,'Unavailable CC is disabled');
      await browser.click(page,'tracks-open');await shot('mobile-no-subtitles');await browser.click(page,'tracks-close');
      await evaluate('playerUI.showChrome();true');await browser.click(page,'fullscreen');await until('!!document.fullscreenElement','Mobile fullscreen');
      await browser.click(page,'tracks-open');await until('document.getElementById("tracks-dialog").open','Mobile fullscreen still uses dialog');await shot('mobile-fullscreen-settings');
      assert.deepEqual(await evaluate('playerUITestErrors'),[],'No unhandled player UI errors');
      console.log(name+' '+browser.version+': PASS');
    } catch(error) {
      if(browser&&page){console.error(await browser.evaluate(page,'JSON.stringify({error:document.getElementById("error").textContent,menu:document.getElementById("player-settings-menu").matches(":popover-open"),dialog:document.getElementById("tracks-dialog").open,paused:state?.state.paused,pending,classes:document.getElementById("stage").className,focus:document.activeElement.id,errors:playerUITestErrors})').catch(()=>''));await browser.screenshot(page,path.join(output,name+'-failed.png'));}throw error;
    } finally {await browser?.close();await app.close();}
  }
  console.log(output);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
