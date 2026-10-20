'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const Policy = require('./room-policy');
const { findOnPath } = require('./media-tools');
const ROOT = path.resolve(__dirname, '..');

// Also used by the explicit one-time converter. Environment variables are not
// runtime configuration inputs; these names describe the old file format only.
const LEGACY = Object.freeze({
  PLEX_URL: 'plex.url', PLEX_TOKEN: 'plex.token', PLEX_MACHINE_IDENTIFIER: 'plex.machine_identifier',
  DISCORD_BOT_TOKEN: 'discord.bot_token', DISCORD_CLIENT_ID: 'discord.client_id',
  DISCORD_CLIENT_SECRET: 'discord.client_secret', DISCORD_OWNER_ID: 'discord.owner_id',
  DISCORD_GUILD_ID: 'discord.guild_id', DISCORD_COMMAND_CHANNEL_IDS: 'discord.command_channel_ids',
  HOST: 'server.host', PORT: 'server.port', PUBLIC_URL: 'server.public_url',
  TLS_CERT: 'server.tls_cert', TLS_KEY: 'server.tls_key',
  UBUROOM_CREDENTIAL_KEY_FILE: 'storage.credential_key_file',
  FFMPEG_PATH: 'tools.ffmpeg', FFPROBE_PATH: 'tools.ffprobe',
  ROOM_HOST_PERMISSIONS: 'rooms.host_permissions', ROOM_VIEWER_PERMISSIONS: 'rooms.viewer_permissions',
  ROOM_ADMIN_DISCORD_IDS: 'rooms.admin_discord_ids', ROOM_ADMIN_PLEX_IDS: 'rooms.admin_plex_ids',
  ROOM_ADMIN_DISCORD_ROLE_IDS: 'rooms.admin_discord_role_ids'
});
const LISTS = new Set(['discord.command_channel_ids', 'rooms.host_permissions', 'rooms.viewer_permissions',
  'rooms.admin_discord_ids', 'rooms.admin_plex_ids', 'rooms.admin_discord_role_ids']);
const KEYS = [...Object.values(LEGACY), 'storage.data_directory', 'secrets.entry_password',
  'access.discord', 'access.plex', 'access.require_plex', 'server.public_web_app',
  'plex.fallback_enabled', 'plex.fallback_token', 'rooms.single_room', 'rooms.single_room_name',
  'transcoding.policy', 'transcoding.plex', 'transcoding.uburoom', 'transcoding.encoder',
  'transcoding.formats', 'transcoding.max_jobs'];

function configPath(args = process.argv.slice(2)) {
  let selected;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--config' || args[i].startsWith('--config=')) {
      if (selected !== undefined) throw new Error('Specify --config only once');
      selected = args[i] === '--config' ? args[++i] : args[i].slice(9);
      if (!selected || selected.startsWith('--')) throw new Error('--config requires a file path');
    }
  }
  return path.resolve(selected || path.join(ROOT, 'config.yaml'));
}

function parseConfig(source) {
  const doc = YAML.parseDocument(source, { prettyErrors: false, uniqueKeys: true, version: '1.2', stringKeys: true });
  const problem = doc.errors[0] || doc.warnings[0];
  // Parser messages can contain tokens/source text. Never echo them or the file.
  if (problem) throw new Error('Invalid config.yaml YAML (' + problem.code + '); check syntax and duplicate keys');
  let value;
  try { value = doc.toJS({ maxAliasCount: 0 }); }
  catch { throw new Error('Invalid config.yaml: YAML aliases are unsupported'); }
  return value;
}

