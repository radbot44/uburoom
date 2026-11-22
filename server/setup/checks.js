'use strict';
// @ts-check
/**
 * Step 6, Check and finish: the doctor's checks (scripts/doctor.js) run against the proposed config,
 * plus the certificate setup makes, shown as one pass-or-fix line each. Finish is allowed only when
 * every line passes.
 */
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const doctor = require('../../scripts/doctor');
const { certificateCovers, writeCertificate } = require('../local-tls');
const { sourceType } = require('../sources');
const { summarize } = require('../source-flows');

const failed = (checks, status = 'fail') => checks.filter(check => check.status === status);
const listed = names =>
  names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];

/** The port uburoom will listen on: free, or the one setup holds now and hands over. */
async function port(config, setup) {
  const title = 'Port ' + config.port;
  if (config.port === setup.port) return { id: 'port', status: 'pass', title, detail: 'Free to use' };
  if (config.port < 1024 && process.platform !== 'win32' && process.getuid?.() !== 0)
    return { id: 'port', status: 'fail', title, detail: 'Ports below 1024 need special permission here. Use 5756.' };
  const [probe] = await doctor.checkPortAvailability(config.host, config.port);
  return probe.status === 'pass'
    ? { id: 'port', status: 'pass', title, detail: 'Free to use' }
    : {
        id: 'port',
        status: 'fail',
        title,
        detail: 'Another program is using it. Close that program, or choose another port, then check again.',
      };
}

/**
 * Every media source answers (its module's connection check, as Server settings asks), and none of
 * its full checks fails (media tools included).
 */
async function sources(config, tools) {
  const title = 'Media sources';
  for (const entry of config.sources) {
    const module = sourceType(entry.type);
    const label = entry.name || entry.id;
    const unchecked = () => [{ status: 'fail', message: 'Couldn’t check this source; try again' }];
    const connection = summarize(await module.check(entry, { ...tools, connectionOnly: true }).catch(unchecked));
    if (connection.status !== 'pass')
      return { id: 'sources', status: 'fail', title, detail: label + ': ' + connection.message };
    const full = await module
      .check(entry, { ...tools, ffmpeg: config.ffmpegPath, ffprobe: config.ffprobePath })
      .catch(unchecked);
    const bad = failed(full);
    if (bad.length)
      return { id: 'sources', status: 'fail', title, detail: label + ': ' + String(bad[0].message).slice(0, 300) };
  }
  return {
    id: 'sources',
    status: 'pass',
    title,
    detail: listed(config.sources.map(entry => entry.name || entry.id)) + ' responded',
  };
}

/** A certificate for the names people open uburoom at, made in the data folder unless one already covers them. */
function certificate(config, names) {
  const title = 'Certificate';
  const label = 'for ' + listed(names);
  try {
    const existing = fs.existsSync(config.tlsCert) ? fs.readFileSync(config.tlsCert) : undefined;
    if (existing && fs.existsSync(config.tlsKey) && certificateCovers(existing, names))
      return { id: 'certificate', status: 'pass', title, detail: 'Ready ' + label };
    const cleaned = names.map(name => String(name).replace(/^\[|\]$/g, '')).filter(Boolean);
    writeCertificate({
      directory: path.dirname(config.tlsCert),
      certName: path.basename(config.tlsCert),
      keyName: path.basename(config.tlsKey),
      replace: true,
      dnsNames: cleaned.filter(name => !net.isIP(name)),
      ipAddresses: cleaned.filter(name => net.isIP(name)),
    });
    const [check] = doctor.checkTlsCertificates(config).filter(item => item.status === 'fail');
    if (check) return { id: 'certificate', status: 'fail', title, detail: String(check.message).slice(0, 300) };
    return { id: 'certificate', status: 'pass', title, detail: 'Created ' + label };
  } catch (error) {
    return {
      id: 'certificate',
      status: 'fail',
      title,
      detail: 'Couldn’t create it (' + (error.code || 'error') + '); check that the data folder can be written',
    };
  }
}

/** The folder holding the config and the data folder: writable, and still no config there. */
function storage(config, { newAccount = false } = {}) {
  const title = 'Settings and data folder';
  const folder = path.dirname(config.configFile);
  const detail = folder;
  try {
    if (fs.existsSync(config.configFile))
      return {
        id: 'storage',
        status: 'fail',
        title,
        detail: 'A config.yaml appeared in ' + folder + '; nothing was changed',
      };
    // Setup's uburoom account is made in a new database; existing data has accounts of its own.
    if (newAccount && fs.existsSync(config.accountFile))
      return {
        id: 'storage',
        status: 'fail',
        title,
        detail: 'This folder already has uburoom data. Move its data folder aside, or sign in with Plex in step 2.',
      };
    fs.mkdirSync(path.dirname(config.accountFile), { recursive: true, mode: 0o700 });
    fs.accessSync(folder, fs.constants.W_OK);
    fs.accessSync(path.dirname(config.accountFile), fs.constants.W_OK);
  } catch {
    return { id: 'storage', status: 'fail', title, detail: 'uburoom can’t write to ' + folder };
  }
  const bad = failed(doctor.checkStorageAndKey(config)).filter(check => check.name !== 'Credential encryption key');
  if (bad.length) return { id: 'storage', status: 'fail', title, detail: String(bad[0].message).slice(0, 300) };
  return { id: 'storage', status: 'pass', title, detail };
}

/** The credential key: an existing one is kept, a new one is made when uburoom starts. */
function key(config) {
  const title = 'Encryption key';
  const [check] = doctor.checkStorageAndKey(config).filter(item => item.name === 'Credential encryption key');
  if (check?.status === 'fail')
    return { id: 'key', status: 'fail', title, detail: String(check.message).slice(0, 300) };
  const inside = !path.relative(path.dirname(config.configFile), config.credentialKeyFile).startsWith('..');
  return {
    id: 'key',
    status: 'pass',
    title,
    detail:
      (inside
        ? 'Back it up with the folder above.'
        : 'Back it up with the folder above: ' + config.credentialKeyFile + '.') +
      ' Without it, saved sign-ins are lost.',
  };
}

/**
 * Every check for a proposed config, in the order step 6 shows them.
 * @param {any} config - normalized, with `configFile`
 * @param {{port: number}} setup - where setup itself listens
 * @param {string[]} names - the names people open uburoom at
 * @param {{newAccount?: boolean, tools?: {plexFetch?: typeof fetch, jellyfinFetch?: typeof fetch}}} [options] -
 *   `newAccount`: setup creates a uburoom account; `tools`: how sources are reached
 */
async function runChecks(config, setup, names, options = {}) {
  const storageRow = storage(config, options);
  return [
    await port(config, setup),
    await sources(config, options.tools || {}),
    storageRow.status === 'pass'
      ? certificate(config, names)
      : { id: 'certificate', status: 'fail', title: 'Certificate', detail: 'Needs the data folder below' },
    storageRow,
    key(config),
  ];
}

module.exports = { runChecks };
