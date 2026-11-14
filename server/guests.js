'use strict';
const { repositories } = require('./repositories');

/**
 * Guests: people a room's invite lets in who could not otherwise enter. Their browser session
 * carries the room (login.guestRoom); guest accounts end with their session, and signed-in
 * visitors' guest access ends at login.guestUntil.
 * `rooms` and `endedFor` are read when called: the rooms and the watch routes are built after this.
 * @param {{config: any, logger: any, registry: any, accounts: any, logins: Map<string, any>,
 *   rooms: () => any, endedFor: (ids: string[]) => Promise<void>}} services
 */
function createGuests({ config, logger, registry, accounts, logins, rooms, endedFor }) {
  const enabled = () => !!config.guests?.enabled;
  /** What the entry policy asks: may this account enter this room as a guest? */
  const admits = (roomId, userId) => {
    if (!enabled()) return false;
    try {
      rooms().roomState.store.get(roomId);
    } catch {
      return false;
    }
    return !(config.guests.requireSignIn && registry.isGuest(userId));
  };
  /** Accounts holding the room's current guest passes. */
  const members = roomId => {
    const now = Date.now(),
      held = new Set();
    for (const login of logins.values())
      if (
        login.guestRoom === roomId &&
        (login.expires === null || login.expires > now) &&
        (login.guestUntil ?? Infinity) > now
      )
        held.add(login.userId);
    return held;
  };
  // Ends guest sessions in a room (all of them, or just these accounts): their
  // viewers get the ordinary "removed from the room" notice, then their sign-in ends.
  async function endSessions(roomId, userIds) {
    const ended = new Set();
    for (const [key, login] of logins) {
      if (login.guestRoom !== roomId || (userIds && !userIds.includes(login.userId))) continue;
      ended.add(login.userId);
      if (registry.isGuest(login.userId)) logins.delete(key);
      else {
        delete login.guestRoom;
        delete login.guestUntil;
        delete login.device;
      }
    }
    if (!ended.size) return [];
    await accounts.save();
    const watch = rooms();
    const room = watch.rooms.get(roomId);
    if (room)
      for (const [id, viewer] of [...room.viewers])
        if (ended.has(viewer.userId)) {
          viewer.watchSocket?.watchKick?.(roomId);
          await watch.leave(room, viewer.actor, id, 'kicked');
        }
    await endedFor([...ended]);
    return [...ended];
  }
  // Guest sessions end when guests are turned off server-wide, their room is
  // deleted or their time runs out. Unused guest accounts are cleaned up every minute.
  let running,
    cleanupAt = 0;
  /** @returns {Promise<void>} */
  const sweep = () =>
    (running ||= (async () => {
      const watch = rooms();
      const now = Date.now(),
        gone = new Set();
      for (const login of logins.values()) {
        if (!login.guestRoom) continue;
        let over = !enabled() || (login.guestUntil ?? Infinity) <= now;
        if (!over)
          try {
            watch.roomState.store.get(login.guestRoom);
          } catch {
            over = true;
          }
        if (over) gone.add(login.guestRoom);
      }
      for (const roomId of gone) {
        const expired = [...logins.values()]
          .filter(
            login =>
              login.guestRoom === roomId &&
              (!enabled() ||
                (login.guestUntil ?? Infinity) <= now ||
                !repositories(watch.roomState.store.db).rooms.exists(roomId)),
          )
          .map(login => login.userId);
        await endSessions(roomId, expired);
      }
      if (now - cleanupAt >= 60000) {
        cleanupAt = now;
        const inUse = new Set([...logins.values()].map(login => login.userId));
        for (const room of watch.rooms.values())
          for (const viewer of [...room.viewers.values(), ...room.disconnectedViewers.values()])
            inUse.add(viewer.userId);
        for (const recovery of watch.roomState.recoveries.values())
          for (const id of recovery.viewers || []) inUse.add(id);
        registry.removeUnusedGuests(inUse);
        await registry.flush();
      }
    })()
      .catch(error => logger.warn('Guests', 'Guest check failed: ' + error.message))
      .finally(() => {
        running = undefined;
      }));
  return { enabled, admits, members, endSessions, sweep };
}
module.exports = { createGuests };
