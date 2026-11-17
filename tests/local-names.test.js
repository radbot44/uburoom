'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { filmName, sortTitle } = require('../server/local/names');

const options = { latestYear: 2026 };
const name = (file, folder = '', alone = false) => filmName(file, folder, alone, options);

test('release file names read as a film title and year', () => {
  const cases = [
    ['65.2023.2160p.UHD.BluRay.x265-B0MBARDiERS.mkv', '65', 2023],
    ['The.Matrix.1999.1080p.BluRay.x264-GROUP.mkv', 'The Matrix', 1999],
    ['Blade.Runner.2049.2017.2160p.WEB-DL.DDP5.1.HDR.HEVC.mkv', 'Blade Runner 2049', 2017],
    ['Blade Runner 2049 (2017).mkv', 'Blade Runner 2049', 2017],
    ['1917 (2019).mkv', '1917', 2019],
    ['2012.2009.1080p.BluRay.mkv', '2012', 2009],
    ['2001.A.Space.Odyssey.1968.REMASTERED.1080p.mkv', '2001 A Space Odyssey', 1968],
    ['Mr. Smith Goes to Washington (1939).mp4', 'Mr. Smith Goes to Washington', 1939],
    ['Heat (1995) [1080p] [YTS.MX].mp4', 'Heat', 1995],
    ['[YTS] Alien (1979).mp4', 'Alien', 1979],
    ['Alien [1979].mp4', 'Alien', 1979],
    ['Movie_Name_2015_720p.mkv', 'Movie Name', 2015],
    ['Some Film - 2004 - 1080p.mkv', 'Some Film', 2004],
    ['Arrival(2016).mkv', 'Arrival', 2016],
    ['Dune.Part.Two.2024.PROPER.2160p.mkv', 'Dune Part Two', 2024],
    ['The.Web.2005.DVDRip.avi', 'The Web', 2005],
  ];
  for (const [file, title, year] of cases) assert.deepEqual(name(file), { title, year }, file);
});

test('names without a year keep their title, cut before any release tags', () => {
  assert.deepEqual(name('Heat.mkv'), { title: 'Heat' });
  assert.deepEqual(name('Home.Video.1080p.x264.mkv'), { title: 'Home Video' });
  assert.deepEqual(name('2049.mkv'), { title: '2049' });
  // A year with nothing before it is the title.
  assert.deepEqual(name('2019.mkv'), { title: '2019' });
  assert.deepEqual(name('2019 Christmas.mp4'), { title: '2019 Christmas' });
});

test('Plex edition markers become the edition, and ids are dropped', () => {
  assert.deepEqual(name('Blade Runner (1982) {edition-The Final Cut} {imdb-tt0083658}.mkv'), {
    title: 'Blade Runner',
    year: 1982,
    edition: 'The Final Cut',
  });
});

test('a folder names the film only when the file does not and the folder holds just that video', () => {
  assert.deepEqual(name('movie.mkv', 'Heat (1995)', true), { title: 'Heat', year: 1995 });
  assert.deepEqual(name('movie.mkv', 'Heat (1995)', false), { title: 'movie' });
  assert.deepEqual(name('Heat.1995.mkv', 'Old Films', true), { title: 'Heat', year: 1995 });
  assert.deepEqual(name('movie.mkv', 'Old Films', true), { title: 'movie' });
  assert.deepEqual(name('Heat {edition-Director}.mkv', 'Heat (1995)', true), {
    title: 'Heat',
    year: 1995,
    edition: 'Director',
  });
});

test('sort titles skip a leading article', () => {
  assert.equal(sortTitle('The Matrix'), 'Matrix');
  assert.equal(sortTitle('A Quiet Place'), 'Quiet Place');
  assert.equal(sortTitle('Theodore'), 'Theodore');
  assert.equal(sortTitle('The'), 'The');
});

test('episode names give their show, season, number and title', () => {
  const { episodeName } = require('../server/local/names');
  const name = (file, folders = []) => episodeName(file, folders, { latestYear: 2026 });
  assert.deepEqual(name('Show.S01E02.The.Title.1080p.WEB-DL.x264-GRP.mkv'), {
    show: 'Show',
    season: 1,
    episode: 2,
    title: 'The Title',
  });
  assert.deepEqual(name('Show.S01E02.1080p.mkv', ['Show (2005)', 'Season 1']), {
    show: 'Show',
    year: 2005,
    season: 1,
    episode: 2,
    title: '',
  });
  assert.deepEqual(name('03 - Pilot.mkv', ['Show', 'Season 2']), {
    show: 'Show',
    season: 2,
    episode: 3,
    title: 'Pilot',
  });
  assert.deepEqual(name('The.Office.US.s02e03e04.720p.mkv', ['The Office (US)']), {
    show: 'The Office (US)',
    season: 2,
    episode: 3,
    title: '',
  });
  assert.deepEqual(name('Show 1x05 Name.avi'), { show: 'Show', season: 1, episode: 5, title: 'Name' });
  assert.deepEqual(name('Extras.mkv', ['Show', 'Specials']), { show: 'Show', season: 0, title: 'Extras' });
  assert.deepEqual(name('Doctor.Who.2005.S01E01.Rose.mkv'), {
    show: 'Doctor Who',
    year: 2005,
    season: 1,
    episode: 1,
    title: 'Rose',
  });
});
