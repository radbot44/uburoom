'use strict';
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  https = require('node:https');
const { randomBytes } = require('node:crypto');
const { createApp } = require('../server/app');
const { accountFixture } = require('../scripts/account-fixture');
const { ConversionPolicy } = require('../server/transcoding-policy');
const { normalizeConfig } = require('../server/config');

async function fixture(t, changes = {}) {
  const provider = accountFixture(),
    cert = fs.readFileSync(path.join(__dirname, '../certs/server-cert.pem'));
  const config = {
    cert,
    key: fs.readFileSync(path.join(__dirname, '../certs/server-key.pem')),
    publicUrl: 'https://localhost',
    ownerId: provider.subjects.host,
    clientId: '100000000000000010',
    clientSecret: 'fixture-secret',
    guildId: 'guild',
    channels: ['commands'],
    demo: true,
    unifiedAccounts: true,
    demoSubjects: provider.subjects,
    plexUrl: 'http://plex-fixture.invalid:32400',
    plexToken: 'fixture-owner',
    accessPolicy: { discord: true, plex: true, requirePlex: false, password: '', publicWeb: true },
    plexFallback: { enabled: true, token: '' },
    ...changes,
  };
  const app = createApp(config, { plexFetch: provider.fetch, oauthFetch: provider.discordFetch, plexDemo: provider });
  const members = new Set(Object.values(provider.subjects));
  app.hub.access = {
    refresh: async id => members.has(id),
    isMember: id => members.has(id),
    voiceChannel: () => 'voice',
    validVoiceChannel: id => id === 'voice',
    options: () => ({ available: true }),
  };
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  config.publicUrl = 'https://localhost:' + app.server.address().port;
  t.after(() => app.close());
  function browser() {
    const jar = new Map(),
      control = require('./helpers/control-client').controlClient(t, config, cert);
    const request = (route, data, extra = {}) => {
      const headers = {
        Origin: config.publicUrl,
        'Content-Type': 'application/json',
        Cookie: [...jar].map(([key, value]) => key + '=' + value).join('; '),
        ...extra,
      };
      if (control.handles(route)) return control.request(route, data, headers);
      return new Promise((resolve, reject) => {
        const req = https.request(
          config.publicUrl + route,
          { method: data === undefined ? 'GET' : 'POST', ca: cert, headers },
          res => {
            for (const cookie of res.headers['set-cookie'] || []) {
              const [key, value] = cookie.split(';')[0].split('=');
              jar.set(key, value);
            }
            let raw = '';
            res.on('data', bytes => (raw += bytes));
            res.on('end', () =>
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: res.headers['content-type']?.includes('json') ? JSON.parse(raw) : raw,
              }),
            );
          },
        );
        req.on('error', reject);
        req.end(data === undefined ? undefined : JSON.stringify(data));
      });
    };
    const post = async (route, data) =>
      request(route, data, { 'X-CSRF-Token': (await request('/api/watch/admission')).body.csrf || '' });
    const discord = async (persona = 'host') => {
      const start = await request('/auth/discord'),
        url = new URL(start.headers.location, config.publicUrl);
      return request('/auth/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: persona }));
    };
    const plex = async (persona = 'alice') => {
      const start = await request('/auth/plex'),
        url = new URL(start.headers.location, config.publicUrl);
      const selected = await request(
        '/auth/plex/demo?' + new URLSearchParams({ state: url.searchParams.get('state'), persona }),
      );
      return selected.status === 302 ? request(selected.headers.location) : selected;
    };
    return { jar, request, post, discord, plex };
  }
  return { app, config, provider, members, browser };
}

test('codec samples require active admin mode with browser or Activity authorization', async t => {
  const f = await fixture(t),
    browser = f.browser(),
    sample = '/__diagnostics/media/av1.webm';
  assert.equal((await browser.request(sample)).status, 403);
  await browser.discord();
  assert.equal((await browser.request(sample)).status, 403);
  assert.equal((await browser.post('/api/watch/admin-mode', { enabled: true })).status, 200);
  assert.equal((await browser.request(sample)).status, 200);
  await browser.post('/api/watch/admin-mode', { enabled: false });
  assert.equal((await browser.request(sample)).status, 403);
  const activity = f.browser(),
    login = await activity.request('/api/watch/demo-login', { persona: 'host', activity: true });
  const headers = { Authorization: 'Bearer ' + login.body.token };
  assert.equal((await activity.request(sample, undefined, headers)).status, 403);
  assert.equal((await activity.request('/api/watch/admin-mode', { enabled: true }, headers)).status, 200);
  assert.equal((await activity.request(sample, undefined, headers)).status, 200);
  const guest = f.browser(),
    guestLogin = await guest.request('/api/watch/demo-login', { persona: 'guest', activity: true });
  assert.equal(
    (await guest.request(sample, undefined, { Authorization: 'Bearer ' + guestLogin.body.token })).status,
    403,
  );
  await activity.request('/api/watch/admin-mode', { enabled: false }, headers);
  assert.equal((await activity.request(sample, undefined, headers)).status, 403);
});

