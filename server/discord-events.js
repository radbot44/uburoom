'use strict';
const {randomUUID,createHash} = require('node:crypto');
const {PermissionFlagsBits,GuildScheduledEventEntityType,GuildScheduledEventPrivacyLevel,GuildScheduledEventStatus} = require('discord.js');
const {eventDetails} = require('./event-time');
const {discordRequest,retryDelay} = require('./discord-request');
const PREFIX='discordEvent:';
const fail=(message,status=503)=>Object.assign(new Error(message),{status});
const statuses={1:'Scheduled',2:'Active',3:'Completed',4:'Canceled'};
function details(event) {
  return {eventId:event.id,title:event.name,description:event.description||'',start:new Date(event.scheduledStartTimestamp).toISOString(),
    end:new Date(event.scheduledEndTimestamp).toISOString(),status:event.status,invite:event.entityMetadata?.location};
}
const version=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
class DiscordEvents {
  constructor(watch,registry) {
    this.watch=watch;this.hub=watch.hub;this.registry=registry;this.config=this.hub.config;
    this.records=new Map(registry.db.prepare('SELECT key,value FROM meta WHERE key LIKE ?').all(PREFIX+'%').map(row=>[row.key.slice(PREFIX.length),JSON.parse(row.value)]));
    this.lanes=new Map();this.errors=new Map();this.timer=setInterval(()=>{void this.reconcile();},30000);this.timer.unref();
    this.lifetime=new AbortController();this.cancelTimers=new Map();
  }
  async save(key,record) {
    this.watch.roomState.store.healthy();
    if(record){this.records.set(key,record);this.registry.meta(PREFIX+key,JSON.stringify(record));}
    else{this.records.delete(key);this.registry.db.prepare('DELETE FROM meta WHERE key=?').run(PREFIX+key);}
    await this.registry.flush();
  }
  lane(id,action) {
    const task=(this.lanes.get(id)||Promise.resolve()).catch(()=>{}).then(action);this.lanes.set(id,task);
    task.finally(()=>{if(this.lanes.get(id)===task)this.lanes.delete(id);}).catch(()=>{});return task;
  }
  async guild(guildId=this.config.guildId) {
    const client=this.hub.discordClient;
    if(!client?.isReady())throw fail('Discord is reconnecting. Try again shortly.');
    const guild=await client.guilds.fetch(guildId);
    const member=guild.members.me||await discordRequest(()=>guild.members.fetchMe(),{signal:this.lifetime.signal});
    if(!member.permissions.has(PermissionFlagsBits.CreateEvents))throw fail('The bot needs Create Events in the Discord server.');
    return guild;
  }
  async check(id,actor,permitted,revision) {
    if(actor.watchCurrent&&!await actor.watchCurrent())throw fail('Room access changed.',403);
    if(this.stopped||this.watch.shuttingDown||!permitted())throw fail('Event change expired. Refresh Share.',409);
    const record=this.watch.roomState.store.get(id);
    if(!this.watch.publications.canManage(record,actor))throw fail('Only room hosts can schedule or change Discord events.',403);
    if(revision!==undefined&&record.revision!==revision)throw fail('The room changed. Refresh Share before changing its event.',409);
    return record;
  }
  async remote(guild,record) {
    const event=await discordRequest(()=>guild.scheduledEvents.fetch({guildScheduledEvent:record.eventId,force:true}),{signal:this.lifetime.signal});
    if(event.creatorId!==this.hub.discordClient.user.id||event.entityType!==GuildScheduledEventEntityType.External)throw fail('This event is no longer managed by uburoom.',409);
    return event;
  }
  async recover(key,guild) {
    const record=this.records.get(key);if(!record||record.eventId)return;
    const events=await guild.scheduledEvents.fetch({cache:false});
    const matches=[...events.values()].filter(event=>event.creatorId===this.hub.discordClient.user.id&&event.entityType===GuildScheduledEventEntityType.External&&
      event.name===record.title&&event.scheduledStartTimestamp===Date.parse(record.start)&&event.scheduledEndTimestamp===Date.parse(record.end)&&event.entityMetadata?.location===record.invite&&
      (event.description||'')===record.description);
    if(matches.length===1)await this.save(key,{...record,...details(matches[0])});
  }
  async summary(id,actor) {
    return this.lane(id,()=>this.describe(id,actor));
  }
  async describe(id,actor) {
    const room=this.watch.roomState.store.get(id),canManage=this.watch.publications.canManage(room,actor);
    const value={configured:!!(this.config.guildId&&(this.config.botToken||this.hub.discordClient)),canManage,events:[]};
    if(!canManage||!value.configured)return value;
    let guild;
    try{guild=await this.guild();value.available=true;value.guildName=guild.name;}
    catch(error){value.available=false;value.error=this.watch.publications.safeError(error,'event');}
    for(const [key,initial] of this.records) {
      if(initial.roomId!==id)continue;
      let record=initial;
      if(guild&&record.guildId===guild.id) {
        try{
          if(!record.eventId)await this.recover(key,guild);
          record=this.records.get(key);
          if(record.eventId&&!record.cancel){const next={...record,...details(await this.remote(guild,record))};if(JSON.stringify(next)!==JSON.stringify(record))await this.save(key,next);record=next;}
        }catch(error){if(error.code===10070){await this.save(key,undefined);continue;}value.error=this.watch.publications.safeError(error,'event');}
      }
      value.events.push({...record,key,eventVersion:version(record),statusName:record.cancel?'Canceling…':record.eventId?statuses[record.status]||'Unavailable':'Unconfirmed',
        url:record.eventId?`https://discord.com/events/${record.guildId}/${record.eventId}`:undefined});
    }
    if(guild&&!value.error&&!value.events.some(event=>event.cancel))this.errors.delete(id);
    if(this.errors.has(id)&&!value.error)value.error=this.errors.get(id);
    value.events.sort((a,b)=>a.start.localeCompare(b.start));return value;
  }
  async command(id,command,actor,permitted) {
    return this.lane(id,async()=>{
      const {action,args}=command;
      const room=await this.check(id,actor,permitted,args.revision);
      const key=args.eventKey||randomUUID();let record=this.records.get(key);
      if(action!=='room.event.create'&&(!record||record.roomId!==id))throw fail('Event unavailable. Refresh Share.',404);
      const guild=await this.guild(record?.guildId);
      const latest=await this.check(id,actor,permitted,args.revision);
      const invite=this.config.publicUrl+'/join/'+latest.inviteCode;
      if(invite.length>100)throw fail('Discord event locations allow at most 100 characters. This server needs a shorter public URL.',400);
      if(action==='room.event.create') {
        if([...this.records.values()].some(item=>item.roomId===id&&!item.eventId))throw fail('A previous event could not be confirmed. Check Discord before scheduling another.',409);
        const planned=eventDetails(args);
        if([...this.records.values()].some(item=>item.roomId===id&&item.start===planned.start&&[1,2].includes(item.status)))throw fail('This room already has an event at that time. Edit the existing event.',409);
        record={roomId:id,guildId:guild.id,...planned,invite,status:GuildScheduledEventStatus.Scheduled};
        await this.save(key,record);
        try{await this.check(id,actor,permitted,args.revision);}catch(error){await this.save(key,undefined);throw error;}
        try{
          const event=await discordRequest(()=>guild.scheduledEvents.create({name:planned.title,description:planned.description||undefined,scheduledStartTime:planned.start,scheduledEndTime:planned.end,
            privacyLevel:GuildScheduledEventPrivacyLevel.GuildOnly,entityType:GuildScheduledEventEntityType.External,entityMetadata:{location:invite}}),{
            current:()=>this.check(id,actor,permitted,args.revision),signal:this.lifetime.signal});
          await this.save(key,{...record,...details(event)});
        }catch(error){if(error.status>=400&&error.status<500)await this.save(key,undefined);throw error;}
      } else {
        if(!record.eventId)throw fail('The event could not be confirmed. Check Discord before changing it.',409);
        if(action==='room.event.cancel') {
          await this.check(id,actor,permitted);
          await this.save(key,{...record,cancel:true});
          try{await this.cancel(key,guild,()=>this.check(id,actor,permitted));}
          catch(error){
            if(!retryDelay(error))throw error;
            this.retryCancellation(key,id,retryDelay(error));
            return {status:'applied',message:'Canceling event…'};
          }
          return {status:'applied',message:'Discord event canceled.'};
        }
        const event=await this.remote(guild,record),current={...record,...details(event)};
        if(version(current)!==args.eventVersion)throw fail('The Discord event changed. Refresh Share before editing it.',409);
        if(event.status!==GuildScheduledEventStatus.Scheduled)throw fail('This event has already started. Open it in Discord.',409);
        const planned=action==='room.event.edit'?eventDetails(args):undefined;
        await this.check(id,actor,permitted,args.revision);
        if(planned) {
          const updated=await discordRequest(()=>guild.scheduledEvents.edit(record.eventId,{name:planned.title,description:planned.description,scheduledStartTime:planned.start,scheduledEndTime:planned.end,entityMetadata:{location:invite}}),{
            current:()=>this.check(id,actor,permitted,args.revision),signal:this.lifetime.signal});
          await this.save(key,{...record,...planned,...details(updated)});
        }
      }
      this.errors.delete(id);
      return {status:'applied',message:action==='room.event.cancel'?'Discord event canceled.':action==='room.event.edit'?'Discord event updated.':'Discord event scheduled.'};
    }).catch(error=>{throw fail(this.watch.publications.safeError(error,'event'),error.status||503);});
  }
  async cancel(key,guild,current=()=>!this.stopped) {
    const record=this.records.get(key);if(!record)return;
    let event;
    try{event=await this.remote(guild,record);}catch(error){if(error.code!==10070)throw error;}
    if(event&&[GuildScheduledEventStatus.Scheduled,GuildScheduledEventStatus.Active].includes(event.status)) {
      await discordRequest(()=>guild.scheduledEvents.edit(record.eventId,{status:event.status===GuildScheduledEventStatus.Active?GuildScheduledEventStatus.Completed:GuildScheduledEventStatus.Canceled}),{current,signal:this.lifetime.signal});
    }
    await this.save(key,undefined);clearTimeout(this.cancelTimers.get(key));this.cancelTimers.delete(key);
  }
  retryCancellation(key,id,wait) {
    clearTimeout(this.cancelTimers.get(key));
    const timer=setTimeout(()=>{
      this.cancelTimers.delete(key);
      if(this.stopped)return;
      void this.lane(id,async()=>{const record=this.records.get(key);if(record?.cancel)await this.cancel(key,await this.guild(record.guildId));})
        .catch(error=>{if(retryDelay(error))this.retryCancellation(key,id,retryDelay(error));else this.errors.set(id,this.watch.publications.safeError(error,'event'));});
    },Math.max(wait,1000)+50);
    timer.unref();this.cancelTimers.set(key,timer);
  }
  async reconcile() {
    if(this.stopped||!this.hub.discordClient?.isReady())return;
    const rooms=new Set([...this.records.values()].map(record=>record.roomId));
    await Promise.allSettled([...rooms].filter(id=>!this.lanes.has(id)).map(id=>this.lane(id,async()=>{
      let room;try{room=this.watch.roomState.store.get(id);}catch(error){if(error.status!==404)throw error;}
      for(const [key,initial] of this.records) {
        if(initial.roomId!==id)continue;
        const guild=await this.guild(initial.guildId);
        if(!initial.eventId)await this.recover(key,guild);
        const record=this.records.get(key);if(!record.eventId)continue;
        if(record.cancel){try{await this.cancel(key,guild);}catch(error){if(retryDelay(error))this.retryCancellation(key,id,retryDelay(error));else throw error;}continue;}
        let event;try{event=await this.remote(guild,record);}catch(error){if(error.code===10070){await this.save(key,undefined);continue;}throw error;}
        if([GuildScheduledEventStatus.Completed,GuildScheduledEventStatus.Canceled].includes(event.status)){await this.save(key,undefined);continue;}
        // A room closing does not cancel a future watch night. A permanently
        // deleted room leaves its event in Discord for the owner to manage.
        if(!room){await this.save(key,undefined);continue;}
        const invite=this.config.publicUrl+'/join/'+room.inviteCode;
        if(event.entityMetadata?.location!==invite&&invite.length<=100)event=await discordRequest(()=>guild.scheduledEvents.edit(record.eventId,{entityMetadata:{location:invite}}),{signal:this.lifetime.signal,current:()=>!this.stopped});
        const next={...record,...details(event)};if(JSON.stringify(next)!==JSON.stringify(record))await this.save(key,next);
      }
      this.errors.delete(id);
    }).catch(error=>this.errors.set(id,this.watch.publications.safeError(error,'event')))));
  }
  async close(){this.stopped=true;this.lifetime.abort();clearInterval(this.timer);for(const timer of this.cancelTimers.values())clearTimeout(timer);await Promise.allSettled([...this.lanes.values()]);}
}
module.exports={DiscordEvents};
