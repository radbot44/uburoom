'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Events, Status } = require('discord.js');
const { startBot, connectBot } = require('../server/discord');
const { discordAccess } = require('../server/sharing');
const { Admission } = require('../server/admission');
const { accessPolicy } = require('./helpers/access');

test('any eligible Discord guild can grant entry, while exclusions, outages and guild removal stay distinct', async () => {
  const client = new EventEmitter();
  client.isReady = () => true;
  const calls = [];
  const guild = (id, roles) => ({
    id,
    available: true,
    shard: { status: Status.Ready },
    members: {
      async fetch() {
        calls.push(id);
        if (!roles) throw Object.assign(new Error('Unknown member'), { code: 10007 });
        return { user: { bot: false }, roles: { cache: new Map(roles.map(role => [role, {}])) } };
      },
    },
  });
  const first = guild('first'),
    second = guild('second', ['role-two']),
    third = guild('third', ['role-three']);
  const excluded = guild('excluded', ['private-role']);
  client.guilds = { cache: new Map([first, second, third, excluded].map(guild => [guild.id, guild])) };
  const access = discordAccess(client, ['excluded']);
  assert.equal(await access.refresh('member'), true);
  assert.deepEqual(calls, ['first', 'second', 'third']);
  assert.equal(access.hasRole('member', 'role-two'), true);
  assert.equal(access.hasRole('member', 'role-three'), true);
  assert.equal(access.hasRole('member', 'private-role'), false);
  third.available = false;
  client.emit(Events.GuildUnavailable, third);
  assert.equal(await access.refresh('member'), true, 'a positive result beats an outage');
  assert.equal(access.hasRole('member', 'role-three'), false);
  let answer;
  second.members.fetch = () => new Promise(resolve => (answer = resolve));
  const checking = access.refresh('member');
  await new Promise(resolve => setImmediate(resolve));
  client.guilds.cache.delete('second');
  client.emit(Events.GuildDelete, second);
  answer({ user: { bot: false } });
  assert.equal(await checking, undefined, 'a removed guild cannot grant a late positive result');
  assert.equal(access.isMember('member'), false);
  assert.equal(await access.refresh('member'), undefined, 'unavailable is distinct from a complete denial');
  client.guilds.cache.delete('third');
  client.emit(Events.GuildDelete, third);
  assert.equal(await access.refresh('member'), false, 'the excluded guild cannot grant entry');
  client.guilds.cache.delete('first');
  assert.equal(await access.refresh('member'), false, 'zero eligible guilds cannot grant entry');
});

test('optional host-directory intents follow application flags without breaking ordinary bot login', async t => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { IntentsBitField, GatewayIntentBits } = require('discord.js');
  for (const flags of [0, (1 << 13) | (1 << 15)]) {
    const client = fakeClient(async () => {
      queueMicrotask(() => client.emit(Events.ClientReady));
      return 'fixture';
    });
    client.options = { intents: new IntentsBitField([GatewayIntentBits.Guilds]) };
    client.rest = {
      setToken() {},
      async get(route) {
        assert.equal(route, '/oauth2/applications/@me');
        return { flags };
      },
    };
    client.guilds = { cache: new Map() };
    client.users = { fetch: async () => ({ username: 'Owner' }) };
    client.isReady = () => true;
    client.application = { commands: { set: async () => {} } };
    const link = { access: { connect() {} }, discord: {}, setOwnerName() {} };
    await startBot({ botToken: 'fixture', ownerId: 'owner', guildId: 'guild' }, link, {
      createClient: () => client,
    });
    assert.equal(client.options.intents.has(GatewayIntentBits.GuildMembers), !!flags);
    assert.equal(client.options.intents.has(GatewayIntentBits.GuildPresences), !!flags);
  }
});