test('shared password is additional to provider sign-in and applies to HTTP and sockets', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, requirePlex: false, password: 'fixture-password', publicWeb: true },
    }),
    browser = f.browser();
  await browser.discord();
  assert.equal((await browser.request('/api/watch/me')).status, 401);
  assert.equal((await browser.request('/api/watch/rooms')).status, 401);
  assert.equal((await browser.request('/api/watch/entry', { password: 'wrong' })).status, 403);
  assert.equal(
    (
      await browser.request(
        '/api/watch/entry',
        { password: 'fixture-password' },
        { Origin: 'https://attacker.invalid' },
      )
    ).status,
    429,
  );
  assert.equal((await browser.request('/api/watch/entry', { password: 'fixture-password' })).status, 200);
  assert.equal((await browser.request('/api/watch/me')).status, 200);
  assert.equal((await browser.request('/api/watch/rooms')).status, 200);
  const other = f.browser();
  await other.request('/api/watch/entry', { password: 'fixture-password' });
  assert.equal(
    (await other.request('/api/watch/me')).status,
    401,
    'password alone does not replace enabled provider identity',
  );
});

test('anonymous entry gets a distinct account, shared media scope and no owner/admin rights', async t => {
  const f = await fixture(t, {
    accessPolicy: { discord: false, plex: false, requirePlex: false, password: '', publicWeb: true },
    channels: [],
  });
  const a = f.browser(),
    b = f.browser();
  await a.request('/api/watch/entry', {});
  await b.request('/api/watch/entry', {});
  const first = (await a.request('/api/watch/me')).body,
    second = (await b.request('/api/watch/me')).body;
  assert.notEqual(first.account.id, second.account.id);
  assert.equal(first.owner, false);
  assert.equal(first.adminEligible, false);
  assert.equal((await f.app.hub.plexFor({ userId: first.account.id })).principal, 'discord-shared');
  assert.equal((await a.post('/api/watch/rooms', {})).status, 201, 'no Discord channels needed for browser rooms');
});

test('Plex-required admission supports pending Discord identity and linking, and never accepts nonmember Plex', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, requirePlex: true, password: '', publicWeb: true },
    }),
    browser = f.browser();
  await browser.discord();
  assert.equal((await browser.request('/api/watch/me')).status, 401);
  const pending = (await browser.request('/api/watch/admission')).body;
  assert.equal(pending.identity, true);
  assert.equal(pending.plexRequired, true);
  assert.equal((await browser.plex('alice')).status, 302);
  const me = (await browser.request('/api/watch/me')).body;
  assert.deepEqual(me.account.identities.map(identity => identity.provider).sort(), ['discord', 'plex']);
  assert.notEqual((await f.app.hub.plexFor({ userId: me.account.id })).principal, 'discord-shared');
  const denied = f.browser();
  assert.equal((await denied.plex('denied')).status, 302);
  assert.equal((await denied.request('/api/watch/me')).status, 401);
});

test('open-entry fallback accepts confirmed nonmembership, can be disabled or configured, and respects denials', async t => {
  const f = await fixture(t),
    browser = f.browser();
  await browser.plex('denied');
  const me = (await browser.request('/api/watch/me')).body;
  assert.ok(me.account);
  assert.equal((await f.app.hub.plexFor({ userId: me.account.id })).principal, 'discord-shared');
  f.provider.revoked.add('103');
  f.app.plexAuth.clear();
  await assert.rejects(f.app.hub.plexFor({ userId: me.account.id }), /expired|revoked/);
  const limited = f.browser();
  await limited.plex('bob');
  const user = (await limited.request('/api/watch/me')).body.account;
  const scoped = await f.app.hub.plexFor({ userId: user.id });
  assert.notEqual(scoped.principal, 'discord-shared');
  await assert.rejects(scoped.allows('999'), /HTTP 404/);

  // Fallback can be disabled or use a separate configured token without becoming personal identity
  f.provider.revoked.delete('103');
  f.app.plexAuth.clear();
  const discordUser = f.browser();
  await discordUser.discord();
  const dMe = (await discordUser.request('/api/watch/me')).body;
  f.config.plexFallback = { enabled: false, token: '' };
  f.app.plexAuth.clear();
  await assert.rejects(f.app.hub.plexFor({ userId: dMe.account.id }), /fallback is disabled/);
  f.config.plexFallback = { enabled: true, token: 'fixture-server-102' };
  const separate = await f.app.hub.plexFor({ userId: dMe.account.id });
  assert.equal(separate.token, 'fixture-server-102');
  assert.ok(!dMe.account.identities.some(identity => identity.provider === 'plex'));
});

