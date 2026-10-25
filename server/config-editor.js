'use strict';
const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const YAML = require('yaml');
const { configPath, parseConfig, normalizeConfig } = require('./config');
const { runningSettings } = require('./operator-settings');
const execute = promisify(execFile);

// YAML paths, deliberately narrower than the read-only operator API. No access,
// retention/history deletion, single-room, identity, connection or path settings.
const EDITABLE = new Set([
  'directory.expose_discord_members', 'directory.expose_plex_members',
  'rooms.max_saved', 'rooms.max_open', 'rooms.max_members', 'rooms.max_people',
  'rooms.recovery_seconds', 'rooms.max_queue', 'rooms.host_permissions', 'rooms.viewer_permissions',
  'transcoding.policy', 'transcoding.plex', 'transcoding.uburoom', 'transcoding.encoder',
  'transcoding.formats', 'transcoding.max_jobs', 'transcoding.cpu_fallback',
  'transcoding.qualities', 'transcoding.allow_original'
]);
const messages = {
  CONFIG_INVALID: 'Invalid proposed configuration; no settings were saved',
  CONFIG_FORBIDDEN: 'Setting is not editable; no settings were saved',
  CONFIG_CONFLICT: 'Configuration changed; read it again before saving',
  CONFIG_AUTHORIZATION: 'Authorization changed; no settings were saved',
  CONFIG_IO: 'Configuration file operation failed; no settings were saved',
  CONFIG_UNSAFE_PATH: 'Configuration must be an existing regular file without symbolic or hard links'
};
class ConfigEditError extends Error {
  constructor(code) { super(messages[code]); this.name = 'ConfigEditError'; this.code = code; }
}
const failure = code => new ConfigEditError(code);
const revision = bytes => createHash('sha256').update(bytes).digest('hex');
const metadata = stat => [(process.platform === 'win32' ? '' : stat.dev),stat.ino,stat.size,stat.mtimeNs,stat.ctimeNs,stat.mode,stat.uid,stat.gid,stat.nlink].join(':');

function editableSettings(config) {
  const values = {
    'directory.expose_discord_members': config.directory.discord,
    'directory.expose_plex_members': config.directory.plex,
    'rooms.host_permissions': Object.keys(config.roomPermissions.host).filter(key => config.roomPermissions.host[key]),
    'rooms.viewer_permissions': Object.keys(config.roomPermissions.viewer).filter(key => config.roomPermissions.viewer[key]),
    'transcoding.policy': config.transcoding.policy,
    'transcoding.plex': config.transcoding.plex,
    'transcoding.uburoom': config.transcoding.uburoom,
    'transcoding.encoder': config.transcoding.encoder,
    'transcoding.formats': config.transcoding.formats.slice(),
    'transcoding.max_jobs': config.transcoding.maxJobs,
    'transcoding.cpu_fallback': config.transcoding.cpuFallback,
    'transcoding.qualities': config.transcoding.qualities.filter(quality => quality.id !== 'direct')
      .map(quality => [quality.height, quality.bitrate / 1000]),
    'transcoding.allow_original': config.transcoding.qualities.some(quality => quality.id === 'direct')
  };
  const limits = require('./room-limits').SETTINGS;
  return Object.fromEntries([...EDITABLE].map(key => [key, key.startsWith('rooms.') && limits[key.slice(6)]
    ? config.roomLimits[limits[key.slice(6)]] : values[key]]));
}

// One process-wide queue, including separate editor instances and path aliases.
let writes = Promise.resolve();
function serialize(action) {
  const result = writes.then(action);
  writes = result.catch(() => {});
  return result;
}

async function powershell(script, environment) {
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64')], {
    env: { ...process.env, ...environment }, windowsHide: true, timeout: 15000, maxBuffer: 65536
  });
  return result.stdout.trim();
}
async function security(file) {
  if (process.platform !== 'win32') return '';
  return powershell('[System.IO.File]::GetAccessControl($env:UBUROOM_EDIT_FILE).GetSecurityDescriptorSddlForm([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group)', { UBUROOM_EDIT_FILE: file });
}
async function protectDirectory(directory) {
  if (process.platform !== 'win32') return fs.chmod(directory, 0o700);
  await powershell(`$acl=[System.Security.AccessControl.DirectorySecurity]::new();
    $owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;
    $acl.SetOwner($owner); $acl.SetAccessRuleProtection($true,$false);
    foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){
      $rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow');
      [void]$acl.AddAccessRule($rule)
    }; [System.IO.Directory]::SetAccessControl($env:UBUROOM_EDIT_DIRECTORY,$acl)`, { UBUROOM_EDIT_DIRECTORY: directory });
}

