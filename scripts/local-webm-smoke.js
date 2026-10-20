/* Actual software WebM conversion and watch clients; only synthetic providers/media. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {fixturePlex}=require('./playback-baseline');
const {playbackBrowser,pause}=require('./lib/playback-browser');
const {findOnPath}=require('../server/media-tools');
async function main(){
  const option=(key,fallback)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3)||fallback;
  const name=option('browser','chrome'),codec=option('codec','vp9'),failFirst=process.argv.includes('--fail-first');
  if(failFirst&&codec!=='vp8')throw new Error('Use --codec=vp8 for the injected VP9 failure check');
  if(!['vp8','vp9'].includes(codec))throw new Error('Choose vp8 or vp9');
  const output=path.resolve(option('out','artifacts/local-webm-'+name+'-'+codec+'-'+Date.now()));fs.mkdirSync(output,{recursive:false});
  const directory=path.resolve(option('media','artifacts/playback-media-initial')),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json'),'utf8'));
  const config={cert:fs.readFileSync('certs/server-cert.pem'),key:fs.readFileSync('certs/server-key.pem'),publicUrl:'https://localhost',ownerId:'demo-host',guildId:'fixture',channels:['fixture'],demo:true,
    plexUrl:'http://playback-fixture.invalid:32400',plexToken:'synthetic-playback-only',ffmpegPath:findOnPath('ffmpeg'),ffprobePath:findOnPath('ffprobe'),
    transcoding:{policy:'override',plex:false,uburoom:true,encoder:'software',cpuFallback:true,formats:failFirst?['vp9','vp8']:[codec],maxJobs:5}};
  const app=createApp(config,{plexFetch:fixturePlex(directory,manifest,{requests:[]})}),browsers=[],pages=[];let room;
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  const manager=app.watch.plex.av1,run=manager.run;let chunks=0;
  manager.run=(binary,args,...rest)=>{if(failFirst&&args.includes('libvpx-vp9'))return Promise.reject(new (require('../server/av1').PlaybackError)('Injected unavailable VP9 encoder'));if(args.includes('-ss'))chunks++;return run(binary,args,...rest);};
  const media=index=>app.watch.rooms.get(room)?.viewers.get(viewers[index])?.media,viewers=[];
  try{
    await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
    for(const persona of ['host','guest']){const browser=await playbackBrowser(name);browsers.push(browser);const page=await browser.page(config.publicUrl+'/watch?demo='+persona);pages.push(page);await browser.until(page,'typeof transport!=="undefined"&&transport?.ready','Login');await browser.viewport(page,1200,850);}
    await browsers[0].evaluate(pages[0],'createRoom().then(()=>true)');await browsers[0].until(pages[0],'!!state','Room');room=await browsers[0].evaluate(pages[0],'selected');
    await browsers[1].evaluate(pages[1],'selectRoom('+JSON.stringify(room)+').then(()=>true)');
    await browsers[0].evaluate(pages[0],'execute({action:"media.load",args:{mediaId:"101",quality:"direct"}}).then(()=>true)');
    for(const index of [0,1]){
      await browsers[index].until(pages[index],'state?.mediaId==="101"','Shared source');
      viewers[index]=await browsers[index].evaluate(pages[index],'viewerId');
      // Exercise configured automatic selection rather than exposing a codec menu.
      await browsers[index].evaluate(pages[index],'compatibleFallback("Synthetic compatibility check").then(()=>true)');
      await browsers[index].until(pages[index],'state?.format==='+JSON.stringify(codec)+' && videoFrames>2','Configured codec decodes',30000);
    }
    assert.equal(media(0).av1Lease.group,media(1).av1Lease.group);assert.equal(media(0).audioCodec,'opus');
    const group=media(0).av1Lease.group;assert.equal(group.refs,2);assert.ok(chunks<=3,'matching viewers reuse the three source chunks');
    const returned=JSON.parse(await browsers[0].evaluate(pages[0],'fetch(state.mediaUrl).then(r=>r.json()).then(JSON.stringify)'));assert.equal(returned.format,codec);assert.ok(returned.mime.includes(codec));
    await browsers[0].evaluate(pages[0],'execute({action:"media.pause"}).then(()=>execute({action:"media.seek.absolute",args:{seconds:12}})).then(()=>true)');
    for(const index of [0,1])await browsers[index].until(pages[index],'video.paused&&!video.seeking&&Math.abs(video.currentTime-12)<.7','Shared paused seek',15000);
    await browsers[0].evaluate(pages[0],'execute({action:"media.seek.absolute",args:{seconds:1}}).then(()=>true)');
    for(const index of [0,1])await browsers[index].until(pages[index],'!video.seeking&&Math.abs(video.currentTime-1)<.7','Cached rewind');
    const before=chunks;await pause(300);assert.equal(chunks,before,'cached rewind does not start new work');
    await browsers[0].screenshot(pages[0],path.join(output,'player.png'));
    await browsers[0].evaluate(pages[0],'renderMediaInformation(state);document.getElementById("tracks-dialog").showModal();true');await browsers[0].screenshot(pages[0],path.join(output,'settings.png'));
    await browsers[0].close();await browsers[1].until(pages[1],'state?.isHost','Remaining viewer');
    await browsers[1].evaluate(pages[1],'execute({action:"media.play"}).then(()=>true)');await browsers[1].until(pages[1],'!video.paused&&video.currentTime>2&&state.format==='+JSON.stringify(codec),'Playback survives producer departure');
    app.watch.remove(room);assert.equal(manager.groups.size,0);assert.equal(app.watch.plex.conversionPolicy.jobs.size,0);
    const report={passed:true,browser:name,version:browsers[1].version,codec,failFirst,chunks,checks:['configured automatic codec selection','authorized codec-specific manifest','shared chunk output','exact Opus delivery','paused seek','cached rewind','producer departure','final reference cleanup'],limits:'Synthetic providers and software encoding; no real PMS/Discord, physical audio or hardware support claim.'};
    fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
  }catch(error){for(let i=0;i<browsers.length;i++)console.error(await browsers[i].evaluate(pages[i],'JSON.stringify({format:state?.format,error:playbackError,frames:videoFrames,position:video.currentTime,paused:video.paused})').catch(()=>''));throw error;}
  finally{await Promise.allSettled(browsers.map(browser=>browser.close()));await app.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
