'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const Policy = require('./room-policy');
const { findOnPath } = require('./media-tools');
const ROOT = path.resolve(__dirname, '..');

const KEYS = [
  'plex.url', 'plex.token', 'plex.machine_identifier', 'plex.fallback_enabled', 'plex.fallback_token',
  'discord.bot_token', 'discord.client_id', 'discord.client_secret', 'discord.owner_id',
  'discord.guild_id', 'discord.command_channel_ids',
  'server.host', 'server.port', 'server.public_url', 'server.tls_cert', 'server.tls_key', 'server.public_web_app',
  'storage.credential_key_file', 'storage.data_directory', 'tools.ffmpeg', 'tools.ffprobe',
  'rooms.host_permissions', 'rooms.viewer_permissions', 'rooms.admin_discord_ids', 'rooms.admin_plex_ids',
  'rooms.admin_discord_role_ids', 'rooms.single_room', 'rooms.single_room_name', 'rooms.single_room_leader_plex_id',
  'secrets.entry_password', 'access.discord', 'access.plex', 'access.require_plex', 'access.require_plex_in_activity',
  'transcoding.policy', 'transcoding.plex', 'transcoding.uburoom', 'transcoding.encoder',
  'transcoding.formats', 'transcoding.max_jobs', 'transcoding.cpu_fallback',
  'transcoding.qualities', 'transcoding.allow_original'];

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

