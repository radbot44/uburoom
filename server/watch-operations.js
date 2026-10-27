// @ts-check
'use strict';
const { UUID, hash } = require('./core');
const { randomUUID } = require('node:crypto');
const RoomPolicy = require('./room-policy');
const { PlaybackError } = require('./av1');
const { ObservationError } = require('./playback-tracking');
const { clientAddress } = require('./plex-delivery');

// Transport-neutral operations return values; HTTP resources and socket framing
// belong to their respective transports. Epochs and authorization stay here.
function watchOperations({ config, watch, hub, authorized, login, mediaGrant, cookies, throttle, registry, clockEpoch, delivery, validGrant }) {
  const result = (status, value) => ({ status, value });
  /**
   * @param {{headers: Object, controlSocket?: {readyState: number}}} context Auth credentials and optional live connection.
   * @param {string} path Allowlisted operation path and query.
   * @param {Object} [data] Validated mutation input; absence selects a read.
   */
  async function execute(context, path, data) {
    const url = new URL(path, config.publicUrl), write = data !== undefined;
    const serverReceivedAt = Date.now(), receivedMono = performance.now();
    try {
      if (write && (!data || typeof data !== 'object' || Array.isArray(data) || Buffer.byteLength(JSON.stringify(data)) > 4096)) return result(400, { error: 'Invalid command data' });
      const auth = await authorized(context, !!context.controlSocket || write);
      if (!auth) return result(401, { error: 'Log in with Discord' });
      watch.roomState?.people.enter(auth.actor.userId);
      if (registry) {
        if (context.controlSocket) hub.directory?.connected(context.controlSocket,auth.actor.userId);
        await watch.roomState?.claimHosts(auth.actor.userId);
      }
      await hub.refreshAdmin?.(auth.actor);
      const current = async () => (!context.controlSocket || context.controlSocket.readyState === 1) && (await login(context))?.userId === auth.actor.userId;
      const opened = async id => {
        if(data.viewerId===undefined)return result(200,{id});
        if(!UUID.test(data.viewerId))return result(400,{error:'Invalid viewer'});
        const query=new URLSearchParams({viewer:data.viewerId,quality:data.quality||'720p4'});if(data.delivery==='local')query.set('delivery','local');
        if(data.subtitles==='browser')query.set('subtitles','browser');
        if(data.volume!==undefined)query.set('volume',String(data.volume));
        if(data.muted!==undefined)query.set('muted',String(data.muted));
        const subscription='/api/watch/rooms/'+id+'?'+query;
        const joined=await execute(context,subscription);
        return joined.status===200?{status:200,value:{id,state:joined.value},subscription}:joined;
      };
      if (url.pathname === '/api/rooms' && !write) return result(200, { rooms: await hub.list(auth.actor) });
      if (url.pathname === '/api/command' && write) {
        if (!throttle('command:' + auth.actor.userId, 120)) return result(429, { error: 'Too many commands; try again shortly' });
        if (Object.hasOwn(data, 'sessionId') || !UUID.test(data.roomId || '')) return result(400, { error: 'Select a room' });
        return result(200, await hub.dispatch({...auth.actor,watchCurrent:current}, { ...data.command, roomId: data.roomId }));
      }
      if (!write && url.pathname === '/api/watch/me') {
        return result(200, { name: auth.actor.name,owner:hub.isOwner(auth.actor),adminEligible:hub.canAdmin(auth.actor),adminMode:hub.isAdmin(auth.actor),durableRooms:!!watch.roomState,roomLimits:watch.roomState?.limits,singleRoom:!!config.singleRoom,roomPermissionDefaults:RoomPolicy.policy(config.roomPermissions),csrf:auth.identity.csrf,account:registry?.summary(auth.actor.userId) });
      }
      if (write && url.pathname === '/api/watch/profile' && registry) {
        if (!throttle('profile-name:'+auth.actor.userId,20)) return result(429,{error:'Too many name changes; try again shortly'});
        const account = await hub.renameAccount(auth.actor.userId,data.name);
        return result(200,{name:account.name});
      }
      if (write && url.pathname === '/api/watch/admin-mode') {
        if (!hub.canAdmin(auth.actor) || typeof data.enabled !== 'boolean') {return result(403,{error:'Only an authorized administrator can change Admin mode'});}
        hub.setAdminMode(auth.actor, data.enabled); return result(200,{adminMode:hub.isAdmin(auth.actor)});
      }
      if (!write && ['/api/watch/library','/api/watch/library/item','/api/watch/library/availability', '/api/watch/library/filters','/api/watch/library/art'].includes(url.pathname)) {
        const room = watch.rooms.get(url.searchParams.get('room'));
        const lobby = !url.searchParams.has('room') && !url.searchParams.has('session');
        const eligible = async () => (lobby || room && watch.rooms.get(room.s.roomId) === room && await watch.canView(room, auth.actor)) && (await login(context))?.userId === auth.actor.userId;
        if (!await eligible()) { return result(403, { error: 'Library access requires room access' }); }
        const plex=hub.plexFor?await hub.plexFor(auth.actor):watch.plex;
        const scopeCurrent=async()=>!hub.plexFor||(await hub.plexFor(auth.actor)).principal===plex.principal;
        const itemVisible=async()=>plex.principal==='discord-shared'||!hub.plexFor||await plex.visible(url.searchParams.get('item'),url.searchParams.get('type'));
        let data;
        if (url.pathname.endsWith('/art')) {
          const art = await plex.artwork(url.searchParams.get('item'), url.searchParams.get('kind') || 'poster', url.searchParams.get('type'));
          if (!await eligible()||!await scopeCurrent()||!await itemVisible()) { return result(403, {error:'Library access was revoked'}); }
          return { status: 200, resource: art };
        } else if (url.pathname.endsWith('/availability')) {
          const ids=(url.searchParams.get('items') || '').split(',');
          if (ids.length>80 || ids.some(id=>!/^\d{1,20}$/.test(id))) return result(400,{error:'Select between 1 and 80 Plex items'});
          data={items:[...await plex.availability(ids)].map(([id,available])=>({id,available}))};
        } else if (url.pathname.endsWith('/item')) data = { item:await plex.details(url.searchParams.get('item'),url.searchParams.get('type')) };
        else if (url.pathname.endsWith('/filters')) data = await plex.filters(url.searchParams.get('section'));
        else {
          const query = Object.fromEntries(['section','parent','collection','tab','q','genre','year','sort','order','offset','seed'].filter(key => url.searchParams.has(key)).map(key => [key,url.searchParams.get(key)]));
          data = plex.configured ? await plex.browse(query) : {items:[],total:0,offset:0,nextOffset:null};
          data.testVideo = !!watch.demoMedia;
        }
        if (!await eligible()||!await scopeCurrent()||url.pathname.endsWith('/item')&&!await itemVisible()) { return result(403, {error:'Library access was revoked'}); }
        return result(200, data);
      }
      if (url.pathname === '/api/watch/playback' && !write) {
        return result(200,watch.tracking.history(auth.actor.userId));
      }
      if (url.pathname === '/api/watch/rooms/saved' && !write) {
        if (!watch.roomState) return result(200,{rooms:[],total:0});
        await watch.roomState.eligible(auth.actor,current);
        return result(200,watch.roomState.list(auth.actor,{offset:Number(url.searchParams.get('offset') || 0)}));
      }
      if (url.pathname === '/api/watch/rooms') {
        if(config.singleRoom){
          if(write)return result(403,{error:'Room creation is disabled in single-room mode'});
          await watch.roomState.ensureSingle(auth.actor,current);
        }
        return write ? result(201, { id: watch.roomState ? await watch.roomState.create(auth.actor,data,current) : watch.create(auth.actor, data.visibility) }) : result(200, { rooms: await watch.list(auth.actor, auth.identity.activity === true) });
      }
      const match = /^\/api\/watch\/rooms\/([a-f0-9-]{36})(?:\/(command|close|leave|ready|observe|delivery|reopen|settings|queue|history|people))?$/.exec(url.pathname);
      if (!match || !UUID.test(match[1])) { return result(404, { error: 'Room unavailable' }); }
      if(config.singleRoom&&match[1]!==registry.meta('singleRoomId'))return result(403,{error:'Only the configured shared room is available'});
      if (watch.roomState && match[2] === 'reopen' && write) {
        if(data.viewerId!==undefined&&!UUID.test(data.viewerId))return result(400,{error:'Invalid viewer'});
        return opened(await watch.roomState.reopen(match[1],auth.actor,current));
      }
      if (watch.roomState && match[2] === 'people' && !write) {
        if (!throttle('room-people:'+auth.actor.userId,120)) return result(429,{error:'Too many searches'});
        const check = async () => {
          await watch.roomState.eligible(auth.actor,current); await watch.roomState.metadata(match[1],auth.actor);
          const room = watch.roomState.store.get(match[1]);
          if (!hub.isAdmin(auth.actor) && !RoomPolicy.allowed(room,auth.actor.userId,'addHosts')) throw Object.assign(new Error('Add hosts permission required'),{status:403});
          return room;
        };
        const room = await check();
        const members = [...(watch.rooms.get(room.id)?.viewers.values() || [])].filter(v=>!v.watchSocket || v.watchSocket.readyState===1).map(v=>v.userId);
        const found = await hub.directory.search(url.searchParams.get('q') || '',{members,hosts:room.hosts,creatorId:room.creatorId,allHosts:room.permissions.allHosts,pending:watch.roomState.store.pendingHosts(room.id)});
        const latest = await check();
        if (latest.revision !== room.revision) return result(409,{error:'Room changed; search again'});
        return result(200,found);
      }
      if (watch.roomState && match[2] === 'settings') {
        if (write) {
          if (!throttle('room-settings:' + auth.actor.userId,60)) return result(429,{error:'Too many room changes'});
          return result(200,await watch.roomState.edit(match[1],auth.actor,data.revision,data.change,current));
        }
        await watch.roomState.eligible(auth.actor,current);
        await watch.roomState.metadata(match[1],auth.actor);
        if (!await current()) return result(403,{error:'Room access changed'});
        return result(200,watch.roomState.summary(match[1],auth.actor));
      }
      if (watch.roomState && match[2] === 'queue') {
        await watch.roomState.eligible(auth.actor, current);
        await watch.roomState.metadata(match[1], auth.actor);
        if (!await current()) return result(403, { error: 'Room access changed' });
        const room = watch.rooms.get(match[1]);
        if (room && !await watch.canView(room, auth.actor)) return result(403, { error: 'Room unavailable or private' });
        if (write) {
          if (!throttle('room-queue:' + auth.actor.userId, 60)) return result(429, { error: 'Too many queue operations' });
          if (!data || typeof data !== 'object') return result(400, { error: 'Invalid queue data' });
          const actions = ['add','move','remove','clear','playNow','playEntry','skipTo','bulk','shuffle','auto','auto.skip','auto.pin','auto.playNow'];
          if (actions.includes(data.action)) {
            const applied = await hub.dispatch({...auth.actor,watchCurrent:current}, { roomId:match[1], action:'queue.' + data.action,
              args:{ ...data, unfinished:data.unfinished ?? false, includeSpecials:data.includeSpecials ?? false } });
            return applied.status === 'applied' ? result(200,applied) : result(applied.httpStatus ||
              ({forbidden:403,unavailable:409,unsupported:400}[applied.status] || 400),{error:applied.message});
          }
          return result(400, { error: 'Unsupported queue action' });
        }
        return result(200, watch.roomState.queue.list(match[1], {
          offset: Number(url.searchParams.get('offset') || 0),
          limit: Number(url.searchParams.get('limit') || 50)
        }));
      }
      if (watch.roomState && match[2] === 'history') {
        await watch.roomState.eligible(auth.actor, current);
        await watch.roomState.metadata(match[1], auth.actor);
        if (!await current()) return result(403, { error: 'Room access changed' });
        const room = watch.rooms.get(match[1]);
        if (room && !await watch.canView(room, auth.actor)) return result(403, { error: 'Room unavailable or private' });
        if (write) {
          if (!throttle('room-queue:' + auth.actor.userId, 60)) return result(429, { error: 'Too many queue operations' });
          if (!data || typeof data !== 'object') return result(400, { error: 'Invalid history data' });
          if (['clear','replay','goBack'].includes(data.action)) {
            const applied = await hub.dispatch({...auth.actor,watchCurrent:current}, { roomId:match[1], action:'queue.history.' + data.action,
              args:{...data,resume:!!data.resume} });
            return applied.status === 'applied' ? result(200,applied) : result(applied.httpStatus ||
              ({forbidden:403,unavailable:409,unsupported:400}[applied.status] || 400),{error:applied.message});
          }
          return result(400, { error: 'Unsupported history action' });
        }
        return result(200, watch.roomState.queue.history(match[1], {
          offset: Number(url.searchParams.get('offset') || 0),
          limit: Number(url.searchParams.get('limit') || 50)
        }));
      }
      if (!watch.rooms.has(match[1]) && !write && !match[2]) await watch.roomState?.recover(match[1],auth.actor,current);
      const room = watch.rooms.get(match[1]);
      if (room?.saved && write && match[2] === 'close') return result(200,await watch.roomState.closeRoom(match[1],auth.actor,data.epoch,current));
      if (!await watch.canView(room, auth.actor)) { return result(403, { error: 'Room unavailable or private' }); }
      if(context.controlSocket&&context.controlSocket.readyState!==1){return result(409,{error:'Room connection changed; retry manually'});}
      if (write && match[2] === 'command') {
        if (!throttle('watch-command:' + auth.actor.userId, 120)) { return result(429, { error: 'Too many commands' }); }
        if (data.epoch !== room.s.epoch || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 3000) {
          return result(409, { error: 'Room changed or command expired; retry manually' });
        }
        const viewer = room.viewers.get(data.viewerId);
        if (data.viewerId !== undefined && (!viewer || viewer.userId !== auth.actor.userId)) throw new Error('Invalid viewer');
        const applied = await hub.dispatch({ ...auth.actor, watchCurrent:current, ...(viewer ? { watchViewerId: data.viewerId } : {}) }, { ...data.command, roomId: room.s.roomId, expiresAt: data.expiresAt }); return result(200, applied);
      }
      if (write && match[2] === 'close') {
        if (!(room.saved ? hub.canRoom(room.s,auth.actor,'closeRoom') : hub.canManage(room.s, auth.actor))) { return result(403, { error: 'Room close permission required' }); }
        if (room.saved && data.epoch !== room.s.epoch) return result(409,{error:'Room changed; refresh before closing'});
        await watch.remove(room.s.roomId); return result(200, { ok: true });
      }
      if (write && match[2] === 'leave') {
        await watch.leave(room, auth.actor, data.viewerId);
        return result(200, { ok: true });
      }
      if (write && match[2] === 'delivery') {
        const viewer = room.viewers.get(data.viewerId);
        if (!viewer || viewer.userId !== auth.actor.userId || viewer.alive && !await viewer.alive() || !await watch.canView(room,auth.actor)) return result(403,{error:'Playback viewer unavailable'});
        if (room.viewers.get(data.viewerId) !== viewer || data.mediaVersion !== room.mediaVersion || data.streamVersion !== viewer.streamVersion || !viewer.directDelivery || viewer.directDelivery !== viewer.media) return result(409,{error:'Playback delivery changed'});
        // A per-viewer transport failure never converts media or changes room
        // playback. Fence pending readiness/observations from the old transport.
        watch.tracking.end(viewer,'delivery-changed');
        viewer.directProxyVersion = room.mediaVersion; viewer.directDelivery = undefined;
        if(viewer.media?.directHls) {
          const previous=viewer.media;viewer.media=undefined;viewer.mediaVersion=undefined;
          void watch.plex.stop(previous);
        }
        viewer.streamVersion = randomUUID(); viewer.ready = false;
        return result(200,{ok:true});
      }
      if (write && match[2] === 'observe') {
        const viewer = room.viewers.get(data.viewerId);
        if (!viewer || viewer.userId !== auth.actor.userId || viewer.alive && !await viewer.alive() || !await watch.canView(room,auth.actor)) {
          return result(403,{error:'Playback viewer unavailable'});
        }
        try {
          const observed = watch.tracking.observe(room,viewer,data.viewerId,data);
          await watch.observeEnd(room,viewer,data,observed);
          await watch.reporting?.observe(room,viewer,data.viewerId,data,observed);
          return result(200,observed);
        }
        catch(error) { return result(error instanceof ObservationError?409:503,{error:'Playback observation unavailable',rejection:error instanceof ObservationError?error.rejection:'storage-failure'}); }
      }
      if (write && match[2] === 'ready') {
        await watch.ready(room, auth.actor, data.viewerId, data.mediaVersion, data.ready, data.readinessVersion);
        return result(200, { ok: true });
      }
      if (write || match[2]) { return result(405, { error: 'Method not allowed' }); }
      const viewerId = url.searchParams.get('viewer');
      if (!UUID.test(viewerId || '')) throw new Error('Invalid viewer');
      if (url.searchParams.has('delivery') && !/^(?:auto|local)$/.test(url.searchParams.get('delivery') || '')) throw new Error('Invalid delivery mode');
      const headers = { cookie: context.headers.cookie, authorization: context.headers.authorization };
      const alive = async () => (!context.controlSocket || context.controlSocket.readyState === 1) && (await login({ headers }))?.userId === auth.actor.userId;
      const preferences={};
      if(url.searchParams.has('volume'))preferences.volume=require('../shared/engine').validate({action:'media.volume.set',args:{percent:Number(url.searchParams.get('volume'))}}).args.percent;
      if(url.searchParams.has('muted')) {
        if(!['true','false'].includes(url.searchParams.get('muted')))throw new Error('Invalid mute preference');
        preferences.muted=url.searchParams.get('muted')==='true';
      }
      if(url.searchParams.has('plexReporting')) {
        if(!['true','false'].includes(url.searchParams.get('plexReporting')))throw new Error('Invalid reporting preference');
        preferences.plexReporting=url.searchParams.get('plexReporting')==='true';
      }
      if(url.searchParams.has('plexWatchState')) {
        if(!['true','false'].includes(url.searchParams.get('plexWatchState')))throw new Error('Invalid watch-state preference');
        preferences.plexWatchState=url.searchParams.get('plexWatchState')==='true';
      }
      watch.snapshot(room, auth.actor, viewerId, alive, url.searchParams.get('quality'),preferences);
      // Capability is set before the first source preparation and never grants access.
      const viewer=room.viewers.get(viewerId);
      const remoteAddress = clientAddress(context);
      if (remoteAddress) viewer.remoteAddress = remoteAddress;
      viewer.activity=!!auth.identity.activity;
      if(viewer.activity && viewer.media?.directHls) {
        watch.tracking.end(viewer,'delivery-changed');
        const previous=viewer.media;viewer.media=undefined;viewer.mediaVersion=undefined;viewer.directDelivery=undefined;
        viewer.directProxyVersion=room.mediaVersion;viewer.streamVersion=randomUUID();viewer.ready=false;
        void watch.plex.stop(previous);
      }
      if(context.controlSocket)viewer.watchSocket=context.controlSocket;
      if(viewer.browserSubtitles===undefined)viewer.browserSubtitles=url.searchParams.get('subtitles')==='browser';
      viewer.localDelivery = url.searchParams.get('delivery') === 'local';
      room.viewers.get(viewerId).browserLoginHash=context.headers.authorization?undefined:cookies(context).uburoom&&hash(cookies(context).uburoom);
      await watch.prepareViewer(room, auth.actor, viewerId);
      if (!await watch.canView(room, auth.actor) || !await alive() || room.viewers.get(viewerId) !== viewer) { return result(403, { error: 'Viewing access was revoked' }); }
      const state = watch.snapshot(room, auth.actor, viewerId, alive);
      const grant = (!viewer.localDelivery && viewer.media?.format !== 'local') ? mediaGrant(room, auth, context, viewerId) : undefined;
      if (grant) {
        state.mediaUrl = `/api/watch/media/${grant}/start`;
        const media=room.viewers.get(viewerId).media;
        if(media.format==='hls' && media.directHls) {
          state.directHls={...media.directHls,session:media.transcodeId};
          state.directDelivery=true;viewer.directDelivery=media;
        }
        else if (config.plexDelivery?.mode === 'auto' && viewer.directProxyVersion !== room.mediaVersion) {
          const direct = await delivery?.file(media, auth, ()=>validGrant(grant), viewer.remoteAddress);
          if (!await validGrant(grant)) return result(409,{error:'Playback delivery changed'});
          if (direct) {
            state.mediaUrl = direct; state.directDelivery = true; viewer.directDelivery = media;
          } else viewer.directDelivery = undefined;
        }
        if (media.selection?.subtitle?.available && media.selection.subtitle.delivery==='text') state.subtitleUrl=`/api/watch/media/${grant}/captions-${media.captionVersion}`;
        else if(media.selection?.subtitle?.available && ['ass','pgs','vobsub'].includes(media.selection.subtitle.delivery))state.subtitleUrl=`/api/watch/media/${grant}/subtitle-${media.captionVersion}`;
      }
      state.timing={serverReceivedAt,serverSentAt:Date.now(),serverProcessingMs:performance.now()-receivedMono,clockEpoch};
      return result(200, state);
    } catch (error) { return result([400,403,404,409,429,503].includes(error.status) ? error.status : 400,
      { error: error.status || error instanceof PlaybackError ? error.message : 'Request failed; check Plex/Discord configuration and try again' }); }
  }
  return { execute };
}
module.exports = { watchOperations };
