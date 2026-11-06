'use strict';

// A conservative retained-payload estimate, bounded even for large catalogs.
// This is a cache admission budget, not a measurement of V8 or process RSS.
function sizeOf(value, limit) {
  const pending = [value], seen = new Set(); let size = 0;
  while (pending.length && size <= limit) {
    const item = pending.pop();
    if (typeof item === 'string') size += item.length * 2 + 24;
    else if (Buffer.isBuffer(item)) size += item.byteLength + 64;
    else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item); size += 64;
      for (const key of Object.keys(item)) { size += key.length * 2 + 16; pending.push(item[key]); }
    } else size += 16;
  }
  return size;
}
class CacheBudget {
  constructor(maxBytes = 32 * 1024 * 1024) { this.maxBytes = maxBytes; this.entries = new Map(); this.bytes = 0; }
  touch(entry) {
    const record = this.entries.get(entry);
    if (record) { this.entries.delete(entry); this.entries.set(entry,record); }
  }
  retain(cache, key, entry, value) {
    if (cache.get(key) !== entry) return;
    const size = sizeOf(value,this.maxBytes);
    this.entries.set(entry,{cache,key,size}); this.bytes += size;
    for (const [old,record] of this.entries) {
      if (record.cache.get(record.key) !== old || old.until <= Date.now() || this.bytes > this.maxBytes) {
        if (record.cache.get(record.key) === old) record.cache.delete(record.key);
        this.entries.delete(old); this.bytes -= record.size;
      }
    }
  }
  clear() { for (const {cache,key} of this.entries.values()) cache.delete(key); this.entries.clear(); this.bytes = 0; }
}
module.exports = { CacheBudget };
