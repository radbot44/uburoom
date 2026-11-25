'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const YAML = require('yaml');
const { configPath, parseConfig, normalizeConfig } = require('./config');
const { runningSettings } = require('./operator-settings');
const { sourceType } = require('./sources');
const { powershell, protectDirectory, protectFile } = require('./local-tls');

// Explicit YAML paths allowed in the saved operator settings dialog.
const EDITABLE = new Set([
  'access.discord_server',
  'access.source_members',
  'access.accounts',
  'access.password',
  'guests.enabled',
  'discord.excluded_guild_ids',
  'directory.expose_discord_members',
  'rooms.max_saved',
  'rooms.max_open',
  'rooms.max_members',
  'rooms.max_people',
  'rooms.recovery_seconds',
  'rooms.max_queue',
  'rooms.host_permissions',
  'rooms.viewer_permissions',
  'transcoding.policy',
  'transcoding.provider',
  'transcoding.uburoom',
  'transcoding.ubuplayer',
  'transcoding.encoder',
  'transcoding.formats',
  'transcoding.max_jobs',
  'transcoding.cpu_fallback',
  'transcoding.qualities',
  'transcoding.allow_original',
]);
// Write-only secrets accepted by save() but never returned by read() or readEditable().
const WRITE_ONLY = new Set(['secrets.server_password']);
const messages = {
  CONFIG_INVALID: 'Invalid proposed configuration; no settings were saved',
  CONFIG_FORBIDDEN: 'Setting is not editable; no settings were saved',
  CONFIG_CONFLICT: 'Configuration changed; read it again before saving',
  CONFIG_AUTHORIZATION: 'Authorization changed; no settings were saved',
  CONFIG_IO: 'Configuration file operation failed; no settings were saved',
  CONFIG_UNSAFE_PATH: 'Configuration must be an existing regular file without symbolic or hard links',
  SOURCE_MISSING: 'That source is no longer in the configuration; read it again',
  SOURCE_INVALID: 'The configuration would not be valid with this change; nothing was saved',
  CONFIG_EXISTS: 'A configuration file already exists there; it was left as it is',
};
class ConfigEditError extends Error {
  constructor(code) {
    super(messages[code]);
    this.name = 'ConfigEditError';
    this.code = code;
  }
}
const failure = code => new ConfigEditError(code);
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = stat =>
  [
    process.platform === 'win32' ? '' : stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeNs,
    stat.ctimeNs,
    stat.mode,
    stat.uid,
    stat.gid,
    stat.nlink,
  ].join(':');

function editableSettings(config) {
  const values = {
    'access.discord_server': !!config.accessPolicy.discordServer,
    'access.source_members': config.accessPolicy.sourceMembers.slice(),
    'access.accounts': !!config.accessPolicy.accounts,
    'access.password': !!config.accessPolicy.password,
    'guests.enabled': !!config.guests.enabled,
    'discord.excluded_guild_ids': config.discordExcludedGuildIds,
    'directory.expose_discord_members': config.directory.discord,
    'rooms.host_permissions': Object.keys(config.roomPermissions.host).filter(key => config.roomPermissions.host[key]),
    'rooms.viewer_permissions': Object.keys(config.roomPermissions.viewer).filter(
      key => config.roomPermissions.viewer[key],
    ),
    'transcoding.policy': config.transcoding.policy,
    'transcoding.provider': config.transcoding.provider,
    'transcoding.uburoom': config.transcoding.uburoom,
    'transcoding.ubuplayer':
      config.ubuplayer !== undefined ? !!config.ubuplayer : config.transcoding.ubuplayer !== false,
    'transcoding.encoder': config.transcoding.encoder,
    'transcoding.formats': config.transcoding.formats.slice(),
    'transcoding.max_jobs': config.transcoding.maxJobs,
    'transcoding.cpu_fallback': config.transcoding.cpuFallback,
    'transcoding.qualities': config.transcoding.qualities
      .filter(quality => quality.id !== 'direct')
      .map(quality => [quality.height, quality.bitrate / 1000]),
    'transcoding.allow_original': config.transcoding.qualities.some(quality => quality.id === 'direct'),
  };
  const limits = require('./room-limits').SETTINGS;
  return Object.fromEntries(
    [...EDITABLE].map(key => [
      key,
      key.startsWith('rooms.') && limits[key.slice(6)] ? config.roomLimits[limits[key.slice(6)]] : values[key],
    ]),
  );
}

