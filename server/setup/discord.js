'use strict';
// @ts-check
/**
 * Everything Discord-specific in first-run setup, in one place: checking the application the owner
 * made, finding which servers its bot has joined, the link that adds the bot to another server, and
 * the settings written for the Discord entry rule.
 */
const API = 'https://discord.com/api/v10';
const SNOWFLAKE = /^\d{17,20}$/;
// The bot scope with the permissions uburoom's optional Discord features use: publishing a room
// (View Channel, Send Messages, Embed Links, Read Message History) and posting watch nights (Create
// Events). None is needed to let members in; the owner can untick them when adding the bot.
const BOT_PERMISSIONS = String(1024 + 2048 + 16384 + 65536 + 2 ** 44);
const MAX_SERVERS = 200;

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const text = (value, limit = 100) =>
  typeof value === 'string'
    ? value
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';

/**
 * What the owner pasted, checked for shape before anything is sent anywhere.
 * @param {any} input
 */
function credentials(input) {
  const clientId = typeof input?.clientId === 'string' ? input.clientId.trim() : '';
  const clientSecret = typeof input?.clientSecret === 'string' ? input.clientSecret.trim() : '';
  const botToken = typeof input?.botToken === 'string' ? input.botToken.trim() : '';
  if (!SNOWFLAKE.test(clientId)) throw fail('Paste the Application ID from General Information');
  if (!clientSecret || clientSecret.length > 200 || /\s/.test(clientSecret))
    throw fail('Paste the client secret from OAuth2');
  if (botToken.length < 20 || botToken.length > 200 || /\s/.test(botToken))
    throw fail('Paste the bot token from Bot (reset it to see a new one)');
  return { clientId, clientSecret, botToken };
}

/** One Discord API answer as JSON, or undefined when Discord refuses the credential. */
async function call(fetcher, resource, init) {
  let response;
  try {
    response = await fetcher(API + resource, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
  } catch {
    throw fail('Couldn’t reach Discord; check this computer’s internet connection', 502);
  }
  if ([401, 403].includes(response.status)) {
    void response.body?.cancel().catch(() => {});
    return undefined;
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw fail('Discord didn’t answer as expected; try again', 502);
  }
  return response.json();
}
const bot = token => ({ headers: { Authorization: 'Bot ' + token, Accept: 'application/json' } });

/**
 * The servers this bot has joined, by name. The one lookup of joined servers: setup and, later,
 * Server settings ask here.
 * @param {string} botToken
 * @param {typeof fetch} fetcher
 * @returns {Promise<{id: string, name: string, memberCount?: number}[]>}
 */
async function joinedServers(botToken, fetcher) {
  const servers = new Map();
  let after;
  for (;;) {
    const query = new URLSearchParams({ limit: String(MAX_SERVERS), with_counts: 'true', ...(after ? { after } : {}) });
    const page = await call(fetcher, '/users/@me/guilds?' + query, bot(botToken));
    if (!page) throw fail('Discord refused the bot token; reset it under Bot and paste the new one');
    if (!Array.isArray(page)) throw fail('Discord didn’t return a server list', 502);
    for (const guild of page) {
      if (!SNOWFLAKE.test(String(guild?.id))) continue;
      servers.set(String(guild.id), {
        id: String(guild.id),
        name: text(guild.name) || 'Discord server',
        ...(Number.isSafeInteger(guild.approximate_member_count) && guild.approximate_member_count >= 0
          ? { memberCount: guild.approximate_member_count }
          : {}),
      });
    }
    if (page.length < MAX_SERVERS) return [...servers.values()];
    const next = String(page.at(-1)?.id);
    if (!SNOWFLAKE.test(next) || (after && BigInt(next) <= BigInt(after)) || servers.size >= 1000)
      throw fail('Discord returned too many servers to review here', 502);
    after = next;
  }
}

/** The page that adds this application's bot to a server the owner chooses. */
function inviteUrl(clientId) {
  return (
    'https://discord.com/oauth2/authorize?' +
    new URLSearchParams({ client_id: clientId, scope: 'bot', permissions: BOT_PERMISSIONS })
  );
}

/**
 * Checks the application, its secret and its bot together, and finds the joined servers. The owner
 * of the installation (`discord.owner_id`) is the application's owner, or its team's owner.
 * @param {any} input - `{clientId, clientSecret, botToken}` as pasted
 * @param {{fetch?: typeof fetch}} [services]
 */
async function verify(input, { fetch: fetcher = fetch } = {}) {
  const pasted = credentials(input);
  const application = await call(fetcher, '/oauth2/applications/@me', bot(pasted.botToken));
  if (!application) throw fail('Discord refused the bot token; reset it under Bot and paste the new one');
  if (String(application.id) !== pasted.clientId)
    throw fail('That bot token belongs to a different application than this Application ID');
  const ownerId = String(application.team ? application.team.owner_user_id : application.owner?.id);
  if (!SNOWFLAKE.test(ownerId)) throw fail('Discord didn’t say who owns this application; try again', 502);
  // The secret is checked by asking for an application token with it, which Discord refuses if wrong.
  const token = await call(fetcher, '/oauth2/token', {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(pasted.clientId + ':' + pasted.clientSecret).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'identify' }),
  });
  if (!token) throw fail('Discord refused the client secret; reset it under OAuth2 and paste the new one');
  const servers = await joinedServers(pasted.botToken, fetcher);
  return {
    ...pasted,
    ownerId,
    name: text(application.name) || 'Discord application',
    servers,
  };
}

/**
 * What the browser may see of a verified application: never the secret or token.
 * @param {Awaited<ReturnType<typeof verify>>} verified
 * @param {string} publicUrl - where uburoom will run, for the redirect to add in the Developer Portal
 */
function summary(verified, publicUrl) {
  return {
    application: verified.name,
    servers: verified.servers,
    inviteUrl: inviteUrl(verified.clientId),
    redirectUrl: publicUrl + '/auth/callback',
  };
}

/**
 * The config settings the Discord entry rule writes, or a reason it can't be on yet.
 * @param {Awaited<ReturnType<typeof verify>>} verified
 * @param {string[]} [excluded]
 */
function settings(verified, excluded = []) {
  if (!verified.servers.length) throw fail('Add the bot to a Discord server first, then check again');
  return {
    discord: {
      bot_token: verified.botToken,
      client_id: verified.clientId,
      client_secret: verified.clientSecret,
      owner_id: verified.ownerId,
      excluded_guild_ids: excluded,
    },
  };
}

module.exports = { verify, summary, settings, joinedServers, inviteUrl, credentials };
