'use strict';
// @ts-check
const { Plex } = require('./plex');

const SECTION = /^\d{1,20}$/;

/**
 * Every movie and show library on the server, whether this source offers it or not, for the
 * operator choosing which to offer: `{id, name, type, count?}`. A count Plex does not give is left out.
 * @param {any} entry
 * @param {{plexFetch?: typeof fetch}} [services]
 */
async function libraries(entry, { plexFetch = fetch } = {}) {
  const plex = new Plex({ url: entry.url, token: entry.token }, plexFetch, { pipeline: {} });
  const sections = ((await plex.client.rawJson('/library/sections')).Directory || []).filter(
    section => ['movie', 'show'].includes(section?.type) && SECTION.test(String(section.key)),
  );
  return Promise.all(
    sections.slice(0, 200).map(async section => {
      const id = String(section.key);
      let count;
      try {
        const page = await plex.client.rawJson(
          '/library/sections/' + id + '/all?X-Plex-Container-Start=0&X-Plex-Container-Size=0',
        );
        const total = Number(page.totalSize ?? page.size);
        if (Number.isSafeInteger(total) && total >= 0) count = total;
      } catch {
        /* Listed without a count. */
      }
      return {
        id,
        name: String(section.title || 'Library').slice(0, 100),
        type: section.type === 'show' ? 'shows' : 'movies',
        ...(count === undefined ? {} : { count }),
      };
    }),
  );
}

module.exports = { libraries, SECTION };
