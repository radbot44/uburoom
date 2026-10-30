'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events, Status } = require('discord.js');
const { startBot, connectBot } = require('../server/discord');
const { discordAccess } = require('../server/sharing');

test('optional host-directory intents follow application flags without breaking ordinary bot login',async t=>{
  t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
  const {IntentsBitField,GatewayIntentBits}=require('discord.js');
  for(const flags of [0,(1<<13)|(1<<15)]){
    const client=fakeClient(async()=>{queueMicrotask(()=>client.emit(Events.ClientReady));return 'fixture';});
    client.options={intents:new IntentsBitField([GatewayIntentBits.Guilds])};
    client.rest={setToken(){},async get(route){assert.equal(route,'/oauth2/applications/@me');return {flags};}};
    client.guilds={cache:new Map()};client.users={fetch:async()=>({username:'Owner'})};client.isReady=()=>true;
    client.application={commands:{set:async()=>{}}};
    const hub={dispatch:async()=>({status:'ok'})};
    await startBot({botToken:'fixture',ownerId:'owner',guildId:'guild',channels:['commands']},hub,{createClient:()=>client});
    assert.equal(client.options.intents.has(GatewayIntentBits.GuildMembers),!!flags);
    assert.equal(client.options.intents.has(GatewayIntentBits.GuildPresences),!!flags);
  }
});

test('Discord directory pages the configured guild, excludes bots, and rejects connection changes; presence unknown stays unknown',async()=>{
  const {Collection,IntentsBitField,GatewayIntentBits}=require('discord.js');
  const client=new EventEmitter();client.isReady=()=>true;
  client.options={intents:new IntentsBitField([GatewayIntentBits.GuildMembers,GatewayIntentBits.GuildPresences])};
  const first=new Collection(Array.from({length:1000},(_,n)=>{const id=String(100000000000000000n+BigInt(n));return [id,{id,displayName:'User '+n,user:{bot:n===0,username:'alias'+n}}];}));
  let calls=0,release;
  const guild={available:true,shard:{status:Status.Ready},members:{async list(options){calls++;assert.equal(options.limit,1000);if(calls===1)return first;assert.equal(options.after,first.last().id);return new Collection();}},presences:{cache:new Map([['person',{status:'idle'}],['invisible',{status:'offline'}]])}};
  client.guilds={cache:new Map([['configured',guild]])};
  const access=discordAccess(client,'configured');
  assert.equal((await access.directory()).length,999);assert.equal(calls,2);
  assert.equal(access.discordOnline('person'),true);assert.equal(access.discordOnline('invisible'),false);assert.equal(access.discordOnline('unknown'),undefined);
  guild.members.list=()=>new Promise(resolve=>release=resolve);
  const request=access.directory();client.emit(Events.ShardDisconnect);release(new Collection());
  await assert.rejects(request,/connection changed/);
  guild.available=false;assert.equal(access.discordOnline('person'),undefined);await assert.rejects(access.directory(),/unavailable/);
});

function fakeClient(login) {
  const client = new EventEmitter();
  client.login = login;
  client.destroy = async () => { client.destroyed = true; };
  return client;
}

test('bot clears its guild command set on startup and registers no message or interaction listeners', async t => {
  t.mock.method(console, 'log', () => {});
  const client = fakeClient(async () => { queueMicrotask(() => client.emit(Events.ClientReady)); return 'fixture'; });
  client.guilds = { cache: new Map() };
  client.isReady = () => true;
  client.users = { fetch: async () => ({ username: 'Owner' }) };
  const registrations = [];
  client.application = { commands: { set: async (...args) => { registrations.push(args); } } };
  const hub = {};
  await startBot({ botToken: 'fixture', ownerId: 'owner', guildId: 'guild', channels: ['commands'] }, hub, { createClient: () => client });
  assert.deepEqual(registrations, [[[], 'guild']]);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
  assert.equal(client.listenerCount(Events.InteractionCreate), 0);
  await client.destroy();
});

