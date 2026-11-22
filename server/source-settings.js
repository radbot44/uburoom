'use strict';
// @ts-check
/**
 * Server settings → Sources: the operator lists, edits, adds and removes media sources. Changes are
 * written to `sources:` in config.yaml (server/config-editor.js) and apply after a restart (S8).
 *
 * Adding and describing a source is ./source-flows.js, shared with the first-run setup wizard; this
 * file adds the operator check, the saved file and its revision. Tokens, API keys and passwords stay
 * in flows and in the file: no answer carries them. Every request is the operator's, checked again
 * after awaited work.
 */
const path = require('node:path');
const { hash } = require('./core');
const { COOKIES } = require('./http/sessions');
const { isServerOperator } = require('./operator-policy');
const { sourceType } = require('./sources');
const flowsCore = require('./source-flows');

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/**
 * @param {{config: any, registry: any, editor?: ReturnType<typeof import('./config-editor').createConfigEditor>,
 *   sessions: any, plexFetch?: typeof fetch, jellyfinFetch?: typeof fetch, jellyfinDiscover?: () => Promise<any[]>,
 *   plexTv?: any, platform?: string}} services
 */
function sourceSettings({
  config,
  registry,
  editor,
  sessions,
  plexFetch,
  jellyfinFetch,
  youtubeFetch,
  youtubeRunner,
  jellyfinDiscover,
  plexTv,
  platform,
}) {
  const { json, body, cookies, logins, user, protectedPost, validIdentity } = sessions;
  const resolvedPlatform = platform || process.platform;
  const tools = {
    plexFetch: plexFetch || fetch,
    jellyfinFetch: jellyfinFetch || fetch,
    youtubeFetch: youtubeFetch || fetch,
    ...(youtubeRunner ? { youtubeRunner } : {}),
    ffmpeg: config.ffmpegPath,
    ffprobe: config.ffprobePath,
    platform: resolvedPlatform,
  };
  // `config.publicUrl` is read when a step runs: a test server learns its port after startup.
  const stepServices = {
    ...tools,
    plexTv,
    base: path.dirname(config.configFile || path.resolve('config.yaml')),
    ...(jellyfinDiscover ? { discover: jellyfinDiscover } : {}),
    get publicUrl() {
      return config.publicUrl;
    },
    get signInReturn() {
      return config.publicUrl + '/';
    },
  };
  const flows = flowsCore.createSourceFlows({ stepServices });
  const pinned = id => registry?.meta?.('source:' + id + ':identity') || undefined;

  // Scoped-identity sources (such as Jellyfin) tie identities to one server; another entry rule
  // cannot prove that an operator has a working second sign-in.
  function removalAffectsOperator(entry, { sources, memberSources, operators }) {
    const mod = sourceType(entry.type);
    if (typeof mod?.scopedIdentityProvider !== 'function' || !memberSources.includes(entry.id)) return false;
    const server = pinned(entry.id);
    const remaining = new Set(
      sources
        .filter(
          other =>
            other.id !== entry.id &&
            memberSources.includes(other.id) &&
            typeof sourceType(other.type)?.scopedIdentityProvider === 'function',
        )
        .map(other => sourceType(other.type).scopedIdentityProvider(pinned(other.id)))
        .filter(Boolean),
    );
    return operators.some(({ provider }) => mod.ownsIdentityProvider(provider, server) && !remaining.has(provider));
  }

  /** The operator's request, checked now and again by `still()` after any awaited work. */
  async function operator(req, res) {
    const login = req.method === 'GET' ? await user(req) : await protectedPost(req);
    const current = () =>
      !!login &&
      logins.get(hash(cookies(req)[COOKIES.session] || '')) === login &&
      validIdentity(login) &&
      (login.expires === null || login.expires > Date.now());
    const still = () => current() && isServerOperator(registry, config, login.userId);
    if (!current()) {
      json(res, req.method === 'GET' ? 401 : 403, { error: 'Sign in to manage media sources' });
      return undefined;
    }
    if (!still()) {
      json(res, 403, { error: 'Server operator required' });
      return undefined;
    }
    // Checked again just before the file is replaced, as for the other saved settings.
    const canSave = () =>
      still() &&
      req.headers.origin === config.publicUrl &&
      req.headers['x-csrf-token'] === login.csrf &&
      (!login.oauth || login.oauth.expires > Date.now());
    return { login, still, canSave };
  }
  async function answer(req, res, act) {
    const auth = await operator(req, res);
    if (!auth) return;
    try {
      if (!editor) return json(res, 503, { error: 'Saved settings are unavailable' });
      const data = req.method === 'POST' ? await body(req, 32768) : {};
      await registry.flush();
      if (!auth.still()) return json(res, 403, { error: 'Operator authorization changed; nothing was changed' });
      const result = await act(data, auth);
      if (!auth.still()) return json(res, 403, { error: 'Operator authorization changed' });
      json(res, 200, result);
    } catch (error) {
      if (error.code === 'CONFIG_CONFLICT')
        return json(res, 409, { code: 'CONFIG_CONFLICT', error: 'Saved configuration changed; read it again' });
      if (error.code === 'CONFIG_AUTHORIZATION')
        return json(res, 403, { error: 'Operator authorization changed; nothing was saved' });
      if (error.code === 'SOURCE_MISSING') return json(res, 404, { error: error.message });
      if (error.code === 'SOURCE_INVALID')
        return json(res, 400, { error: 'Not saved: ' + (error.reason || 'the configuration would not be valid') });
      if (error.expose) return json(res, error.status || 400, { error: error.message });
      json(res, error instanceof SyntaxError ? 400 : 503, { error: 'Media source request failed; try again' });
    }
  }

  /** Saved entries, and which differ from what this process runs (they wait for a restart). */
  async function saved() {
    const saved = await editor.readSources();
    const running = new Map((config.sources || []).map(entry => [entry.id, JSON.stringify(entry)]));
    return { ...saved, running };
  }
  async function list() {
    const state = await saved();
    const { revision, sources, running } = state;
    const ids = new Set(sources.map(entry => entry.id));
    return {
      revision,
      sources: sources.map(entry => ({
        ...flowsCore.describe(entry),
        // Saved but not yet what the server runs: it applies after a restart.
        pending: running.get(entry.id) !== JSON.stringify(entry),
        ...(removalAffectsOperator(entry, state) ? { operatorSignInRisk: true } : {}),
      })),
      // Running sources that are no longer saved: they go at the next restart.
      removed: (config.sources || [])
        .filter(entry => !ids.has(entry.id))
        .map(entry => ({ id: entry.id, type: entry.type, name: entry.name || '' })),
      types: flowsCore.addableTypes(),
    };
  }
  /** A saved source's status and its server's libraries, each marked offered or not. */
  async function details(id) {
    const { sources } = await saved();
    const entry = sources.find(source => source.id === id);
    if (!entry) throw fail('That source is no longer saved; read the list again', 404);
    return flowsCore.details(entry, tools);
  }
  async function change(data, auth) {
    const { revision, action } = data;
    let request, transform, operatorSignInRisk;
    if (action === 'update' || action === 'remove') {
      const saved = await editor.readSources();
      const { sources } = saved;
      const entry = sources.find(source => source.id === data.id);
      if (!entry) throw fail('That source is no longer saved; read the list again', 404);
      if (action === 'remove') {
        request = { action, id: entry.id };
        operatorSignInRisk = removalAffectsOperator(entry, saved);
      } else {
        request = { action, id: entry.id, ...flowsCore.updateRequest(entry, data) };
        // A type's own settings (folders: its libraries and their folders), checked by its module and
        // applied to the entry as written, so whatever it leaves alone stays as it was.
        if (data.settings !== undefined) {
          const module = sourceType(entry.type);
          if (!module.setup.update) throw fail('This source has no other settings to change');
          transform = await module.setup.update(data.settings, {
            base: path.dirname(config.configFile || path.resolve('config.yaml')),
            ...tools,
            current: entry,
            existing: sources.filter(source => source.type === entry.type && source.id !== entry.id),
          });
        }
      }
    } else if (action === 'add') {
      const { sources } = await editor.readSources();
      request = {
        action,
        entry: flows.entry(auth.login.userId, data, sources, pinned),
        ...(data.allowMembers === true ? { allowMembers: true } : {}),
      };
    } else throw fail('Choose add, update or remove');
    const result = await editor.saveSources(
      { revision, change: request },
      {
        beforeReplace: auth.canSave,
        transform,
        preserveBackup: !!operatorSignInRisk,
      },
    );
    if (action === 'add') flows.close(data.flow);
    try {
      registry.audit(auth.login.userId, 'operator-sources-' + action, { source: request.id || request.entry.id });
      await registry.flush();
    } catch {
      /* The file is saved; the audit line is best effort, as for other settings. */
    }
    return {
      ok: true,
      restartRequired: true,
      revision: result.revision,
      ...(await list()),
      ...(operatorSignInRisk ? { recoveryBackup: result.backupPath } : {}),
    };
  }

  /** @type {import('./http/router').Route[]} */
  const routes = [
    {
      name: 'operator sources',
      methods: ['GET', 'POST'],
      path: '/api/operator/sources',
      handle: ({ req, res }) => answer(req, res, (data, auth) => (req.method === 'GET' ? list() : change(data, auth))),
    },
    {
      name: 'operator source details',
      methods: ['GET'],
      path: '/api/operator/sources/details',
      handle: ({ req, res, url }) => answer(req, res, () => details(url.searchParams.get('id') || '')),
    },
    {
      name: 'operator source setup',
      methods: ['POST'],
      path: '/api/operator/sources/setup',
      // One flow per operator at a time: a new one ends the last.
      handle: ({ req, res }) => answer(req, res, (data, auth) => flows.open(auth.login.userId, data.type)),
    },
    {
      name: 'operator source setup step',
      methods: ['POST'],
      path: '/api/operator/sources/setup/step',
      handle: ({ req, res }) =>
        answer(req, res, (data, auth) => flows.step(auth.login.userId, data, auth.still).catch(rename)),
    },
  ];
  return { routes, sweep: flows.sweep, close: flows.closeAll };
}

/** The operator wording for a flow that ended because authorization changed. */
function rename(error) {
  if (error?.status === 403 && error.expose) error.message = 'Operator authorization changed';
  throw error;
}

module.exports = { sourceSettings };
