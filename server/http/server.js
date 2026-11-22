'use strict';
const http = require('node:http');
const https = require('node:https');
const { runOperation } = require('../operation');
const { trustedPeer, loopbackPeer } = require('../client-address');

const STATIC_LOG = /\.(?:js|css|svg|wasm|woff2)$/;

/** Whether a request comes from Discord Activity, and the query to carry into the page it lands on. */
function activityOf(config, req, url) {
  const origin = /^\d{17,20}$/.test(config.clientId || '') ? `https://${config.clientId}.discordsays.com` : undefined;
  let context = url.searchParams.has('frame_id');
  let query = url.search;
  if (origin) {
    try {
      const referrer = new URL(req.headers.referer);
      if (referrer.origin === origin) {
        context = true;
        query ||= referrer.search;
      }
    } catch {
      /* No usable referrer. */
    }
    context ||= req.headers.origin === origin || req.headers.host === new URL(origin).host;
  }
  return { context, query };
}

const isHealth = req => req.method === 'GET' && (req.url || '').split('?')[0] === '/health';
/** The scheme the browser used, as the proxy in front reports it. */
const forwardedProto = req =>
  String(req.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
const PROTO_ERROR =
  'uburoom is behind a proxy (server.listen: http-proxy) and needs X-Forwarded-Proto: https from it; check the proxy publishes HTTPS and sends that header';

/**
 * Plain HTTP behind a trusted proxy (server.listen: 'http-proxy'; docs/tls-and-remote-access.md T2, T3):
 * a connection from a peer outside server.trusted_proxies is destroyed before any request is read, except
 * that this machine may ask GET /health (the container health check). Every other request, WebSocket
 * upgrades included, must say the browser used HTTPS. Returns whether a request may go on.
 * @param {import('node:http').Server} server
 * @param {any} config
 */
function guardProxy(server, config) {
  const peer = socket => socket.remoteAddress;
  server.on('connection', socket => {
    if (trustedPeer(peer(socket), config.trustedProxies)) socket.uburoomTrusted = true;
    else if (!loopbackPeer(peer(socket))) socket.destroy();
  });
  // Runs before the room socket's own upgrade handler, which ignores an already destroyed socket.
  server.prependListener('upgrade', (req, socket) => {
    if (!socket.uburoomTrusted) return socket.destroy();
    if (forwardedProto(req) !== 'https') {
      // Answer, then close once the answer is written.
      socket.end('HTTP/1.1 421 Misdirected Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
  });
  return (req, res, json) => {
    if (isHealth(req)) return true;
    if (!req.socket.uburoomTrusted) {
      req.socket.destroy();
      return false;
    }
    if (forwardedProto(req) === 'https') return true;
    json(res, 421, { error: PROTO_ERROR });
    return false;
  };
}

/**
 * The HTTPS server (or, behind a trusted proxy, plain HTTP): every request gets its security headers, a lifetime that ends with its connection, an
 * access-log line, and the route table's answer (or a 404).
 * @param {{config: any, logger: any, tls: {cert: any, key: any}, json: Function,
 *   route: (ctx: import('./router').RouteContext) => Promise<boolean>}} services
 */
function createHttpServer({ config, logger, tls, json, route: dispatch }) {
  let admit = (_req, _res, _json) => true;
  const handle = (req, res) => {
    if (!admit(req, res, json)) return;
    const lifetime = new AbortController();
    req.once('aborted', () => lifetime.abort());
    // Completed responses also close; only a lost client cancels remaining work.
    res.once('close', () => {
      if (!res.writableFinished) lifetime.abort();
    });
    return runOperation(lifetime.signal, () => {
      const start = Date.now();
      if (config.logging?.requests) {
        res.on('finish', () => {
          const path = req.url ? req.url.split('?')[0] : '';
          const isStatic = path.startsWith('/vendor/') || STATIC_LOG.test(path) || path === '/favicon.ico';
          if (isStatic && res.statusCode < 400 && !logger.isLevelEnabled('debug')) return;
          const message = `${req.method} ${path} ${res.statusCode} ${Date.now() - start}ms`;
          if (res.statusCode >= 500) logger.error('HTTP', message);
          else if (res.statusCode >= 400) logger.warn('HTTP', message);
          else logger.info('HTTP', message);
        });
      }
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
      // Enforce HTTPS via Strict-Transport-Security to defend against SSL/TLS stripping attacks.
      res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
      );
      return (async () => {
        const url = new URL(req.url, config.publicUrl);
        const ctx = {
          req,
          res,
          url,
          route: url.pathname,
          activity: activityOf(config, req, url),
          json,
          flushed: (status, value) => json(res, status, value),
        };
        if (!(await dispatch(ctx))) json(res, 404, { error: 'Not found' });
      })().catch(error => {
        const status =
          error?.code === 'DISCORD_RENEWAL_UNAVAILABLE'
            ? 503
            : Number.isInteger(error?.status) && error.status >= 400 && error.status < 600
              ? error.status
              : error instanceof SyntaxError
                ? 400
                : 500;
        if (status >= 500) logger?.error?.('http', error);
        const message =
          error?.code === 'DISCORD_RENEWAL_UNAVAILABLE'
            ? 'Discord login renewal temporarily unavailable; try again shortly'
            : error?.expose && error.message
              ? error.message
              : error instanceof SyntaxError
                ? 'Invalid JSON request body'
                : status >= 500
                  ? 'Internal server error'
                  : 'Request failed; check configuration or try again';
        if (!res.headersSent) json(res, status, { error: message });
        else res.end();
      });
    });
  };
  const server =
    config.listen === 'http-proxy'
      ? http.createServer(handle)
      : https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, handle);
  if (config.listen === 'http-proxy') admit = guardProxy(server, config);
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createHttpServer };
