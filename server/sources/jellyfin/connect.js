'use strict';
// @ts-check
// Guided setup for a Jellyfin source, for the setup wizard and Server settings (their screens come
// later): find servers on the LAN, confirm an address is Jellyfin, sign in once as an administrator,
// create an API key for uburoom, and list the server's users. The administrator's token is used for
// those two calls and then signed out; only the API key is kept, by whoever saves the source.
const dgram = require('node:dgram');
const { jellyfinClient, jellyfinId, baseUrl, deviceId } = require('./client');
const { jellyfinSignIn } = require('./sign-in');

const DISCOVERY_PORT = 7359;
const DISCOVERY_MESSAGE = 'who is JellyfinServer?';
const API_KEY_APP = 'uburoom';
const text = (value, limit = 100) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';

/**
 * Asks the LAN who runs Jellyfin (UDP broadcast to port 7359) and collects answers for `timeoutMs`.
 * Answers are hints: an address may be unreachable from here (containers), so probe it with
 * `publicInfo` before offering it. Broadcast does not leave a container's bridge network.
 * @param {{timeoutMs?: number, address?: string, port?: number, createSocket?: typeof dgram.createSocket}} [options]
 * @returns {Promise<{id: string, name: string, address: string}[]>}
 */
function discover({
  timeoutMs = 2000,
  address = '255.255.255.255',
  port = DISCOVERY_PORT,
  createSocket = dgram.createSocket,
} = {}) {
  return new Promise((resolve, reject) => {
    const found = new Map();
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    let timer;
    const finish = error => {
      clearTimeout(timer);
      socket.removeAllListeners('message');
      try {
        socket.close();
      } catch {
        /* Already closed. */
      }
      if (error) reject(error);
      else resolve([...found.values()]);
    };
    socket.on('error', finish);
    socket.on('message', message => {
      if (message.length > 4096 || found.size >= 64) return;
      let answer;
      try {
        answer = JSON.parse(message.toString('utf8'));
      } catch {
        return;
      }
      const id = jellyfinId(answer?.Id);
      let url;
      try {
        url = baseUrl(answer?.Address);
      } catch {
        return;
      }
      if (id && !found.has(id)) found.set(id, { id, name: text(answer.Name, 60) || 'Jellyfin', address: url });
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
      } catch {
        /* A unicast probe works without it. */
      }
      socket.send(Buffer.from(DISCOVERY_MESSAGE), port, address, error => {
        if (error) finish(error);
      });
      timer = setTimeout(() => finish(), timeoutMs);
    });
  });
}

/**
 * Confirms an address is a Jellyfin server and reads who it is, without signing in.
 * @param {string} url
 * @param {{fetcher?: typeof fetch}} [options]
 * @returns {Promise<{url: string, id: string, name: string, version: string, setupComplete: boolean}>}
 */
async function publicInfo(url, { fetcher } = {}) {
  const client = jellyfinClient({ url, fetcher, device: deviceId(baseUrl(url), 'setup') });
  let info;
  try {
    info = await client.request('System/Info/Public', { timeoutMs: 8000 });
  } catch (error) {
    throw Object.assign(new Error('No Jellyfin server answered at that address'), {
      code: 'JELLYFIN_UNREACHABLE',
      status: error.unanswered ? 503 : 404,
    });
  }
  const id = jellyfinId(info?.Id);
  if (!id || (info.ProductName && !/jellyfin/i.test(String(info.ProductName))))
    throw Object.assign(new Error('That address answered, but not as a Jellyfin server'), {
      code: 'JELLYFIN_NOT_JELLYFIN',
      status: 400,
    });
  return {
    url: client.base,
    id,
    name: text(info.ServerName, 60) || 'Jellyfin',
    version: text(info.Version, 20),
    setupComplete: info.StartupWizardCompleted !== false,
  };
}

/**
 * Administrator sign-in for setup: Quick Connect or password, on a device id of its own so it never
 * ends the person's other Jellyfin sessions. Nothing is stored; the token goes to `createApiKey`.
 * @param {string} url
 * @param {string} serverId - from `publicInfo`; a sign-in answered by another server is refused
 * @param {{fetcher?: typeof fetch}} [options]
 */
function adminSignIn(url, serverId, { fetcher } = {}) {
  const client = jellyfinClient({ url, fetcher, device: deviceId(baseUrl(url), 'setup') });
  return jellyfinSignIn({ client, serverId: async () => serverId, requireAdministrator: true });
}

/**
 * Creates an API key named "uburoom" with an administrator's token, reads it back, and signs the
 * administrator's token out. The owner can see and revoke the key in Jellyfin's dashboard.
 * @param {string} url
 * @param {string} adminToken
 * @param {{fetcher?: typeof fetch, now?: () => number}} [options]
 * @returns {Promise<string>} the new API key
 */
async function createApiKey(url, adminToken, { fetcher, now = Date.now } = {}) {
  const client = jellyfinClient({ url, fetcher, device: deviceId(baseUrl(url), 'setup') });
  const asAdmin = { token: adminToken };
  const startedAt = now() - 60000;
  try {
    try {
      await client.request('Auth/Keys', { method: 'POST', query: { app: API_KEY_APP }, ...asAdmin });
    } catch (error) {
      if (error.status === 401 || error.status === 403)
        throw Object.assign(new Error('Sign in as a Jellyfin administrator to create an API key'), {
          code: 'JELLYFIN_NOT_ADMIN',
          status: 403,
        });
      throw error;
    }
    const keys = await client.request('Auth/Keys', asAdmin);
    const ours = (Array.isArray(keys?.Items) ? keys.Items : [])
      .filter(
        key =>
          key?.AppName === API_KEY_APP &&
          typeof key.AccessToken === 'string' &&
          /^[\x21-\x7e]{8,200}$/.test(key.AccessToken) &&
          !key.AccessToken.includes('"') &&
          !key.DateRevoked &&
          (Date.parse(key.DateCreated) || 0) >= startedAt,
      )
      .sort((a, b) => Date.parse(b.DateCreated) - Date.parse(a.DateCreated));
    if (!ours.length)
      throw Object.assign(new Error('Jellyfin did not show the new API key; create one in its dashboard'), {
        code: 'JELLYFIN_ANSWER',
        status: 502,
      });
    return ours[0].AccessToken;
  } finally {
    // The administrator's sign-in was only for this; end it whatever happened.
    await client.request('Sessions/Logout', { method: 'POST', ...asAdmin }).catch(() => {});
  }
}

/**
 * The server's users, for choosing the one whose libraries a source offers.
 * @param {string} url
 * @param {string} apiKey
 * @param {{fetcher?: typeof fetch}} [options]
 * @returns {Promise<{id: string, name: string, disabled: boolean, administrator: boolean}[]>}
 */
async function listUsers(url, apiKey, { fetcher } = {}) {
  const client = jellyfinClient({ url, fetcher, device: deviceId(baseUrl(url), 'setup') });
  const users = await client.request('Users', { token: apiKey });
  return (Array.isArray(users) ? users : [])
    .map(user => ({
      id: jellyfinId(user?.Id) || '',
      name: text(user?.Name),
      disabled: user?.Policy?.IsDisabled === true,
      administrator: user?.Policy?.IsAdministrator === true,
    }))
    .filter(user => user.id && user.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { discover, publicInfo, adminSignIn, createApiKey, listUsers, DISCOVERY_PORT };
