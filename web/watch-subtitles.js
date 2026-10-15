'use strict';
// Native TextTrack/VTTCue rendering follows the video into fullscreen. Cue text
// is parsed by the media API, never inserted into the document as HTML.
class uburoomSubtitles {
  constructor(video,status) {
    this.video=video; this.status=status; this.cues=[]; this.generation=0;
    this.track=video.addTextTrack('subtitles','uburoom subtitles'); this.track.mode='disabled';
    video.textTracks.addEventListener('addtrack',event=>{if(event.track!==this.track)event.track.mode='disabled';});
  }
  clearCues() { for (const cue of Array.from(this.track.cues || [])) this.track.removeCue(cue); }
  reset() {
    this.generation++; this.abort?.abort(); clearTimeout(this.timer); this.url=undefined; this.cues=[]; this.attempts=0; this.loaded=false;
    this.clearCues(); this.track.mode='disabled'; this.status({message:'',error:false});
  }
  update(state) {
    if (state.subtitleUrl!==this.url) { this.reset(); this.url=state.subtitleUrl; }
    const offset=state.tracks?.subtitleOffset || 0;
    if (this.offset!==offset) { this.offset=offset; this.rebuild(); }
    if (!this.url) { this.status({message:state.tracks?.subtitleError || '',error:!!state.tracks?.subtitleError}); return; }
    this.track.mode='showing';
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
  layout(visible,phone) {
    const line=visible ? phone ? -7 : -3 : -1;
    if(this.defaultLine===line)return;this.defaultLine=line;
    for(const cue of Array.from(this.track.cues || []))if(cue.uburoomDefaultLine)cue.line=line;
  }
  retry() { clearTimeout(this.timer); this.timer=undefined; this.attempts=0; if(this.url && !this.loading)void this.load(); }
  async load() {
    const generation=this.generation, url=this.url; if(!url)return;
    this.loading=true; const abort=this.abort=new AbortController();
    this.status({message:'Loading subtitles…',error:false});
    try {
      const response=await fetch(url,{signal:AbortSignal.any([abort.signal,AbortSignal.timeout(35000)])}), value=await response.json();
      if (!response.ok) throw Object.assign(new Error(value.error || 'Subtitles could not load.'),{terminal:response.status===403});
      if (generation!==this.generation || url!==this.url) return;
      if (!Array.isArray(value.cues) || value.cues.some(c=>!Number.isFinite(c.start)||!Number.isFinite(c.end)||typeof c.text!=='string')) throw new Error('Invalid subtitle response.');
      this.cues=value.cues; this.rebuild(); this.loaded=true; this.status({message:'',error:false});
    } catch (error) {
      if (generation!==this.generation || abort.signal.aborted) return;
      this.attempts=error.terminal ? 3 : this.attempts+1;
      this.status({message:this.attempts>=3 ? error.message : 'Retrying subtitles…',error:this.attempts>=3});
      if(this.attempts<3)this.timer=setTimeout(()=>{this.timer=undefined;void this.load();},1000*2**(this.attempts-1));
    } finally {
      this.loading=false;
      if(generation!==this.generation && this.url && !this.loaded && !this.timer)void this.load();
    }
  }
  destroy() { this.reset(); }
}
window.uburoomSubtitles=uburoomSubtitles;
