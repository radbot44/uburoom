'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events, Status } = require('discord.js');
const { connectBot, slashInput, helpText, watchVoice } = require('../server/discord');
const { discordAccess } = require('../server/sharing');
const Engine = require('../extension/engine');

function fakeClient(login) {
  const client = new EventEmitter();
  client.login = login;
  client.destroy = async () => { client.destroyed = true; };
  return client;
}

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
  assert.deepEqual(slashInput(options('zoom 150%', 'bob.bedroom')), Engine.parse('!radtv.bob.bedroom zoom 150%'));
  assert.deepEqual(slashInput(options('pause')), Engine.parse('!radtv pause'));
  assert.deepEqual(slashInput(options('pause', 'alice #2')), Engine.parse('!radtv.alice #2 pause'));
  assert.throws(() => slashInput(options('pause', 'bob pause')));
  assert.throws(() => slashInput(options('!radtv.other off', 'bob')));
  assert.equal(slashInput(options('help')).action, 'help.get');
  const help = helpText('https://watch.example');
  assert.ok(help.length < 2000, 'help fits a single Discord reply');
  for (const example of ['play', 'pause', 'toggle', 'mute', 'unmute', 'volume 50', 'seek -15', 'seek 15', 'zoom 150%', 'zoom +5%', 'zoom -5%', 'reset zoom', 'reset stretch', 'reset pan', 'reset all', 'profile load 1', 'profile save 1', 'status', 'off', 'help']) assert.doesNotThrow(() => Engine.parse('!radtv ' + example));
  assert.match(help, /https:\/\/watch\.example/);
});

test('Discord membership is fetched per request and voice permissions fail closed on shard gaps', async () => {
  const client = new EventEmitter(), voice = '111111111111111111'; let calls = 0, present = true;
  const g = { name: 'Test guild', available: true, shard: { status: Status.Ready },
    channels: { cache: new Map([[voice, { id: voice, name: 'Lounge', rawPosition: 0, isVoiceBased: () => true }]]) },
    voiceStates: { cache: new Map([['friend', { channelId: voice }]]) },
    members: { fetch: async options => {
      calls++; assert.deepEqual(options, { user: 'friend', force: true, cache: false });
      if (!present) throw new Error('Unknown member'); return { user: { bot: false } };
    } } };
  client.guilds = { cache: new Map([['guild', g]]) }; client.isReady = () => true;
  const access = discordAccess(client, 'guild');
  assert.equal(await access.refresh('friend'), true); assert.equal(access.isMember('friend'), true);
  assert.equal(access.voiceChannel('friend'), voice); assert.deepEqual(access.options(), { available: true, guildName: 'Test guild' });
  assert.equal(await access.refresh('friend'), true); assert.equal(calls, 2);
  g.voiceStates.cache.delete('friend'); assert.equal(access.voiceChannel('friend'), undefined);
  g.shard.status = Status.Reconnecting; client.emit(Events.ShardReconnecting);
  assert.equal(access.isMember('friend'), false); assert.equal(access.validVoiceChannel(voice), false);
  assert.equal(access.options().available, false); assert.equal(await access.refresh('friend'), false);
  g.shard.status = Status.Ready; present = false;
  assert.equal(await access.refresh('friend'), false); assert.equal(access.isMember('friend'), false);
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
