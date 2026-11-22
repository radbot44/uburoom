/** A library's icon: a folder for local folders, a link or YouTube mark for link sources. */
export function sectionIcon(section) {
  if (section.source === 'folder') return 'folder';
  if (section.source === 'link') return section.serverKind === 'youtube' ? 'brand-youtube' : 'link';
  return section.mediaType === 'show' ? 'tv' : 'film';
}

export const libraryKey = ({ id, serverId }) => JSON.stringify([serverId ?? null, id]);

/** Each media server's own mark, shown beside its name on its libraries' cards. */
const SERVER_MARKS = {
  plex: { label: 'Plex', logo: '/assets/plex-icon.png' },
  jellyfin: { label: 'Jellyfin', logo: '/assets/jellyfin-icon.svg' },
};
/**
 * One card per library on Libraries home, described once for the server's first paint and the page's own
 * render: its icon, its name, the source it is on (its mark and name, or the folders source's name), and
 * whether it has a Collections page, which opens from a button on the card.
 * @returns {{id: string, title: string, icon: string, collections: boolean,
 *   source?: {text: string, logo?: string, label?: string}}[]}
 */
function homeCards(items = []) {
  return items.map(section => {
    const mark = SERVER_MARKS[section.serverKind];
    const source =
      section.source === 'folder'
        ? { text: section.serverName || 'Local folders' }
        : section.source === 'link'
          ? { text: section.serverName || 'YouTube' }
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
