/* Minimal local playback, with no watch controller or per-frame diagnostics. */
'use strict';
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const {playbackBrowser}=require('./lib/playback-browser');
const {execute}=require('./build-playback-fixtures');
const {distribution}=require('./sync-report');
async function measure(seconds) {
  const video=document.querySelector('video');
  const frames=[],animation=[],costs=[];let previous,raf,rvfc,lastAnimation;
  const frame=(now,meta)=>{
    const start=performance.now();
    if(previous)frames.push({interval:meta.expectedDisplayTime-previous.expectedDisplayTime,mediaInterval:(meta.mediaTime-previous.mediaTime)*1000,
      gap:Math.max(0,meta.presentedFrames-previous.presentedFrames-1)});
    previous=meta;costs.push(performance.now()-start);rvfc=video.requestVideoFrameCallback(frame);
  };
  const draw=now=>{if(lastAnimation!==undefined)animation.push(now-lastAnimation);lastAnimation=now;raf=requestAnimationFrame(draw);};
  rvfc=video.requestVideoFrameCallback(frame);raf=requestAnimationFrame(draw);
  await video.play();await new Promise(resolve=>setTimeout(resolve,1000));
  frames.length=animation.length=costs.length=0;previous=undefined;lastAnimation=undefined;
  const before=video.getVideoPlaybackQuality(),start=performance.now();
  await new Promise(resolve=>setTimeout(resolve,seconds*1000));
  const after=video.getVideoPlaybackQuality(),elapsedMs=performance.now()-start;
  video.cancelVideoFrameCallback(rvfc);cancelAnimationFrame(raf);video.pause();
  return {elapsedMs,frames,animation,costs,totalFrames:after.totalVideoFrames-before.totalVideoFrames,dropped:after.droppedVideoFrames-before.droppedVideoFrames,
    visibility:document.visibilityState,focused:document.hasFocus(),width:video.videoWidth,height:video.videoHeight};
}
async function main() {
  const option=(key,fallback)=>process.argv.find(s=>s.startsWith('--'+key+'='))?.slice(key.length+3)??fallback;
  const output=path.resolve(option('output','artifacts/frame-probe-'+Date.now())),seconds=Number(option('seconds','8')),
    browsers=option('browsers','firefox,chrome').split(','),rates=option('fps','24,60000/1001').split(',');
  if(!Number.isFinite(seconds)||seconds<3||seconds>10||rates.some(s=>!/^\d+(?:\/\d+)?$/.test(s)))throw new Error('Invalid probe options');
  if(fs.existsSync(output))throw new Error('Use a new output directory');fs.mkdirSync(output,{recursive:true});
  const sources=new Map();
  for(const rate of rates){const file=path.join(output,rate.replace('/','-')+'.mp4');
    execute('ffmpeg',['-hide_banner','-loglevel','error','-nostdin','-n','-f','lavfi','-i','testsrc2=size=640x360:rate='+rate,
      '-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','20','-c:v','libx264','-preset','veryfast','-threads','2','-pix_fmt','yuv420p','-c:a','aac','-movflags','+faststart',file]);
    sources.set('/'+rate.replace('/','-')+'.mp4',fs.readFileSync(file));}
  const server=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://localhost'),bytes=sources.get(url.pathname);
    if(url.pathname==='/'){res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><title>Procedural frame callback probe</title><video controls width="640" height="360" src="'+(sources.has(url.searchParams.get('source'))?url.searchParams.get('source'):[...sources.keys()][0])+'"></video>');return;}
    if(!bytes){res.writeHead(404);res.end();return;}
    const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||''),start=match?Number(match[1]):0,end=match&&match[2]?Math.min(Number(match[2]),bytes.length-1):bytes.length-1;
    if(start>end||start>=bytes.length){res.writeHead(416);res.end();return;}
    res.writeHead(match?206:200,{'Content-Type':'video/mp4','Accept-Ranges':'bytes','Content-Length':end-start+1,...(match?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const results=[];
  try{for(const name of browsers){let browser;try{browser=await playbackBrowser(name);
    for(const rate of rates){const page=await browser.page('http://127.0.0.1:'+server.address().port+'/?source='+encodeURIComponent('/'+rate.replace('/','-')+'.mp4'));
      await browser.activate(page);
      const raw=JSON.parse(await browser.evaluate(page,'('+measure.toString()+')('+seconds+').then(JSON.stringify)'));
      const result={browser:name,version:browser.version,sourceFps:rate,visibility:raw.visibility,focused:raw.focused,elapsedMs:raw.elapsedMs,
        nativeTotalFrames:raw.totalFrames,nativeDropped:raw.dropped,callbackIntervals:distribution(raw.frames.map(r=>r.interval)),
        animationIntervals:distribution(raw.animation),callbackWorkMs:distribution(raw.costs),unobservedPresentedFrames:raw.frames.reduce((n,r)=>n+r.gap,0)};
      results.push(result);fs.writeFileSync(path.join(output,name+'-'+rate.replace('/','-')+'-raw.json'),JSON.stringify(raw));console.log(JSON.stringify(result));
    }
  }finally{await browser?.close();}}}finally{fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({results,limitations:'Headless software playback; callback coverage and animation cadence are not physical display timing.'},null,2));await new Promise(resolve=>server.close(resolve));}
}
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
