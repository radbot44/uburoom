'use strict';
// A Plex Media Server as a media source. See server/sources/index.js for the contract.
const http = require('node:http');
const https = require('node:https');
const { Plex } = require('./plex');
const { PlexAuth, PlexMembers } = require('./auth');
const { PlexTv } = require('../../identity/plex');
const { plexProvider } = require('./provider');
const { validateLibraries } = require('../libraries');

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
  'libraries',
];
const SECTION = /^\d{1,20}$/;

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
    // Plex section keys this source offers; null offers every section, including later ones.
    libraries: validateLibraries(raw.libraries, where, value => (SECTION.test(value) ? value : undefined)),
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
  return Object.assign(provider, { plexAuth, members: identity => members(plexAuth, identity) });
}

/**
 * Whether a verified Plex identity can reach this source's pinned server through its own stored
 * sign-in: resolves true, or throws flagged `noServerAccess` (another kind of identity, no stored
 * sign-in, or no access) or `revoked`; any other error is Plex giving no answer.
 * @param {any} plexAuth
 * @param {{provider: string, subject: string, userId: string}} identity
 */
async function members(plexAuth, identity) {
  const notMember = message => Object.assign(new Error(message), { noServerAccess: true });
  if (identity?.provider !== 'plex') throw notMember('Not a Plex identity');
  if (!(await plexAuth.forUser(identity.userId))) throw notMember('No stored Plex sign-in');
  return true;
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

/**
 * Every movie and show library on the server, whether this source offers it or not, for the
 * operator choosing which to offer: `{id, name, type, count?}`. A count Plex does not give is left out.
 * @param {any} entry
 * @param {{plexFetch?: typeof fetch}} [services]
 */
async function libraries(entry, { plexFetch = fetch } = {}) {
  const plex = new Plex({ url: entry.url, token: entry.token }, plexFetch, { pipeline: {} });
  const sections = ((await plex.client.rawJson('/library/sections')).Directory || []).filter(
    section => ['movie', 'show'].includes(section?.type) && SECTION.test(String(section.key)),
  );
  return Promise.all(
    sections.slice(0, 200).map(async section => {
      const id = String(section.key);
      let count;
      try {
        const page = await plex.client.rawJson(
          '/library/sections/' + id + '/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0',
        );
        const total = Number(page.totalSize ?? page.size);
        if (Number.isSafeInteger(total) && total >= 0) count = total;
      } catch {
        /* Listed without a count. */
      }
      return {
        id,
        name: String(section.title || 'Library').slice(0, 100),
        type: section.type === 'show' ? 'shows' : 'movies',
        ...(count === undefined ? {} : { count }),
      };
    }),
  );
}

module.exports = {
  validate,
  validateAll,
  create,
  check,
  libraries,
  signIn,
  ownerAccount: true,
  memberIdentity: 'plex',
};
