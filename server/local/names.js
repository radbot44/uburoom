'use strict';
// @ts-check

/**
 * Film names from file and folder names, the way media servers read them: the title is
 * everything before the release year, and what follows the year (resolution, source,
 * codec, release group) is dropped. `65.2023.2160p.UHD.BluRay.x265-GROUP.mkv` is "65"
 * from 2023; `Blade Runner 2049 (2017).mkv` is "Blade Runner 2049" from 2017. A year is
 * only a year with a title before it, so `1917 (2019)` and `2012.2009.1080p` read right.
 * Nothing is looked up anywhere; a name that does not parse keeps its plain title.
 */

// Words that only ever describe a release, never a title. Ordinary words that release
// names also use (Proper, Extended, Web) are left out: they only appear after the year,
// which is cut anyway.
const RELEASE =
  /^(?:\d{3,4}[pi]|[48]k|uhd|hdr(?:10\+?)?|dovi|blu-?ray|bd(?:rip|remux)?|br(?:rip)?|web-?(?:dl|rip)|webrip|hdtv|hdrip|dvd(?:rip|scr)?|remux|[xh]\.?26[45]|hevc|avc|av1|xvid|divx|10-?bit|aac(?:\d\.\d)?|ac3|e?ac-?3|dts(?:-?hd)?|ddp?\d?(?:\.\d)?|truehd|atmos)(?=$|[-.])/i;
const ARTICLE = /^(?:the|a|an)\s+/i;

/** @param {string} token @param {number} latest */
function yearOf(token, latest) {
  const match = /^[([]?((?:19|20)\d\d)[)\]]?$/.exec(token);
  const year = match ? Number(match[1]) : 0;
  return year >= 1900 && year <= latest ? year : 0;
}

/**
 * @param {string} name A file name without its extension, or a folder name.
 * @param {{latestYear?: number}} [options]
 * @returns {{title: string, year?: number, edition?: string}}
 */
function parseName(name, { latestYear = new Date().getFullYear() + 1 } = {}) {
  let stem = String(name).replace(/\(/g, ' (');
  let edition;
  // Plex's own markers: {edition-Director's Cut}, and {imdb-tt…}/{tmdb-…} ids, which are dropped.
  stem = stem.replace(/\{([a-z]+)-([^{}]*)\}/gi, (_, key, value) => {
    if (key.toLowerCase() === 'edition' && value.trim()) edition = value.trim().slice(0, 100);
    return ' ';
  });
  // Square brackets hold tags ([1080p], [YTS.MX]) unless they hold just a year.
  stem = stem.replace(/\[([^\]]*)\]/g, (whole, inside) => (/^\s*(?:19|20)\d\d\s*$/.test(inside) ? whole : ' '));
  // Dots stand for spaces only in names with no spaces; underscores always do.
  stem = (/\s/.test(stem.trim()) ? stem : stem.replace(/\./g, ' ')).replace(/_/g, ' ');
  const tokens = stem.split(/\s+/).filter(Boolean);
  const release = tokens.findIndex((token, index) => index > 0 && RELEASE.test(token));
  const end = release < 0 ? tokens.length : release;
  let at = -1;
  for (let index = 1; index < end; index++) if (yearOf(tokens[index], latestYear)) at = index;
  const words = tokens.slice(0, at > 0 ? at : end);
  const title = words
    .join(' ')
    .replace(/^[\s\-–:(]+|[\s\-–:(]+$/g, '')
    .slice(0, 200);
  if (!title) return { title: '' };
  return {
    title,
    ...(at > 0 ? { year: yearOf(tokens[at], latestYear) } : {}),
    ...(edition ? { edition } : {}),
  };
}

/**
 * A video's title, year and edition from its file name, or from its folder when the file
 * name has no year and the folder holds only this video (`Heat (1995)/movie.mkv`).
 * @param {string} file @param {string} folder The folder's own name, or '' at the top.
 * @param {boolean} alone Whether this is the only video in that folder.
 * @param {{latestYear?: number}} [options]
 */
function filmName(file, folder, alone, options) {
  const own = parseName(file.replace(/\.[^.]+$/, ''), options);
  if (own.year || !alone || !folder) return own;
  const outer = parseName(folder, options);
  if (!outer.year) return own;
  return { ...outer, ...(own.edition || outer.edition ? { edition: own.edition || outer.edition } : {}) };
}

/** The title to sort by: "The Matrix" sorts as "Matrix". */
function sortTitle(title) {
  return title.replace(ARTICLE, '') || title;
}

module.exports = { parseName, filmName, sortTitle };
