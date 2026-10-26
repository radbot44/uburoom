'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const { randomBytes, randomUUID } = require('node:crypto');
const { Handoff, TTL } = require('../server/handoff');
const { createApp } = require('../server/app');
const secret = () => randomBytes(32).toString('hex');

test('handoff binds a single claim and approval to the exact browser proof; expires, cancels and cannot replay', () => {
  let now = 1000; const handoff = new Handoff(() => now), source = {userId:'host'};
  const issued = handoff.issue(source,'room'), proof = secret(), nonce = secret();
  assert.equal(handoff.claim(issued.code,proof,'invalid'),undefined);
  const attempt = handoff.claim(issued.code,proof,nonce);
  assert.ok(attempt); assert.equal(handoff.claim(issued.code,secret(),secret()),undefined,'URL code claims only once');
  assert.equal(handoff.browser(issued.id,secret(),nonce),undefined); assert.equal(handoff.browser(issued.id,proof,secret()),undefined);
  assert.equal(handoff.consume(attempt),false,'browser cannot redeem before source approval');
  assert.equal(handoff.approve(attempt,'000000'),false); assert.equal(handoff.approve(attempt,Number(attempt.verification)),false); assert.equal(handoff.approve(attempt,attempt.verification),true);
  assert.equal(handoff.consume(attempt),true); assert.equal(handoff.consume(attempt),false);
  assert.equal(handoff.browser(issued.id,proof,nonce),undefined,'consumed browser proof cannot replay');
  const second = handoff.issue(source); assert.equal(handoff.get(issued.id),undefined,'new link invalidates the source previous attempt');
  now += TTL; assert.equal(handoff.get(second.id),undefined); assert.equal(handoff.claim(second.code,proof,nonce),undefined);
  handoff.sweep(); assert.equal(handoff.attempts.size,0); assert.equal(handoff.codes.size,0);
  const third = handoff.issue(source); handoff.remove(handoff.get(third.id)); assert.equal(handoff.claim(third.code,proof,nonce),undefined);
  handoff.issue(source); handoff.close(); assert.equal(handoff.attempts.size,0);
});

async function fixture(t) {
  const cert = fs.readFileSync(path.join(__dirname,'../certs/server-cert.pem'));
  const config = {cert,key:fs.readFileSync(path.join(__dirname,'../certs/server-key.pem')),publicUrl:'https://localhost:6768',ownerId:'demo-host',guildId:'demo-guild',channels:['commands'],demo:true};
  const app = createApp(config); let member = true;
  app.hub.access = {refresh:async()=>member,isMember:()=>member,voiceChannel:()=> 'call',validVoiceChannel:()=>true,options:()=>({available:true})};
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve)); t.after(()=>app.close());
  const port = app.server.address().port; config.publicUrl = `https://localhost:${port}`;
  const control=require('./helpers/control-client').controlClient(t,config,cert);
  const request = (route,data,headers={}) => control.handles(route)?control.request(route,data,headers):new Promise((resolve,reject)=> {
    const req = https.request({hostname:'localhost',port,path:route,method:data === undefined?'GET':'POST',ca:cert,headers:{Origin:config.publicUrl,'Content-Type':'application/json',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{const raw=Buffer.concat(chunks).toString();resolve({status:res.statusCode,headers:res.headers,body:res.headers['content-type']?.includes('json')?JSON.parse(raw):raw});});
    });req.on('error',reject);req.end(data === undefined?undefined:JSON.stringify(data));
  });
  const source = async (persona='host',activity=true) => ({Authorization:'Bearer '+(await request('/api/watch/demo-login',{persona,activity})).body.token});
  const issue = async (headers,roomId) => (await request('/api/watch/handoff',roomId?{roomId}:{},headers)).body;
  const claim = async (issued,cookie) => {
    cookie ||= (await request('/auth/handoff')).headers['set-cookie'][0].split(';')[0];
    const proof=secret();const response=await request('/api/watch/handoff/claim',{code:new URL(issued.url).hash.slice(1),proof},{Cookie:cookie});
    return {response,proof,cookie,id:issued.id};
  };
  const approve = (headers,claimed) => request('/api/watch/handoff/action',{id:claimed.id,action:'approve',verification:claimed.response.body.verification},headers);
  const redeem = (claimed,extra={},headers={})=>request('/api/watch/handoff/redeem',{id:claimed.id,proof:claimed.proof,...extra},{Cookie:claimed.cookie,...headers});
  return {app,request,source,issue,claim,approve,redeem,setMember:value=>{member=value;}};
}
const tlsOptions = {skip:!fs.existsSync(path.join(__dirname,'../certs/server-cert.pem'))};

