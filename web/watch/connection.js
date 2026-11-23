import * as uburoomDiagnostics from '../playback-diagnostics.js';
import * as uburoomWire from '../../shared/wire-protocol.mjs';
import { store } from './store.js';

/* HTTP and room-connection requests (api, call, roomLink) with failure diagnostics, and renewal of the viewing sign-in. */
export function mount(host, deps) {
  let richPresenceAuthorized = false;
  let richPresenceRequest;
  // Records a failed request for the diagnostics export, then rethrows it.
  async function tracked(kind, work) {
    const started = deps.time.mono(),
      outcome = {};
    try {
      return await work(outcome);
    } catch (error) {
      const { response, decoded } = outcome;
      deps.diagnostics.record('request-failed', {
        request: kind,
        elapsedMs: deps.time.mono() - started,
        status: response?.status ?? error.status,
        rejection: kind === 'observe' ? (outcome.rejection ?? error.rejection) : undefined,
        failure:
          (response && !response.ok) || (!response && error.status)
            ? 'http'
            : response && !decoded
              ? 'decode'
              : error.name === 'TimeoutError'
                ? 'timeout'
                : error.name === 'AbortError'
                  ? 'abort'
                  : error instanceof TypeError
                    ? 'network'
                    : 'other',
      });
      // The person's own Plex sign-in stopped working: offer the one fix, wherever it surfaced.
      if (error?.reconnect === 'plex') deps.plexReconnect?.(error.message);
      throw error;
    }
  }
  // Plain HTTP: sign-in, admission, invites, account pages and uploads. Room work goes
  // over the room connection (call and room below).
  function api(path, data, options = {}) {
    return tracked(uburoomDiagnostics.requestKind(path), async outcome => {
      const headers = store.identity.token ? { Authorization: 'Bearer ' + store.identity.token } : {};
      if (data !== undefined) {
        headers['Content-Type'] = 'application/json';
        if (store.identity.me?.csrf) headers['X-CSRF-Token'] = store.identity.me.csrf;
      }
      const response = (outcome.response = await fetch(path, {
        method: data === undefined ? 'GET' : 'POST',
        headers,
        keepalive: !!options.keepalive,
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs || 12000)])
          : AbortSignal.timeout(options.timeoutMs || 12000),
      }));
      const value = await response.json();
      outcome.decoded = true;
      if (!response.ok) {
        outcome.rejection = value.rejection;
        throw Object.assign(new Error(value.error || 'Request failed'), {
          status: response.status,
          response: value,
          reconnect: value.reconnect,
        });
      }
      return value;
    });
  }
  /**
   * One named request to the server (`CALLS` in shared/wire-protocol.mjs) over the room
   * connection. Before the connection is ready, the few reads the server also answers
   * by GET go that way.
   * @param {string} op
   * @param {{roomId?: string, args?: Record<string, any>}} [input]
   * @param {{timeoutMs?: number, signal?: AbortSignal}} [options]
   */
  function call(op, input = {}, options = {}) {
    if (!store.connection.transport?.ready && uburoomWire.CALLS[op]?.http) {
      const query = new URLSearchParams(
        Object.entries(input.args || {}).filter(([, value]) => value !== undefined && value !== null),
      ).toString();
      return api(uburoomWire.CALLS[op].http + (query ? '?' + query : ''), undefined, options);
    }
    return tracked(op === 'me' ? 'identity' : op === 'rooms.list' ? 'rooms' : 'other', () => {
      if (!store.connection.transport?.ready)
        throw new TypeError('Room connection unavailable; retry after reconnecting');
      return store.connection.transport.call(op, input, options);
    });
  }
  // This tab's own room messages. Each resolves with the server's answer or rejects with its refusal.
  const roomLink = {
    /** Joins (or renews this tab's place in) a room and takes both lanes of its view. */
    join(id, options) {
      return tracked('room-poll', async () => {
        if (deps.controlProbe?.rejects(id, store.room.selected))
          throw new TypeError('Controlled room-poll interruption');
        if (!store.connection.transport?.ready)
          throw new TypeError('Room connection unavailable; retry after reconnecting');
        const joinSequence = (store.connection.joinSequence = (store.connection.joinSequence || 0) + 1);
        const joined = await store.connection.transport.join(
          id,
          store.identity.viewerId,
          deps.viewerPreferences(),
          options,
        );
        const existing = store.connection.roomLanes;
        if (joinSequence !== store.connection.joinSequence) {
          const current =
            existing?.roomId === id && existing.viewerId === joined.viewerId
              ? existing
              : { room: joined.room, viewer: joined.viewer };
          return { ...uburoomWire.mergeView(current.room.state, current.viewer.state), timing: joined.timing };
        }
        const keepRoom =
          existing?.roomId === id &&
          existing.viewerId === joined.viewerId &&
          existing.room.version > joined.room.version;
        const room = keepRoom ? existing.room : joined.room;
        const keepViewer =
          existing?.roomId === id &&
          existing.viewerId === joined.viewerId &&
          existing.viewer.version > joined.viewer.version;
        const viewer = keepViewer ? existing.viewer : joined.viewer;
        store.connection.roomLanes = {
          roomId: id,
          viewerId: joined.viewerId,
          room,
          viewer,
        };
        if (joined.journal) deps.receiveJournal(joined.journal);
        return { ...uburoomWire.mergeView(room.state, viewer.state), timing: joined.timing };
      });
    },
    leave: (id, options) => {
      if (id && id === store.room.selected) deps.clearRichPresence?.();
      return tracked('other', () => connected().leave(id, store.identity.viewerId, options));
    },
    command: (id, envelope, options) => tracked('command', () => connected().command(id, envelope, options)),
    ready: (id, report) => tracked('ready', () => connected().reportReady(id, store.identity.viewerId, report)),
    observe: (id, observation) =>
      tracked('observe', () => connected().observe(id, store.identity.viewerId, observation)),
  };
  function connected() {
    if (!store.connection.transport?.ready)
      throw new TypeError('Room connection unavailable; retry after reconnecting');
    return store.connection.transport;
  }
  /**
   * Takes one pushed lane for the selected room. Returns the tab's view once both lanes
   * describe the same video; an older lane, or one for another room, is dropped.
   */
  function receiveLane(message) {
    if (
      !store.connection.roomLanes ||
      message.roomId !== store.connection.roomLanes.roomId ||
      message.viewerId !== store.connection.roomLanes.viewerId
    )
      return;
    if (message.version < store.connection.roomLanes[message.type].version) return;
    store.connection.roomLanes[message.type] = { version: message.version, state: message.state };
    if (!uburoomWire.lanesAgree(store.connection.roomLanes.room.state, store.connection.roomLanes.viewer.state)) return;
    return uburoomWire.mergeView(store.connection.roomLanes.room.state, store.connection.roomLanes.viewer.state);
  }
  function acceptIdentity(auth) {
    store.identity.token = auth.token;
    store.identity.identityExpiresAt = auth.expiresAt;
    store.identity.identityRenewAt =
      store.identity.identityExpiresAt -
      Math.min(60000, Math.floor((store.identity.identityExpiresAt - deps.time.wall()) / 5));
    store.identity.identityRetryAt = 0;
    store.identity.identityGeneration++;
    deps.diagnostics.record('identity-renewed', { identity: store.identity.identityGeneration });
    store.connection.transport?.reauthenticate();
  }
  async function activityIdentity(options = {}) {
    const scope =
      Array.isArray(options.scopes) && options.scopes.length
        ? options.scopes
        : richPresenceAuthorized
          ? ['identify', 'rpc.activities.write']
          : ['identify'];
    const authorizeArgs = {
      client_id: store.identity.config.clientId,
      response_type: 'code',
      state: crypto.randomUUID(),
      scope,
    };
    if (options.prompt !== null) authorizeArgs.prompt = options.prompt ?? 'none';
    const { code } = await store.connection.sdk.commands.authorize(authorizeArgs);
    const auth = await api('/api/watch/activity-login', { code, instanceId: store.connection.sdk.instanceId });
    if (!(await store.connection.sdk.commands.authenticate({ access_token: auth.accessToken })))
      throw new Error('Discord Activity authentication failed');
    if (scope.includes('rpc.activities.write')) richPresenceAuthorized = true;
    return auth;
  }
  async function requestRichPresenceScope() {
    if (!deps.activity || !store.connection.sdk || !store.identity.config?.clientId) return false;
    if (store.identity.config.discordRichPresence === false) return false;
    if (richPresenceAuthorized) return true;
    if (richPresenceRequest) return richPresenceRequest;
    richPresenceRequest = (async () => {
      try {
        const auth = await activityIdentity({
          scopes: ['identify', 'rpc.activities.write'],
          prompt: null,
        });
        acceptIdentity(auth);
        return true;
      } catch (error) {
        deps.diagnostics.record('rich-presence-scope-denied', {
          message: error?.message || 'Discord Rich Presence authorization declined',
        });
        return false;
      } finally {
        richPresenceRequest = undefined;
      }
    })();
    return richPresenceRequest;
  }
  async function renewIdentity() {
    if (!store.identity.token || deps.time.wall() < store.identity.identityRenewAt) return;
    if (store.identity.identityRenewal) return store.identity.identityRenewal;
    if (deps.time.wall() < store.identity.identityRetryAt) {
      if (deps.time.wall() >= store.identity.identityExpiresAt)
        throw new Error('Viewing sign-in expired; reconnect to continue.');
      return;
    }
    store.identity.identityRenewal = (async () => {
      const auth =
        store.identity.config.demo && ['host', 'guest', 'guest2'].includes(deps.params.get('demo'))
          ? await api('/api/watch/demo-login', { persona: deps.params.get('demo'), activity: deps.activity })
          : await activityIdentity().catch(error => {
              if (!richPresenceAuthorized) throw error;
              richPresenceAuthorized = false;
              return activityIdentity({ scopes: ['identify'], prompt: 'none' });
            });
      acceptIdentity(auth);
    })()
      .catch(error => {
        deps.diagnostics.record('identity-renew-failed');
        store.identity.identityRetryAt = deps.time.wall() + 10000;
        if (deps.time.wall() >= store.identity.identityExpiresAt) throw error;
      })
      .finally(() => {
        store.identity.identityRenewal = undefined;
      });
    return store.identity.identityRenewal;
  }
  return {
    acceptIdentity,
    activityIdentity,
    api,
    call,
    connected,
    hasRichPresenceScope: () => richPresenceAuthorized,
    receiveLane,
    renewIdentity,
    requestRichPresenceScope,
    roomLink,
    tracked,
  };
}
