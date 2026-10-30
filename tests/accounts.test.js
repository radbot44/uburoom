'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {Accounts,credentialVault}=require('../server/accounts');
const {createApp}=require('../server/app');
const {accountFixture}=require('../scripts/account-fixture');
const {Plex}=require('../server/plex');
const {PlexAuth}=require('../server/plex-auth');
const {isServerOperator}=require('../server/operator-policy');
const {normalizeConfig}=require('../server/config');
const RoomPolicy=require('../server/room-policy');

test('server operator authority requires an explicit verified provider identity independently of room and media authority', async t => {
  const accounts = new Accounts(undefined, credentialVault());
  t.after(() => accounts.close());
  const discordId = '123456789012345678', adminId = '234567890123456789';
  const config = normalizeConfig({operator:{discord_id:discordId,plex_id:'101'},
    discord:{owner_id:adminId},rooms:{admin_discord_ids:[adminId],admin_plex_ids:['102']}});
  const ordinary = accounts.resolve('discord','345678901234567890','Operator');
  const admin = accounts.resolve('discord',adminId,'Room owner');
  const plexOwner = accounts.resolve('plex','102','Plex token owner');
  accounts.credential('102',{token:'fixture-owner'});
  assert.equal(RoomPolicy.administrator(accounts,config,admin.id),true);
  assert.equal(RoomPolicy.administrator(accounts,config,plexOwner.id),true);
  for (const id of [undefined,'',randomUUID(),discordId,ordinary.id,admin.id,plexOwner.id]) {
    assert.equal(isServerOperator(accounts,config,id),false);
  }
  assert.equal(isServerOperator(undefined,config,admin.id),false);
  // Manual matches reserve identities but cannot confer operator authority.
  const pending = accounts.assign(accounts.preview(discordId,'101'),admin.id);
  assert.equal(isServerOperator(accounts,config,pending),false);
  accounts.resolve('discord',discordId,'Operator',false);
  assert.equal(isServerOperator(accounts,config,pending),false);
  accounts.resolve('discord',discordId,'Verified operator');
  assert.equal(isServerOperator(accounts,config,pending),true);
  assert.equal(RoomPolicy.administrator(accounts,config,pending),false);
  assert.equal(accounts.hasCredential('101'),false,'operator identity grants no Plex credentials');
  assert.equal(isServerOperator(accounts,normalizeConfig({}),pending),false,'no implicit owner or token promotion');
  assert.equal(isServerOperator(accounts,{},pending),false,'older configuration grants none');
  const plexOnly = normalizeConfig({operator:{plex_id:'101'}});
  assert.equal(isServerOperator(accounts,plexOnly,pending),false,'verified Discord cannot prove pending Plex');
  accounts.resolve('plex','101','Verified Plex operator');
  assert.equal(isServerOperator(accounts,plexOnly,pending),true);
  accounts.unlink(pending,'plex','101');
  assert.equal(isServerOperator(accounts,plexOnly,pending),false,'unlink takes effect immediately');
  assert.equal(isServerOperator(accounts,config,pending),true,'the other configured identity still authorizes');
  accounts.link(pending,'plex','103','Ordinary Plex account');
  accounts.credential('103',{token:'fixture-personal'});
  accounts.unlink(pending,'discord',discordId);
  assert.equal(isServerOperator(accounts,config,pending),false);
});

test('traditional PIN sign-in works when PMS rejects JWT resource tokens, with safe stage-specific access errors',async t=>{
  const provider=accountFixture(),accounts=new Accounts(),config={plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
  let jwkRegistered=false,failure;
  const fetcher=async(input,options={})=>{
    const url=new URL(input);
    if(url.pathname==='/api/v2/pins'&&options.body)jwkRegistered=!!JSON.parse(options.body).jwk;
    if(url.hostname==='plex-fixture.invalid'&&(url.pathname==='/'&&failure==='identity'||url.pathname==='/library/sections'&&(failure==='libraries'||jwkRegistered)))return new Response('private-upstream-detail',{status:failure==='identity'?503:401});
    return provider.fetch(input,options);
  };
  const plex=new Plex(config,fetcher),auth=new PlexAuth(config,accounts,plex,fetcher);t.after(()=>{accounts.close();plex.close();});
  const attempt=await auth.start('https://uburoom.example/auth/plex/callback');provider.choose(attempt.pinId,'bob');
  const verified=await auth.finish(attempt);assert.equal(verified.subject,'102');assert.equal(jwkRegistered,false);assert.equal(verified.credential.authType,'traditional');
  assert.ok(provider.requests.some(r=>r.path==='/library/sections'&&r.token==='fixture-server-102'&&r.clientId===attempt.credential.clientId),'PMS sees the verified per-user token and registered client ID');
  failure='libraries';await assert.rejects(auth.validate(verified.credential,'102'),error=>error.revoked&&/library access check failed \(HTTP 401\)/.test(error.message)&&!error.message.includes('fixture-')&&!error.message.includes('private-upstream-detail'));
  failure='identity';await assert.rejects(auth.validate(verified.credential,'102'),/server identity check failed \(HTTP 503\)/);
});

test('previous JWT credentials still renew through their registered signing key',async t=>{
  const provider=accountFixture(),accounts=new Accounts(),config={plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'},plex=new Plex(config,provider.fetch),auth=new PlexAuth(config,accounts,plex,provider.fetch);
  t.after(()=>{accounts.close();plex.close();});
  const {privateKey,publicKey}=require('node:crypto').generateKeyPairSync('ed25519'),clientId=randomUUID(),kid=randomUUID();
  const pin=await auth.request('/pins',{clientId,method:'POST',data:{strong:true,jwk:{...publicKey.export({format:'jwk'}),kid,alg:'EdDSA'}}});provider.choose(String(pin.id),'alice');
  const verified=await auth.finish({pinId:String(pin.id),credential:{clientId,kid,privateKey:privateKey.export({type:'pkcs8',format:'pem'})}});verified.credential.expires=0;
  await auth.validate(verified.credential,'101');assert.ok(verified.credential.expires>Date.now());assert.ok(provider.requests.some(r=>r.path==='/api/v2/auth/token'));
});

test('configured account fallback resolves its own PMS token and keeps discovery credentials separate',async t=>{
  const provider=accountFixture(),accounts=new Accounts(),config={plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',
    plexFallback:{enabled:true,token:'fixture-user-102'},plexDelivery:{mode:'auto',clientUrl:'https://plex.example',fallback:true}};
  let rawChecks=0,rawStatus=401;
  const fetcher=async(input,options={})=>{
    const url=new URL(input),token=options.headers?.['X-Plex-Token'];
    if(url.hostname==='plex-fixture.invalid'&&token==='fixture-user-102'){rawChecks++;return new Response(null,{status:rawStatus});}
    if(url.pathname==='/security/token'){
      assert.equal(token,'fixture-server-102','only the resolved non-owner PMS credential delegates');
      return Response.json({MediaContainer:{token:'transient-resolved-fallback'}});
    }
    if(url.pathname==='/api/v2/resources'){
      assert.equal(token,'fixture-user-102','discovery uses the account credential');
      const response=await provider.fetch(input,options);if(!response.ok)return response;
      return Response.json((await response.json()).map(resource=>({...resource,owned:false,connections:[{uri:'https://plex.example',protocol:'https',relay:false}]})));
    }
    return provider.fetch(input,options);
  };
  const plex=new Plex(config,fetcher),auth=new PlexAuth(config,accounts,plex,fetcher);t.after(()=>{accounts.close();plex.close();});
  const scopes=await Promise.all([auth.fallback(),auth.fallback()]);
  assert.equal(rawChecks,1,'concurrent fallback discovery is collapsed');assert.equal(scopes[0],scopes[1]);
  const scope=scopes[0];assert.equal(scope.token,'fixture-server-102');assert.equal(scope.discoveryToken,'fixture-user-102');
  const {PlexDelivery}=require('../server/plex-delivery'),delivery=new PlexDelivery(config,plex,auth,async()=>auth.fallback());
  const direct=await delivery.file({kind:'plex',format:'file',start:'http://plex-fixture.invalid:32400/library/parts/1/file.mp4',plexContext:scope},{identity:{},actor:{}},async()=>true);
  assert.equal(new URL(direct).searchParams.get('X-Plex-Token'),'transient-resolved-fallback');
  await assert.rejects(scope.json('/library/metadata/999'),error=>error.status===404,'item restrictions never switch to owner access');
  provider.revoked.add('102');auth.clear();await assert.rejects(auth.fallback(),error=>error.revoked===true);
  provider.revoked.clear();auth.clear();rawStatus=403;await assert.rejects(auth.fallback(),error=>error.status===403,'library denials do not trigger token resolution');
});

test('account IDs persist, owner reservations resolve exact subjects, conflicting merges roll back, and credentials are authenticated ciphertext',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-accounts-')),vault=credentialVault(path.join(directory,'key')),file=path.join(directory,'accounts.sqlite');
  let accounts=new Accounts(file,vault);
  try{
    const discord=accounts.resolve('discord','123','Alice'),plex=accounts.resolve('plex','101','Same name');assert.notEqual(discord.id,plex.id);
    assert.equal(accounts.link(discord.id,'plex','101','Alice Plex').conflict.id,plex.id);
    accounts.credential('101',{token:'private-test-token',privateKey:'private-test-key'});
    const raw=accounts.db.prepare('SELECT value FROM credentials').get().value;assert.equal(raw.includes('private-test-token'),false);assert.equal(raw.includes('private-test-key'),false);
    const damaged=JSON.parse(raw);damaged.data=Buffer.alloc(30).toString('base64');assert.throws(()=>vault.open(damaged));
    const survivor=accounts.merge(discord.id,plex.id,discord.id);assert.equal(survivor,discord.id);assert.equal(accounts.canonical(plex.id).id,survivor);
    assert.equal(accounts.credential('101').token,'private-test-token');assert.equal(accounts.canonical(survivor).revision,1);
    const reserved=accounts.assign(accounts.preview('456','102'),discord.id);assert.equal(accounts.resolve('plex','102','Bob').id,reserved);assert.equal(accounts.resolve('discord','456','Bob D').id,reserved);
    const conflict=accounts.resolve('discord','789','Other');assert.throws(()=>accounts.merge(survivor,conflict.id,discord.id));assert.equal(accounts.identity('discord','789').userId,conflict.id);
    await accounts.close();accounts=new Accounts(file,vault);assert.equal(accounts.resolve('plex','101','Alice again').id,survivor);
  }finally{await accounts.close();const resolved=path.resolve(directory);assert.ok(resolved.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(resolved,{recursive:true,force:true});}
});

async function fixture(t, deliveryFetch, overrides={}){
  const provider=accountFixture(),cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:provider.subjects.host,clientId:'100000000000000010',clientSecret:'fixture-secret',guildId:'guild',channels:['commands'],demo:true,unifiedAccounts:true,demoSubjects:provider.subjects,plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner',...overrides};
  const app=createApp(config,{plexFetch:deliveryFetch ? (input,options)=>deliveryFetch(input,options,provider) : provider.fetch,plexDemo:provider,oauthFetch:provider.discordFetch});const members=new Set(Object.values(provider.subjects));
  app.hub.access={identity:async id=>Object.values(provider.subjects).includes(id)?{id,name:'Known Discord user'}:undefined,refresh:async id=>members.has(id),isMember:id=>members.has(id),voiceChannel:id=>members.has(id)?'call':undefined,validVoiceChannel:id=>id==='call',options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));t.after(()=>app.close());config.publicUrl=`https://localhost:${app.server.address().port}`;
  function browser(){const jar=new Map();
    const control=require('./helpers/control-client').controlClient(t,config,cert);
    const request=(route,data,extra={})=>control.handles(route)?control.request(route,data,{Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...extra}):new Promise((resolve,reject)=>{
      const req=https.request({hostname:'localhost',port:app.server.address().port,path:route,method:data===undefined?'GET':'POST',ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json',Cookie:[...jar].map(([k,v])=>k+'='+v).join('; '),...extra}},res=>{
        for(const cookie of res.headers['set-cookie']||[]){const pair=cookie.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}
        const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:res.headers['content-type']?.includes('json')?JSON.parse(raw):raw});});
      });req.on('error',reject);req.end(data===undefined?undefined:JSON.stringify(data));
    });
    const csrf=async()=> (await request('/api/watch/me')).body.csrf;
    const post=async(route,data)=>request(route,data,{'X-CSRF-Token':await csrf()||''});
    const discord=async(persona='host',link=false)=>{const start=link?await post('/api/account/discord/connect',{}):await request('/auth/discord');const url=new URL(link?start.body.url:start.headers.location,config.publicUrl);return request('/auth/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code:persona}));};
    const plex=async(persona='alice',link=false)=>{const start=link?await post('/api/account/plex/connect',{}):await request('/auth/plex');const url=new URL(link?start.body.url:start.headers.location,config.publicUrl);const selected=await request('/auth/plex/demo?'+new URLSearchParams({state:url.searchParams.get('state'),persona}));if(selected.status!==302)return selected;return request(selected.headers.location);};
    return {request,post,discord,plex,jar,csrf};
  }
  return {app,provider,config,members,browser};
}
const tls={skip:!fs.existsSync(path.join(__dirname,'../certs/server-cert.pem'))};

