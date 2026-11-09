'use strict';
const {randomUUID,createHash} = require('node:crypto');
const RoomPolicy = require('./room-policy');
const Engine = require('../shared/engine');
const {eventDetails} = require('./event-time');
const {retryDelay} = require('./discord-request');
const {DiscordEventSync} = require('./discord-events');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const iso=at=>new Date(at).toISOString();
const MAX_UPCOMING=20;
const version=({title,description,start,end})=>createHash('sha256').update(JSON.stringify({title,description,start,end})).digest('hex');
const applied=message=>({status:'applied',message});

// Scheduled watch nights. Each belongs to one saved room, is seen by whoever can
// see that room, keeps the room from cleanup until it ends and leaves the lobby
// at its end time. Posting to Discord is optional and mirrors the event.
// Changes run through the shared command engine, one lane per room.
class RoomEvents {
  constructor(watch,registry) {
    this.watch=watch;this.hub=watch.hub;this.config=this.hub.config;this.registry=registry;this.db=registry.db;
    this.lanes=new Map();this.errors=new Map();this.cancelTimers=new Map();
    this.discord=new DiscordEventSync(this);
    this.timer=setInterval(()=>{void this.reconcile();},30000);this.timer.unref();
  }
  get store() {return this.watch.roomState.store;}
  decode(row) {return row&&{...row,discord:row.discord?JSON.parse(row.discord):null};}
  get(key) {return this.decode(this.db.prepare('SELECT * FROM watch_room_events WHERE id=?').get(key));}
  forRoom(roomId,now=Date.now()) {return this.db.prepare('SELECT * FROM watch_room_events WHERE roomId=? AND end>? ORDER BY start,id').all(roomId,iso(now)).map(row=>this.decode(row));}
  upcoming(roomId,now=Date.now()) {return !!this.db.prepare('SELECT 1 FROM watch_room_events WHERE roomId=? AND end>? LIMIT 1').get(roomId,iso(now));}
  async save(event) {
    this.store.healthy();
    this.db.prepare(`INSERT INTO watch_room_events(id,roomId,creatorId,title,description,start,end,timeZone,state,createdAt,updatedAt,discord) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,start=excluded.start,end=excluded.end,timeZone=excluded.timeZone,
      state=excluded.state,updatedAt=excluded.updatedAt,discord=excluded.discord`).run(event.id,event.roomId,event.creatorId,event.title,event.description,event.start,event.end,
      event.timeZone,event.state,event.createdAt,event.updatedAt,event.discord?JSON.stringify(event.discord):null);
    await this.registry.flush();
  }
  async remove(key) {
    this.store.healthy();clearTimeout(this.cancelTimers.get(key));this.cancelTimers.delete(key);
    this.db.prepare('DELETE FROM watch_room_events WHERE id=?').run(key);await this.registry.flush();
  }
  lane(id,action) {
    const task=(this.lanes.get(id)||Promise.resolve()).catch(()=>{}).then(action);this.lanes.set(id,task);
    task.finally(()=>{if(this.lanes.get(id)===task)this.lanes.delete(id);}).catch(()=>{});return task;
  }
  room(id) {try{return this.store.get(id);}catch(error){if(error.status!==404)throw error;}}
  visible(record,actor) {
    if(actor.guestRoomId)return actor.guestRoomId===record.id;
    return this.hub.isAdmin(actor)||record.visibility==='public'||RoomPolicy.admitted(record,actor.userId);
  }
  canManage(record,actor) {return this.watch.publications.canManage(record,actor);}
  canSchedule(actor) {return !actor.guestRoomId&&!!this.hub.canScheduleEvents?.(actor);}
  safeError(error) {return this.watch.publications.safeError(error,'event');}
  present(event,record,actor,now=Date.now()) {
    const manage=this.canManage(record,actor),discord=event.discord;
    return {key:event.id,roomId:record.id,roomName:record.name,roomSlug:record.slug,title:event.title,description:event.description,start:event.start,end:event.end,
      timeZone:event.timeZone,live:Date.parse(event.start)<=now,canceling:event.state==='canceling',canManage:manage,canEdit:manage&&this.canSchedule(actor),
      eventVersion:version(event),invite:manage?this.config.publicUrl+'/join/'+record.inviteCode:undefined,
      discord:discord?{confirmed:!!discord.eventId,status:discord.status,interested:discord.interested??null,url:this.discord.url(discord)}:null};
  }
  // Lobby: every upcoming or live event in a room this person can see.
  async lobby(actor,current) {
    await this.watch.roomState.eligible(actor,current);
    const now=Date.now(),rooms=new Map(),events=[];
    for(const row of this.db.prepare("SELECT * FROM watch_room_events WHERE end>? AND state='scheduled' ORDER BY start,id").all(iso(now))) {
      if(!rooms.has(row.roomId))rooms.set(row.roomId,this.room(row.roomId));
      const record=rooms.get(row.roomId);
      if(record&&this.visible(record,actor))events.push(this.present(this.decode(row),record,actor,now));
    }
    if(!await current())throw fail('Room access changed',403);
    return {events,canSchedule:this.canSchedule(actor),discord:{configured:this.discord.configured(),available:this.discord.ready()}};
  }
  // One room's events, refreshed from Discord for its hosts.
  async summary(id,actor) {
    return this.lane(id,async()=>{
      const record=this.store.get(id),canManage=this.canManage(record,actor);
      const value={configured:this.discord.configured(),canManage,canSchedule:canManage&&this.canSchedule(actor),events:[]};
      if(!this.visible(record,actor))return value;
      if(canManage&&value.configured) {
        try{const guild=await this.discord.guild();value.available=true;value.guildName=guild.name;await this.sync(id,record,guild,{finish:false});}
        catch(error){value.available??=false;value.error=this.safeError(error);}
      }
      if(this.errors.has(id)&&!value.error)value.error=this.errors.get(id);
      value.events=this.forRoom(id).map(event=>{
        const shown=this.present(event,record,actor),discord=event.discord;
        // Fields read by the Share dialog until scheduling moves out of it.
        return {...shown,cancel:shown.canceling,eventId:discord?.eventId,status:discord?.status,url:shown.discord?.url,
          statusName:shown.canceling?'Canceling…':!discord?'Scheduled':discord.eventId?{1:'Scheduled',2:'Active',3:'Completed',4:'Canceled'}[discord.status]||'Unavailable':'Unconfirmed'};
      });
      return value;
    });
  }
  async check(id,actor,permitted,scheduling=true) {
    if(actor.watchCurrent&&!await actor.watchCurrent())throw fail('Room access changed.',403);
    if(this.stopped||this.watch.shuttingDown||!permitted())throw fail('Event change timed out. Try again.',409);
    const record=this.store.get(id);
    if(!this.canManage(record,actor))throw fail('Only room hosts can schedule or change events.',403);
    if(scheduling&&!this.canSchedule(actor))throw fail('Scheduling events is limited on this server.',403);
    return record;
  }
  async command(id,command,actor,permitted) {
    return this.lane(id,async()=>{
      const {action,args}=command,now=Date.now(),current=()=>this.check(id,actor,permitted,action!=='room.event.cancel');
      let record=await current();
      if(action==='room.event.create') {
        const planned=eventDetails(args),events=this.forRoom(id,now),posting=args.discord!==false;
        if(events.length>=MAX_UPCOMING)throw fail(`A room can have at most ${MAX_UPCOMING} upcoming events.`,409);
        if(posting&&events.some(event=>event.discord&&!event.discord.eventId))throw fail('A previous event could not be confirmed. Check Discord before scheduling another.',409);
        const event={id:randomUUID(),roomId:id,creatorId:this.store.account(actor.userId),...planned,state:'scheduled',createdAt:now,updatedAt:now,discord:null};
        if(!posting){await current();await this.save(event);return applied('Event scheduled.');}
        const guild=await this.discord.guild();record=await current();
        event.discord={guildId:guild.id,invite:this.discord.invite(record)};
        await this.save(event);
        try{await current();}catch(error){await this.remove(event.id);throw error;}
        try{await this.save(this.discord.merge(event,await this.discord.create(guild,event,current)));}
        catch(error){if(error.status>=400&&error.status<500)await this.remove(event.id);throw error;}
        this.errors.delete(id);return applied('Event scheduled and posted to Discord.');
      }
      let event=this.get(args.eventKey);
      if(!event||event.roomId!==id||Date.parse(event.end)<=now||event.state==='canceling'&&action!=='room.event.cancel')throw fail('Event unavailable. Refresh and try again.',404);
      if(event.discord&&!event.discord.eventId)throw fail('The event could not be confirmed. Check Discord before changing it.',409);
      if(action==='room.event.cancel') {
        if(!event.discord||!this.discord.configured()){await current();await this.remove(event.id);return applied('Event canceled.');}
        const guild=await this.discord.guild(event.discord.guildId);await current();
        event={...event,state:'canceling',updatedAt:now};await this.save(event);
        try{await this.finishCancel(event,guild,current);}
        catch(error){
          if(!retryDelay(error))throw error;
          this.retryCancellation(event.id,id,retryDelay(error));return applied('Canceling event…');
        }
        this.errors.delete(id);return applied('Event canceled.');
      }
      const planned=eventDetails(args),posting=args.discord??!!event.discord;
      const guild=event.discord||posting?await this.discord.guild(event.discord?.guildId):undefined;
      if(event.discord) {
        const remote=await this.discord.remote(guild,event.discord);
        event=this.discord.merge(event,remote);
        if(!this.discord.scheduled(remote))throw fail('This event has already started. Open it in Discord.',409);
      }
      if(version(event)!==args.eventVersion)throw fail('The event changed. Refresh before editing it.',409);
      record=await current();
      let next={...event,...planned,updatedAt:now};
      if(event.discord&&posting)next=this.discord.merge(next,await this.discord.edit(guild,{...next,discord:{...next.discord,invite:this.discord.invite(record)}},current));
      else if(event.discord){await this.discord.cancel(guild,event.discord,current);next.discord=null;}
      else if(posting) {
        next.discord={guildId:guild.id,invite:this.discord.invite(record)};await this.save(next);
        try{next=this.discord.merge(next,await this.discord.create(guild,next,current));}
        catch(error){if(error.status>=400&&error.status<500)await this.save({...next,discord:null});throw error;}
      }
      await this.save(next);this.errors.delete(id);return applied('Event updated.');
    }).catch(error=>{throw fail(this.safeError(error),error.status||503);});
  }
  // Lobby scheduling, optionally into a new closed room named after the event.
  async schedule(actor,data,current) {
    const create=roomId=>this.hub.dispatch({...actor,watchCurrent:current},{roomId,action:'room.event.create',args:data});
    if(data?.room!=='new')return typeof data?.room==='string'?create(data.room):{status:'failed',message:'Choose a room.',httpStatus:400};
    if(this.config.singleRoom)return {status:'forbidden',message:'Room creation is disabled in single-room mode.',httpStatus:403};
    if(!this.canSchedule(actor))return {status:'forbidden',message:'Scheduling events is limited on this server.',httpStatus:403};
    // Check the form before creating a room so a mistake never leaves one behind.
    try{eventDetails(Engine.validate({action:'room.event.create',args:data}).args);}catch(error){return {status:'failed',message:error.message,httpStatus:400};}
    const roomId=await this.watch.roomState.createClosed(actor,{name:data.title.trim(),isCustom:true},current);
    const outcome=await create(roomId);
    // An unconfirmed Discord post keeps its event, which keeps the room.
    if(outcome.status!=='applied')await this.watch.roomState.deleteEmpty(roomId);
    return {...outcome,roomId};
  }
  async finishCancel(event,guild,current) {await this.discord.cancel(guild,event.discord,current);await this.remove(event.id);}
  retryCancellation(key,id,wait) {
    clearTimeout(this.cancelTimers.get(key));
    const timer=setTimeout(()=>{
      this.cancelTimers.delete(key);
      if(this.stopped)return;
      void this.lane(id,async()=>{const event=this.get(key);if(event?.state==='canceling')await this.finishCancel(event,await this.discord.guild(event.discord.guildId));})
        .catch(error=>{if(retryDelay(error))this.retryCancellation(key,id,retryDelay(error));else this.errors.set(id,this.safeError(error));});
    },Math.max(wait,1000)+50);
    timer.unref();this.cancelTimers.set(key,timer);
  }
  // Brings one room's posted events in step with Discord: recovers lost create
  // receipts, finishes cancellations, follows invite rerolls and reads back edits
  // and interested counts. An event canceled or deleted in Discord ends here too.
  async sync(id,record,guild,{finish=true}={}) {
    const linked=this.forRoom(id).filter(event=>event.discord?.guildId===guild.id);
    if(!linked.length)return;
    const remotes=await this.discord.list(guild),invite=this.discord.location(record);
    for(const event of linked) {
      if(!event.discord.eventId){const found=this.discord.match(remotes,event);if(found)await this.save(this.discord.merge(event,found));continue;}
      if(event.state==='canceling'){
        if(!finish)continue;
        try{await this.finishCancel(event,guild);}catch(error){if(retryDelay(error))this.retryCancellation(event.id,id,retryDelay(error));else throw error;}
        continue;
      }
      let remote=remotes.get(event.discord.eventId);
      if(this.discord.ended(remote)){await this.remove(event.id);continue;}
      if(remote.entityMetadata?.location!==invite&&invite.length<=100)remote=Object.assign(await this.discord.relocate(guild,event.discord,invite),{userCount:remote.userCount});
      const next=this.discord.merge(event,remote);
      if(JSON.stringify(next)!==JSON.stringify(event))await this.save({...next,updatedAt:Date.now()});
    }
  }
  async reconcile() {
    if(this.stopped)return;
    const now=iso(Date.now());
    // Ended watch nights leave the lobby; Discord ends its own copy at the end time.
    const ended=this.db.prepare('SELECT id,roomId FROM watch_room_events WHERE end<=?').all(now);
    const rooms=new Set(this.db.prepare('SELECT DISTINCT roomId FROM watch_room_events WHERE discord IS NOT NULL AND end>?').all(now).map(row=>row.roomId));
    await Promise.allSettled([...ended.map(row=>this.lane(row.roomId,()=>this.remove(row.id))),
      ...(this.discord.ready()?[...rooms].filter(id=>!this.lanes.has(id)).map(id=>this.lane(id,async()=>{
        const record=this.room(id);if(!record)return;
        await this.sync(id,record,await this.discord.guild());this.errors.delete(id);
      }).catch(error=>this.errors.set(id,this.safeError(error)))):[])]);
  }
  async close() {
    this.stopped=true;this.discord.close();clearInterval(this.timer);
    for(const timer of this.cancelTimers.values())clearTimeout(timer);
    await Promise.allSettled([...this.lanes.values()]);
  }
}
module.exports={RoomEvents,version};