/** Non-secret context for the Access tab: member-capable sources, Discord readiness, and operator sign-in coverage. */
function accessContext(config, { verifiedIdentities, pinnedSourceId } = {}) {
  const sources = (config.sources || [])
    .filter(entry => !!sourceType(entry.type)?.memberIdentity)
    .map(entry => ({
      id: entry.id,
      type: entry.type,
      name: entry.name || entry.id,
    }));
  const context = {
    discordConfigured: !!(config.botToken && config.clientId && config.clientSecret),
    publicWeb: !!config.accessPolicy.publicWeb,
    sources,
  };
  if (Array.isArray(verifiedIdentities)) {
    const operators = config.serverOperator?.identities || [];
    const matching = verifiedIdentities.filter(
      identity =>
        identity.verified === 1 &&
        operators.some(op => op.provider === identity.provider && op.subject === identity.subject),
    );
    const scopedSources = sources.filter(s => typeof sourceType(s.type)?.scopedIdentityProvider === 'function');
    const scopedSourceIds = new Set();
    for (const identity of matching) {
      for (const source of scopedSources) {
        const mod = sourceType(source.type);
        const pinned = pinnedSourceId?.(source.id);
        if (mod.ownsIdentityProvider?.(identity.provider, pinned)) scopedSourceIds.add(source.id);
      }
    }
    context.operatorSignIn = {
      discord: matching.some(identity => identity.provider === 'discord'),
      plex: matching.some(identity => identity.provider === 'plex'),
      accounts: matching.some(identity => identity.provider === 'uburoom'),
      jellyfinSourceIds: [...scopedSourceIds],
    };
  }
  return context;
}

// One process-wide queue, including separate editor instances and path aliases.
let writes = Promise.resolve();
function serialize(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

async function security(file) {
  if (process.platform !== 'win32') return '';
  return powershell(
    '[System.IO.File]::GetAccessControl($env:UBUROOM_EDIT_FILE).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group)',
    { UBUROOM_EDIT_FILE: file },
  );
}

async function snapshot(file) {
  const initial = await fs.lstat(file, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n) throw failure('CONFIG_UNSAFE_PATH');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const acl = await security(file);
    if (metadata(initial) !== metadata(stat) || metadata(stat) !== metadata(await fs.lstat(file, { bigint: true })))
      throw failure('CONFIG_CONFLICT');
    return { bytes, stat, acl, revision: revision(bytes) };
  } finally {
    await handle.close();
  }
}
function validate(bytes, file) {
  try {
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw failure('CONFIG_INVALID');
    // Validation needs no PATH discovery, state files or provider contact.
    return normalizeConfig(parseConfig(source), { base: path.dirname(file), discoverTools: false });
  } catch {
    throw failure('CONFIG_INVALID');
  }
}
// The dialog's provider and codec fields edit the one ordered outputs list.
function outputChanges(changes, transcoding) {
  const {
    'transcoding.provider': provider = transcoding.provider,
    'transcoding.uburoom': uburoom = transcoding.uburoom,
    'transcoding.formats': formats = transcoding.formats,
    ...rest
  } = changes;
  if (Object.keys(rest).length === Object.keys(changes).length) return changes;
  const local = uburoom ? (formats.length ? formats : ['av1']) : [];
  const kept = transcoding.outputs.filter(output => (output === 'provider' ? provider : local.includes(output)));
  const added = [
    ...local.filter(output => !kept.includes(output)),
    ...(provider && !kept.includes('provider') ? ['provider'] : []),
  ];
  return { ...rest, 'transcoding.outputs': [...kept, ...added] };
}
function serializeYaml(doc, source = '', options = {}) {
  let next = doc.toString({ lineWidth: 0, ...options });
  if (source.startsWith('\uFEFF')) next = '\uFEFF' + next;
  if (source.includes('\r\n')) next = next.replace(/\r?\n/g, '\r\n');
  return next;
}