async function savedSettingsFixture(t) {
  const directory=await fs.promises.mkdtemp(path.join(os.tmpdir(),'uburoom-settings-http-'));
  t.after(()=>fs.promises.rm(directory,{recursive:true,force:true}));
  const file=path.join(directory,'selected.yaml'),other=path.join(directory,'other.yaml');
  const source=`# Keep this private fixture comment
secrets:
  entry_password: 'fixture-private-password'
operator:
  discord_id: '100000000000000002'
  plex_id: '101'
discord:
  client_id: '100000000000000010'
  client_secret: 'fixture-private-client-secret'
  owner_id: '100000000000000001'
  guild_id: '100000000000000020'
plex:
  url: 'http://plex-fixture.invalid:32400'
  token: 'fixture-owner'
storage:
  credential_key_file: './original.key'
rooms:
  max_members: 20 # keep this capacity comment
`;
  await fs.promises.writeFile(file,source,{mode:0o600});
  await fs.promises.writeFile(other,source.replace('max_members: 20','max_members: 77'),{mode:0o600});
  const {loadConfig}=require('../server/config');
  const f=await fixture(t,undefined,{...loadConfig(file),accountFile:undefined,credentialKeyFile:undefined});
  const save=async(browser,data,extra={})=>browser.request('/api/operator/settings/saved',data,
    {'X-CSRF-Token':(await browser.request('/api/me')).body.csrf||'',...extra});
  return {...f,directory,file,other,source,save};
}

test('saved operator settings HTTP uses the startup path, preserves the allowlist, rejects stale/unauthorized saves and audits names only',tls,async t=>{
  const f=await savedSettingsFixture(t),endpoint='/api/operator/settings/saved';
  const browser=f.browser(),ordinary=f.browser(),admin=f.browser(),anonymous=f.browser();
  assert.equal((await anonymous.request(endpoint)).status,401);
  assert.equal((await f.save(anonymous,{revision:'a'.repeat(64),changes:{'rooms.max_members':12}})).status,401);
  await browser.discord('guest');await ordinary.discord('guest2');await admin.discord();
  assert.equal((await browser.request('/api/account')).body.serverOperator,true);
  assert.equal((await ordinary.request('/api/account')).body.serverOperator,false);
  assert.equal((await admin.request('/api/account')).body.serverOperator,false,'room owner authority is not server-operator capability');
  const password=f.config.accessPolicy.password;f.config.accessPolicy.password='';
  assert.equal((await admin.post('/api/watch/admin-mode',{enabled:true})).status,200);
  f.config.accessPolicy.password=password;
  for(const denied of [ordinary,admin]) {
    assert.equal((await denied.request(endpoint)).status,403);
    assert.equal((await f.save(denied,{revision:'a'.repeat(64),changes:{'rooms.max_members':12}})).status,403);
  }
  let response=await browser.request(endpoint+'?path='+encodeURIComponent(f.other));
  assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
  const initial=response.body;
  assert.equal(initial.source,'file');assert.match(initial.revision,/^[a-f0-9]{64}$/);
  assert.equal(initial.settings['rooms.max_members'],20);
  assert.deepEqual(initial.settings['transcoding.formats'],['av1']);
  for(const key of ['access.discord','rooms.single_room','rooms.inactive_days','rooms.min_retained','rooms.max_history',
    'operator.discord_id','plex.token','storage.credential_key_file']) assert.equal(Object.hasOwn(initial.settings,key),false);
  const payload={revision:initial.revision,changes:{...initial.settings,'rooms.max_members':12,'transcoding.max_jobs':2}};
  assert.equal((await browser.request(endpoint,payload)).status,403,'save requires CSRF proof');
  assert.equal((await f.save(browser,payload,{Origin:'https://attacker.invalid'})).status,403);
  assert.equal((await f.save(browser,{...payload,path:f.other})).status,400,'client-selected paths are rejected');
  // The editor is fixed at app creation, even if this internal property changes.
  f.config.configFile=f.other;
  response=await f.save(browser,payload);
  assert.equal(response.status,200);assert.deepEqual(response.body,{ok:true,restartRequired:true});
  assert.equal(response.headers['cache-control'],'no-store');
  const saved=await browser.request(endpoint);
  assert.equal(saved.body.settings['rooms.max_members'],12);assert.notEqual(saved.body.revision,initial.revision);
  assert.equal((await browser.request('/api/operator/settings')).body.settings.rooms.limits.maxMembers,20,'saving does not change running configuration');
  assert.equal((await browser.request('/api/watch/me')).status,401,'operator writes do not bypass playback admission');
  const contents=await fs.promises.readFile(f.file,'utf8');
  assert.ok(contents.includes('fixture-private-password'));assert.ok(contents.includes('keep this capacity comment'));
  assert.equal(await fs.promises.readFile(f.other,'utf8'),f.source.replace('max_members: 20','max_members: 77'));
  response=await f.save(browser,payload);assert.equal(response.status,409);assert.equal(response.body.code,'CONFIG_CONFLICT');
  assert.equal((await f.save(browser,{revision:saved.body.revision,changes:{'secrets.entry_password':'do-not-save'}})).body.code,'CONFIG_FORBIDDEN');
  assert.equal((await f.save(browser,{revision:saved.body.revision,changes:{'rooms.max_open':100}})).body.code,'CONFIG_INVALID');
  const events=f.app.registry.db.prepare("SELECT actor,detail FROM audit WHERE action='operator-settings-save'").all();
  assert.equal(events.length,1);
  assert.equal(events[0].actor,f.app.registry.identity('discord',f.provider.subjects.guest).userId);
  assert.deepEqual(JSON.parse(events[0].detail),{settings:Object.keys(payload.changes).sort()});
  const exposed=JSON.stringify([initial,saved.body,response.body,events]);
  for(const value of ['fixture-private-password','fixture-private-client-secret','fixture-owner',f.file,f.other,f.directory,'backupPath']) assert.equal(exposed.includes(value),false);
});