test('HTTPS handoff creates only a bounded cookie login, preserves room context and accepts exactly one concurrent redemption',tlsOptions,async t=> {
  const f=await fixture(t), source=await f.source();
  const id=(await f.request('/api/watch/rooms',{},source)).body.id;
  const viewer=randomUUID(); await f.request(`/api/watch/rooms/${id}?viewer=${viewer}`,undefined,source);
  const page=await f.request('/auth/handoff');
  assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.match(page.headers['referrer-policy'],/no-referrer/);assert.match(page.headers['set-cookie'][0],/HttpOnly; Secure; SameSite=Lax/);
  const issued=await f.issue(source,id);assert.equal(new URL(issued.url).pathname,'/auth/handoff');assert.equal(new URL(issued.url).search,'');
  assert.equal(issued.url.includes(source.Authorization.slice(7)),false);
  const claimed=await f.claim(issued,page.headers['set-cookie'][0].split(';')[0]);assert.equal(claimed.response.status,200);
  assert.equal((await f.redeem(claimed)).status,202);assert.equal((await f.approve(source,claimed)).status,200);
  const results=await Promise.all([f.redeem(claimed),f.redeem(claimed)]);
  assert.equal(results.filter(r=>r.status===200).length,1);
  const done=results.find(r=>r.status===200);assert.equal(done.body.destination,'/watch?room='+id);
  const cookie=done.headers['set-cookie'][0];assert.match(cookie,/HttpOnly; Secure; SameSite=Lax/);assert.ok(Number(/Max-Age=(\d+)/.exec(cookie)[1])<=3600);
  assert.equal((await f.redeem(claimed)).status,410);
  const me=await f.request('/api/watch/me',undefined,{Cookie:cookie.split(';')[0]});assert.equal(me.body.name,'Demo host');assert.equal(me.body.adminMode,false);
  assert.equal(f.app.watch.rooms.get(id).s.state.paused,true,'handoff does not issue playback commands');
  assert.equal(f.app.watch.rooms.get(id).viewers.size,1,'redemption itself does not create a viewer');
  const state=await f.request(`/api/watch/rooms/${id}?viewer=${randomUUID()}`,undefined,{Cookie:cookie.split(';')[0]});assert.equal(state.status,200);
  const logout=await f.request('/api/logout',{}, {Cookie:cookie.split(';')[0],'X-CSRF-Token':me.body.csrf});assert.equal(logout.status,200);
  assert.equal((await f.request('/api/watch/me',undefined,{Cookie:cookie.split(';')[0]})).status,401);
});

test('HTTPS handoff rejects other sources, cross-origin/proof attacks and unconfirmed browser account switches',tlsOptions,async t=> {
  const f=await fixture(t), source=await f.source(), other=await f.source('host');
  assert.equal((await f.request('/api/watch/handoff',{},await f.source('guest',false))).status,403);
  const issued=await f.issue(source),claimed=await f.claim(issued);
  assert.equal((await f.request('/api/watch/handoff/status',{id:issued.id},other)).status,410,'same user in another Activity does not own this attempt');
  assert.equal((await f.request('/api/watch/handoff/action',{id:issued.id,action:'approve',verification:claimed.response.body.verification},other)).status,410);
  assert.equal((await f.redeem(claimed,{}, {Origin:'https://evil.example'})).status,403);
  assert.equal((await f.redeem(claimed,{}, {Authorization:source.Authorization})).status,403);
  assert.equal((await f.redeem({...claimed,proof:secret()})).status,410);
  assert.equal((await f.redeem({...claimed,cookie:'uburoom_handoff='+secret()})).status,410);
  const guest=await f.source('guest'),guestClaim=await f.claim(await f.issue(guest));await f.approve(guest,guestClaim);
  const guestLogin=await f.redeem(guestClaim),browserCookie=guestLogin.headers['set-cookie'][0].split(';')[0];
  await f.approve(source,claimed);
  claimed.cookie+='; '+browserCookie;
  assert.equal((await f.redeem(claimed)).status,409,'existing different browser identity requires explicit switch');
  const switched=await f.redeem(claimed,{switchAccount:true});assert.equal(switched.status,200);
  const hostCookie=switched.headers['set-cookie'][0].split(';')[0];
  const before=(await f.request('/api/watch/me',undefined,{Cookie:hostCookie})).body;
  const again=await f.claim(await f.issue(source));again.cookie+='; '+hostCookie;
  await f.approve(source,again);
  const preserved=await f.redeem(again);assert.equal(preserved.status,200);
  assert.equal(preserved.headers['set-cookie'].some(value=>value.startsWith('uburoom=')),false,'same-account browser login is preserved');
  assert.equal((await f.request('/api/watch/me',undefined,{Cookie:hostCookie})).body.csrf,before.csrf);
});

test('HTTPS handoff rechecks revocation, cancellation, room privacy/closure and process lifetime',tlsOptions,async t=> {
  const f=await fixture(t),host=await f.source(),guest=await f.source('guest');
  const roomId=(await f.request('/api/watch/rooms',{},host)).body.id;
  assert.equal((await f.request('/api/watch/handoff',{roomId:randomUUID()},guest)).status,403);
  const privateClaim=await f.claim(await f.issue(guest,roomId));await f.approve(guest,privateClaim);
  f.app.watch.rooms.get(roomId).s.visibility='private';
  const privateDone=await f.redeem(privateClaim);assert.equal(privateDone.body.destination,'/watch','room revoked before redemption is not disclosed');
  const closedClaim=await f.claim(await f.issue(host,roomId));await f.approve(host,closedClaim);f.app.watch.remove(roomId);
  assert.equal((await f.redeem(closedClaim)).body.destination,'/watch');
  const cancelled=await f.claim(await f.issue(host));await f.request('/api/watch/handoff/action',{id:cancelled.id,action:'cancel'},host);
  assert.equal((await f.redeem(cancelled)).status,410);
  const revoked=await f.claim(await f.issue(host));await f.approve(host,revoked);f.setMember(false);
  assert.equal((await f.redeem(revoked)).status,403);f.setMember(true);assert.equal((await f.redeem(revoked)).status,410);
  const disappeared=await f.claim(await f.issue(host));
  const fresh=await fixture(t);assert.equal((await fresh.redeem(disappeared)).status,410,'new process cannot redeem an old attempt');
});
