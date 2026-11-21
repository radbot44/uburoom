'use strict';
// A Plex Media Server as a media source. See server/sources/index.js for the contract.
const http = require('node:http');
const https = require('node:https');
const { Plex } = require('./plex');
const { PlexAuth, PlexMembers } = require('./auth');
const { PlexTv } = require('../../identity/plex');
const { plexProvider } = require('./provider');

const SETTINGS = [
  'url',
  'token',
  'machine_identifier',
  'delivery',
  'client_url',
  'lan_client_url',
  'direct_token',
  'reporting_enabled',
  'reporting_watch_state',
];

/** An HTTPS origin (no path, query or credentials), or undefined when blank. */
function httpsOrigin(value, label) {
  if (!value) return '';
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(label + ' must be an HTTPS origin');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error(label + ' must be an HTTPS origin');
  return url.origin;
}

/**
 * One `type: 'plex'` entry. Returns `{url, token, machineIdentifier, delivery: {mode, clientUrl,
 * lanClientUrl, token}, reporting: {enabled, watchState}}`.
 */
function validate(raw, { id }) {
  const where = 'sources ' + id + ': ';
  for (const key of Object.keys(raw))
    if (!SETTINGS.includes(key)) throw new Error(where + 'unknown Plex setting; check config.example.yaml');
  const text = key => {
    const value = raw[key];
    if (value === undefined) return '';
    if (typeof value !== 'string') throw new Error(where + key + ' must be a quoted string');
    return value;
  };
  const flag = (key, fallback) => {
    if (raw[key] === undefined) return fallback;
    if (typeof raw[key] !== 'boolean') throw new Error(where + key + ' must be true or false');
    return raw[key];
  };
  const url = text('url');
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new Error(where + 'url must be an HTTP(S) origin');
  }
  if (
    !['http:', 'https:'].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== '/'
  )
    throw new Error(where + 'url must be an HTTP(S) origin');
  const token = text('token');
  if (!token) throw new Error(where + 'token is required');
  const mode = text('delivery') || 'proxy';
  if (!['proxy', 'auto'].includes(mode)) throw new Error(where + 'delivery must be proxy or auto');
  const delivery = {
    mode,
    clientUrl: httpsOrigin(text('client_url'), where + 'client_url'),
    lanClientUrl: httpsOrigin(text('lan_client_url'), where + 'lan_client_url'),
    // The dedicated non-owner Plex account everyone watches through when delivery is direct,
    // because browsers receive tokens derived from it. Never the source's own token.
    token: text('direct_token'),
  };
  if (mode === 'auto' && !delivery.clientUrl) throw new Error(where + 'client_url is required for delivery: auto');
  if (mode === 'auto' && !delivery.token) throw new Error(where + 'direct_token is required for delivery: auto');
  if (delivery.token && mode !== 'auto') throw new Error(where + "direct_token is used only with delivery: 'auto'");
  if (delivery.token && delivery.token === token)
    throw new Error(where + 'direct_token must belong to a dedicated non-owner Plex account, not token');
  return {
    url: base.origin,
    token,
    machineIdentifier: text('machine_identifier'),
    delivery,
    reporting: { enabled: flag('reporting_enabled', true), watchState: flag('reporting_watch_state', true) },
  };
}

/** Two Plex entries pinned to the same server would be the same source twice. */
function validateAll(entries) {
  const pinned = entries.map(entry => entry.machineIdentifier).filter(Boolean);
  if (new Set(pinned).size !== pinned.length)
    throw new Error('Two Plex sources must not pin the same machine_identifier');
  const addresses = entries.map(entry => entry.url);
  if (new Set(addresses).size !== addresses.length) throw new Error('Two Plex sources must not use the same url');
}

/**
 * @param {any} entry
 * @param {{config: any, registry: any, pipeline: any, logger?: any, pin: any, plexFetch?: typeof fetch}} services
 */
function create(entry, { registry, pipeline, logger, pin, plexFetch = fetch, plexTv = new PlexTv(plexFetch) }) {
  const plex = new Plex(entry, plexFetch, { logger, pipeline });
  const plexAuth = new PlexAuth(entry, registry, plex, plexTv, { pin });
  const provider = plexProvider({ plex, source: entry, registry, plexAuth, pin });
  return Object.assign(provider, { plexAuth, members: userId => members(plexAuth, userId, logger) });
}

/**
 * Whether a person's own verified Plex sign-in can reach this source's pinned server: true, false,
 * or undefined when Plex gives no answer (so an outage is not a denial).
 */
async function members(plexAuth, userId, logger) {
  try {
    return !!(await plexAuth.forUser(userId));
  } catch (error) {
    if (error.noServerAccess || error.revoked) return false;
    logger?.warn('Access', 'Plex check got no answer: ' + error.message);
    return undefined;
  }
}

/** Every Plex source's server access together (see `PlexMembers`). */
function signIn(providers, { registry, plexFetch = fetch, plexTv = new PlexTv(plexFetch) }) {
  return new PlexMembers(
    registry,
    providers.map(provider => provider.plexAuth),
    plexTv,
  );
}

/** Whether the server answers at its address (non-destructive: `/identity` needs no token). */
async function check(entry) {
  const name = 'Plex Media Server reachability';
  return new Promise(resolve => {
    const client = entry.url.startsWith('https:') ? https : http;
    const req = client.get(new URL('/identity', entry.url), { timeout: 3500 }, res => {
      res.resume();
      resolve([
        res.statusCode >= 200 && res.statusCode < 500
          ? {
              category: 'Sources',
              name,
              status: 'pass',
              message: `Plex server reachable at ${entry.url} (HTTP ${res.statusCode})`,
            }
          : {
              category: 'Sources',
              name,
              status: 'warn',
              message: `Plex server returned HTTP ${res.statusCode} at ${entry.url}`,
            },
      ]);
    });
    req.on('timeout', () => {
      req.destroy();
      resolve([
        {
          category: 'Sources',
          name,
          status: 'warn',
          message: `Connection timed out reaching Plex server at ${entry.url}`,
          remediation: 'Check the source url and that Plex Media Server is running and reachable.',
        },
      ]);
    });
    req.on('error', error =>
      resolve([
        {
          category: 'Sources',
          name,
          status: 'warn',
          message: `Could not connect to Plex server at ${entry.url}: ${error.message}`,
          remediation: 'Check the source url in config.yaml and network routing.',
        },
      ]),
    );
  });
}

module.exports = { validate, validateAll, create, check, signIn, ownerAccount: true, memberIdentity: 'plex' };
