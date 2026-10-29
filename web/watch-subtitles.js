'use strict';
// Native TextTrack/VTTCue rendering follows the video into fullscreen. Cue text
// is parsed by the media API, never inserted into the document as HTML.
class uburoomSubtitleWindows {
  constructor(renderer,windowUrl,onSync,signal) {
    this.renderer=renderer; this.windowUrl=windowUrl; this.onSync=onSync; this.signal=signal;
    this.intervals=[]; this.fetching=null; this.disposed=false;
  }
  isCovered(timeMs,lookaheadMs=0) {
    const end=timeMs+lookaheadMs;
    return this.intervals.some(i=>i.startMs<=timeMs&&i.endMs>=end);
  }
  synced(timeSeconds) {
    return this.isCovered(Math.round(timeSeconds*1000));
  }
  check(timeSeconds) {
    if(this.disposed)return;
    const timeMs=Math.round(timeSeconds*1000);
    if(!this.isCovered(timeMs))this.fetch(timeMs,true);
    else if(!this.isCovered(timeMs,20000))this.fetch(timeMs+30000,false);
  }
  fetch(targetMs,priority=false) {
    if(this.disposed||this.isCovered(targetMs))return;
    if(this.fetching){
      if(priority)this.fetching.abort();
      else return;
    }
    const controller=new AbortController(),signal=AbortSignal.any([this.signal,controller.signal,AbortSignal.timeout(30000)].filter(Boolean));
    this.fetching=controller;
    const beforeMs=15000,afterMs=60000;
    const url=`${this.windowUrl}?atMs=${targetMs}&beforeMs=${beforeMs}&afterMs=${afterMs}`;
    (async()=>{
      try{
        const response=await fetch(url,{signal});
        if(!response.ok)return;
        const rawStart=response.headers.get('x-subtitle-start-ms');
        const parsedStart=rawStart!==null && rawStart!=='' ? Number(rawStart) : NaN;
        const startMs=Number.isFinite(parsedStart) ? parsedStart : Math.max(0,targetMs-beforeMs);
        const rawEnd=response.headers.get('x-subtitle-end-ms');
        const parsedEnd=rawEnd!==null && rawEnd!=='' ? Number(rawEnd) : NaN;
        const endMs=Number.isFinite(parsedEnd) ? parsedEnd : (targetMs+afterMs);
        const rawCues=response.headers.get('x-subtitle-cues');
        const parsedCues=rawCues!==null && rawCues!=='' ? Number(rawCues) : NaN;
        const cues=Number.isFinite(parsedCues) ? parsedCues : 0;
        const buffer=await response.arrayBuffer();
        if(signal.aborted||this.disposed)return;
        if(buffer.byteLength>0)await this.renderer.append(new Uint8Array(buffer));
        this.intervals.push({startMs,endMs,cues});
        this.intervals.sort((a,b)=>a.startMs-b.startMs);
        const merged=[];
        for(const curr of this.intervals){
          if(!merged.length){merged.push(curr);continue;}
          const prev=merged[merged.length-1];
          if(curr.startMs<=prev.endMs){
            prev.endMs=Math.max(prev.endMs,curr.endMs);
            prev.cues+=curr.cues;
          }else merged.push(curr);
        }
        this.intervals=merged;
        this.onSync();
      }catch{}
      finally{if(this.fetching===controller)this.fetching=null;}
    })();
  }
  destroy() {
    this.disposed=true;
    this.fetching?.abort();
    this.intervals=[];
  }
}
class uburoomSubtitles {
  constructor(video,status,resolveMediaTime) {
    this.video=video; this.status=status; this.resolveMediaTime=resolveMediaTime; this.cues=[]; this.generation=0; this.key='';
    this.track=video.addTextTrack('subtitles','uburoom subtitles'); this.track.mode='disabled';
    video.textTracks.addEventListener('addtrack',event=>{if(event.track!==this.track)event.track.mode='disabled';});
    this.onTimeChange=()=>{
      this.windowScheduler?.check(this.mediaTime());
      this.syncStatus();
    };
    for(const event of ['seeking','seeked','timeupdate'])video.addEventListener?.(event,this.onTimeChange);
  }
  mediaTime() { return typeof this.resolveMediaTime==='function' ? this.resolveMediaTime(this.video.currentTime) : this.video.currentTime; }
  syncStatus() {
    if(!this.streaming && !this.windowScheduler || !this.renderer)return;
    const synced=this.windowScheduler ? this.windowScheduler.synced(this.mediaTime()) : (this.renderer.synced ? this.renderer.synced(this.mediaTime()) : true);
    if(synced===this.streamSynced)return;
    this.streamSynced=synced;
    this.status({message:synced ? '' : 'Loading subtitles…',error:false,loading:!synced});
  }
  clearCues() { for (const cue of Array.from(this.track.cues || [])) this.track.removeCue(cue); }
  reset() {
    this.generation++; this.abort?.abort(); clearTimeout(this.timer); this.timer=undefined; this.key=''; this.url=undefined; this.cues=[]; this.attempts=0; this.loading=false; this.loaded=false; this.streaming=false; this.streamSynced=false;
    this.windowScheduler?.destroy(); this.windowScheduler=undefined;
    this.renderer?.destroy();this.renderer=undefined;
    this.clearCues(); this.track.mode='disabled'; this.status({message:'',error:false,loading:false});
  }
  update(state) {
    const key=state.subtitleUrl?.replace(/^\/api\/watch\/media\/[a-f0-9]+\//,'') || '';
    if (key!==this.key) { this.reset(); this.key=key; }
    this.url=state.subtitleUrl;
    const offset=state.tracks?.subtitleOffset || 0;
    if (this.offset!==offset) { this.offset=offset; this.rebuild();this.renderer?.offset(offset); }
    this.picture=state.state?.picture; if(this.picture)this.renderer?.picture(this.picture);
    if (!this.url) { this.status({message:state.tracks?.subtitleError || '',error:!!state.tracks?.subtitleError,loading:false}); return; }
    this.track.mode=this.renderer?'disabled':'showing';
    if (this.streaming || this.windowScheduler) this.syncStatus();
    if (!this.loaded && !this.loading && !this.timer && this.attempts<3) void this.load();
  }
  rebuild() {
    this.clearCues();
    for (const item of this.cues) {
      const start=Math.max(0,item.start+(this.offset || 0)), end=item.end+(this.offset || 0);
      if (end<=start) continue;
      const cue=new VTTCue(start,end,item.text);
      if(!/(?:^|\s)line:/.test(item.settings || '')){cue.line=this.defaultLine ?? -1;cue.uburoomDefaultLine=true;}
      for (const setting of (item.settings || '').split(/\s+/)) {
        const [name,value]=setting.split(':');
        if (name==='align' && ['start','center','end','left','right'].includes(value)) cue.align=value;
        else if (name==='vertical' && ['rl','lr'].includes(value)) cue.vertical=value;
        else if (['line','position','size'].includes(name) && /^\d{1,3}%$/.test(value) && Number(value.slice(0,-1))<=100) {
          cue[name]=Number(value.slice(0,-1)); if(name==='line')cue.snapToLines=false;
        } else if (name==='line' && /^-?\d{1,3}$/.test(value)) cue.line=Number(value);
      }
      this.track.addCue(cue);
    }
  }
  layout(visible,lines=3) {
    const line=visible ? -lines : -1;
    if(this.defaultLine===line)return;this.defaultLine=line;
    for(const cue of Array.from(this.track.cues || []))if(cue.uburoomDefaultLine)cue.line=line;
  }
  retry() { clearTimeout(this.timer); this.timer=undefined; this.attempts=0; if(this.url && !this.loading)void this.load(); }
  async load() {
    const generation=this.generation, url=this.url; if(!url)return;
    this.loading=true; const abort=this.abort=new AbortController();
    try {
      this.status({message:'Loading subtitles…',error:false,loading:true});
      const response=await fetch(url,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(90000)])}), value=await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || 'Subtitles could not load.'),{terminal:response.status===403});
      if (generation!==this.generation) return;
      if(value.format){
        if(!['ass','pgs','vobsub'].includes(value.format)||!Array.isArray(value.fonts)||value.fonts.length>32)throw new Error('Invalid subtitle response.');
        const asset=async(name,limit)=>{
          if(typeof name!=='string'||!name.startsWith(url+'/')||!/(?:\/data|\/index|\/font-\d{1,2})$/.test(name))throw new Error('Invalid subtitle asset.');
          const result=await fetch(name,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(35000)])});
          if(!result.ok)throw new Error('Subtitle resource could not load. Retry or choose Plex burn-in.');
          const reader=result.body.getReader(),chunks=[];let size=0;
          try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit)throw new Error('Subtitle resource exceeds the supported size.');chunks.push(value);}}
          finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
          const bytes=new Uint8Array(size);let at=0;for(const chunk of chunks){bytes.set(chunk,at);at+=chunk.length;}return bytes;
        };
        let data, subUrl;
        if(value.window && ['pgs','ass','vobsub'].includes(value.format))subUrl=value.data;
        else if(value.format==='pgs')subUrl=value.data;
        else data=await asset(value.data,value.format==='ass'?4*1024*1024:64*1024*1024);
        const index=value.index?await asset(value.index,1024*1024):undefined;
        if(value.fonts.length)this.status({message:'Loading subtitle fonts…',error:false,loading:true});
        const fonts=[];let fontSize=0;for(const font of value.fonts){const bytes=await asset(font,16*1024*1024-fontSize);fontSize+=bytes.length;fonts.push(bytes);}
        this.status({message:'Preparing subtitles…',error:false,loading:true});
        const renderer=await window.uburoomSubtitleRenderers.create(this.video,value.format,{data,subUrl,index,fonts,fileName:value.fileName},this.offset||0,abort.signal,this.resolveMediaTime);
        if(generation!==this.generation){renderer.destroy();return;}
        this.renderer=renderer;renderer.offset(this.offset||0);this.track.mode='disabled';if(this.picture)renderer.picture(this.picture);
        if(value.window && ['pgs','ass','vobsub'].includes(value.format)){
          this.streamSynced=undefined;
          const scheduler=this.windowScheduler=new uburoomSubtitleWindows(renderer,value.window,()=>this.syncStatus(),abort.signal);
          this.syncStatus();
          scheduler.check(this.mediaTime());
        }else if(subUrl){
          if(typeof subUrl!=='string'||!subUrl.startsWith(url+'/')||!subUrl.endsWith('/data'))throw new Error('Invalid subtitle asset.');
          // Stall timers are backstops for the server's own FFmpeg idle limit. They
          // abort only this request so the failure is reported and retried; the
          // shared controller stays reserved for reset/cancellation. Headers wait
          // for the first extracted packet, which can follow a long demux catch-up.
          const stall=new AbortController(),stalled=()=>stall.abort(new Error('Subtitle stream timed out. Retry or choose Plex burn-in.'));
          const signal=AbortSignal.any([abort.signal,stall.signal]);
          const interrupted=error=>abort.signal.aborted ? error : stall.signal.aborted ? stall.signal.reason :
            error instanceof TypeError || error?.name==='AbortError' ? new Error('Subtitle stream was interrupted. Retry or choose Plex burn-in.') : error;
          const headerTimer=setTimeout(stalled,310000);
          let result;
          try{result=await fetch(subUrl,{signal});}
          catch(error){throw interrupted(error);}
          finally{clearTimeout(headerTimer);}
          if(!result.ok || !result.body){const value=await result.json().catch(()=>({}));throw Object.assign(new Error(value.error || 'Subtitle resource could not load. Retry or choose Plex burn-in.'),{terminal:result.status===403});}
          const reader=result.body.getReader(),limit=64*1024*1024;let size=0,idleTimer;
          const resetIdle=()=>{clearTimeout(idleTimer);idleTimer=setTimeout(stalled,310000);};
          this.streaming=true;this.streamSynced=false;this.syncStatus();
          resetIdle();
          try{
            for(;;){
              let next;
              try{next=await reader.read();}catch(error){throw interrupted(error);}
              const {done,value:chunk}=next;
              if(done)break;
              resetIdle();
              if(!chunk || !chunk.byteLength)continue;
              size+=chunk.byteLength;
              if(size>limit)throw new Error('Subtitle resource exceeds the supported size.');
              const added=await renderer.append(chunk);
              if(added>0)this.syncStatus();
            }
            clearTimeout(idleTimer);
            await renderer.flush();
            this.streaming=false;this.streamSynced=true;
          }finally{clearTimeout(idleTimer);await reader.cancel().catch(()=>{});reader.releaseLock();}
        }
      }else{
        if (!Array.isArray(value.cues) || value.cues.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||typeof c.text!=='string')) throw new Error('Invalid subtitle response.');
        this.cues=value.cues; this.rebuild();
      }
      this.loaded=true; if(!this.windowScheduler)this.status({message:'',error:false,loading:false});
    } catch (error) {
      if (generation!==this.generation || abort.signal.aborted) return;
      // Release this attempt's renderer and requests before retrying so a
      // retry never stacks a second overlay over a stale partial stream.
      abort.abort();this.renderer?.destroy();this.renderer=undefined;
      this.streaming=false;this.streamSynced=false;
      this.attempts=error.terminal ? 3 : this.attempts+1;
      const failed=this.attempts>=3;
      this.status({message:failed ? error.message : 'Retrying subtitles…',error:failed,loading:!failed});
      if(!failed)this.timer=setTimeout(()=>{this.timer=undefined;void this.load();},1000*2**(this.attempts-1));
    } finally {
      if(generation===this.generation)this.loading=false;
    }
  }
  destroy() {
    for(const event of ['seeking','seeked','timeupdate'])this.video.removeEventListener?.(event,this.onTimeChange);
    this.reset();
  }
}
if(typeof window!=='undefined')window.uburoomSubtitles=uburoomSubtitles;
if(typeof module!=='undefined')module.exports={uburoomSubtitleWindows,uburoomSubtitles};
