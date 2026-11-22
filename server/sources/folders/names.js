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
 * @param {{latestYear?: number, stripYear?: boolean}} [options]
 * @returns {{title: string, year?: number, edition?: string}}
 */
function parseName(name, { latestYear = new Date().getFullYear() + 1, stripYear = true } = {}) {
  let stem = String(name).replace(/\(/g, ' (');
  let edition;
  // Plex's own markers: {edition-Director's Cut}, and {imdb-tt…}/{tmdb-…} ids, which are dropped.
  stem = stem.replace(/\{([a-z]+)-([^{}]*)\}/gi, (_, key, value) => {
    if (key.toLowerCase() === 'edition' && value.trim()) edition = value.trim().slice(0, 100);
    return ' ';
  });
  // Square brackets hold tags ([1080p], [YTS.MX]) unless they hold just a year (or stripYear is false).
  stem = stem.replace(/\[([^\]]*)\]/g, (whole, inside) =>
    stripYear && /^\s*(?:19|20)\d\d\s*$/.test(inside) ? whole : ' ',
  );
  // Dots stand for spaces only in names with no spaces; underscores always do.
  stem = (/\s/.test(stem.trim()) ? stem : stem.replace(/\./g, ' ')).replace(/_/g, ' ');
  const tokens = stem.split(/\s+/).filter(Boolean);
  const release = tokens.findIndex((token, index) => index > 0 && RELEASE.test(token));
  const end = release < 0 ? tokens.length : release;
  let at = -1;
  if (stripYear) for (let index = 1; index < end; index++) if (yearOf(tokens[index], latestYear)) at = index;
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

// S01E02 (also s1e2 and S01E02E03, which counts as its first episode), or 1x02.
const EPISODE =
  /(?:^|[\s._\-\[(])(?:s(\d{1,3})[\s._-]?e(\d{1,4})(?:[\s._-]?e\d{1,4})*|(\d{1,2})x(\d{2,3}))(?=$|[\s._\-\])])/i;
const SEASON_FOLDER = /^(?:season|series|staffel|saison|temporada)[\s._-]*(\d{1,3})$/i;

/**
 * A show's episode from its file name and the folders above it, the way media servers read
 * them: `Show/Season 1/Show.S01E02.Title.1080p.mkv` is episode 2 of season 1 of "Show",
 * titled "Title". The show is the first folder inside the library when there is one, or
 * else the name before the episode number; "Season N" folders give the season when the
 * name has none, and "Specials" is season 0. A file with no episode number is a special
 * of its show. Nothing is looked up anywhere.
 * @param {string} file The file name. @param {string[]} folders The folders from the library down to the file.
 * @returns {{show: string, year?: number, season: number, episode?: number, title: string}}
 */
function episodeName(file, folders, options) {
  const stem = file.replace(/\.[^.]+$/, '');
  const match = EPISODE.exec(stem);
  let season = match ? Number(match[1] ?? match[3]) : undefined,
    episode = match ? Number(match[2] ?? match[4]) : undefined;
  // The show: its own folder, else what comes before the episode number.
  const before = match ? stem.slice(0, match.index) : '';
  const shown = folders.length ? parseName(folders[0], options) : parseName(before || stem, options);
  const show = shown.title || parseName(stem, options).title || stem.slice(0, 200);
  // The season, when the name has none: a "Season 2" or "Specials" folder.
  let folderSeason;
  for (const folder of folders.slice(1)) {
    const seasonMatch = SEASON_FOLDER.exec(folder.trim());
    if (seasonMatch) folderSeason = Number(seasonMatch[1]);
    else if (/^specials?$/i.test(folder.trim())) folderSeason = 0;
  }
  // In a season folder, a name that starts with a number is that episode: `Season 2/03 - Pilot.mkv`.
  let rest = match ? stem.slice(match.index + match[0].length) : stem;
  const numbered =
    !match && folderSeason !== undefined ? /^(\d{1,3})(?:[\s._]*-[\s._]*|[\s._]+)(.*)$/.exec(stem) : null;
  if (numbered) {
    episode = Number(numbered[1]);
    rest = numbered[2];
  }
  // The episode's own title: what follows the number, up to the first release tag.
  rest = rest.replace(/^[\s._-]+/, '');
  const title = RELEASE.test(rest.split(/[\s.]/)[0] || '')
    ? ''
    : parseName(rest, { ...options, stripYear: false }).title;
  return {
    show,
    ...(shown.year ? { year: shown.year } : {}),
    season: season ?? folderSeason ?? 0,
    ...(episode !== undefined ? { episode } : {}),
    title: title && title !== show ? title : '',
  };
}

module.exports = { parseName, filmName, sortTitle, episodeName };