test('owner-only recovery works with ordinary Discord disabled and rejects another verified Discord user', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: false, plex: false, requirePlex: false, password: '', publicWeb: true },
    }),
    browser = f.browser();
  assert.notEqual((await browser.request('/auth/discord')).status, 302);
  let start = await browser.request('/auth/owner'),
    url = new URL(start.headers.location, f.config.publicUrl);
  assert.equal(
    (
      await browser.request(
        '/auth/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'guest' }),
      )
    ).status,
    403,
  );
  start = await browser.request('/auth/owner');
  url = new URL(start.headers.location, f.config.publicUrl);
  assert.equal(
    (
      await browser.request(
        '/auth/callback?' + new URLSearchParams({ state: url.searchParams.get('state'), code: 'host' }),
      )
    ).status,
    302,
  );
  assert.equal((await browser.request('/api/watch/me')).body.owner, true);
});

test('Activity-only rejects browser sessions and spoofed frame query while accepting verified Activity OAuth', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, requirePlex: false, password: '', publicWeb: false },
    }),
    browser = f.browser();
  await browser.discord();
  assert.equal((await browser.request('/api/watch/me')).status, 401);
  assert.equal((await browser.request('/api/watch/me?frame_id=spoof')).status, 401);
  assert.equal((await browser.request('/api/watch/rooms')).status, 401);
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await browser.request('/api/watch/activity-login', { code: 'guest' }, headers);
  assert.equal(issued.status, 200);
  headers.Authorization = 'Bearer ' + issued.body.token;
  assert.equal((await browser.request('/api/watch/me', undefined, headers)).status, 200);
  const handoff = await browser.request('/api/watch/handoff', {}, headers);
  assert.equal(handoff.status, 200, 'account linking remains possible without public playback');
});

test('Plex-required Activity can approve browser linking without enabling browser playback', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, requirePlex: true, password: '', publicWeb: false },
    }),
    activity = f.browser(),
    browser = f.browser();
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await activity.request('/api/watch/activity-login', { code: 'guest' }, headers);
  headers.Authorization = 'Bearer ' + issued.body.token;
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 401);
  const issue = (await activity.request('/api/watch/handoff', {}, headers)).body;
  await browser.request('/auth/handoff');
  const proof = randomBytes(32).toString('hex');
  const claim = await browser.request('/api/watch/handoff/claim', { code: new URL(issue.url).hash.slice(1), proof });
  assert.equal(claim.status, 200);
  assert.equal(
    (
      await activity.request(
        '/api/watch/handoff/action',
        { id: issue.id, action: 'approve', verification: claim.body.verification },
        headers,
      )
    ).status,
    200,
  );
  const redeem = await browser.request('/api/watch/handoff/redeem', { id: issue.id, proof });
  assert.equal(redeem.status, 200);
  assert.equal(redeem.body.destination, '/auth/plex');
  assert.equal((await browser.plex('alice')).status, 302);
  assert.equal(
    (await browser.request('/api/watch/me')).status,
    401,
    'browser identity cannot play in Activity-only mode',
  );
  assert.equal(
    (await activity.request('/api/watch/me', undefined, headers)).status,
    401,
    'linking revokes the original Activity bearer',
  );
  const renewed = await activity.request('/api/watch/activity-login', { code: 'guest' }, { Origin: headers.Origin });
  headers.Authorization = 'Bearer ' + renewed.body.token;
  assert.equal(
    (await activity.request('/api/watch/me', undefined, headers)).status,
    200,
    'fresh Activity authentication uses the linked Plex identity',
  );
});

test('Activity password is additional to OAuth and survives verified renewal for the same identity', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, requirePlex: false, password: 'fixture-entry', publicWeb: false },
    }),
    browser = f.browser();
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await browser.request('/api/watch/activity-login', { code: 'guest' }, headers);
  headers.Authorization = 'Bearer ' + issued.body.token;
  assert.equal((await browser.request('/api/watch/me', undefined, headers)).status, 401);
  await browser.request('/api/watch/entry', { password: 'fixture-entry' }, headers);
  assert.equal((await browser.request('/api/watch/me', undefined, headers)).status, 200);
  const renewal = await browser.request('/api/watch/activity-login', { code: 'guest' }, headers);
  headers.Authorization = 'Bearer ' + renewal.body.token;
  assert.equal((await browser.request('/api/watch/me', undefined, headers)).status, 200);
  const other = await browser.request('/api/watch/activity-login', { code: 'guest2' }, headers);
  headers.Authorization = 'Bearer ' + other.body.token;
  assert.equal(
    (await browser.request('/api/watch/me', undefined, { ...headers, Cookie: '' })).status,
    401,
    'different Activity identity cannot inherit another password grant',
  );
});

