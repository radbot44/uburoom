'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const os = require('node:os');
const YAML = require('yaml');
const Policy = require('./room-policy');
const { findOnPath, findBundledTool, findSiblingTool } = require('./media-tools');
const { validateSources, ownerAccountSources, memberIdentities } = require('./sources');
const ROOT = path.resolve(__dirname, '..');

const KEYS = [
  'operator.identities',
  'directory.expose_discord_members',
  ...Object.keys(require('./room-limits').SETTINGS).map(key => 'rooms.' + key),
  'discord.bot_token',
  'discord.client_id',
  'discord.client_secret',
  'discord.owner_id',
  'discord.excluded_guild_ids',
  'discord.command_channel_ids',
  'discord.share_channel_id',
  'discord.rich_presence',
  'server.host',
  'server.port',
  'server.public_url',
  'server.lan_url',
  'server.tls_cert',
  'server.tls_key',
  'server.listen',
  'server.public_web_app',
  'server.max_connections',
  'server.trusted_proxies',
  'server.trusted_proxy_header',
  'storage.credential_key_file',
  'storage.data_directory',
  'tools.ffmpeg',
  'tools.ffprobe',
  'rooms.host_permissions',
  'rooms.viewer_permissions',
  'rooms.admin_identities',
  'rooms.admin_discord_ids',
  'rooms.admin_plex_ids',
  'rooms.admin_discord_role_ids',
  'rooms.trusted_identities',
  'rooms.trusted_discord_ids',
  'rooms.trusted_plex_ids',
  'rooms.trusted_discord_role_ids',
  'rooms.single_room',
  'rooms.pause_on_buffering',
  'rooms.single_room_leader',
  'rooms.single_room_leader_plex_id',
  'guests.enabled',
  'guests.default_allow',
  'guests.issuers',
  'guests.require_sign_in',
  'guests.max_per_room',
  'guests.session_hours',
  'events.schedulers',
  'secrets.server_password',
  'access.discord_server',
  'access.source_members',
  'access.password',
  'access.accounts',
  'transcoding.policy',
  'transcoding.encoder',
  'transcoding.outputs',
  'transcoding.max_jobs',
  'transcoding.ubuplayer',
  'transcoding.cpu_fallback',
  'transcoding.hardware_decode',
  'transcoding.qualities',
  'transcoding.allow_original',
  'transcoding.fallback.enabled',
  'transcoding.fallback.height',
  'transcoding.fallback.bitrate',
  'logging.level',
  'logging.requests',
  'logging.file',
  'diagnostics.enabled',
  'diagnostics.keep_days',
  'diagnostics.max_mb',
];

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
  const doc = YAML.parseDocument(String(source || '').replace(/^\uFEFF/, ''), {
    prettyErrors: false,
    uniqueKeys: true,
    version: '1.2',
    stringKeys: true,
  });
  const problem = doc.errors[0] || doc.warnings[0];
  // Parser messages can contain tokens/source text. Never echo them or the file.
  if (problem) throw new Error('Invalid config.yaml YAML (' + problem.code + '); check syntax and duplicate keys');
  let value;
  try {
    value = doc.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error('Invalid config.yaml: YAML aliases are unsupported');
  }
  return value;
}

