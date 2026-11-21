'use strict';
// @ts-check
/**
 * Adding, describing and editing media sources, shared by Server settings → Sources
 * (server/source-settings.js, which saves to config.yaml) and the first-run setup wizard
 * (server/setup/, which keeps a draft list until the first config is written).
 *
 * Nothing here knows a source type: each module's `setup` drives adding one (`steps`, each given a
 * flow held here; `entry`, the settings to save; `summary`, what may be shown), and its `check` and
 * `libraries` describe a saved one. Tokens, API keys and passwords stay in flows and entries on the
 * server: no answer built here carries them.
 */
const { randomBytes } = require('node:crypto');
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

/** The types a source can be added as. */
const addableTypes = () => Object.keys(TYPES).filter(type => TYPES[type].setup);

/**
 * What may be shown of a source entry (normalized): never a secret.
 * @param {any} entry
 */
function describe(entry) {
  const setup = sourceType(entry.type).setup;
  return {
    id: entry.id,
    type: entry.type,
    name: entry.name || '',
    ...setup.summary(entry),
    selectLibraries: !!setup.selectLibraries,
  };
}

/**
 * A source's status and its server's libraries, each marked offered or not.
 * @param {any} entry - normalized
 * @param {{plexFetch: typeof fetch, jellyfinFetch: typeof fetch}} tools
 */
async function details(entry, tools) {
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

/** The libraries an owner chose to offer: ids, each on the server when `allowed` is given. */
function offeredList(value, allowed) {
  if (!Array.isArray(value) || value.length > 500 || value.some(id => typeof id !== 'string'))
    throw fail('Choose the libraries to offer');
  const ids = [...new Set(value)];
  if (allowed && ids.some(id => !allowed.has(id))) throw fail('A chosen library is not on this server');
  return ids;
}

/**
 * A new id for a source: from its name, unused, and never one `pinned` says belongs to another server.
 * @param {string} name
 * @param {string} type
 * @param {{id: string}[]} sources
 * @param {string|undefined} identity
 * @param {(id: string) => string|undefined} [pinned]
 */
function newId(name, type, sources, identity, pinned = () => undefined) {
  const base =
    String(name || type)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || type;
  const taken = id => {
    if (sources.some(source => source.id === id)) return true;
    const pin = pinned(id);
    return !!pin && identity !== undefined && pin !== identity;
  };
  let id = base;
  for (let n = 2; taken(id) || !ID.test(id); n++) id = base + '-' + n;
  return id;
}

/**
 * The changes an update asks for: a name, and the libraries offered (for types that choose them).
 * @param {any} entry - the saved entry
 * @param {any} data - what the browser sent
 */
function updateRequest(entry, data) {
  const module = sourceType(entry.type);
  const libraries =
    data.libraries === undefined
      ? undefined
      : module.setup.selectLibraries
        ? offeredList(data.libraries)
        : (() => {
            throw fail('This source’s libraries are its folders');
          })();
  return { name: sourceName(data.name), libraries };
}

/**
 * Add flows: one per owner at a time, each holding a source type's setup state on the server.
 * `owner` is whoever started it (the operator's user id, or the setup session).
 * @param {{stepServices: any}} options
 */
function createSourceFlows({ stepServices }) {
  /** @type {Map<string, {owner: string, type: string, expires: number, state: any}>} */
  const flows = new Map();

  function close(id) {
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
    for (const [id, flow] of flows) if (flow.expires <= Date.now()) close(id);
  }
  /** A flow this owner may use, or undefined. */
  function owned(id, owner) {
    const flow = typeof id === 'string' ? flows.get(id) : undefined;
    return flow && flow.owner === owner && flow.expires > Date.now() ? flow : undefined;
  }
  return {
    sweep,
    close,
    closeAll: () => [...flows.keys()].forEach(close),
    /** Starts adding a source of `type`; a new flow ends the owner's last one. */
    open(owner, type) {
      if (typeof type !== 'string' || !TYPES[type]?.setup) throw fail('Choose Plex, Jellyfin, a folder or YouTube');
      sweep();
      for (const [id, flow] of flows) if (flow.owner === owner) close(id);
      if (flows.size >= MAX_FLOWS) throw fail('Too many sources are being added; try again shortly', 429);
      const id = randomBytes(18).toString('base64url');
      flows.set(id, { owner, type, expires: Date.now() + FLOW_MS, state: {} });
      return { flow: id };
    },
    /**
     * Runs one of the type's steps. `still` is checked after the awaited step; when it no longer
     * holds, the flow ends and nothing is answered.
     */
    async step(owner, data, still = () => true) {
      const flow = owned(data.flow, owner);
      if (!flow) throw fail('Start adding the source again', 410);
      const steps = sourceType(flow.type).setup.steps;
      if (typeof data.step !== 'string' || !STEP.test(data.step) || !Object.hasOwn(steps, data.step))
        throw fail('Unknown step');
      const { flow: _flow, step: _step, ...input } = data;
      const reply = await steps[data.step](flow.state, input, stepServices);
      if (!still()) {
        close(data.flow);
        throw fail('Authorization changed', 403);
      }
      return { ...reply, ready: !!flow.state.draft };
    },
    /**
     * The whole raw entry a ready flow adds, with an id unused among `sources`.
     * @param {string} owner
     * @param {any} data - `{flow, name?, libraries?}` from the browser
     * @param {any[]} sources - the entries already there (normalized)
     * @param {(id: string) => string|undefined} [pinned]
     */
    entry(owner, data, sources, pinned) {
      const flow = owned(data.flow, owner);
      if (!flow || !flow.state.draft) throw fail('Start adding the source again');
      const module = sourceType(flow.type);
      const draft = flow.state.draft;
      const name = sourceName(data.name) || draft.name || '';
      const libraries = module.setup.selectLibraries
        ? offeredList(data.libraries, new Set(draft.libraries.map(library => library.id)))
        : undefined;
      const id = newId(name, flow.type, sources, draft.identity, pinned);
      const settings = module.setup.entry(draft, {
        id,
        name,
        libraries,
        existing: sources.filter(source => source.type === flow.type),
      });
      return { id, type: flow.type, ...(name ? { name } : {}), ...settings };
    },
  };
}

module.exports = {
  createSourceFlows,
  sourceName,
  summarize,
  describe,
  details,
  newId,
  offeredList,
  updateRequest,
  addableTypes,
};