test('single room fixes creator, assigns configured hosts and requires explicit Admin mode for management/reset', async t => {
  const f = await fixture(t, {
    singleRoom: true,
    singleRoomName: 'Shared room',
    roomAdministrators: { discord: ['100000000000000002'], plex: [], discordRoles: [] },
  });
  const browser = f.browser();
  await browser.discord('guest');
  const rooms = await browser.request('/api/watch/rooms');
  assert.equal(rooms.status, 200);
  assert.equal(rooms.body.rooms.length, 1);
  const id = rooms.body.rooms[0].id,
    owner = f.app.registry.identity('discord', f.config.ownerId).userId;
  let details = (await browser.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.name, 'Room');
  assert.equal(
    (
      await browser.post('/api/watch/rooms/' + id + '/settings', {
        revision: details.revision,
        change: { action: 'rename', name: 'Different' },
      })
    ).status,
    403,
  );
  assert.equal(details.creator.id, owner);
  assert.equal(details.role, 'host');
  assert.equal(details.capabilities.managePermissions, false);
  assert.equal((await browser.post('/api/watch/rooms', {})).status, 403);
  assert.equal(
    (
      await browser.post('/api/watch/rooms/' + id + '/settings', {
        revision: details.revision,
        change: { action: 'permissions', role: 'viewer', permissions: { seek: true } },
      })
    ).status,
    403,
  );
  assert.equal((await browser.post('/api/watch/admin-mode', { enabled: true })).status, 200);
  details = (await browser.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.capabilities.managePermissions, true);
  assert.equal(details.capabilities.transferCreator, false);
  details = (
    await browser.post('/api/watch/rooms/' + id + '/settings', {
      revision: details.revision,
      change: { action: 'permissions', role: 'viewer', permissions: { seek: true } },
    })
  ).body;
  assert.equal(details.permissions.viewer.seek, true);
  assert.equal(
    (
      await browser.post('/api/watch/rooms/' + id + '/settings', {
        revision: details.revision,
        change: { action: 'creator.transfer', userId: details.hosts[0].id },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await browser.post('/api/watch/rooms/' + id + '/settings', {
        revision: details.revision,
        change: { action: 'delete' },
      })
    ).status,
    403,
  );
  const result = await browser.post('/api/watch/rooms/' + id + '/settings', {
    revision: details.revision,
    change: { action: 'reset' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.creator.id, owner);
  assert.equal(result.body.id, id);
  assert.equal(result.body.permissions.viewer.seek, false, 'reset restores server permission defaults');
  assert.equal((await browser.request('/api/watch/rooms')).body.rooms[0].id, id);
});

test('conversion policy follows Plex, fails closed when unknown and counts jobs rather than users', async () => {
  let disabled = '1',
    reads = 0;
  const policy = new ConversionPolicy(
    { policy: 'follow_plex', plex: true, uburoom: true, formats: ['av1'], maxJobs: 1 },
    {
      json: async () => {
        reads++;
        return { Setting: [{ id: 'TranscoderCanOnlyRemuxVideo', value: disabled }] };
      },
    },
  );
  await assert.rejects(policy.video('uburoom'), /Plex disables/);
  assert.equal(reads, 1);
  policy.preference = undefined;
  disabled = '0';
  await policy.video('uburoom');
  await policy.video('plex');
  assert.equal(reads, 2);
  const release = policy.acquire();
  assert.throws(() => policy.acquire(), /conversion jobs/);
  release();
  const again = policy.acquire();
  again();
  assert.equal(policy.jobs.size, 0);
  const busy = policy.acquire();
  await assert.rejects(policy.wait({ background: true }), /reserved for viewers/);
  assert.equal(policy.waiters.length, 0, 'fallback does not queue ahead of viewers or reserve a slot while busy');
  busy();
  const background = await policy.wait({ background: true });
  assert.equal(policy.jobs.size, 1);
  background();
  policy.settings.policy = 'disabled';
  await assert.rejects(policy.video('plex'), /disabled/);
  policy.settings.policy = 'override';
  disabled = '1';
  await policy.video('uburoom');
  policy.settings.formats = [];
  await assert.rejects(policy.video('uburoom'), /not offered/);
  const missing = new ConversionPolicy(
    { ...policy.settings, policy: 'follow_plex', formats: ['av1'] },
    { json: async () => ({}) },
  );
  await assert.rejects(missing.video('uburoom'), /could not be verified/);
});

test('Plex conversions reserve/release shared global capacity and follow video-copy decisions', async () => {
  const provider = accountFixture();
  let onlyRemux = '0',
    copy = false;
  const plex = new (require('../server/plex').Plex)(
    {
      plexUrl: 'http://plex-fixture.invalid:32400',
      plexToken: 'fixture-owner',
      transcoding: { policy: 'follow_plex', plex: true, uburoom: true, formats: ['av1'], maxJobs: 1 },
    },
    async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/:/prefs')
        return new Response(
          JSON.stringify({ MediaContainer: { Setting: [{ id: 'TranscoderCanOnlyRemuxVideo', value: onlyRemux }] } }),
        );
      if (copy && url.pathname.endsWith('/decision')) {
        assert.equal(url.searchParams.get('directStream'), '1');
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  Media: [
                    { videoCodec: 'h264', Part: [{ Stream: [{ streamType: 1, codec: 'h264', decision: 'copy' }] }] },
                  ],
                },
              ],
            },
          }),
        );
      }
      return provider.fetch(input, options);
    },
  );
  try {
    const media = await plex.prepare('1', '720p4', true);
    assert.equal(plex.conversionPolicy.jobs.size, 1);
    await assert.rejects(plex.prepare('2', '720p4', true), /conversion jobs/);
    assert.equal(plex.conversionPolicy.jobs.size, 1);
    await plex.stop(media);
    assert.equal(plex.conversionPolicy.jobs.size, 0);
    plex.conversionPolicy.preference = undefined;
    onlyRemux = '1';
    await assert.rejects(plex.prepare('1', '720p4', true), /video transcoding/);
    assert.equal(plex.conversionPolicy.jobs.size, 0);
    copy = true;
    const remux = await plex.prepare('1', 'direct', true);
    await plex.stop(remux);
    assert.equal(plex.conversionPolicy.jobs.size, 0);
    plex.conversionPolicy.settings.policy = 'disabled';
    assert.equal((await plex.prepare('1', 'direct')).format, 'file');
    await assert.rejects(plex.prepare('1', '720p4', true), /disabled/);
  } finally {
    await plex.close();
  }
});

