'use strict';
const { plexIdentity } = require('./identity');
const { SharedTask } = require('../../operation');

// Access scoping: whether this token may play or see an item, with short-lived positive
// answers and coalesced checks. Invalidated when access changes.
class PlexAccess {
  constructor(plex) {
    this.plex = plex;
    this.allowedItems = new Map();
  }
  async allows(id) {
    const baseId = plexIdentity(this.plex.id(id)).ratingKey;
    return offered(
      this.plex.checkItem(
        'play:' + baseId,
        '/library/metadata/' + baseId,
        item => String(item.ratingKey) === baseId && ['movie', 'episode'].includes(item.type),
      ),
    );
  }
  async visible(id, type) {
    const baseId = String(id).split(':')[0];
    const key = (type === 'collection' ? 'collection:' : 'item:') + this.plex.id(baseId);
    return offered(
      this.plex.checkItem(
        key,
        (type === 'collection' ? '/library/collections/' : '/library/metadata/') + this.plex.id(baseId),
        item => String(item.ratingKey) === String(baseId),
      ),
    );
  }
  invalidateAccess() {
    this.accessGeneration = (this.accessGeneration || 0) + 1;
    this.allowedItems.clear();
    for (const task of this.itemChecks?.values() || []) task.abort();
    this.itemChecks?.clear();
  }
  async checkItem(key, resource, accepts) {
    if (this.allowedItems.get(key) > Date.now()) return true;
    this.itemChecks ||= new Map();
    let task = this.itemChecks.get(key);
    if (!task || task.signal.aborted) {
      if (this.itemChecks.size >= 200) throw Object.assign(new Error('Media access checks are busy'), { status: 503 });
      const generation = this.accessGeneration;
      task = new SharedTask(
        async signal => {
          const data = await this.plex.json(resource, { signal });
          signal.throwIfAborted();
          if (generation !== this.accessGeneration) return false;
          const allowed = !!data.Metadata?.some(accepts);
          if (allowed) {
            this.allowedItems.set(key, Date.now() + 3000);
            if (this.allowedItems.size > 200) this.allowedItems.delete(this.allowedItems.keys().next().value);
          }
          return allowed;
        },
        { timeoutMs: 12000 },
      );
      this.itemChecks.set(key, task);
      task.promise
        .finally(() => {
          if (this.itemChecks.get(key) === task) this.itemChecks.delete(key);
        })
        .catch(() => {});
    }
    return task.join();
  }
}

/** An item in a library the source does not offer is simply not allowed: no outage, no error. */
async function offered(check) {
  try {
    return await check;
  } catch (error) {
    if (error?.libraryOff) return false;
    throw error;
  }
}

module.exports = { PlexAccess };
