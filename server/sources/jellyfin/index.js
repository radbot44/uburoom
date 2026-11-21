'use strict';
// A Jellyfin server, seen through one of its users, as a media source. See server/sources/index.js.
const { Jellyfin, jellyfinProvider } = require('./provider');

const { jellyfinId } = require('./client');
const { validateLibraries } = require('../libraries');

const TEXT = ['url', 'api_key', 'user'];
const SETTINGS = [...TEXT, 'reporting_watch_state', 'libraries'];

/** One `type: 'jellyfin'` entry. Returns `{url, apiKey, user, reporting: {watchState}}`. */
function validate(raw, { id }) {
  const where = 'sources ' + id + ': ';
  for (const key of Object.keys(raw))
    if (!SETTINGS.includes(key)) throw new Error(where + 'unknown Jellyfin setting; check config.example.yaml');
  for (const key of TEXT)
    if (raw[key] !== undefined && typeof raw[key] !== 'string')
      throw new Error(where + key + ' must be a quoted string');
  if (raw.reporting_watch_state !== undefined && typeof raw.reporting_watch_state !== 'boolean')
    throw new Error(where + 'reporting_watch_state must be true or false');
  let url;
  try {
    url = new URL(raw.url || '');
  } catch {
    throw new Error(where + 'url must be an HTTP(S) address');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error(where + 'url must be an HTTP(S) address without credentials or a query');
  const apiKey = raw.api_key || '',
    user = raw.user || '';
  if (!apiKey || !/^[\x21-\x7e]{1,200}$/.test(apiKey) || apiKey.includes('"'))
    throw new Error(where + 'api_key is required');
  if (!user || user.length > 100 || /[\u0000-\u001f\u007f]/.test(user))
    throw new Error(where + 'user is required: the Jellyfin user whose libraries are offered');
  return {
    url: url.origin + url.pathname.replace(/\/+$/, ''),
    apiKey,
    user,
    // Viewers who signed in to this server may opt in to resume/watched sync on their own user.
    reporting: { watchState: raw.reporting_watch_state !== false },
    // The user's library (view) ids this source offers; null offers every library, including later ones.
    libraries: validateLibraries(raw.libraries, where, jellyfinId),
  };
}

function validateAll(entries) {
  const addresses = entries.map(entry => entry.url);
  if (new Set(addresses).size !== addresses.length) throw new Error('Two Jellyfin sources must not use the same url');
}

function create(entry, { pipeline, logger, pin, registry, jellyfinFetch = fetch }) {
  return jellyfinProvider({ source: entry, pipeline, pin, logger, registry, fetcher: jellyfinFetch });
}

/** The server answers, and the API key and user can list libraries. */
async function check(entry, { ffmpeg, connectionOnly = false, jellyfinFetch } = {}) {
  const checks = [];
  const jellyfin = new Jellyfin(entry, { pipeline: {}, ...(jellyfinFetch ? { fetcher: jellyfinFetch } : {}) });
  const step = async (name, action, remediation) => {
    try {
      checks.push({ category: 'Sources', name, status: 'pass', message: await action() });
      return true;
    } catch (error) {
      checks.push({ category: 'Sources', name, status: 'fail', message: String(error.message || error), remediation });
      return false;
    }
  };
  const reached = await step(
    'Jellyfin server',
    async () => {
      const info = await jellyfin.json('System/Info/Public');
      return `Reached ${String(info.ServerName || 'Jellyfin').slice(0, 60)} ${String(info.Version || '').slice(0, 20)} at ${entry.url}`;
    },
    "Check the source's url (include any base path) and that the server is running.",
  );
  if (reached)
    await step(
      'Jellyfin API key and user',
      async () => {
        await jellyfin.userId();
        const libraries = await jellyfin.libraries();
        return `User "${entry.user}" offers ${libraries.length} movie or show ${libraries.length === 1 ? 'library' : 'libraries'}`;
      },
      "Create an API key in the Jellyfin dashboard and set the source's user to an existing username.",
    );
  if (!ffmpeg && !connectionOnly)
    checks.push({
      category: 'Sources',
      name: 'Jellyfin media tools',
      status: 'warn',
      message: 'Without FFmpeg, only files a browser plays as they are can be watched.',
      remediation: 'Install FFmpeg on PATH or set tools.ffmpeg.',
    });
  return checks;
}

/**
 * Every movie and show library the source's user can see, whether this source offers it or not, for
 * the operator choosing which to offer: `{id, name, type, count?}`.
 * @param {any} entry
 * @param {{jellyfinFetch?: typeof fetch}} [services]
 */
function libraries(entry, { jellyfinFetch = fetch } = {}) {
  return new Jellyfin({ ...entry, libraries: null }, { pipeline: {}, fetcher: jellyfinFetch }).serverLibraries();
}

module.exports = {
  validate,
  validateAll,
  create,
  check,
  libraries,
  connect: require('./connect'),
  setup: require('./setup'),
  memberIdentity: 'jellyfin',
};