test('Discord directory pages the configured guild, excludes bots, and rejects connection changes; presence unknown stays unknown', async () => {
  const { Collection, IntentsBitField, GatewayIntentBits } = require('discord.js');
  const client = new EventEmitter();
  client.isReady = () => true;
  client.options = { intents: new IntentsBitField([GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences]) };
  const first = new Collection(
    Array.from({ length: 1000 }, (_, n) => {
      const id = String(100000000000000000n + BigInt(n));
      return [id, { id, displayName: 'User ' + n, user: { bot: n === 0, username: 'alias' + n } }];
    }),
  );
  let calls = 0,
    release;
  const guild = {
    available: true,
    shard: { status: Status.Ready },
    members: {
      async list(options) {
        calls++;
        assert.equal(options.limit, 1000);
        if (calls === 1) return first;
        assert.equal(options.after, first.last().id);
        return new Collection();
      },
    },
    presences: {
      cache: new Map([
        ['person', { status: 'idle' }],
        ['invisible', { status: 'offline' }],
      ]),
    },
  };
  client.guilds = { cache: new Map([['configured', guild]]) };
  const access = discordAccess(client);
  assert.equal((await access.directory()).length, 999);
  assert.equal(calls, 2);
  assert.equal(access.discordOnline('person'), true);
  assert.equal(access.discordOnline('invisible'), false);
  assert.equal(access.discordOnline('unknown'), undefined);
  guild.members.list = () => new Promise(resolve => (release = resolve));
  const request = access.directory();
  client.emit(Events.ShardDisconnect);
  release(new Collection());
  await assert.rejects(request, /connection changed/);
  guild.available = false;
  assert.equal(access.discordOnline('person'), undefined);
  await assert.rejects(access.directory(), /unavailable/);
});

function fakeClient(login) {
  const client = new EventEmitter();
  client.login = login;
  client.destroy = async () => {
    client.destroyed = true;
  };
  return client;
}

test('bot starts without rewriting guild commands or registering message and interaction listeners', async t => {
  t.mock.method(console, 'log', () => {});
  const client = fakeClient(async () => {
    queueMicrotask(() => client.emit(Events.ClientReady));
    return 'fixture';
  });
  client.guilds = {
    cache: new Map([
      ['guild', {}],
      ['another', {}],
    ]),
  };
  client.isReady = () => true;
  client.users = { fetch: async () => ({ username: 'Owner' }) };
  const registrations = [];
  client.application = {
    commands: {
      set: async (...args) => {
        registrations.push(args);
      },
    },
  };
  const link = { access: { connect() {} }, discord: {}, setOwnerName() {} };
  await startBot({ botToken: 'fixture', ownerId: 'owner', guildId: 'guild' }, link, {
    createClient: () => client,
  });
  assert.deepEqual(registrations, []);
  assert.equal(client.listenerCount(Events.MessageCreate), 0);
  assert.equal(client.listenerCount(Events.InteractionCreate), 0);
  await client.destroy();
});

