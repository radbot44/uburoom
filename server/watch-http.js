'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { randomBytes, randomUUID } = require('node:crypto');
const { UUID, hash } = require('./core');
const { PlaybackError, CHUNK, AUDIO_MIME } = require('./av1');
const { Handoff, SECRET } = require('./handoff');
const Playback = require('../web/playback-policy');
const Subtitles = require('./subtitles');
const SubtitleResources = require('./subtitle-resources');
const { watchOperations } = require('./watch-operations');

function watchHttp({ config, watch, hub, user, webActor, body, json, oauthFetch, throttle, browserLogin, cookies, discordIdentity = value=>value, validIdentity = ()=>true, registry, entryPolicy, cookie, accounts, logins }) {
  const identities = new Map(), grants = new Map();
  const clockEpoch=randomUUID();
  const publicConfig = () => ({ watchVersion:18,unifiedAccounts:!!registry,accountDemo:!!config.demo&&!!config.unifiedAccounts,watchUrl:config.publicUrl+'/watch',clientId:config.clientId,demo:!!config.demo,plexConfigured:watch.plex.configured,testVideo:!!watch.demoMedia,access:entryPolicy?.public(),singleRoom:!!config.singleRoom,localFormats:config.transcoding && (!config.transcoding.uburoom || config.transcoding.policy==='disabled')?[]:config.transcoding?.formats || ['av1'] });
  const handoff = new Handoff();
  const activityOrigin = /^\d{17,20}$/.test(config.clientId || '') ? `https://${config.clientId}.discordsays.com` : undefined;
  const allowedOrigin = req => req.headers.origin === config.publicUrl || activityOrigin && req.headers.origin === activityOrigin;
  if (config.demo && (!['localhost', '127.0.0.1'].includes(new URL(config.publicUrl).hostname) || config.botToken)) throw new Error('Demo identities are restricted to an isolated localhost server without a bot token');
  function issue(login) {
    const token = randomBytes(32).toString('hex');
    const lifetime = config.demo && Number.isSafeInteger(config.demoIdentityMs) && config.demoIdentityMs >= 10000 ? config.demoIdentityMs : 3600000;
    login.expires = Date.now() + lifetime; login.viewerId = randomUUID();
    identities.set(token, login); return { token, expiresAt: login.expires };
  }
  async function rawLogin(req) {
    const token = /^Bearer ([a-f0-9]{64})$/.exec(req.headers.authorization || '')?.[1];
    const identity = req.headers.authorization ? token && identities.get(token) : await user(req);
    if (!identity || !validIdentity(identity) || identity.expires != null && identity.expires <= Date.now()) return;
    return identity;
  }
  async function login(req) {
    const identity = await rawLogin(req);
    if (!identity) return;
    if(config.accessPolicy) {
      if(!config.accessPolicy.publicWeb && !identity.activity)return;
      if(!entryPolicy.password(req,identity))return;
      entryPolicy.entered(identity.userId);
      if(!await entryPolicy.admit(identity.userId,identity))return;
      return identity;
    }
    if (!(hub.access?.canWatch?hub.access.canWatch(identity.userId):hub.access?.isMember(identity.userId)) && !await (hub.access?.refreshWatch||hub.access?.refresh)?.(identity.userId)) return;
    return identity;
  }
  async function authorized(req, write = false) {
    const identity = await login(req);
    if (!identity || req.controlSocket && req.controlSocket.readyState !== 1 || write && (!allowedOrigin(req) || !req.headers.authorization && req.headers['x-csrf-token'] !== identity.csrf)) return;
    return { identity, actor: webActor(identity) };
  }
  async function validGrant(grant) {
    return grant && grant.expires > Date.now() && await grant.alive() && watch.rooms.get(grant.room.s.roomId) === grant.room &&
      grant.version === grant.room.mediaVersion && grant.room.viewers.get(grant.viewerId)?.media === grant.media &&
      grant.streamVersion === grant.room.viewers.get(grant.viewerId)?.streamVersion && await watch.canView(grant.room, grant.actor);
  }
  function mediaGrant(room, auth, req, viewerId) {
    const viewer = room.viewers.get(viewerId);
    if (!viewer?.media || viewer.media.playbackError) return;
    const credential = req.headers.authorization || cookies(req).uburoom;
    const existing = [...grants.values()].find(g => g.room === room && g.viewerId === viewerId && g.actor.userId === auth.actor.userId && g.version === room.mediaVersion && g.streamVersion === viewer.streamVersion);
    if (existing?.credential === credential) { existing.expires = Date.now() + 15000; return existing.id; }
    if (existing) grants.delete(existing.id);
    const id = randomBytes(24).toString('hex');
    const headers = { cookie: req.headers.cookie, authorization: req.headers.authorization };
    grants.set(id, { id, room, media: viewer.media, streamVersion: viewer.streamVersion, actor: auth.actor, viewerId, version: room.mediaVersion, credential, expires: Date.now() + 15000,
      alive: async () => (await login({ headers }))?.userId === auth.actor.userId });
    return id;
  }
  function resource(media, url) {
    const target = watch.plex.url(url).href;
    for (const [key, value] of media.resources) if (value === target) return key;
    if (media.resources.size > 20000) throw new Error('Too many media resources');
    const key = randomBytes(12).toString('hex'); media.resources.set(key, target); return key;
  }
  function rewriteManifest(text, upstream, media, grantId) {
    const resolve = value => `/api/watch/media/${grantId}/${resource(media, new URL(value, upstream).href)}`;
    return text.split(/\r?\n/).map(line => !line.trim() ? line : line.startsWith('#') ?
      line.replace(/URI="([^"\r\n]+)"/g, (_, value) => `URI="${resolve(value)}"`) : resolve(line.trim())).join('\n');
  }
  async function stream(req, res, grant, key) {
    if (!await validGrant(grant)) return json(res, 403, { error: 'Viewing access expired or was revoked' });
    const media = grant.media;
    if(key.startsWith('subtitle-')){
      const match=/^subtitle-([a-f0-9-]{36})(?:\/(data|index|font-\d{1,2}))?$/.exec(key);
      if(!match || match[1]!==media.captionVersion)return json(res,403,{error:'Subtitle selection changed or access expired.'});
      const controller=new AbortController(),cancel=()=>controller.abort();res.on('close',cancel);
      const check=setInterval(async()=>{try{if(!await validGrant(grant)||media.captionVersion!==match[1])controller.abort();}catch{controller.abort();}},1000);
      try{
        const result=await SubtitleResources.load(media.plexContext||watch.plex,media,controller.signal);
        if(controller.signal.aborted || !await validGrant(grant) || media.captionVersion!==match[1])return json(res,403,{error:'Subtitle access expired or selection changed.'});
        res.setHeader('Cache-Control','no-store');
        if(!match[2]){
          const base=`/api/watch/media/${grant.id}/subtitle-${match[1]}/`;
          return json(res,200,{format:result.format,fileName:result.fileName,data:base+'data',
            ...(result.assets.has('index')?{index:base+'index'}:{}),fonts:[...result.assets.keys()].filter(k=>k.startsWith('font-')).map(k=>base+k)});
        }
        const data=result.assets.get(match[2]);if(!data)return json(res,404,{error:'Subtitle resource unavailable.'});
        res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':data.length});return res.end(req.method==='HEAD'?undefined:data);
      }catch(error){if(!res.destroyed)json(res,503,{error:error instanceof PlaybackError?error.message:'Subtitles could not load. Try Plex burn-in.'});}
      finally{clearInterval(check);res.off('close',cancel);}return;
    }
    if (key.startsWith('captions-')) {
      const match = /^captions-([a-f0-9-]{36})$/.exec(key);
      if (!match || match[1]!==media.captionVersion) return json(res,403,{error:'Subtitle selection changed or access expired.'});
      const abort=new AbortController(), cancel=()=>abort.abort(); res.on('close',cancel);
      const check=setInterval(async()=>{try{if(!await validGrant(grant)||media.captionVersion!==match[1])abort.abort();}catch{abort.abort();}},2000);
      try {
        const cues=await Subtitles.load(media.plexContext||watch.plex,media,abort.signal);
        if (abort.signal.aborted || !await validGrant(grant) || media.captionVersion!==match[1]) return json(res,403,{error:'Subtitle access expired or selection changed.'});
        json(res,200,{cues});
      } catch(error) { if(!res.destroyed)json(res,503,{error:error instanceof PlaybackError ? error.message : 'Subtitles could not load.'}); }
      finally {clearInterval(check);res.off('close',cancel);}
      return;
    }
    if (Playback.localFormat(media.format)) {
      if (key === 'start') return json(res, 200, { format:media.format, mime:Playback.LOCAL_CODECS[media.format], audioMime:AUDIO_MIME, chunkSeconds:CHUNK, duration:media.duration,buffer:Playback.BUFFER });
      const match = /^chunk-(video|audio)-(\d{1,9})$/.exec(key), index = Number(match?.[2]);
      // The authoritative timeline selects source time. The grant cannot be used
      // as an arbitrary transcoding API, even by an authenticated viewer.
      const window = Playback.chunkWindow(watch.position(grant.room),media.duration);
      if (!match || index < window.first || index > window.last) return json(res, 403, {error:'Chunk is outside the shared playback window'});
      const abort = new AbortController();
      const cancel = () => abort.abort(); res.on('close', cancel);
      const check = setInterval(async () => { try { if (!await validGrant(grant)) abort.abort(); } catch { abort.abort(); } }, 2000);
      try {
        const chunk = await watch.plex.av1.chunk(media.av1Lease, index, abort.signal), bytes = chunk[match[1]];
        if (abort.signal.aborted || !await validGrant(grant)) return;
        res.writeHead(200, {'Content-Type':'video/webm','Content-Length':bytes.length});
        if (req.method === 'HEAD') res.end(); else await pipeline(Readable.from([bytes]), res);
      } catch (error) {
        if (!res.headersSent && !res.destroyed) json(res, 503, {error:error instanceof PlaybackError ? error.message : 'Local video conversion failed'});
        else res.destroy();
      } finally { clearInterval(check); res.off('close', cancel); }
      return;
    }
    if (media.kind === 'demo') {
      if (key !== 'start') return json(res, 404, { error: 'Media unavailable' });
      const size = fs.statSync(media.file).size, range = req.headers.range;
      let start = 0, end = size - 1;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || !match[1] && !match[2]) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
        if (!match[1]) start = Math.max(0, size - Number(match[2]));
        else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
        if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
      }
      const headers = { 'Content-Type': 'video/mp4', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' };
      if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      res.writeHead(range ? 206 : 200, headers); if (req.method === 'HEAD') return res.end();
      const source = fs.createReadStream(media.file, { start, end });
      const check = setInterval(async () => { try { if (!await validGrant(grant)) source.destroy(); } catch { source.destroy(); } }, 2000);
      try { await pipeline(source, res); } catch { res.destroy(); } finally { clearInterval(check); } return;
    }
    const target = key === 'start' ? media.start : media.resources.get(key);
    if (!target) return json(res, 404, { error: 'Media unavailable' });
    if (key==='start' && media.initialManifest) {
      // Repeated master loads must keep the captured session. Reissuing start
      // after restoring Plex's audio preference could select another track.
      const text=media.initialManifest;
      res.writeHead(200,{'Content-Type':'application/vnd.apple.mpegurl'}); return res.end(req.method==='HEAD' ? undefined : rewriteManifest(text,target,media,grant.id));
    }
    const abort = new AbortController(); let response;
    const timer = setTimeout(() => abort.abort(), 12000);
    const disconnect = () => { if (!res.writableEnded) abort.abort(); }; res.on('close', disconnect);
    try {
      // The grant's own source access is checked before cached or producer bytes.
      response = (media.plexContext||watch.plex).hlsPool?.response(media.hlsLease,target,req.method,req.headers.range) || await (media.hlsContext||media.plexContext||watch.plex).request(target, { method: req.method, signal: abort.signal, headers: { Accept: '*/*',
        ...(media.transcodeId ? { 'X-Plex-Client-Identifier': media.transcodeId } : {}), ...(req.headers.range ? { Range: req.headers.range } : {}) } });
      clearTimeout(timer);
      if (!await validGrant(grant)) { abort.abort(); return json(res, 403, { error: 'Viewing access was revoked' }); }
      const type = response.headers.get('content-type') || 'application/octet-stream';
      if (req.method !== 'HEAD' && (new URL(target).pathname.endsWith('.m3u8') || /mpegurl/i.test(type))) {
        const text = await response.text(); if (text.length > 2e6) throw new Error('Manifest too large');
        if (!await validGrant(grant)) { abort.abort(); return json(res, 403, { error: 'Viewing access was revoked' }); }
        res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
        return res.end(rewriteManifest(text, target, media, grant.id));
      }
      const headers = { 'Content-Type': type };
      for (const name of ['content-length', 'content-range', 'accept-ranges']) if (response.headers.has(name)) headers[name] = response.headers.get(name);
      res.writeHead(response.status, headers); if (req.method === 'HEAD') return res.end();
      const check = setInterval(async () => { try { if (!await validGrant(grant)) abort.abort(); } catch { abort.abort(); } }, 2000);
      try { await pipeline(Readable.fromWeb(response.body), res); } finally { clearInterval(check); }
    } catch (error) {
      if (!res.headersSent) json(res, media.transcodeId && ([404,410].includes(error.status)||media.hlsLease&&[401,403].includes(error.status)) ? 410 : 502,
        { error: 'Plex playback failed; try a different quality or check server access' });
      else res.destroy();
    }
    finally { clearTimeout(timer); res.off('close', disconnect); }
  }
  const operations = watchOperations({ config, watch, hub, authorized, login, mediaGrant, cookies, throttle, registry, clockEpoch });
  async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/watch/')) return false;
    if(config.accessPolicy && url.pathname==='/api/watch/entry' && req.method==='POST') {
      if(!allowedOrigin(req)||!throttle('entry:'+req.socket.remoteAddress,10)){json(res,429,{error:'Entry is unavailable; wait a minute and try again'});return true;}
      const identity=await rawLogin(req), data=await body(req);
      if(!config.accessPolicy.publicWeb&&!identity?.activity){json(res,403,{error:'Open uburoom through Discord Activity'});return true;}
      if(entryPolicy.passwordRequired){
        const grant=entryPolicy.enter(data.password,identity);
        if(!grant){json(res,403,{error:'Incorrect server password'});return true;}
        res.setHeader('Set-Cookie',cookie('uburoom_entry',grant,43200));
      }
      if(entryPolicy.anonymous && !identity){
        const id=randomBytes(32).toString('hex'), accountId=registry.create('Guest'), account=registry.canonical(accountId);
        registry.seen(accountId);
        logins.set(hash(id),{userId:account.id,accountRevision:account.revision,name:'Guest',csrf:randomBytes(32).toString('hex'),expires:Date.now()+86400000});accounts.save();
        const existing=res.getHeader('Set-Cookie');
        res.setHeader('Set-Cookie',[...(existing?[existing]:[]),cookie('uburoom',id,86400)]);
      }
      json(res,200,{ok:true});return true;
    }
    if(config.accessPolicy && url.pathname==='/api/watch/admission' && req.method==='GET') {
      const identity=await rawLogin(req);
      json(res,200,{identity:!!identity,passwordNeeded:!entryPolicy.password(req,identity),
        activityOnly:!config.accessPolicy.publicWeb&&!identity?.activity,
        plexRequired:entryPolicy.requiresPlex(identity),
        admitted:!!identity&&!!await login(req),csrf:identity?.csrf,
        pendingIdentity:identity?{name:identity.name,csrf:identity.csrf,account:registry?.summary(identity.userId)}:undefined});return true;
    }
    if (['GET', 'HEAD'].includes(req.method) && url.pathname.startsWith('/api/watch/media/')) {
      const match = /^\/api\/watch\/media\/([a-f0-9]{48})\/(start|chunk-(?:video|audio)-\d{1,9}|captions-[a-f0-9-]{36}|subtitle-[a-f0-9-]{36}(?:\/(?:data|index|font-\d{1,2}))?|[a-f0-9]{24})$/.exec(url.pathname);
      if (!match) { json(res, 404, { error: 'Media unavailable' }); return true; }
      await stream(req, res, grants.get(match[1]), match[2]); return true;
    }
    if (!throttle('watch:' + req.socket.remoteAddress, 600)) { json(res, 429, { error: 'Too many requests' }); return true; }
    try {
      if (req.method === 'POST' && ['/api/watch/handoff/claim', '/api/watch/handoff/redeem'].includes(url.pathname)) {
        // These browser endpoints never accept an Activity bearer or a cross-origin request.
        const nonce = cookies(req).uburoom_handoff;
        if (req.headers.origin !== config.publicUrl || req.headers.authorization || !SECRET.test(nonce || '') ||
          !throttle('handoff-browser:' + req.socket.remoteAddress, 120)) { json(res, 403, {error:'Browser sign-in unavailable; open a fresh link from the Activity'}); return true; }
        const data = await body(req);
        const attempt = url.pathname.endsWith('/claim') ? handoff.claim(data.code, data.proof, nonce) : handoff.browser(data.id, data.proof, nonce);
        if (!attempt || attempt.redeeming || !['claimed','approved'].includes(attempt.state)) { json(res, 410, {error:'Browser sign-in expired or was already used; open a fresh link from the Activity'}); return true; }
        const alive = async () => (attempt.linkOnly ? await rawLogin({headers:{authorization:attempt.authorization}}) : await login({headers:{authorization:attempt.authorization}})) === attempt.source;
        if (!await alive() || handoff.get(attempt.id) !== attempt) { handoff.remove(attempt); json(res,403,{error:'Activity sign-in is no longer available'}); return true; }
        const existing = await user(req);
        if (url.pathname.endsWith('/claim')) {
          json(res,200,{id:attempt.id,name:attempt.source.name,verification:attempt.verification,expires:attempt.expires,
            switchRequired:!!existing && existing.userId !== attempt.source.userId,existingName:existing?.name}); return true;
        }
        if (attempt.state !== 'approved') { json(res,202,{pending:true}); return true; }
        if (existing && existing.userId !== attempt.source.userId && data.switchAccount !== true) { json(res,409,{error:'Confirm switching this browser to the Activity account',switchRequired:true}); return true; }
        attempt.redeeming = true;
        try {
          const room = watch.rooms.get(attempt.roomId);
          const roomId = await watch.canView(room, webActor(attempt.source)) ? room.s.roomId : undefined;
          if (!await alive() || !handoff.consume(attempt)) { json(res,410,{error:'Activity sign-in expired or was cancelled'}); return true; }
          if (existing?.userId !== attempt.source.userId) browserLogin(res,attempt.source);
          else res.setHeader('Set-Cookie','uburoom_handoff=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
          json(res,200,{destination:attempt.connectPlex?'/auth/plex':attempt.linkOnly?'/watch?account=1':'/watch' + (roomId ? '?room=' + roomId : '')}); return true;
        } finally { attempt.redeeming = false; }
      }
      if (req.method === 'GET' && url.pathname === '/api/watch/config') {
        json(res, 200, publicConfig()); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/demo-login') {
        if (!config.demo || !allowedOrigin(req) || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { json(res, 403, { error: 'Demo login is disabled' }); return true; }
        const data = await body(req); if (!['host', 'guest', 'guest2'].includes(data.persona)) throw new Error('Choose a demo identity');
        const identity = discordIdentity({ userId:config.demoSubjects?.[data.persona]||(data.persona === 'host' ? config.ownerId : data.persona === 'guest2' ? 'demo-guest2' : 'demo-guest'), name: data.persona === 'host' ? 'Demo host' : data.persona === 'guest2' ? 'Demo guest 2' : 'Demo guest', activity:data.activity === true });
        json(res, 200, { ...issue(identity), name: identity.name, owner: hub.isOwner(webActor(identity)) }); return true;
      }
      if (req.method === 'POST' && url.pathname === '/api/watch/activity-login') {
        if (!activityOrigin || req.headers.origin !== activityOrigin || !config.clientSecret) { json(res, 403, { error: 'Activity authentication unavailable' }); return true; }
        const data = await body(req); if (typeof data.code !== 'string' || !data.code || data.code.length > 512) throw new Error('Invalid login code');
        const response = await oauthFetch('https://discord.com/api/oauth2/token', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code: data.code }) });
        if (!response.ok) throw new Error('Discord rejected the login');
        const tokens = await response.json();
        const profile = await oauthFetch('https://discord.com/api/users/@me', { signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + tokens.access_token } });
        if (!profile.ok) throw new Error('Discord identity unavailable');
        const identity = await profile.json();
        // Never trust guild/channel/user IDs supplied by the iframe. Membership
        // and its current voice channel come from the connected bot's guild.
        if (config.accessPolicy?.discord===false || !await hub.access?.refresh(identity.id) || !hub.access.validVoiceChannel(hub.access.voiceChannel(identity.id))) { json(res, 403, { error: 'Join a voice channel in the configured Discord server first' }); return true; }
        const login = discordIdentity({ userId: identity.id, name: EngineName(identity.global_name || identity.username), activity:true });
        const previous=await rawLogin(req);
        if(previous?.activity&&previous.userId===login.userId&&previous.entryAuthorized)login.entryAuthorized=true;
        json(res, 200, { ...issue(login), accessToken: tokens.access_token, name: login.name, owner: hub.isOwner(webActor(login)) }); return true;
      }
      if (req.method === 'GET' && ['/api/watch/me', '/api/watch/playback', '/api/watch/library', '/api/watch/library/item', '/api/watch/library/availability', '/api/watch/library/filters', '/api/watch/library/art'].includes(url.pathname)) {
        const reply = await operations.execute({ headers: req.headers }, url.href);
        if (reply.resource) {
          const art = reply.resource;
          res.writeHead(reply.status, { 'Content-Type': art.type, 'Content-Length': art.bytes.length, 'Cache-Control': 'private, no-store' });
          res.end(art.bytes);
        } else json(res, reply.status, reply.value);
        return true;
      }
      if (!['/api/watch/handoff', '/api/watch/handoff/status', '/api/watch/handoff/action'].includes(url.pathname)) { json(res, 404, { error: 'Room controls require an authenticated WebSocket' }); return true; }
      let auth = await authorized(req, req.method !== 'GET');
      if(!auth&&config.accessPolicy&&allowedOrigin(req)&&req.headers.authorization){
        const identity=await rawLogin(req);
        if(identity?.activity&&entryPolicy.password(req,identity))auth={identity,actor:webActor(identity),pending:true};
      }
      if (!auth) { json(res, 401, { error: 'Log in with Discord' }); return true; }
      if (url.pathname === '/api/watch/handoff' && req.method === 'POST') {
        if (!auth.identity.activity || !req.headers.authorization || !throttle('handoff-issue:' + auth.actor.userId, 6)) {json(res,403,{error:'Open in Browser requires an authenticated Activity'});return true;}
        const data = await body(req), room = watch.rooms.get(data.roomId);
        if (data.roomId !== undefined && (!UUID.test(data.roomId) || !await watch.canView(room,auth.actor))) {json(res,403,{error:'Room unavailable or private'});return true;}
        const issued = handoff.issue(auth.identity,data.roomId);
        handoff.get(issued.id).authorization = req.headers.authorization;
        handoff.get(issued.id).linkOnly=auth.pending||config.accessPolicy?.publicWeb===false;
        handoff.get(issued.id).connectPlex=auth.pending&&config.accessPolicy?.requirePlex;
        json(res,200,{id:issued.id,expires:issued.expires,url:config.publicUrl+'/auth/handoff#'+issued.code});return true;
      }
      if (url.pathname === '/api/watch/handoff/status' && req.method === 'POST') {
        const data = await body(req), attempt = handoff.get(data.id);
        if (!attempt || attempt.source !== auth.identity) {json(res,410,{error:'Browser sign-in expired or was cancelled'});return true;}
        json(res,200,{state:attempt.state,verification:attempt.verification});return true;
      }
      if (url.pathname === '/api/watch/handoff/action' && req.method === 'POST') {
        const data = await body(req), attempt = handoff.get(data.id);
        if (!attempt || attempt.source !== auth.identity) {json(res,410,{error:'Browser sign-in expired or was cancelled'});return true;}
        if (data.action === 'cancel') handoff.remove(attempt);
        else if (data.action !== 'approve' || !handoff.approve(attempt,data.verification)) {json(res,409,{error:'Wait for the browser and check its code before approving'});return true;}
        json(res,200,{ok:true});return true;
      }
      json(res, 404, { error: 'Room controls require an authenticated WebSocket' }); return true;
    } catch (error) { json(res, 400, { error: error instanceof PlaybackError ? error.message : 'Request failed; check Plex/Discord configuration and try again' }); return true; }
  }
  const EngineName = value => require('../shared/engine').senderName(value);
  function sweep() {
    entryPolicy?.sweep();
    handoff.sweep();
    for (const [token, value] of identities) if (value.expires <= Date.now()) identities.delete(token);
    for (const [token, value] of grants) if (value.expires <= Date.now()) grants.delete(token);
  }
  async function logout(loginHash){
    for(const room of [...watch.rooms.values()])for(const [id,viewer]of [...room.viewers])if(viewer.browserLoginHash===loginHash)await watch.leave(room,viewer.actor,id,'logout');
  }
  async function bootstrap(req) {
    const initial = {config:publicConfig()};
    const query = new URL(req.url,config.publicUrl).searchParams;
    if(query.has('frame_id')||config.demo&&['host','guest','guest2'].includes(query.get('demo')))return initial;
    try {
      initial.me=await operations.execute({headers:req.headers},'/api/watch/me');
      if(initial.me.status===200)initial.rooms=await operations.execute({headers:req.headers},'/api/watch/rooms');
    } catch { initial.me={status:503,value:{error:'Sign-in temporarily unavailable. Try again.'}}; }
    return initial;
  }
  return { route, bootstrap, execute: operations.execute, sweep, logout, authorized, clockEpoch, close: () => { identities.clear(); grants.clear(); handoff.close(); }, rewriteManifest };
}
module.exports = { watchHttp };
