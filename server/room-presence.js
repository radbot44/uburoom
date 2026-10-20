'use strict';
// Admission leases count people rather than tabs and reserve their places during reconnect.
class RoomPresence {
  constructor(maximum, now = Date.now) { this.maximum = maximum; this.now = now; this.people = new Map(); }
  reserve(userId, until) { this.people.set(userId, Math.max(this.people.get(userId) || 0, until)); }
  enter(userId) {
    const now = this.now();
    for (const [id, until] of this.people) if (until <= now) this.people.delete(id);
    if (!this.people.has(userId) && this.people.size >= this.maximum) throw Object.assign(new Error('Server full; try again when someone leaves'), {status:429});
    this.reserve(userId, now + 60000);
  }
}
module.exports = { RoomPresence };
