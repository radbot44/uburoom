'use strict';
// @ts-check
/**
 * WAL-safe operator backup archive creation and verified first-run restore.
 *
 * Uses only Node.js built-ins (node:sqlite VACUUM INTO, node:zlib DEFLATE/CRC32, node:crypto SHA-256).
 * Backup archives contain sensitive material (config.yaml tokens, TLS private keys, credentials.key);
 * temporary files live inside private directories and are cleaned up on completion or failure, and
 * credentials.key is kept in memory only (zeroed after use) during staging and verification.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { parseConfig, normalizeConfig } = require('./config');
const { SCHEMA_VERSION, initializeSchema } = require('./storage');
const { credentialVault, authenticateDatabaseEnvelopes } = require('./accounts');
const { readBuildIdentity } = require('./build-identity');
const { privateDirectory, ensurePrivateDirectorySync, writePrivateFileSync } = require('./local-tls');

const MANIFEST_NAME = 'BACKUP_MANIFEST.json';
const FORMAT_VERSION = 1;
const REQUIRED_FILES = Object.freeze(['config.yaml', 'accounts.sqlite', 'credentials.key']);
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024;
const MAX_ENTRY_COUNT = 64;
const SAFE_CERT_NAME = /^[A-Za-z0-9._-]{1,128}$/;

class BackupError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {number} [status]
   */
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BackupError';
    this.code = code;
    this.status = status;
    this.expose = true;
  }
}

/** @param {Buffer} data */
function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

/** @param {string} a @param {string} b */
function equalHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** @param {string} file */
function pathExists(file) {
  try {
    fs.lstatSync(file);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Encodes a JS Date into MS-DOS time/date fields for ZIP headers.
 * @param {Date} date
 */
function dosDateTime(date) {
  const year = Math.min(2107, Math.max(1980, date.getUTCFullYear()));
  const dosTime =
    ((date.getUTCHours() & 0x1f) << 11) | ((date.getUTCMinutes() & 0x3f) << 5) | ((date.getUTCSeconds() >> 1) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9) | (((date.getUTCMonth() + 1) & 0x0f) << 5) | (date.getUTCDate() & 0x1f);
  return { dosTime, dosDate };
}

/**
 * Builds a standard ZIP archive buffer (STORE or raw DEFLATE) from in-memory entries.
 * @param {Array<{name: string, data: Buffer, mtime?: Date}>} entries
 * @returns {Buffer}
 */
function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = zlib.crc32(data) >>> 0;
    const deflated = data.length > 0 ? zlib.deflateRawSync(data) : data;
    const useDeflate = deflated.length < data.length;
    const method = useDeflate ? 8 : 0;
    const payload = useDeflate ? deflated : data;
    const { dosTime, dosDate } = dosDateTime(entry.mtime || new Date());

    // Local File Header (30 bytes + filename)
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed: 2.0
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);

    // Central Directory Header (46 bytes + filename)
    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra length
    central.writeUInt16LE(0, 32); // comment length
    central.writeUInt16LE(0, 34); // disk start
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    localParts.push(local, payload);
    centralParts.push(central);
    offset += local.length + payload.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // central dir disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDir, eocd]);
}

/**
 * Validates a ZIP entry name against path traversal, drive letters, backslashes, and control chars.
 * @param {string} name
 */
function assertSafeArchiveEntryName(name) {
  if (!name || name.length > 256)
    throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains an invalid path');
  if (/[\x00-\x1f\x7f\\]/.test(name))
    throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains an unsafe path');
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name))
    throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains an absolute path');
  const trimmed = name.endsWith('/') ? name.slice(0, -1) : name;
  const segments = trimmed.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..'))
    throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains a path traversal entry');
}

/**
 * Checks whether a normalized file entry path belongs to the allowed uburoom backup layout.
 * @param {string} name
 */
