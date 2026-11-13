// @ts-check
/* Room-scoped and tenant-aware state publication broker.
 * Prevents room-local playback, readiness, and telemetry events from waking or
 * leaking state updates to subscribers in unrelated rooms or tenants.
 */

/**
 * Create a coalescing subscription broker that delivers room-local changes only
 * to clients subscribed to that `(tenantId, roomId)`, while lobby/global changes
 * wake all clients within the affected tenant.
 * @param {{
 *   publish:(client:any, context:{roomOnly:boolean, roomIds?:ReadonlySet<string>})=>void|Promise<void>,
 *   getRoomId?:(client:any)=>string|undefined,
 *   getTenantId?:(client:any)=>string,
 *   onError?:(error:unknown, client:any)=>void,
 *   schedule?:(fn:()=>void)=>void
 * }} config
 */
export function createSubscriptionBroker({
  publish,
  getRoomId = client => client?.roomId,
  getTenantId = client => client?.tenantId || 'default',
  onError = () => {},
  schedule = typeof setImmediate === 'function' ? setImmediate : queueMicrotask,
}) {
  const clients = new Set();
  const dirtyTenants = new Set();
  /** @type {Map<string, Set<string>>} */
  const dirtyRoomsByTenant = new Map();
  let flushQueued = false;

  function safePublish(client, context) {
    try {
      const result = publish(client, context);
      if (result && typeof result.then === 'function') {
        result.then(undefined, error => onError(error, client));
      }
    } catch (error) {
      onError(error, client);
    }
  }

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
      if (typeof tenant !== 'string' || !tenant) continue;
      if (globalAll || tenantsSnapshot.has(tenant)) {
        safePublish(client, { roomOnly: false });
        continue;
      }
      const dirtyRooms = roomsSnapshot.get(tenant);
      if (!dirtyRooms || dirtyRooms.size === 0) continue;
      const subscribedRoom = getRoomId(client);
      if (subscribedRoom && dirtyRooms.has(subscribedRoom)) {
        safePublish(client, { roomOnly: true, roomIds: dirtyRooms });
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
   * - `notify()` (no arguments) or `notify({ tenantId: '*' })`: wakes all tenants.
   * - `notify({ tenantId, includeLobby: true })`: wakes all clients in `tenantId` (defaults to `'default'` when `scope` is provided without `tenantId`).
   * - `notify({ tenantId, roomId, includeLobby: false })`: wakes ONLY clients subscribed to `(tenantId, roomId)`.
   * @param {{roomId?:string, tenantId?:string, includeLobby?:boolean}} [scope]
   */
  function notify(scope) {
    if (scope === undefined) {
      dirtyTenants.add('*');
      ensureScheduled();
      return;
    }
    const tenant = scope.tenantId === undefined ? 'default' : scope.tenantId;
    if (typeof tenant !== 'string' || !tenant) return;
    if (scope.includeLobby !== false || typeof scope.roomId !== 'string' || !scope.roomId) {
      dirtyTenants.add(tenant);
      ensureScheduled();
      return;
    }
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
    add(client) {
      clients.add(client);
    },
    delete(client) {
      clients.delete(client);
    },
    get size() {
      return clients.size;
    },
    notify,
    subscribers(roomId, tenantId = 'default') {
      const matched = [];
      for (const client of clients) {
        if (getTenantId(client) === tenantId && getRoomId(client) === roomId) {
          matched.push(client);
        }
      }
      return matched;
    },
  };
}