/** Ensures at most `keep` routine backup folders owned by `file` remain beside it; other configs, ambiguous older backups, and preserved recovery backups stay untouched. */
async function pruneBackups(file, currentDirectory, keep = 3) {
  const parent = path.dirname(file);
  const ownerName = path.basename(file);
  const sameOwner = value =>
    process.platform === 'win32' ? value.toLowerCase() === ownerName.toLowerCase() : value === ownerName;
  const entries = await fs.readdir(parent, { withFileTypes: true }).catch(() => []);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('.uburoom-config-')) continue;
    const dir = path.join(parent, entry.name);
    const contents = new Set(await fs.readdir(dir).catch(() => []));
    if (
      !contents.has('original.yaml') ||
      contents.has('replacement.yaml') ||
      contents.has('.preserve') ||
      !contents.has('.owner')
    )
      continue;
    const owner = await fs.readFile(path.join(dir, '.owner'), 'utf8').catch(() => '');
    if (!owner || !sameOwner(owner.trim())) continue;
    const stat = await fs.lstat(path.join(dir, 'original.yaml'), { bigint: true }).catch(() => undefined);
    if (!stat) continue;
    candidates.push({ dir, isCurrent: dir === currentDirectory, mtimeNs: stat.mtimeNs, name: entry.name });
  }
  candidates.sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (b.mtimeNs !== a.mtimeNs) return b.mtimeNs > a.mtimeNs ? 1 : -1;
    return b.name.localeCompare(a.name);
  });
  for (const stale of candidates.slice(keep)) {
    await fs.rm(stale.dir, { recursive: true, force: true }).catch(() => {});
  }
}

function proposed(original, requested, file) {
  const current = validate(original, file);
  const changes = outputChanges(requested, current.transcoding);
  if (
    changes['access.password'] === false &&
    !Object.hasOwn(changes, 'secrets.server_password') &&
    current.serverPassword
  )
    changes['secrets.server_password'] = '';
  const source = original.toString('utf8');
  const doc = YAML.parseDocument(source.replace(/^\uFEFF/, ''), {
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
    stringKeys: true,
  });
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'),
      old = doc.getIn(parts, true),
      node = doc.createNode(value);
    if (key === 'secrets.server_password' && YAML.isScalar(node)) node.type = 'QUOTE_SINGLE';
    if (key === 'access.source_members' && YAML.isSeq(node)) {
      node.flow = true;
      for (const item of node.items)
        if (YAML.isScalar(item) && typeof item.value === 'string') item.type = 'QUOTE_SINGLE';
    }
    if (old) {
      node.commentBefore = old.commentBefore;
      node.comment = old.comment;
      node.spaceBefore = old.spaceBefore;
      if (YAML.isScalar(old) && YAML.isScalar(node) && typeof old.value === typeof node.value) node.type = old.type;
      if (YAML.isCollection(old)) {
        node.flow = old.flow;
        // Comments on removed/replaced list items are retained before the new
        // value; their exact attachment may change when a list is replaced.
        YAML.visit(old, (_, child) => {
          if (child && child !== old)
            for (const name of ['commentBefore', 'comment']) {
              if (child[name]) node.commentBefore = [node.commentBefore, child[name]].filter(Boolean).join('\n');
            }
        });
      }
    }
    doc.setIn(parts, node);
  }
  const bytes = Buffer.from(serializeYaml(doc, source), 'utf8');
  validate(bytes, file);
  return bytes;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/**
 * Makes `node` hold `value` while keeping every part that does not change as it was written, with its
 * comments and quoting: map keys left alone when equal, list items kept by `id` (mappings) or by value
 * (scalars), and new strings single-quoted like the rest of config.yaml. Returns the node to use.
 */
function merge(doc, node, value) {
  if (YAML.isMap(node) && value && typeof value === 'object' && !Array.isArray(value)) {
    for (const pair of [...node.items]) {
      const key = YAML.isScalar(pair.key) ? pair.key.value : pair.key;
      if (!Object.hasOwn(value, key)) node.delete(key);
    }
    for (const [key, next] of Object.entries(value)) {
      const old = node.get(key, true);
      if (old !== undefined && same(YAML.isNode(old) ? old.toJSON() : old, next)) continue;
      node.set(key, old !== undefined && YAML.isNode(old) ? merge(doc, old, next) : fresh(doc, next));
    }
    return node;
  }
  if (YAML.isSeq(node) && Array.isArray(value)) {
    const byId = new Map(),
      byValue = new Map();
    for (const item of node.items) {
      if (YAML.isMap(item) && item.get('id') !== undefined) byId.set(item.get('id'), item);
      else if (YAML.isScalar(item) && !byValue.has(item.value)) byValue.set(item.value, item);
    }
    node.items = value.map(next => {
      if (next && typeof next === 'object' && !Array.isArray(next) && byId.has(next.id))
        return merge(doc, byId.get(next.id), next);
      if ((next === null || typeof next !== 'object') && byValue.has(next)) {
        const kept = byValue.get(next);
        byValue.delete(next);
        return kept;
      }
      return fresh(doc, next);
    });
    return node;
  }
  return fresh(doc, value, YAML.isScalar(node) ? node : undefined);
}
function fresh(doc, value, like) {
  const node = doc.createNode(value);
  YAML.visit(node, {
    Scalar(key, scalar) {
      if (key !== 'key' && typeof scalar.value === 'string') scalar.type = like?.type || 'QUOTE_SINGLE';
    },
  });
  if (like) {
    node.comment = like.comment;
    node.commentBefore = like.commentBefore;
  }
  return node;
}

