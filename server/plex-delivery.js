'use strict';
const net = require('node:net');

function normalizeAddress(raw) {
  if (typeof raw !== 'string' || !raw) return '';
  let ip = raw.trim();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isLocalAddress(raw) {
  const ip = normalizeAddress(raw);
  if (!ip) return false;
  if (ip === '::1' || ip === 'localhost') return true;
  if (ip.startsWith('127.')) return true;
  if (ip.startsWith('10.')) return true;
  if (ip.startsWith('192.168.')) return true;
  if (ip.startsWith('169.254.')) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  const lower = ip.toLowerCase();
  if (lower.startsWith('fe8') || lower.startsWith('fe9') || lower.startsWith('fea') || lower.startsWith('feb')) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(ip)) return true;
  return false;
}

function clientAddress(req) {
  const peer = normalizeAddress(req?.socket?.remoteAddress ?? req?.remoteAddress);
  if (!isLocalAddress(peer)) return peer;
  const headers = req?.headers;
  if (!headers || typeof headers !== 'object') return peer;
  const candidates = [
    headers['cf-connecting-ip'],
    typeof headers['x-forwarded-for'] === 'string' ? headers['x-forwarded-for'].split(',')[0] : undefined,
    headers['x-real-ip']
  ];
  for (const raw of candidates) {
    const ip = normalizeAddress(raw);
    if (ip && net.isIP(ip) !== 0) return ip;
  }
  return peer;
}

