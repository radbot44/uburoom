// @ts-check
/* Room-scoped and tenant-aware state publication broker.
 * Prevents room-local playback, readiness, and telemetry events from waking or
 * leaking state updates to subscribers in unrelated rooms or tenants.
 */

import { SYNC_ACTIONS } from './protocol.mjs';

const ROOM_SUBSCRIPTION_PATTERN = /^\/api\/watch\/rooms\/([a-f0-9-]{36})(?:\/([a-z]+))?(?:\?|$)/;

// Generic media commands affect only their room. Host applications with
// extension commands pass their own predicate to classifyMutationScope.
const ROOM_LOCAL_ACTIONS = new Set(SYNC_ACTIONS.filter(action => action.startsWith('media.')));

/**
 * Determine whether a generic sync action affects only the target room's subscribers
 * (never altering lobby room list titles, visibility, names, or membership).
 * @param {string|undefined} action
 */
export function isRoomLocalAction(action) {
  if (typeof action !== 'string') return false;
  return ROOM_LOCAL_ACTIONS.has(action);
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
 * @param {(action: string|undefined) => boolean} [roomLocal] Whether a command action is room-local.
 * @returns {{roomId?:string, includeLobby:boolean}}
 */
export function classifyMutationScope(path, data, roomLocal = isRoomLocalAction) {
  const cleanPath = String(path || '').split('?')[0];
  const match = ROOM_SUBSCRIPTION_PATTERN.exec(cleanPath);
  if (!match) return { includeLobby: true };
  const [, roomId, subresource] = match;
  if (subresource === 'ready' || subresource === 'delivery') {
    return { roomId, includeLobby: false };
  }
  if (subresource === 'command' && roomLocal(data?.command?.action)) {
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
 *   onError?:(error:unknown, client:any)=>void,
 *   schedule?:(fn:()=>void)=>void
 * }} config
 */
export function createSubscriptionBroker({
  publish,
  getRoomId = client => extractSubscribedRoomId(client?.subscription),
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