test('Plex requests opportunistic directStream when burn and fallback compatible are inactive, recording decisions', async () => {
  const provider = accountFixture();
  const decisions = [];
  const plex = new (require('../server/plex').Plex)(
    {
      plexUrl: 'http://plex-fixture.invalid:32400',
      plexToken: 'fixture-owner',
      transcoding: { policy: 'follow_plex', plex: true, uburoom: true, formats: ['av1'], maxJobs: 2 },
    },
    async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/:/prefs')
        return new Response(
          JSON.stringify({ MediaContainer: { Setting: [{ id: 'TranscoderCanOnlyRemuxVideo', value: '0' }] } }),
        );
      if (url.pathname === '/library/metadata/901') {
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: '901',
                  type: 'movie',
                  title: 'Multi audio movie',
                  duration: 60000,
                  Media: [
                    {
                      videoCodec: 'h264',
                      bitrate: 4000,
                      width: 640,
                      height: 360,
                      Part: [
                        {
                          id: 98,
                          key: '/library/parts/98/file.mkv',
                          Stream: [
                            { id: 10, streamType: 1, codec: 'h264' },
                            { id: 11, index: 1, streamType: 2, codec: 'dts', selected: true },
                            { id: 12, index: 2, streamType: 2, codec: 'ac3' },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      }
      if (url.pathname === '/library/metadata/902') {
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  ratingKey: '902',
                  type: 'movie',
                  title: 'Burn movie',
                  duration: 60000,
                  Media: [
                    {
                      videoCodec: 'h264',
                      bitrate: 4000,
                      width: 640,
                      height: 360,
                      Part: [
                        {
                          id: 99,
                          key: '/library/parts/99/file.mp4',
                          Stream: [
                            { id: 10, streamType: 1, codec: 'h264' },
                            { id: 22, index: 1, streamType: 3, codec: 'pgs', selected: true },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      }
      if (url.pathname.endsWith('/decision')) {
        const burned = url.searchParams.get('subtitles') === 'burn';
        decisions.push({
          directStream: url.searchParams.get('directStream'),
          subtitles: url.searchParams.get('subtitles'),
        });
        return new Response(
          JSON.stringify({
            MediaContainer: {
              Metadata: [
                {
                  Media: [
                    {
                      videoCodec: 'h264',
                      Part: [
                        {
                          Stream: [
                            { streamType: 1, codec: 'h264', decision: 'copy' },
                            {
                              streamType: 2,
                              id: Number(url.searchParams.get('audioStreamID') || 11),
                              codec: 'aac',
                              decision: 'transcode',
                              selected: 1,
                            },
                            ...(burned ? [{ streamType: 3, id: 22, decision: 'burn' }] : []),
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          }),
        );
      }
      if (url.pathname === '/streams/child.m3u8') return new Response('#EXTM3U');
      if (url.pathname.endsWith('/start.m3u8')) {
        return new Response('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=20000000\n/streams/child.m3u8\n');
      }
      return provider.fetch(input, options);
    },
  );
  try {
    const normal = await plex.prepare('901', 'direct', false, undefined, undefined, { subtitleId: 'off' });
    assert.equal(decisions.at(-1).directStream, '1');
    assert.equal(normal.output.videoDecision, 'copy');
    assert.equal(normal.output.audioDecision, 'transcode');
    await plex.stop(normal);

    const downscaled = await plex.prepare('1', '720p4', false, undefined, undefined, { subtitleId: 'off' });
    assert.equal(decisions.at(-1).directStream, '1');
    await plex.stop(downscaled);

    const fallback = await plex.prepare('901', 'direct', true, undefined, undefined, { subtitleId: 'off' });
    assert.equal(decisions.at(-1).directStream, '0');
    await plex.stop(fallback);

    const burned = await plex.prepare('902', 'direct', false, undefined, undefined, {
      subtitleId: '22',
      subtitleMode: 'burn',
    });
    assert.equal(decisions.at(-1).directStream, '0');
    assert.equal(decisions.at(-1).subtitles, 'burn');
    await plex.stop(burned);
  } finally {
    await plex.close();
  }
});

test('explicit software AV1 uses/probes only software and identical viewers consume one conversion job', async () => {
  const { AV1 } = require('../server/av1');
  let encodes = 0,
    releaseEncode,
    started;
  const encoding = new Promise(resolve => {
      started = resolve;
    }),
    encoderArgs = [];
  const manager = new AV1(
    {},
    { ffmpegPath: 'fixture', transcoding: { encoder: 'software' } },
    async (_binary, args) => {
      if (args.includes('-show_entries'))
        return Buffer.from(JSON.stringify({ streams: [{ index: 0, codec_type: 'video', width: 640, height: 360 }] }));
      encoderArgs.push(args);
      if (args.includes('-ss')) {
        encodes++;
        started();
        await new Promise(resolve => {
          releaseEncode = resolve;
        });
        return { video: Buffer.alloc(200), audio: Buffer.alloc(50) };
      }
      return Buffer.alloc(200);
    },
  );
  manager.conversionPolicy = new ConversionPolicy(
    { policy: 'override', plex: true, uburoom: true, formats: ['av1'], maxJobs: 1 },
    {},
  );
  const source = {
    id: '1',
    duration: 60,
    start: 'http://fixture',
    shareKey: ['room', 'version'],
    sourceKey: 'same',
    audioIndex: undefined,
  };
  const a = manager.acquire(source, 'direct'),
    b = manager.acquire({ ...source }, 'direct'),
    other = manager.acquire({ ...source, sourceKey: 'other' }, 'direct');
  try {
    const first = manager.chunk(a, 0, new AbortController().signal);
    await encoding;
    const shared = manager.chunk(b, 0, new AbortController().signal);
    assert.equal(manager.conversionPolicy.jobs.size, 1);
    await assert.rejects(manager.chunk(other, 0, new AbortController().signal), /conversion jobs/);
    releaseEncode();
    assert.equal(await first, await shared);
    assert.equal(encodes, 1);
    assert.equal(manager.conversionPolicy.jobs.size, 0);
    assert.ok(encoderArgs.every(args => args.includes('libsvtav1') && !args.includes('av1_qsv')));
  } finally {
    releaseEncode?.();
    for (const lease of [a, b, other]) manager.release(lease);
    await manager.close();
  }
});

test('Plex exemption belongs only to verified Activity requests and survives browser cache checks', async t => {
  const f = await fixture(t, {
    accessPolicy: {
      discord: true,
      plex: true,
      requirePlex: true,
      requirePlexInActivity: false,
      password: '',
      publicWeb: true,
    },
  });
  const browser = f.browser(),
    activity = f.browser();
  await browser.discord('guest');
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await activity.request('/api/watch/activity-login', { code: 'guest' }, headers);
  assert.equal(issued.status, 200);
  headers.Authorization = 'Bearer ' + issued.body.token;
  assert.equal((await activity.request('/api/watch/admission', undefined, headers)).body.plexRequired, false);
  const me = await activity.request('/api/watch/me', undefined, headers);
  assert.equal(me.status, 200);
  assert.equal((await browser.request('/api/watch/admission')).body.plexRequired, true);
  assert.equal((await browser.request('/api/watch/me?frame_id=spoof&activity=true')).status, 401);
  assert.equal(
    (await activity.request('/api/watch/rooms', {}, headers)).status,
    201,
    'Activity room lifecycle preserves its verified context',
  );
  assert.equal((await activity.request('/api/watch/rooms', undefined, headers)).body.rooms.length, 1);
  assert.equal(
    (await browser.request('/api/watch/rooms')).status,
    401,
    'Activity admission cannot authorize a browser for the same account',
  );
  assert.equal(f.app.hub.access.canWatch(me.body.account.id), false);
  assert.equal(f.app.hub.access.canWatch(me.body.account.id, { activity: true }), true);
  const handoff = (await activity.request('/api/watch/handoff', {}, headers)).body;
  await browser.request('/auth/handoff');
  const proof = randomBytes(32).toString('hex');
  const claim = await browser.request('/api/watch/handoff/claim', { code: new URL(handoff.url).hash.slice(1), proof });
  assert.equal(claim.status, 200);
  assert.equal(
    (
      await activity.request(
        '/api/watch/handoff/action',
        { id: handoff.id, action: 'approve', verification: claim.body.verification },
        headers,
      )
    ).status,
    200,
  );
  assert.equal((await browser.request('/api/watch/handoff/redeem', { id: handoff.id, proof })).status, 200);
  assert.equal(
    (await browser.request('/api/watch/me')).status,
    401,
    'an approved browser handoff still requires personal Plex access',
  );

  // Activity Plex exemption keeps the extra password and default Plex requirement
  f.config.accessPolicy.password = 'fixture-password';
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 401);
  assert.equal((await activity.request('/api/watch/entry', { password: 'fixture-password' }, headers)).status, 200);
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 200);
  f.config.accessPolicy.password = '';
  f.config.accessPolicy.requirePlexInActivity = true;
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 401);
  delete f.config.accessPolicy.requirePlexInActivity;
  assert.equal(
    (await activity.request('/api/watch/me', undefined, headers)).status,
    401,
    'omitted setting keeps required Plex access in Activity',
  );
  f.config.accessPolicy.requirePlexInActivity = false;

  // Sponsors confirmed nonmembers but never revoked credentials
  f.app.registry.link(me.body.account.id, 'plex', '103', 'Denied');
  f.app.registry.credential('103', { token: 'fixture-server-103', authType: 'traditional' });
  assert.equal((await f.app.hub.plexFor({ userId: me.body.account.id, activity: true })).principal, 'discord-shared');
  await assert.rejects(f.app.hub.plexFor({ userId: me.body.account.id }), /access|server/i);
  f.provider.revoked.add('103');
  f.app.plexAuth.clear();
  await assert.rejects(f.app.hub.plexFor({ userId: me.body.account.id, activity: true }), /expired|revoked/);
  f.provider.revoked.delete('103');
  f.app.plexAuth.clear();

  f.members.clear();
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301000);
  assert.equal(
    (await activity.request('/api/watch/me', undefined, headers)).status,
    401,
    'Activity still needs current Discord membership at its recheck',
  );
});

test('Plex-only single room derives its fixed leader from token or explicit ID, and preserves creator rights', async t => {
  const explicit = await fixture(t, { singleRoom: true, singleRoomLeaderPlexId: '102' }),
    viewer = explicit.browser();
  await viewer.discord('guest');
  const explicitRooms = await viewer.request('/api/watch/rooms');
  assert.equal(explicitRooms.status, 200);
  const record = explicit.app.watch.roomState.store.get(explicitRooms.body.rooms[0].id);
  assert.equal(record.creatorId, explicit.app.registry.identity('plex', '102').userId);

  const f = await fixture(t, {
    singleRoom: true,
    accessPolicy: { discord: false, plex: true, requirePlex: false, password: '', publicWeb: true },
    ownerId: '',
    roomAdministrators: { discord: [], plex: ['102'], discordRoles: [] },
  });
  let lookups = 0,
    fail = true;
  const request = f.app.plexAuth.request.bind(f.app.plexAuth);
  f.app.plexAuth.request = async (resource, options) => {
    if (resource === '/user' && options?.token === f.config.plexToken) {
      if (fail) throw new Error('fixture rejection');
      lookups++;
      return { id: 101, username: 'token-account' };
    }
    return request(resource, options);
  };
  const leader = f.browser();
  await leader.plex('alice');
  assert.notEqual((await leader.request('/api/watch/rooms')).status, 200, 'failed discovery never assigns visitor');
  assert.equal(f.app.registry.meta('singleRoomId'), undefined);
  fail = false;
  const rooms = await leader.request('/api/watch/rooms');
  assert.equal(rooms.status, 200);
  const id = rooms.body.rooms[0].id,
    owner = (await leader.request('/api/watch/me')).body.account.id;
  let details = (await leader.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.creator.id, owner);
  assert.equal(details.role, 'creator');
  assert.equal(details.capabilities.managePermissions, true);
  const admin = f.browser();
  await admin.plex('bob');
  await admin.request('/api/watch/rooms');
  assert.equal(lookups, 1, 'discovery is shared and cached until restart');
  details = (await admin.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.role, 'host');
  assert.equal(details.capabilities.managePermissions, false);
  assert.equal((await admin.post('/api/watch/admin-mode', { enabled: true })).status, 200);
  details = (await admin.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.capabilities.managePermissions, true);
  assert.equal(
    (
      await admin.post('/api/watch/rooms/' + id + '/settings', {
        revision: details.revision,
        change: { action: 'reset' },
      })
    ).status,
    200,
  );
  await admin.post('/api/watch/admin-mode', { enabled: false });
  details = (await admin.request('/api/watch/rooms/' + id + '/settings')).body;
  assert.equal(details.role, 'host', 'reset restores the configured Plex admin as a host');
  assert.equal(details.capabilities.managePermissions, false);
});

test('provider removal rejects leaving only a disabled login provider; owner exception preserves Discord', async t => {
  const fPlexOff = await fixture(t, {
    accessPolicy: { discord: true, plex: false, requirePlex: false, password: '', publicWeb: true },
  });
  const b1 = fPlexOff.browser();
  await b1.discord('guest');
  const u1 = (await b1.request('/api/account')).body.account;
  fPlexOff.app.registry.link(u1.id, 'plex', '101', 'Alice');
  fPlexOff.app.registry.credential('101', { token: 'fixture-server-101', authType: 'traditional' });
  await b1.discord('guest');
  assert.equal(fPlexOff.app.registry.identities(u1.id).length, 2);
  const resPlexOff = await b1.post('/api/account/discord/remove', { subject: fPlexOff.provider.subjects.guest });
  assert.equal(resPlexOff.status, 400, 'cannot remove Discord when Plex is disabled');
  assert.equal(fPlexOff.app.registry.identities(u1.id).length, 2, 'identities preserved');

  const fDiscordOff = await fixture(t, {
    accessPolicy: { discord: false, plex: true, requirePlex: false, password: '', publicWeb: true },
  });
  const bGuest = fDiscordOff.browser();
  await bGuest.plex('alice');
  const uGuest = (await bGuest.request('/api/account')).body.account;
  fDiscordOff.app.registry.link(uGuest.id, 'discord', fDiscordOff.provider.subjects.guest, 'Guest');
  await bGuest.plex('alice');
  fDiscordOff.config.serverOperator = { discordId: fDiscordOff.provider.subjects.guest };
  assert.equal(fDiscordOff.app.registry.identities(uGuest.id).length, 2);
  const resGuest = await bGuest.post('/api/account/plex/remove', { subject: '101' });
  assert.equal(resGuest.status, 400, 'regular user cannot remove Plex when Discord is disabled');
  assert.equal(fDiscordOff.app.registry.identities(uGuest.id).length, 2, 'identities preserved');

  const bOwner = fDiscordOff.browser();
  await bOwner.plex('bob');
  const uOwner = (await bOwner.request('/api/account')).body.account;
  fDiscordOff.app.registry.link(uOwner.id, 'discord', fDiscordOff.config.ownerId, 'Host');
  await bOwner.plex('bob');
  assert.equal(fDiscordOff.app.registry.identities(uOwner.id).length, 2);
  const resOwner = await bOwner.post('/api/account/plex/remove', { subject: '102' });
  assert.equal(resOwner.status, 200, 'owner can remove Plex when Discord auth is available via /auth/owner');
  assert.equal(fDiscordOff.app.registry.identities(uOwner.id).length, 1);
  assert.equal(fDiscordOff.app.registry.identities(uOwner.id)[0].provider, 'discord');
});
