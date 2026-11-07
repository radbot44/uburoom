'use strict';
const { SharedTask } = require('./operation');

class ConversionPolicy {
  constructor(settings, plex) {
    this.settings = settings;
    this.plex = plex;
    this.jobs = new Set();
    this.waiters = [];
  }
  failure(message) { return Object.assign(new (require('./av1').PlaybackError)(message), { playbackPolicy:true }); }
  async video(provider, codec = 'av1') {
    const policy = this.settings;
    if (!policy) return;
    if (policy.policy === 'disabled' || !policy[provider]) throw this.failure('Playback needs ' + provider + ' conversion, which this server has disabled. Try Original quality or another supported player/track.');
    if (provider === 'uburoom' && !policy.formats.includes(codec)) throw this.failure(codec.toUpperCase()+' conversion is not offered by this server.');
    if (policy.policy === 'follow_plex') {
      if (!this.preference || this.preference.until <= Date.now()) {
        if(!this.reading || this.reading.signal.aborted){
          const task = this.reading = new SharedTask(async()=>{
          try {
            const preferences = await this.plex.json('/:/prefs');
            const setting = preferences.Setting?.find(value => value.id === 'TranscoderCanOnlyRemuxVideo');
            if(!setting || ![true,false,0,1,'0','1'].includes(setting.value))throw this.failure('The Plex video-conversion policy could not be verified. Ask the owner to check Plex settings or deliberately configure an override.');
            this.preference={until:Date.now()+30000,disabled:[true,1,'1'].includes(setting.value)};
          } catch(error){throw error.playbackPolicy?error:this.failure('Cannot read the Plex conversion policy. Original playback remains available; ask the owner to check the server credentials.');}
          });
          task.promise.finally(()=>{if(this.reading===task)this.reading=undefined;}).catch(()=>{});
        }
        await this.reading.join();
      }
      if(this.preference.disabled)throw Object.assign(this.failure('Plex disables video transcoding. uburoom honors this setting; try Original playback in a compatible player.'),{videoDisabled:true});
    }
  }
  acquire() {
    if(!this.settings)return ()=>{};
    if(this.jobs.size>=this.settings.maxJobs)throw Object.assign(this.failure('All conversion jobs are in use. A shared quality may be available; otherwise retry after a conversion stops.'),{conversionCapacity:true});
    const job={};this.jobs.add(job);return ()=>{
      this.jobs.delete(job);
      const count = Math.max(1, this.settings.maxJobs - this.jobs.size);
      for (let i = 0; i < count && i < this.waiters.length; i++) this.waiters[i]?.();
    };
  }
  async wait({signal,authorized,timeoutMs=8000,background=false}={}) {
    if(signal?.aborted || authorized && !await authorized())throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
    if(!this.settings)return ()=>{};
    if(background) {
      if(this.waiters.length || this.jobs.size>=this.settings.maxJobs)throw Object.assign(this.failure('Conversion capacity is reserved for viewers.'),{conversionCapacity:true});
      return this.acquire();
    }
    if(!this.waiters.length && this.jobs.size<this.settings.maxJobs)return this.acquire();
    if(this.waiters.length>=32)throw Object.assign(this.failure('Too many players are waiting for conversion. Try again shortly.'),{conversionCapacity:true});
    const until=Date.now()+timeoutMs;
    let wake, pendingWake = false;
    const turn=()=>{ if (wake) wake(); else pendingWake = true; };
    this.waiters.push(turn);
    try {
      for(;;) {
        if(signal?.aborted || authorized && !await authorized())throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
        if(this.waiters[0]===turn && this.jobs.size<this.settings.maxJobs)return this.acquire();
        if(Date.now()>=until)throw Object.assign(this.failure('All conversion jobs are in use. Try an available shared quality or wait for another conversion to stop.'),{conversionCapacity:true});
        if(pendingWake) { pendingWake = false; continue; }
        await new Promise(resolve=>{
          let timer;
          const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', done); wake = undefined; resolve(); };
          timer = setTimeout(done, Math.min(200, Math.max(0, until - Date.now())));
          wake = done;
          signal?.addEventListener('abort', done, { once: true });
        });
      }
    } finally {
      this.waiters=this.waiters.filter(value=>value!==turn);
      const count = Math.max(1, this.settings.maxJobs - this.jobs.size);
      for (let i = 0; i < count && i < this.waiters.length; i++) this.waiters[i]?.();
    }
  }
}
module.exports={ConversionPolicy};
