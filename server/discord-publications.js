'use strict';
const { randomBytes } = require('node:crypto');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { isHost } = require('./core');
const fail = (message, status = 503) => Object.assign(new Error(message), {status});
const PREFIX = 'discordPublication:';
const clean = (value, length = 256) => String(value || '').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,length);
const markdown = value => clean(value,256).replace(/([\\`*_{}\[\]()<>#+.!|~])/g,'\\$1');

// Discord is a projection of room state. It never participates in the playback
// tick or owns entry/media authorization. Persist message identities in the
// existing worker-backed metadata store, including uncertain create receipts.
class DiscordPublications {
  constructor(watch, registry) {
    this.watch = watch; this.hub = watch.hub; this.config = this.hub.config; this.registry = registry;
    this.records = new Map(registry.db.prepare('SELECT key,value FROM meta WHERE key LIKE ?').all(PREFIX+'%')
      .map(row => [row.key.slice(PREFIX.length),JSON.parse(row.value)]));
    this.lanes = new Map(); this.sent = new Map(); this.errors = new Map(); this.retryAt = 0; this.retries = new Map();
    this.timer = setInterval(() => {void this.reconcile();},5000); this.timer.unref();
  }
  canManage(record, actor) {return !actor.guestRoomId && (isHost(record,actor) || this.hub.isAdmin(actor));}
  getRecord(id) {try {return this.watch.roomState.store.get(id);} catch (error) {if(error.status!==404)throw error;}}
  async save(id, value) {
    this.watch.roomState.store.healthy();
    if (value) {this.records.set(id,value);this.registry.meta(PREFIX+id,JSON.stringify(value));}
    else {this.records.delete(id);this.sent.delete(id);this.errors.delete(id);this.retries.delete(id);this.registry.db.prepare('DELETE FROM meta WHERE key=?').run(PREFIX+id);}
    await this.registry.flush();
  }
  lane(id, action) {
    const previous=this.lanes.get(id) || Promise.resolve();
    const task=previous.catch(()=>{}).then(action);this.lanes.set(id,task);
    task.finally(()=>{if(this.lanes.get(id)===task)this.lanes.delete(id);}).catch(()=>{});
    return task;
  }
  async channel(channelId = this.config.shareChannelId, guildId = this.config.guildId) {
    const client=this.hub.discordClient;
    if (!client?.isReady()) throw fail('Discord is unavailable. Try again when the bot reconnects.');
    if (!channelId || Date.now()<this.retryAt) throw fail('Discord publishing is unavailable. Try again shortly.');
    const channel=await client.channels.fetch(channelId);
    if (channel?.guildId!==guildId || channel.type!==ChannelType.GuildText) throw fail('Choose a text channel in the configured Discord server.');
    const permissions=channel.permissionsFor(client.user);
    if (!permissions?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory])) {
      throw fail('The bot needs View Channel, Send Messages, Embed Links and Read Message History in the publishing channel.');
    }
    return channel;
  }
  preview(record) {
    const room=this.watch.rooms.get(record.id), recovering=this.watch.roomState.recoveries.has(record.id);
    const live=!!room && !room.removing;
    const viewers=new Set([...(room?.viewers.values() || [])].filter(v=>!v.watchSocket || v.watchSocket.readyState===1).map(v=>v.userId)).size;
    return {name:record.name,title:live?room.media?.title || 'Nothing selected':recovering?record.bookmark?.title || 'Nothing selected':'Nothing selected',
      subtitle:live?room.media?.subtitle || '':'',status:!live&&!recovering?'Closed':!live||room.reconnecting||room.mediaTransition||!room.media||room.media.unavailable||room.s.state.waitingForReady?'Waiting':room.s.state.paused?'Paused':'Playing',
      viewers,visibility:record.visibility,revision:record.revision,epoch:room?.s.epoch,invite:this.config.publicUrl+'/join/'+record.inviteCode};
  }
  payload(preview, closed = false) {
    const status=closed?'Closed':preview.status;
    return {content:'',allowedMentions:{parse:[]},embeds:[{title:clean(preview.name),color:closed?0x777777:0xff984f,
      description:closed?'This room is closed.':[markdown(preview.title),markdown(preview.subtitle)].filter(Boolean).join('\n'),
      fields:[{name:'Status',value:status,inline:true},{name:'Viewers',value:String(closed?0:preview.viewers),inline:true}],footer:{text:'uburoom'}}],
      components:closed?[]:[{type:1,components:[{type:2,style:5,label:'Join room',url:preview.invite}]}]};
  }
  async summary(id, actor) {
    const record=this.getRecord(id);if(!record)throw fail('Room unavailable',404);
    const publication=this.records.get(id), canManage=this.canManage(record,actor);
    const value={invite:{code:record.inviteCode,url:this.config.publicUrl+'/join/'+record.inviteCode},preview:this.preview(record),canManage,
      configured:!!this.config.shareChannelId||!!publication,canPublish:!!this.config.shareChannelId,published:!!publication?.active,hasPost:!!publication?.messageId,removing:!!publication?.remove,uncertain:!!publication&&!publication.messageId,
      messageUrl:publication?.messageId?`https://discord.com/channels/${publication.guildId}/${publication.channelId}/${publication.messageId}`:undefined};
    if (!canManage) return {...value,messageUrl:undefined,published:false,hasPost:false,removing:false,uncertain:false};
    if (publication?.channelName) value.channelName=publication.channelName;
    if (this.config.shareChannelId||publication) {
      try {value.channelName=(await this.channel(publication?.channelId||this.config.shareChannelId,publication?.guildId||this.config.guildId)).name;value.available=true;}
      catch (error) {value.available=false;value.error=this.safeError(error);}
    }
    if(this.errors.has(id))value.error=this.errors.get(id);
    return value;
  }
  safeError(error, subject = 'room post') {
    const wait=Number(error?.retryAfter || error?.timeToReset || error?.retry_after*1000);
    if(Number.isFinite(wait)&&wait>0)this.retryAt=Date.now()+Math.max(wait,1000);
    return error?.status && error.status<500 && error.message && !error.code ? error.message :
      error?.status===503?error.message:`Discord could not update the ${subject}. Check the bot and permissions, then try again.`;
  }
  async check(room, actor, permitted, revision) {
    if(actor.watchCurrent&&!await actor.watchCurrent())throw fail('Room access changed.',403);
    const id=room.s.roomId,record=this.getRecord(id);
    if (this.stopped || this.watch.shuttingDown || this.watch.rooms.get(id)!==room || room.removing || !permitted() || !record) throw fail('Room changed or command expired.',409);
    if (!this.canManage(record,actor)) throw fail('Only room hosts can publish or remove the post.',403);
    if (revision!==undefined && record.revision!==revision) throw fail('Room changed. Refresh the publication preview.',409);
    return record;
  }
  async command(room, action, actor, permitted, revision) {
    const id=room.s.roomId;
    return this.lane(id,async()=>{
      const record=await this.check(room,actor,permitted,revision);
      let publication=this.records.get(id);
      if(action==='room.unpublish') {
        if (!publication)return {status:'applied',message:'Room post removed.'};
        publication={...publication,active:false,remove:true};await this.save(id,publication);
        await this.update(id);
        return {status:'applied',message:'Room post removed.'};
      }
      if (!this.config.shareChannelId)throw fail('Discord room publishing is not configured.');
      const channel=await this.channel();await this.check(room,actor,permitted,revision);
      if(publication?.channelId!==undefined && (publication.channelId!==channel.id || publication.guildId!==this.config.guildId))throw fail('Remove the previous room post before publishing to the new channel.',409);
      if(publication&&!publication.messageId) {
        await this.recoverReceipt(id,channel);
        publication=this.records.get(id);
        if(!publication?.messageId)throw fail('The previous post could not be confirmed. Check Discord before retrying; no duplicate was posted.',409);
      }
      const preview=this.preview(record);
      if(publication?.messageId) {
        await this.check(room,actor,permitted,revision);
        try {await channel.messages.edit(publication.messageId,this.payload(preview));}
        catch(error){if(error.code===10008)await this.save(id,undefined);throw error;}
        await this.save(id,{...publication,active:true,remove:false,channelName:channel.name});
        this.sent.set(id,JSON.stringify(this.payload(preview)));
      } else {
        publication={guildId:this.config.guildId,channelId:channel.id,channelName:channel.name,active:true,nonce:randomBytes(12).toString('hex'),preview};
        await this.save(id,publication);
        // Recheck after durable intent, immediately before the external mutation.
        try {await this.check(room,actor,permitted,revision);}catch(error){await this.save(id,undefined);throw error;}
        try {
          const message=await channel.send({...this.payload(preview),nonce:publication.nonce,enforceNonce:true});
          await this.save(id,{...publication,messageId:message.id});
          this.sent.set(id,JSON.stringify(this.payload(preview)));
        } catch(error) {
          // A definite API refusal did not create a message. Timeouts and 5xx
          // remain uncertain and are never retried as fresh sends.
          if(error.status>=400&&error.status<500)await this.save(id,undefined);
          throw error;
        }
      }
      if(room.removing||this.watch.rooms.get(id)!==room) {
        const value=this.records.get(id);
        if(value)await this.save(id,{...value,active:false});
        await this.update(id);
        throw fail('The room closed while publishing. Its post is now closed.',409);
      }
      this.errors.delete(id);this.retries.delete(id);
      return {status:'applied',message:'Room published to Discord.'};
    }).catch(error=>{throw fail(this.safeError(error),error.status || 503);});
  }
  async removeSaved(id,actor,permitted) {
    return this.lane(id,async()=>{
      if(actor.watchCurrent&&!await actor.watchCurrent())throw fail('Room access changed.',403);
      const record=this.getRecord(id);
      if(this.stopped||!record||!permitted())throw fail('Room changed or command expired.',409);
      if(!this.canManage(record,actor))throw fail('Only room hosts can remove the post.',403);
      const publication=this.records.get(id);
      if(publication){await this.save(id,{...publication,active:false,remove:true});await this.update(id);}
      return {status:'applied',message:'Room post removed.'};
    }).catch(error=>{throw fail(this.safeError(error),error.status||503);});
  }
  async recoverReceipt(id, channel) {
    const publication=this.records.get(id);if(!publication||publication.messageId)return;
    const messages=await channel.messages.fetch({limit:100});
    const found=[...messages.values()].find(message=>message.author?.id===this.hub.discordClient.user.id && String(message.nonce)===publication.nonce);
    if(found)await this.save(id,{...publication,messageId:found.id});
  }
  roomClosed(id) {
    if(!this.records.has(id)||this.stopped)return;
    // Serialize the close intent with in-flight publication. A reopened room
    // cannot inherit the old active flag, even if Discord is offline.
    void this.lane(id,async()=>{const value=this.records.get(id);if(value)await this.save(id,{...value,active:false});await this.update(id);})
      .catch(error=>this.recordError(id,error));
  }
  async update(id, force = false) {
    let publication=this.records.get(id);if(!publication)return;
    const record=this.getRecord(id), room=this.watch.rooms.get(id);
    if(publication.active&&(!record || (!room&&!this.watch.roomState.recoveries.has(id)))) {
      publication={...publication,active:false};await this.save(id,publication);
    }
    const channel=await this.channel(publication.channelId,publication.guildId);
    if(!publication.messageId){await this.recoverReceipt(id,channel);publication=this.records.get(id);}
    if(!publication.messageId)throw fail('The room post could not be confirmed. Check Discord; no duplicate was posted.',409);
    if(publication.remove) {
      try {await channel.messages.delete(publication.messageId);}catch(error){if(error.code!==10008)throw error;}
      await this.save(id,undefined);this.sent.delete(id);this.errors.delete(id);return;
    }
    const payload=this.payload(record?this.preview(record):publication.preview,!publication.active);
    const signature=JSON.stringify(payload);
    if(!force&&this.sent.get(id)===signature)return;
    try {await channel.messages.edit(publication.messageId,payload);}
    catch(error){if(error.code===10008){await this.save(id,undefined);this.sent.delete(id);return;}throw error;}
    this.sent.set(id,signature);this.errors.delete(id);this.retries.delete(id);
    if(!record){await this.save(id,undefined);this.sent.delete(id);}
  }
  async reconcile() {
    if(this.stopped||!this.hub.discordClient?.isReady()||Date.now()<this.retryAt)return;
    await Promise.allSettled([...this.records.keys()].filter(id=>!this.lanes.has(id)&&Date.now()>=(this.retries.get(id)||0)).map(id=>this.lane(id,()=>this.update(id))
      .catch(error=>this.recordError(id,error))));
  }
  recordError(id,error) {this.errors.set(id,this.safeError(error));this.retries.set(id,Math.max(this.retryAt,Date.now()+30000));}
  async close() {this.stopped=true;clearInterval(this.timer);await Promise.allSettled([...this.lanes.values()]);}
}
module.exports = {DiscordPublications};