test('saved operator settings rechecks authorization after queueing and immediately before replacement', {...tls,timeout:30000},async t=>{
  const f=await savedSettingsFixture(t),browser=f.browser(),endpoint='/api/operator/settings/saved';await browser.discord('guest');
  const initial=(await browser.request(endpoint)).body;
  const {createConfigEditor}=require('../server/config-editor'),blocker=createConfigEditor(f.other),revision=(await blocker.read()).revision;
  const rename=fs.promises.rename.bind(fs.promises);
  let entered,release;
  const waiting=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
  const mock=t.mock.method(fs.promises,'rename',async(from,to)=>{
    if(to===f.other){entered();await held;}return rename(from,to);
  });
  const blocking=blocker.save({revision,changes:{'rooms.max_members':70}});await waiting;
  const csrf=(await browser.request('/api/me')).body.csrf;
  const received=new Promise(resolve=>{
    const listener=req=>{
      if(req.url!==endpoint||req.method!=='POST')return;
      f.app.server.removeListener('request',listener);req.once('end',()=>setImmediate(resolve));
    };
    f.app.server.on('request',listener);
  });
  const pending=browser.request(endpoint,{revision:initial.revision,changes:{'rooms.max_members':12}},{'X-CSRF-Token':csrf});
  try {
    await received;
    assert.equal((await browser.request('/api/logout',{}, {'X-CSRF-Token':csrf})).status,200);
  } finally {release();}
  await blocking;assert.equal((await pending).status,401);mock.mock.restore();
  assert.equal(await fs.promises.readFile(f.file,'utf8'),f.source,'logout while queued leaves YAML untouched');
  await browser.discord('guest');
  const readFile=fs.promises.readFile.bind(fs.promises);
  const stage=t.mock.method(fs.promises,'readFile',async(target,...args)=>{
    const bytes=await readFile(target,...args);
    if(path.basename(target)==='replacement.yaml')f.app.registry.db.prepare('UPDATE identities SET verified=0 WHERE provider=? AND subject=?').run('discord',f.provider.subjects.guest);
    return bytes;
  });
  assert.equal((await f.save(browser,{revision:initial.revision,changes:{'rooms.max_members':11}})).status,403);
  stage.mock.restore();
  assert.equal(await fs.promises.readFile(f.file,'utf8'),f.source,'authority lost during staging prevents replacement');
  assert.equal(f.app.registry.db.prepare("SELECT COUNT(*) AS n FROM audit WHERE action='operator-settings-save'").get().n,0);
});

test('saved operator settings sanitize write failures and report an audit failure after committed YAML honestly',tls,async t=>{
  const f=await savedSettingsFixture(t),browser=f.browser(),endpoint='/api/operator/settings/saved';await browser.discord('guest');
  const initial=(await browser.request(endpoint)).body,payload={revision:initial.revision,changes:{'rooms.max_members':12}};
  const mock=t.mock.method(fs.promises,'rename',async()=>{throw new Error('private-storage-details '+f.file);});
  let response=await f.save(browser,payload);assert.equal(response.status,503);mock.mock.restore();
  assert.equal(await fs.promises.readFile(f.file,'utf8'),f.source);
  const audit=f.app.registry.audit.bind(f.app.registry),flush=f.app.registry.flush.bind(f.app.registry);
  let fail=false;
  const auditMock=t.mock.method(f.app.registry,'audit',(...args)=>{audit(...args);fail=true;});
  const flushMock=t.mock.method(f.app.registry,'flush',async()=>{if(fail){fail=false;throw new Error('private-storage-details '+f.file);}return flush();});
  response=await f.save(browser,payload);assert.equal(response.status,503);
  auditMock.mock.restore();flushMock.mock.restore();
  assert.equal(response.body.saved,true);assert.equal(response.body.restartRequired,true);
  assert.match(response.body.error,/audit persistence/);
  assert.equal(JSON.stringify(response.body).includes('private-storage-details'),false);assert.equal(JSON.stringify(response.body).includes(f.file),false);
  assert.equal((await browser.request(endpoint)).body.settings['rooms.max_members'],12,'audit failure does not roll back the already-saved file');
});

test('operator settings HTTP uses verified session identities and exposes only nonprivate running settings',tls,async t=>{
  const settings = normalizeConfig({rooms:{max_members:12},directory:{expose_plex_members:true},
    transcoding:{encoder:'software',qualities:[[480,1]]}});
  const f = await fixture(t,undefined,{
    accessPolicy:settings.accessPolicy,roomLimits:settings.roomLimits,roomPermissions:settings.roomPermissions,
    directory:settings.directory,transcoding:settings.transcoding
  });
  f.config.serverOperator={discordId:f.provider.subjects.guest2,plexId:'101'};
  const endpoint='/api/operator/settings',anonymous=f.browser(),ordinary=f.browser(),admin=f.browser(),operator=f.browser(),pending=f.browser();
  let response=await anonymous.request(endpoint+'?userId=101');
  assert.equal(response.status,401);assert.equal(response.headers['cache-control'],'no-store');
  await ordinary.discord('guest');await admin.discord();await pending.plex('bob');
  assert.equal((await admin.post('/api/watch/admin-mode',{enabled:true})).status,200);
  for(const browser of [ordinary,admin,pending]) {
    response=await browser.request(endpoint+'?userId=101',undefined,{'X-User-Id':'101'});
    assert.equal(response.status,403);assert.equal(response.headers['cache-control'],'no-store');
  }
  f.app.registry.assign(f.app.registry.preview(f.provider.subjects.guest2,'102'),'fixture-admin');
  assert.equal((await pending.request(endpoint)).status,401,'assignment invalidates the previous session revision');
  await pending.plex('bob');
  assert.equal((await pending.request(endpoint)).status,403,'a session with an unverified assigned operator identity is denied');
  await operator.plex('alice');
  // Seed private fields at every object depth to catch accidental object spreads.
  const secret='settings-private-marker';
  f.config.unlistedPrivateValue=secret;f.config.accountFile=secret;f.config.credentialKeyFile=secret;
  f.config.tlsCert=secret;f.config.tlsKey=secret;f.config.ffmpegPath=secret;f.config.ffprobePath=secret;
  f.config.plexFallback={enabled:true,token:secret};f.config.plexDelivery={mode:'proxy',clientUrl:secret,lanClientUrl:secret};
  f.config.accessPolicy.password=secret;
  for(const object of [f.config.accessPolicy,f.config.roomLimits,f.config.roomPermissions,
    f.config.roomPermissions.host,f.config.roomPermissions.viewer,f.config.directory,f.config.transcoding,
    f.config.transcoding.qualities[0]]) object.futurePrivate=secret;
  response=await operator.request(endpoint);
  assert.equal(response.status,200);assert.equal(response.headers['cache-control'],'no-store');
  assert.equal(response.body.source,'running');
  assert.deepEqual(response.body.settings.access,{discord:true,plex:true,requirePlex:false,requirePlexInActivity:true,publicWeb:true});
  assert.equal(response.body.settings.rooms.limits.maxMembers,12);
  assert.equal(response.body.settings.rooms.hostPermissions.seek,true);
  assert.deepEqual(response.body.settings.directory,{discord:true,plex:true});
  assert.deepEqual(response.body.settings.transcoding.qualities,[{height:480,mbps:1}]);
  assert.equal(response.body.settings.transcoding.encoder,'software');
  const serialized=JSON.stringify(response.body);
  for(const privateValue of [secret,f.config.plexToken,f.config.plexUrl,f.config.publicUrl,
    f.config.clientSecret,f.config.clientId,f.config.ownerId,f.config.guildId,
    f.provider.subjects.guest2,'101','102','commands']) {
    assert.equal(serialized.includes(JSON.stringify(privateValue)),false,'private value excluded: '+privateValue);
  }
  assert.equal((await operator.request('/api/watch/me')).status,401,'operator status does not bypass the entry password');
  assert.equal((await operator.request(endpoint,{})).status,404,'no settings write operation');
  f.config.accessPolicy.password='';f.config.accessPolicy.discord=false;f.config.accessPolicy.plex=false;
  await anonymous.request('/api/watch/entry',{});
  assert.equal((await anonymous.request(endpoint)).status,403,'anonymous guest sessions gain no authority');
});

test('operator settings rechecks logout, account validity and operator identity after persistence waits', {...tls,timeout:15000}, async t=>{
  const f=await fixture(t,undefined,{accessPolicy:{discord:true,plex:true,requirePlex:false,requirePlexInActivity:true,password:'',publicWeb:true}});
  f.config.serverOperator={discordId:f.provider.subjects.guest,plexId:''};
  const browser=f.browser(),endpoint='/api/operator/settings';await browser.discord('guest');
  const account=f.app.registry.identity('discord',f.provider.subjects.guest);
  assert.equal((await browser.request(endpoint)).status,200,'verified Discord operator is independent of room Admin mode');
  f.config.accessPolicy.requirePlex=true;
  assert.equal((await browser.request(endpoint)).status,200);
  assert.equal((await browser.request('/api/watch/me')).status,401,'operator authority cannot satisfy required personal Plex admission');
  f.config.accessPolicy.requirePlex=false;
  const duringFlush=async change=>{
    const flush=f.app.registry.flush.bind(f.app.registry);
    let entered,release;
    const waiting=new Promise(resolve=>entered=resolve),held=new Promise(resolve=>release=resolve);
    f.app.registry.flush=async()=>{f.app.registry.flush=flush;entered();await held;return flush();};
    const request=browser.request(endpoint);
    try {await waiting;await change();} finally {release();f.app.registry.flush=flush;}
    return request;
  };
  const unverified=await duringFlush(async()=>{
    f.app.registry.db.prepare('UPDATE identities SET verified=0 WHERE provider=? AND subject=?').run('discord',account.subject);
  });
  assert.equal(unverified.status,403);assert.equal(unverified.body.settings,undefined);
  f.app.registry.resolve('discord',account.subject,'Verified again');
  const loggedOut=await duringFlush(async()=>{assert.equal((await browser.post('/api/logout',{})).status,200);});
  assert.equal(loggedOut.status,401);assert.equal(loggedOut.body.settings,undefined);
  await browser.discord('guest');await browser.plex('bob',true);
  f.provider.revoked.add('102');f.app.plexAuth.clear();
  assert.equal((await browser.request(endpoint)).status,200);
  const deniedMedia=await browser.request('/api/watch/library');
  assert.equal(deniedMedia.status,400,'revoked media credentials retain the existing library failure behavior for operators');
  assert.deepEqual(Object.keys(deniedMedia.body),['error']);
  f.provider.revoked.clear();f.app.plexAuth.clear();
  const staleCookie=browser.jar.get('uburoom');
  const removed=await duringFlush(async()=>{
    assert.equal((await browser.post('/api/account/discord/remove',{subject:account.subject})).status,200);
  });
  assert.equal(removed.status,401);assert.equal(removed.body.settings,undefined);
  assert.equal((await browser.request(endpoint)).status,403,'remaining Plex identity is not the configured operator');
  assert.equal((await browser.request(endpoint,undefined,{Cookie:'uburoom='+staleCookie})).status,401);
});

