'use strict';
// Fake plex.tv, Plex, Jellyfin and Discord answers for first-run setup (tests/setup.test.js, and the
// wizard screenshots). Nothing here reaches the network: every address is .invalid.

const PLEX_ACCOUNT = { id: 101, username: 'alexwatches' };
const JF = {
  server: '1'.repeat(32),
  admin: '2'.repeat(32),
  viewer: '3'.repeat(32),
  kids: '5'.repeat(32),
  films: '4'.repeat(32),
  shows: '6'.repeat(32),
};
const DISCORD = {
  application: '100000000000000010',
  owner: '100000000000000001',
  secret: 'fixture-discord-secret',
  token: 'fixture-discord-bot-token-0123456789',
};

/**
 * plex.tv: a PIN approved after `approveAfter` checks, the account alexwatches, and two servers:
 * Living Room answers on its local address, Mom's server never answers. Relays are never tried.
 */
function plexFake({ approveAfter = 1 } = {}) {
  const state = { checks: 0, seen: [] };
  async function plexFetch(input, options = {}) {
    const url = new URL(String(input)),
      token = new Headers(options.headers).get('x-plex-token');
    state.seen.push(url.host + url.pathname);
    if (url.hostname === 'relay.invalid') throw new Error('A relay was tried');
    if (url.hostname === 'clients.plex.tv') {
      if (url.pathname === '/api/v2/pins' && options.method === 'POST') return Response.json({ id: 7, code: 'PINC' });
      if (url.pathname === '/api/v2/pins/7')
        return Response.json({ id: 7, authToken: ++state.checks > approveAfter ? 'fixture-plex-account' : null });
      if (token !== 'fixture-plex-account') return new Response('{}', { status: 401 });
      if (url.pathname === '/api/v2/user') return Response.json(PLEX_ACCOUNT);
      if (url.pathname === '/api/v2/resources')
        return Response.json([
          {
            name: 'Living Room',
            clientIdentifier: 'machine-lr',
            provides: 'server',
            owned: true,
            accessToken: 'fixture-living-room-token',
            connections: [
              { uri: 'https://relay.invalid:443', local: false, relay: true },
              { uri: 'http://plex-lr.invalid:32400', local: true, relay: false },
            ],
          },
          {
            name: 'Mom’s server',
            clientIdentifier: 'machine-mom',
            provides: 'server',
            accessToken: 'fixture-mom-token',
            connections: [{ uri: 'http://plex-mom.invalid:32400', local: false, relay: false }],
          },
        ]);
    }
    if (url.hostname === 'plex-mom.invalid') throw new Error('unreachable');
    if (url.hostname === 'plex-lr.invalid') {
      if (url.pathname === '/identity' || (url.pathname === '/' && token === 'fixture-living-room-token'))
        return Response.json({ MediaContainer: { machineIdentifier: 'machine-lr', friendlyName: 'Living Room' } });
      if (token !== 'fixture-living-room-token') return new Response('{}', { status: 401 });
      if (url.pathname === '/library/sections')
        return Response.json({
          MediaContainer: {
            Directory: [
              { key: '1', type: 'movie', title: 'Movies' },
              { key: '2', type: 'show', title: 'TV Shows' },
              { key: '3', type: 'show', title: 'Anime' },
              { key: '4', type: 'movie', title: 'Home Videos' },
            ],
          },
        });
      const counts = { 1: 1204, 2: 86, 3: 41, 4: 312 };
      const section = /^\/library\/sections\/(\d+)\/all$/.exec(url.pathname);
      if (section) return Response.json({ MediaContainer: { totalSize: counts[section[1]] || 0, size: 0 } });
      return Response.json({ MediaContainer: {} });
    }
    throw new Error('Unexpected Plex request: ' + url.href);
  }
  return { plexFetch, state };
}

