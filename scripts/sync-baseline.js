/* Real decoded browsers, disposable local accounts/media; never loads .env. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {createApp}=require('../server/app');
const {playbackBrowser,pause}=require('./lib/playback-browser');
const {execute}=require('./build-playback-fixtures');
const {compare}=require('./sync-report');
const root=path.resolve(__dirname,'..');
const option=(name,fallback)=>process.argv.find(s=>s.startsWith('--'+name+'='))?.slice(name.length+3)??fallback;
async function main() {
  const mode=option('controller','arrival'),name=option('browser','firefox'),fps=option('fps','24'),seconds=Number(option('seconds','15')),
    rtts=option('rtts','20,100,200,320').split(',').map(Number),output=path.resolve(option('output',path.join(root,'artifacts','sync-'+Date.now())));
  assert.ok(['arrival','shared'].includes(mode)&&/^(?:\d+|\d+\/\d+)$/.test(fps));
  assert.ok(seconds>=5&&seconds<=25&&rtts.every(n=>n>=0&&n<=1000));
  if(fs.existsSync(output))throw new Error('Use a new output directory.');fs.mkdirSync(output,{recursive:true});
  const media=path.join(output,'fixture.mp4');
  execute(option('ffmpeg','ffmpeg'),['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate='+fps,
    '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','60','-c:v','libx264','-preset','veryfast','-crf','24','-pix_fmt','yuv420p','-threads','2','-c:a','aac','-movflags','+faststart',media]);
  const config={cert:fs.readFileSync(path.join(root,'certs/server-cert.pem')),key:fs.readFileSync(path.join(root,'certs/server-key.pem')),
    publicUrl:'https://localhost',ownerId:'demo-host',guildId:'synthetic-guild',channels:['synthetic-channel'],demo:true};
  const app=createApp(config,{oauthFetch:async()=>{throw new Error('Live OAuth disabled');},plexFetch:async()=>{throw new Error('Live Plex disabled');}});
  app.watch.demoMedia={...app.watch.demoMedia,file:media,duration:60};
  app.hub.access={refresh:async()=>true,isMember:()=>true,voiceChannel:()=>'synthetic-call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));config.publicUrl='https://localhost:'+app.server.address().port;
  const report={controller:mode,browser:name,sourceFps:fps,steadySeconds:seconds,results:[],
    limitations:'Headless software decoding on one machine; symmetric delays added only to room-state fetches. No physical refresh, geographic WAN, packet loss, Tunnel, audio output, HLS or AV1 certification.'};
  try {
    for(const rtt of rtts) {
      let host,guest;
      try {
        host=await playbackBrowser(name);guest=await playbackBrowser(name);
        const h=await host.page(config.publicUrl+'/watch?demo=host'),g=await guest.page(config.publicUrl+'/watch?demo=guest');
        const setup=async(browser,page,delay)=>{
          await browser.until(page,'typeof me!=="undefined" && !!me','Fixture login');
          await browser.evaluate(page,`(()=>{
            const originalFetch=fetch;
            globalThis.fetch=async function(url,options){
              if(!/^\\/api\\/watch\\/rooms\\/[^/?]+\\?/.test(String(url)))return originalFetch(url,options);
              const delay=${delay}/2;await new Promise(r=>setTimeout(r,delay));
              const response=await originalFetch(url,options);await new Promise(r=>setTimeout(r,delay));return response;
            };
            ${mode==='arrival'?'expected=arrivalExpected;':''}
            return true;
          })()`);
        };
        await setup(host,h,20);await setup(guest,g,rtt);
        await host.evaluate(h,'document.getElementById("create").click();true');await host.until(h,'!!state','Fixture room');
        const room=await host.evaluate(h,'selected');
        await guest.evaluate(g,'selectRoom('+JSON.stringify(room)+').then(()=>true)');
        await guest.until(g,'!!state','Guest room');
        await host.evaluate(h,'execute({action:"media.load",args:{mediaId:"demo",quality:"direct"}}).then(()=>true)');
        await Promise.all([host.until(h,'!video.paused && videoFrames>24 && !state.waitingForReady','Host decoded playback'),guest.until(g,'!video.paused && videoFrames>24','Guest decoded playback')]);
        await pause(4000);
        // Use the diagnostic ring's own elapsed-time coordinate for trimming.
        const boundaries=await Promise.all([host.evaluate(h,'diagnosticSample();diagnostics.snapshot().entries.at(-1).ms'),guest.evaluate(g,'diagnosticSample();diagnostics.snapshot().entries.at(-1).ms')]);
        await pause(seconds*1000);
        const capture=async(browser,page,boundary)=>JSON.parse(await browser.evaluate(page,'JSON.stringify((()=>{diagnosticSample();const log=diagnostics.snapshot();log.entries=log.entries.filter(r=>r.ms>='+boundary+');return log;})())'));
        const logs=await Promise.all([capture(host,h,boundaries[0]),capture(guest,g,boundaries[1])]);
        for(let i=0;i<2;i++)fs.writeFileSync(path.join(output,rtt+'-steady-'+(i?'guest':'host')+'.json'),JSON.stringify(logs[i])+'\n');
        const steady=compare(...logs,{sameTimeline:true});
        const status=steady.healthySkewMs.count>100&&steady.healthyCoverageFraction>=.8?'measured':'insufficient-presentation-coverage';
        assert.equal(await host.evaluate(h,'state.enabled'),false);
        const before=await host.evaluate(h,'video.currentTime');
        await guest.evaluate(g,'probing=true;video.pause();playerWaiting=true;true');await pause(3000);
        assert.ok(await host.evaluate(h,'video.currentTime')>before+2,'Guest recovery must not stop healthy playback');
        assert.equal(app.watch.rooms.get(room).s.state.paused,false);
        await guest.evaluate(g,'probing=false;playerWaiting=false;sync.synchronize().then(()=>true)');
        await guest.until(g,'!video.paused && !video.seeking','Guest catch-up');await pause(3000);
        const recovery=await Promise.all([capture(host,h,boundaries[0]),capture(guest,g,boundaries[1])]);
        for(let i=0;i<2;i++){fs.writeFileSync(path.join(output,rtt+'-'+(i?'guest':'host')+'.json'),JSON.stringify(recovery[i])+'\n');}
        report.results.push({status,guestControlDelayMs:rtt,versions:[host.version,guest.version],steady,recovery:compare(...recovery,{sameTimeline:true}),independentRecovery:true});
        console.log(JSON.stringify({controller:mode,rtt,status,coverage:steady.healthyCoverageFraction,skew:steady.healthySkewMs,intervals:steady.viewers.map(v=>v.frameIntervalMs),uncertainty:steady.combinedClockUncertaintyMs}));
        app.watch.remove(room);
      }finally{await Promise.allSettled([host?.close(),guest?.close()]);}
    }
  }finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify(report,null,2)+'\n');await app.close();}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