test('direct original delivery isolates delegated credentials and fences private transport recovery',tls,async t=>{
  const delegated=[];
  const f=await fixture(t,async(input,options,provider)=>{
    const url=new URL(input);
    if(url.pathname==='/identity') {
      assert.equal(options.headers['X-Plex-Token'],undefined);
      return Response.json({MediaContainer:{machineIdentifier:'fixture-machine'}});
    }
    if(url.pathname==='/security/token') {
      assert.equal(options.method,'POST');delegated.push(options.headers['X-Plex-Token']);
      return Response.json({MediaContainer:{token:'transient-fixture-'+delegated.length}});
    }
    return provider.fetch(input,options);
  });
  f.config.plexDelivery={mode:'auto',clientUrl:'https://plex-client.invalid:32400',fallback:false};
  const alice=f.browser(),bob=f.browser(),guest=f.browser();await alice.plex('alice');await bob.plex('bob');await guest.discord('guest');
  const roomId=(await alice.post('/api/watch/rooms',{})).body.id,viewerId=randomUUID(),other=randomUUID();
  let state=(await alice.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}`)).body;
  await alice.post(`/api/watch/rooms/${roomId}/command`,{epoch:state.epoch,expiresAt:Date.now()+2500,viewerId,command:{action:'media.load',args:{mediaId:'1',quality:'direct'}}});
  state=(await alice.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}`)).body;
  assert.equal(state.directDelivery,true);assert.equal(new URL(state.mediaUrl).origin,f.config.plexDelivery.clientUrl);
  assert.equal(new URL(state.mediaUrl).searchParams.get('X-Plex-Token'),'transient-fixture-1');
  assert.deepEqual(delegated,['fixture-server-101']);
  assert.equal(JSON.stringify(state).includes('fixture-server-101'),false);assert.equal(JSON.stringify(state).includes('fixture-owner'),false);
  const personal=(await bob.request(`/api/watch/rooms/${roomId}?viewer=${other}`)).body;
  assert.equal(personal.directDelivery,true);assert.notEqual(personal.mediaUrl,state.mediaUrl);
  const sponsored=(await guest.request(`/api/watch/rooms/${roomId}?viewer=${randomUUID()}`)).body;
  assert.match(sponsored.mediaUrl,/^\/api\/watch\/media\//);assert.equal(delegated.includes('fixture-owner'),false);
  const recover={viewerId,mediaVersion:state.mediaVersion,streamVersion:state.streamVersion};
  assert.equal((await bob.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,403);
  assert.equal((await alice.post(`/api/watch/rooms/${roomId}/delivery`,{...recover,streamVersion:randomUUID()})).status,409);
  assert.equal((await alice.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,200);
  const recovered=(await alice.request(`/api/watch/rooms/${roomId}?viewer=${viewerId}`)).body;
  assert.match(recovered.mediaUrl,/^\/api\/watch\/media\//);assert.notEqual(recovered.streamVersion,state.streamVersion);
  assert.equal(recovered.mediaVersion,state.mediaVersion);assert.equal(recovered.state.paused,state.state.paused);
  assert.equal((await alice.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,409);
  assert.equal((await bob.request(`/api/watch/rooms/${roomId}?viewer=${other}`)).body.mediaUrl,personal.mediaUrl);
  f.provider.revoked.add('102');f.app.plexAuth.clear();
  assert.equal((await bob.request(`/api/watch/rooms/${roomId}?viewer=${other}`)).status,401);
});

test('direct HLS shares preparation without server video, keeps own credentials and recovers only the failed viewer',tls,async t=>{
  const delegated=[],starts=[],stops=[];let segments=0;
  const f=await fixture(t,async(input,options,provider)=>{
    const url=new URL(input),json=value=>Response.json({MediaContainer:value});
    if(url.pathname==='/identity')return json({machineIdentifier:'fixture-machine'});
    if(url.pathname==='/security/token'){
      delegated.push(options.headers['X-Plex-Token']);return json({token:'transient-hls-'+delegated.length});
    }
    if(url.pathname==='/library/metadata/1')return json({Metadata:[{ratingKey:'1',type:'movie',title:'Synthetic HLS',duration:60000,Media:[{videoCodec:'h264',bitrate:12000,width:1920,height:1080,Part:[{id:'1',key:'/library/parts/1/file.mp4',Stream:[{id:11,streamType:1,codec:'h264'},{id:12,streamType:2,codec:'aac',selected:true}]}]}]}]});
    if(url.pathname.endsWith('/decision'))return json({Metadata:[{Media:[{videoCodec:'h264',audioCodec:'aac',Part:[{Stream:[{streamType:1,codec:'h264'},{id:12,streamType:2,codec:'aac',selected:1}]}]}]}]});
    if(url.pathname.endsWith('/start.m3u8')){
      const session=url.searchParams.get('session');starts.push(session);
      return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=4000000\n/video/:/transcode/universal/session/'+session+'/index.m3u8\n');
    }
    if(url.pathname.endsWith('/index.m3u8'))return new Response('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\n0.ts\n#EXT-X-ENDLIST\n');
    if(url.pathname.endsWith('.ts')){segments++;const bytes=Buffer.alloc(188*2);bytes[0]=bytes[188]=0x47;return new Response(bytes,{headers:{'Content-Type':'video/mp2t'}});}
    if(url.pathname.endsWith('/stop')){stops.push(url.searchParams.get('session'));return json({});}
    return provider.fetch(input,options);
  });
  f.config.plexDelivery={mode:'auto',clientUrl:'https://plex-client.invalid:32400',lanClientUrl:'https://plex-lan.invalid:32400',fallback:false};
  f.app.watch.delivery.discoveredLanOrigin='https://plex-lan.invalid:32400';
  const alice=f.browser(),bob=f.browser();await alice.plex('alice');await bob.plex('bob');
  const roomId=(await alice.post('/api/watch/rooms',{})).body.id,a=randomUUID(),b=randomUUID();
  const state=(browser,viewer,headers)=>browser.request(`/api/watch/rooms/${roomId}?viewer=${viewer}&quality=720p4`,undefined,headers);
  let initial=(await state(alice,a)).body;
  await alice.post(`/api/watch/rooms/${roomId}/command`,{epoch:initial.epoch,expiresAt:Date.now()+2500,viewerId:a,command:{action:'media.load',args:{mediaId:'1',quality:'720p4'}}});
  const left=(await state(alice,a)).body,right=(await state(bob,b,{'cf-connecting-ip':'172.56.21.89'})).body;
  assert.equal(left.directDelivery,true);assert.equal(right.directDelivery,true);assert.equal(left.format,'hls');
  assert.equal(left.directHls.origin,'https://plex-lan.invalid:32400');assert.equal(right.directHls.origin,'https://plex-client.invalid:32400');
  assert.equal(left.directHls.session,right.directHls.session);assert.deepEqual(delegated,['fixture-server-101','fixture-server-102']);
  assert.notEqual(left.directHls.token,right.directHls.token);assert.equal(starts.length,1);assert.equal(segments,0);assert.equal(f.app.watch.plex.hlsPool.bytes,0);
  const master=await alice.request(left.mediaUrl);assert.equal(master.status,200);
  const child=new URL(master.body.split('\n').find(line=>line.startsWith('https://')));
  assert.equal(child.origin,'https://plex-lan.invalid:32400');assert.equal(child.searchParams.get('X-Plex-Token'),left.directHls.token);
  const wanMaster=await bob.request(right.mediaUrl);assert.equal(wanMaster.status,200);
  const wanChild=new URL(wanMaster.body.split('\n').find(line=>line.startsWith('https://')));
  assert.equal(wanChild.origin,'https://plex-client.invalid:32400');assert.equal(wanChild.searchParams.get('X-Plex-Token'),right.directHls.token);
  const lanCsp=(await alice.request('/watch')).headers['content-security-policy'];
  assert.equal(lanCsp.includes('https://plex-lan.invalid:32400'),true);
  const wanCsp=(await bob.request('/watch',undefined,{'cf-connecting-ip':'172.56.21.89'})).headers['content-security-policy'];
  assert.equal(wanCsp.includes('https://plex-client.invalid:32400'),true);
  assert.equal(wanCsp.includes('https://plex-lan.invalid:32400'),false,'WAN CSP must not expose the LAN origin');
  assert.equal(master.body.includes(right.directHls.token),false);assert.equal(master.body.includes('fixture-server-'),false);
  const recover={viewerId:a,mediaVersion:left.mediaVersion,streamVersion:left.streamVersion};
  assert.equal((await bob.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,403);
  assert.equal((await alice.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,200);
  assert.equal((await alice.request(left.mediaUrl)).status,403);
  const proxy=(await state(alice,a)).body;assert.equal(proxy.directDelivery,undefined);assert.equal(proxy.format,'hls');assert.notEqual(proxy.streamVersion,left.streamVersion);
  assert.equal(starts.length,2);assert.ok(segments>0,'only the explicit proxy recovery may warm a video anchor');
  assert.equal(stops.includes(right.directHls.session),false);assert.deepEqual((await state(bob,b,{'cf-connecting-ip':'172.56.21.89'})).body.directHls,right.directHls);
  assert.equal((await alice.post(`/api/watch/rooms/${roomId}/delivery`,recover)).status,409);
  f.provider.revoked.add('102');f.app.plexAuth.clear();assert.equal((await state(bob,b)).status,401);
});

test('direct fallback requires verified non-ownership and never delegates configured owner credentials',async t=>{
  const {PlexDelivery,clientAddress}=require('../server/plex-delivery');
  const config={plexUrl:'http://plex.invalid:32400',plexToken:'owner',plexDelivery:{mode:'auto',clientUrl:'https://plex.example',fallback:true},plexFallback:{enabled:true,token:'dedicated'}};
  let owned=false,requests=0,publicMachine='machine',live=true,revokeOnDelegate=false,holdIdentity,publicUnavailable=false,identityRequests=0;
  let advertised=[],resourceMachine='machine',publicAddress='71.120.154.212';
  const plex=new Plex(config,async(input,options)=>{
    const url=new URL(input);
    if(url.pathname==='/identity'){identityRequests++;if(publicUnavailable)throw new Error('No NAT loopback');await holdIdentity;return Response.json({MediaContainer:{machineIdentifier:publicMachine}});}
    assert.equal(url.pathname,'/security/token');assert.equal(options.headers['X-Plex-Token'],'dedicated');requests++;
    if(revokeOnDelegate)live=false;
    return Response.json({MediaContainer:{token:'transient-fallback'}});
  });t.after(()=>plex.close());
  let scope=plex.scope('dedicated','configured-fallback');
  const auth={machine:async()=> 'machine',request:async()=>[{clientIdentifier:resourceMachine,provides:'server',owned,publicAddress,connections:advertised}]};
  const context={identity:{},actor:{userId:'guest'}};
  const media=()=>({kind:'plex',format:'file',start:'http://plex.invalid:32400/library/parts/1/file.mp4',plexContext:scope});
  const delivery=()=>new PlexDelivery(config,plex,auth,async()=>scope);
  assert.match(await delivery().file(media(),context,async()=>true),/transient-fallback/);
  publicMachine='another-server';assert.equal(await delivery().file(media(),context,async()=>true),undefined);publicMachine='machine';
  revokeOnDelegate=true;assert.equal(await delivery().file(media(),context,async()=>live),undefined);revokeOnDelegate=false;
  for(const ownership of [true,undefined,'false']) {
    owned=ownership;assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  }
  owned=false;assert.equal(await delivery().file(media(),{...context,identity:{activity:true}},async()=>true),undefined);
  assert.equal(await delivery().file({...media(),format:'hls'},context,async()=>true),undefined);
  assert.equal(await delivery().file(media(),context,async()=>false),undefined);
  let release;holdIdentity=new Promise(resolve=>release=resolve);
  const slow=delivery(),slowMedia=media();assert.equal(await slow.file(slowMedia,context,async()=>true),undefined);
  release();holdIdentity=undefined;await new Promise(resolve=>setImmediate(resolve));
  assert.equal(await slow.file(slowMedia,context,async()=>true),undefined,'late endpoint success cannot replace the selected proxy or mint a token');
  publicUnavailable=true;
  advertised=[{uri:'https://plex.example:443',protocol:'https',relay:false}];
  const probes=identityRequests;
  assert.match(await delivery().file(media(),context,async()=>true),/transient-fallback/,'authenticated discovery permits direct delivery without server NAT loopback');
  assert.equal(identityRequests,probes,'a verified advertised origin does not need server-side public connectivity');
  config.plexDelivery.clientUrl='https://plex.example.attacker.invalid';
  assert.equal(await delivery().file(media(),context,async()=>true),undefined,'origin comparison is exact');
  config.plexDelivery.clientUrl='https://plex.example';resourceMachine='other-machine';
  assert.equal(await delivery().file(media(),context,async()=>true),undefined,'another server cannot attest the client endpoint');resourceMachine='machine';
  advertised=[{uri:'https://plex.example',protocol:'https',relay:true}];
  assert.equal(await delivery().file(media(),context,async()=>true),undefined,'relay metadata does not attest a direct endpoint');
  config.plexFallback.token='';assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  config.plexFallback.token='owner';scope=plex.scope('owner','configured-fallback');assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  scope=plex;assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  config.plexFallback.token='dedicated';scope=plex.scope('dedicated','configured-fallback');
  config.plexDelivery.clientUrl='https://plex.example';
  advertised=[
    {uri:'https://plex.example',protocol:'https',relay:false,local:false},
    {uri:'https://plex-lan.example:32400',protocol:'https',relay:false,local:true}
  ];
  const d=delivery();
  assert.equal(clientAddress({socket:{remoteAddress:'127.0.0.1'},headers:{'cf-connecting-ip':'172.56.21.89'}}),'172.56.21.89');
  assert.equal(clientAddress({socket:{remoteAddress:'::ffff:127.0.0.1'},headers:{'x-forwarded-for':'71.120.154.212, 10.0.0.1'}}),'71.120.154.212');
  assert.equal(clientAddress({socket:{remoteAddress:'203.0.113.5'},headers:{'cf-connecting-ip':'192.168.1.50'}}),'203.0.113.5','public sockets cannot spoof proxy headers');
  const lanFile=await d.file(media(),context,async()=>true,'192.168.1.50');
  assert.equal(new URL(lanFile).origin,'https://plex-lan.example:32400');
  const hairpinnedLanFile=await d.file(media(),context,async()=>true,'71.120.154.212');
  assert.equal(new URL(hairpinnedLanFile).origin,'https://plex-lan.example:32400','LAN viewer behind tunnel matching Plex WAN IP gets LAN origin');
  const wanFile=await d.file(media(),context,async()=>true,'172.56.21.89');
  assert.equal(new URL(wanFile).origin,'https://plex.example');
  assert.deepEqual(await d.deliveryOrigins('192.168.1.50'),['https://plex.example','https://plex-lan.example:32400']);
  assert.deepEqual(await d.deliveryOrigins('71.120.154.212'),['https://plex.example','https://plex-lan.example:32400']);
  assert.deepEqual(await d.deliveryOrigins('172.56.21.89'),['https://plex.example'],'external clients do not receive the local origin in CSP');
  assert.ok(requests >= 5,'only verified endpoint/account combinations request delegation; late revocation suppresses its result');
});

test('logout checks CSRF, revokes only this browser login and its viewers, retains links, and works after access revocation',tls,async t=>{
  const f=await fixture(t),host=f.browser(),other=f.browser(),bob=f.browser();await host.discord();await host.plex('alice',true);await other.plex('alice');await bob.plex('bob');
  const account=(await host.request('/api/account')).body.account,csrf=(await host.request('/api/watch/me')).body.csrf,oldCookie=host.jar.get('uburoom');
  await host.post('/api/watch/admin-mode',{enabled:true});
  const roomId=(await host.post('/api/watch/rooms',{})).body.id,first=randomUUID(),second=randomUUID();await host.request(`/api/watch/rooms/${roomId}?viewer=${first}`);await other.request(`/api/watch/rooms/${roomId}?viewer=${second}`);
  const room=f.app.watch.rooms.get(roomId);assert.equal(room.viewers.size,2);
  assert.equal((await host.request('/api/logout',{})).status,403);assert.equal((await host.request('/api/logout',{}, {'X-CSRF-Token':csrf,Origin:'https://elsewhere.invalid'})).status,403);assert.equal(room.viewers.size,2);
  const result=await host.request('/api/logout',{}, {'X-CSRF-Token':csrf});assert.equal(result.status,200);assert.ok(result.headers['set-cookie'].some(cookie=>cookie.startsWith('uburoom=;')&&cookie.includes('Max-Age=0')));
  assert.equal(room.viewers.has(first),false);assert.equal(room.viewers.has(second),true);assert.equal(f.app.hub.adminMode,false);assert.equal((await other.request('/api/watch/me')).status,200);
  assert.equal((await host.request('/api/watch/me',undefined,{Cookie:'uburoom='+oldCookie})).status,401,'the old cookie cannot be replayed');assert.equal(f.app.registry.summary(account.id).identities.length,2);assert.ok(f.app.registry.credential('101'));
  await host.plex('alice');assert.equal((await host.request('/api/account')).body.account.id,account.id);
  const bobCsrf=(await bob.request('/api/watch/me')).body.csrf;f.provider.revoked.add('102');f.app.plexAuth.clear();assert.equal((await bob.request('/api/watch/me')).status,401);assert.equal((await bob.request('/api/logout',{}, {'X-CSRF-Token':bobCsrf})).status,200,'provider eligibility is not needed to revoke your existing browser session');
});

test('SQLite restart retains UUIDs and encrypted logins without reading or backing up legacy JSON; missing keys fail closed',tls,async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'uburoom-baseline-')),cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:'100000000000000001',guildId:'guild',channels:['commands'],clientId:'100000000000000010',accountFile:path.join(directory,'accounts.sqlite'),credentialKeyFile:path.join(directory,'credentials.key')};
  const legacyFile=path.join(directory,'logins.json');fs.writeFileSync(legacyFile,'invalid legacy data');
  let app;
  try{
    assert.throws(()=>createApp(config),/Legacy private state/);assert.equal(fs.existsSync(config.credentialKeyFile),false);
    const baseline=new Accounts(config.accountFile,credentialVault(config.credentialKeyFile));await baseline.close();
    app=createApp(config);assert.equal(app.registry.db.prepare('SELECT COUNT(*) AS n FROM browser_logins').get().n,0);
    const account=app.registry.resolve('discord',config.ownerId,'Owner');
    app.registry.link(account.id,'plex','101','Fixture Plex');
    app.registry.credential('101',{token:'private-restore-plex'});
    const store=require('../server/storage').loginStore(JSON.stringify([config.publicUrl,config.ownerId,config.guildId,config.clientId]),app.registry.vault,app.registry);
    store.logins.set('a'.repeat(64),{userId:account.id,accountRevision:account.revision,name:'Owner',csrf:'b'.repeat(64),expires:null,oauth:{refreshToken:'private-fixture-refresh',expires:Date.now()+3600000}});await store.save();
    const keyBytes=fs.readFileSync(config.credentialKeyFile);
    const yaml=path.join(directory,'config.yaml');
    fs.writeFileSync(yaml,"# Matched private fixture\nplex:\n  token: 'fixture-only'\nstorage:\n  credential_key_file: './credentials.key'\n");
    const editor=require('../server/config-editor').createConfigEditor(yaml);
    await editor.save({revision:(await editor.readEditable()).revision,changes:{'rooms.max_members':12}});
    const {RoomStore}=require('../server/room-store'),{RoomQueue}=require('../server/room-queue');
    const rooms=new RoomStore(app.registry),queue=new RoomQueue(app.registry,rooms);
    const savedRoom=await rooms.create(account.id,{name:'Restore room',keepEmpty:true});
    await queue.add(savedRoom.id,account.id,{serverId:'fixture-machine',mediaId:'123',type:'movie',title:'Fixture movie',duration:60,position:0});
    await app.registry.flush();
    const restoreDir=path.join(directory,'restored');fs.mkdirSync(restoreDir);
    const restoreFile=path.join(restoreDir,'accounts.sqlite'),restoreKey=path.join(restoreDir,'credentials.key');
    // SQLite creates a consistent snapshot while the fixture installation stays open.
    const disk=new (require('node:sqlite').DatabaseSync)(config.accountFile);
    try{disk.prepare('VACUUM INTO ?').run(restoreFile);}finally{disk.close();}
    fs.copyFileSync(config.credentialKeyFile,restoreKey);fs.copyFileSync(yaml,path.join(restoreDir,'config.yaml'));
    app.registry.rename(account.id,'Changed after backup');await app.registry.flush();
    await editor.save({revision:(await editor.readEditable()).revision,changes:{'rooms.max_members':16}});
    const restoreConfig={...config,accountFile:restoreFile,credentialKeyFile:restoreKey};
    let restored=createApp(restoreConfig);
    try{
      assert.equal(restored.registry.identity('discord',config.ownerId).userId,account.id);
      assert.equal(restored.registry.canonical(account.id).name,'Owner','matched restore rolls back later state changes');
      assert.equal(restored.registry.identity('plex','101').verified,1);
      assert.equal(restored.registry.credential('101').token,'private-restore-plex');
      assert.equal(new RoomStore(restored.registry).get(savedRoom.id).creatorId,account.id);
      assert.equal(restored.registry.db.prepare('SELECT mediaId FROM watch_queue_entries WHERE roomId=?').get(savedRoom.id).mediaId,'123');
      assert.equal((await require('../server/config-editor').createConfigEditor(path.join(restoreDir,'config.yaml')).readEditable()).settings['rooms.max_members'],12);
      assert.equal(restored.registry.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    }finally{await restored.close();}
    fs.unlinkSync(restoreKey);assert.throws(()=>createApp(restoreConfig),/key is missing/);assert.equal(fs.existsSync(restoreKey),false);
    const wrongKey=Buffer.alloc(32,7);fs.writeFileSync(restoreKey,wrongKey);
    assert.throws(()=>createApp(restoreConfig),'a mismatched key cannot decrypt restored browser credentials');
    assert.deepEqual(fs.readFileSync(restoreKey),wrongKey,'never replace a mismatched key');
    fs.writeFileSync(restoreKey,keyBytes);restored=createApp(restoreConfig);await restored.close();
    await app.close();app=createApp(config);
    const stored=JSON.parse(app.registry.db.prepare('SELECT record FROM browser_logins').get().record);
    assert.equal(stored.userId,account.id);assert.equal(app.registry.identity('discord',config.ownerId).userId,account.id);
    assert.equal(stored.oauth.encrypted,1);assert.equal(JSON.stringify(stored).includes('private-fixture-refresh'),false);
    assert.equal(fs.readFileSync(legacyFile,'utf8'),'invalid legacy data');assert.equal(fs.existsSync(legacyFile+'.pre-accounts.encrypted.json'),false);
    assert.deepEqual(fs.readFileSync(config.credentialKeyFile),keyBytes);
    await app.close();app=undefined;fs.renameSync(config.credentialKeyFile,config.credentialKeyFile+'.saved');assert.throws(()=>createApp(config),/key is missing/);assert.equal(fs.existsSync(config.credentialKeyFile),false);
  }finally{if(app)await app.close();assert.equal(path.dirname(directory),path.resolve(os.tmpdir()));fs.rmSync(directory,{recursive:true,force:true});}
});

test('Discord/Plex link ownership, stable accounts and Plex-only room authorization preserve provider-specific media restrictions',tls,async t=>{
  let holdMedia=false;
  const f=await fixture(t,(input,options,provider)=>{
    if(holdMedia&&new URL(input).pathname==='/library/parts/123/file.mp4')return new Response(new ReadableStream({start(controller){
      controller.enqueue(Buffer.from('fixture-stream-start'));
      options.signal.addEventListener('abort',()=>controller.error(new Error('Fixture stream revoked')),{once:true});
    }}),{headers:{'content-type':'video/mp4'}});
    return provider.fetch(input,options);
  }),alice=f.browser(),bob=f.browser(),denied=f.browser();
  assert.equal((await alice.discord()).status,302);const a=(await alice.request('/api/account')).body.account;assert.match(a.id,/^[a-f0-9-]{36}$/);assert.notEqual(a.id,f.config.ownerId);
  const oldCookie=alice.jar.get('uburoom'),oldActivity=(await alice.request('/api/watch/demo-login',{persona:'host',activity:true})).body;
  const oldRoom=(await alice.post('/api/watch/rooms',{})).body.id,oldViewer=randomUUID();
  const oldState=(await alice.request(`/api/watch/rooms/${oldRoom}?viewer=${oldViewer}&quality=direct`)).body;
  await alice.post(`/api/watch/rooms/${oldRoom}/command`,{epoch:oldState.epoch,expiresAt:Date.now()+2900,viewerId:oldViewer,command:{action:'media.load',args:{mediaId:'123',quality:'direct'}}});
  const oldMedia=(await alice.request(`/api/watch/rooms/${oldRoom}?viewer=${oldViewer}`)).body.mediaUrl;
  const previousRoom=f.app.watch.rooms.get(oldRoom);
  const oldSocket=previousRoom.viewers.get(oldViewer).watchSocket;
  assert.equal((await alice.plex('alice',true)).status,302);assert.equal((await alice.request('/api/account')).body.account.id,a.id);
  assert.equal((await alice.request('/api/account',undefined,{Cookie:'uburoom='+oldCookie})).status,401,'linking revokes the previous browser session');
  assert.equal((await alice.request('/api/watch/me',undefined,{Authorization:'Bearer '+oldActivity.token})).status,401,'linking revokes Activity tokens');
  assert.equal(previousRoom.viewers.has(oldViewer),false,'linking evicts existing room viewers');
  assert.notEqual(oldSocket.readyState,1,'linking closes the viewer socket');
  assert.equal((await alice.request(oldMedia)).status,403,'old media grants cannot inherit the newly linked identity');
  const same=f.browser();assert.equal((await same.plex('alice')).status,302);assert.equal((await same.request('/api/account')).body.account.id,a.id,'either login resolves the same uburoom account');
  f.members.delete(f.config.ownerId);assert.equal((await same.post('/api/watch/admin-mode',{enabled:true})).status,200,'the verified owner can use Plex authorization independently of guild membership');await same.post('/api/watch/admin-mode',{enabled:false});f.members.add(f.config.ownerId);
  assert.equal((await bob.plex('bob')).status,302);const b=(await bob.request('/api/account')).body.account;assert.equal(b.identities.length,1);assert.equal(b.identities[0].provider,'plex');
  const stored=f.app.registry.credential('102');assert.equal(stored.authType,'traditional');assert.equal(stored.privateKey,undefined);assert.equal(stored.expires,undefined);f.app.plexAuth.clear();assert.equal((await bob.request('/api/watch/me')).status,200);assert.equal(f.provider.requests.some(r=>r.deviceJWT||r.path==='/api/v2/auth/token'),false,'traditional PINs never request incompatible JWT resource tokens');
  assert.equal((await denied.plex('denied')).headers.location,'/auth/error');assert.match((await denied.request('/api/account/auth-error')).body.error,/does not have access/);assert.equal((await denied.request('/api/watch/me')).status,401);
  const roomId=(await bob.post('/api/watch/rooms',{})).body.id,viewer=randomUUID();let state=(await bob.request(`/api/watch/rooms/${roomId}?viewer=${viewer}&quality=direct`)).body;
  const command=(action,args)=>bob.post(`/api/watch/rooms/${roomId}/command`,{epoch:state.epoch,expiresAt:Date.now()+2900,viewerId:viewer,command:{action,args}});
  assert.equal((await command('media.load',{mediaId:'999',quality:'direct'})).body.status,'failed','Plex-only host cannot load a denied item through the owner token');
  assert.equal((await command('media.load',{mediaId:'123',quality:'direct'})).body.status,'applied');state=(await bob.request(`/api/watch/rooms/${roomId}?viewer=${viewer}`)).body;
  assert.equal((await bob.request(state.mediaUrl)).status,200);
  const reads=f.provider.requests.filter(r=>r.path==='/library/parts/123/file.mp4');assert.ok(reads.length);assert.ok(reads.every(r=>r.token==='fixture-server-102'));
  const scoped=await f.app.plexAuth.forUser(b.id),hls=await scoped.prepare('123','720p4');assert.ok(hls.transcodeId);assert.ok(f.provider.requests.some(r=>r.path.includes('/transcode/universal/decision')&&r.token==='fixture-server-102'));await f.app.watch.plex.stop(hls);
  f.app.watch.plex.av1.ffmpeg='fixture-only';const av1=await scoped.prepare('123','direct',true,undefined,'av1');assert.equal(av1.av1Lease.group.source.plexContext.token,'fixture-server-102','shared encoder input uses an authorized user context');await f.app.watch.plex.stop(av1);
  const ownerSource=await f.app.watch.plex.prepare('999','direct');await assert.rejects(scoped.prepare('999','direct',false,ownerSource),'owner metadata cannot bypass a restricted user context');
  const actor={userId:b.id,name:'Bob',surface:'web',guildId:f.config.guildId,channelId:'commands'};
  assert.equal(f.app.hub.access.isMember(b.id),false);assert.equal(await f.app.watch.canView(f.app.watch.rooms.get(roomId),actor),true,'Plex access does not require Discord membership');
  const aliceRoom=(await alice.post('/api/watch/rooms',{})).body.id,aliceViewer=randomUUID();let aliceState=(await alice.request(`/api/watch/rooms/${aliceRoom}?viewer=${aliceViewer}&quality=direct`)).body;
  await alice.post(`/api/watch/rooms/${aliceRoom}/command`,{epoch:aliceState.epoch,expiresAt:Date.now()+2900,viewerId:aliceViewer,command:{action:'media.load',args:{mediaId:'999',quality:'direct'}}});aliceState=(await alice.request(`/api/watch/rooms/${aliceRoom}?viewer=${aliceViewer}`)).body;
  const restrictedRoom=f.app.watch.rooms.get(aliceRoom);
  restrictedRoom.s.permissions.allHosts=true;
  assert.equal(await f.app.watch.canView(restrictedRoom,actor),false,'All hosts grants no item entitlement');
  restrictedRoom.s.permissions.allHosts=false;restrictedRoom.s.hosts.push(b.id);
  assert.equal(await f.app.watch.canView(restrictedRoom,actor),false,'explicit host assignment grants no item entitlement');
  f.config.roomAdministrators={discord:[],plex:['102'],discordRoles:[]};
  assert.equal((await bob.post('/api/watch/admin-mode',{enabled:true})).status,200);
  assert.equal(f.app.hub.isAdmin(actor),true);
  assert.equal(await f.app.watch.canView(restrictedRoom,actor),false,'Admin mode grants no item entitlement');
  for(const endpoint of ['/api/operator/settings','/api/operator/settings/saved'])assert.equal((await bob.request(endpoint)).status,403,'a room creator/host in Admin mode cannot read server settings');
  assert.equal((await bob.post('/api/operator/settings/saved',{revision:'a'.repeat(64),changes:{'rooms.max_members':12}})).status,403);
  f.app.hub.clearAdmin(actor);
  f.provider.revoked.add('101');f.app.plexAuth.clear();assert.equal((await alice.request('/api/watch/me')).status,200,'Discord still provides uburoom account access');assert.equal((await alice.request(aliceState.mediaUrl)).status,403,'a linked Plex denial does not fall back to the owner token');
  assert.equal((await f.app.hub.dispatch({userId:f.config.ownerId,name:'Owner',surface:'web',guildId:'guild',channelId:'commands'},{roomId:aliceRoom,action:'media.pause'})).status,'forbidden','Room commands enforce the same media entitlement');
  const grantBase=state.mediaUrl.slice(0,state.mediaUrl.lastIndexOf('/')+1),captionVersion=randomUUID();
  f.app.watch.rooms.get(roomId).viewers.get(viewer).media.captionVersion=captionVersion;
  holdMedia=true;
  let streamStarted;
  const started=new Promise(resolve=>{streamStarted=resolve;});
  const stopped=new Promise((resolve,reject)=>{
    const req=https.get(f.config.publicUrl+state.mediaUrl,{ca:f.config.cert},res=>{
      res.once('data',streamStarted);res.once('aborted',resolve);res.on('error',()=>{});
      res.once('end',()=>reject(new Error('Fixture stream ended without revocation')));
    });
    req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('Revoked stream stayed open')));
  });
  await started;
  f.provider.revoked.add('102');f.app.plexAuth.clear();assert.equal((await bob.request(state.mediaUrl)).status,403,'revoked Plex access invalidates media grants');
  await stopped;
  for(const resource of ['captions-'+captionVersion,'subtitle-'+captionVersion,'subtitle-'+captionVersion+'/window'])assert.equal((await bob.request(grantBase+resource)).status,403,'revoked access rejects captions and subtitle windows');
  assert.equal((await bob.request('/api/watch/me')).status,401);assert.equal((await bob.post('/api/watch/admin-mode',{enabled:true})).status,401);
});