/** A Jellyfin server, Cabin: an administrator signs in once (or by Quick Connect), and uburoom makes its API key. */
function jellyfinFake({ quickConnect = false } = {}) {
  const calls = [];
  async function jellyfinFetch(input, options = {}) {
    const url = new URL(String(input)),
      auth = new Headers(options.headers).get('authorization') || '';
    calls.push((options.method || 'GET') + ' ' + url.pathname);
    if (url.hostname !== 'jellyfin-cabin.invalid') throw new Error('unreachable');
    if (url.pathname === '/System/Info/Public')
      return Response.json({
        Id: JF.server,
        ServerName: 'Cabin',
        ProductName: 'Jellyfin Server',
        Version: '10.10.0',
        StartupWizardCompleted: true,
      });
    if (url.pathname === '/QuickConnect/Enabled') return Response.json(quickConnect);
    if (url.pathname === '/QuickConnect/Initiate') return Response.json({ Code: '482913', Secret: 'qc-secret' });
    if (url.pathname === '/QuickConnect/Connect') return Response.json({ Authenticated: false });
    if (url.pathname === '/Users/AuthenticateByName') {
      const sent = JSON.parse(options.body);
      if (sent.Username !== 'admin' || sent.Pw !== 'jf-password') return new Response('', { status: 401 });
      return Response.json({
        User: { Id: JF.admin, Name: 'admin', Policy: { IsAdministrator: true } },
        AccessToken: 'jf-admin-token',
        ServerId: JF.server,
      });
    }
    if (url.pathname === '/Auth/Keys' && /Token="jf-admin-token"/.test(auth))
      return options.method === 'POST'
        ? new Response(null, { status: 204 })
        : Response.json({
            Items: [{ AppName: 'uburoom', AccessToken: 'jf-new-key-1', DateCreated: new Date().toISOString() }],
          });
    if (url.pathname === '/Sessions/Logout') return new Response(null, { status: 204 });
    if (!/Token="jf-new-key-1"/.test(auth)) return new Response('{}', { status: 401 });
    if (url.pathname === '/Users')
      return Response.json([
        { Id: JF.viewer, Name: 'uburoom', Policy: {} },
        { Id: JF.admin, Name: 'admin', Policy: { IsAdministrator: true } },
        { Id: JF.kids, Name: 'kids', Policy: {} },
      ]);
    if (url.pathname === '/UserViews')
      return Response.json({
        Items: [
          { Id: JF.films, Name: 'Films', CollectionType: 'movies' },
          { Id: JF.shows, Name: 'Shows', CollectionType: 'tvshows' },
        ],
      });
    if (url.pathname === '/Items')
      return Response.json({ Items: [], TotalRecordCount: url.searchParams.get('ParentId') === JF.films ? 530 : 44 });
    return Response.json({ Items: [] });
  }
  const jellyfinDiscover = async () => [{ address: 'http://jellyfin-cabin.invalid:8096' }];
  return { jellyfinFetch, jellyfinDiscover, calls };
}

/** Discord: the application, its owner, a secret check and the servers its bot has joined. */
function discordFake({ servers = [{ id: '100000000000000020', name: 'Movie Night Crew' }] } = {}) {
  const state = { servers };
  async function discordFetch(input, options = {}) {
    const url = new URL(String(input)),
      auth = new Headers(options.headers).get('authorization') || '';
    if (url.hostname !== 'discord.com') throw new Error('unreachable');
    if (url.pathname === '/api/v10/oauth2/token') {
      const expected = 'Basic ' + Buffer.from(DISCORD.application + ':' + DISCORD.secret).toString('base64');
      return auth === expected
        ? Response.json({ access_token: 'x', token_type: 'Bearer' })
        : new Response('{}', { status: 401 });
    }
    if (auth !== 'Bot ' + DISCORD.token) return new Response('{}', { status: 401 });
    if (url.pathname === '/api/v10/oauth2/applications/@me')
      return Response.json({ id: DISCORD.application, name: 'uburoom', owner: { id: DISCORD.owner } });
    if (url.pathname === '/api/v10/users/@me/guilds') return Response.json(state.servers);
    return new Response('{}', { status: 404 });
  }
  return { discordFetch, state };
}

module.exports = { plexFake, jellyfinFake, discordFake, PLEX_ACCOUNT, JF, DISCORD };
