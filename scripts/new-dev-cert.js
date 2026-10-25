#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');

function derLength(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let temp = len;
  while (temp > 0) { bytes.unshift(temp & 0xff); temp >>= 8; }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derWrap(tag, buf) {
  return Buffer.concat([Buffer.from([tag]), derLength(buf.length), buf]);
}

function formatUtcTime(d) {
  const pad = n => String(n).padStart(2, '0');
  return String(d.getUTCFullYear()).slice(2) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds()) + 'Z';
}

function generateDevCert(options = {}) {
  const dnsNames = options.dnsNames || ['localhost'];
  const certDirectory = path.resolve(ROOT, options.directory || 'certs');

  const keyFile = path.join(certDirectory, 'server-key.pem');
  const certFile = path.join(certDirectory, 'server-cert.pem');

  if (fs.existsSync(keyFile) || fs.existsSync(certFile)) {
    if (options.ifMissing) {
      return { created: false, keyFile, certFile };
    }
    throw new Error('A certificate already exists. Keep it, or move those files aside before generating another.');
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const spkiDer = publicKey.export({ type: 'spki', format: 'der' });

  // Algorithm Identifier: sha256WithRSAEncryption (1.2.840.113549.1.1.11)
  const sha256WithRSAAlg = derWrap(0x30, Buffer.concat([
    derWrap(0x06, Buffer.from([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x0b])),
    derWrap(0x05, Buffer.alloc(0))
  ]));

  // Version: v3 [0] EXPLICIT INTEGER 2
  const version = derWrap(0xa0, derWrap(0x02, Buffer.from([0x02])));

  // Serial Number: random 16 bytes positive integer
  const serialBytes = crypto.randomBytes(16);
  serialBytes[0] &= 0x7f;
  const serial = derWrap(0x02, serialBytes);

  // Subject/Issuer DN: CN=uburoom LAN development
  const cnAttr = derWrap(0x30, Buffer.concat([
    derWrap(0x06, Buffer.from([0x55, 0x04, 0x03])), // 2.5.4.3 CN
    derWrap(0x0c, Buffer.from('uburoom LAN development')) // UTF8String
  ]));
  const name = derWrap(0x30, derWrap(0x31, cnAttr));

  // Validity: UTCTime
  const now = new Date();
  const notBefore = new Date(now.getTime() - 5 * 60 * 1000);
  const notAfter = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);
  const validity = derWrap(0x30, Buffer.concat([
    derWrap(0x17, Buffer.from(formatUtcTime(notBefore))),
    derWrap(0x17, Buffer.from(formatUtcTime(notAfter)))
  ]));

  // Extensions
  const sanEntries = [];
  for (const dnsName of dnsNames) {
    sanEntries.push(derWrap(0x82, Buffer.from(dnsName)));
  }
  sanEntries.push(derWrap(0x87, Buffer.from([127, 0, 0, 1])));
  const sanSeq = derWrap(0x30, Buffer.concat(sanEntries));
  const sanExt = derWrap(0x30, Buffer.concat([
    derWrap(0x06, Buffer.from([0x55, 0x1d, 0x11])), // OID 2.5.29.17
    derWrap(0x04, sanSeq)
  ]));

  const ekuSeq = derWrap(0x30, derWrap(0x06, Buffer.from([0x2b, 0x06, 0x01, 0x05, 0x05, 0x07, 0x03, 0x01])));
  const ekuExt = derWrap(0x30, Buffer.concat([
    derWrap(0x06, Buffer.from([0x55, 0x1d, 0x25])), // OID 2.5.29.37
    derWrap(0x04, ekuSeq)
  ]));

  const extensions = derWrap(0xa3, derWrap(0x30, Buffer.concat([sanExt, ekuExt])));

  // TBSCertificate
  const tbs = derWrap(0x30, Buffer.concat([
    version,
    serial,
    sha256WithRSAAlg,
    name,
    validity,
    name,
    spkiDer,
    extensions
  ]));

  // Sign TBSCertificate
  const signer = crypto.createSign('SHA256');
  signer.update(tbs);
  const signature = signer.sign(privateKey);
  const sigBitString = derWrap(0x03, Buffer.concat([Buffer.from([0]), signature]));

  // Full Certificate
  const certDer = derWrap(0x30, Buffer.concat([
    tbs,
    sha256WithRSAAlg,
    sigBitString
  ]));

  const certPem = '-----BEGIN CERTIFICATE-----\n' +
    certDer.toString('base64').match(/.{1,64}/g).join('\n') +
    '\n-----END CERTIFICATE-----\n';
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' });

  if (!fs.existsSync(certDirectory)) {
    fs.mkdirSync(certDirectory, { recursive: true });
  }

  fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
  fs.writeFileSync(certFile, certPem, { mode: 0o644 });

  return { created: true, keyFile, certFile, certPem, keyPem };
}

function parseArgs(args) {
  const options = { dnsNames: ['localhost'], directory: 'certs', ifMissing: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--if-missing') {
      options.ifMissing = true;
    } else if (args[i] === '--directory' || args[i].startsWith('--directory=')) {
      options.directory = args[i] === '--directory' ? args[++i] : args[i].slice(12);
    } else if (args[i] === '--dnsNames' || args[i].startsWith('--dnsNames=')) {
      const raw = args[i] === '--dnsNames' ? args[++i] : args[i].slice(11);
      options.dnsNames = raw.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = generateDevCert(opts);
    if (res.created) {
      console.log(`Created local TLS files in ${path.relative(ROOT, path.dirname(res.keyFile))}. No certificate was installed in any trust store.`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { generateDevCert };
