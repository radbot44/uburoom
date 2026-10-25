'use strict';
const { Client, GatewayIntentBits, Events } = require('discord.js');
const { discordAccess } = require('./sharing');

function loginFailure(error) {
  const code = error?.cause?.code || error?.code;
  if (code === 'UBUROOM_LOGIN_TIMEOUT') return new Error('Discord login timed out after 30 seconds. Check the server can reach discord.com and gateway.discord.gg over HTTPS/WSS, then retry.');
  if (code === 'TokenInvalid' || code === 4004 || error?.status === 401) return new Error('Discord rejected the bot token. Put the Bot page token in DISCORD_BOT_TOKEN; the OAuth client secret is a different value.');
  if (code === 4014 || /disallowed intents/i.test(error?.message || '')) return new Error('Discord rejected the requested privileged Gateway intents. Check the application\'s Bot page settings, save, and restart uburoom.');
  if (code === 4013 || /invalid intents/i.test(error?.message || '')) return new Error('Discord rejected the requested Gateway intents. Check the installed discord.js version and Bot settings.');
  const networkCodes = ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN'];
  if (networkCodes.includes(code)) return new Error(`Discord connection failed (${code}). Check the server's internet connection, DNS, firewall, proxy and system clock.`);
  return new Error('Discord login failed. Verify the bot token and the server\'s connection to Discord.');
}

async function connectBot(client, token, timeoutMs = 30000) {
  let timer, onReady;
  const ready = new Promise(resolve => { onReady = resolve; client.once(Events.ClientReady, onReady); });
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Login timeout'), { code: 'UBUROOM_LOGIN_TIMEOUT' })), timeoutMs);
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

async function startBot(config, hub, { createClient = options => new Client(options) } = {}) {
  const log = config.logger ? config.logger.child('Discord') : {
    info: (...args) => console.log('[Discord] ' + args.join(' ')),
    warn: (...args) => console.warn('[Discord] ' + args.join(' ')),
    error: (...args) => console.error('[Discord] ' + args.join(' '))
  };
  if (!config.botToken) { log.info('Not configured. Browser playback and HTTPS setup are available.'); return; }
  if (!config.ownerId || !config.guildId) throw new Error('Configure Discord owner and guild');
  const client = createClient({ rest: { timeout:10000,retries:0,rejectOnRateLimit:()=>true }, intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
  if (client.rest?.setToken && client.options?.intents?.add) {
    try {
      client.rest.setToken(config.botToken);
      const application = await client.rest.get('/oauth2/applications/@me');
      const flags = Number(application.flags || 0);
      if (config.directory?.discord !== false) {
        if (flags & ((1<<14)|(1<<15))) client.options.intents.add(GatewayIntentBits.GuildMembers);
        else log.warn('Host search cannot list new members: enable Server Members Intent in the Developer Portal.');
      }
      if (flags & ((1<<12)|(1<<13))) client.options.intents.add(GatewayIntentBits.GuildPresences);
      else log.warn('Host search cannot show Discord availability: enable Presence Intent in the Developer Portal.');
    } catch { log.warn('Could not check optional directory intents. Known uburoom account search remains available.'); }
  }
  hub.access = discordAccess(client, config.guildId);
  client.on(Events.ClientReady, () => log.info('Connected to the configured guild.'));
  client.on(Events.Error, error => log.error(loginFailure(error).message));
  client.on(Events.ShardError, error => log.error(loginFailure(error).message));
  client.on(Events.ShardDisconnect, event => log.warn('Gateway disconnected' + (Number.isInteger(event.code) ? ` (code ${event.code})` : '') + '.'));
  client.on(Events.ShardReconnecting, () => log.info('Reconnecting to the Gateway...'));
  log.info('Connecting... waiting up to 30 seconds for the bot to become ready.');
  await connectBot(client, config.botToken);
  try { hub.setOwnerName?.((await client.users.fetch(config.ownerId)).username); }
  catch { /* Retain the last authenticated account name if Discord lookup fails. */ }
  // Clear any previously registered guild commands.
  try { await client.application?.commands?.set([], config.guildId); } catch {}
  return client;
}
module.exports = { startBot, connectBot };
