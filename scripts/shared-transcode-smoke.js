/* Three disposable viewers, synthetic Plex only; no .env or live providers. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');
async function main(){
  const option=(key,fallback)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
  const root=path.resolve(__dirname,'..'),directory=path.resolve(option('media','artifacts/playback-media-recovery-120')),
    output=path.resolve(option('output','artifacts/shared-transcode-'+Date.now())),name=option('browser','chrome');
  assert.ok(!fs.existsSync(output),'Use a fresh output directory');fs.mkdirSync(output,{recursive:true});
  const control={events:[],requests:[]},manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'))),upstream=fixturePlex(directory,manifest,control);
  const plexFetch=async(input,options)=>{
    const response=await upstream(input,options);
    if(new URL(input).pathname==='/library/metadata/104'){
      const body=await response.json();Object.assign(body.MediaContainer.Metadata[0].Media[0],{width:1920,height:1080});
      return new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});
    }
    return response;
  };
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only'};
  const app=createApp(config,{plexFetch,oauthFetch:async()=>{throw new Error('Live OAuth disabled');}}),plex=app.watch.plex;
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  app.hub.plexFor=async actor=>plex.scope('synthetic-playback-only',actor.userId);
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  const browsers=[],pages=[],report={browser:name,checks:{},limitations:'Synthetic HLS shared bytes across quality labels and desktop software decoding; does not certify live Plex encoder reuse, throughput, Android or the Plex HEVC subtitle issue.'};
  const starts=()=>control.events.filter(e=>e.event==='start').length;
  const media=async index=>{const id=await browsers[index].evaluate(pages[index],'viewerId');return app.watch.rooms.get(room).viewers.get(id).media;};
  let room;
  try{
    for(const persona of['host','guest','guest2']){
      const browser=await playbackBrowser(name);browsers.push(browser);const page=await browser.page(config.publicUrl+'/watch?demo='+persona);pages.push(page);
      await browser.until(page,'typeof me!=="undefined"&&!!me','Login');
    }
    report.versions=browsers.map(browser=>browser.version);
    await browsers[0].evaluate(pages[0],'preferredQuality="1080p20";document.getElementById("create").click();true');await browsers[0].until(pages[0],'!!state','Room');
    room=await browsers[0].evaluate(pages[0],'selected');
    for(const index of[1,2])await browsers[index].evaluate(pages[index],'preferredQuality='+JSON.stringify(index===1?'1080p20':'720p4')+';selectRoom('+JSON.stringify(room)+').then(()=>true)');
    await browsers[0].evaluate(pages[0],'execute({action:"media.load",args:{mediaId:"104",quality:"1080p20"}}).then(()=>true)');
    for(const index of[0,1,2])await browsers[index].until(pages[index],'!state.waitingForReady&&!video.paused&&videoFrames>5','Three-viewer playback',30000);
    const first=await Promise.all([0,1,2].map(media));
    assert.equal(starts(),2);assert.equal(first[0].transcodeId,first[1].transcodeId);assert.notEqual(first[0].transcodeId,first[2].transcodeId);
    assert.equal(new Set(first.map(m=>m.plexContext.principal)).size,3,'viewers retain separate Plex scopes');report.checks.threeViewersTwoConversions=true;
    await browsers[1].evaluate(pages[1],'execute({action:"media.tracks.set",args:{mediaVersion:state.mediaVersion,streamVersion:state.streamVersion,subtitleId:"10490"}}).then(()=>true)');
    assert.equal(starts(),2);assert.equal((await media(1)).selection.subtitle.id,'10490');assert.equal((await media(0)).selection.subtitle,undefined);report.checks.independentTextCaptions=true;
    const anchorReads=control.requests.filter(r=>r.file.endsWith('segment-000.ts')).length;
    await browsers[1].evaluate(pages[1],'execute({action:"media.quality.set",args:{quality:"720p4"}}).then(()=>true)');
    await browsers[1].until(pages[1],'!video.paused&&!video.seeking&&video.readyState>=3&&Math.abs(video.currentTime-expected())<.5','Join existing quality output',30000);
    assert.equal(starts(),2);assert.equal((await media(1)).transcodeId,first[2].transcodeId);assert.equal((await media(0)).transcodeId,first[0].transcodeId);
    assert.equal(control.requests.filter(r=>r.file.endsWith('segment-000.ts')).length,anchorReads,'reusing output serves cached segment zero');report.checks.qualityJoinsExistingOutput=true;
    await browsers[0].evaluate(pages[0],'document.getElementById("close-room").click();true');await browsers[0].until(pages[0],'!selected','Host leaves');
    assert.equal(plex.hlsPool.groups.size,1);report.checks.unusedOutputReleased=true;
    await browsers[1].until(pages[1],'state.isHost','Host transfer');
    await browsers[1].evaluate(pages[1],'execute({action:"session.visibility",args:{visibility:"private"}}).then(()=>true)');
    await browsers[2].until(pages[2],'!state','Private room removes another account');
    const before=await browsers[1].evaluate(pages[1],'videoFrames');await pause(1500);
    assert.ok(await browsers[1].evaluate(pages[1],'!video.paused&&videoFrames>'+Number(before+10)),'remaining viewer keeps decoded playback after its producer viewer leaves');
    assert.equal(starts(),2);assert.equal(plex.hlsPool.groups.size,1);report.checks.producerDepartureAndPrivacyPreservePlayback=true;
    app.watch.remove(room);assert.equal(plex.hlsPool.groups.size,0);assert.equal(plex.hlsPool.bytes,0);report.checks.finalReferenceCleanup=true;
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }finally{await Promise.allSettled(browsers.map(browser=>browser.close()));await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
