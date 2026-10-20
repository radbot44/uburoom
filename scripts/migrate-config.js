'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const YAML = require('yaml');
const { ROOT, LEGACY, LISTS, normalizeConfig, parseConfig } = require('../server/config');

function convert(source, base, environment = process.env) {
  const old = parseEnv(source), value = {};
  // Refuse unknown settings rather than silently discarding operator intent.
  if (Object.keys(old).some(key => !Object.hasOwn(LEGACY, key))) throw new Error('Unrecognized .env settings; review and remove or translate them before converting');
  for (const [name, key] of Object.entries(LEGACY)) {
    const raw = old[name];
    if (raw === undefined || raw === '') continue;
    if (LISTS.has(key) && raw.trim() === '') continue;
    const [section, setting] = key.split('.');
    value[section] ||= {};
    value[section][setting] = key === 'server.port' ? Number(raw) :
      LISTS.has(key) && !['all', 'none'].includes(raw) ? raw.split(',').map(item => item.trim())
        .filter(item => key !== 'discord.command_channel_ids' || item !== '') : raw;
  }
  // Put APIs/secrets first even when the legacy file used another order.
  const ordered = Object.fromEntries(['plex', 'discord', 'server', 'storage', 'tools', 'rooms'].map(key => [key, value[key] || {}]));
  ordered.storage.credential_key_file = path.resolve(base, old.UBUROOM_CREDENTIAL_KEY_FILE ||
    path.join(environment.LOCALAPPDATA || environment.HOME || require('node:os').homedir(), 'uburoom', 'credentials.key'));
  // Pin old relative paths to the old installation, even if output is elsewhere.
  for (const [section, key, fallback] of [
    ['server', 'tls_cert', 'certs/server-cert.pem'], ['server', 'tls_key', 'certs/server-key.pem'],
    ['storage', 'data_directory', 'data'], ['tools', 'ffmpeg'], ['tools', 'ffprobe']
  ]) {
    if (ordered[section][key] || fallback) ordered[section][key] = path.resolve(base, ordered[section][key] || fallback);
  }
  normalizeConfig(ordered, { base, environment });
  return '# PRIVATE: contains secrets and API tokens. NEVER share, commit, or attach to bug reports.\n' +
    '# Converted from .env; original left unchanged. Restart required.\n' + YAML.stringify(ordered);
}

function main(args = process.argv.slice(2)) {
  if (args.length > 2) throw new Error('Usage: node scripts/migrate-config.js [input.env] [output.yaml]');
  const input = path.resolve(args[0] || path.join(ROOT, '.env'));
  const output = path.resolve(args[1] || path.join(ROOT, 'config.yaml'));
  const text = convert(fs.readFileSync(input, 'utf8'), path.dirname(input));
  normalizeConfig(parseConfig(text), { base: path.dirname(output) });
  // Never overwrite an existing file, including a symlink or the original .env.
  fs.writeFileSync(output, text, { flag: 'wx', mode: 0o600 });
  try { require('../server/accounts').privateFile(output); }
  catch { fs.unlinkSync(output); throw new Error('Cannot restrict configuration permissions; conversion cancelled'); }
  console.log('Created private YAML configuration. Original .env unchanged; preserve it privately for rollback. Never share either file.');
}
if (require.main === module) {
  try { main(); } catch (error) {
    console.error(error.code ? 'Configuration conversion failed (' + error.code + '); no existing files overwritten.' : error.message);
    process.exitCode = 1;
  }
}
module.exports = { convert, main };
