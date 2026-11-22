'use strict';
// @ts-check
/**
 * Setup mode (docs/first-run-setup.md): a small server that runs only when the config file does not
 * exist. It opens no database, media source or room code; it serves the setup page, its API and
 * /health, and ends by writing the first config and handing over, in this process, to the normal app.
 *
 * - Plain HTTP when bound to loopback; HTTPS with a certificate made in memory when bound wider
 *   (`--setup-host`), because the setup code and session cookie then cross the network (D2).
 * - Every request's Host must be localhost or an IP address (no DNS rebinding); every POST's Origin
 *   must be this page's own. Every API call but the code exchange needs the setup session (D3).
 * - The console and log show the setup code and a link with it in the fragment (D8).
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const { randomBytes, createHash } = require('node:crypto');
const { PlexTv } = require('../identity');
const { createStaticFiles, WEB } = require('../http/static');
const { createConfigFile } = require('../config-editor');
const { createCertificate } = require('../local-tls');
const { createSetupGuard } = require('./code');
const { createWizard, homeAddress, DEFAULT_PORT } = require('./wizard');
const { configText, load } = require('./config-file');
const { runChecks } = require('./checks');

const TICKET_MS = 2 * 60000;
const COOKIE = 'uburoom_setup';
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const PAGES = {
  '/setup': 'setup/index.html',
  '/setup/signed-in': 'setup/signed-in.html',
};
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";

/**
 * The setup options on the command line: `--setup-host <address>` to be reachable beyond this
 * computer (a container passes 0.0.0.0) and `--setup-port <port>`.
 * @param {string[]} args
 */
function setupOptions(args = process.argv.slice(2)) {
  /** @type {{host: string, port: number, published?: boolean}} */
  const options = { host: '127.0.0.1', port: DEFAULT_PORT };
  for (let i = 0; i < args.length; i++) {
    const [flag, inline] = args[i].split(/=(.*)/s);
    if (args[i] === '--setup-published') {
      options.published = true;
      continue;
    }
    if (flag !== '--setup-host' && flag !== '--setup-port') continue;
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(flag + ' requires a value');
    if (flag === '--setup-host') {
      if (value !== 'localhost' && !net.isIP(value)) throw new Error('--setup-host must be an IP address');
      options.host = value;
    } else {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--setup-port must be a port number');
      options.port = port;
    }
  }
  return options;
}

/** The hostname a request's Host header names, if it is one setup answers to. */
function allowedHost(header) {
  if (typeof header !== 'string' || header.length > 300) return undefined;
  let hostname;
  try {
    const url = new URL('http://' + header);
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash || /[/?#\\@\s]/.test(header))
      return undefined;
    hostname = url.hostname;
  } catch {
    return undefined;
  }
  const bare = hostname.replace(/^\[|\]$/g, '');
  return hostname === 'localhost' || net.isIP(bare) ? hostname : undefined;
}

const cookieValue = req =>
  Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map(part => part.trim().split('=')),
  )[COOKIE];

/**
 * Starts setup mode and resolves once it listens.
 * @param {{configFile: string, host?: string, port?: number, logger: any, handOff: (handoff: any) => Promise<any>,
 *   plexFetch?: typeof fetch, jellyfinFetch?: typeof fetch, jellyfinDiscover?: () => Promise<any[]>,
 *   discordFetch?: typeof fetch, platform?: string, published?: boolean}} options - `handOff` starts the normal app from the
 *   config just written, with the operator's sign-in ticket; setup's listener is closed first.
 */