test('Discord startup waits for actual readiness and removes its startup listener', async () => {
  const client = fakeClient(async () => 'private-token');
  let connected = false;
  const connection = connectBot(client, 'private-token', 1000).then(() => { connected = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connected, false, 'login completion alone is not readiness');
  client.emit(Events.ClientReady);
  await connection;
  assert.equal(connected, true);
  assert.equal(client.listenerCount(Events.ClientReady), 0);
  assert.equal(client.destroyed, undefined);
});

test('Discord membership is fetched per request and voice permissions fail closed on shard gaps', async () => {
  const client = new EventEmitter(), voice = '111111111111111111'; let calls = 0, present = true, role = true;
  const g = { name: 'Test guild', available: true, shard: { status: Status.Ready },
    channels: { cache: new Map([[voice, { id: voice, name: 'Lounge', rawPosition: 0, isVoiceBased: () => true }]]) },
    voiceStates: { cache: new Map([['friend', { channelId: voice }]]) },
    members: { fetch: async options => {
      calls++; assert.deepEqual(options, { user: 'friend', force: true, cache: false });
      if (!present) throw new Error('Unknown member'); return { user: { bot: false }, roles: { cache: new Map(role ? [['moderator', {}]] : []) } };
    } } };
  client.guilds = { cache: new Map([['guild', g]]) }; client.isReady = () => true;
  const access = discordAccess(client, 'guild');
  assert.equal(await access.refresh('friend'), true); assert.equal(access.isMember('friend'), true);
  assert.equal(access.hasRole('friend', 'moderator'), true);
  assert.equal(access.voiceChannel('friend'), voice); assert.deepEqual(access.options(), { available: true, guildName: 'Test guild' });
  assert.equal(await access.refresh('friend'), true); assert.equal(calls, 2);
  role = false; await access.refresh('friend');
  assert.equal(access.hasRole('friend', 'moderator'), false, 'a refreshed role removal revokes administrator eligibility');
  role = true; await access.refresh('friend');
  g.voiceStates.cache.delete('friend'); assert.equal(access.voiceChannel('friend'), undefined);
  g.shard.status = Status.Reconnecting; client.emit(Events.ShardReconnecting);
  assert.equal(access.isMember('friend'), false); assert.equal(access.validVoiceChannel(voice), false);
  assert.equal(access.hasRole('friend', 'moderator'), false);
  assert.equal(access.options().available, false); assert.equal(await access.refresh('friend'), false);
  g.shard.status = Status.Ready; present = false;
  assert.equal(await access.refresh('friend'), false); assert.equal(access.isMember('friend'), false);
  assert.equal(access.hasRole('friend', 'moderator'), false);
});

test('a stalled Discord login times out, destroys the client and cannot later become ready', async () => {
  const client = fakeClient(() => new Promise(() => {}));
  await assert.rejects(connectBot(client, 'private-token', 20), /login timed out/);
  assert.equal(client.destroyed, true);
  assert.equal(client.listenerCount(Events.ClientReady), 0);
  client.emit(Events.ClientReady);
});

test('Discord startup distinguishes token, intent and network failures without exposing error details', async () => {
  for (const [error, expected] of [
    [Object.assign(new Error('private-token'), { code: 'TokenInvalid' }), /rejected the bot token/],
    [new Error('Used disallowed intents: private-token'), /rejected the requested privileged Gateway intents/],
    [Object.assign(new Error('private-token'), { cause: { code: 'ECONNRESET' } }), /ECONNRESET/]
  ]) {
    const client = fakeClient(async () => { throw error; });
    await assert.rejects(connectBot(client, 'private-token', 1000), result => {
      assert.match(result.message, expected);
      assert.doesNotMatch(result.message, /private-token/);
      return true;
    });
    assert.equal(client.destroyed, true);
    assert.equal(client.listenerCount(Events.ClientReady), 0);
  }
});

test('lookup preserves cached membership while in-flight fetch is pending and handles timeout failure', async () => {
  const client = new EventEmitter();
  let fetchCount = 0;
  let delay = false;
  const g = {
    name: 'Guild',
    available: true,
    shard: { status: Status.Ready },
    members: {
      fetch: async () => {
        fetchCount++;
        if (delay) {
          await new Promise(r => setTimeout(r, 20));
          throw new Error('Fetch failed');
        }
        return { user: { bot: false }, roles: { cache: new Map() } };
      }
    }
  };
  client.guilds = { cache: new Map([['guild', g]]) };
  client.isReady = () => true;
  const access = discordAccess(client, 'guild');

  assert.equal(await access.refresh('friend'), true);
  assert.equal(access.isMember('friend'), true);
  assert.equal(fetchCount, 1);

  delay = true;
  const inFlight = access.refresh('friend');
  assert.equal(access.isMember('friend'), true, 'cached membership survives while lookup is in-flight');

  const res = await inFlight;
  assert.equal(res, false);
  assert.equal(access.isMember('friend'), true, 'valid cached membership survives failed refresh');
});
