'use strict';
const { validateSources } = require('../server/sources');
const test = require('node:test'),
  assert = require('node:assert/strict'),
  fs = require('node:fs'),
  path = require('node:path'),
  https = require('node:https');
const { randomBytes, randomUUID } = require('node:crypto');
const { createApp } = require('../server/app');
const { accountFixture } = require('../scripts/account-fixture');
const { ConversionPolicy } = require('../server/transcoding-policy');

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
    sources: validateSources([
      { id: 'plex', type: 'plex', url: 'http://plex-fixture.invalid:32400', token: 'fixture-owner' },
    ]),
    accessPolicy: { discord: true, plex: true, password: '', publicWeb: true },
    ...changes,
  };
  const app = createApp(config, { plexFetch: provider.fetch, oauthFetch: provider.discordFetch, plexDemo: provider });
  const members = new Set(Object.values(provider.subjects));
  app.access.connect({
    refresh: async id => members.has(id),
    isMember: id => members.has(id),
    voiceChannel: () => 'voice',
    validVoiceChannel: id => id === 'voice',
    options: () => ({ available: true }),
  });
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
      accessPolicy: { discord: true, plex: true, password: 'fixture-password', publicWeb: true },
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
    accessPolicy: { discord: false, plex: false, password: '', publicWeb: true },
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
  assert.equal((await f.app.hub.mediaFor({ userId: first.account.id })).principal, 'discord-shared');
  assert.equal((await a.post('/api/watch/rooms', {})).status, 201, 'no Discord channels needed for browser rooms');
});

test('every admitted person watches every library through the source credential; refused people get nothing', async t => {
  const f = await fixture(t);
  const source = principal => assert.equal(principal, 'discord-shared', 'the source credential, not a personal one');
  // A Discord member with no Plex link.
  const member = f.browser();
  await member.discord('guest');
  const memberId = (await member.request('/api/watch/me')).body.account.id;
  // A Plex member whose own account is denied item 999.
  const limited = f.browser();
  await limited.plex('bob');
  const limitedId = (await limited.request('/api/watch/me')).body.account.id;
  for (const userId of [memberId, limitedId]) {
    const scope = await f.app.hub.mediaFor({ userId });
    source(scope.principal);
    assert.ok(await scope.allows('999'), "a viewer's own Plex restrictions play no part");
  }
  // Someone the server refuses gets no library from any source.
  const refused = f.browser();
  assert.equal((await refused.plex('denied')).status, 302);
  assert.equal((await refused.request('/api/watch/me')).status, 401);
  assert.equal((await refused.request('/api/watch/library')).status, 401);
  assert.equal((await refused.request('/api/watch/rooms')).status, 401);
});

test('standalone Plex requires PMS membership; a Plex denial takes no media from someone Discord admits', async t => {
  const f = await fixture(t),
    standalone = await fixture(t),
    browser = standalone.browser();
  assert.equal((await browser.plex('denied')).headers.location, '/auth/error', 'a nonmember Plex sign-in is refused');
  assert.equal((await browser.request('/api/watch/me')).status, 401);
  const admission = (await browser.request('/api/watch/admission')).body;
  assert.equal(admission.admitted, false);
  assert.equal(admission.plexRequired, undefined, 'there is no Plex requirement any more');
  const member = f.browser();
  await member.discord('guest');
  await member.plex('alice', true);
  const me = (await member.request('/api/watch/me')).body;
  assert.deepEqual(me.account.identities.map(identity => identity.provider).sort(), ['discord', 'plex']);
  assert.equal((await f.app.hub.mediaFor({ userId: me.account.id })).principal, 'discord-shared');
  f.provider.revoked.add('101');
  f.app.plexAuth.clear();
  assert.equal((await member.request('/api/watch/me')).status, 200, 'guild admission is independent of Plex');
  assert.equal((await f.app.hub.mediaFor({ userId: me.account.id })).principal, 'discord-shared');
});

test('owner-only recovery works with ordinary Discord disabled and rejects another verified Discord user', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: false, plex: false, password: '', publicWeb: true },
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
      accessPolicy: { discord: true, plex: true, password: '', publicWeb: false },
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

