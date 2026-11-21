'use strict';
// Folders of videos on this machine as a media source. See server/sources/index.js for the contract.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { localProvider } = require('./provider');

const LIBRARY_KEYS = ['id', 'name', 'paths', 'parse_names', 'type'];

/**
 * One `type: 'folders'` entry: `libraries`, each as `local_media.libraries` took them. Each library keeps
 * its id for as long as its queue entries and resume positions should survive, wherever its folder moves.
 * Returns `{libraries: [{id, name, paths, parseNames, type}], artDirectory}`.
 */
function validate(raw, { id, base, platform, dataDirectory }) {
  const where = 'sources ' + id + ': ';
  for (const key of Object.keys(raw))
    if (key !== 'libraries') throw new Error(where + 'unknown folders setting; check config.example.yaml');
  const libraries = raw.libraries;
  if (
    !Array.isArray(libraries) ||
    !libraries.length ||
    libraries.length > 32 ||
    libraries.some(
      library =>
        !library ||
        typeof library !== 'object' ||
        Array.isArray(library) ||
        Object.keys(library).some(key => !LIBRARY_KEYS.includes(key)) ||
        typeof library.id !== 'string' ||
        !/^[a-z][a-z0-9-]{0,31}$/.test(library.id) ||
        typeof library.name !== 'string' ||
        !library.name.trim() ||
        library.name.length > 100 ||
        /[\u0000-\u001f\u007f]/.test(library.name) ||
        !Array.isArray(library.paths) ||
        !library.paths.length ||
        library.paths.length > 16 ||
        library.paths.some(folder => typeof folder !== 'string' || !folder) ||
        (library.parse_names !== undefined && typeof library.parse_names !== 'boolean') ||
        (library.type !== undefined && !['movies', 'shows'].includes(library.type)),
    )
  )
    throw new Error(
      where +
        'libraries requires 1-32 entries with a quoted id (lowercase letters, digits and hyphens, starting with a letter), name and paths (a list of 1-16 folders), and optionally type (movies or shows) and parse_names (true or false)',
    );
  return {
    // Pictures made for local videos live in the data folder, never beside the media.
    artDirectory: path.join(dataDirectory, 'local-art'),
    libraries: libraries.map(library => ({
      id: library.id,
      name: library.name.trim(),
      paths: library.paths.map(folder => path.resolve(base, folder)),
      parseNames: library.parse_names ?? true,
      type: library.type || 'movies',
    })),
    platform,
  };
}

/**
 * Library ids name pictures in the one picture folder, so they are unique across every folders source;
 * and a folder belongs to one library only. Windows paths ignore case.
 */
function validateAll(entries) {
  const libraries = entries.flatMap(entry => entry.libraries);
  if (new Set(libraries.map(library => library.id)).size !== libraries.length)
    throw new Error('Folders sources must not repeat a library id');
  const folders = entries.flatMap(entry =>
    entry.libraries.flatMap(library =>
      library.paths.map(folder => (entry.platform === 'win32' ? folder.toLowerCase() : folder)),
    ),
  );
  if (new Set(folders).size !== folders.length) throw new Error('Folders sources must not repeat a folder');
  for (const entry of entries) delete entry.platform;
}

function create(entry, { pipeline, logger }) {
  return localProvider({ source: entry, pipeline, logger });
}

/** Each folder is readable, FFprobe/FFmpeg are present, and pictures can be made. */
async function check(entry, { ffmpeg, ffprobe, connectionOnly = false } = {}) {
  const checks = [];
  for (const library of entry.libraries)
    for (const folder of library.paths) {
      let status = 'pass',
        message = `"${library.name}" (${library.id}) reads ${folder}`,
        remediation;
      try {
        if (!fs.statSync(folder).isDirectory()) throw new Error('not a folder');
        fs.accessSync(folder, fs.constants.R_OK);
      } catch {
        status = 'fail';
        message = `"${library.name}" (${library.id}) cannot read ${folder}`;
        remediation = 'Point each library path at a folder the uburoom account can read.';
      }
      checks.push({ category: 'Sources', name: 'Library folder', status, message, remediation });
    }
  if (connectionOnly) return checks;
  checks.push({
    category: 'Sources',
    name: 'Folder media tools',
    status: !ffprobe ? 'fail' : ffmpeg ? 'pass' : 'warn',
    message: !ffprobe
      ? 'Local media cannot be read without FFprobe.'
      : ffmpeg
        ? 'FFprobe reads local files and FFmpeg converts those a browser cannot play.'
        : 'Without FFmpeg, only files a browser plays as they are can be watched.',
    remediation:
      !ffprobe || !ffmpeg ? 'Install FFmpeg (with FFprobe) on PATH or set tools.ffmpeg and tools.ffprobe.' : undefined,
  });
  // Pictures for local videos: the filters their frames need (zscale and tonemap only for HDR), and the folder.
  if (ffmpeg) {
    let missing;
    try {
      const filters = cp.execFileSync(ffmpeg, ['-hide_banner', '-filters'], {
        timeout: 4000,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      missing = ['thumbnail', 'boxblur', 'overlay', 'zscale', 'tonemap'].filter(
        name => !new RegExp('^\\s*\\S+\\s+' + name + '\\s', 'm').test(filters),
      );
    } catch {
      missing = undefined;
    }
    const hdrOnly = !!missing?.length && missing.every(name => ['zscale', 'tonemap'].includes(name));
    checks.push({
      category: 'Sources',
      name: 'Pictures',
      status: missing?.length === 0 ? 'pass' : 'warn',
      message: !missing
        ? 'Could not list FFmpeg filters; local videos may get no pictures.'
        : missing.length
          ? `FFmpeg lacks ${missing.join(', ')}: ${hdrOnly ? 'HDR videos' : 'local videos'} get no picture of their own.`
          : 'FFmpeg can make pictures for local videos, HDR included.',
      remediation: missing?.length
        ? 'Use an FFmpeg build with zimg (for zscale), such as the gyan.dev or BtbN full builds.'
        : undefined,
    });
  }
  let bytes = 0,
    files = 0;
  try {
    for (const name of fs.readdirSync(entry.artDirectory)) {
      const stat = fs.statSync(path.join(entry.artDirectory, name));
      if (stat.isFile()) {
        bytes += stat.size;
        files++;
      }
    }
  } catch {
    /* Not made yet: pictures are saved there once local videos are browsed. */
  }
  checks.push({
    category: 'Sources',
    name: 'Picture folder',
    status: 'pass',
    message: `${files} pictures, ${(bytes / 1024 / 1024).toFixed(1)} MB of 256 MB in ${entry.artDirectory}`,
  });
  return checks;
}

/** The source's libraries, for Server settings: a folders source defines them itself, so all are offered. */
async function libraries(entry) {
  return entry.libraries.map(library => ({ id: library.id, name: library.name, type: library.type }));
}

module.exports = { validate, validateAll, create, check, libraries, setup: require('./setup') };