function isAllowedBackupFile(name) {
  if (name === MANIFEST_NAME || REQUIRED_FILES.includes(name)) return true;
  if (name.startsWith('data/certs/')) {
    const base = name.slice('data/certs/'.length);
    return !base.includes('/') && SAFE_CERT_NAME.test(base) && base !== '.' && base !== '..';
  }
  return false;
}

/**
 * Parses and strictly validates a ZIP archive buffer.
 * @param {Buffer} buffer
 * @param {{maxArchiveBytes?: number, maxEntries?: number, maxExtractedBytes?: number}} [limits]
 * @returns {Map<string, Buffer>}
 */
function readZip(
  buffer,
  { maxArchiveBytes = MAX_ARCHIVE_BYTES, maxEntries = MAX_ENTRY_COUNT, maxExtractedBytes = MAX_EXTRACTED_BYTES } = {},
) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22)
    throw new BackupError('BACKUP_INVALID_ZIP', 'Uploaded file is not a valid ZIP archive');
  if (buffer.length > maxArchiveBytes)
    throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive exceeds maximum allowed size', 413);

  const minEocd = Math.max(0, buffer.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minEocd; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buffer.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buffer.length) {
        eocdOffset = i;
        break;
      }
    }
  }
  if (eocdOffset < 0) throw new BackupError('BACKUP_INVALID_ZIP', 'Uploaded file is not a valid ZIP archive');

  const diskNum = buffer.readUInt16LE(eocdOffset + 4);
  const cdDisk = buffer.readUInt16LE(eocdOffset + 6);
  const diskEntries = buffer.readUInt16LE(eocdOffset + 8);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (diskNum !== 0 || cdDisk !== 0 || diskEntries !== totalEntries)
    throw new BackupError('BACKUP_INVALID_ZIP', 'Multi-disk ZIP archives are not supported');
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    throw new BackupError('BACKUP_INVALID_ZIP', 'ZIP64 backup archives are not supported');
  if (totalEntries === 0 || totalEntries > maxEntries)
    throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive contains an unsupported number of entries');
  if (cdOffset + cdSize > eocdOffset)
    throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive central directory is corrupt');

  /** @type {Map<string, Buffer>} */
  const files = new Map();
  let cursor = cdOffset;
  let totalExtracted = 0;

  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > cdOffset + cdSize || buffer.readUInt32LE(cursor) !== 0x02014b50)
      throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive central directory entry is corrupt');
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compSize = buffer.readUInt32LE(cursor + 20);
    const uncompSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const extAttr = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);

    if ((flags & 0x0001) !== 0) throw new BackupError('BACKUP_INVALID_ZIP', 'Encrypted ZIP archives are not supported');
    if (method !== 0 && method !== 8)
      throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive uses an unsupported compression method');
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff)
      throw new BackupError('BACKUP_INVALID_ZIP', 'ZIP64 backup entries are not supported');
    if (((extAttr >>> 16) & 0o170000) === 0o120000)
      throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive must not contain symbolic links');

    const headerEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (headerEnd > cdOffset + cdSize)
      throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive central directory entry is truncated');

    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');
    cursor = headerEnd;

    assertSafeArchiveEntryName(name);

    // Allow harmless empty directory entries for data/ and data/certs/ only.
    if (name.endsWith('/')) {
      if (uncompSize !== 0 || compSize !== 0 || !['data/', 'data/certs/'].includes(name))
        throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains an unexpected directory entry');
      continue;
    }

    if (!isAllowedBackupFile(name))
      throw new BackupError('BACKUP_UNSAFE_PATH', 'Backup archive contains an unexpected file: ' + name);
    if (files.has(name)) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive contains duplicate entries');

    totalExtracted += uncompSize;
    if (totalExtracted > maxExtractedBytes)
      throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive exceeds maximum uncompressed size', 413);

    if (localOffset + 30 > cdOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50)
      throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive local file header is corrupt');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > cdOffset) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive entry data is truncated');
    const localName = buffer.subarray(localOffset + 30, localOffset + 30 + localNameLen).toString('utf8');
    if (localName !== name) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive header mismatch');

    const compressed = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) {
      if (compSize !== uncompSize) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive entry size mismatch');
      data = Buffer.from(compressed);
    } else {
      try {
        data = zlib.inflateRawSync(compressed, { maxOutputLength: Math.max(uncompSize, 1) });
      } catch {
        throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive entry could not be decompressed');
      }
      if (data.length !== uncompSize)
        throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive decompressed size mismatch');
    }
    if (zlib.crc32(data) >>> 0 !== crc) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive CRC check failed');

    files.set(name, data);
  }

  return files;
}

