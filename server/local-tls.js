'use strict';
// @ts-check
/**
 * Self-signed certificates for this machine: the development script (scripts/new-dev-cert.js), the
 * setup page when it is reachable beyond loopback, and the certificate a new installation runs on
 * (server/setup/). Built with node:crypto alone; nothing is installed in any trust store.
 */
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawnSync } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

const WIN_ACL_FILE =
  "$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=[System.IO.File]::GetAccessControl($env:UBUROOM_PRIVATE_FILE);$acl.SetAccessRuleProtection($true,$false);foreach($r in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($r)};foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','Allow'))};[System.IO.File]::SetAccessControl($env:UBUROOM_PRIVATE_FILE,$acl)";
const WIN_ACL_DIRS =
  "$targets=$env:UBUROOM_PRIVATE_DIRS | ConvertFrom-Json;$owner=[System.Security.Principal.WindowsIdentity]::GetCurrent().User;foreach($dir in $targets){$acl=[System.IO.Directory]::GetAccessControl($dir);$acl.SetAccessRuleProtection($true,$false);foreach($r in @($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($r)};foreach($sid in @($owner,[System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'))){[void]$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'))};[System.IO.Directory]::SetAccessControl($dir,$acl)}";

/**
 * Runs a PowerShell snippet with environment parameters (no shell-quoting interpolation).
 * @param {string} script
 * @param {Record<string, string>} environment
 */
async function powershell(script, environment) {
  const result = await execute(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64'),
    ],
    {
      env: { ...process.env, ...environment },
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 65536,
    },
  );
  return result.stdout.trim();
}

/**
 * Synchronously runs a PowerShell snippet for private ACL enforcement.
 * @param {string} script
 * @param {Record<string, string>} environment
 * @param {string} errorMessage
 */
function powershellSync(script, environment, errorMessage) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from("$ErrorActionPreference='Stop'; " + script, 'utf16le').toString('base64'),
    ],
    { env: { ...process.env, ...environment }, windowsHide: true, timeout: 15000 },
  );
  if (result.status !== 0) throw new Error(errorMessage);
}

/**
 * Makes an existing file readable and writable only by the current user (and SYSTEM on Windows).
 * @param {string} file
 */
function privateFile(file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(file, 0o600);
    return;
  }
  powershellSync(WIN_ACL_FILE, { UBUROOM_PRIVATE_FILE: file }, 'Cannot protect uburoom private files');
}

/**
 * Makes an existing directory accessible only by the current user (and SYSTEM on Windows).
 * @param {string} directory
 */
function privateDirectory(directory) {
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
    return;
  }
  powershellSync(
    WIN_ACL_DIRS,
    { UBUROOM_PRIVATE_DIRS: JSON.stringify([path.resolve(directory)]) },
    'Cannot protect uburoom private directory',
  );
}

/**
 * Ensures `directory` exists, applying private directory permissions to any newly created directories.
 * @param {string} directory
 * @returns {boolean} True when at least one directory was newly created.
 */
function ensurePrivateDirectorySync(directory) {
  const target = path.resolve(directory);
  const missing = [];
  let current = target;
  while (!fs.existsSync(current)) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!missing.length) return false;
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    for (const created of missing.reverse()) fs.chmodSync(created, 0o700);
  } else {
    powershellSync(
      WIN_ACL_DIRS,
      { UBUROOM_PRIVATE_DIRS: JSON.stringify(missing.reverse()) },
      'Cannot protect uburoom private directory',
    );
  }
  return true;
}

/**
 * Atomically creates a new private file (`wx`), locks its permissions/DACLs before writing secret bytes,
 * and removes the file if locking or writing fails.
 * @param {string} file
 * @param {string | Buffer} [content]
 */
function writePrivateFileSync(file, content) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    privateFile(file);
    if (content !== undefined && content.length > 0) fs.writeFileSync(fd, content);
  } catch (error) {
    try {
      fs.closeSync(fd);
    } catch {}
    try {
      fs.unlinkSync(file);
    } catch {}
    throw error;
  }
  fs.closeSync(fd);
}

/**
 * Async version: makes a directory accessible only by this user (and SYSTEM on Windows).
 * @param {string} directory
 */
async function protectDirectory(directory) {
  if (process.platform !== 'win32') return fs.promises.chmod(directory, 0o700);
  await powershell(WIN_ACL_DIRS, { UBUROOM_PRIVATE_DIRS: JSON.stringify([path.resolve(directory)]) });
}

/**
 * Async version: makes a file readable and writable only by this user (and SYSTEM on Windows).
 * @param {string} file
 */
async function protectFile(file) {
  if (process.platform !== 'win32') return fs.promises.chmod(file, 0o600);
  await powershell(WIN_ACL_FILE, { UBUROOM_PRIVATE_FILE: file });
}

function derLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) {
    bytes.unshift(temp & 0xff);
    temp >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), derLength(buf.length), buf]);
}

function formatUtcTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return (
    String(d.getUTCFullYear()).slice(2) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) +
    'Z'
  );
}

/** An IP address as the bytes of a certificate's IP entry. */
function ipBytes(address) {
  const clean = String(address).replace(/^\[|\]$/g, '');
  if (net.isIPv4(clean)) return Buffer.from(clean.split('.').map(Number));
  let v6 = clean;
  const dotted = /:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(v6);
  if (dotted) {
    const hi = ((Number(dotted[1]) << 8) | Number(dotted[2])).toString(16);
    const lo = ((Number(dotted[3]) << 8) | Number(dotted[4])).toString(16);
    v6 = v6.slice(0, dotted.index) + ':' + hi + ':' + lo;
  }
  const [head, tail = ''] = v6.split('::');
  const part = text => (text ? text.split(':') : []);
  const groups = [...part(head), ...Array(8 - part(head).length - part(tail).length).fill('0'), ...part(tail)];
  return Buffer.concat(groups.map(group => Buffer.from(group.padStart(4, '0'), 'hex')));
}

