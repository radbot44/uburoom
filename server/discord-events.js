'use strict';
const {PermissionFlagsBits,GuildScheduledEventEntityType,GuildScheduledEventPrivacyLevel,GuildScheduledEventStatus} = require('discord.js');
const {discordRequest} = require('./discord-request');
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const iso=at=>new Date(at).toISOString();
const ENDED=[GuildScheduledEventStatus.Completed,GuildScheduledEventStatus.Canceled];

// Discord's copy of a uburoom watch night: an External scheduled event whose
// location is the room invite. uburoom owns the event; this reads back details
// edited in Discord and the interested count, and never decides access.
class DiscordEventSync {
  constructor(events) {this.events=events;this.hub=events.hub;this.lifetime=new AbortController();}
  get config() {return this.events.config;}
  configured() {return !!(this.config.guildId&&(this.config.botToken||this.hub.discordClient));}
  ready() {return !!this.hub.discordClient?.isReady();}
  request(action,current) {return discordRequest(action,{signal:this.lifetime.signal,...(current?{current}:{})});}
  async guild(guildId=this.config.guildId) {
    const client=this.hub.discordClient;
    if(!client?.isReady())throw fail('Discord is reconnecting. Try again shortly.');
    const guild=await client.guilds.fetch(guildId);
    const member=guild.members.me||await this.request(()=>guild.members.fetchMe());
    if(!member.permissions.has(PermissionFlagsBits.CreateEvents))throw fail('The bot needs Create Events in the Discord server.');
    return guild;
  }
  location(record) {return this.config.publicUrl+'/join/'+record.inviteCode;}
  invite(record) {
    const url=this.location(record);
    if(url.length>100)throw fail('Discord event locations allow at most 100 characters. This server needs a shorter public URL.',400);
    return url;
  }
  owned(remote) {return remote.creatorId===this.hub.discordClient.user.id&&remote.entityType===GuildScheduledEventEntityType.External;}
  url(discord) {return discord?.eventId?`https://discord.com/events/${discord.guildId}/${discord.eventId}`:undefined;}
  // Discord edits flow back into the uburoom event; a missing count keeps the last one.
  merge(event,remote) {
    return {...event,title:remote.name,description:remote.description||'',start:iso(remote.scheduledStartTimestamp),end:iso(remote.scheduledEndTimestamp),
      discord:{...event.discord,eventId:remote.id,status:remote.status,invite:remote.entityMetadata?.location,...(Number.isSafeInteger(remote.userCount)?{interested:remote.userCount}:{})}};
  }
  async remote(guild,discord) {
    const remote=await this.request(()=>guild.scheduledEvents.fetch({guildScheduledEvent:discord.eventId,force:true,withUserCount:true}));
    if(!this.owned(remote))throw fail('This event is no longer managed by uburoom.',409);
    return remote;
  }
  list(guild) {return this.request(()=>guild.scheduledEvents.fetch({cache:false,withUserCount:true}));}
  // A create whose receipt was lost is identified by its exact details, never guessed.
  match(remotes,event) {
    const found=[...remotes.values()].filter(remote=>this.owned(remote)&&remote.name===event.title&&(remote.description||'')===event.description&&
      remote.scheduledStartTimestamp===Date.parse(event.start)&&remote.scheduledEndTimestamp===Date.parse(event.end)&&remote.entityMetadata?.location===event.discord.invite);
    return found.length===1?found[0]:undefined;
  }
  create(guild,event,current) {
    return this.request(()=>guild.scheduledEvents.create({name:event.title,description:event.description||undefined,scheduledStartTime:event.start,scheduledEndTime:event.end,
      privacyLevel:GuildScheduledEventPrivacyLevel.GuildOnly,entityType:GuildScheduledEventEntityType.External,entityMetadata:{location:event.discord.invite}}),current);
  }
  edit(guild,event,current) {
    return this.request(()=>guild.scheduledEvents.edit(event.discord.eventId,{name:event.title,description:event.description,scheduledStartTime:event.start,scheduledEndTime:event.end,
      entityMetadata:{location:event.discord.invite}}),current);
  }
  relocate(guild,discord,invite) {return this.request(()=>guild.scheduledEvents.edit(discord.eventId,{entityMetadata:{location:invite}}),()=>!this.events.stopped);}
  // Ends Discord's copy; an event Discord already removed counts as ended.
  async cancel(guild,discord,current) {
    let remote;
    try{remote=await this.remote(guild,discord);}catch(error){if(error.code!==10070)throw error;}
    if(remote&&!ENDED.includes(remote.status)) {
      const status=remote.status===GuildScheduledEventStatus.Active?GuildScheduledEventStatus.Completed:GuildScheduledEventStatus.Canceled;
      await this.request(()=>guild.scheduledEvents.edit(discord.eventId,{status}),current);
    }
  }
  ended(remote) {return !remote||!this.owned(remote)||ENDED.includes(remote.status);}
  scheduled(remote) {return remote.status===GuildScheduledEventStatus.Scheduled;}
  close() {this.lifetime.abort();}
}
module.exports={DiscordEventSync};