async function snapshot(file) {
  const initial = await fs.lstat(file, { bigint: true });
  if (!initial.isFile() || initial.nlink !== 1n) throw failure('CONFIG_UNSAFE_PATH');
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const acl = await security(file);
    if (metadata(initial) !== metadata(stat) || metadata(stat) !== metadata(await fs.lstat(file, { bigint: true }))) throw failure('CONFIG_CONFLICT');
    return { bytes, stat, acl, revision: revision(bytes) };
  } finally { await handle.close(); }
}
function validate(bytes, file) {
  try {
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw failure('CONFIG_INVALID');
    // Validation needs no PATH discovery, state files or provider contact.
    return normalizeConfig(parseConfig(source), { base: path.dirname(file), discoverTools: false });
  } catch { throw failure('CONFIG_INVALID'); }
}
function proposed(original, changes, file) {
  validate(original, file);
  const source = original.toString('utf8');
  const doc = YAML.parseDocument(source, { prettyErrors: false, uniqueKeys: true, version: '1.2', stringKeys: true });
  for (const [key, value] of Object.entries(changes)) {
    const parts = key.split('.'), old = doc.getIn(parts, true), node = doc.createNode(value);
    if (old) {
      node.commentBefore = old.commentBefore; node.comment = old.comment; node.spaceBefore = old.spaceBefore;
      if (YAML.isScalar(old) && YAML.isScalar(node) && typeof old.value === typeof node.value) node.type = old.type;
      if (YAML.isCollection(old)) {
        node.flow = old.flow;
        // Comments on removed/replaced list items are retained before the new
        // value; their exact attachment may change when a list is replaced.
        YAML.visit(old, (_, child) => {
          if (child && child !== old) for (const name of ['commentBefore', 'comment']) {
            if (child[name]) node.commentBefore = [node.commentBefore, child[name]].filter(Boolean).join('\n');
          }
        });
      }
    }
    doc.setIn(parts, node);
  }
  let next = doc.toString({ lineWidth: 0 });
  if (source.startsWith('\uFEFF')) next = '\uFEFF' + next;
  if (source.includes('\r\n')) next = next.replace(/\n/g, '\r\n');
  const bytes = Buffer.from(next, 'utf8');
  validate(bytes, file);
  return bytes;
}

async function writePrivate(file, bytes, original) {
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    if (original) {
      if (process.platform === 'win32') {
        // Freeze the original effective DACL so moving out of the staging
        // directory cannot introduce broader inherited permissions.
        await powershell(`$acl=[System.Security.AccessControl.FileSecurity]::new();
          $acl.SetSecurityDescriptorSddlForm($env:UBUROOM_EDIT_ACL,[System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Group);
          $acl.SetAccessRuleProtection($true,$true);
          [System.IO.File]::SetAccessControl($env:UBUROOM_EDIT_FILE,$acl)`, { UBUROOM_EDIT_FILE: file, UBUROOM_EDIT_ACL: original.acl });
      } else {
        await handle.chown(Number(original.stat.uid), Number(original.stat.gid));
        // Tighten to the original owner's existing read/write permissions.
        await handle.chmod(Number(original.stat.mode) & 0o600);
      }
    }
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
}

/**
 * The path is selected by the server, not HTTP. Remote callers supply a
 * synchronous beforeReplace authorization check, also run after queueing.
 * @param {string} [selectedPath]
 */
function createConfigEditor(selectedPath = configPath()) {
  const file = path.resolve(selectedPath);
  const sanitized = async action => {
    try { return await action(); }
    catch (error) { throw error instanceof ConfigEditError ? error : failure('CONFIG_IO'); }
  };
  return {
    read() {
      return sanitized(async () => {
        const original = await snapshot(file);
        return { source: 'file', revision: original.revision, settings: runningSettings(validate(original.bytes, file)).settings };
      });
    },
    readEditable() {
      return sanitized(async () => {
        const original = await snapshot(file);
        return { source: 'file', revision: original.revision, settings: editableSettings(validate(original.bytes, file)) };
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
        if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw failure('CONFIG_INVALID');
        if (Object.keys(changes).some(key => !EDITABLE.has(key))) throw failure('CONFIG_FORBIDDEN');
        if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected) || Object.values(changes).some(value => value === null || value === undefined)) throw failure('CONFIG_INVALID');
        patch = structuredClone(changes);
      } catch (error) { return Promise.reject(error instanceof ConfigEditError ? error : failure('CONFIG_INVALID')); }
      return serialize(() => sanitized(async () => {
        authorize();
        const original = await snapshot(file);
        if (original.revision !== expected) throw failure('CONFIG_CONFLICT');
        let bytes;
        try { bytes = proposed(original.bytes, patch, file); }
        catch { throw failure('CONFIG_INVALID'); }
        const nextRevision = revision(bytes);
        const directory = await fs.mkdtemp(path.join(path.dirname(file), '.uburoom-config-'));
        const backupPath = path.join(directory, 'original.yaml'), replacement = path.join(directory, 'replacement.yaml');
        let backupReady = false;
        try {
          // The directory is empty until protected; never put secrets in an
          // inherited/public Windows directory even briefly.
          await protectDirectory(directory);
          await writePrivate(backupPath, original.bytes);
          if (revision(await fs.readFile(backupPath)) !== original.revision) throw failure('CONFIG_IO');
          backupReady = true;
          await writePrivate(replacement, bytes, original);
          if (revision(await fs.readFile(replacement)) !== nextRevision) throw failure('CONFIG_IO');
          if (process.platform !== 'win32') {
            for (const entry of [directory, path.dirname(file)]) {
              const parent = await fs.open(entry, 'r');
              try { await parent.sync(); } finally { await parent.close(); }
            }
          }
          const current = await snapshot(file);
          if (current.revision !== original.revision || metadata(current.stat) !== metadata(original.stat) || current.acl !== original.acl) throw failure('CONFIG_CONFLICT');
          // No unlink/copy fallback. A filesystem that refuses replacement
          // fails closed. External editors can still race this check/rename.
          authorize();
          await fs.rename(replacement, file);
          return { source: 'file', revision: nextRevision, restartRequired: true, backupPath };
        } finally {
          await fs.unlink(replacement).catch(() => {});
          if (!backupReady) await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
        }
      }));
    }
  };
}

module.exports = { createConfigEditor };
