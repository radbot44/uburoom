'use strict';
// @ts-check
/**
 * Server settings → Sources: the operator lists, edits, adds and removes media sources. Changes are
 * written to `sources:` in config.yaml (server/config-editor.js) and apply after a restart (S8).
 *
 * Nothing here knows a source type: each module's `check` and `libraries` describe a saved source,
 * and its `setup` drives adding one (`steps`, each given a flow held here; `entry`, the settings to
 * save; `summary`, what the panel may show). Tokens, API keys and passwords stay in flows and in the
 * file: no answer carries them. Every request is the operator's, checked again after awaited work.
 */
const { randomBytes } = require('node:crypto');
const { hash } = require('./core');
const { isServerOperator } = require('./operator-policy');
const { sourceType, TYPES } = require('./sources');

const FLOW_MS = 20 * 60000,
  MAX_FLOWS = 20;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const STEP = /^[a-zA-Z]{1,32}$/;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** A source's name as the owner typed it: trimmed, up to 60 characters, no control characters. */
function sourceName(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 200 || CONTROL.test(value)) throw fail('Use a shorter name');
  const name = value.trim();
  if (name.length > 60) throw fail('Use a name of up to 60 characters');
  return name;
}

/** The worst of a module's checks, as one status line. */
function summarize(checks) {
  const rank = { fail: 2, warn: 1, pass: 0 };
  const worst = checks.reduce((a, b) => ((rank[b.status] ?? 1) > (rank[a?.status] ?? -1) ? b : a), undefined);
  return worst
    ? { status: worst.status, message: String(worst.message || '').slice(0, 300) }
    : { status: 'pass', message: 'Ready' };
}

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
  jellyfinDiscover,
  plexTv,
  platform,
}) {
  const { json, body, cookies, logins, user, protectedPost, validIdentity } = sessions;
  const tools = { plexFetch: plexFetch || fetch, jellyfinFetch: jellyfinFetch || fetch };
  // `config.publicUrl` is read when a step runs: a test server learns its port after startup.
  const stepServices = {
    ...tools,
    plexTv,
    platform: platform || process.platform,
    ...(jellyfinDiscover ? { discover: jellyfinDiscover } : {}),
    get publicUrl() {
      return config.publicUrl;
    },
  };
  /** @type {Map<string, {userId: string, type: string, expires: number, state: any}>} */
  const flows = new Map();

  function closeFlow(id) {
    const flow = flows.get(id);
    if (!flow) return;
    flows.delete(id);
    try {
      sourceType(flow.type).setup.close?.(flow.state);
    } catch {
      /* Nothing more to end. */
    }
  }
  function sweep() {
    for (const [id, flow] of flows) if (flow.expires <= Date.now()) closeFlow(id);
  }

  /** The operator's request, checked now and again by `still()` after any awaited work. */
  async function operator(req, res) {
    const login = req.method === 'GET' ? await user(req) : await protectedPost(req);
    const current = () =>
      !!login &&
      logins.get(hash(cookies(req).uburoom || '')) === login &&
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
    const { revision, sources } = await editor.readSources();
    const running = new Map((config.sources || []).map(entry => [entry.id, JSON.stringify(entry)]));
    return { revision, sources, running };
  }
  function describe(entry, running) {
    const setup = sourceType(entry.type).setup;
    return {
      id: entry.id,
      type: entry.type,
      name: entry.name || '',
      ...setup.summary(entry),
      selectLibraries: !!setup.selectLibraries,
      // Saved but not yet what the server runs: it applies after a restart.
      pending: running.get(entry.id) !== JSON.stringify(entry),
    };
  }
  async function list() {
    const { revision, sources, running } = await saved();
    const ids = new Set(sources.map(entry => entry.id));
    return {
      revision,
      sources: sources.map(entry => describe(entry, running)),
      // Running sources that are no longer saved: they go at the next restart.
      removed: (config.sources || [])
        .filter(entry => !ids.has(entry.id))
        .map(entry => ({ id: entry.id, type: entry.type, name: entry.name || '' })),
      types: Object.keys(TYPES).filter(type => TYPES[type].setup),
    };
  }
  /** A saved source's status and its server's libraries, each marked offered or not. */
  async function details(id) {
    const { sources } = await saved();
    const entry = sources.find(source => source.id === id);
    if (!entry) throw fail('That source is no longer saved; read the list again', 404);
    const module = sourceType(entry.type);
    const [status, libraries] = await Promise.all([
      module
        .check(entry, { ...tools, connectionOnly: true })
        .then(summarize)
        .catch(() => ({ status: 'warn', message: 'Could not check this source' })),
      module.libraries(entry, tools).then(
        listed => listed,
        () => undefined,
      ),
    ]);
    const offered = entry.libraries === null || entry.libraries === undefined ? null : new Set(entry.libraries);
    return {
      status,
      ...(libraries
        ? {
            libraries: libraries.map(library => ({
              ...library,
              offered: !module.setup.selectLibraries || !offered || offered.has(library.id),
            })),
          }
        : { librariesError: 'Couldn’t read this server’s libraries; check that it is running' }),
    };
  }
  /** A new id for a source: from its name, unused, and never one pinned to a different server. */
  function newId(name, type, sources, identity) {
    const base =
      String(name || type)
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || type;
    const taken = id => {
      if (sources.some(source => source.id === id)) return true;
      const pinned = registry?.meta?.('source:' + id + ':identity');
      return !!pinned && identity !== undefined && pinned !== identity;
    };
    let id = base;
    for (let n = 2; taken(id) || !ID.test(id); n++) id = base + '-' + n;
    return id;
  }
  function offeredList(value, allowed) {
    if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string'))
      throw fail('Choose the libraries to offer');
    const ids = [...new Set(value)];
    if (allowed && ids.some(id => !allowed.has(id))) throw fail('A chosen library is not on this server');
    return ids;
  }
  async function change(data, auth) {
    const { revision, action } = data;
    let request;
    if (action === 'update' || action === 'remove') {
      const { sources } = await editor.readSources();
      const entry = sources.find(source => source.id === data.id);
      if (!entry) throw fail('That source is no longer saved; read the list again', 404);
      if (action === 'remove') request = { action, id: entry.id };
      else {
        const module = sourceType(entry.type);
        const libraries =
          data.libraries === undefined
            ? undefined
            : module.setup.selectLibraries
              ? offeredList(data.libraries)
              : (() => {
                  throw fail('This source’s libraries are its folders');
                })();
        request = { action, id: entry.id, name: sourceName(data.name), libraries };
      }
    } else if (action === 'add') {
      const flow = typeof data.flow === 'string' ? flows.get(data.flow) : undefined;
      if (!flow || flow.userId !== auth.login.userId || flow.expires <= Date.now() || !flow.state.draft)
        throw fail('Start adding the source again');
      const module = sourceType(flow.type);
      const { sources } = await editor.readSources();
      const draft = flow.state.draft;
      const name = sourceName(data.name) || draft.name || '';
      const libraries = module.setup.selectLibraries
        ? offeredList(data.libraries, new Set(draft.libraries.map(library => library.id)))
        : undefined;
      const id = newId(name, flow.type, sources, draft.identity);
      const settings = module.setup.entry(draft, {
        id,
        name,
        libraries,
        existing: sources.filter(source => source.type === flow.type),
      });
      request = { action, entry: { id, type: flow.type, ...(name ? { name } : {}), ...settings } };
    } else throw fail('Choose add, update or remove');
    const result = await editor.saveSources({ revision, change: request }, { beforeReplace: auth.canSave });
    if (action === 'add') closeFlow(data.flow);
    try {
      registry.audit(auth.login.userId, 'operator-sources-' + action, { source: request.id || request.entry.id });
      await registry.flush();
    } catch {
      /* The file is saved; the audit line is best effort, as for other settings. */
    }
    return { ok: true, restartRequired: true, revision: result.revision, ...(await list()) };
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
      handle: ({ req, res }) =>
        answer(req, res, (data, auth) => {
          if (typeof data.type !== 'string' || !TYPES[data.type]?.setup)
            throw fail('Choose Plex, Jellyfin or a folder');
          sweep();
          // One flow per operator at a time: a new one ends the last.
          for (const [id, flow] of flows) if (flow.userId === auth.login.userId) closeFlow(id);
          if (flows.size >= MAX_FLOWS) throw fail('Too many sources are being added; try again shortly', 429);
          const id = randomBytes(18).toString('base64url');
          flows.set(id, { userId: auth.login.userId, type: data.type, expires: Date.now() + FLOW_MS, state: {} });
          return { flow: id };
        }),
    },
    {
      name: 'operator source setup step',
      methods: ['POST'],
      path: '/api/operator/sources/setup/step',
      handle: ({ req, res }) =>
        answer(req, res, async (data, auth) => {
          const flow = typeof data.flow === 'string' ? flows.get(data.flow) : undefined;
          if (!flow || flow.userId !== auth.login.userId || flow.expires <= Date.now())
            throw fail('Start adding the source again', 410);
          const steps = sourceType(flow.type).setup.steps;
          if (typeof data.step !== 'string' || !STEP.test(data.step) || !Object.hasOwn(steps, data.step))
            throw fail('Unknown step');
          const { flow: _flow, step: _step, ...input } = data;
          const reply = await steps[data.step](flow.state, input, stepServices);
          if (!auth.still()) {
            closeFlow(data.flow);
            throw fail('Operator authorization changed', 403);
          }
          return { ...reply, ready: !!flow.state.draft };
        }),
    },
  ];
  return { routes, sweep, close: () => [...flows.keys()].forEach(closeFlow) };
}

module.exports = { sourceSettings, sourceName };