function normalizeConfig(value, { base = ROOT, environment = process.env } = {}) {
  const object = (v, label) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(label + ' must be a mapping');
  };
  object(value, 'config.yaml');
  for (const section of Object.keys(value)) {
    if (!KEYS.some(key => key.startsWith(section + '.'))) throw new Error('Unknown config.yaml section; check the example');
    object(value[section], 'Configuration section');
    for (const key of Object.keys(value[section])) {
      if (!KEYS.includes(section + '.' + key)) throw new Error('Unknown setting in ' + section + '; check config.example.yaml');
    }
  }
  function get(key, fallback = '') {
    const [section, name] = key.split('.');
    const v = value[section]?.[name];
    if (v === undefined) return fallback;
    if (typeof v !== 'string') throw new Error(key + ' must be a quoted string (quote all IDs)');
    return v;
  }
  function list(key, permissions = false) {
    const [section, name] = key.split('.');
    const v = value[section]?.[name];
    if (v === undefined) return undefined;
    if (permissions && ['all', 'none'].includes(v)) return v;
    if (!Array.isArray(v) || v.some(item => typeof item !== 'string' || !item || item.includes(','))) {
      throw new Error(key + ' must be a list of quoted strings' + (permissions ? ', or all/none' : ''));
    }
    return v.join(',');
  }
  function boolean(key, fallback) {
    const [section, name] = key.split('.'), selected = value[section]?.[name];
    if (selected === undefined) return fallback;
    if (typeof selected !== 'boolean') throw new Error(key + ' must be true or false');
    return selected;
  }
  function choice(key, fallback, options) {
    const selected = get(key, fallback);
    if (!options.includes(selected)) throw new Error(key + ' has an unsupported option');
    return selected;
  }
  const port = value.server?.port ?? 6767;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('server.port must be an integer from 1 to 65535');
  let publicUrl;
  try { publicUrl = new URL(get('server.public_url', 'https://localhost:6767')); }
  catch { throw new Error('server.public_url must be an HTTPS origin'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('server.public_url must be an HTTPS origin');
  }
  const resolveFile = (key, fallback) => path.resolve(base, get(key) || fallback);
  // Preserve the existing default exactly, including on Unix: moving a key
  // silently would make an existing encrypted database unreadable.
  const defaultKey = path.join(environment.LOCALAPPDATA || environment.HOME || os.homedir(), 'uburoom', 'credentials.key');
  const credentialKeyFile = resolveFile('storage.credential_key_file', defaultKey);
  const relative = path.relative(ROOT, credentialKeyFile);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) throw new Error('storage.credential_key_file must be outside the project folder');
  const plexUrl = get('plex.url');
  if (plexUrl) {
    let url;
    try { url = new URL(plexUrl); } catch { throw new Error('plex.url must be an HTTP(S) origin'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('plex.url must be an HTTP(S) origin');
  }
  const config = {
    host: get('server.host', '127.0.0.1'), port, publicUrl: publicUrl.origin,
    tlsCert: resolveFile('server.tls_cert', 'certs/server-cert.pem'),
    tlsKey: resolveFile('server.tls_key', 'certs/server-key.pem'),
    accountFile: path.join(resolveFile('storage.data_directory', 'data'), 'accounts.sqlite'), credentialKeyFile,
    plexUrl, plexToken: get('plex.token'), plexMachineIdentifier: get('plex.machine_identifier'),
    botToken: get('discord.bot_token'), clientId: get('discord.client_id'), clientSecret: get('discord.client_secret'),
    ownerId: get('discord.owner_id'), guildId: get('discord.guild_id'),
    channels: (list('discord.command_channel_ids') || '').split(',').filter(Boolean),
    ffmpegPath: get('tools.ffmpeg') ? resolveFile('tools.ffmpeg') : findOnPath('ffmpeg', environment),
    ffprobePath: get('tools.ffprobe') ? resolveFile('tools.ffprobe') : findOnPath('ffprobe', environment)
  };
  config.accessPolicy = {
    discord:boolean('access.discord', true), plex:boolean('access.plex', true),
    requirePlex:boolean('access.require_plex', false), password:get('secrets.entry_password'),
    publicWeb:boolean('server.public_web_app', true)
  };
  config.plexFallback = { enabled:boolean('plex.fallback_enabled',true), token:get('plex.fallback_token') };
  config.singleRoom = boolean('rooms.single_room',false);
  config.singleRoomName = get('rooms.single_room_name','Room');
  const maxJobs = value.transcoding?.max_jobs ?? 5;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 32) throw new Error('transcoding.max_jobs must be an integer from 1 to 32');
  const formats = list('transcoding.formats');
  config.transcoding = { policy:choice('transcoding.policy','follow_plex',['follow_plex','disabled','override']),
    plex:boolean('transcoding.plex',true), uburoom:boolean('transcoding.uburoom',true),
    encoder:choice('transcoding.encoder','hardware',['hardware','software']),
    formats:formats === undefined ? ['av1'] : formats.split(',').filter(Boolean), maxJobs };
  if (config.transcoding.formats.some(format => format !== 'av1')) throw new Error('transcoding.formats currently supports only av1');
  if (config.accessPolicy.requirePlex && !config.accessPolicy.plex) throw new Error('access.require_plex requires access.plex');
  if (config.accessPolicy.requirePlex && !config.plexToken) throw new Error('access.require_plex requires configured Plex credentials');
  if (config.accessPolicy.password.length > 1024) throw new Error('secrets.entry_password must contain at most 1024 characters');
  if ((config.accessPolicy.requirePlex || config.plexFallback.token) && !config.plexUrl) throw new Error('Plex access policy requires plex.url');
  if (!config.accessPolicy.publicWeb && (!config.accessPolicy.discord || !config.clientId || !config.clientSecret || !config.ownerId)) throw new Error('Activity-only access requires Discord authorization and configured client credentials/owner');
  if (!config.accessPolicy.publicWeb && (!config.botToken || !config.guildId)) throw new Error('Activity-only access requires a Discord bot and guild for verified membership');
  if (config.singleRoom && !config.ownerId) throw new Error('Single-room mode requires discord.owner_id for fixed room leadership');
  if (!config.singleRoomName.trim() || config.singleRoomName.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(config.singleRoomName)) throw new Error('rooms.single_room_name must contain 1 to 100 characters without control characters');
  if (!config.host.trim()) throw new Error('server.host must not be empty');
  for (const key of ['clientId', 'ownerId', 'guildId']) {
    if (config[key] && !/^\d{17,20}$/.test(config[key])) throw new Error('discord IDs must be quoted numeric Developer Mode IDs');
  }
  if (config.channels.some(id => !/^\d{17,20}$/.test(id))) throw new Error('discord.command_channel_ids requires exact quoted IDs');
  // Reuse the existing policy validator and its established permission rules.
  const roomSettings = {};
  for (const [old, key] of Object.entries(LEGACY).filter(([, key]) => key.startsWith('rooms.'))) {
    const permissions = key.endsWith('_permissions'), items = list(key, permissions);
    roomSettings[old] = permissions && items === '' ? 'none' : items;
  }
  Object.assign(config, Policy.configuration(roomSettings));
  return config;
}

function loadConfig(file = configPath()) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing config.yaml. Copy config.example.yaml or run node scripts/migrate-config.js for an old .env installation. Never share your private config.');
    throw new Error('Cannot read private configuration file (' + error.code + ')');
  }
  return normalizeConfig(parseConfig(source), { base: path.dirname(path.resolve(file)) });
}

module.exports = { ROOT, LEGACY, LISTS, configPath, parseConfig, normalizeConfig, loadConfig };