test('provider removal protects the last sign-in, checks CSRF and current ownership, preserves UUID and revokes old logins and credentials',tls,async t=>{
  const f=await fixture(t),browser=f.browser(),other=f.browser();await browser.discord('guest');
  const original=(await browser.request('/api/account')).body.account;
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400,'last sign-in cannot be removed');
  await browser.plex('alice',true);await other.plex('alice');
  const before=(await browser.request('/api/watch/me')).body,revision=f.app.registry.canonical(original.id).revision;
  const activity=(await browser.request('/api/watch/demo-login',{persona:'guest',activity:true})).body;
  assert.equal((await browser.request('/api/account/plex/remove',{subject:'101'})).status,401,'CSRF required');
  assert.equal((await browser.post('/api/account/plex/remove',{subject:'102'})).status,400,'a stale or other account subject cannot be removed');
  assert.equal(f.app.registry.canonical(original.id).revision,revision);
  const room=(await browser.post('/api/watch/rooms',{})).body.id;
  assert.equal((await browser.post('/api/account/plex/remove',{subject:'101'})).status,400,'active rooms must be left before changing identities');
  await browser.post('/api/watch/rooms/'+room+'/close',{epoch:f.app.watch.rooms.get(room).s.epoch});
  f.members.delete(f.provider.subjects.guest);
  assert.equal((await browser.post('/api/account/plex/remove',{subject:'101'})).status,400,'ineligible Discord identity cannot be the remaining sign-in');
  f.members.add(f.provider.subjects.guest);
  assert.equal((await browser.post('/api/account/plex/remove',{subject:'101'})).status,200);
  let account=(await browser.request('/api/account')).body.account;
  assert.equal(account.id,original.id);assert.deepEqual(account.identities.map(i=>i.provider),['discord']);
  assert.equal(f.app.registry.hasCredential('101'),false);assert.equal(f.app.registry.credentialCache.has('101'),false);
  assert.equal((await other.request('/api/watch/me')).status,401,'other browsers are revoked');
  assert.equal((await browser.request('/api/watch/me',undefined,{Authorization:'Bearer '+activity.token})).status,401,'previous Activity grants are revoked');
  assert.equal((await browser.request('/api/account/discord/connect',{}, {'X-CSRF-Token':before.csrf})).status,401,'previous CSRF proof is revoked');
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400);
  await browser.plex('alice',true);await other.plex('alice');
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,200);
  account=(await browser.request('/api/account')).body.account;
  assert.equal(account.id,original.id);assert.deepEqual(account.identities.map(i=>i.provider),['plex']);
  assert.equal(f.app.registry.identity('discord',f.provider.subjects.guest),undefined);
  assert.equal((await other.request('/api/watch/me')).status,401);
  await browser.discord('guest',true);
  account=(await browser.request('/api/account')).body.account;
  assert.equal(account.id,original.id);assert.equal(account.identities.length,2,'both providers can be connected again');
});

