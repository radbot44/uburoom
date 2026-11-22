export const libraryProgressKey = (server, id) => JSON.stringify([server || '', id]);

// Room progress overrides personal progress for the same media on the same source.
export function libraryProgress({ current, bookmark, history = [] } = {}) {
  const recorded = new Map(history.map(row => [libraryProgressKey(row.serverId, row.mediaId), row]));
  return item => {
    for (const row of [current, bookmark, recorded.get(libraryProgressKey(item.serverId, item.id))]) {
      if (!row || row.mediaId !== item.id || (row.serverId && row.serverId !== item.serverId)) continue;
      if (row.outcome === 'completed') return 0;
      const duration = row.duration || item.duration;
      if (duration && row.position > duration * 0.92) return 0;
      if (row.position >= 10) return Math.round(row.position);
    }
    const offset = item.viewOffset || 0;
    return offset >= 10 && (!item.duration || offset <= item.duration * 0.92) ? offset : 0;
  };
}
