'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events, Status } = require('discord.js');
const { startBot, connectBot, slashInput, helpText, watchVoice } = require('../server/discord');
const { discordAccess } = require('../server/sharing');
const Engine = require('../shared/engine');

test('optional host-directory intents follow application flags without breaking ordinary bot login',async t=>{
  t.mock.method(console,'log',()=>{});t.mock.method(console,'warn',()=>{});
  const {IntentsBitField,GatewayIntentBits}=require('discord.js');
  for(const flags of [0,(1<<13)|(1<<15)]){
    const client=fakeClient(async()=>{queueMicrotask(()=>client.emit(Events.ClientReady));return 'fixture';});
    client.options={intents:new IntentsBitField([GatewayIntentBits.Guilds])};
    client.rest={setToken(){},async get(route){assert.equal(route,'/oauth2/applications/@me');return {flags};}};
    client.guilds={cache:new Map()};client.users={fetch:async()=>({username:'Owner'})};client.isReady=()=>true;
    client.application={commands:{set:async()=>{}}};
    const hub={publishVoice(){},dispatch:async()=>({status:'ok'})};
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

test('bot replaces its guild command set with ubu and routes only ubu through channel authorization', async t => {
  t.mock.method(console, 'log', () => {});
  const client = fakeClient(async () => { queueMicrotask(() => client.emit(Events.ClientReady)); return 'fixture'; });
  client.guilds = { cache: new Map() };
  client.isReady = () => true;
  client.users = { fetch: async () => ({ username: 'Owner' }) };
  const registrations = [], dispatched = [], replies = [];
  client.application = { commands: { set: async (...args) => { registrations.push(args); } } };
  const hub = { publishVoice() {}, dispatch: async (actor, input) => {
    dispatched.push({ actor, input }); return { status: 'ok', message: 'paused' };
  } };
  await startBot({ botToken: 'fixture', ownerId: 'owner', guildId: 'guild', channels: ['commands'] }, hub, { createClient: () => client });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0][1], 'guild');
  assert.deepEqual(registrations[0][0].map(command => command.name), ['ubu']);
  const message = (content, guildId = 'guild') => ({ content, guildId, channelId: 'commands', author: { id: 'friend', username: 'Friend', bot: false }, reply: async reply => replies.push(reply) });
  const receive = client.listeners(Events.MessageCreate)[0];
  await receive(message('!ubu pause', 'other'));
  await receive(message('!uburoom pause'));
  assert.equal(dispatched.length, 0);
  assert.equal(replies.length, 0);
  await receive(message('!ubu pause'));
  assert.equal(dispatched.length, 1);
  assert.equal(dispatched[0].input.action, 'media.pause');
  assert.equal(dispatched[0].actor.channelId, 'commands');
  assert.deepEqual(replies[0].allowedMentions, { parse: [], repliedUser: false });
  const interaction = { isChatInputCommand: () => true, commandName: 'ubu', guildId: 'guild', channelId: 'commands', user: { id: 'friend', username: 'Friend', bot: false }, options: { getString: name => name === 'command' ? 'pause' : null }, deferReply: async () => {}, editReply: async reply => replies.push(reply), reply: async reply => replies.push(reply) };
  const slash = client.listeners(Events.InteractionCreate)[0];
  await slash({ ...interaction, commandName: 'uburoom' });
  assert.equal(dispatched.length, 1);
  await slash({ ...interaction, guildId: 'other' });
  assert.equal(dispatched.length, 1);
  assert.match(replies.at(-1).content, /forbidden/);
  await slash(interaction);
  assert.equal(dispatched.length, 2);
  assert.equal(dispatched[1].input.action, 'media.pause');
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

test('slash commands use the same parser with an explicit target and cannot smuggle commands into it', () => {
  const options = (command, target) => ({ getString: name => name === 'command' ? command : target });
  assert.deepEqual(slashInput(options('zoom 150%', 'bob.bedroom')), Engine.parse('!ubu.bob.bedroom zoom 150%'));
  assert.deepEqual(slashInput(options('pause')), Engine.parse('!ubu pause'));
  assert.deepEqual(slashInput(options('pause', 'alice #2')), Engine.parse('!ubu.alice #2 pause'));
  assert.throws(() => slashInput(options('pause', 'bob pause')));
  assert.throws(() => slashInput(options('!ubu.other off', 'bob')));
  assert.equal(slashInput(options('help')).action, 'help.get');
  const help = helpText('https://watch.example');
  assert.ok(help.length < 2000, 'help fits a single Discord reply');
  for (const example of ['play', 'pause', 'toggle', 'mute', 'unmute', 'volume 50', 'seek -15', 'seek 15', 'zoom 150%', 'zoom +5%', 'zoom -5%', 'reset zoom', 'reset stretch', 'reset pan', 'reset all', 'profile load 1', 'profile save 1', 'status', 'off', 'help']) assert.doesNotThrow(() => Engine.parse('!ubu ' + example));
  assert.match(help, /https:\/\/watch\.example/);
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

test('call automation listens only to owner joins/moves in the configured guild; shard recovery sends a baseline', () => {
  const client = new EventEmitter(), messages=[];
  watchVoice({guildId:'guild',ownerId:'owner'},client,{publishVoice:(...args)=>messages.push(args)});
  const state=(channelId,id='owner',guildId='guild')=>({id,guild:{id:guildId},channelId});
  client.emit(Events.VoiceStateUpdate,state(null),state('voice'));
  assert.deepEqual(messages.pop(),[true]);
  client.emit(Events.VoiceStateUpdate,state('voice'),state('voice'));
  client.emit(Events.VoiceStateUpdate,state(null,'friend'),state('voice','friend'));
  client.emit(Events.VoiceStateUpdate,state(null,'owner','other'),state('voice','owner','other'));
  assert.equal(messages.length,0,'mute changes, friends and other guilds cannot trigger On join');
  client.emit(Events.VoiceStateUpdate,state('voice'),state('other-call'));
  assert.deepEqual(messages.pop(),[true]);
  client.emit(Events.VoiceStateUpdate,state('voice'),state(null));assert.deepEqual(messages.pop(),[false]);
  client.emit(Events.ShardDisconnect);assert.deepEqual(messages.pop(),[false,true]);
  client.emit(Events.ShardResume);assert.deepEqual(messages.pop(),[],'recovery does not manufacture a join');
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
    [new Error('Used disallowed intents: private-token'), /rejected Message Content Intent/],
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
