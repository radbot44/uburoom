'use strict';
const https = require('node:https');
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Hub, hash, UUID } = require('./core');
const { loginStore } = require('./storage');
const { Plex } = require('./plex');
const { Watch } = require('./watch');
const { watchHttp } = require('./watch-http');
const { watchPage } = require('./watch-page');
const { watchSockets } = require('./watch-socket');
const { Accounts, credentialVault } = require('./accounts');
const { PlexAuth } = require('./plex-auth');
const { accountHttp } = require('./account-http');
const { isServerOperator } = require('./operator-policy');
const { runningSettings } = require('./operator-settings');
const { createConfigEditor } = require('./config-editor');
const { operatorHttp } = require('./operator-http');
const version = require('../package.json').version;
const { resilientFetch } = require('./resilience');
const RoomPolicy = require('./room-policy');
const { AccessPolicy } = require('./access-policy');

function createApp(config, { authorizeUrl = 'https://discord.com/oauth2/authorize', oauthFetch = fetch, plexFetch = fetch, plexDemo } = {}) {
  // Browser-only installations do not need a Discord text-channel whitelist.
  if(config.accessPolicy && !config.channels.length)config.channels=['__web__'];
  let registry;
  try {
  oauthFetch=resilientFetch(oauthFetch,{timeoutMs:10000});
  if(config.accountFile&&!config.credentialKeyFile)throw new Error('Configure a private uburoom credential key file outside the project');
  if(config.accountFile&&!fs.existsSync(config.accountFile)&&fs.existsSync(path.join(path.dirname(config.accountFile),'logins.json')))throw new Error('Legacy private state found without a baseline database; review a backup and manual transfer or reset before starting');
  if(config.accountFile&&fs.existsSync(config.accountFile)&&!fs.existsSync(config.credentialKeyFile))throw new Error('The uburoom credential key is missing; restore the original key before starting');
  const vault=config.accountFile||config.unifiedAccounts?credentialVault(config.credentialKeyFile):undefined;
  registry=vault?new Accounts(config.accountFile,vault):undefined;
  // Persist policy identity without leaving an offline verifier of the shared
  // password in SQLite. Password grants are process-local and reset on restart.
  const accounts = loginStore(JSON.stringify([config.publicUrl, config.ownerId, config.guildId, config.clientId,...(config.accessPolicy?[hash(JSON.stringify({...config.accessPolicy,password:!!config.accessPolicy.password}))]:[])]),vault,registry);
  // Browsers require a finite cookie lifetime; renew it on each account visit.
  // Server logins have no fixed lifetime; Discord renewal/revocation governs them.
  const loginSeconds = 365 * 24 * 60 * 60, renewals = new Map(), cookieRenewedAt = new Map();
  const hub = new Hub(config);
  hub.ownerName = accounts.ownerName;
  hub.setOwnerName = name => {
    const owner = registry?.identity('discord',config.ownerId);
    if (owner) name = registry.canonical(owner.userId)?.name || name;
    if (typeof name !== 'string' || !name || name === accounts.ownerName) return;
    hub.ownerName = accounts.ownerName = name.slice(0, 100);
    accounts.save();
  };
  const logins = accounts.logins, oauthStates = new Map(), limits = new Map();
  function discordIdentity(identity) {
    if(!registry)return identity;
    const account=registry.resolve('discord',identity.userId,identity.name);
    return {...identity,name:account.name,userId:account.id,accountRevision:account.revision};
  }
  function validIdentity(identity) {if(!registry)return true;const account=registry.canonical(identity.userId);return !!account&&account.id===identity.userId&&account.revision===identity.accountRevision;}
  const publicDir = path.join(__dirname, '../web');
  const assetCache = new Map();
  async function readAsset(filePath, encoding) {
    const key = filePath + (encoding ? ':' + encoding : '');
    const hit = assetCache.get(key);
    if (hit !== undefined) return hit;
    const data = await fsp.readFile(filePath, encoding);
    if (assetCache.size < 128) assetCache.set(key, data);
    return data;
  }
  const oauthReady = !!(config.clientId && config.clientSecret && config.ownerId);
  const cookie = (name, value, maxAge) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
  function cookies(req) {
    return Object.fromEntries((req.headers.cookie || '').split(';').map(p => p.trim().split('=')));
  }
  function browserLogin(res, identity) {
    // Activity OAuth is not duplicated/rotated across browser sessions. This
    // browser login expires with its source's one-hour identity grant.
    const id = randomBytes(32).toString('hex');
    logins.set(hash(id), { userId: identity.userId, name: identity.name, accountRevision:identity.accountRevision, csrf: randomBytes(32).toString('hex'), expires: identity.expires });
    accounts.save();
    res.setHeader('Set-Cookie', [cookie('uburoom', id, Math.max(1, Math.floor((identity.expires - Date.now()) / 1000))), cookie('uburoom_handoff', '', 0)]);
  }
  function throttle(key, max = 60) {
    const now = Date.now(); let bucket = limits.get(key);
    if (!bucket || now - bucket.at > 60000) { bucket = { at: now, count: 0 }; limits.set(key, bucket); }
    return ++bucket.count <= max;
  }
  function json(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  }
  function renewCookie(req, res, login, force = false) {
    if (!login) return;
    const token = cookies(req).uburoom, now = Date.now();
    if (force || now - (cookieRenewedAt.get(hash(token)) || 0) >= 86400000) {
      res.setHeader('Set-Cookie', cookie('uburoom', token, loginSeconds));
      cookieRenewedAt.set(hash(token), now);
    }
  }
  async function user(req) {
    const token = cookies(req).uburoom;
    const id = token && /^[a-f0-9]{64}$/.test(token) && hash(token);
    const login = id && logins.get(id);
    if (!login || !validIdentity(login) || login.expires !== null && login.expires <= Date.now()) return;
    // Pending identities must remain usable for account linking when admission
    // requires Plex. Playback admission is enforced separately by watch routes.
    if (!config.accessPolicy && !(hub.access?.canWatch?hub.access.canWatch(login.userId):hub.access?.isMember(login.userId)) && !await (hub.access?.refreshWatch||hub.access?.refresh)?.(login.userId)) return;
    if (login.oauth && login.oauth.expires <= Date.now()) {
      if (!renewals.has(id)) {
        const renewal = (async () => {
          const response = await oauthFetch('https://discord.com/api/oauth2/token', { method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, signal: AbortSignal.timeout(10000),
            body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
              grant_type: 'refresh_token', refresh_token: login.oauth.refreshToken }) });
          if (!response.ok) {
            if ([400, 401, 403].includes(response.status)) { logins.delete(id); accounts.save(); return; }
            throw new Error('Discord login renewal temporarily unavailable');
          }
          const renewed = await response.json();
          if (typeof renewed.refresh_token !== 'string' || !Number.isFinite(renewed.expires_in) || renewed.expires_in <= 0) throw new Error('Invalid login renewal');
          // Logout may have removed this login while Discord was responding.
          if (logins.get(id) !== login) return;
          login.oauth = { refreshToken: renewed.refresh_token, expires: Date.now() + renewed.expires_in * 1000 };
          accounts.save(); return login;
        })().catch(() => { throw Object.assign(new Error('Discord login renewal temporarily unavailable'), { status: 503 }); })
          .finally(() => renewals.delete(id));
        renewals.set(id, renewal);
      }
      return renewals.get(id);
    }
    return logins.get(id) === login ? login : undefined;
  }
  async function protectedPost(req) {
    if (req.headers.origin !== config.publicUrl) return;
    const login = await user(req);
    return login && req.headers.origin === config.publicUrl && req.headers['x-csrf-token'] === login.csrf ? login : undefined;
  }
  // Web requests are bound to the configured guild and its approved command context.
  // These actor fields come from the server/login, never from the caller's JSON.
  function webActor(login) { return { userId: login.userId, ...(registry?{discordId:registry.identities(login.userId).find(i=>i.provider==='discord')?.subject}:{}),name: registry?.canonical(login.userId)?.name || login.name, guildId: config.guildId, channelId: config.channels[0], surface: 'web', activity:login.activity === true }; }
  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('JSON required');
    let text = '';
    for await (const chunk of req) { text += chunk; if (Buffer.byteLength(text) > 4096) throw new Error('Body too large'); }
    const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid body'); return value;
  }
  async function discordFetch(url, options) {
    const response = await oauthFetch(url, { ...options, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Discord authentication failed');
    return response.json();
  }
  const demoFile = path.join(__dirname, '../assets/demo/sync-test.mp4');
  const plex = new Plex(config,plexFetch);
  const plexAuth=registry?new PlexAuth(config,registry,plex,plexFetch):undefined;
  let entryPolicy;
  if(config.demo&&plexAuth)plexAuth.demo=plexDemo;
  if(registry){
    let rawAccess;
    entryPolicy = new AccessPolicy(config,registry,plexAuth,()=>rawAccess);
    let singleLeader;
    hub.singleRoomLeader = async () => {
      if (!singleLeader) {
        singleLeader = (async () => {
          if (config.singleRoomLeaderPlexId) return registry.resolve('plex',config.singleRoomLeaderPlexId,'Assigned account',false);
          if (config.accessPolicy?.discord !== false || !config.accessPolicy?.plex) return registry.resolve('discord',config.ownerId,'Assigned account',false);
          let profile;
          try { profile = await plexAuth.request('/user',{token:config.plexToken}); }
          catch { throw new Error('Cannot identify the single-room leader from plex.token; check the token or set rooms.single_room_leader_plex_id'); }
          if (!/^\d{1,20}$/.test(String(profile?.id || ''))) throw new Error('Plex did not identify the token account; set rooms.single_room_leader_plex_id');
          return registry.resolve('plex',String(profile.id),'Assigned account',false);
        })();
        singleLeader.catch(() => { singleLeader = undefined; });
      }
      return singleLeader.then(account => registry.canonical(account.id));
    };
    hub.adminEligible = actor => RoomPolicy.administrator(registry,config,actor.userId,rawAccess);
    hub.refreshAdmin = async actor => {
      const roles = config.roomAdministrators?.discordRoles || [];
      const discord = registry.identities(actor.userId).find(identity => identity.provider === 'discord' && identity.verified)?.subject;
      if (roles.length && discord && !rawAccess?.isMember(discord)) {
        try { await rawAccess?.refresh(discord); } catch { /* Missing live guild authority fails closed below. */ }
      }
      if (!hub.canAdmin(actor)) hub.clearAdmin(actor);
    };
    const discordId=id=>registry.canonical(id)?registry.identities(id).find(i=>i.provider==='discord')?.subject:id;
    const access={
      isMember:id=>{const discord=discordId(id);return !!discord&&!!rawAccess?.isMember(discord);},
      refresh:async id=>{const discord=discordId(id);return !!discord&&!!await rawAccess?.refresh(discord);},
      voiceChannel:id=>{const discord=discordId(id);return discord&&rawAccess?.voiceChannel(discord);},
      hasRole:(id,role)=>{const discord=discordId(id);return !!discord&&rawAccess?.hasRole?.(discord,role)===true;},
      identity:async id=>rawAccess?.identity?rawAccess.identity(id):await rawAccess?.refresh(id)?{id,name:registry.identity('discord',id)?.name||id}:undefined,
      directory:()=>rawAccess?.directory?.() || Promise.reject(new Error('Discord directory unavailable; check the bot and Server Members Intent')),
      discordOnline:subject=>rawAccess?.discordOnline?.(subject),
      validVoiceChannel:id=>!!rawAccess?.validVoiceChannel(id),options:()=>rawAccess?.options()||{available:false},
      canWatch:(id,actor)=>config.accessPolicy ? entryPolicy.fresh(id,actor) : access.isMember(id)||!!registry.canonical(id)&&plexAuth.fresh(id),
      refreshWatch:async (id,actor)=>{if(config.accessPolicy)return entryPolicy.admit(id,actor);if(access.isMember(id)||await access.refresh(id))return true;try{return !!await plexAuth.forUser(id);}catch{return false;}}
    };
    Object.defineProperty(hub,'access',{get:()=>access,set:value=>{rawAccess=value;}});
    hub.accountActor=actor=>registry.canonical(actor.userId)?{...actor,name:registry.canonical(actor.userId).name}:{...actor,...discordIdentity({userId:actor.userId,name:actor.name||'Discord user'}),discordId:actor.userId};
    hub.plexFor=async actor=>{
      const identity=registry.identities(actor.userId).find(i=>i.provider==='plex');
      const fallback=()=>{
        if(config.plexFallback?.enabled===false)throw new Error('Connect a Plex account with access to this server; shared fallback is disabled');
        return plexAuth.fallback();
      };
      if(!identity)return fallback();
      if(!registry.hasCredential(identity.subject))throw new Error('Connect your Plex account again');
      try {const scoped=await plexAuth.forUser(actor.userId);if(!scoped)throw new Error('Connect your Plex account again');return scoped;}
      catch(error){
        // Only a confirmed lack of server membership may use explicit open-entry
        // sponsorship. Expiry, network errors and item restrictions never do.
        if(config.accessPolicy && !entryPolicy.requiresPlex(actor) && error.noServerAccess)return fallback();
        throw error;
      }
    };
  }
  const watch = new Watch(hub, plex, fs.existsSync(demoFile) ? { kind: 'demo', title: 'uburoom synchronization test', duration: 60, format: 'file', quality: 'direct', file: demoFile } : undefined, registry, plexAuth);
  if (registry) {
    hub.directory = new (require('./user-directory').UserDirectory)({registry,config,discord:()=>hub.access.directory(),discordOnline:subject=>hub.access.discordOnline(subject),plex:()=>require('./plex-directory').plexDirectory(plexAuth)});
    hub.renameAccount = async (id,name) => {
      const account = registry.rename(id,name); await registry.flush();
      if (registry.identities(id).some(identity=>identity.provider==='discord'&&identity.subject===config.ownerId)) hub.setOwnerName(account.name);
      for (const login of logins.values()) if (login.userId === id) login.name = account.name;
      for (const room of watch.rooms.values()) {
        if (room.s.hostId === id) room.s.hostName = account.name;
        if (room.s.ownerId === id) room.s.ownerName = account.name;
        for (const viewer of room.viewers.values()) if (viewer.userId === id) { viewer.name = account.name; viewer.actor.name = account.name; }
      }
      return account;
    };
  }
  hub.watchCanView=(room,actor)=>watch.canView(watch.rooms.get(room.roomId),actor);
  const watchRoutes = watchHttp({ config, watch, hub, user, webActor, body, json, oauthFetch, throttle, browserLogin, cookies, discordIdentity, validIdentity, registry, entryPolicy, cookie, accounts, logins, plexAuth });
  async function discordStart(req,res,linkLogin,ownerOnly=false) {
    if(config.accessPolicy && !config.accessPolicy.discord&&!ownerOnly)throw new Error('Discord authorization is disabled');
    const state=randomBytes(32).toString('hex');oauthStates.set(state,{expires:Date.now()+300000,ownerOnly,...(linkLogin?{linkUserId:linkLogin.userId,sourceHash:hash(cookies(req).uburoom),revision:linkLogin.accountRevision}:{})});
    const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.publicUrl+'/auth/callback',response_type:'code',scope:'identify',state});
    res.setHeader('Set-Cookie',cookie('uburoom_oauth',state,300));
    const destination=config.demo&&plexAuth?.demo?config.publicUrl+'/demo-discord?state='+state:authorizeUrl+'?'+query;
    if(linkLogin)json(res,200,{url:destination});else{res.writeHead(302,{Location:destination});res.end();}
  }
  const accountRoutes=accountHttp({config,registry,plexAuth,hub,watch,user,protectedPost,webActor,body,json,cookies,cookie,logins,loginStore:accounts,discordStart,throttle});
  const operatorRoutes = operatorHttp({ config, registry, editor: config.configFile ? createConfigEditor(config.configFile) : undefined,
    user, protectedPost, validIdentity, logins, cookies, body, json });
  const server = https.createServer({ cert: config.cert, key: config.key, minVersion: 'TLSv1.2' }, (req, res) => {
    const start = Date.now();
    const logger = config.logger;
    if (logger && config.logging?.requests) {
      res.on('finish', () => {
        const route = req.url ? req.url.split('?')[0] : '';
        const isStatic = route.startsWith('/vendor/') || route.endsWith('.js') || route.endsWith('.css') || route.endsWith('.svg') || route.endsWith('.wasm') || route.endsWith('.woff2') || route === '/favicon.ico';
        if (isStatic && res.statusCode < 400 && !logger.isLevelEnabled('debug')) return;
        const duration = Date.now() - start;
        const msg = `${req.method} ${route} ${res.statusCode} ${duration}ms`;
        if (res.statusCode >= 500) {
          logger.error('HTTP', msg);
        } else if (res.statusCode >= 400) {
          logger.warn('HTTP', msg);
        } else {
          logger.info('HTTP', msg);
        }
      });
    }
    let operatorSettingsFlushed = false;
    if(registry&&req.url?.split('?')[0]!=='/health'){
      const end=res.end.bind(res);
      res.end=(...args)=>{
        if (operatorSettingsFlushed) return end(...args);
        registry.flush().then(()=>end(...args),()=>res.destroy());return res;
      };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
    (async () => {
      const url = new URL(req.url, config.publicUrl), route = url.pathname;
      const activityOrigin = /^\d{17,20}$/.test(config.clientId || '') ? `https://${config.clientId}.discordsays.com` : undefined;
      let activityContext = url.searchParams.has('frame_id');
      let activityQuery = url.search;
      if (activityOrigin) {
        try {
          const referrer = new URL(req.headers.referer);
          if (referrer.origin === activityOrigin) { activityContext = true; activityQuery ||= referrer.search; }
        } catch {}
        activityContext ||= req.headers.origin === activityOrigin || req.headers.host === new URL(activityOrigin).host;
      }
      if (req.method === 'GET' && (route === '/' || activityContext && ['/activity', '/auth/discord', '/auth/callback'].includes(route))) {
        res.writeHead(302, {Location:'/watch' + activityQuery}); return res.end();
      }
      if (await watchRoutes.route(req, res, url)) return;
      if (await accountRoutes.route(req,res,url)) return;
      if (!throttle(req.socket.remoteAddress || 'local', 180)) return json(res, 429, { error: 'Too many requests; try again shortly' });
      if (await operatorRoutes.route(req, res, url, (status, value) => {
        operatorSettingsFlushed = true; json(res, status, value);
      })) return;
      if (req.method === 'GET' && route === '/api/operator/settings') {
        const login = await user(req);
        const current = () => !!login && logins.get(hash(cookies(req).uburoom || '')) === login &&
          validIdentity(login) && (login.expires === null || login.expires > Date.now());
        if (!current()) return json(res, 401, { error: 'Sign in to read operator settings' });
        if (!isServerOperator(registry, config, login.userId)) return json(res, 403, { error: 'Server operator required' });
        // Flush before the final checks, rather than deferring res.end: logout,
        // account changes or operator removal during persistence must win.
        await registry.flush();
        operatorSettingsFlushed = true;
        if (!current()) return json(res, 401, { error: 'Sign in to read operator settings' });
        if (!isServerOperator(registry, config, login.userId)) return json(res, 403, { error: 'Server operator required' });
        return json(res, 200, runningSettings(config));
      }
      const watchDocument = route === '/watch' || route === '/activity';
      // The watch page needs a per-response nonce for OverlayScrollbars' own inline <style>.
      const scrollbarStyleNonce = watchDocument ? randomBytes(16).toString('base64') : undefined;
      const player = watchDocument || route === '/__diagnostics/codec';
      const plexDeliveryOrigins = watchDocument && !activityContext && config.plexDelivery?.mode === 'auto' && watchRoutes.deliveryOrigins ? await watchRoutes.deliveryOrigins(req) : (config.plexDelivery?.clientUrl ? [config.plexDelivery.clientUrl] : []);
      const plexOrigin = watchDocument && !activityContext && config.plexDelivery?.mode === 'auto' ? plexDeliveryOrigins.map(origin => ' ' + origin).join('') : '';
      if (player) res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'${scrollbarStyleNonce ? ` 'nonce-${scrollbarStyleNonce}'` : ''}; connect-src 'self'${plexOrigin}; media-src 'self' blob:${plexOrigin}; worker-src 'self' blob:; img-src 'self' blob: data:; frame-src 'self'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com; form-action 'self'`);
      const subtitleAsset=/^\/vendor\/subtitles\/(jassub(?:-worker(?:-modern)?)?\.(?:js|wasm)|libbitsub(?:-renderer)?\.js|libbitsub_bg\.wasm|default\.woff2)$/.exec(route);
      if(req.method==='GET' && subtitleAsset){
        const name=subtitleAsset[1],type=name.endsWith('.wasm')?'application/wasm':name.endsWith('.woff2')?'font/woff2':'text/javascript';
        if(name.endsWith('.js'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:");
        const content = await readAsset(path.join(__dirname,'../web/vendor/subtitles',name));
        res.writeHead(200,{'Content-Type':type});return res.end(content);
      }
      // Synthetic samples only. Production requires current admission and active
      // Admin mode, including when requested with an Activity bearer identity.
      const testSamples = { 'sample.mp4':'sync-test.mp4', 'h264-baseline.mp4':'h264-baseline.mp4',
        'h264-main.mp4':'h264-main.mp4', 'vp8.webm':'vp8.webm', 'vp9.webm':'vp9.webm', 'av1.webm':'av1.webm', 'hevc.mp4':'hevc.mp4' };
      const sampleName = route.startsWith('/__diagnostics/media/') ? route.slice('/__diagnostics/media/'.length) : '';
      if (['GET', 'HEAD'].includes(req.method) && Object.hasOwn(testSamples, sampleName)) {
        if (config.diagnostics !== true) {
          const auth = await watchRoutes.authorized(req);
          if (!auth || !hub.isAdmin(auth.actor)) return json(res,403,{error:'Turn on Admin mode to use the codec tester.'});
        }
        const sampleFile = path.join(__dirname, '../assets/demo', testSamples[sampleName]);
        let stat;
        try { stat = await fsp.stat(sampleFile); } catch { return json(res, 404, { error:'Test sample is missing' }); }
        const size = stat.size, range = req.headers.range;
        let start = 0, end = size - 1;
        if (range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(range);
          if (!match || !match[1] && !match[2]) { res.writeHead(416, { 'Content-Range':`bytes */${size}` }); return res.end(); }
          if (!match[1]) start = Math.max(0, size - Number(match[2]));
          else { start = Number(match[1]); if (match[2]) end = Math.min(end, Number(match[2])); }
          if (!Number.isSafeInteger(start) || start > end || start >= size) { res.writeHead(416, { 'Content-Range':`bytes */${size}` }); return res.end(); }
        }
        const headers = { 'Content-Type':sampleName.endsWith('.webm') ? 'video/webm' : 'video/mp4', 'Content-Length':end - start + 1, 'Accept-Ranges':'bytes' };
        if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
        res.writeHead(range ? 206 : 200, headers);
        if (req.method === 'HEAD') return res.end();
        const source = fs.createReadStream(sampleFile, { start, end });
        source.on('error', () => res.destroy()); res.on('close', () => source.destroy()); source.pipe(res); return;
      }
      if (req.method === 'GET' && route === '/health') return json(res, registry?.persistence.error?503:200, { ok: !registry?.persistence.error, version });
      if(req.method==='GET'&&['/demo-plex','/demo-discord'].includes(route)&&!config.demo)return json(res,404,{error:'Not found'});
      if (req.method === 'GET' && route === '/auth/handoff') {
        const content = await readAsset(path.join(publicDir, 'handoff.html'));
        res.setHeader('Set-Cookie', cookie('uburoom_handoff', randomBytes(32).toString('hex'), 60));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(content);
      }
      const branding = {
        '/assets/branding/uburoom-wordmark-brand.svg': ['uburoom-wordmark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/assets/branding/uburoom-oomark-brand.svg': ['uburoom-oomark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/favicon.svg': ['uburoom-oomark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/favicon.ico': ['uburoom-favicon.ico', 'image/vnd.microsoft.icon']
      };
      if (req.method === 'GET' && branding[route]) {
        const [file, type] = branding[route];
        const content = await readAsset(path.join(publicDir, 'assets', file));
        res.writeHead(200, { 'Content-Type': type });
        return res.end(content);
      }
      if (req.method === 'GET' && route === '/theme.js') {
        const [wordmark, favicon, themeScript] = await Promise.all([
          readAsset(path.join(publicDir,'assets',branding['/assets/branding/uburoom-wordmark-brand.svg'][0]),'utf8'),
          readAsset(path.join(publicDir,'assets',branding['/favicon.svg'][0]),'utf8'),
          readAsset(path.join(publicDir,'theme.js'),'utf8')
        ]);
        const sources={
          '/assets/branding/uburoom-wordmark-brand.svg': wordmark,
          '/favicon.svg': favicon
        };
        res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});
        return res.end('window.uburoomBrandAssets='+JSON.stringify(sources)+';\n'+themeScript);
      }
      const assets = {
        '/icons.js': ['icons.js', 'text/javascript'],
        '/assets/discord-symbol-white.svg': ['assets/discord-symbol-white.svg', 'image/svg+xml'],
        '/assets/plex-icon.png': ['assets/plex-icon.png', 'image/png'],
        '/assets/branding/uburoom-oomark-mono.svg': ['assets/branding/uburoom-oomark-mono.svg', 'image/svg+xml'],
        '/watch-sync.mjs': ['watch-sync.mjs', 'text/javascript'],
        '/watch': ['watch.html', 'text/html'], '/activity': ['watch.html', 'text/html'],
        '/playback-policy.js':['playback-policy.js','text/javascript'],
        '/playback-diagnostics.js':['playback-diagnostics.js','text/javascript'],
        '/watch-subtitles.js':['watch-subtitles.js','text/javascript'],
        '/watch-dialogs.js':['watch-dialogs.js','text/javascript'],
          '/watch-player-ui.js':['watch-player-ui.js','text/javascript'],
        '/watch-layout.js':['watch-layout.js','text/javascript'],
        '/watch-player.css':['watch-player.css','text/css'],
        '/watch-transport.js':['watch-transport.js','text/javascript'],
        '/watch-rooms-ui.js':['watch-rooms-ui.js','text/javascript'],
        '/watch-controls.js':['watch-controls.js','text/javascript'],
        '/watch-toasts.js':['watch-toasts.js','text/javascript'],
        '/watch-feedback.js':['watch-feedback.js','text/javascript'],
        '/ubumfa.js':['ubumfa.js','text/javascript'],
        '/watch-queue-ui.js':['watch-queue-ui.js','text/javascript'],
        '/watch-queue.css':['watch-queue.css','text/css'],
        '/subtitle-renderers.js':['subtitle-renderers.js','text/javascript'],
        '/playback-timing.js':['playback-timing.js','text/javascript'],
        '/sync-quality.js':['sync-quality.js','text/javascript'],
        '/auth/error':['auth-error.html','text/html'],'/auth-error.js':['auth-error.js','text/javascript'],'/demo-discord':['demo-discord.html','text/html'],'/demo-discord.js':['demo-discord.js','text/javascript'],'/demo-plex':['demo-plex.html','text/html'],'/demo-plex.js':['demo-plex.js','text/javascript'],'/server-settings.js':['server-settings.js','text/javascript'],'/account.js':['account.js','text/javascript'],'/handoff.js': ['handoff.js', 'text/javascript'], '/watch.js': ['watch.js', 'text/javascript'], '/watch-library.js': ['watch-library.js','text/javascript'], '/watch-library.css': ['watch-library.css','text/css'], '/watch-av1.js': ['watch-av1.js', 'text/javascript'], '/watch.css': ['watch.css', 'text/css'], '/watch-scrollbars.js': ['watch-scrollbars.js', 'text/javascript'], '/watch-sidebar.js': ['watch-sidebar.js', 'text/javascript'], '/watch-scrollbars.css': ['watch-scrollbars.css', 'text/css'], '/vendor/overlayscrollbars/overlayscrollbars.browser.es6.min.js': ['vendor/overlayscrollbars/overlayscrollbars.browser.es6.min.js', 'text/javascript'], '/vendor/overlayscrollbars/overlayscrollbars.css': ['vendor/overlayscrollbars/overlayscrollbars.css', 'text/css'], '/vendor/discord-sdk.js': ['vendor/discord-sdk.js', 'text/javascript'] };
      if (req.method === 'GET' && ['/room-protocol.js', '/picture.js', '/engine.js'].includes(route)) {
        const content = await readAsset(path.join(__dirname, '../shared', route.slice(1)));
        res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(content);
      }
      const diagnosticAssets = { '/__diagnostics/codec': ['codec.html', 'text/html'], '/__diagnostics/codec.js': ['codec.js', 'text/javascript'], '/__diagnostics/codec.css': ['codec.css', 'text/css'] };
      if (req.method === 'GET' && diagnosticAssets[route]) {
        const [file, type] = diagnosticAssets[route];
        const content = await readAsset(path.join(__dirname, '../diagnostics', file));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(content);
      }
      if (req.method === 'GET' && route === '/vendor/hls.js') {
        const content = await readAsset(path.join(__dirname, '../node_modules/hls.js/dist/hls.min.js'));
        res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(content);
      }
      if (req.method === 'GET' && assets[route]) {
        const [file, type] = assets[route];
        if(file==='watch.html'){
          const [initial, template] = await Promise.all([
            watchRoutes.bootstrap(req),
            readAsset(path.join(publicDir,file),'utf8')
          ]);
          const html=watchPage(template,initial,scrollbarStyleNonce);
          res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(html);
        }
        const content = await readAsset(path.join(publicDir, file));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(content);
      }
      if (req.method === 'GET' && route === '/api/me') {
        const login = await user(req);
        renewCookie(req, res, login, true);
        return json(res, 200, { oauthReady, loggedIn: !!login, csrf: login?.csrf, owner:!!login&&hub.isOwner(webActor(login)), name: login?.name, adminMode:!!login && hub.isAdmin(webActor(login)) });
      }
      if (req.method === 'POST' && route === '/api/admin-mode') {
        const login = await protectedPost(req), data = await body(req);
        if (login) await hub.refreshAdmin?.(webActor(login));
        if (!login || !hub.canAdmin(webActor(login)) || typeof data.enabled !== 'boolean') return json(res,403,{error:'Only an authorized administrator can change Admin mode'});
        hub.setAdminMode(webActor(login),data.enabled); return json(res,200,{adminMode:hub.isAdmin(webActor(login))});
      }
      if (req.method === 'GET' && ['/auth/discord','/auth/owner'].includes(route)) {
        if (!oauthReady) return json(res, 503, { error: 'Configure Discord OAuth on the server first' });
        return discordStart(req,res,undefined,route==='/auth/owner');
      }
      if (req.method === 'GET' && route === '/auth/callback') {
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        const attempt = oauthStates.get(state); oauthStates.delete(state);
        if (!oauthReady || !state || cookies(req).uburoom_oauth !== state || !attempt || attempt.expires <= Date.now() || !code || code.length > 512) return json(res, 403, { error: 'Invalid or expired login; start again' });
        const linking=attempt.linkUserId?await user(req):undefined;
        if(attempt.linkUserId&&(!linking||linking.userId!==attempt.linkUserId||hash(cookies(req).uburoom||'')!==attempt.sourceHash||linking.accountRevision!==attempt.revision))return json(res,403,{error:'Account changed during linking; start again'});
        const token = await discordFetch('https://discord.com/api/oauth2/token', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code,
            redirect_uri: config.publicUrl + '/auth/callback' }) });
        const identity = await discordFetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } });
        if(attempt.ownerOnly&&identity.id!==config.ownerId)return json(res,403,{error:'This sign-in is reserved for the configured installation owner'});
        if(linking){
          if((await user(req))!==linking)return json(res,403,{error:'Account sign-in expired during linking'});
          accountRoutes.verifiedLink(req,linking,'discord',identity.id,String(identity.username||identity.global_name||'Discord user').slice(0,100));
          res.writeHead(302,{Location:'/watch?account=1','Set-Cookie':cookie('uburoom_oauth','',0)});return res.end();
        }
        if (!config.accessPolicy && !await hub.access?.refresh(identity.id)) return json(res, 403, { error: 'Sign in as a member of the configured Discord server; the bot must be connected.' });
        const id = randomBytes(32).toString('hex');
        const name = String(identity.username || identity.global_name || 'Discord user').slice(0, 100);
        if (identity.id === config.ownerId) hub.setOwnerName(name);
        logins.set(hash(id), { ...discordIdentity({userId:identity.id,name}),csrf: randomBytes(32).toString('hex'), expires: null,
          ...(typeof token.refresh_token === 'string' && Number.isFinite(token.expires_in) && token.expires_in > 0 ? {
            oauth: { refreshToken: token.refresh_token, expires: Date.now() + token.expires_in * 1000 }
          } : {}) });
        accounts.save();
        const destination = '/watch';
        res.writeHead(302, { Location: destination, 'Set-Cookie': [cookie('uburoom', id, loginSeconds), cookie('uburoom_oauth', '', 0)] }); return res.end();
      }
      if (req.method === 'POST' && route === '/api/logout') {
        // Sign-out needs the existing cookie and CSRF proof, not current provider
        // eligibility: revocation or an upstream outage must not trap a login.
        const token=cookies(req).uburoom,id=token&&hash(token),login=id&&logins.get(id);
        if (!login || req.headers.origin!==config.publicUrl || req.headers['x-csrf-token']!==login.csrf) return json(res,403,{error:'Not authorized'});
        hub.clearAdmin(webActor(login));
        logins.delete(id);cookieRenewedAt.delete(id);accounts.save();
        await watchRoutes.logout(id);
        res.setHeader('Set-Cookie', cookie('uburoom', '', 0)); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    })().catch(error => { if (!res.headersSent) json(res, error.status === 503 ? 503 : 400, {
      error: error.status === 503 ? 'Discord login renewal temporarily unavailable; try again shortly' : 'Request failed; check configuration or try again'
    }); else res.end(); });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const watchConnections=watchSockets({server,config,routes:watchRoutes,watch,hub,throttle,flush:()=>registry?.flush()});
  const sweep = setInterval(() => {
    watch.sweep(); watchRoutes.sweep(); accountRoutes.sweep();
    let expired = false;
    for (const [id, s] of logins) if (s.expires !== null && s.expires <= Date.now()) { logins.delete(id); expired = true; }
    if (expired) Promise.resolve(accounts.save()).catch(()=> (config.logger ? config.logger.error('Storage', 'Login storage unavailable') : console.error('[uburoom] Login storage unavailable')));
    for (const id of cookieRenewedAt.keys()) if (!logins.has(id)) cookieRenewedAt.delete(id);
    for (const [id, attempt] of oauthStates) if (attempt.expires <= Date.now()) oauthStates.delete(id);
    for (const [id, bucket] of limits) if (Date.now() - bucket.at > 60000) limits.delete(id);
  }, 1000);
  sweep.unref();
  function close() {
    clearInterval(sweep); watchConnections.close(); const mediaClosed = watch.close(); watchRoutes.close();accountRoutes.close(); hub.close(); assetCache.clear();
    return Promise.all([mediaClosed, new Promise(resolve => server.listening ? server.close(resolve) : resolve())]).then(() => registry?.close());
  }
  return { server, hub, watch, close, registry, plexAuth };
  } catch(error) { Promise.resolve(registry?.persistence.abort()).catch(()=>{});throw error; }
}
module.exports = { createApp };