/**
 * One change to the `sources:` list, as YAML, keeping the file's comments and layout:
 * - `{action: 'add', entry}`: appends a whole raw entry (built by the server, never the browser);
 * - `{action: 'update', id, name?, libraries?}`: renames (blank removes the name) or sets the
 *   libraries offered (null removes the list: every library);
 * - `{action: 'remove', id}`: removes the entry, and its id from `access.source_members`.
 * Returns the proposed bytes and, when the whole file is invalid, the reason from validation.
 */
function proposedSources(original, change, file) {
  const source = original.toString('utf8');
  const doc = YAML.parseDocument(source.replace(/^\uFEFF/, ''), {
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
    stringKeys: true,
  });
  let list = doc.get('sources', true);
  if (list !== undefined && !YAML.isSeq(list)) throw failure('CONFIG_INVALID');
  const index = () => {
    const found = (list?.items || []).findIndex(item => YAML.isMap(item) && item.get('id') === change.id);
    if (found < 0) throw failure('SOURCE_MISSING');
    return found;
  };
  if (change.action === 'add') {
    if (!list) {
      doc.set('sources', doc.createNode([]));
      list = doc.get('sources', true);
    }
    // An empty `sources: []` becomes a block list, like the commented examples.
    list.flow = false;
    const node = doc.createNode(change.entry);
    const offered = node.get('libraries', true);
    if (offered) offered.flow = true;
    list.items.push(node);
    if (change.allowMembers === true && sourceType(change.entry?.type)?.memberIdentity && change.entry?.id) {
      let members = doc.getIn(['access', 'source_members'], true);
      if (!YAML.isSeq(members)) {
        const seq = doc.createNode([]);
        seq.flow = true;
        doc.setIn(['access', 'source_members'], seq);
        members = doc.getIn(['access', 'source_members'], true);
      }
      const exists = members.items.some(item => YAML.isScalar(item) && item.value === change.entry.id);
      if (!exists) members.items.push(fresh(doc, change.entry.id));
    }
  } else if (change.action === 'update') {
    const entry = list.items[index()];
    if (change.name !== undefined) {
      if (change.name) entry.set('name', change.name);
      else entry.delete('name');
    }
    if (change.libraries !== undefined) {
      if (change.libraries === null) entry.delete('libraries');
      else {
        const node = doc.createNode(change.libraries);
        node.flow = true;
        entry.set('libraries', node);
      }
    }
    // A source type's own edit (folders: its libraries and folders), applied to the entry as written.
    if (change.transform) {
      let next;
      try {
        next = change.transform(entry.toJSON());
      } catch (error) {
        throw Object.assign(failure('SOURCE_INVALID'), {
          reason: error?.expose ? String(error.message).slice(0, 300) : undefined,
        });
      }
      merge(doc, entry, next);
    }
  } else if (change.action === 'remove') {
    list.items.splice(index(), 1);
    const members = doc.getIn(['access', 'source_members'], true);
    if (YAML.isSeq(members)) {
      const at = members.items.findIndex(item => YAML.isScalar(item) && item.value === change.id);
      if (at >= 0) members.items.splice(at, 1);
    }
  } else throw failure('CONFIG_INVALID');
  const next = serializeYaml(doc, source, { flowCollectionPadding: false });
  const bytes = Buffer.from(next, 'utf8');
  try {
    normalizeConfig(parseConfig(next), { base: path.dirname(file), discoverTools: false });
  } catch (error) {
    throw Object.assign(failure('SOURCE_INVALID'), { reason: String(error?.message || '').slice(0, 300) });
  }
  return bytes;
}

