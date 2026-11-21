'use strict';
const { accessPolicy } = require('./helpers/access');
// Admitted means everything: every admitted person browses every library of every
// media source through the source's own credential, and a refused person gets none.
const test = require('node:test');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fixture } = require('./helpers/account-app');
const { validateSources } = require('../server/sources');

const tls = { skip: !fs.existsSync(path.join(__dirname, '../certs/server-cert.pem')) };
const JELLYFIN_SERVER = 'f'.repeat(32),
  JELLYFIN_USER = 'a'.repeat(32),
  JELLYFIN_LIBRARY = 'c'.repeat(32);

/** A Jellyfin server that knows one user and one film library, and accepts only its API key. */
async function jellyfinFetch(input, options = {}) {
  const url = new URL(input);
  if (!/Token="fixture-jellyfin-key"/.test(new Headers(options.headers).get('authorization') || ''))
    return new Response('{}', { status: 401 });
  if (url.pathname === '/System/Info/Public')
    return Response.json({ Id: JELLYFIN_SERVER, ServerName: 'Fixture Jellyfin' });
  if (url.pathname === '/Users') return Response.json([{ Id: JELLYFIN_USER, Name: 'Viewer' }]);
  if (url.pathname === '/UserViews')
    return Response.json({ Items: [{ Id: JELLYFIN_LIBRARY, Name: 'Jellyfin Films', CollectionType: 'movies' }] });
  return Response.json({ Items: [], TotalRecordCount: 0 });
}

async function sources(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-admitted-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'Fixture Film (2020).mp4'), '');
  const f = await fixture(
    t,
    undefined,
    {
      accessPolicy: accessPolicy({ sourceMembers: ['plex'] }),
      guests: {
        enabled: true,
        defaultAllow: true,
        issuers: 'members',
        requireSignIn: false,
        maxPerRoom: 10,
        sessionHours: 1,
      },
      sources: validateSources(
        [
          { id: 'plex', type: 'plex', url: 'http://plex-fixture.invalid:32400', token: 'fixture-owner' },
          {
            id: 'jellyfin',
            type: 'jellyfin',
            url: 'http://jellyfin.invalid:8096',
            api_key: 'fixture-jellyfin-key',
            user: 'Viewer',
          },
          { id: 'films', type: 'folders', libraries: [{ id: 'films', name: 'Folder Films', paths: [dir] }] },
        ],
        { base: dir, platform: process.platform, dataDirectory: path.join(dir, 'data') },
      ),
    },
    { jellyfinFetch },
  );
  const servers = {};
  for (const provider of f.app.watch.providers.list) servers[provider.kind] = await provider.identity();
  return { ...f, servers };
}

const titles = response => JSON.stringify(response.body);

