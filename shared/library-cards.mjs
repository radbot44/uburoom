/** A library's icon: a folder for local folders, so they stand apart from Plex and Jellyfin movie libraries. */
export function sectionIcon(section) {
  return section.source === 'folder' ? 'folder' : section.mediaType === 'show' ? 'tv' : 'film';
}

/** Each media server's own mark, shown beside its name on its libraries' cards. */
const SERVER_MARKS = {
  plex: { label: 'Plex', logo: '/assets/plex-icon.png' },
  jellyfin: { label: 'Jellyfin', logo: '/assets/jellyfin-icon.svg' },
};
/**
 * One card per library on Libraries home, described once for the server's first paint and the page's own
 * render: its icon, its name, the server it is on (that server's mark and name, or "Local folders"), and
 * whether it has a Collections page, which opens from a button on the card.
 * @returns {{id: string, title: string, icon: string, collections: boolean,
 *   source?: {text: string, logo?: string, label?: string}}[]}
 */
function homeCards(items = []) {
  return items.map(section => {
    const mark = SERVER_MARKS[section.serverKind];
    const source =
      section.source === 'folder'
        ? { text: 'Local folders' }
        : mark
          ? { text: section.serverName || mark.label, logo: mark.logo, label: mark.label }
          : undefined;
    return {
      id: section.id,
      title: section.title,
      icon: sectionIcon(section),
      collections: section.collections !== false,
      ...(source ? { source } : {}),
    };
  });
}
/** The synchronization test video's card, shown on Libraries home only in Admin mode. */
const SYNC_CARD = { title: 'Sync test video', icon: 'play', source: { text: 'Admin mode' } };

export { homeCards, SYNC_CARD };
