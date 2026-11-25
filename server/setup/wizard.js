'use strict';
// @ts-check
/**
 * The first-run wizard's draft: what each step chose, validated by the server as it is chosen, and
 * the config it adds up to (docs/first-run-setup.md, "Wizard steps"). One draft per setup server,
 * whoever holds the current setup session; nothing is written until Finish.
 *
 * Secrets (the Plex sign-in, source tokens and keys, Discord credentials, the server password and
 * the account's password hash) stay here and in the written file; `view()` and every step's answer
 * leave them out.
 */
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateSources, sourceType } = require('../sources');
const flowsCore = require('../source-flows');
const { normalizeUsername, hashPassword, PROVIDER: UBUROOM } = require('../identity/accounts');
const discord = require('./discord');

const OWNER = 'setup';
const DEFAULT_PORT = 5756;
const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/** Whether an IPv4 address is in a private (home network) range. */
const privateV4 = address =>
  /^10\./.test(address) || /^192\.168\./.test(address) || /^172\.(1[6-9]|2\d|3[01])\./.test(address);

/**
 * This machine's address on the home network: the address the owner's browser used to reach setup,
 * when that is one (a container or NAS), otherwise this machine's private IPv4 address.
 * @param {string|undefined} requestHost - the hostname the setup page was opened at
 */
function homeAddress(requestHost, interfaces = os.networkInterfaces()) {
  const literal = requestHost?.replace(/^\[|\]$/g, '');
  if (literal && net.isIP(literal) && !LOOPBACK.has(literal) && literal !== '0.0.0.0') return literal;
  const found = Object.values(interfaces)
    .flat()
    .filter(entry => entry && entry.family === 'IPv4' && !entry.internal)
    .map(entry => entry.address);
  return found.find(privateV4) || found[0];
}

/**
 * @param {{configFile: string, setupHost: string, setupPort: () => number, published: boolean, plexTv: any, plexFetch?: typeof fetch,
 *   jellyfinFetch?: typeof fetch, jellyfinDiscover?: () => Promise<any[]>, discordFetch?: typeof fetch,
 *   platform?: string, origin: () => string}} services - `origin` is where the setup page is open now
 */
