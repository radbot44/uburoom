'use strict';
// @ts-check
/**
 * The media sources this server is configured with: one module per source type, each
 * exporting the same contract, and the one place that maps a config entry's `type` to it.
 * Nothing outside a source module reads a source's settings or checks its type.
 *
 * A source module exports:
 * - `validate(entry, context)`: checks one raw `sources:` entry (its `id`, `type` and `name`
 *   already checked here) and returns the normalized entry its other functions take.
 * - `create(entry, services)`: the source as a `MediaProvider` (server/media-providers.js).
 * - `check(entry, services)`: a connection and credential test for the doctor, as doctor checks.
 * - optionally `signIn(entries, services)`: the sign-in method this type offers, built once from
 *   every entry of the type (Plex today).
 * - optionally `connect`: guided-setup services for the wizard and Server settings (Jellyfin today).
 * A created provider may also offer `members(identity)`: is this verified identity a user of this server?
 * It resolves true, or throws an error flagged `noServerAccess` or `revoked`; any other error means no
 * answer (an outage), never a denial (Jellyfin today; Plex answers through its `signIn`).
 *
 * @typedef {{id: string, type: string, name: string, [key: string]: any}} SourceEntry
 * @typedef {{base: string, platform: string, dataDirectory: string}} ValidateContext
 */

/** @type {Record<string, any>} */
const TYPES = {
  plex: require('./plex'),
  jellyfin: require('./jellyfin'),
  folders: require('./folders'),
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The module for a source type. */
function sourceType(type) {
  const module = Object.hasOwn(TYPES, type) ? TYPES[type] : undefined;
  if (!module) throw new Error('Unknown source type');
  return module;
}

/**
 * Checks the whole `sources:` list and returns the normalized entries, in config order.
 * @param {unknown} list
 * @param {ValidateContext} context
 * @returns {SourceEntry[]}
 */
function validateSources(
  list,
  context = { base: process.cwd(), platform: process.platform, dataDirectory: require('node:path').resolve('data') },
) {
  if (list === undefined) return [];
  if (!Array.isArray(list) || list.length > 32) throw new Error('sources must be a list of up to 32 media sources');
  const entries = list.map((raw, index) => {
    const where = 'sources[' + index + ']';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(where + ' must be a mapping');
    if (typeof raw.id !== 'string' || !ID.test(raw.id))
      throw new Error(
        where + '.id must be a quoted id of letters, digits, dots, hyphens or underscores (up to 64), never reused',
      );
    if (typeof raw.type !== 'string' || !Object.hasOwn(TYPES, raw.type))
      throw new Error('sources ' + raw.id + ': type must be one of ' + Object.keys(TYPES).join(', '));
    if (raw.name !== undefined && (typeof raw.name !== 'string' || raw.name.length > 60 || CONTROL.test(raw.name)))
      throw new Error('sources ' + raw.id + ': name must be quoted text of up to 60 characters');
    const { id, type, name, ...settings } = raw;
    const entry = sourceType(type).validate(settings, { ...context, id });
    return { ...entry, id, type, name: (name || '').trim() };
  });
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) throw new Error('sources must not repeat an id');
  for (const module of new Set(Object.values(TYPES)))
    module.validateAll?.(entries.filter(entry => TYPES[entry.type] === module));
  return entries;
}

/**
 * The server identity a source pinned the first time it answered, remembered per source id,
 * so a different server behind the same address is refused rather than mistaken for this one.
 * @param {any} registry
 * @param {SourceEntry} entry
 */
function sourcePin(registry, entry) {
  const key = 'source:' + entry.id + ':identity';
  return {
    get: () => registry?.meta(key) || undefined,
    async set(identity) {
      if (!registry) return;
      registry.meta(key, identity);
      await registry.flush?.();
    },
  };
}

/**
 * Every configured source as a `MediaProvider`, in config order, plus the sign-in
 * methods source types offer.
 * @param {SourceEntry[]} entries
 * @param {any} services
 */
function createSources(entries, services) {
  const providers = entries.map(entry => {
    const provider = sourceType(entry.type).create(entry, { ...services, pin: sourcePin(services.registry, entry) });
    return Object.assign(provider, { id: entry.id, type: entry.type, label: entry.name });
  });
  const signIn = {};
  for (const [type, module] of Object.entries(TYPES))
    if (module.signIn)
      signIn[type] = module.signIn(
        providers.filter(provider => provider.type === type),
        services,
      );
  return { providers, signIn };
}

/**
 * The doctor's checks for every source: each module's own, labelled with the source.
 * @param {SourceEntry[]} entries
 * @param {any} [services]
 */
async function checkSources(entries, services = {}) {
  const checks = [];
  for (const entry of entries)
    for (const check of await sourceType(entry.type).check(entry, services))
      checks.push({ ...check, name: check.name + ' (' + entry.id + ')' });
  return checks;
}

/** Whether any source can name the account its own credential belongs to (for single-room leadership). */
function ownerAccountSources(entries) {
  return entries.filter(entry => sourceType(entry.type).ownerAccount);
}

module.exports = { validateSources, createSources, checkSources, sourcePin, sourceType, ownerAccountSources, TYPES };
