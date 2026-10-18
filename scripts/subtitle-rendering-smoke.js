'use strict';
// Actual watch UI, local synthetic Plex and procedural subtitles. Never .env.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {createApp}=require('../server/app'),{fixturePlex}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser'),fixtures=require('./lib/subtitle-fixtures');
async function main(){
  const option=(name,fallback)=>process.argv.find(arg=>arg.startsWith('--'+name+'='))?.slice(name.length+3) || fallback;
  const root=path.resolve(__dirname,'..'),directory=path.resolve(option('media','artifacts/playback-media-tracks')),
    output=path.resolve(option('out','artifacts/subtitle-rendering-'+Date.now())),name=option('browser','firefox'),repeats=Number(option('repeats','1'));
  assert.ok(Number.isInteger(repeats)&&repeats>=1&&repeats<=5,'Use --repeats=1..5');
  assert.ok(!fs.existsSync(output),'Use a fresh output directory');fs.mkdirSync(output,{recursive:true});
  const manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),upstream=fixturePlex(directory,manifest),vob=fixtures.vobsub();
  fs.writeFileSync(path.join(output,'track.ass'),fixtures.ass());fs.writeFileSync(path.join(output,'track.sup'),fixtures.pgs());
  fs.writeFileSync(path.join(output,'track.idx'),vob.index);fs.writeFileSync(path.join(output,'track.sub'),vob.data);
  const embeddedFile=path.join(output,'embedded.mkv');
  const mux=spawnSync('ffmpeg',['-v','error','-nostdin','-i',path.join(directory,manifest.sources.find(s=>s.id==='101').file),
    '-i',path.join(output,'track.ass'),'-i',path.join(output,'track.sup'),'-i',path.join(output,'track.idx'),'-map','0:v:0','-map','0:a:0','-map','1:0','-map','2:0','-map','3:0','-c','copy',
    '-attach',path.join(root,'web/vendor/subtitles/default.woff2'),'-metadata:s:t','mimetype=font/woff2','-metadata:s:t','filename=fixture.woff2',embeddedFile],{windowsHide:true});
  assert.equal(mux.status,0,mux.stderr?.toString());const embeddedBytes=fs.readFileSync(embeddedFile);
  const data={'/library/streams/901.ass':fixtures.ass(),'/library/streams/902.sup':fixtures.pgs(),'/library/streams/903.sub':vob.data,'/library/streams/903.idx':vob.index};
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',demo:true,ownerId:'demo-host',guildId:'fixture',channels:['fixture'],plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only',ffmpegPath:'ffmpeg',ffprobePath:'ffprobe'};
  const app=createApp(config,{plexFetch:async(input,options)=>{
    const url=new URL(input);if(data[url.pathname])return new Response(data[url.pathname]);
    if(url.pathname==='/library/parts/101/file'){
      const match=/^bytes=(\d+)-(\d*)$/.exec(options.headers?.Range || ''),start=match?Number(match[1]):0,end=match?.[2]?Math.min(embeddedBytes.length-1,Number(match[2])):embeddedBytes.length-1;
      if(start>end)return new Response(null,{status:416});
      return new Response(options.method==='HEAD'?null:embeddedBytes.subarray(start,end+1),{status:match?206:200,headers:{'Content-Type':'video/x-matroska','Accept-Ranges':'bytes','Content-Length':String(end-start+1),...(match?{'Content-Range':`bytes ${start}-${end}/${embeddedBytes.length}`}:{})}});
    }
    const response=await upstream(input,options);
    if(url.pathname==='/library/metadata/101'){
      const body=await response.json();body.MediaContainer.Metadata[0].Media[0].Part[0].Stream.push(...[['901','ass'],['902','pgs'],['903','vobsub']].map(([id,codec])=>({id,streamType:3,codec,key:'/library/streams/'+id,label:codec})));
      body.MediaContainer.Metadata[0].Media[0].Part[0].Stream.push({id:'904',index:2,streamType:3,codec:'ass'},{id:'905',index:3,streamType:3,codec:'pgs'});
      body.MediaContainer.Metadata[0].Media[0].Part[0].Stream.push({id:'906',index:4,streamType:3,codec:'vobsub'});
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }return response;
  },oauthFetch:async()=>{throw new Error('Live OAuth disabled');}});
  app.hub.access={refresh:async()=>true,isMember:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  let browser;const report={browser:name,repeats,cases:[],limitations:'Procedural local sources; does not certify real Plex extraction/fonts, complex authored subtitles, hardware or Discord Activity.'};
  try{
    browser=await playbackBrowser(name);report.version=browser.version;const page=await browser.page(config.publicUrl+'/watch?demo=host');await browser.viewport(page,1280,1000);
    await browser.until(page,'typeof me!=="undefined"&&!!me','Login');await browser.evaluate(page,'preferredQuality="720p4";document.getElementById("create").click();true');
    await browser.until(page,'!!state','Room');await browser.evaluate(page,'execute({action:"media.load",args:{mediaId:"101",quality:"720p4"}}).then(()=>true)');
    await browser.until(page,'!state.waitingForReady&&!video.paused&&videoFrames>3','Playback');
    await browser.evaluate(page,'execute({action:"media.pause"}).then(()=>true)');
    async function command(action,args){return browser.evaluate(page,'execute({action:'+JSON.stringify(action)+',args:'+JSON.stringify(args)+'}).then(()=>true)');}
    await command('media.seek.absolute',{seconds:2});await browser.until(page,'!video.seeking&&Math.abs(video.currentTime-2)<.15','Reference frame');await pause(700);
    const reference=path.join(output,'off.png');await browser.screenshot(page,reference);
    const off=spawnSync('ffmpeg',['-v','error','-i',reference,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:10*1024*1024});assert.equal(off.status,0);
    await browser.evaluate(page,'window.subtitleProbeSeeks=0;video.addEventListener("seeked",()=>window.subtitleProbeSeeks++);true');
    const overlayPixels=(frame,bounds)=>{
      const decoded=spawnSync('ffmpeg',['-v','error','-i',frame,'-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{windowsHide:true,maxBuffer:10*1024*1024});
      assert.equal(decoded.status,0);let white=0,backgroundDelta=0,backgroundSamples=0;
      // A subtitle can be visible while an opaque canvas hides the video.
      // Check the fixture's subtitle-free middle area against the Off frame.
      for(let y=Math.ceil(bounds.y+bounds.height*.4);y<Math.min(1000,bounds.y+bounds.height*.6);y++)
        for(let x=Math.ceil(bounds.x+bounds.width*.2);x<Math.min(1280,bounds.x+bounds.width*.4);x++){
          const at=(y*1280+x)*3;
          for(let c=0;c<3;c++){backgroundDelta+=Math.abs(decoded.stdout[at+c]-off.stdout[at+c]);backgroundSamples++;}
        }
      assert.ok(backgroundSamples>0&&backgroundDelta/backgroundSamples<3,'Video remains visible behind the subtitle canvas');
      const y0=Math.max(0,Math.floor(bounds.y+bounds.height*.73)),y1=Math.min(1000,Math.floor(bounds.y+bounds.height*.96));
      for(let y=y0;y<y1;y++)for(let x=Math.max(0,Math.floor(bounds.x+bounds.width*.3));x<Math.min(1280,Math.floor(bounds.x+bounds.width*.7));x++){
        const at=(y*1280+x)*3,color=[...decoded.stdout.subarray(at,at+3)],delta=color.reduce((sum,v,c)=>sum+Math.abs(v-off.stdout[at+c]),0);
        if(Math.min(...color)>125&&Math.max(...color)-Math.min(...color)<30&&delta>100)white++;
      }return white;
    };
    for(let cycle=0;cycle<repeats;cycle++){
    for(const [id,format]of[['901','ass'],['902','pgs'],['903','vobsub'],['904','ass'],['905','pgs'],['906','vobsub']]){
      const versions=JSON.parse(await browser.evaluate(page,'JSON.stringify({mediaVersion:state.mediaVersion,streamVersion:state.streamVersion})'));
      await command('media.tracks.set',{...versions,subtitleId:id});
      try{await browser.until(page,'captions.loaded&&!!captions.renderer','Subtitle '+format,30000);}
      catch(error){console.error(await browser.evaluate(page,'JSON.stringify({notice:trackNotice,state:state.tracks,loaded:captions.loaded})'));throw error;}
      // Loading a track while paused at the same position must paint without
      // issuing another seek (a real seek could conceal a startup repaint race).
      assert.equal(await browser.evaluate(page,'video.paused&&!video.seeking&&Math.abs(video.currentTime-2)<.15&&window.subtitleProbeSeeks===0'),true);await pause(700);
      const frame=path.join(output,format+'-'+id+'-'+cycle+'.png');await browser.screenshot(page,frame);
      // Decoded screenshot pixels establish an actual overlay, independent of renderer ready events.
      const bounds=JSON.parse(await browser.evaluate(page,'JSON.stringify(document.querySelector(".subtitle-canvas").getBoundingClientRect().toJSON())'));
      const white=overlayPixels(frame,bounds);
      if(white<=50)console.error(await browser.evaluate(page,'JSON.stringify({notice:trackNotice,bounds:document.querySelector(".subtitle-canvas").getBoundingClientRect().toJSON(),time:video.currentTime,loaded:captions.loaded})'));
      assert.ok(white>50,'Visible '+format+' subtitle pixels');report.cases.push({format,cycle,embedded:Number(id)>=904,whitePixels:white,delivery:JSON.parse(await browser.evaluate(page,'JSON.stringify(state.tracks.subtitleDelivery)'))});
      if(Number(id)<904&&cycle===0){
        for(const [offset,visible]of[[.1,true],[3,false],[0,true]]){
          await command('media.tracks.set',{...versions,subtitleOffset:offset});await pause(350);
          const delayed=path.join(output,format+'-offset-'+offset+'.png');await browser.screenshot(page,delayed);
          const count=overlayPixels(delayed,bounds);assert.ok(visible?count>50:count<50,format+' paused delay '+offset+' changes presentation');
          assert.equal(await browser.evaluate(page,'video.paused&&window.subtitleProbeSeeks===0'),true);
        }
      }
      if(id==='904'){
        const selected=JSON.parse(await browser.evaluate(page,'JSON.stringify({room:selected,viewer:viewerId})'));
        assert.ok(app.watch.rooms.get(selected.room).viewers.get(selected.viewer).media.subtitleAssets.has('font-0'),'ASS attachment extracted and delivered');report.embeddedFont=true;
      }
      const version=JSON.parse(await browser.evaluate(page,'JSON.stringify({mediaVersion:state.mediaVersion,streamVersion:state.streamVersion})'));
      await command('media.tracks.set',{...version,subtitleId:'off'});await browser.until(page,'!document.querySelector(".subtitle-layer")','Overlay cleanup');
    }
    }
    report.pausedStartupWithoutSeek=true;report.pausedDelay=true;report.videoVisibleBehindOverlay=true;
    const versions=JSON.parse(await browser.evaluate(page,'JSON.stringify({mediaVersion:state.mediaVersion,streamVersion:state.streamVersion})'));
    await command('media.tracks.set',{...versions,subtitleId:'902'});await browser.until(page,'captions.loaded&&!!captions.renderer','Layout overlay');
    await command('zoom.set',{value:1.1});await command('stretch.set',{axis:'stretchX',value:1.15});await command('pan.set',{x:.03,y:-.02});
    const geometry=JSON.parse(await browser.evaluate(page,'JSON.stringify({video:video.getBoundingClientRect().toJSON(),canvas:document.querySelector(".subtitle-canvas").getBoundingClientRect().toJSON()})'));
    for(const key of ['x','y','width','height'])assert.ok(Math.abs(geometry.video[key]-geometry.canvas[key])<3,'Picture and overlay transform '+key);
    await browser.screenshot(page,path.join(output,'transformed.png'));report.pictureTransform=true;
    await command('reset.all');await browser.evaluate(page,'setTheater(true);true');await pause(300);await browser.screenshot(page,path.join(output,'theater.png'));
    await browser.viewport(page,390,844);await pause(500);await browser.screenshot(page,path.join(output,'phone.png'));
    await browser.evaluate(page,'document.body.classList.add("activity-pip");true');await pause(250);
    assert.equal(await browser.evaluate(page,'getComputedStyle(document.querySelector(".subtitle-layer")).display!=="none"'),true,'Activity PIP layout retains subtitles');
    await browser.screenshot(page,path.join(output,'activity-pip-layout.png'));report.activityPipLayout=true;
    await browser.evaluate(page,'document.body.classList.remove("activity-pip");setTheater(false);true');await browser.viewport(page,1280,1000);await pause(300);
    await browser.evaluate(page,'document.getElementById("tracks-open").click();if(!document.getElementById("tracks-dialog").open)document.getElementById("settings-more").click();true');await browser.screenshot(page,path.join(output,'tracks-dialog.png'));
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({output,...report}));
  }finally{await browser?.close();await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