/**
 * Formats a UTC timestamp for the downloaded backup ZIP filename.
 * @param {Date} date
 */
function backupFilename(date) {
  const pad = n => String(n).padStart(2, '0');
  return (
    'uburoom-backup-' +
    date.getUTCFullYear() +
    '-' +
    pad(date.getUTCMonth() + 1) +
    '-' +
    pad(date.getUTCDate()) +
    '-' +
    pad(date.getUTCHours()) +
    pad(date.getUTCMinutes()) +
    pad(date.getUTCSeconds()) +
    '.zip'
  );
}

/**
 * Creates a WAL-safe backup ZIP archive in a private temporary directory using `VACUUM INTO`.
 * The caller must invoke `cleanup()` after reading or streaming `archivePath`.
 * On any error, all temporary files are removed before throwing.
 *
 * @param {{
 *   config?: any,
 *   db?: import('node:sqlite').DatabaseSync,
 *   registry?: { db: import('node:sqlite').DatabaseSync },
 *   configFile?: string,
 *   credentialKeyFile?: string,
 *   dataDirectory?: string,
 *   now?: Date,
 *   maxArchiveBytes?: number,
 *   maxExtractedBytes?: number,
 *   maxEntryCount?: number,
 * }} options
 */
function createBackupArchive({
  config,
  db,
  registry,
  configFile,
  credentialKeyFile,
  dataDirectory,
  now = new Date(),
  maxArchiveBytes = MAX_ARCHIVE_BYTES,
  maxExtractedBytes = MAX_EXTRACTED_BYTES,
  maxEntryCount = MAX_ENTRY_COUNT,
}) {
  const activeDb = db || registry?.db;
  const resolvedConfigFile = configFile || config?.configFile;
  const resolvedKeyFile = credentialKeyFile || config?.credentialKeyFile;
  const resolvedDataDir =
    dataDirectory ||
    (config?.accountFile
      ? path.dirname(config.accountFile)
      : resolvedConfigFile
        ? path.join(path.dirname(path.resolve(resolvedConfigFile)), 'data')
        : undefined);

  if (!activeDb) throw new BackupError('BACKUP_UNAVAILABLE', 'Database connection is unavailable', 503);
  if (!resolvedConfigFile || !pathExists(resolvedConfigFile))
    throw new BackupError('BACKUP_UNAVAILABLE', 'Configuration file is unavailable', 503);
  if (!resolvedKeyFile || !pathExists(resolvedKeyFile))
    throw new BackupError('BACKUP_UNAVAILABLE', 'Credential encryption key is unavailable', 503);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-backup-'));
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  };

  /** @type {Buffer | undefined} */
  let keyBuffer;
  /** @type {Buffer | undefined} */
  let zipBuffer;
  try {
    privateDirectory(tmpDir);

    // 1. WAL-safe SQLite snapshot via VACUUM INTO on the live connection.
    const snapshotPath = path.join(tmpDir, 'accounts.sqlite');
    if (snapshotPath.includes('\0')) throw new BackupError('BACKUP_IO', 'Invalid temporary snapshot path', 500);
    const escapedPath = snapshotPath.replace(/'/g, "''");
    let snapshotBuffer;
    try {
      activeDb.exec(`VACUUM INTO '${escapedPath}'`);
      snapshotBuffer = fs.readFileSync(snapshotPath);
    } finally {
      try {
        fs.rmSync(snapshotPath, { force: true });
      } catch {}
    }

    // 2. Read config.yaml and credentials.key (kept in memory only, never copied to temp disk).
    const configBuffer = fs.readFileSync(resolvedConfigFile);
    keyBuffer = fs.readFileSync(resolvedKeyFile);
    if (keyBuffer.length !== 32)
      throw new BackupError('BACKUP_UNAVAILABLE', 'Credential encryption key has an invalid length', 503);

    /** @type {Array<{name: string, data: Buffer, mtime: Date}>} */
    const archivedFiles = [
      { name: 'config.yaml', data: configBuffer, mtime: now },
      { name: 'accounts.sqlite', data: snapshotBuffer, mtime: now },
      { name: 'credentials.key', data: keyBuffer, mtime: now },
    ];

    // 3. Collect regular files under data/certs/* when present.
    if (resolvedDataDir) {
      const certsDir = path.join(resolvedDataDir, 'certs');
      if (pathExists(certsDir) && fs.lstatSync(certsDir).isDirectory()) {
        const dirEntries = fs
          .readdirSync(certsDir, { withFileTypes: true })
          .sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of dirEntries) {
          if (!entry.isFile() || !SAFE_CERT_NAME.test(entry.name)) continue;
          const certPath = path.join(certsDir, entry.name);
          if (fs.lstatSync(certPath).isSymbolicLink()) continue;
          archivedFiles.push({
            name: 'data/certs/' + entry.name,
            data: fs.readFileSync(certPath),
            mtime: now,
          });
        }
      }
    }

    /** @type {Record<string, string>} */
    const hashes = {};
    for (const file of archivedFiles) hashes[file.name] = sha256Hex(file.data);

    const manifest = {
      formatVersion: FORMAT_VERSION,
      version: readBuildIdentity().version,
      schemaVersion: SCHEMA_VERSION,
      createdAt: now.toISOString(),
      files: hashes,
    };
    const manifestBuffer = Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    const filename = backupFilename(now);
    const archivePath = path.join(tmpDir, filename);
    const allEntries = [{ name: MANIFEST_NAME, data: manifestBuffer, mtime: now }, ...archivedFiles];
    if (allEntries.length > maxEntryCount) {
      throw new BackupError(
        'BACKUP_TOO_LARGE',
        `Backup has ${allEntries.length} files, exceeding the ${maxEntryCount}-file restore limit`,
        413,
      );
    }
    const extractedBytes = allEntries.reduce((sum, entry) => sum + entry.data.length, 0);
    if (extractedBytes > maxExtractedBytes) {
      throw new BackupError(
        'BACKUP_TOO_LARGE',
        `Backup data exceeds the ${Math.round(maxExtractedBytes / (1024 * 1024))} MiB restore limit and would not be restorable`,
        413,
      );
    }
    zipBuffer = createZip(allEntries);
    if (zipBuffer.length > maxArchiveBytes) {
      throw new BackupError(
        'BACKUP_TOO_LARGE',
        `Backup archive exceeds the ${Math.round(maxArchiveBytes / (1024 * 1024))} MiB restore limit and would not be restorable`,
        413,
      );
    }
    writePrivateFileSync(archivePath, zipBuffer);
    const size = zipBuffer.length;

    return { archivePath, filename, manifest, size, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  } finally {
    keyBuffer?.fill(0);
    zipBuffer?.fill(0);
  }
}