test('provider removal rejects unusable Plex credentials and account changes during remaining-provider verification',tls,async t=>{
  const f=await fixture(t),browser=f.browser();await browser.discord('guest');await browser.plex('alice',true);
  const owner=f.browser();await owner.discord();await owner.plex('bob',true);f.members.delete(f.config.ownerId);
  assert.equal((await owner.post('/api/account/plex/remove',{subject:'102'})).status,400,'owner also needs an eligible remaining sign-in');
  f.members.add(f.config.ownerId);
  const original=(await browser.request('/api/account')).body.account;
  f.provider.revoked.add('101');f.app.plexAuth.clear();
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400,'revoked Plex cannot replace Discord sign-in');
  assert.equal(f.app.registry.identities(original.id).length,2);
  f.provider.revoked.delete('101');
  const credential=f.app.registry.credential('101');
  f.app.registry.db.prepare('DELETE FROM credentials WHERE subject=?').run('101');f.app.registry.credentialCache.delete('101');
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400,'a verified Plex link without a stored credential is not a usable login');
  f.app.registry.credential('101',credential);
  const verify=f.app.plexAuth.forUser.bind(f.app.plexAuth);
  f.app.plexAuth.forUser=async id=>{const result=await verify(id);f.app.registry.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(id);return result;};
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400,'stale sign-in cannot unlink after awaited verification');
  assert.equal(f.app.registry.identities(original.id).length,2);
});

