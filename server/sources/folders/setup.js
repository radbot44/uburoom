'use strict';
// @ts-check
// Adding a folders source in Server settings: a browser of the directories on this machine (in
// Docker, the container's mounted paths), then a name and Movies or Shows. Operator only, through
// server/source-settings.js; it lists directory names and nothing inside files.
const fs = require('node:fs/promises');
const path = require('node:path');

const { constants: fsConstants } = require('node:fs');

const MAX_FOLDERS = 500,
  MAX_LIBRARIES = 32,
  MAX_PATHS = 16;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });

/** Windows drive roots that exist, for the top of the browser. */
async function drives() {
  const found = [];
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZAB') {
    const root = letter + ':\\';
    try {
      await fs.access(root);
      found.push({ name: root, path: root });
    } catch {
      /* No such drive. */
    }
  }
  return found;
}

/** A folder the owner named: absolute, and a readable directory. */
async function folder(value, platform) {
  if (typeof value !== 'string' || !value || value.length > 1000 || /[\u0000-\u001f]/.test(value))
    throw fail('Choose a folder');
  const resolved = (platform === 'win32' ? path.win32 : path.posix).resolve(value);
  if (!(platform === 'win32' ? path.win32 : path.posix).isAbsolute(value)) throw fail('Choose a folder');
  let stat;
  try {
    stat = await fs.stat(resolved);
  } catch {
    throw fail('That folder can’t be opened', 404);
  }
  if (!stat.isDirectory()) throw fail('Choose a folder', 400);
  try {
    await fs.access(resolved, fsConstants.R_OK);
  } catch {
    throw fail('uburoom can’t read that folder', 403);
  }
  return resolved;
}

/** A library id from a name: lowercase letters, digits and hyphens, starting with a letter, not in `taken`. */
function libraryId(name, taken) {
  const base =
    String(name)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'folder';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = base + '-' + n;
  return id;
}

/**
 * Editing a saved folders source's libraries from Server settings. `input.libraries` is the whole list
 * wanted, in order: each `{id?, name, type, paths}`, where an `id` names a library already saved and
 * none adds one. Every folder that may be new is checked here (absolute, a readable directory); the
 * result is a function the config editor runs on the entry exactly as config.yaml holds it, so a
 * library's id, and each folder already written (relative or not), are kept as they are. A library's
 * type may change: videos are recorded under the library id and their place inside its folders,
 * whatever the type, so queues and resume positions are unaffected.
 * @param {any} input
 * @param {{base: string, platform?: string, existing?: any[]}} context - `existing`: the other folders
 *   sources, whose library ids a new one must not repeat
 */
