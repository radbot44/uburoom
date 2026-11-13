'use strict';
const https = require('node:https');
const { runOperation, commitOperation } = require('../operation');

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

/**
 * The HTTPS server: every request gets its security headers, a lifetime that ends with its connection, an
 * access-log line, and the route table's answer (or a 404).
 * @param {{config: any, logger: any, tls: {cert: any, key: any}, json: Function,
 *   route: (ctx: import('./router').RouteContext) => Promise<boolean>}} services
 */
function createHttpServer({ config, logger, tls, json, route: dispatch }) {
  const server = https.createServer({ cert: tls.cert, key: tls.key, minVersion: 'TLSv1.2' }, (req, res) => {
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
      // Changes made during a request are answered only once they are stored, unless the route
      // has already flushed them itself (operator settings).
      let flushedByRoute = false;
      if (req.url?.split('?')[0] !== '/health') {
        const end = res.end.bind(res);
        res.end = (...args) => {
          if (flushedByRoute) return end(...args);
          const receipt = commitOperation();
          if (!receipt) return end(...args);
          receipt.then(
            () => end(...args),
            () => res.destroy(),
          );
          return res;
        };
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
          flushed: (status, value) => {
            flushedByRoute = true;
            json(res, status, value);
          },
          markFlushed: () => {
            flushedByRoute = true;
          },
        };
        if (!(await dispatch(ctx))) json(res, 404, { error: 'Not found' });
      })().catch(error => {
        if (!res.headersSent)
          json(res, error.status === 503 ? 503 : 400, {
            error:
              error.status === 503
                ? 'Discord login renewal temporarily unavailable; try again shortly'
                : 'Request failed; check configuration or try again',
          });
        else res.end();
      });
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}
module.exports = { createHttpServer };