/**
 * Checks whether a cert filename is a TLS private key (requiring 0600 / private ACLs).
 * @param {string} name
 * @param {string} destPath
 * @param {string | undefined} configuredTlsKey
 */
function isPrivateCertFile(name, destPath, configuredTlsKey) {
  if (configuredTlsKey && path.resolve(destPath) === path.resolve(configuredTlsKey)) return true;
  return /(?:^|[-_.])key(?:[-_.]|$)|\.key$/i.test(name);
}

/**
 * Inspects a backup ZIP archive (manifest, SHA-256 hashes, config validity, SQLite integrity,
 * schema version, and credential-key match) BEFORE writing any target files.
 *
 * Refuses to overwrite an existing config.yaml, credentials.key, or accounts.sqlite.
 * Never leaves temporary copies of credentials.key on disk.
 *
 * @param {{
 *   zipBuffer?: Buffer,
 *   zipPath?: string,
 *   configFile: string,
 *   credentialKeyFile?: string,
 *   environment?: NodeJS.ProcessEnv,
 *   platform?: NodeJS.Platform,
 *   inspectOnly?: boolean,
 * }} options
 */
function inspectAndRestoreBackup({
  zipBuffer,
  zipPath,
  configFile,
  credentialKeyFile,
  environment = process.env,
  platform = process.platform,
  inspectOnly = false,
}) {
  if (!configFile) throw new BackupError('BACKUP_INVALID_CONFIG', 'Target config.yaml path is required');
  const resolvedConfigFile = path.resolve(configFile);
  const baseDir = path.dirname(resolvedConfigFile);

  if (!inspectOnly && pathExists(resolvedConfigFile)) {
    throw new BackupError(
      'BACKUP_TARGET_EXISTS',
      'A config.yaml already exists; restore is only allowed on an empty first-run installation',
      409,
    );
  }

  let archiveBytes = zipBuffer;
  if (!archiveBytes) {
    if (!zipPath) throw new BackupError('BACKUP_INVALID_ZIP', 'Backup archive is required');
    archiveBytes = fs.readFileSync(zipPath);
  }

  const entries = readZip(archiveBytes);

  // 1. Validate BACKUP_MANIFEST.json
  const manifestRaw = entries.get(MANIFEST_NAME);
  if (!manifestRaw) throw new BackupError('BACKUP_INVALID_MANIFEST', 'Backup archive is missing BACKUP_MANIFEST.json');

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw.toString('utf8'));
  } catch {
    throw new BackupError('BACKUP_INVALID_MANIFEST', 'BACKUP_MANIFEST.json is not valid JSON');
  }
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !Number.isInteger(manifest.schemaVersion) ||
    !manifest.files ||
    typeof manifest.files !== 'object' ||
    Array.isArray(manifest.files)
  ) {
    throw new BackupError('BACKUP_INVALID_MANIFEST', 'BACKUP_MANIFEST.json is missing required metadata');
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new BackupError(
      'BACKUP_INVALID_MANIFEST',
      `Backup database schema v${manifest.schemaVersion} requires a newer uburoom version (current: v${SCHEMA_VERSION})`,
    );
  }
  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw new BackupError(
      'BACKUP_INVALID_MANIFEST',
      `Backup database schema v${manifest.schemaVersion} is incompatible with this uburoom version (expected v${SCHEMA_VERSION})`,
    );
  }

  // 2. Verify required files, manifest completeness, and SHA-256 hashes.
  const manifestKeys = Object.keys(manifest.files);
  for (const required of REQUIRED_FILES) {
    if (!Object.hasOwn(manifest.files, required) || !entries.has(required)) {
      const code = required === 'credentials.key' ? 'BACKUP_KEY_MISMATCH' : 'BACKUP_HASH_MISMATCH';
      throw new BackupError(code, `Backup archive is missing required file: ${required}`);
    }
  }
  for (const entryName of entries.keys()) {
    if (entryName === MANIFEST_NAME) continue;
    if (!Object.hasOwn(manifest.files, entryName)) {
      throw new BackupError('BACKUP_HASH_MISMATCH', `Backup archive contains unlisted file: ${entryName}`);
    }
  }
  for (const name of manifestKeys) {
    assertSafeArchiveEntryName(name);
    if (name === MANIFEST_NAME || !isAllowedBackupFile(name)) {
      throw new BackupError('BACKUP_UNSAFE_PATH', `Backup manifest references an unexpected file: ${name}`);
    }
    const expectedHash = manifest.files[name];
    if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(expectedHash)) {
      throw new BackupError('BACKUP_INVALID_MANIFEST', `Backup manifest has an invalid SHA-256 hash for ${name}`);
    }
    const fileData = entries.get(name);
    if (!fileData) {
      throw new BackupError('BACKUP_HASH_MISMATCH', `Backup archive is missing file listed in manifest: ${name}`);
    }
    const actualHash = sha256Hex(fileData);
    if (!equalHex(actualHash, expectedHash)) {
      throw new BackupError('BACKUP_HASH_MISMATCH', `SHA-256 checksum mismatch for ${name}`);
    }
  }

  const configBuffer = /** @type {Buffer} */ (entries.get('config.yaml'));
  const dbBuffer = /** @type {Buffer} */ (entries.get('accounts.sqlite'));
  const keyBuffer = /** @type {Buffer} */ (entries.get('credentials.key'));

  /** @type {string | undefined} */
  let stagingDir;
  try {
    // 3. Validate credentials.key length and construct in-memory vault (never written to temp disk).
    if (keyBuffer.length !== 32) {
      throw new BackupError('BACKUP_KEY_MISMATCH', 'Backup credentials.key must be exactly 32 bytes');
    }
    const vault = credentialVault(keyBuffer);

    // 4. Parse and validate config.yaml against target installation base directory.
    let parsedConfig;
    let targetConfig;
    try {
      parsedConfig = parseConfig(configBuffer.toString('utf8'));
      targetConfig = normalizeConfig(parsedConfig, {
        base: baseDir,
        discoverTools: false,
        environment,
        platform,
      });
      targetConfig.configFile = resolvedConfigFile;
    } catch (error) {
      throw new BackupError('BACKUP_INVALID_CONFIG', 'Backup config.yaml is invalid: ' + error.message);
    }

    const targetKeyFile = path.resolve(credentialKeyFile || targetConfig.credentialKeyFile);
    const targetAccountFile = path.resolve(targetConfig.accountFile);
    const targetDataDir = path.dirname(targetAccountFile);
    const targetCertsDir = path.join(targetDataDir, 'certs');
    const certEntries = manifestKeys.filter(name => name.startsWith('data/certs/')).sort();

    // 5. Refuse to overwrite existing installation files before staging or writing.
    if (!inspectOnly) {
      if (pathExists(targetKeyFile)) {
        throw new BackupError(
          'BACKUP_TARGET_EXISTS',
          'A credentials.key already exists; move it aside before restoring a backup',
          409,
        );
      }
      for (const dbRelated of [
        targetAccountFile,
        targetAccountFile + '-wal',
        targetAccountFile + '-shm',
        targetAccountFile + '.lock',
      ]) {
        if (pathExists(dbRelated)) {
          throw new BackupError(
            'BACKUP_TARGET_EXISTS',
            'Existing account database files were found; move the data folder aside before restoring a backup',
            409,
          );
        }
      }
      for (const certEntry of certEntries) {
        const dest = path.join(targetCertsDir, certEntry.slice('data/certs/'.length));
        if (pathExists(dest)) {
          throw new BackupError(
            'BACKUP_TARGET_EXISTS',
            'Existing certificate files were found; move them aside before restoring a backup',
            409,
          );
        }
      }
    }

    // 6. Validate SQLite integrity, schema baseline, and credential-key match in private temp dir.
    stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uburoom-restore-'));
    privateDirectory(stagingDir);
    const stagedDbPath = path.join(stagingDir, 'accounts.sqlite');
    writePrivateFileSync(stagedDbPath, dbBuffer);

    let stagedDb;
    try {
      stagedDb = new DatabaseSync(stagedDbPath, { readOnly: true });
      const integrityRows = stagedDb.prepare('PRAGMA integrity_check').all();
      if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== 'ok') {
        throw new BackupError('BACKUP_INVALID_DATABASE', 'Backup database failed SQLite integrity check');
      }
      const userVersion = stagedDb.prepare('PRAGMA user_version').get()?.user_version;
      if (userVersion !== manifest.schemaVersion || userVersion !== SCHEMA_VERSION) {
        throw new BackupError(
          'BACKUP_INVALID_DATABASE',
          `Backup database schema version (${userVersion}) does not match manifest (v${manifest.schemaVersion})`,
        );
      }
      try {
        initializeSchema(stagedDb, { checkOnly: true });
      } catch (error) {
        throw new BackupError('BACKUP_INVALID_DATABASE', 'Backup database schema is invalid: ' + error.message);
      }
      try {
        authenticateDatabaseEnvelopes(stagedDb, vault);
      } catch {
        throw new BackupError(
          'BACKUP_KEY_MISMATCH',
          'Backup credentials.key does not match the encrypted credentials in accounts.sqlite',
        );
      }
    } catch (error) {
      if (error instanceof BackupError) throw error;
      throw new BackupError('BACKUP_INVALID_DATABASE', 'Backup accounts.sqlite could not be verified');
    } finally {
      try {
        stagedDb?.close();
      } catch {}
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
      stagingDir = undefined;
    }

    if (inspectOnly) {
      return {
        manifest,
        config: targetConfig,
        files: manifestKeys,
      };
    }

    // 7. Write restored files atomically ('wx'), rolling back all written files if any write fails.
    /** @type {string[]} */
    const writtenFiles = [];
    try {
      ensurePrivateDirectorySync(path.dirname(targetKeyFile));
      ensurePrivateDirectorySync(targetDataDir);
      ensurePrivateDirectorySync(baseDir);
      if (certEntries.length) ensurePrivateDirectorySync(targetCertsDir);

      writePrivateFileSync(targetKeyFile, keyBuffer);
      writtenFiles.push(targetKeyFile);

      writePrivateFileSync(targetAccountFile, dbBuffer);
      writtenFiles.push(targetAccountFile);

      for (const certEntry of certEntries) {
        const certName = certEntry.slice('data/certs/'.length);
        const certDest = path.join(targetCertsDir, certName);
        const certData = /** @type {Buffer} */ (entries.get(certEntry));
        if (isPrivateCertFile(certName, certDest, targetConfig.tlsKey)) {
          writePrivateFileSync(certDest, certData);
        } else {
          fs.writeFileSync(certDest, certData, { mode: 0o644, flag: 'wx' });
        }
        writtenFiles.push(certDest);
      }

      // Write config.yaml last: its presence exits first-run setup mode.
      writePrivateFileSync(resolvedConfigFile, configBuffer);
      writtenFiles.push(resolvedConfigFile);
    } catch (error) {
      for (const created of writtenFiles.reverse()) {
        try {
          fs.rmSync(created, { force: true });
        } catch {}
      }
      if (error && error.code === 'EEXIST') {
        throw new BackupError(
          'BACKUP_TARGET_EXISTS',
          'Target installation files appeared while restoring; restore was aborted',
          409,
        );
      }
      throw error;
    }

    return {
      manifest,
      config: targetConfig,
      restoredFiles: writtenFiles,
    };
  } finally {
    keyBuffer.fill(0);
    if (stagingDir) {
      try {
        fs.rmSync(stagingDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

module.exports = {
  MANIFEST_NAME,
  FORMAT_VERSION,
  MAX_ARCHIVE_BYTES,
  BackupError,
  createZip,
  readZip,
  createBackupArchive,
  inspectAndRestoreBackup,
};