/**
 * A new self-signed certificate and its private key, as PEM.
 * @param {{dnsNames?: string[], ipAddresses?: string[], commonName?: string, days?: number}} [options]
 *   `ipAddresses` always includes 127.0.0.1.
 */
function createCertificate({ dnsNames = ['localhost'], ipAddresses = [], commonName = 'uburoom', days = 825 } = {}) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Algorithm Identifier: sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sha256WithRSAAlg = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
      derWrap(0x05, Buffer.alloc(0)),
    ]),
  );
  // Version: v3 [0] EXPLICIT INTEGER 2
  const version = derWrap(0xa0, derWrap(0x02, Buffer.from([0x02])));
  // Keep the sign bit clear and the first byte nonzero for a canonical 16-byte DER integer.
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] = (serialBytes[0] & 0x3f) | 0x40;
  const serial = derWrap(0x02, serialBytes);
  // Subject/Issuer DN: CN=<commonName>
  const cnAttr = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x06, Buffer.from([0x55, 0x04, 0x03])), // 2.5.4.3 CN
      derWrap(0x0c, Buffer.from(commonName)), // UTF8String
    ]),
  );
  const name = derWrap(0x30, derWrap(0x31, cnAttr));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
  const validity = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x17, Buffer.from(formatUtcTime(notBefore))),
      derWrap(0x17, Buffer.from(formatUtcTime(notAfter))),
    ]),
  );
  const addresses = [...new Set(['127.0.0.1', ...ipAddresses])].filter(address => net.isIP(address));
  const sanEntries = [
    ...dnsNames.map(dnsName => derWrap(0x82, Buffer.from(dnsName))),
    ...addresses.map(address => derWrap(0x87, ipBytes(address))),
  ];
  const sanExt = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x06, Buffer.from([0x55, 0x1d, 0x11])), // OID 2.5.29.17
      derWrap(0x04, derWrap(0x30, Buffer.concat(sanEntries))),
    ]),
  );
  const ekuSeq = derWrap(0x30, derWrap(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])));
  const ekuExt = derWrap(
    0x30,
    Buffer.concat([
      derWrap(0x06, Buffer.from([0x55, 0x1d, 0x25])), // OID 2.5.29.37
      derWrap(0x04, ekuSeq),
    ]),
  );
  const extensions = derWrap(0xa3, derWrap(0x30, Buffer.concat([sanExt, ekuExt])));
  const tbs = derWrap(
    0x30,
    Buffer.concat([version, serial, sha256WithRSAAlg, name, validity, name, spkiDer, extensions]),
  );
  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);
  const sigBitString = derWrap(0x03, Buffer.concat([Buffer.from([0]), signature]));
  const certDer = derWrap(0x30, Buffer.concat([tbs, sha256WithRSAAlg, sigBitString]));
  const certPem =
    '-----BEGIN CERTIFICATE-----\n' +
    certDer
      .toString('base64')
      .match(/.{1,64}/g)
      .join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const keyPem = String(privateKey.export({ type: 'pkcs1', format: 'pem' }));
  return { certPem, keyPem };
}

/**
 * Whether a PEM certificate is still valid for a while and names every one of `names` (DNS names
 * or IP addresses).
 * @param {string|Buffer} pem
 * @param {string[]} names
 */
function certificateCovers(pem, names) {
  try {
    const cert = new crypto.X509Certificate(pem);
    if (Date.parse(cert.validTo) < Date.now() + 30 * 86400000) return false;
    return names.every(name => (net.isIP(name) ? !!cert.checkIP(name) : !!cert.checkHost(name)));
  } catch {
    return false;
  }
}

/**
 * Writes a new certificate and key into `directory` (the key readable only by this user). Refuses to
 * replace existing files unless `replace` is set; with `ifMissing`, existing files are kept.
 * @param {{directory: string, certName?: string, keyName?: string, replace?: boolean, ifMissing?: boolean,
 *   dnsNames?: string[], ipAddresses?: string[], commonName?: string}} options
 */
function writeCertificate({
  directory,
  certName = 'server-cert.pem',
  keyName = 'server-key.pem',
  replace = false,
  ifMissing = false,
  ...names
}) {
  const keyFile = path.join(directory, keyName);
  const certFile = path.join(directory, certName);
  if (fs.existsSync(keyFile) || fs.existsSync(certFile)) {
    if (ifMissing) return { created: false, keyFile, certFile };
    if (!replace)
      throw new Error('A certificate already exists. Keep it, or move those files aside before generating another.');
  }
  const { certPem, keyPem } = createCertificate(names);
  ensurePrivateDirectorySync(directory);
  for (const file of [keyFile, certFile]) fs.rmSync(file, { force: true });
  writePrivateFileSync(keyFile, keyPem);
  fs.writeFileSync(certFile, certPem, { mode: 0o644, flag: 'wx' });
  return { created: true, keyFile, certFile, certPem, keyPem };
}

module.exports = {
  createCertificate,
  certificateCovers,
  writeCertificate,
  powershell,
  privateFile,
  privateDirectory,
  ensurePrivateDirectorySync,
  writePrivateFileSync,
  protectDirectory,
  protectFile,
};
