'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),https=require('node:https'),os=require('node:os');
const {randomUUID}=require('node:crypto');
const {Accounts,credentialVault}=require('../server/accounts');
const {createApp}=require('../server/app');
const {accountFixture}=require('../scripts/account-fixture');
const {Plex}=require('../server/plex');
const {PlexAuth}=require('../server/plex-auth');

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

async function fixture(t, deliveryFetch){
  const provider=accountFixture(),cert=fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config={cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:provider.subjects.host,clientId:'100000000000000010',clientSecret:'fixture-secret',guildId:'guild',channels:['commands'],demo:true,unifiedAccounts:true,demoSubjects:provider.subjects,plexUrl:'http://plex-fixture.invalid:32400',plexToken:'fixture-owner'};
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
    return {request,post,discord,plex,jar};
  }
  return {app,provider,config,members,browser};
}
const tls={skip:!fs.existsSync(path.join(__dirname,'../certs/server-cert.pem'))};

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

test('direct fallback requires verified non-ownership and never delegates configured owner credentials',async t=>{
  const {PlexDelivery}=require('../server/plex-delivery');
  const config={plexUrl:'http://plex.invalid:32400',plexToken:'owner',plexDelivery:{mode:'auto',clientUrl:'https://plex.example',fallback:true},plexFallback:{enabled:true,token:'dedicated'}};
  let owned=false,requests=0,publicMachine='machine',live=true,revokeOnDelegate=false,holdIdentity;
  const plex=new Plex(config,async(input,options)=>{
    const url=new URL(input);
    if(url.pathname==='/identity'){await holdIdentity;return Response.json({MediaContainer:{machineIdentifier:publicMachine}});}
    assert.equal(url.pathname,'/security/token');assert.equal(options.headers['X-Plex-Token'],'dedicated');requests++;
    if(revokeOnDelegate)live=false;
    return Response.json({MediaContainer:{token:'transient-fallback'}});
  });t.after(()=>plex.close());
  let scope=plex.scope('dedicated','configured-fallback');
  const auth={machine:async()=> 'machine',request:async()=>[{clientIdentifier:'machine',provides:'server',owned}]};
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
  config.plexFallback.token='';assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  config.plexFallback.token='owner';scope=plex.scope('owner','configured-fallback');assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  scope=plex;assert.equal(await delivery().file(media(),context,async()=>true),undefined);
  assert.equal(requests,2,'wrong endpoints and owner/ambiguous fallback accounts cannot request delegation; late revocation suppresses its result');
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
    const store=require('../server/storage').loginStore(JSON.stringify([config.publicUrl,config.ownerId,config.guildId,config.clientId]),app.registry.vault,app.registry);
    store.logins.set('a'.repeat(64),{userId:account.id,accountRevision:account.revision,name:'Owner',csrf:'b'.repeat(64),expires:null,oauth:{refreshToken:'private-fixture-refresh',expires:Date.now()+3600000}});await store.save();
    const keyBytes=fs.readFileSync(config.credentialKeyFile);
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
  const f=await fixture(t),alice=f.browser(),bob=f.browser(),denied=f.browser();
  assert.equal((await alice.discord()).status,302);const a=(await alice.request('/api/account')).body.account;assert.match(a.id,/^[a-f0-9-]{36}$/);assert.notEqual(a.id,f.config.ownerId);
  assert.equal((await alice.plex('alice',true)).status,302);assert.equal((await alice.request('/api/account')).body.account.id,a.id);
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
  f.provider.revoked.add('101');f.app.plexAuth.clear();assert.equal((await alice.request('/api/watch/me')).status,200,'Discord still provides uburoom account access');assert.equal((await alice.request(aliceState.mediaUrl)).status,403,'a linked Plex denial does not fall back to the owner token');
  assert.equal((await f.app.hub.dispatch({userId:f.config.ownerId,name:'Owner',guildId:'guild',channelId:'commands'},{roomId:aliceRoom,action:'media.pause'})).status,'forbidden','Discord commands enforce the same media entitlement');
  f.provider.revoked.add('102');f.app.plexAuth.clear();assert.equal((await bob.request(state.mediaUrl)).status,403,'revoked Plex access invalidates media grants');
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
  const verify=f.app.plexAuth.forUser.bind(f.app.plexAuth);
  f.app.plexAuth.forUser=async id=>{const result=await verify(id);f.app.registry.db.prepare('UPDATE users SET revision=revision+1 WHERE id=?').run(id);return result;};
  assert.equal((await browser.post('/api/account/discord/remove',{subject:f.provider.subjects.guest})).status,400,'stale sign-in cannot unlink after awaited verification');
  assert.equal(f.app.registry.identities(original.id).length,2);
});

test('verified reverse linking offers an explicit offline merge, refuses stale proof and signs out both previous accounts',tls,async t=>{
  const f=await fixture(t),discord=f.browser(),plex=f.browser();await discord.discord('guest');await plex.plex('bob');
  const oldD=(await discord.request('/api/account')).body.account.id,oldP=(await plex.request('/api/account')).body.account.id;
  assert.notEqual(oldD,oldP);await plex.discord('guest',true);
  const preview=(await plex.request('/api/account')).body.merge;assert.ok(preview);assert.equal(preview.accounts.length,2);
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
