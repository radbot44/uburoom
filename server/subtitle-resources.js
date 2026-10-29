'use strict';
// Original subtitle assets only. Rendering stays in the browser; extraction never
// re-encodes video or receives a Plex credential in process arguments.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PlaybackError}=require('./av1');
const Sources=require('./plex-source');
const LIMIT=64*1024*1024,FONTS=16*1024*1024,TOTAL=96*1024*1024;
const cache=new Map(),windows=new Map();let bytes=0,active=0;
function classifyExtractionError(error){
  if(/timed out/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction timed out. Try Plex burn-in.');
  if(/exceeded the.*limit|exceed/i.test(error?.message || ''))return new PlaybackError('Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');
  if(/no usable data/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction produced no usable data. Try Plex burn-in.');
  if(/failed/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction failed during media demuxing. Try Plex burn-in.');
  if(error instanceof PlaybackError)return error;
  return new PlaybackError('Original subtitles could not be extracted. Try Plex burn-in.');
}
function dropWindow(entry){bytes-=entry.data.length;windows.delete(entry);entry.media.windowCache?.delete(entry.key);}
function reserve(size){
  while(bytes+size>TOTAL){
    if(windows.size)dropWindow(windows.keys().next().value);
    else clearCached(cache.keys().next().value);
  }
}
function clearCached(media){
  const old=cache.get(media);if(old){bytes-=old.size;cache.delete(media);}media.subtitleAssets=undefined;
  for(const entry of media.windowCache?.values() || [])dropWindow(entry);
  media.windowCache?.clear();
}
function clear(media){
  clearCached(media);
  for(const job of media.windowJobs?.values() || [])job.controller.abort();
}
function transfer(from,to){
  if(!from || !to || from===to || !from.sourceKey || from.sourceKey!==to.sourceKey || from.principal!==to.principal)return false;
  const a=from.selection?.subtitle,b=to.selection?.subtitle;
  if(!a?.available || !b?.available || a.delivery==='burn' || a.delivery!==b.delivery || a.id!==b.id)return false;
  if(from.subtitleCache){to.subtitleCache=from.subtitleCache;from.subtitleCache=undefined;}
  if(from.windowCache){to.windowCache=from.windowCache;from.windowCache=undefined;for(const entry of to.windowCache.values())entry.media=to;}
  if(from.windowJobs){to.windowJobs=from.windowJobs;from.windowJobs=undefined;for(const job of to.windowJobs.values())job.media=to;}
  to.captionVersion=from.captionVersion;
  to.subtitleAbort?.abort();
  to.subtitleAbort=from.subtitleAbort;
  to.subtitleAssets=from.subtitleAssets;
  to.subtitleJob=from.subtitleJob;
  if(to.subtitleJob)to.subtitleJob.media=to;
  if(cache.has(from)){const entry=cache.get(from);cache.delete(from);cache.set(to,entry);}
  from.subtitleAbort=undefined;from.subtitleAssets=undefined;from.subtitleJob=undefined;
  return true;
}
async function read(response,signal,limit=LIMIT){
  if(!response.ok)throw new PlaybackError('The original subtitle resource is unavailable. Try Plex burn-in.');
  const chunks=[];let size=0;
  try{for await(const chunk of response.body){signal.throwIfAborted();size+=chunk.length;if(size>limit)throw new PlaybackError('Subtitle resource exceeds the supported size. Try Plex burn-in.');chunks.push(Buffer.from(chunk));}}
  catch(error){await response.body.cancel?.().catch(()=>{});throw error;}
  return Buffer.concat(chunks,size);
}
function source(media){
  const track=media.selection?.subtitle;
  if(!track || !['ass','pgs','vobsub'].includes(track.delivery))throw new PlaybackError('No browser-rendered subtitle is selected.');
  const part = media.sourceSelection ? Sources.select(media.source, media.sourceSelection).part : media.source?.Media?.[0]?.Part?.[0];
  const row = part?.Stream?.find(s=>String(s.id)===track.id);
  if(!row)throw new PlaybackError('Subtitle selection no longer belongs to this file.');
  return {track,row};
}
function startPgsJob(plex,media){
  const {track}=source(media),version=media.captionVersion;
  if(active>=2)throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose Plex burn-in.');
  const controller=new AbortController();
  const abort=AbortSignal.any([media.subtitleAbort.signal,controller.signal,AbortSignal.timeout(300000)]);
  const job={media,version,controller,chunks:[],size:0,listeners:new Set(),complete:false,error:null};
  active++;
  job.promise=(async()=>{
    try{
      const av1=plex.av1;
      if(!av1?.ffmpeg||!Number.isSafeInteger(track.index))throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or Plex burn-in.');
      await av1.input({...media,start:media.sourceStart,plexContext:plex},abort,async url=>{
        // Flush each packet so viewers receive cues as soon as demuxing reaches
        // them, instead of waiting for FFmpeg's pipe buffer to fill.
        const args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',url,'-map','0:'+track.index,'-c:s','copy','-map_metadata','-1','-map_chapters','-1','-flush_packets','1','-f','sup','pipe:1'];
        await av1.stream(av1.ffmpeg,args,abort,chunk=>{
          job.chunks.push(chunk);job.size+=chunk.length;
          for(const listener of job.listeners)try{listener(chunk,null);}catch{}
        },{idleTimeout:300000,maxOutput:LIMIT});
      });
      job.complete=true;
      const fullData=Buffer.concat(job.chunks,job.size);
      job.output=fullData;job.chunks=[];
      const result={format:'pgs',assets:new Map([['data',fullData]]),version,size:job.size};
      const target=job.media;
      clearCached(target);
      abort.throwIfAborted();if(target.captionVersion!==version)throw new PlaybackError('Subtitle selection changed.');
      while(cache.size>=8)clearCached(cache.keys().next().value);reserve(result.size);
      cache.set(target,result);bytes+=result.size;target.subtitleAssets=result.assets;
      for(const listener of job.listeners)try{listener(null,null);}catch{}
      return result;
    }catch(error){
      job.error=classifyExtractionError(error);
      for(const listener of job.listeners)try{listener(null,job.error);}catch{}
      throw job.error;
    }finally{
      active--;job.listeners.clear();
      if(job.media.subtitleJob===job)job.media.subtitleJob=undefined;
    }
  })();
  job.promise.catch(()=>{});
  media.subtitleJob=job;
  return job;
}
async function pipe(plex,media,req,res,signal){
  const version=media.captionVersion,previous=cache.get(media);
  if(previous?.version===version&&previous.assets?.has('data')){
    const data=previous.assets.get('data');
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-store'});
    res.end(req?.method==='HEAD'?undefined:data);return;
  }
  if(req?.method==='HEAD'){res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});res.end();return;}
  let job=media.subtitleJob;
  if(!job||job.version!==version)job=startPgsJob(plex,media);
  let wake,closed=false,sent=0,index=0,headers=false;
  const notify=()=>{wake?.();wake=undefined;};
  const cancel=()=>{closed=true;if(!res.writableEnded&&!res.destroyed)res.destroy();notify();};
  const close=()=>{closed=true;notify();};
  const wait=()=>new Promise(resolve=>{wake=resolve;});
  job.listeners.add(notify);res.on('close',close);signal?.addEventListener('abort',cancel,{once:true});
  try{
    if(signal?.aborted||res.destroyed)cancel();
    while(!closed){
      if(job.error)throw job.error;
      const chunk=job.complete?job.output?.subarray(sent,sent+65536):job.chunks[index];
      if(chunk?.length){
        if(!headers){res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});headers=true;}
        sent+=chunk.length;index++;
        if(res.write(chunk)===false){
          // Each subscriber drains independently; slow readers cannot grow an
          // unbounded response queue or hold another viewer's video connection.
          await new Promise(resolve=>{
            const done=()=>{res.off('drain',done);res.off('close',done);signal?.removeEventListener('abort',done);resolve();};
            res.on('drain',done);res.on('close',done);signal?.addEventListener('abort',done,{once:true});
            if(closed||signal?.aborted||res.destroyed)done();
          });
        }
      }else if(job.complete){
        if(!headers)res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});
        res.end();return;
      }else await wait();
    }
  }catch(error){if(!res.headersSent)throw error;res.destroy();}
  finally{
    job.listeners.delete(notify);res.off('close',close);signal?.removeEventListener('abort',cancel);
    if(!job.complete&&job.listeners.size===0)job.controller?.abort();
  }
}
async function extract(plex,media,track,signal){
  const av1=plex.av1;
  if(!av1?.ffmpeg || !Number.isSafeInteger(track.index))throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or Plex burn-in.');
  let directory;
  try{return await av1.input({...media,start:media.sourceStart,plexContext:plex},signal,async url=>{
    const fonts=[];
    if(track.delivery==='ass'){
      const info=JSON.parse((await av1.run(av1.ffprobe,['-v','error','-show_entries','stream=index,codec_type:stream_tags=mimetype,filename','-of','json',url],signal,20000,1024*1024)).toString());
      for(const stream of info.streams || [])if(stream.codec_type==='attachment' && Number.isSafeInteger(stream.index) &&
        (!stream.tags?.mimetype || /(?:font|opentype|truetype)/i.test(stream.tags.mimetype)) && /\.(?:ttf|ttc|otf|woff2?)$/i.test(stream.tags?.filename || '')){
        if(fonts.length>=32)throw new PlaybackError('Subtitle font attachments exceed the supported count.');fonts.push(stream.index);
      }
    }
    if(fonts.length)directory=await fs.mkdtemp(path.join(os.tmpdir(),'uburoom-subtitles-'));
    const files=fonts.map((_,i)=>path.join(directory,String(i)+'.font'));
    const budget=new AbortController(),cancel=()=>budget.abort();signal.addEventListener('abort',cancel,{once:true});
    let checking=false,oversize=false;
    const timer=files.length?setInterval(async()=>{if(checking)return;checking=true;try{
      const sizes=await Promise.all(files.map(file=>fs.stat(file).then(s=>s.size,()=>0)));
      if(sizes.reduce((a,b)=>a+b,0)>FONTS){oversize=true;budget.abort();}
    }finally{checking=false;}},100):undefined;
    try{
      const args=['-hide_banner','-loglevel','error','-nostdin','-y',...fonts.flatMap((index,i)=>['-dump_attachment:'+index,files[i]]),
        '-i',url,'-map','0:'+track.index,'-c:s','copy','-map_metadata','-1','-map_chapters','-1','-f',track.delivery==='ass'?'ass':track.delivery==='pgs'?'sup':'matroska','pipe:1'];
      const data=await av1.run(av1.ffmpeg,args,AbortSignal.any([signal,budget.signal]),60000,track.delivery==='ass'?4*1024*1024:LIMIT);
      const assets=new Map([['data',data]]);let fontSize=0;
      for(let i=0;i<files.length;i++){const stat=await fs.stat(files[i]);fontSize+=stat.size;if(fontSize>FONTS)throw new PlaybackError('Subtitle fonts exceed the supported size.');assets.set('font-'+i,await fs.readFile(files[i]));}
      if(!data.length || oversize)throw new PlaybackError('Subtitle extraction produced no usable data.');
      return {format:track.delivery,fileName:track.delivery==='vobsub'?'track.mks':undefined,assets};
    }finally{clearInterval(timer);signal.removeEventListener('abort',cancel);}
  });}catch(error){if(signal.aborted)throw error;throw classifyExtractionError(error);}
  finally{if(directory){const resolved=path.resolve(directory);if(path.dirname(resolved)!==path.resolve(os.tmpdir())||!path.basename(resolved).startsWith('uburoom-subtitles-'))throw new Error('Invalid subtitle temporary directory');await fs.rm(resolved,{recursive:true,force:true,maxRetries:5});}}
}
async function load(plex,media,signal){
  const {track,row}=source(media),version=media.captionVersion;
  const previous=cache.get(media);
  if(previous?.version===version){cache.delete(media);cache.set(media,previous);return previous;}
  if(media.subtitleJob?.version===version)return media.subtitleJob.promise;
  if(active>=2)throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose Plex burn-in.');
  const abort=AbortSignal.any([signal,media.subtitleAbort.signal,AbortSignal.timeout(85000)]);
  const job={media,version};active++;
  job.promise=(async()=>{
    let result;
    if(track.external){
      if(!/^\/library\/streams\/\d{1,20}(?:\.[a-z0-9]+)?$/.test(row.key))throw new PlaybackError('Invalid subtitle resource.');
      const ext=track.delivery==='ass'?'ass':track.delivery==='pgs'?'sup':'sub';
      const key=track.delivery!=='vobsub' && /\.[a-z0-9]+$/.test(row.key)?row.key:row.key.replace(/\.[a-z0-9]+$/,'')+'.'+ext;
      const data=await read(await plex.request(key,{signal:abort,headers:{Accept:'*/*'}}),abort,track.delivery==='ass'?4*1024*1024:LIMIT);
      result={format:track.delivery,assets:new Map([['data',data]])};
      if(track.delivery==='vobsub')result.assets.set('index',await read(await plex.request(key.replace(/\.sub$/,'.idx'),{signal:abort,headers:{Accept:'*/*'}}),abort,1024*1024));
    }else result=await extract(plex,media,track,abort);
    const target=job.media;
    abort.throwIfAborted();if(target.captionVersion!==version)throw new PlaybackError('Subtitle selection changed.');
    result.version=version;result.size=[...result.assets.values()].reduce((sum,value)=>sum+value.length,0);
    if(result.size>TOTAL)throw new PlaybackError('Subtitle resources exceed the cache limit.');
    clearCached(target);
    while(cache.size>=8)clearCached(cache.keys().next().value);reserve(result.size);
    cache.set(target,result);bytes+=result.size;target.subtitleAssets=result.assets;return result;
  })().finally(()=>{active--;if(job.media.subtitleJob===job)job.media.subtitleJob=undefined;});
  media.subtitleJob=job;return job.promise;
}
// Inspect all packet timestamps first: filtering ffprobe to a sparse subtitle
// stream makes even its interval reader wait for the next selected packet.
// Then stop FFmpeg at the known packet count, preserving original source PTS.
function alignPgs(data,origin,endSeconds){
  const output=[];let cues=0;
  for(let offset=0;offset<data.length;){
    if(offset+13>data.length||data[offset]!==0x50||data[offset+1]!==0x47)throw new PlaybackError('Invalid PGS extraction. Try Plex burn-in.');
    const end=offset+13+data.readUInt16BE(offset+11);
    if(end>data.length)throw new PlaybackError('Incomplete PGS extraction. Try Plex burn-in.');
    const pts=Math.round(data.readUInt32BE(offset+2)-origin*90000);
    if(pts>=0&&pts<endSeconds*90000){
      const segment=Buffer.from(data.subarray(offset,end));segment.writeUInt32BE(pts,2);segment.writeUInt32BE(0,6);
      output.push(segment);if(segment[10]===0x16)cues++;
    }
    offset=end;
  }
  return {data:Buffer.concat(output),cues};
}
function waitWindow(job,signal){
  return new Promise((resolve,reject)=>{
    job.users++;
    let settled=false;
    const finish=(error,value)=>{
      if(settled)return;settled=true;signal?.removeEventListener('abort',cancel);
      if(--job.users===0&&!job.complete)job.controller.abort();
      error?reject(error):resolve(value);
    };
    const cancel=()=>finish(signal.reason || new PlaybackError('Subtitle loading was cancelled.'));
    signal?.addEventListener('abort',cancel,{once:true});
    if(signal?.aborted)cancel();
    job.promise.then(value=>finish(null,value),error=>finish(error));
  });
}
async function window(plex,media,{atMs=0,beforeMs=15000,afterMs=60000,signal}={}){
  const {track}=source(media),version=media.captionVersion;
  signal?.throwIfAborted();media.subtitleAbort?.signal.throwIfAborted();
  const number=(value,fallback)=>Number.isFinite(Number(value))?Number(value):fallback;
  const at=Math.max(0,number(atMs,0))/1000;
  const before=Math.min(60,Math.max(0,number(beforeMs,15000))/1000);
  const after=Math.min(180,Math.max(10,number(afterMs,60000)/1000));
  const startSeconds=Math.max(0,at-before),endSeconds=at+after,durationSeconds=endSeconds-startSeconds;
  const startMs=Math.round(startSeconds*1000),endMs=Math.round(endSeconds*1000);
  media.windowCache||=new Map();media.windowJobs||=new Map();
  const cacheKey=JSON.stringify([version,track.id,track.delivery,startMs,endMs]);
  for(const item of media.windowCache.values()){
    if(item.version===version&&item.trackId===track.id&&item.startMs<=startMs&&item.endMs>=endMs){
      windows.delete(item);windows.set(item,media);
      return {format:track.delivery,startMs:item.startMs,endMs:item.endMs,data:item.data,cues:item.cues};
    }
  }
  let job=media.windowJobs.get(cacheKey);
  if(job?.controller.signal.aborted)job=undefined;
  if(job)return waitWindow(job,signal);
  if(active>=2)throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose Plex burn-in.');
  const av1=plex.av1;
  if(!av1?.ffmpeg||!Number.isSafeInteger(track.index))throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or Plex burn-in.');
  const controller=new AbortController();
  const abort=AbortSignal.any([controller.signal,media.subtitleAbort?.signal,AbortSignal.timeout(30000)].filter(Boolean));
  job={media,controller,users:0,complete:false};active++;
  job.promise=Promise.resolve().then(async()=>{
    try{
      const format=track.delivery==='ass'?'ass':track.delivery==='vobsub'?'matroska':'sup';
      let pgs;
      let data=await av1.input({...media,start:media.sourceStart,plexContext:plex,subtitleWindow:track.delivery==='pgs'},abort,async url=>{
        if(track.delivery==='pgs'){
          const probe=av1.ffprobe;
          if(!probe)throw new PlaybackError('PGS window extraction needs configured FFprobe. Try Plex burn-in.');
          let origin=media.subtitleOrigin;
          if(!Number.isFinite(origin)){
            const info=JSON.parse((await av1.run(probe,['-v','error','-analyzeduration','1000000','-probesize','1048576','-read_intervals','%+0.1','-show_packets','-show_entries','format=start_time:stream=index,codec_name:packet=pts_time','-of','json',url],abort,10000,1024*1024)).toString());
            if(!info.streams?.some(stream=>stream.index===track.index&&stream.codec_name==='hdmv_pgs_subtitle'))throw new PlaybackError('The selected PGS stream could not be verified. Try Plex burn-in.');
            origin=Number(info.format?.start_time??info.packets?.[0]?.pts_time);
            if(!Number.isFinite(origin))throw new PlaybackError('The source timeline could not be determined. Try Plex burn-in.');
            abort.throwIfAborted();job.media.subtitleOrigin=origin;
          }
          const metadata=JSON.parse((await av1.run(probe,['-v','error','-analyzeduration','1000000','-probesize','1048576','-read_intervals',String(origin+startSeconds)+'%'+String(origin+endSeconds),
            '-show_packets','-show_entries','packet=stream_index,pts_time,size:stream=index,codec_name','-of','json',url],abort,25000,16*1024*1024)).toString());
          if(!metadata.streams?.some(stream=>stream.index===track.index&&stream.codec_name==='hdmv_pgs_subtitle'))throw new PlaybackError('The selected PGS stream could not be verified. Try Plex burn-in.');
          if(!Array.isArray(metadata.packets)||!metadata.packets.length)throw new PlaybackError('No media packets could be verified for the subtitle window. Try Plex burn-in.');
          const packets=metadata.packets.filter(packet=>packet.stream_index===track.index);
          const count=packets.length;
          const expected=packets.reduce((sum,packet)=>sum+Number(packet.size),0);
          if(!Number.isSafeInteger(expected)||expected<0||expected>16*1024*1024)throw new PlaybackError('PGS window exceeded the supported limit. Try Plex burn-in.');
          if(!count){pgs={data:Buffer.alloc(0),cues:0};return pgs.data;}
          const args=['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(startSeconds),'-copyts','-analyzeduration','1000000','-probesize','1048576','-i',url,
            '-map','0:'+track.index,'-c:s','copy','-frames:s',String(count),'-flush_packets','1','-map_metadata','-1','-map_chapters','-1','-f','sup','pipe:1'];
          let pending=Buffer.alloc(0),rawBytes=0;
          const expectedTimes=new Map(),receivedTimes=new Map();
          for(const packet of packets){
            const pts=Math.round(Number(packet.pts_time)*90000);
            if(!Number.isSafeInteger(pts)||pts<0||pts>0xffffffff)throw new PlaybackError('PGS source timestamps are unavailable or exceed the supported range. Try Plex burn-in.');
            expectedTimes.set(pts,(expectedTimes.get(pts)||0)+Number(packet.size));
          }
          const outputComplete=chunk=>{
            pending=Buffer.concat([pending,chunk]);let offset=0;
            while(offset+13<=pending.length){
              if(pending[offset]!==0x50||pending[offset+1]!==0x47)throw new PlaybackError('Invalid PGS extraction. Try Plex burn-in.');
              const length=pending.readUInt16BE(offset+11);if(offset+13+length>pending.length)break;
              const pts=pending.readUInt32BE(offset+2);receivedTimes.set(pts,(receivedTimes.get(pts)||0)+3+length);
              rawBytes+=3+length;offset+=13+length;
            }
            pending=Buffer.from(pending.subarray(offset));return rawBytes>=expected;
          };
          const data=await av1.run(av1.ffmpeg,args,abort,25000,16*1024*1024,undefined,{outputComplete});
          if(rawBytes!==expected||pending.length||expectedTimes.size!==receivedTimes.size||[...expectedTimes].some(([pts,size])=>receivedTimes.get(pts)!==size))throw new PlaybackError('PGS extraction did not match the requested packets. Try Plex burn-in.');
          pgs=alignPgs(data,origin,endSeconds);
          if(!pgs.data.length)throw new PlaybackError('Subtitle extraction produced no usable data. Try Plex burn-in.');
          return pgs.data;
        }
        const args=['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(startSeconds),'-t',String(durationSeconds),'-copyts','-i',url,
          '-map','0:'+track.index,'-c:s','copy','-map_metadata','-1','-map_chapters','-1','-f',format,'pipe:1'];
        return av1.run(av1.ffmpeg,args,abort,25000,16*1024*1024);
      });
      abort.throwIfAborted();
      const target=job.media;
      if(target.captionVersion!==version||target.selection?.subtitle?.id!==track.id)throw new PlaybackError('Subtitle selection changed.');
      data||=Buffer.alloc(0);
      let cues=0;
      if(track.delivery==='pgs')cues=pgs.cues;
      else if(track.delivery==='ass')cues=(data.toString('utf8').match(/^Dialogue:/mg)||[]).length;
      else cues=data.length>500?1:0;
      const entry={media:target,key:cacheKey,version,trackId:track.id,startMs,endMs,data,cues};
      target.windowCache||=new Map();
      let trackBytes=[...target.windowCache.values()].reduce((n,item)=>n+item.data.length,0);
      while(target.windowCache.size>=16 || trackBytes+data.length>16*1024*1024){
        const oldest=target.windowCache.values().next().value;if(!oldest)break;
        trackBytes-=oldest.data.length;dropWindow(oldest);
      }
      while(windows.size>=128)dropWindow(windows.keys().next().value);
      reserve(data.length);target.windowCache.set(cacheKey,entry);windows.set(entry,target);bytes+=data.length;
      return {format:track.delivery,startMs,endMs,data,cues};
    }catch(error){if(abort.aborted)throw error;throw classifyExtractionError(error);}
    finally{
      active--;job.complete=true;
      if(job.media.windowJobs?.get(cacheKey)===job)job.media.windowJobs.delete(cacheKey);
    }
  });
  media.windowJobs.set(cacheKey,job);
  return waitWindow(job,signal);
}
module.exports={load,clear,transfer,read,pipe,window,classifyExtractionError,LIMIT};
