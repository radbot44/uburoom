'use strict';
const net = require('node:net');
const { isLocalAddress, normalizeAddress } = require('../../client-address');
const { DIRECT_CLIENT } = require('./auth');

// Browsers get delegated tokens only from the dedicated non-owner account
// (`plex.direct_token`), never from the owner's plex.token. Issued tokens belong to one
// viewer, including consumers of shared HLS, and never enter shared room state, shared
// producers or persistent state.
class PlexDelivery {
  /** @param {any} source - The Plex source entry: `token` and `delivery` (`mode`, `clientUrl`, `lanClientUrl`, `token`). */
  constructor(source, plex, plexAuth, resolve) {
    this.source = source;
    this.plex = plex;
    this.plexAuth = plexAuth;
    this.resolve = resolve;
    this.files = new WeakMap();
    this.resources = new WeakMap();
    this.plans = new WeakMap();
    this.discoveredLanOrigin = this.source.delivery?.lanClientUrl || undefined;
    this.publicAddresses = new Set();
    this.rememberConfiguredPublicOrigin();
    this.discoveryJob = undefined;
    if (this.enabled && !this.discoveredLanOrigin && this.plexAuth) {
      queueMicrotask(() => {
        void this.discoverLanOrigin();
      });
    }
  }
  /** Whether the owner turned direct delivery on with a dedicated account; off, nothing here is asked. */
  get enabled() {
    const delivery = this.source.delivery;
    return (
      delivery?.mode === 'auto' && !!delivery.clientUrl && !!delivery.token && delivery.token !== this.source.token
    );
  }
  rememberPublicAddress(raw) {
    const ip = normalizeAddress(raw);
    if (ip && net.isIP(ip) !== 0 && !isLocalAddress(ip)) this.publicAddresses.add(ip);
  }
  rememberConfiguredPublicOrigin() {
    const raw = this.source.delivery?.clientUrl;
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
    if (this.source.delivery?.lanClientUrl) {
      this.discoveredLanOrigin = this.source.delivery.lanClientUrl;
      return;
    }
    const connection = resource?.connections?.find(conn => {
      if (conn.protocol !== 'https' || conn.relay !== false || conn.local !== true) return false;
      try {
        const url = new URL(conn.uri);
        return (
          url.protocol === 'https:' &&
          url.pathname === '/' &&
          !url.username &&
          !url.password &&
          !url.search &&
          !url.hash
        );
      } catch {
        return false;
      }
    });
    if (connection) {
      try {
        this.discoveredLanOrigin = new URL(connection.uri).origin;
      } catch {}
    }
  }
  isLocalViewer(remoteAddress) {
    if (isLocalAddress(remoteAddress)) return true;
    const ip = normalizeAddress(remoteAddress);
    return !!ip && this.publicAddresses.has(ip);
  }
  async discoverLanOrigin() {
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    if (this.source.delivery?.lanClientUrl) {
      return (this.discoveredLanOrigin = this.source.delivery.lanClientUrl);
    }
    if (Date.now() < (this.lanCheckedUntil || 0)) return;
    if (this.discoveryJob) return this.discoveryJob;
    const token = this.source.delivery?.token;
    if (!token || !this.plexAuth) return;
    this.discoveryJob = (async () => {
      try {
        const machine = await this.plexAuth.machine();
        const resources = await this.plexAuth.request('/resources?includeHttps=1', { token });
        const server = Array.isArray(resources)
          ? resources.find(r => r.clientIdentifier === machine && String(r.provides).split(',').includes('server'))
          : undefined;
        if (server) this.rememberDiscoveredLan(server);
      } catch {
        return;
      } finally {
        if (!this.discoveredLanOrigin) this.lanCheckedUntil = Date.now() + 300000;
        this.discoveryJob = undefined;
      }
      return this.discoveredLanOrigin;
    })();
    return this.discoveryJob;
  }
  async lanOrigin(scope) {
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    if (this.source.delivery?.lanClientUrl) {
      return (this.discoveredLanOrigin = this.source.delivery.lanClientUrl);
    }
    const resource = scope ? await this.resource(scope) : undefined;
    if (resource) this.rememberDiscoveredLan(resource);
    if (this.discoveredLanOrigin) return this.discoveredLanOrigin;
    return this.discoverLanOrigin();
  }
  origins() {
    const list = [];
    if (this.source.delivery?.clientUrl) list.push(this.source.delivery.clientUrl);
    if (this.discoveredLanOrigin && !list.includes(this.discoveredLanOrigin)) {
      list.push(this.discoveredLanOrigin);
    }
    return list;
  }
  async deliveryOrigins(remoteAddress) {
    if (!this.discoveredLanOrigin && this.source.delivery?.mode === 'auto') await this.discoverLanOrigin();
    if (remoteAddress !== undefined && !this.isLocalViewer(remoteAddress)) {
      return this.source.delivery?.clientUrl ? [this.source.delivery.clientUrl] : [];
    }
    return this.origins();
  }
  async originFor(scope, remoteAddress) {
    if (!remoteAddress) return this.source.delivery?.clientUrl;
    if (isLocalAddress(remoteAddress)) {
      const lan = await this.lanOrigin(scope);
      if (lan) return lan;
    } else if (this.source.delivery?.mode === 'auto') {
      const lan = await this.lanOrigin(scope);
      if (lan && this.isLocalViewer(remoteAddress)) return lan;
    }
    return this.source.delivery?.clientUrl;
  }
  async resource(scope) {
    const cached = this.resources.get(scope);
    if (cached?.until > Date.now()) return cached.job;
    const job = (async () => {
      try {
        const machine = await this.plexAuth.machine();
        const resources = await this.plexAuth.request('/resources?includeHttps=1', {
          token: scope.discoveryToken || scope.token,
          clientId: scope.clientId,
        });
        const res = Array.isArray(resources)
          ? resources.find(
              value => value.clientIdentifier === machine && String(value.provides).split(',').includes('server'),
            )
          : undefined;
        if (res) this.rememberDiscoveredLan(res);
        return res;
      } catch {
        return;
      }
    })();
    this.resources.set(scope, { job, until: Date.now() + 30000 });
    return job;
  }
  /** Whether this scope is the dedicated account and plex.tv confirms it does not own the server. */
  async dedicatedAllowed(scope) {
    const token = this.source.delivery?.token;
    if (
      !this.enabled ||
      scope?.clientId !== DIRECT_CLIENT ||
      (scope.discoveryToken || scope.token) !== token ||
      scope.token === this.source.token
    )
      return false;
    // A different string alone does not prove a non-owner account.
    return (await this.resource(scope))?.owned === false;
  }
  async advertised(scope, origin) {
    const resource = await this.resource(scope);
    return (
      resource?.connections?.some(connection => {
        if (connection.protocol !== 'https' || connection.relay !== false) return false;
        try {
          const url = new URL(connection.uri);
          return (
            url.protocol === 'https:' &&
            url.origin === origin &&
            url.pathname === '/' &&
            !url.username &&
            !url.password &&
            !url.search &&
            !url.hash
          );
        } catch {
          return false;
        }
      }) === true
    );
  }
  async file(media, auth, valid, remoteAddress) {
    if (
      !this.enabled ||
      auth.identity.activity ||
      media?.kind !== 'plex' ||
      media.format !== 'file' ||
      !this.resolve ||
      !this.plexAuth
    )
      return;
    // Optional direct negotiation must not exhaust the 15-second media grant
    // or block the room subscription through provider/endpoint timeouts.
    const controller = new AbortController(),
      ref = { origin: undefined };
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        controller.abort();
        if (ref.origin) {
          let byOrigin = this.files.get(media);
          if (!byOrigin) this.files.set(media, (byOrigin = new Map()));
          byOrigin.set(ref.origin, { job: Promise.resolve(undefined), until: Date.now() + 30000 });
        }
        resolve(undefined);
      }, 5000);
    });
    try {
      return await Promise.race([
        timeout,
        this.candidate(
          media,
          auth,
          async () => !controller.signal.aborted && (await valid()),
          controller.signal,
          remoteAddress,
          ref,
        ),
      ]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async hlsPlan(scope, viewer, room, valid) {
    if (
      !this.enabled ||
      viewer.activity !== false ||
      viewer.directProxyVersion === room.mediaVersion ||
      !scope ||
      scope === this.plex ||
      !this.resolve ||
      !this.plexAuth
    )
      return;
    const existing = this.plans.get(viewer);
    if (
      existing?.scope === scope &&
      existing.version === room.mediaVersion &&
      existing.streamVersion === viewer.streamVersion &&
      existing.remoteAddress === viewer.remoteAddress
    ) {
      const plan = await existing.job;
      if (plan !== undefined) {
        return (await valid()) && (await this.resolve(viewer.actor)) === scope ? plan : undefined;
      }
    }
    const controller = new AbortController();
    let timer;
    const current = async () =>
      !controller.signal.aborted && (await valid()) && (await this.resolve(viewer.actor)) === scope;
    const job = (async () => {
      const timeout = new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, 5000);
      });
      try {
        return await Promise.race([
          timeout,
          (async () => {
            if (!(await this.dedicatedAllowed(scope))) return;
            if (!(await current())) return;
            const plan = await this.credentials(scope, current, controller.signal, viewer.remoteAddress);
            return (await current()) ? plan : undefined;
          })().catch(() => undefined),
        ]);
      } finally {
        clearTimeout(timer);
        controller.abort();
      }
    })();
    this.plans.set(viewer, {
      scope,
      version: room.mediaVersion,
      streamVersion: viewer.streamVersion,
      remoteAddress: viewer.remoteAddress,
      job,
    });
    return job;
  }
  async candidate(media, auth, valid, signal, remoteAddress, ref) {
    try {
      const scope = await this.resolve(auth.actor);
      // The owner's configured token is never a direct-play credential; only the dedicated account is.
      if (!scope || scope === this.plex || scope !== media.provider) return;
      if (!(await this.dedicatedAllowed(scope))) return;
      if (!(await valid())) return;
      const origin = await this.originFor(scope, remoteAddress);
      if (ref) ref.origin = origin;
      if (signal?.aborted || !(await valid())) return;
      let byOrigin = this.files.get(media);
      if (!byOrigin) this.files.set(media, (byOrigin = new Map()));
      const existing = byOrigin.get(origin);
      const job = existing?.until > Date.now() ? existing.job : this.prepare(media, scope, valid, signal, origin);
      if (job !== existing?.job) byOrigin.set(origin, { job, until: Date.now() + 10 * 60_000 });
      const url = await job;
      if (!url) {
        const current = byOrigin.get(origin);
        if (current?.job === job) current.until = Date.now() + 30000;
      }
      return (await valid()) && (await this.resolve(auth.actor)) === scope ? url : undefined;
    } catch {
      return;
    } // The existing authorized proxy remains the recovery path.
  }
  async prepare(media, scope, valid, signal, origin) {
    try {
      const source = scope.url(media.start);
      if (!/^\/library\/parts\/\d+\//.test(source.pathname)) return;
      const credentials = await this.credentialsForOrigin(scope, valid, signal, origin);
      if (!credentials) return;
      const target = new URL(source.pathname, credentials.origin);
      // Never forward arbitrary upstream query parameters or credentials.
      if (source.searchParams.get('download') === '1') target.searchParams.set('download', '1');
      target.searchParams.set('X-Plex-Token', credentials.token);
      return target.href;
    } catch {
      return;
    }
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
      if (!(await this.advertised(scope, origin))) {
        const response = await this.plex.rawFetch(new URL('/identity', origin), {
          redirect: 'error',
          headers: { Accept: 'application/json' },
          signal,
        });
        if (!response.ok) return;
        const identity = (await response.json()).MediaContainer;
        if (!identity?.machineIdentifier || identity.machineIdentifier !== (await this.plexAuth.machine())) return;
      }
      if (!(await valid())) return;
      const delegated = await scope.json('/security/token?type=delegation&scope=all', { method: 'POST', signal });
      if (
        typeof delegated.token !== 'string' ||
        !delegated.token.startsWith('transient-') ||
        delegated.token.length > 1024 ||
        [scope.token, scope.discoveryToken, this.source.token, this.source.delivery?.token].includes(delegated.token)
      )
        return;
      return (await valid()) ? { origin, token: delegated.token } : undefined;
    } catch {
      return;
    }
  }
}
module.exports = { PlexDelivery };
