'use strict';
// @ts-check
// Adding a Jellyfin source in Server settings, through ./connect.js: servers found on the network
// (or a typed address), an administrator's sign-in (password or Quick Connect) used only to create
// uburoom's own API key, then the Jellyfin user whose libraries are offered. The password is passed
// once to that server; the API key stays in the flow on the server. See server/source-settings.js.
const connect = require('./connect');
const { jellyfinId } = require('./client');

const fail = (message, status = 400) => Object.assign(new Error(message), { status, expose: true });
/** A connect error is already worded for the person; anything else is not repeated. */
const told = error =>
  error?.code?.startsWith?.('JELLYFIN_')
    ? Object.assign(new Error(error.message), { status: error.status || 400, expose: true })
    : fail('The Jellyfin server did not answer as expected; try again', 502);

/** After a sign-in: uburoom's API key and the server's users, for choosing one. */
async function signedIn(flow, identity, jellyfinFetch) {
  flow.apiKey = await connect.createApiKey(flow.server.url, identity.token, { fetcher: jellyfinFetch });
  flow.users = await connect.listUsers(flow.server.url, flow.apiKey, { fetcher: jellyfinFetch });
  return {
    users: flow.users.map(user => ({ id: user.id, name: user.name, disabled: user.disabled })),
  };
}

const steps = {
  /** Servers that answered a network broadcast and confirm they are Jellyfin. */
  async discover(flow, data, { jellyfinFetch, discover = connect.discover }) {
    let found = [];
    try {
      found = await discover();
    } catch {
      /* No broadcast here (a container, say): the address field still works. */
    }
    const servers = await Promise.all(
      found.slice(0, 16).map(server =>
        connect.publicInfo(server.address, { fetcher: jellyfinFetch }).then(
          info => ({ id: info.id, name: info.name, address: info.url }),
          () => undefined,
        ),
      ),
    );
    return { servers: servers.filter(Boolean) };
  },
  /** Chooses the server, found or typed, after confirming it is Jellyfin. */
  async server(flow, data, { jellyfinFetch }) {
    let info;
    try {
      info = await connect.publicInfo(String(data.url || ''), { fetcher: jellyfinFetch });
    } catch (error) {
      throw error?.code ? told(error) : fail('Enter an address like http://192.168.1.30:8096');
    }
    if (!info.setupComplete) throw fail('Finish setting up this Jellyfin server first', 409);
    flow.server = info;
    flow.signIn = connect.adminSignIn(info.url, info.id, { fetcher: jellyfinFetch });
    let quickConnect = false;
    try {
      quickConnect = await flow.signIn.quickConnect();
    } catch {
      /* Password sign-in still works. */
    }
    return { name: info.name, address: info.url, quickConnect };
  },
  /** An administrator's username and password, passed once to the server and never kept. */
  async password(flow, data, { jellyfinFetch }) {
    if (!flow.signIn) throw fail('Choose a Jellyfin server first');
    let identity;
    try {
      identity = await flow.signIn.password(data.username, data.password);
    } catch (error) {
      throw told(error);
    }
    try {
      return await signedIn(flow, identity, jellyfinFetch);
    } catch (error) {
      throw told(error);
    }
  },
  /** Starts Quick Connect: the code to approve in Jellyfin. */
  async quickConnect(flow) {
    if (!flow.signIn) throw fail('Choose a Jellyfin server first');
    try {
      const started = await flow.signIn.startQuickConnect();
      flow.quickConnect = started.id;
      return { code: started.code, expires: started.expires };
    } catch (error) {
      throw told(error);
    }
  },
  /** Whether the code is approved yet (`waiting` until then); then as a password sign-in. */
  async quickConnectPoll(flow, data, { jellyfinFetch }) {
    if (!flow.signIn || !flow.quickConnect) throw fail('Start Quick Connect again');
    try {
      if (!(await flow.signIn.poll(flow.quickConnect))) return { waiting: true };
      const identity = await flow.signIn.finish(flow.quickConnect);
      flow.quickConnect = undefined;
      return await signedIn(flow, identity, jellyfinFetch);
    } catch (error) {
      throw told(error);
    }
  },
  /** The user whose libraries are offered, and those libraries; the flow is then ready to be added. */
  async user(flow, data, { jellyfinFetch }) {
    const chosen = flow.users?.find(user => user.id === jellyfinId(data.user));
    if (!chosen || chosen.disabled) throw fail('Choose an enabled Jellyfin user');
    const entry = { url: flow.server.url, apiKey: flow.apiKey, user: chosen.name, libraries: null };
    const { libraries } = require('./index');
    const listed = await libraries(entry, { jellyfinFetch });
    flow.draft = {
      entry: { url: flow.server.url, api_key: flow.apiKey, user: chosen.name },
      identity: flow.server.id,
      name: flow.server.name,
      libraries: listed,
    };
    return { name: flow.server.name, address: flow.server.url, libraries: listed };
  },
};

function entry(draft, { libraries: offered }) {
  return { ...draft.entry, ...(offered ? { libraries: offered } : {}) };
}

/** Ends what a flow left open with the server (a pending Quick Connect). */
function close(flow) {
  flow.signIn?.close();
}

/** What Server settings may show of a saved entry: where it is, its user and the libraries it offers. */
function summary(saved) {
  const url = new URL(saved.url);
  return { address: url.host + url.pathname.replace(/\/$/, ''), user: saved.user, offered: saved.libraries ?? null };
}

module.exports = { steps, entry, close, summary, selectLibraries: true };