// Direct credentials belong to one viewer, including consumers of shared HLS.
// Credentials never enter shared room state, shared producers or persistent state.
class PlexDelivery {
  constructor(config, plex, plexAuth, resolve) {
    this.config = config; this.plex = plex; this.plexAuth = plexAuth; this.resolve = resolve;
    this.files = new WeakMap(); this.resources = new WeakMap(); this.plans = new WeakMap();
    this.discoveredLanOrigin = this.config.plexDelivery?.lanClientUrl || undefined;
    this.publicAddresses = new Set();
    this.rememberConfiguredPublicOrigin();
    this.discoveryJob = undefined;
    if (this.config.plexDelivery?.mode === 'auto' && !this.discoveredLanOrigin && this.plexAuth) {
      queueMicrotask(() => { void this.discoverLanOrigin(); });
    }
  }
  rememberPublicAddress(raw) {
    const ip = normalizeAddress(raw);
    if (ip && net.isIP(ip) !== 0 && !isLocalAddress(ip)) this.publicAddresses.add(ip);
  }
  rememberConfiguredPublicOrigin() {
    const raw = this.config.plexDelivery?.clientUrl;
    if (!raw) return;
    try {
      const host = new URL(raw).hostname.replace(/^\[|\]$/g, '');
      this.rememberPublicAddress(host);
      const match = /^(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.[0-9a-f]{32}\.plex\.direct$/i.exec(host);
      if (match) this.rememberPublicAddress(match[1].replace(/-/g, '.'));
    } catch {}
  }
  rememberDiscoveredLan(resource) {
    if (resource?.publicAddress) this.rememberPublicAddress(resource.publicAddress);
    for (const conn of resource?.connections || []) {
      if (conn?.local === false && conn?.relay === false && conn?.address) {
        this.rememberPublicAddress(conn.address);
      }
    }
    if (this.config.plexDelivery?.lanClientUrl) {
      this.discoveredLanOrigin = this.config.plexDelivery.lanClientUrl;
      return;
    }
    const connection = resource?.connections?.find(conn => {
      if (conn.protocol !== 'https' || conn.relay !== false || conn.local !== true) return false;
      try {
        const url = new URL(conn.uri);
        return url.protocol === 'https:' && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    });
    if (connection) {
      try { this.discoveredLanOrigin = new URL(connection.uri).origin; } catch {}
    }
  }
  isLocalViewer(remoteAddress) {
    if (isLocalAddress(remoteAddress)) return true;
    const ip = normalizeAddress(remoteAddress);
    return !!ip && this.publicAddresses.has(ip);
  }
  async discoverLanOrigin() {
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    if (this.config.plexDelivery?.lanClientUrl) {
      return (this.discoveredLanOrigin = this.config.plexDelivery.lanClientUrl);
    }
    if (this.discoveryJob) return this.discoveryJob;
    const token = this.config.plexFallback?.token || this.config.plexToken;
    if (!token || !this.plexAuth) return;
    this.discoveryJob = (async () => {
      try {
        const machine = await this.plexAuth.machine();
        const resources = await this.plexAuth.request('/resources?includeHttps=1', { token });
        const server = Array.isArray(resources) ? resources.find(r => r.clientIdentifier === machine && String(r.provides).split(',').includes('server')) : undefined;
        if (server) this.rememberDiscoveredLan(server);
      } catch { return; }
      finally { this.discoveryJob = undefined; }
      return this.discoveredLanOrigin;
    })();
    return this.discoveryJob;
  }
  async lanOrigin(scope) {
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    if (this.config.plexDelivery?.lanClientUrl) {
      return (this.discoveredLanOrigin = this.config.plexDelivery.lanClientUrl);
    }
    const resource = scope ? await this.resource(scope) : undefined;
    if (resource) this.rememberDiscoveredLan(resource);
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    return this.discoverLanOrigin();
  }
  origins() {
    const list = [];
    if (this.config.plexDelivery?.clientUrl) list.push(this.config.plexDelivery.clientUrl);
    if (this.discoveredLanOrigin && !list.includes(this.discoveredLanOrigin)) {
      list.push(this.discoveredLanOrigin);
    }
    return list;
  }
  async deliveryOrigins(remoteAddress) {
    if (!this.discoveredLanOrigin && this.config.plexDelivery?.mode === 'auto') {
      await this.discoverLanOrigin();
    }
    if (remoteAddress !== undefined && !this.isLocalViewer(remoteAddress)) {
      return this.config.plexDelivery?.clientUrl ? [this.config.plexDelivery.clientUrl] : [];
    }
    return this.origins();
  }
  async originFor(scope, remoteAddress) {
    if (!remoteAddress) return this.config.plexDelivery?.clientUrl;
    if (isLocalAddress(remoteAddress)) {
      const lan = await this.lanOrigin(scope);
      if (lan) return lan;
    } else if (this.config.plexDelivery?.mode === 'auto') {
      const lan = await this.lanOrigin(scope);
      if (lan && this.isLocalViewer(remoteAddress)) return lan;
    }
    return this.config.plexDelivery?.clientUrl;
  }
  async resource(scope) {
    const cached = this.resources.get(scope);
    if (cached?.until > Date.now()) return cached.job;
    const job = (async () => {
      try {
        const machine = await this.plexAuth.machine();
        const resources = await this.plexAuth.request('/resources?includeHttps=1', { token:scope.discoveryToken||scope.token, clientId:scope.clientId });
        const res = Array.isArray(resources) ? resources.find(value => value.clientIdentifier === machine && String(value.provides).split(',').includes('server')) : undefined;
        if (res) this.rememberDiscoveredLan(res);
        return res;
      } catch { return; }
    })();
    this.resources.set(scope, { job, until: Date.now() + 30000 });
    return job;
  }
  async fallbackAllowed(scope) {
    const { plexFallback: sharing, plexDelivery: delivery } = this.config;
    if (!delivery?.fallback || !sharing?.enabled || !sharing.token || sharing.token === this.config.plexToken || (scope.discoveryToken||scope.token) !== sharing.token) return false;
    // A different string alone does not prove a non-owner account.
    return (await this.resource(scope))?.owned === false;
  }
  async advertised(scope, origin) {
    const resource = await this.resource(scope);
    return resource?.connections?.some(connection => {
      if (connection.protocol !== 'https' || connection.relay !== false) return false;
      try {
        const url = new URL(connection.uri);
        return url.protocol === 'https:' && url.origin === origin && url.pathname === '/' && !url.username && !url.password && !url.search && !url.hash;
      } catch { return false; }
    }) === true;
  }
  async file(media, auth, valid, remoteAddress) {
    if (this.config.plexDelivery?.mode !== 'auto' || !this.config.plexDelivery.clientUrl || auth.identity.activity ||
      media?.kind !== 'plex' || media.format !== 'file' || !this.resolve || !this.plexAuth) return;
    // Optional direct negotiation must not exhaust the 15-second media grant
    // or block the room subscription through provider/endpoint timeouts.
    const controller = new AbortController(); let timer;
    const timeout = new Promise(resolve => { timer = setTimeout(() => {
      controller.abort();
      this.files.set(media, { job:Promise.resolve(undefined), until:Date.now() + 24 * 3600000 });
      resolve(undefined);
    }, 5000); });
    try { return await Promise.race([timeout, this.candidate(media,auth,async()=>!controller.signal.aborted && await valid(),controller.signal,remoteAddress)]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async hlsPlan(scope, viewer, room, valid) {
    if (this.config.plexDelivery?.mode !== 'auto' || !this.config.plexDelivery.clientUrl || viewer.activity !== false ||
      viewer.directProxyVersion === room.mediaVersion || !scope || scope === this.plex || !this.resolve || !this.plexAuth) return;
    const existing = this.plans.get(viewer);
    if (existing?.scope === scope && existing.version === room.mediaVersion && existing.remoteAddress === viewer.remoteAddress) {
      const plan=await existing.job;
      return await valid() && await this.resolve(viewer.actor)===scope ? plan : undefined;
    }
    const controller = new AbortController(); let timer;
    const current = async () => !controller.signal.aborted && await valid() && await this.resolve(viewer.actor) === scope;
    const job = (async () => {
      const timeout = new Promise(resolve => { timer=setTimeout(()=>{controller.abort();resolve(undefined);},5000); });
      try {
        return await Promise.race([timeout,(async()=>{
          if (scope.clientId === 'configured-fallback' && !await this.fallbackAllowed(scope)) return;
          if (!await current()) return;
          const plan = await this.credentials(scope,current,controller.signal,viewer.remoteAddress);
          return await current() ? plan : undefined;
        })().catch(()=>undefined)]);
      } finally {clearTimeout(timer);controller.abort();}
    })();
    this.plans.set(viewer,{scope,version:room.mediaVersion,remoteAddress:viewer.remoteAddress,job});
    return job;
  }
  async candidate(media, auth, valid, signal, remoteAddress) {
    try {
      const scope = await this.resolve(auth.actor);
      // The unscoped configured token is never a direct-play credential.
      if (!scope || scope === this.plex || scope !== media.plexContext) return;
      if (scope.clientId === 'configured-fallback' && !await this.fallbackAllowed(scope)) return;
      if (!await valid()) return;
      const origin = await this.originFor(scope, remoteAddress);
      const existing = this.files.get(media);
      const job = existing?.until > Date.now() && (!existing.origin || existing.origin === origin) ? existing.job : this.prepare(media, scope, valid, signal, origin);
      if (job !== existing?.job) this.files.set(media, { job, until: Date.now() + 24 * 3600000, origin });
      const url = await job;
      return await valid() && await this.resolve(auth.actor) === scope ? url : undefined;
    } catch { return; } // The existing authorized proxy remains the recovery path.
  }
  async prepare(media, scope, valid, signal, origin) {
    try {
      const source = scope.url(media.start);
      if (!/^\/library\/parts\/\d+\//.test(source.pathname)) return;
      const credentials = await this.credentialsForOrigin(scope, valid, signal, origin);
      if (!credentials) return;
      const target = new URL(source.pathname, credentials.origin);
      // Never forward arbitrary upstream query parameters or credentials.
      if (source.searchParams.get('download') === '1') target.searchParams.set('download','1');
      target.searchParams.set('X-Plex-Token', credentials.token);
      return target.href;
    } catch { return; }
  }
  async credentials(scope, valid, signal, remoteAddress) {
    const origin = await this.originFor(scope, remoteAddress);
    return this.credentialsForOrigin(scope, valid, signal, origin);
  }
  async credentialsForOrigin(scope, valid, signal, origin) {
    try {
      if (!origin) return;
      // Authenticated Plex discovery binds this exact HTTPS origin to the
      // pinned server, even when the server cannot loop back to its public IP.
      // Custom/unlisted origins still need a credential-free identity probe.
      if (!await this.advertised(scope, origin)) {
        const response = await this.plex.rawFetch(new URL('/identity', origin), { redirect: 'error',
          headers: { Accept: 'application/json' }, signal });
        if (!response.ok) return;
        const identity = (await response.json()).MediaContainer;
        if (!identity?.machineIdentifier || identity.machineIdentifier !== await this.plexAuth.machine()) return;
      }
      if (!await valid()) return;
      const delegated = await scope.json('/security/token?type=delegation&scope=all', { method: 'POST', signal });
      if (typeof delegated.token !== 'string' || !delegated.token.startsWith('transient-') || delegated.token.length > 1024 ||
        [scope.token, scope.discoveryToken, this.config.plexToken, this.config.plexFallback?.token].includes(delegated.token)) return;
      return await valid() ? {origin,token:delegated.token} : undefined;
    } catch { return; }
  }
}
module.exports = { PlexDelivery, isLocalAddress, clientAddress };