async function writePrivate(file, bytes, original) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    if (original) {
      if (process.platform === 'win32') {
        // Freeze the original effective DACL so moving out of the staging
        // directory cannot introduce broader inherited permissions.
        await powershell(
          `$acl=[System.Security.AccessControl.FileSecurity]::new();
          $acl.SetSecurityDescriptorSddlForm($env:UBUROOM_EDIT_ACL,[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group);
          $acl.SetAccessRuleProtection($true,$true);
          [System.IO.File]::SetAccessControl($env:UBUROOM_EDIT_FILE,$acl)`,
          { UBUROOM_EDIT_FILE: file, UBUROOM_EDIT_ACL: original.acl },
        );
      } else {
        await handle.chown(Number(original.stat.uid), Number(original.stat.gid));
        // Tighten to the original owner's existing read/write permissions.
        await handle.chmod(Number(original.stat.mode) & 0o600);
      }
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Creates a configuration file that does not exist yet, for first-run setup: never replaces or reads
 * an existing one (or a link where it would go). The bytes must be a valid configuration. They are
 * written privately in a protected folder beside it, then linked into place, which fails if anything
 * appeared there meanwhile; where the filesystem has no hard links, an exclusive create is used.
 * The file ends readable only by this user.
 * @param {string} selectedPath
 * @param {Buffer} bytes
 */
function createConfigFile(selectedPath, bytes) {
  const file = path.resolve(selectedPath);
  return serialize(async () => {
    try {
      validate(bytes, file);
      const parent = await fs.lstat(path.dirname(file));
      if (!parent.isDirectory()) throw failure('CONFIG_UNSAFE_PATH');
      const existing = await fs.lstat(file).then(
        () => true,
        error => {
          if (error.code === 'ENOENT') return false;
          throw error;
        },
      );
      if (existing) throw failure('CONFIG_EXISTS');
      const directory = await fs.mkdtemp(path.join(path.dirname(file), '.uburoom-config-'));
      try {
        await protectDirectory(directory);
        const staged = path.join(directory, 'config.yaml');
        await writePrivate(staged, bytes);
        if (revision(await fs.readFile(staged)) !== revision(bytes)) throw failure('CONFIG_IO');
        await protectFile(staged);
        try {
          await fs.link(staged, file);
        } catch (error) {
          if (error.code === 'EEXIST') throw failure('CONFIG_EXISTS');
          if (!['ENOSYS', 'EPERM', 'ENOTSUP'].includes(error.code)) throw error;
          // No hard links here: lock ACLs on an empty exclusive file before writing secrets.
          const handle = await fs.open(file, 'wx', 0o600);
          try {
            await protectFile(file);
            await handle.writeFile(bytes);
            await handle.sync();
          } catch (writeError) {
            await handle.close().catch(() => {});
            await fs.unlink(file).catch(() => {});
            throw writeError;
          }
          await handle.close();
        }
        if (process.platform !== 'win32') {
          const handle = await fs.open(path.dirname(file), 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
        return { revision: revision(bytes) };
      } finally {
        await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    } catch (error) {
      if (error instanceof ConfigEditError) throw error;
      throw error?.code === 'EEXIST' ? failure('CONFIG_EXISTS') : failure('CONFIG_IO');
    }
  });
}

/**
 * The path is selected by the server, not HTTP. Remote callers supply a
 * synchronous beforeReplace authorization check, also run after queueing.
 * @param {string} [selectedPath]
 */
function createConfigEditor(selectedPath = configPath()) {
  const file = path.resolve(selectedPath);
  const sanitized = async action => {
    try {
      return await action();
    } catch (error) {
      throw error instanceof ConfigEditError ? error : failure('CONFIG_IO');
    }
  };
  return {
    read() {
      return sanitized(async () => {
        const original = await snapshot(file);
        return {
          source: 'file',
          revision: original.revision,
          settings: runningSettings(validate(original.bytes, file)).settings,
        };
      });
    },
    readEditable(options) {
      return sanitized(async () => {
        const original = await snapshot(file);
        const config = validate(original.bytes, file);
        return {
          source: 'file',
          revision: original.revision,
          settings: editableSettings(config),
          access: accessContext(config, options),
        };
      });
    },
    save(request, { beforeReplace } = {}) {
      const authorize = () => {
        if (beforeReplace && beforeReplace() !== true) throw failure('CONFIG_AUTHORIZATION');
      };
      let patch, expected;
      try {
        if (!request || typeof request !== 'object' || Array.isArray(request)) throw failure('CONFIG_INVALID');
        const { changes } = request;
        expected = request.revision;
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length)
          throw failure('CONFIG_INVALID');
        if (Object.keys(changes).some(key => !EDITABLE.has(key) && !WRITE_ONLY.has(key)))
          throw failure('CONFIG_FORBIDDEN');
        if (
          typeof expected !== 'string' ||
          !/^[a-f0-9]{64}$/.test(expected) ||
          Object.values(changes).some(value => value === null || value === undefined)
        )
          throw failure('CONFIG_INVALID');
        patch = structuredClone(changes);
      } catch (error) {
        return Promise.reject(error instanceof ConfigEditError ? error : failure('CONFIG_INVALID'));
      }
      return commit(expected, authorize, bytes => {
        try {
          return proposed(bytes, patch, file);
        } catch {
          throw failure('CONFIG_INVALID');
        }
      });
    },
    /** The saved `sources:` entries, normalized, with the file revision. Secrets included: server use only. */
    readSources() {
      return sanitized(async () => {
        const original = await snapshot(file);
        const config = validate(original.bytes, file);
        return {
          revision: original.revision,
          sources: config.sources || [],
          memberSources: config.accessPolicy.sourceMembers,
          operators: config.serverOperator.identities,
        };
      });
    },
    /**
     * Saves one change to `sources:` (see `proposedSources`), with the same revision check, backup,
     * private write and authorization recheck as `save`. Applies after a restart.
     */
    saveSources(request, { beforeReplace, transform, preserveBackup = false } = {}) {
      const authorize = () => {
        if (beforeReplace && beforeReplace() !== true) throw failure('CONFIG_AUTHORIZATION');
      };
      const { revision: expected, change } = request || {};
      if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || !change || typeof change !== 'object')
        return Promise.reject(failure('CONFIG_INVALID'));
      const copy = { ...structuredClone(change), ...(transform ? { transform } : {}) };
      return commit(expected, authorize, bytes => proposedSources(bytes, copy, file), { preserveBackup });
    },
  };
  /**
   * Replaces the file with what `build` makes of its current bytes, if it is still at `expected`:
   * a protected backup first, a private replacement beside it, then one rename.
   */
  function commit(expected, authorize, build, { preserveBackup = false } = {}) {
    return serialize(() =>
      sanitized(async () => {
        authorize();
        const original = await snapshot(file);
        if (original.revision !== expected) throw failure('CONFIG_CONFLICT');
        const bytes = build(original.bytes);
        const nextRevision = revision(bytes);
        const directory = await fs.mkdtemp(path.join(path.dirname(file), '.uburoom-config-'));
        const backupPath = path.join(directory, 'original.yaml'),
          replacement = path.join(directory, 'replacement.yaml');
        let backupReady = false;
        let preserveDir = preserveBackup;
        try {
          // The directory is empty until protected; never put secrets in an
          // inherited/public Windows directory even briefly.
          await protectDirectory(directory);
          await writePrivate(backupPath, original.bytes);
          if (revision(await fs.readFile(backupPath)) !== original.revision) throw failure('CONFIG_IO');
          await writePrivate(path.join(directory, '.owner'), Buffer.from(path.basename(file) + '\n', 'utf8'));
          backupReady = true;
          await writePrivate(replacement, bytes, original);
          if (revision(await fs.readFile(replacement)) !== nextRevision) throw failure('CONFIG_IO');
          if (process.platform !== 'win32') {
            for (const entry of [directory, path.dirname(file)]) {
              const parent = await fs.open(entry, 'r');
              try {
                await parent.sync();
              } finally {
                await parent.close();
              }
            }
          }
          const current = await snapshot(file);
          if (
            current.revision !== original.revision ||
            metadata(current.stat) !== metadata(original.stat) ||
            current.acl !== original.acl
          )
            throw failure('CONFIG_CONFLICT');
          // No unlink/copy fallback. A filesystem that refuses replacement
          // fails closed. External editors can still race this check/rename.
          authorize();
          await fs.rename(replacement, file);
          if (preserveDir) {
            await fs.writeFile(path.join(directory, '.preserve'), '1', { flag: 'wx' }).catch(() => {});
          }
          await pruneBackups(file, directory);
          return { source: 'file', revision: nextRevision, restartRequired: true, backupPath };
        } catch (error) {
          if (error.code === 'CONFIG_CONFLICT' || error.code === 'CONFIG_AUTHORIZATION') {
            backupReady = false;
            preserveDir = false;
          } else if (backupReady) {
            preserveDir = true;
          }
          throw error;
        } finally {
          await fs.unlink(replacement).catch(() => {});
          if (!backupReady) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
          else if (preserveDir) {
            await fs.writeFile(path.join(directory, '.preserve'), '1', { flag: 'wx' }).catch(() => {});
          }
        }
      }),
    );
  }
}

module.exports = { createConfigEditor, createConfigFile, serializeYaml };
