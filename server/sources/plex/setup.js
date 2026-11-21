'use strict';
// @ts-check
// Adding a Plex source in Server settings: a plex.tv PIN sign-in, the account's servers, each
// tested from this machine (local connections first, never a relay) against its /identity, then
// the chosen server's libraries. The account's server token stays in the flow on the server; the
// browser only ever sees names, addresses and library lists. See server/source-settings.js.
const { libraries } = require('./libraries');

const MAX_SERVERS = 20,
  MAX_CONNECTIONS = 8;
const text = (value, limit = 100) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** An HTTP(S) origin, or undefined. */
function origin(value) {
  try {
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Whether the server answering at `address` is the one named, by its /identity (no token needed).
 * @param {typeof fetch} fetcher
 * @param {string} address
 * @returns {Promise<string|undefined>} the machine identifier that answered
 */
async function identityAt(fetcher, address) {
  try {
    const response = await fetcher(new URL('/identity', address), {
      headers: { Accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(3500),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return undefined;
    }
    const id = (await response.json())?.MediaContainer?.machineIdentifier;
    return typeof id === 'string' && id ? id : undefined;
  } catch {
    return undefined;
  }
}

/** The first of a server's connections that reaches it from here: local before remote, relays never. */
async function reach(fetcher, resource) {
  const connections = (Array.isArray(resource.connections) ? resource.connections : [])
    .filter(connection => connection && connection.relay !== true && origin(connection.uri))
    .sort((a, b) => Number(b.local === true) - Number(a.local === true))
    .slice(0, MAX_CONNECTIONS);
  const answers = await Promise.all(
    connections.map(async connection =>
      (await identityAt(fetcher, origin(connection.uri))) === resource.clientIdentifier ? origin(connection.uri) : '',
    ),
  );
  return answers.find(Boolean);
}

/** The steps, each given the flow (server-held state) and what the browser sent. */
const steps = {
  /** Starts a plex.tv PIN sign-in; the browser opens the returned page. */
  async start(flow, data, { plexTv, publicUrl }) {
    flow.attempt = await plexTv.start(publicUrl + '/');
    flow.servers = new Map();
    return { url: flow.attempt.url };
  },
  /**
   * The account's servers once the PIN is approved (`waiting` until then), each tested from here.
   * Unreachable ones are listed with the reason, so they can be shown disabled.
   */
  async servers(flow, data, { plexTv, plexFetch }) {
    if (!flow.attempt) throw fail('Start the Plex sign-in again');
    if (!flow.account) {
      try {
        flow.account = await plexTv.identify(flow.attempt);
      } catch (error) {
        // Not approved yet: plex.tv has no token for the PIN (or refuses it until then).
        if (/not completed/.test(String(error.message)) || error.revoked) return { waiting: true };
        throw fail('Plex sign-in failed; start again', 502);
      }
    }
    const { credential } = flow.account;
    const resources = await plexTv.request('/resources?includeHttps=1&includeRelay=1', {
      token: credential.token,
      clientId: credential.clientId,
    });
    const found = (Array.isArray(resources) ? resources : [])
      .filter(
        resource =>
          String(resource?.provides || '')
            .split(',')
            .includes('server') &&
          typeof resource.clientIdentifier === 'string' &&
          resource.clientIdentifier &&
          typeof resource.accessToken === 'string' &&
          resource.accessToken,
      )
      .slice(0, MAX_SERVERS);
    flow.resources = found;
    const servers = await Promise.all(
      found.map(async resource => {
        const address = await reach(plexFetch, resource);
        const server = {
          id: resource.clientIdentifier,
          name: text(resource.name, 60) || 'Plex Media Server',
          owned: resource.owned === true,
        };
        if (address) flow.servers.set(server.id, { ...server, url: address, token: resource.accessToken });
        return address
          ? { ...server, reachable: true, address: new URL(address).host }
          : { ...server, reachable: false, reason: 'uburoom can’t reach this server from this computer' };
      }),
    );
    return { account: text(flow.account.name, 100), servers };
  },
  /** A server the account can reach, at an address the owner types instead of a found one. */
  async address(flow, data, { plexFetch }) {
    if (!flow.resources) throw fail('Sign in to Plex first');
    const address = origin(data.url);
    if (!address) throw fail('Enter an address like http://192.168.1.20:32400');
    const id = await identityAt(plexFetch, address);
    if (!id) throw fail('No Plex server answered at that address');
    const resource = flow.resources.find(candidate => candidate.clientIdentifier === id);
    if (!resource) throw fail('This Plex account has no access to the server at that address', 403);
    const server = {
      id,
      name: text(resource.name, 60) || 'Plex Media Server',
      owned: resource.owned === true,
    };
    flow.servers.set(id, { ...server, url: address, token: resource.accessToken });
    return { server: { ...server, reachable: true, address: new URL(address).host } };
  },
  /** The chosen server's libraries; the flow is then ready to be added. */
  async choose(flow, data, { plexFetch }) {
    const server = typeof data.server === 'string' ? flow.servers?.get(data.server) : undefined;
    if (!server) throw fail('Choose a server uburoom can reach');
    const listed = await libraries({ url: server.url, token: server.token }, { plexFetch });
    flow.draft = {
      entry: { url: server.url, token: server.token, machine_identifier: server.id },
      identity: server.id,
      name: server.name,
      libraries: listed,
    };
    return { name: server.name, address: new URL(server.url).host, libraries: listed };
  },
};

/** The entry's own settings, from a ready flow and the libraries the owner switched on. */
function entry(draft, { libraries: offered }) {
  return { ...draft.entry, ...(offered ? { libraries: offered } : {}) };
}

/** What Server settings may show of a saved entry: where it is and the libraries it offers. */
function summary(saved) {
  return { address: new URL(saved.url).host, offered: saved.libraries ?? null };
}

module.exports = { steps, entry, summary, selectLibraries: true };