test('Discord startup waits for readiness, handles timeouts, and distinguishes sanitized failures', async () => {
  const client = fakeClient(async () => 'private-token');
  let connected = false;
  const connection = connectBot(client, 'private-token', 1000).then(() => {
    connected = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(connected, false, 'login completion alone is not readiness');
  client.emit(Events.ClientReady);
  await connection;
  assert.equal(connected, true);
  assert.equal(client.listenerCount(Events.ClientReady), 0);
  assert.equal(client.destroyed, undefined);

  // Stalled login timeout destroys client
  const stalled = fakeClient(() => new Promise(() => {}));
  await assert.rejects(connectBot(stalled, 'private-token', 20), /login timed out/);
  assert.equal(stalled.destroyed, true);
  assert.equal(stalled.listenerCount(Events.ClientReady), 0);
  stalled.emit(Events.ClientReady);

  // Error classification and token sanitization
  for (const [error, expected] of [
    [Object.assign(new Error('private-token'), { code: 'TokenInvalid' }), /rejected the bot token/],
    [new Error('Used disallowed intents: private-token'), /rejected the requested privileged Gateway intents/],
    [Object.assign(new Error('private-token'), { cause: { code: 'ECONNRESET' } }), /ECONNRESET/],
  ]) {
    const errClient = fakeClient(async () => {
      throw error;
    });
    await assert.rejects(connectBot(errClient, 'private-token', 1000), result => {
      assert.match(result.message, expected);
      assert.doesNotMatch(result.message, /private-token/);
      return true;
    });
    assert.equal(errClient.destroyed, true);
    assert.equal(errClient.listenerCount(Events.ClientReady), 0);
  }
});

test('Discord membership is fetched per request, caches in-flight lookups, and voice permissions fail closed on shard gaps', async () => {
  const client = new EventEmitter(),
    voice = '111111111111111111';
  let calls = 0,
    present = true,
    role = true;
  const g = {
    name: 'Test guild',
    available: true,
    shard: { status: Status.Ready },
    channels: { cache: new Map([[voice, { id: voice, name: 'Lounge', rawPosition: 0, isVoiceBased: () => true }]]) },
    voiceStates: { cache: new Map([['friend', { channelId: voice }]]) },
    members: {
      fetch: async options => {
        calls++;
        assert.deepEqual(options, { user: 'friend', force: true, cache: false });
        if (!present) throw Object.assign(new Error('Unknown Member'), { code: 10007 });
        return { user: { bot: false }, roles: { cache: new Map(role ? [['moderator', {}]] : []) } };
      },
    },
  };
  client.guilds = { cache: new Map([['guild', g]]) };
  client.isReady = () => true;
  const access = discordAccess(client);
  assert.equal(await access.refresh('friend'), true);
  assert.equal(access.isMember('friend'), true);
  assert.equal(access.hasRole('friend', 'moderator'), true);
  assert.equal(access.voiceChannel('friend'), voice);
  assert.deepEqual(access.options(), { available: true });
  assert.equal(await access.refresh('friend'), true);
  assert.equal(calls, 2);
  role = false;
  await access.refresh('friend');
  assert.equal(
    access.hasRole('friend', 'moderator'),
    false,
    'a refreshed role removal revokes administrator eligibility',
  );
  role = true;
  await access.refresh('friend');
  g.voiceStates.cache.delete('friend');
  assert.equal(access.voiceChannel('friend'), undefined);
  g.shard.status = Status.Reconnecting;
  client.emit(Events.ShardReconnecting);
  assert.equal(access.isMember('friend'), false);
  assert.equal(access.validVoiceChannel(voice), false);
  assert.equal(access.hasRole('friend', 'moderator'), false);
  assert.equal(access.options().available, false);
  assert.equal(await access.refresh('friend'), undefined);
  g.shard.status = Status.Ready;
  present = false;
  assert.equal(await access.refresh('friend'), false);
  assert.equal(access.isMember('friend'), false);
  assert.equal(access.hasRole('friend', 'moderator'), false);

  // Cached membership survives while in-flight fetch is pending and handles timeout/outage
  let delayed = false;
  const prevFetch = g.members.fetch;
  g.members.fetch = async options => {
    if (delayed) {
      await new Promise(r => setTimeout(r, 20));
      throw new Error('Fetch failed');
    }
    return prevFetch(options);
  };
  present = true;
  assert.equal(await access.refresh('friend'), true);
  assert.equal(access.isMember('friend'), true);
  delayed = true;
  const inFlight = access.refresh('friend');
  assert.equal(access.isMember('friend'), true, 'cached membership survives while lookup is in-flight');
  const res = await inFlight;
  assert.equal(res, undefined, 'a failed lookup is no answer, not a denial');
  assert.equal(access.isMember('friend'), true, 'valid cached membership survives failed refresh');
});

test('admission survives a provider that gives no answer, but not its denial', async () => {
  let answer = true,
    asked = 0;
  const account = { id: 'viewer', name: 'Viewer' },
    other = { id: 'other', name: 'Other' };
  const registry = {
    canonical: id => (id === 'viewer' ? account : id === 'other' ? other : undefined),
    identities: id => [{ provider: 'discord', subject: id, verified: true }],
  };
  const config = { ownerId: 'owner', accessPolicy: accessPolicy() };
  const policy = new Admission(config, registry, undefined, () => ({
    isMember: () => false,
    refresh: async () => {
      asked++;
      return answer;
    },
  }));
  const due = () => {
    policy.confirmed.get('viewer').recheck = 0;
  };

  assert.equal(await policy.admit('viewer'), true);
  assert.equal(await policy.admit('viewer'), true);
  assert.equal(asked, 1, 'a confirmed viewer is not asked about again before the recheck');

  answer = undefined;
  due();
  assert.equal(await policy.admit('viewer'), true, 'an admitted viewer keeps their place');
  assert.equal(await policy.admit('other'), false, 'nobody new is admitted without an answer');

  answer = false;
  due();
  assert.equal(await policy.admit('viewer'), false, 'the provider denial still removes them');
  answer = undefined;
  assert.equal(await policy.admit('viewer'), false, 'and nothing is left to keep');
});

test('Discord Rich Presence formatter redacts private rooms, gates timestamps on live playback, and omits unsafe fields', () => {
  const { buildPresenceActivity, equivalentPresence } = require('../web/watch/discord-presence.js');
  const nowMs = 1_700_000_100_000;
  const publicRoom = {
    visibility: 'public',
    roomName: 'Friday Screening',
    mediaId: 'movie-1',
    title: 'Spirited Away',
    subtitle: '2001 · 125m',
    serverNow: nowMs,
    state: { paused: false, waitingForReady: false, position: 100, duration: 1000 },
  };

  assert.equal(buildPresenceActivity({ enabled: false, activity: true, room: publicRoom, nowMs }), null);
  assert.equal(buildPresenceActivity({ enabled: true, activity: false, room: publicRoom, nowMs }), null);
  assert.equal(
    buildPresenceActivity({ enabled: true, serverAllowed: false, activity: true, room: publicRoom, nowMs }),
    null,
  );
  assert.equal(buildPresenceActivity({ enabled: true, activity: true, room: undefined, nowMs }), null);

  const privatePresence = buildPresenceActivity({
    enabled: true,
    activity: true,
    room: { ...publicRoom, visibility: 'private' },
    nowMs,
  });
  assert.deepEqual(privatePresence, { type: 3, details: 'Watching in uburoom' });

  const playingPresence = buildPresenceActivity({ enabled: true, activity: true, room: publicRoom, nowMs });
  assert.equal(playingPresence.type, 3);
  assert.equal(playingPresence.details, 'Spirited Away');
  assert.equal(playingPresence.state, '2001 · 125m · Friday Screening');
  assert.deepEqual(playingPresence.timestamps, { start: 1_700_000_000, end: 1_700_001_000 });
  assert.equal(playingPresence.assets, undefined);
  assert.equal(playingPresence.secrets, undefined);
  assert.equal(playingPresence.party, undefined);

  // Continuous playback 10s later yields identical timestamps; small 1s clock jitter stays equivalent.
  const tenSecondsLater = buildPresenceActivity({
    enabled: true,
    activity: true,
    room: { ...publicRoom, serverNow: nowMs + 10_000, state: { ...publicRoom.state, position: 110 } },
    nowMs: nowMs + 10_000,
  });
  assert.deepEqual(tenSecondsLater.timestamps, playingPresence.timestamps);
  assert.equal(
    equivalentPresence(playingPresence, {
      ...playingPresence,
      timestamps: { start: playingPresence.timestamps.start + 1, end: playingPresence.timestamps.end + 1 },
    }),
    true,
  );

  // Pausing or waiting for readiness clears timestamps.
  const paused = buildPresenceActivity({
    enabled: true,
    activity: true,
    room: { ...publicRoom, state: { ...publicRoom.state, paused: true } },
    nowMs,
  });
  assert.equal(paused.timestamps, undefined);
  assert.match(paused.state, /^Paused · /);

  const waiting = buildPresenceActivity({
    enabled: true,
    activity: true,
    room: { ...publicRoom, state: { ...publicRoom.state, waitingForReady: true } },
    nowMs,
  });
  assert.equal(waiting.timestamps, undefined);
});

test('Discord Rich Presence controller debounces, suppresses drift, handles consent denial, and clears on leave', async () => {
  const { createPresenceController } = require('../web/watch/discord-presence.js');
  let wallMs = 1_700_000_100_000;
  let enabled = true;
  let allowScope = true;
  let deniedCount = 0;
  let nextTimerId = 1;
  const timers = new Map();
  const sent = [];
  let room = {
    visibility: 'public',
    roomName: 'Main Room',
    mediaId: 'ep-1',
    title: 'Show Episode',
    subtitle: 'S1 · E1',
    serverNow: wallMs,
    state: { paused: false, waitingForReady: false, position: 50, duration: 500 },
  };

  const controller = createPresenceController({
    getSdk: () => ({
      commands: {
        setActivity: async arg => {
          sent.push(arg);
        },
      },
    }),
    isActivity: () => true,
    isEnabled: () => enabled,
    setEnabled: next => {
      enabled = next;
    },
    isServerAllowed: () => true,
    getRoom: () => room,
    ensureScope: async () => allowScope,
    now: () => wallMs,
    debounceMs: 100,
    minIntervalMs: 1000,
    setTimeoutFn: (fn, ms) => {
      const id = nextTimerId++;
      timers.set(id, { fn, at: wallMs + ms });
      return id;
    },
    clearTimeoutFn: id => timers.delete(id),
    onAuthDenied: () => {
      deniedCount++;
      enabled = false;
    },
  });

  await controller.sync();
  assert.equal(timers.size, 1);
  wallMs += 100;
  for (const [id, entry] of [...timers]) {
    timers.delete(id);
    await entry.fn();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].activity.details, 'Show Episode');

  // Minor 1s drift update does not schedule another setActivity IPC call.
  wallMs += 5000;
  room = { ...room, serverNow: wallMs, state: { ...room.state, position: 56 } };
  await controller.sync();
  assert.equal(timers.size, 0);

  // Room leave clears presence immediately without waiting on debounce.
  room = undefined;
  await controller.clear();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].activity, null);

  // Denying OAuth consent flips enabled back off cleanly and prevents retry spam.
  allowScope = false;
  room = {
    visibility: 'private',
    roomName: 'Secret',
    mediaId: 'x',
    title: 'Hidden',
    serverNow: wallMs,
    state: { paused: true, waitingForReady: false, position: 0, duration: 100 },
  };
  await controller.setEnabled(true);
  wallMs += 1000;
  for (const [id, entry] of [...timers]) {
    timers.delete(id);
    await entry.fn();
  }
  assert.equal(deniedCount, 1);
  assert.equal(enabled, false);
  await controller.sync();
  assert.equal(timers.size, 0);
});

