'use strict';
const {ChannelType} = require('discord.js');
// Provider boundary fixture: keeps remote messages across local app restarts.
function discordChannel(config) {
  const messages=new Map(), calls=[];let sequence=100;
  const missing=()=>Object.assign(new Error('Unknown message'),{code:10008,status:404});
  function limit(value) {if(value?.remaining>0){value.remaining--;throw Object.assign(new Error('Fixture rate limit'),{name:'RateLimitError',retryAfter:value.wait});}}
  const channel={id:config.shareChannelId,guildId:config.guildId,name:'watch-together',type:ChannelType.GuildText,permitted:true,
    permissionsFor:()=>({has:()=>channel.permitted}),
    async send(payload) {
      calls.push({method:'send',payload:structuredClone(payload)});
      if(channel.beforeSend)await channel.beforeSend();
      const id=String(++sequence),message={...structuredClone(payload),id,author:{id:'fixture-bot'}};
      messages.set(id,message);
      if(channel.loseReceipt){channel.loseReceipt=false;throw new TypeError('Fixture response lost after creation');}
      return message;
    },
    messages:{
      async fetch(){return messages;},
      async edit(id,payload){calls.push({method:'edit',id,payload:structuredClone(payload)});if(!messages.has(id))throw missing();Object.assign(messages.get(id),structuredClone(payload));return messages.get(id);},
      async delete(id){calls.push({method:'delete',id});limit(channel.deleteRateLimit);if(!messages.delete(id))throw missing();}
    }};
  const client={user:{id:'fixture-bot'},isReady:()=>!channel.offline,channels:{fetch:async id=>{
    if(channel.beforeFetch)await channel.beforeFetch();
    if(id!==channel.id)throw new Error('Unexpected fixture channel');return channel;
  }}};
  const events=new Map();channel.eventPermitted=true;
  const guild={id:config.guildId,name:'Fixture server',members:{fetchMe:async()=>{guild.members.me={permissions:{has:()=>channel.eventPermitted}};return guild.members.me;}},scheduledEvents:{
    async fetch(options={}) {
      if(channel.beforeEventFetch)await channel.beforeEventFetch();
      if(!options.guildScheduledEvent)return events;
      const event=events.get(options.guildScheduledEvent);if(!event)throw Object.assign(new Error('Unknown event'),{code:10070,status:404});return event;
    },
    async create(payload) {
      calls.push({method:'event-create',payload:structuredClone(payload)});
      const id=String(++sequence),event={id,name:payload.name,description:payload.description||'',scheduledStartTimestamp:Date.parse(payload.scheduledStartTime),scheduledEndTimestamp:Date.parse(payload.scheduledEndTime),
        entityMetadata:payload.entityMetadata,entityType:payload.entityType,status:1,creatorId:client.user.id};
      events.set(id,event);if(channel.loseEventReceipt){channel.loseEventReceipt=false;throw new TypeError('Fixture event response lost');}return event;
    },
    async edit(id,payload) {
      calls.push({method:'event-edit',id,payload:structuredClone(payload)});limit(channel.eventRateLimit);const event=events.get(id);if(!event)throw Object.assign(new Error('Unknown event'),{code:10070,status:404});
      for(const [key,value] of Object.entries(payload)) {
        if(key==='scheduledStartTime')event.scheduledStartTimestamp=Date.parse(value);
        else if(key==='scheduledEndTime')event.scheduledEndTimestamp=Date.parse(value);
        else event[key]=structuredClone(value);
      }return event;
    }
  }};
  client.guilds={fetch:async id=>{if(id!==guild.id)throw new Error('Unexpected fixture guild');return guild;}};
  return {channel,client,messages,events,guild,calls,attach:hub=>{hub.discordClient=client;}};
}
module.exports={discordChannel};
