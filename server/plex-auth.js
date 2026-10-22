'use strict';
const {randomUUID,sign}=require('node:crypto');
const { resilientFetch } = require('./resilience');
class PlexAccessError extends Error {constructor(message,revoked=false){super(message);this.revoked=revoked;}}
class PlexAuth {
  constructor(config,accounts,plex,fetcher=fetch){this.config=config;this.accounts=accounts;this.plex=plex;this.fetch=resilientFetch(fetcher,{timeoutMs:10000});this.cache=new Map();this.inflight=new Map();this.generation=0;}
  async request(resource,{token,clientId,method='GET',data}={}) {
    const response=await this.fetch('https://clients.plex.tv/api/v2'+resource,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{Accept:'application/json','X-Plex-Product':'uburoom','X-Plex-Client-Identifier':clientId||'uburoom-auth',...(token?{'X-Plex-Token':token}:{}),...(data?{'Content-Type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
    if(!response.ok)throw new PlexAccessError([401,403,498].includes(response.status)?'Plex authorization expired or was revoked':'Plex is temporarily unavailable; try again',[401,403,498].includes(response.status));
    return response.json();
  }
  jwt(credential,claims={}) {
    const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url'),now=Math.floor(Date.now()/1000);
    const payload=encode({aud:'plex.tv',iss:credential.clientId,iat:now,exp:now+300,scope:'username,friendly_name,restricted',...claims});
    const input=encode({kid:credential.kid,alg:'EdDSA',typ:'JWT'})+'.'+payload;
    return input+'.'+sign(null,Buffer.from(input),credential.privateKey).toString('base64url');
  }
  async start(forwardUrl){
    // PMS installations can reject JWT resource tokens despite accepting the
    // same account at plex.tv. Use Plex's documented traditional PIN flow.
    const clientId=randomUUID(),credential={clientId,authType:'traditional'};
    const pin=await this.request('/pins?strong=true',{clientId,method:'POST'});
    if(!pin.id||typeof pin.code!=='string')throw new Error('Plex sign-in could not start');
    const params=new URLSearchParams({clientID:clientId,code:pin.code,forwardUrl,'context[device][product]':'uburoom'});
    return {credential,pinId:String(pin.id),url:'https://app.plex.tv/auth#?'+params};
  }
  async finish(attempt){
    const {credential}=attempt,pin=await this.request('/pins/'+encodeURIComponent(attempt.pinId)+(credential.privateKey?'?deviceJWT='+encodeURIComponent(this.jwt(credential)):''),{clientId:credential.clientId});
    if(typeof pin.authToken!=='string'||!pin.authToken)throw new Error('Plex sign-in was not completed; start again');
    credential.token=pin.authToken;if(credential.privateKey)credential.expires=Date.now()+6*86400000;
    const profile=await this.request('/user',{token:credential.token,clientId:credential.clientId});
    if(!/^\d{1,20}$/.test(String(profile.id)))throw new Error('Plex account identity unavailable');
    const name=String(profile.username||profile.friendlyName||'Plex user').slice(0,100);
    try {await this.validate(credential);}
    catch(error){if(!(this.config.accessPolicy && !this.config.accessPolicy.requirePlex && this.config.plexFallback?.enabled && error.noServerAccess))throw error;}
    return {subject:String(profile.id),name,credential};
  }
  async machine(){
    const pinned=this.config.plexMachineIdentifier||this.accounts.meta('plexMachineIdentifier');
    let root;try{root=await this.plex.json('/');}catch(error){throw new PlexAccessError(error.status?`Plex server identity check failed (HTTP ${error.status}); check the server's PLEX_TOKEN and access settings`:'Plex server identity check could not reach the configured server; check PLEX_URL and connectivity');}
    const id=root.machineIdentifier;
    if(typeof id!=='string'||!id)throw new Error('Plex server identity unavailable');
    if(pinned&&pinned!==id)throw new Error('Configured Plex server identity changed; check server configuration');
    if(!pinned)this.accounts.meta('plexMachineIdentifier',id);return id;
  }
  async validate(credential,expectedSubject){
    // Keep renewal for already-stored JWT credentials; traditional tokens are
    // verified on every access refresh and require sign-in again if revoked.
    if(credential.privateKey&&credential.expires<=Date.now()){
      const {nonce}=await this.request('/auth/nonce',{clientId:credential.clientId});if(typeof nonce!=='string')throw new Error('Plex renewal unavailable');
      const renewed=await this.request('/auth/token',{clientId:credential.clientId,method:'POST',data:{jwt:this.jwt(credential,{nonce})}});
      if(typeof renewed.auth_token!=='string')throw new Error('Plex renewal unavailable');credential.token=renewed.auth_token;credential.expires=Date.now()+6*86400000;
    }
    if(expectedSubject){const profile=await this.request('/user',{token:credential.token,clientId:credential.clientId});if(String(profile.id)!==expectedSubject)throw new PlexAccessError('Plex credential identity mismatch',true);}
    const machine=await this.machine(),resources=await this.request('/resources?includeHttps=1&includeRelay=1',{token:credential.token,clientId:credential.clientId});
    const resource=Array.isArray(resources)&&resources.find(r=>r.clientIdentifier===machine&&String(r.provides).split(',').includes('server'));
    if(!resource||typeof resource.accessToken!=='string'||!resource.accessToken)throw Object.assign(new PlexAccessError('This Plex account does not have access to this server',true),{noServerAccess:true});
    credential.serverToken=resource.accessToken;
    const scoped=this.plex.scope(resource.accessToken,credential.clientId);
    scoped.discoveryToken=credential.token;
    let sections;try{sections=await scoped.json('/library/sections');}catch(error){const denied=[401,403,498].includes(error.status);throw new PlexAccessError(error.status?`Plex server library access check failed (HTTP ${error.status}); ${denied?'the server rejected this account token. Sign in or reconnect Plex again; check that this account has server access':'try again or check the Plex server'}`:'Plex server library access check could not reach the configured server; check PLEX_URL and connectivity',denied);}
    if(!Array.isArray(sections.Directory)||!sections.Directory.length)throw new PlexAccessError('This Plex account has no accessible libraries on this server',true);
    // A refreshed permission scope must not reuse data gathered before revalidation.
    for(const cache of [scoped.catalogCache,scoped.artSources,scoped.imageCache,scoped.randomCache,scoped.allowedItems])cache.clear();
    return scoped;
  }
  async fallback() {
    const token=this.config.plexFallback?.token;
    if(!token)return this.plex;
    if(this.fallbackCache?.token===token && this.fallbackCache.until>Date.now())return this.fallbackCache.plex;
    if(this.fallbackInflight?.token===token)return this.fallbackInflight.job;
    const generation=this.generation;
    const job=(async()=>{
      let scoped=this.plex.scope(token,'configured-fallback'),sections;
      try {sections=await scoped.json('/library/sections');}
      catch(error) {
        if(error.status!==401)throw error;
        // Configured fallback may be an account token rather than a PMS
        // token. Resolve access for that same account; never change identity.
        scoped=await this.validate({token,clientId:'configured-fallback'});
      }
      if(sections && (!Array.isArray(sections.Directory)||!sections.Directory.length))throw new PlexAccessError('The configured fallback account has no accessible libraries');
      if(generation!==this.generation)throw new PlexAccessError('Plex scope changed during validation');
      this.fallbackCache={token,plex:scoped,until:Date.now()+30000};return scoped;
    })();
    this.fallbackInflight={token,job};
    try{return await job;}finally{if(this.fallbackInflight?.job===job)this.fallbackInflight=undefined;}
  }
  async forUser(userId){
    const user=this.accounts.canonical(userId),identity=user&&this.accounts.identities(user.id).find(i=>i.provider==='plex');
    if(!identity)return;
    const cached=this.cache.get(identity.subject);if(cached&&cached.until>Date.now())return cached.plex;
    if(this.inflight.has(identity.subject))return this.inflight.get(identity.subject);
    const generation=this.generation;
    const job=(async()=>{const credential=this.accounts.credential(identity.subject);if(!credential)return;try{
      const scoped=await this.validate(credential,identity.subject);
      if(generation!==this.generation)throw new PlexAccessError('Plex scope changed during validation');
      this.accounts.credential(identity.subject,credential);this.cache.set(identity.subject,{plex:scoped,until:Date.now()+30000});return scoped;
    }catch(error){if(generation===this.generation)this.cache.delete(identity.subject);throw error;}})();
    this.inflight.set(identity.subject,job);try{return await job;}finally{if(this.inflight.get(identity.subject)===job)this.inflight.delete(identity.subject);}
  }
  fresh(userId){const identity=this.accounts.identities(userId).find(i=>i.provider==='plex');return !!identity&&!!this.cache.get(identity.subject)&&this.cache.get(identity.subject).until>Date.now();}
  clear(){this.generation++;this.cache.clear();this.inflight.clear();this.fallbackCache=undefined;this.fallbackInflight=undefined;}
}
module.exports={PlexAuth,PlexAccessError};