test('verified reverse linking offers an explicit offline merge, refuses stale proof and signs out both previous accounts',tls,async t=>{
  const f=await fixture(t),discord=f.browser(),plex=f.browser();await discord.discord('guest');await plex.plex('bob');
  const oldD=(await discord.request('/api/account')).body.account.id,oldP=(await plex.request('/api/account')).body.account.id;
  assert.notEqual(oldD,oldP);await plex.discord('guest',true);
  let preview=(await plex.request('/api/account')).body.merge;assert.ok(preview);assert.equal(preview.accounts.length,2);
  assert.equal((await discord.post('/api/account/merge',{id:preview.id})).status,400,'merge proof belongs to its originating browser');
  f.app.registry.link(oldD,'discord',f.provider.subjects.guest,'Reverified guest');
  assert.equal((await plex.post('/api/account/merge',{id:preview.id})).status,400,'a target account revision change invalidates the preview');
  await discord.discord('guest');await plex.discord('guest',true);preview=(await plex.request('/api/account')).body.merge;
  const roomId=(await discord.post('/api/watch/rooms',{})).body.id;
  assert.equal((await plex.post('/api/account/merge',{id:preview.id})).status,400,'live room ownership cannot move during a merge');
  await discord.post('/api/watch/rooms/'+roomId+'/close',{epoch:f.app.watch.rooms.get(roomId).s.epoch});
  assert.equal((await plex.post('/api/account/merge',{id:preview.id})).status,200);
  assert.equal((await discord.request('/api/watch/me')).status,401);assert.equal((await plex.request('/api/account')).body.account.id,oldP);
  const again=f.browser();await again.discord('guest');assert.equal((await again.request('/api/account')).body.account.id,oldP);
  assert.equal(f.app.registry.canonical(oldD).id,oldP);
  const bad=f.browser();const start=await bad.request('/auth/plex'),state=new URL(start.headers.location,f.config.publicUrl).searchParams.get('state');
  assert.equal((await discord.request('/auth/plex/callback?state='+state)).headers.location,'/auth/error','another browser cannot claim the PIN attempt');
});

