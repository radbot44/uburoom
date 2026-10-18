'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createHash } = require('node:crypto');
const { WebSocketServer } = require('ws');
const { Hub, hash, UUID } = require('./core');
const { DeviceLogin, FIREFOX_REDIRECT } = require('./login');
const { deviceStore, loginStore } = require('./storage');
const RemoteUI = require('../web/remote-ui');
const Engine = require('../shared/engine');
const { Plex } = require('./plex');
const { Watch } = require('./watch');
const { watchHttp } = require('./watch-http');
const { watchSockets } = require('./watch-socket');
const { Accounts, credentialVault } = require('./accounts');
const { PlexAuth } = require('./plex-auth');
const { accountHttp } = require('./account-http');
const version = require('../package.json').version;
const { resilientFetch } = require('./resilience');

function createApp(config, { authorizeUrl = 'https://discord.com/oauth2/authorize', oauthFetch = fetch, plexFetch = fetch, plexDemo } = {}) {
  let registry;
  try {
  oauthFetch=resilientFetch(oauthFetch,{timeoutMs:10000});
  if(config.accountFile&&!config.credentialKeyFile)throw new Error('Configure a private uburoom credential key file outside the project');
  if(config.accountFile&&!fs.existsSync(config.accountFile)&&['devices.json','logins.json'].some(name=>fs.existsSync(path.join(path.dirname(config.accountFile),name))))throw new Error('Legacy private state found without a baseline database; review a backup and manual transfer or reset before starting');
  if(config.accountFile&&fs.existsSync(config.accountFile)&&!fs.existsSync(config.credentialKeyFile))throw new Error('The uburoom credential key is missing; restore the original key before starting');
  const vault=config.accountFile||config.unifiedAccounts?credentialVault(config.credentialKeyFile):undefined;
  registry=vault?new Accounts(config.accountFile,vault):undefined;
  const store = deviceStore(registry);
  const accounts = loginStore(JSON.stringify([config.publicUrl, config.ownerId, config.guildId, config.clientId]),vault,registry);
  // Browsers require a finite cookie lifetime; renew it on each account visit.
  // Server logins have no fixed lifetime; Discord renewal/revocation governs them.
  const loginSeconds = 365 * 24 * 60 * 60, renewals = new Map(), cookieRenewedAt = new Map();
  const hub = new Hub(config, store.devices), deviceLogin = new DeviceLogin();
  hub.ownerName = accounts.ownerName;
  hub.setOwnerName = name => {
    if (typeof name !== 'string' || !name || name === accounts.ownerName) return;
    hub.ownerName = accounts.ownerName = name.slice(0, 100);
    for (const s of hub.rooms.values()) s.ownerName = hub.ownerName;
    accounts.save();
  };
  const logins = accounts.logins, oauthStates = new Map(), limits = new Map();
  function discordIdentity(identity) {
    if(!registry)return identity;
    const account=registry.resolve('discord',identity.userId,identity.name);
    return {...identity,userId:account.id,accountRevision:account.revision};
  }
  function validIdentity(identity) {if(!registry)return true;const account=registry.canonical(identity.userId);return !!account&&account.id===identity.userId&&account.revision===identity.accountRevision;}
  const publicDir = path.join(__dirname, '../web');
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
    if (!(hub.access?.canWatch?hub.access.canWatch(login.userId):hub.access?.isMember(login.userId)) && !await (hub.access?.refreshWatch||hub.access?.refresh)?.(login.userId)) return;
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
  function extensionRequest(req) {
    return !req.headers.origin || /^moz-extension:\/\/[0-9a-f-]+$/i.test(req.headers.origin);
  }
  // Web requests are bound to the configured guild and its approved command context.
  // These actor fields come from the server/login, never from the caller's JSON.
  function webActor(login) { return { userId: login.userId, ...(registry?{discordId:registry.identities(login.userId).find(i=>i.provider==='discord')?.subject}:{}),name: login.name, guildId: config.guildId, channelId: config.channels[0], surface: 'web' }; }
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
  if(config.demo&&plexAuth)plexAuth.demo=plexDemo;
  if(registry){
    let rawAccess;
    const discordId=id=>registry.canonical(id)?registry.identities(id).find(i=>i.provider==='discord')?.subject:id;
    const access={
      isMember:id=>{const discord=discordId(id);return !!discord&&!!rawAccess?.isMember(discord);},
      refresh:async id=>{const discord=discordId(id);return !!discord&&!!await rawAccess?.refresh(discord);},
      voiceChannel:id=>{const discord=discordId(id);return discord&&rawAccess?.voiceChannel(discord);},
      identity:async id=>rawAccess?.identity?rawAccess.identity(id):await rawAccess?.refresh(id)?{id,name:registry.identity('discord',id)?.name||id}:undefined,
      validVoiceChannel:id=>!!rawAccess?.validVoiceChannel(id),options:()=>rawAccess?.options()||{available:false},
      canWatch:id=>access.isMember(id)||!!registry.canonical(id)&&plexAuth.fresh(id),
      refreshWatch:async id=>{if(access.isMember(id)||await access.refresh(id))return true;try{return !!await plexAuth.forUser(id);}catch{return false;}}
    };
    Object.defineProperty(hub,'access',{get:()=>access,set:value=>{rawAccess=value;}});
    hub.accountActor=actor=>registry.canonical(actor.userId)?actor:{...actor,...discordIdentity({userId:actor.userId,name:actor.name||'Discord user'}),discordId:actor.userId};
    hub.plexFor=async actor=>{
      const identity=registry.identities(actor.userId).find(i=>i.provider==='plex');
      if(!identity||!registry.hasCredential(identity.subject))return plex;
      const scoped=await plexAuth.forUser(actor.userId);if(!scoped)throw new Error('Connect your Plex account again');return scoped;
    };
  }
  const watch = new Watch(hub, plex, fs.existsSync(demoFile) ? { kind: 'demo', title: 'uburoom synchronization test', duration: 60, format: 'file', quality: 'direct', file: demoFile } : undefined, registry);
  hub.watchCanView=(room,actor)=>watch.canView(watch.rooms.get(room.roomId),actor);
  const watchRoutes = watchHttp({ config, watch, hub, user, webActor, body, json, oauthFetch, throttle, browserLogin, cookies, discordIdentity, validIdentity, registry });
  async function discordStart(req,res,linkLogin,extension) {
    const state=randomBytes(32).toString('hex');oauthStates.set(state,{expires:Date.now()+300000,loginId:extension,...(linkLogin?{linkUserId:linkLogin.userId,sourceHash:hash(cookies(req).uburoom),revision:linkLogin.accountRevision}:{})});
    const query=new URLSearchParams({client_id:config.clientId,redirect_uri:config.publicUrl+'/auth/callback',response_type:'code',scope:'identify',state});
    res.setHeader('Set-Cookie',cookie('uburoom_oauth',state,300));
    const destination=config.demo&&plexAuth?.demo?config.publicUrl+'/demo-discord?state='+state:authorizeUrl+'?'+query;
    if(linkLogin)json(res,200,{url:destination});else{res.writeHead(302,{Location:destination});res.end();}
  }
  const accountRoutes=accountHttp({config,registry,plexAuth,hub,watch,user,protectedPost,webActor,body,json,cookies,cookie,logins,loginStore:accounts,discordStart,throttle});
  const server = https.createServer({ cert: config.cert, key: config.key, minVersion: 'TLSv1.2' }, (req, res) => {
    if(registry&&req.url?.split('?')[0]!=='/health'){
      const end=res.end.bind(res);
      res.end=(...args)=>{registry.flush().then(()=>end(...args),()=>res.destroy());return res;};
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const styleHash = createHash('sha256').update(RemoteUI.CSS).digest('base64');
    const badgeHash = createHash('sha256').update(RemoteUI.BADGE_CSS).digest('base64');
    res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self'; style-src 'self' 'sha256-${styleHash}'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`);
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
      const player = route === '/watch' || route === '/activity' || config.diagnostics === true && route === '/__diagnostics/codec';
      if (player) res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'sha256-${styleHash}' 'sha256-${badgeHash}'; connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:; img-src 'self' blob:; frame-src 'self'; base-uri 'none'; frame-ancestors 'self' https://discord.com https://*.discord.com https://*.discordsays.com; form-action 'self'`);
      const subtitleAsset=/^\/vendor\/subtitles\/(jassub(?:-worker(?:-modern)?)?\.(?:js|wasm)|libbitsub(?:-renderer)?\.js|libbitsub_bg\.wasm|default\.woff2)$/.exec(route);
      if(req.method==='GET' && subtitleAsset){
        const name=subtitleAsset[1],type=name.endsWith('.wasm')?'application/wasm':name.endsWith('.woff2')?'font/woff2':'text/javascript';
        if(name.endsWith('.js'))res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; worker-src 'self' blob:");
        res.writeHead(200,{'Content-Type':type});return res.end(fs.readFileSync(path.join(__dirname,'../web/vendor/subtitles',name)));
      }
      // Only explicit diagnostics may serve these non-private fixtures. No Plex/session grant.
      const testSamples = { 'sample.mp4':'sync-test.mp4', 'h264-baseline.mp4':'h264-baseline.mp4',
        'h264-main.mp4':'h264-main.mp4', 'vp8.webm':'vp8.webm', 'vp9.webm':'vp9.webm', 'av1.webm':'av1.webm', 'hevc.mp4':'hevc.mp4' };
      const sampleName = route.startsWith('/__diagnostics/media/') ? route.slice('/__diagnostics/media/'.length) : '';
      if (config.diagnostics === true && ['GET', 'HEAD'].includes(req.method) && Object.hasOwn(testSamples, sampleName)) {
        const sampleFile = path.join(__dirname, '../assets/demo', testSamples[sampleName]);
        if (!fs.existsSync(sampleFile)) return json(res, 404, { error:'Test sample is missing' });
        const size = fs.statSync(sampleFile).size, range = req.headers.range;
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
        res.setHeader('Set-Cookie', cookie('uburoom_handoff', randomBytes(32).toString('hex'), 60));
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(publicDir, 'handoff.html')));
      }
      const branding = {
        '/assets/branding/uburoom-wordmark-brand.svg': ['uburoom-wordmark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/assets/branding/uburoom-oomark-brand.svg': ['uburoom-oomark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/favicon.svg': ['uburoom-oomark-brand.svg', 'image/svg+xml; charset=utf-8'],
        '/favicon.ico': ['uburoom-favicon.ico', 'image/vnd.microsoft.icon']
      };
      if (req.method === 'GET' && branding[route]) {
        const [file, type] = branding[route];
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(path.join(publicDir, 'assets', file)));
      }
      const assets = { '/remote-ui.js': ['remote-ui.js', 'text/javascript'],
        '/watch-sync.mjs': ['watch-sync.mjs', 'text/javascript'],
        '/watch': ['watch.html', 'text/html'], '/activity': ['watch.html', 'text/html'],
        '/playback-policy.js':['playback-policy.js','text/javascript'],
        '/playback-diagnostics.js':['playback-diagnostics.js','text/javascript'],
        '/watch-subtitles.js':['watch-subtitles.js','text/javascript'],
        '/watch-player-ui.js':['watch-player-ui.js','text/javascript'],
        '/watch-player.css':['watch-player.css','text/css'],
        '/watch-transport.js':['watch-transport.js','text/javascript'],
        '/subtitle-renderers.js':['subtitle-renderers.js','text/javascript'],
        '/playback-timing.js':['playback-timing.js','text/javascript'],
        '/auth/error':['auth-error.html','text/html'],'/auth-error.js':['auth-error.js','text/javascript'],'/demo-discord':['demo-discord.html','text/html'],'/demo-discord.js':['demo-discord.js','text/javascript'],'/demo-plex':['demo-plex.html','text/html'],'/demo-plex.js':['demo-plex.js','text/javascript'],'/account.js':['account.js','text/javascript'],'/handoff.js': ['handoff.js', 'text/javascript'], '/watch.js': ['watch.js', 'text/javascript'], '/watch-library.js': ['watch-library.js','text/javascript'], '/watch-library.css': ['watch-library.css','text/css'], '/watch-av1.js': ['watch-av1.js', 'text/javascript'], '/watch.css': ['watch.css', 'text/css'], '/vendor/discord-sdk.js': ['vendor/discord-sdk.js', 'text/javascript'] };
      if (req.method === 'GET' && ['/room-protocol.js', '/viewport.js', '/engine.js'].includes(route)) {
        res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(__dirname, '../shared', route.slice(1))));
      }
      const diagnosticAssets = { '/__diagnostics/codec': ['codec.html', 'text/html'], '/__diagnostics/codec.js': ['codec.js', 'text/javascript'], '/__diagnostics/codec.css': ['codec.css', 'text/css'] };
      if (req.method === 'GET' && config.diagnostics === true && diagnosticAssets[route]) {
        const [file, type] = diagnosticAssets[route];
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' });
        return res.end(fs.readFileSync(path.join(__dirname, '../diagnostics', file)));
      }
      if (req.method === 'GET' && route === '/vendor/hls.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(fs.readFileSync(path.join(__dirname, '../node_modules/hls.js/dist/hls.min.js')));
      }
      if (req.method === 'GET' && assets[route]) {
        const [file, type] = assets[route];
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      if (req.method === 'GET' && route === '/api/me') {
        const login = await user(req);
        renewCookie(req, res, login, true);
        return json(res, 200, { oauthReady, loggedIn: !!login, csrf: login?.csrf, owner:!!login&&hub.isOwner(webActor(login)), name: login?.name, adminMode:!!login && hub.isAdmin(webActor(login)),
          devices: login && hub.isAdmin(webActor(login)) ? store.devices.filter(d => d.ownerId === config.ownerId).map(d => ({ id: d.id, pairedAt: d.pairedAt })) : [] });
      }
      if (req.method === 'POST' && route === '/api/admin-mode') {
        const login = await protectedPost(req), data = await body(req);
        if (!login || !hub.isOwner(webActor(login)) || typeof data.enabled !== 'boolean') return json(res,403,{error:'Only the owner can change Admin mode'});
        hub.setAdminMode(webActor(login),data.enabled); return json(res,200,{adminMode:hub.isAdmin(webActor(login))});
      }
      if (req.method === 'GET' && route === '/auth/discord') {
        if (!oauthReady) return json(res, 503, { error: 'Configure Discord OAuth on the server first' });
        const loginId = url.searchParams.get('extension');
        if (loginId && (!deviceLogin.get(loginId) || url.searchParams.get('redirect_uri') !== FIREFOX_REDIRECT)) return json(res, 400, { error: 'Invalid or expired login; start from the extension again' });
        return discordStart(req,res,undefined,loginId);
      }
      if (req.method === 'GET' && route === '/auth/callback') {
        const state = url.searchParams.get('state'), code = url.searchParams.get('code');
        const attempt = oauthStates.get(state); oauthStates.delete(state);
        if (!oauthReady || !state || cookies(req).uburoom_oauth !== state || !attempt || attempt.expires <= Date.now() || !code || code.length > 512) return json(res, 403, { error: 'Invalid or expired login; start again' });
        if (attempt.loginId && !deviceLogin.get(attempt.loginId)) return json(res, 403, { error: 'Login expired; start from the extension again' });
        const linking=attempt.linkUserId?await user(req):undefined;
        if(attempt.linkUserId&&(!linking||linking.userId!==attempt.linkUserId||hash(cookies(req).uburoom||'')!==attempt.sourceHash||linking.accountRevision!==attempt.revision))return json(res,403,{error:'Account changed during linking; start again'});
        const token = await discordFetch('https://discord.com/api/oauth2/token', { method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, grant_type: 'authorization_code', code,
            redirect_uri: config.publicUrl + '/auth/callback' }) });
        const identity = await discordFetch('https://discord.com/api/users/@me', { headers: { Authorization: 'Bearer ' + token.access_token } });
        if(linking){
          if((await user(req))!==linking)return json(res,403,{error:'Account sign-in expired during linking'});
          accountRoutes.verifiedLink(req,linking,'discord',identity.id,String(identity.username||identity.global_name||'Discord user').slice(0,100));
          res.writeHead(302,{Location:'/watch?account=1','Set-Cookie':cookie('uburoom_oauth','',0)});return res.end();
        }
        if (identity.id !== config.ownerId && attempt.loginId) {
          const request = deviceLogin.get(attempt.loginId); deviceLogin.requests.delete(attempt.loginId);
          res.writeHead(302, { Location: FIREFOX_REDIRECT + '#' + new URLSearchParams({ state: request.state, error: 'owner_only' }) }); return res.end();
        }
        if (!await hub.access?.refresh(identity.id)) return json(res, 403, { error: 'Sign in as a member of the configured Discord server; the bot must be connected.' });
        const id = randomBytes(32).toString('hex');
        const name = String(identity.username || identity.global_name || 'Discord user').slice(0, 100);
        if (identity.id === config.ownerId) hub.setOwnerName(name);
        logins.set(hash(id), { ...discordIdentity({userId:identity.id,name}),csrf: randomBytes(32).toString('hex'), expires: null,
          ...(typeof token.refresh_token === 'string' && Number.isFinite(token.expires_in) && token.expires_in > 0 ? {
            oauth: { refreshToken: token.refresh_token, expires: Date.now() + token.expires_in * 1000 }
          } : {}) });
        accounts.save();
        // The completion code goes only to this add-on's fixed Firefox auth URL,
        // never to a caller-selected destination or a polling endpoint.
        const destination = attempt.loginId ? FIREFOX_REDIRECT + '#' + new URLSearchParams(deviceLogin.approve(attempt.loginId, identity.id)) : '/';
        res.writeHead(302, { Location: destination, 'Set-Cookie': [cookie('uburoom', id, loginSeconds), cookie('uburoom_oauth', '', 0)] }); return res.end();
      }
      if (req.method === 'POST' && route === '/api/logout') {
        // Sign-out needs the existing cookie and CSRF proof, not current provider
        // eligibility: revocation or an upstream outage must not trap a login.
        const token=cookies(req).uburoom,id=token&&hash(token),login=id&&logins.get(id);
        if (!login || req.headers.origin!==config.publicUrl || req.headers['x-csrf-token']!==login.csrf) return json(res,403,{error:'Not authorized'});
        if (hub.adminMode && hub.isOwner(webActor(login))) {hub.adminMode=false;hub.adminEpoch++;for(const [pendingId,command]of hub.pending)if(hub.isOwner(command.actor))hub.finish(pendingId,{status:'unavailable',message:'Admin mode changed.'});}
        logins.delete(id);cookieRenewedAt.delete(id);accounts.save();
        await watchRoutes.logout(id);
        res.setHeader('Set-Cookie', cookie('uburoom', '', 0)); return json(res, 200, { ok: true });
      }
      if (req.method === 'POST' && (route === '/api/login/start' || route === '/api/login/finish')) {
        if (!extensionRequest(req) || !throttle('login:' + req.socket.remoteAddress, 30)) return json(res, 403, { error: 'Login unavailable' });
        if (!oauthReady) return json(res, 503, { error: 'Configure Discord OAuth on the server first' });
        const data = await body(req);
        if (route.endsWith('/start')) {
          if (data.redirectUri !== FIREFOX_REDIRECT) return json(res, 400, { error: 'Unsupported Firefox login return URL' });
          const id = deviceLogin.start(data.deviceId, data.challenge, data.state);
          const query = new URLSearchParams({ extension: id, redirect_uri: FIREFOX_REDIRECT });
          return json(res, 200, { id, url: config.publicUrl + '/auth/discord?' + query });
        }
        const result = deviceLogin.finish(data.id, data.verifier, data.code);
        const old = store.devices.findIndex(d => d.id === result.deviceId);
        if (old >= 0) { hub.revoke(result.deviceId); store.devices.splice(old, 1); }
        store.devices.push({ id: result.deviceId, ownerId: result.ownerId, credentialHash: hash(result.credential), pairedAt: new Date().toISOString() });
        store.save(); return json(res, 200, { deviceId: result.deviceId, credential: result.credential });
      }
      if (req.method === 'POST' && route === '/api/devices/revoke') {
        const login = await protectedPost(req); if (!login || !hub.isAdmin(webActor(login))) return json(res, 403, { error: 'Enable Admin mode to manage devices' });
        const data = await body(req), index = store.devices.findIndex(d => d.id === data.id && d.ownerId === config.ownerId);
        if (index < 0) return json(res, 404, { error: 'Device unavailable' });
        hub.revoke(data.id); store.devices.splice(index, 1); store.save(); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'Not found' });
    })().catch(error => { if (!res.headersSent) json(res, error.status === 503 ? 503 : 400, {
      error: error.status === 503 ? 'Discord login renewal temporarily unavailable; try again shortly' : 'Request failed; check configuration or use a fresh pairing code'
    }); else res.end(); });
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  const watchConnections=watchSockets({server,config,routes:watchRoutes,watch,hub,throttle,flush:()=>registry?.flush()});
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if(req.url==='/watch-socket')return;
    if (req.url !== '/ws' || !extensionRequest(req) || !throttle('ws:' + req.socket.remoteAddress, 30)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    const authTimer = setTimeout(() => ws.close(4003, 'Authentication required'), 5000);
    let windowAt = Date.now(), count = 0;
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        if (Date.now() - windowAt > 1000) { windowAt = Date.now(); count = 0; }
        if (++count > 40) return ws.close(4008, 'Rate limit');
        const m = JSON.parse(raw.toString());
        if (!ws.device) {
          if (m.type !== 'auth' || !UUID.test(m.deviceId) || typeof m.credential !== 'string' || m.credential.length !== 64) return ws.close(4003, 'Authentication failed');
          if (!Engine.protocolCompatible(m.protocol)) return ws.close(4006, 'Incompatible remote protocol');
          if (!hub.authenticate(ws, m.deviceId, m.credential)) return ws.close(4003, 'Authentication failed');
          clearTimeout(authTimer); ws.send(JSON.stringify({ type: 'auth-ok', protocol: Engine.PROTOCOL })); return;
        }
        ws.lastSeen = Date.now();
        if (m.type === 'room') hub.update(ws, m);
        else if (m.type === 'sharing-options') {
          ws.send(JSON.stringify({ type: 'sharing-options', ownerName: hub.ownerName, ...(hub.access?.options() || { available: false }) }));
          ws.send(JSON.stringify(hub.voiceMessage()));
        }
        else if (m.type === 'remove') hub.remove(ws, m.roomId);
        else if (m.type === 'ack') hub.ack(ws, m);
        else if (m.type === 'heartbeat') ws.send(JSON.stringify({ type: 'heartbeat-ack' }));
        else ws.close(4002, 'Invalid message');
      } catch { ws.close(4002, 'Invalid message'); }
    });
    ws.on('close', () => { clearTimeout(authTimer); hub.drop(ws); });
  });
  const sweep = setInterval(() => {
    watch.sweep(); watchRoutes.sweep(); accountRoutes.sweep();hub.sweep(); deviceLogin.sweep();
    let expired = false;
    for (const [id, s] of logins) if (s.expires !== null && s.expires <= Date.now()) { logins.delete(id); expired = true; }
    if (expired) Promise.resolve(accounts.save()).catch(()=>console.error('[uburoom] Login storage unavailable'));
    for (const id of cookieRenewedAt.keys()) if (!logins.has(id)) cookieRenewedAt.delete(id);
    for (const [id, attempt] of oauthStates) if (attempt.expires <= Date.now()) oauthStates.delete(id);
    for (const [id, bucket] of limits) if (Date.now() - bucket.at > 60000) limits.delete(id);
  }, 1000);
  sweep.unref();
  function close() {
    clearInterval(sweep); watchConnections.close(); const mediaClosed = watch.close(); watchRoutes.close();accountRoutes.close(); hub.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close(); return Promise.all([mediaClosed, new Promise(resolve => server.close(resolve))]).then(() => registry?.close());
  }
  return { server, hub, store, watch, close, registry, plexAuth };
  } catch(error) { Promise.resolve(registry?.persistence.abort()).catch(()=>{});throw error; }
}
module.exports = { createApp };
