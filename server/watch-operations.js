// @ts-check
'use strict';
const { UUID, hash } = require('./core');
const { PlaybackError } = require('./av1');
const { ObservationError } = require('./playback-tracking');

// Transport-neutral operations return values; HTTP resources and socket framing
// belong to their respective transports. Epochs and authorization stay here.
function watchOperations({ config, watch, hub, authorized, login, mediaGrant, cookies, throttle, registry, clockEpoch }) {
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
      if (url.pathname === '/api/rooms' && !write) return result(200, { rooms: await hub.list(auth.actor) });
      if (url.pathname === '/api/command' && write) {
        if (!throttle('command:' + auth.actor.userId, 120)) return result(429, { error: 'Too many commands; try again shortly' });
        if (Object.hasOwn(data, 'sessionId') || !UUID.test(data.roomId || '')) return result(400, { error: 'Select a room' });
        return result(200, await hub.dispatch(auth.actor, { ...data.command, roomId: data.roomId }));
      }
      if (!write && url.pathname === '/api/watch/me') {
        return result(200, { name: auth.identity.name,owner:hub.isOwner(auth.actor),adminMode:hub.isAdmin(auth.actor),csrf:auth.identity.csrf,account:registry?.summary(auth.actor.userId) });
      }
      if (write && url.pathname === '/api/watch/admin-mode') {
        if (!hub.isOwner(auth.actor) || typeof data.enabled !== 'boolean') {return result(403,{error:'Only the owner can change Admin mode'});}
        hub.setAdminMode(auth.actor, data.enabled); return result(200,{adminMode:hub.isAdmin(auth.actor)});
      }
      if (!write && ['/api/watch/library','/api/watch/library/item','/api/watch/library/filters','/api/watch/library/art'].includes(url.pathname)) {
        const room = watch.rooms.get(url.searchParams.get('room'));
        const eligible = async () => room && watch.rooms.get(room.s.roomId) === room && hub.canManage(room.s, auth.actor) &&
         await watch.canView(room, auth.actor) && (await login(context))?.userId === auth.actor.userId;
        if (!await eligible()) { return result(403, { error: 'Library access requires the current host or active Admin mode' }); }
        const plex=hub.plexFor?await hub.plexFor(auth.actor):watch.plex;
        const scopeCurrent=async()=>!hub.plexFor||(await hub.plexFor(auth.actor)).principal===plex.principal;
        const itemVisible=async()=>plex.principal==='discord-shared'||!hub.plexFor||await plex.visible(url.searchParams.get('item'),url.searchParams.get('type'));
        let data;
        if (url.pathname.endsWith('/art')) {
          const art = await plex.artwork(url.searchParams.get('item'), url.searchParams.get('kind') || 'poster', url.searchParams.get('type'));
          if (!await eligible()||!await scopeCurrent()||!await itemVisible()) { return result(403, {error:'Library access was revoked'}); }
          return { status: 200, resource: art };
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
      if (url.pathname === '/api/watch/rooms') return write ? result(201, { id: watch.create(auth.actor) }) : result(200, { rooms: await watch.list(auth.actor, auth.identity.activity === true) });
      const match = /^\/api\/watch\/rooms\/([a-f0-9-]{36})(?:\/(command|close|leave|ready|observe))?$/.exec(url.pathname);
      if (!match || !UUID.test(match[1])) { return result(404, { error: 'Room unavailable' }); }
      const room = watch.rooms.get(match[1]);
      if (!await watch.canView(room, auth.actor)) { return result(403, { error: 'Room unavailable or private' }); }
      if(context.controlSocket&&context.controlSocket.readyState!==1){return result(409,{error:'Room connection changed; retry manually'});}
      if (write && match[2] === 'command') {
        if (!throttle('watch-command:' + auth.actor.userId, 120)) { return result(429, { error: 'Too many commands' }); }
        if (data.epoch !== room.s.epoch || !Number.isFinite(data.expiresAt) || data.expiresAt <= Date.now() || data.expiresAt > Date.now() + 3000) {
          return result(409, { error: 'Room changed or command expired; retry manually' });
        }
        const viewer = room.viewers.get(data.viewerId);
        if (data.viewerId !== undefined && (!viewer || viewer.userId !== auth.actor.userId)) throw new Error('Invalid viewer');
        const applied = await hub.dispatch({ ...auth.actor, ...(viewer ? { watchViewerId: data.viewerId } : {}) }, { ...data.command, roomId: room.s.roomId, expiresAt: data.expiresAt }); return result(200, applied);
      }
      if (write && match[2] === 'close') {
        if (!hub.canManage(room.s, auth.actor)) { return result(403, { error: 'Only the host or an active administrator can close the room' }); }
        watch.remove(room.s.roomId); return result(200, { ok: true });
      }
      if (write && match[2] === 'leave') {
        await watch.leave(room, auth.actor, data.viewerId);
        return result(200, { ok: true });
      }
      if (write && match[2] === 'observe') {
        const viewer = room.viewers.get(data.viewerId);
        if (!viewer || viewer.userId !== auth.actor.userId || viewer.alive && !await viewer.alive() || !await watch.canView(room,auth.actor)) {
          return result(403,{error:'Playback viewer unavailable'});
        }
        try { return result(200,watch.tracking.observe(room,viewer,data.viewerId,data)); }
        catch(error) { return result(error instanceof ObservationError?409:503,{error:'Playback observation unavailable',rejection:error instanceof ObservationError?error.rejection:'storage-failure'}); }
      }
      if (write && match[2] === 'ready') {
        await watch.ready(room, auth.actor, data.viewerId, data.mediaVersion, data.ready, data.readinessVersion);
        return result(200, { ok: true });
      }
      if (write || match[2]) { return result(405, { error: 'Method not allowed' }); }
      const viewerId = url.searchParams.get('viewer');
      if (!UUID.test(viewerId || '')) throw new Error('Invalid viewer');
      const headers = { cookie: context.headers.cookie, authorization: context.headers.authorization };
      const alive = async () => (!context.controlSocket || context.controlSocket.readyState === 1) && (await login({ headers }))?.userId === auth.actor.userId;
      watch.snapshot(room, auth.actor, viewerId, alive, url.searchParams.get('quality'));
      // Capability is set before the first source preparation and never grants access.
      const viewer=room.viewers.get(viewerId);
      if(context.controlSocket)viewer.watchSocket=context.controlSocket;
      if(viewer.browserSubtitles===undefined)viewer.browserSubtitles=url.searchParams.get('subtitles')==='browser';
      room.viewers.get(viewerId).browserLoginHash=context.headers.authorization?undefined:cookies(context).uburoom&&hash(cookies(context).uburoom);
      await watch.prepareViewer(room, auth.actor, viewerId);
      if (!await watch.canView(room, auth.actor) || !await alive()) { return result(403, { error: 'Viewing access was revoked' }); }
      const state = watch.snapshot(room, auth.actor, viewerId, alive);
      const grant = mediaGrant(room, auth, context, viewerId);
      if (grant) {
        state.mediaUrl = `/api/watch/media/${grant}/start`;
        const media=room.viewers.get(viewerId).media;
        if (media.selection?.subtitle?.available && media.selection.subtitle.delivery==='text') state.subtitleUrl=`/api/watch/media/${grant}/captions-${media.captionVersion}`;
        else if(media.selection?.subtitle?.available && ['ass','pgs','vobsub'].includes(media.selection.subtitle.delivery))state.subtitleUrl=`/api/watch/media/${grant}/subtitle-${media.captionVersion}`;
      }
      state.timing={serverReceivedAt,serverSentAt:Date.now(),serverProcessingMs:performance.now()-receivedMono,clockEpoch};
      return result(200, state);
    } catch (error) { return result(400, { error: error instanceof PlaybackError ? error.message : 'Request failed; check Plex/Discord configuration and try again' }); }
  }
  return { execute };
}
module.exports = { watchOperations };
