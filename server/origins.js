'use strict';
// @ts-check
const os = require('node:os');
const { clientAddress, isLocalAddress } = require('./client-address');

/**
 * Browser origin checks shared by HTTP routes and the room WebSocket.
 * Trusts `server.public_url` and, when enabled, either an explicit `server.lan_url`
 * or `'auto'` (this machine's detected LAN IP/hostname and loopback origins on `server.port`).
 */

const AUTO_CACHE_MS = 30_000;
/** @type {{key: string, at: number, origins: Set<string>} | undefined} */
let autoCache;

/** @param {string} address */
function isPrivateAutoAddress(address) {
  if (!address || address.includes('%')) return false;
  if (address.startsWith('10.') || address.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(address))
    return true;
  // Unique local IPv6 (fc00::/7); skip link-local fe80:: since browsers reject scoped literals.
  return /^f[cd][0-9a-f]{2}:/i.test(address);
}

/**
 * Formats an HTTPS origin from a host/IP and port, returning `undefined` if invalid.
 * @param {string} host
 * @param {number} port
 */
function httpsOrigin(host, port) {
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined;
  const formatted = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  const suffix = port === 443 ? '' : `:${port}`;
  try {
    const parsed = new URL(`https://${formatted}${suffix}`);
    return parsed.pathname === '/' && !parsed.username && !parsed.password ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Computes this machine's HTTPS LAN and loopback origins on `config.port`, excluding `config.publicUrl`.
 * @param {{port?: number, publicUrl?: string, lanAutoOrigins?: string[]}} config
 * @param {{interfaces?: NodeJS.Dict<os.NetworkInterfaceInfo[]>, hostname?: string}} [env]
 * @returns {Set<string>}
 */
function detectLanOrigins(config, env) {
  if (Array.isArray(config.lanAutoOrigins)) {
    const fixed = new Set(config.lanAutoOrigins);
    if (config.publicUrl) fixed.delete(config.publicUrl);
    return fixed;
  }
  const port = Number(config.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return new Set();
  const useCache = !env;
  const cacheKey = `${port}\0${config.publicUrl || ''}`;
  if (useCache && autoCache && autoCache.key === cacheKey && Date.now() - autoCache.at < AUTO_CACHE_MS) {
    return autoCache.origins;
  }
  const origins = new Set();
  const add = host => {
    const origin = httpsOrigin(host, port);
    if (origin && origin !== config.publicUrl) origins.add(origin);
  };
  for (const loopback of ['localhost', '127.0.0.1', '::1']) add(loopback);
  const interfaces = env?.interfaces ?? os.networkInterfaces();
  for (const entries of Object.values(interfaces || {})) {
    for (const entry of entries || []) {
      if (!entry || entry.internal) continue;
      if (isPrivateAutoAddress(entry.address)) add(entry.address);
    }
  }
  const rawHost = String(env?.hostname ?? os.hostname() ?? '')
    .trim()
    .toLowerCase();
  if (rawHost && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(rawHost)) {
    add(rawHost);
    if (!rawHost.includes('.')) add(`${rawHost}.local`);
  }
  if (useCache) autoCache = { key: cacheKey, at: Date.now(), origins };
  return origins;
}

/**
 * Whether `origin` is an allowed LAN origin under `config.lanUrl` (explicit or `'auto'`).
 * Never returns true for `config.publicUrl`.
 * @param {{publicUrl?: string, lanUrl?: string, listen?: string, port?: number, lanAutoOrigins?: string[]}} config
 * @param {string|undefined} origin
 */
function isLanOrigin(config, origin) {
  if (!config.lanUrl || typeof origin !== 'string' || origin === config.publicUrl) return false;
  if (config.lanUrl === 'auto') {
    if (config.listen === 'http-proxy') return false;
    return detectLanOrigins(config).has(origin);
  }
  return origin === config.lanUrl;
}

/**
 * Whether a browser `Origin` header matches an explicitly configured HTTPS origin of this server.
 * When `lan_url: 'auto'` is matched and `req` carries a peer address, the peer must be local/private.
 * @param {{publicUrl?: string, lanUrl?: string, listen?: string, port?: number, trustedProxies?: string[], trustedProxyHeader?: string, lanAutoOrigins?: string[]}} config
 * @param {string|undefined} origin
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}, remoteAddress?: string}} [req]
 */
function isAllowedBrowserOrigin(config, origin, req) {
  if (typeof origin !== 'string') return false;
  if (origin === config.publicUrl) return true;
  if (!isLanOrigin(config, origin)) return false;
  if (config.lanUrl === 'auto' && req && (req.socket?.remoteAddress || req.remoteAddress)) {
    return isLocalAddress(clientAddress(req, config));
  }
  return true;
}

/**
 * The HTTPS origin implied by a request's `Host` header, or `undefined` if missing/invalid.
 * Used for top-level GET navigations (such as OAuth start) that do not carry an `Origin` header.
 * @param {{headers?: Record<string, any>}} req
 */
function requestHostOrigin(req) {
  const host = typeof req?.headers?.host === 'string' ? req.headers.host.trim() : '';
  if (!host || /[\s/\\@]/.test(host)) return undefined;
  try {
    const parsed = new URL('https://' + host);
    return parsed.pathname === '/' && !parsed.username && !parsed.password ? parsed.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns the validated LAN origin for a request, or `undefined` if the request is not on an
 * allowed LAN origin (or is from a non-local peer under `lan_url: 'auto'`).
 * @param {{publicUrl?: string, lanUrl?: string, listen?: string, port?: number, trustedProxies?: string[], trustedProxyHeader?: string, lanAutoOrigins?: string[]}} config
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}, remoteAddress?: string}} req
 */
function requestLanOrigin(config, req) {
  if (!config.lanUrl) return undefined;
  const candidate = isLanOrigin(config, req?.headers?.origin)
    ? req.headers.origin
    : isLanOrigin(config, requestHostOrigin(req))
      ? requestHostOrigin(req)
      : undefined;
  if (!candidate) return undefined;
  if (config.lanUrl === 'auto' && req && (req.socket?.remoteAddress || req.remoteAddress)) {
    if (!isLocalAddress(clientAddress(req, config))) return undefined;
  }
  return candidate;
}

/**
 * Whether a request arrived on a configured LAN origin rather than `server.public_url`.
 * @param {{publicUrl?: string, lanUrl?: string, listen?: string, port?: number, trustedProxies?: string[], trustedProxyHeader?: string, lanAutoOrigins?: string[]}} config
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}, remoteAddress?: string}} req
 */
function isLanRequest(config, req) {
  return !!requestLanOrigin(config, req);
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a hostname looks like a local/LAN host (private IP, loopback, `.local`, or single-label hostname).
 * @param {string} hostname
 */
function isLikelyLanHost(hostname) {
  const host = hostname.toLowerCase();
  if (LOOPBACK_HOSTS.has(host)) return true;
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isPrivateAutoAddress(bare)) return true;
  if (host.endsWith('.local')) return true;
  return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host);
}

/**
 * Returns a helpful operator-facing message when a sign-in request arrives on a local/LAN address
 * that is not allowed by `server.public_url` or `server.lan_url`, or `undefined` otherwise.
 * @param {{publicUrl?: string, lanUrl?: string, listen?: string, port?: number, trustedProxies?: string[], trustedProxyHeader?: string, lanAutoOrigins?: string[]}} config
 * @param {{headers?: Record<string, any>, socket?: {remoteAddress?: string}, remoteAddress?: string}} req
 */
function unconfiguredOriginMessage(config, req) {
  const origin = typeof req?.headers?.origin === 'string' ? req.headers.origin : requestHostOrigin(req);
  if (!origin || origin === config.publicUrl || isAllowedBrowserOrigin(config, origin, req)) return undefined;
  let host, pubHost;
  try {
    host = new URL(origin).hostname.toLowerCase();
    pubHost = config.publicUrl ? new URL(config.publicUrl).hostname.toLowerCase() : '';
  } catch {
    return undefined;
  }
  if (LOOPBACK_HOSTS.has(host) && LOOPBACK_HOSTS.has(pubHost)) return undefined;
  if (!isLikelyLanHost(host)) return undefined;
  return config.lanUrl
    ? `This address is not configured for sign-in. Open ${config.publicUrl} or check server.lan_url in config.yaml.`
    : `This address is not enabled for sign-in. Open ${config.publicUrl}, or set server.lan_url in config.yaml.`;
}

module.exports = {
  detectLanOrigins,
  isLanOrigin,
  isAllowedBrowserOrigin,
  requestHostOrigin,
  requestLanOrigin,
  isLanRequest,
  unconfiguredOriginMessage,
};
