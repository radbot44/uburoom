'use strict';
// Local tests only: client-bound traditional PINs, existing JWT renewal and fake media metadata.
const {createPublicKey,verify}=require('node:crypto');
function accountFixture(){
  const pins=new Map(),requests=[],revoked=new Set();let number=0;
  const profiles={alice:{id:'101',username:'alice_plex'},bob:{id:'102',username:'bob_plex'},denied:{id:'103',username:'no_access'}};
  const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
  const tokenProfile=token=>Object.values(profiles).find(profile=>token==='fixture-user-'+profile.id||token==='fixture-server-'+profile.id);
  const fetcher=async(input,options={})=>{
    const url=new URL(input),headers=options.headers||{},token=headers['X-Plex-Token'];requests.push({path:url.pathname,token,clientId:headers['X-Plex-Client-Identifier'],deviceJWT:url.searchParams.has('deviceJWT')});
    if(url.hostname==='clients.plex.tv'){
      if(url.pathname==='/api/v2/pins'&&options.method==='POST'){const data=options.body?JSON.parse(options.body):{},id=String(++number);if(!data.strong&&url.searchParams.get('strong')!=='true')return response({},400);pins.set(id,{jwk:data.jwk,clientId:headers['X-Plex-Client-Identifier']});return response({id,code:'fixture-code-'+id});}
      if(url.pathname.startsWith('/api/v2/pins/')){
        const pin=pins.get(url.pathname.split('/').pop()),jwt=url.searchParams.get('deviceJWT')?.split('.');
        if(!pin?.persona||headers['X-Plex-Client-Identifier']!==pin.clientId)return response({},401);
        if(pin.jwk){if(!jwt||!verify(null,Buffer.from(jwt[0]+'.'+jwt[1]),createPublicKey({key:pin.jwk,format:'jwk'}),Buffer.from(jwt[2],'base64url')))return response({},401);const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));if(claims.iss!==pin.clientId||claims.aud!=='plex.tv')return response({},401);}else if(jwt)return response({},401);
        return response({authToken:'fixture-user-'+profiles[pin.persona].id});
      }
      if(url.pathname==='/api/v2/auth/nonce')return response({nonce:'fixture-nonce'});
      if(url.pathname==='/api/v2/auth/token'){
        const pin=[...pins.values()].find(pin=>pin.clientId===headers['X-Plex-Client-Identifier']),jwt=JSON.parse(options.body).jwt.split('.');
        if(!pin?.persona||!verify(null,Buffer.from(jwt[0]+'.'+jwt[1]),createPublicKey({key:pin.jwk,format:'jwk'}),Buffer.from(jwt[2],'base64url')))return response({},401);
        const claims=JSON.parse(Buffer.from(jwt[1],'base64url'));if(claims.nonce!=='fixture-nonce'||claims.iss!==pin.clientId)return response({},401);
        return response({auth_token:'fixture-user-'+profiles[pin.persona].id});
      }
      const profile=tokenProfile(token);if(!profile||revoked.has(profile.id))return response({},401);
      if(url.pathname==='/api/v2/user')return response(profile);
      if(url.pathname==='/api/v2/resources')return response(profile.id==='103'?[]:[{clientIdentifier:'fixture-machine',provides:'server',accessToken:'fixture-server-'+profile.id}]);
      return response({},404);
    }
    if(token==='fixture-owner'){
      if(url.pathname==='/')return response({MediaContainer:{machineIdentifier:'fixture-machine'}});
    }
    const profile=tokenProfile(token);if(token!=='fixture-owner'&&(!profile||revoked.has(profile.id)))return response({},401);
    if(url.pathname==='/library/sections')return response({MediaContainer:{Directory:[{key:'1',type:'movie',title:'Fixture Movies'}]}});
    if(url.pathname==='/library/sections/1/all')return response({MediaContainer:{Metadata:[],totalSize:0}});
    const match=/^\/library\/metadata\/(\d+)$/.exec(url.pathname);
    if(match){if(match[1]==='999'&&profile?.id==='102')return response({},404);return response({MediaContainer:{Metadata:[{ratingKey:match[1],type:'movie',title:'Fixture movie',duration:60000,Media:[{videoCodec:'h264',bitrate:4000,width:640,height:360,Part:[{key:'/library/parts/'+match[1]+'/file.mp4'}]}]}]}});}
    if(url.pathname.startsWith('/library/parts/'))return new Response('fixture-media-bytes',{headers:{'content-type':'video/mp4'}});
    if(url.pathname.includes('/transcode/universal/decision'))return response({MediaContainer:{}});
    if(url.pathname.includes('/transcode/universal/'))return response({});
    return response({},404);
  };
  const subjects={host:'100000000000000001',guest:'100000000000000002',guest2:'100000000000000003'};
  const discordFetch=async(url,options={})=>{
    if(url.endsWith('/token')){const persona=new URLSearchParams(options.body).get('code')||'host';if(!subjects[persona])return response({},400);return response({access_token:'fixture-discord-'+subjects[persona],refresh_token:'fixture-refresh',expires_in:3600});}
    const id=(options.headers?.Authorization||'').replace('Bearer fixture-discord-','');if(!Object.values(subjects).includes(id))return response({},401);
    return response({id,username:'Demo '+Object.keys(subjects).find(key=>subjects[key]===id)});
  };
  return {fetch:fetcher,discordFetch,subjects,requests,revoked,choose(id,persona){if(!profiles[persona]||!pins.has(id))throw new Error('Choose a simulated Plex persona');pins.get(id).persona=persona;}};
}
module.exports={accountFixture};
