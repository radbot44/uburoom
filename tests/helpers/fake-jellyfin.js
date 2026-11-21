'use strict';
// A fake Jellyfin server for tests, as a fetch function: the endpoints uburoom uses for sign-in,
// membership, watch-state reports and setup, with the answers Jellyfin 12 gives. No network.
const { randomBytes } = require('node:crypto');

const hex = () => randomBytes(16).toString('hex');

function fakeJellyfin({
  base = 'http://jellyfin.invalid:8096',
  serverId = 'f'.repeat(32),
  apiKey = 'fixture-api-key',
} = {}) {
  const state = {
    serverId,
    apiKey,
    down: false,
    quickConnect: true,
    /** @type {Map<string, {Id: string, Name: string, password: string, Policy: {IsDisabled: boolean, IsAdministrator: boolean}}>} */
    users: new Map(),
    /** @type {Map<string, string>} token → user id */
    tokens: new Map(),
    /** @type {Map<string, {Code: string, Authenticated: boolean, userId?: string}>} secret → request */
    pending: new Map(),
    keys: [],
    /** Every request: method, path, token, body. */
    calls: [],
    reports: [],
  };
  function addUser(name, password, { admin = false, disabled = false, id = hex() } = {}) {
    state.users.set(id, { Id: id, Name: name, password, Policy: { IsDisabled: disabled, IsAdministrator: admin } });
    return id;
  }
  function issue(userId) {
    const token = hex();
    state.tokens.set(token, userId);
    return token;
  }
  const dto = user => ({ Id: user.Id, Name: user.Name, ServerId: state.serverId, Policy: { ...user.Policy } });
  const auth = (user, token = issue(user.Id)) => ({ AccessToken: token, ServerId: state.serverId, User: dto(user) });
  /** Approves a Quick Connect code as the named user would in Jellyfin's web client. */
  function approve(code, userId) {
    for (const request of state.pending.values())
      if (request.Code === code) Object.assign(request, { Authenticated: true, userId });
  }
  const json = (value, status = 200) => Response.json(value, { status });
  const empty = (status = 204) => new Response(null, { status });

  async function handle(input, options = {}) {
    if (state.down) throw new TypeError('fetch failed');
    const url = new URL(input);
    if (!url.href.startsWith(base + '/')) return empty(404);
    const path = url.pathname.slice(new URL(base).pathname.replace(/\/$/, '').length + 1);
    const header = new Headers(options.headers).get('authorization') || '';
    const token = /Token="([^"]+)"/.exec(header)?.[1];
    const body = options.body ? JSON.parse(options.body) : undefined;
    const method = options.method || 'GET';
    state.calls.push({
      method,
      path,
      token,
      body,
      device: /DeviceId="([^"]+)"/.exec(header)?.[1],
      query: Object.fromEntries(url.searchParams),
    });
    const isKey = token === state.apiKey;
    const tokenUser = token && state.users.get(state.tokens.get(token));
    const route = method + ' ' + path;
    if (route === 'GET System/Info/Public')
      return json({
        Id: state.serverId,
        ServerName: 'Fixture Jellyfin',
        Version: '12.4.0',
        ProductName: 'Jellyfin Server',
        StartupWizardCompleted: true,
      });
    if (route === 'GET QuickConnect/Enabled') return json(state.quickConnect);
    if (route === 'POST QuickConnect/Initiate') {
      if (!state.quickConnect) return empty(401);
      if (!/DeviceId="[^"]+"/.test(header) || !/Version="[^"]+"/.test(header)) return empty(400);
      const secret = hex(),
        code = String(100000 + Math.floor(Math.random() * 900000));
      state.pending.set(secret, { Code: code, Authenticated: false });
      return json({ Secret: secret, Code: code, Authenticated: false });
    }
    if (route === 'GET QuickConnect/Connect') {
      const request = state.pending.get(url.searchParams.get('secret'));
      return request ? json({ Code: request.Code, Authenticated: request.Authenticated }) : empty(404);
    }
    if (route === 'POST Users/AuthenticateWithQuickConnect') {
      const request = state.pending.get(body?.Secret);
      if (!request?.Authenticated) return empty(400);
      state.pending.delete(body.Secret);
      return json(auth(state.users.get(request.userId)));
    }
    if (route === 'POST Users/AuthenticateByName') {
      const user = [...state.users.values()].find(
        candidate => candidate.Name.toLowerCase() === String(body?.Username).toLowerCase(),
      );
      if (!user || user.password !== body?.Pw || user.Policy.IsDisabled) return empty(401);
      return json(auth(user));
    }
    if (route === 'GET Users') {
      if (!isKey && !tokenUser) return empty(401);
      return json([...state.users.values()].map(dto));
    }
    if (route === 'GET Users/Me') return tokenUser ? json(dto(tokenUser)) : empty(401);
    const byId = /^GET Users\/([a-f0-9]{32})$/.exec(route);
    if (byId) {
      if (!isKey) return empty(401);
      const user = state.users.get(byId[1]);
      return user ? json(dto(user)) : empty(404);
    }
    if (route === 'POST Auth/Keys') {
      if (!tokenUser?.Policy.IsAdministrator) return empty(403);
      state.keys.push({
        AccessToken: hex(),
        AppName: url.searchParams.get('app'),
        DateCreated: new Date().toISOString(),
      });
      return empty();
    }
    if (route === 'GET Auth/Keys') {
      if (!tokenUser?.Policy.IsAdministrator) return empty(403);
      return json({ Items: state.keys, TotalRecordCount: state.keys.length });
    }
    if (route === 'POST Sessions/Logout') {
      if (token) state.tokens.delete(token);
      return empty();
    }
    if (/^POST (Sessions\/Playing(\/Progress|\/Stopped)?|UserPlayedItems\/[a-f0-9]{32})$/.test(route)) {
      if (!tokenUser) return empty(401);
      state.reports.push({ path, userId: tokenUser.Id, token, body });
      return path.startsWith('UserPlayedItems') ? json({ Played: true }) : empty();
    }
    return empty(404);
  }
  return { fetch: handle, state, addUser, approve, issue, base };
}

module.exports = { fakeJellyfin };