async function startSetup({
  configFile,
  host = '127.0.0.1',
  port = DEFAULT_PORT,
  logger,
  handOff,
  plexFetch = fetch,
  jellyfinFetch,
  youtubeFetch,
  youtubeRunner,
  jellyfinDiscover,
  discordFetch,
  platform,
  published = false,
}) {
  const log = logger.child ? logger.child('Setup') : logger;
  const secure = !LOOPBACK.has(host);
  const files = createStaticFiles({ config: {} });
  let origin = 'http://localhost:' + port;
  const wizard = createWizard({
    configFile,
    setupHost: host,
    setupPort: () => address().port,
    published,
    plexTv: new PlexTv(plexFetch),
    plexFetch,
    jellyfinFetch,
    youtubeFetch,
    youtubeRunner,
    jellyfinDiscover,
    discordFetch,
    platform,
    origin: () => origin,
  });
  /** @type {ReturnType<typeof createSetupGuard>} */
  let guard;
  let finishing = false,
    finished = false;

  const headers = res => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Frame-Options', 'DENY');
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
  async function body(req, limit = 32768) {
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw fail('JSON required');
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (Buffer.byteLength(text) > limit) throw fail('Request too large', 413);
    }
    let value;
    try {
      value = JSON.parse(text || '{}');
    } catch {
      throw fail('Invalid request');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('Invalid request');
    return value;
  }
  function setCookie(res, value, maxAge) {
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${value}; Path=/setup; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? '; Secure' : ''}`,
    );
  }

  /** The proposed config, and its checks. */
  async function check() {
    const answers = wizard.complete();
    const text = configText(answers);
    let config;
    try {
      config = load(text, configFile, true);
    } catch (error) {
      throw fail('These choices don’t make a valid configuration: ' + String(error.message).slice(0, 300));
    }
    const checks = await runChecks(config, { port: address().port }, answers.draft.network.names, {
      newAccount: answers.draft.account.provider === 'uburoom',
      tools: {
        plexFetch,
        ...(jellyfinFetch ? { jellyfinFetch } : {}),
        ...(youtubeFetch ? { youtubeFetch } : {}),
        ...(youtubeRunner ? { youtubeRunner } : {}),
      },
    });
    return { text, config, answers, checks };
  }
  /** Writes the config and hands over to the normal app; the answer waits until it listens. */
  async function finish(req, res, setupOrigin) {
    if (finishing) throw fail('Setup is already finishing', 409);
    finishing = true;
    try {
      const { text, answers, checks, config } = await check();
      if (checks.some(row => row.status !== 'pass')) return json(res, 409, { checks });
      await createConfigFile(configFile, Buffer.from(text, 'utf8'));
      log.info('Wrote ' + configFile);
      const ticket = randomBytes(32).toString('base64url');
      const { account } = answers.draft;
      const handoff = {
        ticket: createHash('sha256').update(ticket).digest('hex'),
        expires: Date.now() + TICKET_MS,
        setupOrigin,
        account:
          account.provider === 'plex'
            ? {
                provider: 'plex',
                subject: account.subject,
                name: account.name,
                credential: account.identity.credential,
              }
            : {
                provider: 'uburoom',
                subject: account.subject,
                username: account.username,
                name: account.name,
                hashed: account.hashed,
              },
      };
      guard.end();
      wizard.close();
      clearInterval(sweep);
      finished = true;
      // Stop listening so the app can take the port; this request's connection stays open for the answer
      // (so the close callback, which waits for every connection, is not awaited).
      server.close();
      server.closeIdleConnections?.();
      await new Promise(resolve => setImmediate(resolve));
      try {
        await handOff(handoff);
      } catch (error) {
        log.error('uburoom could not start: ' + error.message);
        return json(res, 500, { error: 'uburoom couldn’t start: ' + String(error.message).slice(0, 300) });
      }
      json(res, 200, { url: config.publicUrl + '/auth/setup#ticket=' + ticket });
    } finally {
      if (!finished) finishing = false;
      else
        res.once('finish', () =>
          setImmediate(() => {
            files.close();
            server.closeAllConnections?.();
          }),
        );
    }
  }

  /** @type {Record<string, (data: any, req: any) => any>} */
  const api = {
    'GET /setup/api/state': () => wizard.view(),
    'POST /setup/api/account/plex': data => (data.poll ? wizard.account.plexPoll() : wizard.account.plexStart()),
    'POST /setup/api/account/create': data => wizard.account.create(data),
    'POST /setup/api/account/clear': () => wizard.account.clear(),
    'GET /setup/api/sources': () => wizard.sources.list(),
    'GET /setup/api/sources/details': (data, req) =>
      wizard.sources.details(new URL(req.url, 'http://setup').searchParams.get('id') || ''),
    'POST /setup/api/sources/setup': data => wizard.sources.open(data.type),
    'POST /setup/api/sources/setup/step': data => wizard.sources.step(data),
    'POST /setup/api/sources': data => {
      if (data.action === 'add') return wizard.sources.add(data);
      if (data.action === 'update') return wizard.sources.update(data);
      if (data.action === 'remove') return wizard.sources.remove(data);
      throw fail('Choose add, update or remove');
    },
    'GET /setup/api/access': () => wizard.access.view(),
    'POST /setup/api/access': data => wizard.access.set(data),
    'POST /setup/api/access/discord': data => wizard.access.discord(data),
    'GET /setup/api/network': () => wizard.network.view(),
    'POST /setup/api/network': data => wizard.network.set(data),
    'POST /setup/api/check': async () => {
      const { checks, config, answers } = await check();
      return { checks, discordRedirect: answers.rules.discord ? config.publicUrl + '/auth/callback' : undefined };
    },
  };

  async function handle(req, res) {
    headers(res);
    const hostname = allowedHost(req.headers.host);
    if (!hostname) return json(res, 421, { error: 'Open setup at localhost or this computer’s IP address' });
    const url = new URL(req.url || '/', 'http://setup');
    const route = url.pathname;
    if (req.method === 'GET' && route === '/health') return json(res, 200, { ok: true, setup: true });
    if (finished) return json(res, 503, { error: 'Setup has finished' });
    const requestOrigin = new URL((secure ? 'https://' : 'http://') + req.headers.host).origin;
    if (['GET', 'HEAD'].includes(req.method || '')) {
      if (route === '/' || route === '/setup/') {
        res.writeHead(302, { Location: '/setup' });
        return res.end();
      }
      if (Object.hasOwn(PAGES, route))
        return files.send(
          req,
          res,
          await files.readAsset(path.join(WEB, PAGES[route])),
          'text/html; charset=utf-8',
          route,
        );
      if (route === '/theme.js') {
        const theme = files.routes().find(entry => entry.name === 'theme script');
        return theme.handle({ req, res, route });
      }
      const asset = await files.lookup(route);
      if (asset) return files.send(req, res, await files.readAsset(asset.file), asset.type, route);
    }
    if (!route.startsWith('/setup/api/')) return json(res, 404, { error: 'Not found' });
    if (req.method === 'POST' && req.headers.origin !== requestOrigin) return json(res, 403, { error: 'Not allowed' });
    try {
      if (req.method === 'POST' && route === '/setup/api/code') {
        const data = await body(req, 1024);
        const result = guard.exchange(data.code);
        if ('error' in result)
          return json(res, result.error === 'locked' ? 429 : 401, {
            code: result.error,
            error:
              result.error === 'locked'
                ? 'Too many attempts. The uburoom window now shows a new code.'
                : 'That code doesn’t match. Check the uburoom window.',
          });
        setCookie(res, result.session, Math.floor(guard.SESSION_MS / 1000));
        return json(res, 200, { ok: true });
      }
      if (!guard.valid(cookieValue(req)))
        return json(res, 401, { code: 'session', error: 'Enter the setup code again' });
      origin = requestOrigin;
      if (req.method === 'POST' && route === '/setup/api/finish') return await finish(req, res, requestOrigin);
      const action = api[req.method + ' ' + route];
      if (!action) return json(res, 404, { error: 'Not found' });
      const data = req.method === 'POST' ? await body(req) : {};
      json(res, 200, (await action(data, req)) || {});
    } catch (error) {
      if (res.headersSent) return res.end();
      if (error?.expose) return json(res, error.status || 400, { error: error.message });
      log.warn('Request failed: ' + (error?.message || error));
      json(res, 500, { error: 'Setup request failed; try again' });
    }
  }

  const listener = (req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Setup request failed; try again' });
      else res.end();
    });
  };
  let server;
  if (secure) {
    const names = ['localhost'];
    const ips = [host, homeAddress(undefined)].filter(
      address => address && net.isIP(address) && address !== '0.0.0.0' && address !== '::',
    );
    const { certPem, keyPem } = createCertificate({
      dnsNames: names,
      ipAddresses: ips,
      commonName: 'uburoom setup',
      days: 30,
    });
    server = https.createServer({ cert: certPem, key: keyPem, minVersion: 'TLSv1.2' }, listener);
  } else server = http.createServer(listener);
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  const address = () => /** @type {import('node:net').AddressInfo} */ (server.address());
  const localHost = ['127.0.0.1', '0.0.0.0', '::'].includes(host) ? 'localhost' : host;
  const shown =
    (secure ? 'https' : 'http') +
    '://' +
    (net.isIPv6(localHost) ? '[' + localHost + ']' : localHost) +
    ':' +
    address().port;
  origin = shown;
  guard = createSetupGuard({
    announce(code) {
      log.info(`No config file at ${configFile}: setup mode.`);
      if (published) log.info('In a browser, open https://<Docker host address>:<published port>/setup.');
      else {
        log.info(`Open ${shown}/setup#code=${code}`);
        if (secure && localHost === 'localhost')
          log.info(`From another device, open https://<this computer's address>:${address().port}/setup`);
      }
      log.info(`Setup code: ${code}`);
    },
  });
  const sweep = setInterval(() => wizard.sweep(), 10000);
  sweep.unref();
  return {
    server,
    address,
    /** Stops setup without finishing (Ctrl+C). */
    close() {
      clearInterval(sweep);
      wizard.close();
      files.close();
      return new Promise(resolve => {
        if (!server.listening) return resolve(undefined);
        server.close(() => resolve(undefined));
        server.closeAllConnections?.();
      });
    },
  };
}

/** Whether setup mode applies: the config file does not exist (an unreadable or invalid one does not count). */
function needsSetup(configFile) {
  try {
    fs.lstatSync(configFile);
    return false;
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

module.exports = { startSetup, setupOptions, needsSetup, allowedHost };
