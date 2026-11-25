'use strict';

// A conservative retained-payload estimate, bounded even for large catalogs.
// This is a cache admission budget, not a measurement of V8 or process RSS.
function sizeOf(value, limit = Infinity) {
  const pending = [value],
    seen = new Set();
  let size = 0;
  while (pending.length && size <= limit) {
    const item = pending.pop();
    if (typeof item === 'string') size += item.length * 2 + 24;
    else if (item && typeof item === 'object') {
      if (seen.has(item)) {
        size += 16;
        continue;
      }
      seen.add(item);
      if (Buffer.isBuffer(item) || ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
        size += item.byteLength + 64;
      } else if (item instanceof Map) {
        size += 64;
        for (const [k, v] of item) pending.push(k, v);
      } else if (item instanceof Set) {
        size += 64;
        for (const v of item) pending.push(v);
      } else {
        size += 64;
        for (const key of Object.keys(item)) {
          size += key.length * 2 + 16;
          pending.push(item[key]);
        }
      }
    } else size += 16;
  }
  return size;
}
class CacheBudget {
  constructor(maxBytes = 32 * 1024 * 1024) {
    this.maxBytes = maxBytes;
    this.entries = new Map();
    this.bytes = 0;
  }
  touch(entry) {
    const record = this.entries.get(entry);
    if (record) {
      this.entries.delete(entry);
      this.entries.set(entry, record);
    }
  }
  delete(entry) {
    const record = this.entries.get(entry);
    if (!record) return false;
    if (record.cache.get(record.key) === entry) record.cache.delete(record.key);
    this.entries.delete(entry);
    this.bytes -= record.size;
    return true;
  }
  retain(cache, key, entry, value) {
    if (cache.get(key) !== entry) return false;
    const prev = this.entries.get(entry);
    if (prev) {
      this.entries.delete(entry);
      this.bytes -= prev.size;
    }
    const size = sizeOf(value, this.maxBytes);
    if (size > this.maxBytes) {
      cache.delete(key);
      return false;
    }
    this.entries.set(entry, { cache, key, size });
    this.bytes += size;
    for (const [old, record] of this.entries) {
      if (
        record.cache.get(record.key) !== old ||
        (old.until !== undefined && old.until <= Date.now()) ||
        this.bytes > this.maxBytes
      ) {
        if (record.cache.get(record.key) === old) record.cache.delete(record.key);
        this.entries.delete(old);
        this.bytes -= record.size;
      }
    }
    return true;
  }
  clear() {
    for (const { cache, key } of this.entries.values()) cache.delete(key);
    this.entries.clear();
    this.bytes = 0;
  }
}
module.exports = { CacheBudget, sizeOf };
