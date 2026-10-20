'use strict';

class ConversionPolicy {
  constructor(settings, plex) {
    this.settings = settings;
    this.plex = plex;
    this.jobs = new Set();
  }
  failure(message) { return Object.assign(new (require('./av1').PlaybackError)(message), { playbackPolicy:true }); }
  async video(provider) {
    const policy = this.settings;
    if (!policy) return;
    if (policy.policy === 'disabled' || !policy[provider]) throw this.failure('Playback needs ' + provider + ' conversion, which this server has disabled. Try Original quality or another supported player/track.');
    if (provider === 'uburoom' && !policy.formats.includes('av1')) throw this.failure('AV1 conversion is not offered by this server.');
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
    if(this.jobs.size>=this.settings.maxJobs)throw this.failure('All conversion jobs are in use. Join a matching shared output or try again after another conversion stops.');
    const job={};this.jobs.add(job);return ()=>this.jobs.delete(job);
  }
}
module.exports={ConversionPolicy};
