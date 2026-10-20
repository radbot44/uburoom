'use strict';

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
        if(!this.reading)this.reading=(async()=>{
          try {
            const preferences = await this.plex.json('/:/prefs');
            const setting = preferences.Setting?.find(value => value.id === 'TranscoderCanOnlyRemuxVideo');
            if(!setting || ![true,false,0,1,'0','1'].includes(setting.value))throw this.failure('The Plex video-conversion policy could not be verified. Ask the owner to check Plex settings or deliberately configure an override.');
            this.preference={until:Date.now()+30000,disabled:[true,1,'1'].includes(setting.value)};
          } catch(error){throw error.playbackPolicy?error:this.failure('Cannot read the Plex conversion policy. Original playback remains available; ask the owner to check the server credentials.');}
        })().finally(()=>{this.reading=undefined;});
        await this.reading;
      }
      if(this.preference.disabled)throw Object.assign(this.failure('Plex disables video transcoding. uburoom honors this setting; try Original playback in a compatible player.'),{videoDisabled:true});
    }
  }
  acquire() {
    if(!this.settings)return ()=>{};
    if(this.jobs.size>=this.settings.maxJobs)throw Object.assign(this.failure('All conversion jobs are in use. A shared quality may be available; otherwise retry after a conversion stops.'),{conversionCapacity:true});
    const job={};this.jobs.add(job);return ()=>{this.jobs.delete(job);this.waiters[0]?.();};
  }
  async wait({signal,authorized,timeoutMs=8000}={}) {
    if(signal?.aborted || authorized && !await authorized())throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
    if(!this.settings)return ()=>{};
    if(!this.waiters.length && this.jobs.size<this.settings.maxJobs)return this.acquire();
    if(this.waiters.length>=32)throw Object.assign(this.failure('Too many players are waiting for conversion. Try again shortly.'),{conversionCapacity:true});
    const until=Date.now()+timeoutMs;
    let wake;
    const turn=()=>wake?.();this.waiters.push(turn);
    try {
      for(;;) {
        if(signal?.aborted || authorized && !await authorized())throw this.failure('Conversion waiting cancelled: viewing access expired or selection changed.');
        if(this.waiters[0]===turn && this.jobs.size<this.settings.maxJobs)return this.acquire();
        if(Date.now()>=until)throw Object.assign(this.failure('All conversion jobs are in use. Try an available shared quality or wait for another conversion to stop.'),{conversionCapacity:true});
        await new Promise(resolve=>{const timer=setTimeout(resolve,Math.min(200,Math.max(0,until-Date.now())));wake=()=>{clearTimeout(timer);resolve();};});
      }
    } finally {this.waiters=this.waiters.filter(value=>value!==turn);this.waiters[0]?.();}
  }
}
module.exports={ConversionPolicy};
