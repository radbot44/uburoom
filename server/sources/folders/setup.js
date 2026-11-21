'use strict';
// @ts-check
// Adding a folders source in Server settings: a browser of the directories on this machine (in
// Docker, the container's mounted paths), then a name and Movies or Shows. Operator only, through
// server/source-settings.js; it lists directory names and nothing inside files.
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_FOLDERS = 500;
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
  return resolved;
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
  const base =
    String(id)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^[^a-z]+/, '')
      .slice(0, 24)
      .replace(/-+$/, '') || 'folder';
  let library = base;
  for (let n = 2; taken.has(library); n++) library = base + '-' + n;
  return { libraries: [{ id: library, name, paths: [draft.entry.path], type: draft.entry.type }] };
}

/** What Server settings may show of a saved entry: its folders. Every library is offered. */
function summary(saved) {
  return { address: saved.libraries.flatMap(library => library.paths).join('; '), offered: null };
}

module.exports = { steps, entry, summary, selectLibraries: false };