test('Activity can approve browser Plex linking without enabling browser playback', async t => {
  const f = await fixture(t, {
      accessPolicy: { discord: true, plex: true, password: '', publicWeb: false },
    }),
    activity = f.browser(),
    browser = f.browser();
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await activity.request('/api/watch/activity-login', { code: 'guest' }, headers);
  headers.Authorization = 'Bearer ' + issued.body.token;
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 200);
  const issue = (await activity.request('/api/watch/handoff', { connectPlex: true }, headers)).body;
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
      accessPolicy: { discord: true, plex: true, password: 'fixture-entry', publicWeb: false },
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
  const { events, roomState } = f.app.watch;
  const { inviteCode } = roomState.store.get(id);
  assert.ok(inviteCode, 'the room has an invite code before reset');
  const now = Date.now();
  const watchNight = {
    id: randomUUID(),
    roomId: id,
    creatorId: owner,
    title: 'Scheduled watch night',
    description: '',
    start: new Date(now + 60 * 60 * 1000).toISOString(),
    end: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    timeZone: 'UTC',
    state: 'scheduled',
    createdAt: now,
    updatedAt: now,
    discord: null,
  };
  await events.save(watchNight);
  const result = await browser.post('/api/watch/rooms/' + id + '/settings', {
    revision: details.revision,
    change: { action: 'reset' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.creator.id, owner);
  assert.equal(result.body.id, id);
  assert.equal(result.body.permissions.viewer.seek, false, 'reset restores server permission defaults');
  assert.equal(roomState.store.get(id).inviteCode, inviteCode, 'reset preserves the room invite code');
  assert.deepEqual(events.get(watchNight.id), watchNight, 'reset preserves the scheduled watch night');
  assert.equal((await browser.request('/api/watch/rooms')).body.rooms[0].id, id);
});

test('conversion policy follows Plex, fails closed when unknown and counts jobs rather than users', async () => {
  let disabled = '1',
    reads = 0;
  const { Plex } = require('../server/sources/plex/plex');
  const server = settings =>
    new Plex({ url: 'http://plex-fixture.invalid:32400', token: 'fixture-owner' }, async () => {
      reads++;
      return new Response(JSON.stringify({ MediaContainer: { Setting: settings() } }));
    });
  const plex = server(() => [{ id: 'TranscoderCanOnlyRemuxVideo', value: disabled }]);
  const policy = new ConversionPolicy({
    policy: 'follow_provider',
    provider: true,
    uburoom: true,
    formats: ['av1'],
    maxJobs: 1,
  });
  await assert.rejects(policy.video('uburoom', 'av1', plex), /media server disables/);
  assert.equal(reads, 1);
  plex.shared.conversionPreference = undefined;
  disabled = '0';
  await policy.video('uburoom', 'av1', plex);
  await policy.video('provider', undefined, plex.scope('viewer-token', 'viewer'));
  assert.equal(reads, 2, 'a viewer scope follows the setting read with the server token');
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
  await assert.rejects(policy.video('provider'), /disabled/);
  policy.settings.policy = 'override';
  disabled = '1';
  await policy.video('uburoom', 'av1', plex);
  policy.settings.formats = [];
  await assert.rejects(policy.video('uburoom'), /not offered/);
  const missing = new ConversionPolicy({ ...policy.settings, policy: 'follow_provider', formats: ['av1'] });
  await assert.rejects(
    missing.video(
      'uburoom',
      'av1',
      server(() => undefined),
    ),
    /could not be verified/,
  );
});

test('Plex conversions reserve/release shared global capacity and follow video-copy decisions', async () => {
  const provider = accountFixture();
  let onlyRemux = '0',
    copy = false;
  const plex = new (require('../server/sources/plex/plex').Plex)(
    {
      url: 'http://plex-fixture.invalid:32400',
      token: 'fixture-owner',
      transcoding: { policy: 'follow_provider', provider: true, uburoom: true, formats: ['av1'], maxJobs: 1 },
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
  // A full pool turns a viewer away after its wait; a short wait keeps the test quick.
  plex.pipeline.conversionPolicy.waitMs = 100;
  try {
    const media = await plex.prepare('1', '720p4', true);
    assert.equal(plex.pipeline.conversionPolicy.jobs.size, 1);
    await assert.rejects(plex.prepare('2', '720p4', true), /conversion jobs/);
    assert.equal(plex.pipeline.conversionPolicy.jobs.size, 1);
    await plex.stop(media);
    assert.equal(plex.pipeline.conversionPolicy.jobs.size, 0);
    plex.shared.conversionPreference = undefined;
    onlyRemux = '1';
    await assert.rejects(plex.prepare('1', '720p4', true), /video transcoding/);
    assert.equal(plex.pipeline.conversionPolicy.jobs.size, 0);
    copy = true;
    const remux = await plex.prepare('1', 'direct', true);
    await plex.stop(remux);
    assert.equal(plex.pipeline.conversionPolicy.jobs.size, 0);
    plex.pipeline.conversionPolicy.settings.policy = 'disabled';
    assert.equal((await plex.prepare('1', 'direct')).format, 'file');
    await assert.rejects(plex.prepare('1', '720p4', true), /disabled/);
  } finally {
    await plex.close();
  }
});

test('Plex requests opportunistic directStream when burn and fallback compatible are inactive, recording decisions', async () => {
  const provider = accountFixture();
  const decisions = [];
  const plex = new (require('../server/sources/plex/plex').Plex)(
    {
      url: 'http://plex-fixture.invalid:32400',
      token: 'fixture-owner',
      transcoding: { policy: 'follow_provider', provider: true, uburoom: true, formats: ['av1'], maxJobs: 2 },
    },
    async (input, options) => {
      const url = new URL(input);
      if (url.pathname === '/:/prefs')
        return new Response(
          JSON.stringify({ MediaContainer: { Setting: [{ id: 'TranscoderCanOnlyRemuxVideo', value: '0' }] } }),
        );
      if (url.pathname === '/library/metadata/901' || url.pathname === '/library/metadata/903') {
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
        // Plex re-encodes 903's picture even when asked to copy it, as a tight bitrate cap makes it do.
        const reencoded = url.searchParams.get('path') === '/library/metadata/903';
        decisions.push({
          directStream: url.searchParams.get('directStream'),
          subtitles: url.searchParams.get('subtitles'),
          maxVideoBitrate: url.searchParams.get('maxVideoBitrate'),
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
                            { streamType: 1, codec: 'h264', decision: reencoded ? 'transcode' : 'copy' },
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
    assert.equal(
      decisions.at(-1).maxVideoBitrate,
      '200000',
      'a copied original is never held to its own bitrate, which Plex shares with the audio',
    );
    await plex.stop(normal);

    await assert.rejects(
      plex.prepare('903', 'direct', false, undefined, undefined, { subtitleId: 'off' }),
      /re-encode the original video/,
      'Original never accepts a full video transcode in place of a copy',
    );

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
  const { fakeRuns, fakeTools } = require('./helpers/fake-ffmpeg');
  let releaseEncode, started;
  const encoding = new Promise(resolve => {
      started = resolve;
    }),
    encoderArgs = [];
  const runs = fakeRuns({
    chunk: (args, n) => {
      if (n) return;
      started();
      return new Promise(resolve => {
        releaseEncode = resolve;
      });
    },
  });
  const tools = fakeTools({ streams: [{ index: 0, codec_type: 'video', width: 640, height: 360 }] });
  const manager = new AV1(
    { ffmpegPath: 'fixture', transcoding: { encoder: 'software' } },
    async (binary, args, signal) => {
      if (!args.includes('-show_entries') && !args.includes('libopus')) encoderArgs.push(args);
      return tools(binary, args, signal);
    },
    undefined,
    async (...args) => {
      encoderArgs.push(args[1]);
      return runs.segments(...args);
    },
  );
  runs.manager = manager;
  manager.conversionPolicy = new ConversionPolicy({
    policy: 'override',
    provider: true,
    uburoom: true,
    formats: ['av1'],
    maxJobs: 1,
  });
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
  // The third viewer is turned away after its wait for the one job; a short wait keeps the test quick.
  manager.conversionPolicy.waitMs = 100;
  try {
    const first = manager.chunk(a, 0, new AbortController().signal);
    await encoding;
    const shared = manager.chunk(b, 0, new AbortController().signal);
    assert.equal(manager.conversionPolicy.jobs.size, 1);
    await assert.rejects(manager.chunk(other, 0, new AbortController().signal), /conversion jobs/);
    releaseEncode();
    assert.equal(await first, await shared);
    assert.equal(runs.started.length, 1);
    assert.ok(encoderArgs.every(args => args.includes('libsvtav1') && !args.includes('av1_qsv')));
    for (const lease of [a, b]) manager.release(lease);
    while (manager.conversionPolicy.jobs.size) await new Promise(resolve => setTimeout(resolve, 5));
  } finally {
    releaseEncode?.();
    for (const lease of [a, b, other]) manager.release(lease);
    await manager.close();
  }
});

test('Activity viewers keep the entry password and Discord recheck, and watch through the source credential', async t => {
  const f = await fixture(t);
  const activity = f.browser();
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await activity.request('/api/watch/activity-login', { code: 'guest' }, headers);
  assert.equal(issued.status, 200);
  headers.Authorization = 'Bearer ' + issued.body.token;
  const me = await activity.request('/api/watch/me', undefined, headers);
  assert.equal(me.status, 200);
  assert.equal(
    (await activity.request('/api/watch/rooms', {}, headers)).status,
    201,
    'Activity room lifecycle preserves its verified context',
  );
  assert.equal((await activity.request('/api/watch/rooms', undefined, headers)).body.rooms.length, 1);

  f.config.accessPolicy.password = 'fixture-password';
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 401);
  assert.equal((await activity.request('/api/watch/entry', { password: 'fixture-password' }, headers)).status, 200);
  assert.equal((await activity.request('/api/watch/me', undefined, headers)).status, 200);
  f.config.accessPolicy.password = '';

  // A linked Plex account that cannot reach the server, or is revoked, changes no media access.
  f.app.registry.link(me.body.account.id, 'plex', '103', 'Denied');
  f.app.registry.credential('103', { token: 'fixture-server-103', authType: 'traditional' });
  assert.equal((await f.app.hub.mediaFor({ userId: me.body.account.id, activity: true })).principal, 'discord-shared');
  f.provider.revoked.add('103');
  f.app.plexAuth.clear();
  assert.equal((await f.app.hub.mediaFor({ userId: me.body.account.id, activity: true })).principal, 'discord-shared');

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
    accessPolicy: { discord: false, plex: true, password: '', publicWeb: true },
    ownerId: '',
    roomAdministrators: { discord: [], plex: ['102'], discordRoles: [] },
  });
  let lookups = 0,
    fail = true;
  const request = f.app.plexAuth.request.bind(f.app.plexAuth);
  f.app.plexAuth.request = async (resource, options) => {
    if (resource === '/user' && options?.token === f.config.sources[0].token) {
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
    accessPolicy: { discord: true, plex: false, password: '', publicWeb: true },
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
    accessPolicy: { discord: false, plex: true, password: '', publicWeb: true },
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

// Room passes must not turn a nonmember's verified identity into server-wide standing.
test('Plex nonmembers can verify identity for a signed-in room invite without standalone admission', async t => {
  const f = await fixture(t, {
    guests: { enabled: true, requireSignIn: true, maxPerRoom: 10, sessionHours: 1 },
  });
  const host = f.browser();
  await host.discord();
  const id = (await host.post('/api/watch/rooms', {})).body.id;
  const store = f.app.watch.roomState.store;
  let record = store.get(id);
  record = await store.edit(id, record.creatorId, record.revision, { action: 'guests.allow', enabled: true });
  const visitor = f.browser();
  assert.equal((await visitor.plex('denied')).status, 302);
  assert.equal((await visitor.request('/api/watch/me')).status, 401);
  const joined = await visitor.request('/api/watch/invite', { action: 'join', code: record.inviteCode });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.guest, true);
  const me = await visitor.request('/api/watch/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.guestRoomId, id);
  assert.equal(
    (await f.app.hub.mediaFor({ userId: me.body.account.id, guestRoomId: id })).principal,
    'discord-shared',
    'a room guest watches through the source credential',
  );
});

test('room guests cannot authorize native clients, escape to former rooms or browse after close', async t => {
  const f = await fixture(t, {
    guests: { enabled: true, requireSignIn: false, maxPerRoom: 10, sessionHours: 1 },
  });
  const host = f.browser(),
    former = f.browser();
  await host.discord();
  const hostId = (await host.request('/api/watch/me')).body.account.id;
  const shared = await f.app.hub.mediaFor({ userId: hostId });
  t.mock.method(shared, 'artwork', async () => ({ type: 'image/png', bytes: Buffer.from('fixture-art') }));
  await former.discord('guest');
  const formerId = (await former.request('/api/watch/me')).body.account.id;
  const otherId = (await former.post('/api/watch/rooms', { name: 'Former room' })).body.id;
  const id = (await host.post('/api/watch/rooms', { name: 'Guest room' })).body.id;
  const store = f.app.watch.roomState.store;
  let record = store.get(id);
  record = await store.edit(id, record.creatorId, record.revision, { action: 'guests.allow', enabled: true });
  // Former server members can hold room passes after losing guild membership.
  f.members.delete(f.provider.subjects.guest);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301000);
  const anonymous = f.browser();
  for (const visitor of [former, anonymous]) {
    const joined = await visitor.request('/api/watch/invite', { action: 'join', code: record.inviteCode });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.guest, true);
    assert.equal((await visitor.request('/api/watch/me')).status, 200);
    for (const action of ['claim', 'approve']) {
      const denied = await visitor.request('/api/watch/handoff/native/' + action, {});
      assert.equal(denied.status, 403);
      assert.match(denied.body.error, /Guests cannot authorize/);
    }
    assert.equal((await visitor.request('/api/watch/library')).status, 200, 'open-room library remains available');
    assert.equal((await visitor.request('/api/watch/library?room=' + otherId)).status, 403);
    assert.equal((await visitor.request('/api/watch/library/art?item=1')).status, 200, 'art defaults to guest room');
  }
  for (const part of ['settings', 'queue'])
    assert.equal((await former.request('/api/watch/rooms/' + otherId + '/' + part)).status, 403);
  for (const part of ['reopen', 'settings', 'queue', 'close'])
    assert.equal((await former.post('/api/watch/rooms/' + otherId + '/' + part, {})).status, 403);
  assert.equal((await former.post('/api/watch/rooms/' + id + '/settings', {})).status, 403);
  assert.equal((await former.request('/api/watch/rooms/' + id + '?viewer=' + randomUUID())).status, 200);
  const suggestion = await former.post('/api/watch/rooms/' + id + '/queue', {
    action: 'suggest',
    item: { id: '1' },
  });
  assert.equal(suggestion.status, 200, JSON.stringify(suggestion.body));
  assert.equal(store.get(otherId).creatorId, formerId);
  record = store.get(id);
  await store.edit(id, record.creatorId, record.revision, { action: 'keepEmpty', enabled: true });
  await f.app.watch.remove(id);
  for (const visitor of [former, anonymous]) {
    assert.equal((await visitor.request('/api/watch/library')).status, 403);
    assert.equal(
      (await visitor.post('/api/watch/rooms/' + id + '/queue', { action: 'add', item: { id: '1' } })).status,
      403,
    );
  }
});

test('same-account Activity handoff replaces a browser room-pass cookie with full admission', async t => {
  const f = await fixture(t, { guests: { enabled: true, requireSignIn: true, maxPerRoom: 10, sessionHours: 1 } });
  const host = f.browser(),
    visitor = f.browser(),
    activity = f.browser();
  await host.discord();
  await visitor.discord('guest');
  const id = (await host.post('/api/watch/rooms', {})).body.id;
  const store = f.app.watch.roomState.store;
  let record = store.get(id);
  record = await store.edit(id, record.creatorId, record.revision, { action: 'guests.allow', enabled: true });
  f.members.delete(f.provider.subjects.guest);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301000);
  assert.equal(
    (await visitor.request('/api/watch/invite', { action: 'join', code: record.inviteCode })).body.guest,
    true,
  );
  assert.equal((await visitor.request('/api/watch/me')).body.guestRoomId, id);
  f.members.add(f.provider.subjects.guest);
  const headers = { Origin: 'https://' + f.config.clientId + '.discordsays.com' };
  const issued = await activity.request('/api/watch/activity-login', { code: 'guest' }, headers);
  headers.Authorization = 'Bearer ' + issued.body.token;
  const handoff = (await activity.request('/api/watch/handoff', {}, headers)).body;
  await visitor.request('/auth/handoff');
  const proof = randomBytes(32).toString('hex');
  const claim = await visitor.request('/api/watch/handoff/claim', { code: new URL(handoff.url).hash.slice(1), proof });
  assert.equal(claim.status, 200);
  assert.equal(claim.body.switchRequired, false);
  assert.equal(
    (
      await activity.request(
        '/api/watch/handoff/action',
        {
          id: handoff.id,
          action: 'approve',
          verification: claim.body.verification,
        },
        headers,
      )
    ).status,
    200,
  );
  const redeemed = await visitor.request('/api/watch/handoff/redeem', { id: handoff.id, proof });
  assert.equal(redeemed.status, 200);
  assert.ok(redeemed.headers['set-cookie'].some(value => value.startsWith('uburoom=')));
  const me = await visitor.request('/api/watch/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.guestRoomId, undefined);
});

test('SSR and canonical redirects reveal private room metadata only to authorized viewers', async t => {
  const f = await fixture(t, { guests: { enabled: true, requireSignIn: false, maxPerRoom: 10, sessionHours: 1 } });
  const host = f.browser(),
    member = f.browser(),
    anonymous = f.browser(),
    guest = f.browser();
  await host.discord();
  await member.discord('guest');
  const id = (await host.post('/api/watch/rooms', { name: 'Private screening', visibility: 'private' })).body.id;
  const store = f.app.watch.roomState.store,
    room = f.app.watch.rooms.get(id);
  const slug = room.slug,
    oldSlug = 'private-earlier-address';
  room.previousSlugs = new Set([oldSlug]);
  const guestRoomId = (await host.post('/api/watch/rooms', { name: 'Guest screening' })).body.id;
  let record = store.get(guestRoomId);
  record = await store.edit(guestRoomId, record.creatorId, record.revision, { action: 'guests.allow', enabled: true });
  assert.equal(
    (await guest.request('/api/watch/invite', { action: 'join', code: record.inviteCode })).body.guest,
    true,
  );
  room.media = {
    id: '1',
    title: 'Private film title',
    subtitle: 'Private film subtitle',
    duration: 60,
    resources: new Map(),
  };
  const bootstrap = html =>
    JSON.parse(/<script id="watch-bootstrap" type="application\/json">(.*?)<\/script>/.exec(html)[1]);
  try {
    for (const browser of [anonymous, member, guest]) {
      for (const route of ['/room/' + slug, '/?room=' + id, '/room/' + oldSlug]) {
        const page = await browser.request(route);
        assert.equal(page.status, 200);
        assert.equal(bootstrap(page.body).targetRoom, undefined);
        for (const secret of [slug, 'Private screening', 'Private film title', 'Private film subtitle'])
          assert.equal(page.body.includes(secret), false, route + ' leaked ' + secret);
      }
      const legacy = await browser.request('/watch?room=' + id);
      assert.equal(legacy.status, 302);
      assert.equal(legacy.headers.location, '/?room=' + id);
    }
    const memberId = (await member.request('/api/watch/me')).body.account.id;
    const invited = await store.invite(id, memberId);
    f.app.watch.roomState.apply(room, invited);
    for (const browser of [host, member]) {
      for (const route of ['/room/' + slug, '/?room=' + id]) {
        const target = bootstrap((await browser.request(route)).body).targetRoom;
        assert.equal(target.id, id);
        assert.equal(target.slug, slug);
        assert.equal(target.media.title, 'Private film title');
      }
      assert.equal((await browser.request('/watch?room=' + id)).headers.location, '/room/' + slug);
      assert.equal((await browser.request('/room/' + oldSlug)).headers.location, '/room/' + slug);
    }
  } finally {
    room.media = undefined;
  }
});