function normalizeConfig(
  value,
  { base = ROOT, root = ROOT, environment = process.env, platform = process.platform, discoverTools = true } = {},
) {
  const object = (v, label) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(label + ' must be a mapping');
  };
  object(value, 'config.yaml');
  for (const section of Object.keys(value)) {
    // Media sources are a list; each source type checks its own entries (server/sources/).
    if (section === 'sources') continue;
    if (!KEYS.some(key => key.startsWith(section + '.')))
      throw new Error('Unknown config.yaml section; check the example');
    object(value[section], 'Configuration section');
    const validate = (node, prefix) => {
      for (const key of Object.keys(node)) {
        const name = prefix + '.' + key;
        if (KEYS.includes(name)) continue;
        if (name === 'discord.guild_id')
          throw new Error(
            'Remove discord.guild_id. Use discord.excluded_guild_ids for Discord servers that should not grant entry.',
          );
        if (!KEYS.some(known => known.startsWith(name + '.')))
          throw new Error('Unknown setting in ' + section + '; check config.example.yaml');
        object(node[key], 'Configuration section');
        validate(node[key], name);
      }
    };
    validate(value[section], section);
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
    const selected = key.split('.').reduce((node, name) => node?.[name], value);
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
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('server.port must be an integer from 1 to 65535');
  let publicUrl;
  try {
    publicUrl = new URL(get('server.public_url', 'https://localhost:5756'));
  } catch {
    throw new Error('server.public_url must be an HTTPS origin');
  }
  if (
    publicUrl.protocol !== 'https:' ||
    publicUrl.username ||
    publicUrl.password ||
    publicUrl.search ||
    publicUrl.hash ||
    publicUrl.pathname !== '/'
  ) {
    throw new Error('server.public_url must be an HTTPS origin');
  }
  const rawLanUrl = get('server.lan_url', '');
  let lanUrl;
  if (rawLanUrl === 'auto') {
    lanUrl = 'auto';
  } else if (rawLanUrl) {
    let parsedLanUrl;
    try {
      parsedLanUrl = new URL(rawLanUrl);
    } catch {
      throw new Error("server.lan_url must be 'auto' or an HTTPS origin");
    }
    if (
      parsedLanUrl.protocol !== 'https:' ||
      parsedLanUrl.username ||
      parsedLanUrl.password ||
      parsedLanUrl.search ||
      parsedLanUrl.hash ||
      parsedLanUrl.pathname !== '/'
    ) {
      throw new Error("server.lan_url must be 'auto' or an HTTPS origin");
    }
    if (parsedLanUrl.origin === publicUrl.origin) {
      throw new Error('server.lan_url must differ from server.public_url');
    }
    lanUrl = parsedLanUrl.origin;
  }
  const resolveFile = (key, fallback) => path.resolve(base, get(key) || fallback);
  const home = environment.HOME || (platform === 'win32' && environment.USERPROFILE) || os.homedir();
  const keyDirectory =
    platform === 'win32'
      ? environment.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : environment.XDG_DATA_HOME && path.isAbsolute(environment.XDG_DATA_HOME)
          ? environment.XDG_DATA_HOME
          : path.join(home, '.local', 'share');
  const defaultKey = path.join(keyDirectory, 'uburoom', 'credentials.key');
  const credentialKeyFile = resolveFile('storage.credential_key_file', defaultKey);
  const relative = path.relative(ROOT, credentialKeyFile);
  if (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
    throw new Error('storage.credential_key_file must be outside the project folder');
  const explicitFfmpeg = get('tools.ffmpeg');
  const explicitFfprobe = get('tools.ffprobe');
  const ffmpegPath = explicitFfmpeg
    ? resolveFile('tools.ffmpeg')
    : discoverTools
      ? findBundledTool('ffmpeg', root, platform) || findOnPath('ffmpeg', environment, platform)
      : undefined;
  const ffprobePath = explicitFfprobe
    ? resolveFile('tools.ffprobe')
    : discoverTools
      ? (!explicitFfmpeg ? findBundledTool('ffprobe', root, platform) : undefined) ||
        findOnPath('ffprobe', environment, platform) ||
        findSiblingTool(ffmpegPath, 'ffprobe', platform)
      : undefined;
  const config = {
    host: get('server.host', '127.0.0.1'),
    port,
    publicUrl: publicUrl.origin,
    lanUrl,
    tlsCert: resolveFile('server.tls_cert', 'certs/server-cert.pem'),
    tlsKey: resolveFile('server.tls_key', 'certs/server-key.pem'),
    accountFile: path.join(resolveFile('storage.data_directory', 'data'), 'accounts.sqlite'),
    credentialKeyFile,
    botToken: get('discord.bot_token'),
    clientId: get('discord.client_id'),
    clientSecret: get('discord.client_secret'),
    ownerId: get('discord.owner_id'),
    discordExcludedGuildIds: list('discord.excluded_guild_ids') || [],
    channels: list('discord.command_channel_ids') || [],
    shareChannelId: get('discord.share_channel_id'),
    discordRichPresence: boolean('discord.rich_presence', true),
    ffmpegPath,
    ffprobePath,
  };
  config.sources = validateSources(value.sources, {
    base,
    platform,
    dataDirectory: resolveFile('storage.data_directory', 'data'),
  });
  // Entry rules: any one that matches lets a person in (server/admission/). Each sign-in method
  // is offered only for a rule that needs it.
  const sourceMembers = list('access.source_members') || [];
  if (new Set(sourceMembers).size !== sourceMembers.length)
    throw new Error('access.source_members must not repeat a source');
  const memberSignIn = memberIdentities(config.sources, sourceMembers);
  config.accessPolicy = {
    discordServer: boolean('access.discord_server', true),
    sourceMembers,
    password: boolean('access.password', false),
    accounts: boolean('access.accounts', false),
    publicWeb: boolean('server.public_web_app', true),
  };
  // The sign-in methods the entry page offers; derived from the rules above.
  config.accessPolicy.discord = config.accessPolicy.discordServer;
  config.accessPolicy.plex = memberSignIn.includes('plex');
  // Jellyfin sign-in (per Jellyfin source) is offered when a member rule names a Jellyfin source.
  config.accessPolicy.jellyfin = memberSignIn.includes('jellyfin');
  config.serverPassword = get('secrets.server_password');
  if (config.serverPassword.length > 1024)
    throw new Error('secrets.server_password must contain at most 1024 characters');
  if (config.accessPolicy.password && !config.serverPassword)
    throw new Error('access.password requires secrets.server_password');
  if (!config.accessPolicy.password && config.serverPassword)
    throw new Error('secrets.server_password is used only with access.password: true');
  if (config.serverPassword && [...config.serverPassword].length < 8)
    throw new Error('secrets.server_password must contain at least 8 characters');
  if (
    !config.accessPolicy.discordServer &&
    !sourceMembers.length &&
    !config.accessPolicy.password &&
    !config.accessPolicy.accounts
  )
    throw new Error('access needs at least one entry rule: discord_server, source_members, password or accounts');
  const parseIdentity = (entry, setting) => {
    const match = /^(discord|plex|uburoom|jellyfin:[0-9a-f]{32}):(.+)$/.exec(entry);
    const valid =
      match &&
      (match[1] === 'discord'
        ? /^\d{17,20}$/.test(match[2])
        : match[1] === 'plex'
          ? /^\d{1,20}$/.test(match[2])
          : match[1].startsWith('jellyfin:')
            ? /^[0-9a-f]{32}$/.test(match[2])
            : /^[A-Za-z0-9._@-]{1,100}$/.test(match[2]));
    if (!valid)
      throw new Error(
        `${setting} entries are quoted 'discord:<id>', 'plex:<id>', 'uburoom:<subject>' or 'jellyfin:<server id>:<user id>' account identities`,
      );
    return { provider: match[1], subject: match[2] };
  };
  // The server operator: exact verified identities, written provider:subject.
  const operators = list('operator.identities') || [];
  config.serverOperator = {
    identities: operators.map(entry => parseIdentity(entry, 'operator.identities')),
  };
  const adminIdentities = (list('rooms.admin_identities') || []).map(entry =>
    parseIdentity(entry, 'rooms.admin_identities'),
  );
  const trustedIdentities = (list('rooms.trusted_identities') || []).map(entry =>
    parseIdentity(entry, 'rooms.trusted_identities'),
  );
  config.singleRoom = boolean('rooms.single_room', false);
  config.pauseOnBuffering = boolean('rooms.pause_on_buffering', false);
  config.directory = {
    discord: boolean('directory.expose_discord_members', true),
  };
  config.roomLimits = require('./room-limits').configuration(value.rooms);
  const singleRoomLeader = get('rooms.single_room_leader');
  config.singleRoomLeader = singleRoomLeader ? parseIdentity(singleRoomLeader, 'rooms.single_room_leader') : undefined;
  config.singleRoomLeaderPlexId = get('rooms.single_room_leader_plex_id');
  if (config.singleRoomLeaderPlexId && !/^\d{1,20}$/.test(config.singleRoomLeaderPlexId))
    throw new Error('rooms.single_room_leader_plex_id must be a quoted Plex account ID');
  const maxConnections = value.server?.max_connections ?? 256;
  if (!Number.isSafeInteger(maxConnections) || maxConnections < 1 || maxConnections > 4096)
    throw new Error('server.max_connections must be an integer from 1 to 4096');
  config.maxConnections = maxConnections;
  const trustedProxies = list('server.trusted_proxies') || [];
  for (const entry of trustedProxies) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      if (net.isIP(entry) === 0)
        throw new Error('server.trusted_proxies entries must be valid IPv4/IPv6 addresses or CIDRs');
      continue;
    }
    const ip = entry.slice(0, slash);
    const prefixText = entry.slice(slash + 1);
    const version = net.isIP(ip);
    const prefix = /^(?:0|[1-9]\d*)$/.test(prefixText) ? Number(prefixText) : -1;
    const maxPrefix = version === 4 ? 32 : 128;
    if (version === 0 || prefix < 0 || prefix > maxPrefix)
      throw new Error('server.trusted_proxies entries must be valid IPv4/IPv6 addresses or CIDRs');
  }
  config.trustedProxies = trustedProxies;
  // How uburoom listens (docs/tls-and-remote-access.md): its own HTTPS (default), or plain HTTP that
  // only the configured proxies may reach. public_url stays HTTPS and cookies stay Secure either way.
  config.listen = choice('server.listen', 'https', ['https', 'http-proxy']);
  if (config.listen === 'http-proxy' && !trustedProxies.length)
    throw new Error(
      "server.listen: 'http-proxy' needs server.trusted_proxies: the proxies allowed to reach uburoom over plain HTTP",
    );
  config.tlsFilesSet = value.server?.tls_cert !== undefined || value.server?.tls_key !== undefined;
  config.trustedProxyHeader = choice('server.trusted_proxy_header', 'x-forwarded-for', [
    'x-forwarded-for',
    'cf-connecting-ip',
    'x-real-ip',
  ]);
  const maxJobs = value.transcoding?.max_jobs ?? 5;
  if (!Number.isSafeInteger(maxJobs) || maxJobs < 1 || maxJobs > 32)
    throw new Error('transcoding.max_jobs must be an integer from 1 to 32');
  const outputs = list('transcoding.outputs') ?? ['av1', 'provider'];
  const { localFormat } = require('../shared/playback-policy.mjs');
  if (outputs.some(output => output !== 'provider' && !localFormat(output)))
    throw new Error('transcoding.outputs supports av1, vp9, vp8 and provider');
  if (new Set(outputs).size !== outputs.length) throw new Error('transcoding.outputs must not repeat an output');
  const formats = outputs.filter(output => output !== 'provider');
  const ubuplayer = boolean('transcoding.ubuplayer', true);
  config.ubuplayer = ubuplayer;
  config.transcoding = {
    policy: choice('transcoding.policy', 'follow_provider', ['follow_provider', 'disabled', 'override']),
    outputs,
    // Whether a provider's own transcoder may be used, where the provider has one.
    provider: outputs.includes('provider'),
    uburoom: formats.length > 0,
    ubuplayer,
    encoder: choice('transcoding.encoder', 'auto', ['auto', 'hardware', 'qsv', 'nvenc', 'software']),
    cpuFallback: boolean('transcoding.cpu_fallback', true),
    hardwareDecode: boolean('transcoding.hardware_decode', true),
    formats,
    maxJobs,
  };
  const { QUALITIES, qualityDefinition } = require('../shared/room-protocol.mjs');
  const fallbackHeight = value.transcoding?.fallback?.height ?? 720,
    fallbackBitrate = value.transcoding?.fallback?.bitrate ?? 2;
  if (
    typeof fallbackHeight !== 'number' ||
    typeof fallbackBitrate !== 'number' ||
    !qualityDefinition(fallbackHeight + 'p' + fallbackBitrate)
  )
    throw new Error('transcoding.fallback requires an even height 144-4320 and bitrate 0.1-200 Mbps');
  config.transcoding.fallback = {
    enabled: boolean('transcoding.fallback.enabled', false),
    height: fallbackHeight,
    bitrate: fallbackBitrate,
  };
  if (config.transcoding.fallback.enabled && (!formats.length || config.transcoding.policy === 'disabled'))
    throw new Error('transcoding.fallback requires an enabled uburoom output');
  const pairs = value.transcoding?.qualities;
  if (
    pairs !== undefined &&
    (!Array.isArray(pairs) ||
      pairs.length > 32 ||
      pairs.some(
        pair =>
          !Array.isArray(pair) ||
          pair.length !== 2 ||
          pair.some(n => typeof n !== 'number') ||
          !qualityDefinition(pair[0] + 'p' + pair[1]),
      ))
  )
    throw new Error(
      'transcoding.qualities requires up to 32 [height, Mbps] pairs, even heights 144-4320 and 0.1-200 Mbps',
    );
  const configured =
    pairs === undefined ? QUALITIES.slice(1) : pairs.map(([height, mbps]) => qualityDefinition(height + 'p' + mbps));
  if (new Set(configured.map(q => q.id)).size !== configured.length)
    throw new Error('transcoding.qualities must not repeat a quality');
  config.transcoding.qualities = [
    ...(boolean('transcoding.allow_original', true) ? [QUALITIES[0]] : []),
    ...configured,
  ].sort(
    (a, b) => (b.height || Infinity) - (a.height || Infinity) || (b.bitrate || Infinity) - (a.bitrate || Infinity),
  );
  if (!config.transcoding.qualities.length) throw new Error('Offer Original or at least one transcoding quality');
  if (
    !config.accessPolicy.publicWeb &&
    (!config.accessPolicy.discord || !config.clientId || !config.clientSecret || !config.ownerId)
  )
    throw new Error('Activity-only access requires Discord authorization and configured client credentials/owner');
  if (!config.accessPolicy.publicWeb && !config.botToken)
    throw new Error('Activity-only access requires a Discord bot for verified membership');
  if (
    config.singleRoom &&
    !config.singleRoomLeader &&
    !config.singleRoomLeaderPlexId &&
    !config.serverOperator.identities.length
  ) {
    if (!config.accessPolicy.discord && config.accessPolicy.plex) {
      if (!ownerAccountSources(config.sources).length)
        throw new Error(
          'Single-room mode requires a Plex source, rooms.single_room_leader or rooms.single_room_leader_plex_id',
        );
    } else if (!config.ownerId)
      throw new Error(
        'Single-room mode requires discord.owner_id, operator.identities, rooms.single_room_leader or rooms.single_room_leader_plex_id for fixed room leadership',
      );
  }
  if (!config.host.trim()) throw new Error('server.host must not be empty');
  for (const key of ['clientId', 'ownerId']) {
    if (config[key] && !/^\d{17,20}$/.test(config[key]))
      throw new Error('discord IDs must be quoted numeric Developer Mode IDs');
  }
  if (
    config.discordExcludedGuildIds.some(id => !/^\d{17,20}$/.test(id)) ||
    new Set(config.discordExcludedGuildIds).size !== config.discordExcludedGuildIds.length
  )
    throw new Error('discord.excluded_guild_ids requires distinct quoted Discord server IDs');
  if (config.channels.some(id => !/^\d{17,20}$/.test(id)))
    throw new Error('discord.command_channel_ids requires exact quoted IDs');
  if (config.shareChannelId && !/^\d{17,20}$/.test(config.shareChannelId))
    throw new Error('discord.share_channel_id requires one quoted Discord channel ID');
  if (config.shareChannelId && !config.botToken) throw new Error('discord.share_channel_id requires discord.bot_token');
  const logFile = get('logging.file');
  config.logging = {
    level: choice('logging.level', 'info', ['error', 'warn', 'info', 'debug']),
    requests: boolean('logging.requests', true),
    file: logFile ? resolveFile('logging.file') : '',
  };
  const keepDays = value.diagnostics?.keep_days ?? 7,
    maxMb = value.diagnostics?.max_mb ?? 500;
  if (!Number.isInteger(keepDays) || keepDays < 1 || keepDays > 365)
    throw new Error('diagnostics.keep_days must be a whole number of days from 1 to 365');
  if (!Number.isInteger(maxMb) || maxMb < 10 || maxMb > 100000)
    throw new Error('diagnostics.max_mb must be a whole number from 10 to 100000');
  config.diagnostics = {
    enabled: boolean('diagnostics.enabled', true),
    keepDays,
    maxBytes: maxMb * 1024 * 1024,
    directory: path.join(resolveFile('storage.data_directory', 'data'), 'diagnostics'),
  };
  Object.assign(config, Policy.configuration(value.rooms || {}));
  config.roomAdministrators = { ...config.roomAdministrators, identities: adminIdentities };
  config.trustedMembers = { ...config.trustedMembers, identities: trustedIdentities };
  const whole = (key, fallback, min, max) => {
    const selected = value.guests?.[key] ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < min || selected > max)
      throw new Error(`guests.${key} must be a whole number from ${min} to ${max}`);
    return selected;
  };
  config.guests = {
    enabled: boolean('guests.enabled', false),
    defaultAllow: boolean('guests.default_allow', true),
    issuers: choice('guests.issuers', 'admins', Policy.TIERS),
    requireSignIn: boolean('guests.require_sign_in', false),
    maxPerRoom: whole('max_per_room', 10, 1, 50),
    sessionHours: whole('session_hours', 24, 1, 720),
  };
  config.events = { schedulers: choice('events.schedulers', 'trusted', Policy.TIERS) };
  if (config.guests.enabled && !config.accessPolicy.publicWeb)
    throw new Error('Guests need the public web app (server.public_web_app: true)');
  return config;
}

function applyLoggingFlags(logging, args = process.argv.slice(2)) {
  if (!logging) return;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--verbose') {
      if (logging.level === 'error' || logging.level === 'warn') logging.level = 'info';
      logging.requests = true;
    } else if (arg === '--debug') {
      logging.level = 'debug';
      logging.requests = true;
    } else if (arg === '--log-level' || arg.startsWith('--log-level=')) {
      const lvl = arg === '--log-level' ? args[++i] : arg.slice(12);
      if (['error', 'warn', 'info', 'debug'].includes(lvl?.toLowerCase())) {
        logging.level = lvl.toLowerCase();
      }
    }
  }
}

function loadConfig(file = configPath(), args = process.argv.slice(2)) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'Missing config.yaml. Copy config.example.yaml and configure your installation. Never share your private config.',
      );
    throw new Error('Cannot read private configuration file (' + error.code + ')');
  }
  const selectedPath = path.resolve(file);
  const config = normalizeConfig(parseConfig(source), { base: path.dirname(selectedPath) });
  config.configFile = selectedPath;
  applyLoggingFlags(config.logging, args);
  return config;
}

module.exports = { ROOT, configPath, parseConfig, normalizeConfig, loadConfig, applyLoggingFlags };
