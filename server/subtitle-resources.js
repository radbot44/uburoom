'use strict';
// Original subtitle assets only. Rendering stays in the browser; extraction never
// re-encodes video or receives a Plex credential in process arguments.
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {PlaybackError}=require('./av1');
const LIMIT=64*1024*1024,FONTS=16*1024*1024,TOTAL=96*1024*1024;
const cache=new Map();let bytes=0,active=0;
function classifyExtractionError(error){
  if(/timed out/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction timed out. Try Plex burn-in.');
  if(/exceeded the.*limit|exceed/i.test(error?.message || ''))return new PlaybackError('Subtitle resource or fonts exceeded the supported limits. Try Plex burn-in.');
  if(/no usable data/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction produced no usable data. Try Plex burn-in.');
  if(/failed/i.test(error?.message || ''))return new PlaybackError('Subtitle extraction failed during media demuxing. Try Plex burn-in.');
  if(error instanceof PlaybackError)return error;
  return new PlaybackError('Original subtitles could not be extracted. Try Plex burn-in.');
}
function clear(media){const old=cache.get(media);if(old){bytes-=old.size;cache.delete(media);}media.subtitleAssets=undefined;}
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
  const row=media.source?.Media?.[0]?.Part?.[0]?.Stream?.find(s=>String(s.id)===track.id);
  if(!row)throw new PlaybackError('Subtitle selection no longer belongs to this file.');
  return {track,row};
}
function startPgsJob(plex,media){
  const {track}=source(media),version=media.captionVersion;
  if(active>=2)throw new PlaybackError('Subtitle extraction is busy. Retry shortly or choose Plex burn-in.');
  const abort=AbortSignal.any([media.subtitleAbort.signal,AbortSignal.timeout(300000)]);
  const job={version,chunks:[],size:0,listeners:new Set(),complete:false,error:null};
  active++;
  job.promise=(async()=>{
    try{
      const av1=plex.av1;
      if(!av1?.ffmpeg||!Number.isSafeInteger(track.index))throw new PlaybackError('This embedded subtitle needs configured FFmpeg extraction or Plex burn-in.');
      await av1.input({...media,start:media.sourceStart,plexContext:plex},abort,async url=>{
        const args=['-hide_banner','-loglevel','error','-nostdin','-y','-i',url,'-map','0:'+track.index,'-c:s','copy','-map_metadata','-1','-map_chapters','-1','-f','sup','pipe:1'];
        await av1.stream(av1.ffmpeg,args,abort,chunk=>{
          job.chunks.push(chunk);job.size+=chunk.length;
          for(const listener of job.listeners)try{listener(chunk,null);}catch{}
        },{idleTimeout:300000,maxOutput:LIMIT});
      });
      job.complete=true;
      const fullData=Buffer.concat(job.chunks,job.size);
      job.chunks=[];
      const result={format:'pgs',assets:new Map([['data',fullData]]),version,size:job.size};
      clear(media);
      while(cache.size>=8||bytes+result.size>TOTAL)clear(cache.keys().next().value);
      cache.set(media,result);bytes+=result.size;media.subtitleAssets=result.assets;
      for(const listener of job.listeners)try{listener(null,null);}catch{}
      return result;
    }catch(error){
      job.error=classifyExtractionError(error);
      for(const listener of job.listeners)try{listener(null,job.error);}catch{}
      throw job.error;
    }finally{
      active--;job.listeners.clear();
      if(media.subtitleJob===job)media.subtitleJob=undefined;
    }
  })();
  job.promise.catch(()=>{});
  media.subtitleJob=job;
  return job;
}
async function pipe(plex,media,req,res,signal){
  const version=media.captionVersion;
  const previous=cache.get(media);
  if(previous?.version===version&&previous.assets?.has('data')){
    const data=previous.assets.get('data');
    res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':data.length,'Cache-Control':'no-store'});
    res.end(req?.method==='HEAD'?undefined:data);
    return;
  }
  if(req?.method==='HEAD'){
    res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});
    res.end();
    return;
  }
  let job=media.subtitleJob;
  if(!job||job.version!==version)job=startPgsJob(plex,media);
  if(job.error)throw job.error;
  await new Promise((resolve,reject)=>{
    let headersSent=false,settled=false;
    const sendHeaders=()=>{
      if(headersSent)return;
      headersSent=true;
      res.writeHead(200,{'Content-Type':'application/octet-stream','Cache-Control':'no-store'});
    };
    const cleanup=()=>{
      if(settled)return;
      settled=true;
      job.listeners.delete(listener);
      res.off('close',onClose);
      signal?.removeEventListener('abort',onAbort);
    };
    const onClose=()=>{cleanup();resolve();};
    const onAbort=()=>{
      cleanup();
      if(!res.writableEnded&&!res.destroyed)res.destroy();
      resolve();
    };
    const listener=(chunk,error)=>{
      if(error){
        cleanup();
        if(!headersSent&&!res.headersSent)reject(error);
        else{res.destroy();resolve();}
        return;
      }
      if(chunk===null){
        cleanup();
        sendHeaders();
        res.end();
        resolve();
        return;
      }
      sendHeaders();
      res.write(chunk);
    };
    if(signal?.aborted||res.destroyed){onAbort();return;}
    if(job.chunks.length){
      sendHeaders();
      for(const chunk of job.chunks)res.write(chunk);
    }
    if(job.complete){
      const cached=cache.get(media);
      sendHeaders();
      if(!job.chunks.length&&cached?.version===version&&cached.assets?.has('data'))res.end(cached.assets.get('data'));
      else res.end();
      resolve();
      return;
    }
    res.on('close',onClose);
    signal?.addEventListener('abort',onAbort,{once:true});
    job.listeners.add(listener);
  });
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
  const job={version};active++;
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
    abort.throwIfAborted();if(media.captionVersion!==version)throw new PlaybackError('Subtitle selection changed.');
    result.version=version;result.size=[...result.assets.values()].reduce((sum,value)=>sum+value.length,0);
    if(result.size>TOTAL)throw new PlaybackError('Subtitle resources exceed the cache limit.');
    clear(media);
    while(cache.size>=8 || bytes+result.size>TOTAL)clear(cache.keys().next().value);
    cache.set(media,result);bytes+=result.size;media.subtitleAssets=result.assets;return result;
  })().finally(()=>{active--;if(media.subtitleJob===job)media.subtitleJob=undefined;});
  media.subtitleJob=job;return job.promise;
}
module.exports={load,clear,read,pipe,classifyExtractionError,LIMIT};
