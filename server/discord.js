'use strict';
const { Client, GatewayIntentBits, Events, MessageFlags, ApplicationCommandOptionType } = require('discord.js');
const Engine = require('../extension/engine');
const { discordAccess } = require('./sharing');

const slashCommand = { name: 'radtv', description: 'Control an enabled uburoom player', options: [
  { name: 'command', description: 'For example: pause, volume 50, zoom 150%, reset all, or off', type: ApplicationCommandOptionType.String, required: true, max_length: 140 },
  { name: 'target', description: 'Player name (for example bob #1); only needed with several available players', type: ApplicationCommandOptionType.String, max_length: 104 }
] };
function slashInput(options) {
  const target = options.getString('target')?.trim().toLowerCase();
  if (target && !/^[a-z0-9_][a-z0-9_.-]{0,99}(?: ?#[1-9][0-9]?)?$/.test(target)) throw new Error('Invalid target');
  // Parse exactly the same vocabulary as text commands; a command cannot override target.
  const input = Engine.parse('!radtv ' + options.getString('command', true));
  return { ...input, target: target || undefined };
}
function replyText(result) {
  return `${result.status}: ${result.message}${result.latencyMs === undefined ? '' : ' (' + result.latencyMs + ' ms server round trip)'}`;
}
function helpText(website) {
  return [
    '**uburoom commands**',
    'Use `!radtv <command>` when one player is available, or `!radtv.<player> <command>` to choose a player.',
    '',
    '**Playback & sound**',
    '• `play` / `pause` — start or pause playback',
    '• `toggle` — switch play/pause',
    '• `mute` / `unmute` — turn sound off/on',
    '• `volume 50` — set volume from 0 to 100%',
    '• `seek -15` / `seek 15` — go back/forward in seconds (up to 600; available DVR/recordings only)',
    '• `start` / `end` / `live` — jump to the available beginning or latest end',
    '',
    '**Picture & profiles**',
    '• `zoom 150%` — set zoom (10–1600%; `zoom 1.5` also works)',
    '• `zoom +5%` / `zoom -5%` — increase/decrease zoom',
    '• `reset zoom` / `reset stretch` / `reset pan` / `reset all` — reset picture settings',
    '• `profile load 1` — load a saved profile (slots 1–9)',
    '• `profile save 1` — save the current picture (host only)',
    '',
    '**Remote**',
    '• `status` — check the player responds',
    '• `off` — disable remote access (host only)',
    '• `help` — show this list',
    '',
    'Blank player names use the host’s Discord username: `bob`, or `bob #1` / `bob #2` with multiple players.',
    'Examples: `!radtv.livingroom volume 50`, `!radtv.bob#1 pause`',
    'Slash commands: `/radtv command:volume 50 target:livingroom` (target optional with one player).',
    'Enable and permissions: Firefox controls or the host’s website. Guests must share the host’s current voice channel or be actively watching that session. The owner can opt into Admin mode on the website.',
    `**Web remote:** ${website}`
  ].join('\n');
}

function loginFailure(error) {
  const code = error?.cause?.code || error?.code;
  if (code === 'RADTV_LOGIN_TIMEOUT') return new Error('Discord login timed out after 30 seconds. Check the server can reach discord.com and gateway.discord.gg over HTTPS/WSS, then retry.');
  if (code === 'TokenInvalid' || code === 4004 || error?.status === 401) return new Error('Discord rejected the bot token. Put the Bot page token in DISCORD_BOT_TOKEN; the OAuth client secret is a different value.');
  if (code === 4014 || /disallowed intents/i.test(error?.message || '')) return new Error('Discord rejected Message Content Intent. Enable it on the application\'s Bot page, save, and restart uburoom.');
  if (code === 4013 || /invalid intents/i.test(error?.message || '')) return new Error('Discord rejected the requested Gateway intents. Check the installed discord.js version and Bot settings.');
  const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'];
  if (networkCodes.includes(code)) return new Error(`Discord connection failed (${code}). Check the server's internet connection, DNS, firewall, proxy and system clock.`);
  return new Error('Discord login failed. Verify the bot token, Message Content Intent and the server\'s connection to Discord.');
}

async function connectBot(client, token, timeoutMs = 30000) {
  let timer, onReady;
  const ready = new Promise(resolve => { onReady = resolve; client.once(Events.ClientReady, onReady); });
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Login timeout'), { code: 'RADTV_LOGIN_TIMEOUT' })), timeoutMs);
  });
  try {
    await Promise.race([Promise.all([client.login(token), ready]), timeout]);
  } catch (error) {
    await client.destroy().catch(() => {});
    throw loginFailure(error);
  } finally {
    clearTimeout(timer);
    client.off(Events.ClientReady, onReady);
  }
}

