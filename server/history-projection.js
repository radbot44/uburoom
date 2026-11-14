'use strict';
const busy = () =>
  Object.assign(new Error('History exceeds the current read budget; retry after retention cleanup'), { status: 503 });
async function historyProjection(rows) {
  // The repository snapshots bounded committed strings before yielding. Reduce
  // in slices so requests and room ticks can run between batches.
  const media = new Map(),
    sessions = [];
  let intervals = 0,
    slice = performance.now();
  for (const row of rows) {
    const { wallIntervals, sourceIntervals, ...record } = JSON.parse(row.record);
    if (sessions.length < 100) sessions.push(record);
    let item = media.get(record.mediaId);
    if (!item) {
      item = { mediaId: record.mediaId, wall: new Map(), source: new Map() };
      media.set(record.mediaId, item);
    }
    for (const [field, ranges] of [
      ['wall', wallIntervals],
      ['source', sourceIntervals],
    ])
      for (const [start, end] of ranges) {
        if (!item[field].has(start) && ++intervals > 500000) throw busy();
        item[field].set(start, Math.max(item[field].get(start) ?? end, end));
      }
    if (performance.now() - slice >= 4) {
      await new Promise(setImmediate);
      slice = performance.now();
    }
  }
  const totals = [];
  for (const item of media.values()) {
    const total = { mediaId: item.mediaId };
    for (const [field, key, scale] of [
      ['wall', 'watchedSeconds', 1000],
      ['source', 'sourceSeconds', 1],
    ]) {
      let start,
        end,
        length = 0;
      for (const [a, b] of [...item[field]].sort((a, b) => a[0] - b[0])) {
        if (start !== undefined && a <= end + 0.001) end = Math.max(end, b);
        else {
          if (start !== undefined) length += end - start;
          start = a;
          end = b;
        }
      }
      if (start !== undefined) length += end - start;
      total[key] = length / scale;
      await new Promise(setImmediate);
    }
    totals.push(total);
  }
  return { retentionDays: 90, totals, sessions };
}
module.exports = { historyProjection };
