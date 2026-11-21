'use strict';
// @ts-check
/**
 * Which of a media server's own libraries a source offers. A Plex or Jellyfin entry may name them
 * in `libraries:` (the server's own library ids). Absent means every library, including ones the
 * server gains later; present means only those, so a library added to the server later stays off
 * until the owner switches it on. Each source module enforces its list wherever its media is
 * reachable; admission never reads it.
 */

/**
 * Checks a raw `libraries:` value.
 * @param {unknown} raw
 * @param {string} where - the message prefix naming the source
 * @param {(value: string) => string | undefined} normalize - the server's library id, or undefined when invalid
 * @returns {string[] | null} null when absent: every library
 */
function validateLibraries(raw, where, normalize) {
  if (raw === undefined || raw === null) return null;
  if (!Array.isArray(raw) || raw.length > 500)
    throw new Error(where + "libraries must be a list of the server's library ids");
  const ids = raw.map(value => {
    const id = typeof value === 'string' || typeof value === 'number' ? normalize(String(value)) : undefined;
    if (!id) throw new Error(where + "libraries must be a list of the server's library ids");
    return id;
  });
  return [...new Set(ids)];
}

/**
 * The truthful refusal for media in a library the source does not offer: unavailable, like media
 * whose source is not configured, never "denied".
 */
function libraryOff() {
  return Object.assign(new Error("This media's library is unavailable: it is switched off for its source"), {
    status: 409,
    unavailable: true,
    libraryOff: true,
  });
}

module.exports = { validateLibraries, libraryOff };