function normalizeConfig(value, { base = ROOT, environment = process.env, platform = process.platform } = {}) {
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
  function list(key) {
    const [section, name] = key.split('.');
    const v = value[section]?.[name];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.some(item => typeof item !== 'string' || !item || item.includes(','))) {
      throw new Error(key + ' must be a list of quoted strings');
    }
    return v;
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
  const port = value.server?.port ?? 5756;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('server.port must be an integer from 1 to 65535');
  let publicUrl;
  try { publicUrl = new URL(get('server.public_url', 'https://localhost:5756')); }
  catch { throw new Error('server.public_url must be an HTTPS origin'); }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname !== '/') {
    throw new Error('server.public_url must be an HTTPS origin');
  }
  const resolveFile = (key, fallback) => path.resolve(base, get(key) || fallback);
  const home = environment.HOME || (platform === 'win32' && environment.USERPROFILE) || os.homedir();
  const keyDirectory = platform === 'win32' ? environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    : platform === 'darwin' ? path.join(home, 'Library', 'Application Support')
    : environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME) ? environment.XDG_DATA_HOME : path.join(home, '.local', 'share');
  const defaultKey = path.join(keyDirectory, 'uburoom', 'credentials.key');
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
    channels: list('discord.command_channel_ids') || [],
    ffmpegPath: get('tools.ffmpeg') ? resolveFile('tools.ffmpeg') : findOnPath('ffmpeg', environment),
    ffprobePath: get('tools.ffprobe') ? resolveFile('tools.ffprobe') : findOnPath('ffprobe', environment)
  };
  config.accessPolicy = {
    discord:boolean('access.discord', true), plex:boolean('access.plex', true),
    requirePlex:boolean('access.require_plex', false), requirePlexInActivity:boolean('access.require_plex_in_activity', true), password:get('secrets.entry_password'),
    publicWeb:boolean('server.public_web_app', true)
  };
  config.plexFallback = { enabled:boolean('plex.fallback_enabled',true), token:get('plex.fallback_token') };
  config.singleRoom = boolean('rooms.single_room',false);
  config.singleRoomName = get('rooms.single_room_name','Room');
  config.singleRoomLeaderPlexId = get('rooms.single_room_leader_plex_id');
  if (config.singleRoomLeaderPlexId && !/^\d{1,20}$/.test(config.singleRoomLeaderPlexId)) throw new Error('rooms.single_room_leader_plex_id must be a quoted Plex account ID');
  const maxJobs = value.transcoding?.max_jobs ?? 5;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 32) throw new Error('transcoding.max_jobs must be an integer from 1 to 32');
  const formats = list('transcoding.formats');
  config.transcoding = { policy:choice('transcoding.policy','follow_plex',['follow_plex','disabled','override']),
    plex:boolean('transcoding.plex',true), uburoom:boolean('transcoding.uburoom',true),
    encoder:choice('transcoding.encoder','auto',['auto','hardware','qsv','nvenc','software']),
    cpuFallback:boolean('transcoding.cpu_fallback',true),
    formats:formats === undefined ? ['av1'] : formats, maxJobs };
  if (config.transcoding.formats.some(format => !require('../web/playback-policy').localFormat(format))) throw new Error('transcoding.formats supports av1, vp9 and vp8');
  if(new Set(config.transcoding.formats).size!==config.transcoding.formats.length)throw new Error('transcoding.formats must not repeat a codec');
  const {QUALITIES,qualityDefinition} = require('../shared/room-protocol');
  const pairs = value.transcoding?.qualities;
  if (pairs !== undefined && (!Array.isArray(pairs) || pairs.length > 32 || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(n => typeof n !== 'number') || !qualityDefinition(pair[0]+'p'+pair[1])))) throw new Error('transcoding.qualities requires up to 32 [height, Mbps] pairs, even heights 144-4320 and 0.1-200 Mbps');
  const configured = pairs === undefined ? QUALITIES.slice(1) : pairs.map(([height,mbps])=>qualityDefinition(height+'p'+mbps));
  if (new Set(configured.map(q=>q.id)).size !== configured.length) throw new Error('transcoding.qualities must not repeat a quality');
  config.transcoding.qualities = [...(boolean('transcoding.allow_original',true)?[QUALITIES[0]]:[]),...configured].sort((a,b)=>(b.height||Infinity)-(a.height||Infinity)||(b.bitrate||Infinity)-(a.bitrate||Infinity));
  if (!config.transcoding.qualities.length) throw new Error('Offer Original or at least one transcoding quality');
  if (config.accessPolicy.requirePlex && !config.accessPolicy.plex) throw new Error('access.require_plex requires access.plex');
  if (config.accessPolicy.requirePlex && !config.plexToken) throw new Error('access.require_plex requires configured Plex credentials');
  if (config.accessPolicy.password.length > 1024) throw new Error('secrets.entry_password must contain at most 1024 characters');
  if ((config.accessPolicy.requirePlex || config.plexFallback.token) && !config.plexUrl) throw new Error('Plex access policy requires plex.url');
  if (!config.accessPolicy.publicWeb && (!config.accessPolicy.discord || !config.clientId || !config.clientSecret || !config.ownerId)) throw new Error('Activity-only access requires Discord authorization and configured client credentials/owner');
  if (!config.accessPolicy.publicWeb && (!config.botToken || !config.guildId)) throw new Error('Activity-only access requires a Discord bot and guild for verified membership');
  if (config.singleRoom && !config.singleRoomLeaderPlexId) {
    if (!config.accessPolicy.discord && config.accessPolicy.plex) {
      if (!config.plexToken) throw new Error('Single-room mode requires plex.token or rooms.single_room_leader_plex_id for Plex leadership');
    } else if (!config.ownerId) throw new Error('Single-room mode requires discord.owner_id or rooms.single_room_leader_plex_id for fixed room leadership');
  }
  if (!config.singleRoomName.trim() || config.singleRoomName.length > 100 || /[\u0000-\u001f\u007f-\u009f]/.test(config.singleRoomName)) throw new Error('rooms.single_room_name must contain 1 to 100 characters without control characters');
  if (!config.host.trim()) throw new Error('server.host must not be empty');
  for (const key of ['clientId', 'ownerId', 'guildId']) {
    if (config[key] && !/^\d{17,20}$/.test(config[key])) throw new Error('discord IDs must be quoted numeric Developer Mode IDs');
  }
  if (config.channels.some(id => !/^\d{17,20}$/.test(id))) throw new Error('discord.command_channel_ids requires exact quoted IDs');
  Object.assign(config, Policy.configuration(value.rooms || {}));
  return config;
}

function loadConfig(file = configPath()) {
  let source;
  try { source = fs.readFileSync(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') throw new Error('Missing config.yaml. Copy config.example.yaml and configure your installation. Never share your private config.');
    throw new Error('Cannot read private configuration file (' + error.code + ')');
  }
  return normalizeConfig(parseConfig(source), { base: path.dirname(path.resolve(file)) });
}

module.exports = { ROOT, configPath, parseConfig, normalizeConfig, loadConfig };
