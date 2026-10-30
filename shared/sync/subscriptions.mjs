// @ts-check
/* Room-scoped and tenant-aware state publication broker.
 * Prevents room-local playback, readiness, and telemetry events from waking or
 * leaking state updates to subscribers in unrelated rooms or tenants.
 */

const ROOM_SUBSCRIPTION_PATTERN = /^\/api\/watch\/rooms\/([a-f0-9-]{36})(?:\/([a-z]+))?(?:\?|$)/;

const ROOM_LOCAL_ACTIONS = new Set([
  'media.play',
  'media.pause',
  'media.toggle',
  'media.seek.start',
  'media.seek.end',
  'media.seek.relative',
  'media.seek.absolute',
  'media.ready.start',
  'media.ready.wait',
  'media.ready.cancel',
  'media.autoplay.set',
  'media.autoplay.cancel',
  'media.quality.set',
  'media.tracks.set',
  'media.stream.refresh',
  'media.volume.set',
  'media.mute',
  'media.unmute',
  'media.reporting.set',
  'profile.save',
  'profile.load'
]);

/**
 * Determine whether an action affects only the target room's subscribers
 * (never altering lobby room list titles, visibility, names, or membership).
 * @param {string|undefined} action
 */
export function isRoomLocalAction(action) {
  if (typeof action !== 'string') return false;
  if (ROOM_LOCAL_ACTIONS.has(action)) return true;
  if (/^(?:zoom|stretch|pan|reset)\./.test(action)) return true;
  return false;
}

/**
 * Extract the subscribed `roomId` from a watch subscription path.
 * @param {string|undefined} subscriptionPath
 */
export function extractSubscribedRoomId(subscriptionPath) {
  if (typeof subscriptionPath !== 'string' || !subscriptionPath) return undefined;
  return ROOM_SUBSCRIPTION_PATTERN.exec(subscriptionPath)?.[1];
}

/**
 * Classify a mutation request path + body into either a room-only scope or a lobby-inclusive scope.
 * @param {string} path
 * @param {any} [data]
 * @returns {{roomId?:string, includeLobby:boolean}}
 */
export function classifyMutationScope(path, data) {
  const cleanPath = String(path || '').split('?')[0];
  const match = ROOM_SUBSCRIPTION_PATTERN.exec(cleanPath);
  if (!match) return { includeLobby: true };
  const [, roomId, subresource] = match;
  if (subresource === 'ready' || subresource === 'delivery') {
    return { roomId, includeLobby: false };
  }
  if (subresource === 'command' && isRoomLocalAction(data?.command?.action)) {
    // Note: in saved rooms when no media is loaded, `media.play`/`media.toggle`
    // can advance into the next queued title, which updates the lobby title.
    // Callers with room context can pass `roomHasMedia` or let dispatch classify it.
    return { roomId, includeLobby: false };
  }
  return { roomId, includeLobby: true };
}

/**
 * Create a coalescing subscription broker that delivers room-local changes only
 * to clients subscribed to that `(tenantId, roomId)`, while lobby/global changes
 * wake all clients within the affected tenant.
 * @param {{
 *   publish:(client:any, context:{roomOnly:boolean, roomIds?:ReadonlySet<string>})=>void|Promise<void>,
 *   getRoomId?:(client:any)=>string|undefined,
 *   getTenantId?:(client:any)=>string,
 *   schedule?:(fn:()=>void)=>void
 * }} config
 */
export function createSubscriptionBroker({
  publish,
  getRoomId = client => extractSubscribedRoomId(client?.subscription),
  getTenantId = client => client?.tenantId || 'default',
  schedule = typeof setImmediate === 'function' ? setImmediate : queueMicrotask
}) {
  const clients = new Set();
  const dirtyTenants = new Set();
  /** @type {Map<string, Set<string>>} */
  const dirtyRoomsByTenant = new Map();
  let flushQueued = false;

  function flush() {
    flushQueued = false;
    const globalAll = dirtyTenants.has('*');
    const tenantsSnapshot = new Set(dirtyTenants);
    const roomsSnapshot = new Map();
    for (const [tenant, roomSet] of dirtyRoomsByTenant) {
      roomsSnapshot.set(tenant, new Set(roomSet));
    }
    dirtyTenants.clear();
    dirtyRoomsByTenant.clear();

    for (const client of clients) {
      const tenant = getTenantId(client);
      if (globalAll || tenantsSnapshot.has(tenant)) {
        void publish(client, { roomOnly: false });
        continue;
      }
      const dirtyRooms = roomsSnapshot.get(tenant);
      if (!dirtyRooms || dirtyRooms.size === 0) continue;
      const subscribedRoom = getRoomId(client);
      if (subscribedRoom && dirtyRooms.has(subscribedRoom)) {
        void publish(client, { roomOnly: true, roomIds: dirtyRooms });
      }
    }
  }

  function ensureScheduled() {
    if (flushQueued) return;
    flushQueued = true;
    schedule(flush);
  }

  /**
   * Queue a state publication.
   * - `notify()` or `notify({ includeLobby: true })`: wakes all clients in `tenantId` (or `*` when omitted).
   * - `notify({ roomId, includeLobby: false })`: wakes ONLY clients subscribed to `(tenantId, roomId)`.
   * @param {{roomId?:string, tenantId?:string, includeLobby?:boolean}} [scope]
   */
  function notify(scope) {
    if (!scope || scope.includeLobby !== false || !scope.roomId) {
      dirtyTenants.add(scope?.tenantId || '*');
      ensureScheduled();
      return;
    }
    const tenant = scope.tenantId || 'default';
    let set = dirtyRoomsByTenant.get(tenant);
    if (!set) {
      set = new Set();
      dirtyRoomsByTenant.set(tenant, set);
    }
    set.add(scope.roomId);
    ensureScheduled();
  }

  return {
    clients,
    add(client) { clients.add(client); },
    delete(client) { clients.delete(client); },
    get size() { return clients.size; },
    notify,
    subscribers(roomId, tenantId = 'default') {
      const matched = [];
      for (const client of clients) {
        if (getTenantId(client) === tenantId && getRoomId(client) === roomId) {
          matched.push(client);
        }
      }
      return matched;
    }
  };
}