test(
  'a Discord member, a Plex member and a room guest all browse Plex, Jellyfin and folder libraries',
  tls,
  async t => {
    const f = await sources(t);
    assert.deepEqual(Object.keys(f.servers).sort(), ['jellyfin', 'local', 'plex']);
    const member = f.browser(),
      plexMember = f.browser(),
      guest = f.browser(),
      refused = f.browser();
    // A Discord member with no Plex link.
    await member.discord('guest');
    // A Plex member with no Discord link, whose own Plex account is denied some items.
    await plexMember.plex('bob');
    // A room guest who is neither.
    const created = await plexMember.post('/api/watch/rooms', { name: 'Guest room' });
    assert.equal(created.status, 201);
    const id = created.body.id;
    const other = await plexMember.post('/api/watch/rooms', { name: 'Other room' });
    assert.equal(other.status, 201);
    const store = f.app.watch.roomState.store;
    let record = store.get(id);
    record = await store.edit(id, record.creatorId, record.revision, { action: 'guests.allow', enabled: true });
    f.members.delete(f.provider.subjects.guest2);
    const joined = await guest.request('/api/watch/invite', {
      action: 'join',
      code: record.inviteCode,
      name: 'Visitor',
    });
    assert.equal(joined.status, 200);
    assert.equal(joined.body.guest, true);
    assert.equal((await guest.request('/api/watch/me')).body.guestRoomId, id);
    const rooms = await guest.request('/api/watch/rooms');
    assert.equal(rooms.status, 200);
    assert.equal(
      rooms.body.rooms.some(room => room.id === other.body.id),
      false,
    );
    const expected = { plex: 'Fixture Movies', jellyfin: 'Jellyfin Films', local: 'Folder Films' };
    for (const [who, browser] of [
      ['Discord member', member],
      ['Plex member', plexMember],
      ['room guest', guest],
    ]) {
      assert.equal((await browser.request('/api/watch/me')).status, 200, who + ' is admitted');
      for (const [kind, serverId] of Object.entries(f.servers)) {
        const response = await browser.request('/api/watch/library?server=' + encodeURIComponent(serverId));
        assert.equal(response.status, 200, `${who} browses the ${kind} source`);
        assert.match(titles(response), new RegExp(expected[kind]), `${who} sees the ${kind} libraries`);
        for (const secret of ['fixture-owner', 'fixture-jellyfin-key', 'fixture-server-'])
          assert.equal(titles(response).includes(secret), false, 'no source credential reaches a browser');
      }
      const me = (await browser.request('/api/watch/me')).body.account.id;
      const scope = await f.app.hub.mediaFor({ userId: me, guestRoomId: browser === guest ? id : undefined });
      assert.equal(scope.principal, 'discord-shared', `${who} watches Plex through the source credential`);
      assert.ok(await scope.allows('999'), "a viewer's own Plex restrictions play no part");
    }
    const hostViewer = randomUUID();
    const hostPath = '/api/watch/rooms/' + id + '?viewer=' + hostViewer;
    const guestPath = '/api/watch/rooms/' + id + '?viewer=' + randomUUID();
    const initial = await plexMember.request(hostPath);
    assert.equal(initial.status, 200);
    const load = await plexMember.post('/api/watch/rooms/' + id + '/command', {
      epoch: initial.body.epoch,
      expiresAt: Date.now() + 2900,
      viewerId: hostViewer,
      command: { action: 'media.load', args: { mediaId: '123', quality: 'direct' } },
    });
    assert.equal(load.body.status, 'applied');
    for (const [browser, roomPath] of [
      [plexMember, hostPath],
      [guest, guestPath],
    ]) {
      const state = await browser.request(roomPath);
      assert.equal(state.status, 200);
      assert.ok(state.body.mediaUrl);
      assert.equal((await browser.request(state.body.mediaUrl)).body, 'fixture-media-bytes');
    }
    assert.equal((await guest.request('/api/watch/rooms/' + other.body.id + '?viewer=' + randomUUID())).status, 403);
    // Someone the server refuses gets nothing from any source. With guests on, a Plex
    // nonmember may still sign in to use an invite, but that alone admits nobody.
    await refused.plex('denied');
    assert.equal((await refused.request('/api/watch/me')).status, 401);
    for (const serverId of Object.values(f.servers))
      assert.equal((await refused.request('/api/watch/library?server=' + encodeURIComponent(serverId))).status, 401);
    assert.equal((await refused.request('/api/watch/library/art?item=1')).status, 401);
  },
);

test('losing admission ends access to every source within the recheck window', tls, async t => {
  const f = await sources(t);
  const member = f.browser();
  await member.discord('guest');
  for (const serverId of Object.values(f.servers))
    assert.equal((await member.request('/api/watch/library?server=' + encodeURIComponent(serverId))).status, 200);
  f.members.delete(f.provider.subjects.guest);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 301000);
  for (const serverId of Object.values(f.servers))
    assert.equal(
      (await member.request('/api/watch/library?server=' + encodeURIComponent(serverId))).status,
      401,
      'a confirmed removal from the Discord server ends media access at the recheck',
    );
});