test('Activity connection keeps baseline login prompt=none identify-only and requests rpc.activities.write incrementally', async t => {
  const { mountModule } = require('./helpers/watch-module');
  const connection = require('../web/watch/connection.js');

  const authorizeCalls = [];
  const authenticateCalls = [];
  let denyRpc = false;
  let rejectRpcRenewal = false;

  const mounted = mountModule(connection, {
    activity: true,
    config: { clientId: 'client-1', discordRichPresence: true },
    token: 'initial-token',
    diagnostics: { record() {} },
    sdk: {
      commands: {
        authorize: async args => {
          authorizeCalls.push(args);
          if (denyRpc && args.scope.includes('rpc.activities.write')) throw new Error('User denied scope');
          if (rejectRpcRenewal && args.prompt === 'none' && args.scope.includes('rpc.activities.write'))
            throw new Error('Consent revoked');
          return { code: 'oauth-code-' + authorizeCalls.length };
        },
        authenticate: async args => {
          authenticateCalls.push(args);
          return true;
        },
      },
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        token: 'jwt-' + authorizeCalls.length,
        accessToken: 'discord-access-' + authorizeCalls.length,
        expiresAt: Date.now() + 3600_000,
      }),
    }),
  });
  t.after(mounted.restore);

  await mounted.api.activityIdentity();
  assert.deepEqual(authorizeCalls[0].scope, ['identify']);
  assert.equal(authorizeCalls[0].prompt, 'none');
  assert.equal(mounted.api.hasRichPresenceScope(), false);

  // Declining incremental RPC consent returns false and keeps existing viewing sign-in intact.
  denyRpc = true;
  assert.equal(await mounted.api.requestRichPresenceScope(), false);
  assert.equal(mounted.view.token, 'initial-token');
  assert.equal(mounted.api.hasRichPresenceScope(), false);
  assert.equal('prompt' in authorizeCalls[1], false);
  assert.deepEqual(authorizeCalls[1].scope, ['identify', 'rpc.activities.write']);

  // Granting incremental consent authenticates SDK and preserves both scopes across renewals,
  // falling back to ['identify'] if RPC consent is later revoked.
  denyRpc = false;
  assert.equal(await mounted.api.requestRichPresenceScope(), true);
  assert.equal(mounted.api.hasRichPresenceScope(), true);
  assert.equal(authenticateCalls.at(-1).access_token, 'discord-access-3');

  mounted.view.identityRenewAt = 0;
  mounted.view.identityExpiresAt = Date.now() + 60_000;
  rejectRpcRenewal = true;
  await mounted.api.renewIdentity();
  assert.equal(mounted.api.hasRichPresenceScope(), false);
  assert.deepEqual(authorizeCalls.at(-1).scope, ['identify']);
  assert.equal(authorizeCalls.at(-1).prompt, 'none');
});

