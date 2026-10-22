'use strict';

// Direct credentials belong to one viewer, including consumers of shared HLS.
// Credentials never enter shared room state, shared producers or persistent state.
class PlexDelivery {
  constructor(config, plex, plexAuth, resolve) {
    this.config = config; this.plex = plex; this.plexAuth = plexAuth; this.resolve = resolve;
    this.files = new WeakMap(); this.resources = new WeakMap(); this.plans = new WeakMap();
  }
  async resource(scope) {
    const cached = this.resources.get(scope);
    if (cached?.until > Date.now()) return cached.job;
    const job = (async () => {
      try {
        const machine = await this.plexAuth.machine();
        const resources = await this.plexAuth.request('/resources?includeHttps=1', { token:scope.discoveryToken||scope.token, clientId:scope.clientId });
        return Array.isArray(resources) ? resources.find(value => value.clientIdentifier === machine && String(value.provides).split(',').includes('server')) : undefined;
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
  async file(media, auth, valid) {
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
    try { return await Promise.race([timeout, this.candidate(media,auth,async()=>!controller.signal.aborted && await valid(),controller.signal)]); }
    finally { clearTimeout(timer); controller.abort(); }
  }
  async hlsPlan(scope, viewer, room, valid) {
    if (this.config.plexDelivery?.mode !== 'auto' || !this.config.plexDelivery.clientUrl || viewer.activity !== false ||
      viewer.directProxyVersion === room.mediaVersion || !scope || scope === this.plex || !this.resolve || !this.plexAuth) return;
    const existing = this.plans.get(viewer);
    if (existing?.scope === scope && existing.version === room.mediaVersion) {
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
          const plan = await this.credentials(scope,current,controller.signal);
          return await current() ? plan : undefined;
        })().catch(()=>undefined)]);
      } finally {clearTimeout(timer);controller.abort();}
    })();
    this.plans.set(viewer,{scope,version:room.mediaVersion,job});
    return job;
  }
  async candidate(media, auth, valid, signal) {
    try {
      const scope = await this.resolve(auth.actor);
      // The unscoped configured token is never a direct-play credential.
      if (!scope || scope === this.plex || scope !== media.plexContext) return;
      if (scope.clientId === 'configured-fallback' && !await this.fallbackAllowed(scope)) return;
      if (!await valid()) return;
      const existing = this.files.get(media);
      const job = existing?.until > Date.now() ? existing.job : this.prepare(media, scope, valid, signal);
      if (job !== existing?.job) this.files.set(media, { job, until: Date.now() + 24 * 3600000 });
      const url = await job;
      return await valid() && await this.resolve(auth.actor) === scope ? url : undefined;
    } catch { return; } // The existing authorized proxy remains the recovery path.
  }
  async prepare(media, scope, valid, signal) {
    try {
      const source = scope.url(media.start);
      if (!/^\/library\/parts\/\d+\//.test(source.pathname)) return;
      const credentials = await this.credentials(scope,valid,signal);
      if (!credentials) return;
      const target = new URL(source.pathname, credentials.origin);
      // Never forward arbitrary upstream query parameters or credentials.
      if (source.searchParams.get('download') === '1') target.searchParams.set('download','1');
      target.searchParams.set('X-Plex-Token', credentials.token);
      return target.href;
    } catch { return; }
  }
  async credentials(scope, valid, signal) {
    try {
      const origin = this.config.plexDelivery.clientUrl;
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
module.exports = { PlexDelivery };