test('only owner Admin mode assigns previewed ID matches; pending matches create no credential and resolve on later proven login',tls,async t=>{
  const f=await fixture(t),owner=f.browser(),guest=f.browser();await owner.discord();await guest.discord('guest');
  f.members.delete(f.provider.subjects.guest2);
  assert.equal((await owner.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest2,plexId:'102'})).status,403);
  await owner.post('/api/watch/admin-mode',{enabled:true});
  assert.equal((await guest.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest2,plexId:'102'})).status,403);
  assert.equal((await owner.post('/api/account/admin/preview',{discordId:f.config.ownerId,plexId:'101'})).status,400,'owner privilege cannot be assigned through a manual match');
  const preview=await owner.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest2,plexId:'102'});assert.equal(preview.status,200);
  const assigned=await owner.post('/api/account/admin/assign',{id:preview.body.id});assert.equal(assigned.status,200);assert.equal(f.app.registry.credential('102'),undefined);
  const notMember=f.browser();assert.equal((await notMember.discord('guest2')).status,403,'a preassigned match does not grant Discord-server eligibility');
  const both=f.browser();await both.plex('bob');assert.equal((await both.request('/api/account')).body.account.id,assigned.body.account.id);
  f.members.add(f.provider.subjects.guest2);const byDiscord=f.browser();await byDiscord.discord('guest2');assert.equal((await byDiscord.request('/api/account')).body.account.id,assigned.body.account.id);
  const stale=await owner.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest,plexId:'101'});
  await f.app.registry.resolve('plex','101','Alice separately');
  assert.equal((await owner.post('/api/account/admin/assign',{id:stale.body.id})).status,400,'a changed account registry requires a new preview');
  assert.equal((await owner.request('/api/account/admin')).body.accounts.some(account=>JSON.stringify(account).includes('fixture-server-')),false);
  const separate=f.browser();await separate.plex('alice');await owner.plex('alice',true);const ownerMerge=(await owner.request('/api/account')).body.merge;
  assert.equal((await owner.post('/api/account/merge',{id:ownerMerge.id})).status,200);assert.equal((await owner.request('/api/watch/me')).body.adminMode,false,'owner merging accounts does not preserve active Admin consent');
});

test('account assignment and merge revalidate active Admin mode and current login after reading request bodies',tls,async t=>{
  const f=await fixture(t),owner=f.browser(),guest=f.browser();
  await owner.discord();await owner.post('/api/watch/admin-mode',{enabled:true});
  await guest.discord('guest');
  const preview=await owner.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest,plexId:'102'});
  assert.equal(preview.status,200);

  const ownerCsrf=await owner.csrf(),ownerCookie=[...owner.jar].map(([k,v])=>k+'='+v).join('; ');
  const sendDelayed=async(path,bodyObj,midFlight)=>{
    return new Promise((resolve,reject)=>{
      const data=JSON.stringify(bodyObj);
      const req=https.request({
        hostname:'localhost',port:f.app.server.address().port,path,method:'POST',ca:f.config.cert,
        headers:{Origin:f.config.publicUrl,'Content-Type':'application/json','X-CSRF-Token':ownerCsrf,Cookie:ownerCookie}
      },res=>{
        const chunks=[];res.on('data',c=>chunks.push(c));
        res.on('end',()=>{
          const raw=Buffer.concat(chunks).toString();
          resolve({status:res.statusCode,body:res.headers['content-type']?.includes('json')?JSON.parse(raw):raw});
        });
      });
      req.on('error',reject);
      req.write(data.slice(0, 5));
      setTimeout(async()=>{
        try {
          await midFlight();
          req.write(data.slice(5));
          req.end();
        } catch(err) {
          req.destroy(err);
          reject(err);
        }
      }, 25);
    });
  };

  const exitedAdmin=await sendDelayed('/api/account/admin/assign',{id:preview.body.id},async()=>{
    await owner.post('/api/watch/admin-mode',{enabled:false});
  });
  assert.equal(exitedAdmin.status,403);
  assert.equal(f.app.registry.identity('plex','102'),undefined,'identity was not assigned when Admin mode was revoked');

  await owner.post('/api/watch/admin-mode',{enabled:true});
  const preview2=await owner.post('/api/account/admin/preview',{discordId:f.provider.subjects.guest,plexId:'102'});
  assert.equal(preview2.status,200);

  const revokedLogin=await sendDelayed('/api/account/admin/assign',{id:preview2.body.id},async()=>{
    await owner.post('/api/logout',{});
  });
  assert.equal(revokedLogin.status,403);
  assert.equal(f.app.registry.identity('plex','102'),undefined,'identity was not assigned when login was revoked');

  await owner.discord();
  await owner.post('/api/watch/admin-mode',{enabled:true});
  const plexUser=f.browser();await plexUser.plex('bob');
  await owner.plex('bob',true);
  const mergePreview=(await owner.request('/api/account')).body.merge;
  assert.ok(mergePreview);

  const newOwnerCsrf=await owner.csrf(),newOwnerCookie=[...owner.jar].map(([k,v])=>k+'='+v).join('; ');
  const revokedMerge=await new Promise((resolve,reject)=>{
    const data=JSON.stringify({id:mergePreview.id});
    const req=https.request({
      hostname:'localhost',port:f.app.server.address().port,path:'/api/account/merge',method:'POST',ca:f.config.cert,
      headers:{Origin:f.config.publicUrl,'Content-Type':'application/json','X-CSRF-Token':newOwnerCsrf,Cookie:newOwnerCookie}
    },res=>{
      const chunks=[];res.on('data',c=>chunks.push(c));
      res.on('end',()=>{
        const raw=Buffer.concat(chunks).toString();
        resolve({status:res.statusCode,body:res.headers['content-type']?.includes('json')?JSON.parse(raw):raw});
      });
    });
    req.on('error',reject);
    req.write(data.slice(0, 5));
    setTimeout(async()=>{
      await owner.post('/api/logout',{});
      req.write(data.slice(5));
      req.end();
    }, 25);
  });
  assert.equal(revokedMerge.status,400);
  assert.match(revokedMerge.body.error,/Account sign-in changed/);
});

test('PlexAuth and administrator identity lookups ignore unverified assigned identities', async t => {
  const accounts = new Accounts(undefined, credentialVault());
  t.after(() => accounts.close());
  const user = accounts.resolve('discord', '123456789012345678', 'Assigned user', false);
  assert.equal(accounts.identity('discord', '123456789012345678').verified, 0);

  const plexUser = accounts.resolve('plex', '101', 'Assigned Plex', false);
  accounts.credential('101', { token: 'fixture-token' });
  assert.equal(accounts.identity('plex', '101').verified, 0);

  const plexAuth = new PlexAuth({}, accounts, { scoped: (token, clientId) => ({ token, clientId }) });
  plexAuth.validate = async cred => cred;
  assert.equal(await plexAuth.forUser(plexUser.id), undefined, 'unverified Plex identity cannot provide PlexAuth');

  accounts.resolve('plex', '101', 'Verified Plex');
  assert.equal(accounts.identity('plex', '101').verified, 1);
  const auth = await plexAuth.forUser(plexUser.id);
  assert.ok(auth, 'verified Plex identity provides PlexAuth');
  assert.equal(auth.token, 'fixture-token');
});