function watchVoice(config, client, hub) {
  client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    if (newState.guild.id === config.guildId && newState.id === config.ownerId && oldState.channelId !== newState.channelId) {
      hub.publishVoice(!!newState.channelId);
    }
  });
  for (const event of [Events.ClientReady, Events.ShardReady, Events.ShardResume]) client.on(event, () => hub.publishVoice());
  for (const event of [Events.ShardDisconnect, Events.ShardReconnecting]) client.on(event, () => hub.publishVoice(false, true));
  client.on(Events.GuildUnavailable, guild => { if (guild.id === config.guildId) hub.publishVoice(false, true); });
  client.on(Events.GuildAvailable, guild => { if (guild.id === config.guildId) hub.publishVoice(); });
}
async function startBot(config, hub) {
  if (!config.botToken) { console.log('[Discord] Not configured. Local picture controls and HTTPS setup are available.'); return; }
  if (!config.ownerId || !config.guildId || !config.channels.length) throw new Error('Configure Discord owner, guild and command channels');
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.GuildVoiceStates] });
  hub.access = discordAccess(client, config.guildId);
  watchVoice(config, client, hub);
  const buckets = new Map();
  function rateLimited(userId) {
    const now = Date.now(); let bucket = buckets.get(userId);
    if (!bucket || now - bucket.at > 2000) bucket = { at: now, count: 0 };
    buckets.set(userId, bucket);
    for (const [id, b] of buckets) if (now - b.at > 10000) buckets.delete(id);
    return ++bucket.count > 5;
  }
  client.on(Events.ClientReady, () => console.log('[Discord] Connected. Commands follow each tab\'s local sharing settings in configured command channels.'));
  client.on(Events.Error, error => console.error('[Discord] ' + loginFailure(error).message));
  client.on(Events.ShardError, error => console.error('[Discord] ' + loginFailure(error).message));
  client.on(Events.ShardDisconnect, event => console.warn('[Discord] Gateway disconnected' + (Number.isInteger(event.code) ? ` (code ${event.code})` : '') + '. Commands unavailable until reconnected.'));
  client.on(Events.ShardReconnecting, () => console.log('[Discord] Reconnecting to the Gateway...'));
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot || !/^!radtv(?:\.|\s|$)/i.test(message.content)) return;
    // Forbidden channels get no reply and no player data.
    if (message.guildId !== config.guildId || !config.channels.includes(message.channelId)) return;
    try {
      const key = message.author.id;
      if (rateLimited(key)) return;
      const actor = { userId: key, name: message.member?.displayName || message.author.globalName || message.author.username,
        guildId: message.guildId, channelId: message.channelId };
      const input = Engine.parse(message.content);
      const content = input.action === 'help.get' ? helpText(config.publicUrl) : replyText(await hub.dispatch(actor, input));
      await message.reply({ content,
        allowedMentions: { parse: [], repliedUser: false } });
    } catch {
      await message.reply({ content: 'Use `!radtv help` for all commands and examples.', allowedMentions: { parse: [], repliedUser: false } }).catch(() => {});
    }
  });
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'radtv') return;
    try {
      if (interaction.guildId !== config.guildId || !config.channels.includes(interaction.channelId) || interaction.user.bot) {
        await interaction.reply({ content: 'forbidden: Use a configured uburoom command channel.', flags: MessageFlags.Ephemeral }); return;
      }
      if (rateLimited(interaction.user.id)) {
        await interaction.reply({ content: 'Please wait before sending another command.', flags: MessageFlags.Ephemeral }); return;
      }
      const input = slashInput(interaction.options);
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const actor = { userId: interaction.user.id, name: interaction.member?.displayName || interaction.member?.nick || interaction.user.globalName || interaction.user.username,
        guildId: interaction.guildId, channelId: interaction.channelId };
      await interaction.editReply({ content: input.action === 'help.get' ? helpText(config.publicUrl) : replyText(await hub.dispatch(actor, input)), allowedMentions: { parse: [] } });
    } catch {
      const content = 'Use `/radtv command:help` for all commands and examples.';
      if (interaction.deferred) await interaction.editReply({ content }).catch(() => {});
      else if (!interaction.replied) await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  });
  console.log('[Discord] Connecting... waiting up to 30 seconds for the bot to become ready.');
  await connectBot(client, config.botToken);
  try { hub.setOwnerName?.((await client.users.fetch(config.ownerId)).username); }
  catch { /* Retain the last authenticated account name if Discord lookup fails. */ }
  // Guild-scoped upsert preserves any other application commands; no global publication.
  try {
    await client.application.commands.create(slashCommand, config.guildId);
    console.log('[Discord] /radtv registered in the configured server.');
  } catch { console.warn('[Discord] Could not register /radtv. Check the bot installation includes applications.commands. Text commands remain available.'); }
  return client;
}
module.exports = { startBot, connectBot, slashInput, helpText, watchVoice };