test('Discord Rich Presence UI switch stays hidden outside Activity or when server-disabled and reverts cleanly on scope denial', async t => {
  const { mountModule, element } = require('./helpers/watch-module');
  const preferences = require('../web/watch/preferences.js');
  const tracksMenu = require('../web/watch/tracks-menu.js');
  const prevResizeObserver = globalThis.ResizeObserver;
  const prevMutationObserver = globalThis.MutationObserver;
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  t.after(() => {
    if (prevResizeObserver === undefined) delete globalThis.ResizeObserver;
    else globalThis.ResizeObserver = prevResizeObserver;
    if (prevMutationObserver === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prevMutationObserver;
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  });

  const docOverrides = () => {
    const byId = new Map();
    return {
      getElementById: id => {
        if (id.endsWith('-group')) return null;
        if (!byId.has(id)) {
          const el = element();
          el.options = [];
          el.isConnected = false;
          if (id === 'player-mute') el.closest = () => element('div');
          byId.set(id, el);
        }
        return byId.get(id);
      },
    };
  };

  const fakeVideo = () => {
    const v = element('video');
    v.parentElement = element('div');
    v.textTracks = { length: 0, addEventListener() {} };
    v.addTextTrack = () => ({ mode: 'hidden', cues: [], addCue() {}, removeCue() {} });
    return v;
  };

  const storageData = new Map();
  const fakeStorage = {
    getItem: key => (storageData.has(key) ? storageData.get(key) : null),
    setItem: (key, val) => storageData.set(key, val),
  };

  // Non-Activity browser hides the Rich Presence switch even if server allows it.
  const browserPref = mountModule(preferences, {
    activity: false,
    document: docOverrides(),
    localStorage: fakeStorage,
    subtitleLayout: () => {},
  });
  assert.equal(browserPref.view.playerPreferences.discordRichPresence, false);
  const browserTracks = mountModule(tracksMenu, {
    activity: false,
    document: docOverrides(),
    video: fakeVideo(),
    config: { discordRichPresence: true },
    playerPreferences: browserPref.view.playerPreferences,
  });
  assert.equal(browserTracks.view.document.getElementById('discord-rich-presence-settings').hidden, true);
  browserTracks.restore();
  browserPref.restore();

  // Server-disabled discordRichPresence hides the switch even inside Discord Activity.
  const disabledTracks = mountModule(tracksMenu, {
    activity: true,
    document: docOverrides(),
    video: fakeVideo(),
    config: { discordRichPresence: false },
    playerPreferences: { discordRichPresence: false },
  });
  assert.equal(disabledTracks.view.document.getElementById('discord-rich-presence-settings').hidden, true);
  disabledTracks.restore();

  // Inside Discord Activity when server allows: defaults off, reverts on consent denial, persists on grant.
  let allowGrant = false;
  const enabledCalls = [];
  const pref = mountModule(preferences, {
    activity: true,
    document: docOverrides(),
    localStorage: fakeStorage,
    subtitleLayout: () => {},
  });
  t.after(pref.restore);
  const tracks = mountModule(tracksMenu, {
    activity: true,
    document: docOverrides(),
    video: fakeVideo(),
    config: { discordRichPresence: true },
    playerPreferences: pref.view.playerPreferences,
    savePlayerPreferences: pref.api.savePlayerPreferences,
    requestRichPresenceScope: async () => allowGrant,
    setRichPresenceEnabled: async value => enabledCalls.push(value),
  });
  t.after(tracks.restore);

  const rpSettings = tracks.view.document.getElementById('discord-rich-presence-settings');
  const rpInput = tracks.view.document.getElementById('discord-rich-presence');
  assert.equal(rpSettings.hidden, false);
  assert.equal(rpInput.checked, false);

  rpInput.checked = true;
  await rpInput.listeners.change();
  assert.equal(rpInput.checked, false);
  assert.equal(pref.view.playerPreferences.discordRichPresence, false);
  assert.deepEqual(enabledCalls, [false]);

  allowGrant = true;
  rpInput.checked = true;
  await rpInput.listeners.change();
  assert.equal(rpInput.checked, true);
  assert.equal(pref.view.playerPreferences.discordRichPresence, true);
  assert.equal(JSON.parse(storageData.get('uburoom.player')).discordRichPresence, true);
  assert.deepEqual(enabledCalls, [false, true]);
});