function createWizard({
  configFile,
  setupHost,
  setupPort,
  published,
  plexTv,
  plexFetch = fetch,
  jellyfinFetch = fetch,
  youtubeFetch = fetch,
  youtubeRunner,
  jellyfinDiscover,
  discordFetch = fetch,
  platform = process.platform,
  origin,
}) {
  const base = path.dirname(configFile);
  const tools = { plexFetch, jellyfinFetch, youtubeFetch, ...(youtubeRunner ? { youtubeRunner } : {}) };
  const context = { base, platform, dataDirectory: path.resolve(base, 'data') };
  // Setup bound beyond loopback (a container, a NAS) is reached from elsewhere; so is uburoom after it.
  const wide = !LOOPBACK.has(setupHost);

  /** @type {{account?: any, plexAttempt?: any, sources: any[], access?: any, discord?: any, network?: any}} */
  const draft = { sources: [] };

  const flows = flowsCore.createSourceFlows({
    stepServices: {
      ...tools,
      base,
      plexTv,
      platform,
      ...(jellyfinDiscover ? { discover: jellyfinDiscover } : {}),
      get publicUrl() {
        return origin();
      },
      get signInReturn() {
        return origin() + '/setup/signed-in';
      },
      // A Plex source is added with the Plex sign-in of step 2, when the account is one.
      signedIn: kind => (draft.account?.provider === kind ? draft.account.identity : undefined),
    },
  });

  // ----- Step 2: your account -----

  const accountView = () =>
    draft.account ? { provider: draft.account.provider, name: draft.account.name } : undefined;
  const account = {
    /** Starts a plex.tv PIN sign-in; the page opens the returned address. */
    async plexStart() {
      draft.plexAttempt = { ...(await plexTv.start(origin() + '/setup/signed-in')), expires: Date.now() + 600000 };
      return { url: draft.plexAttempt.url };
    },
    /** The Plex account once the PIN is approved (`waiting` until then). */
    async plexPoll() {
      const attempt = draft.plexAttempt;
      if (!attempt || attempt.expires <= Date.now()) throw fail('Start the Plex sign-in again', 410);
      let identity;
      try {
        identity = await plexTv.identify(attempt);
      } catch (error) {
        if (/not completed/.test(String(error.message)) || error.revoked) return { waiting: true };
        throw fail('Plex sign-in failed; start again', 502);
      }
      if (draft.plexAttempt !== attempt) throw fail('Start the Plex sign-in again', 410);
      draft.plexAttempt = undefined;
      draft.account = { provider: 'plex', subject: identity.subject, name: identity.name, identity };
      return { account: accountView() };
    },
    /** A uburoom account: its password is hashed now and kept only as the hash. */
    async create(data) {
      let username;
      try {
        username = normalizeUsername(data.username);
      } catch (error) {
        throw fail(error.message);
      }
      let hashed;
      try {
        hashed = await hashPassword(data.password);
      } catch (error) {
        throw fail(error.message, error.code === 'ACCOUNT_BUSY' ? 429 : 400);
      }
      draft.plexAttempt = undefined;
      draft.account = { provider: UBUROOM, subject: randomUUID(), username, name: username, hashed };
      return { account: accountView() };
    },
    clear() {
      draft.plexAttempt = undefined;
      draft.account = undefined;
      return {};
    },
  };

  // ----- Step 3: media sources -----

  /** The draft's sources, normalized, or the reason they are not valid together. */
  function normalized(list = draft.sources) {
    try {
      return validateSources(list, context);
    } catch (error) {
      throw fail('Not added: ' + String(error.message).slice(0, 300));
    }
  }
  const sourcesView = () => normalized().map(flowsCore.describe);
  function index(id) {
    const at = draft.sources.findIndex(entry => entry.id === id);
    if (at < 0) throw fail('That source is no longer in the list', 404);
    return at;
  }
  const sources = {
    list: () => ({ sources: sourcesView(), types: flowsCore.addableTypes() }),
    open: type => flows.open(OWNER, type),
    step: data => flows.step(OWNER, data),
    add(data) {
      const entry = flows.entry(OWNER, data, normalized());
      normalized([...draft.sources, entry]);
      draft.sources.push(entry);
      flows.close(data.flow);
      return sources.list();
    },
    async update(data) {
      const at = index(data.id);
      const current = normalized()[at];
      const { name, libraries } = flowsCore.updateRequest(current, data);
      let next = { ...draft.sources[at] };
      if (name !== undefined) {
        if (name) next.name = name;
        else delete next.name;
      }
      if (libraries !== undefined) next.libraries = libraries;
      // A type's own settings (folders: what its library holds), applied by its module.
      if (data.settings !== undefined) {
        const update = sourceType(current.type).setup.update;
        if (!update) throw fail('This source has no other settings to change');
        const transform = await update(data.settings, {
          ...tools,
          base,
          platform,
          current,
          existing: normalized().filter((source, i) => source.type === current.type && i !== at),
        });
        next = transform(next);
      }
      const list = draft.sources.map((entry, i) => (i === at ? next : entry));
      normalized(list);
      draft.sources = list;
      return sources.list();
    },
    remove(data) {
      const at = index(data.id);
      draft.sources.splice(at, 1);
      if (draft.access) draft.access.sourceMembers = draft.access.sourceMembers.filter(id => id !== data.id);
      return sources.list();
    },
    details: id => flowsCore.details(normalized()[index(id)], tools),
  };

  // ----- Step 4: who can get in -----

  /** The sources whose members can be let in, and whether each is how the operator gets in. */
  function memberSources() {
    return normalized()
      .filter(entry => sourceType(entry.type).memberIdentity)
      .map(entry => ({
        id: entry.id,
        name: entry.name || entry.id,
        type: entry.type,
        identity: sourceType(entry.type).memberIdentity,
      }));
  }
  /** The rules that are how the operator's own account gets in (one of them must stay on). */
  function operatorWays() {
    const provider = draft.account?.provider;
    if (!provider) return { accounts: false, sources: [] };
    return {
      accounts: provider === UBUROOM,
      sources: memberSources()
        .filter(source => source.identity === provider)
        .map(source => source.id),
    };
  }
  const defaults = () => ({
    sourceMembers: memberSources().map(source => source.id),
    password: false,
    accounts: true,
    guests: true,
    discord: false,
    excludedGuildIds: [],
  });
  const rules = () => {
    const chosen = draft.access || defaults();
    const ids = new Set(memberSources().map(source => source.id));
    return { ...chosen, sourceMembers: chosen.sourceMembers.filter(id => ids.has(id)) };
  };
  /** Where uburoom will be opened, as chosen in step 5 (or the default until then). */
  const publicUrl = () => draft.network?.publicUrl || networkOptions(setupPort()).computer;
  const accessView = () => {
    const { password: _password, ...chosen } = rules();
    return {
      ...chosen,
      password: !!draft.access?.password,
      sources: memberSources().map(({ id, name, type }) => ({ id, name, type })),
      operator: operatorWays(),
      discordSetup: draft.discord ? discord.summary(draft.discord, publicUrl()) : undefined,
      redirectUrl: publicUrl() + '/auth/callback',
    };
  };
  const access = {
    view: accessView,
    /** Checks the Discord application and finds the servers its bot has joined. */
    async discord(data) {
      draft.discord = await discord.verify(data, { fetch: discordFetch });
      return { discordSetup: discord.summary(draft.discord, publicUrl()) };
    },
    set(data) {
      const ids = new Set(memberSources().map(source => source.id));
      if (!Array.isArray(data.sourceMembers) || data.sourceMembers.some(id => typeof id !== 'string' || !ids.has(id)))
        throw fail('Choose sources from the list');
      const chosen = {
        sourceMembers: [...new Set(data.sourceMembers)],
        password: undefined,
        accounts: data.accounts === true,
        guests: data.guests === true,
        discord: data.discord === true,
        excludedGuildIds: [],
      };
      if (data.password !== null && data.password !== undefined) {
        if (typeof data.password !== 'string' || [...data.password].length < 8 || data.password.length > 1024)
          throw fail('Use a server password of at least 8 characters');
        chosen.password = data.password;
      } else if (data.keepPassword === true && draft.access?.password) chosen.password = draft.access.password;
      if (chosen.discord) {
        if (!draft.discord) throw fail('Paste the Discord application’s details first');
        const ids = new Set([
          ...draft.discord.servers.map(server => server.id),
          ...(draft.access?.excludedGuildIds || []),
        ]);
        const excluded = data.excludedGuildIds ?? [];
        if (!Array.isArray(excluded) || excluded.some(id => !ids.has(id)))
          throw fail('Choose Discord servers from the list');
        chosen.excludedGuildIds = [...new Set(excluded)];
        discord.settings(draft.discord, chosen.excludedGuildIds);
      }
      if (!chosen.sourceMembers.length && !chosen.password && !chosen.accounts && !chosen.discord)
        throw fail('Turn on at least one way in besides room invites');
      const ways = operatorWays();
      if (ways.accounts && !chosen.accounts) throw fail('Keep uburoom accounts on: your own account signs in that way');
      if (!ways.accounts && !ways.sources.some(id => chosen.sourceMembers.includes(id)))
        throw fail(
          ways.sources.length
            ? 'Keep at least one of your own Plex sources on: your account gets in as its member'
            : 'Your Plex account gets in only as a member of a Plex source: add one in Media sources, or use a uburoom account',
        );
      draft.access = chosen;
      return accessView();
    },
  };

  // ----- Step 5: where people watch -----

  function networkOptions(port) {
    const browser = new URL(origin());
    const browserHost = browser.hostname.replace(/^\[|\]$/g, '');
    const loopback = LOOPBACK.has(browserHost);
    const home = published ? (loopback ? undefined : browserHost) : homeAddress(browserHost);
    const computer = wide || loopback ? browserHost : 'localhost';
    const visiblePort = published ? browser.port : String(port);
    const where = (/** @type {string} */ address) =>
      new URL(
        'https://' + (net.isIPv6(address) ? '[' + address + ']' : address) + (visiblePort ? ':' + visiblePort : ''),
      ).origin;
    return {
      computer: where(computer),
      home: home ? where(home) : undefined,
      computerAddress: computer,
      homeAddress: home,
    };
  }
  const localHostname = () => {
    const raw = String(os.hostname() || '')
      .trim()
      .toLowerCase();
    if (!raw || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(raw)) return [];
    return raw.includes('.') ? [raw] : [raw, raw + '.local'];
  };
  const parseHttpsOrigin = raw => {
    const text = typeof raw === 'string' ? raw.trim() : '';
    let parsed;
    try {
      parsed = new URL(text);
    } catch {
      throw fail('Enter an HTTPS address like https://watch.example.com (no path)');
    }
    if (
      parsed.protocol !== 'https:' ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== '/'
    ) {
      throw fail('Enter an HTTPS address like https://watch.example.com (no path)');
    }
    return parsed.origin;
  };
  const network = {
    view() {
      const port = draft.network?.port ?? setupPort();
      return {
        where: draft.network?.where || 'computer',
        port,
        published,
        route: draft.network?.route || 'cloudflare',
        publicUrl: draft.network?.where === 'internet' ? draft.network.publicUrl : '',
        trustedProxies: draft.network?.trustedProxies || (published ? ['172.30.0.0/24'] : ['127.0.0.1', '::1']),
        allowLan: draft.network?.allowLan ?? true,
        ...networkOptions(port),
      };
    },
    set(data) {
      if (!['computer', 'home', 'internet'].includes(data.where)) throw fail('Choose where people watch');
      const port = typeof data.port === 'string' && /^\d{1,5}$/.test(data.port.trim()) ? Number(data.port) : data.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail('Use a port from 1 to 65535');
      if (published && port !== setupPort()) throw fail('Keep the container port used by the Docker port mapping');
      const options = networkOptions(port);
      if (data.where === 'home' && !options.home)
        throw fail(
          published
            ? 'Open setup using the Docker host’s LAN address and published port, then choose My home network'
            : 'uburoom couldn’t find this computer’s address on the network; choose This computer',
        );
      if (data.where === 'internet') {
        const publicUrl = parseHttpsOrigin(data.publicUrl);
        const route = data.route || 'cloudflare';
        if (!['cloudflare', 'tailscale', 'caddy', 'https'].includes(route)) throw fail('Choose how people connect');
        if (route === 'https') {
          const allowLan = data.allowLan !== false;
          const pubHost = new URL(publicUrl).hostname.replace(/^\[|\]$/g, '');
          const lanNames = allowLan && !published ? [options.homeAddress, ...localHostname()].filter(Boolean) : [];
          draft.network = {
            where: 'internet',
            route,
            port,
            listen: 'https',
            host: wide ? setupHost : '0.0.0.0',
            publicUrl,
            lanUrl: allowLan && !published ? 'auto' : '',
            allowLan,
            trustedProxies: [],
            trustedProxyHeader: 'x-forwarded-for',
            names: [...new Set(['localhost', pubHost, ...lanNames])],
          };
          return network.view();
        }
        const rawProxies = Array.isArray(data.trustedProxies)
          ? data.trustedProxies
          : String(data.trustedProxies ?? (published ? '172.30.0.0/24' : '127.0.0.1, ::1'))
              .split(',')
              .map(s => s.trim())
              .filter(Boolean);
        if (!rawProxies.length) throw fail('Enter at least one trusted proxy address or CIDR');
        draft.network = {
          where: 'internet',
          route,
          port,
          listen: 'http-proxy',
          host: wide ? setupHost : '127.0.0.1',
          publicUrl,
          lanUrl: '',
          allowLan: false,
          trustedProxies: rawProxies,
          trustedProxyHeader: route === 'cloudflare' ? 'cf-connecting-ip' : 'x-forwarded-for',
          names: [],
        };
        return network.view();
      }
      const homeNames =
        data.where === 'home'
          ? ['localhost', options.homeAddress, ...(!published ? localHostname() : [])].filter(Boolean)
          : ['localhost', options.computerAddress].filter(Boolean);
      draft.network = {
        where: data.where,
        port,
        listen: 'https',
        // A container or NAS is reached through its published port either way.
        host: wide ? setupHost : data.where === 'home' ? '0.0.0.0' : setupHost,
        publicUrl: data.where === 'home' ? options.home : options.computer,
        lanUrl: data.where === 'home' && !published ? 'auto' : '',
        trustedProxies: [],
        trustedProxyHeader: 'x-forwarded-for',
        names: [...new Set(homeNames)],
      };
      return network.view();
    },
  };

  // ----- The whole draft -----

  /** Which step still needs an answer, for a page opened part way through. */
  function view() {
    return {
      account: accountView(),
      sources: sourcesView(),
      access: draft.access ? accessView() : undefined,
      network: draft.network ? network.view() : undefined,
    };
  }

  /** Everything the config is written from, checked as a whole. */
  function complete() {
    if (!draft.account) throw fail('Choose your account first (step 2)');
    const list = normalized();
    if (!list.length) throw fail('Add at least one media source (step 3)');
    if (!draft.access) throw fail('Choose who can get in (step 4)');
    // Checked again: sources may have changed since.
    access.set({ ...rules(), password: draft.access.password ?? null });
    if (!draft.network) throw fail('Choose where people watch (step 5)');
    const discordSettings = draft.access.discord
      ? discord.settings(draft.discord, draft.access.excludedGuildIds)
      : undefined;
    return { draft, list, rules: rules(), discordSettings };
  }

  return {
    view,
    account,
    sources,
    access,
    network,
    complete,
    setupPort,
    close: flows.closeAll,
    sweep: flows.sweep,
  };
}

module.exports = { createWizard, homeAddress, DEFAULT_PORT };