async function update(input, { base, platform = process.platform, existing = [] }) {
  const wanted = input?.libraries;
  if (!Array.isArray(wanted) || !wanted.length) throw fail('Keep at least one library');
  if (wanted.length > MAX_LIBRARIES) throw fail(`Use up to ${MAX_LIBRARIES} libraries`);
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const key = value => {
    const resolved = paths.resolve(base, value);
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const libraries = wanted.map(library => {
    if (!library || typeof library !== 'object' || Array.isArray(library)) throw fail('Choose a library');
    if (library.id !== undefined && typeof library.id !== 'string') throw fail('Choose a library');
    const name = typeof library.name === 'string' ? library.name.trim() : '';
    if (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(name))
      throw fail('Give each library a name of up to 100 characters');
    if (!['movies', 'shows'].includes(library.type)) throw fail('Choose Movies or Shows for ' + name);
    if (!Array.isArray(library.paths) || !library.paths.length) throw fail('Keep at least one folder in ' + name);
    if (library.paths.length > MAX_PATHS) throw fail(`Use up to ${MAX_PATHS} folders in ${name}`);
    const seen = new Set(),
      folders = [];
    for (const value of library.paths) {
      if (typeof value !== 'string' || !value || value.length > 1000) throw fail('Choose a folder');
      if (seen.has(key(value))) continue;
      seen.add(key(value));
      folders.push(value);
    }
    return { id: library.id, name, type: library.type, paths: folders };
  });
  /** @type {Map<string, true | Error>} */
  const checked = new Map();
  await Promise.all(
    [...new Set(libraries.flatMap(library => library.paths))].map(async value => {
      try {
        await folder(value, platform);
        checked.set(key(value), true);
      } catch (error) {
        checked.set(key(value), error);
      }
    }),
  );
  return raw => {
    const before = Array.isArray(raw.libraries) ? raw.libraries : [];
    // Ids stay unique across every folders source, and a removed library's id is never given to a new one.
    const taken = new Set([
      ...existing.flatMap(source => source.libraries.map(library => library.id)),
      ...before.map(library => library?.id),
    ]);
    return {
      ...raw,
      libraries: libraries.map(library => {
        const saved = library.id === undefined ? undefined : before.find(old => old?.id === library.id);
        if (library.id !== undefined && !saved) throw fail('That library is no longer saved; read the source again');
        const written = new Map((saved?.paths || []).map(value => [key(value), value]));
        const folders = library.paths.map(value => {
          if (written.has(key(value))) return written.get(key(value));
          const result = checked.get(key(value));
          if (result !== true) throw result || fail('Choose a folder');
          return paths.resolve(value);
        });
        if (saved)
          return {
            ...saved,
            name: library.name,
            paths: folders,
            // A type left out means movies; it stays left out unless it changes.
            ...((saved.type ?? 'movies') === library.type ? {} : { type: library.type }),
          };
        const id = libraryId(library.name, taken);
        taken.add(id);
        return { id, name: library.name, paths: folders, type: library.type };
      }),
    };
  };
}

const steps = {
  /** The directories inside one, sorted by name; with none named, the drives (Windows) or `/`. */
  async browse(flow, data, { platform = process.platform } = {}) {
    if (data.path === undefined || data.path === '') {
      if (platform === 'win32') return { path: '', parent: null, folders: await drives() };
      data = { path: '/' };
    }
    const at = await folder(data.path, platform);
    let entries;
    try {
      entries = await fs.readdir(at, { withFileTypes: true });
    } catch {
      throw fail('That folder can’t be opened', 404);
    }
    const folders = entries
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && !entry.name.startsWith('$'))
      .map(entry => ({ name: entry.name, path: path.join(at, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, MAX_FOLDERS);
    const up = path.dirname(at);
    return { path: at, parent: up !== at ? up : platform === 'win32' ? '' : null, folders };
  },
  /** The folder to add and what it holds; the flow is then ready to be added. */
  async choose(flow, data, { platform = process.platform } = {}) {
    const at = await folder(data.path, platform);
    if (!['movies', 'shows'].includes(data.type)) throw fail('Choose Movies or Shows');
    const name = path.basename(at) || at;
    flow.draft = { entry: { path: at, type: data.type }, name, libraries: [] };
    return { name, path: at };
  },
};

/**
 * The entry's settings: one library holding the folder, its id unique among every folders source's
 * libraries (they share one picture folder) and kept with the source, so history returns with it.
 */
function entry(draft, { id, name, existing }) {
  const taken = new Set(existing.flatMap(source => source.libraries.map(library => library.id)));
  const library = libraryId(id, taken);
  return { libraries: [{ id: library, name, paths: [draft.entry.path], type: draft.entry.type }] };
}

/**
 * What Server settings may show of a saved entry: its folders, and each library with its folders for
 * editing. Every library is offered.
 */
function summary(saved) {
  return {
    address: saved.libraries.flatMap(library => library.paths).join('; '),
    offered: null,
    folders: saved.libraries.map(library => ({
      id: library.id,
      name: library.name,
      type: library.type,
      paths: library.paths,
    })),
  };
}

module.exports = { steps, entry, update, summary, selectLibraries: false };
