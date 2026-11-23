#!/usr/bin/env node
'use strict';
const path = require('node:path');
const net = require('node:net');
const { writeCertificate } = require('../server/local-tls');
const { detectLanOrigins } = require('../server/origins');

const ROOT = path.join(__dirname, '..');

/** The development certificate in `certs/` (or `options.directory`), made by server/local-tls.js. */
function generateDevCert(options = {}) {
  const names = (options.dnsNames || ['localhost']).map(name => String(name).replace(/^\[|\]$/g, '')).filter(Boolean);
  if (options.lan) {
    for (const origin of detectLanOrigins({ port: 5756 }, options.lanEnv)) {
      const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
      if (host) names.push(host);
    }
  }
  const dnsNames = [...new Set(names.filter(name => !net.isIP(name)))];
  const ipAddresses = [...new Set([...names.filter(name => net.isIP(name)), ...(options.ipAddresses || [])])];
  return writeCertificate({
    directory: path.resolve(ROOT, options.directory || 'certs'),
    dnsNames,
    ipAddresses,
    ifMissing: !!options.ifMissing,
    commonName: options.lan ? 'uburoom LAN' : 'uburoom LAN development',
    days: 365,
  });
}

function parseArgs(args) {
  const options = { dnsNames: ['localhost'], directory: 'certs', ifMissing: false, lan: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--if-missing') {
      options.ifMissing = true;
    } else if (args[i] === '--lan') {
      options.lan = true;
    } else if (args[i] === '--directory' || args[i].startsWith('--directory=')) {
      options.directory = args[i] === '--directory' ? args[++i] : args[i].slice(12);
    } else if (args[i] === '--dnsNames' || args[i].startsWith('--dnsNames=')) {
      const raw = args[i] === '--dnsNames' ? args[++i] : args[i].slice(11);
      options.dnsNames = raw
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);
    }
  }
  return options;
}

if (require.main === module) {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const res = generateDevCert(opts);
    if (res.created) {
      console.log(
        `Created local TLS files in ${path.relative(ROOT, path.dirname(res.keyFile))}. No certificate was installed in any trust store.`,
      );
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}

module.exports = { generateDevCert };
