'use strict';
const {randomBytes}=require('node:crypto');
const {hash}=require('./core');

function accountHttp({config,registry,plexAuth,hub,watch,user,protectedPost,webActor,body,json,cookies,cookie,logins,loginStore,discordStart,throttle}) {
  const attempts=new Map(),previews=new Map(),merges=new Map(),errors=new Map();
  const secret=()=>randomBytes(32).toString('hex');
  const sourceHash=req=>cookies(req).uburoom&&hash(cookies(req).uburoom);
  const busy=ids=>[...watch.rooms.values()].some(room=>ids.includes(room.s.hostId)||[...room.viewers.values()].some(v=>ids.includes(v.userId)));
  function invalidate(ids,ownerChanged=false){
    for (const id of ids) if (hub.adminUsers.delete(id)) hub.adminEpoch++;
    if(ownerChanged||ids.includes(registry.identity('discord',config.ownerId)?.userId)){hub.adminMode=false;hub.adminEpoch++;}
    for(const [token,login] of logins)if(ids.includes(login.userId))logins.delete(token);
    loginStore.save();plexAuth.clear();
  }
  function session(res,account,name){const token=secret();logins.set(hash(token),{userId:account.id,accountRevision:account.revision,name,csrf:secret(),expires:null});loginStore.save();res.setHeader('Set-Cookie',cookie('uburoom',token,31536000));}
  function mergePreview(req,login,incoming){
    const source=registry.canonical(login.userId),other=registry.canonical(incoming.conflict.id),all=[...registry.identities(source.id),...registry.identities(other.id)];
    if(new Set(all.map(i=>i.provider)).size!==all.length)throw new Error('Accounts have conflicting identities; owner assistance is required');
    const id=secret();merges.set(sourceHash(req),{id,sourceHash:sourceHash(req),sourceId:source.id,otherId:other.id,version:JSON.stringify([source.revision,other.revision]),credential:incoming.credential,subject:incoming.subject,expires:Date.now()+300000});
    return {pendingMerge:true};
  }
  function verifiedLink(req,login,provider,subject,name,credential){
    const result=registry.link(login.userId,provider,subject,name);
    if(result.conflict)return mergePreview(req,login,{...result,credential,subject:credential?subject:undefined});
    if(credential)registry.credential(subject,credential);plexAuth.clear();
    registry.audit(login.userId,'self-link',{provider,subject});return {linked:true};
  }
  async function startPlex(req,res,login){
    if(!plexAuth.plex.configured)throw new Error('Configure Plex on the server first');
    if(attempts.size>=200)throw new Error('Plex sign-in is busy');
    const state=secret(),attempt=await plexAuth.start(config.publicUrl+'/auth/plex/callback?state='+state);
    attempts.set(state,{...attempt,expires:Date.now()+300000,...(login?{sourceId:login.userId,sourceHash:sourceHash(req),revision:login.accountRevision}:{})});
    res.setHeader('Set-Cookie',cookie('uburoom_plex',state,300));return config.demo&&plexAuth.demo?config.publicUrl+'/demo-plex?state='+state:attempt.url;
  }
  function pending(req,login){const merge=merges.get(sourceHash(req));return merge&&merge.expires>Date.now()&&merge.sourceId===login.userId?{id:merge.id,accounts:[registry.summary(merge.sourceId),registry.summary(merge.otherId)]}:undefined;}
  async function route(req,res,url){
    if(!registry)return false;
    const route=url.pathname;
    if(!route.startsWith('/api/account')&&!route.startsWith('/auth/plex'))return false;
    if(!throttle('account:'+req.socket.remoteAddress,120)){json(res,429,{error:'Too many account requests'});return true;}
    try {
      if(req.method==='GET'&&route==='/api/account/auth-error'){
        const id=cookies(req).uburoom_auth_error,record=errors.get(id);errors.delete(id);json(res,200,{error:record&&record.expires>Date.now()?record.message:'Sign-in expired. Start again from uburoom.'});return true;
      }
      if(req.method==='GET'&&route==='/auth/plex'){
        if(config.accessPolicy?.plex===false)throw new Error('Plex authorization is disabled');
        const destination=await startPlex(req,res,await user(req));res.writeHead(302,{Location:destination});res.end();return true;
      }
      if(req.method==='GET'&&route==='/auth/plex/demo'){
        const state=url.searchParams.get('state'),attempt=attempts.get(state);
        if(!config.demo||!plexAuth.demo||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||!attempt||attempt.expires<=Date.now()||cookies(req).uburoom_plex!==state)throw new Error('Isolated Plex demo is unavailable');
        plexAuth.demo.choose(attempt.pinId,url.searchParams.get('persona'));
        res.writeHead(302,{Location:'/auth/plex/callback?state='+state});res.end();return true;
      }
      if(req.method==='POST'&&route==='/api/account/demo-login'){
        if(!config.demo||!plexAuth.demo||req.headers.origin!==config.publicUrl||!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress))throw new Error('Isolated account demo is unavailable');
        const data=await body(req);if(!['host','guest','guest2'].includes(data.persona))throw new Error('Choose a demo identity');
        const subject=config.demoSubjects?.[data.persona]||(data.persona==='host'?config.ownerId:data.persona==='guest2'?'demo-guest2':'demo-guest');
        const account=registry.resolve('discord',subject,'Demo '+data.persona);session(res,account,account.name);json(res,200,{ok:true});return true;
      }
      if(req.method==='GET'&&route==='/auth/plex/callback'){
        const state=url.searchParams.get('state'),attempt=attempts.get(state);attempts.delete(state);
        if(!state||cookies(req).uburoom_plex!==state||!attempt||attempt.expires<=Date.now())throw new Error('Plex sign-in expired; start again');
        const login=attempt.sourceId?await user(req):undefined;
        if(attempt.sourceId&&(!login||login.userId!==attempt.sourceId||sourceHash(req)!==attempt.sourceHash||login.accountRevision!==attempt.revision))throw new Error('The account changed during Plex linking; start again');
        const identity=await plexAuth.finish(attempt);
        if(login){if((await user(req))!==login)throw new Error('Account sign-in expired during linking');verifiedLink(req,login,'plex',identity.subject,identity.name,identity.credential);}
        else {const account=registry.resolve('plex',identity.subject,identity.name);registry.credential(identity.subject,identity.credential);plexAuth.clear();session(res,account,account.name);}
        const existing=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(existing?Array.isArray(existing)?existing:[existing]:[]),cookie('uburoom_plex','',0)]);
        res.writeHead(302,{Location:'/watch?account=1'});res.end();return true;
      }
      const login=req.method==='GET'?await user(req):await protectedPost(req);
      if(!login){json(res,401,{error:'Sign in to manage your account'});return true;}
      if(req.method==='GET'&&route==='/api/account'){json(res,200,{account:registry.summary(login.userId),merge:pending(req,login),admin:hub.isOwner(webActor(login))&&hub.isAdmin(webActor(login))});return true;}
      if(req.method==='POST'&&route==='/api/account/plex/connect'){if(config.accessPolicy?.plex===false)throw new Error('Plex authorization is disabled');json(res,200,{url:await startPlex(req,res,login)});return true;}
      if(req.method==='POST'&&route==='/api/account/discord/connect'){await discordStart(req,res,login);return true;}
      const remove=/^\/api\/account\/(discord|plex)\/remove$/.exec(route);
      if(req.method==='POST'&&remove){
        const provider=remove[1],data=await body(req),identities=registry.identities(login.userId);
        const remaining=identities.find(i=>i.provider!==provider&&i.verified&&(i.provider!=='plex'||registry.hasCredential(i.subject)));
        if(!remaining)throw new Error('Connect another sign-in method before removing this account');
        const ownerChanged=hub.isOwner(webActor(login));
        if(remaining.provider==='plex'){if(!await plexAuth.forUser(login.userId))throw new Error('Sign in to Plex before removing Discord');}
        else if(!hub.access.isMember(login.userId)&&!await hub.access.refresh(login.userId))throw new Error('Discord access is unavailable; keep Plex connected');
        if((await user(req))!==login)throw new Error('Account sign-in changed; open Account again');
        if(remaining.provider==='discord'&&!hub.access.isMember(login.userId))throw new Error('Discord access changed; keep Plex connected');
        if(busy([login.userId]))throw new Error('Leave your watch rooms before removing a connected account');
        const account=registry.unlink(login.userId,provider,data.subject);
        invalidate([account.id],ownerChanged);merges.delete(sourceHash(req));session(res,account,account.name);
        json(res,200,{removed:true});return true;
      }
      if(req.method==='POST'&&route==='/api/account/merge'){
        const data=await body(req),merge=merges.get(sourceHash(req));
        if(!merge||merge.id!==data.id||merge.expires<=Date.now()||merge.sourceId!==login.userId)throw new Error('Merge verification expired; connect the account again');
        const a=registry.canonical(merge.sourceId),b=registry.canonical(merge.otherId);
        if(JSON.stringify([a.revision,b.revision])!==merge.version)throw new Error('Accounts changed; connect again');
        if(busy([a.id,b.id]))throw new Error('Leave all watch rooms for both accounts before merging');
        const current=await user(req);
        if(!current||current!==login)throw new Error('Account sign-in changed; connect again');
        registry.merge(a.id,b.id,a.id);if(merge.credential)registry.credential(merge.subject,merge.credential);
        invalidate([a.id,b.id]);merges.delete(sourceHash(req));session(res,registry.canonical(a.id),a.name);json(res,200,{merged:true});return true;
      }
      if(!hub.isOwner(webActor(login))||!hub.isAdmin(webActor(login))){json(res,403,{error:'Enable owner Admin mode to match accounts'});return true;}
      if(req.method==='GET'&&route==='/api/account/admin'){json(res,200,{accounts:registry.list()});return true;}
      if(req.method==='POST'&&route==='/api/account/admin/preview'){
        const data=await body(req);
        if(typeof data.discordId!=='string'||typeof data.plexId!=='string'||!/^\d{17,20}$/.test(data.discordId)||!/^\d{1,20}$/.test(data.plexId))throw new Error('Use Discord and Plex account IDs, not names or email addresses');
        if(data.discordId===config.ownerId)throw new Error('Connect the owner account through verified self-service linking');
        const profile=await hub.access.identity(data.discordId);if(!profile)throw new Error('Discord identity unavailable; check the ID and bot connection');
        const current=await user(req);
        if(!current||current!==login||!hub.isOwner(webActor(current))||!hub.isAdmin(webActor(current))){json(res,403,{error:'Owner Admin permission changed; preview again'});return true;}
        const preview=registry.preview(data.discordId,data.plexId),id=secret();
        const discordName=profile.name,plexName=registry.identity('plex',data.plexId)?.name||'Awaiting Plex sign-in';
        previews.set(id,{...preview,discordName,sourceHash:sourceHash(req),expires:Date.now()+300000});json(res,200,{id,discordId:data.discordId,discordName,plexId:data.plexId,plexName,accounts:preview.users});return true;
      }
      if(req.method==='POST'&&route==='/api/account/admin/assign'){
        const data=await body(req),preview=previews.get(data.id);previews.delete(data.id);
        if(!preview||preview.sourceHash!==sourceHash(req)||preview.expires<=Date.now())throw new Error('Match preview expired; preview again');
        if(busy(preview.users.map(u=>u.id)))throw new Error('Both accounts must leave their watch rooms before matching');
        const current=await user(req);
        if(!current||current!==login||!hub.isOwner(webActor(current))||!hub.isAdmin(webActor(current))){json(res,403,{error:'Owner Admin permission changed; preview again'});return true;}
        const id=registry.assign(preview,current.userId);invalidate(preview.users.map(u=>u.id));json(res,200,{account:registry.summary(id)});return true;
      }
      json(res,404,{error:'Account action unavailable'});return true;
    }catch(error){
      const message=error.message.includes('UNIQUE')?'Account identity conflict; preview again':error.message;
      if(req.method==='GET'&&route.startsWith('/auth/plex')){const id=secret();errors.set(id,{message,expires:Date.now()+60000});res.setHeader('Set-Cookie',cookie('uburoom_auth_error',id,60));res.writeHead(302,{Location:'/auth/error'});res.end();}
      else json(res,400,{error:message});return true;
    }
  }
  function sweep(){for(const map of [attempts,previews,merges,errors])for(const [key,value]of map)if(value.expires<=Date.now())map.delete(key);}
  return {route,sweep,verifiedLink,close(){attempts.clear();previews.clear();merges.clear();errors.clear();}};
}
module.exports={accountHttp};
