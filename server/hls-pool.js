'use strict';
const {PlaybackError}=require('./av1');
// Only live, identical outputs in one authorized room/media generation are pooled.
// A cached segment-zero anchor prevents a late join from rewinding Plex's encoder.
class HLSPool {
  constructor(stop,{maxGroups=32,maxBytes=64*1024*1024,anchorBytes=16*1024*1024}={}) {
    this.stop=stop;this.groups=new Map();this.live=new Set();this.bytes=0;this.pendingBytes=0;
    this.maxGroups=maxGroups;this.maxBytes=maxBytes;this.anchorBytes=anchorBytes;this.closed=false;
  }
  async anchor(media,timeoutMs) {
    const plex=media.plexContext,signal=AbortSignal.timeout(timeoutMs);
    const options={signal,headers:{Accept:'*/*','X-Plex-Client-Identifier':media.transcodeId}};
    const wait=promise=>new Promise((resolve,reject)=>{
      const abort=()=>reject(signal.reason);if(signal.aborted){Promise.resolve(promise).catch(()=>{});abort();return;}
      signal.addEventListener('abort',abort,{once:true});
      Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    });
    let url=media.start,text=media.initialManifest;
    for(let depth=0;depth<3;depth++) {
      if(!text)text=await wait((await wait(plex.request(url,options))).text());
      if(text.length>2e6||!text.startsWith('#EXTM3U')||/#EXT-X-(?:KEY|MAP):/.test(text))return;
      const first=text.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!line.startsWith('#'));
      if(!first)return;
      const target=plex.url(new URL(first.trim(),url).href).href;
      if(!/#EXTINF:/.test(text)){url=target;text=undefined;continue;}
      const sequence=/#EXT-X-MEDIA-SEQUENCE:([^\r\n]+)/.exec(text);
      if(sequence&&Number(sequence[1])!==0)return;
      const response=await wait(plex.request(target,options)),reader=response.body.getReader();
      const chunks=[];let size=0;
      try {
        for(;;){const {done,value}=await wait(reader.read());if(done)break;
          if(size+value.byteLength>this.anchorBytes||this.bytes+this.pendingBytes+value.byteLength>this.maxBytes)return;
          size+=value.byteLength;this.pendingBytes+=value.byteLength;chunks.push(value);}
        if(!size)return;
        const bytes=Buffer.concat(chunks,size);
        if(bytes[0]!==0x47||size<188||size>188&&bytes[188]!==0x47)return;
        this.bytes+=size;
        return {url:target,bytes,type:response.headers.get('content-type')||'video/mp2t'};
      } finally {this.pendingBytes-=size;void reader.cancel().catch(()=>{});reader.releaseLock();}
    }
  }
  invalidate(lease) {
    const group=lease?.group;
    if(group&&this.groups.get(group.key)===group)this.groups.delete(group.key);
  }
  async dispose(group) {
    if(group.users.size||group.disposed||!group.settled)return;
    group.disposed=true;this.live.delete(group);
    if(this.groups.get(group.key)===group)this.groups.delete(group.key);
    if(group.anchor){this.bytes-=group.anchor.bytes.length;group.anchor=undefined;}
    if(group.media&&!group.claimed)await this.stop(group.media);
  }
  async acquire(key,create,authorized,exclude,warmMs=1000,existingOnly=false,direct=false) {
    const unavailable=()=>{throw Object.assign(new PlaybackError('No matching shared output is available.'),{conversionCapacity:true});};
    if(existingOnly && (!this.groups.has(key) || !(this.groups.get(key).anchor || this.groups.get(key).direct)))return unavailable();
    this.invalidate(exclude);
    if(this.closed)throw new PlaybackError('Server is shutting down.');
    if(!key||!this.groups.has(key)&&this.live.size>=this.maxGroups)return {media:await create(authorized)};
    let group=this.groups.get(key),producer=false;
    if(!group){
      producer=true;group={key,users:new Set(),settled:false,direct};this.groups.set(key,group);this.live.add(group);
      group.promise=Promise.resolve().then(async()=>{
        try {
          // Source preparation always uses its producer's own authorization.
          group.media=await create(authorized);
          if(!direct)try{group.anchor=await this.anchor(group.media,Math.min(8000,Math.max(1,warmMs)));}catch{/* Uncacheable outputs keep independent sessions. */}
          if(!direct&&!group.anchor&&this.groups.get(key)===group)this.groups.delete(key);
          return group.media;
        } catch(error) {
          if(this.groups.get(key)===group)this.groups.delete(key);
          throw error;
        } finally {group.settled=true;void this.dispose(group).catch(()=>{});}
      });
    }
    const user={authorized};group.users.add(user);let retained=false;
    try {
      let media;
      try{media=await group.promise;}
      catch(error){
        if(!producer&&!this.closed&&(!authorized||await authorized()))return existingOnly?unavailable():{media:await create(authorized)};
        throw error;
      }
      const live=!authorized||await authorized();
      if(this.closed||!live)throw new PlaybackError('Viewing access or stream selection expired.');
      if(!direct&&!group.anchor) {
        // No anchor cache means a future join could restart the encoder at zero.
        // Transfer the first private output once; other callers prepare their own.
        if(!group.claimed){group.claimed=true;return {media};}
        return existingOnly?unavailable():{media:await create(authorized)};
      }
      retained=true;
      const lease={group,released:false};
      lease.release=async()=>{if(lease.released)return;lease.released=true;group.users.delete(user);await this.dispose(group);};
      return {media,lease};
    } finally {if(!retained){group.users.delete(user);await this.dispose(group);}}
  }
  response(lease,target,method,range) {
    const anchor=!lease?.released&&lease?.group.anchor;
    if(!anchor||target!==anchor.url)return;
    const size=anchor.bytes.length,headers={'Content-Type':anchor.type,'Accept-Ranges':'bytes'};
    let start=0,end=size-1;
    if(range){
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match||!match[1]&&!match[2])return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
      if(!match[1])start=Math.max(0,size-Number(match[2]));else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(!Number.isSafeInteger(start)||start>end||start>=size)return new Response(null,{status:416,headers:{'Content-Range':'bytes */'+size}});
      headers['Content-Range']='bytes '+start+'-'+end+'/'+size;
    }
    headers['Content-Length']=String(end-start+1);
    return new Response(method==='HEAD'?null:anchor.bytes.subarray(start,end+1),{status:range?206:200,headers});
  }
  async close() {
    this.closed=true;this.groups.clear();
    await Promise.allSettled([...this.live].map(async group=>{group.users.clear();await group.promise.catch(()=>{});await this.dispose(group);}));
  }
}
module.exports={HLSPool};
